/**
 * 回归测试：卡片操作的后端部分
 *   - 在浏览器里打开禅道页面：浏览器会话有效则直接打开；失效则返回新会话 cookie；看板任务用 onlybody 页
 *   - 修改所属执行：未同步只改本地；禅道允许则直接移动；不允许时要求确认；确认后重建
 *     （新建任务、复制字段与附件、进行中则开始、取消旧任务、本地改指向并映射附件 ID）
 *
 * 临时数据目录 + 模拟禅道（替换 globalThis.fetch），不读写真实 data/，不访问网络。
 */
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });

// ---------- 模拟禅道 ----------
const realFetch = globalThis.fetch;
const zt = {
  nextTaskId: 900,
  nextFileId: 700,
  validSids: new Set(),
  kanbanTasks: new Set(['950']),
  tasks: {
    '952': { id: '952', name: '阿迪新增confirmed小程序', desc: '<p>描述<img src="/zentao/file-read-10.png"></p>', pri: '2', deadline: '2026-10-30', estimate: '4', left: '3', status: 'doing', assignedTo: 'lijc', type: 'devel', execution: '149', allowed: ['149'], files: [{ id: '11', title: '截图', extension: 'png', data: Buffer.from('img-bytes') }] },
    '944': { id: '944', name: '同项目任务', desc: '', pri: '3', deadline: '0000-00-00', estimate: '0', left: '0', status: 'wait', assignedTo: 'lijc', type: 'devel', execution: '54', allowed: ['54', '55'], files: [] },
    '960': { id: '960', name: '已关闭任务', desc: '', pri: '3', status: 'closed', execution: '149', allowed: ['149'], files: [] }
  },
  created: [],
  actions: [],
  edits: []
};
const json = (o) => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });
const zjson = (inner) => json({ status: 'success', data: JSON.stringify(inner) });
let loginCount = 0;

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (!url.startsWith('http://z.test')) return realFetch(input, init);
  const method = (init.method || 'GET').toUpperCase();
  const cookie = new Headers(init.headers || {}).get('Cookie') || '';
  const sid = (cookie.match(/zentaosid=([^;]+)/) || [])[1];
  if (url.includes('user-refreshRandom')) return new Response('1234');
  if (url.includes('user-login') && method === 'GET') {
    const s = `sid${++loginCount}`;
    zt.validSids.add(s);
    return new Response('', { headers: { 'Set-Cookie': `zentaosid=${s}; path=/zentao/; HttpOnly` } });
  }
  if (url.includes('user-login')) return json({ result: 'success' });
  if (sid && !zt.validSids.has(sid)) return json({ result: false, message: '登录已超时，请重新登入!' });

  let m;
  if (url.includes('/zentao/my-task-')) return zjson({ tasks: [], pager: { pageTotal: 1 } });
  if ((m = url.match(/\/zentao\/task-view-(\d+)\.json(\?onlybody=yes)?/))) {
    const t = zt.tasks[m[1]];
    if (!m[2] && zt.kanbanTasks.has(m[1])) return zjson({ locate: '/zentao/execution-kanban-149.json' });
    if (!t) return zjson({ locate: '/zentao/' });
    return zjson({ task: { ...t, files: Object.fromEntries(t.files.map(f => [f.id, { id: f.id, title: f.title, extension: f.extension, size: String(f.data.length), deleted: '0' }])) } });
  }
  if ((m = url.match(/\/zentao\/task-edit-(\d+)\.html/))) {
    const t = zt.tasks[m[1]];
    if (method === 'GET') {
      return new Response(`<script>var kuid = 'k${m[1]}';</script><form>
        <input name='name' value='${t.name}'><input name='lastEditedDate' value='2026-10-22 10:00:00'>
        <select name='execution'>${t.allowed.map(e => `<option value='${e}'${e === t.execution ? ' selected' : ''}>执行${e}</option>`).join('')}</select>
        <textarea name='desc'>${t.desc.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea></form>`);
    }
    const fields = {};
    const files = [];
    if (init.body instanceof FormData) {
      for (const [k, v] of init.body.entries()) {
        if (k === 'files[]') files.push({ name: v.name, data: Buffer.from(await v.arrayBuffer()) });
        else fields[k] = String(v);
      }
    } else {
      for (const [k, v] of new URLSearchParams(String(init.body))) fields[k] = v;
    }
    zt.edits.push({ id: m[1], fields, files: files.length });
    if (fields.execution) t.execution = fields.execution;
    const labels = [];
    if (init.body instanceof FormData) for (const [k, v] of init.body.entries()) if (k === 'labels[]') labels.push(String(v));
    files.forEach((f, i) => t.files.push({ id: String(zt.nextFileId++), title: labels[i] || f.name, extension: f.name.split('.').pop(), data: f.data }));
    return new Response(`<script>parent.location='/zentao/task-view-${m[1]}.html';</script>`);
  }
  if ((m = url.match(/\/zentao\/task-create-(\d+)/))) {
    const body = new URLSearchParams(String(init.body));
    const id = String(zt.nextTaskId++);
    zt.tasks[id] = { id, name: body.get('name'), desc: body.get('desc'), pri: body.get('pri'), deadline: body.get('deadline'), estimate: body.get('estimate'), left: body.get('estimate'), status: 'wait', assignedTo: body.get('assignedTo[]'), type: body.get('type'), execution: m[1], allowed: [m[1]], files: [] };
    zt.created.push({ id, exec: m[1], url, fields: Object.fromEntries(body) });
    return json({ result: 'success', id });
  }
  if ((m = url.match(/\/zentao\/task-(start|cancel)-(\d+)\.html/))) {
    if (method === 'GET') return new Response(`<form><input name='consumed' value='0'><input name='left' value='3'><textarea name='comment'></textarea></form>`);
    const body = new URLSearchParams(String(init.body));
    zt.actions.push({ action: m[1], id: m[2], comment: body.get('comment') });
    zt.tasks[m[2]].status = m[1] === 'start' ? 'doing' : 'cancel';
    return new Response('<script>parent.parent.ajaxRefresh()</script>');
  }
  if ((m = url.match(/\/zentao\/file-download-(\d+)-download\.html/))) {
    for (const t of Object.values(zt.tasks)) {
      const f = (t.files || []).find(x => x.id === m[1]);
      if (f) return new Response(f.data, { headers: { 'Content-Type': 'application/octet-stream' } });
    }
    return new Response('<html>no</html>', { headers: { 'Content-Type': 'text/html' } });
  }
  if (url.includes('file-ajaxUpload')) return json({ error: 0, url: '/zentao/file-read-1.png' });
  return new Response('');
};

