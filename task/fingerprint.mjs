#!/usr/bin/env node
/**
 * task/fingerprint.mjs — mybook 原稿指纹（变更检测）
 *
 * 职责：扫描 mybook/<书>/第XXXX章.md → 每章正文 hash；对比 project-meta 的
 *       sourceFingerprints → 输出 changed / newChs / deleted 三分类。
 *
 * 原则：mybook 原稿 = 唯一事实源（无条件信任）。md 有章 = 该章存在；
 *       md 无章 = 该章不存在（剔除）。无第二参考系，无"误判需确认"概念。
 *
 * 指纹算法：md5(正文去空白) —— 含标点。
 *   ⚠ 必须含标点：句子切分依赖标点（往返1 按停顿标点切句），句号→逗号 = 句子边界
 *   变化 = 标注必须重跑。仅去空白防"纯空白/换行微调"误触发。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { mybookDir } from "../shared/paths.mjs";

/** 单章正文 hash（去空白，含标点） */
export function chapterHash(text) {
  const body = String(text ?? "").replace(/\s/g, "");
  return crypto.createHash("md5").update(body, "utf-8").digest("hex");
}

/**
 * 扫描 mybook 原稿全书：{ 章号 → 正文hash }（按 md 文件名 第XXXX章.md）
 * @param {string} book 书名
 * @returns {{fingerprints:Object<number,string>, missing:number[]}}
 *   fingerprints: 每章当前 hash；missing: 指纹已记录但 md 里没了的章号
 */
export function scanBookFingerprints(book, prevFingerprints = {}) {
  const dir = path.join(mybookDir, book);
  const fingerprints = {};
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^第(\d{4})章\.md$/);
      if (!m) continue;
      const num = Number(m[1]);
      try {
        const text = fs.readFileSync(path.join(dir, f), "utf-8");
        fingerprints[num] = chapterHash(text);
      } catch { /* 读取失败跳过该章 */ }
    }
  }
  // deleted：指纹记录过但 md 里没了（无条件信任原稿 → 该章已不存在）
  const missing = Object.keys(prevFingerprints ?? {})
    .map(Number)
    .filter((n) => !(n in fingerprints));
  return { fingerprints, missing };
}

/**
 * 对比新旧指纹 → 三分类
 * @param {Object<number,string>} prev 旧指纹（project-meta.sourceFingerprints）
 * @param {Object<number,string>} cur  新指纹（当前 md）
 * @returns {{changed:number[], newChs:number[], deleted:number[]}}
 */
export function diffFingerprints(prev = {}, cur = {}) {
  const changed = [], newChs = [], deleted = [];
  for (const [n, h] of Object.entries(cur)) {
    const num = Number(n);
    if (!(num in prev)) newChs.push(num);       // 指纹不存在 = 新增章
    else if (prev[num] !== h) changed.push(num); // hash 不同 = 内容变了
  }
  for (const n of Object.keys(prev)) {
    if (!(n in cur)) deleted.push(Number(n));    // md 没了 = 删除章
  }
  return { changed, newChs, deleted };
}

/** 读 project-meta 的 sourceFingerprints（不存在返回空对象） */
export function readFingerprints(projectDir) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(projectDir, "project-meta.json"), "utf-8"));
    return meta.sourceFingerprints ?? {};
  } catch { return {}; }
}

/** 写 project-meta 的 sourceFingerprints（合并写入，保留其他字段） */
export function writeFingerprints(projectDir, fingerprints) {
  const p = path.join(projectDir, "project-meta.json");
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(p, "utf-8")); } catch { /* 不存在则新建 */ }
  meta.sourceFingerprints = fingerprints;
  meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify(meta, null, 2), "utf-8");
}
