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
#
# ⚠️ 本脚本可能被「正在运行的插件后端」调用（设置页里的开机自启开关），
#    因此有一条铁律：**绝不无条件 bootout 自己的 job**。
#    无条件 bootout 会当场杀掉发起请求的那个进程，用户看到的是连接中断。
#    下面所有 launchctl 操作都遵守这一点。

set -euo pipefail

LABEL="com.workassistant.backend"
AGENT_DIR="$HOME/Library/LaunchAgents"
PLIST="$AGENT_DIR/$LABEL.plist"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${WORKASSISTANT_PORT:-3721}"

# node 路径查找顺序（与 install-native-host.sh / backend-launcher.sh 保持一致）：
#   1. scripts/.node-path —— 安装时落盘，不依赖 shell 环境
#   2. WORKASSISTANT_NODE 环境变量
#   3. PATH 中的 node
#
# 注意：本脚本被 launchd 或插件后端调用时都没有用户 shell 环境，
# 所以「安装时落盘」这条不能省。
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
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>

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
echo "   策略: 登录自启 + 异常退出自动重启（KeepAlive.SuccessfulExit=false）"
echo ""

# ─────────────────────────────────────────────────────────────
# 加载（让 launchd 认识它）
#
# KeepAlive 用 SuccessfulExit=false 而不是 true 是刻意的：
#   端口被占时 src/index.js 会以 0 正常退出，
#   若用 KeepAlive=true，launchd 会不停重启它，形成崩溃重启死循环。
#   SuccessfulExit=false 只对「异常退出」重启 —— 崩溃照样能恢复，
#   正常让位则安静退出。
# ─────────────────────────────────────────────────────────────
UID_NUM="$(id -u)"
LABEL_TARGET="gui/$UID_NUM/$LABEL"

port_in_use() {
  (: < /dev/tcp/127.0.0.1/"$1") 2>/dev/null
}

# 清掉可能存在的 disable 覆盖（上次「关闭开机自启」留下的）
launchctl enable "$LABEL_TARGET" 2>/dev/null || true

if launchctl print "$LABEL_TARGET" >/dev/null 2>&1; then
  echo "ℹ️  登录项已加载（launchd 已认识它），无需重复启动"
else
  # 端口被占时**也要** bootstrap。
  #
  # 早期实现是「端口被占 → 跳过 bootstrap，只留 plist」，理由是避免两个实例
  # 抢端口。但那会得到一个非常误导人的中间状态：文件在、launchd 里却没有这个
  # job —— `launchctl print` 查不到（Bad request / Could not find service），
  # 系统设置「通用 → 登录项与扩展 → 允许在后台」里也不会出现，
  # 用户看到的现象就是「开关说是开了，可系统里什么都没有」。
  #
  # 直接 bootstrap 是安全的：
  #   · 第二个实例绑端口失败 → src/index.js 里 EADDRINUSE 分支以 0 正常退出
  #   · KeepAlive 是 SuccessfulExit=false → 正常退出不会触发重启，没有死循环
  #   · 定时任务挂在 listen 成功回调里 → 让位的实例不会多跑一份调度
  # 最终状态正好是我们要的：job 已注册进 launchd、此刻未运行，下次登录接管。
  if launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null; then
    if port_in_use "$PORT"; then
      echo "✅ 登录项已注册并加载（端口 $PORT 已有后端在服务，新实例会让位退出）"
      echo "   下一次登录将由 launchd 自动启动后端"
    else
      echo "✅ 已启动登录项（立即生效）"
    fi
  else
    echo "⚠️  自动加载失败，可稍后手动执行：launchctl bootstrap gui/$UID_NUM $PLIST"
  fi
fi

echo ""
echo "常用命令："
echo "  查看状态: launchctl print gui/$UID_NUM/$LABEL"
echo "  立即停止: launchctl bootout gui/$UID_NUM/$LABEL"
echo "  卸载:    bash scripts/uninstall-launchagent.sh"
