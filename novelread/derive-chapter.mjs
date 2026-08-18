/**
 * derive-chapter.mjs — 派生字段生成器（冗余字段脚本化，数据结构不变）
 *
 * 职责：每章落盘后无条件生成派生字段（LLM 不输出这些键，唯一写入者是本脚本）：
 *   shotId         句子 JSON  ← 从分镜 sentenceIds 反查（权威=分镜引用）
 *   sentenceRange  分镜 JSON  ← 从本镜 sentenceIds 算 min/max（权威=同对象 ids）
 *   stats          章节标注    ← 从分镜 type/funcs + 句子 struct/text 扫标签聚合
 *   suspense       章节标注    ← 从分镜 funcs 含「悬念」聚合
 *
 * 不代做（LLM 语义错误，只检测不猜）：
 *   分镜 sentenceIds 覆盖不完整（句子无归属）→ note 记录，交 fix / 形态2
 *
 * 用法：
 *   import { deriveChapter } from "./derive-chapter.mjs";   // host 落盘后调用
 *   node novelread/derive-chapter.mjs <project> <章号>       # 单章
 *   node novelread/derive-chapter.mjs <project> --all        # 全书兜底（已标注章）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkJsonText } from "./verify-json.mjs";
import { storeDir } from "../shared/paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SENT_FILE = (dir, ch) => path.join(dir, "句子标注", "json", `第${String(ch).padStart(4, "0")}章.json`);
const SHOT_FILE = (dir, ch) => path.join(dir, "分镜标注", "json", `第${String(ch).padStart(4, "0")}章.json`);
const CH_FILE = (dir, ch) => path.join(dir, "章节", `第${String(ch).padStart(4, "0")}章.json`);

function readJson(p) {
  if (!fs.existsSync(p)) return null;
  const v = checkJsonText(fs.readFileSync(p, "utf-8"));
  if (!v.ok) return null; // 语法非法：不生成派生字段（由形态2/4 处理）
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

/**
 * 生成一章的派生字段。
 * @param {string} projectDir store/<project>project/
 * @param {number} ch 章号
 * @returns {{derived: string[], note: string[], ok: boolean}}
 */
export function deriveChapter(projectDir, ch) {
  const derived = [];
  const note = [];
  const chStr = String(ch).padStart(4, "0");

  const sentJson = readJson(SENT_FILE(projectDir, ch));
  const shotJson = readJson(SHOT_FILE(projectDir, ch));
  const chJson = readJson(CH_FILE(projectDir, ch));

  /* ---- 1. shotId 回填（句子 ← 分镜 sentenceIds 反查） ---- */
  if (sentJson && shotJson) {
    const shotOf = {};
    for (const sh of shotJson.shots ?? []) {
      for (const id of sh.sentenceIds ?? []) shotOf[id] = sh.id;
    }
    const sents = sentJson.sentences ?? [];
    let changed = false, orphan = 0;
    for (const s of sents) {
      const target = shotOf[s.id];
      if (target === undefined) { orphan++; continue; }
      if (s.shotId !== target) { s.shotId = target; changed = true; }
    }
    if (changed) fs.writeFileSync(SENT_FILE(projectDir, ch), JSON.stringify(sentJson, null, 2) + "\n", "utf-8");
    derived.push("shotId");
    if (orphan > 0) note.push(`分镜覆盖不完整：${orphan} 句无归属（需 LLM 定向修复，脚本不猜归属）`);
  }

  /* ---- 2. sentenceRange 重算（分镜内部，ids → min/max） ---- */
  if (shotJson) {
    const shots = shotJson.shots ?? [];
    let changed = false;
    for (const sh of shots) {
      const seqs = (sh.sentenceIds ?? []).map((id) => Number(id.slice(1)));
      if (!seqs.length) continue;
      const min = Math.min(...seqs), max = Math.max(...seqs);
      if (sh.sentenceRange?.[0] !== min || sh.sentenceRange?.[1] !== max) {
        sh.sentenceRange = [min, max];
        changed = true;
      }
    }
    if (changed) fs.writeFileSync(SHOT_FILE(projectDir, ch), JSON.stringify(shotJson, null, 2) + "\n", "utf-8");
    derived.push("sentenceRange");
  }

  /* ---- 3. stats + 4. suspense（章节标注 ← 扫分镜/句子标签） ---- */
  if (chJson && shotJson) {
    const sents = sentJson?.sentences ?? [];
    const shots = shotJson.shots ?? [];
    const shotTypeDist = {}, funcDist = {};
    for (const sh of shots) {
      shotTypeDist[sh.type] = (shotTypeDist[sh.type] ?? 0) + 1;
      for (const f of sh.funcs ?? []) funcDist[f] = (funcDist[f] ?? 0) + 1;
    }
    const short = sents.filter((s) => (s.text ?? "").replace(/\s/g, "").length <= 12).length;
    const cluster = sents.filter((s) => s.struct === "句从").length;
    const stats = {
      sentenceCount: sents.length,
      shotCount: shots.length,
      shotTypeDist,
      funcDist,
      shortSentenceRate: +(short / (sents.length || 1)).toFixed(2),
      sentenceClusterRate: +(cluster / (sents.length || 1)).toFixed(2),
    };
    const suspense = shots.filter((sh) => (sh.funcs ?? []).includes("悬念"))
      .map((sh) => ({ shot: sh.id, label: sh.label ?? "", sentenceRange: sh.sentenceRange ?? [0, 0] }));

    let changed = false;
    if (JSON.stringify(chJson.stats) !== JSON.stringify(stats)) { chJson.stats = stats; changed = true; }
    if (JSON.stringify(chJson.suspense ?? []) !== JSON.stringify(suspense)) { chJson.suspense = suspense; changed = true; }
    if (changed) fs.writeFileSync(CH_FILE(projectDir, ch), JSON.stringify(chJson, null, 2) + "\n", "utf-8");
    derived.push("stats", "suspense");
  }

  return { derived, note, ok: note.length === 0 };
}

