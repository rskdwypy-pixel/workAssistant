#!/usr/bin/env bash
# Native Messaging 宿主启动器
#
 # 由 Chrome 在插件调用 connectNative() 时自动拉起。
 # Chrome 要求宿主必须通过 stdin/stdout 通信（type: stdio），
 # 但 Express 只监听 TCP 端口即可，因此这里把 node 后端放到后台，
 # 然后阻塞等待，保证 Chrome 认为宿主仍在运行。
#
 # 后端本身不读写 stdio，日志写到 backend.log，避免污染宿主协议通道。

set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${WORKASSISTANT_PORT:-3721}"
LOG_FILE="/tmp/workassistant-backend.log"

# node 路径查找顺序：
#   1. install-native-host.sh 生成的 .node-path 文件（安装时固化，不依赖环境变量）
#   2. 环境变量 WORKASSISTANT_NODE（手动调试时可用）
#   3. PATH 中的 node
#
# 说明：Chrome 启动宿主时不继承用户 shell 的环境变量，
# 因此不能只靠 WORKASSISTANT_NODE，必须在安装时把路径落盘。
NODE_BIN=""
if [[ -f "$PROJECT_DIR/scripts/.node-path" ]]; then
  NODE_BIN="$(cat "$PROJECT_DIR/scripts/.node-path")"
fi
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  NODE_BIN="${WORKASSISTANT_NODE:-$(command -v node || true)}"
fi

if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "workassistant-backend: 找不到 node 可执行文件" >&2
  echo "  请重新执行 scripts/install-native-host.sh" >&2
  exit 1
fi

# 端口探测：用 bash 内置 /dev/tcp，毫秒级完成。
# 早期实现每次探测都 spawn 一次 node（~100ms 启动开销），
# 20 次轮询的窗口内后端还没起来就误判为失败。
# 环境若不支持 /dev/tcp（如 sh 而非 bash）则退回 node 探测。
is_port_in_use() {
  local port="$1"
  if (: < /dev/tcp/127.0.0.1/"$port") 2>/dev/null; then
    return 0
  fi
  "$NODE_BIN" -e "
    const net=require('net');
    const s=net.connect({host:'127.0.0.1',port:$port},()=>{s.destroy();process.exit(0)});
    s.on('error',()=>process.exit(1));
    s.setTimeout(1000,()=>{s.destroy();process.exit(1)});
  " 2>/dev/null
}

if is_port_in_use "$PORT"; then
  echo "workassistant-backend: 端口 $PORT 已被占用，复用现有后端" >&2
else
  cd "$PROJECT_DIR"
  nohup "$NODE_BIN" src/index.js >> "$LOG_FILE" 2>&1 &
  BACKEND_PID=$!

  # 给后端启动留足时间（首次启动要加载配置与用户列表，约需 2-3 秒）
  READY=0
  for _ in $(seq 1 60); do
    if is_port_in_use "$PORT"; then
      READY=1
      break
    fi
    # 进程意外退出则不必继续等
    if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
      break
    fi
    sleep 0.25
  done

  if [[ "$READY" != "1" ]]; then
    echo "workassistant-backend: 后端启动失败，详见 $LOG_FILE" >&2
    exit 1
  fi

  echo "workassistant-backend: 已启动 pid=$BACKEND_PID port=$PORT" >&2
fi

# 宿主进程退出时，一并结束后端，避免留下孤儿进程
cleanup() {
  if [[ -n "${BACKEND_PID:-}" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# 阻塞等待：Chrome 认为宿主存活，后端就存活。
# Chrome 结束宿主时会关闭 stdin，用它作为退出信号。
while read -r _ || [[ -n "${_:-}" ]]; do
  :
done