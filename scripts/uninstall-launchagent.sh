#!/usr/bin/env bash
# 卸载后端登录项（对应 scripts/install-launchagent.sh）
#
# 用法：
#   bash scripts/uninstall-launchagent.sh                关闭开机自启，并从 launchd 卸载 job
#   bash scripts/uninstall-launchagent.sh --keep-running 关闭开机自启，但保留当前运行的后端
#
# 卸载 job（bootout）会停掉由 launchd 管理的后端实例：只删 plist 的话 job 仍留在 launchd 里，
# 本次登录期间崩溃了还会被 KeepAlive 拉起来，等于没关干净。
#
# ⚠️ 被正在运行的插件后端调用时（WORKASSISTANT_CALLED_FROM_BACKEND=1）绝不 bootout：
#    那会当场杀掉发起请求的进程。后端在「停止服务并停用自启」时会紧接着以 0 正常退出，
#    KeepAlive(SuccessfulExit=false) 不会再拉起它。

set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=common.sh
source "$PROJECT_DIR/scripts/common.sh"

PLIST="$HOME/Library/LaunchAgents/$WA_LABEL.plist"
UID_NUM="$(id -u)"
LABEL_TARGET="gui/$UID_NUM/$WA_LABEL"
KEEP_RUNNING=0
[[ "${WORKASSISTANT_CALLED_FROM_BACKEND:-0}" == "1" ]] && KEEP_RUNNING=1

for arg in "$@"; do
  case "$arg" in
    --keep-running) KEEP_RUNNING=1 ;;
    # 兼容旧参数：现在默认就会停止
    --stop-now) ;;
  esac
done

# 打上 disable 覆盖：即便 plist 之后被别的途径放回来，登录时也不会加载。
# install-launchagent.sh 会在安装时用 launchctl enable 清掉这个标记。
if launchctl disable "$LABEL_TARGET" 2>/dev/null; then
  echo "✅ 已标记为禁用（登录时不再加载）"
else
  echo "ℹ️  未能写入禁用标记（系统不支持或权限不足），仅删除配置文件"
fi

if [[ -f "$PLIST" ]]; then
  rm -f "$PLIST"
  echo "✅ 已删除 $PLIST"
else
  echo "ℹ️  未找到 $PLIST"
fi

if [[ "$KEEP_RUNNING" == "1" ]]; then
  echo "ℹ️  当前运行中的实例不受影响"
elif launchctl bootout "$LABEL_TARGET" 2>/dev/null; then
  echo "✅ 已从 launchd 卸载（由 launchd 启动的后端实例已停止，需要时可在插件中点「启动服务」）"
else
  echo "ℹ️  launchd 中没有已加载的登录项"
fi

echo ""
echo "如需彻底移除插件的自动启动能力，再执行："
echo "  bash scripts/uninstall-native-host.sh"
