import { v4 as uuidv4 } from 'uuid';
import { readTasks, writeTasks, getTasksByDate } from '../utils/storage.js';
import { analyzeTask } from '../ai/openai.js';

/**
 * 获取所有任务
 */
async function getAllTasks(filters = {}) {
  const data = await readTasks();
  let tasks = data.tasks || [];

  // 行数据迁移：旧的 reminderTriggered 逻辑迁移至新的双标志位逻辑
  let needsSave = false;
  tasks.forEach(task => {
    if (task.reminderTriggered !== undefined) {
      if (task.reminderTriggered) {
        task.reminder3hTriggered = true;
        task.reminderExactTriggered = true;
      } else {
        if (task.reminder3hTriggered === undefined) {
          task.reminder3hTriggered = task.reminderTime ? (new Date(task.reminderTime).getTime() - Date.now() <= 3 * 3600000) : false;
        }
        if (task.reminderExactTriggered === undefined) {
          task.reminderExactTriggered = false;
        }
      }
      delete task.reminderTriggered;
      needsSave = true;
    }
  });

  if (needsSave) {
    await writeTasks({ tasks });
  }

  // 按状态筛选
  if (filters.status) {
    tasks = tasks.filter(t => t.status === filters.status);
  }

  // 按日期筛选
  if (filters.date) {
    tasks = getTasksByDate(tasks, filters.date);
  }

  // 排序规则：
  // 1. 手动拖拽位置（order）优先级最高
  // 2. 优先级（priority）高排序靠前
  // 3. 最后修改时间（updatedAt）排序靠前
  tasks.sort((a, b) => {
    // 1. 优先使用手动拖拽的 order 值
    // 如果两个任务都有 order 值，按 order 排序
    if (a.order !== undefined && b.order !== undefined) {
      return a.order - b.order;
    }
    // 如果只有一个有 order 值，有 order 的排前面
    if (a.order !== undefined) return -1;
    if (b.order !== undefined) return 1;

    // 2. 按 priority 排序（1最高，4最低）
    const aPriority = a.priority ?? 3;
    const bPriority = b.priority ?? 3;
    if (aPriority !== bPriority) {
      return aPriority - bPriority;
    }

    // 3. 按 updatedAt 降序排序（最新修改的在前）
    const aTime = new Date(a.updatedAt || a.createdAt).getTime();
    const bTime = new Date(b.updatedAt || b.createdAt).getTime();
    return bTime - aTime;
  });

  return tasks;
}

/**
 * 获取今日任务
 */
async function getTodayTasks() {
  const today = new Date().toISOString().split('T')[0];
  return await getAllTasks({ date: today });
}

/**
 * 获取指定日期的任务
 */
async function getTasksByDateFilter(dateStr) {
  return await getAllTasks({ date: dateStr });
}

/**
 * 搜索任务
 */
async function searchTasks(keyword) {
  const tasks = await getAllTasks();
  const lowerKeyword = keyword.toLowerCase();

  // 1 year time range filter
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  const oneYearAgoMs = oneYearAgo.getTime();

  return tasks.filter(task => {
    const isWithinYear = new Date(task.createdAt).getTime() >= oneYearAgoMs || new Date(task.updatedAt).getTime() >= oneYearAgoMs;
    if (!isWithinYear) return false;

    return task.title?.toLowerCase().includes(lowerKeyword) ||
      task.content?.toLowerCase().includes(lowerKeyword);
  });
}

/**
 * 添加任务（AI自动分析）
 */
