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
  stageImportBar: $('#stage-import-bar'), stageImportBarFill: $('#stage-import-bar-fill'),
  statusDot: $('#status-dot'), statusText: $('#status-text'), statusExtra: $('#status-extra'),
  statusVersion: $('#status-version'),   btnStart: $('#btn-start-dsh'), btnStop: $('#btn-stop-dsh'),
  btnOpenSettings: $('#btn-open-settings'),
  // 窗口控制
  winMin: $('#win-min'), winMax: $('#win-max'), winMaxIcon: $('#win-max-icon'), winClose: $('#win-close'),
  titlebar: $('#titlebar'), titlebarControls: $('#titlebar-controls'),
  settingsModal: $('#settings-modal'), settingsBackdrop: $('#settings-backdrop'),
  btnCloseSettings: $('#btn-close-settings'), btnSaveSettings: $('#btn-save-settings'),
  settingsSaveTip: $('#settings-save-tip'), kernelVersionInfo: $('#kernel-version-info'),
  kernelUpdateBox: $('#kernel-update-box'), kernelUpdateBar: $('#kernel-update-bar'), kernelUpdateText: $('#kernel-update-text'),
  setNpmRegistryMode: $('#set-npm-registry-mode'), setNpmRegistryCustom: $('#set-npm-registry-custom'), rowNpmRegistryCustom: $('#row-npm-registry-custom'),
  btnCheckUpdate: $('#btn-check-update'), btnInstallUpdate: $('#btn-install-update'), updateToast: $('#update-toast'),
  setAutoCheck: $('#set-auto-check'), setAutoInstall: $('#set-auto-install'),
  setCheckInterval: $('#set-check-interval'), setUpdateChannel: $('#set-update-channel'),
  setAutoStartDsh: $('#set-auto-start-dsh'), setDshPort: $('#set-dsh-port'), setTheme: $('#set-theme'),
  nodeVersion: $('#node-version'), npmVersion: $('#npm-version'), btnOpenNodeDownload: $('#btn-open-node-download'),
  setAppUpdateRepo: $('#set-app-update-repo'), setAppUpdateUrl: $('#set-app-update-url'),
  setAppAutoCheck: $('#set-app-auto-check'), btnCheckAppUpdate: $('#btn-check-app-update'),
  btnDownloadAppUpdate: $('#btn-download-app-update'), appUpdateResult: $('#app-update-result'),
  btnRemoveKernel: $('#btn-remove-kernel'),
  // 运行日志
  btnOpenLogs: $('#btn-open-logs'), logsModal: $('#logs-modal'), logsBackdrop: $('#logs-backdrop'),
  btnCloseLogs: $('#btn-close-logs'), btnCopyLog: $('#btn-copy-log'), btnClearLog: $('#btn-clear-log'),
  logOutput: $('#log-output'),
};

// 运行日志状态：滚动保留最近 500 条，实时追加
let logCache = [];
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// 单行日志 → 着色 HTML（错误红 / 警告黄），span 必须包裹文本才生效
function logLineHtml(line) {
  if (/error|失败|异常|✗|Cannot|Unable/i.test(line)) return '<span class="log-err">' + escapeHtml(line) + '</span>';
  if (/warn|警告|WARN/i.test(line)) return '<span class="log-warn">' + escapeHtml(line) + '</span>';
  return escapeHtml(line);
}
function appendLogLine(line) {
  logCache.push(line);
  if (logCache.length > 500) logCache.shift();
  // 弹层未打开时只更新缓存，打开时由 refreshLogs 全量渲染
  if (!els.logOutput || els.logsModal.classList.contains('hidden')) return;
  if (els.logOutput.textContent === '（暂无日志）') els.logOutput.textContent = '';
  // insertAdjacentHTML 增量追加，避免 innerHTML += 全量重解析
  els.logOutput.insertAdjacentHTML('beforeend', logLineHtml(line) + '\n');
  els.logOutput.scrollTop = els.logOutput.scrollHeight;
}
async function refreshLogs() {
  try {
    const logs = await api.getLogs();
    logCache = logs || [];
    renderLogCache();
  } catch {}
}
function renderLogCache() {
  if (!els.logOutput) return;
  els.logOutput.innerHTML = logCache.length ? logCache.map(logLineHtml).join('\n') : '（暂无日志）';
  els.logOutput.scrollTop = els.logOutput.scrollHeight;
}
function openLogs() {
  els.logsModal.classList.remove('hidden');
  refreshLogs();
}
function closeLogs() { els.logsModal.classList.add('hidden'); }

