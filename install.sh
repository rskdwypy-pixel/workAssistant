#!/bin/bash
# 工作助手一键安装脚本（Mac/Linux）
# 执行此脚本后，只需加载插件并启动后端服务即可使用

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

# 获取脚本所在目录（项目目录）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo ""
echo -e "${BOLD}========================================"
echo -e "  🚀 工作助手 - 一键安装向导"
echo -e "========================================${NC}"
echo ""
echo -e "${BLUE}项目目录:${NC} $SCRIPT_DIR"
echo ""

# 检测操作系统
if [[ "$OSTYPE" == "darwin"* ]]; then
    OS="Mac"
    SHELL_RC="$HOME/.zshrc"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    OS="Linux"
    SHELL_RC="$HOME/.bashrc"
else
    echo -e "${RED}❌ 不支持的操作系统: $OSTYPE${NC}"
    echo "仅支持 Mac 和 Linux 系统"
    echo "Windows 用户请运行 install.bat"
    exit 1
fi

echo -e "${GREEN}✓ 检测到操作系统: $OS${NC}"

# ==================== 步骤1: 环境检查 ====================
echo ""
echo -e "${BOLD}[1/6]${NC} 检查运行环境..."

# 检查 Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ 未安装 Node.js${NC}"
    echo ""
    echo "请先安装 Node.js:"
    echo ""
    if [[ "$OS" == "Mac" ]]; then
        echo "  方式1 (推荐): 使用 Homebrew"
        echo "    /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
        echo ""
        echo "  方式2: 官方网站下载"
        echo "    https://nodejs.org/"
    else
        echo "  使用包管理器安装:"
        echo "    sudo apt install nodejs"
        echo "    sudo yum install nodejs"
    fi
    echo ""
    echo "安装后请重新运行此脚本"
    exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 14 ]; then
    echo -e "${YELLOW}⚠️  Node.js 版本较低 ($NODE_VERSION)，建议升级到 18+${NC}"
fi
echo -e "${GREEN}✓ Node.js 版本: $(node -v)${NC}"

# 检查 npm
if ! command -v npm &> /dev/null; then
    echo -e "${RED}❌ npm 未安装${NC}"
    exit 1
fi
echo -e "${GREEN}✓ npm 版本: $(npm -v)${NC}"

# 检查 git
if command -v git &> /dev/null; then
    echo -e "${GREEN}✓ Git 已安装: $(git --version)${NC}"
else
    echo -e "${YELLOW}⚠️  Git 未安装（可选，不影响使用）${NC}"
fi

# ==================== 步骤2: 安装依赖 ====================
echo ""
echo -e "${BOLD}[2/6]${NC} 安装项目依赖..."

if [ ! -d "node_modules" ]; then
    echo "正在安装 npm 依赖..."
    npm install
    echo -e "${GREEN}✓ 依赖安装完成${NC}"
else
    echo -e "${GREEN}✓ 依赖已安装${NC}"
fi

# ==================== 步骤3: 配置文件 ====================
echo ""
echo -e "${BOLD}[3/6]${NC} 配置环境文件..."

if [ ! -f ".env" ]; then
    echo "创建 .env 配置文件..."
    cp .env.example .env

    # 检查配置文件是否已配置
    if ! grep -q "your_api_key_here" .env && \
       ! grep -q "ZENTAO_URL=" .env && \
       ! grep -q "ZENTAO_USERNAME=" .env; then
        # 配置文件还是默认状态，不需要手动配置
        echo -e "${GREEN}✓ 配置文件已创建${NC}"
    else
        echo -e "${YELLOW}⚠️  配置文件已创建${NC}"
        echo ""
        echo -e "${YELLOW}⚙️  请编辑 .env 文件，配置以下信息：${NC}"
        echo ""
        echo "  1. AI 配置（必须）"
        echo "     - OPENAI_API_KEY: 你的AI API密钥"
        echo "     - OPENAI_BASE_URL: API基础URL"
        echo ""
        echo "  2. 禅道配置（可选）"
        echo "     - ZENTAO_URL: 禅道地址"
        echo "     - ZENTAO_USERNAME: 用户名"
        echo "     - ZENTAO_PASSWORD: 密码"
        echo ""
        echo -e "${RED}⚠️  配置完成后，重新运行此脚本${NC}"
        exit 1
    fi
