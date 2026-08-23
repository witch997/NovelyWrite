/**
 * aggregates.mjs — 聚合层编排器（阶段二，合并原 recompute-aggregates + semantic-aggregates + finalize）
 *
 * 执行顺序（事实层全部落盘后一次运行）：
 *   ① 确定性重算（deterministicPart）：章节表.json / 清单 / 缺章报告（输入=全部章节标注规定字段）
 *   ② 语义调用①（semanticEvent）：全部 summary → 大事件/event.json（lifecycle[] 事件跨章判断，含 note；无 mainline/chapterIndex）
 *   ③ 语义调用②（semanticVolume）：仅全部 summary → 卷纲/volume.json（goal/targets[] 目标跨章判断/diagnostics）
 *      ——正交：卷纲只吃 summary，不读 event.json；targets.isMain 由脚本派生（命中章节最多者，唯一）
 *   ④ 终检（finalizePart）：全项目语法门（严格，跳过 temp 文件）+ 契约门（check-chapter --all 宽松计数）+ 统计
 *      → 写 store/<project>/project-meta.json（可机读时间戳 + 头文档）
 *
 * 增量模式（默认，有 aggregatedChapters 快照时自动启用）：
 *   新增章 = 全部已标注章 − derivedFrom.aggregatedChapters
 *   → 新增章单独聚合 → 大事件/eventtemp-<ts>.json、卷纲/volumetemp-<ts>.json（持久保留待查）
 *   → 合并判定（merge/insert 指令，宁拆勿合）→ 应用 → isMain 重派生 → aggregatedChapters 更新
 *   --full 强制全量重跑（逃生门：增量异常/想重判粒度时）
 *
 * 子命令：
 *   node novelread/aggregates.mjs <project>                    # 完整阶段二（有快照→增量，否则全量）
 *   node novelread/aggregates.mjs <project> --full             # 强制全量（首次/逃生门）
 *   node novelread/aggregates.mjs <project> --deterministic-only  # 只①（无 LLM）
 *   node novelread/aggregates.mjs <project> --finalize-only       # 只⑤（无 LLM；fix 用）
 *   node novelread/aggregates.mjs <project> --emit-summaries      # 只输出全部 summary
 *   node novelread/aggregates.mjs <project> --skip-llm            # ① + ⑤（跳过②③语义 LLM）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { checkJsonText } from "./verify-json.mjs";
import { buildLexicalIndex, buildVectors } from "../retriever/build-derived.mjs";
import { ensureDerived } from "../retriever/ensure-derived.mjs";
import { loadSkillSlice } from "../shared/skill-slice.mjs";
import { CODE_ROOT, DATA_ROOT, configPath, corpusDir, storeDir, projectRoot, cliArgs, runScriptArgs } from "../shared/paths.mjs";
import { loadChatConfig } from "../shared/config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let args, project, flags, projectDir, corpusList, listPath, stateDir; // 惰性初始化（被 import 时不可有副作用）

/** 解析 CLI 参数（延迟到 main 调用——被 sea-main import 时无参数，不能执行 projectRoot） */
function parseArgs() {
  if (projectDir) return;
  args = cliArgs(); // SEA 分发兼容（过滤 "run <script>" 前缀）
  project = args.find((a) => !a.startsWith("--")) ?? "大王饶命";
  flags = args.filter((a) => a.startsWith("--"));
  projectDir = projectRoot(project); // 域感知：两域自动探测
  corpusList = path.join(corpusDir, `${project}-章节清单.csv`);
  listPath = fs.existsSync(corpusList) ? corpusList : path.join(corpusDir, "章节清单.csv");
  stateDir = path.join(CODE_ROOT, "novelread", "state"); // LLM 输出留档目录（格式漂移诊断）
  chatCfg = loadChatConfig(); // 惰性读配置（parseArgs 后）
  baseUrl = (chatCfg.baseUrl ?? "https://api.deepseek.com/v1").replace(/\/+$/, "");
}

/* ================= ① 确定性重算（原 recompute-aggregates） ================= */

function loadChapters() {
  const dir = path.join(projectDir, "章节");
  const out = [], bad = [];
  if (!fs.existsSync(dir)) return { out, bad };
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json") && x !== "章节表.json")) {
    const text = fs.readFileSync(path.join(dir, f), "utf-8");
    const v = checkJsonText(text);
    if (!v.ok) { bad.push({ file: f, kind: v.kind }); continue; }
    const d = JSON.parse(text);
    out.push({
      number: d.chapter?.number, title: d.chapter?.title ?? d.title, function: d.function,
      summary: d.summary, mainlineProgress: d.mainlineProgress ?? [],
      stats: d.stats ?? null, suspense: d.suspense ?? [],
    });
  }
  return { out: out.sort((a, b) => a.number - b.number), bad };
}

function loadList() {
  if (!fs.existsSync(listPath)) return [];
  const rows = [];
  const lines = fs.readFileSync(listPath, "utf-8").replace(/\r\n/g, "\n").split("\n");
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    const m5 = l.match(/^(\d+),(.+),(\d+),(\d+),(\d+)$/);
    if (m5) { rows.push({ number: Number(m5[1]), title: m5[2].trim(), start: Number(m5[3]), end: Number(m5[4]) }); continue; }
    const m3 = l.match(/^(\d+),(.+?),(\d+)-(\d+)$/);
    if (m3) rows.push({ number: Number(m3[1]), title: m3[2], start: Number(m3[3]), end: Number(m3[4]) });
  }
  return rows;
}

