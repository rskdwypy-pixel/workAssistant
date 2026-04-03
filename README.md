# 工作助手

> AI 驱动的智能任务管理工具，支持任务与 Bug 管理、禅道双向同步、自动日报生成

## ✨ 功能特点

### 📝 任务管理
- **智能任务添加** - 自然语言输入，AI 自动分析任务标题、优先级、分类
- **三栏看板** - 待办/进行中/已完成，支持拖拽排序与状态变更
- **日历视图** - GitHub 式日历，颜色显示每日完成度
- **快速搜索** - 支持关键词搜索任务
- **键盘快捷键** - Delete 删除，Esc 取消选中
- **进度管理** - 可视化进度条，动态渐变色背景

### 🐛 Bug 管理
- **Bug 创建与跟踪** - 支持创建 Bug，记录详细信息
- **Bug 状态管理** - 未确认 → 已激活 → 已解决 → 已关闭
- **禅道 Bug 同步** - 双向同步 Bug 数据到禅道
- **Bug 详情查看** - 查看 Bug 完整信息和操作历史

### 🐉 禅道集成
- **双向同步** - 任务和 Bug 与禅道实时同步
- **自动登录** - 禅道自动登录，无需手动输入账号密码
- **用户管理** - 自动缓存禅道用户列表，方便指派
- **工时记录** - 自动计算和记录工时到禅道
- **状态同步** - 本地状态变更自动同步到禅道
- **去重机制** - 基于 zentaoId 智能去重，避免重复创建

### 🤖 AI 汇总
- **日报生成** - 每晚自动生成工作日报
- **周报生成** - 每周生成工作总结
- **月报生成** - 每月生成工作汇总
- **智能分析** - AI 分析任务完成情况和工作内容
- **多模型支持** - 智谱 AI / OpenAI / 自定义 API

### ☁️ 数据备份
- **坚果云备份** - 支持坚果云 WebDAV 备份
- **智能过滤** - 自动排除已同步到禅道的数据
- **完整备份** - 备份配置、报告、本地任务、草稿等
- **一键恢复** - 换设备后快速恢复所有数据

### 🔔 通知提醒
- **系统通知** - 早 9 点提醒今日待办
- **Webhook 推送** - 支持飞书/钉钉/企业微信
- **工时提醒** - 实时显示今日工作时长

### 🎨 用户体验
- **新标签页集成** - 打开新标签页即工作助手
- **右键菜单** - 选中网页文字直接添加为任务
- **进度 Toast** - 透明的进度提示，不遮挡操作
- **按钮防重复** - 防止重复提交，保护数据安全

## 🛠 技术栈

- **后端**: Node.js + Express
- **前端**: Chrome/Edge 扩展 (Manifest V3)
- **AI**: 智谱 AI / OpenAI API
- **数据存储**: 本地 JSON 文件
- **数据备份**: WebDAV (坚果云/NextCloud/iCloud)
- **跨平台**: Windows / macOS / Linux

## 🚀 快速开始

### 一键安装（推荐）

#### Windows
```bash
install.bat
```

#### Mac / Linux
```bash
chmod +x install.sh
./install.sh
```

安装脚本会自动：
1. ✅ 检查运行环境（Node.js、npm）
2. ✅ 安装项目依赖
3. ✅ 创建配置文件
4. ✅ 初始化数据目录
5. ✅ **创建全局命令**（wa、wastop、walog）
6. ✅ 提供扩展安装指引
7. ✅ 启动后端服务

**安装后可用命令：**
```bash
wa              # 启动服务（任何位置）
wastop          # 停止服务
walog           # 查看日志
```

**首次使用需要加载 PATH：**
```bash
# Mac
source ~/.zshrc

# Linux
source ~/.bashrc
```

### 手动安装

#### 1. 安装依赖
```bash
npm install
```

#### 2. 配置环境变量
```bash
cp .env.example .env
```

编辑 `.env` 文件：

```bash
# AI 配置 - 智谱 AI（推荐）
OPENAI_API_KEY=your_zhipu_api_key
OPENAI_BASE_URL=https://open.bigmodel.cn/api/paas/v4/
OPENAI_MODEL=glm-4-flash

# 或使用 OpenAI 官方
# OPENAI_API_KEY=sk-your-api-key
# OPENAI_BASE_URL=https://api.openai.com/v1
# OPENAI_MODEL=gpt-4o-mini

# 服务配置
PORT=3721
MORNING_HOUR=9
EVENING_HOUR=21

# Webhook 通知（可选）
WEBHOOK_URL=
WEBHOOK_TYPE=generic

# 禅道集成（可选）
ZENTAO_ENABLED=false
ZENTAO_URL=http://your-zentao.com
ZENTAO_USERNAME=your-account
ZENTAO_PASSWORD=your-password
```

#### 3. 启动服务

**Windows:**
```bash
npm start
```

**Mac / Linux:**
```bash
./start.sh
```

**使用 PM2（生产环境）:**
```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # 开机自启
```

#### 4. 安装浏览器扩展

1. 打开 Chrome/Edge，访问 `chrome://extensions/`
2. 开启"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择项目的 `extension/` 目录
5. 固定扩展图标到工具栏

