#!/usr/bin/env bash
# 卸载后端登录项（对应 scripts/install-launchagent.sh）
#
# 用法：
#   bash scripts/uninstall-launchagent.sh              关闭开机自启（不影响正在运行的实例）
#   bash scripts/uninstall-launchagent.sh --stop-now   关闭开机自启 + 停掉当前登录项实例
#
# ⚠️ 默认不 bootout 是刻意的：
#    本脚本可能被「正在运行的插件后端」调用（设置页里的开机自启开关）。
#    一旦 bootout，launchd 会当场杀掉发起请求的那个进程，
#    用户看到的是请求中断、后端莫名消失。
#    删除 plist 已足以阻止下次登录自动启动，不需要顺手杀进程。
#    只有「停止服务」这种明确要停的场景才传 --stop-now。

set -uo pipefail

LABEL="com.workassistant.backend"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"
LABEL_TARGET="gui/$UID_NUM/$LABEL"
STOP_NOW=0

for arg in "$@"; do
  case "$arg" in
    --stop-now) STOP_NOW=1 ;;
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

if [[ "$STOP_NOW" == "1" ]]; then
  if launchctl bootout "$LABEL_TARGET" 2>/dev/null; then
    echo "✅ 已停止当前登录项实例"
  else
    echo "ℹ️  登录项未在运行"
  fi
else
  echo "ℹ️  当前运行中的实例不受影响（本操作只阻止下次登录自动启动）"
fi

echo ""
echo "如需彻底移除插件的自动启动能力，再执行："
echo "  bash scripts/uninstall-native-host.sh"
