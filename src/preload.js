'use strict';

/**
 * preload.js
 * 安全 IPC 桥：渲染进程只能通过暴露的白名单 API 与主进程通信
 */

const { contextBridge, ipcRenderer } = require('electron');

const api = {
  // ---------- 状态 ----------
  getStatus: () => ipcRenderer.invoke('status:get'),

  // ---------- 内核更新 ----------
  checkUpdate: (channel) => ipcRenderer.invoke('update:check', channel),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  rollbackKernel: () => ipcRenderer.invoke('update:rollback'),
  installKernel: () => ipcRenderer.invoke('kernel:install'),
  removeKernel: () => ipcRenderer.invoke('kernel:remove'),

  // ---------- dsh 进程 ----------
  startDsh: (opts) => ipcRenderer.invoke('dsh:start', opts),
  stopDsh: () => ipcRenderer.invoke('dsh:stop'),
  restartDsh: (opts) => ipcRenderer.invoke('dsh:restart', opts),

  // ---------- 设置 ----------
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),

  // ---------- 日志 ----------
  getLogs: () => ipcRenderer.invoke('logs:get'),

  // ---------- 系统 ----------
  openNodeDownload: () => ipcRenderer.invoke('env:openNodeDownload'),

  // ---------- 客户端自身程序更新（预留） ----------
  checkAppUpdate: () => ipcRenderer.invoke('app-update:check'),
  downloadAppUpdate: (url, filename) => ipcRenderer.invoke('app-update:download', url, filename),
  openAppRelease: (url) => ipcRenderer.invoke('app-update:open-release', url),

  // ---------- 事件订阅 ----------
  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (_e, info) => cb(info)),
  onUpdateInstallStart: (cb) => ipcRenderer.on('update:install-start', () => cb()),
  onUpdateInstallProgress: (cb) => ipcRenderer.on('update:install-progress', (_e, msg) => cb(msg)),
  onUpdateInstallDone: (cb) => ipcRenderer.on('update:install-done', (_e, result) => cb(result)),
  onUpdateInstallError: (cb) => ipcRenderer.on('update:install-error', (_e, msg) => cb(msg)),
  onAppUpdateAvailable: (cb) => ipcRenderer.on('app-update:available', (_e, info) => cb(info)),
  onDshLog: (cb) => ipcRenderer.on('dsh:log', (_e, line) => cb(line)),
};

contextBridge.exposeInMainWorld('dshClient', api);
