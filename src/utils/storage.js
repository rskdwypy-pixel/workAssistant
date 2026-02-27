import fs from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

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
 */
async function createBackup(filePath) {
  try {
    const dir = join(filePath, '..', BACKUP_DIR);
    await ensureDir(dir);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = join(dir, `${timestamp}.json`);

    await fs.copyFile(filePath, backupPath);

    // 清理旧备份
    const files = await fs.readdir(dir);
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
  try {
    // 如果文件存在，先备份
    if (existsSync(filePath)) {
      await createBackup(filePath);
    }

    // 写入临时文件
    const tmpPath = `${filePath}.tmp`;
    const content = JSON.stringify(data, null, 2);
    await fs.writeFile(tmpPath, content, 'utf-8');

    // 原子重命名
    await fs.rename(tmpPath, filePath);

    return true;
  } catch (err) {
    console.error(`写入文件失败 ${filePath}:`, err.message);
    return false;
  }
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
 */
async function writeTasks(data) {
  const { config } = await import('../config.js');
  data.lastUpdated = new Date().toISOString();
  return await writeJSON(config.paths.tasks, data);
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
  readHistory,
  writeHistory,
  getTasksByDate,
  getTasksByDateRange
};
