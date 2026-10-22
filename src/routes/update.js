import express from 'express';
import { getUpdater } from '../services/updater.js';

const router = express.Router();

/** GET /api/update/status - 当前版本、是否自动更新、最近一次检查 / 更新 */
router.get('/update/status', (req, res) => {
  res.json({ success: true, data: getUpdater().getStatus() });
});

/** POST /api/update/check - 立即检查（有新版本会下载好，等空闲时安装，或点「立即更新」） */
router.post('/update/check', async (req, res) => {
  const updater = getUpdater();
  if (!updater.installed) return res.json({ success: false, message: '开发版（在仓库里运行）不自动更新', data: updater.getStatus() });
  res.json({ success: true, data: await updater.check({ manual: true }) });
});

/** POST /api/update/apply - 立即安装已下载好的新版本（后台会重启，插件随后自动重新加载） */
router.post('/update/apply', (req, res) => {
  const updater = getUpdater();
  const s = updater.getStatus();
  if (s.state !== 'ready') return res.json({ success: false, message: '没有已下载好的新版本', data: s });
  res.json({ success: true, data: { ...s, state: 'restarting' } });
  // 先把响应发出去再切换、重启
  setTimeout(() => updater.apply(), 100);
});

/** POST /api/update/settings - { auto: boolean } */
router.post('/update/settings', (req, res) => {
  res.json({ success: true, data: getUpdater().setAuto(!(req.body && req.body.auto === false)) });
});

export default router;