let currentSettings = null;
let lastAppUpdateInfo = null;
let wsReady = false;      // webview 页面加载完成
let dshReady = false;     // 端口探活成功（dsh 服务真正就绪）
let webviewVerifyTimer = null; // webview "完全加载" 校验轮询定时器
let lastDshPort = 3080;
// 内核更新（安装）操作锁：安装中禁用更新按钮与 dsh 启动按钮，防止重复点击/文件占用
let updateBusy = false;
// 检查更新锁：仅禁用检查/安装按钮，不影响 dsh 启动
let checkBusy = false;
// 内置内核导入/对齐中：抑制 15s 轮询把启动遮罩重置为"空态"并禁用启动按钮
let kernelImporting = false;

function setStageLoading(t) { els.loadingText.textContent = t || '正在启动 dsh…'; }

/** 启动阶段的内核导入进度：更新全屏提示文字 + 进度条 */
function setKernelImport(percent, message) {
  setStageLoading((message || '') + (typeof percent === 'number' ? '（' + percent + '%）' : ''));
  if (els.stageImportBar) els.stageImportBar.classList.remove('hidden');
  if (els.stageImportBarFill && typeof percent === 'number') {
    els.stageImportBarFill.style.width = percent + '%';
  }
}
function hideKernelImport() {
  if (els.stageImportBar) els.stageImportBar.classList.add('hidden');
  if (els.stageImportBarFill) els.stageImportBarFill.style.width = '0%';
}

function setUpdateButtonsDisabled(disabled) {
  els.btnCheckUpdate.disabled = disabled || updateBusy || checkBusy;
  // 该按钮同时承担"安装内核"职责（未安装时也应可点击），不再以 kernelInstalled 禁用
  els.btnInstallUpdate.disabled = disabled || updateBusy || checkBusy || !currentSettings;
}

// ---------- 内核更新进度条展示 ----------

/**
 * 更新进度条：显示进度百分比 + 状态文字。
 * @param {number|undefined} percent 0-100；undefined 时保持当前宽度
 * @param {string} message 状态文字
 * @param {string} [state] 'active'（流动动画）| 'done' | 'err'
 */
function setKernelUpdateProgress(percent, message, state) {
  if (!els.kernelUpdateBox) return;
  els.kernelUpdateBox.classList.remove('hidden');
  els.kernelUpdateBox.classList.remove('active', 'done', 'err');
  if (state) els.kernelUpdateBox.classList.add(state);
  if (typeof percent === 'number') {
    const p = Math.max(0, Math.min(100, Math.round(percent)));
    if (els.kernelUpdateBar) els.kernelUpdateBar.style.width = p + '%';
  }
  if (els.kernelUpdateText) els.kernelUpdateText.textContent = (message || '') + (typeof percent === 'number' ? '（' + Math.max(0, Math.min(100, Math.round(percent))) + '%）' : '');
}
function hideKernelUpdateProgress() {
  if (!els.kernelUpdateBox) return;
  els.kernelUpdateBox.classList.add('hidden');
  els.kernelUpdateBox.classList.remove('active', 'done', 'err');
  if (els.kernelUpdateBar) els.kernelUpdateBar.style.width = '0%';
  if (els.kernelUpdateText) els.kernelUpdateText.textContent = '';
}

/** 进入/退出"内核更新中"状态：锁定更新按钮、禁用 dsh 启动按钮 */
function setKernelUpdating(busy) {
  updateBusy = busy;
  setUpdateButtonsDisabled(false);
  if (busy) {
    els.btnStart.disabled = true;
  } else {
    refreshStatus(); // 恢复按实际 dsh 状态刷新按钮
  }
}

function setDot(c) { els.statusDot.className = 'dot ' + c; }
function setStatus(t, c) { els.statusText.textContent = t; if (c) setDot(c); }
function showStage(s) {
  els.stageEmpty.classList.toggle('hidden', s !== 'empty');
  els.stageLoading.classList.toggle('hidden', s !== 'loading');
  els.stageFailed.classList.toggle('hidden', s !== 'failed');
  els.stageFrame.classList.toggle('hidden', s !== 'frame');
}

function loadWsUrl() {
  if (!els.dshWebview) return;
  wsReady = false;
  clearTimeout(webviewVerifyTimer);
  els.dshWebview.src = 'http://127.0.0.1:' + lastDshPort;
}

