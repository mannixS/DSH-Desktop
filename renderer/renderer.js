'use strict';

/**
 * renderer.js
 * 渲染进程逻辑：状态刷新、更新管理、dsh 控制、设置、日志
 */

const api = window.dshClient;

// ---------- DOM 引用 ----------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const els = {
  navItems: $$('.nav-item'),
  views: $$('.view'),
  sideStatus: $('#side-status'),
  appVersion: $('#app-version'),

  kernelBadge: $('#kernel-state-badge'),
  channelTip: $('#kernel-channel-tip'),
  bundledKernelInfo: $('#bundled-kernel-info'),
  localVersion: $('#local-version'),
  localInstallInfo: $('#local-install-info'),
  remoteVersion: $('#remote-version'),
  remotePublishInfo: $('#remote-publish-info'),
  btnCheckUpdate: $('#btn-check-update'),
  btnInstallUpdate: $('#btn-install-update'),
  btnRollback: $('#btn-rollback'),
  updateProgress: $('#update-progress'),
  updateProgressBar: $('#update-progress-bar'),
  updateProgressText: $('#update-progress-text'),
  updateToast: $('#update-toast'),

  nodeBadge: $('#node-badge'),
  nodeVersion: $('#node-version'),
  npmVersion: $('#npm-version'),
  btnOpenNodeDownload: $('#btn-open-node-download'),

  dshBadge: $('#dsh-badge'),
  dshStatusText: $('#dsh-status-text'),
  dshPortText: $('#dsh-port-text'),
  btnStartDsh: $('#btn-start-dsh'),
  btnStopDsh: $('#btn-stop-dsh'),
  btnOpenWorkspace: $('#btn-open-workspace'),

  wsStart: $('#btn-ws-start'),
  wsStop: $('#btn-ws-stop'),
  wsReload: $('#btn-ws-reload'),
  workspaceEmpty: $('#workspace-empty'),
  workspaceFrame: $('#workspace-frame'),
  dshWebview: $('#dsh-webview'),

  setAutoCheck: $('#set-auto-check'),
  setAutoInstall: $('#set-auto-install'),
  setCheckInterval: $('#set-check-interval'),
  setUpdateChannel: $('#set-update-channel'),
  setDshMode: $('#set-dsh-mode'),
  setDshPort: $('#set-dsh-port'),
  btnSaveSettings: $('#btn-save-settings'),
  settingsSaveTip: $('#settings-save-tip'),
  btnRemoveKernel: $('#btn-remove-kernel'),

  // 程序更新
  appCurrentVersion: $('#app-current-version'),
  setAppUpdateRepo: $('#set-app-update-repo'),
  setAppUpdateUrl: $('#set-app-update-url'),
  setAppAutoCheck: $('#set-app-auto-check'),
  btnCheckAppUpdate: $('#btn-check-app-update'),
  btnDownloadAppUpdate: $('#btn-download-app-update'),
  appUpdateResult: $('#app-update-result'),

  logOutput: $('#log-output'),
  btnClearLog: $('#btn-clear-log'),
  btnRefreshLog: $('#btn-refresh-log'),
};

// ---------- 状态 ----------
let currentSettings = null;
let logCache = [];

function formatDate(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '—';
  }
}

function setBadge(el, text, cls) {
  el.textContent = text;
  el.className = 'version-badge' + (cls ? ' ' + cls : '');
}

function showToast(type, text, ms = 6000) {
  els.updateToast.textContent = text;
  els.updateToast.className = 'update-toast' + (type === 'error' ? ' error' : '') ;
  els.updateToast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => els.updateToast.classList.add('hidden'), ms);
}

function setUpdateProgress(active, percent, text) {
  if (active) {
    els.updateProgress.classList.remove('hidden');
    if (percent >= 0) els.updateProgressBar.style.width = percent + '%';
    if (text) els.updateProgressText.textContent = text;
  } else {
    els.updateProgress.classList.add('hidden');
    els.updateProgressBar.style.width = '0%';
  }
}

