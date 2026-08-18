---
name: 语料分析
description: 将语料文件夹中的原始语料作为输入，按分层流程（语料分章 → 句子 → 分镜 → 章节 → 大事件 → 卷纲）分析，产出包含各层分析结果文件的 project 文件夹，置于 store 下。执行分两阶段：事实层（逐章两次 LLM 往返，句子层为唯一权威源）→ 聚合层（一次性生成章节表/大事件主文件/卷纲）。
---

# 语料分析

## 角色与任务

你是**语料全流程分析师**：将 `corpus/` 中的原始语料，按分层流程完整分析，产出 **project 文件夹**（含各层分析结果 + 章节切分副本）。

```
输入：语料文件夹（corpus/）
  ↓ 事实层（阶段一，逐章，每章 2 次 LLM 往返）
  ↓ 往返1：句子层 → 句子标注 JSON（★ 唯一权威源，过闸后冻结）
  ↓ 往返2：分镜层 + 章节层 → 分镜标注 JSON + 章节标注 JSON
  ↓ 聚合层（阶段二，全部落盘后一次性）
  ↓ 章节表 JSON / 大事件主文件 JSON / 卷纲 JSON
输出：project 文件夹（store/<语料名>project/）
```

> **两阶段机制（本 SKILL 的核心约定）**：
> - **阶段一·事实层**：逐章执行 **2 次 LLM 往返**，各往返只交付对应章级文件，且**各往返后设硬闸门**（上游不过闸，下游不执行）：
>   - **往返1（句子）**：只输出 `句子标注/json/第XXXX章.json`。过闸后**句子层冻结**——后续任何层只读不改（句子是唯一权威源）。
>   - **往返2（分镜+章节）**：只输出 `分镜标注/json/第XXXX章.json` + `章节/第XXXX章.json`。输入 = 句子 JSON（不改句子边界）。
>   - 语料分章由宿主脚本生成，聚合文件由阶段二生成。
> - **阶段二·聚合层**：全部章落盘后，宿主运行确定性重算（章节表/清单/缺章报告），再分两次 LLM 调用做语义判定——调用①只输出 `大事件/event.json`（lifecycle[] 事件跨章判断），调用②只输出 `卷纲/volume.json`（targets[] 目标跨章判断；**只吃 summary，与调用①彻底正交**）。
> - 宿主在每个往返落盘后执行**对应层校验**（语法 + 契约），不合格记 issue 不阻塞批任务（该章标记待修）。

## 输入与输出

### 输入
- **语料文件**：`corpus/<语料名>-语料.txt`
- **章节清单**（若存在）：`corpus/<语料名>-章节清单.csv` 或 `corpus/章节清单.csv`（章号/标题/语料行范围）
- 语料可能带章节标记（`数字、标题` 或 `第X章`），无清单时由分章步骤自动识别

### 输出（project 文件夹）
`store/<语料名>project/`

```
<语料名>project/
├── 语料分章/第0001章_标题.txt … 第NNNN章_标题.txt   # ★ 按章节切分的语料副本（宿主脚本）
├── 清单/章节清单.csv                                # 宿主脚本恢复/维护
├── 句子标注/json/第0001章.json … 第NNNN章.json       # dsh/sentence-card/v1（事实层·往返1，★唯一权威源）
├── 分镜标注/json/第0001章.json … 第NNNN章.json       # dsh/shot-card/v1（事实层·往返2）
├── 章节/第0001章.json … 第NNNN章.json               # 章节标注 dsh/chapter-annotation/v1（事实层·往返2）
│   └── 章节表.json                               # 全卷聚合 dsh/chapter-table/v1（聚合层）
├── 大事件/event.json                             # 主文件 dsh/event-card/v1（聚合层）
├── 卷纲/volume.json                               # 单卷层 dsh/volume-card/v1（聚合层）
└── project-meta.json                            # ★ 项目头文档 dsh/project-meta/v1（终检脚本生成）
```

> **project-meta.json（项目头文档，脚本化维护）**：由终检脚本生成/更新——含项目自述（corpus/清单来源、chapterRange、counts、缺失章）、语法验收状态（syntaxPass/badFiles）、契约问题计数、`verifiedAt`（终检时间戳）与 `updatedAt`（聚合重算时间戳）。**其他软件读取该文件即可了解本项目状态**；不依赖 LLM 生成。

