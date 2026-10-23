/**
 * 需求（story）接口
 *
 *   GET    /api/stories?keyword=   当前账号相关的需求（前端按产品 / 状态分组、搜索）；
 *                           加 cache=only 只读本地缓存（没有则 data:null）；响应带 syncedAt 与 diff（新增 / 变更 / 删除条数）
 *   GET    /api/stories/meta       新建/编辑所需下拉选项（产品、模块、评审人、分类、来源…）
 *   GET    /api/stories/:id        需求详情（描述 + 验收标准，已消毒 + 内联图代理；附件）
 *   POST   /api/stories            新建需求
 *   PUT    /api/stories/:id        编辑需求（含正文 spec/verify、备注；评审中会自动撤回评审）
 *   DELETE /api/stories/:id        删除需求（放回收站）
 *
 * 文件预览 / 下载复用：GET /api/zentao/files/:fileId/content
 */
import express from 'express';
import * as storyService from '../services/storyService.js';

const router = express.Router();

function fail(res, err) {
  if (err && err.code === 'ZENTAO_DISABLED') return res.status(409).json({ success: false, code: err.code, message: '请先在设置里登录禅道' });
  if (err && err.code === 'STORY_NOT_FOUND') return res.status(404).json({ success: false, code: err.code, message: err.message });
  return res.status(500).json({ success: false, message: (err && err.message) || '服务异常' });
}

router.get('/stories', async (req, res) => {
  try {
    // cache=only：只读本地缓存（页面先画缓存）；否则向禅道要最新并和缓存比对
    const r = await storyService.loadStories({ cacheOnly: req.query.cache === 'only' });
    const kw = String(req.query.keyword || '').trim().toLowerCase();
    const data = r.items && kw ? r.items.filter(s => s.title.toLowerCase().includes(kw) || s.id.includes(kw)) : r.items;
    const d = r.diff;
    res.json({
      success: true, data, syncedAt: r.syncedAt, fromCache: r.fromCache,
      diff: d ? { added: d.added.length, changed: d.changed.length, removed: d.removed.length } : undefined
    });
  } catch (err) {
    fail(res, err);
  }
});

router.get('/stories/meta', async (req, res) => {
  try {
    res.json({ success: true, data: await storyService.getStoryForm({ product: req.query.product }) });
  } catch (err) {
    fail(res, err);
  }
});

router.get('/stories/:id', async (req, res) => {
  try {
    res.json({ success: true, data: await storyService.getStory(req.params.id) });
  } catch (err) {
    fail(res, err);
  }
});

router.post('/stories', async (req, res) => {
  try {
    res.json({ success: true, data: await storyService.createStory(req.body || {}) });
  } catch (err) {
    fail(res, err);
  }
});

router.put('/stories/:id', async (req, res) => {
  try {
    res.json({ success: true, data: await storyService.editStory({ ...(req.body || {}), id: req.params.id }) });
  } catch (err) {
    fail(res, err);
  }
});

router.delete('/stories/:id', async (req, res) => {
  try {
    res.json({ success: true, data: await storyService.deleteStory(req.params.id) });
  } catch (err) {
    fail(res, err);
  }
});

export default router;
