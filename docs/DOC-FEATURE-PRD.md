# 文档中心 PRD 与实现说明

> 状态：P0 开发中（浏览 / 查看 / 下载 / 搜索）
> 作者：产品 + 研发（Claude 协助）
> 日期：2026-10-23

在「任务 / Bug / 报告」同级新增「📁 文档」标签页，把禅道的文档搬进插件：**浏览、查看、下载、上传**。
定位是"禅道文档的轻量工作台"，不做在线富文本编辑器（成本高、禅道版本差异大），正文的新建/编辑走表单或跳回禅道网页。

## 1. 目标与非目标

**目标**
- 在插件内按文档库 / 目录浏览禅道文档，查看正文与附件，下载文件。
- 上传本地文件为"文件型文档"，或新建"正文型文档"。
- 数据实时以禅道为准，不展示已删除文档。

**非目标（P0）**
- 不做富文本所见即所得编辑器。
- 不做文档权限管理、评论、版本对比编辑。

## 2. 禅道文档模型（基于真实实例 http://10.128.1.8:8088 抓取冻结）

该实例为 ZenTao 18+（`vision=rnd`）。结构三层：

```
文档库(doclib) ── 目录(module，可多级) ── 文档(doc)
```

**文档库按归属分空间**，接口 `doc-objectLibs-{type}.json` 返回各空间的库：

| space(type) | 示例库 | 说明 |
|---|---|---|
| product | 75 产品主库（docCount 3） | 挂在产品下 |
| project | 109 项目主库 | 挂在项目下 |
| execution | 185 迭代主库 | 挂在执行/迭代下 |
| custom | 59 接口文档库 | 团队自定义库 |
| mine | — | 个人空间（见 `doc-index` 的 myDocs/collectedDocs） |

库对象字段：`id, type, name, product/project/execution, acl(default/custom/open), main, docCount, deleted`。

**文档对象**（`doc-view-{id}.json` → `data.doc`）关键字段：
`id, lib, module, parent, grade, order, title, type, contentType, content, files[], addedBy, editedBy, editedDate, acl, deleted, productName, executionName, moduleName`。

- `type`：`text`（正文）/ `word|ppt|excel`（Office 附件型）/ `attachment`（上传文件）/ `url`（外链）。本实例现有 6 篇均为 `text`。
- `contentType`：`html` / `markdown`。正文 html 内含内联图片 `/zentao/file-read-N.ext`。
- `files[]`：附件数组（文件型文档的正文为空，内容在 files）。

## 3. 冻结的接口路由（经真实实例验证）

| 用途 | 路由 | 验证 |
|---|---|---|
| 全部可见文档（骨干） | `doc-browse.json` → `data.docs{}`（map），`pager` 分页 | ✅ 返回 6 篇，等于 statisticInfo.totalDocs |
| 各空间文档库 | `doc-objectLibs-{product\|project\|execution\|custom}.json` → `data.libs{}` | ✅ |
| 个人空间统计 | `doc-index.json` → `data.{myDocs, collectedDocs, statisticInfo, latestEditedDocs}` | ✅ |
| 文档详情 | `doc-view-{id}.json` → `data.doc` | ✅ |
| 文件预览/下载 | 复用现有 `GET /api/zentao/files/:fileId/content?ext=&download=1`（后端转发 `file-read-N.ext` / `file-download-N`） | ✅ 已有 |
| 新建正文文档（P1） | `doc-create-...` 表单 | 待抓 |
| 给文档加附件（P1，已完成 2026-10-23） | 文档编辑表单的 `files[]` + `labels[]`（multipart，一次一个，回读确认附件数真的多了）；新建时先建文档再逐个追加 | 已实测。"文件型文档"（`doc-uploadDocs`）在目标禅道 18.3 开源版不可用（返回空），所以不做 |

> 说明：**按库列出文档不走 `doc-browse-{libID}`**（实测该参数组合返回空，禅道各版本参数位不同、易碎）。改为拉 `doc-browse.json` 全量后端按 `lib`/`module` 分组，稳健且跨版本。全量随 `pager` 翻页。