// ---------- 刷新总览状态 ----------
async function refreshStatus() {
  try {
    const s = await api.getStatus();

    els.appVersion.textContent = s.appVersion;
    els.appCurrentVersion.textContent = s.appVersion;
    currentSettings = s.settings;
    applySettingsToForm();

    // 侧栏状态
    const dot = els.sideStatus.querySelector('.dot');
    if (s.kernel.installed) {
      if (s.dsh.running) {
        dot.className = 'dot dot-green';
        els.sideStatus.innerHTML = '<span class="dot dot-green"></span><span>dsh 运行中</span>';
      } else {
        els.sideStatus.innerHTML = '<span class="dot dot-yellow"></span><span>内核 v' + s.kernel.version + '</span>';
      }
    } else {
      els.sideStatus.innerHTML = '<span class="dot dot-red"></span><span>内核未安装</span>';
    }

    // ---- 内核卡片 ----
    const channel = (s.settings && s.settings.updateChannel) || 'latest';
    els.channelTip.textContent = '更新通道：' + channel + (channel === 'stable' ? '（仅正式版）' : '（含 RC）');
    if (s.bundledKernel && s.bundledKernel.bundled) {
      els.bundledKernelInfo.textContent = '安装包内置内核 v' + (s.bundledKernel.version || '?') + '（首次启动自动导入）';
    } else {
      els.bundledKernelInfo.textContent = '';
    }

    if (s.kernel.installed) {
      els.localVersion.textContent = s.kernel.version;
      els.localInstallInfo.textContent = s.kernelRunnable ? '内核可运行' : '⚠ 内核文件不完整，建议重新安装';
      setBadge(els.kernelBadge, '已安装', s.kernelRunnable ? 'ok' : 'warn');
    } else {
      els.localVersion.textContent = '—';
      els.localInstallInfo.textContent = '尚未安装内核';
      setBadge(els.kernelBadge, '未安装', 'err');
    }

    // ---- Node 环境 ----
    if (s.nodeEnv.nodeAvailable) {
      els.nodeVersion.textContent = s.nodeEnv.nodeVersion;
      els.npmVersion.textContent = s.nodeEnv.npmAvailable ? s.nodeEnv.npmVersion : '不可用';
      if (s.nodeEnv.meetsRequirement) {
        setBadge(els.nodeBadge, '满足要求', 'ok');
      } else {
        setBadge(els.nodeBadge, '版本过低', 'warn');
        els.btnOpenNodeDownload.hidden = false;
      }
    } else {
      els.nodeVersion.textContent = '未检测到';
      els.npmVersion.textContent = '不可用';
      setBadge(els.nodeBadge, '未安装', 'err');
      els.btnOpenNodeDownload.hidden = false;
    }

    // ---- dsh 进程 ----
    if (s.dsh.running) {
      setBadge(els.dshBadge, '运行中', 'ok');
      els.dshStatusText.textContent = '运行中 (PID ' + s.dsh.pid + ')';
      els.btnStartDsh.disabled = true;
      els.btnStopDsh.disabled = false;
      els.btnWsStop.disabled = false;
      els.wsStart.disabled = true;
      showWorkspace(true);
    } else {
      setBadge(els.dshBadge, '未运行', '');
      els.dshStatusText.textContent = '未运行';
      els.btnStartDsh.disabled = false;
      els.btnStopDsh.disabled = true;
      els.btnWsStop.disabled = true;
      els.wsStart.disabled = false;
      showWorkspace(false);
    }
    els.dshPortText.textContent = (s.settings && s.settings.dshPort) || 3080;

    // ---- 更新按钮状态 ----
    els.btnInstallUpdate.disabled = !s.kernel.installed;
    els.btnRollback.disabled = true; // 有可用备份时主进程会告知，此处由 update 事件刷新
  } catch (err) {
    els.sideStatus.innerHTML = '<span class="dot dot-red"></span><span>状态获取失败</span>';
  }
}

function applySettingsToForm() {
  if (!currentSettings) return;
  els.setAutoCheck.checked = !!currentSettings.autoCheckUpdate;
  els.setAutoInstall.checked = !!currentSettings.autoInstall;
  els.setCheckInterval.value = currentSettings.checkIntervalMinutes || 60;
  els.setUpdateChannel.value = currentSettings.updateChannel || 'latest';
  els.setDshMode.value = currentSettings.dshMode || 'web';
  els.setDshPort.value = currentSettings.dshPort || 3080;
  els.setAppUpdateRepo.value = currentSettings.appUpdateRepo || '';
  els.setAppUpdateUrl.value = currentSettings.appUpdateUrl || '';
  els.setAppAutoCheck.checked = !!currentSettings.appAutoCheckUpdate;
}

