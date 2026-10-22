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
 * 由启动方通过环境变量 WORKASSISTANT_LAUNCHED_BY 声明：
 * LaunchAgent plist 写 launchd，backend-launcher.sh 写 native；未设置即手动启动。
 * （不能靠 ppid 推断：宿主拉起的后端会脱离宿主，ppid 同样是 1）
 */
function detectLauncher() {
  return process.env.WORKASSISTANT_LAUNCHED_BY || 'manual';
}

function isLaunchAgentInstalled() {
  return existsSync(join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`));
}

// ==================== Windows：开机自启是当前用户的启动项（注册表 Run） ====================
// 由安装器 installer/install.ps1 注册；值是「wscript.exe "<WorkAssistant>\bin\workassistant.vbs"」（隐藏窗口启动守护进程）
const IS_WINDOWS = process.platform === 'win32';
const WIN_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const WIN_RUN_NAME = 'WorkAssistant';

function reg(args) {
  return new Promise((resolve) => {
    execFile('reg', args, { timeout: 10000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: [String(stdout || ''), String(stderr || '')].join('\n').trim() });
    });
  });
}

async function isWinAutostartInstalled() {
  const r = await reg(['query', WIN_RUN_KEY, '/v', WIN_RUN_NAME]);
  return r.ok && /REG_SZ/.test(r.output);
}

async function setWinAutostart(enabled) {
  if (!enabled) return reg(['delete', WIN_RUN_KEY, '/v', WIN_RUN_NAME, '/f']);
  if (!process.env.WA_HOME) return { ok: false, output: '开发版（在仓库里运行）不支持开机自启，请用安装命令安装' };
  const vbs = join(process.env.WA_HOME, 'bin', 'workassistant.vbs');
  return reg(['add', WIN_RUN_KEY, '/v', WIN_RUN_NAME, '/t', 'REG_SZ', '/d', `wscript.exe "${vbs}"`, '/f']);
}

/** 开机自启是否已注册（Mac：LaunchAgent 文件；Windows：启动项） */
async function autostartInstalled() {
  return IS_WINDOWS ? isWinAutostartInstalled() : isLaunchAgentInstalled();
}

/** 开机自启是否已生效（Mac：launchd 已加载；Windows：注册了就会在下次登录生效，守护进程已在跑） */
async function autostartLoaded(installed) {
  if (!installed) return false;
  return IS_WINDOWS ? true : isLaunchAgentLoaded();
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
 * GET /api/admin/status - 本地服务状态
 *
 * 供插件展示「是否运行 / 由谁启动 / 能否停止」，
 * 避免用户在不该停的时候点停止（比如正在跑定时日报）。
 */
router.get('/admin/status', async (req, res) => {
  try {
    const launchedBy = detectLauncher();
    const launchAgentInstalled = await autostartInstalled();
    const launchAgentLoaded = await autostartLoaded(launchAgentInstalled);

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
        platform: process.platform,
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
 * 来源校验由全局 requestGuard 完成（只放行本插件 / 本机命令行），这里再兜底校验 IP。
 *
 * 关闭方式：进程以 0 退出。LaunchAgent 的 KeepAlive 是 SuccessfulExit=false，
 * 只对异常退出重启，所以正常退出不会被拉回来，也不需要 bootout。
 * 旧实现先 bootout 自己所在的 job：launchd 当场 SIGTERM 本进程，响应发不出去，
 * 而且 job 被卸载到下次登录，之后「启动」只能走浏览器宿主，后端跟着浏览器退出、日报静默丢失。
 */
router.post('/admin/shutdown', async (req, res) => {
  try {
    if (!isLocalRequest(req)) {
      console.warn('[Admin] 拒绝非本机关闭请求:', req.ip);
      return res.status(403).json({ success: false, message: '仅允许本机请求' });
    }

    const disableAutoStart = !!(req.body && req.body.disableAutoStart);
    const notes = [];

    // 用户显式要求「关闭并停用开机自启」时才动登录项配置（脚本在后端调用时不会 bootout 本进程）
    if (disableAutoStart && await autostartInstalled()) {
      const r = IS_WINDOWS ? await setWinAutostart(false) : await runScript('uninstall-launchagent.sh');
      notes.push(await autostartInstalled()
        ? `停用开机自启失败: ${r.output.split('\n').pop()}`
        : '已停用开机自启');
    }

    // 必须先回包，再退出 —— 否则前端会收到连接中断错误，看不到结果
    res.json({
      success: true,
      message: '本地服务已关闭',
      notes
    });

    console.log('[Admin] 收到关闭请求，1 秒后退出...', notes.join(' / '));
    setTimeout(() => process.exit(0), 1000);
  } catch (err) {
    console.error('[Admin] 关闭失败:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
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
      {
        timeout: 20000,
        cwd: PROJECT_DIR,
        // 告诉脚本「是正在运行的后端在调用你」：脚本据此绝不 bootout 本进程所在的 job
        env: { ...process.env, WORKASSISTANT_CALLED_FROM_BACKEND: '1' }
      },
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
    const r = IS_WINDOWS
      ? await setWinAutostart(enabled)
      : await runScript(enabled ? 'install-launchagent.sh' : 'uninstall-launchagent.sh');

    // 不信任脚本的退出码，以「文件 / 启动项是否真的在」为准
    const installed = await autostartInstalled();
    // 顺带回报 launchd 是否已加载，前端据此区分
    // 「已加载、马上生效」与「已注册、下次登录生效」
    const loaded = await autostartLoaded(installed);
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
            ? (IS_WINDOWS ? '已开启开机自启（登录 Windows 时自动启动）'
              : loaded ? '已开启开机自启（launchd 已加载，下次登录会自动启动）'
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