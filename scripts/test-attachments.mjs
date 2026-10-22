/**
 * 回归测试：任务 / Bug 附件（后端）
 *
 * 临时数据目录 + 模拟禅道（替换 globalThis.fetch，内存里维护附件、正文、动作），不读写真实 data/、不访问网络。
 *
 * 覆盖：
 *   - 类型 / 单文件 / 数量 / 总大小限制；文件名清理与路径穿越防护
 *   - 未同步到禅道：附件暂存本地（pending），不请求禅道
 *   - 拿到禅道 ID 后自动推送：一次编辑提交、图片插进正文、本地暂存文件删除、记下禅道文件 ID
 *   - Bug 走 bug-edit，图片插进「重现步骤」
 *   - 附件列表：本地 + 禅道（含网页上加的）；禅道里已删除的自动清理
 *   - 删除：未上传只删本地；已上传同时删禅道
 *   - 推送失败：标记失败、自动重试次数上限、手动重试
 *   - 并发推送不重复上传
 *   - 解决 Bug 时附图：随解决动作提交；失败时附件保留
 *   - 预览 / 下载：本地暂存与禅道转发；禅道返回 HTML 时报错
 *   - 删除记录清理待上传文件；更新任务不覆盖附件元数据
 */
import { mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeout = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return true;
    await sleep(30);
  }
  return false;
}

// ---------- 模拟禅道 ----------
const zentao = {
  nextFileId: 500,
  objects: { task: {}, bug: {} },   // id -> { body, files: [{id,title,extension,size,data}] }
  edits: 0,
  rejectEdits: 0,                   // 接下来 N 次编辑提交返回失败
  resolves: [],
  editorImages: 0,
  deletedFiles: [],
  editDelay: 20,
  realFetch: globalThis.fetch
};
const obj = (type, id) => (zentao.objects[type][id] ||= { body: '<p>原描述</p>', files: [] });
const json = (o) => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json' } });
let loginCount = 0;