// ---------- 检查更新 ----------
async function handleCheckUpdate() {
  els.btnCheckUpdate.disabled = true;
  els.btnCheckUpdate.textContent = '检查中…';
  try {
    const channel = (currentSettings && currentSettings.updateChannel) || 'latest';
    const res = await api.checkUpdate(channel);
    if (!res.ok) {
      showToast('error', '检查更新失败：' + (res.error || '未知错误'));
      return;
    }
    if (res.hasUpdate) {
      els.remoteVersion.textContent = res.remote;
      els.remotePublishInfo.textContent = '发布于 ' + formatDate(res.publishedAt);
      setBadge(els.kernelBadge, '有新版本', 'warn');
      els.btnInstallUpdate.disabled = false;
      showToast('info', '发现新版本 ' + res.remote + '，可点击"更新内核"。');
    } else {
      els.remoteVersion.textContent = res.remote || '—';
      els.remotePublishInfo.textContent = res.remote ? '发布于 ' + formatDate(res.publishedAt) : '';
      showToast('info', res.local ? '已是最新版本（' + res.local + '）。' : '未安装内核，点击"更新内核"安装最新版。');
    }
  } catch (err) {
    showToast('error', '检查更新失败：' + err.message);
  } finally {
    els.btnCheckUpdate.disabled = false;
    els.btnCheckUpdate.textContent = '检查更新';
  }
}

// ---------- 安装更新 ----------
async function handleInstallUpdate() {
  els.btnInstallUpdate.disabled = true;
  setUpdateProgress(true, 5, '正在准备更新…');
  try {
    const res = await api.installUpdate();
    if (!res.ok) {
      setUpdateProgress(false);
      showToast('error', '更新失败：' + (res.error || res.reason || '未知错误'));
    } else {
      setUpdateProgress(true, 100, '更新完成：v' + res.version);
      setTimeout(() => setUpdateProgress(false), 2000);
      showToast('info', '内核已更新至 v' + res.version);
    }
  } catch (err) {
    setUpdateProgress(false);
    showToast('error', '更新失败：' + err.message);
  } finally {
    refreshStatus();
  }
}

// ---------- 回滚 ----------
async function handleRollback() {
  if (!confirm('确定回滚到上一版本内核吗？')) return;
  els.btnRollback.disabled = true;
  try {
    const res = await api.rollbackKernel();
    if (res.ok) {
      showToast('info', '已回滚至 v' + res.version);
    } else {
      showToast('error', '回滚失败：' + (res.error || ''));
    }
  } catch (err) {
    showToast('error', '回滚失败：' + err.message);
  } finally {
    refreshStatus();
  }
}

// ---------- dsh 控制 ----------
async function handleStartDsh() {
  els.btnStartDsh.disabled = true;
  try {
    await api.startDsh({ mode: (currentSettings && currentSettings.dshMode) || 'web', port: (currentSettings && currentSettings.dshPort) || 3080 });
    await refreshStatus();
    if (els.dshWebview) {
      setTimeout(() => {
        els.dshWebview.src = 'http://127.0.0.1:' + ((currentSettings && currentSettings.dshPort) || 3080);
      }, 800);
    }
  } catch (err) {
    showToast('error', '启动 dsh 失败：' + err.message);
    els.btnStartDsh.disabled = false;
  }
}

async function handleStopDsh() {
  try {
    await api.stopDsh();
    await refreshStatus();
  } catch (err) {
    showToast('error', '停止 dsh 失败：' + err.message);
  }
}

function showWorkspace(active) {
  els.workspaceEmpty.classList.toggle('hidden', active);
  els.workspaceFrame.classList.toggle('hidden', !active);
  if (active && els.dshWebview) {
    els.dshWebview.src = 'http://127.0.0.1:' + ((currentSettings && currentSettings.dshPort) || 3080);
  }
}

