/**
 * errors.mjs — 统一错误模块（结构化错误 + 错误码表）
 *
 * 目标：错误从"散落的 console.error/throw 文本"升级为
 *   "code + message + hint + context" 的结构化对象，
 *   CLI 与前端（未来）共用同一套错误定义，不写两套。
 *
 * 用法：
 *   import { NovelyError, E, report } from "../shared/errors.mjs";
 *   throw new NovelyError(E.PROJECT_DUPLICATE, { project, domain, existingPath });
 *
 * 消费：
 *   CLI 场景：report(err) → 统一打印格式（code + message + hint）
 *   前端场景：任务接口返回 { ok:false, error: { code, message, hint, context } }
 *             → UI 弹提示框 + 徽标，不解析日志文本
 */

/** 错误级别 */
export const LEVEL = {
  ERROR: "error",
  WARN: "warn",
  INFO: "info",
};

/**
 * 错误码表（机器可读，新增码在此登记 + 注释用途）
 * 命名规范：<AREA>_<KIND>（域/模块_错误类型），全大写
 */
export const E = {
  /* ===== 创建 / 重名 ===== */
  PROJECT_DUPLICATE: "PROJECT_DUPLICATE", // 创建项目时，两域已存在同名书
  PROJECT_CREATE_FAILED: "PROJECT_CREATE_FAILED", // 创建项目目录失败（IO）

  /* ===== 配置 ===== */
  CONFIG_MISSING: "CONFIG_MISSING", // config.json 不存在
  CONFIG_CHAT_MISSING: "CONFIG_CHAT_MISSING", // chat 段缺 apiKey/model
  CONFIG_EMBED_MISSING: "CONFIG_EMBED_MISSING", // embed 段缺 apiKey/model
  CONFIG_INVALID: "CONFIG_INVALID", // config.json 语法非法

  /* ===== 文件 / 路径 ===== */
  FILE_MISSING: "FILE_MISSING", // 指定文件不存在（标注/语料/产物）
  PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND", // store 下找不到 <书>project
  DOMAIN_NOT_FOUND: "DOMAIN_NOT_FOUND", // 指定域目录不存在（myproject/exproject）
  DIR_CREATE_FAILED: "DIR_CREATE_FAILED", // 目录创建失败

  /* ===== 参数 ===== */
  ARG_INVALID: "ARG_INVALID", // CLI/接口参数非法（如缺 project、章号非法）
  ARG_REQUIRED: "ARG_REQUIRED", // 必填参数缺失

  /* ===== LLM / embed ===== */
  LLM_NOT_READY: "LLM_NOT_READY", // chat 未配置，LLM 任务无法执行
  EMBED_NOT_READY: "EMBED_NOT_READY", // embed 未配置，向量通道降级
  LLM_CALL_FAILED: "LLM_CALL_FAILED", // LLM 调用失败（网络/超时/HTTP 错误）
  LLM_PARSE_FAILED: "LLM_PARSE_FAILED", // LLM 输出解析失败（非 JSON / 缺键）
  EMBED_CALL_FAILED: "EMBED_CALL_FAILED", // embedding 调用失败

  /* ===== 数据 / 校验 ===== */
  DATA_INVALID: "DATA_INVALID", // 标注数据契约非法（句子/分镜/章节结构）
  SYNTAX_FAILED: "SYNTAX_FAILED", // JSON 语法校验失败
  CONTRACT_FAILED: "CONTRACT_FAILED", // 契约校验失败（章级/聚合层）
  NOT_FOUND: "NOT_FOUND", // 通用：找不到目标（书/章/会话）
};

