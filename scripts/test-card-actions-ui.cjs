/**
 * 真函数测试：卡片操作（前端）
 *   - 点禅道 ID：申请禅道地址权限 → 交浏览器会话给后端检查 → 失效则写入新会话 → 打开页面
 *   - 点附件角标：一张图直接预览；一个文件直接下载；多个弹浮层，图片可左右切换
 *   - 点执行标签：选择浮层（收藏优先、按项目分组、隐藏已关闭、可搜索、标注直接移动 / 需重建），
 *     未同步只改本地；需重建时二次确认，取消则不动
 *
 * jsdom 加载真实 newtab.html，原样执行 attachments.js，从 newtab.js 抽出真实代码；
 * chrome.* 与网络换成模拟。
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
/** 抽出包含某段特征文本的顶层语句（如全局委托的 addEventListener） */
function extractStatement(marker) {
  const node = AST.body.find(n => n.type === 'ExpressionStatement' && SRC.slice(n.start, n.end).includes(marker));
  if (!node) throw new Error(`找不到包含 ${marker} 的语句`);
  return SRC.slice(node.start, node.end);
}

/**
 * @param {object} state - 模拟后端与浏览器状态
 */
function setup(state) {
  const dom = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  state.requests = [];
  state.cookiesSet = [];
  state.tabs = [];
  state.toasts = [];
  state.permissionRequests = 0;
  win.__s = state;
  win.chrome = {
    permissions: {
      contains: async () => !!state.permissionAlready,
      request: async () => { state.permissionRequests++; return !!state.permissionGrant; }
    },
    cookies: {
      get: async () => (state.browserSid ? { value: state.browserSid } : null),
      set: async (c) => { state.cookiesSet.push(c); return c; }
    },
    tabs: { create: (o) => { state.tabs.push(o.url); } }
  };
  win.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : null;
    state.requests.push({ method, path: u.pathname, body });
    const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o, blob: async () => new win.Blob(['x']) });
    // 模拟后端正在重启：前 N 次请求连不上（浏览器抛 TypeError: Failed to fetch），/health 也要等到恢复
    if (state.downCalls > 0) { state.downCalls--; throw new TypeError('Failed to fetch'); }
    if (u.pathname === '/health') return json({ status: 'ok' });
    if (u.pathname === '/api/zentao/open') return json(state.openResult(body));
    if (u.pathname === '/api/executions') return json({ success: true, data: state.executions });
    if (u.pathname === '/api/executions/favorites') return json({ success: true, data: state.favorites.map(id => ({ id })) });
    if (/execution-options$/.test(u.pathname)) return json({ success: true, allowed: state.allowed });
    if (/\/api\/tasks\/[^/]+\/execution$/.test(u.pathname)) return json(state.changeResult(body));
    if (/\/api\/records\/[^/]+\/attachments$/.test(u.pathname)) return json({ success: true, items: state.items || [] });
    if (/\/content/.test(u.pathname)) return json({});
    return json({ success: false, message: `未模拟 ${u.pathname}` }, 404);
  };
  win.eval(`
    const API_BASE_URL = 'http://127.0.0.1:3721';
    URL.createObjectURL = () => 'blob:test';
    URL.revokeObjectURL = () => {};
    let allTasks = window.__s.allTasks || [];
    const Toast = {
      success(m){ window.__s.toasts.push(['success', m]); }, error(m){ window.__s.toasts.push(['error', m]); },
      warning(m){ window.__s.toasts.push(['warning', m]); }, info(m){ window.__s.toasts.push(['info', m]); }
    };
    const ProgressToast = { show(){}, hide(){} };
    const ZentaoBrowserClient = { getBaseUrl: () => window.__s.zentaoBase || '' };
    const loadTasks = async () => { window.__s.loaded = (window.__s.loaded || 0) + 1; };
    let selectedTaskId = null;
    let draggingProgressTask = null, draggingProgressElement = null, draggingProgressOriginalValue = null;
    const updateTaskProgress = async () => {}, updateTaskPriority = () => {}, updateProgressFromMouse = () => {};
    const openDatetimeModal = () => {}, onTitleClick = () => {}, syncTaskToZentao = () => {};
    const showTaskDetail = () => { window.__s.detailOpened = true; };
    ${extract(['escapeHtml', 'resetListenerScope', 'Confirm'])}
    ${ATT}
    ${extract(['fetchBackendWithRetry', 'openInZentao', 'ExecutionPicker', 'createTaskCard'])}
    ${extractStatement('[data-exec-task]')}
    window.__api = { fetchBackendWithRetry, openInZentao, ExecutionPicker, createTaskCard, Confirm, AttachmentQuickView, AttachmentPreview, attachmentBadgeHTML };
  `);
  return win;
}

