#!/usr/bin/env node
/**
 * report.mjs — 拆书数据看板生成器（features/report 模块）
 *
 * 输入：章节树（chapter-tree/，构建时增量更新）+ store（卷纲）
 * 输出：一份自包含 HTML（NovelyWrite 浅色风格，数据看板）——纯程序投影，零 LLM，幂等。
 *
 * 看板内容：
 *   ① 统计卡：章节数 / 分镜数 / 句子数（+ 每章平均）
 *   ② 分布：章节 function 分布（开端/推进/爆发…）、分镜 type 分布、悬念章数
 *   ③ 主线卡（卷纲 isMain）
 *   ④ 章节列表：每章卡可展开（summary + 分镜列表，分镜含句子数徽章）
 *
 * 原则：summary 是唯一权威事实；本模块只投影不篡改；缺数据段自动降级。
 *
 * 用法：
 *   node features/report/report.mjs --project=<书> [--out=<文件.html>]   # CLI 自检
 *   import { buildReport } from "./report.mjs"                           # server 调用
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { projectRoot } from "../../shared/paths.mjs";
import { buildChapterTree, loadChapterTreeIndex, loadChapterNode } from "./chapter-tree.mjs";

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; } };

/**
 * 生成拆书数据看板 HTML
 * @param {string} project 书名（域自动探测：my 优先）
 * @returns {{html: string, project: string, root: string, stats: object, tree: object}}
 */
export function buildReport(project) {
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

  // 统计
  const chapterCount = nodes.length;
  const shotCount = nodes.reduce((a, n) => a + (n.shots?.length ?? 0), 0);
  // 句子 id 每章重新编号（S1-S65），跨章不可全局去重 → 按章去重再累加
  const sentenceCount = nodes.reduce((a, n) => a + new Set((n.shots ?? []).flatMap((s) => s.sentenceIds ?? [])).size, 0);
  const suspenseChapters = nodes.filter((n) => (n.suspense ?? []).length).length;
  const fnDist = {};
  for (const n of nodes) fnDist[n.function || "未标注"] = (fnDist[n.function || "未标注"] ?? 0) + 1;
  const typeDist = {};
  for (const n of nodes) for (const s of n.shots ?? []) typeDist[s.type || "未知"] = (typeDist[s.type || "未知"] ?? 0) + 1;

  const stats = {
    chapters: chapterCount, shots: shotCount, sentences: sentenceCount,
    suspenseChapters, mainTarget,
    avgShots: chapterCount ? (shotCount / chapterCount).toFixed(1) : 0,
    avgSentences: chapterCount ? (sentenceCount / chapterCount).toFixed(1) : 0,
  };

  /* ================= HTML 组装（数据看板，NovelyWrite 浅色风格） ================= */
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // 分布条（值 → 百分比条）
  const bar = (dist, total) => Object.entries(dist)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => {
      const pct = total ? (v / total * 100).toFixed(1) : 0;
      return `<div class="dist-row"><span class="dist-k">${esc(k)}</span><div class="dist-bar"><div class="dist-fill" style="width:${pct}%"></div></div><span class="dist-v">${v} · ${pct}%</span></div>`;
    }).join("");

  const statCard = (v, k, extra = "") => `<div class="stat-card"><div class="v">${v}</div><div class="k">${k}</div>${extra ? `<div class="x">${extra}</div>` : ""}</div>`;

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
  --green-500:#22a55d;--green-100:#dcfce7;--amber-500:#d97706;--amber-100:#fef3c7;
  --red-500:#dc2626;--red-100:#fee2e2;
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

/* 顶栏 */
.topbar{display:flex;align-items:baseline;gap:12px;padding:14px 24px;background:var(--bg-module);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:2}
.topbar .brand{font-size:16px;font-weight:600}
.topbar .brand small{color:var(--label-tertiary);font-weight:400;font-size:12px;margin-left:8px}
.topbar .stat{color:var(--label-secondary);font-size:13px;margin-left:auto}
.topbar .stat b{color:var(--label-primary)}

main{max-width:960px;margin:0 auto;padding:24px 22px 60px}