> store 内**不生成任何人类可读 .md 文件**。人类可读的拆书报告由专门的拆书功能读取 JSON 后另行生成，不落入 store。

## 工作流程（事实层两往返 + 聚合层，每步：输入 → 处理 → 输出 → 闸门）

### 第0步：语料分章（宿主脚本执行，LLM 不参与）
- **执行者**：**宿主脚本**（确定性）
- **输入**：`corpus/<语料名>-语料.txt`；章节清单（章号/标题/语料行范围）
- **处理**（宿主）：按清单行范围 `[start, end)` 切片（跳过标题行）→ 写入 `语料分章/第XXXX章_标题.txt`（四位零填充）→ 维护 `清单/章节清单.csv`
- **输出**：`语料分章/第XXXX章_标题.txt`（= 喂给 LLM 的本章原文切片；与语料的偏差属输入偏差，不校验）
- **消费方**：句子层（往返1 的输入）

### 往返1：句子层（唯一权威源，硬闸门）
- **输入**：本章原文切片
- **处理**：按停顿标点 `，、；。！？…` 切分 → struct 标注（短句/句从，轻标注无 type/funcs）
- **输出**：`句子标注/json/第XXXX章.json`（dsh/sentence-card/v1，**只输出这一个文件**）
- **【硬闸门 A】**：落盘语法 + 句子层校验（S#/seq 连续、struct 枚举、text 非空）
  - 通过 → 落盘（**句子层冻结**：后续往返/聚合只读不改）
  - 失败 → 本章跳过（不执行往返2，标记 issue）
- **消费方**：分镜层/章节层（往返2 输入）

### 往返2：分镜层 + 章节层（硬闸门）
- **输入**：句子 JSON（**唯一**，不改句子边界）
- **分镜层**：以句子序列为输入，按切镜判据划分分镜 → type/funcs/label 标注 → 输出 `分镜标注/json/第XXXX章.json`（dsh/shot-card/v1）
- **章节层**：基于分镜/句子 → function/summary/mainlineProgress → 输出 `章节/第XXXX章.json`（dsh/chapter-annotation/v1）
- **输出**：两个文件（分镜 + 章节标注）
- **【硬闸门 B】**：落盘语法（两文件）+ 分镜层校验（覆盖无缝、type/funcs 枚举、sentenceIds⊆句子）+ 章节层校验（function 枚举、summary 非空、state 枚举）
  - 通过 → 落盘 → 宿主脚本派生（shotId/range/stats/suspense）→ 复检 → 本章完成
  - 失败 → 本章跳过（标记 issue，批末统一修）
- **消费方**：聚合层（读各章 summary）

### 第4步：大事件分析（聚合层，阶段二）
- **输入**：全部章节标注（各章 summary）
- **处理**：抽跨章事件（直接从 summary 抽取，条数不限）→ 状态机判生命周期（事件开启/持续/结束）→ 每项带 note（≤60 字）
- **输出**：`大事件/event.json`（主文件：lifecycle[]，聚合层调用①生成；**无 mainline/chapterIndex**）
- **消费方**：下游查询/检索层（事件跨章判断的唯一权威源）

### 第5步：卷纲生成（聚合层，阶段二）
- **输入**：仅全部章节标注（各章 summary）——**与 event.json 彻底正交，不读调用①结果**
- **处理**：目标跨章判断——从 summary 归纳卷级目标 targets[]（target/state/evidenceChapters/note，state 取目标五态）；goal/diagnostics 判定；isMain 由宿主脚本派生
- **输出**：`卷纲/volume.json`（dsh/volume-card/v1）
- **消费方**：下游查询/检索层（目标跨章判断的唯一权威源）

## 格式契约（LLM 标注时以此为准，不再引用外部文件）

### 模型调用约定（宿主执行时强制，LLM 标注不感知）
- 宿主调用 LLM 时必须传 `thinking: {type: "disabled"}`（禁用思考，直接输出正文）。
- 原因：标注所用 reasoning 模型（如 deepseek-v4-flash）在长任务（规范全文 + 大章语料）下，默认思考过程会吃光 max_tokens 预算——实测 65536 tokens 全部消耗在 reasoning 上、content 为空（finish_reason=length），导致整章标注失败。
- 配套参数：流式输出（stream: true）、max_tokens 取大值（如 65536）、不设超时；输出 JSON 内字符串换行必须转义为 `\n`（不得出现未转义裸换行）。

