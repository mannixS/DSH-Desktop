# resources —— 打包资源目录

存放 electron-builder 打包所需的静态资源（图标等）。

## 约定

- 可选目录，构建时通过 `electron-builder.yml` 的 `buildResources` 引用。
- 建议放置：
  - `icon.ico`（Windows 图标）
  - `icon.icns`（macOS 图标）
- 当前为空目录（`npm start` 开发模式不依赖图标资源）。