/* 统计卡 */
.stat-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:18px}
.stat-card{background:var(--bg-module);border:1px solid var(--border);border-radius:var(--radius);padding:18px 14px;text-align:center;box-shadow:var(--shadow-sm)}
.stat-card .v{font-size:30px;font-weight:700;color:var(--brand);letter-spacing:1px}
.stat-card .k{font-size:12px;color:var(--label-secondary);margin-top:4px}
.stat-card .x{font-size:11px;color:var(--label-tertiary);margin-top:6px}

/* 卡片区（分布 + 主线） */
.cards{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:18px}
@media(max-width:720px){.cards{grid-template-columns:1fr}}
.card{background:var(--bg-module);border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px;box-shadow:var(--shadow-sm)}
.card-title{font-size:13px;font-weight:600;color:var(--label-secondary);margin-bottom:12px}
.card-main{border-left:3px solid var(--brand)}
.card-main .mt{font-size:14px;font-weight:600}
.card-main .ms{display:inline-block;background:var(--bg-active);color:var(--brand);border-radius:999px;padding:0 8px;font-size:11px;margin-left:8px}
.card-main .mn{color:var(--label-tertiary);font-size:12px;margin-top:8px;line-height:1.7}

/* 分布条 */
.dist-row{display:flex;align-items:center;gap:10px;margin-bottom:7px;font-size:12px}
.dist-k{width:72px;color:var(--label-secondary);flex-shrink:0;text-align:right}
.dist-bar{flex:1;background:var(--n-100);border-radius:999px;height:14px;overflow:hidden}
.dist-fill{height:100%;background:linear-gradient(90deg,var(--brand-400),var(--brand-500));border-radius:999px;transition:width .4s var(--ease)}
.dist-v{color:var(--label-tertiary);font-size:11px;width:88px;flex-shrink:0}

/* 章节列表 */
.sec-title{font-size:15px;font-weight:600;margin:22px 2px 12px;color:var(--label-secondary)}
.chapter{background:var(--bg-module);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:8px;overflow:hidden;transition:border-color var(--dur) var(--ease),box-shadow var(--dur) var(--ease)}
.chapter:hover{border-color:var(--border-strong)}
.chapter.open{border-color:var(--brand);box-shadow:var(--shadow-md)}
.ch-head{cursor:pointer;padding:11px 16px;display:flex;align-items:center;gap:10px;user-select:none}
.ch-head .num{color:var(--label-tertiary);font-size:12px;flex-shrink:0}
.ch-head .t{font-weight:600;font-size:14px}
.ch-head .fn{background:var(--bg-active);color:var(--brand);border-radius:999px;padding:0 8px;font-size:11px;flex-shrink:0}
.ch-head .cnt{color:var(--label-tertiary);font-size:11px;flex-shrink:0}
.ch-head .arrow{margin-left:auto;color:var(--label-tertiary);transition:transform var(--dur) var(--ease)}
.chapter.open .ch-head .arrow{transform:rotate(90deg)}
.ch-body{display:none;border-top:1px solid var(--border)}
.chapter.open .ch-body{display:block}
.ch-summary{padding:12px 16px;font-size:13.5px;line-height:1.85;color:var(--label-secondary);background:var(--n-50)}
.shots{padding:8px 12px 12px}
.shot{display:inline-block;background:var(--n-75);border:1px solid var(--border);border-radius:6px;padding:3px 10px;font-size:12px;margin:3px;color:var(--label-secondary)}
.shot .st{color:var(--brand);font-weight:600;margin-right:4px}
.no-data{color:var(--label-tertiary);font-size:13px;padding:8px 2px}
.footer{text-align:center;color:var(--label-tertiary);font-size:11px;margin-top:36px}
</style>
</head>
<body data-theme="light">
  <header class="topbar">
    <div class="brand">拆书看板<small>${esc(name)}</small></div>
    <div class="stat"><b>${stats.chapters}</b> 章 · <b>${stats.shots}</b> 分镜 · <b>${stats.sentences}</b> 句</div>
  </header>
  <main>
    <!-- ① 统计卡 -->
    <div class="stat-grid">
      ${statCard(stats.chapters, "章节", `平均 ${stats.avgSentences} 句/章`)}
      ${statCard(stats.shots, "分镜", `平均 ${stats.avgShots} 镜/章`)}
      ${statCard(stats.sentences, "句子", "")}
      ${statCard(stats.suspenseChapters, "悬念章", "含 suspense 标注")}
    </div>

    <!-- ② 分布 + 主线 -->
    <div class="cards">
      <div class="card">
        <div class="card-title">章节功能分布（function）</div>
        ${Object.keys(fnDist).length ? bar(fnDist, chapterCount) : `<div class="no-data">暂无 function 数据</div>`}
      </div>
      <div class="card">
        <div class="card-title">分镜类型分布（type）</div>
        ${Object.keys(typeDist).length ? bar(typeDist, shotCount) : `<div class="no-data">暂无分镜数据</div>`}
      </div>
      ${mainTarget ? `<div class="card card-main">
        <div class="card-title">★ 主线</div>
        <div class="mt">${esc(mainTarget.target)}<span class="ms">${esc(mainTarget.state)}</span></div>
        <div class="mn">${esc(mainTarget.note ?? "")}</div>
      </div>` : ""}
    </div>

    <!-- ③ 章节列表（可展开看 summary + 分镜） -->
    <div class="sec-title">逐章 · ${stats.chapters} 章（点开看 summary 与分镜）</div>
    <div id="list"></div>
    <div class="footer">NovelyWrite · 拆书看板 · 章节树 chapter-tree · summary 为唯一权威事实 · 纯程序投影</div>
  </main>
