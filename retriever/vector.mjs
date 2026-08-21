/**
 * vector.mjs — 向量通道（语义召回）
 *
 * 数据源：<书>project/derived/vector/（由 build-derived.mjs 构建，每书一份）
 *   - index.json：embedVersion + 每章 {project, chapter, file, shotCount}
 *   - 每章一个向量文件：{vectors: [{project, shotId, type, funcs, label, chapter, sentenceIds, embedding}]}
 *
 * 逻辑：查询文本 → embedding → 与库内全部分镜余弦 → top-k
 * 未构建向量库 / 无 embed 配置 / 嵌入失败 → 通道降级为空（不阻塞）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vectorDirOf, vectorIndexFileOf, cosine } from "./rag-core.mjs";
import { ensureEmbedReady, createEmbedClient } from "./embed.mjs";
import { listProjects } from "../shared/paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const _indexCache = new Map(); // project → index
const _allVectorsCache = new Map(); // project → vectors[]

/** 加载单书向量索引 */
export function loadVectorIndex(project) {
  const file = vectorIndexFileOf(project);
  if (!fs.existsSync(file)) return null;
  try {
    const index = JSON.parse(fs.readFileSync(file, "utf-8"));
    const cached = _indexCache.get(project);
    if (cached && cached.updatedAt === index.updatedAt) return cached;
    _indexCache.set(project, index);
    return index;
  } catch {
    return null;
  }
}

/** 加载单书全部向量（进程内缓存，按 index.updatedAt 失效） */
export function loadAllVectors(project) {
  const index = loadVectorIndex(project);
  if (!index) return null;
  const cached = _allVectorsCache.get(project);
  if (cached && cached.key === index.updatedAt) return cached.vectors;
  const all = [];
  for (const meta of Object.values(index.chapters ?? {})) {
    const file = path.resolve(vectorDirOf(project), meta.file);
    if (!fs.existsSync(file)) continue;
    try {
      const payload = JSON.parse(fs.readFileSync(file, "utf-8"));
      for (const v of payload.vectors ?? []) all.push(v);
    } catch { /* 跳过损坏 */ }
  }
  _allVectorsCache.set(project, { key: index.updatedAt, vectors: all });
  return all;
}

/** 向量库版本信息（供调用方判断可用性；按书） */
export function vectorIndexInfo(project) {
  const index = loadVectorIndex(project);
  if (!index) return null;
  return {
    updatedAt: index.updatedAt,
    embedVersion: index.embedding ?? null,
    totalShots: index.stats?.totalShots ?? null,
    totalChapters: Object.keys(index.chapters ?? {}).length,
  };
}

/**
 * 向量通道召回（支持多书：各书独立向量库，分别余弦后合并）
 * @param {object} query { label? | text? }
 * @param {object} opts { topk?, projects? }
 * @returns {Promise<object[]>} hits: {shot, score, source:"vec"}
 */
export async function vectorRecall(query, opts = {}) {
  // 查询文本：优先 label（浓缩标签），否则 text
  const queryText = query.label ?? query.text ?? "";
  if (!queryText.trim()) return [];

  // embed 未就绪 → 返回结构化信号（agent/LLM 用自然语言提示用户）
  const ready = opts.embedCfg ? { ok: true, cfg: opts.embedCfg } : await ensureEmbedReady({});
  if (!ready.ok) {
    const signal = {
      status: ready.status ?? "embed_not_ready",
      reason: ready.reason ?? "embed 未配置",
      guidance: ready.guidance ?? "请在 config.json 的 embed 段填入 apiKey 与 model。",
    };
    // 不 console.warn（每次检索都刷屏）——降级信号经 result.warnings 返回，调用方/LLM 可见
    return { ok: false, ...signal, hits: [] };
  }

  const projects = opts.projects?.length ? opts.projects : listProjects();

  let queryVec;
  try {
    const client = createEmbedClient();
    if (!client) return [];
    queryVec = await client.embedOneCached(queryText);
  } catch {
    return []; // 嵌入失败 → 通道降级
  }
  if (!queryVec) return [];

  // 多书：各书独立向量库，分别余弦 → 合并
  const ranked = [];
  for (const project of projects) {
    const all = loadAllVectors(project);
    if (!all || all.length === 0) continue;
    for (const v of all) {
      ranked.push({ shot: v, score: cosine(queryVec, v.embedding) });
    }
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, opts.topk ?? 2).map((r) => ({ shot: r.shot, score: r.score, source: "vec" }));
}
