#!/usr/bin/env node
/**
 * resplit-dialogs.mjs — 长对话分镜重标（按话题切换拆分为多个分镜）
 *
 * 背景：红楼梦长对话分镜（>150字 type=对话）一个分镜承载整场多话题对话，
 *   粒度错配（参考文本过长）+ 风格过拟合（整段长文作参考）。
 * 方案：按「话题切换」切分——LLM 读原分镜的句子序列，输出每个句子的分镜归属
 *   （话题段），脚本按归属重建分镜（type/funcs/label 由 LLM 给）。
 *
 * 关键设计：
 *   - 句子是权威源（不改句子），只重排「句子 → 分镜」归属
 *   - LLM 输出：每个句子属于哪个新分镜（segment 编号）+ 每段 type/funcs/label
 *   - 脚本校验：无缝覆盖原句子（不丢不漏）、段连续
 *   - 产出：新分镜 JSON（覆盖原分镜，其余分镜不动）
 *
 * 用法：
 *   node novelread/resplit-dialogs.mjs --dry-run   # 只检测范围，不调 LLM
 *   node novelread/resplit-dialogs.mjs --chapter 57   # 只处理指定章
 *   node novelread/resplit-dialogs.mjs --all           # 全部长对话分镜
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { storeDir } from "../shared/paths.mjs";
import { loadChatConfig } from "../shared/config.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const project = "红楼梦";
const projectDir = path.join(storeDir, `${project}project`);
const shotDir = path.join(projectDir, "分镜标注", "json");
const sentDir = path.join(projectDir, "句子标注", "json");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const doAll = args.includes("--all");
const chapterArg = (args.find((a) => a.startsWith("--chapter="))?.split("=")[1])
  ?? (args.indexOf("--chapter") >= 0 ? args[args.indexOf("--chapter") + 1] : null);

const MIN_LEN = 150; // 长对话阈值

/* ---------- LLM 客户端（thinking 禁用——结构化判定） ---------- */
const chatCfg = loadChatConfig();
const baseUrl = (chatCfg.baseUrl ?? "https://api.deepseek.com/v1").replace(/\/+$/, "");
async function chat(messages, maxTokens = 8192) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${chatCfg.apiKey}` },
    body: JSON.stringify({ model: chatCfg.model, messages, stream: true, max_tokens: maxTokens, thinking: { type: "disabled" } }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
  return out;
}

/* ---------- 读句子（权威源） ---------- */
function loadSentences(chapter) {
  const p = path.join(sentDir, `第${String(chapter).padStart(4, "0")}章.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8")).sentences ?? [];
}

/* ---------- 检测长对话分镜 ---------- */
function findLongDialogs(chapter) {
  const p = path.join(shotDir, `第${String(chapter).padStart(4, "0")}章.json`);
  if (!fs.existsSync(p)) return null;
  const d = JSON.parse(fs.readFileSync(p, "utf-8"));
  const sents = loadSentences(chapter);
  if (!sents) return null;
  const byId = Object.fromEntries(sents.map((s) => [s.id, s.text]));
  const longShots = [];
  for (const s of d.shots ?? []) {
    if (s.type !== "对话") continue;
    const text = (s.sentenceIds ?? []).map((id) => byId[id] ?? "").join("");
    if (text.length > MIN_LEN) {
      longShots.push({ shot: s, text });
    }
  }
  return { data: d, sents, byId, longShots };
}

/* ---------- LLM 话题切分 ---------- */
const SPLIT_SYSTEM = `你是网文分镜分析师。把一个"长对话分镜"按话题切换拆分为多个新分镜。

输入：原分镜的句子序列（每句有 S# 和文本）。
要求：
1. 按【话题切换】切分：对话中话题变化（说话人组合变/话题对象变/情绪基调变/插入新叙事动作）= 新分镜
2. 每句必须归属且仅归属一个新分镜（连续，不跳号）
3. 每个新分镜给：type（对话/动作/事件/心理/信息/环境）/ funcs（1-3个：塑造人物/引入世界观/设置动机/推进/铺垫/反转/爆发/转场/收束分镜/悬念）/ label（2-6字）
4. 单句对话如果自成话题段，可单独一个分镜（宁细勿粗）
5. 输出 JSON：{"segments":[{"sentIds":["S1","S2"],"type":"对话","funcs":["推进"],"label":"问候"},...]}
只输出这个 JSON。`;

