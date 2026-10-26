/**
 * 工时计时器
 *
 *   GET  /api/timer          { timer: {taskId, name, startedAt} | null, now }   now 是后端当前时间（毫秒），界面用它校准时钟
 *   POST /api/timer/start    { taskId, name? }   已有计时在走返回 409
 *   POST /api/timer/clear    结束 / 放弃计时
 */
import express from 'express';
import { getTimer, startTimer, clearTimer } from '../services/timer.js';

const router = express.Router();

router.get('/timer', (req, res) => {
  res.json({ success: true, data: { timer: getTimer(), now: Date.now() } });
});

router.post('/timer/start', (req, res) => {
  const b = req.body || {};
  const r = startTimer({ taskId: b.taskId, name: b.name });
  if (r.ok) return res.json({ success: true, data: { timer: r.timer, now: Date.now() } });
  res.status(r.code === 'RUNNING' ? 409 : 400).json({ success: false, code: r.code, message: r.message, data: { timer: r.timer || null, now: Date.now() } });
});

router.post('/timer/clear', (req, res) => {
  clearTimer();
  res.json({ success: true, data: { timer: null, now: Date.now() } });
});

export default router;
