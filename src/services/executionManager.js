import { join, dirname } from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { config } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXECUTIONS_FILE = join(__dirname, '../../data/executions.json');

/**
 * 确保执行文件存在
 */
function ensureExecutionsFile() {
  if (!existsSync(EXECUTIONS_FILE)) {
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
    writeFileSync(EXECUTIONS_FILE, JSON.stringify(defaultData, null, 2), 'utf-8');
    return defaultData;
  }

  const data = JSON.parse(readFileSync(EXECUTIONS_FILE, 'utf-8'));

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
    writeFileSync(EXECUTIONS_FILE, JSON.stringify(data, null, 2), 'utf-8');
  }

  return data;
}

/**
 * 写入执行文件
 */
function writeExecutionsFile(data) {
  writeFileSync(EXECUTIONS_FILE, JSON.stringify(data, null, 2), 'utf-8');
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
 * 从禅道同步执行列表
 * @param {Array} executionsFromFrontend - 从前端获取的执行列表（可选）
 */
async function syncExecutionsFromZentao(executionsFromFrontend = null) {
  // 如果从前端传入了执行数据，需要处理并添加类型字段
  if (executionsFromFrontend && Array.isArray(executionsFromFrontend)) {
    const data = ensureExecutionsFile();
    const existingFavorites = new Set(data.favoriteExecutionIds || []);

    // 为前端传入的执行数据补充类型字段
    console.log('[ExecutionManager] 前端传入的执行数量:', executionsFromFrontend.length);
    console.log('[ExecutionManager] 前3个执行的type:', executionsFromFrontend.slice(0, 3).map(e => ({ id: e.id, name: e.name, type: e.type })));

    const processedExecutions = executionsFromFrontend.map(ex => {
      // 如果已有type字段，保留；否则根据名称判断
      if (ex.type) {
        return {
          ...ex,
          kanbanId: ex.type === 'kanban' ? (ex.kanbanId || ex.id) : null
        };
      }

      // 根据名称判断执行类型
      const name = (ex.name || '').toLowerCase();
      let executionType = 'execution';

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
    });

    console.log('[ExecutionManager] 处理后前3个执行的type:', processedExecutions.slice(0, 3).map(e => ({ id: e.id, name: e.name, type: e.type })));

    data.executions = processedExecutions;
    data.favoriteExecutionIds = Array.from(existingFavorites);
    data.lastSync = new Date().toISOString();
    writeExecutionsFile(data);

    // 统计执行类型分布
    const typeStats = processedExecutions.reduce((acc, ex) => {
      acc[ex.type] = (acc[ex.type] || 0) + 1;
      return acc;
    }, {});
    console.log('[ExecutionManager] 同步成功，获取到', processedExecutions.length, '个执行，类型分布:', typeStats);
    return processedExecutions;
  }

  // 否则尝试从服务端同步（使用 zentaoService 获取准确的 type 字段）
  if (!config.zentao.enabled) {
    throw new Error('禅道未启用');
  }

  if (!config.zentao.url) {
    throw new Error('禅道 URL 未配置');
  }

  try {
    // 使用 zentaoService 的 getExecutions 方法，它从 HTML 页面解析准确的 type 字段
    const { getExecutions } = await import('./zentaoService.js');
    const executions = await getExecutions();

    if (!executions || executions.length === 0) {
      throw new Error('未获取到执行列表');
    }

    console.log('[ExecutionManager] 从 zentaoService 获取到', executions.length, '个执行');
    console.log('[ExecutionManager] 执行类型分布:', executions.reduce((acc, ex) => {
      acc[ex.type] = (acc[ex.type] || 0) + 1;
      return acc;
    }, {}));

    // 保存到本地，保留收藏的执行ID
    const data = ensureExecutionsFile();
    const existingFavorites = new Set(data.favoriteExecutionIds || []);
    data.executions = executions;
    data.favoriteExecutionIds = Array.from(existingFavorites);
    data.lastSync = new Date().toISOString();
    writeExecutionsFile(data);

    console.log('[ExecutionManager] 同步成功，获取到', executions.length, '个执行，保留收藏', existingFavorites.size, '个');

    return executions;
  } catch (err) {
    console.error('[ExecutionManager] 同步执行列表失败:', err.message);

    // 返回现有的执行列表
    const data = ensureExecutionsFile();
    return data.executions || [];
  }
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
  removeFavoriteExecution
};
