@echo off
REM 工作助手一键安装脚本（Windows）
REM 执行此脚本后，只需加载插件并启动后端服务即可使用

setlocal enabledelayedexpansion

REM 获取脚本所在目录（项目目录）
set "SCRIPT_DIR=%~dp0"
set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

echo.
echo ========================================
echo   🚀 工作助手 - 一键安装向导
echo ========================================
echo.
echo 项目目录: %SCRIPT_DIR%
echo.

REM ==================== 步骤1: 环境检查 ====================
echo [1/6] 检查运行环境...
echo.

REM 检查 Node.js
where node >nul 2>&1
if errorlevel 1 (
    echo [错误] 未安装 Node.js
    echo.
    echo 请先安装 Node.js:
    echo   1. 访问 https://nodejs.org/
    echo   2. 下载并安装 LTS 版本
    echo   3. 安装后重新运行此脚本
    echo.
    pause
    exit /b 1
)

for /f "tokens=1" %%v in ('node -v') do set NODE_VERSION=%%v
echo [√] Node.js 版本: %NODE_VERSION%

REM 检查 npm
where npm >nul 2>&1
if errorlevel 1 (
    echo [错误] npm 未安装
    pause
    exit /b 1
)

for /f "tokens=1" %%v in ('npm -v') do set NPM_VERSION=%%v
echo [√] npm 版本: %NPM_VERSION%

REM 检查 git
where git >nul 2>&1
if errorlevel 1 (
    echo [!] Git 未安装（可选，不影响使用）
) else (
    for /f "tokens=1-3" %%v in ('git --version') do set GIT_VERSION=%%v %%w %%x
    echo [√] Git 已安装: %GIT_VERSION%
)

REM ==================== 步骤2: 安装依赖 ====================
echo.
echo [2/6] 安装项目依赖...
echo.

if not exist "node_modules" (
    echo 正在安装 npm 依赖...
    call npm install
    if errorlevel 1 (
        echo [错误] 依赖安装失败
        echo.
        echo 可能的原因：
        echo   1. 网络连接问题
        echo   2. npm registry 访问受限
        echo   3. Node.js 版本过低
        echo.
        echo 解决方案：
        echo   1. 检查网络连接
        echo   2. 使用淘宝镜像: npm config set registry https://registry.npmmirror.com
        echo   3. 清理缓存重试: npm cache clean --force ^&^& npm install
        pause
        exit /b 1
    )
    echo [√] 依赖安装完成
) else (
    echo [√] 依赖目录已存在
)

REM 验证关键依赖是否正确安装
echo.
echo 验证关键依赖...
set "MISSING_DEPS="

if not exist "node_modules\express" set "MISSING_DEPS=1"
if not exist "node_modules\cors" set "MISSING_DEPS=1"
if not exist "node_modules\dotenv" set "MISSING_DEPS=1"
if not exist "node_modules\uuid" set "MISSING_DEPS=1"

if defined MISSING_DEPS (
    echo [!] 检测到关键依赖缺失
    echo 正在重新安装依赖...
    rmdir /s /q node_modules 2>nul
    del package-lock.json 2>nul
    call npm install

    if errorlevel 1 (
        echo [错误] 依赖重新安装失败
        echo.
        echo 手动安装步骤：
        echo   1. 清理缓存: npm cache clean --force
        echo   2. 删除依赖: rmdir /s /q node_modules ^& del package-lock.json
        echo   3. 重新安装: npm install
        echo.
        echo 如果仍然失败，请尝试：
        echo   - 使用淘宝镜像: npm config set registry https://registry.npmmirror.com
        echo   - 检查 Node.js 版本: node -v (需要 ^>= 14.0.0)
        pause
        exit /b 1
    )
)

echo [√] 关键依赖验证通过

REM ==================== 步骤3: 配置文件 ====================
echo.
echo [3/6] 配置环境文件...
echo.

