#!/usr/bin/env node
/**
 * server.mjs — NovelyWrite HTTP 服务（前端 ↔ 现有模块能力的中介层）
 *
 * 职责：把 CLI 能力包装成 HTTP/JSON 接口，供前端（浏览器页面）调用。
 *   不重写任何业务逻辑——直接 import 现有模块（novelread/retriever/features/shared），
 *   只做：路由 → 参数解析 → 调模块函数 → JSON 序列化 → 返回。
 *
 * 零依赖：仅 node:http / node:fs / node:path / node:child_process（Node ≥18 标准库）。
 *
 * 接口一览：
 *   静态页：    GET  /                     → 前端页面（可选，返回内置 HTML 或提示）
 *   知识库：    GET  /api/projects         → 项目列表（两域 + 进度，读 project-meta）
 *               GET  /api/projects/:name   → 项目详情（meta + 章节表 + 事件 + 卷纲 概览）
 *               GET  /api/projects/:name/chapters/:n  → 单章三层（句子/分镜/章节标注）
 *               GET  /api/projects/:name/chapters/:n/source → 语料分章原文
 *               GET  /api/projects/:name/events       → 大事件 event.json
 *               GET  /api/projects/:name/volumes      → 卷纲 volume.json
 *               GET  /api/projects/:name/chapter-table→ 章节表
 *   检索：      POST /api/search           → 三通道检索（retrieve()）
 *   配置：      GET  /api/config           → 配置摘要（脱敏：不含 apiKey）
 *               PUT  /api/config           → 写 features 段/全局非敏感字段（模块作用域）
 *   系统：      POST /api/system/open-folder → 调系统资源管理器打开目录（store/mybook/output/数据根）
 *   写作会话：  GET  /api/sessions         → 会话列表
 *               GET  /api/sessions/:id     → 会话详情（shots/recalls/draft/meta）
 *   长任务：    POST /api/tasks/annotate   → 启动标注（子进程 host-exec.mjs）
 *               POST /api/tasks/aggregate  → 启动聚合（aggregates.mjs）
 *               POST /api/tasks/fix        → 启动修复（fix.mjs）
 *               POST /api/tasks/preprocess → 写作①（preprocess.mjs）
 *               POST /api/tasks/recall     → 写作②（recall.mjs）
 *               POST /api/tasks/writedraft → 写作③（writedraft.mjs）
 *               GET  /api/tasks            → 任务列表（running/finished）
 *               GET  /api/tasks/:id        → 任务状态 + 进度（轮询）
 *               GET  /api/tasks/:id/log    → 任务日志尾部
 *               POST /api/tasks/:id/kill   → 终止任务
 *
 * 用法：
 *   node server.mjs [--port=3081] [--host=127.0.0.1] [--open]
 *
 * 端口策略（杜绝冲突）：
 *   --port=0   → 动态端口：系统自动分配一个必然空闲的端口（推荐 exe/桌面场景）
 *   --port=N   → 固定端口：被占用会启动失败（开发调试用）
 *   默认 3081  —— 不要用 3080（DeepSeek Harness Web GUI 占用）。
 *   --open     → 服务就绪后自动打开系统默认浏览器（时序：先起服务、拿端口、再开页面）。
 *                桌面版（Tauri/WebView）改为创建原生窗口指向实际端口。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CODE_ROOT, DATA_ROOT, storeDir, corpusDir, mybookDir, outputDir, projectRoot, listProjects, domainOf, DOMAIN, configPath, ensureDataDirs, createProject } from "./shared/paths.mjs";
import { loadChatConfig, loadConfigSummary, loadRawConfig } from "./shared/config.mjs";
import { retrieve } from "./retriever/retriever.mjs";
import { NovelyError, report } from "./shared/errors.mjs";
import { persistTask, appendTaskLog, loadTaskLog, listTasks as listTasksFromDisk } from "./shared/tasks.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;

/* ================= 参数 ================= */
const args = process.argv.slice(2);
const port = Number((args.find((a) => a.startsWith("--port=")) ?? "--port=3081").split("=")[1]);
const host = (args.find((a) => a.startsWith("--host=")) ?? "--host=127.0.0.1").split("=")[1];

/* ================= 小工具 ================= */
const pad4 = (n) => String(n).padStart(4, "0");
const json = (res, code, data) => {
  const body = JSON.stringify(data ?? { ok: true });
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
};
const errRes = (res, err) => {
  const e = err instanceof NovelyError ? err : new NovelyError("INTERNAL", { message: err?.message ?? String(err) });
  json(res, 400, e.toJSON());
};
function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}
function getBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 2e6) req.destroy(); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}
const SENTENCE_FUNCS = ["塑造人物", "引入世界观", "设置动机", "推进", "铺垫", "反转", "爆发", "转场", "收束分镜", "悬念"];
const SHOT_TYPES = ["信息", "对话", "心理", "动作", "事件", "环境"];

/* ================= 长任务管理器（子进程 + 状态文件，复用 shared/tasks.mjs） ================= */
const taskState = new Map(); // id → {id, script, args, status, startedAt, finishedAt, code}

