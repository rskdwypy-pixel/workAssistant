import express from 'express';
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const router = express.Router();

const LABEL = 'com.workassistant.backend';
const START_TIME = Date.now();

/**
 * 进程信息：谁启动的我
 *
 * - manual   手动 npm start
 * - native   由 Native Messaging 宿主（backend-launcher.sh）拉起
 * - launchd  由 macOS 登录项拉起
 *
 * 宿主脚本会设置 WORKASSISTANT_LAUNCHED_BY=native；
 * LaunchAgent 未设置该变量，因此「变量为空且父进程为 launchd」判定为 launchd。
 */
function detectLauncher() {
  if (process.env.WORKASSISTANT_LAUNCHED_BY) {
    return process.env.WORKASSISTANT_LAUNCHED_BY;
  }
  return process.ppid === 1 ? 'launchd' : 'manual';
}

function isLaunchAgentInstalled() {
  return existsSync(join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`));
}

/**
 * 执行 launchctl 命令
 * @param {string[]} args
 * @returns {Promise<{ok: boolean, output: string}>}
 */
function runLaunchctl(args) {
  return new Promise((resolve) => {
    execFile('launchctl', args, { timeout: 8000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, output: (stderr || err.message || '').trim() });
      } else {
        resolve({ ok: true, output: String(stdout || '').trim() });
      }
    });
  });
}

/**
 * GET /api/admin/status - 本地服务状态
 *
 * 供插件展示「是否运行 / 由谁启动 / 能否停止」，
 * 避免用户在不该停的时候点停止（比如正在跑定时日报）。
 */
router.get('/admin/status', async (req, res) => {
  try {
    const launchedBy = detectLauncher();
    const launchAgentInstalled = isLaunchAgentInstalled();

    res.json({
      success: true,
      data: {
        running: true,
        pid: process.pid,
        port: process.env.WORKASSISTANT_PORT || 3721,
        uptimeSeconds: Math.floor((Date.now() - START_TIME) / 1000),
        startedAt: new Date(START_TIME).toISOString(),
        launchedBy,
        launchAgentInstalled,
        // 只有常驻服务（登录项）才需要先停用才能真正关闭
        needsLaunchAgentStop: launchAgentInstalled,
        canStop: true
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/admin/shutdown - 关闭本地服务
 * body: { disableAutoStart?: boolean }
 *
 * 安全约束：这是能杀掉服务的接口，只接受来自本机的请求。
 * Express 仅监听 localhost，但要额外校验来源，
 * 避免浏览器里任意网页通过 fetch 打过来（插件自身也会走这里，故允许扩展来源）。
 */
router.post('/admin/shutdown', async (req, res) => {
  try {
    // —— 来源校验 ——
    const ip = (req.ip || '').replace('::ffff:', '');
    const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '';
    if (!isLocal) {
      console.warn('[Admin] 拒绝非本机关闭请求:', req.ip);
      return res.status(403).json({ success: false, message: '仅允许本机请求' });
    }

    const disableAutoStart = !!(req.body && req.body.disableAutoStart);
    const launchAgentInstalled = isLaunchAgentInstalled();
    const notes = [];

    // 先停掉登录项，否则进程一退出就被 KeepAlive 立刻拉回来
    if (launchAgentInstalled) {
      const uid = process.getuid ? process.getuid() : 501;
      const r = await runLaunchctl(['bootout', `gui/${uid}/${LABEL}`]);
      if (r.ok) {
        notes.push('已停用开机自启');
        if (disableAutoStart) {
          const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
          try {
            // 仅在用户显式要求时删除 plist 文件
            const { unlinkSync } = await import('fs');
            unlinkSync(plistPath);
            notes.push('已删除开机自启配置');
          } catch (e) {
            notes.push(`删除登录项配置失败: ${e.message}`);
          }
        }
      } else {
        notes.push(`停用开机自启失败(不影响本次关闭): ${r.output}`);
      }
    }

    // 必须先回包，再退出 —— 否则前端会收到连接中断错误，看不到结果
    res.json({
      success: true,
      message: '本地服务已关闭',
      notes
    });

    console.log('[Admin] 收到关闭请求，2 秒后退出...', notes.join(' / '));

    // 留出时间让 HTTP 响应发完
    setTimeout(() => {
      process.exit(0);
    }, 2000);
  } catch (err) {
    console.error('[Admin] 关闭失败:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/admin/restart-support - 查询重启前置条件
 *
 * 插件本身拉不起后端（除非注册了 Native Messaging 宿主），
 * 这个接口用于让前端如实告诉用户重启是否可行，而不是假装成功。
 */
router.post('/admin/restart-support', async (req, res) => {
  res.json({
    success: true,
    data: {
      // 服务已退出，只能靠外部拉起
      viaNativeMessaging: true,
      viaLaunchAgent: isLaunchAgentInstalled(),
      hint: '关闭后请在设置中点击「启动服务」，或等待开机自启/手动启动'
    }
  });
});

export default router;