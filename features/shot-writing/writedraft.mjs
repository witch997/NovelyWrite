#!/usr/bin/env node
/**
 * writedraft.mjs — 分镜参考写作 · 第 3 步：写作（两阶段：逐镜拼接 → 全文整合）
 *
 * 职责：消费 recalls.json（完整 shots + 每镜 refs）：
 *   阶段① 逐镜写作（每镜一次 LLM，thinking 禁）：intent + refs（参考分镜文本）→ 该镜文本
 *         ——口语化约束 + 字数对齐参考（WRITE_SYSTEM）
 *         拼接为「带分镜标签」的 draft：`【镜N｜type｜label】\n正文`
 *         → 落盘会话存档 <项目名>draft.txt（中间产物，人可读/可人工调整）
 *   阶段② 全文整合（一次 LLM，thinking 禁）：输入 = draft.txt（带标签分镜）+ 原始章纲
 *         ——最小幅度改写整合，去标签
 *         → 落盘最终稿 NovelyWrite/output/<项目名>.final.txt（纯正文）
 *
 * 输出：
 *   sessions/<session-id>/<项目名>draft.txt        （阶段① 中间产物，会话存档）
 *   NovelyWrite/output/<项目名>.final.txt               （阶段② 最终整合稿，用户可读）
 *
 * 测试模式（--test-mode）：
 *   不做最终整合——阶段①分镜完成后直接拼接为最终稿（保留分镜标签）。
 *   用途：调试逐镜写作质量（排除整合环节干扰）/ 快速产出原始拼接稿。
 *
 * 风格指纹（--profile，默认关闭）：
 *   跨书召回/风格混杂场景统一基调用；同书召回下与逐镜风格观察冗余且带泄漏风险，默认跳过。
 *
 * 对话拆分修复（默认开；--no-fix-dialogue 关闭）：
 *   脚本检测「"A"动作，"B"」句式并重排为合法（动作前置合并），确定性零 LLM。
 *
 * 用法：
 *   node features/shot-writing/writedraft.mjs --session <session-id> [--project <语料名>]
 *   node features/shot-writing/writedraft.mjs --session <session-id> --test-mode
 *   node features/shot-writing/writedraft.mjs --session <session-id> --profile
 *   node features/shot-writing/writedraft.mjs --session <session-id> --no-fix-dialogue
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CODE_ROOT } from "../../shared/paths.mjs";
import { loadChatConfig } from "../../shared/config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sessionsDir = path.join(__dirname, "sessions");
const outputDir = path.join(CODE_ROOT, "output");

/* ---------- 参数 ---------- */
const args = process.argv.slice(2);
function argVal(name) {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  if (a) return a.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
const sessionId = argVal("session");
const project = argVal("project") ?? "未命名"; // 项目名（用于 draft 文件名）
if (!sessionId) { console.error("用法: node features/shot-writing/writedraft.mjs --session <session-id> [--project <语料名>]"); process.exit(2); }

/* ---------- 读 recalls.json ---------- */
const sessionDir = path.join(sessionsDir, sessionId);
const recallsPath = path.join(sessionDir, "recalls.json");
if (!fs.existsSync(recallsPath)) {
  console.error(`[writedraft] recalls.json 不存在: ${recallsPath}（先跑 recall）`);
  process.exit(1);
}
const recalls = JSON.parse(fs.readFileSync(recallsPath, "utf-8"));
const shots = recalls.shots ?? [];
console.log(`[writedraft] 会话 ${sessionId} | 项目 ${project} | 分镜 ${shots.length} 镜`);

/* ---------- 读原始章纲（input.txt，阶段② 整合输入之一） ---------- */
const inputPath = path.join(sessionDir, "input.txt");
const outline = fs.existsSync(inputPath) ? fs.readFileSync(inputPath, "utf-8") : recalls.summary ?? "";

/* ---------- LLM 客户端（thinking 开——推理型任务；模型/温度走模块作用域 config） ---------- */
const chatCfg = loadChatConfig("shot-writing", __dirname); // 根 config.features["shot-writing"] 覆盖全局 + 功能目录 config.json 兼容
const baseUrl = (chatCfg.baseUrl ?? "https://api.deepseek.com/v1").replace(/\/+$/, "");

/* ---------- 字数基准配置（每镜字数目标） ----------
 * 优先级：--shot-len=N（命令行）> config features.shot-writing.chat.shotLen > 默认 200
 * shotLen 取值：
 *   number → "约 N 字"
 *   [min, max] → "N-M 字"
 */
const DEFAULT_SHOT_LEN = 200;
const shotLenConfig = (() => {
  const fromArg = args.find((a) => a.startsWith("--shot-len="));
  if (fromArg) return JSON.parse(fromArg.slice("--shot-len=".length));
  if (typeof chatCfg.shotLen !== "undefined") return chatCfg.shotLen;
  return DEFAULT_SHOT_LEN;
})();
const lenTargetText = Array.isArray(shotLenConfig)
  ? `${shotLenConfig[0]}-${shotLenConfig[1]} 字`
  : `约 ${shotLenConfig} 字`;
console.log(`[writedraft] 字数基准: ${lenTargetText}（来源: ${args.some((a) => a.startsWith("--shot-len=")) ? "命令行" : typeof chatCfg.shotLen !== "undefined" ? "config shotLen" : "默认"}）`);

async function chat(messages, maxTokens = null, thinking = false, temperature = null) {
  const body = {
    model: chatCfg.model, messages, temperature: temperature ?? chatCfg.temperature ?? 0.8,
    stream: true,
  };
  // maxTokens === null → 不传 max_tokens（用 API 默认上限，不限制长度）
  if (maxTokens !== null) body.max_tokens = maxTokens;
  // thinking：默认禁用（不传 disabled）；只有显式 thinking=true 才开启
  if (thinking !== true) body.thinking = { type: "disabled" };
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${chatCfg.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const d = t.slice(5).trim();
      if (d === "[DONE]") continue;
      try { out += JSON.parse(d).choices?.[0]?.delta?.content ?? ""; } catch { /* skip */ }
    }
  }
  if (!out.trim()) throw new Error("LLM 流式返回空内容");
  return out;
}