function startTask(script, targs, label) {
  const id = `${label}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const p = path.join(CODE_ROOT, script);
  const t = { id, script, args: targs, status: "running", label, startedAt: new Date().toISOString(), finishedAt: null, code: null };
  taskState.set(id, t);
  const child = spawn(NODE, [p, ...targs], { cwd: CODE_ROOT, env: process.env });
  // 日志流 → 独立 log 文件夹（store/_tasks/log/<id>.log，appendTaskLog 内部截断 LOG_KEEP 行）
  let buf = "";
  const push = (chunk) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    const clean = lines.filter((l) => l.trim());
    if (clean.length) appendTaskLog(id, clean);
  };
  child.stdout.on("data", push);
  child.stderr.on("data", push);
  child.on("error", (err) => { t.status = "failed"; t.finishedAt = new Date().toISOString(); t.code = -1; t.error = err.message; persistTask(t); });
  child.on("close", (code) => { t.status = code === 0 ? "success" : "failed"; t.finishedAt = new Date().toISOString(); t.code = code; persistTask(t); });
  persistTask(t);
  return id;
}

function listTasks() {
  // 内存态 + 磁盘态合并（磁盘覆盖内存中已结束的，补齐重启前遗留）
  const byId = new Map();
  for (const t of listTasksFromDisk()) byId.set(t.id, t);
  for (const [id, t] of taskState) {
    if (!byId.has(id) || t.status === "running") byId.set(id, t);
  }
  return [...byId.values()].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
}

/* ================= API 实现 ================= */

/** 项目列表（两域 + 进度） */
function apiProjects() {
  const out = [];
  for (const project of listProjects()) {
    const domain = domainOf(project);
    const meta = readJsonSafe(path.join(projectRoot(project), "project-meta.json"));
    out.push({
      name: project,
      domain,
      meta: meta
        ? {
            chaptersAnnotated: meta.counts?.chaptersAnnotated ?? 0,
            chaptersTotal: meta.counts?.chaptersTotal ?? 0,
            missingChapters: meta.counts?.missingChapters ?? [],
            sentences: meta.counts?.sentences ?? 0,
            shots: meta.counts?.shots ?? 0,
            syntaxPass: meta.verify?.syntaxPass ?? null,
            contractIssues: meta.verify?.contractIssues ?? null,
            verifiedAt: meta.verify?.verifiedAt ?? null,
          }
        : null,
    });
  }
  return { projects: out };
}

/** 项目详情（meta + 章节表 + 事件 + 卷纲） */
function apiProjectDetail(name) {
  const root = projectRoot(name);
  const meta = readJsonSafe(path.join(root, "project-meta.json"));
  const chapterTable = readJsonSafe(path.join(root, "章节", "章节表.json"));
  const events = readJsonSafe(path.join(root, "大事件", "event.json"));
  const volumes = readJsonSafe(path.join(root, "卷纲", "volume.json"));
  return { project: name, domain: domainOf(name), meta, chapterTable, events, volumes };
}

/** 单章三层（句子/分镜/章节标注）+ 语料分章 */
function apiChapter(name, ch) {
  const root = projectRoot(name);
  const chStr = pad4(ch);
  const sents = readJsonSafe(path.join(root, "句子标注", "json", `第${chStr}章.json`));
  const shots = readJsonSafe(path.join(root, "分镜标注", "json", `第${chStr}章.json`));
  const chapter = readJsonSafe(path.join(root, "章节", `第${chStr}章.json`));
  // 语料分章：文件名形如 第0001章_标题.txt
  let source = null;
  const splitDir = path.join(root, "语料分章");
  if (fs.existsSync(splitDir)) {
    const f = fs.readdirSync(splitDir).find((x) => x.startsWith(`第${chStr}章`));
    if (f) source = { file: f, text: fs.readFileSync(path.join(splitDir, f), "utf-8") };
  }
  return { project: name, chapter: ch, sents, shots, chapterAnnotation: chapter, source };
}

/** 三通道检索 */
async function apiSearch(body) {
  const { text = "", type = "", funcs = [], label = "", projects = [], quota, topk = 6 } = body ?? {};
  const result = await retrieve(
    { text, type: type || undefined, funcs: Array.isArray(funcs) ? funcs : [], label: label || undefined },
    { projects: projects.length ? projects : undefined, quota: quota ?? undefined, topk, buildContext: true }
  );
  return result;
}

/** 配置：读摘要（脱敏） */
function apiConfigGet() {
  return loadConfigSummary();
}

/** 配置：写 features 段 / 全局非敏感字段（模块作用域；apiKey 禁止写入） */
function apiConfigPut(body) {
  const raw = loadRawConfig() ?? {};
  const NON_SENSITIVE = ["model", "temperature", "maxTokens", "timeoutMs", "maxRetries"];
  const pick = (o) => Object.fromEntries(NON_SENSITIVE.filter((k) => o?.[k] !== undefined && o[k] !== null && o[k] !== "").map((k) => [k, o[k]]));

  // 全局 chat 非敏感字段
  if (body?.chat) {
    const picked = pick(body.chat);
    raw.chat = { ...(raw.chat ?? {}), ...picked };
  }
  // embed 非敏感字段
  if (body?.embed) {
    const picked = pick(body.embed);
    raw.embed = { ...(raw.embed ?? {}), ...picked };
  }
  // features.<module>.chat（模块作用域，非敏感）
  if (body?.features && typeof body.features === "object") {
    raw.features = raw.features ?? {};
    for (const [mod, v] of Object.entries(body.features)) {
      if (typeof v !== "object" || v === null) continue;
      raw.features[mod] = raw.features[mod] ?? {};
      raw.features[mod].chat = { ...(raw.features[mod].chat ?? {}), ...pick(v.chat ?? v) };
    }
  }
  try {
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 4), "utf-8");
  } catch (err) {
    throw new NovelyError("CONFIG_INVALID", { context: { cause: err.message } });
  }
  return { ok: true, summary: loadConfigSummary() };
}

/* ================= 模型列表（从 API 读可用模型）/ API Key 填写 ================= */

/** 调 OpenAI 兼容 /models 端点获取可用模型列表 */
async function fetchModels(baseUrl, apiKey, kind) {
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, reason: `HTTP ${res.status} ${text.slice(0, 120)}` };
    }
    const data = await res.json();
    const models = (data.data ?? []).map((m) => m.id).filter(Boolean).sort();
    return { ok: true, kind, baseUrl, models };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/**
 * GET /api/models/(chat|embed) — 从 API 读可用模型（供前端选择器）
 * 无 apiKey → {ok:false, reason:"缺少…API Key"}
 */
async function apiModels(kind) {
  const raw = loadRawConfig() ?? {};
  if (kind === "embed") {
    const e = raw.embed ?? {};
    const key = e.apiKey || process.env.NOVELYWRITE_EMBED_API_KEY;
    if (!key) return { ok: false, kind, reason: "缺少向量 API Key（config.json embed.apiKey 或 NOVELYWRITE_EMBED_API_KEY）" };
    const base = (e.baseUrl ?? "https://api.siliconflow.cn/v1").replace(/\/+$/, "");
    return await fetchModels(base, key, "embed");
  }
  const c = raw.chat ?? {};
  const key = c.apiKey || process.env.NOVELYWRITE_CHAT_API_KEY;
  if (!key) return { ok: false, kind, reason: "缺少对话 API Key（config.json chat.apiKey 或 NOVELYWRITE_CHAT_API_KEY）" };
  const base = (c.baseUrl ?? "https://api.deepseek.com/v1").replace(/\/+$/, "");
  return await fetchModels(base, key, "chat");
}

/** POST /api/config/keys {chatApiKey?, embedApiKey?} — 填写 API Key（写入本地 config.json） */
function apiSaveKeys(body) {
  const raw = loadRawConfig() ?? {};
  if (typeof body?.chatApiKey === "string" && body.chatApiKey.trim()) {
    raw.chat = { ...(raw.chat ?? {}), apiKey: body.chatApiKey.trim() };
  }
  if (typeof body?.embedApiKey === "string" && body.embedApiKey.trim()) {
    raw.embed = { ...(raw.embed ?? {}), apiKey: body.embedApiKey.trim() };
  }
  try {
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 4), "utf-8");
  } catch (err) {
    throw new NovelyError("CONFIG_INVALID", { context: { cause: err.message } });
  }
  return { ok: true };
}

/* ================= 书/章节 API（我的作品 mybook 资产区：用户原稿实时持久化） =================
 * 布局：mybook/<书>/第XXXX章.md（Markdown 原稿；首行 "# 标题" 为可选章节标题约定）
 * 新建书 = createProject(my) 建 store 骨架 + mkdir mybook/<书>（两处）
 */
const BOOK_NAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9_·《》（）()]+$/; // 书名白名单（防路径穿越）
const MAX_BOOK_NAME = 50;

function bookDir(name) {
  return path.join(mybookDir, name);
}
/** 校验书存在（mybook 资产区），不存在抛 NOT_FOUND */
function ensureBook(name) {
  if (!name || !BOOK_NAME_RE.test(name)) throw new NovelyError("ARG_INVALID", { context: { field: "name", value: name } });
  const dir = bookDir(name);
  if (!fs.existsSync(dir)) throw new NovelyError("NOT_FOUND", { context: { name, kind: "book" } });
  return dir;
}
/** 扫描书目录章节：第XXXX章.md → [{num,title?,chars,updatedAt}]（按 num 排序；chars=去空白字符数，含标点） */
function scanChapters(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^第(\d{4})章\.md$/);
    if (!m) continue;
    const p = path.join(dir, f);
    let title = null, chars = 0;
    try {
      const text = fs.readFileSync(p, "utf-8");
      const first = text.split("\n")[0] ?? "";
      const tm = first.match(/^#\s+(.+)/);
      if (tm) title = tm[1].trim();
      chars = text.replace(/\s/g, "").length; // 含标点的本章总字数（去空白）
    } catch { /* 读取失败 → null/0 */ }
    let updatedAt = null;
    try { updatedAt = fs.statSync(p).mtime.toISOString(); } catch { /* ignore */ }
    out.push({ num: Number(m[1]), title, chars, updatedAt });
  }
  return out.sort((a, b) => a.num - b.num);
}
const chapterFile = (dir, num) => path.join(dir, `第${pad4(num)}章.md`);

/** GET /api/books — 我的书列表（书名 + 章节数 + 最近更新） */
function apiBooks() {
  return {
    books: listProjects(DOMAIN.MY).map((name) => {
      const chapters = scanChapters(bookDir(name));
      return { name, chapters: chapters.length, updatedAt: chapters.at(-1)?.updatedAt ?? null };
    }),
  };
}

/** POST /api/books {name} — 新建书（查重 + store 骨架 + mybook 原稿区） */
function apiCreateBook(body) {
  const name = (body?.name ?? "").trim();
  if (!name || name.length > MAX_BOOK_NAME) {
    throw new NovelyError("ARG_INVALID", { context: { field: "name", value: name, rule: `1-${MAX_BOOK_NAME} 字符` } });
  }
  if (!BOOK_NAME_RE.test(name)) {
    throw new NovelyError("ARG_INVALID", { context: { field: "name", value: name, rule: "仅中文/字母/数字/_·《》（）()" } });
  }
  createProject(name, DOMAIN.MY); // 查重(两域同名禁止) + 建 store/myproject/<书>project 骨架
  fs.mkdirSync(bookDir(name), { recursive: true });
  return { ok: true, book: name };
}

/** GET /api/books/:name — 书详情（章节列表） */
function apiBookDetail(name) {
  const dir = ensureBook(name);
  return { name, chapters: scanChapters(dir) };
}

/** POST /api/books/:name/chapters {title?} — 新建章节（自动编号 = 现有最大 + 1） */
function apiCreateChapter(name, body) {
  const dir = ensureBook(name);
  const chapters = scanChapters(dir);
  const num = chapters.length ? chapters.at(-1).num + 1 : 1;
  const title = (body?.title ?? "").trim().slice(0, 60);
  const content = title ? `# ${title}\n\n` : "";
  fs.writeFileSync(chapterFile(dir, num), content, "utf-8");
  return { ok: true, num, title: title || `第${num}章` };
}

