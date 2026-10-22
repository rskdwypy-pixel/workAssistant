import { join, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { config } from '../config.js';

// 数据目录取自 config.paths.data（调用时读取，测试可指向临时目录）
const EXECUTIONS_FILE_NAME = 'executions.json';
const executionsFile = () => join(config.paths.data, EXECUTIONS_FILE_NAME);

/**
 * 确保执行文件存在
 */
function ensureExecutionsFile() {
  if (!existsSync(executionsFile())) {
    // 从配置中获取默认执行ID
    const configuredExecutionId = config.zentao.executionId;

    const defaultData = {
      executions: configuredExecutionId ? [{
        id: String(configuredExecutionId),
        name: `执行 ${configuredExecutionId}`,
        isDefault: true
      }] : [],
      defaultExecutionId: configuredExecutionId ? String(configuredExecutionId) : null,
      favoriteExecutionIds: [],  // 新增：初始化收藏列表
      lastSync: null
    };
    writeFileSync(executionsFile(), JSON.stringify(defaultData, null, 2), 'utf-8');
    return defaultData;
  }

  const data = JSON.parse(readFileSync(executionsFile(), 'utf-8'));

  // 确保 favoriteExecutionIds 字段存在
  if (!data.favoriteExecutionIds) {
    data.favoriteExecutionIds = [];
  }

  // 如果文件存在但没有执行，且配置中有执行ID，则自动添加
  if (data.executions.length === 0 && config.zentao.executionId) {
    data.executions.push({
      id: String(config.zentao.executionId),
      name: `执行 ${config.zentao.executionId}`,
      isDefault: true
    });
    data.defaultExecutionId = String(config.zentao.executionId);
    writeFileSync(executionsFile(), JSON.stringify(data, null, 2), 'utf-8');
  }

  return data;
}

/**
 * 写入执行文件
 */
function writeExecutionsFile(data) {
  writeFileSync(executionsFile(), JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * 获取所有执行列表
 * 确保每个执行都有 type 字段
 */
async function getExecutions() {
  const data = ensureExecutionsFile();
  let executions = data.executions || [];

  // 为没有 type 字段的执行补充类型判断
  let needsUpdate = false;
  executions = executions.map(ex => {
    if (!ex.type) {
      needsUpdate = true;
      // 根据名称判断执行类型
      const name = (ex.name || '').toLowerCase();
      let executionType = 'execution'; // 默认为普通执行（阶段/迭代）

      // 判断是否为看板类型 - 检查名称中是否包含"看板"或"kanban"
      if (name.includes('看板') || name.includes('kanban')) {
        executionType = 'kanban';
      } else if (name.includes('迭代') || name.includes('sprint')) {
        executionType = 'sprint';
      } else if (name.includes('阶段') || name.includes('stage')) {
        executionType = 'stage';
      }

      return {
        ...ex,
        type: executionType,
        kanbanId: executionType === 'kanban' ? ex.id : null
      };
    }
    return ex;
  });

  // 如果有更新，保存到文件
  if (needsUpdate) {
    console.log('[ExecutionManager] 更新执行类型字段，保存到文件...');
    data.executions = executions;
    writeExecutionsFile(data);
  }

  return executions;
}

/**
 * 从禅道同步执行列表（后端直连，保留收藏与默认执行）
 * @returns {Promise<Array>} 执行列表
 * @throws {Error} 禅道不可达或解析失败时抛出（不再静默返回旧数据）
 */
async function syncExecutionsFromZentao() {
  if (!config.zentao.enabled) {
    throw new Error('禅道未启用');
  }
  if (!config.zentao.url) {
    throw new Error('禅道 URL 未配置');
  }

  // zentaoService.getExecutions 从 HTML 页面解析，能拿到准确的 type 字段
  const { getExecutions } = await import('./zentaoService.js');
  const executions = await getExecutions();
  if (executions.length === 0) {
    throw new Error('禅道返回的执行列表为空');
  }

  const data = ensureExecutionsFile();
  const defaultId = data.defaultExecutionId ? String(data.defaultExecutionId) : '';
  data.executions = executions.map(ex => ({ ...ex, isDefault: ex.id === defaultId }));
  data.favoriteExecutionIds = Array.from(new Set(data.favoriteExecutionIds || []));
  data.lastSync = new Date().toISOString();
  writeExecutionsFile(data);

  const typeStats = executions.reduce((acc, ex) => {
    acc[ex.type] = (acc[ex.type] || 0) + 1;
    return acc;
  }, {});
  console.log('[ExecutionManager] 同步成功，获取到', executions.length, '个执行，类型分布:', typeStats);

  // 项目列表顺带刷新（失败不影响执行同步）
  try {
    const { syncProjectsFromZentao } = await import('./projectManager.js');
    await syncProjectsFromZentao();
  } catch (err) {
    console.warn('[ExecutionManager] 顺带刷新项目列表失败:', err.message);
  }

  return data.executions;
}

/**
 * 获取默认执行
 */
async function getDefaultExecution() {
  const data = ensureExecutionsFile();
  if (data.defaultExecutionId) {
    const executions = data.executions || [];
    const defaultIdStr = String(data.defaultExecutionId);
    return executions.find(e => String(e.id) === defaultIdStr);
  }
  return null;
}

/**
 * 设置默认执行
 */
async function setDefaultExecution(executionId) {
  const data = ensureExecutionsFile();
  data.defaultExecutionId = executionId;
  data.lastSync = new Date().toISOString();
  writeExecutionsFile(data);
  return true;
}

/**
 * 添加执行
 */
async function addExecution(execution) {
  const data = ensureExecutionsFile();

  // 检查是否已存在
  const exists = data.executions.some(e => e.id === execution.id);
  if (exists) {
    throw new Error(`执行 ID ${execution.id} 已存在`);
  }

  data.executions.push(execution);

  // 如果是第一个执行，自动设为默认
  if (!data.defaultExecutionId) {
    data.defaultExecutionId = execution.id;
  }

  data.lastSync = new Date().toISOString();
  writeExecutionsFile(data);
  return execution;
}

/**
 * 删除执行
 */
async function deleteExecution(executionId) {
  const data = ensureExecutionsFile();

  const index = data.executions.findIndex(e => e.id === executionId);
  if (index === -1) {
    throw new Error(`执行 ID ${executionId} 不存在`);
  }

  data.executions.splice(index, 1);

  // 如果删除的是默认执行，清除默认设置或设置新的默认
  if (data.defaultExecutionId === executionId) {
    data.defaultExecutionId = data.executions.length > 0 ? data.executions[0].id : null;
  }

  data.lastSync = new Date().toISOString();
  writeExecutionsFile(data);
  return true;
}

/**
 * 更新执行
 */
async function updateExecution(executionId, updates) {
  const data = ensureExecutionsFile();

  const execution = data.executions.find(e => e.id === executionId);
  if (!execution) {
    throw new Error(`执行 ID ${executionId} 不存在`);
  }

  Object.assign(execution, updates);
  data.lastSync = new Date().toISOString();
  writeExecutionsFile(data);
  return execution;
}

/**
 * 根据执行 ID 获取执行信息
 */
async function getExecutionById(executionId) {
  const executions = await getExecutions();
  return executions.find(e => e.id === executionId) || null;
}

/**
 * 获取收藏的执行 ID 列表
 */
function getFavoriteExecutionIds() {
  const data = ensureExecutionsFile();
  return data.favoriteExecutionIds || [];
}

/**
 * 获取收藏的执行列表
 */
async function getFavoriteExecutions() {
  const data = ensureExecutionsFile();
  const favoriteIds = data.favoriteExecutionIds || [];
  const executions = data.executions || [];

  console.log('[ExecutionManager] ========== 获取收藏执行 ==========');
  console.log('[ExecutionManager] favoriteExecutionIds:', favoriteIds);
  console.log('[ExecutionManager] 所有执行数量:', executions.length);
  console.log('[ExecutionManager] 所有执行ID:', executions.map(e => e.id));

  // 确保 ID 类型匹配（转换为字符串比较）
  const favorites = executions.filter(e => {
    const isMatch = favoriteIds.some(favId => String(favId) === String(e.id));
    console.log(`[ExecutionManager]   - ID ${e.id} (${e.name}): ${isMatch ? '✓收藏' : '✗不收藏'}`);
    return isMatch;
  });

  console.log('[ExecutionManager] 收藏的执行数量:', favorites.length);
  console.log('[ExecutionManager] =======================================');

  return favorites;
}

/**
 * 设置收藏的执行列表
 */
async function setFavoriteExecutions(executionIds) {
  const data = ensureExecutionsFile();
  data.favoriteExecutionIds = executionIds;
  data.lastSync = new Date().toISOString();
  writeExecutionsFile(data);
  return true;
}

/**
 * 添加收藏执行
 */
async function addFavoriteExecution(executionId) {
  const data = ensureExecutionsFile();
  if (!data.favoriteExecutionIds) {
    data.favoriteExecutionIds = [];
  }
  if (!data.favoriteExecutionIds.includes(executionId)) {
    data.favoriteExecutionIds.push(executionId);
    data.lastSync = new Date().toISOString();
    writeExecutionsFile(data);
  }
  return true;
}

/**
 * 移除收藏执行
 */
async function removeFavoriteExecution(executionId) {
  const data = ensureExecutionsFile();
  if (data.favoriteExecutionIds) {
    data.favoriteExecutionIds = data.favoriteExecutionIds.filter(id => id !== executionId);
    data.lastSync = new Date().toISOString();
    writeExecutionsFile(data);
  }
  return true;
}

/**
 * 获取执行列表（收藏的排在前面）
 */
async function getExecutionsOrdered() {
  const data = ensureExecutionsFile();
  const executions = data.executions || [];
  const favoriteIds = data.favoriteExecutionIds || [];

  // 分离收藏和非收藏
  const favorites = [];
  const others = [];
  executions.forEach(exec => {
    if (favoriteIds.includes(exec.id)) {
      favorites.push({ ...exec, isFavorite: true });
    } else {
      others.push({ ...exec, isFavorite: false });
    }
  });

  return [...favorites, ...others];
}

/**
 * 构建 AI 匹配的候选执行集合
 *
 * 设计要点：默认使用**全部执行**，不再依赖「收藏执行」。
 * 早期实现只把收藏执行喂给 AI，用户一旦没收藏，AI 拿到的就是空候选表，
 * 匹配功能等于关闭。现在以全部执行为基础，默认执行置顶并做容量上限，
 * 既保证候选池完整，又避免一次把几百个执行塞给小模型导致无法判断。
 *
 * @param {Object} options
 * @param {number} options.limit - 最多返回多少个候选，默认 120
 * @returns {Promise<{candidates: Array, totalCount: number, truncated: boolean}>}
 */
async function getAiCandidateExecutions(options = {}) {
  const limit = Number(options.limit) || 120;
  const data = ensureExecutionsFile();
  const executions = data.executions || [];
  const defaultId = data.defaultExecutionId != null ? String(data.defaultExecutionId) : null;

  // 默认执行置顶：兜底时总要有个确定的目标
  const defaultExec = defaultId ? executions.find(e => String(e.id) === defaultId) : null;
  const ordered = [];
  if (defaultExec) ordered.push({ ...defaultExec, isDefault: true });
  // 已关闭/已取消的执行不再作为候选：新任务不会建到关闭的执行里，
  // 留着只会拉长提示词、拖慢模型，还可能被误选
  const inactive = new Set(['closed', 'cancel', '已关闭', '已取消']);
  for (const e of executions) {
    if (String(e.id) !== defaultId && !inactive.has(e.status)) ordered.push(e);
  }

  const candidates = ordered.slice(0, limit);
  return {
    candidates,
    totalCount: executions.length,
    truncated: ordered.length > candidates.length
  };
}

export {
  getExecutions,
  getExecutionsOrdered,
  syncExecutionsFromZentao,
  getDefaultExecution,
  setDefaultExecution,
  addExecution,
  deleteExecution,
  updateExecution,
  getExecutionById,
  getFavoriteExecutionIds,
  getFavoriteExecutions,
  setFavoriteExecutions,
  addFavoriteExecution,
  removeFavoriteExecution,
  getAiCandidateExecutions
};
