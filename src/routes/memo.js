/**
 * 备忘录接口
 *
 *   GET    /api/memos?keyword=        备忘录列表（过滤已删除，置顶优先，支持关键字）
 *   GET    /api/memos/:id             单条详情
 *   POST   /api/memos                  新建 {title, content, tags}
 *   PUT    /api/memos/:id              编辑 {title, content, tags}
 *   DELETE /api/memos/:id              删除（软删 + 同步时调禅道删除）
 *   POST   /api/memos/:id/pin          置顶 / 取消（切换）
 *   POST   /api/memos/:id/sync         单条同步（上传这一条 / 同步它的删除）
 *
 *   GET    /api/memos/sync/state       同步配置与状态
 *   GET    /api/memos/sync/libs        可选文档库列表（弹窗用，复用 docService.listLibs）
 *   POST   /api/memos/sync/enable      启用同步 {libId}
 *   POST   /api/memos/sync/disable     停用同步
 *   POST   /api/memos/sync/pull        手动拉取同步（下行）
 *   POST   /api/memos/sync/push        手动上传同步（上行）
 */
import express from 'express';
import * as memoService from '../services/memoService.js';

const router = express.Router();

// 与文档附件同一个上限（POST /api/docs/:id/files）
const MAX_MEMO_FILE_BYTES = 50 * 1024 * 1024;

function fail(res, err) {
  if (err && err.code === 'ZENTAO_DISABLED') {
    return res.status(409).json({ success: false, code: err.code, message: '请先在设置里登录禅道' });
  }
  if (err && err.code === 'MEMO_NOT_FOUND') {
    return res.status(404).json({ success: false, code: err.code, message: err.message });
  }
  if (err && err.code === 'MEMO_NO_LIB') {
    return res.status(409).json({ success: false, code: err.code, message: err.message });
  }
  return res.status(500).json({ success: false, message: (err && err.message) || '服务异常' });
}

// ==================== 同步相关（必须在 :id 之前注册）====================

router.get('/memos/sync/state', async (req, res) => {
  try {
    res.json({ success: true, data: await memoService.getSyncState() });
  } catch (err) { fail(res, err); }
});

router.get('/memos/sync/config', async (req, res) => {
  try {
    const state = await memoService.getSyncState();
    res.json({ success: true, data: { defaultLibId: state.defaultLibId || '', libName: state.libName || '' } });
  } catch (err) { fail(res, err); }
});

router.post('/memos/sync/config', async (req, res) => {
  try {
    const b = req.body || {};
    res.json({ success: true, data: await memoService.setSyncState({ defaultLibId: String(b.defaultLibId || '') }) });
  } catch (err) { fail(res, err); }
});

router.get('/memos/sync/libs', async (req, res) => {
  try {
    res.json({ success: true, data: await memoService.listMemoLibs() });
  } catch (err) { fail(res, err); }
});

router.post('/memos/sync/enable', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.libId) return res.status(400).json({ success: false, message: '缺少文档库 ID' });
    // 先尝试获取用户 ID（验证禅道已登录 + 口令可用）
    await memoService.getCurrentUserId();
    res.json({ success: true, data: await memoService.setSyncState({ enabled: true, libId: String(b.libId) }) });
  } catch (err) { fail(res, err); }
});

router.post('/memos/sync/disable', async (req, res) => {
  try {
    res.json({ success: true, data: await memoService.setSyncState({ enabled: false }) });
  } catch (err) { fail(res, err); }
});

router.post('/memos/sync/pull', async (req, res) => {
  try {
    res.json({ success: true, data: await memoService.syncDownload() });
  } catch (err) { fail(res, err); }
});

router.post('/memos/sync/push', async (req, res) => {
  try {
    res.json({ success: true, data: await memoService.syncUpload() });
  } catch (err) { fail(res, err); }
});

// ==================== CRUD ====================

router.get('/memos', async (req, res) => {
  try {
    const keyword = String(req.query.keyword || '');
    res.json({ success: true, data: await memoService.listMemos({ keyword }) });
  } catch (err) { fail(res, err); }
});

router.get('/memos/:id', async (req, res) => {
  try {
    res.json({ success: true, data: await memoService.getMemo(req.params.id) });
  } catch (err) { fail(res, err); }
});

router.post('/memos', async (req, res) => {
  try {
    const b = req.body || {};
    res.json({ success: true, data: await memoService.createMemo({ title: b.title, content: b.content, tags: b.tags, syncLibId: b.syncLibId }) });
  } catch (err) { fail(res, err); }
});

/** 单条同步（卡片上的「同步」按钮） */
router.post('/memos/:id/sync', async (req, res) => {
  try {
    res.json({ success: true, data: await memoService.syncOne(req.params.id) });
  } catch (err) { fail(res, err); }
});

router.put('/memos/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};
    if (b.title != null) patch.title = b.title;
    if (b.content != null) patch.content = b.content;
    if (b.tags != null) patch.tags = b.tags;
    if (b.syncLibId != null) patch.syncLibId = b.syncLibId;
    res.json({ success: true, data: await memoService.updateMemo(req.params.id, patch) });
  } catch (err) { fail(res, err); }
});

router.post('/memos/:id/sync-lib', async (req, res) => {
  try {
    const b = req.body || {};
    res.json({ success: true, data: await memoService.setSyncLib(req.params.id, String(b.libId || '')) });
  } catch (err) { fail(res, err); }
});

/** 给便签追加一个附件（请求体是文件二进制，一次一个；文件传到便签对应的禅道文档） */
router.post('/memos/:id/attachments', express.raw({ type: () => true, limit: MAX_MEMO_FILE_BYTES + 1024 }), async (req, res) => {
  try {
    const name = String(req.query.name || '').trim();
    if (!name) return res.status(400).json({ success: false, message: '缺少文件名' });
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!buffer.length) return res.status(400).json({ success: false, message: '文件是空的' });
    res.json({ success: true, data: await memoService.addMemoAttachment({
      id: req.params.id,
      file: { name, mime: String(req.query.mime || ''), buffer }
    }) });
  } catch (err) {
    if (err && err.type === 'entity.too.large') return res.status(413).json({ success: false, message: '文件超过 50MB' });
    fail(res, err);
  }
});

router.delete('/memos/:id', async (req, res) => {
  try {
    res.json({ success: true, data: await memoService.deleteMemo(req.params.id) });
  } catch (err) { fail(res, err); }
});

router.post('/memos/:id/pin', async (req, res) => {
  try {
    res.json({ success: true, data: await memoService.togglePin(req.params.id) });
  } catch (err) { fail(res, err); }
});

export default router;
