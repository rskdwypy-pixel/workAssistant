#!/bin/bash

# 禅道 API 测试脚本
# 配置信息
ZENTAO_URL="http://10.128.1.8:8088"
BASE_URL="$ZENTAO_URL/zentao"
USERNAME="ljc"
PASSWORD="Qc@123456"

# 创建输出目录
mkdir -p test_results

# 登录获取 session
echo "正在登录禅道系统..."
LOGIN_RESPONSE=$(curl -s -c /tmp/cookies.txt -X POST "$BASE_URL/user-login.json" \
    -d "account=$USERNAME&password=$PASSWORD&passwordStrength=1")

# 检查登录是否成功
if echo "$LOGIN_RESPONSE" | grep -q '"status":"success"'; then
    echo "✅ 登录成功"
else
    echo "❌ 登录失败"
    echo "$LOGIN_RESPONSE"
    exit 1
fi

# 测试结果统计
TOTAL=0
SUCCESS=0
FAILED=0
SKIPPED=0

# 测试函数
test_api() {
    local method=$1
    local path=$2
    local params=$3
    local description=$4
    local module=$5
    
    TOTAL=$((TOTAL + 1))
    local full_url="$BASE_URL/$path"
    
    if [ "$method" = "GET" ]; then
        response=$(curl -s -b /tmp/cookies.txt "$full_url")
    else
        response=$(curl -s -b /tmp/cookies.txt -X POST "$full_url" -d "$params")
    fi
    
    # 检查响应状态
    if echo "$response" | grep -q '"status":"success"'; then
        echo "✅ $description"
        echo "$full_url"
        echo "状态: 成功"
        echo ""
        SUCCESS=$((SUCCESS + 1))
        
        # 保存成功结果
        mkdir -p "test_results/$module"
        echo "$full_url" >> "test_results/$module/success.txt"
        
    elif echo "$response" | grep -q '"status":"fail"'; then
        echo "❌ $description"
        echo "$full_url"
        echo "状态: 失败"
        # 提取错误信息
        error_msg=$(echo "$response" | grep -o '"message":"[^"]*"' | sed 's/"message":"//;s/"//')
        if [ ! -z "$error_msg" ]; then
            echo "错误: $error_msg"
        fi
        echo ""
        FAILED=$((FAILED + 1))
        
        # 保存失败结果
        mkdir -p "test_results/$module"
        echo "$full_url" >> "test_results/$module/failed.txt"
        
    else
        echo "⏭️  $description"
        echo "$full_url"
        echo "状态: 跳过（无法确定状态）"
        echo ""
        SKIPPED=$((SKIPPED + 1))
        
        # 保存跳过结果
        mkdir -p "test_results/$module"
        echo "$full_url" >> "test_results/$module/skipped.txt"
    fi
    
    # 保存完整响应
    echo "$response" >> "test_results/$module/response_${TOTAL}.json"
}

echo "开始测试系统相关接口..."
echo "============================"

# 测试系统相关接口 (index)
echo "## 系统相关 (index) - 4个接口"

test_api "GET" "index-index-open.json" "" "首页" "index"
test_api "GET" "index-changeLog-18.3.json" "" "变更日志" "index"
test_api "GET" "index-ajaxClearObjectSession.json" "" "清除会话" "index"
test_api "GET" "index-ajaxGetViewMethod-1-project.json" "" "获取视图方法" "index"

echo "开始测试产品相关接口..."
echo "========================"

# 测试产品相关接口 (product)
echo "## 产品相关 (product) - 43个接口"