### 句子层 `dsh/sentence-card/v1`
- 文件：`句子标注/json/第XXXX章.json`
- 字段：`schema` / `chapter{number:int, title, range:[int,int]}` / `source` / `sentences[]`
- `sentences[]`：`id(S#)` / `seq:int` / `struct` / `text` / `note("")`
- **`shotId` 由宿主脚本生成**（从分镜 sentenceIds 反查），**LLM 不输出该键**
- **struct 枚举**：`短句` / `句从`
- 切分规则：按停顿标点 `，、；。！？…` 切分；引号内话语为整体；聚合信号（主语承接/动作链/修饰补充）→句从；断开信号（新信息/新主语/视角切换/对话句）→短句
- 句子 text 应尽量与原文一致（软约束，参考输入偏差，不校验）；无 type/funcs（轻标注）

### 分镜层 `dsh/shot-card/v1`
- 文件：`分镜标注/json/第XXXX章.json`
- 字段：`schema` / `chapter` / `source` / `shots[]`
- `shots[]`：`id:int` / `type` / `funcs[]` / `label(软约束 ≤10 字，无下界，含主语则显式声明；长度不校验、仅供人读/检索)` / `sentenceIds[]` / `note("")`
- **`sentenceRange` 由宿主脚本生成**（从本镜 sentenceIds 算 min/max），**LLM 不输出该键**
- **type 六型**：`信息` `对话` `心理` `动作` `事件` `环境`
- **funcs 十种**（多值 1-3 个，无主辅无实体）：`塑造人物` `引入世界观` `设置动机` `推进` `铺垫` `反转` `爆发` `转场` `收束分镜` `悬念`
- 切镜判据：空间切换 / 时间跳跃 / 视角切换 / 舞台切换 / 感知通道切换 / 动作溢出；宁过切勿合并
- 章末校验：最后一镜按实际功能标注，不强制"悬念"（真实收尾/日常就标对应功能；确实以悬念收尾才标"悬念"）

### 章节层 `dsh/chapter-annotation/v1`
- 章节标注：文件 `章节/第XXXX章.json`（一章一文件，单章结构）；顶层 `schema` / `chapter{number:int,title,range:[int,int]}` / `function` / `summary(软约束 ≤400字，优先体现含{悬念/反转/爆发/设置动机}的分镜信息；长度不校验，消费方为 LLM 语义判定，对长度宽容)` / `mainlineProgress[]` / `source`
- **`stats` / `suspense` 由宿主脚本生成**（从本章分镜/句子 JSON 扫标签聚合），**LLM 不输出这两个键**
- **chapterFunc 七种**：`开端` `推进` `铺垫` `爆发` `转折` `收束章节` `过渡`
- **mainlineState 五种**：`主线启动` `推进` `受阻` `达成` `更换`
- `mainlineProgress[]` 元素：`{entity, state, evidence}`
- > 章节表 `章节/章节表.json`（dsh/chapter-table/v1）**不由本章 LLM 输出**——由聚合层确定性重算生成（见【聚合层】）。

### 大事件层 `dsh/event-card/v1`（主文件，聚合层）
- 主文件（聚合层调用①输出）：文件 `大事件/event.json`；字段 `schema` / `volume` / `lifecycle[]` / `derivedFrom`
- `lifecycle[]`：`{entity, 开始章:int, 持续章:int[], 结束章:int|null, state, note}`——**结束章为 int 或 null（null = 未了结，不得填字符串），悬置状态由 state 字段表达**
- **lifecycleState 两种**：`悬置` `已回收`
- **`note`（必填）**：一句叙述性说明（事件性质/关键节点/成因，≤60 字，客观陈述）
- **lifecycle 条数不限**：按语料实际识别出多少具名事件就列多少条，不设上限
- **已废弃（不得输出）**：`mainline[]`（已并入卷纲 targets）、`chapterIndex`（与章节表.chapters[] 重复）

