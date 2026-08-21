/**
 * verify-json.mjs — 纯语法 JSON 校验器（无任何语义判断）
 *
 * 定位：回答唯一问题"JSON 文件格式合法吗"。不校验枚举/长度/覆盖/一致性——
 * 语义与契约校验归 check-chapter.mjs（全书模式）与确定性聚合脚本（aggregates.mjs），本器不越界。
 *
 * 检查点（RFC 8259 严格子集）：
 *   1. 可解析（引号/括号/冒号/逗号配对、字符串转义正确）
 *   2. 字符串内无裸换行/裸控制字符（LLM 长输出最常见错误）
 *   3. 对象内无重复键（JSON.parse 静默取后者，掩盖错误）
 *   4. 无尾逗号（对象/数组）
 *   5. 根节点为对象（store 下所有 JSON 根均为对象）
 *   6. 顶层无多余内容
 *
 * 用法：
 *   node novelread/verify-json.mjs [project]     # 批量巡检 store/<project>/ 全部 .json（默认红楼梦）
 *   node novelread/verify-json.mjs [project] --list   # 仅列出非法文件，不打印详情
 *
 * 程序化复用（落盘 gate）：
 *   import { checkJsonText } from "./verify-json.mjs";
 *   const r = checkJsonText(text);   // {ok:true} | {ok:false, kind, pos, line, col}
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { projectRoot } from "../shared/paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ================= 严格 JSON 解析器（递归下降） ================= */

function makeParser(text) {
  let i = 0;
  const n = text.length;
  const loc = (p) => {
    const before = text.slice(0, p);
    const line = before.split("\n").length;
    const col = p - before.lastIndexOf("\n");
    return { pos: p, line, col };
  };
  const fail = (kind, p) => { throw Object.assign(new Error(kind), { kind, ...loc(p) }); };
  const skipWs = () => { while (i < n && " \t\r\n".includes(text[i])) i++; };
  const expect = (ch) => { if (text[i] !== ch) fail(`期望 "${ch}"，实际 "${text[i] ?? "结尾"}"`, i); i++; };

  /** 字符串：严格转义；裸控制字符（含换行）报错 */
  function parseString() {
    expect('"');
    let s = "";
    while (i < n) {
      const c = text[i];
      if (c === '"') { i++; return s; }
      if (c === "\\") {
        i++;
        const e = text[i];
        if (e === undefined) fail("转义序列未闭合", i);
        if ('"\\/bfnrt'.includes(e)) { s += e; i++; continue; }
        if (e === "u") {
          const hex = text.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("\\u 转义需 4 位十六进制", i);
          s += String.fromCharCode(parseInt(hex, 16));
          i += 5;
          continue;
        }
        fail(`非法转义 "\\${e}"`, i);
      }
      const code = c.charCodeAt(0);
      if (code < 0x20) fail(c === "\n" ? "字符串内裸换行" : c === "\r" ? "字符串内裸回车" : "字符串内裸控制字符", i);
      s += c;
      i++;
    }
    fail("字符串未闭合", i);
  }

  function parseNumber() {
    const start = i;
    if (text[i] === "-") i++;
    if (text[i] === "0") i++;
    else if (/[1-9]/.test(text[i] ?? "")) { while (/[0-9]/.test(text[i] ?? "")) i++; }
    else fail("数字格式非法", i);
    if (text[i] === ".") { i++; if (!/[0-9]/.test(text[i] ?? "")) fail("小数缺少尾随数字", i); while (/[0-9]/.test(text[i] ?? "")) i++; }
    if (text[i] !== undefined && "eE".includes(text[i])) {
      i++;
      if ("+-".includes(text[i] ?? "")) i++;
      if (!/[0-9]/.test(text[i] ?? "")) fail("指数缺少数字", i);
      while (/[0-9]/.test(text[i] ?? "")) i++;
    }
    return text.slice(start, i);
  }

  function parseLiteral(word) {
    if (text.slice(i, i + word.length) !== word) fail(`非法字面量，期望 "${word}"`, i);
    i += word.length;
    return word === "true" ? true : word === "false" ? false : null;
  }

  function parseValue() {
    skipWs();
    const c = text[i];
    if (c === undefined) fail("值未闭合（提前结尾）", i);
    if (c === "{") return parseObject();
    if (c === "[") return parseArray();
    if (c === '"') return parseString();
    if (c === "-" || /[0-9]/.test(c)) return parseNumber();
    if (text.startsWith("true", i)) return parseLiteral("true");
    if (text.startsWith("false", i)) return parseLiteral("false");
    if (text.startsWith("null", i)) return parseLiteral("null");
    fail(`非法字符 "${c}"`, i);
  }

  function parseObject() {
    expect("{");
    const keys = new Set();
    const obj = {};
    skipWs();
    if (text[i] === "}") { i++; return obj; }
    for (;;) {
      skipWs();
      if (text[i] !== '"') fail("对象键必须为字符串", i);
      const key = parseString();
      if (keys.has(key)) fail(`重复键 "${key}"`, i);
      keys.add(key);
      skipWs();
      expect(":");
      obj[key] = parseValue();
      skipWs();
      const c = text[i];
      if (c === ",") {
        i++;
        skipWs();
        if (text[i] === "}") fail("对象尾逗号", i);
        continue;
      }
      if (c === "}") { i++; return obj; }
      fail(`对象内期望 "," 或 "}"，实际 "${c ?? "结尾"}"`, i);
    }
  }

  function parseArray() {
    expect("[");
    const arr = [];
    skipWs();
    if (text[i] === "]") { i++; return arr; }
    for (;;) {
      arr.push(parseValue());
      skipWs();
      const c = text[i];
      if (c === ",") {
        i++;
        skipWs();
        if (text[i] === "]") fail("数组尾逗号", i);
        continue;
      }
      if (c === "]") { i++; return arr; }
      fail(`数组内期望 "," 或 "]"`, i);
    }
  }

  return { parseValue, skipWs, fail, loc, end: () => i, len: n };
}

