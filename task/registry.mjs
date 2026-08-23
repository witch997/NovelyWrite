#!/usr/bin/env node
/**
 * task/registry.mjs — 任务类型注册表（单一事实源）
 *
 * 消灭任务类型字符串魔法：脚本路径 / 展示名 / 并发域 / 进度语义 / 重跑策略 / 参数装配
 * 全部集中在此。加新任务类型 = 加一条注册，无需改动 server 路由、前端、管理器。
 */
import { DOMAIN } from "../shared/paths.mjs";
import { NovelyError } from "../shared/errors.mjs";

/** 书名显示归一（corpus 名可能自带《》→ 去外层重复包裹，统一显示《X》） */
const book = (name) => {
  const clean = (name ?? "").replace(/^《|》$/g, "").trim();
  return clean ? `《${clean}》` : "";
};

/** 任务参数装配（前端 body → 脚本 CLI 参数）——原 taskArgsFor 各分支原样搬入 */
function argsOfAnnotate(b) {
  const a = [];
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
  return a;
}

function argsOfAggregate(b) {
  const a = [];
  if (!b?.project) throw new NovelyError("ARG_REQUIRED", { context: { field: "project" } });
  a.push(b.project);
  if (b.full) a.push("--full");
  if (b.finalizeOnly) a.push("--finalize-only");
  return a;
}

function argsOfFix(b) {
  const a = [];
  if (!b?.project) throw new NovelyError("ARG_REQUIRED", { context: { field: "project" } });
  a.push(b.project);
  if (b.aggregates) { a.push("--aggregates"); if (b.dryRun) a.push("--dry-run"); }
  else if (b.chapter) { a.push(String(b.chapter)); if (b.limit) a.push(`--limit=${b.limit}`); if (b.dryRun) a.push("--dry-run"); }
  else throw new NovelyError("ARG_REQUIRED", { context: { field: "chapter|aggregates" } });
  return a;
}

function argsOfPreprocess(b) {
  const a = [];
  if (!b?.input) throw new NovelyError("ARG_REQUIRED", { context: { field: "input" } });
  a.push(`--input=${b.input}`);
  if (b.session) a.push(`--session=${b.session}`);
  return a;
}

/** 参考源选择：body.projects（数组，多书）或 body.project（单书兼容）→ --project=A,B */
function selProjects(b) {
  const sel = Array.isArray(b.projects)
    ? b.projects.filter((x) => typeof x === "string" && x.trim())
    : (b.project ? [String(b.project)] : []);
  return sel.length ? [`--project=${sel.join(",")}`] : [];
}

function argsOfRecall(b) {
  const a = [];
  if (!b?.session) throw new NovelyError("ARG_REQUIRED", { context: { field: "session" } });
  a.push(`--session=${b.session}`);
  a.push(...selProjects(b));
  if (b.topk) a.push(`--topk=${b.topk}`);
  return a;
}

function argsOfWritedraft(b) {
  const a = [];
  if (!b?.session) throw new NovelyError("ARG_REQUIRED", { context: { field: "session" } });
  a.push(`--session=${b.session}`);
  a.push(...selProjects(b)); // 消费 recalls.json，参数仅记录
  return a;
}

/**
 * 任务类型注册表
 * @type {Object<string, {
 *   script: string,            // 子进程脚本（相对 CODE_ROOT）
 *   name: (body)=>string,      // 展示名（server 生成，前端直接显示）
 *   queue: "build"|"writing",  // 并发域：同域串行，跨域并行
 *   progress: "chapter"|"stage", // 进度语义（前端渲染参考，实际以 progress 字段为准）
 *   rerun: "smart"|"plain",    // 重跑策略（smart=建库智能续跑；plain=原参数重跑）
 *   argsOf: (body)=>string[],  // 前端 body → CLI 参数
 * }>}
 */
export const TASK_KINDS = {
  annotate: {
    script: "novelread/host-exec.mjs",
    name: (b) => `📚 建库${book(b?.project)}`,
    queue: "build",
    progress: "chapter",
    rerun: "smart",
    argsOf: argsOfAnnotate,
  },
  aggregate: {
    script: "novelread/aggregates.mjs",
    name: (b) => `🧩 聚合${book(b?.project)}`,
    queue: "build",
    progress: "stage",
    rerun: "plain",
    argsOf: argsOfAggregate,
  },
  fix: {
    script: "novelread/fix.mjs",
    name: (b) => `🔧 修复${book(b?.project)}`,
    queue: "build",
    progress: "stage",
    rerun: "plain",
    argsOf: argsOfFix,
  },
  preprocess: {
    script: "features/shot-writing/preprocess.mjs",
    name: () => "🎬 分镜",
    queue: "writing",
    progress: "stage",
    rerun: "plain",
    argsOf: argsOfPreprocess,
  },
  recall: {
    script: "features/shot-writing/recall.mjs",
    name: () => "🔍 召回",
    queue: "writing",
    progress: "stage",
    rerun: "plain",
    argsOf: argsOfRecall,
  },
  writedraft: {
    script: "features/shot-writing/writedraft.mjs",
    name: () => "✍️ 成稿",
    queue: "writing",
    progress: "stage",
    rerun: "plain",
    argsOf: argsOfWritedraft,
  },
};

/** 按脚本路径反查 kind（旧任务磁盘数据只有 script，无 kind —— 兼容层用） */
export function kindOfScript(script) {
  for (const [kind, reg] of Object.entries(TASK_KINDS)) {
    if (reg.script === script) return kind;
  }
  return null;
}