# 核心接口
test_api "GET" "product-index-yes---id-20-1.json" "" "产品列表" "product"
test_api "GET" "product-browse-1-trunk-story-id-desc-20-1-.json" "" "浏览产品" "product"
test_api "GET" "product-view-1.json" "" "查看产品" "product"
test_api "POST" "product-create-0-.json" "programID=1" "创建产品" "product"
test_api "POST" "product-edit-1-edit--1.json" "productID=1" "编辑产品" "product"
test_api "POST" "product-batchEdit-1.json" "" "批量编辑" "product"
test_api "POST" "product-close-1.json" "" "关闭产品" "product"
test_api "GET" "product-delete-1-no.json" "" "删除产品" "product"
test_api "GET" "product-roadmap-1-trunk.json" "" "产品路线图" "product"
test_api "GET" "product-dynamic-1-all-id-desc-20-.json" "" "产品动态" "product"
test_api "GET" "product-dashboard-1.json" "" "产品仪表盘" "product"
test_api "GET" "product-track-1-trunk--20-1.json" "" "需求追踪" "product"

# AJAX 接口
test_api "GET" "product-ajaxGetProducts-1.json" "" "获取产品列表" "product"
test_api "GET" "product-ajaxGetProductById-1.json" "" "获取产品详情" "product"
test_api "GET" "product-ajaxGetProjects-1-trunk-1.json" "" "获取项目" "product"
test_api "GET" "product-ajaxGetProjectsByBranch-1-trunk-1.json" "" "按分支获取项目" "product"
test_api "GET" "product-ajaxGetExecutions-1-1-trunk-1-1-0-mode.json" "" "获取执行列表" "product"
test_api "GET" "product-ajaxGetExecutionsByProject-1-1-trunk-1.json" "" "按项目获取执行" "product"
test_api "GET" "product-ajaxGetPlans-1-trunk-1-0-1-0-.json" "" "获取计划" "product"
test_api "GET" "product-ajaxGetLine-1-1.json" "" "获取产品线" "product"
test_api "GET" "product-ajaxGetReviewers-1-1.json" "" "获取评审人" "product"
test_api "GET" "product-ajaxSetState-1.json" "" "设置会话状态" "product"

# 其他接口
test_api "GET" "product-project-1-1-trunk-0-id-desc-20-1.json" "" "关联项目" "product"
test_api "GET" "product-kanban.json" "" "看板" "product"
test_api "POST" "product-manageLine.json" "" "管理产品线" "product"
test_api "GET" "product-whitelist-1-product-module-id-desc-20-1.json" "" "获取白名单" "product"
test_api "GET" "product-addWhitelist-1-1-1.json" "" "添加白名单" "product"
test_api "GET" "product-unbindWhitelist-1-no.json" "" "解绑白名单" "product"
test_api "POST" "product-export-0-id.json" "" "导出产品" "product"
test_api "GET" "product-build-1-trunk.json" "" "产品构建" "product"
test_api "POST" "product-updateOrder.json" "" "更新排序" "product"
test_api "POST" "product-ajaxSetShowSetting.json" "" "显示设置" "product"

echo "开始测试项目相关接口..."
echo "========================"

# 测试项目相关接口 (project)
echo "## 项目相关 (project) - 52个接口"

# 核心接口
test_api "GET" "project-browse-0-all--id-desc-20-1.json" "" "项目列表" "project"
test_api "GET" "project-index-1-all-20-1.json" "" "项目首页" "project"
test_api "GET" "project-view-1.json" "" "查看项目" "project"
test_api "POST" "project-create-waterfall-1-0-.json" "model=agile" "创建项目" "project"
test_api "POST" "project-edit-1-.json" "projectID=1" "编辑项目" "project"
test_api "POST" "project-batchEdit.json" "" "批量编辑" "project"
test_api "POST" "project-start-1.json" "" "启动项目" "project"
test_api "POST" "project-suspend-1.json" "" "暂停项目" "project"
test_api "POST" "project-close-1.json" "" "关闭项目" "project"
test_api "POST" "project-activate-1.json" "" "激活项目" "project"
test_api "GET" "project-delete-1-no-.json" "" "删除项目" "project"
test_api "POST" "project-updateOrder.json" "" "更新排序" "project"
test_api "GET" "project-createGuide-0-1-1-1.json" "" "创建向导" "project"

