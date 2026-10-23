# 禅道助手

把禅道的待办、任务、Bug、需求、文档、工时和日报 / 周报 / 月报放进浏览器新标签页的个人工作台。浏览器扩展负责界面，本机后台服务负责连接禅道和 AI；数据都留在你自己的电脑上。

## 功能

标签页顺序：待办 → 任务 → Bug → 需求 → 文档 → 工作日历。

- **待办**：一屏看到该处理的事——未完成的任务、待处理的 Bug、指派给你或评审中的需求、全部文档（任务和 Bug 一排，需求和文档一排）。点一条跳到对应标签页并高亮闪烁；最近几个工作日一小时工时都没填会在顶部提醒。标签上的角标是待办总数。
- **任务看板**：待办 / 进行中 / 已完成三列，拖拽改状态并记工时；卡片上直接改标题、优先级、截止时间、所属执行；附件与截图（截图会插入禅道正文）。
- **Bug 看板**：未确认 / 已确认 / 已解决三列，拖拽即确认、解决、激活；卡片和详情里可改标题、优先级、严重程度、指派人（可附备注）。同步「指派给我 / 由我创建 / 抄送给我 / 由我指派」的未解决 Bug。
- **需求**：浏览与你相关的需求（你提的 / 指派你的 / 你评审的 / 抄送你的），按产品和状态筛选、搜索；新建、编辑（评审中的会自动先撤回评审）、删除；详情里看描述、验收标准和附件。
- **文档**：浏览、搜索、查看禅道文档（Markdown 按渲染效果显示）；新建、编辑、删除、收藏；附件预览和下载。
- **Bug 转任务 / 需求拆任务**：Bug 详情「转任务」、激活需求详情「拆任务」，在所选执行里建任务并与 Bug / 需求关联（建完回读核对）；已转过的 Bug 不能重复转。
- **工作日历**（原「报告」）：日历里每一天显示当天工时（填满 / 不足 / 缺填一眼可见，今天高亮），点某一天可查看、**填报、补填过去的日期、修改、删除**工时；剩余工时填 0 会先确认「任务将标记为已完成」。「全员」视角看团队每天的工时与成员 × 日期热力图。日历下方有按执行、任务 Top5 的统计，也能打开每天 / 每周 / 每月的日报周报月报（AI 按人、按项目总结，可推送到企业微信 / 钉钉 / 飞书机器人）。
- **禅道同步**：以禅道为准，禅道里删除的任务 / Bug 会从插件移除；搜索直接查禅道全局搜索。需求、文档、工时在本机做了缓存：先显示缓存、再向禅道要最新的，页头会提示「已同步」。
- **AI 解析**：一句话新建任务 / Bug，自动识别执行、优先级、时间；任务解析与报告总结可分别选模型，支持测速推荐。
- **账号与设置**：首次打开弹出禅道登录卡片，右上角头像显示连接状态。设置以后端为准，浏览器里只留缓存并静默校对（多处同时修改时保存会提醒冲突）；可设置每日标准工时、**法定节假日 / 调休日**（不算缺填）；配置可加密导出 / 导入，换电脑不用重新配置。

### 调试模式（高级）

设置右上角的「调试模式」开关打开后，工作日历里**过去的、工时不满标准的工作日**右上角会出现「补」，「本月」按钮后面也有一个「补」：用你真实的进行中任务把缺的工时补上，工作内容由 AI 结合任务和你以前的写法来写。**每次都要先预览、可逐条修改，确认后才写入；每一批都有记录，可一键撤销。**只用「进行中、当天已存在、剩余工时大于 0」的任务，写入时沿用任务当前的剩余工时，不会改变任务状态。参数（每天任务数、单条小时范围、给 AI 的额外要求等）在「设置 → 禅道集成」里调试模式下才出现的区块。写入的是团队的正式工时记录，请按你们的规定使用。

## 系统要求

- macOS（Intel 或 Apple 芯片），或 Windows 10（1803 及以上）/ Windows 11。不需要管理员权限。
- Chromium 内核的浏览器：Chrome、Edge、Brave、Helium、Arc、Vivaldi 等。
- 能访问你们的禅道（公司内网 / VPN）。
- 不需要预先安装 Node.js：安装器会自带。

