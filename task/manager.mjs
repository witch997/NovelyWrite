#!/usr/bin/env node
/**
 * task/manager.mjs — 任务管理器（从 server.mjs 原样抽出的模块，行为零改动）
 *
 * 职责：长任务生命周期管理 —— 启动子进程、进度解析、状态持久化、列表查询、
 *       重跑/停止/stale 判定、启动清理。纯 Node 模块，不依赖 HTTP。
 *
 * 本文件是【结构性搬家】产物：函数体与 server.mjs 抽取前完全一致，未做任何
 * 行为改动。已知设计问题统一记录在 task/ISSUES.md（只记录、未修复）。
 *
 * 依赖：
 *   shared/paths.mjs（runScriptArgs/isSeaRuntime/CODE_ROOT/DATA_ROOT/DOMAIN 等）
 *   shared/tasks.mjs（状态/日志持久化）
 *   shared/errors.mjs（NovelyError）
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CODE_ROOT, DATA_ROOT, storeDir, corpusDir, projectRoot, DOMAIN, isSeaRuntime, runScriptArgs } from "../shared/paths.mjs";
import { NovelyError } from "../shared/errors.mjs";
import { persistTask, appendTaskLog, loadTaskLog, listTasks as listTasksFromDisk } from "../shared/tasks.mjs";

const NODE = process.execPath;

/* ================= 长任务管理器（子进程 + 状态文件，复用 shared/tasks.mjs） ================= */
const taskState = new Map(); // id → {id, script, args, status, startedAt, finishedAt, code}

