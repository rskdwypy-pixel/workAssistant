import { v4 as uuidv4 } from 'uuid';
import { readTasks, updateTasks } from '../utils/storage.js';
import { removeRecordFiles } from './attachmentStore.js';

/**
 * 创建 Bug（仅本地）
 */
async function createBug(bugData) {
  const now = new Date().toISOString();
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
    comments: bugData.comments || [],  // 多条备注
    history: bugData.history || [],
    assignedDate: bugData.assignedDate || '',
    zentaoId: bugData.zentaoId || null,
    createdAt: now,
    updatedAt: now,
    progress: 0,
    consumedTime: 0
  };

  await updateTasks((data) => {
    data.tasks.unshift(newBug);
    return data;
  });

  console.log('[BugManager] Bug 已创建:', newBug.id, newBug.zentaoId || '(未同步禅道)');
  return newBug;
}

/**
 * 迁移Bug数据，添加缺失的字段
 */
async function migrateBugData() {
  let migratedCount = 0;
  let total = 0;

  await updateTasks((data) => {
    const bugs = data.tasks.filter(t => t.type === 'bug');
    total = bugs.length;

    bugs.forEach(bug => {
      let needUpdate = false;

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
      if (bug.comments === undefined) {
        // 旧的 comment 字段转换为 comments 数组
        if (bug.comment !== undefined && bug.comment !== '') {
          bug.comments = [{
            content: bug.comment,
            timestamp: bug.createdAt || bug.updatedAt || new Date().toISOString()
          }];
          delete bug.comment;
        } else {
          bug.comments = [];
        }
        needUpdate = true;
      }
      if (bug.projectName === undefined) {
        bug.projectName = '';
        needUpdate = true;
      }

      if (needUpdate) migratedCount++;
    });
    return data;
  });

  console.log('[BugManager] Bug 数据迁移完成:', migratedCount, '/', total);
  return { migratedCount, total };
}

/**
 * 获取所有 Bug
 */