/** 错误码 → 默认 message + 用户提示（可被实例覆盖） */
const E_DEFAULT = {
  PROJECT_DUPLICATE: { message: "书名已存在，禁止同名", hint: "请为你的书换一个名字（全局唯一，我的作品区与外部知识库区不可重名）" },
  PROJECT_CREATE_FAILED: { message: "项目目录创建失败", hint: "检查 store 目录是否可写、磁盘是否满" },
  CONFIG_MISSING: { message: "配置文件缺失", hint: "请创建 config.json（参考 README 配置模板）" },
  CONFIG_CHAT_MISSING: { message: "chat 配置缺失", hint: "请在 config.json 的 chat 段填入 apiKey 与 model，或用环境变量 NOVELYWRITE_CHAT_API_KEY 注入" },
  CONFIG_EMBED_MISSING: { message: "embed 配置缺失", hint: "请在 config.json 的 embed 段填入 apiKey 与 model（如 BAAI/bge-large-zh-v1.5），或用 NOVELYWRITE_EMBED_API_KEY 注入" },
  CONFIG_INVALID: { message: "config.json 语法非法", hint: "检查 JSON 格式（可用 JSON 校验工具）" },
  FILE_MISSING: { message: "文件不存在", hint: "检查路径与文件是否已生成" },
  PROJECT_NOT_FOUND: { message: "项目不存在", hint: "检查书名拼写，或先 annotate 建库" },
  DOMAIN_NOT_FOUND: { message: "域目录不存在", hint: "检查 store/myproject 与 store/exproject 是否存在（首次运行会自动创建）" },
  DIR_CREATE_FAILED: { message: "目录创建失败", hint: "检查目标目录权限" },
  ARG_INVALID: { message: "参数非法", hint: "检查命令行参数格式" },
  ARG_REQUIRED: { message: "缺少必填参数", hint: "查看用法说明（node cli.mjs 无参数打印用法）" },
  LLM_NOT_READY: { message: "chat LLM 未配置", hint: "配置后重试（见 CONFIG_CHAT_MISSING）" },
  EMBED_NOT_READY: { message: "embed 未配置", hint: "向量通道降级；配置后向量召回可用（见 CONFIG_EMBED_MISSING）" },
  LLM_CALL_FAILED: { message: "LLM 调用失败", hint: "检查网络 / API key 余额 / 模型名" },
  LLM_PARSE_FAILED: { message: "LLM 输出解析失败", hint: "重试该任务；持续失败请检查提示词或 API 返回" },
  EMBED_CALL_FAILED: { message: "embedding 调用失败", hint: "检查网络 / API key 余额 / 模型名" },
  DATA_INVALID: { message: "标注数据契约非法", hint: "重跑对应章标注或修复" },
  SYNTAX_FAILED: { message: "JSON 语法校验失败", hint: "检查对应 JSON 文件" },
  CONTRACT_FAILED: { message: "契约校验未通过", hint: "查看校验报告定位问题章节" },
  NOT_FOUND: { message: "未找到目标", hint: "检查名称/编号是否正确" },
};

/**
 * 统一错误类
 * @param {string} code 错误码（E 表中的键值）
 * @param {object} opts { message?, level?, context?, hint? } 覆盖默认值
 */
export class NovelyError extends Error {
  constructor(code, opts = {}) {
    const def = E_DEFAULT[code] ?? { message: code, hint: "" };
    const message = opts.message ?? def.message;
    super(message);
    this.name = "NovelyError";
    this.code = code;
    this.level = opts.level ?? LEVEL.ERROR;
    this.hint = opts.hint ?? def.hint ?? "";
    this.context = opts.context ?? {};
  }

  /** 转纯对象（JSON 序列化用，前端消费） */
  toJSON() {
    return {
      ok: false,
      error: {
        code: this.code,
        message: this.message,
        hint: this.hint,
        level: this.level,
        context: this.context,
      },
    };
  }
}

/** 便捷：把任意 throw 包装成 NovelyError（非 NovelyError 原样包装为 INTERNAL） */
export function toNovelyError(err) {
  if (err instanceof NovelyError) return err;
  const wrapped = new NovelyError("INTERNAL", {
    message: err?.message ?? String(err),
    context: { originalName: err?.name ?? null },
  });
  wrapped.code = "INTERNAL";
  wrapped.hint = "发生了未分类的内部错误，请提供复现步骤";
  return wrapped;
}

/**
 * 统一错误出口：打印到控制台（CLI 用）。
 * 前端场景不调本函数——直接取 err.toJSON() 返回给接口。
 */
export function report(err) {
  const e = toNovelyError(err);
  if (e.level === LEVEL.WARN) {
    console.warn(`[${e.code}] ${e.message}${e.hint ? `（提示：${e.hint}）` : ""}`);
    return;
  }
  console.error(`[${e.code}] ${e.message}${e.hint ? `（提示：${e.hint}）` : ""}`);
}
