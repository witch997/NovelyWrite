#!/usr/bin/env node
/**
 * cli.mjs — NovelyWrite 统一入口（根目录）
 *
 * 覆盖全部用户操作：建库（语料处理/标注/聚合/校验/修复）+ 功能层（报告/分镜写作）。
 * 用法：
 *   node cli.mjs <task> [--参数...]        显式命令（确定性强）
 *   node cli.mjs "自然语言指令"             意图识别（关键词匹配，随功能扩展）
 *
 * 当前任务：
 *   kb / "建立知识库" | "建库" | "知识库" | "扫描语料"
 *       → 扫描 corpus/ 语料 vs store/ 头文档（project-meta.json）对比，回传未建库语料
 *   annotate（标注，事实层）→ novelread/host-exec.mjs
 *   aggregate（聚合，阶段二）→ novelread/aggregates.mjs（默认增量，--full 逃生门）
 *   check（校验）→ novelread/verify-json + check-chapter + aggregates --finalize-only
 *   fix（修复）→ novelread/fix.mjs（章级 / --aggregates 聚合层）
 *
 * 规划任务（后续接入）：
 *   report（拆书报告） / write-shot（分镜参考写作）
 *
 * 打包：本文件即未来打包入口骨架（bin 包装），任务逻辑模块化可复用。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { CODE_ROOT, DATA_ROOT, corpusDir, storeDir } from "./shared/paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;

/** 调用 novelread 模块（透传参数，打印输出） */
function runModule(module, args) {
  const p = path.join(CODE_ROOT, "novelread", module);
  console.log(`\n[cli] node novelread/${module} ${args.join(" ")}`);
  try {
    const out = execFileSync(NODE, [p, ...args], { encoding: "utf-8" });
    console.log(out);
    return true;
  } catch (e) {
    console.log((e.stdout ?? "").toString());
    console.error((e.stderr ?? "").toString().trim() || `[cli] ${module} 退出码 ${e.status}`);
    return false;
  }
}

/* ================= 意图识别（关键词匹配，随功能扩展） ================= */

const INTENT_RULES = [
  { task: "kb", pattern: /建立知识库|建库|知识库|扫描语料|看.*语料.*(库|建)/ },
  { task: "annotate", pattern: /标注|标.*章|注解|annotate/i },
  { task: "aggregate", pattern: /聚合|重算|重跑.*聚合|aggregate/i },
  { task: "check", pattern: /校验|检查|查错|体检|验证|check/i },
  { task: "fix", pattern: /修复|改错|修正|修.*章|fix/i },
];

function detectIntent(input) {
  for (const r of INTENT_RULES) {
    if (r.pattern.test(input)) return r.task;
  }
  return null;
}

/* ================= 任务：kb（建立知识库） ================= */

/**
 * 扫描 corpus/ 语料 vs store/ 头文档，对比建库状态。
 * 已建库：corpus 有 <名>-语料.txt 且 store 有 <名>project/（尽量读 project-meta 显示进度）
 * 未建库：corpus 有语料但 store 无对应 project
 */
function kbStatus() {
  const corpusFiles = fs.existsSync(corpusDir)
    ? fs.readdirSync(corpusDir).filter((f) => f.endsWith("-语料.txt"))
    : [];
  const storeProjects = fs.existsSync(storeDir)
    ? fs.readdirSync(storeDir, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.endsWith("project")).map((e) => e.name)
    : [];

  const built = [];
  const unbuilt = [];
  for (const cf of corpusFiles) {
    const name = cf.replace("-语料.txt", "");
    const projectDir = path.join(storeDir, `${name}project`);
    if (fs.existsSync(projectDir)) {
      // 已建库：读 project-meta.json 显示进度（缺则标记"目录存在无头文档"）
      const metaPath = path.join(projectDir, "project-meta.json");
      if (fs.existsSync(metaPath)) {
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
          const c = meta.counts ?? {};
          built.push({
            name,
            annotated: c.chaptersAnnotated ?? "?",
            total: c.chaptersTotal ?? "?",
            missing: (c.missingChapters ?? []).length,
            verifiedAt: meta.verify?.verifiedAt ?? null,
          });
        } catch {
          built.push({ name, annotated: "?", total: "?", missing: "?", note: "project-meta 解析失败" });
        }
      } else {
        built.push({ name, annotated: "?", total: "?", missing: "?", note: "目录存在但无 project-meta.json（未终检）" });
      }
    } else {
      unbuilt.push(name);
    }
  }
  return { corpusCount: corpusFiles.length, storeCount: storeProjects.length, built, unbuilt };
}

