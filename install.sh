#!/bin/bash
# 工作助手全局命令安装脚本

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# 获取脚本所在目录（项目目录）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$HOME/bin"

echo ""
echo "========================================="
echo "  安装工作助手全局命令"
echo "========================================="
echo ""
echo "项目目录: $SCRIPT_DIR"

# 检查项目目录
if [ ! -f "$SCRIPT_DIR/start.sh" ]; then
    echo -e "${RED}错误: 找不到 start.sh${NC}"
    echo "请确保在项目根目录下运行此脚本"
    exit 1
fi

# 1. 创建 ~/bin 目录
if [ ! -d "$BIN_DIR" ]; then
    echo -e "${YELLOW}创建 $BIN_DIR 目录...${NC}"
    mkdir -p "$BIN_DIR"
fi

# 2. 检查/添加 PATH
if ! echo "$PATH" | grep -q "$BIN_DIR"; then
    echo -e "${YELLOW}添加 $BIN_DIR 到 PATH...${NC}"

    if [ -f "$HOME/.zshrc" ]; then
        SHELL_RC="$HOME/.zshrc"
    else
        SHELL_RC="$HOME/.bashrc"
    fi

    echo "" >> "$SHELL_RC"
    echo "# 工作助手 bin 目录" >> "$SHELL_RC"
    echo "export PATH=\"$BIN_DIR:\$PATH\"" >> "$SHELL_RC"
    echo -e "${GREEN}✓ 已添加到 $SHELL_RC${NC}"
    echo -e "${YELLOW}请执行: source $SHELL_RC${NC}"
else
    echo -e "${GREEN}✓ $BIN_DIR 已在 PATH 中${NC}"
fi

# 3. 创建命令文件
echo ""
echo "创建命令脚本..."

# wa - 启动命令
cat > "$BIN_DIR/wa" << EOF
#!/bin/bash
cd "$SCRIPT_DIR" && exec ./start.sh "\$@"
EOF

# wastop - 停止命令
cat > "$BIN_DIR/wastop" << EOF
#!/bin/bash
cd "$SCRIPT_DIR" && exec ./stop.sh "\$@"
EOF

# 设置执行权限
chmod +x "$BIN_DIR/wa" "$BIN_DIR/wastop"

echo ""
echo -e "${GREEN}✓ 安装成功!${NC}"
echo ""
echo "现在你可以在任何位置使用："
echo ""
echo -e "  ${GREEN}wa${NC}           # 启动服务"
echo -e "  ${GREEN}wastop${NC}        # 停止服务"
echo ""
echo -e "${YELLOW}注意: 如果 PATH 未生效，请执行: source ~/.zshrc${NC}"
echo ""