/** GET /api/books/:name/chapters/:n — 读章节内容 */
function apiGetChapter(name, num) {
  const dir = ensureBook(name);
  if (!Number.isInteger(num) || num < 1 || num > 9999) throw new NovelyError("ARG_INVALID", { context: { field: "num", value: num } });
  const file = chapterFile(dir, num);
  if (!fs.existsSync(file)) throw new NovelyError("NOT_FOUND", { context: { name, num, kind: "chapter" } });
  const content = fs.readFileSync(file, "utf-8");
  const first = content.split("\n")[0] ?? "";
  const tm = first.match(/^#\s+(.+)/);
  return { name, num, title: tm ? tm[1].trim() : null, content };
}

/** PUT /api/books/:name/chapters/:n {content} — 保存章节内容 */
function apiSaveChapter(name, num, body) {
  const dir = ensureBook(name);
  if (!Number.isInteger(num) || num < 1 || num > 9999) throw new NovelyError("ARG_INVALID", { context: { field: "num", value: num } });
  const file = chapterFile(dir, num);
  if (!fs.existsSync(file)) throw new NovelyError("NOT_FOUND", { context: { name, num, kind: "chapter" } });
  if (typeof body?.content !== "string") throw new NovelyError("ARG_REQUIRED", { context: { field: "content" } });
  fs.writeFileSync(file, body.content, "utf-8");
  return { ok: true, name, num, savedAt: new Date().toISOString() };
}

/** 可打开的目录清单（安全白名单：只能开这些目录，防任意路径） */
const OPENABLE_DIRS = {
  data: DATA_ROOT,           // 数据根
  store: storeDir,           // 标注数据/派生
  corpus: corpusDir,         // 语料
  mybook: mybookDir,         // 用户原稿
  output: outputDir, // 成稿/报告（数据根下）
  webview: path.join(CODE_ROOT, "webview"), // 前端
};

/**
 * 调系统资源管理器打开目录（跨平台）
 * POST /api/system/open-folder { dir: "store"|"corpus"|"mybook"|"output"|"data"|"webview" }
 */
function apiOpenFolder(body) {
  const key = body?.dir;
  const target = OPENABLE_DIRS[key];
  if (!target) {
    throw new NovelyError("ARG_INVALID", { context: { field: "dir", value: key, expects: Object.keys(OPENABLE_DIRS) } });
  }
  if (!fs.existsSync(target)) {
    throw new NovelyError("NOT_FOUND", { context: { dir: target, kind: "folder" } });
  }
  // 跨平台打开目录：Windows explorer / macOS open / Linux xdg-open
  try {
    if (process.platform === "win32") {
      spawn("explorer", [target], { stdio: "ignore", detached: true }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [target], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [target], { stdio: "ignore", detached: true }).unref();
    }
  } catch (err) {
    throw new NovelyError("INTERNAL", { context: { cause: err.message } });
  }
  return { ok: true, dir: key, path: target };
}

/** 写作会话列表/详情 */
function apiSessions() {
  const sessionsDir = path.join(CODE_ROOT, "features", "shot-writing", "sessions");
  if (!fs.existsSync(sessionsDir)) return { sessions: [] };
  const out = [];
  for (const e of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const meta = readJsonSafe(path.join(sessionsDir, e.name, "meta.json"));
    const shots = readJsonSafe(path.join(sessionsDir, e.name, "shots.json"));
    out.push({
      id: e.name,
      meta,
      summary: shots?.summary ?? meta?.inputSummary ?? null,
      shotCount: shots?.shots?.length ?? 0,
      hasRecalls: fs.existsSync(path.join(sessionsDir, e.name, "recalls.json")),
      hasDraft: fs.existsSync(path.join(sessionsDir, e.name, `${meta?.sessionId ?? ""}draft.txt`)) || fs.readdirSync(path.join(sessionsDir, e.name)).some((f) => f.endsWith("draft.txt")),
    });
  }
  return { sessions: out.sort((a, b) => (b.meta?.createdAt ?? "").localeCompare(a.meta?.createdAt ?? "")) };
}

function apiSessionDetail(id) {
  const dir = path.join(CODE_ROOT, "features", "shot-writing", "sessions", id);
  if (!fs.existsSync(dir)) throw new NovelyError("NOT_FOUND", { context: { id, kind: "session" } });
  const input = fs.existsSync(path.join(dir, "input.txt")) ? fs.readFileSync(path.join(dir, "input.txt"), "utf-8") : null;
  const shots = readJsonSafe(path.join(dir, "shots.json"));
  const recalls = readJsonSafe(path.join(dir, "recalls.json"));
  const meta = readJsonSafe(path.join(dir, "meta.json"));
  const draftFiles = fs.readdirSync(dir).filter((f) => f.endsWith("draft.txt"));
  const drafts = {};
  for (const f of draftFiles) drafts[f] = fs.readFileSync(path.join(dir, f), "utf-8");
  return { id, input, meta, shots, recalls, drafts };
}

/** 会话最终成稿：读 output/<sessionId>/<项目名>.final.txt（按会话归档，纯正文，无分镜标签）
 *  项目名从会话目录的 <项目名>draft.txt 推导。 */
function apiSessionFinal(id) {
  const dir = path.join(CODE_ROOT, "features", "shot-writing", "sessions", id);
  if (!fs.existsSync(dir)) throw new NovelyError("NOT_FOUND", { context: { id, kind: "session" } });
  const draftFile = fs.readdirSync(dir).find((f) => f.endsWith("draft.txt"));
  const project = draftFile ? draftFile.replace(/draft\.txt$/, "") : null;
  if (!project) return { ok: false, reason: "会话无 draft（尚未写作）" };
  const finalPath = path.join(outputDir, id, `${project}.final.txt`);
  if (!fs.existsSync(finalPath)) return { ok: false, reason: `final 不存在: output/${id}/${project}.final.txt` };
  return { ok: true, project, file: `${project}.final.txt`, content: fs.readFileSync(finalPath, "utf-8") };
}

/* ================= 导入参考书（上传语料 → 自动分章清单 → 启动建库） ================= */
const CORPUS_NAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9_·《》（）()]+$/; // 语料名白名单（防路径穿越）

