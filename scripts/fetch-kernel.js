'use strict';

/**
 * fetch-kernel.js
 * 打包前预下载 dsh 内核到 vendor/kernel，并打包为单文件归档 vendor/kernel.tar.gz。
 * electron-builder 将归档与版本信息打入安装包（process.resourcesPath/kernel）。
 *
 * 为什么用归档：内核含 3 万+ 小文件，若以裸目录打进安装包，NSIS 安装时要
 * 逐个解压文件（加 Defender 扫描），安装极慢。归档为单文件后安装秒级完成，
 * 首次启动时由客户端用系统 tar 快速解压导入。
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
const ARCHIVE = path.join(vendorDir, 'kernel.tar.gz');
const DSH_PACKAGE = '@deepseek-ai/dsh';
const INFO_FILE = path.join(kernelDir, 'bundle-info.json');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    cwd: opts.cwd || root,
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

function tarCmd() {
  // Windows 10 1803+ / macOS / Linux 均自带 tar（bsdtar 或 GNU tar）
  return 'tar';
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

// 7. 打包为单文件归档（精简冗余内容 + 排除符号链接 .bin）
// 注意：必须使用相对路径，规避 Windows bsdtar 把 "D:\..." 盘符误判为
// "远程主机:路径"（rsh 风格，报 "Cannot connect to D: resolve failed"）。
// 归档输出到 ARCHIVE（vendor/kernel.tar.gz），与 electron-builder.yml 的
// extraResources 引用路径保持一致。
//
// 精简说明：node_modules 含大量运行时不需要的冗余（调试符号/源码映射/TS 源码/
// 文档等），剔除后可显著减小安装包体积，加快 NSIS 安装与首次导入速度。
// 已编译 JS 运行不依赖 .ts/.map/.pdb，剔除不影响 dsh 功能。
console.log('打包内核为单文件归档 kernel.tar.gz ...');
const archiveRel = path.relative(kernelDir, ARCHIVE).replace(/\\/g, '/'); // "../kernel.tar.gz"
const EXCLUDES = [
  'node_modules/.bin', // 符号链接目录，跨平台解压会出问题
  '*.map', // sourcemap
  '*.tsbuildinfo', // TS 增量编译缓存
  '*.pdb', // 调试符号
  '*.ts', // TS 源码（已编译）
  '*.mts', // TS 源码（ESM）
  '*.cts', // TS 源码（CJS）
  '*/test/*', '*/tests/*', '*/__tests__/*', // 测试
  '*/docs/*', '*/doc/*', // 文档
  '*/examples/*', '*/example/*', // 示例
];
const tarArgs = ['-czf', archiveRel];
for (const e of EXCLUDES) tarArgs.push('--exclude', e);
tarArgs.push('.');
const tar = run(tarCmd(), tarArgs, { silent: true, cwd: kernelDir });
if (tar.status !== 0) {
  console.error('✗ 内核归档打包失败:');
  console.error((tar.stderr || '').trim() || (tar.stdout || '').trim() || '未知错误');
  process.exit(1);
}

const archiveSize = Math.round(fs.statSync(ARCHIVE).size / 1024 / 1024);
console.log(`✓ 内置内核下载完成: ${DSH_PACKAGE}@${pkg.version}`);
console.log(`  归档: vendor/kernel.tar.gz (${archiveSize} MB)`);
console.log(`  版本信息: vendor/kernel/bundle-info.json`);
console.log('');
console.log('执行 `npm run pack:win` 或 `npm run pack:mac` 即可将内核打包进安装包。');
