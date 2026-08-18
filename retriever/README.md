# retriever · 检索器（L3）

**职责**：统一检索入口 `retrieve()`，三通道召回（label / token / vec）——给写作/报告等消费方提供「参考分镜」。

## 架构位置

```
L1 语料处理（novelread/）   → 产出标注（两往返 + 硬闸门）
L2 数据访问（store/）       → JSON + project-meta.json（头文档）
L3 检索器（retriever/） ★  → 三通道召回（label/token/vec）
L4 功能层（features/）      → 消费 L2/L3 做业务
```

## 三通道定位

| 通道 | 相似度 | 数据源 | 成本 | 定位 |
|---|---|---|---|---|
| label | 结构（type/funcs） | 分镜 type/funcs | 零 | **跨书噪声源**（同类参考，多样性） |
| token | 字面（词重叠） | 分镜 label/正文（词典切词） | 零 | 情境/内容相近参考（素材供给） |
| vec | 语义（embedding） | 分镜向量（预构建） | API | 语义相近（词面无关） |

## 统一入口（retriever.mjs）

```js
const { hits, contextBlock, warnings } = await retrieve(
  { text, type, funcs, label },            // 查询意图
  { projects, quota: {label, token, vec}, buildContext }  // 参数
);
// hits[]: {shot, score?, source:"label"|"token"|"vec"}
```

- **quota** 默认 `{label:2, token:2, vec:2}`（各通道配额）
- **去重**：同 project+chapter+shotId 只留一条
- **contextBlock**：hits → LLM 可读参考块（无 source 标记，降 prompt 长度）
- **warnings**：向量通道降级信号（embed 未配置时）

### 方向 C（构建/查询分离）
`retrieve()` **不触发索引构建**（`ensure` 默认关闭）——索引/词典由建库流程显式执行（`build-derived.mjs` / `aggregates.mjs` 收尾）。查询只读现有派生数据。

## 词典建库（buildDict，PMI 版）

```
输入：分镜 label + 句子 text
  ↓
label 词集（主源）：label 整体入词（2-8 字、非停用词）→ 浓缩短语
PMI 真词（次源）：统计相邻两字互信息 → PMI 切词器从句子提真词（频次≥3）
  ↓
entity-dict.json（label 词 + PMI 真词，无滑窗碎片）
```

- **治 2-gram 污染**：PMI 判定真词（黛玉 7.4 / 碎片玉借≈0），碎片不入词典
- **性能**：20 万镜 ~1 分钟建库（一次性）；bigram 表 ~350MB（建库进程）

### 词典更新触发（B 方案）
- `aggregates.mjs` 收尾走 `ensureDerived()` **对比**：`scanSourceState()` 扫 分镜+句子 双 mtime（`mtime1|mtime2`），源没变 → 跳过重建（省 20 万规模重建成本）
- 手动：`node retriever/build-derived.mjs --dict`（无条件重建）

## 切词（tokenize，纯词典最大匹配）

```
词典正向最大匹配（最长优先）+ 首字索引（字 → 候选词列表）
  → O(正文长 × 候选数)，非 O(正文长 × 词典长)
  → 实测 54ms/1143 镜（线性遍历 6569ms，快 120 倍）
无 2-gram 兜底（避免碎片 树识/破黑/会傍）
```

## token 通道（tokenRecall，词重叠 + 素材供给）

```
查询词典切词 → 与每个分镜的 label 词/正文词求交集（词重叠）→ 命中
  label 包含匹配兜底：庙会 ⊆ 庙会傍晚（覆盖子词）
  ↓
素材供给（软排序）：命中次数最高的 1 条作代表（确定性），
  剩余 topk-1 条从其余命中随机取（多样性）
  ——不全局评分排序，LLM 自行取舍
```

**已移除**：LCS（字符模糊）、2-gram、分层（label/原文层）、打分（全局排序）——当前为扁平词重叠 + 素材供给。

## 向量通道（vectorRecall，语义召回）

### 建库（buildVectors，存量更新机制 ★）

```
输入：分镜（scanAllShots）
  ↓
每镜文本 = shotToText（句子拼正文，≤500 字截断）
  ↓
embedTexts（shared/embed.mjs）：
  分批（batchSize 32）+ 批内自适应拆分（413/414/429 → 拆半重试）+ 批间 sleep(50ms)
  ↓
向量文件：store/派生/向量/{project}-第XXXX章.json
index.json：embedVersion + 每章 {project,chapter,file,shotCount,sourceMtime,lastEmbedded}
  ↓
原子切换（tmp + rename，防半写索引）
```

**存量更新（增量）**：
```
for 每个 {project, chapter}：
  key = "project:chapter"
  shotMtime = 分镜文件 mtime
  已有记录 且 sourceMtime === shotMtime → skipped（未变章零成本跳过）
  否则 → 重新嵌入该章 → 更新 index
模型变更 / --reset → 全量重建
```

- **触发**：`aggregates.mjs` 收尾自动调 `buildVectors({projects})`；手动 `--vector`
- **增量粒度**：章级（每章一个向量文件 + index 条目）
- **正常流程完整性**：重标一章 = 句子+分镜一起重写 → 分镜 mtime 变 → 该章向量重建（存量更新覆盖主流程）

### 召回（vectorRecall）
```
查询文本（label 优先）→ embedOneCached（同文本缓存 500 条）
  → 与全部分镜向量余弦 → 排序 → topk
  → 未配置/未构建/失败 → 降级（信号进 warnings，不阻塞其他通道）
```

### 性能
- 查询：全量余弦 O(N×1024)——20 万 ≈ 2-3s（比切词实时扫描快，但非 ANN）
- 建库：按章增量（只嵌入变章）

## 性能预算（实测外推）

| 规模 | 建库 | 查询/次 |
|---|---|---|
| 当前 3393 镜 | 词典 秒级 / 向量按需 | token ~82ms 端到端 |
| 10 万镜 | 词典 ~9s / 向量按章 | token ~7s |
| 20 万镜 | 词典 ~1min / 向量按章 | token ~14s（方案 A：实时扫描，可接受） |

## 文件清单

| 文件 | 职责 |
|---|---|
| retriever.mjs | 统一入口 retrieve()（三通道合并/去重/上下文） |
| lexical.mjs | 词典加载（首字索引）+ 切词 + labelRecall + tokenRecall |
| build-derived.mjs | 词典建库（PMI）+ 四表（预备）+ 向量构建（存量更新） |
| derived-state.mjs | 源状态扫描（分镜+句子双 mtime）+ 重建对比 |
| ensure-derived.mjs | 调用前对比 + 按需重建词典 |
| vector.mjs | 向量召回（余弦 topk + 降级） |
| embed.mjs | embed 配置读取 + 就绪检测 |
| rag-core.mjs | 路径/句子回源/余弦/去重/上下文块 |
