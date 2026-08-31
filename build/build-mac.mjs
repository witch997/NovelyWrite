#!/usr/bin/env node
// v0.8.0 — mac 构建脚本（2026-08-31 更新触发 Actions 重建）
/**
 * build-mac.mjs — macOS 单文件应用构建（rollup bundle → 官方 node:sea → postject → .app 打包）
 *
 * 与 build-sea.mjs（Windows）对齐，产物差异：
 *   - Windows: dist/NovelyWrite.exe（裸可执行文件）
 *   - macOS:   dist/NovelyWrite.app（App 包，双击即开；内含 Contents/MacOS/NovelyWrite）
 *              同时保留裸可执行文件 dist/NovelyWrite（命令行运行用）
 *
 * 步骤：
 *   1. rollup sea-main.mjs → sea-bundle.cjs（纯 CJS，官方 SEA 要求 CJS 入口）
 *   2. node --experimental-sea-config sea-config.json → sea-prep.blob
 *   3. 复制 node（darwin 运行时）→ dist/NovelyWrite.app/Contents/MacOS/NovelyWrite
 *   4. npx postject 注入 blob（--sentinel-fuse）
 *   5. 写 Info.plist + 目录骨架 → 完整 .app
 *
 * 用法（在 macOS 上执行，需已安装 node ≥18 与 npx）：
 *   node build/build-mac.mjs
 *
 * 产物：dist/NovelyWrite.app（运行后在 App 包旁自动建 config/corpus/store/mybook/output/sessions；
 *       数据目录规则与 Windows 一致——exe/App 所在目录，详见 shared/paths.mjs DATA_ROOT）
 *
 * 注意（Gatekeeper）：
 *   - 未签名/自签名 App 首次双击可能被拦截：右键 → 打开，或在终端执行
 *       xattr -cr dist/NovelyWrite.app
 *   - 如需免拦截分发，用 ad-hoc 自签名：
 *       codesign --force --deep --sign - dist/NovelyWrite.app
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url)); // build/
const APP_NAME = "NovelyWrite";
const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

/** 执行 npx（跨平台）：Windows 走 cmd /c 包装（execFileSync 直接调 .cmd 会 ENOENT/EINVAL），mac/Linux 直接 npx */
function runNpx(args) {
  if (process.platform === "win32") {
    execFileSync(process.env.ComSpec || "cmd.exe", ["/c", "npx", "--yes", ...args], { cwd: ROOT, stdio: "inherit" });
  } else {
    execFileSync("npx", ["--yes", ...args], { cwd: ROOT, stdio: "inherit" });
  }
}

// 1. rollup bundle（ESM → CJS；与 Windows 相同）
console.log("[mac] rollup bundle → sea-bundle.cjs ...");
runNpx(["rollup", "sea-main.mjs", "-f", "cjs", "-o", "sea-bundle.cjs"]);

// 2. SEA blob（同 Windows）
console.log("[mac] 生成 blob（--experimental-sea-config）...");
execFileSync(process.execPath, ["--experimental-sea-config", "sea-config.json"], { cwd: ROOT, stdio: "inherit" });

// 3. .app 目录骨架
const distDir = path.join(ROOT, "..", "dist");
const appDir = path.join(distDir, `${APP_NAME}.app`);
const macosDir = path.join(appDir, "Contents", "MacOS");
fs.mkdirSync(macosDir, { recursive: true });
const outBin = path.join(macosDir, APP_NAME);
fs.copyFileSync(process.execPath, outBin); // darwin 的 node → 无扩展名可执行文件
fs.chmodSync(outBin, 0o755);
console.log(`[mac] 已复制运行时 → ${outBin}`);

// 4. postject 注入（macOS 用 --macho-segment-name 防段名冲突，可选但推荐）
console.log("[mac] postject 注入 blob ...");
runNpx(["postject", outBin, "NODE_SEA_BLOB", path.join(ROOT, "sea-prep.blob"), "--sentinel-fuse", FUSE, "--macho-segment-name", "NODE_SEA"]);

// 5. Info.plist（macOS 识别 App 包必需）
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleIdentifier</key>
  <string>com.novelywrite.app</string>
  <key>CFBundleVersion</key>
  <string>1.0.0</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleExecutable</key>
  <string>${APP_NAME}</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
fs.writeFileSync(path.join(appDir, "Contents", "Info.plist"), plist, "utf-8");
fs.writeFileSync(path.join(appDir, "Contents", "PkgInfo"), "APPL????", "utf-8");

// 6. 同时保留裸可执行文件（命令行运行/调试用）
const bareBin = path.join(distDir, APP_NAME);
fs.copyFileSync(outBin, bareBin);
fs.chmodSync(bareBin, 0o755);

console.log(`\n✅ macOS 构建完成:`);
console.log(`  App 包:   ${appDir}`);
console.log(`  裸二进制: ${bareBin}`);
console.log(`\n运行: 双击 NovelyWrite.app → 自动启动服务并打开浏览器；数据落在 dist/ 旁`);
console.log(`Gatekeeper 提示时执行: xattr -cr "${appDir}"`);
console.log(`（本脚本在 Windows 上仅验证构建流程前 4 步，.app 结构需在 macOS 上生成确认）`);

