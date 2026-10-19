# 给新机器 AI 的迁移指令

> 用法：把本文件的**全部内容**复制给新机器上的 AI。
> 它包含完成迁移所需的全部信息，无需你额外解释项目背景。

---

## 你的任务

把 `workAssistant` 这个项目在这台新机器上部署起来，做到**功能与旧机器一致**。

仓库：https://github.com/rskdwypy-pixel/workAssistant.git

配置（AI Key、禅道密码）已加密入库，**不需要重新配置**，你只需在需要口令时向用户索要一次。

## 硬性约束

1. **绝不把明文密钥写进任何文件、日志或提交**。仓库是公开仓库（PUBLIC），明文一旦入库不可逆。
2. 仓库根目录已有 `.env.example`（占位符模板）与 `MIGRATION.md`（完整说明），动手前先读这两个。
3. 口令只能由用户在终端交互式输入，你不要猜测、不要硬编码、不要让它出现在命令行参数里（会留在 shell 历史）。

## 执行步骤

### 第 1 步：拉取代码

```bash
git clone https://github.com/rskdwypy-pixel/workAssistant.git
cd workAssistant
```

如果克隆超时（直连 github.com 在国内常不通），换镜像重试：

```bash
git clone https://ghfast.top/https://github.com/rskdwypy-pixel/workAssistant.git
```

### 第 2 步：还原配置（会需要用户输口令）

```bash
./scripts/export-secrets.sh import
```

口令关闭回显、需输入两次。**请提示用户在终端里输入，不要试图代劳。**

脚本会自动：解密 `.env` → 安装 npm 依赖 → 自检禅道配置项是否齐全。

可能的提示含义：
- `✅ 配置自检通过` —— 继续
- `⚠️ .env 已还原，但禅道配置项不全` —— 配置是旧的或不完整，在扩展设置页补齐
- `❌ 解密失败：口令不正确` —— 让用户重新输入；**脚本会自动删掉半截文件，不会留下损坏的 `.env`**

### 第 3 步：验证后端可跑

```bash
npm test                      # 应 6/6 套件通过
npm start &                   # 或用下面的自启方式
curl -s localhost:3721/health # 应返回健康状态
```

若 `npm test` 挂了 1~2 项，先读 `MIGRATION.md` 的「常见问题」，不要盲改业务代码。

### 第 4 步：安装浏览器扩展

在浏览器扩展管理页选择「加载已解压的扩展程序」，选 `workAssistant/extension` 目录。

**记下新生成的扩展 ID**（32 位），下一步要用。

### 第 5 步：注册开机自启 + Native Messaging

```bash
npm run setup:auto-start
```

⚠️ **顺序不能反**：必须先完成第 4 步拿到真实扩展 ID 再执行本步。
脚本要把 `allowed_origins` 写成真实的 32 位 ID（Chromium 不支持通配符），
ID 错了后端就永远连不上。

本机默认浏览器可能是 Helium / Chrome / Firefox，按实际情况选。

### 第 6 步：交付确认

跑一次端到端验证并向用户汇报：

```bash
curl -s localhost:3721/health
curl -s localhost:3721/api/tasks | head -c 300
launchctl print gui/$(id -u)/com.workassistant.backend >/dev/null 2>&1 && echo "自启已注册"
```

## 需要迁移任务数据时（可选）

`data/` 含真实任务与历史，**不入库**，需单独拷贝：

```bash
tar czf ~/workassistant-data.tar.gz -C /path/to/workAssistant data
# 新机器
tar xzf ~/workassistant-data.tar.gz -C /path/to/workAssistant
launchctl kickstart -k gui/$(id -u)/com.workassistant.backend
```

## 已知坑（`MIGRATION.md` 有完整版）

- **Clash Verge TUN 模式**会劫持内网流量，禅道 `10.128.1.8:8088` 表现是「TCP 通但 HTTP 空响应，curl exit 52」。解法：给 `10.0.0.0/8` 加 DIRECT 规则。
- **macOS TCC**：项目若放在 `~/Documents` 下，后台进程（launchd、浏览器拉起的宿主）访问时会**阻塞**而非报错，表现为进程存在但无套接字、日志无输出。排查：`sample <pid> 2`，栈停在 `node::ReadFileSync → uv_fs_open → open()` 即确诊。解法：项目移到非受保护目录。
- **扩展 ID 按安装路径哈希派生**，换机必变，宿主清单必须重生成。
- **改服务配置后要 `launchctl bootout` 再 bootstrap**，否则 launchd 继续用内存里的旧定义，出现「配置已改、进程没换」的假生效。

## 汇报要求

迁移完成后，向用户说明：后端健康状态、扩展是否装上、`npm test` 结果、
以及哪些内容属于机器相关无法迁移（如任务数据 `data/`）。
若某一步失败，**如实报告失败原因和已尝试的方案**，不要报「已完成」。