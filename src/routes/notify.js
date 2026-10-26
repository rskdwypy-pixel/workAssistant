/**
 * 新指派提醒
 *
 *   GET  /api/notify/settings        { enabled, system, webhook, webhookConfigured }
 *   POST /api/notify/settings        { enabled?, system?, webhook? }
 *   GET  /api/notifications          { items, unread }  插件里的未读列表（新的在前）
 *   POST /api/notifications/read     { ids: string[] | 'all' }
 *   POST /api/notifications/check    立即检查一次（不等 5 分钟）
 *   POST /api/notifications/test     发一条测试提醒，验证系统通知和 Webhook
 */
import express from 'express';
import { config } from '../config.js';
import * as notify from '../services/assignNotify.js';

const router = express.Router();
const fail = (res, err) => res.status(500).json({ success: false, message: (err && err.message) || '服务异常' });

router.get('/notify/settings', (req, res) => {
  res.json({ success: true, data: { ...notify.getSettings(), webhookConfigured: !!(config.webhook && config.webhook.url) } });
});

router.post('/notify/settings', (req, res) => {
  try {
    res.json({ success: true, data: { ...notify.saveSettings(req.body || {}), webhookConfigured: !!(config.webhook && config.webhook.url) } });
  } catch (err) { fail(res, err); }
});

router.get('/notifications', (req, res) => {
  try { res.json({ success: true, data: notify.listNotifications() }); } catch (err) { fail(res, err); }
});

router.post('/notifications/read', (req, res) => {
  try {
    const ids = req.body && req.body.ids;
    res.json({ success: true, data: notify.markRead(ids === 'all' ? 'all' : Array.isArray(ids) ? ids : []) });
  } catch (err) { fail(res, err); }
});

router.post('/notifications/check', async (req, res) => {
  try { res.json({ success: true, data: { ...(await notify.pollOnce({ force: true })), ...notify.listNotifications() } }); } catch (err) { fail(res, err); }
});

router.post('/notifications/test', async (req, res) => {
  try { res.json({ success: true, data: await notify.sendTest() }); } catch (err) { fail(res, err); }
});

export default router;
