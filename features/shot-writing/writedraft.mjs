#!/usr/bin/env node
/**
 * writedraft.mjs — 分镜参考写作 · 第 3 步：写作（两阶段：逐镜拼接 → 全文整合）
 *
 * 职责：消费 recalls.json（完整 shots + 每镜 refs）：
 *   阶段① 逐镜写作（每镜一次 LLM，thinking 开）：intent + refs（参考分镜文本）→ 该镜文本
 *         ——口语化约束 + 每镜 150-400 字（对齐 narrativeeasy 的 WRITE_SYSTEM）
 *         拼接为「带分镜标签」的 draft：`【镜N｜type｜label】\n正文`
 *         → 落盘会话存档 <项目名>draft.txt（中间产物，人可读/可人工调整）
 *   阶段② 全文整合（一次 LLM，thinking 禁）：输入 = draft.txt（带标签分镜）+ 原始章纲
 *         ——按《章节写作》SKILL 数据化硬指标约束，整合为完整章节
 *         → 落盘最终稿 NovelyWrite/output/<项目名>.final.txt（去掉分镜标签，纯正文）
 *
 * 输出：
 *   sessions/<session-id>/<项目名>draft.txt        （阶段① 中间产物，会话存档）
 *   NovelyWrite/output/<项目名>.final.txt               （阶段② 最终整合稿，用户可读）
 *
 * 用法：
 *   node features/shot-writing/writedraft.mjs --session <session-id> [--project <语料名>]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CODE_ROOT } from "../../shared/paths.mjs";
import { loadChatConfig } from "../../shared/config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sessionsDir = path.join(__dirname, "sessions");
const outputDir = path.join(CODE_ROOT, "output");

/* ---------- 参数 ---------- */
const args = process.argv.slice(2);
function argVal(name) {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  if (a) return a.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
const sessionId = argVal("session");
const project = argVal("project") ?? "未命名"; // 项目名（用于 draft 文件名）
if (!sessionId) { console.error("用法: node features/shot-writing/writedraft.mjs --session <session-id> [--project <语料名>]"); process.exit(2); }

/* ---------- 读 recalls.json ---------- */
const sessionDir = path.join(sessionsDir, sessionId);
const recallsPath = path.join(sessionDir, "recalls.json");
if (!fs.existsSync(recallsPath)) {
  console.error(`[writedraft] recalls.json 不存在: ${recallsPath}（先跑 recall）`);
  process.exit(1);
}
const recalls = JSON.parse(fs.readFileSync(recallsPath, "utf-8"));
const shots = recalls.shots ?? [];
console.log(`[writedraft] 会话 ${sessionId} | 项目 ${project} | 分镜 ${shots.length} 镜`);

/* ---------- 读原始章纲（input.txt，阶段② 整合输入之一） ---------- */
const inputPath = path.join(sessionDir, "input.txt");
const outline = fs.existsSync(inputPath) ? fs.readFileSync(inputPath, "utf-8") : recalls.summary ?? "";

/* ---------- LLM 客户端（thinking 开——推理型任务） ---------- */
const chatCfg = loadChatConfig();
const baseUrl = (chatCfg.baseUrl ?? "https://api.deepseek.com/v1").replace(/\/+$/, "");

async function chat(messages, maxTokens = 8192, thinking = true) {
  const body = {
    model: chatCfg.model, messages, temperature: 0.8,
    stream: true, max_tokens: maxTokens,
  };
  // thinking：默认开（不传 disabled）；调用方传 thinking=false 时禁用
  if (thinking === false) body.thinking = { type: "disabled" };
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${chatCfg.apiKey}` },
    body: JSON.stringify(body),
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
}

/* ========== 阶段① 逐镜写作 + 拼接带标签 draft ========== */
console.log("\n[writedraft] 阶段① 逐镜写作（每镜一次 LLM，thinking 开）...");
const WRITE_SYSTEM = `你是起点中文网风格的网文作者。根据【任务】写作一个分镜（镜头级片段），
参考【写作参考】中前文类似分镜的写法与风格。

要求：
- 只输出该分镜的正文，不要输出标题、注释、分析
- 严格遵循该分镜给出的信息，可以拓展，但不允许按照【写作参考】改写
- 符合给定 type（分镜类型）与 funcs（叙事功能）
- 分镜长度 150-400 字
- 语言口语化、有网文节奏感，避免文学性拖沓（不要 对仗式描写/环境暗喻心理/成语堆砌/「仿佛/恰似/凛然」类书面腔）
- 本镜是章节中的独立片段，不写场景开头/结尾的过渡语（衔接由整合阶段统一处理）
- 主角称呼与上下镜保持一致（本镜若出现人物，沿用其已有称呼，不自行改名）`;

const shotBodies = [];
for (const shot of shots) {
  const refsText = (shot.refs ?? []).length
    ? (shot.refs ?? []).map((r, i) =>
        `${i + 1}. [${r.source}] 第${r.chapter}章 分镜${r.shotId}（${r.type}/${(r.funcs ?? []).join("、")}「${r.label ?? ""}」）：${r.text ?? ""}`
      ).join("\n")
    : "（无参考）";
  const userMsg = [
    "## 任务：写一个分镜文本",
    "### 本镜需求",
    `类型: ${shot.type}`,
    `功能: ${(shot.funcs ?? []).join("、")}`,
    `标签: ${shot.label ?? ""}`,
    `内容: ${shot.content ?? ""}`,
    "",
    "### 写作参考（前文相似分镜，可借鉴其写法/口吻/信息，不要照抄）",
    refsText,
    "",
    "## 要求",
    "写出该分镜的正文文本（150-400 字，口语化有网文节奏感，避免文学性拖沓；贴合本镜 type/funcs/内容；参考分镜只学口语节奏与写法）。",
    "只输出该分镜的正文文本，不要任何格式说明。",
  ].join("\n");
  const raw = await chat([
    { role: "system", content: WRITE_SYSTEM },
    { role: "user", content: userMsg },
  ]);
  shotBodies.push(raw.trim());
  console.log(`  [${shot.seq}] ${shot.type}「${shot.label ?? ""}」 → ${raw.length} 字符`);
}

/* 拼接：带分镜标签的 draft（中间产物） */
const taggedDraft = shotBodies.map((body, i) => {
  const s = shots[i];
  return `【镜${i + 1}｜${s.type}｜${s.label ?? ""}】\n${body}`;
}).join("\n\n");

const draftName = `${project}draft.txt`; // <项目名>draft.txt（现有风格：项目名 + draft）
fs.mkdirSync(sessionDir, { recursive: true });
fs.writeFileSync(path.join(sessionDir, draftName), taggedDraft, "utf-8");
console.log(`\n[writedraft] 阶段① draft 已落盘（中间产物，带分镜标签）:`);
console.log(`   sessions/${sessionId}/${draftName}（${taggedDraft.length} 字符）`);

/* ========== 阶段② 全文整合（draft + 章纲 → 最终稿，SKILL 指标约束） ========== */
console.log("\n[writedraft] 阶段② 全文整合（draft.txt + 原始章纲 → 完整章节，按 SKILL 指标约束）...");
const MERGE_SYSTEM = `你是起点中文网风格的网文作者。把一组"带标签的分镜文本"整合成一个完整的章节。

【整合要求】
- 输入分镜带标签【镜N｜类型｜label】——标签是分镜意图（类型/功能），正文是已写好的分镜文本
- 按分镜顺序整合为完整章节，镜头间过渡自然（可加段落衔接，不机械拼接）
- 各分镜独立写作，可能缺开头/结尾过渡语：你负责补衔接句，使场景切换流畅
- 消除重复/冲突内容，润色衔接处；保持各分镜核心内容不变，不新增情节
- 整合后【去掉分镜标签】，输出纯正文章节
- 只输出章节正文，不要输出标题、注释、分析

【结构硬指标（来自《章节写作》SKILL，必须达标）】
- 开篇钩子：动作/对话/异常开局，禁静态描写或前情复述
- 收尾悬念：为下一章留未解问题，禁情绪闭环或总结
- 字数 2500-4500；每 500-800 字 1 个节拍（障碍/新信息）；首次场景描写 ≤5 句；场景过渡每处 ≤2 句

【语言硬指标（来自《章节写作》SKILL，必须达标）】
- 短句优先：≤12 字短句占比 ≥20%，宁可拆句不用逗号串接复杂从句
- 主谓宾直给："谁做了什么"，禁倒装与嵌套修饰
- 破折号（——）0 次：需要强调/转折时用逗号分割短句或另起一句
- 禁舒缓叠词（慢慢/轻轻/缓缓/微微/渐渐）：改具体动作
- 禁艺术性明喻（文学化"像…"）≤1 个；总比喻 ≤5 个
- 动词朴实（拿/放/掏/倒/收拾/拧/拨），禁华丽动词（攫住/凝视/伫立）
- 情绪直接命名（"她有些落寞"），禁止环境渲染代替情绪
- 心理活动 ≤5 次，单次 ≤80 字，禁超长内耗独白
- 对话不可分割：禁「"A"动作，"B"」句式；每段对话至少一种功能（推进/揭示/塑造/张力），否则删除
- 叙述者介入 0 次（不出现"作者按/各位读者"等）`;
const mergeUser = [
  "### 原始章纲（供你把握整体意图）",
  outline,
  "",
  "### 带标签的分镜文本（按顺序）",
  taggedDraft,
].join("\n\n");
const mergeRaw = await chat([
  { role: "system", content: MERGE_SYSTEM },
  { role: "user", content: mergeUser },
], 8192, false); // 全文整合：thinking 禁用（长输入下 thinking 会吃光 max_tokens 导致空输出）
const finalText = mergeRaw.trim();
console.log(`  [整合] 最终稿 ${finalText.length} 字符`);

/* ---------- 落盘：最终稿 → NovelyWrite/output/ ---------- */
fs.mkdirSync(outputDir, { recursive: true });
const finalName = `${project}.final.txt`; // <项目名>.final.txt（最终整合稿，纯正文）
fs.writeFileSync(path.join(outputDir, finalName), finalText, "utf-8");
console.log(`\n✅ 最终稿已生成:`);
console.log(`   中间产物: features/shot-writing/sessions/${sessionId}/${draftName}（带标签，会话存档）`);
console.log(`   最终稿:   NovelyWrite/output/${finalName}（纯正文，用户可读）`);
console.log(`\n=== 最终稿预览 ===`);
console.log(finalText.slice(0, 600) + (finalText.length > 600 ? "\n…" : ""));
