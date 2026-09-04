#!/usr/bin/env node
/**
 * build-sea.mjs — 单文件 exe 构建（rollup bundle → 官方 node:sea → postject 注入）
 *
 * 步骤：
 *   1. rollup sea-main.mjs → sea-bundle.cjs（纯 CJS，官方 SEA 要求 CJS 入口）
 *   2. node --experimental-sea-config sea-config.json → sea-prep.blob
 *   3. 复制 node.exe → dist/NovelyWrite.exe
 *   4. npx postject 注入 blob（--sentinel-fuse）
 *
 * 用法：
 *   node build-sea.mjs
 *
 * 产物：dist/NovelyWrite.exe（运行后在 exe 旁自动建 config/corpus/store/mybook/output/sessions）
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// 防误 import：仅直接运行（node build/build-sea.mjs）时执行打包；被 import 时静默跳过（无副作用）
if (!(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))) process.exit(0);

// 1. rollup bundle（ESM → CJS；import.meta.url 由 rollup 转为 pathToFileURL(__filename)）
console.log("[sea] rollup bundle → sea-bundle.cjs ...");
const rollupCmd = process.platform === "win32"
  ? [process.env.ComSpec || "cmd.exe", ["/c", "npx", "--yes", "rollup", "sea-main.mjs", "-f", "cjs", "-o", "sea-bundle.cjs"]]
  : ["npx", ["--yes", "rollup", "sea-main.mjs", "-f", "cjs", "-o", "sea-bundle.cjs"]];
execFileSync(rollupCmd[0], rollupCmd[1], { cwd: ROOT, stdio: "inherit" });

// 2. SEA blob
console.log("[sea] 生成 blob（--experimental-sea-config）...");
execFileSync(process.execPath, ["--experimental-sea-config", "sea-config.json"], { cwd: ROOT, stdio: "inherit" });

// 3. 复制 node.exe → ../dist/NovelyWrite-browser.exe（浏览器模式独立版；Tauri 壳的 sidecar 另命名 nw-server）
const distDir = path.join(ROOT, "..", "dist");
fs.mkdirSync(distDir, { recursive: true });
const outExe = path.join(distDir, "NovelyWrite-browser.exe");
fs.copyFileSync(process.execPath, outExe);
console.log(`[sea] 已复制运行时 → ${outExe}`);

// 4. postject 注入
console.log("[sea] postject 注入 blob（npx postject，首次会下载）...");
const fuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const postjectArgs = ["--yes", "postject", outExe, "NODE_SEA_BLOB", path.join(ROOT, "sea-prep.blob"), "--sentinel-fuse", fuse];
execFileSync(process.env.ComSpec || "cmd.exe", ["/c", "npx", ...postjectArgs], { cwd: ROOT, stdio: "inherit" });

// 5. PE subsystem 控制台(3) → GUI(2)：双击不弹命令行黑窗口
//    （node.exe 默认 console 子系统；改 GUI 后无控制台，服务日志改走文件）
console.log("[sea] 改 PE subsystem 3→2（GUI，双击不弹命令行窗口）...");
{
  const b = fs.readFileSync(outExe);
  const e = b.readUInt32LE(0x3c);          // e_lfanew
  const opt = e + 24;                      // OptionalHeader 起点
  const subsystemOff = opt + 68;           // Subsystem（PE32/PE32+ 均在偏移 68）
  const sub = b.readUInt16LE(subsystemOff);
  if (sub !== 2) {
    b.writeUInt16LE(2, subsystemOff);      // 2 = IMAGE_SUBSYSTEM_WINDOWS_GUI
    fs.writeFileSync(outExe, b);
    console.log(`  subsystem ${sub} → 2 ✓`);
  } else {
    console.log("  已是 GUI（2）");
  }
}

console.log("✅ 构建完成: dist/NovelyWrite-browser.exe（GUI，双击无黑窗）");
console.log("   运行: 双击 exe → 自动启动服务并打开浏览器；数据落在 exe 旁（config/corpus/store/mybook/output/sessions）");