else
    echo -e "${GREEN}✓ 配置文件已存在${NC}"
fi

# ==================== 步骤4: 创建数据目录 ====================
echo ""
echo -e "${BOLD}[4/6]${NC} 初始化数据目录..."

mkdir -p data/backups
mkdir -p logs

# 检查 tasks.json
if [ ! -f "data/tasks.json" ]; then
    echo '{"version": "1.0","lastUpdated":null,"tasks":[]}' > data/tasks.json
    echo -e "${GREEN}✓ tasks.json 已创建${NC}"
else
    echo -e "${GREEN}✓ 数据目录已存在${NC}"
fi

# ==================== 步骤5: 安装扩展 ====================
echo ""
echo -e "${BOLD}[5/6]${NC} 安装 Chrome 扩展..."

EXTENSION_PATH="$SCRIPT_DIR/extension"

if [ ! -d "$EXTENSION_PATH" ]; then
    echo -e "${RED}❌ 找不到 extension 目录${NC}"
    exit 1
fi

echo ""
echo -e "${BLUE}📦 Chrome 扩展安装步骤：${NC}"
echo ""
echo "  1. 打开 Chrome 浏览器"
echo "  2. 在地址栏输入: chrome://extensions/"
echo "  3. 开启右上角的「开发者模式」"
echo "  4. 点击「加载已解压的扩展程序」"
echo "  5. 选择文件夹: $EXTENSION_PATH"
echo "  6. 点击「添加扩展程序」"
echo ""
echo -e "${GREEN}✓ 扩展文件准备就绪${NC}"
echo -e "${YELLOW}💡 提示: 加载后可固定扩展图标到工具栏${NC}"
echo ""

# ==================== 步骤6: 启动后端服务 ====================
echo ""
echo -e "${BOLD}[6/6]${NC} 启动后端服务..."

# 检查端口是否被占用
PORT=3721
if lsof -ti :$PORT > /dev/null 2>&1; then
    echo -e "${YELLOW}⚠️  端口 $PORT 已被占用${NC}"
    read -p "是否停止现有服务并启动? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "正在停止现有服务..."
        if [ -f "stop.sh" ]; then
            bash stop.sh
        else
            pkill -f "node.*src/index.js" 2>/dev/null || true
        fi
        sleep 2
    else
        echo -e "${YELLOW}操作已取消${NC}"
        echo ""
        echo -e "${BLUE}💡 如需手动启动服务，请运行: ./start.sh${NC}"
        exit 0
    fi
fi

# 自动启动服务
if [ -f "start.sh" ]; then
    bash start.sh
else
    echo "正在启动服务..."
    nohup npm start > logs/service.log 2>&1 &
    sleep 2

    if ps -p $! > /dev/null; then
        echo -e "${GREEN}✓ 服务启动成功!${NC}"
        echo "   地址: http://localhost:$PORT"
        echo "   日志: logs/service.log"
    else
        echo -e "${RED}❌ 服务启动失败，请查看日志${NC}"
        exit 1
    fi
fi

# ==================== 安装完成 ====================
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  🎉 安装完成！${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${BLUE}📋 后续步骤：${NC}"
echo ""
echo "  1. 确认 Chrome 扩展已加载（参考上面的安装步骤）"
echo "  2. 访问 chrome://extensions/ 固定扩展图标"
echo "  3. 打开新标签页，开始使用工作助手"
echo ""
echo -e "${BLUE}🎯 常用命令：${NC}"
echo ""
echo "  ${GREEN}wa${NC}              - 启动服务"
echo "  ${GREEN}wastop${NC}           - 停止服务"
echo "  ${GREEN}walog${NC}            - 查看日志"
echo ""
echo -e "${BLUE}💡 提示：${NC}"
echo "  - 后端服务已在后台运行，关闭终端不影响"
echo "  - 数据存储在: $SCRIPT_DIR/data"
echo "  - 配置文件: $SCRIPT_DIR/.env"
echo ""
echo -e "${YELLOW}⚠️  注意事项：${NC}"
echo "  - 如需使用 AI 功能，请配置 .env 中的 API 密钥"
echo "  - 如需同步禅道，请配置禅道相关信息"
echo ""
