/**
 * build-derived.mjs — 派生构建器（词典 + 四表索引 + 向量，每书一份）
 *
 * 从 store 事实层（各 project 的分镜/句子 JSON）构建派生数据到**每书的 derived 目录**：
 *   <书>project/derived/dict/entity-dict.json    # 该书实体词典（label 词整体 + PMI 切词高频真词）
 *   <书>project/derived/dict/lexical-index.json  # 四表倒排（byFunc/byType/byEntity/byGram，后期扩容预备）
 *   <书>project/derived/vector/第XXXX章.json     # 该书每章向量文件
 *   <书>project/derived/vector/index.json        # 该书向量索引（embedVersion + 每章 mtime）
 *
 * 域化说明：每书独立派生（词典/向量），书间重算隔离——
 *   改 A 书只重建 A 书词典/向量，不触发全域重建（支持"我的作品/外部库"分池检索）。
 *
 * 用法：
 *   node retriever/build-derived.mjs --dict [--book=<书>]     # 只构建词典（默认全部书）
 *   node retriever/build-derived.mjs --index                   # 只构建四表索引（预备，跳过）
 *   node retriever/build-derived.mjs --vector [--book=<书>]    # 只构建/增量向量
 *   node retriever/build-derived.mjs --all                     # 全部
 *   node retriever/build-derived.mjs --reset-vector            # 强制全量重建向量
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dictDirOf, vectorDirOf, vectorIndexFileOf, storeDir, projectRoot, shotJsonPath, shotToText, padChapter } from "./rag-core.mjs";
import { scanAllShots } from "./lexical.mjs";
import { createEmbed } from "../shared/embed.mjs";
import { ensureEmbedReady } from "./embed.mjs";
import { scanSourceState } from "./derived-state.mjs";
import { listProjects } from "../shared/paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ========== 词典构建（全域：label 词 + 高频词） ========== */

/** 词典停用词（高频功能词/虚词——不是实体但会进入候选） */
const DICT_STOPWORDS = new Set([
  "自己", "什么", "一个", "没有", "现在", "这个", "那个", "时候", "就是", "不是",
  "知道", "已经", "有点", "有人", "还是", "真的", "不会", "不能", "可以", "可能",
  "但是", "因为", "所以", "如果", "虽然", "然后", "可是", "只是", "就是", "觉得",
  "说道", "说着", "起来", "出来", "过来", "进去", "回来", "上去", "下去", "上来",
  "一下", "一点", "一起", "一边", "一直", "一定", "一样", "一时", "一天", "一次",
  "两人", "三人", "众人", "大家", "他们", "我们", "你们", "她们", "咱们",
  "那些", "这时", "那时", "此时", "此刻", "眼前", "面前", "身边", "身后", "心里",
  "第一", "一番", "一事", "一物", "一切", "何事", "如何", "何为", "今日", "明日",
  "当时", "当下", "原来", "本来", "方才", "方才", "此后", "后来", "其中", "其间",
  "恐怕", "只怕", "想必", "不知", "不曾", "未曾", "只得", "只好", "只是", "但凡",
]);

/** 句子文本清洗正则：标点/引号/空白全部剔除（含中文弯引号——漏了会让引号混入 PMI 词） */
const SENT_CLEAN_RE = /[，。！？…、；：""''“”‘’—–·《》「」『』【】〈〉\s]/g;

/* ========== PMI 统计切词（词典建库的次源：从句子 text 提取真词，替代滑窗） ========== */

/**
 * 统计互信息（PMI）切词——零依赖中文切词，用于词典建库的高频词提取。
 *
 * 设计背景：旧方案「滑窗统计 2-3 字片段」无词边界 → 跨词碎片（玉借/山正）混入词典。
 * PMI 方案：统计相邻两字共现频次，算互信息——真词（黛玉/手炉/奚落）共现强相关 PMI 高，
 *          碎片（玉借/山正）共现偶然 PMI≈0 → 切词时按 PMI 阈值判定词边界。
 *
 * 性能（已实测）：10 万分镜 ≈ 9s 建表、~180MB（bigram Map）；建库一次性，非查询路径。
 * 定位：词典次源（label 整体词为主源，PMI 只补正文真词；label 词不受 PMI 误伤影响）。
 */
