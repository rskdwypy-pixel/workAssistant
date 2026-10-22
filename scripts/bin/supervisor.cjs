/**
 * Windows 后台守护进程（Mac 上这件事由 launchd + bin/workassistant-run 完成）
 *
 * 由开机自启（注册表 Run → wscript bin\workassistant.vbs，隐藏窗口）或浏览器宿主拉起：
 *   · 运行 current.txt 记录的版本，数据在 data\，日志在 logs\backend.log
 *   · 后台异常退出（非 0）就重新拉起；以 0 退出（插件里点「停止服务」、端口已有后台在服务）守护进程也退出
 *   · 自动更新：后台装好新版本后以 75 退出，这里马上按新的 current.txt 拉起
 *   · 启动自检：update-pending 记着「新版本 已启动次数」，新版本连续 3 次没撑过 30 秒（后台运行 30 秒后会删掉它）
 *     → 退回上一个版本（含扩展目录），并记进 update-bad.txt，以后不再自动装它
 * 同一时间只运行一个（supervisor.pid）。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const WA_HOME = path.resolve(__dirname, '..');
const NODE = process.execPath;
const LOG_DIR = path.join(WA_HOME, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'backend.log');
const PID_FILE = path.join(WA_HOME, 'supervisor.pid');
const PENDING = path.join(WA_HOME, 'update-pending');
// 启动后这么久内又退出算「启动失败」，下一次拉起前等一会儿（与 launchd 的默认节流一致）
const THROTTLE_MS = 10 * 1000;

// 不用 fs.cpSync：Node 22 在 Windows 上遇到含中文的路径会让进程直接崩溃（0xC0000409）
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

const read = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; } };
const log = (msg) => { try { fs.appendFileSync(LOG_FILE, `[Supervisor] ${new Date().toISOString()} ${msg}\n`); } catch { /* 日志写不了也照常运行 */ } };

function alreadyRunning() {
  const pid = parseInt(read(PID_FILE), 10);
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 启动自检：返回这次要运行的版本 */
function resolveVersion() {
  let version = read(path.join(WA_HOME, 'current.txt'));
  if (!fs.existsSync(PENDING)) return version;
  const [pVersion, pTries] = read(PENDING).split(/\s+/);
  const tries = parseInt(pTries, 10) || 0;
  if (pVersion !== version) {
    fs.rmSync(PENDING, { force: true });
  } else if (tries >= 3) {
    const prev = read(path.join(WA_HOME, 'previous.txt'));
    if (prev && fs.existsSync(path.join(WA_HOME, 'versions', prev, 'src', 'index.js'))) {
      log(`[Update] ${version} 连续 ${tries} 次启动失败，退回 ${prev}`);
      fs.appendFileSync(path.join(WA_HOME, 'update-bad.txt'), `${version}\n`);
      fs.writeFileSync(path.join(WA_HOME, 'current.txt'), `${prev}\n`);
      try {
        const ext = path.join(WA_HOME, 'extension');
        fs.rmSync(ext, { recursive: true, force: true });
        copyDir(path.join(WA_HOME, 'versions', prev, 'extension'), ext);
      } catch (err) {
        log(`扩展目录退回失败：${err.message}`);
      }
      version = prev;
    }
    fs.rmSync(PENDING, { force: true });
  } else {
    fs.writeFileSync(PENDING, `${version} ${tries + 1}\n`);
  }
  return version;
}

function runOnce() {
  const version = resolveVersion();
  const dir = path.join(WA_HOME, 'versions', version);
  if (!version || !fs.existsSync(path.join(dir, 'src', 'index.js'))) {
    log(`找不到要运行的版本（current.txt：${version || '空'}），请重新运行安装命令`);
    return Promise.resolve({ code: 1, ranMs: 0, fatal: true });
  }
  const fd = fs.openSync(LOG_FILE, 'a');
  const started = Date.now();
  const child = spawn(NODE, ['src/index.js'], {
    cwd: dir,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
    env: {
      ...process.env,
      WA_HOME,
      WA_DATA_DIR: path.join(WA_HOME, 'data'),
      WORKASSISTANT_LAUNCHED_BY: 'supervisor',
      WORKASSISTANT_LOG_FILE: LOG_FILE
    }
  });
  fs.closeSync(fd);
  return new Promise((resolve) => {
    child.on('error', (err) => { log(`启动失败：${err.message}`); resolve({ code: 1, ranMs: Date.now() - started }); });
    child.on('exit', (code, signal) => resolve({ code: code === null ? 1 : code, signal, ranMs: Date.now() - started }));
  });
}

async function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  if (alreadyRunning()) return;
  fs.writeFileSync(PID_FILE, String(process.pid));
  const cleanup = () => { if (read(PID_FILE) === String(process.pid)) fs.rmSync(PID_FILE, { force: true }); };
  process.on('exit', cleanup);

  for (;;) {
    const { code, ranMs, fatal } = await runOnce();
    if (fatal) process.exit(1);
    if (code === 0) {
      log('后台正常退出，守护进程随之退出');
      process.exit(0);
    }
    if (code === 75) {
      log('后台已安装新版本，重新拉起');
      continue;
    }
    log(`后台异常退出（${code}），${ranMs < THROTTLE_MS ? '10 秒后' : ''}重新拉起`);
    if (ranMs < THROTTLE_MS) await new Promise(r => setTimeout(r, THROTTLE_MS));
  }
}

main().catch((err) => { log(`守护进程出错：${err.stack || err.message}`); process.exit(1); });
