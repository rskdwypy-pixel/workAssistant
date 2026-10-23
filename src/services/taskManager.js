import { v4 as uuidv4 } from 'uuid';
import { readTasks, updateTasks, zentaoKeyOf, getTasksByDate } from '../utils/storage.js';
import { parseTaskLocally } from '../ai/localTaskParser.js';
import { removeRecordFiles } from './attachmentStore.js';

/**
 * 旧的 reminderTriggered 单标志位迁移为双标志位
 * @returns {boolean} 是否有记录被迁移
 */
function migrateReminderFlags(tasks) {
  let migrated = false;
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
      migrated = true;
    }
  });
  return migrated;
}

/** 那天我填过工时的禅道任务 ID（读工时缓存，缓存 5 分钟内不请求禅道；任何失败都当没有） */
async function taskIdsWorkedOn(dateStr) {
  try {
    const { getMonthEfforts } = await import('./effortService.js');
    const r = await getMonthEfforts(String(dateStr).slice(0, 7), { maxAge: 5 * 60 * 1000 });
    return new Set(((r.days || {})[dateStr] || { items: [] }).items.map(i => String(i.taskId)));
  } catch {
    return new Set();
  }
}


/**
 * 获取所有任务
 */
async function getAllTasks(filters = {}) {
  const data = await readTasks();
  let tasks = data.tasks || [];

  // 去重：同步过禅道的按「类型+禅道ID」，否则按本地 id
  const taskMap = new Map();
  tasks.forEach(task => {
    // 统一 zentaoId 为 string 类型（如果存在）
    if (task.zentaoId && typeof task.zentaoId !== 'string') {
      task.zentaoId = String(task.zentaoId);
    }
    // 修复缺失或无效的 type 字段
    if (task.type !== 'task' && task.type !== 'bug') {
      task.type = 'task';
    }
    const key = zentaoKeyOf(task) || task.id;
    // 如果有重复，保留最新的（按 updatedAt）
    const existing = taskMap.get(key);
    if (!existing ||
        new Date(task.updatedAt || task.createdAt) > new Date(existing.updatedAt || existing.createdAt)) {
      taskMap.set(key, task);
    }
  });
  tasks = Array.from(taskMap.values());

  if (migrateReminderFlags(tasks)) {
    // 迁移只改标志位，在锁内对最新数据重做一遍再落盘，不把读侧的去重结果写回去
    await updateTasks((fresh) => {
      migrateReminderFlags(fresh.tasks);
      return fresh;
    });
  }

  // 按状态筛选
  if (filters.status) {
    tasks = tasks.filter(t => t.status === filters.status);
  }

  // 按日期筛选
  if (filters.date) {
    // 那天填过工时的任务也算那天的任务（补填、在禅道网页上填的都算），否则补过的日子在任务页看不到
    const worked = await taskIdsWorkedOn(filters.date);
    const byDate = new Set(getTasksByDate(tasks, filters.date));
    tasks = tasks.filter(t => byDate.has(t) || (t.type !== 'bug' && t.zentaoId && worked.has(String(t.zentaoId))));
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
 *
 * options.preAnalysis：调用方（taskIntake）已得到的字段分析结果。
 * 保存阶段不调用大模型：没有分析结果时用本地规则解析，保证保存始终是毫秒级。
 */
async function addOrUpdateTask(content, options = {}) {
  const data = options.preAnalysis && !options.preAnalysis.failed
    ? options.preAnalysis
    : parseTaskLocally(content);
  const analysis = { success: true, failed: false, data };

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

  // —— 表单值优先于 AI 推断 ——
  // 用户在弹窗里手动改过的字段就是最终结论（显式操作 > 模型推断）。
  // 早期版本这些表单字段被后端整体忽略，导致用户在弹窗里改的
  // 优先级/进度/截止时间/指派人一提交就丢。
  const fd = options.formData || {};
  if (Number.isFinite(fd.priority)) newTask.priority = fd.priority;
  if (Number.isFinite(fd.progress)) newTask.progress = fd.progress;
  if (fd.status) newTask.status = fd.status;
  if (fd.dueDate) newTask.dueDate = fd.dueDate;
  if (Array.isArray(fd.assignees)) {
    newTask.assignedToList = fd.assignees;
    newTask.assignedTo = fd.assignees[0] || null;
  }
  if (Array.isArray(fd.cc)) {
    newTask.ccList = fd.cc;
  }

  // 进度与状态最终一致性（表单覆盖后重新对齐）
  if (newTask.progress > 0 && newTask.progress < 100) newTask.status = 'in_progress';
  if (newTask.progress >= 100) newTask.status = 'done';
  if (newTask.progress === 0 && newTask.status === 'in_progress') newTask.status = 'todo';

  // 读-改-写整体放进互斥事务，防止并发下任务凭空丢失
  let result = null;

  await updateTasks((data) => {
    // 查找相似任务
    const similarTask = findSimilarTask(data.tasks, newTask.title);

    if (similarTask) {
      // 更新现有任务，保留原有的 zentaoId 和 zentaoExecution
      Object.assign(similarTask, {
        content: content,
        status: newTask.status,
        progress: newTask.progress,
        priority: newTask.priority,
        dueDate: newTask.dueDate || similarTask.dueDate,
        assignedTo: newTask.assignedTo || similarTask.assignedTo,
        assignedToList: newTask.assignedToList || similarTask.assignedToList,
        ccList: newTask.ccList || similarTask.ccList,
        reminderTime: newTask.reminderTime || similarTask.reminderTime,
        zentaoId: options.zentaoId || similarTask.zentaoId,
        zentaoExecution: options.zentaoExecution || similarTask.zentaoExecution,
        executionId: options.executionId || similarTask.executionId,
        executionName: executionName || similarTask.executionName,
        updatedAt: new Date().toISOString()
      });

      result = { task: similarTask, isNew: false };
      return data;
    }

    const task = {
      id: uuidv4(),
      type: 'task',
      content: content,
      ...newTask,
      zentaoId: options.zentaoId || null,
      zentaoExecution: options.zentaoExecution || options.executionId || null,
      totalConsumedTime: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    data.tasks.push(task);
    result = { task, isNew: true };
    return data;
  });

  return result;
}

/**
 * 更新任务状态
 */
async function updateTaskStatus(taskId, status) {
  let task = null;
  await updateTasks((data) => {
    task = data.tasks.find(t => t.id === taskId);
    if (!task) {
      throw new Error('任务不存在');
    }
    task.status = status;
    task.updatedAt = new Date().toISOString();
    return data;
  });
  return task;
}

/**
 * 更新任务
 */
async function updateTask(taskId, updates) {
  let task = null;
  await updateTasks((data) => {
    task = data.tasks.find(t => t.id === taskId);
    if (!task) {
      throw new Error('任务不存在');
    }
    applyTaskUpdates(task, updates);
    return data;
  });
  return task;
}

/**
 * 把更新应用到任务对象上（含提醒标志位与进度历史）
 */
function applyTaskUpdates(task, updates) {
  // 附件元数据由附件服务维护，前端提交的整条任务里可能带着旧的 attachments，不能覆盖
  delete updates.attachments;

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

  Object.assign(task, updates, {
    updatedAt: new Date().toISOString()
  });
}

/**
 * 删除任务
 */
async function deleteTask(taskId) {
  // 走互斥事务，避免与并发的「读-改-写」互相覆盖
  await updateTasks((data) => {
    const index = data.tasks.findIndex(t => t.id === taskId);
    if (index === -1) {
      throw new Error('任务不存在');
    }
    data.tasks.splice(index, 1);
    return data;
  });
  await removeRecordFiles(taskId);

  return { success: true };
}

/**
 * 删掉禅道里已删除的任务 / Bug 的本地记录（同步时调用，一切以禅道为准）
 * @param {'task'|'bug'} type
 * @param {Array<string|number>} zentaoIds
 * @returns {Promise<number>} 删掉的条数
 */
async function removeZentaoDeleted(type, zentaoIds) {
  if (!zentaoIds || !zentaoIds.length) return 0;
  const ids = new Set(zentaoIds.map(String));
  const matches = (t) => t.zentaoId && ids.has(String(t.zentaoId)) && (type === 'bug' ? t.type === 'bug' : t.type !== 'bug');
  let removedIds = [];
  await updateTasks((data) => {
    removedIds = data.tasks.filter(matches).map(t => t.id);
    data.tasks = data.tasks.filter(t => !matches(t));
    return data;
  });
  for (const id of removedIds) await removeRecordFiles(id);
  if (removedIds.length) console.log(`[TaskManager] 禅道里已删除，移除本地${type === 'bug' ? ' Bug' : '任务'}: ${[...ids].join(', ')}`);
  return removedIds.length;
}

/**
 * 删除所有本地任务（不影响禅道任务）
 */
async function deleteAllTasks() {
  let deletedCount = 0;
  let removedIds = [];
  await updateTasks((data) => {
    deletedCount = data.tasks.length;
    removedIds = data.tasks.map(t => t.id);
    data.tasks = [];
    return data;
  });
  for (const id of removedIds) await removeRecordFiles(id);

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
  const data = await updateTasks((data) => {
    updates.forEach(update => {
      const idx = data.tasks.findIndex(t => t.id === update.id);
      if (idx !== -1) {
        const { attachments, ...rest } = update; // 附件元数据由附件服务维护
        Object.assign(data.tasks[idx], rest);
        data.tasks[idx].updatedAt = new Date().toISOString();
      }
    });
    return data;
  });
  return data.tasks;
}


/**
 * 按「类型+禅道ID」去重，保留最新的一条（updatedAt，其次 createdAt）
 * 只处理带 zentaoId 的记录，任务与 Bug 互不干扰。
 * @returns {{ tasks: Array, removed: { task: number, bug: number } }}
 */
function dedupeZentaoRecords(tasks) {
  const latest = new Map();
  const toDelete = new Set();
  const removed = { task: 0, bug: 0 };

  tasks.forEach(t => {
    const key = zentaoKeyOf(t);
    if (!key) return;
    const existing = latest.get(key);
    if (!existing) {
      latest.set(key, t);
      return;
    }
    const existingTime = new Date(existing.updatedAt || existing.createdAt).getTime();
    const currentTime = new Date(t.updatedAt || t.createdAt).getTime();
    const loser = currentTime > existingTime ? existing : t;
    if (loser === existing) latest.set(key, t);
    toDelete.add(loser.id);
    removed[loser.type === 'bug' ? 'bug' : 'task']++;
    console.log('[TaskManager] 删除重复记录:', loser.id, key, loser.title);
  });

  return {
    tasks: toDelete.size ? tasks.filter(t => !toDelete.has(t.id)) : tasks,
    removed
  };
}

/** 禅道同步会覆盖的字段 */
const ZENTAO_TASK_FIELDS = [
  'title', 'status', 'priority', 'executionId', 'executionName',
  'projectName', 'projectId', 'progress', 'totalConsumedTime'
];
/**
 * 其中只有这些字段变化才刷新 updatedAt：
 * 日历和「今日完成」按 updatedAt 判断任务哪天完成，补全执行/项目名、工时这类元数据
 * 不能让历史上已完成的任务全部「挪到今天」。
 */
const ZENTAO_TASK_SIGNIFICANT_FIELDS = ['title', 'status', 'priority'];

/**
 * 批量导入禅道任务（去重）
 *
 * 只处理 type !== 'bug' 的记录：Bug 有自己的编号空间和导入逻辑（bugManager.importZentaoBugs）。
 * updatedAt 只在禅道字段真的变化时才刷新——日历按它判断「哪天完成」，不能每次同步都改。
 *
 * @param {Array} zentaoTasks - 从禅道获取的任务列表
 * @returns {Promise<Object>} { added, updated, unchanged, skipped }
 */
async function importZentaoTasks(zentaoTasks) {
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;

  await updateTasks((data) => {
    const tasks = data.tasks || [];
    const existingByKey = new Map();
    tasks.forEach(t => {
      if (t.type === 'bug' || !t.zentaoId) return;
      if (t.type !== 'task') t.type = 'task';
      if (typeof t.zentaoId !== 'string') t.zentaoId = String(t.zentaoId);
      existingByKey.set(zentaoKeyOf(t), t);
    });

    const now = new Date().toISOString();
    for (const zentaoTask of zentaoTasks) {
      try {
        const zentaoId = String(zentaoTask.zentaoId);
        const incoming = {
          title: zentaoTask.title,
          status: zentaoTask.status,
          priority: zentaoTask.priority,
          totalConsumedTime: zentaoTask.consumed || 0
        };
        // 禅道给不出进度（未填预计工时）时传 null，此时保留本地进度
        if (zentaoTask.progress !== null && zentaoTask.progress !== undefined) {
          incoming.progress = zentaoTask.progress;
        }
        const existingTask = existingByKey.get(`task:${zentaoId}`);

        if (existingTask) {
          // 只覆盖禅道侧字段，保留本地修改的字段
          Object.assign(incoming, {
            executionId: zentaoTask.executionId ? String(zentaoTask.executionId) : existingTask.executionId,
            executionName: zentaoTask.executionName || existingTask.executionName,
            projectName: zentaoTask.projectName || existingTask.projectName,
            projectId: zentaoTask.projectId || existingTask.projectId
          });
          const differs = (f) => f in incoming && String(existingTask[f] ?? '') !== String(incoming[f] ?? '');
          if (ZENTAO_TASK_FIELDS.some(differs)) {
            const significant = ZENTAO_TASK_SIGNIFICANT_FIELDS.some(differs);
            Object.assign(existingTask, incoming, { content: incoming.title });
            if (significant) existingTask.updatedAt = now;
            updated++;
          } else {
            unchanged++;
          }
        } else {
          const newTask = {
            id: uuidv4(),
            type: 'task',
            progress: 0,
            ...incoming,
            content: incoming.title,
            zentaoId,
            executionId: zentaoTask.executionId ? String(zentaoTask.executionId) : '',
            executionName: zentaoTask.executionName || '',
            projectName: zentaoTask.projectName || '',
            projectId: zentaoTask.projectId || '',
            createdAt: now,
            updatedAt: now
          };
          tasks.unshift(newTask);
          existingByKey.set(`task:${zentaoId}`, newTask);
          added++;
        }
      } catch (err) {
        console.error('[TaskManager] 导入任务失败:', zentaoTask && zentaoTask.zentaoId, err.message);
        skipped++;
      }
    }

    data.tasks = dedupeZentaoRecords(tasks).tasks;
    return data;
  });

  console.log(`[TaskManager] 禅道任务导入完成: 新增 ${added} 更新 ${updated} 无变化 ${unchanged} 跳过 ${skipped}`);
  return { added, updated, unchanged, skipped };
}

/**
 * 获取近期任务标题（供 AI 理解用户表达习惯与项目黑话）
 *
 * 只取标题、不做去重等额外处理，避免为了喂上下文而加载全量任务对象。
 *
 * @param {number} limit - 最多返回多少条
 * @returns {Promise<string[]>}
 */
async function getRecentTaskTitles(limit = 8) {
  try {
    const data = await readTasks();
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    return tasks
      .filter(t => t && t.title)
      .slice(-limit)
      .map(t => String(t.title))
      .reverse();
  } catch (e) {
    console.warn('[TaskManager] 读取近期任务标题失败:', e.message);
    return [];
  }
}

export {
  getAllTasks,
  getRecentTaskTitles,
  getTodayTasks,
  getTasksByDateFilter,
  searchTasks,
  addOrUpdateTask,
  updateTaskStatus,
  updateTask,
  deleteTask,
  deleteAllTasks,
  removeZentaoDeleted,
  getTaskStats,
  getCalendarData,
  batchUpdateTasks,
  importZentaoTasks
};
