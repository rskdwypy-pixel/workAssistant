import { v4 as uuidv4 } from 'uuid';
import { readTasks, writeTasks } from '../utils/storage.js';

/**
 * 创建 Bug
 */
async function createBug(bugData) {
  console.log('[BugManager] ========== createBug 开始 ==========');
  console.log('[BugManager] 输入的 bugData:', JSON.stringify(bugData, null, 2));

  const data = await readTasks();
  const tasks = data.tasks || [];

  const newBug = {
    id: uuidv4(),
    type: 'bug',
    title: bugData.title || bugData.content?.substring(0, 100) || '未命名Bug',
    content: bugData.content || bugData.steps || '',
    status: 'unconfirmed', // unconfirmed | activated | resolved | closed
    severity: bugData.severity || 3,
    bugType: bugData.type || 'codeerror',
    productId: bugData.productId || '',
    executionId: bugData.executionId || '',
    executionName: bugData.executionName || '',
    projectName: bugData.projectName || '',
    steps: bugData.steps || '',
    os: bugData.os || '',
    browser: bugData.browser || '',
    openedBuild: bugData.openedBuild || 'trunk',
    priority: bugData.priority || 3,
    assignedTo: bugData.assignedTo || '',
    assignedToList: bugData.assignedToList || [],
    cc: bugData.cc || [],
    comment: bugData.comment || '',
    zentaoId: bugData.zentaoId || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    progress: 0,
    consumedTime: 0
  };

  console.log('[BugManager] 创建的 newBug 对象:', JSON.stringify(newBug, null, 2));
  console.log('[BugManager] newBug.type:', newBug.type);
  console.log('[BugManager] newBug.zentaoId:', newBug.zentaoId);

  tasks.unshift(newBug);
  await writeTasks({ tasks });

  console.log('[BugManager] Bug 已保存到文件，type:', newBug.type);
  console.log('[BugManager] ========== createBug 结束 ==========');

  return newBug;
}

/**
 * 迁移Bug数据，添加缺失的字段
 */
async function migrateBugData() {
  console.log('[BugManager] ========== 迁移Bug数据开始 ==========');

  const data = await readTasks();
  const tasks = data.tasks || [];
  const bugs = tasks.filter(t => t.type === 'bug');

  console.log('[BugManager] 找到 Bug 数量:', bugs.length);

  let migratedCount = 0;
  bugs.forEach(bug => {
    let needUpdate = false;

    // 确保所有必需字段都存在
    if (bug.assignedTo === undefined) {
      bug.assignedTo = '';
      needUpdate = true;
    }
    if (bug.assignedToList === undefined) {
      bug.assignedToList = [];
      needUpdate = true;
    }
    if (bug.cc === undefined) {
      bug.cc = [];
      needUpdate = true;
    }
    if (bug.comment === undefined) {
      bug.comment = '';
      needUpdate = true;
    }
    if (bug.projectName === undefined) {
      bug.projectName = '';
      needUpdate = true;
    }

    if (needUpdate) {
      migratedCount++;
      console.log('[BugManager] 迁移 Bug:', bug.id, bug.title);
    }
  });

  if (migratedCount > 0) {
    await writeTasks({ tasks });
    console.log('[BugManager] ✓ 已迁移', migratedCount, '个Bug');
  } else {
    console.log('[BugManager] 所有Bug数据已是最新，无需迁移');
  }

  console.log('[BugManager] ========== 迁移Bug数据结束 ==========');
  return { migratedCount, total: bugs.length };
}

/**
 * 获取所有 Bug
 */
async function getBugs(filters = {}) {
  console.log('[BugManager] ========== getBugs 开始 ==========');
  console.log('[BugManager] 过滤条件:', filters);

  const data = await readTasks();
  const allTasks = data.tasks || [];

  console.log('[BugManager] 总任务数量:', allTasks.length);

  // 统计不同类型的任务
  const typeStats = {};
  allTasks.forEach(t => {
    typeStats[t.type] = (typeStats[t.type] || 0) + 1;
  });
  console.log('[BugManager] 任务类型统计:', typeStats);

  let bugs = allTasks.filter(t => t.type === 'bug');

  console.log('[BugManager] 过滤出 type=bug 的任务数量:', bugs.length);

  // 打印前几个 Bug 的信息
  bugs.slice(0, 5).forEach((bug, index) => {
    console.log(`[BugManager] Bug ${index + 1}:`, {
      id: bug.id,
      title: bug.title,
      type: bug.type,
      zentaoId: bug.zentaoId,
      status: bug.status
    });
  });

  // 按状态筛选
  if (filters.status) {
    // Bug 状态映射
    const statusMap = {
      'todo': 'unconfirmed',
      'in_progress': 'activated',
      'done': 'closed'
    };
    const bugStatus = statusMap[filters.status] || filters.status;
    console.log('[BugManager] 状态筛选:', filters.status, '->', bugStatus);
    const beforeFilter = bugs.length;
    bugs = bugs.filter(b => b.status === bugStatus);
    console.log('[BugManager] 状态筛选后数量:', bugs.length, '(筛选前:', beforeFilter, ')');
  }

  // 按执行筛选
  if (filters.executionId) {
    console.log('[BugManager] 执行筛选: executionId =', filters.executionId);
    const beforeFilter = bugs.length;
    bugs = bugs.filter(b => b.executionId === filters.executionId);
    console.log('[BugManager] 执行筛选后数量:', bugs.length, '(筛选前:', beforeFilter, ')');
  }

  console.log('[BugManager] 最终返回的 Bug 数量:', bugs.length);
  console.log('[BugManager] ========== getBugs 结束 ==========');

  return bugs;
}