function applyDshState(dsh) {
  const running = !!(dsh && dsh.running);
  // 内核更新/导入中即使 dsh 已停止也禁用启动按钮（防止文件占用破坏内核）
  els.btnStart.disabled = running || updateBusy || kernelImporting;
  els.btnStop.disabled = !running;
  if (running) {
    lastDshPort = dsh.port || lastDshPort;
    els.statusExtra.textContent = 'PID ' + (dsh.pid || '') + ' · 端口 ' + lastDshPort;
    // 就绪状态以主进程端口探活结果（dsh.ready）为准：
    // macOS 关窗后应用驻留后台、dsh 继续运行，重开窗口时新的渲染层
    // 没有收到过 dsh:ready 一次性事件，靠状态快照里的 ready 恢复加载工作台。
    if (!dsh.ready) {
      dshReady = false;
      // 进程在但服务未就绪：保持"启动中"，不加载 webview（避免闪"无法连接"失败页）
      setStatus('dsh 启动中', 'yellow');
      showStage('loading'); setStageLoading('dsh 服务启动中，请稍候…');
    } else {
      dshReady = true;
      if (!wsReady) {
        setStatus('dsh 运行中', 'green');
        showStage('loading'); setStageLoading('正在加载工作台…'); loadWsUrl();
      } else {
        setStatus('dsh 运行中', 'green');
      }
    }
  } else if (kernelImporting) {
    // 内置内核导入/对齐中：保持全屏进度提示，不被 15s 轮询重置为"空态"
    setStatus('正在导入内核…', 'yellow');
    showStage('loading');
  } else {
    setStatus('dsh 已停止', 'gray');
    els.statusExtra.textContent = '';
    wsReady = false;
    dshReady = false;
    clearTimeout(webviewVerifyTimer);
    showStage('empty');
  }
}

