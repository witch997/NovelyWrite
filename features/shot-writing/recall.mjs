#!/usr/bin/env node
/**
 * recall.mjs — 分镜参考写作 · 第 2 步：召回（纯脚本，零 LLM）
 *
 * 职责：读 preprocess 产出的 shots.json（全部分镜需求），逐镜触发检索器三通道，
 *       回源参考分镜文本，装配 recalls.json（完整保留 shots + 每镜 refs）。
 *
 * 输出：sessions/<session-id>/recalls.json
 *   { sessionId, project, topk, generatedAt,
 *     shots: [ { ...原分镜需求, refs: [{source,score,chapter,shotId,type,funcs,label,text}] } ] }
 *
 * 用法：
 *   node features/shot-writing/recall.mjs --session <session-id> --project <语料名> [--topk 6]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CODE_ROOT, storeDir, projectRoot } from "../../shared/paths.mjs";

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
const sessionId = argVal("session");
const project = argVal("project"); // 可选：限定单书召回；不传 = 跨书全库召回（label 跨书噪声）
const topk = Number(argVal("topk") ?? "6");
if (!sessionId) {
  console.error('用法: node features/shot-writing/recall.mjs --session <session-id> [--project <语料名>] [--topk 6]\n  不传 --project = 跨书全库召回（label 跨书噪声 + token/vec 全库）');
  process.exit(2);
}

/* ---------- 读 shots.json（preprocess 产物） ---------- */
const sessionDir = path.join(sessionsDir, sessionId);
const shotsPath = path.join(sessionDir, "shots.json");
if (!fs.existsSync(shotsPath)) {
  console.error(`[recall] shots.json 不存在: ${shotsPath}（先跑 preprocess）`);
  process.exit(1);
}
const { summary, shots } = JSON.parse(fs.readFileSync(shotsPath, "utf-8"));
console.log(`[recall] 会话 ${sessionId} | 分镜需求 ${shots.length} 镜 | 召回源: ${project ?? "全库（跨书）"}（topk=${topk}）`);

/* ---------- 检索器（retriever 三通道） ---------- */
const { pathToFileURL } = await import("node:url");
const { retrieve } = await import(pathToFileURL(path.join(CODE_ROOT, "retriever", "retriever.mjs")).href);

/** 回源：按分镜所属 project 定位句子文件（跨书回源必须用 hit 自带的 project；域感知） */
function resolveText(shot) {
  try {
    const proj = shot.project; // retriever hit.shot 带 project 字段（跨书各镜来源不同）
    if (!proj) return null;
    const ch = String(shot.chapter).padStart(4, "0");
    let sentFile;
    try {
      sentFile = path.join(projectRoot(proj), "句子标注", "json", `第${ch}章.json`);
    } catch { return null; } // 项目不存在（两域均无）
    if (!fs.existsSync(sentFile)) return null;
    const sents = JSON.parse(fs.readFileSync(sentFile, "utf-8")).sentences ?? [];
    const byId = Object.fromEntries(sents.map((s) => [s.id, s.text]));
    const texts = (shot.sentenceIds ?? []).map((id) => byId[id]).filter(Boolean);
    return texts.length ? texts.join("") : null;
  } catch { return null; }
}

/* ---------- 逐镜召回（跨书：不限定 project，三通道全库召回） ---------- */
const recalls = [];
for (const shot of shots) {
  const query = { text: shot.content ?? "", type: shot.type, funcs: shot.funcs ?? [], label: shot.label ?? "" };
  let hits = [];
  try {
    // 跨书召回：retrieve 不传 projects（全库）——label 跨书噪声 + token/vec 全库
    const r = await retrieve(query, { topk });
    hits = (r.hits ?? []).map((h) => {
      const sh = h.shot ?? {};
      const text = resolveText(sh);
      return {
        source: h.source ?? "?",
        score: typeof h.score === "number" ? +h.score.toFixed(3) : h.score,
        project: sh.project ?? null,   // 跨书回源依据（hit.shot 自带 project）
        chapter: sh.chapter ?? null,
        shotId: sh.shotId ?? null,   // retriever hit.shot 用 shotId 字段（勿用 id）
        type: sh.type, funcs: sh.funcs ?? [],
        label: sh.label ?? "",
        text: text ?? "(回源失败)",
      };
    }).filter((h) => h.text !== "(回源失败)"); // 回源失败剔除
  } catch (err) {
    console.warn(`  ⚠ 第${shot.seq}镜 召回异常: ${err.message.slice(0, 80)}`);
  }
  console.log(`  [${shot.seq}] ${shot.type}「${shot.label ?? ""}」 → ${hits.length} 条参考`);
  recalls.push({ ...shot, refs: hits });
}

/* ---------- 落盘 recalls.json（完整装配） ---------- */
const recallsJson = {
  sessionId,
  project: project ?? null,   // 传了 = 单书限定；null = 跨书全库
  topk,
  generatedAt: new Date().toISOString(),
  summary,
  shots: recalls,
};
fs.writeFileSync(path.join(sessionDir, "recalls.json"), JSON.stringify(recallsJson, null, 2) + "\n", "utf-8");
console.log(`\n✅ recalls.json 已生成: features/shot-writing/sessions/${sessionId}/recalls.json（${recalls.length} 镜，含完整 shots + refs）`);
