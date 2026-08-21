# NovelyWrite

AI 辅助小说写作工具链：把小说原文解析为结构化标注（卷纲 / 大事件 / 章节 / 分镜 / 句子），构建可检索知识库，并在写作工作台中为「剧情需求 → 分镜 → 成稿」提供三通道参考召回与逐镜写作。

> 纯 Node.js（>= 18）零第三方运行时依赖；可打包为**单文件 exe**（官方 node:sea），双击即用。

## 功能

- **建库（annotate）**：语料 → 句子 / 分镜 / 章节 结构化标注（两往返 + 硬闸门 + 派生字段），支持 `--all` 全量 / `--chapter=N` 单章 / `--from=N --to=M` 续建范围（不鼓励全量：一次开销大，推荐每次 ≤30 章）
- **导入参考书 / 对我的书建库**：Web 界面——上传 txt 建外部书，或点书旁「建库标注」把 mybook 原稿自动合成语料建自己的书（均自动分章清单 → 选续建终点：默认从已建库最后一章起续 30 章；0=全量⚠ / p=补建缺章）→ 自动建库（标注 → 向量 → **自动补跑增量聚合**，一条链全自动）
- **聚合（aggregate）**：标注 → 大事件 / 卷纲 / 章节表 / 头文档（默认增量，`--full` 全量）；**annotate 批末自动触发**——本批有成功章即自动增量聚合（失败章不占名额，补跑成功后下次自动聚合），聚合失败仅警告不阻塞建库
- **校验（check）/ 修复（fix）**：JSON 语法 / 契约一致性 / 章级与聚合层修复
- **检索（retriever）**：三通道召回——label（结构）/ token（词重叠）/ vec（embedding 语义），跨书参考可勾选限定书源
- **写作工作台（Web）**：书 / 章节管理（mybook 原稿持久化）、AI 写作全流程（分镜 → 召回 → 逐镜写作 → 整合成稿）、成稿直显 + 一键插入写作栏、参考书池、模型选择器（从 API 读可用模型）、API Key 设置、定时自动保存、可拖拽分栏、**浮动任务栏**（右下角全局轮询任务进度/报错：建库章进度条、失败标红驻留、可停止/最小化）
- **单文件 exe**：rollup bundle + 官方 node:sea + postject 打包，双击启动并自动打开浏览器

## 架构（四层）

| 层 | 目录 | 职责 |
|---|---|---|
| L1 语料处理 | `novelread/` | 原文解析 → 标注产出（两往返 + 硬闸门） |
| L2 数据访问 | `store/` | JSON 数据 + `project-meta.json`，域化（myproject/exproject） |
| L3 检索器 | `retriever/` | 三通道召回（label / token / vec） |
| L4 功能层 | `features/` | 消费 L2/L3 做业务（分镜写作） |

## 目录结构

```
NovelyWrite/
├── cli.mjs                 # 统一 CLI 入口
├── server.mjs              # Web 服务入口（node:http 内置，零依赖）
├── webview/                # 前端（index.html / app.js / style.css / vendor/vditor）
├── novelread/              # L1 语料处理（标注 / 聚合 / 校验 / 修复 / 章节清单）
├── retriever/              # L3 三通道检索器
├── features/               # L4 功能层
│   └── shot-writing/       # 分镜写作（preprocess / recall / writedraft）
├── shared/                 # 公共模块（路径 / 配置 / LLM / 错误 / 任务）
├── build/                  # 打包（sea-main 入口 / sea-config / build-sea 构建脚本）
├── dist/                   # 打包产物（NovelyWrite.exe，不入库）
├── config.json             # 本地配置（不入库，含 chat/embed/features 段）
├── corpus/                 # 用户语料（自备，不提交）
├── store/                  # 标注数据 / 派生索引（myproject / exproject，不提交）
├── mybook/                 # 用户原稿（书/章节实时保存，不提交）
├── sessions/               # 写作会话（数据根下，不提交）
└── output/                 # 成稿 / 报告（按会话归档 output/<sessionId>/，不提交）
```

## 快速开始

