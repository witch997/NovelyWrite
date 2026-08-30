#!/usr/bin/env node
/**
 * chapter-tree.mjs — 章节树索引（features/report 模块）
 *
 * 定位索引两层：
 *   output/<书>/chapter-tree/
 *   ├── index.json      ← 卷级索引（章节表 + 每章指纹，超小，失效判断入口）
 *   └── ch-NNNN.json    ← 每章节点（元数据 summary/function/suspense + 分镜引用 shots[]）
 *
 * 设计原则：
 *   - 树 = 元数据投影，纯程序生成，零 LLM，随时可重建
 *   - 每章节点指纹 = hash(章节标注 + 分镜标注 内容) → 单章变更只重建该章节点（增量）
 *   - index.json 存每章指纹 → 读小文件即知哪章脏，不用打开 2000 个节点
 *   - 句子永不进树：shots[].sentenceIds 是引用，句子原文仍在 store 句子文件（唯一事实源）
 *   - 存 output/ 不污染 store（store 是唯一事实源）
 *
 * 用法：
 *   node features/report/chapter-tree.mjs --project=<书> [--force]   # CLI 增量构建
 *   import { buildChapterTree } from "./chapter-tree.mjs"            # report 集成
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { projectRoot, outputDir } from "../../shared/paths.mjs";

const pad4 = (n) => String(n).padStart(4, "0");
const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 16);

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

/** 章节树根目录（output/<书>/chapter-tree/） */
export function treeDirOf(project) {
  return path.join(outputDir, project, "chapter-tree");
}

/** 章节树索引文件 */
export function treeIndexFileOf(project) {
  return path.join(treeDirOf(project), "index.json");
}

/** 单章节点文件 */
export function chapterNodeFileOf(project, num) {
  return path.join(treeDirOf(project), `ch-${pad4(num)}.json`);
}

/** 单章指纹 = hash(章节标注 + 分镜标注 内容) */
export function chapterFingerprint(root, num) {
  const chP = path.join(root, "章节", `第${pad4(num)}章.json`);
  const shP = path.join(root, "分镜标注", "json", `第${pad4(num)}章.json`);
  const ch = fs.existsSync(chP) ? fs.readFileSync(chP, "utf-8") : "";
  const sh = fs.existsSync(shP) ? fs.readFileSync(shP, "utf-8") : "";
  return sha1(ch + sh);
}

/**
 * 构建章节树（增量：只重建指纹变化的章节点）
 * @param {string} project 书名
 * @param {{force?: boolean}} [opts]
 * @returns {{treeDir, chapters: number, rebuilt: number, skipped: number, index: object}}
 */
export function buildChapterTree(project, opts = {}) {
  const root = projectRoot(project);
  const dir = treeDirOf(project);
  fs.mkdirSync(dir, { recursive: true });

  const table = readJson(path.join(root, "章节", "章节表.json"))?.chapters ?? [];
  const oldIndex = readJson(treeIndexFileOf(project));
  const oldFps = new Map((oldIndex?.chapters ?? []).map((c) => [c.num, c.fingerprint]));

  const chapters = [];
  let rebuilt = 0, skipped = 0;

  for (const c of table) {
    const num = c.num ?? c.number;
    const fp = opts.force ? null : chapterFingerprint(root, num); // force → 强制重算

    // 指纹相同 → 节点复用（跳过）
    if (fp && oldFps.get(num) === fp && fs.existsSync(chapterNodeFileOf(project, num))) {
      chapters.push({ num, title: c.title ?? `第${num}章`, function: nodeFunction(root, num), fingerprint: fp });
      skipped++;
      continue;
    }

    // 重建该章节点
    const j = readJson(path.join(root, "章节", `第${pad4(num)}章.json`));
    const shotsJ = readJson(path.join(root, "分镜标注", "json", `第${pad4(num)}章.json`));
    const node = {
      schema: "dsh/chapter-node/v1",
      num,
      title: c.title ?? j?.chapter?.title ?? `第${num}章`,
      function: j?.function ?? "",
      summary: j?.summary ?? "",
      suspense: j?.suspense ?? null,
      shots: (shotsJ?.shots ?? []).map((s) => ({
        id: s.id,
        type: s.type,
        funcs: s.funcs ?? [],
        label: s.label ?? "",
        sentenceIds: s.sentenceIds ?? [],
      })),
      fingerprint: fp ?? chapterFingerprint(root, num),
    };
    fs.writeFileSync(chapterNodeFileOf(project, num), JSON.stringify(node, null, 2) + "\n", "utf-8");
    chapters.push({ num, title: node.title, function: node.function, fingerprint: node.fingerprint });
    rebuilt++;
  }

  const index = {
    schema: "dsh/chapter-tree/v1",
    book: project,
    builtAt: new Date().toISOString(),
    chapterCount: chapters.length,
    chapters, // 每章：{num, title, function, fingerprint}
    fingerprint: sha1(chapters.map((c) => c.fingerprint).join("|")), // 整树指纹
  };
  fs.writeFileSync(treeIndexFileOf(project), JSON.stringify(index, null, 2) + "\n", "utf-8");

  return { treeDir: dir, chapters: chapters.length, rebuilt, skipped, index };
}

/** 读现有章节树索引（无 → null） */
export function loadChapterTreeIndex(project) {
  return readJson(treeIndexFileOf(project));
}

/** 读单章节点（无 → null） */
export function loadChapterNode(project, num) {
  return readJson(chapterNodeFileOf(project, num));
}

function nodeFunction(root, num) {
  const j = readJson(path.join(root, "章节", `第${pad4(num)}章.json`));
  return j?.function ?? "";
}

/* ================= CLI ================= */
if (process.argv[1] && path.resolve(process.argv[1]).endsWith("chapter-tree.mjs")) {
  const argVal = (n) => {
    const a = process.argv.find((x) => x.startsWith(`--${n}=`));
    return a ? a.slice(n.length + 3) : null;
  };
  const project = argVal("project") ?? process.argv[2];
  if (!project) { console.error("用法: node features/report/chapter-tree.mjs --project=<书> [--force]"); process.exit(2); }
  try {
    const r = buildChapterTree(project, { force: process.argv.includes("--force") });
    console.log(`✅ 章节树已构建: ${r.treeDir}`);
    console.log(`   章节 ${r.chapters} | 重建 ${r.rebuilt} | 复用 ${r.skipped} | 整树指纹 ${r.index.fingerprint}`);
  } catch (e) {
    console.error(`❌ 构建失败: ${e.message}`);
    process.exit(1);
  }
}
