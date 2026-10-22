/**
 * 修改任务的所属执行
 *
 *   未同步到禅道        → 只改本地（之后同步时会建到新执行里）
 *   已同步，禅道允许移动 → 走禅道编辑表单改 execution（禅道只允许同一项目内的执行之间移动）
 *   已同步，禅道不允许   → 需要调用方确认后「重建」：在目标执行新建任务并复制标题、描述、
 *                          优先级、截止日期、预计工时、附件，旧任务在禅道里取消。
 *                          旧任务的工时记录与操作历史无法迁移。
 */
import { getRecord } from './attachmentStore.js';
import { withRecordLock } from './attachmentSync.js';
import { updateTasks } from '../utils/storage.js';

/** 从本地执行清单里找执行信息（名称、类型、项目） */
async function findExecution(executionId) {
  const { getExecutions } = await import('./executionManager.js');
  const list = await getExecutions();
  return list.find(e => String(e.id) === String(executionId)) || null;
}

async function applyLocalExecution(recordId, exec, extra = {}) {
  let updated = null;
  await updateTasks((data) => {
    const t = data.tasks.find(x => x.id === recordId);
    if (!t) return data;
    Object.assign(t, {
      executionId: String(exec.id),
      executionName: exec.name || '',
      zentaoExecution: String(exec.id),
      projectId: exec.projectId || t.projectId,
      projectName: exec.projectName || t.projectName,
      executionType: exec.type || t.executionType,
      updatedAt: new Date().toISOString()
    }, extra);
    updated = t;
    return data;
  });
  return updated;
}

/** 禅道日期为空时是 0000-00-00 */
const validDate = (d) => (d && !/^0000/.test(String(d)) ? String(d).slice(0, 10) : undefined);

/**
 * 在目标执行里重建任务
 * @returns {Promise<Object>} { success, newZentaoId, oldZentaoId, copiedFiles, warnings }
 */
async function rebuildTask(record, exec) {
  const z = await import('./zentaoService.js');
  const oldId = String(record.zentaoId);
  const old = await z.getTaskDetail(oldId);
  if (['done', 'closed', 'cancel'].includes(old.status)) {
    return { success: false, message: '禅道里该任务已完成或已关闭，不支持换执行' };
  }

  const warnings = [];
  const estimate = Number(old.left) > 0 ? Number(old.left) : (Number(old.estimate) || undefined);
  const created = await z.createTask({
    title: old.name,
    content: old.desc || old.name,
    executionId: String(exec.id),
    priority: Number(old.pri) || 3,
    estimate,
    estStarted: validDate(old.estStarted),
    dueDate: validDate(old.deadline),
    assignedTo: old.assignedTo || undefined,
    type: old.type || 'devel',
    kanban: exec.type === 'kanban' ? { laneType: 'task', columnType: 'wait' } : undefined
  });
  if (!created.success || !created.taskId) {
    return { success: false, message: `在「${exec.name}」新建任务失败：${created.message || '未返回任务 ID'}` };
  }
  const newId = String(created.taskId);

  // 进行中的任务：新任务也开始
  if (old.status === 'doing') {
    const started = await z.updateTaskStatus(newId, 'doing');
    if (!started.success) warnings.push(`新任务未能自动开始：${started.message}`);
  }

  // 复制附件（正文里的内嵌图片随描述一起带过去，仍指向原文件，旧任务取消后可正常显示）
  const oldFiles = Object.values(old.files || {}).filter(f => String(f.deleted) !== '1');
  const idMap = new Map();
  if (oldFiles.length) {
    const files = [];
    for (const f of oldFiles) {
      try {
        const resp = await z.fetchZentaoFile(f.id, f.extension, { download: true });
        if (!resp.ok || /text\/html/i.test(resp.headers.get('content-type') || '')) throw new Error(`HTTP ${resp.status}`);
        const buffer = Buffer.from(await resp.arrayBuffer());
        files.push({ id: String(f.id), name: f.extension ? `${f.title}.${f.extension}` : f.title, mime: resp.headers.get('content-type') || '', buffer });
      } catch (err) {
        warnings.push(`附件「${f.title}」复制失败：${err.message}`);
      }
    }
    if (files.length) {
      const r = await z.attachFilesToObject('task', newId, files);
      if (r.success) r.files.forEach(x => { if (x.zentaoFileId) idMap.set(x.id, x.zentaoFileId); });
      else warnings.push(`附件复制失败：${r.message}`);
    }
  }

  // 取消旧任务
  const cancelled = await z.updateTaskStatus(oldId, 'cancel', {
    comment: `已移到执行「${exec.name}」，新任务 #${newId}（禅道助手换执行重建）`
  });
  if (!cancelled.success) warnings.push(`旧任务 #${oldId} 未能取消，请在禅道里手动取消：${cancelled.message}`);

  // 本地记录指向新任务；已上传附件的禅道文件 ID 换成新任务里的副本
  let attachmentsMapped = 0;
  await applyLocalExecution(record.id, exec, { zentaoId: newId, previousZentaoIds: [...(record.previousZentaoIds || []), oldId] });
  await updateTasks((data) => {
    const t = data.tasks.find(x => x.id === record.id);
    if (t && Array.isArray(t.attachments)) {
      t.attachments = t.attachments.map(a => {
        if (a.status === 'uploaded' && a.zentaoFileId && idMap.has(String(a.zentaoFileId))) {
          attachmentsMapped++;
          return { ...a, zentaoFileId: idMap.get(String(a.zentaoFileId)) };
        }
        return a;
      });
    }
    return data;
  });

  console.log(`[TaskExecution] 任务 #${oldId} 已重建为 #${newId}（执行 ${exec.id}），附件 ${idMap.size} 个`, warnings);
  return {
    success: true,
    mode: 'rebuilt',
    oldZentaoId: oldId,
    newZentaoId: newId,
    copiedFiles: idMap.size,
    attachmentsMapped,
    warnings,
    message: `已在「${exec.name}」重建为任务 #${newId}${warnings.length ? `（${warnings.length} 项需要注意）` : ''}`
  };
}

