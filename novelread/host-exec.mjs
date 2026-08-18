/**
 * host-exec.mjs — 宿主执行器（事实层，阶段一）——两往返 + 硬闸门版（对齐新版 SKILL）
 *
 * 职责：逐章执行 2 次 LLM 往返：
 *   往返1（句子）：原文切片 → 句子 JSON → 【硬闸门A】句子层校验 → 落盘（句子冻结=唯一权威源）
 *   往返2（分镜+章节）：句子 JSON → 分镜 JSON + 章节标注 JSON → 【硬闸门B】分镜/章节校验 → 落盘
 *   派生字段（derive）→ 整章复检（check-chapter）→ 批末 issue 汇总 + 向量构建。
 *
 * 硬闸门语义：往返1 不过闸 → 不执行往返2（该章跳过标记）；往返2 不过闸 → 本章跳过（句子已落盘）。
 * 语料分章由宿主脚本生成（corpus 切片，跳过标题行）。
 *
 * 章节清单自动按语料名查找：corpus/<语料名>-章节清单.csv（不存在则回退 corpus/章节清单.csv）。
 * LLM 调用自带 thinking 禁用（reasoning 模型长任务适配）。
 *
 * 用法：
 *   node novelread/host-exec.mjs --corpus=红楼梦 --chapter=1 [--chapter=2 ...]
 *   node novelread/host-exec.mjs --corpus=红楼梦 --all
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildVectors } from "../retriever/build-derived.mjs";
import { checkJsonText } from "./verify-json.mjs";
import { execFileSync } from "node:child_process";
import { deriveChapter } from "./derive-chapter.mjs";
import { loadSkillSlice } from "../shared/skill-slice.mjs";
import { CODE_ROOT, DATA_ROOT, storeDir, corpusDir } from "../shared/paths.mjs";
import { loadChatConfig } from "../shared/config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ========== 自带 LLM 调用（不依赖 shared/llm.mjs 的 chatStream） ==========
 * 原因：deepseek-v4-flash 为 reasoning 模型，长任务下思考会吃光 max_tokens
 * （finish_reason=length，reasoning_tokens=65534，content 为空）。
 * 需要传 thinking:{type:"disabled"} 禁用思考，直接输出正文。
 * 配置来源：数据根 config.json 的 chat 段（shared/config.mjs loadChatConfig，NOVELYWRITE_CHAT_API_KEY/NOVELYWRITE_CHAT_BASE_URL 可覆盖）。 */
const chatCfg = loadChatConfig();
const baseUrl = (chatCfg.baseUrl ?? "https://api.deepseek.com/v1").replace(/\/+$/, "");

/** 流式 chat（thinking 禁用，reasoning 模型长任务专用） */
async function chatStreamNoThinking(messages, opts = {}) {
  const body = {
    model: opts.model ?? chatCfg.model,
    messages,
    temperature: opts.temperature ?? chatCfg.temperature ?? 0.8,
    stream: true,
    thinking: { type: "disabled" },
  };
  if (opts.maxTokens !== null) body.max_tokens = opts.maxTokens ?? chatCfg.maxTokens ?? 65536;

  let lastError = null;
  const maxRetries = chatCfg.maxRetries ?? 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    let timer = null;
    if (opts.timeoutMs !== null) {
      timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? chatCfg.timeoutMs ?? 300000);
    }
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${chatCfg.apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullContent = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const chunk = JSON.parse(data);
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              fullContent += delta;
              opts.onDelta?.(delta);
            }
          } catch { /* 跳过无法解析的行 */ }
        }
      }
      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith("data:")) {
          const data = trimmed.slice(5).trim();
          if (data !== "[DONE]") {
            try {
              const chunk = JSON.parse(data);
              const delta = chunk.choices?.[0]?.delta?.content;
              if (delta) fullContent += delta;
            } catch { /* ignore */ }
          }
        }
      }
      if (!fullContent.trim()) {
        throw new Error("LLM 流式返回空内容（可能思考模式未禁用或 API 异常）");
      }
      return fullContent;
    } catch (err) {
      lastError = err;
      const retryable = err.name === "AbortError" || /429|5\d\d/.test(err.message);
      if (retryable && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

// ---------- 解析参数 ----------
const args = process.argv.slice(2);
function argVal(name) {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
}
const corpusName = argVal("corpus") ?? "红楼梦";
const chapterArgs = argVal("chapter");
const doAll = args.includes("--all");
const chapters = doAll ? null : (chapterArgs ? chapterArgs.split(",").map(Number) : null);

const CORPUS_PATH = path.join(corpusDir, `${corpusName}-语料.txt`);
// 按语料名查找专属清单，不存在则回退通用清单
const LIST_CANDIDATES = [
  path.join(corpusDir, `${corpusName}-章节清单.csv`),
  path.join(corpusDir, "章节清单.csv"),
];
const LIST_PATH = LIST_CANDIDATES.find((p) => fs.existsSync(p));
const PROJECT_DIR = path.join(storeDir, `${corpusName}project`);

function readLines(p) {
  return fs.readFileSync(p, "utf-8").replace(/\r\n/g, "\n").split("\n");
}

/** 遍历 project 目录，返回相对路径列表 */
function walkProject(dir, prefix = "") {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix + e.name;
    if (e.isDirectory()) out.push(...walkProject(path.join(dir, e.name), rel + "/"));
    else out.push(rel);
  }
  return out.sort();
}

/** 读章节清单（章号/标题/起始行/结束行） */
function readChapterList() {
  if (!LIST_PATH) return [];
  const lines = readLines(LIST_PATH);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    // CSV: 章号,标题,语料起始行,语料结束行,字符数（标题内可能含逗号，从右侧取数字列）
    const m = l.match(/^(\d+),(.+),(\d+),(\d+),(\d+)$/);
    if (!m) continue;
    rows.push({ number: Number(m[1]), title: m[2].trim(), start: Number(m[3]), end: Number(m[4]) });
  }
  return rows;
}