/* ---------- 从参考文本提炼 temperature（8 位小数） ----------
 * 原理：参考文本 = 天然的"种子"——FNV-1a 哈希(32位) → [0,1) → 映射到 [TEMP_MIN, TEMP_MAX]
 *   - 同参考 → 同 temperature（可复现）
 *   - 不同参考 → 大概率不同 temperature（多样性）
 *   - 8 位小数：几乎不重复，每镜独立发散度
 * 语义：参考文本特征决定该镜写作的发散程度（参考越分散，温度越随机）
 */
const TEMP_MIN = 0.6;   // 温度下限（较收敛）
const TEMP_MAX = 1.3;   // 温度上限（较发散）
const FNV_PRIME = 16777619;
const FNV_OFFSET = 2166136261;

export function tempFromRefs(refsText, min = TEMP_MIN, max = TEMP_MAX) {
  let h = FNV_OFFSET;
  const s = refsText ?? "";
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME);
  }
  const ratio = (h >>> 0) / 4294967296; // [0,1)
  return Number((min + ratio * (max - min)).toFixed(8));
}

/* ========== 阶段① 逐镜写作 + 拼接带标签 draft ========== */
console.log("\n[writedraft] 阶段① 逐镜写作（每镜一次 LLM，thinking 开）...");
const WRITE_SYSTEM = `你是起点中文网风格的网文作者。根据【任务】写作一个分镜（镜头级片段），
参考【写作参考】中前文类似分镜的行文节奏、互动风格和角色风格。

要求：
- 只输出该分镜的正文，不要输出标题、注释、分析
- 严格遵循该分镜给出的信息，可以拓展情节细节
- 【风格跟随】参考文本是风格样例：句式节奏、口语化程度、叙述视角、情绪表达方式要向参考靠拢——
  参考怎么说话，你就怎么说话；参考用什么词，你就用什么词（同一语域）；但内容必须用本镜的，不得照搬参考的剧情
- 【留白，不啰嗦】允许信息跳跃，不必把每件事讲透；读者能推出来的，不写；同一信息只讲一遍，
  禁止"解释性复述"（先给结论再展开、或把已说清的事换个说法再说一遍）
- 【节奏错落】短句冲刺与长句铺垫交替，允许单句成段制造停顿；不要每段均匀 2-4 句的匀速推进
- 【短句优先】单句尽量 ≤30 字，宁可拆成两句不用逗号串长句；短句占全段主体
- 【禁煽情】禁止用华丽辞藻/抒情渲染/大段心理煽情；情绪点到即止，用动作或简短对话带出，
  不得出现「仿佛/恰似/凛然/心中涌起/难以言说」类书面煽情腔
- 【禁比喻】禁止比喻（包括艺术性明喻"像…"、隐喻、拟人化描写）；需要表达时直白陈述或用具体动作，
  仅允许极口语化的比拟（如"跟没睡醒似的"），艺术性比喻一律不用
- 符合给定 type（分镜类型）与 funcs（叙事功能）
- 【字数对齐参考】本镜字数对齐【写作参考】分镜的平均长度（±10%），参考写多长你写多长，
  不要偏长也不要偏短（具体字数目标以【本镜需求】里给出的为准）
- 本镜是章节中的独立片段，不写场景开头/结尾的过渡语（衔接由整合阶段统一处理）
- 主角称呼与上下镜保持一致（本镜若出现人物，沿用其已有称呼，不自行改名）`;

