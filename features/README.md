# features · 功能层（L4）

**职责**：消费 L2（store 数据）+ L3（retriever 检索）做业务，**只读实施层，不写 store**——功能层产物（报告/生成稿/分析结果）另行输出，不落入标注数据。

## 架构位置

```
L1 语料处理（novelread/）   → 产出标注（两往返 + 硬闸门）
L2 数据访问（store/）       → JSON + project-meta.json（头文档）
L3 检索器（retriever/）     → 三通道召回（label/token/vec）
L4 功能层（features/） ★    → 消费 L2/L3 做业务
```

## 功能层原则

1. **只读实施层**：读 `store/<project>/` 的 JSON + project-meta；不写标注文件（写 = 标注层的事）
2. **入口先读 project-meta**：任何功能先读头文档（进度/缺章/质量状态），据此决定能做什么
3. **复用 L3 检索**：需要"找参考"时走 `retriever/`（三通道），不自己碰向量库/词典
4. **产物不落 store**：报告/生成稿输出到消费端（如 output/ 或直接打印）

## 目录规划

```
features/
├── README.md              # 本文件
├── report/                # 拆书报告（读 store → 人类可读报告）
├── shot-writing/          # ★ 分镜参考写作（章纲 → 分镜，消费 L3 三通道召回）
└── （规划）rewrite/       # 生成稿按 SKILL 重写
    （规划）analysis/      # 一致性检查 / 爽点定位 / 节奏诊断
```

## 拆书报告（report/）

**定位**：消费 `store/<project>/` 的 JSON → 人类可读报告（**不落 store**，输出到消费端）。

**输入**：project-meta.json（进度/质量）+ 章节表/章节标注（summary）+ event.json（lifecycle/mainline）+ 卷纲.json（eventStructure）+ 分镜标注（funcs 扫悬念/爆发）

**报告内容（建议）**：
- 项目概览（进度/缺章/质量状态，来自 project-meta）
- 主线（event.json mainline + 章节表 mainlineProgress）
- 事件线（event.json lifecycle：开始/持续/结束/悬置）
- 章节摘要（章节表 chapters[].summary）
- 爽点/悬念定位（扫分镜 funcs=爆发/悬念，按章/按镜）
- 卷纲（卷纲.json eventStructure：事件 → 涉及章节）

**实现形态**：脚本渲染（确定性，结构化数据直接组织）——可选 LLM 叙事化（后续）。

## 与其他模块的关系

| 调用方 | 被调用 | 方式 |
|---|---|---|
| features/report | store/<project>/*.json | import/读文件 |
| features/report | store/<project>/project-meta.json | 读头文档 |
| features/shot-writing | retriever/retriever.mjs | import（三通道召回） |
| features/shot-writing | store/<project>/句子·分镜 JSON | 回源参考文本 |
| features/rewrite（规划） | specs/章节写作-SKILL.md | 读规范 |

## 待办 / 规划

- [ ] report/ 拆书报告实现（读 store → 报告）
- [ ] shot-writing/ 分镜参考写作实现（意图 → 三通道召回 → LLM 写分镜）
- [ ] rewrite：生成稿按 SKILL 重写
- [ ] analysis：一致性检查 / 爽点定位 / 节奏诊断