## 4. 信息架构与交互

```
┌─────────────┬──────────────────────────────┐
│ 文档库树     │  文档列表 / 文档详情           │
│ ▸ 我的空间   │  [搜索框]        [⬆ 上传文档]  │
│ ▸ 自定义库   │  📄 需求评审纪要  张三 10-20   │
│   接口文档库 │  📎 接口文档.pdf  李四 10-18   │
│ ▸ 产品库     │  🔗 竞品分析链接  王五 10-15   │
│   产品主库   │                               │
└─────────────┴──────────────────────────────┘
```

- 左：空间 → 文档库（懒展开），显示库名与文档数；选中库过滤右侧列表。
- 右：当前库的文档列表（标题、类型图标、作者、更新时间）；顶部搜索框按标题过滤。
- 详情：正文型渲染 HTML（已消毒 + 内联图改写为后端代理）+ 附件列表；文件型直接给预览/下载；顶部「在禅道中打开」按钮复用现有自动登录跳转。

## 5. 后端设计

- `src/services/docService.js`
  - `listLibs()` → 汇总 4 个 `doc-objectLibs-{type}` 的库 + 个人空间，返回扁平库列表 `{id,name,space,spaceLabel,docCount}`。
  - `listDocs()` → 翻页拉 `doc-browse.json`，返回全部可见文档（过滤 `deleted`），带 `lib/module/type/title/editedBy/editedDate`。
  - `getDoc(id)` → `doc-view-{id}`，返回 `{doc, contentHtml(已消毒改写), files}`。
- `src/routes/docs.js`
  - `GET /api/docs/libs`
  - `GET /api/docs/list`（可选 `?keyword=` 后端兜底过滤）
  - `GET /api/docs/:id`
  - 文件内容复用 `GET /api/zentao/files/:fileId/content`。
- 安全：正文 HTML 后端消毒（去 `<script>/<style>/<iframe>/<object>/<embed>`、`on*` 事件属性、`javascript:` 链接），内联图片 `file-read-N` 改写为 `/api/zentao/files/N/content?ext=`。

## 6. 前端设计

- `extension/newtab.html`：新增 `data-mode="doc"` 标签 + `#docMode` 容器 + 引入 `docs.js`。
- `extension/docs.js`：`DocApi` + `DocPage`（库树 + 列表 + 详情弹窗），镜像 `reports.js` 的全局挂载与本地（未登录）兜底。
- `extension/newtab.js`：`switchMode` 增加 `doc` 分支调用 `DocPage.show()`。
- `extension/newtab.css`：文档页样式（树、列表、详情）。

## 7. 验收标准（P0）

- 文档库树与禅道一致；选库能过滤文档。
- 正文型文档内容正确渲染、内联图片可见、无脚本注入；附件可下载/预览。
- 列表实时来自禅道，不含已删除文档。
- 未登录禅道时给出登录入口（与报告页一致）。

## 8. 分期

- **P0（本次）**：浏览 + 查看 + 下载 + 搜索。
- **P1**：上传文件 / 新建正文文档（抓 `doc-create` 表单后实现）。
- **P2**：收藏、版本历史、删除/移动、服务端搜索。

## 9. 后续可做的其他禅道需求（调研结论，按价值排序）

1. ⭐⭐⭐ 需求/用户故事（story）菜单——复用任务卡片交互。
2. ⭐⭐⭐ 全局搜索 + 待办/通知中心。
3. ⭐⭐ 工时（effort）填报（已有 recordEstimate 基础）。
4. ⭐⭐ 执行看板（按状态列）。
5. ⭐⭐ Bug 转任务 / 需求拆任务。
6. ⭐⭐ 「我的待办」聚合首页。
7. ⭐ 评论/沟通、测试单、版本发布。

建议路线：文档（本次）→ 需求菜单 → 待办聚合 + 通知 → 工时。
