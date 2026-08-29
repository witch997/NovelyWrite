#!/usr/bin/env node
/**
 * report.mjs — 拆书地图生成器（features/report 模块）
 *
 * 输入：store/<域>/<书>project/ 下的已有 JSON（章节标注 summary / 章节表 / 大事件 / 卷纲）
 * 输出：一份自包含 HTML（NovelyWrite 风格，双栏 wiki 形态）——纯程序投影，零 LLM，幂等。
 *
 * 布局：
 *   顶栏：书名 / 统计
 *   左栏：wiki 导航页（书的超文本文档）—— 章节 / 人物 / 事件 均为可点击超链接样式
 *         （跳转暂未实现，点击仅占位；未来点击 → 右栏渲染对应详情）
 *   右栏：内容页 —— 默认展示全书概览（书的首页），未来承接链接跳转的详情内容
 *
 * 原则：summary 是唯一权威事实；本模块只投影不篡改；缺数据段自动降级。
 *
 * 用法：
 *   node features/report/report.mjs --project=<书> [--out=<文件.html>]   # CLI 自测
 *   import { buildReport } from "./report.mjs"                           # server 调用
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { projectRoot } from "../../shared/paths.mjs";

const pad4 = (n) => String(n).padStart(4, "0");

/** 安全读 JSON（不存在/非法 → null） */
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

/** 章节标注路径（章节/第XXXX章.json） */
function chapterJsonPath(root, n) {
  return path.join(root, "章节", `第${pad4(n)}章.json`);
}

/**
 * 生成拆书地图 HTML（wiki 导航 + 内容页，NovelyWrite 风格）
 * @param {string} project 书名（域自动探测：my 优先）
 * @returns {{html: string, project: string, root: string, stats: object}}
 */
