/**
 * fix.mjs — 修错脚本：字段级定向修复（不跨层、单字段）
 *
 * 定位：错误孤立在单个文件的单个字段（枚举值/长度/单个值），修复不依赖其他层、不改映射。
 *   检测 → LLM 只输出"修正补丁"（JSON 路径定位 + 新值，不重生成文件）→ 脚本应用 → gate → 复检。
 *
 * 两种模式：
 *   <project> <章号>       章级：分镜 type/funcs、章节 function/state、句子 struct（少量）、
 *                              语法非法句子 JSON 重建（脚本，零 LLM）
 *   <project> --aggregates 聚合层：event.json 的 lifecycle.state/结束章/note、废弃字段清理；
 *                              卷纲/volume.json 的 targets.state/target/evidenceChapters/note、isMain 派生一致性、废弃字段清理
 *                              （temp 文件不参与改错检查）
 *
 * 阈值：同一类型问题 ≤ 阈值（默认 5 处）走 LLM 字段级补丁；超过 → 不做补丁，
 *       输出具体问题提示（如 struct 混入 type 值可按 B4 规则脚本修、funcs/type 需 LLM 判定或重出文件）。
 * 不适用（明确排除）：拼接≠原文（输入偏差不修）/ sentenceIds 覆盖 / S# 不连续等
 *   —— 覆盖/结构类归形态 2/3。
 *
 * 用法：
 *   node novelread/fix.mjs <project> <章号> [--limit=N] [--dry-run]
 *   node novelread/fix.mjs <project> --aggregates [--dry-run]
 *   --dry-run 只检测+生成问题清单，不调 LLM 不落盘
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { checkJsonText } from "./verify-json.mjs";
import { deriveChapter } from "./derive-chapter.mjs";
import { projectRoot, cliArgs, runScriptArgs } from "../shared/paths.mjs";
import { loadChatConfig } from "../shared/config.mjs";

let args, project, aggregatesMode, ch, dryRun, limit, projectDir, chStr; // 惰性初始化（被 import 时不可有副作用）

/** 解析 CLI 参数（延迟到 main 调用——被 sea-main import 时无参数，不能执行 projectRoot/exit） */
function parseArgs() {
  if (projectDir) return;
  args = cliArgs(); // SEA 分发兼容（过滤 "run <script>" 前缀）
  project = args.find((a) => !a.startsWith("--"));
  aggregatesMode = args.includes("--aggregates");
  ch = Number(args.find((a) => /^\d+$/.test(a)));
  dryRun = args.includes("--dry-run");
  limit = Number((args.find((a) => a.startsWith("--limit=")) ?? "--limit=5").split("=")[1]);
  if (!project || (!Number.isInteger(ch) && !aggregatesMode)) {
    console.error("用法: node novelread/fix.mjs <project> <章号> [--limit=N] [--dry-run] | <project> --aggregates [--dry-run]");
    process.exit(2);
  }
  projectDir = projectRoot(project); // 域感知：两域自动探测
  chStr = aggregatesMode ? "" : String(ch).padStart(4, "0");
  chatCfg = loadChatConfig(); // 惰性读配置（parseArgs 后）
  baseUrl = (chatCfg.baseUrl ?? "https://api.deepseek.com/v1").replace(/\/+$/, "");
}

/* ---------- 枚举（对齐 specs 契约） ---------- */
const SHOT_TYPES = ["信息", "对话", "心理", "动作", "事件", "环境"];
const SHOT_FUNCS = ["塑造人物", "引入世界观", "设置动机", "推进", "铺垫", "反转", "爆发", "转场", "收束分镜", "悬念"];
const CHAPTER_FUNCS = ["开端", "推进", "铺垫", "爆发", "转折", "收束章节", "过渡"];
const MAINLINE_STATES = ["主线启动", "推进", "受阻", "达成", "更换"];
const STRUCTS = ["短句", "句从"];

/* ---------- 形态 1 问题检测 ---------- */
const issues = []; // {file, loc, problem, current, context}

function readJson(rel) {
  const p = path.join(projectDir, rel);
  if (!fs.existsSync(p)) return null;
  if (path.basename(p).includes("temp")) return null; // temp 为增量中间产物，不参与改错检查
  const v = checkJsonText(fs.readFileSync(p, "utf-8"));
  if (!v.ok) return null; // 语法非法 → 走语法修复（句子）或需重出对应文件
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}
function push(rel, loc, problem, current, context) {
  issues.push({ file: rel, loc, problem, current, context: context ?? "" });
}

