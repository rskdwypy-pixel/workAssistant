# 换机迁移指南

> **让新机器上的 AI 来做？** 把 [`NEW-MACHINE-PROMPT.md`](NEW-MACHINE-PROMPT.md)
> 全文复制给它即可，里面是完整可执行的指令。

目标：新机器拉取代码后，恢复到与旧机器一致的可运行状态。

## 一条命令的版本（配置已加密入库）

```bash
git clone https://github.com/rskdwypy-pixel/workAssistant.git
cd workAssistant
./scripts/export-secrets.sh import   # 输入导出时设的口令
```

`import` 会自动完成：解密 `.env` → `npm install` → 自检禅道配置项。
末尾会打印仍需手动完成的步骤。

配置变更后重新导出，**一条命令即可**（加密 + 提交 + 推送全自动）：

```bash
./scripts/export-secrets.sh export
```

> 注意脚本名统一是 `export-secrets.sh`，用子命令区分 export / import。

再补两个**无法随代码迁移**的步骤（与机器/路径相关）：

```bash
npm run setup:auto-start         # 注册开机自启 + Native Messaging 宿主
```

最后在浏览器扩展管理页加载 `extension/` 目录。

> ⚠️ 扩展 ID 由**安装路径**派生，换机后 ID 必然变化。
> `scripts/install-native-host.sh` 依赖 `allowed_origins` 写入真实 32 位 ID，
> 所以必须先在浏览器加载扩展、拿到新 ID，再跑上面的注册命令（顺序不能反）。

---

## 为什么不直接把 .env 提交进仓库

本仓库是 **PUBLIC（公开）**，`https://github.com/rskdwypy-pixel/workAssistant`
匿名可访问。`.env` 里是 AI API Key、禅道账号密码和内网地址。

一旦明文提交，后果是不可逆的：

- git 历史**无法真正删除**。任何人 clone 都拿到了完整密钥，
  即使之后 `git rm` 也只是「当前版本看不到」，旧提交仍在。
- GitHub 的 Secret Scanning 会自动检测并可能推送告警；
  已泄露的密钥通常需要**立即在服务商后台轮换（作废重发）**，改历史没用。
- 仓库 Fork、第三方镜像、CI 缓存都会各自留一份副本。

所以改用**口令加密**：`.env` 用 AES-256-CBC + PBKDF2(20 万次迭代) 加密成
`secrets.env.enc` 提交。换机时输入口令还原，全程明文密钥不经网络。

安全性取决于你的口令强度，请用与其他账号**不同**的密码，存在密码管理器里。
口令遗失 = 密钥无法还原，只能重新配置。

---

## 导出（新机器之前做一次）

```bash
./scripts/export-secrets.sh      # 输入口令，确认二次
git add secrets.env.enc
git commit -m "chore: 更新加密配置"
git push
```

`.env` 本身始终被 `.gitignore` 忽略，不会被提交。

## 导入（新机器）

```bash
./scripts/import-secrets.sh      # 输入口令
```

会校验口令正确性（错误口令直接失败，不会写出半截文件）；
若本机已有 `.env`，会先自动备份再覆盖。

---

## 不会被迁移的东西（必须在新机重建）

以下内容与**本机路径/浏览器/系统**绑定，无法随 git 迁移：

| 项目 | 原因 | 重建方式 |
|---|---|---|
| `node_modules/` | 被 gitignore | `npm install` |
| `scripts/.node-path` | 含本机 node 绝对路径 | 安装脚本自动生成 |
| 扩展 ID | Chromium 按**安装路径**哈希派生 | 换路径即变，需重新注册宿主清单 |
| LaunchAgent plist | 含本机路径 | `npm run setup:auto-start` |
| `data/` | 含真实任务数据，被 gitignore | 见下方「迁移任务数据」 |

## 迁移任务数据（可选）

`data/` 含真实任务与历史记录，不入库。需要单独拷贝：

```bash
# 旧机器
tar czf ~/workassistant-data.tar.gz -C ~/path/to/workAssistant data

# 新机器（解压到项目目录后）
tar xzf ~/workassistant-data.tar.gz -C ~/path/to/workAssistant
```

拷贝后重启服务：

```bash
launchctl kickstart -k gui/$(id -u)/com.workassistant.backend
```

---

## 验证迁移成功

```bash
npm test                # 98 项断言，应全部通过
curl -s localhost:3721/health
```

`npm test` 需要 `npm install` 装上 devDependencies（jsdom / acorn），
不要依赖全局 NODE_PATH——那在别的机器上不存在。

## 常见问题

**装完扩展但连不上后端**
先确认服务在跑：`curl localhost:3721/health`。
再确认 Native Messaging 宿主清单里的 `allowed_origins` 是**当前**扩展 ID。

**服务进程存在但无响应（macOS 卡在读文件）**
项目放在 `~/Documents` 下会被 macOS TCC 拦截。后台进程（launchd、浏览器拉起的
宿主）访问 `~/Documents` 时 `open()` 会**阻塞**而非报错，表现为进程存在但无套接字。
排查：`sample <pid> 2`，栈停在 `node::ReadFileSync → uv_fs_open → open()` 即确诊。
解法：把项目移到 `~/.workassistant` 等非受保护目录。

**禅道接口报 fetch failed**
Clash Verge 的 TUN 模式会劫持内网流量。`nc` 能连通但 HTTP 空响应、
`curl` exit 52 是典型特征。给内网网段（如 `10.0.0.0/8`）加 DIRECT 规则。