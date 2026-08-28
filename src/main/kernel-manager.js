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
// 官方 npm registry 端点（默认兜底）
const REGISTRY_BASE = 'https://registry.npmjs.org';
// 国内镜像（npmmirror，已验证同步 @deepseek-ai/dsh）
const CN_REGISTRY = 'https://registry.npmmirror.com';
// 自动源探测结果的缓存时长（5 分钟），避免每次操作都重新测速
const AUTO_REGISTRY_CACHE_MS = 5 * 60 * 1000;
// 默认 Node 最低版本要求（dsh 官方要求 v18+，推荐 v24）
const MIN_NODE_MAJOR = 18;
const RECOMMEND_NODE_MAJOR = 24;

class KernelManager {
  /**
   * @param {object} options
   * @param {string} options.kernelDir 内核安装根目录（含 .bak/.tmp 平级）
   * @param {object} [options.logger] 可选日志器 { info, warn, error }
   * @param {function():{mode:string,customUrl?:string}} [options.registryConfig] 下载源配置读取函数
   *   mode: 'auto'（默认，探测最快源）/ 'cn' / 'official' / 'custom'
   */
  constructor({ kernelDir, logger, registryConfig }) {
    this.kernelDir = kernelDir;
    this.backupDir = `${kernelDir}.bak`;
    this.tmpDir = `${kernelDir}.tmp`;
    this.registryConfig = registryConfig || null;
    this.logger = logger || {
      info: (...a) => console.log('[kernel]', ...a),
      warn: (...a) => console.warn('[kernel]', ...a),
      error: (...a) => console.error('[kernel]', ...a),
    };
    /** 自动源探测缓存 { url, at } */
    this._autoRegistry = null;
    /** 正在进行的 npm install 子进程（用于中止退出保护） */
    this._npmChild = null;
  }

  // ---------------------------------------------------------------
  // npm registry 下载源解析
  // ---------------------------------------------------------------