/** 修复 JSON 字符串值内的裸换行/制表符（LLM 大输出常见：未转义的 \n 破坏解析） */
function repairBareNewlines(text) {
  let out = "";
  let inStr = false, esc = false;
  for (const ch of text) {
    if (esc) { out += ch; esc = false; continue; }
    if (ch === "\\") { out += ch; esc = true; continue; }
    if (ch === '"') { out += ch; inStr = !inStr; continue; }
    if (inStr) {
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { out += "\\r"; continue; }
      if (ch === "\t") { out += "\\t"; continue; }
    }
    out += ch;
  }
  return out;
}

/** 解析 LLM 输出为 {路径: 内容} 对象 */
function parsePayload(raw) {
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  let obj = null;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    // 尝试修复字符串内裸换行后重试
    try {
      obj = JSON.parse(repairBareNewlines(cleaned));
    } catch {
      const s = cleaned.indexOf("{");
      const e = cleaned.lastIndexOf("}");
      if (s >= 0 && e > s) {
        const slice = cleaned.slice(s, e + 1);
        try { obj = JSON.parse(slice); } catch {
          try { obj = JSON.parse(repairBareNewlines(slice)); } catch { /* 继续 */ }
        }
      }
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error(`LLM 输出非 JSON 对象。前 200 字符：\n${raw.slice(0, 200)}`);
  }
  return obj;
}

/* ================= 硬闸门校验（内联轻量，对齐 SKILL 契约） ================= */

const STRUCTS = ["短句", "句从"];
const SHOT_TYPES = ["信息", "对话", "心理", "动作", "事件", "环境"];
const SHOT_FUNCS = ["塑造人物", "引入世界观", "设置动机", "推进", "铺垫", "反转", "爆发", "转场", "收束分镜", "悬念"];
const CHAPTER_FUNCS = ["开端", "推进", "铺垫", "爆发", "转折", "收束章节", "过渡"];
const MAINLINE_STATES = ["主线启动", "推进", "受阻", "达成", "更换"];

/** 硬闸门 A：句子层校验（S#连续/struct枚举/text非空） */
function gateSentences(sentJson) {
  const issues = [];
  const s = sentJson?.sentences ?? [];
  if (!s.length) issues.push("句子数组为空");
  if (s.length && !s.every((x, i) => x.id === `S${i + 1}` && x.seq === i + 1)) issues.push("S#/seq 不连续");
  if (s.some((x) => !STRUCTS.includes(x.struct))) issues.push("struct 枚举非法");
  if (s.some((x) => !(x.text ?? "").trim())) issues.push("存在空 text");
  return { ok: issues.length === 0, issues };
}

