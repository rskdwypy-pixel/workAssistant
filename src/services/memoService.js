/**
 * 备忘录服务：CRUD + 加密同步
 *
 * 本地存储：data/memo.json（原子写 + 备份，沿用 storage.js）
 * 加密同步：每条备忘录 = 禅道文档库中的一个文档，标题明文、正文加密
 *   口令 = 禅道用户 ID（my-profile.json → user.id）
 *   正文 = MEMO_V1:base64(AES-256-GCM(JSON))
 *
 * 同步策略：
 *   - 上行：编辑后 syncDirty=true → syncUpload() 加密上传 → 成功清除 dirty
 *   - 下行：syncDownload() 列出文档库 → 逐条解密 → 条目级合并 → 写回本地
 *   - 删除：以禅道为准（插件删除 = 调禅道删除 + 本地移除；禅道手动删 = 同步时本地移除）
 */
import { readJSON, writeJSON } from '../utils/storage.js';
import { config } from '../config.js';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { getZentaoJson, isConfigured } from './zentaoService.js';
import * as docService from './docService.js';
import { encryptMemo, decryptMemo, isMemoEncrypted } from '../utils/memoCrypto.js';

// ==================== 本地存储 ====================

const MEMO_FILE = () => join(config.paths.data, 'memo.json');

async function readMemoData() {
  const data = await readJSON(MEMO_FILE());
  return data || { version: '1.0', lastUpdated: null, memos: [], syncState: { enabled: false } };
}

async function writeMemoData(data) {
  data.version = data.version || '1.0';
  data.lastUpdated = new Date().toISOString();
  return await writeJSON(MEMO_FILE(), data);
}

let _memoWriteLock = Promise.resolve();
async function updateMemos(mutator) {
  const run = _memoWriteLock.then(async () => {
    const data = await readMemoData();
    const next = await mutator(data);
    await writeMemoData(next || data);
    return next || data;
  });
  _memoWriteLock = run.then(() => undefined, () => undefined);
  return run;
}

// ==================== 用户 ID ====================

let _userId = null;
let _userIdKey = '';

/** 获取当前登录用户的禅道 ID（口令），配置变化时自动重新获取 */
async function getCurrentUserId() {
  const key = `${config.zentao.url || ''}|${config.zentao.username || ''}`;
  if (_userId != null && _userIdKey === key) return _userId;
  if (!isConfigured()) {
    const err = new Error('禅道未配置');
    err.code = 'ZENTAO_DISABLED';
    throw err;
  }
  const data = await getZentaoJson('my-profile.json');
  const u = data && data.user;
  if (!u || !u.id) throw new Error('禅道没有返回用户 ID');
  _userId = Number(u.id);
  _userIdKey = key;
  return _userId;
}

/** 清除用户 ID 缓存（切换账号 / 配置变化时调用） */
function invalidateUserId() {
  _userId = null;
  _userIdKey = '';
}

// ==================== CRUD ====================

/** 列表：过滤已删除，按置顶 + updatedAt 排序，支持关键字搜索 */
async function listMemos({ keyword = '' } = {}) {
  const data = await readMemoData();
  let items = (data.memos || []).filter(m => !m.deleted);
  items.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  });
  const kw = String(keyword || '').trim().toLowerCase();
  if (kw) {
    items = items.filter(m =>
      String(m.title || '').toLowerCase().includes(kw) ||
      String(m.content || '').toLowerCase().includes(kw) ||
      (m.tags || []).some(t => String(t).toLowerCase().includes(kw))
    );
  }
  return items;
}

/** 单条详情 */
async function getMemo(id) {
  const data = await readMemoData();
  const memo = (data.memos || []).find(m => m.id === id);
  if (!memo || memo.deleted) {
    const err = new Error('备忘录不存在');
    err.code = 'MEMO_NOT_FOUND';
    throw err;
  }
  return memo;
}

/** 新建 */
async function createMemo(input = {}) {
  const { title, content = '', tags = [], syncLibId = '' } = input;
  if (!title || !String(title).trim()) throw new Error('标题不能为空');
  const now = new Date().toISOString();
  const memo = {
    id: randomUUID(),
    docId: '',
    title: String(title).trim(),
    content: String(content || ''),
    tags: Array.isArray(tags) ? tags.map(String).filter(Boolean) : [],
    pinned: false,
    refs: [],
    createdAt: now,
    updatedAt: now,
    syncDirty: false,
    deleted: false,
    syncLibId: String(syncLibId || '')
  };
  await updateMemos(data => {
    const memos = [...(data.memos || []), memo];
    return { ...data, memos };
  });
  // 创建后标记 dirty（同步时检查 syncLibId，不依赖全局 syncState.enabled）
  await updateMemos(d => {
    const memos = (d.memos || []).map(m => m.id === memo.id ? { ...m, syncDirty: true } : m);
    return { ...d, memos };
  });
  memo.syncDirty = true;
  return memo;
}

