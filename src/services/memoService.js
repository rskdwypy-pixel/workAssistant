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
  // 只有能解析出同步目标库时才标记待同步；纯本地便签不标，避免永远挂着「待同步」角标
  const data = await updateMemos(d => {
    const target = resolveLib(memo, d.syncState || {});
    memo.syncDirty = !!target;
    const memos = [...(d.memos || []), memo];
    return { ...d, memos };
  });
  memo.syncDirty = !!(data && resolveLib(memo, data.syncState || {}));
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
      // 有 docId = 禅道上确实有这份文档，删除要同步过去（不依赖全局 enabled，否则会留下孤儿文档）
      if (m.docId) {
        result = { ...m, deleted: true, syncDirty: true };
      } else {
        // 从未同步过 → 直接软删
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
 * 解析一条便签的目标文档库：便签自己的 syncLibId > 全局默认库 defaultLibId > 旧版 enable 写入的 libId
 */
function resolveLib(memo, syncState = {}) {
  return String((memo && memo.syncLibId) || syncState.defaultLibId || syncState.libId || '');
}


/**
 * 上传单条便签到禅道（新建 / 更新 / 删除文档）
 * @returns {{ok:boolean, docId?:string, deleted?:boolean, error?:string}}
 */
async function uploadOne(memo, userId, syncState = {}) {
  const targetLib = resolveLib(memo, syncState);
  if (!targetLib) return { ok: false, error: '没有设置同步文档库' };

  if (memo.deleted) {
    if (memo.docId) {
      await docService.deleteDoc(memo.docId);
      return { ok: true, deleted: true };
    }
    return { ok: true }; // 没有远端文档，视为删除成功
  }

  const body = encryptMemo({
    content: memo.content,
    tags: memo.tags,
    pinned: memo.pinned,
    refs: memo.refs,
    // 附件记录（id/name/size）：文件本体挂在禅道文档的附件区（明文），
    // 这里只存索引，让多端知道这条便签有哪些附件、可下载。
    attachments: (memo.attachments || []).map(a => ({ id: String(a.id), name: String(a.name || ''), size: Number(a.size) || 0 })),
    createdAt: memo.createdAt,
    updatedAt: memo.updatedAt
  }, userId);

  if (memo.docId) {
    await docService.editDoc({ id: memo.docId, title: memo.title, body });
    return { ok: true, docId: memo.docId };
  }
  const r = await docService.createDoc({ lib: targetLib, module: '0', title: memo.title, body, contentType: 'markdown' });
  if (!r.id) throw new Error('禅道没有返回文档 ID');
  return { ok: true, docId: r.id };
}

/**
 * 上行：遍历 syncDirty 的备忘录 → 加密 → 逐条创建/更新禅道文档
 * @returns {{uploaded:number, deleted:number, failed:number, errors:Array}}
 */
async function syncUpload() {
  const data = await readMemoData();
  const dirty = (data.memos || []).filter(m => m.syncDirty);
  if (dirty.length === 0) return { uploaded: 0, deleted: 0, failed: 0, errors: [] };
  // 目标库解析链：便签自己的 syncLibId > defaultLibId > 旧版 libId；一个都解析不出才跳过
  if (!dirty.some(m => resolveLib(m, data.syncState || {}))) {
    return { skipped: true, reason: '没有设置同步文档库' };
  }

  let userId;
  try {
    userId = await getCurrentUserId();
  } catch (err) {
    return { skipped: true, reason: err.message };
  }

  const errors = [];
  const docIds = new Map(); // id → 新分配的 docId
  let uploaded = 0, deletedCount = 0;

  for (const memo of dirty) {
    try {
      const r = await uploadOne(memo, userId, data.syncState || {});
      if (r.ok) {
        if (r.deleted) deletedCount++;
        else uploaded++;
        if (r.docId) docIds.set(memo.id, r.docId);
      } else {
        errors.push({ id: memo.id, title: memo.title, error: r.error });
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
      if (docIds.has(m.id) && !m.docId) next.docId = docIds.get(m.id);
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
 * 单条同步：只处理指定的一条便签（卡片上的「同步」按钮）
 * @returns {{uploaded:number, deleted:number, failed:number, errors:Array}}
 */
async function syncOne(id) {
  const data = await readMemoData();
  const memo = (data.memos || []).find(m => m.id === id && !m.deleted);
  if (!memo) {
    const err = new Error('备忘录不存在');
    err.code = 'MEMO_NOT_FOUND';
    throw err;
  }
  if (!resolveLib(memo, data.syncState || {})) {
    return { skipped: true, reason: '没有设置同步文档库' };
  }

  let userId;
  try {
    userId = await getCurrentUserId();
  } catch (err) {
    return { skipped: true, reason: err.message };
  }

  const errors = [];
  let uploaded = 0, deletedCount = 0, newDocId = null;
  try {
    const r = await uploadOne(memo, userId, data.syncState || {});
    if (r.ok) {
      if (r.deleted) deletedCount++;
      else uploaded++;
      newDocId = r.docId || null;
    } else {
      errors.push({ id: memo.id, title: memo.title, error: r.error });
    }
  } catch (err) {
    errors.push({ id: memo.id, title: memo.title, error: err.message });
  }

  const errorIds = new Set(errors.map(e => e.id));
  await updateMemos(d => {
    const memos = (d.memos || []).map(m => {
      if (m.id !== id || errorIds.has(m.id)) return m;
      const next = { ...m, syncDirty: false };
      if (newDocId && !m.docId) next.docId = newDocId;
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
 * 下行合并（纯函数，便于单测）：
 *
 * 本地便签与远端按 docId 对齐，「文档还在不在禅道」以全量文档列表 allDocIds 为准——
 * 以前只拿「解密成功的结果」当存在性判据，正文被人在禅道里改坏（前缀没了）会被误判成
 * 「禅道已删除」而把本地数据清掉。现在分三态：
 *   - 文档真不在了（列表里没有）→ 以禅道为准，非 dirty 的本地删除（回收站可恢复）
 *   - 文档在、但正文不是便签密文（brokenIds）→ 本地保留并标 dirty，下轮上行把密文写回去
 *   - 文档在、是密文但解密失败（别人的便签 / 被篡改）→ 本地原样保留，不动
 *
 * @param {Array} localMemos 本地全部便签（含 deleted / dirty）
 * @param {Array} remoteMemos 远端解密成功的便签（docId 已填）
 * @param {Set<string>} allDocIds 禅道全量文档列表里的 docId 集合
 * @param {Set<string>} brokenIds 拉过详情、确认正文已不是便签密文的 docId 集合
 * @returns {{merged:Array, removed:number, repaired:number}}
 */
function mergeRemoteMemos(localMemos, remoteMemos, allDocIds, brokenIds) {
  const remoteMap = new Map(remoteMemos.map(m => [m.docId, m]));
  const merged = [];
  let removed = 0, repaired = 0;

  // 1. 本地无 docId（新建未上传）→ 保留
  for (const m of localMemos) {
    if (!m.docId && !m.deleted) merged.push(m);
  }

  // 2. 本地有 docId 且未删
  for (const m of localMemos) {
    if (!m.docId || m.deleted) continue;
    const rm = remoteMap.get(m.docId);
    if (rm) {
      // 两端都有 → 取 updatedAt 较新者
      merged.push(String(rm.updatedAt || '') > String(m.updatedAt || '') ? rm : m);
    } else if (allDocIds.has(String(m.docId))) {
      // 文档还在禅道，只是没解出便签（正文被改坏 / 解密失败）→ 不删
      if (brokenIds.has(String(m.docId)) && !m.syncDirty) {
        // 正文被换成普通内容 → 标 dirty，下轮上行把密文恢复回去
        merged.push({ ...m, syncDirty: true });
        repaired++;
      } else {
        merged.push(m);
      }
    } else if (m.syncDirty) {
      // 文档不在了但本地还有未上传的修改（含换库重建的中间态）→ 保留等上传
      merged.push(m);
    } else {
      // 文档真被删了 → 以禅道为准，本地移除（禅道回收站里可恢复）
      removed++;
    }
  }

  // 3. 已删除的：删除还没同步成功的保留（等 syncUpload 调禅道删除），其余丢弃
  for (const m of localMemos) {
    if (m.deleted && m.syncDirty && m.docId) merged.push(m);
  }

  // 4. 远端有、本地没有 → 加入；但跳过「换库重建」留下的旧副本
  //    （setSyncLib 换库 = 删旧建新，删旧失败时旧文档还在：与本地新副本 title+updatedAt 完全相同）
  for (const rm of remoteMemos) {
    const dup = localMemos.some(m => !m.deleted && m.docId !== rm.docId
      && String(m.title) === String(rm.title) && String(m.updatedAt) === String(rm.updatedAt));
    if (dup) continue;
    if (!localMemos.some(m => m.docId === rm.docId && !m.deleted)) merged.push(rm);
  }

  return { merged, removed, repaired };
}

/**
 * 下行：列出文档库全部文档 → 逐条解密 → 条目级合并 → 写回本地
 * @returns {{synced:number}}
 */
async function syncDownload() {
  const data = await readMemoData();
  const syncState = data.syncState || {};
  // 未配置任何同步目标、也没有待上传内容 → 纯本地用户，不必每次都扫禅道
  const memoLibs = new Set(
    (data.memos || []).map(m => String(m.syncLibId || '')).filter(Boolean)
      .concat([String(syncState.defaultLibId || ''), String(syncState.libId || '')]).filter(Boolean)
  );
  const hasDirty = (data.memos || []).some(m => m.syncDirty);
  if (memoLibs.size === 0 && !hasDirty) {
    return { skipped: true, reason: '没有设置同步文档库' };
  }

  let userId;
  try {
    userId = await getCurrentUserId();
  } catch (err) {
    return { skipped: true, reason: err.message };
  }

  // 全量文档列表（跨所有库）——它同时回答两个问题：哪些文档值得拉详情、哪些文档确实还在
  const docs = await docService.listDocs({});
  const allDocIds = new Set(docs.map(d => String(d.id)));

  // 预筛后再拉正文：便签文档只可能在「配置过的库」或「本地已同步过的文档（含被移库）」里，
  // 再兜底同型的 markdown 文档（老便签未记 syncLibId 时靠它识别）；
  // 不加筛选的话禅道里每一篇文档都要 getDoc 一次，文档多时每轮同步要打几百个请求
  const localDocIds = new Set((data.memos || []).map(m => String(m.docId || '')).filter(Boolean));
  const candidates = docs.filter(d =>
    memoLibs.has(String(d.lib || '')) || localDocIds.has(String(d.id)) || String(d.type || '') === 'markdown'
  );

  // 逐条拉取正文并解密
  const remoteMemos = [];
  const brokenIds = new Set(); // 文档在、正文已不是便签密文（被人在禅道改成普通文档）
  for (const doc of candidates) {
    try {
      const detail = await docService.getDoc(doc.id);
      if (!detail.raw || !isMemoEncrypted(detail.raw)) {
        brokenIds.add(String(doc.id)); // 只有本地有同 docId 便签时这个标记才有意义
        continue;
      }
      const memo = decryptMemo(detail.raw, userId);
      // 附件索引：正文里记录的（多端同步的真源）∪ 文档上实际挂的文件（在禅道里手动加的也能看到）
      const byId = new Map();
      for (const f of (detail.files || [])) byId.set(String(f.id), { id: String(f.id), name: String(f.name || ''), size: Number(f.size) || 0 });
      for (const a of (memo.attachments || [])) byId.set(String(a.id), { id: String(a.id), name: String(a.name || ''), size: Number(a.size) || 0 });
      remoteMemos.push({
        id: String(doc.id),
        docId: String(doc.id),
        title: detail.title,
        content: memo.content || '',
        tags: memo.tags || [],
        pinned: !!memo.pinned,
        refs: memo.refs || [],
        attachments: [...byId.values()],
        createdAt: memo.createdAt || doc.addedDate || '',
        updatedAt: memo.updatedAt || doc.editedDate || '',
        syncDirty: false,
        deleted: false,
        syncLibId: String(doc.lib)
      });
    } catch {
      // 是密文但解密失败（别人的便签 / 被篡改）→ 跳过，合并时本地对应条目原样保留
    }
  }

  // 条目级合并
  const localSnapshot = data.memos || [];
  const { merged, removed, repaired } = mergeRemoteMemos(localSnapshot, remoteMemos, allDocIds, brokenIds);

  await updateMemos(d => {
    // d 里的 memos 可能在这期间被并发改过（编辑/新建），无 docId 的新条目以 d 为准补回来
    const fresh = (d.memos || []).filter(m => !m.docId && !m.deleted
      && !merged.some(x => x.id === m.id));
    return {
      ...d,
      memos: [...merged, ...fresh],
      syncState: { ...d.syncState, lastSyncAt: new Date().toISOString(), lastSyncResult: 'ok' }
    };
  });

  return { synced: remoteMemos.length, removed, repaired };
}

// ==================== 同步配置 ====================

async function getSyncState() {
  const data = await readMemoData();
  return data.syncState || { enabled: false };
}

async function setSyncState(state) {
  return await updateMemos(d => {
    const prev = d.syncState || {};
    const nextSyncState = { ...prev, ...state };
    const memos = d.memos || [];
    // 启用同步或（重新）指定了默认文档库时，把所有还没上传过的备忘录标记为 dirty，
    // 让之前纯本地的便签在下次上行时自动入库（换机恢复、后配默认库都靠这一步）
    const enabledTurnedOn = nextSyncState.enabled && !prev.enabled;
    const libChanged = 'defaultLibId' in state && String(state.defaultLibId || '') !== String(prev.defaultLibId || '');
    if (enabledTurnedOn || libChanged) {
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

/**
 * 给一条便签追加附件：文件本体传到便签对应的禅道文档（addDocFile，回读确认禅道收下了），
 * 附件索引（id/name/size）记进本地并随加密正文同步到多端。
 *   - 便签还没有禅道文档（未同步过）→ 先按当前目标库把正文建上去，再传文件
 *   - 文件传成功后立刻把带附件记录的新正文写回禅道；这步失败只标 dirty 让下轮上行补
 * @param {{id:string, file:{name:string, mime?:string, buffer:Buffer}}} opts
 * @returns {Promise<{id:string, file:{id:string,name:string,size:number}}>}
 */
async function addMemoAttachment({ id, file } = {}) {
  const memo = await getMemo(id);
  const data = await readMemoData();
  const syncState = data.syncState || {};

  let userId;
  try {
    userId = await getCurrentUserId();
  } catch (err) {
    err.message = `附件要存到禅道：${err.message}`;
    throw err;
  }

  // 还没有远端文档：先把正文建上去（需要能解析出目标库）
  let target = memo;
  if (!target.docId) {
    if (!resolveLib(target, syncState)) {
      const err = new Error('这条便签还没有同步目标，先在预览里选择同步文档库，再上传附件');
      err.code = 'MEMO_NO_LIB';
      throw err;
    }
    const r = await uploadOne(target, userId, syncState);
    if (!r.ok) throw new Error(r.error || '创建禅道文档失败');
    target = await updateMemo(id, { docId: r.docId, syncDirty: false });
  }

  // 文件本体 → 禅道文档附件区
  const r = await docService.addDocFile({ id: target.docId, file });

  // 索引进本地 + 新正文（含附件记录）写回禅道
  const attachments = [...(target.attachments || []), r.file];
  const updated = await updateMemo(id, { attachments, syncDirty: true });
  try {
    const up = await uploadOne(updated, userId, syncState);
    if (up.ok) await updateMemo(id, { syncDirty: false });
  } catch {
    // 正文回写失败：保留 dirty，下轮 syncUpload 自动补
  }
  return { id, file: r.file };
}

export {
  listMemos, getMemo, createMemo, updateMemo, deleteMemo, togglePin,
  syncUpload, syncDownload, syncOne, mergeRemoteMemos,
  getSyncState, setSyncState, listMemoLibs, setSyncLib, addMemoAttachment,
  getCurrentUserId, invalidateUserId
};
