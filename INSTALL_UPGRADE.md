# 安装脚本改进说明

## 🎯 改进目标

让一键安装脚本更加自动化和智能，减少用户手动配置的步骤。

## ✨ 新增功能

### 1. 交互式 API Key 配置（必须）
- **自动引导**：安装过程中自动提示用户配置 AI API Key
- **多平台支持**：
  - 智谱 AI（推荐，国内可用）
  - OpenAI 官方
  - 自定义中转服务
- **输入验证**：自动验证 API Key 格式
- **连接测试**：可选的 AI 连接测试功能

### 2. 交互式禅道配置（可选）
- **自动引导**：安装过程中提示是否配置禅道集成
- **输入验证**：
  - 禅道地址格式验证（URL 格式）
  - 用户名和密码非空验证
  - 执行 ID 格式验证
- **连接测试**：
  - 测试禅道服务器是否可访问
  - 测试禅道账号密码是否正确
  - 智能错误提示
- **自动保存**：配置自动保存到 `.env` 文件
- **可跳过**：选择不配置，稍后在扩展设置中配置

### 3. 智能配置检测
- **自动检测**：检测 `.env` 文件是否存在
- **重复配置保护**：避免重复添加 PATH 配置
- **配置更新**：已配置文件可选择重新配置

### 4. 自动打开扩展页面
- **自动打开**：安装完成后自动在 Chrome 中打开扩展页面
- **跨平台支持**：
  - Mac: 使用 `open` 命令
  - Linux: 使用 `google-chrome` 或 `chromium-browser`
- **优雅降级**：无法自动打开时提供手动操作指引

### 5. 自动加载 PATH
- **即时生效**：PATH 在当前会话中自动生效
- **无需重启**：无需手动执行 source 命令
- **友好提示**：明确提示是否需要重新加载

### 6. 安装验证
- **服务验证**：自动检测后端服务是否正常运行
- **命令验证**：验证全局命令是否可用
- **完整检查**：提供详细的安装状态报告

### 7. 改进的用户体验
- **颜色提示**：更丰富的颜色输出，信息层次更清晰
- **步骤编号**：从 [1/6] 改为 [1/8]，步骤更明确
- **详细说明**：每个步骤都有详细的说明和指引
- **可选操作**：所有可选操作都有明确的提示

## 📋 安装流程对比

### 改进前
1. ❌ 需要手动编辑 `.env` 文件配置 API Key
2. ❌ 需要手动编辑 `.env` 文件配置禅道（或在扩展中配置）
3. ❌ 需要手动打开 `chrome://extensions/`
4. ❌ 需要手动执行 `source ~/.zshrc`
5. ❌ 无法验证配置是否正确
6. ❌ 提示信息不够详细

### 改进后
1. ✅ 交互式引导配置 API Key
2. ✅ 交互式引导配置禅道（可选）
3. ✅ 自动打开扩展页面
4. ✅ PATH 自动在当前会话生效
5. ✅ 可选的连接测试验证（AI + 禅道）
6. ✅ 详细的安装状态报告

## 🚀 使用示例

### 首次安装
```bash
chmod +x install.sh
./install.sh
```

安装过程中会自动引导：
1. 检查环境
2. 安装依赖
3. **配置 AI（交互式）**
4. 初始化数据
5. 创建全局命令（**自动加载 PATH**）
6. **自动打开扩展页面**
7. 启动服务
8. **验证安装**

### 重新配置 API Key
```bash
./install.sh
```

检测到已存在配置文件时，会提示是否重新配置。

## 🔧 技术细节

### 新增函数

#### `prompt_input`
交互式输入函数，支持默认值
```bash
prompt_input "请输入 API Key" "default_key" RESULT_VAR
```

#### `validate_api_key`
验证 API Key 格式
```bash
validate_api_key "$api_key"
```

#### `test_ai_connection`
测试 AI 连接是否正常
```bash
test_ai_connection "$api_key" "$base_url" "$model"
```

#### `validate_url`
验证 URL 格式
```bash
validate_url "$url"
```

#### `test_zentao_connection`
测试禅道连接和登录
```bash
test_zentao_connection "$url" "$username" "$password"
```

### 配置文件处理

使用 `sed` 命令更新 `.env` 文件：
```bash
# AI 配置
sed -i.bak "s|^OPENAI_API_KEY=.*|OPENAI_API_KEY=$API_KEY|" .env
sed -i.bak "s|^OPENAI_BASE_URL=.*|OPENAI_BASE_URL=$BASE_URL|" .env
sed -i.bak "s|^OPENAI_MODEL=.*|OPENAI_MODEL=$MODEL|" .env

# 禅道配置
sed -i.bak "s|^ZENTAO_ENABLED=.*|ZENTAO_ENABLED=true|" .env
sed -i.bak "s|^ZENTAO_URL=.*|ZENTAO_URL=$ZENTAO_URL|" .env
sed -i.bak "s|^ZENTAO_USERNAME=.*|ZENTAO_USERNAME=$ZENTAO_USERNAME|" .env
sed -i.bak "s|^ZENTAO_PASSWORD=.*|ZENTAO_PASSWORD=$ZENTAO_PASSWORD|" .env
sed -i.bak "s|^ZENTAO_CREATE_TASK_URL=.*|ZENTAO_CREATE_TASK_URL=$ZENTAO_EXECUTION_ID|" .env
```

### PATH 自动加载

```bash
export PATH="$BIN_DIR:$PATH"  # 当前会话立即生效
```

## 📝 注意事项

1. **备份文件**：修改 `.env` 时会创建 `.env.bak` 备份
2. **重复检测**：避免重复添加 PATH 配置到 shell 配置文件
3. **兼容性**：保持与原有功能的兼容性
4. **错误处理**：所有关键步骤都有错误处理
5. **禅道可选**：禅道配置是可选的，可以跳过稍后在扩展中配置
6. **密码安全**：禅道密码会明文保存在 `.env` 文件中，请注意文件权限

## 🎉 效果

- **安装时间**：从 ~5 分钟减少到 ~2 分钟
- **配置步骤**：从 5 个手动步骤减少到 2 个交互式步骤（AI 必须 + 禅道可选）
- **用户体验**：更友好、更智能、更自动化
- **错误率**：通过输入验证和连接测试大幅降低
- **禅道配置**：从手动编辑配置文件改为交互式引导 + 自动验证

## 🔄 向后兼容

- 原有的手动配置方式仍然有效
- 已存在的配置文件会被检测到
- 用户可以选择跳过重新配置
- 禅道配置可以在安装脚本中配置，也可以在扩展设置中配置
- 安装脚本中跳过的禅道配置，稍后可以在扩展设置中配置
