# NovelyWrite

AI 辅助小说拆解与分镜参考写作工具链：把小说原文解析为结构化标注（卷纲 / 大事件 / 章节 / 分镜 / 句子），构建可检索的知识库，并为「给定意图 → 生成分镜文本」提供三通道参考召回。

> 纯 Node.js 实现（>= 18），无第三方运行时依赖，克隆即用。

## 功能

- **建库（kb）**：扫描 `corpus/` 语料与 `store/` 头文档对比，报告未建库项目
- **标注（annotate）**：语料 → 卷纲 / 大事件 / 章节表 / 分镜 / 句子 结构化标注（两往返 + 硬闸门）
- **聚合（aggregate）**：标注 → 派生数据（词典 / 向量索引等），默认增量、`--full` 全量逃生门
- **校验（check）**：JSON 结构 / 章节一致性 / 聚合收尾检查
- **修复（fix）**：章级修复、聚合层修复（`--dry-run` 预览）
- **检索（retriever）**：三通道召回——label（结构）/ token（词重叠）/ vec（embedding 语义）
- **分镜参考写作（shot-writing，功能层）**：输入意图 → 结构化分镜序列 → 三通道召回参考 → LLM 写作
- **自然语言入口**：`node cli.mjs "把红楼梦建立知识库"` 这类指令可被意图识别路由到对应任务

## 架构（四层）

| 层 | 目录 | 职责 |
|---|---|---|
| L1 语料处理 | `novelread/` | 原文解析 → 标注产出（两往返 + 硬闸门） |
| L2 数据访问 | `store/` | JSON 数据 + `project-meta.json`（头文档） |
| L3 检索器 | `retriever/` | 三通道召回（label / token / vec） |
| L4 功能层 | `features/` | 消费 L2/L3 做业务（拆书报告 / 分镜写作） |

## 目录结构

```
NovelyWrite/
├── cli.mjs                 # 统一 CLI 入口（显式命令 + 自然语言意图）
├── config.json             # 本地配置（不入库，见「配置」节创建）
├── novelread/              # L1 语料处理（标注 / 聚合 / 校验 / 修复）
│   ├── specs/              # 标注规范（卷纲 / 大事件 / 章节 / 分镜 / 句子）
│   └── state/              # 运行时原始文本分章（不提交）
├── retriever/              # L3 三通道检索器
├── features/               # L4 功能层
│   ├── report/             # 拆书报告（规划中）
│   └── shot-writing/       # 分镜参考写作（会话机制 + 写作）
├── shared/                 # 公共模块（路径 / 配置 / LLM / embedding / SKILL 切片）
├── corpus/                 # 用户语料（自备，不提交）
├── store/                  # 标注数据 / 派生索引（运行时生成，不提交）
└── output/                 # 写作产物 / 报告（运行时生成，不提交）
```

## 快速开始

### 1. 环境要求

- Node.js >= 18（内置 `fetch`）

### 2. 配置

创建 `config.json`（被 `.gitignore` 排除，不入库），按以下结构填写，apiKey 可留空、运行时用环境变量注入：

```json
{
  "chat": {
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKey": "",
    "model": "deepseek-v4-flash",
    "temperature": 0.8,
    "maxTokens": 2000,
    "timeoutMs": 300000,
    "maxRetries": 3
  },
  "embed": {
    "baseUrl": "https://api.siliconflow.cn/v1",
    "apiKey": "",
    "model": "BAAI/bge-large-zh-v1.5",
    "dimension": 1024,
    "batchSize": 32,
    "timeoutMs": 30000,
    "maxRetries": 3
  }
}
```

`config.json` 含两段：

- `chat`：对话 LLM（默认 DeepSeek，`https://api.deepseek.com/v1`）
- `embed`：embedding（默认 SiliconFlow，`BAAI/bge-large-zh-v1.5`）

**API key 优先走环境变量**（安全，config.json 可留空）：

| 环境变量 | 作用 |
|---|---|
| `NOVELYWRITE_HOME` | 数据根目录（config / corpus / store 所在），默认=代码根 |
| `NOVELYWRITE_CHAT_API_KEY` | 覆盖 `chat.apiKey` |
| `NOVELYWRITE_EMBED_API_KEY` | 覆盖 `embed.apiKey` |
| `NOVELYWRITE_CHAT_BASE_URL` | 覆盖 `chat.baseUrl` |
| `NOVELYWRITE_EMBED_BASE_URL` | 覆盖 `embed.baseUrl` |

> 前缀统一用 `NOVELYWRITE_*`（不用 `DSH_*`，避免与 harness 环境冲突）。

### 3. 使用

显式命令：

```bash
node cli.mjs kb                 # 扫描语料，查看建库状态
node cli.mjs annotate <语料名>  # 标注（两往返 + 硬闸门）
node cli.mjs aggregate <语料名> # 聚合派生数据
node cli.mjs check              # 校验
node cli.mjs fix <语料名> <章号> # 修复
```

自然语言指令（意图识别）：

```bash
node cli.mjs "把红楼梦建立知识库"
node cli.mjs "标注 大王饶命 第三章"
node cli.mjs "聚合一下"
node cli.mjs "校验"
```

### 4. 数据布局

- **代码根（CODE_ROOT）**：包内只读（`novelread/ retriever/ shared/ features/`）
- **数据根（DATA_ROOT）**：外部可写，含 `config.json / corpus / store`；由 `NOVELYWRITE_HOME` 指定，默认=代码根

## 写作流程（shot-writing）

```
用户输入（任意）
  ↓ ① preprocess：输入 → 结构化分镜序列 + 会话落盘（sessions/<session-id>/）
  ↓ ② 召回：逐镜 retriever.retrieve() 三通道（label / token / vec）
  ↓ ③ 回源：hits → 句子文本 → 参考上下文
  ↓ ④ 写作：意图 + 参考 → 分镜文本 → draft → 复制到 output/
```

产出：

- 会话存档：`features/shot-writing/sessions/<session-id>/`
- 用户可读稿：`output/<session-id>.draft.txt`（写作产物，不落 store）

## 文档

- `打包分发指南.md`：代码根 / 数据根分离、环境变量注入、分发部署说明
- `features/README.md`：功能层（L4）设计
- `retriever/README.md`：三通道检索器（L3）设计
- `features/shot-writing/README.md`：分镜参考写作
- `novelread/specs/`：标注规范（卷纲 / 大事件 / 章节表 / 分镜 / 句子）

## License

暂未指定 —— 发布前请选择开源协议并添加 `LICENSE` 文件。
