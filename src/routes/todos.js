/**
 * 我的待办聚合接口
 *
 *   GET /api/todos   任务 / Bug / 需求 / 日报 的待处理项（分组 + 紧急度排序）
 */
import express from 'express';
import { getTodos } from '../services/todoService.js';

const router = express.Router();

router.get('/todos', async (req, res) => {
  try {
    res.json({ success: true, data: await getTodos() });
  } catch (err) {
    res.status(500).json({ success: false, message: (err && err.message) || '服务异常' });
  }
});

export default router;
