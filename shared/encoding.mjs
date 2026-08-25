#!/usr/bin/env node
/**
 * shared/encoding.mjs — 语料文件编码检测与强制转换（导入链路防乱码）
 *
 * 背景：桌面 txt 语料多为 GBK/GB2312（Windows 简体中文默认 ANSI），而系统内部
 *       全链路 UTF-8。若直接按 UTF-8 读 GBK 字节 → 无效字节变 U+FFFD（�），
 *       且一旦损坏信息不可逆。因此导入时必须拿到【原始字节】做编码判定：
 *         1. 严格 UTF-8 解码成功 → 原样使用（已是 UTF-8）
 *         2. 否则按 GBK 解码 → 转成 UTF-8 文本（强制转换）
 *         3. 两者都失败 / 仍含替换符 → 明确报错（防坏数据入库）
 *
 * 用法（配合前端传 base64 原始字节）：
 *   import { decodeTextBuffer, countReplacement, isLikelyMojibake } from "./shared/encoding.mjs";
 *   const r = decodeTextBuffer(Buffer.from(b64, "base64"));
 *   if (!r.ok) throw ...; // 无法识别编码
 *   fs.writeFileSync(path, r.text, "utf-8");
 */
// TextDecoder 是 Node 全局对象（node:util 导出同名），直接使用全局即可（SEA rollup 打包无需 external 处理）
import fs from "node:fs"; // CLI 自检用（模块被 import 时不触发，SEA 打包 node:fs 走 external）

/** 统计文本中 U+FFFD 替换符数量（判断是否已损坏） */
export function countReplacement(text) {
  if (typeof text !== "string") return 0;
  let n = 0;
  for (const ch of text) if (ch === "\uFFFD") n++;
  return n;
}

/**
 * 判断文本是否"已损坏"：含任意 U+FFFD 即视为损坏（正常小说文本不会含替换符；
 * FFFD 只可能是编码转换失败的产物，一旦出现信息已不可恢复）
 * @param {string} text
 * @param {number} threshold 保留参数（默认 0 = 任何 FFFD 都拒绝；可放宽但一般不需要）
 */
export function isLikelyMojibake(text, threshold = 0) {
  if (!text) return false;
  const repl = countReplacement(text);
  if (!repl) return false;
  return repl / Math.max(1, text.length) > threshold;
}

/**
 * 原始字节 → 检测编码并转 UTF-8 文本（导入链路唯一入口）
 * @param {Buffer|Uint8Array} buf 文件原始字节（必须未经过任何字符串解码）
 * @returns {{ok:true, text:string, encoding:"utf-8"|"gbk", converted:boolean, note?:string}
 *          |{ok:false, error:string}}
 */
export function decodeTextBuffer(buf) {
  if (!buf || !buf.length) return { ok: false, error: "文件为空（0 字节）" };
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  // 1. 严格 UTF-8：能完整解码 → 原样使用（含纯 ASCII / UTF-8 中文）
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    // 严格解码通过但仍有替换符（文件内本身就写了 U+FFFD）→ 视为已损坏，拒绝入库
    if (isLikelyMojibake(text)) {
      return { ok: false, error: `文件已损坏：含 ${countReplacement(text)} 处乱码（U+FFFD），无法恢复。请提供原始文本文件重试。` };
    }
    return { ok: true, text, encoding: "utf-8", converted: false, note: "UTF-8" };
  } catch {
    /* 非法 UTF-8（典型：GBK 中文双字节序列）→ 走 GBK 强制转换 */
  }
  // 2. GBK 解码（Windows 简体中文默认 ANSI / GB2312 超集）
  try {
    const text = new TextDecoder("gbk").decode(bytes);
    if (isLikelyMojibake(text)) {
      return { ok: false, error: `无法识别文件编码：GBK 解码后仍含 ${countReplacement(text)} 处乱码。请将文件另存为 UTF-8 编码后重试。` };
    }
    // 兜底启发：GBK 解码成功但结果几乎无汉字（说明原文件可能不是中文 GBK 文本）
    const hasCjk = /[\u4e00-\u9fff]/.test(text);
    if (text.trim() && !hasCjk) {
      return { ok: false, error: "无法识别文件编码（既非有效 UTF-8，GBK 解码结果也非中文文本）。请确认文件为 UTF-8 或 GBK 编码的纯文本。" };
    }
    return { ok: true, text, encoding: "gbk", converted: true, note: "GBK→UTF-8 已自动转换" };
  } catch (e) {
    return { ok: false, error: `编码检测失败：${e.message ?? e}` };
  }
}

/**
 * 对已读出的文本做"入库前体检"：含乱码即拒绝（用于 mybook md 等文本路径）
 * @param {string} text
 * @returns {{ok:true}|{ok:false, error:string}}
 */
export function checkTextHealthy(text, source = "文本") {
  const n = countReplacement(text);
  if (n > 0) {
    return { ok: false, error: `${source}含 ${n} 处乱码（U+FFFD），已拒绝入库。请将源文件转为 UTF-8 后重试。` };
  }
  return { ok: true };
}

/* ---------- 命令行自检：node shared/encoding.mjs <file> ---------- */
if (process.argv[1] && process.argv[1].endsWith("encoding.mjs")) {
  const file = process.argv[2];
  if (!file) {
    console.log("用法: node shared/encoding.mjs <file>   # 检测文件编码（UTF-8/GBK）并输出转换结果");
    process.exit(0);
  }
  const buf = fs.readFileSync(file);
  const r = decodeTextBuffer(buf);
  if (!r.ok) {
    console.error(`✗ ${r.error}`);
    process.exit(1);
  }
  console.log(`✓ ${r.note}（${buf.length} 字节 → ${Buffer.byteLength(r.text, "utf-8")} 字节 UTF-8）`);
  console.log(r.text.slice(0, 500));
  process.exit(0);
}