### 单卷层 `dsh/volume-card/v1`
- 文件：`卷纲/volume.json`（聚合层调用②输出）
- 字段：`schema` / `volume` / `goal` / `targets[]` / `diagnostics[]` / `derivedFrom`
- `targets[]`：`{target, state, evidenceChapters:int[], note}`——**卷级目标的跨章判断**，与 event.json 彻底正交（不引用任何事件实体名）
- **targetState 五种**：`确立` `推进` `达成` `搁置` `失败`（目标语义词表，区别于 lifecycleState 的 悬置/已回收）
- `target`：目标名（卷级意图，**不得引用事件名**；删掉事件名后描述仍成立）
- `evidenceChapters`：推进该目标的章号数组（LLM 从 summary 判定）
- `note`：叙述性说明（可提及事件作佐证，但结构化字段不引用事件）
- `isMain`：**由宿主脚本派生，LLM 不输出**——按 evidenceChapters.length 降序，命中章节最多者为唯一主目标（`isMain: true`，其余不写）
- **已废弃（不得输出）**：`eventStructure[]`（事件跨章判断已归 event.json）、`mainline{result,state,evidence}`
- 不生成 `卷纲.md`（store 不落人类可读文件）。

## 聚合层（阶段二：全部章落盘后一次性执行）

聚合层**不在单章 LLM 调用中交付**，由宿主在事实层全部完成后统一执行，顺序：

1. **确定性重算**（脚本）：`章节/章节表.json`（chapters[]/mainlineProgress[]/真实 stats/chapterRange/derivedFrom）、`清单/章节清单.csv` 恢复、缺章报告——**输入只读本项目全部章节标注的规定字段**（见【增量更新·读取】）
2. **语义判定调用①**（LLM，输入 = 全部 summary）→ 输出 `大事件/event.json`：
   - lifecycle 状态机：同 entity → 更新 持续章[]/结束章/state；新 entity → 追加（开始章=出现章号）；未出现条目不保留；条数不限
   - 每项带 note（≤60 字）；**不输出 mainline/chapterIndex**（宿主脚本兜底删除）
3. **语义判定调用②**（LLM，输入 = 仅全部 summary——与 event.json 彻底正交，不读 event.json）→ 输出 `卷纲/volume.json`：
   - targets[]：卷级目标跨章判断（target/state/evidenceChapters/note），state 取目标五态；**不输出 isMain**（宿主脚本按 evidenceChapters.length 派生）
   - goal / diagnostics 判定；**不输出 eventStructure/mainline**（宿主脚本兜底删除）
4. **终检**（脚本）：全项目 JSON 语法门（严格，**跳过 temp 文件**）+ 契约门（宽松计数）+ 缺章统计 → 写 `project-meta.json`

### 聚合层·增量更新（宿主执行，默认模式）

有 `derivedFrom.aggregatedChapters` 快照时，聚合层默认走**增量**（`--full` 强制全量逃生门）：

1. **计算新增章** = 全部已标注章号 − aggregatedChapters；无新增 → 只跑确定性重算，跳过 LLM
2. **新增章单独聚合**（只喂新增章 summary，语义判定逻辑同全量）→ 产出 temp 文件并持久保留：
   - `大事件/eventtemp-<时间戳>.json`（dsh/event-card/v1 同构，含 `tempFor` 标注批次章号）
   - `卷纲/volumetemp-<时间戳>.json`（dsh/volume-card/v1 同构，含 `tempFor`）
   - **temp 语义失真**：只喂新增章，temp 内条目的 开始章/state/结束章 不可信（只作新增章视角），**合并时只取章号**
3. **合并判定**（两次 LLM 调用：event 一次、卷纲一次；输入 = 旧正式文件精炼视图 + temp）→ 逐条输出指令：
   - `merge`：同一实体（章号重叠/语义同一）→ `{"action":"merge","条目索引":N,"并入章号":[...],"状态覆盖":{可选}}`；状态覆盖仅限前向（state 悬置→已回收、结束章 null→int）
   - `insert`：旧文件没有 → `{"action":"insert","条目":{完整对象}}`；**拿不准一律 insert（宁拆勿合）**
4. **脚本应用**：merge 并章号（去重升序）+ 状态覆盖；insert 追加；应用前校验 entity 名与索引匹配
5. **收尾**：卷纲 `targets.isMain` 重派生 → `derivedFrom.aggregatedChapters` 更新（旧 ∪ 新增章）→ 终检 → 索引

