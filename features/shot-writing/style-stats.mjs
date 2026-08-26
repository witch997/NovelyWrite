#!/usr/bin/env node
/**
 * style-stats.mjs — 文体统计特征（Stylometric Features）
 *
 * 学术定位：文体计量学（Stylometry）——用可计算的表面统计量量化文风，
 * 参考 Stamatatos(2009) 五类框架（字符/词法/句法/结构/内容）与 Burrows Delta（虚词指纹）。
 *
 * 分工：程序负责【精确计算】统计值 → 翻译成语义标签 → LLM 消费标签生成画像
 *      （LLM 不直接算统计——计数/去重会幻觉；只理解"偏短/偏高"这类语义标签）
 *
 * 18 维特征（14 基础 + 4 词典语义统计）：
 *   [字符/词汇]  avgSentenceLen 平均句长 / sentenceLenStd 句长方差 / avgWordLen 平均词长 /
 *                ttr 词汇丰富度(去重字/总字) / functionWordRatio 虚词频率
 *   [句法]       punctDensity 标点密度 / exclaimRatio 感叹号密度 / questionRatio 问号密度 / quoteDensity 引号密度
 *   [篇章]       dialogueRatio 对话占比 / avgParaLen 平均段落长 / firstPersonRatio 第一人称比例
 *   [语气/修辞]  particleRatio 语气词密度 / intensifierRatio 程度副词密度
 *   [词典语义]   emotionRatio 情感词密度 / abstractRatio 抽象词比例 / evaluativeRatio 评价性形容词密度 /
 *                temporalRatio 时间词密度
 *
 * 输出：
 *   statsToJson(text)   → { raw: {…18维原始值}, labels: {…15项标签(含数值)}, summary }
 *   labels 供 LLM 消费（程序定阈值翻译，附原始值）；raw 供程序比较/校验
 *
 * 用法：
 *   node features/shot-writing/style-stats.mjs "文本…"    # 单条文本统计（自检）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* ================= 词典常量（中文风格语义统计） ================= */
const FUNCTION_WORDS = ["的", "了", "在", "是", "和", "与", "把", "被", "就", "都", "也", "很", "对", "从", "到", "而", "之", "其", "则", "于", "以", "为"];
const PARTICLES = ["啊", "呀", "呢", "吧", "嘛", "么", "哦", "唉", "哎", "哟", "哈", "嘿", "哇", "啦", "咯", "罢"];
const INTENSIFIERS = ["很", "太", "极", "非常", "特别", "十分", "格外", "越发", "愈发", "更", "最", "相当", "颇为", "甚"];
const EMOTION_WORDS = ["怒", "愤", "恼", "恨", "悲", "哀", "痛", "苦", "怒", "惊", "骇", "喜", "悦", "欢", "乐", "笑", "泪", "泣", "羞", "愧", "惧", "恐", "怕", "忧", "愁", "烦", "闷", "气", "怨", "怜", "爱", "恨", "怨", "悔", "愧", "耻", "恼", "烦"];
const ABSTRACT_WORDS = ["真相", "权力", "名声", "前程", "仕途", "体面", "道理", "规矩", "礼法", "身份", "地位", "名誉", "尊严", "责任", "义务", "命运", "人生", "世界", "天下", "朝廷", "名声", "荣辱", "祸福", "利害", "人心", "是非", "对错", "真假", "虚实", "轻重", "缓急", "分寸", "体统", "体面", "风骨", "气节", "操守", "名声", "信义", "恩义", "情义", "大义", "私情", "公义", "原则", "底线", "理想", "抱负", "志气", "度量", "格局"];
const EVALUATIVE_WORDS = ["冷静", "荒谬", "荒唐", "可笑", "可笑", "体面", "得体", "失态", "无礼", "规矩", "妥当", "不妥", "合理", "过分", "过分", "荒唐", "愚蠢", "精明", "高明", "拙劣", "卑鄙", "磊落", "坦荡", "虚伪", "真诚", "虚伪", "愚蠢", "懦弱", "勇敢", "果断", "优柔", "寡断", "荒唐", "荒谬", "严肃", "轻浮", "庄重", "轻佻", "得体", "失礼"];
const TEMPORAL_WORDS = ["今日", "明日", "昨日", "当年", "从前", "此刻", "当时", "方才", "适才", "如今", "后来", "此后", "那年", "这日", "当夜", "晌午", "傍晚", "深夜", "天明", "三更", "初春", "深秋", "暮色", "拂晓", "黄昏", "子时", "午时", "三月", "十月", "数日", "多日", "经年", "昔日", "往昔", "起初", "先时"];

