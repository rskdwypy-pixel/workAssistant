# 工作助手 - 快速开始指南

## 🚀 一键安装（推荐）

### Mac / Linux

```bash
# 1. 克隆或下载项目
cd workAssistant

# 2. 运行一键安装脚本
chmod +x install.sh
./install.sh
```

### 安装过程

安装脚本会自动完成以下步骤：

#### ✅ [1/10] 检查运行环境
- 检查 Node.js、npm、git
- 自动提示安装命令（如果缺失）

#### ✅ [2/10] 安装项目依赖
- 自动运行 `npm install`

#### ✅ [3/10] 配置环境文件
**（新增：交互式配置）**
```
🤖 AI 配置（必须）

请选择 AI 服务商：
  1. 智谱 AI（推荐，国内可用，有免费额度）
  2. OpenAI 官方
  3. 自定义中转服务

请输入选项 [1-3，默认 1]: 1

请输入智谱 API Key: sk-xxxxxxxxxxxx

是否测试 AI 连接？[y/N]: y
正在测试 AI 连接...
✅ AI 连接测试成功！
```

#### ✅ [4/10] 初始化数据目录
- 创建 `data/` 和 `logs/` 目录
- 初始化 `tasks.json`

#### ✅ [5/10] 配置禅道（可选）
**（新增：交互式禅道配置）**
```
🐉 禅道集成配置
禅道集成可以实现任务和 Bug 的双向同步

是否配置禅道集成？[y/N]: y

禅道配置
禅道地址: http://zentao.example.com:8088
禅道用户名: your-account
禅道密码: ******
默认执行 ID (execution ID, 选填): 167

配置摘要：
  禅道地址: http://zentao.example.com:8088
  用户名: your-account
  执行 ID: 167

是否测试禅道连接？[Y/n]: y
正在测试禅道连接...
✓ 禅道服务器可访问
正在测试禅道登录...
✓ 禅道登录成功！
✓ 禅道配置已保存
```

> **执行 ID 是选填的。** 直接回车留空即可 —— 留空后，「添加任务」弹窗会自动拉取该禅道账号下的**全部执行**供你选择，不需要提前在这里指定。

#### ✅ [6/10] 创建全局命令
- 创建 `wa`、`wastop`、`walog` 命令
- **自动添加到 PATH**
- **自动在当前会话生效**

#### ✅ [7/10] 安装 Chrome 扩展
**（新增：自动打开扩展页面）**
```
📦 Chrome 扩展安装步骤：

  1. 打开 Chrome 浏览器
  2. 在地址栏输入: chrome://extensions/
  3. 开启右上角的「开发者模式」
  4. 点击「加载已解压的扩展程序」
  5. 选择文件夹: /path/to/workAssistant/extension
  6. 点击「添加扩展程序」

✓ 扩展文件准备就绪
💡 提示: 加载后可固定扩展图标到工具栏

是否自动打开扩展安装页面？[Y/n]: y
正在打开扩展安装页面...
✓ 已在 Chrome 中打开扩展页面
```

#### ✅ [8/10] 启动后端服务
- 自动检测端口占用
- 自动启动服务
- 服务在后台运行

#### ✅ [9/10] 安装开机自启与浏览器宿主
**（新增）**
- 注册 Native Messaging 宿主，扩展可唤起本地后端
- 安装 macOS LaunchAgent（登录后自动拉起后端）
- 可在「设置 → 本地服务 → 开机自启」中随时开关

