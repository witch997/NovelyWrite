/**
 * paths.mjs — 路径统一模块（打包/分发支持）
 *
 * 路径分离原则：
 *   代码根（CODE_ROOT）：包内只读，打包后不变（novelread/retriever/...）
 *   数据根（DATA_ROOT）：外部可写目录，含 config.json / corpus / store
 *
 * 数据根确定优先级：
 *   1. 环境变量 NOVELYWRITE_HOME（显式指定数据根，如 NOVELYWRITE_HOME=/data/lvshi）
 *   2. 默认：代码根本身（当前工作区布局，NovelyWrite/ 下放 config/corpus/store）
 *     ——注意：不用 DSH_HOME（那是 harness 注入的变量，指向 ~/.dsh，会冲突）
 *
 * 用法：
 *   import { CODE_ROOT, DATA_ROOT, configPath, corpusDir, storeDir } from "../shared/paths.mjs";
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 代码根（本文件在 <root>/shared/ 下） */
export const CODE_ROOT = path.resolve(__dirname, "..");

/** 数据根：NOVELYWRITE_HOME > 默认（代码根，即 NovelyWrite/）——不用 DSH_HOME（harness 占用） */
export const DATA_ROOT = (() => {
  if (process.env.NOVELYWRITE_HOME) return path.resolve(process.env.NOVELYWRITE_HOME);
  return CODE_ROOT; // 默认：数据根 = 代码根（NovelyWrite/ 下放 config/corpus/store）
})();

/** config.json 路径（数据根下） */
export const configPath = path.join(DATA_ROOT, "config.json");

/** corpus 语料目录（数据根下） */
export const corpusDir = path.join(DATA_ROOT, "corpus");

/** store 数据库目录（数据根下） */
export const storeDir = path.join(DATA_ROOT, "store");

/** 项目 store 下 project 根（store/<名>project） */
export function projectRoot(project) {
  return path.join(storeDir, `${project}project`);
}

/** 运行时：确保数据根目录存在（corpus/store） */
export function ensureDataDirs() {
  fs.mkdirSync(corpusDir, { recursive: true });
  fs.mkdirSync(storeDir, { recursive: true });
}

/** 调试：打印路径 */
export function debugPaths() {
  console.log(`[paths] CODE_ROOT = ${CODE_ROOT}`);
  console.log(`[paths] DATA_ROOT = ${DATA_ROOT}${process.env.NOVELYWRITE_HOME ? " (来自 NOVELYWRITE_HOME)" : " (默认=代码根)"}`);
  console.log(`[paths] config     = ${configPath}`);
  console.log(`[paths] corpus     = ${corpusDir}`);
  console.log(`[paths] store      = ${storeDir}`);
}
