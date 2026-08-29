#!/usr/bin/env node
/**
 * report.mjs — 拆书地图生成器（features/report 模块）
 *
 * 输入：store/<域>/<书>project/ 下的已有 JSON（章节标注 summary / 分镜标注 / 大事件 / 卷纲）
 * 输出：一份自包含 HTML（五段拆书地图）——纯程序投影，零 LLM，幂等，可随时重算。
 *
 * 五段：
 *   ① 全书速览  主线一句话 + 章数/事件/目标线统计 + 状态分布
 *   ② 大纲结构  卷纲目标线表（目标/状态/证据章）
 *   ③ 人物弧光  事件表实体聚合 → 每实体遭遇链（按章排序，可溯源）
 *   ④ 伏笔追踪  悬置事件 + 卷纲未达成目标（"还没收的线"）
 *   ⑤ 逐章精读  章节表 + 每章 summary（唯一权威事实）
 *
 * 原则：summary 是唯一权威事实；本模块只投影不篡改；缺数据段自动降级显示。
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

/** 状态图标 */
const STATE_ICON = { "推进": "🔄", "达成": "✅", "失败": "❌", "搁置": "⏸️", "确立": "📌", "悬置": "⏸️", "已回收": "✅" };

/**
 * 生成拆书地图 HTML
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
        function: j.function ?? "",
        summary: j.summary ?? "",
        mainline: j.mainlineProgress ?? null,
        shots: readJson(path.join(root, "分镜标注", "json", `第${pad4(c.num ?? c.number)}章.json`))?.shots ?? null,
      });
    }
  }

  /* ---------- 实体聚合（从事件表 entity 提取 → 遭遇链） ---------- */
  const entityMap = new Map(); // entity 名 → {events: []}
  for (const e of lifecycle) {
    const key = e.entity ?? "";
    if (!key) continue;
    if (!entityMap.has(key)) entityMap.set(key, { events: [] });
    entityMap.get(key).events.push(e);
  }
  const entities = [...entityMap.entries()]
    .map(([name, v]) => ({ name, count: v.events.length, events: v.events }))
    .sort((a, b) => b.count - a.count);
  // 每个实体遭遇链（按开始章排序）
  for (const ent of entities) ent.events.sort((a, b) => (a["开始章"] ?? 0) - (b["开始章"] ?? 0));

  /* ---------- 状态统计 ---------- */
  const stats = {
    chapters: chapterInfos.length,
    events: lifecycle.length,
    targets: targets.length,
    mainTarget: targets.find((t) => t.isMain) ?? null,
    suspended: lifecycle.filter((e) => e.state === "悬置").length,
    entityCount: entities.length,
  };

  /* ================= HTML 组装 ================= */
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // ① 全书速览
  const secOverview = `
    <section class="card" id="overview">
      <h2>① 全书速览</h2>
      <div class="hero">
        <div class="hero-title">《${esc(name)}》</div>
        <div class="hero-sub">${stats.chapters} 章 · ${stats.events} 条事件 · ${stats.targets} 条目标线 · ${stats.entityCount} 个实体 · 悬置 ${stats.suspended}</div>
        ${stats.mainTarget ? `<div class="hero-main">★ 主线：${esc(stats.mainTarget.target)} <span class="state">${STATE_ICON[stats.mainTarget.state] ?? ""} ${esc(stats.mainTarget.state)}</span>（${stats.mainTarget.evidenceChapters?.length ?? 0} 章）</div>` : ""}
        ${stats.mainTarget?.note ? `<div class="hero-note">${esc(stats.mainTarget.note)}</div>` : ""}
      </div>
    </section>`;

  // ② 大纲结构（卷纲目标线）
  const secOutline = `
    <section class="card" id="outline">
      <h2>② 大纲结构 · ${stats.targets} 条目标线</h2>
      ${volume?.goal ? `<p class="goal">全卷目标：${esc(volume.goal)}</p>` : ""}
      ${targets.length ? `
      <table>
        <tr><th>#</th><th>目标</th><th>状态</th><th>证据章</th><th>说明</th></tr>
        ${targets.map((t, i) => {
          const ch = t.evidenceChapters ?? [];
          const range = ch.length > 10 ? `${ch[0]}–${ch[ch.length - 1]}（${ch.length}章）` : ch.join("、");
          return `<tr><td>${i + 1}${t.isMain ? " ★" : ""}</td><td class="tgt">${esc(t.target)}</td><td><span class="state">${STATE_ICON[t.state] ?? ""} ${esc(t.state)}</span></td><td class="muted">${esc(range)}</td><td class="muted small">${esc(t.note)}</td></tr>`;
        }).join("")}
      </table>` : `<p class="muted">暂无卷纲数据（先跑 aggregate）</p>`}
    </section>`;

  // ③ 人物弧光（实体遭遇链）
  const mainEnts = entities.filter((e) => e.count >= 2).slice(0, 15); // 主要实体（出现≥2次）
  const secEntities = `
    <section class="card" id="entities">
      <h2>③ 人物弧光 · ${mainEnts.length} 个主要实体</h2>
      ${mainEnts.length ? mainEnts.map((ent) => `
        <details class="entity">
          <summary><b>${esc(ent.name)}</b> <span class="muted">· ${ent.count} 条事件 · 第 ${ent.events[0]["开始章"]}–${ent.events[ent.events.length - 1]["开始章"]} 章</span></summary>
          <div class="chain">
            ${ent.events.map((ev) => {
              const dur = ev["结束章"] ? `${ev["开始章"]}–${ev["结束章"]}` : `${ev["开始章"]}–`;
              return `<div class="chain-item"><span class="chip">第${dur}章</span> <span class="state">${STATE_ICON[ev.state] ?? ""} ${esc(ev.state)}</span> ${esc(ev.note || ev.entity)}</div>`;
            }).join("")}
          </div>
        </details>`).join("") : `<p class="muted">暂无事件数据（先跑 aggregate 生成大事件）</p>`}
      ${entities.length > mainEnts.length ? `<p class="muted small">另有 ${entities.length - mainEnts.length} 个低频实体（出现 1 次，已折叠）</p>` : ""}
    </section>`;

  // ④ 伏笔追踪（悬置事件 + 未达成目标线）
  const suspended = lifecycle.filter((e) => e.state === "悬置");
  const unDone = targets.filter((t) => t.state === "推进" || t.state === "搁置");
  const secForeshadow = `
    <section class="card" id="foreshadow">
      <h2>④ 伏笔追踪 · 还没收的线</h2>
      ${suspended.length ? `
      <h3>悬置事件（${suspended.length}）</h3>
      <ul>${suspended.map((e) => `<li><span class="chip">自第${e["开始章"]}章</span> ${esc(e.entity)} <span class="muted small">— ${esc(e.note)}</span></li>`).join("")}</ul>` : `<p class="muted">无悬置事件</p>`}
      ${unDone.length ? `
      <h3>未完成目标线（${unDone.length}）</h3>
      <ul>${unDone.map((t) => `<li><span class="state">${STATE_ICON[t.state] ?? ""} ${esc(t.state)}</span> ${esc(t.target)}</li>`).join("")}</ul>` : ""}
    </section>`;

  // ⑤ 逐章精读（summary 是唯一权威事实）
  const secChapters = `
    <section class="card" id="chapters">
      <h2>⑤ 逐章精读 · ${chapterInfos.length} 章</h2>
      ${chapterInfos.length ? chapterInfos.map((c) => `
        <details class="chapter">
          <summary><b>第${c.num}章 ${esc(c.title)}</b> ${c.function ? `<span class="chip">${esc(c.function)}</span>` : ""} ${c.mainline ? `<span class="chip">${esc(c.mainline.state ?? "")}</span>` : ""}</summary>
          ${c.summary ? `<p class="summary">${esc(c.summary)}</p>` : `<p class="muted">无 summary（未标注）</p>`}
          ${c.shots?.length ? `<div class="shots"><span class="muted small">分镜：</span>${c.shots.map((s) => `<span class="shot">[${esc(s.type)}] ${esc(s.label)}</span>`).join(" ")}</div>` : ""}
        </details>`).join("") : `<p class="muted">暂无章节数据（先 annotate）</p>`}
    </section>`;

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>拆书地图 · ${esc(name)}</title>
<style>
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;background:#0f1115;color:#e5e7eb;line-height:1.7}
header{padding:18px 28px;background:#161a22;border-bottom:1px solid #2a2f3a;display:flex;align-items:baseline;gap:14px}
header h1{margin:0;font-size:19px}
header .sub{color:#9ca3af;font-size:12px}
main{max-width:1000px;margin:0 auto;padding:22px 28px 60px}
.card{background:#161a22;border:1px solid #2a2f3a;border-radius:12px;padding:18px 22px;margin-bottom:18px}
h2{font-size:16px;margin:0 0 12px;color:#93c5fd}
h3{font-size:14px;margin:14px 0 8px;color:#e5e7eb}
.hero{background:linear-gradient(135deg,#1e3a5f,#161a22);border-radius:10px;padding:20px 24px}
.hero-title{font-size:26px;font-weight:700;letter-spacing:2px}
.hero-sub{color:#9ca3af;font-size:13px;margin-top:6px}
.hero-main{margin-top:12px;font-size:15px}
.hero-note{color:#c4b5fd;font-size:13px;margin-top:6px}
.goal{color:#c4b5fd;font-size:13px;background:#1a1f2e;padding:10px 14px;border-radius:8px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #242b38;vertical-align:top}
th{color:#9ca3af;font-weight:600;font-size:12px}
.tgt{font-weight:600}
.state{display:inline-block;padding:0 8px;border-radius:999px;background:#1e3a5f;color:#93c5fd;font-size:12px;white-space:nowrap}
.chip{display:inline-block;background:#242b38;color:#cbd5e1;border-radius:6px;padding:1px 8px;font-size:12px;margin-right:6px;white-space:nowrap}
.muted{color:#9ca3af}.small{font-size:12px}
details{border:1px solid #242b38;border-radius:8px;padding:0 14px;margin-bottom:8px;background:#131720}
summary{cursor:pointer;padding:10px 0;font-size:14px}
details[open] summary{border-bottom:1px solid #242b38;margin-bottom:10px}
.entity .chain,.shots{margin-bottom:12px}
.chain-item{padding:4px 0;font-size:13px;color:#cbd5e1}
.chapter .summary{font-size:13.5px;color:#d6dbe2;background:#10131a;padding:12px 14px;border-radius:8px;border-left:3px solid #1e3a5f}
.shot{display:inline-block;background:#10131a;color:#93c5fd;border-radius:6px;padding:2px 8px;font-size:12px;margin:2px 4px 2px 0}
ul{margin:6px 0;padding-left:20px}li{font-size:13px;margin:4px 0}
.footer{text-align:center;color:#4b5563;font-size:11px;margin-top:30px}
</style>
</head>
<body>
<header><h1>拆书地图</h1><span class="sub">${esc(name)} · ${new Date().toLocaleString("zh-CN")} · 数据源：store 章节标注/大事件/卷纲（summary 为唯一权威事实）</span></header>
<main>
${secOverview}
${secOutline}
${secEntities}
${secForeshadow}
${secChapters}
<div class="footer">NovelyWrite · 拆书地图（纯程序投影，随时可重算）</div>
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
    console.log(`   统计: ${stats.chapters} 章 / ${stats.events} 事件 / ${stats.targets} 目标线 / ${stats.entityCount} 实体 / 悬置 ${stats.suspended}`);
  } catch (e) {
    console.error(`❌ 生成失败: ${e.message}`);
    process.exit(1);
  }
}
