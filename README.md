# NovelyWrite

AI 辅助小说写作工具链：把小说原文拆成可检索的结构化知识库，并在写作工作台中为「剧情需求 → 分镜 → 成稿」提供参考书风格召回与逐镜写作。

当前开发主线：
`拆书建库（语料 → 结构化标注）→ 三通道参考召回 → 参考书风格跟随写作 → 自动聚合/向量/头文档`

**技术标签**：Node ≥ 18 ｜ 零第三方运行时依赖 ｜ node:http 内置 Web ｜ **Tauri 桌面版 + SEA 单文件 exe（Windows）** ｜ .app 包（macOS，CI 自动构建）｜ 三通道 RAG（label / token / vec）

## ✨ 项目简介

这是一个**面向网文写作的本地优先 AI 工作台**，不是"你写一句、AI 补一句"的聊天壳子。

它的核心做法是：

- 👉 把一本已有小说（或自己的原稿）**拆成句子 / 分镜 / 章节 / 大事件 / 卷纲**的结构化知识库，而不是只留一段摘要
- 👉 写作时按**三通道召回**（结构 label / 词重叠 token / 语义向量 vec）从知识库取参考，**勾选参考书 = 限定书源**，不选 = 全库
- 👉 **参考书即风格选择器**：勾《红楼梦》成稿出红楼笔法，勾起点文出网文节奏——学参考的写法，不抄参考的内容
- 👉 建库 / 向量 / 聚合 / 头文档**一条链全自动**，失败章自动补建、任务失败一键智能续跑
- 👉 纯 Node 零运行时依赖，**打包单文件 exe 双击即用**，数据全在本地

适合**写网文想参考名作文风的人**，也适合研究「拆书 → 知识库 → 检索增强写作」链路和零依赖本地应用的开发者参考。

## 项目定位

很多 AI 写作工具的用法差不多：输入一句 Prompt，回你一段正文，不满意就重试。参考效果只能靠多试几次撞运气。

这个仓库的产品判断是：

- 目标用户是**认真写网文、想要可控文风参考**的作者，而不是要"整本代写"的新手
- 优先解决**"写作时能否看到某个参考书这么写会有什么效果"**，再逐步优化写作质量
- AI 不只是补全文本的模型，而是参与**拆解、建库、检索、调度和追踪**的系统角色
- **本地优先**：语料、标注、向量、原稿、成稿全部留在自己机器上，不上传

如果你在找下面这类项目，这个仓库会更值得关注：

- 想用已有小说建库、写作时按风格参考召回
- 想研究「拆书 → 结构化知识库 → RAG 召回 → 风格跟随写作」的完整链路
- 想要一个**零依赖、可打包 exe、数据全本地**的写作工具台

## 现在已经能做什么

### 1. 拆书建库（语料 → 结构化标注）

- 上传 txt 建**外部书**，或点书旁「建库标注」把 **mybook 原稿自动合成语料**建自己的书
- 自动按「第 X 章」或「N、标题」分章生成清单 → 逐章两往返标注（句子 → 分镜 + 章节）→ 硬闸门校验 → 派生字段
- 建库范围控制：**续建从最新章节下一章到指定终点**（默认一次 30 章），0=全量⚠（不鼓励），p=补建缺章
- 批末自动触发向量增量构建 + 增量聚合（大事件 / 卷纲 / 章节表 / 头文档），失败章不占聚合名额、补跑后自动聚合

### 2. 三通道参考召回（检索器）

- **label（结构）**：按分镜类型 / 叙事功能 / 标签召回
- **token（词重叠）**：按文本词面重叠召回（词典 PMI）
- **vec（语义向量）**：embedding 语义召回（embed 未配置自动降级，不阻塞）
- 每书独立向量库与词典，增量构建（mtime 对比，只嵌变化的章）

### 3. 参考书风格跟随写作

