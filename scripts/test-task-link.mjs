/**
 * 真函数测试：需求拆任务 / Bug 转任务（taskLink + 路由），模拟的禅道按真实实测（ZenTao 18.3）的行为：
 *   - 只收 multipart（urlencoded 时回表单页、不建任务）；缺 X-Requested-With 同样只回页面
 *   - 需求：URL task-create-{执行}-{需求}-0.html，字段 story；Bug：URL 带 projectID 与 BugID，没有 fromBug 字段
 *   - 响应不带任务 ID：按标题回查；回读 task-view 核对 story / fromBug
 *   - 禅道允许重复转 Bug：插件自己拦（toTask 非 0 → ALREADY_LINKED，不发请求）
 */
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });

const zt = { realFetch: globalThis.fetch, posts: [], tasks: [], bugs: {}, nextId: 900, rejectAs: '', noLink: false, syncs: 0 };
const reset = () => { zt.posts = []; zt.tasks = []; zt.bugs = { 88: { id: '88', title: '登录超时', status: 'active', toTask: '0' }, 89: { id: '89', title: '已转过', status: 'active', toTask: '777' } }; zt.nextId = 900; zt.rejectAs = ''; zt.noLink = false; zt.syncs = 0; };
const wrap = (o) => new Response(JSON.stringify({ status: 'success', data: JSON.stringify(o) }), { headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (!url.startsWith('http://z.test')) return zt.realFetch(input, init);
  const method = (init.method || 'GET').toUpperCase();
  if (url.includes('user-refreshRandom')) return new Response('1234');
  if (url.includes('user-login') && method === 'GET') return new Response('<html></html>', { headers: { 'Set-Cookie': 'zentaosid=sid1; path=/' } });
  if (url.includes('user-login')) return new Response(JSON.stringify({ result: 'success' }), { headers: { 'Content-Type': 'application/json' } });
  let m;
  if ((m = url.match(/execution-view-(\d+)\.json/))) return wrap({ execution: { id: m[1], name: '真机拨测看板', project: '39', type: 'sprint' } });
  if ((m = url.match(/bug-view-(\d+)\.json/))) return wrap({ bug: zt.bugs[m[1]] || {} });
  if ((m = url.match(/task-view-(\d+)\.json/))) { const t = zt.tasks.find(x => x.id === m[1]); return wrap({ task: t ? { id: t.id, story: zt.noLink ? '0' : t.story, fromBug: zt.noLink ? '0' : t.fromBug } : {} }); }
  if ((m = url.match(/story-view-(\d+)\.json/))) return wrap({ story: { id: m[1], title: '需求标题', spec: '<p>支持正则匹配</p>', verify: '<p>验收点</p>' }, executions: { 61: { id: '61' } }, tasks: { 61: zt.tasks.map(t => ({ id: t.id, name: t.name, assignedTo: 'lijc', status: 'wait', execution: '61', consumed: '0', left: '1' })) } });
  if (url.includes('task-ajaxGetTasks')) return new Response(zt.tasks.map(t => `<tr data-id='t${t.id}' data-status='wait' data-assignedTo='lijc'><td><a href='task-view-${t.id}.json'>${t.name}</a></td></tr>`).join(''));
  if ((m = url.match(/task-create-(\d+)-(.*)\.html$/)) && method === 'POST') {
    const h = new Headers(init.headers);
    const isForm = init.body instanceof FormData;
    const body = isForm ? Object.fromEntries([...init.body.entries()]) : {};
    zt.posts.push({ exec: m[1], tail: m[2], body, xhr: h.get('x-requested-with'), isForm });
    if (!isForm || h.get('x-requested-with') !== 'XMLHttpRequest') return new Response('<!DOCTYPE html><html><title>建任务</title></html>');
    if (zt.rejectAs) return new Response(JSON.stringify({ result: 'fail', message: { type: [zt.rejectAs] } }));
    const id = String(zt.nextId++);
    const bugM = m[2].match(/projectID=(\d+)-(\d+)$/);
    zt.tasks.push({ id, name: body.name, story: body.story || '0', fromBug: bugM ? bugM[2] : '0' });
    if (bugM) zt.bugs[bugM[2]].toTask = id;
    return new Response(JSON.stringify({ result: 'success', message: '保存成功', locate: '/zentao/execution-task-61.html' }));
  }
  return new Response('not found', { status: 404 });
};

const tmp = mkdtempSync(join(tmpdir(), 'wa-tasklink-'));
process.env.WA_DATA_DIR = tmp;
process.env.WA_ENV_FILE = join(tmp, '.env');
writeFileSync(process.env.WA_ENV_FILE, '');
const { config } = await import('../src/config.js');
Object.assign(config.zentao, { enabled: true, url: 'http://z.test', username: 'lijc', password: 'p' });
const tl = await import('../src/services/taskLink.js');
const router = (await import('../src/routes/taskLink.js')).default;
const app = express();
app.use(express.json());
app.use('/api', router);
const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const call = (method, p, body) => zt.realFetch(`http://127.0.0.1:${server.address().port}/api${p}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async r => ({ status: r.status, ...(await r.json()) }));

try {
  // ---- 纯函数 ----
  check('标题为空被拒', (() => { try { tl.normalizeDraft({ name: '  ' }); return false; } catch (e) { return /标题/.test(e.message); } })());
  check('类型 / 优先级 / 工时校验', (() => { const bad = [{ name: 'a', type: 'x' }, { name: 'a', pri: 9 }, { name: 'a', estimate: -1 }]; return bad.every(d => { try { tl.normalizeDraft(d); return false; } catch { return true; } }); })());
  const nd = tl.normalizeDraft({ name: ' 做事 ', estimate: '2', deadline: '2026-10-30T00:00:00' });
  check('规整：去空格、数字化、日期截到天、默认 devel / pri3', nd.name === '做事' && nd.estimate === 2 && nd.deadline === '2026-10-30' && nd.type === 'devel' && nd.pri === 3);
  check('flattenMessage：字段错误对象拍平', tl.flattenMessage({ type: ['『任务类型』不能为空。'], name: ['重名'] }) === '『任务类型』不能为空。；重名');

  // ---- 需求拆任务 ----
  reset();
  const r1 = await tl.createLinkedTask({ executionId: '61', storyId: '120' }, { name: '方案设计', type: 'design', estimate: 3, assignedTo: 'lijc' });
  const p1 = zt.posts[0];
  check('需求：成功并回读确认关联（linked）', r1.success && r1.linked && r1.taskId === '900', JSON.stringify(r1));
  check('需求：URL task-create-61-120-0.html，multipart + XHR 头', p1.exec === '61' && p1.tail === '120-0' && p1.isForm && p1.xhr === 'XMLHttpRequest', JSON.stringify({ e: p1.exec, t: p1.tail }));
  check('需求：story=120、assignedTo[]、estimate、type 字段到位', p1.body.story === '120' && p1.body['assignedTo[]'] === 'lijc' && p1.body.estimate === '3' && p1.body.type === 'design');
  const r1b = await tl.createLinkedTask({ executionId: '61', storyId: '120' }, { name: '联调' });
  check('需求：第二个任务拿到自己的 ID（按标题回查）', r1b.taskId === '901');

  // ---- Bug 转任务 ----
  reset();
  const r2 = await tl.createLinkedTask({ executionId: '61', bugId: '88' }, { name: '【Bug#88】登录超时', desc: '重现步骤…' });
  const p2 = zt.posts[0];
  check('Bug：成功且回读 fromBug 一致', r2.success && r2.linked && r2.taskId === '900', JSON.stringify(r2));
  check('Bug：URL 带 projectID=39 与 BugID，且没有 fromBug 字段', p2.tail === '0-0-0-0-projectID=39-88' && !('fromBug' in p2.body) && p2.body.story === '');
  const r2b = await tl.createLinkedTask({ executionId: '61', bugId: '88' }, { name: '再转一次' });
  check('Bug：已转过 → ALREADY_LINKED，带出已有任务 ID，不发请求', !r2b.success && r2b.code === 'ALREADY_LINKED' && r2b.taskId === '900' && zt.posts.length === 1);
  const r2c = await tl.createLinkedTask({ executionId: '61', bugId: '89' }, { name: 'x' });
  check('Bug：禅道里早已转过（toTask=777）同样被拦', r2c.code === 'ALREADY_LINKED' && r2c.taskId === '777');
  const r2d = await tl.createLinkedTask({ executionId: '61', bugId: '404' }, { name: 'x' });
  check('Bug：不存在 → NOT_FOUND', r2d.code === 'NOT_FOUND');

  // ---- AI 拆分建议 ----
  let seenPrompt = '';
  const goodAi = async (prompt) => { seenPrompt = prompt; return '好的：\n```json\n[{"name":"设计匹配规则","type":"design","estimate":2},{"name":"实现正则匹配","type":"devel","estimate":6},{"name":"联调验证","type":"test","estimate":"3"}]\n```'; };
  const sg = await tl.suggestTasks({ title: '需求标题', spec: '<p>支持正则匹配 账号：abc123 密码：xyz 见 http://a.b/c</p>', verify: '<p>验收点</p>' }, { ai: goodAi });
  check('建议：AI 返回被解析成任务（标题 / 类型 / 工时）', sg.aiUsed && sg.tasks.length === 3 && sg.tasks[1].type === 'devel' && sg.tasks[1].estimate === 6 && sg.tasks[2].estimate === 3, JSON.stringify(sg));
  check('建议：提示词里去掉了 HTML、链接和账号密码，带上需求标题', !/<p>|http:\/\/|abc123|xyz/.test(seenPrompt) && /需求标题/.test(seenPrompt) && /支持正则匹配/.test(seenPrompt));
  const noAi = await tl.suggestTasks({ title: 't' }, { ai: null });
  check('建议：没配置 AI → 通用模板，说明原因，不抛错', !noAi.aiUsed && noAi.tasks.length === 4 && /还没有配置 AI/.test(noAi.reason));
  const errAi = await tl.suggestTasks({ title: 't' }, { ai: async () => { throw new Error('401'); } });
  check('建议：AI 报错 → 退回模板并说明，不抛错', !errAi.aiUsed && errAi.tasks.length === 4 && /暂时不可用/.test(errAi.reason));
  const junk = await tl.suggestTasks({ title: 't' }, { ai: async () => '我没法拆分' });
  check('建议：AI 回了废话 → 退回模板', !junk.aiUsed && junk.tasks.length === 4);
  const dup = tl.parseSuggestions('[{"name":"a"},{"name":"a"},{"name":""},{"name":"b","type":"zzz","estimate":99}]');
  check('解析：去重、丢空标题、非法类型 → devel、工时超限置空', dup.length === 2 && dup[1].type === 'devel' && dup[1].estimate === '');

  // ---- 失败形态 ----
  reset();
  zt.rejectAs = '『任务类型』不能为空。';
  const f1 = await tl.createLinkedTask({ executionId: '61', storyId: '120' }, { name: 'a' });
  check('禅道拒绝：原因原样带出，不当成功', !f1.success && f1.code === 'REJECTED' && /任务类型/.test(f1.message));
  reset(); zt.noLink = true;
  const f2 = await tl.createLinkedTask({ executionId: '61', storyId: '120' }, { name: 'a' });
  check('建成但回读没关联上：success 但 linked=false 并提示核对', f2.success && f2.linked === false && /核对/.test(f2.message));
  check('校验：没选执行 / 同时给需求和 Bug / 标题空，都不发请求', (await tl.createLinkedTask({ storyId: '1' }, { name: 'a' })).success === false && (await tl.createLinkedTask({ executionId: '61', storyId: '1', bugId: '2' }, { name: 'a' })).success === false && (await tl.createLinkedTask({ executionId: '61', storyId: '1' }, { name: '' })).code === 'INVALID' && zt.posts.length === 1);

  // ---- 路由 ----
  reset();
  const g = await call('GET', '/bugs/88/task-link');
  check('接口：GET /bugs/:zid/task-link 未转过', g.success && g.data.toTask === '' && g.data.exists);
  const bad = await call('POST', '/bugs/abc/to-task', { executionId: '61', name: 'x' });
  check('接口：Bug 编号不是数字 → 400', bad.status === 400);
  const t1 = await call('POST', '/bugs/88/to-task', { executionId: '61', name: '【Bug#88】登录超时', type: 'devel' });
  check('接口：POST /bugs/:zid/to-task 成功', t1.success && t1.taskId === '900' && t1.linked);
  const t2 = await call('POST', '/bugs/88/to-task', { executionId: '61', name: '重复' });
  check('接口：重复转返回 ALREADY_LINKED', !t2.success && t2.code === 'ALREADY_LINKED');
  reset();
  const s1 = await call('POST', '/stories/120/tasks', { executionId: '61', tasks: [{ name: '设计', type: 'design' }, { name: '开发' }, { name: '' }] });
  check('接口：需求拆任务逐个创建，空标题那条失败不影响前面', s1.success && s1.data.created === 2 && s1.data.failed === 1 && s1.data.results[2].code === 'INVALID', JSON.stringify(s1.data && s1.data.results.map(r => r.success)));
  const lst = await call('GET', '/stories/120/tasks');
  check('接口：需求下任务列表 + 已关联的执行', lst.data.tasks.length === 2 && Array.isArray(lst.data.executionIds));
  const d1 = await call('POST', '/stories/120/tasks', { executionId: '61', tasks: [{ name: '同名' }, { name: '同名' }] });
  check('接口：同一次标题重复 → 400，什么都没建', d1.status === 400 && zt.tasks.length === 2);
  check('接口：空列表 / 超过 20 条 → 400', (await call('POST', '/stories/120/tasks', { executionId: '61', tasks: [] })).status === 400 && (await call('POST', '/stories/120/tasks', { executionId: '61', tasks: Array.from({ length: 21 }, (_, i) => ({ name: 't' + i })) })).status === 400);
} catch (err) {
  check(`异常：${err.stack}`, false);
} finally {
  server.close();
}

for (const x of results) console.log(`  ${x.pass ? '✓' : '✗'} ${x.name}${x.pass || !x.extra ? '' : `   → ${x.extra}`}`);
const passed = results.filter(x => x.pass).length;
console.log(`\n需求拆任务 / Bug 转任务：${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