/**
 * 更新 Bug 状态
 * @param {string} bugId - Bug ID
 * @param {string} newStatus - 新状态
 * @param {Object} extraData - 额外数据 { assignedTo, cc, comment }
 */
async function updateBugStatus(bugId, newStatus, extraData = {}) {
  const data = await readTasks();
  const tasks = data.tasks || [];

  const bug = tasks.find(t => t.id === bugId && t.type === 'bug');
  if (!bug) {
    throw new Error(`Bug ${bugId} 不存在`);
  }

  bug.status = newStatus;
  bug.updatedAt = new Date().toISOString();

  // 保存额外数据
  if (extraData.assignedTo !== undefined) {
    bug.assignedTo = extraData.assignedTo;
    bug.assignedToList = extraData.assignedToList || [];
  }
  if (extraData.cc !== undefined) {
    bug.cc = extraData.cc;
  }
  if (extraData.comment !== undefined) {
    bug.comment = extraData.comment;
  }

  await writeTasks({ tasks });
  return bug;
}

/**
 * 删除 Bug
 */
async function deleteBug(bugId) {
  const data = await readTasks();
  const tasks = data.tasks || [];

  const index = tasks.findIndex(t => t.id === bugId && t.type === 'bug');
  if (index === -1) {
    throw new Error(`Bug ${bugId} 不存在`);
  }

  tasks.splice(index, 1);
  await writeTasks({ tasks });
  return true;
}

/**
 * 删除所有 Bug
 */
async function deleteAllBugs() {
  const data = await readTasks();
  const tasks = data.tasks || [];

  const beforeCount = tasks.filter(t => t.type === 'bug').length;
  // 过滤掉所有 type 为 'bug' 的任务
  const filteredTasks = tasks.filter(t => t.type !== 'bug');
  const afterCount = filteredTasks.length;

  await writeTasks({ tasks: filteredTasks });
  return { deletedCount: beforeCount, remainingCount: afterCount };
}

/**
 * 获取 Bug 统计
 */
async function getBugStats() {
  const bugs = await getBugs();

  const stats = {
    total: bugs.length,
    unconfirmed: bugs.filter(b => b.status === 'unconfirmed').length,
    activated: bugs.filter(b => b.status === 'activated').length,
    resolved: bugs.filter(b => b.status === 'resolved').length,
    closed: bugs.filter(b => b.status === 'closed').length
  };

  // 按执行分组统计
  const byExecution = {};
  bugs.forEach(bug => {
    const key = bug.executionId || 'unassigned';
    if (!byExecution[key]) {
      byExecution[key] = {
        executionId: key,
        executionName: bug.executionName || '未分配',
        count: 0
      };
    }
    byExecution[key].count++;
  });

  stats.byExecution = Object.values(byExecution);
  return stats;
}

/**
 * 将 Bug 转换为任务状态用于显示
 */
function bugToTaskStatus(bugStatus) {
  const statusMap = {
    'unconfirmed': 'todo',
    'activated': 'in_progress',
    'resolved': 'in_progress',
    'closed': 'done'
  };
  return statusMap[bugStatus] || 'todo';
}

/**
 * 将任务状态转换为 Bug 状态
 */
function taskStatusToBugStatus(taskStatus) {
  const statusMap = {
    'todo': 'unconfirmed',
    'in_progress': 'activated',
    'done': 'closed'
  };
  return statusMap[taskStatus] || 'unconfirmed';
}

/**
 * @deprecated 创建禅道 Bug（已废弃）
 * 请使用浏览器端 ZentaoBrowserClient 通过 executeBugInZentaoPage 完成
 */
async function createZentaoBug(bugData) {
  console.warn('[BugManager] createZentaoBug 已废弃，请使用浏览器端');
  return {
    success: false,
    message: '已废弃：请使用浏览器端 ZentaoBrowserClient'
  };
}

/**
 * @deprecated 更新禅道 Bug 状态（已废弃）
 * 请使用浏览器端完成
 */
async function updateZentaoBugStatus(bugId, status) {
  console.warn('[BugManager] updateZentaoBugStatus 已废弃，请使用浏览器端');
  return {
    success: false,
    message: '已废弃：请使用浏览器端'
  };
}

/**
 * 创建 Bug（本地+禅道）
 * 注意：禅道同步已迁移到浏览器端，此函数仅处理本地存储
 * 如果前端已提供 zentaoId（浏览器端同步成功），直接使用
 */
async function createBugWithSync(bugData) {
  // 先创建本地 Bug
  const localBug = await createBug(bugData);
  let syncResult = null;

  // 如果前端已经提供了 zentaoId（浏览器端已同步），直接使用
  if (bugData.zentaoId) {
    localBug.zentaoId = bugData.zentaoId;
    // 保存到本地
    const data = await readTasks();
    const tasks = data.tasks || [];
    const bug = tasks.find(t => t.id === localBug.id);
    if (bug) {
      bug.zentaoId = bugData.zentaoId;
      await writeTasks({ tasks });
    }
    syncResult = { success: true, bugId: bugData.zentaoId, fromBrowser: true };
    console.log('[BugManager] 使用浏览器端同步的禅道 ID:', bugData.zentaoId);
    return { localBug, syncResult };
  }

  // 后端不再尝试同步到禅道（已迁移到浏览器端）
  // 所有禅道操作应通过前端 ZentaoBrowserClient 完成
  console.log('[BugManager] Bug 已在本地创建，禅道同步需通过浏览器端完成');
  syncResult = { success: false, message: '禅道同步需通过浏览器端完成' };

  return { localBug, syncResult };
}

export {
  createBug,
  createBugWithSync,
  getBugs,
  updateBugStatus,
  deleteBug,
  deleteAllBugs,
  getBugStats,
  bugToTaskStatus,
  taskStatusToBugStatus,
  createZentaoBug,
  updateZentaoBugStatus
};