if not exist ".env" (
    echo 创建 .env 配置文件...
    copy .env.example .env >nul

    REM 检查配置文件是否需要手动配置
    findstr /C:"your_api_key_here" .env >nul
    if not errorlevel 1 (
        echo [!] 配置文件已创建
        echo.
        echo [!] 请编辑 .env 文件，配置以下信息：
        echo.
        echo   1. AI 配置（必须）
        echo      - OPENAI_API_KEY: 你的AI API密钥
        echo      - OPENAI_BASE_URL: API基础URL
        echo.
        echo   2. 禅道配置（可选）
        echo      - ZENTAO_URL: 禅道地址
        echo      - ZENTAO_USERNAME: 用户名
        echo      - ZENTAO_PASSWORD: 密码
        echo.
        echo [!] 配置完成后，重新运行此脚本
        pause
        exit /b 1
    ) else (
        echo [√] 配置文件已创建
    )
) else (
    echo [√] 配置文件已存在
)

REM ==================== 步骤4: 创建数据目录 ====================
echo.
echo [4/6] 初始化数据目录...
echo.

if not exist "data\backups" mkdir data\backups
if not exist "logs" mkdir logs

if not exist "data\tasks.json" (
    echo {"version": "1.0","lastUpdated":null,"tasks":[]} > data\tasks.json
    echo [√] tasks.json 已创建
) else (
    echo [√] 数据目录已存在
)

REM ==================== 步骤5: 安装扩展 ====================
echo.
echo [5/6] 安装 Chrome 扩展...
echo.

set "EXTENSION_PATH=%SCRIPT_DIR%\extension"

if not exist "%EXTENSION_PATH%" (
    echo [错误] 找不到 extension 目录
    pause
    exit /b 1
)

echo.
echo 📦 Chrome 扩展安装步骤：
echo.
echo   1. 打开 Chrome 浏览器
echo   2. 在地址栏输入: chrome://extensions/
echo   3. 开启右上角的「开发者模式」
echo   4. 点击「加载已解压的扩展程序」
echo   5. 选择文件夹: %EXTENSION_PATH%
echo   6. 点击「添加扩展程序」
echo.
echo [√] 扩展文件准备就绪
echo [!] 提示: 加载后可固定扩展图标到工具栏
echo.

REM ==================== 步骤6: 启动后端服务 ====================
echo.
echo [6/6] 启动后端服务...
echo.

set PORT=3721
netstat -ano | findstr ":%PORT%" | findstr "LISTENING" >nul
if not errorlevel 1 (
    echo [!] 端口 %PORT% 已被占用
    set /p STOP_SERVICE="是否停止现有服务并启动? (y/N): "
    if /i "!STOP_SERVICE!"=="y" (
        echo 正在停止现有服务...
        if exist "stop.bat" (
            call stop.bat
        ) else (
            for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do (
                taskkill /F /PID %%a >nul 2>&1
            )
        )
        timeout /t 2 /nobreak >nul
    ) else (
        echo 操作已取消
        echo.
        echo [!] 如需手动启动服务，请运行: start.bat
        pause
        exit /b 0
    )
)

REM 自动启动服务
if exist "start.bat" (
    call start.bat
) else (
    echo 正在启动服务...
    start /B cmd /c "npm start > logs\service.log 2>&1"
    timeout /t 2 /nobreak >nul

    REM 检查服务是否启动成功
    netstat -ano | findstr ":%PORT%" | findstr "LISTENING" >nul
    if not errorlevel 1 (
        echo [√] 服务启动成功!
        echo    地址: http://localhost:%PORT%
        echo    日志: logs\service.log
    ) else (
        echo [错误] 服务启动失败，请查看日志
        pause
        exit /b 1
    )
)

REM ==================== 安装完成 ====================
echo.
echo ========================================
echo   🎉 安装完成！
echo ========================================
echo.
echo 📋 后续步骤：
echo.
echo   1. 确认 Chrome 扩展已加载（参考上面的安装步骤）
echo   2. 访问 chrome://extensions/ 固定扩展图标
echo   3. 打开新标签页，开始使用工作助手
echo.
echo 🎯 常用命令：
echo.
echo   wa              - 启动服务
echo   wastop          - 停止服务
echo   walog           - 查看日志
echo.
echo 💡 提示：
echo   - 后端服务已在后台运行
echo   - 数据存储在: %SCRIPT_DIR%\data
echo   - 配置文件: %SCRIPT_DIR%\.env
echo.
echo ⚠️  注意事项：
echo   - 如需使用 AI 功能，请配置 .env 中的 API 密钥
echo   - 如需同步禅道，请配置禅道相关信息
echo.
pause