/** ① 章节表重写 + 清单恢复 + 缺章报告（确定性） */
export function deterministicPart(projectDir, project) {
  const { out: chs, bad } = loadChapters();
  console.log(`\n========== 聚合层① 确定性重算：${project} ==========`);
  console.log(`已标注章: ${chs.length}（语法非法跳过 ${bad.length}${bad.length ? ": " + bad.map((b) => `${b.file}[${b.kind}]`).join(" / ") : ""}）`);
  if (!chs.length) { console.error("无可用章节标注，中止"); process.exit(1); }

  const table = {
    schema: "dsh/chapter-table/v1",
    volume: { name: project, chapterRange: [chs[0].number, chs[chs.length - 1].number] },
    chapters: chs.map((c) => ({
      number: c.number, title: c.title, function: c.function,
      // summary 不落副本——唯一合法源在章节标注（statsRef join）；消费方按需读取
      mainlineProgress: c.mainlineProgress.map((m) => ({ entity: m.entity, state: m.state })),
      statsRef: `分析结果/${project}project/章节/第${String(c.number).padStart(4, "0")}章.json`,
    })),
    mainlineProgress: chs.flatMap((c) => c.mainlineProgress.map((m) => ({ chapter: c.number, entity: m.entity, state: m.state }))),
    stats: (() => {
      let shotSum = 0, sentSum = 0, wordSum = 0;
      for (const c of chs) { shotSum += c.stats?.shotCount ?? 0; sentSum += c.stats?.sentenceCount ?? 0; wordSum += c.stats?.wordCount ?? 0; }
      return { chapterCount: chs.length, totalSentences: sentSum, totalShots: shotSum, totalWords: wordSum };
    })(),
    derivedFrom: { source: `分析结果/${project}project/章节`, sourceVersion: new Date().toISOString() },
    source: `分析结果/${project}project/章节`,
  };
  fs.writeFileSync(path.join(projectDir, "章节", "章节表.json"), JSON.stringify(table, null, 2) + "\n", "utf-8");
  console.log(`章节表.json 已重写：chapters=${table.chapters.length}，stats=${JSON.stringify(table.stats)}`);

  // 清单恢复
  const list = loadList();
  if (list.length) {
    const head = "章号,标题,语料起始行,语料结束行,字符数";
    const rows = list.map((r) => `${r.number},${r.title},${r.start},${r.end},${(r.end - r.start + 1) * 50}`);
    fs.mkdirSync(path.join(projectDir, "清单"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "清单", "章节清单.csv"), [head, ...rows].join("\n") + "\n", "utf-8");
    console.log(`清单/章节清单.csv 已恢复：${list.length} 行`);
  } else console.warn(`  ⚠ corpus 清单不存在或为空: ${listPath}`);

  // 缺章报告
  const have = new Set(chs.map((c) => c.number));
  const missing = list.map((r) => r.number).filter((n) => !have.has(n));
  if (missing.length) console.log(`  ⚠ 缺章 ${missing.length} 个: ${missing.join(",")}`);
  else console.log(`  ✓ 无缺章`);
  return { chapters: chs, list, missing };
}

/** 输出全部 summary（语义判定输入，范围写死） */
export function emitSummaries(projectDir) {
  const { out: chs } = loadChapters();
  console.log(`\n---------- 全部 summary（${chs.length} 章，供语义判定） ----------`);
  for (const c of chs) console.log(`第${String(c.number).padStart(4, "0")}章 ${c.title}（${c.function}）：${c.summary}`);
  return chs;
}

/* ================= LLM 客户端（thinking 禁用） ================= */

let chatCfg = null, baseUrl = ""; // 惰性（被 import 时不可读 config——全新目录无 config.json 会炸；parseArgs 后赋值）

