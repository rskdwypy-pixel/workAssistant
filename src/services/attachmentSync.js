/**
 * 附件推送到禅道
 *
 * 触发时机：
 *   - 上传附件时记录已有禅道 ID → 立即推送
 *   - 记录拿到禅道 ID（任务后台建到禅道、Bug 手动同步）→ 推送积压的附件
 *   - 后台定时重试（失败的附件按次数上限自动重试）
 *   - 用户点「重试」→ 强制推送
 *
 * 同一条记录的推送串行执行，避免两次编辑表单提交互相覆盖。
 */
import {
  getRecord,
  readAttachmentContent,
  markUploaded,
  markStatus,
  needsPush
} from './attachmentStore.js';
import { readTasks } from '../utils/storage.js';

const locks = new Map();

/** 同一记录串行执行 */
function withRecordLock(recordId, fn) {
  const prev = locks.get(recordId) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  locks.set(recordId, tail);
  tail.then(() => { if (locks.get(recordId) === tail) locks.delete(recordId); });
  return run;
}

/**
 * 把一条记录积压的附件推送到禅道
 * @param {string} recordId
 * @param {{force?: boolean}} [options] - force：失败超过自动重试次数的也重试（用户手动点重试）
 * @returns {Promise<{success:boolean, uploaded:number, failed:number, pending:number, message:string}>}
 */
function pushRecordAttachments(recordId, options = {}) {
  return withRecordLock(recordId, async () => {
    const record = await getRecord(recordId);
    if (!record) return { success: false, uploaded: 0, failed: 0, pending: 0, message: '任务或 Bug 不存在' };
    const todo = (record.attachments || []).filter(a => needsPush(a, options));
    if (todo.length === 0) return { success: true, uploaded: 0, failed: 0, pending: 0, message: '没有待上传的附件' };
    if (!record.zentaoId) {
      return { success: true, uploaded: 0, failed: 0, pending: todo.length, message: '尚未同步到禅道，附件将在同步后自动上传' };
    }

    const { config } = await import('../config.js');
    if (!config.zentao.enabled || !config.zentao.url) {
      return { success: false, uploaded: 0, failed: 0, pending: todo.length, message: '禅道未启用，附件暂存在本地' };
    }

    const files = [];
    const missing = [];
    for (const a of todo) {
      try {
        files.push({ id: a.id, name: a.name, mime: a.mime, inline: a.inline, buffer: await readAttachmentContent(recordId, a.id) });
      } catch {
        missing.push(a.id);
      }
    }
    if (missing.length) await markStatus(recordId, missing, 'failed', '本地暂存文件丢失，请删除后重新添加');
    if (files.length === 0) return { success: false, uploaded: 0, failed: missing.length, pending: 0, message: '本地暂存文件丢失' };

    await markStatus(recordId, files.map(f => f.id), 'uploading');
    const type = record.type === 'bug' ? 'bug' : 'task';
    const { attachFilesToObject } = await import('./zentaoService.js');
    const result = await attachFilesToObject(type, String(record.zentaoId), files);

    if (!result.success) {
      await markStatus(recordId, files.map(f => f.id), 'failed', result.message);
      console.warn(`[Attachments] ${type}#${record.zentaoId} 附件上传失败:`, result.message);
      return { success: false, uploaded: 0, failed: files.length + missing.length, pending: 0, message: result.message };
    }
    await markUploaded(recordId, result.files);
    return { success: missing.length === 0, uploaded: files.length, failed: missing.length, pending: 0, message: result.message };
  });
}

/**
 * 解决 Bug，并把暂扣（held）的附件随解决动作一起提交
 * 附件出现在禅道里该次「解决」的历史记录下，而不是单独一次编辑。
 *
 * @param {string} recordId - 本地 Bug ID
 * @param {Object} params - resolveBug 的参数（bugId 为禅道 ID）
 * @param {string[]} attachmentIds - 随动作提交的附件
 */
function resolveBugWithAttachments(recordId, params, attachmentIds = []) {
  return withRecordLock(recordId, async () => {
    const { resolveBug, listObjectFiles } = await import('./zentaoService.js');
    const record = await getRecord(recordId);
    const wanted = new Set(attachmentIds);
    const metas = (record && record.attachments || []).filter(a => wanted.has(a.id) && a.status !== 'uploaded');
    const files = [];
    for (const a of metas) {
      const buffer = await readAttachmentContent(recordId, a.id).catch(() => null);
      if (buffer) files.push({ id: a.id, name: a.name, mime: a.mime, buffer });
    }
    if (files.length === 0) return resolveBug(params);

    const before = new Set((await listObjectFiles('bug', String(params.bugId)).catch(() => [])).map(f => f.id));
    await markStatus(recordId, files.map(f => f.id), 'uploading');
    const result = await resolveBug({ ...params, files });
    if (!result.success) {
      // 解决没成功：附件放回暂扣状态，用户可以修改后重新提交
      await markStatus(recordId, files.map(f => f.id), 'held', result.message);
      return result;
    }
    const added = (await listObjectFiles('bug', String(params.bugId)).catch(() => [])).filter(f => !before.has(f.id));
    await markUploaded(recordId, files.map((f, i) => ({ id: f.id, zentaoFileId: added[i] ? added[i].id : null })));
    return { ...result, attachments: files.length };
  });
}

/** 记录刚拿到禅道 ID：后台推送积压的附件（不阻塞调用方） */
function schedulePush(recordId) {
  setImmediate(() => {
    pushRecordAttachments(recordId).catch(err => console.warn('[Attachments] 推送失败:', recordId, err.message));
  });
}

/** 定时任务：推送所有已同步到禅道、仍有待上传附件的记录 */
async function retryAllPending() {
  const { tasks } = await readTasks();
  const ids = (tasks || [])
    .filter(t => t.zentaoId && (t.attachments || []).some(a => needsPush(a)))
    .map(t => t.id);
  for (const id of ids) {
    await pushRecordAttachments(id).catch(err => console.warn('[Attachments] 定时重试失败:', id, err.message));
  }
  return ids.length;
}

let retryTimer = null;
/** 启动定时重试：启动 30 秒后一次，之后每 10 分钟一次 */
function startAttachmentRetry() {
  if (retryTimer) return;
  setTimeout(() => retryAllPending().catch(() => {}), 30 * 1000).unref();
  retryTimer = setInterval(() => retryAllPending().catch(() => {}), 10 * 60 * 1000);
  retryTimer.unref();
}

export { pushRecordAttachments, schedulePush, retryAllPending, startAttachmentRetry, withRecordLock, resolveBugWithAttachments };
