/**
 * embed.mjs — embedding 客户端（公共模块，配置注入式）——供 retriever / siliconflowserver 复用
 *
 * 与 shared/llm.mjs 对称：本模块只封装 embedding API 调用（文本 → 向量），
 * 不实现任何向量库功能（构建/索引/检索是消费方的事）。
 *
 * 用法：
 *   import { createEmbed } from "../../shared/embed.mjs";
 *   const embed = createEmbed({ baseUrl, apiKey, model, dimension, batchSize, timeoutMs, maxRetries });
 *   const vectors = await embed.embedTexts(["文本1", "文本2"]);
 *   const vec = await embed.embedOne("文本");
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 创建 embedding 客户端实例
 * @param {object} cfg 必须包含：
 *   - baseUrl: string  OpenAI 兼容端点（如 https://api.siliconflow.cn/v1）
 *   - apiKey:  string
 *   - model:   string
 *   可选：dimension / batchSize / timeoutMs / maxRetries
 */
export function createEmbed(cfg) {
  const baseUrl = (cfg.baseUrl ?? "https://api.siliconflow.cn/v1").replace(/\/+$/, "");
  const model = cfg.model;
  const batchSize = cfg.batchSize ?? 32;
  const timeoutMs = cfg.timeoutMs ?? 30000;
  const maxRetries = cfg.maxRetries ?? 3;

  /** 单次 /embeddings 请求（含重试） */
  async function requestEmbedding(texts) {
    const url = `${baseUrl}/embeddings`;
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify({ model, input: texts }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        const payload = await res.json();
        return [...(payload.data ?? [])]
          .sort((a, b) => a.index - b.index)
          .map((d) => d.embedding);
      } catch (err) {
        lastError = err;
        const retryable = err.name === "AbortError" || /429|5\d\d/.test(err.message);
        if (retryable && attempt < maxRetries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }

  /** 批内自适应拆分：单批失败（413/414/429）时拆半重试 */
  async function embedWithSplit(texts) {
    try {
      return await requestEmbedding(texts);
    } catch (err) {
      if (texts.length <= 1 || !/413|414|429/.test(err.message)) throw err;
      const mid = Math.ceil(texts.length / 2);
      const left = await embedWithSplit(texts.slice(0, mid));
      const right = await embedWithSplit(texts.slice(mid));
      return [...left, ...right];
    }
  }

  /**
   * 批量嵌入（自动分批 + 超长截断）
   * @param {string[]} texts 待嵌入文本（每条约 500 字内）
   * @returns {Promise<number[][]>}
   */
  async function embedTexts(texts) {
    const MAX_CHARS = 500;
    const clean = texts.map((t) => (t ?? "").trim().slice(0, MAX_CHARS)).filter(Boolean);
    if (clean.length === 0) return [];
    const vectors = [];
    for (let i = 0; i < clean.length; i += batchSize) {
      const batch = clean.slice(i, i + batchSize);
      vectors.push(...await embedWithSplit(batch));
      if (i + batchSize < clean.length) await sleep(50);
    }
    return vectors;
  }

  /** 单条嵌入 */
  async function embedOne(text) {
    const v = await embedTexts([text]);
    return v[0];
  }

  /* 查询向量缓存：同文本不重复调用 */
  const _embedCache = new Map();
  const EMBED_CACHE_MAX = 500;

  /** 单条嵌入（带缓存） */
  async function embedOneCached(text) {
    const key = text.slice(0, 500);
    if (_embedCache.has(key)) return _embedCache.get(key);
    const v = await embedOne(text);
    if (_embedCache.size >= EMBED_CACHE_MAX) _embedCache.clear();
    _embedCache.set(key, v);
    return v;
  }

  /** 健康检查 */
  async function healthCheck() {
    try {
      const v = await embedOne("测试");
      return { ok: true, model, dimension: v.length };
    } catch (err) {
      return { ok: false, error: err.message, model };
    }
  }

  return { embedTexts, embedOne, embedOneCached, healthCheck, model, dimension: cfg.dimension ?? null };
}
