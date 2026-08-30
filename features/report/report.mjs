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
 *   node features/report/report.mjs --project=<书> [--out=<文件.html>]
 *   import { buildReport } from "./report.mjs"
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { projectRoot, outputDir } from "../../shared/paths.mjs";
import { loadChatConfig } from "../../shared/config.mjs";
import { buildChapterTree, loadChapterTreeIndex, loadChapterNode } from "./chapter-tree.mjs";

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; } };
const sha1 = (s) => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 16);

/** 梗概缓存文件（output/<书>/synopsis.json，带指纹：输入 summary 变了才重调 LLM） */
function synopsisCacheFile(project) {
  return path.join(outputDir, project, "synopsis.json");
}

/** 调 LLM 生成全书梗概（前 N 章 summary → 一段话），带指纹缓存 */
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

  // 调 LLM（全局 chat 配置；非流式；低温度保稳定）
  const cfg = loadChatConfig();
  const baseUrl = (cfg.baseUrl ?? "https://api.deepseek.com/v1").replace(/\/+$/, "");
  const sys = "你是小说编辑。根据给定章节的剧情摘要，用一段话（120-200 字）总结全书梗概：概括主线、核心人物与整体走向，语言精炼、客观，不罗列章节。";
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      stream: false,
      temperature: 0.3,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: `《${project}》前 ${picked.length} 章摘要：\n${inputText}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = (data.choices?.[0]?.message?.content ?? "").trim();
  if (!text) throw new Error("LLM 返回空梗概");
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
      <div class="book-title">《${esc(name)}》</div>
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
  askResult.innerHTML = '<div class="muted">正在定位…</div>';
  try {
    const r = await fetch(\`/api/report/\${encodeURIComponent(BOOK)}/ask\`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q }),
    });
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
    askResult.innerHTML = \`<div class="err">请求失败：\${esc2(e.message)}</div>\`;
  }
}
</script>`;

  return { html, project: name, root, stats, tree: treeStats };
}

/* ================= CLI 自检 ================= */
if (process.argv[1] && path.resolve(process.argv[1]).endsWith("report.mjs")) {
  const argVal = (n) => {
    const a = process.argv.find((x) => x.startsWith(`--${n}=`));
    return a ? a.slice(n.length + 3) : null;
  };
  const project = argVal("project") ?? process.argv[2];
  if (!project) { console.error("用法: node features/report/report.mjs --project=<书> [--out=<文件.html>]"); process.exit(2); }
  try {
    const { html, root, stats, tree: treeStats } = await buildReport(project);
    const out = argVal("out") ?? path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "output", `${project}-拆书地图.html`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, html, "utf-8");
    console.log(`✅ 拆书看板已生成: ${out}`);
    console.log(`   统计: ${stats.chapters} 章 / ${stats.shots} 分镜 / ${stats.sentences} 句`);
    if (treeStats && !treeStats.error) console.log(`   章节树: ${treeStats.chapters} 章（重建 ${treeStats.rebuilt}，复用 ${treeStats.skipped}）`);
  } catch (e) {
    console.error(`❌ 生成失败: ${e.message}`);
    process.exit(1);
  }
}
