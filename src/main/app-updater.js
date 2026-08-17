'use strict';

/**
 * app-updater.js
 * 客户端（自身）程序更新模块 —— 预留能力框架
 *
 * 更新源设计（两种模式）：
 *  1. GitHub Releases（推荐）：配置 owner/repo 后，查询该仓库 latest release
 *  2. 自定义 JSON 端点：配置 updateUrl，返回 { version, notes, assets: [{ name, url, platform }] }
 *
 * 工作流程：
 *  checkForUpdate() → 对比当前 app 版本 → 有新版本则返回 release 信息
 *  downloadUpdate(release) → 下载与当前平台匹配的安装包到系统下载目录
 *  （安装由用户运行下载的安装包完成，跨平台最稳妥；Windows 可配合 NSIS /S 静默参数）
 *
 * 未配置更新源时，checkForUpdate 返回 { configured: false }，UI 提示"未配置程序更新源"。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { app } = require('electron');

const GITHUB_API = 'https://api.github.com/repos';

class AppUpdater {
  /**
   * @param {object} options
   * @param {object} options.settings 设置对象（含 appUpdateOwner/appUpdateRepo/appUpdateUrl）
   * @param {object} [options.logger]
   */
  constructor({ settings, logger }) {
    this.settings = settings;
    this.logger = logger || {
      info: (...a) => console.log('[app-update]', ...a),
      warn: (...a) => console.warn('[app-update]', ...a),
      error: (...a) => console.error('[app-update]', ...a),
    };
  }

  /** 当前应用版本（来自 package.json） */
  get currentVersion() {
    return app.getVersion();
  }

  /**
   * 判断更新源是否已配置
   */
  isConfigured() {
    const owner = (this.settings.get('appUpdateOwner') || '').trim();
    const repo = (this.settings.get('appUpdateRepo') || '').trim();
    const url = (this.settings.get('appUpdateUrl') || '').trim();
    return !!((owner && repo) || url);
  }

  /**
   * 检查客户端是否有新版本
   * @returns {Promise<{ configured: boolean, hasUpdate: boolean, current: string, latest: string|null, tag: string|null, publishedAt: string|null, notes: string, downloadUrl: string|null, error?: string }>}
   */
  async checkForUpdate() {
    if (!this.isConfigured()) {
      return {
        configured: false,
        hasUpdate: false,
        current: this.currentVersion,
        latest: null,
        tag: null,
        publishedAt: null,
        notes: '',
        downloadUrl: null,
      };
    }

    try {
      const release = await this._fetchLatestRelease();
      const latestTag = this._normalizeTag(release.tag_name);
      const current = this.currentVersion;

      const hasUpdate = this._compareAppVersions(latestTag, current) > 0;
      const asset = hasUpdate ? this._pickAsset(release.assets) : null;

      return {
        configured: true,
        hasUpdate,
        current,
        latest: latestTag,
        tag: release.tag_name,
        publishedAt: release.published_at || null,
        notes: release.body || '',
        downloadUrl: asset ? asset.url : null,
        assetName: asset ? asset.name : null,
      };
    } catch (err) {
      this.logger.warn(`检查程序更新失败: ${err.message}`);
      return {
        configured: true,
        hasUpdate: false,
        current: this.currentVersion,
        latest: null,
        tag: null,
        publishedAt: null,
        notes: '',
        downloadUrl: null,
        error: err.message,
      };
    }
  }

  /**
   * 下载安装包到系统下载目录
   * @param {string} url 安装包直链（GitHub release asset browser_download_url）
   * @param {string} [filename] 可选文件名
   * @returns {Promise<{ ok: boolean, filePath: string|null, error?: string }>}
   */
  async downloadUpdate(url, filename) {
    if (!url) return { ok: false, error: '缺少下载地址' };
    const downloadsDir = app.getPath('downloads');
    const name = filename || this._defaultFileName(url);
    const target = path.join(downloadsDir, name);

    try {
      this.logger.info(`下载程序更新安装包: ${url} -> ${target}`);
      const res = await fetch(url, { signal: AbortSignal.timeout(300000) });
      if (!res.ok) throw new Error(`下载失败 (HTTP ${res.status})`);
      const buf = Buffer.from(await res.arrayBuffer());
      await fsp.writeFile(target, buf);
      return { ok: true, filePath: target, size: buf.length };
    } catch (err) {
      this.logger.error(`下载安装包失败: ${err.message}`);
      return { ok: false, error: err.message, filePath: null };
    }
  }

  // ---------------- 内部 ----------------

  /** 获取 GitHub latest release */
  async _fetchLatestRelease() {
    const owner = (this.settings.get('appUpdateOwner') || '').trim();
    const repo = (this.settings.get('appUpdateRepo') || '').trim();
    const customUrl = (this.settings.get('appUpdateUrl') || '').trim();

    if (customUrl) {
      const res = await fetch(customUrl, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`更新源请求失败 (HTTP ${res.status})`);
      const data = await res.json();
      // 兼容自定义 JSON：{ version, notes, published_at, assets: [{ name, url, platform }] }
      return {
        tag_name: data.version || data.tag_name,
        published_at: data.published_at || data.publishedAt || null,
        body: data.notes || data.body || '',
        assets: (data.assets || []).map((a) => ({
          name: a.name,
          url: a.url || a.browser_download_url,
          platform: a.platform || '',
        })),
      };
    }

    const res = await fetch(`${GITHUB_API}/${owner}/${repo}/releases/latest`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'dsh-desktop-client',
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      if (res.status === 404) throw new Error('更新源仓库不存在或暂无 release');
      throw new Error(`GitHub API 请求失败 (HTTP ${res.status})`);
    }
    return res.json();
  }

  /** 将 tag（如 v1.2.0 / 1.2.0）规范化为纯版本号 */
  _normalizeTag(tag) {
    if (!tag) return '0.0.0';
    const m = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(tag.trim());
    return m ? m[1] : tag.trim();
  }

  /**
   * 简单版本比较（客户端自身版本为常规 semver，无需预发布复杂规则）
   * @returns {number} a > b ? 1 : a < b ? -1 : 0
   */
  _compareAppVersions(a, b) {
    const pa = a.split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
    const pb = b.split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
      const x = pa[i] || 0;
      const y = pb[i] || 0;
      if (x !== y) return x > y ? 1 : -1;
    }
    return 0;
  }

  /** 挑选与当前平台/架构匹配的安装包资源 */
  _pickAsset(assets) {
    if (!Array.isArray(assets) || assets.length === 0) return null;
    const plat = process.platform; // win32 | darwin
    const arch = process.arch; // x64 | arm64
    const wanted = [];
    if (plat === 'win32') {
      wanted.push('.exe');
      wanted.push('.msi');
    } else {
      wanted.push('.dmg');
      wanted.push('.zip');
    }
    // 优先精确匹配 arch
    const byArch = assets.filter((a) => {
      const n = a.name.toLowerCase();
      const hasArch = n.includes(arch);
      return wanted.some((ext) => n.endsWith(ext)) && hasArch;
    });
    const pool = byArch.length > 0 ? byArch : assets.filter((a) =>
      wanted.some((ext) => a.name.toLowerCase().endsWith(ext))
    );
    if (pool.length === 0) return assets[0];
    return pool[0];
  }

  _defaultFileName(url) {
    try {
      const p = new URL(url).pathname;
      const base = path.posix.basename(p);
      if (base) return base;
    } catch {}
    return 'dsh-desktop-update-' + Date.now() + (process.platform === 'win32' ? '.exe' : '.dmg');
  }
}

module.exports = { AppUpdater };
