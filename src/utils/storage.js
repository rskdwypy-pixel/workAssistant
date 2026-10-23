import fs from 'fs/promises';
import { existsSync } from 'fs';
import { join, basename } from 'path';

const BACKUP_DIR = 'backups';
const MAX_BACKUPS = 10;

/**
 * 确保目录存在
 */
async function ensureDir(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (err) {
    // 忽略已存在的错误
    if (err.code !== 'EEXIST') throw err;
  }
}

/**
 * 创建备份
 *
 * 备份文件名带上源文件名前缀，并按源文件各自保留 MAX_BACKUPS 份。
 * 旧实现所有 JSON 共用一个 10 份的池子、文件名只有时间戳，
 * 每晚写 history.json 的备份会把 tasks.json 的备份挤掉，出事时无备份可恢复。
 */
async function createBackup(filePath) {
  try {
    const dir = join(filePath, '..', BACKUP_DIR);
    await ensureDir(dir);

    const prefix = basename(filePath, '.json');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = join(dir, `${prefix}__${timestamp}.json`);

    await fs.copyFile(filePath, backupPath);

    // 只清理同一源文件的旧备份
    const files = (await fs.readdir(dir)).filter(f => f.startsWith(`${prefix}__`));
    if (files.length > MAX_BACKUPS) {
      files.sort();
      const oldBackups = files.slice(0, files.length - MAX_BACKUPS);
      for (const old of oldBackups) {
        await fs.unlink(join(dir, old));
      }
    }
  } catch (err) {
    console.error('备份失败:', err.message);
  }
}

/**
 * 读取JSON文件
 */
async function readJSON(filePath) {
  try {
    if (!existsSync(filePath)) {
      return null;
    }
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    console.error(`读取文件失败 ${filePath}:`, err.message);
    return null;
  }
}

/**
 * 写入JSON文件（原子写入）
 */
async function writeJSON(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  try {
    // 如果文件存在，先备份
    if (existsSync(filePath)) {
      await createBackup(filePath);
    }

    // 先把内容完整落到临时文件
    const content = JSON.stringify(data, null, 2);
    await fs.writeFile(tmpPath, content, 'utf-8');

    // rename 本身在 POSIX 上就是原子的，会直接覆盖目标文件。
    // 旧实现先 unlink 再 rename，多一步删除动作，既非必要，
    // 也会在受限环境下被拦截（表现为「写入失败」但任务其实没丢数据）。
    await fs.rename(tmpPath, filePath);

    return true;
  } catch (err) {
    console.error(`写入文件失败 ${filePath}:`, err.message);
    // 兜底：rename 失败时退回直接覆盖写
    try {
      await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
      return true;
    } catch (err2) {
      console.error(`回退写入同样失败 ${filePath}:`, err2.message);
      return false;
    }
  }
}

/**
 * 任务数据写入互斥锁
 *
 * 背景：readTasks → 修改 → writeTasks 是「读-改-写」三步，
 * 两个并发请求会各自读到同一份旧数据，后写的覆盖先写的，导致任务凭空消失。
 * 这里用 Promise 链把所有任务写入串行化。
 *
 * @type {Promise<void>}
 */
let _tasksWriteLock = Promise.resolve();

/**
 * 以串行方式执行「读-改-写」事务，保证并发安全
 * @param {(data:Object)=>Promise<Object>|Object} mutator - 接收当前数据，返回要写入的数据
 * @returns {Promise<Object>} 写入后的数据
 */
async function updateTasks(mutator) {
  const run = _tasksWriteLock.then(async () => {
    const data = await readTasks();
    const next = await mutator(data);
    await writeTasks(next || data);
    return next || data;
  });
  // 无论成功失败都要释放锁，避免一次异常导致后续全部卡死
  _tasksWriteLock = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * 读取任务数据
 */
async function readTasks() {
  const { config } = await import('../config.js');
  const data = await readJSON(config.paths.tasks);
  return data || { version: '1.0', lastUpdated: null, tasks: [] };
}

/**
 * 写入任务数据
 *
 * 不要在锁外直接调用（读-改-写请用 updateTasks），否则会和并发写互相覆盖。
 */
async function writeTasks(data) {
  const { config } = await import('../config.js');
  data.version = data.version || '1.0';
  data.lastUpdated = new Date().toISOString();
  return await writeJSON(config.paths.tasks, data);
}

/**
 * 禅道记录的去重键：类型 + 禅道 ID
 *
 * 禅道里任务和 Bug 是两套独立编号，任务 #496 与 Bug #496 是两条不同的记录。
 * 只按 zentaoId 去重会把其中一条当成重复删掉（曾真实发生），所以必须带上类型。
 *
 * @param {Object} record
 * @returns {string|null} 没有 zentaoId 时返回 null
 */
function zentaoKeyOf(record) {
  if (!record || record.zentaoId === null || record.zentaoId === undefined || record.zentaoId === '') {
    return null;
  }
  const type = record.type === 'bug' ? 'bug' : 'task';
  return `${type}:${String(record.zentaoId)}`;
}

/**
 * 读取历史日报
 */
async function readHistory() {
  const { config } = await import('../config.js');
  const data = await readJSON(config.paths.history);
  return data || { version: '1.0', dailySummaries: [] };
}

/**
 * 写入历史日报
 */
async function writeHistory(data) {
  const { config } = await import('../config.js');
  return await writeJSON(config.paths.history, data);
}

/**
 * 按日期获取任务
 */
function getTasksByDate(tasks, dateStr) {
  const targetDateTime = new Date(dateStr).getTime();

  return tasks.filter(task => {
    const taskCreatedAtDateStr = new Date(task.createdAt).toISOString().split('T')[0];
    const taskUpdatedAtDateStr = new Date(task.updatedAt || task.createdAt).toISOString().split('T')[0];

    // 1. 在当前选中日期创建的所有任务，都显示
    if (taskCreatedAtDateStr === dateStr) return true;

    // 2. 如果任务是未完成状态（todo或in_progress），并且创建于选中日期之前，则一直顺延携带显示
    if (task.status !== 'done' && new Date(taskCreatedAtDateStr).getTime() <= targetDateTime) return true;

    // 3. 如果任务是已完成状态，但它的完成(更新)时间是在选中日期，也显示在这天
    if (task.status === 'done' && taskUpdatedAtDateStr === dateStr) return true;

    return false;
  });
}
/**
 * 按日期范围获取任务
 */
function getTasksByDateRange(tasks, startDate, endDate) {
  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();
  return tasks.filter(task => {
    const taskTime = new Date(task.createdAt).getTime();
    return taskTime >= start && taskTime <= end;
  });
}

export {
  readJSON,
  writeJSON,
  readTasks,
  writeTasks,
  updateTasks,
  zentaoKeyOf,
  readHistory,
  writeHistory,
  getTasksByDate,
  getTasksByDateRange
};
