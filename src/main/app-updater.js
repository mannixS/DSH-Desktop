'use strict';

/**
 * app-updater.js
 * 客户端（自身）程序自动更新模块 —— 基于 electron-updater
 *
 * 更新源：GitHub Releases（本仓库 mannixS/DSH-Desktop）。
 * electron-builder 打包时自动生成 latest.yml（Windows）与
 * latest-mac.yml（macOS），随 Release 发布到 GitHub，updater 据此检查并下载更新。
 *
 * 流程：
 *  init()             → 初始化 autoUpdater，订阅事件，配置 GitHub 源
 *  checkForUpdate()   → 手动/自动检查更新（有新版本则自动下载）
 *  下载完成           → 推送 update-downloaded 事件，UI 提示"安装并重启"
 *  downloadAndInstall()-> 触发安装并重启
 */

const { app, shell } = require('electron');
const path = require('path');
const fs = require('fs');

class AppUpdater {
  /**
   * @param {object} options
   * @param {object} options.settings 设置对象（含 appUpdateOwner/appUpdateRepo）
   * @param {object} [options.logger]
   * @param {function(string, object):void} [options.onEvent] 事件回调 (event, payload)
   */
  constructor({ settings, logger, onEvent }) {
    this.settings = settings;
    this.logger = logger || {
      info: (...a) => console.log('[app-update]', ...a),
      warn: (...a) => console.warn('[app-update]', ...a),
      error: (...a) => console.error('[app-update]', ...a),
    };
    this.onEvent = onEvent || (() => {});
    this.initialized = false;
    this.updateDownloaded = false;
    /** 已下载安装包的落盘路径与版本（macOS 引导式手动更新需要该文件） */
    this._downloadedFile = null;
    this._downloadedVersion = null;
    /** 当前生效的更新源（{ key, label }） */
    this._activeSource = null;
    /** 最近一次更新源测速结果（供 UI 展示） */
    this._sourceLatency = [];
    /** electron-updater 的 autoUpdater 实例（懒加载） */
    this._autoUpdater = null;
  }

  /**
   * electron-updater 的 autoUpdater（按平台自动选择 NsisUpdater/MacUpdater 等）。
   * 注意：必须是 electron-updater 的 autoUpdater，而不是 electron 原生的——
   * 原生 autoUpdater 是 Squirrel 实现，只认 { url } 格式，
   * 传入 { provider: 'github' } 会抛 "Expected options object to contain a 'url'..."。
   * 懒加载：require 顶层解构会立刻触发构造（依赖 Electron 运行时），纯 node 测试环境不可用。
   */
  _au() {
    if (!this._autoUpdater) {
      this._autoUpdater = require('electron-updater').autoUpdater;
    }
    return this._autoUpdater;
  }

  /** 当前应用版本 */
  get currentVersion() {
    return app.getVersion();
  }

  /** 更新源是否已配置（GitHub 仓库 / CNB 镜像 / 自定义 URL 任一可用即可） */
  isConfigured() {
    return this._buildSources().length > 0;
  }

  /**
   * 初始化 autoUpdater 并订阅事件（应用 ready 后调用一次）
   * 仅在打包环境（app.isPackaged）下启用自动更新；
   * 开发模式 electron-updater 无有效 feed 且无法更新，跳过以避免 setFeedURL 抛错。
   */
  init() {
    if (this.initialized) return;
    this.initialized = true;

    if (!app.isPackaged) {
      this.logger.info('开发模式，跳过程序自动更新初始化。');
      return;
    }

    // 事件订阅
    this._au().on('checking-for-update', () => {
      this._emit('checking');
    });
    this._au().on('update-available', (info) => {
      this.logger.info(`发现新版本 ${info.version}`);
      this._emit('available', { version: info.version });
    });
    this._au().on('update-not-available', () => {
      this.logger.info('已是最新版本');
      this._emit('not-available', { version: this.currentVersion });
    });
    this._au().on('error', (err) => {
      this.logger.error('更新错误: ' + err.message);
      this._emit('error', { message: err.message });
    });
    this._au().on('download-progress', (progressObj) => {
      this._emit('progress', {
        percent: Math.round(progressObj.percent),
        transferred: progressObj.transferred,
        total: progressObj.total,
        bytesPerSecond: progressObj.bytesPerSecond,
      });
    });
    this._au().on('update-downloaded', (info) => {
      this.updateDownloaded = true;
      // 记录安装包落盘路径：macOS 引导式手动更新要把该文件交给用户
      this._downloadedFile = (info && info.downloadedFile) || null;
      this._downloadedVersion = (info && info.version) || null;
      this.logger.info(`新版本 ${info.version} 已下载完成`);
      this._emit('downloaded', { version: info.version, manual: this.isManualUpdateMode });
    });

    this.logger.info('autoUpdater 初始化完成');
  }