/** 硬闸门 B1：分镜层校验（覆盖无缝/type/funcs枚举） */
function gateShots(shotJson, sentJson) {
  const issues = [];
  const sh = shotJson?.shots ?? [];
  const sents = sentJson?.sentences ?? [];
  const allIds = sh.flatMap((x) => x.sentenceIds ?? []);
  const uniq = new Set(allIds);
  if (uniq.size !== allIds.length) issues.push("分镜 sentenceIds 有重叠");
  if (allIds.length !== sents.length) issues.push(`分镜覆盖 ${allIds.length} 句，应=${sents.length}`);
  if (allIds.some((id, i) => id !== `S${i + 1}`)) issues.push("分镜 sentenceIds 不连续");
  if (sh.some((x) => !SHOT_TYPES.includes(x.type))) issues.push("type 枚举非法");
  if (sh.some((x) => !(x.funcs ?? []).length || x.funcs.some((f) => !SHOT_FUNCS.includes(f)))) issues.push("funcs 枚举非法或为空");
  return { ok: issues.length === 0, issues };
}

/** 硬闸门 B2：章节层校验（function/summary/state） */
function gateChapter(chJson) {
  const issues = [];
  if (!chJson?.function || !CHAPTER_FUNCS.includes(chJson.function)) issues.push(`function 非法「${chJson?.function}」`);
  if (!chJson?.summary || !chJson.summary.trim()) issues.push("summary 为空");
  const badState = (chJson?.mainlineProgress ?? []).filter((m) => !MAINLINE_STATES.includes(m.state));
  if (badState.length) issues.push("mainlineProgress.state 枚举非法");
  return { ok: issues.length === 0, issues };
}

/* ================= 主流程 ================= */

