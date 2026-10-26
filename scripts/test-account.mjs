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
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
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
  if (tv) return zj({ task: { id: tv[1], name: `task-${tv[1]}` } });
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
  // 已经换过地址、旧数据还留着（没有记录）：抽查标题，对不上就是别的禅道的
  writeTasks([{ id: 'a', type: 'task', title: 'task-1', zentaoId: '1' }, { id: 'b', type: 'task', title: 'task-2', zentaoId: '2' }, { id: 'c', type: 'task', title: 'task-3', zentaoId: '3' }]);
  check('抽查：标题和当前禅道一致 → 不是别的禅道', (await acct.probeForeignData()) === false);
  writeTasks([{ id: 'a', type: 'task', title: '旧禅道的任务甲', zentaoId: '1' }, { id: 'b', type: 'task', title: '旧禅道的任务乙', zentaoId: '2' }, { id: 'c', type: 'task', title: '旧禅道的任务丙', zentaoId: '3' }]);
  check('抽查：标题对不上 → 判定为别的禅道的数据', (await acct.probeForeignData()) === true);
  writeTasks([{ id: 'a', type: 'task', title: '只有一条', zentaoId: '1' }]);
  check('抽查：数据太少不下结论（不清）', (await acct.probeForeignData()) === false);
  rmSync(join(tmp, 'data-scope.json'), { force: true });
  writeTasks([{ id: 'a', type: 'task', title: '旧禅道的任务甲', zentaoId: '1' }, { id: 'b', type: 'task', title: '旧禅道的任务乙', zentaoId: '2' }]);
  r = await call('POST', '/account/login', { url: 'http://10.0.0.1:8088', username: 'lisi', password: 'pw-li', confirmSwitch: true });
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
