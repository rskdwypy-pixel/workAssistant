#!/bin/bash
# 工作助手一键安装脚本（Mac/Linux）
# 执行此脚本后，只需加载插件并启动后端服务即可使用
# 创建全局命令：wa、wastop、walog

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# 获取脚本所在目录（项目目录）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo ""
echo -e "${BOLD}========================================"
echo -e "  🚀 工作助手 - 一键安装向导 v2.0"
echo -e "========================================${NC}"
echo ""
echo -e "${BLUE}项目目录:${NC} $SCRIPT_DIR"
echo ""

# 交互式输入函数
prompt_input() {
    local prompt_text="$1"
    local default_value="$2"
    local result_var="$3"

    if [ -n "$default_value" ]; then
        echo -n "${CYAN}$prompt_text [$default_value]: ${NC}"
    else
        echo -n "${CYAN}$prompt_text: ${NC}"
    fi

    read -r input
    if [ -z "$input" ] && [ -n "$default_value" ]; then
        input="$default_value"
    fi

    eval "$result_var='$input'"
}

# 验证 API Key 函数
validate_api_key() {
    local api_key="$1"
    if [ -z "$api_key" ]; then
        return 1
    fi
    # 基本长度验证
    if [ ${#api_key} -lt 10 ]; then
        return 1
    fi
    return 0
}

# 测试 AI 连接
test_ai_connection() {
    local api_key="$1"
    local base_url="$2"
    local model="$3"

    echo -e "${YELLOW}正在测试 AI 连接...${NC}"

    # 使用 curl 测试 API
    local response=$(curl -s -X POST "$base_url/chat/completions" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $api_key" \
        -d '{
            "model": "'"$model"'",
            "messages": [{"role": "user", "content": "test"}],
            "max_tokens": 1
        }' 2>&1)

    # 检查是否包含错误
    if echo "$response" | grep -q "error\|401\|403\|500"; then
        return 1
    fi

    return 0
}

# 验证 URL 格式
validate_url() {
    local url="$1"
    if [[ $url =~ ^https?://[a-zA-Z0-9.-]+(:[0-9]+)?(/.*)?$ ]]; then
        return 0
    fi
    return 1
}

# 测试禅道连接
test_zentao_connection() {
    local url="$1"
    local username="$2"
    local password="$3"

    echo -e "${YELLOW}正在测试禅道连接...${NC}"

    # 标准化 URL（去除末尾斜杠）
    url="${url%/}"

    # 测试禅道是否可访问
    local test_url="${url}/zentao/user-login.html"

    # 先测试网络连通性
    local http_code=$(curl -s -o /dev/null -w "%{http_code}" "$test_url" 2>&1)

    if [ "$http_code" = "000" ]; then
        echo -e "${RED}❌ 无法连接到禅道服务器${NC}"
        echo -e "${YELLOW}   请检查：${NC}"
        echo -e "${YELLOW}   1. 禅道地址是否正确${NC}"
        echo -e "${YELLOW}   2. 网络连接是否正常${NC}"
        echo -e "${YELLOW}   3. 禅道服务是否正在运行${NC}"
        return 1
    fi

    if [[ ! "$http_code" =~ ^2[0-9]{2}$ ]] && [ "$http_code" != "000" ]; then
        echo -e "${YELLOW}⚠️  禅道服务器返回异常状态码: $http_code${NC}"
        echo -e "${YELLOW}   但配置已保存，请稍后手动测试${NC}"
        return 0  # 不阻止安装，只是警告
    fi

    echo -e "${GREEN}✓ 禅道服务器可访问${NC}"

    # 尝试登录测试（如果提供了用户名和密码）
    if [ -n "$username" ] && [ -n "$password" ]; then
        echo -e "${YELLOW}正在测试禅道登录...${NC}"

        # 尝试登录
        local login_response=$(curl -s -c /tmp/zentao_cookies.txt -X POST \
            "${url}/zentao/user-login.html" \
            -H "Content-Type: application/x-www-form-urlencoded" \
            -d "account=${username}&password=${password}" \
            -L 2>&1)

        # 检查是否登录成功（通过查找重定向或成功标志）
        if echo "$login_response" | grep -q "zentao/my\|zentao/index"; then
            echo -e "${GREEN}✓ 禅道登录成功！${NC}"
            rm -f /tmp/zentao_cookies.txt
            return 0
        else
            echo -e "${YELLOW}⚠️  禅道登录测试失败${NC}"
            echo -e "${YELLOW}   可能原因：${NC}"
            echo -e "${YELLOW}   1. 用户名或密码错误${NC}"
            echo -e "${YELLOW}   2. 禅道版本不兼容${NC}"
            echo -e "${YELLOW}   但配置已保存，请稍后在扩展中手动测试${NC}"
            rm -f /tmp/zentao_cookies.txt
            return 0  # 不阻止安装
        fi
    fi

    return 0
}

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
echo -e "${BOLD}[1/9]${NC} 检查运行环境..."

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
echo -e "${BOLD}[2/9]${NC} 安装项目依赖..."

if [ ! -d "node_modules" ]; then
    echo "正在安装 npm 依赖..."
    npm install

    if [ $? -ne 0 ]; then
        echo -e "${RED}❌ 依赖安装失败${NC}"
        echo ""
        echo "可能的原因："
        echo "  1. 网络连接问题"
        echo "  2. npm registry 访问受限"
        echo "  3. Node.js 版本过低"
        echo ""
        echo "解决方案："
        echo "  1. 检查网络连接"
        echo "  2. 使用淘宝镜像: npm config set registry https://registry.npmmirror.com"
        echo "  3. 清理缓存重试: npm cache clean --force && npm install"
        exit 1
    fi
    echo -e "${GREEN}✓ 依赖安装完成${NC}"
else
    echo -e "${GREEN}✓ 依赖目录已存在${NC}"
fi

# 验证关键依赖是否正确安装
echo ""
echo "验证关键依赖..."
CRITICAL_DEPS=("express" "cors" "dotenv" "uuid")
MISSING_DEPS=()

for dep in "${CRITICAL_DEPS[@]}"; do
    if [ ! -d "node_modules/$dep" ]; then
        MISSING_DEPS+=("$dep")
    fi
done

if [ ${#MISSING_DEPS[@]} -gt 0 ]; then
    echo -e "${YELLOW}⚠️  检测到关键依赖缺失: ${MISSING_DEPS[*]}${NC}"
    echo "正在重新安装依赖..."
    rm -rf node_modules package-lock.json
    npm install

    if [ $? -ne 0 ]; then
        echo -e "${RED}❌ 依赖重新安装失败${NC}"
        echo ""
        echo "手动安装步骤："
        echo "  1. 清理缓存: npm cache clean --force"
        echo "  2. 删除依赖: rm -rf node_modules package-lock.json"
        echo "  3. 重新安装: npm install"
        echo ""
        echo "如果仍然失败，请尝试："
        echo "  - 使用淘宝镜像: npm config set registry https://registry.npmmirror.com"
        echo "  - 检查 Node.js 版本: node -v (需要 >= 14.0.0)"
        exit 1
    fi
fi

echo -e "${GREEN}✓ 关键依赖验证通过${NC}"

# ==================== 步骤3: 配置文件 ====================
echo ""
echo -e "${BOLD}[3/9]${NC} 配置环境文件..."

if [ ! -f ".env" ]; then
    echo "创建 .env 配置文件..."
    cp .env.example .env
    echo -e "${GREEN}✓ 配置文件已创建${NC}"

    # 交互式配置 AI
    echo ""
    echo -e "${BOLD}🤖 AI 配置（必须）${NC}"
    echo ""
    echo "请选择 AI 服务商："
    echo "  1. 智谱 AI（推荐，国内可用，有免费额度）"
    echo "  2. OpenAI 官方"
    echo "  3. 自定义中转服务"
    echo ""

    read -p "${CYAN}请输入选项 [1-3，默认 1]: ${NC}" ai_choice
    ai_choice=${ai_choice:-1}

    API_KEY=""
    BASE_URL=""
    MODEL=""

    case $ai_choice in
        1)
            # 智谱 AI
            echo ""
            echo -e "${BLUE}智谱 AI 配置${NC}"
            echo "获取 API Key: https://open.bigmodel.cn/"
            echo ""

            while true; do
                prompt_input "请输入智谱 API Key" "" API_KEY
                if validate_api_key "$API_KEY"; then
                    break
                fi
                echo -e "${RED}❌ API Key 无效，请重新输入${NC}"
            done

            BASE_URL="https://open.bigmodel.cn/api/paas/v4/"
            MODEL="glm-4-flash"
            ;;

        2)
            # OpenAI 官方
            echo ""
            echo -e "${BLUE}OpenAI 官方配置${NC}"
            echo "获取 API Key: https://platform.openai.com/"
            echo ""

            while true; do
                prompt_input "请输入 OpenAI API Key" "" API_KEY
                if validate_api_key "$API_KEY"; then
                    break
                fi
                echo -e "${RED}❌ API Key 无效，请重新输入${NC}"
            done

            BASE_URL="https://api.openai.com/v1"
            MODEL="gpt-4o-mini"
            ;;

        3)
            # 自定义中转
            echo ""
            echo -e "${BLUE}自定义中转服务配置${NC}"
            echo ""

            while true; do
                prompt_input "请输入 API Key" "" API_KEY
                if validate_api_key "$API_KEY"; then
                    break
                fi
                echo -e "${RED}❌ API Key 无效，请重新输入${NC}"
            done

            prompt_input "请输入 API Base URL" "" BASE_URL
            prompt_input "请输入模型名称" "" MODEL
            ;;

        *)
            echo -e "${RED}❌ 无效选项${NC}"
            exit 1
            ;;
    esac

    # 写入配置到 .env
    sed -i.bak "s|^OPENAI_API_KEY=.*|OPENAI_API_KEY=$API_KEY|" .env
    sed -i.bak "s|^OPENAI_BASE_URL=.*|OPENAI_BASE_URL=$BASE_URL|" .env
    sed -i.bak "s|^OPENAI_MODEL=.*|OPENAI_MODEL=$MODEL|" .env
    rm -f .env.bak

    echo ""
    echo -e "${GREEN}✓ AI 配置已保存${NC}"

    # 可选：测试 AI 连接
    read -p "${CYAN}是否测试 AI 连接？[y/N]: ${NC}" test_conn
    if [[ $test_conn =~ ^[Yy]$ ]]; then
        if test_ai_connection "$API_KEY" "$BASE_URL" "$MODEL"; then
            echo -e "${GREEN}✅ AI 连接测试成功！${NC}"
        else
            echo -e "${YELLOW}⚠️  AI 连接测试失败，但配置已保存${NC}"
            echo -e "${YELLOW}   可能原因：网络问题或 API Key 无效${NC}"
        fi
    fi

else
    echo -e "${GREEN}✓ 配置文件已存在${NC}"

    # 检查是否已配置 API Key
    if grep -q "your_zhipu_api_key\|sk-your-api-key" .env 2>/dev/null; then
        echo ""
        echo -e "${YELLOW}⚠️  检测到配置文件使用默认 API Key${NC}"
        read -p "${CYAN}是否现在配置 AI API Key？[y/N]: ${NC}" reconfig

        if [[ $reconfig =~ ^[Yy]$ ]]; then
            # 复用上面的配置逻辑
            echo ""
            echo -e "${BOLD}🤖 AI 配置（必须）${NC}"
            echo ""
            echo "请选择 AI 服务商："
            echo "  1. 智谱 AI（推荐，国内可用，有免费额度）"
            echo "  2. OpenAI 官方"
            echo "  3. 自定义中转服务"
            echo ""

            read -p "${CYAN}请输入选项 [1-3，默认 1]: ${NC}" ai_choice
            ai_choice=${ai_choice:-1}

            API_KEY=""
            BASE_URL=""
            MODEL=""

            case $ai_choice in
                1)
                    echo ""
                    echo -e "${BLUE}智谱 AI 配置${NC}"
                    while true; do
                        prompt_input "请输入智谱 API Key" "" API_KEY
                        if validate_api_key "$API_KEY"; then
                            break
                        fi
                        echo -e "${RED}❌ API Key 无效，请重新输入${NC}"
                    done
                    BASE_URL="https://open.bigmodel.cn/api/paas/v4/"
                    MODEL="glm-4-flash"
                    ;;
                2)
                    echo ""
                    echo -e "${BLUE}OpenAI 官方配置${NC}"
                    while true; do
                        prompt_input "请输入 OpenAI API Key" "" API_KEY
                        if validate_api_key "$API_KEY"; then
                            break
                        fi
                        echo -e "${RED}❌ API Key 无效，请重新输入${NC}"
                    done
                    BASE_URL="https://api.openai.com/v1"
                    MODEL="gpt-4o-mini"
                    ;;
                3)
                    echo ""
                    echo -e "${BLUE}自定义中转服务配置${NC}"
                    while true; do
                        prompt_input "请输入 API Key" "" API_KEY
                        if validate_api_key "$API_KEY"; then
                            break
                        fi
                        echo -e "${RED}❌ API Key 无效，请重新输入${NC}"
                    done
                    prompt_input "请输入 API Base URL" "" BASE_URL
                    prompt_input "请输入模型名称" "" MODEL
                    ;;
            esac

            # 更新配置
            sed -i.bak "s|^OPENAI_API_KEY=.*|OPENAI_API_KEY=$API_KEY|" .env
            sed -i.bak "s|^OPENAI_BASE_URL=.*|OPENAI_BASE_URL=$BASE_URL|" .env
            sed -i.bak "s|^OPENAI_MODEL=.*|OPENAI_MODEL=$MODEL|" .env
            rm -f .env.bak

            echo ""
            echo -e "${GREEN}✓ AI 配置已更新${NC}"
        fi
    fi