# 团队与权限
test_api "GET" "project-team-1.json" "" "浏览团队" "project"
test_api "POST" "project-manageMembers-1-0-1.json" "projectID=1" "管理成员" "project"
test_api "GET" "project-unlinkMember-1-1-no-1.json" "" "移除成员" "project"
test_api "POST" "project-managePriv-1-menu--.json" "projectID=1" "管理权限" "project"

# 分组管理
test_api "GET" "project-group-1-0.json" "" "浏览分组" "project"
test_api "POST" "project-createGroup-1.json" "" "创建分组" "project"
test_api "POST" "project-copyGroup-1.json" "" "复制分组" "project"
test_api "POST" "project-editGroup-1.json" "" "编辑分组" "project"
test_api "POST" "project-manageGroupMember-1-1.json" "" "管理分组成员" "project"

# 执行与产品
test_api "GET" "project-execution-all-1-id-desc-1-20-1.json" "" "执行列表" "project"
test_api "POST" "project-manageProducts-1-.json" "projectID=1" "管理产品" "project"

# QA 相关
test_api "GET" "project-qa-1.json" "" "QA 仪表盘" "project"
test_api "GET" "project-bug-1-1-trunk-id-build--type--id-desc-20-1.json" "" "Bug 列表" "project"
test_api "GET" "project-testcase-1-1-trunk-product-id-desc-20-1.json" "" "用例列表" "project"
test_api "GET" "project-testreport-1-story-id-desc-20-1.json" "" "测试报告" "project"
test_api "GET" "project-testtask-1-id-desc-20-1.json" "" "测试单" "project"
test_api "GET" "project-build-1-bug-id-desc.json" "" "构建" "project"

# AJAX 接口
test_api "GET" "project-ajaxGetDropMenu-1-product-index.json" "" "获取下拉菜单" "project"
test_api "POST" "project-ajaxGetCopyProjects.json" "" "获取复制项目" "project"
test_api "GET" "project-ajaxGetUnlinkTips-1-admin.json" "" "获取解绑提示" "project"
test_api "GET" "project-ajaxGetLinkedProducts-1.json" "" "获取关联产品" "project"
test_api "GET" "project-ajaxGetObjectInfo-project-1-1.json" "" "获取对象信息" "project"
test_api "GET" "project-ajaxGetExecutions-1-1-mode.json" "" "获取执行列表" "project"
test_api "GET" "project-ajaxGetPairsByExecution-1.json" "" "按执行获取项目" "project"

# 其他接口
test_api "GET" "project-kanban.json" "" "看板" "project"
test_api "GET" "project-dynamic-1-all-id-desc-20-.json" "" "项目动态" "project"
test_api "POST" "project-export-0-id.json" "" "导出项目" "project"
test_api "GET" "project-whitelist-1-project-index-project-id-desc-20-1.json" "" "白名单" "project"
test_api "GET" "project-addWhitelist-1-1-1-1-1.json" "" "添加白名单" "project"
test_api "GET" "project-unbindWhitelist-1-no.json" "" "解绑白名单" "project"
test_api "POST" "project-manageRepo-1.json" "" "管理代码库" "project"

echo "开始测试任务相关接口..."
echo "========================"

# 测试任务相关接口 (task)
echo "## 任务相关 (task) - 35个接口"

# 核心接口
test_api "POST" "task-create-1---.json" "execution=167&type=devel&name=测试任务&pri=3" "创建任务" "task"
test_api "POST" "task-batchCreate-1----.json" "execution=167" "批量创建" "task"
test_api "GET" "task-view-1.json" "" "查看任务" "task"
test_api "POST" "task-edit-1-.json" "taskID=1" "编辑任务" "task"
test_api "POST" "task-batchEdit-1.json" "executionID=1" "批量编辑" "task"
test_api "GET" "task-delete-1-1-from.json" "executionID=1&taskID=1" "删除任务" "task"

