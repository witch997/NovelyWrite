/**
 * shared/fs.mjs — 原子文件写工具（tmp + rename，防半写）
 *
 * 背景：config.json / project-meta.json / pending.json 等「读改写」元文件若直接
 * writeFileSync 覆写，写入中途被 kill/断电/崩溃会留下半截 JSON → 后续 parse 失败，
 * 单点损坏无备份。tmp + rename 保证磁盘上任意时刻要么旧完整文件、要么新完整文件
 * （Windows/NTFS rename 覆盖是原子的）；残留 .tmp 可安全忽略（下次写覆盖）。
 */
import fs from "node:fs";
import path from "node:path";

/** 原子写 JSON（格式化 2 空格；自动建父目录；失败抛错由调用方决定处理） */
export function atomicWriteJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, file);
}

/** 原子写文本（追加场景勿用——rename 是整体替换语义） */
export function atomicWriteText(file, text) {
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, text, "utf-8");
  fs.renameSync(tmp, file);
}
