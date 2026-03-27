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

/**
 * 创建禅道 Bug
 */
async function createZentaoBug(bugData) {
  const { config } = await import('../config.js');

  if (!config.zentao.enabled) {
    throw new Error('禅道未启用');
  }

  try {
    // 获取 cookie
    const { getZentaoCookies, cookiesToString } = await import('./zentaoService.js');
    const cookies = await getZentaoCookies();
    const cookieHeader = cookiesToString(cookies);

    // 获取项目的默认产品 ID（如果有）
    let productId = bugData.productId || '1';
    let executionId = bugData.executionId || '';

    // 如果提供了 projectId，获取该项目的执行信息
    if (bugData.projectId) {
      const { getProjectById } = await import('./projectManager.js');
      const project = await getProjectById(bugData.projectId);
      if (project && project.executionId) {
        executionId = project.executionId;
      }
    }

    // 构建 Bug 创建请求
    const formData = new FormData();
    formData.append('product', productId);
    formData.append('branch', '0');
    formData.append('execution', executionId);
    formData.append('module', '0');
    formData.append('title', bugData.title);
    formData.append('severity', String(bugData.severity || 3));
    formData.append('type', bugData.type || 'codeerror');
    formData.append('steps', bugData.steps || '');
    formData.append('status', 'active');

    const endpoint = `${config.zentao.url}/zentao/bug-create-${productId}-.json`;

    console.log('[BugManager] 创建禅道 Bug:', bugData.title, '执行ID:', executionId);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Cookie': cookieHeader,
      },
      body: formData,
    });

    const responseText = await response.text();

    if (!response.ok) {
      console.error('[BugManager] HTTP 错误:', response.status, responseText.substring(0, 200));
      return {
        success: false,
        message: `HTTP ${response.status}`
      };
    }

    let data;
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      console.error('[BugManager] 响应解析失败:', responseText.substring(0, 200));
      return {
        success: false,
        message: '响应解析失败'
      };
    }

    // 检查登录是否超时
    if (data.message && (
      data.message.includes('登录已超时') ||
      data.message.includes('请重新登入') ||
      data.message.includes('请先登录')
    )) {
      console.log('[BugManager] 检测到禅道登录超时');
      return {
        success: false,
        needRelogin: true,
        message: '禅道登录已超时，需要重新登录'
      };
    }

    // 检查返回结果
    if (data.result === 'success' || data.status === 'success') {
      const bugId = data.id || data.bug?.id || data.data?.id;
      console.log('[BugManager] Bug 创建成功, ID:', bugId);
      return {
        success: true,
        bugId: bugId,
        message: 'Bug 已同步到禅道'
      };
    }

    // 检查是否是定位到 Bug 列表的成功响应
    if (data.locate && data.locate.includes('bug-view')) {
      const match = data.locate.match(/bug-view-(\d+)/);
      if (match) {
        const bugId = parseInt(match[1]);
        console.log('[BugManager] Bug 创建成功, ID:', bugId);
        return {
          success: true,
          bugId: bugId,
          message: 'Bug 已同步到禅道'
        };
      }
    }

    const errorMessage = data.message || data.error || '未知错误';
    console.error('[BugManager] 禅道返回错误:', errorMessage);
    return {
      success: false,
      message: errorMessage
    };
  } catch (err) {
    console.error('[BugManager] 创建 Bug 异常:', err.message);
    return {
      success: false,
      message: err.message
    };
  }
}

/**
 * 更新禅道 Bug 状态
 */
async function updateZentaoBugStatus(bugId, status) {
  const { config } = await import('../config.js');

  if (!config.zentao.enabled) {
    throw new Error('禅道未启用');
  }

  try {
    const { getZentaoCookies, cookiesToString } = await import('./zentaoService.js');
    const cookies = await getZentaoCookies();
    const cookieHeader = cookiesToString(cookies);

    // 状态映射到操作
    const statusActionMap = {
      'confirmed': 'confirm',
      'active': 'activate',
      'activated': 'activate',
      'resolved': 'resolve',
      'closed': 'close'
    };

    const action = statusActionMap[status];
    if (!action) {
      return {
        success: false,
        message: `不支持的状态: ${status}`
      };
    }

    const endpoint = `${config.zentao.url}/zentao/bug-${action}-${bugId}.json`;

    console.log('[BugManager] 更新 Bug 状态:', bugId, '->', status);

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'Cookie': cookieHeader,
      },
    });

    const data = await response.json();

    if (data.result === 'success' || data.status === 'success') {
      return {
        success: true,
        message: '状态已更新'
      };
    }

    return {
      success: false,
      message: data.message || '更新失败'
    };
  } catch (err) {
    console.error('[BugManager] 更新 Bug 状态失败:', err.message);
    return {
      success: false,
      message: err.message
    };
  }
}

/**
 * 创建 Bug（本地+禅道）
 */
async function createBugWithSync(bugData) {
  // 先创建本地 Bug
  const localBug = await createBug(bugData);

  // 尝试同步到禅道
  try {
    const zentaoResult = await createZentaoBug({
      ...bugData,
      executionId: localBug.executionId
    });

    if (zentaoResult.success && zentaoResult.bugId) {
      // 更新本地 Bug 的 zentaoId
      const data = await readTasks();
      const tasks = data.tasks || [];
      const bug = tasks.find(t => t.id === localBug.id);
      if (bug) {
        bug.zentaoId = zentaoResult.bugId;
        await writeTasks({ tasks });
      }
    }
  } catch (err) {
    console.error('[BugManager] 同步到禅道失败:', err);
    // 本地创建成功，但禅道同步失败，不影响本地使用
  }

  return localBug;
}

export {
  createBug,
  createBugWithSync,
  getBugs,
  updateBugStatus,
  deleteBug,
  getBugStats,
  bugToTaskStatus,
  taskStatusToBugStatus,
  createZentaoBug,
  updateZentaoBugStatus
};
