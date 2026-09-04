# features · 功能层（L4）

**职责**：消费 L2（store 数据）+ L3（retriever 检索）做业务，**只读实施层，不写 store**——功能层产物（报告/生成稿/分析结果）另行输出，不落入标注数据。

## 架构位置

```
L1 语料处理（novelread/）   → 产出标注（两往返 + 硬闸门）+ 确定性聚合（清单/缺章/终检/头文档）
L2 数据访问（store/）       → JSON + project-meta.json（头文档）
L3 检索器（retriever/）     → 三通道召回（label/token/vec）
L4 功能层（features/） ★    → 消费 L2/L3 做业务
```

## 功能层原则

1. **只读实施层**：读 `store/<project>/` 的 JSON + project-meta；不写标注文件（写 = 标注层的事）
2. **入口先读 project-meta**：任何功能先读头文档（进度/缺章/质量状态），据此决定能做什么
3. **复用 L3 检索**：需要"找参考"时走 `retriever/`（三通道），不自己碰向量库/词典
4. **产物不落 store**：报告/生成稿输出到消费端（如 output/ 或直接打印）

## 目录结构

```
features/
├── README.md              # 本文件
├── report/                # ★ 拆书报告（读 store → 人类可读看板 / 拆书地图 / 问答）
│   ├── report.mjs         # buildReport：统计卡 + 全书梗概 + 章节树下钻（拆书看板 HTML）
│   ├── chapter-tree.mjs   # 章节树索引（元数据节点 + 单章指纹增量重建，拆书时自动构建）
│   ├── ask.mjs            # 拆书问答（retriever 程序粗筛 + LLM 精筛）
│   └── demo.mjs           # 章节树 Demo 路由
└── shot-writing/          # ★ 分镜参考写作（剧情需求 → 分镜 → 成稿，消费 L3 三通道召回）
    ├── preprocess.mjs     # 剧情需求 → 结构化分镜序列（章纲）
    ├── recall.mjs         # 逐镜三通道召回参考（限定书源 / 全库）
    ├── writedraft.mjs     # 逐镜写作 + 全文整合成稿
    └── style-stats.mjs    # 文风统计
```

## 拆书报告（report/）

**定位**：消费 `store/<project>/` 的 JSON → 人类可读报告（**不落 store**，输出到消费端；server 暴露 `/api/report/:name`，前端拆书按钮开新窗口渲染）。

**输入（2026-09-04 更新——章节表/大事件/卷纲语义已移除，不再读取该类产物）**：
- project-meta.json（进度/缺章/质量状态）
- 章节树索引（chapter-tree：章节元数据 + 单章指纹）
- 章节标注 `summary`（跨章语义搜证的唯一权威输入——梗概 LLM 只吃 summary + 前 N 章摘要）
- 分镜标注 funcs（扫悬念/爆发，统计与章节树组装）

**报告内容**：
- 统计卡：章节数 / 分镜数 / 句子数（数据来自章节树聚合）
- 全书梗概：LLM 联网搜证定位作品 + 前 N 章 summary 综合直出（DeepSeek web_search；剧情只用摘要、禁全书剧情；指纹缓存——summary 变更才重调）
- 章节树下钻：章节 → 分镜 → 句子三层浏览；章节带 summary 预览
- 拆书问答（ask）：按章节范围/分镜层级程序粗筛 + LLM 精筛回答

**实现形态**：纯程序投影（章节树/统计）+ 可选 LLM 化（梗概 buildSynopsis / 问答 refine，均带超时与指纹缓存）。

## 分镜参考写作（shot-writing/）

**定位**：输入剧情需求 → 结构化分镜序列 → 逐镜三通道召回（retriever）→ 逐镜写作 → 全文整合成稿。
- **参考书即风格选择器**：参考文本作「风格样例」注入（句式/口吻/修辞向参考靠拢，内容与专名不照搬）；勾选限定书源，不选 = 全库
- 排版硬规范（短段/对话独占成段）不受风格跟随影响
- 产出按会话归档，成稿直显可一键插入写作栏（详见 `shot-writing/README.md`）

## 与其他模块的关系

| 调用方 | 被调用 | 方式 |
|---|---|---|
| features/report | store/<project>/*.json（章节树/章节标注/分镜标注） | import/读文件 |
| features/report | store/<project>/project-meta.json | 读头文档 |
| features/shot-writing | retriever/retriever.mjs | import（三通道召回） |
| features/shot-writing | store/<project>/句子·分镜 JSON | 回源参考文本 |
| server.mjs | features/report（buildReport / buildChapterTree） | import + 路由 |

## 待办 / 规划

- [x] report/ 拆书报告实现（看板/拆书地图/章节树/问答）
- [x] shot-writing/ 分镜参考写作实现（preprocess → recall → writedraft）
- [ ] rewrite：生成稿按 SKILL 重写
- [ ] analysis：一致性检查 / 爽点定位 / 节奏诊断
