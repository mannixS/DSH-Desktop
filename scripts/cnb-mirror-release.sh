#!/usr/bin/env bash
# ============================================================================
# cnb-mirror-release.sh
# 把 GitHub Release 的双平台产物镜像到 CNB（cnb.cool）Release，形成国内分发通道。
#
# 用法：bash scripts/cnb-mirror-release.sh <tag>
#
# 环境变量：
#   CNB_TOKEN          CNB 访问令牌（流水线内为平台自动注入的临时令牌），用于创建 Release
#   CNB_REPO_SLUG      当前 CNB 仓库路径（如 owner/DSH-Desktop），流水线自动注入
#   CNB_API_ENDPOINT   CNB OpenAPI 地址，默认 https://api.cnb.cool
#   GH_REPO            GitHub 仓库（owner/repo），默认 mannixS/DSH-Desktop
#   GITHUB_TOKEN       可选：拉取 GitHub Release 时避免 API 限流
#
# 产出：
#   dist/                 版本化产物（exe / dmg / zip / blockmap / latest*.yml）
#   dist/latest-channel/  latest 通道清单（url 已改写为指向该 tag 的绝对下载地址）
# ============================================================================
set -euo pipefail

TAG="${1:?用法: bash scripts/cnb-mirror-release.sh <tag>}"
GH_REPO="${GH_REPO:-mannixS/DSH-Desktop}"
API="${CNB_API_ENDPOINT:-https://api.cnb.cool}"
SLUG="${CNB_REPO_SLUG:?缺少 CNB_REPO_SLUG（应在 CNB 流水线中运行）}"
OUT="dist"
LATEST_DIR="${OUT}/latest-channel"

mkdir -p "$OUT" "$LATEST_DIR"

echo "==> 1/3 确保 CNB Release 存在：${TAG} 与 latest"
for t in "$TAG" latest; do
  code=$(curl -s -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer ${CNB_TOKEN}" \
    "${API}/${SLUG}/-/releases/tags/${t}" || echo 000)
  if [ "$code" = "200" ]; then
    echo "    - ${t} 已存在"
  else
    echo "    - 创建 ${t}"
    curl -sS -X POST \
      -H "Authorization: Bearer ${CNB_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "{\"tag_name\":\"${t}\",\"name\":\"DSH Desktop ${t}\"}" \
      "${API}/${SLUG}/-/releases" > /dev/null
  fi
done

echo "==> 2/3 从 GitHub Release 拉取产物：${GH_REPO}@${TAG}"
CURL_ARGS=(-fsSL --retry 3 --retry-delay 5)
if [ -n "${GITHUB_TOKEN:-}" ]; then
  CURL_ARGS+=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
fi

release_json=$(curl "${CURL_ARGS[@]}" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${GH_REPO}/releases/tags/${TAG}")

urls=$(printf '%s' "$release_json" \
  | grep -o '"browser_download_url":[[:space:]]*"[^"]*"' \
  | sed 's/.*"\(http[^"]*\)"/\1/')
if [ -z "$urls" ]; then
  echo "!! 未获取到 GitHub Release 产物列表（tag=${TAG}），请确认 GitHub 侧已发布完成" >&2
  exit 1
fi

for url in $urls; do
  file="${url##*/}"
  case "$file" in
    *.exe|*.dmg|*.zip|*.blockmap|latest.yml|latest-mac.yml)
      echo "    - ${file}"
      curl "${CURL_ARGS[@]}" -o "${OUT}/${file}" "$url"
      ;;
    *)
      echo "    - 跳过 ${file}"
      ;;
  esac
done

echo "==> 3/3 生成 latest 通道清单（url 指向 ${TAG} 的绝对地址）"
node scripts/cnb-rewrite-manifest.js "$TAG" "$OUT" "$SLUG"

echo "==> 产物清单"
ls -lh "$OUT" "$LATEST_DIR"
echo "==> 镜像准备完成"
