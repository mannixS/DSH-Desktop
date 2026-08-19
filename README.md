# DSH Desktop

**DeepSeek Harness（dsh）跨平台桌面客户端** —— 把 dsh 装进一个开箱即用的桌面应用，安装即用，无需配置 Node.js 等任何环境。

支持 Windows 10/11 x64 与 macOS 12+（Apple Silicon / Intel）。

---

## ✨ 功能特性

- 🚀 **开箱即用**：安装包内置 dsh 内核与 Node.js 运行时，安装后自动导入并启动服务，无需联网下载、无需预装环境
- 🖥️ **全屏工作台**：内嵌 dsh Web 界面，服务就绪后自动呈现；启动全程有加载提示，不黑屏、不闪白
- 🎨 **主题跟随**：客户端外观自动跟随 dsh 的深/浅色切换，也可在设置中固定深色、浅色或跟随系统
- 🔄 **内核管理**：一键检查、更新、回滚 dsh 内核；支持 latest（含 RC）/ stable（仅正式版）双通道与定时自动检查
- ⬆️ **程序自更新**：检测到新版本自动下载，点一下「安装并重启」即可升级客户端自身
- 📊 **实时状态**：底部状态栏随时显示服务运行状态、进程 PID 与端口；启动 / 停止 / 重启一键操作
- 📜 **运行日志**：客户端与 dsh 的完整输出实时滚动展示，支持一键复制，方便排查问题
- 🧹 **退出不残留**：关闭客户端时自动结束 dsh 及其全部子进程，不占用端口、不留后台进程

## 📥 下载安装

从 [Releases](https://github.com/mannixS/DSH-Desktop/releases) 页面下载对应平台的安装包：

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| Windows x64 | `DSH-Desktop-<版本>-win-x64.exe` | 双击安装（NSIS 安装向导） |
| macOS Apple Silicon | `DSH-Desktop-<版本>-mac-arm64.zip` | 解压后拖入「应用程序」 |
| macOS Intel | `DSH-Desktop-<版本>-mac-x64.zip` | 解压后拖入「应用程序」 |

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

## 📄 许可证

[MIT](LICENSE)。基于上游项目 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 构建。