function runKb() {
  const s = kbStatus();
  console.log("\n========== 知识库状态 ==========");
  console.log(`语料：${s.corpusCount} 个（corpus/*-语料.txt）| store 项目：${s.storeCount} 个（*project/）\n`);

  if (s.built.length) {
    console.log("【已建库】");
    for (const b of s.built) {
      const progress = typeof b.annotated === "number" ? `${b.annotated}/${b.total} 章（缺 ${b.missing}）` : `${b.annotated ?? "?"}`;
      console.log(`  ✓ ${b.name}：${progress}${b.note ? `（${b.note}）` : ""}`);
    }
  } else {
    console.log("【已建库】无");
  }

  console.log("");
  if (s.unbuilt.length) {
    console.log("【未建库语料】（corpus 有语料，store 无对应 project）");
    for (const n of s.unbuilt) {
      console.log(`  ✗ ${n} —— 可执行建库：node cli.mjs annotate --corpus=${n} --all`);
    }
    console.log(`\n共 ${s.unbuilt.length} 个未建库语料。`);
  } else {
    console.log("【未建库语料】无——所有 corpus 语料均已建库。");
  }
  console.log("\n提示：已建库但标注未完成的，可增量补跑（annotate --corpus=<名> --chapter=<缺章>）。");
}

/* ================= 参数解析 ================= */

