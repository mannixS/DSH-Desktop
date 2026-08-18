'use strict';

/**
 * main.js
 * Electron 主进程入口：窗口创建、IPC 路由、内核管理与 dsh 托管编排
 */

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { KernelManager } = require('./kernel-manager');
const { DshHost } = require('./dsh-host');
const { Settings } = require('./settings');
const { AppUpdater } = require('./app-updater');

// 防止应用被再次实例化后继续跑（单实例）
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  bootstrap();
}

function bootstrap() {
  // ---------------- 全局状态 ----------------
  let mainWindow = null;
  let updateTimer = null;
  let checkingUpdate = false;
  let installingUpdate = false;

  // 各模块数据目录
  const userData = app.getPath('userData');
  const kernelDir = path.join(userData, 'kernel');
  const dshHome = path.join(userData, 'dsh-home');

  const settings = new Settings(path.join(userData, 'settings.json'));
  const kernelManager = new KernelManager({ kernelDir, logger: makeLogger('[kernel]') });
  const dshHost = new DshHost({
    kernelDir,
    dshHome,
    port: 3080,
    logger: makeLogger('[dsh]'),
  });
  const appUpdater = new AppUpdater({
    settings,
    logger: makeLogger('[app-update]'),
    onEvent: (event, payload) => notifyRenderer('app-update:event', { event, payload }),
  });

  // 推送日志给渲染进程（滚动保留最近 500 条）
  const logBuffer = [];
  // 向渲染进程发送事件（窗口未就绪时安全忽略）
  function notifyRenderer(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, payload);
    }
  }
  function pushLog(tag, line) {
    const entry = `[${new Date().toLocaleTimeString()}] ${tag} ${line}`;
    logBuffer.push(entry);
    if (logBuffer.length > 500) logBuffer.shift();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('dsh:log', entry);
    }
  }
  dshHost.events.onLog = (line) => pushLog('', line);
  // dsh 进程状态变化（启动/就绪/退出）实时推送渲染层
  dshHost.events.onStateChange = (status) => notifyRenderer('dsh:state', status);
  dshHost.events.onReady = (port) => {
    pushLog('[dsh]', `dsh Web UI 已就绪（端口 ${port}）`);
    notifyRenderer('dsh:ready', { port });
  };

  function makeLogger(tag) {
    return {
      info: (...a) => pushLog(tag, a.join(' ')),
      warn: (...a) => pushLog(tag, 'WARN ' + a.join(' ')),
      error: (...a) => pushLog(tag, 'ERROR ' + a.join(' ')),
    };
  }

  // ---------------- 窗口 ----------------
  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 960,
      minHeight: 640,
      title: 'DSH Desktop',
      // 无边框窗口（去掉标题栏/菜单栏），四周圆角由 CSS + 透明背景实现
      frame: false,
      transparent: true,
      // macOS 也使用无边框
      titleBarStyle: 'hidden',
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webviewTag: true,
      },
    });

    mainWindow.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'));

    // 外链交给系统浏览器
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });

    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  }

  // ---------------- 自动更新逻辑 ----------------
  async function runAutoCheck() {
    if (checkingUpdate) return;
    const enabled = settings.get('autoCheckUpdate');
    if (!enabled) return;
    checkingUpdate = true;
    try {
      const channel = settings.get('updateChannel');
      const info = await kernelManager.checkForUpdates(channel);
      await settings.update({ lastCheckAt: Date.now() });
      if (info.hasUpdate && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:available', info);
        // 自动安装（若开启）
        if (settings.get('autoInstall')) {
          startUpdateInstall();
        }
      }
    } catch (err) {
      pushLog('[update]', `检查更新失败: ${err.message}`);
    } finally {
      checkingUpdate = false;
    }
  }

  function scheduleAutoCheck() {
    if (updateTimer) clearInterval(updateTimer);
    const minutes = Math.max(10, Number(settings.get('checkIntervalMinutes')) || 60);
    updateTimer = setInterval(() => {
      if (!checkingUpdate && !installingUpdate) runAutoCheck();
    }, minutes * 60 * 1000);
  }

  async function startUpdateInstall() {
    if (installingUpdate) return { ok: false, reason: 'installing' };
    installingUpdate = true;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:install-start');
    }
    try {
      const channel = settings.get('updateChannel');
      const info = await kernelManager.checkForUpdates(channel);
      if (!info.hasUpdate) {
        return { ok: false, reason: 'no-update' };
      }
      const remote = info.remote;
      const result = await kernelManager.installKernel(remote, {
        onProgress: (msg) => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('update:install-progress', msg);
          }
        },
      });
      await settings.update({ lastUpdateAt: Date.now() });
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:install-done', result);
      }
      // 若 dsh 正在运行，更新后自动重启以应用新内核
      if (dshHost.running) {
        pushLog('[update]', '检测到 dsh 正在运行，自动重启以应用新内核...');
        await dshHost.restart({ mode: settings.get('dshMode'), port: settings.get('dshPort') });
      }
      return { ok: true, version: result.version };
    } catch (err) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:install-error', err.message);
      }
      pushLog('[update]', `安装更新失败: ${err.message}`);
      return { ok: false, error: err.message };
    } finally {
      installingUpdate = false;
    }
  }

  // ---------------- 内置内核导入（首次启动） ----------------
  async function ensureBundledKernel() {
    try {
      const bundled = await kernelManager.getBundledKernelInfo();
      if (!bundled.bundled) {
        pushLog('[kernel]', '未发现安装包内置内核（开发模式或未预下载），可手动点击"更新内核"安装。');
        return;
      }
      const result = await kernelManager.importBundledKernel(undefined, {
        onProgress: (msg) => notifyRenderer('kernel:import-progress', msg),
      });
      if (result.imported) {
        pushLog('[kernel]', `已导入安装包内置内核 v${result.version}，可直接使用。`);
        notifyRenderer('kernel:import-done', { version: result.version });
      } else if (result.error) {
        pushLog('[kernel]', `内置内核导入失败: ${result.error}`);
        notifyRenderer('kernel:import-error', result.error);
      } else if (result.reason === 'already-installed') {
        pushLog('[kernel]', `用户目录已有内核 v${result.version}，跳过内置导入。`);
      }
    } catch (err) {
      pushLog('[kernel]', `内置内核导入异常: ${err.message}`);
    }
  }

  // ---------------- 状态快照 ----------------
  async function getStatusSnapshot() {
    const local = await kernelManager.getLocalKernelInfo();
    const env = await kernelManager.detectNodeEnvironment();
    const bundled = await kernelManager.getBundledKernelInfo();
    return {
      appVersion: app.getVersion(),
      kernel: local,
      kernelRunnable: local.installed ? await kernelManager.isKernelRunnable() : false,
      bundledKernel: { bundled: bundled.bundled, version: bundled.version },
      nodeEnv: env,
      dsh: dshHost.status,
      settings: settings.data,
    };
  }

  // ---------------- IPC ----------------
  function registerIpc() {
    ipcMain.handle('status:get', async () => {
      return await getStatusSnapshot();
    });

    ipcMain.handle('update:check', async (_e, channel) => {
      if (checkingUpdate) return { ok: false, reason: 'checking' };
      checkingUpdate = true;
      try {
        const ch = channel || settings.get('updateChannel');
        const info = await kernelManager.checkForUpdates(ch);
        await settings.update({ lastCheckAt: Date.now() });
        return { ok: true, ...info };
      } catch (err) {
        return { ok: false, error: err.message };
      } finally {
        checkingUpdate = false;
      }
    });

    ipcMain.handle('update:install', async () => {
      const result = await startUpdateInstall();
      return result;
    });

    ipcMain.handle('update:rollback', async () => {
      try {
        const result = await kernelManager.rollbackKernel();
        return { ok: true, ...result };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    ipcMain.handle('kernel:install', async () => {
      // 安装最新版内核（本地未安装时使用）
      return await startUpdateInstall();
    });

    ipcMain.handle('dsh:start', async (_e, opts) => {
      const mode = opts?.mode || settings.get('dshMode');
      const port = opts?.port || settings.get('dshPort');
      // 启动中状态实时推送给渲染层（进度提示）
      notifyRenderer('dsh:start-progress', '正在启动 dsh 服务...');
      const result = dshHost.start({ mode, port });
      return { ok: result.ok, status: dshHost.status, reason: result.reason };
    });

    ipcMain.handle('dsh:stop', async () => {
      notifyRenderer('dsh:stop-progress', '正在停止 dsh 服务...');
      await dshHost.stop();
      notifyRenderer('dsh:stop-done', {});
      return { ok: true, status: dshHost.status };
    });

    ipcMain.handle('dsh:restart', async (_e, opts) => {
      const mode = opts?.mode || settings.get('dshMode');
      const port = opts?.port || settings.get('dshPort');
      const result = await dshHost.restart({ mode, port });
      return { ok: result.ok, status: dshHost.status };
    });

    ipcMain.handle('settings:get', async () => settings.data);

    ipcMain.handle('settings:update', async (_e, patch) => {
      const updated = await settings.update(patch);
      // 间隔变化时重排自动检查
      if (patch.checkIntervalMinutes !== undefined) scheduleAutoCheck();
      // 端口变化时若 dsh 在运行，提示重启
      return updated;
    });

    ipcMain.handle('logs:get', async () => logBuffer);

    ipcMain.handle('env:openNodeDownload', async () => {
      shell.openExternal('https://nodejs.org/zh-cn/download');
      return { ok: true };
    });

    ipcMain.handle('kernel:remove', async () => {
      try {
        await kernelManager.removeKernel();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

    // ---------- 客户端自身程序更新（预留） ----------
    ipcMain.handle('app-update:check', async () => {
      return await appUpdater.checkForUpdate();
    });

    // 安装并重启（electron-updater 自动更新）
    ipcMain.handle('app-update:install', async () => {
      return appUpdater.downloadAndInstall();
    });

    // ---------- 窗口控制（无边框自绘按钮） ----------
    ipcMain.handle('window:minimize', () => {
      mainWindow?.minimize();
      return { ok: true };
    });
    ipcMain.handle('window:toggle-maximize', () => {
      if (!mainWindow) return { ok: true };
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
      return { ok: true, maximized: mainWindow.isMaximized() };
    });
    ipcMain.handle('window:close', () => {
      mainWindow?.close();
      return { ok: true };
    });
    ipcMain.handle('window:is-maximized', () => {
      return { ok: true, maximized: mainWindow ? mainWindow.isMaximized() : false };
    });
  }

  // ---------------- 生命周期 ----------------
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    await settings.load();
    dshHost.port = settings.get('dshPort');
    registerIpc();
    createWindow();

    // 提前推送"启动中"状态，避免窗口显示空白/黑屏
    setTimeout(() => notifyRenderer('dsh:start-progress', '正在初始化...'), 200);

    // 导入内置内核与自动启动 dsh 并行执行，缩短等待时间：
    // 先导入内核（若需），再自动运行 dsh；两者不互相阻塞窗口交互
    const init = (async () => {
      await ensureBundledKernel();
      // 应用启动后自动运行 dsh（若启用了 autoStartDsh 且内核可用）
      if (settings.get('autoStartDsh')) {
        const local = await kernelManager.getLocalKernelInfo();
        if (local.installed && !dshHost.running) {
          pushLog('[dsh]', '应用启动，自动运行 dsh 服务...');
          dshHost.start({ mode: settings.get('dshMode'), port: settings.get('dshPort') });
        }
      }
    })();
    // 不 await，让窗口与渲染层优先就绪，避免阻塞交互
    init.catch((err) => pushLog('[app]', '初始化异常: ' + err.message));

    // 首次启动自动检查内核更新
    scheduleAutoCheck();
    setTimeout(runAutoCheck, 2500);

    // 客户端自身程序自动更新（electron-updater）
    // 已发布到 GitHub，默认指向本仓库 mannixS/DSH-Desktop
    appUpdater.init();
    if (settings.get('appAutoCheckUpdate')) {
      setTimeout(async () => {
        await appUpdater.checkForUpdate();
      }, 5000);
    }
  });

  app.on('window-all-closed', () => {
    // macOS 惯例：窗口关闭后保留在 Dock
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  // 应用退出时同步关闭内核（含子进程树），避免 dsh 残留
  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    if (!dshHost.running) {
      if (updateTimer) clearInterval(updateTimer);
      return;
    }
    // 阻止默认退出，等待 dsh 完全停止后再退出
    event.preventDefault();
    quitting = true;
    if (updateTimer) clearInterval(updateTimer);
    pushLog('[app]', '应用退出中，正在关闭 dsh 内核...');
    dshHost.stop({ force: true }).then(() => {
      pushLog('[app]', 'dsh 内核已关闭，应用退出。');
      app.exit(0);
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
