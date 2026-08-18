/**
 * config.mjs — 统一配置读取（支持打包分发 + key 外置）
 *
 * 读取 DATA_ROOT/config.json（数据根下，NOVELYWRITE_HOME 可指定）。
 * API key 外置支持：环境变量可覆盖 config.json 中的 key——
 *   NOVELYWRITE_CHAT_API_KEY  → chat.apiKey
 *   NOVELYWRITE_EMBED_API_KEY → embed.apiKey
 * 这样打包分发时 config.json 可留空 key，运行时用环境变量注入（安全）。
 * 注意：不用 DSH_* 变量名（harness 占用），统一 NOVELYWRITE_* 前缀。
 *
 * 用法：
 *   import { loadChatConfig, loadEmbedConfig } from "../shared/config.mjs";
 *   const chat = loadChatConfig();   // {baseUrl, apiKey, model, ...}
 */
import fs from "node:fs";
import path from "node:path";
import { configPath, DATA_ROOT } from "./paths.mjs";

/** 读取并解析 config.json（数据根下），不存在返回 null */
export function loadRawConfig() {
  if (!fs.existsSync(configPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return null;
  }
}

/** 环境变量 key 覆盖（key 外置：config.json 留空，运行时注入） */
function applyEnvOverrides(cfg) {
  if (!cfg) return cfg;
  if (process.env.NOVELYWRITE_CHAT_API_KEY) cfg.chat = { ...(cfg.chat ?? {}), apiKey: process.env.NOVELYWRITE_CHAT_API_KEY };
  if (process.env.NOVELYWRITE_EMBED_API_KEY) cfg.embed = { ...(cfg.embed ?? {}), apiKey: process.env.NOVELYWRITE_EMBED_API_KEY };
  if (process.env.NOVELYWRITE_CHAT_BASE_URL) cfg.chat = { ...(cfg.chat ?? {}), baseUrl: process.env.NOVELYWRITE_CHAT_BASE_URL };
  if (process.env.NOVELYWRITE_EMBED_BASE_URL) cfg.embed = { ...(cfg.embed ?? {}), baseUrl: process.env.NOVELYWRITE_EMBED_BASE_URL };
  return cfg;
}

/** chat 配置（deepseek 对话 LLM） */
export function loadChatConfig() {
  const cfg = applyEnvOverrides(loadRawConfig());
  if (!cfg?.chat?.apiKey || !cfg?.chat?.model) {
    throw new Error(`缺少 chat 配置：${configPath} 需含 chat.apiKey/chat.model，或用环境变量 NOVELYWRITE_CHAT_API_KEY 注入`);
  }
  return {
    baseUrl: (cfg.chat.baseUrl ?? "https://api.deepseek.com/v1").replace(/\/+$/, ""),
    apiKey: cfg.chat.apiKey,
    model: cfg.chat.model,
    temperature: cfg.chat.temperature ?? 0.8,
    maxTokens: cfg.chat.maxTokens ?? 2000,
    timeoutMs: cfg.chat.timeoutMs ?? 300000,
    maxRetries: cfg.chat.maxRetries ?? 3,
  };
}

/** embed 配置（就绪检测版，供向量通道） */
export function loadEmbedConfig() {
  const cfg = applyEnvOverrides(loadRawConfig());
  if (!cfg) return { ready: false, reason: "config.json 不存在" };
  const e = cfg.embed;
  if (!e) return { ready: false, reason: "config.json 缺少 embed 段" };
  if (!e.apiKey) return { ready: false, reason: "embed.apiKey 为空（可用环境变量 NOVELYWRITE_EMBED_API_KEY 注入）" };
  if (!e.model) return { ready: false, reason: "embed.model 为空" };
  return {
    ready: true,
    baseUrl: (e.baseUrl ?? "https://api.siliconflow.cn/v1").replace(/\/+$/, ""),
    apiKey: e.apiKey,
    model: e.model,
    dimension: e.dimension ?? 1024,
    batchSize: e.batchSize ?? 32,
    timeoutMs: e.timeoutMs ?? 30000,
    maxRetries: e.maxRetries ?? 3,
  };
}

/** config.json 路径（供提示用） */
export { configPath };
