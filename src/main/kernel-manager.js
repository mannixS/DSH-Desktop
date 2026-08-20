'use strict';

/**
 * kernel-manager.js
 * DeepSeek Harness (dsh) 内核管理模块
 *
 * 职责：
 *  1. 检测本地已安装的内核版本
 *  2. 通过 npm registry 检查最新版本（支持 latest / stable 通道）
 *  3. 安装 / 更新 / 回滚内核（原子替换 + 备份机制）
 *  4. Node.js 运行环境检测
 *
 * 内核目录约定：{userData}/kernel
 *   - kernel/package.json
 *   - kernel/node_modules/@deepseek-ai/dsh
 *   - kernel.bak/     （上一版本备份，用于回滚）
 *   - kernel.tmp/     （下载/安装中的临时目录）
 */

const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

// dsh 在 npm 上的包名
const DSH_PACKAGE = '@deepseek-ai/dsh';
// npm registry 端点
const REGISTRY_BASE = 'https://registry.npmjs.org';
// 默认 Node 最低版本要求（dsh 官方要求 v18+，推荐 v24）
const MIN_NODE_MAJOR = 18;
const RECOMMEND_NODE_MAJOR = 24;

class KernelManager {
  /**
   * @param {object} options
   * @param {string} options.kernelDir 内核安装根目录（含 .bak/.tmp 平级）
   * @param {object} [options.logger] 可选日志器 { info, warn, error }
   */
  constructor({ kernelDir, logger }) {
    this.kernelDir = kernelDir;
    this.backupDir = `${kernelDir}.bak`;
    this.tmpDir = `${kernelDir}.tmp`;
    this.logger = logger || {
      info: (...a) => console.log('[kernel]', ...a),
      warn: (...a) => console.warn('[kernel]', ...a),
      error: (...a) => console.error('[kernel]', ...a),
    };
  }

  // ---------------------------------------------------------------
  // 路径辅助
  // ---------------------------------------------------------------

  /** 内核 package.json 路径 */
  get dshPkgJsonPath() {
    return path.join(this.kernelDir, 'node_modules', DSH_PACKAGE, 'package.json');
  }

  /** dsh CLI 入口文件（bin.js）路径 */
  get dshBinPath() {
    return path.join(this.kernelDir, 'node_modules', DSH_PACKAGE, 'lib', 'bin.js');
  }

  // ---------------------------------------------------------------
  // 版本工具
  // ---------------------------------------------------------------

  /**
   * 解析 semver 字符串为可比较结构
   * 支持格式：major.minor.patch[-pre.release]
   * 非 semver（如未知字符串）按 0.0.0 处理并标记 invalid
   */
  _parseVersion(raw) {
    if (typeof raw !== 'string') return { major: 0, minor: 0, patch: 0, pre: [], valid: false };
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(raw.trim());
    if (!m) return { major: 0, minor: 0, patch: 0, pre: [], valid: false };
    return {
      major: parseInt(m[1], 10),
      minor: parseInt(m[2], 10),
      patch: parseInt(m[3], 10),
      pre: m[4] ? m[4].split('.') : [],
      valid: true,
    };
  }

  /**
   * semver 比较（含预发布规则）
   * 返回：a > b → 1；a < b → -1；相等 → 0
   * 预发布版本低于正式版本（1.0.0-rc.1 < 1.0.0）
   */
  compareVersions(a, b) {
    const pa = this._parseVersion(a);
    const pb = this._parseVersion(b);
    if (!pa.valid && !pb.valid) return 0;
    if (!pa.valid) return -1;
    if (!pb.valid) return 1;
    for (const key of ['major', 'minor', 'patch']) {
      if (pa[key] !== pb[key]) return pa[key] > pb[key] ? 1 : -1;
    }
    // 主版本号相同，比较预发布标识
    if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
    if (pa.pre.length === 0) return 1; // a 是正式版 > b 预发布
    if (pb.pre.length === 0) return -1;
    const len = Math.min(pa.pre.length, pb.pre.length);
    for (let i = 0; i < len; i++) {
      const xa = pa.pre[i];
      const xb = pb.pre[i];
      if (xa === xb) continue;
      const na = /^\d+$/.test(xa);
      const nb = /^\d+$/.test(xb);
      if (na && nb) return parseInt(xa, 10) > parseInt(xb, 10) ? 1 : -1;
      if (na) return -1; // 数字 < 字母
      if (nb) return 1;
      return xa > xb ? 1 : -1;
    }
    return pa.pre.length > pb.pre.length ? 1 : -1;
  }