async function chatStreamNoThinking(messages, opts = {}) {
  const body = {
    model: opts.model ?? chatCfg.model, messages,
    temperature: opts.temperature ?? chatCfg.temperature ?? 0.8,
    stream: true, thinking: { type: "disabled" },
  };
  if (opts.maxTokens !== null) body.max_tokens = opts.maxTokens ?? chatCfg.maxTokens ?? 65536;
  let lastError = null;
  const maxRetries = chatCfg.maxRetries ?? 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    let timer = null;
    if (opts.timeoutMs !== null) timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? chatCfg.timeoutMs ?? 300000);
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${chatCfg.apiKey}` },
        body: JSON.stringify(body), signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "", fullContent = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const data = t.slice(5).trim();
          if (data === "[DONE]") continue;
          try { fullContent += JSON.parse(data).choices?.[0]?.delta?.content ?? ""; } catch { /* skip */ }
        }
      }
      if (!fullContent.trim()) throw new Error("LLM 流式返回空内容");
      return fullContent;
    } catch (err) {
      lastError = err;
      if ((err.name === "AbortError" || /429|5\d\d/.test(err.message)) && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
        continue;
      }
      throw err;
    } finally { clearTimeout(timer); }
  }
  throw lastError;
}

function repairBareNewlines(text) {
  let out = "", inStr = false, esc = false;
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
function parsePayload(raw) {
  let cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  let obj = null;
  try { obj = JSON.parse(cleaned); } catch {
    try { obj = JSON.parse(repairBareNewlines(cleaned)); } catch {
      const s = cleaned.indexOf("{"), e = cleaned.lastIndexOf("}");
      if (s >= 0 && e > s) {
        const slice = cleaned.slice(s, e + 1);
        try { obj = JSON.parse(slice); } catch { try { obj = JSON.parse(repairBareNewlines(slice)); } catch { /* 继续 */ } }
      }
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error(`LLM 输出非 JSON 对象。前 200 字符：\n${raw.slice(0, 200)}`);
  return obj;
}

function writeJson(rel, obj) {
  const text = JSON.stringify(obj, null, 2) + "\n";
  const v = checkJsonText(text);
  if (!v.ok) { console.error(`  [校验✗] ${rel}: ${v.kind} → 未落盘`); return false; }
  const p = path.join(projectDir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, "utf-8");
  console.log(`  [写] ${rel} (${text.length} 字符)`);
  return true;
}
const now = () => new Date().toISOString();

/* ================= ② 语义调用① event.json ================= */

/** 事件跨章判断（全量或 temp）。opts.outRel 传 temp 路径时产出 temp 文件（带 tempFor） */
async function semanticEvent(summaries, summariesText, opts = {}) {
  const outRel = opts.outRel ?? "大事件/event.json";
  const isTemp = outRel.includes("temp");
  console.log(`\n========== 聚合层② 语义调用① ${isTemp ? "temp（新增章）" : "event.json"}（${summaries.length} 章 summary） ==========`);
  taskLine({ stage: "aggregate", phase: "聚合层② 语义:大事件" });
  const skill = loadSkillSlice("event");
  // temp 模式（增量）：prompt 明确「只喂新增章」，降低 temp 语义失真（开始章/state 仅代表新增章视角）
  const userMsg = [
    "## 聚合层语义判定·调用①：生成大事件主文件",
    isTemp
      ? `输入 = **本次新增章（${summaries.map((c) => c.number).join(",")}）** 的 summary（仅这些章；用于增量合并。注意：你只看到这些章，条目的 开始章/state/结束章 仅代表新增章视角，可能失真）。`
      : "输入 = 本项目全部已标注章的 summary（唯一语义依据，不得读取其他文件）。",
    "", "### summary", summariesText, "",
    "请按《语料分析-SKILL》【聚合层】【大事件层 dsh/event-card/v1】契约：",
    "- lifecycle[]：跨章生命周期状态机（同 entity 合并持续章；新 entity 开始章=首次出现；结束章 int|null；state∈{悬置,已回收}）",
    "- **每项 lifecycle 必须带 note**：一句叙述性说明（事件性质/关键节点/成因，≤60 字，客观陈述）",
    "- lifecycle 条数不限：按语料实际识别出多少具名事件就列多少条，不设上限",
    "- **只输出 lifecycle[]，不输出 mainline[]、不输出 chapterIndex**（这两者已废弃）",
    "- 只输出一个文件：键 = `大事件/event.json`，值 = 完整 JSON 内容。只输出这个 JSON 对象。",
  ].join("\n");
  const raw = await chatStreamNoThinking([{ role: "system", content: skill }, { role: "user", content: userMsg }], { maxTokens: 65536, timeoutMs: null });
  console.log(`[聚合] 调用①返回 ${raw.length} 字符`);
  const payload = parsePayload(raw);
  const key = Object.keys(payload).find((k) => k.includes("event.json") && !k.includes("event/"));
  let ev;
  if (key) {
    ev = typeof payload[key] === "string" ? JSON.parse(payload[key]) : payload[key];
  } else if (Array.isArray(payload.lifecycle) && (typeof payload.schema === "string" || payload.lifecycle.length > 0)) {
    // 兜底：LLM 省略键包装，直接输出 event-card 对象（schema/lifecycle 齐全即采用）
    console.log("[聚合] 调用①未带键包装，直接采用 event-card 对象（兜底）");
    ev = payload;
  } else {
    // 留档原始输出供诊断（LLM 格式漂移：键不对/输出过短/非 JSON 包装）
    try {
      const rawP = path.join(stateDir, `raw-聚合-${project}-event.txt`);
      fs.mkdirSync(path.dirname(rawP), { recursive: true });
      fs.writeFileSync(rawP, raw, "utf-8");
      throw new Error(`调用①输出缺少 大事件/event.json（${raw.length} 字符，原始输出已存 ${rawP}）`);
    } catch (e) {
      throw e instanceof Error && e.message.startsWith("调用①") ? e : new Error("调用①输出缺少 大事件/event.json（留档失败）");
    }
  }
  // 废弃字段兜底：mainline/chapterIndex 一律不落盘（正交方案下不存在）
  delete ev.mainline;
  delete ev.chapterIndex;
  // 语义自洽兜底：持续章为空 → 补 [开始章]（单章事件）；结束章=null 且 state=已回收 → 结束章=开始章；结束章不在持续章 → 追加（结束章必为持续章末）
  for (const lc of ev.lifecycle ?? []) {
    if (!Array.isArray(lc["持续章"]) || !lc["持续章"].length) {
      if (typeof lc["开始章"] === "number") lc["持续章"] = [lc["开始章"]];
      else lc["持续章"] = [];
    }
    if (lc.state === "已回收" && lc["结束章"] === null && typeof lc["开始章"] === "number") lc["结束章"] = lc["开始章"];
    if (typeof lc["结束章"] === "number" && !(lc["持续章"] ?? []).includes(lc["结束章"])) {
      lc["持续章"] = [...(lc["持续章"] ?? []), lc["结束章"]].sort((a, b) => a - b);
    }
  }
  ev.volume = { name: project, chapterRange: [summaries[0].number, summaries[summaries.length - 1].number] };
  ev.derivedFrom = { source: `分析结果/${project}project/章节`, sourceVersion: now() };
  if (isTemp) ev.tempFor = summaries.map((c) => c.number);
  else ev.derivedFrom.aggregatedChapters = summaries.map((c) => c.number);
  ev.schema = "dsh/event-card/v1";
  if (!writeJson(outRel, ev)) throw new Error(`${outRel} 落盘失败`);
  return ev;
}

/* ================= ③ 语义调用② volume.json ================= */

/** 目标跨章判断（全量或 temp）。opts.outRel 传 temp 路径时产出 temp 文件（带 tempFor） */
async function semanticVolume(summaries, summariesText, opts = {}) {
  const outRel = opts.outRel ?? "卷纲/volume.json";
  const isTemp = outRel.includes("temp");
  console.log(`\n========== 聚合层③ 语义调用② ${isTemp ? "temp（新增章）" : "volume.json"}（仅 summary；targets.isMain 由脚本派生） ==========`);
  taskLine({ stage: "aggregate", phase: "聚合层③ 语义:卷纲" });
  const skill = loadSkillSlice("volume");
  // temp 模式（增量）：prompt 明确「只喂新增章」，降低 temp 语义失真（state 仅代表新增章视角）
  const userMsg = [
    "## 聚合层语义判定·调用②：生成卷纲（目标跨章判断）",
    isTemp
      ? `输入 = **本次新增章（${summaries.map((c) => c.number).join(",")}）** 的 summary（仅这些章；用于增量合并。注意：你只看到这些章，state/evidenceChapters 仅代表新增章视角，可能失真）。`
      : "输入 = 本项目全部已标注章的 summary（唯一语义依据，不得读取其他文件——与 event.json 彻底正交）。",
    "", "### summary", summariesText, "",
    "请按《语料分析-SKILL》【聚合层】【单卷层 dsh/volume-card/v1】契约：",
    "- goal：单卷总目标（一段话，客观陈述）",
    "- targets[]：卷级目标的跨章判断（3-6 条，只列卷级意图；单章内小目标不列）",
    "  - 每项 {target, state, evidenceChapters[], note}：target=目标名（卷级意图，**不得引用任何事件名**）；state∈{确立,推进,达成,搁置,失败}；evidenceChapters=推进该目标的章号数组（从 summary 判定）；note=叙述性说明（可提及事件作佐证，但结构化字段不引用事件）",
    "  - **不要输出 isMain 字段**（宿主脚本按 evidenceChapters.length 最大者派生，唯一）",
    "- diagnostics：风险/异常判定 [{level, issue}]",
    "- **只输出 goal/targets/diagnostics，不输出 eventStructure[]、不输出 mainline**（已废弃）",
    "- 只输出一个文件：键 = `卷纲/volume.json`，值 = 完整 JSON 内容。只输出这个 JSON 对象。",
  ].join("\n");
  const raw = await chatStreamNoThinking([{ role: "system", content: skill }, { role: "user", content: userMsg }], { maxTokens: 65536, timeoutMs: null });
  console.log(`[聚合] 调用②返回 ${raw.length} 字符`);
  const payload = parsePayload(raw);
  const key = Object.keys(payload).find((k) => k.includes("卷纲") && k.endsWith(".json"));
  let vol;
  if (key) {
    vol = typeof payload[key] === "string" ? JSON.parse(payload[key]) : payload[key];
  } else if (typeof payload.goal === "string" && Array.isArray(payload.targets)) {
    // 兜底：LLM 省略键包装，直接输出 volume-card 对象（goal/targets 齐全即采用）
    console.log("[聚合] 调用②未带键包装，直接采用 volume-card 对象（兜底）");
    vol = payload;
  } else {
    try {
      const rawP = path.join(stateDir, `raw-聚合-${project}-volume.txt`);
      fs.mkdirSync(path.dirname(rawP), { recursive: true });
      fs.writeFileSync(rawP, raw, "utf-8");
      throw new Error(`调用②输出缺少 卷纲/volume.json（${raw.length} 字符，原始输出已存 ${rawP}）`);
    } catch (e) {
      throw e instanceof Error && e.message.startsWith("调用②") ? e : new Error("调用②输出缺少 卷纲/volume.json（留档失败）");
    }
  }
  // 废弃字段兜底：eventStructure/mainline 一律不落盘（正交方案下不存在）
  delete vol.eventStructure;
  delete vol.mainline;
  vol.volume = { name: project, chapterRange: [summaries[0].number, summaries[summaries.length - 1].number] };
  vol.derivedFrom = { source: `分析结果/${project}project/章节`, sourceVersion: now() };
  if (isTemp) vol.tempFor = summaries.map((c) => c.number);
  else vol.derivedFrom.aggregatedChapters = summaries.map((c) => c.number);
  vol.schema = "dsh/volume-card/v1";

  deriveIsMain(vol);

  if (!writeJson(outRel, vol)) throw new Error(`${outRel} 落盘失败`);
  return vol;
}

/** 脚本派生 isMain：按 evidenceChapters.length 降序排序 targets，命中章节最多者为唯一主目标（幂等，全量/temp/增量共用） */
function deriveIsMain(vol) {
  const targets = vol.targets ?? [];
  for (const t of targets) delete t.isMain;
  targets.sort((a, b) => (b.evidenceChapters?.length ?? 0) - (a.evidenceChapters?.length ?? 0));
  if (targets.length) targets[0].isMain = true;
  vol.targets = targets;
  console.log(`  [脚本] targets 已排序并派生 isMain（${targets.length} 条，主目标=${targets[0]?.target ?? "无"}）`);
}

/* ================= ④ 增量更新（temp 聚合 + 合并判定 + 应用） ================= */

/** 读取已聚合章号（derivedFrom.aggregatedChapters），无快照返回 null（首次 → 全量） */
function readAggregatedChapters() {
  const p = path.join(projectDir, "大事件", "event.json");
  if (!fs.existsSync(p)) return null;
  const v = checkJsonText(fs.readFileSync(p, "utf-8"));
  if (!v.ok) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8")).derivedFrom?.aggregatedChapters ?? null;
}

/* ---------- 失败重入：incremental-state.json（增量事务标记） ---------- */
const INCR_STATE = "incremental-state.json";

function incrStatePath() { return path.join(projectDir, INCR_STATE); }

/** 读增量状态；无/损坏返回 null */
function readIncrState() {
  const p = incrStatePath();
  if (!fs.existsSync(p)) return null;
  const v = checkJsonText(fs.readFileSync(p, "utf-8"));
  if (!v.ok) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

/** 写增量状态（batch=本批新增章号，tempTs=本批 temp 文件名时间戳） */
function writeIncrState(batch, tempTs) {
  fs.writeFileSync(incrStatePath(), JSON.stringify({ schema: "dsh/incremental-state/v1", batch, tempTs, phase: "started", startedAt: now() }, null, 2) + "\n", "utf-8");
}

/** 清增量状态（成功完成后调用） */
function clearIncrState() {
  const p = incrStatePath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

/** 读 temp 文件（已存在且语法合法 → 返回对象；否则 null） */
function readTempIfReady(rel) {
  const p = path.join(projectDir, rel);
  if (!fs.existsSync(p)) return null;
  const v = checkJsonText(fs.readFileSync(p, "utf-8"));
  if (!v.ok) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

/** 时间戳（本地时间）：YYYYMMDDTHHmmss */
function tsStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 合并判定：输入 = 旧正式文件 + temp 文件 → LLM 逐条输出 merge/insert 指令（宁拆勿合，不确定一律 insert） */
async function mergeJudgement(kind, oldObj, tempObj, newChapters) {
  const isEvent = kind === "event";
  const fileLabel = isEvent ? "大事件/event.json" : "卷纲/volume.json";
  const itemLabel = isEvent ? "lifecycle" : "targets";
  const oldItems = isEvent ? oldObj.lifecycle ?? [] : oldObj.targets ?? [];
  const tempItems = isEvent ? tempObj.lifecycle ?? [] : tempObj.targets ?? [];
  console.log(`\n========== 聚合层④ 合并判定 ${kind}（旧 ${oldItems.length} 条 vs temp ${tempItems.length} 条） ==========`);
  const skill = loadSkillSlice("incremental");
  // 旧文件只喂精炼视图：索引 + 名称 + 章号集合（不喂 note 全文，省 token）
  const oldView = oldItems.map((it, i) => ({
    索引: i,
    名称: it.entity ?? it.target,
    章号: isEvent ? it["持续章"] : it.evidenceChapters,
    state: it.state,
    ...(isEvent && it["结束章"] !== null && it["结束章"] !== undefined ? { 结束章: it["结束章"] } : {}),
  }));
  const tempView = tempItems.map((it, i) => ({
    索引: i,
    名称: it.entity ?? it.target,
    章号: isEvent ? it["持续章"] : it.evidenceChapters,
    state: it.state,
  }));
  const userMsg = [
    `## 聚合层增量合并判定（${isEvent ? "事件" : "目标"}）`,
    `新增章：${newChapters.join(",")}。请把 temp 的每条 ${itemLabel} 判定为 merge 或 insert：`,
    "",
    "### 旧文件条目（索引 + 名称 + 章号 + state，已聚合不可重写）：",
    JSON.stringify(oldView, null, 2), "",
    "### temp 条目（只喂新增章的视角，开始章/state/结束章失真，只有章号可信）：",
    JSON.stringify(tempView, null, 2), "",
    "### 判定规则（优先级：章号客观重叠 > 名称语义相近；拿不准一律 insert）",
    `- 与旧文件某条为同一实体（章号重叠 或 名称语义同一）→ merge：{"action":"merge","文件":"${fileLabel}","条目索引":<旧数组索引>,"并入章号":[<新增章号>], "状态覆盖":{...}}`,
    `  - merge 的 "状态覆盖" 可选：仅当该事件在新增章中结束才带（state 只能 悬置→已回收；结束章 null→int）；否则省略`,
    `- 旧文件没有对应实体 → insert：{"action":"insert","文件":"${fileLabel}","条目":{<完整 ${itemLabel} 对象>}}`,
    `  - insert 的条目须含全部必填字段（${isEvent ? "entity/开始章/持续章/结束章/state/note" : "target/state/evidenceChapters/note"}）`,
    "- 只输出一个 JSON 数组（指令列表），不要任何其他内容。",
  ].join("\n");
  const raw = await chatStreamNoThinking([{ role: "system", content: skill }, { role: "user", content: userMsg }], { maxTokens: 65536, timeoutMs: null });
  console.log(`[增量] 合并判定 ${kind} 返回 ${raw.length} 字符`);
  let instructions = [];
  try {
    let cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
    const parsed = JSON.parse(cleaned);
    instructions = Array.isArray(parsed) ? parsed : (parsed.修正 ?? parsed.instructions ?? []);
  } catch (e) {
    // 解析失败 → throw（进入失败重入路径，状态文件保留，temp 幂等复用）
    throw new Error(`合并判定 ${kind} 输出非 JSON 指令: ${e.message}\n原始: ${raw.slice(0, 200)}`);
  }
  if (!Array.isArray(instructions)) instructions = [];
  console.log(`  [增量] ${kind} 合并指令 ${instructions.length} 条`);
  return instructions;
}

