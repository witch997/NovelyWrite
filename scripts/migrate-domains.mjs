/**
 * migrate-domains.mjs — 一次性迁移脚本：store 平铺 → 域化布局
 *
 * 目标布局：
 *   store/exproject/<书>project/                      # 外部书（标注事实层）
 *   store/exproject/<书>project/derived/dict/         # 每书词典
 *   store/exproject/<书>project/derived/vector/       # 每书向量
 *   store/myproject/<书>project/                      # 我的作品（迁移后为空，供后续使用）
 *
 * 迁移动作（幂等，可重复跑）：
 *   1. 确保 store/myproject、store/exproject 存在
 *   2. store/<书>project/（平铺）→ store/exproject/<书>project/
 *      （若目标已存在则跳过——不覆盖已有数据）
 *   3. store/派生/词典/* → store/exproject/<书>project/derived/dict/
 *   4. store/派生/向量/* → store/exproject/<书>project/derived/vector/
 *   5. 清空 store/派生/（若已迁移干净）
 *
 * 用法：
 *   node scripts/migrate-domains.mjs [--dry-run]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { storeDir, myprojectDir, exprojectDir } from "../shared/paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

function moveDir(src, dst, label) {
  if (!fs.existsSync(src)) return { moved: false, reason: "源不存在" };
  if (fs.existsSync(dst)) return { moved: false, reason: "目标已存在（跳过，不覆盖）" };
  if (dryRun) return { moved: "dry-run", reason: "模拟" };
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(src, dst);
  return { moved: true };
}

function main() {
  console.log(`\n========== 域化迁移 ${dryRun ? "（dry-run 模拟）" : ""} ==========`);
  console.log(`store: ${storeDir}`);
  console.log(`myproject: ${myprojectDir}`);
  console.log(`exproject: ${exprojectDir}\n`);

  // 0. 确保两域目录
  if (!dryRun) {
    fs.mkdirSync(myprojectDir, { recursive: true });
    fs.mkdirSync(exprojectDir, { recursive: true });
  }

  // 1. 平铺 project 目录 → exproject
  //    注意：排除两域目录本身（myproject/exproject 也以 "project" 结尾）
  const EXCLUDED = new Set(["myproject", "exproject"]);
  const flatProjects = fs.existsSync(storeDir)
    ? fs.readdirSync(storeDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.endsWith("project") && !EXCLUDED.has(d.name))
        .map((d) => d.name)
    : [];
  for (const name of flatProjects) {
    const src = path.join(storeDir, name);
    const dst = path.join(exprojectDir, name);
    const r = moveDir(src, dst, `project/${name}`);
    console.log(`[${r.moved === true ? "移动" : r.moved === "dry-run" ? "模拟" : "跳过"}] ${name} → exproject/${name}（${r.reason ?? "ok"}）`);
  }

  // 2. 全域派生 → 每书 derived（词典/向量）
  //    store/派生/词典/entity-dict.json → <书>project/derived/dict/entity-dict.json
  //    store/派生/向量/*.json            → <书>project/derived/vector/*.json
  const oldDerived = path.join(storeDir, "派生");
  if (fs.existsSync(oldDerived)) {
    const oldDict = path.join(oldDerived, "词典");
    const oldVector = path.join(oldDerived, "向量");
    // 词典：global 词典（含所有书）→ 无法直接归属某书——提示需重跑 buildDict
    if (fs.existsSync(oldDict)) {
      const dictFiles = fs.readdirSync(oldDict).filter((f) => f.endsWith(".json"));
      if (dictFiles.length) {
        console.log(`\n[词典] 旧全域词典 ${dictFiles.length} 个文件无法自动归属（词典是跨书合并的）——迁移后请重跑：`);
        console.log(`       node retriever/build-derived.mjs --dict`);
      }
    }
    // 向量：每章文件前缀为 <书>-0001.json（旧格式）或 <书>-第0001章.json，可归属
    if (fs.existsSync(oldVector)) {
      const files = fs.readdirSync(oldVector).filter((f) => f.endsWith(".json"));
      const byBook = new Map(); // 书 → [文件]
      for (const f of files) {
        if (f === "index.json") continue; // 旧全局 index 无法归属，重跑生成
        const m = f.match(/^(.+?)-(?:第)?\d{4}(?:章)?\.json$/);
        const book = m ? m[1] : null;
        if (!book) continue;
        if (!byBook.has(book)) byBook.set(book, []);
        byBook.get(book).push(f);
      }
      for (const [book, fsList] of byBook) {
        const dstDir = path.join(exprojectDir, `${book}project`, "derived", "vector");
        for (const f of fsList) {
          const src = path.join(oldVector, f);
          const dst = path.join(dstDir, f);
          if (dryRun) { console.log(`[模拟] 向量 ${f} → ${book}project/derived/vector/`); continue; }
          fs.mkdirSync(dstDir, { recursive: true });
          fs.renameSync(src, dst);
        }
        console.log(`[移动] 向量 ${fsList.length} 个文件 → ${book}project/derived/vector/`);
      }
      if (!dryRun) {
        // 清理旧 index.json（无法归属，重跑生成）
        const oldIdx = path.join(oldVector, "index.json");
        if (fs.existsSync(oldIdx)) { fs.unlinkSync(oldIdx); console.log("[清理] 旧全局 index.json 已删除（重跑 --vector 生成每书 index）"); }
      }
    }
    // 3. 清空旧派生目录（仅当里面没有剩余 .json）
    if (!dryRun) {
      const remain = fs.existsSync(oldDerived)
        ? (() => { const files = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } }; walk(oldDerived); return files; })()
        : [];
      if (remain.length === 0) {
        fs.rmSync(oldDerived, { recursive: true, force: true });
        console.log("[清理] store/派生/ 已清空并删除");
      } else {
        console.log(`[保留] store/派生/ 剩余 ${remain.length} 个文件未迁移（见上），未删除`);
      }
    }
  } else {
    console.log("\n[派生] 旧 store/派生/ 不存在，跳过");
  }

  console.log("\n========== 迁移完成 ==========");
  console.log("后续步骤：");
  console.log("  1. node retriever/build-derived.mjs --dict           # 每书词典");
  console.log("  2. node retriever/build-derived.mjs --vector --reset-vector  # 每书向量");
  console.log("  3. node cli.mjs check 大王饶命                       # 校验回归");
}

main();
