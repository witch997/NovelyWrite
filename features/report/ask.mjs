#!/usr/bin/env node
/**
 * ask.mjs — 拆书问答定位（features/report 模块）
 *
 * 两级定位：
 *   ① 程序粗筛（零 LLM，毫秒级）：问题关键词 → 在章节树元数据（title/function/summary/shots.label）匹配
 *   ② LLM 精筛（一次调用）：粗筛候选章的 summary → LLM 选最相关 N 章 + 给出定位说明
 *
 * 设计原则：
 *   - 树是"元数据索引"：粗筛只扫树节点（summary/分镜 label），不读全文
 *   - LLM 只吃候选摘要，不吃全书——token 可控（粗筛后通常 <30 章候选）
 *   - 无树时自动建树（buildChapterTree 增量）
 *
 * 用法：
 *   node features/report/ask.mjs --project=<书> --q="问题"
 *   import { locateQuestions } from "./ask.mjs"
 */
import path from "node:path";
import { loadChatConfig } from "../../shared/config.mjs";
import { buildChapterTree, loadChapterTreeIndex, loadChapterNode } from "./chapter-tree.mjs";

/** 粗筛：关键词在章节元数据中匹配 → 候选章（含命中分镜/句子引用） */
export function coarseFilter(project, question, opts = {}) {
  const topk = opts.topk ?? 30;
  const index = loadChapterTreeIndex(project);
  if (!index) { buildChapterTree(project); return coarseFilter(project, question, opts); }

  // 关键词：去掉常见停用词，按 2+ 字片段切（中文无空格，按整句匹配 + 双字片段）
  const q = String(question ?? "").replace(/[？?。！!，,、\s]/g, "");
  if (!q) return [];
  const keys = [];
  // 整句 + 4字/2字滑动片段作为匹配键
  keys.push(q);
  for (let i = 0; i <= q.length - 4; i++) keys.push(q.slice(i, i + 4));
  const uniqKeys = [...new Set(keys)];

  const scored = [];
  for (const c of index.chapters) {
    const node = loadChapterNode(project, c.num);
    if (!node) continue;
    const title = node.title ?? "";
    const fn = node.function ?? "";
    const summary = node.summary ?? "";
    const labels = (node.shots ?? []).map((s) => s.label ?? "").join(" ");
    let score = 0;
    for (const k of uniqKeys) {
      if (title.includes(k)) score += 5;
      if (summary.includes(k)) score += 3;
      if (labels.includes(k)) score += 2;
      if (fn.includes(k)) score += 1;
    }
    if (score > 0) scored.push({ num: node.num, title, function: fn, summary, score, shotCount: (node.shots ?? []).length });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, topk);
}

/** LLM 精筛：候选章 → 定位结果 */
async function refineWithLLM(project, candidates, question) {
  const cfg = loadChatConfig();
  const baseUrl = (cfg.baseUrl ?? "https://api.deepseek.com/v1").replace(/\/+$/, "");
  const sys = `你是小说检索助手。根据用户问题，从给定候选章节中选出最相关的章节，输出 JSON：
{"chapters":[{"num":章号,"reason":"为什么相关"}], "answer":"对问题的简要回答（如有把握）"}
只输出 JSON。`;

  const candText = candidates
    .map((c) => `第${c.num}章 ${c.title}（${c.function}）：${String(c.summary ?? "").slice(0, 80)}`)
    .join("\n");

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model, stream: false, temperature: 0.2,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: `问题：${question}\n候选章节：\n${candText}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const data = await res.json();
  const text = (data.choices?.[0]?.message?.content ?? "").trim();
  // 解析 JSON（容忍代码块包裹）
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("LLM 未返回 JSON");
  return JSON.parse(m[0]);
}

/**
 * 问答定位主入口
 * @param {string} project 书名
 * @param {string} question 用户问题
 * @returns {{question, candidates:[], refined:object|null, error:string|null}}
 */
export async function locateQuestions(project, question) {
  buildChapterTree(project); // 确保树最新（增量）
  const candidates = coarseFilter(project, question);
  if (!candidates.length) return { question, candidates: [], refined: null, error: "粗筛无命中（尝试换关键词）" };

  let refined = null, error = null;
  try { refined = await refineWithLLM(project, candidates.slice(0, 20), question); }
  catch (e) { error = e.message; }

  return { question, candidates, refined, error };
}

/* ================= CLI ================= */
if (process.argv[1] && path.resolve(process.argv[1]).endsWith("ask.mjs")) {
  const argVal = (n) => {
    const a = process.argv.find((x) => x.startsWith(`--${n}=`));
    return a ? a.slice(n.length + 3) : null;
  };
  const project = argVal("project") ?? process.argv[2];
  const q = argVal("q") ?? process.argv[3];
  if (!project || !q) { console.error("用法: node features/report/ask.mjs --project=<书> --q=\"问题\""); process.exit(2); }
  try {
    const r = await locateQuestions(project, q);
    console.log(`问题: ${r.question}`);
    console.log(`粗筛候选: ${r.candidates.length} 章`);
    if (r.candidates.length) console.log(`  候选: ${r.candidates.slice(0, 8).map((c) => `第${c.num}章(${c.score})`).join(" ")}`);
    if (r.refined) {
      console.log(`精筛结果:`);
      for (const ch of r.refined.chapters ?? []) console.log(`  → 第${ch.num}章: ${ch.reason}`);
      if (r.refined.answer) console.log(`回答: ${r.refined.answer}`);
    }
    if (r.error) console.log(`精筛错误: ${r.error}`);
  } catch (e) {
    console.error(`❌ 失败: ${e.message}`);
    process.exit(1);
  }
}
