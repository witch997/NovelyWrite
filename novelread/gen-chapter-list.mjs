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

/** 中文数字 → 阿拉伯（第一章→1；支持 一~千，零/两 兼容） */
function cnToNum(s) {
  if (!s) return null;
  const D = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 百: 100, 千: 1000 };
  let total = 0, section = 0, cur = 0;
  for (const ch of s) {
    const v = D[ch];
    if (v === undefined) return null;
    if (v === 10 || v === 100 || v === 1000) {
      section += (cur || 1) * v;
      cur = 0;
    } else {
      cur = v;
    }
  }
  total = section + cur;
  return total > 0 ? total : null;
}

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

  // 标题行两种格式（正文行通常缩进，标题行顶格，靠行首锚定防误匹配）：
  //   ① 第X章 标题（中文数字，如 第一章 甄士隐…）
  //   ② N、标题（阿拉伯数字，如 1、庙会）
  const TITLE_RE_CN = /^第([一二三四五六七八九十百零〇两]+)章\s+(.+)$/;
  const TITLE_RE_AR = /^(\d+)、(.*)$/;
  const heads = [];
  lines.forEach((l, i) => {
    const m1 = l.match(TITLE_RE_CN);
    if (m1) { heads.push({ idx: i, num: cnToNum(m1[1]), title: m1[2].trim() }); return; }
    const m2 = l.match(TITLE_RE_AR);
    if (m2) { heads.push({ idx: i, num: Number(m2[1]), title: m2[2].trim() || `第${Number(m2[1])}章` }); }
  });

  if (!heads.length) {
    console.error(`[gen-list] 未识别到任何章节标题（${corpusName}）。支持格式：①「第X章 标题」②「N、标题」；请检查语料格式`);
    process.exit(1);
  }
  // 章号归一：中文数字 → 阿拉伯；识别不出（如重复/非数字）按出现顺序兜底，防 CSV 章号冲突
  let fallback = 0;
  const seen = new Set();
  for (const h of heads) {
    if (!Number.isInteger(h.num) || h.num <= 0 || seen.has(h.num)) {
      fallback++;
      while (seen.has(fallback)) fallback++;
      h.num = fallback;
      console.warn(`  [gen-list] 章号归一: 第${h.idx + 1}行 标题「${h.title.slice(0, 20)}」→ 章号 ${h.num}（原编号异常或重复）`);
    }
    seen.add(h.num);
  }
  console.log(`[gen-list] ${corpusName}: 识别 ${heads.length} 章标题（两种格式：第X章 / N、标题）`);

  const rows = [];
  for (let k = 0; k < heads.length; k++) {
    const h = heads[k];
    const start = h.idx + 1; // 正文从标题下一行开始
    const end = k + 1 < heads.length ? heads[k + 1].idx : lines.length; // 到下一标题行前一行
    const body = lines.slice(start, end).join("\n");
    rows.push({ num: h.num, title: h.title, start, end, chars: body.length });
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
