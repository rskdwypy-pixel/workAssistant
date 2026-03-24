import { v4 as uuidv4 } from 'uuid';
import { readTasks, writeTasks } from '../utils/storage.js';

/**
 * 创建 Bug
 */
async function createBug(bugData) {
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
    steps: bugData.steps || '',
    os: bugData.os || '',
    browser: bugData.browser || '',
    openedBuild: bugData.openedBuild || 'trunk',
    priority: bugData.priority || 3,
    zentaoId: bugData.zentaoId || null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    progress: 0,
    consumedTime: 0
  };

  tasks.unshift(newBug);
  await writeTasks({ tasks });
  return newBug;
}

/**
 * 获取所有 Bug
 */
async function getBugs(filters = {}) {
  const data = await readTasks();
  let bugs = (data.tasks || []).filter(t => t.type === 'bug');

  // 按状态筛选
  if (filters.status) {
    // Bug 状态映射
    const statusMap = {
      'todo': 'unconfirmed',
      'in_progress': 'activated',
      'done': 'closed'
    };
    const bugStatus = statusMap[filters.status] || filters.status;
    bugs = bugs.filter(b => b.status === bugStatus);
  }

  // 按执行筛选
  if (filters.executionId) {
    bugs = bugs.filter(b => b.executionId === filters.executionId);
  }

  return bugs;
}

/**
 * 更新 Bug 状态
 */
async function updateBugStatus(bugId, newStatus) {
  const data = await readTasks();
  const tasks = data.tasks || [];

  const bug = tasks.find(t => t.id === bugId && t.type === 'bug');
  if (!bug) {
    throw new Error(`Bug ${bugId} 不存在`);
  }

  bug.status = newStatus;
  bug.updatedAt = new Date().toISOString();

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

export {
  createBug,
  getBugs,
  updateBugStatus,
  deleteBug,
  getBugStats,
  bugToTaskStatus,
  taskStatusToBugStatus
};