/**
 * 严格校验一段 JSON 文本。
 * @returns {{ok:true, root:any}} | {{ok:false, kind:string, pos:number, line:number, col:number}}
 */
export function checkJsonText(text) {
  try {
    const p = makeParser(text);
    const root = p.parseValue();
    p.skipWs();
    if (p.end() !== p.len) p.fail(`顶层多余内容 "${text[p.end()]}"`, p.end());
    if (root === null || typeof root !== "object" || Array.isArray(root)) {
      p.fail("根节点必须为对象", 0);
    }
    return { ok: true, root };
  } catch (e) {
    if (e && typeof e === "object" && e.kind) {
      return { ok: false, kind: e.kind, pos: e.pos, line: e.line, col: e.col };
    }
    return { ok: false, kind: "解析异常", pos: 0, line: 1, col: 1 };
  }
}

/* ================= CLI 批量巡检 ================= */

function walkJson(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkJson(p));
    else if (e.name.endsWith(".json")) out.push(p);
  }
  return out.sort();
}

function main() {
  const args = process.argv.slice(2);
  const project = args.find((a) => !a.startsWith("--")) ?? "大王饶命";
  const listOnly = args.includes("--list");
  const projectDir = projectRoot(project); // 域感知：两域自动探测
  if (!fs.existsSync(projectDir)) { console.error(`project 不存在: ${projectDir}`); process.exit(2); }

  const files = walkJson(projectDir);
  console.log(`\n========== 语法校验：${project}（${files.length} 个 JSON）==========\n`);

  const bad = [];
  for (const f of files) {
    const rel = f.replace(projectDir + path.sep, "").replaceAll("\\", "/");
    let text;
    try { text = fs.readFileSync(f, "utf-8"); }
    catch { bad.push({ rel, kind: "文件不可读", pos: 0, line: 0, col: 0 }); continue; }
    const r = checkJsonText(text);
    if (!r.ok) bad.push({ rel, ...r });
  }

  if (bad.length === 0) {
    console.log(`✅ 全部 ${files.length} 个 JSON 语法合法`);
    process.exit(0);
  }
  console.log(`❌ ${bad.length} 个文件语法非法:`);
  for (const b of bad) {
    if (listOnly) { console.log(`  ${b.rel}  [${b.kind}]`); continue; }
    console.log(`  ${b.rel}`);
    console.log(`      错误: ${b.kind} @ 行${b.line}:列${b.col}（offset ${b.pos}）`);
  }
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith(".mjs") && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
