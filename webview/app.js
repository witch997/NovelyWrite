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

  /* ================= 浮动任务栏（全局任务进度/报错） =================
   * 全局轮询 GET /api/tasks（1.5s）→ 每个 running 任务拉 /api/tasks/:id/log
   * 解析日志尾部启发式进度（annotate: 第X章完成/共N章；AI 链: 阶段行）
   * 完成→绿自动收起；失败→红驻留（手动关闭）；可最小化成标题条
   */
  const taskBar = {
    el: null, head: null, body: null, count: null, toggle: null,
    timer: null, minimized: false, dragging: null, // {startX, startY, origLeft, origTop, moved}
    cards: new Map(), // taskId → {el, name, status, logEl, barEl, doneAt, failed}
    done: [],         // 已结束任务快照（失败驻留）
    dismissed: new Set(), // 用户已关闭的历史失败卡（localStorage 持久化，刷新不复活）
    init() {
      this.el = $("taskBar");
      this.head = $("taskBarHead");
      this.body = $("taskBarBody");
      this.count = $("taskBarCount");
      this.toggle = $("taskBarToggle");
      if (!this.el) return;
      // 恢复已关闭的历史失败卡（localStorage；上次会话关闭的不再出现）
      try {
        const arr = JSON.parse(localStorage.getItem("nw-taskbar-dismissed") || "[]");
        if (Array.isArray(arr)) for (const id of arr) if (typeof id === "string") this.dismissed.add(id);
      } catch { /* 记录损坏忽略 */ }
      // 恢复上次拖动位置（localStorage）；无记录 → 保持 CSS 默认（右下角）
      try {
        const pos = JSON.parse(localStorage.getItem("nw-taskbar-pos") || "null");
        if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
          this.el.style.left = `${pos.left}px`;
          this.el.style.top = `${pos.top}px`;
          this.el.style.right = "auto";
          this.el.style.bottom = "auto";
        }
      } catch { /* 位置记录损坏忽略 */ }
      // 拖动：按住标题条拖动（最小化按钮除外）；松开时无位移=点击(最小化)，有位移=落位记忆
      this.head.addEventListener("mousedown", (e) => {
        if (e.target === this.toggle) return;
        const r = this.el.getBoundingClientRect();
        this.dragging = { startX: e.clientX, startY: e.clientY, origLeft: r.left, origTop: r.top, moved: false };
        e.preventDefault();
      });
      document.addEventListener("mousemove", (e) => {
        if (!this.dragging) return;
        const d = this.dragging;
        if (!d.moved && (Math.abs(e.clientX - d.startX) > 3 || Math.abs(e.clientY - d.startY) > 3)) d.moved = true;
        if (!d.moved) return;
        this.el.classList.add("dragging");
        const left = Math.max(4, Math.min(window.innerWidth - this.el.offsetWidth - 4, d.origLeft + (e.clientX - d.startX)));
        const top = Math.max(4, Math.min(window.innerHeight - this.el.offsetHeight - 4, d.origTop + (e.clientY - d.startY)));
        this.el.style.left = `${left}px`;
        this.el.style.top = `${top}px`;
        this.el.style.right = "auto";
        this.el.style.bottom = "auto";
      });
      document.addEventListener("mouseup", () => {
        if (!this.dragging) return;
        this.el.classList.remove("dragging");
        const wasMove = this.dragging.moved;
        this.dragging = null;
        if (wasMove) {
          // 拖动结束 → 记忆位置
          try {
            localStorage.setItem("nw-taskbar-pos", JSON.stringify({ left: parseFloat(this.el.style.left), top: parseFloat(this.el.style.top) }));
          } catch { /* ignore */ }
        } else {
          this.toggleMin(); // 无位移 → 视为点击标题条：最小化/展开
        }
      });
      this.toggle.onclick = (e) => { e.stopPropagation(); this.toggleMin(); };
      this.timer = setInterval(() => this.poll(), 1500);
      this.poll(); // 立即来一轮
    },
    toggleMin() {
      this.minimized = !this.minimized;
      this.el.classList.toggle("minimized", this.minimized);
      this.toggle.textContent = this.minimized ? "+" : "–";
    },
    /** 渲染任务名（优先 server 生成的 name；旧任务无 name 时按类型/参数回退拼） */
    labelOf(t) {
      if (t.name) return t.name; // server 注册表生成（TASK_KINDS.name）
      const map = {
        annotate: "📚 建库", aggregate: "🧩 聚合", fix: "🔧 修复",
        preprocess: "🎬 分镜", recall: "🔍 召回", writedraft: "✍️ 成稿",
      };
      const base = map[t.label] ?? t.label ?? "任务";
      const args = t.args ?? [];
      // annotate: --corpus=X；其他任务: 第一个非 -- 参数（项目名）
      const corpusArg = args.find((a) => a.startsWith("--corpus="));
      const arg = corpusArg
        ? corpusArg.slice("--corpus=".length)
        : args.find((a) => !a.startsWith("--")) ?? "";
      if (!arg) return base;
      // 书名本身可能带《》→ 不重复包裹；去书名号统一显示《X》
      const clean = arg.replace(/^《|》$/g, "");
      return `${base}《${clean}》`;
    },
    /** 旧任务（无 progress 字段）回退：无进度数据（启发式解析已移除——见 task/ISSUES.md P0-2） */
    progressFrom() { return null; },
    /** 从日志尾部取最近状态行（只扫尾部 SCAN 行——历史错误行不霸屏，恢复后立即显示新进度） */
    lastLogLine(log, scan = 8) {
      if (!log?.length) return { text: "", kind: "" };
      const tail = log.slice(-scan).reverse();
      const err = tail.find((l) => /失败|✗|❌|error|Error|异常|拒绝/i.test(l));
      if (err) return { text: err.slice(0, 120), kind: "error" };
      const warn = tail.find((l) => /⚠|缺|熔断|pending/i.test(l));
      if (warn) return { text: warn.slice(0, 120), kind: "warn" };
      return { text: log[log.length - 1].slice(0, 120), kind: "" };
    },
    /** 一轮全局轮询 */
    async poll() {
      try {
        const { tasks } = await api("/api/tasks");
        const active = tasks.filter((t) => t.status === "running" || t.status === "queued");
        const ids = new Set(tasks.map((t) => t.id));
        // 清理已从服务端消失的卡（非失败驻留的）
        for (const [id, card] of this.cards) {
          if (!ids.has(id) && !card.failed) this.removeCard(id);
        }
        for (const t of active) {
          this.ensureCard(t);
          this.updateRunning(t); // 刷新进度条 + 状态文字（不 await，独立请求）
        }
        for (const t of tasks.filter((x) => x.status !== "running" && x.status !== "queued")) {
          const card = this.cards.get(t.id);
          if (card && !card.failed && card.status !== t.status) await this.finishCard(t, card);
        }
        // 历史失败/被杀任务（页面刷新后可见，供一键重跑）：
        // 最近的 3 个建库失败/被杀任务自动建卡；先查 stale——使命已完成(缺章已补齐) → 显示✅后收起，不再红卡驻留
        const hist = tasks
          .filter((x) => (x.status === "failed" || x.status === "killed") && x.script === "novelread/host-exec.mjs")
          .slice(0, 3);
        for (const t of hist) {
          if (this.cards.has(t.id) || this.dismissed.has(t.id)) continue;
          let stale = false;
          try { const s = await api(`/api/tasks/${t.id}/stale`); stale = !!s.stale; } catch { /* 查不到按需重跑处理 */ }
          if (stale) { this.dismissTask(t.id); continue; } // 已补齐 → 静默收起（不打扰）
          this.ensureCard(t);
          const card = this.cards.get(t.id);
          if (card) await this.finishCard(t, card); // 立即转终态（红卡 + 重跑/关闭）
        }
        this.refreshCount();
        // 无任务且无失败驻留 → 自动隐藏
        const visible = this.cards.size > 0 || this.done.length > 0;
        this.el.classList.toggle("visible", visible);
      } catch { /* 轮询失败忽略（服务器可能重启中） */ }
    },
    ensureCard(t) {
      if (this.cards.has(t.id)) return;
      const el = document.createElement("div");
      el.className = "task-card " + (t.status === "queued" ? "queued" : "running");
      el.innerHTML = `
        <div class="task-card-head">
          <span class="task-card-name">${escapeHtml(this.labelOf(t))}</span>
          <span class="task-card-status running">${t.status === "queued" ? "⏳ 排队中" : "⏳ 进行中"}</span>
        </div>
        <div class="task-card-bar"><div class="task-card-bar-fill" style="width:5%"></div></div>
        <div class="task-card-log"></div>
        <div class="task-card-actions">
          <button class="btn btn-sm" data-act="kill" title="中止/取消任务">${t.status === "queued" ? "取消" : "停止"}</button>
        </div>`;
      this.body.appendChild(el);
      el.querySelector("[data-act=kill]").onclick = async () => {
        try { await api(`/api/tasks/${t.id}/kill`, { method: "POST" }); toast(t.status === "queued" ? `已取消排队: ${this.labelOf(t)}` : `已请求中止: ${this.labelOf(t)}`); }
        catch (e) { toast(`中止失败: ${e.message}`); }
      };
      this.cards.set(t.id, { el, name: this.labelOf(t), status: t.status === "queued" ? "queued" : "running", logEl: el.querySelector(".task-card-log"), barEl: el.querySelector(".task-card-bar-fill"), failed: false });
      this.el.classList.add("visible");
    },
    /** 更新运行中/排队卡片（进度条 + 状态文字）；进度读 server 结构化字段（progress/phase），不解析日志 */
    async updateRunning(t) {
      const card = this.cards.get(t.id);
      if (!card || (card.status !== "running" && card.status !== "queued")) return;
      try {
        const [detail, { log }] = await Promise.all([
          api(`/api/tasks/${t.id}`).catch(() => null),
          api(`/api/tasks/${t.id}/log`).catch(() => ({ log: [] })),
        ]);
        if (t.status === "queued" || detail?.status === "queued") {
          // 排队中：显示排队状态（进度条保持，状态文字说明）
          card.logEl.textContent = "⏳ 排队中（同类型任务进行中，自动等待）";
          card.logEl.className = "task-card-log";
          return;
        }
        // 进度：server progress 字段（done/total）；旧任务无字段则无进度条（不猜）
        const pr = detail?.progress;
        if (pr && pr.total) {
          card.barEl.style.width = `${Math.min(Math.round((pr.done ?? 0) / pr.total * 100), 99)}%`;
        }
        // 状态文字：优先 server phase（当前阶段描述）；其次日志尾部（含错误）
        const line = this.lastLogLine(log);
        let text = detail?.phase ?? line.text, kind = line.kind;
        if (pr?.total && detail?.phase) text += ` · ${pr.done ?? 0}/${pr.total}`;
        if (line.kind && detail?.phase) text += ` ⚠ ${line.text.slice(0, 36)}`; // 附最近错误/警告摘要
        if (text) {
          card.logEl.textContent = text;
          card.logEl.className = "task-card-log" + (kind ? ` ${kind}` : "");
        }
      } catch { /* 拉取失败忽略 */ }
    },
    /** 任务结束：成功→绿+短暂展示后收起；失败/被杀→红+驻留（stale 已补齐→绿+收起） */
    async finishCard(t, card) {
      const ok = t.status === "success";
      const killed = t.status === "killed";
      card.status = t.status;
      const partial = !ok && t.summary && t.summary.ok > 0 && t.summary.pending > 0; // 部分成功
      card.failed = !ok;
      card.el.classList.remove("running");
      card.el.classList.add(ok || partial ? "success" : "failed");
      const st = card.el.querySelector(".task-card-status");
      st.textContent = ok ? "✅ 完成" : killed ? "⏹ 已停止" : partial ? "⚠ 部分完成" : "❌ 失败";
      st.className = "task-card-status " + (ok || partial ? "success" : "failed");
      card.barEl.style.width = ok ? "100%" : "100%";
      const act = card.el.querySelector(".task-card-actions");
      if (act) act.remove();
      // 结束摘要：部分成功显示"X/Y 成功，缺章"；成功显示 summary.note（如有）
      if (t.summary) {
        const s = t.summary;
        if (partial) {
          card.logEl.textContent = `⚠ ${s.ok}/${s.ok + s.pending} 章成功，缺第${(s.failed ?? []).join("、")}章`;
          card.logEl.className = "task-card-log warn";
        } else if (ok && s.note) {
          card.logEl.textContent = s.note;
          card.logEl.className = "task-card-log";
        }
      }
      // 失败/被杀 → 显示结构化 error（优先）或日志错误行 + 驻留（可手动关闭 / 重跑）
      if (!ok) {
        // 先查 stale：该任务使命已完成（缺章已被其他任务补齐）→ 显示✅已补齐后自动收起，不红卡驻留
        if (t.script === "novelread/host-exec.mjs") {
          try {
            const s = await api(`/api/tasks/${t.id}/stale`);
            if (s.stale) {
              st.textContent = "✅ 已补齐";
              st.className = "task-card-status success";
              card.el.classList.remove("failed");
              card.el.classList.add("success");
              this.dismissTask(t.id);
              this.scheduleRefPoolRefresh(); // 缺章已补齐 → 参考书池缺章标记同步消失
              setTimeout(() => { if (this.cards.has(t.id)) this.removeCard(t.id); }, 2500);
              return;
            }
          } catch { /* 查不到按需重跑处理 */ }
        }
        if (t.error?.message && !partial) {
          // 结构化 error（server 维护）优先——不再从日志正则抠
          card.logEl.textContent = t.error.message.slice(0, 160);
          card.logEl.className = "task-card-log error";
        } else if (!t.error?.message) {
          (async () => {
            try {
              const { log } = await api(`/api/tasks/${t.id}/log`);
              const line = this.lastLogLine(log);
              if (line.text) { card.logEl.textContent = line.text; card.logEl.className = "task-card-log error"; }
            } catch { /* ignore */ }
          })();
        }
        this.done.push({ id: t.id, el: card.el });
        // 失败卡片提供 重跑（仅 annotate）+ 关闭
        const actRow = document.createElement("div");
        actRow.className = "task-card-actions";
        if (t.script === "novelread/host-exec.mjs") {
          const rerun = document.createElement("button");
          rerun.className = "btn btn-sm btn-primary";
          rerun.textContent = "🔄 重跑";
          rerun.title = "智能续跑：只补未标注/失败的章";
          rerun.onclick = async () => {
            try {
              const r = await api(`/api/tasks/${t.id}/rerun`, { method: "POST" });
              if (r.rerun) {
                toast(`🔄 已重跑《${this.name}》：${r.mode || "续跑"}`);
                // 旧卡收起 + 标记已处理（磁盘状态仍是 failed，防下轮 poll 重建）
                this.dismissTask(t.id);
                this.removeCard(t.id);
                this.done = this.done.filter((d) => d.id !== t.id);
              } else {
                toast(`无需重跑: ${r.reason || "无缺章"}`);
              }
            } catch (e) { toast(`重跑失败: ${e.message}`); }
          };
          actRow.appendChild(rerun);
        }
        const close = document.createElement("button");
        close.className = "btn btn-sm";
        close.textContent = "关闭";
        close.onclick = () => { this.dismissTask(t.id); this.removeCard(t.id); this.done = this.done.filter((d) => d.id !== t.id); };
        actRow.appendChild(close);
        card.el.appendChild(actRow);
      } else {
        // 成功 → 3.5s 后收起（若用户已关闭则跳过）
        setTimeout(() => { if (this.cards.has(t.id) && !card.failed) this.removeCard(t.id); }, 3500);
      }
      this.refreshCount();
      // 建库类任务结束（成功/失败/被杀都算）→ 刷新参考书池（缺章标记/pending 提示自动更新，无需手动刷新页面）
      if (t.script === "novelread/host-exec.mjs") this.scheduleRefPoolRefresh();
    },
    /** 任务结束 → 刷新参考书池（防抖：任务结束时集中触发一次，避免多任务同时结束重复拉取） */
    scheduleRefPoolRefresh() {
      clearTimeout(this._refPoolTimer);
      this._refPoolTimer = setTimeout(() => { try { loadRefPool(); } catch { /* 刷新失败忽略 */ } }, 800);
    },
    removeCard(id) {
      const card = this.cards.get(id);
      if (card) { card.el.remove(); this.cards.delete(id); }
      this.done = this.done.filter((d) => d.id !== id);
      const visible = this.cards.size > 0 || this.done.length > 0;
      this.el.classList.toggle("visible", visible);
      this.refreshCount();
    },
    /** 标记历史失败卡已处理（关闭/重跑）并持久化，刷新后不再自动出现 */
    dismissTask(id) {
      this.dismissed.add(id);
      try { localStorage.setItem("nw-taskbar-dismissed", JSON.stringify([...this.dismissed])); } catch { /* ignore */ }
    },
    refreshCount() {
      const running = [...this.cards.values()].filter((c) => c.status === "running").length;
      const failed = this.done.length;
      this.count.textContent = running ? `${running} 个进行中` : failed ? `${failed} 个失败` : "";
    },
  };

  /* ================= DOM 引用 ================= */
  const $ = (id) => document.getElementById(id);
  const outlineList = $("outlineList");
  const aiResult = $("aiResult");

  /* ================= 通用工具 ================= */
  // 安全 localStorage：浏览器跟踪防护/隐私模式可能阻止 storage 访问（抛 SecurityError），
  // 统一 try-catch 包裹，失败静默返回默认值，绝不中断应用初始化。
  function safeGet(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function safeSet(key, value) {
    try { localStorage.setItem(key, value); } catch { /* 存储不可用时忽略 */ }
  }
  function safeGetJSON(key, fallback) {
    try { const v = JSON.parse(safeGet(key) || "null"); return v === null || v === undefined ? fallback : v; } catch { return fallback; }
  }

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

  /**
   * 统计正文字数（剥掉 Markdown 语法再计数，避免 # / * / > / 链接等被计入）
   * @returns {number} 去空白后的正文字符数（含标点，与 server scanChapters 口径一致）
   */
  function countWords(val) {
    let t = val || "";
    // ① 代码块整段剔除（```...``` 内不算正文）
    t = t.replace(/```[\s\S]*?```/g, "");
    // ② 行内代码 `...` 剔除
    t = t.replace(/`[^`]*`/g, "");
    // ③ 图片/链接：![alt](url) / [text](url) → 保留 alt/text 文案
    t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    // ④ 标题/引用/列表/分隔线标记符剔除（保留文字内容）
    t = t.split("\n").map((l) => l.replace(/^\s*(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/, "")).join("\n");
    t = t.replace(/^\s*([-*_]){3,}\s*$/gm, ""); // 分隔线 --- / *** / ___
    // ⑤ 行内粗体/斜体/删除线标记符剔除（保留文字）
    t = t.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1")
         .replace(/__([^_]+)__/g, "$1").replace(/_([^_]+)_/g, "$1")
         .replace(/~~([^~]+)~~/g, "$1");
    // ⑥ 去空白计数（与 server 一致：含标点、不含空白）
    return t.replace(/\s/g, "").length;
  }

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
  /** 在光标处插入文本（Vditor insertValue，IR 模式正确保持焦点；引号/分隔符用） */
  function insertAtCursor(prefix, suffix = "") {
    if (!vditor) return;
    vditor.focus();
    vditor.insertValue(prefix + suffix);
    autoSave();
  }
  function initEditor() {
    vditor = new Vditor("vditor", {
      height: "100%",
      mode: "ir", // 即时渲染(所见即所得,写作友好)
      value: "",
      placeholder: "开始写作…(Markdown)",
      cache: { enable: false }, // 不依赖 localStorage 缓存
      toolbar: [
        {
          name: "font-minus",
          icon: '<svg viewBox="0 0 1024 1024" width="16" height="16"><path fill="currentColor" d="M192 448h640v128H192z"/></svg>',
          tip: "减小字号",
          click: () => adjustEditorFontSize(-1),
        },
        {
          name: "font-size",
          icon: `<span class="vditor-menu-fontsize" style="font-size:12px;font-weight:600;line-height:1;white-space:nowrap;">15</span>`,
          tip: "当前字号",
          click: () => {},
        },
        {
          name: "font-plus",
          icon: '<svg viewBox="0 0 1024 1024" width="16" height="16"><path fill="currentColor" d="M448 192h128v640H448zM192 448h640v128H192z"/></svg>',
          tip: "增大字号",
          click: () => adjustEditorFontSize(1),
        },
        "|",
        "bold", "italic", "|",
        "undo", "redo", "|",
        {
          name: "quote-dialog",
          icon: '<svg viewBox="0 0 1024 1024" width="18" height="18"><path fill="currentColor" d="M448 192v768L0 512V192h448zm576 0v768L576 512V192h448z"/></svg>',
          tip: "插入对话引号 “”",
          hotkey: "⌘⇧Q",
          click: () => insertAtCursor('“', '”'),
        },
        {
          name: "paragraph-break",
          icon: '<svg viewBox="0 0 1024 1024" width="18" height="18"><path fill="currentColor" d="M192 192h640v128H192V192zm0 256h640v128H192V448zm0 256h640v128H192V704z"/></svg>',
          tip: "插入段落分隔符（场景切换）",
          hotkey: "⌘⇧P",
          click: () => insertAtCursor('\n\n***\n\n'),
        },
        "|", "fullscreen",
      ],
      counter: { enable: true, type: "text" },
      input: (val) => {
        $("wordCount").textContent = `${countWords(val)} 字`;
        autoSave();
      },
      after: () => {
        $("wordCount").textContent = "0 字";
        applyEditorFontSize(); // 初始化后应用已保存的字号
      },
    });
  }

  /* ================= 写作台字号调节 ================= */
  const FONT_KEY = "nw-editor-fontsize";
  const FONT_MIN = 12, FONT_MAX = 24, FONT_DEFAULT = 15;
  /** 当前字号 */
  function getEditorFontSize() {
    const v = Number(safeGet(FONT_KEY) ?? FONT_DEFAULT);
    return Number.isFinite(v) ? Math.max(FONT_MIN, Math.min(FONT_MAX, v)) : FONT_DEFAULT;
  }
  /** 应用字号到 Vditor 编辑区（CSS 变量，所有模式生效）+ 更新工具栏字号显示 */
  function applyEditorFontSize() {
    const size = getEditorFontSize();
    const root = document.getElementById("vditor");
    if (!root) return;
    // Vditor 编辑区（ir 模式 .vditor-ir，sv 模式 .vditor-reset，wysiwyg .vditor-wysiwyg）
    root.querySelectorAll(".vditor-ir, .vditor-reset, .vditor-wysiwyg").forEach((el) => {
      el.style.fontSize = `${size}px`;
    });
    // 同步工具栏字号显示（.vditor-menu-fontsize 自定义项）
    const sizeSpan = root.querySelector(".vditor-menu-fontsize");
    if (sizeSpan) sizeSpan.textContent = `${size}`;
  }
  /** 字号 ±delta（clamp 到 [12,24]），存 localStorage 并应用 */
  function adjustEditorFontSize(delta) {
    const next = Math.max(FONT_MIN, Math.min(FONT_MAX, getEditorFontSize() + delta));
    safeSet(FONT_KEY, String(next));
    applyEditorFontSize();
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
      scheduleChapterRefresh(); // 保存后刷新左侧章节表（防抖合并，避免输入连发刷屏）
    } catch (e) {
      if (!silent) toast(`保存失败: ${e.message}`);
    }
  }

  let chapterRefreshTimer = null;
  /** 防抖刷新章节列表（500ms 合并；手动保存/章节切换后立即刷） */
  function scheduleChapterRefresh() {
    clearTimeout(chapterRefreshTimer);
    chapterRefreshTimer = setTimeout(() => refreshChapterList(), 500);
  }

  /** 轻量刷新章节列表（仅重拉列表 + 重绘大纲，保持当前章节与编辑器不动） */
  async function refreshChapterList() {
    if (!state.currentBook) return;
    try {
      const d = await api(`/api/books/${encodeURIComponent(state.currentBook)}`);
      state.chapters = d.chapters || [];
      renderOutline();
    } catch { /* 刷新失败忽略 */ }
  }

  /** 切换书/章节前强制保存当前编辑器内容（防未保存内容丢失）；无当前章则跳过 */
  async function flushSave() {
    if (!state.currentBook || !state.currentChapter || !vditor) return;
    clearTimeout(saveTimer); // 取消待触发的 autoSave（本处立即保存）
    try {
      await saveChapter(true);
    } catch { /* 保存失败不阻塞切换 */ }
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
    const v = Number(safeGet("nw-autosave-min") ?? "5");
    return Number.isFinite(v) && v >= 0 ? v : 5;
  }

  /* ================= 书（我的作品 mybook 资产区） ================= */
  /** 更新写作台书名显示（原 bookSelect 下拉 → 静态书名） */
  function updateBookName(name) {
    const el = $("currentBookName");
    if (el) el.textContent = name ? name : "（无书）";
  }

  async function loadBooks() {
    try {
      const d = await api("/api/books");
      state.books = d.books || [];
      if (!state.books.length) {
        state.currentBook = null;
        updateBookName("");
        renderOutline();
        return;
      }
      // 保持当前选择（或恢复上次打开的书；都没有则默认第一本）
      let lastBook = null;
      try { lastBook = JSON.parse(localStorage.getItem("nw-last-open") || "null")?.book ?? null; } catch { /* ignore */ }
      if (state.currentBook && state.books.some((b) => b.name === state.currentBook)) {
        // 保持
      } else if (lastBook && state.books.some((b) => b.name === lastBook)) {
        state.currentBook = lastBook;
      } else {
        state.currentBook = state.books[0].name;
      }
      updateBookName(state.currentBook);
      await loadBookDetail(state.currentBook);
    } catch (e) {
      $("outlineList").innerHTML = `<div class="placeholder">书加载失败: ${e.message}</div>`;
    }
  }

  /** 加载某书章节列表；若该书是「上次打开的书」，自动定位到上次章节 */
  async function loadBookDetail(name) {
    state.currentBook = name;
    state.currentChapter = null;
    const d = await api(`/api/books/${encodeURIComponent(name)}`);
    state.chapters = d.chapters || [];
    renderOutline();
    // 恢复上次打开的章节（同一本书时定位到上次章号；否则第一章）
    let target = state.chapters[0]?.num;
    try {
      const last = JSON.parse(localStorage.getItem("nw-last-open") || "null");
      if (last && last.book === name && state.chapters.some((c) => c.num === last.chapter)) {
        target = last.chapter;
      }
    } catch { /* 记录损坏忽略 */ }
    if (state.chapters.length) {
      openChapter(target ?? state.chapters[0].num);
    } else if (vditor) {
      vditor.setValue("");
      $("currentChapterTitle").textContent = `${name} · 未命名`;
    }
  }

  /** 新建书（输入书名 → POST /api/books → 刷新并选中） */
  async function newBook() {
    const name = await promptModal("新建书", { value: "", placeholder: "书名（仅中文/字母/数字等）" });
    if (!name) return;
    try {
      await api("/api/books", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
      await loadBooks();
      state.currentBook = name.trim();
      updateBookName(name.trim());
      await loadBookDetail(name.trim());
      openWorkspaceTab(name.trim()); // 拉写作工作台标签
      toast(`✅ 已建书: ${name.trim()}`);
    } catch (e) {
      toast(`建书失败: ${e.message}`);
    }
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

  /** 打开章节（读 mybook 内容 → 编辑器）；切换前强制保存当前章，记录「上次打开的书+章节」 */
  async function openChapter(num) {
    if (!state.currentBook) return;
    await flushSave(); // 切换章节前保存当前编辑器内容（防未保存丢失）
    state.currentChapter = num;
    renderOutline();
    try {
      safeSet("nw-last-open", JSON.stringify({ book: state.currentBook, chapter: num }));
    } catch { /* ignore */ }
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
      // LLM 就绪状态（功能区底部：设置上方）
      const statusEl = $("envStatus");
      if (cfg?.chat?.apiKeySet) {
        statusEl.textContent = "● LLM 已就绪";
        statusEl.className = "env-status env-status-nav ok";
      } else {
        statusEl.textContent = "● LLM 未就绪";
        statusEl.className = "env-status env-status-nav err";
      }
    } catch {
      $("envStatus").textContent = "● LLM 未就绪";
      $("envStatus").className = "env-status env-status-nav err";
    }
  }

  /** 模型切换 → 写入 config features.shot-writing.chat.model */
  /* 模型选择已并入设置面板（setShotModel），不再有顶栏快捷切换 */

  /* ================= 参考书池(跨书参考源选择,可多选) ================= */
  const refPool = new Map(); // name → {checked, domain}
  let refPoolAll = []; // 全部参考书（搜索/排序用）
  const PIN_KEY = "nw-refpool-pinned";
  /** 置顶书列表（localStorage 持久化） */
  function getPinned() {
    try { const v = JSON.parse(localStorage.getItem(PIN_KEY) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
  }
  function setPinned(arr) {
    try { localStorage.setItem(PIN_KEY, JSON.stringify(arr)); } catch { /* ignore */ }
  }
  /** 项目时间戳：目录 ctime/mtime（无后端改动；项目目录可能不存在→0） */
  function projectTime(p) {
    // 前端拿不到目录时间，用 meta.verifiedAt / 兜底 0（排序时放最后）
    return p.meta?.verifiedAt ? new Date(p.meta.verifiedAt).getTime() : 0;
  }
  /** 排序：置顶恒优先 → 域优先（【我的】在前）→ 所选维度（拼音/时间） */
  function sortRefPool(list, mode) {
    const pinned = new Set(getPinned());
    const arr = [...list];
    arr.sort((a, b) => {
      const pa = pinned.has(a.name) ? 1 : 0, pb = pinned.has(b.name) ? 1 : 0;
      if (pa !== pb) return pb - pa; // 置顶在前
      const da = a.domain === "my" ? 0 : 1, db = b.domain === "my" ? 0 : 1;
      if (da !== db) return da - db; // 【我的】域优先
      if (mode === "time-desc" || mode === "time-asc") {
        const ta = projectTime(a), tb = projectTime(b);
        if (ta !== tb) return mode === "time-desc" ? tb - ta : ta - tb;
      }
      return a.name.localeCompare(b.name, "zh"); // 拼音兜底
    });
    return arr;
  }
  async function loadRefPool() {
    try {
      const d = await api("/api/projects");
      refPoolAll = d.projects || [];
      renderRefPool();
    } catch {
      $("refPoolList").innerHTML = '<span class="muted">参考书加载失败</span>';
    }
  }
  /** 渲染参考书池（按搜索框关键字过滤 + 排序方式排序；勾选状态保留） */
  function renderRefPool() {
    const box = $("refPoolList");
    if (!refPoolAll.length) { box.innerHTML = '<span class="muted">无已建库项目(先 annotate 建库)</span>'; return; }
    const kw = ($("refPoolSearch")?.value ?? "").trim().toLowerCase();
    const mode = $("refPoolSort")?.value ?? "name";
    let list = kw ? refPoolAll.filter((p) => p.name.toLowerCase().includes(kw)) : refPoolAll;
    list = sortRefPool(list, mode);
    box.innerHTML = "";
    if (!list.length) { box.innerHTML = '<span class="muted">无匹配「' + escapeHtml(kw) + '」的参考书</span>'; return; }
    for (const p of list) {
      const pendN = (p.pending || []).length;
      const tag = p.domain === "my" ? "【我的】" : "【外部】";
      const label = `${tag}${p.name}${p.meta?.chaptersAnnotated ? `（${p.meta.chaptersAnnotated}章）` : ""}${pendN ? ` ⚠缺${pendN}章` : ""}`;
      if (!refPool.has(p.name)) refPool.set(p.name, { checked: false, domain: p.domain });
      const pinned = getPinned().includes(p.name);
      const item = document.createElement("label");
      item.className = "ref-pool-item" + (pendN ? " has-pending" : "");
      item.innerHTML = `<input type="checkbox" data-book="${escapeHtml(p.name)}"> <span>${escapeHtml(label)}</span>`;
      // 置顶按钮（📌 固定在行尾；点击 toggle 置顶，不影响 checkbox）
      const pinBtn = document.createElement("span");
      pinBtn.className = "ref-pin" + (pinned ? " pinned" : "");
      pinBtn.title = pinned ? "取消置顶" : "置顶此书";
      pinBtn.textContent = "📌";
      pinBtn.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        const cur = getPinned();
        const next = cur.includes(p.name) ? cur.filter((n) => n !== p.name) : [p.name, ...cur];
        setPinned(next);
        renderRefPool(); // 重新排序渲染
      });
      item.appendChild(pinBtn);
      const cb = item.querySelector("input");
      cb.checked = refPool.get(p.name)?.checked ?? false;
      cb.addEventListener("change", (e) => {
        const b = refPool.get(p.name);
        if (b) b.checked = e.target.checked;
      });
      box.appendChild(item);
    }
  }
  /** 收集勾选的参考书（数组；空 = 全库跨书） */
  function selectedRefBooks() {
    return [...refPool.entries()].filter(([, v]) => v.checked).map(([name]) => name);
  }

  /** 全选/全取消 切换：当前全部勾选 → 全取消；否则 → 全选（含未加载进 refPool 的） */
  function selectAllRefPool() {
    if (!refPoolAll.length) { toast("暂无参考书"); return; }
    // 确保全部书都有 refPool 条目
    for (const p of refPoolAll) {
      if (!refPool.has(p.name)) refPool.set(p.name, { checked: false, domain: p.domain });
    }
    const allChecked = refPoolAll.every((p) => refPool.get(p.name)?.checked);
    const next = !allChecked; // 全部已选 → 取消；否则 → 全选
    for (const p of refPoolAll) refPool.get(p.name).checked = next;
    renderRefPool();
    toast(next ? `✅ 已全选 ${refPoolAll.length} 本参考书` : "已全部取消选择");
  }

  /* ================= 导入参考书（选 txt → 选建库范围 → 自动建库） ================= */
  /* ================= 建库范围选择面板（导入参考书 / 建库标注 共用） ================= */
  /**
   * 弹出「建库范围」模态面板，返回 Promise：
   *   解析为 { pending:true }（补建缺章）
   *          或 { from:0 }（全量建库）
   *          或 { from:startCh, to:N }（续建到终点章）
   *   取消时 resolve(null)。
   * @param {{title:string, hint:string, startCh:number, defEnd:number}} opt
   */
  function openRangePanel({ title, hint, startCh, defEnd }) {
    return new Promise((resolve) => {
      $("rangeTitle").textContent = title;
      $("rangeHint").textContent = hint;
      const modeSel = $("rangeMode");
      const endRow = $("rangeEndRow");
      const endInput = $("rangeEnd");
      endInput.value = String(defEnd);
      endInput.min = String(startCh);
      // 方式切换：续建显示终点章输入；全量/补建隐藏
      const syncMode = () => {
        const m = modeSel.value;
        endRow.style.display = m === "continue" ? "flex" : "none";
        if (m === "continue") endInput.focus();
      };
      modeSel.onchange = syncMode;
      modeSel.value = "continue";
      syncMode();
      $("rangeMask").classList.add("open");
      // 回车确认
      const onKey = (e) => { if (e.key === "Enter") confirm(); };
      endInput.onkeydown = onKey;
      const cleanup = () => {
        $("rangeMask").classList.remove("open");
        $("btnRangeOk").onclick = null;
        $("btnRangeCancel").onclick = null;
        $("btnRangeClose").onclick = null;
        endInput.onkeydown = null;
        modeSel.onchange = null;
      };
      const confirm = () => {
        const m = modeSel.value;
        let result = null;
        if (m === "pending") result = { pending: true };
        else if (m === "full") result = { from: 0 };
        else {
          const end = parseInt(endInput.value, 10);
          if (!Number.isFinite(end) || end < startCh) { toast(`终点章号需 ≥ ${startCh}`); return; }
          result = { from: startCh, to: end };
        }
        cleanup();
        resolve(result);
      };
      $("btnRangeOk").onclick = confirm;
      $("btnRangeCancel").onclick = () => { cleanup(); resolve(null); };
      $("btnRangeClose").onclick = () => { cleanup(); resolve(null); };
      // 点遮罩空白关闭
      $("rangeMask").onclick = (e) => { if (e.target === $("rangeMask")) { cleanup(); resolve(null); } };
    });
  }

  /** 通用单行输入面板（替代原生 prompt）。resolve(字符串) 或 resolve(null)（取消/空）。 */
  function promptModal(title, { value = "", placeholder = "", select = false } = {}) {
    return new Promise((resolve) => {
      $("inputTitle").textContent = title;
      const field = $("inputField");
      field.value = value;
      field.placeholder = placeholder;
      field.onkeydown = (e) => { if (e.key === "Enter") confirm(); };
      $("inputMask").classList.add("open");
      const cleanup = () => {
        $("inputMask").classList.remove("open");
        field.onkeydown = null;
        $("btnInputOk").onclick = null;
        $("btnInputCancel").onclick = null;
        $("btnInputClose").onclick = null;
      };
      const confirm = () => { const v = field.value.trim(); cleanup(); resolve(v || null); };
      $("btnInputOk").onclick = confirm;
      $("btnInputCancel").onclick = () => { cleanup(); resolve(null); };
      $("btnInputClose").onclick = () => { cleanup(); resolve(null); };
      $("inputMask").onclick = (e) => { if (e.target === $("inputMask")) { cleanup(); resolve(null); } };
      setTimeout(() => { field.focus(); field.select(); }, 0);
    });
  }

  /** 公共导入建库流程：查进度 → 弹范围面板 → POST /api/tasks/import-book
   *  @param {string} filename 语料文件名（如 大王饶命-语料.txt）→ 推导书名
   *  @param {string} contentB64 原始字节 base64（外传；空 = 服务器走 mybook 原稿路径）
   */
  async function importBookFlow(filename, contentB64) {
    const base = filename.replace(/\.txt$/i, "").replace(/-语料$/, "").trim();
    const isMy = !contentB64; // 无字节 → mybook 原稿路径（我的书）
    // 查已建库进度（同名项目已标注章数 = 续建起点）
    let lastCh = 0;
    try {
      const d = await api("/api/projects");
      lastCh = (d.projects || []).find((p) => p.name === base && (!isMy || p.domain === "my"))?.meta?.chaptersAnnotated || 0;
    } catch { /* 查不到按 0 */ }
    const startCh = lastCh + 1; // 续建从最新章节的下一章开始
    const defEnd = startCh + 29; // 默认一次续建 30 章（推荐单批上限）
    const hint = lastCh > 0 ? `已建库至第 ${lastCh} 章，将从第 ${startCh} 章续建` : "尚未建库，将从第 1 章开始";
    const range = await openRangePanel({ title: isMy ? `对《${base}》建库标注` : `导入《${base}》`, hint, startCh, defEnd });
    if (!range) return; // 取消
    const body = isMy ? { name: base, domain: "my" } : { filename, contentB64 };
    if (range.pending) body.pending = true;            // 补建指令
    else if (range.from === 0) body.from = 0;          // 全量（服务器端转 --all）
    else { body.from = range.from; body.to = range.to; } // 续建到终点章
    toast(isMy ? `正在对《${base}》合成语料并建库…` : `正在导入《${base}》并生成章节清单…`);
    try {
      const r = await api("/api/tasks/import-book", { method: "POST", body: JSON.stringify(body) });
      const modeDesc = body.pending ? "补建缺章" : body.to ? `续建第${body.from}~${body.to}章` : r.mode;
      // 变更检测结果（原稿变更 → 重标/剔除/新增）透传提示
      const ch = r.change;
      let changeNote = "";
      if (ch) {
        const parts = [];
        if (ch.changed?.length) parts.push(`重标第${ch.changed.join(",")}章`);
        if (ch.deleted?.length) parts.push(`剔除第${ch.deleted.join(",")}章`);
        if (ch.newChs?.length) parts.push(`新增第${ch.newChs.join(",")}章`);
        changeNote = parts.length ? `（检测到原稿变更：${parts.join("、")}）` : "";
      }
      toast(`✅ 已开始建库《${r.name}》（${modeDesc}）${r.encoding ? `｜${r.encoding}` : ""}${changeNote}`);
      await loadRefPool(); // 刷新参考书池
    } catch (err) {
      toast(isMy ? `建库失败: ${err.message}` : `导入失败: ${err.message}`);
    }
  }

  /** 文件选择 → 导入参考书（外传语料 txt，读原始字节 base64） */
  async function onBookFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    // 读原始字节（base64）而非 file.text()：file.text() 强制按 UTF-8 解码，
    // GBK/GB2312 语料会当场损坏成 �（不可逆）。原始字节交由服务端检测编码并转换。
    let contentB64 = "";
    try {
      const ab = await file.arrayBuffer();
      const bytes = new Uint8Array(ab);
      const CHUNK = 0x8000;
      let bin = "";
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      contentB64 = btoa(bin);
    } catch (err) {
      toast(`读取文件失败: ${err.message}`);
      return;
    }
    await importBookFlow(file.name, contentB64);
  }

  /** 右栏「外部书」建库标注：自动选 corpus 区的对应语料文件（等价于 bookFileInput 选了它） */
  async function annotateExBook(book) {
    const fname = `${book}-语料.txt`;
    try {
      // 从 server 取 corpus 语料原始字节（以字节方式避免文本解码损耗）
      const res = await fetch(`/api/corpus/${encodeURIComponent(fname)}`);
      if (!res.ok) { toast(`未找到 corpus 语料文件：${fname}（${res.status}）`); return; }
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      const CHUNK = 0x8000;
      let bin = "";
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      const contentB64 = btoa(bin);
      await importBookFlow(fname, contentB64);
    } catch (err) {
      toast(`读取语料失败: ${err.message}`);
    }
  }

  /** 左栏「我的书」建库标注（mybook 原稿路径） */
  async function annotateMyBook(name) {
    await importBookFlow(name, ""); // 空字节 → my 域（server 从 mybook 原稿合成语料）
  }

  /** 「导入参考书语料」：选语料 txt → 复制到 corpus + 生成章节清单 + 建 exproject 文件夹（不启动标注）→ 刷新条目 */
  async function importRefOnly() {
    const inp = $("bookFileInput");
    const file = inp?.files?.[0] ?? null;
    if (!file) return;
    // 恢复默认绑定（标注流程），避免污染其他入口
    inp.onchange = onBookFile;
    // 读原始字节（base64），交由服务端编码检测转换
    let contentB64 = "";
    try {
      const ab = await file.arrayBuffer();
      const bytes = new Uint8Array(ab);
      const CHUNK = 0x8000;
      let bin = "";
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      contentB64 = btoa(bin);
    } catch (err) {
      toast(`读取文件失败: ${err.message}`);
      return;
    }
    toast(`正在导入《${file.name.replace(/\.txt$/i, "").replace(/-语料$/, "")}》…`);
    try {
      const r = await api("/api/tasks/import-book", {
        method: "POST",
        body: JSON.stringify({ filename: file.name, contentB64, annotate: false }),
      });
      toast(`✅ 已导入《${r.name}》（语料 + 章节清单 + exproject 文件夹）${r.encoding ? `｜${r.encoding}` : ""}`);
      await renderHomeDismantle(); // 刷新条目（右栏出现该书）
    } catch (err) {
      toast(`导入失败: ${err.message}`);
    }
  }

  /* ================= 拆书：生成拆书地图（读 store 已建库数据 → 新窗口展示） ================= */
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
      renderDraft(d);
    } catch (e) {
      setAiStatus(`读取成稿失败: ${e.message}`);
    }
  }

  /** 渲染成稿到 AI 成稿区（供 showFinalDraft / loadLatestDraft 共用）；插入按钮固定在栏头 */
  function renderDraft(d) {
    aiResult.innerHTML = `
      <div class="draft-title">
        <span>📄 ${escapeHtml(d.file)}</span>
      </div>
      <div class="draft-text">${escapeHtml(d.content)}</div>`;
    const wrap = document.getElementById("paneDraft");
    if (wrap) wrap.scrollTop = 0;
  }

  /** 清空 AI 成稿栏（恢复占位，清除当前 session 引用） */
  function clearDraft() {
    state.sessionId = null;
    aiResult.innerHTML = `<div class="placeholder">AI 成稿将显示在这里</div>`;
    toast("已清空成稿栏");
  }

  /** 加载最近一次成稿到工作台（页面刷新后自动显示最近产出；无成稿则忽略） */
  async function loadLatestDraft() {
    try {
      const s = await api("/api/sessions");
      if (!s.sessions?.length) return;
      // 从最新会话往下找第一个有 final 的
      for (const ss of s.sessions) {
        try {
          const d = await api(`/api/sessions/${encodeURIComponent(ss.id)}/final`);
          if (d.ok) { state.sessionId = ss.id; renderDraft(d); return; }
        } catch { /* 该会话无成稿，继续找下一个 */ }
      }
    } catch { /* 静默：无成稿时保持占位 */ }
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
    const left = $("paneLeft"), editorEl = $("paneEditor"), draftPane = $("paneDraft"), right = $("paneRight");
    const spLeft = document.querySelector('.splitter-v[data-split="left"]');
    const spDraft = document.querySelector('.splitter-v[data-split="draft"]');
    const spRight = document.querySelector('.splitter-v[data-split="right"]');
    const panel = document.getElementById("aiPanel");
    const inputSec = $("aiInputSec"), refSec = $("aiRefSec");
    const spH1 = document.querySelector('.splitter-h[data-split="aiInput"]');

    // 恢复记忆尺寸（列宽）——受各栏最小宽度约束
    const EDITOR_MIN = 400, DRAFT_MIN = 200, COL_MIN = 140, SPLITV = 5; // 编辑器/成稿/外侧栏最小宽 + 竖分隔条宽
    const MIN_INNER = EDITOR_MIN + DRAFT_MIN + SPLITV; // 中栏最小宽（编辑器+成稿+spD）
    const centerEl = document.getElementById("paneCenter");

    const wLeft = () => left.getBoundingClientRect().width;
    const wRight = () => right.getBoundingClientRect().width;
    const wEditor = () => editorEl.getBoundingClientRect().width;
    const wDraft = () => draftPane.getBoundingClientRect().width;
    const wCenter = () => centerEl.getBoundingClientRect().width;
    const centerW = () => wCenter(); // 中栏实际宽（JS 管理）

    /** 应用中栏内部两栏宽度：按当前比例分配，触底策略 A（先触底一栏锁定最小，剩余给另一栏） */
    /** 基于快照的纯计算（不读实时 DOM 宽，杜绝读写反馈循环——WebView2 下 getBoundingClientRect+写宽会指数放大）
     *  snap = {L,C,R,E,D} 为按下瞬间快照；返回 {L,C,R,E,D} 目标宽（已 clamp），由调用方一次性写回。 */

    /** 左栏拖动：只改左栏宽（clamp 到布局剩余 - 中栏最小 - 右栏），中栏 flex:1 自动吸收 */
    function calcLeft(snap, w) {
      const newL = Math.max(COL_MIN, Math.min(w, layoutW() - SPLITV * 2 - MIN_INNER - snap.R));
      return { L: newL };
    }
    /** 右栏拖动：只改右栏宽（clamp 到布局剩余 - 中栏最小 - 左栏），中栏 flex:1 自动吸收 */
    function calcRight(snap, w) {
      const newR = Math.max(COL_MIN, Math.min(w, layoutW() - SPLITV * 2 - MIN_INNER - snap.L));
      return { R: newR };
    }
    /** 成稿栏拖动：只调编辑器↔成稿栏，中栏总宽不变 */
    function calcDraft(snap, w) {
      const avail = snap.C - SPLITV;
      const newD = Math.max(DRAFT_MIN, Math.min(w, avail - EDITOR_MIN));
      return { D: newD, E: avail - newD };
    }
    /** 中栏内部按比例分配（触底策略 A）：基于 center 实际宽（flex 决定），分配 editor/draft */
    function calcInner(snap) {
      const cw = wCenter();
      if (cw < MIN_INNER) return null; // 中栏不可见/过小（页面隐藏时 wCenter=0）→ 跳过，避免设出负宽/异常
      const avail = cw - SPLITV;
      const total = Math.max(1, snap.E + snap.D);
      let ed = avail * (snap.E / total);
      ed = Math.max(EDITOR_MIN, Math.min(ed, avail - DRAFT_MIN));
      return { E: ed, D: avail - ed };
    }
    /** 写回 DOM（一次性）；不设 center 宽——center 由 flex:1 自动铺满剩余 */
    function writeLayout(w) {
      if (!w) return;
      if (w.L !== undefined) left.style.width = Math.round(w.L) + "px";
      if (w.R !== undefined) right.style.width = Math.round(w.R) + "px";
      if (w.E !== undefined) editorEl.style.width = Math.round(w.E) + "px";
      if (w.D !== undefined) draftPane.style.width = Math.round(w.D) + "px";
    }

    // 初始化：左 230 / 右 350（中栏 flex:1 自动铺满剩余 → 默认天然铺满整个布局）
    const layoutInit = () => {
      left.style.width = "230px";
      right.style.width = "350px";
    };
    /** 窗口尺寸变化/切到写作台：中栏 flex 自动铺满，只需重新分配中栏内部 editor/draft */
    function relayout() {
      if (window.__splitting) return;
      writeLayout(calcInner({ E: wEditor(), D: wDraft() }));
    }
    window.__relayout = relayout; // 供 switchTab 切到写作台（可见）时调用
    layoutInit();
    // 每次打开按比例重新分配（不恢复记忆，清除脏键）
    ["nw-left-w", "nw-draft-w", "nw-right-w"].forEach((k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } });
    // 仅在可见时分配内部（当前 pageWorkspace 临时显示，wCenter 有效）
    if (wCenter() >= MIN_INNER) writeLayout(calcInner({ E: wEditor(), D: wDraft() }));

    /* ---------- AI 参考栏：两块 + 一条拖拽条 绝对定位统一排布 ---------- */
    let inputH = Math.max(110, Number(safeGet("nw-ai-input-h")) || 160);
    const SPLIT = 5; // 单条拖拽条高

    function layoutAiPanel() {
      const panelH = panel.getBoundingClientRect().height;
      if (!panelH) return;
      // 输入区
      inputSec.style.top = "0px";
      inputSec.style.height = inputH + "px";
      // 拖拽条
      spH1.style.top = inputH + "px";
      // 参考书区（贴底占剩余）
      refSec.style.top = inputH + SPLIT + "px";
      refSec.style.height = Math.max(60, panelH - inputH - SPLIT) + "px";
    }
    // 工作台从首页切换到显隐 / 窗口尺寸变化时，pane-body 高度会从 0 变化。
    // 首次 layoutAiPanel 若在高度为 0 时调用会提前 return，导致参考书区未排布；
    // 用 ResizeObserver 监听 #aiPanel 实际尺寸，一变就重排，参考书池总能正确显示。
    if (typeof ResizeObserver !== "undefined") {
      new ResizeObserver(() => layoutAiPanel()).observe(panel);
    }
    window.addEventListener("resize", () => { layoutAiPanel(); relayout(); });
    layoutAiPanel();

    /** 通用竖条拖拽——快照事务模式：
     *  pointerdown 捕获全部栏宽快照；move 只用「快照 + 位移」纯计算目标宽，一次性写回。
     *  全程不读实时 getBoundingClientRect —— 杜绝 WebView2 下「读宽→写宽」自反馈指数放大。
     *  双事件兜底：pointer + mouse up 任一先到即结束；不用 setPointerCapture（坐标系统一）。 */
    function dragBar(spEl, kind) {
      let move = null, up = null, noDrag = null;
      const clear = () => {
        if (move) { document.removeEventListener("pointermove", move); document.removeEventListener("mousemove", move); move = null; }
        if (up) { document.removeEventListener("pointerup", up); document.removeEventListener("mouseup", up); document.removeEventListener("pointercancel", up); document.removeEventListener("mouseleave", up); up = null; }
        if (noDrag) { document.removeEventListener("selectstart", noDrag); document.removeEventListener("dragstart", noDrag); noDrag = null; }
      };
      spEl.addEventListener("pointerdown", (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        e.preventDefault();
        clear();
        window.__splitting = true;
        spEl.classList.add("dragging");
        const startX = e.clientX;
        // 按下瞬间快照（唯一读一次实时宽）
        const snap = { L: wLeft(), C: wCenter(), R: wRight(), E: wEditor(), D: wDraft() };
        let acc = 0, lastX = startX;
        move = (ev) => {
          acc += ev.clientX - lastX;
          lastX = ev.clientX;
          // 纯计算（快照 + 位移）；center 是 flex:1 自动铺满，不需 JS 设宽
          if (kind === "left") {
            const w = calcLeft(snap, snap.L + acc);
            writeLayout({ ...w, ...calcInner(snap) });
          } else if (kind === "right") {
            const w = calcRight(snap, snap.R - acc);
            writeLayout({ ...w, ...calcInner(snap) });
          } else { // draft
            const w = calcDraft(snap, snap.D - acc);
            writeLayout(w);
          }
          // 总宽保险：左/右栏总和不得超过布局可用宽（中栏 flex 自动，防御性）
          const avail = layoutW() - SPLITV * 2;
          const totalLR = wLeft() + wRight();
          if (totalLR > avail - MIN_INNER + 1) {
            const over = totalLR - (avail - MIN_INNER);
            const k = (totalLR - over) / totalLR;
            left.style.width = Math.max(COL_MIN, Math.round(wLeft() * k)) + "px";
            right.style.width = Math.max(COL_MIN, Math.round(wRight() * k)) + "px";
            writeLayout(calcInner(snap));
          }
        };
        up = () => {
          window.__splitting = false;
          spEl.classList.remove("dragging");
          clear();
        };
        noDrag = (ev) => ev.preventDefault();
        document.addEventListener("selectstart", noDrag);
        document.addEventListener("dragstart", noDrag);
        document.addEventListener("pointermove", move);
        document.addEventListener("mousemove", move);
        document.addEventListener("pointerup", up);
        document.addEventListener("mouseup", up);
        document.addEventListener("pointercancel", up);
        document.addEventListener("mouseleave", up);
      });
    }

    // 三根竖条（标准语义：拖向哪边，移动方向侧的栏变窄、对侧变宽）
    dragBar(spLeft, "left");   // 向左拖→左栏变窄（中栏变宽）；向右拖→左栏变宽（中栏变窄）
    dragBar(spDraft, "draft"); // 向左拖→成稿栏变宽；向右拖→成稿栏变窄（中栏不变）
    dragBar(spRight, "right"); // 向左拖→AI参考栏变宽；向右拖→AI参考栏变窄（中栏变宽）

    /** 行高拖拽：改 JS 变量 inputH（带 clamp），layoutAiPanel 重排全部区块。
     *  pointer events + setPointerCapture：鼠标移出窗口不丢事件，杜绝卡死。 */
    function dragRow(spEl, saveKey, minH) {
      spEl.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        spEl.setPointerCapture?.(e.pointerId);
        spEl.classList.add("dragging");
        const startY = e.clientY;
        const startH = inputH;
        const move = (ev) => {
          const panelH = panel.getBoundingClientRect().height;
          // 目标块上限 = 面板 − 参考书区最小(60) − 一条拖拽条
          const maxH = panelH - 60 - SPLIT;
          inputH = Math.max(minH, Math.min(startH + (ev.clientY - startY), maxH));
          layoutAiPanel();
        };
        const up = (ev) => {
          spEl.classList.remove("dragging");
          spEl.releasePointerCapture?.(ev.pointerId);
          document.removeEventListener("pointermove", move);
          document.removeEventListener("pointerup", up);
          document.removeEventListener("pointercancel", up);
          safeSet(saveKey, String(Math.round(inputH)));
        };
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", up);
        document.addEventListener("pointercancel", up);
      });
    }

    dragRow(spH1, "nw-ai-input-h", 110); // 输入区：需容纳按钮+输入框（右栏仅一条拖拽条）
    window.addEventListener("resize", () => { layoutAiPanel(); relayout(); });
  }

  /* ================= 主题切换 ================= */
  function applyTheme(theme) {
    document.body.dataset.theme = theme;
    safeSet("nw-theme", theme);
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
      const dec = cfg?.features?.["shot-writing"]?.chat?.decode;
      $("setShotDecode").value = dec ? JSON.stringify(dec, null, 2) : "";
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
    // 解码配方（JSON 文本域）：解析失败则中断保存并提示
    const decodeText = $("setShotDecode").value.trim();
    if (decodeText) {
      try {
        const dec = JSON.parse(decodeText);
        if (!dec || typeof dec !== "object" || Array.isArray(dec)) throw new Error("须为 JSON 对象");
        shotChat.decode = dec;
      } catch (e) {
        toast(`❌ 解码配方不是合法 JSON：${e.message}`);
        return;
      }
    }
    if (Object.keys(shotChat).length) body.features["shot-writing"] = { chat: shotChat };
    await api("/api/config", { method: "PUT", body: JSON.stringify(body) });
    // 自动保存间隔
    const sel = $("setAutoSave");
    let min = sel.value === "custom" ? parseInt($("setAutoSaveCustom").value, 10) : Number(sel.value);
    if (!Number.isFinite(min) || min < 0) min = 5;
    safeSet("nw-autosave-min", String(min));
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
    // 顶栏「清空」= 清空编辑器（不落盘）；「保存」= 保存到 mybook 资产区
    $("btnNew").onclick = () => { if (vditor) vditor.setValue(""); };
    $("btnSave").onclick = () => saveChapter(false);
    // AI 写作（右栏：输入剧情需求 → 自动生成分镜 → 召回 → 成稿）
    $("btnGenerate").onclick = aiWrite;
    // 成稿区"插入到写作栏"（固定按钮在成稿栏头 + 兼容旧内嵌调用）
    $("btnInsertDraft").onclick = insertDraftToEditor;
    $("btnClearDraft").onclick = clearDraft;
    window.__insertDraft = insertDraftToEditor;
    $("bookFileInput").onchange = onBookFile;
    // 参考书搜索（点击/回车才过滤）+ 排序 + 全选
    const searchInput = $("refPoolSearch");
    const doSearch = () => renderRefPool();
    $("btnSearchPool").onclick = doSearch;
    searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
    $("refPoolSort").onchange = renderRefPool;
    $("btnSelectAll").onclick = selectAllRefPool;
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

  /* ================= 多标签工作台 + 首页 =================
   * 标签：首页（固定，不可关） / 写作工作台（每书一标签，共享四栏 DOM，切换时重载该书）
   *       / 拆书（每书一 iframe 容器，独立保留状态）
   * 首页：左导航（小说作品/拆书/知识库）+ 右内容区
   */
  const tabState = {
    list: new Map(), // id → {id, kind: "workspace"|"dismantle", title, book}
    active: "home",
  };
  const dismantlePages = new Map(); // tabId → iframe 容器 div

  /** 渲染标签栏动态区 */
  function renderTabbar() {
    const box = $("tabbarDynamic");
    box.innerHTML = "";
    for (const t of tabState.list.values()) {
      const el = document.createElement("div");
      el.className = "tab" + (tabState.active === t.id ? " tab-active" : "");
      el.dataset.tab = t.id;
      const title = document.createElement("span");
      title.textContent = t.title;
      title.style.cursor = "pointer";
      title.onclick = () => switchTab(t.id);
      const close = document.createElement("span");
      close.className = "tab-close";
      close.textContent = "✕";
      close.title = "关闭标签";
      close.onclick = (e) => { e.stopPropagation(); closeTab(t.id); };
      el.appendChild(title);
      el.appendChild(close);
      box.appendChild(el);
    }
    // 首页标签激活态
    document.querySelector('#tabbar .tab[data-tab="home"]')?.classList.toggle("tab-active", tabState.active === "home");
  }

  /** 视图切换：只显示激活标签对应的容器 */
  function showView(id) {
    $("pageHome").style.display = "none";
    $("pageWorkspace").style.display = "none";
    for (const el of dismantlePages.values()) el.style.display = "none";
    if (id === "home") $("pageHome").style.display = "flex";
    else if (id === "workspace") $("pageWorkspace").style.display = "flex";
    else { const el = dismantlePages.get(id); if (el) el.style.display = "flex"; }
  }

  /** 切换标签 */
  async function switchTab(id) {
    tabState.active = id;
    renderTabbar();
    const t = tabState.list.get(id);
    if (id === "home") {
      showView("home");
      // 回到首页时刷新当前导航视图（新建书/导入后列表保持最新）
      const view = document.querySelector(".nav-item.nav-active")?.dataset.homeview || "works";
      homeNav(view);
    } else if (t?.kind === "workspace") {
      showView("workspace");
      await activateWorkspace(t.book);
      window.__relayout?.(); // 写作台可见后重新分配中栏内部（此时尺寸正确，防空白）
    } else if (t?.kind === "dismantle") {
      showView(id);
    }
  }
  window.__switchTab = switchTab;

  /** 写作工作台标签：切到对应书（换书前保存当前；同书不重载） */
  async function activateWorkspace(book) {
    if (state.currentBook !== book) {
      await flushSave(); // 防止未保存内容丢失
      updateBookName(book);
      await loadBookDetail(book);
    }
  }

  /** 打开/激活某书的写作工作台标签 */
  function openWorkspaceTab(book) {
    const id = "ws:" + book;
    if (!tabState.list.has(id)) {
      tabState.list.set(id, { id, kind: "workspace", title: book, book });
    }
    switchTab(id);
  }
  window.__openWorkspace = openWorkspaceTab;

  /** 打开/激活某书的拆书标签（iframe 独立容器；已开过则直接切过去保留状态） */
  function openDismantleTab(book) {
    const id = "dm:" + book;
    if (!tabState.list.has(id)) {
      tabState.list.set(id, { id, kind: "dismantle", title: "🔍 " + book, book });
      const wrap = document.createElement("div");
      wrap.id = id;
      wrap.className = "page dismantle-page";
      wrap.style.display = "none";
      const iframe = document.createElement("iframe");
      iframe.src = `/api/report/${encodeURIComponent(book)}`;
      iframe.style.cssText = "flex:1;min-height:0;border:0;width:100%;height:100%;background:var(--bg-base);";
      wrap.appendChild(iframe);
      // 放到设置模态之前（body 尾部区域），避免遮挡任务栏
      document.body.insertBefore(wrap, $("taskBar"));
      dismantlePages.set(id, wrap);
    }
    switchTab(id);
  }

  /** 关闭标签（首页固定不可关） */
  function closeTab(id) {
    if (id === "home" || !tabState.list.has(id)) return;
    const wasActive = tabState.active === id;
    tabState.list.delete(id);
    const el = dismantlePages.get(id);
    if (el) { el.remove(); dismantlePages.delete(id); }
    renderTabbar();
    if (wasActive) {
      const keys = [...tabState.list.keys()];
      switchTab(keys.length ? keys[keys.length - 1] : "home");
    }
  }

  /* ---------- 首页：左导航 ---------- */
  function homeNav(view) {
    document.querySelectorAll(".nav-item").forEach((el) => {
      el.classList.toggle("nav-active", el.dataset.homeview === view);
    });
    if (view === "works") renderHomeWorks();
    else renderHomeDismantle(); // 拆书 == 知识库（合并视图）
  }
  window.__homeNav = homeNav;

  /** 首页 · 小说作品：书名 + 灰色字数副标题；点书拉写作工作台标签 */
  async function renderHomeWorks() {
    const box = $("homeContent");
    try {
      const d = await api("/api/books");
      const books = d.books || [];
      let html = `<div class="works-list-head">我的书（mybook）</div>
        <div class="bookshelf">`;
      for (const b of books) {
        const sub = [];
        if (b.chapters) sub.push(`${b.chapters} 章`);
        if (b.chars) sub.push(`${b.chars.toLocaleString("zh-CN")} 字`);
        if (b.updatedAt) sub.push(fmtTime(b.updatedAt));
        html += `<div class="book-card" data-book="${escapeHtml(b.name)}" title="${escapeHtml(b.name)}">
          <div class="book-cover">${escapeHtml(b.name)}</div>
          <div class="book-sub">${escapeHtml(sub.join(" · ") || "暂无章节")}</div>
        </div>`;
      }
      html += `</div>
        <div class="section-title">操作</div>
        <div style="display:flex;gap:8px;max-width:820px">
          <button class="btn btn-primary" id="homeNewBook">+ 新建书</button>
        </div>`;
      box.innerHTML = html;
      box.querySelectorAll(".book-card").forEach((el) => {
        el.onclick = () => openWorkspaceTab(el.dataset.book);
      });
      // newBook 内部已完成：建书 → 刷新列表 → 选中 → 拉工作台标签
      $("homeNewBook").onclick = newBook;
    } catch (e) {
      box.innerHTML = `<div class="placeholder">作品列表加载失败：${escapeHtml(e.message)}</div>`;
    }
  }

  /** 首页 · 拆书（=知识库合并视图）：列出全部项目（两域）+ 标注/拆解进度，每条下方一个「拆书」按钮 */
  /** 首页 · 拆书（两栏：左=我的书 mybook，右=外部知识库；顶部为导入操作区） */
  async function renderHomeDismantle() {
    const box = $("homeContent");
    try {
      const [booksD, projD] = await Promise.all([api("/api/books"), api("/api/projects")]);
      const books = booksD.books || [];
      const projects = projD.projects || [];
      // 顶部操作区（原底部操作移到最上方）：导入参考书语料 → corpus 备份 + 分章 + exbook 区建文件夹
      let html = `<div class="section-title">操作</div>
        <div style="display:flex;gap:8px;max-width:820px;margin-bottom:16px">
          <button class="btn btn-primary" id="homeImportRef">📥 导入参考书语料</button>
        </div>
        <div class="dismantle-two-col">
        <!-- 左栏：我的书（mybook 文件夹建立即出现条目） -->
        <div class="dismantle-col">
          <div class="works-list-head">我的书（mybook）</div>
          <div class="knowledge-grid">`;
      if (!books.length) html += `<div class="placeholder">我的书为空<br>在写作工作台新建书，或打开 mybook 文件夹放入原稿</div>`;
      // my 域项目进度（左栏进度条）：name → meta
      const myMeta = new Map(projects.filter((p) => p.domain === "my").map((p) => [p.name, p.meta]));
      for (const b of books) {
        const sub = [];
        if (b.chapters) sub.push(`${b.chapters} 章`);
        if (b.chars) sub.push(`${b.chars.toLocaleString("zh-CN")} 字`);
        const mm = myMeta.get(b.name);
        const mTotal = mm?.chaptersTotal || 0;
        const mDone = mm?.chaptersAnnotated || 0;
        const mPct = mTotal ? Math.round((mDone / mTotal) * 100) : 0;
        if (mTotal) sub.push(`标注 ${mDone}/${mTotal}`);
        else sub.push("未建库");
        html += `<div class="knowledge-card">
          <div class="kc-name">${escapeHtml(b.name)}</div>
          <div class="kc-meta">${escapeHtml(sub.join(" · ") || "暂无章节")}</div>
          <div class="kc-bar"><div class="kc-bar-in" style="width:${Math.min(100, mPct)}%"></div></div>
          <div class="kc-actions">
            <button class="btn btn-sm btn-primary kc-my-annotate" data-book="${escapeHtml(b.name)}">建库标注</button>
            <button class="btn btn-sm btn-danger kc-dismantle" data-book="${escapeHtml(b.name)}">🔍 拆书</button>
          </div>
        </div>`;
      }
      html += `</div></div>
        <!-- 右栏：外部知识库 -->
        <div class="dismantle-col">
          <div class="works-list-head">外部知识库（exproject）</div>
          <div class="knowledge-grid">`;
      const ex = projects.filter((p) => p.domain === "ex");
      if (!ex.length) html += `<div class="placeholder">外部知识库为空<br>点上方「导入参考书语料」建立（corpus 备份 + 分章 + exproject 文件夹）</div>`;
      for (const x of ex) {
        const meta = x.meta;
        const total = meta?.chaptersTotal || 0;
        const done = meta?.chaptersAnnotated || 0;
        const pct = total ? Math.round((done / total) * 100) : 0;
        const sent = meta?.sentences ? ` · 句子 ${meta.sentences.toLocaleString("zh-CN")}` : "";
        const shots = meta?.shots ? ` · 分镜 ${meta.shots}` : "";
        const missing = meta?.missingChapters?.length ? ` · 缺章 ${meta.missingChapters.length}` : "";
        const pend = x.pending?.length ? ` · 待补跑 ${x.pending.length}` : "";
        // 未就绪（corpus 备份/分章/exproject 文件夹不齐全）→ 红色副标题提示缺失项
        const notReady = !x.ready;
        const missNote = notReady && x.missing?.length ? `缺：${x.missing.join("、")}` : "";
        html += `<div class="knowledge-card${notReady ? " not-ready" : ""}">
          <div class="kc-name">${escapeHtml(x.name)}</div>
          <div class="kc-meta">章节标注 ${done}/${total}（${pct}%）${sent}${shots}${missing}${pend}</div>
          ${notReady ? `<div class="kc-miss" style="color:#e5484d;font-size:12px;margin-top:4px">⚠ ${escapeHtml(missNote)}</div>` : ""}
          <div class="kc-bar"><div class="kc-bar-in" style="width:${Math.min(100, pct)}%"></div></div>
          <div class="kc-actions">
            <button class="btn btn-sm btn-primary kc-ex-annotate" data-book="${escapeHtml(x.name)}">建库标注</button>
            <button class="btn btn-sm btn-danger kc-dismantle" data-book="${escapeHtml(x.name)}">🔍 拆书</button>
          </div>
        </div>`;
      }
      html += `</div></div></div>`;
      box.innerHTML = html;
      // 按钮绑定
      box.querySelectorAll(".kc-dismantle").forEach((btn) => {
        btn.onclick = () => openDismantleTab(btn.dataset.book);
      });
      box.querySelectorAll(".kc-my-annotate").forEach((btn) => {
        btn.onclick = () => annotateMyBook(btn.dataset.book);
      });
      box.querySelectorAll(".kc-ex-annotate").forEach((btn) => {
        btn.onclick = () => annotateExBook(btn.dataset.book);
      });
      $("homeImportRef").onclick = () => {
        const inp = $("bookFileInput");
        if (!inp) return;
        inp.value = ""; // 允许重复选同一文件（onchange 才会触发）
        inp.onchange = importRefOnly; // 导入模式：仅落库不标注
        inp.click();
      };
    } catch (e) {
      box.innerHTML = `<div class="placeholder">拆书列表加载失败：${escapeHtml(e.message)}</div>`;
    }
  }

  /** 首页 · 知识库：全部项目（两域）状态 + 标注进度 */
  /** 相对时间（近 7 天显示"x天前/昨天/今天"，更早显示日期） */
  function fmtTime(iso) {
    const t = new Date(iso);
    if (isNaN(t)) return "";
    const diff = Date.now() - t.getTime();
    const day = 86400000;
    if (diff < day && t.getDate() === new Date().getDate()) return "今天";
    if (diff < 2 * day) return "昨天";
    if (diff < 7 * day) return `${Math.floor(diff / day)}天前`;
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  }

  /** 初始化标签栏 + 首页默认视图（skipFetch：空数据模式不请求） */
  function initTabs(skipFetch) {
    renderTabbar();
    showView("home");
    if (skipFetch) {
      $("homeContent").innerHTML = `<div class="placeholder">空数据模式：首页数据未加载</div>`;
      return;
    }
    homeNav("works");
  }

  /* ================= 启动 ================= */
  async function init() {
    // 注：不再使用 documentElement.style.zoom 放大 —— zoom 会同时放大布局尺寸，
    // 导致 getBoundingClientRect 返回视觉宽(×1.15)而 style.width 设置 CSS 像素，
    // 两者体系不一致 → 三栏总宽溢出容器 → 默认水平滚动条 + 内容截断。
    // （Tauri WebView2 字体偏小问题另寻方案，不在此缩放布局）
    bind();
    // 主题初始化:本地记忆优先,默认浅色
    applyTheme(safeGet("nw-theme") || "light");
    // Vditor 需在可见容器中初始化（隐藏容器尺寸为 0）；临时显示，initTabs 会切回首页
    $("pageWorkspace").style.display = "flex";
    initEditor();
    initSplitters(); // 四栏可拖宽 + 右栏内两块可拖高
    // 空数据模式（?empty=1）：只渲染布局骨架，不加载任何外部数据（用于布局验证）
    const emptyMode = new URLSearchParams(location.search).get("empty") === "1";
    if (emptyMode) {
      $("envStatus").textContent = "○ LLM 未就绪";
      $("envStatus").className = "env-status env-status-nav err";
      $("refPoolList").innerHTML = '<span class="muted">空数据模式：参考书未加载</span>';
      $("outlineList").innerHTML = '<div class="placeholder">空数据模式：书/章节未加载</div>';
      if (vditor) vditor.setValue("/* 空数据模式：仅布局验证 */");
      initTabs(true); // 标签栏 + 首页骨架（不 fetch 数据，首页留占位）
      return; // 跳过所有数据加载
    }
    initTabs(); // 标签栏 + 首页（默认视图：小说作品）
    loadConfig();
    loadRefPool(); // 参考书池(跨书参考源选择)
    loadBooks();   // 我的书(mybook 资产区)
    taskBar.init(); // 浮动任务栏（全局任务进度/报错）
    loadLatestDraft(); // 刷新后自动显示最近成稿（无成稿则忽略）
    applyAutoSaveSetting(); // 定时自动保存（设置间隔，默认 5 分钟）
    // WebUI 心跳：每 15s 上报存活；页面关闭后 server 60s 无心跳自动退出
    // （server 有保护：任务运行中/刚结束时心跳超时不退出，见 server.mjs startHeartbeatWatch）
    const heartbeat = () => fetch("/api/system/heartbeat", { method: "POST" }).catch(() => {});
    setInterval(heartbeat, 15000);
    // 标签页从休眠/后台恢复可见时立即补一次心跳（不等下一个 15s 间隔，尽快续上存活状态）
    document.addEventListener("visibilitychange", () => { if (!document.hidden) heartbeat(); });
  }

  init();
})();