/** 编辑 */
async function updateMemo(id, patch = {}) {
  let result = null;
  await updateMemos(data => {
    const memos = (data.memos || []).map(m => {
      if (m.id !== id) return m;
      const next = { ...m, ...patch, updatedAt: new Date().toISOString() };
      // 如果 patch 里显式设置了 syncDirty，用 patch 的值；否则默认标记 dirty
      if (!('syncDirty' in patch)) next.syncDirty = true;
      result = next;
      return next;
    });
    return { ...data, memos };
  });
  if (!result) {
    const err = new Error('备忘录不存在');
    err.code = 'MEMO_NOT_FOUND';
    throw err;
  }
  return result;
}

/** 删除（软删 + 同步时调禅道删除） */
async function deleteMemo(id) {
  let result = null;
  await updateMemos(data => {
    const memos = (data.memos || []).map(m => {
      if (m.id !== id) return m;
      const syncEnabled = data.syncState && data.syncState.enabled;
      if (syncEnabled && m.docId) {
        // 启用同步且有文档 → 标记删除 + dirty，等 syncUpload 调禅道删除
        result = { ...m, deleted: true, syncDirty: true };
      } else {
        // 未启用同步或无文档 → 直接软删
        result = { ...m, deleted: true };
      }
      return result;
    });
    return { ...data, memos };
  });
  if (!result) {
    const err = new Error('备忘录不存在');
    err.code = 'MEMO_NOT_FOUND';
    throw err;
  }
  return result;
}

/** 置顶 / 取消（切换） */
async function togglePin(id) {
  const memo = await getMemo(id);
  return await updateMemo(id, { pinned: !memo.pinned });
}

// ==================== 加密同步 ====================

/**
 * 上行：遍历 syncDirty 的备忘录 → 加密 → 逐条创建/更新禅道文档
 * @returns {{uploaded:number, deleted:number, failed:number, errors:Array}}
 */
async function syncUpload() {
  const data = await readMemoData();
  const dirty = (data.memos || []).filter(m => m.syncDirty);
  if (dirty.length === 0) return { uploaded: 0, deleted: 0, failed: 0, errors: [] };
  // 检查是否有 dirty 的便签设置了 syncLibId
  const hasSyncLib = dirty.some(m => m.syncLibId);
  if (!hasSyncLib) return { skipped: true, reason: '没有设置同步文档库' };

  let userId;
  try {
    userId = await getCurrentUserId();
  } catch (err) {
    return { skipped: true, reason: err.message };
  }

  const libId = data.syncState.libId;
  const errors = [];
  let uploaded = 0, deletedCount = 0;

  for (const memo of dirty) {
    try {
      // 每条备忘录可以用自己的 syncLibId，没设就用全局的
      const targetLib = memo.syncLibId || libId;
      if (!targetLib) {
        errors.push({ id: memo.id, title: memo.title, error: '没有设置同步文档库' });
        continue;
      }
      if (memo.deleted) {
        // 删除同步：调禅道删除文档
        if (memo.docId) {
          await docService.deleteDoc(memo.docId);
          deletedCount++;
        }
      } else {
        // 内容同步：加密 → 上传
        const body = encryptMemo({
          content: memo.content,
          tags: memo.tags,
          pinned: memo.pinned,
          refs: memo.refs,
          createdAt: memo.createdAt,
          updatedAt: memo.updatedAt
        }, userId);

        if (memo.docId) {
          await docService.editDoc({ id: memo.docId, title: memo.title, body });
        } else {
          const r = await docService.createDoc({ lib: targetLib, module: '0', title: memo.title, body, contentType: 'markdown' });
          if (!r.id) throw new Error('禅道没有返回文档 ID');
          memo.docId = r.id;
        }
        uploaded++;
      }
    } catch (err) {
      errors.push({ id: memo.id, title: memo.title, error: err.message });
    }
  }

  // 清除成功的 dirty 标记 + 写回 docId，更新同步状态
  const errorIds = new Set(errors.map(e => e.id));
  await updateMemos(d => {
    const memos = (d.memos || []).map(m => {
      if (errorIds.has(m.id)) return m; // 失败的保留 dirty
      const next = m.syncDirty ? { ...m, syncDirty: false } : m;
      // 上传成功且分配了新 docId → 写回本地
      const src = dirty.find(dm => dm.id === m.id);
      if (src && src.docId && !m.docId) next.docId = src.docId;
      return next;
    });
    return {
      ...d, memos,
      syncState: { ...d.syncState, lastSyncAt: new Date().toISOString(), lastSyncResult: errors.length > 0 ? 'partial' : 'ok' }
    };
  });

  return { uploaded, deleted: deletedCount, failed: errors.length, errors };
}

/**
 * 下行：列出文档库全部文档 → 逐条解密 → 条目级合并 → 写回本地
 * @returns {{synced:number}}
 */