/* ---------- 风格指纹提炼（默认关闭，--profile 显式开启） ----------
 * 定位：跨书召回时统一风格基调的"保险"；同书召回下与逐镜风格观察(做法A)冗余，
 *   且指纹提炼读全部 refs 有剧情泄漏风险——故默认关闭。
 * 用法：--profile 开启（跨书/风格混杂场景）；默认跳过，靠逐镜风格观察 + 借用规则。
 */
const useProfile = args.includes("--profile");
let styleProfile = "";
if (useProfile) {
  console.log("\n[writedraft] 提炼风格指纹（--profile，读全部参考 → 显式风格契约）...");
  // 每条参考前标 "-"，表示这是不同的独立分镜（避免被当成一整段连续文本）
  const allRefsText = (recalls.shots ?? [])
    .flatMap((s) => s.refs ?? [])
    .map((r) => r.text ?? "")
    .filter(Boolean)
    .map((t) => `- ${t}`)   // 每条前加 "-" 列表标记
    .join("\n");
  if (allRefsText.trim().length > 20) {
    const profileRaw = await chat([
      { role: "system", content: "你是风格分析师。读下面的参考文本，提炼出它的写作风格指纹，输出纯文本（不要 JSON 格式符号）。" },
      { role: "user", content: `参考文本（每个 "- " 开头是一条独立的分镜，不是连续段落）：\n${allRefsText.slice(0, 3000)}\n\n请输出风格指纹，覆盖：\n1. 句式（短句占比/平均长度）\n2. 口语特征（语气词/吐槽腔/市井比喻）\n3. 叙述视角与节奏（段落长短/停顿习惯/信息是否留白）\n4. 情绪表达（直接命名还是动作暗示）\n5. 禁忌（什么词/什么写法绝不出现）` },
    ], null, false, 0.3); // 提炼用低温度，稳定；thinking 禁；max_tokens 不限制
    styleProfile = profileRaw.trim();
    console.log(`  [风格指纹] 已提炼（${styleProfile.length} 字符）`);
  } else {
    console.log("  [风格指纹] 参考不足，跳过提炼");
  }
} else {
  console.log("[writedraft] 风格指纹：默认关闭（--profile 可开启）");
}

/* ---------- 对话修复（脚本确定性，默认开；--no-fix-dialogue 关闭） ----------
 * 覆盖三类对话问题（全部确定性正则，零 LLM）：
 *  ① 拆句：「"A"动作"B"」→ 动作前置合并「动作"A。B"」（含标点智能处理）
 *  ② 逗号代替冒号：动作+逗号+对话（如 他说，"B"）→ 冒号（他说："B"）
 *  ③ 无标点直接引对话（如 他走过来"B"）→ 冒号（他走过来："B"）
 */
