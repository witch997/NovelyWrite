/**
 * ensure-derived.mjs — 调用前对比 + 自动重建（词典 + 四表，按书）
 *
 * retrieve() 入口前调用：扫描 store 事实层现状 vs 各书派生数据 derivedFrom 覆盖清单，
 * 有变化 → 重建该书词典（entity-dict）+ 四表（lexical-index），保证检索用的是最新派生。
 *
 * 域化说明：每书独立词典，对比与重建均按书进行——改 A 书只重建 A 书词典（重算隔离）。
 *
 * 成本：扫描 = 目录遍历 + stat（毫秒级）；重建 = CPU 秒级（1143 镜 <1s）。
 * 向量库不在此机制内（API 贵，走 buildVectors 的独立增量）。
 *
 * 用法：
 *   import { ensureDerived } from "./ensure-derived.mjs";
 *   await ensureDerived(); // 幂等：无变化时零成本
 */
import { dictDirOf } from "./rag-core.mjs";
import { scanSourceState, needsRebuild, readDerivedFrom } from "./derived-state.mjs";
import { buildDict, buildLexicalIndex } from "./build-derived.mjs";
import { listProjects } from "../shared/paths.mjs";

let _lastChecked = null; // 进程内缓存：同一轮检查过就不再重复（避免并发重复重建）

/**
 * 确保派生数据（词典 + 四表）最新（按书）。
 * @param {object} opts { force?: boolean, projects?: string[] } 强制重建 / 限定书
 * @returns {Promise<{rebuilt: string[]}>} 重建了哪些（空 = 无变化）
 */
export async function ensureDerived(opts = {}) {
  const rebuilt = [];
  const projects = opts.projects?.length ? opts.projects : listProjects();

  for (const project of projects) {
    // 扫描一次该书事实层现状
    const current = scanSourceState({ projects: [project] });

    // ① 词典对比（按书）
    const dictFile = `${dictDirOf(project)}/entity-dict.json`;
    const dictRecorded = readDerivedFrom(dictFile)?.sourceState ?? null;
    if (opts.force || dictRecorded === null || needsRebuild(current, dictRecorded)) {
      buildDict({ book: project });
      rebuilt.push(`entity-dict:${project}`);
    }

    // ② 四表对比（依赖词典最新——若词典重建了，四表必须跟着重建）
    //    注：四表索引为后期扩容预备（buildLexicalIndex 当前输出提示并跳过，返回 null）
    const indexFile = `${dictDirOf(project)}/lexical-index.json`;
    const indexRecorded = readDerivedFrom(indexFile)?.sourceState ?? null;
    const dictChanged = rebuilt.includes(`entity-dict:${project}`);
    if (opts.force || dictChanged || indexRecorded === null || needsRebuild(current, indexRecorded)) {
      const r = buildLexicalIndex();
      if (r !== null) rebuilt.push(`lexical-index:${project}`); // 预备态返回 null → 不误报重建
    }
  }

  _lastChecked = Date.now();
  return { rebuilt };
}

/** 进程内缓存失效（供测试/手动触发） */
export function resetEnsureCache() {
  _lastChecked = null;
}
