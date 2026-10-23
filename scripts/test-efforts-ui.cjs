/**
 * 真函数测试：工作日历里的工时（前端）
 *   - 日格子：填满 / 不足 / 缺填 / 今天 / 未来 / 周末的显示，工时进度条，周累计
 *   - 页头统计：本月累计、缺填天数（点了跳到第一个缺填日）
 *   - 先画缓存再刷新，页头提示同步状态；读取失败的提示
 *   - 日抽屉：当天明细、还差多少；填报表单校验、提交内容（日期=所点的这天，可补填过去）；
 *     自动算剩余工时；未来日期不能填；提交成功后日历刷新
 *   - 标签页叫「工作日历」，页头标题同步
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const EXT = path.join(__dirname, '..', 'extension');
const REP = fs.readFileSync(path.join(EXT, 'reports.js'), 'utf8');
const EFF = fs.readFileSync(path.join(EXT, 'efforts.js'), 'utf8');
const HTML = fs.readFileSync(path.join(EXT, 'newtab.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');

// 2025 年 3 月；"今天" = 3 月 20 日（周四），其后为未来
const TODAY = '2025-03-20';
function calendar() {
  const days = [];
  for (let d = 1; d <= 31; d++) {
    const date = `2025-03-${pad(d)}`;
    const wd = new Date(2025, 2, d).getDay();
    days.push({ date, weekday: wd, weekend: wd === 0 || wd === 6, future: date > TODAY, today: date === TODAY, legacy: false, report: null });
  }
  const weeks = [];
  for (let b = new Date(2025, 2, 3); b <= new Date(2025, 2, 31); b.setDate(b.getDate() + 7)) {
    const begin = `2025-03-${pad(b.getDate())}`;
    const e = new Date(b); e.setDate(e.getDate() + 6);
    weeks.push({ key: begin, label: `${begin} 周报`, begin, end: `${e.getFullYear()}-${pad(e.getMonth() + 1)}-${pad(e.getDate())}`, future: begin > TODAY, report: null });
  }
  return { month: '2025-03', today: TODAY, eveningHour: 21, days, weeks, monthly: { key: '2025-03', future: false, report: null, autoDate: '2025-03-31' } };
}
const EFFORTS = {
  month: '2025-03', standard: 8, me: 'lijc',
  days: {
    '2025-03-17': { hours: 8, items: [{ effortId: '1', taskId: '10', taskName: '接口联调', execName: '项目甲', consumed: 8, left: 0, work: '联调完成' }] },
    '2025-03-18': { hours: 3.5, items: [
      { effortId: '2', taskId: '10', taskName: '接口联调', execName: '项目甲', consumed: 2, left: 6, work: '对字段' },
      { effortId: '3', taskId: '11', taskName: '写文档', execName: '项目甲', consumed: 1.5, left: 2, work: '补接口文档' }] },
    '2025-03-20': { hours: 1, items: [{ effortId: '4', taskId: '11', taskName: '写文档', execName: '项目甲', consumed: 1, left: 1, work: '继续写' }] }
  }
};
const TASKS = [
  { id: '10', name: '接口联调', execName: '项目甲', status: 'doing', estimate: 16, consumed: 10, left: 6 },
  { id: '12', name: '新需求评估', execName: '项目乙', status: 'wait', estimate: 4, consumed: 0, left: 4 }
];

function setup(state = {}) {
  const win = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true }).window;
  state.reqs = []; state.toasts = [];
  win.fetch = async (url, init = {}) => {
    const u = String(url).replace('http://127.0.0.1:3721', '');
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    state.reqs.push({ u, method, body });
    const reply = (b, s = 200) => ({ ok: s < 400, status: s, json: async () => b });
    if (u.startsWith('/api/reports/calendar')) return reply({ success: true, data: calendar() });
    if (u === '/api/efforts?month=2025-03&cache=only') return reply({ success: true, data: { ...EFFORTS, days: state.cache === undefined ? null : state.cache }, syncedAt: 1741000000000, fromCache: true });
    if (u === '/api/efforts?month=2025-03') {
      if (state.freshDelay) await new Promise(r => setTimeout(r, state.freshDelay));
      if (state.freshFail) return reply({ success: false, message: '禅道连不上' }, 500);
      return reply({ success: true, data: { ...EFFORTS, days: state.days || EFFORTS.days }, syncedAt: Date.now(), fromCache: false });
    }
    if (u === '/api/efforts/tasks') return reply({ success: true, data: TASKS });
    if (u === '/api/efforts' && method === 'POST') {
      if (state.postFail) return reply({ success: false, message: '禅道没有接受这条工时' }, 502);
      state.posted = body;
      // 提交成功后，那天多出一条
      state.days = JSON.parse(JSON.stringify(state.days || EFFORTS.days));
      const d = state.days[body.date] || (state.days[body.date] = { hours: 0, items: [] });
      d.hours += body.consumed;
      d.items.push({ effortId: '99', taskId: body.taskId, taskName: '接口联调', execName: '项目甲', consumed: body.consumed, left: body.left, work: body.work });
      return reply({ success: true, data: { success: true } });
    }
    return reply({ success: false, message: 'not mocked' }, 404);
  };
  win.Toast = { success: (m) => state.toasts.push(['success', m]), error: (m) => state.toasts.push(['error', m]), info() {}, warning() {} };
  win.eval(`const API_BASE_URL='http://127.0.0.1:3721';\n${REP}\n${EFF}\nwindow.ReportApi = ReportApi;`);
  return { win, doc: win.document, state };
}

(async () => {
  let { win, doc, state } = setup({});
  check('标签页叫「工作日历」', [...doc.querySelectorAll('.tab-btn')].some(b => b.dataset.mode === 'report' && /工作日历/.test(b.textContent)));
  win.ReportPage.month = '2025-03';
  win.ReportPage.show(); await tick(40);
  const root = doc.getElementById('reportMode');
  const cell = (d) => root.querySelector(`[data-effort-day="2025-03-${pad(d)}"]`);
  check('页头标题是「工作日历」', /工作日历/.test(root.querySelector('.task-board-header h2').textContent));

  // ── 日格子 ──
  check('填满（8h）：绿色 + 进度条满', cell(17).classList.contains('is-full') && /8h/.test(cell(17).textContent) && cell(17).querySelector('.report-day-bar span').style.width === '100%');
  check('不足（3.5h）：琥珀色 + 进度条 44%', cell(18).classList.contains('is-partial') && /3\.5h/.test(cell(18).textContent) && cell(18).querySelector('.report-day-bar span').style.width === '44%');
  check('过去的工作日一小时没填：标红「未填工时」', cell(19).classList.contains('is-missing') && /未填工时/.test(cell(19).textContent));
  check('今天没填满不标红，今天有工时显示小时数', !cell(20).classList.contains('is-missing') && /1h/.test(cell(20).textContent) && cell(20).classList.contains('is-today'));
  check('周末没填不标红', !cell(15).classList.contains('is-missing') && !cell(16).classList.contains('is-missing'));
  check('未来日期不可点', root.querySelector('.report-day.is-future').getAttribute('aria-disabled') === 'true' && !root.querySelector('.report-day.is-future').dataset.effortDay);
  check('周累计：3/17 那周 = 8 + 3.5 + 1 = 12.5h', /12\.5h/.test(root.querySelector('[data-report-key="2025-03-17"].report-week').textContent));

  // ── 页头统计 ──
  const stats = doc.getElementById('reportStats');
  check('页头：本月累计 12.5h', /本月累计/.test(stats.textContent) && /12\.5h/.test(stats.textContent));
  // 3 月 3~19 的工作日里不满 8 小时的：3~7(5) + 10~14(5) + 17 满 + 18 不足 + 19 = 12 天
  check('页头：缺填天数 = 过去工作日里不满标准工时的', /12 天/.test(stats.textContent), stats.textContent.replace(/\s+/g, ' '));
  stats.querySelector('[data-effort-day]').click(); await tick(20);
  check('点缺填 → 打开第一个缺填日（3/3）的抽屉', doc.getElementById('effortDrawer').classList.contains('active') && /3月3日/.test(doc.getElementById('effortDrawerTitle').textContent));
  doc.querySelector('#effortDrawer [data-eff="close"]').click();

  // ── 日抽屉 ──
  cell(18).click(); await tick(40);
  const drawer = doc.getElementById('effortDrawer');
  const meta = () => drawer.querySelector('[data-eff-meta]').textContent;
  check('抽屉标题带星期', /3月18日 周二/.test(doc.getElementById('effortDrawerTitle').textContent));
  check('抽屉：已填 3.5 / 8，还差 4.5', /已填 3\.5h \/ 8h/.test(meta()) && /还差 4\.5h/.test(meta()), meta());
  check('抽屉：列出当天 2 条明细（任务、小时、工作内容）', drawer.querySelectorAll('.effort-item').length === 2 && /对字段/.test(drawer.textContent) && /补接口文档/.test(drawer.textContent));
  check('抽屉：任务下拉来自接口（含未开始的）', drawer.querySelectorAll('select[name="taskId"] option').length === 3 && /未开始/.test(drawer.querySelector('select[name="taskId"]').textContent));
  check('抽屉：有「查看日报」入口', !!drawer.querySelector('[data-eff="report"]'));

  const f = drawer.querySelector('.effort-form');
  const set = (name, v) => { const el = f.querySelector(`[name="${name}"]`); el.value = v; el.dispatchEvent(new win.Event('input', { bubbles: true })); el.dispatchEvent(new win.Event('change', { bubbles: true })); };
  // 校验
  f.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true })); await tick(5);
  check('没选任务：提示并且不发请求', /请选择任务/.test(drawer.querySelector('[data-eff-err]').textContent) && !state.reqs.some(r => r.method === 'POST'));
  set('taskId', '10');
  f.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true })); await tick(5);
  check('没填小时：提示', /消耗工时/.test(drawer.querySelector('[data-eff-err]').textContent));
  set('consumed', '2');
  f.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true })); await tick(5);
  check('没写工作内容：提示（它会进日报）', /工作内容/.test(drawer.querySelector('[data-eff-err]').textContent) && !state.reqs.some(r => r.method === 'POST'));
  // 自动算剩余：任务剩余 6 - 消耗 2 = 4
  check('选任务 + 填小时：剩余自动算为 4', f.querySelector('[name="left"]').value === '4', f.querySelector('[name="left"]').value);
  // 「按还差的」一键填入
  drawer.querySelector('[data-eff="fill"]').click();
  check('点「按还差的 4.5h 填入」：消耗填 4.5，剩余变 1.5', f.querySelector('[name="consumed"]').value === '4.5' && f.querySelector('[name="left"]').value === '1.5');
  set('work', '补填：联调接口');
  f.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true })); await tick(60);
  check('提交：POST /api/efforts，日期 = 所点的这天（补填过去）', state.posted && state.posted.date === '2025-03-18' && state.posted.taskId === '10' && state.posted.consumed === 4.5 && state.posted.left === 1.5 && state.posted.work === '补填：联调接口', JSON.stringify(state.posted));
  check('成功后提示并重新向禅道要工时', state.toasts.some(t => t[0] === 'success') && state.reqs.filter(r => r.u === '/api/efforts?month=2025-03').length >= 2);
  check('成功后抽屉更新为 8h（已填满）', /已填 8h \/ 8h/.test(meta()) && /已填满/.test(meta()), meta());
  check('成功后日历格子变绿', cell(18).classList.contains('is-full'));
  check('成功后页头缺填天数少了一天', /11 天/.test(doc.getElementById('reportStats').textContent));
  doc.querySelector('#effortDrawer [data-eff="close"]').click();

  // ── 禅道拒绝：显示原因，按钮恢复 ──
  state.postFail = true;
  cell(19).click(); await tick(40);
  const f2 = doc.querySelector('#effortDrawer .effort-form');
  const set2 = (name, v) => { const el = f2.querySelector(`[name="${name}"]`); el.value = v; el.dispatchEvent(new win.Event('input', { bubbles: true })); };
  set2('taskId', '10'); set2('consumed', '1'); set2('work', 'x');
  f2.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true })); await tick(40);
  check('禅道没接受：抽屉里显示原因，按钮恢复可点', /禅道没有接受/.test(doc.querySelector('#effortDrawer [data-eff-err]').textContent) && !doc.querySelector('#effortDrawer [data-eff-submit]').disabled);
  doc.querySelector('#effortDrawer [data-eff="close"]').click();

  // ── 未来日期不能填 ──
  // 未来格子不可点，直接调用也只显示提示
  win.EffortDrawer.open('2025-03-25'); await tick(20);
  check('未来日期：只有提示，没有填报表单', /不能填工时/.test(doc.getElementById('effortDrawer').textContent) && !doc.querySelector('#effortDrawer .effort-form'));
  doc.querySelector('#effortDrawer [data-eff="close"]').click();

  // ── 先画缓存再刷新 ──
  ({ win, doc, state } = setup({ cache: EFFORTS.days, freshDelay: 80 }));
  win.ReportPage.month = '2025-03'; win.ReportPage.show(); await tick(40);
  const hint = () => doc.getElementById('reportSyncHint').textContent;
  check('缓存先画出来，页头提示「缓存 · 正在更新」', doc.querySelector('[data-effort-day="2025-03-17"]').classList.contains('is-full') && /缓存/.test(hint()) && /更新/.test(hint()), hint());
  await tick(120);
  check('最新数据回来后提示「已同步」', /已同步/.test(hint()), hint());

  // 没有缓存：提示第一次会慢
  ({ win, doc, state } = setup({ freshDelay: 80 }));
  win.ReportPage.month = '2025-03'; win.ReportPage.show(); await tick(40);
  check('没有缓存时提示「第一次会慢一点」', /第一次会慢/.test(doc.getElementById('reportSyncHint').textContent));
  await tick(120);

  // 更新失败
  ({ win, doc, state } = setup({ cache: EFFORTS.days, freshFail: true }));
  win.ReportPage.month = '2025-03'; win.ReportPage.show(); await tick(60);
  check('更新失败：保留缓存并提示', doc.querySelector('[data-effort-day="2025-03-17"]').classList.contains('is-full') && /更新失败/.test(doc.getElementById('reportSyncHint').textContent));

  // 完全读不到：不报错，格子退回报告快照
  ({ win, doc, state } = setup({ freshFail: true }));
  win.ReportPage.month = '2025-03'; win.ReportPage.show(); await tick(60);
  check('没缓存且读取失败：提示原因，日历照常显示', /工时读取失败/.test(doc.getElementById('reportSyncHint').textContent) && doc.querySelectorAll('.report-day[data-effort-day]').length > 0);

  const passed = results.filter(r => r.pass).length;
  for (const r of results) console.log(`${r.pass ? '✅' : '❌'} ${r.name}${r.extra ? `  (${r.extra})` : ''}`);
  console.log(`\n工时日历前端：${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
})();
