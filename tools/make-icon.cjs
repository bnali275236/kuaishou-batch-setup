/**
 * 生成应用图标 PNG（纯 Node，零依赖，zlib 内置）。
 * 设计：紫色渐变圆角方块 + 白色闪电（投放加速的意象），与前端主色 #534AB7 一致。
 * 用法：node tools/make-icon.cjs  →  输出 tools/icon.png + tools/icon.ico
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;

/* ---------- 简单矢量光栅化 ---------- */

function inRoundedRect(x, y, s, r) {
  if (x < 0 || y < 0 || x > s || y > s) return false;
  const cx = Math.min(Math.max(x, r), s - r);
  const cy = Math.min(Math.max(y, r), s - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

// 闪电多边形（0-1 归一化坐标）
const BOLT = [
  [0.58, 0.12], [0.30, 0.55], [0.47, 0.55], [0.40, 0.88],
  [0.70, 0.44], [0.52, 0.44],
];

function inBolt(px, py) {
  const x = px / SIZE;
  const y = py / SIZE;
  let inside = false;
  for (let i = 0, j = BOLT.length - 1; i < BOLT.length; j = i++) {
    const [xi, yi] = BOLT[i];
    const [xj, yj] = BOLT[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/* ---------- PNG 编码 ---------- */

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0; // filter none
    pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- 渲染 ---------- */

const pixels = Buffer.alloc(SIZE * SIZE * 4);
const R = 44; // 圆角半径
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const o = (y * SIZE + x) * 4;
    if (!inRoundedRect(x + 0.5, y + 0.5, SIZE, R)) continue; // 透明背景
    // 垂直渐变：#6254CD → #463CA0（前端主色 #534AB7 的两档明度）
    const t = y / SIZE;
    let r = Math.round(0x62 + (0x46 - 0x62) * t);
    let g = Math.round(0x54 + (0x3c - 0x54) * t);
    let b = Math.round(0xcd + (0xa0 - 0xcd) * t);
    if (inBolt(x + 0.5, y + 0.5)) {
      r = g = b = 255; // 白色闪电
    }
    pixels[o] = r;
    pixels[o + 1] = g;
    pixels[o + 2] = b;
    pixels[o + 3] = 255;
  }
}

const outDir = path.join(__dirname);
const png = encodePng(pixels);
fs.writeFileSync(path.join(outDir, 'icon.png'), png);

/* ---------- PNG 包进 ICO（Vista+ 支持 PNG 直存，256px 单层即可） ---------- */
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type icon
header.writeUInt16LE(1, 4); // count
const entry = Buffer.alloc(16);
entry[0] = 0; // 256px 写 0
entry[1] = 0;
entry[2] = 0; // 调色板
entry[3] = 0;
entry.writeUInt16LE(1, 4); // planes
entry.writeUInt16LE(32, 6); // bpp
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(22, 12); // 数据偏移 = 6 + 16
fs.writeFileSync(path.join(outDir, 'icon.ico'), Buffer.concat([header, entry, png]));

console.log('icon.png / icon.ico generated');
