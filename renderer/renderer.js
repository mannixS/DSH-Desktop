'use strict';

/**
 * renderer.js
 * 渲染进程逻辑：全屏工作台 + 底部状态栏 + 设置弹层。
 * 核心：由 dsh 真实状态（运行/启动中/停止）驱动 UI。
 */

const api = window.dshClient;
const $ = (s) => document.querySelector(s);

const els = {
  stageEmpty: $('#stage-empty'), stageLoading: $('#stage-loading'),
  stageFailed: $('#stage-failed'), stageFailedText: $('#stage-failed-text'),
  stageFrame: $('#stage-frame'), dshWebview: $('#dsh-webview'),
  loadingText: $('#stage-loading-text'), btnStageRetry: $('#btn-stage-retry'),
  statusDot: $('#status-dot'), statusText: $('#status-text'), statusExtra: $('#status-extra'),
  statusVersion: $('#status-version'),   btnStart: $('#btn-start-dsh'), btnStop: $('#btn-stop-dsh'),
  btnOpenSettings: $('#btn-open-settings'),
  // 窗口控制
  winMin: $('#win-min'), winMax: $('#win-max'), winMaxIcon: $('#win-max-icon'), winClose: $('#win-close'),
  titlebar: $('#titlebar'),
  settingsModal: $('#settings-modal'), settingsBackdrop: $('#settings-backdrop'),
  btnCloseSettings: $('#btn-close-settings'), btnSaveSettings: $('#btn-save-settings'),
  settingsSaveTip: $('#settings-save-tip'), kernelVersionInfo: $('#kernel-version-info'),
  btnCheckUpdate: $('#btn-check-update'), btnInstallUpdate: $('#btn-install-update'), updateToast: $('#update-toast'),
  setAutoCheck: $('#set-auto-check'), setAutoInstall: $('#set-auto-install'),
  setCheckInterval: $('#set-check-interval'), setUpdateChannel: $('#set-update-channel'),
  setAutoStartDsh: $('#set-auto-start-dsh'), setDshPort: $('#set-dsh-port'),
  nodeVersion: $('#node-version'), npmVersion: $('#npm-version'), btnOpenNodeDownload: $('#btn-open-node-download'),
  setAppUpdateRepo: $('#set-app-update-repo'), setAppUpdateUrl: $('#set-app-update-url'),
  setAppAutoCheck: $('#set-app-auto-check'), btnCheckAppUpdate: $('#btn-check-app-update'),
  btnDownloadAppUpdate: $('#btn-download-app-update'), appUpdateResult: $('#app-update-result'),
  btnRemoveKernel: $('#btn-remove-kernel'),
};

let currentSettings = null;
let lastAppUpdateInfo = null;
let wsReady = false;
let lastDshPort = 3080;

function setDot(c) { els.statusDot.className = 'dot ' + c; }
function setStatus(t, c) { els.statusText.textContent = t; if (c) setDot(c); }
function showStage(s) {
  els.stageEmpty.classList.toggle('hidden', s !== 'empty');
  els.stageLoading.classList.toggle('hidden', s !== 'loading');
  els.stageFailed.classList.toggle('hidden', s !== 'failed');
  els.stageFrame.classList.toggle('hidden', s !== 'frame');
}
function setStageLoading(t) { els.loadingText.textContent = t || '正在启动 dsh…'; }

function loadWsUrl() {
  if (!els.dshWebview) return;
  wsReady = false;
  els.dshWebview.src = 'http://127.0.0.1:' + lastDshPort;
}

function applyDshState(dsh) {
  const running = !!(dsh && dsh.running);
  els.btnStart.disabled = running;
  els.btnStop.disabled = !running;
  if (running) {
    lastDshPort = dsh.port || lastDshPort;
    setStatus('dsh 运行中', 'green');
    els.statusExtra.textContent = 'PID ' + (dsh.pid || '') + ' · 端口 ' + lastDshPort;
    if (!wsReady) { showStage('loading'); setStageLoading('正在加载工作台…'); loadWsUrl(); }
  } else {
    setStatus('dsh 已停止', 'gray');
    els.statusExtra.textContent = '';
    wsReady = false;
    showStage('empty');
  }
}

