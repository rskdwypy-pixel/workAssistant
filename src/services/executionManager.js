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
        id: configuredExecutionId,
        name: `执行 ${configuredExecutionId}`,
        isDefault: true
      }] : [],
      defaultExecutionId: configuredExecutionId || null,
      lastSync: null
    };
    writeFileSync(EXECUTIONS_FILE, JSON.stringify(defaultData, null, 2), 'utf-8');
    return defaultData;
  }

  const data = JSON.parse(readFileSync(EXECUTIONS_FILE, 'utf-8'));

  // 如果文件存在但没有执行，且配置中有执行ID，则自动添加
  if (data.executions.length === 0 && config.zentao.executionId) {
    data.executions.push({
      id: config.zentao.executionId,
      name: `执行 ${config.zentao.executionId}`,
      isDefault: true
    });
    data.defaultExecutionId = config.zentao.executionId;
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
 */
async function getExecutions() {
  const data = ensureExecutionsFile();
  return data.executions || [];
}

/**
 * 从禅道同步执行列表
 */
async function syncExecutionsFromZentao() {
  if (!config.zentao.enabled) {
    throw new Error('禅道未启用');
  }

  if (!config.zentao.url) {
    throw new Error('禅道 URL 未配置');
  }

  try {
    // 动态导入 zentaoService
    const { getZentaoCookies, cookiesToString } = await import('./zentaoService.js');

    // 获取 cookie
    const cookies = await getZentaoCookies();
    const cookieHeader = cookiesToString(cookies);

    // 调用禅道 API 获取执行列表
    const response = await fetch(`${config.zentao.url}/zentao/project-execution-all------1-50-1.json`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Cookie': cookieHeader,
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const result = await response.json();
    console.log('[ExecutionManager] 禅道响应:', result);

    // 解析执行列表
    let executions = [];
    if (result && result.executions) {
      // 禅道返回的格式可能是 { executions: [...] }
      executions = result.executions;
    } else if (Array.isArray(result)) {
      // 或者直接是数组
      executions = result;
    } else if (result.data && Array.isArray(result.data)) {
      executions = result.data;
    }

    // 转换为我们的格式
    const formattedExecutions = executions.map(ex => ({
      id: String(ex.id),
      name: ex.name || ex.title || `执行 ${ex.id}`,
      projectName: ex.projectName || ex.project || '',
      productName: ex.productName || ex.product || '',
      status: ex.status || 'open',
      isDefault: ex.id === parseInt(config.zentao.executionId)
    }));

    // 保存到本地
    const data = ensureExecutionsFile();
    data.executions = formattedExecutions;
    data.lastSync = new Date().toISOString();
    writeExecutionsFile(data);

    console.log('[ExecutionManager] 同步成功，获取到', formattedExecutions.length, '个执行');

    return formattedExecutions;
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
    return executions.find(e => e.id === data.defaultExecutionId);
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

export {
  getExecutions,
  syncExecutionsFromZentao,
  getDefaultExecution,
  setDefaultExecution,
  addExecution,
  deleteExecution,
  updateExecution,
  getExecutionById
};
