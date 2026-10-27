#!/usr/bin/env node
/**
 * 回归测试：禅道个人待办（后端）
 * 临时数据目录 + 模拟禅道（替换 globalThis.fetch），不访问网络。模拟新旧两版的差异：
 *   新版写操作走 .json（FormData，返回 {result:'success'}）；旧版走 .html（urlencoded，必须带指向表单页的 Referer，
 *   否则只回表单不执行；返回 <script>）；列表里日期 / 时间是 2026-10-27 / 15:00，详情里是 20261027 / 1500。
 */
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });

const st = { todos: new Map(), nextId: 1, acceptWrites: true, uploads: [], refererMisses: 0 };
const json = (o, h = {}) => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json', ...h } });
const zj = (inner) => json({ status: 'success', data: JSON.stringify(inner) });
const compact = (d) => d.replace(/-/g, '');
const hhmm = (t) => t.replace(':', '');
const listRow = (t) => ({ ...t, date: t.date, begin: t.begin === '2400' ? '' : `${t.begin.slice(0, 2)}:${t.begin.slice(2)}`, end: t.end === '2400' ? '' : `${t.end.slice(0, 2)}:${t.end.slice(2)}` });

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const old = url.startsWith('http://old.test');
  if (!old && !url.startsWith('http://z.test')) return new Response('', { status: 404 });
  if (url.includes('mode=getconfig')) return json({ version: old ? '18.3' : '22.3' });
  if (url.includes('user-refreshRandom')) return new Response('1234');
  if (url.includes('user-login') && (init.method || 'GET') === 'GET') return new Response('<html></html>', { headers: { 'Set-Cookie': 'zentaosid=s1; path=/' } });
  if (url.includes('user-login')) return json({ result: 'success' }, { 'Set-Cookie': 'za=u; path=/' });
  const path = url.replace(/^http:\/\/[^/]+\/zentao\//, '').replace(/\?.*$/, '');
  const method = (init.method || 'GET').toUpperCase();
  const h = new Headers(init.headers || {});
  const fields = (() => {
    if (method !== 'POST' || !init.body) return {};
    if (init.body instanceof FormData) return Object.fromEntries(init.body.entries());
    return Object.fromEntries(new URLSearchParams(String(init.body)));
  })();
  const done = old ? () => new Response('<html><script>parent.location="x"</script></html>') : () => json({ result: 'success', message: '保存成功' });

  let m;
  if (path.startsWith('my-todo-')) {
    const rows = [...st.todos.values()].filter(t => t.deleted === '0').map(listRow);
    return zj({ todos: rows, pager: { pageTotal: 1 } });
  }
  if ((m = path.match(/^todo-view-(\d+)\.json$/))) {
    const t = st.todos.get(m[1]);
    if (!t) return json({ status: 'fail', message: '404 Not found' });
    return zj({ todo: { ...t, date: compact(t.date) } });
  }
  if (/^file-ajaxUpload-[\w-]+\.html$/.test(path)) { st.uploads.push(path); return json({ error: 0, url: '/zentao/file-read-9.png' }); }

  const write = (fn) => {
    if (old && !h.get('Referer')?.includes('todo-')) { st.refererMisses++; return new Response('<html>form</html>'); }
    if (!st.acceptWrites) return old ? new Response('<html>form</html>') : json({ result: 'success' });   // 静默失败
    return fn();
  };
  if ((m = path.match(/^todo-create\.(json|html)$/)) && method === 'POST') {
    return write(() => {
      const id = String(st.nextId++);
      const idvalue = fields.idvalue && old ? fields.idvalue : (fields[fields.type] || fields.idvalue || '0');
      st.todos.set(id, { id, account: 'me', date: fields.date, begin: fields.begin, end: fields.end, type: fields.type, cycle: '0', idvalue, pri: fields.pri, name: fields.type === 'custom' ? fields.name : `关联${fields.type}${idvalue}`, desc: fields.desc, status: 'wait', private: fields.private || '0', assignedTo: fields.assignedTo, assignedBy: 'me', account2: '', deleted: '0', _fields: fields });
      return old ? done() : json({ result: 'success', message: '保存成功', id: Number(id) });
    });
  }
  if ((m = path.match(/^todo-edit-(\d+)\.(json|html)$/)) && method === 'POST') {
    return write(() => { const t = st.todos.get(m[1]); Object.assign(t, { date: fields.date, begin: fields.begin, end: fields.end, pri: fields.pri, name: fields.type === 'custom' ? fields.name : t.name, desc: fields.desc, private: fields.private || '0', assignedTo: fields.assignedTo }); t._fields = fields; return done(); });
  }
  if ((m = path.match(/^todo-(start|finish|activate|close)-(\d+)\.(json|html)$/))) {
    return write(() => {
      const t = st.todos.get(m[2]); const to = { start: 'doing', finish: 'done', activate: 'wait', close: 'closed' }[m[1]];
      if (m[1] === 'close' && t.status !== 'done') return done();
      if (m[1] === 'start' && t.status !== 'wait') return done();
      t.status = to; st.log.push(m[1]); return done();
    });
  }
  if ((m = path.match(/^todo-delete-(\d+)-yes\.(json|html)$/))) return write(() => { st.todos.get(m[1]).deleted = '1'; return done(); });
  return new Response('not mocked ' + path, { status: 404 });
};
st.log = [];