## 安装

### macOS

#### 1. 运行安装命令

打开「终端」，粘贴运行：

```bash
curl -fsSL https://gitee.com/iTreeNewBee/work-assistant/releases/latest/download/install.sh | bash
```

> 默认从 Gitee 下载（国内更稳）；安装器下载安装包时会在 Gitee 连不上时自动回退 GitHub。
> 若连 `install.sh` 这步都拿不到（Gitee、GitHub 都不通，如纯内网），把域名在 gitee / github 间换一个再试；仍不行可让管理员用离线安装包（`install.ps1 -Package <本地包>`，Windows 还支持 `-NodeZip <本地 Node>`）。

安装器不问任何问题，大约 1～3 分钟（主要是下载）。它会：

1. 下载并校验 Node 运行环境（官方源，连不上自动换国内镜像）和最新版的禅道助手安装包；
2. 安装到 `~/Library/Application Support/WorkAssistant`；
3. 注册开机自启（登录 macOS 后自动在后台运行）和浏览器宿主（插件需要时可拉起后台）；
4. 启动后台服务并核对版本；
5. 打开浏览器扩展页，并把扩展目录复制到剪贴板。

看到 `✓ 安装完成：禅道助手 x.y.z` 即成功。

#### 2. 在浏览器里加载扩展（只需一次）

1. 在浏览器的扩展页（地址 `chrome://extensions`，安装器已自动打开）打开右上角的 **开发者模式**；
2. 如果以前装过「工作助手」（旧名称）或「禅道助手」，先把旧的 **移除**；
3. 点 **加载已解压的扩展程序**，在弹出的选择框里按 `⌘ ⇧ G`，粘贴下面的目录（已在剪贴板里），回车后点「选择」：

   ```
   ~/Library/Application Support/WorkAssistant/extension
   ```

### Windows

打开「PowerShell」（开始菜单搜索 PowerShell），粘贴运行：

```powershell
curl.exe -fsSL -o "$env:TEMP\wa-install.ps1" https://gitee.com/iTreeNewBee/work-assistant/releases/latest/download/install.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\wa-install.ps1"
```

与 Mac 一样不问任何问题、不需要管理员权限，装到 `%LOCALAPPDATA%\WorkAssistant`，注册开机自启（当前用户的启动项）和浏览器宿主（Chrome、Edge、Brave、Chromium、Vivaldi），启动后台并打开扩展页、把扩展目录复制到剪贴板。然后在扩展页打开 **开发者模式** → **加载已解压的扩展程序** → 在选择框的地址栏粘贴目录：

```
%LOCALAPPDATA%\WorkAssistant\extension
```

### 首次使用（Mac / Windows 相同）

打开一个新标签页：

- **登录禅道**：在登录卡片里填禅道地址（例如 `http://10.x.x.x:8088`，粘贴浏览器地址栏里的整串网址也可以）、账号、密码。登录前会先验证，成功后自动同步执行、团队成员、你的任务和 Bug。
- **从旧电脑搬配置**：点登录卡片上的「已有配置文件？导入」，选择在旧电脑「设置 → 数据迁移」里加密导出的文件，输入导出时设的口令。禅道账号密码、AI Key、推送地址等会一起恢复。
- **配置 AI（可选）**：「设置 → AI 配置」。不配也能用，新建任务会改用本地规则解析。
- 也可以先点「稍后再说」进入本地模式，之后随时点右上角「登录禅道」。

## 更新

**自动更新（1.2.0 起）**：不用做任何事。

- 后台每 6 小时检查一次新版本（默认从 Gitee 下载，连不上自动换 GitHub），下载后校验哈希和发版签名，签名对不上的包不会安装；
- 等你没在用的时候安装（3 分钟没有操作，并避开早晚提醒、日报、周报的时间段），后台重启一两秒；
- 浏览器里的插件发现文件变了会自动重新加载，已打开的新标签页会自动刷新成新版本；
- 新版本如果启动不起来，会自动退回上一个版本，并且不再自动安装这个版本；
- 「设置 → 关于」里可以看当前版本、检查更新、立即更新，或关掉自动更新。

