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

const { app } = require('electron');

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
      this.logger.info(`新版本 ${info.version} 已下载完成`);
      this._emit('downloaded', { version: info.version });
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

  /** 安装并重启（新版本已下载完成时） */
  downloadAndInstall() {
    if (!app.isPackaged) {
      return { ok: false, error: '开发模式不支持自动更新' };
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
