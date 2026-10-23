# 补抓任务：执行 61 里「建任务」的成功请求（给抓包 AI）

背景：插件用后端 `POST task-create-61-…` 提交，禅道返回的是表单页（HTTP 200，无任何错误提示），任务没建出来；
同样的字段在普通执行里能成功。需要看浏览器里**成功**的那一次到底发了什么。

## 要做的（只建自己的测试数据，标题带「【插件联调·可删】」，做完删除并报告）

在**同一个登录会话的浏览器**里，对执行 **61**（真机拨测看板-建任务，产品 20）：

1. 建一个**不带需求**的任务（看板界面「+ 添加任务」）。
2. 建一个**带需求 #120** 的任务（需求下拉里选 #120；`task-create-61-120-0` 打开）。

每次抓：
- 完整请求 URL（含 `?onlybody=yes` 等）、方法、**全部请求头**（Content-Type 含 boundary 类型、X-Requested-With、Referer、Accept）；
- 请求体**每个字段原样**（含空字段、数组字段 `assignedTo[]`、`team[]` 的个数、`execution`、`region`、`lane`、`column` 之类看板字段、`uid`、`after`）；
- 响应状态码与原文；
- 之后任务详情 `task-view-{id}.json` 里的 `story`、`storyTitle`、`execution`，以及需求 120 的 `stage`/`status` 变化。

另外回答：
- 点「添加任务」前，页面有没有先发过某个请求（如 ajaxGetExecutions / 设置当前执行 / 切换项目）？请列出提交前的所有 XHR。
- 浏览器 Cookie 里除 zentaosid 外还有哪些**名字**（只要名字，不要值），如 `preExecutionID`、`lastExecution`、`projectID`、`tab` 之类。

## 约束
- cookie、密码、token 一律替换为 `<COOKIE>` / `<PASSWORD>`，报告里不要出现真实值。
- 交付放 `docs/zentao-capture-<日期>-task-create-61/`（该目录已被 git 忽略）。
- 清理：删除自己建的任务；顺带把遗留任务 **965**「【插件联调·可删】任务A1」（执行 47）删掉。
