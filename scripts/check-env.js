'use strict';

/**
 * check-env.js
 * 开发/运行环境检查：Node.js 版本、npm 可用性
 * 用法：node scripts/check-env.js
 */

const { spawnSync } = require('child_process');

const MIN_MAJOR = 18;
const RECOMMEND_MAJOR = 24;

function run(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32' });
    if (r.status === 0) return (r.stdout || '').trim();
    return null;
  } catch {
    return null;
  }
}

const nodeBin = process.platform === 'win32' ? 'node.exe' : 'node';
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const nodeVersion = run(nodeBin, ['--version']);
const npmVersion = run(npmBin, ['--version']);

console.log('=== DSH Desktop 环境检查 ===');
console.log('');

if (!nodeVersion) {
  console.log('✗ Node.js：未检测到');
  console.log('  请访问 https://nodejs.org/zh-cn/download 安装 v' + MIN_MAJOR + '+（推荐 v' + RECOMMEND_MAJOR + '+）');
  process.exit(1);
} else {
  const major = parseInt(nodeVersion.replace(/^v/, '').split('.')[0], 10);
  const ok = major >= MIN_MAJOR;
  console.log((ok ? '✓' : '✗') + ' Node.js：' + nodeVersion + (ok ? '' : `（要求 v${MIN_MAJOR}+，推荐 v${RECOMMEND_MAJOR}+）`));
  if (!ok) process.exit(1);
}

if (!npmVersion) {
  console.log('✗ npm：未检测到');
  process.exit(1);
} else {
  console.log('✓ npm：' + npmVersion);
}

console.log('');
console.log('环境就绪。运行 `npm install` 安装依赖后执行 `npm start` 启动客户端。');
