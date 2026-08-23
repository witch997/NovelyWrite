#!/usr/bin/env node
/**
 * recall.mjs — 分镜参考写作 · 第 2 步：召回（纯脚本，零 LLM）
 *
 * 职责：读 preprocess 产出的 shots.json（全部分镜需求），逐镜触发检索器三通道，
 *       回源参考分镜文本，装配 recalls.json（完整保留 shots + 每镜 refs）。
 *
 * 参考源选择（跨书参考）：
 *   --project=A,B  限定召回书（逗号分隔多书，跨域自动解析：myproject/exproject 都认）
 *   --project=A --project=B  等价写法（多值）
 *   不传 --project = 跨书全库召回（label 跨书噪声 + token/vec 全库）
 *
 * 输出：sessions/<session-id>/recalls.json
 *   { sessionId, projects, topk, generatedAt,
 *     shots: [ { ...原分镜需求, refs: [{source,score,chapter,shotId,type,funcs,label,text}] } ] }
 *
 * 用法：
 *   node features/shot-writing/recall.mjs --session <session-id> [--project=书A,书B] [--topk 6]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CODE_ROOT, storeDir, projectRoot, listProjects, writingSessionDir, cliArgs } from "../../shared/paths.mjs";
import { retrieve } from "../../retriever/retriever.mjs"; // 静态 import（SEA blob 只含静态依赖）

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sessionsDir = writingSessionDir; // 数据根 sessions/（SEA 只读区不可写）

let args, sessionId, topk; // 惰性初始化（被 import 时不可 exit）

/* ---------- 参数（延迟到 main——被 sea-main import 时无参数，不能 exit） ---------- */
function parseArgs() {
  if (sessionId) return;
  args = cliArgs(); // SEA 分发兼容（过滤 "run <script>" 前缀）
  const argVal = (name) => {
    const a = args.find((x) => x.startsWith(`--${name}=`));
    if (a) return a.slice(name.length + 3);
    const i = args.indexOf(`--${name}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };
  sessionId = argVal("session");
  topk = Number(argVal("topk") ?? "6");
  if (!sessionId) {
    console.error('用法: node features/shot-writing/recall.mjs --session <session-id> [--project=书A,书B] [--topk 6]\n  不传 --project = 跨书全库召回（label 跨书噪声 + token/vec 全库）');
    process.exit(2);
  }
}

/* ================= 主流程 ================= */
export async function main() {
  parseArgs(); // 惰性解析 CLI 参数（SEA 分发时 main 无参）
  const taskLine = (d) => console.log(`[task] ${JSON.stringify(d)}`); // [task] 进度协议（task/manager.mjs 解析）
  taskLine({ stage: "recall", phase: "召回参考" });
  // 参考源：--project 支持逗号分隔多书 / 多次传入；解析为数组（空 = 全库）
  const rawProjects = [];
  for (const a of args) {
    if (a.startsWith("--project=")) rawProjects.push(...a.slice("--project=".length).split(",").map((s) => s.trim()).filter(Boolean));
  }
  {
    const i = args.indexOf("--project");
    while (i >= 0 && i + 1 < args.length && !args[i + 1].startsWith("--")) {
      const v = args[i + 1];
      if (!v.startsWith("--")) rawProjects.push(...v.split(",").map((s) => s.trim()).filter(Boolean));
      break;
    }
  }
  // 去重 + 存在性校验（两域任一有即合法；不存在的书剔除并警告）
  const allBooks = new Set(listProjects());
  const unknown = rawProjects.filter((p) => !allBooks.has(p));
  for (const p of new Set(unknown)) console.warn(`  ⚠ 参考书不存在（已忽略）: ${p}（可用: ${[...allBooks].join(" / ")}）`);
  const projects = [...new Set(rawProjects)].filter((p) => allBooks.has(p));

  /* ---------- 读 shots.json（preprocess 产物） ---------- */
  const sessionDir = path.join(sessionsDir, sessionId);
  const shotsPath = path.join(sessionDir, "shots.json");
  if (!fs.existsSync(shotsPath)) {
    console.error(`[recall] shots.json 不存在: ${shotsPath}（先跑 preprocess）`);
    process.exit(1);
  }
  const { summary, shots } = JSON.parse(fs.readFileSync(shotsPath, "utf-8"));
  console.log(`[recall] 会话 ${sessionId} | 分镜需求 ${shots.length} 镜 | 召回源: ${projects.length ? projects.join(" + ") : "全库（跨书）"}（topk=${topk}）`);

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

/* ---------- 逐镜召回（参考源选择：限书 projects 或全库） ---------- */
const recalls = [];
for (const shot of shots) {
  const query = { text: shot.content ?? "", type: shot.type, funcs: shot.funcs ?? [], label: shot.label ?? "" };
  let hits = [];
  try {
    // 限书召回：只传 projects（所选书内三通道召回）；不传 = 全库跨书
    const r = await retrieve(query, { topk, projects: projects.length ? projects : undefined });
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
  projects: projects.length ? projects : null, // 选了书 = [书A,书B]；null = 全库跨书
  topk,
  generatedAt: new Date().toISOString(),
  summary,
  shots: recalls,
};
fs.writeFileSync(path.join(sessionDir, "recalls.json"), JSON.stringify(recallsJson, null, 2) + "\n", "utf-8");
console.log(`\n✅ recalls.json 已生成: ${sessionsDir}/${sessionId}/recalls.json（${recalls.length} 镜，含完整 shots + refs）`);
taskLine({ stage: "done", phase: `召回完成（${recalls.length} 镜）` });
}

// 直接运行（源码 CLI / SEA 分发调用 export main）
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(".mjs") && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error("[recall] 失败:", err.message); process.exit(1); });
}
