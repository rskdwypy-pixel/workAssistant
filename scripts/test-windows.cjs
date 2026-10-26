/**
 * Windows 实机测试（在 GitHub Actions 的 Windows 虚拟机上运行，见 .github/workflows/windows-test.yml）
 *
 *   node scripts/test-windows.cjs <安装包目录>
 *     <安装包目录>/base/workassistant.tar.gz(.sha256)   当前版本
 *     <安装包目录>/v99.0.0/workassistant.tar.gz(.sha256/.sig)  更新用的新版本（真实签名）
 *     <安装包目录>/v99.0.1/…  装上就启动失败的版本（测回滚）
 *
 * 覆盖：安装（路径含中文和空格）、开机自启与浏览器宿主注册、宿主协议（后台在跑 / 没在跑）、
 * 后台崩溃后守护进程拉起、自动更新、更新后启动失败自动回滚、设置里的开机自启开关、卸载。
 * 会改当前用户的注册表（启动项、浏览器宿主），只适合在一次性的虚拟机里运行。
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

if (process.platform !== 'win32') {
  console.log('只在 Windows 上运行');
  process.exit(0);
}

const ROOT = path.join(__dirname, '..');
const PKGS = path.resolve(process.argv[2] || 'dist-test');
const WA_HOME = path.join(process.env.SystemDrive || 'C:', '工作 助手测试', 'WorkAssistant');
const PORT = 3721;
const RUN_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const HOST_KEYS = ['HKCU:\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.workassistant.backend', 'HKCU:\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.workassistant.backend'];

let passed = 0, failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail ? `\n    ${String(detail).slice(0, 1500).replace(/\n/g, '\n    ')}` : ''}`); }
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const read = (f) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return ''; } };
// 日志末尾（去掉测试自己轮询 /health 的记录）
const logTail = () => read(path.join(WA_HOME, 'logs', 'backend.log')).split('\n')
  .filter(l => !/GET \/health|\[ExecutionManager\]/.test(l)).slice(-40).join('\n');

function request(method, p, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    // agent: false 不复用连接：Node 22 默认保持连接，后台被重启后复用旧连接会直接失败
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, timeout: 120000, agent: false, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      let s = '';
      res.on('data', d => { s += d; });
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    if (data) req.write(data);
    req.end();
  });
}
const health = () => request('GET', '/health');
async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  return null;
}
const waitVersion = (v, ms = 60000) => waitFor(async () => { const h = await health(); return h && h.version === v ? h : null; }, ms);
const waitDown = (ms = 30000) => waitFor(async () => !(await health()), ms);

// 测试步骤本身跑在 PowerShell 7 里：调 Windows PowerShell 5.1 前去掉继承来的 PSModulePath，否则自带命令加载不上
function psEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.PSModulePath;
  return env;
}

// PowerShell 5.1 和 reg.exe 被重定向时按系统代码页输出，路径里的中文会变成问号：一律让 PowerShell 以 UTF-8 输出
function ps(script, env) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${script}`], { encoding: 'utf8', env: psEnv(env), timeout: 15 * 60 * 1000 });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, stdout: r.stdout || '' };
}

/** 读注册表的字符串值（name 省略 = 默认值）；不存在返回 null */
function regQuery(key, name) {
  const r = ps(`$k = Get-Item -LiteralPath $env:K -ErrorAction SilentlyContinue; if ($k) { $v = $k.GetValue($env:N); if ($v -ne $null) { [Console]::Out.Write('=' + $v) } }`, { K: key, N: name || '' });
  return r.stdout.startsWith('=') ? r.stdout.slice(1) : null;
}

function installer(args) {
  const quoted = args.map(a => (a.startsWith('-') ? a : `'${a.replace(/'/g, "''")}'`)).join(' ');
  // 临时目录也放到含中文的路径下：模拟中文用户名（C:\Users\张三\AppData\Local\Temp）
  const tmp = path.join(path.dirname(WA_HOME), '临时 目录');
  fs.mkdirSync(tmp, { recursive: true });
  return ps(`& '${path.join(ROOT, 'installer', 'install.ps1')}' ${quoted}; exit $LASTEXITCODE`, { WA_HOME, TEMP: tmp, TMP: tmp });
}