/* ---------- 应用切分：重建分镜数组 ---------- */
function applySplit(shot, segments, byId) {
  // 校验：所有原句子都被覆盖且连续
  const origIds = shot.sentenceIds ?? [];
  const covered = segments.flatMap((seg) => seg.sentIds ?? []);
  const origSet = new Set(origIds);
  // 校验覆盖完整
  const miss = origIds.filter((id) => !covered.includes(id));
  const extra = covered.filter((id) => !origSet.has(id));
  const dup = covered.filter((id, i) => covered.indexOf(id) !== i);
  if (miss.length || extra.length || dup.length) {
    return { ok: false, reason: `覆盖校验失败: 缺${miss.length} 多${extra.length} 重${dup.length}` };
  }
  // 校验连续（segments 内的 sentIds 顺序与原文一致）
  const seq = covered.join(",");
  const origSeq = origIds.join(",");
  if (seq !== origSeq) return { ok: false, reason: "句子顺序被重排（应保持原序）" };

  // 构建新分镜
  const newShots = segments.map((seg, i) => {
    const ids = seg.sentIds ?? [];
    const seqs = ids.map((id) => Number(id.slice(1)));
    return {
      id: 0, // 占位，稍后重排
      type: seg.type ?? "对话",
      funcs: (seg.funcs ?? []).slice(0, 3),
      label: (seg.label ?? "").slice(0, 10),
      sentenceIds: ids,
      note: "",
      sentenceRange: [Math.min(...seqs), Math.max(...seqs)],
    };
  });
  return { ok: true, newShots };
}

/* ---------- 主流程 ---------- */
async function main() {
  const chapters = doAll
    ? fs.readdirSync(shotDir).filter((f) => /^第\d{4}章\.json$/.test(f)).map((f) => Number(f.match(/\d+/)[0])).sort((a, b) => a - b)
    : chapterArg ? [Number(chapterArg)] : [];
  if (!chapters.length) { console.error("用法: --all | --chapter=N"); process.exit(2); }

  let totalLong = 0, totalSplit = 0, errors = 0;
  for (const chapter of chapters) {
    const found = findLongDialogs(chapter);
    if (!found || !found.longShots.length) { console.log(`第${chapter}章: 无长对话`); continue; }
    console.log(`\n第${chapter}章: ${found.longShots.length} 个长对话分镜`);
    totalLong += found.longShots.length;

    if (dryRun) {
      found.longShots.forEach(({ shot, text }) => console.log(`  [dry] 镜${shot.id} ${text.length}字「${shot.label}」`));
      continue;
    }

    const { data, sents, byId } = found;
    const newShotsMap = new Map(); // 原分镜 id → 新分镜数组
    for (const { shot, text } of found.longShots) {
      // 组装 LLM 输入：句子序列
      const sentLines = (shot.sentenceIds ?? []).map((id) => `${id}: ${byId[id] ?? ""}`).join("\n");
      const userMsg = [
        "### 原分镜",
        `label: ${shot.label} | funcs: ${JSON.stringify(shot.funcs)}`,
        "### 句子序列",
        sentLines,
      ].join("\n\n");
      try {
        const raw = await chat([{ role: "system", content: SPLIT_SYSTEM }, { role: "user", content: userMsg }]);
        let payload;
        try { payload = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "")); }
        catch { payload = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)); }
        const segments = payload.segments ?? payload.镜头 ?? [];
        if (!segments.length) throw new Error("无 segments");
        const result = applySplit(shot, segments, byId);
        if (!result.ok) { console.error(`  [✗] 镜${shot.id} ${result.reason}`); errors++; continue; }
        newShotsMap.set(shot.id, result.newShots);
        console.log(`  [✓] 镜${shot.id}「${shot.label}」${text.length}字 → ${result.newShots.length} 个分镜`);
        totalSplit += result.newShots.length;
      } catch (err) {
        console.error(`  [✗] 镜${shot.id} 切分失败: ${err.message.slice(0, 80)}`);
        errors++;
      }
    }

    // 重建 shots 数组：替换长对话分镜为多个新分镜，其余保留，重排 id
    if (newShotsMap.size) {
      const newShots = [];
      let idCounter = 1;
      for (const old of data.shots ?? []) {
        const replaced = newShotsMap.get(old.id);
        if (replaced) {
          for (const ns of replaced) { ns.id = idCounter++; newShots.push(ns); }
        } else {
          newShots.push({ ...old, id: idCounter++ });
        }
      }
      data.shots = newShots;
      fs.writeFileSync(path.join(shotDir, `第${String(chapter).padStart(4, "0")}章.json`), JSON.stringify(data, null, 2) + "\n", "utf-8");
      console.log(`  [写] 第${chapter}章 分镜 ${newShots.length} 个`);
    }
  }
  console.log(`\n=== 完成 ===`);
  console.log(`长对话分镜: ${totalLong} | 拆后: ${totalSplit} | 失败: ${errors}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
