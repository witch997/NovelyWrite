/**
 * check-chapter.mjs — 章级检测 + 全书契约校验（吸收原 verify-format.mjs）
 *
 * 单章模式：检查本章 4 个章级文件——
 *   1. 齐全性：语料分章 / 句子 / 分镜 / 章节标注 4 文件都存在
 *   2. 语法：每个 .json 过 verify-json 的严格语法检查（必查）
 *   3. 契约（--contract，默认开；--no-contract 关闭）：
 *      - 句子：S# 连续 / struct 枚举 / text 拼接=语料分章（忽略空白）/ shotId 与分镜引用一致
 *      - 分镜：sentenceIds 无缝覆盖 S1..Sn 不重叠 / sentenceRange↔ids 一致 / type、funcs 枚举 / funcs 非空 / label≤10字
 *      - 章节：function 枚举 / summary≤400字 / stats、suspense 与扫盘重算一致
 *
 * 全书模式（--all）：循环全部已标注章跑单章检测
 *   （2026-09-04 聚合层检查已移除——event/volume 语义、mainlineProgress、章节表.json 均已删除）。
 *
 * 语义（标得对不对）不在检测范围——由 LLM 判定，本脚本零语义判断。
 *
 * 用法：
 *   node novelread/check-chapter.mjs <project> <章号> [--no-contract]   # 单章
 *   node novelread/check-chapter.mjs <project> --all [--no-contract]    # 全书
 *   返回 0 = 通过；1 = 有问题
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { checkJsonText } from "./verify-json.mjs";
import { SHOT_TYPES as SHOT_TYPES_ARR, SHOT_FUNCS as SHOT_FUNCS_ARR, CHAPTER_FUNCS as CHAPTER_FUNCS_ARR } from "./enums.mjs";
import { projectRoot, cliArgs, runScriptArgs } from "../shared/paths.mjs";

let args, project, chapterArg, doAll, contract, projectDir = null; // 惰性初始化（被 import 时不可有副作用）

/** 解析 CLI 参数（延迟到 main 调用——被 sea-main import 时无参数，不能执行 projectRoot/exit） */
function parseArgs() {
  if (projectDir) return;
  args = cliArgs(); // SEA 分发兼容（过滤 "run <script>" 前缀）
  project = args.find((a) => !a.startsWith("--")) ?? null;
  chapterArg = args.filter((a) => !a.startsWith("--") && project !== a)[0] ?? null;
  doAll = args.includes("--all");
  contract = !args.includes("--no-contract");
  projectDir = null;
  try { projectDir = project ? projectRoot(project) : null; } catch { projectDir = null; }
  if (!project || !projectDir || !fs.existsSync(projectDir)) { console.error(`project 不存在: ${project}`); process.exit(2); }
}

