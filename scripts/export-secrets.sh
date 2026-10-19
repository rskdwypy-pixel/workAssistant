#!/usr/bin/env bash
#
# 本机私密配置的加密导出 / 导入。
#
# 背景：仓库 rskdwypy-pixel/workAssistant 是公开仓库（PUBLIC，匿名可读），
# 所以 .env（含 AI Key、禅道密码）绝不能明文提交，否则任何人都能取走，
# 且 git 历史一旦写入就无法真正删除（克隆/缓存/Fork 都会留存）。
#
# 本脚本的取舍：
#   把 .env 用口令加密成 secrets.env.enc 提交到仓库，换机后一条命令还原。
#   这样满足「换机拉取即可用、免重新配置」，同时不把明文密钥暴露在公开网络上。
#
# 口令强度是你唯一的安全边界，请用与其他账号不同的口令。
# 口令遗失 = 密钥无法还原（只能重新配置）。
#
# 用法：
#   导出：./scripts/export-secrets.sh <口令>
#   导入：./scripts/import-secrets.sh <口令>
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

ENV_FILE="${PROJECT_DIR}/.env"
ENC_FILE="${PROJECT_DIR}/secrets.env.enc"

# 用 AES-256-CBC + PBKDF2(20万次)。openssl 在 macOS/Linux 上都是系统自带。
CIPHER="aes-256-cbc"
PBKDF2_ITER=200000

usage() {
  cat <<EOF
用法：
  $(basename "$0") export   # 把 .env 加密成 secrets.env.enc，供入库
  $(basename "$0") import   # 在新机器解密还原 .env

说明：
  口令交互式输入（不回显），不要作为命令行参数传，以免留在 shell 历史里。
  导出后请自行 git add ${ENC_FILE#"${PROJECT_DIR}/"} 并提交。
  口令请单独记在密码管理器里，不要和 GitHub 账号密码复用。
EOF
}

# 合法子命令校验。注意不能写成 [ $# -ge 1 ]：正常调用 `./export-secrets.sh export`
# 的 $# 就是 1，会被误判为「没给子命令」。
case "${1:-}" in
  export|import) ;;
  *) usage; exit 1 ;;
esac

if ! command -v openssl >/dev/null 2>&1; then
  echo "❌ 未找到 openssl，无法加解密。请先安装 openssl。" >&2
  exit 1
fi

read_passphrase() {
  # 关闭回显，避免口令显示在屏幕上
  local p1 p2
  while true; do
    printf "请输入口令: " >&2
    read -rs p1
    printf "\n" >&2
    [ -z "$p1" ] && { echo "口令不能为空" >&2; continue; }

    printf "请再输入一次确认: " >&2
    read -rs p2
    printf "\n" >&2
    if [ "$p1" = "$p2" ]; then
      # 立刻交给 openssl 用（WA_PASS 是约定名），随后清空，避免口令留在内存变量里
      export WA_PASS="$p1"
      unset p1 p2
      return 0
    fi
    echo "两次输入不一致，请重试" >&2
  done
}

export_secrets() {
  if [ ! -f "$ENV_FILE" ]; then
    echo "❌ 没找到 ${ENV_FILE}，请先运行 install.sh 完成配置。" >&2
    exit 1
  fi

  read_passphrase
  echo "正在加密 ${ENV_FILE#"${PROJECT_DIR}/"} ..."
  openssl enc -"${CIPHER}" -salt -pbkdf2 -iter "${PBKDF2_ITER}" \
    -in "$ENV_FILE" -out "$ENC_FILE" -pass env:WA_PASS
  chmod 600 "$ENC_FILE"

  echo "✅ 已生成 ${ENC_FILE#"${PROJECT_DIR}/"}"
  echo ""
  echo "下一步："
  echo "  1. git add ${ENC_FILE#"${PROJECT_DIR}/"}"
  echo "  2. git commit -m 'chore: 更新加密配置'"
  echo "  3. git push"
  echo ""
  echo "换机后执行： ./scripts/import-secrets.sh"
}

import_secrets() {
  if [ ! -f "$ENC_FILE" ]; then
    echo "❌ 没找到 ${ENC_FILE}，请确认已拉取最新代码。" >&2
    exit 1
  fi

  if [ -f "$ENV_FILE" ]; then
    echo "⚠️  ${ENV_FILE#"${PROJECT_DIR}/"} 已存在，导入会覆盖它。"
    read -rp "确认覆盖? [y/N]: " ok
    [ "$ok" = "y" ] || [ "$ok" = "Y" ] || { echo "已取消。"; exit 0; }
    cp "$ENV_FILE" "${ENV_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
    echo "已备份原文件。"
  fi

  read_passphrase
  echo "正在解密 ..."
  if ! openssl enc -d -"${CIPHER}" -pbkdf2 -iter "${PBKDF2_ITER}" \
       -in "$ENC_FILE" -out "$ENV_FILE" -pass env:WA_PASS 2>/dev/null; then
    rm -f "$ENV_FILE"
    echo "❌ 解密失败：口令不正确，或文件已损坏。" >&2
    exit 1
  fi
  chmod 600 "$ENV_FILE"

  echo "✅ 已还原 ${ENV_FILE#"${PROJECT_DIR}/"}"
  echo ""
  echo "还需完成（这些与机器相关，无法随代码迁移）："
  echo "  1. npm install"
  echo "  2. 装扩展：浏览器扩展页加载 extension/ 目录"
  echo "  3. npm run setup:auto-start   （注册开机自启与 Native Messaging）"
  echo "  4. 扩展 ID 因安装路径而异，需按新 ID 重新生成 NativeMessagingHosts"
  echo "     清单里的 allowed_origins"
}

case "${1:-}" in
  export) export_secrets ;;
  import) import_secrets ;;
  *) usage; exit 1 ;;
esac