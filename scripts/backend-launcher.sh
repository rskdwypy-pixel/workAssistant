#!/usr/bin/env bash
# Native Messaging 宿主启动器
#
# 由浏览器在插件调用 connectNative() 时自动拉起，职责只有一个：确保后端在跑，然后退出。
#
#   1. 后端已在跑            → 回报 ready，退出
#   2. 装了开机自启（LaunchAgent）→ 交给 launchd 启动（kickstart / bootstrap），
#                                 后端归 launchd 管，崩溃自动拉起、不随浏览器退出
#   3. 否则                  → 以独立会话（setsid）后台启动 node，脱离浏览器进程组
#   4. 等端口就绪后按 Native Messaging 协议回报 {type:"ready"}，失败回报 {type:"error"}
#
# 旧实现的问题（见 docs/AUDIT-2026-10-21.md C2/C4/C5）：
#   - 从不回报 ready，插件每次都要等满 6 秒超时
#   - 宿主阻塞在 cat 上常驻，退出时顺手杀掉后端 → 后端跟着浏览器生死，晚间日报丢失
#   - 并发拉起时多个宿主进程永久挂着
#
# 协议约束：stdout 是给浏览器的消息通道，只能写 Native Messaging 帧；诊断信息一律写 stderr。

set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=common.sh
source "$PROJECT_DIR/scripts/common.sh"

NODE_BIN="$(wa_resolve_node_for_run "$PROJECT_DIR" || true)"
# 安装版：数据与配置在 WorkAssistant/data（与程序分开）
if WA_HOME="$(wa_install_home "$PROJECT_DIR")"; then
  export WA_HOME WA_DATA_DIR="$WA_HOME/data"
fi

# 按 Native Messaging 协议写一条消息：4 字节小端长度 + UTF-8 JSON
send_message() {
  local json="$1"
  if [[ -n "$NODE_BIN" ]]; then
    "$NODE_BIN" -e '
      const b = Buffer.from(process.argv[1], "utf8");
      const h = Buffer.alloc(4);
      h.writeUInt32LE(b.length, 0);
      process.stdout.write(Buffer.concat([h, b]));
    ' "$json"
  fi
}

fail() {
  echo "workassistant-backend: $1" >&2
  # 引号与反斜杠转义，保证 JSON 合法
  local msg="${1//\\/\\\\}"
  msg="${msg//\"/\\\"}"
  send_message "{\"type\":\"error\",\"reason\":\"$msg\"}"
  exit 1
}

if wa_backend_alive; then
  echo "workassistant-backend: 后端已在运行，复用" >&2
  send_message '{"type":"ready","reused":true}'
  exit 0
fi

[[ -n "$NODE_BIN" ]] || fail "找不到可用的 node（需要 18 及以上版本），请重新运行一次安装命令"

wa_prepare_log_dir
PLIST="$HOME/Library/LaunchAgents/$WA_LABEL.plist"
UID_NUM="$(id -u)"
STARTED_BY=""

if [[ -f "$PLIST" ]]; then
  # 开机自启已安装：由 launchd 启动，后端生命周期与浏览器无关
  if launchctl print "gui/$UID_NUM/$WA_LABEL" >/dev/null 2>&1; then
    launchctl kickstart "gui/$UID_NUM/$WA_LABEL" >/dev/null 2>&1 && STARTED_BY="launchd"
  else
    launchctl bootstrap "gui/$UID_NUM" "$PLIST" >/dev/null 2>&1 && STARTED_BY="launchd"
  fi
fi

if [[ -z "$STARTED_BY" ]]; then
  # 未装开机自启（或 launchd 拒绝）：用 node 以 detached 方式启动，进入新会话，
  # 浏览器结束宿主进程组时不会波及后端
  WORKASSISTANT_LAUNCHED_BY=native WORKASSISTANT_LOG_FILE="$WA_LOG_FILE" \
  "$NODE_BIN" -e '
    const { spawn } = require("child_process");
    const fs = require("fs");
    const [nodeBin, projectDir, logFile] = process.argv.slice(1);
    const fd = fs.openSync(logFile, "a", 0o600);
    spawn(nodeBin, ["src/index.js"], {
      cwd: projectDir,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: process.env
    }).unref();
  ' "$NODE_BIN" "$PROJECT_DIR" "$WA_LOG_FILE" || fail "启动 node 失败"
  STARTED_BY="native"
fi

# 等后端就绪（首次启动需加载配置，一般 1~3 秒）
for _ in $(seq 1 60); do
  if wa_backend_alive; then
    echo "workassistant-backend: 已启动（${STARTED_BY}） port=$WA_PORT" >&2
    send_message "{\"type\":\"ready\",\"startedBy\":\"$STARTED_BY\"}"
    exit 0
  fi
  sleep 0.25
done

fail "后端 15 秒内未就绪，详见日志 $WA_LOG_FILE"
