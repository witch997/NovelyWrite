#!/usr/bin/env node
/**
 * writedraft.mjs — 分镜参考写作 · 第 3 步：写作（两阶段：逐镜拼接 → 全文整合）
 *
 * 职责：消费 recalls.json（完整 shots + 每镜 refs）：
 *   阶段① 逐镜写作（每镜一次 LLM，thinking 禁）：intent + refs（参考分镜文本）→ 该镜文本
 *         ——口语化约束 + 字数对齐参考（WRITE_SYSTEM）
 *         拼接为「带分镜标签」的 draft：`【镜N｜type｜label】\n正文`
 *         → 落盘会话存档 <项目名>draft.txt（中间产物，人可读/可人工调整）
 *   阶段② 全文整合（一次 LLM，thinking 禁）：输入 = draft.txt（带标签分镜）+ 原始章纲
 *         ——最小幅度改写整合，去标签
 *         → 落盘最终稿 NovelyWrite/output/<项目名>.final.txt（纯正文）
 *
 * 输出：
 *   sessions/<session-id>/<项目名>draft.txt        （阶段① 中间产物，会话存档）
 *   NovelyWrite/output/<项目名>.final.txt               （阶段② 最终整合稿，用户可读）
 *
 * 测试模式（--test-mode）：
 *   不做最终整合——阶段①分镜完成后直接拼接为最终稿（保留分镜标签）。
 *   用途：调试逐镜写作质量（排除整合环节干扰）/ 快速产出原始拼接稿。
 *
 * 每镜风格锚点（--style，默认关闭）：
 *   程序统计（18 维文体特征 → 语义标签）逐镜注入——形态锚点，零 LLM，确定性可校验。
 *   （LLM 不参与风格提炼：其语义输出会使生成结果过拟合；统计只描述"文本长什么样"，不锁语义。）
 *   不传 --style = 直接以参考文本为风格样例（默认行为）。
 *
 * 对话拆分修复（默认开；--no-fix-dialogue 关闭）：
 *   脚本检测「"A"动作，"B"」句式并重排为合法（动作前置合并），确定性零 LLM。
 *
 * 用法：
 *   node features/shot-writing/writedraft.mjs --session <session-id> [--project <语料名>]
 *   node features/shot-writing/writedraft.mjs --session <session-id> --test-mode
 *   node features/shot-writing/writedraft.mjs --session <session-id> --style
 *   node features/shot-writing/writedraft.mjs --session <session-id> --no-fix-dialogue
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CODE_ROOT, DATA_ROOT, writingSessionDir, cliArgs } from "../../shared/paths.mjs";
import { loadChatConfig } from "../../shared/config.mjs";
import { statsToJson, decodeParamsFromStats } from "./style-stats.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sessionsDir = writingSessionDir; // 数据根 sessions/（SEA 只读区不可写）

let args, sessionId, project, outputDir, sessionDir, recalls, shots, outline, chatCfg, baseUrl, shotLenConfig, lenTargetText, fixDialogue, decodeCfg; // 惰性初始化（被 import 时不可有副作用）

/* ---------- 初始化（延迟到 main——被 sea-main import 时无参数，不能 exit/读文件） ---------- */
function initWritedraft() {
  if (sessionId) return;
  args = cliArgs(); // SEA 分发兼容（过滤 "run <script>" 前缀）
  const argVal = (name) => {
    const a = args.find((x) => x.startsWith(`--${name}=`));
    if (a) return a.slice(name.length + 3);
    const i = args.indexOf(`--${name}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };
  sessionId = argVal("session");
  project = argVal("project") ?? "未命名"; // 项目名（用于 draft 文件名）
  if (!sessionId) { console.error("用法: node features/shot-writing/writedraft.mjs --session <session-id> [--project <语料名>]"); process.exit(2); }
  outputDir = path.join(DATA_ROOT, "output", sessionId); // 最终稿按会话归档: output/<sessionId>/(数据根下)
  sessionDir = path.join(sessionsDir, sessionId);

  // 读 recalls.json
  const recallsPath = path.join(sessionDir, "recalls.json");
  if (!fs.existsSync(recallsPath)) {
    console.error(`[writedraft] recalls.json 不存在: ${recallsPath}（先跑 recall）`);
    process.exit(1);
  }
  recalls = JSON.parse(fs.readFileSync(recallsPath, "utf-8"));
  shots = recalls.shots ?? [];
  console.log(`[writedraft] 会话 ${sessionId} | 项目 ${project} | 分镜 ${shots.length} 镜`);
  console.log("\n[writedraft] 阶段① 逐镜写作（每镜一次 LLM，thinking 开）...");

  // 读原始章纲（input.txt，阶段② 整合输入之一）
  const inputPath = path.join(sessionDir, "input.txt");
  outline = fs.existsSync(inputPath) ? fs.readFileSync(inputPath, "utf-8") : recalls.summary ?? "";

  // LLM 客户端（thinking 开——推理型任务；模型/温度走模块作用域 config）
  chatCfg = loadChatConfig("shot-writing", __dirname); // 根 config.features["shot-writing"] 覆盖全局 + 功能目录 config.json 兼容
  baseUrl = (chatCfg.baseUrl ?? "https://api.deepseek.com/v1").replace(/\/+$/, "");

  // 字数基准配置（每镜字数目标）：--shot-len=N（命令行）> config features.shot-writing.chat.shotLen > 默认 200
  const DEFAULT_SHOT_LEN = 200;
  shotLenConfig = (() => {
    const fromArg = args.find((a) => a.startsWith("--shot-len="));
    if (fromArg) return JSON.parse(fromArg.slice("--shot-len=".length));
    if (typeof chatCfg.shotLen !== "undefined") return chatCfg.shotLen;
    return DEFAULT_SHOT_LEN;
  })();
  lenTargetText = Array.isArray(shotLenConfig)
    ? `${shotLenConfig[0]}-${shotLenConfig[1]} 字`
    : `约 ${shotLenConfig} 字`;
  console.log(`[writedraft] 字数基准: ${lenTargetText}（来源: ${args.some((a) => a.startsWith("--shot-len=")) ? "命令行" : typeof chatCfg.shotLen !== "undefined" ? "config shotLen" : "默认"}）`);
  fixDialogue = !args.includes("--no-fix-dialogue"); // 对话修复（脚本确定性，默认开）
  // 解码四元组配置（跨模型兼容）：读 features.shot-writing.chat.decode（模块作用域，随写作 LLM 配置一起读入 chatCfg）
  //   { tempRange, top_p, fpCenter, fpSlope, fpRange, presence_penalty, supports:{top_p,frequency_penalty,presence_penalty} }
  //   supports 中某参数 = false → 该参数不支持，chat 回退 API 默认（不传）
  decodeCfg = chatCfg.decode ?? null;
}

async function chat(messages, maxTokens = null, thinking = false, decode = null, decodeCfg = null) {
  // decode: { temperature?, top_p?, frequency_penalty?, presence_penalty? }——完整解码参数（可只给部分）
  // decodeCfg: { supports?: {top_p?, frequency_penalty?, presence_penalty?}, ... }——模型参数支持声明（不支持的回退 API 默认）
  const supports = decodeCfg?.supports ?? {};
  const body = {
    model: chatCfg.model, messages, stream: true,
  };
  if (decode?.temperature != null) body.temperature = decode.temperature;
  else body.temperature = chatCfg.temperature ?? 0.8;
  if (decode?.top_p != null && supports.top_p !== false) body.top_p = decode.top_p;
  if (decode?.frequency_penalty != null && supports.frequency_penalty !== false) body.frequency_penalty = decode.frequency_penalty;
  if (decode?.presence_penalty != null && supports.presence_penalty !== false) body.presence_penalty = decode.presence_penalty;
  // maxTokens === null → 不传 max_tokens（用 API 默认上限，不限制长度）
  if (maxTokens !== null) body.max_tokens = maxTokens;
  // thinking：默认禁用（不传 disabled）；只有显式 thinking=true 才开启
  if (thinking !== true) body.thinking = { type: "disabled" };
  // 超时（2026-09-04 修复，原无 AbortController——API 挂起=任务永久 running）
  // 逐镜/整合单次调用输出量小，config.timeoutMs（默认 5min）足够
  const timeoutMs = chatCfg.timeoutMs ?? 300000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${chatCfg.apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", out = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const d = t.slice(5).trim();
        if (d === "[DONE]") continue;
        try { out += JSON.parse(d).choices?.[0]?.delta?.content ?? ""; } catch { /* skip */ }
      }
    }
    if (!out.trim()) throw new Error("LLM 流式返回空内容");
    return out;
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`LLM 请求超时（${timeoutMs}ms），请检查网络或调大 config.json 的 chat.timeoutMs`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* ========== 温度模块（采样层，逐镜独立；与风格模块解耦） ==========
 * 基于镜型(type) + funcs 的规则映射（零 LLM、确定性、可解释）：
 *   温度 = clamp(基准0.9 + type调整 + funcs调整均值, 下限0.6, 上限1.3)
 *   - type 决定基础档（心理收敛/动作发散）
 *   - funcs 多个取【均值】叠加（1 个全值生效；多个折中，不爆上限；负向不叠加过冷）
 *   - 兜底：type 未知 → 仅 funcs 调整；均无 → 基准 0.9
 * 与整合阶段 tempFromText（哈希，无 type/funcs 时兜底）并存：逐镜用规则映射，整合用哈希。
 */
const TEMP_BASE = 0.9;   // 基准温度
const TEMP_MIN = 0.6;    // 下限（收敛）
const TEMP_MAX = 1.3;    // 上限（发散）
const TYPE_TEMP = {
  "心理": -0.15,  // 内心戏要稳，收敛防跳脱
  "信息": -0.10,  // 陈述性内容，稳
  "环境": -0.05,  // 场景描写，平和
  "对话": 0,      // 常规对话，基准
  "事件": +0.05,  // 情节推进，略放开
  "动作": +0.10,  // 动作戏要跳，发散
};
const FUNC_TEMP = {
  "爆发": +0.15,   // 情绪顶点，放开
  "反转": +0.10,   // 转折要锐
  "悬念": +0.05,   // 留钩子，略发散
  "塑造人物": +0.05, // 人物戏，稍活
  "推进": +0.05,   // 动起来
  "转场": -0.05,   // 过渡要顺
  "引入世界观": -0.05, // 交代要清楚
  "设置动机": -0.10,   // 铺垫性，稳
  "铺垫": -0.10,   // 伏笔要稳
  "收束分镜": -0.15,   // 收尾要收住
};

/**
 * 逐镜温度（规则映射）：type 基础档 + funcs 均值调整，钳制 [TEMP_MIN, TEMP_MAX]。
 * 跨模型适配：range = [lo, hi] 为目标模型温度范围（如 GLM [0.5, 1.0]）——
 *   结果先在 DeepSeek 标定范围 [TEMP_MIN, TEMP_MAX] 内 clamp，再【按比例映射】到目标范围：
 *     ratio = (v - TEMP_MIN) / (TEMP_MAX - TEMP_MIN)
 *     newV  = lo + ratio × (hi - lo)
 *   无 range（默认）→ 直接返回标定范围值（DeepSeek 行为不变）。
 */
export function tempFromShot(shot, base = TEMP_BASE, range = null) {
  const tAdj = TYPE_TEMP[shot?.type] ?? 0;
  const funcs = (shot?.funcs ?? []).map((f) => FUNC_TEMP[f]).filter((v) => v != null);
  const fAdj = funcs.length ? funcs.reduce((a, b) => a + b, 0) / funcs.length : 0;
  let v = Math.min(TEMP_MAX, Math.max(TEMP_MIN, base + tAdj + fAdj));
  if (range && Array.isArray(range) && range.length === 2 && range[1] > range[0]) {
    // 按比例映射：DeepSeek 标定范围 → 目标模型范围
    const [lo, hi] = range;
    const ratio = (v - TEMP_MIN) / (TEMP_MAX - TEMP_MIN);
    v = lo + ratio * (hi - lo);
  }
  return Number(v.toFixed(3));
}

/** 全文哈希温度（整合阶段用：无 type/funcs，取整篇 draft 特征；FNV-1a 确定性） */
const FNV_PRIME = 16777619;
const FNV_OFFSET = 2166136261;
export function tempFromText(text, min = TEMP_MIN, max = TEMP_MAX) {
  let h = FNV_OFFSET;
  const s = text ?? "";
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  const ratio = (h >>> 0) / 4294967296; // [0,1)
  return Number((min + ratio * (max - min)).toFixed(8));
}

/* ========== 动态字数目标（方案：refs 平均长度定区间，内容承载量感知） ==========
 * 固定字数（配置 200）的缺陷：分镜内容信息量差异大，简单镜注水、复杂镜被压缩。
 * 改为：该镜 refs 的平均字符数 = "这类内容通常写多长" → 目标区间 [0.8×, 1.2×]，
 *       clamp 到 [MIN, MAX] 合理范围；无 refs 时回退配置默认。
 */
const LEN_MIN = 100;    // 字数下限（太短写不开）
const LEN_MAX = 600;    // 字数上限（太长失控）
const LEN_RANGE = [0.8, 1.2]; // 区间系数（信息量弹性）

/** 从该镜 refs 文本算字数目标区间；无参考返回 null（调用方回退配置） */
export function lenTargetFromRefs(refsText, defaultText = "约 200 字") {
  if (!refsText || refsText === "（无参考）") return null;
  // refs 文本 = 多条拼接（"1. [label] 第X章 分镜Y…：正文"）——正文是冒号后的部分
  const bodies = refsText.split("\n").map((l) => l.includes("：") ? l.slice(l.indexOf("：") + 1) : l).filter((x) => x.trim().length > 0);
  if (!bodies.length) return null;
  const avgLen = bodies.reduce((a, b) => a + b.trim().length, 0) / bodies.length;
  const lo = Math.max(LEN_MIN, Math.round(avgLen * LEN_RANGE[0]));
  const hi = Math.min(LEN_MAX, Math.round(avgLen * LEN_RANGE[1]));
  if (hi <= lo) return `${Math.round(avgLen)} 字`; // 区间退化（clamp 后无跨度）→ 单值
  return `${lo}-${hi} 字`;
}

/* ========== 每镜风格锚点（--style：纯程序统计，零 LLM） ==========
 * 风格画像 = statsToJson 程序统计（raw 数值 + labels 语义标签）。
 * LLM 不参与风格提炼（语义输出会过拟合生成结果）——统计只作"形态锚点"：
 * 写作时注入 labels（描述性参考），不注入任何 LLM 语义判断。
 */
/** 每镜统计标签 → 提示词文本（零 LLM） */
function styleStatsToText(st) {
  if (!st) return "";
  const labelLine = Object.entries(st.labels).map(([k, v]) => `${k}:${v}`).join(" | ");
  return `【本镜统计形态（程序实测）】${labelLine}`;
}

/* ========== 逐镜写作参数（合并封装：风格锚点 + 解码四元组，同粒度一次产出） ==========
 * 每镜一次调用，产出该镜完整写作参数：
 *   { styleText: 形态标签文本（--style 时）| "", decode: 四元组 }
 * 解码四元组来源（优先级）：
 *   1. refs 统计解析（decodeParamsFromStats：temperature/top_p/penalties 全从 refs 文本推导）
 *   2. 无 refs 或未开 --style → temperature 用 type+funcs 规则，其余用 API 默认
 */
function shotParams(shot, refsText, useStyle, styleMap) {
  const stats = useStyle ? styleMap.get(shot.seq) : null;
  // decodeCfg 里 supports 是模型能力声明（chat 用），系数部分是 decodeParamsFromStats 用
  const { supports, tempRange, ...coeffCfg } = decodeCfg ?? {};
  const decode = stats ? decodeParamsFromStats(stats, coeffCfg) : null;
  if (decode) {
    // temperature 由 type+funcs 规则出（decode 返回 null 表示不覆盖）；tempRange 存在时按比例映射到目标模型范围
    decode.temperature = tempFromShot(shot, TEMP_BASE, tempRange);
  }
  return {
    styleText: stats ? styleStatsToText(stats) : "",
    decode: decode ?? { temperature: tempFromShot(shot, TEMP_BASE, tempRange) },
  };
}

/* ========== 阶段① 逐镜写作 + 拼接带标签 draft ========== */
const WRITE_SYSTEM = `你是网文作者。根据【任务】写作一个分镜（镜头级片段）。

要求：
- 只输出该分镜的正文，不要输出标题、注释、分析
- 严格遵循该分镜给出的信息，可以拓展情节细节
- 【风格跟随·最高优先级】写作风格以【写作参考】文本的实际写法为准——句式/用词/节奏/口语化/修辞/情绪表达全部向参考靠拢，参考怎么写你就怎么写；
  【本镜统计形态】（--style 时）是程序对参考文本形态的摘要，帮助你更快把握参考的风格——以参考原文的实际读感为准，标签只是提示，不要脱离参考原文照标签行事；
  无参考时采用简洁直白的网文写法（短句优先、不拖沓、点到即止）。
  内容必须用本镜的，不得照搬参考的剧情与专名
- 【修辞从参考】修辞习惯（比喻/夸张/直白/含蓄）跟随参考文本的实际写法，参考怎么用你就怎么用，以参考原文为准，不自行堆砌
- 【排版·网文硬规范】（不受风格跟随影响，任何文风都必须满足）：
  - 段落极短：每段 1-3 句，禁止长段连排；超过 4 句必须断段
  - 对话独占成段：引号内的话单独成段，动作可前置（如「她冷笑：『……』」）或后置，但话本身独占一段
  - 段落之间【空一行】：每段之后一个空行，段与段以单个空行分隔；禁止连续两个以上空行；场景/视角切换同样以空行分段
- 【字数对齐参考】本镜字数对齐【本镜需求】里给出的字数目标区间（由参考分镜实际长度推算，±10% 内），
  信息量大的内容写到区间上限，简单的靠近下限，不要机械凑整数
- 本镜是章节中的独立片段，不写场景开头/结尾的过渡语（衔接由整合阶段统一处理）
- 【叙述人称】正文叙述默认第三人称（姓名/她/他），包括心理描写（内心活动用"她心想/她暗暗"表述）；
  若【写作参考】文本通篇第一人称（"我"作主语叙述），则跟随参考用第一人称；
  无论哪种，本镜内不得混用，禁止在正文叙述中出现"我"（对话引语内人物自称"我"不受影响）
- 主角称呼与上下镜保持一致（本镜若出现人物，沿用其已有称呼，不自行改名）`;

/* ---------- 对话修复（脚本确定性，默认开；--no-fix-dialogue 关闭） ----------
 * 覆盖三类对话问题（全部确定性正则，零 LLM）：
 *  ① 拆句：「"A"动作"B"」→ 动作前置合并「动作"A。B"」（含标点智能处理）
 *  ② 逗号代替冒号：动作+逗号+对话（如 他说，"B"）→ 冒号（他说："B"）
 *  ③ 无标点直接引对话（如 他走过来"B"）→ 冒号（他走过来："B"）
 */

function fixSplitDialogue(text) {
  if (!fixDialogue) return text;
  let total = 0;
  let t = text;

  // ① 拆句修复：「"A"动作"B"」→ 动作"A。B"（动作前置合并）
  t = t.replace(
    /“([^”\n]{2,60})”([^“”\n]{1,40}?)(“([^”\n]{2,60})”)/g,
    (m, a, action, _x, b) => {
      total++;
      let sep = "";
      if (/[。！？…]$/.test(a)) sep = "";
      else if (/[，,]$/.test(a)) sep = "。"; // 逗号替换为句号
      else sep = "。";
      const aClean = a.replace(/[，,]$/, "");
      return `${action.trim()}“${aClean}${sep}${b}”`;
    }
  );

  // ② 逗号代替冒号：动作 + "，" + 引号对话 → 动作 + "：" + 引号对话
  //   匹配：非引号字符(动作) 后跟 逗号 空格? 然后 引号
  t = t.replace(
    /([^“”\n]{1,50}?)[，,]\s*“/g,
    (m, action) => {
      // 动作部分不能以句末标点结尾（若"他笑了。，“B"是另一种情况，跳过）
      if (/[。！？…]$/.test(action)) return m;
      total++;
      return `${action}：“`;
    }
  );

  // ③ 无标点直接引对话：动作 紧跟 引号（如 他走过来"B"）→ 动作："B"
  t = t.replace(
    /([^“”\n]{1,50}?)(?<![:：])\s*“/g,
    (m, action) => {
      // 动作部分若以句末标点或逗号结尾则跳过（已有标点）
      if (/[。！？…，,]$/.test(action)) return m;
      total++;
      return `${action}：“`;
    }
  );

  // ④ 多余冒号：冒号前是"对话引导词"但冒号后不是引号（说明冒号用错了位置，应引出对话）
  //   例："嗤笑：他翘着的腿放下" → "嗤笑，他翘着的腿放下"（引导词后的冒号只能接对话）
  //   只修引导词后(说/道/笑/喊/问/答/叹/斥/喝/冷笑/嗤笑/哼 等)，不碰"价格：五十两"类说明性冒号
  t = t.replace(
    /([^“”\n]{0,20}?(?:说|道|喊|问|答|叹|斥|喝|吼|笑|冷笑|嗤笑|苦笑|哼|嘀咕|叫)[^“”\n]{0,15}?)[：:](?!“)/g,
    (m, action) => {
      total++;
      return `${action}，`;
    }
  );

  if (total > 0) console.log(`  [对话修复] 修复 ${total} 处对话格式（拆句合并/逗号改冒号/补冒号/多余冒号）`);
  return t;
}

/* ================= 主流程（SEA 分发调用 export main） ================= */
export async function main() {
  initWritedraft(); // 惰性初始化（参数/recalls/配置）
  const taskLine = (d) => console.log(`[task] ${JSON.stringify(d)}`); // [task] 进度协议（task/manager.mjs 解析）
  taskLine({ stage: "write", phase: "逐镜写作" });
  const useStyle = args.includes("--style"); // 风格锚点（--style：程序统计注入，零 LLM；默认关闭）
  const styleMap = new Map(); // seq → statsToJson 结果（raw/labels）

  // 风格锚点（--style 开启）：每镜 refs → 程序统计（零 LLM，确定性、可校验）
  if (useStyle) {
    console.log("\n[writedraft] 每镜风格锚点（--style：程序统计 18 维，零 LLM）...");
    const refsOf = shots.map((s) => {
      const refs = s.refs ?? [];
      return refs.length
        ? refs.map((r, i) => `${i + 1}. [${r.source}] 第${r.chapter}章 分镜${r.shotId}（${r.type}/${(r.funcs ?? []).join("、")}「${r.label ?? ""}」）：${r.text ?? ""}`).join("\n")
        : "（无参考）";
    });
    for (let si = 0; si < shots.length; si++) {
      const refsText = refsOf[si];
      if (refsText === "（无参考）") continue;
      const st = statsToJson(refsText);
      styleMap.set(shots[si].seq, st);
    }
    console.log(`  ✓ 统计完成：${styleMap.size}/${shots.length} 镜`);
    for (const [seq, st] of styleMap) console.log(`    [镜${seq}] ${st.summary}`);
    // 注：统计快照不落盘——实时计算产物只在 <项目>draft.txt 中留调试标记（见阶段①）
  } else {
    console.log("[writedraft] 风格锚点：默认关闭（--style 可开启；不传 = 直接以参考文本为风格样例）");
  }

  const shotBodies = [];
  const shotDebugs = []; // 每镜调试标记（统计/字数/温度，写进 draft 供调试，不单独落盘）
  for (let si = 0; si < shots.length; si++) {
  const shot = shots[si];
  const refs = shot.refs ?? [];
  const refsText = refs.length
    ? refs.map((r, i) =>
        `${i + 1}. [${r.source}] 第${r.chapter}章 分镜${r.shotId}（${r.type}/${(r.funcs ?? []).join("、")}「${r.label ?? ""}」）：${r.text ?? ""}`
      ).join("\n")
    : "（无参考）";
  // 上下文（供本镜写作锚定）：前两分镜（更完整的来龙去脉）→ 本镜起点；后一分镜的起点 → 本镜收尾衔接
  const prevShot1 = si > 0 ? shots[si - 1] : null;
  const prevShot2 = si > 1 ? shots[si - 2] : null;
  const nextShot = si < shots.length - 1 ? shots[si + 1] : null;
  const prevText = [
    prevShot2 ? `【前二分镜·第${prevShot2.seq}镜】${prevShot2.type}「${prevShot2.label ?? ""}」：${prevShot2.content ?? ""}` : null,
    prevShot1 ? `【前一分镜·第${prevShot1.seq}镜】${prevShot1.type}「${prevShot1.label ?? ""}」：${prevShot1.content ?? ""}` : "（无前一分镜，本镜是开场）",
  ].filter(Boolean).join("\n");
  const nextText = nextShot
    ? `【后一分镜·第${nextShot.seq}镜】${nextShot.type}「${nextShot.label ?? ""}」：${nextShot.content ?? ""}`
    : "（无后一分镜，本镜是收尾）";
  // 逐镜写作参数（合并封装：风格锚点 + 解码四元组，一次产出）
  const { styleText, decode: shotDecode } = shotParams(shot, refsText, useStyle, styleMap);
  // 动态字数目标：该镜 refs 平均长度定区间（信息量感知）；无 refs 回退配置默认
  const lenTarget = lenTargetFromRefs(refsText) ?? lenTargetText;
  const userMsg = [
    "## 任务：写一个分镜文本",
    "",
    "### 前后分镜上下文（明确衔接，写作本镜时必须与它们连贯）",
    prevText,
    nextText,
    "注意：你写的是【中间的本镜】，前一分镜（含前二分镜）是它的来龙去脉，后一分镜是它的终点——",
    "本镜的结尾要为后一分镜的起点留好衔接（人物状态/场景/事件），本镜开头要承接前一分镜的结局（如有前二分镜，本镜的铺垫/伏笔要延续其走向）。",
    "",
    "### 写作参考（本分镜内容在别处的实际写法——风格以此为准）",
    refsText,
    "",
    "### 本镜统计形态（程序对上述参考的形态摘要，帮助你更快把握其风格——以参考原文实际读感为准）",
    styleText || "（本镜无统计，按参考文本自行把握）",
    "",
    "### 时空映射：先理解平行时空，再写本时空（必须执行）",
    "【参考定位】以下【写作参考】是本分镜内容在**不同时空下可能呈现的映射**——它们描述的可能是",
    "同一类事件/场景/情绪在另一本书、另一段剧情里的样子。你需要：",
    "①【理解映射】看懂参考在「不同时空」里是怎么呈现这类内容的（人物怎么反应、场景怎么铺、对话怎么走）",
    "②【对齐本质】从参考原文感受句式律动与叙述口吻（句长/停顿/吐槽腔/市井感）——这些是跨时空不变的写法",
    "③【按本时空写】现在回到本时空（本镜），用从参考原文感受到的律动和口吻，按【本镜需求】的内容写作；",
    "   参考的具体人物/事件/设定是「另一时空」的，不得带入，只学它的「写法」",
    "",
    "### 本镜需求",
    `类型: ${shot.type}`,
    `功能: ${(shot.funcs ?? []).join("、")}`,
    `标签: ${shot.label ?? ""}`,
    `内容: ${shot.content ?? ""}`,
    `字数目标: ${lenTarget}`,
    "",
    "### 参考借用规则（显式声明）",
    "参考是「另一时空」的映射。仅当参考中的人物、事件、设定与【本镜需求】的内容**完全重合**时，",
    "才允许将其作为本镜的设定沿用；与【本镜需求】不重合的参考内容，一律忽略，不得引入本镜。",
    "【专名保护】参考中的专有名词（人名/地名/物品名/组织名）除非与【本镜需求】逐字相同，",
    "否则一律不得引入本镜；本镜的人物、称呼、物品以【本镜需求】为准，参考不得给本镜添加角色或改名。",
    "参考主要用途是：学其写法（句式/口吻/节奏/场景呈现），并作为字数基准。",
    "",
    "## 输出要求",
    "风格以【写作参考】为基准（参考怎么写你怎么写）；无参考时简洁直白、不拖沓。贴合本镜 type/funcs/内容；字数对齐字数目标（±10%）。",
    "只输出该分镜的正文文本，不要任何格式说明。",
  ].join("\n");
  const raw = await chat([
    { role: "system", content: WRITE_SYSTEM },
    { role: "user", content: userMsg },
  ], null, false, shotDecode, decodeCfg); // 解码四元组 + 模型能力声明（不支持的参数回退 API 默认）；thinking 禁
  shotBodies.push(raw.trim());
  // 调试标记（draft 内联，供调试；不单独落盘 style-profiles）
  const st = styleMap.get(shot.seq);
  const d = shotDecode ?? {};
  const dstr = `t=${d.temperature ?? "-"} p=${d.top_p ?? "-"} fp=${d.frequency_penalty ?? "-"} pp=${d.presence_penalty ?? "-"}`;
  shotDebugs.push(`  [debug] 统计: ${st?.summary ?? "无"} | 字数目标: ${lenTarget} | 解码: ${dstr}`);
  console.log(`  [${shot.seq}] ${shot.type}「${shot.label ?? ""}」 → ${raw.length} 字符（${dstr}，字数目标=${lenTarget}）`);
}

/* 拼接：带分镜标签的 draft（中间产物）——每镜内联调试标记（统计/字数/温度），供调试 */
const taggedDraft = shotBodies.map((body, i) => {
  const s = shots[i];
  const dbg = shotDebugs[i] ?? "";
  return `【镜${i + 1}｜${s.type}｜${s.label ?? ""}】\n${body}\n${dbg}`;
}).join("\n\n");

const draftName = `${project}draft.txt`; // <项目名>draft.txt（现有风格：项目名 + draft）
fs.mkdirSync(sessionDir, { recursive: true });
fs.writeFileSync(path.join(sessionDir, draftName), taggedDraft, "utf-8");
console.log(`\n[writedraft] 阶段① draft 已落盘（中间产物，带分镜标签）:`);
console.log(`   ${sessionsDir}/${sessionId}/${draftName}（${taggedDraft.length} 字符）`);

/* ========== 测试模式：不做最终整合，分镜完成后直接拼接 ==========
 * --test-mode 时跳过阶段②全文整合，把带标签的分镜文本直接作为最终稿落盘。
 * 用途：调试逐镜写作质量（不含整合环节的干扰），或快速产出原始分镜拼接稿。
 */
const testMode = args.includes("--test-mode");
if (testMode) {
  console.log("\n[writedraft] 测试模式：不做最终整合，分镜完成后直接拼接...");
  const finalText = taggedDraft; // 直接拼接（保留分镜标签）
  fs.mkdirSync(outputDir, { recursive: true });
  const finalName = `${project}.final.txt`;
  fs.writeFileSync(path.join(outputDir, finalName), finalText, "utf-8");
  console.log(`\n✅ 最终稿已生成（测试模式，未整合）:`);
  console.log(`   中间产物: ${sessionsDir}/${sessionId}/${draftName}（带标签，会话存档）`);
  console.log(`   最终稿:   output/${sessionId}/${finalName}（测试模式：分镜直接拼接，含标签）`);
  console.log(`\n=== 最终稿预览 ===`);
  console.log(finalText.slice(0, 600) + (finalText.length > 600 ? "\n…" : ""));
  process.exit(0);
}

/* ========== 阶段② 全文整合（draft + 章纲 → 最终稿，最小改动整合） ==========
 * 前置剥离（脚本，零 LLM）：把带标签 draft 中的【镜N｜type｜label】标签和 [debug] 调试行
 * 全部剥掉，只传纯正文给整合 LLM——LLM 无需费心删标签，final 必然干净。
 */
console.log("\n[writedraft] 阶段② 全文整合（剥离标签/debug → draft 纯正文 + 原始章纲 → 完整章节，最小改动衔接）...");
taskLine({ stage: "write", phase: "全文整合" });
const cleanDraft = taggedDraft
  .split("\n")
  .filter((l) => !/^【镜\d+｜/.test(l.trim()) && !/^\s*\[debug\]/.test(l))
  .map((l) => l.trimEnd())
  .join("\n")
  .replace(/\n{3,}/g, "\n\n")   // 段落间空一行：多空行归一到单个空行（保留段间空行）
  .replace(/^\n+|\n+$/g, ""); // 去首尾空行
console.log(`  [剥离] 标签+debug 已剔除（${taggedDraft.length} → ${cleanDraft.length} 字符，仅纯正文进 LLM）`);
const MERGE_SYSTEM = `你是编辑。把一组带标签的分镜文本整合为一个连贯章节。

【硬约束】
- 只做拼接与去标签，正文【逐字保留】：不扩写、不删减、不润色、不新增任何情节/台词/设定
- 仅允许最小调整：消除镜间重复；统一前后指代；保持时间线顺序
- 分镜中出现原始章纲未指定的人物台词或设定 → 删除或改为不特定表述
- 【视角统一】检查全章叙述人称（第一人称"我" vs 第三人称姓名/她），判断多数镜采用的人称，
  全文统一为该人称：第一人称则把正文叙述中的主角姓名改为"我"（对话引语内不改），
  第三人称则把正文叙述中的"我"改为主角姓名/她（对话引语内不改）；全文不得混用
- 【人称细节】判断人称时数【镜数/段落数】而非"我"字出现频次（心理独白中"我"密度极高，会误判多数）；
  心理描写的人称必须与全篇一致；若全篇为第三人称，只允许把残留的第一人称叙述改为第三人称，
  【禁止】把已有的第三人称叙述（姓名/她）改写为第一人称"我"
- 【对话归属】每个引号段内只允许一个说话人；两镜拼接处若出现「人物A动作+冒号/逗号」紧接「人物B的对话」，
  必须补全分割并分成两个段落，不得让两个说话人共享同一引号块（典型错误：『挤出两个字：曹攸宁点头："他认了"』）
- 【称呼统一】同一人物全篇使用单一称呼（对话引语内按原文保留），以正文中已出现的称呼为准，
  不得在同一场景混用不同称呼（如曹娘子/曹小姐/攸宁）
- 【标点】引号内需要再引用词语/书名时，内层改用单引号（如：他说到'复旨'二字），禁止双引号嵌套双引号
- 【引导语完整】『某人道/缓声道/冷声道』等引导语后必须紧跟该人所说的话，中间不得插入他人动作或第三人称描述
- 【排版】段间空一行（现代网文排版）：每段之后一个空行，段落以单个空行分隔；禁止连续两个以上空行
- 输出纯正文章节，只输出正文`;
const mergeUser = [
  "### 原始章纲（供你把握整体意图）",
  outline,
  "",
  "### 分镜正文（已去标签，按顺序，直接整合）",
  cleanDraft,
].join("\n\n");
// 整合温度：从剥离后的纯正文提炼一个 temperature（8 位小数，确定性：同正文同值）
const mergeTemp = tempFromText(cleanDraft);
const mergeRaw = await chat([
  { role: "system", content: MERGE_SYSTEM },
  { role: "user", content: mergeUser },
], null, false, { temperature: mergeTemp }, decodeCfg); // 全文整合：只调温度，其余用 API 默认；thinking 禁
const finalText = mergeRaw.trim();
console.log(`  [整合] 最终稿 ${finalText.length} 字符（temp=${mergeTemp}）`);
// 对话拆分修复（默认开；--no-fix-dialogue 关闭）：整合完成后统一检测「"A"动作，"B"」重排为合法句式
const fixedFinalText = fixSplitDialogue(finalText);
const finalOut = fixedFinalText;

/* ---------- 落盘：最终稿 → NovelyWrite/output/ ---------- */
fs.mkdirSync(outputDir, { recursive: true });
const finalName = `${project}.final.txt`; // <项目名>.final.txt（最终整合稿，纯正文）
fs.writeFileSync(path.join(outputDir, finalName), finalOut, "utf-8");
console.log(`\n✅ 最终稿已生成:`);
console.log(`   中间产物: ${sessionsDir}/${sessionId}/${draftName}（带标签，会话存档）`);
console.log(`   最终稿:   output/${sessionId}/${finalName}（纯正文，用户可读）`);
console.log(`\n=== 最终稿预览 ===`);
console.log(finalOut.slice(0, 600) + (finalOut.length > 600 ? "\n…" : ""));
taskLine({ stage: "done", phase: `成稿完成（${finalOut.length} 字符）` });
}

// 直接运行（源码 CLI / SEA 分发调用 export main）
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(".mjs") && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error("[writedraft] 失败:", err.message); process.exit(1); });
}