const CUT_CHARS = new Set([
  "的","了","在","是","我","你","他","她","它","们","这","那","就","也","都","说","道",
  "看","想","着","过","什","么","怎","自","己","有","没","不","要","会","能","到","去","来",
  "和","与","及","把","被","然","后","因","为","所","以","如","果","虽","时","候","现","已","经",
  "借","请","得","之","其","乃","遂","且","便","亦","故","方","将","令","闻","见","言","问","笑",
  "回","叫","让","往","来","于","於","者","也","乎","焉","哉","矣","耳","曰","云","谓",
]);

/** PMI 统计表：{ unigram: Map<字,频次>, bigram: Map<两字,共现频次>, total: 总字符数 } */
export function buildPmiTable(projects) {
  const unigram = new Map(), bigram = new Map();
  let total = 0;
  for (const project of projects) {
    const sentDir = path.join(projectRoot(project), "句子标注", "json");
    if (!fs.existsSync(sentDir)) continue;
    for (const file of fs.readdirSync(sentDir).filter((f) => /^第\d{4}章\.json$/.test(f))) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(sentDir, file), "utf-8"));
        for (const s of data.sentences ?? []) {
          const t = (s.text ?? "").replace(SENT_CLEAN_RE, "");
          for (let i = 0; i < t.length; i++) {
            unigram.set(t[i], (unigram.get(t[i]) ?? 0) + 1);
            total++;
            if (i < t.length - 1) {
              const g = t.slice(i, i + 2);
              bigram.set(g, (bigram.get(g) ?? 0) + 1);
            }
          }
        }
      } catch { /* 跳过 */ }
    }
  }
  return { unigram, bigram, total };
}

/**
 * PMI 切词器（基于 PMI 表）：文本 → 词数组。
 * 规则：停用字（CUT_CHARS）强制切分；相邻两字 PMI ≥ 阈值 且 共现 ≥ minCount → 不切（词内）；
 *       否则切。词长上限 MAX_WORD。
 * 接受误伤：非 label 词可能切碎（如「庙会」→庙/会），但 label 整体词（主源）不受影响。
 */
export function pmiCut(text, table, opts = {}) {
  const { unigram, bigram, total } = table;
  const minPmi = opts.minPmi ?? 2.0;
  const minCount = opts.minCount ?? 3;
  const maxWord = opts.maxWord ?? 6;
  const pmi = (a, b) => {
    const ab = bigram.get(a + b) ?? 0;
    if (ab < minCount) return -1;
    const pa = (unigram.get(a) ?? 0) / total, pb = (unigram.get(b) ?? 0) / total, pab = ab / total;
    return Math.log2(pab / (pa * pb));
  };
  const words = [];
  let i = 0;
  const len = text.length;
  while (i < len) {
    if (CUT_CHARS.has(text[i])) { i++; continue; }
    let lastGood = i, j = i + 1;
    while (j < len) {
      if (CUT_CHARS.has(text[j])) break;
      if (pmi(text[j - 1], text[j]) >= minPmi) { lastGood = j; j++; } else break;
      if (j - i > maxWord) break;
    }
    const word = text.slice(i, lastGood + 1);
    if (word.length >= 1) words.push(word);
    i = lastGood + 1;
  }
  return words;
}

/**
 * 实体词典构建（每书一份）：以该书分镜 label 为主源（人写的浓缩词 = 天然真实词，整体入词，不受 PMI 误伤），
 * 次源用 PMI 切词器从该书句子 text 提取真词（替代旧滑窗，消除跨词碎片污染），频率 ≥ 阈值。
 * @param {object} opts { book?: string } 指定书；缺省 = 遍历 store 两域全部书，各建一份
 * @returns {object|null} 单书构建返回 payload；多书返回 null（逐书打印）
 */
