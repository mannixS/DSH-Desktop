'use strict';

/**
 * settings.js
 * 客户端设置持久化（JSON 文件，位于 userData/settings.json）
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const DEFAULTS = {
  // 自动检查更新开关
  autoCheckUpdate: true,
  // 自动检查间隔（分钟）
  checkIntervalMinutes: 60,
  // 更新通道：'latest' 跟随 npm latest（可能为 RC）；'stable' 仅正式版
  updateChannel: 'latest',
  // 检测到新版本时是否自动安装（false = 仅提示，由用户手动确认）
  autoInstall: false,
  // dsh Web UI 端口
  dshPort: 3080,
  // dsh 启动参数（数组，如 ['web']）
  dshMode: 'web',
  // 应用启动后自动运行 dsh（有内核时），使主页直接呈现工作台
  autoStartDsh: true,
  // 上次检查更新时间（时间戳）
  lastCheckAt: null,
  // 上次更新完成时间（时间戳）
  lastUpdateAt: null,
  // ---- 客户端自身程序更新（预留）----
  // GitHub Releases 模式：填 owner + repo（如 'your-name/dsh-desktop'）
  appUpdateOwner: '',
  appUpdateRepo: '',
  // 自定义 JSON 更新源：返回 { version, notes, published_at, assets: [{ name, url, platform }] }
  appUpdateUrl: '',
  // 是否自动检查程序更新（启动后延时检查）
  appAutoCheckUpdate: true,
};

class Settings {
  /**
   * @param {string} filePath settings.json 绝对路径
   */
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { ...DEFAULTS };
  }

  /** 加载设置（不存在则使用默认值） */
  async load() {
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = { ...DEFAULTS, ...parsed };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn('[settings] 读取设置失败，使用默认值:', err.message);
      }
    }
    return this.data;
  }

  /** 保存设置到磁盘 */
  async save() {
    try {
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
      await fsp.writeFile(this.filePath, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (err) {
      console.warn('[settings] 保存设置失败:', err.message);
    }
  }

  /** 更新设置（合并），并持久化 */
  async update(patch) {
    this.data = { ...this.data, ...patch };
    await this.save();
    return this.data;
  }

  get(key) {
    return this.data[key];
  }
}

module.exports = { Settings, DEFAULTS };