async function getBugs(filters = {}) {
  const data = await readTasks();
  let bugs = (data.tasks || []).filter(t => t.type === 'bug');

  // 按状态筛选
  if (filters.status) {
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
 * @param {string} bugId - Bug ID
 * @param {string} newStatus - 新状态
 * @param {Object} extraData - 额外数据 { assignedTo, cc, comment, author }
 */
async function updateBugStatus(bugId, newStatus, extraData = {}) {
  let bug = null;
  await updateTasks((data) => {
    bug = data.tasks.find(t => t.id === bugId && t.type === 'bug');
    if (!bug) {
      throw new Error(`Bug ${bugId} 不存在`);
    }

    // 只改给出的字段：以前不传状态也会把状态改成 undefined
    if (newStatus !== undefined && newStatus !== null && newStatus !== '') bug.status = newStatus;
    bug.updatedAt = new Date().toISOString();
    if (extraData.title !== undefined && String(extraData.title).trim()) {
      bug.title = String(extraData.title).trim();
      bug.content = bug.title;
    }
    if (extraData.priority !== undefined) bug.priority = Number(extraData.priority) || bug.priority;
    if (extraData.severity !== undefined) bug.severity = Number(extraData.severity) || bug.severity;

    if (extraData.assignedTo !== undefined) {
      bug.assignedTo = extraData.assignedTo;
      bug.assignedToList = extraData.assignedToList || [];
    }
    if (extraData.cc !== undefined) {
      bug.cc = extraData.cc;
    }

    // 追加备注（而不是覆盖）
    if (extraData.comment !== undefined && extraData.comment !== '') {
      if (!bug.comments) bug.comments = [];
      bug.comments.push({
        content: extraData.comment,
        timestamp: new Date().toISOString(),
        author: extraData.author || '系统'
      });
    }
    return data;
  });
  return bug;
}

/**
 * 删除 Bug
 */
async function deleteBug(bugId) {
  await updateTasks((data) => {
    const index = data.tasks.findIndex(t => t.id === bugId && t.type === 'bug');
    if (index === -1) {
      throw new Error(`Bug ${bugId} 不存在`);
    }
    data.tasks.splice(index, 1);
    return data;
  });
  await removeRecordFiles(bugId);
  return true;
}

/**
 * 删除所有 Bug
 */
async function deleteAllBugs() {
  let deletedCount = 0;
  let remainingCount = 0;
  let removedIds = [];
  await updateTasks((data) => {
    removedIds = data.tasks.filter(t => t.type === 'bug').map(t => t.id);
    deletedCount = removedIds.length;
    data.tasks = data.tasks.filter(t => t.type !== 'bug');
    remainingCount = data.tasks.length;
    return data;
  });
  for (const id of removedIds) await removeRecordFiles(id);
  return { deletedCount, remainingCount };
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
 * 创建 Bug（本地），前端已在禅道创建成功时带上 zentaoId
 */
async function createBugWithSync(bugData) {
  const localBug = await createBug(bugData);
  const syncResult = bugData.zentaoId
    ? { success: true, bugId: bugData.zentaoId, fromBrowser: true }
    : { success: false, message: 'Bug 仅在本地创建，未同步到禅道' };
  return { localBug, syncResult };
}

/** 禅道同步会覆盖的 Bug 字段（只有这些字段真的变了才更新 updatedAt） */
const ZENTAO_BUG_FIELDS = [
  'title', 'status', 'severity', 'priority', 'bugType', 'productName',
  'openedBy', 'resolvedBy', 'resolution', 'confirmed', 'assignedTo',
  'executionId', 'executionName', 'projectId', 'projectName'
];

/**
 * 批量导入禅道Bug（按禅道 ID 去重，只处理 type === 'bug' 的记录）
 * @param {Array} zentaoBugs - 已映射为本地字段的禅道 Bug 列表
 * @returns {Promise<Object>} { added, updated, unchanged, skipped }
 */
async function importZentaoBugs(zentaoBugs) {
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;

  await updateTasks((data) => {
    const existingBugsMap = new Map();
    data.tasks.forEach(t => {
      if (t.type === 'bug' && t.zentaoId) {
        // Bug 的 zentaoId 统一为数字（与前端约定一致）
        t.zentaoId = Number(t.zentaoId);
        existingBugsMap.set(t.zentaoId, t);
      }
    });

    const now = new Date().toISOString();
    for (const zentaoBug of zentaoBugs) {
      try {
        const zentaoId = Number(zentaoBug.zentaoId);
        if (!zentaoId) {
          skipped++;
          continue;
        }
        const existingBug = existingBugsMap.get(zentaoId);

        if (existingBug) {
          const incoming = {};
          ZENTAO_BUG_FIELDS.forEach(f => {
            const v = zentaoBug[f];
            incoming[f] = (v === undefined || v === null || v === '') ? existingBug[f] : v;
          });
          const changed = ZENTAO_BUG_FIELDS.some(f => String(existingBug[f] ?? '') !== String(incoming[f] ?? ''));
          if (changed) {
            Object.assign(existingBug, incoming, { content: incoming.title, updatedAt: now });
            updated++;
          } else {
            unchanged++;
          }
        } else {
          const newBug = {
            id: uuidv4(),
            type: 'bug',
            title: zentaoBug.title,
            content: zentaoBug.title,
            status: zentaoBug.status,
            severity: zentaoBug.severity,
            priority: zentaoBug.priority,
            bugType: zentaoBug.bugType,
            productId: zentaoBug.productId || '',
            productName: zentaoBug.productName || '',
            openedBy: zentaoBug.openedBy || '',
            resolvedBy: zentaoBug.resolvedBy || '',
            resolution: zentaoBug.resolution || '',
            confirmed: zentaoBug.confirmed,
            steps: zentaoBug.steps || '',
            history: [],
            assignedTo: zentaoBug.assignedTo || '',
            assignedDate: zentaoBug.assignedDate || '',
            cc: [],
            assignedToList: [],
            comments: [],
            // 执行和项目信息（删除 Bug 时用于判断 kanbanId）
            executionId: zentaoBug.executionId || null,
            executionName: zentaoBug.executionName || '',
            projectId: zentaoBug.projectId || null,
            projectName: zentaoBug.projectName || '',
            zentaoId,
            createdAt: now,
            updatedAt: now,
            progress: 0,
            consumedTime: 0
          };
          data.tasks.unshift(newBug);
          existingBugsMap.set(zentaoId, newBug);
          added++;
        }
      } catch (err) {
        console.error('[BugManager] 导入Bug失败:', zentaoBug && zentaoBug.zentaoId, err.message);
        skipped++;
      }
    }
    return data;
  });

  console.log(`[BugManager] 禅道Bug导入完成: 新增 ${added} 更新 ${updated} 无变化 ${unchanged} 跳过 ${skipped}`);
  return { added, updated, unchanged, skipped };
}

export {
  createBugWithSync,
  getBugs,
  updateBugStatus,
  deleteBug,
  deleteAllBugs,
  getBugStats,
  migrateBugData,
  importZentaoBugs
};