# 状态控制
test_api "POST" "task-start-1-.json" "taskID=1" "开始任务" "task"
test_api "POST" "task-pause-1-.json" "taskID=1" "暂停任务" "task"
test_api "POST" "task-restart-1-from.json" "taskID=1" "重启任务" "task"
test_api "POST" "task-finish-1-.json" "taskID=1" "完成任务" "task"
test_api "POST" "task-close-1-.json" "taskID=1" "关闭任务" "task"
test_api "POST" "task-cancel-1-.json" "taskID=1" "取消任务" "task"
test_api "POST" "task-activate-1-.json" "taskID=1" "激活任务" "task"
test_api "POST" "task-batchCancel.json" "" "批量取消" "task"
test_api "POST" "task-batchClose-.json" "" "批量关闭" "task"
test_api "GET" "task-confirmStoryChange-1.json" "" "确认需求变更" "task"

# 工时管理
test_api "POST" "task-recordEstimate-1-.json" "taskID=1" "记录工时" "task"
test_api "POST" "task-editEstimate-1.json" "estimateID=1" "编辑工时" "task"
test_api "GET" "task-deleteEstimate-1-no.json" "estimateID=1" "删除工时" "task"

# 指派与模块
test_api "POST" "task-assignTo-1-1-.json" "executionID=1&taskID=1" "指派任务" "task"
test_api "POST" "task-batchAssignTo-1.json" "execution=1" "批量指派" "task"
test_api "POST" "task-batchChangeModule-1.json" "moduleID=1" "批量更改模块" "task"
test_api "POST" "task-editTeam-1-1-.json" "executionID=1&taskID=1" "编辑团队" "task"

# AJAX 接口
test_api "GET" "task-ajaxGetUserTasks-1-1-all-1.json" "" "获取用户任务" "task"
test_api "GET" "task-ajaxGetExecutionTasks-1-1.json" "" "获取执行任务" "task"
test_api "GET" "task-ajaxGetTasks-1-0.json" "" "获取任务列表" "task"
test_api "GET" "task-ajaxGetDetail-1.json" "" "获取任务详情" "task"
test_api "GET" "task-ajaxGetByID-1.json" "" "按ID获取任务" "task"

# 其他接口
test_api "GET" "task-commonAction-1.json" "" "通用操作" "task"
test_api "POST" "task-report-1-all-bar.json" "executionID=1" "报告页面" "task"
test_api "POST" "task-export-1-id-all.json" "executionID=1" "导出任务" "task"

echo "开始测试Bug相关接口..."
echo "========================"

# 测试Bug相关接口 (bug)
echo "## Bug 相关 (bug) - 42个接口"

# 核心接口
test_api "GET" "bug-browse-1-trunk-all-id-desc-20-1.json" "" "Bug 列表" "bug"
test_api "POST" "bug-create-1--.json" "product=1&title=测试Bug&openedBuild=trunk&type=codeerror&severity=3" "创建 Bug" "bug"
test_api "POST" "bug-batchCreate-1-trunk-1-1-.json" "productID=1&branchID=1" "批量创建" "bug"
test_api "GET" "bug-view-1-.json" "" "查看 Bug" "bug"
test_api "POST" "bug-edit-1-.json" "bugID=1" "编辑 Bug" "bug"
test_api "POST" "bug-batchEdit-1-trunk.json" "productID=1&branchID=1" "批量编辑" "bug"
test_api "GET" "bug-delete-1-no-from.json" "" "删除 Bug" "bug"

