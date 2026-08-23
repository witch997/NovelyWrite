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
    const v = Number(localStorage.getItem(FONT_KEY) ?? FONT_DEFAULT);
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
    localStorage.setItem(FONT_KEY, String(next));
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
      // 保持当前选择（或恢复上次打开的书；都没有则默认第一本）
      let lastBook = null;
      try { lastBook = JSON.parse(localStorage.getItem("nw-last-open") || "null")?.book ?? null; } catch { /* ignore */ }
      if (state.currentBook && state.books.some((b) => b.name === state.currentBook)) {
        sel.value = state.currentBook;
      } else if (lastBook && state.books.some((b) => b.name === lastBook)) {
        state.currentBook = lastBook;
        sel.value = lastBook;
      } else {
        state.currentBook = state.books[0].name;
        sel.value = state.currentBook;
      }
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
    await flushSave(); // 切换书前强制保存当前章节（防未保存内容丢失）
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

  /** 打开章节（读 mybook 内容 → 编辑器）；切换前强制保存当前章，记录「上次打开的书+章节」 */
  async function openChapter(num) {
    if (!state.currentBook) return;
    await flushSave(); // 切换章节前保存当前编辑器内容（防未保存丢失）
    state.currentChapter = num;
    renderOutline();
    try {
      localStorage.setItem("nw-last-open", JSON.stringify({ book: state.currentBook, chapter: num }));
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
      toast(`✅ 已开始建库《${r.name}》${modeDesc}${changeNote}`);
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
    const left = $("paneLeft"), draftPane = $("paneDraft"), right = $("paneRight");
    const spLeft = document.querySelector('.splitter-v[data-split="left"]');
    const spDraft = document.querySelector('.splitter-v[data-split="draft"]');
    const spRight = document.querySelector('.splitter-v[data-split="right"]');
    const panel = document.getElementById("aiPanel");
    const inputSec = $("aiInputSec"), refSec = $("aiRefSec");
    const spH1 = document.querySelector('.splitter-h[data-split="aiInput"]');

    // 恢复记忆尺寸（列宽）——受写作台最小宽度(400)约束，防覆盖
    const EDITOR_MIN = 400, SPLITV = 5; // 写作台最小宽 / 竖分隔条宽
    const MIN_COL = 140; // 各栏最小宽
    const fixedOthers = (exclude) => {
      let sum = EDITOR_MIN + SPLITV * 3; // 写作台 + 三条分隔条
      if (exclude !== left) sum += left.getBoundingClientRect().width;
      if (exclude !== draftPane) sum += draftPane.getBoundingClientRect().width;
      if (exclude !== right) sum += right.getBoundingClientRect().width;
      return sum;
    };
    // 该栏最大宽 = 布局 − 其他栏与写作台最小占用；写作台 min 优先（不覆盖写作台）
    const maxLeft = () => Math.max(MIN_COL, layoutW() - fixedOthers(left));
    const maxDraft = () => Math.max(MIN_COL, layoutW() - fixedOthers(draftPane));
    const maxRight = () => Math.max(MIN_COL, layoutW() - fixedOthers(right));
    const savedL = Number(localStorage.getItem("nw-left-w"));
    const savedD = Number(localStorage.getItem("nw-draft-w"));
    const savedR = Number(localStorage.getItem("nw-right-w"));
    if (savedL > 0) left.style.width = Math.min(savedL, maxLeft()) + "px";
    if (savedD > 0) draftPane.style.width = Math.min(savedD, maxDraft()) + "px";
    if (savedR > 0) right.style.width = Math.min(savedR, maxRight()) + "px";

    /* ---------- AI 参考栏：两块 + 一条拖拽条 绝对定位统一排布 ---------- */
    let inputH = Math.max(110, Number(localStorage.getItem("nw-ai-input-h")) || 160);
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
    layoutAiPanel();

    /** 列宽拖拽（左栏向右增宽 / 成稿栏 / 右栏向左增宽）
     *  maxW：该栏最大宽度（由其他栏最小宽度约束，防覆盖写作台）
     *  isLeft：true=向右拖增宽（左栏）；false=向左拖增宽（成稿/右栏） */
    function dragCol(spEl, target, saveKey, isLeft, maxW) {
      spEl.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        spEl.setPointerCapture?.(e.pointerId);
        spEl.classList.add("dragging");
        const startX = e.clientX;
        const startW = target.getBoundingClientRect().width;
        const move = (ev) => {
          const delta = ev.clientX - startX;
          const w = Math.max(140, Math.min(startW + (isLeft ? delta : -delta), maxW()));
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
          localStorage.setItem(saveKey, String(Math.round(inputH)));
        };
        document.addEventListener("pointermove", move);
        document.addEventListener("pointerup", up);
        document.addEventListener("pointercancel", up);
      });
    }

    dragCol(spLeft, left, "nw-left-w", true, maxLeft);
    dragCol(spDraft, draftPane, "nw-draft-w", false, maxDraft); // 分隔条右拖 → 成稿栏变窄（写作台变宽），符合直觉
    dragCol(spRight, right, "nw-right-w", false, maxRight);
    dragRow(spH1, "nw-ai-input-h", 110); // 输入区：需容纳按钮+输入框（右栏仅一条拖拽条）
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
    // 成稿区"插入到写作栏"（固定按钮在成稿栏头 + 兼容旧内嵌调用）
    $("btnInsertDraft").onclick = insertDraftToEditor;
    $("btnClearDraft").onclick = clearDraft;
    window.__insertDraft = insertDraftToEditor;
    // 导入参考书
    $("btnImportBook").onclick = importBook;
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

  /* ================= 启动 ================= */
  async function init() {
    bind();
    // 主题初始化:本地记忆优先,默认浅色
    applyTheme(localStorage.getItem("nw-theme") || "light");
    initEditor();
    initSplitters(); // 四栏可拖宽 + 右栏内两块可拖高
    // 空数据模式（?empty=1）：只渲染布局骨架，不加载任何外部数据（用于布局验证）
    const emptyMode = new URLSearchParams(location.search).get("empty") === "1";
    if (emptyMode) {
      $("envStatus").textContent = "空数据模式（未加载外部数据）";
      $("envStatus").className = "env-status warn";
      $("modelSelect").innerHTML = '<option value="">(空模式)</option>';
      $("refPoolList").innerHTML = '<span class="muted">空数据模式：参考书未加载</span>';
      $("outlineList").innerHTML = '<div class="placeholder">空数据模式：书/章节未加载</div>';
      if (vditor) vditor.setValue("/* 空数据模式：仅布局验证 */");
      return; // 跳过所有数据加载
    }
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