- 输入剧情需求 → ① preprocess 生成结构化分镜序列 → ② recall 逐镜三通道召回 → ③ 逐镜写作 → ④ 全文整合成稿
- **参考书即风格选择器**：参考文本作为「风格样例」注入——句式节奏 / 口吻 / 修辞向参考靠拢，内容与专名不照搬
- 排版硬规范（短段 / 对话独占成段）不受风格跟随影响，任何文风都保持网文排版
- 成稿直显 → 一键插入写作栏 → 自动保存，产出按会话归档

### 4. 写作工作台（Web，三栏）+ 拆书视图（两栏）

- **写作工作台**：左：书 / 章节大纲｜中：写作台 + AI 成稿｜右：AI 参考（输入 + 参考书池）；全栏可拖拽调宽（中栏 flex 自动铺满）
- **拆书视图**（首页 · 拆书）：两栏——左 = 我的书（mybook，每条目「建库标注 + 拆书」），右 = 外部知识库（exproject，进度 / 缺章 / 就绪提示，「建库标注 + 拆书」）
- **导入参考书语料**：读取外部语料 → 复制到 corpus + 生成章节清单 + 建 exproject 文件夹（仅落库，不自动标注）；标注由条目上的「建库标注」按钮按需触发
- **参考书池**：搜索过滤 + 排序（拼音 / 时间）+ 域前缀（【我的】/【外部】）+ 📌 置顶
- 模型选择器（写作 / 建库 / 向量独立 API），定时自动保存，设置面板

### 5. 浮动任务栏（全局任务进度 / 报错）

- 右下角全局轮询任务状态（1.5s），建库章进度条、最新日志滚动
- 失败 / 被杀标红驻留，**一键智能续跑**（只补未标注 / 失败的章，不重标已成功章）
- 已补齐的历史失败卡自动识别收起，不打扰；任务栏可拖动、位置记忆
- 服务器启动自动清理僵尸任务与 stale 任务记录，任务列表不堆积

### 6. 自动兜底与可恢复

- 失败章自动重跑 1 次 → 仍失败自动 fix → 记录 pending.json → 下次补建指令只补缺章
- 失败率 >30% 熔断停止重试；聚合 / 向量 / 索引增量幂等可重入
- WebUI 心跳：页面关闭 60s 后服务器自动退出（不驻留后台）

### 7. 桌面版分发（Windows 原生窗口 / 单文件 / macOS）

- **Windows 桌面版（推荐）**：`build/build-desktop.mjs` 一键打包 **Tauri 原生窗口壳 + SEA sidecar** → `dist/desktop/NovelyWrite.exe`（原生窗口，跟随系统 DPI，最小窗口 1200×700 保证三栏完整；依赖仅 WebView2Loader.dll）
- **Windows 浏览器版（单文件）**：SEA 打包 → `dist/NovelyWrite-browser.exe`（~89MB），双击启动并自动打开浏览器，数据落在 exe 旁
- **macOS**：`build/build-mac.mjs` → `NovelyWrite.app`；无 mac 机器可用 GitHub Actions 自动构建（Actions 页面下载）

## 典型使用路径

1. 双击 exe（或 `node server.mjs --port=3081 --open`）打开工作台。
2. 点「导入参考书」上传一本想学文风的小说 txt，选建库范围（默认续建 30 章）→ 自动拆书建库 + 向量 + 聚合。
3. 或在左栏「+ 书」建自己的书，写几章后点「建库标注」，mybook 原稿自动合成语料建库。
4. 在右栏勾选参考书（或留空 = 全库），输入剧情需求，点「✨ AI 写作」。
5. 看中右栏成稿效果：符合预期 → 插入写作栏精修；想换风格 → 换勾选的书再跑一次。
6. 有失败章 → 任务栏红卡一键「重跑」智能续跑；全部完成 → 参考书池显示标注进度。

## 快速开始

### 方式一：桌面版 / 单文件 exe（推荐，无需安装 Node）