async function syncDownload() {
  const data = await readMemoData();
  const hasSyncLib = (data.memos || []).some(m => m.syncLibId);
  if (!hasSyncLib) return { skipped: true, reason: '没有设置同步文档库' };

  let userId;
  try {
    userId = await getCurrentUserId();
  } catch (err) {
    return { skipped: true, reason: err.message };
  }

  // 列出所有文档（跨所有库），按 docId 匹配（每条备忘录可以同步到不同库）
  const docs = await docService.listDocs({});

  // 逐条拉取正文并解密
  const remoteMemos = [];
  for (const doc of docs) {
    try {
      const detail = await docService.getDoc(doc.id);
      if (!detail.raw || !isMemoEncrypted(detail.raw)) continue; // 非备忘录文档跳过
      const memo = decryptMemo(detail.raw, userId);
      remoteMemos.push({
        id: String(doc.id),
        docId: String(doc.id),
        title: detail.title,
        content: memo.content || '',
        tags: memo.tags || [],
        pinned: !!memo.pinned,
        refs: memo.refs || [],
        createdAt: memo.createdAt || doc.addedDate || '',
        updatedAt: memo.updatedAt || doc.editedDate || '',
        syncDirty: false,
        deleted: false,
        syncLibId: String(doc.lib)
      });
    } catch {
      // 解密失败（口令不对 / 格式不对）→ 跳过，不影响其他备忘录
    }
  }

  // 条目级合并
  const remoteMap = new Map(remoteMemos.map(m => [m.docId, m]));

  await updateMemos(d => {
    const localMemos = d.memos || [];
    const merged = [];

    // 1. 无 docId 的本地备忘录（新建未上传）→ 保留
    for (const m of localMemos) {
      if (!m.docId && !m.deleted) merged.push(m);
    }

    // 2. 有 docId 的本地未删除备忘录
    for (const m of localMemos) {
      if (!m.docId || m.deleted) continue;
      const rm = remoteMap.get(m.docId);
      if (rm) {
        // 两端都有 → 取 updatedAt 较新者
        if (String(rm.updatedAt || '') > String(m.updatedAt || '')) {
          merged.push(rm);
        } else {
          merged.push(m);
        }
      } else if (!m.syncDirty) {
        // 远端没有且不是 dirty → 以禅道为准删除（不加入 merged）
      } else {
        // dirty 但远端没有 → 上传失败过，保留等下次重试
        merged.push(m);
      }
    }

    // 3. 已删除的本地备忘录
    for (const m of localMemos) {
      if (m.deleted && m.syncDirty && m.docId) {
        // 删除还没成功上传 → 保留等下次 syncUpload
        merged.push(m);
      }
      // 其他已删除的 → 不加入 merged（已从本地移除）
    }

    // 4. 远端有但本地未删除的没有 → 加入
    for (const rm of remoteMemos) {
      if (!localMemos.some(m => m.docId === rm.docId && !m.deleted)) {
        merged.push(rm);
      }
    }

    return {
      ...d, memos: merged,
      syncState: { ...d.syncState, lastSyncAt: new Date().toISOString(), lastSyncResult: 'ok' }
    };
  });

  return { synced: remoteMemos.length };
}

// ==================== 同步配置 ====================

async function getSyncState() {
  const data = await readMemoData();
  return data.syncState || { enabled: false };
}

async function setSyncState(state) {
  return await updateMemos(d => {
    const prevEnabled = d.syncState && d.syncState.enabled;
    const nextSyncState = { ...(d.syncState || { enabled: false }), ...state };
    const memos = d.memos || [];
    // 启用同步时，把所有 docId 为空且未删除的备忘录标记为 dirty（之前未启用同步时创建的）
    if (nextSyncState.enabled && !prevEnabled) {
      const memos2 = memos.map(m => {
        if (!m.deleted && !m.docId) return { ...m, syncDirty: true };
        return m;
      });
      return { ...d, memos: memos2, syncState: nextSyncState };
    }
    return { ...d, syncState: nextSyncState };
  });
}

/** 可选文档库列表（复用 docService.listLibs） */
async function listMemoLibs() {
  return await docService.listLibs();
}

/**
 * 设置单条便签的同步文档库
 * 如果文档库改变：删除原文档，在新文档库创建新文档
 */
async function setSyncLib(id, libId) {
  const memo = await getMemo(id);
  const oldLibId = memo.syncLibId || '';
  const newLibId = String(libId || '');
  if (oldLibId === newLibId) return updateMemo(id, { syncLibId: newLibId });
  // 删除原文档
  if (memo.docId && oldLibId) {
    try { await docService.deleteDoc(memo.docId); } catch {}
  }
  // 在新文档库创建新文档
  const userId = await getCurrentUserId();
  const body = encryptMemo({
    content: memo.content, tags: memo.tags, pinned: memo.pinned, refs: memo.refs,
    createdAt: memo.createdAt, updatedAt: memo.updatedAt
  }, userId);
  const r = await docService.createDoc({ lib: newLibId, module: '0', title: memo.title, body, contentType: 'markdown' });
  if (!r.id) throw new Error('禅道没有返回文档 ID');
  return updateMemo(id, { syncLibId: newLibId, docId: r.id, syncDirty: false });
}

export {
  listMemos, getMemo, createMemo, updateMemo, deleteMemo, togglePin,
  syncUpload, syncDownload,
  getSyncState, setSyncState, listMemoLibs, setSyncLib,
  getCurrentUserId, invalidateUserId
};