async function refreshStatus() {
  try {
    const s = await api.getStatus();
    currentSettings = s.settings;
    lastDshPort = (s.settings && s.settings.dshPort) || 3080;
    applySettingsToForm();
    els.statusVersion.textContent = 'v' + s.appVersion;
    els.kernelVersionInfo.textContent = s.kernel.installed ? '已安装 v' + s.kernel.version : '未安装';
    els.nodeVersion.textContent = s.nodeEnv.nodeAvailable ? s.nodeEnv.nodeVersion : '未检测到';
    els.npmVersion.textContent = s.nodeEnv.npmAvailable ? s.nodeEnv.npmVersion : '不可用';
    els.btnOpenNodeDownload.hidden = !(s.nodeEnv && !s.nodeEnv.meetsRequirement);
    els.btnInstallUpdate.disabled = !s.kernel.installed;
    applyDshState(s.dsh);
  } catch {
    setStatus('状态获取失败', 'red');
  }
}

function applySettingsToForm() {
  if (!currentSettings) return;
  els.setAutoCheck.checked = !!currentSettings.autoCheckUpdate;
  els.setAutoInstall.checked = !!currentSettings.autoInstall;
  els.setCheckInterval.value = currentSettings.checkIntervalMinutes || 60;
  els.setUpdateChannel.value = currentSettings.updateChannel || 'latest';
  els.setAutoStartDsh.checked = !!currentSettings.autoStartDsh;
  els.setDshPort.value = currentSettings.dshPort || 3080;
  els.setAppUpdateRepo.value = currentSettings.appUpdateRepo || '';
  els.setAppUpdateUrl.value = currentSettings.appUpdateUrl || '';
  els.setAppAutoCheck.checked = !!currentSettings.appAutoCheckUpdate;
}

async function handleStart() {
  els.btnStart.disabled = true;
  showStage('loading'); setStageLoading('正在启动 dsh 服务…');
  try {
    const res = await api.startDsh({ mode: 'web', port: lastDshPort });
    if (res && res.ok === false && res.reason === 'kernel-not-installed') {
      showStage('failed'); els.stageFailedText.textContent = '内核未安装，请到设置中安装内核。';
    }
  } catch (err) {
    showStage('failed'); els.stageFailedText.textContent = err.message;
  }
}

async function handleStop() {
  els.btnStop.disabled = true;
  showStage('loading'); setStageLoading('正在停止 dsh 服务…');
  try { await api.stopDsh(); } catch (err) { setStatus('停止失败：' + err.message, 'red'); }
}

function openSettings() { els.settingsModal.classList.remove('hidden'); refreshStatus(); }
function closeSettings() { els.settingsModal.classList.add('hidden'); }

function showToast(t, text, ms) {
  els.updateToast.textContent = text;
  els.updateToast.style.color = t === 'error' ? 'var(--danger)' : (t === 'ok' ? 'var(--accent)' : 'var(--text-muted)');
  els.updateToast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => els.updateToast.classList.add('hidden'), ms || 6000);
}

async function handleCheckUpdate() {
  els.btnCheckUpdate.disabled = true; els.btnCheckUpdate.textContent = '检查中…';
  try {
    const ch = (currentSettings && currentSettings.updateChannel) || 'latest';
    const res = await api.checkUpdate(ch);
    if (!res.ok) showToast('error', '检查失败：' + (res.error || ''));
    else if (res.hasUpdate) { showToast('info', '发现新版本 ' + res.remote); els.btnInstallUpdate.disabled = false; }
    else showToast('info', res.local ? '已是最新版本（' + res.local + '）。' : '未安装内核。');
  } catch (err) { showToast('error', '检查更新失败：' + err.message); }
  finally { els.btnCheckUpdate.disabled = false; els.btnCheckUpdate.textContent = '检查更新'; }
}

async function handleInstallUpdate() {
  els.btnInstallUpdate.disabled = true; showToast('info', '正在安装内核更新…');
  try {
    const res = await api.installUpdate();
    if (res && res.ok) showToast('ok', '内核已更新至 v' + res.version);
    else showToast('error', '更新失败：' + ((res && (res.error || res.reason)) || '未知'));
  } catch (err) { showToast('error', '更新失败：' + err.message); }
  finally { els.btnInstallUpdate.disabled = false; refreshStatus(); }
}

function setAppUpdateResult(t, text) {
  els.appUpdateResult.className = 'app-update-result' + (t ? ' ' + t : '');
  els.appUpdateResult.textContent = text;
}