async function refreshStatus() {
  try {
    const s = await api.getStatus();
    currentSettings = { ...s.settings, kernelInstalled: !!s.kernel.installed };
    lastDshPort = (s.settings && s.settings.dshPort) || 3080;
    // 注意：不要在此处调用 applySettingsToForm——
    // 本函数被 15s 定时轮询调用，会把设置弹层中正在编辑的内容覆盖回旧值。
    // 表单仅在打开弹层 / 初始加载时同步一次。
    els.statusVersion.textContent = 'v' + s.appVersion;
    els.kernelVersionInfo.textContent = s.kernel.installed ? '已安装 v' + s.kernel.version : '未安装';
    els.btnInstallUpdate.textContent = s.kernel.installed ? '更新内核' : '安装内核';
    els.nodeVersion.textContent = s.nodeEnv.nodeAvailable ? s.nodeEnv.nodeVersion : '未检测到';
    els.npmVersion.textContent = s.nodeEnv.npmAvailable ? s.nodeEnv.npmVersion : '不可用';
    els.btnOpenNodeDownload.hidden = !(s.nodeEnv && !s.nodeEnv.meetsRequirement);
    // 更新按钮状态由锁统一管理（更新进行中保持禁用）
    setUpdateButtonsDisabled(false);
    // 主进程侧内置内核导入/对齐中：若窗口就绪过晚导致 import 进度事件丢失，
    // 靠状态快照恢复导入提示（置于 applyDshState 之前，避免被重置为空态）
    if (s.kernelImporting) {
      if (!kernelImporting) {
        kernelImporting = true;
        els.btnStart.disabled = true;
        showStage('loading');
      }
      const p = s.kernelImportProgress;
      if (p && typeof p === 'object' && !Array.isArray(p)) {
        setKernelImport(p.percent, p.message);
      } else {
        setKernelImport(undefined, '正在准备导入内置内核…');
      }
    } else if (kernelImporting) {
      // 导入已结束但完成事件错失（窗口就绪太晚）：清理导入态
      kernelImporting = false;
      els.btnStart.disabled = false;
      hideKernelImport();
    }
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
  els.setNpmRegistryMode.value = currentSettings.npmRegistryMode || 'auto';
  els.setNpmRegistryCustom.value = currentSettings.npmRegistryCustom || '';
  syncRegistryCustomRow();
  els.setAutoStartDsh.checked = !!currentSettings.autoStartDsh;
  els.setDshPort.value = currentSettings.dshPort || 3080;
  els.setTheme.value = currentSettings.themeMode || 'auto';
  // 输入框语义是 owner/repo 完整格式；repo 字段若已含 owner 前缀则原样显示
  const own = currentSettings.appUpdateOwner || 'mannixS';
  const rep = currentSettings.appUpdateRepo || 'DSH-Desktop';
  els.setAppUpdateRepo.value = rep.includes('/') ? rep : `${own}/${rep}`;
  els.setAppUpdateUrl.value = currentSettings.appUpdateUrl || '';
  els.setAppAutoCheck.checked = !!currentSettings.appAutoCheckUpdate;
}

/** 自定义源行：仅当选择"自定义"时显示 */
function syncRegistryCustomRow() {
  if (!els.rowNpmRegistryCustom || !els.setNpmRegistryMode) return;
  els.rowNpmRegistryCustom.classList.toggle('hidden', els.setNpmRegistryMode.value !== 'custom');
}

async function handleStart() {
  // 点击瞬间立即反馈：禁用按钮 + 显示启动中 + 重置就绪标记（防重复点击）
  els.btnStart.disabled = true;
  dshReady = false; wsReady = false;
  showStage('loading'); setStageLoading('正在启动 dsh 服务…');
  try {
    const res = await api.startDsh({ mode: 'web', port: lastDshPort });
    if (res && res.ok === false && res.reason === 'kernel-not-installed') {
      showStage('failed'); els.stageFailedText.textContent = '内核未安装，请到设置中安装内核。';
    } else if (res && res.ok === false && res.reason === 'kernel-updating') {
      showToast('error', '内核处理中（更新/导入），完成后即可启动 dsh。', 5000);
      refreshStatus();
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

async function openSettings() {
  els.settingsModal.classList.remove('hidden');
  // 打开弹层时同步一次表单（此后的轮询不再覆盖用户输入）
  await refreshStatus();
  applySettingsToForm();
}
function closeSettings() { els.settingsModal.classList.add('hidden'); }

function showToast(t, text, ms) {
  els.updateToast.textContent = text;
  els.updateToast.style.color = t === 'error' ? 'var(--danger)' : (t === 'ok' ? 'var(--accent)' : 'var(--text-muted)');
  els.updateToast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => els.updateToast.classList.add('hidden'), ms || 6000);
}

async function handleCheckUpdate() {
  if (checkBusy || updateBusy) return; // 更新/检查进行中，忽略
  checkBusy = true;
  setUpdateButtonsDisabled(true);
  els.btnCheckUpdate.textContent = '检查中…';
  try {
    const ch = (currentSettings && currentSettings.updateChannel) || 'latest';
    const res = await api.checkUpdate(ch);
    if (!res.ok) showToast('error', '检查失败：' + (res.error || ''));
    else if (res.hasUpdate) { showToast('info', '发现新版本 ' + res.remote + '，点击「更新内核」升级。'); }
    else showToast('info', res.local ? '已是最新版本（' + res.local + '）。' : '未安装内核。');
  } catch (err) { showToast('error', '检查更新失败：' + err.message); }
  finally {
    checkBusy = false;
    els.btnCheckUpdate.textContent = '检查更新';
    setUpdateButtonsDisabled(false);
    refreshStatus();
  }
}

async function handleInstallUpdate() {
  if (updateBusy) return; // 更新进行中，忽略
  setKernelUpdating(true);
  setKernelUpdateProgress(0, '正在准备更新内核…', 'active');
  try {
    // 进度与最终结果主要由 update:install-* 事件驱动进度条显示；
    // 这里仅兜底处理不会触发事件的分支（如"已是最新"）
    const res = await api.installUpdate();
    if (res && res.reason === 'no-update') {
      hideKernelUpdateProgress();
      showToast('info', '已是最新版本。');
    } else if (res && res.reason === 'installing') {
      hideKernelUpdateProgress();
      showToast('info', '已有更新任务进行中。');
    } else if (res && !res.ok && res.reason === 'kernel-updating') {
      hideKernelUpdateProgress();
      showToast('error', '内核更新中，请稍候。');
    }
  } catch (err) {
    // invoke 抛错（事件未发出的异常路径）：补一次错误提示
    setKernelUpdateProgress(undefined, '更新失败：' + err.message, 'err');
    setTimeout(hideKernelUpdateProgress, 5000);
    showToast('error', '更新失败：' + err.message);
  } finally {
    setKernelUpdating(false);
  }
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
    else if (info.updateAvailable) setAppUpdateResult('ok', '发现新版本 v' + info.latest + '，正在自动下载…');
    else setAppUpdateResult('', '当前已是最新版本（v' + info.current + '）。');
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
  const prevPort = lastDshPort;
  // 解析「GitHub 仓库」输入：支持 owner/repo 完整格式或纯 repo 名
  const repoInput = els.setAppUpdateRepo.value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '');
  let appUpdateOwner = (currentSettings && currentSettings.appUpdateOwner) || 'mannixS';
  let appUpdateRepo = repoInput;
  if (repoInput.includes('/')) {
    const parts = repoInput.split('/').filter(Boolean);
    appUpdateOwner = parts[0];
    appUpdateRepo = parts[1] || '';
  }
  const patch = {
    autoCheckUpdate: els.setAutoCheck.checked, autoInstall: els.setAutoInstall.checked,
    checkIntervalMinutes: Math.max(10, parseInt(els.setCheckInterval.value, 10) || 60),
    updateChannel: els.setUpdateChannel.value,
    npmRegistryMode: els.setNpmRegistryMode.value,
    npmRegistryCustom: els.setNpmRegistryCustom.value.trim(),
    autoStartDsh: els.setAutoStartDsh.checked,
    dshPort: parseInt(els.setDshPort.value, 10) || 3080,
    themeMode: els.setTheme.value,
    appUpdateOwner, appUpdateRepo,
    appUpdateUrl: els.setAppUpdateUrl.value.trim(),
    appAutoCheckUpdate: els.setAppAutoCheck.checked,
  };
  try {
    const res = await api.updateSettings(patch);
    currentSettings = { ...currentSettings, ...patch };
    lastDshPort = patch.dshPort;
    // 主题模式保存后立即生效
    applyConfiguredTheme();
    els.settingsSaveTip.textContent = '已保存';
    setTimeout(() => (els.settingsSaveTip.textContent = ''), 2000);
    // 端口变化且 dsh 运行中：自动重启以应用新端口
    if (res && res.dshNeedsRestart) {
      showToast('info', `端口已改为 ${patch.dshPort}，正在重启 dsh 以应用新端口…`, 5000);
      try {
        const rr = await api.restartDsh({ mode: 'web', port: patch.dshPort });
        if (!(rr && rr.ok) && rr && rr.reason === 'kernel-updating') {
          showToast('error', '内核更新中，端口将在更新完成后由您手动重启生效。', 6000);
        }
      } catch (err) {
        showToast('error', '重启 dsh 失败：' + err.message);
      }
    } else if (patch.dshPort !== prevPort) {
      showToast('info', `端口已改为 ${patch.dshPort}，下次启动 dsh 时生效。`);
    }
  } catch (err) { showToast('error', '保存设置失败：' + err.message); }
}

async function handleRemoveKernel() {
  if (!confirm('确定移除本地内核吗？')) return;
  if (!confirm('再次确认：移除后将无法启动 dsh。')) return;
  try {
    const res = await api.removeKernel();
    if (res && res.ok === false && res.reason === 'kernel-updating') {
      showToast('error', '内核更新中，暂时无法移除内核。');
    } else {
      showToast('info', '内核已移除');
    }
    refreshStatus();
  } catch (err) { showToast('error', '移除内核失败：' + err.message); }
}

// ---------- 主题动态跟随 dsh 页面（明暗主题） ----------

/**
 * 应用主题模式到客户端根元素，CSS 据此切换深色/浅色配色。
 * @param {'dark'|'light'} mode
 */
function setShellTheme(mode) {
  document.documentElement.setAttribute('data-theme', mode === 'light' ? 'light' : 'dark');
}

/**
 * 根据设置中的 themeMode 应用外壳主题：
 *   auto   → 跟随 dsh web ui（由 extractThemeFromWebview 周期驱动）
 *   system → 跟随系统深浅色
 *   dark / light → 固定
 */
function applyConfiguredTheme() {
  const m = (currentSettings && currentSettings.themeMode) || 'auto';
  if (m === 'dark' || m === 'light') {
    setShellTheme(m);
  } else if (m === 'system') {
    setShellTheme(window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  }
  // 'auto'：不直接设置，等待 dsh 页面检测结果
}

/** 截图兜底采样（限频 5s）：DOM 检测失败时按 webview 渲染像素亮度判断明暗 */
let _themeShotAt = 0;
function themeByScreenshot() {
  if (!els.dshWebview || Date.now() - _themeShotAt < 5000) return;
  _themeShotAt = Date.now();
  try {
    els.dshWebview.capturePage().then((img) => {
      const url = img.toDataURL();
      if (!url || url.length < 100) return; // webview 隐藏时返回空图
      const c = document.createElement('canvas');
      c.width = 8; c.height = 8;
      const ctx = c.getContext('2d');
      const im = new Image();
      im.onload = () => {
        try {
          ctx.drawImage(im, 0, 0, 8, 8);
          const d = ctx.getImageData(0, 0, 8, 8).data;
          let lum = 0, n = 0;
          for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] > 0) { lum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; n++; }
          }
          if (n > 0) setShellTheme(lum / n < 128 ? 'dark' : 'light');
        } catch {}
      };
      im.onerror = () => {};
      im.src = url;
    }).catch(() => {});
  } catch {}
}

