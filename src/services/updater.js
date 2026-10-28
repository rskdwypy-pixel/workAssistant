/**
 * 自动更新（只在安装版里运行；在仓库里直接运行的开发版不更新）
 *
 * 安装目录（见 installer/install-mac.sh）：
 *   versions/<版本>/  current.txt  previous.txt  extension/  bin/  data/
 *
 * 流程：
 *   1. 检查：启动 1 分钟后、之后每 1 小时，看 GitHub Releases 的最新版本号
 *   2. 下载：新版本的安装包 + .sha256 + .sig，校验哈希和 Ed25519 签名（公钥见 releaseKey.js），
 *      解压到 versions/<新版本>/；新版本需要更高的 Node 时不装，提示重新运行安装命令
 *   3. 安装：等后台空闲（3 分钟没有请求，且不在早晚提醒 / 日报 / 周报的时间段），
 *      刷新 bin/ 固定入口、替换 extension/（浏览器扩展自己发现文件变了会重新加载）、
 *      切换 current.txt，写 update-pending，然后重启后台
 *   4. 自检：新版本正常运行 30 秒后删掉 update-pending；连续 3 次没撑过 30 秒，
 *      bin/workassistant-run 会退回上一个版本，并把这个版本记进 update-bad.txt，以后不再自动装它
 *
 * 下载用系统自带的 curl（与安装器一致，Mac / Windows 10+ 都有）：
 * Node 的 fetch 不走 HTTPS_PROXY 等代理设置，公司网络里容易连不上 GitHub。
 */
import { execFile, spawn } from 'child_process';
import { createHash, verify as verifySignature } from 'crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { RELEASE_PUBLIC_KEY } from './releaseKey.js';

// 发布源：默认先 Gitee（国内 / 内网更稳），连不上再回退 GitHub。
// 可用 WA_UPDATE_URL 覆盖成单一地址（测试、私有镜像用）。
const GITEE_RELEASES = 'https://gitee.com/iTreeNewBee/work-assistant/releases';
const GITHUB_RELEASES = 'https://github.com/rskdwypy-pixel/workAssistant/releases';
const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const CHECK_DELAY_MS = 60 * 1000;
const CHECK_INTERVAL_MS = 1 * 60 * 60 * 1000;
const APPLY_RETRY_MS = 5 * 60 * 1000;
const IDLE_MS = 3 * 60 * 1000;
const HEALTHY_AFTER_MS = 30 * 1000;
// 定时任务前后不重启：整点开始的提醒 / 报告大约在 15 分钟内跑完
const QUIET_MINUTES = 15;

/** 比较 x.y.z：a > b 返回正数 */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

/**
 * 递归复制目录。不用 fs.cpSync：Node 22 在 Windows 上遇到含中文的路径会让进程直接崩溃（0xC0000409），
 * 用户名是中文时安装目录就含中文。
 */
export function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const e of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, e.name);
    const to = join(dst, e.name);
    if (e.isDirectory()) copyDir(from, to);
    else copyFileSync(from, to);
  }
}

const readText = (file) => {
  try { return readFileSync(file, 'utf8').trim(); } catch { return ''; }
};

function run(cmd, args, timeout, cwd) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, cwd, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || '').trim().split('\n').pop();
        return reject(new Error(detail || err.message));
      }
      resolve(String(stdout));
    });
  });
}

/**
 * @param {object} [opts]  测试用：换掉安装目录、下载地址、时钟、重启方式等
 */
