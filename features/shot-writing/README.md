# shot-writing · 分镜参考写作（L4 功能）

**定位**：给定分镜写作意图 → 从已标注项目召回**参考分镜**（三通道）→ 生成/润色分镜文本。消费 L2（store 数据）+ L3（retriever 三通道），是功能层对"写作工作流"的承载。

## 会话机制（每次写作任务 = 一个会话）

```
NovelyWrite/
├── features/shot-writing/sessions/<session-id>/   # 会话目录（功能层内，留痕）
│   ├── input.txt            # 用户原始输入
│   ├── shots.json           # preprocess 输出（结构化分镜序列）
│   ├── <session-id>.draft.txt  # 写作产出（会话内留痕）
│   └── meta.json            # 会话元信息（时间/概括/模型/统计）
│
└── output/<session-id>.draft.txt   # ★ 用户可读文件（与 features 同级，NovelyWrite/output/）
```

**session-id 命名**：`YYYYMMDD-HHmmss-<LLM概括>`（如 `20260818-103000-打脸反转`）——时间戳 + LLM 对输入生成的 2-6 字概括。

**产出流转**：写作环节生成会话内 `draft.txt` 时，**复制一份到 `NovelyWrite/output/`**（用户可读文件，与 features 同级；不落 store）。

## 业务流

```
用户输入（任意）
  ↓ ① preprocess（LLM）：输入 → 结构化分镜序列 + 概括 → 会话目录（input/shots/meta）
  ↓ ② 召回：逐镜 retriever.retrieve({text,type,funcs}, {project,topk}) 三通道
  ↓ ③ 回源：hits → join 句子文本 → 参考上下文
  ↓ ④ 写作（LLM）：意图 + 参考 → 分镜文本 → 会话内 draft.txt → 复制 output/
```

## 分镜序列格式（preprocess 输出，标准中间格式）

```json
{
  "summary": "打脸反转",
  "shots": [
    { "seq": 1, "type": "对话", "funcs": ["推进", "塑造人物"], "label": "…", "content": "…" },
    { "seq": 2, "type": "动作", "funcs": ["爆发", "反转"], "label": "…", "content": "…" }
  ]
}
```

**content 原则**：尽可能从用户输入切出；仅输入过于简略时由 LLM 补充衔接与细节。

## 输入输出

| | 内容 |
|---|---|
| **输入** | 用户任意输入（自然语言描述剧情/分镜需求）|
| **输出** | 会话目录（input/shots/meta）+ 后续 draft → NovelyWrite/output/ |

## 依赖

- **L3 检索器**：`retriever/retriever.mjs`（统一入口 retrieve()，三通道）
- **L2 数据**：`store/<project>/` 的句子/分镜 JSON（回源文本）
- **LLM**：`shared/llm.mjs` / 自带 chatStream（config.json chat 段）
- **写作规范**：（可挂接章节写作 SKILL）

## 文件

- `preprocess.mjs`：用户输入 → 结构化分镜序列 + 会话落盘（第一步）
- （规划）`recall.mjs` / `writedraft.mjs`：召回 / 写作

## 待办 / 规划

- [x] 会话目录 + output 目录机制（设计）
- [ ] preprocess.mjs 实现（输入 → 分镜序列 + 会话落盘）
- [ ] recall.mjs（逐镜三通道召回）
- [ ] writedraft.mjs（参考 + 意图 → 逐镜 draft → 整合 final）
- [ ] embed key 配置后启用 vec 通道
