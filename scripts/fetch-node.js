'use strict';

/**
 * fetch-node.js
 * 打包前预下载便携版 Node.js 到 vendor/node，供 electron-builder 以 extraResources
 * 打入安装包（process.resourcesPath/node）。用户系统未安装 Node.js/npm 时，
 * 客户端使用内置 Node 运行 dsh 内核，无需联网安装。
 *
 * 用法：node scripts/fetch-node.js [version]
 *   - 省略 version 时用默认 v24.17.0（当前最新 LTS）
 *   - 可通过环境变量 DSH_NODE_VERSION 指定版本
 *
 * 平台差异：
 *   Windows: node-vXX-win-x64.zip（内含 node.exe, npm.cmd 等）
 *   macOS:   node-vXX-darwin-arm64.tar.gz / node-vXX-darwin-x64.tar.gz
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const vendorDir = path.join(root, 'vendor');
const NODE_VERSION = process.env.DSH_NODE_VERSION || process.argv[2] || 'v24.17.0';
const INFO_FILE = path.join(vendorDir, 'node', 'bundle-info.json');

// 官方下载基础地址
const BASE = 'https://nodejs.org/dist';

function nodeCmd() { return process.platform === 'win32' ? 'node.exe' : 'node'; }

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    cwd: root,
    stdio: opts.silent ? 'pipe' : 'inherit',
  });
}

/** 下载文件 */
async function download(url, dest) {
  const res = await fetch(url, { signal: AbortSignal.timeout(600000) });
  if (!res.ok) throw new Error(`下载失败 (HTTP ${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf.length;
}

async function main() {
  console.log('=== DSH Desktop 内置 Node.js 预下载 ===');

  const isWin = process.platform === 'win32';
  const arch = isWin ? 'x64' : process.arch; // darwin: arm64 | x64
  const fileBase = `node-${NODE_VERSION}-${isWin ? 'win-x64' : `darwin-${arch}`}`;
  const ext = isWin ? '.zip' : '.tar.gz';
  const file = fileBase + ext;
  const url = `${BASE}/${NODE_VERSION}/${file}`;

  const downloadDir = path.join(vendorDir, 'node-download');
  fs.mkdirSync(downloadDir, { recursive: true });
  const archivePath = path.join(downloadDir, file);

  // 1. 下载（若已缓存则复用，避免重复下载）
  if (!fs.existsSync(archivePath) || fs.statSync(archivePath).size === 0) {
    console.log(`下载 ${url}`);
    try {
      const size = await download(url, archivePath);
      console.log(`✓ 已下载 ${file} (${Math.round(size / 1048576)} MB)`);
    } catch (err) {
      console.error(`✗ 下载失败: ${err.message}`);
      console.error('  可指定版本: DSH_NODE_VERSION=v22.12.0 node scripts/fetch-node.js');
      process.exit(1);
    }
  } else {
    console.log(`✓ 使用已缓存的 ${file}`);
  }

  // 2. 解压到 vendor/node
  const outDir = path.join(vendorDir, 'node');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  if (isWin) {
    // Windows：用 PowerShell Expand-Archive 解压（spawnSync 数组传参，避免引号丢失）
    const ps = spawnSync('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${outDir}' -Force`],
      { encoding: 'utf8', cwd: outDir });
    if (ps.status !== 0) {
      console.error('✗ zip 解压失败: ' + ((ps.stderr || '').trim() || (ps.stdout || '').trim() || 'unknown'));
      process.exit(1);
    }
    // 将 node-vXX-win-x64 顶层目录内容上移到 outDir
    const inner = fs.readdirSync(outDir).find((n) => n.startsWith('node-v') && fs.statSync(path.join(outDir, n)).isDirectory());
    if (inner) {
      const innerDir = path.join(outDir, inner);
      for (const e of fs.readdirSync(innerDir)) {
        fs.renameSync(path.join(innerDir, e), path.join(outDir, e));
      }
      fs.rmSync(innerDir, { recursive: true, force: true });
    }
  } else {
    // macOS/Linux 用 tar 解压（相对路径避免盘符问题）
    const archiveRel = path.relative(outDir, archivePath).replace(/\\/g, '/');
    const r = run('tar', ['-xzf', archiveRel, '--strip-components=1'], { silent: true, cwd: outDir });
    if (r.status !== 0) {
      console.error('✗ tar 解压失败: ' + ((r.stderr || '').trim() || (r.stdout || '').trim()));
      process.exit(1);
    }
  }

  // 3. 验证 node 可运行（用绝对路径，避免解析到系统 node）
  const nodeExe = isWin ? path.join(outDir, 'node.exe') : path.join(outDir, 'bin', 'node');
  if (!fs.existsSync(nodeExe)) {
    console.error('✗ 解压后未找到 node 可执行文件: ' + nodeExe);
    process.exit(1);
  }
  const ver = run(nodeExe, ['--version'], { silent: true });
  if (ver.status !== 0) {
    console.error('✗ 内置 node 无法运行');
    process.exit(1);
  }

  // 4. 写入版本信息
  fs.writeFileSync(
    INFO_FILE,
    JSON.stringify({ version: NODE_VERSION, platform: process.platform, arch, fetchedAt: new Date().toISOString() }, null, 2),
    'utf8'
  );

  // 5. 清理下载临时目录
  fs.rmSync(downloadDir, { recursive: true, force: true });

  console.log(`✓ 内置 Node.js ${ver.stdout.trim()} 就绪 (${outDir})`);
  console.log('');
  console.log('执行 `npm run pack:win` 或 `npm run pack:mac` 即可将内置 Node 打包进安装包。');
}

main().catch((err) => {
  console.error('✗ 内置 Node 下载失败:', err);
  process.exit(1);
});