/** 应用合并指令：merge 并章号+状态覆盖 / insert 追加（entity 名校验，不匹配拒绝） */
function applyInstructions(instructions) {
  let applied = 0;
  for (const inst of instructions) {
    const rel = inst?.文件;
    const p = path.join(projectDir, rel);
    if (!rel || !fs.existsSync(p)) { console.warn(`  [✗] 指令跳过（文件不存在）: ${JSON.stringify(inst).slice(0, 100)}`); continue; }
    const v = checkJsonText(fs.readFileSync(p, "utf-8"));
    if (!v.ok) { console.warn(`  [✗] 指令跳过（语法非法）: ${rel}`); continue; }
    const obj = JSON.parse(fs.readFileSync(p, "utf-8"));
    const isEvent = rel.includes("event.json");
    const arr = isEvent ? obj.lifecycle : obj.targets;
    if (!Array.isArray(arr)) { console.warn(`  [✗] 指令跳过（无条目数组）: ${rel}`); continue; }

    if (inst.action === "merge") {
      const idx = inst["条目索引"];
      const item = arr[idx];
      if (!item) { console.warn(`  [✗] merge 跳过（索引 ${idx} 越界）: ${rel}`); continue; }
      const nameField = isEvent ? "entity" : "target";
      if (inst.entity && item[nameField] !== inst.entity) { console.warn(`  [✗] merge 拒绝（entity 不匹配: 指令「${inst.entity}」≠ 现有「${item[nameField]}」@${idx}）`); continue; }
      const chField = isEvent ? "持续章" : "evidenceChapters";
      const merged = new Set([...(item[chField] ?? []), ...(inst["并入章号"] ?? [])]);
      item[chField] = [...merged].sort((a, b) => a - b);
      // 状态覆盖：前向单调校验（state 只能 悬置→已回收；结束章 null→int）
      const cov = inst["状态覆盖"];
      if (cov) {
        if (cov.state && isEvent && item.state === "悬置" && cov.state === "已回收") item.state = cov.state;
        else if (cov.state && isEvent) console.warn(`  [✗] merge 状态覆盖拒绝（非前向: ${item.state}→${cov.state}）@${idx}`);
        if (cov["结束章"] !== undefined && isEvent) {
          const cur = item["结束章"] ?? null;
          if (cur === null && typeof cov["结束章"] === "number") item["结束章"] = cov["结束章"];
          else console.warn(`  [✗] merge 结束章覆盖拒绝（非前向: ${cur}→${cov["结束章"]}）@${idx}`);
        }
      }
      console.log(`  [merge] ${rel} @${idx} ${item[nameField]} ← 并入章号 ${JSON.stringify(inst["并入章号"])}`);
    } else if (inst.action === "insert") {
      const item = inst["条目"];
      if (!item || typeof item !== "object") { console.warn(`  [✗] insert 跳过（无条目对象）: ${JSON.stringify(inst).slice(0, 100)}`); continue; }
      arr.push(item);
      console.log(`  [insert] ${rel} + ${item.entity ?? item.target}`);
    } else {
      console.warn(`  [✗] 指令跳过（未知 action: ${inst.action}）`);
      continue;
    }
    const text = JSON.stringify(obj, null, 2) + "\n";
    const gv = checkJsonText(text);
    if (!gv.ok) { console.error(`  [gate✗] ${rel} 应用后语法非法 → 未落盘`); continue; }
    fs.writeFileSync(p, text, "utf-8");
    applied++;
  }
  console.log(`  [增量] 已应用 ${applied} 条指令`);
  return applied;
}