function buildDict(opts = {}) {
  const books = opts.book ? [opts.book] : listProjects();
  if (!books.length) { console.log("[词典] 无项目（store 两域为空），跳过"); return null; }
  let last = null;
  for (const project of books) {
    last = buildDictFor(project, opts);
  }
  return last;
}

/** 构建单书词典 */
function buildDictFor(project, opts = {}) {
  const outDir = dictDirOf(project);
  fs.mkdirSync(outDir, { recursive: true });

  // ① label 词集（主源：人写的浓缩词，整体入词）
  const labelWords = new Set();
  {
    const shotDir = path.join(projectRoot(project), "分镜标注", "json");
    if (fs.existsSync(shotDir)) {
      for (const file of fs.readdirSync(shotDir).filter((f) => /^第\d{4}章\.json$/.test(f))) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(shotDir, file), "utf-8"));
          for (const s of data.shots ?? []) {
            const label = (s.label ?? "").trim();
            if (label && !DICT_STOPWORDS.has(label) && label.length >= 2 && label.length <= 8) {
              labelWords.add(label);
            }
          }
        } catch { /* 跳过 */ }
      }
    }
  }

  // ② 高频真词补充（次源：该书 PMI 切词器从句子 text 提取真词，频率 ≥ minFreq）
  const pmiTable = buildPmiTable([project]);
  const freq = new Map();
  {
    const sentDir = path.join(projectRoot(project), "句子标注", "json");
    if (fs.existsSync(sentDir)) {
      for (const file of fs.readdirSync(sentDir).filter((f) => /^第\d{4}章\.json$/.test(f))) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(sentDir, file), "utf-8"));
          for (const s of data.sentences ?? []) {
            const clean = (s.text ?? "").replace(SENT_CLEAN_RE, "");
            for (const w of pmiCut(clean, pmiTable, opts)) {
              if (w.length >= 2 && w.length <= 4 && !DICT_STOPWORDS.has(w)) {
                freq.set(w, (freq.get(w) ?? 0) + 1);
              }
            }
          }
        } catch { /* 跳过 */ }
      }
    }
  }
  // PMI 判出的词是真词（可信，无碎片），频次阈值可远低于滑窗方案：
  // 滑窗需 minFreq=20 筛碎片；PMI 已按词边界筛过，真词出现 3-5 次即可入词典（低频真词如 手炉/奚落/庙会 也能收录）
  const minFreq = opts.minFreq ?? 3;
  const highFreqWords = [...freq.entries()]
    .filter(([, c]) => c >= minFreq)
    .map(([g]) => g);

  // 合并：label 词全部保留 + PMI 高频真词补充（去重）
  const entities = [...new Set([...labelWords, ...highFreqWords])];

  const payload = {
    schema: "dsh/entity-dict/v1",
    scope: "book", // 每书一份
    project,
    derivedFrom: {
      projects: [project],
      sourceState: scanSourceState({ projects: [project] }), // 该书覆盖清单（调用前对比用）
      builtAt: new Date().toISOString(),
    },
    stats: {
      entityCount: entities.length,
      labelWords: labelWords.size,
      highFreqWords: highFreqWords.length,
      minFreq,
      dictMethod: "label + PMI-cut", // 词典构建方法标注
    },
    entities,
  };
  const outFile = path.join(outDir, "entity-dict.json");
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), "utf-8");
  console.log(`[词典] ${project}: 已构建 ${entities.length} 个实体（label ${labelWords.size} + PMI高频 ${highFreqWords.length}）→ ${outFile}`);
  return payload;
}

/* ========== 四表索引构建（lexical-index.json：byFunc/byType/byEntity/byGram） ========== */