**temp 文件规范**：`{event|volume}temp-YYYYMMDDTHHmmss.json`，跟随各层存放，**持久保留不随合并删除**（留待检查）；check 终检/聚合层/改错检查**跳过含 temp 的文件**，但单独校验 temp（语法 + 与层同构 + tempFor 存在）。

**失败重入**（`store/<项目>/incremental-state.json` 事务标记）：
- 增量开始写状态（batch=本批章号 + tempTs），成功完成删除，失败保留
- 重跑同批次 → 复用 tempTs（temp 幂等覆盖不堆积）+ **复用已落盘 temp（跳过 temp 聚合 LLM，直接进合并判定）**
- 失败后又补了章 → 新批次新 tempTs（旧 temp 保留待查）
- check 检测到状态文件残留 → 提示「上次增量未完成，重跑同批次续传」（非阻塞）

**增量边界**：只保证「延续正确」（新章并入已有条目/新实体插入）；**不支持**粒度调整（split/重切）、旧章 summary 修正、状态反向（复活）——这些场景走 `--full` 全量。建议周期性（如每 10 轮增量）跑一次 `--full` 校准。

## 自检模块

- 句子无遗漏：text 非空且 S# 连续（与语料的逐字一致属软约束，不校验）
- 分镜覆盖：sentenceRange 无缝覆盖 S1..Sn；sentenceIds 全覆盖不重叠
- 枚举合法：type/funcs/chapterFunc/mainlineState/lifecycleState/targetState 严格取契约枚举
- 版本戳：派生文件（章节表.json/event.json/volume.json）含 `derivedFrom`

## 增量更新（执行时遵守）

- **检查现状**：执行前先读取 `store/<语料名>project/` 的文件清单，确定**哪些章已标注、哪些未标注**；只处理未标注章（已产出的章不重跑）

- **读取（本次输入，只读不改）**：
  - **新章语料**：从 `corpus/<语料名>-语料.txt` 按章节清单取本章原文（往返1 输入）
  - **聚合重算输入（范围写死）**：只读本项目 `store/<语料名>project/章节/第XXXX章.json`（**全部已标注章**）的以下字段，聚合层的一切重算只依据这些字段：
    - `summary`（≤400 字，**唯一的语义输入**——事件抽取、动机、主线判定、卷纲摘要一律只依据 summary，不读句子/分镜/原文）
    - `number` / `title` / `function` / `mainlineProgress` / `stats` / `suspense`（结构化字段，供章节表/统计/悬念聚合）
    - **不读**：句子标注、分镜标注、语料原文（旧章一律不重读这些文件）
  - **旧聚合文件不作为读取依据**：`章节/章节表.json` / `大事件/event.json` / `卷纲/volume.json` 是**待整体重写的对象**，其旧内容不参与重算输入（防止旧聚合污染新判定）

- **往返1 交付（只输出句子 JSON，完整内容）**：
  - `句子标注/json/第XXXX章.json`（唯一文件；已有章文件一律不重写）
  - 不输出分镜/章节/聚合/语料分章文件
- **往返2 交付（只输出分镜 + 章节标注，完整内容）**：
  - `分镜标注/json/第XXXX章.json` + `章节/第XXXX章.json`
  - 不输出句子/聚合/语料分章文件

- **交付格式**：你的输出是一个 JSON 对象——键 = project 内相对路径（用 "/"），值 = 该文件完整内容。宿主会按路径写入 `store/<语料名>project/`。**只输出这个 JSON**，不要任何其他内容

- **保持项目结构**：输出必须严格遵循【输出（project 文件夹）】定义的目录结构——新增文件落位于对应子目录，路径命名与已有文件一致（如 `句子标注/json/第0002章.json`）；不得改变已有目录层级、不得引入结构外的新路径

## 使用说明

- **输入**：`corpus/<语料名>-语料.txt`
- **输出**：`store/<语料名>project/`
- **规范依据**：本文档【格式契约】为唯一标注依据（枚举/字段/判据已内嵌，不依赖外部文件）
- **执行**：你是最终执行者，按工作流程完成**本次往返**的交付（往返1 = 句子；往返2 = 分镜+章节），不输出本次往返范围外的文件
- **聚合层**：见【聚合层】章节——由宿主在全部章落盘后统一执行（确定性重算 + 两次语义调用），单章往返不涉及
- **增量**：见【增量更新】章节——检查项目现状，只处理未标注章，输出 {路径: 内容} 交付