const fixDialogue = !args.includes("--no-fix-dialogue");

function fixSplitDialogue(text) {
  if (!fixDialogue) return text;
  let total = 0;
  let t = text;

  // ① 拆句修复：「"A"动作"B"」→ 动作"A。B"（动作前置合并）
  t = t.replace(
    /“([^”\n]{2,60})”([^“”\n]{1,40}?)(“([^”\n]{2,60})”)/g,
    (m, a, action, _x, b) => {
      total++;
      let sep = "";
      if (/[。！？…]$/.test(a)) sep = "";
      else if (/[，,]$/.test(a)) sep = "。"; // 逗号替换为句号
      else sep = "。";
      const aClean = a.replace(/[，,]$/, "");
      return `${action.trim()}“${aClean}${sep}${b}”`;
    }
  );

  // ② 逗号代替冒号：动作 + "，" + 引号对话 → 动作 + "：" + 引号对话
  //   匹配：非引号字符(动作) 后跟 逗号 空格? 然后 引号
  t = t.replace(
    /([^“”\n]{1,50}?)[，,]\s*“/g,
    (m, action) => {
      // 动作部分不能以句末标点结尾（若"他笑了。，“B"是另一种情况，跳过）
      if (/[。！？…]$/.test(action)) return m;
      total++;
      return `${action}：“`;
    }
  );

  // ③ 无标点直接引对话：动作 紧跟 引号（如 他走过来"B"）→ 动作："B"
  t = t.replace(
    /([^“”\n]{1,50}?)(?<![:：])\s*“/g,
    (m, action) => {
      // 动作部分若以句末标点或逗号结尾则跳过（已有标点）
      if (/[。！？…，,]$/.test(action)) return m;
      total++;
      return `${action}：“`;
    }
  );

  // ④ 多余冒号：冒号前是"对话引导词"但冒号后不是引号（说明冒号用错了位置，应引出对话）
  //   例："嗤笑：他翘着的腿放下" → "嗤笑，他翘着的腿放下"（引导词后的冒号只能接对话）
  //   只修引导词后(说/道/笑/喊/问/答/叹/斥/喝/冷笑/嗤笑/哼 等)，不碰"价格：五十两"类说明性冒号
  t = t.replace(
    /([^“”\n]{0,20}?(?:说|道|喊|问|答|叹|斥|喝|吼|笑|冷笑|嗤笑|苦笑|哼|嘀咕|叫)[^“”\n]{0,15}?)[：:](?!“)/g,
    (m, action) => {
      total++;
      return `${action}，`;
    }
  );

  if (total > 0) console.log(`  [对话修复] 修复 ${total} 处对话格式（拆句合并/逗号改冒号/补冒号/多余冒号）`);
  return t;
}

