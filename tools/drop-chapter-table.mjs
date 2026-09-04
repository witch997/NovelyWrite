#!/usr/bin/env node
/**
 * drop-chapter-table.mjs — 存量章节表清理（一次性迁移脚本，可复用）
 *
 * 背景（2026-09-04）：章节表（dsh/chapter-table/v1）设计已整体移除——纯投影无消费方，
 * 报告 tip 从章节标注 summary 直接搜证；章节树（chapter-tree）改扫 章节/ 目录第NNNN章.json。
 * 本脚本清理已落盘的存量数据文件：
 *   - 各 project 顶层 `章节/章节表.json`：整文件删除
 *
 * 范围限定：只删各 project 顶层 `章节/章节表.json`；
 *   不触碰 标注备份/ 等历史快照（非活数据，保留原样）；
 *   不触碰 章节/第NNNN章.json 等任何其他文件。
 *
 * 备份策略（2026-09-04 用户决定，与 drop-mainline 一致）：不维护备份文件——
 * 章节表是纯确定性重算的投影（由 章节/ 目录可随时再生），删除前自行确认无碍即可。
 *
 * 用法（直接运行才执行；被 import 无副作用）：
 *   node tools/drop-chapter-table.mjs --dry-run               # 预览（dev 数据根）
 *   node tools/drop-chapter-table.mjs                          # 执行（dev 数据根）
 *   node tools/drop-chapter-table.mjs --root "路径/到/store"   # 指定 store 根（可多次传）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEV_STORE = path.resolve(HERE, "..", "store");

function processRoot(root, dryRun) {
  if (!fs.existsSync(root)) { console.warn(`  ⚠ 不存在: ${root}`); return { files: 0 }; }
  console.log(`\n========== 清理 store: ${root} ==========`);
  const changed = []; // {file}

  for (const domain of ["exproject", "myproject"]) {
    const domDir = path.join(root, domain);
    if (!fs.existsSync(domDir)) continue;
    for (const proj of fs.readdirSync(domDir)) {
      const p = path.join(domDir, proj, "章节", "章节表.json");
      if (!fs.existsSync(p)) continue;
      changed.push({ file: path.relative(root, p).replaceAll("\\", "/") });
    }
  }

  console.log(`  命中章节表 ${changed.length} 个文件`);
  for (const c of changed) console.log(`    - ${c.file}`);
  if (!dryRun) {
    for (const c of changed) fs.rmSync(path.join(root, c.file));
    console.log("  ✅ 已删除（无备份——章节表为纯投影，可由 章节/ 目录再生）");
  } else {
    console.log("  [dry-run] 未删盘");
  }
  return { files: changed.length };
}

export function main() {
  const args = process.argv.slice(2);
  const argVals = (name) => args.filter((x) => x.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));
  const dryRun = args.includes("--dry-run");

  const roots = argVals("root");
  if (!roots.length) roots.push(DEV_STORE);

  let totalFiles = 0;
  for (const r of roots) {
    const { files } = processRoot(r, dryRun);
    totalFiles += files;
  }
  console.log(`\n汇总: 删除章节表 ${totalFiles} 个文件（${dryRun ? "dry-run 预览，未删盘" : "已完成"}）`);
}

// 直接运行才执行（被 import 无副作用——本项目 .mjs 统一惯例）
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(".mjs") && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