export async function main() {
  parseArgs(); // 惰性解析 CLI 参数
/* ---------- 聚合层字段级检测（--aggregates 模式：event.json / 卷纲.json 的枚举/类型） ---------- */
const aggIssues = [];
if (aggregatesMode) {
  const pushA = (file, loc, problem, current) => aggIssues.push({ file, loc, problem, current, context: "" });
  const TARGET_STATES = ["确立", "推进", "达成", "搁置", "失败"];
  const ev = readJson("大事件/event.json");
  if (ev) {
    (ev.lifecycle ?? []).forEach((lc, i) => {
      if (!["悬置", "已回收"].includes(lc.state)) pushA("大事件/event.json", `lifecycle[${i}].state`, `lifecycleState 非法「${lc.state}」`, lc.state);
      const end = lc["结束章"];
      if (end !== null && end !== undefined && typeof end !== "number") pushA("大事件/event.json", `lifecycle[${i}].结束章`, "结束章非 int/null", String(end));
      if (!(lc.note ?? "").trim()) pushA("大事件/event.json", `lifecycle[${i}].note`, "note 为空", "");
      // 语义自洽（对齐 check）：state=已回收 ⟺ 结束章≠null；结束章 ∈ 持续章（或 null）
      if (lc.state === "已回收" && end === null) pushA("大事件/event.json", `lifecycle[${i}].state`, "语义不自洽：state=已回收 但 结束章=null", lc.state);
      if (lc.state === "悬置" && end !== null && end !== undefined) pushA("大事件/event.json", `lifecycle[${i}].state`, "语义不自洽：state=悬置 但 结束章≠null", lc.state);
      if (end !== null && end !== undefined && typeof end === "number" && !(lc["持续章"] ?? []).includes(end)) pushA("大事件/event.json", `lifecycle[${i}].持续章`, "语义不自洽：结束章不在持续章内", String(end));
    });
    // 废弃字段：mainline/chapterIndex 不应存在
    if ("mainline" in ev) pushA("大事件/event.json", "mainline", "废弃字段 mainline 应删除（已并入卷纲 targets）", "存在");
    if ("chapterIndex" in ev) pushA("大事件/event.json", "chapterIndex", "废弃字段 chapterIndex 应删除（与章节表重复）", "存在");
  }
  const vol = readJson("卷纲/volume.json");
  if (vol) {
    (vol.targets ?? []).forEach((t, i) => {
      if (!TARGET_STATES.includes(t.state)) pushA("卷纲/volume.json", `targets[${i}].state`, `targetState 非法「${t.state}」（确立/推进/达成/搁置/失败）`, t.state);
      if (!(t.target ?? "").trim()) pushA("卷纲/volume.json", `targets[${i}].target`, "target 为空", "");
      if (!Array.isArray(t.evidenceChapters)) pushA("卷纲/volume.json", `targets[${i}].evidenceChapters`, "evidenceChapters 非数组", String(t.evidenceChapters));
      if (!(t.note ?? "").trim()) pushA("卷纲/volume.json", `targets[${i}].note`, "note 为空", "");
    });
    // 废弃字段：eventStructure/mainline 不应存在
    if ("eventStructure" in vol) pushA("卷纲/volume.json", "eventStructure", "废弃字段 eventStructure 应删除（事件跨章判断已归 event.json）", "存在");
    if ("mainline" in vol) pushA("卷纲/volume.json", "mainline", "废弃字段 mainline 应删除（已并入 targets）", "存在");
    // isMain 派生一致性：唯一且为命中章节最多者
    const targets = vol.targets ?? [];
    const mainT = targets.filter((t) => t.isMain === true);
    if (mainT.length !== 1) pushA("卷纲/volume.json", "targets.isMain", `isMain 应唯一（现 ${mainT.length} 个）`, String(mainT.length));
    else if (targets.length) {
      const maxLen = Math.max(...targets.map((t) => (t.evidenceChapters ?? []).length));
      if ((mainT[0].evidenceChapters ?? []).length !== maxLen) pushA("卷纲/volume.json", "targets.isMain", "isMain 非命中章节最多者（应由脚本派生，勿手改）", mainT[0].target);
    }
  }
}

// 分镜层
const shotJson = readJson(`分镜标注/json/第${chStr}章.json`);
if (shotJson) {
  (shotJson.shots ?? []).forEach((sh, i) => {
    const ctx = `分镜${sh.id}「${sh.label ?? ""}」句子: ${(sh.sentenceIds ?? []).slice(0, 2).join(",")}`;
    if (!SHOT_TYPES.includes(sh.type)) push(`分镜标注/json/第${chStr}章.json`, `shots[${i}].type`, `type 非法「${sh.type}」`, sh.type, ctx);
    const badF = (sh.funcs ?? []).filter((f) => !SHOT_FUNCS.includes(f));
    if (badF.length) push(`分镜标注/json/第${chStr}章.json`, `shots[${i}].funcs`, `funcs 含非法值 ${JSON.stringify(badF)}`, JSON.stringify(sh.funcs), ctx);
    if (!(sh.funcs ?? []).length) push(`分镜标注/json/第${chStr}章.json`, `shots[${i}].funcs`, "funcs 为空", "[]", ctx);
    if ((sh.funcs ?? []).length > 3) push(`分镜标注/json/第${chStr}章.json`, `shots[${i}].funcs`, `funcs ${sh.funcs.length} 个 > 3`, JSON.stringify(sh.funcs), ctx);
    if (!sh.label || !sh.label.trim()) push(`分镜标注/json/第${chStr}章.json`, `shots[${i}].label`, "label 为空", sh.label ?? "", ctx);
  });
}

// 章节层
const chJson = readJson(`章节/第${chStr}章.json`);
if (chJson) {
  if (!CHAPTER_FUNCS.includes(chJson.function)) push(`章节/第${chStr}章.json`, "function", `function 非法「${chJson.function}」`, chJson.function, "");
  if (!chJson.summary || !chJson.summary.trim()) push(`章节/第${chStr}章.json`, "summary", "summary 为空", "", "");
  (chJson.mainlineProgress ?? []).forEach((m, i) => {
    if (!MAINLINE_STATES.includes(m.state)) push(`章节/第${chStr}章.json`, `mainlineProgress[${i}].state`, `state 非法「${m.state}」`, m.state, m.entity ?? "");
  });
}

// 事件层（按章事件已删除——大事件信息由聚合层 event.json 主文件承载，无章级事件文件）

// 句子层（仅少量 struct 错走字段级；大量错单独统计并提示）
const sentJson = readJson(`句子标注/json/第${chStr}章.json`);
// 语法修复候选：句子 JSON 语法非法 → 提取内容重建外壳（保留内容，零 LLM）
const rebuilt = sentJson ? null : rebuildBrokenSentences(projectDir, chStr);
const badStructAll = sentJson ? (sentJson.sentences ?? []).filter((s) => !STRUCTS.includes(s.struct)) : [];

/* ---- B4 规则修复（零 LLM）：struct 非法 且 text 含成对引号（“ ”）→ 对话句恒为短句 ---- */
const B4_FIXED = [];   // 命中规则，脚本直接改 struct=短句
const B4_UNFIXED = []; // 非法但不含成对引号，不做 LLM 兜底，仅提示
if (sentJson && badStructAll.length) {
  const hasPairQuote = (t) => /[\u201C\u201D]/.test(t ?? "") && (t ?? "").includes("\u201C") && (t ?? "").includes("\u201D");
  for (const s of badStructAll) {
    if (hasPairQuote(s.text)) B4_FIXED.push(s);
    else B4_UNFIXED.push(s);
  }
  if (B4_FIXED.length && !dryRun) {
    for (const s of B4_FIXED) s.struct = "短句"; // B4：对话句（引号话语整体）恒为短句型句子
    fs.writeFileSync(path.join(projectDir, `句子标注/json/第${chStr}章.json`), JSON.stringify(sentJson, null, 2) + "\n", "utf-8");
  }
}
if (sentJson) {
  for (const s of badStructAll.slice(0, limit)) {
    if (B4_FIXED.includes(s)) continue; // 已被 B4 规则修复为短句，不进 LLM 补丁清单
    const i = sentJson.sentences.indexOf(s);
    push(`句子标注/json/第${chStr}章.json`, `sentences[${i}].struct`, `struct 非法「${s.struct}」`, s.struct, (s.text ?? "").slice(0, 30));
  }
}

/* ---------- 阈值分组：字段级补丁 vs 超阈值（输出具体问题提示） ---------- */
const typeCount = {};
for (const i of issues) {
  const key = i.problem.includes("funcs") ? "funcs" : i.problem.includes("type") ? "type" : i.problem.includes("struct") ? "struct" : "other";
  typeCount[key] = (typeCount[key] ?? 0) + 1;
}
const tooMany = Object.entries(typeCount).filter(([, n]) => n > limit).map(([k, n]) => `${k}×${n}`);
const fieldIssues = issues.filter((i) => !(i.problem.includes("struct") && typeCount.struct > limit));

if (!aggregatesMode) {
  console.log(`\n========== 修错脚本（字段级修复）：${project} 第${chStr}章 ==========`);
  console.log(`检测到字段级问题 ${issues.length} 项`);
  // B4 规则修复结果
  if (B4_FIXED.length) console.log(`  ✅ B4 规则修复：${B4_FIXED.length} 句 struct 非法且含成对引号（对话句）→ 已改「短句」（零 LLM）`);
  if (B4_UNFIXED.length) console.log(`  ⚠ 未处理：${B4_UNFIXED.length} 句 struct 非法但不含成对引号（非对话句），不做 LLM 兜底，需人工判定或重出句子文件`);
  // struct 超限单独提示（不入 issues 的补丁清单，但报告具体问题）
  if (badStructAll.length > limit) {
    console.log(`  ⚠ 类别「struct」${badStructAll.length} 处超阈值（${limit}），不做字段级补丁。含成对引号的对话句已由 B4 规则修正为短句；其余需人工判定或重出句子文件`);
  }
  for (const [k, n] of Object.entries(typeCount)) {
    if (n > limit) {
      const detail = {
        struct: `句子 struct 填了分镜 type 值（如「对话」）——含引语的对话句可按规则（B4：对话句恒为短句）脚本修正，其余需 LLM 重判或重出句子文件`,
        funcs: `分镜 funcs 混入了 type 值或自造词——需 LLM 逐镜判定合法 funcs`,
        type: `分镜 type 混入了 funcs 值——需 LLM 逐镜判定合法 type`,
        other: `其他字段问题——见上方明细`,
      }[k];
      console.log(`  ⚠ 类别「${k}」${n} 处超阈值（${limit}），不做字段级补丁。${detail}`);
    }
  }
  if (!issues.length && !rebuilt && !B4_FIXED.length) { console.log("✅ 无字段级问题"); process.exit(0); }
  for (const i of issues) console.log(`  ✗ ${i.file} @ ${i.loc}: ${i.problem}${i.context ? `（${i.context}）` : ""}`);
  if (dryRun) { console.log("\n（--dry-run，不调 LLM 不落盘）"); process.exit(0); }
}

/* ---------- LLM 客户端（thinking 禁用，与 host 一致） ---------- */
let chatCfg = null, baseUrl = ""; // 惰性（被 import 时不可读 config；parseArgs 后赋值）
async function chat(messages, maxTokens = 4096) {
  const body = { model: chatCfg.model, messages, temperature: 0.3, stream: true, thinking: { type: "disabled" }, max_tokens: maxTokens };
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${chatCfg.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
  return out;
}

/* ---------- 补丁应用（JSON 路径 setter：shots[3].funcs / summary / events[0].crossChapter[1]） ---------- */
function applyPatch(root, loc, value) {
  const parts = loc.split(".");
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const m = parts[i].match(/^(\w+)\[(\d+)\]$/);
    cur = m ? cur[m[1]][Number(m[2])] : cur[parts[i]];
  }
  const last = parts[parts.length - 1];
  const m = last.match(/^(\w+)\[(\d+)\]$/);
  if (value === "__DELETE__") {
    if (m) delete cur[m[1]][Number(m[2])]; else delete cur[last];
    return;
  }
  if (m) cur[m[1]][Number(m[2])] = value; else cur[last] = value;
}

/* ---------- 语法修复（fix-chapter 的功能之一）：语法非法 → 提取内容重建外壳，零 LLM ---------- */

/** 状态机提取 JSON 文本中指定字符串键的所有值（容错：语法非法也能抓，含转义处理） */
function extractKeyPairs(raw, key) {
  const re = new RegExp(`"${key}"\\s*:\\s*"`, "g");
  const out = [];
  let m;
  while ((m = re.exec(raw)) !== null) {
    let j = m.index + m[0].length;
    let s = "";
    while (j < raw.length) {
      const ch = raw[j];
      if (ch === "\\") { s += raw[j] + (raw[j + 1] ?? ""); j += 2; continue; }
      if (ch === '"') break;
      s += ch;
      j++;
    }
    out.push(s);
  }
  return out;
}

/**
 * 语法非法句子 JSON → 重建合法 JSON：
 * 容错提取 {text, struct} 键值对（按出现顺序配对）→ 重组 dsh/sentence-card/v1。
 * 保留 LLM 输出的内容原样（实施层是唯一可信记录，不因与语料偏差而重跑）。
 * @returns {object|null} 重建的句子 JSON（可提取时）；否则 null
 */
function rebuildBrokenSentences(projectDir, chStr) {
  const rel = `句子标注/json/第${chStr}章.json`;
  const p = path.join(projectDir, rel);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, "utf-8");
  if (checkJsonText(raw).ok) return null; // 语法合法，不需要重建
  const texts = extractKeyPairs(raw, "text");
  if (!texts.length) return null; // 提取不到 → 需人工/重跑处理
  const structs = extractKeyPairs(raw, "struct");
  return {
    schema: "dsh/sentence-card/v1",
    chapter: { number: Number(chStr), title: "", range: `第${chStr}章` },
    source: rel,
    sentences: texts.map((text, i) => ({
      id: `S${i + 1}`, seq: i + 1,
      struct: structs[i] && STRUCTS.includes(structs[i]) ? structs[i] : "短句",
      text, shotId: null, note: "",
    })),
  };
}

