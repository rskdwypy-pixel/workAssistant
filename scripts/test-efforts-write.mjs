/**
 * 真函数测试：工时的写操作（新增 / 修改 / 删除）——用模拟的禅道，按真实抓包（ZenTao 18.3）的请求格式
 *   - 新增：补填过去的日期（dates[1]=那天）；剩余必填；剩余为 0 必须确认完成（带 finish）才发请求
 *   - 修改：POST task-editEstimate-{id}，urlencoded 的 date / consumed / left / work；只能改自己的；
 *           禅道的 alert 原因原样带出；改完回读核对，核对不一致就报错
 *   - 删除：GET task-deleteEstimate-{id}-yes；只能删自己的；删完回读确认记录没了
 *   - 写操作之后「我的」和「全员」两份缓存里该任务的条目都被清掉；缓存条目超过 6 小时不再信任
 *   - 接口：PUT / DELETE 的状态码、CONFIRM_FINISH 的 code
 */
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });

// ---------- 模拟禅道 ----------
const zt = { realFetch: globalThis.fetch, reqs: [], failEdit: '', ignoreEdit: false, ignoreDelete: false, nextId: 2000, efforts: [] };
const reset = () => {
  zt.reqs = []; zt.failEdit = ''; zt.ignoreEdit = false; zt.ignoreDelete = false; zt.nextId = 2000;
  zt.efforts = [
    { id: '1001', account: 'lijc', date: '2025-03-17', consumed: '2', left: '6', work: '联调', deleted: '0' },
    { id: '1002', account: 'zhouh', date: '2025-03-17', consumed: '4', left: '2', work: '别人的', deleted: '0' }
  ];
};
const json = (o) => new Response(JSON.stringify({ status: 'success', data: JSON.stringify(o) }), { headers: { 'Content-Type': 'application/json' } });
const total = () => zt.efforts.filter(e => e.deleted !== '1').reduce((n, e) => n + Number(e.consumed), 0);
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (!url.startsWith('http://z.test')) return zt.realFetch(input, init);
  const method = (init.method || 'GET').toUpperCase();
  if (url.includes('user-refreshRandom')) return new Response('1234');
  if (url.includes('user-login') && method === 'GET') return new Response('<html></html>', { headers: { 'Set-Cookie': 'zentaosid=sid1; path=/' } });
  if (url.includes('user-login')) return new Response(JSON.stringify({ result: 'success' }), { headers: { 'Content-Type': 'application/json' } });
  let m;
  if (url.includes('my-task-assignedTo')) return json({ tasks: { 10: { id: '10', name: '接口联调', status: 'doing', consumed: String(total()), left: '4' } }, pager: { pageTotal: 1 } });
  if ((m = url.match(/task-recordEstimate-(\d+)\.json/))) return json({ efforts: zt.efforts });
  if ((m = url.match(/task-recordEstimate-(\d+)\.html/)) && method === 'POST') {
    zt.reqs.push({ kind: 'add', task: m[1], body: Object.fromEntries(new URLSearchParams(init.body)) });
    const b = new URLSearchParams(init.body);
    for (let i = 1; i <= 5; i++) {
      if (b.get(`consumed[${i}]`)) zt.efforts.push({ id: String(zt.nextId++), account: 'lijc', date: b.get(`dates[${i}]`), consumed: b.get(`consumed[${i}]`), left: b.get(`left[${i}]`), work: b.get(`work[${i}]`), deleted: '0' });
    }
    return new Response("<script>if(typeof(parent.parent.ajaxRefresh) == 'function') parent.parent.ajaxRefresh()</script>");
  }
  if ((m = url.match(/task-editEstimate-(\d+)\.html/)) && method === 'POST') {
    const body = Object.fromEntries(new URLSearchParams(init.body));
    zt.reqs.push({ kind: 'edit', id: m[1], body, ct: new Headers(init.headers).get('content-type') });
    if (zt.failEdit) return new Response(`<script>alert('${zt.failEdit}');</script>`);
    if (!zt.ignoreEdit) Object.assign(zt.efforts.find(e => e.id === m[1]), { date: body.date, consumed: body.consumed, left: body.left, work: body.work });
    return new Response("<html><script>parent.location='/zentao/task-recordEstimate-10.html?onlybody=yes';</script>");
  }
  if ((m = url.match(/task-deleteEstimate-(\d+)-yes\.html/))) {
    zt.reqs.push({ kind: 'delete', id: m[1] });
    if (!zt.ignoreDelete) zt.efforts.find(e => e.id === m[1]).deleted = '1';
    return new Response('<html><script>if(parent !== window) parent.location.reload(true);</script>');
  }
  return new Response('not found', { status: 404 });
};