<script>
const CHAPTERS = ${JSON.stringify(nodes.map((n) => ({ num: n.num, title: n.title, function: n.function, summary: n.summary, shots: (n.shots ?? []).map((s) => ({ type: s.type, label: s.label, sentenceIds: (s.sentenceIds ?? []).length })) }))).replace(/</g, "\\u003c")};
const list = document.getElementById("list");
const esc2 = (s) => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

CHAPTERS.forEach((ch) => {
  const el = document.createElement("div");
  const shotsHtml = ch.shots.length
    ? ch.shots.map((s) => \`<span class="shot"><span class="st">\${esc2(s.type)}</span>\${esc2(s.label)} · \${s.sentenceIds}句</span>\`).join("")
    : '<div class="no-data">无分镜</div>';
  el.innerHTML = \`
    <div class="chapter" data-ch="\${ch.num}">
      <div class="ch-head">
        <span class="num">\${ch.num}</span>
        <span class="t">\${esc2(ch.title)}</span>
        \${ch.function ? \`<span class="fn">\${esc2(ch.function)}</span>\` : ""}
        <span class="cnt">\${ch.shots.length} 镜</span>
        <span class="arrow">▸</span>
      </div>
      <div class="ch-body">
        <div class="ch-summary">\${esc2(ch.summary) || "（无 summary）"}</div>
        <div class="shots">\${shotsHtml}</div>
      </div>
    </div>\`;
  list.appendChild(el.firstElementChild);
});
list.addEventListener("click", (e) => {
  const head = e.target.closest(".ch-head");
  if (head) head.parentElement.classList.toggle("open");
});
</script>
</body>
</html>`;

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
    const { html, root, stats, tree: treeStats } = buildReport(project);
    const out = argVal("out") ?? path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "output", `${project}-拆书地图.html`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, html, "utf-8");
    console.log(`✅ 拆书看板已生成: ${out}`);
    console.log(`   统计: ${stats.chapters} 章 / ${stats.shots} 分镜 / ${stats.sentences} 句 / 悬念章 ${stats.suspenseChapters}`);
    if (treeStats && !treeStats.error) console.log(`   章节树: ${treeStats.chapters} 章（重建 ${treeStats.rebuilt}，复用 ${treeStats.skipped}）`);
  } catch (e) {
    console.error(`❌ 生成失败: ${e.message}`);
    process.exit(1);
  }
}
