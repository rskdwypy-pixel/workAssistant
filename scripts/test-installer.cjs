/**
 * 回归测试：Mac 安装器（installer/install-mac.sh）与安装版目录结构
 *
 * 全程在临时目录里：假的 HOME（登录项、浏览器宿主注册写到这里）、假的 launchctl / pbcopy / open，
 * 用本机现成的 node（WA_TEST_NODE，不下载），安装包现场拼出来（node_modules 链接到仓库的）。
 * 不碰真实的登录项、浏览器、剪贴板和正在运行的后台服务。
 *
 * 覆盖：
 *   全新安装 + 从旧仓库目录迁移（先备份、原目录不动）；目录结构、固定入口、扩展目录
 *   升级：保留上一个版本、更早的自动清理、数据不动
 *   完整安装：登录项指向固定入口、浏览器宿主只允许固定扩展 ID、服务启动且版本一致
 *   浏览器宿主：后台在运行时直接复用、不在运行时交给开机自启拉起
 *   卸载：默认保留数据；--purge 全删
 */
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const INSTALLER = path.join(ROOT, 'installer', 'install-mac.sh');
const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });

if (process.platform !== 'darwin') {
  console.log('  （非 macOS，跳过 Mac 安装器测试）\n\n0/0 通过');
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-installer-'));
const WA = path.join(tmp, 'WA');
const HOME = path.join(tmp, 'home');
const SHIM = path.join(tmp, 'shim');
const PORT = String(3790 + Math.floor(Math.random() * 8));
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(SHIM);
const shimLog = path.join(tmp, 'shim.log');
const shimState = path.join(tmp, 'shim.loaded');

// 假 launchctl：bootstrap 时按登录项里的入口把服务拉起来（模拟 launchd），bootout 时停掉
fs.writeFileSync(path.join(SHIM, 'launchctl'), `#!/bin/bash
echo "launchctl $*" >> "${shimLog}"
case "$1" in
  print) [[ -f "${shimState}" ]] && exit 0 || exit 1 ;;
  bootstrap) prog="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$3")"; touch "${shimState}"; (PORT=${PORT} "$prog" >> "${shimLog}.run" 2>&1 &) ; exit 0 ;;
  bootout) rm -f "${shimState}"; pid=$(lsof -ti tcp:${PORT}); [[ -n "$pid" ]] && kill $pid; exit 0 ;;
  *) exit 0 ;;
esac
`);
fs.writeFileSync(path.join(SHIM, 'pbcopy'), '#!/bin/bash\ncat > /dev/null\n');
fs.writeFileSync(path.join(SHIM, 'open'), `#!/bin/bash\necho "open $*" >> "${shimLog}"\n`);
for (const f of fs.readdirSync(SHIM)) fs.chmodSync(path.join(SHIM, f), 0o755);

const env = { ...process.env, HOME, WA_HOME: WA, WA_TEST_NODE: process.execPath, WORKASSISTANT_PORT: PORT, PATH: `${SHIM}:${process.env.PATH}` };
const install = (...args) => spawnSync('bash', [INSTALLER, ...args], { env, encoding: 'utf8', timeout: 90000 });
const plain = (r) => `${r.stdout || ''}${r.stderr || ''}`.replace(/\x1b\[[0-9;]*m/g, '');
const health = () => {
  const r = spawnSync('curl', ['-s', '-m', '2', `http://127.0.0.1:${PORT}/health`], { encoding: 'utf8' });
  try { return JSON.parse(r.stdout); } catch { return null; }
};

// 现场拼安装包（与 build-package.mjs 的内容一致，只是 node_modules 链接到仓库的，不跑 npm ci）
function makePackage(version) {
  const stage = path.join(tmp, `stage-${version}`);
  const dir = path.join(stage, `workassistant-${version}`);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  for (const d of ['src', 'extension']) fs.cpSync(path.join(ROOT, d), path.join(dir, d), { recursive: true });
  for (const f of ['common.sh', 'backend-launcher.sh', 'install-launchagent.sh', 'uninstall-launchagent.sh', 'install-native-host.sh', 'uninstall-native-host.sh']) {
    fs.cpSync(path.join(ROOT, 'scripts', f), path.join(dir, 'scripts', f));
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ ...pkg, version }, null, 2));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, '.wa-package'), JSON.stringify({ app: 'workassistant', version }));
  const tarball = path.join(tmp, `workassistant-${version}.tar.gz`);
  execFileSync('tar', ['-czf', tarball, '-C', stage, `workassistant-${version}`]);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
  fs.writeFileSync(`${tarball}.sha256`, `${sha}  workassistant-${version}.tar.gz\n`);
  return tarball;
}

