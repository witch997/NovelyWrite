/**
 * paths.mjs — 路径统一模块（打包/分发支持 + 域化布局）
 *
 * 路径分离原则：
 *   代码根（CODE_ROOT）：包内只读，打包后不变（novelread/retriever/...）
 *   数据根（DATA_ROOT）：外部可写目录，含 config.json / corpus / store / mybook
 *
 * 数据根确定优先级：
 *   1. 环境变量 NOVELYWRITE_HOME（显式指定数据根，如 NOVELYWRITE_HOME=/data/lvshi）
 *   2. 默认：代码根本身（当前工作区布局，NovelyWrite/ 下放 config/corpus/store）
 *     ——注意：不用 DSH_HOME（那是 harness 注入的变量，指向 ~/.dsh，会冲突）
 *
 * 域化布局（store 下两域 + 资产区 mybook）：
 *   store/myproject/<书>project/   域：我的作品（用户自己的书）
 *   store/exproject/<书>project/   域：外部知识库（语料标注的书）
 *   mybook/<书>/                  资产区：用户原稿（实时保存，不可再生）
 *
 * 约定：
 *   - 域 = 目录位置（无注册表），projectDirOf() 自动探测两域
 *   - 书名全局唯一（禁止同名），createProject() 创建时检查
 *   - 每书独立派生目录：<书>project/derived/dict + derived/vector（英文，见 rag-core.mjs）
 *
 * 用法：
 *   import { CODE_ROOT, DATA_ROOT, configPath, corpusDir, storeDir, projectRoot, createProject } from "../shared/paths.mjs";
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NovelyError, E } from "./errors.mjs";

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

/** 域：我的作品区（store/myproject） */
export const myprojectDir = path.join(storeDir, "myproject");

/** 域：外部知识库区（store/exproject） */
export const exprojectDir = path.join(storeDir, "exproject");

/** 资产区：用户原稿（数据根下 mybook，与 store 平级，不可再生资产） */
export const mybookDir = path.join(DATA_ROOT, "mybook");

/** 产出区：成稿/报告（数据根下 output——打包后代码根只读，产出必须随数据走） */
export const outputDir = path.join(DATA_ROOT, "output");

/** 域标识常量 */
export const DOMAIN = { MY: "my", EX: "ex" };

/**
 * 项目根目录（store/<域>/<书>project）
 * @param {string} project 书名
 * @param {string} [domain] 域（DOMAIN.MY / DOMAIN.EX）；缺省自动探测（我的优先）
 * @returns {string} 项目根路径
 * @throws {NovelyError} PROJECT_NOT_FOUND 指定域/两域均不存在
 */
export function projectRoot(project, domain) {
  if (domain === DOMAIN.MY) return path.join(myprojectDir, `${project}project`);
  if (domain === DOMAIN.EX) return path.join(exprojectDir, `${project}project`);
  // 自动探测：我的优先，其次外部（同名已禁止，无歧义）
  const my = path.join(myprojectDir, `${project}project`);
  if (fs.existsSync(my)) return my;
  const ex = path.join(exprojectDir, `${project}project`);
  if (fs.existsSync(ex)) return ex;
  throw new NovelyError(E.PROJECT_NOT_FOUND, { context: { project } });
}

/**
 * 列出项目（书名列表）
 * @param {string} [domain] 域；缺省 = 两域合并
 * @returns {string[]} 书名列表
 */
export function listProjects(domain) {
  const dirs = domain === DOMAIN.MY ? [myprojectDir] : domain === DOMAIN.EX ? [exprojectDir] : [myprojectDir, exprojectDir];
  const out = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.endsWith("project")) out.push(e.name.replace(/project$/, ""));
    }
  }
  return out.sort();
}

/** 某书所在域（探测；不存在返回 null） */
export function domainOf(project) {
  if (fs.existsSync(path.join(myprojectDir, `${project}project`))) return DOMAIN.MY;
  if (fs.existsSync(path.join(exprojectDir, `${project}project`))) return DOMAIN.EX;
  return null;
}

/**
 * 创建项目（禁止同名 + 报错统一走 errors 模块）
 * @param {string} project 书名
 * @param {string} domain 域（DOMAIN.MY / DOMAIN.EX）
 * @returns {string} 项目根路径（已创建）
 * @throws {NovelyError} PROJECT_DUPLICATE 两域已存在同名 / ARG_INVALID 域非法
 */
export function createProject(project, domain) {
  if (!project || !project.trim()) {
    throw new NovelyError(E.ARG_REQUIRED, { context: { field: "project" } });
  }
  if (domain !== DOMAIN.MY && domain !== DOMAIN.EX) {
    throw new NovelyError(E.ARG_INVALID, { context: { field: "domain", value: domain, expects: ["my", "ex"] } });
  }
  const target = path.join(domain === DOMAIN.MY ? myprojectDir : exprojectDir, `${project}project`);
  // 禁止同名：两域都查
  const existingDomain = domainOf(project);
  if (existingDomain) {
    const existingPath = existingDomain === DOMAIN.MY
      ? path.join(myprojectDir, `${project}project`)
      : path.join(exprojectDir, `${project}project`);
    throw new NovelyError(E.PROJECT_DUPLICATE, {
      context: { project, domain, existingDomain, existingPath },
    });
  }
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch (err) {
    throw new NovelyError(E.PROJECT_CREATE_FAILED, { context: { project, target, cause: err.message } });
  }
  return target;
}

/**
 * 运行时：确保数据目录骨架存在（corpus / store 两域 / mybook / output）。
 * 供 CLI / server 入口在启动时调用——新安装（fork/克隆）后首次运行即建好目录，
 * 避免"读取不到 store 等文件夹"；也保证 open-folder 等按路径操作可用。
 */
export function ensureDataDirs() {
  fs.mkdirSync(corpusDir, { recursive: true });
  fs.mkdirSync(storeDir, { recursive: true });
  fs.mkdirSync(myprojectDir, { recursive: true });
  fs.mkdirSync(exprojectDir, { recursive: true });
  fs.mkdirSync(mybookDir, { recursive: true });
  // output 是数据根下的成稿/报告目录（打包后代码根只读，产出随数据走）
  fs.mkdirSync(outputDir, { recursive: true });
}

/** 调试：打印路径 */
export function debugPaths() {
  console.log(`[paths] CODE_ROOT = ${CODE_ROOT}`);
  console.log(`[paths] DATA_ROOT = ${DATA_ROOT}${process.env.NOVELYWRITE_HOME ? " (来自 NOVELYWRITE_HOME)" : " (默认=代码根)"}`);
  console.log(`[paths] config     = ${configPath}`);
  console.log(`[paths] corpus     = ${corpusDir}`);
  console.log(`[paths] store      = ${storeDir}`);
  console.log(`[paths] myproject  = ${myprojectDir}`);
  console.log(`[paths] exproject  = ${exprojectDir}`);
  console.log(`[paths] mybook     = ${mybookDir}`);
}