// ---------- 设置 ----------
async function handleSaveSettings() {
  const patch = {
    autoCheckUpdate: els.setAutoCheck.checked,
    autoInstall: els.setAutoInstall.checked,
    checkIntervalMinutes: Math.max(10, parseInt(els.setCheckInterval.value, 10) || 60),
    updateChannel: els.setUpdateChannel.value,
    dshMode: els.setDshMode.value,
    dshPort: parseInt(els.setDshPort.value, 10) || 3080,
    appUpdateRepo: els.setAppUpdateRepo.value.trim(),
    appUpdateUrl: els.setAppUpdateUrl.value.trim(),
    appAutoCheckUpdate: els.setAppAutoCheck.checked,
  };
  try {
    await api.updateSettings(patch);
    currentSettings = { ...currentSettings, ...patch };
    els.settingsSaveTip.textContent = '✓ 已保存 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
    setTimeout(() => (els.settingsSaveTip.textContent = ''), 3000);
    refreshStatus();
  } catch (err) {
    showToast('error', '保存设置失败：' + err.message);
  }
}

async function handleRemoveKernel() {
  if (!confirm('确定移除本地内核吗？此操作将删除内核文件与备份。')) return;
  if (!confirm('再次确认：移除后将无法启动 dsh，需重新安装内核。')) return;
  try {
    await api.removeKernel();
    showToast('info', '内核已移除');
    refreshStatus();
  } catch (err) {
    showToast('error', '移除内核失败：' + err.message);
  }
}

// ---------- 程序更新（客户端自身） ----------
let lastAppUpdateInfo = null;

function setAppUpdateResult(type, text) {
  els.appUpdateResult.className = 'app-update-result' + (type ? ' ' + type : '');
  els.appUpdateResult.textContent = text;
}

async function handleCheckAppUpdate() {
  els.btnCheckAppUpdate.disabled = true;
  els.btnCheckAppUpdate.textContent = '检查中…';
  try {
    const info = await api.checkAppUpdate();
    lastAppUpdateInfo = info;

    if (!info.configured) {
      setAppUpdateResult('', '未配置程序更新源。请在下方填写 GitHub 仓库（owner/repo）或自定义更新源 URL 并保存设置。');
      els.btnDownloadAppUpdate.disabled = true;
      return;
    }
    if (info.error) {
      setAppUpdateResult('err', '检查失败：' + info.error);
      els.btnDownloadAppUpdate.disabled = true;
      return;
    }
    if (info.hasUpdate) {
      setAppUpdateResult('ok',
        '发现新版本：v' + info.latest + '（当前 v' + info.current + '）' +
        (info.publishedAt ? '\n发布于 ' + formatDate(info.publishedAt) : '') +
        (info.notes ? '\n\n更新说明：\n' + info.notes.slice(0, 800) : '') +
        (info.downloadUrl ? '\n\n可点击"下载新版本"获取安装包。' : '\n\n未找到匹配当前平台的安装包，请前往 Release 页面手动下载。')
      );
      els.btnDownloadAppUpdate.disabled = !info.downloadUrl;
    } else {
      setAppUpdateResult('', '当前已是最新版本（v' + info.current + '）。');
      els.btnDownloadAppUpdate.disabled = true;
    }
  } catch (err) {
    setAppUpdateResult('err', '检查程序更新失败：' + err.message);
    els.btnDownloadAppUpdate.disabled = true;
  } finally {
    els.btnCheckAppUpdate.disabled = false;
    els.btnCheckAppUpdate.textContent = '检查程序更新';
  }
}

async function handleDownloadAppUpdate() {
  if (!lastAppUpdateInfo || !lastAppUpdateInfo.downloadUrl) return;
  els.btnDownloadAppUpdate.disabled = true;
  els.btnDownloadAppUpdate.textContent = '下载中…';
  try {
    const res = await api.downloadAppUpdate(lastAppUpdateInfo.downloadUrl, lastAppUpdateInfo.assetName);
    if (res.ok) {
      setAppUpdateResult('ok',
        '安装包已下载到：\n' + res.filePath +
        '\n\n请关闭本客户端后运行安装包完成升级。');
    } else {
      setAppUpdateResult('err', '下载失败：' + (res.error || '未知错误'));
    }
  } catch (err) {
    setAppUpdateResult('err', '下载失败：' + err.message);
  } finally {
    els.btnDownloadAppUpdate.disabled = false;
    els.btnDownloadAppUpdate.textContent = '下载新版本';
  }
}

// ---------- 日志 ----------
function appendLog(line) {
  logCache.push(line);
  if (logCache.length > 500) logCache.shift();
  if (els.logOutput.textContent === '（暂无日志）') els.logOutput.textContent = '';
  els.logOutput.textContent += line + '\n';
  els.logOutput.scrollTop = els.logOutput.scrollHeight;
}

