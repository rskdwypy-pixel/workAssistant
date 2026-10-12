#!/usr/bin/env bash
# 把后端注册为 macOS 登录项，开机自动启动
#
# 为什么还要这个方案：
#   Chrome Native Messaging 是插件按需拉起后端的官方通道，但它要求
#   1) 一次性把宿主注册文件写到浏览器读取的目录（扩展沙箱外，必须手动执行一次）
#   2) Chrome 后续需要重启才识别新宿主
#   而本插件的后端是「常驻服务」性质 —— 日报定时任务（早 9:00 / 晚 21:00 /
#   周五周报）本身就需要后端一直在跑，与是否打开标签页无关。
#
#   因此用 LaunchAgent 让它开机自启，是更贴合实际使用场景的方案：
#   装一次，之后完全无感，既满足定时任务，也不依赖插件是否打开。
#
#   两者可共存：LaunchAgent 保证常驻，Native Messaging 负责异常退出后的按需重启。

set -euo pipefail

LABEL="com.workassistant.backend"
AGENT_DIR="$HOME/Library/LaunchAgents"
PLIST="$AGENT_DIR/$LABEL.plist"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

NODE_BIN=""
if [[ -f "$PROJECT_DIR/scripts/.node-path" ]]; then
  NODE_BIN="$(cat "$PROJECT_DIR/scripts/.node-path")"
fi
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  NODE_BIN="${WORKASSISTANT_NODE:-$(command -v node || true)}"
fi

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "❌ 找不到 node，请先执行 scripts/install-native-host.sh 或设置 WORKASSISTANT_NODE"
  exit 1
fi

mkdir -p "$AGENT_DIR"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$PROJECT_DIR/src/index.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/tmp/workassistant-backend.log</string>

  <key>StandardErrorPath</key>
  <string>/tmp/workassistant-backend.log</string>

  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
PLIST_EOF

echo "✅ 已写入登录项: $PLIST"
echo "   程序: $NODE_BIN $PROJECT_DIR/src/index.js"
echo "   策略: 登录自启 + 崩溃自动重启（KeepAlive）"
echo ""

# 立即加载（无需注销重登）
if command -v launchctl >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
    echo "✅ 已启动登录项（立即生效）"
  else
    echo "⚠️  自动加载失败，可稍后手动执行：launchctl bootstrap gui/$(id -u) $PLIST"
  fi
fi

echo ""
echo "常用命令："
echo "  查看状态: launchctl list | grep $LABEL"
echo "  立即停止: launchctl bootout gui/\$(id -u)/$LABEL"
echo "  卸载:    bash scripts/uninstall-launchagent.sh"