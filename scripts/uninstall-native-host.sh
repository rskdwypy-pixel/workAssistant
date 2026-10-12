#!/usr/bin/env bash
# 移除 Native Messaging 宿主注册（对应 scripts/install-native-host.sh）

set -uo pipefail

HOST_NAME="com.workassistant.backend"

for rel in "Google/Chrome" "Google/Chrome for Testing" "Google/Chrome Beta" \
           "Google/Chrome Canary" "Google/Chrome-headless" "Chromium" "Microsoft Edge"; do
  f="$HOME/Library/Application Support/$rel/NativeMessagingHosts/$HOST_NAME.json"
  if [[ -f "$f" ]]; then
    rm -f "$f"
    echo "  ✅ 已移除: $rel"
  fi
done

echo "✅ 完成（登录项请另用 scripts/uninstall-launchagent.sh）"
