#!/usr/bin/env bash
# 注册 Native Messaging 宿主，让 Chrome 在插件请求时自动拉起后端
#
# 背景：Chrome MV3 扩展无法直接启动本地进程（无 child_process、service worker
# 会被回收）。Chrome 官方的解决方案是 Native Messaging：
# 插件调用 chrome.runtime.connectNative() 时，Chrome 会自动启动这里注册的宿主进程。
#
# 本脚本只需执行一次。Chrome 只会授予「已注册宿主」启动权限，这一步无法由插件自身完成
# （该目录在扩展沙箱之外），因此必须由用户在终端执行一次。

set -euo pipefail

HOST_NAME="com.workassistant.backend"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${WORKASSISTANT_NODE:-$(command -v node || true)}"

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "❌ 找不到 node 可执行文件"
  echo "   请先安装 Node.js，或用环境变量指定："
  echo "   WORKASSISTANT_NODE=/path/to/node bash scripts/install-native-host.sh"
  exit 1
fi

LAUNCHER="$PROJECT_DIR/scripts/backend-launcher.sh"

if [[ ! -f "$LAUNCHER" ]]; then
  echo "❌ 找不到启动器: $LAUNCHER"
  exit 1
fi

chmod +x "$LAUNCHER"

# 固化 node 路径：Chrome 启动宿主时不继承 shell 环境变量，
# 启动器必须能从文件读到 node 的绝对路径。
echo "$NODE_BIN" > "$PROJECT_DIR/scripts/.node-path"
echo "  已固化 node 路径: $NODE_BIN"

install_host() {
  local app_support_rel="$1"
  local browser_name="$2"
  local browser_dir="$HOME/Library/Application Support/$app_support_rel/NativeMessagingHosts"

  mkdir -p "$browser_dir"

  cat > "$browser_dir/$HOST_NAME.json" <<JSON
{
  "name": "$HOST_NAME",
  "description": "工作助手本地后端服务",
  "path": "$LAUNCHER",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://hceiphnkbdcloohaeinpmoiolpomlegi/",
    "chrome-extension://*/"
  ]
}
JSON

  echo "  ✅ $browser_name"
}

echo "════════════════════════════════════════════"
echo "  工作助手 · 后端自动启动宿主注册"
echo "════════════════════════════════════════════"
echo "  项目目录: $PROJECT_DIR"
echo "  Node:     $NODE_BIN"
echo ""
echo "  注册到以下浏览器（Chrome 按产品名读取不同目录）："

# Chrome 按「产品名」决定读取哪个目录，不同发行版路径不同：
#   Google Chrome              → Google/Chrome
#   Google Chrome for Testing  → Google/Chrome for Testing
#   Chromium                   → Chromium
# 一次注册到全部常见位置，避免换浏览器后又失效。
install_host "Google/Chrome" "Google Chrome"
install_host "Google/Chrome for Testing" "Google Chrome for Testing"
install_host "Google/Chrome Beta" "Google Chrome Beta"
install_host "Google/Chrome Canary" "Google Chrome Canary"
install_host "Chromium" "Chromium"
install_host "Microsoft Edge" "Microsoft Edge"

echo ""
echo "✅ 注册完成"
echo ""
echo "接下来："
echo "  1. 在 chrome://extensions 重新加载插件"
echo "  2. 打开新标签页，后端会自动在 127.0.0.1:3721 启动"
echo ""
echo "启动/停止：插件「设置 → 本地服务」里有「启动服务 / 停止服务」按钮"
echo "命令行停止：pkill -f 'node src/index.js'"