// ---------- 临时数据与服务 ----------
const tmp = mkdtempSync(join(tmpdir(), 'wa-card-'));
const { config } = await import('../src/config.js');
config.paths.data = tmp;
config.paths.tasks = join(tmp, 'tasks.json');
Object.assign(config.zentao, { enabled: true, url: 'http://z.test', username: 'u', password: 'p' });
const now = new Date().toISOString();
writeFileSync(config.paths.tasks, JSON.stringify({ version: '1.0', tasks: [
  { id: 'local-1', type: 'task', title: '本地任务', executionId: '167', executionName: '工作日志', status: 'todo', createdAt: now, updatedAt: now },
  { id: 'synced-952', type: 'task', title: '阿迪新增confirmed小程序', zentaoId: '952', executionId: '149', executionName: '阿迪达斯项目交付', status: 'in_progress', createdAt: now, updatedAt: now,
    attachments: [{ id: 'a1', name: '截图.png', status: 'uploaded', zentaoFileId: '11', size: 9, createdAt: now }] },
  { id: 'synced-944', type: 'task', title: '同项目任务', zentaoId: '944', executionId: '54', executionName: '开发', status: 'todo', createdAt: now, updatedAt: now },
  { id: 'closed-960', type: 'task', title: '已关闭任务', zentaoId: '960', executionId: '149', status: 'done', createdAt: now, updatedAt: now }
] }));
writeFileSync(join(tmp, 'executions.json'), JSON.stringify({ executions: [
  { id: '54', name: '开发', projectId: '51', projectName: '主动网络探测', type: 'stage', status: 'doing' },
  { id: '55', name: '测试', projectId: '51', projectName: '主动网络探测', type: 'stage', status: 'doing' },
  { id: '149', name: '阿迪达斯项目交付', projectId: '119', projectName: '阿迪达斯', type: 'kanban', status: 'doing' },
  { id: '167', name: '2026 年工作日志记录', projectId: '166', projectName: '工作日志', type: 'stage', status: 'doing' },
  { id: '174', name: '华夏银行 2026 交付', projectId: '173', projectName: '华夏银行', type: 'sprint', status: 'doing' }
], favoriteExecutionIds: [] }));

