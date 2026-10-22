/**
 * 附件：本地记录与待上传区
 *
 * 以禅道为准，本地不长期保存文件：
 *   - 任务 / Bug 记录上只记附件元数据（record.attachments）
 *   - 文件本体在上传到禅道之前，暂存在 data/attachments/<记录ID>/<附件ID>
 *   - 上传成功即删除本地暂存文件，只留禅道文件 ID
 *
 * 附件状态：
 *   pending   待上传（记录还没同步到禅道，或等待后台推送）
 *   held      暂扣（随「解决 Bug」等动作一起提交，不走后台推送）
 *   uploading 上传中
 *   uploaded  已上传到禅道
 *   failed    上传失败（自动重试 MAX_ATTEMPTS 次后需手动重试）
 */
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { join, extname, basename } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { readTasks, updateTasks } from '../utils/storage.js';

/** 与禅道一致：单个文件不超过 50MB */
const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** 每条任务 / Bug 最多附件数与总大小 */
const MAX_FILES_PER_RECORD = 10;
const MAX_BYTES_PER_RECORD = 100 * 1024 * 1024;
/** 待上传区总容量上限，防止长期离线把磁盘写满 */
const MAX_PENDING_STORE_BYTES = 1024 * 1024 * 1024;
/** 待上传超过这个天数，在界面上提醒用户处理 */
const STALE_DAYS = 7;
/** 后台自动重试次数上限，超过后只能手动重试 */
const MAX_ATTEMPTS = 5;

/**
 * 允许的类型：图片、视频、PDF、Office 文档、压缩包、日志与文本
 * SVG 可内嵌脚本，不允许；可执行文件、脚本一律拦截
 */
const ALLOWED_EXTENSIONS = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'],
  video: ['mp4', 'mov', 'webm', 'avi', 'mkv', 'm4v'],
  document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'wps', 'et', 'dps', 'key', 'numbers', 'pages'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz'],
  text: ['txt', 'log', 'md', 'json', 'xml', 'yaml', 'yml', 'har']
};
const EXT_KIND = Object.fromEntries(
  Object.entries(ALLOWED_EXTENSIONS).flatMap(([kind, list]) => list.map(ext => [ext, kind]))
);

const ACTIVE_STATUSES = new Set(['pending', 'held', 'uploading', 'uploaded', 'failed']);

function attachmentsRoot() {
  return join(config.paths.data, 'attachments');
}

function recordDir(recordId) {
  // 记录 ID 由本服务生成（uuid），仍做一次白名单校验，杜绝路径穿越
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(recordId))) throw new Error('非法的记录 ID');
  return join(attachmentsRoot(), String(recordId));
}

function filePath(recordId, attachmentId) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(attachmentId))) throw new Error('非法的附件 ID');
  return join(recordDir(recordId), String(attachmentId));
}

/**
 * 文件名清理：去掉路径、控制字符和文件系统保留字符，限制长度
 */
function sanitizeFileName(name) {
  let n = basename(String(name || '').replace(/\\/g, '/'));
  n = n.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').replace(/^\.+/, '').trim();
  if (!n) n = '附件';
  if (n.length > 120) {
    const ext = extname(n);
    n = n.slice(0, 120 - ext.length) + ext;
  }
  return n;
}

function extOf(name) {
  return extname(String(name)).replace(/^\./, '').toLowerCase();
}

function kindOf(name) {
  return EXT_KIND[extOf(name)] || null;
}

/**
 * 校验单个文件能否加入某条记录（类型、单文件大小、数量、总大小）
 * @returns {string|null} 不通过的原因
 */