/* ---------- CLI ---------- */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const project = args.find((a) => !a.startsWith("--"));
  const chNum = Number(args.find((a) => /^\d+$/.test(a)));
  const doAll = args.includes("--all");
  const projectDir = path.join(storeDir, `${project}project`);
  if (!fs.existsSync(projectDir)) { console.error(`project 不存在: ${projectDir}`); process.exit(2); }

  if (doAll) {
    // 全书兜底：扫语料分章目录取已标注章
    const splitDir = path.join(projectDir, "语料分章");
    const chs = fs.existsSync(splitDir)
      ? fs.readdirSync(splitDir).map((f) => f.match(/^第0*(\d+)章/)?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b)
      : [];
    console.log(`\n========== 派生字段全书兜底：${project}（${chs.length} 章） ==========`);
    let fixedChapters = 0, noteCount = 0;
    for (const ch of chs) {
      const r = deriveChapter(projectDir, ch);
      if (r.derived.length) { fixedChapters++; console.log(`  [${String(ch).padStart(4, "0")}] 生成: ${r.derived.join("/")}`); }
      for (const n of r.note) { noteCount++; console.log(`  ⚠ [${String(ch).padStart(4, "0")}] ${n}`); }
    }
    console.log(`\n✅ 全书派生完成：${fixedChapters} 章更新了派生字段${noteCount ? `，${noteCount} 条覆盖不完整需 LLM 修复` : ""}`);
    process.exit(noteCount ? 1 : 0);
  }

  if (!Number.isInteger(chNum)) { console.error("用法: node novelread/derive-chapter.mjs <project> <章号> | <project> --all"); process.exit(2); }
  const r = deriveChapter(projectDir, chNum);
  console.log(`\n===== 派生字段生成：${project} 第${String(chNum).padStart(4, "0")}章 =====`);
  for (const d of r.derived) console.log(`  ✅ ${d}`);
  for (const n of r.note) console.log(`  ⚠ ${n}`);
  console.log(r.ok ? "\n✅ 派生字段已生成（无覆盖问题）" : "\n⚠ 存在覆盖不完整（需 LLM 修复）");
  process.exit(r.ok ? 0 : 1);
}
