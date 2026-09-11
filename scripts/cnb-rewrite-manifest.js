'use strict';
/**
 * cnb-rewrite-manifest.js
 * 为 CNB 的「latest 通道」生成更新清单。
 *
 * 背景：electron-builder 生成的 latest.yml / latest-mac.yml 中 files[].url 是相对文件名。
 * 若把这两个清单直接放进 latest 通道 Release，electron-updater 会把 url 解析为
 *   https://cnb.cool/<slug>/-/releases/download/latest/<文件名>
 * 而安装包只存在于版本化 Release（vX.Y.Z）中 —— 会导致 404。
 *
 * 因此这里把 url 改写为指向对应版本化 Release 的绝对地址，使 latest 通道只需存放
 * 两个几十 KB 的清单文件，避免重复上传上百 MB 的安装包。
 *
 * 用法：node scripts/cnb-rewrite-manifest.js <tag> <distDir> <repoSlug>
 */

const fs = require('fs');
const path = require('path');

const [tag, distDir, slug] = process.argv.slice(2);
if (!tag || !distDir || !slug) {
  console.error('用法: node scripts/cnb-rewrite-manifest.js <tag> <distDir> <repoSlug>');
  process.exit(1);
}

const base = `https://cnb.cool/${slug}/-/releases/download/${tag}/`;
const outDir = path.join(distDir, 'latest-channel');
fs.mkdirSync(outDir, { recursive: true });

let count = 0;
for (const name of ['latest.yml', 'latest-mac.yml']) {
  const src = path.join(distDir, name);
  if (!fs.existsSync(src)) {
    console.log(`    - ${name} 不存在，跳过`);
    continue;
  }
  const rewritten = fs
    .readFileSync(src, 'utf8')
    // 只改写 files[].url（行内形如 `url: 文件名`），已是绝对地址的保持原样。
    // 用 [^\S\n]（空白但非换行）匹配缩进/空格，避免 \s 吞掉行尾换行导致整行匹配失败。
    .replace(/^([^\S\n]*-?[^\S\n]*url:[^\S\n]*)(\S+)[^\S\n]*$/gm, (line, key, value) =>
      /^https?:\/\//i.test(value) ? line : `${key}${base}${value}`
    );
  fs.writeFileSync(path.join(outDir, name), rewritten, 'utf8');
  count++;
  console.log(`    - ${name} → latest-channel/${name}`);
}
console.log(`    共生成 ${count} 个清单（url 前缀 ${base}）`);