/**
 * 从 dsh 页面提取当前主题模式并应用到客户端。
 * 检测优先级（已按 dsh 官方源码 ui-theme/ui-layout 插件的实际机制适配）：
 *  1. body[data-ds-dark-theme] —— dsh ThemePresenter 切主题时写（深色有、浅色无），权威
 *  2. html/body 的 inline colorScheme（dsh boot-theme 脚本写入 'dark'/'light'）
 *  3. 通用属性：data-theme / class dark|light / computed color-scheme
 *  4. 深层容器背景亮度（SPA 兜底）
 *  全部失败 → 截图采样兜底。
 * 注意：不能依赖 webview.getWebContents()（Electron 33 已移除），executeJavaScript 是稳定 API。
 */
function extractThemeFromWebview() {
  if (!els.dshWebview) return;
  // 手动/系统模式下不跟随 dsh（不覆盖用户选择）
  const mode0 = (currentSettings && currentSettings.themeMode) || 'auto';
  if (mode0 !== 'auto') return;
  try {
    els.dshWebview.executeJavaScript(`
      (() => {
        // 1) dsh 官方机制：body[data-ds-dark-theme]（ThemePresenter 维护）
        if (document.body && document.body.hasAttribute('data-ds-dark-theme')) return 'dark';
        // 2) dsh boot 脚本：html/body inline colorScheme
        for (const el of [document.documentElement, document.body]) {
          const s = ((el && el.style && el.style.colorScheme) || '').toLowerCase();
          if (s === 'dark' || s === 'light') return s;
        }
        // 3) 通用属性（非 dsh 页面兜底）
        const pickAttr = (el) => {
          if (!el) return null;
          const dt = el.getAttribute && el.getAttribute('data-theme');
          if (dt === 'dark' || dt === 'light') return dt;
          if (el.classList) {
            if (el.classList.contains('dark')) return 'dark';
            if (el.classList.contains('light')) return 'light';
          }
          const cs = (getComputedStyle(el).getPropertyValue('color-scheme') || '').trim().toLowerCase();
          if (cs.includes('dark')) return 'dark';
          if (cs.includes('light')) return 'light';
          return null;
        };
        for (const el of [document.documentElement, document.body]) {
          const r = pickAttr(el); if (r) return r;
        }
        // 4) 深层容器背景亮度（跳过全透明元素）
        const byLuminance = (el) => {
          if (!el) return null;
          const bg = getComputedStyle(el).backgroundColor || '';
          const m = bg.match(/^rgba?\\(([\\d.]+)[, ]+([\\d.]+)[, ]+([\\d.]+)(?:[, /]+([\\d.]+))?\\)/);
          if (!m) return null;
          if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
          const lum = 0.299 * parseFloat(m[1]) + 0.587 * parseFloat(m[2]) + 0.114 * parseFloat(m[3]);
          return lum < 128 ? 'dark' : 'light';
        };
        let el = document.body, depth = 0;
        while (el && depth < 15) {
          const r = byLuminance(el); if (r) return r;
          el = el.firstElementChild; depth++;
        }
        return null; // 交给外部截图兜底
      })()
    `, true).then((mode) => {
      if (mode) setShellTheme(mode);
      else themeByScreenshot();
    }).catch(() => {});
  } catch {}
}

