#!/usr/bin/env node
/**
 * build-desktop.mjs — 一键打包桌面版（Tauri 壳 + SEA sidecar）
 *
 * 流程：
 *   ① SEA 打包（build-sea.mjs）→ dist/NovelyWrite-browser.exe
 *   ② 复制为 sidecar → tauri/binaries/nw-server-<triple>.exe
 *   ③ cargo build --release（tauri/）→ target/release/NovelyWrite.exe + nw-server.exe
 *   ④ 组装桌面版 → dist/desktop/（默认；--target 指定其他目录）
 *
 * 产物依赖：仅 WebView2Loader.dll（sidecar/SEA 零第三方 DLL；壳实测无需 mingw DLL）
 *
 * 用法：
 *   node build/build-desktop.mjs
 *   node build/build-desktop.mjs --target "C:\Users\xifan\Desktop\NovelyWrite桌面版"
 *   node build/build-desktop.mjs --no-sea --no-cargo   # 只组装（sidecar/壳已最新）
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TRIBLE = process.env.TAURI_TARGET_TRIPLE || "x86_64-pc-windows-gnu";
const CARGO_BIN = path.join(os.homedir(), ".cargo", "bin");
// mingw bin（gnu 工具链链接器；运行时 DLL 不需要——壳实测静态链接 libgcc/libwinpthread）
const MINGW_BIN = "C:/Users/xifan/AppData/Local/Microsoft/WinGet/Packages/BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe/mingw64/bin";

const args = process.argv.slice(2);
const noSea = args.includes("--no-sea");
const noCargo = args.includes("--no-cargo");
const targetArg = args.find((a) => a.startsWith("--target="));
const targetDir = targetArg
  ? path.resolve(targetArg.slice(9))
  : path.join(ROOT, "dist", "desktop"); // 默认产出归位源码 dist/desktop/

const step = (s) => console.log(`\n=== ${s} ===`);
const run = (cmd, args, cwd, env) => {
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
};

/** 把 exe 的 PE subsystem 改成 GUI(2)：双击不弹命令行黑窗口 */
function fixGui(exePath) {
  const b = fs.readFileSync(exePath);
  const e = b.readUInt32LE(0x3c);       // e_lfanew
  const off = e + 24 + 68;              // Subsystem 字段（PE32/PE32+ 均在偏移 68）
  const sub = b.readUInt16LE(off);
  if (sub !== 2) {
    b.writeUInt16LE(2, off);            // 2 = IMAGE_SUBSYSTEM_WINDOWS_GUI
    fs.writeFileSync(exePath, b);
    console.log(`   ${path.basename(exePath)}: subsystem ${sub}→2 ✓`);
    return true;
  }
  return false;
}

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
  if (!fs.existsSync(srcSea)) throw new Error(`缺少 SEA 产物: ${srcSea}（先跑完整流程或去掉 --no-sea）`);
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

  const files = [
    ["NovelyWrite.exe", releaseDir],   // 壳
    ["nw-server.exe", releaseDir],     // sidecar
    ["WebView2Loader.dll", releaseDir],// 唯一依赖 DLL
  ];
  for (const [name, dir] of files) {
    const src = path.join(dir, name);
    if (!fs.existsSync(src)) throw new Error(`缺少产物: ${src}（先跑完整流程）`);
    fs.copyFileSync(src, path.join(targetDir, name));
    console.log(`   ${name} ✓`);
  }

  // 确保壳 + sidecar 均为 GUI 子系统（gnu toolchain 下壳可能残留 console → 双击弹黑窗）
  step("⑤ PE subsystem → GUI（防命令行黑窗）");
  fixGui(path.join(targetDir, "NovelyWrite.exe"));
  fixGui(path.join(targetDir, "nw-server.exe"));

  /* ---------- 完成 ---------- */
  console.log("\n✅ 桌面版打包完成");
  console.log(`   目录: ${targetDir}`);
  console.log(`   启动: 双击 NovelyWrite.exe（原生窗口，自动起 nw-server）`);
  console.log(`   浏览器版: dist/NovelyWrite-browser.exe`);
} catch (e) {
  console.error(`\n❌ 打包失败: ${e.message}`);
  process.exit(1);
}