// ---------- 临时数据 ----------
const tmp = mkdtempSync(join(tmpdir(), 'wa-eff-write-'));
process.env.WA_DATA_DIR = tmp;
process.env.WA_ENV_FILE = join(tmp, '.env');
writeFileSync(process.env.WA_ENV_FILE, '');
const { config } = await import('../src/config.js');
Object.assign(config.zentao, { enabled: true, url: 'http://z.test', username: 'lijc', password: 'p' });
const es = await import('../src/services/effortService.js');
const router = (await import('../src/routes/efforts.js')).default;
const app = express();
app.use(express.json());
app.use('/api', router);
const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const call = (method, p, body) => zt.realFetch(`http://127.0.0.1:${server.address().port}/api${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, ...(await r.json()) }));
const rejects = async (fn, re, code) => { try { await fn(); return false; } catch (e) { return re.test(e.message) && (!code || e.code === code); } };

try {
  // ============ 新增 ============
  reset();
  const ok = { taskId: '10', date: '2025-03-14', consumed: 1.5, left: 2.5, work: '补填：联调' };
  const r1 = await es.addEffort(ok);
  const add = zt.reqs.find(x => x.kind === 'add');
  check('新增：补填过去的日期（dates[1] = 那天），消耗 / 剩余 / 内容按原样', r1.success && add.body['dates[1]'] === '2025-03-14' && add.body['consumed[1]'] === '1.5' && add.body['left[1]'] === '2.5' && add.body['work[1]'] === '补填：联调', JSON.stringify(add && add.body).slice(0, 160));
  check('新增：记录真的出现在禅道里', zt.efforts.some(e => e.work === '补填：联调' && e.date === '2025-03-14'));

  reset();
  check('新增：剩余不填被拒绝（要明确填，0 表示做完）', await rejects(() => es.addEffort({ ...ok, left: '' }), /请填写剩余工时/) && zt.reqs.length === 0);
  check('新增：剩余为 0 且没确认 → CONFIRM_FINISH，不发请求', await rejects(() => es.addEffort({ ...ok, left: 0 }), /标记为「已完成」/, 'CONFIRM_FINISH') && zt.reqs.length === 0);
  const fin = await es.addEffort({ ...ok, left: 0, finish: true });
  check('新增：确认完成（finish:true）后才发请求，left[1]=0', fin.success && zt.reqs[0].body['left[1]'] === '0');

  // ============ 修改 ============
  reset();
  const e1 = { taskId: '10', effortId: '1001', date: '2025-03-16', consumed: 3, left: 5, work: '改成这样' };
  const r2 = await es.editEffort(e1);
  const ed = zt.reqs.find(x => x.kind === 'edit');
  check('修改：POST task-editEstimate-{id}，urlencoded，字段 date / consumed / left / work', r2.success && ed.id === '1001' && /x-www-form-urlencoded/.test(ed.ct) && ed.body.date === '2025-03-16' && ed.body.consumed === '3' && ed.body.left === '5' && ed.body.work === '改成这样', JSON.stringify(ed));
  check('修改：回读核对一致，禅道里确实改了', zt.efforts.find(e => e.id === '1001').consumed === '3');

  reset();
  check('修改：不是自己的工时被拒绝，不发修改请求', await rejects(() => es.editEffort({ ...e1, effortId: '1002' }), /只能修改自己的工时/) && !zt.reqs.some(x => x.kind === 'edit'));
  check('修改：记录已不存在（别处删了）：提示刷新，不发请求', await rejects(() => es.editEffort({ ...e1, effortId: '9999' }), /已经不存在/) && !zt.reqs.some(x => x.kind === 'edit'));
  check('修改：校验在发请求之前（日期是将来）', await rejects(() => es.editEffort({ ...e1, date: '2999-01-01' }), /将来/) && zt.reqs.length === 0);
  check('修改：剩余为 0 也要确认完成', await rejects(() => es.editEffort({ ...e1, left: 0 }), /已完成/, 'CONFIRM_FINISH') && zt.reqs.length === 0);
  zt.failEdit = '日期不能晚于今天';
  check('修改：禅道的 alert 原因原样带出', await rejects(() => es.editEffort(e1), /日期不能晚于今天/));
  zt.failEdit = ''; zt.ignoreEdit = true;
  check('修改：禅道返回成功脚本但实际没改 → 回读核对出来并报错（不误报成功）', await rejects(() => es.editEffort(e1), /回读核对不一致/));

  // ============ 删除 ============
  reset();
  const r3 = await es.deleteEffort({ taskId: '10', effortId: '1001' });
  check('删除：请求 task-deleteEstimate-{id}-yes，记录消失', r3.success && zt.reqs.some(x => x.kind === 'delete' && x.id === '1001') && zt.efforts.find(e => e.id === '1001').deleted === '1');
  reset();
  check('删除：不是自己的被拒绝，不发删除请求', await rejects(() => es.deleteEffort({ taskId: '10', effortId: '1002' }), /只能修改自己的工时/) && !zt.reqs.some(x => x.kind === 'delete'));
  check('删除：非法 ID 被拒绝', await rejects(() => es.deleteEffort({ taskId: '10', effortId: '1;drop' }), /非法/));
  zt.ignoreDelete = true;
  check('删除：禅道说成功但记录还在 → 回读核对出来并报错', await rejects(() => es.deleteEffort({ taskId: '10', effortId: '1001' }), /没有生效/));

  // ============ 缓存失效 ============
  reset();
  es._caches.mine.write({ syncedAt: Date.now(), tasks: { 10: { sig: 'a', at: Date.now(), name: '联调', exec: '', efforts: [] }, 11: { sig: 'b', at: Date.now(), name: '别的', exec: '', efforts: [] } } });
  es._caches.team.write({ syncedAt: Date.now(), tasks: { 10: { sig: 'a', at: Date.now(), efforts: [] }, 11: { sig: 'b', at: Date.now(), efforts: [] } } });
  await es.editEffort(e1);
  check('写操作后：「我的」和「全员」缓存里该任务的条目都被清掉，别的任务不受影响', !es._caches.mine.read().tasks[10] && !es._caches.team.read().tasks[10] && !!es._caches.mine.read().tasks[11] && !!es._caches.team.read().tasks[11]);
  check('写操作后：「我的」缓存标为需要重新同步（syncedAt = 0）', es._caches.mine.read().syncedAt === 0);

  // ============ 缓存条目的有效期 ============
  es._caches.team.write({ syncedAt: Date.now(), tasks: {
    20: { sig: 's', at: Date.now() - 60 * 1000, efforts: [{ id: '1' }] },
    21: { sig: 's', at: Date.now() - 7 * 3600 * 1000, efforts: [{ id: '1' }] },
    22: { sig: 's', efforts: [{ id: '1' }] } } });
  check('缓存条目 1 分钟前读的：命中', es.cachedTaskEfforts('20', 's') !== null);
  check('缓存条目超过 6 小时：不再信任（外部只改日期 / 内容时靠它自愈）', es.cachedTaskEfforts('21', 's') === null);
  check('老缓存没有时间戳：当作过期，读一次后补上', es.cachedTaskEfforts('22', 's') === null);

  // ============ 接口 ============
  reset();
  const bad = await call('POST', '/efforts', { ...ok, left: 0 });
  check('接口：剩余 0 未确认 → 400 + code=CONFIRM_FINISH', bad.status === 400 && bad.code === 'CONFIRM_FINISH' && zt.reqs.length === 0, JSON.stringify(bad));
  const put = await call('PUT', '/efforts/1001', e1);
  check('接口：PUT /api/efforts/:id 修改成功', put.status === 200 && put.success);
  const putOther = await call('PUT', '/efforts/1002', e1);
  check('接口：改别人的 → 400', putOther.status === 400 && /只能修改自己的工时/.test(putOther.message));
  const del = await call('DELETE', '/efforts/1001?taskId=10');
  check('接口：DELETE /api/efforts/:id?taskId= 删除成功', del.status === 200 && del.success);
  const delNoTask = await call('DELETE', '/efforts/1001');
  check('接口：缺 taskId → 400', delNoTask.status === 400);
} catch (err) {
  check(`异常：${err.stack}`, false);
} finally {
  server.close();
}

for (const x of results) console.log(`  ${x.pass ? '✓' : '✗'} ${x.name}${x.pass || !x.extra ? '' : `   → ${x.extra}`}`);
const passed = results.filter(x => x.pass).length;
console.log(`\n工时写操作：${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
