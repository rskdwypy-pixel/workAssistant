#!/usr/bin/env bash
# 卸载后端登录项（对应 scripts/install-launchagent.sh）

set -uo pipefail

LABEL="com.workassistant.backend"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null; then
  echo "✅ 已停止登录项"
else
  echo "ℹ️  登录项未在运行"
fi

if [[ -f "$PLIST" ]]; then
  rm -f "$PLIST"
  echo "✅ 已删除 $PLIST"
else
  echo "ℹ️  未找到 $PLIST"
fi

echo ""
echo "如需彻底移除插件的自动启动能力，再执行："
echo "  bash scripts/uninstall-native-host.sh"