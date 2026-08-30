/**
 * sea-main.mjs — 单文件 exe 入口分发（@yao-pkg/pkg 打包入口）
 *
 * 无 NOVELYWRITE_RUN 环境变量 → 启动 HTTP 服务（server.mjs main）
 * 有 NOVELYWRITE_RUN → 分发到对应任务脚本 main（server spawn 自身做子进程，数据目录一致）
 *
 * 子进程调用形态：server 设 env NOVELYWRITE_RUN=novelread/host-exec.mjs + 传任务参数
 *   ——脚本名走环境变量而非 argv（pkg 会把 argv[1] 当模块路径加载）
 * 各任务脚本 main 内部用 cliArgs() 读取参数（无前缀，原样）。
 * 注意：不得出现模块顶层 await（rollup CJS 转换不支持）。
 */
import { main as serverMain } from "../server.mjs";
import net from "node:net";
import * as hostExec from "../novelread/host-exec.mjs";
import * as aggregates from "../novelread/aggregates.mjs";
import * as fix from "../novelread/fix.mjs";
import * as preprocess from "../features/shot-writing/preprocess.mjs";
import * as recall from "../features/shot-writing/recall.mjs";
import * as writedraft from "../features/shot-writing/writedraft.mjs";
import * as checkChapter from "../novelread/check-chapter.mjs";
import * as genList from "../novelread/gen-chapter-list.mjs";

const runScript = process.env.NOVELYWRITE_RUN;

if (runScript) {
  const TASKS = [
    [/host-exec/, hostExec],
    [/aggregates/, aggregates],
    [/-fix\./, fix],
    [/preprocess/, preprocess],
    [/recall/, recall],
    [/writedraft/, writedraft],
    [/check-chapter/, checkChapter],
    [/gen-chapter-list/, genList],
  ];
  const hit = TASKS.find(([re]) => re.test(runScript));
  if (!hit) {
    console.error(`[sea] 未知任务脚本: ${runScript}`);
    process.exit(1);
  }
  (async () => {
    try {
      await hit[1].main(); // 各脚本 main 默认参数走 cliArgs()（无前缀）
      process.exit(0);
    } catch (err) {
      console.error(`[${runScript}] 失败:`, err.message);
      process.exit(1);
    }
  })();
} else {
  // 双击启动：默认自动打开浏览器；3081 被占用(如源码版在跑)→ 自动换动态端口
  // --sidecar：Tauri 壳模式——不开浏览器、无心跳（生命周期由壳管理）、固定 3081（壳窗口加载固定 URL）
  const sidecar = process.argv.includes("--sidecar");
  (async () => {
    if (sidecar) {
      if (!process.argv.some((a) => a.startsWith("--port="))) process.argv.push("--port=3081");
      process.argv.push("--no-heartbeat");
      serverMain();
    } else {
      process.argv.push("--open");
      if (!process.argv.some((a) => a.startsWith("--port="))) {
        const used = await new Promise((resolve) => {
          const s = net.connect({ port: 3081, host: "127.0.0.1" });
          s.on("connect", () => { s.destroy(); resolve(true); });
          s.on("error", () => resolve(false));
        });
        if (used) process.argv.push("--port=0"); // 3081 被占 → 动态端口(必然空闲)
      }
      serverMain(); // 正常启动 HTTP 服务
    }
  })();
}
