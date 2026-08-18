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

const { app, autoUpdater } = require('electron');

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

    const owner = (this.settings.get('appUpdateOwner') || 'mannixS').trim();
    const repo = (this.settings.get('appUpdateRepo') || 'DSH-Desktop').trim();
    const customUrl = (this.settings.get('appUpdateUrl') || '').trim();

    // 设置更新源。打包环境且未配置自定义 URL 时，可直接用 electron-builder 的
    // publish 配置（setFeedURL 传空对象会从 app-update.yml 读取 GitHub 源）。
    if (!customUrl) {
      autoUpdater.setFeedURL({ provider: 'github', owner, repo });
    } else {
      autoUpdater.setFeedURL({ provider: 'generic', url: customUrl });
    }

    // 事件订阅
    autoUpdater.on('checking-for-update', () => {
      this._emit('checking');
    });
    autoUpdater.on('update-available', (info) => {
      this.logger.info(`发现新版本 ${info.version}`);
      this._emit('available', { version: info.version });
    });
    autoUpdater.on('update-not-available', () => {
      this.logger.info('已是最新版本');
      this._emit('not-available', { version: this.currentVersion });
    });
    autoUpdater.on('error', (err) => {
      this.logger.error('更新错误: ' + err.message);
      this._emit('error', { message: err.message });
    });
    autoUpdater.on('download-progress', (progressObj) => {
      this._emit('progress', {
        percent: Math.round(progressObj.percent),
        transferred: progressObj.transferred,
        total: progressObj.total,
        bytesPerSecond: progressObj.bytesPerSecond,
      });
    });
    autoUpdater.on('update-downloaded', (info) => {
      this.updateDownloaded = true;
      this.logger.info(`新版本 ${info.version} 已下载完成`);
      this._emit('downloaded', { version: info.version });
    });

    this.logger.info(`autoUpdater 初始化完成，更新源: GitHub ${owner}/${repo}`);
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
      // await checkForUpdates：electron-updater 的 checkForUpdates() 返回 Promise，
      // 不 await 会导致 UI 一直停留在"检查中"（事件可能已错过）
      const result = await autoUpdater.checkForUpdates();
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
      autoUpdater.quitAndInstall(false, true);
      return { ok: true };
    }
    // 未下载完成则重新触发检查（触发自动下载）
    if (!this.initialized) this.init();
    try {
      autoUpdater.checkForUpdates();
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
