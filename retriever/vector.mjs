/**
 * vector.mjs — 向量通道（语义召回）
 *
 * 数据源：store/派生/向量/（由 build-derived.mjs 构建）
 *   - index.json：embedVersion + 每章 {project, chapter, file, shotCount}
 *   - 每章一个向量文件：{vectors: [{project, shotId, type, funcs, label, chapter, sentenceIds, embedding}]}
 *
 * 逻辑：查询文本 → embedding → 与库内全部分镜余弦 → top-k
 * 未构建向量库 / 无 embed 配置 / 嵌入失败 → 通道降级为空（不阻塞）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vectorDir, vectorIndexFile, cosine } from "./rag-core.mjs";
import { ensureEmbedReady, createEmbedClient } from "./embed.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _indexCache = null;
let _indexKey = null;

export function loadVectorIndex() {
  if (!fs.existsSync(vectorIndexFile)) return null;
  try {
    const index = JSON.parse(fs.readFileSync(vectorIndexFile, "utf-8"));
    if (_indexCache && _indexKey === index.updatedAt) return _indexCache;
    _indexCache = index;
    _indexKey = index.updatedAt;
    return index;
  } catch {
    return null;
  }
}

let _allVectors = null;
let _allVectorsKey = null;

/** 加载全部向量（进程内缓存，按 index.updatedAt 失效） */
export function loadAllVectors() {
  const index = loadVectorIndex();
  if (!index) return null;
  if (_allVectors && _allVectorsKey === index.updatedAt) return _allVectors;
  const all = [];
  for (const meta of Object.values(index.chapters ?? {})) {
    const file = path.resolve(vectorDir, meta.file);
    if (!fs.existsSync(file)) continue;
    try {
      const payload = JSON.parse(fs.readFileSync(file, "utf-8"));
      for (const v of payload.vectors ?? []) all.push(v);
    } catch { /* 跳过损坏 */ }
  }
  _allVectors = all;
  _allVectorsKey = index.updatedAt;
  return all;
}

/** 向量库版本信息（供调用方判断可用性） */
export function vectorIndexInfo() {
  const index = loadVectorIndex();
  if (!index) return null;
  return {
    updatedAt: index.updatedAt,
    embedVersion: index.embedding ?? null,
    totalShots: index.stats?.totalShots ?? null,
    totalChapters: Object.keys(index.chapters ?? {}).length,
  };
}

/**
 * 向量通道召回
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
  const embedCfg = ready.cfg;

  const all = loadAllVectors();
  if (!all || all.length === 0) return []; // 向量库未构建 → 空

  let queryVec;
  try {
    const client = createEmbedClient();
    if (!client) return [];
    queryVec = await client.embedOneCached(queryText);
  } catch {
    return []; // 嵌入失败 → 通道降级
  }
  if (!queryVec) return [];

  // 限定 project（可选）
  const pool = opts.projects && opts.projects.length
    ? all.filter((v) => opts.projects.includes(v.project))
    : all;

  const ranked = pool
    .map((v) => ({ shot: v, score: cosine(queryVec, v.embedding) }))
    .sort((a, b) => b.score - a.score);
  return ranked.slice(0, opts.topk ?? 2).map((r) => ({ shot: r.shot, score: r.score, source: "vec" }));
}
