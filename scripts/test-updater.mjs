#!/usr/bin/env node
/**
 * 自动更新测试：本地假的 GitHub Releases + 测试用签名密钥，在临时目录里模拟安装目录
 *   检查 / 下载 / 校验（哈希、签名、Node 版本）/ 空闲判断 / 安装切换 / 启动自检与回滚（真实运行 bin/workassistant-run）
 */
import { execFileSync, spawnSync } from 'child_process';
import { createHash, generateKeyPairSync, sign } from 'crypto';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createUpdater, compareVersions } from '../src/services/updater.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0;
const check = (name, ok, detail) => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name}${detail ? `\n    ${String(detail).slice(0, 600)}` : ''}`); }
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-updater-'));
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const other = generateKeyPairSync('ed25519').privateKey;

/** 做一个假的版本目录（安装包里的那个目录） */
function makeVersionDir(dir, version, { node = '18.0.0', exitCode } = {}) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'extension'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.wa-package'), JSON.stringify({ app: 'workassistant', version, node }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'work-assistant', version }));
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), exitCode !== undefined ? `process.exit(${exitCode})` : `console.log('running ${version}')`);
  fs.writeFileSync(path.join(dir, 'extension', 'manifest.json'), JSON.stringify({ version }));
  for (const f of ['workassistant-run', 'native-host']) fs.copyFileSync(path.join(ROOT, 'scripts', 'bin', f), path.join(dir, 'scripts', 'bin', f));
}

/** 发布目录：<tag>/workassistant.tar.gz(.sha256/.sig) */
const RELEASES = path.join(TMP, 'releases');
function publish(version, { node, sigKey = privateKey, noSig = false, badSha = false } = {}) {
  const stage = path.join(TMP, 'stage', version);
  fs.rmSync(stage, { recursive: true, force: true });
  makeVersionDir(path.join(stage, `workassistant-${version}`), version, { node });
  const out = path.join(RELEASES, `v${version}`);
  fs.mkdirSync(out, { recursive: true });
  const tgz = path.join(out, 'workassistant.tar.gz');
  execFileSync('tar', ['-czf', tgz, '-C', stage, `workassistant-${version}`]);
  const data = fs.readFileSync(tgz);
  const sha = badSha ? '0'.repeat(64) : createHash('sha256').update(data).digest('hex');
  fs.writeFileSync(`${tgz}.sha256`, `${sha}  workassistant.tar.gz\n`);
  fs.rmSync(`${tgz}.sig`, { force: true });
  if (!noSig) fs.writeFileSync(`${tgz}.sig`, sign(null, data, sigKey).toString('base64'));
}

let latestTag = 'v1.1.0';
const server = http.createServer((req, res) => {
  if (req.url === '/releases/latest') {
    res.writeHead(302, { Location: `/releases/tag/${latestTag}` });
    return res.end();
  }
  if (req.url.startsWith('/releases/tag/')) { res.writeHead(200); return res.end('release page'); }
  const m = req.url.match(/^\/releases\/download\/(v[\d.]+)\/(.+)$/);
  const file = m && path.join(RELEASES, m[1], m[2]);
  if (!file || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200);
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/releases`;

/** 一个安装目录：当前版本 1.0.0 */
function makeHome(name) {
  const home = path.join(TMP, name);
  makeVersionDir(path.join(home, 'versions', '1.0.0'), '1.0.0');
  makeVersionDir(path.join(home, 'versions', '0.9.0'), '0.9.0');
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(home, 'data'), { recursive: true });
  fs.cpSync(path.join(home, 'versions', '1.0.0', 'extension'), path.join(home, 'extension'), { recursive: true });
  fs.writeFileSync(path.join(home, 'current.txt'), '1.0.0\n');
  fs.writeFileSync(path.join(home, 'previous.txt'), '0.9.0\n');
  return home;
}

function updaterFor(home, extra = {}) {
  const restarts = [];
  const u = createUpdater({
    root: path.join(home, 'versions', '1.0.0'),
    waHome: home,
    dataDir: path.join(home, 'data'),
    baseUrl: BASE,
    publicKey: PUB,
    restart: (a) => restarts.push(a),
    log: () => {},
    ...extra
  });
  return { u, restarts };
}
const read = (f) => fs.readFileSync(f, 'utf8').trim();

