#!/usr/bin/env node
/**
 * report.mjs — 拆书看板生成器（features/report 模块）
 *
 * 输出：自包含 HTML（NovelyWrite 浅色风格）——纯程序投影，零 LLM，幂等。
 *
 * 页面结构（精简版）：
 *   顶栏：书名 + 统计
 *   全书梗概：一段概括全书的话（优先卷纲 goal——刮削器式：把散落元数据聚合为简介）
 *   统计卡：章节数 / 分镜数 / 句子数（无平均、无悬念）
 *   页脚
 *
 * 原则：summary 是唯一权威事实；本模块只投影不篡改；缺数据段自动降级。
 *
 * 用法：
 *   import { buildReport } from "./report.mjs"
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { projectRoot, outputDir } from "../../shared/paths.mjs";
import { loadChatConfig } from "../../shared/config.mjs";
import { buildChapterTree, loadChapterTreeIndex, loadChapterNode } from "./chapter-tree.mjs";

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; } };
const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 16);

/** 梗概缓存文件（output/<书>/synopsis.json，带指纹：输入 summary 变了才重调 LLM） */
function synopsisCacheFile(project) {
  return path.join(outputDir, project, "synopsis.json");
}

/** 调 LLM 生成全书梗概：联网搜索作品信息 + 前 N 章 summary → 一段话（指纹缓存） */
async function buildSynopsis(project, nodes) {
  const SYNOPSIS_CHAPTERS = 10;
  const picked = nodes.slice(0, SYNOPSIS_CHAPTERS);
  const inputText = picked
    .map((n) => `第${n.num}章 ${String(n.summary ?? "").replace(/\s+/g, " ").trim()}`)
    .filter((s) => s.trim().length > 4)
    .join("\n");
  if (!inputText.trim()) return { text: "", from: "none" };

  const fp = sha1(inputText);
  const cache = readJson(synopsisCacheFile(project));
  if (cache?.fingerprint === fp && cache?.text) return { text: cache.text, from: "cache" };

  // 一次调用：联网搜索（解决模型知识时效）+ 前 10 章摘要 → 500 字全书梗概
  // 目的：联网主要解决"大模型训练数据不更新"的时效问题；梗概 500 字左右、基本准确即可，不做严格结构约束
  const cfg = loadChatConfig();
  const baseUrl = "https://api.deepseek.com/anthropic/v1"; // Messages API 端点（与 chat/completions 不同）
  const sys = `你是小说编辑。为《${project}》生成全书梗概。
先联网搜索这部作品的题材与简介（忽略学术会议、研究动态类信息），再结合前 ${picked.length} 章剧情摘要综合概括。
要求：500 字左右；纯文字输出（不要标题/列表/加粗）；不介绍作者生平；概括主线、核心人物、故事走向，基本准确即可。`;
  const res = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiKey,
      "Authorization": `Bearer ${cfg.apiKey}`,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: 4096,
      temperature: 0.8, // 较高温度 → 凝练综述而非机械罗列
      messages: [{
        role: "user",
        content: [{ type: "text", text: `搜索《${project}》的题材简介，结合前 ${picked.length} 章剧情摘要生成全书梗概。输出约 500 字（400-650 字），纯文字，不介绍作者生平。\n\n${inputText}` }],
      }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
    }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  // Messages 响应：text block 即梗概（搜索结果为 web_search_tool_result block，不计入）
  const raw = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
  if (!raw) throw new Error("LLM 返回空梗概");
  // 轻清理（仅去 markdown 标记让显示干净，不截断——字数由 prompt 控制，直出 LLM 原文）
  const text = raw
    .replace(/^#{1,6}\s*.*$/gm, "")        // 去标题行
    .replace(/^\s*(?:[-*|>\d.]+)\s+/gm, "") // 去列表/表格标记
    .replace(/^>\s*/gm, "")                 // 去引用
    .replace(/\*\*/g, "")                   // 去粗体标记
    .replace(/\n{2,}/g, "\n")
    .replace(/\n/g, "")                     // 合并为连续文本
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!text) throw new Error("LLM 返回空梗概（清理后为空）");
  fs.mkdirSync(path.dirname(synopsisCacheFile(project)), { recursive: true });
  fs.writeFileSync(synopsisCacheFile(project), JSON.stringify({ fingerprint: fp, text, builtAt: new Date().toISOString() }, null, 2) + "\n", "utf-8");
  return { text, from: "llm" };
}

/**
 * 生成拆书看板 HTML
 * @param {string} project 书名（域自动探测：my 优先）
 * @returns {{html: string, project: string, root: string, stats: object, tree: object}}
 */
