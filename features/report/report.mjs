#!/usr/bin/env node
/**
 * report.mjs — 拆书地图生成器（features/report 模块）
 *
 * 输入：store/<域>/<书>project/ 下的已有 JSON（章节标注 summary / 章节表 / 卷纲）
 * 输出：一份自包含 HTML（单栏，NovelyWrite 项目浅色风格）——纯程序投影，零 LLM，幂等。
 *
 * 布局（单栏纵向流）：
 *   顶栏：书名 / 统计
 *   ① 全书速览：书名 + 主线一句话
 *   ② 逐章精读：每章一个折叠卡（章标题 → summary 全文），默认折叠，点开即读
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
 * 生成拆书地图 HTML（单栏，NovelyWrite 浅色风格）
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

  /* ---------- 速览统计 ---------- */
  const stats = {
    chapters: chapterInfos.length,
    mainTarget: targets.find((t) => t.isMain) ?? null,
  };

  /* ================= HTML 组装（NovelyWrite / DSH 浅色风格） ================= */
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const html = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>拆书 · ${esc(name)}</title>
<style>
/* ===== NovelyWrite / DSH 风格（bluish 色阶 + deepseek 蓝，浅色主题） ===== */
:root{
  --n-50:#f8fafc;--n-75:#f1f5f9;--n-100:#e9eef5;--n-150:#dfe6ef;--n-200:#d3dbe6;
  --n-300:#b8c3d2;--n-400:#94a3b8;--n-500:#7587a0;--n-600:#5c6f88;--n-700:#47586f;
  --n-750:#39495e;--n-800:#2d3b4d;--n-850:#232f3e;--n-900:#1a2430;--n-950:#10161f;
  --brand-100:#dbeafe;--brand-400:#4176e6;--brand-500:#2563eb;--brand-600:#1d4ed8;
  --green-500:#22a55d;--green-100:#dcfce7;--amber-500:#d97706;--amber-100:#fef3c7;
  --red-500:#dc2626;--red-100:#fee2e2;
  --ease:cubic-bezier(.4,0,.2,1);--dur:.2s;
  --radius:8px;--radius-sm:6px;
  --shadow-sm:0 1px 2px rgba(16,22,31,.06);
  --shadow-md:0 4px 16px rgba(16,22,31,.1);
}
body[data-theme="light"]{
  --bg-base:var(--n-50);--bg-module:#ffffff;--bg-hover:var(--n-75);
  --bg-active:var(--brand-100);--border:var(--n-150);--border-strong:var(--n-200);
  --label-primary:var(--n-950);--label-secondary:var(--n-700);--label-tertiary:var(--n-400);
  --brand:var(--brand-500);--brand-hover:var(--brand-600);
  --interactive-hover:rgba(38,49,72,.06);--code-bg:var(--n-75);
}
*{box-sizing:border-box;margin:0;padding:0}
body{
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  background:var(--bg-base);color:var(--label-primary);
  min-height:100vh;-webkit-font-smoothing:antialiased;
  transition:background var(--dur) var(--ease),color var(--dur) var(--ease);
}

/* 顶栏 */
.topbar{
  display:flex;align-items:baseline;gap:12px;padding:14px 24px;
  background:var(--bg-module);border-bottom:1px solid var(--border);
  position:sticky;top:0;z-index:2;
}
.topbar .brand{font-size:16px;font-weight:600}
.topbar .brand small{color:var(--label-tertiary);font-weight:400;font-size:12px;margin-left:8px}
.topbar .stat{color:var(--label-secondary);font-size:13px;margin-left:auto}
.topbar .stat b{color:var(--label-primary)}

/* 单栏主体 */
main{max-width:860px;margin:0 auto;padding:24px 20px 60px}

/* ① 全书速览 */
.hero{
  background:linear-gradient(135deg,var(--brand-100),transparent);
  border:1px solid var(--border);border-radius:var(--radius);
  padding:22px 26px;margin-bottom:22px;
}
.hero .title{font-size:26px;font-weight:700;letter-spacing:1px}
.hero .sub{color:var(--label-secondary);font-size:13px;margin-top:6px}
.hero .main{margin-top:14px;font-size:15px}
.hero .main .state{
  display:inline-block;padding:0 8px;border-radius:999px;
  background:var(--bg-active);color:var(--brand);font-size:12px;margin-left:8px;
}
.hero .note{color:var(--label-secondary);font-size:13px;margin-top:8px}

/* ② 逐章精读 */
.sec-title{font-size:15px;font-weight:600;margin:4px 2px 12px;color:var(--label-secondary)}
.chapter{
  border:1px solid var(--border);border-radius:var(--radius);
  background:var(--bg-module);margin-bottom:8px;overflow:hidden;
  box-shadow:var(--shadow-sm);transition:border-color var(--dur) var(--ease),box-shadow var(--dur) var(--ease);
}
.chapter:hover{border-color:var(--border-strong)}
.chapter[open]{border-color:var(--brand);box-shadow:var(--shadow-md)}
.chapter summary{
  cursor:pointer;padding:12px 18px;font-size:14px;font-weight:600;
  list-style:none;display:flex;align-items:center;gap:10px;user-select:none;
}
.chapter summary::-webkit-details-marker{display:none}
.chapter summary .num{color:var(--label-tertiary);font-size:12px;font-weight:400}
.chapter summary::after{
  content:"▸";margin-left:auto;color:var(--label-tertiary);
  transition:transform var(--dur) var(--ease);
}
.chapter[open] summary::after{transform:rotate(90deg)}
.chapter .summary{
  padding:14px 18px 18px;font-size:14px;line-height:1.9;color:var(--label-primary);
  border-top:1px solid var(--border);background:var(--n-50);
}
.chapter .empty{color:var(--label-tertiary);font-size:13px}
.no-data{color:var(--label-tertiary);font-size:13px;padding:10px 2px}
</style>
</head>
<body data-theme="light">
  <header class="topbar">
    <div class="brand">拆书<small>${esc(name)}</small></div>
    <div class="stat"><b>${stats.chapters}</b> 章${stats.mainTarget ? ` · 主线：<b>${esc(stats.mainTarget.target)}</b> <span style="color:var(--brand)">${esc(stats.mainTarget.state)}</span>` : ""}</div>
  </header>
  <main>
    <section class="hero">
      <div class="title">《${esc(name)}》</div>
      <div class="sub">拆书地图 · 全书速览</div>
      ${stats.mainTarget ? `<div class="main">★ 主线：${esc(stats.mainTarget.target)}<span class="state">${esc(stats.mainTarget.state)}</span></div>` : ""}
      ${stats.mainTarget?.note ? `<div class="note">${esc(stats.mainTarget.note)}</div>` : ""}
    </section>

    <section>
      <div class="sec-title">逐章精读 · ${stats.chapters} 章</div>
      ${chapterInfos.length ? chapterInfos.map((c) => `
        <details class="chapter">
          <summary><span class="num">${c.num}</span> ${esc(c.title)}</summary>
          <div class="summary">${c.summary ? esc(c.summary) : `<span class="empty">该章未标注 summary</span>`}</div>
        </details>`).join("") : `<div class="no-data">暂无章节数据（先 annotate 建库）</div>`}
    </section>
  </main>
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
