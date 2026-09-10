'use strict';

/**
 * main.js
 * Electron 主进程入口：窗口创建、IPC 路由、内核管理与 dsh 托管编排
 */

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
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
  // 内核更新期间内核目录被锁定：禁止启动 dsh（避免文件占用导致替换失败/内核损坏）
  let kernelLocked = false;
  // 内置内核导入/对齐中的主进程侧状态：
  // 启动阶段窗口可能尚未加载完成，import 进度事件会提前发出并丢失；
  // 主进程持久跟踪导入状态，窗口 did-finish-load / 状态快照时重放，确保 UI 不错位。
  let kernelImporting = false;
  let kernelImportProgress = null;

  // 各模块数据目录
  const userData = app.getPath('userData');
  const kernelDir = path.join(userData, 'kernel');
  const dshHome = path.join(userData, 'dsh-home');

  const settings = new Settings(path.join(userData, 'settings.json'));
  const kernelManager = new KernelManager({
    kernelDir,
    logger: makeLogger('[kernel]'),
    // 下载源配置读取函数（settings 可能随时更新，保持惰性读取；
    // auto 模式由 KernelManager 内部测速探测最快源）
    registryConfig: () => ({
      mode: settings.get('npmRegistryMode') || 'auto',
      customUrl: settings.get('npmRegistryCustom') || '',
    }),
  });
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
  dshHost.events.onReady = (port, authUrl) => {
    pushLog('[dsh]', `dsh Web UI 已就绪（端口 ${port}）`);
    // authUrl：新内核为带 token 的根 URL，渲染层必须用它加载 webview
    //（否则裸地址被 browser-auth 以 401 拒绝）；旧内核为裸地址
    notifyRenderer('dsh:ready', { port, authUrl: authUrl || null });
  };
  // dsh 意外退出自动重启（时间窗口限频：60s 内最多 3 次，之后停止并提示）
  // 避免 dsh 崩溃→重启→再崩溃的无限循环（旧版 restartCount 在 onReady 重置会导致死循环）
  const RESTART_WINDOW_MS = 60000;
  const RESTART_MAX = 3;
  let restartTimestamps = [];
  let restartTimer = null;
  dshHost.events.onUnexpectedExit = ({ code, signal, reason }) => {
    pushLog('[dsh]', reason);
    notifyRenderer('dsh:unexpected-exit', { code, signal, reason });

    if (settings.get('autoStartDsh') && !quitting && !kernelLocked) {
      const now = Date.now();
      // 清理超出窗口的重启记录
      restartTimestamps = restartTimestamps.filter((t) => now - t < RESTART_WINDOW_MS);
      if (restartTimestamps.length >= RESTART_MAX) {
        pushLog('[dsh]', `60 秒内 dsh 异常退出已达 ${RESTART_MAX} 次，已停止自动重启。请查看运行日志排查。`);
        notifyRenderer('dsh:unexpected-exit', {
          code, signal,
          reason: `60 秒内 dsh 异常退出已达 ${RESTART_MAX} 次，已停止自动重启。请查看运行日志排查（端口占用/API Key 未配置/工作目录无效等）。`,
        });
        restartTimestamps = [];
        return;
      }
      restartTimestamps.push(now);
      const attempt = restartTimestamps.length;
      const delay = Math.min(3000 * attempt, 9000);
      pushLog('[dsh]', `${delay / 1000}s 后自动重启 dsh（${attempt}/${RESTART_MAX}）...`);
      clearTimeout(restartTimer);
      restartTimer = setTimeout(async () => {
        if (!dshHost.running && !quitting) {
          try {
            await dshHost.start({ mode: settings.get('dshMode'), port: settings.get('dshPort') });
          } catch (err) {
            pushLog('[dsh]', `自动重启 dsh 失败: ${err.message}`);
          }
        }
      }, delay);
    }
  };

  function makeLogger(tag) {
    return {
      info: (...a) => pushLog(tag, a.join(' ')),
      warn: (...a) => pushLog(tag, 'WARN ' + a.join(' ')),
      error: (...a) => pushLog(tag, 'ERROR ' + a.join(' ')),
    };
  }

  // ---------------- 窗口 ----------------
  const isMac = process.platform === 'darwin';
  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 960,
      minHeight: 640,
      title: 'DSH Desktop',
      // macOS：保留原生红绿灯按钮（在左侧），titleBarStyle hiddenInset 隐藏标题栏文字
      // Windows/Linux：完全无边框，自绘窗口按钮
      ...(isMac
        ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 16, y: 18 } }
        : { frame: false, transparent: true, backgroundColor: '#00000000' }),
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        // preload 仅使用 electron 内置模块，开启沙箱提升安全性
        sandbox: true,
        webviewTag: true,
      },
    });

    mainWindow.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'));

    // 窗口（重新）创建后立即把当前 dsh 状态推给渲染层：
    // macOS 关闭窗口后应用仍在后台、dsh 继续运行，重开窗口时若只靠
    // 首次启动的 dsh:ready 一次性事件，新窗口会永远卡在"内核加载中"。
    mainWindow.webContents.on('did-finish-load', () => {
      if (dshHost.running) {
        notifyRenderer('dsh:state', dshHost.status);
        if (dshHost.ready) notifyRenderer('dsh:ready', { port: dshHost.port });
      }
      // 内置内核导入/对齐中：重放最近一次进度，让新就绪的窗口恢复全屏进度提示
      // （窗口若比导入开始晚就绪，小概率事件会导致冷启动时跑到空态"内核未启动"）
      if (kernelImporting) {
        notifyRenderer(
          'kernel:import-progress',
          kernelImportProgress || { message: '正在准备导入内置内核…', percent: 0 }
        );
      }
    });

    // 外链交给系统浏览器（含 dsh webview 的 guest 页面）
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });

    // 拦截所有 webContents（含 webview 内嵌页面）的 window.open：
    // webview 的外链也交给系统浏览器，避免开出裸的 Electron 窗口。
    // 但 dsh UI 打开自身地址（127.0.0.1:端口）的新窗口/新标签时直接拒绝——
    // 否则 dsh 的"browser UI alias"会把主页在系统浏览器里再开一份。
    app.on('web-contents-created', (_event, contents) => {
      if (contents.getType() === 'webview') {
        contents.setWindowOpenHandler(({ url }) => {
          if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(url) || /^https?:\/\/127\.0\.0\.1:\d+$/i.test(url)) {
            return { action: 'deny' };
          }
          if (/^https?:\/\//i.test(url)) shell.openExternal(url);
          return { action: 'deny' };
        });
      }
    });

    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    // 内核更新中关闭窗口 = 退出应用：先确认，避免中断更新导致内核损坏。
    // 确认退出后立即中止 npm 安装并清理临时目录（下次启动用内置内核兜底修复）。
    mainWindow.on('close', (e) => {
      if (installingUpdate && !quitting) {
        const choice = dialog.showMessageBoxSync(mainWindow, {
          type: 'warning',
          buttons: ['取消退出', '仍然退出'],
          defaultId: 0,
          cancelId: 0,
          message: '内核正在更新中',
          detail:
            '此时退出可能中断内核更新并导致内核损坏。推荐先等待更新完成。\n\n确定要退出吗？' +
            '（若确实退出，下次启动时会用安装包内置内核自动修复）',
        });
        if (choice !== 1) {
          e.preventDefault();
          return;
        }
        kernelManager.abortInstall({ removeTmp: true });
        installingUpdate = false;
        kernelLocked = false;
      }
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
    kernelLocked = true; // 更新期间锁定内核目录，禁止 dsh 启动
    notifyRenderer('update:install-start', null);
    // 记录更新前 dsh 是否在运行：更新前必须停止（Windows 下文件占用会导致
    // 内核目录备份/替换失败，甚至损坏现役内核），更新成功后再恢复运行
    let wasRunning = false;
    try {
      const channel = settings.get('updateChannel');
      const info = await kernelManager.checkForUpdates(channel);
      if (!info.hasUpdate) {
        return { ok: false, reason: 'no-update' };
      }
      if (dshHost.running) {
        wasRunning = true;
        pushLog('[update]', '更新前先停止 dsh 服务，以安全替换内核目录...');
        notifyRenderer('update:install-progress', { message: '正在停止 dsh 服务以安全更新内核...', percent: 0 });
        await dshHost.stop({ force: true });
      }
      const remote = info.remote;
      const result = await kernelManager.installKernel(remote, {
        onProgress: (msg) => notifyRenderer('update:install-progress', msg),
      });
      await settings.update({ lastUpdateAt: Date.now() });
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('update:install-done', result);
      }
      // 更新前 dsh 在运行：自动重启以应用新内核
      if (wasRunning) {
        pushLog('[update]', '内核更新完成，自动重启 dsh 以应用新内核...');
        await dshHost.start({ mode: settings.get('dshMode'), port: settings.get('dshPort') });
      }
      return { ok: true, version: result.version };
    } catch (err) {
      // 用户选择退出应用中途中止安装：不再做恢复/重试，直接交给退出流程收尾
      if (!quitting) {
        // 更新失败但更新前 dsh 在运行：尝试恢复运行旧内核
        if (wasRunning && !dshHost.running) {
          pushLog('[update]', '更新失败，尝试恢复运行原内核...');
          try {
            await dshHost.start({ mode: settings.get('dshMode'), port: settings.get('dshPort') });
          } catch (startErr) {
            pushLog('[update]', '恢复 dsh 运行失败: ' + startErr.message);
          }
        }
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('update:install-error', err.message);
        }
      }
      pushLog('[update]', `安装更新失败: ${err.message}`);
      return { ok: false, error: err.message };
    } finally {
      installingUpdate = false;
      kernelLocked = false;
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
      // 导入/对齐期间内核目录会被替换，锁住 dsh 启动，避免文件占用破坏导入
      kernelLocked = true;
      // 记录主进程侧导入状态：即使渲染窗口尚未就绪（进度事件丢失），
      // 也能通过 did-finish-load 重放 / 状态快照让 UI 恢复正确的导入中提示
      kernelImporting = true;
      kernelImportProgress = null;
      try {
        const result = await kernelManager.importBundledKernel(undefined, {
          onProgress: (msg) => {
            kernelImportProgress = msg;
            notifyRenderer('kernel:import-progress', msg);
          },
        });
        if (result.imported) {
          pushLog('[kernel]', `已导入安装包内置内核 v${result.version}，可直接使用。`);
          notifyRenderer('kernel:import-done', { version: result.version });
        } else if (result.error) {
          pushLog('[kernel]', `内置内核导入失败: ${result.error}`);
          notifyRenderer('kernel:import-error', result.error);
        } else if (result.reason === 'already-installed') {
          pushLog('[kernel]', `用户目录已有内核 v${result.version}，跳过内置导入。`);
          notifyRenderer('kernel:import-done', { version: result.version, skipped: true });
        }
      } finally {
        kernelImporting = false;
        kernelImportProgress = null;
        kernelLocked = false;
      }
    } catch (err) {
      pushLog('[kernel]', `内置内核导入异常: ${err.message}`);
    }
  }

  // ---------------- 状态快照 ----------------
  // Node 环境检测需 spawn 子进程，且环境基本不变——缓存 5 分钟，
  // 避免渲染层 15s 轮询 status:get 时反复拉起 node/npm 进程
  let nodeEnvCache = { data: null, at: 0 };
  async function getNodeEnv() {
    if (nodeEnvCache.data && Date.now() - nodeEnvCache.at < 5 * 60 * 1000) {
      return nodeEnvCache.data;
    }
    const env = await kernelManager.detectNodeEnvironment();
    nodeEnvCache = { data: env, at: Date.now() };
    return env;
  }

  async function getStatusSnapshot() {
    const local = await kernelManager.getLocalKernelInfo();
    const env = await getNodeEnv();
    const bundled = await kernelManager.getBundledKernelInfo();
    return {
      appVersion: app.getVersion(),
      kernel: local,
      kernelRunnable: local.installed ? await kernelManager.isKernelRunnable() : false,
      bundledKernel: { bundled: bundled.bundled, version: bundled.version },
      // 启动阶段内置内核导入/对齐状态：渲染层靠它恢复导入进度 UI（事件丢失兜底）
      kernelImporting,
      kernelImportProgress,
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
      // 内核更新中禁止启动：文件占用会导致内核替换失败甚至损坏
      if (kernelLocked) {
        return { ok: false, reason: 'kernel-updating', status: dshHost.status };
      }
      const mode = opts?.mode || settings.get('dshMode');
      const port = opts?.port || settings.get('dshPort');
      // 启动中状态实时推送给渲染层（进度提示）
      notifyRenderer('dsh:start-progress', '正在启动 dsh 服务...');
      const result = await dshHost.start({ mode, port });
      return { ok: result.ok, status: dshHost.status, reason: result.reason };
    });

    ipcMain.handle('dsh:stop', async () => {
      notifyRenderer('dsh:stop-progress', '正在停止 dsh 服务...');
      await dshHost.stop();
      notifyRenderer('dsh:stop-done', {});
      return { ok: true, status: dshHost.status };
    });

    ipcMain.handle('dsh:restart', async (_e, opts) => {
      // 内核更新中禁止重启 dsh（设置端口保存触发的自动重启同样受限）
      if (kernelLocked) {
        return { ok: false, reason: 'kernel-updating', status: dshHost.status };
      }
      const mode = opts?.mode || settings.get('dshMode');
      const port = opts?.port || settings.get('dshPort');
      const result = await dshHost.restart({ mode, port });
      return { ok: result.ok, status: dshHost.status };
    });

    ipcMain.handle('settings:get', async () => settings.data);

    ipcMain.handle('settings:update', async (_e, patch) => {
      const prevPort = Number(settings.get('dshPort'));
      const updated = await settings.update(patch);
      // 间隔变化时重排自动检查
      if (patch.checkIntervalMinutes !== undefined) scheduleAutoCheck();
      // 端口变化且 dsh 运行中：标记需要重启，由渲染层提示并触发重启
      const dshNeedsRestart =
        patch.dshPort !== undefined &&
        Number(patch.dshPort) !== prevPort &&
        dshHost.running;
      return { ...updated, dshNeedsRestart };
    });

    ipcMain.handle('logs:get', async () => logBuffer);

    ipcMain.handle('env:openNodeDownload', async () => {
      shell.openExternal('https://nodejs.org/zh-cn/download');
      return { ok: true };
    });

    // webview / 渲染层的外链统一交给系统浏览器（仅允许 http/https）
    ipcMain.handle('shell:openExternal', (_e, url) => {
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
        shell.openExternal(url);
        return { ok: true };
      }
      return { ok: false, error: 'invalid-url' };
    });

    ipcMain.handle('kernel:remove', async () => {
      if (kernelLocked) {
        return { ok: false, reason: 'kernel-updating' };
      }
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
          try {
            await dshHost.start({ mode: settings.get('dshMode'), port: settings.get('dshPort') });
          } catch (err) {
            pushLog('[dsh]', '自动启动 dsh 失败: ' + err.message);
          }
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

  // 应用退出时彻底关闭 dsh（含进程树 + 本客户端启动的残留进程），避免端口残留
  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    // 内核更新中退出：内核目录可能处于替换的不安全状态，
    // 必须先向用户确认（退出可能损坏内核），确认后中止安装并收尾
    if (installingUpdate) {
      const choice =
        mainWindow && !mainWindow.isDestroyed()
          ? dialog.showMessageBoxSync(mainWindow, {
              type: 'warning',
              buttons: ['取消退出', '仍然退出'],
              defaultId: 0,
              cancelId: 0,
              message: '内核正在更新中',
              detail:
                '此时退出可能中断内核更新并导致内核损坏。推荐先等待更新完成。\n\n确定要退出吗？' +
                '（若确实退出，下次启动时会用安装包内置内核自动修复）',
            })
          : 1;
      if (choice !== 1) {
        event.preventDefault();
        return;
      }
      // 确认退出：立即中止 npm 安装并清理临时目录，把风险窗口缩到最小
      kernelManager.abortInstall({ removeTmp: true });
      installingUpdate = false;
      kernelLocked = false;
    }
    // 无论 dshHost.running 是否为 true，都执行清理：
    // - running=true：正常终止当前 dsh 进程树
    // - running=false：可能有上一会话残留的 dsh 进程（命令行含本客户端 kernel 路径），一并清理
    event.preventDefault();
    quitting = true;
    if (updateTimer) clearInterval(updateTimer);
    pushLog('[app]', '应用退出中，正在彻底关闭 dsh 服务...');
    const cleanup = async () => {
      // 1. 停止当前管理的 dsh 进程（含子进程树）
      if (dshHost.running) {
        await dshHost.stop({ force: true });
      }
      // 2. 清理本客户端启动但已脱离管理的残留 dsh 进程（按 kernel 路径识别，只清理自己的）
      dshHost.cleanupResidual();
      // 3. 短暂等待进程退出
      await new Promise((r) => setTimeout(r, 800));
      pushLog('[app]', 'dsh 服务已彻底关闭，应用退出。');
      app.exit(0);
    };
    cleanup();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