async function addTask(content) {
  const data = await readTasks();

  // AI分析任务
  const analysis = await analyzeTask(content);

  // 依据进度二次修正状态
  let parsedStatus = analysis.data.status || 'todo';
  let parsedProgress = analysis.data.progress ?? (parsedStatus === 'done' ? 100 : (parsedStatus === 'in_progress' ? 10 : 0));
  if (parsedProgress > 0 && parsedProgress < 100) parsedStatus = 'in_progress';
  if (parsedProgress === 100) parsedStatus = 'done';

  const task = {
    id: uuidv4(),
    content: content,
    title: analysis.data.title || content.slice(0, 20),
    status: parsedStatus,
    priority: analysis.data.priority ?? 3,
    dueDate: analysis.data.dueDate || null,
    reminderTime: analysis.data.reminderTime || null,
    reminder3hTriggered: analysis.data.reminderTime ? (new Date(analysis.data.reminderTime).getTime() - Date.now() <= 3 * 3600000) : false,
    reminderExactTriggered: false,
    progress: parsedProgress,
    zentaoId: null,           // 禅道任务 ID（由浏览器插件同步）
    zentaoExecution: null,    // 禅道执行 ID（用于编辑任务）
    totalConsumedTime: 0,     // 累计消耗工时（用于计算剩余工时）
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  data.tasks.push(task);
  await writeTasks(data);

  // 注意：禅道同步现在由浏览器插件负责，服务端不再主动同步

  return task;
}


/**
 * 查找相似任务（用于去重）
 */
function findSimilarTask(tasks, title) {
  const today = new Date().toISOString().split('T')[0];

  // 查找最近7天内相同或相似标题的任务
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  return tasks.find(task => {
    const taskDate = new Date(task.createdAt);
    const isRecent = taskDate >= sevenDaysAgo;

    if (!isRecent) return false;

    // 完全匹配标题
    if (task.title === title) return true;

    // 标题相似（包含关系，且长度差异不能过大，防止过度匹配导致不同项目被当成同一个任务）
    const titleLower = task.title.toLowerCase();
    const newTitleLower = title.toLowerCase();

    // 如果互相包含，且长度相差不超过3个字符，则认为是同一个任务变体
    if (titleLower.includes(newTitleLower) || newTitleLower.includes(titleLower)) {
      const lengthDiff = Math.abs(titleLower.length - newTitleLower.length);
      if (lengthDiff <= 3) {
        return true;
      }
    }

    return false;
  });
}

/**
 * 添加或更新任务（智能去重）
 */
async function addOrUpdateTask(content, options = {}) {
  const data = await readTasks();

  // AI分析任务
  const analysis = await analyzeTask(content);

  // 依据进度二次修正状态
  let parsedStatus = analysis.data.status || 'todo';
  let parsedProgress = analysis.data.progress ?? (parsedStatus === 'done' ? 100 : (parsedStatus === 'in_progress' ? 10 : 0));
  if (parsedProgress > 0 && parsedProgress < 100) parsedStatus = 'in_progress';
  if (parsedProgress === 100) parsedStatus = 'done';

  // 获取执行信息
  let executionName = null;
  if (options.executionId) {
    const { getExecutionById } = await import('./executionManager.js');
    const execution = await getExecutionById(options.executionId);
    executionName = execution?.name || `执行 ${options.executionId}`;
  }

  const newTask = {
    title: analysis.data.title || content.slice(0, 20),
    status: parsedStatus,
    priority: analysis.data.priority ?? 3,
    dueDate: analysis.data.dueDate || null,
    reminderTime: analysis.data.reminderTime || null,
    reminder3hTriggered: analysis.data.reminderTime ? (new Date(analysis.data.reminderTime).getTime() - Date.now() <= 3 * 3600000) : false,
    reminderExactTriggered: false,
    progress: parsedProgress,
    executionId: options.executionId || null,
    executionName: executionName
  };

  // 查找相似任务
  const similarTask = findSimilarTask(data.tasks, newTask.title);

  if (similarTask) {
    // 更新现有任务，保留原有的 zentaoId 和 zentaoExecution
    Object.assign(similarTask, {
      content: content,
      status: newTask.status,
      progress: newTask.progress,
      reminderTime: newTask.reminderTime || similarTask.reminderTime,
      zentaoId: options.zentaoId || similarTask.zentaoId,  // 优先使用传入的，否则保留原值
      zentaoExecution: options.zentaoExecution || similarTask.zentaoExecution,  // 优先使用传入的，否则保留原值
      executionId: options.executionId || similarTask.executionId,
      executionName: executionName || similarTask.executionName,
      updatedAt: new Date().toISOString()
    });

    await writeTasks(data);
    return { task: similarTask, isNew: false };
  }

  // 创建新任务
  const task = {
    id: uuidv4(),
    content: content,
    ...newTask,
    zentaoId: options.zentaoId || null,        // 支持传入浏览器端已创建的 zentaoId
    zentaoExecution: options.zentaoExecution || options.executionId || null,  // 禅道执行 ID，兼容旧字段
    totalConsumedTime: 0,  // 累计消耗工时（用于计算剩余工时）
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  data.tasks.push(task);
  await writeTasks(data);

  return { task, isNew: true };
}

/**
 * 更新任务状态
 */
async function updateTaskStatus(taskId, status) {
  const data = await readTasks();
  const task = data.tasks.find(t => t.id === taskId);

  if (!task) {
    throw new Error('任务不存在');
  }

  const oldStatus = task.status;
  task.status = status;
  task.updatedAt = new Date().toISOString();

  await writeTasks(data);

  // 同步到禅道
  if (task.zentaoId && status !== oldStatus) {
    await syncTaskToZentao(task, { status }, oldStatus);
  }

  return task;
}

/**
 * 更新任务
 */
async function updateTask(taskId, updates) {
  const data = await readTasks();
  const task = data.tasks.find(t => t.id === taskId);

  if (!task) {
    throw new Error('任务不存在');
  }

  // Intercept reminderTime updates to calculate trigger flags
  if (updates.reminderTime !== undefined) {
    if (updates.reminderTime) {
      const targetMs = new Date(updates.reminderTime).getTime();
      updates.reminder3hTriggered = (targetMs - Date.now() <= 3 * 3600000);
      updates.reminderExactTriggered = false;
    } else {
      updates.reminder3hTriggered = false;
      updates.reminderExactTriggered = false;
    }
  }

  // 如果 order 明确设置为 null，则删除该字段（取消手动排序）
  if (updates.hasOwnProperty('order') && updates.order === null) {
    delete task.order;
  }

  // 记录进度更新历史
  if (updates.hasOwnProperty('progress') || updates.progressComment || updates.consumedTime) {
    if (!task.progressUpdates) {
      task.progressUpdates = [];
    }
    const now = new Date().toISOString();
    const progressValue = updates.hasOwnProperty('progress') ? updates.progress : task.progress;
    const oldProgress = task.progress ?? 0;
    // 只有进度发生变化，或有工作内容/工时记录时才添加历史
    if (progressValue !== oldProgress || updates.progressComment || updates.consumedTime) {
      task.progressUpdates.push({
        timestamp: now,
        progress: progressValue,
        oldProgress: oldProgress,
        workContent: updates.progressComment || '',
        consumedTime: updates.consumedTime || 0
      });
      // 限制历史记录数量，最多保留20条
      if (task.progressUpdates.length > 20) {
        task.progressUpdates = task.progressUpdates.slice(-20);
      }
    }
  }

  // 保存更新前的旧状态，用于同步时比较
  const oldStatus = task.status;

  Object.assign(task, updates, {
    updatedAt: new Date().toISOString()
  });

  await writeTasks(data);

  // 同步到禅道（传入旧状态用于比较）
  await syncTaskToZentao(task, updates, oldStatus);

  return task;
}

/**
 * 同步任务到禅道
 * 根据执行类型（看板/阶段/迭代）调用不同的API
 * 注意：看板类型执行中的任务，实际上是普通任务（通过 task-create 创建），
 *       只是以看板视图展示。因此应使用 task-* API，而非 kanban-* API。
 *       kanban-* API 是用于独立看板模块的卡片，不适用于执行看板中的任务。
 */
async function syncTaskToZentao(task, updates, oldStatus) {
  if (!task.zentaoId) {
    return; // 没有关联禅道任务，跳过同步
  }

  try {
    // 获取执行信息以判断执行类型
    let executionType = null;
    let kanbanId = null;

    // 优先使用任务上存储的 executionType
    if (task.executionType) {
      executionType = task.executionType;
      kanbanId = task.executionId;
    } else if (task.executionId) {
      const { getExecutionById } = await import('./executionManager.js');
      const execution = await getExecutionById(task.executionId);
      if (execution) {
        executionType = execution.type;
        kanbanId = execution.kanbanId || execution.id;
      }
    }

    console.log('[TaskManager] 同步到禅道:', {
      zentaoId: task.zentaoId,
      executionId: task.executionId,
      executionType,
      kanbanId,
      updatesKeys: Object.keys(updates)
    });

    // 看板类型执行中的任务本质上也是普通任务，统一使用 task-* API
    // （kanban-editCard 等 API 是用于独立看板模块的卡片，不适用于执行看板中的任务）
    await syncTaskToExecution(task, updates, oldStatus);

  } catch (err) {
    console.error('[TaskManager] 同步到禅道失败:', err);
    // 同步失败不影响本地更新
  }
}

/**
 * 同步任务到看板（已废弃，保留用于参考）
 * 注意：看板执行中的任务现在统一使用 syncTaskToExecution，
 *       因为它们是通过 task-create 创建的普通任务。
 * @deprecated 使用 syncTaskToExecution 代替
 */
async function syncTaskToKanban(task, updates, kanbanId) {
  // 看板执行中的任务本质上是普通任务，使用 task-* API
  await syncTaskToExecution(task, updates);
}

/**
 * 同步任务到阶段/迭代/看板执行
 * 看板执行中的任务也是通过 task-create 创建的普通任务，使用相同的 task-* API
 * @param {Object} task - 任务对象（已更新后的）
 * @param {Object} updates - 本次更新的字段
 * @param {string} oldStatus - 更新前的旧状态
 */
async function syncTaskToExecution(task, updates, oldStatus) {
  const { updateTaskStatus: updateZentaoStatus, recordTaskEstimate } = await import('./zentaoService.js');

  // 同步状态变化（使用 oldStatus 与 updates.status 比较，因为 task.status 已经被更新过了）
  if (updates.status && oldStatus && updates.status !== oldStatus) {
    const statusMap = {
      'todo': 'wait',
      'in_progress': 'doing',
      'done': 'done'
    };
    const zentaoStatus = statusMap[updates.status];
    if (zentaoStatus) {
      await updateZentaoStatus(task.zentaoId, zentaoStatus);
      console.log('[TaskManager] 状态已同步到禅道:', task.zentaoId, oldStatus, '->', updates.status, '(zentao:', zentaoStatus + ')');
    }
  }

  // 同步工时记录
  if (updates.consumedTime && updates.consumedTime > 0) {
    // 计算剩余工时
    const totalConsumedTime = task.totalConsumedTime || updates.consumedTime;
    const currentProgress = updates.progress !== undefined ? updates.progress : (task.progress || 0);
    let leftTime = 0;

    if (currentProgress > 0 && currentProgress < 100 && totalConsumedTime > 0) {
      leftTime = Math.round((totalConsumedTime / (currentProgress / 100) - totalConsumedTime) * 10) / 10;
      if (leftTime < 0) leftTime = 0;
    } else if (currentProgress === 100) {
      leftTime = 0;
    } else if (totalConsumedTime > 0) {
      leftTime = totalConsumedTime * 2;
    }

    const result = await recordTaskEstimate(task.zentaoId, {
      work: updates.progressComment || `进度更新至 ${currentProgress}%`,
      consumed: updates.consumedTime,
      left: leftTime
    });

    if (result.success) {
      console.log('[TaskManager] 工时已同步到禅道:', task.zentaoId, `consumed=${updates.consumedTime}h, left=${leftTime}h`);
    } else {
      console.error('[TaskManager] 工时同步失败:', task.zentaoId, result.message);
    }
  }
}

/**
 * 删除任务
 */
async function deleteTask(taskId) {
  const data = await readTasks();
  const index = data.tasks.findIndex(t => t.id === taskId);

  if (index === -1) {
    throw new Error('任务不存在');
  }

  data.tasks.splice(index, 1);
  await writeTasks(data);

  return { success: true };
}

/**
 * 删除所有本地任务（不影响禅道任务）
 */
async function deleteAllTasks() {
  const data = await readTasks();
  const deletedCount = data.tasks.length;
  data.tasks = [];
  await writeTasks(data);

  return { success: true, deletedCount };
}

/**
 * 获取任务统计
 */
async function getTaskStats() {
  const tasks = await getAllTasks();
  const now = new Date();

  // start of today
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  // start of week (Monday)
  const day = now.getDay() || 7;
  const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1).getTime();

  // start of month
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  let todayDone = 0;
  let weekDone = 0;
  let monthDone = 0;

  const doneTasks = tasks.filter(t => t.status === 'done');

  // Calculate done counts based on updatedAt (when they were marked as done) or createdAt
  doneTasks.forEach(task => {
    const time = new Date(task.updatedAt || task.createdAt).getTime();
    if (time >= monthStart) monthDone++;
    if (time >= weekStart) weekDone++;
    if (time >= todayStart) todayDone++;
  });

  // Calculate streak (consecutive days with at least 1 task done)
  let streak = 0;
  const doneDays = new Set(doneTasks.map(t => new Date(t.updatedAt || t.createdAt).toISOString().split('T')[0]));

  // Start checking from today, go backwards
  let currentCheck = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // If no task done today, we still check yesterday to not break the streak
  let streakCheckingDate = new Date(currentCheck);
  const todayStr = streakCheckingDate.toISOString().split('T')[0];

  if (!doneDays.has(todayStr)) {
    streakCheckingDate.setDate(streakCheckingDate.getDate() - 1);
  }

  while (true) {
    const checkStr = streakCheckingDate.toISOString().split('T')[0];
    if (doneDays.has(checkStr)) {
      streak++;
      streakCheckingDate.setDate(streakCheckingDate.getDate() - 1);
    } else {
      break;
    }
  }

  return {
    total: tasks.length,
    todo: tasks.filter(t => t.status === 'todo').length,
    inProgress: tasks.filter(t => t.status === 'in_progress').length,
    done: doneTasks.length,
    todayDone,
    weekDone,
    monthDone,
    streak
  };
}

/**
 * 获取日历数据（指定月份）
 */
async function getCalendarData(year, month) {
  const tasks = await getAllTasks();
  const days = {};

  // 获取该月的所有任务
  tasks.forEach(task => {
    const taskDate = new Date(task.createdAt);
    if (taskDate.getFullYear() === year && taskDate.getMonth() + 1 === month) {
      const day = taskDate.getDate();
      if (!days[day]) {
        days[day] = { total: 0, done: 0 };
      }
      days[day].total++;
      if (task.status === 'done') {
        days[day].done++;
      }
    }
  });

  return {
    year,
    month,
    days
  };
}

/**
 * 批量更新任务（用于拖动排序等）
 */
async function batchUpdateTasks(updates) {
  const data = await readTasks();
  let updatedCount = 0;

  updates.forEach(update => {
    const idx = data.tasks.findIndex(t => t.id === update.id);
    if (idx !== -1) {
      Object.assign(data.tasks[idx], update);
      data.tasks[idx].updatedAt = new Date().toISOString();
      updatedCount++;
    }
  });

  if (updatedCount > 0) {
    await writeTasks(data);
  }
  return data.tasks;
}


export {
  getAllTasks,
  getTodayTasks,
  getTasksByDateFilter,
  searchTasks,
  addTask,
  addOrUpdateTask,
  updateTaskStatus,
  updateTask,
  deleteTask,
  deleteAllTasks,
  getTaskStats,
  getCalendarData,
  batchUpdateTasks
};
