/**
 * retriever.mjs — 统一检索器入口（所有消费方的唯一检索接口）
 *
 * 输入：查询意图（text/type/funcs/label）+ 检索参数（projects/quota/topk）
 * 输出：三通道 hits 并集（不排序，LLM 自己做语义处理）+ 可选上下文块
 *
 * 用法：
 *   import { retrieve } from "./retriever.mjs";
 *   const { hits, contextBlock } = await retrieve({
 *     text: "吕树识破黑衣人谎言",
 *     type: "心理", funcs: ["反转"],
 *     label: "识破说辞",
 *   }, { projects: ["大王饶命"], quota: { label: 2, token: 2, vec: 2 } });
 *
 * 通道（已确认决策）：
 *   标签：精确同类池→随机取1；未命中→权重累加降级top；全不命中→空
 *   切词：词典词+gram 分池（+5/+1）；命中<2丢弃；允许空；label 子串匹配
 *   向量：余弦 top-k（语义泛化，词面无关）
 *   合并：不排序 + 去重 + 上下文块（无 source 标记）
 */
import { dedupe, buildContextBlock } from "./rag-core.mjs";
import { labelRecall, tokenRecall, scanAllShots } from "./lexical.mjs";
import { vectorRecall } from "./vector.mjs";
import { ensureDerived } from "./ensure-derived.mjs";

const DEFAULT_QUOTA = { label: 2, token: 2, vec: 2 };

/**
 * 统一检索入口
 * @param {object} query
 *   - text: string   查询文本（切词/向量通道用）
 *   - type?: string  分镜类型（标签通道用）
 *   - funcs?: string[] 功能枚举（标签通道用）
 *   - label?: string 浓缩标签（向量通道用）
 * @param {object} opts
 *   - projects?: string[] 限定检索的 project（默认全部）
 *   - quota?: {label, token, vec} 各通道配额（默认 2/2/2，可改）
 *   - buildContext?: boolean 附带 contextBlock（默认 true）
 *   - ensure?: boolean 显式触发派生索引构建（默认 false——查询只读索引，
 *     构建由建库流程显式执行，如 node cli.mjs build-index；索引缺失时查询返回空）
 * @returns {Promise<{queryText, hits, contextBlock?}>}
 *   hits[]: {shot: {project, chapter, shotId, type, funcs, label, sentenceIds}, score, source}
 */
export async function retrieve(query, opts = {}) {
  const quota = { ...DEFAULT_QUOTA, ...(opts.quota ?? {}) };
  const projects = opts.projects?.length ? opts.projects : undefined;

  // 方向 C：查询路径不触发索引构建（构建/查询分离；构建由 cli build-index / ensure:true 显式执行）
  if (opts.ensure) {
    await ensureDerived();
  }

  // 扫描一次事实层（三个通道共享）
  const allShots = projects ? scanAllShots({ projects }) : scanAllShots();

  const collected = [];

  /* ① 标签通道 */
  if (quota.label > 0) {
    const hits = labelRecall({ type: query.type, funcs: query.funcs }, { shots: allShots, topk: quota.label });
    collected.push(...hits);
  }

  /* ② 切词通道 */
  if (quota.token > 0 && query.text) {
    const hits = tokenRecall({ text: query.text }, { shots: allShots, topk: quota.token });
    collected.push(...hits);
  }

  /* ③ 向量通道 */
  const vecWarnings = [];
  if (quota.vec > 0 && (query.label || query.text)) {
    const vres = await vectorRecall({ label: query.label, text: query.text }, { topk: quota.vec, projects });
    if (Array.isArray(vres)) {
      collected.push(...vres);
    } else if (vres && vres.ok === false) {
      // 向量通道未就绪：收集信号（agent/LLM 可据此提示用户），不阻塞其他通道
      vecWarnings.push({ channel: "vec", status: vres.status, reason: vres.reason, guidance: vres.guidance });
    }
  }

  // 去重（同 project+chapter+shotId）
  const hits = dedupe(collected);

  const result = { queryText: query.text ?? query.label ?? "", hits };
  if (vecWarnings.length) result.warnings = vecWarnings; // agent 可读的降级信号
  if (opts.buildContext !== false) {
    result.contextBlock = buildContextBlock(hits);
  }
  return result;
}

/** 便捷：直接返回上下文块（写作场景用） */
export async function retrieveContext(query, opts = {}) {
  const r = await retrieve(query, { ...opts, buildContext: true });
  return r.contextBlock;
}

export { DEFAULT_QUOTA };