/* ================= 切分工具 ================= */
function splitSentences(text) {
  // 按句末标点切句（保留中文常见句末符；忽略省略号内部）
  return text.split(/[。！？!?…]+/).filter((s) => s.trim().length > 0);
}

/* ================= 18 维统计计算 ================= */
export function statsToJson(text) {
  const s = text ?? "";
  const totalChars = s.replace(/\s/g, "").length || 1;

  // 句子
  const sents = splitSentences(s);
  const sentLens = sents.map((x) => x.length);
  const avgSentenceLen = sents.length ? sentLens.reduce((a, b) => a + b, 0) / sents.length : 0;
  const sentenceLenStd = sents.length > 1
    ? Math.sqrt(sentLens.reduce((a, b) => a + (b - avgSentenceLen) ** 2, 0) / sents.length)
    : 0;

  // 词（按空格 + 标点粗切为"词块"）
  const tokens = s.split(/[\s，。！？；：""''、（）《》…—·]+/).filter((x) => x.trim().length > 0);
  const avgWordLen = tokens.length ? tokens.reduce((a, b) => a + b.length, 0) / tokens.length : 0;

  // 词汇丰富度（去重字/总字）
  const uniqueChars = new Set(s.replace(/[\s，。！？；：""''、（）《》…—·，]/g, "")).size;
  const ttr = uniqueChars / totalChars;

  // 标点 / 语气（中文全角优先，兼容半角；排除全角/半角直引号计入标点密度会高估——单独处理引号）
  const punctCount = (s.match(/[，。！？；：、（）《》…—·,.;:?!()[\]{}]/g) ?? []).length;
  const exclaimCount = (s.match(/[！!](?![！!])/g) ?? []).length; // 感叹号（排除连续感叹号串重复计）
  const questionCount = (s.match(/[？?]/g) ?? []).length;
  const quoteCount = (s.match(/[“”"']/g) ?? []).length;

  // 段落（按 \n 或空行）
  const paras = s.split(/\n\s*\n|\n+/).filter((x) => x.trim().length > 0);
  const avgParaLen = paras.length ? s.replace(/\s/g, "").length / paras.length : 0;

  // 对话占比（引号内字符；支持全角“”与半角""）
  let dialogueChars = 0;
  const qRe = /[“"]([^“”"]*)[”"]/g;
  let qm;
  while ((qm = qRe.exec(s))) dialogueChars += qm[1].replace(/\s/g, "").length;
  const dialogueRatio = dialogueChars / totalChars;

  // 第一人称
  const firstPersonRatio = (s.match(/我|我们|我的|咱/g) ?? []).length / totalChars;

  /* ========== 解码参数痕迹特征（四元组解析用） ==========
   * repeatRatio    重复 3-gram 比例 → frequency_penalty（越高=越重复，惩罚该低）
   *                 （3-gram 比 2-gram 更少受拼接伪影影响：跨条拼接的常用字对不会形成跨条 3-gram）
   * noveltyDecay   后段新词率 - 前段新词率 → presence_penalty（新词衰减=意象缠绕，惩罚该高）
   * vocabEntropy   词表熵（归一化）→ top_p（分布越散，截断该放宽）
   */
  // 3-gram 重复率（按字三元组；跳过标点）
  const cleanChars = s.replace(/[\s，。！？；：""''、（）《》…—·,.;:?!]/g, "");
  const GRAM_N = 3;
  const grams = [];
  for (let i = 0; i < cleanChars.length - GRAM_N + 1; i++) grams.push(cleanChars.slice(i, i + GRAM_N));
  const gramTotal = grams.length || 1;
  const gramUniq = new Set(grams).size;
  const repeatRatio = 1 - gramUniq / gramTotal; // 重复率 = 1 - 去重比

  // 前/后段新词率（presence_penalty：新词衰减越快 = 越爱缠绕旧意象）
  const HALF = Math.floor(cleanChars.length / 2) || 1;
  const front = cleanChars.slice(0, HALF);
  const back = cleanChars.slice(HALF);
  const frontSet = new Set(front);
  const backNovel = [...back].filter((c) => !frontSet.has(c)).length;
  const noveltyDecay = Number(((backNovel / (back.length || 1)) - 0).toFixed(3)); // 后段新词占比（越低=越缠绕）

  // 词表熵（归一化 0-1：log2(去重数) / log2(总字数)）——分布越散越接近 1
  const vocabEntropy = Number((Math.log2(gramUniq + 1) / Math.log2(gramTotal + 1)).toFixed(3));

  // 词典统计
  const countOf = (words) => {
    let n = 0;
    for (const w of words) {
      const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
      n += (s.match(re) ?? []).length;
    }
    return n;
  };
  const functionWordRatio = countOf(FUNCTION_WORDS) / totalChars;
  const particleRatio = countOf(PARTICLES) / totalChars;
  const intensifierRatio = countOf(INTENSIFIERS) / totalChars;
  const emotionRatio = countOf(EMOTION_WORDS) / totalChars;
  const abstractRatio = countOf(ABSTRACT_WORDS) / totalChars;
  const evaluativeRatio = countOf(EVALUATIVE_WORDS) / totalChars;
  const temporalRatio = countOf(TEMPORAL_WORDS) / totalChars;

  const raw = {
    avgSentenceLen: Number(avgSentenceLen.toFixed(2)),
    sentenceLenStd: Number(sentenceLenStd.toFixed(2)),
    avgWordLen: Number(avgWordLen.toFixed(2)),
    ttr: Number(ttr.toFixed(3)),
    functionWordRatio: Number(functionWordRatio.toFixed(3)),
    punctDensity: Number((punctCount / totalChars * 100).toFixed(2)),
    exclaimRatio: Number((exclaimCount / sents.length * 100).toFixed(1)),
    questionRatio: Number((questionCount / sents.length * 100).toFixed(1)),
    quoteDensity: Number((quoteCount / totalChars * 100).toFixed(2)),
    dialogueRatio: Number(dialogueRatio.toFixed(3)),
    avgParaLen: Number(avgParaLen.toFixed(1)),
    firstPersonRatio: Number(firstPersonRatio.toFixed(3)),
    particleRatio: Number(particleRatio.toFixed(3)),
    intensifierRatio: Number(intensifierRatio.toFixed(3)),
    emotionRatio: Number(emotionRatio.toFixed(3)),
    abstractRatio: Number(abstractRatio.toFixed(3)),
    evaluativeRatio: Number(evaluativeRatio.toFixed(3)),
    temporalRatio: Number(temporalRatio.toFixed(3)),
    repeatRatio: Number(repeatRatio.toFixed(3)),
    noveltyDecay: noveltyDecay,
    vocabEntropy: vocabEntropy,
  };

  /* ============ 标签化翻译（程序定阈值 → 语义标签 + 数值，LLM 消费用） ============ */
  // 每项：标签（数值）——LLM 读到"中（14.5）"既知结论又见原始值，可自行判断
  const T = (label, val) => `${label}（${val}）`;
  const labels = {
    "句长": T(raw.avgSentenceLen < 10 ? "短" : raw.avgSentenceLen < 18 ? "中" : "长", raw.avgSentenceLen),
    "句长波动": T(raw.sentenceLenStd < 5 ? "平稳" : raw.sentenceLenStd < 10 ? "中等" : "跳跃", raw.sentenceLenStd),
    "词汇": T(raw.ttr < 0.5 ? "重复度高" : raw.ttr < 0.65 ? "中等丰富" : "丰富", raw.ttr),
    "虚词密度": T(raw.functionWordRatio < 0.08 ? "低" : raw.functionWordRatio < 0.15 ? "中" : "高", raw.functionWordRatio),
    "标点密度": T(raw.punctDensity < 8 ? "稀疏" : raw.punctDensity < 15 ? "适中" : "密集", raw.punctDensity),
    "感叹强度": T(raw.exclaimRatio < 5 ? "克制" : raw.exclaimRatio < 15 ? "适度" : "外放", raw.exclaimRatio),
    "疑问密度": T(raw.questionRatio < 5 ? "低" : raw.questionRatio < 20 ? "中" : "高", raw.questionRatio),
    "对话占比": T(raw.dialogueRatio < 0.25 ? "低(叙事为主)" : raw.dialogueRatio < 0.55 ? "中(对白均衡)" : "高(对白驱动)", raw.dialogueRatio),
    "段落": T(raw.avgParaLen < 40 ? "短段" : raw.avgParaLen < 80 ? "中段" : "长段", raw.avgParaLen),
    "视角": T(raw.firstPersonRatio < 0.005 ? "第三人称" : "含第一人称", raw.firstPersonRatio),
    "口语化": T(raw.particleRatio < 0.005 ? "少口语词" : raw.particleRatio < 0.015 ? "轻度口语" : "口语重", raw.particleRatio),
    "夸张度": T(raw.intensifierRatio < 0.005 ? "平实" : raw.intensifierRatio < 0.012 ? "适度" : "夸张", raw.intensifierRatio),
    "情绪外露": T(raw.emotionRatio < 0.01 ? "内敛" : raw.emotionRatio < 0.025 ? "含蓄" : "外显", raw.emotionRatio),
    "抽象思辨": T(raw.abstractRatio < 0.01 ? "具体叙事" : raw.abstractRatio < 0.025 ? "偶有思辨" : "思辨重", raw.abstractRatio),
    "评判语气": T(raw.evaluativeRatio < 0.008 ? "中性" : raw.evaluativeRatio < 0.02 ? "偶有评判" : "评判重", raw.evaluativeRatio),
  };

  return { raw, labels, summary: labels["句长"] + "句/" + labels["对话占比"] + "/" + labels["情绪外露"] };
}

/* ========== 解码四元组解析（stats → temperature/top_p/frequency_penalty/presence_penalty） ==========
 * 原理：解码参数在文本上留下统计痕迹（学术：温度可逆推 arXiv 2303.04729）——
 *   词汇新颖度(ttr/词长) → temperature
 *   分布集中度(vocabEntropy) → top_p
 *   重复率(repeatRatio) → frequency_penalty
 *   新词衰减(noveltyDecay) → presence_penalty
 *
 * 系数可配置（跨模型兼容）：不同模型对参数的敏感性不同，系数按模型标定。
 * 默认值 = DeepSeek 标定结果；换 GLM/其他模型可在 config 覆盖。
 *
 * cfg 结构（全部可选，缺省用默认）：
 *   {
 *     tempRange: [lo, hi],          // temperature clamp 区间（GLM 建议 [0.5, 1.0]）
 *     top_p: number|null,           // top_p 固定值；null = 不覆盖（用 API 默认）
 *     fpCenter: number,             // frequency_penalty 中心（repeat=0 时的值）
 *     fpSlope: number,              // frequency_penalty 斜率（repeat 每 +0.01 扣多少）
 *     fpRange: [lo, hi],            // frequency_penalty clamp 区间
 *     presence_penalty: number|null,// presence_penalty 固定值；null = 不覆盖
 *   }
 */
const DEFAULT_DECODE_CFG = {
  tempRange: [0.6, 1.3],      // DeepSeek 标定（GLM 建议改为 [0.5, 1.0]）
  top_p: 1.0,
  fpCenter: 1.0,
  fpSlope: 6.7,
  fpRange: [-0.5, 1.5],
  presence_penalty: 0.3,
};

export function decodeParamsFromStats(st, cfg = {}) {
  const c = { ...DEFAULT_DECODE_CFG, ...cfg };
  const r = st?.raw ?? {};
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  // temperature：回退——由 type+funcs 规则出（shotParams 侧处理，此处不推），保留占位 null 表示"不覆盖"
  const temperature = null;
  // top_p：固定值（cfg 可设 null = 用 API 默认）
  const top_p = c.top_p;
  // frequency_penalty：重复率越高 → 惩罚越低；系数可重标定
  const frequency_penalty = clamp(c.fpCenter - (r.repeatRatio ?? 0.05) * c.fpSlope, c.fpRange[0], c.fpRange[1]);
  // presence_penalty：固定值（cfg 可设 null = 用 API 默认）
  const presence_penalty = c.presence_penalty;
  return {
    temperature, // null → 调用方回退 type+funcs 规则
    top_p,
    frequency_penalty: Number(frequency_penalty.toFixed(3)),
    presence_penalty,
  };
}

/* ========== CLI 自检 ========== */
if (process.argv[1] && path.resolve(process.argv[1]).endsWith("style-stats.mjs")) {
  const file = process.argv[2];
  const text = file && fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : (file ?? "");
  if (!text.trim()) { console.log("用法: node features/shot-writing/style-stats.mjs \"文本\" 或 <文件>"); process.exit(0); }
  const r = statsToJson(text);
  console.log("=== raw（18 维原始值）===");
  console.log(JSON.stringify(r.raw, null, 2));
  console.log("\n=== labels（语义标签 + 数值，LLM 消费）===");
  console.log(JSON.stringify(r.labels, null, 2));
  process.exit(0);
}
