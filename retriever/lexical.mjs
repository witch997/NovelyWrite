/**
 * lexical.mjs — 标签通道 + 切词通道（确定性代码，零 API 成本）
 *
 * 数据源：
 *  - 标签通道：分镜标注 JSON 的 type/funcs（事实层，直接扫描）
 *  - 切词通道：分镜 label（浓缩情境）与整镜原文（事实层，回源句子 JSON）
 *              ——词典（entity-dict）是 tokenize 的切词依据（label 整体词 + PMI 真词）
 *
 * 通道逻辑（已确认决策）：
 *  标签通道：**本质是跨书噪声源**——给写作 LLM 提供标签相近的跨书参考（多样性，不追求精确）。
 *            精确同类池（funcs 全命中）→ 确定性取 1（高基准分 2.0）
 *            然后**用满本通道配额**：剩余 quota.label-1 条由降级候选填满（funcs 部分命中 +2 / type 命中 +0.5，
 *            排除已精确命中的分镜；不排序语义——分数仅通道内相对度量，合并后 LLM 自行权衡）
 *            精确池空 → 纯降级填满 quota.label；全不命中 → 空
 *
 *  切词通道：**情境/内容相近的参考素材召回**（扁平词重叠匹配）——
 *            查询词典切词 → 与每个分镜的 label 词/正文词求交集（词重叠）→ 命中。
 *            匹配方式：词典切词（纯词典最大匹配，无 2-gram——避免碎片）；子词命中
 *            （如 庙会 → 庙会傍晚）由「label 包含匹配」兜底。
 *            **素材供给（软排序）**：命中次数最高的 1 条作代表，剩余配额随机取（多样性）。
 *  （注：四表索引（lexical-index.json）为后期扩容预备——当前检索走实时扫描，见 build-derived.mjs）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { storeDir, dictDir, projectRoot, shotJsonPath, shotToText, padChapter } from "./rag-core.mjs";

/* ---------- 全域实体词典（store/派生/词典/entity-dict.json） ---------- */
let _dictCache = null; // { entities: string[]（按长度降序）, derivedFrom }

export function loadEntityDict() {
  if (_dictCache) return _dictCache;
  const file = path.join(dictDir, "entity-dict.json");
  if (!fs.existsSync(file)) {
    _dictCache = { entities: [], derivedFrom: null };
    return _dictCache;
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    const entities = (data.entities ?? []).map((e) => (typeof e === "string" ? e : e.text)).filter(Boolean);
    // 最长优先（最大匹配）
    entities.sort((a, b) => b.length - a.length);
    // 首字索引：字 → 该字开头的词列表（tokenize 用——避免线性遍历全词典，性能关键：
    //   线性 O(正文长×词典长) ≈ 7s/1143镜；首字索引 O(正文长×候选数) ≈ 58ms，快 ~120 倍，10万镜 ~5s）
    const byFirstChar = new Map();
    for (const e of entities) {
      const ch = e[0];
      if (!byFirstChar.has(ch)) byFirstChar.set(ch, []);
      byFirstChar.get(ch).push(e);
    }
    _dictCache = { entities, byFirstChar, derivedFrom: data.derivedFrom ?? null };
  } catch {
    _dictCache = { entities: [], byFirstChar: new Map(), derivedFrom: null };
  }
  return _dictCache;
}

/** 词典版本戳（供调用方对比源变化） */
export function dictVersion() {
  return loadEntityDict().derivedFrom;
}

/* ---------- 切词（纯词典最大匹配，无 2-gram 兜底） ---------- */
/**
 * 词典切词：正向最大匹配（最长优先），只切词典里有的词。
 * 设计目的：词典由 label 整体词 + PMI 真词构成（已去碎片），切词只认词典词——
 *   无 2-gram 兜底（避免碎片噪音，如 树识/破黑/会傍）。
 * 代价：词典外的文本被逐字跳过（无产出）；「庙会傍晚」只切出整体，不产子词「庙会」
 *   ——子词命中由调用方处理（见 tokenRecall 的 label 包含匹配）。
 */
