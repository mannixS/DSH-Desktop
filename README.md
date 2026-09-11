# DSH Desktop

**DeepSeek Harness（dsh）跨平台桌面客户端** —— 把 dsh 装进一个开箱即用的桌面应用，安装即用，无需配置 Node.js 等任何环境。

支持 Windows 10/11 x64 与 macOS 12+（Apple Silicon / Intel）。

---

## ✨ 功能特性

- 🚀 **开箱即用**：安装包内置 dsh 内核与 Node.js 运行时，安装后自动导入并启动服务，无需联网下载、无需预装环境
- 🖥️ **全屏工作台**：内嵌 dsh Web 界面，服务就绪后自动呈现；启动全程有加载提示，不黑屏、不闪白
- 🎨 **主题跟随**：客户端外观自动跟随 dsh 的深/浅色切换，也可在设置中固定深色、浅色或跟随系统
- 🔄 **内核管理**：一键检查、更新、回滚 dsh 内核；支持 latest（含 RC）/ stable（仅正式版）双通道与定时自动检查
- ⬆️ **程序自更新**：检测到新版本自动下载；Windows 点「安装并重启」即可升级，macOS 为引导式手动更新（详见常见问题）
- 🇨🇳 **国内加速更新源**：支持 **CNB 镜像（cnb.cool）**，与 GitHub 双源并发测速择优；国内网络无需代理即可快速检查与下载
- 📊 **实时状态**：底部状态栏随时显示服务运行状态、进程 PID 与端口；启动 / 停止 / 重启一键操作
- 📜 **运行日志**：客户端与 dsh 的完整输出实时滚动展示，支持一键复制，方便排查问题
- 🧹 **退出不残留**：关闭客户端时自动结束 dsh 及其全部子进程，不占用端口、不留后台进程

## 📥 下载安装

从 [Releases](https://github.com/mannixS/DSH-Desktop/releases) 页面下载对应平台的安装包：

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| Windows x64 | `DSH-Desktop-<版本>-win-x64.exe` | 双击安装（NSIS 安装向导） |
| macOS Apple Silicon | `DSH-Desktop-<版本>-mac-arm64.dmg` | 双击直接安装（推荐） |
| macOS Apple Silicon（解压版） | `DSH-Desktop-<版本>-mac-arm64.zip` | 解压后拖入「应用程序」 |
| macOS Intel | `DSH-Desktop-<版本>-mac-x64.zip` | 解压后拖入「应用程序」 |

**国内用户**可改用 CNB 镜像（cnb.cool）下载，速度更快且无需代理：

```
https://cnb.cool/mannixS/DSH-Desktop/-/releases
```

> **macOS 首次打开提示「已损坏/无法验证开发者」？**
> 应用未做 Apple 签名公证，属 Gatekeeper 正常拦截，并非文件损坏。在终端执行：
>
> ```bash
> sudo xattr -cr "/Applications/DSH Desktop.app"
> ```
>
> 然后重新打开即可。也可右键应用 →「打开」→「打开」放行。

## 🚀 快速上手

1. 安装并启动客户端，内置内核自动导入、dsh 服务自动运行；
2. 首次使用在工作台中填入 API Key（DeepSeek 或兼容模型），选择工作目录；
3. 开始使用。所有配置（端口、主题、更新等）集中在「设置」中。

## ❓ 常见问题

- **杀毒软件提示「正在修改 DLL 文件」？**
  覆盖升级时安装程序会替换 Electron 运行组件（如 `d3dcompiler_47.dll`），属正常现象，选择允许/信任即可。
- **检查更新提示 404？**
  请确认「设置 → 程序更新」中的 GitHub 仓库填写为 `owner/repo` 格式，且对应仓库已发布 Release。
- **国内检查更新慢或超时？**
  「设置 → 程序更新 → 程序更新源」默认为**自动（测速优选）**：客户端会并发探测 GitHub 与
  CNB 镜像的清单响应时间并选用最快可用的一方，国内网络通常自动命中 CNB 镜像（cnb.cool），
  无需代理；也可手动固定为「CNB 国内镜像」。详见 [`docs/cnb-mirror.md`](docs/cnb-mirror.md)。
- **更新内核后工作台提示 `dsh web authentication required; reopen the URL printed by dsh web.`？**
  新版内核为 Web UI 增加了 browser-auth：访问必须使用启动时打印的**带 token URL** 兑换签名 cookie，
  直接访问裸地址会被 401 拒绝。客户端已自动接管该流程（捕获并加载认证 URL），请升级客户端到最新版本。
- **macOS 更新失败，提示 `Code signature ... did not pass validation`？**
  macOS 的自动安装依赖 Squirrel ShipIt 的代码签名校验，而本项目未使用 Apple 开发者证书
  （只能 ad-hoc 签名，其校验基准是内容哈希，新版本必然不匹配），因此 mac 端改为**引导式手动更新**：
  点击「下载安装包」后安装包会保存到「下载」目录并自动打开，把 `DSH Desktop.app`
  拖入「应用程序」覆盖即可。Windows 端不受影响。

## 📄 许可证

[MIT](LICENSE)。基于上游项目 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 构建。
