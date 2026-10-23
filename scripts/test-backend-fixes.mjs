/**
 * 回归测试：docs/AUDIT-2026-10-21.md 中修复的后端问题
 *
 * 全程使用临时数据目录 + 模拟禅道（替换 globalThis.fetch），不读写真实 data/，不访问网络。
 *
 * 覆盖：
 *   B1 同步任务不再把 Bug 改成 Task，任务 #N 与 Bug #N 互不去重
 *   B2 同类型重复记录去重不再抛 TypeError
 *   B3 并发写入不丢数据
 *   B4 字段无变化时不刷新 updatedAt
 *   备份按源文件分别保留
 *   A1 「我的任务」自动翻页
 *   A2 执行列表解析（引号、类型标签、项目 ID、中文状态）
 *   A3/A5 会话失效自动重登并重试；并发请求只登录一次
 *   A4 超时错误给出可读提示
 *   C1/E1 请求来源校验
 *   E3 .env 写入拒绝换行注入
 */
import { mkdtempSync, readdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { join } from 'path';

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });

// ---------- 模拟禅道 ----------
const mock = { handler: null, calls: [] };
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  mock.calls.push({ url, init });
  return mock.handler(url, init);
};
const jsonResp = (obj, { status = 200, headers = {} } = {}) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json', ...headers }
});
const zentaoJson = (inner) => jsonResp({ status: 'success', data: JSON.stringify(inner) });

// 登录三步：user-login(GET) → refreshRandom → user-login(POST)，每次登录发一个新 sid
let loginCount = 0;
function loginHandler(url, init) {
  if (url.includes('user-refreshRandom')) return new Response('1234');
  if (url.includes('user-login') && (init.method || 'GET') === 'GET') {
    loginCount++;
    return new Response('<html></html>', { headers: { 'Set-Cookie': `zentaosid=sid${loginCount}; path=/` } });
  }
  if (url.includes('user-login')) return jsonResp({ result: 'success' }, { headers: { 'Set-Cookie': 'za=lijc; path=/' } });
  return null;
}

// ---------- 临时数据目录 ----------
const tmp = mkdtempSync(join(tmpdir(), 'wa-test-'));
const { config, updateEnvFile } = await import('../src/config.js');
config.paths.data = tmp;
config.paths.tasks = join(tmp, 'tasks.json');
config.paths.history = join(tmp, 'history.json');
Object.assign(config.zentao, { enabled: true, url: 'http://z.test', username: 'u', password: 'p' });

const storage = await import('../src/utils/storage.js');
const { importZentaoTasks, getAllTasks } = await import('../src/services/taskManager.js');
const { importZentaoBugs, createBugWithSync } = await import('../src/services/bugManager.js');
const zs = await import('../src/services/zentaoService.js');
const { createRequestGuard, extensionIdFromPath } = await import('../src/utils/requestGuard.js');

const seed = (tasks) => writeFileSync(config.paths.tasks, JSON.stringify({ version: '1.0', tasks }, null, 2));
const read = async () => (await storage.readTasks()).tasks;
const OLD = '2026-01-01T00:00:00.000Z';

