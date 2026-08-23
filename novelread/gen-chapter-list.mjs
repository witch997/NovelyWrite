#!/usr/bin/env node
/**
 * gen-chapter-list.mjs — 章节清单生成器（建库前置：语料 → 章节清单 CSV）
 *
 * 职责：读 corpus/<语料名>-语料.txt，按「第X章 + 空白」标题行切分章节，
 *       生成 corpus/<语料名>-章节清单.csv（与 host-exec 的 readChapterList 格式对齐）。
 *
 * 格式（0-based slice 参数，与 host-exec 对齐）：
 *   章号,标题,语料起始行,语料结束行,字符数
 *   start = 标题行索引 + 1（正文从标题下一行起），end = 下一标题行索引（slice 半开）
 *
 * 标题识别：^第[一二三四五六七八九十百零〇两]+章\s+（标题后必须有空白，
 *           防正文误匹配如"第四章中既将…"）
 *
 * 用法：
 *   node novelread/gen-chapter-list.mjs <语料名> [--dry-run]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { corpusDir, cliArgs } from "../shared/paths.mjs";

export function main(argv = cliArgs()) {
  const corpusName = argv[0];
  const dryRun = argv.includes("--dry-run");

  if (!corpusName) {
    console.error("用法: node novelread/gen-chapter-list.mjs <语料名> [--dry-run]");
    process.exit(2);
  }

  const corpusPath = path.join(corpusDir, `${corpusName}-语料.txt`);
  if (!fs.existsSync(corpusPath)) {
    console.error(`[gen-list] 语料不存在: ${corpusPath}`);
    process.exit(1);
  }

  const text = fs.readFileSync(corpusPath, "utf-8").replace(/\r\n/g, "\n");
  const lines = text.split("\n");

  // 标题行五种格式（正文行通常缩进，标题行顶格，靠行首锚定防误匹配）：
  //   ① 第X章 标题（中文数字，如 第一章 甄士隐…）
  //   ② N、标题 / N.标题（阿拉伯数字 + 顿号/点号，如 1、庙会 / 1.楔子）
  //   ③ 第N章 标题（阿拉伯数字，如 第1章 楔子…）
  //   ④ 中文数字+顿号（如 一、楔子）
  // 章号统一按【出现顺序】编号（第 k 个标题 → 章号 k）——避免多卷重号/格式混排导致
  // 的章号冲突；原文章号信息保留在标题列，可通过标题检索定位。
  const TITLE_RE_CN = /^第([一二三四五六七八九十百零〇两]+)章\s+(.+)$/;
  const TITLE_RE_AR = /^(\d+)[、．.]\s*(.*)$/; // 阿拉伯 + 顿号/全角点/半角点
  const TITLE_RE_AR_CN = /^第(\d+)章\s+(.+)$/;
  const TITLE_RE_CN_DUN = /^([一二三四五六七八九十百零〇两]+)[、．.]\s*(.*)$/; // 中文数字 + 顿号/点
  const heads = [];
  lines.forEach((l, i) => {
    const m1 = l.match(TITLE_RE_CN);
    if (m1) { heads.push({ idx: i, title: m1[2].trim() }); return; }
    const m2 = l.match(TITLE_RE_AR);
    if (m2) { heads.push({ idx: i, title: m2[2].trim() || `第${Number(m2[1])}章` }); return; }
    const m3 = l.match(TITLE_RE_AR_CN);
    if (m3) { heads.push({ idx: i, title: m3[2].trim() }); return; }
    const m4 = l.match(TITLE_RE_CN_DUN);
    if (m4) { heads.push({ idx: i, title: m4[2].trim() }); }
  });

  if (!heads.length) {
    console.error(`[gen-list] 未识别到任何章节标题（${corpusName}）。\n支持的语料章节分章格式（标题行须顶格）：\n  ① 第X章 标题　如「第一章 楔子」\n  ② N、标题　如「1、庙会」\n  ③ N.标题　如「1.楔子」（半角/全角点均可）\n  ④ 第N章 标题　如「第1章 楔子」\n  ⑤ 一、标题　如「一、楔子」\n请检查语料格式（正文行通常缩进，标题行顶格）`);
    process.exit(1);
  }
  // 章号 = 出现顺序（第 k 个标题 → k），天然唯一，无需归一
  heads.forEach((h, k) => { h.num = k + 1; });
  console.log(`[gen-list] ${corpusName}: 识别 ${heads.length} 章标题（五种格式：第X章 / N、N. / 第N章 / 一、），章号按出现顺序 1-${heads.length}`);

  const rows = [];
  for (let k = 0; k < heads.length; k++) {
    const h = heads[k];
    const start = h.idx + 1; // 正文从标题下一行开始
    const end = k + 1 < heads.length ? heads[k + 1].idx : lines.length; // 到下一标题行前一行
    const body = lines.slice(start, end).join("\n");
    rows.push({ num: h.num, title: h.title, start, end, chars: body.length });
  }

  // 空章节检测：正文完全为空（标题紧邻标题，可能爬虫重复标题）→ 拒绝导入
  const empties = rows.filter((r) => r.chars === 0);
  if (empties.length) {
    console.error(`[gen-list] 检测到 ${empties.length} 个空章节（正文为空，通常为标题重复/爬虫残留），拒绝导入：`);
    for (const e of empties) {
      console.error(`  · 第${e.num}章「${e.title}」（语料行 ${e.start}-${e.end}）`);
    }
    console.error(`支持的语料章节分章格式（标题行须顶格）：\n  ① 第X章 标题　如「第一章 楔子」\n  ② N、标题　如「1、庙会」\n  ③ N.标题　如「1.楔子」（半角/全角点均可）\n  ④ 第N章 标题　如「第1章 楔子」\n  ⑤ 一、标题　如「一、楔子」\n请清理原文件中重复/空的标题行后重试。`);
    process.exit(1);
  }

  let csv = "章号,标题,语料起始行,语料结束行,字符数\n";
  for (const r of rows) csv += `${r.num},${r.title},${r.start},${r.end},${r.chars}\n`;

  if (dryRun) {
    console.log(`[dry-run] 将写入 corpus/${corpusName}-章节清单.csv（${rows.length} 章）`);
    console.log(`  首章: ${rows[0].num},${rows[0].title},${rows[0].start},${rows[0].end},${rows[0].chars}`);
    console.log(`  末章: ${rows.at(-1).num},${rows.at(-1).title},${rows.at(-1).start},${rows.at(-1).end},${rows.at(-1).chars}`);
    process.exit(0);
  }

  const outPath = path.join(corpusDir, `${corpusName}-章节清单.csv`);
  fs.writeFileSync(outPath, csv, "utf-8");
  console.log(`[gen-list] 已写入: corpus/${corpusName}-章节清单.csv（${rows.length} 章）`);
}

// 直接运行（源码 CLI / SEA 分发调用 export main）
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(".mjs") && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
