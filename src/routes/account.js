/**
 * 账号接口
 *
 *   GET  /api/account[?refresh=1]      登录状态与用户信息（state: unconfigured | invalid | offline | ok）
 *   POST /api/account/login            { url, username, password, confirmSwitch? } 先真实登录，成功才保存；
 *                                      换成别的账号且本地有数据时返回 needConfirm，确认后清空本地数据再登录
 *   POST /api/account/logout           清除密码与会话（保留地址、账号）
 *   POST /api/account/reset            { includeData? } 清空全部配置，回到第一次使用（设置页调试模式里的按钮）
 */
import express from 'express';
import * as account from '../services/account.js';

const router = express.Router();

router.get('/account', async (req, res) => {
  try {
    res.json({ success: true, data: await account.getAccountState({ refresh: req.query.refresh === '1' }) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/account/login', async (req, res) => {
  try {
    const b = req.body || {};
    const result = await account.login({ url: b.url, username: b.username, password: b.password, confirmSwitch: b.confirmSwitch === true });
    res.status(result.ok || result.needConfirm ? 200 : 400).json({ success: result.ok, data: result, message: result.error ? result.error.message : '' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/account/logout', async (req, res) => {
  try {
    res.json({ success: true, data: await account.logout() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/account/reset', async (req, res) => {
  try {
    const b = req.body || {};
    res.json({ success: true, data: await account.resetAll({ includeData: b.includeData === true }) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
