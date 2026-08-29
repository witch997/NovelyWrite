#!/usr/bin/env node
/**
 * report.mjs — 拆书地图生成器（features/report 模块）
 *
 * 输入：store/<域>/<书>project/ 下的已有 JSON（章节标注 summary / 章节表）
 * 输出：一份自包含 HTML（双栏拆书视图）——纯程序投影，零 LLM，幂等，可随时重算。
 *
 * 布局：顶部栏（书名/统计/主线） + 双栏：
 *   左栏：章节条目列表（可点击，选中高亮）
 *   右栏：内容显示器（默认展示全书速览 + 当前章 summary；预留点击切换）
 * 数据内嵌（<script> JSON），页面自包含、双击即用、无网络请求。
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
 * 生成拆书地图 HTML（双栏，NovelyWrite 风格）
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

  // 单章标注（summary 是唯一权威；只取摘要，不取分镜标签行）
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

  /* ---------- 速览统计 ---------- */
  const stats = {
    chapters: chapterInfos.length,
    mainTarget: targets.find((t) => t.isMain) ?? null,
  };

  /* ================= HTML 组装（NovelyWrite / DSH 风格） ================= */
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // 内嵌 JSON（防 </script> 注入：< 转义后 JSON 仍合法，读取时需 unescape）
  const jsonData = JSON.stringify(chapterInfos).replace(/</g, "\\u003c");

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
  --ease:cubic-bezier(.4,0,.2,1);--dur:.2s;
  --radius:8px;--radius-sm:6px;
  --shadow-md:0 4px 16px rgba(16,22,31,.1);
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
  display:flex;flex-direction:column;overflow:hidden;
  -webkit-font-smoothing:antialiased;
}

/* ===== 顶栏 ===== */
.topbar{
  display:flex;align-items:baseline;gap:14px;
  padding:14px 20px;background:var(--bg-module);
  border-bottom:1px solid var(--border);flex-shrink:0;
}
.topbar .brand{font-size:16px;font-weight:600}
.topbar .brand small{color:var(--label-tertiary);font-weight:400;font-size:12px;margin-left:8px}
.topbar .stat{color:var(--label-secondary);font-size:13px;margin-left:auto}
.topbar .stat b{color:var(--label-primary)}

/* ===== 主体双栏 ===== */
.main{display:flex;flex:1;min-height:0}

/* 左栏：章节条目 */
.list-pane{
  width:280px;flex-shrink:0;overflow-y:auto;
  background:var(--bg-module);border-right:1px solid var(--border);
}
.list-pane::-webkit-scrollbar{width:8px}
.list-pane::-webkit-scrollbar-thumb{background:var(--n-700);border-radius:4px}
.ch-item{
  display:block;width:100%;text-align:left;
  padding:10px 16px;border:none;border-bottom:1px solid var(--border);
  background:transparent;color:var(--label-secondary);
  font-size:13px;font-family:inherit;cursor:pointer;
  transition:background var(--dur) var(--ease),color var(--dur) var(--ease);
}
.ch-item:hover{background:var(--bg-hover)}
.ch-item.active{background:var(--bg-active);color:var(--label-primary);font-weight:600}
.ch-item .num{color:var(--label-tertiary);margin-right:8px;font-size:12px}
.ch-item .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* 右栏：内容显示器 */
.view-pane{flex:1;overflow-y:auto;padding:24px 32px}
.view-pane::-webkit-scrollbar{width:8px}
.view-pane::-webkit-scrollbar-thumb{background:var(--n-700);border-radius:4px}
.view-empty{color:var(--label-tertiary);text-align:center;margin-top:120px;font-size:14px}

/* 速览卡 */
.hero{
  background:linear-gradient(135deg,rgba(65,118,230,.16),transparent);
  border:1px solid var(--border);border-radius:var(--radius);
  padding:20px 24px;margin-bottom:20px;
}
.hero .title{font-size:24px;font-weight:700;letter-spacing:1px}
.hero .sub{color:var(--label-secondary);font-size:13px;margin-top:6px}
.hero .main{margin-top:12px;font-size:14px;color:var(--label-primary)}
.hero .main .state{display:inline-block;padding:0 8px;border-radius:999px;background:var(--bg-active);color:var(--brand);font-size:12px;margin-left:6px}
.hero .note{color:var(--label-tertiary);font-size:13px;margin-top:6px}

/* 章节内容卡 */
.ch-card{border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-module);overflow:hidden}
.ch-card .head{padding:14px 20px;border-bottom:1px solid var(--border)}
.ch-card .head .t{font-size:15px;font-weight:600}
.ch-card .head .n{color:var(--label-tertiary);font-size:12px;margin-left:8px}
.ch-card .body{padding:18px 20px;font-size:14px;line-height:1.9;color:var(--label-primary)}
.ch-card .body .empty{color:var(--label-tertiary);font-size:13px}
</style>
</head>
<body data-theme="dark">
  <header class="topbar">
    <div class="brand">拆书<small>${esc(name)}</small></div>
    <div class="stat"><b>${stats.chapters}</b> 章${stats.mainTarget ? ` · 主线：<b>${esc(stats.mainTarget.target)}</b> ${esc(stats.mainTarget.state)}` : ""}</div>
  </header>
  <div class="main">
    <aside class="list-pane" id="list"></aside>
    <section class="view-pane" id="view">
      <div class="view-empty">选择左侧章节查看精读</div>
    </section>
  </div>
<script>
const CHAPTERS = ${jsonData};
const listEl = document.getElementById("list");
const viewEl = document.getElementById("view");

function renderChapter(ch) {
  const isFirst = ch.num === (CHAPTERS[0] && CHAPTERS[0].num);
  viewEl.innerHTML = \`
    \${isFirst ? \`<div class="hero">
      <div class="title">《${esc(name)}》</div>
      <div class="sub">共 \${CHAPTERS.length} 章</div>
      ${stats.mainTarget ? `<div class="main">★ 主线：${esc(stats.mainTarget.target)}<span class="state">${esc(stats.mainTarget.state)}</span></div>` : ""}
      ${stats.mainTarget?.note ? `<div class="note">${esc(stats.mainTarget.note)}</div>` : ""}
    </div>\` : ""}
    <div class="ch-card">
      <div class="head"><span class="t">第\${ch.num}章 \${esc2(ch.title)}</span><span class="n">第 \${ch.num} 章 / 共 \${CHAPTERS.length} 章</span></div>
      <div class="body">\${ch.summary ? esc2(ch.summary) : '<div class="empty">无 summary（该章未标注）</div>'}</div>
    </div>\`;
  // 高亮左栏
  document.querySelectorAll(".ch-item").forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.num) === ch.num);
  });
  viewEl.scrollTop = 0;
}

function esc2(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 左栏条目
CHAPTERS.forEach((ch) => {
  const btn = document.createElement("button");
  btn.className = "ch-item";
  btn.dataset.num = ch.num;
  btn.innerHTML = \`<span class="num">\${ch.num}</span><span class="t">\${esc2(ch.title)}</span>\`;
  btn.onclick = () => renderChapter(ch);
  listEl.appendChild(btn);
});

// 默认选中第一章（有数据时）
if (CHAPTERS.length) renderChapter(CHAPTERS[0]);
else viewEl.innerHTML = '<div class="view-empty">暂无章节数据（先 annotate 建库）</div>';
</script>
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
    console.log(`   统计: ${stats.chapters} 章${stats.mainTarget ? ` / 主线: ${stats.mainTarget.target}` : ""}`);
  } catch (e) {
    console.error(`❌ 生成失败: ${e.message}`);
    process.exit(1);
  }
}
