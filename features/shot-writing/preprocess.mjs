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
 * 用法：
 *   node features/shot-writing/preprocess.mjs --input "吕树被堵反杀后装无辜"
 *   node features/shot-writing/preprocess.mjs --input "..." --session=我的会话
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadChatConfig } from "../../shared/config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sessionsDir = path.join(__dirname, "sessions");

/* ---------- 参数 ---------- */
const args = process.argv.slice(2);
function argVal(name) {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  if (a) return a.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
const input = argVal("input");
const sessionName = argVal("session");
if (!input) { console.error("用法: node features/shot-writing/preprocess.mjs --input \"<用户输入>\""); process.exit(2); }

/* ---------- LLM 客户端（thinking 禁用，与 host 一致；模型/温度走模块作用域 config） ---------- */
const chatCfg = loadChatConfig("shot-writing", __dirname); // 根 config.features["shot-writing"] 覆盖全局 + 功能目录 config.json 兼容
const baseUrl = (chatCfg.baseUrl ?? "https://api.deepseek.com/v1").replace(/\/+$/, "");

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
async function main() {
  console.log(`[preprocess] 用户输入（${input.length} 字符）: ${input.slice(0, 60)}${input.length > 60 ? "…" : ""}`);

  // 检测用户是否已自带内容分块逻辑：
  //   ① 空行分隔（段落间有 ≥2 个连续换行）
  //   ② 显式分隔标记（--- / ### / 【】 / 数字编号如 "1."）
  // 有分块 → 按用户分块切分（每块一镜）；无分块 → LLM 按叙事动作自由切
  const hasBlankLineBlocks = /\n\s*\n/.test(input);
  const hasExplicitMarkers = /(?:^|\n)\s*(?:---|###|【|\[\d+\]|\d+[\.、])/m.test(input);
  const userBlocked = hasBlankLineBlocks || hasExplicitMarkers;
  console.log(`[preprocess] 用户分块检测: ${userBlocked ? "有（按用户分块切分）" : "无（LLM 自由切分）"}（空行块=${hasBlankLineBlocks}，显式标记=${hasExplicitMarkers}）`);

  // LLM：概括 + 分镜序列
  const userMsg = [
    "## 任务：把用户输入改写为一组尽可能详细的结构化分镜序列",
    "### 用户输入",
    input,
    "",
    "## 要求",
    ...(userBlocked
      ? [
          "1. **用户输入已按内容分块**（空行/标记分隔的段落即一个完整分块）。",
          "2. 严格按用户的分块切分：每个分块 = 一个分镜，分块内部不再细分（一个分块一个分镜）。",
          "3. 每镜字段：type（六型）/ funcs（十种，1-3 个）/ label（2-6字）/ content（本镜内容，完整保留该分块原文）",
          "4. content 必须【逐字保留】对应分块的原文内容，不增删不改写。",
          "5. 额外给出 summary：对用户输入主题的 2-6 字概括（用于会话命名）",
        ]
      : [
          "1. 将输入切分为有序分镜序列（宁过切勿合并，每镜一个叙事动作）",
          "2. 每镜字段：type（六型）/ funcs（十种，1-3 个）/ label（2-6字）/ content（本镜内容）",
          "3. **content 必须尽可能从用户输入切出**（忠实于原意/原文）；仅当输入过于简略无法支撑分镜时，才由你补充衔接与细节（补充应最少化）",
          "4. 额外给出 summary：对用户输入主题的 2-6 字概括（用于会话命名）",
        ]),
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
  console.log(`   目录: features/shot-writing/sessions/${sessionId}/`);
  console.log(`   概括: ${summary} | 分镜: ${shots.length} 镜`);
  console.log(`\n=== 分镜序列 ===`);
  for (const s of shots) {
    console.log(`  [${s.seq}] ${s.type} ${JSON.stringify(s.funcs ?? [])}「${s.label ?? ""}」 ${(s.content ?? "").slice(0, 50)}${(s.content ?? "").length > 50 ? "…" : ""}`);
  }
  console.log(`\n[preprocess] 完成。后续：recall（召回参考）→ write（写作）→ draft 复制到 NovelyWrite/output/`);
}
main().catch((err) => { console.error("[preprocess] 失败:", err.message); process.exit(1); });
