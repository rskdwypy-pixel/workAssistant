#!/usr/bin/env bash
# 移除 Native Messaging 宿主注册（对应 scripts/install-native-host.sh）
#
# 不依赖浏览器的识别表，直接全盘扫描 Application Support 下所有
# NativeMessagingHosts 目录，删掉其中的 com.workassistant.backend.json。
# 这样即便将来新增了浏览器、或装过又删了，本脚本也能清干净。

set -uo pipefail

HOST_NAME="com.workassistant.backend"
APP_SUPPORT="$HOME/Library/Application Support"

if [[ ! -d "$APP_SUPPORT" ]]; then
  echo "✅ 无需清理（$APP_SUPPORT 不存在）"
  exit 0
fi

# 扫描 Application Support 下所有 NativeMessagingHosts 目录（限定深度 4 层）。
# 注意两点：
#   1. 不要用无 maxdepth 的全盘 find —— Application Support 下可能有
#      大型缓存目录（Codex / OpenAI 等），全盘遍历会卡住数分钟甚至被系统终止。
#   2. 深度必须够：浏览器目录结构深浅不一 ——
#        Helium:  net.imput.helium/NativeMessagingHosts/x.json          → 3 层
#        Mozilla: Mozilla/NativeMessagingHosts/x.json                  → 3 层
#        Chrome:  Google/Chrome/NativeMessagingHosts/x.json             → 4 层
#      用 -maxdepth 3 会漏掉 Chrome / Edge / Brave / Arc 这类两级目录。
#
# macOS 的 find 支持 -print0，read -d '' 逐个处理（路径含空格安全）
REMOVED=0
while IFS= read -r -d '' f; do
  rm -f "$f"
  rel="${f#$APP_SUPPORT/}"
  rel="${rel%/NativeMessagingHosts/$HOST_NAME.json}"
  echo "  ✅ 已移除: $rel"
  REMOVED=$((REMOVED + 1))
done < <(find "$APP_SUPPORT" -maxdepth 4 -type f -name "$HOST_NAME.json" \
  -path "*/NativeMessagingHosts/*" -print0 2>/dev/null)

if [[ $REMOVED -eq 0 ]]; then
  echo "  （未找到已注册的宿主文件）"
else
  echo ""
  echo "✅ 共移除 $REMOVED 处"
fi

echo ""
echo "登录项请另用 scripts/uninstall-launchagent.sh 移除"
