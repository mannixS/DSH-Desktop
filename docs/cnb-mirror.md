# CNB（cnb.cool）国内镜像发布

本项目同时发布到 **GitHub Releases** 与 **CNB Releases（cnb.cool）**：
GitHub 负责构建与主发布，CNB 提供国内高速下载通道，客户端会并发测速并择优。

## 架构

| 阶段 | 负责方 | 说明 |
|------|--------|------|
| 构建 | GitHub Actions | 双平台（Windows / macOS）构建并产出安装包 |
| 主发布 | GitHub Actions | 创建 GitHub Release（全部产物 + `latest.yml` / `latest-mac.yml`） |
| 同步 | GitHub Actions | 推送 `main` 与 tag 到 CNB，触发 CNB 流水线 |
| 国内发布 | CNB 流水线（`.cnb.yml`） | 创建 CNB Release，拉取 GitHub 产物并上传（版本化 + `latest` 通道） |
| 客户端 | — | 并发探测两源清单响应时间，优选最快可用源 |

> **为什么不在 CNB 上构建安装包**
> CNB 的构建节点以 Docker 容器（Linux）为环境，而 electron-builder 无法在 Linux 上
> 交叉产出可用的 macOS 包。为保证 `latest.yml` / `latest-mac.yml` 中的 sha512 与实际
> 产物严格一致，双平台构建统一在 GitHub Actions 完成，CNB 专注「国内发布与分发」。

## CNB Release 结构

每次发布产出两个 Release：

| Release | 内容 | 用途 |
|---------|------|------|
| `vX.Y.Z` | 全量产物（exe / dmg / zip / blockmap / 清单） | 版本化下载、人工安装 |
| `latest` | 仅 `latest.yml` / `latest-mac.yml` | 客户端用固定 URL 检查更新 |

`latest` 通道里的清单已由 `scripts/cnb-rewrite-manifest.js` 把 `url` 改写为指向 `vX.Y.Z`
的**绝对地址**，因此安装包只需上传一次（否则 `latest` 通道也要再存一份上百 MB 的产物）。

客户端使用的更新源地址（generic provider 的目录形式，**末尾 `/` 必需**）：

```
https://cnb.cool/<owner>/<repo>/-/releases/download/latest/
```

## 首次接入步骤

### 1. 在 CNB 创建仓库

登录 <https://cnb.cool> → 新建仓库 `DSH-Desktop`（路径建议与 GitHub 一致，如 `mannixS/DSH-Desktop`）。
也可用 CNB 的 **CODE IMPORT** 从 GitHub 一键导入，或用 **GIT SYNC** 插件做持续同步。

### 2. 创建 CNB 访问令牌

CNB →「个人设置 → 访问令牌」→ 新建，勾选 **repo-contents 读写** 权限，复制令牌。

### 3. 在 GitHub 配置 Actions 凭据

仓库 →「Settings → Secrets and variables → Actions」新增：

| 名称 | 推荐位置 | 示例值 | 用途 |
|------|----------|--------|------|
| `CNB_TOKEN` | **Repository secrets** | （第 2 步复制的令牌） | 推送代码/标签到 CNB |
| `CNB_REPO` | **Repository variables** 或 secrets | `mannixS/DSH-Desktop` | CNB 仓库路径 |

- 两者放在 **Repository 级别**即可（`sync-cnb` 会同时读取 secrets 与 variables）；
- `CNB_REPO` 只是仓库路径、并非敏感信息，放 **Variables** 更规范；
- ⚠️ **不要配置在 environment 中**：本 workflow 未声明 `environment`，配在那里取不到值；
- 未配置时 `sync-cnb` 会**自动跳过**，并在日志中以 `::warning::` 指出具体缺少哪一项，不影响 GitHub 侧发布。

### 3.1 补同步已发布的历史版本

若某个 tag 发布时凭据尚未配好（CNB 侧缺产物），**无需重新发版**：

1. 打开仓库 Actions → 左侧选「Build & Release」→ 右侧 **Run workflow**；
2. 分支选 `main`，在 **sync_tag** 输入框填写要补同步的标签（如 `v1.0.29`）；
3. 运行后只执行 `sync-cnb`（构建与 GitHub Release 步骤会因条件不满足而跳过），
   把该 tag 推到 CNB，由 CNB 流水线完成国内镜像发布。

### 4. 推送标签触发发布

```bash
git push origin main
git push origin v1.0.30
```

流程：GitHub Actions 构建 → 发布 GitHub Release → 同步 `main` 与 tag 到 CNB →
CNB 流水线（`.cnb.yml` 的 `tag_push`）拉取产物 → 创建 `v1.0.30` 与 `latest` Release 并上传附件。

### 5. 客户端配置（可选）

默认「自动（测速优选）」即可，无需配置。如需固定源：
「设置 → 程序更新 → 程序更新源」选择 **CNB 国内镜像**；
「CNB 镜像仓库」留空时自动沿用 GitHub 仓库路径。

## 相关文件

| 文件 | 作用 |
|------|------|
| `.cnb.yml` | CNB 流水线定义（`tag_push` 触发） |
| `scripts/cnb-mirror-release.sh` | 创建 CNB Release、拉取 GitHub 产物、生成 latest 通道清单 |
| `scripts/cnb-rewrite-manifest.js` | 把清单中的 `url` 改写为绝对地址 |
| `.github/workflows/build-release.yml` | 构建、GitHub Release、同步到 CNB（`sync-cnb` job） |

## 排障

| 现象 | 排查方向 |
|------|----------|
| CNB 流水线未触发 | `sync-cnb` job 是否成功；`CNB_TOKEN` / `CNB_REPO` 是否配置（**放 Repository 级别，不要放 environment**）；CNB 仓库是否存在该 tag |
| 日志提示「缺少配置: CNB_TOKEN / CNB_REPO」 | 按 warning 提示补齐凭据；`CNB_REPO` 放 Variables 亦可（`sync-cnb` 两者都读）；补齐后用 **Run workflow + sync_tag** 补同步，无需重新发版 |
| 拉取 GitHub 产物失败 | GitHub Release 是否已发布完成；可在 CNB 上重跑流水线；配置 `GITHUB_TOKEN` 避免 API 限流 |
| 上传附件报「tag 不存在对应 release」 | `cnb-mirror-release.sh` 第 1 步创建 Release 是否成功（检查 CNB_TOKEN 权限） |
| 客户端仍走 GitHub | 更新源模式是否为「自动」；CNB 仓库路径是否正确；CNB 上是否已生成 `latest` 通道 |
