#!/usr/bin/env node
/**
 * build-desktop.mjs — 一键打包桌面版（Tauri 壳 + SEA sidecar）
 *
 * 流程：
 *   ① SEA 打包（build-sea.mjs）→ dist/NovelyWrite-browser.exe
 *   ② 复制为 sidecar → tauri/binaries/nw-server-<triple>.exe
 *   ③ cargo build --release（tauri/）→ target/release/NovelyWrite.exe + nw-server.exe
 *   ④ 组装桌面版目录（壳 + sidecar + DLL）→ 桌面/NovelyWrite桌面版/
 *
 * 用法：
 *   node build/build-desktop.mjs [--target <桌面目录>] [--no-sea] [--no-cargo]
 *     --no-sea    跳过 SEA 打包（sidecar 已是最新时）
 *     --no-cargo  跳过 cargo 编译（壳未变时，只组装）
 *     --target    自定义输出目录（默认 桌面/NovelyWrite桌面版）
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TRIBLE = process.env.TAURI_TARGET_TRIPLE || detectTriple();
const CARGO_BIN = path.join(os.homedir(), ".cargo", "bin");
// mingw bin（gnu 工具链的链接器 + 运行时 DLL 来源）
const MINGW_BIN = "C:/Users/xifan/AppData/Local/Microsoft/WinGet/Packages/BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe/mingw64/bin";

function detectTriple() {
  // 当前默认 gnu toolchain
  return "x86_64-pc-windows-gnu";
}

const args = process.argv.slice(2);
const noSea = args.includes("--no-sea");
const noCargo = args.includes("--no-cargo");
const targetArg = args.find((a) => a.startsWith("--target="));
const targetDir = targetArg ? path.resolve(targetArg.slice(9)) : path.join(os.homedir(), "Desktop", "NovelyWrite桌面版");

const step = (s) => console.log(`\n=== ${s} ===`);
const run = (cmd, args, cwd, env) => {
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
};

try {
  /* ---------- ① SEA 打包（浏览器版 + sidecar 源） ---------- */
  if (!noSea) {
    step("① SEA 打包 → dist/NovelyWrite-browser.exe");
    run(process.execPath, ["build-sea.mjs"], path.join(ROOT, "build"));
  } else {
    console.log("（--no-sea：跳过 SEA 打包）");
  }

  /* ---------- ② 复制 sidecar ---------- */
  step(`② 复制 sidecar → tauri/binaries/nw-server-${TRIBLE}.exe`);
  const srcSea = path.join(ROOT, "dist", "NovelyWrite-browser.exe");
  const sidecarDir = path.join(ROOT, "tauri", "binaries");
  fs.mkdirSync(sidecarDir, { recursive: true });
  const sidecarPath = path.join(sidecarDir, `nw-server-${TRIBLE}.exe`);
  fs.copyFileSync(srcSea, sidecarPath);
  console.log(`   sidecar: ${sidecarPath} (${(fs.statSync(sidecarPath).size / 1048576).toFixed(1)} MB)`);

  /* ---------- ③ cargo build --release ---------- */
  if (!noCargo) {
    step("③ cargo build --release（tauri/）");
    const env = { PATH: `${CARGO_BIN};${MINGW_BIN};${process.env.PATH}` };
    run("cargo", ["build", "--release"], path.join(ROOT, "tauri"), env);
  } else {
    console.log("（--no-cargo：跳过 cargo 编译）");
  }

  /* ---------- ④ 组装桌面版 ---------- */
  step(`④ 组装桌面版 → ${targetDir}`);
  fs.mkdirSync(targetDir, { recursive: true });
  const releaseDir = path.join(ROOT, "tauri", "target", "release");

  // 壳 + sidecar + WebView2Loader（Tauri 运行时 DLL）
  const files = [
    ["NovelyWrite.exe", releaseDir],
    ["nw-server.exe", releaseDir],
    ["WebView2Loader.dll", releaseDir],
  ];
  for (const [name, dir] of files) {
    const src = path.join(dir, name);
    if (!fs.existsSync(src)) throw new Error(`缺少产物: ${src}（先跑完整流程）`);
    fs.copyFileSync(src, path.join(targetDir, name));
    console.log(`   ${name} ✓`);
  }

  // mingw 运行时 DLL（gnu 工具链，exe 旁查找）
  const mingwDlls = ["libgcc_s_seh-1.dll", "libstdc++-6.dll", "libwinpthread-1.dll"];
  for (const dll of mingwDlls) {
    const src = path.join(MINGW_BIN, dll);
    if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(targetDir, dll)); console.log(`   ${dll} ✓`); }
  }

  /* ---------- 完成 ---------- */
  console.log("\n✅ 桌面版打包完成");
  console.log(`   目录: ${targetDir}`);
  console.log(`   启动: 双击 NovelyWrite.exe（原生窗口，自动起 nw-server）`);
  console.log(`   浏览器版: dist/NovelyWrite-browser.exe`);
} catch (e) {
  console.error(`\n❌ 打包失败: ${e.message}`);
  process.exit(1);
}
