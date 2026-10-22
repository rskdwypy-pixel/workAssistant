#!/usr/bin/env bash
# 把后端注册为 macOS 登录项，开机自动启动
#
# 为什么还要这个方案：
#   后端是「常驻服务」性质 —— 日报定时任务（早 9:00 / 晚 21:00 / 周五周报）
#   本身就需要后端一直在跑，与是否打开浏览器无关。LaunchAgent 让它开机自启，
#   崩溃自动拉起。插件的「启动服务」（Native Messaging 宿主）在装了登录项时
#   也会交给 launchd 启动，保证后端始终归 launchd 管。
#
# ⚠️ 本脚本可能被「正在运行的插件后端」调用（设置页里的开机自启开关，
#    此时环境变量 WORKASSISTANT_CALLED_FROM_BACKEND=1）。
#    铁律：后端调用时**绝不 bootout** 已加载的 job —— 那会当场杀掉发起请求的进程。

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=common.sh
source "$PROJECT_DIR/scripts/common.sh"

AGENT_DIR="$HOME/Library/LaunchAgents"
PLIST="$AGENT_DIR/$WA_LABEL.plist"
FROM_BACKEND="${WORKASSISTANT_CALLED_FROM_BACKEND:-0}"

# 选定 node 并固化到 .node-path（宿主启动器与 launchd 都不继承 shell 环境）
NODE_BIN="$(wa_resolve_node_for_install || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "❌ 找不到可用的 node（需要 18 及以上版本）。可设置 WORKASSISTANT_NODE=/path/to/node 后重试"
  exit 1
fi
case "$NODE_BIN" in
  */.nvm/*|*/.fnm/*|*/.volta/*|*/.asdf/*|*/n/versions/*)
    echo "⚠️  只找到版本管理器里的 node：$NODE_BIN"
    echo "   卸载或切换该版本后开机自启会失效，建议安装一个固定路径的 node（如 brew install node）后重跑本脚本"
    ;;
esac
echo "$NODE_BIN" > "$PROJECT_DIR/scripts/.node-path"

mkdir -p "$AGENT_DIR"
wa_prepare_log_dir

X_NODE="$(wa_xml_escape "$NODE_BIN")"
X_ENTRY="$(wa_xml_escape "$PROJECT_DIR/src/index.js")"
X_DIR="$(wa_xml_escape "$PROJECT_DIR")"
X_LOG="$(wa_xml_escape "$WA_LOG_FILE")"

NEW_PLIST="$(cat <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$WA_LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>$X_NODE</string>
    <string>$X_ENTRY</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$X_DIR</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>WORKASSISTANT_LAUNCHED_BY</key>
    <string>launchd</string>
    <key>WORKASSISTANT_LOG_FILE</key>
    <string>$X_LOG</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

  <key>StandardOutPath</key>
  <string>$X_LOG</string>

  <key>StandardErrorPath</key>
  <string>$X_LOG</string>

  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
PLIST_EOF
)"

# KeepAlive 用 SuccessfulExit=false 而不是 true 是刻意的：
#   正常退出（插件里点「停止服务」、端口已被本项目后端占用时让位）以 0 退出，不重启；
#   崩溃（非 0 退出）才自动拉起。

OLD_PLIST=""
[[ -f "$PLIST" ]] && OLD_PLIST="$(cat "$PLIST")"
CHANGED=0
[[ "$OLD_PLIST" != "$NEW_PLIST" ]] && CHANGED=1

printf '%s\n' "$NEW_PLIST" > "$PLIST"
echo "✅ 已写入登录项: $PLIST"
echo "   程序: $NODE_BIN $PROJECT_DIR/src/index.js"
echo "   日志: $WA_LOG_FILE"
echo ""

UID_NUM="$(id -u)"
LABEL_TARGET="gui/$UID_NUM/$WA_LABEL"

# 清掉可能存在的 disable 覆盖（上次「关闭开机自启」留下的）
launchctl enable "$LABEL_TARGET" 2>/dev/null || true

if launchctl print "$LABEL_TARGET" >/dev/null 2>&1; then
  if [[ "$CHANGED" == "1" ]]; then
    # launchd 只在 bootstrap 时读取 plist；只改文件不重载，新配置要等到下次登录才生效
    if [[ "$FROM_BACKEND" == "1" ]]; then
      echo "ℹ️  登录项配置已更新，将在下次「重启服务」或重新登录后生效"
    else
      echo "🔄 登录项配置有变化，重新加载..."
      launchctl bootout "$LABEL_TARGET" 2>/dev/null || true
      # bootout 是异步的，等 job 真正卸载后再 bootstrap
      for _ in $(seq 1 20); do
        launchctl print "$LABEL_TARGET" >/dev/null 2>&1 || break
        sleep 0.25
      done
      if launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null; then
        echo "✅ 已按新配置重新加载（后端已由 launchd 重启）"
      else
        echo "⚠️  重新加载失败，可手动执行：launchctl bootstrap gui/$UID_NUM $PLIST"
      fi
    fi
  else
    echo "ℹ️  登录项已加载且配置未变，无需重复加载"
  fi
else
  # 端口被占时也要 bootstrap：新实例检测到本项目后端已在服务会以 0 让位退出，
  # KeepAlive(SuccessfulExit=false) 不会重启它；job 注册进 launchd，下次登录接管。
  if launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null; then
    if wa_backend_alive; then
      echo "✅ 登录项已注册并加载（端口 $WA_PORT 已有后端在服务，新实例会让位退出）"
    else
      echo "✅ 已启动登录项（立即生效）"
    fi
  else
    echo "⚠️  自动加载失败，可稍后手动执行：launchctl bootstrap gui/$UID_NUM $PLIST"
  fi
fi

echo ""
echo "常用命令："
echo "  查看状态: launchctl print gui/$UID_NUM/$WA_LABEL"
echo "  重启服务: launchctl kickstart -k gui/$UID_NUM/$WA_LABEL"
echo "  卸载:    bash scripts/uninstall-launchagent.sh"
