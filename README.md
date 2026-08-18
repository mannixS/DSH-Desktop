# DSH Desktop —— DeepSeek Harness 跨平台桌面客户端

基于 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（简称 **dsh**，npm 包 `@deepseek-ai/dsh`）构建的 Windows / macOS 通用桌面客户端。

客户端围绕 **内核（dsh 本身）的安装与版本管理** 为核心能力，提供：

- ✅ **内置内核**：安装包预装 dsh 内核，用户下载安装后开箱即用（无需联网下载）
- ✅ **内核更新功能**：手动或自动检查 npm 上 dsh 的新版本，一键完成内核升级
- ✅ **内核回滚**：更新前自动备份上一版本，可随时回滚
- ✅ **更新通道**：`latest`（跟随最新，含 RC）/ `stable`（仅正式版）
- ✅ **客户端自身程序自动更新**：基于 electron-updater 指向本仓库 GitHub Releases，检查/下载/一键安装重启，支持自动检查
- ✅ **DSH 为主页**：全屏 dsh 工作台（内嵌 Web 界面 `127.0.0.1:3080`），启动中显示加载遮罩，异常提示加载失败并可重试
- ✅ **无边框圆角窗口**：去掉系统标题栏/菜单栏，自绘最小化/最大化/关闭按钮，可拖动
- ✅ **主题跟随 dsh**：客户端深/浅主题随 dsh 页面明暗切换（检测 data-theme / color-scheme / 背景亮度），并支持跟随系统
- ✅ **启动优化**：服务就绪前始终显示"启动中"遮罩（不黑屏），页面加载完成才展示 dsh
- ✅ **底部状态栏**：状态圆点 + 状态文字 + PID/端口 + 启动/停止按钮 + 版本号，一目了然
- ✅ **设置集中**：所有配置项（内核更新 / dsh 运行 / 运行环境 / 程序更新 / 危险操作）集中在设置弹层，点「设置」才展示
- ✅ **真实状态驱动**：通过端口探活感知 dsh 服务就绪，避免"进程已启动但界面显示未启动"的状态脱节
- ✅ **内核归档化**：内置内核以单文件归档打进安装包，安装秒级完成（避免 3 万+ 小文件逐个解压）
- ✅ **进程托管**：启动 / 停止 / 重启 dsh，实时日志；**关闭软件时同步关闭内核（含子进程树），不残留**
- ✅ **环境检测**：Node.js / npm 可用性检测与引导安装（设置页）

---

## 项目文件树

```
deepseek-harness/
├── package.json              # 客户端主包（Electron 应用配置与依赖）
├── electron-builder.yml      # 双平台打包配置（Windows nsis / macOS dmg + 内置内核）
├── .gitignore                # Git 忽略规则
│
├── .github/
│   └── workflows/
│       └── build-release.yml # ★ GitHub Actions：tag 触发双平台编译并自动发布 Release
│
├── src/                      # Electron 主进程源码
│   ├── main/
│   │   ├── main.js           # 主进程入口：窗口、IPC、自动更新编排、内置内核导入、退出联动关闭内核
│   │   ├── kernel-manager.js # ★ 内核管理：版本检测 / npm 更新检查 / 安装 / 回滚 / 内置导入
│   │   ├── dsh-host.js       # ★ dsh 进程托管：启动 / 停止（进程树）/ 重启 / 日志
│   │   ├── app-updater.js    # ★ 客户端自身程序更新（GitHub Releases / 自定义 JSON）
│   │   └── settings.js       # 设置持久化（JSON）
│   └── preload.js            # 安全 IPC 桥（contextBridge 白名单 API）
│
├── renderer/                 # 渲染进程（客户端 UI）
│   ├── index.html            # 界面结构（全屏工作台 + 底部状态栏 + 设置弹层）
│   ├── styles.css            # 界面样式（深色主题）
│   └── renderer.js           # 界面逻辑（状态驱动 UI / 启停控制 / 更新 / 设置）
│
├── scripts/                  # 辅助脚本
│   ├── fetch-kernel.js       # ★ 打包前预下载内置内核到 vendor/kernel
│   ├── gen-icons.js          # ★ 从源图生成全套应用图标（PNG/ICO/ICNS）
│   ├── check-env.js          # 环境检查（Node/npm 版本）
│   ├── build.js              # 构建检查与打包提示
│   └── _verify.test.js       # 核心逻辑单元验证（回归）
│
├── build/icons/              # ★ 应用图标（icon.ico / icon.icns / 多尺寸 PNG）
├── vendor/kernel/            # 内置内核（打包时预下载，git 忽略）
├── resources/                # 图标源图等资源
├── dist/                     # 打包输出目录（构建后生成）
├── docs/                     # 文档目录
├── README.md                 # 本文件（项目简介 + 文件树）
└── agent_log.md              # 开发操作日志
```

> 运行时动态数据（内核安装、dsh 数据、设置）不放在仓库内，而是写入 Electron 的 `userData` 目录（见下文「运行时目录」）。

---

## 快速开始

### 环境要求

- **Node.js v18+**（推荐 v24，dsh 官方要求），且 npm 可用
- 本客户端为跨平台应用：Windows 10/11 x64、macOS 12+（Apple Silicon / Intel）

### 安装与运行（开发模式）

```bash
# 1. 安装依赖
npm install

# 2. 启动客户端
npm start
```

