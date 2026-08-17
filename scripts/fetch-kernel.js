'use strict';

/**
 * fetch-kernel.js
 * 打包前预下载 dsh 内核到 vendor/kernel，供 electron-builder 以 extraResources
 * 打入安装包（process.resourcesPath/kernel）。用户安装客户端后首启即可使用，
 * 无需联网下载内核。
 *
 * 用法：node scripts/fetch-kernel.js [version]
 *   - 省略 version 时安装 latest
 *   - 可通过环境变量 DSH_KERNEL_VERSION 指定版本
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const vendorDir = path.join(root, 'vendor');
const kernelDir = path.join(vendorDir, 'kernel');
const DSH_PACKAGE = '@deepseek-ai/dsh';
const INFO_FILE = path.join(kernelDir, 'bundle-info.json');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    cwd: root,
    stdio: opts.silent ? 'pipe' : 'inherit',
  });
  return r;
}

function nodeCmd() {
  return process.platform === 'win32' ? 'node.exe' : 'node';
}

function npmCmd() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

console.log('=== DSH Desktop 内置内核预下载 ===');

// 1. 环境检查
const nodeV = run(nodeCmd(), ['--version'], { silent: true });
if (nodeV.status !== 0) {
  console.error('✗ 未检测到 Node.js，无法下载内核。');
  process.exit(1);
}
console.log('✓ Node.js: ' + (nodeV.stdout || '').trim());

// 2. 确定目标版本
const version = process.env.DSH_KERNEL_VERSION || process.argv[2] || 'latest';

// 3. 下载内核到 vendor/kernel
console.log(`下载 ${DSH_PACKAGE}@${version} ...`);
fs.mkdirSync(vendorDir, { recursive: true });
fs.rmSync(kernelDir, { recursive: true, force: true });
fs.mkdirSync(kernelDir, { recursive: true });

const install = run(
  npmCmd(),
  [
    'install',
    '--prefix', kernelDir,
    '--no-audit',
    '--no-fund',
    '--no-update-notifier',
    '--loglevel=error',
    `${DSH_PACKAGE}@${version}`,
  ],
  { silent: true }
);

if (install.status !== 0) {
  console.error('✗ 内核下载失败:');
  console.error((install.stderr || '').trim() || (install.stdout || '').trim() || '未知错误');
  process.exit(1);
}

// 4. 读取实际安装版本
const pkgPath = path.join(kernelDir, 'node_modules', DSH_PACKAGE, 'package.json');
if (!fs.existsSync(pkgPath)) {
  console.error('✗ 内核包未安装到预期位置: ' + pkgPath);
  process.exit(1);
}
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

// 5. 写入版本信息文件（供运行时读取内置版本号）
const info = {
  package: DSH_PACKAGE,
  version: pkg.version,
  fetchedAt: new Date().toISOString(),
  note: '内置内核：安装客户端后自动导入到用户数据目录，之后可通过客户端更新/回滚。',
};
fs.writeFileSync(INFO_FILE, JSON.stringify(info, null, 2), 'utf8');

// 6. 清理 npm 生成的 lock（避免误提交）
const lock = path.join(kernelDir, 'package-lock.json');
if (fs.existsSync(lock)) fs.rmSync(lock, { force: true });

console.log(`✓ 内置内核下载完成: ${DSH_PACKAGE}@${pkg.version}`);
console.log(`  位置: vendor/kernel (${info.fetchedAt})`);
console.log('');
console.log('执行 `npm run pack:win` 或 `npm run pack:mac` 即可将内核打包进安装包。');