/** 解析参数：位置参数（非 --）+ 选项（--key=value / --key value / --flag） */
function parseArgs(args) {
  const positional = [];
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        options[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (i + 1 < args.length && !args[i + 1].startsWith("--")) {
        options[a.slice(2)] = args[++i];
      } else {
        options[a.slice(2)] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, options };
}

/* ================= 任务：check（校验） ================= */

/**
 * 校验任务：
 *   node cli.mjs check <project>           → 全量校验（语法 + 契约 + 终检刷新头文档）
 *   node cli.mjs check <project> <章号>    → 单章校验
 *   node cli.mjs check <project> --syntax-only → 只语法门
 */
function runCheck(args) {
  const { positional, options } = parseArgs(args);
  const project = positional[0];
  const chapter = positional[1] ?? options.chapter ?? null;
  const syntaxOnly = !!options["syntax-only"];

  if (!project) {
    console.error("[cli] check 需要 project：check <project> [章号] [--syntax-only]");
    return false;
  }
  const projectDir = path.join(storeDir, `${project}project`);
  if (!fs.existsSync(projectDir)) {
    console.error(`[cli] project 不存在: ${project}project（store/ 下无此目录）`);
    return false;
  }

  if (chapter) {
    return runModule("check-chapter.mjs", [project, String(chapter)]);
  }
  let ok = runModule("verify-json.mjs", [project, "--list"]);
  if (!syntaxOnly) {
    ok = runModule("check-chapter.mjs", [project, "--all"]) && ok;
    ok = runModule("aggregates.mjs", [project, "--finalize-only"]) && ok;
  }
  return ok;
}

/* ================= 任务：annotate（标注，事实层） ================= */

/**
 * 标注任务（事实层两往返）：
 *   node cli.mjs annotate <project> --all           → 全章标注
 *   node cli.mjs annotate <project> --chapter=3      → 指定章（可逗号分隔多章）
 *   node cli.mjs annotate <project> --chapter=3,4,5
 */
function runAnnotate(args) {
  const { positional, options } = parseArgs(args);
  const project = positional[0];
  const all = !!options.all;
  const chapter = options.chapter ?? null;

  if (!project) {
    console.error("[cli] annotate 需要 project：annotate <project> --all | annotate <project> --chapter=N[,M...]");
    return false;
  }
  if (!all && !chapter) {
    console.error("[cli] annotate 需指定 --all 或 --chapter=N（annotate 是 LLM 标注，必须明确范围）");
    return false;
  }

  const moduleArgs = ["--corpus=" + project];
  if (all) moduleArgs.push("--all");
  else for (const n of chapter.split(",")) moduleArgs.push("--chapter=" + n.trim());
  return runModule("host-exec.mjs", moduleArgs);
}

/* ================= 任务：aggregate（聚合，阶段二） ================= */

/**
 * 聚合任务（阶段二：确定性重算 + 语义判定 + 终检 + 索引）：
 *   node cli.mjs aggregate <project>                → 默认增量（有快照时）或全量（首次）
 *   node cli.mjs aggregate <project> --full         → 强制全量（逃生门）
 *   node cli.mjs aggregate <project> --finalize-only → 只终检
 */
function runAggregate(args) {
  const { positional, options } = parseArgs(args);
  const project = positional[0];
  if (!project) {
    console.error("[cli] aggregate 需要 project：aggregate <project> [--full] [--finalize-only]");
    return false;
  }
  const projectDir = path.join(storeDir, `${project}project`);
  if (!fs.existsSync(projectDir)) {
    console.error(`[cli] project 不存在: ${project}project`);
    return false;
  }

  const aggArgs = [project];
  if (options.full) aggArgs.push("--full");
  if (options["finalize-only"]) aggArgs.push("--finalize-only");
  return runModule("aggregates.mjs", aggArgs);
}

/* ================= 任务：fix（修复） ================= */

/**
 * 修复任务（用户主动发起）：
 *   node cli.mjs fix <project> <章号> [--limit=N] [--dry-run]
 *   node cli.mjs fix <project> --aggregates [--dry-run]
 */
function runFix(args) {
  const { positional, options } = parseArgs(args);
  const project = positional[0];
  const chapter = positional[1] ?? options.chapter ?? null;
  const aggregates = !!options.aggregates;
  const dryRun = !!options["dry-run"];

  if (!project) {
    console.error("[cli] fix 需要 project：fix <project> <章号> | fix <project> --aggregates [--dry-run]");
    return false;
  }
  const projectDir = path.join(storeDir, `${project}project`);
  if (!fs.existsSync(projectDir)) {
    console.error(`[cli] project 不存在: ${project}project`);
    return false;
  }

  const fixArgs = [];
  if (aggregates) {
    fixArgs.push(project, "--aggregates");
    if (dryRun) fixArgs.push("--dry-run");
  } else if (chapter) {
    fixArgs.push(project, String(chapter));
    if (options.limit) fixArgs.push(`--limit=${options.limit}`);
    if (dryRun) fixArgs.push("--dry-run");
  } else {
    console.error("[cli] fix 需要章号或 --aggregates：fix <project> <章号> | fix <project> --aggregates [--dry-run]");
    return false;
  }
  return runModule("fix.mjs", fixArgs);
}

/* ================= 任务路由 ================= */

const TASK_HELP = {
  kb: "扫描语料 vs store 头文档，对比建库状态",
  annotate: "标注：annotate <project> --all | --chapter=N[,M...]",
  aggregate: "聚合：aggregate <project> [--full] [--finalize-only]",
  check: "校验：check [project] [--chapter=N] [--syntax-only]",
  fix: "修复：fix <project> <章号> | fix <project> --aggregates [--dry-run]",
};

function printUsage() {
  console.log(`
NovelyWrite 统一 CLI
用法：
  node cli.mjs <task> [--参数...]        显式命令
  node cli.mjs "自然语言指令"             意图识别（当前支持：建立知识库/标注/聚合/校验/修复）

任务：
  kb        ${TASK_HELP.kb}
  annotate  ${TASK_HELP.annotate}
  aggregate ${TASK_HELP.aggregate}
  check     ${TASK_HELP.check}
  fix       ${TASK_HELP.fix}

示例：
  node cli.mjs kb
  node cli.mjs "建立知识库"
  node cli.mjs annotate 红楼梦 --all
  node cli.mjs annotate 大王饶命 --chapter=88,89,90
  node cli.mjs aggregate 红楼梦
  node cli.mjs aggregate 红楼梦 --full
  node cli.mjs check 红楼梦
  node cli.mjs check 红楼梦 --chapter=1
  node cli.mjs check 红楼梦 --syntax-only
  node cli.mjs fix 红楼梦 83
  node cli.mjs fix 红楼梦 --aggregates --dry-run
`);
}

function dispatch(task, args) {
  switch (task) {
    case "kb":
      runKb();
      return true;
    case "annotate":
      return runAnnotate(args);
    case "aggregate":
      return runAggregate(args);
    case "check":
      return runCheck(args);
    case "fix":
      return runFix(args);
    default:
      console.error(`未知任务: ${task}`);
      printUsage();
      return false;
  }
}

/* ================= main ================= */

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length) { printUsage(); process.exit(1); }

  const first = argv[0];
  // 显式 task（非 -- 开头，且是已知任务）
  const knownTasks = ["kb", "annotate", "aggregate", "check", "fix"];
  if (knownTasks.includes(first)) {
    dispatch(first, argv.slice(1));
    process.exit(0);
  }

  // 自然语言 → 意图识别
  const input = argv.join(" ");
  const task = detectIntent(input);
  if (task) {
    console.log(`[意图识别] "${input}" → 任务 ${task}`);
    dispatch(task, []);
    process.exit(0);
  }

  // 未知
  console.error(`无法识别指令: "${input}"`);
  printUsage();
  process.exit(1);
}

main();