fi

# ==================== 步骤4: 创建数据目录 ====================
echo ""
echo -e "${BOLD}[4/9]${NC} 初始化数据目录..."

mkdir -p data/backups
mkdir -p logs

# 检查 tasks.json
if [ ! -f "data/tasks.json" ]; then
    echo '{"version": "1.0","lastUpdated":null,"tasks":[]}' > data/tasks.json
    echo -e "${GREEN}✓ tasks.json 已创建${NC}"
else
    echo -e "${GREEN}✓ 数据目录已存在${NC}"
fi

# ==================== 步骤5: 配置禅道（可选）====================
echo ""
echo -e "${BOLD}[5/9]${NC} 配置禅道（可选）..."
echo ""
echo -e "${CYAN}🐉 禅道集成配置${NC}"
echo "禅道集成可以实现任务和 Bug 的双向同步"
echo ""

read -p "${CYAN}是否配置禅道集成？[y/N]: ${NC}" config_zentao
config_zentao=${config_zentao:-N}

if [[ $config_zentao =~ ^[Yy]$ ]]; then
    echo ""
    echo -e "${BLUE}禅道配置${NC}"
    echo ""

    # 输入禅道地址
    while true; do
        prompt_input "禅道地址" "" ZENTAO_URL
        ZENTAO_URL="${ZENTAO_URL%/}"  # 去除末尾斜杠

        if validate_url "$ZENTAO_URL"; then
            break
        fi
        echo -e "${RED}❌ URL 格式无效，请输入完整的 URL（如 http://10.128.1.8:8088）${NC}"
    done

    # 输入用户名
    prompt_input "禅道用户名" "" ZENTAO_USERNAME
    if [ -z "$ZENTAO_USERNAME" ]; then
        echo -e "${RED}❌ 用户名不能为空${NC}"
        exit 1
    fi

    # 输入密码
    prompt_input "禅道密码" "" ZENTAO_PASSWORD
    if [ -z "$ZENTAO_PASSWORD" ]; then
        echo -e "${RED}❌ 密码不能为空${NC}"
        exit 1
    fi

    # 输入执行 ID
    prompt_input "执行 ID (execution ID)" "" ZENTAO_EXECUTION_ID
    if [ -z "$ZENTAO_EXECUTION_ID" ]; then
        echo -e "${RED}❌ 执行 ID 不能为空${NC}"
        echo -e "${YELLOW}提示: 从禅道任务创建页面的 URL 中获取${NC}"
        echo -e "${YELLOW}如: task-create-167-0-0.html 中的 167${NC}"
        exit 1
    fi

    echo ""
    echo -e "${CYAN}配置摘要：${NC}"
    echo "  禅道地址: $ZENTAO_URL"
    echo "  用户名: $ZENTAO_USERNAME"
    echo "  执行 ID: $ZENTAO_EXECUTION_ID"
    echo ""

    # 测试连接
    read -p "${CYAN}是否测试禅道连接？[Y/n]: ${NC}" test_zentao_conn
    test_zentao_conn=${test_zentao_conn:-Y}

    if [[ $test_zentao_conn =~ ^[Yy]$ ]]; then
        if test_zentao_connection "$ZENTAO_URL" "$ZENTAO_USERNAME" "$ZENTAO_PASSWORD"; then
            echo -e "${GREEN}✅ 禅道连接测试成功！${NC}"
        else
            echo -e "${YELLOW}⚠️  禅道连接测试失败，但配置已保存${NC}"
        fi
    fi

    # 写入配置到 .env
    sed -i.bak "s|^ZENTAO_ENABLED=.*|ZENTAO_ENABLED=true|" .env
    sed -i.bak "s|^ZENTAO_URL=.*|ZENTAO_URL=$ZENTAO_URL|" .env
    sed -i.bak "s|^ZENTAO_USERNAME=.*|ZENTAO_USERNAME=$ZENTAO_USERNAME|" .env
    sed -i.bak "s|^ZENTAO_PASSWORD=.*|ZENTAO_PASSWORD=$ZENTAO_PASSWORD|" .env
    sed -i.bak "s|^ZENTAO_CREATE_TASK_URL=.*|ZENTAO_CREATE_TASK_URL=$ZENTAO_EXECUTION_ID|" .env
    rm -f .env.bak

    echo ""
    echo -e "${GREEN}✓ 禅道配置已保存${NC}"