try {
  console.log('\n🔄 自动更新');
  check('版本比较', compareVersions('1.10.0', '1.9.9') > 0 && compareVersions('1.1.3', '1.1.3') === 0 && compareVersions('1.1.3', '1.2.0') < 0);

  // 开发版
  const dev = createUpdater({ root: ROOT, waHome: '', dataDir: path.join(TMP, 'devdata'), baseUrl: BASE, log: () => {} });
  const devStatus = await dev.check();
  check('开发版（在仓库里运行）：不检查、不更新', !dev.installed && devStatus.state === 'dev');

  // 正常流程
  publish('1.1.0');
  let home = makeHome('h1');
  let { u, restarts } = updaterFor(home);
  let s = await u.check();
  check('检查：发现新版本，下载、校验后解压到 versions/1.1.0', s.state === 'ready' && s.readyVersion === '1.1.0' && fs.existsSync(path.join(home, 'versions', '1.1.0', 'src', 'index.js')) && !fs.existsSync(path.join(home, 'downloads')), JSON.stringify(s));
  check('检查：记下检查时间', !!JSON.parse(fs.readFileSync(path.join(home, 'data', 'update.json'), 'utf8')).lastCheck);

  u._setLastActivity(Date.now());
  check('空闲判断：3 分钟内有请求不算空闲', !u.isIdle());
  u._setLastActivity(Date.now() - 10 * 60 * 1000);
  check('空闲判断：3 分钟没请求算空闲', u.isIdle());
  const at = (h, mi) => { const d = new Date(); d.setHours(h, mi, 0, 0); return d; };
  const quiet = createUpdater({ root: path.join(home, 'versions', '1.0.0'), waHome: home, dataDir: path.join(home, 'data'), log: () => {}, now: () => at(21, 5), scheduleHours: () => [9, 21] });
  quiet._setLastActivity(0);
  const quiet2 = createUpdater({ root: path.join(home, 'versions', '1.0.0'), waHome: home, dataDir: path.join(home, 'data'), log: () => {}, now: () => at(21, 30), scheduleHours: () => [9, 21] });
  quiet2._setLastActivity(0);
  check('空闲判断：日报时间段（21:00～21:15）不重启，过了就可以', !quiet.isIdle() && quiet2.isIdle());

  check('安装：切换版本并重启后台', u.apply() === true && restarts.length === 1);
  check('安装：current.txt / previous.txt', read(path.join(home, 'current.txt')) === '1.1.0' && read(path.join(home, 'previous.txt')) === '1.0.0');
  check('安装：扩展目录换成新版本（不留中间目录）', JSON.parse(fs.readFileSync(path.join(home, 'extension', 'manifest.json'))).version === '1.1.0' && !fs.existsSync(path.join(home, 'extension.next')) && !fs.existsSync(path.join(home, 'extension.old')));
  const runStat = fs.statSync(path.join(home, 'bin', 'workassistant-run'));
  check('安装：刷新 bin/ 固定入口（可执行）', (runStat.mode & 0o111) !== 0 && fs.existsSync(path.join(home, 'bin', 'native-host')));
  check('安装：写下启动自检标记', read(path.join(home, 'update-pending')) === '1.1.0 0');
  check('安装：只保留新版本和上一个版本', fs.readdirSync(path.join(home, 'versions')).sort().join() === '1.0.0,1.1.0');
  check('安装：记录这次更新（设置页显示）', JSON.parse(fs.readFileSync(path.join(home, 'data', 'update.json'), 'utf8')).lastUpdate.to === '1.1.0');

  // 新版本启动后撑过 30 秒：删掉自检标记
  const after = createUpdater({ root: path.join(home, 'versions', '1.1.0'), waHome: home, dataDir: path.join(home, 'data'), log: () => {}, healthyAfterMs: 20 });
  after.markHealthy();
  await new Promise(r => setTimeout(r, 80));
  check('启动自检：新版本运行正常后删掉标记', !fs.existsSync(path.join(home, 'update-pending')));

  // 已是最新
  latestTag = 'v1.0.0';
  home = makeHome('h2');
  ({ u } = updaterFor(home));
  s = await u.check();
  check('已是最新版本：不下载', s.state === 'idle' && s.latest === '1.0.0' && !fs.existsSync(path.join(home, 'versions', '1.1.0')));

  // 签名不对 / 没有签名 / 哈希不对
  latestTag = 'v1.2.0';
  publish('1.2.0', { sigKey: other });
  home = makeHome('h3');
  ({ u, restarts } = updaterFor(home));
  s = await u.check();
  check('签名不对：拒绝安装', s.state === 'error' && /签名不对/.test(s.error) && !fs.existsSync(path.join(home, 'versions', '1.2.0')) && u.apply() === false && restarts.length === 0, JSON.stringify(s));
  publish('1.2.0', { noSig: true });
  s = await u.check();
  check('没有签名文件：不自动安装', s.state === 'error' && /没有签名/.test(s.error));
  publish('1.2.0', { badSha: true });
  s = await u.check();
  check('哈希不对：拒绝安装', s.state === 'error' && /校验不通过/.test(s.error));

  // 需要更高的 Node
  publish('1.2.0', { node: '99.0.0' });
  s = await u.check();
  check('新版本需要更高的 Node：不装，提示重新运行安装命令', s.state === 'needs-installer' && /重新运行一次安装命令/.test(s.error) && !fs.existsSync(path.join(home, 'versions', '1.2.0')));

  // 启动失败过的版本不再自动装
  publish('1.2.0');
  fs.writeFileSync(path.join(home, 'update-bad.txt'), '1.2.0\n');
  s = await u.check();
  check('上次启动失败退回过的版本：自动检查时跳过', s.state === 'error' && /启动失败/.test(s.error) && !fs.existsSync(path.join(home, 'versions', '1.2.0')));
  s = await u.check({ manual: true });
  check('……手动检查时仍可下载，但标明上次失败过', s.state === 'ready' && s.readyVersion === '1.2.0' && s.readyIsBad === true);
  u._setLastActivity(0);
  u.tryApply();
  check('……空闲时也不自动安装它（只能手动点「立即更新」）', read(path.join(home, 'current.txt')) === '1.0.0' && restarts.length === 0);
  fs.writeFileSync(path.join(home, 'data', 'update.json'), JSON.stringify({ auto: true, lastUpdate: { from: '1.0.0', to: '1.2.0', at: new Date().toISOString() } }));
  check('退回过：状态里标明（设置页提示「已自动退回」）', u.getStatus().rolledBack === true);

  // 关掉自动更新
  u.setAuto(false);
  check('自动更新开关：关掉后记在 data/update.json', u.getStatus().auto === false && JSON.parse(fs.readFileSync(path.join(home, 'data', 'update.json'), 'utf8')).auto === false);

  // ===== bin/workassistant-run：启动自检与回滚（真实运行脚本）=====
  console.log('\n🧯 启动自检与回滚');
  home = path.join(TMP, 'h-run');
  makeVersionDir(path.join(home, 'versions', '1.0.0'), '1.0.0');
  makeVersionDir(path.join(home, 'versions', '1.1.0'), '1.1.0', { exitCode: 1 });
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(home, 'runtime', 'node', 'bin'), { recursive: true });
  fs.symlinkSync(process.execPath, path.join(home, 'runtime', 'node', 'bin', 'node'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'bin', 'workassistant-run'), path.join(home, 'bin', 'workassistant-run'));
  fs.chmodSync(path.join(home, 'bin', 'workassistant-run'), 0o755);
  fs.cpSync(path.join(home, 'versions', '1.1.0', 'extension'), path.join(home, 'extension'), { recursive: true });
  fs.writeFileSync(path.join(home, 'current.txt'), '1.1.0\n');
  fs.writeFileSync(path.join(home, 'previous.txt'), '1.0.0\n');
  fs.writeFileSync(path.join(home, 'update-pending'), '1.1.0 0\n');
  const runOnce = () => spawnSync(path.join(home, 'bin', 'workassistant-run'), [], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
  let r = runOnce();
  check('新版本启动：记一次启动次数，照常运行新版本', r.status === 1 && read(path.join(home, 'update-pending')) === '1.1.0 1', r.stdout + r.stderr);
  runOnce(); runOnce();
  r = runOnce();
  check('连续 3 次没撑过 30 秒：退回上一个版本并运行它', /running 1\.0\.0/.test(r.stdout) && read(path.join(home, 'current.txt')) === '1.0.0' && !fs.existsSync(path.join(home, 'update-pending')), r.stdout + r.stderr);
  check('回滚：扩展目录也退回，失败的版本记进 update-bad.txt', JSON.parse(fs.readFileSync(path.join(home, 'extension', 'manifest.json'))).version === '1.0.0' && read(path.join(home, 'update-bad.txt')) === '1.1.0');
  fs.writeFileSync(path.join(home, 'update-pending'), '1.1.0 2\n');
  r = runOnce();
  check('标记不是当前版本（已被处理过）：删掉标记，正常运行', /running 1\.0\.0/.test(r.stdout) && !fs.existsSync(path.join(home, 'update-pending')));

  // ===== 签名脚本：私钥与代码里的公钥不配对时拒绝 =====
  console.log('\n🔏 发版签名');
  const pkgFile = path.join(RELEASES, 'v1.1.0', 'workassistant.tar.gz');
  r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'sign-package.mjs'), pkgFile], { encoding: 'utf8', env: { ...process.env, WA_SIGNING_KEY: other.export({ type: 'pkcs8', format: 'pem' }) } });
  check('签名脚本：私钥与公钥不配对时拒绝签名', r.status !== 0 && /不匹配/.test(r.stderr), r.stdout + r.stderr);
} finally {
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${passed}/${passed + failed} 通过`);
process.exit(failed ? 1 : 0);
