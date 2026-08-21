# shot-writing · 分镜参考写作（L4 功能）

**定位**：给定分镜写作意图 → 结构化分镜序列 → 三通道召回参考 → 逐镜写作 + 全文整合 → 成稿。消费 L2（store 数据）+ L3（retriever 三通道），是功能层对"写作工作流"的承载。

## 业务流

```
用户输入（任意）
  ↓ ① preprocess.mjs（LLM）：输入 → 结构化分镜序列 + 概括 → 会话目录
  ↓ ② recall.mjs（零 LLM）：逐镜 retriever.retrieve() 三通道召回参考 → recalls.json
  ↓ ③ writedraft.mjs（LLM）：逐镜写作 + 全文整合 → draft → output/<项目>.final.txt
```

## 会话机制（每次写作任务 = 一个会话）

```
features/shot-writing/sessions/<session-id>/
├── input.txt       # 用户原始输入
├── shots.json      # preprocess 输出（结构化分镜序列）
├── recalls.json    # recall 输出（每镜 + refs 参考）
├── <项目>draft.txt # 写作中间产物（带分镜标签）
└── meta.json       # 会话元信息

output/<项目>.final.txt   # 用户成稿（纯正文）
```

**session-id 命名**：`YYYYMMDD-HHmmss-<LLM概括>`（如 `20260818-103000-打脸反转`）。

## 分镜序列格式（preprocess 输出）

```json
{
  "summary": "打脸反转",
  "shots": [
    { "seq": 1, "type": "对话", "funcs": ["推进", "塑造人物"], "label": "…", "content": "…" }
  ]
}
```

**分块切分**：若用户输入已按内容分块（空行/标记分隔），preprocess 按用户分块切分（每块一镜）；否则 LLM 按叙事动作自由切。

## writedraft 写作逻辑（当前实现）

### 逐镜写作（每镜一次 LLM）

- **前后镜上下文**：注入前一分镜/后一分镜内容，本镜写作与之衔接
- **时空映射参考定位**：参考被定义为"本镜内容在不同时空的映射"——学其写法（句式/口吻/节奏），不引用其内容（强制唤醒参考）
- **动态字数**：由配置 `shotLen` 决定（默认 200，`--shot-len` 可覆盖）
- **温度随机**：0.6-1.3（参考文本哈希提炼，确定性可复现）
- **双防幻觉**：不编造未指定的台词/称号/设定

### 全文整合（一次 LLM）

- 最小幅度改写、去重、时间线、对话连贯、防幻觉台词、防设定幻觉、节奏错落

### 脚本修复（零 LLM）

- **对话修复**：拆句合并 / 逗号改冒号 / 无标点补冒号 / 多余冒号（确定性正则，默认开，`--no-fix-dialogue` 关闭）

### 测试模式

- `--test-mode`：跳过整合，逐镜直接拼接（调试逐镜质量）
- `--profile`：开启风格指纹提炼（默认关；跨书/风格混杂场景用）

## 配置

写作模型与参数在 **根 config.json 的 `features.shot-writing.chat`**（模块作用域）：

```json
{
  "chat": { "model": "deepseek-v4-flash", "temperature": 0.8 },
  "features": {
    "shot-writing": {
      "chat": { "model": "deepseek-v4-pro", "temperature": 0.8, "shotLen": 200 }
    }
  }
}
```

- **读取优先级**：环境变量 `NOVELYWRITE_CHAT_MODEL` > 根 config 的 features 段 > 根 config 的 chat 段 > 默认值
- **shotLen**：每镜字数目标（数字=约N字 / [min,max]=N-M字 / `--shot-len` 命令行覆盖）

## 文件

- `preprocess.mjs`：输入 → 分镜序列 + 会话落盘
- `recall.mjs`：逐镜三通道召回（零 LLM）
- `writedraft.mjs`：逐镜写作 + 全文整合 + 对话修复
- `README.md`：本文件

## 已知边界

- 参考召回在"同书同实体/同场景"时有效；跨书且无相关性时，LLM 可能忽略参考（"唤醒门控"）
- 生成稿是"工整的 AI 文本"——定位为扩写辅助，人味/毛边需人工注入