else
    echo -e "${YELLOW}⊘ 跳过禅道配置${NC}"
    echo -e "${YELLOW}  提示: 稍后可在扩展设置中配置${NC}"

    # 确保 .env 中有禅道配置项（设为禁用）
    if ! grep -q "ZENTAO_ENABLED" .env 2>/dev/null; then
        echo "" >> .env
        echo "# 禅道配置" >> .env
        echo "ZENTAO_ENABLED=false" >> .env
        echo "ZENTAO_URL=" >> .env
        echo "ZENTAO_USERNAME=" >> .env
        echo "ZENTAO_PASSWORD=" >> .env
        echo "ZENTAO_CREATE_TASK_URL=" >> .env
    fi
fi

# ==================== 步骤6: 创建全局命令 ====================
echo ""
echo -e "${BOLD}[6/9]${NC} 创建全局命令..."

BIN_DIR="$HOME/bin"
mkdir -p "$BIN_DIR"

# 创建 wa 命令
cat > "$BIN_DIR/wa" << EOF
#!/bin/bash
cd "$SCRIPT_DIR" && exec ./start.sh "\$@"
EOF

# 创建 wastop 命令
cat > "$BIN_DIR/wastop" << EOF
#!/bin/bash
cd "$SCRIPT_DIR" && exec ./stop.sh "\$@"
EOF