/** 按 Native Messaging 协议调一次宿主：发一条消息，读回一条 */
function callHost() {
  return new Promise((resolve) => {
    const p = spawn('cmd.exe', ['/d', '/c', path.join(WA_HOME, 'bin', 'native-host.cmd')], { windowsHide: true });
    const msg = Buffer.from(JSON.stringify({ type: 'launch' }));
    const head = Buffer.alloc(4); head.writeUInt32LE(msg.length, 0);
    p.stdin.end(Buffer.concat([head, msg]));
    let out = Buffer.alloc(0), err = '';
    p.stdout.on('data', d => { out = Buffer.concat([out, d]); });
    p.stderr.on('data', d => { err += d; });
    p.on('exit', (code) => {
      let reply = null;
      if (out.length >= 4) { try { reply = JSON.parse(out.slice(4, 4 + out.readUInt32LE(0)).toString()); } catch { /* 帧不完整 */ } }
      resolve({ code, reply, err, raw: out.toString() });
    });
  });
}

function nodeProcs() {
  const r = ps("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }");
  return r.stdout.split(/\r?\n/).filter(Boolean).map(l => { const [pid, ...rest] = l.split('\t'); return { pid: Number(pid), cmd: rest.join('\t') }; })
    .filter(p => p.cmd.includes(WA_HOME));
}

/** 停掉守护进程和后台，再用指定的环境变量直接拉起守护进程（测自动更新时要把下载地址指到本地） */
async function restartSupervisor(env) {
  for (const p of nodeProcs().filter(p => p.cmd.includes('supervisor.cjs'))) spawnSync('taskkill', ['/F', '/PID', String(p.pid)]);
  for (const p of nodeProcs()) spawnSync('taskkill', ['/F', '/PID', String(p.pid)]);
  await waitDown();
  fs.rmSync(path.join(WA_HOME, 'supervisor.pid'), { force: true });
  spawn(path.join(WA_HOME, 'runtime', 'node', 'node.exe'), [path.join(WA_HOME, 'bin', 'supervisor.cjs')], {
    cwd: WA_HOME, detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ...env }
  }).unref();
}

