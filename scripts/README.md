# scripts —— 辅助脚本

| 脚本 | 用法 | 功能 |
|------|------|------|
| `gen-icons.js` | `node scripts/gen-icons.js [源图]` | 从源图生成全套应用图标：PNG 多尺寸（16~1024）、Windows ICO（7 尺寸）、macOS ICNS（7 尺寸），输出到 `build/icons/` |
| `fetch-kernel.js` | `node scripts/fetch-kernel.js [version]` | 打包前预下载 dsh 内核到 `vendor/kernel`（含 `bundle-info.json` 版本信息），打包进安装包；支持 `DSH_KERNEL_VERSION` 环境变量指定版本 |
| `fetch-node.js` | `node scripts/fetch-node.js [version]` | 打包前预下载便携版 Node.js 到 `vendor/node`，打入安装包作为内置运行时；支持 `DSH_NODE_VERSION` 环境变量指定版本 |
| `check-env.js` | `node scripts/check-env.js` | 检测 Node.js / npm 版本与可用性，输出是否满足 dsh 要求（v18+） |
| `build.js` | `node scripts/build.js` | 语法检查所有 JS 源文件、校验 package.json，并提示打包命令 |
| `_verify.test.js` | `node scripts/_verify.test.js` | 核心逻辑回归验证（semver、内核信息、环境检测、远端检查、内置内核导入、程序更新版本比较），共 26 项断言 |
| `cnb-mirror-release.sh` | `bash scripts/cnb-mirror-release.sh <tag>` | **CNB 国内镜像发布**：在 CNB 流水线中运行——创建 CNB Release（版本化 + `latest` 通道）、从 GitHub Release 拉取双平台产物、生成 latest 通道清单 |
| `cnb-rewrite-manifest.js` | `node scripts/cnb-rewrite-manifest.js <tag> <distDir> <slug>` | 把 `latest.yml` / `latest-mac.yml` 中的 `url` 改写为指向版本化 Release 的绝对地址，使 `latest` 通道只需存放两个小清单 |

## 打包前置

`npm run pack:*` 会自动先执行 `fetch-kernel.js`（通过 `npm run fetch-kernel && electron-builder`），确保安装包包含最新内置内核。

## 依赖

- 仅 Node.js 内置模块，无第三方依赖。

## 注意事项

- Windows 下子命令执行使用 `shell: true`（兼容 `npm.cmd`）。
- `build.js` 的语法检查使用 `new Function(...)` 包装，仅验证语法不执行代码。
