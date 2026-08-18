'use strict';

/**
 * build.js
 * 开发构建辅助：语法检查 + 提示打包命令
 * 用法：node scripts/build.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function sh(cmd) {
  console.log('$', cmd);
  execSync(cmd, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
}

console.log('=== DSH Desktop 构建检查 ===');
console.log('');

// 1. 语法检查主进程与渲染进程 JS
const jsFiles = [
  'src/main/main.js',
  'src/main/kernel-manager.js',
  'src/main/dsh-host.js',
  'src/main/settings.js',
  'src/main/app-updater.js',
  'src/preload.js',
  'renderer/renderer.js',
  'scripts/check-env.js',
  'scripts/fetch-kernel.js',
  'scripts/fetch-node.js',
];
let ok = true;
for (const f of jsFiles) {
  const abs = path.join(root, f);
  if (!fs.existsSync(abs)) {
    console.log(`✗ 缺少文件: ${f}`);
    ok = false;
    continue;
  }
  try {
    new Function('require', 'module', 'exports', fs.readFileSync(abs, 'utf8'));
    console.log(`✓ 语法 OK: ${f}`);
  } catch (err) {
    console.log(`✗ 语法错误: ${f} -> ${err.message}`);
    ok = false;
  }
}

// 2. package.json 校验
try {
  JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  console.log('✓ package.json 有效');
} catch (err) {
  console.log('✗ package.json 无效: ' + err.message);
  ok = false;
}

if (!ok) {
  console.log('');
  console.log('构建检查未通过，请修复上述问题。');
  process.exit(1);
}

console.log('');
console.log('构建检查通过。');
console.log('');
console.log('打包命令：');
console.log('  npm run pack:win   # 生成 Windows 安装包 (dist/)');
console.log('  npm run pack:mac   # 生成 macOS 安装包 (dist/)');
console.log('  npm start          # 开发模式运行');