const apiRouter = (await import('../src/routes/api.js')).default;
const store = await import('../src/services/attachmentStore.js');
const app = express();
app.use(express.json());
app.use('/api', apiRouter);
const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const call = (path, body) => realFetch(`http://127.0.0.1:${server.address().port}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
}).then(async r => ({ status: r.status, ...(await r.json()) }));

try {
  // ============ 在浏览器里打开禅道页面 ============
  zt.validSids.add('browser-ok');
  let r = await call('/api/zentao/open', { type: 'task', id: '944', browserSid: 'browser-ok' });
  check('浏览器会话有效：直接打开，不下发新会话', r.success && r.cookies === null && r.url === 'http://z.test/zentao/index-index.html#app=execution&url=' + encodeURIComponent('/zentao/task-view-944.html'), JSON.stringify(r));
  const loginsBefore = loginCount;
  r = await call('/api/zentao/open', { type: 'task', id: '944', browserSid: 'expired-sid' });
  check('浏览器会话失效：单独登录一次，返回要写入的会话 cookie', r.success && Array.isArray(r.cookies) && r.cookies[0].name === 'zentaosid' && r.cookies[0].path === '/zentao/' && r.cookies[0].httpOnly === true && loginCount === loginsBefore + 1, JSON.stringify(r.cookies));
  r = await call('/api/zentao/open', { type: 'task', id: '944' });
  check('浏览器里没有会话：同样自动登录', r.success && r.cookies && r.cookies.length === 1);
  r = await call('/api/zentao/open', { type: 'task', id: '950', browserSid: 'browser-ok' });
  check('看板执行里的任务：主框架里打开 onlybody 详情页（避免被跳到整个看板）', r.url === 'http://z.test/zentao/index-index.html#app=execution&url=' + encodeURIComponent('/zentao/task-view-950.html?onlybody=yes'), r.url);
  r = await call('/api/zentao/open', { type: 'bug', id: '308', browserSid: 'browser-ok' });
  check('Bug：在「测试」应用里打开 Bug 详情页', r.url === 'http://z.test/zentao/index-index.html#app=qa&url=' + encodeURIComponent('/zentao/bug-view-308.html'), r.url);
  check('直接打开禅道主框架地址（单独打开详情页会被禅道脚本再跳一次）', /\/zentao\/index-index\.html#app=/.test(r.url));
  r = await call('/api/zentao/open', { type: 'story', id: '1' });
  check('非法类型被拒绝', r.status === 400);

  // ============ 新建任务：截止日期格式 ============
  // 新建任务表单是 datetime-local，存下来是 2026-10-30T13:51，原样提交禅道会报「截止日期应当为合法的日期」
  const createdCount = zt.created.length;
  r = await call('/api/zentao/task/create', { name: '截止日期带时刻', executionId: '54', dueDate: '2026-10-30T13:51', estStarted: '2026-10-22 09:00' });
  const dated = zt.created[createdCount];
  check('新建任务：截止日期带时刻 → 按 YYYY-MM-DD 提交', r.success && dated && dated.fields.deadline === '2026-10-30' && dated.fields.estStarted === '2026-10-22', JSON.stringify(dated && dated.fields));
  const { toZentaoDate } = await import('../src/services/zentaoService.js');
  check('日期规整：只有日期 / 带秒 / 个位月日 / 空日期', toZentaoDate('2026-10-30') === '2026-10-30' && toZentaoDate('2026-10-30 18:00:00') === '2026-10-30' && toZentaoDate('2026-1-5') === '2026-01-05' && toZentaoDate('0000-00-00') === '' && toZentaoDate('') === '' && toZentaoDate('abc') === '');
  const utc = new Date(2026, 9, 30, 1, 0).toISOString();
  check('日期规整：带时区的 ISO 时间按本地日期取', toZentaoDate(utc) === '2026-10-30', `${utc} → ${toZentaoDate(utc)}`);

  // ============ 修改所属执行 ============
  r = await call('/api/tasks/local-1/execution', { executionId: '174' });
  let t = await store.getRecord('local-1');
  check('未同步任务：只改本地', r.success && r.mode === 'local' && t.executionId === '174' && t.executionName === '华夏银行 2026 交付' && t.projectName === '华夏银行', JSON.stringify(r));
  check('未同步任务：不请求禅道编辑', zt.edits.length === 0);

  r = await call('/api/tasks/synced-944/execution', { executionId: '55' });
  t = await store.getRecord('synced-944');
  check('已同步、同项目：在禅道里直接移动', r.success && r.mode === 'moved' && zt.tasks['944'].execution === '55' && t.executionId === '55', JSON.stringify(r));

  const createdBefore = zt.created.length;
  r = await call('/api/tasks/synced-952/execution', { executionId: '174' });
  check('已同步、跨项目：不直接动，要求确认重建', !r.success && r.needRebuild && r.executionName === '华夏银行 2026 交付' && zt.created.length === createdBefore, JSON.stringify(r));

  r = await call('/api/tasks/synced-952/execution', { executionId: '174', rebuild: true });
  t = await store.getRecord('synced-952');
  const created = zt.created[zt.created.length - 1];
  check('重建：在目标执行新建任务', r.success && r.mode === 'rebuilt' && created && created.exec === '174' && r.newZentaoId === created.id, JSON.stringify(r));
  check('重建：复制标题、描述、优先级、截止日期、剩余工时', created.fields.name === '阿迪新增confirmed小程序' && /描述/.test(created.fields.desc) && created.fields.pri === '2' && created.fields.deadline === '2026-10-30' && created.fields.estimate === '3', JSON.stringify(created.fields));
  check('重建：原任务进行中 → 新任务也开始', zt.actions.some(a => a.action === 'start' && a.id === created.id));
  check('重建：附件复制到新任务', zt.tasks[created.id].files.length === 1 && zt.tasks[created.id].files[0].data.toString() === 'img-bytes');
  const cancel = zt.actions.find(a => a.action === 'cancel' && a.id === '952');
  check('重建：旧任务在禅道里取消，并注明新任务', cancel && new RegExp(`#${created.id}`).test(cancel.comment), JSON.stringify(cancel));
  check('重建：本地任务指向新任务与新执行，保留原 ID 记录', t.zentaoId === created.id && t.executionId === '174' && (t.previousZentaoIds || []).includes('952'));
  check('重建：本地附件的禅道文件 ID 换成新任务里的副本', t.attachments[0].zentaoFileId === zt.tasks[created.id].files[0].id, JSON.stringify(t.attachments));

  r = await call('/api/tasks/closed-960/execution', { executionId: '174', rebuild: true });
  check('已关闭的任务不支持换执行', !r.success && /已完成或已关闭/.test(r.message), JSON.stringify(r));
  r = await call('/api/tasks/local-1/execution', { executionId: '99999' });
  check('目标执行不存在时给出原因', !r.success && /不存在/.test(r.message));
} finally {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}

for (const x of results) console.log(`  ${x.pass ? '✓' : '✗'} ${x.name}${x.pass || !x.extra ? '' : `   → ${x.extra}`}`);
const passed = results.filter(x => x.pass).length;
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
