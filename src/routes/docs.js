/**
 * 文档中心接口
 *
 *   GET    /api/docs/libs                 文档库列表（各空间的库）
 *   GET    /api/docs/list?keyword=        当前账号可见的全部文档（前端按库分组 / 搜索）
 *   GET    /api/docs/:id                  文档详情（正文已消毒 + 内联图代理；附件列表）
 *   POST   /api/docs                      新建正文文档 body:{lib,module,title,body,contentType,keywords,acl}
 *   PUT    /api/docs/:id                  编辑文档 body:{title,body,keywords,acl}
 *   DELETE /api/docs/:id                  删除文档（放回收站）
 *   POST   /api/docs/:id/collect          收藏 / 取消收藏（切换）
 *
 * 文件预览 / 下载复用：GET /api/zentao/files/:fileId/content?ext=&download=1&name=
 */
import express from 'express';
import * as docService from '../services/docService.js';

const router = express.Router();

function fail(res, err) {
  if (err && err.code === 'ZENTAO_DISABLED') {
    return res.status(409).json({ success: false, code: err.code, message: '请先在设置里登录禅道' });
  }
  if (err && err.code === 'DOC_NOT_FOUND') {
    return res.status(404).json({ success: false, code: err.code, message: err.message });
  }
  return res.status(500).json({ success: false, message: (err && err.message) || '服务异常' });
}

router.get('/docs/libs', async (req, res) => {
  try {
    res.json({ success: true, data: await docService.listLibs() });
  } catch (err) {
    fail(res, err);
  }
});

router.get('/docs/list', async (req, res) => {
  try {
    const items = await docService.listDocs({ keyword: req.query.keyword || '' });
    res.json({ success: true, data: items });
  } catch (err) {
    fail(res, err);
  }
});

router.get('/docs/:id', async (req, res) => {
  try {
    res.json({ success: true, data: await docService.getDoc(req.params.id) });
  } catch (err) {
    fail(res, err);
  }
});

router.post('/docs', async (req, res) => {
  try {
    const b = req.body || {};
    const r = await docService.createDoc({
      lib: b.lib, module: b.module, title: b.title, body: b.body,
      contentType: b.contentType, keywords: b.keywords, acl: b.acl
    });
    res.json({ success: true, data: r });
  } catch (err) {
    fail(res, err);
  }
});

router.put('/docs/:id', async (req, res) => {
  try {
    const b = req.body || {};
    const r = await docService.editDoc({ id: req.params.id, title: b.title, body: b.body, keywords: b.keywords, acl: b.acl });
    res.json({ success: true, data: r });
  } catch (err) {
    fail(res, err);
  }
});

router.delete('/docs/:id', async (req, res) => {
  try {
    res.json({ success: true, data: await docService.deleteDoc(req.params.id) });
  } catch (err) {
    fail(res, err);
  }
});

router.post('/docs/:id/collect', async (req, res) => {
  try {
    res.json({ success: true, data: await docService.collectDoc(req.params.id) });
  } catch (err) {
    fail(res, err);
  }
});

export default router;
