# 任务模块已知问题清单（task/ISSUES.md）

> 状态：**只记录，未修复**。2026-08-23 从 server.mjs 结构性抽出 task/manager.mjs 时
> 原样搬移（行为零改动），以下问题在搬家前就已存在。修复请另立任务，逐一解决，
> 修复后在此勾选。

---

## P0 — 严重（影响正确性/可信度）

### P0-1 kill 是假的（停止按钮无效）
- **位置**：`task/manager.mjs` 的 `killTask` + `startTask`
- **现象**：`taskState` 只存了状态对象 `t`，**没存 child 句柄**；`killTask` 只把
  `status` 改成 `"killed"`，子进程照跑。且 `child.on("close")` 无条件覆盖状态：
  `t.status = code === 0 ? "success" : "failed"` —— 用户点"停止"后任务照样跑完，
  最终显示"✅ 完成"。
- **修复方向**：`taskState` 存 `{ t, child, killed }`；`killTask` 调 `child.kill()`；
  close 回调先查 `killed` 标志，置 killed 则不覆盖。

### P0-2 进度解析双轨制，且只服务 annotate
- **位置**：`task/manager.mjs` 的 `parseProgress`（server 端）+ `webview/app.js`
  的 `progressFrom`（前端启发式）
- **现象**：server 端硬编码匹配 host-exec 的行（`本次任务 N 章待处理`/`第X章完成`/
  `往返1`/`往返2`/`全部完成`）；前端又有一套日志正则启发式。两套各自维护，
  可能不一致。**aggregate/fix/preprocess/recall/writedraft 五种任务完全没有
  结构化进度**，前端只能猜固定百分比（40%/50%）。
- **修复方向**：业务脚本统一输出 `[task] {stage,done,total,phase}` JSON 行协议，
  server 一个解析器通吃；前端删 `progressFrom` 启发式，只读 `progress` 字段。

### P0-3 状态机缺"部分成功"语义
- **位置**：`task/manager.mjs`（status 枚举）+ `webview/app.js` 卡片渲染
- **现象**：status 只有 `running|success|failed|killed`。建库 19 章成功 18 失败 1，
  旧代码 exit 0 显示"✅ 完成"（假成功）；补了退出码后整任务变"❌ 失败"
  （18 章成功也被抹成失败）。真实语义"18/19 成功、缺第50章"无法表达。
- **修复方向**：状态增加结构化 `summary: {ok, failed[], pending}`，结束卡片
  显示"⚠ 18/19 成功，缺第50章"。

---

## P1 — 重要（影响可维护性/健壮性）

### P1-1 任务类型字符串魔法散落四处
- **位置**：`task/manager.mjs`（`startTask` 的 label、`apiTaskStale` 的
  `script === "novelread/host-exec.mjs"`）、`server.mjs` 路由表、`webview/app.js`
  `labelOf()` map、`progressFrom` 分支
- **现象**：加一个任务类型要改 4 处；类型名拼错静默失效；无单一事实源。
- **修复方向**：`TASK_KINDS` 注册表（script/name/progress 语义/rerun 策略/并发域）。

### P1-2 无并发控制（连点建库会文件竞争）
- **位置**：`task/manager.mjs` `startTask`
- **现象**：用户连点两次建库 → 两个 host-exec 同时写同一项目目录 → 文件竞争/脏写。
- **修复方向**：并发域队列（建库域串行、写作域串行、两域并行）。

### P1-3 日志与状态耦合、IO 低效
- **位置**：`shared/tasks.mjs` `appendTaskLog`（每批读全量→过滤→截尾→重写，
  O(n)/批）+ `parseProgress` 每次有进度就 `persistTask` 全量写盘（高频小写）
- **修复方向**：日志尾部追加（超限才截断）；progress 写盘节流（≥1s 一次，
  退出前 flush）。

### P1-4 错误无结构化字段，靠日志正则抠
- **位置**：`webview/app.js` `lastLogLine` 的 `/失败|✗|❌|error/` 正则
- **现象**：任务失败原因只能从日志文本猜，前端显示不准确、易被历史错误行误导
  （曾出现"卡在42章报错"实为历史失败行霸屏）。
- **修复方向**：`error: {message, chapter?}` 结构化字段（spawn error / 业务
  `[task] {error}`），前端直接读。

---

## P2 — 一般（影响体验/扩展性）

### P2-1 重启恢复弱（无断点续跑）
- **位置**：`task/manager.mjs` `cleanupOnStart`
- **现象**：server 重启 → 所有 running 统一标 killed（子进程确实死了），
  日志/进度丢失；只能手动 rerun，无"检查 pid 存活/续接"能力。
- **修复方向**：启动时查 pid 存活 → 存活重新 attach stdout 续接；已死标 killed
  + 自动判 stale（缺章已补齐删记录/未补齐红卡可 rerun）。

### P2-2 API 无过滤分页、日志无增量
- **位置**：`server.mjs` 路由 `/api/tasks`、`/api/tasks/:id/log`
- **现象**：任务列表全量返回（可能堆积上百条），前端自己 `slice(0,3)`；
  日志每次全量拉 500 行，无 offset 续读。
- **修复方向**：`?status=&kind=&limit=`；`/log?after=N` 游标增量。

### P2-3 前端轮询放大
- **位置**：`webview/app.js` `taskBar.poll`（每 1.5s 对每个 running 任务
  发 detail+log 两个请求）
- **现象**：多任务时 N×2 请求/1.5s，且 log 全量。
- **修复方向**：running+queued 才拉 detail；日志增量游标；或 SSE 推送
  （`onTaskEvent` 已留接口位）。

---

## 已修复问题（历史，勿重复改）

- 2026-08-23 任务有失败章仍 exit 0 → 显示假成功：host-exec 收尾按 `failedCh`
  设退出码 1（commit bf2c08a）
- 2026-08-23 任务卡片状态文字被历史错误行霸屏：`lastLogLine` 只扫尾部 8 行
  （commit d3a12fb）
- 2026-08-23 页面被杀/休眠时任务被连带杀掉：心跳保护（有任务运行/刚结束不退出，
  commit 6bbf9d8）
- 2026-08-23 进度依赖日志截断丢失：server 维护结构化 progress 字段
  （commit d5375dd）
