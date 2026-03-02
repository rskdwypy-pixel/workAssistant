# 工作助手

AI驱动的智能任务管理和日报生成工具。

## 功能特点

- 📝 **智能任务管理** - 自然语言输入，AI自动分析任务标题、优先级、分类，支持输入法安全防误触与Shift+Enter换行
- 📅 **日历视图** - GitHub式日历，颜色显示每日完成度，未完成任务自动顺延
- 📊 **三栏看板** - 待办/进行中/已完成，支持**鼠标拖拽排序与状态变更**，进度条无缝渲染
- 🎨 **视觉反馈** - 任务卡片随进度显示动态柔和渐变色背景
- 🔔 **定时提醒** - 每早9点提醒今日待办
- 📖 **自动日报** - 每晚9点自动生成排版精美的工作日报
- 🔍 **快速搜索** - 支持关键词搜索任务
- 📱 **浏览器插件** - 覆盖新标签页，随时使用
- 🔔 **多渠道通知** - 系统通知 + Webhook（干净格式，支持飞书/钉钉/企业微信）
- 🐉 **禅道集成** - 自动同步任务到禅道，支持工时记录和状态同步
- ⌨️ **键盘快捷键** - 选中任务后按Delete删除，按Esc取消选中
- ☁️ **数据同步** - 支持坚果云/WebDAV多设备同步

## 技术栈

- **后端**: Node.js + Express
- **前端**: Chrome/Edge 浏览器插件
- **AI**: 智谱AI / OpenAI API（支持自定义baseURL）
- **进程管理**: PM2
- **数据存储**: 本地JSON文件 + WebDAV云同步

## 快速开始

### 方式一：安装全局命令（推荐）

运行安装脚本，可在任意位置使用命令：

```bash
cd /Users/itreenewbee/Pictures/Github/workAssistant
./install.sh
```

安装后可用的命令：

| 命令 | 说明 |
|------|------|
| `wa` | 启动服务 |
| `wastop` | 停止服务 |
| `walog` | 查看实时日志（Ctrl+C 退出） |

### 方式二：使用启动脚本

```bash
cd /Users/itreenewbee/Pictures/Github/workAssistant
./start.sh
```

### 方式二：手动启动

```bash
cd /Users/itreenewbee/Pictures/Github/workAssistant
npm install  # 首次运行需要
npm start
```

### 使用 PM2（生产环境，推荐）

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # 开机自启
```

## 安装部署

### 1. 安装依赖

```bash
cd /Users/itreenewbee/Pictures/Github/workAssistant
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env` 文件，填入你的配置：

```bash
# AI配置 - 智谱AI (推荐)
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

# Webhook通知配置（可选）
WEBHOOK_URL=
WEBHOOK_TYPE=generic

# 禅道集成配置（可选）
ZENTAO_ENABLED=false
ZENTAO_URL=http://your-zentao.com
ZENTAO_USERNAME=your-account
ZENTAO_PASSWORD=your-password
ZENTAO_CREATE_TASK_URL=167
```

**智谱AI 配置说明**：
1. 访问 [智谱AI开放平台](https://open.bigmodel.cn/)
2. 获取 API Key
3. `glm-4-flash` 是智谱的免费/低价模型，速度快且足够用
4. 也可以使用 `glm-4-plus` 或 `glm-4-air` 获得更好效果

### 3. 启动服务

```bash
# 开发模式
npm run dev

# 生产模式（使用PM2）
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # 开机自启
```

### 4. 安装浏览器插件

1. 打开 Chrome/Edge，访问 `chrome://extensions/`
2. 开启"开发者模式"
3. 点击"加载已解压的扩展程序"
4. 选择项目的 `extension/` 目录

### 5. 配置插件

打开新标签页，点击右上角 **⚙️ 设置** 按钮，可以配置：

| 配置项 | 说明 |
|--------|------|
| **AI服务** | 选择智谱AI / OpenAI / 自定义 |
| **API Key** | 你的智谱/ OpenAI API Key |
| **API地址** | 自动填充，也可自定义 |
| **模型** | glm-4-flash / gpt-4o-mini 等 |
| **早/晚提醒** | 设置提醒时间（默认9点/21点） |
| **Webhook** | 飞书/钉钉/企业微信通知地址 |
| **数据同步** | 坚果云/WebDAV多设备同步 |
| **禅道集成** | 禅道账号、密码、执行ID |