/**
 * POST /api/tasks/import-book
 *   { filename: "xxx.txt", content: "…语料全文…", from?: number }
 * 流程：保存 corpus/<名>-语料.txt → 自动生成章节清单(gen-chapter-list) → 启动 annotate 任务
 *       from=0/缺省 → --all（全量）；from=N>0 → --from=N（从第 N 章到末尾）
 */
async function apiImportBook(body) {
  const filename = (body?.filename ?? "").trim();
  const content = body?.content;
  if (!filename || typeof content !== "string" || !content.trim()) {
    throw new NovelyError("ARG_REQUIRED", { context: { field: "filename|content" } });
  }
  const base = filename.replace(/\.txt$/i, "").replace(/-语料$/, "").trim();
  if (!base || !CORPUS_NAME_RE.test(base)) {
    throw new NovelyError("ARG_INVALID", { context: { field: "filename", value: filename, rule: "仅中文/字母/数字等，去 .txt 后缀" } });
  }
  // 1. 保存语料
  fs.mkdirSync(corpusDir, { recursive: true });
  const corpusPath = path.join(corpusDir, `${base}-语料.txt`);
  fs.writeFileSync(corpusPath, content, "utf-8");
  // 2. 自动生成章节清单（spawn，等待完成；失败时透出 gen-chapter-list 的具体原因）
  await new Promise((resolve, reject) => {
    const child = spawn(NODE, [path.join(CODE_ROOT, "novelread", "gen-chapter-list.mjs"), base], {
      cwd: CODE_ROOT,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let errMsg = "";
    child.stderr.on("data", (c) => { errMsg += c.toString(); });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(errMsg.trim() || `gen-chapter-list 退出码 ${code}`))));
  });
  // 3. 启动建库任务
  const from = Number(body.from);
  const taskArgs = { project: base, domain: DOMAIN.EX };
  if (from > 0) taskArgs.from = from;
  else taskArgs.all = true;
  const taskId = startTask("novelread/host-exec.mjs", taskArgsFor("annotate", taskArgs), "annotate");
  return { ok: true, name: base, corpus: `${base}-语料.txt`, list: `${base}-章节清单.csv`, taskId, mode: from > 0 ? `from-${from}` : "all" };
}

