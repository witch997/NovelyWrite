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
import { STRUCTS, SHOT_TYPES, SHOT_FUNCS, CHAPTER_FUNCS } from "./enums.mjs";
import { loadSkillSlice } from "../shared/skill-slice.mjs";
import { DATA_ROOT, storeDir, corpusDir, projectRoot, DOMAIN, createProject, outputDir, cliArgs, runScriptArgs, mybookDir } from "../shared/paths.mjs";
import { loadChatConfig } from "../shared/config.mjs";
import { chapterHash, readFingerprints, writeFingerprints } from "../task/fingerprint.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ========== 自带 LLM 调用 ==========
 * 原因：deepseek-v4-flash 为 reasoning 模型，长任务下思考会吃光 max_tokens
 * （finish_reason=length，reasoning_tokens=65534，content 为空）。
 * 需要传 thinking:{type:"disabled"} 禁用思考，直接输出正文。
 * 配置来源：数据根 config.json 的 chat 段（shared/config.mjs loadChatConfig，NOVELYWRITE_CHAT_API_KEY/NOVELYWRITE_CHAT_BASE_URL 可覆盖）。 */
let chatCfg = null; // 惰性（被 import 时不可读 config——全新目录无 config.json 会炸；main 内赋值）
let baseUrl = "";

/** 流式 chat（thinking 禁用，reasoning 模型长任务专用） */
async function chatStreamNoThinking(messages, opts = {}) {
  const body = {
    model: opts.model ?? chatCfg.model,
    messages,
    temperature: opts.temperature ?? chatCfg.temperature ?? 0.8,
    stream: true,
    thinking: { type: "disabled" },
    // 流式末尾 chunk 附带 usage（token 消耗统计用；不影响内容流）
    stream_options: { include_usage: true },
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
    let usage = null; // 本次调用 token 消耗（末 chunk 携带）
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
            if (chunk.usage) usage = chunk.usage; // 末 chunk（choices 空）带 usage
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
              if (chunk.usage) usage = chunk.usage;
              const delta = chunk.choices?.[0]?.delta?.content;
              if (delta) fullContent += delta;
            } catch { /* ignore */ }
          }
        }
      }
      if (!fullContent.trim()) {
        throw new Error("LLM 流式返回空内容（可能思考模式未禁用或 API 异常）");
      }
      return { content: fullContent, usage };
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

// ---------- 解析参数（移入 main，支持 SEA 分发注入 argv） ----------
function readLines(p) {
  return fs.readFileSync(p, "utf-8").replace(/\r\n/g, "\n").split("\n");
}

/** LLM 原始输出留档路径（数据根 output/raw/——代码根只读场景不可写，诊断文件必须随数据走）
 * 原实现写 CODE_ROOT/novelread/state 且无保护：目录不可写时 writeFileSync 抛错会冒泡
 * 崩掉整个 annotate 任务（而非记 pending 跳章）。统一挪数据根 + 调用方包 try。 */
function rawDumpFile(corpusName, chNum, suffix = "") {
  return path.join(outputDir, "raw", `raw-${corpusName}-ch${String(chNum).padStart(3, "0")}${suffix}.txt`);
}

/** 写留档（自动建目录，失败不抛）——留档是诊断辅助，任何失败都不应阻塞主流程 */
function writeRawDump(file, content) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf-8");
  } catch { /* 留档失败静默（数据根也不可写时跳过） */ }
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
  const badFuncs = sh
    .filter((x) => !(x.funcs ?? []).length || x.funcs.some((f) => !SHOT_FUNCS.includes(f)))
    .map((x) => `镜${x.id ?? "?"} funcs=[${(x.funcs ?? []).join(",")}]`);
  if (badFuncs.length) issues.push(`funcs 枚举非法或为空: ${badFuncs.join("; ")}`);
  return { ok: issues.length === 0, issues };
}

/** 硬闸门 B2：章节层校验（function/summary）——2026-09-04 mainlineProgress.state 校验已移除 */
function gateChapter(chJson) {
  const issues = [];
  if (!chJson?.function || !CHAPTER_FUNCS.includes(chJson.function)) issues.push(`function 非法「${chJson?.function}」`);
  if (!chJson?.summary || !chJson.summary.trim()) issues.push("summary 为空");
  return { ok: issues.length === 0, issues };
}

/* ================= 主流程 ================= */

let LIST_PATH = null; // 章节清单路径（模块级 let——readChapterList 等模块级函数引用；main 内赋值）

