/**
 * 回归测试：同步以禅道为准、截止时间推送禅道
 *
 * 全程使用临时数据目录 + 模拟禅道（替换 globalThis.fetch），不读写真实 data/，不访问网络。
 *
 * 覆盖：
 *   L1 禅道里已删除的任务 / Bug（含看板任务、对象不存在），同步时删掉本地记录
 *   L1 查不了的（网络失败）、还在的，本地记录不动；还在的不按 ID 覆盖（本地有关联错的老记录）
 *   L6 Bug 同步：指派给我 / 由我创建 / 抄送给我 / 由我指派 的激活 Bug 都同步；已解决、已关闭的不新增，本地已有的刷新状态
 *   L7 禅道返回的标题是 HTML 转义过的（&#039; &quot; &gt;），同步、搜索时还原成原文
 *   L2 编辑任务可改截止日期（只取日期，空串清除，不传不改）；不传优先级不再改成 3
 *   L2 卡片「截止时间」保存后推送禅道；「提醒时间」、Bug、未同步的不推送
 *   N1 搜索任务 / Bug 走禅道全局搜索：按类型过滤、去掉已删除、按最后编辑时间排序；先列命中再补详情；搜索面板交互与本地退路
 *   N2 看板头部「添加任务」按钮；侧栏不再有「所属执行」卡片
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as acorn from 'acorn';
import { createRequire } from 'module';
const { JSDOM } = createRequire(import.meta.url)('jsdom');

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });

// ---------- 模拟禅道 ----------
const mock = { handler: null, calls: [] };
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  mock.calls.push({ url, init });
  return mock.handler(url, init);
};
const jsonResp = (obj, { headers = {} } = {}) => new Response(JSON.stringify(obj), {
  headers: { 'Content-Type': 'application/json', ...headers }
});
const zentaoJson = (inner) => jsonResp({ status: 'success', data: JSON.stringify(inner) });

function loginHandler(url, init) {
  if (url.includes('user-refreshRandom')) return new Response('1234');
  if (url.includes('user-login') && (init.method || 'GET') === 'GET') {
    return new Response('<html></html>', { headers: { 'Set-Cookie': 'zentaosid=sid1; path=/' } });
  }
  if (url.includes('user-login')) return jsonResp({ result: 'success' }, { headers: { 'Set-Cookie': 'za=lijc; path=/' } });
  return null;
}

// 对象不存在：失败结果后面还拼着一段跳转 JSON（禅道 18.3 实际返回）
const notFound = () => new Response(
  JSON.stringify({ status: 'success', data: JSON.stringify({ result: 'fail', message: '抱歉，您访问的对象不存在！' }) }) +
  JSON.stringify({ status: 'success', data: JSON.stringify({ locate: 'http://z.test/zentao/qa.json' }) })
);
const view = (kind, item) => zentaoJson({ [kind]: { id: String(item.id), deleted: '0', ...item } });

const tmp = mkdtempSync(join(tmpdir(), 'wa-truth-'));
const { config } = await import('../src/config.js');
config.paths.data = tmp;
config.paths.tasks = join(tmp, 'tasks.json');
config.paths.history = join(tmp, 'history.json');
Object.assign(config.zentao, { enabled: true, url: 'http://z.test', username: 'u', password: 'p' });

const { syncMyTasks, editTask, searchZentao } = await import('../src/services/zentaoService.js');

try {
  // ---------- L1 同步删除 ----------
  const local = [
    { id: 'a', type: 'task', title: '我的任务', status: 'in_progress', zentaoId: '10' },
    { id: 'b', type: 'task', title: '禅道里删了', status: 'done', zentaoId: '11' },
    { id: 'c', type: 'task', title: '本地标题（关联错的老记录）', status: 'done', zentaoId: '12' },
    { id: 'd', type: 'task', title: '对象不存在', status: 'todo', zentaoId: '13' },
    { id: 'e', type: 'task', title: '查不了', status: 'todo', zentaoId: '14' },
    { id: 'f', type: 'task', title: '看板任务删了', status: 'done', zentaoId: '15' },
    { id: 'g', type: 'task', title: '没同步过', status: 'todo' },
    { id: 'h', type: 'bug', title: '指派给我', status: 'activated', zentaoId: 20 },
    { id: 'i', type: 'bug', title: 'Bug 删了', status: 'unconfirmed', zentaoId: 496 },
    { id: 'j', type: 'bug', title: '列表里带删除标记', status: 'unconfirmed', zentaoId: 21 },
    // 任务 #11 删了，但同号 Bug #11 还在：不能误删
    { id: 'k', type: 'bug', title: '同号 Bug', status: 'activated', zentaoId: 11 },
    { id: 'm', type: 'bug', title: '本地已有、禅道里已解决', status: 'activated', zentaoId: 32 }
  ];
  writeFileSync(config.paths.tasks, JSON.stringify({ tasks: local }));

  const viewed = [];
  mock.handler = (url, init) => {
    const login = loginHandler(url, init);
    if (login) return login;
    const page = { pager: { pageTotal: 1 } };
    if (url.includes('/my-task-assignedTo-')) {
      return zentaoJson({ ...page, tasks: [{ id: '10', name: '我的任务', status: 'doing', pri: '3' }] });
    }
    if (url.includes('/my-bug-assignedTo-')) {
      return zentaoJson({ ...page, bugs: [
        { id: '20', title: '指派给我', status: 'active', confirmed: '1' },
        { id: '21', title: '列表里带删除标记', status: 'active', deleted: '1' }
      ] });
    }
    if (url.includes('/my-bug-openedBy-')) {
      return zentaoJson({ ...page, bugs: [
        { id: '30', title: '我创建的激活 Bug', status: 'active', confirmed: '0' },
        { id: '35', title: '$waitTextList([&#039;搜索&#039;]) &quot;len&gt;4&quot; A&amp;B', status: 'active', confirmed: '0' },
        { id: '31', title: '我创建的已关闭 Bug', status: 'closed' },
        { id: '32', title: '本地已有、禅道里已解决', status: 'resolved' }
      ] });
    }
    if (url.includes('/my-bug-mailto-')) return zentaoJson({ ...page, bugs: [{ id: '33', title: '抄送给我', status: 'active', confirmed: '1' }] });
    if (url.includes('/my-bug-assignedBy-')) return zentaoJson({ ...page, bugs: [{ id: '34', title: '由我指派', status: 'active' }, { id: '30', title: '我创建的激活 Bug', status: 'active' }] });
    const m = url.match(/\/(task|bug)-view-(\d+)\.json/);
    if (m) {
      viewed.push(`${m[1]}#${m[2]}`);
      const [, kind, id] = m;
      if (kind === 'task' && id === '11') return view('task', { id, name: '删了', status: 'closed', deleted: '1' });
      if (kind === 'task' && id === '12') return view('task', { id, name: '2023 年别人的任务', status: 'closed', pri: '1' });
      if (kind === 'task' && id === '13') return notFound();
      if (kind === 'task' && id === '14') throw new TypeError('fetch failed');
      // 看板任务：只有 onlybody 版有数据
      if (kind === 'task' && id === '15') {
        return url.includes('onlybody=yes')
          ? view('task', { id, name: '看板', status: 'done', deleted: '1' })
          : zentaoJson({ locate: 'http://z.test/zentao/execution-kanban-147.json' });
      }
      if (kind === 'bug' && (id === '496' || id === '21')) return view('bug', { id, title: '删了', status: 'active', deleted: '1' });
      if (kind === 'bug' && id === '11') return view('bug', { id, title: '同号 Bug', status: 'active' });
    }
    return new Response('not mocked: ' + url, { status: 404 });
  };

  const r = await syncMyTasks();
  const after = JSON.parse(readFileSync(config.paths.tasks, 'utf8')).tasks;
  const idList = after.map(t => t.id);
  const ids = { includes: (id) => idList.includes(id), toString: () => idList.filter(id => id.length === 1).sort().join('') };
  check('L1 禅道里已删除 / 不存在的任务删掉本地记录（含看板任务）', !['b', 'd', 'f'].some(id => ids.includes(id)), ids);
  check('L1 禅道里已删除的 Bug 删掉本地记录（含列表里带删除标记的）', !['i', 'j'].some(id => ids.includes(id)), ids);
  check('L1 查不了、还在的、没同步过的、同号的另一类记录不动', ['a', 'c', 'e', 'g', 'h', 'k'].every(id => ids.includes(id)), ids);
  const c = after.find(t => t.id === 'c');
  check('L1 列表外还在的记录不按 ID 覆盖（关联错的老记录保持原样）', c && c.title === '本地标题（关联错的老记录）' && c.status === 'done', JSON.stringify(c));
  check('L1 同步结果带删除条数', r.removed === 3 && r.bugs && r.bugs.removed === 2, JSON.stringify({ removed: r.removed, bugs: r.bugs }));
  check('L1 只查列表外的记录，列表里的不逐个查', !viewed.includes('task#10') && !viewed.includes('bug#20') && !viewed.includes('bug#32'), viewed.join(','));
  const bugsAfter = after.filter(t => t.type === 'bug');
  const bugIds = bugsAfter.map(t => String(t.zentaoId));
  check('L6 指派给我 / 由我创建 / 抄送给我 / 由我指派 的激活 Bug 都同步进来（重复的只一条）',
    ['20', '30', '33', '34'].every(id => bugIds.filter(x => x === id).length === 1), bugIds.join(','));
  check('L6 已解决、已关闭的不新增', !bugIds.includes('31'));
  const escaped = bugsAfter.find(t => String(t.zentaoId) === '35');
  check('L7 同步时还原禅道转义过的标题', escaped && escaped.title === `$waitTextList(['搜索']) "len>4" A&B`, escaped && escaped.title);
  const { decodeZentaoText } = await import('../src/utils/text.js');
  check('L7 还原规则：&amp; 最后处理（原文就是 &lt; 的不多还原一层）、数字实体、空值原样',
    decodeZentaoText('&amp;lt;b&amp;gt;') === '&lt;b&gt;' && decodeZentaoText('&#20013;&#039;') === "中'" && decodeZentaoText(undefined) === undefined && decodeZentaoText('普通标题') === '普通标题');
  check('L6 本地已有的按禅道刷新状态（禅道已解决 → 已解决）', bugsAfter.find(t => t.id === 'm').status === 'resolved');
  check('L1 详情用 onlybody 版（看板任务才有数据）',
    mock.calls.filter(x => /-view-\d+\.json/.test(x.url)).every(x => x.url.includes('onlybody=yes')));

  // ---------- L2 编辑任务：截止日期 / 优先级 ----------
  const form = `<form method="post">
    <input type="text" name="name" value="原标题">
    <select name="pri"><option value="1">1</option><option value="2" selected>2</option><option value="3">3</option></select>
    <input type="text" name="deadline" value="2026-11-01">
    <input type="hidden" name="lastEditedDate" value="2026-10-22 10:00:00">
    <textarea name="desc">原描述</textarea>
  </form>`;
  let posted = null;
  mock.handler = (url, init) => {
    const login = loginHandler(url, init);
    if (login) return login;
    if (url.includes('/task-edit-') && (init.method || 'GET') === 'GET') return new Response(form);
    if (url.includes('/task-edit-')) {
      posted = new URLSearchParams(String(init.body));
      return new Response('<script>parent.location.reload()</script>', { status: 302 });
    }
    return new Response('not mocked', { status: 404 });
  };
  const sent = async (args) => { posted = null; const res = await editTask({ taskId: 9, ...args }); return { res, p: posted }; };

  let { res, p } = await sent({ deadline: '2026-10-30T18:00', pri: '' });
  check('L2 截止时间 → 禅道截止日期（只取日期）', res.success && p.get('deadline') === '2026-10-30', p && p.get('deadline'));
  check('L2 不传优先级、标题：保留禅道原值', p.get('pri') === '2' && p.get('name') === '原标题' && p.get('desc') === '原描述',
    `${p.get('pri')} ${p.get('name')} ${p.get('desc')}`);
  ({ p } = await sent({ deadline: '' }));
  check('L2 空串清除截止日期', p.get('deadline') === '', p.get('deadline'));
  ({ p } = await sent({ name: '新标题' }));
  check('L2 不传截止时间：保留禅道原值', p.get('deadline') === '2026-11-01' && p.get('name') === '新标题', p.get('deadline'));

  // ---------- L2 前端：卡片保存截止时间后推送禅道 ----------
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'newtab.js'), 'utf8');
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script' });
  const fn = ast.body.find(n => n.type === 'FunctionDeclaration' && n.id.name === 'syncDeadlineToZentao');
  check('L2 抽到 syncDeadlineToZentao', !!fn);
  const tracked = [];
  const OptimisticUI = { trackSync: (o) => { tracked.push(o); }, explainFailure: () => '' };
  const edits = [];
  const ZentaoBrowserClient = { editTask: (o) => { edits.push(o); return { success: true }; } };
  // eslint-disable-next-line no-new-func
  const syncDeadline = new Function('OptimisticUI', 'ZentaoBrowserClient', `${src.slice(fn.start, fn.end)}; return syncDeadlineToZentao;`)(OptimisticUI, ZentaoBrowserClient);
  const base = { id: 'x', type: 'task', status: 'in_progress', zentaoId: '963', executionId: '167' };
  syncDeadline(base, '2026-10-30T18:00');
  tracked.splice(0).forEach(o => o.syncFn());
  check('L2 进行中任务的截止时间推送禅道（不带优先级、标题）',
    edits.length === 1 && edits[0].deadline === '2026-10-30T18:00' && edits[0].zentaoId === '963' && edits[0].execution === '167' &&
    !('pri' in edits[0]) && !('name' in edits[0]), JSON.stringify(edits));
  syncDeadline(base, '');
  tracked.splice(0).forEach(o => o.syncFn());
  check('L2 清空截止时间：清除禅道截止日期', edits.length === 2 && edits[1].deadline === '', JSON.stringify(edits[1]));
  syncDeadline({ ...base, status: 'todo' }, '2026-10-30T18:00');
  syncDeadline({ ...base, type: 'bug' }, '2026-10-30T18:00');
  syncDeadline({ ...base, zentaoId: '' }, '2026-10-30T18:00');
  check('L2 提醒时间（未开始）、Bug、未同步的任务不推送', tracked.length === 0, tracked.length);
  check('L2 编辑任务不再默认优先级 3', !/pri:\s*pri\s*\|\|\s*3/.test(src));

  // ---------- N1 禅道搜索（后端） ----------
  let searchCookie = '';
  mock.handler = (url, init) => {
    const login = loginHandler(url, init);
    if (login) return login;
    if (url.includes('/search-index.json')) {
      searchCookie = JSON.stringify(init.headers instanceof Headers ? Object.fromEntries(init.headers) : init.headers);
      return zentaoJson({ results: [
        { objectType: 'task', objectID: '1', title: '旧任务', summary: '含<span class=\'text-danger\'>阿迪</span>', editedDate: '2025-01-01 10:00:00' },
        { objectType: 'task', objectID: '2', title: '新任务', summary: '', editedDate: '2026-10-20 10:00:00' },
        { objectType: 'bug', objectID: '3', title: '一个 Bug', summary: '', editedDate: '2026-10-21 10:00:00' },
        { objectType: 'task', objectID: '4', title: '已删除', summary: '', editedDate: '2026-10-22 10:00:00' },
        { objectType: 'story', objectID: '5', title: '需求', summary: '', editedDate: '2026-10-22 10:00:00' }
      ] });
    }
    const m = url.match(/\/(task|bug)-view-(\d+)\.json/);
    if (m) {
      const [, kind, id] = m;
      const item = { id, deleted: id === '4' ? '1' : '0', status: { 1: 'doing', 2: 'closed', 3: 'active' }[id] || 'wait', assignedTo: 'lijc', ...(kind === 'task' ? { name: `任务${id}` } : { title: `Bug${id}` }) };
      return zentaoJson({ [kind]: item, users: { lijc: '李佳成' }, execution: { name: '阿迪达斯项目交付' }, product: 'Android' });
    }
    return new Response('not mocked', { status: 404 });
  };
  const sr = await searchZentao('阿迪', 'task');
  check('N1 只要这一类（任务），去掉禅道里已删除的', sr.items.map(x => x.id).sort().join() === '1,2' && sr.total === 3, JSON.stringify(sr.items.map(x => x.id)));
  check('N1 按最后编辑时间倒序', sr.items.map(x => x.id).join() === '2,1' && sr.items[0].statusLabel === '已关闭' && sr.items[1].statusLabel === '进行中', JSON.stringify(sr.items.map(x => [x.id, x.status])));
  check('N1 带上指派人姓名、所属执行，摘要去掉高亮标签', sr.items[1].assignedToName === '李佳成' && sr.items[1].where === '阿迪达斯项目交付' && sr.items[1].summary === '含阿迪', JSON.stringify(sr.items[1]));
  const viewsBefore = mock.calls.filter(c => /-view-/.test(c.url)).length;
  const quick = await searchZentao('阿迪', 'task', { details: false });
  check('N1 先只要命中：不查详情，顺序与补全后一致', quick.items.map(x => x.id).join() === '4,2,1' && quick.items.every(x => x.partial) && mock.calls.filter(c => /-view-/.test(c.url)).length === viewsBefore, JSON.stringify(quick.items.map(x => x.id)));
  check('N1 用 cookie 调大每页条数（默认只有 10 条）', /pagerSearchIndex=200/.test(searchCookie), searchCookie);
  const sb = await searchZentao('阿迪', 'bug');
  check('N1 搜 Bug：标题、状态、所属产品', sb.items.length === 1 && sb.items[0].title === 'Bug3' && sb.items[0].statusLabel === '激活', JSON.stringify(sb.items));

  // ---------- N1/N2 页面 ----------
  const HTML = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'newtab.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  const top = (name) => {
    const n = ast.body.find(x => (x.type === 'FunctionDeclaration' && x.id.name === name) || (x.type === 'VariableDeclaration' && x.declarations.some(d => d.id.name === name)));
    if (!n) throw new Error(`找不到 ${name}`);
    return src.slice(n.start, n.end);
  };
  const win = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only' }).window;
  const doc = win.document;
  check('N2 看板头部有「添加任务」按钮，紧跟搜索框（与「添加 Bug」同样式）',
    doc.querySelector('#taskMode .task-board-right #headerAddTaskBtn.header-btn') && /添加任务/.test(doc.getElementById('headerAddTaskBtn').textContent) &&
    doc.getElementById('searchInput').closest('.task-board-center').nextElementSibling.contains(doc.getElementById('headerAddTaskBtn')));
  check('N2 侧栏不再有「所属执行」卡片', !doc.getElementById('executionSelectorWrapper') && !doc.getElementById('executionSelect'));
  const ui = { reqs: [], details: [], opened: [], localSearch: 0, fail: false };
  win.fetch = async (url) => {
    ui.reqs.push(String(url));
    if (ui.fail) return { ok: false, status: 502, json: async () => ({ success: false, message: '无法连接禅道' }) };
    return { ok: true, status: 200, json: async () => ({ success: true, data: { total: 3, items: [
      { type: 'task', id: '950', title: '阿迪版本更新', status: 'wait', statusLabel: '未开始', assignedToName: '李佳成', where: '阿迪达斯', localId: 'L1' },
      { type: 'task', id: '417', title: '阿迪 1 月报告', status: 'closed', statusLabel: '已关闭', assignedToName: 'Closed', where: '阿迪达斯', localId: null }
    ] } }) };
  };
  win.allTasks = [{ id: 'L1', title: '阿迪版本更新' }];
  win.showTaskDetail = (t) => ui.details.push(t.id);
  win.openInZentao = (type, id) => ui.opened.push(`${type}#${id}`);
  win.handleSearch = async () => { ui.localSearch++; };
  win.BugManager = { showBugDetail: () => {} };
  win.eval(`var API_BASE_URL = 'http://127.0.0.1:3721';\n${top('debounce')}\n${top('escapeHtml')}\n${top('ZentaoSearch')}\nwindow.ZentaoSearch = ZentaoSearch;`);
  win.ZentaoSearch.attach('searchInput', 'task');
  win.ZentaoSearch.attach('bugSearchInput', 'bug');
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const typeIn = async (id, value) => { const el = doc.getElementById(id); el.value = value; el.dispatchEvent(new win.Event('input')); await sleep(480); };
  await typeIn('searchInput', '阿迪');
  const panel = doc.querySelector('#taskMode .zsearch-panel');
  const searchUrl = `http://127.0.0.1:3721/api/zentao/search?type=task&q=${encodeURIComponent('阿迪')}`;
  check('N1 输入后向禅道搜索任务：先列命中再补详情，结果在搜索框下方', ui.reqs.slice(-2).join() === `${searchUrl}&details=0,${searchUrl}` && !panel.hidden && panel.querySelectorAll('.zsearch-item').length === 2 && /禅道中找到 3 个任务/.test(panel.textContent), ui.reqs.slice(-2).join());
  check('N1 已在看板上的标「看板中」', panel.querySelectorAll('.zsearch-local').length === 1 && /看板中/.test(panel.querySelector('.zsearch-item').textContent));
  panel.querySelectorAll('.zsearch-item')[0].click();
  panel.querySelectorAll('.zsearch-item')[1].click();
  check('N1 点结果：看板上的打开本地详情，其余在禅道打开', ui.details.join() === 'L1' && ui.opened.join() === 'task#417', JSON.stringify(ui));
  await typeIn('bugSearchInput', '登录');
  check('N1 Bug 搜索框也接到禅道搜索（以前没有任何作用）', ui.reqs.pop().includes('type=bug&q='));
  ui.fail = true;
  await typeIn('searchInput', '兼容');
  check('N1 禅道搜索失败：任务退回本地搜索并说明', ui.localSearch === 1 && /禅道搜索失败：无法连接禅道/.test(panel.textContent) && /本地搜索结果/.test(panel.textContent));
  await typeIn('searchInput', '');
  check('N1 清空搜索：收起面板，恢复看板', panel.hidden && ui.localSearch === 2);
} catch (err) {
  check('测试运行异常', false, err.stack);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log(`${r.pass ? '  ✓' : '  ✗'} ${r.name}${r.pass || !r.extra ? '' : `\n      ${r.extra}`}`);
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