**手动更新**：重新运行一次安装命令。以下情况需要手动更新：

- 1.1.x 升级到 1.2.0（1.2.0 才有自动更新）；
- 「设置 → 关于」提示「需要更新运行环境」（新版本需要更高的 Node）。

手动更新同样保留上一个版本、沿用现有的配置和数据；更新后在浏览器扩展页点「禅道助手」上的刷新按钮。

## 卸载

Mac：

```bash
curl -fsSL https://gitee.com/iTreeNewBee/work-assistant/releases/latest/download/install.sh | bash -s -- --uninstall
```

Windows（PowerShell）：

```powershell
curl.exe -fsSL -o "$env:TEMP\wa-install.ps1" https://gitee.com/iTreeNewBee/work-assistant/releases/latest/download/install.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\wa-install.ps1" -Uninstall
```

- 默认 **保留数据和配置**（重新安装后自动使用）；
- 连数据一起删除：Mac 把末尾的 `--uninstall` 换成 `--uninstall --purge`，Windows 在 `-Uninstall` 后面加 `-Purge`；
- 最后在浏览器扩展页移除「禅道助手」。

## 文件都在哪里

```
~/Library/Application Support/WorkAssistant/
├─ runtime/node/      自带的 Node 运行环境
├─ versions/<版本>/   程序（保留上一个版本用于回滚）
├─ current.txt        当前使用的版本
├─ extension/         浏览器加载的扩展目录（更新时替换里面的文件）
├─ bin/               开机自启、浏览器宿主的固定入口
├─ data/              配置（.env）、任务、Bug、报告、附件（只有你自己可读）；update.json 是自动更新的设置；
│                     cache/ 是需求、文档、工时的本地缓存（可随时删，会自动重建）；client-settings.json 是各 AI 服务商记住的地址与模型；
│                     autofill-log.json 是「补」写入过哪些工时的记录（用于撤销）
├─ backups/           迁移 / 升级前的备份
├─ downloads/         自动更新下载中的临时文件
└─ update-bad.txt     启动失败、已自动退回的版本（不再自动安装）

~/Library/Logs/WorkAssistant/backend.log   后台服务日志
```