export function startTask(script, targs, label) {
  const id = `${label}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const t = { id, script, args: targs, status: "running", label, startedAt: new Date().toISOString(), finishedAt: null, code: null };
  taskState.set(id, t);
  // SEA 单文件：无真实子进程脚本 → spawn exe 自身（sea-main 按 NOVELYWRITE_RUN 环境变量分发）
  const cwd = isSeaRuntime ? DATA_ROOT : CODE_ROOT; // pkg 下 CODE_ROOT 是 snapshot 虚拟路径，spawn cwd 必须真实
  const [cmd, cmdArgs, cmdEnv] = runScriptArgs(script, targs);
  const child = isSeaRuntime
    ? spawn(cmd, cmdArgs, { cwd, env: cmdEnv })
    : spawn(NODE, [path.join(CODE_ROOT, script), ...targs], { cwd: CODE_ROOT, env: process.env });
  // 日志流 → 独立 log 文件夹（store/_tasks/log/<id>.log，appendTaskLog 内部截断 LOG_KEEP 行）
  // 同时实时解析进度（annotate: 第X章完成/共N章/阶段行）→ 维护 t.progress（内存+持久化，不依赖日志截断）
  let buf = "";
  const parseProgress = (line) => {
    if (script !== "novelread/host-exec.mjs") return;
    const p = t.progress ?? {};
    // 范围/总数：优先子进程权威行"本次任务 N 章待处理"（--all/--from/--chapter/--pending 通用）；缺失时按 args 推断兜底
    const todoM = line.match(/本次任务\s*(\d+)\s*章待处理/);
    if (todoM) {
      p.total = Number(todoM[1]);
    } else {
      // 范围/总数：--from/--to 或 --all
      const argVal = (n) => { const a = targs.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
      if (argVal("from")) {
        const from = Number(argVal("from"));
        const to = argVal("to") ? Number(argVal("to")) : null;
        const totalM = line.match(/共\s*(\d+)\s*章/);
        if (totalM) p.total = to ? (to - from + 1) : (Number(totalM[1]) - from + 1);
      } else if (targs.includes("--all")) {
        const totalM = line.match(/共\s*(\d+)\s*章/);
        if (totalM) p.total = Number(totalM[1]);
      } else if (argVal("chapter")) {
        p.total = String(argVal("chapter")).split(",").filter(Boolean).length;
      }
    }
    // 完成章 / 阶段（done = 本次任务范围内已完成章数；"第X章完成"每章至多输出一次 → 计数即完成数）
    const doneM = line.match(/第(\d+)章完成/);
    if (doneM) {
      p.currentChapter = Number(doneM[1]);
      p.done = (p.done ?? 0) + 1;
    } else if (line.includes("往返1")) {
      p.stage = "往返1:句子";
    } else if (line.includes("往返2")) {
      p.stage = "往返2:分镜+章节";
    } else if (line.includes("批末自动补跑增量聚合") || line.includes("触发向量增量构建")) {
      p.stage = "批末派生";
    } else if (line.includes("全部完成")) {
      p.stage = "完成";
    }
    // 有进度信息才写（防高频无意义写盘）
    if (p.total || p.done || p.stage) {
      t.progress = p;
      persistTask(t);
    }
  };
  const push = (chunk) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    const clean = lines.filter((l) => l.trim());
    if (clean.length) {
      appendTaskLog(id, clean);
      for (const l of clean) parseProgress(l);
    }
  };
  child.stdout.on("data", push);
  child.stderr.on("data", push);
  child.on("error", (err) => { t.status = "failed"; t.finishedAt = new Date().toISOString(); t.code = -1; t.error = err.message; taskFinishedAt = Date.now(); persistTask(t); });
  child.on("close", (code) => { t.status = code === 0 ? "success" : "failed"; t.finishedAt = new Date().toISOString(); t.code = code; taskFinishedAt = Date.now(); persistTask(t); });
  persistTask(t);
  return id;
}

export function listTasks() {
  // 内存态 + 磁盘态合并（磁盘覆盖内存中已结束的，补齐重启前遗留）
  const byId = new Map();
  for (const t of listTasksFromDisk()) byId.set(t.id, t);
  for (const [id, t] of taskState) {
    if (!byId.has(id) || t.status === "running") byId.set(id, t);
  }
  return [...byId.values()].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
}

/* ================= 任务重跑（失败/被杀 → 智能续跑） =================
 * annotate：从原任务参数推导本次范围(todo) − 已标注章(章节/目录) = 缺失章 → --chapter=缺失
 *           只补缺章，不重标已成功章（省 LLM）；无缺章 → rerun:false + 原因
 * 其他任务（aggregate/fix/AI 链）：原参数重跑（聚合/fix 增量幂等；AI 链重新生成）
 */
export function apiTaskRerun(id) {
  const t = listTasks().find((x) => x.id === id);
  if (!t) throw new NovelyError("NOT_FOUND", { context: { id, kind: "task" } });
  if (t.status === "running") throw new NovelyError("ARG_INVALID", { context: { id, rule: "任务仍在运行，不能重跑" } });
  const args = t.args ?? [];
  if (t.script === "novelread/host-exec.mjs") {
    const smart = smartRerunAnnotate(args);
    if (smart) return smart; // { rerun:true, taskId, mode } | { rerun:false, reason }
  }
  const taskId = startTask(t.script, args, t.label);
  return { rerun: true, taskId, mode: "原参数重跑" };
}

/** annotate 智能续跑：todo − 已标注 → 缺失章；无法推导范围/清单缺失 → null（调用方走原参数重跑） */
/**
 * annotate 任务范围状态：todo（原任务应标章）− done（已标注章）= missing（缺章）
 * @returns {null|{corpus, domain, todo:number[], done:Set<number>, missing:number[], reason?:string}}
 *   null = 无法推导范围（清单缺失/参数无法解析）→ 调用方走原参数重跑
 *   reason 存在 = 明确"无需重跑"（如 pending 为空 / 无缺章）
 */
function annotateRangeState(args) {
  const argVal = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
  const corpus = argVal("corpus");
  const domain = argVal("domain") ?? DOMAIN.EX;
  if (!corpus) return null;
  // 1. 读章节清单 → 全部章号
  const allNums = [];
  const listPath = path.join(corpusDir, `${corpus}-章节清单.csv`);
  if (fs.existsSync(listPath)) {
    const lines = fs.readFileSync(listPath, "utf-8").replace(/\r\n/g, "\n").split("\n");
    for (let i = 1; i < lines.length; i++) {
      const m = lines[i].trim().match(/^(\d+),/);
      if (m) allNums.push(Number(m[1]));
    }
  }
  if (!allNums.length) return null;
  // 书名显示归一（corpus 名可能自带《》→ 去外层重复包裹）
  const displayName = corpus.replace(/^《|》$/g, "");
  // 2. 从原参数推导本次范围 todo
  let todo = null;
  if (args.includes("--all")) todo = allNums;
  else if (argVal("from")) {
    const from = Number(argVal("from")), to = argVal("to") ? Number(argVal("to")) : Infinity;
    todo = allNums.filter((n) => n >= from && n <= to);
  } else if (argVal("chapter")) {
    todo = String(argVal("chapter")).split(",").map(Number);
  } else if (args.includes("--pending")) {
    // 补建任务重跑：范围 = pending.json 缺章
    try {
      const pend = JSON.parse(fs.readFileSync(path.join(projectRoot(corpus, domain), "pending.json"), "utf-8"));
      todo = (pend.pending ?? []).map((x) => x.chapter);
    } catch { /* pending 缺失 → 无法推导 */ }
    // pending 无缺章 → 明确"无需重跑"，不启动注定失败的任务（原 --pending 会报"无未完成章"退出）
    if (!todo?.length) {
      return { corpus, domain, todo: [], done: new Set(), missing: [], reason: `无缺章（《${displayName}》pending.json 无未完成章）` };
    }
  }
  if (!todo?.length) return null;
  // 3. 已标注章（扫 章节/ 目录，排除 章节表.json）
  const done = new Set();
  const chDir = path.join(projectRoot(corpus, domain), "章节");
  if (fs.existsSync(chDir)) {
    for (const f of fs.readdirSync(chDir)) {
      const m = f.match(/^第(\d{4})章\.json$/);
      if (m) done.add(Number(m[1]));
    }
  }
  // 4. 缺失 = todo − done（保持 todo 顺序）
  const missing = todo.filter((n) => !done.has(n));
  return { corpus, domain, todo, done, missing, reason: missing.length ? null : `无缺章（《${displayName}》范围内 ${todo.length} 章全部已标注）` };
}

function smartRerunAnnotate(args) {
  const st = annotateRangeState(args);
  if (!st) return null; // 无法推导 → 调用方原参数重跑
  if (st.reason) return { rerun: false, reason: st.reason };
  const newArgs = [`--corpus=${st.corpus}`, `--domain=${st.domain}`, `--chapter=${st.missing.join(",")}`];
  const taskId = startTask("novelread/host-exec.mjs", newArgs, "annotate");
  return { rerun: true, taskId, mode: `智能续跑：补 ${st.missing.length} 章（${st.missing.join(",")}）`, missing: st.missing };
}

/** 任务是否"使命已完成"（failed/killed 卡降级用）：范围 todo − done 为空 → stale=true 已补齐 */
export function apiTaskStale(id) {
  const t = listTasks().find((x) => x.id === id);
  if (!t) throw new NovelyError("NOT_FOUND", { context: { id, kind: "task" } });
  if (t.script !== "novelread/host-exec.mjs") return { stale: false, reason: "仅建库任务可判断" };
  const st = annotateRangeState(t.args ?? []);
  if (!st) return { stale: false, reason: "无法推导任务范围（清单缺失）" };
  if (st.reason) return { stale: true, reason: st.reason, done: st.todo.length };
  return { stale: false, reason: `缺 ${st.missing.length} 章（${st.missing.slice(0, 10).join(",")}${st.missing.length > 10 ? "…" : ""}）`, missing: st.missing };
}

/** 任务参数装配（前端 body → 脚本 CLI 参数） */
export function taskArgsFor(kind, b) {
  const a = [];
  switch (kind) {
    case "annotate":
      if (!b?.project) throw new NovelyError("ARG_REQUIRED", { context: { field: "project" } });
      a.push(`--corpus=${b.project}`, `--domain=${b.domain ?? DOMAIN.EX}`);
      if (b.all) a.push("--all");
      else if (b.chapter) a.push(`--chapter=${String(b.chapter).trim()}`); // 逗号列表单参数（host-exec 内部分 split）
      else if (b.pending) a.push("--pending"); // 补建指令：只补 pending 缺章
      else if (b.from) {
        a.push(`--from=${Number(b.from)}`); // 从第 N 章起
        if (b.to) a.push(`--to=${Number(b.to)}`); // 续建终点（默认到末尾）
      }
      else throw new NovelyError("ARG_REQUIRED", { context: { field: "all|chapter|from" } });
      break;
    case "aggregate":
      if (!b?.project) throw new NovelyError("ARG_REQUIRED", { context: { field: "project" } });
      a.push(b.project);
      if (b.full) a.push("--full");
      if (b.finalizeOnly) a.push("--finalize-only");
      break;
    case "fix":
      if (!b?.project) throw new NovelyError("ARG_REQUIRED", { context: { field: "project" } });
      a.push(b.project);
      if (b.aggregates) { a.push("--aggregates"); if (b.dryRun) a.push("--dry-run"); }
      else if (b.chapter) { a.push(String(b.chapter)); if (b.limit) a.push(`--limit=${b.limit}`); if (b.dryRun) a.push("--dry-run"); }
      else throw new NovelyError("ARG_REQUIRED", { context: { field: "chapter|aggregates" } });
      break;
    case "preprocess":
      if (!b?.input) throw new NovelyError("ARG_REQUIRED", { context: { field: "input" } });
      a.push(`--input=${b.input}`);
      if (b.session) a.push(`--session=${b.session}`);
      break;
    case "recall":
      if (!b?.session) throw new NovelyError("ARG_REQUIRED", { context: { field: "session" } });
      a.push(`--session=${b.session}`);
      // 参考源选择：body.projects（数组，多书）或 body.project（单书兼容）→ --project=A,B
      {
        const sel = Array.isArray(b.projects)
          ? b.projects.filter((x) => typeof x === "string" && x.trim())
          : (b.project ? [String(b.project)] : []);
        if (sel.length) a.push(`--project=${sel.join(",")}`);
      }
      if (b.topk) a.push(`--topk=${b.topk}`);
      break;
    case "writedraft":
      if (!b?.session) throw new NovelyError("ARG_REQUIRED", { context: { field: "session" } });
      a.push(`--session=${b.session}`);
      // 参考源选择与 recall 一致（writedraft 消费 recalls.json，参数仅记录）
      {
        const sel = Array.isArray(b.projects)
          ? b.projects.filter((x) => typeof x === "string" && x.trim())
          : (b.project ? [String(b.project)] : []);
        if (sel.length) a.push(`--project=${sel.join(",")}`);
      }
      break;
  }
  return a;
}

/* ================= 任务停止（kill） =================
 * 注意：当前实现只改状态字段，不真杀子进程——已知问题，见 task/ISSUES.md P0-1。
 */
export function killTask(id) {
  // 内存任务（真子进程）；磁盘遗留 running 任务（服务器重启后僵尸态）也一并标记 killed
  const t = taskState.get(id) ?? listTasks().find((x) => x.id === id);
  if (t && t.status === "running") { t.status = "killed"; t.finishedAt = new Date().toISOString(); persistTask(t); }
  return { ok: true };
}

/** 是否有任务正在运行（内存态；含 SEA 子进程）——心跳保护用 */
export function hasRunningTask() {
  for (const t of taskState.values()) {
    if (t.status === "running") return true;
  }
  return false;
}

/** 最近任务结束时刻（心跳宽限期用；由 startTask 的 close/error 回调维护） */
export let taskFinishedAt = null;

/** 启动清理：僵尸任务标记 + stale 任务记录删除（server main 启动时调用一次） */
export function cleanupOnStart() {
  // 启动时清理僵尸任务：磁盘遗留的 running 任务 = 上一次 server 已退出、子进程已终止
  //（本进程新起，无任何子进程存活）→ 标记 killed，避免前端任务栏永久「进行中」
  let cleaned = 0;
  for (const t of listTasks()) {
    if (t.status === "running") {
      t.status = "killed";
      t.finishedAt = new Date().toISOString();
      t.error = t.error ?? "服务器重启，任务进程已终止";
      persistTask(t);
      cleaned++;
    }
  }
  if (cleaned) console.log(`[server] 清理 ${cleaned} 个僵尸任务（上次服务器退出遗留，已标记 killed）`);
  // 启动时清理 stale 任务记录：failed/killed 的建库任务若使命已完成（范围缺章已补齐）
  // → 任务记录 + 日志一并删除，防 store/_tasks 无限堆积（前端也不显示已补齐卡）
  let purged = 0;
  const tdir = path.join(storeDir, "_tasks");
  for (const t of listTasks()) {
    if (!(t.status === "failed" || t.status === "killed") || t.script !== "novelread/host-exec.mjs") continue;
    try {
      const st = annotateRangeState(t.args ?? []);
      if (st?.reason) { // 无缺章 = 已补齐
        fs.rmSync(path.join(tdir, `${t.id}.json`), { force: true });
        fs.rmSync(path.join(tdir, "log", `${t.id}.log`), { force: true });
        purged++;
      }
    } catch { /* 单任务判断失败跳过（不误删） */ }
  }
  if (purged) console.log(`[server] 清理 ${purged} 个 stale 任务记录（failed/killed 且缺章已补齐，已删除）`);
}
