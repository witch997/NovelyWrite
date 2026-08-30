#!/usr/bin/env node
/** 生成 Tauri 所需图标（32x32/128x128 PNG + ICO，纯色+NW 字标） */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const dir = path.resolve("tauri/icons");
fs.mkdirSync(dir, { recursive: true });

// 用 Node 原生 API 画 PNG（纯色底 + 简单 N/W 字母块）
function makePng(size) {
  const px = Buffer.alloc(size * size * 4);
  // 背景：深蓝 (#1a2430)
  const bg = [26, 36, 48, 255];
  // 品牌蓝 (#2563eb)
  const fg = [37, 99, 235, 255];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // 画一个 "N"：两条竖线 + 斜杠；简单用 3 条矩形
      const n = size / 5;
      const inN =
        (x < n || x > size - n) && y > n && y < size - n || // 两竖
        (Math.abs((x - n) - (y - n)) < n * 0.9 && y > n && y < size - n); // 斜杠（简化菱形）
      const c = inN ? fg : bg;
      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = c[3];
    }
  }
  // PNG 编码
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter none
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const typeBuf = Buffer.from(type, "ascii");
    const crcBuf = Buffer.alloc(4);
    const crcTable = (() => {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
      }
      return t;
    })();
    let crc = 0xffffffff;
    for (const b of Buffer.concat([typeBuf, data])) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ICO：PNG 条目（Windows Vista+ 支持 PNG 压缩 ICO）
function makeIco(png128) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = 128; entry[1] = 128; // 尺寸
  entry[2] = 0; entry[3] = 0;     // 调色板
  entry.writeUInt16LE(1, 4);      // planes
  entry.writeUInt16LE(32, 6);     // bpp
  entry.writeUInt32LE(png128.length, 8);
  entry.writeUInt32LE(22, 12);    // 偏移
  return Buffer.concat([header, entry, png128]);
}

fs.writeFileSync(path.join(dir, "32x32.png"), makePng(32));
fs.writeFileSync(path.join(dir, "128x128.png"), makePng(128));
fs.writeFileSync(path.join(dir, "128x128@2x.png"), makePng(256));
const png128 = makePng(128);
fs.writeFileSync(path.join(dir, "icon.ico"), makeIco(png128));
console.log("图标已生成:", fs.readdirSync(dir).join(", "));
