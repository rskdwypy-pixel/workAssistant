/**
 * 报告页接口
 *
 *   GET  /api/reports/calendar?month=YYYY-MM           当月日历（每天日报 / 每周周报 / 月报的状态）
 *   GET  /api/reports/:kind/:key                       读取已保存的报告（未生成时 report 为 null）
 *   POST /api/reports/:kind/:key/generate              生成（或重新生成）并保存；body.part = mine | team 只重新生成这一部分
 *   POST /api/reports/:kind/:key/push                  推送到通知 / 群机器人；body.part = mine（默认）| team
 *   GET  /api/reports/legacy/:date                     旧版日报（基于本地任务，迁移前生成的）
 *   GET  /api/reports/list                             已生成的报告（历史报告列表，新的在前）
 *   GET  /api/reports/members                          团队成员 + 全员报告关注的用户
 *   POST /api/reports/members                          保存全员报告关注的用户 body.accounts（空 = 全员）
 *
 * kind: daily | weekly | monthly；key: 日报 YYYY-MM-DD，周报为当周任意一天，月报 YYYY-MM
 */
import express from 'express';
import * as reportCenter from '../services/reportCenter.js';

const router = express.Router();
const KINDS = new Set(['daily', 'weekly', 'monthly']);
const PARTS = new Set(['mine', 'team']);
const partOf = (req) => (PARTS.has(req.body && req.body.part) ? req.body.part : null);

function checkKind(req, res) {
  if (!KINDS.has(req.params.kind)) {
    res.status(400).json({ success: false, message: '报告类型应为 daily / weekly / monthly' });
    return false;
  }
  try {
    reportCenter.periodOf(req.params.kind, req.params.key);
    return true;
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
    return false;
  }
}

router.get('/reports/calendar', async (req, res) => {
  try {
    const month = String(req.query.month || reportCenter.ymd(new Date()).slice(0, 7));
    res.json({ success: true, data: await reportCenter.getCalendar(month) });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

router.get('/reports/list', async (req, res) => {
  try {
    res.json({ success: true, data: await reportCenter.listReports(Number(req.query.limit) || 100) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/reports/members', async (req, res) => {
  try {
    const { config } = await import('../config.js');
    let members = [];
    let message = '';
    try {
      const { getTeamMembers } = await import('../services/zentaoService.js');
      members = (await getTeamMembers()).filter(m => m.account !== 'admin');
    } catch (err) {
      // 禅道连不上时用本地缓存的用户列表，至少能看到 / 改已选的人
      const cached = config.zentao.users || {};
      members = Object.entries(cached).filter(([a]) => a !== 'admin').map(([account, realname]) => ({ account, realname, role: '' }));
      message = `读取禅道团队失败，显示的是本地缓存：${err.message}`;
    }
    res.json({ success: true, data: { members, selected: config.reports.members, message } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/reports/members', async (req, res) => {
  try {
    const { config, updateEnvFile, parseAccountList } = await import('../config.js');
    const list = Array.isArray(req.body && req.body.accounts) ? req.body.accounts : [];
    const accounts = parseAccountList(list.join(','));
    updateEnvFile({ REPORT_MEMBERS: accounts.join(',') });
    config.reports.members = accounts;
    res.json({ success: true, data: { selected: accounts } });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/reports/legacy/:date', async (req, res) => {
  try {
    const { getHistoryByDate } = await import('../services/summary.js');
    const report = await getHistoryByDate(String(req.params.date));
    res.json({ success: true, data: report || null });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/reports/:kind/:key', async (req, res) => {
  if (!checkKind(req, res)) return;
  try {
    const { kind, key } = req.params;
    const period = reportCenter.periodOf(kind, key);
    res.json({
      success: true,
      data: await reportCenter.getReport(kind, key),
      period,
      status: reportCenter.generationStatus(kind, key)
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/reports/:kind/:key/generate', async (req, res) => {
  if (!checkKind(req, res)) return;
  try {
    const report = await reportCenter.generateReport(req.params.kind, req.params.key, { part: partOf(req) });
    res.json({ success: true, data: report });
  } catch (err) {
    console.error('[API] 生成报告失败:', err.message);
    const { describeZentaoTransportError } = await import('../services/zentaoService.js');
    res.status(500).json({ success: false, message: describeZentaoTransportError(err) });
  }
});

router.post('/reports/:kind/:key/push', async (req, res) => {
  if (!checkKind(req, res)) return;
  try {
    const report = await reportCenter.getReport(req.params.kind, req.params.key);
    if (!report) return res.status(404).json({ success: false, message: '报告还没有生成' });
    await reportCenter.pushReport(report, partOf(req) || 'mine');
    res.json({ success: true, message: '已推送' });
  } catch (err) {
    res.status(500).json({ success: false, message: `推送失败：${err.message}` });
  }
});

export default router;