  /**
   * 解析当前应使用的 registry 地址（异步：auto 模式需要测速探测）
   * @returns {Promise<string>}
   */
  async getRegistryBase() {
    const cfg = (this.registryConfig && this.registryConfig()) || {};
    const mode = cfg.mode || 'auto';
    if (mode === 'cn') return CN_REGISTRY;
    if (mode === 'official') return REGISTRY_BASE;
    if (mode === 'custom') {
      const url = (cfg.customUrl || '').trim().replace(/\/+$/, '');
      if (/^https?:\/\//i.test(url)) return url;
      this.logger.warn(`自定义下载源无效（${url}），回退官方源`);
      return REGISTRY_BASE;
    }
    return this._resolveAutoRegistry();
  }

  /**
   * 自动模式：并发探测内置两源的访问延迟，取更快且可用的那个。
   * 结果缓存 5 分钟，探测失败时回退官方源（不影响功能）。
   * @returns {Promise<string>}
   */
  async _resolveAutoRegistry() {
    if (this._autoRegistry && Date.now() - this._autoRegistry.at < AUTO_REGISTRY_CACHE_MS) {
      return this._autoRegistry.url;
    }
    // 用最小元数据端点测速（带 /latest 的 packument 比全量小得多）
    const probe = async (url) => {
      const t0 = Date.now();
      try {
        const res = await fetch(`${url}/${DSH_PACKAGE}/latest`, {
          signal: AbortSignal.timeout(4000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { url, ms: Date.now() - t0 };
      } catch {
        return null;
      }
    };
    const results = await Promise.all([probe(CN_REGISTRY), probe(REGISTRY_BASE)]);
    const ok = results.filter(Boolean).sort((a, b) => a.ms - b.ms);
    const pick = ok.length > 0 ? ok[0].url : REGISTRY_BASE;
    this._autoRegistry = { url: pick, at: Date.now() };
    this.logger.info(
      `自动下载源探测完成，选用 ${pick}` +
        (ok.length > 0 ? `（${ok[0].ms}ms，备选 ${ok.slice(1).map((r) => r.url + ':' + r.ms + 'ms').join(', ') || '无'}）` : '（均不可达，回退官方源）')
    );
    return pick;
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

  /**
   * 内置对齐标记文件（记录最近一次用内置内核覆盖对齐时的版本）
   * 放 kernelDir 平级，避免被覆盖/删除时丢失。
   */
  get alignMarkPath() {
    return `${this.kernelDir}.aligned-mark.json`;
  }

  /** 读取对齐标记（不存在或损坏时返回空对象） */
  async _readAlignMark() {
    try {
      return JSON.parse(await fsp.readFile(this.alignMarkPath, 'utf8'));
    } catch {
      return {};
    }
  }

  /** 写入对齐标记 */
  async _writeAlignMark(version) {
    try {
      await fsp.writeFile(
        this.alignMarkPath,
        JSON.stringify({ version, at: Date.now() }),
        'utf8'
      );
    } catch (err) {
      this.logger.warn(`写入内核对齐标记失败: ${err.message}`);
    }
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
   * @param {function({message:string,percent:number}):void} [options.onProgress] 进度回调（结构化对象）
   * @returns {Promise<{ imported: boolean, version: string|null, reason?: string, error?: string }>}
   */
  async importBundledKernel(bundledKernelDir, { onProgress } = {}) {
    const progress = (percent, message) => {
      const pct = Math.max(0, Math.min(100, Math.round(percent)));
      this.logger.info(message);
      if (typeof onProgress === 'function') onProgress({ message, percent: pct });
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
    //  3. 内置版本等于本地，但尚未对齐过 → 覆盖一次（修复历史上同版本的
    //     缺损内核，如早期坏归档导入的 rc.7；用对齐标记去重，避免每次启动重复解压）
    //  4. 否则（本地更高，或已对齐）→ 尊重本地已装版本
    // 删除旧内核目录可能很慢（node_modules 文件众多，Windows 上尤其明显，
    // 实测动辄 10-30 秒）。期间以心跳持续推送进度提示，避免界面长时间无反馈。
    const rmWithHeartbeat = async (target, pct, message) => {
      progress(pct, message);
      const hb = setInterval(() => progress(pct, message), 3000);
      try {
        await this._rmrf(target);
      } finally {
        clearInterval(hb);
      }
    };

    const local = await this.getLocalKernelInfo();
    let shouldReplace = false;
    let alignReason = '';
    if (local.installed) {
      const runnable = await this._verifyKernelRunnable(this.kernelDir);
      const cmp =
        bundled.version != null && local.version != null
          ? this.compareVersions(bundled.version, local.version)
          : 0;
      const mark = await this._readAlignMark();
      // 尚未对齐过：标记缺失，或标记版本与当前内置版本不同
      const notAligned = mark.version !== bundled.version;
      if (!runnable) {
        this.logger.warn(`本地内核 v${local.version} 无法运行（可能导入不完整），将使用内置内核自动修复...`);
        progress(2, `检测到本地内核损坏，正在使用内置内核 v${bundled.version} 修复...`);
        shouldReplace = true;
        alignReason = 'broken';
      } else if (cmp > 0) {
        this.logger.info(`内置内核 v${bundled.version} 高于本地 v${local.version}，自动对齐到内置版本...`);
        progress(2, `检测到内置内核 v${bundled.version} 更新，正在自动对齐（本地 v${local.version}）...`);
        shouldReplace = true;
        alignReason = 'bundled-newer';
      } else if (cmp === 0 && notAligned) {
        this.logger.info(`本地内核 v${local.version} 与内置同版本但未对齐过，用内置内核覆盖对齐...`);
        progress(2, `正在用内置内核 v${bundled.version} 覆盖对齐本地内核...`);
        shouldReplace = true;
        alignReason = 'align-once';
      } else {
        return { imported: false, reason: 'already-installed', version: local.version };
      }
    }
    if (shouldReplace) {
      await rmWithHeartbeat(this.kernelDir, 3, '正在清理旧内核目录，准备对齐到内置版本（文件较多时可能需要一点时间）…');
    }

    const archivePath = path.join(bundled.dir, 'kernel.tar.gz');
    const hasArchive = fs.existsSync(archivePath);
    const hasSourceDir = fs.existsSync(path.join(bundled.dir, 'node_modules'));

    if (!hasArchive && !hasSourceDir) {
      return { imported: false, error: '内置内核资源缺失（既无归档也无源目录）' };
    }

    progress(5, `正在导入内置内核 v${bundled.version}...`);

    // 解压/复制到临时目录，校验通过后原子替换，避免中途失败留下半成品
    const importTmp = `${this.kernelDir}.import`;
    await rmWithHeartbeat(importTmp, 4, '正在准备内核导入目录…');
    await rmWithHeartbeat(this.kernelDir, 4, '正在准备内核导入目录…');

    try {
      await fsp.mkdir(importTmp, { recursive: true });
      if (hasArchive) {
        progress(8, '正在解压内置内核（单文件归档），请稍候…');
        // 解压期间定期上报进度（tar 本身静默，靠心跳推进百分比）
        await this._extractArchive(archivePath, importTmp, (pct, msg) => progress(pct, msg));
        progress(88, '内置内核解压完成，正在校验…');
        progress(93, '内置内核校验通过，正在安装…');
      } else {
        progress(10, '正在复制内置内核文件…');
        await this._copyRecursive(bundled.dir, importTmp, progress);
        progress(88, '内置内核文件复制完成，正在校验…');
        progress(93, '内置内核校验通过，正在安装…');
      }

      // 校验临时目录中的内核可运行（入口文件存在）
      const tmpBin = path.join(importTmp, 'node_modules', DSH_PACKAGE, 'lib', 'bin.js');
      await fsp.access(tmpBin, fs.constants.R_OK);

      // 原子替换：importTmp → kernelDir
      progress(97, '正在应用内置内核…');
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

    progress(100, `内置内核 v${bundled.version} 导入完成`);
    // 记录已用内置内核对齐（避免同版本场景每次启动重复覆盖）
    await this._writeAlignMark(bundled.version);
    return { imported: true, version: bundled.version };
  }

  /**
   * 用系统 tar 解压归档到目标目录
   * tar 静默执行不输出进度，通过心跳推进百分比（8→85），
   * 保证解压大归档期间界面仍有持续提示。
   * @param {string} archive 归档路径（.tar.gz）
   * @param {string} dest 目标目录（已存在）
   * @param {function(number,string):void} [onTick] 进度回调 (percent, message)
   */
  _extractArchive(archive, dest, onTick) {
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
      // tar 静默执行：心跳兜底推进百分比（8→85），确保解压期间界面持续有提示
      let pct = 8;
      const tick = typeof onTick === 'function' ? onTick : () => {};
      const heartbeat = setInterval(() => {
        pct = Math.min(85, pct + Math.max(0.4, (85 - pct) * 0.04));
        tick(Math.round(pct), '正在解压内置内核（单文件归档），可能需要 1-2 分钟，请耐心等待…');
      }, 3000);
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('error', (err) => {
        clearInterval(heartbeat);
        reject(new Error(`无法启动 tar: ${err.message}`));
      });
      child.on('close', (code) => {
        clearInterval(heartbeat);
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
   * - 通过回调上报结构化进度（每 500 个文件，百分比以渐进方式推进）
   * @param {string} src 源目录
   * @param {string} dest 目标目录
   * @param {function(number,string):void} [onProgress] (percent, message)
   */
  async _copyRecursive(src, dest, onProgress) {
    let count = 0;
    let pct = 10;
    const tick = () => {
      count++;
      if (count % 500 === 0 && typeof onProgress === 'function') {
        pct = Math.min(85, pct + Math.max(0.3, (85 - pct) * 0.06));
        onProgress(Math.round(pct), `正在复制内置内核文件…（已复制 ${count} 个文件）`);
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
    const base = await this.getRegistryBase();
    const res = await fetch(`${base}/${DSH_PACKAGE}`, {
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
   * 进度回调为结构化对象 { message, percent }（percent 为 0-100 整数）。
   * @param {string} version 目标版本（如 '0.1.0-rc.6' 或 'latest'）
   * @param {object} [options]
   * @param {function({message:string,percent:number}):void} [options.onProgress] 进度回调
   * @returns {Promise<{ success: boolean, version: string|null, error?: string }>}
   */
  async installKernel(version, { onProgress } = {}) {
    const progress = (percent, message) => {
      const pct = Math.max(0, Math.min(100, Math.round(percent)));
      this.logger.info(message);
      if (typeof onProgress === 'function') onProgress({ message, percent: pct });
    };

    progress(1, '正在检测 Node.js / npm 环境...');
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

    progress(3, `环境就绪，开始安装内核 @deepseek-ai/dsh@${version} ...`);

    // 1. 清理并创建临时目录
    await this._rmrf(this.tmpDir);
    await fsp.mkdir(this.tmpDir, { recursive: true });

    // 2. 在临时目录执行 npm install（内部按 3→90 估算进度）
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

    progress(91, `内核 ${installedVersion} 依赖安装完成，正在校验可运行性...`);
    const runOk = await this._verifyKernelRunnable(this.tmpDir);
    if (!runOk) {
      await this._rmrf(this.tmpDir);
      throw new Error(`内核 ${installedVersion} 启动校验失败，已中止安装。`);
    }

    progress(95, `内核 ${installedVersion} 校验通过，正在替换旧内核...`);

    // 4. 备份旧内核（失败则中止更新：保留现役内核不被破坏，回滚能力不受影响）
    const oldInfo = await this.getLocalKernelInfo();
    await this._rmrf(this.backupDir);
    if (oldInfo.installed) {
      try {
        await fsp.rename(this.kernelDir, this.backupDir);
        progress(96, `已备份旧内核 (${oldInfo.version})`);
      } catch (err) {
        await this._rmrf(this.tmpDir);
        throw new Error(
          `备份旧内核失败，已中止更新（当前内核 v${oldInfo.version} 保持不变）。` +
            `常见原因：dsh 正在运行占用文件，请停止 dsh 后重试。详情: ${err.message}`
        );
      }
    }

    // 5. 原子替换：tmp → kernel
    // 若替换中途失败（磁盘/权限/进程占用），尽力从备份恢复旧内核，
    // 避免内核目录缺失导致 dsh 完全不可用（找不到内核时下次启动会用内置内核修复）。
    try {
      await this._rmrf(this.kernelDir);
      await fsp.rename(this.tmpDir, this.kernelDir);
    } catch (err) {
      await this._rmrf(this.tmpDir);
      this.logger.warn(`应用新内核失败，尝试从备份恢复旧内核: ${err.message}`);
      if (fs.existsSync(this.backupDir)) {
        try {
          await fsp.rename(this.backupDir, this.kernelDir);
          progress(96, '内核替换失败，已从备份恢复旧内核，建议稍后重试更新。');
        } catch (e2) {
          this.logger.error(`恢复备份内核失败: ${e2.message}`);
        }
      }
      throw new Error(`应用新内核失败: ${err.message}`);
    }

    progress(100, `内核更新完成：${oldInfo.version || '无'} → ${installedVersion}`);
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

  /**
   * 在指定目录执行 npm install
   * 进度回调签名 (percent, message)，内部按阶段估算百分比：
   *   下载阶段 3→70、安装阶段 70→88、完成 90，心跳兜底保证进度条持续走动。
   * @param {string} prefixDir 安装目录
   * @param {string} version 目标版本
   * @param {function(number,string):void} progress
   */
  async _runNpmInstall(prefixDir, version, progress) {
    // 解析下载源（auto 模式首次会测速探测），显式传给 npm，
    // 避免用户机器上的 .npmrc 配置（如老旧的淘宝源）干扰
    const registry = await this.getRegistryBase();

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
        '--registry', registry,
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
      // 记录子进程，供 abortInstall() 在退出保护时终止
      this._npmChild = child;

      let stdout = '';
      let stderr = '';
      let pct = 3; // 从 installKernel 传入的 3% 起算
      let phase = 'idle'; // 'idle' → 'download' → 'reify' → 'done'

      // 向目标百分比渐进推进：差值越小步幅越小，保证不同依赖规模的包都能平滑前进
      const bump = (target, message) => {
        if (phase !== 'done') {
          pct = target > pct ? Math.min(target, pct + Math.max(0.3, (target - pct) * 0.15)) : pct;
          progress(Math.round(pct), message);
        } else {
          progress(Math.round(pct), message);
        }
      };

      // 心跳：npm 下载大包时可能长时间无输出，定时推动进度条，避免用户误以为卡死
      let lastProgress = Date.now();
      const heartbeat = setInterval(() => {
        lastProgress = Date.now();
        if (phase === 'download') bump(70, '正在下载内核依赖…（大包下载可能需要几分钟，请耐心等待）');
        else if (phase === 'reify') bump(88, '正在安装内核依赖，请稍候…');
        else progress(Math.round(pct), '稍等，正在更新内核…');
      }, 4000);

      const emitLine = (raw) => {
        const text = (raw || '').trim();
        if (!text) return;
        // 解析 npm verbose 输出，转换为阶段化进度提示与百分比推进
        if (/^npm http fetch GET|^npm http fetch POST/.test(text)) {
          if (phase === 'idle' || phase === 'download') { phase = 'download'; bump(70, '正在下载内核依赖（阶段 1/3：下载）…'); }
        } else if (/^npm http fetch 200|^npm http fetch 304/.test(text)) {
          if (phase === 'download') bump(70, '正在下载内核依赖（阶段 1/3：下载）…');
        } else if (/^npm timing reify|^npm warn reify|reify:/.test(text)) {
          if (phase !== 'reify') { phase = 'reify'; pct = Math.max(pct, 72); }
          bump(88, '正在安装内核依赖（阶段 2/3：安装）…');
        } else if (/^added \d+ packages/.test(text)) {
          phase = 'done'; pct = Math.max(pct, 90);
          progress(Math.round(pct), text + '（阶段 3/3：完成）');
        } else if (/^up to date/.test(text)) {
          phase = 'done'; pct = Math.max(pct, 88);
          progress(Math.round(pct), text);
        } else if (/^npm notice|^npm timing|^npm verbose/.test(text)) {
          // 忽略 notice/timing/verbose 噪音
        } else {
          // 其他行（如错误）也透传
          progress(Math.round(pct), text);
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
        this._npmChild = null;
        reject(new Error(`无法启动 npm: ${err.message}`));
      });
      child.on('close', (code) => {
        clearInterval(heartbeat);
        this._npmChild = null;
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
   * 中止正在进行的内核安装（退出保护时调用）。
   * 终止 npm 子进程并清理临时目录；安装只发生在 .tmp 中，
   * 中止不会影响现役内核，仅可能留下需要下次启动修复的残余 tmp。
   * @param {object} [opts]
   * @param {boolean} [opts.removeTmp=true] 是否清理临时目录
   */
  abortInstall({ removeTmp = true } = {}) {
    const child = this._npmChild;
    this._npmChild = null;
    if (child && child.exitCode == null && !child.killed) {
      try {
        child.kill();
        this.logger.warn('内核安装已中止（用户退出应用）');
      } catch (err) {
        this.logger.warn(`中止 npm 子进程失败: ${err.message}`);
      }
    }
    if (removeTmp) {
      this._rmrf(this.tmpDir).then(() => {}).catch(() => {});
    }
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

module.exports = { KernelManager, DSH_PACKAGE, REGISTRY_BASE, CN_REGISTRY };
