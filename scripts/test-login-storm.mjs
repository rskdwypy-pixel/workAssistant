/**
 * 回归测试：会话失效的重新登录不能连环触发（禅道的「动态」里每次登录都会留一条记录，刷屏很烦）
 *
 * 模拟禅道：登录成功，但「我的任务」永远回「登录已超时」（最坏情况：会话怎么登都判失效）。
 *   - 20 个并发请求：登录次数被限速（30 秒内最多 2 次），不会每个请求各登一次、也不会无限重登
 *   - 同时发往禅道的请求数不超过 4（新版禅道在并发 6 以上时实测开始返回异常）
 *   - 正常情况（不失效）20 个并发请求只登录 1 次
 */
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });

let loginCount = 0, inflight = 0, maxInflight = 0, alwaysExpired = false;
const json = (o, h = {}) => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json', ...h } });
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (url.includes('user-refreshRandom')) return new Response('1234');
  if (url.includes('user-login') && (init.method || 'GET') === 'GET') {
    loginCount++;
    return new Response('<html></html>', { headers: { 'Set-Cookie': `zentaosid=sid${loginCount}; path=/` } });
  }
  if (url.includes('user-login')) return json({ result: 'success' }, { 'Set-Cookie': 'za=u; path=/' });
  inflight++; maxInflight = Math.max(maxInflight, inflight);
  await new Promise(r => setTimeout(r, 15));   // 请求要花点时间，才能看出并发
  inflight--;
  if (alwaysExpired) return json({ result: false, message: '登录已超时，请重新登入!' });
  return json({ status: 'success', data: JSON.stringify({ tasks: [{ id: 1, name: 't', status: 'wait' }], pager: { pageTotal: 1 } }) });
};

const tmp = mkdtempSync(join(tmpdir(), 'wa-storm-'));
const { config } = await import('../src/config.js');
config.paths.data = tmp;
Object.assign(config.zentao, { enabled: true, url: 'http://z.test', username: 'u', password: 'p' });
const zs = await import('../src/services/zentaoService.js');

// 正常：20 个并发只登录 1 次，并发请求不超过上限
zs.clearCookies();
const ok = await Promise.all(Array.from({ length: 20 }, () => zs.getMyTasks().then(() => 'ok', () => 'err')));
check('正常情况：20 个并发请求只登录 1 次', loginCount === 1 && ok.every(x => x === 'ok'), `登录 ${loginCount} 次`);
check('同时发往禅道的请求不超过 4 个', maxInflight <= 4, `最多同时 ${maxInflight} 个`);

// 最坏：会话怎么登都判失效
loginCount = 0; alwaysExpired = true;
zs.clearCookies();
await Promise.all(Array.from({ length: 20 }, () => zs.getMyTasks().then(() => 'ok', () => 'err')));
check('会话怎么登都判失效：20 个并发请求总共登录不超过 3 次（限速），不会连环重登', loginCount <= 3, `登录 ${loginCount} 次`);
const before = loginCount;
await Promise.all(Array.from({ length: 10 }, () => zs.getMyTasks().then(() => 'ok', () => 'err')));
check('限速窗口内再来 10 个请求：不再登录', loginCount === before, `又登录了 ${loginCount - before} 次`);

for (const x of results) console.log(`  ${x.pass ? '✓' : '✗'} ${x.name}${x.pass || !x.extra ? '' : `   → ${x.extra}`}`);
const passed = results.filter(x => x.pass).length;
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