export function createUpdater(opts = {}) {
  const root = opts.root || ROOT_DIR;
  const waHome = opts.waHome !== undefined ? opts.waHome : (process.env.WA_HOME || '');
  const dataDir = opts.dataDir || process.env.WA_DATA_DIR || join(root, 'data');
  // 发布源列表：显式指定（opts / 环境变量）时只用这一个；否则 Gitee 优先、GitHub 兜底
  const override = opts.baseUrl || process.env.WA_UPDATE_URL || '';
  const bases = (opts.bases || (override ? [override] : [GITEE_RELEASES, GITHUB_RELEASES])).map(u => u.replace(/\/$/, ''));
  // fetchLatestVersion 选中哪个源能用，后续下载就走那个
  let activeBase = bases[0];
  let candidateBases = [bases[0]];   // 有最新版本的发布源（下载失败时依次换下一个）
  const publicKey = opts.publicKey || RELEASE_PUBLIC_KEY;
  const now = opts.now || (() => new Date());
  const scheduleHours = opts.scheduleHours || (() => []);
  const restartImpl = opts.restart || defaultRestart;
  const log = opts.log || ((...a) => console.log('[Update]', ...a));

  const pkgInfo = (() => {
    try { return JSON.parse(readFileSync(join(root, '.wa-package'), 'utf8')); } catch { return null; }
  })();
  const installed = !!(waHome && pkgInfo && pkgInfo.app === 'workassistant');
  const currentVersion = (() => {
    try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version; } catch { return '0.0.0'; }
  })();

  const settingsFile = join(dataDir, 'update.json');
  const pendingFile = waHome ? join(waHome, 'update-pending') : '';
  const badFile = waHome ? join(waHome, 'update-bad.txt') : '';

  let lastActivity = Date.now();
  let busy = false;
  let timers = [];
  // 运行时状态（不落盘）：idle / checking / downloading / ready / error / needs-installer
  let status = { state: 'idle', latest: '', error: '', readyVersion: '' };

  function loadSettings() {
    try {
      const s = JSON.parse(readFileSync(settingsFile, 'utf8'));
      return { auto: s.auto !== false, lastCheck: s.lastCheck || '', lastUpdate: s.lastUpdate || null };
    } catch {
      return { auto: true, lastCheck: '', lastUpdate: null };
    }
  }
  function saveSettings(patch) {
    const next = { ...loadSettings(), ...patch };
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(settingsFile, JSON.stringify(next, null, 2) + '\n');
    return next;
  }

  const badVersions = () => readText(badFile).split('\n').map(s => s.trim()).filter(Boolean);

  function getStatus() {
    const s = loadSettings();
    const bad = badVersions();
    return {
      installed,
      current: currentVersion,
      auto: s.auto,
      lastCheck: s.lastCheck,
      lastUpdate: s.lastUpdate,
      state: installed ? status.state : 'dev',
      latest: status.latest,
      readyVersion: status.readyVersion,
      // 下载进度：received / total 字节（total 为 0 表示服务器没告知大小），percent 为整数 0~100 或 null
      progress: status.state === 'downloading' ? (status.progress || { received: 0, total: 0, percent: null }) : null,
      // 已下载好的版本上次安装后启动失败、被退回过：不自动安装，只能手动点「立即更新」
      readyIsBad: !!status.readyVersion && bad.includes(status.readyVersion),
      // 上次自动更新的版本启动失败，已退回
      rolledBack: !!(s.lastUpdate && s.lastUpdate.to !== currentVersion && bad.includes(s.lastUpdate.to)),
      error: status.error
    };
  }

  /**
   * 最新版本号：/releases/latest 会跳到 /releases/tag/vX.Y.Z（Gitee 与 GitHub 规则一致）。
   * 每个发布源都问一遍，取其中最高的版本——发版时 GitHub 先发布、Gitee 随后在本机同步，
   * Gitee 落后的那段时间里只问第一个源会看不到新版本。有这个版本的源按顺序都作为下载候选（Gitee 优先）。
   */
  async function fetchLatestVersion() {
    let lastErr = null;
    const found = [];
    for (const base of bases) {
      try {
        // 只看第一跳的 Location：Gitee 的 tag 页面会再跳到源码压缩包，跟到底就读不到版本号了
        const head = await run('curl', ['-sI', '--connect-timeout', '15', '--max-time', '60', `${base}/latest`], 70 * 1000);
        const loc = (head.match(/^location:\s*(\S+)/im) || [])[1] || '';
        const m = loc.match(/\/tag\/v?(\d+\.\d+\.\d+)$/);
        if (m) found.push({ base, version: m[1] });
        else lastErr = new Error(`没有读到最新版本号（${loc || '没有跳转'}）`);
      } catch (err) {
        lastErr = err;
      }
    }
    if (!found.length) throw lastErr || new Error('没有读到最新版本号');
    let best = found[0];
    for (const f of found) if (compareVersions(f.version, best.version) > 0) best = f;
    candidateBases = found.filter(f => f.version === best.version).map(f => f.base);
    activeBase = candidateBases[0];
    return best.version;
  }

  /** 远端文件大小（字节）；取不到返回 0（界面显示不确定进度） */
  async function remoteSize(url) {
    try {
      const out = await run('curl', ['-sIL', '--connect-timeout', '10', '--max-time', '20', url], 25 * 1000);
      const lens = [...out.matchAll(/^content-length:\s*(\d+)/gim)].map(m => Number(m[1]));
      return lens.length ? lens[lens.length - 1] : 0;   // 跟随跳转后的最后一个响应
    } catch {
      return 0;
    }
  }

  function setProgress(received, total) {
    const percent = total > 0 ? Math.max(0, Math.min(100, Math.floor((received * 100) / total))) : null;
    status = { ...status, progress: { received, total, percent } };
  }

  /** @param {{track?:boolean}} [options] track：边下边上报进度（只对大文件，量一下磁盘上文件的大小） */
  async function download(url, file, { track = false } = {}) {
    let timer = null;
    let total = 0;
    if (track) {
      total = await remoteSize(url);
      setProgress(0, total);
      timer = setInterval(() => {
        try { setProgress(statSync(file).size, total); } catch { /* 文件还没出现 */ }
      }, 250);
    }
    try {
      await run('curl', ['-fsSL', '--retry', '2', '--connect-timeout', '15', '--max-time', '900', '-o', file, url], 920 * 1000);
    } finally {
      if (timer) clearInterval(timer);
    }
    if (track) {
      let size = total;
      try { size = statSync(file).size; } catch { /* ignore */ }
      setProgress(size, size);
    }
  }

  /** 这个版本是不是已经下载、校验、解压好了 */
  function isPrepared(version) {
    const marker = join(waHome, 'versions', version, '.wa-package');
    return existsSync(marker) && readText(marker).includes(`"version": "${version}"`);
  }

  /** 下载、校验、解压到 versions/<版本>/；返回 true 表示已就绪 */
  async function prepare(version) {
    const dir = join(waHome, 'versions', version);
    if (isPrepared(version)) return true;

    const work = join(waHome, 'downloads');
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    const tag = `v${version}`;
    const tgz = join(work, 'workassistant.tar.gz');
    status = { ...status, state: 'downloading', error: '', progress: { received: 0, total: 0, percent: null } };
    log(`下载 ${version}`);
    // 安装包、校验文件、签名必须来自同一个源；一个源下载失败就换下一个有这个版本的源
    let got = false;
    let dlErr = null;
    for (const base of candidateBases.length ? candidateBases : [activeBase]) {
      try {
        await download(`${base}/download/${tag}/workassistant.tar.gz`, tgz, { track: true });
        await download(`${base}/download/${tag}/workassistant.tar.gz.sha256`, `${tgz}.sha256`);
        try {
          await download(`${base}/download/${tag}/workassistant.tar.gz.sig`, `${tgz}.sig`);
        } catch {
          throw new Error(`${version} 没有签名文件，不自动安装（可重新运行安装命令手动更新）`);
        }
        got = true;
        break;
      } catch (err) {
        dlErr = err;
        log(`从 ${base.split('/')[2]} 下载 ${version} 失败：${err.message}`);
      }
    }
    if (!got) throw dlErr || new Error('下载失败');

    const data = readFileSync(tgz);
    const expectSha = readText(`${tgz}.sha256`).split(/\s+/)[0];
    const actualSha = createHash('sha256').update(data).digest('hex');
    if (!expectSha || expectSha !== actualSha) throw new Error('安装包校验不通过（文件不完整）');
    const sig = Buffer.from(readText(`${tgz}.sig`), 'base64');
    let signed = false;
    try { signed = verifySignature(null, data, publicKey, sig); } catch { signed = false; }
    if (!signed) throw new Error('安装包签名不对，拒绝安装');

    const unpack = join(work, 'unpack');
    mkdirSync(unpack, { recursive: true });
    // Windows 自带的 tar.exe 打不开含中文的路径（用户名是中文时安装目录就含中文）：在下载目录里运行、只传相对路径
    await run('tar', ['-xzf', 'workassistant.tar.gz', '-C', 'unpack'], 120 * 1000, work);
    const top = readdirSync(unpack, { withFileTypes: true }).filter(e => e.isDirectory());
    if (top.length !== 1) throw new Error('安装包结构不对');
    const pkgDir = join(unpack, top[0].name);
    let info;
    try { info = JSON.parse(readFileSync(join(pkgDir, '.wa-package'), 'utf8')); } catch { info = null; }
    if (!info || info.app !== 'workassistant' || info.version !== version) throw new Error('不是禅道助手的安装包，或版本号对不上');
    if (info.node && compareVersions(info.node, process.versions.node) > 0) {
      const e = new Error(`新版本 ${version} 需要更新运行环境（Node ${info.node}），请重新运行一次安装命令`);
      e.needsInstaller = true;
      throw e;
    }
    rmSync(dir, { recursive: true, force: true });
    renameSync(pkgDir, dir);
    rmSync(work, { recursive: true, force: true });
    log(`${version} 已下载并校验`);
    return true;
  }

  /**
   * 检查更新；有新版本就下载好（auto 时随后在空闲时安装）。
   * @param {{manual?:boolean, detach?:boolean}} [options]
   *   detach：发现新版本后立刻返回（state=downloading，带 latest），下载在后台继续，界面轮询 getStatus().progress 显示进度；
   *   不带 detach（定时检查）则一直等到下载完成。
   */
  async function check({ manual = false, detach = false } = {}) {
    if (!installed) return getStatus();
    if (busy) return getStatus();
    busy = true;
    let detached = false;
    status = { ...status, state: 'checking', error: '', progress: null };
    try {
      const latest = await fetchLatestVersion();
      saveSettings({ lastCheck: now().toISOString() });
      status.latest = latest;
      if (compareVersions(latest, currentVersion) <= 0) {
        status = { ...status, state: 'idle', readyVersion: '' };
        return getStatus();
      }
      if (badVersions().includes(latest) && !manual) {
        status = { ...status, state: 'error', error: `${latest} 上次安装后启动失败，已退回；可重新运行安装命令手动更新` };
        return getStatus();
      }
      if (detach && !isPrepared(latest)) {
        detached = true;
        status = { ...status, state: 'downloading', latest, error: '', readyVersion: '', progress: { received: 0, total: 0, percent: null } };
        prepare(latest)
          .then(() => { status = { ...status, state: 'ready', readyVersion: latest, error: '', progress: null }; })
          .catch((err) => {
            status = { ...status, state: err.needsInstaller ? 'needs-installer' : 'error', error: err.message, progress: null };
            log('下载失败:', err.message);
          })
          .finally(() => { busy = false; });
        return getStatus();
      }
      await prepare(latest);
      status = { ...status, state: 'ready', readyVersion: latest, error: '', progress: null };
      return getStatus();
    } catch (err) {
      status = { ...status, state: err.needsInstaller ? 'needs-installer' : 'error', error: err.message, progress: null };
      log('检查 / 下载失败:', err.message);
      return getStatus();
    } finally {
      if (!detached) busy = false;
    }
  }

  /** 后台是否空闲（可以重启） */
  function isIdle() {
    if (Date.now() - lastActivity < IDLE_MS) return false;
    const d = now();
    const minutesOfDay = d.getHours() * 60 + d.getMinutes();
    return !scheduleHours(d).some(h => minutesOfDay >= h * 60 - 2 && minutesOfDay < h * 60 + QUIET_MINUTES);
  }

  /** 切换到已下载好的版本并重启后台 */
  function apply() {
    const version = status.readyVersion;
    if (!installed || !version) return false;
    const dir = join(waHome, 'versions', version);
    if (!existsSync(join(dir, 'src', 'index.js'))) {
      status = { ...status, state: 'idle', readyVersion: '' };
      return false;
    }
    log(`安装 ${version}（当前 ${currentVersion}）`);

    // 1. 新扩展先完整复制到旁边（不影响正在用的）
    const ext = join(waHome, 'extension');
    rmSync(`${ext}.next`, { recursive: true, force: true });
    rmSync(`${ext}.old`, { recursive: true, force: true });
    copyDir(join(dir, 'extension'), `${ext}.next`);

    // 2. 切换版本：从这里起即使中途出错，launchd / 守护进程也会按新版本拉起，启动自检兜底
    writeFileSync(join(waHome, 'previous.txt'), `${currentVersion}\n`);
    writeFileSync(join(waHome, 'current.txt'), `${version}\n`);
    writeFileSync(pendingFile, `${version} 0\n`);
    saveSettings({ lastUpdate: { from: currentVersion, to: version, at: now().toISOString() } });

    // 3. 扩展整体换掉（浏览器读到的始终是完整的一份）
    try {
      if (existsSync(ext)) renameSync(ext, `${ext}.old`);
      renameSync(`${ext}.next`, ext);
    } catch (err) {
      // Windows 上目录里有文件正被占用（浏览器、资源管理器）时不能改名：就地覆盖
      log(`扩展目录不能整体替换（${err.code || err.message}），改为就地覆盖`);
      if (!existsSync(ext) && existsSync(`${ext}.old`)) renameSync(`${ext}.old`, ext);
      for (const name of readdirSync(ext)) rmSync(join(ext, name), { recursive: true, force: true });
      copyDir(`${ext}.next`, ext);
      rmSync(`${ext}.next`, { recursive: true, force: true });
    }
    rmSync(`${ext}.old`, { recursive: true, force: true });

    // 4. 固定入口（Mac：workassistant-run、native-host；Windows：workassistant.vbs、supervisor.cjs、native-host.cmd/.cjs）
    const binSrc = join(dir, 'scripts', 'bin');
    for (const name of existsSync(binSrc) ? readdirSync(binSrc) : []) {
      const dst = join(waHome, 'bin', name);
      copyFileSync(join(binSrc, name), `${dst}.next`);
      chmodSync(`${dst}.next`, 0o755);
      renameSync(`${dst}.next`, dst);
    }

    // 只保留新版本和当前（即将成为上一个）版本
    for (const v of readdirSync(join(waHome, 'versions'))) {
      if (v !== version && v !== currentVersion) rmSync(join(waHome, 'versions', v), { recursive: true, force: true });
    }

    status = { ...status, state: 'restarting' };
    restartImpl({ waHome });
    return true;
  }

  function tryApply() {
    if (status.state !== 'ready' || badVersions().includes(status.readyVersion)) return;
    if (loadSettings().auto && isIdle()) apply();
  }

  /** 新版本启动成功：撑过 30 秒就删掉 update-pending（否则启动脚本会认为启动失败） */
  function markHealthy() {
    if (!installed || !existsSync(pendingFile)) return;
    const t = setTimeout(() => {
      const [v] = readText(pendingFile).split(/\s+/);
      if (v === currentVersion) {
        try { unlinkSync(pendingFile); } catch { /* 已被删掉 */ }
        log(`${currentVersion} 运行正常`);
      }
    }, opts.healthyAfterMs ?? HEALTHY_AFTER_MS);
    t.unref?.();
    timers.push(t);
  }

  function start() {
    if (!installed) return;
    markHealthy();
    const first = setTimeout(async () => {
      if (loadSettings().auto) await check();
      tryApply();
    }, opts.checkDelayMs ?? CHECK_DELAY_MS);
    const every = setInterval(async () => {
      if (loadSettings().auto) await check();
      tryApply();
    }, CHECK_INTERVAL_MS);
    const applyLoop = setInterval(tryApply, APPLY_RETRY_MS);
    for (const t of [first, every, applyLoop]) { t.unref?.(); timers.push(t); }
  }

  function stop() {
    timers.forEach(t => clearTimeout(t));
    timers = [];
  }

  return {
    installed,
    getStatus,
    check,
    apply,
    start,
    stop,
    markHealthy,
    isIdle,
    tryApply,
    setAuto: (auto) => { saveSettings({ auto: !!auto }); return getStatus(); },
    touch: () => { lastActivity = Date.now(); },
    _setLastActivity: (t) => { lastActivity = t; }
  };
}