const tmp = mkdtempSync(join(tmpdir(), 'wa-zttodo-'));
const { config } = await import('../src/config.js');
config.paths.data = tmp;
Object.assign(config.zentao, { enabled: true, url: 'http://z.test', username: 'me', password: 'pw', users: { me: '我' } });
const T = await import('../src/services/zentaoTodo.js');
const useVersion = (v) => { config.zentao.url = v === '18.3' ? 'http://old.test' : 'http://z.test'; st.todos.clear(); st.log = []; st.acceptWrites = true; };

try {
  // ---------- 纯函数 ----------
  check('日期归一：详情的 20261027 / 列表的 2026-10-27 都变成 2026-10-27', T.normDate('20261027') === '2026-10-27' && T.normDate('2026-10-27') === '2026-10-27');
  check('日期归一：2030-01-01（长期）/ 空 / 0000 → 空（待定）', T.normDate('2030-01-01') === '' && T.normDate('20300101') === '' && T.normDate('') === '' && T.normDate('0000-00-00') === '');
  check('时间归一：1500 / 15:00 → 15:00；2400 / 空 → 空', T.normTime('1500') === '15:00' && T.normTime('15:00') === '15:00' && T.normTime('2400') === '' && T.normTime('') === '' && T.normTime('0930') === '09:30');
  const n = T.normalizeTodo({ id: 5, type: 'task', idvalue: '77', pri: '9', status: 'weird', private: '1', date: '20261027', begin: '1500', end: '1530', name: ' 名 ' });
  check('归一：优先级 / 状态非法时给默认值，私人、关联、时间都转好', n.pri === 3 && n.status === 'wait' && n.private === true && n.objectId === '77' && n.begin === '15:00' && n.name === '名' && n.id === '5');
  const bf = (o) => T.buildFields({ type: 'custom', name: '写周报', pri: 2, date: '2026-10-27', begin: '09:00', end: '10:00', ...o }, { me: 'me' });
  const f1 = bf({});
  check('表单：自定义待办的字段（时间 HHMM、默认指派给自己）', f1.type === 'custom' && f1.begin === '0900' && f1.end === '1000' && f1.assignedTo === 'me' && f1.pri === '2' && f1.date === '2026-10-27' && !('private' in f1));
  const f2 = bf({ date: '', begin: '', end: '', private: true });
  check('表单：待定日期 = 2030-01-01，不设时间 = 2400，私人 = 1', f2.date === '2030-01-01' && f2.begin === '2400' && f2.end === '2400' && f2.private === '1');
  const f3 = bf({ type: 'bug', objectId: '12', name: '' });
  check('表单：关联 Bug 同时带 idvalue（旧版）和 bug（新版）', f3.idvalue === '12' && f3.bug === '12');
  const bad = (o) => { try { bf(o); return false; } catch (e) { return e.message; } };
  check('表单：名称为空 / 优先级越界 / 日期不对 / 只填一个时间 / 结束早于开始 / 关联没选 都被拦', bad({ name: ' ' }) && bad({ pri: 9 }) && bad({ date: '10/27' }) && bad({ begin: '09:00', end: '' }) && bad({ begin: '10:00', end: '09:00' }) && bad({ type: 'task', objectId: '' }));

  // ---------- 新旧两版的完整流程 ----------
  for (const ver of ['22.3', '18.3']) {
    useVersion(ver);
    const tag = `[${ver}]`;
    const c = await T.createTodo({ type: 'custom', name: '给客户回电话', pri: 1, desc: '<p>说明</p>', date: '2026-10-27', begin: '15:00', end: '15:30', private: true });
    check(`${tag} 新建：回读到名称 / 优先级 / 日期 / 时间 / 私人 / 描述`, c.name === '给客户回电话' && c.pri === 1 && c.date === '2026-10-27' && c.begin === '15:00' && c.private === true && c.desc === '<p>说明</p>' && c.assignedTo === 'me', JSON.stringify(c));
    if (ver === '18.3') check(`${tag} 旧版写操作带了指向表单页的 Referer`, st.refererMisses === 0);
    const u = await T.updateTodo(c.id, { type: 'custom', name: '改名了', pri: 4, desc: '新', date: '', begin: '', end: '' });
    check(`${tag} 编辑：名称 / 优先级 / 待定日期 / 无时间`, u.name === '改名了' && u.pri === 4 && u.date === '' && u.begin === '');
    const seq = [];
    for (const to of ['doing', 'done', 'wait', 'closed', 'doing', 'done']) { seq.push((await T.setTodoStatus(c.id, to)).status); }
    check(`${tag} 状态流转（含 已关闭→进行中 / 完成）`, seq.join() === 'doing,done,wait,closed,doing,done', seq.join());
    check(`${tag} 已经是目标状态：不发请求`, await (async () => { const before = st.log.length; await T.setTodoStatus(c.id, 'done'); return st.log.length === before; })());
    const lk = await T.createTodo({ type: 'task', objectId: '88', pri: 3, date: '2026-10-27' });
    check(`${tag} 关联任务：编号落到 objectId`, lk.type === 'task' && lk.objectId === '88');
    const list = await T.listTodos();
    check(`${tag} 列表：全部（含已完成），不含已删除`, list.length === 2);
    await T.deleteTodo(c.id);
    check(`${tag} 删除：回读已不在列表`, (await T.listTodos()).length === 1);
    st.acceptWrites = false;
    const silent = async (fn) => { try { await fn(); return false; } catch (e) { return e.message; } };
    check(`${tag} 禅道静默失败（返回成功但没执行）：新建 / 状态 / 删除 都不能报成功`,
      await silent(() => T.createTodo({ type: 'custom', name: '静默', pri: 3 })) && await silent(() => T.setTodoStatus(lk.id, 'doing')) && await silent(() => T.deleteTodo(lk.id)));
    st.acceptWrites = true;
  }

  // ---------- 周期待办 / 不存在 / 图片 ----------
  useVersion('22.3');
  st.todos.set('50', { id: '50', account: 'me', date: '2026-10-27', begin: '2400', end: '2400', type: 'cycle', cycle: '1', idvalue: '0', pri: '3', name: '每月报表', desc: '', status: 'doing', private: '0', assignedTo: 'me', deleted: '0' });
  check('周期待办：不允许在这里编辑，给出原因', await (async () => { try { await T.updateTodo('50', { type: 'custom', name: 'x', pri: 3 }); return false; } catch (e) { return /周期/.test(e.message); } })());
  check('周期待办：可以改状态', (await T.setTodoStatus('50', 'done')).status === 'done');
  check('不存在的待办：给明确提示', await (async () => { try { await T.getTodo('999'); return false; } catch (e) { return /不存在/.test(e.message); } })());
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  check('图片上传：返回禅道里的图片地址', (await T.uploadTodoImage({ uid: 'wa123', name: 'a.png', mime: 'image/png', buffer: png })) === '/zentao/file-read-9.png' && st.uploads.length === 1);
  const rej = async (o) => { try { await T.uploadTodoImage(o); return false; } catch { return true; } };
  check('图片上传：非图片 / 空文件 / 缺少编辑会话 / 超过 10MB 都拒绝', await rej({ uid: 'wa123', mime: 'text/html', buffer: png }) && await rej({ uid: 'wa123', mime: 'image/png', buffer: Buffer.alloc(0) }) && await rej({ uid: '', mime: 'image/png', buffer: png }) && await rej({ uid: 'wa123', mime: 'image/png', buffer: Buffer.alloc(10 * 1024 * 1024 + 1) }));
} catch (err) {
  check('测试本身没有异常', false, err.stack);
}

let bad = 0;
for (const r of results) { console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${!r.pass && r.extra ? '\n      ' + r.extra : ''}`); if (!r.pass) bad++; }
console.log(`\n${results.length - bad}/${results.length} 通过`);
process.exit(bad ? 1 : 0);