## ⚙️ 配置说明

### AI 配置

**智谱 AI（推荐）:**
1. 访问 [智谱AI开放平台](https://open.bigmodel.cn/)
2. 获取 API Key
3. 使用 `glm-4-flash` 模型（免费/低价，速度快）

**OpenAI:**
1. 使用 OpenAI API Key
2. 推荐使用 `gpt-4o-mini` 模型

### 禅道配置

1. 在插件设置中配置禅道账号、密码
2. 配置执行 ID（用于创建任务和 Bug）
3. 开启"启用禅道同步"开关
4. 首次使用会自动登录禅道

### 数据备份配置

1. 在插件设置中选择"坚果云"或"自定义 WebDAV"
2. 填写账号和应用密码（⚠️ 非登录密码）
3. 点击"测试连接"验证配置
4. 开启"定期自动备份"

**坚果云配置步骤：**
1. 登录坚果云网页版 → 头像 → 账户信息
2. 安全选项 → 勾选"启用第三方应用管理"
3. 生成应用密码

## 📖 使用指南

### 任务管理

**添加任务:**
1. 在输入框输入任务内容
2. 点击"添加任务"或按 Enter
3. 支持 Shift+Enter 换行输入多行内容

**管理任务:**
- 🖱️ **拖拽** - 鼠标按住任务卡片可拖拽调整顺序或状态
- ⌨️ **快捷键** - 选中后按 Delete 删除，Esc 取消选中
- 📅 **日历** - 点击日历日期查看/创建该日任务
- 📊 **进度** - 拖动进度条调整任务完成度

**右键菜单:**
- 选中网页文字 → 右键 → "添加到任务"

### Bug 管理

**创建 Bug:**
1. 切换到 "Bug" 标签页
2. 填写 Bug 信息（标题、步骤、严重程度等）
3. 选择指派人和抄送
4. 点击"提交 Bug"

**Bug 操作:**
- **激活** - 将 Bug 状态改为"已激活"并同步到禅道
- **解决** - 填写解决方案并标记为"已解决"
- **关闭** - 关闭已解决的 Bug
- **删除** - 删除本地 Bug（同步到禅道的需要先在禅道删除）

### 禅道同步

**自动同步:**
- 创建任务/Bug 时自动同步到禅道
- 更新状态时自动同步到禅道
- 获取用户列表并缓存

**手动同步:**
- 点击设置页面的"立即同步"按钮
- 可跳过 24 小时时间限制

**同步内容:**
- ✅ 任务和 Bug 数据
- ✅ 状态变更
- ✅ 工时记录
- ✅ 指派信息

### 数据备份

**备份内容:**
- ✅ 配置文件（AI、Webhook、提醒时间等）
- ✅ 历史报告（日报、周报、月报）
- ✅ 本地任务（排除已同步到禅道的）
- ✅ 草稿数据
- ✅ 用户偏好设置

**不备份:**
- ❌ 禅道任务和 Bug（已在禅道中）
- ❌ 禅道会话令牌

**恢复数据:**
1. 换设备后配置相同的 WebDAV 信息
2. 点击"恢复数据"按钮
3. 确认后自动恢复所有数据

### AI 汇总

**日报:**
- 每晚 21 点自动生成
- 包含今日完成任务、工时统计、明日计划
- 可通过 Webhook 推送到飞书/钉钉

**周报/月报:**
- 每周一上午生成周报
- 每月一号上午生成月报
- 统计周期内的任务完成情况

## 🔧 常用命令

### 全局命令（推荐）

运行 `install.sh` 后，可在任何位置使用以下命令：

| 命令 | 说明 | 等同于 |
|------|------|--------|
| `wa` | 启动服务 | `./start.sh` |
| `wastop` | 停止服务 | `./stop.sh` |
| `walog` | 查看实时日志 | `tail -f logs/service.log` |

**首次使用需要加载 PATH：**
```bash
# Mac
source ~/.zshrc

# Linux
source ~/.bashrc
```

### 启动/停止服务

**Windows:**
```bash
npm start        # 启动
npm stop         # 停止
```

**Mac / Linux:**
```bash
./start.sh       # 启动
./stop.sh        # 停止
```

**使用 PM2:**
```bash
pm2 start ecosystem.config.js    # 启动
pm2 restart work-assistant       # 重启
pm2 stop work-assistant          # 停止
pm2 logs work-assistant          # 查看日志
pm2 status                       # 查看状态
```

### 查看日志

**使用全局命令：**
```bash
walog            # 实时日志（Ctrl+C 退出）
```

**Mac / Linux:**
```bash
./start.sh       # 实时日志
./stop.sh        # 停止后查看日志
```

**直接查看:**
```bash
tail -f logs/service.log
```

## 📡 API 接口

### 任务管理
```
POST   /api/task              # 添加任务
GET    /api/tasks             # 获取所有任务
GET    /api/tasks/today       # 获取今日任务
GET    /api/tasks/date/:date  # 获取指定日期任务
GET    /api/tasks/search?q=   # 搜索任务
PUT    /api/task/:id/status   # 更新任务状态
PUT    /api/task/:id          # 更新任务
DELETE /api/task/:id          # 删除任务
```

### Bug 管理
```
POST   /api/bug               # 创建 Bug
GET    /api/bugs              # 获取所有 Bug
PUT    /api/bug/:id/status    # 更新 Bug 状态
DELETE /api/bug/:id           # 删除 Bug
GET    /api/bug/stats         # 获取 Bug 统计
```

### 禅道集成
```
GET    /api/zentao/config     # 获取禅道配置
POST   /api/zentao/config     # 保存禅道配置
POST   /api/zentao/sync/tasks # 同步禅道任务
POST   /api/zentao/sync/bugs  # 同步禅道 Bug
GET    /api/zentao/users      # 获取禅道用户列表
```

### 数据备份
```
POST   /api/backup            # 立即备份
POST   /api/restore           # 恢复数据
GET    /api/history/restore   # 恢复历史报告
```

### AI 汇总
```
POST   /api/report/generate/daily   # 生成日报
POST   /api/report/generate/weekly  # 生成周报
POST   /api/report/generate/monthly # 生成月报
GET    /api/history                 # 获取历史报告
```

## 🔔 Webhook 配置

### 飞书机器人
```bash
WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxx
WEBHOOK_TYPE=feishu
```

### 钉钉机器人
```bash
WEBHOOK_URL=https://oapi.dingtalk.com/robot/send?access_token=xxx
WEBHOOK_TYPE=dingtalk
```

### 企业微信机器人
```bash
WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx
WEBHOOK_TYPE=wecom
```

## 📂 项目结构

```
workAssistant/
├── extension/              # Chrome 扩展
│   ├── newtab.html        # 新标签页
│   ├── newtab.js          # 主逻辑
│   ├── background.js      # 后台服务
│   ├── sync.js            # 数据同步
│   ├── backupManager.js   # 备份管理
│   └── manifest.json      # 扩展配置
├── src/                   # 后端服务
│   ├── routes/            # API 路由
│   ├── services/          # 业务逻辑
│   └── index.js           # 入口文件
├── data/                  # 数据存储
│   ├── tasks.json         # 任务数据
│   ├── history.json       # 历史报告
│   └── backups/           # 备份文件
├── install.sh             # Mac/Linux 安装脚本（创建全局命令）
├── install.bat            # Windows 安装脚本
├── start.sh               # 启动脚本
├── stop.sh                # 停止脚本
├── ecosystem.config.js    # PM2 配置
└── ~/bin/                 # 全局命令（安装后自动创建）
    ├── wa                 # 启动服务
    ├── wastop             # 停止服务
    └── walog              # 查看日志
```

## 🐛 常见问题

### 1. 扩展无法连接后端服务

**检查:**
- 后端服务是否启动（访问 http://localhost:3721）
- 浏览器控制台是否有错误
- 端口 3721 是否被占用

**解决:**
```bash
# 重启后端服务
./stop.sh && ./start.sh
```

### 2. 禅道同步失败

**检查:**
- 禅道账号密码是否正确
- 网络是否正常
- 禅道地址是否可访问

**解决:**
- 清除浏览器缓存
- 重新配置禅道信息
- 手动点击"立即同步"

### 3. AI 汇总失败

**检查:**
- API Key 是否正确
- API 余额是否充足
- 网络是否正常

**解决:**
- 更换 AI 模型
- 检查 API 配置
- 查看 `logs/service.log` 日志

### 4. 数据备份失败

**检查:**
- WebDAV 配置是否正确
- 应用密码是否正确（非登录密码）
- 网络是否正常

**解决:**
- 点击"测试连接"验证配置
- 重新生成应用密码
- 检查坚果云账户状态

### 5. 全局命令不可用

**问题:**
```bash
wa: command not found
```

**原因:**
- PATH 环境变量未生效
- ~/bin 目录未创建

**解决:**
```bash
# 1. 重新加载 PATH
source ~/.zshrc    # Mac
source ~/.bashrc   # Linux

# 2. 如果还不行，手动添加到 PATH
export PATH="$HOME/bin:$PATH"

# 3. 验证命令是否可用
which wa          # 应该显示 ~/bin/wa

# 4. 如果 ~/bin 不存在，重新运行安装脚本
./install.sh
```

## 📝 更新日志

### v2.0.0 (2026-04-02)
- ✨ 新增 Bug 管理功能
- ✨ 实现禅道双向同步
- ✨ 新增数据备份功能（坚果云/WebDAV）
- ✨ 支持跨平台一键安装（Windows/Mac/Linux）
- 🎨 优化 UI，添加进度 Toast 显示
- 🐛 修复按钮重复提交问题
- 🐛 修复 zentaoId 类型不一致问题
- 📝 完善文档

### v1.0.0
- 🎉 初始版本
- ✨ 任务管理功能
- ✨ AI 日报生成
- ✨ 禅道集成

## 📄 许可证

MIT License

---

**💡 提示:** 首次使用建议先运行一键安装脚本，5 分钟内即可完成所有配置！