async function handleCheckAppUpdate() {
  els.btnCheckAppUpdate.disabled = true; els.btnCheckAppUpdate.textContent = '检查中…';
  try {
    const info = await api.checkAppUpdate();
    lastAppUpdateInfo = info;
    if (!info.configured) setAppUpdateResult('', '未配置更新源，请填写 GitHub 仓库并保存。');
    else if (info.error) setAppUpdateResult('err', '检查失败：' + info.error);
    else setAppUpdateResult('', '正在检查更新…');
  } catch (err) { setAppUpdateResult('err', '检查失败：' + err.message); }
  finally { els.btnCheckAppUpdate.disabled = false; els.btnCheckAppUpdate.textContent = '检查程序更新'; }
}

// 安装并重启（新版本已下载完成后）
async function handleInstallAppUpdate() {
  try {
    const res = await api.installAppUpdate();
    if (res && res.ok === false) setAppUpdateResult('err', '安装失败：' + (res.error || ''));
  } catch (err) { setAppUpdateResult('err', '安装失败：' + err.message); }
}

async function handleSaveSettings() {
  const patch = {
    autoCheckUpdate: els.setAutoCheck.checked, autoInstall: els.setAutoInstall.checked,
    checkIntervalMinutes: Math.max(10, parseInt(els.setCheckInterval.value, 10) || 60),
    updateChannel: els.setUpdateChannel.value, autoStartDsh: els.setAutoStartDsh.checked,
    dshPort: parseInt(els.setDshPort.value, 10) || 3080,
    appUpdateRepo: els.setAppUpdateRepo.value.trim(), appUpdateUrl: els.setAppUpdateUrl.value.trim(),
    appAutoCheckUpdate: els.setAppAutoCheck.checked,
  };
  try {
    await api.updateSettings(patch);
    currentSettings = { ...currentSettings, ...patch };
    lastDshPort = patch.dshPort;
    els.settingsSaveTip.textContent = '已保存';
    setTimeout(() => (els.settingsSaveTip.textContent = ''), 2000);
  } catch (err) { showToast('error', '保存设置失败：' + err.message); }
}

async function handleRemoveKernel() {
  if (!confirm('确定移除本地内核吗？')) return;
  if (!confirm('再次确认：移除后将无法启动 dsh。')) return;
  try { await api.removeKernel(); showToast('info', '内核已移除'); refreshStatus(); }
  catch (err) { showToast('error', '移除内核失败：' + err.message); }
}

// ---------- 主题色动态匹配 dsh 页面 ----------
function applyThemeColor(color) {
  if (!color) return;
  // 设置主题色相关的 CSS 变量（标题栏、按钮、状态点等随 dsh 页面主色调）
  document.documentElement.style.setProperty('--theme-color', color);
  document.documentElement.style.setProperty('--primary', color);
}
// 从 webview 中提取 dsh 页面的主色调（读取其 CSS 变量/主题色）
function extractThemeFromWebview() {
  if (!els.dshWebview || !els.dshWebview.getWebContents) return;
  try {
    els.dshWebview.executeJavaScript(`
      (() => {
        const css = getComputedStyle(document.documentElement);
        // 常见主题色来源：primary/accent/品牌色
        const candidates = ['--primary','--accent','--brand','--color-primary','--main-color'];
        for (const c of candidates) {
          const v = css.getPropertyValue(c);
          if (v && v.trim() && v.trim() !== 'transparent') return v.trim();
        }
        return null;
      })()
    `).then((color) => {
      if (color) applyThemeColor(color);
    }).catch(() => {});
  } catch {}
}