async function refreshLogs() {
  try {
    const logs = await api.getLogs();
    els.logOutput.textContent = logs.length ? logs.join('\n') : '（暂无日志）';
    els.logOutput.scrollTop = els.logOutput.scrollHeight;
  } catch {
    /* 忽略 */
  }
}

// ---------- 视图切换 ----------
function switchView(name) {
  els.navItems.forEach((n) => n.classList.toggle('active', n.dataset.view === name));
  els.views.forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  if (name === 'logs') refreshLogs();
  if (name === 'workspace' && els.dshWebview) {
    // 确保 webview 显示正确页面
    const port = (currentSettings && currentSettings.dshPort) || 3080;
    if (els.workspaceFrame.classList.contains('hidden') === false) {
      els.dshWebview.src = 'http://127.0.0.1:' + port;
    }
  }
}

// ---------- 事件绑定 ----------
function bindEvents() {
  els.navItems.forEach((n) => n.addEventListener('click', () => switchView(n.dataset.view)));

  els.btnCheckUpdate.addEventListener('click', handleCheckUpdate);
  els.btnInstallUpdate.addEventListener('click', handleInstallUpdate);
  els.btnRollback.addEventListener('click', handleRollback);

  els.btnStartDsh.addEventListener('click', handleStartDsh);
  els.btnStopDsh.addEventListener('click', handleStopDsh);
  els.btnOpenWorkspace.addEventListener('click', () => switchView('workspace'));
  els.wsStart.addEventListener('click', handleStartDsh);
  els.wsStop.addEventListener('click', handleStopDsh);
  els.wsReload.addEventListener('click', () => {
    if (els.dshWebview) {
      els.dshWebview.src = 'about:blank';
      setTimeout(() => {
        els.dshWebview.src = 'http://127.0.0.1:' + ((currentSettings && currentSettings.dshPort) || 3080);
      }, 200);
    }
  });

  els.btnOpenNodeDownload.addEventListener('click', () => api.openNodeDownload());
  els.btnSaveSettings.addEventListener('click', handleSaveSettings);
  els.btnRemoveKernel.addEventListener('click', handleRemoveKernel);

  els.btnCheckAppUpdate.addEventListener('click', handleCheckAppUpdate);
  els.btnDownloadAppUpdate.addEventListener('click', handleDownloadAppUpdate);

  els.btnClearLog.addEventListener('click', () => {
    logCache = [];
    els.logOutput.textContent = '（暂无日志）';
  });
  els.btnRefreshLog.addEventListener('click', refreshLogs);

  // 主进程推送事件
  api.onUpdateAvailable((info) => {
    els.remoteVersion.textContent = info.remote;
    els.remotePublishInfo.textContent = '发布于 ' + formatDate(info.publishedAt);
    if (info.hasUpdate) {
      els.btnInstallUpdate.disabled = false;
      showToast('info', '发现新版本 ' + info.remote + '，点击"更新内核"即可升级。');
    }
  });
  api.onUpdateInstallStart(() => {
    setUpdateProgress(true, 5, '开始安装内核…');
  });
  api.onUpdateInstallProgress((msg) => {
    setUpdateProgress(true, -1, msg);
  });
  api.onUpdateInstallDone((result) => {
    setUpdateProgress(true, 100, '更新完成：v' + (result.version || ''));
    setTimeout(() => setUpdateProgress(false), 2500);
    showToast('info', '内核已更新至 v' + (result.version || ''));
    refreshStatus();
  });
  api.onUpdateInstallError((msg) => {
    setUpdateProgress(false);
    showToast('error', '更新失败：' + msg);
    refreshStatus();
  });
  api.onDshLog((line) => appendLog(line));

  // 启动时自动检查发现客户端新版本
  api.onAppUpdateAvailable((info) => {
    lastAppUpdateInfo = info;
    setAppUpdateResult('ok',
      '发现客户端新版本：v' + info.latest + '（当前 v' + info.current + '）。' +
      '可前往"设置 → 程序更新"查看并下载。');
  });
}

// ---------- 启动 ----------
bindEvents();
refreshStatus();
setInterval(refreshStatus, 15000); // 每 15 秒同步一次状态