  /**
   * 读取并规范化更新源配置：
   * repo 字段可能被存成 "owner/repo" 完整格式（旧版 UI 所致），此处拆分，
   * 避免拼出 github.com/<owner>/<owner>/<repo> 重复 owner 的 404。
   */
  _readRepoConfig() {
    let owner = (this.settings.get('appUpdateOwner') || 'mannixS').trim();
    let repo = (this.settings.get('appUpdateRepo') || 'DSH-Desktop').trim();
    if (repo.includes('/')) {
      const parts = repo.split('/').filter(Boolean);
      if (parts.length >= 2) {
        owner = parts[0];
        repo = parts.slice(1).join('/');
      }
    }
    return { owner, repo };
  }

  /** 确保 URL 以 / 结尾（generic provider 按目录拼接清单文件名，缺尾斜杠会截掉末段） */
  static _dirUrl(url) {
    return url.endsWith('/') ? url : url + '/';
  }

  /**
   * 构建候选更新源：
   * - `github`：GitHub Releases（electron-updater 的 github provider）
   * - `cnb`   ：cnb.cool 国内镜像的 Release 公开直链（generic provider，国内下载快）
   * - `custom`：用户在设置中填写的自定义地址（generic provider）
   * 每个源都带 `base`（清单文件所在目录），供测速与清单比对复用。
   * @returns {Array<{key: string, label: string, feed: object, base: string}>}
   */
  _buildSources() {
    const { owner, repo } = this._readRepoConfig();
    const customUrl = (this.settings.get('appUpdateUrl') || '').trim();
    const cnbRepo =
      (this.settings.get('appUpdateCnbRepo') || '').trim() ||
      (owner && repo ? `${owner}/${repo}` : '');
    const list = [];
    if (customUrl) {
      const base = AppUpdater._dirUrl(customUrl);
      list.push({ key: 'custom', label: '自定义源', feed: { provider: 'generic', url: base }, base });
    }
    if (owner && repo) {
      list.push({
        key: 'github',
        label: 'GitHub',
        feed: { provider: 'github', owner, repo },
        base: `https://github.com/${owner}/${repo}/releases/latest/download/`,
      });
    }
    if (cnbRepo.includes('/')) {
      const base = `https://cnb.cool/${cnbRepo}/-/releases/download/latest/`;
      list.push({ key: 'cnb', label: 'CNB 国内镜像', feed: { provider: 'generic', url: base }, base });
    }
    return list;
  }

  /** 按当前模式筛选候选源；auto 返回全部（交由测速决定），模式无匹配时回退全部 */
  _candidateSources() {
    const all = this._buildSources();
    const mode = this.settings.get('appUpdateSourceMode') || 'auto';
    if (mode === 'auto') return all;
    const picked = all.filter((s) => s.key === mode);
    return picked.length ? picked : all;
  }

  /** 当前平台对应的更新清单文件名 */
  _manifestName() {
    return process.platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml';
  }

  /**
   * 选择更新源：`auto` 模式下并发探测各源清单文件的响应时间，
   * 选用「可用且最快」的源（国内网络下通常命中 CNB 镜像）；
   * 指定模式则直接返回该源。全部不可探测时回退首选源，由 electron-updater 报出具体错误。
   * @returns {Promise<object|null>}
   */
  async _resolveSource() {
    const list = this._candidateSources();
    if (!list.length) return null;
    if (list.length === 1) {
      this._sourceLatency = [{ key: list[0].key, label: list[0].label, ms: null }];
      return list[0];
    }
    const manifest = this._manifestName();
    const probe = async (source) => {
      const started = Date.now();
      try {
        const res = await fetch(source.base + manifest, {
          method: 'GET',
          signal: AbortSignal.timeout(6000),
        });
        if (!res.ok) return null;
        await res.arrayBuffer();
        return { source, ms: Date.now() - started };
      } catch {
        return null;
      }
    };
    const results = (await Promise.all(list.map(probe)))
      .filter(Boolean)
      .sort((a, b) => a.ms - b.ms);
    this._sourceLatency = results.map((r) => ({ key: r.source.key, label: r.source.label, ms: r.ms }));
    if (!results.length) {
      this.logger.warn('所有更新源均探测失败，回退首选源');
      return list[0];
    }
    this.logger.info(
      `更新源测速：${results.map((r) => `${r.source.label} ${r.ms}ms`).join('，')} → 选用 ${results[0].source.label}`
    );
    return results[0].source;
  }

  /** 应用更新源（setFeedURL）；每次检查都重设，确保用户在设置中的改动即时生效 */
  _applySource(source) {
    if (!source) return;
    this._au().setFeedURL(source.feed);
    this._activeSource = { key: source.key, label: source.label };
    this.logger.info(`更新源: ${source.label}`);
  }

