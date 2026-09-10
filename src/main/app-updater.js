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
    /** 已应用的更新源标识（设置变化时据此重新 setFeedURL） */
    this._feedKey = null;
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

  /** 更新源是否已配置（GitHub owner/repo，带默认兜底） */
  isConfigured() {
    const owner = (this.settings.get('appUpdateOwner') || 'mannixS').trim();
    const repo = (this.settings.get('appUpdateRepo') || 'DSH-Desktop').trim();
    return !!(owner && repo);
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

    this._syncFeed();

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

  /**
   * 根据当前设置应用更新源；设置发生变化时重新 setFeedURL，
   * 用户在设置中修改 GitHub 仓库 / 自定义 URL 后无需重启应用即生效。
   */
  _syncFeed() {
    const { owner, repo } = this._readRepoConfig();
    const customUrl = (this.settings.get('appUpdateUrl') || '').trim();
    const key = customUrl ? `generic:${customUrl}` : `github:${owner}/${repo}`;
    if (this._feedKey === key) return;
    if (customUrl) {
      this._au().setFeedURL({ provider: 'generic', url: customUrl });
      this.logger.info(`更新源已切换: ${customUrl}`);
    } else {
      this._au().setFeedURL({ provider: 'github', owner, repo });
      this.logger.info(`更新源已切换: GitHub ${owner}/${repo}`);
    }
    this._feedKey = key;
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
      // 每次检查前同步更新源（用户可能刚在设置中修改了 GitHub 仓库 / 自定义 URL）
      this._syncFeed();
      // await checkForUpdates：electron-updater 的 checkForUpdates() 返回 Promise，
      // 不 await 会导致 UI 一直停留在"检查中"（事件可能已错过）
      const result = await this._au().checkForUpdates();
      const info = result && result.updateInfo;
      return {
        configured: true,
        current: this.currentVersion,
        latest: info ? info.version : null,
        updateAvailable: !!(info && info.version !== this.currentVersion),
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
  downloadAndInstall() {
    if (!app.isPackaged) {
      return { ok: false, error: '开发模式不支持自动更新' };
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
