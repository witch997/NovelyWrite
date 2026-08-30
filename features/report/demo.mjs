#!/usr/bin/env node
/**
 * demo.mjs — 拆书功能演示页生成器（features/report 模块）
 *
 * 产物：一份自包含 HTML（内嵌章节树 + 句子全文，双击即用，零依赖）
 * 演示：章节 → 分镜 → 句子 三级下钻（NovelyWrite 浅色风格）
 *
 * 数据来源：
 *   - 章节树（chapter-tree/，构建时自动增量更新）
 *   - 句子标注（store 句子文件，唯一事实源；内嵌为文本 map，按 sentenceIds 引用）
 *
 * 用法：
 *   node features/report/demo.mjs --project=<书> [--out=<文件.html>]
 *   import { buildDemo } from "./demo.mjs"
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { projectRoot } from "../../shared/paths.mjs";
import { buildChapterTree, loadChapterTreeIndex, loadChapterNode } from "./chapter-tree.mjs";

const pad4 = (n) => String(n).padStart(4, "0");
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; } };

/**
 * 生成拆书演示页 HTML
 * @param {string} project 书名
 * @returns {{html: string, stats: object}}
 */
export function buildDemo(project) {
  const root = projectRoot(project);
  buildChapterTree(project); // 确保章节树最新（增量）

  const index = loadChapterTreeIndex(project);
  const chapters = [];
  let sentenceCount = 0;

  for (const c of index?.chapters ?? []) {
    const node = loadChapterNode(project, c.num);
    if (!node) continue;
    // 读该章句子（按 id → text 映射）
    const sentsJ = readJson(path.join(root, "句子标注", "json", `第${pad4(c.num)}章.json`));
    const sentences = {};
    for (const s of sentsJ?.sentences ?? []) { sentences[s.id] = s.text; sentenceCount++; }
    chapters.push({
      num: node.num,
      title: node.title,
      function: node.function,
      summary: node.summary,
      shots: node.shots ?? [],
      sentences,
    });
  }

  const stats = { chapters: chapters.length, shots: chapters.reduce((a, c) => a + c.shots.length, 0), sentences: sentenceCount };

  /* ================= HTML（内嵌数据 + 下钻交互） ================= */
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const jsonData = JSON.stringify(chapters).replace(/</g, "\\u003c");
  const stateIcon = { "推进": "🔄", "达成": "✅", "失败": "❌", "搁置": "⏸️", "确立": "📌", "悬置": "⏸️", "已回收": "✅" };

  const html = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>拆书 Demo · ${esc(project)}</title>
<style>
/* ===== NovelyWrite / DSH 浅色风格 ===== */
:root{
  --n-50:#f8fafc;--n-75:#f1f5f9;--n-100:#e9eef5;--n-150:#dfe6ef;--n-200:#d3dbe6;
  --n-300:#b8c3d2;--n-400:#94a3b8;--n-500:#7587a0;--n-600:#5c6f88;--n-700:#47586f;
  --n-750:#39495e;--n-800:#2d3b4d;--n-850:#232f3e;--n-900:#1a2430;--n-950:#10161f;
  --brand-100:#dbeafe;--brand-400:#4176e6;--brand-500:#2563eb;--brand-600:#1d4ed8;
  --ease:cubic-bezier(.4,0,.2,1);--dur:.2s;--radius:8px;--radius-sm:6px;
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

main{max-width:860px;margin:0 auto;padding:24px 20px 60px}

/* 速览 */
.hero{background:linear-gradient(135deg,var(--brand-100),transparent);border:1px solid var(--border);border-radius:var(--radius);padding:20px 26px;margin-bottom:22px}
.hero .title{font-size:24px;font-weight:700;letter-spacing:1px}
.hero .sub{color:var(--label-secondary);font-size:13px;margin-top:6px}

/* 章节卡 */
.chapter{background:var(--bg-module);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:10px;overflow:hidden;transition:border-color var(--dur) var(--ease)}
.chapter:hover{border-color:var(--border-strong)}
.chapter.open{border-color:var(--brand)}
.ch-head{cursor:pointer;padding:12px 18px;display:flex;align-items:center;gap:10px;user-select:none}
.ch-head .num{color:var(--label-tertiary);font-size:12px;flex-shrink:0}
.ch-head .t{font-weight:600;font-size:14px}
.ch-head .fn{background:var(--bg-active);color:var(--brand);border-radius:999px;padding:0 8px;font-size:11px;flex-shrink:0}
.ch-head .arrow{margin-left:auto;color:var(--label-tertiary);transition:transform var(--dur) var(--ease)}
.chapter.open .ch-head .arrow{transform:rotate(90deg)}

.ch-body{display:none;border-top:1px solid var(--border)}
.chapter.open .ch-body{display:block}
.ch-summary{padding:12px 18px;font-size:13.5px;line-height:1.85;color:var(--label-secondary);background:var(--n-50)}

/* 分镜区 */
.shots{padding:6px 12px 12px}
.shot-title{font-size:11px;color:var(--label-tertiary);padding:6px 6px 4px;letter-spacing:1px}
.shot{border:1px solid var(--border);border-radius:var(--radius-sm);margin-bottom:6px;background:var(--bg-module)}
.shot-head{cursor:pointer;padding:8px 12px;display:flex;align-items:center;gap:8px;font-size:13px}
.shot-head .type{background:var(--n-100);color:var(--n-700);border-radius:6px;padding:1px 7px;font-size:11px;flex-shrink:0}
.shot-head .label{color:var(--label-primary)}
.shot-head .arrow{margin-left:auto;color:var(--label-tertiary);font-size:11px;transition:transform var(--dur) var(--ease)}
.shot.open .shot-head .arrow{transform:rotate(90deg)}
.sentences{display:none;padding:8px 12px 12px;background:var(--n-50);border-top:1px solid var(--border)}
.shot.open .sentences{display:block}
.sentence{padding:4px 6px;font-size:13px;line-height:1.8;color:var(--label-secondary)}
.sentence .sid{color:var(--label-tertiary);font-size:11px;margin-right:8px}

.footer{text-align:center;color:var(--label-tertiary);font-size:11px;margin-top:36px}
</style>
</head>
<body data-theme="light">
  <header class="topbar">
    <div class="brand">拆书 Demo<small>${esc(project)}</small></div>
    <div class="stat"><b>${stats.chapters}</b> 章 · <b>${stats.shots}</b> 分镜 · <b>${stats.sentences}</b> 句</div>
  </header>
  <main>
    <div class="hero">
      <div class="title">《${esc(project)}》</div>
      <div class="sub">章节树三级下钻演示：章节 → 分镜 → 句子（数据来自章节树 + store 句子文件）</div>
    </div>
    <div id="list"></div>
    <div class="footer">NovelyWrite · 拆书功能 Demo · 章节树 chapter-tree · summary 唯一权威</div>
  </main>
<script>
const CHAPTERS = ${jsonData};
const list = document.getElementById("list");
const esc2 = (s) => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

function renderChapter(ch) {
  const shotsHtml = ch.shots.length ? ch.shots.map((s, i) => \`
    <div class="shot" data-ch="\${ch.num}" data-shot="\${s.id}">
      <div class="shot-head">
        <span class="type">\${esc2(s.type)}</span>
        <span class="label">\${esc2(s.label)}</span>
        <span class="arrow">▸</span>
      </div>
      <div class="sentences">
        \${(s.sentenceIds || []).map((sid) => \`<div class="sentence"><span class="sid">\${sid}</span>\${esc2(ch.sentences[sid] ?? "(句子缺失)")}</div>\`).join("")}
      </div>
    </div>\`).join("") : '<div style="padding:8px 14px;font-size:12px;color:var(--label-tertiary)">暂无分镜</div>';

  return \`
    <div class="chapter" data-ch="\${ch.num}">
      <div class="ch-head">
        <span class="num">\${ch.num}</span>
        <span class="t">\${esc2(ch.title)}</span>
        \${ch.function ? \`<span class="fn">\${esc2(ch.function)}</span>\` : ""}
        <span class="arrow">▸</span>
      </div>
      <div class="ch-body">
        <div class="ch-summary">\${esc2(ch.summary) || "（无 summary）"}</div>
        <div class="shots">
          <div class="shot-title">分镜 · \${ch.shots.length}</div>
          \${shotsHtml}
        </div>
      </div>
    </div>\`;
}

// 渲染全部章节（默认折叠）
CHAPTERS.forEach((ch) => {
  const el = document.createElement("div");
  el.innerHTML = renderChapter(ch);
  list.appendChild(el.firstElementChild);
});

// 交互：点章节展开分镜；点分镜展开句子
list.addEventListener("click", (e) => {
  const shotHead = e.target.closest(".shot-head");
  if (shotHead) { shotHead.parentElement.classList.toggle("open"); return; }
  const chHead = e.target.closest(".ch-head");
  if (chHead) { chHead.parentElement.classList.toggle("open"); return; }
});
</script>
</body>
</html>`;

  return { html, stats };
}

/* ================= CLI ================= */
if (process.argv[1] && path.resolve(process.argv[1]).endsWith("demo.mjs")) {
  const argVal = (n) => {
    const a = process.argv.find((x) => x.startsWith(`--${n}=`));
    return a ? a.slice(n.length + 3) : null;
  };
  const project = argVal("project") ?? process.argv[2];
  if (!project) { console.error("用法: node features/report/demo.mjs --project=<书>"); process.exit(2); }
  try {
    const { html, stats } = buildDemo(project);
    const out = argVal("out") ?? path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "output", `${project}-拆书Demo.html`);
    fs.writeFileSync(out, html, "utf-8");
    console.log(`✅ 拆书 Demo 已生成: ${out}`);
    console.log(`   统计: ${stats.chapters} 章 / ${stats.shots} 分镜 / ${stats.sentences} 句`);
  } catch (e) {
    console.error(`❌ 生成失败: ${e.message}`);
    process.exit(1);
  }
}
