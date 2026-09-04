#!/usr/bin/env node
/**
 * aggregates.mjs — 聚合层确定性编排（阶段二）
 *
 * 2026-09-04 变更①：移除大事件（event.json）与卷纲（volume.json）语义设计与增量合并——
 * 报告期由 LLM 从章节层自行搜寻 evidence（report 链路），标注完不再强制跨章语义调用。
 * 2026-09-04 变更②：移除 mainlineProgress 与章节表（chapter-table）——mainline 无消费方随之删除，
 * 章节表退化为纯投影亦无消费方（报告 tip 从章节标注 summary 直接搜证），不再生成。
 * 本文件保留纯确定性部分：
 *   ① 确定性重算（deterministicPart）：清单恢复 / 缺章报告 / 卷级统计（输入=全部章节标注规定字段）
 *   ② 终检（finalizePart）：全项目语法门 + 契约门（宽松）+ 统计 → project-meta.json
 *   ③ 索引更新：词典（ensureDerived）/ 四表 / 向量（分镜）
 *
 * 子命令：
 *   node novelread/aggregates.mjs <project>                    # ① + ② + ③（确定性）
 *   node novelread/aggregates.mjs <project> --deterministic-only  # 只①（无索引）
 *   node novelread/aggregates.mjs <project> --finalize-only       # 只②（语法门/统计/头文档；fix 后调用）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { checkJsonText } from "./verify-json.mjs";
import { buildLexicalIndex, buildVectors } from "../retriever/build-derived.mjs";
import { ensureDerived } from "../retriever/ensure-derived.mjs";
import { DATA_ROOT, corpusDir, projectRoot, cliArgs, runScriptArgs } from "../shared/paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let args, project, flags, projectDir, corpusList, listPath; // 惰性初始化（被 import 时不可有副作用）

/** 解析 CLI 参数（延迟到 main 调用——被 sea-main import 时无参数，不能执行 projectRoot） */
function parseArgs() {
  if (projectDir) return;
  args = cliArgs(); // SEA 分发兼容（过滤 "run <script>" 前缀）
  project = args.find((a) => !a.startsWith("--")) ?? "大王饶命";
  flags = args.filter((a) => a.startsWith("--"));
  projectDir = projectRoot(project); // 域感知：两域自动探测
  corpusList = path.join(corpusDir, `${project}-章节清单.csv`);
  listPath = fs.existsSync(corpusList) ? corpusList : path.join(corpusDir, "章节清单.csv");
}

/* ================= ① 确定性重算（章节统计 / 清单 / 缺章报告）——2026-09-04 章节表.json 已移除 ================= */

function loadChapters() {
  const dir = path.join(projectDir, "章节");
  const out = [], bad = [];
  if (!fs.existsSync(dir)) return { out, bad };
  // 章节目录 = 仅章标注 JSON（章节表.json 已于 2026-09-04 移除，不再生成）
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const text = fs.readFileSync(path.join(dir, f), "utf-8");
    const v = checkJsonText(text);
    if (!v.ok) { bad.push({ file: f, kind: v.kind }); continue; }
    const d = JSON.parse(text);
    out.push({
      number: d.chapter?.number, title: d.chapter?.title ?? d.title, function: d.function,
      summary: d.summary, stats: d.stats ?? null, suspense: d.suspense ?? [],
    });
  }
  return { out: out.sort((a, b) => a.number - b.number), bad };
}

function loadList() {
  if (!fs.existsSync(listPath)) return [];
  const rows = [];
  const lines = fs.readFileSync(listPath, "utf-8").replace(/\r\n/g, "\n").split("\n");
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    const m5 = l.match(/^(\d+),(.+),(\d+),(\d+),(\d+)$/);
    if (m5) { rows.push({ number: Number(m5[1]), title: m5[2].trim(), start: Number(m5[3]), end: Number(m5[4]) }); continue; }
    const m3 = l.match(/^(\d+),(.+?),(\d+)-(\d+)$/);
    if (m3) rows.push({ number: Number(m3[1]), title: m3[2], start: Number(m3[3]), end: Number(m3[4]) });
  }
  return rows;
}

