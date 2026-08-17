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
   * 仅当用户目录中尚未安装内核时执行；复制完成后校验可运行。
   * @param {string|null} [bundledKernelDir] 内置内核目录（默认 process.resourcesPath/kernel）
   * @returns {Promise<{ imported: boolean, version: string|null, reason?: string, error?: string }>}
   */
  async importBundledKernel(bundledKernelDir) {
    const bundled = await this.getBundledKernelInfo(bundledKernelDir);
    if (!bundled.bundled || !bundled.dir) {
      return { imported: false, reason: 'no-bundled-kernel' };
    }
    if (!fs.existsSync(bundled.dir)) {
      return { imported: false, reason: 'no-bundled-kernel' };
    }

    // 用户目录已安装内核则不覆盖（用户可能已手动更新/回滚）
    const local = await this.getLocalKernelInfo();
    if (local.installed) {
      return { imported: false, reason: 'already-installed', version: local.version };
    }

    this.logger.info(`导入内置内核 ${bundled.version} 到 ${this.kernelDir}`);
    try {
      await fsp.mkdir(path.dirname(this.kernelDir), { recursive: true });
      await fsp.cp(bundled.dir, this.kernelDir, { recursive: true, errorOnExist: false });
    } catch (err) {
      this.logger.error(`导入内置内核失败: ${err.message}`);
      // 复制失败时清理半成品
      await this._rmrf(this.kernelDir);
      return { imported: false, error: err.message };
    }

    const runnable = await this.isKernelRunnable();
    if (!runnable) {
      this.logger.error('导入的内置内核不可运行，已清理，请手动重新安装。');
      await this._rmrf(this.kernelDir);
      return { imported: false, error: '内置内核校验失败' };
    }

    return { imported: true, version: bundled.version };
  }

  // ---------------------------------------------------------------
  // 远端版本检查（npm registry）
  // ---------------------------------------------------------------

  /**
   * 查询 npm registry 中 dsh 的远端版本信息
   * @param {string} [channel='latest'] 'latest' | 'stable'
   * @returns {Promise<{ channel: string, version: string|null, publishedAt: string|null, distTags: object }>}
   */
  async fetchRemoteVersion(channel = 'latest') {
    // stable 通道需要全量版本列表，latest 只需要 latest 端点
    if (channel === 'stable') {
      return this._fetchRemoteStable();
    }
    const res = await fetch(`${REGISTRY_BASE}/${DSH_PACKAGE}/latest`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      throw new Error(`npm registry 请求失败 (HTTP ${res.status})`);
    }
    const data = await res.json();
    return {
      channel: 'latest',
      version: data.version || null,
      publishedAt: data.time ? data.time[data.version] || null : null,
      distTags: { latest: data.version || null },
    };
  }

  /** 从全量版本列表中选择最高正式版本（stable 通道） */
  async _fetchRemoteStable() {
    const res = await fetch(`${REGISTRY_BASE}/${DSH_PACKAGE}`, {
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      throw new Error(`npm registry 请求失败 (HTTP ${res.status})`);
    }
    const data = await res.json();
    const versions = Object.keys(data.versions || {});
    const stable = versions.filter((v) => this.isStableVersion(v));
    const pick = stable.length > 0 ? stable : versions; // 无正式版则退回到全部版本
    let best = null;
    for (const v of pick) {
      if (!best || this.compareVersions(v, best) > 0) best = v;
    }
    const time = data.time || {};
    return {
      channel: 'stable',
      version: best,
      publishedAt: best ? time[best] || null : null,
      distTags: data['dist-tags'] || { latest: best },
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
    const npmVersion = await this._runVersionCommand(this._getNpmCmd(), ['--version']);
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

  _getNodeCmd() {
    return process.platform === 'win32' ? 'node.exe' : 'node';
  }

  _getNpmCmd() {
    return process.platform === 'win32' ? 'npm.cmd' : 'npm';
  }

  _runVersionCommand(cmd, args) {
    return new Promise((resolve) => {
      try {
        const child = spawn(cmd, args, {
          shell: process.platform === 'win32',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout.on('data', (d) => (out += d.toString()));
        child.on('error', () => resolve(null));
        child.on('close', (code) => {
          resolve(code === 0 ? out.trim() : null);
        });
        setTimeout(() => {
          try {
            child.kill();
          } catch {}
          resolve(null);
        }, 10000);
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

    // 4. 备份旧内核
    const oldInfo = await this.getLocalKernelInfo();
    await this._rmrf(this.backupDir);
    if (oldInfo.installed) {
      try {
        await fsp.rename(this.kernelDir, this.backupDir);
        progress(`已备份旧内核 (${oldInfo.version})`);
      } catch (err) {
        this.logger.warn(`备份旧内核失败（继续安装）: ${err.message}`);
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
      const npmCmd = this._getNpmCmd();
      const args = [
        'install',
        '--prefix', prefixDir,
        '--no-audit',
        '--no-fund',
        '--no-update-notifier',
        '--loglevel=error',
        `${DSH_PACKAGE}@${version}`,
      ];
      this.logger.info(`执行: ${npmCmd} ${args.join(' ')}`);
      const child = spawn(npmCmd, args, {
        shell: process.platform === 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => {
        stdout += d.toString();
        const text = d.toString().trim();
        if (text) progress(text);
      });
      child.stderr.on('data', (d) => {
        stderr += d.toString();
        const text = d.toString().trim();
        if (text) this.logger.warn(text);
      });
      child.on('error', (err) => reject(new Error(`无法启动 npm: ${err.message}`)));
      child.on('close', (code) => {
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
          shell: process.platform === 'win32',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout.on('data', (d) => (out += d.toString()));
        child.on('error', () => resolve(false));
        child.on('close', (code) => {
          // dsh 成功输出版本号即视为可运行；部分版本 --version 可能返回非 0 但正常输出
          resolve(code === 0 || out.trim().length > 0);
        });
        setTimeout(() => {
          try {
            child.kill();
          } catch {}
          resolve(false);
        }, 20000);
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