async function main() {
  // SKILL 按层切片：往返1（sentence）/ 往返2（shot-chapter）各取对应段落，省重复 token
  const skillA = loadSkillSlice("sentence");
  const skillB = loadSkillSlice("shot-chapter");
  const corpusLines = readLines(CORPUS_PATH);
  const list = readChapterList();
  if (!list.length) throw new Error(`章节清单为空: ${LIST_PATH ?? "未找到 <语料名>-章节清单.csv 或 章节清单.csv"}`);
  console.log(`[host] 语料 ${corpusName}，共 ${list.length} 章，清单: ${LIST_PATH}`);

  const todo = doAll
    ? list
    : list.filter((c) => chapters.includes(c.number));
  if (!todo.length) throw new Error(`没有要处理的章: ${chapters ?? "all"}`);

  const existing = walkProject(PROJECT_DIR);
  const chapterIssues = [];
  function extractIssues(out, ch) {
    return out.split("\n").filter((l) => l.includes("✗") || l.includes("❌")).map((l) => `第${ch}章: ${l.trim()}`);
  }

  /** 调 LLM 并解析（失败存 raw，返回 null）；skill 按层传入（往返1/往返2 各取切片） */
  async function callLlm(userMsg, ch, skill) {
    console.log("[host] 调用 LLM（streaming + thinking 禁用，max_tokens=65536 / 无超时）...");
    const t0 = Date.now();
    const raw = await chatStreamNoThinking([{ role: "system", content: skill }, { role: "user", content: userMsg }], { maxTokens: 65536, timeoutMs: null });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[host] LLM 返回 ${raw.length} 字符（耗时 ${secs}s）`);
    try {
      return { payload: parsePayload(raw), raw };
    } catch (err) {
      console.error("[host] 解析失败，原始输出已存盘供检查:", err.message);
      fs.writeFileSync(path.join(CODE_ROOT, "novelread", "state", `raw-${corpusName}-ch${String(ch.number).padStart(3, "0")}.txt`), raw, "utf-8");
      return null;
    }
  }

  for (const ch of todo) {
    console.log(`\n========== [host] 第${ch.number}章《${ch.title}》（语料行 ${ch.start}-${ch.end}）==========`);
    const text = corpusLines.slice(ch.start, ch.end).join("\n"); // 正文（跳过标题行）
    console.log(`[host] 本章语料 ${text.length} 字符`);

    // 语料分章（宿主脚本，总是写——独立于 LLM 成败）
    {
      const splitDir = path.join(PROJECT_DIR, "语料分章");
      fs.mkdirSync(splitDir, { recursive: true });
      const splitName = `第${String(ch.number).padStart(4, "0")}章_${ch.title}.txt`;
      fs.writeFileSync(path.join(splitDir, splitName), text, "utf-8");
      console.log(`  [写] 语料分章/${splitName}（脚本生成，${text.length} 字符）`);
    }

    /* ===== 往返1：句子（硬闸门 A） ===== */
    console.log("\n---------- 往返1：句子层 ----------");
    const userA = [
      "## 本次输入",
      `- 本次往返：**往返1（句子层）**——只输出 句子标注/json/第XXXX章.json 一个文件`,
      `- 本次范围：第${ch.number}章《${ch.title}》（语料行 ${ch.start}-${ch.end}）`,
      "",
      "### 本章语料原文",
      "```", text, "```",
      "",
      "请按《语料分析-SKILL》【往返1：句子层】执行：按停顿标点切分句子 + struct 标注（短句/句从）。",
      "注意：① 派生字段（shotId）由宿主脚本生成，不得输出；② 句子只覆盖正文（标题行不属于正文）；③ text 逐字保留原文。",
      "JSON 转义要求：所有字符串值内的换行必须转义为 \\\\n（不得出现未转义的真实换行符）。",
      "输出格式：一个 JSON 对象，键 = project 内相对路径（用 \"/\"），值 = 该文件完整内容。只输出这个 JSON。",
    ].join("\n");
    const r1 = await callLlm(userA, ch, skillA);
    if (!r1) { chapterIssues.push(`第${ch.number}章 往返1 解析失败`); continue; }
    const sentKey = Object.keys(r1.payload).find((k) => k.includes("句子标注") && k.endsWith(".json"));
    if (!sentKey) {
      console.error(`[往返1✗] 缺句子 JSON，实际键: ${Object.keys(r1.payload).join(", ")}`);
      chapterIssues.push(`第${ch.number}章 往返1 缺句子 JSON`);
      continue;
    }
    let sentData = typeof r1.payload[sentKey] === "string" ? r1.payload[sentKey] : JSON.stringify(r1.payload[sentKey], null, 2);
    const gvA = checkJsonText(sentData);
    if (!gvA.ok) { console.error(`[往返1 gate✗] 句子语法非法: ${gvA.kind} @行${gvA.line}`); chapterIssues.push(`第${ch.number}章 往返1 句子语法非法`); continue; }
    const sentJson = JSON.parse(sentData);
    const gA = gateSentences(sentJson);
    if (!gA.ok) {
      console.error(`[硬闸门A✗] ${gA.issues.join("; ")} → 本章跳过（不执行往返2）`);
      chapterIssues.push(`第${ch.number}章 往返1 句子层校验失败: ${gA.issues.join("; ")}`);
      continue;
    }
    fs.mkdirSync(path.dirname(path.join(PROJECT_DIR, sentKey)), { recursive: true });
    fs.writeFileSync(path.join(PROJECT_DIR, sentKey), sentData, "utf-8");
    console.log(`  [写] ${sentKey}（${sentData.length} 字符）→ 句子层冻结（唯一权威源）`);

    /* ===== 往返2：分镜 + 章节（硬闸门 B） ===== */
    console.log("\n---------- 往返2：分镜层 + 章节层 ----------");
    const userB = [
      "## 本次输入",
      `- 本次往返：**往返2（分镜层+章节层）**——只输出 分镜标注/json/第XXXX章.json + 章节/第XXXX章.json 两个文件`,
      `- 本次范围：第${ch.number}章《${ch.title}》`,
      "",
      "### 句子 JSON（唯一输入，句子边界为权威，不得修改句子）",
      "```json",
      sentData,
      "```",
      "",
      "请按《语料分析-SKILL》【往返2：分镜层+章节层】执行：",
      "① 分镜层：以句子序列为输入，按切镜判据划分分镜 → type/funcs/label 标注（sentenceIds 引用句子）",
      "② 章节层：function（七种）/ summary / mainlineProgress",
      "注意：派生字段（sentenceRange/stats/suspense）由宿主脚本生成，不得输出。",
      "JSON 转义要求：所有字符串值内的换行必须转义为 \\\\n（不得出现未转义的真实换行符）。",
      "输出格式：一个 JSON 对象，键 = project 内相对路径（用 \"/\"），值 = 该文件完整内容。只输出这个 JSON。",
    ].join("\n");
    const r2 = await callLlm(userB, ch, skillB);
    if (!r2) { chapterIssues.push(`第${ch.number}章 往返2 解析失败`); continue; }
    const shotKey = Object.keys(r2.payload).find((k) => k.includes("分镜标注") && k.endsWith(".json"));
    const chKey = Object.keys(r2.payload).find((k) => k.startsWith("章节/") && k.endsWith(".json") && !k.endsWith("章节表.json"));
    if (!shotKey || !chKey) {
      console.error(`[往返2✗] 缺分镜/章节 JSON，实际键: ${Object.keys(r2.payload).join(", ")}`);
      chapterIssues.push(`第${ch.number}章 往返2 缺分镜/章节`);
      continue;
    }
    let shotData = typeof r2.payload[shotKey] === "string" ? r2.payload[shotKey] : JSON.stringify(r2.payload[shotKey], null, 2);
    let chData = typeof r2.payload[chKey] === "string" ? r2.payload[chKey] : JSON.stringify(r2.payload[chKey], null, 2);
    const gvB1 = checkJsonText(shotData), gvB2 = checkJsonText(chData);
    if (!gvB1.ok || !gvB2.ok) {
      console.error(`[往返2 gate✗] 分镜/章节语法非法: ${gvB1.ok ? "" : gvB1.kind} / ${gvB2.ok ? "" : gvB2.kind}`);
      chapterIssues.push(`第${ch.number}章 往返2 分镜/章节语法非法`);
      continue;
    }
    const shotJson = JSON.parse(shotData), chJson = JSON.parse(chData);
    const gB = [...gateShots(shotJson, sentJson).issues, ...gateChapter(chJson).issues];
    if (gB.length) {
      console.error(`[硬闸门B✗] ${gB.join("; ")} → 本章跳过（句子已落盘）`);
      chapterIssues.push(`第${ch.number}章 往返2 校验失败: ${gB.join("; ")}`);
      continue;
    }
    fs.mkdirSync(path.dirname(path.join(PROJECT_DIR, shotKey)), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(PROJECT_DIR, chKey)), { recursive: true });
    fs.writeFileSync(path.join(PROJECT_DIR, shotKey), shotData, "utf-8");
    fs.writeFileSync(path.join(PROJECT_DIR, chKey), chData, "utf-8");
    console.log(`  [写] ${shotKey} + ${chKey}`);

    // 派生字段（shotId/range/stats/suspense——脚本生成）
    const der = deriveChapter(PROJECT_DIR, ch.number);
    for (const d of der.derived) console.log(`  [派生] ${d} 已生成`);
    for (const n of der.note) console.log(`  [待修] ${n}`);

    // 整章复检（check-chapter，软记录不阻塞）
    try {
      const out = execFileSync(process.execPath, [path.join(__dirname, "check-chapter.mjs"), corpusName, String(ch.number)], { encoding: "utf-8" });
      console.log(out.trim());
      chapterIssues.push(...extractIssues(out, ch.number));
    } catch (e) {
      const msg = (e.stdout ?? "").toString();
      console.log(msg.trim() || `[检测✗] 第${ch.number}章检测异常: ${e.message}`);
      chapterIssues.push(`第${ch.number}章`);
    }
    existing.splice(0, existing.length, ...walkProject(PROJECT_DIR));
    // 成功落盘 → 删除本轮的 raw 解析失败留档（成功即留档使命结束，防 state/ 堆积）
    const rawP = path.join(CODE_ROOT, "novelread", "state", `raw-${corpusName}-ch${String(ch.number).padStart(3, "0")}.txt`);
    if (fs.existsSync(rawP)) { fs.unlinkSync(rawP); console.log(`  [清理] 删除过期留档 ${path.basename(rawP)}`); }
    console.log(`[host] 第${ch.number}章完成`);
  }

  console.log("\n[host] 全部完成。产出文件：");
  for (const f of walkProject(PROJECT_DIR)) console.log("  " + f);

  if (chapterIssues.length) {
    console.log(`\n⚠ 检测发现 ${chapterIssues.length} 项问题（不阻塞，建议处理后重跑对应章）：`);
    for (const i of chapterIssues) console.log("  - " + i);
  } else {
    console.log("\n✅ 章级检测全部通过（所有章 4 文件齐全 + 语法 + 契约）");
  }

  // 整批完成后统一触发向量增量构建（embed 未就绪则跳过）
  console.log("\n[host] 触发向量增量构建...");
  const vresult = await buildVectors({ projects: [corpusName] });
  if (vresult?.ok) {
    console.log(`[host] 向量构建完成：${vresult.index.stats.totalShots} 分镜 / ${vresult.index.stats.totalChapters} 章`);
  } else {
    console.log(`[host] 向量构建跳过：${vresult?.reason ?? "未知原因"}（${vresult?.guidance ?? ""}）`);
  }
}

// 仅直接运行时执行 main
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[host] 失败:", err);
    process.exit(1);
  });
}

export { main };