// 系统深浅色变化实时跟随（themeMode === 'system' 时）
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if ((currentSettings && currentSettings.themeMode) === 'system') applyConfiguredTheme();
});

// ---------- webview 完全加载校验 ----------
// 只有当 dsh 页面真正加载完成（did-finish-load 且 document.readyState === complete）
// 才关闭"启动中"遮罩、展示 webview，避免闪现空白页。
// 初始 about:blank 的加载事件一律忽略（通过 URL 判断）。

/** 当前 webview 是否已导航到 dsh 服务地址 */
function isDshUrl() {
  try {
    return /^http:\/\/127\.0\.0\.1:\d+/.test(els.dshWebview.getURL());
  } catch {
    return false;
  }
}

/** 标记 webview 就绪：展示工作台 + 同步一次主题 */
function markWebviewReady() {
  wsReady = true;
  clearTimeout(webviewVerifyTimer);
  webviewVerifyTimer = null;
  showStage('frame');
  setStatus('dsh 运行中', 'green');
  extractThemeFromWebview();
}

/**
 * 校验 dsh 页面是否"完全加载完成"：
 * readyState === 'complete' 才放行；未完成则 300ms 重试，
 * 重试超限后兜底放行（防止个别页面行为导致一直卡在遮罩）。
 */
async function verifyWebviewLoaded(attempt = 0) {
  if (!els.dshWebview || wsReady || !isDshUrl()) return;
  try {
    const ready = await els.dshWebview.executeJavaScript('document.readyState === "complete"', true);
    if (ready) {
      markWebviewReady();
      return;
    }
  } catch { /* 页面正在跳转等，继续重试 */ }
  if (attempt >= 25) {
    markWebviewReady(); // ~7.5s 兜底放行
    return;
  }
  clearTimeout(webviewVerifyTimer);
  webviewVerifyTimer = setTimeout(() => verifyWebviewLoaded(attempt + 1), 300);
}

