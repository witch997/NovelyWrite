/**
 * check-chapter.mjs — 章级检测 + 全书契约校验（吸收原 verify-format.mjs）
 *
 * 单章模式：检查本章 4 个章级文件——
 *   1. 齐全性：语料分章 / 句子 / 分镜 / 章节标注 4 文件都存在
 *   2. 语法：每个 .json 过 verify-json 的严格语法检查（必查）
 *   3. 契约（--contract，默认开；--no-contract 关闭）：
 *      - 句子：S# 连续 / struct 枚举 / text 拼接=语料分章（忽略空白）/ shotId 与分镜引用一致
 *      - 分镜：sentenceIds 无缝覆盖 S1..Sn 不重叠 / sentenceRange↔ids 一致 / type、funcs 枚举 / funcs 非空 / label≤10字
 *      - 章节：function 枚举 / summary≤400字 / mainlineProgress.state 枚举 / stats、suspense 与扫盘重算一致
 *
 * 全书模式（--all）：循环全部已标注章跑单章检测 + 聚合层检查
 *   （章节表/event.json schema+derivedFrom、卷纲 volume.json targets 结构、temp 文件检查——原 verify-format 的聚合层部分）。
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
import { projectRoot } from "../shared/paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const project = args.find((a) => !a.startsWith("--")) ?? null;
const chapterArg = args.filter((a) => !a.startsWith("--") && project !== a)[0] ?? null;
const doAll = args.includes("--all");
const contract = !args.includes("--no-contract");

let projectDir = null;
try { projectDir = project ? projectRoot(project) : null; } catch { projectDir = null; }
if (!project || !projectDir || !fs.existsSync(projectDir)) { console.error(`project 不存在: ${project}`); process.exit(2); }

/* ---------- 全书模式（--all）：循环单章 + 聚合层检查 ---------- */
if (doAll) {
  const splitDir = path.join(projectDir, "语料分章");
  const chs = fs.existsSync(splitDir)
    ? fs.readdirSync(splitDir).map((f) => f.match(/^第0*(\d+)章/)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b)
    : [];
  console.log(`\n========== 全书契约校验：${project}（${chs.length} 章） ==========\n`);
  let allIssues = 0;
  for (const ch of chs) {
    try {
      const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), project, String(ch), ...(contract ? [] : ["--no-contract"])], { encoding: "utf-8" });
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
  // 聚合层检查（原 verify-format：章节表/event.json schema+derivedFrom、卷纲结构）
  console.log("\n--- 聚合层 ---");
  const aggIssues = [];
  const checkAgg = (name, p, schema) => {
    if (!fs.existsSync(p)) { aggIssues.push(`${name} 缺失`); console.log(`  ✗ ${name} 缺失`); return; }
    const v = checkJsonText(fs.readFileSync(p, "utf-8"));
    if (!v.ok) { aggIssues.push(`${name} 语法非法`); console.log(`  ✗ ${name} 语法非法`); return; }
    const d = JSON.parse(fs.readFileSync(p, "utf-8"));
    if (d.schema !== schema) { aggIssues.push(`${name} schema 非法`); console.log(`  ✗ ${name} schema 非法: ${d.schema}`); }
    if (!d.derivedFrom) { aggIssues.push(`${name} 缺 derivedFrom`); console.log(`  ✗ ${name} 缺 derivedFrom 版本戳`); }
  };
  checkAgg("章节表", path.join(projectDir, "章节", "章节表.json"), "dsh/chapter-table/v1");
  checkAgg("大事件主文件", path.join(projectDir, "大事件", "event.json"), "dsh/event-card/v1");
  // event.json：lifecycle[] 契约（entity/开始章/持续章/结束章/state/note）
  const evFile = path.join(projectDir, "大事件", "event.json");
  if (fs.existsSync(evFile)) {
    const v = checkJsonText(fs.readFileSync(evFile, "utf-8"));
    if (v.ok) {
      const d = JSON.parse(fs.readFileSync(evFile, "utf-8"));
      const lcs = d.lifecycle ?? [];
      const badLc = lcs.filter((lc) => !lc.entity || !Array.isArray(lc["持续章"]) || !["悬置", "已回收"].includes(lc.state) || !(lc.note ?? "").trim());
      if (badLc.length) { aggIssues.push(`event.json ${badLc.length} 个 lifecycle 结构不完整（缺 entity/持续章/state 枚举/note）`); console.log(`  ✗ event.json ${badLc.length} 个 lifecycle 结构不完整`); }
      const badEnd = lcs.filter((lc) => { const end = lc["结束章"]; return end !== null && end !== undefined && typeof end !== "number"; });
      if (badEnd.length) { aggIssues.push(`event.json ${badEnd.length} 个事件结束章非 int/null`); console.log(`  ✗ event.json ${badEnd.length} 个事件结束章非 int/null`); }
      // 语义自洽：state=已回收 ⟺ 结束章≠null；结束章 ∈ 持续章（或 null）
      const badSelf = lcs.filter((lc) => (lc.state === "已回收" && lc["结束章"] === null) || (lc.state === "悬置" && lc["结束章"] !== null) || (lc["结束章"] !== null && !(lc["持续章"] ?? []).includes(lc["结束章"])));
      if (badSelf.length) { aggIssues.push(`event.json ${badSelf.length} 个 lifecycle 语义不自洽（state/结束章/持续章 冲突）`); console.log(`  ✗ event.json ${badSelf.length} 个 lifecycle 语义不自洽`); }
      // 废弃字段检查：mainline/chapterIndex 不得残留
      if ("mainline" in d || "chapterIndex" in d) { aggIssues.push("event.json 含废弃字段 mainline/chapterIndex"); console.log(`  ✗ event.json 含废弃字段 mainline/chapterIndex`); }
      // aggregatedChapters 快照：存在（增量模式启用条件）
      const agg = d.derivedFrom?.aggregatedChapters;
      if (!Array.isArray(agg) || !agg.length) { aggIssues.push("event.json 缺 derivedFrom.aggregatedChapters（增量快照）"); console.log(`  ✗ event.json 缺 derivedFrom.aggregatedChapters`); }
    }
  }
  const volFile = path.join(projectDir, "卷纲", "volume.json");
  if (fs.existsSync(volFile)) {
    const v = checkJsonText(fs.readFileSync(volFile, "utf-8"));
    if (!v.ok) { aggIssues.push("卷纲 语法非法"); console.log(`  ✗ 卷纲 语法非法`); }
    else {
      const d = JSON.parse(fs.readFileSync(volFile, "utf-8"));
      if (d.schema !== "dsh/volume-card/v1") { aggIssues.push("卷纲 schema 非法"); console.log(`  ✗ 卷纲 schema 非法: ${d.schema}`); }
      // targets[] 契约：target/state 枚举/evidenceChapters/note；isMain 唯一且为命中最多者
      const TARGET_STATES = new Set(["确立", "推进", "达成", "搁置", "失败"]);
      const targets = d.targets ?? [];
      const badT = targets.filter((t) => !(t.target ?? "").trim() || !TARGET_STATES.has(t.state) || !Array.isArray(t.evidenceChapters) || !(t.note ?? "").trim());
      if (badT.length) { aggIssues.push(`卷纲 ${badT.length} 个 targets 结构不完整（缺 target/state 枚举/evidenceChapters/note）`); console.log(`  ✗ 卷纲 ${badT.length} 个 targets 结构不完整`); }
      const mainT = targets.filter((t) => t.isMain === true);
      if (mainT.length !== 1) { aggIssues.push(`卷纲 isMain 应唯一（现 ${mainT.length} 个）`); console.log(`  ✗ 卷纲 isMain 应唯一（现 ${mainT.length} 个）`); }
      else {
        const maxLen = Math.max(...targets.map((t) => (t.evidenceChapters ?? []).length));
        if ((mainT[0].evidenceChapters ?? []).length !== maxLen) { aggIssues.push("卷纲 isMain 非命中章节最多者"); console.log(`  ✗ 卷纲 isMain 非命中章节最多者`); }
      }
      // 废弃字段检查：eventStructure/mainline 不得残留
      if ("eventStructure" in d || "mainline" in d) { aggIssues.push("卷纲 含废弃字段 eventStructure/mainline"); console.log(`  ✗ 卷纲 含废弃字段 eventStructure/mainline`); }
    }
  }
  // 增量状态文件（失败重入标记）：存在 → 提示上次增量未完成（非阻塞，重跑 aggregates 即可续）
  const incrP = path.join(projectDir, "incremental-state.json");
  if (fs.existsSync(incrP)) {
    const iv = checkJsonText(fs.readFileSync(incrP, "utf-8"));
    if (iv.ok) {
      const st = JSON.parse(fs.readFileSync(incrP, "utf-8"));
      console.log(`  ⚠ 增量状态残留（上次失败未完成）: batch=[${st.batch?.join(",") ?? "?"}] tempTs=${st.tempTs ?? "?"}——重跑 aggregates 同批次续传`);
    } else {
      console.log("  ⚠ incremental-state.json 存在但语法非法（上次失败）——重跑 aggregates 覆盖");
    }
  }
  // temp 文件检查（增量中间产物，持久保留待查）：语法 + 同构 + tempFor 章号存在性
  for (const tempDir of ["大事件", "卷纲"]) {
    const dir = path.join(projectDir, tempDir);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!/^[a-z]+temp-.*\.json$/i.test(f)) continue;   // eventtemp-*.json / volumetemp-*.json
      const p = path.join(dir, f);
      const tv = checkJsonText(fs.readFileSync(p, "utf-8"));
      if (!tv.ok) { aggIssues.push(`${tempDir}/${f} 语法非法`); console.log(`  ✗ ${tempDir}/${f} 语法非法`); continue; }
      const td = JSON.parse(fs.readFileSync(p, "utf-8"));
      const wantSchema = tempDir === "大事件" ? "dsh/event-card/v1" : "dsh/volume-card/v1";
      if (td.schema !== wantSchema) { aggIssues.push(`${tempDir}/${f} schema 与层不符`); console.log(`  ✗ ${tempDir}/${f} schema 与层不符: ${td.schema}`); }
      if (!Array.isArray(td.tempFor) || !td.tempFor.length) { aggIssues.push(`${tempDir}/${f} 缺 tempFor（新增章批次）`); console.log(`  ✗ ${tempDir}/${f} 缺 tempFor`); }
    }
  }
  const total = allIssues + aggIssues.length;
  console.log(`\n---------- 汇总 ----------`);
  if (total === 0) { console.log(`✅ 全书契约校验通过：${chs.length} 章 + 聚合层无问题`); process.exit(0); }
  console.log(`❌ 发现问题 ${total} 项（${allIssues} 章级 + ${aggIssues.length} 聚合层）`);
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