  /** 是否为正式版（无预发布后缀） */
  isStableVersion(version) {
    const p = this._parseVersion(version);
    return p.valid && p.pre.length === 0;
  }

  // ---------------------------------------------------------------
  // 本地内核信息
  // ---------------------------------------------------------------

  /**
   * 读取本地已安装内核的版本号
   * @returns {Promise<{ installed: boolean, version: string|null }>}
   */
  async getLocalKernelInfo() {
    try {
      const pkgRaw = await fsp.readFile(this.dshPkgJsonPath, 'utf8');
      const pkg = JSON.parse(pkgRaw);
      return { installed: true, version: pkg.version || null };
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { installed: false, version: null };
      }
      this.logger.warn(`读取本地内核版本失败: ${err.message}`);
      return { installed: false, version: null };
    }
  }

  /**
   * 校验本地内核可执行（dsh 入口文件存在）
   * @returns {Promise<boolean>}
   */
  async isKernelRunnable() {
    try {
      await fsp.access(this.dshBinPath, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------
  // 内置内核（打包预装）
  // ---------------------------------------------------------------

  /**
   * 读取安装包内置内核的信息（process.resourcesPath/kernel/bundle-info.json）
   * @param {string|null} [bundledKernelDir] 内置内核目录；不传则尝试从 process.resourcesPath 推断
   * @returns {Promise<{ bundled: boolean, version: string|null, dir: string|null }>}
   */
  async getBundledKernelInfo(bundledKernelDir) {
    let dir = bundledKernelDir;
    if (!dir) {
      try {
        dir = path.join(process.resourcesPath, 'kernel');
      } catch {
        return { bundled: false, version: null, dir: null };
      }
    }
    try {
      const infoRaw = await fsp.readFile(path.join(dir, 'bundle-info.json'), 'utf8');
      const info = JSON.parse(infoRaw);
      return { bundled: true, version: info.version || null, dir };
    } catch {
      // 无 bundle-info.json 时尝试直接读包版本
      try {
        const pkgRaw = await fsp.readFile(
          path.join(dir, 'node_modules', DSH_PACKAGE, 'package.json'),
          'utf8'
        );
        return { bundled: true, version: JSON.parse(pkgRaw).version || null, dir };
      } catch {
        return { bundled: false, version: null, dir };
      }
    }
  }

  /**
   * 将内置内核导入用户数据目录（首次启动时调用）
   * 仅当用户目录中尚未安装内核时执行；导入完成后校验可运行。
   *
   * 导入方式（按优先级）：
   *  1. 内置内核为单文件归档（kernel.tar.gz，安装包默认形态）→ 系统 tar 解压
   *  2. 内置内核为裸目录（开发模式 vendor/kernel 直接引用）→ 递归复制（回退）
   *
   * @param {string|null} [bundledKernelDir] 内置内核目录（默认 process.resourcesPath/kernel）
   * @param {object} [options]
   * @param {function(string):void} [options.onProgress] 进度回调
   * @returns {Promise<{ imported: boolean, version: string|null, reason?: string, error?: string }>}
   */
  async importBundledKernel(bundledKernelDir, { onProgress } = {}) {
    const progress = (msg) => {
      this.logger.info(msg);
      if (typeof onProgress === 'function') onProgress(msg);
    };

    const bundled = await this.getBundledKernelInfo(bundledKernelDir);
    if (!bundled.bundled || !bundled.dir) {
      return { imported: false, reason: 'no-bundled-kernel' };
    }
    if (!fs.existsSync(bundled.dir)) {
      return { imported: false, reason: 'no-bundled-kernel' };
    }

    // 用户目录已安装内核，判断是否需要用内置内核对齐：
    //  1. 损坏（如导入不完整）→ 用内置修复
    //  2. 内置版本更高 → 自动升级对齐到内置（"内置版本优先"策略）
    //  3. 否则 → 尊重本地已装版本，不覆盖
    const local = await this.getLocalKernelInfo();
    let shouldReplace = false;
    if (local.installed) {
      const runnable = await this._verifyKernelRunnable(this.kernelDir);
      // 内置版本更高：内置版本合法、本地版本合法、且内置 > 本地
      const bundledHigher =
        bundled.version != null &&
        local.version != null &&
        this.compareVersions(bundled.version, local.version) > 0;
      if (!runnable) {
        this.logger.warn(`本地内核 v${local.version} 无法运行（可能导入不完整），将使用内置内核自动修复...`);
        progress(`检测到本地内核损坏，正在使用内置内核 v${bundled.version} 修复...`);
        shouldReplace = true;
      } else if (bundledHigher) {
        this.logger.info(`内置内核 v${bundled.version} 高于本地 v${local.version}，自动对齐到内置版本...`);
        progress(`检测到内置内核 v${bundled.version} 更新，正在自动对齐（本地 v${local.version}）...`);
        shouldReplace = true;
      } else {
        return { imported: false, reason: 'already-installed', version: local.version };
      }
    }
    if (shouldReplace) {
      await this._rmrf(this.kernelDir);
    }

    const archivePath = path.join(bundled.dir, 'kernel.tar.gz');
    const hasArchive = fs.existsSync(archivePath);
    const hasSourceDir = fs.existsSync(path.join(bundled.dir, 'node_modules'));

    if (!hasArchive && !hasSourceDir) {
      return { imported: false, error: '内置内核资源缺失（既无归档也无源目录）' };
    }

    progress(`正在导入内置内核 v${bundled.version}...`);

    // 解压/复制到临时目录，校验通过后原子替换，避免中途失败留下半成品
    const importTmp = `${this.kernelDir}.import`;
    await this._rmrf(importTmp);
    await this._rmrf(this.kernelDir);

    try {
      await fsp.mkdir(importTmp, { recursive: true });
      if (hasArchive) {
        progress('正在解压内置内核（单文件归档）...');
        await this._extractArchive(archivePath, importTmp);
        progress('内置内核解压完成，正在校验...');
      } else {
        await this._copyRecursive(bundled.dir, importTmp, progress);
      }

      // 校验临时目录中的内核可运行（入口文件存在）
      const tmpBin = path.join(importTmp, 'node_modules', DSH_PACKAGE, 'lib', 'bin.js');
      await fsp.access(tmpBin, fs.constants.R_OK);

      // 原子替换：importTmp → kernelDir
      await fsp.rename(importTmp, this.kernelDir);
    } catch (err) {
      this.logger.error(`导入内置内核失败: ${err.message}`);
      await this._rmrf(importTmp);
      await this._rmrf(this.kernelDir);
      return { imported: false, error: err.message };
    }

    const runnable = await this.isKernelRunnable();
    if (!runnable) {
      this.logger.error('导入的内置内核不可运行，已清理，请手动重新安装。');
      await this._rmrf(this.kernelDir);
      return { imported: false, error: '内置内核校验失败' };
    }

    progress(`内置内核 v${bundled.version} 导入完成`);
    return { imported: true, version: bundled.version };
  }

  /**
   * 用系统 tar 解压归档到目标目录
   * @param {string} archive 归档路径（.tar.gz）
   * @param {string} dest 目标目录（已存在）
   */
  _extractArchive(archive, dest) {
    return new Promise((resolve, reject) => {
      const tarCmd = process.platform === 'win32' ? 'tar.exe' : 'tar';
      // 规避 Windows bsdtar 把 "C:\..." 盘符路径误判为远程主机的问题：
      // 以 dest 为 cwd，归档路径改为相对路径（无盘符、无冒号）
      const archiveRel = path.relative(dest, archive).replace(/\\/g, '/');
      const child = spawn(tarCmd, ['-xzf', archiveRel], {
        cwd: dest,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', (err) => reject(new Error(`无法启动 tar: ${err.message}`)));
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(stderr.trim() || `tar 解压退出码 ${code}`));
        }
      });
    });
  }

  /**
   * 稳健的递归目录复制：
   * - 跳过符号链接 / junction（避免 Windows 上 .bin 链接导致复制失败或死循环）
   * - 通过回调上报进度（每 500 个文件）
   * @param {string} src 源目录
   * @param {string} dest 目标目录
   * @param {function(string):void} [onProgress]
   */
  async _copyRecursive(src, dest, onProgress) {
    let count = 0;
    const tick = () => {
      count++;
      if (count % 500 === 0 && typeof onProgress === 'function') {
        onProgress(`正在导入内置内核...（已复制 ${count} 个文件）`);
      }
    };

    async function walk(from, to) {
      await fsp.mkdir(to, { recursive: true });
      const entries = await fsp.readdir(from, { withFileTypes: true });
      for (const entry of entries) {
        const srcPath = path.join(from, entry.name);
        const destPath = path.join(to, entry.name);
        try {
          if (entry.isSymbolicLink()) {
            // 跳过符号链接（如 node_modules/.bin 中的 junction/链接）
            continue;
          }
          if (entry.isDirectory()) {
            await walk(srcPath, destPath);
          } else if (entry.isFile()) {
            await fsp.copyFile(srcPath, destPath);
            tick();
          } else {
            // 其他类型（socket 等）跳过
          }
        } catch (err) {
          // 单文件失败不影响整体，记录并继续
          console.warn(`[kernel] 跳过复制 ${srcPath}: ${err.message}`);
        }
      }
    }

    await walk(src, dest);
  }

  // ---------------------------------------------------------------
  // 远端版本检查（npm registry）
  // ---------------------------------------------------------------

  /**
   * 查询 npm registry 中 dsh 的远端版本信息
   * 统一拉取全量 packument（/latest 端点不含 time 字段，无法取得发布时间）
   * @param {string} [channel='latest'] 'latest' | 'stable'
   * @returns {Promise<{ channel: string, version: string|null, publishedAt: string|null, distTags: object }>}
   */
  async fetchRemoteVersion(channel = 'latest') {
    const res = await fetch(`${REGISTRY_BASE}/${DSH_PACKAGE}`, {
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      throw new Error(`npm registry 请求失败 (HTTP ${res.status})`);
    }
    const data = await res.json();
    const time = data.time || {};
    const distTags = data['dist-tags'] || {};
    let version = null;
    if (channel === 'stable') {
      // stable 通道：全量版本中选最高正式版（无正式版则退回全部版本）
      const versions = Object.keys(data.versions || {});
      const stable = versions.filter((v) => this.isStableVersion(v));
      const pick = stable.length > 0 ? stable : versions;
      for (const v of pick) {
        if (!version || this.compareVersions(v, version) > 0) version = v;
      }
    } else {
      version = distTags.latest || null;
    }
    return {
      channel,
      version,
      publishedAt: version ? time[version] || null : null,
      distTags,
    };
  }

  /**
   * 检查更新（对比本地与远端版本）
   * @param {string} [channel='latest']
   * @returns {Promise<{ hasUpdate: boolean, local: string|null, remote: string|null, publishedAt: string|null, channel: string }>}
   */
  async checkForUpdates(channel = 'latest') {
    const local = await this.getLocalKernelInfo();
    const remote = await this.fetchRemoteVersion(channel);

    const hasUpdate =
      remote.version != null &&
      (local.version == null || this.compareVersions(remote.version, local.version) > 0);

    return {
      hasUpdate,
      local: local.version,
      remote: remote.version,
      publishedAt: remote.publishedAt,
      channel: remote.channel,
    };
  }

  // ---------------------------------------------------------------
  // Node.js 环境检测
  // ---------------------------------------------------------------

  /**
   * 检测系统 Node.js / npm 是否可用
   * @returns {Promise<{ nodeAvailable: boolean, npmAvailable: boolean, nodeVersion: string|null, npmVersion: string|null, meetsRequirement: boolean, recommended: number, minimum: number }>}
   */
  async detectNodeEnvironment() {
    const nodeVersion = await this._runVersionCommand(this._getNodeCmd(), ['--version']);
    // npm 检测：优先 node + npm-cli.js（兼容含空格路径），回退 npm.cmd
    let npmVersion = null;
    const npmCli = this._getNpmCliPath();
    if (npmCli) {
      npmVersion = await this._runVersionCommand(this._getNodeCmd(), [npmCli, '--version']);
    } else {
      npmVersion = await this._runVersionCommand(this._getNpmCmd(), ['--version']);
    }
    const parsed = this._parseVersion(nodeVersion || '');
    return {
      nodeAvailable: !!nodeVersion,
      npmAvailable: !!npmVersion,
      nodeVersion,
      npmVersion,
      meetsRequirement: nodeVersion ? parsed.major >= MIN_NODE_MAJOR : false,
      minimum: MIN_NODE_MAJOR,
      recommended: RECOMMEND_NODE_MAJOR,
    };
  }

  /**
   * 获取 npm-cli.js 的完整路径（内置 Node 时）
   * @returns {string|null}
   */
  _getNpmCliPath() {
    const bundled = this._getBundledNodeDir();
    if (!bundled) return null;
    const cli = path.join(bundled, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    return fs.existsSync(cli) ? cli : null;
  }

  /**
   * 内置 Node 目录（安装包 extraResources: process.resourcesPath/node）
   * @returns {string|null} 存在返回目录，否则 null
   */
  _getBundledNodeDir() {
    try {
      const dir = path.join(process.resourcesPath, 'node');
      const probe = process.platform === 'win32'
        ? path.join(dir, 'node.exe')
        : path.join(dir, 'bin', 'node');
      if (fs.existsSync(probe)) return dir;
    } catch {}
    return null;
  }

  /**
   * 获取 node 命令：
   *  系统有 node 用系统（PATH），否则回退内置 Node（安装在 resourcesPath/node）
   */
  _getNodeCmd() {
    const bundled = this._getBundledNodeDir();
    if (bundled) {
      // 优先用内置（确保版本一致）；系统有 Node 且满足要求时也可用系统，这里统一用内置最稳妥
      return process.platform === 'win32'
        ? path.join(bundled, 'node.exe')
        : path.join(bundled, 'bin', 'node');
    }
    return process.platform === 'win32' ? 'node.exe' : 'node';
  }

  /**
   * 获取 npm 命令（配合 node 的路径）
   * Windows 内置 node 自带 npm.cmd；macOS 为 bin/npm
   */
  _getNpmCmd() {
    const bundled = this._getBundledNodeDir();
    if (bundled) {
      return process.platform === 'win32'
        ? path.join(bundled, 'npm.cmd')
        : path.join(bundled, 'bin', 'npm');
    }
    return process.platform === 'win32' ? 'npm.cmd' : 'npm';
  }

  /** 是否为内置 Node 路径 */
  _usingBundledNode() {
    return !!this._getBundledNodeDir();
  }

  /**
   * 子进程环境：若使用内置 Node，将其 bin 目录加入 PATH，
   * 确保 npm 脚本 / node 子进程能解析到内置 node。
   */
  _childEnv() {
    const env = { ...process.env };
    const bundled = this._getBundledNodeDir();
    if (bundled) {
      const binDir = process.platform === 'win32' ? bundled : path.join(bundled, 'bin');
      const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
      env[pathKey] = binDir + path.delimiter + (env[pathKey] || '');
    }
    return env;
  }

  _runVersionCommand(cmd, args) {
    return new Promise((resolve) => {
      try {
        // 注意：绝对路径可能含空格（如 "Program Files"、用户名带空格），
        // 必须用 shell:false + 数组传参，否则 shell 拼接命令时路径被拆断
        const child = spawn(cmd, args, {
          shell: false,
          windowsHide: true,
          env: this._childEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout.on('data', (d) => (out += d.toString()));
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {}
          resolve(null);
        }, 10000);
        child.on('error', () => {
          clearTimeout(timer);
          resolve(null);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve(code === 0 ? out.trim() : null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  // ---------------------------------------------------------------
  // 内核安装 / 更新 / 回滚
  // ---------------------------------------------------------------

  /**
   * 安装或更新内核到指定版本
   * 流程：安装到临时目录 → 校验可运行 → 备份旧版 → 原子替换 → 清理
   * @param {string} version 目标版本（如 '0.1.0-rc.6' 或 'latest'）
   * @param {object} [options]
   * @param {function(string):void} [options.onProgress] 进度回调
   * @returns {Promise<{ success: boolean, version: string|null, error?: string }>}
   */
  async installKernel(version, { onProgress } = {}) {
    const progress = (msg) => {
      this.logger.info(msg);
      if (typeof onProgress === 'function') onProgress(msg);
    };

    const env = await this.detectNodeEnvironment();
    if (!env.nodeAvailable || !env.npmAvailable) {
      throw new Error(
        `未检测到可用的 Node.js/npm 环境。请先安装 Node.js v${env.minimum}+（推荐 v${env.recommended}）后再更新内核。`
      );
    }
    if (!env.meetsRequirement) {
      throw new Error(
        `Node.js 版本过低（当前 ${env.nodeVersion}），dsh 内核要求 v${env.minimum}+，推荐 v${env.recommended}+。`
      );
    }

    progress(`开始安装内核 @deepseek-ai/dsh@${version} ...`);

    // 1. 清理并创建临时目录
    await this._rmrf(this.tmpDir);
    await fsp.mkdir(this.tmpDir, { recursive: true });

    // 2. 在临时目录执行 npm install
    try {
      await this._runNpmInstall(this.tmpDir, version, progress);
    } catch (err) {
      await this._rmrf(this.tmpDir);
      throw new Error(`内核下载/安装失败: ${err.message}`);
    }

    // 3. 校验临时目录中的内核可运行
    const tmpPkg = path.join(this.tmpDir, 'node_modules', DSH_PACKAGE, 'package.json');
    const tmpBin = path.join(this.tmpDir, 'node_modules', DSH_PACKAGE, 'lib', 'bin.js');
    let installedVersion = null;
    try {
      const pkgRaw = await fsp.readFile(tmpPkg, 'utf8');
      installedVersion = JSON.parse(pkgRaw).version;
    } catch {
      await this._rmrf(this.tmpDir);
      throw new Error('安装校验失败：临时目录中未找到内核包。');
    }
    try {
      await fsp.access(tmpBin, fs.constants.R_OK);
    } catch {
      await this._rmrf(this.tmpDir);
      throw new Error('安装校验失败：内核入口文件缺失。');
    }

    progress(`内核 ${installedVersion} 下载完成，正在校验可运行性...`);
    const runOk = await this._verifyKernelRunnable(this.tmpDir);
    if (!runOk) {
      await this._rmrf(this.tmpDir);
      throw new Error(`内核 ${installedVersion} 启动校验失败，已中止安装。`);
    }

    // 4. 备份旧内核（失败则中止更新：保留现役内核不被破坏，回滚能力不受影响）
    const oldInfo = await this.getLocalKernelInfo();
    await this._rmrf(this.backupDir);
    if (oldInfo.installed) {
      try {
        await fsp.rename(this.kernelDir, this.backupDir);
        progress(`已备份旧内核 (${oldInfo.version})`);
      } catch (err) {
        await this._rmrf(this.tmpDir);
        throw new Error(
          `备份旧内核失败，已中止更新（当前内核 v${oldInfo.version} 保持不变）。` +
            `常见原因：dsh 正在运行占用文件，请停止 dsh 后重试。详情: ${err.message}`
        );
      }
    }

    // 5. 原子替换：tmp → kernel
    await this._rmrf(this.kernelDir);
    await fsp.rename(this.tmpDir, this.kernelDir);

    progress(`内核更新完成：${oldInfo.version || '无'} → ${installedVersion}`);
    return { success: true, version: installedVersion };
  }

  /**
   * 回滚到上一个版本（从 .bak 恢复）
   * @returns {Promise<{ success: boolean, version: string|null, error?: string }>}
   */
  async rollbackKernel() {
    let bakVersion = null;
    try {
      const bakPkg = path.join(this.backupDir, 'node_modules', DSH_PACKAGE, 'package.json');
      bakVersion = JSON.parse(await fsp.readFile(bakPkg, 'utf8')).version;
    } catch {
      // 无备份或备份损坏
    }
    if (!bakVersion) {
      throw new Error('没有可用的上一版本备份，无法回滚。');
    }

    // 校验备份可运行
    const runOk = await this._verifyKernelRunnable(this.backupDir);
    if (!runOk) {
      throw new Error('备份内核启动校验失败，已中止回滚。');
    }

    // 当前内核移到临时，备份移到当前
    await this._rmrf(this.kernelDir);
    await fsp.rename(this.backupDir, this.kernelDir);
    await this._rmrf(this.backupDir);

    return { success: true, version: bakVersion };
  }

  /**
   * 移除本地内核（用于完全卸载）
   */
  async removeKernel() {
    await this._rmrf(this.kernelDir);
    await this._rmrf(this.backupDir);
    await this._rmrf(this.tmpDir);
  }

  // ---------------------------------------------------------------
  // 内部工具
  // ---------------------------------------------------------------

  /** 在指定目录执行 npm install */
  _runNpmInstall(prefixDir, version, progress) {
    return new Promise((resolve, reject) => {
      // 用 node 直接执行 npm 的 cli.js，彻底避开 .cmd/shell 及空格路径问题：
      // Windows 上 npm.cmd 是 .cmd 脚本，若其绝对路径含空格（如 "DSH Desktop" 目录），
      // spawn 经 shell 拼接会失败。直接用 node 运行 npm-cli.js 最稳妥。
      const nodeCmd = this._getNodeCmd();
      const npmCli = this._getNpmCliPath(); // 内置 Node 时返回 npm-cli.js 路径
      const args = [
        'install',
        '--prefix', prefixDir,
        '--no-audit',
        '--no-fund',
        '--no-update-notifier',
        '--loglevel=verbose',
        `${DSH_PACKAGE}@${version}`,
      ];
      // 组装：优先 node + npm-cli.js；无内置时回退 npm.cmd（shell:false，Node 会自动处理 .cmd）
      let child;
      if (npmCli) {
        this.logger.info(`执行: ${nodeCmd} ${npmCli} ${args.join(' ')}`);
        child = spawn(nodeCmd, [npmCli, ...args], {
          shell: false,
          windowsHide: true,
          env: this._childEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } else {
        const npmCmd = this._getNpmCmd();
        this.logger.info(`执行: ${npmCmd} ${args.join(' ')}`);
        child = spawn(npmCmd, args, {
          shell: false,
          windowsHide: true,
          env: this._childEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      }
      let stdout = '';
      let stderr = '';
      // 心跳：npm 下载大包时可能长时间无输出，定期提示"仍在下载"，避免用户误以为卡死
      let lastProgress = Date.now();
      const heartbeat = setInterval(() => {
        if (Date.now() - lastProgress > 8000) {
          lastProgress = Date.now();
          if (typeof progress === 'function') progress('正在下载内核依赖…（大包下载可能需几分钟，请耐心等待）');
        }
      }, 8000);

      const emitLine = (raw) => {
        const text = (raw || '').trim();
        if (!text) return;
        // 解析 npm verbose 输出，转换为阶段化进度提示
        if (/^npm http fetch GET/.test(text) || /^npm http fetch POST/.test(text)) {
          // 下载请求 → 下载中阶段（不逐条刷屏，靠心跳节流）
          progress('正在下载内核依赖…（阶段 1/3：下载）');
        } else if (/^npm http fetch 200|^npm http fetch 304/.test(text)) {
          progress('正在下载内核依赖…（阶段 1/3：下载）');
        } else if (/^npm timing reify|^npm warn reify|reify:/.test(text)) {
          progress('正在安装内核依赖…（阶段 2/3：安装）');
        } else if (/^added \d+ packages/.test(text)) {
          progress(text + '（阶段 3/3：完成）');
        } else if (/^up to date/.test(text)) {
          progress(text);
        } else if (/^npm notice|^npm timing|^npm verbose/.test(text)) {
          // 忽略 notice/timing/verbose 噪音
        } else {
          // 其他行（如错误）也透传
          progress(text);
        }
        lastProgress = Date.now();
      };

      child.stdout.on('data', (d) => {
        stdout += d.toString();
        emitLine(d.toString());
      });
      child.stderr.on('data', (d) => {
        stderr += d.toString();
        emitLine(d.toString());
      });
      child.on('error', (err) => {
        clearInterval(heartbeat);
        reject(new Error(`无法启动 npm: ${err.message}`));
      });
      child.on('close', (code) => {
        clearInterval(heartbeat);
        if (code === 0) {
          resolve();
        } else {
          const detail = stderr.trim() || stdout.trim();
          reject(new Error(detail || `npm 退出码 ${code}`));
        }
      });
    });
  }

  /**
   * 校验内核可运行：用 node 执行 dsh --version
   * @param {string} kernelDir 待校验的内核目录
   */
  _verifyKernelRunnable(kernelDir) {
    return new Promise((resolve) => {
      const binPath = path.join(kernelDir, 'node_modules', DSH_PACKAGE, 'lib', 'bin.js');
      try {
        const child = spawn(this._getNodeCmd(), [binPath, '--version'], {
          shell: false,
          windowsHide: true,
          env: this._childEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout.on('data', (d) => (out += d.toString()));
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {}
          resolve(false);
        }, 20000);
        child.on('error', () => {
          clearTimeout(timer);
          resolve(false);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          // dsh 成功输出版本号即视为可运行；部分版本 --version 可能返回非 0 但正常输出
          resolve(code === 0 || out.trim().length > 0);
        });
      } catch {
        resolve(false);
      }
    });
  }

  /** 递归删除目录/文件 */
  async _rmrf(target) {
    try {
      await fsp.rm(target, { recursive: true, force: true });
    } catch (err) {
      // 目标不存在或删除失败时静默处理（Windows 文件占用等情况交给上层）
      if (err.code !== 'ENOENT') {
        this.logger.warn(`清理失败 ${target}: ${err.message}`);
      }
    }
  }
}

module.exports = { KernelManager, DSH_PACKAGE, REGISTRY_BASE };