(async () => {
  const baseVersion = read(path.join(PKGS, 'base', 'VERSION'));
  console.log(`\n🪟 Windows 安装（${WA_HOME}，版本 ${baseVersion}）`);
  fs.rmSync(path.dirname(WA_HOME), { recursive: true, force: true });

  // ===== 安装 =====
  let r = installer(['-Package', path.join(PKGS, 'base', 'workassistant.tar.gz')]);
  check('安装成功，后台以新版本运行', r.status === 0 && /安装完成/.test(r.out) && (await health() || {}).version === baseVersion, r.out.slice(-3000) + '\n' + logTail());
  check('目录结构：runtime / versions / bin / extension / data / logs / current.txt',
    ['runtime\\node\\node.exe', `versions\\${baseVersion}\\src\\index.js`, 'bin\\supervisor.cjs', 'bin\\workassistant.vbs', 'bin\\native-host.cmd', 'extension\\manifest.json', 'data', 'logs\\backend.log'].every(f => fs.existsSync(path.join(WA_HOME, f))) &&
    read(path.join(WA_HOME, 'current.txt')) === baseVersion);
  check('current.txt 不带 BOM（Node 读版本号不出错）', fs.readFileSync(path.join(WA_HOME, 'current.txt'))[0] !== 0xef);
  const runValue = regQuery(RUN_KEY, 'WorkAssistant');
  check('开机自启：当前用户的启动项指向 bin\\workassistant.vbs', runValue === `wscript.exe "${path.join(WA_HOME, 'bin', 'workassistant.vbs')}"`, runValue);
  const manifestPath = regQuery(HOST_KEYS[0]);
  let hostManifest = null;
  try { hostManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* 下面报错 */ }
  check('浏览器宿主：Chrome / Edge 都已注册，清单指向 native-host.cmd、只允许固定扩展 ID',
    hostManifest && regQuery(HOST_KEYS[1]) === manifestPath && hostManifest.path === path.join(WA_HOME, 'bin', 'native-host.cmd') &&
    JSON.stringify(hostManifest.allowed_origins) === '["chrome-extension://eoabdnjlihliplmaopdfkmmghmhfeefc/"]', `${manifestPath}\n${JSON.stringify(hostManifest)}`);
  const status = await request('GET', '/api/admin/status');
  check('服务状态：由守护进程拉起，开机自启已开启', status && status.data.launchedBy === 'supervisor' && status.data.platform === 'win32' && status.data.launchAgentInstalled === true, JSON.stringify(status));

  // ===== 浏览器宿主 =====
  console.log('\n🔌 浏览器宿主');
  let host = await callHost();
  check('后台在跑：回报 ready（复用）', host.reply && host.reply.type === 'ready' && host.reply.reused === true, JSON.stringify(host));
  const shut = await request('POST', '/api/admin/shutdown', {});
  check('设置里「停止服务」：后台和守护进程都退出', shut && shut.success && await waitDown() && await waitFor(async () => nodeProcs().length === 0, 15000), JSON.stringify(nodeProcs()));
  host = await callHost();
  check('后台没在跑：拉起守护进程，就绪后回报 ready', host.reply && host.reply.type === 'ready' && host.reply.startedBy === 'supervisor' && (await health() || {}).version === baseVersion, JSON.stringify(host) + '\n' + logTail());
  await sleep(3000);
  check('宿主退出后后台仍在运行（不随宿主 / 浏览器退出）', !!(await health()));

  // ===== 崩溃后拉起 =====
  console.log('\n🧯 崩溃后拉起');
  const before = await health();
  spawnSync('taskkill', ['/F', '/PID', String(before.pid)]);
  const after = await waitFor(async () => { const h = await health(); return h && h.pid !== before.pid ? h : null; }, 40000);
  check('后台被结束：守护进程重新拉起', !!after, logTail());

  // ===== 开机自启开关 =====
  console.log('\n⚙️  开机自启开关');
  let a = await request('POST', '/api/admin/autostart', { enabled: false });
  check('关闭：启动项被删除', a && a.success && a.installed === false && regQuery(RUN_KEY, 'WorkAssistant') === null, JSON.stringify(a));
  a = await request('POST', '/api/admin/autostart', { enabled: true });
  check('开启：启动项恢复（与安装器写的一致）', a && a.success && regQuery(RUN_KEY, 'WorkAssistant') === runValue, JSON.stringify(a) + '\n' + regQuery(RUN_KEY, 'WorkAssistant'));

  // ===== 系统通知 =====
  const { WIN_TOAST_SCRIPT } = await import(require('url').pathToFileURL(path.join(ROOT, 'src', 'utils', 'winToast.js')).href);
  const toast = ps(WIN_TOAST_SCRIPT, { WA_NOTIFY_TITLE: '禅道助手测试', WA_NOTIFY_MESSAGE: '通知内容 "带引号" 与 $(whoami)' });
  console.log(`  · 系统通知脚本：${toast.status === 0 ? '执行成功' : `执行失败（虚拟机没有桌面会话时属正常）：${toast.out.trim().split('\n')[0]}`}`);

  // ===== 自动更新 =====
  console.log('\n🔄 自动更新');
  let latest = 'v99.0.0';
  const server = http.createServer((req, res) => {
    if (req.url === '/releases/latest') { res.writeHead(302, { Location: `/releases/tag/${latest}` }); return res.end(); }
    if (req.url.startsWith('/releases/tag/')) { res.writeHead(200); return res.end('ok'); }
    const m = req.url.match(/^\/releases\/download\/(v[\d.]+)\/(.+)$/);
    const f = m && path.join(PKGS, m[1], m[2]);
    if (!f || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200); fs.createReadStream(f).pipe(res);
  });
  await new Promise(r => server.listen(8798, '127.0.0.1', r));
  await restartSupervisor({ WA_UPDATE_URL: 'http://127.0.0.1:8798/releases' });
  check('守护进程（带测试下载地址）拉起后台', !!(await waitVersion(baseVersion)), logTail());
  // 检查更新发现新版本就立刻返回（state=downloading），下载在后台进行：轮询状态等它就绪（界面的进度条也是这么读的）
  const checkUntilDone = async () => {
    let r = await request('POST', '/api/update/check', {});
    const t0 = Date.now();
    while (r && r.data && r.data.state === 'downloading' && Date.now() - t0 < 180000) {
      await sleep(500);
      r = await request('GET', '/api/update/status');
    }
    return r;
  };
  let s = await checkUntilDone();
  check('检查：下载、校验签名后就绪', s && s.data.state === 'ready' && s.data.readyVersion === '99.0.0', JSON.stringify(s) + '\n' + logTail());
  let applied = await request('POST', '/api/update/apply', {});
  check('安装：后台以 75 退出，守护进程按新版本拉起', !!(await waitVersion('99.0.0')), JSON.stringify(applied) + '\n' + logTail());
  check('安装：current / previous、扩展目录、固定入口都已切换',
    read(path.join(WA_HOME, 'current.txt')) === '99.0.0' && read(path.join(WA_HOME, 'previous.txt')) === baseVersion &&
    JSON.parse(read(path.join(WA_HOME, 'extension', 'manifest.json'))).version === '99.0.0');
  check('启动自检：新版本运行 30 秒后清掉标记', !!(await waitFor(async () => !fs.existsSync(path.join(WA_HOME, 'update-pending')), 60000)));

  latest = 'v99.0.1';
  s = await checkUntilDone();
  check('坏版本：同样能下载', s && s.data.state === 'ready' && s.data.readyVersion === '99.0.1', JSON.stringify(s));
  applied = await request('POST', '/api/update/apply', {});
  const back = await waitFor(async () => {
    const h = await health();
    return h && h.version === '99.0.0' && read(path.join(WA_HOME, 'update-bad.txt')) === '99.0.1' ? h : null;
  }, 120000);
  check('坏版本连续 3 次启动失败：自动退回上一个版本，记进 update-bad.txt', !!back && read(path.join(WA_HOME, 'current.txt')) === '99.0.0' &&
    JSON.parse(read(path.join(WA_HOME, 'extension', 'manifest.json'))).version === '99.0.0', JSON.stringify(applied) + '\n' + logTail());
  server.close();

  // ===== 重新安装（升级覆盖）=====
  console.log('\n♻️  重新安装与卸载');
  const LOG = path.join(WA_HOME, 'logs', 'backend.log');
  fs.appendFileSync(LOG, `=== 重新安装开始 ${new Date().toISOString()} ===\n`);
  r = installer(['-Package', path.join(PKGS, 'base', 'workassistant.tar.gz')]);
  const reH = await health();
  check('重新运行安装命令：停掉正在运行的版本，装回安装包的版本', r.status === 0 && (reH || {}).version === baseVersion && nodeProcs().filter(p => p.cmd.includes('supervisor.cjs')).length === 1,
    `exit=${r.status} health=${JSON.stringify(reH)} 15 秒后=${JSON.stringify(await (async () => { await sleep(15000); return health(); })())}\n${JSON.stringify(nodeProcs())}\n安装器结束于 ${new Date().toISOString()}\n${read(LOG).split('=== 重新安装开始').pop().split('\n').filter(l => !/\[ExecutionManager\]|[╔╚║╠]/.test(l)).slice(0, 80).join('\n')}`);

  // ===== 卸载 =====
  fs.writeFileSync(path.join(WA_HOME, 'data', 'keep.txt'), 'x');
  r = installer(['-Uninstall']);
  check('卸载：停掉后台，移除启动项和宿主注册，保留数据',
    r.status === 0 && await waitDown(5000) && nodeProcs().length === 0 && regQuery(RUN_KEY, 'WorkAssistant') === null && regQuery(HOST_KEYS[0]) === null &&
    fs.existsSync(path.join(WA_HOME, 'data', 'keep.txt')) && !fs.existsSync(path.join(WA_HOME, 'versions')), r.out.slice(-1500));
  r = installer(['-Uninstall', '-Purge']);
  check('卸载 -Purge：连数据一起删', r.status === 0 && !fs.existsSync(WA_HOME), r.out.slice(-800));

  console.log(`\n${passed}/${passed + failed} 通过`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); console.log(logTail()); process.exit(1); });
