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
    chapters: [],          // 大纲列表 [{num, title}]
    currentChapter: null,  // 当前章号
    sessionId: null,       // 当前写作会话
    shots: [],             // 当前分镜序列
    taskPolling: null,     // 轮询定时器
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

  /* ================= 自动保存(骨架:落 localStorage;mybook 落地后改 server) ================= */
  let saveTimer = null;
  function autoSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!state.currentChapter || !vditor) return;
      const text = vditor.getValue();
      localStorage.setItem(`nw-ch-${pad4(state.currentChapter)}`, text);
      taskStatus.textContent = "已自动保存";
    }, 800);
  }

  /* ================= 大纲 ================= */
  function renderOutline() {
    outlineList.innerHTML = "";
    if (!state.chapters.length) {
      outlineList.innerHTML = '<div class="placeholder">暂无章节<br>点击「+ 章」新建</div>';
      return;
    }
    for (const c of state.chapters) {
      const item = document.createElement("div");
      item.className = "outline-item" + (c.num === state.currentChapter ? " active" : "");
      item.innerHTML = `<span>${c.title || "未命名"}</span><span class="ch-num">${pad4(c.num)}</span>`;
      item.onclick = () => openChapter(c.num);
      outlineList.appendChild(item);
    }
  }

  function addChapter() {
    const num = state.chapters.length + 1;
    state.chapters.push({ num, title: `第${num}章` });
    renderOutline();
    openChapter(num);
  }

  function openChapter(num) {
    state.currentChapter = num;
    renderOutline();
    const saved = localStorage.getItem(`nw-ch-${pad4(num)}`) || "";
    if (vditor) vditor.setValue(saved);
    $("currentChapterTitle").textContent = `第${pad4(num)}章`;
  }

  /* ================= 配置状态 ================= */
  async function loadConfig() {
    try {
      const cfg = await api("/api/config");
      const m = cfg?.features?.["shot-writing"]?.chat?.model || cfg?.chat?.model || "--";
      $("modelBadge").textContent = `模型: ${m}`;
      const statusEl = $("envStatus");
      if (cfg?.chat?.apiKeySet) {
        statusEl.textContent = "LLM 就绪";
        statusEl.className = "env-status ok";
      } else {
        statusEl.textContent = "⚠ LLM 未配置(无 apiKey)";
        statusEl.className = "env-status warn";
      }
    } catch {
      $("envStatus").textContent = "服务未连接";
      $("envStatus").className = "env-status warn";
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

  /** ① 生成分镜序列(preprocess) */
  async function genShots() {
    const prompt = $("aiPrompt").value.trim();
    if (!prompt) { aiResult.innerHTML = '<div class="placeholder">请先输入剧情需求</div>'; return; }
    aiResult.innerHTML = '<div class="placeholder">正在生成分镜序列…</div>';
    try {
      const taskId = await startTask("preprocess", { input: prompt });
      pollTask(taskId, async (t) => {
        if (t.status !== "success") { aiResult.innerHTML = `<div class="placeholder">分镜生成失败</div>`; return; }
        // 从任务日志找 sessionId,或从最近会话取
        await refreshSessionFromTask(taskId);
      });
    } catch (e) {
      aiResult.innerHTML = `<div class="placeholder">错误: ${e.message}</div>`;
    }
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
    aiResult.insertAdjacentHTML("beforeend",
      `<div style="padding:8px 0"><button class="btn btn-accent btn-sm" onclick="window.__writeDraft()">② 生成正文(AI 写作)</button></div>`);
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /** ② 写作(recall + writedraft) */
  async function writeDraft() {
    if (!state.sessionId) { aiResult.insertAdjacentHTML("beforeend", '<div class="placeholder">先生成分镜序列</div>'); return; }
    aiResult.insertAdjacentHTML("beforeend", '<div class="placeholder">正在召回参考 + 写作…(任务日志见底部)</div>');
    const refBooks = selectedRefBooks(); // 勾选的参考书（空 = 全库跨书）
    taskStatus.textContent = refBooks.length ? `参考源: ${refBooks.join(" + ")}` : "参考源: 全库跨书";
    try {
      // 先 recall(装配参考, 限定所选参考书)
      const recallId = await startTask("recall", { session: state.sessionId, topk: 6, projects: refBooks });
      pollTask(recallId, async (t) => {
        if (t.status !== "success") { taskStatus.textContent = "recall 失败"; return; }
        // 再 writedraft(写作成稿)
        const draftId = await startTask("writedraft", { session: state.sessionId, projects: refBooks });
        pollTask(draftId, (dt) => {
          if (dt.status === "success") {
            taskStatus.textContent = "✅ 成稿完成";
            aiResult.insertAdjacentHTML("beforeend",
              `<div class="placeholder" style="color:var(--green)">✅ 成稿已生成(见任务日志/会话目录)</div>`);
          }
        });
      });
    } catch (e) {
      taskStatus.textContent = `写作失败: ${e.message}`;
    }
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

  /** 加载当前配置到表单(读 GET /api/config) */
  async function loadSettingsForm() {
    try {
      const cfg = await api("/api/config");
      $("setChatModel").value = cfg?.chat?.model || "";
      $("setFeatModel").value = cfg?.features?.["shot-writing"]?.chat?.model || "";
      $("setTemperature").value = cfg?.chat?.temperature ?? "";
      const chatKey = $("chatKeyStatus"), embedKey = $("embedKeyStatus");
      chatKey.textContent = cfg?.chat?.apiKeySet ? "✅ 已配置" : "⚠ 未配置";
      chatKey.className = "key-status " + (cfg?.chat?.apiKeySet ? "ok" : "no");
      embedKey.textContent = cfg?.embed?.apiKeySet ? "✅ 已配置" : "⚠ 未配置";
      embedKey.className = "key-status " + (cfg?.embed?.apiKeySet ? "ok" : "no");
    } catch (e) {
      taskStatus.textContent = `读取配置失败: ${e.message}`;
    }
  }

  /** 保存设置(PUT /api/config;模块作用域写 features) */
  async function saveSettings() {
    const body = { features: {}, chat: {} };
    const featModel = $("setFeatModel").value.trim();
    const chatModel = $("setChatModel").value.trim();
    const temp = parseFloat($("setTemperature").value);
    if (featModel) body.features["shot-writing"] = { chat: { model: featModel } };
    if (!isNaN(temp)) {
      body.chat.temperature = temp;
      body.features["shot-writing"] = body.features["shot-writing"] ?? {};
      body.features["shot-writing"].chat = { ...(body.features["shot-writing"].chat ?? {}), temperature: temp };
    }
    if (chatModel) body.chat.model = chatModel;
    await api("/api/config", { method: "PUT", body: JSON.stringify(body) });
    taskStatus.textContent = "✅ 设置已保存";
    loadConfig(); // 刷新顶栏模型徽标
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
    $("btnNew").onclick = () => { state.chapters = []; renderOutline(); if (vditor) vditor.setValue(""); };
    $("btnSave").onclick = () => { autoSave(); taskStatus.textContent = "已保存(本地)"; };
    $("btnGenerate").onclick = genShots;
    $("btnGenShots").onclick = genShots;
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
    // 顶栏打开文件夹按钮(快捷打开数据根)
    $("btnOpenFolder").onclick = () => openFolder("data");
    // 暴露给内联按钮
    window.__writeDraft = writeDraft;
  }

  /* ================= 启动 ================= */
  async function init() {
    bind();
    // 主题初始化:本地记忆优先,默认浅色
    applyTheme(localStorage.getItem("nw-theme") || "light");
    initEditor();
    loadConfig();
    loadRefPool(); // 参考书池(跨书参考源选择)
    // 骨架演示:默认加一章
    addChapter();
    taskStatus.textContent = "就绪";
  }

  init();
})();