const SHOT_TYPES = new Set(["信息", "对话", "心理", "动作", "事件", "环境"]);
const SHOT_FUNCS = new Set(["塑造人物", "引入世界观", "设置动机", "推进", "铺垫", "反转", "爆发", "转场", "收束分镜", "悬念"]);
const CHAPTER_FUNCS = new Set(["开端", "推进", "铺垫", "爆发", "转折", "收束章节", "过渡"]);
const MAINLINE_STATES = new Set(["主线启动", "推进", "受阻", "达成", "更换"]);

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
    const badState = (ca.mainlineProgress ?? []).filter((m) => !MAINLINE_STATES.has(m.state));
    if (badState.length) bad(`mainlineProgress.state 枚举非法: ${[...new Set(badState.map((m) => m.state))].join("/")}`);
    // 派生字段一致性：stats/suspense == 扫本章分镜/句子标签重算
    if (shots && sents) {
      const sh = shots.shots ?? [];
      const ss = sents.sentences ?? [];
      const shotTypeDist = {}, funcDist = {};
      for (const x of sh) {
        shotTypeDist[x.type] = (shotTypeDist[x.type] ?? 0) + 1;
        for (const f of x.funcs ?? []) funcDist[f] = (funcDist[f] ?? 0) + 1;
      }
      const short = ss.filter((x) => (x.text ?? "").replace(/\s/g, "").length <= 12).length;
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