/** 增量收尾：重派生 isMain + 更新 aggregatedChapters（旧 ∪ 新增章） */
function finalizeIncremental(newChapters) {
  const volP = path.join(projectDir, "卷纲", "volume.json");
  if (fs.existsSync(volP)) {
    const v = checkJsonText(fs.readFileSync(volP, "utf-8"));
    if (v.ok) {
      const vol = JSON.parse(fs.readFileSync(volP, "utf-8"));
      deriveIsMain(vol);
      fs.writeFileSync(volP, JSON.stringify(vol, null, 2) + "\n", "utf-8");
    }
  }
  for (const rel of ["大事件/event.json", "卷纲/volume.json"]) {
    const p = path.join(projectDir, rel);
    if (!fs.existsSync(p)) continue;
    const v = checkJsonText(fs.readFileSync(p, "utf-8"));
    if (!v.ok) continue;
    const obj = JSON.parse(fs.readFileSync(p, "utf-8"));
    const old = obj.derivedFrom?.aggregatedChapters ?? [];
    obj.derivedFrom = {
      source: `分析结果/${project}project/章节`,
      sourceVersion: now(),
      aggregatedChapters: [...new Set([...old, ...newChapters])].sort((a, b) => a - b),
    };
    fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf-8");
    console.log(`  [增量] ${rel} aggregatedChapters 更新（${newChapters.length} 章新增）`);
  }
}