/* ================= 路由 ================= */
const ROUTES = [
  { m: "GET", p: /^\/api\/projects$/, h: () => apiProjects() },
  { m: "GET", p: /^\/api\/books$/, h: () => apiBooks() },
  { m: "POST", p: /^\/api\/books$/, h: (_m, b) => apiCreateBook(b) },
  { m: "GET", p: /^\/api\/books\/([^/]+)$/, h: (m) => apiBookDetail(decodeURIComponent(m[1])) },
  { m: "POST", p: /^\/api\/books\/([^/]+)\/chapters$/, h: (m, b) => apiCreateChapter(decodeURIComponent(m[1]), b) },
  { m: "GET", p: /^\/api\/books\/([^/]+)\/chapters\/(\d+)$/, h: (m) => apiGetChapter(decodeURIComponent(m[1]), Number(m[2])) },
  { m: "PUT", p: /^\/api\/books\/([^/]+)\/chapters\/(\d+)$/, h: (m, b) => apiSaveChapter(decodeURIComponent(m[1]), Number(m[2]), b) },
  { m: "GET", p: /^\/api\/projects\/([^/]+)$/, h: (m) => apiProjectDetail(decodeURIComponent(m[1])) },
  { m: "GET", p: /^\/api\/projects\/([^/]+)\/chapters\/(\d+)$/, h: (m) => apiChapter(decodeURIComponent(m[1]), Number(m[2])) },
  { m: "GET", p: /^\/api\/projects\/([^/]+)\/events$/, h: (m) => readJsonSafe(path.join(projectRoot(decodeURIComponent(m[1])), "大事件", "event.json")) ?? { events: [] } },
  { m: "GET", p: /^\/api\/projects\/([^/]+)\/volumes$/, h: (m) => readJsonSafe(path.join(projectRoot(decodeURIComponent(m[1])), "卷纲", "volume.json")) ?? { volumes: [] } },
  { m: "GET", p: /^\/api\/projects\/([^/]+)\/chapter-table$/, h: (m) => readJsonSafe(path.join(projectRoot(decodeURIComponent(m[1])), "章节", "章节表.json")) ?? { chapters: [] } },
  { m: "POST", p: /^\/api\/search$/, h: async (_m, body) => apiSearch(body) },
  { m: "GET", p: /^\/api\/config$/, h: () => apiConfigGet() },
  { m: "PUT", p: /^\/api\/config$/, h: (_m, body) => apiConfigPut(body) },
  { m: "GET", p: /^\/api\/models\/(chat|embed)$/, h: async (m) => apiModels(m[1]) },
  { m: "POST", p: /^\/api\/config\/keys$/, h: (_m, b) => apiSaveKeys(b) },
  { m: "POST", p: /^\/api\/system\/open-folder$/, h: (_m, body) => apiOpenFolder(body) },
  { m: "GET", p: /^\/api\/sessions$/, h: () => apiSessions() },
  { m: "GET", p: /^\/api\/sessions\/([^/]+)$/, h: (m) => apiSessionDetail(decodeURIComponent(m[1])) },
  { m: "GET", p: /^\/api\/tasks$/, h: () => ({ tasks: listTasks().map((t) => ({ id: t.id, label: t.label, status: t.status, startedAt: t.startedAt, finishedAt: t.finishedAt, code: t.code })) }) },
  { m: "GET", p: /^\/api\/tasks\/([^/]+)$/, h: (m) => { const t = listTasks().find((x) => x.id === m[1]); if (!t) throw new NovelyError("NOT_FOUND", { context: { id: m[1], kind: "task" } }); return { id: t.id, label: t.label, status: t.status, startedAt: t.startedAt, finishedAt: t.finishedAt, code: t.code, args: t.args }; } },
  { m: "GET", p: /^\/api\/tasks\/([^/]+)\/log$/, h: (m) => { const t = listTasks().find((x) => x.id === m[1]); if (!t) throw new NovelyError("NOT_FOUND", { context: { id: m[1], kind: "task" } }); return { id: t.id, status: t.status, log: loadTaskLog(t.id) }; } },
  { m: "POST", p: /^\/api\/tasks\/([^/]+)\/kill$/, h: (m) => { const t = taskState.get(m[1]); if (t && t.status === "running") { t.status = "killed"; t.finishedAt = new Date().toISOString(); } return { ok: true }; } },
  { m: "POST", p: /^\/api\/tasks\/annotate$/, h: (_m, b) => ({ taskId: startTask("novelread/host-exec.mjs", taskArgsFor("annotate", b), "annotate") }) },
  { m: "POST", p: /^\/api\/tasks\/aggregate$/, h: (_m, b) => ({ taskId: startTask("novelread/aggregates.mjs", taskArgsFor("aggregate", b), "aggregate") }) },
  { m: "POST", p: /^\/api\/tasks\/fix$/, h: (_m, b) => ({ taskId: startTask("novelread/fix.mjs", taskArgsFor("fix", b), "fix") }) },
  { m: "POST", p: /^\/api\/tasks\/preprocess$/, h: (_m, b) => ({ taskId: startTask("features/shot-writing/preprocess.mjs", taskArgsFor("preprocess", b), "preprocess") }) },
  { m: "POST", p: /^\/api\/tasks\/recall$/, h: (_m, b) => ({ taskId: startTask("features/shot-writing/recall.mjs", taskArgsFor("recall", b), "recall") }) },
  { m: "POST", p: /^\/api\/tasks\/writedraft$/, h: (_m, b) => ({ taskId: startTask("features/shot-writing/writedraft.mjs", taskArgsFor("writedraft", b), "writedraft") }) },
  { m: "GET", p: /^\/api\/sessions\/([^/]+)\/final$/, h: (m) => apiSessionFinal(decodeURIComponent(m[1])) },
  { m: "POST", p: /^\/api\/tasks\/import-book$/, h: (_m, b) => apiImportBook(b) },
];