### 方式一：单文件 exe（推荐，无需安装 Node）

1. 从 Release 下载 `NovelyWrite.exe`，放入任意文件夹（如 `D:\NovelyWrite\`）
2. **双击 exe** → 自动启动服务并打开浏览器工作台
3. 数据（config/corpus/store/mybook/output/sessions）自动生成在 **exe 旁**；整文件夹拷走即迁移，更新只换 exe

### 方式二：源码运行

**环境要求**：Node.js >= 18（内置 `fetch`）

```bash
node server.mjs --port=3081 --open   # 启动工作台并自动打开浏览器
# 或命令行建库：
node cli.mjs annotate <语料名> --all   # 全量标注（语料放 corpus/<名>-语料.txt）
```

### 配置

启动后点右上角 **⚙ 设置**：

- **API Key**：对话（chat）与向量（embed）分开填写；未配置时模型选择器会提示
- **模型选择器**：写作模型 / 建库模型 / 向量模型——选项**从 API 实时读取**（DeepSeek / SiliconFlow 的 /models 接口）
- **自动保存**：关闭 / 1 / 5（默认）/ 10 / 30 分钟 / 自定义

也可直接编辑 `config.json`（不入库），apiKey 可留空、用环境变量注入：

```json
{
  "chat": { "baseUrl": "https://api.deepseek.com/v1", "apiKey": "", "model": "deepseek-v4-flash", "temperature": 0.8 },
  "embed": { "baseUrl": "https://api.siliconflow.cn/v1", "apiKey": "", "model": "BAAI/bge-large-zh-v1.5" },
  "features": { "shot-writing": { "chat": { "model": "deepseek-v4-pro", "shotLen": 200 } } }
}
```

**环境变量**（优先级高于 config.json）：

| 变量 | 作用 |
|---|---|
| `NOVELYWRITE_HOME` | 数据根目录（config/corpus/store/sessions/output 所在），默认=代码根或 exe 旁 |
| `NOVELYWRITE_CHAT_API_KEY` / `NOVELYWRITE_EMBED_API_KEY` | 注入 API key（config 可留空） |
| `NOVELYWRITE_CHAT_MODEL` / `NOVELYWRITE_CHAT_BASE_URL` | 覆盖 chat 模型 / 地址 |

## 写作流程（Web 工作台）

```
输入剧情需求 → ✨ AI 写作
  ↓ ① preprocess：输入 → 结构化分镜序列（会话落盘 sessions/<session-id>/）
  ↓ ② recall：逐镜三通道召回（参考书池勾选 = 限定书源；不选 = 全库）
  ↓ ③ 逐镜写作：前后镜上下文 + 时空映射参考（学写法不抄内容）+ 动态字数 + 温度随机 + 双防幻觉
  ↓ ④ 全文整合：LLM 逐字保留拼接 + 脚本对话修复（去掉分镜标签）
  ↓ AI 成稿（纯正文）直显 → 点「插入到写作栏」进编辑器（保留排版）→ 自动保存
```

产出归档：

- 会话：`sessions/<session-id>/`（input / shots / recalls / draft）
- 成稿：`output/<session-id>/<项目名>.final.txt`（按会话归档，互不覆盖）

## 打包（单文件 exe）

```bash
node build/build-sea.mjs
# 产物：dist/NovelyWrite.exe（约 88MB，双击即用）
```

原理：rollup 把 ESM 项目 bundle 成 CJS 单文件（官方 node:sea 要求 CJS 入口）→ `--experimental-sea-config` 生成 blob（内嵌 webview/SKILL 资源）→ postject 注入 node.exe。

## 文档

- `打包分发指南.md`：代码根 / 数据根分离、环境变量注入、分发部署
- `features/shot-writing/README.md`：分镜写作设计（时空映射 / 防幻觉 / 整合）
- `retriever/README.md`：三通道检索器
- `novelread/specs/`：标注规范（句子 / 分镜 / 章节 / 大事件 / 卷纲）

## 交流

- QQ 交流群：**1106526576**

## License

[MIT](LICENSE) © witch997
