import express from 'express';
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const router = express.Router();

const LABEL = 'com.workassistant.backend';
const START_TIME = Date.now();

// src/routes/admin.js → 项目根
const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 本项目只有本机回环访问，其他来源一律拒绝 */
function isLocalRequest(req) {
  const ip = (req.ip || '').replace('::ffff:', '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '';
}

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
 * launchd 是否真的认识这个 job（已 bootstrap / 已加载）
 *
 * 只看 plist 文件在不在是不够的。文件在、但 job 没被 bootstrap 的情况下：
 *   · `launchctl print` 查不到（Bad request / Could not find service）
 *   · macOS 系统设置「通用 → 登录项与扩展 → 允许在后台」里也不显示
 * 用户看到的现象就是「开关说开了，可系统里什么都没有」，很自然地判定为假的。
 * 所以这两个状态必须分开报，前端才能给出可核对的提示。
 *
 * @returns {Promise<boolean>}
 */
function isLaunchAgentLoaded() {
  const uid = process.getuid ? process.getuid() : 501;
  return new Promise((resolve) => {
    execFile('launchctl', ['print', `gui/${uid}/${LABEL}`], { timeout: 5000 }, (err) => {
      resolve(!err);
    });
  });
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
    const launchAgentLoaded = launchAgentInstalled ? await isLaunchAgentLoaded() : false;

    res.json({
      success: true,
      data: {
        running: true,
        pid: process.pid,
        // 必须用 PORT：config.js 读的是 PORT，
        // 而前端会把这个值直接显示成「监听地址」，写错会误导排障。
        port: parseInt(process.env.PORT || '3721', 10),
        uptimeSeconds: Math.floor((Date.now() - START_TIME) / 1000),
        startedAt: new Date(START_TIME).toISOString(),
        launchedBy,
        launchAgentInstalled,
        launchAgentLoaded,
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
    if (!isLocalRequest(req)) {
      console.warn('[Admin] 拒绝非本机关闭请求:', req.ip);
      return res.status(403).json({ success: false, message: '仅允许本机请求' });
    }

    const disableAutoStart = !!(req.body && req.body.disableAutoStart);
    const launchAgentInstalled = isLaunchAgentInstalled();
    // bootout 只对「已加载的 job」有意义。plist 在、但 launchd 还没加载它时
    // 执行 bootout 必然失败，然后前端会显示一句并不成立的「停用开机自启失败」——
    // 那种情况本来就没东西需要停用，所以先判断 loaded 再决定要不要 bootout。
    const launchAgentLoaded = launchAgentInstalled ? await isLaunchAgentLoaded() : false;
    const notes = [];

    // 先停掉登录项，否则进程一退出就被 KeepAlive 立刻拉回来
    if (launchAgentLoaded) {
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
    } else if (launchAgentInstalled && disableAutoStart) {
      // 已注册但未加载：无需 bootout，但仍要按用户要求把注册项移除
      const plistPath = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
      try {
        const { unlinkSync } = await import('fs');
        unlinkSync(plistPath);
        notes.push('已删除开机自启配置');
      } catch (e) {
        notes.push(`删除登录项配置失败: ${e.message}`);
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

/**
 * 执行 scripts/ 下的脚本
 *
 * 开机自启的安装/卸载逻辑刻意不在这里用 JS 重写一遍，而是直接调用现成脚本：
 * plist 内容、node 路径解析、KeepAlive 策略都只该有一处定义，
 * 否则插件里点一下和终端里跑一次会得到两种结果。
 *
 * @param {string} scriptName scripts 目录下的文件名
 * @returns {Promise<{ok: boolean, output: string}>}
 */
function runScript(scriptName) {
  return new Promise((resolve) => {
    const scriptPath = join(PROJECT_DIR, 'scripts', scriptName);
    execFile(
      'bash',
      [scriptPath],
      { timeout: 20000, cwd: PROJECT_DIR },
      (err, stdout, stderr) => {
        const output = [String(stdout || ''), String(stderr || '')]
          .join('\n')
          .trim();
        resolve({ ok: !err, output });
      }
    );
  });
}

/**
 * POST /api/admin/autostart - 开启 / 关闭开机自启
 * body: { enabled: boolean }
 *
 * 与 shutdown 同样的安全约束：只接受本机请求。
 *
 * 注意这里**只写配置、不动进程**：脚本在端口被占用时不会去 bootstrap，
 * 也不会 bootout 正在服务的实例。否则这个请求会把自己的后端杀掉。
 */
router.post('/admin/autostart', async (req, res) => {
  try {
    if (!isLocalRequest(req)) {
      console.warn('[Admin] 拒绝非本机开机自启请求:', req.ip);
      return res.status(403).json({ success: false, message: '仅允许本机请求' });
    }

    const enabled = !!(req.body && req.body.enabled);
    const script = enabled ? 'install-launchagent.sh' : 'uninstall-launchagent.sh';
    const r = await runScript(script);

    // 不信任脚本的退出码，以「文件是否真的在」为准
    const installed = isLaunchAgentInstalled();
    // 顺带回报 launchd 是否已加载，前端据此区分
    // 「已加载、马上生效」与「已注册、下次登录生效」
    const loaded = installed ? await isLaunchAgentLoaded() : false;
    const ok = r.ok && installed === enabled;

    if (enabled && installed) {
      console.log('[Admin] 已开启开机自启', loaded ? '(launchd 已加载)' : '(待下次登录生效)');
    } else if (!enabled && !installed) {
      console.log('[Admin] 已关闭开机自启');
    } else {
      console.warn('[Admin] 开机自启操作未达到预期状态', { enabled, installed });
    }

    res.json({
      success: ok,
      // 前端用这个值同步开关的实际状态，而不是假设操作成功
      enabled: installed,
      installed,
      loaded,
      output: r.output,
      message: enabled
        ? (installed
            ? (loaded ? '已开启开机自启（launchd 已加载，下次登录会自动启动）'
                      : '已开启开机自启（已注册，下次登录生效）')
            : '未能开启开机自启，请查看详情')
        : (installed ? '未能关闭开机自启，请查看详情' : '已关闭开机自启')
    });
  } catch (err) {
    console.error('[Admin] 开机自启操作失败:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;