/**
 * embed.mjs — embedding 客户端入口（薄壳）
 *
 * 从 NovelyWrite/config.json 的 embed 段读取配置，创建公共 embedding 客户端（shared/embed.mjs）。
 * 本文件只做"配置读取 + 就绪检测"，实际的 API 调用在 shared/embed.mjs。
 *
 * 配置（config.json 的 embed 段）：
 *   apiKey / model 默认空（占位），首次调用时填入。
 *
 * 就绪状态：
 *   loadEmbedConfig() 返回 { ready: true, ...配置 } 或 { ready: false, reason }
 *   未就绪（无 embed 段 / apiKey 空 / model 空）→ 向量通道降级，不阻塞标签/切词通道
 *
 * agent 友好：
 *   ensureEmbedReady() 默认不阻塞等待，返回结构化信号 { ok, status, reason, guidance }，
 *   由调用方（agent/LLM）用自然语言提示用户。
 */
import { createEmbed } from "../shared/embed.mjs";
import { loadEmbedConfig as loadEmbedConfigFromShared } from "../shared/config.mjs";

// 兼容导出：loadEmbedConfig 改走 shared/config.mjs（数据根 + key 外置）
export { loadEmbedConfig as loadEmbedConfigFromShared };
export const loadEmbedConfig = loadEmbedConfigFromShared;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 确保 embed 就绪（触发向量库操作前调用）——agent 友好版
 *
 * 默认行为（agent 场景）：不阻塞等待，立即返回结构化信号，由调用方（agent/LLM）决定如何提示用户：
 *   { ok: true, cfg }                        → 已就绪，可继续
 *   { ok: false, status, reason, guidance }  → 未就绪，调用方/LLM 用自然语言提示用户
 *
 * CLI 交互场景（opt-in）：opts.waitForFill=true 时，提示填入 + 等待用户编辑 config 后重读（默认 10s×3 次）
 *
 * @param {object} opts { waitForFill?: boolean, waitMs?: number, attempts?: number }
 */
export async function ensureEmbedReady(opts = {}) {
  const check = () => {
    const cfg = loadEmbedConfig();
    if (cfg.ready) return { ok: true, cfg };
    return {
      ok: false,
      status: "embed_not_ready",
      reason: cfg.reason,
      guidance: "请在 NovelyWrite/config.json 的 embed 段填入 apiKey 与 model（如 BAAI/bge-large-zh-v1.5）。填写后可继续向量召回；不配置则 RAG 召回通道无响应，标签/切词通道仍可用。",
    };
  };

  // 立即检查
  const first = check();
  if (first.ok || !opts.waitForFill) return first;

  // CLI 交互：提示 + 等待重读
  const waitMs = opts.waitMs ?? 10000;
  const attempts = opts.attempts ?? 3;
  console.warn(`\n[embed] ${first.reason}\n  ${first.guidance}\n  等待自动检测（${waitMs / 1000}s × ${attempts} 次）...`);
  for (let i = 0; i < attempts; i++) {
    await sleep(waitMs);
    const cfg = loadEmbedConfig();
    if (cfg.ready) return { ok: true, cfg };
  }
  const final = check();
  console.warn(`\n[embed] 仍未检测到 embed 配置。embedding 模型未载入，RAG 召回通道无响应。`);
  return final;
}

/** 创建 embed 客户端实例（配置就绪时） */
export function createEmbedClient() {
  const cfg = loadEmbedConfig();
  if (!cfg.ready) return null;
  return createEmbed(cfg);
}

/** embedding 可用性（健康检查） */
export async function embedHealthCheck() {
  const cfg = loadEmbedConfig();
  if (!cfg.ready) return { ok: false, error: cfg.reason };
  const client = createEmbed(cfg);
  return client.healthCheck();
}
