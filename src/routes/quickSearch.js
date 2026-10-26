/**
 * 全局搜索
 *
 *   GET /api/quick-search?q=关键词&scope=local|remote
 *     local（默认）：本地任务 / Bug + 需求 / 文档缓存，即时返回
 *     remote：禅道服务端搜索任务 / Bug（慢一点，界面在 local 结果出来后再补）
 */
import express from 'express';
import { quickSearch } from '../services/quickSearch.js';

const router = express.Router();

router.get('/quick-search', async (req, res) => {
  try {
    const scope = req.query.scope === 'remote' ? 'remote' : 'local';
    res.json({ success: true, data: await quickSearch(req.query.q, { scope }) });
  } catch (err) {
    res.status(500).json({ success: false, message: (err && err.message) || '搜索失败' });
  }
});

export default router;