export function tokenize(text) {
  const clean = (text ?? "").replace(/[\[\]（）()【】「」、，。！？：；“”"'《》\s\n]/g, " ");
  const { byFirstChar } = loadEntityDict();
  const tokens = [];
  let remaining = clean;
  while (remaining.trim()) {
    const ch = remaining[0];
    const candidates = byFirstChar.get(ch) ?? []; // 首字候选（~6 个，替代全词典 12239 个）
    let matched = false;
    for (const ent of candidates) {
      if (remaining.startsWith(ent)) {
        tokens.push(ent);
        remaining = remaining.slice(ent.length);
        matched = true;
        break;
      }
    }
    if (!matched) remaining = remaining.slice(1);
  }
  return tokens;
}

/* ---------- 事实层扫描：收集全部 project 的全部分镜 ---------- */
/** store 下所有 <语料名>project 目录名 */
export function listProjects() {
  if (!fs.existsSync(storeDir)) return [];
  return fs.readdirSync(storeDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.endsWith("project"))
    .map((d) => d.name.replace(/project$/, ""));
}

/**
 * 扫描全部 store 分镜，返回 {project, chapter, shotId, type, funcs, label, sentenceIds, chapterNum}
 * @param {object} opts { projects?: string[] } 限定范围
 */
export function scanAllShots(opts = {}) {
  const projects = opts.projects ?? listProjects();
  const shots = [];
  for (const project of projects) {
    const shotDir = path.join(projectRoot(project), "分镜标注", "json");
    if (!fs.existsSync(shotDir)) continue;
    const files = fs.readdirSync(shotDir).filter((f) => /^第\d{4}章\.json$/.test(f));
    for (const file of files) {
      const chapter = parseInt(file.match(/\d+/)[0], 10);
      const shotPath = shotJsonPath(project, chapter);
      if (!fs.existsSync(shotPath)) continue;
      try {
        const data = JSON.parse(fs.readFileSync(shotPath, "utf-8"));
        for (const s of data.shots ?? []) {
          shots.push({
            project,
            chapter,
            shotId: s.id,
            type: s.type,
            funcs: s.funcs ?? [],
            label: s.label ?? "",
            sentenceIds: s.sentenceIds ?? [],
          });
        }
      } catch { /* 跳过损坏文件 */ }
    }
  }
  return shots;
}

/* ---------- 标签通道 ---------- */
/**
 * 标签通道召回
 * @param {object} query { type?, funcs? }
 * @param {object} opts { shots?, topk? }
 * @returns {object[]} hits: {shot, score, source:"label"}
 */
export function labelRecall(query, opts = {}) {
  const shots = opts.shots ?? scanAllShots();
  const funcs = query.funcs ?? [];
  const type = query.type;
  const topk = opts.topk ?? 2;

  // ① 精确同类池：funcs 全命中（type 命中优先）
  const exactPool = shots.filter((s) =>
    funcs.length > 0 && funcs.every((f) => s.funcs.includes(f)) &&
    (type ? s.type === type : true)
  );
  const result = [];
  if (exactPool.length > 0) {
    // 确定性取 1（可复现）：用 查询签名 + 池大小 做 seed 的伪随机，不用 Math.random
    // 查询签名 = type + funcs 排序拼接（同查询恒同 seed → 同结果，测试/调试稳定）
    const seedStr = `${type ?? ""}|${[...funcs].sort().join(",")}|${exactPool.length}`;
    let h = 2166136261;
    for (const ch of seedStr) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    const idx = (h >>> 0) % exactPool.length;
    result.push({ shot: exactPool[idx], score: 2.0, source: "label" });
  }

  // ② 用满配额：精确取 1 后，剩余配额由降级候选填充（funcs 部分命中 +2 / type 命中 +0.5）
  //    降级候选排除已精确命中的分镜（避免重复）
  const excluded = new Set(result.map((r) => r.shot));
  const scores = new Map(); // shot → {shot, score}
  for (const s of shots) {
    if (excluded.has(s)) continue;
    let score = 0;
    let hit = false;
    for (const f of funcs) {
      if (s.funcs.includes(f)) { score += 2; hit = true; }
    }
    if (type && s.type === type) { score += 0.5; hit = true; }
    if (hit) scores.set(s, { shot: s, score });
  }
  const ranked = [...scores.values()].sort((a, b) => b.score - a.score);
  result.push(...ranked.slice(0, Math.max(0, topk - result.length)).map((r) => ({ ...r, source: "label" })));

  return result;
}

/* ---------- 切词通道 ---------- */
/**
 * 切词通道召回——情境/内容相近的参考素材（词重叠匹配，素材供给）
 *
 * 设计目的（详见文件头注释）：
 *  - 匹配方式：词典切词（tokenize，纯词典最大匹配无 2-gram）→ 查询词集 ∩ 分镜词集（词重叠）
 *  - 命中判定：label 词重叠 / label 包含匹配（庙会 ⊆ 庙会傍晚，覆盖子词）/ 正文词重叠
 *  - **素材供给（软排序）**：命中次数最高的 1 条作代表（确定性），
 *    剩余 topk-1 条从其余命中里随机取（多样性）——不全局评分排序，LLM 自行取舍
 *
 * @param {object} query { text }
 * @param {object} opts { shots?, topk? }
 * @returns {object[]} hits: {shot, source:"token"}
 */
export function tokenRecall(query, opts = {}) {
  const shots = opts.shots ?? scanAllShots();
  const q = (query.text ?? "").replace(/[，。！？…、；：""''（）《》\s]/g, "");
  if (q.length < 2) return [];
  const topk = opts.topk ?? 2;

  const qTokens = tokenize(q);            // 查询词典切词
  const qSet = new Set(qTokens);
  const qRaw = q;                          // 原始查询（label 包含匹配用）

  const hits = []; // {shot, count} —— 命中分镜 + 命中次数（词重叠数）

  for (const s of shots) {
    let count = 0;

    // label 词重叠 + label 包含匹配兜底（子词命中，如 庙会 ⊆ 庙会傍晚）
    const label = (s.label ?? "").replace(/[\s]/g, "");
    if (label.length >= 2) {
      const lTokens = tokenize(label);
      count += lTokens.filter((t) => qSet.has(t)).length;
      if (label.includes(qRaw) || qRaw.includes(label)) count = Math.max(count, 1);
    }

    // 正文词重叠（预过滤：正文含查询 ≥2 字符才切词，性能）
    const text = shotToText(s);
    if (text.length >= qRaw.length) {
      let shared = 0;
      for (const ch of new Set(qRaw)) if (text.includes(ch)) shared++;
      if (shared >= 2) {
        const tTokens = tokenize(text);
        count += tTokens.filter((t) => qSet.has(t)).length;
      }
    }

    if (count > 0) hits.push({ shot: s, count });
  }

  // 素材供给（软排序）：命中次数最高的 1 条作代表（确定性：并列取先扫到的），
  // 剩余 topk-1 条从其余命中里随机取（多样性，LLM 自行取舍）
  if (!hits.length) return [];
  hits.sort((a, b) => b.count - a.count);
  const top = hits.shift();
  const rest = hits;
  const pick = [top.shot];
  while (pick.length < topk && rest.length) {
    const idx = Math.floor(Math.random() * rest.length);
    pick.push(rest.splice(idx, 1)[0].shot);
  }
  return pick.map((shot) => ({ shot, source: "token" }));
}