/* ================= ⑤ 终检 + 头文档（原 finalize） ================= */

/** ④ 终检：全项目语法门 + 契约计数 + 统计 + project-meta.json */
export function finalizePart(projectDir, project) {
  console.log(`\n========== 聚合层④ 终检 + 头文档：${project} ==========`);
  taskLine({ stage: "aggregate", phase: "聚合层④ 终检+索引" });
  // 语法门（严格，跳过 temp 文件与增量状态文件——中间产物不参与正式文件校验）
  const jsonFiles = (() => {
    const out = [];
    const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".json") && !e.name.includes("temp") && e.name !== INCR_STATE) out.push(p); } };
    walk(projectDir);
    return out.sort();
  })();
  const badFiles = [];
  for (const f of jsonFiles) {
    const v = checkJsonText(fs.readFileSync(f, "utf-8"));
    if (!v.ok) badFiles.push({ file: f.replace(projectDir + path.sep, "").replaceAll("\\", "/"), kind: v.kind, line: v.line, col: v.col });
  }
  const syntaxPass = badFiles.length === 0;
  console.log(`JSON 文件: ${jsonFiles.length} 个 | 语法 ${syntaxPass ? "✅ 全过" : `❌ ${badFiles.length} 个非法`}`);
  for (const b of badFiles) console.log(`   - ${b.file} [${b.kind} @行${b.line}:列${b.col}]`);

  // 契约门（宽松：check-chapter --all 计数）
  let contractIssues = 0, contractReport = [];
  try {
    const [rCmd, rArgs, rEnv] = runScriptArgs("novelread/check-chapter.mjs", [project, "--all"]); const out = execFileSync(rCmd, rArgs, { encoding: "utf-8", env: rEnv });
    const badLines = out.split("\n").filter((l) => l.includes("✗") || l.includes("❌"));
    contractIssues = badLines.length;
    contractReport = badLines.map((l) => l.trim()).slice(0, 20);
    console.log(`契约问题: ${contractIssues} 项（宽松门，不阻塞）`);
  } catch (e) {
    const out = (e.stdout ?? "").toString();
    const badLines = out.split("\n").filter((l) => l.includes("✗") || l.includes("❌"));
    contractIssues = badLines.length;
    contractReport = badLines.map((l) => l.trim()).slice(0, 20);
    console.log(`契约问题: ${contractIssues} 项（宽松门，不阻塞）`);
  }

  // 统计（只读章节标注）
  const { out: chs } = loadChapters();
  let sentences = 0, shots = 0, words = 0;
  for (const c of chs) { sentences += c.stats?.sentenceCount ?? 0; shots += c.stats?.shotCount ?? 0; words += c.stats?.wordCount ?? 0; }
  const list = loadList();
  const have = new Set(chs.map((c) => c.number));
  const missingChapters = list.map((r) => r.number).filter((n) => !have.has(n));
  const chRange = chs.length ? [chs[0].number, chs[chs.length - 1].number] : [0, 0];
  console.log(`标注进度: ${chs.length}/${list.length} 章 | 缺 ${missingChapters.length} 章 | 范围 [${chRange}]`);
  console.log(`统计: ${sentences} 句 / ${shots} 镜 / ${words} 字`);

  // 头文档
  const meta = {
    schema: "dsh/project-meta/v1",
    project,
    corpus: path.relative(DATA_ROOT, corpusList).replaceAll("\\", "/"),
    chapterList: path.relative(DATA_ROOT, listPath).replaceAll("\\", "/"),
    volume: { name: project, chapterRange: chRange },
    counts: {
      chaptersAnnotated: chs.length, chaptersTotal: list.length, missingChapters,
      sentences, shots, chapterAnnotations: chs.length,
      events: 0, // 按章事件已删除（大事件信息由 event.json 主文件承载）
      jsonFiles: jsonFiles.length,
    },
    verify: { syntaxPass, badFiles, contractIssues, contractReport, verifiedAt: now() },
    updatedAt: now(),
    generatedBy: "novelread/aggregates.mjs (finalizePart)",
  };
  fs.writeFileSync(path.join(projectDir, "project-meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf-8");
  console.log(`\n✅ 头文档已写入: ${projectDir}/project-meta.json（verifiedAt=${meta.verify.verifiedAt}）`);
  return { syntaxPass, contractIssues };
}