/** ① 清单恢复 + 缺章报告（确定性）——2026-09-04 章节表.json 已移除（纯投影无消费方，报告 tip 按需搜证） */
export function deterministicPart(projectDir, project) {
  const { out: chs, bad } = loadChapters();
  console.log(`\n========== 聚合层① 确定性重算：${project} ==========`);
  console.log(`已标注章: ${chs.length}（语法非法跳过 ${bad.length}${bad.length ? ": " + bad.map((b) => `${b.file}[${b.kind}]`).join(" / ") : ""}）`);
  if (!chs.length) { console.error("无可用章节标注，中止"); process.exit(1); }

  // 清单恢复
  const list = loadList();
  if (list.length) {
    const head = "章号,标题,语料起始行,语料结束行,字符数";
    const rows = list.map((r) => `${r.number},${r.title},${r.start},${r.end},${(r.end - r.start + 1) * 50}`);
    fs.mkdirSync(path.join(projectDir, "清单"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, "清单", "章节清单.csv"), [head, ...rows].join("\n") + "\n", "utf-8");
    console.log(`清单/章节清单.csv 已恢复：${list.length} 行`);
  } else console.warn(`  ⚠ corpus 清单不存在或为空: ${listPath}`);

  // 缺章报告
  const have = new Set(chs.map((c) => c.number));
  const missing = list.map((r) => r.number).filter((n) => !have.has(n));
  if (missing.length) console.log(`  ⚠ 缺章 ${missing.length} 个: ${missing.join(",")}`);
  else console.log(`  ✓ 无缺章`);
  return { chapters: chs, list, missing };
}

/* ================= ② 终检 + 头文档（语法门 + 契约门 + 统计） ================= */

const now = () => new Date().toISOString();

/** ② 终检：全项目语法门 + 契约计数 + 统计 + project-meta.json */
export function finalizePart(projectDir, project) {
  console.log(`\n========== 聚合层② 终检 + 头文档：${project} ==========`);
  taskLine({ stage: "aggregate", phase: "聚合层② 终检+索引" });
  // 语法门（严格，跳过中间产物文件）
  const jsonFiles = (() => {
    const out = [];
    const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(".json")) out.push(p); } };
    walk(projectDir);
    return out.sort();
  })();
  const badFiles = [];
  for (const f of jsonFiles) {
    const v = checkJsonText(fs.readFileSync(f, "utf-8"));
    if (!v.ok) badFiles.push({ file: f.replace(projectDir + path.sep, "").replaceAll("\\", "/"), kind: v.kind, line: v.line, col: v.col });
  }
  const syntaxPass = badFiles.length === 0;
  console.log(`JSON 文件: ${jsonFiles.length} 个 | 语法 ${syntaxPass ? "✅ 全过" : `❌ ${badFiles.length} 个非法`}`);
  for (const b of badFiles) console.log(`   - ${b.file} [${b.kind} @行${b.line}:列${b.col}]`);

  // 契约门（宽松：check-chapter --all 计数）
  let contractIssues = 0, contractReport = [];
  try {
    const [rCmd, rArgs, rEnv] = runScriptArgs("novelread/check-chapter.mjs", [project, "--all"]); const out = execFileSync(rCmd, rArgs, { encoding: "utf-8", env: rEnv });
    const badLines = out.split("\n").filter((l) => l.includes("✗") || l.includes("❌"));
    contractIssues = badLines.length;
    contractReport = badLines.map((l) => l.trim()).slice(0, 20);
    console.log(`契约问题: ${contractIssues} 项（宽松门，不阻塞）`);
  } catch (e) {
    const out = (e.stdout ?? "").toString();
    const badLines = out.split("\n").filter((l) => l.includes("✗") || l.includes("❌"));
    contractIssues = badLines.length;
    contractReport = badLines.map((l) => l.trim()).slice(0, 20);
    console.log(`契约问题: ${contractIssues} 项（宽松门，不阻塞）`);
  }

  // 统计（只读章节标注）
  const { out: chs } = loadChapters();
  let sentences = 0, shots = 0, words = 0;
  for (const c of chs) { sentences += c.stats?.sentenceCount ?? 0; shots += c.stats?.shotCount ?? 0; words += c.stats?.wordCount ?? 0; }
  const list = loadList();
  const have = new Set(chs.map((c) => c.number));
  const missingChapters = list.map((r) => r.number).filter((n) => !have.has(n));
  const chRange = chs.length ? [chs[0].number, chs[chs.length - 1].number] : [0, 0];
  console.log(`标注进度: ${chs.length}/${list.length} 章 | 缺 ${missingChapters.length} 章 | 范围 [${chRange}]`);
  console.log(`统计: ${sentences} 句 / ${shots} 镜 / ${words} 字`);

  // 头文档
  const metaP = path.join(projectDir, "project-meta.json");
  let prevMeta = {};
  try { prevMeta = JSON.parse(fs.readFileSync(metaP, "utf-8")); } catch { /* 首次无旧 meta */ }
  const meta = {
    schema: "dsh/project-meta/v1",
    project,
    corpus: path.relative(DATA_ROOT, corpusList).replaceAll("\\", "/"),
    chapterList: path.relative(DATA_ROOT, listPath).replaceAll("\\", "/"),
    volume: { name: project, chapterRange: chRange },
    counts: {
      chaptersAnnotated: chs.length, chaptersTotal: list.length, missingChapters,
      sentences, shots, chapterAnnotations: chs.length,
      jsonFiles: jsonFiles.length,
    },
    verify: { syntaxPass, badFiles, contractIssues, contractReport, verifiedAt: now() },
    // 保留扩展字段（sourceFingerprints 等——由 mybook 指纹检测/更新写入，finalize 不得覆盖）
    ...(prevMeta.sourceFingerprints ? { sourceFingerprints: prevMeta.sourceFingerprints } : {}),
    updatedAt: now(),
    generatedBy: "novelread/aggregates.mjs (finalizePart)",
  };
  fs.writeFileSync(metaP, JSON.stringify(meta, null, 2) + "\n", "utf-8");
  console.log(`\n✅ 头文档已写入: ${metaP}（verifiedAt=${meta.verify.verifiedAt}）`);
  return { syntaxPass, contractIssues };
}

