/**
 * 工作负载
 *
 *   GET /api/workload?days=14   未来 days 天（默认 14）我名下未完成任务的剩余工时，按截止日累计，标出来不及的日子
 */
import express from 'express';
import { getWorkload } from '../services/workload.js';

const router = express.Router();

router.get('/workload', async (req, res) => {
  try {
    res.json({ success: true, data: await getWorkload({ days: req.query.days }) });
  } catch (err) {
    res.status(500).json({ success: false, message: (err && err.message) || '读取失败' });
  }
});

export default router;