// ---------- 事件绑定 ----------
function bindEvents() {
  // 窗口控制
  els.winMin.addEventListener('click', () => api.windowMinimize());
  els.winMax.addEventListener('click', async () => {
    const r = await api.windowToggleMaximize();
    updateMaxIcon(r && r.maximized);
  });
  els.winClose.addEventListener('click', () => api.windowClose());
  async function updateMaxIcon(maximized) {
    if (!els.winMaxIcon) return;
    els.winMaxIcon.innerHTML = maximized
      ? '<path d="M2.5 0.5h7v7h-7z" fill="none" stroke="currentColor"/><path d="M0.5 2.5h7v7h-7z" fill="none" stroke="currentColor"/>'
      : '<path d="M0.5 0.5h9v9h-9z" fill="none" stroke="currentColor"/>';
  }
  // 同步最大化状态
  api.windowIsMaximized().then((r) => updateMaxIcon(r && r.maximized));

  els.btnStart.addEventListener('click', handleStart);
  els.btnStop.addEventListener('click', handleStop);
  els.btnOpenSettings.addEventListener('click', openSettings);
  els.btnCloseSettings.addEventListener('click', closeSettings);
  els.settingsBackdrop.addEventListener('click', closeSettings);
  els.btnStageRetry.addEventListener('click', handleStart);
  els.btnCheckUpdate.addEventListener('click', handleCheckUpdate);
  els.btnInstallUpdate.addEventListener('click', handleInstallUpdate);
  els.btnSaveSettings.addEventListener('click', handleSaveSettings);
  els.btnRemoveKernel.addEventListener('click', handleRemoveKernel);
  els.btnOpenNodeDownload.addEventListener('click', () => api.openNodeDownload());
  els.btnCheckAppUpdate.addEventListener('click', handleCheckAppUpdate);
  els.btnDownloadAppUpdate.addEventListener('click', handleInstallAppUpdate);

  if (els.dshWebview) {
    els.dshWebview.addEventListener('did-start-loading', () => { showStage('loading'); setStageLoading('正在加载工作台…'); });
    els.dshWebview.addEventListener('did-stop-loading', () => {
      wsReady = true; showStage('frame'); setStatus('dsh 运行中', 'green');
      // 页面加载完成后提取 dsh 主题色
      setTimeout(extractThemeFromWebview, 1500);
    });
    els.dshWebview.addEventListener('did-fail-load', (e) => {
      if (e.errorCode === -3) return;
      wsReady = false; showStage('failed');
      els.stageFailedText.textContent = '无法连接 dsh（端口 ' + lastDshPort + '），请确认服务已启动。';
    });
  }

  api.onDshState((st) => {
    if (st && st.running) {
      els.btnStart.disabled = true; els.btnStop.disabled = false;
      lastDshPort = st.port || lastDshPort;
      setStatus('dsh 运行中', 'green');
      els.statusExtra.textContent = 'PID ' + (st.pid || '') + ' · 端口 ' + lastDshPort;
      showStage('loading'); setStageLoading('正在加载工作台…'); loadWsUrl();
    } else { applyDshState(st); }
  });
  api.onDshReady((info) => { setStatus('dsh 运行中', 'green'); els.statusExtra.textContent = '端口 ' + (info && info.port); loadWsUrl(); });
  api.onDshStartProgress((m) => { showStage('loading'); setStageLoading(m); });
  api.onDshStopProgress((m) => { showStage('loading'); setStageLoading(m); });
  api.onDshStopDone(() => refreshStatus());

  api.onUpdateAvailable((info) => { if (info.hasUpdate) { els.btnInstallUpdate.disabled = false; showToast('info', '发现新版本 ' + info.remote + '，可到设置中更新。'); } });
  api.onUpdateInstallProgress((m) => showToast('info', m, 3000));
  api.onUpdateInstallDone((r) => { showToast('ok', '内核已更新至 v' + (r.version || '')); refreshStatus(); });
  api.onUpdateInstallError((m) => showToast('error', '更新失败：' + m));

  api.onKernelImportProgress((m) => { showStage('loading'); setStageLoading(m); });
  api.onKernelImportDone((info) => { setStatus('内核就绪，点击启动', 'yellow'); showToast('ok', '内置内核 v' + (info.version || '?') + ' 导入完成'); refreshStatus(); });
  api.onKernelImportError((m) => showToast('error', '内置内核导入失败：' + m));

  // 程序自动更新事件（electron-updater）
  api.onAppUpdateEvent((event, payload) => {
    if (event === 'checking') setAppUpdateResult('', '正在检查程序更新…');
    else if (event === 'available') { setAppUpdateResult('ok', '发现新版本 v' + (payload && payload.version) + '，正在自动下载…'); els.btnDownloadAppUpdate.disabled = true; }
    else if (event === 'not-available') setAppUpdateResult('', '当前已是最新版本。');
    else if (event === 'progress') setAppUpdateResult('', '正在下载更新：' + (payload && payload.percent) + '%');
    else if (event === 'downloaded') { setAppUpdateResult('ok', '新版本已下载完成，点击「安装并重启」完成升级。'); els.btnDownloadAppUpdate.disabled = false; }
    else if (event === 'error') { setAppUpdateResult('err', '更新失败：' + (payload && payload.message)); els.btnDownloadAppUpdate.disabled = true; }
  });
}

bindEvents();
refreshStatus();
setInterval(refreshStatus, 15000);
