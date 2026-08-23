#!/usr/bin/env node
/**
 * task/manager.mjs — 任务管理器（生命周期 / 进度 / 队列 / 重跑 / stale / 清理）
 *
 * P0/P1 修复版（2026-08-23）：
 *   P0-1 kill 真杀：taskState 存 {t, child, killed}；kill 调 child.kill()；close 防覆盖
 *   P0-3 状态机：status 增加 queued；结束生成 summary（部分成功可表达）；error 结构化
 *   P1-1 注册表：startTask(kind, body) 查 task/registry.mjs，类型单一事实源
 *   P1-2 并发队列：并发域（build 串行 / writing 串行，跨域并行）
 *   P1-3 IO：progress 写盘节流（≥500ms 合并一次）；日志追加优化在 shared/tasks.mjs
 *   进度协议：业务脚本输出 [task] {stage,done,total,phase,error} JSON 行 → 统一解析
 *
 * 遗留（未修，见 task/ISSUES.md）：P2 重启恢复 / API 分页增量 / 前端轮询放大。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CODE_ROOT, DATA_ROOT, storeDir, corpusDir, projectRoot, DOMAIN, isSeaRuntime, runScriptArgs } from "../shared/paths.mjs";
import { NovelyError } from "../shared/errors.mjs";
import { persistTask, appendTaskLog, loadTaskLog, listTasks as listTasksFromDisk } from "../shared/tasks.mjs";
import { TASK_KINDS, kindOfScript } from "./registry.mjs";

const NODE = process.execPath;

/* ================= 任务状态（内存） =================
 * taskState: id → { t, child, killed }
 *   t     任务对象（含 progress/phase/stage/summary/error 等结构化字段）
 *   child 子进程句柄（kill 真杀用；排队中为 null）
 *   killed 用户主动停止标志（close 回调据此不覆盖状态）
 */
const taskState = new Map();

/** 并发域队列：queueName → taskId[]（队头 running，其余 queued） */
const queues = { build: [], writing: [] };

/** 最近任务结束时刻（心跳宽限期用） */
export let taskFinishedAt = null;

/* ================= [task] 进度协议解析（统一解析器，服务所有任务类型） =================
 * 业务脚本阶段变化时输出一行：console.log(`[task] ${JSON.stringify({...})}`)
 *   { stage: "sentence|shots|derive|aggregate|vector|done", done?, total?, phase?, error? }
 * 普通日志照旧进日志文件；[task] 行同时进日志（留痕）但不作为显示文本。
 */
function parseTaskLine(line, t) {
  const m = line.match(/^\[task\]\s+(.*)$/);
  if (!m) return;
  try {
    const d = JSON.parse(m[1]);
    if (!d || typeof d !== "object") return;
    if (typeof d.stage === "string") t.stage = d.stage;
    if (typeof d.phase === "string") t.phase = d.phase;
    if (d.done != null || d.total != null) {
      t.progress = t.progress ?? {};
      if (d.done != null) t.progress.done = Number(d.done);
      if (d.total != null) t.progress.total = Number(d.total);
    }
    if (d.error) t.error = typeof d.error === "string" ? { message: d.error } : d.error;
    if (d.summary) t.summary = d.summary;
  } catch { /* 协议行解析失败忽略（普通日志行误匹配不致命） */ }
}

/* ================= 启动 / 队列 ================= */

/**
 * 启动任务（注册表驱动）：(kind, body)
 * @returns {{taskId:string, queued:boolean, position:number}}
 */
