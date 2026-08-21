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
  const taskLog = $("taskLog");
  const taskStatus = $("taskStatus");

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
      if (!silent) taskStatus.textContent = "✅ 已保存到 mybook";
    } catch (e) {
      if (!silent) taskStatus.textContent = `保存失败: ${e.message}`;
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
      taskStatus.textContent = `✅ 已建书: ${name.trim()}`;
    } catch (e) {
      taskStatus.textContent = `建书失败: ${e.message}`;
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
    if (!state.currentBook) { taskStatus.textContent = "请先选择或新建一本书"; return; }
    try {
      const r = await api(`/api/books/${encodeURIComponent(state.currentBook)}/chapters`, { method: "POST", body: JSON.stringify({}) });
      taskStatus.textContent = `✅ 已新建第${r.num}章`;
      await loadBookDetail(state.currentBook); // 刷新列表（自动打开第一章；若已打开则保持）
      // 保持当前打开的章不变；新章通常是最新一章
      if (!state.currentChapter) openChapter(r.num);
    } catch (e) {
      taskStatus.textContent = `新建章节失败: ${e.message}`;
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
      taskStatus.textContent = `读取章节失败: ${e.message}`;
    }
  }

  /* ================= 配置状态 + 模型选择器（顶栏右侧） ================= */
  const PRESET_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"];

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
      // 模型选择器：预设 + 当前配置模型
      const current = cfg?.features?.["shot-writing"]?.chat?.model || cfg?.chat?.model || "";
      const sel = $("modelSelect");
      const opts = new Set([...PRESET_MODELS, ...(current ? [current] : [])]);
      sel.innerHTML = "";
      for (const m of opts) {
        const o = document.createElement("option");
        o.value = m;
        o.textContent = m;
        sel.appendChild(o);
      }
      if (current) sel.value = current;
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
      taskStatus.textContent = `✅ 写作模型: ${model}`;
    } catch (e) {
      taskStatus.textContent = `模型切换失败: ${e.message}`;
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
        const label = `${p.name}（${p.domain === "my" ? "我的" : "外部"}${p.meta?.chaptersAnnotated ? ` ${p.meta.chaptersAnnotated}章` : ""}）`;
        refPool.set(p.name, { checked: false, domain: p.domain });
        const item = document.createElement("label");
        item.className = "ref-pool-item";
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

  /* ================= AI 写作流程 ================= */
  async function startTask(kind, body) {
    const { taskId } = await api(`/api/tasks/${kind}`, { method: "POST", body: JSON.stringify(body) });
    return taskId;
  }

  function pollTask(taskId, onDone) {
    clearInterval(state.taskPolling);
    taskStatus.textContent = "任务运行中…";
    taskStatus.className = "taskbar-status running";
    state.taskPolling = setInterval(async () => {
      try {
        const t = await api(`/api/tasks/${taskId}`);
        const log = await api(`/api/tasks/${taskId}/log`);
        taskLog.textContent = (log.log || []).join("\n");
        if (t.status !== "running") {
          clearInterval(state.taskPolling);
          state.taskPolling = null;
          taskStatus.textContent = t.status === "success" ? "✅ 完成" : `❌ ${t.status}`;
          taskStatus.className = "taskbar-status " + (t.status === "success" ? "success" : "failed");
          onDone?.(t);
        }
      } catch { /* 轮询失败忽略,下轮重试 */ }
    }, 1500);
  }

  /** AI 写作全流程：输入剧情需求 → preprocess(分镜) → recall(召回) → writedraft(成稿) */
  async function aiWrite() {
    const prompt = $("aiPrompt").value.trim();
    if (!prompt) { aiResult.innerHTML = '<div class="placeholder">请先输入剧情需求</div>'; return; }
    if (state.busy) return;
    state.busy = true;
    aiResult.innerHTML = '<div class="placeholder">AI 生成中：正在生成分镜序列…</div>';
    try {
      const preId = await startTask("preprocess", { input: prompt });
      pollTask(preId, async (t) => {
        if (t.status !== "success") { aiResult.innerHTML = '<div class="placeholder">❌ 分镜生成失败（见任务日志）</div>'; state.busy = false; return; }
        await refreshSessionFromTask(preId); // 渲染分镜卡片到 aiResult
        if (!state.sessionId) { aiResult.innerHTML = '<div class="placeholder">会话 id 未找到（查看任务日志）</div>'; state.busy = false; return; }
        const refBooks = selectedRefBooks();
        taskStatus.textContent = refBooks.length ? `参考源: ${refBooks.join(" + ")}` : "参考源: 全库跨书";
        aiResult.insertAdjacentHTML("beforeend", '<div class="placeholder">AI 生成中：正在召回参考…</div>');
        const recallId = await startTask("recall", { session: state.sessionId, topk: 6, projects: refBooks });
        pollTask(recallId, async (t2) => {
          if (t2.status !== "success") { taskStatus.textContent = "recall 失败"; state.busy = false; return; }
          aiResult.insertAdjacentHTML("beforeend", '<div class="placeholder">AI 生成中：正在写作成稿…</div>');
          const draftId = await startTask("writedraft", { session: state.sessionId, projects: refBooks });
          pollTask(draftId, async (dt) => {
            state.busy = false;
            if (dt.status !== "success") { taskStatus.textContent = "写作失败"; aiResult.insertAdjacentHTML("beforeend", '<div class="placeholder">❌ 成稿失败（见任务日志）</div>'); return; }
            taskStatus.textContent = "✅ 成稿完成";
            await showDraftResult();
          });
        });
      });
    } catch (e) {
      state.busy = false;
      taskStatus.textContent = `AI 写作失败: ${e.message}`;
    }
  }

  /** 成稿完成后展示：分镜上方已渲染，此处追加成稿预览 */
  async function showDraftResult() {
    try {
      const s = await api(`/api/sessions/${state.sessionId}`);
      const draftEntry = Object.entries(s.drafts ?? {})[0];
      let html = '<div style="padding:10px 2px 4px;font-weight:600;font-size:13px">✅ 成稿预览</div>';
      if (draftEntry) {
        const text = draftEntry[1] || "";
        html += `<div class="shot-card" style="white-space:pre-wrap;line-height:1.7;font-size:13px">${escapeHtml(text.slice(0, 3000))}${text.length > 3000 ? "…" : ""}</div>`;
        html += `<div style="font-size:11px;color:var(--label-tertiary)">文件: ${escapeHtml(draftEntry[0])}（完整内容见该文件）</div>`;
      } else {
        html += '<div class="placeholder">成稿文件未找到</div>';
      }
      aiResult.insertAdjacentHTML("beforeend", html);
    } catch { /* 展示失败忽略 */ }
  }

  /** 从任务日志提取 sessionId 并加载分镜 */
  async function refreshSessionFromTask(taskId) {
    try {
      const log = await api(`/api/tasks/${taskId}/log`);
      const line = (log.log || []).find((l) => l.includes("sessions/"));
      const m = line?.match(/sessions\/([^/\s]+)/);
      if (m) {
        state.sessionId = m[1];
        await loadSession(state.sessionId);
      } else {
        aiResult.innerHTML = '<div class="placeholder">会话 id 未找到(查看任务日志)</div>';
      }
    } catch (e) {
      aiResult.innerHTML = `<div class="placeholder">加载会话失败: ${e.message}</div>`;
    }
  }

  /** 加载会话分镜并展示 */
  async function loadSession(sessionId) {
    const s = await api(`/api/sessions/${sessionId}`);
    state.shots = s.shots?.shots || [];
    renderShots(state.shots);
  }

  function renderShots(shots) {
    if (!shots.length) { aiResult.innerHTML = '<div class="placeholder">分镜序列为空</div>'; return; }
    aiResult.innerHTML = "";
    aiResult.insertAdjacentHTML("afterbegin", '<div style="padding:2px 0 8px;font-weight:600;font-size:13px">分镜序列（AI 自动生成）</div>');
    for (const s of shots) {
      const card = document.createElement("div");
      card.className = "shot-card";
      card.innerHTML = `
        <div class="shot-head">
          <span class="shot-tag">${s.type || "?"}</span>
          ${(s.funcs || []).map((f) => `<span class="shot-func">${f}</span>`).join("")}
          <span class="shot-label">${s.label || ""}</span>
        </div>
        <div class="shot-content">${escapeHtml(s.content || "")}</div>`;
      aiResult.appendChild(card);
    }
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
    const inputSec = $("aiInputSec"), refSec = $("aiRefSec");
    const spH1 = document.querySelector('.splitter-h[data-split="aiInput"]');
    const spH2 = document.querySelector('.splitter-h[data-split="aiRef"]');

    // 恢复记忆尺寸（右栏内行高同时做面板边界保护，防历史越界值残留）
    const savedL = Number(localStorage.getItem("nw-left-w"));
    const savedR = Number(localStorage.getItem("nw-right-w"));
    if (savedL > 0) left.style.width = Math.min(savedL, layoutW() * 0.6) + "px";
    if (savedR > 0) right.style.width = Math.min(savedR, layoutW() * 0.6) + "px";
    const savedH1 = Number(localStorage.getItem("nw-ai-input-h"));
    const savedH2 = Number(localStorage.getItem("nw-ai-ref-h"));
    const panel = document.getElementById("aiPanel");
    const panelH = panel.getBoundingClientRect().height || 600;
    if (savedH1 > 0) inputSec.style.height = Math.min(savedH1, panelH - 220) + "px";
    if (savedH2 > 0) refSec.style.height = Math.min(savedH2, panelH - 150) + "px";

    /** 列宽拖拽（左栏向右增宽 / 右栏向左增宽） */
    function dragCol(spEl, target, saveKey, isLeft) {
      spEl.addEventListener("mousedown", (e) => {
        e.preventDefault();
        spEl.classList.add("dragging");
        const startX = e.clientX;
        const startW = target.getBoundingClientRect().width;
        const move = (ev) => {
          const delta = ev.clientX - startX;
          const w = Math.max(140, Math.min(startW + (isLeft ? delta : -delta), layoutW() * 0.6));
          target.style.width = w + "px";
        };
        const up = () => {
          spEl.classList.remove("dragging");
          document.removeEventListener("mousemove", move);
          document.removeEventListener("mouseup", up);
          localStorage.setItem(saveKey, String(Math.round(target.getBoundingClientRect().width)));
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
      });
    }

    /** 行高拖拽（调整上块高度，下块自适应；限制在面板内，防拖穿边界） */
    function dragRow(spEl, target, saveKey) {
      spEl.addEventListener("mousedown", (e) => {
        e.preventDefault();
        spEl.classList.add("dragging");
        const startY = e.clientY;
        const startH = target.getBoundingClientRect().height;
        const panel = document.getElementById("aiPanel");
        const move = (ev) => {
          let h = startH + (ev.clientY - startY);
          // 上限：面板高度 − 其余区块最小占用（参考书区≈130 / 结果区 90 + 分隔条）
          const others = [...panel.querySelectorAll(".ai-sec")].filter((el) => el !== target);
          const minOthers = others.reduce((a, el) => a + (el.id === "aiResultSec" ? 90 : 130), 0);
          const splitH = panel.querySelectorAll(".splitter-h").length * 5;
          const maxH = panel.getBoundingClientRect().height - minOthers - splitH;
          h = Math.min(h, maxH);
          target.style.height = Math.max(60, h) + "px";
        };
        const up = () => {
          spEl.classList.remove("dragging");
          document.removeEventListener("mousemove", move);
          document.removeEventListener("mouseup", up);
          localStorage.setItem(saveKey, String(Math.round(target.getBoundingClientRect().height)));
        };
        document.addEventListener("mousemove", move);
        document.addEventListener("mouseup", up);
      });
    }

    dragCol(spLeft, left, "nw-left-w", true);
    dragCol(spRight, right, "nw-right-w", false);
    dragRow(spH1, inputSec, "nw-ai-input-h");
    dragRow(spH2, refSec, "nw-ai-ref-h");
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

  /** 加载当前配置到表单(读 GET /api/config) + 自动保存间隔(localStorage) */
  async function loadSettingsForm() {
    try {
      const cfg = await api("/api/config");
      $("setShotModel").value = cfg?.features?.["shot-writing"]?.chat?.model || cfg?.chat?.model || "";
      $("setShotTemp").value = cfg?.features?.["shot-writing"]?.chat?.temperature ?? cfg?.chat?.temperature ?? "";
    } catch (e) {
      taskStatus.textContent = `读取配置失败: ${e.message}`;
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

  /** 保存设置(PUT /api/config 写 features.shot-writing.chat) + 自动保存间隔(localStorage) */
  async function saveSettings() {
    const body = { features: {} };
    const model = $("setShotModel").value.trim();
    const temp = parseFloat($("setShotTemp").value);
    if (model || !Number.isNaN(temp)) {
      body.features["shot-writing"] = { chat: {} };
      if (model) body.features["shot-writing"].chat.model = model;
      if (!Number.isNaN(temp)) body.features["shot-writing"].chat.temperature = temp;
    }
    await api("/api/config", { method: "PUT", body: JSON.stringify(body) });
    // 自动保存间隔
    const sel = $("setAutoSave");
    let min = sel.value === "custom" ? parseInt($("setAutoSaveCustom").value, 10) : Number(sel.value);
    if (!Number.isFinite(min) || min < 0) min = 5;
    localStorage.setItem("nw-autosave-min", String(min));
    applyAutoSaveSetting();
    taskStatus.textContent = `✅ 设置已保存（自动保存 ${min > 0 ? min + " 分钟" : "关闭"}）`;
    loadConfig(); // 刷新顶栏模型选择器
    closeSettings();
  }

  /* ================= 打开文件夹 ================= */
  async function openFolder(dir) {
    try {
      await api("/api/system/open-folder", { method: "POST", body: JSON.stringify({ dir }) });
      taskStatus.textContent = `已打开目录: ${dir}`;
    } catch (e) {
      taskStatus.textContent = `打开失败: ${e.message}`;
    }
  }

  /* ================= 事件绑定 ================= */
  function bind() {
    $("btnAddChapter").onclick = addChapter;
    $("btnNewBook").onclick = newBook;
    $("bookSelect").onchange = onBookChange;
    // 顶栏「清空」= 清空编辑器（不落盘）；「保存」= 保存到 mybook 资产区
    $("btnNew").onclick = () => { if (vditor) vditor.setValue(""); };
    $("btnSave").onclick = () => saveChapter(false);
    // AI 写作（右栏：输入剧情需求 → 自动生成分镜 → 召回 → 成稿）
    $("btnGenerate").onclick = aiWrite;
    // 顶栏模型选择器
    $("modelSelect").onchange = onModelChange;
    $("taskbarToggle").onclick = () => document.getElementById("taskbar").classList.toggle("open");
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
    taskStatus.textContent = "就绪";
  }

  init();
})();