# 创建 walog 命令
cat > "$BIN_DIR/walog" << EOF
#!/bin/bash
cd "$SCRIPT_DIR" && exec tail -f logs/service.log
EOF

# 设置执行权限
chmod +x "$BIN_DIR/wa" "$BIN_DIR/wastop" "$BIN_DIR/walog"

# 检查/添加 PATH
PATH_UPDATED=false
if ! echo "$PATH" | grep -q "$BIN_DIR"; then
    echo -e "${YELLOW}添加 $BIN_DIR 到 PATH...${NC}"

    # 添加到 shell 配置文件
    if [ -f "$SHELL_RC" ]; then
        # 检查是否已经添加过（避免重复）
        if ! grep -q "工作助手 bin 目录" "$SHELL_RC"; then
            echo "" >> "$SHELL_RC"
            echo "# 工作助手 bin 目录" >> "$SHELL_RC"
            echo "export PATH=\"$BIN_DIR:\$PATH\"" >> "$SHELL_RC"
            echo -e "${GREEN}✓ 已添加到 $SHELL_RC${NC}"
        else
            echo -e "${GREEN}✓ PATH 配置已存在${NC}"
        fi

        # 自动加载 PATH
        echo -e "${YELLOW}自动加载 PATH...${NC}"
        export PATH="$BIN_DIR:$PATH"
        PATH_UPDATED=true
        echo -e "${GREEN}✓ PATH 已在当前会话中生效${NC}"
    else
        echo -e "${YELLOW}⚠️  未找到 $SHELL_RC，请手动添加 PATH${NC}"
    fi