/**
 * 【后期扩容预备】四表倒排索引（lexical-index.json）当前**不被检索路径消费**——
 * 检索的标签/切词通道走实时扫盘（scanAllShots + labelRecall/tokenRecall）。
 * 除非落实「查询读索引」设计（方向 C 的索引消费侧），否则本函数输出提示并跳过构建，
 * 避免白耗构建时间与磁盘（四表在 1000 章规模才值得启用）。
 * @returns {null} 始终返回 null（预备态：不构建）
 */
function buildLexicalIndex() {
  console.log("[索引] 四表索引为后期扩容预备（当前检索走实时扫盘，索引消费设计未落实）——跳过构建");
  return null;
}

/* ========== 向量构建（全域，增量） ========== */

/** 收集 [project, chapter] 待处理列表 */
function collectVectorJobs(projects) {
  const jobs = [];
  for (const project of projects) {
    const shotDir = path.join(projectRoot(project), "分镜标注", "json");
    if (!fs.existsSync(shotDir)) continue;
    for (const file of fs.readdirSync(shotDir).filter((f) => /^第\d{4}章\.json$/.test(f))) {
      jobs.push({ project, chapter: parseInt(file.match(/\d+/)[0], 10) });
    }
  }
  return jobs;
}

/** 构建单章向量 */
async function buildChapterVectors(project, chapter, embedCfg) {
  const shots = scanAllShots({ projects: [project] }).filter((s) => s.chapter === chapter);
  if (shots.length === 0) return null;
  const texts = shots.map((s) => shotToText(s));
  let embeddings;
  try {
    const client = createEmbed(embedCfg);
    embeddings = await client.embedTexts(texts);
  } catch (err) {
    console.error(`[向量] ${project} 第${padChapter(chapter)}章嵌入失败: ${err.message.slice(0, 80)}`);
    return null;
  }
  const vectors = shots.map((s, i) => ({
    project: s.project,
    shotId: s.shotId,
    type: s.type,
    funcs: s.funcs ?? [],
    label: s.label ?? "",
    chapter: s.chapter,
    sentenceIds: s.sentenceIds ?? [],
    embedding: embeddings[i],
  }));
  return {
    vectors,
    payload: {
      schema: "dsh/vector-store/v1",
      project,
      chapter: { number: chapter },
      embedding: { provider: "siliconflow", model: embedCfg.model, dimension: embedCfg.dimension },
      vectors,
    },
  };
}

/** 构建/增量更新向量库（每书独立 index + 向量文件，书间重算隔离） */
async function buildVectors(opts = {}) {
  const ready = opts.embedCfg
    ? { ok: true, cfg: opts.embedCfg }
    : await ensureEmbedReady({ waitForFill: opts.waitForFill, waitMs: opts.waitMs, attempts: opts.attempts });
  if (!ready.ok) {
    // agent 友好：返回结构化信号，由调用方/LLM 用自然语言提示用户
    const signal = {
      ok: false,
      status: ready.status ?? "embed_not_ready",
      reason: ready.reason ?? "embed 未配置",
      guidance: ready.guidance ?? "请在 config.json 的 embed 段填入 apiKey 与 model。",
      action: "skip_vector_build",
    };
    console.error(`[向量] ${signal.reason}（RAG 召回通道无响应）——跳过向量构建。${signal.guidance}`);
    return signal;
  }
  const embedCfg = ready.cfg;

  const projects = opts.projects?.length ? opts.projects : listProjects();

  let totalBuilt = 0, totalSkipped = 0, totalShots = 0, totalChapters = 0;
  for (const project of projects) {
    const r = await buildProjectVectors(project, embedCfg, opts);
    totalBuilt += r.built;
    totalSkipped += r.skipped;
    totalShots += r.index.stats?.totalShots ?? 0;
    totalChapters += r.index.stats?.totalChapters ?? 0;
  }

  console.log(`[向量] 全部完成：构建 ${totalBuilt} 章，跳过 ${totalSkipped} 章，总量 ${totalShots} 分镜 / ${totalChapters} 章（${projects.length} 书）`);
  return { ok: true, stats: { totalBuilt, totalSkipped, totalShots, totalChapters } };
}