首次打开客户端（安装包版本）：

1. 启动即自动导入**安装包内置内核**（无需联网下载）；
2. 导入完成后**自动运行 dsh 服务**，默认主页（工作台）直接呈现 dsh Web 界面；
3. 首次使用 dsh 时，在 Web 界面中填入 API Key（DeepSeek 或其他兼容模型）并选择工作目录；
4. 「总览」页可查看内核版本与 dsh 进程状态，「设置」页包含全部配置项。

> 开发模式（`npm start`）下没有内置内核，需在「总览」页点击「更新内核」手动安装后，再「启动 dsh」（或开启设置中的「启动时自动运行 dsh」）。

### 内核更新

- **手动检查**：总览页 →「检查更新」，对比本地与最新版本；
- **自动检查**：默认开启（启动后与定时轮询，默认 60 分钟），可在「设置」中调整间隔或关闭；
- **自动安装**：可选，开启后检测到新版本自动下载安装并重启 dsh；
- **回滚**：更新前自动备份上一版本，可在总览页一键回滚。

### 客户端自身程序更新（预留）

客户端自身更新能力已实现检查与下载框架，通过 GitHub Releases 或自定义 JSON 端点：

- 在「设置 → 程序更新」填写更新源（GitHub `owner/repo` 或自定义 JSON URL）并保存；
- 点击「检查程序更新」对比当前客户端版本；有新版本时「下载新版本」下载安装包到系统下载目录；
- 安装由用户运行安装包完成（跨平台最稳妥，可扩展为自动静默安装）。

### 打包分发（Windows / macOS）

```bash
npm run pack:win     # 自动预下载内置内核 → Windows 安装包
npm run pack:mac     # 自动预下载内置内核 → macOS 安装包
```

- 打包前自动执行 `fetch-kernel` 将最新 dsh 内核下载到 `vendor/kernel` 并打入安装包；
- 指定内核版本：`DSH_KERNEL_VERSION=0.1.0 node scripts/fetch-kernel.js` 或直接 `node scripts/fetch-kernel.js <version>`；
- `electron-builder` 默认需联网下载 Electron 二进制与打包工具；macOS 安装包建议在 macOS 环境执行。

### GitHub Actions 在线编译与发布

仓库内置 `.github/workflows/build-release.yml`，支持在 GitHub 云端自动编译双平台客户端并发布 Release：

| 触发方式                           | 行为                                                                 |
| ---------------------------------- | -------------------------------------------------------------------- |
| 推送`v*` tag（如 `v1.0.0`）    | Windows/macOS 双平台并行构建 → 自动创建 GitHub Release 并附加安装包 |
| 手动`Run workflow`（Actions 页） | 仅构建并产出构建产物（artifact），不创建 Release                     |

发布流程：

```bash
# 1. 创建远程仓库后推送代码
git remote add origin https://github.com/<你的账号>/DSH-Desktop.git
git push -u origin main

# 2. 打版本 tag 触发 CI 构建与 Release
git tag v1.0.0
git push origin v1.0.0
```

CI 产物：

- Windows：`DSH Desktop-<版本>-win-x64.exe`（NSIS 安装包）
- macOS：`DSH Desktop-<版本>-mac-arm64.dmg` / `...-mac-x64.dmg`

---

## 运行时目录

客户端把动态数据写入系统用户数据目录（Electron `app.getPath('userData')`，即 `dsh-desktop/`）：

| 路径              | 用途                                                            |
| ----------------- | --------------------------------------------------------------- |
| `kernel/`       | dsh 内核安装目录（`node_modules/@deepseek-ai/dsh`）           |
| `kernel.bak/`   | 上一版本内核备份（用于回滚）                                    |
| `kernel.tmp/`   | 下载/安装中的临时目录                                           |
| `dsh-home/`     | dsh 数据目录（`DSH_HOME`，含 `.env`、`settings.yaml` 等） |
| `settings.json` | 客户端设置（自动更新开关、通道、程序更新源、端口等）            |

安装包内置内核位于安装目录（`process.resourcesPath/kernel`），首次启动时导入到上面的 `kernel/`，此后更新/回滚均在 `kernel/` 进行。

---

## 内核更新机制说明

1. **版本来源**：npm registry（`registry.npmjs.org/@deepseek-ai/dsh`），与 dsh 官方发布机制一致；
2. **检查更新**：对比本地安装版本与远端版本（`latest` 或 `stable` 通道），遵循 semver（含预发布 RC 排序规则）；
3. **安装流程**：`npm install --prefix <tmp> @deepseek-ai/dsh@<version>` → 校验入口可运行 → 备份旧版 → 原子替换（tmp → kernel）→ 若 dsh 运行中则自动重启应用新内核；
4. **失败保护**：下载失败自动清理临时目录；替换前校验新内核可运行；旧版保留在 `.bak` 可回滚；
5. **内置内核**：打包时将 `vendor/kernel` 打入安装包（`process.resourcesPath/kernel`），首启时若用户目录无内核则自动复制导入（已安装则跳过，尊重用户手动更新/回滚结果）。

---

## 相关文档

- 子目录说明：`src/README.md`、`src/main/README.md`、`renderer/README.md`、`scripts/README.md`
- 上游项目：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（MIT License）
- 运行日志：`agent_log.md`
