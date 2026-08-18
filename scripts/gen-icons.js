'use strict';

/**
 * gen-icons.js
 * 从源图生成应用全套图标：
 *   - PNG 多尺寸（16/24/32/48/64/128/256/512/1024）
 *   - Windows ICO（含 16/24/32/48/64/128/256 多尺寸）
 *   - macOS ICNS（含 16/32/64/128/256/512/1024 多尺寸，使用 png 内嵌 icns 格式）
 * 用法：node scripts/gen-icons.js
 */

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const root = path.join(__dirname, '..');
const SRC = process.argv[2] || path.join(root, 'resources', '微信图片_20260818100718_1_134.png');
const OUT = path.join(root, 'build', 'icons');

// 各用途的 PNG 尺寸
const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
// ICO 内部尺寸（Windows 规范）
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
// ICNS 内嵌尺寸（按 icns 标准 type 映射）
const ICNS_SIZES = [
  { size: 16, type: 'icp4' },
  { size: 32, type: 'icp5' },
  { size: 64, type: 'icp6' },
  { size: 128, type: 'ic07' },
  { size: 256, type: 'ic08' },
  { size: 512, type: 'ic09' },
  { size: 1024, type: 'ic10' },
];

/** PNG 编码 buffer */
async function pngBuf(size) {
  return sharp(SRC)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
}

/** 生成 Windows ICO（PNG 格式内嵌，Windows Vista+ 支持） */
async function buildIco() {
  const images = [];
  for (const size of ICO_SIZES) {
    const buf = await pngBuf(size);
    images.push({ size, buf });
  }
  // ICO 文件头：reserved(2) + type(2=1 icon) + count(2)
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  // 目录项（16 字节/个）
  let offset = 6 + images.length * 16;
  const entries = [];
  const datas = [];
  for (const img of images) {
    const entry = Buffer.alloc(16);
    const dim = img.size >= 256 ? 0 : img.size; // 256+ 用 0 表示
    entry.writeUInt8(dim, 0); // width
    entry.writeUInt8(dim, 1); // height
    entry.writeUInt8(0, 2); // color palette
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(img.buf.length, 8); // size of image data
    entry.writeUInt32LE(offset, 12); // offset of image data
    entries.push(entry);
    datas.push(img.buf);
    offset += img.buf.length;
  }
  return Buffer.concat([header, ...entries, ...datas]);
}

/** 生成 macOS ICNS（PNG 内嵌 icns 格式） */
async function buildIcns() {
  const images = [];
  for (const { size, type } of ICNS_SIZES) {
    const buf = await pngBuf(size);
    images.push({ type, buf });
  }
  // ICNS 文件头：magic 'icns'(4) + file length(4)
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  let totalLen = 8;
  for (const img of images) totalLen += 8 + img.buf.length;
  header.writeUInt32BE(totalLen, 4);

  const chunks = [];
  for (const img of images) {
    const chunk = Buffer.alloc(8);
    chunk.write(img.type, 0, 4, 'ascii');
    chunk.writeUInt32BE(8 + img.buf.length, 4);
    chunks.push(chunk, img.buf);
  }
  return Buffer.concat([header, ...chunks]);
}

async function main() {
  console.log('=== 生成应用图标 ===');
  if (!fs.existsSync(SRC)) {
    console.error('✗ 源图片不存在: ' + SRC);
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });

  // 1. 各尺寸 PNG
  for (const size of PNG_SIZES) {
    const buf = await pngBuf(size);
    const f = path.join(OUT, `icon-${size}.png`);
    fs.writeFileSync(f, buf);
    console.log(`✓ ${path.basename(f)} (${size}x${size})`);
  }
  // 2. 512 主图标
  fs.copyFileSync(path.join(OUT, 'icon-512.png'), path.join(OUT, 'icon.png'));
  console.log('✓ icon.png (512x512 主图标)');

  // 3. Windows ICO
  const ico = await buildIco();
  fs.writeFileSync(path.join(OUT, 'icon.ico'), ico);
  console.log('✓ icon.ico (Windows 多尺寸) ' + Math.round(ico.length / 1024) + 'KB');

  // 4. macOS ICNS
  const icns = await buildIcns();
  fs.writeFileSync(path.join(OUT, 'icon.icns'), icns);
  console.log('✓ icon.icns (macOS 多尺寸) ' + Math.round(icns.length / 1024) + 'KB');

  console.log('\n图标已生成到 ' + OUT);
  console.log('在 electron-builder.yml 中引用 build/icons/icon.ico 与 icon.icns 即可。');
}

main().catch((err) => {
  console.error('✗ 生成图标失败:', err);
  process.exit(1);
});