export async function buildReport(project) {
  const root = projectRoot(project); // 不存在会抛 PROJECT_NOT_FOUND
  const name = project;

  // 章节树：拆书时增量构建（单章指纹，只重建变了的章节点）
  let treeStats = null;
  try { treeStats = buildChapterTree(project); } catch (e) { treeStats = { error: e.message }; }

  /* ---------- 数据装配（章节树 + 卷纲） ---------- */
  const index = loadChapterTreeIndex(project);
  const nodes = (index?.chapters ?? [])
    .map((c) => loadChapterNode(project, c.num))
    .filter(Boolean);
  const volume = readJson(path.join(root, "卷纲", "volume.json"));
  const targets = volume?.targets ?? [];
  const mainTarget = targets.find((t) => t.isMain) ?? null;

  const chapterCount = nodes.length;
  const shotCount = nodes.reduce((a, n) => a + (n.shots?.length ?? 0), 0);
  // 句子 id 每章重新编号（S1-S65），跨章不可全局去重 → 按章去重再累加
  const sentenceCount = nodes.reduce((a, n) => a + new Set((n.shots ?? []).flatMap((s) => s.sentenceIds ?? [])).size, 0);

  // 全书梗概：LLM 总结前 10 章 summary（不足取全部），指纹缓存（summary 变了才重调）
  let synopsis = "", synopsisError = null;
  try {
    const r = await buildSynopsis(name, nodes);
    synopsis = r.text;
  } catch (e) { synopsisError = e.message; }

  const stats = { chapters: chapterCount, shots: shotCount, sentences: sentenceCount, mainTarget };

  /* ================= HTML 组装（NovelyWrite 浅色风格，精简看板） ================= */
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const html = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>拆书看板 · ${esc(name)}</title>
<style>
/* ===== NovelyWrite / DSH 浅色风格 ===== */
:root{
  --n-50:#f8fafc;--n-75:#f1f5f9;--n-100:#e9eef5;--n-150:#dfe6ef;--n-200:#d3dbe6;
  --n-300:#b8c3d2;--n-400:#94a3b8;--n-500:#7587a0;--n-600:#5c6f88;--n-700:#47586f;
  --n-750:#39495e;--n-800:#2d3b4d;--n-850:#232f3e;--n-900:#1a2430;--n-950:#10161f;
  --brand-100:#dbeafe;--brand-400:#4176e6;--brand-500:#2563eb;--brand-600:#1d4ed8;
  --ease:cubic-bezier(.4,0,.2,1);--dur:.2s;--radius:8px;--radius-sm:6px;
  --shadow-sm:0 1px 2px rgba(16,22,31,.06);--shadow-md:0 4px 16px rgba(16,22,31,.1);
}
body[data-theme="light"]{
  --bg-base:var(--n-50);--bg-module:#fff;--bg-hover:var(--n-75);--bg-active:var(--brand-100);
  --border:var(--n-150);--border-strong:var(--n-200);
  --label-primary:var(--n-950);--label-secondary:var(--n-700);--label-tertiary:var(--n-400);
  --brand:var(--brand-500);--brand-hover:var(--brand-600);
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;background:var(--bg-base);color:var(--label-primary);min-height:100vh;-webkit-font-smoothing:antialiased}

main{max-width:760px;margin:0 auto;padding:44px 24px 60px}

/* 书名（全书梗概栏内） */
.book-title{font-size:26px;font-weight:700;letter-spacing:2px;margin-bottom:14px}

/* 全书梗概 */
.synopsis{background:var(--bg-module);border:1px solid var(--border);border-radius:var(--radius);padding:24px 28px;margin-bottom:26px;box-shadow:var(--shadow-sm)}
.synopsis .b{font-size:15px;line-height:2.1;color:var(--label-primary)}
.synopsis .b.empty{color:var(--label-tertiary);font-size:13px}

/* 统计卡 */
.stat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.stat-card{background:var(--bg-module);border:1px solid var(--border);border-radius:var(--radius);padding:28px 14px;text-align:center;box-shadow:var(--shadow-sm)}
.stat-card .v{font-size:42px;font-weight:700;color:var(--brand);letter-spacing:1px}
.stat-card .k{font-size:14px;color:var(--label-secondary);margin-top:8px}

/* 问答定位 */
.ask{background:var(--bg-module);border:1px solid var(--border);border-radius:var(--radius);padding:18px 22px;margin-top:26px;box-shadow:var(--shadow-sm)}
.ask .t{font-size:12px;font-weight:600;color:var(--label-tertiary);letter-spacing:1px;margin-bottom:10px}
.ask-row{display:flex;gap:8px}
.ask input{flex:1;background:var(--n-50);color:var(--label-primary);border:1px solid var(--border);border-radius:var(--radius-sm);padding:9px 12px;font-size:14px;font-family:inherit;outline:none}
.ask input:focus{border-color:var(--brand)}
.ask button{background:var(--brand);color:#fff;border:none;border-radius:var(--radius-sm);padding:9px 18px;font-size:14px;cursor:pointer;font-family:inherit}
.ask button:hover{background:var(--brand-hover)}
.ask-result{margin-top:12px;font-size:13.5px;line-height:1.8}
.ask-result .hit{background:var(--bg-active);border-radius:6px;padding:8px 12px;margin-bottom:6px}
.ask-result .hit b{color:var(--brand)}
.ask-result .reason{color:var(--label-secondary);font-size:12.5px}
.ask-result .answer{background:var(--n-50);border-left:3px solid var(--brand);padding:10px 14px;border-radius:6px;margin-bottom:8px}
.ask-result .err{color:var(--red-500);font-size:13px}
.ask-result .muted{color:var(--label-tertiary);font-size:12px}

.footer{text-align:center;color:var(--label-tertiary);font-size:11px;margin-top:36px}
</style>
</head>
<body data-theme="light">
  <main>
    <!-- 全书梗概（书名在栏内，无灰色小标题） -->
    <div class="synopsis">
      <div class="book-title">${esc(name.includes("《") ? name : `《${name}》`)}</div>
      <div class="b${synopsis ? "" : " empty"}">${synopsis ? esc(synopsis) : "（梗概生成失败" + (synopsisError ? "：" + esc(synopsisError) : "") + "）"}</div>
    </div>

    <!-- 统计卡 -->
    <div class="stat-grid">
      <div class="stat-card"><div class="v">${stats.chapters}</div><div class="k">章节</div></div>
      <div class="stat-card"><div class="v">${stats.shots}</div><div class="k">分镜</div></div>
      <div class="stat-card"><div class="v">${stats.sentences}</div><div class="k">句子</div></div>
    </div>

    <!-- 问答定位 -->
    <div class="ask">
      <div class="t">定位章节 · 提问</div>
      <div class="ask-row">
        <input id="askInput" placeholder="如：上校的真实身份是什么？" onkeydown="if(event.key==='Enter')ask()">
        <button onclick="ask()">定位</button>
      </div>
      <div class="ask-result" id="askResult"></div>
    </div>

    <div class="footer">NovelyWrite · 拆书看板 · 章节树 chapter-tree · summary 为唯一权威事实 · 纯程序投影</div>
  </main>
<script>
const BOOK = ${JSON.stringify(name).replace(/</g, "\\u003c")};
const askInput = document.getElementById("askInput");
const askResult = document.getElementById("askResult");
const esc2 = (s) => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
async function ask() {
  const q = askInput.value.trim();
  if (!q) return;
  // 静态预览模式（双击打开 file://）无 API，提示正确访问方式
  if (location.protocol === "file:") {
    askResult.innerHTML = \`<div class="err">静态预览模式无法提问。请先启动服务，再访问：<br><span class="muted">node server.mjs → http://127.0.0.1:3081/api/report/\${encodeURIComponent(BOOK)}</span></div>\`;
    return;
  }
  askResult.innerHTML = '<div class="muted">正在定位…</div>';
  try {
    const r = await fetch(\`/api/report/\${encodeURIComponent(BOOK)}/ask\`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q }),
    });
    if (!r.ok) throw new Error(\`HTTP \${r.status}\`);
    const j = await r.json();
    let html = "";
    if (j.refined?.answer) html += \`<div class="answer">\${esc2(j.refined.answer)}</div>\`;
    if (j.refined?.chapters?.length) {
      html += j.refined.chapters.map((c) => \`<div class="hit"><b>第\${c.num}章</b> \${esc2(c.reason ?? "")}</div>\`).join("");
    } else if (j.candidates?.length) {
      html += \`<div class="muted">LLM 未精筛，粗筛候选 \${j.candidates.length} 章：\${j.candidates.slice(0,5).map(c=>"第"+c.num+"章").join("、")}</div>\`;
    }
    if (!html) html = \`<div class="err">\${esc2(j.error ?? "无结果")}</div>\`;
    askResult.innerHTML = html;
  } catch (e) {
    askResult.innerHTML = \`<div class="err">请求失败：\${esc2(e.message)}<br><span class="muted">请确认服务已启动（node server.mjs，端口 3081）</span></div>\`;
  }
}
</script>`;

  return { html, project: name, root, stats, tree: treeStats };
}