> 💡 配置保存在浏览器本地，后端服务配置仍然需要在 `.env` 文件中设置。

### 6. 启动后端服务

⚠️ **重要说明**：浏览器插件无法直接启动Node.js后端服务（浏览器安全限制），需要手动启动：

```bash
# 方式一：使用启动脚本
./start.sh

# 方式二：直接启动
npm start

# 方式三：使用PM2（推荐，长期运行）
pm2 start ecosystem.config.js
pm2 save
pm2 startup  # 开机自启
```

**为什么插件不能启动服务？**
浏览器插件运行在沙箱环境，没有执行系统命令的权限，这是浏览器的安全限制。

**服务状态检查**：插件设置页面会显示后端服务是否在线。

### 7. 添加插件图标

在 `extension/icons/` 目录下放置以下文件：
- icon16.png (16x16)
- icon48.png (48x48)
- icon128.png (128x128)

## 使用方式

### 浏览器插件（推荐）

1. 打开新标签页（Cmd+T）直接进入工作助手
2. 输入任务内容，点击"添加任务" (支持Shift+Enter换行)
3. **鼠标按住任务卡片**即可上下拖拽调整顺序，或左右拖拽变更状态
4. 点击日历中的日期查看那天的任务
5. 选中网页文字 → 右键 → "添加到任务"
6. **键盘快捷键**：
   - 点击任务选中，按 `Delete/Backspace` 弹出确认删除
   - 按 `Enter` 直接删除选中任务
   - 按 `Esc` 取消选中

### 禅道集成

1. 在设置中配置禅道账号、密码和执行ID
2. 创建任务时自动同步到禅道
3. 更新进度时自动记录工时到禅道
4. 删除任务时同步删除禅道任务

**工时计算**：
- 剩余工时自动根据累计消耗工时和进度计算
- 公式：`剩余工时 = 累计消耗 / (进度 / 100) - 累计消耗`

### 数据同步

支持坚果云/WebDAV多设备同步：

1. 在设置中配置WebDAV信息
2. 数据变更时自动上传到云端
3. 换设备后登录坚果云即可同步

### 命令行（可选）

在 `~/.zshrc` 中添加快捷命令：

```bash
# 工作助手
alias wa-add='curl -X POST http://localhost:3721/api/task -H "Content-Type: application/json" -d'
alias wa-list='curl http://localhost:3721/api/tasks'
alias wa-today='curl http://localhost:3721/api/tasks/today'
alias wa-search='curl http://localhost:3721/api/tasks/search?q='
alias wa-history='curl http://localhost:3721/api/history'
```

使用示例：

```bash
# 添加任务
wa-add '{"content":"明天下午3点和产品开会讨论需求"}'

# 查看所有任务
wa-list

# 搜索任务
wa-search 会议

# 查看历史日报
wa-history
```

## API接口

```
POST   /api/task              # 添加任务
GET    /api/tasks             # 获取所有任务
GET    /api/tasks/today       # 获取今日任务
GET    /api/tasks/date/:date  # 获取指定日期任务
GET    /api/tasks/search?q=   # 搜索任务
PUT    /api/task/:id/status   # 更新任务状态
PUT    /api/task/:id          # 更新任务
DELETE /api/task/:id          # 删除任务

GET    /api/calendar/:year/:month  # 获取日历数据
GET    /api/history           # 获取历史日报
GET    /api/stats             # 获取统计数据

# 同步接口
GET    /api/sync/export       # 导出数据
POST   /api/sync/import       # 导入数据
GET    /api/sync/summary      # 获取同步摘要

# 禅道接口
GET    /api/zentao/config     # 获取禅道配置
POST   /api/zentao/config     # 保存禅道配置
POST   /api/zentao/task/create # 创建禅道任务
```

## 常用命令

```bash
# 启动服务
pm2 start work-assistant

# 查看状态
pm2 status

# 查看日志
pm2 logs work-assistant

# 重启服务
pm2 restart work-assistant

# 停止服务
pm2 stop work-assistant
```

## Webhook配置

支持以下类型的Webhook：

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

## 许可证

MIT
