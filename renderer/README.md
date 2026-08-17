# renderer —— 客户端界面（渲染进程）

原生 HTML/CSS/JS 实现的客户端界面，无前端框架依赖，深色主题。

## 结构

```
renderer/
├── index.html    # 四个视图：总览 / dsh 工作台 / 设置 / 运行日志
├── styles.css    # 深色主题样式（CSS 变量驱动）
└── renderer.js   # 界面逻辑
```

## 视图说明

| 视图 | 功能 |
|------|------|
| 总览 | 内核当前/最新版本对比、检查更新、更新内核、回滚；Node 环境；dsh 进程控制 |
| dsh 工作台 | 内嵌 `<webview>` 加载 dsh Web UI（127.0.0.1:端口） |
| 设置 | 自动检查开关、自动安装、检查间隔、更新通道（latest/stable）、启动模式、端口 |
| 运行日志 | 客户端与 dsh 进程的实时输出 |

## 与主进程通信

- 通过 `window.dshClient`（preload 注入）调用 IPC。
- 订阅事件：`onUpdateAvailable`、`onUpdateInstallStart/Progress/Done/Error`、`onDshLog`。

## 注意事项

- 页面启用 CSP：`default-src 'self'`，脚本不内联（独立 `renderer.js`）。
- `<webview>` 需要在主进程 `webPreferences.webviewTag = true`（已在 main.js 配置）。
- 状态每 15 秒自动同步一次；更新操作过程中按钮会禁用防止重复触发。