const shotBodies = [];
for (let si = 0; si < shots.length; si++) {
  const shot = shots[si];
  const refs = shot.refs ?? [];
  const refsText = refs.length
    ? refs.map((r, i) =>
        `${i + 1}. [${r.source}] 第${r.chapter}章 分镜${r.shotId}（${r.type}/${(r.funcs ?? []).join("、")}「${r.label ?? ""}」）：${r.text ?? ""}`
      ).join("\n")
    : "（无参考）";
  // 前后分镜上下文（供本镜写作锚定：前镜的结局 → 本镜起点；后镜的起点 → 本镜收尾衔接）
  const prevShot = si > 0 ? shots[si - 1] : null;
  const nextShot = si < shots.length - 1 ? shots[si + 1] : null;
  const prevText = prevShot
    ? `【前一分镜·第${prevShot.seq}镜】${prevShot.type}「${prevShot.label ?? ""}」：${prevShot.content ?? ""}`
    : "（无前一分镜，本镜是开场）";
  const nextText = nextShot
    ? `【后一分镜·第${nextShot.seq}镜】${nextShot.type}「${nextShot.label ?? ""}」：${nextShot.content ?? ""}`
    : "（无后一分镜，本镜是收尾）";
  // 字数基准：由配置决定（--shot-len / config shotLen / 默认 200），不再随机对齐参考
  const lenTarget = lenTargetText;
  const userMsg = [
    "## 任务：写一个分镜文本",
    "",
    "### 前后分镜上下文（明确衔接，写作本镜时必须与它们连贯）",
    prevText,
    nextText,
    "注意：你写的是【中间的本镜】，前一分镜是它的起点，后一分镜是它的终点——",
    "本镜的结尾要为后一分镜的起点留好衔接（人物状态/场景/事件），本镜开头要承接前一分镜的结局。",
    "",
    "### 本镜风格指纹（强制遵循）",
    styleProfile || "（无风格指纹，按下方【内含提炼】自行把握）",
    "",
    "### 时空映射：先理解平行时空，再写本时空（必须执行）",
    "【参考定位】以下【写作参考】是本分镜内容在**不同时空下可能呈现的映射**——它们描述的可能是",
    "同一类事件/场景/情绪在另一本书、另一段剧情里的样子。你需要：",
    "①【理解映射】看懂参考在「不同时空」里是怎么呈现这类内容的（人物怎么反应、场景怎么铺、对话怎么走）",
    "②【对齐本质】提炼参考的句式律动与叙述口吻（句长/停顿/吐槽腔/市井感）——这些是跨时空不变的写法",
    "③【按本时空写】现在回到本时空（本镜），用提炼到的律动和口吻，按【本镜需求】的内容写作；",
    "   参考的具体人物/事件/设定是「另一时空」的，不得带入，只学它的「写法」",
    "",
    "### 本镜需求",
    `类型: ${shot.type}`,
    `功能: ${(shot.funcs ?? []).join("、")}`,
    `标签: ${shot.label ?? ""}`,
    `内容: ${shot.content ?? ""}`,
    `字数目标: ${lenTarget}`,
    "",
    "### 写作参考（本分镜在不同时空下的映射——学习其写法，不引用其内容）",
    refsText,
    "",
    "### 参考借用规则（显式声明）",
    "参考是「另一时空」的映射。仅当参考中的人物、事件、设定与【本镜需求】的内容**完全重合**时，",
    "才允许将其作为本镜的设定沿用；与【本镜需求】不重合的参考内容，一律忽略，不得引入本镜。",
    "【专名保护】参考中的专有名词（人名/地名/物品名/组织名）除非与【本镜需求】逐字相同，",
    "否则一律不得引入本镜；本镜的人物、称呼、物品以【本镜需求】为准，参考不得给本镜添加角色或改名。",
    "参考主要用途是：学其写法（句式/口吻/节奏/场景呈现），并作为字数基准。",
    "",
    "## 输出要求",
    "口语化有网文节奏感，避免文学性拖沓；贴合本镜 type/funcs/内容；字数对齐字数目标（±10%）。",
    "只输出该分镜的正文文本，不要任何格式说明。",
  ].join("\n");
  // 从本镜参考文本提炼 temperature（8 位小数，确定性：同参考同值）
  const shotTemp = tempFromRefs(refsText);
  const raw = await chat([
    { role: "system", content: WRITE_SYSTEM },
    { role: "user", content: userMsg },
  ], null, false, shotTemp); // temperature 由参考文本提炼（覆盖默认）；thinking 禁；max_tokens 不限制
  shotBodies.push(raw.trim());
  console.log(`  [${shot.seq}] ${shot.type}「${shot.label ?? ""}」 → ${raw.length} 字符（temp=${shotTemp}，字数目标=${lenTarget}）`);
}

/* 拼接：带分镜标签的 draft（中间产物） */
const taggedDraft = shotBodies.map((body, i) => {
  const s = shots[i];
  return `【镜${i + 1}｜${s.type}｜${s.label ?? ""}】\n${body}`;
}).join("\n\n");

