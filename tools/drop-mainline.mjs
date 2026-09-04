#!/usr/bin/env node
/**
 * drop-mainline.mjs — 存量 mainlineProgress 清理（一次性迁移脚本，可复用）
 *
 * 背景（2026-09-04）：mainlineProgress 字段随聚合层删除已从代码链路移除
 * （enums/host-exec/check-chapter/fix/aggregates/specs），本脚本清理已落盘的存量数据：
 *   - 各 project 顶层 `章节/第XXXX章.json`（章节标注）：删除顶层 mainlineProgress
 *   - 各 project 顶层 `章节/章节表.json`（章节表）：删除顶层 mainlineProgress + chapters[].mainlineProgress
 *
 * 范围限定：只扫各 project 顶层 `章节/` 目录下的 *.json；
 *   不触碰 标注备份/ 等历史快照（非活数据，保留原样）；
 *   不触碰 句子/分镜 标注（无此字段）。
 *
 * 备份策略（2026-09-04 用户决定）：不维护备份文件——清理前自行确认数据无碍即可。
 *
 * 用法（直接运行才执行；被 import 无副作用）：
 *   node tools/drop-mainline.mjs --dry-run                 # 预览（dev 数据根）
 *   node tools/drop-mainline.mjs                            # 执行（dev 数据根）
 *   node tools/drop-mainline.mjs --root "路径/到/store"     # 指定 store 根（可多次传）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEV_STORE = path.resolve(HERE, "..", "store");

/** 深删对象中指定键（顶层 + 逐 chapters[] 元素），返回删除的键位计数 */
function stripMainline(o) {
  let removed = 0;
  if (o && typeof o === "object") {
    if ("mainlineProgress" in o) { delete o.mainlineProgress; removed++; }
    if (Array.isArray(o.chapters)) {
      for (const c of o.chapters) {
        if (c && typeof c === "object" && "mainlineProgress" in c) { delete c.mainlineProgress; removed++; }
      }
    }
  }
  return removed;
}

function processRoot(root, dryRun) {
  if (!fs.existsSync(root)) { console.warn(`  ⚠ 不存在: ${root}`); return { files: 0, keys: 0 }; }
  console.log(`\n========== 清理 store: ${root} ==========`);
  const changed = []; // {file, keys}
  let keys = 0;

  for (const domain of ["exproject", "myproject"]) {
    const domDir = path.join(root, domain);
    if (!fs.existsSync(domDir)) continue;
    for (const proj of fs.readdirSync(domDir)) {
      const chDir = path.join(domDir, proj, "章节");
      if (!fs.existsSync(chDir)) continue;
      for (const f of fs.readdirSync(chDir)) {
        if (!f.endsWith(".json")) continue;
        const p = path.join(chDir, f);
        let o;
        try { o = JSON.parse(fs.readFileSync(p, "utf8")); } catch { continue; }
        const n = stripMainline(o);
        if (!n) continue;
        keys += n;
        changed.push({ file: path.relative(root, p).replaceAll("\\", "/"), keys: n, json: o });
      }
    }
  }

  console.log(`  命中 ${changed.length} 个文件，删除 mainline 键位 ${keys} 处`);
  for (const c of changed) console.log(`    - ${c.file}（${c.keys} 键位）`);
  if (!dryRun) {
    for (const c of changed) {
      fs.writeFileSync(path.join(root, c.file), JSON.stringify(c.json, null, 2) + "\n", "utf8");
    }
    console.log("  ✅ 已清理（无备份——用户决定不维护备份文件）");
  } else {
    console.log("  [dry-run] 未写盘");
  }
  return { files: changed.length, keys };
}

export function main() {
  const args = process.argv.slice(2);
  const argVals = (name) => args.filter((x) => x.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));
  const dryRun = args.includes("--dry-run");

  const roots = argVals("root");
  if (!roots.length) roots.push(DEV_STORE);

  let totalFiles = 0, totalKeys = 0;
  for (const r of roots) {
    const { files, keys } = processRoot(r, dryRun);
    totalFiles += files; totalKeys += keys;
  }
  console.log(`\n汇总: ${totalFiles} 文件 / ${totalKeys} 键位（${dryRun ? "dry-run 预览，未改盘" : "已完成"}）`);
}

// 直接运行才执行（被 import 无副作用——本项目 .mjs 统一惯例）
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(".mjs") && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
