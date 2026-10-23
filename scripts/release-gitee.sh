#!/usr/bin/env bash
#
# 在本机把一次发版同步到 Gitee（国内网络直连 Gitee，比 GitHub 的海外机器上传稳）：
#
#   npm run release:gitee            # 同步最新的版本标签
#   npm run release:gitee -- v1.4.1  # 同步指定版本
#
# 做三件事：
#   1. 把这个版本的代码（该标签对应的提交作为 main，加上标签本身）推到 Gitee 仓库——Gitee 的 release 要挂在存在的标签上，标签得指向对的提交；
#   2. 从 GitHub Release 下载这个版本的全部产物（GitHub 先发布成功才有）；
#   3. 在 Gitee 建 release 并上传附件（已经传过的跳过，可以反复运行），最后验证下载地址。
#
# 需要：gh（已登录）、node、Gitee 私人令牌（发行版权限）。令牌放环境变量 GITEE_TOKEN，
# 或放在 ~/.config/workassistant/gitee-token（只有自己可读）。令牌不会写进仓库，也不会出现在日志里。
set -euo pipefail

GITHUB_REPO="${GITHUB_REPO:-rskdwypy-pixel/workAssistant}"
GITEE_REPO="${GITEE_REPO:-iTreeNewBee/work-assistant}"
GITEE_USER="${GITEE_REPO%%/*}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

die() { echo "✗ $*" >&2; exit 1; }
say() { echo "▶ $*"; }

TAG="${1:-$(git describe --tags --abbrev=0 2>/dev/null || true)}"
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "版本标签不对：'${TAG}'（应形如 v1.4.1）"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || die "本地没有标签 $TAG"

TOKEN="${GITEE_TOKEN:-}"
if [[ -z "$TOKEN" && -f "$HOME/.config/workassistant/gitee-token" ]]; then
  TOKEN="$(tr -d '[:space:]' < "$HOME/.config/workassistant/gitee-token")"
fi
[[ -n "$TOKEN" ]] || die "缺少 Gitee 令牌：设置环境变量 GITEE_TOKEN，或写入 ~/.config/workassistant/gitee-token（chmod 600）"
command -v gh >/dev/null || die "需要 gh（GitHub 命令行）"

say "版本 $TAG → Gitee ($GITEE_REPO)"

# 1. 推代码和标签。令牌通过请求头传，不放在地址里（不会写进 .git/config 或日志）
AUTH="Authorization: Basic $(printf '%s:%s' "$GITEE_USER" "$TOKEN" | base64 | tr -d '\n')"
GITEE_URL="https://gitee.com/$GITEE_REPO.git"
push() { git -c "http.extraHeader=$AUTH" push "$GITEE_URL" "$@" 2>&1 | sed "s#$TOKEN#***#g"; return "${PIPESTATUS[0]}"; }
say "把 $TAG 对应的提交推成 Gitee 的 main（只推已发布的代码，本地还没发版的提交不会过去）"
push "$TAG^{commit}:refs/heads/main" || die "推送 main 失败（Gitee 的 main 不是 $TAG 的祖先？先看看那边是不是有别的提交）"
say "推送标签 $TAG 到 Gitee（以本地为准，覆盖 Gitee 上指向别处的同名标签）"
push "+refs/tags/$TAG:refs/tags/$TAG" || die "推送标签失败"

# 2. 下载 GitHub 上的产物
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
say "从 GitHub Release 下载产物"
gh release download "$TAG" --repo "$GITHUB_REPO" --dir "$TMP" || die "GitHub 上还没有 $TAG 的 Release（先等 GitHub Actions 发布完成）"

# 3. 建 release + 传附件
say "在 Gitee 发布 release 并上传附件"
GITEE_TOKEN="$TOKEN" GITEE_REPO="$GITEE_REPO" GITEE_BRANCH=main node scripts/publish-gitee.mjs "$TAG" "$TMP"

# 4. 验证：安装器和自动更新实际会请求的地址
say "验证下载地址"
for f in workassistant.tar.gz workassistant.tar.gz.sha256 workassistant.tar.gz.sig install.sh install.ps1; do
  code="$(curl -s -L -o /dev/null -w '%{http_code}' -m 60 "https://gitee.com/$GITEE_REPO/releases/download/$TAG/$f" || true)"
  [[ "$code" == "200" ]] && echo "  ✓ $f" || die "$f 下载返回 HTTP $code"
done
echo "✓ 完成：https://gitee.com/$GITEE_REPO/releases/tag/$TAG"