/** 构建单书向量（增量：章 mtime 对比；reset/模型变更 → 该书全量） */
async function buildProjectVectors(project, embedCfg, opts = {}) {
  const vDir = vectorDirOf(project);
  const vIndexFile = vectorIndexFileOf(project);
  fs.mkdirSync(vDir, { recursive: true });

  const jobs = collectVectorJobs([project]);
  const index = fs.existsSync(vIndexFile) ? JSON.parse(fs.readFileSync(vIndexFile, "utf-8")) : { chapters: {} };

  // 模型变更 / --reset → 该书全量重建
  if (opts.reset || index.embedding?.model !== embedCfg.model || index.embedding?.dimension !== embedCfg.dimension) {
    console.log(`[向量] ${project}: embed 配置变更或 --reset，全量重建`);
    fs.rmSync(vDir, { recursive: true, force: true });
    fs.mkdirSync(vDir, { recursive: true });
    index.chapters = {};
  }

  let built = 0, skipped = 0;
  for (const { project: pj, chapter } of jobs) {
    const key = `${pj}:${chapter}`;
    const existing = index.chapters[key];
    const shotFile = shotJsonPath(pj, chapter);
    const shotMtime = fs.existsSync(shotFile) ? fs.statSync(shotFile).mtime.toISOString() : null;
    if (!opts.reset && existing && existing.sourceMtime === shotMtime) {
      skipped++;
      continue;
    }
    const data = await buildChapterVectors(pj, chapter, embedCfg);
    if (!data) { skipped++; continue; }
    const outFile = path.join(vDir, `${pj}-${padChapter(chapter)}.json`);
    fs.writeFileSync(outFile, JSON.stringify(data.payload), "utf-8");
    index.chapters[key] = {
      project: pj, chapter,
      file: path.relative(vDir, outFile).replaceAll("\\", "/"),
      shotCount: data.vectors.length,
      sourceMtime: shotMtime,
      lastEmbedded: new Date().toISOString(),
    };
    built++;
  }

  index.schema = "dsh/vector-index/v1";
  index.project = project;
  index.embedding = { provider: "siliconflow", model: embedCfg.model, dimension: embedCfg.dimension };
  index.projects = [project];
  index.stats = {
    totalShots: Object.values(index.chapters).reduce((a, c) => a + c.shotCount, 0),
    totalChapters: Object.keys(index.chapters).length,
  };
  index.updatedAt = new Date().toISOString();
  // 原子切换：先写临时文件，再 rename 覆盖（防读到半写索引）
  const tmpFile = `${vIndexFile}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(index, null, 2), "utf-8");
  fs.renameSync(tmpFile, vIndexFile);

  console.log(`[向量] ${project}: 构建 ${built} 章，跳过 ${skipped} 章，总量 ${index.stats.totalShots} 分镜 / ${index.stats.totalChapters} 章`);
  return { built, skipped, index };
}

/* ========== 主入口 ========== */
async function main() {
  const args = process.argv.slice(2);
  const doDict = args.includes("--dict") || args.includes("--all");
  const doIndex = args.includes("--index") || args.includes("--all");
  const doVector = args.includes("--vector") || args.includes("--all");
  const reset = args.includes("--reset-vector");
  const book = (() => {
    const a = args.find((x) => x.startsWith("--book="));
    return a ? a.slice("--book=".length) : null;
  })();

  if (doDict) buildDict({ book });
  if (doIndex) buildLexicalIndex();
  if (doVector) await buildVectors({ reset, projects: book ? [book] : undefined });
  if (!doDict && !doIndex && !doVector) {
    console.error("用法: node retriever/build-derived.mjs [--dict] [--index] [--vector] [--all] [--reset-vector] [--book=<书>]");
    process.exit(1);
  }
}

// 允许作为模块导入（供 ensure 逻辑调用），直接运行时执行 main
if (process.argv[1] && path.resolve(process.argv[1]).endsWith(".mjs") && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

export { buildDict, buildLexicalIndex, buildVectors };