1. 从 Release 下载：
   - **Windows 桌面版**：`NovelyWrite.exe`（原生窗口）+ 同目录 `nw-server.exe` + `WebView2Loader.dll`（解压到同一文件夹，双击 `NovelyWrite.exe`）
   - **Windows 浏览器版**：`NovelyWrite-browser.exe`（单文件，双击自动开浏览器）
   - **macOS**：`NovelyWrite.app`（Actions 下载）
2. **双击启动** → 自动打开写作工作台。
3. 数据（config / corpus / store / mybook / sessions / output）自动生成在 exe 旁；整文件夹拷走即迁移，更新只换 exe。

### 方式二：源码运行

**环境要求**：Node.js >= 18（内置 `fetch`）

```bash
node server.mjs --port=3081 --open   # 启动工作台并自动打开浏览器
# 或命令行建库：
node cli.mjs annotate <语料名> --all   # 全量标注（语料放 corpus/<名>-语料.txt）
```

### 配置

启动后点右上角 **⚙ 设置**：

- **API Key**：建库（chat）与向量（embed）分开填写；写作（shot-writing）可独立于建库配置
- **模型选择器**：写作 / 建库 / 向量模型——选项**从 API 实时读取**（DeepSeek / SiliconFlow 的 /models 接口）
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

## 架构（四层）

| 层 | 目录 | 职责 |
|---|---|---|
| L1 语料处理 | `novelread/` | 原文解析 → 标注产出（两往返 + 硬闸门）、聚合、校验、修复、章节清单 |
| L2 数据访问 | `store/` | JSON 数据 + `project-meta.json`，域化（myproject/exproject） |
| L3 检索器 | `retriever/` | 三通道召回（label / token / vec）+ 词典 / 向量增量构建 |
| L4 功能层 | `features/` | 消费 L2/L3 做业务（分镜写作 preprocess / recall / writedraft） |

## 目录结构

```
NovelyWrite/
├── cli.mjs                 # 统一 CLI 入口（建库 / 聚合 / 校验 / 修复）
├── server.mjs              # Web 服务入口（node:http 内置，零依赖）
├── webview/                # 前端（index.html / app.js / style.css / vendor/vditor）
├── novelread/              # L1 语料处理（标注 / 聚合 / 校验 / 修复 / 章节清单）
├── retriever/              # L3 三通道检索器
├── features/               # L4 功能层
│   └── shot-writing/       # 分镜写作（preprocess / recall / writedraft）
├── shared/                 # 公共模块（路径 / 配置 / LLM / 错误 / 任务）
├── build/                  # 打包（sea-main / sea-config / build-sea / build-mac / build-desktop）
├── tauri/                  # Tauri 桌面壳（原生窗口 + SEA sidecar，src/main.rs + tauri.conf.json）
├── dist/                   # 打包产物（desktop/ 桌面版 + NovelyWrite-browser.exe，不入库）
├── config.json             # 本地配置（不入库）
├── corpus/                 # 用户语料（自备，不提交）
├── store/                  # 标注数据 / 派生索引（myproject / exproject，不提交）
├── mybook/                 # 用户原稿（书/章节实时保存，不提交）
├── sessions/               # 写作会话（数据根下，不提交）
└── output/                 # 成稿 / 报告（按会话归档，不提交）
```

## 当前路线图

### P0

- 稳定拆书建库链路（标注 / 向量 / 聚合全自动、失败可续跑）
- 让参考书风格跟随更可控（风格强度、多书风格融合）

### P1

- 提高成稿一致性、节奏稳定性、角色连续性
- 参考书池进阶（书内章节级筛选、风格指纹提炼）

### P2

- 强化多书混合风格控制与运行时质量反馈
- 自动化的章节级审校、修复闭环

## 文档

- `打包分发指南.md`：代码根 / 数据根分离、环境变量注入、分发部署
- `features/shot-writing/README.md`：分镜写作设计（时空映射 / 防幻觉 / 整合）
- `retriever/README.md`：三通道检索器
- `novelread/specs/`：标注规范（句子 / 分镜 / 章节 / 大事件 / 卷纲）

## 交流反馈

- QQ 交流群：**1106526576**

## License

[MIT](LICENSE) © witch997