/**
 * 重启后台：由 launchd（Mac）或守护进程（Windows，bin/supervisor.cjs）拉起的进程以 75 退出，
 * 它们会马上按新的 current.txt 重新拉起；
 * 其他方式启动的，先拉起一个新进程（新进程会等端口空出来后再监听），再退出自己。
 */
function defaultRestart({ waHome }) {
  setTimeout(() => {
    if (['launchd', 'supervisor'].includes(process.env.WORKASSISTANT_LAUNCHED_BY)) process.exit(75);
    if (process.platform === 'win32') {
      // Windows 上统一交给守护进程（它会等端口空出来）
      spawn('wscript.exe', [join(waHome, 'bin', 'workassistant.vbs')], {
        detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, WA_RESTART_WAIT_PORT: '1' }
      }).unref();
      setTimeout(() => process.exit(0), 300);
      return;
    }
    try {
      const logFile = process.env.WORKASSISTANT_LOG_FILE;
      const fd = logFile ? openSync(logFile, 'a', 0o600) : 'ignore';
      spawn(join(waHome, 'bin', 'workassistant-run'), [], {
        detached: true,
        stdio: ['ignore', fd, fd],
        env: { ...process.env, WA_RESTART_WAIT_PORT: '1' }
      }).unref();
    } catch (err) {
      console.error('[Update] 重启失败:', err.message);
    }
    process.exit(0);
  }, 500);
}

/** 后台进程里用的那一个 */
let instance = null;
export function getUpdater(opts) {
  if (!instance) instance = createUpdater(opts);
  return instance;
}
