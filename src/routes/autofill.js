/**
 * 工时自动补填接口（调试模式下的「补」，设计见 docs/AUTOFILL-PRD.md）。
 * 所有写入都要先 plan（只生成方案）再 execute（用户确认后），没有一步直写。
 *
 *   POST /api/efforts/autofill/plan      {dates?:[…] | month?:'YYYY-MM', seed?}  生成方案（预览用，不写任何东西）
 *   POST /api/efforts/autofill/rewrite   {planId, date, entries:[{taskId,hours}], seed?}  重写这天的工作内容
 *   POST /api/efforts/autofill/execute   {planId, days:[{date, entries:[{taskId,hours,work}]}]}  开始后台写入 → {jobId}
 *   GET  /api/efforts/autofill/jobs/:id  进度
 *   POST /api/efforts/autofill/jobs/:id/stop  停止（已写入的保留，可撤销）
 *   POST /api/efforts/autofill/undo      {batchId}  撤销一批
 *   GET  /api/efforts/autofill/log       补填记录
 */
import express from 'express';
import * as autofill from '../services/autofillService.js';

const router = express.Router();

function fail(res, err) {
  if (err && err.code === 'ZENTAO_DISABLED') return res.status(409).json({ success: false, code: err.code, message: '请先在设置里登录禅道' });
  const validation = /^(请|一次最多|没有|方案已过期|找不到|任务 #|\d{4}-|这批)/.test((err && err.message) || '');
  return res.status(validation ? 400 : 500).json({ success: false, message: (err && err.message) || '服务异常' });
}

router.post('/efforts/autofill/plan', async (req, res) => {
  try { res.json({ success: true, data: await autofill.buildPlan(req.body || {}) }); } catch (err) { fail(res, err); }
});

router.post('/efforts/autofill/rewrite', async (req, res) => {
  try { res.json({ success: true, data: await autofill.rewriteWorks(req.body || {}) }); } catch (err) { fail(res, err); }
});

router.post('/efforts/autofill/execute', async (req, res) => {
  try { res.json({ success: true, data: await autofill.startExecution(req.body || {}) }); } catch (err) { fail(res, err); }
});

router.get('/efforts/autofill/jobs/:id', (req, res) => {
  const job = autofill.getJob(req.params.id);
  if (!job) return res.status(404).json({ success: false, message: '找不到这个任务（后端重启过？可以到补填记录里查看已写入的）' });
  res.json({ success: true, data: job });
});

router.post('/efforts/autofill/jobs/:id/stop', (req, res) => {
  res.json({ success: autofill.stopJob(req.params.id) });
});

router.post('/efforts/autofill/undo', async (req, res) => {
  try { res.json({ success: true, data: await autofill.undoBatch((req.body || {}).batchId) }); } catch (err) { fail(res, err); }
});

router.get('/efforts/autofill/log', async (req, res) => {
  try { res.json({ success: true, data: await autofill.getLog() }); } catch (err) { fail(res, err); }
});

export default router;
