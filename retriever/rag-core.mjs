/**
 * rag-core.mjs — 检索器核心（纯计算，无外部依赖）
 *
 * 能力：
 *  - store 定位：project 根目录 → 分镜/句子 JSON 路径
 *  - 余弦相似度（向量通道）
 *  - 回源：按 sentenceIds 拼整镜文本（原文唯一事实源 = 句子 JSON）
 *  - 上下文块：hits → LLM 可读文本块（无 source 标记，降 prompt 长度）
 *  - 去重：同 project+chapter+shotId 只留一条
 *
 * 数据源约定（NovelyWrite 自包含，域化布局）：
 *  - 事实层：store/<myproject|exproject>/<书>project/分镜标注/json/第XXXX章.json + 句子标注/json/第XXXX章.json
 *  - 派生层：<书>project/derived/dict/*.json + <书>project/derived/vector/*.json（每书一份，英文目录，由 build-derived.mjs 构建）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { storeDir, projectRoot } from "../shared/paths.mjs"; // 数据根下的 store + 域感知项目根（支持 NOVELYWRITE_HOME 分发）

/** store 根（来自 shared/paths.mjs——数据根下） */
export { storeDir };
/** 项目根（来自 shared/paths.mjs——域感知：myproject/exproject 自动探测） */
export { projectRoot };

/**
 * 每书派生目录（英文，位于 <书>project/derived/ 下）
 * 设计：每书一份派生（词典/向量），支持"勾选某书/我的全部/外部库"的域池检索；
 *       书间改动互不影响（重算隔离）。
 */
export function derivedDirOf(project) {
  return path.join(projectRoot(project), "derived");
}

/** 每书词典目录 */
export function dictDirOf(project) {
  return path.join(derivedDirOf(project), "dict");
}

/** 每书向量目录 */
export function vectorDirOf(project) {
  return path.join(derivedDirOf(project), "vector");
}

/** 每书向量索引文件 */
export function vectorIndexFileOf(project) {
  return path.join(vectorDirOf(project), "index.json");
}

/** 章号四位数补零 */
export function padChapter(n) {
  return String(n).padStart(4, "0");
}

/** 分镜标注 JSON 路径 */
export function shotJsonPath(project, chapter) {
  return path.join(projectRoot(project), "分镜标注", "json", `第${padChapter(chapter)}章.json`);
}

/** 句子标注 JSON 路径 */
export function sentenceJsonPath(project, chapter) {
  return path.join(projectRoot(project), "句子标注", "json", `第${padChapter(chapter)}章.json`);
}

/* ---------- 余弦相似度 ---------- */
export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1e-9);
}

/* ---------- 句子 map 缓存（回源用；mtime 感知——子进程标注更新后自动失效重载） ----------
 * 缓存条目: key: project:chapter → { sig, map }
 * 失效：每次 load 对该章句子文件 statSync（μs 级），签名变化（重标/修复/文件删除/恢复）→ 重建。
 *   签名 = mtimeMs + size 双值（同毫秒内重写同文件内容不同但 mtime 可能相同 → size 兜底）。
 *   stat 失败（文件不存在/不可访问）→ 空 map（不残留旧数据）。
 * 附带收益：修复"半写/损坏空 map 被永久缓存"的隐藏 bug——损坏瞬间缓存带旧签名，
 *   源文件写入完成后签名变化 → 下次 load 自动重建（原逻辑一旦缓存空 map 永不更新）。 */
const _sentMapCache = new Map(); // key → { sig, map }

/** 文件签名（mtimeMs+size 双值字符串）；stat 失败返回 null（不存在/不可访问） */
export function fileSig(p) {
  try {
    const st = fs.statSync(p);
    return `${st.mtimeMs}_${st.size}`;
  } catch {
    return null;
  }
}

export function loadSentenceMap(project, chapter) {
  const key = `${project}:${chapter}`;
  const file = sentenceJsonPath(project, chapter);
  const sig = fileSig(file);
  const cached = _sentMapCache.get(key);
  if (cached && sig && cached.sig === sig) return cached.map;
  let map = new Map();
  if (sig) {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf-8"));
      map = new Map((data.sentences ?? []).map((s) => [s.id, s.text]));
    } catch { /* 源文件损坏 → 空 map（带当前签名缓存，源修好后签名变 → 自动重建） */ }
  }
  _sentMapCache.set(key, { sig, map });
  return map;
}

/** 分镜 → 整镜文本（按 sentenceIds 拼句子） */
export function shotToText(shot) {
  const map = loadSentenceMap(shot.project, shot.chapter);
  return (shot.sentenceIds ?? []).map((sid) => map.get(sid) ?? "").join("").trim();
}

/* ---------- 去重（同 project+chapter+shotId） ---------- */
export function dedupe(hits) {
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    const s = h.shot;
    const key = `${s.project}|${s.chapter}|${s.shotId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

/* ---------- 上下文块（无 source 标记，降 prompt 长度） ---------- */
/**
 * @param {object[]} hits 每项 { shot: {project, chapter, shotId, type, funcs, label, sentenceIds}, score?, source? }
 * @returns {string} LLM 可读的参考块
 */
export function buildContextBlock(hits) {
  return hits.map((h, i) => {
    const s = h.shot;
    const text = shotToText(s);
    const funcs = (s.funcs ?? []).join("/");
    return `[RAG-${i + 1}] (${s.type}|${funcs}) ${s.project}·第${padChapter(s.chapter)}章:镜${s.shotId}「${s.label}」\n${text}`;
  }).join("\n\n");
}
