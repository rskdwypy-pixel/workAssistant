# 禅道 18.3 开源版 API 接口文档

**基础地址**: `http://10.128.1.8:8088`

**接口格式**: `/zentao/{module}-{action}-{params}.json`

**说明**:
- 路径中的 `[xxx]` 是动态参数，需要替换成实际值
- 空参数用 `-` 表示
- 返回格式均为 JSON

---

## 目录

- [系统相关 (index)](#系统相关-index---4个)
- [产品相关 (product)](#产品相关-product---43个)
- [项目相关 (project)](#项目相关-project---52个)
- [任务相关 (task)](#任务相关-task---35个)
- [Bug 相关 (bug)](#bug-相关-bug---42个)
- [数据字典](#数据字典)

---

## 系统相关 (index) - 4个

| 接口 | 方法 | 路径 | 参数 |
|------|------|------|------|
| 首页 | GET | `/zentao/index-index-[open].json` | open: string |
| 变更日志 | GET | `/zentao/index-changeLog-[version].json` | version: string |
| 清除会话 | GET/POST | `/zentao/index-ajaxClearObjectSession.json` | - |
| 获取视图方法 | GET | `/zentao/index-ajaxGetViewMethod-[objectID]-[objectType].json` | objectID: int, objectType: string |

---

## 产品相关 (product) - 43个

### 核心接口

| 接口 | 方法 | 路径 | 参数 |
|------|------|------|------|
| 产品列表 | GET | `/zentao/product-index-[locate]-[productID]-[status]-[orderBy]-[recTotal]-[recPerPage]-[pageID].json` | locate, productID, status, orderBy, recTotal, recPerPage, pageID |
| 浏览产品 | GET | `/zentao/product-browse-[productID]-[branch]-[browseType]-[param]-[storyType]-[orderBy]-[recTotal]-[recPerPage]-[pageID]-[projectID].json` | productID, branch, browseType, param, storyType, orderBy, recTotal, recPerPage, pageID, projectID |
| 查看产品 | GET | `/zentao/product-view-[productID].json` | productID |
| 创建产品 | GET/POST | `/zentao/product-create-[programID]-[extra].json` | programID, extra |
| 编辑产品 | GET/POST | `/zentao/product-edit-[productID]-[action]-[extra]-[programID].json` | productID, action, extra, programID |
| 批量编辑 | GET/POST | `/zentao/product-batchEdit-[programID].json` | programID |
| 关闭产品 | GET/POST | `/zentao/product-close-[productID].json` | productID |
| 删除产品 | GET | `/zentao/product-delete-[productID]-[confirm].json` | productID, confirm (yes\|no) |
| 产品路线图 | GET | `/zentao/product-roadmap-[productID]-[branch].json` | productID, branch |
| 产品动态 | GET | `/zentao/product-dynamic-[productID]-[type]-[param]-[recTotal]-[date]-[direction].json` | productID, type, param, recTotal, date, direction |
| 产品仪表盘 | GET | `/zentao/product-dashboard-[productID].json` | productID |
| 需求追踪 | GET | `/zentao/product-track-[productID]-[branch]-[projectID]-[recTotal]-[recPerPage]-[pageID].json` | productID, branch, projectID, recTotal, recPerPage, pageID |

### AJAX 接口

| 接口 | 方法 | 路径 | 参数 |
|------|------|------|------|
| 获取产品列表 | GET | `/zentao/product-ajaxGetProducts-[executionID].json` | executionID |
| 获取产品详情 | GET | `/zentao/product-ajaxGetProductById-[productID].json` | productID |
| 获取项目 | GET | `/zentao/product-ajaxGetProjects-[productID]-[branch]-[projectID].json` | productID, branch, projectID |
| 按分支获取项目 | GET | `/zentao/product-ajaxGetProjectsByBranch-[productID]-[branch]-[number].json` | productID, branch, number |
| 获取执行列表 | GET | `/zentao/product-ajaxGetExecutions-[productID]-[projectID]-[branch]-[number]-[executionID]-[from]-[mode].json` | productID, projectID, branch, number, executionID, from, mode |
| 按项目获取执行 | GET | `/zentao/product-ajaxGetExecutionsByProject-[productID]-[projectID]-[branch]-[number].json` | productID, projectID, branch, number |
| 获取计划 | GET | `/zentao/product-ajaxGetPlans-[productID]-[branch]-[planID]-[fieldID]-[needCreate]-[expired]-[param].json` | productID, branch, planID, fieldID, needCreate, expired, param |
| 获取产品线 | GET | `/zentao/product-ajaxGetLine-[programID]-[productID].json` | programID, productID |
| 获取评审人 | GET | `/zentao/product-ajaxGetReviewers-[productID]-[storyID].json` | productID, storyID |
| 设置会话状态 | GET | `/zentao/product-ajaxSetState-[productID].json` | productID |

### 其他接口

| 接口 | 方法 | 路径 | 参数 |
|------|------|------|------|
| 关联项目 | GET | `/zentao/product-project-[status]-[productID]-[branch]-[involved]-[orderBy]-[recTotal]-[recPerPage]-[pageID].json` | status, productID, branch, involved, orderBy, recTotal, recPerPage, pageID |
| 看板 | GET | `/zentao/product-kanban.json` | - |
| 管理产品线 | GET/POST | `/zentao/product-manageLine.json` | - |
| 获取白名单 | GET | `/zentao/product-whitelist-[productID]-[module]-[objectType]-[orderBy]-[recTotal]-[recPerPage]-[pageID].json` | productID, module, objectType, orderBy, recTotal, recPerPage, pageID |
| 添加白名单 | GET | `/zentao/product-addWhitelist-[productID]-[deptID]-[copyID].json` | productID, deptID, copyID |
| 解绑白名单 | GET | `/zentao/product-unbindWhitelist-[id]-[confirm].json` | id, confirm |
| 导出产品 | GET/POST | `/zentao/product-export-[status]-[orderBy].json` | status, orderBy |
| 产品构建 | GET | `/zentao/product-build-[productID]-[branch].json` | productID, branch |
| 更新排序 | GET/POST | `/zentao/product-updateOrder.json` | - |
| 显示设置 | GET/POST | `/zentao/product-ajaxSetShowSetting.json` | - |

---

## 项目相关 (project) - 52个

### 核心接口

| 接口 | 方法 | 路径 | 参数 |
|------|------|------|------|
| 项目列表 | GET | `/zentao/project-browse-[programID]-[browseType]-[param]-[orderBy]-[recTotal]-[recPerPage]-[pageID].json` | programID, browseType, param, orderBy, recTotal, recPerPage, pageID |
| 项目首页 | GET | `/zentao/project-index-[projectID]-[browseType]-[recTotal]-[recPerPage]-[pageID].json` | projectID, browseType, recTotal, recPerPage, pageID |
| 查看项目 | GET | `/zentao/project-view-[projectID].json` | projectID |
| 创建项目 | GET/POST | `/zentao/project-create-[model]-[programID]-[copyProjectID]-[extra].json` | model, programID, copyProjectID, extra |
| 编辑项目 | GET/POST | `/zentao/project-edit-[projectID]-[from].json` | projectID, from |
| 批量编辑 | GET/POST | `/zentao/project-batchEdit.json` | - |
| 启动项目 | GET/POST | `/zentao/project-start-[projectID].json` | projectID |
| 暂停项目 | GET/POST | `/zentao/project-suspend-[projectID].json` | projectID |
| 关闭项目 | GET/POST | `/zentao/project-close-[projectID].json` | projectID |
| 激活项目 | GET/POST | `/zentao/project-activate-[projectID].json` | projectID |
| 删除项目 | GET | `/zentao/project-delete-[projectID]-[confirm]-[from].json` | projectID, confirm, from |
| 更新排序 | GET/POST | `/zentao/project-updateOrder.json` | - |
| 创建向导 | GET | `/zentao/project-createGuide-[programID]-[from]-[productID]-[branchID].json` | programID, from, productID, branchID |

### 团队与权限

| 接口 | 方法 | 路径 | 参数 |
|------|------|------|------|
| 浏览团队 | GET | `/zentao/project-team-[projectID].json` | projectID |
| 管理成员 | GET/POST | `/zentao/project-manageMembers-[projectID]-[dept]-[copyProjectID].json` | projectID, dept, copyProjectID |
| 移除成员 | GET | `/zentao/project-unlinkMember-[projectID]-[userID]-[confirm]-[removeExecution].json` | projectID, userID, confirm, removeExecution |
| 管理权限 | GET/POST | `/zentao/project-managePriv-[projectID]-[type]-[param]-[menu]-[version].json` | projectID, type, param, menu, version |

### 分组管理

| 接口 | 方法 | 路径 | 参数 |
|------|------|------|------|
| 浏览分组 | GET | `/zentao/project-group-[projectID]-[programID].json` | projectID, programID |
| 创建分组 | GET/POST | `/zentao/project-createGroup-[projectID].json` | projectID |
| 复制分组 | GET/POST | `/zentao/project-copyGroup-[groupID].json` | groupID |
| 编辑分组 | GET/POST | `/zentao/project-editGroup-[groupID].json` | groupID |
| 管理分组成员 | GET/POST | `/zentao/project-manageGroupMember-[groupID]-[deptID].json` | groupID, deptID |

### 执行与产品

| 接口 | 方法 | 路径 | 参数 |
|------|------|------|------|
| 执行列表 | GET | `/zentao/project-execution-[status]-[projectID]-[orderBy]-[productID]-[recTotal]-[recPerPage]-[pageID].json` | status, projectID, orderBy, productID, recTotal, recPerPage, pageID |
| 管理产品 | GET/POST | `/zentao/project-manageProducts-[projectID]-[from].json` | projectID, from |

### QA 相关

| 接口 | 方法 | 路径 | 参数 |
|------|------|------|------|
| QA 仪表盘 | GET | `/zentao/project-qa-[projectID].json` | projectID |
| Bug 列表 | GET | `/zentao/project-bug-[projectID]-[productID]-[branchID]-[orderBy]-[build]-[type]-[param]-[recTotal]-[recPerPage]-[pageID].json` | projectID, productID, branchID, orderBy, build, type, param, recTotal, recPerPage, pageID |
| 用例列表 | GET | `/zentao/project-testcase-[projectID]-[productID]-[branch]-[browseType]-[param]-[caseType]-[orderBy]-[recTotal]-[recPerPage]-[pageID].json` | projectID, productID, branch, browseType, param, caseType, orderBy, recTotal, recPerPage, pageID |
| 测试报告 | GET | `/zentao/project-testreport-[projectID]-[objectType]-[extra]-[orderBy]-[recTotal]-[recPerPage]-[pageID].json` | projectID, objectType, extra, orderBy, recTotal, recPerPage, pageID |
| 测试单 | GET | `/zentao/project-testtask-[projectID]-[orderBy]-[recTotal]-[recPerPage]-[pageID].json` | projectID, orderBy, recTotal, recPerPage, pageID |
| 构建 | GET | `/zentao/project-build-[projectID]-[type]-[param]-[orderBy].json` | projectID, type, param, orderBy |

### AJAX 接口

| 接口 | 方法 | 路径 | 参数 |
|------|------|------|------|
| 获取下拉菜单 | GET | `/zentao/project-ajaxGetDropMenu-[projectID]-[module]-[method].json` | projectID, module, method |
| 获取复制项目 | GET/POST | `/zentao/project-ajaxGetCopyProjects.json` | - |
| 获取解绑提示 | GET | `/zentao/project-ajaxGetUnlinkTips-[projectID]-[account].json` | projectID, account |
| 获取关联产品 | GET | `/zentao/project-ajaxGetLinkedProducts-[projectID].json` | projectID |
| 获取对象信息 | GET | `/zentao/project-ajaxGetObjectInfo-[objectType]-[objectID]-[selectedProgramID].json` | objectType, objectID, selectedProgramID |
| 获取执行列表 | GET | `/zentao/project-ajaxGetExecutions-[projectID]-[executionID]-[mode].json` | projectID, executionID, mode |
| 按执行获取项目 | GET | `/zentao/project-ajaxGetPairsByExecution-[executionID].json` | executionID |

### 其他接口

| 接口 | 方法 | 路径 | 参数 |
|------|------|------|------|
| 看板 | GET | `/zentao/project-kanban.json` | - |
| 项目动态 | GET | `/zentao/project-dynamic-[projectID]-[type]-[param]-[recTotal]-[date]-[direction].json` | projectID, type, param, recTotal, date, direction |
| 导出项目 | GET/POST | `/zentao/project-export-[status]-[orderBy].json` | status, orderBy |
| 白名单 | GET | `/zentao/project-whitelist-[projectID]-[module]-[from]-[objectType]-[orderBy]-[recTotal]-[recPerPage]-[pageID].json` | projectID, module, from, objectType, orderBy, recTotal, recPerPage, pageID |
| 添加白名单 | GET | `/zentao/project-addWhitelist-[projectID]-[deptID]-[copyID]-[programID]-[from].json` | projectID, deptID, copyID, programID, from |
| 解绑白名单 | GET | `/zentao/project-unbindWhitelist-[id]-[confirm].json` | id, confirm |
| 管理代码库 | GET/POST | `/zentao/project-manageRepo-[projectID].json` | projectID |

---

## 任务相关 (task) - 35个

### 核心接口

| 接口 | 方法 | 路径 | 参数 |
|------|------|------|------|
| 创建任务 | GET/POST | `/zentao/task-create-[executionID]-[storyID]-[moduleID]-[taskID]-[todoID]-[extra]-[bugID].json` | executionID, storyID, moduleID, taskID, todoID, extra, bugID |
| 批量创建 | GET/POST | `/zentao/task-batchCreate-[executionID]-[storyID]-[moduleID]-[taskID]-[iframe]-[extra].json` | executionID, storyID, moduleID, taskID, iframe, extra |
| 查看任务 | GET | `/zentao/task-view-[taskID].json` | taskID |
| 编辑任务 | GET/POST | `/zentao/task-edit-[taskID]-[comment]-[kanbanGroup]-[from].json` | taskID, comment, kanbanGroup, from |
| 批量编辑 | GET/POST | `/zentao/task-batchEdit-[executionID].json` | executionID |
| 删除任务 | GET | `/zentao/task-delete-[executionID]-[taskID]-[confirm]-[from].json` | executionID, taskID, confirm, from |

### 状态控制

| 接口 | 方法 | 路径 | 参数 |
|------|------|------|------|
| 开始任务 | GET/POST | `/zentao/task-start-[taskID]-[extra].json` | taskID, extra |
| 暂停任务 | GET/POST | `/zentao/task-pause-[taskID]-[extra].json` | taskID, extra |
| 重启任务 | GET/POST | `/zentao/task-restart-[taskID]-[from].json` | taskID, from |
| 完成任务 | GET/POST | `/zentao/task-finish-[taskID]-[extra].json` | taskID, extra |
| 关闭任务 | GET/POST | `/zentao/task-close-[taskID]-[extra].json` | taskID, extra |
| 取消任务 | GET/POST | `/zentao/task-cancel-[taskID]-[extra].json` | taskID, extra |
| 激活任务 | GET/POST | `/zentao/task-activate-[taskID]-[extra].json` | taskID, extra |
| 批量取消 | GET/POST | `/zentao/task-batchCancel.json` | - |
| 批量关闭 | GET/POST | `/zentao/task-batchClose-[skipTaskIdList].json` | skipTaskIdList |
| 确认需求变更 | GET | `/zentao/task-confirmStoryChange-[taskID].json` | taskID |

### 工时管理

| 接口 | 方法 | 路径 | 参数 |
|------|------|------|------|
| 记录工时 | GET/POST | `/zentao/task-recordEstimate-[taskID]-[from]-[orderBy].json` | taskID, from, orderBy |
| 编辑工时 | GET/POST | `/zentao/task-editEstimate-[estimateID].json` | estimateID |
| 删除工时 | GET | `/zentao/task-deleteEstimate-[estimateID]-[confirm].json` | estimateID, confirm |

### 指派与模块

| 接口 | 方法 | 路径 | 参数 |
|------|------|------|------|
| 指派任务 | GET/POST | `/zentao/task-assignTo-[executionID]-[taskID]-[kanbanGroup]-[from].json` | executionID, taskID, kanbanGroup, from |
| 批量指派 | GET/POST | `/zentao/task-batchAssignTo-[execution].json` | execution |
| 批量更改模块 | GET/POST | `/zentao/task-batchChangeModule-[moduleID].json` | moduleID |
| 编辑团队 | GET/POST | `/zentao/task-editTeam-[executionID]-[taskID]-[kanbanGroup]-[from].json` | executionID, taskID, kanbanGroup, from |

### AJAX 接口

| 接口 | 方法 | 路径 | 参数 |
|------|------|------|------|
| 获取用户任务 | GET | `/zentao/task-ajaxGetUserTasks-[userID]-[id]-[status]-[appendID].json` | userID, id, status, appendID |
| 获取执行任务 | GET | `/zentao/task-ajaxGetExecutionTasks-[executionID]-[taskID].json` | executionID, taskID |
| 获取任务列表 | GET | `/zentao/task-ajaxGetTasks-[executionID]-[maxTaskID].json` | executionID, maxTaskID |
| 获取任务详情 | GET | `/zentao/task-ajaxGetDetail-[taskID].json` | taskID |
| 按ID获取任务 | GET | `/zentao/task-ajaxGetByID-[taskID].json` | taskID |

### 其他接口

| 接口 | 方法 | 路径 | 参数 |
|------|------|------|------|
| 通用操作 | GET | `/zentao/task-commonAction-[taskID].json` | taskID |
| 报告页面 | GET/POST | `/zentao/task-report-[executionID]-[browseType]-[chartType].json` | executionID, browseType, chartType |
| 导出任务 | GET/POST | `/zentao/task-export-[executionID]-[orderBy]-[type].json` | executionID, orderBy, type |

### 创建任务 POST 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| execution | int | 是 | 所属执行 |
| type | string | 是 | 任务类型：design/devel/request/test/study/discuss/ui/affair/misc/interrupt |
| name | string | 是 | 任务名称 |
| module | int | 否 | 所属模块 |
| assignedTo | string | 否 | 指派给 |
| story | int | 否 | 相关研发需求 |
| pri | int | 否 | 优先级 (0-4) |
| color | string | 否 | 标题颜色 (#RGB) |
| desc | string | 否 | 任务描述 |
| mailto | string | 否 | 抄送给（多个账号用','分隔） |

---

## Bug 相关 (bug) - 42个

### 核心接口

| 接口 | 方法 | 路径 | 参数 |
|------|------|------|------|
| Bug 列表 | GET | `/zentao/bug-browse-[productID]-[branch]-[browseType]-[param]-[orderBy]-[recTotal]-[recPerPage]-[pageID].json` | productID, branch, browseType, param, orderBy, recTotal, recPerPage, pageID |
| 创建 Bug | GET/POST | `/zentao/bug-create-[productID]-[branch]-[extras].json` | productID, branch, extras |
| 批量创建 | GET/POST | `/zentao/bug-batchCreate-[productID]-[branch]-[executionID]-[moduleID]-[extra].json` | productID, branch, executionID, moduleID, extra |
| 查看 Bug | GET | `/zentao/bug-view-[bugID]-[from].json` | bugID, from |
| 编辑 Bug | GET/POST | `/zentao/bug-edit-[bugID]-[comment]-[kanbanGroup].json` | bugID, comment, kanbanGroup |
| 批量编辑 | GET/POST | `/zentao/bug-batchEdit-[productID]-[branch].json` | productID, branch |
| 删除 Bug | GET | `/zentao/bug-delete-[bugID]-[confirm]-[from].json` | bugID, confirm, from |

### 状态控制

| 接口 | 方法 | 路径 | 参数 |
|------|------|------|------|
| 确认 Bug | GET/POST | `/zentao/bug-confirmBug-[bugID]-[extra]-[from].json` | bugID, extra, from |
| 批量确认 | GET/POST | `/zentao/bug-batchConfirm.json` | - |
| 解决 Bug | GET/POST | `/zentao/bug-resolve-[bugID]-[extra]-[from].json` | bugID, extra, from |
| 批量解决 | GET/POST | `/zentao/bug-batchResolve-[resolution]-[resolvedBuild].json` | resolution, resolvedBuild |
| 激活 Bug | GET/POST | `/zentao/bug-activate-[bugID]-[extra]-[from].json` | bugID, extra, from |
| 批量激活 | GET/POST | `/zentao/bug-batchActivate-[productID]-[branch].json` | productID, branch |
| 关闭 Bug | GET/POST | `/zentao/bug-close-[bugID]-[extra]-[from].json` | bugID, extra, from |
| 批量关闭 | GET/POST | `/zentao/bug-batchClose-[releaseID]-[viewType].json` | releaseID, viewType |

### 指派与批量操作

| 接口 | 方法 | 路径 | 参数 |
|------|------|------|------|
| 指派 Bug | GET/POST | `/zentao/bug-assignTo-[bugID]-[kanbanGroup]-[from].json` | bugID, kanbanGroup, from |
| 批量指派 | GET/POST | `/zentao/bug-batchAssignTo-[objectID]-[type].json` | objectID, type |
| 批量更改分支 | GET/POST | `/zentao/bug-batchChangeBranch-[branchID].json` | branchID |
| 批量更改模块 | GET/POST | `/zentao/bug-batchChangeModule-[moduleID].json` | moduleID |
| 批量更改计划 | GET/POST | `/zentao/bug-batchChangePlan-[planID].json` | planID |

### AJAX 接口

| 接口 | 方法 | 路径 | 参数 |
|------|------|------|------|
| 获取用户 Bug | GET | `/zentao/bug-ajaxGetUserBugs-[userID]-[id]-[appendID].json` | userID, id, appendID |
| 获取模块负责人 | GET | `/zentao/bug-ajaxGetModuleOwner-[moduleID]-[productID].json` | moduleID, productID |
| 加载指派用户 | GET | `/zentao/bug-ajaxLoadAssignedTo-[executionID]-[selectedUser].json` | executionID, selectedUser |
| 加载执行团队 | GET | `/zentao/bug-ajaxLoadExecutionTeamMembers-[productID]-[selectedUser].json` | productID, selectedUser |
| 加载所有用户 | GET | `/zentao/bug-ajaxLoadAllUsers-[selectedUser]-[params].json` | selectedUser, params |
| 获取 Bug 详情 | GET | `/zentao/bug-ajaxGetDetail-[bugID].json` | bugID |
| 按 ID 获取 Bug | GET | `/zentao/bug-ajaxGetByID-[bugID].json` | bugID |
| 获取字段选项 | GET | `/zentao/bug-ajaxGetBugFieldOptions-[productID]-[executionID].json` | productID, executionID |
| 获取产品成员 | GET | `/zentao/bug-ajaxGetProductMembers-[productID]-[selectedUser]-[branchID].json` | productID, selectedUser, branchID |
| 获取产品 Bug | GET | `/zentao/bug-ajaxGetProductBugs-[productID]-[bugID].json` | productID, bugID |
| 获取项目团队 | GET | `/zentao/bug-ajaxGetProjectTeamMembers-[projectID]-[selectedUser].json` | projectID, selectedUser |
| 获取发布版本 | GET | `/zentao/bug-ajaxGetReleasedBuilds-[productID]-[branch].json` | productID, branch |

### 其他接口

| 接口 | 方法 | 路径 | 参数 |
|------|------|------|------|
| 报告页面 | GET/POST | `/zentao/bug-report-[productID]-[browseType]-[branchID]-[moduleID]-[chartType].json` | productID, browseType, branchID, moduleID, chartType |
| 关联 Bug | GET | `/zentao/bug-linkBugs-[bugID]-[browseType]-[excludeBugs]-[param]-[recTotal]-[recPerPage]-[pageID].json` | bugID, browseType, excludeBugs, param, recTotal, recPerPage, pageID |
| 确认需求变更 | GET | `/zentao/bug-confirmStoryChange-[bugID].json` | bugID |
| 导出 Bug | GET/POST | `/zentao/bug-export-[productID]-[orderBy]-[browseType]-[executionID].json` | productID, orderBy, browseType, executionID |
| 下拉菜单 | GET | `/zentao/bug-ajaxGetDropMenu-[productID]-[module]-[method]-[extra].json` | productID, module, method, extra |

### 创建 Bug POST 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| product | int | 是 | 所属产品 |
| title | string | 是 | Bug 标题 |
| openedBuild | int\|trunk | 是 | 影响版本 |
| branch | int | 否 | 平台/分支 |
| module | int | 否 | 所属模块 |
| execution | int | 否 | 所属执行 |
| assignedTo | string | 否 | 指派给 |
| deadline | date | 否 | 截止日期 (YY-mm-dd) |
| type | string | 否 | Bug类型：codeerror/config/install/security/performance/standard/automation/designdefect/others |
| os | string | 否 | 操作系统：all/windows/win11/.../linux/others |
| browser | string | 否 | 浏览器：all/chrome/edge/ie/firefox/opera/safari/... |
| color | string | 否 | 标题颜色 (#RGB) |
| severity | int | 否 | 严重程度 (0-4) |
| pri | int | 否 | 优先级 (0-4) |
| steps | string | 否 | 重现步骤 |
| mailto | string | 否 | 抄送给 |
| keywords | string | 否 | 关键词 |

---

## 数据字典

### zt_product - 产品表

| 字段 | 类型 | 长度 | 可空 | 说明 |
|------|------|------|------|------|
| id | int | 8 | NO | 编号 |
| program | int | 8 | NO | 所属项目集 |
| name | varchar | 110 | NO | 产品名称 |
| code | varchar | 45 | NO | 产品代号 |
| type | varchar | 30 | NO | 产品类型 |
| status | varchar | 30 | NO | 状态 |
| PO | varchar | 30 | NO | 产品负责人 |
| QD | varchar | 30 | NO | 测试负责人 |
| RD | varchar | 30 | NO | 发布负责人 |
| acl | enum | - | NO | 访问控制 (open/private/custom) |
| deleted | enum | - | NO | 已删除 (0/1) |

### zt_project - 项目表

| 字段 | 类型 | 长度 | 可空 | 说明 |
|------|------|------|------|------|
| id | int | 8 | NO | 项目ID |
| name | varchar | 90 | NO | 项目名称 |
| code | varchar | 45 | NO | 项目代号 |
| model | char | 30 | NO | 项目管理方式 |
| type | char | 30 | NO | 项目类型 |
| status | varchar | 10 | NO | 状态 |
| pri | enum | - | NO | 优先级 (1/2/3/4) |
| PO | varchar | 30 | NO | 项目负责人 |
| PM | varchar | 30 | NO | 负责人 |
| QD | varchar | 30 | NO | 测试负责人 |
| RD | varchar | 30 | NO | 发布负责人 |
| deleted | enum | - | NO | 已删除 (0/1) |

### zt_task - 任务表

| 字段 | 类型 | 长度 | 可空 | 说明 |
|------|------|------|------|------|
| id | int | 8 | NO | 编号 |
| project | int | 8 | NO | 所属项目 |
| execution | int | 8 | NO | 所属执行 |
| name | varchar | 255 | NO | 任务名称 |
| type | varchar | 20 | NO | 任务类型 |
| status | enum | - | NO | 任务状态 (wait/doing/done/pause/cancel/closed) |
| pri | int | 3 | NO | 优先级 |
| estimate | float | - | NO | 最初预计 |
| consumed | float | - | NO | 总计消耗 |
| left | float | - | NO | 预计剩余 |
| assignedTo | varchar | 30 | NO | 指派给 |
| finishedBy | varchar | 30 | NO | 由谁完成 |
| deleted | enum | - | NO | 已删除 (0/1) |

### zt_bug - Bug 表

| 字段 | 类型 | 长度 | 可空 | 说明 |
|------|------|------|------|------|
| id | int | 8 | NO | Bug 编号 |
| project | int | 8 | NO | 所属项目 |
| product | int | 8 | NO | 所属产品 |
| execution | int | 8 | NO | 所属执行 |
| title | varchar | 255 | NO | Bug 标题 |
| severity | int | 4 | NO | 严重程度 |
| pri | int | 3 | NO | 优先级 |
| type | varchar | 30 | NO | Bug 类型 |
| status | enum | - | NO | Bug 状态 (active/resolved/closed) |
| steps | text | - | NO | 重现步骤 |
| openedBy | varchar | 30 | NO | 由谁创建 |
| assignedTo | varchar | 30 | NO | 指派给 |
| resolvedBy | varchar | 30 | NO | 解决者 |
| closedBy | varchar | 30 | NO | 由谁关闭 |
| deleted | enum | - | NO | 已删除 (0/1) |

---

## 测试示例

```bash
# 获取产品列表
GET http://10.128.1.8:8088/zentao/product-index-yes---id-20-1.json

# 查看产品详情
GET http://10.128.1.8:8088/zentao/product-view-1.json

# 创建任务
POST http://10.128.1.8:8088/zentao/task-create-167---.json
Content-Type: application/x-www-form-urlencoded

execution=167&type=devel&name=测试任务&pri=3

# 创建 Bug
POST http://10.128.1.8:8088/zentao/bug-create-1--.json
Content-Type: application/x-www-form-urlencoded

product=1&title=测试Bug&openedBuild=trunk&type=codeerror&severity=3
```

---

## 接口统计

| 模块 | 接口数量 |
|------|----------|
| 系统 (index) | 4 |
| 产品 (product) | 43 |
| 项目 (project) | 52 |
| 任务 (task) | 35 |
| Bug (bug) | 42 |
| **合计** | **176** |
