# 任务模块已知问题清单（task/ISSUES.md）

> 状态：**P0+P1 已修复（2026-08-23），P2 遗留**。修复详情见各条勾选记录。

---

## P0 — 严重（影响正确性/可信度）

### ✅ P0-1 kill 是假的（停止按钮无效）— 已修复
- **修复**：`task/manager.mjs` 的 `taskState` 改为存 `{ t, child, killed }`；
  `killTask` 调 `child.kill()` 真杀子进程；`child.on("close")` 先查 `killed` 标志，
  用户主动停止时不覆盖状态；排队任务直接出队标 killed。已验证：kill 后子进程
  从进程表消失、状态稳定为 killed（不再被 close 覆盖成 success）。
- **决策**：只杀直接子进程（host-exec 内部 execFileSync 的孙进程由 OS 回收，
  不追杀进程树——1B）。

### ✅ P0-2 进度解析双轨制，且只服务 annotate — 已修复
- **修复**：统一 `[task] {stage,done,total,phase,error}` JSON 行协议——6 个业务脚本
  （host-exec/aggregates/fix/preprocess/recall/writedraft）阶段变化时输出；
  `task/manager.mjs` 一个解析器通吃；前端 `progressFrom` 启发式删除
  （webview/app.js 保留为 stub 返回 null）。[task] 行同时进日志留痕。
- **决策**：[task] 行写日志（A）。

### ✅ P0-3 状态机缺"部分成功"语义 — 已修复
- **修复**：status 增加 `queued`；任务结束生成结构化 `summary {ok, failed[], pending}`——
  建库任务由 server 推导（`annotateRangeState`：todo−done=missing，成功/失败/部分成功
  都生成）；前端结束卡片显示"⚠ X/Y 成功，缺第N章"（部分成功）、"✅ 完成"、
  "❌ 失败"。`error` 结构化：业务 `[task] {error}` 或 spawn error，不再从日志正则抠。
- **决策**：summary 由 server 推导（A）。

---

## P1 — 重要（影响可维护性/健壮性）

### ✅ P1-1 任务类型字符串魔法散落四处 — 已修复
- **修复**：新增 `task/registry.mjs`（TASK_KINDS：script/name/queue/progress/rerun/
  argsOf），`startTask(kind, body)` 注册表驱动；server 路由/前端展示名/stale 判断
  全部经注册表。加新任务类型 = 加一条注册。
- **决策**：startTask 签名改为 `(kind, body)`（A）。

### ✅ P1-2 无并发控制（连点建库会文件竞争）— 已修复
- **修复**：并发域队列 `queues: {build: [], writing: []}`——build 域
  （annotate/aggregate/fix）串行、writing 域（preprocess/recall/writedraft）串行、
  跨域并行。新任务入队 status=queued，返回 `{queued, position}`；前端显示排队状态
  （"⏳ 排队中"+ 取消按钮）。
- **决策**：接受"建库时点聚合要等"（6）。

### ✅ P1-3 日志与状态耦合、IO 低效 — 已修复
- **修复**：`shared/tasks.mjs` `appendTaskLog` 改为纯 append + 惰性截断（文件超
  256KB 才读全量截尾，不再每批 O(n)）；`task/manager.mjs` progress 写盘节流
  （有变化且 ≥500ms 才 persistTask）。

### ✅ P1-4 错误无结构化字段，靠日志正则抠 — 已修复
- **修复**：`error: {message}` 结构化字段（业务 `[task] {error}` / spawn error /
  close 时日志尾部兜底——排除 [task] 协议行）；前端失败卡片直接读 `t.error.message`。
  曾出现"卡在42章"式日志误导已消除（历史错误行不霸屏的 lastLogLine 只扫尾部 8 行）。

---

## P2 — 一般（影响体验/扩展性，遗留未修）

### ⏳ P2-1 重启恢复弱（无断点续跑）
- 现状：server 重启 → running/queued 统一标 killed；无 pid 存活检测/续接能力。
- 方向：启动时查 pid 存活 → 存活重新 attach stdout 续接；已死标 killed + 自动判 stale。

### ⏳ P2-2 API 无过滤分页、日志无增量
- 现状：`/api/tasks` 全量返回，`/api/tasks/:id/log` 每次全量 500 行。
- 方向：`?status=&kind=&limit=`；`/log?after=N` 游标增量。

### ⏳ P2-3 前端轮询放大
- 现状：每 1.5s 对每个 running/queued 任务发 detail+log 两个请求。
- 方向：日志增量游标；或 SSE 推送（`onTaskEvent` 已留接口位）。

---

## 已修复问题（历史，勿重复改）

- 2026-09-04 kill 竞态：kill running 任务后其状态立刻变 killed（子进程可能仍在同步
  execFileSync 写盘），但旧逻辑 pumpQueue 只查 running → 同域新任务被提前放行，
  与未退出的旧进程并发写同一本书。修复：pumpQueue 引入 queueBusy 占槽判断——
  killed 且仍在 taskState（未 close/未手动收尾）的任务继续占槽，由 close 回调或
  5s SIGKILL 兜底出队后再唤醒下一个（改动未提交，task/manager.mjs）
- 2026-09-04 服务器进程+子进程写入器缓存不一致（无过期、永久陈腐风险）：
  sentMap/entity 词典带 mtime+size 签名缓存，加载时 statSync 对比签名失效
  （retriever/rag-core.mjs fileSig + retriever/lexical.mjs；改动未提交）
- 2026-09-04 诊断转储写入代码根 CODE_ROOT（只读/不可写部署会失败）：raw 转储
  改写到数据根 outputDir/raw/（novelread/host-exec.mjs 3 处 + aggregates.mjs stateDir；
  改动未提交）
- 2026-09-04 LLM fetch 无超时（API 挂起=任务永久 running/看板转圈）：
  host-exec（宿主级任务取 max(timeoutMs,15min)）、aggregates、preprocess/writedraft、
  report/ask+report/report 全部补 AbortController + 可操作报错；shared/llm.mjs
  为不可达死代码未动（改动未提交）
- 2026-09-04 config.json 直接 writeFileSync 覆写（写一半被 kill=半截 JSON 单点损坏）：
  新增 shared/fs.mjs 原子写（tmp+rename，Windows/NTFS rename 覆盖原子性），
  server.mjs apiConfigPut/apiSaveKeys 两处 config 写入改走 atomicWriteJson
  （改动未提交，shared/fs.mjs 为新增文件）
- 2026-08-23 任务有失败章仍 exit 0 → 显示假成功：host-exec 收尾按 `failedCh`
  设退出码 1（commit bf2c08a）
- 2026-08-23 任务卡片状态文字被历史错误行霸屏：`lastLogLine` 只扫尾部 8 行
  （commit d3a12fb）
- 2026-08-23 页面被杀/休眠时任务被连带杀掉：心跳保护（有任务运行/刚结束不退出，
  commit 6bbf9d8）
- 2026-08-23 进度依赖日志截断丢失：server 维护结构化 progress 字段
  （commit d5375dd）
- 2026-08-23 任务管理从 server.mjs 抽出为 task/manager.mjs（纯搬家，commit 6e8157e）