export async function main(argv = cliArgs()) {
  // ---------- 解析参数（SEA 分发注入 argv；源码模式默认 process.argv） ----------
  const args = argv;
  const argVal = (name) => {
    const a = args.find((x) => x.startsWith(`--${name}=`));
    return a ? a.slice(name.length + 3) : null;
  };
  const corpusName = argVal("corpus") ?? "红楼梦";
  const domain = argVal("domain") ?? DOMAIN.EX; // 默认外部知识库；--domain=my 我的作品
  const chapterArgs = argVal("chapter");
  const changedArgs = argVal("changed"); // 改动章（原稿内容变更 → 删标注重标）；my 域专用
  const doAll = args.includes("--all");
  const pendingOnly = args.includes("--pending"); // 补建指令：只跑 pending.json 里未完成的章
  const fromN = argVal("from") ? Number(argVal("from")) : null; // --from=N: 从第 N 章开始
  const toN = argVal("to") ? Number(argVal("to")) : null;       // --to=M: 到第 M 章结束(与 --from 组合=续建范围)
  const chapters = doAll ? null : (chapterArgs ? chapterArgs.split(",").map(Number) : null);
  const changedChs = changedArgs ? changedArgs.split(",").map(Number).filter(Boolean) : [];
  const deletedArgs = argVal("deleted"); // 删除章（md 没了 → 归档标注 + 聚合剔章号）；my 域专用
  const deletedChs = deletedArgs ? deletedArgs.split(",").map(Number).filter(Boolean) : [];
  chatCfg = loadChatConfig(); // 惰性读配置（main 调用时——被 import 时不可读，全新目录无 config 会炸）
  baseUrl = (chatCfg.baseUrl ?? "https://api.deepseek.com/v1").replace(/\/+$/, "");
  const CORPUS_PATH = path.join(corpusDir, `${corpusName}-语料.txt`);
  // 按语料名查找专属清单，不存在则回退通用清单（LIST_PATH 模块级 let——readChapterList 模块级函数引用）
  const LIST_CANDIDATES = [
    path.join(corpusDir, `${corpusName}-章节清单.csv`),
    path.join(corpusDir, "章节清单.csv"),
  ];
  LIST_PATH = LIST_CANDIDATES.find((p) => fs.existsSync(p));
  // 项目根（域感知）：--domain 指定域；缺省自动探测两域（同名已禁止）
  const PROJECT_DIR = (() => {
    try {
      return projectRoot(corpusName, domain);
    } catch {
      // 未建库：创建项目目录（禁止同名检查在 createProject 内）
      return createProject(corpusName, domain);
    }
  })();

  // SKILL 按层切片：往返1（sentence）/ 往返2（shot-chapter）各取对应段落，省重复 token
  const skillA = loadSkillSlice("sentence");
  const skillB = loadSkillSlice("shot-chapter");
  const corpusLines = readLines(CORPUS_PATH);
  const list = readChapterList();
  if (!list.length) throw new Error(`章节清单为空: ${LIST_PATH ?? "未找到 <语料名>-章节清单.csv 或 章节清单.csv"}`);
  console.log(`[host] 语料 ${corpusName}，共 ${list.length} 章，清单: ${LIST_PATH}`);

  // 补建指令 --pending：从 pending.json 读未完成章号（先读,供 todo 计算）
  const pendingNums = (() => {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, "pending.json"), "utf-8"));
      return (p.pending ?? []).map((x) => x.chapter).filter(Boolean);
    } catch { return []; }
  })();

  // 消耗统计（LLM 调用次数 / token / 耗时）
  const COST = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, elapsedMs: 0 };
  const startedAt = new Date().toISOString();

  const todo = doAll
    ? list
    : list.filter((c) => {
        if (changedChs.length) return changedChs.includes(c.number); // --changed：改动章重标（优先）
        if (chapters) return chapters.includes(c.number);
        if (fromN) return c.number >= fromN && (!toN || c.number <= toN); // --from=N --to=M：续建范围
        if (pendingOnly) return pendingNums.includes(c.number); // --pending：只补未完成章
        return false;
      });
  // [task] 进度协议行（task/manager.mjs 统一解析；同时进日志留痕）
  const taskLine = (d) => console.log(`[task] ${JSON.stringify(d)}`);
  if (!todo.length && !deletedChs.length) {
    // 无待处理章：--pending 无缺章 = 补建已完成（正常结束，非失败）；
    // 其他模式（--chapter/--from 超范围）也按"无需处理"正常退出，避免红卡误导
    const reason = pendingOnly ? "pending 无未完成章（已全部补齐）" : `范围内无待处理章（${chapters ? `指定 ${chapters.join(",")}` : fromN ? `从${fromN}章起${toN ? `到${toN}章` : ""}` : "all"}）`;
    console.log(`\n✅ [host] 无需处理：${reason}`);
    taskLine({ stage: "done", done: 0, phase: `无需处理：${reason}` });
    process.exit(0);
  }
  if (!todo.length && deletedChs.length) {
    // 仅删除章（无重标任务）：归档标注 → 直接触发聚合剔除
    console.log(`\n[host] 仅删除章处理（${deletedChs.join(",")}）：归档标注 + 聚合剔除`);
  } else {
    // 本次任务待处理章数（server 端解析为进度 total；--all/--from/--chapter/--pending 通用）
    console.log(`[host] 本次任务 ${todo.length} 章待处理（${doAll ? "全量" : pendingOnly ? "补建 pending" : chapters ? `指定 ${chapters.join(",")}` : fromN ? `从${fromN}章起${toN ? `到${toN}章` : "到末尾"}` : "未知范围"}）`);
    taskLine({ stage: "sentence", total: todo.length, done: 0, phase: "准备" });
  }
  // 建库范围提示：全量/大批次开销大，推荐分批（每次 ≤30 章）
  if (doAll) console.log(`\n⚠ 全量建库（${todo.length} 章）——一次开销较大（LLM token），如非必要建议分批续建（每次 ≤30 章）\n`);
  else if (todo.length > 30) console.log(`\n⚠ 本次建库 ${todo.length} 章，超过推荐单批上限（30 章）——建议分批以控制开销\n`);

  const existing = walkProject(PROJECT_DIR);
  const chapterIssues = [];
  function extractIssues(out, ch) {
    return out.split("\n").filter((l) => l.includes("✗") || l.includes("❌")).map((l) => `第${ch}章: ${l.trim()}`);
  }

  /** 调 LLM 并解析（失败存 raw，返回 null）；skill 按层传入（往返1/往返2 各取切片） */
  async function callLlm(userMsg, ch, skill) {
    console.log("[host] 调用 LLM（streaming + thinking 禁用，max_tokens=65536）...");
    const t0 = Date.now();
    // 超时（2026-09-04 修复，原为 timeoutMs:null 永久挂起）：标注单次往返下限 15 分钟
    // （reasoning 模型长思考/慢速时段/超长章兜底）；config.timeoutMs 更大则跟随用户配置
    const llmTimeoutMs = Math.max(chatCfg.timeoutMs ?? 300000, 900000);
    const res = await chatStreamNoThinking([{ role: "system", content: skill }, { role: "user", content: userMsg }], { maxTokens: 65536, timeoutMs: llmTimeoutMs });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[host] LLM 返回 ${res.content.length} 字符（耗时 ${secs}s）`);
    // 消耗统计累计（token 来自流式末 chunk usage；未带 usage 时该项为 0）
    COST.calls++;
    COST.elapsedMs += Date.now() - t0;
    if (res.usage) {
      COST.promptTokens += res.usage.prompt_tokens ?? 0;
      COST.completionTokens += res.usage.completion_tokens ?? 0;
      COST.totalTokens += res.usage.total_tokens ?? 0;
    }
    try {
      return { payload: parsePayload(res.content), raw: res.content };
    } catch (err) {
      console.error("[host] 解析失败，原始输出已存盘供检查:", err.message);
      writeRawDump(rawDumpFile(corpusName, ch.number), res.content);
      return null;
    }
  }

  /* ---- pending.json（未完成章记录：失败章 → 下次任务提示/补跑） ---- */
  const PENDING_FILE = path.join(PROJECT_DIR, "pending.json");
  function readPending() {
    try { return JSON.parse(fs.readFileSync(PENDING_FILE, "utf-8")); } catch { return { updatedAt: null, pending: [] }; }
  }
  function recordPending(ch, reason) {
    const p = readPending();
    p.updatedAt = new Date().toISOString();
    const ex = p.pending.find((x) => x.chapter === ch.number);
    if (ex) { ex.reason = reason; ex.attempts = (ex.attempts ?? 0) + 1; ex.fixed = false; }
    else p.pending.push({ chapter: ch.number, reason, attempts: 1, fixed: false });
    fs.writeFileSync(PENDING_FILE, JSON.stringify(p, null, 2), "utf-8");
  }
  function clearPending(ch) {
    const p = readPending();
    const before = p.pending.length;
    p.pending = p.pending.filter((x) => x.chapter !== ch.number);
    if (p.pending.length !== before) { p.updatedAt = new Date().toISOString(); fs.writeFileSync(PENDING_FILE, JSON.stringify(p, null, 2), "utf-8"); }
  }
  // 本批启动时提示未完成章（上次失败遗留）
  {
    const pend = readPending();
    const todoNums = new Set(todo.map((c) => c.number));
    const stale = pend.pending.filter((x) => !todoNums.has(x.chapter)); // 本次未覆盖的遗留
    if (stale.length) {
      console.log(`\n⚠ 检测到 ${stale.length} 章上次未完成（pending.json）: ${stale.map((x) => `第${x.chapter}章`).join("、")}`);
      console.log(`  本次任务未覆盖这些章——可用补建指令补跑: --pending（只补缺章）或 --all（全量）\n`);
    }
  }

  /** 单章处理（往返1+2+派生+复检）；失败返回 {ok:false, issue} */
  async function runChapter(ch) {
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
    taskLine({ stage: "sentence", phase: `往返1:句子（第${ch.number}章）` });
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
    if (!r1) return { ok: false, issue: "往返1 解析失败" };
    const sentKey = Object.keys(r1.payload).find((k) => k.includes("句子标注") && k.endsWith(".json"));
    if (!sentKey) {
      console.error(`[往返1✗] 缺句子 JSON，实际键: ${Object.keys(r1.payload).join(", ")}`);
      return { ok: false, issue: "往返1 缺句子 JSON" };
    }
    let sentData = typeof r1.payload[sentKey] === "string" ? r1.payload[sentKey] : JSON.stringify(r1.payload[sentKey], null, 2);
    const gvA = checkJsonText(sentData);
    if (!gvA.ok) { console.error(`[往返1 gate✗] 句子语法非法: ${gvA.kind} @行${gvA.line}`); return { ok: false, issue: "往返1 句子语法非法" }; }
    const sentJson = JSON.parse(sentData);
    const gA = gateSentences(sentJson);
    if (!gA.ok) {
      console.error(`[硬闸门A✗] ${gA.issues.join("; ")} → 本章跳过（不执行往返2）`);
      return { ok: false, issue: `往返1 句子层校验失败: ${gA.issues.join("; ")}` };
    }
    // 文件名规范化：宿主决定标准路径（第XXXX章.json 4位零填充），不信任 LLM 输出的键
    const sentPath = `句子标注/json/第${String(ch.number).padStart(4, "0")}章.json`;
    fs.mkdirSync(path.dirname(path.join(PROJECT_DIR, sentPath)), { recursive: true });
    fs.writeFileSync(path.join(PROJECT_DIR, sentPath), sentData, "utf-8");
    console.log(`  [写] ${sentPath}（${sentData.length} 字符）→ 句子层冻结（唯一权威源）`);

    /* ===== 往返2：分镜 + 章节（硬闸门 B） ===== */
    console.log("\n---------- 往返2：分镜层 + 章节层 ----------");
    taskLine({ stage: "shots", phase: `往返2:分镜+章节（第${ch.number}章）` });
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
      "② 章节层：function（七种）/ summary（2026-09-04 起不再生成 mainlineProgress）",
      "注意：派生字段（sentenceRange/stats/suspense）由宿主脚本生成，不得输出。",
      "JSON 转义要求：所有字符串值内的换行必须转义为 \\\\n（不得出现未转义的真实换行符）。",
      "输出格式：一个 JSON 对象，键 = project 内相对路径（用 \"/\"），值 = 该文件完整内容。只输出这个 JSON。",
    ].join("\n");
    const r2 = await callLlm(userB, ch, skillB);
    if (!r2) return { ok: false, issue: "往返2 解析失败" };
    const shotKey = Object.keys(r2.payload).find((k) => k.includes("分镜标注") && k.endsWith(".json"));
    const chKey = Object.keys(r2.payload).find((k) => k.startsWith("章节/") && k.endsWith(".json"));
    if (!shotKey || !chKey) {
      console.error(`[往返2✗] 缺分镜/章节 JSON，实际键: ${Object.keys(r2.payload).join(", ")}`);
      return { ok: false, issue: "往返2 缺分镜/章节" };
    }
    let shotData = typeof r2.payload[shotKey] === "string" ? r2.payload[shotKey] : JSON.stringify(r2.payload[shotKey], null, 2);
    let chData = typeof r2.payload[chKey] === "string" ? r2.payload[chKey] : JSON.stringify(r2.payload[chKey], null, 2);
    const gvB1 = checkJsonText(shotData), gvB2 = checkJsonText(chData);
    if (!gvB1.ok || !gvB2.ok) {
      console.error(`[往返2 gate✗] 分镜/章节语法非法: ${gvB1.ok ? "" : gvB1.kind} / ${gvB2.ok ? "" : gvB2.kind}`);
      return { ok: false, issue: "往返2 分镜/章节语法非法" };
    }
    const shotJson = JSON.parse(shotData), chJson = JSON.parse(chData);
    const gB = [...gateShots(shotJson, sentJson).issues, ...gateChapter(chJson).issues];
    if (gB.length) {
      console.error(`[硬闸门B✗] ${gB.join("; ")} → 本章跳过（句子已落盘）`);
      // 留档原始输出供排查（funcs/结构为何不过闸）
      const r2Dump = rawDumpFile(corpusName, ch.number, "-round2");
      writeRawDump(r2Dump, r2.raw);
      if (fs.existsSync(r2Dump)) console.log(`  [留档] ${path.basename(r2Dump)}`);
      return { ok: false, issue: `往返2 校验失败: ${gB.join("; ")}` };
    }
    // 文件名规范化：宿主决定标准路径（第XXXX章.json 4位零填充），不信任 LLM 输出的键
    const shotPath = `分镜标注/json/第${String(ch.number).padStart(4, "0")}章.json`;
    const chPath = `章节/第${String(ch.number).padStart(4, "0")}章.json`;
    fs.mkdirSync(path.dirname(path.join(PROJECT_DIR, shotPath)), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(PROJECT_DIR, chPath)), { recursive: true });
    fs.writeFileSync(path.join(PROJECT_DIR, shotPath), shotData, "utf-8");
    fs.writeFileSync(path.join(PROJECT_DIR, chPath), chData, "utf-8");
    console.log(`  [写] ${shotPath} + ${chPath}`);

    // 派生字段（shotId/range/stats/suspense——脚本生成）
    const der = deriveChapter(PROJECT_DIR, ch.number);
    for (const d of der.derived) console.log(`  [派生] ${d} 已生成`);
    for (const n of der.note) console.log(`  [待修] ${n}`);

    // 整章复检（check-chapter，软记录不阻塞）
    try {
      const [rCmd, rArgs, rEnv] = runScriptArgs("novelread/check-chapter.mjs", [corpusName, String(ch.number)]); const out = execFileSync(rCmd, rArgs, { encoding: "utf-8", env: rEnv });
      console.log(out.trim());
      chapterIssues.push(...extractIssues(out, ch.number));
    } catch (e) {
      const msg = (e.stdout ?? "").toString();
      console.log(msg.trim() || `[检测✗] 第${ch.number}章检测异常: ${e.message}`);
      chapterIssues.push(`第${ch.number}章`);
    }
    existing.splice(0, existing.length, ...walkProject(PROJECT_DIR));
    // 成功落盘 → 删除本轮的 raw 解析失败留档（成功即留档使命结束，防 output/raw 堆积）
    const rawP = rawDumpFile(corpusName, ch.number);
    if (fs.existsSync(rawP)) { fs.unlinkSync(rawP); console.log(`  [清理] 删除过期留档 ${path.basename(rawP)}`); }
    console.log(`[host] 第${ch.number}章完成`);
    return { ok: true, issue: null };
  }

  /* ===== 主循环：失败自动重跑 1 次 → 仍失败自动 fix + pending 记录；失败率 >30% 熔断 ===== */
  const totalChapters = todo.length;
  let processedCh = 0, failedCh = 0, okCount = 0; // okCount: 本批成功章数（批末自动聚合依据）

  /* ---- 改动/删除章预处理（--changed/--deleted）：快照旧标注 → 删旧标注 ---- */
  const changedSet = new Set(changedChs);
  const deletedSet = new Set(deletedChs);
  let snapDir = null; // 快照目录（整批一个）
  if (changedSet.size || deletedSet.size) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    snapDir = path.join(PROJECT_DIR, "标注备份", ts);
    fs.mkdirSync(snapDir, { recursive: true });
    const all = [...new Set([...changedSet, ...deletedSet])];
    console.log(`\n[host] 变更章 ${all.join(",")} 处理前快照 → ${path.relative(PROJECT_DIR, snapDir)}`);
    // 保留最近 3 份快照（更早清理）
    const snapRoot = path.join(PROJECT_DIR, "标注备份");
    if (fs.existsSync(snapRoot)) {
      const snaps = fs.readdirSync(snapRoot).filter((d) => fs.statSync(path.join(snapRoot, d)).isDirectory()).sort();
      while (snaps.length > 3) fs.rmSync(path.join(snapRoot, snaps.shift()), { recursive: true, force: true });
    }
  }
  /** 备份某章标注到快照并删除当前标注（重标/删除前调用）；返回是否备份成功 */
  const backupAndRemove = (chNum) => {
    if (!snapDir) return false;
    const pad = String(chNum).padStart(4, "0");
    const pairs = [
      [`语料分章/第${pad}章_*.txt`, "语料分章"],
      [`句子标注/json/第${pad}章.json`, "句子标注/json"],
      [`分镜标注/json/第${pad}章.json`, "分镜标注/json"],
      [`章节/第${pad}章.json`, "章节"],
    ];
    let backed = false;
    for (const [glob, dir] of pairs) {
      const srcDir = path.join(PROJECT_DIR, dir);
      if (!fs.existsSync(srcDir)) continue;
      for (const f of fs.readdirSync(srcDir)) {
        if (glob.includes("*")) { if (!f.startsWith(`第${pad}章_`)) continue; }
        else if (f !== path.basename(glob)) continue;
        const from = path.join(srcDir, f);
        const to = path.join(snapDir, dir, f);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        try { fs.copyFileSync(from, to); backed = true; } catch { /* 复制失败忽略 */ }
        fs.unlinkSync(from); // 删旧标注
        console.log(`  [快照+删] ${dir}/${f}`);
      }
    }
    return backed;
  };
  /** 从快照恢复某章标注（重标失败回滚——B2） */
  const restoreFromSnapshot = (chNum) => {
    if (!snapDir) return;
    const pad = String(chNum).padStart(4, "0");
    const pairs = [
      ["语料分章", `第${pad}章_`],
      ["句子标注/json", `第${pad}章.json`],
      ["分镜标注/json", `第${pad}章.json`],
      ["章节", `第${pad}章.json`],
    ];
    for (const [dir, prefix] of pairs) {
      const srcDir = path.join(snapDir, dir);
      if (!fs.existsSync(srcDir)) continue;
      for (const f of fs.readdirSync(srcDir)) {
        if (!f.startsWith(prefix)) continue;
        const to = path.join(PROJECT_DIR, dir, f);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        try { fs.copyFileSync(path.join(srcDir, f), to); console.log(`  [恢复] ${dir}/${f}`); } catch { /* 恢复失败忽略 */ }
      }
    }
  };
  /** 删除章归档处理（A1）：标注已备份，聚合章号由批末 aggregates --deleted 剔除 */
  const retireDeleted = (chNum) => {
    backupAndRemove(chNum); // 归档到快照（保历史）
    // 从指纹移除（该章不再存在）
    if (domain === DOMAIN.MY) {
      const cur = readFingerprints(PROJECT_DIR);
      if (chNum in cur) { delete cur[chNum]; writeFingerprints(PROJECT_DIR, cur); console.log(`  [指纹] 第${chNum}章 已移除`); }
    }
    console.log(`  [删除] 第${chNum}章 标注已归档（聚合剔除由批末 aggregates 处理）`);
  };
  /** 本次任务写入指纹的章（B2：聚合失败时回滚——存旧值恢复，不误删已有指纹） */
  const fingerprintWritten = new Map(); // ch → 旧指纹（null=原本无指纹）
  const updateFingerprint = (ch) => {
    if (domain !== DOMAIN.MY) return; // 指纹仅 my 域
    const cur = readFingerprints(PROJECT_DIR);
    // 从当前 md 重算该章 hash（最新原稿 = 标注所依据的版本；标注成功后写入）
    try {
      const md = fs.readFileSync(path.join(mybookDir, corpusName, `第${String(ch.number).padStart(4, "0")}章.md`), "utf-8");
      if (!fingerprintWritten.has(ch.number)) fingerprintWritten.set(ch.number, cur[ch.number] ?? null); // 记录旧值
      cur[ch.number] = chapterHash(md);
      writeFingerprints(PROJECT_DIR, cur);
      console.log(`  [指纹] 第${ch.number}章 指纹已更新`);
    } catch { /* md 不存在（deleted 场景）→ 不更新 */ }
  };

  // 删除章先处理（无重标，仅归档 + 指纹移除）
  for (const d of deletedChs) retireDeleted(d);

  for (const ch of todo) {
    processedCh++;
    const fuse = failedCh / processedCh > 0.3; // 熔断：已处理章失败率 >30% → 停止自动重跑/fix
    if (changedSet.has(ch.number)) backupAndRemove(ch.number); // 改动章：快照 + 删旧标注
    let result = await runChapter(ch);
    if (!result.ok && !fuse) {
      console.log(`\n[host] ⚠ 第${ch.number}章失败（${result.issue.slice(0, 50)}），自动重跑第 2 次...`);
      result = await runChapter(ch);
    }
    if (!result.ok) {
      failedCh++;
      // 改动章重标失败 → 从快照恢复旧标注（B2：不留缺章，下次检测仍为改动 → 再重试）
      if (changedSet.has(ch.number)) restoreFromSnapshot(ch.number);
      // 自动 fix（分镜/章节文件已落盘才跑——文件缺失时 fix 无下手处）
      const pad = String(ch.number).padStart(4, "0");
      const hasShots = fs.existsSync(path.join(PROJECT_DIR, `分镜标注/json/第${pad}章.json`));
      const hasChap = fs.existsSync(path.join(PROJECT_DIR, `章节/第${pad}章.json`));
      if (hasShots && hasChap && !fuse) {
        console.log(`\n[host] 自动跑 fix 修复第${ch.number}章（字段级，含 LLM 补丁）...`);
        try {
          const [cmd, cmdArgs, cmdEnv] = runScriptArgs("novelread/fix.mjs", [corpusName, String(ch.number)]);
          const out = execFileSync(cmd, cmdArgs, { encoding: "utf-8", env: cmdEnv, timeout: 180000 });
          console.log(out.trim().slice(-800));
        } catch (e) {
          console.log((e.stdout ?? "").toString().slice(-400) || `[fix✗] ${e.message}`);
        }
      }
      recordPending(ch, result.issue);
      chapterIssues.push(`第${ch.number}章 ${result.issue}（${fuse ? "熔断,未重试" : "已重试1次" + (hasShots && hasChap ? "+fix" : "")}）`);
    } else {
      okCount++; // 成功章计数（批末自动聚合：至少 1 章成功才跑）
      clearPending(ch); // 成功 → 从 pending 移除
      updateFingerprint(ch); // 标注成功 → 指纹更新（含首次建库基线；失败不写 → 下次仍检测为改动）
      taskLine({ stage: "sentence", done: okCount, phase: `第${ch.number}章完成（${okCount}/${todo.length}）` });
    }
  }

  console.log("\n[host] 全部完成。产出文件：");
  for (const f of walkProject(PROJECT_DIR)) console.log("  " + f);
  taskLine({ stage: "aggregate", done: okCount, phase: "批末派生（聚合/索引）" });

  if (chapterIssues.length) {
    console.log(`\n⚠ 检测发现 ${chapterIssues.length} 项问题（不阻塞，建议处理后重跑对应章）：`);
    for (const i of chapterIssues) console.log("  - " + i);
  } else {
    console.log("\n✅ 章级检测全部通过（所有章 4 文件齐全 + 语法 + 契约）");
  }

  // 消耗汇总（时间 / token / 次数），写入 output/ 供分析
  const finishedAt = new Date().toISOString();
  const costReport = {
    corpus: corpusName,
    domain,
    chaptersRequested: todo.map((c) => c.number),
    startedAt,
    finishedAt,
    elapsedSec: Math.round(COST.elapsedMs / 1000),
    llmCalls: COST.calls,
    promptTokens: COST.promptTokens,
    completionTokens: COST.completionTokens,
    totalTokens: COST.totalTokens,
    model: chatCfg.model,
  };
  console.log(`\n[消耗] LLM ${COST.calls} 次 / 输入 ${COST.promptTokens} / 输出 ${COST.completionTokens} / 合计 ${COST.totalTokens} tokens / 耗时 ${(COST.elapsedMs / 1000).toFixed(1)}s`);
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    const costFile = path.join(outputDir, `标注消耗-${corpusName}.json`);
    fs.writeFileSync(costFile, JSON.stringify(costReport, null, 2), "utf-8");
    console.log(`[消耗] 已写入 ${costFile}`);
  } catch (err) {
    console.log(`[消耗] 写入报告失败: ${err.message}`);
  }

  // 整批完成后统一触发向量增量构建（embed 未就绪则跳过）
  console.log("\n[host] 触发向量增量构建...");
  const vresult = await buildVectors({ projects: [corpusName] });
  if (vresult?.ok) {
    console.log(`[host] 向量构建完成：${vresult.stats?.totalShots ?? 0} 分镜 / ${vresult.stats?.totalChapters ?? 0} 章`);
  } else {
    console.log(`[host] 向量构建跳过：${vresult?.reason ?? "未知原因"}（${vresult?.guidance ?? ""}）`);
  }

  /* ===== 批末自动补跑聚合（确定性重算 + 终检 + 索引） =====
   * 语义：本批有成功/改动/删除章才跑（全失败 → 聚合无变化，跳过）；
   * 聚合为纯确定性全量重算（无 LLM，2026-09-04 起不再生成章节表.json）：
   *   改动/删除章旧标注已在上面快照删除，重算只依据现存标注与清单，
   *   自然剔除已删章，无需传章号；
   * 聚合失败仅 warning（不拖垮 annotate）——重跑聚合即可恢复。 */
  if (okCount > 0 || changedSet.size || deletedSet.size) {
    console.log(`\n[host] 批末自动补跑聚合（本批成功 ${okCount} 章${changedSet.size ? `，改动 ${[...changedSet].join(",")}` : ""}${deletedSet.size ? `，删除 ${[...deletedSet].join(",")}` : ""}）...`);
    try {
      const [aggCmd, aggArgs, aggEnv] = runScriptArgs("novelread/aggregates.mjs", [corpusName]);
      const aggOut = execFileSync(aggCmd, aggArgs, { encoding: "utf-8", env: aggEnv, timeout: 600000, maxBuffer: 32 * 1024 * 1024 }); // 确定性聚合（无 LLM），10 分钟为兜底上限
      console.log(aggOut.trim().slice(-1500)); // 只回显尾部关键信息（完成/终检/索引），全文进任务日志
    } catch (e) {
      console.log((e.stdout ?? "").toString().slice(-600) || `[聚合✗] ${e.message}`);
      console.log("  [聚合] 本次聚合未完成（不阻塞）。可用补建指令后的下次任务自动续跑，或手动: node cli.mjs aggregate <书>");
      // B2：聚合失败 → 回滚本次写入的指纹（标注数据保留，但指纹回退 → 下次检测仍视为改动，聚合会重跑；
      // 恢复旧值而非删除——不误删该章原本就有的指纹，下次检测精确判定为 changed）
      if (domain === DOMAIN.MY && fingerprintWritten.size) {
        try {
          const cur = readFingerprints(PROJECT_DIR);
          let rolled = 0;
          for (const [chNum, oldHash] of fingerprintWritten) {
            if (oldHash === null) { if (chNum in cur) { delete cur[chNum]; rolled++; } }
            else if (cur[chNum] !== oldHash) { cur[chNum] = oldHash; rolled++; }
          }
          if (rolled) { writeFingerprints(PROJECT_DIR, cur); console.log(`  [指纹回滚] 聚合失败，恢复 ${rolled} 章旧指纹（下次检测仍视为改动）`); }
        } catch { /* 回滚失败忽略 */ }
      }
    }
  } else {
    console.log("\n[host] 本批无成功章，跳过自动聚合（失败章补跑成功后批末会自动聚合）");
  }

  // 任务终态判定：有失败章 → 退出码 1（server 端按退出码标记 failed，前端显示失败+重跑按钮；
  // 避免"补跑后仍缺章"却被显示为成功——缺章以红卡驻留提示，直到补齐）
  if (failedCh > 0) {
    console.log(`\n❌ 本批 ${failedCh} 章失败（已记录 pending.json）。任务标记为失败——可用补建指令重跑缺章，或等下次任务自动续跑。`);
    taskLine({ stage: "done", done: okCount, phase: `完成：${okCount} 成功 / ${failedCh} 失败`, error: `本批 ${failedCh} 章失败（已记录 pending.json，可用补建指令重跑）` });
    process.exitCode = 1;
  } else {
    console.log("\n✅ 本批全部成功。");
    taskLine({ stage: "done", done: okCount, phase: `完成：${okCount}/${todo.length} 章全部成功` });
  }
}

// 仅直接运行时执行 main
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(".mjs") && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[host] 失败:", err);
    process.exit(1);
  });
}