> **关于「系统里为什么看不到开机自启项」**
>
> 本项目的开机自启用的是 macOS 的 **LaunchAgent**（`~/Library/LaunchAgents/com.workassistant.backend.plist`），
> 这跟「登录项（Login Items）」不是同一个东西，表现也不一样：
>
> | | 登录项 App | 本项目用的 LaunchAgent |
> |---|---|---|
> | 添加时是否弹窗确认 | 会 | **不会，静默注册** |
> | 系统设置里在哪看 | 通用 → 登录项与扩展 → 「打开时」 | 同页面的「**允许在后台**」列表（需 job 已被 launchd 加载后才会出现） |
> | 怎么核对 | 图形界面 | `launchctl print gui/$(id -u)/com.workassistant.backend` |
>
> 所以「没弹窗」不等于没生效。真正要确认的是 launchd 里有没有这个 job：
>
> ```bash
> # 有输出 = 已加载（含 state / pid / program 等字段）
> launchctl print gui/$(id -u)/com.workassistant.backend
>
> # 查不到时手动加载一次
> launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.workassistant.backend.plist
> ```
>
> ⚠️ 注意：`launchctl bootstrap` 无法从被 macOS 沙箱限制的进程里执行
> （会报 `Bootstrap failed: 5: Input/output error`）。
> 如果你是从 IDE / 沙箱终端触发的安装，请改用**系统自带的「终端」App** 执行上面这条命令，
> 或者干脆**注销/重启一次** —— launchd 会在登录时自动加载 `~/Library/LaunchAgents/` 下的所有 plist。

#### ✅ [10/10] 验证安装
**（新增：安装验证）**
```
验证安装...

✓ 全局命令 'wa' 已配置（当前会话可用）
✓ 后端服务运行正常
```

## 🎉 安装完成

### 立即开始使用

1. **在 Chrome 中加载扩展**
   - 已自动打开扩展页面（如果选择）
   - 或手动访问：`chrome://extensions/`
   - 开启"开发者模式"
   - 点击"加载已解压的扩展程序"
   - 选择项目的 `extension/` 目录

2. **固定扩展图标（可选）**
   - 在扩展页面点击"详细信息"
   - 点击"在工具栏中显示"

3. **开始使用**
   - 打开新标签页
   - 开始添加任务！

## 🎯 常用命令

安装完成后，可以在任何位置使用以下命令：

```bash
wa              # 启动服务
wastop          # 停止服务
walog           # 查看实时日志（Ctrl+C 退出）
```

## 🔧 可选配置

### 禅道集成
**（已在安装时配置，或可在扩展设置中配置）**
- 如果在安装时跳过了禅道配置，可以在扩展设置中配置
- 禅道地址、用户名、密码、执行 ID

### Webhook 通知
编辑 `.env` 文件：
```bash
# 飞书
WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxx
WEBHOOK_TYPE=feishu

# 或钉钉
WEBHOOK_URL=https://oapi.dingtalk.com/robot/send?access_token=xxx
WEBHOOK_TYPE=dingtalk
```

### 数据备份
在扩展设置中配置：
- 坚果云/WebDAV 账号
- 应用密码（⚠️ 非登录密码）

### PM2 开机自启
```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # 开机自启
```

## 📂 项目结构

```
workAssistant/
├── extension/          # Chrome 扩展（需要加载）
├── src/               # 后端服务
├── data/              # 数据存储
├── logs/              # 日志文件
├── .env               # 配置文件（自动生成）
├── install.sh         # 一键安装脚本
├── start.sh           # 启动脚本
├── stop.sh            # 停止脚本
└── ~/bin/             # 全局命令（自动创建）
    ├── wa             # 启动服务
    ├── wastop         # 停止服务
    └── walog          # 查看日志
```

## ❓ 常见问题

### 1. 全局命令不可用
```bash
# 解决方法：重新加载 PATH
source ~/.zshrc    # Mac
source ~/.bashrc   # Linux
```

### 2. 扩展无法连接后端
```bash
# 检查服务状态
curl http://localhost:3721

# 重启服务
wastop && wa

# 查看日志
walog
```

### 3. AI 功能不工作
```bash
# 检查 API Key 配置
cat .env | grep API_KEY

# 重新配置
./install.sh
```

## 💡 提示

- 后端服务在后台运行，关闭终端不影响
- 数据存储在：`$PROJECT_DIR/data`
- 配置文件：`$PROJECT_DIR/.env`
- 查看日志：`tail -f logs/service.log` 或 `walog`

## 📚 更多信息

- 完整文档：查看 `README.md`
- 改进说明：查看 `INSTALL_UPGRADE.md`
- 禅道配置：查看 `ZENTAO_SETUP.md`

---

**🎊 现在开始使用工作助手，提高工作效率吧！**