export function buildReport(project) {
  const root = projectRoot(project); // 不存在会抛 PROJECT_NOT_FOUND
  const name = project;

  /* ---------- 数据读取（缺什么降级什么） ---------- */
  const tableJson = readJson(path.join(root, "章节", "章节表.json"));
  const chapters = tableJson?.chapters ?? [];
  const volume = readJson(path.join(root, "卷纲", "volume.json"));
  const targets = volume?.targets ?? [];
  const eventJson = readJson(path.join(root, "大事件", "event.json"));
  const lifecycle = eventJson?.lifecycle ?? [];

  // 单章标注（summary 是唯一权威）
  const chapterInfos = [];
  for (const c of chapters) {
    const j = readJson(chapterJsonPath(root, c.num ?? c.number));
    if (j) {
      chapterInfos.push({
        num: c.num ?? c.number,
        title: c.title ?? j.chapter?.title ?? `第${c.num}章`,
        summary: j.summary ?? "",
      });
    }
  }

  // 实体聚合（从事件表 entity 提取；用于左栏"人物"导航）
  const entityCount = new Map();
  for (const e of lifecycle) {
    const key = e.entity ?? "";
    if (key) entityCount.set(key, (entityCount.get(key) ?? 0) + 1);
  }
  const entities = [...entityCount.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  // 事件列表（用于左栏"事件"导航；悬置优先 + 按开始章排序）
  const events = [...lifecycle]
    .sort((a, b) => (a.state === "悬置" ? -1 : 1) - (b.state === "悬置" ? -1 : 1) || (a["开始章"] ?? 0) - (b["开始章"] ?? 0));

  /* ---------- 统计 ---------- */
  const stats = {
    chapters: chapterInfos.length,
    events: lifecycle.length,
    entities: entities.length,
    suspended: lifecycle.filter((e) => e.state === "悬置").length,
    mainTarget: targets.find((t) => t.isMain) ?? null,
  };

  /* ================= HTML 组装（NovelyWrite / DSH 风格） ================= */
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  /* ---- 左栏 wiki 导航：概览 / 章节 / 人物 / 事件 ---- */
  const link = (label, type, key, extra = "") =>
    `<a class="wiki-link" data-type="${type}" data-key="${esc(key)}" title="详情页开发中" href="javascript:void(0)" onclick="return false">${esc(label)}</a>${extra}`;

  const wikiOverview = `
    <div class="wiki-sec">
      <div class="wiki-sec-title">书</div>
      <div class="wiki-book">《${esc(name)}》</div>
      <div class="wiki-meta">${stats.chapters} 章 · ${stats.events} 事件 · ${stats.entities} 实体 · 悬置 ${stats.suspended}</div>
      ${stats.mainTarget ? `<div class="wiki-meta">★ ${esc(stats.mainTarget.target)}（${esc(stats.mainTarget.state)}）</div>` : ""}
    </div>`;

  const wikiChapters = `
    <div class="wiki-sec">
      <div class="wiki-sec-title">章节 · ${stats.chapters}</div>
      ${chapterInfos.length ? chapterInfos.map((c) =>
        `<div class="wiki-row">${link(`第${c.num}章 ${c.title}`, "chapter", String(c.num))}</div>`
      ).join("") : `<div class="wiki-empty">暂无章节（先 annotate）</div>`}
    </div>`;

  const wikiEntities = `
    <div class="wiki-sec">
      <div class="wiki-sec-title">人物 · ${entities.length}</div>
      ${entities.length ? entities.map((e) =>
        `<div class="wiki-row">${link(e.name, "entity", e.name)} <span class="wiki-count">×${e.count}</span></div>`
      ).join("") : `<div class="wiki-empty">暂无事件（先 aggregate）</div>`}
    </div>`;

  const wikiEvents = `
    <div class="wiki-sec">
      <div class="wiki-sec-title">事件 · ${events.length}</div>
      ${events.length ? events.map((e) => {
        const dur = e["结束章"] ? `${e["开始章"]}–${e["结束章"]}` : `第${e["开始章"]}章起`;
        const badge = e.state === "悬置" ? `<span class="wiki-badge susp">悬置</span>` : `<span class="wiki-badge">${esc(e.state)}</span>`;
        return `<div class="wiki-row">${badge} ${link(e.entity, "event", e.entity)} <span class="wiki-count">${dur}</span></div>`;
      }).join("") : `<div class="wiki-empty">暂无事件</div>`}
    </div>`;

  const wikiNav = `<aside class="list-pane" id="wiki">
    <div class="wiki-scroll">
      ${wikiOverview}
      ${wikiChapters}
      ${wikiEntities}
      ${wikiEvents}
    </div>
  </aside>`;

  /* ---- 右栏内容页（默认 = 全书概览；未来点左栏链接在此渲染详情） ---- */
  const viewPage = `
    <section class="view-pane" id="view">
      <div class="content-page">
        <div class="hero">
          <div class="title">《${esc(name)}》</div>
          <div class="sub">拆书地图 · 全书概览</div>
        </div>
        <div class="stat-grid">
          <div class="stat-card"><div class="v">${stats.chapters}</div><div class="k">章节</div></div>
          <div class="stat-card"><div class="v">${stats.entities}</div><div class="k">人物实体</div></div>
          <div class="stat-card"><div class="v">${stats.events}</div><div class="k">事件</div></div>
          <div class="stat-card"><div class="v ${stats.suspended ? "warn" : ""}">${stats.suspended}</div><div class="k">悬置（未收线）</div></div>
        </div>
        ${stats.mainTarget ? `
        <div class="card">
          <div class="card-title">★ 主线</div>
          <div class="card-body">${esc(stats.mainTarget.target)} <span class="state">${esc(stats.mainTarget.state)}</span></div>
          ${stats.mainTarget?.note ? `<div class="card-note">${esc(stats.mainTarget.note)}</div>` : ""}
        </div>` : ""}
        <div class="card">
          <div class="card-title">关于本页</div>
          <div class="card-body muted">左侧为本书的 wiki 导航（章节 / 人物 / 事件），条目均为超链接样式——点击跳转至右侧详情页功能开发中。</div>
        </div>
      </div>
    </section>`;

  const html = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>拆书 · ${esc(name)}</title>
<style>
/* ===== NovelyWrite / DSH 风格（bluish 色阶 + deepseek 蓝，深色） ===== */
:root{
  --n-50:#f8fafc;--n-75:#f1f5f9;--n-100:#e9eef5;--n-150:#dfe6ef;--n-200:#d3dbe6;
  --n-300:#b8c3d2;--n-400:#94a3b8;--n-500:#7587a0;--n-600:#5c6f88;--n-700:#47586f;
  --n-750:#39495e;--n-800:#2d3b4d;--n-850:#232f3e;--n-900:#1a2430;--n-950:#10161f;
  --brand-100:#dbeafe;--brand-400:#4176e6;--brand-500:#2563eb;--brand-600:#1d4ed8;
  --amber-500:#d97706;--green-500:#22a55d;--green-100:#dcfce7;--red-500:#dc2626;--red-100:#fee2e2;
  --ease:cubic-bezier(.4,0,.2,1);--dur:.2s;
  --radius:8px;--radius-sm:6px;
}
body[data-theme="dark"]{
  --bg-base:var(--n-950);--bg-module:var(--n-850);--bg-hover:var(--n-800);
  --bg-active:rgba(65,118,230,.18);--border:var(--n-750);--border-strong:var(--n-600);
  --label-primary:var(--n-50);--label-secondary:var(--n-300);--label-tertiary:var(--n-500);
  --brand:var(--brand-400);--brand-hover:var(--brand-500);--interactive-hover:rgba(255,255,255,.08);
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  background:var(--bg-base);color:var(--label-primary);
  display:flex;flex-direction:column;overflow:hidden;-webkit-font-smoothing:antialiased;
}

/* 顶栏 */
.topbar{display:flex;align-items:baseline;gap:12px;padding:13px 20px;background:var(--bg-module);border-bottom:1px solid var(--border);flex-shrink:0}
.topbar .brand{font-size:15px;font-weight:600}
.topbar .brand small{color:var(--label-tertiary);font-weight:400;font-size:12px;margin-left:8px}
.topbar .stat{color:var(--label-secondary);font-size:13px;margin-left:auto}
.topbar .stat b{color:var(--label-primary)}

/* 主体双栏 */
.main{display:flex;flex:1;min-height:0}

/* 左栏 wiki 导航 */
.list-pane{width:300px;flex-shrink:0;border-right:1px solid var(--border);background:var(--bg-module);overflow:hidden;display:flex}
.wiki-scroll{flex:1;overflow-y:auto;padding:14px 0}
.list-pane::-webkit-scrollbar{width:8px}
.list-pane::-webkit-scrollbar-thumb{background:var(--n-700);border-radius:4px}
.wiki-sec{padding:4px 0 10px;border-bottom:1px solid var(--border)}
.wiki-sec-title{
  padding:6px 18px 4px;font-size:11px;font-weight:600;letter-spacing:1px;
  color:var(--label-tertiary);text-transform:uppercase;
}
.wiki-book{padding:2px 18px;font-size:15px;font-weight:600}
.wiki-meta{padding:2px 18px;font-size:12px;color:var(--label-tertiary)}
.wiki-row{padding:3px 18px;font-size:13px;display:flex;align-items:center;gap:8px}
.wiki-row:hover{background:var(--bg-hover)}
.wiki-count{color:var(--label-tertiary);font-size:11px;margin-left:auto;flex-shrink:0}
.wiki-empty{padding:3px 18px;font-size:12px;color:var(--label-tertiary)}
.wiki-badge{
  display:inline-block;font-size:10px;padding:0 6px;border-radius:999px;
  background:var(--n-700);color:var(--n-100);flex-shrink:0;
}
.wiki-badge.susp{background:rgba(217,119,6,.18);color:var(--amber-500)}

/* wiki 链接（可点击样式；跳转开发中） */
.wiki-link{
  color:var(--brand);text-decoration:none;cursor:pointer;
  border-bottom:1px dashed rgba(65,118,230,.4);transition:color var(--dur) var(--ease);
}
.wiki-link:hover{color:var(--brand-hover);text-decoration:underline}

/* 右栏内容页 */
.view-pane{flex:1;overflow-y:auto;padding:26px 34px}
.view-pane::-webkit-scrollbar{width:8px}
.view-pane::-webkit-scrollbar-thumb{background:var(--n-700);border-radius:4px}
.content-page{max-width:760px;margin:0 auto}
.hero{
  background:linear-gradient(135deg,rgba(65,118,230,.16),transparent);
  border:1px solid var(--border);border-radius:var(--radius);padding:22px 26px;margin-bottom:20px;
}
.hero .title{font-size:26px;font-weight:700;letter-spacing:1px}
.hero .sub{color:var(--label-secondary);font-size:13px;margin-top:6px}
.stat-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}
.stat-card{
  background:var(--bg-module);border:1px solid var(--border);border-radius:var(--radius);
  padding:14px 8px;text-align:center;
}
.stat-card .v{font-size:22px;font-weight:700;color:var(--label-primary)}
.stat-card .v.warn{color:var(--amber-500)}
.stat-card .k{font-size:11px;color:var(--label-tertiary);margin-top:2px}
.card{background:var(--bg-module);border:1px solid var(--border);border-radius:var(--radius);padding:16px 20px;margin-bottom:14px}
.card-title{font-size:13px;font-weight:600;color:var(--label-secondary);margin-bottom:8px}
.card-body{font-size:14px;line-height:1.8}
.card-body.muted{color:var(--label-tertiary);font-size:13px}
.card-note{color:var(--label-tertiary);font-size:13px;margin-top:8px}
.state{display:inline-block;padding:0 8px;border-radius:999px;background:var(--bg-active);color:var(--brand);font-size:12px;margin-left:6px}
</style>
</head>
<body data-theme="dark">
  <header class="topbar">
    <div class="brand">拆书<small>${esc(name)}</small></div>
    <div class="stat"><b>${stats.chapters}</b> 章 · <b>${stats.entities}</b> 人物 · <b>${stats.events}</b> 事件</div>
  </header>
  <div class="main">
    ${wikiNav}
    ${viewPage}
  </div>
</body>
</html>`;

  return { html, project: name, root, stats };
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
    const { html, root, stats } = buildReport(project);
    const out = argVal("out") ?? path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "output", `${project}-拆书地图.html`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, html, "utf-8");
    console.log(`✅ 拆书地图已生成: ${out}`);
    console.log(`   统计: ${stats.chapters} 章 / ${stats.entities} 实体 / ${stats.events} 事件 / 悬置 ${stats.suspended}`);
  } catch (e) {
    console.error(`❌ 生成失败: ${e.message}`);
    process.exit(1);
  }
}
