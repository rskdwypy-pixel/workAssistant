#!/bin/bash
# 工作助手停止脚本

cd "$(dirname "$0")"

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

PROJECT_DIR="$(pwd)"
PID_FILE="$PROJECT_DIR/.service.pid"
PORT=3721

echo -e "${YELLOW}🛑 停止工作助手服务...${NC}"

STOPPED=0

# 方式1: 通过 PID 文件停止
if [ -f "$PID_FILE" ]; then
    SAVED_PID=$(cat "$PID_FILE")
    if ps -p "$SAVED_PID" > /dev/null 2>&1; then
        echo "正在停止服务 (PID: $SAVED_PID)..."
        kill "$SAVED_PID" 2>/dev/null
        sleep 1

        # 检查是否还在运行
        if ps -p "$SAVED_PID" > /dev/null 2>&1; then
            echo -e "${YELLOW}强制停止服务...${NC}"
            kill -9 "$SAVED_PID" 2>/dev/null
        fi
        STOPPED=1
    fi
    rm -f "$PID_FILE"
fi

# 方式2: 通过端口查找并停止
PORT_PID=$(lsof -ti :$PORT 2>/dev/null)
if [ -n "$PORT_PID" ]; then
    echo "发现端口 $PORT 被占用 (PID: $PORT_PID)，正在停止..."
    kill "$PORT_PID" 2>/dev/null
    sleep 1

    # 检查是否还在运行
    if lsof -ti :$PORT >/dev/null 2>&1; then
        echo -e "${YELLOW}强制停止...${NC}"
        kill -9 "$PORT_PID" 2>/dev/null
    fi
    STOPPED=1
fi

# 方式3: 通过进程名查找（兜底）
NODE_PIDS=$(pgrep -f "node.*src/index.js" 2>/dev/null)
if [ -n "$NODE_PIDS" ]; then
    echo "发现相关进程: $NODE_PIDS"
    for PID in $NODE_PIDS; do
        # 确认是当前目录的进程
        if lsof -p "$PID" 2>/dev/null | grep -q "$(pwd)"; then
            echo "停止进程 $PID..."
            kill "$PID" 2>/dev/null
        fi
    done
    sleep 1
    STOPPED=1
fi

if [ $STOPPED -eq 1 ]; then
    # 确认所有相关进程都已停止
    sleep 1
    REMAINING=$(lsof -ti :$PORT 2>/dev/null)
    if [ -n "$REMAINING" ]; then
        echo -e "${RED}⚠️  端口仍被占用，尝试最后清理...${NC}"
        kill -9 "$REMAINING" 2>/dev/null
    fi
    echo -e "${GREEN}✅ 服务已停止${NC}"
else
    echo -e "${YELLOW}ℹ️  没有发现运行中的服务${NC}"
fi
