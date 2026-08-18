/**
 * derived-state.mjs — 派生数据的状态对比（"调用前对比"的核心）
 *
 * 职责：
 *   - 扫描 store 事实层（各 project 的分镜目录 + 每章源文件 mtime）
 *   - 生成覆盖清单（派生数据 derivedFrom 里记录的"我覆盖了哪些章、源 mtime 是多少"）
 *   - 对比：事实层现状 vs 派生记录 → 判定"是否需要重建"
 *
 * 用于：词典（entity-dict）与四表（lexical-index）的"调用前对比"。
 * 向量库不用此机制（API 贵，增量策略不同，见 buildVectors）。
 *
 * 覆盖清单格式：
 *   { "大王饶命:1": "2026-08-16T01:03:00.000Z", "大王饶命:2": "..." }
 *   键 = project:chapter，值 = 该章分镜源文件的 mtime（ISO）
 */
import fs from "node:fs";
import path from "node:path";
import { storeDir, projectRoot, shotJsonPath } from "./rag-core.mjs";

/**
 * 扫描 store 事实层，返回覆盖清单 { "project:chapter": sourceMtime }
 * 追踪对象：分镜文件 + 句子文件 的 mtime（词典 PMI 建库依赖句子 text，句子变化也必须触发重建）
 * @param {object} opts { projects?: string[] }
 */
export function scanSourceState(opts = {}) {
  const state = {};
  const projects = opts.projects ?? fs.readdirSync(storeDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.endsWith("project"))
    .map((d) => d.name.replace(/project$/, ""));

  for (const project of projects) {
    const shotDir = path.join(projectRoot(project), "分镜标注", "json");
    if (!fs.existsSync(shotDir)) continue;
    for (const file of fs.readdirSync(shotDir).filter((f) => /^第\d{4}章\.json$/.test(f))) {
      const chapter = parseInt(file.match(/\d+/)[0], 10);
      const shotFile = shotJsonPath(project, chapter);
      const sentFile = path.join(projectRoot(project), "句子标注", "json", file);
      if (!fs.existsSync(shotFile) && !fs.existsSync(sentFile)) continue;
      // 分镜 + 句子 的 mtime 拼接（任一变 → 键值变化 → 触发重建）
      const shotMtime = fs.existsSync(shotFile) ? fs.statSync(shotFile).mtime.toISOString() : "missing";
      const sentMtime = fs.existsSync(sentFile) ? fs.statSync(sentFile).mtime.toISOString() : "missing";
      state[`${project}:${chapter}`] = `${shotMtime}|${sentMtime}`;
    }
  }
  return state;
}

/**
 * 对比：事实层现状 vs 派生记录
 * @param {object} current 扫描出的覆盖清单（scanSourceState 结果）
 * @param {object} recorded 派生数据 derivedFrom 里记录的覆盖清单
 * @returns {boolean} true = 需要重建（有新增/变更/删除）
 */
export function needsRebuild(current, recorded) {
  const rec = recorded ?? {};
  // 键集合不同（新增/删除章）
  const curKeys = Object.keys(current);
  const recKeys = Object.keys(rec);
  if (curKeys.length !== recKeys.length) return true;
  for (const k of curKeys) {
    if (rec[k] !== current[k]) return true; // 新增键 或 mtime 变化
  }
  return false;
}

/** 读取派生数据的 derivedFrom（带默认值） */
export function readDerivedFrom(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return data.derivedFrom ?? null;
  } catch {
    return null;
  }
}