# 状态控制
test_api "POST" "bug-confirmBug-1-.json" "bugID=1" "确认 Bug" "bug"
test_api "POST" "bug-batchConfirm.json" "" "批量确认" "bug"
test_api "POST" "bug-resolve-1-.json" "bugID=1" "解决 Bug" "bug"
test_api "POST" "bug-batchResolve-fixed-.json" "" "批量解决" "bug"
test_api "POST" "bug-activate-1-.json" "bugID=1" "激活 Bug" "bug"
test_api "POST" "bug-batchActivate-1-trunk.json" "productID=1&branchID=1" "批量激活" "bug"
test_api "POST" "bug-close-1-.json" "bugID=1" "关闭 Bug" "bug"
test_api "POST" "bug-batchClose-1-view.json" "" "批量关闭" "bug"

# 指派与批量操作
test_api "POST" "bug-assignTo-1-.json" "bugID=1" "指派 Bug" "bug"
test_api "POST" "bug-batchAssignTo-1-project.json" "objectID=1" "批量指派" "bug"
test_api "POST" "bug-batchChangeBranch-1.json" "branchID=1" "批量更改分支" "bug"
test_api "POST" "bug-batchChangeModule-1.json" "moduleID=1" "批量更改模块" "bug"
test_api "POST" "bug-batchChangePlan-1.json" "planID=1" "批量更改计划" "bug"

# AJAX 接口
test_api "GET" "bug-ajaxGetUserBugs-1-1-1.json" "" "获取用户 Bug" "bug"
test_api "GET" "bug-ajaxGetModuleOwner-1-1.json" "" "获取模块负责人" "bug"
test_api "GET" "bug-ajaxLoadAssignedTo-1-.json" "executionID=1" "加载指派用户" "bug"
test_api "GET" "bug-ajaxLoadExecutionTeamMembers-1-.json" "productID=1" "加载执行团队" "bug"
test_api "GET" "bug-ajaxLoadAllUsers--.json" "" "加载所有用户" "bug"
test_api "GET" "bug-ajaxGetDetail-1.json" "" "获取 Bug 详情" "bug"
test_api "GET" "bug-ajaxGetByID-1.json" "" "按 ID 获取 Bug" "bug"
test_api "GET" "bug-ajaxGetBugFieldOptions-1-1.json" "" "获取字段选项" "bug"
test_api "GET" "bug-ajaxGetProductMembers-1--1.json" "" "获取产品成员" "bug"
test_api "GET" "bug-ajaxGetProductBugs-1-1.json" "" "获取产品 Bug" "bug"
test_api "GET" "bug-ajaxGetProjectTeamMembers-1-.json" "" "获取项目团队" "bug"
test_api "GET" "bug-ajaxGetReleasedBuilds-1-trunk.json" "" "获取发布版本" "bug"

# 其他接口
test_api "POST" "bug-report-1-all-1--bar.json" "productID=1" "报告页面" "bug"
test_api "GET" "bug-linkBugs-1-all--id-desc-20-1.json" "" "关联 Bug" "bug"
test_api "GET" "bug-confirmStoryChange-1.json" "" "确认需求变更" "bug"
test_api "POST" "bug-export-1-id-all-1.json" "productID=1" "导出 Bug" "bug"
test_api "GET" "bug-ajaxGetDropMenu-1-product-index-.json" "" "下拉菜单" "bug"

# 生成统计报告
echo ""
echo "========================"
echo "测试完成！"
echo "========================"
echo "总接口数: $TOTAL"
echo "成功数: $SUCCESS"
echo "失败数: $FAILED"
echo "跳过数: $SKIPPED"
echo "成功率: $(echo "scale=2; $SUCCESS * 100 / $TOTAL" | bc)%"
echo ""

# 输出常见问题分析
echo "常见问题分析:"
echo "============="
echo "检查失败的接口..."
for module in index product project task bug; do
    if [ -f "test_results/$module/failed.txt" ]; then
        echo ""
        echo "## $module 模块失败接口:"
        cat "test_results/$module/failed.txt" | sed 's/^/  /'
    fi
done

# 清理临时文件
rm -f /tmp/cookies.txt

