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
import { main as serverMain } from "./server.mjs";
import * as hostExec from "./novelread/host-exec.mjs";
import * as aggregates from "./novelread/aggregates.mjs";
import * as fix from "./novelread/fix.mjs";
import * as preprocess from "./features/shot-writing/preprocess.mjs";
import * as recall from "./features/shot-writing/recall.mjs";
import * as writedraft from "./features/shot-writing/writedraft.mjs";
import * as checkChapter from "./novelread/check-chapter.mjs";
import * as genList from "./novelread/gen-chapter-list.mjs";

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
  process.argv.push("--open"); // exe 双击默认自动打开浏览器（源码模式可加 --no-open? 保留手动控制）
  serverMain(); // 正常启动 HTTP 服务
}