/* ---------- 主流程 ---------- */

/** 收尾：派生重算 + 章级复检 + 项目终检 */
async function finalizeChapter() {
  console.log("\n[fix] 重算派生字段（derive-chapter）...");
  const der = deriveChapter(projectDir, ch);
  for (const d of der.derived) console.log(`  [派生] ${d} 已重算`);
  for (const n of der.note) console.log(`  [待修] ${n}`);

  console.log("\n[fix] 复检（check-chapter）...");
  let chapterOk = false;
  try {
    const [rCmd, rArgs, rEnv] = runScriptArgs("novelread/check-chapter.mjs", [project, String(ch)]); const out = execFileSync(rCmd, rArgs, { encoding: "utf-8", env: rEnv });
    console.log(out.trim());
    chapterOk = out.includes("✅ 第") && !out.includes("✗");
  } catch (e) {
    console.log((e.stdout ?? "").toString().trim());
  }

  console.log("\n[fix] 终检（aggregates --finalize-only，刷新 project-meta.json）...");
  try {
    const [rCmd, rArgs, rEnv] = runScriptArgs("novelread/aggregates.mjs", [project, "--finalize-only"]); const out = execFileSync(rCmd, rArgs, { encoding: "utf-8", env: rEnv });
    console.log(out.trim());
  } catch (e) {
    console.log((e.stdout ?? "").toString().trim());
    console.log("（项目级语法门未过——若非本次修复章所致，属存量问题，见上报告）");
  }
  console.log(`\n✅ 修复动作已留痕：project-meta.json 的 verifiedAt/contractIssues 已刷新`);
  console.log(chapterOk ? "✅ 章级复检通过" : "⚠ 章级复检仍有问题——请查看上方 ✗ 项定位具体原因（如句子切分、分镜归属、枚举混淆），对症处理");
  process.exit(chapterOk ? 0 : 1);
}

  // 聚合层模式（--aggregates）：event.json / 卷纲.json 字段级修复
  if (aggregatesMode) {
    console.log(`\n========== 修错脚本（聚合层字段级）：${project} ==========`);
    console.log(`检测到聚合层字段级问题 ${aggIssues.length} 项`);
    for (const i of aggIssues) console.log(`  ✗ ${i.file} @ ${i.loc}: ${i.problem}`);
    if (!aggIssues.length) { console.log("✅ 无聚合层字段级问题"); process.exit(0); }
    if (dryRun) { console.log("\n（--dry-run，不调 LLM 不落盘）"); process.exit(0); }

    const problemText = aggIssues.map((i, n) =>
      `${n + 1}. ${i.file} @ ${i.loc}: ${i.problem}\n   当前值: ${String(i.current).slice(0, 200)}`
    ).join("\n");
    const userMsg = [
      "## 任务：聚合层字段级修复",
      "以下问题均为聚合层（event.json / 卷纲.json）的单字段枚举/类型错误，最小改动修正，不重生成文件。",
      "",
      "## 合法枚举",
      `lifecycleState: 悬置/已回收`,
      `targetState: 确立/推进/达成/搁置/失败`,
      "结束章：int 或 null（null = 未了结，不得填字符串）。",
      "废弃字段（mainline/chapterIndex/eventStructure）：`新值` 填字符串 `__DELETE__` 表示删除该字段。",
      "",
      "## 问题清单",
      problemText,
      "",
      "## 输出格式",
      '{"修正":[{"文件":"<相对路径>","定位":"<JSON路径>","新值":<修正后的值>}]}',
      "只输出这个 JSON 对象，不要任何其他内容。",
    ].join("\n");

    console.log("\n[fix] 调用 LLM 定向修复（聚合层字段）...");
    const raw = await chat([
      { role: "system", content: "你是网文标注修复器：只做最小改动的字段级修正，严格遵守枚举与类型约束。" },
      { role: "user", content: userMsg },
    ]);
    console.log(`[fix] LLM 返回 ${raw.length} 字符`);
    let payload;
    try {
      let cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
      payload = JSON.parse(cleaned);
    } catch (e) {
      console.error(`[fix] 补丁解析失败: ${e.message}\n原始: ${raw.slice(0, 300)}`);
      process.exit(1);
    }
    const patches = payload.修正 ?? [];
    if (!patches.length) { console.error("[fix] LLM 未返回修正项"); process.exit(1); }
    const byFile = {};
    for (const p of patches) {
      if (!p?.文件 || !p?.定位) { console.warn(`  ⚠ 跳过无效补丁: ${JSON.stringify(p)}`); continue; }
      (byFile[p.文件] ??= []).push(p);
    }
    for (const [rel, list] of Object.entries(byFile)) {
      const p = path.join(projectDir, rel);
      if (!fs.existsSync(p)) { console.error(`  [✗] ${rel} 不存在`); continue; }
      const obj = JSON.parse(fs.readFileSync(p, "utf-8"));
      for (const pt of list) {
        try { applyPatch(obj, pt.定位, pt.新值); console.log(`  [补丁] ${rel} @ ${pt.定位} → ${JSON.stringify(pt.新值).slice(0, 80)}`); }
        catch { console.error(`  [✗] ${rel} @ ${pt.定位} 定位失败`); }
      }
      const text = JSON.stringify(obj, null, 2) + "\n";
      const v = checkJsonText(text);
      if (!v.ok) { console.error(`  [gate✗] ${rel} 修正后语法非法: ${v.kind} → 未落盘`); continue; }
      fs.writeFileSync(p, text, "utf-8");
      console.log(`  [写] ${rel}`);
    }
    // 终检（聚合层修复后刷新头文档；无章级派生）
    console.log("\n[fix] 终检（aggregates --finalize-only，刷新 project-meta.json）...");
    try {
      const [rCmd, rArgs, rEnv] = runScriptArgs("novelread/aggregates.mjs", [project, "--finalize-only"]); const out = execFileSync(rCmd, rArgs, { encoding: "utf-8", env: rEnv });
      console.log(out.trim());
    } catch (e) {
      console.log((e.stdout ?? "").toString().trim());
    }
    console.log(`\n✅ 聚合层字段级修复完成（project-meta.json 已刷新）`);
    process.exit(0);
  }

  // 语法修复分支：句子 JSON 语法非法 → 脚本重建外壳（保留提取的内容，零 LLM，不走重跑）
  if (rebuilt) {
    console.log(`\n========== 语法修复：${project} 第${chStr}章 句子 JSON（原文件语法非法） ==========`);
    const text = JSON.stringify(rebuilt, null, 2) + "\n";
    if (!checkJsonText(text).ok) {
      console.error(`[gate✗] 重建结果语法非法（异常）`); process.exit(1);
    }
    fs.writeFileSync(path.join(projectDir, `句子标注/json/第${chStr}章.json`), text, "utf-8");
    console.log(`✅ 脚本重建完成：${rebuilt.sentences.length} 句（保留提取的 text/struct；若与语料有偏差属输入偏差，不触发重跑）`);
    await finalizeChapter();
    return;
  }

  // B4 规则修复分支：只做了规则修复（无字段级补丁）→ 走收尾验证，不调 LLM
  if (B4_FIXED.length && !issues.length) {
    console.log("\n[fix] B4 规则修复完成（对话句→短句），走收尾验证（derive/复检/终检）...");
    await finalizeChapter();
    return;
  }

  const problemText = issues.map((i, n) =>
    `${n + 1}. ${i.file} @ ${i.loc}: ${i.problem}\n   当前值: ${String(i.current).slice(0, 200)}\n   上下文: ${i.context.slice(0, 120)}`
  ).join("\n");

  const userMsg = [
    "## 任务：字段级标注修复",
    "以下问题均为单字段枚举/长度错误，最小改动修正，不重生成文件、不修改未列出的任何内容。",
    "",
    "## 合法枚举",
    `type: ${SHOT_TYPES.join("/")}`,
    `funcs: ${SHOT_FUNCS.join("/")}`,
    `function: ${CHAPTER_FUNCS.join("/")}`,
    `mainlineState: ${MAINLINE_STATES.join("/")}`,
    `struct: ${STRUCTS.join("/")}`,
    "label ≤10 字；summary ≤400 字（超长需压缩，保留关键情节）。",
    "",
    "## 问题清单",
    problemText,
    "",
    "## 输出格式",
    '{"修正":[{"文件":"<相对路径>","定位":"<JSON路径>","新值":<修正后的值>}]}',
    "只输出这个 JSON 对象，不要任何其他内容。",
  ].join("\n");

  console.log("\n[fix] 调用 LLM 定向修复（只改问题字段）...");
  const raw = await chat([
    { role: "system", content: "你是网文标注修复器：只做最小改动的字段级修正，严格遵守枚举与长度约束。" },
    { role: "user", content: userMsg },
  ]);
  console.log(`[fix] LLM 返回 ${raw.length} 字符`);

  let payload;
  try {
    let cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    payload = JSON.parse(cleaned);
  } catch (e) {
    console.error(`[fix] 补丁解析失败: ${e.message}\n原始: ${raw.slice(0, 300)}`);
    process.exit(1);
  }
  const patches = payload.修正 ?? [];
  if (!patches.length) { console.error("[fix] LLM 未返回修正项"); process.exit(1); }

  // 应用补丁（按文件分组，读→改→gate→写）
  const byFile = {};
  for (const p of patches) {
    if (!p?.文件 || !p?.定位) { console.warn(`  ⚠ 跳过无效补丁: ${JSON.stringify(p)}`); continue; }
    (byFile[p.文件] ??= []).push(p);
  }
  let applied = 0, rejected = 0;
  for (const [rel, list] of Object.entries(byFile)) {
    const p = path.join(projectDir, rel);
    // 读前语法门（对齐 aggregates.applyInstructions）：非法 → 跳过该文件，不崩溃
    if (!fs.existsSync(p)) { rejected += list.length; console.error(`  [✗] ${rel} 不存在 → 跳过该文件`); continue; }
    const rawText = fs.readFileSync(p, "utf-8");
    const preV = checkJsonText(rawText);
    if (!preV.ok) { rejected += list.length; console.error(`  [✗] ${rel} 语法非法（${preV.kind}）→ 跳过该文件`); continue; }
    const obj = JSON.parse(rawText);
    for (const pt of list) {
      try { applyPatch(obj, pt.定位, pt.新值); applied++; console.log(`  [补丁] ${rel} @ ${pt.定位} → ${JSON.stringify(pt.新值).slice(0, 80)}`); }
      catch { rejected++; console.error(`  [✗] ${rel} @ ${pt.定位} 定位失败`); }
    }
    const text = JSON.stringify(obj, null, 2) + "\n";
    const v = checkJsonText(text);
    if (!v.ok) { rejected++; console.error(`  [gate✗] ${rel} 修正后语法非法: ${v.kind} → 未落盘`); continue; }
    fs.writeFileSync(p, text, "utf-8");
    console.log(`  [写] ${rel}`);
  }

  // T3 + 复检 + 终检（共用收尾）
  await finalizeChapter();
}

// 直接运行（源码 CLI / SEA 分发调用 export main）——被 import 时仅当直接运行才执行
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(".mjs") && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error("[fix] 失败:", err.message); process.exit(1); });
}
