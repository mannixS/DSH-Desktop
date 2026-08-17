# src —— Electron 主进程与预加载脚本

本目录存放 Electron 主进程源码与渲染进程预加载桥。

## 结构

```
src/
├── main/          # 主进程模块（见 src/main/README.md）
└── preload.js     # 安全 IPC 桥：通过 contextBridge 暴露白名单 API 给渲染进程
```

## 依赖

- Electron（devDependencies）
- Node.js 内置模块（child_process / fs / path 等）

## 注意事项

- 主进程使用 CommonJS 模块（Electron 默认）。
- `preload.js` 开启了 `contextIsolation`，渲染进程无法直接访问 Node API，只能使用 `window.dshClient` 暴露的接口。
- 所有动态数据（内核、dsh 数据、设置）存放在 `app.getPath('userData')` 下，避免与打包的 asar 冲突。