const draftName = `${project}draft.txt`; // <项目名>draft.txt（现有风格：项目名 + draft）
fs.mkdirSync(sessionDir, { recursive: true });
fs.writeFileSync(path.join(sessionDir, draftName), taggedDraft, "utf-8");
console.log(`\n[writedraft] 阶段① draft 已落盘（中间产物，带分镜标签）:`);
console.log(`   sessions/${sessionId}/${draftName}（${taggedDraft.length} 字符）`);

/* ========== 测试模式：不做最终整合，分镜完成后直接拼接 ==========
 * --test-mode 时跳过阶段②全文整合，把带标签的分镜文本直接作为最终稿落盘。
 * 用途：调试逐镜写作质量（不含整合环节的干扰），或快速产出原始分镜拼接稿。
 */
const testMode = args.includes("--test-mode");
if (testMode) {
  console.log("\n[writedraft] 测试模式：不做最终整合，分镜完成后直接拼接...");
  const finalText = taggedDraft; // 直接拼接（保留分镜标签）
  fs.mkdirSync(outputDir, { recursive: true });
  const finalName = `${project}.final.txt`;
  fs.writeFileSync(path.join(outputDir, finalName), finalText, "utf-8");
  console.log(`\n✅ 最终稿已生成（测试模式，未整合）:`);
  console.log(`   中间产物: features/shot-writing/sessions/${sessionId}/${draftName}（带标签，会话存档）`);
  console.log(`   最终稿:   NovelyWrite/output/${finalName}（测试模式：分镜直接拼接，含标签）`);
  console.log(`\n=== 最终稿预览 ===`);
  console.log(finalText.slice(0, 600) + (finalText.length > 600 ? "\n…" : ""));
  process.exit(0);
}

/* ========== 阶段② 全文整合（draft + 章纲 → 最终稿，最小改动整合） ========== */
console.log("\n[writedraft] 阶段② 全文整合（draft.txt + 原始章纲 → 完整章节，最小改动衔接）...");
const MERGE_SYSTEM = `你是编辑。把一组带标签的分镜文本整合为一个连贯章节。

【硬约束】
- 只做拼接与去标签，正文【逐字保留】：不扩写、不删减、不润色、不新增任何情节/台词/设定
- 仅允许最小调整：消除镜间重复；统一前后指代；保持时间线顺序
- 分镜中出现原始章纲未指定的人物台词或设定 → 删除或改为不特定表述
- 输出纯正文章节，只输出正文`;
const mergeUser = [
  "### 原始章纲（供你把握整体意图）",
  outline,
  "",
  "### 带标签的分镜文本（按顺序）",
  taggedDraft,
].join("\n\n");
// 整合温度：从整篇 draft 提炼一个 temperature（8 位小数，确定性：同 draft 同值）
const mergeTemp = tempFromRefs(taggedDraft);
const mergeRaw = await chat([
  { role: "system", content: MERGE_SYSTEM },
  { role: "user", content: mergeUser },
], null, false, mergeTemp); // 全文整合：thinking 禁用 + 温度由整篇 draft 提炼 + max_tokens 不限制
const finalText = mergeRaw.trim();
console.log(`  [整合] 最终稿 ${finalText.length} 字符（temp=${mergeTemp}）`);
// 对话拆分修复（默认开；--no-fix-dialogue 关闭）：整合完成后统一检测「"A"动作，"B"」重排为合法句式
const fixedFinalText = fixSplitDialogue(finalText);
const finalOut = fixedFinalText;

/* ---------- 落盘：最终稿 → NovelyWrite/output/ ---------- */
fs.mkdirSync(outputDir, { recursive: true });
const finalName = `${project}.final.txt`; // <项目名>.final.txt（最终整合稿，纯正文）
fs.writeFileSync(path.join(outputDir, finalName), finalOut, "utf-8");
console.log(`\n✅ 最终稿已生成:`);
console.log(`   中间产物: features/shot-writing/sessions/${sessionId}/${draftName}（带标签，会话存档）`);
console.log(`   最终稿:   NovelyWrite/output/${finalName}（纯正文，用户可读）`);
console.log(`\n=== 最终稿预览 ===`);
console.log(finalOut.slice(0, 600) + (finalOut.length > 600 ? "\n…" : ""));
