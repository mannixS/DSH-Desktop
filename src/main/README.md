# src/main —— 主进程核心模块

本目录是客户端的核心逻辑所在：内核管理、dsh 进程托管、设置持久化与主进程编排。

## 模块说明

| 文件 | 职责 |
|------|------|
| `main.js` | 主进程入口。创建窗口、注册全部 IPC、编排自动更新（启动检查 + 定时轮询）、首启导入内置内核、单实例锁、退出清理 |
| `kernel-manager.js` | **内核管理**。本地版本读取、npm registry 版本检查（latest/stable）、Node 环境检测、内核安装（临时目录安装 → 校验 → 备份 → 原子替换）、回滚、内置内核导入（`getBundledKernelInfo` / `importBundledKernel`） |
| `dsh-host.js` | **dsh 进程托管**。用系统 Node 启动 `dsh web`（设置 `DSH_HOME` 隔离数据）、停止/重启、日志实时回调 |
| `app-updater.js` | **客户端自身程序更新（预留）**。GitHub Releases / 自定义 JSON 更新源检查、匹配平台安装包、下载到系统下载目录 |
| `settings.js` | 设置持久化。JSON 文件读写（userData/settings.json），默认值见 `DEFAULTS` |

## 关键流程

### 内核更新（kernel-manager.installKernel）
```
安装到 kernel.tmp（npm install --prefix）→ 校验 bin.js 存在
→ 用 node 执行 dsh --version 验证可运行 → 备份旧内核到 kernel.bak
→ 原子替换 tmp → kernel → 若 dsh 运行中则自动重启
```

### 更新检查（kernel-manager.checkForUpdates）
- `latest` 通道：请求 `registry.npmjs.org/@deepseek-ai/dsh/latest`
- `stable` 通道：请求全量版本列表，挑选最高正式版（无预发布后缀）

### 版本比较（semver）
- 支持 `major.minor.patch[-pre]`，预发布版本低于正式版（`0.1.0-rc.6 < 0.1.0`）。

## IPC 通道一览

| 通道 | 说明 |
|------|------|
| `status:get` | 获取完整状态快照（内核 / 内置内核 / Node / dsh / 设置） |
| `update:check` / `update:install` / `update:rollback` | 内核更新操作 |
| `kernel:install` / `kernel:remove` | 内核安装 / 移除 |
| `app-update:check` | 客户端程序更新检查 |
| `app-update:download` | 下载客户端新版本安装包 |
| `app-update:open-release` | 打开 Release 页面 |
| `dsh:start` / `dsh:stop` / `dsh:restart` | 进程控制 |
| `settings:get` / `settings:update` | 设置读写 |
| `logs:get` | 日志获取 |
| `env:openNodeDownload` | 打开 Node.js 下载页 |

主进程 → 渲染进程事件：`update:available`、`update:install-start/progress/done/error`、`app-update:available`、`dsh:log`。

## 注意事项

- 依赖系统 Node.js/npm 执行内核安装与运行；启动前会检测环境（v18+）。
- 更新采用"先校验后替换"策略，任何失败不会破坏当前可用内核。
- `main.js` 中自动检查使用 `setInterval`，间隔修改后会自动重排。
