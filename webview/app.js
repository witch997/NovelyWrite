/**
 * app.js — NovelyWrite 写作工作台前端逻辑
 *
 * 三栏:左=大纲 / 中=Vditor 正文编辑器 / 右=AI 参考
 * 全部通过 fetch 调 server.mjs 的 /api/* 接口,前端不直接碰 Node 模块。
 *
 * 接口依赖(server.mjs):
 *   GET  /api/config         → 配置状态(模型/就绪)
 *   GET  /api/projects       → 项目列表(参考池勾选)
 *   POST /api/tasks/preprocess → 输入 → 分镜序列(会话)
 *   GET  /api/sessions/:id   → 会话详情(shots)
 *   POST /api/tasks/recall   → 装配参考
 *   POST /api/tasks/writedraft → 写作成稿
 *   GET  /api/tasks/:id      → 任务状态(轮询)
 *   GET  /api/tasks/:id/log  → 任务日志(进度)
 */
(() => {
  "use strict";

  /* ================= 全局状态 ================= */
  const state = {
    books: [],           // 我的书列表 [{name, chapters, updatedAt}]
    currentBook: null,   // 当前书
    chapters: [],        // 当前书章节列表 [{num, title, updatedAt}]
    currentChapter: null, // 当前章号
    sessionId: null,     // 当前写作会话
    shots: [],           // 当前分镜序列
    taskPolling: null,   // 轮询定时器
    busy: false,
  };

  /* ================= DOM 引用 ================= */
  const $ = (id) => document.getElementById(id);
  const outlineList = $("outlineList");
  const aiResult = $("aiResult");

  /* ================= 通用工具 ================= */
  async function api(url, opt = {}) {
    const res = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      ...opt,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    return data;
  }
  const pad4 = (n) => String(n).padStart(4, "0");

  /* ================= 轻量提示(toast,右下角浮动) ================= */
  let toastTimer = null;
  function toast(msg) {
    let el = document.getElementById("toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2500);
  }

  /* ================= Vditor 编辑器 ================= */
  let vditor = null;
  function initEditor() {
    vditor = new Vditor("vditor", {
      height: "100%",
      mode: "ir", // 即时渲染(所见即所得,写作友好)
      value: "",
      placeholder: "开始写作…(Markdown)",
      cache: { enable: false }, // 不依赖 localStorage 缓存
      toolbar: [
        "headings", "bold", "italic", "strike", "|",
        "list", "ordered-list", "quote", "|",
        "link", "upload", "table", "|",
        "undo", "redo", "|", "fullscreen",
      ],
      counter: { enable: true, type: "text" },
      input: (val) => {
        const len = (val || "").replace(/\s/g, "").length;
        $("wordCount").textContent = `${len} 字`;
        autoSave();
      },
      after: () => {
        $("wordCount").textContent = "0 字";
      },
    });
  }

  /* ================= 自动保存（server 持久化：PUT /api/books/:name/chapters/:n） ================= */
  let saveTimer = null;
  function autoSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveChapter(true), 800); // 输入停顿立即保存（即时保护）
  }

  /** 保存当前章节到 mybook 资产区（静默模式不打扰 UI） */
  async function saveChapter(silent) {
    if (!state.currentBook || !state.currentChapter || !vditor) return;
    const content = vditor.getValue();
    try {
      await api(`/api/books/${encodeURIComponent(state.currentBook)}/chapters/${state.currentChapter}`, {
        method: "PUT",
        body: JSON.stringify({ content }),
      });
      if (!silent) toast("✅ 已保存到 mybook");
    } catch (e) {
      if (!silent) toast(`保存失败: ${e.message}`);
    }
  }

  /* 定时自动保存（设置里可调间隔，默认 5 分钟；0=关闭） */
  let autoSaveTimer = null;
  function applyAutoSaveSetting() {
    clearInterval(autoSaveTimer);
    autoSaveTimer = null;
    const min = getAutoSaveMinutes();
    if (min > 0) {
      autoSaveTimer = setInterval(() => {
        if (state.currentBook && state.currentChapter) saveChapter(true);
      }, min * 60 * 1000);
    }
  }
  /** 读取自动保存间隔（localStorage，默认 5 分钟） */
  function getAutoSaveMinutes() {
    const v = Number(localStorage.getItem("nw-autosave-min") ?? "5");
    return Number.isFinite(v) && v >= 0 ? v : 5;
  }

  /* ================= 书（我的作品 mybook 资产区） ================= */
  async function loadBooks() {
    try {
      const d = await api("/api/books");
      state.books = d.books || [];
      const sel = $("bookSelect");
      sel.innerHTML = "";
      if (!state.books.length) {
        sel.innerHTML = '<option value="">(无书,先新建)</option>';
        state.currentBook = null;
        renderOutline();
        return;
      }
      for (const b of state.books) {
        const opt = document.createElement("option");
        opt.value = b.name;
        opt.textContent = `${b.name}（${b.chapters}章）`;
        sel.appendChild(opt);
      }
      // 保持当前选择（或默认第一本）
      if (state.currentBook && state.books.some((b) => b.name === state.currentBook)) {
        sel.value = state.currentBook;
      } else {
        state.currentBook = state.books[0].name;
        sel.value = state.currentBook;
      }
      await loadBookDetail(state.currentBook);
    } catch (e) {
      $("outlineList").innerHTML = `<div class="placeholder">书加载失败: ${e.message}</div>`;
    }
  }

  /** 加载某书章节列表 */
  async function loadBookDetail(name) {
    state.currentBook = name;
    state.currentChapter = null;
    const d = await api(`/api/books/${encodeURIComponent(name)}`);
    state.chapters = d.chapters || [];
    renderOutline();
    if (state.chapters.length) {
      openChapter(state.chapters[0].num);
    } else if (vditor) {
      vditor.setValue("");
      $("currentChapterTitle").textContent = `${name} · 未命名`;
    }
  }

  /** 新建书（prompt 书名 → POST /api/books → 刷新并选中） */
  async function newBook() {
    const name = prompt("新建书（书名，仅中文/字母/数字等）:");
    if (!name) return;
    try {
      await api("/api/books", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
      await loadBooks();
      $("bookSelect").value = name.trim();
      state.currentBook = name.trim();
      await loadBookDetail(name.trim());
      toast(`✅ 已建书: ${name.trim()}`);
    } catch (e) {
      toast(`建书失败: ${e.message}`);
    }
  }

  /** 书选择变化 */
  async function onBookChange() {
    const name = $("bookSelect").value;
    if (!name) { state.currentBook = null; renderOutline(); return; }
    await loadBookDetail(name);
  }

  /* ================= 大纲 ================= */
  function renderOutline() {
    const list = outlineList;
    list.innerHTML = "";
    if (!state.currentBook) {
      list.innerHTML = '<div class="placeholder">先选择或新建一本书<br>再「+ 章」开始写作</div>';
      return;
    }
    if (!state.chapters.length) {
      list.innerHTML = '<div class="placeholder">暂无章节<br>点击「+ 章」新建</div>';
      return;
    }
    for (const c of state.chapters) {
      const item = document.createElement("div");
      item.className = "outline-item" + (c.num === state.currentChapter ? " active" : "");
      // 右侧显示本章总字数（含标点），而非章号
      const chars = typeof c.chars === "number" ? c.chars.toLocaleString("zh-CN") : "0";
      item.innerHTML = `<span title="第${pad4(c.num)}章">${escapeHtml(c.title || `第${c.num}章`)}</span><span class="ch-num">${chars}字</span>`;
      item.onclick = () => openChapter(c.num);
      list.appendChild(item);
    }
  }

  /** 新建章节（当前书） */
  async function addChapter() {
    if (!state.currentBook) { toast("请先选择或新建一本书"); return; }
    try {
      const r = await api(`/api/books/${encodeURIComponent(state.currentBook)}/chapters`, { method: "POST", body: JSON.stringify({}) });
      toast(`✅ 已新建第${r.num}章`);
      await loadBookDetail(state.currentBook); // 刷新列表（自动打开第一章；若已打开则保持）
      // 保持当前打开的章不变；新章通常是最新一章
      if (!state.currentChapter) openChapter(r.num);
    } catch (e) {
      toast(`新建章节失败: ${e.message}`);
    }
  }

  /** 打开章节（读 mybook 内容 → 编辑器） */
  async function openChapter(num) {
    if (!state.currentBook) return;
    state.currentChapter = num;
    renderOutline();
    try {
      const d = await api(`/api/books/${encodeURIComponent(state.currentBook)}/chapters/${num}`);
      if (vditor) vditor.setValue(d.content || "");
      $("currentChapterTitle").textContent = `${state.currentBook} · ${d.title || `第${pad4(num)}章`}`;
    } catch (e) {
      $("currentChapterTitle").textContent = `第${pad4(num)}章`;
      toast(`读取章节失败: ${e.message}`);
    }
  }

  /* ================= 配置状态 + 模型选择器（顶栏右侧，从 API 读可用模型） ================= */

  /** 从 API 读可用模型（kind=chat|embed）；无 key 时返回 {ok:false,reason} */
  async function fetchModels(kind) {
    try {
      return await api(`/api/models/${kind}`);
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  /** 填充 select：模型列表 + 当前值；空/无 key → 提示占位 */
  function fillModelSelect(sel, data, current) {
    sel.innerHTML = "";
    if (!data?.ok) {
      const o = document.createElement("option");
      o.value = "";
      o.textContent = `(未配置 Key：${(data?.reason || "读取失败").slice(0, 40)})`;
      sel.appendChild(o);
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    const opts = new Set([...(data.models || []), ...(current ? [current] : [])]);
    for (const m of opts) {
      const o = document.createElement("option");
      o.value = m;
      o.textContent = m;
      sel.appendChild(o);
    }
    if (current) sel.value = current;
    else if (data.models?.length) sel.value = data.models[0];
  }

  async function loadConfig() {
    try {
      const cfg = await api("/api/config");
      // LLM 就绪状态（模型选择器左侧）
      const statusEl = $("envStatus");
      if (cfg?.chat?.apiKeySet) {
        statusEl.textContent = "LLM 就绪";
        statusEl.className = "env-status ok";
      } else {
        statusEl.textContent = "⚠ LLM 未配置(无 apiKey)";
        statusEl.className = "env-status warn";
      }
      // 顶栏写作模型选择器：选项从写作 API 读（独立 base/key，缺则回退全局 chat）
      const current = cfg?.features?.["shot-writing"]?.chat?.model || "";
      const data = await fetchModels("writing");
      fillModelSelect($("modelSelect"), data, current);
    } catch {
      $("envStatus").textContent = "服务未连接";
      $("envStatus").className = "env-status warn";
      $("modelSelect").innerHTML = '<option value="">(无连接)</option>';
    }
  }

  /** 模型切换 → 写入 config features.shot-writing.chat.model */
  async function onModelChange() {
    const model = $("modelSelect").value;
    if (!model) return;
    try {
      await api("/api/config", {
        method: "PUT",
        body: JSON.stringify({ features: { "shot-writing": { chat: { model } } } }),
      });
      toast(`✅ 写作模型: ${model}`);
    } catch (e) {
      toast(`模型切换失败: ${e.message}`);
    }
  }

  /* ================= 参考书池(跨书参考源选择,可多选) ================= */
  const refPool = new Map(); // name → {checked, domain}
  async function loadRefPool() {
    try {
      const d = await api("/api/projects");
      const list = (d.projects || []).sort((a, b) => a.name.localeCompare(b.name, "zh"));
      const box = $("refPoolList");
      if (!list.length) { box.innerHTML = '<span class="muted">无已建库项目(先 annotate 建库)</span>'; return; }
      box.innerHTML = "";
      for (const p of list) {
        const pendN = (p.pending || []).length;
        const label = `${p.name}（${p.domain === "my" ? "我的" : "外部"}${p.meta?.chaptersAnnotated ? ` ${p.meta.chaptersAnnotated}章` : ""}${pendN ? ` ⚠缺${pendN}章` : ""}）`;
        refPool.set(p.name, { checked: false, domain: p.domain });
        const item = document.createElement("label");
        item.className = "ref-pool-item" + (pendN ? " has-pending" : "");
        item.innerHTML = `<input type="checkbox" data-book="${escapeHtml(p.name)}"> <span>${escapeHtml(label)}</span>`;
        item.querySelector("input").addEventListener("change", (e) => {
          const b = refPool.get(p.name);
          if (b) b.checked = e.target.checked;
        });
        box.appendChild(item);
      }
    } catch {
      $("refPoolList").innerHTML = '<span class="muted">参考书加载失败</span>';
    }
  }
  /** 收集勾选的参考书（数组；空 = 全库跨书） */
  function selectedRefBooks() {
    return [...refPool.entries()].filter(([, v]) => v.checked).map(([name]) => name);
  }

  /* ================= 导入参考书（选 txt → 选建库范围 → 自动建库） ================= */
  function importBook() {
    const input = $("bookFileInput");
    input.value = "";
    input.click(); // 打开文件选择器（选语料 txt）
  }

  async function onBookFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const base = file.name.replace(/\.txt$/i, "").replace(/-语料$/, "").trim();
    // 查已建库进度（同名项目已标注章数 = 续建起点）
    let lastCh = 0;
    try {
      const d = await api("/api/projects");
      lastCh = (d.projects || []).find((p) => p.name === base)?.meta?.chaptersAnnotated || 0;
    } catch { /* 查不到按 0 */ }
    const startCh = lastCh + 1; // 续建从最新章节的下一章开始
    const defEnd = startCh + 29; // 默认一次续建 30 章（推荐单批上限）
    const hint = lastCh > 0 ? `已建库至第 ${lastCh} 章，将从第 ${startCh} 章续建` : "尚未建库，将从第 1 章开始";
    const endStr = prompt(
      `导入《${base}》——选择建库范围（${hint}）\n\n` +
      `· 输入终点章号 N = 从第 ${startCh} 章续建到第 N 章（推荐每次 ≤30 章）\n` +
      `· 输入 0 = 全量建库（⚠ 从头建全书，一次开销很大，不推荐）\n` +
      `· 输入 p = 补建指令（只补上次未完成的缺章）\n\n` +
      `默认终点章号：`,
      String(defEnd)
    );
    if (endStr === null) return; // 取消
    const body = { filename: file.name, content: await file.text() };
    const s = String(endStr).trim().toLowerCase();
    if (s === "p") {
      body.pending = true; // 补建指令
    } else if (s === "0") {
      body.from = 0; // 全量（服务器端转 --all）
    } else {
      const end = parseInt(s, 10);
      if (!Number.isFinite(end) || end < startCh) { toast(`终点章号需 ≥ ${startCh}，已取消`); return; }
      body.from = startCh; // 从最新章节之后续建
      body.to = end;       // 到指定终点章
    }
    toast(`正在导入《${base}》并生成章节清单…`);
    try {
      const r = await api("/api/tasks/import-book", { method: "POST", body: JSON.stringify(body) });
      const modeDesc = body.pending ? "补建缺章" : body.to ? `续建第${body.from}~${body.to}章` : r.mode;
      toast(`✅ 已开始建库《${r.name}》（${modeDesc}）`);
      await loadRefPool(); // 刷新参考书池
    } catch (err) {
      toast(`导入失败: ${err.message}`);
    }
  }

  /* ================= 对我的书建库标注（mybook 原稿 → 语料 → 标注 → 向量 → 聚合） ================= */
  async function annotateBook() {
    const name = state.currentBook;
    if (!name) { toast("请先选择一本书"); return; }
    // 查该书已建库进度（my 域 project-meta.chaptersAnnotated = 续建起点）
    let lastCh = 0;
    try {
      const d = await api("/api/projects");
      lastCh = (d.projects || []).find((p) => p.name === name && p.domain === "my")?.meta?.chaptersAnnotated || 0;
    } catch { /* 查不到按 0 */ }
    const startCh = lastCh + 1; // 续建从最新章节的下一章开始
    const defEnd = startCh + 29; // 默认一次续建 30 章（推荐单批上限）
    const hint = lastCh > 0 ? `已建库至第 ${lastCh} 章，将从第 ${startCh} 章续建` : "尚未建库，将从第 1 章开始";
    const endStr = prompt(
      `对《${name}》建库标注（${hint}）\n\n` +
      `· 输入终点章号 N = 从第 ${startCh} 章续建到第 N 章（推荐每次 ≤30 章）\n` +
      `· 输入 0 = 全量建库（⚠ 从头建全书，一次开销很大，不推荐）\n` +
      `· 输入 p = 补建指令（只补上次未完成的缺章）\n\n` +
      `默认终点章号：`,
      String(defEnd)
    );
    if (endStr === null) return; // 取消
    const body = { name, domain: "my" }; // domain=my：server 从 mybook 原稿合成语料
    const s = String(endStr).trim().toLowerCase();
    if (s === "p") {
      body.pending = true; // 补建指令
    } else if (s === "0") {
      body.from = 0; // 全量（服务器端转 --all）
    } else {
      const end = parseInt(s, 10);
      if (!Number.isFinite(end) || end < startCh) { toast(`终点章号需 ≥ ${startCh}，已取消`); return; }
      body.from = startCh; // 从最新章节之后续建
      body.to = end;       // 到指定终点章
    }
    toast(`正在对《${name}》合成语料并建库…`);
    try {
      const r = await api("/api/tasks/import-book", { method: "POST", body: JSON.stringify(body) });
      const modeDesc = body.pending ? "补建缺章" : body.to ? `续建第${body.from}~${body.to}章` : r.mode;
      toast(`✅ 已开始建库《${r.name}》（${modeDesc}）`);
      await loadRefPool(); // 刷新参考书池（我的书会以「我的」域出现）
    } catch (err) {
      toast(`建库失败: ${err.message}`);
    }
  }

  /* ================= AI 写作流程 ================= */
  async function startTask(kind, body) {
    const { taskId } = await api(`/api/tasks/${kind}`, { method: "POST", body: JSON.stringify(body) });
    return taskId;
  }

  function pollTask(taskId, onDone) {
    clearInterval(state.taskPolling);
    state.taskPolling = setInterval(async () => {
      try {
        const t = await api(`/api/tasks/${taskId}`);
        if (t.status !== "running") {
          clearInterval(state.taskPolling);
          state.taskPolling = null;
          onDone?.(t);
        }
      } catch { /* 轮询失败忽略,下轮重试 */ }
    }, 1500);
  }

  /** AI 成稿区状态提示（替代原底部任务日志） */
  function setAiStatus(msg) {
    aiResult.innerHTML = `<div class="ai-status">${escapeHtml(msg)}</div>`;
  }

  /** 从任务日志提取 sessionId（不渲染分镜，AI 写作全流程自动衔接） */
  async function resolveSessionId(taskId) {
    try {
      const log = await api(`/api/tasks/${taskId}/log`);
      const line = (log.log || []).find((l) => l.includes("sessions/"));
      const m = line?.match(/sessions\/([^/\s]+)/);
      return m ? m[1] : null;
    } catch { return null; }
  }

  /** AI 写作全流程：输入剧情需求 → preprocess(分镜) → recall(召回) → writedraft(成稿) → 成稿直显 */
  async function aiWrite() {
    const prompt = $("aiPrompt").value.trim();
    if (!prompt) { setAiStatus("请先输入剧情需求"); return; }
    if (state.busy) return;
    state.busy = true;
    setAiStatus("AI 生成中：正在生成分镜序列…");
    try {
      const preId = await startTask("preprocess", { input: prompt });
      pollTask(preId, async (t) => {
        if (t.status !== "success") { setAiStatus("❌ 分镜生成失败"); state.busy = false; return; }
        const sid = await resolveSessionId(preId);
        if (!sid) { setAiStatus("❌ 会话 id 未找到"); state.busy = false; return; }
        state.sessionId = sid;
        const refBooks = selectedRefBooks();
        setAiStatus(refBooks.length ? `AI 生成中：正在从 ${refBooks.join(" + ")} 召回参考…` : "AI 生成中：正在召回参考（全库）…");
        const recallId = await startTask("recall", { session: sid, topk: 6, projects: refBooks });
        pollTask(recallId, async (t2) => {
          if (t2.status !== "success") { setAiStatus("❌ 参考召回失败"); state.busy = false; return; }
          setAiStatus("AI 生成中：正在写作成稿…");
          const draftId = await startTask("writedraft", { session: sid, projects: refBooks });
          pollTask(draftId, async (dt) => {
            state.busy = false;
            if (dt.status !== "success") { setAiStatus("❌ 成稿失败"); return; }
            await showFinalDraft();
          });
        });
      });
    } catch (e) {
      state.busy = false;
      setAiStatus(`❌ AI 写作失败: ${e.message}`);
    }
  }

  /** 成稿直显：读 output/<项目名>.final.txt（纯正文，无分镜标签），顶端默认在栏顶端 */
  async function showFinalDraft() {
    try {
      const d = await api(`/api/sessions/${state.sessionId}/final`);
      if (!d.ok) { setAiStatus(`成稿未找到: ${d.reason}`); return; }
      aiResult.innerHTML = `
        <div class="draft-title">
          <span>📄 AI 成稿 · ${escapeHtml(d.file)}</span>
          <button class="btn btn-sm btn-primary" onclick="window.__insertDraft()">↪ 插入到写作栏</button>
        </div>
        <div class="draft-text">${escapeHtml(d.content)}</div>`;
      // 结果顶端默认在本栏顶端（不滚动即看到开头）
      const sec = document.getElementById("aiResultSec");
      if (sec) sec.scrollTop = 0;
    } catch (e) {
      setAiStatus(`读取成稿失败: ${e.message}`);
    }
  }

  /** 把成稿全文插入当前章节编辑器（不走剪贴板，完整保留段落/换行排版） */
  function insertDraftToEditor() {
    if (!state.currentBook || !state.currentChapter) { toast("请先在中间栏打开一个章节"); return; }
    if (!vditor) return;
    const el = aiResult.querySelector(".draft-text");
    const text = el ? el.textContent : "";
    if (!text.trim()) { toast("成稿为空"); return; }
    const cur = vditor.getValue();
    const sep = cur && cur.trim() ? "\n\n" : "";
    vditor.setValue((cur.replace(/\s+$/, "") || "") + sep + text);
    saveChapter(true);
    toast("✅ 已插入到当前章节并保存");
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* ================= 可拖拽布局：三栏宽度 + 右栏内三块高度 ================= */
  function initSplitters() {
    const layout = document.querySelector(".layout");
    const layoutW = () => layout.getBoundingClientRect().width;
    const left = $("paneLeft"), right = $("paneRight");
    const spLeft = document.querySelector('.splitter-v[data-split="left"]');
    const spRight = document.querySelector('.splitter-v[data-split="right"]');
    const panel = document.getElementById("aiPanel");
    const inputSec = $("aiInputSec"), refSec = $("aiRefSec"), resultSec = $("aiResultSec");
    const spH1 = document.querySelector('.splitter-h[data-split="aiInput"]');
    const spH2 = document.querySelector('.splitter-h[data-split="aiRef"]');

    // 恢复记忆尺寸（列宽）
    const savedL = Number(localStorage.getItem("nw-left-w"));
    const savedR = Number(localStorage.getItem("nw-right-w"));
    if (savedL > 0) left.style.width = Math.min(savedL, layoutW() * 0.6) + "px";
    if (savedR > 0) right.style.width = Math.min(savedR, layoutW() * 0.6) + "px";

    /* ---------- AI 栏：三块 + 两条拖拽条 绝对定位统一排布 ----------
     * 输入区/参考书区高度用 JS 变量（记忆/默认），成稿区贴底占剩余。
     * 所有 top/height 由 layoutAiPanel 一次性计算 → 区块物理上不可能跨栏/互相覆盖。 */
    let inputH = Math.max(110, Number(localStorage.getItem("nw-ai-input-h")) || 160);
    let refH = Math.max(60, Number(localStorage.getItem("nw-ai-ref-h")) || 130);
    const SPLIT = 5; // 单条拖拽条高

    function layoutAiPanel() {
      const panelH = panel.getBoundingClientRect().height;
      if (!panelH) return;
      const resultH = Math.max(80, panelH - inputH - refH - SPLIT * 2);
      // 输入区
      inputSec.style.top = "0px";
      inputSec.style.height = inputH + "px";
      // 拖拽条1
      spH1.style.top = inputH + "px";
      // 参考书区
      refSec.style.top = inputH + SPLIT + "px";
      refSec.style.height = refH + "px";
      // 拖拽条2
      spH2.style.top = inputH + SPLIT + refH + "px";
      // 成稿区（贴底）
      resultSec.style.top = inputH + SPLIT * 2 + refH + "px";
      resultSec.style.height = resultH + "px";
    }
    layoutAiPanel();

    /** 列宽拖拽（左栏向右增宽 / 右栏向左增宽） */
    function dragCol(spEl, target, saveKey, isLeft) {
      spEl.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        spEl.setPointerCapture?.(e.pointerId);
        spEl.classList.add("dragging");
        const startX = e.clientX;
        const startW = target.getBoundingClientRect().width;
        const move = (ev) => {
          const delta = ev.clientX - startX;
          const w = Math.max(140, Math.min(startW + (isLeft ? delta : -delta), layoutW() * 0.6));
          target.style.width = w + "px";
        };
        const up = (ev) => {
          spEl.classList.remove("dragging");
          spEl.releasePointerCapture?.(ev.pointerId);
          document.removeEventListener("pointermove", move);
          document.removeEventListener("pointerup", up);
          document.removeEventListener("pointercancel", up);
          localStorage.setItem(saveKey, String(Math.round(target.getBoundingClientRect().width)));
        };
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", up);
        document.addEventListener("pointercancel", up);
      });
    }

    /** 行高拖拽：改 JS 变量 inputH/refH（带 clamp），layoutAiPanel 重排全部区块。
     *  pointer events + setPointerCapture：鼠标移出窗口不丢事件，杜绝卡死。 */
    function dragRow(spEl, kind, saveKey, minH) {
      spEl.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        spEl.setPointerCapture?.(e.pointerId);
        spEl.classList.add("dragging");
        const startY = e.clientY;
        const startH = kind === "input" ? inputH : refH;
        const move = (ev) => {
          const panelH = panel.getBoundingClientRect().height;
          const otherH = kind === "input" ? refH : inputH;
          // 目标块上限 = 面板 − 另一块 − 成稿区最小(80) − 两条拖拽条
          const maxH = panelH - otherH - 80 - SPLIT * 2;
          const h = Math.max(minH, Math.min(startH + (ev.clientY - startY), maxH));
          if (kind === "input") inputH = h; else refH = h;
          layoutAiPanel();
        };
        const up = (ev) => {
          spEl.classList.remove("dragging");
          spEl.releasePointerCapture?.(ev.pointerId);
          document.removeEventListener("pointermove", move);
          document.removeEventListener("pointerup", up);
          document.removeEventListener("pointercancel", up);
          localStorage.setItem(saveKey, String(Math.round(kind === "input" ? inputH : refH)));
        };
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", up);
        document.addEventListener("pointercancel", up);
      });
    }

    dragCol(spLeft, left, "nw-left-w", true);
    dragCol(spRight, right, "nw-right-w", false);
    dragRow(spH1, "input", "nw-ai-input-h", 110); // 输入区：需容纳按钮+输入框
    dragRow(spH2, "ref", "nw-ai-ref-h", 60);       // 参考书区：标题+可滚动列表
    window.addEventListener("resize", () => layoutAiPanel());
  }

  /* ================= 主题切换 ================= */
  function applyTheme(theme) {
    document.body.dataset.theme = theme;
    localStorage.setItem("nw-theme", theme);
    document.querySelectorAll("#themeSwitch .ts-item").forEach((el) => {
      el.classList.toggle("active", el.dataset.theme === theme);
    });
  }

  /* ================= 设置面板 ================= */
  function openSettings() {
    $("settingsMask").classList.add("open");
    loadSettingsForm();
  }
  function closeSettings() {
    $("settingsMask").classList.remove("open");
  }

  /** 加载当前配置到表单 + 从 API 读模型填充三个选择器 + 自动保存间隔 */
  async function loadSettingsForm() {
    try {
      const cfg = await api("/api/config");
      // Key 状态提示（不回显密钥）
      $("setChatApiKey").placeholder = cfg?.chat?.apiKeySet ? "已配置 ✓（留空不修改）" : "未配置，填入 sk-…";
      $("setEmbedApiKey").placeholder = cfg?.embed?.apiKeySet ? "已配置 ✓（留空不修改）" : "未配置，填入 sk-…";
      $("setShotApiKey").placeholder = cfg?.features?.["shot-writing"]?.chat?.apiKey ? "已配置 ✓（留空不修改）" : "留空 = 用建库的 Key";
      // 网址（回显；为空则占位默认）
      $("setChatBaseUrl").value = cfg?.chat?.baseUrl || "";
      $("setEmbedBaseUrl").value = cfg?.embed?.baseUrl || "";
      $("setShotBaseUrl").value = cfg?.features?.["shot-writing"]?.chat?.baseUrl || "";
      // 模型选择器（从各自 API 读：建库=chat / 写作=writing(独立API) / 向量=embed）
      const [chatData, writingData, embedData] = await Promise.all([fetchModels("chat"), fetchModels("writing"), fetchModels("embed")]);
      fillModelSelect($("setAnnotateModel"), chatData, cfg?.chat?.model || "");
      fillModelSelect($("setEmbedModel"), embedData, cfg?.embed?.model || "");
      fillModelSelect($("setShotModel"), writingData, cfg?.features?.["shot-writing"]?.chat?.model || "");
      $("setShotTemp").value = cfg?.features?.["shot-writing"]?.chat?.temperature ?? cfg?.chat?.temperature ?? "";
    } catch (e) {
      toast(`读取配置失败: ${e.message}`);
    }
    // 自动保存间隔
    const min = getAutoSaveMinutes();
    const sel = $("setAutoSave");
    const row = $("autoSaveCustomRow");
    if ([0, 1, 5, 10, 30].includes(min)) {
      sel.value = String(min);
      row.style.display = "none";
    } else {
      sel.value = "custom";
      row.style.display = "flex";
      $("setAutoSaveCustom").value = min;
    }
  }

  /** 保存设置：Key/网址/模型/温度（PUT /api/config，支持各模块独立 API）+ 自动保存间隔 */
  async function saveSettings() {
    const val = (id) => $(id).value.trim();
    const body = { chat: {}, embed: {}, features: {} };
    // 建库(全局 chat)：Key / 网址 / 模型
    const chatKey = val("setChatApiKey");
    const chatBaseUrl = val("setChatBaseUrl");
    const annotateModel = $("setAnnotateModel").value;
    if (chatKey) body.chat.apiKey = chatKey;
    if (chatBaseUrl) body.chat.baseUrl = chatBaseUrl;
    if (annotateModel) body.chat.model = annotateModel;
    // 向量：Key / 网址 / 模型
    const embedKey = val("setEmbedApiKey");
    const embedBaseUrl = val("setEmbedBaseUrl");
    const embedModel = $("setEmbedModel").value;
    if (embedKey) body.embed.apiKey = embedKey;
    if (embedBaseUrl) body.embed.baseUrl = embedBaseUrl;
    if (embedModel) body.embed.model = embedModel;
    // 写作(features.shot-writing.chat)：Key / 网址 / 模型 / 温度（独立 API）
    const shotApiKey = val("setShotApiKey");
    const shotBaseUrl = val("setShotBaseUrl");
    const shotModel = $("setShotModel").value;
    const temp = parseFloat($("setShotTemp").value);
    const shotChat = {};
    if (shotApiKey) shotChat.apiKey = shotApiKey;
    if (shotBaseUrl) shotChat.baseUrl = shotBaseUrl;
    if (shotModel) shotChat.model = shotModel;
    if (!Number.isNaN(temp)) shotChat.temperature = temp;
    if (Object.keys(shotChat).length) body.features["shot-writing"] = { chat: shotChat };
    await api("/api/config", { method: "PUT", body: JSON.stringify(body) });
    // 自动保存间隔
    const sel = $("setAutoSave");
    let min = sel.value === "custom" ? parseInt($("setAutoSaveCustom").value, 10) : Number(sel.value);
    if (!Number.isFinite(min) || min < 0) min = 5;
    localStorage.setItem("nw-autosave-min", String(min));
    applyAutoSaveSetting();
    toast(`✅ 设置已保存（自动保存 ${min > 0 ? min + " 分钟" : "关闭"}）`);
    loadConfig(); // 刷新顶栏模型选择器
    closeSettings();
  }

  /* ================= 打开文件夹 ================= */
  async function openFolder(dir) {
    try {
      await api("/api/system/open-folder", { method: "POST", body: JSON.stringify({ dir }) });
      toast(`已打开目录: ${dir}`);
    } catch (e) {
      toast(`打开失败: ${e.message}`);
    }
  }

  /* ================= 事件绑定 ================= */
  function bind() {
    $("btnAddChapter").onclick = addChapter;
    $("btnNewBook").onclick = newBook;
    $("btnAnnotateBook").onclick = annotateBook; // 对我的书建库标注
    $("bookSelect").onchange = onBookChange;
    // 顶栏「清空」= 清空编辑器（不落盘）；「保存」= 保存到 mybook 资产区
    $("btnNew").onclick = () => { if (vditor) vditor.setValue(""); };
    $("btnSave").onclick = () => saveChapter(false);
    // AI 写作（右栏：输入剧情需求 → 自动生成分镜 → 召回 → 成稿）
    $("btnGenerate").onclick = aiWrite;
    // 顶栏模型选择器
    $("modelSelect").onchange = onModelChange;
    // 成稿区"插入到写作栏"
    window.__insertDraft = insertDraftToEditor;
    // 导入参考书
    $("btnImportBook").onclick = importBook;
    $("bookFileInput").onchange = onBookFile;
    // 设置
    $("btnSettings").onclick = openSettings;
    $("btnSettingsClose").onclick = closeSettings;
    $("btnSettingsCancel").onclick = closeSettings;
    $("btnSettingsSave").onclick = saveSettings;
    $("settingsMask").onclick = (e) => { if (e.target === $("settingsMask")) closeSettings(); };
    // 主题切换
    document.querySelectorAll("#themeSwitch .ts-item").forEach((el) => {
      el.onclick = () => applyTheme(el.dataset.theme);
    });
    // 打开文件夹(设置面板内)
    document.querySelectorAll(".folder-btn").forEach((el) => {
      el.onclick = () => openFolder(el.dataset.dir);
    });
    // 自动保存设置：切到"自定义"时显示分钟输入框
    $("setAutoSave").onchange = () => {
      $("autoSaveCustomRow").style.display = $("setAutoSave").value === "custom" ? "flex" : "none";
    };
  }

  /* ================= 启动 ================= */
  async function init() {
    bind();
    // 主题初始化:本地记忆优先,默认浅色
    applyTheme(localStorage.getItem("nw-theme") || "light");
    initEditor();
    initSplitters(); // 三栏可拖宽 + 右栏内三块可拖高
    loadConfig();
    loadRefPool(); // 参考书池(跨书参考源选择)
    loadBooks();   // 我的书(mybook 资产区)
    applyAutoSaveSetting(); // 定时自动保存（设置间隔，默认 5 分钟）
    // WebUI 心跳：每 15s 上报存活；页面关闭后 server 60s 无心跳自动退出
    setInterval(() => {
      fetch("/api/system/heartbeat", { method: "POST" }).catch(() => {});
    }, 15000);
  }

  init();
})();