const fixedId = (() => {
  const key = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8')).key;
  const h = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex').slice(0, 32);
  return [...h].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
})();

try {
  // ============ 全新安装 + 迁移 ============
  const old = path.join(tmp, 'oldrepo');
  fs.mkdirSync(path.join(old, 'data'), { recursive: true });
  fs.mkdirSync(path.join(old, 'src'));
  fs.writeFileSync(path.join(old, 'src', 'index.js'), '');
  fs.writeFileSync(path.join(old, '.env'), 'ZENTAO_URL=http://old:1\nOPENAI_API_KEY=sk-old\n');
  fs.writeFileSync(path.join(old, 'data', 'tasks.json'), JSON.stringify({ tasks: [{ id: 't1', title: '旧任务' }] }));
  const p110 = makePackage('1.1.0');
  let r = install('--no-service', '--package', p110, '--migrate-from', old);
  check('全新安装成功', r.status === 0 && /安装完成：工作助手 1.1.0/.test(plain(r)), plain(r).slice(-600));
  check('目录结构：runtime / versions / bin / extension / data / backups / current.txt',
    ['runtime/node/bin/node', 'versions/1.1.0/src/index.js', 'bin/workassistant-run', 'bin/native-host', 'extension/manifest.json', 'data', 'backups'].every(p => fs.existsSync(path.join(WA, p))) &&
    fs.readFileSync(path.join(WA, 'current.txt'), 'utf8').trim() === '1.1.0');
  check('迁移：配置和数据搬到 data/，权限只有自己可读', fs.readFileSync(path.join(WA, 'data', '.env'), 'utf8').includes('ZENTAO_URL=http://old:1') &&
    /旧任务/.test(fs.readFileSync(path.join(WA, 'data', 'tasks.json'), 'utf8')) && (fs.statSync(path.join(WA, 'data')).mode & 0o777) === 0o700 && (fs.statSync(path.join(WA, 'data', '.env')).mode & 0o777) === 0o600);
  const backups = fs.readdirSync(path.join(WA, 'backups'));
  check('迁移前先完整备份，原目录不动', backups.length === 1 && /^before-migrate-.*\.tar\.gz$/.test(backups[0]) && fs.existsSync(path.join(old, '.env')) &&
    /\.env/.test(execFileSync('tar', ['-tzf', path.join(WA, 'backups', backups[0])], { encoding: 'utf8' })));
  check('--no-service：不注册登录项、不改剪贴板', !fs.existsSync(path.join(HOME, 'Library', 'LaunchAgents')) && !fs.existsSync(shimLog));

  r = install('--no-service', '--package', p110 + '.missing');
  check('安装包不存在：报错退出', r.status !== 0);
  const bad = path.join(tmp, 'bad.tar.gz');
  fs.copyFileSync(p110, bad);
  fs.writeFileSync(`${bad}.sha256`, `${'0'.repeat(64)}  bad.tar.gz\n`);
  r = install('--no-service', '--package', bad);
  check('安装包校验不通过：拒绝安装，当前版本不变', r.status !== 0 && /校验不通过/.test(plain(r)) && fs.readFileSync(path.join(WA, 'current.txt'), 'utf8').trim() === '1.1.0');

  // ============ 升级 ============
  fs.writeFileSync(path.join(WA, 'data', 'tasks.json'), JSON.stringify({ tasks: [{ id: 't1', title: '旧任务' }, { id: 't2', title: '升级前新增' }] }));
  install('--no-service', '--package', makePackage('1.1.1'));
  check('升级：当前 1.1.1，保留 1.1.0 可回滚', fs.readFileSync(path.join(WA, 'current.txt'), 'utf8').trim() === '1.1.1' && fs.readFileSync(path.join(WA, 'previous.txt'), 'utf8').trim() === '1.1.0');
  r = install('--no-service', '--package', makePackage('1.1.2'));
  check('再升级：只保留当前和上一个版本', fs.readdirSync(path.join(WA, 'versions')).sort().join() === '1.1.1,1.1.2', fs.readdirSync(path.join(WA, 'versions')).join());
  check('升级不碰数据', /升级前新增/.test(fs.readFileSync(path.join(WA, 'data', 'tasks.json'), 'utf8')) && /沿用已有数据/.test(plain(r)));

  // ============ 完整安装（登录项、宿主、启动） ============
  r = install('--package', p110);
  const out = plain(r);
  check('完整安装：服务启动且版本与安装包一致', r.status === 0 && /后台服务已启动（版本 1.1.0）/.test(out) && health() && health().version === '1.1.0', out.slice(-800));
  const plist = path.join(HOME, 'Library', 'LaunchAgents', 'com.workassistant.backend.plist');
  const progArg = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :ProgramArguments:0', plist], { encoding: 'utf8' }).trim();
  check('登录项指向固定入口（切换版本不用改登录项）', progArg === path.join(WA, 'bin', 'workassistant-run'), progArg);
  const hosts = spawnSync('find', [path.join(HOME, 'Library'), '-name', 'com.workassistant.backend.json'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
  const manifests = hosts.map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
  check('浏览器宿主：指向固定入口，只允许固定扩展 ID', manifests.length > 0 && manifests.every(m => m.path === path.join(WA, 'bin', 'native-host') && m.allowed_origins.join() === `chrome-extension://${fixedId}/`), JSON.stringify(manifests));
  check('数据目录：服务读的是 WorkAssistant/data', /旧任务/.test(spawnSync('curl', ['-s', `http://127.0.0.1:${PORT}/api/tasks`, '-H', `Origin: chrome-extension://${fixedId}`], { encoding: 'utf8' }).stdout));

  // 浏览器宿主
  const frame = (buf) => (buf.length >= 4 ? buf.slice(4, 4 + buf.readUInt32LE(0)).toString() : '');
  let h = spawnSync(path.join(WA, 'bin', 'native-host'), [], { env, timeout: 30000 });
  check('浏览器宿主：后台在运行时直接复用', /"type":"ready","reused":true/.test(frame(h.stdout)), frame(h.stdout));
  spawnSync('launchctl', ['bootout', 'x'], { env });
  for (let i = 0; i < 20 && health(); i++) spawnSync('sleep', ['0.25']);
  h = spawnSync(path.join(WA, 'bin', 'native-host'), [], { env, timeout: 30000 });
  check('浏览器宿主：后台不在运行时交给开机自启拉起', /"type":"ready","startedBy":"launchd"/.test(frame(h.stdout)) && health() && health().version === '1.1.0', frame(h.stdout));

  // ============ 卸载 ============
  r = install('--uninstall');
  check('卸载：移除登录项与宿主注册，保留数据', r.status === 0 && !fs.existsSync(plist) &&
    spawnSync('find', [path.join(HOME, 'Library'), '-name', 'com.workassistant.backend.json'], { encoding: 'utf8' }).stdout.trim() === '' &&
    fs.readdirSync(WA).sort().join() === 'backups,data' && !health());
  r = install('--uninstall', '--purge');
  check('卸载 --purge：连数据一起删', r.status === 0 && !fs.existsSync(WA));
} catch (err) {
  check(`异常：${err.stack}`, false);
} finally {
  const pid = spawnSync('lsof', ['-ti', `tcp:${PORT}`], { encoding: 'utf8' }).stdout.trim();
  if (pid) spawnSync('kill', pid.split('\n'));
  fs.rmSync(tmp, { recursive: true, force: true });
}

for (const x of results) console.log(`  ${x.pass ? '✓' : '✗'} ${x.name}${x.pass || !x.extra ? '' : `   → ${String(x.extra).slice(0, 400)}`}`);
const passed = results.filter(x => x.pass).length;
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