Windows 在 `%LOCALAPPDATA%\WorkAssistant\`，结构相同；日志在其中的 `logs\backend.log`。后台由守护进程（`bin\supervisor.cjs`，隐藏窗口）运行：崩溃自动拉起，自动更新后的启动自检与回滚也由它完成。

配置（禅道密码、AI Key 等）只保存在本机 `data/.env` 里，不会上传到任何地方；只有在「数据迁移」里用你设置的口令加密导出时才会离开这台电脑。

## 常见问题

**插件提示连不上本地服务**
看后台服务是否在运行：

```bash
curl -s http://127.0.0.1:3721/health
```

（Windows 在 PowerShell 里用 `curl.exe`。）没有输出就重启它：

```bash
launchctl kickstart -k gui/$(id -u)/com.workassistant.backend      # Mac
wscript "$env:LOCALAPPDATA\WorkAssistant\bin\workassistant.vbs"    # Windows（PowerShell）
```

仍然不行，查看日志（Mac：`~/Library/Logs/WorkAssistant/backend.log`；Windows：`%LOCALAPPDATA%\WorkAssistant\logs\backend.log`），或重新运行安装命令。

**登录禅道提示「无法连接」**
确认已连公司内网 / VPN，地址填禅道首页的地址（带端口）。

**右上角头像是灰点**
连不上禅道（多半是没连 VPN），连上后会自动恢复。红点表示禅道密码已失效，按提示重新输入密码。

**旧版本（从仓库目录运行的）怎么升级**
直接运行安装命令。安装器会认出旧的开机自启项，把仓库里的 `.env` 和 `data/` 先完整备份、再迁移到新位置（仓库目录不动）。然后按「加载扩展」一节在浏览器里移除旧插件、加载新目录。

**打开插件没有登录卡片、右上角还是「设置」按钮，或提示「后台服务版本过旧」**
多半是以前用旧方式（旧版 `install.sh`、`start.sh`、`npm start`）启动的后台还在运行，占着 3721 端口。重新运行安装命令即可：安装器会认出并停掉旧的后台（顺带迁移它目录里的配置和数据），再启动新的。然后确认浏览器扩展页里「禅道助手」的 ID 是 `eoabdnjlihliplmaopdfkmmghmhfeefc`，有旧的「禅道助手」就移除。

**安装提示「端口 3721 被另一个程序占用」**
提示里会写明是哪个程序；关掉它后重新运行安装命令。安装失败时安装器会自动打印排查信息（端口占用、开机自启状态、日志末尾）。

## 开发

```bash
git clone https://github.com/rskdwypy-pixel/workAssistant.git   # 或 https://gitee.com/iTreeNewBee/work-assistant.git
cd workAssistant
npm install
npm test                       # 全部测试（jsdom 前端测试 + 后端测试 + 安装器测试 + 仓库卫生检查），约 3 分钟
npm start                      # 在仓库里直接运行后台服务（使用仓库里的 data/ 和 .env）
```

开发时在浏览器里加载仓库里的 `extension/` 目录即可（扩展 ID 是固定的，与目录无关）。注意同一台电脑上不要同时运行安装版和仓库版：两者都用 3721 端口。

**注意：不要把抓包得到的 cURL / 响应提交进仓库**（里面有真实会话 cookie）。`docs/zentao-*capture*/` 已被忽略，`npm test` 里的仓库卫生检查会拦住已跟踪文件里的 cookie、密钥和抓包目录。

**打包与本地安装测试**

```bash
node scripts/build-package.mjs                                        # 生成 dist/workassistant-<版本>.tar.gz 和 .sha256
bash installer/install-mac.sh --package dist/workassistant-<版本>.tar.gz   # 用本地安装包安装 / 升级
```

版本号以 `package.json` 为准，打包时会同步到 `extension/manifest.json`。

**发版**

```bash
npm version 1.2.0          # 改版本号并同步到扩展，提交并打标签 v1.2.0
git push --follow-tags     # 推送标签后，GitHub Actions 自动测试、打包、签名并发布
```

发版流水线见 `.github/workflows/release.yml`：推 `v*` 标签后在 GitHub 上测试、打包、签名并发布。**Gitee 不在流水线里同步**（海外机器传 Gitee 大文件经常卡住）：GitHub 发布成功后，在本机运行 `npm run release:gitee`（可加版本号，如 `npm run release:gitee -- v1.4.1`），它会把该版本的代码和标签推到 Gitee、从 GitHub Release 下载产物并发布到 Gitee、最后验证下载地址；可重复运行。需要 `gh` 已登录和 Gitee 私人令牌（发行版权限），令牌放环境变量 `GITEE_TOKEN` 或 `~/.config/workassistant/gitee-token`（`chmod 600`），不要写进仓库。安装器和自动更新默认从 Gitee 下载、连不上回退 GitHub，所以每次发版别忘了这一步。

安装包用 Ed25519 签名，已安装的电脑只自动安装签名对得上的包：

- 公钥在 `src/services/releaseKey.js`；
- 私钥不在仓库里：仓库 Secret `RELEASE_SIGNING_KEY`（流水线用），维护者本机 `~/.config/workassistant/release-signing-key.pem`（手动签名：`node scripts/sign-package.mjs <安装包>`）；
- 换密钥要同时改公钥和 Secret，已安装的电脑需要重新运行一次安装命令。

**目录结构**

```
src/          后台服务（Express）：禅道、AI、需求 / 文档 / 工时 / 待办、报告、附件、账号、配置迁移
extension/    浏览器扩展（Manifest V3，新标签页）
scripts/      启动器、开机自启、浏览器宿主注册、打包 / 签名脚本与测试；scripts/bin/ 是安装目录 bin/ 下固定入口的模板
installer/    安装器（install-mac.sh）
.github/      发版流水线
docs/         设计与审计文档
```