// ---------- 事件绑定 ----------
function bindEvents() {
  // 检测平台：mac 使用原生红绿灯按钮，隐藏自绘按钮；Windows/Linux 使用自绘
  const isMac = navigator.platform.toLowerCase().includes('mac');
  document.body.setAttribute('data-platform', isMac ? 'mac' : 'win');

  if (isMac) {
    // mac：保留原生按钮，不绑定自绘窗口控制（避免功能重叠）
    if (els.titlebarControls) els.titlebarControls.style.display = 'none';
  } else {
    // Windows/Linux：自绘窗口控制按钮
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
  }

  els.btnStart.addEventListener('click', handleStart);
  els.btnStop.addEventListener('click', handleStop);
  els.btnOpenSettings.addEventListener('click', openSettings);
  els.btnCloseSettings.addEventListener('click', closeSettings);
  els.settingsBackdrop.addEventListener('click', closeSettings);
  // 运行日志
  els.btnOpenLogs.addEventListener('click', openLogs);
  els.btnCloseLogs.addEventListener('click', closeLogs);
  els.logsBackdrop.addEventListener('click', closeLogs);
  els.btnClearLog.addEventListener('click', () => {
    logCache = [];
    if (els.logOutput) els.logOutput.textContent = '（暂无日志）';
  });
  els.btnCopyLog.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(logCache.join('\n'));
      showToast('info', '日志已复制到剪贴板');
    } catch {
      showToast('error', '复制失败');
    }
  });
  els.btnStageRetry.addEventListener('click', handleStart);
  els.btnCheckUpdate.addEventListener('click', handleCheckUpdate);
  els.btnInstallUpdate.addEventListener('click', handleInstallUpdate);
  // 下载源选择联动：选"自定义"时显示地址输入框
  els.setNpmRegistryMode.addEventListener('change', syncRegistryCustomRow);
  els.btnSaveSettings.addEventListener('click', handleSaveSettings);
  els.btnRemoveKernel.addEventListener('click', handleRemoveKernel);
  els.btnOpenNodeDownload.addEventListener('click', () => api.openNodeDownload());
  els.btnCheckAppUpdate.addEventListener('click', handleCheckAppUpdate);
  els.btnDownloadAppUpdate.addEventListener('click', handleInstallAppUpdate);

  if (els.dshWebview) {
    // 外链拦截已移至主进程（web-contents-created）：
    // webview.getWebContents() 在 Electron 33 已移除，渲染层拿不到 guest webContents
    els.dshWebview.addEventListener('did-start-loading', () => {
      if (!isDshUrl()) return;
      showStage('loading'); setStageLoading('正在加载工作台…');
    });
    els.dshWebview.addEventListener('dom-ready', () => {
      if (!isDshUrl()) return;
      setStageLoading('正在渲染工作台界面…');
    });
    // 完全加载校验：did-finish-load / did-stop-loading 都触发一次，
    // 由 verifyWebviewLoaded 轮询 readyState 确认真正完成才展示（见上方实现）
    els.dshWebview.addEventListener('did-finish-load', () => verifyWebviewLoaded());
    els.dshWebview.addEventListener('did-stop-loading', () => verifyWebviewLoaded());
    els.dshWebview.addEventListener('did-fail-load', (e) => {
      if (e.errorCode === -3) return; // ABORTED（正常导航中断），忽略
      wsReady = false; clearTimeout(webviewVerifyTimer);
      showStage('failed');
      els.stageFailedText.textContent = '无法连接 dsh（端口 ' + lastDshPort + '），请确认服务已启动。';
    });
  }

  api.onDshState((st) => {
    // 统一走 applyDshState：启动中/就绪/停止全部由状态（含 ready 探活结果）驱动
    if (st) applyDshState(st);
  });
  // 端口探活成功（服务就绪）后才加载 webview → 期间一直显示"启动中"，避免黑屏
  api.onDshReady((info) => {
    dshReady = true;
    setStatus('dsh 运行中', 'green'); els.statusExtra.textContent = '端口 ' + (info && info.port);
    // 若状态推送已抢先加载过工作台，避免重复加载
    if (wsReady) return;
    showStage('loading'); setStageLoading('正在加载工作台…'); loadWsUrl();
  });
  api.onDshStartProgress((m) => { showStage('loading'); setStageLoading(m); });
  api.onDshStopProgress((m) => { showStage('loading'); setStageLoading(m); });
  api.onDshStopDone(() => refreshStatus());
  // 实时日志（dsh 进程输出 + 客户端日志）
  api.onDshLog((line) => appendLogLine(line));
  // dsh 意外退出：显示退出原因（便于用户定位反复退出的问题）
  api.onDshUnexpectedExit((info) => {
    setStatus('dsh 已退出', 'red');
    els.statusExtra.textContent = info && info.reason ? info.reason : 'dsh 异常退出';
    showToast('error', info && info.reason ? info.reason : 'dsh 异常退出', 8000);
  });

  api.onUpdateAvailable((info) => { if (info.hasUpdate) { els.btnInstallUpdate.disabled = updateBusy || checkBusy; showToast('info', '发现新版本 ' + info.remote + '，可到设置中更新。'); } });
  // 内核更新（自动安装/手动安装都会触发）：进入更新中状态，进度走内嵌进度条
  api.onUpdateInstallStart(() => {
    setKernelUpdating(true);
    setKernelUpdateProgress(0, '正在准备更新内核…', 'active');
  });
  api.onUpdateInstallProgress((m) => {
    if (m && typeof m === 'object' && !Array.isArray(m)) {
      setKernelUpdateProgress(m.percent, m.message, 'active');
    } else if (typeof m === 'string') {
      // 兼容旧版纯文本进度
      setKernelUpdateProgress(undefined, m, 'active');
    }
  });
  api.onUpdateInstallDone((r) => {
    setKernelUpdateProgress(100, '内核已更新至 v' + (r.version || '?'), 'done');
    setTimeout(hideKernelUpdateProgress, 3500);
    showToast('ok', '内核已更新至 v' + (r.version || ''));
    setKernelUpdating(false);
  });
  api.onUpdateInstallError((m) => {
    setKernelUpdateProgress(undefined, '更新失败：' + m, 'err');
    setTimeout(hideKernelUpdateProgress, 5000);
    showToast('error', '更新失败：' + m);
    setKernelUpdating(false);
  });

  api.onKernelImportProgress((m) => {
    // 导入/对齐期间：禁用启动按钮，显示全屏进度条；阻止轮询重置为空态
    kernelImporting = true;
    els.btnStart.disabled = true;
    showStage('loading');
    if (m && typeof m === 'object' && !Array.isArray(m)) {
      setKernelImport(m.percent, m.message);
    } else {
      setKernelImport(undefined, m);
    }
  });
  api.onKernelImportDone((info) => {
    kernelImporting = false;
    els.btnStart.disabled = false;
    hideKernelImport();
    setStatus('内核就绪，点击启动', 'yellow');
    // skipped=true 表示"已安装同版本内核，无需导入"（仅提示一条中性文案）
    if (!(info && info.skipped)) {
      showToast('ok', '内置内核 v' + (info.version || '?') + ' 导入完成');
    }
    refreshStatus();
  });
  api.onKernelImportError((m) => {
    kernelImporting = false;
    els.btnStart.disabled = false;
    hideKernelImport();
    showToast('error', '内置内核导入失败：' + m);
    refreshStatus();
  });

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

// ---------- 启动 ----------
bindEvents();
// 初始加载同步一次设置表单与主题（此后仅打开设置弹层时同步，避免轮询覆盖用户输入）
refreshStatus().then(() => { applySettingsToForm(); applyConfiguredTheme(); });
setInterval(refreshStatus, 15000);
// 周期检测 dsh 主题（dsh 切换明暗主题时客户端跟随，2s 保证跟手）
setInterval(extractThemeFromWebview, 2000);
