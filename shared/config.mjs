/**
 * config.mjs — 统一配置读取（支持打包分发 + key 外置 + 功能层独立模型）
 *
 * 读取 DATA_ROOT/config.json（数据根下，NOVELYWRITE_HOME 可指定）。
 * API key 外置支持：环境变量可覆盖 config.json 中的 key——
 *   NOVELYWRITE_CHAT_API_KEY  → chat.apiKey
 *   NOVELYWRITE_EMBED_API_KEY → embed.apiKey
 * 这样打包分发时 config.json 可留空 key，运行时用环境变量注入（安全）。
 * 注意：不用 DSH_* 变量名（harness 占用），统一 NOVELYWRITE_* 前缀。
 *
 * 功能层独立模型（featureDir）：
 *   每个功能目录可放自己的 config.json（如 features/shot-writing/config.json），
 *   其 chat 段**逐字段覆盖**全局 chat 配置——只改想改的（如 model），其余继承全局。
 *   读取优先级：环境变量 > 功能层 config.json > 全局 config.json > 默认值。
 *   环境变量：NOVELYWRITE_CHAT_MODEL 可单独覆盖模型（不写文件）。
 *
 * 用法：
 *   import { loadChatConfig, loadEmbedConfig } from "../shared/config.mjs";
 *   const chat = loadChatConfig();               // 全局 chat 配置
 *   const chat2 = loadChatConfig(__dirname);     // 功能层：读 <功能目录>/config.json 覆盖
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

/** 读取功能层目录级 config.json（如 features/shot-writing/config.json），不存在返回 null */
export function loadFeatureConfig(featureDir) {
  if (!featureDir) return null;
  const p = path.join(featureDir, "config.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

/** 环境变量 key/模型覆盖（key 外置：config.json 留空，运行时注入） */
function applyEnvOverrides(cfg) {
  if (!cfg) return cfg;
  if (process.env.NOVELYWRITE_CHAT_API_KEY) cfg.chat = { ...(cfg.chat ?? {}), apiKey: process.env.NOVELYWRITE_CHAT_API_KEY };
  if (process.env.NOVELYWRITE_EMBED_API_KEY) cfg.embed = { ...(cfg.embed ?? {}), apiKey: process.env.NOVELYWRITE_EMBED_API_KEY };
  if (process.env.NOVELYWRITE_CHAT_BASE_URL) cfg.chat = { ...(cfg.chat ?? {}), baseUrl: process.env.NOVELYWRITE_CHAT_BASE_URL };
  if (process.env.NOVELYWRITE_EMBED_BASE_URL) cfg.embed = { ...(cfg.embed ?? {}), baseUrl: process.env.NOVELYWRITE_EMBED_BASE_URL };
  if (process.env.NOVELYWRITE_CHAT_MODEL) cfg.chat = { ...(cfg.chat ?? {}), model: process.env.NOVELYWRITE_CHAT_MODEL };
  return cfg;
}

/**
 * chat 配置（对话 LLM；支持模块作用域覆盖）
 *
 * 合并顺序（高 → 低）：
 *   1. 环境变量：NOVELYWRITE_CHAT_API_KEY / NOVELYWRITE_CHAT_BASE_URL / NOVELYWRITE_CHAT_MODEL
 *   2. 根 config.json 的 features.<module>.chat（模块作用域，如 features["shot-writing"].chat）
 *   3. 功能目录 config.json 的 chat 段（兼容覆盖层：features/<module>/config.json）
 *   4. 根 config.json 的 chat（全局默认）
 *   5. 代码默认值
 *
 * 模块作用域允许全字段（含 apiKey/baseUrl）——「建库与写作使用不同 API」：
 *   写作模块可配 features.shot-writing.chat.{apiKey,baseUrl,model,...} 完全独立于全局 chat。
 *
 * @param {string} [moduleName] 模块名（如 "shot-writing"）——读根 config 的 features.<module>
 * @param {string} [featureDir] 兼容：功能目录路径（如 features/shot-writing/），
 *   该目录下若有 config.json，其 chat 段作为兼容覆盖层（优先级低于根 features 段）
 * @returns {{baseUrl, apiKey, model, temperature, maxTokens, timeoutMs, maxRetries, moduleName}}
 */
export function loadChatConfig(moduleName, featureDir) {
  // 模块作用域允许字段（apiKey/baseUrl 也允许——写作/建库独立 API）
  const MODULE_FIELDS = ["apiKey", "baseUrl", "model", "temperature", "maxTokens", "timeoutMs", "maxRetries", "shotLen"];
  const pickModuleFields = (o) => Object.fromEntries(MODULE_FIELDS.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));

  // ① 全局 config.json + 环境变量覆盖
  let cfg = applyEnvOverrides(loadRawConfig());

  // ② 功能目录 config.json（兼容覆盖层，模块字段）
  if (featureDir) {
    const local = loadFeatureConfig(featureDir);
    if (local?.chat && typeof local.chat === "object") {
      cfg = { ...(cfg ?? {}), chat: { ...(cfg?.chat ?? {}), ...pickModuleFields(local.chat) } };
    }
  }

  // ③ 根 config.json 的 features.<module>.chat（模块作用域）
  if (moduleName) {
    const featChat = cfg?.features?.[moduleName]?.chat;
    if (featChat && typeof featChat === "object") {
      cfg = { ...(cfg ?? {}), chat: { ...(cfg?.chat ?? {}), ...pickModuleFields(featChat) } };
    }
  }

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
    shotLen: cfg.chat.shotLen ?? null,
    moduleName: moduleName ?? null,
  };
}

/**
 * 模块作用域配置摘要（供前端 /api/config 展示，脱敏：不含 apiKey）
 * @returns {object} { chat: {model, temperature, maxTokens, ...}, embed: {model, dimension, ...}, features: {...} }
 */
export function loadConfigSummary() {
  const raw = loadRawConfig() ?? {};
  const chat = raw.chat ?? {};
  const embed = raw.embed ?? {};
  return {
    chat: {
      baseUrl: chat.baseUrl ?? "https://api.deepseek.com/v1",
      model: chat.model ?? "",
      temperature: chat.temperature ?? 0.8,
      maxTokens: chat.maxTokens ?? 2000,
      timeoutMs: chat.timeoutMs ?? 300000,
      maxRetries: chat.maxRetries ?? 3,
      apiKeySet: Boolean(chat.apiKey || process.env.NOVELYWRITE_CHAT_API_KEY),
    },
    embed: {
      baseUrl: embed.baseUrl ?? "https://api.siliconflow.cn/v1",
      model: embed.model ?? "",
      dimension: embed.dimension ?? 1024,
      apiKeySet: Boolean(embed.apiKey || process.env.NOVELYWRITE_EMBED_API_KEY),
    },
    features: raw.features ?? {},
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