/* ================= main ================= */

export async function main() {
  parseArgs(); // 惰性解析 CLI 参数（SEA 分发时 main 无参，参数来自 cliArgs 过滤后的 process.argv）
  if (!fs.existsSync(projectDir)) { console.error(`project 不存在: ${projectDir}`); process.exit(2); }
  // [task] 进度协议行（task/manager.mjs 统一解析；同时进日志留痕）
  const taskLine = (d) => console.log(`[task] ${JSON.stringify(d)}`);
  taskLine({ stage: "aggregate", phase: "聚合层① 确定性重算" });

  if (flags.includes("--emit-summaries")) { emitSummaries(projectDir); process.exit(0); }
  if (flags.includes("--deterministic-only")) { deterministicPart(projectDir, project); process.exit(0); }
  if (flags.includes("--finalize-only")) {
    const { syntaxPass } = finalizePart(projectDir, project);
    process.exit(syntaxPass ? 0 : 1);
  }

  // 完整阶段二
  const { out: summaries } = loadChapters();
  if (!summaries.length) { console.error("无可用章节标注（至少 1 章）"); process.exit(1); }
  deterministicPart(projectDir, project);

  if (flags.includes("--skip-llm")) {
    console.log("\n（--skip-llm：跳过语义调用①②，event.json/volume.json 保持现状）");
  } else if (!flags.includes("--full") && readAggregatedChapters() !== null) {
    /* ============ 增量模式（默认）：只处理新增章，存量条目零扰动 ============ */
    const aggSet = new Set(readAggregatedChapters());
    const newChs = summaries.filter((c) => !aggSet.has(c.number));
    if (!newChs.length) {
      console.log("\n[增量] 无新增章，跳过语义调用（event.json/volume.json 保持现状）");
      clearIncrState(); // 清理可能残留的失败状态（已全部聚合，无需重入）
    } else {
      console.log(`\n[增量] 新增章 ${newChs.length} 个: ${newChs.map((c) => c.number).join(",")}`);
      // 失败重入：同批次（上次失败）→ 复用 tempTs（temp 幂等覆盖不堆积）；新批次 → 新时间戳
      const prev = readIncrState();
      const batch = newChs.map((c) => c.number);
      const sameBatch = prev && JSON.stringify(prev.batch) === JSON.stringify(batch);
      const ts = sameBatch ? prev.tempTs : tsStamp();
      if (sameBatch) console.log(`  [重入] 检测到上次失败批次（tempTs=${ts}），幂等复用 temp 时间戳`);
      else writeIncrState(batch, ts);
      const newText = newChs.map((c) => `第${String(c.number).padStart(4, "0")}章 ${c.title}（${c.function}）：${c.summary}`).join("\n\n");

      // ① 新增章单独聚合 → temp 文件（持久保存，留待检查）；已存在且合法 → 幂等复用（省 2 次 LLM）
      const tempEvRel = `大事件/eventtemp-${ts}.json`;
      const tempVolRel = `卷纲/volumetemp-${ts}.json`;
      let tempEv = readTempIfReady(tempEvRel);
      let tempVol = readTempIfReady(tempVolRel);
      if (!tempEv) { tempEv = await semanticEvent(newChs, newText, { outRel: tempEvRel }); }
      else console.log(`  [重入] 复用已落盘 ${tempEvRel}（跳过 temp 聚合 LLM）`);
      if (!tempVol) { tempVol = await semanticVolume(newChs, newText, { outRel: tempVolRel }); }
      else console.log(`  [重入] 复用已落盘 ${tempVolRel}（跳过 temp 聚合 LLM）`);

      // ② 合并判定（旧正式文件 vs temp）→ merge/insert 指令
      const oldEv = JSON.parse(fs.readFileSync(path.join(projectDir, "大事件", "event.json"), "utf-8"));
      const oldVol = JSON.parse(fs.readFileSync(path.join(projectDir, "卷纲", "volume.json"), "utf-8"));
      const evIns = await mergeJudgement("event", oldEv, tempEv, newChs.map((c) => c.number));
      const volIns = await mergeJudgement("volume", oldVol, tempVol, newChs.map((c) => c.number));

      // ③ 应用指令
      applyInstructions([...evIns, ...volIns]);

      // ④ 收尾：isMain 重派生 + aggregatedChapters 更新 + 清状态（成功）
      finalizeIncremental(newChs.map((c) => c.number));
      clearIncrState();
      console.log(`\n[增量] event.json + volume.json 增量更新完成（temp: ${tempEvRel}、${tempVolRel} 保留待查）`);
    }
  } else {
    /* ============ 全量模式（首次 / --full / 无快照） ============ */
    console.log("\n（全量模式：重跑语义调用①②）");
    const summariesText = summaries.map((c) => `第${String(c.number).padStart(4, "0")}章 ${c.title}（${c.function}）：${c.summary}`).join("\n\n");
    await semanticEvent(summaries, summariesText);
    await semanticVolume(summaries, summariesText);
    console.log(`\n[聚合] event.json + volume.json 落盘完成`);
  }

  const { syntaxPass } = finalizePart(projectDir, project);
  if (!syntaxPass) { console.error("\n❌ 终检未通过（语法门有非法文件，见上）"); process.exit(1); }

  // 索引更新：卷纲.json 落盘 + 全书校验通过 → 更新检索索引（词典/四表/向量，增量）
  // 依据：数据变化后索引必须刷新（否则检索引用过期快照）；构建/查询分离原则——此处是显式构建点
  // 词典：走 ensureDerived 对比（源 mtime 没变 → 不重建，省 20 万规模的重建成本；句子变化暂不追踪，已知局限）
  console.log("\n[聚合] 更新检索索引（词典/四表/向量，增量）...");
  try {
    const { rebuilt } = await ensureDerived(); // {rebuilt: string[]}
    if (rebuilt.length) console.log(`  [索引] 词典已重建: ${rebuilt.join(", ")}`);
    else console.log("  [索引] 词典无变化（源未变，跳过重建）");
  } catch (err) { console.warn(`  [索引] 词典更新异常（不阻塞）: ${err.message.slice(0, 80)}`); }
  try {
    const r = buildLexicalIndex();
    if (r === null) console.log("  [索引] 四表索引：后期扩容预备，跳过（检索走实时扫盘，消费设计未落实）");
    else console.log("  [索引] 四表索引已更新（无变化则零成本）");
  } catch (err) { console.warn(`  [索引] 四表更新异常（不阻塞）: ${err.message.slice(0, 80)}`); }
  try {
    const vres = await buildVectors({ projects: [project] });
    if (vres?.ok) console.log(`  [索引] 向量已更新：${vres.index?.stats?.totalShots ?? "?"} 分镜`);
    else console.log(`  [索引] 向量跳过：${vres?.reason ?? "未知"}（${vres?.guidance ?? ""}）`);
  } catch (err) { console.warn(`  [索引] 向量更新异常（不阻塞）: ${err.message.slice(0, 80)}`); }

  console.log("\n✅ 阶段二完成：聚合层 + 终检通过 + 索引已更新（project-meta.json 已更新）");
  taskLine({ stage: "done", phase: "聚合完成" });
}

// 直接运行（源码 CLI / SEA 分发调用 export main）——被 import 时仅当直接运行才执行
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(".mjs") && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error("[aggregates] 失败:", err.message); process.exit(1); });
}