export function startTask(kind, body) {
  const reg = TASK_KINDS[kind];
  if (!reg) throw new NovelyError("ARG_INVALID", { context: { field: "kind", value: kind } });
  const args = reg.argsOf(body ?? {});
  const id = `${kind}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const t = {
    id, kind, script: reg.script, args, label: kind,
    name: reg.name(body ?? {}),
    status: "queued",           // 默认排队；队列空时立即转 running
    startedAt: new Date().toISOString(), finishedAt: null, code: null,
    stage: null, phase: null, progress: null, summary: null, error: null,
  };
  taskState.set(id, { t, child: null, killed: false });
  persistTask(t);
  const queue = queues[reg.queue];
  queue.push(id);
  pumpQueue(reg.queue);
  return { taskId: id, queued: t.status === "queued", position: queue.length };
}

/** 唤醒队列：域内无 running 且队头等待 → spawn */
function pumpQueue(queueName) {
  const queue = queues[queueName];
  if (!queue?.length) return;
  if (queue.some((id) => taskState.get(id)?.t.status === "running")) return;
  const nextId = queue.find((id) => taskState.get(id)?.t.status === "queued");
  if (!nextId) return;
  const rec = taskState.get(nextId);
  rec.t.status = "running";
  persistTask(rec.t);
  spawnTask(nextId);
}

/** 真正 spawn 子进程（仅 running 状态调用） */
function spawnTask(id) {
  const rec = taskState.get(id);
  const { t } = rec;
  // SEA 单文件：无真实子进程脚本 → spawn exe 自身（sea-main 按 NOVELYWRITE_RUN 环境变量分发）
  const cwd = isSeaRuntime ? DATA_ROOT : CODE_ROOT;
  const [cmd, cmdArgs, cmdEnv] = runScriptArgs(t.script, t.args);
  const child = isSeaRuntime
    ? spawn(cmd, cmdArgs, { cwd, env: cmdEnv })
    : spawn(NODE, [path.join(CODE_ROOT, t.script), ...t.args], { cwd: CODE_ROOT, env: process.env });
  rec.child = child;
  rec.killed = false;
  // 日志流 → 独立 log 文件夹 + [task] 协议解析
  let buf = "";
  const push = (chunk) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    const clean = lines.filter((l) => l.trim());
    if (!clean.length) return;
    appendTaskLog(t.id, clean);
    let dirty = false;
    for (const l of clean) {
      const before = JSON.stringify(t.progress ?? null) + t.stage + t.phase;
      parseTaskLine(l, t);
      if (JSON.stringify(t.progress ?? null) + t.stage + t.phase !== before) dirty = true;
    }
    // progress 写盘节流：有变化才写，且 ≥500ms 合并（防高频小写）
    if (dirty) {
      const now = Date.now();
      if (!rec._lastPersist || now - rec._lastPersist >= 500) {
        rec._lastPersist = now;
        persistTask(t);
      }
    }
  };
  child.stdout.on("data", push);
  child.stderr.on("data", push);
  child.on("error", (err) => {
    t.status = "failed"; t.finishedAt = new Date().toISOString(); t.code = -1;
    t.error = { message: err.message }; taskFinishedAt = Date.now();
    persistTask(t);
  });
  child.on("close", (code) => {
    if (rec.killed) {
      t.status = "killed"; // 用户主动停止：close 不覆盖
      t.error = t.error ?? { message: "任务已被用户停止" };
    } else {
      t.status = code === 0 ? "success" : "failed";
      if (code !== 0 && !t.error) {
        // 业务失败无结构化 error → 从日志尾部提取最后错误行兜底（排除 [task] 协议行）
        const tail = loadTaskLog(t.id).slice(-8).filter((l) => !l.startsWith("[task]"));
        const errLine = [...tail].reverse().find((l) => /失败|✗|❌|error|Error|异常|拒绝/i.test(l));
        t.error = errLine ? { message: errLine.slice(0, 160) } : { message: `进程退出码 ${code}` };
      }
    }
    t.finishedAt = new Date().toISOString();
    t.code = code;
    if (!t.kind) t.kind = kindOfScript(t.script) ?? t.kind; // 兜底（旧字段缺失）
    // summary：建库任务由 server 推导（todo − done = missing；成功/失败/部分成功都生成）
    if (t.kind === "annotate" && !t.summary) {
      const st = annotateRangeState(t.args ?? []);
      if (st) t.summary = st.reason
        ? { ok: st.todo.length, failed: [], pending: 0, note: st.reason }
        : { ok: st.todo.length - st.missing.length, failed: st.missing, pending: st.missing.length };
    }
    taskFinishedAt = Date.now();
    persistTask(t);
    taskState.delete(id);
    // 队列：出队 + 唤醒下一个
    const queue = queues[TASK_KINDS[t.kind]?.queue];
    if (queue) { const i = queue.indexOf(id); if (i >= 0) queue.splice(i, 1); }
    pumpQueue(TASK_KINDS[t.kind]?.queue);
  });
  persistTask(t);
}

export function listTasks() {
  // 内存态 + 磁盘态合并（磁盘覆盖内存中已结束的，补齐重启前遗留）
  const byId = new Map();
  for (const t of listTasksFromDisk()) byId.set(t.id, t);
  for (const [id, t] of taskState) {
    if (!byId.has(id) || t.status === "running" || t.status === "queued") byId.set(id, t);
  }
  // 兼容层：旧任务（无 kind/name，只有 script/label）按 script 反查注册表补全
  for (const t of byId.values()) {
    if (!t.kind) {
      const k = kindOfScript(t.script);
      if (k) t.kind = k;
    }
    if (!t.name && t.kind) {
      const reg = TASK_KINDS[t.kind];
      try { t.name = reg.name(bodyFromArgs(t.args ?? [])); } catch { /* 生成失败忽略 */ }
    }
    if (t.label && !t.name && t.kind) t.name = t.label; // 兜底
  }
  return [...byId.values()].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
}

/* ================= 停止（kill 真杀） ================= */
export function killTask(id) {
  const rec = taskState.get(id);
  const t = rec ? rec.t : listTasks().find((x) => x.id === id);
  if (!t) return { ok: true }; // 兼容：不存在视为已结束
  if (t.status === "queued") {
    // 排队任务：直接出队标记 killed（无子进程可杀）
    const queue = queues[TASK_KINDS[t.kind]?.queue];
    if (queue) { const i = queue.indexOf(id); if (i >= 0) queue.splice(i, 1); }
    t.status = "killed"; t.finishedAt = new Date().toISOString(); t.error = t.error ?? { message: "排队中已取消" };
    persistTask(t);
    taskState.delete(id);
    pumpQueue(TASK_KINDS[t.kind]?.queue);
    return { ok: true };
  }
  if (t.status === "running" && rec) {
    rec.killed = true; // close 回调据此不覆盖
    t.status = "killed";
    t.finishedAt = new Date().toISOString();
    t.error = t.error ?? { message: "任务已被用户停止" };
    persistTask(t);
    try { rec.child?.kill(); } catch { /* 杀失败不阻塞 */ }
    return { ok: true };
  }
  // 已结束任务：幂等标记
  if (t.status === "running") { t.status = "killed"; t.finishedAt = new Date().toISOString(); persistTask(t); }
  return { ok: true };
}

/* ================= 重跑 / stale（建库智能续跑） ================= */
export function apiTaskRerun(id) {
  const t = listTasks().find((x) => x.id === id);
  if (!t) throw new NovelyError("NOT_FOUND", { context: { id, kind: "task" } });
  if (t.status === "running" || t.status === "queued") throw new NovelyError("ARG_INVALID", { context: { id, rule: "任务仍在运行/排队，不能重跑" } });
  const kind = t.kind ?? kindOfScript(t.script);
  const reg = TASK_KINDS[kind];
  if (!reg) throw new NovelyError("ARG_INVALID", { context: { id, rule: "未知任务类型" } });
  if (reg.rerun === "smart") {
    const smart = smartRerunAnnotate(t.args ?? []);
    if (smart) return smart; // { rerun:true, taskId, mode } | { rerun:false, reason }
  }
  const { taskId } = startTask(kind, bodyFromArgs(t.args ?? [], reg));
  return { rerun: true, taskId, mode: "原参数重跑" };
}

/** CLI 参数反解为 body（原参数重跑用——注册表 argsOf 的逆过程，近似即可） */
function bodyFromArgs(args) {
  const argVal = (n) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : null; };
  const body = {};
  const project = argVal("corpus") ?? args.find((a) => !a.startsWith("--"));
  if (project) body.project = project;
  if (args.includes("--all")) body.all = true;
  if (args.includes("--pending")) body.pending = true;
  const chapter = argVal("chapter");
  if (chapter) body.chapter = chapter;
  const from = argVal("from");
  if (from) { body.from = Number(from); const to = argVal("to"); if (to) body.to = Number(to); }
  const domain = argVal("domain");
  if (domain) body.domain = domain;
  const session = argVal("session");
  if (session) body.session = session;
  const input = argVal("input");
  if (input) body.input = input;
  const projectArg = argVal("project");
  if (projectArg) body.projects = projectArg.split(",");
  const topk = argVal("topk");
  if (topk) body.topk = Number(topk);
  if (args.includes("--full")) body.full = true;
  if (args.includes("--finalize-only")) body.finalizeOnly = true;
  if (args.includes("--aggregates")) body.aggregates = true;
  if (args.includes("--dry-run")) body.dryRun = true;
  const limit = argVal("limit");
  if (limit) body.limit = Number(limit);
  return body;
}

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
  const body = { project: st.corpus, domain: st.domain, chapter: st.missing.join(",") };
  const { taskId } = startTask("annotate", body);
  return { rerun: true, taskId, mode: `智能续跑：补 ${st.missing.length} 章（${st.missing.join(",")}）`, missing: st.missing };
}

/** 任务是否"使命已完成"（failed/killed 卡降级用）：范围 todo − done 为空 → stale=true 已补齐 */
export function apiTaskStale(id) {
  const t = listTasks().find((x) => x.id === id);
  if (!t) throw new NovelyError("NOT_FOUND", { context: { id, kind: "task" } });
  if ((t.kind ?? kindOfScript(t.script)) !== "annotate") return { stale: false, reason: "仅建库任务可判断" };
  const st = annotateRangeState(t.args ?? []);
  if (!st) return { stale: false, reason: "无法推导任务范围（清单缺失）" };
  if (st.reason) return { stale: true, reason: st.reason, done: st.todo.length };
  return { stale: false, reason: `缺 ${st.missing.length} 章（${st.missing.slice(0, 10).join(",")}${st.missing.length > 10 ? "…" : ""}）`, missing: st.missing };
}

/** 是否有任务正在运行/排队（内存态）——心跳保护用 */
export function hasRunningTask() {
  for (const [id, rec] of taskState) {
    if (rec.t.status === "running" || rec.t.status === "queued") return true;
  }
  return false;
}

/** 启动清理：僵尸任务标记 + stale 任务记录删除（server main 启动时调用一次） */
export function cleanupOnStart() {
  // 启动时清理僵尸任务：磁盘遗留的 running/queued 任务 = 上一次 server 已退出、子进程已终止
  let cleaned = 0;
  for (const t of listTasks()) {
    if (t.status === "running" || t.status === "queued") {
      t.status = "killed";
      t.finishedAt = new Date().toISOString();
      t.error = t.error ?? { message: "服务器重启，任务进程已终止" };
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
    if (!(t.status === "failed" || t.status === "killed") || (t.kind ?? kindOfScript(t.script)) !== "annotate") continue;
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
