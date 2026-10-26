/**
 * 真函数测试：Bug 看板（前端）
 *   - 卡片：已确认浅蓝、已解决浅绿；P▼ 优先级、指派人按钮
 *   - 卡片上改标题 / 优先级 / 指派人（可带备注）：先改界面，写回禅道后存本地；禅道拒绝时回滚
 *   - 拖拽：未确认→已确认 = 确认，→已解决 = 解决，已解决→已确认 = 激活；不允许的方向给出原因；未同步的先同步
 *   - 确认 / 解决表单默认指派给当前用户；确认表单带入 Bug 原来的优先级
 *   - 详情可编辑；状态动作按状态显示（确认 / 解决 / 激活）；已解决显示中文状态
 *   - 关联禅道 Bug：先核对编号再保存
 *
 * jsdom 加载真实 newtab.html，从 newtab.js 抽出真实代码；网络换成模拟。
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const { JSDOM } = require('jsdom');

const EXT = path.join(__dirname, '..', 'extension');
const SRC = fs.readFileSync(path.join(EXT, 'newtab.js'), 'utf8');
const ATT = fs.readFileSync(path.join(EXT, 'attachments.js'), 'utf8');
const HTML = fs.readFileSync(path.join(EXT, 'newtab.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
const AST = acorn.parse(SRC, { ecmaVersion: 'latest', sourceType: 'script' });

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

function extract(names) {
  return names.map((name) => {
    const node = AST.body.find(n =>
      (n.type === 'FunctionDeclaration' && n.id.name === name) ||
      (n.type === 'VariableDeclaration' && n.declarations.some(d => d.id.name === name)));
    if (!node) throw new Error(`newtab.js 里找不到 ${name}`);
    return SRC.slice(node.start, node.end);
  }).join('\n');
}

const pad2 = (n) => String(n).padStart(2, '0');
const dayStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const TODAY = dayStr(new Date());
const YESTERDAY = dayStr(new Date(Date.now() - 86400000));

const bugsFixture = () => [
  { id: 'u1', type: 'bug', title: '未确认的 Bug', status: 'unconfirmed', priority: 2, severity: 3, bugType: 'config', zentaoId: 101, assignedTo: 'zhangs' },
  { id: 'a1', type: 'bug', title: '已确认的 Bug', status: 'activated', priority: 3, severity: 2, zentaoId: 102, assignedTo: 'zhangs' },
  { id: 'r1', type: 'bug', title: '已解决的 Bug', status: 'resolved', priority: 3, severity: 3, zentaoId: 103, assignedTo: 'lijc', resolvedAt: `${TODAY} 10:00:00` },
  { id: 'n1', type: 'bug', title: '没同步的 Bug', status: 'unconfirmed', priority: 3, severity: 4 }
];

function setup(state) {
  const dom = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  state.requests = [];
  state.toasts = [];
  state.bugs = state.bugs || bugsFixture();
  win.__s = state;
  win.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    state.requests.push({ method, path: u.pathname, query: Object.fromEntries(u.searchParams), body });
    const reply = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
    if (u.pathname === '/api/bugs/migrate') return reply({ success: true, migrated: 0 });
    if (u.pathname === '/api/bugs') return reply({ success: true, data: state.bugs });
    if (/^\/api\/zentao\/bug\/(edit|assign|reactivate)$/.test(u.pathname)) {
      return reply(state.zentaoFail ? { success: false, message: '模拟：禅道拒绝' } : { success: true, bug: { confirmed: '1' } });
    }
    if (u.pathname === '/api/zentao/bug/brief') {
      return reply({ success: true, data: u.searchParams.get('bugId') === '468' ? { exists: true, id: '468', title: '卡中心测试异常', status: 'active' } : { exists: false } });
    }
    if (/^\/api\/bug\/[^/]+(\/zentaoId)?$/.test(u.pathname) && method === 'PUT') return reply({ success: true, data: {} });
    if (/\/attachments$/.test(u.pathname)) return reply({ success: true, items: [], zentaoId: '' });
    return reply({ success: false, message: `未模拟 ${method} ${u.pathname}` }, 404);
  };
  win.eval(`
    var API_BASE_URL = 'http://127.0.0.1:3721';
    var selectedDate = '${TODAY}';
    const Toast = {
      success(m){ window.__s.toasts.push(['success', m]); }, error(m){ window.__s.toasts.push(['error', m]); },
      warning(m){ window.__s.toasts.push(['warning', m]); }, info(m){ window.__s.toasts.push(['info', m]); }
    };
    const ProgressToast = { show(){}, hide(){} };
    const ButtonStateManager = { setLoading(){ return () => {}; } };
    const getWorkTimePlaceholder = () => '';
    const ZentaoBrowserClient = { config: { username: 'lijc' }, getUsers: async () => ({ lijc: '李佳成', zhangs: '张三', wangw: '王五' }), refreshUsersFromZentao: async () => ({ lijc: '李佳成', zhangs: '张三', wangw: '王五' }) };
    window.openInZentao = (type, id) => { window.__s.opened = [type, id]; };
    window.Account = { state: { username: 'lijc' } };
    ${extract(['escapeHtml', 'resetListenerScope', 'Confirm', 'debounce'])}
    ${ATT}
    ${extract(['BUG_PRIORITY_CHOICES', 'BUG_SEVERITY_CHOICES', 'BUG_COLUMN_STATUS', 'BugManager'])}
    window.BugManager = BugManager;
  `);
  return { win, doc: win.document, BM: win.BugManager };
}

const card = (doc, id) => doc.querySelector(`.bug-card[data-bug-id="${id}"]`);

(async () => {
  let s = {};
  let { win, doc, BM } = setup(s);
  await BM.loadBugs();

  // ============ 卡片 ============
  check('已确认卡片浅蓝、已解决卡片浅绿（状态类名）', card(doc, 'a1').classList.contains('bug-status-activated') && card(doc, 'r1').classList.contains('bug-status-resolved') && card(doc, 'u1').classList.contains('bug-status-unconfirmed'));
  // 已解决列只显示所选日历日期解决的 Bug
  BM.bugs.push({ id: 'r2', type: 'bug', title: '昨天解决的 Bug', status: 'resolved', priority: 3, severity: 3, zentaoId: 104, assignedTo: 'lijc', resolvedAt: `${YESTERDAY} 16:30:00` });
  await BM.renderBugs();
  check('已解决列只显示所选日期解决的 Bug（今天看不到昨天解决的）', card(doc, 'r1') && !card(doc, 'r2') && doc.getElementById('bugClosedListCount').textContent === '1');
  win.eval(`selectedDate = '${YESTERDAY}'`);
  await BM.renderBugs();
  check('切到昨天：只显示昨天解决的 Bug', !card(doc, 'r1') && card(doc, 'r2') && doc.getElementById('bugClosedListCount').textContent === '1');
  BM.bugs = BM.bugs.filter(b => b.id !== 'r2');
  win.eval(`selectedDate = '${TODAY}'`);
  await BM.renderBugs();
  check('卡片上有 P▼ 优先级与指派人按钮，可拖拽', /P2/.test(card(doc, 'u1').querySelector('.bug-priority-toggle').textContent) && /张三/.test(card(doc, 'u1').querySelector('.bug-assignee-btn').textContent) && card(doc, 'u1').draggable);
  check('没有指派人时显示「未指派」可点', /未指派/.test(card(doc, 'n1').querySelector('.bug-assignee-btn').textContent));
  check('禅道 ID 仍是绿色链接（浅色底上加白底）', card(doc, 'r1').querySelector('.bug-id-link-inline') && /#103/.test(card(doc, 'r1').textContent));

  // 改优先级
  card(doc, 'u1').querySelector('.bug-priority-toggle').click();
  const menu = doc.querySelector('.bug-choice-menu');
  check('点 P▼ 弹出 P1~P4，当前值标出', menu && menu.querySelectorAll('.bug-choice').length === 4 && menu.querySelector('.is-current').dataset.value === '2');
  menu.querySelector('[data-value="1"]').click();
  await tick(30);
  const edit = s.requests.find(r => r.path === '/api/zentao/bug/edit');
  const put = s.requests.find(r => r.method === 'PUT' && r.path === '/api/bug/u1');
  check('改优先级：写回禅道（编号 101、只带优先级）再存本地', edit && edit.body.bugId === 101 && edit.body.pri === 1 && edit.body.title === undefined && put && put.body.priority === 1, JSON.stringify([edit, put]));
  check('改优先级：卡片立即显示 P1，提示已同步', /P1/.test(card(doc, 'u1').querySelector('.bug-priority-toggle').textContent) && s.toasts.some(t => t[0] === 'success' && /P1/.test(t[1])));

  // 禅道拒绝 → 回滚
  s.zentaoFail = true;
  card(doc, 'a1').querySelector('.bug-priority-toggle').click();
  doc.querySelector('.bug-choice-menu [data-value="4"]').click();
  await tick(30);
  check('禅道拒绝：回滚到原优先级并提示原因，不存本地', /P3/.test(card(doc, 'a1').querySelector('.bug-priority-toggle').textContent) && s.toasts.some(t => t[0] === 'error' && /模拟：禅道拒绝/.test(t[1])) && !s.requests.some(r => r.method === 'PUT' && r.path === '/api/bug/a1'));
  s.zentaoFail = false;

  // 改标题
  card(doc, 'a1').querySelector('.task-title-text').click();
  const input = card(doc, 'a1').querySelector('.bug-title-input');
  check('点标题：原地编辑', input && input.value === '已确认的 Bug');
  input.value = '已确认的 Bug（改）';
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter' }));
  await tick(30);
  const editTitle = s.requests.filter(r => r.path === '/api/zentao/bug/edit').pop();
  check('改标题：回车保存，写回禅道并刷新卡片', editTitle.body.title === '已确认的 Bug（改）' && editTitle.body.bugId === 102 && /（改）/.test(card(doc, 'a1').textContent));
  const editsBefore = s.requests.filter(r => r.path === '/api/zentao/bug/edit').length;
  card(doc, 'a1').querySelector('.task-title-text').click();
  const input2 = card(doc, 'a1').querySelector('.bug-title-input');
  input2.value = '不保存';
  input2.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' }));
  await tick(20);
  check('改标题：Esc 取消，不发请求', !/不保存/.test(card(doc, 'a1').textContent) && s.requests.filter(r => r.path === '/api/zentao/bug/edit').length === editsBefore);

  // 改指派（带备注）
  card(doc, 'u1').querySelector('.bug-assignee-btn').click();
  await tick(10);
  const pop = doc.querySelector('.bug-assign-pop');
  check('点指派人：成员浮层（当前用户排第一并标「我」，当前指派人选中）', pop && /李佳成/.test(pop.querySelector('.bap-user').textContent) && /我/.test(pop.querySelector('.bap-user').textContent) && pop.querySelector('.is-picked').dataset.account === 'zhangs');
  pop.querySelector('.bap-search').value = '王';
  pop.querySelector('.bap-search').dispatchEvent(new win.Event('input'));
  check('指派浮层可搜索', pop.querySelectorAll('.bap-user').length === 1);
  pop.querySelector('[data-account="wangw"]').click();
  pop.querySelector('.bap-comment').value = '麻烦看下';
  pop.querySelector('[data-bap="ok"]').click();
  await tick(30);
  const assign = s.requests.find(r => r.path === '/api/zentao/bug/assign');
  check('改指派：走禅道「指派」并带备注，卡片显示新指派人', assign && assign.body.assignedTo === 'wangw' && assign.body.comment === '麻烦看下' && /王五/.test(card(doc, 'u1').querySelector('.bug-assignee-btn').textContent) && s.toasts.some(t => /已指派给 王五/.test(t[1])));

  // 未同步的 Bug：只改本地
  const editsBefore2 = s.requests.filter(r => r.path === '/api/zentao/bug/edit').length;
  card(doc, 'n1').querySelector('.bug-priority-toggle').click();
  doc.querySelector('.bug-choice-menu [data-value="2"]').click();
  await tick(30);
  check('未同步的 Bug：只改本地，不调禅道', s.requests.some(r => r.method === 'PUT' && r.path === '/api/bug/n1') && s.requests.filter(r => r.path === '/api/zentao/bug/edit').length === editsBefore2);

  // ============ 拖拽规则 ============
  const rule = (f, t) => BM.dropRule(f, t);
  check('拖拽规则：未确认→已确认=确认，→已解决=解决，已解决→已确认=激活',
    rule('unconfirmed', 'activated').action === 'confirm' && rule('unconfirmed', 'resolved').action === 'resolve' && rule('activated', 'resolved').action === 'resolve' && rule('resolved', 'activated').action === 'reactivate');
  check('拖拽规则：不允许的方向给出原因，同一列无动作',
    /不支持/.test(rule('activated', 'unconfirmed').reason) && /请拖到「已确认」/.test(rule('resolved', 'unconfirmed').reason) && rule('activated', 'activated') === null);

  BM.markDropTargets(BM.bugs.find(b => b.id === 'a1'));
  const col = (id) => doc.getElementById(id).closest('.task-column');
  check('拖拽中：能放的列高亮，不能放的变灰', col('bugClosedList').classList.contains('bug-drop-ok') && col('bugUnconfirmedList').classList.contains('bug-drop-no') && !col('bugActivatedList').classList.contains('bug-drop-ok'));
  BM.markDropTargets(null);

  let called = '';
  BM.activateBug = (id) => { called = `confirm:${id}`; };
  BM.showResolveModal = (id) => { called = `resolve:${id}`; };
  BM.handleBugDrop('u1', 'activated');
  check('放到已确认：弹确认表单', called === 'confirm:u1');
  BM.handleBugDrop('a1', 'resolved');
  check('放到已解决：弹解决表单', called === 'resolve:a1');
  called = '';
  BM.handleBugDrop('a1', 'unconfirmed');
  check('不允许的方向：提示原因，不弹表单', !called && s.toasts.some(t => t[0] === 'warning' && /不支持/.test(t[1])));
  BM.handleBugDrop('n1', 'activated');
  check('未同步的 Bug：提示先同步', s.toasts.some(t => t[0] === 'warning' && /先点卡片上的「同步」/.test(t[1])));

  // 激活
  await BM.handleBugDrop('r1', 'activated');
  await tick(20);
  const ra = doc.getElementById('bugReactivateModal');
  check('已解决→已确认：弹激活表单，指派人默认当前用户', ra && ra.querySelector('[data-ra="assignee"]').value === 'lijc');
  ra.querySelector('[data-ra="comment"]').value = '复现了';
  ra.querySelector('[data-ra="ok"]').click();
  await tick(40);
  const re = s.requests.find(r => r.path === '/api/zentao/bug/reactivate');
  const rePut = s.requests.filter(r => r.method === 'PUT' && r.path === '/api/bug/r1').pop();
  check('激活：调禅道激活（不是确认），本地改为已确认', re && re.body.bugId === 103 && re.body.assignedTo === 'lijc' && re.body.comment === '复现了' && rePut.body.status === 'activated' && !doc.getElementById('bugReactivateModal'));

  // ============ 确认 / 解决表单默认值 ============
  ({ win, doc, BM } = setup(s = {}));
  await BM.loadBugs();
  await BM.showActivateModal('u1');
  check('确认表单：指派人默认当前用户（不再是原指派人）', doc.getElementById('activateAssigneeDisplay').dataset.value === 'lijc' && /李佳成/.test(doc.getElementById('activateAssigneeDisplay').textContent));
  check('确认表单：带入 Bug 原来的优先级与类型', doc.getElementById('activatePri').value === '2' && doc.getElementById('activateType').value === 'config');
  BM.hideActivateModal();
  await BM.showResolveModal('a1');
  check('解决表单：指派人默认当前用户', doc.getElementById('resolveAssigneeDisplay').dataset.value === 'lijc');
  BM.hideResolveModal();

  // ============ 详情 ============
  await BM.showBugDetail('r1');
  const detail = doc.getElementById('bugDetailModal');
  check('详情：已解决显示中文状态', /已解决/.test(doc.getElementById('bugDetailHeaderInfo').textContent));
  check('详情：标题、优先级、严重程度、指派人都可编辑', detail.querySelector('.bug-detail-title') && detail.querySelector('[data-bd="priority"]') && detail.querySelector('[data-bd="severity"]') && detail.querySelector('[data-bd="assignee"]'));
  const btns = [...doc.getElementById('bugDetailActions').querySelectorAll('button')].map(b => b.textContent);
  check('详情：已解决的 Bug 底部是「关联禅道 Bug / 激活 / 删除」', btns.join() === '关联禅道 Bug,激活,删除', btns.join());
  detail.querySelector('[data-bd="severity"]').click();
  doc.querySelector('.bug-choice-menu [data-value="1"]').click();
  await tick(30);
  const sev = s.requests.find(r => r.path === '/api/zentao/bug/edit');
  check('详情里改严重程度：写回禅道，详情随之刷新', sev && sev.body.severity === 1 && /致命/.test(doc.querySelector('#bugDetailModal [data-bd="severity"]').textContent));
  await BM.showBugDetail('a1');
  const btns2 = [...doc.getElementById('bugDetailActions').querySelectorAll('button')].map(b => b.textContent);
  check('详情：已确认的 Bug 是「解决」而不是「已解决」', btns2.join() === '关联禅道 Bug,解决,删除', btns2.join());

  // ============ 关联禅道 Bug ============
  BM.showEditBugIdModal('a1', 102);
  const em = doc.getElementById('editBugIdModal');
  const idInput = em.querySelector('[data-eb="id"]');
  const save = em.querySelector('[data-eb="save"]');
  check('关联弹窗：标准结构（标题栏 / 正文 / 底部按钮），显示完整标题', em.querySelector('.modal-header') && em.querySelector('.modal-body') && em.querySelector('.modal-footer') && /已确认的 Bug/.test(em.textContent));
  idInput.value = '999';
  idInput.dispatchEvent(new win.Event('input'));
  await tick(500);
  check('关联：不存在的编号提示，不能保存', /没有 Bug #999/.test(em.textContent) && save.disabled);
  idInput.value = '468';
  idInput.dispatchEvent(new win.Event('input'));
  await tick(500);
  check('关联：存在的编号显示禅道标题后才能保存', /#468 卡中心测试异常/.test(em.textContent) && !save.disabled);
  save.click();
  await tick(30);
  const link = s.requests.find(r => r.path === '/api/bug/a1/zentaoId');
  check('关联：保存核对过的编号', link && link.body.zentaoId === '468' && !doc.getElementById('editBugIdModal'));

  for (const x of results) console.log(`  ${x.pass ? '✓' : '✗'} ${x.name}${x.pass || !x.extra ? '' : `   → ${String(x.extra).slice(0, 300)}`}`);
  const passed = results.filter(x => x.pass).length;
  console.log(`\n${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