async function readForm(body) {
  const fields = {};
  const files = [];
  for (const [k, v] of body.entries()) {
    if (k === 'files[]') files.push({ name: v.name, size: v.size, type: v.type, data: Buffer.from(await v.arrayBuffer()) });
    else (fields[k] ||= []).push(String(v));
  }
  return { fields, files };
}

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (!url.startsWith('http://z.test')) return zentao.realFetch(input, init);
  const method = (init.method || 'GET').toUpperCase();
  // 登录
  if (url.includes('user-refreshRandom')) return new Response('1234');
  if (url.includes('user-login') && method === 'GET') {
    loginCount++;
    return new Response('<html></html>', { headers: { 'Set-Cookie': `zentaosid=sid${loginCount}; path=/` } });
  }
  if (url.includes('user-login')) return json({ result: 'success' });

  let m;
  // 编辑表单
  if ((m = url.match(/\/zentao\/(task|bug)-edit-(\d+)\.html/))) {
    const [, type, id] = m;
    const o = obj(type, id);
    if (method === 'GET') {
      const bodyField = type === 'bug' ? 'steps' : 'desc';
      const titleField = type === 'bug' ? 'title' : 'name';
      return new Response(`<html><script>var kuid = 'uid${id}';</script><form>
        <input name='${titleField}' value='对象${id}'>
        <textarea name='${bodyField}'>${o.body.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</textarea>
        <input name='lastEditedDate' value='2026-10-21 10:00:00'>
        <select name='mailto[]' multiple><option value='a' selected>a</option><option value='b' selected>b</option></select>
        <input type='file' name='files[]'><input name='labels[]'>
      </form></html>`);
    }
    zentao.edits++;
    if (zentao.rejectEdits > 0) {
      zentao.rejectEdits--;
      return json({ result: 'fail', message: '模拟：禅道拒绝了提交' });
    }
    const { fields, files } = await readForm(init.body);
    o.lastFields = fields;
    o.body = (fields[type === 'bug' ? 'steps' : 'desc'] || [''])[0];
    const labels = fields['labels[]'] || [];
    files.forEach((f, i) => {
      const ext = f.name.includes('.') ? f.name.split('.').pop().toLowerCase() : '';
      o.files.push({ id: String(zentao.nextFileId++), title: labels[i] || f.name, extension: ext, size: f.size, data: f.data });
    });
    await sleep(zentao.editDelay); // 模拟网络耗时，便于暴露并发问题
    return new Response(`<script>parent.location='/zentao/${type}-view-${id}.html';</script>`);
  }
  // 详情 JSON（附件列表）
  if ((m = url.match(/\/zentao\/(task|bug)-view-(\d+)\.json/))) {
    const [, type, id] = m;
    // 模拟看板执行里的任务：不带 onlybody=yes 时禅道只返回跳转（2026-10-22 实测 #950）
    if (!/onlybody=yes/.test(url)) return json({ status: 'success', data: JSON.stringify({ locate: '/zentao/execution-kanban-149.json' }) });
    const o = obj(type, id);
    const files = Object.fromEntries(o.files.map(f => [f.id, { id: f.id, title: f.title, extension: f.extension, size: String(f.size), deleted: '0' }]));
    return json({ status: 'success', data: JSON.stringify({ [type]: { id, files } }) });
  }
  // 编辑器图片上传
  if ((m = url.match(/\/zentao\/file-ajaxUpload-(\w+)\.html/))) {
    zentao.editorImages++;
    return json({ error: 0, url: `/zentao/file-read-${9000 + zentao.editorImages}.png` });
  }
  // 删除附件
  if ((m = url.match(/\/zentao\/file-delete-(\d+)-yes\.html/))) {
    zentao.deletedFiles.push(m[1]);
    for (const t of ['task', 'bug']) for (const o of Object.values(zentao.objects[t])) o.files = o.files.filter(f => f.id !== m[1]);
    return new Response("<script>parent.location.reload();</script>");
  }
  // 读文件
  if ((m = url.match(/\/zentao\/file-(?:read|download)-(\d+)/))) {
    for (const t of ['task', 'bug']) for (const o of Object.values(zentao.objects[t])) {
      const f = o.files.find(x => x.id === m[1]);
      if (f) return new Response(f.data, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(f.data.length) } });
    }
    return new Response('<html>文件不存在</html>', { headers: { 'Content-Type': 'text/html' } });
  }
  // 解决 Bug
  if ((m = url.match(/\/zentao\/bug-resolve-(\d+)\.html/))) {
    const { fields, files } = await readForm(init.body);
    if ((fields.resolution || [''])[0] === 'reject') return json({ result: 'fail', message: { resolution: ['模拟：解决方案不合法'] } });
    const o = obj('bug', m[1]);
    const labels = fields['labels[]'] || [];
    files.forEach((f, i) => o.files.push({ id: String(zentao.nextFileId++), title: labels[i] || f.name, extension: f.name.split('.').pop(), size: f.size, data: f.data }));
    zentao.resolves.push({ id: m[1], files: files.length });
    return new Response("<script>parent.parent.ajaxRefresh()</script>");
  }
  return new Response('');
};

// ---------- 临时数据与服务 ----------
const tmp = mkdtempSync(join(tmpdir(), 'wa-attach-'));
const { config } = await import('../src/config.js');
config.paths.data = tmp;
config.paths.tasks = join(tmp, 'tasks.json');
Object.assign(config.zentao, { enabled: true, url: 'http://z.test', username: 'u', password: 'p' });

const now = new Date().toISOString();
writeFileSync(config.paths.tasks, JSON.stringify({ version: '1.0', tasks: [
  { id: 'task-a', type: 'task', title: '任务A', status: 'todo', priority: 3, createdAt: now, updatedAt: now },
  { id: 'task-b', type: 'task', title: '任务B', zentaoId: '700', status: 'todo', priority: 3, createdAt: now, updatedAt: now },
  { id: 'bug-a', type: 'bug', title: 'BugA', zentaoId: 516, status: 'activated', createdAt: now, updatedAt: now },
  { id: 'task-c', type: 'task', title: '任务C', zentaoId: '701', status: 'todo', priority: 3, createdAt: now, updatedAt: now },
  { id: 'task-d', type: 'task', title: '任务D', zentaoId: '703', status: 'todo', priority: 3, createdAt: now, updatedAt: now }
] }));