/** 任务参数装配（前端 body → 脚本 CLI 参数） */
function taskArgsFor(kind, b) {
  const a = [];
  switch (kind) {
    case "annotate":
      if (!b?.project) throw new NovelyError("ARG_REQUIRED", { context: { field: "project" } });
      a.push(`--corpus=${b.project}`, `--domain=${b.domain ?? DOMAIN.EX}`);
      if (b.all) a.push("--all");
      else if (b.chapter) a.push(...String(b.chapter).split(",").map((n) => `--chapter=${n.trim()}`));
      else if (b.from) a.push(`--from=${Number(b.from)}`); // 从第 N 章建到清单末尾
      else throw new NovelyError("ARG_REQUIRED", { context: { field: "all|chapter|from" } });
      break;
    case "aggregate":
      if (!b?.project) throw new NovelyError("ARG_REQUIRED", { context: { field: "project" } });
      a.push(b.project);
      if (b.full) a.push("--full");
      if (b.finalizeOnly) a.push("--finalize-only");
      break;
    case "fix":
      if (!b?.project) throw new NovelyError("ARG_REQUIRED", { context: { field: "project" } });
      a.push(b.project);
      if (b.aggregates) { a.push("--aggregates"); if (b.dryRun) a.push("--dry-run"); }
      else if (b.chapter) { a.push(String(b.chapter)); if (b.limit) a.push(`--limit=${b.limit}`); if (b.dryRun) a.push("--dry-run"); }
      else throw new NovelyError("ARG_REQUIRED", { context: { field: "chapter|aggregates" } });
      break;
    case "preprocess":
      if (!b?.input) throw new NovelyError("ARG_REQUIRED", { context: { field: "input" } });
      a.push(`--input=${b.input}`);
      if (b.session) a.push(`--session=${b.session}`);
      break;
    case "recall":
      if (!b?.session) throw new NovelyError("ARG_REQUIRED", { context: { field: "session" } });
      a.push(`--session=${b.session}`);
      // 参考源选择：body.projects（数组，多书）或 body.project（单书兼容）→ --project=A,B
      {
        const sel = Array.isArray(b.projects)
          ? b.projects.filter((x) => typeof x === "string" && x.trim())
          : (b.project ? [String(b.project)] : []);
        if (sel.length) a.push(`--project=${sel.join(",")}`);
      }
      if (b.topk) a.push(`--topk=${b.topk}`);
      break;
    case "writedraft":
      if (!b?.session) throw new NovelyError("ARG_REQUIRED", { context: { field: "session" } });
      a.push(`--session=${b.session}`);
      // 参考源选择与 recall 一致（writedraft 消费 recalls.json，参数仅记录）
      {
        const sel = Array.isArray(b.projects)
          ? b.projects.filter((x) => typeof x === "string" && x.trim())
          : (b.project ? [String(b.project)] : []);
        if (sel.length) a.push(`--project=${sel.join(",")}`);
      }
      break;
  }
  return a;
}