const baseState = () => ({
  zentaoBase: 'http://z.test',
  openResult: (b) => ({ success: true, base: 'http://z.test', url: `http://z.test/zentao/${b.type}-view-${b.id}.html`, cookies: null }),
  executions: [], favorites: [], allowed: null,
  changeResult: () => ({ success: true, mode: 'local', message: 'ok' })
});

async function main() {
  // ============ 点禅道 ID：自动登录并打开 ============
  {
    const s = { ...baseState(), permissionGrant: true, browserSid: 'old-sid',
      openResult: (b) => ({ success: true, base: 'http://z.test', url: 'http://z.test/zentao/task-view-950.html?onlybody=yes', cookies: [{ name: 'zentaosid', value: 'new-sid', path: '/zentao/', httpOnly: true }] }) };
    const win = setup(s);
    await win.__api.openInZentao('task', 950);
    const openReq = s.requests.find(r => r.path === '/api/zentao/open');
    check('首次点击：申请禅道地址访问权限', s.permissionRequests === 1);
    check('把浏览器现有会话交给后端检查', openReq && openReq.body.browserSid === 'old-sid' && openReq.body.type === 'task' && openReq.body.id === '950', JSON.stringify(openReq && openReq.body));
    check('会话失效：按禅道的属性写入新会话 cookie', s.cookiesSet.length === 1 && s.cookiesSet[0].name === 'zentaosid' && s.cookiesSet[0].value === 'new-sid' &&
      s.cookiesSet[0].url === 'http://z.test/zentao/' && s.cookiesSet[0].path === '/zentao/' && s.cookiesSet[0].httpOnly === true, JSON.stringify(s.cookiesSet));
    check('写完会话后打开后端给的地址（看板任务为 onlybody 页）', s.tabs[0] === 'http://z.test/zentao/task-view-950.html?onlybody=yes', s.tabs[0]);
  }
  {
    const s = { ...baseState(), permissionAlready: true, browserSid: 'good-sid' };
    const win = setup(s);
    await win.__api.openInZentao('bug', 308);
    check('已授权：不再弹授权框', s.permissionRequests === 0);
    check('浏览器会话有效：不写 cookie，直接打开 Bug 页', s.cookiesSet.length === 0 && s.tabs[0] === 'http://z.test/zentao/bug-view-308.html');
  }
  {
    const s = { ...baseState(), permissionGrant: false,
      openResult: () => ({ success: true, base: 'http://z.test', url: 'http://z.test/zentao/task-view-1.html', cookies: [{ name: 'zentaosid', value: 'x', path: '/zentao/', httpOnly: true }] }) };
    const win = setup(s);
    await win.__api.openInZentao('task', 1);
    check('拒绝授权：不写 cookie，仍打开页面并提示手动登录', s.cookiesSet.length === 0 && s.tabs.length === 1 && s.toasts.some(t => t[0] === 'info' && /手动登录/.test(t[1])), JSON.stringify(s.toasts));
  }
  {
    const s = { ...baseState(), permissionAlready: true, openResult: () => ({ success: false, message: '禅道未启用' }) };
    const win = setup(s);
    await win.__api.openInZentao('task', 1);
    check('后端失败：提示原因，不打开空页面', s.tabs.length === 0 && s.toasts.some(t => t[0] === 'error' && /禅道未启用/.test(t[1])));
  }
  {
    // 后端正在重启：第一次请求和第一次健康检查都连不上，恢复后自动重试成功
    const s = { ...baseState(), permissionAlready: true, downCalls: 2 };
    const win = setup(s);
    await win.__api.openInZentao('bug', 7);
    check('后端正在重启：等它恢复后自动重试，照常打开禅道', s.tabs.length === 1 && /bug-view-7/.test(s.tabs[0]) && !s.toasts.some(t => t[0] === 'error'), JSON.stringify(s.toasts));
  }
  {
    // 一直连不上：给出能看懂的原因，而不是「Failed to fetch」
    const s = { ...baseState(), permissionAlready: true, downCalls: 1000 };
    const win = setup(s);
    let msg = '';
    try { await win.__api.fetchBackendWithRetry('http://127.0.0.1:3721/api/zentao/open', {}, 1200); } catch (e) { msg = e.message; }
    check('后端一直连不上：提示本地服务可能正在重启', /本地服务暂时连不上/.test(msg), msg);
  }
  {
    // 卡片上的 #ID 打开禅道（不再打开插件内详情）
    const s = { ...baseState(), permissionAlready: true };
    const win = setup(s);
    const card = win.__api.createTaskCard({ id: 't1', title: '任务', zentaoId: '944', status: 'todo', priority: 3, progress: 0, executionName: '工作日志', createdAt: new Date().toISOString() });
    win.document.body.appendChild(card);
    card.querySelector('.zentao-task-link').click();
    await tick(10);
    check('卡片上点禅道 ID：打开禅道页面而不是插件内详情', s.tabs[0] === 'http://z.test/zentao/task-view-944.html' && !s.detailOpened, JSON.stringify(s.tabs));
  }

  // ============ 点附件角标 ============
  {
    const s = { ...baseState(), items: [{ key: 'zentao:1', source: 'zentao', zentaoFileId: '1', name: 'a.png', size: 3, ext: 'png', kind: 'image', status: 'uploaded' }] };
    const win = setup(s);
    const holder = win.document.createElement('div');
    holder.innerHTML = win.__api.attachmentBadgeHTML({ id: 'r1', attachments: [{ status: 'uploaded' }] });
    let cardClicked = false;
    holder.addEventListener('click', () => { cardClicked = true; });
    win.document.body.appendChild(holder);
    holder.querySelector('[data-att-view]').click();
    await tick(20);
    const pv = win.document.getElementById('attPreview');
    check('角标：一张图直接全屏预览', pv && pv.classList.contains('active') && pv.querySelector('figcaption').textContent === 'a.png');
    check('角标：单张时不显示左右切换', [...pv.querySelectorAll('.att-preview-nav')].every(b => b.hidden));
    check('角标：点击不打开卡片详情', !cardClicked);
  }
  {
    const s = { ...baseState(), items: [
      { key: 'zentao:1', source: 'zentao', zentaoFileId: '1', name: 'a.png', size: 3, ext: 'png', kind: 'image', status: 'uploaded' },
      { key: 'zentao:2', source: 'zentao', zentaoFileId: '2', name: 'log.txt', size: 3, ext: 'txt', kind: 'text', status: 'uploaded' },
      { key: 'zentao:3', source: 'zentao', zentaoFileId: '3', name: 'b.png', size: 3, ext: 'png', kind: 'image', status: 'uploaded' }
    ] };
    const win = setup(s);
    const anchor = win.document.createElement('button');
    win.document.body.appendChild(anchor);
    await win.__api.AttachmentQuickView.open('r2', anchor);
    const pop = win.document.querySelector('.att-quickview');
    check('角标：多个附件弹出浮层并列出全部', pop && pop.querySelectorAll('.att-quickview-item').length === 3 && /附件（3）/.test(pop.textContent));
    pop.querySelectorAll('.att-quickview-item')[2].click();
    await tick(20);
    const pv = win.document.getElementById('attPreview');
    check('浮层：点图片进入预览（第 2 / 2 张）', pv.classList.contains('active') && /b\.png（2 \/ 2）/.test(pv.querySelector('figcaption').textContent), pv.querySelector('figcaption').textContent);
    pv.querySelector('.att-preview-next').click();
    await tick(20);
    check('预览：左右切换只在图片之间（跳过非图片）', /a\.png（1 \/ 2）/.test(pv.querySelector('figcaption').textContent), pv.querySelector('figcaption').textContent);
    win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    await tick(20);
    check('预览：方向键切换', /b\.png/.test(pv.querySelector('figcaption').textContent));
    win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' }));
    check('预览：Esc 关闭预览但保留附件浮层', !pv.classList.contains('active') && win.document.querySelector('.att-quickview'));
    win.document.body.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
    check('浮层：点外部关闭', !win.document.querySelector('.att-quickview'));
  }

  // ============ 点执行标签：换执行 ============
  const executions = [
    { id: '54', name: '开发', projectName: '主动网络探测', status: 'doing' },
    { id: '55', name: '测试', projectName: '主动网络探测', status: 'doing' },
    { id: '8', name: '需求', projectName: '上海张园小程序', status: 'closed' },
    { id: '174', name: '华夏银行 2026 交付', projectName: '华夏银行', status: 'doing' }
  ];
  {
    const task = { id: 't-synced', title: 'x', zentaoId: '944', executionId: '54', executionName: '开发', status: 'todo', priority: 3, progress: 0, createdAt: new Date().toISOString() };
    const s = { ...baseState(), executions, favorites: ['174'], allowed: ['54', '55'], allTasks: [task],
      changeResult: (b) => (b.rebuild ? { success: true, mode: 'rebuilt', message: '已在「华夏银行 2026 交付」重建为任务 #956', warnings: [] } : { success: false, needRebuild: true, executionName: '华夏银行 2026 交付' }) };
    const win = setup(s);
    const card = win.__api.createTaskCard(task);
    win.document.body.appendChild(card);
    card.querySelector('[data-exec-task]').click();
    await tick(30);
    const pop = win.document.querySelector('.exec-picker');
    check('点执行标签：弹出选择浮层', !!pop && !s.detailOpened);
    const groups = [...pop.querySelectorAll('.exec-picker-group')].map(g => g.textContent);
    check('收藏的执行排在最前', groups[0] === '★ 收藏', groups.join(','));
    check('已关闭的执行不出现', !/需求/.test(pop.textContent));
    const tagOf = (id) => (pop.querySelector(`[data-exec-id="${id}"] .exec-picker-tag`) || {}).textContent;
    check('标注：当前 / 直接移动 / 需重建', tagOf('54') === '当前' && tagOf('55') === '直接移动' && tagOf('174') === '需重建', `${tagOf('54')} ${tagOf('55')} ${tagOf('174')}`);
    check('当前执行不可选', pop.querySelector('[data-exec-id="54"]').disabled);
    const search = pop.querySelector('.exec-picker-search');
    search.value = '华夏';
    search.dispatchEvent(new win.Event('input'));
    check('搜索过滤', pop.querySelectorAll('.exec-picker-item').length === 2 && !/主动网络探测/.test(pop.querySelector('.exec-picker-list').textContent), pop.querySelectorAll('.exec-picker-item').length);

    // 需重建：先取消
    win.__api.Confirm.show = async (t, m) => { s.confirmMsg = m; return false; };
    pop.querySelector('[data-exec-id="174"]').click();
    await tick(30);
    const posts = () => s.requests.filter(r => /\/execution$/.test(r.path));
    check('需重建：先问后端，再向用户确认（说明工时与历史不迁移）', posts().length === 1 && !posts()[0].body.rebuild && /旧任务 #944/.test(s.confirmMsg) && /工时记录和操作历史不会带过去/.test(s.confirmMsg), s.confirmMsg);
    check('需重建：用户取消则不重建', posts().length === 1 && !s.loaded);

    // 需重建：确认
    win.__api.Confirm.show = async () => true;
    win.document.querySelector('[data-exec-task]').click();
    await tick(30);
    win.document.querySelector('.exec-picker [data-exec-id="174"]').click();
    await tick(30);
    check('需重建：确认后带 rebuild 重新提交并刷新列表', posts().length === 3 && posts()[2].body.rebuild === true && s.loaded === 1 && s.toasts.some(t => t[0] === 'success' && /#956/.test(t[1])), JSON.stringify(posts().map(p => p.body)));
  }
  {
    const task = { id: 't-local', title: 'x', executionId: '', executionName: '', status: 'todo', priority: 3, progress: 0, createdAt: new Date().toISOString() };
    const s = { ...baseState(), executions, favorites: [], allowed: null, allTasks: [task],
      changeResult: () => ({ success: true, mode: 'local', message: '已改为「测试」，同步到禅道时会建到该执行' }) };
    const win = setup(s);
    const card = win.__api.createTaskCard(task);
    win.document.body.appendChild(card);
    const tag = card.querySelector('[data-exec-task]');
    check('没有执行的任务显示「＋ 设置执行」', /设置执行/.test(tag.textContent) && tag.classList.contains('is-empty'));
    tag.click();
    await tick(30);
    const pop = win.document.querySelector('.exec-picker');
    check('未同步任务：不标注移动 / 重建', !pop.querySelector('.exec-picker-tag'));
    pop.querySelector('[data-exec-id="55"]').click();
    await tick(30);
    const post = s.requests.find(r => /\/execution$/.test(r.path));
    check('未同步任务：直接修改并刷新', post && post.body.executionId === '55' && !post.body.rebuild && s.loaded === 1 && s.toasts.some(t => t[0] === 'success'));
  }

  for (const r of results) console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${r.pass || !r.extra ? '' : `   → ${r.extra}`}`);
  const passed = results.filter(r => r.pass).length;
  console.log(`\n${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
