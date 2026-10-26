/**
 * 回归测试：账号（登录状态、登录 / 切换账号 / 退出、重置为首次使用）
 *
 * 临时 .env（WA_ENV_FILE）+ 临时数据目录 + 模拟禅道（替换 globalThis.fetch），不读写真实配置、不访问网络。
 *
 * 覆盖：
 *   状态：未配置 / 已登录（读个人档案）/ 密码失效 / 连不上（保留上次的用户信息）
 *   登录：先真实登录再保存；账号密码错误、地址不是禅道、连不上分别给出原因且不保存；地址自动规整
 *   切换账号：本地有别人的数据时先确认，确认后清空本地数据；同一账号重新登录不清空
 *   退出：清密码与会话，保留地址与账号
 *   重置：只清配置（本地数据保留）/ 连本地数据一起清；端口等本机项、备份目录保留
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import crypto from 'crypto';
import express from 'express';

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

const tmp = mkdtempSync(join(tmpdir(), 'wa-account-'));
const envFile = join(tmp, '.env');
writeFileSync(envFile, 'PORT=3721\nOPENAI_API_KEY=sk-test\nOPENAI_MODEL=minimax-m3\nREPORT_MEMBERS=a,b\n');
process.env.WA_ENV_FILE = envFile;

// ---------- 模拟禅道 ----------
const zt = { passwords: { zhangs: 'pw-zhang', lisi: 'pw-li' }, offline: false, logins: 0 };
const json = (o, headers = {}) => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json', ...headers } });
const zj = (inner) => json({ status: 'success', data: JSON.stringify(inner) });
const sidOwner = new Map();
let sidSeq = 0;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (zt.offline || url.startsWith('http://10.9.9.9')) throw new TypeError('fetch failed');
  if (url.startsWith('http://not-zentao')) return json({ error: '接口不存在' });
  const cookie = String((init.headers && (init.headers.Cookie || (init.headers.get && init.headers.get('Cookie')))) || '');
  if (url.includes('user-refreshRandom')) return new Response('1234');
  if (url.includes('user-login') && (init.method || 'GET') === 'GET') {
    sidSeq++;
    return new Response('<html></html>', { headers: { 'Set-Cookie': `zentaosid=s${sidSeq}; path=/` } });
  }
  if (url.includes('user-login')) {
    const body = new URLSearchParams(String(init.body));
    const account = body.get('account');
    const pw = zt.passwords[account];
    if (pw && body.get('password') === md5(md5(pw) + '1234')) {
      zt.logins++;
      sidOwner.set((cookie.match(/zentaosid=([^;]+)/) || [])[1], account);
      return json({ result: 'success' }, { 'Set-Cookie': `za=${account}; path=/` });
    }
    return json({ result: 'fail', message: '登录失败，请检查您的用户名或密码是否填写正确。' });
  }
  if (url.includes('my-profile.json')) {
    const sid = (cookie.match(/zentaosid=([^;]+)/) || [])[1];
    const account = sidOwner.get(sid);
    // 会话不认（密码已改等）：禅道跳登录页
    if (!account || !zt.passwords[account]) return new Response('<html><script>location="/zentao/user-login.html"</script></html>', { headers: { 'Content-Type': 'text/html' } });
    const names = { zhangs: '张三', lisi: '李四' };
    return zj({ user: { account, realname: names[account], role: 'qa', email: 'x@y', join: '2023-05-15' }, deptPath: [{ name: '产研部' }] });
  }
  const tv = url.match(/task-view-(\d+)\.json/);
  if (tv && zt.failView) return new Response('boom', { status: 500 });
  if (tv) return Number(tv[1]) >= 900 ? json({ result: 'fail', load: { alert: '抱歉，您访问的对象不存在！', locate: '/zentao/execution-all.json' } }) : zj({ task: { id: tv[1], name: `task-${tv[1]}` } });
  const bv = url.match(/bug-view-(\d+)\.json/);
  if (bv && zt.failView) return new Response('boom', { status: 500 });
  if (bv) return zj({ result: 'fail', message: '抱歉，您访问的对象不存在！' });
  return new Response('not mocked: ' + url, { status: 404 });
};

const { config } = await import('../src/config.js');
config.paths.data = tmp;
config.paths.tasks = join(tmp, 'tasks.json');
config.paths.history = join(tmp, 'history.json');
const acct = await import('../src/services/account.js');
const router = (await import('../src/routes/account.js')).default;
const app = express();
app.use(express.json());
app.use('/api', router);
const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const http = await import('node:http');
// 接口调用不能走被替换的 fetch，用 node:http
const call = (method, path, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : '';
  const req = http.request({ host: '127.0.0.1', port: server.address().port, path: `/api${path}`, method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
    let s = '';
    res.on('data', c => { s += c; });
    res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(s) }));
  });
  req.on('error', reject);
  req.end(data);
});
const env = () => readFileSync(envFile, 'utf8');
const writeTasks = (tasks) => writeFileSync(config.paths.tasks, JSON.stringify({ tasks }));
const readTasksFile = () => JSON.parse(readFileSync(config.paths.tasks, 'utf8')).tasks;
const del = (path) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: server.address().port, path: `/api${path}`, method: 'DELETE' }, (res) => {
    let b = '';
    res.on('data', c => { b += c; });
    res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(b || '{}') }));
  });
  req.on('error', reject);
  req.end();
});

try {
  // ---------- 未配置 ----------
  let r = await call('GET', '/account');
  check('第一次使用：未配置', r.success && r.data.state === 'unconfigured' && !r.data.profile && r.data.aiConfigured === true);

  // ---------- 登录失败：不保存 ----------
  r = await call('POST', '/account/login', { url: 'http://10.0.0.1:8088', username: 'zhangs', password: 'wrong' });
  check('密码错误：给出禅道的原因，不保存', r.status === 400 && r.data.error.kind === 'credentials' && /用户名或密码/.test(r.message) && !/ZENTAO_PASSWORD/.test(env()));
  r = await call('POST', '/account/login', { url: 'http://not-zentao:80', username: 'zhangs', password: 'pw-zhang' });
  check('地址不是禅道：明确提示', r.status === 400 && r.data.error.kind === 'not_zentao' && /不是禅道/.test(r.message));
  r = await call('POST', '/account/login', { url: 'http://10.9.9.9:8088', username: 'zhangs', password: 'pw-zhang' });
  check('连不上：提示检查网络', r.status === 400 && r.data.error.kind === 'offline' && /无法连接|VPN/.test(r.message), r.message);
  r = await call('POST', '/account/login', { url: '', username: 'zhangs', password: 'x' });
  check('漏填：提示填写', r.status === 400 && /请填写禅道地址/.test(r.message));

  // ---------- 登录成功 ----------
  r = await call('POST', '/account/login', { url: '10.0.0.1:8088/zentao/my.html', username: 'zhangs', password: 'pw-zhang' });
  check('登录成功：地址自动规整（补 http、去掉页面路径）并保存', r.success && /ZENTAO_URL=http:\/\/10\.0\.0\.1:8088\n/.test(env()) && /ZENTAO_PASSWORD=pw-zhang/.test(env()) && /ZENTAO_ENABLED=true/.test(env()), env());
  check('登录成功：返回用户信息（姓名、角色、部门）', r.data.state.state === 'ok' && r.data.state.profile.realname === '张三' && r.data.state.profile.roleLabel === '测试' && r.data.state.profile.dept === '产研部');
  check('登录成功：用户信息存到 data/account.json', JSON.parse(readFileSync(join(tmp, 'account.json'), 'utf8')).account === 'zhangs');

  // ---------- 密码失效 / 连不上 ----------
  zt.passwords.zhangs = 'changed-in-zentao';
  acct.invalidateState();
  const { clearCookies } = await import('../src/services/zentaoService.js');
  clearCookies();
  r = await call('GET', '/account?refresh=1');
  check('在禅道里改了密码：登录失效（invalid），仍显示上次的用户信息', r.data.state === 'invalid' && r.data.profile && r.data.profile.realname === '张三', JSON.stringify(r.data));
  zt.passwords.zhangs = 'pw-zhang';
  zt.offline = true;
  clearCookies();
  r = await call('GET', '/account?refresh=1');
  check('连不上禅道：offline（不当成登录失效），仍显示上次的用户信息', r.data.state === 'offline' && r.data.profile && r.data.profile.account === 'zhangs');
  zt.offline = false;
  r = await call('GET', '/account?refresh=1');
  check('恢复连接：回到已登录', r.data.state === 'ok');

  // ---------- 切换账号 ----------
  writeTasks([{ id: 't1', title: '张三的任务', zentaoId: '1' }]);
  writeFileSync(join(tmp, 'reports.json'), '{"reports":{}}');
  r = await call('POST', '/account/login', { url: 'http://10.0.0.1:8088', username: 'lisi', password: 'pw-li' });
  check('换成别的账号且本地有数据：先确认，不保存', r.data.needConfirm && r.data.previous.account === 'zhangs' && r.data.previous.realname === '张三' && /ZENTAO_USERNAME=zhangs/.test(env()) && readTasksFile().length === 1);
  r = await call('POST', '/account/login', { url: 'http://10.0.0.1:8088', username: 'lisi', password: 'wrong' });
  check('换账号但密码错误：报错，不清空数据', r.data.error && r.data.error.kind === 'credentials' && readTasksFile().length === 1);
  r = await call('POST', '/account/login', { url: 'http://10.0.0.1:8088', username: 'lisi', password: 'pw-li', confirmSwitch: true });
  check('确认后：清空本地数据再登录新账号', r.success && r.data.switched && readTasksFile().length === 0 && !existsSync(join(tmp, 'reports.json')) && /ZENTAO_USERNAME=lisi/.test(env()) && r.data.state.profile.realname === '李四');
  writeTasks([{ id: 't2', title: '李四的任务', zentaoId: '2' }]);
  r = await call('POST', '/account/login', { url: 'http://10.0.0.1:8088', username: 'lisi', password: 'pw-li' });
  check('同一账号重新登录：不确认、不清空', r.success && !r.data.switched && readTasksFile().length === 1);

  // ---------- 同一账号换禅道地址（新旧禅道的任务 / Bug 编号会重叠，旧数据不能留）----------
  r = await call('POST', '/account/login', { url: 'http://10.0.0.2:8088', username: 'lisi', password: 'pw-li' });
  check('同账号只换地址且本地有数据：先确认，不保存', r.data.needConfirm && r.data.previous.urlChanged === true && r.data.previous.accountChanged === false && r.data.previous.url === 'http://10.0.0.1:8088' && /ZENTAO_URL=http:\/\/10\.0\.0\.1:8088\n/.test(env()) && readTasksFile().length === 1, JSON.stringify(r.data));
  r = await call('POST', '/account/login', { url: 'http://10.0.0.2:8088', username: 'lisi', password: 'pw-li', confirmSwitch: true });
  check('确认后：旧数据清空并先备份，地址换成新的', r.success && r.data.switched && readTasksFile().length === 0 && /ZENTAO_URL=http:\/\/10\.0\.0\.2:8088\n/.test(env()) && existsSync(join(tmp, 'backups')) && readdirSync(join(tmp, 'backups')).some(f => f.startsWith('tasks__switch-')), String(existsSync(join(tmp, 'backups')) && readdirSync(join(tmp, 'backups'))));
  writeTasks([{ id: 't3', title: '新禅道里的任务', zentaoId: '3' }]);
  r = await call('POST', '/account/login', { url: 'http://10.0.0.2:8088/zentao/', username: 'lisi', password: 'pw-li' });
  check('同账号同地址（多写了 /zentao/）重新登录：不当成换地址', r.success && !r.data.switched && readTasksFile().length === 1);
  // 设置页保存 / 配置导入不经登录弹窗，直接换地址：自动备份并清空，不再询问
  let rc = await acct.reconcileBeforeChange('http://10.0.0.2:8088', 'lisi');
  check('保存的地址和账号没变：不清', rc.cleared === false && readTasksFile().length === 1);
  rc = await acct.reconcileBeforeChange('http://10.0.0.3:8088', 'lisi');
  check('设置页换了地址：自动清空本地旧数据', rc.cleared === true && rc.previous.url === 'http://10.0.0.2:8088' && readTasksFile().length === 0);
  writeTasks([{ id: 't4', title: 'x', zentaoId: '4' }]);
  rc = await acct.reconcileBeforeChange('http://10.0.0.3:8088', 'wangw');
  check('设置页换了账号：同样清空', rc.cleared === true && readTasksFile().length === 0);
  rc = await acct.reconcileBeforeChange('', '');
  check('清空 / 停用配置不算换禅道：不清', rc.cleared === false);
  // 老版本留下的数据没有归属记录：按改动前的配置补记，再比较
  writeTasks([{ id: 't5', title: 'y', zentaoId: '5' }]);
  rmSync(join(tmp, 'data-scope.json'), { force: true });
  rc = await acct.reconcileBeforeChange('http://10.0.0.9:8088', 'lisi');
  check('没有归属记录的老数据：按改动前的地址补记，换了地址就清', rc.cleared === true && readTasksFile().length === 0, JSON.stringify(rc));
  // 已经换过地址、旧数据还留着（没有确切记录）：逐条到当前禅道核对，只清对不上的
  // 模拟的禅道：task-N 的标题是 `task-N`；编号 >= 900 的任务不存在；bug 一律不存在
  const items = [
    { id: 'k1', type: 'task', title: 'task-101', zentaoId: '101' },      // 一致 → 留
    { id: 'k2', type: 'task', title: 'task-102', zentaoId: '102' },      // 一致 → 留
    { id: 'x1', type: 'task', title: '旧禅道的任务', zentaoId: '103' },   // 编号在，标题不同（编号重叠的另一个对象）→ 清
    { id: 'x2', type: 'task', title: '迁移后在旧禅道新建的', zentaoId: '991' }, // 新禅道里不存在 → 清
    { id: 'x3', type: 'bug', title: '旧禅道的 Bug', zentaoId: '5' }       // 不存在 → 清
  ];
  writeTasks(items);
  let pr = await acct.pruneForeignItems();
  check('逐条核对：对得上的留下，标题不同 / 不存在的清掉', pr.checked === 5 && pr.removed === 3 && readTasksFile().map(t => t.id).sort().join() === 'k1,k2', JSON.stringify([pr, readTasksFile().map(t => t.id)]));
  check('清理前备份了 tasks.json（tasks__prune-…）', readdirSync(join(tmp, 'backups')).some(f => f.startsWith('tasks__prune-')));
  pr = await acct.pruneForeignItems();
  check('再核对一次：没有要清的，不动', pr.removed === 0 && readTasksFile().length === 2);
  zt.failView = true;
  writeTasks(items);
  pr = await acct.pruneForeignItems();
  check('核对时查不了（网络 / 会话）：保持不动，不乱删', pr.removed === 0 && readTasksFile().length === 5);
  zt.failView = false;
  // 状态确认时的兜底：没有记录 / 旧版本写下的记录（无核对标记）都要核对，核对后补上标记
  writeTasks(items);
  writeFileSync(join(tmp, 'data-scope.json'), JSON.stringify({ url: config.zentao.url, account: config.zentao.username }));
  await acct.ensureDataScope();
  check('旧版本写下的归属记录（无核对标记）：核对并清掉对不上的，补上标记', readTasksFile().length === 2 && JSON.parse(readFileSync(join(tmp, 'data-scope.json'), 'utf8')).verified === true);
  writeTasks(items);
  await acct.ensureDataScope();
  check('已核对过的归属记录：不再核对（不会反复打禅道）', readTasksFile().length === 5);
  rmSync(join(tmp, 'data-scope.json'), { force: true });
  await acct.ensureDataScope();
  check('完全没有记录的老数据：同样逐条核对', readTasksFile().length === 2);
  rmSync(join(tmp, 'data-scope.json'), { force: true });
  writeTasks([{ id: 'a', type: 'task', title: '旧禅道的任务甲', zentaoId: '1' }, { id: 'b', type: 'task', title: '旧禅道的任务乙', zentaoId: '2' }]);
  r = await call('POST', '/account/login', { url: 'http://10.0.0.1:8088', username: 'lisi', password: 'pw-li', confirmSwitch: true });
  writeTasks([{ id: 't2', title: '李四的任务', zentaoId: '2' }]);

  // ---------- 已保存的账号：快速切换 ----------
  r = await call('GET', '/account/saved');
  let list = r.data.accounts;
  const key = (a) => `${a.username}@${a.url}`;
  check('登录过的账号都被记住（含不同地址的同名账号）', ['zhangs@http://10.0.0.1:8088', 'lisi@http://10.0.0.1:8088', 'lisi@http://10.0.0.2:8088'].every(k => list.some(a => key(a) === k)), JSON.stringify(list.map(key)));
  check('接口里没有密码（任何字段都没有）', !/pw-li|pw-zhang|"password"/i.test(JSON.stringify(r)) && list.every(a => a.hasPassword === true));
  check('当前账号带 current 标记，且只有一个', list.filter(a => a.current).length === 1 && list.find(a => a.current).username === 'lisi' && list.find(a => a.current).url === 'http://10.0.0.1:8088');
  check('按最近使用排序（当前账号刚登录过，排最前）', list[0].current === true && list.every((a, i) => i === 0 || String(list[i - 1].lastUsedAt) >= String(a.lastUsedAt)));
  check('保存了姓名，方便界面显示', list.find(a => a.username === 'zhangs').realname === '张三');
  const n0 = list.length;
  await call('POST', '/account/login', { url: 'HTTP://10.0.0.1:8088/zentao/my.html', username: 'lisi', password: 'pw-li' });
  r = await call('GET', '/account/saved');
  check('同地址同账号重复登录（大小写 / 页面路径不同）只有一条', r.data.accounts.length === n0);
  check('accounts.json 权限只有本人可读写', process.platform === 'win32' || (statSync(join(tmp, 'accounts.json')).mode & 0o777) === 0o600);

  // 切换：目标密码已失效（在禅道里改了）→ 动数据之前就拦下，当前状态不变
  const zhangId = list.find(a => a.username === 'zhangs').id;
  zt.passwords.zhangs = 'changed-in-zentao';
  r = await call('POST', '/account/switch', { id: zhangId });
  check('切换到密码已失效的账号：返回 credentials，当前账号和本地数据都不变', !r.success && r.data.error.kind === 'credentials' && /ZENTAO_USERNAME=lisi/.test(env()) && readTasksFile().length === 1, JSON.stringify(r.data));
  zt.passwords.zhangs = 'pw-zhang';
  zt.offline = true;
  r = await call('POST', '/account/switch', { id: zhangId });
  check('切换时连不上禅道：返回 offline，当前账号和本地数据都不变', !r.success && r.data.error.kind === 'offline' && /ZENTAO_USERNAME=lisi/.test(env()) && readTasksFile().length === 1, JSON.stringify(r.data));
  zt.offline = false;
  r = await call('POST', '/account/switch', { id: 'nope' });
  check('切换到不存在的账号：404', r.status === 404 && r.data.error.kind === 'not_found');

  // 切换：本地内容都已同步到禅道（都有禅道编号）→ 不打断，直接切并先备份
  writeTasks([{ id: 't2', title: '李四的任务', zentaoId: '2' }]);
  const backupsBefore = new Set(existsSync(join(tmp, 'backups')) ? readdirSync(join(tmp, 'backups')) : []);
  r = await call('POST', '/account/switch', { id: zhangId });
  check('本地内容都已同步：不用确认，直接切换并清空', r.success && r.data.switched && !r.data.needConfirm && readTasksFile().length === 0 && /ZENTAO_USERNAME=zhangs/.test(env()) && r.data.state.profile.realname === '张三', JSON.stringify(r.data).slice(0, 200));
  check('切换前备份了 tasks.json（新增一份 tasks__switch-…）', readdirSync(join(tmp, 'backups')).some(f => f.startsWith('tasks__switch-') && !backupsBefore.has(f)));
  r = await call('GET', '/account/saved');
  check('切换后当前账号变了，且排到最前', r.data.accounts[0].username === 'zhangs' && r.data.accounts[0].current);

  // 切换：有只存在本机的内容 → 先确认，说明条数；取消什么都不动
  writeTasks([{ id: 'l1', title: '只在本机的任务' }, { id: 'l2', title: '另一条本机任务' }, { id: 't9', title: '已同步的', zentaoId: '9' }]);
  const lisiId = r.data.accounts.find(a => a.username === 'lisi' && a.url === 'http://10.0.0.1:8088').id;
  r = await call('POST', '/account/switch', { id: lisiId });
  check('有未同步的本地内容：先确认并告知条数，什么都没改', r.data.needConfirm && r.data.unsynced === 2 && /ZENTAO_USERNAME=zhangs/.test(env()) && readTasksFile().length === 3, JSON.stringify(r.data).slice(0, 200));
  r = await call('POST', '/account/switch', { id: lisiId, confirmSwitch: true });
  check('确认后切换并清空', r.success && r.data.switched && readTasksFile().length === 0 && /ZENTAO_USERNAME=lisi/.test(env()));

  // 移除
  r = await del(`/account/saved/${lisiId}`);
  check('不能移除正在使用的账号（409）', r.status === 409 && /先切换/.test(r.message));
  const other = (await call('GET', '/account/saved')).data.accounts.find(a => !a.current);
  r = await del(`/account/saved/${other.id}`);
  check('移除其他账号：成功，列表和文件里都没有了', r.success && !(await call('GET', '/account/saved')).data.accounts.some(a => a.id === other.id) && !readFileSync(join(tmp, 'accounts.json'), 'utf8').includes(other.id));
  r = await del(`/account/saved/${other.id}`);
  check('移除不存在的账号：404', r.status === 404);

  // 老用户升级：.env 里有凭据但还没有 accounts.json → 读到登录状态时自动记住当前账号
  rmSync(join(tmp, 'accounts.json'), { force: true });
  await call('GET', '/account?refresh=1');
  r = await call('GET', '/account/saved');
  check('升级后当前账号自动进入列表（不用重新登录）', r.data.accounts.length === 1 && r.data.accounts[0].current && r.data.accounts[0].username === 'lisi');

  // 换下来的账号：换之前先存进列表（它的密码这时还在配置里，换掉就找不回来了），以后点一下能切回去
  rmSync(join(tmp, 'accounts.json'), { force: true });
  await call('GET', '/account?refresh=1');
  rmSync(join(tmp, 'accounts.json'), { force: true });   // 模拟：以前（没有这个功能）登录的账号，列表里什么都没有
  r = await call('POST', '/account/login', { url: 'http://10.0.0.1:8088', username: 'zhangs', password: 'pw-zhang', confirmSwitch: true });
  list = (await call('GET', '/account/saved')).data.accounts;
  check('登录另一个账号：被换下来的账号自动保存（带密码，列表里可见）', r.success && list.some(a => a.username === 'lisi' && !a.current && a.hasPassword) && list.some(a => a.username === 'zhangs' && a.current), JSON.stringify(list.map(a => `${a.username}${a.current ? '*' : ''}`)));
  r = await call('POST', '/account/switch', { id: list.find(a => a.username === 'lisi').id });
  check('点换下来的账号：直接切回去', r.success && /ZENTAO_USERNAME=lisi/.test(env()) && r.data.state.profile.realname === '李四');
  rmSync(join(tmp, 'accounts.json'), { force: true });
  const rcv = await acct.reconcileBeforeChange('http://10.0.0.5:8088', 'lisi');
  list = (await call('GET', '/account/saved')).data.accounts;
  check('设置里改了地址：改之前先保存当前账号（换地址的历史账号不丢）', list.some(a => a.username === 'lisi' && a.url === 'http://10.0.0.1:8088' && a.hasPassword), JSON.stringify(list.map(a => `${a.username}@${a.url}`)));
  await call('POST', '/account/login', { url: 'http://10.0.0.1:8088', username: 'lisi', password: 'pw-li', confirmSwitch: true });
  writeTasks([{ id: 't2', title: '李四的任务', zentaoId: '2' }]);

  // 退出不丢列表，重置清空列表（含密码）
  await call('POST', '/account/logout');
  r = await call('GET', '/account/saved');
  check('退出登录后列表还在，仍可一键回来', r.data.accounts.length === 1 && r.data.accounts[0].hasPassword);
  r = await call('POST', '/account/switch', { id: r.data.accounts[0].id });
  check('退出状态下点已保存的账号：直接登录', r.success && r.data.state.state === 'ok');
  writeTasks([{ id: 't2', title: '李四的任务', zentaoId: '2' }]);

  // ---------- 退出 ----------
  r = await call('POST', '/account/logout');
  check('退出：清密码，保留地址与账号，回到未配置；本地数据保留', r.data.state === 'unconfigured' && r.data.zentaoUrl === 'http://10.0.0.1:8088' && r.data.username === 'lisi' && /ZENTAO_PASSWORD=\n/.test(env()) && readTasksFile().length === 1);
  check('退出后：仍知道本地数据属于谁（重新登录卡片上显示）', r.data.dataOwner === 'lisi' && r.data.dataOwnerName === '李四', JSON.stringify(r.data));

  // ---------- 重置：只清配置 ----------
  await call('POST', '/account/login', { url: 'http://10.0.0.1:8088', username: 'lisi', password: 'pw-li' });
  writeFileSync(join(tmp, 'executions.json'), JSON.stringify({ executions: [{ id: '1' }], favoriteExecutionIds: ['1'] }));
  mkdirSync(join(tmp, 'attachments', 'rec1'), { recursive: true });
  writeFileSync(join(tmp, 'attachments', 'rec1', 'a.png'), 'x');
  mkdirSync(join(tmp, 'backups'), { recursive: true });
  writeFileSync(join(tmp, 'backups', 'tasks__x.json'), '{}');
  r = await call('POST', '/account/reset', {});
  const e1 = env();
  check('重置（只清配置）：禅道、AI、推送、提示词、报告成员清空，提醒时间恢复默认',
    r.success && /ZENTAO_URL=\n/.test(e1) && /ZENTAO_PASSWORD=\n/.test(e1) && /OPENAI_API_KEY=\n/.test(e1) && /OPENAI_MODEL=\n/.test(e1) && /REPORT_MEMBERS=\n/.test(e1) && /MORNING_HOUR=9/.test(e1) &&
    config.zentao.password === '' && config.ai.apiKey === '' && config.reports.members.length === 0, e1);
  check('重置（只清配置）：端口保留；本地任务、附件保留；收藏的执行清空', /PORT=3721/.test(e1) && readTasksFile().length === 1 && existsSync(join(tmp, 'attachments', 'rec1', 'a.png')) && JSON.parse(readFileSync(join(tmp, 'executions.json'), 'utf8')).favoriteExecutionIds.length === 0);
  r = await call('GET', '/account');
  check('重置后：回到第一次使用（未配置、没有用户信息、AI 未配置）', r.data.state === 'unconfigured' && !r.data.profile && !existsSync(join(tmp, 'account.json')) && r.data.aiConfigured === false && r.data.zentaoUrl === '');

  // ---------- 重置：连本地数据 ----------
  writeFileSync(join(tmp, 'reports.json'), '{"reports":{}}');
  writeFileSync(join(tmp, 'executionLearning.json'), '{}');
  r = await call('POST', '/account/reset', { includeData: true });
  check('重置（含本地数据）：任务、报告、执行、学习记录、附件清空', r.success && readTasksFile().length === 0 && !existsSync(join(tmp, 'reports.json')) && !existsSync(join(tmp, 'executions.json')) && !existsSync(join(tmp, 'executionLearning.json')) && readdirSync(join(tmp, 'attachments')).length === 0 && r.data.cleared.some(x => /本地任务/.test(x)));
  check('重置：保存的账号和密码一并清掉', (await call('GET', '/account/saved')).data.accounts.length === 0 && !/pw-li|pw-zhang/.test(existsSync(join(tmp, 'accounts.json')) ? readFileSync(join(tmp, 'accounts.json'), 'utf8') : ''));
  check('重置（含本地数据）：备份目录保留', existsSync(join(tmp, 'backups', 'tasks__x.json')));
} catch (err) {
  check(`异常：${err.stack}`, false);
} finally {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}

for (const x of results) console.log(`  ${x.pass ? '✓' : '✗'} ${x.name}${x.pass || !x.extra ? '' : `   → ${String(x.extra).slice(0, 400)}`}`);
const passed = results.filter(x => x.pass).length;
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