/* ================= 静态页（内置最小 HTML，方便直接浏览器打开） ================= */
const INDEX_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>NovelyWrite</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;background:#0f1115;color:#e5e7eb}
header{padding:16px 24px;background:#161a22;border-bottom:1px solid #2a2f3a}
header h1{margin:0;font-size:18px}
main{padding:24px;max-width:1100px;margin:0 auto}
.card{background:#161a22;border:1px solid #2a2f3a;border-radius:8px;padding:16px;margin-bottom:16px}
button{background:#2563eb;color:#fff;border:none;padding:6px 14px;border-radius:6px;cursor:pointer}
button:disabled{opacity:.5}
input,select,textarea{background:#0f1115;color:#e5e7eb;border:1px solid #2a2f3a;border-radius:6px;padding:6px}
code{background:#0f1115;padding:2px 5px;border-radius:4px;font-size:12px}
.tag{display:inline-block;background:#1e3a5f;color:#93c5fd;border-radius:4px;padding:1px 7px;font-size:12px;margin-right:4px}
.hit{border-left:3px solid #2563eb;padding:6px 10px;margin:6px 0;background:#10131a}
pre{white-space:pre-wrap;font-size:13px;background:#0f1115;padding:10px;border-radius:6px;max-height:400px;overflow:auto}
#log{height:200px;overflow:auto;font-family:monospace;font-size:12px}
.muted{color:#9ca3af;font-size:12px}
</style>
</head>
<body>
<header><h1>NovelyWrite · 工作台</h1></header>
<main>
  <div class="card"><h3>API 服务运行中</h3>
    <p class="muted">本页为内置最小页。完整前端可对接以下接口（全部 JSON）：</p>
    <p><code>GET /api/projects</code> · <code>GET /api/projects/:name</code> · <code>GET /api/projects/:name/chapters/:n</code> · <code>POST /api/search</code> · <code>GET/PUT /api/config</code> · <code>GET /api/sessions</code> · <code>POST /api/tasks/annotate|aggregate|fix|preprocess|recall|writedraft</code> · <code>GET /api/tasks/:id</code></p>
  </div>
  <div class="card"><h3>项目列表</h3><div id="projects">加载中…</div></div>
  <div class="card"><h3>三通道检索</h3>
    <input id="q" placeholder="查询文本" style="width:60%"><br><br>
    <select id="type"><option value="">类型(不限)</option>${SHOT_TYPES.map((t) => `<option>${t}</option>`).join("")}</select>
    <select id="func"><option value="">功能(不限)</option>${SENTENCE_FUNCS.map((f) => `<option>${f}</option>`).join("")}</select>
    <input id="label" placeholder="浓缩标签(可选)" style="width:200px">
    <button onclick="doSearch()">检索</button>
    <div id="hits"></div>
  </div>
  <div class="card"><h3>任务</h3>
    <button onclick="runTask('annotate')">标注(需 project)</button>
    <button onclick="runTask('aggregate')">聚合(需 project)</button>
    <div id="tasks"></div>
    <div id="log"></div>
  </div>
</main>
<script>
async function j(url, opt) { const r = await fetch(url, opt); const d = await r.json(); if (!r.ok) throw new Error(JSON.stringify(d)); return d; }
async function loadProjects() {
  const d = await j('/api/projects');
  document.getElementById('projects').innerHTML = d.projects.length
    ? d.projects.map(p => '<div><b>'+p.name+'</b> <span class="muted">['+(p.domain==='my'?'我的作品':'外部知识库')+'] '+(p.meta?p.meta.chaptersAnnotated+'章/'+p.meta.shots+'镜':'无meta')+'</span></div>').join('')
    : '无项目';
}
async function doSearch() {
  const body = { text: document.getElementById('q').value, type: document.getElementById('type').value, funcs: document.getElementById('func').value ? [document.getElementById('func').value] : [], label: document.getElementById('label').value, topk: 6 };
  const d = await j('/api/search', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
  document.getElementById('hits').innerHTML = (d.hits||[]).map(h => '<div class="hit"><b>['+h.source+']</b> '+h.shot.project+' 第'+h.shot.chapter+'章 镜'+h.shot.shotId+'「'+h.shot.label+'」<div class="muted">'+h.shot.type+'/'+(h.shot.funcs||[]).join('、')+'</div></div>').join('') || '无命中';
}
async function runTask(kind) {
  const body = { project: prompt('project 名(如 大王饶命):'), chapter: prompt('章号(留空=全部):') || undefined, all: !prompt('章号(留空=全部):') };
  const d = await j('/api/tasks/'+kind, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
  document.getElementById('log').textContent += '\\n已启动任务 ' + d.taskId;
  pollTask(d.taskId);
}
async function pollTask(id) {
  const t = setInterval(async () => {
    const d = await j('/api/tasks/'+id);
    const lg = await j('/api/tasks/'+id+'/log');
    document.getElementById('log').textContent = (lg.log||[]).join('\\n');
    if (d.status !== 'running') { clearInterval(t); document.getElementById('log').textContent += '\\n[完成] '+d.status; }
  }, 2000);
}
loadProjects();
</script>
</body>
</html>`;

/* ================= 服务器 ================= */
const webviewDir = path.join(CODE_ROOT, "webview");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".ico": "image/x-icon", ".map": "application/json",
};

/** 静态文件托管：优先 webview/ 目录；缺文件回退内置页/404 */
function serveStatic(res, pathname) {
  let rel = pathname === "/" ? "/index.html" : pathname;
  // 防目录穿越
  const file = path.normalize(path.join(webviewDir, rel));
  if (!file.startsWith(webviewDir)) { json(res, 403, { ok: false, error: { code: "ARG_INVALID", message: "路径非法" } }); return; }
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(fs.readFileSync(file));
    return;
  }
  // webview/index.html 缺失 → 回退内置最小页；其他静态文件缺失 → 404
  if (rel === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(INDEX_HTML);
    return;
  }
  json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: `文件不存在: ${pathname}` } });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname;

  // 静态资源（webview/ 目录：/ → index.html，/app.js /style.css /vendor/*）
  if (req.method === "GET" && (pathname.startsWith("/vendor/") || pathname === "/" || pathname === "/index.html" || pathname === "/app.js" || pathname === "/style.css" || pathname === "/favicon.ico")) {
    if (pathname === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    serveStatic(res, pathname);
    return;
  }

  // API 路由
  for (const r of ROUTES) {
    if (req.method !== r.m) continue;
    const m = pathname.match(r.p);
    if (!m) continue;
    try {
      const body = ["POST", "PUT"].includes(req.method) ? await getBody(req) : null;
      const data = await r.h(m, body);
      json(res, 200, data);
    } catch (err) {
      errRes(res, err);
    }
    return;
  }

  json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: `无此接口: ${req.method} ${pathname}` } });
});

// 首启建目录骨架（corpus/store 两域/mybook/output）——新安装即可用，open-folder 等按路径操作不报缺目录
ensureDataDirs();

server.listen(port, host, () => {
  // 动态端口：--port=0 时由系统分配，此处取真实端口（必然空闲，杜绝端口冲突）
  const actualPort = server.address().port;
  const actualUrl = `http://${host}:${actualPort}`;
  console.log(`\nNovelyWrite HTTP 服务已启动`);
  console.log(`  地址: ${actualUrl}${port === 0 ? "（动态端口，系统分配）" : ""}`);
  console.log(`  接口: /api/projects /api/search /api/config /api/sessions /api/tasks/*\n`);
  // 端口就绪后再打开 web（时序：先起服务、拿端口、再打开页面）
  // --open 时自动调起系统默认浏览器（Tauri 壳/桌面版改为创建 WebView 窗口指向 actualUrl）
  if (args.includes("--open")) {
    const url = actualUrl;
    try {
      const cmd = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
      const cmdArgs = process.platform === "win32" ? ["/c", "start", "", url] : [url];
      spawn(cmd, cmdArgs, { stdio: "ignore", detached: true }).unref();
      console.log(`  已打开: ${url}\n`);
    } catch (err) {
      console.error(`  自动打开失败（可手动访问 ${url}）: ${err.message}`);
    }
  }
});
