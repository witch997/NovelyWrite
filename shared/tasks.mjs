#!/usr/bin/env node
/**
 * tasks.mjs — 任务状态查询器（长任务状态持久化 + 查询）
 *
 * 职责：
 *   - 任务状态落盘：server.mjs 启动长任务时调用 persistTask()，状态写 store/_tasks/<id>.json
 *   - 任务日志落盘：独立 log 文件夹 store/_tasks/log/<id>.log（状态文件只存元信息，日志分离）
 *   - 查询：从磁盘读任务状态/日志，支持 CLI 独立查询与 server API 复用
 *
 * 目录结构：
 *   store/_tasks/
 *   ├── <id>.json        # 任务状态（元信息：status/args/code/时间戳）
 *   └── log/<id>.log     # 任务日志（独立文件，append 追加，截断 LOG_KEEP 行）
 *
 * 用法（CLI 查询）：
 *   node shared/tasks.mjs list              # 列出全部任务（按时间倒序）
 *   node shared/tasks.mjs <taskId>          # 查单个任务状态
 *   node shared/tasks.mjs <taskId> --log    # 查单个任务 + 日志尾部
 *
 * 用法（模块复用，供 server.mjs）：
 *   import { TASKS_DIR, persistTask, appendTaskLog, listTasks, loadTask, loadTaskLog } from "./shared/tasks.mjs";
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { storeDir } from "./paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 任务状态目录（store/_tasks，与 server.mjs 共用） */
export const TASKS_DIR = path.join(storeDir, "_tasks");

/** 任务日志目录（独立 log 文件夹：store/_tasks/log/） */
export const LOGS_DIR = path.join(TASKS_DIR, "log");

/** 单任务状态文件路径 */
export function taskPath(id) {
  return path.join(TASKS_DIR, `${id}.json`);
}

/** 单任务日志文件路径（store/_tasks/log/<id>.log） */
export function taskLogPath(id) {
  return path.join(LOGS_DIR, `${id}.log`);
}

/** 日志保留行数（落盘截断，防无限膨胀） */
export const LOG_KEEP = 500;

/**
 * 持久化任务状态到磁盘（只存元信息，日志分离到 log/ 文件夹；原子写：tmp + rename）
 * @param {object} t 任务对象 {id, label, script, args, status, startedAt, finishedAt, code, error?}
 */
export function persistTask(t) {
  try {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
    const payload = {
      id: t.id,
      kind: t.kind ?? null,       // 任务类型（注册表 kind；旧任务为 null，读取时按 script 反查）
      label: t.label,
      name: t.name ?? null,       // 展示名（server 注册表生成）
      script: t.script,
      args: t.args ?? [],
      status: t.status,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      code: t.code,
      error: t.error ?? null,
      progress: t.progress ?? null, // 实时进度（done/total/stage/currentChapter，覆盖写不累积）
      phase: t.phase ?? null,       // 当前阶段描述（[task] 协议）
      summary: t.summary ?? null,   // 结束摘要（部分成功可表达）
      logFile: `log/${t.id}.log`, // 日志位置引用（独立 log 文件夹）
    };
    const tmp = `${taskPath(t.id)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
    fs.renameSync(tmp, taskPath(t.id));
  } catch { /* 状态文件写失败不阻塞主流程 */ }
}

/**
 * 追加日志行到独立 log 文件夹（<id>.log；追加模式，超阈值才惰性截断）
 * 优化（P1-3）：不再每批读全量→过滤→重写；改为纯 append，仅在文件过大时截断一次。
 */
export function appendTaskLog(id, lines) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const p = taskLogPath(id);
    if (!lines.length) return;
    const text = lines.join("\n") + "\n";
    if (!fs.existsSync(p)) {
      fs.writeFileSync(p, text, "utf-8");
      return;
    }
    // 追加（append 模式，无读全量重写）
    fs.appendFileSync(p, text, "utf-8");
    // 惰性截断：文件超 256KB 才读全量截尾（低频，避免每批 O(n)）
    if (fs.statSync(p).size > 256 * 1024) {
      const existing = fs.readFileSync(p, "utf-8").split("\n");
      if (existing.length > LOG_KEEP * 2) {
        const trimmed = existing.filter((l) => l.trim() !== "").slice(-LOG_KEEP);
        fs.writeFileSync(p, trimmed.join("\n") + "\n", "utf-8");
      }
    }
  } catch { /* 日志写失败不阻塞主流程 */ }
}

/** 读单个任务状态（磁盘；不存在返回 null） */
export function loadTask(id) {
  const p = taskPath(id);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

/**
 * 读任务日志（独立 log 文件夹；返回行数组；无日志返回 []）
 * @param {string} id 任务 id
 * @returns {string[]}
 */
export function loadTaskLog(id) {
  const p = taskLogPath(id);
  if (!fs.existsSync(p)) return [];
  try { return fs.readFileSync(p, "utf-8").split("\n").filter((l) => l.trim()); } catch { return []; }
}

/**
 * 列出全部任务（磁盘，按 startedAt 倒序）
 * @returns {object[]} 任务对象数组
 */
export function listTasks() {
  if (!fs.existsSync(TASKS_DIR)) return [];
  const out = [];
  for (const f of fs.readdirSync(TASKS_DIR).filter((x) => x.endsWith(".json") && !x.endsWith(".tmp"))) {
    const d = loadTask(f.replace(/\.json$/, ""));
    if (d) out.push(d);
  }
  return out.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
}

/* ================= CLI 查询入口 ================= */

function fmtStatus(t) {
  const icon = t.status === "success" ? "✅" : t.status === "running" ? "🔄" : t.status === "killed" ? "⏹" : "❌";
  const dur = t.startedAt && t.finishedAt ? ` ${((new Date(t.finishedAt) - new Date(t.startedAt)) / 1000).toFixed(1)}s` : "";
  return `${icon} ${t.id}  [${t.label}] ${t.status}${dur}${t.code !== null ? ` (code=${t.code})` : ""}`;
}

function main() {
  const args = process.argv.slice(2);
  const arg0 = args[0];

  if (!arg0 || arg0 === "list" || arg0 === "ls") {
    const tasks = listTasks();
    console.log(`\n========== 任务列表（${tasks.length} 个，store/_tasks/） ==========\n`);
    if (!tasks.length) { console.log("无任务记录。"); return; }
    for (const t of tasks) console.log(fmtStatus(t));
    console.log(`\n查询详情: node shared/tasks.mjs <taskId>\n`);
    return;
  }

  // 单个任务
  const id = arg0;
  const wantLog = args.includes("--log") || args.includes("-l");
  const t = loadTask(id);
  if (!t) { console.error(`任务不存在: ${id}（store/_tasks/ 下无此记录）`); process.exit(1); }

  console.log(`\n========== 任务 ${id} ==========`);
  console.log(`  状态:   ${fmtStatus(t)}`);
  console.log(`  脚本:   ${t.script}`);
  console.log(`  参数:   ${(t.args ?? []).join(" ") || "(无)"}`);
  if (t.error) console.log(`  错误:   ${t.error}`);
  const logLines = loadTaskLog(id);
  if (wantLog) {
    console.log(`\n---------- 日志（store/_tasks/log/${id}.log，${logLines.length} 行） ----------`);
    for (const l of logLines) console.log("  " + l);
  } else {
    console.log(`\n  日志: ${logLines.length} 行（加 --log 查看，文件 store/_tasks/log/${id}.log）`);
  }
  console.log("");
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith(".mjs") && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