else
    echo -e "${GREEN}✓ $BIN_DIR 已在 PATH 中${NC}"
fi

echo -e "${GREEN}✓ 全局命令已创建${NC}"

# ==================== 步骤7: 安装扩展 ====================
echo ""
echo -e "${BOLD}[7/9]${NC} 安装 Chrome 扩展..."

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

# 自动打开扩展页面
read -p "${CYAN}是否自动打开扩展安装页面？[Y/n]: ${NC}" open_ext
open_ext=${open_ext:-Y}

if [[ $open_ext =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}正在打开扩展安装页面...${NC}"

    # Mac 系统
    if [[ "$OS" == "Mac" ]]; then
        if command -v open &> /dev/null; then
            open "chrome://extensions/"
            echo -e "${GREEN}✓ 已在 Chrome 中打开扩展页面${NC}"
        elif command -v google-chrome &> /dev/null; then
            google-chrome "chrome://extensions/" &> /dev/null &
            echo -e "${GREEN}✓ 已在 Chrome 中打开扩展页面${NC}"
        else
            echo -e "${YELLOW}⚠️  无法自动打开，请手动打开 chrome://extensions/${NC}"
        fi
    # Linux 系统
    else
        if command -v google-chrome &> /dev/null; then
            google-chrome "chrome://extensions/" &> /dev/null &
            echo -e "${GREEN}✓ 已在 Chrome 中打开扩展页面${NC}"
        elif command -v chromium-browser &> /dev/null; then
            chromium-browser "chrome://extensions/" &> /dev/null &
            echo -e "${GREEN}✓ 已在 Chrome 中打开扩展页面${NC}"
        else
            echo -e "${YELLOW}⚠️  无法自动打开，请手动打开 chrome://extensions/${NC}"
        fi
    fi
fi

echo ""

# ==================== 步骤8: 启动后端服务 ====================
echo ""
echo -e "${BOLD}[8/9]${NC} 启动后端服务..."

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

# ==================== 步骤9: 验证安装 ====================
echo ""
echo -e "${BOLD}[9/9]${NC} 验证安装..."

# 验证全局命令
if command -v wa &> /dev/null; then
    echo -e "${GREEN}✓ 全局命令 'wa' 可用${NC}"
else
    if [ "$PATH_UPDATED" = true ]; then
        echo -e "${GREEN}✓ 全局命令 'wa' 已配置（当前会话可用）${NC}"
    else
        echo -e "${YELLOW}⚠️  全局命令需要重新加载 PATH${NC}"
    fi
fi

# 验证后端服务
sleep 2
if curl -s "http://localhost:$PORT" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ 后端服务运行正常${NC}"
else
    echo -e "${YELLOW}⚠️  后端服务可能未正常启动${NC}"
    echo -e "${YELLOW}   请运行: walog 查看日志${NC}"
fi

# ==================== 安装完成 ====================
echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  🎉 安装完成！${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${BLUE}📋 后续步骤：${NC}"
echo ""

if [ "$PATH_UPDATED" = true ]; then
    echo -e "${GREEN}✅${NC} PATH 已在当前会话中生效，无需重新加载"
else
    echo "  1. ${YELLOW}重新加载 PATH（如需使用全局命令）${NC}"
    echo "     ${CYAN}source $SHELL_RC${NC}"
    echo ""
fi

echo "  2. ${YELLOW}在 Chrome 中加载扩展${NC}"
echo "     - 已自动打开扩展页面（如果选择）"
echo "     - 或手动访问: chrome://extensions/"
echo "     - 开启「开发者模式」，加载扩展"
echo "     - 选择文件夹: $EXTENSION_PATH"
echo ""

echo "  3. ${YELLOW}固定扩展图标（可选）${NC}"
echo "     - 在扩展页面点击「详细信息」"
echo "     - 点击「在工具栏中显示」"
echo ""

echo -e "${BLUE}🎯 常用命令：${NC}"
echo ""
echo "  ${GREEN}wa${NC}              - 启动服务"
echo "  ${GREEN}wastop${NC}           - 停止服务"
echo "  ${GREEN}walog${NC}            - 查看实时日志"
echo ""

echo -e "${BLUE}💡 提示：${NC}"
echo "  - 后端服务已在后台运行，关闭终端不影响"
echo "  - 数据存储在: $SCRIPT_DIR/data"
echo "  - 配置文件: $SCRIPT_DIR/.env"
echo "  - 全局命令已安装到 $BIN_DIR"
echo "  - 查看日志: tail -f $SCRIPT_DIR/logs/service.log"
echo ""

echo -e "${BLUE}🔧 可选配置：${NC}"
echo ""
echo "  ${CYAN}• 禅道集成${NC} - 在扩展设置中配置禅道账号"
echo "  ${CYAN}• Webhook 通知${NC} - 在 .env 中配置 WEBHOOK_URL"
echo "  ${CYAN}• 数据备份${NC} - 在扩展设置中配置坚果云/WebDAV"
echo "  ${CYAN}• PM2 开机自启${NC} - 运行: pm2 startup && pm2 save"
echo ""

echo -e "${GREEN}✨ 现在可以打开新标签页，开始使用工作助手了！${NC}"
echo ""
