#!/usr/bin/env node
/**
 * preprocess.mjs — 分镜参考写作 · 第 1 步：用户输入预处理
 *
 * 职责：把用户任意输入 → 结构化分镜序列（{seq, type, funcs, label, content}），
 *       并建立会话目录留痕（input.txt / shots.json / meta.json）。
 *
 * 会话机制：
 *   会话目录：features/shot-writing/sessions/<session-id>/
 *   session-id = YYYYMMDD-HHmmss-<LLM概括>（时间戳 + LLM 生成的 2-6 字概括）；--session 可指定自定义名
 *   产物：input.txt（原始输入）/ shots.json（分镜序列）/ meta.json（元信息）
 *   写作产出（draft）在后续环节生成后复制到 NovelyWrite/output/（本步不涉及）
 *
 * 分镜序列 content 原则：尽可能从用户输入切出（忠实切分）；仅输入过于简略时才由 LLM 补充衔接与细节。
 *
 * 输入两路判别（脚本零 LLM）：
 *   A. 结构化分镜序列（含分镜标记/显式序号分点）→ 每块=一镜，content 逐字保留块原文
 *   B. 故事梗概（仅空行分隔或纯叙事）→ 一次 LLM：拆信息点 → 判断合并 → content 中改写（信息点+写作提示）
 *
 * 用法：
 *   node features/shot-writing/preprocess.mjs --input "吕树被堵反杀后装无辜"
 *   node features/shot-writing/preprocess.mjs --input "..." --session=我的会话
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadChatConfig } from "../../shared/config.mjs";
import { writingSessionDir, cliArgs } from "../../shared/paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sessionsDir = writingSessionDir; // 数据根 sessions/（SEA 只读区不可写）

let args, input, sessionName; // 惰性初始化（被 import 时不可 exit）

/* ---------- 参数（延迟到 main——被 sea-main import 时无参数，不能 exit） ---------- */
function parseArgs() {
  if (input) return;
  args = cliArgs(); // SEA 分发兼容（过滤 "run <script>" 前缀）
  const argVal = (name) => {
    const a = args.find((x) => x.startsWith(`--${name}=`));
    if (a) return a.slice(name.length + 3);
    const i = args.indexOf(`--${name}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };
  input = argVal("input");
  sessionName = argVal("session");
  if (!input) { console.error("用法: node features/shot-writing/preprocess.mjs --input \"<用户输入>\""); process.exit(2); }
  chatCfg = loadChatConfig("shot-writing", __dirname); // 惰性读配置（parseArgs 后——被 import 时不可读）
  baseUrl = (chatCfg.baseUrl ?? "https://api.deepseek.com/v1").replace(/\/+$/, "");
}

/* ---------- LLM 客户端（thinking 禁用，与 host 一致；模型/温度走模块作用域 config） ---------- */
let chatCfg = null, baseUrl = ""; // 惰性（被 import 时不可读 config；parseArgs 后赋值）

async function chatStream(messages, maxTokens = 65536) {
  const body = {
    model: chatCfg.model, messages, temperature: chatCfg.temperature ?? 0.6,
    stream: true, thinking: { type: "disabled" }, max_tokens: maxTokens,
  };
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

function parsePayload(raw) {
  let cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  try { return JSON.parse(cleaned); }
  catch {
    // 修复裸换行后重试
    const fixed = cleaned.replace(/"((?:[^"\\]|\\.)*)"/g, (m, inner) => `"${inner.replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`);
    return JSON.parse(fixed);
  }
}

/* ---------- session-id 生成（时间戳 + LLM 概括，净化） ---------- */
function sanitize(s) {
  // 去非法文件名字符 + 截断到 12 字
  return (s ?? "").replace(/[\\/:*?"<>|\s，。！？、]/g, "").slice(0, 12) || "未命名";
}
function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ---------- 主流程 ---------- */
export async function main() {
  parseArgs(); // 惰性解析 CLI 参数（SEA 分发时 main 无参）
  const taskLine = (d) => console.log(`[task] ${JSON.stringify(d)}`); // [task] 进度协议（task/manager.mjs 解析）
  taskLine({ stage: "preprocess", phase: "用户输入→分镜序列" });
  console.log(`[preprocess] 用户输入（${input.length} 字符）: ${input.slice(0, 60)}${input.length > 60 ? "…" : ""}`);

  // 输入类型判定（脚本，零 LLM）：
  //   A. sequence（结构化分镜序列）：含分镜标记（分镜N/【镜N】/镜N：）或显式序号分点（1. / 一、）→ 每块=一镜，content 逐字保留
  //   B. story（故事梗概）：仅空行分隔或纯连续叙事 → 一次 LLM 拆信息点 → 合镜 → content 中改写（信息点+写作提示）
  const hasShotMarker = /(?:^|\n)\s*(?:分镜[一二三四五六七八九十\d]+|【镜\d+】|镜\d+[|｜:：]|shot\s*\d+[:：])/i.test(input);
  const hasNumberedPoint = /(?:^|\n)\s*(?:[一二三四五六七八九十]+[、．.]|\d+[、．.])/m.test(input);
  const inputKind = hasShotMarker || hasNumberedPoint ? "sequence" : "story";
  console.log(`[preprocess] 输入类型: ${inputKind === "sequence" ? "结构化分镜序列（A：每块一镜，逐字保留）" : "故事梗概（B：拆信息点→合镜→中改写）"}`);

  // LLM：概括 + 分镜序列
  const userMsg = inputKind === "sequence"
    ? [
        "## 任务：把用户输入改写为一组尽可能详细的结构化分镜序列",
        "### 用户输入",
        input,
        "",
        "## 要求",
        "1. **用户输入已按内容分块**（分镜标记/序号分点分隔的段落即一个完整分块）。",
        "2. 严格按用户的分块切分：每个分块 = 一个分镜，分块内部不再细分（一个分块一个分镜）。",
        "3. 每镜字段：type（六型）/ funcs（十种，1-3 个）/ label（2-6字）/ content（本镜内容，完整保留该分块原文）",
        "4. content 必须【逐字保留】对应分块的原文内容，不增删不改写。",
        "5. 额外给出 summary：对用户输入主题的 2-6 字概括（用于会话命名）",
        "",
        "## 合法枚举",
        "type: 信息/对话/心理/动作/事件/环境",
        "funcs: 塑造人物/引入世界观/设置动机/推进/铺垫/反转/爆发/转场/收束分镜/悬念",
        "",
        "## 输出格式",
        '{"summary": "<7字以下概括>", "shots": [{"seq":1,"type":"...","funcs":[...],"label":"...","content":"..."}, ...]}',
        "只输出这个 JSON，不要任何其他内容。",
      ].join("\n")
    : [
        "## 任务：把故事梗概转化为结构化分镜序列",
        "### 用户输入（故事梗概）",
        input,
        "",
        "## 步骤（在心中执行，不要输出中间过程）",
        "1. **拆解信息点**：先把梗概拆散为一组信息点序列——每个信息点是梗概里的一个原子内容（人物/动机/冲突/转折/场景/事件），忠于原文不增删。",
        "2. **判断合并**：判断哪些信息点属于同一分镜（语义相邻/同场景/同人物/同一叙事动作）→ 合并为一个分镜；宁细勿粗。",
        "3. **生成分镜**：每个合并后的分镜输出一镜，字段：type（六型）/ funcs（十种，1-3 个）/ label（2-6字）/ content。",
        "",
        "## content 要求（两段式分层）",
        "content 必须包含两段，用换行分隔：",
        "【信息点】本镜覆盖的梗概内容（忠于原文，不增删不改写，逐条列出本镜负责的信息点）。",
        "【写作提示】本镜的写作线索——场景氛围、人物状态、情绪变化、动作细节、对话要点等，供写作阶段展开。写作提示允许补充细节，但不得新增情节/人物/偏离梗概主线。",
        "两段合计 100-200 字，信息点保真、写作提示丰满。",
        "",
        "## 合法枚举",
        "type: 信息/对话/心理/动作/事件/环境",
        "funcs: 塑造人物/引入世界观/设置动机/推进/铺垫/反转/爆发/转场/收束分镜/悬念",
        "",
        "## 输出格式",
        '{"summary": "<7字以下概括>", "shots": [{"seq":1,"type":"...","funcs":[...],"label":"...","content":"..."}, ...]}',
        "只输出这个 JSON，不要任何其他内容。",
      ].join("\n");

  console.log("[preprocess] 调用 LLM（结构化分镜序列 + 概括）...");
  const raw = await chatStream([
    { role: "system", content: "你是分镜结构化器：把用户输入改写为结构化分镜序列，忠实切分、不自行发挥。" },
    { role: "user", content: userMsg },
  ]);
  console.log(`[preprocess] LLM 返回 ${raw.length} 字符`);

  const payload = parsePayload(raw);
  const summary = sanitize(payload.summary ?? "未命名");
  let shots = payload.shots ?? [];
  // 脚本补 seq（防 LLM 跳号）+ 校验枚举
  shots = shots.map((s, i) => ({ ...s, seq: i + 1 }));
  const validTypes = ["信息", "对话", "心理", "动作", "事件", "环境"];
  const validFuncs = ["塑造人物", "引入世界观", "设置动机", "推进", "铺垫", "反转", "爆发", "转场", "收束分镜", "悬念"];
  const badType = shots.filter((s) => !validTypes.includes(s.type));
  const badFunc = shots.filter((s) => !(s.funcs ?? []).length || s.funcs.some((f) => !validFuncs.includes(f)));
  if (badType.length) console.warn(`  ⚠ ${badType.length} 镜 type 非法（LLM 输出）: ${badType.map((s) => s.type).join("/")}`);
  if (badFunc.length) console.warn(`  ⚠ ${badFunc.length} 镜 funcs 非法/为空（LLM 输出）`);

  // 会话落盘
  const sessionId = sessionName ? sanitize(sessionName) : `${ts()}-${summary}`;
  const sessionDir = path.join(sessionsDir, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "input.txt"), input, "utf-8");
  fs.writeFileSync(path.join(sessionDir, "shots.json"), JSON.stringify({ summary, shots }, null, 2) + "\n", "utf-8");
  const meta = {
    sessionId,
    createdAt: new Date().toISOString(),
    inputSummary: summary,
    model: chatCfg.model,
    inputLength: input.length,
    shotCount: shots.length,
    next: "recall/write（后续环节）",
  };
  fs.writeFileSync(path.join(sessionDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf-8");

  console.log(`\n✅ 会话已建立: ${sessionId}`);
  console.log(`   目录: ${sessionsDir}/${sessionId}/`);
  console.log(`   概括: ${summary} | 分镜: ${shots.length} 镜`);
  console.log(`\n=== 分镜序列 ===`);
  for (const s of shots) {
    console.log(`  [${s.seq}] ${s.type} ${JSON.stringify(s.funcs ?? [])}「${s.label ?? ""}」 ${(s.content ?? "").slice(0, 50)}${(s.content ?? "").length > 50 ? "…" : ""}`);
  }
  console.log(`\n[preprocess] 完成。后续：recall（召回参考）→ write（写作）→ draft 复制到 output/`);
  taskLine({ stage: "done", phase: `分镜完成（${shots.length} 镜）` });
}

// 直接运行（源码 CLI / SEA 分发调用 export main）
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(".mjs") && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error("[preprocess] 失败:", err.message); process.exit(1); });
}
