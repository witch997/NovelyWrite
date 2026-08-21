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
import { corpusDir } from "../shared/paths.mjs";

const args = process.argv.slice(2);
const corpusName = args[0];
const dryRun = args.includes("--dry-run");

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

// 标题行: 第一章 甄士隐梦幻识通灵 贾雨村风尘怀闺秀（标题后必须有空白）
const TITLE_RE = /^第[一二三四五六七八九十百零〇两]+章\s+.+$/;
const heads = [];
lines.forEach((l, i) => {
  if (TITLE_RE.test(l)) {
    heads.push({ idx: i, title: l.replace(/^第[一二三四五六七八九十百零〇两]+章\s+/, "").trim() });
  }
});

if (!heads.length) {
  console.error(`[gen-list] 未识别到任何「第X章」标题（${corpusName}），请检查语料格式`);
  process.exit(1);
}
console.log(`[gen-list] ${corpusName}: 识别 ${heads.length} 章标题`);

const rows = [];
for (let k = 0; k < heads.length; k++) {
  const h = heads[k];
  const start = h.idx + 1; // 正文从标题下一行开始
  const end = k + 1 < heads.length ? heads[k + 1].idx : lines.length; // 到下一标题行前一行
  const body = lines.slice(start, end).join("\n");
  rows.push({ num: k + 1, title: h.title, start, end, chars: body.length });
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
