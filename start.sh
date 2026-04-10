#!/bin/bash
# 工作助手启动脚本

cd "$(dirname "$0")"

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}🚀 启动工作助手服务...${NC}"
echo ""

# 项目根目录
PROJECT_DIR="$(pwd)"
PID_FILE="$PROJECT_DIR/.service.pid"
LOG_FILE="$PROJECT_DIR/logs/service.log"

# 创建日志目录
mkdir -p "$(dirname "$LOG_FILE")"

# 检查依赖
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}📦 首次运行，正在安装依赖...${NC}"
    echo -e "${RED}💡 建议: 首次使用请先运行 ./install.sh 完成完整配置${NC}"
    npm install --cache /tmp/npm-cache
fi

# 检查.env配置
if [ ! -f ".env" ]; then
    echo -e "${YELLOW}⚙️  创建配置文件...${NC}"
    cp .env.example .env
    echo -e "${RED}⚠️  请先编辑 .env 文件，配置你的 API Key${NC}"
    echo "   然后重新运行此脚本"
    exit 1
fi

# 检查是否已运行
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if ps -p "$OLD_PID" > /dev/null 2>&1; then
        echo -e "${YELLOW}⚠️  服务已在运行 (PID: $OLD_PID)${NC}"
        read -p "是否重启服务? (y/N): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            echo -e "${YELLOW}🛑 停止旧服务...${NC}"
            kill "$OLD_PID" 2>/dev/null
            sleep 1
            # 强制杀死如果还在运行
            if ps -p "$OLD_PID" > /dev/null 2>&1; then
                kill -9 "$OLD_PID" 2>/dev/null
            fi
        else
            echo "操作已取消"
            exit 0
        fi
    fi
fi

# 清理可能存在的旧进程（通过端口查找）
PORT=3721
OLD_PORT_PIDS=$(lsof -ti :$PORT 2>/dev/null)
if [ -n "$OLD_PORT_PIDS" ]; then
    PID_STR=$(echo $OLD_PORT_PIDS | tr '\n' ' ')
    echo -e "${YELLOW}🛑 发现端口 $PORT 被占用 (PID: $PID_STR)，正在清理...${NC}"
    for PID in $OLD_PORT_PIDS; do
        kill $PID 2>/dev/null
    done
    sleep 1
    REMAIN_PIDS=$(lsof -ti :$PORT 2>/dev/null)
    if [ -n "$REMAIN_PIDS" ]; then
        for PID in $REMAIN_PIDS; do
            kill -9 $PID 2>/dev/null
        done
    fi
fi

# 启动服务（使用 nohup 后台运行）
echo -e "${GREEN}✅ 启动服务...${NC}"
nohup npm start >> "$LOG_FILE" 2>&1 &
SERVICE_PID=$!

# 保存 PID
echo "$SERVICE_PID" > "$PID_FILE"

# 等待服务启动
sleep 2

# 检查服务是否启动成功
if ps -p "$SERVICE_PID" > /dev/null 2>&1; then
    echo -e "${GREEN}✅ 服务启动成功！${NC}"
    echo "   PID: $SERVICE_PID"
    echo "   地址: http://localhost:$PORT"
    echo "   日志: $LOG_FILE"
    echo ""
    echo -e "${GREEN}📝 查看日志: tail -f $LOG_FILE${NC}"
    echo -e "${GREEN}🛑 停止服务: ./stop.sh${NC}"
    echo ""
    echo "服务将在后台持续运行，关闭终端不会影响服务。"
else
    echo -e "${RED}❌ 服务启动失败，请查看日志: $LOG_FILE${NC}"
    rm -f "$PID_FILE"
    exit 1
fi