function validateAddition(record, { name, size }) {
  const ext = extOf(name);
  if (!ext || !EXT_KIND[ext]) {
    return `不支持的文件类型${ext ? `「.${ext}」` : ''}：支持图片、视频、PDF、Office 文档、压缩包、日志和文本`;
  }
  if (!(size > 0)) return '文件为空';
  if (size > MAX_FILE_BYTES) {
    // 向上取一位小数：50MB 多一点的文件不能显示成「当前 50.0MB」
    return `单个文件不能超过 50MB（当前 ${(Math.ceil(size / 1024 / 1024 * 10) / 10).toFixed(1)}MB）`;
  }
  const current = (record.attachments || []).filter(a => ACTIVE_STATUSES.has(a.status));
  if (current.length >= MAX_FILES_PER_RECORD) return `每条最多 ${MAX_FILES_PER_RECORD} 个附件`;
  const total = current.reduce((s, a) => s + (Number(a.size) || 0), 0);
  if (total + size > MAX_BYTES_PER_RECORD) return '附件总大小不能超过 100MB';
  return null;
}

async function pendingStoreBytes() {
  const root = attachmentsRoot();
  if (!existsSync(root)) return 0;
  let total = 0;
  for (const dir of await fs.readdir(root)) {
    const p = join(root, dir);
    const st = await fs.stat(p).catch(() => null);
    if (!st || !st.isDirectory()) continue;
    for (const f of await fs.readdir(p)) {
      const fst = await fs.stat(join(p, f)).catch(() => null);
      if (fst) total += fst.size;
    }
  }
  return total;
}

/**
 * 给记录加一个附件：文件先写入待上传区，再登记元数据
 *
 * @param {string} recordId - 本地任务 / Bug ID
 * @param {{name:string, mime?:string, buffer:Buffer, inline?:boolean, hold?:boolean}} file
 *   inline：图片同时插入禅道正文（描述 / 重现步骤）
 *   hold：暂扣，随动作（如解决 Bug）一起提交，不走后台推送
 * @returns {Promise<Object>} 附件元数据
 */
async function addAttachment(recordId, file) {
  const name = sanitizeFileName(file.name);
  const size = file.buffer ? file.buffer.length : 0;

  const { tasks } = await readTasks();
  const record = (tasks || []).find(t => t.id === recordId);
  if (!record) throw Object.assign(new Error('任务或 Bug 不存在'), { status: 404 });
  const reason = validateAddition(record, { name, size });
  if (reason) throw Object.assign(new Error(reason), { status: 400 });
  if (await pendingStoreBytes() + size > MAX_PENDING_STORE_BYTES) {
    throw Object.assign(new Error('待上传的附件太多（超过 1GB），请先处理未上传的附件'), { status: 400 });
  }

  const meta = {
    id: uuidv4(),
    name,
    size,
    mime: String(file.mime || '').slice(0, 100) || 'application/octet-stream',
    ext: extOf(name),
    kind: kindOf(name),
    inline: !!file.inline && kindOf(name) === 'image',
    status: file.hold ? 'held' : 'pending',
    attempts: 0,
    error: '',
    zentaoFileId: null,
    createdAt: new Date().toISOString()
  };

  // 目录仅本人可访问（里面是真实文件：截图、日志等）
  await fs.mkdir(attachmentsRoot(), { recursive: true, mode: 0o700 });
  await fs.mkdir(recordDir(recordId), { recursive: true, mode: 0o700 });
  await fs.writeFile(filePath(recordId, meta.id), file.buffer, { mode: 0o600 });

  try {
    await updateTasks((data) => {
      const r = data.tasks.find(t => t.id === recordId);
      if (!r) throw Object.assign(new Error('任务或 Bug 不存在'), { status: 404 });
      // 锁内再校验一次：并发上传时以落库时刻为准
      const again = validateAddition(r, { name, size });
      if (again) throw Object.assign(new Error(again), { status: 400 });
      r.attachments = [...(r.attachments || []), meta];
      return data;
    });
  } catch (err) {
    await fs.rm(filePath(recordId, meta.id), { force: true });
    throw err;
  }
  return meta;
}

async function getRecord(recordId) {
  const { tasks } = await readTasks();
  return (tasks || []).find(t => t.id === recordId) || null;
}

async function readAttachmentContent(recordId, attachmentId) {
  return fs.readFile(filePath(recordId, attachmentId));
}