try {
  // ============ B1：任务同步不碰 Bug，同号任务与 Bug 并存 ============
  seed([
    { id: 'b496', type: 'bug', zentaoId: 496, title: '测试步骤未提供', severity: 3, status: 'unconfirmed', createdAt: OLD, updatedAt: '2026-02-01T00:00:00.000Z' },
    { id: 't496', type: 'task', zentaoId: '496', title: '任务496', status: 'todo', priority: 3, progress: 0, totalConsumedTime: 0, createdAt: OLD, updatedAt: OLD }
  ]);
  await importZentaoTasks([{ zentaoId: '496', title: '任务496', status: 'todo', priority: 3, progress: 0, consumed: 0 }]);
  let all = await read();
  const bug = all.find(t => t.id === 'b496');
  check('B1 同步任务后 Bug 仍是 type=bug', bug && bug.type === 'bug', JSON.stringify(bug && bug.type));
  check('B1 任务 #496 与 Bug #496 都保留（不互相去重）', all.length === 2, `剩 ${all.length} 条`);
  check('B4 任务字段无变化时 updatedAt 不变', all.find(t => t.id === 't496').updatedAt === OLD);

  await importZentaoTasks([{ zentaoId: '496', title: '任务496', status: 'in_progress', priority: 3, progress: 10, consumed: 1 }]);
  all = await read();
  check('B4 任务字段变化时才刷新 updatedAt', all.find(t => t.id === 't496').updatedAt !== OLD);

  seed([{ id: 'm1', type: 'task', zentaoId: '706', title: '老任务', status: 'done', priority: 3, progress: 100, totalConsumedTime: 2, executionName: '/旧名', createdAt: OLD, updatedAt: OLD }]);
  await importZentaoTasks([{ zentaoId: '706', title: '老任务', status: 'done', priority: 3, progress: 100, consumed: 2, executionName: '新名', projectName: '项目', projectId: '173' }]);
  all = await read();
  check('只补全执行/项目名时更新字段但不刷新 updatedAt（已完成任务不会被挪到今天）',
    all[0].executionName === '新名' && all[0].projectId === '173' && all[0].updatedAt === OLD, JSON.stringify(all[0]));

  seed([{ id: 'p1', type: 'task', zentaoId: '944', title: '零工时', status: 'in_progress', priority: 3, progress: 28, createdAt: OLD, updatedAt: OLD }]);
  await importZentaoTasks([{ zentaoId: '944', title: '零工时', status: 'in_progress', priority: 3, progress: null, consumed: 0 }]);
  check('禅道算不出进度（未填预计工时）时保留本地进度', (await read())[0].progress === 28);

  seed([
    { id: 'b496', type: 'bug', zentaoId: 496, title: '测试步骤未提供', severity: 3, status: 'unconfirmed', createdAt: OLD, updatedAt: '2026-02-01T00:00:00.000Z' },
    { id: 't496', type: 'task', zentaoId: '496', title: '任务496', status: 'in_progress', priority: 3, progress: 10, totalConsumedTime: 1, createdAt: OLD, updatedAt: OLD }
  ]);
  const listed = await getAllTasks();
  check('B1 读侧去重不再把同号任务/Bug 合并', listed.length === 2, `返回 ${listed.length} 条`);

  // ============ B1b：日期视图包含「那天填过工时」的任务（补填后任务页能看到） ============
  {
    const es = await import('../src/services/effortService.js');
    es._caches.mine.write({ syncedAt: Date.now(), tasks: {
      721: { sig: 'a', at: Date.now(), name: '补填的任务', exec: '', efforts: [{ id: '1', account: 'u', date: '2026-10-09', consumed: 3, left: 0, work: 'x' }] },
      722: { sig: 'b', at: Date.now(), name: '别人的', exec: '', efforts: [{ id: '2', account: 'other', date: '2026-10-09', consumed: 3, left: 0, work: 'x' }] }
    } });
    seed([
      { id: 'w1', type: 'task', zentaoId: '721', title: '补填的任务', status: 'done', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z' },
      { id: 'w2', type: 'task', zentaoId: '722', title: '别人的', status: 'done', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z' },
      { id: 'w3', type: 'bug', zentaoId: '721', title: '同号 Bug', status: 'done', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z' }
    ]);
    const day = await getAllTasks({ date: '2026-10-09' });
    check('B1b 已完成、完成日不在当天，但当天填过工时的任务出现在当天', day.some(t => t.id === 'w1'), JSON.stringify(day.map(t => t.id)));
    check('B1b 别人填的工时 / 同号 Bug 不会把任务带进来', !day.some(t => t.id === 'w2') && !day.some(t => t.id === 'w3'));
    const other = await getAllTasks({ date: '2026-10-10' });
    check('B1b 没填工时的其他日子不受影响', !other.some(t => t.id === 'w1'));
  }

  // ============ B2：同类型重复记录去重不抛错 ============
  seed([
    { id: 'a', type: 'task', zentaoId: '700', title: 'x', createdAt: OLD, updatedAt: OLD },
    { id: 'b', type: 'task', zentaoId: 700, title: 'x', createdAt: OLD, updatedAt: '2026-03-01T00:00:00.000Z' }
  ]);
  let threw = null;
  try {
    await importZentaoTasks([{ zentaoId: '701', title: 'y', status: 'todo', priority: 3, progress: 0 }]);
  } catch (e) { threw = e; }
  all = await read();
  check('B2 有重复时导入不抛 TypeError', !threw, threw && threw.message);
  check('B2 同类型重复只保留最新一条', all.filter(t => String(t.zentaoId) === '700').map(t => t.id).join() === 'b');
  check('B5 写入保留 version 字段', (await storage.readTasks()).version === '1.0');

  // ============ Bug 导入：状态刷新、ID 为数字、无变化不刷新 ============
  seed([{ id: 'b1', type: 'bug', zentaoId: '516', title: 'bug516', status: 'unconfirmed', severity: 3, priority: 3, createdAt: OLD, updatedAt: OLD }]);
  await importZentaoBugs([{ zentaoId: 516, title: 'bug516', status: 'unconfirmed', severity: 3, priority: 3 }]);
  all = await read();
  check('Bug 导入：无变化不刷新 updatedAt', all[0].updatedAt === OLD);
  check('Bug 导入：zentaoId 统一为数字', all[0].zentaoId === 516);
  await importZentaoBugs([{ zentaoId: 516, title: 'bug516', status: 'resolved', severity: 3, priority: 3 }]);
  check('Bug 导入：状态变化被同步', (await read())[0].status === 'resolved');

  // ============ B3：并发写入不丢数据 ============
  seed([]);
  await Promise.all([
    ...Array.from({ length: 10 }, (_, i) => createBugWithSync({ title: `并发Bug${i}` })),
    importZentaoTasks(Array.from({ length: 10 }, (_, i) => ({ zentaoId: String(900 + i), title: `并发任务${i}`, status: 'todo', priority: 3, progress: 0 })))
  ]);
  all = await read();
  check('B3 并发 10 个建 Bug + 一次批量导入 10 个任务，一条不丢', all.length === 20, `实际 ${all.length} 条`);

  // ============ 备份按源文件分别保留 ============
  const backups = readdirSync(join(tmp, 'backups'));
  check('备份文件名带源文件前缀', backups.length > 0 && backups.every(f => f.startsWith('tasks__')), backups.slice(0, 2).join(','));
  check('每个源文件最多保留 10 份备份', backups.length <= 10, `${backups.length} 份`);

  // ============ A3：并发请求只登录一次 ============
  zs.clearCookies();
  loginCount = 0;
  mock.handler = (url, init) => loginHandler(url, init) || zentaoJson({ tasks: [], pager: { pageTotal: 1 } });
  await Promise.all([zs.getZentaoCookies(), zs.getZentaoCookies(), zs.getZentaoCookies()]);
  check('A3 三个并发请求只触发一次登录', loginCount === 1, `登录 ${loginCount} 次`);

  // ============ A5：会话失效自动重登并重试 ============
  mock.handler = (url, init) => {
    const lr = loginHandler(url, init);
    if (lr) return lr;
    const cookie = new Headers(init.headers).get('Cookie') || '';
    if (url.includes('/zentao/my-task')) {
      if (cookie.includes('zentaosid=sid1')) {
        return jsonResp({ result: false, message: '登录已超时，请重新登入!' });
      }
      return zentaoJson({ tasks: [{ id: 1, name: 'ok', status: 'wait' }], pager: { pageTotal: 1 } });
    }
    return new Response('');
  };
  const before = loginCount;
  const tasks = await zs.getMyTasks();
  check('A5 会话失效后自动重新登录', loginCount === before + 1, `登录 ${loginCount - before} 次`);
  check('A5 重登后重试拿到数据', tasks.length === 1 && tasks[0].name === 'ok', JSON.stringify(tasks));

  // ============ A1：自动翻页 ============
  mock.calls = [];
  mock.handler = (url, init) => {
    const lr = loginHandler(url, init);
    if (lr) return lr;
    const page = Number((url.match(/-(\d+)\.json$/) || [])[1]);
    const ids = page === 1 ? [1, 2] : [3];
    return zentaoJson({ tasks: ids.map(id => ({ id, name: `t${id}`, status: 'wait' })), pager: { recTotal: 3, pageTotal: 2, pageID: page } });
  };
  const paged = await zs.getMyTasks();
  const listCalls = mock.calls.filter(c => c.url.includes('/zentao/my-task-'));
  check('A1 「我的任务」拉取全部分页', paged.length === 3 && listCalls.length === 2, `${paged.length} 条 / ${listCalls.length} 次请求`);
  check('A1 每页条数为 500', listCalls.every(c => /-0-500-\d+\.json$/.test(c.url)), listCalls[0] && listCalls[0].url);

  // ============ A2：执行列表解析 ============
  const execs = [
    { id: '41', project: '真机拨测项目', path: ',39,41,', type: 'kanban', status: '进行中', deleted: '0',
      name: "<span class='project-type-label'>看板</span> <a href='/zentao/execution-kanban-41.html'>*2024年真机拨测看板</a>\n<span class=\"label\">已延期</span>",
      projectName: '真机拨测项目' },
    { id: '8', project: '上海张园小程序', path: ',7,8,', type: 'stage', status: '已关闭', deleted: '0',
      name: "<span>阶段</span> <a href='/x'>需求 \"引号\"</a>", projectName: '上海张园小程序' },
    { id: '99', project: 'x', path: ',1,99,', type: 'sprint', status: '进行中', deleted: '1', name: '<a>已删除</a>' }
  ];
  const escaped = JSON.stringify(JSON.stringify(execs)).slice(1, -1);
  mock.handler = (url, init) => loginHandler(url, init) ||
    new Response(`<html><script>data = "${escaped}"</script><div>…</div></html>`);
  const parsed = await zs.getExecutions();
  check('A2 解析执行列表（不再恒为空）', parsed.length === 2, `${parsed.length} 个`);
  check('A2 名称取链接文字而不是类型标签', parsed[0].name === '*2024年真机拨测看板' && parsed[1].name === '需求 "引号"', parsed.map(e => e.name).join(' | '));
  check('A2 项目 ID 取自 path', parsed[0].projectId === '39' && parsed[1].projectId === '7');
  check('A2 中文状态转为状态码', parsed[0].status === 'doing' && parsed[1].status === 'closed');
  check('A2 已删除的执行被过滤', !parsed.some(e => e.id === '99'));

  mock.handler = (url, init) => loginHandler(url, init) || new Response('<html>no data</html>');
  let execErr = null;
  try { await zs.getExecutions(); } catch (e) { execErr = e; }
  check('B6 解析失败时抛错而不是返回空数组', execErr && /未在执行列表页面中找到数据/.test(execErr.message));

  // ============ A4：超时提示 ============
  const timeoutErr = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  check('A4 超时错误翻译为可读提示', /超时/.test(zs.describeZentaoTransportError(timeoutErr)), zs.describeZentaoTransportError(timeoutErr));

  // ============ E2：只有禅道请求带禅道头 ============
  mock.calls = [];
  mock.handler = (url, init) => loginHandler(url, init) || zentaoJson({ tasks: [], pager: { pageTotal: 1 } });
  await zs.getMyTasks();
  const zreq = mock.calls.find(c => c.url.includes('/zentao/my-task-'));
  check('E2 禅道请求带 Referer 与浏览器 UA', new Headers(zreq.init.headers).get('Referer') === 'http://z.test/zentao/' &&
    /Chrome/.test(new Headers(zreq.init.headers).get('User-Agent')));
  check('E2 不再全局改写 fetch', globalThis.fetch.toString().includes('mock.calls'));

  // ============ 状态推送：零工时任务开始、看板执行任务、失败原因 ============
  const posts = [];
  const statusHandler = (failMsg) => (url, init) => {
    const lr = loginHandler(url, init);
    if (lr) return lr;
    if (/task-(start|close|finish)-\d+\.html/.test(url)) {
      if ((init.method || 'GET') === 'GET') {
        return new Response(`<form><input name='consumed' value='0'><input name='left' value='0'><input name='status' value='wait'><textarea name='comment'></textarea></form>`);
      }
      posts.push({ url, body: String(init.body) });
      return failMsg ? jsonResp({ result: 'fail', message: { left: [failMsg] } })
        : new Response("<script>parent.parent.ajaxRefresh()</script>");  // 禅道真实的收尾脚本
    }
    return zentaoJson({ tasks: [], pager: { pageTotal: 1 } });
  };
  mock.handler = statusHandler(null);
  await zs.updateTaskStatus('944', 'doing');
  const startBody = new URLSearchParams(posts[0].body);
  check('零工时任务开始时补上预计剩余（禅道要求消耗与剩余不能同时为 0）', Number(startBody.get('left')) > 0, posts[0].body);

  posts.length = 0;
  const kr = await zs.updateKanbanCardStatus('934', '149', 'done');
  check('看板执行里的任务完成走任务关闭动作（不再调 kanban-finishCard）',
    posts.length === 1 && /task-close-934/.test(posts[0].url) && kr.success, JSON.stringify({ posts: posts.map(p => p.url), kr }));
  check('看板执行里的任务开始走任务开始动作',
    (await zs.updateKanbanCardStatus('934', '149', 'in_progress')) && /task-start-934/.test(posts[1].url));

  mock.handler = statusHandler('『预计剩余』不能为空');
  const failed = await zs.updateTaskStatus('944', 'doing');
  check('状态更新失败时带上禅道给出的原因', !failed.success && /预计剩余/.test(failed.message), failed.message);

  // ============ 编辑任务：只改优先级，描述 / 抄送等字段原样带回 ============
  const editPosts = [];
  const EDIT_FORM = `<form method='post'>
    <input type='text' name='name' value='阿迪新增confirmed小程序'>
    <textarea name='desc' rows='5'>&lt;p&gt;详细说明：A &amp; B&lt;/p&gt;</textarea>
    <textarea name='comment'></textarea>
    <input type='hidden' name='lastEditedDate' value='2026-10-21 22:47:45'>
    <select name='pri'><option value='1'>1</option><option value='3' selected='selected'>3</option></select>
    <select name='mailto[]' multiple><option value='lijc' selected>李佳成</option><option value='qianj' selected>钱进</option><option value='x'>X</option></select>
    <select name='execution'><option value='149' selected>阿迪</option></select>
  </form>`;
  const editHandler = (reply) => (url, init) => {
    const lr = loginHandler(url, init);
    if (lr) return lr;
    if (/task-edit-\d+\.html/.test(url)) {
      if ((init.method || 'GET') === 'GET') return new Response(reply.form ?? EDIT_FORM);
      editPosts.push(new URLSearchParams(String(init.body)));
      return reply.post();
    }
    return new Response('');
  };
  mock.handler = editHandler({ post: () => new Response("<script>parent.parent.ajaxRefresh()</script>") });
  const er = await zs.editTask({ taskId: '952', pri: 2 });
  const ep = editPosts[0];
  check('编辑：优先级被改成 2', er.success && ep && ep.get('pri') === '2', JSON.stringify(er));
  check('编辑：任务描述原样带回（不再被标题覆盖）', ep && ep.get('desc') === '<p>详细说明：A & B</p>', ep && ep.get('desc'));
  check('编辑：多个抄送人全部带回', ep && ep.getAll('mailto[]').join(',') === 'lijc,qianj', ep && ep.getAll('mailto[]').join(','));
  check('编辑：并发锁字段 lastEditedDate 带回', ep && ep.get('lastEditedDate') === '2026-10-21 22:47:45');

  // 禅道编辑成功的真实返回：跳转到详情页的脚本（2026-10-21 实测 #952），旧实现误判为失败
  editPosts.length = 0;
  mock.handler = editHandler({ post: () => new Response("<html><meta charset='utf-8'/><style>body{background:white}</style><script>parent.location='/zentao/task-view-952.html'; </script>") });
  const erRedirect = await zs.editTask({ taskId: '952', pri: 4 });
  check('编辑成功返回「跳转详情页」脚本 → 判为成功', erRedirect.success, JSON.stringify(erRedirect));

  editPosts.length = 0;
  mock.handler = editHandler({ post: () => jsonResp({ result: 'fail', message: '该记录可能已经被改动。请刷新页面重新编辑！' }) });
  const er2 = await zs.editTask({ taskId: '952', pri: 2 });
  check('编辑失败：带上禅道给出的原因', !er2.success && /已经被改动/.test(er2.message), er2.message);

  editPosts.length = 0;
  mock.handler = editHandler({ form: '<html>no form</html>', post: () => new Response('') });
  const er3 = await zs.editTask({ taskId: '999', pri: 2 });
  check('取不到编辑表单：不提交、明确报错', !er3.success && editPosts.length === 0 && /编辑表单/.test(er3.message), er3.message);

  // ============ 新建 Bug：禅道只回「跳列表页」时也要拿到 ID ============
  mock.handler = (url, init) => {
    const lr = loginHandler(url, init);
    if (lr) return lr;
    if (/bug-create-/.test(url)) return jsonResp({ result: 'success', message: '保存成功', locate: '/zentao/bug-browse-89-0-byModule-0-id_desc.html' });
    // 产品 / 执行的 Bug 列表返回空（实测如此），「我提的 Bug」里能找到
    if (/bug-browse-|execution-bug-/.test(url)) return zentaoJson({ bugs: [] });
    if (/my-bug-openedBy-/.test(url)) return zentaoJson({ bugs: [{ id: 531, title: '新建的 Bug' }, { id: 400, title: '新建的 Bug' }, { id: 530, title: '别的' }], pager: { pageTotal: 1 } });
    return new Response('');
  };
  const cb = await zs.createBug({ title: '新建的 Bug', steps: 's', productId: '89', executionId: '167' });
  check('新建 Bug：响应不带 ID 时从「我提的 Bug」里找回（取最新同名）', cb.success && String(cb.bugId) === '531', JSON.stringify(cb));

  // ============ Bug 动作：禅道拒绝时不能报成功 ============
  const bugActionHandler = (reply) => (url, init) => loginHandler(url, init) || reply(url, init);
  mock.handler = bugActionHandler(() => jsonResp({ result: 'fail', message: { resolution: ['『解决方案』不能为空。'] } }));
  const rb = await zs.resolveBug({ bugId: '516', resolution: '' });
  check('Bug 解决被禅道拒绝（HTTP 200）→ 判失败并带原因', !rb.success && /解决方案/.test(rb.message), JSON.stringify(rb));
  mock.handler = bugActionHandler(() => new Response("<script>parent.location='/zentao/bug-view-516.html';</script>"));
  const rb2 = await zs.resolveBug({ bugId: '516', resolution: 'fixed' });
  check('Bug 解决成功（跳转详情页）→ 判成功', rb2.success, JSON.stringify(rb2));
  mock.handler = bugActionHandler(() => new Response("<script>parent.parent.ajaxRefresh()</script>"));
  check('Bug 关闭成功（刷新父页面）→ 判成功', (await zs.closeBug({ bugId: '516' })).success);

  // ============ 同步：本地已有任务在禅道被完成后，本地也跟着完成 ============
  seed([
    { id: 'l1', type: 'task', zentaoId: '801', title: '别人帮我关了', status: 'in_progress', priority: 3, progress: 50, totalConsumedTime: 1, createdAt: OLD, updatedAt: OLD },
    { id: 'b801', type: 'bug', zentaoId: 801, title: '同号Bug', status: 'activated', createdAt: OLD, updatedAt: OLD }
  ]);
  mock.handler = (url, init) => {
    const lr = loginHandler(url, init);
    if (lr) return lr;
    if (url.includes('/zentao/my-task-')) {
      return zentaoJson({ tasks: [
        { id: 801, name: '别人帮我关了', status: 'closed', pri: 3, consumed: 1, estimate: 2, progress: 100 },
        { id: 802, name: '历史已完成，本地没有', status: 'done', pri: 3 },
        { id: 803, name: '新任务', status: 'wait', pri: 3 }
      ], pager: { pageTotal: 1 } });
    }
    return zentaoJson({ bugs: [], pager: { pageTotal: 1 } });
  };
  const syncResult = await zs.syncMyTasks();
  all = await read();
  check('禅道里已关闭的本地任务同步为完成', all.find(t => t.id === 'l1').status === 'done');
  check('本地没有的历史已完成任务不拉进来', !all.some(t => String(t.zentaoId) === '802'));
  check('新的活跃任务照常新增', all.some(t => String(t.zentaoId) === '803' && t.status === 'todo'));
  check('同号 Bug 不受任务同步影响', all.find(t => t.id === 'b801').status === 'activated' && all.find(t => t.id === 'b801').type === 'bug');
  check('同步结果 total 为活跃任务数', syncResult.total === 1 && syncResult.refreshed === 2, JSON.stringify(syncResult));

  // ============ 同步：最近填过工时的已完成任务也收进来，落在最后一次填工时的那天 ============
  {
    const es = await import('../src/services/effortService.js');
    const day = new Date(Date.now() - 5 * 86400000);
    const dayStr = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    es._caches.mine.write({ syncedAt: Date.now(), tasks: {
      804: { sig: 'a', at: Date.now(), name: '补过工时的已完成任务', exec: '', efforts: [{ id: '9', account: 'u', date: dayStr, consumed: 2, left: 0, work: 'x' }] }
    } });
    seed([]);
    mock.handler = (url, init) => {
      const lr = loginHandler(url, init);
      if (lr) return lr;
      if (url.includes('/zentao/my-task-')) return zentaoJson({ tasks: [
        { id: 804, name: '补过工时的已完成任务', status: 'done', pri: 3 },
        { id: 805, name: '没填过工时的历史任务', status: 'done', pri: 3 }
      ], pager: { pageTotal: 1 } });
      return zentaoJson({ bugs: [], pager: { pageTotal: 1 } });
    };
    await zs.syncMyTasks();
    all = await read();
    const t804 = all.find(t => String(t.zentaoId) === '804');
    check('同步：近期填过工时的已完成任务被收进来（状态完成）', !!t804 && t804.status === 'done');
    check('同步：它的日期落在最后一次填工时那天，不是"今天"', t804 && t804.createdAt.slice(0, 10) === dayStr && t804.updatedAt.slice(0, 10) === dayStr, t804 && t804.createdAt);
    check('同步：没填过工时的历史已完成任务仍不收', !all.some(t => String(t.zentaoId) === '805'));
    const view = await getAllTasks({ date: dayStr });
    check('同步后：任务页按那天看，能看到这个任务', view.some(t => String(t.zentaoId) === '804'));
  }

  // ============ C1/E1：请求来源校验 ============
  const guard = createRequestGuard({ port: 3721, projectRoot: '/Users/x/workAssistant' });
  const extId = extensionIdFromPath('/Users/x/workAssistant/extension');
  const runGuard = (headers, method = 'GET') => {
    const res = { code: 200, headers: {}, status(c) { this.code = c; return this; }, json() { return this; },
      header(k, v) { this.headers[k] = v; }, sendStatus(c) { this.code = c; return this; } };
    let passed = false;
    guard({ method, path: '/api/zentao/config', headers }, res, () => { passed = true; });
    return { passed, res };
  };
  check('C1 恶意网页 Origin 被拒绝', !runGuard({ host: '127.0.0.1:3721', origin: 'https://evil.example' }).passed);
  const okExt = runGuard({ host: '127.0.0.1:3721', origin: `chrome-extension://${extId}` });
  check('C1 本插件 Origin 放行并回显 CORS 头', okExt.passed && okExt.res.headers['Access-Control-Allow-Origin'] === `chrome-extension://${extId}`);
  check('C1 其他扩展 Origin 被拒绝', !runGuard({ host: '127.0.0.1:3721', origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }).passed);
  check('C1 无 Origin 的跨站请求（表单/图片）被拒绝', !runGuard({ host: '127.0.0.1:3721', 'sec-fetch-site': 'cross-site' }, 'POST').passed);
  check('C1 命令行请求（无 Origin）放行', runGuard({ host: '127.0.0.1:3721' }).passed);
  check('C1 DNS rebinding（Host 非本机）被拒绝', !runGuard({ host: 'evil.example:3721' }).passed);
  check('C1 扩展 ID 算法与浏览器一致', extensionIdFromPath('/Users/itreenewbee/工作/代码/Github/workAssistant/extension') === 'mfnhmoaaclbpmmnbhbifigahbepenibl');
  // 固定扩展 ID：manifest.json 带 key 后，ID 由公钥算出、与安装位置无关；旧的按路径算出的 ID 不再放行
  const { projectExtensionId, extensionIdFromKey } = await import('../src/utils/requestGuard.js');
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const manifestKey = JSON.parse(readFileSync(join(repoRoot, 'extension', 'manifest.json'), 'utf8')).key;
  const fixedId = projectExtensionId(repoRoot);
  check('C1 扩展固定 ID：由 manifest 公钥算出，与目录无关', manifestKey && fixedId === extensionIdFromKey(manifestKey) && /^[a-p]{32}$/.test(fixedId) && fixedId !== extensionIdFromPath(join(repoRoot, 'extension')), fixedId);
  const realGuard = createRequestGuard({ port: 3721, projectRoot: repoRoot });
  const runReal = (origin) => { let ok = false; realGuard({ method: 'GET', path: '/api/zentao/config', headers: { host: '127.0.0.1:3721', origin } }, { status() { return this; }, json() { return this; }, header() {}, sendStatus() { return this; } }, () => { ok = true; }); return ok; };
  check('C1 固定 ID 放行，旧的按路径算出的 ID 拒绝', runReal(`chrome-extension://${fixedId}`) && !runReal(`chrome-extension://${extensionIdFromPath(join(repoRoot, 'extension'))}`));

  // ============ E3：.env 换行注入 ============
  let envErr = null;
  try { updateEnvFile({ WEBHOOK_URL: 'http://x\nZENTAO_URL=http://evil' }); } catch (e) { envErr = e; }
  check('E3 值含换行时拒绝写入 .env', envErr && /换行/.test(envErr.message));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

for (const r of results) {
  console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${r.pass || !r.extra ? '' : `   → ${r.extra}`}`);
}
const passed = results.filter(r => r.pass).length;
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
