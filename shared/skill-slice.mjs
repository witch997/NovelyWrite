/**
 * skill-slice.mjs — SKILL 按层切片（宿主侧解析，不改 SKILL.md 结构）
 *
 * 现状问题：每次 LLM 调用都把 语料分析-SKILL.md 全文（~20KB）作为 system prompt，
 * 而实际每次调用只需要其中「公共前缀 + 对应层契约」段落。1000 章规模下，
 * 纯 SKILL 重复开销 ~12M token。
 *
 * 方案：按 markdown 标题（## / ###）切段，每层调用只取 公共前缀 + 专属段落。
 *
 * 用法：
 *   import { loadSkillSlice } from "../shared/skill-slice.mjs";
 *   const skill = loadSkillSlice("sentence");        // 往返1
 *   const skill = loadSkillSlice("shot-chapter");    // 往返2
 *   const skill = loadSkillSlice("full");            // 全文（调试/兜底）
 *   （2026-09-04：event/volume/incremental 切片已随聚合层语义设计一并移除）
 */
import fs from "node:fs";
import path from "node:path";
import { CODE_ROOT, isSeaRuntime } from "./paths.mjs";

const SKILL_PATH = path.join(CODE_ROOT, "novelread", "specs", "语料分析-SKILL.md");
const SKILL_ASSET = "novelread/specs/语料分析-SKILL.md"; // SEA 内嵌资源键

/** 读 SKILL 全文：SEA 优先 sea.getAsset（内嵌），源码模式读磁盘 */
function readSkillText() {
  if (isSeaRuntime) {
    try {
      const sea = process.getBuiltinModule?.("node:sea"); // Node 22.3+；低版本返回 undefined
      if (sea?.getAsset) return Buffer.from(sea.getAsset(SKILL_ASSET)).toString("utf-8"); // getAsset 返回 ArrayBuffer
    } catch { /* 内嵌读取失败 → 回退磁盘 */ }
  }
  return fs.readFileSync(SKILL_PATH, "utf-8");
}

/** 按 markdown 标题切段：返回 [{title, body}]（title 含标题行，body 为后续内容直到下一标题） */
function parseSections(text) {
  const lines = text.split("\n");
  const sections = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^(#{1,3}) (.+)$/);
    if (m) {
      if (cur) sections.push(cur);
      cur = { level: m[1].length, title: line, body: [] };
    } else if (cur) {
      cur.body.push(line);
    }
  }
  if (cur) sections.push(cur);
  return sections;
}

/** 按标题文本（前缀匹配，如 "### 句子层"）取段落 */
function findSection(sections, titlePrefix) {
  return sections.find((s) => s.title.includes(titlePrefix)) ?? null;
}

/** 层 → 需要的标题前缀列表（顺序即拼接顺序；均为「公共前缀 + 专属段落」） */
const LAYER_MAP = {
  // 往返1：句子层
  sentence: [
    "## 角色与任务",
    "### 模型调用约定",
    "### 往返1：句子层",
    "### 句子层 `dsh/sentence-card/v1`",
  ],
  // 往返2：分镜层 + 章节层
  "shot-chapter": [
    "## 角色与任务",
    "### 模型调用约定",
    "### 往返2：分镜层 + 章节层",
    "### 分镜层 `dsh/shot-card/v1`",
    "### 章节层 `dsh/chapter-annotation/v1`",
  ],
  // 2026-09-04：聚合层语义切片（event/volume/incremental）已随 event/volume 设计移除
};

/**
 * 加载 SKILL 切片
 * @param {string} layer sentence | shot-chapter | full
 * @returns {string} system prompt 文本
 */
export function loadSkillSlice(layer) {
  const full = readSkillText();
  if (layer === "full") return full;
  const wanted = LAYER_MAP[layer];
  if (!wanted) throw new Error(`未知 SKILL 切片层: ${layer}（可选: ${Object.keys(LAYER_MAP).join("/")}/full）`);
  const sections = parseSections(full);
  const picked = [];
  for (const prefix of wanted) {
    const sec = findSection(sections, prefix);
    if (sec) picked.push(sec.title + "\n" + sec.body.join("\n"));
  }
  if (!picked.length) throw new Error(`SKILL 切片层 ${layer} 未匹配到任何段落（SKILL.md 结构可能已变）`);
  return picked.join("\n\n");
}

/** 调试：打印各层切片大小（字符数） */
export function debugSlices() {
  const full = readSkillText();
  console.log(`[skill-slice] SKILL 全文: ${full.length} 字符`);
  for (const layer of Object.keys(LAYER_MAP)) {
    console.log(`  ${layer}: ${loadSkillSlice(layer).length} 字符`);
  }
}