/**
 * 批量更新附件元数据
 * @param {string} recordId
 * @param {(meta:Object)=>Object|null} patcher - 返回要合并的字段；返回 null 表示不改
 */
async function patchAttachments(recordId, patcher) {
  let record = null;
  await updateTasks((data) => {
    const r = data.tasks.find(t => t.id === recordId);
    if (!r || !Array.isArray(r.attachments)) return data;
    r.attachments = r.attachments.map(a => {
      const patch = patcher(a);
      return patch ? { ...a, ...patch } : a;
    });
    record = r;
    return data;
  });
  return record;
}

/** 上传成功：记下禅道文件 ID，删除本地暂存文件 */
async function markUploaded(recordId, results) {
  const byId = new Map(results.map(r => [r.id, r]));
  await patchAttachments(recordId, (a) => {
    const r = byId.get(a.id);
    if (!r) return null;
    return { status: 'uploaded', zentaoFileId: r.zentaoFileId || null, inlineUrl: r.inlineUrl || null, error: '', uploadedAt: new Date().toISOString() };
  });
  for (const r of results) {
    await fs.rm(filePath(recordId, r.id), { force: true });
  }
  await removeEmptyDir(recordId);
}

async function markStatus(recordId, ids, status, error = '') {
  const set = new Set(ids);
  await patchAttachments(recordId, (a) => {
    if (!set.has(a.id)) return null;
    const patch = { status, error };
    if (status === 'failed') {
      patch.attempts = (a.attempts || 0) + 1;
      patch.lastAttemptAt = new Date().toISOString();
    }
    return patch;
  });
}

async function removeEmptyDir(recordId) {
  const dir = recordDir(recordId);
  if (!existsSync(dir)) return;
  const left = await fs.readdir(dir).catch(() => []);
  if (left.length === 0) await fs.rm(dir, { recursive: true, force: true });
}

/** 删除一个附件的本地记录与暂存文件（禅道侧由调用方处理） */
async function removeAttachment(recordId, attachmentId) {
  let removed = null;
  await updateTasks((data) => {
    const r = data.tasks.find(t => t.id === recordId);
    if (!r || !Array.isArray(r.attachments)) return data;
    removed = r.attachments.find(a => a.id === attachmentId) || null;
    r.attachments = r.attachments.filter(a => a.id !== attachmentId);
    return data;
  });
  await fs.rm(filePath(recordId, attachmentId), { force: true });
  await removeEmptyDir(recordId);
  return removed;
}

/** 记录被删除时清掉它的待上传文件 */
async function removeRecordFiles(recordId) {
  try {
    await fs.rm(recordDir(recordId), { recursive: true, force: true });
  } catch (err) {
    console.warn('[Attachments] 清理待上传文件失败:', recordId, err.message);
  }
}

/** 附件元数据加上派生字段（是否待上传过久、是否还能自动重试） */
function describeAttachment(a) {
  const ageDays = (Date.now() - new Date(a.createdAt).getTime()) / 86400000;
  return {
    ...a,
    stale: ['pending', 'failed'].includes(a.status) && ageDays > STALE_DAYS,
    autoRetry: a.status === 'failed' ? (a.attempts || 0) < MAX_ATTEMPTS : undefined
  };
}

/** 需要后台推送的附件：pending / uploading（上次中断）/ 未超重试次数的 failed */
function needsPush(a, { force = false } = {}) {
  if (a.status === 'pending' || a.status === 'uploading') return true;
  if (a.status === 'failed') return force || (a.attempts || 0) < MAX_ATTEMPTS;
  return false;
}

export {
  MAX_FILE_BYTES,
  MAX_FILES_PER_RECORD,
  MAX_BYTES_PER_RECORD,
  MAX_ATTEMPTS,
  STALE_DAYS,
  ALLOWED_EXTENSIONS,
  sanitizeFileName,
  extOf,
  kindOf,
  validateAddition,
  addAttachment,
  getRecord,
  readAttachmentContent,
  markUploaded,
  markStatus,
  removeAttachment,
  removeRecordFiles,
  describeAttachment,
  needsPush
};