/**
 * 修改任务的所属执行
 * @param {string} recordId - 本地任务 ID
 * @param {string} executionId - 目标执行
 * @param {{rebuild?: boolean}} [options] - rebuild：禅道不允许直接移动时，确认重建
 * @returns {Promise<Object>} 需要确认重建时返回 { success:false, needRebuild:true, ... }
 */
function changeTaskExecution(recordId, executionId, options = {}) {
  return withRecordLock(recordId, async () => {
    const record = await getRecord(recordId);
    if (!record || record.type === 'bug') return { success: false, message: '任务不存在' };
    const exec = await findExecution(executionId);
    if (!exec) return { success: false, message: '目标执行不存在，请先在设置里同步执行列表' };
    if (String(record.executionId) === String(exec.id) && !options.rebuild) {
      return { success: true, mode: 'unchanged', message: '所属执行未变化' };
    }

    if (!record.zentaoId) {
      const task = await applyLocalExecution(recordId, exec);
      return { success: true, mode: 'local', task, message: `已改为「${exec.name}」，同步到禅道时会建到该执行` };
    }

    const z = await import('./zentaoService.js');
    const allowed = await z.getTaskExecutionOptions(String(record.zentaoId));
    if (allowed.includes(String(exec.id)) && !options.rebuild) {
      const r = await z.editTask({ taskId: String(record.zentaoId), execution: String(exec.id) });
      if (!r.success) return { success: false, message: `禅道里移动失败：${r.message}` };
      const task = await applyLocalExecution(recordId, exec);
      return { success: true, mode: 'moved', task, message: `已移到「${exec.name}」` };
    }

    if (!options.rebuild) {
      return {
        success: false,
        needRebuild: true,
        executionName: exec.name,
        message: '禅道不支持把任务直接移到其他项目的执行，需要在新执行中重建'
      };
    }
    return rebuildTask(record, exec);
  });
}

export { changeTaskExecution };