  /** 检查更新（有新版本则自动下载） */
  async checkForUpdate() {
    if (!app.isPackaged) {
      return { configured: false, current: this.currentVersion, skipped: true, reason: 'dev-mode' };
    }
    if (!this.initialized) this.init();
    if (!this.isConfigured()) {
      return { configured: false, current: this.currentVersion };
    }
    try {
      // 选择更新源：auto 模式会并发探测各源清单响应时间，优先国内快速源
      this._applySource(await this._resolveSource());
      // await checkForUpdates：electron-updater 的 checkForUpdates() 返回 Promise，
      // 不 await 会导致 UI 一直停留在"检查中"（事件可能已错过）
      const result = await this._au().checkForUpdates();
      const info = result && result.updateInfo;
      return {
        configured: true,
        current: this.currentVersion,
        latest: info ? info.version : null,
        updateAvailable: !!(info && info.version !== this.currentVersion),
        source: this._activeSource,
        sourceLatency: this._sourceLatency || [],
      };
    } catch (err) {
      this.logger.error('检查更新失败: ' + err.message);
      return { configured: true, current: this.currentVersion, error: err.message };
    }
  }

  /**
   * 是否采用"引导式手动更新"（当前仅 macOS）。
   *
   * macOS 的自动安装依赖 Squirrel 的 ShipIt，其代码签名校验
   * （SecStaticCodeCheckValidity）要求新 app 满足当前 app 的 designated requirement；
   * 本项目没有 Apple Developer ID 证书，mac 包只能 ad-hoc 签名，其 designated
   * requirement 退化为内容哈希（cdhash）——新版本内容必然不同，校验注定失败，
   * 报 "Code signature ... did not pass validation: 代码不含资源，但签名指示这些资源必须存在"。
   * 因此 macOS 改为把安装包交给用户手动拖拽覆盖（不经过 ShipIt，不做签名校验）。
   * Windows（NSIS）不校验签名，自动更新不受影响。
   */
  get isManualUpdateMode() {
    return process.platform === 'darwin';
  }

  /** 本仓库的 Release 页面地址（引导式更新的兜底下载入口） */
  releasePageUrl() {
    const { owner, repo } = this._readRepoConfig();
    if (!owner || !repo) return null;
    return `https://github.com/${owner}/${repo}/releases/latest`;
  }

  /**
   * macOS 引导式手动安装：
   * 把 electron-updater 已下载的安装包复制到「下载」目录并打开，
   * 由用户将 DSH Desktop.app 拖入「应用程序」覆盖安装（无需代码签名校验）。
   * 本地安装包不可用时退回打开 Release 下载页。
   */
  _guideMacManualInstall() {
    if (!this.updateDownloaded) {
      // 尚未下载完成：触发/继续下载，等 update-downloaded 事件后再点一次
      if (!this.initialized) this.init();
      try {
        this._au().checkForUpdates();
      } catch {}
      return { ok: true, downloading: true, manual: true };
    }
    try {
      const src = this._downloadedFile;
      if (!src || !fs.existsSync(src)) throw new Error('未找到已下载的安装包');
      const dest = path.join(app.getPath('downloads'), path.basename(src));
      if (path.resolve(src) !== path.resolve(dest)) fs.copyFileSync(src, dest);
      // 打开安装包：macOS 会用「归档实用工具」解压 zip，用户即可拖拽覆盖
      shell.openPath(dest).catch((e) => this.logger.warn('打开安装包失败: ' + e.message));
      this.logger.info(`macOS 引导式更新：安装包已放入下载目录 ${dest}`);
      return { ok: true, manual: true, path: dest, version: this._downloadedVersion };
    } catch (err) {
      const url = this.releasePageUrl();
      this.logger.warn(`本地安装包不可用（${err.message}），改为打开下载页${url ? ': ' + url : ''}`);
      if (url) shell.openExternal(url).catch(() => {});
      return { ok: true, manual: true, fallbackUrl: url, error: err.message };
    }
  }

  /** 安装并重启（新版本已下载完成时） */
  async downloadAndInstall() {
    if (!app.isPackaged) {
      return { ok: false, error: '开发模式不支持自动更新' };
    }
    // 用户可能未先"检查更新"就直接点击安装：先解析并应用更新源
    if (!this._activeSource) {
      try {
        this._applySource(await this._resolveSource());
      } catch (err) {
        this.logger.warn('解析更新源失败: ' + err.message);
      }
    }
    // macOS：无 Apple 证书时 ShipIt 签名校验必然失败，改走引导式手动更新
    if (this.isManualUpdateMode) {
      return this._guideMacManualInstall();
    }
    if (this.updateDownloaded) {
      this._au().quitAndInstall(false, true);
      return { ok: true };
    }
    // 未下载完成则重新触发检查（触发自动下载）
    if (!this.initialized) this.init();
    try {
      this._au().checkForUpdates();
      return { ok: true, downloading: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  _emit(event, payload) {
    try {
      this.onEvent(event, payload);
    } catch (err) {
      this.logger.warn('更新事件回调异常: ' + err.message);
    }
  }
}

module.exports = { AppUpdater };