/* ================= main ================= */

/** [task] 进度协议行（模块级——main 及聚合各阶段函数共用；task/manager.mjs 统一解析，同时进日志留痕） */
function taskLine(d) {
  console.log(`[task] ${JSON.stringify(d)}`);
}

export async function main() {
  parseArgs(); // 惰性解析 CLI 参数（SEA 分发时 main 无参，参数来自 cliArgs 过滤后的 process.argv）
  if (!fs.existsSync(projectDir)) { console.error(`project 不存在: ${projectDir}`); process.exit(2); }

  if (flags.includes("--deterministic-only")) { deterministicPart(projectDir, project); process.exit(0); }
  if (flags.includes("--finalize-only")) {
    const { syntaxPass } = finalizePart(projectDir, project);
    process.exit(syntaxPass ? 0 : 1);
  }

  // 完整阶段二（确定性）：① 清单/缺章/卷级统计 → ② 终检/头文档 → ③ 索引更新
  deterministicPart(projectDir, project);
  const { syntaxPass } = finalizePart(projectDir, project);
  if (!syntaxPass) { console.error("\n❌ 终检未通过（语法门有非法文件，见上）"); process.exit(1); }

  // 索引更新：校验通过 → 更新检索索引（词典/四表/向量，增量）
  // 依据：数据变化后索引必须刷新（否则检索引用过期快照）；构建/查询分离原则——此处是显式构建点
  // 词典：走 ensureDerived 对比（源 mtime 没变 → 不重建，省 20 万规模的重建成本；句子变化暂不追踪，已知局限）
  console.log("\n[聚合] 更新检索索引（词典/四表/向量，增量）...");
  try {
    const { rebuilt } = await ensureDerived(); // {rebuilt: string[]}
    if (rebuilt.length) console.log(`  [索引] 词典已重建: ${rebuilt.join(", ")}`);
    else console.log("  [索引] 词典无变化（源未变，跳过重建）");
  } catch (err) { console.warn(`  [索引] 词典更新异常（不阻塞）: ${err.message.slice(0, 80)}`); }
  try {
    const r = buildLexicalIndex();
    if (r === null) console.log("  [索引] 四表索引：后期扩容预备，跳过（检索走实时扫盘，消费设计未落实）");
    else console.log("  [索引] 四表索引已更新（无变化则零成本）");
  } catch (err) { console.warn(`  [索引] 四表更新异常（不阻塞）: ${err.message.slice(0, 80)}`); }
  try {
    const vres = await buildVectors({ projects: [project] });
    if (vres?.ok) console.log(`  [索引] 向量已更新：${vres.stats?.totalShots ?? "?"} 分镜`);
    else console.log(`  [索引] 向量跳过：${vres?.reason ?? "未知"}（${vres?.guidance ?? ""}）`);
  } catch (err) { console.warn(`  [索引] 向量更新异常（不阻塞）: ${err.message.slice(0, 80)}`); }

  console.log("\n✅ 阶段二完成：确定性聚合 + 终检通过 + 索引已更新（project-meta.json 已更新）");
  taskLine({ stage: "done", phase: "聚合完成" });
}

// 直接运行（源码 CLI / SEA 分发调用 export main）——被 import 时仅当直接运行才执行
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(".mjs") && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error("[aggregates] 失败:", err.message); process.exit(1); });
}