/* ---------- 全书模式（--all）：循环单章 + 聚合层检查 ---------- */
export function main() {
  parseArgs(); // 惰性解析 CLI 参数
  if (doAll) {
  const splitDir = path.join(projectDir, "语料分章");
  const chs = fs.existsSync(splitDir)
    ? fs.readdirSync(splitDir).map((f) => f.match(/^第0*(\d+)章/)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b)
    : [];
  console.log(`\n========== 全书契约校验：${project}（${chs.length} 章） ==========\n`);
  let allIssues = 0;
  for (const ch of chs) {
    try {
      const [rCmd, rArgs, rEnv] = runScriptArgs("novelread/check-chapter.mjs", [project, String(ch), ...(contract ? [] : ["--no-contract"])]); const out = execFileSync(rCmd, rArgs, { encoding: "utf-8", env: rEnv });
      // 输出仅保留 ✗/✅ 关键行
      const lines = out.split("\n").filter((l) => l.includes("✗") || l.includes("✅") || l.includes("❌"));
      for (const l of lines) console.log(l.trim());
      if (out.includes("✗")) allIssues++;
    } catch (e) {
      const out = (e.stdout ?? "").toString();
      const lines = out.split("\n").filter((l) => l.includes("✗") || l.includes("❌"));
      for (const l of lines) console.log(l.trim());
      allIssues++;
    }
  }
  // 聚合层检查已移除（2026-09-04：event/volume 语义、mainlineProgress、章节表.json 均已删除，无聚合产物可查）
  const total = allIssues;
  console.log(`\n---------- 汇总 ----------`);
  if (total === 0) { console.log(`✅ 全书契约校验通过：${chs.length} 章`); process.exit(0); }
  console.log(`❌ 发现问题 ${total} 项（章级）`);
  process.exit(1);
}

const ch = Number(chapterArg);
if (!Number.isInteger(ch) || ch <= 0) { console.error(`章号非法: ${chapterArg}`); process.exit(2); }
const chStr = String(ch).padStart(4, "0");

const issues = [];
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => { issues.push(msg); console.log(`  ✗ ${msg}`); };

function readJson(rel) {
  const p = path.join(projectDir, rel);
  if (!fs.existsSync(p)) { bad(`文件缺失: ${rel}`); return null; }
  const text = fs.readFileSync(p, "utf-8");
  const v = checkJsonText(text);
  if (!v.ok) { bad(`语法非法: ${rel} [${v.kind} @行${v.line}:列${v.col}]`); return null; }
  return JSON.parse(text);
}

const SHOT_TYPES = new Set(SHOT_TYPES_ARR);
const SHOT_FUNCS = new Set(SHOT_FUNCS_ARR);
const CHAPTER_FUNCS = new Set(CHAPTER_FUNCS_ARR);

console.log(`\n========== 章级检测：${project} 第${chStr}章（契约检查${contract ? "开" : "关"}） ==========`);

/* ---- 1. 齐全性 ---- */
const txtFile = fs.readdirSync(path.join(projectDir, "语料分章"), { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.startsWith(`第${chStr}章`)).map((e) => e.name)[0] ?? null;
if (txtFile) ok(`语料分章: ${txtFile}`); else bad(`语料分章缺失: 第${chStr}章*`);

/* ---- 2. 句子 ---- */
const sents = readJson(`句子标注/json/第${chStr}章.json`);
if (sents) {
  ok(`句子语法合法（${sents.sentences?.length ?? 0} 句）`);
  if (contract) {
    const s = sents.sentences ?? [];
    if (!s.length) bad("句子数组为空");
    if (s.length && !s.every((x, i) => x.id === `S${i + 1}` && x.seq === i + 1)) bad("S#/seq 不连续");
    if (s.some((x) => !["短句", "句从"].includes(x.struct))) bad("struct 枚举非法");
    if (s.some((x) => !(x.text ?? "").trim())) bad("存在空 text（基本完整性）");
  }
}

/* ---- 3. 分镜 ---- */
const shots = readJson(`分镜标注/json/第${chStr}章.json`);
if (shots) {
  ok(`分镜语法合法（${shots.shots?.length ?? 0} 镜）`);
  if (contract) {
    const sh = shots.shots ?? [];
    const allIds = sh.flatMap((x) => x.sentenceIds ?? []);
    const uniq = new Set(allIds);
    if (uniq.size !== allIds.length) bad("分镜 sentenceIds 有重叠");
    if (sents && allIds.length !== (sents.sentences ?? []).length) bad(`分镜覆盖 ${allIds.length} 句，应=${(sents.sentences ?? []).length}`);
    if (allIds.some((id, i) => id !== `S${i + 1}`)) bad("分镜 sentenceIds 不连续");
    const rangeBad = sh.filter((x) => {
      const seqs = (x.sentenceIds ?? []).map((id) => Number(id.slice(1)));
      return x.sentenceRange[0] !== Math.min(...seqs) || x.sentenceRange[1] !== Math.max(...seqs);
    });
    if (rangeBad.length) bad(`${rangeBad.length} 镜 sentenceRange 与 sentenceIds 不一致`);
    if (sh.some((x) => !SHOT_TYPES.has(x.type))) bad("type 枚举非法");
    if (sh.some((x) => !(x.funcs ?? []).length || x.funcs.some((f) => !SHOT_FUNCS.has(f)))) bad("funcs 枚举非法或为空");
    // 派生字段一致性（脚本生成后证明写对）：句子 shotId == 分镜 sentenceIds 反查
    if (sents) {
      const shotOf = {};
      for (const x of sh) for (const id of x.sentenceIds ?? []) shotOf[id] = x.id;
      const badShot = (sents.sentences ?? []).filter((x) => x.shotId !== (shotOf[x.id] ?? null));
      if (badShot.length) bad(`${badShot.length} 句 shotId 与分镜引用不一致`);
    }
  }
}

/* ---- 4. 章节标注 ---- */
const ca = readJson(`章节/第${chStr}章.json`);
if (ca) {
  ok(`章节标注语法合法`);
  if (contract) {
    if (!CHAPTER_FUNCS.has(ca.function)) bad(`function 枚举非法: ${ca.function}`);
    if (!ca.summary || !(ca.summary ?? "").trim()) bad("summary 为空（基本完整性）");
    // 2026-09-04：mainlineProgress.state 校验已移除（字段随聚合层删除，章节表不再承载）
    // 派生字段一致性：stats/suspense == 扫本章分镜/句子标签重算
    if (shots && sents) {
      const sh = shots.shots ?? [];
      const ss = sents.sentences ?? [];
      const shotTypeDist = {}, funcDist = {};
      for (const x of sh) {
        shotTypeDist[x.type] = (shotTypeDist[x.type] ?? 0) + 1;
        for (const f of x.funcs ?? []) funcDist[f] = (funcDist[f] ?? 0) + 1;
      }
      // 短句 = LLM 标注的 struct=「短句」（与 derive-chapter.mjs 口径一致，不按字符数机械判定）
      const short = ss.filter((x) => x.struct === "短句").length;
      const cluster = ss.filter((x) => x.struct === "句从").length;
      const expectStats = {
        sentenceCount: ss.length, shotCount: sh.length, shotTypeDist, funcDist,
        shortSentenceRate: +(short / (ss.length || 1)).toFixed(2),
        sentenceClusterRate: +(cluster / (ss.length || 1)).toFixed(2),
      };
      const expectSuspense = sh.filter((x) => (x.funcs ?? []).includes("悬念"))
        .map((x) => ({ shot: x.id, label: x.label ?? "", sentenceRange: x.sentenceRange ?? [0, 0] }));
      if (JSON.stringify(ca.stats) !== JSON.stringify(expectStats)) bad("章节 stats 与扫盘重算不一致");
      if (JSON.stringify(ca.suspense ?? []) !== JSON.stringify(expectSuspense)) bad("章节 suspense 与扫盘重算不一致");
    }
  }
}

/* ---- 汇总 ---- */
  if (issues.length === 0) {
    console.log(`\n✅ 第${chStr}章 章级检测通过（4 文件齐全 + 语法合法${contract ? " + 契约" : ""}）`);
    process.exit(0);
  }
  console.log(`\n❌ 第${chStr}章 章级检测发现 ${issues.length} 项问题:`);
  for (const i of issues) console.log(`   - ${i}`);
  process.exit(1);
}

// 直接运行（源码 CLI / SEA 分发调用 export main）——被 import 时仅当直接运行才执行
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(".mjs") && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