const apiRouter = (await import('../src/routes/api.js')).default;
const attachmentsRouter = (await import('../src/routes/attachments.js')).default;
const sync = await import('../src/services/attachmentSync.js');
const store = await import('../src/services/attachmentStore.js');
const app = express();
app.use(express.json());
app.use('/api', apiRouter);
app.use('/api', attachmentsRouter);
const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const BASE = `http://127.0.0.1:${server.address().port}`;
const call = (path, init = {}) => zentao.realFetch(`${BASE}${path}`, init);
const upload = (recordId, name, buf, q = {}) => call(
  `/api/records/${encodeURIComponent(recordId)}/attachments?${new URLSearchParams({ name, mime: q.mime || 'application/octet-stream', ...q })}`,
  { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf }
).then(async r => ({ status: r.status, ...(await r.json()) }));
const list = (recordId, remote = true) => call(`/api/records/${recordId}/attachments${remote ? '?remote=1' : ''}`).then(r => r.json());
const record = async (id) => (await store.getRecord(id));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005010201a5e2ae7b0000000049454e44ae426082', 'hex');

try {
  // ============ 限制与清理 ============
  let r = await upload('task-a', 'virus.exe', Buffer.from('MZ'));
  check('拦截可执行文件', r.status === 400 && /不支持的文件类型/.test(r.message), r.message);
  r = await upload('task-a', 'x.svg', Buffer.from('<svg/>'));
  check('拦截 SVG（可内嵌脚本）', r.status === 400);
  r = await upload('task-a', 'big.mp4', Buffer.alloc(50 * 1024 * 1024 + 10));
  check('单文件超过 50MB 被拒绝并给出原因', (r.status === 413 || r.status === 400) && /不能超过 50MB/.test(r.message) && !/当前 50\.0MB/.test(r.message), `${r.status} ${r.message}`);
  // 远超上限：在请求体解析阶段就被拒绝（不读完整个文件）
  r = await upload('task-a', 'huge.mp4', Buffer.alloc(52 * 1024 * 1024));
  check('远超 50MB：解析阶段即拒绝，返回可读原因', r.status === 413 && /50MB/.test(r.message), `${r.status} ${r.message}`);
  r = await upload('task-a', '../../etc/截图.png', PNG, { mime: 'image/png', inline: '1' });
  check('文件名去掉路径部分', r.success && r.data.name === '截图.png', r.data && r.data.name);
  r = await upload('../escape', 'a.png', PNG);
  check('非法记录 ID（路径穿越）被拒绝，不会写到数据目录之外', !r.success && !existsSync(join(tmp, 'escape')) && !existsSync(join(tmp, '..', 'escape')), `${r.status} ${r.message}`);

  // ============ 未同步到禅道：暂存本地 ============
  const editsBefore = zentao.edits;
  r = await upload('task-a', 'app.log', Buffer.from('log line\n'), { mime: 'text/plain' });
  let rec = await record('task-a');
  check('未同步到禅道：附件状态为待上传', rec.attachments.length === 2 && rec.attachments.every(a => a.status === 'pending'));
  check('未同步到禅道：文件暂存在本地', readdirSync(join(tmp, 'attachments', 'task-a')).length === 2);
  check('未同步到禅道：不请求禅道', zentao.edits === editsBefore);
  const pendingList = await list('task-a');
  check('附件列表显示待上传项', pendingList.items.length === 2 && pendingList.items.every(i => i.source === 'local' && i.status === 'pending'));
  const content = await call(`/api/records/task-a/attachments/${rec.attachments[0].id}/content`);
  check('待上传附件可预览（返回原始内容）', content.ok && Buffer.from(await content.arrayBuffer()).equals(PNG));

  // ============ 拿到禅道 ID → 自动推送 ============
  await call('/api/task/task-a', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ zentaoId: '702' }) });
  await waitFor(async () => (await record('task-a')).attachments.every(a => a.status === 'uploaded'));
  rec = await record('task-a');
  const z702 = zentao.objects.task['702'];
  check('拿到禅道 ID 后自动推送全部附件', rec.attachments.every(a => a.status === 'uploaded' && a.zentaoFileId), JSON.stringify(rec.attachments.map(a => [a.status, a.zentaoFileId])));
  check('一次编辑提交上传全部附件', zentao.edits === editsBefore + 1 && z702.files.length === 2, `edits=${zentao.edits - editsBefore} files=${z702 && z702.files.length}`);
  check('图片插进任务描述末尾，原描述保留', /^<p>原描述<\/p><p><img src="\/zentao\/file-read-\d+\.png"/.test(z702.body), z702.body);
  check('非图片不插进正文', (z702.body.match(/<img/g) || []).length === 1);
  check('附件标题去掉扩展名（禅道下载时自动补上）', z702.files.map(f => f.title).join(',') === '截图,app', z702.files.map(f => f.title).join(','));
  check('编辑表单其他字段原样带回（多选抄送）', (z702.lastFields['mailto[]'] || []).join(',') === 'a,b');
  // 先改状态、再删暂存文件：等删除完成再断言
  check('上传成功后删除本地暂存文件', await waitFor(() => !existsSync(join(tmp, 'attachments', 'task-a')), 2000));

  // ============ 附件列表：本地 + 禅道 ============
  z702.files.push({ id: String(zentao.nextFileId++), title: '网页上传', extension: 'pdf', size: 3, data: Buffer.from('pdf') });
  let lst = await list('task-a');
  check('禅道网页上加的附件也出现在列表', lst.items.length === 3 && lst.items.some(i => i.name === '网页上传.pdf' && i.source === 'zentao'), JSON.stringify(lst.items.map(i => i.name)));
  check('已上传的附件按禅道文件 ID 标识', lst.items.filter(i => i.key.startsWith('zentao:')).length === 3);

  const proxied = await call(`/api/zentao/files/${rec.attachments[0].zentaoFileId}/content?ext=png`);
  check('禅道附件经后端转发可预览', proxied.ok && Buffer.from(await proxied.arrayBuffer()).equals(PNG));
  const missing = await call('/api/zentao/files/99999/content?ext=png');
  check('禅道返回 HTML（文件不存在 / 会话失效）时不当成文件转发', missing.status === 502);

  // 禅道里删掉一个 → 本地清理
  const removedId = rec.attachments[1].zentaoFileId;
  z702.files = z702.files.filter(f => f.id !== removedId);
  lst = await list('task-a');
  await sleep(50);
  check('禅道里已删除的附件不再展示并清理本地记录', !lst.items.some(i => i.zentaoFileId === removedId) && (await record('task-a')).attachments.length === 1);

  // ============ 删除 ============
  const inlineUrl = rec.attachments[0].inlineUrl;
  const inlineId = (String(inlineUrl).match(/file-read-(\d+)/) || [])[1];
  check('截图上传时记下了正文图片地址', inlineUrl && z702.body.includes(inlineUrl), `${inlineUrl} / ${z702.body}`);
  const delResp = await call(`/api/records/task-a/attachments/zentao:${rec.attachments[0].zentaoFileId}`, { method: 'DELETE' }).then(x => x.json());
  check('删除已上传附件：同时删除禅道里的文件', delResp.success && !z702.files.some(f => f.id === rec.attachments[0].zentaoFileId) && (await record('task-a')).attachments.length === 0, JSON.stringify(delResp));
  check('删除图片附件：正文里对应的图片一起去掉，原描述保留', !/<img/.test(z702.body) && z702.body === '<p>原描述</p>', z702.body);
  check('删除图片附件：正文图片文件也从禅道删除', zentao.deletedFiles.includes(inlineId), JSON.stringify(zentao.deletedFiles));

  // 只在禅道里的图片附件（没有本地记录）：按 alt = 文件名、ID 小于附件 ID 找到正文里的那张
  z702.body = '<p>原描述</p><p><img src="/zentao/file-read-870.png" alt="网页图.png" /></p><p><img src="/zentao/file-read-871.png" /></p><p><img src="/zentao/file-read-880.png" alt="网页图.png" /></p>';
  z702.files.push({ id: '881', title: '网页图', extension: 'png', size: 3, data: Buffer.from('png') });
  const delRemote = await call('/api/records/task-a/attachments/zentao:881', { method: 'DELETE' }).then(x => x.json());
  check('只在禅道的图片附件：删除时去掉正文里同名的最近一张', delRemote.success && !z702.body.includes('file-read-880') && z702.body.includes('file-read-870'), z702.body);
  check('正文里在禅道网页上粘贴的图片（无对应附件）不受影响', z702.body.includes('file-read-871'), z702.body);
  z702.body = '<p>原描述</p>';
  r = await upload('task-a', 'note.txt', Buffer.from('x'), { push: '0' });
  const delLocal = await call(`/api/records/task-a/attachments/local:${r.data.id}`, { method: 'DELETE' }).then(x => x.json());
  await waitFor(async () => !(await record('task-a')).attachments.length, 500);
  check('删除未上传附件：只删本地', delLocal.success && (await record('task-a')).attachments.length === 0);

  // ============ 推送中途的附件列表 ============
  // 禅道已收到文件、本地还没回写禅道文件 ID 的那一两秒：不能把同一个附件列成两条
  zentao.editDelay = 400;
  r = await upload('task-d', '推送中截图.png', PNG, { mime: 'image/png' });
  await waitFor(() => (zentao.objects.task['703'] || { files: [] }).files.length === 1, 2000);
  const midList = await list('task-d');
  check('推送中途：禅道里已有、本地仍在上传 → 只显示 1 条（上传中）', midList.items.length === 1 && midList.items[0].status === 'uploading', JSON.stringify(midList.items.map(i => [i.key, i.status])));
  await waitFor(async () => (await record('task-d')).attachments.every(a => a.status === 'uploaded'), 3000);
  zentao.editDelay = 20;
  const doneList = await list('task-d');
  check('推送完成后仍是 1 条（已上传）', doneList.items.length === 1 && doneList.items[0].status === 'uploaded', JSON.stringify(doneList.items.map(i => [i.key, i.status])));

  // ============ Bug：走 bug-edit，图片插进重现步骤 ============
  await upload('bug-a', '复现截图.png', PNG, { mime: 'image/png', inline: '1' });
  await waitFor(async () => (await record('bug-a')).attachments.every(a => a.status === 'uploaded'));
  const z516 = zentao.objects.bug['516'];
  check('Bug 已同步：上传后立即推送到 bug-edit', z516 && z516.files.length === 1 && (await record('bug-a')).attachments[0].status === 'uploaded');
  check('Bug 截图插进重现步骤', z516 && /<img src="\/zentao\/file-read-\d+\.png" alt="复现截图.png"/.test(z516.body), z516 && z516.body);

  // ============ 推送失败与重试 ============
  zentao.rejectEdits = 100;
  await upload('task-b', 'fail.txt', Buffer.from('x'));
  await waitFor(async () => (await record('task-b')).attachments[0].status === 'failed');
  let fa = (await record('task-b')).attachments[0];
  check('禅道拒绝：标记失败并记录原因', fa.status === 'failed' && /模拟/.test(fa.error) && fa.attempts === 1, JSON.stringify(fa));
  for (let i = 0; i < 6; i++) await sync.retryAllPending();
  fa = (await record('task-b')).attachments[0];
  check('自动重试到上限后停止', fa.attempts === store.MAX_ATTEMPTS, `attempts=${fa.attempts}`);
  zentao.rejectEdits = 0;
  await sync.retryAllPending();
  check('超过上限后自动重试不再触发', (await record('task-b')).attachments[0].status === 'failed');
  const manual = await call('/api/records/task-b/attachments/sync', { method: 'POST' }).then(x => x.json());
  check('手动重试成功', manual.success && manual.uploaded === 1 && (await record('task-b')).attachments[0].status === 'uploaded', JSON.stringify(manual));

  // ============ 并发推送不重复上传 ============
  const filesBefore = (zentao.objects.task['701'] || { files: [] }).files.length;
  await upload('task-c', 'c1.txt', Buffer.from('1'), { push: '0' });
  await upload('task-c', 'c2.txt', Buffer.from('2'), { push: '0' });
  await Promise.all([sync.pushRecordAttachments('task-c'), sync.pushRecordAttachments('task-c'), sync.pushRecordAttachments('task-c')]);
  check('三次并发推送只上传一次', zentao.objects.task['701'].files.length - filesBefore === 2, `${zentao.objects.task['701'].files.length - filesBefore} 个`);

  // ============ 解决 Bug 时附图 ============
  const held = await upload('bug-a', '验证截图.png', PNG, { mime: 'image/png', hold: '1' });
  check('暂扣的附件不走后台推送', held.data.status === 'held');
  await sleep(100);
  check('暂扣的附件确实没有被推送', (await record('bug-a')).attachments.find(a => a.id === held.data.id).status === 'held');
  const badResolve = await call('/api/zentao/bug/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bugId: 516, resolution: 'reject', localId: 'bug-a', attachmentIds: [held.data.id] }) }).then(x => x.json());
  check('解决失败：返回原因，附件保持暂扣可重新提交', !badResolve.success && (await record('bug-a')).attachments.find(a => a.id === held.data.id).status === 'held', JSON.stringify(badResolve));
  const goodResolve = await call('/api/zentao/bug/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bugId: 516, resolution: 'fixed', localId: 'bug-a', attachmentIds: [held.data.id] }) }).then(x => x.json());
  const heldAfter = (await record('bug-a')).attachments.find(a => a.id === held.data.id);
  check('解决 Bug：附件随解决动作提交', goodResolve.success && zentao.resolves.length === 1 && zentao.resolves[0].files === 1, JSON.stringify(goodResolve));
  check('解决 Bug：附件标记已上传并记下禅道文件 ID', heldAfter.status === 'uploaded' && heldAfter.zentaoFileId);

  // ============ 数量 / 总大小限制 ============
  for (let i = 0; i < 9; i++) await upload('task-c', `n${i}.txt`, Buffer.from('n'), { push: '0' });
  r = await upload('task-c', 'eleven.txt', Buffer.from('x'), { push: '0' });
  check('每条最多 10 个附件', r.status === 400 && /最多 10/.test(r.message), r.message);
  await upload('task-b', 'v1.mp4', Buffer.alloc(45 * 1024 * 1024), { push: '0' });
  await upload('task-b', 'v2.mp4', Buffer.alloc(45 * 1024 * 1024), { push: '0' });
  r = await upload('task-b', 'v3.mp4', Buffer.alloc(20 * 1024 * 1024), { push: '0' });
  check('附件总大小不超过 100MB', r.status === 400 && /100MB/.test(r.message), r.message);

  // ============ 更新任务不覆盖附件；删除记录清理暂存 ============
  const countBefore = (await record('task-b')).attachments.length;
  await call('/api/task/task-b', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ priority: 1, attachments: [] }) });
  check('更新任务时带着旧 attachments 不会覆盖附件元数据', (await record('task-b')).attachments.length === countBefore);
  check('删除前 task-b 有暂存文件', existsSync(join(tmp, 'attachments', 'task-b')));
  await call('/api/task/task-b', { method: 'DELETE' });
  check('删除任务时清理它的待上传文件', !existsSync(join(tmp, 'attachments', 'task-b')));
} finally {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
}

for (const x of results) {
  console.log(`  ${x.pass ? '✓' : '✗'} ${x.name}${x.pass || !x.extra ? '' : `   → ${x.extra}`}`);
}
const passed = results.filter(x => x.pass).length;
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
