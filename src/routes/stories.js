/**
 * 需求（story）接口
 *
 *   GET  /api/stories?keyword=   当前账号相关的需求（前端按产品 / 状态分组、搜索）
 *   GET  /api/stories/:id        需求详情（描述 + 验收标准，已消毒 + 内联图代理；附件）
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
    res.json({ success: true, data: await storyService.listStories({ keyword: req.query.keyword || '' }) });
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

export default router;
