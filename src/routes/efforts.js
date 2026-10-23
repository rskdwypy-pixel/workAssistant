/**
 * 工时（工作日历）接口。工时以禅道为准，后端只做缓存。
 *
 *   GET  /api/efforts?month=YYYY-MM   我这个月每天的工时与明细；cache=only 只读缓存（没有则 days:null）
 *   GET  /api/efforts/team?month=     全员这个月的工时（按人、按天）；cache=only 只读缓存。第一次比较慢
 *   GET  /api/efforts/tasks           填报下拉：指派给我、未完成的任务
 *   POST /api/efforts                 记工时 body:{taskId,date,consumed,left,work,finish?}（date 可为过去的日期）
 *   PUT  /api/efforts/:id             改工时 body:{taskId,date,consumed,left,work,finish?}（只能改自己的）
 *   DELETE /api/efforts/:id?taskId=   删工时（只能删自己的）
 * 剩余填 0 会让禅道把任务标成已完成：不带 finish:true 时返回 400 + code=CONFIRM_FINISH，界面确认后再带 finish 重发。
 */
import express from 'express';
import * as effortService from '../services/effortService.js';

const router = express.Router();

function fail(res, err) {
  if (err && err.code === 'ZENTAO_DISABLED') return res.status(409).json({ success: false, code: err.code, message: '请先在设置里登录禅道' });
  const validation = (err && err.code === 'CONFIRM_FINISH') || /^(请|不能|消耗|剩余|日期|月份|只能|这条|非法)/.test((err && err.message) || '');
  return res.status(validation ? 400 : 500).json({ success: false, code: err && err.code, message: (err && err.message) || '服务异常' });
}

router.get('/efforts', async (req, res) => {
  try {
    const month = String(req.query.month || '').trim() || new Date().toISOString().slice(0, 7);
    const r = await effortService.getMonthEfforts(month, { cacheOnly: req.query.cache === 'only' });
    res.json({ success: true, data: { month: r.month, standard: r.standard, me: r.me, days: r.days }, syncedAt: r.syncedAt, fromCache: r.fromCache, reread: r.reread });
  } catch (err) {
    fail(res, err);
  }
});

router.get('/efforts/team', async (req, res) => {
  try {
    const month = String(req.query.month || '').trim() || new Date().toISOString().slice(0, 7);
    const r = await effortService.getTeamMonthEfforts(month, { cacheOnly: req.query.cache === 'only' });
    res.json({ success: true, data: { month: r.month, standard: r.standard, members: r.members, days: r.days }, syncedAt: r.syncedAt, fromCache: r.fromCache, reread: r.reread });
  } catch (err) {
    fail(res, err);
  }
});

router.get('/efforts/tasks', async (req, res) => {
  try {
    res.json({ success: true, data: await effortService.listFillableTasks() });
  } catch (err) {
    fail(res, err);
  }
});

router.post('/efforts', async (req, res) => {
  try {
    const r = await effortService.addEffort(req.body || {});
    if (!r || !r.success) return res.status(502).json({ success: false, message: (r && r.message) || '禅道没有接受这条工时' });
    res.json({ success: true, data: r });
  } catch (err) {
    fail(res, err);
  }
});

router.put('/efforts/:id', async (req, res) => {
  try {
    res.json({ success: true, data: await effortService.editEffort({ ...(req.body || {}), effortId: req.params.id }) });
  } catch (err) {
    fail(res, err);
  }
});

router.delete('/efforts/:id', async (req, res) => {
  try {
    res.json({ success: true, data: await effortService.deleteEffort({ taskId: req.query.taskId, effortId: req.params.id }) });
  } catch (err) {
    fail(res, err);
  }
});

export default router;
