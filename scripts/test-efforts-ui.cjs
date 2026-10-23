/**
 * 真函数测试：工作日历里的工时（前端）
 *   - 日格子：填满 / 不足 / 缺填 / 今天 / 未来 / 周末的显示，工时进度条，周累计
 *   - 页头统计：本月累计、缺填天数（点了跳到第一个缺填日）
 *   - 先画缓存再刷新，页头提示同步状态；读取失败的提示
 *   - 日抽屉：当天明细、还差多少；填报表单校验、提交内容（日期=所点的这天，可补填过去）；
 *     自动算剩余工时；未来日期不能填；提交成功后日历刷新
 *   - 每条工时可修改 / 删除：内联编辑表单、校验、PUT / DELETE 请求内容；剩余填 0 先确认「任务将标记为已完成」，
 *     取消则不发请求；删除先确认；全员视角不提供修改 / 删除
 *   - 标签页叫「工作日历」，页头标题同步
 *   - 统计面板：按执行 / 任务 Top5；「我的 / 全员」切换：团队格子、成员 × 日期热力图、全员抽屉（只读）；
 *     全员先画缓存再刷新、第一次慢的提示
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
const TEAM = {
  month: '2025-03', standard: 8,
  members: [
    { account: 'wuf', name: '吴凡', role: 'dev', hours: 16, byDay: { '2025-03-17': 8, '2025-03-18': 8 } },
    { account: 'lijc', name: '李佳成', role: 'qa', hours: 11.5, byDay: { '2025-03-17': 8, '2025-03-18': 3.5 } },
    { account: 'zhouh', name: '周航', role: 'dev', hours: 0, byDay: {} }
  ],
  days: {
    '2025-03-17': { total: 16, byMember: { wuf: 8, lijc: 8 } },
    '2025-03-18': { total: 11.5, byMember: { wuf: 8, lijc: 3.5 } }
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
    if (u.startsWith('/api/reports/calendar')) return reply({ success: true, data: state.calOverride || calendar() });
    if (u === '/api/efforts?month=2025-03&cache=only') return reply({ success: true, data: { ...EFFORTS, days: state.cache === undefined ? null : state.cache }, syncedAt: 1741000000000, fromCache: true });
    if (u === '/api/efforts?month=2025-03') {
      if (state.freshDelay) await new Promise(r => setTimeout(r, state.freshDelay));
      if (state.freshFail) return reply({ success: false, message: '禅道连不上' }, 500);
      return reply({ success: true, data: { ...EFFORTS, days: state.days || EFFORTS.days }, syncedAt: Date.now(), fromCache: false });
    }
    if (u === '/api/efforts/team?month=2025-03&cache=only') return reply({ success: true, data: { ...TEAM, days: state.teamCache === undefined ? null : TEAM.days, members: state.teamCache === undefined ? null : TEAM.members }, syncedAt: 1741000000000, fromCache: true });
    if (u === '/api/efforts/team?month=2025-03') {
      if (state.teamDelay) await new Promise(r => setTimeout(r, state.teamDelay));
      if (state.teamFail) return reply({ success: false, message: '禅道连不上' }, 500);
      return reply({ success: true, data: TEAM, syncedAt: Date.now(), fromCache: false });
    }
    if (u === '/api/efforts/tasks') return reply({ success: true, data: TASKS });
    if (u === '/api/efforts' && method === 'POST' && body.left === 0 && !body.finish) return reply({ success: false, code: 'CONFIRM_FINISH', message: '剩余工时为 0：禅道会把这个任务标记为「已完成」。确认要完成吗？' }, 400);
    if (/^\/api\/efforts\/\d+$/.test(u) && method === 'PUT') {
      if (body.left === 0 && !body.finish) return reply({ success: false, code: 'CONFIRM_FINISH', message: '剩余工时为 0：禅道会把这个任务标记为「已完成」。确认要完成吗？' }, 400);
      if (state.putFail) return reply({ success: false, message: '日期不能晚于今天' }, 400);
      state.put = { id: u.split('/').pop(), body };
      state.days = JSON.parse(JSON.stringify(state.days || EFFORTS.days));
      for (const d of Object.values(state.days)) { const it = d.items.find(x => x.effortId === state.put.id); if (it) { d.hours = Math.round((d.hours - it.consumed + body.consumed) * 10) / 10; Object.assign(it, { consumed: body.consumed, left: body.left, work: body.work }); } }
      return reply({ success: true, data: { success: true } });
    }
    if (/^\/api\/efforts\/\d+\?taskId=/.test(u) && method === 'DELETE') {
      state.deleted = u;
      state.days = JSON.parse(JSON.stringify(state.days || EFFORTS.days));
      const id = u.split('?')[0].split('/').pop();
      for (const d of Object.values(state.days)) { const i = d.items.findIndex(x => x.effortId === id); if (i >= 0) { d.hours = Math.round((d.hours - d.items[i].consumed) * 10) / 10; d.items.splice(i, 1); } }
      return reply({ success: true, data: { success: true } });
    }
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
  state.confirms = [];
  win.Confirm = { show: async (title, msg) => { state.confirms.push([title, msg]); return state.confirmAnswer !== false; } };
  win.eval(`const API_BASE_URL='http://127.0.0.1:3721';\n${REP}\n${EFF}\nwindow.ReportApi = ReportApi;`);
  return { win, doc: win.document, state };
}

(async () => {
  let { win, doc, state } = setup({});
  check('标签页叫「工作日历」', [...doc.querySelectorAll('.tab-btn')].some(b => b.dataset.mode === 'report' && /工作日历/.test(b.textContent)));
  win.ReportPage.month = '2025-03';
  win.ReportPage.show(); await tick(40);
  const root = doc.getElementById('reportMode');
  const cell = (d) => doc.querySelector(`[data-effort-day="2025-03-${pad(d)}"]`);   // 用当前的 doc（后面会重建页面）
  check('页头标题是「工作日历」', /工作日历/.test(root.querySelector('.task-board-header h2').textContent));

  // ── 日格子 ──
  check('填满（8h）：绿色 + 进度条满', cell(17).classList.contains('is-full') && /8h/.test(cell(17).textContent) && cell(17).querySelector('.report-day-bar span').style.width === '100%');
  check('不足（3.5h）：琥珀色 + 进度条 44%', cell(18).classList.contains('is-partial') && /3\.5h/.test(cell(18).textContent) && cell(18).querySelector('.report-day-bar span').style.width === '44%');
  check('过去的工作日一小时没填：标红「未填工时」', cell(19).classList.contains('is-missing') && /未填工时/.test(cell(19).textContent));
  check('今天没填满不标红，今天有工时显示小时数', !cell(20).classList.contains('is-missing') && /1h/.test(cell(20).textContent) && cell(20).classList.contains('is-today'));
  check('今天高亮：有「今天」徽标、日期是实心圆、有高亮外圈的样式', cell(20).classList.contains('is-today') && !!cell(20).querySelector('.report-today-tag') && /今天/.test(cell(20).querySelector('.report-today-tag').textContent) && !!cell(20).querySelector('.report-day-n') && !cell(19).querySelector('.report-today-tag'));
  check('今天只有一个格子带徽标', root.querySelectorAll('.report-today-tag').length === 1);
  check('周末没填不标红', !cell(15).classList.contains('is-missing') && !cell(16).classList.contains('is-missing'));
  check('未来日期不可点', root.querySelector('.report-day.is-future').getAttribute('aria-disabled') === 'true' && !root.querySelector('.report-day.is-future').dataset.effortDay);
  check('周累计：3/17 那周 = 8 + 3.5 + 1 = 12.5h', /12\.5h/.test(root.querySelector('[data-report-key="2025-03-17"].report-week').textContent));

  // ── 节假日 / 调休：休息的标「休」、调休上班的标「班」，不算缺填 ──
  {
    const cal2 = calendar();
    const d3 = cal2.days.find(x => x.date === '2025-03-05'), d4 = cal2.days.find(x => x.date === '2025-03-08');
    Object.assign(d3, { holiday: true, weekend: true });      // 周三放假
    Object.assign(d4, { makeup: true, weekend: false });      // 周六调休上班
    const w2 = setup({}); w2.state.calOverride = cal2;
    w2.win.ReportPage.month = '2025-03'; w2.win.ReportPage.show(); await tick(60);
    const c5 = w2.doc.querySelector('[data-effort-day="2025-03-05"]'), c8 = w2.doc.querySelector('[data-effort-day="2025-03-08"]');
    check('节假日（3/5）：有「休」标签，不标红、不算缺填', !!c5.querySelector('.report-rest-tag') && !c5.classList.contains('is-missing') && !/未填工时/.test(c5.textContent));
    check('调休上班的周六（3/8）：有「班」标签，没填工时标红（要上班）', !!c8.querySelector('.report-work-tag') && c8.classList.contains('is-missing') && /未填工时/.test(c8.textContent));
    check('缺填天数：节假日不算，调休上班的周六算（比不设置时 11 天：-1 +1 = 11）', /11 天/.test(w2.doc.getElementById('reportStats').textContent), w2.doc.getElementById('reportStats').textContent);
  }

  // ── 页头统计 ──
  const stats = doc.getElementById('reportStats');
  check('页头：本月累计 12.5h', /本月累计/.test(stats.textContent) && /12\.5h/.test(stats.textContent));
  // 3 月 3~19 的工作日：3~7(5) + 10~14(5) + 19 = 11 天一小时都没填；17 满、18 填了 3.5h（不足但不算缺填）
  check('页头：缺填天数 = 过去工作日里一小时都没填的（填了但不足的不算）', /11 天/.test(stats.textContent), stats.textContent.replace(/\s+/g, ' '));
  check('填了 3.5h 的 3/18 不算缺填：格子是琥珀色，不是红色', cell(18).classList.contains('is-partial') && !cell(18).classList.contains('is-missing'));
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
  const idLink = drawer.querySelector('.effort-task-id[data-task-id="10"]');
  check('抽屉：每条明细带禅道任务编号 #10，可点', !!idLink && idLink.textContent === '#10' && drawer.querySelectorAll('.effort-task-id').length === 2);
  const opened = []; win.openInZentao = (t, id) => opened.push([t, id]);
  if (idLink) idLink.click();
  check('抽屉：点编号 → 在禅道打开该任务（type=task）', opened.length === 1 && opened[0][0] === 'task' && opened[0][1] === '10');
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
  check('补填的是本来就有工时的一天：缺填天数不变（11 天）', /11 天/.test(doc.getElementById('reportStats').textContent));
  doc.querySelector('#effortDrawer [data-eff="close"]').click();

  // ── 修改 / 删除 ──
  ({ win, doc, state } = setup({}));
  win.ReportPage.month = '2025-03'; win.ReportPage.show(); await tick(60);
  cell(17).click(); await tick(40);
  let dr = doc.getElementById('effortDrawer');
  if (!dr) throw new Error('抽屉没打开：cell(17) 不存在？' + doc.querySelectorAll('[data-effort-day]').length);
  check('每条工时有「修改」「删除」按钮', dr.querySelectorAll('.effort-item').length === 1 && !!dr.querySelector('[data-eff="edit"][data-id="1"]') && !!dr.querySelector('[data-eff="del"][data-id="1"]'));
  dr.querySelector('[data-eff="edit"]').click();
  const ef = dr.querySelector('.effort-edit-form');
  check('点修改：这条变成内联表单，带出日期 / 消耗 / 剩余 / 内容', !!ef && ef.querySelector('[name="consumed"]').value === '8' && ef.querySelector('[name="left"]').value === '0' && ef.querySelector('[name="work"]').value === '联调完成' && ef.querySelector('[name="date"]').value === '2025-03-17');
  dr.querySelector('[data-eff="edit-cancel"]').click();
  check('取消：回到原样，没发任何修改请求', !dr.querySelector('.effort-edit-form') && !state.reqs.some(r => r.method === 'PUT'));
  dr.querySelector('[data-eff="edit"]').click();
  const sub = (form) => form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  let f3 = dr.querySelector('.effort-edit-form');
  f3.querySelector('[name="consumed"]').value = '';
  sub(f3); await tick(5);
  check('修改：消耗为空被拦截', /消耗工时/.test(f3.querySelector('[data-eff-edit-err]').textContent) && !state.reqs.some(r => r.method === 'PUT'));
  f3.querySelector('[name="consumed"]').value = '6'; f3.querySelector('[name="left"]').value = ''; sub(f3); await tick(5);
  check('修改：剩余为空被拦截（0 = 做完，必须明确填）', /剩余工时/.test(f3.querySelector('[data-eff-edit-err]').textContent));
  f3.querySelector('[name="left"]').value = '2'; f3.querySelector('[name="work"]').value = '改后的内容'; sub(f3); await tick(60);
  check('修改：PUT /api/efforts/1，带任务 id、日期、消耗、剩余、内容', state.put && state.put.id === '1' && state.put.body.taskId === '10' && state.put.body.date === '2025-03-17' && state.put.body.consumed === 6 && state.put.body.left === 2 && state.put.body.work === '改后的内容', JSON.stringify(state.put));
  check('修改成功：提示、抽屉与日历格子更新（8h → 6h，变成不足）', state.toasts.some(t => t[1] === '工时已修改') && /已填 6h/.test(dr.querySelector('[data-eff-meta]').textContent) && cell(17).classList.contains('is-partial'), dr.querySelector('[data-eff-meta]').textContent);

  // 剩余填 0：先确认
  dr.querySelector('[data-eff="edit"]').click();
  f3 = dr.querySelector('.effort-edit-form');
  f3.querySelector('[name="left"]').value = '0'; state.confirmAnswer = false; state.put = null; sub(f3); await tick(40);
  check('剩余填 0：弹「任务将标记为已完成」确认；点取消 → 不修改，表单还在', state.confirms.some(c => /已完成/.test(c[0])) && !state.put && !!dr.querySelector('.effort-edit-form'));
  state.confirmAnswer = true; sub(f3); await tick(60);
  check('确认完成后带 finish:true 重发，修改成功', state.put && state.put.body.left === 0 && state.put.body.finish === true);

  // 禅道拒绝
  state.putFail = true;
  dr.querySelector('[data-eff="edit"]').click();
  f3 = dr.querySelector('.effort-edit-form'); sub(f3); await tick(40);
  check('修改被禅道拒绝：显示原因，表单保留可重试', /日期不能晚于今天/.test(f3.querySelector('[data-eff-edit-err]').textContent) && !f3.querySelector('button[type="submit"]').disabled);
  state.putFail = false;
  dr.querySelector('[data-eff="edit-cancel"]').click();

  // 删除
  state.confirmAnswer = false;
  dr.querySelector('[data-eff="del"]').click(); await tick(20);
  check('删除：先确认；点取消 → 不发 DELETE', state.confirms.some(c => /删除工时/.test(c[0])) && !state.deleted);
  state.confirmAnswer = true;
  dr.querySelector('[data-eff="del"]').click(); await tick(60);
  check('删除：DELETE /api/efforts/1?taskId=10', state.deleted === '/api/efforts/1?taskId=10', state.deleted);
  check('删除成功：提示、这天回到 0h、格子变回「未填」', state.toasts.some(t => t[1] === '工时已删除') && /已填 0h/.test(dr.querySelector('[data-eff-meta]').textContent) && cell(17).classList.contains('is-missing'), dr.querySelector('[data-eff-meta]').textContent);
  dr.querySelector('[data-eff="close"]').click();

  // 新增：剩余必填、0 要确认
  ({ win, doc, state } = setup({}));
  win.ReportPage.month = '2025-03'; win.ReportPage.show(); await tick(60);
  cell(19).click(); await tick(40);
  dr = doc.getElementById('effortDrawer');
  const nf = dr.querySelector('.effort-form');
  const setn = (name, v) => { const el = nf.querySelector(`[name="${name}"]`); el.value = v; el.dispatchEvent(new win.Event('input', { bubbles: true })); el.dispatchEvent(new win.Event('change', { bubbles: true })); };
  setn('taskId', '10'); setn('consumed', '2'); setn('work', '新增'); nf.querySelector('[name="left"]').value = '';
  sub(nf); await tick(5);
  check('新增：剩余不填被拦截（不再默默当成 0）', /请填写剩余工时/.test(dr.querySelector('[data-eff-err]').textContent) && !state.reqs.some(r => r.method === 'POST'));
  nf.querySelector('[name="left"]').value = '0'; state.confirmAnswer = false; sub(nf); await tick(40);
  check('新增：剩余 0 → 弹确认，取消则不记', state.confirms.some(c => /已完成/.test(c[0])) && !state.posted);
  state.confirmAnswer = true; sub(nf); await tick(60);
  check('新增：确认后带 finish:true 重发并成功', state.posted && state.posted.left === 0 && state.posted.finish === true);
  dr.querySelector('[data-eff="close"]').click();

  // 全员视角没有修改 / 删除
  ({ win, doc, state } = setup({}));
  win.ReportPage.month = '2025-03'; win.ReportPage.show(); await tick(60);
  doc.querySelector('[data-report-lens="team"]').click(); await tick(80);
  doc.querySelector('[data-effort-day="2025-03-17"]').click(); await tick(20);
  check('全员视角：抽屉里没有修改 / 删除按钮', !doc.querySelector('#effortDrawer [data-eff="edit"]') && !doc.querySelector('#effortDrawer [data-eff="del"]'));
  doc.querySelector('#effortDrawer [data-eff="close"]').click();

  // ── 禅道拒绝：显示原因，按钮恢复 ──
  ({ win, doc, state } = setup({}));
  win.ReportPage.month = '2025-03'; win.ReportPage.show(); await tick(60);
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

  // ── 统计面板（我的）──
  ({ win, doc, state } = setup({}));
  win.ReportPage.month = '2025-03'; win.ReportPage.show(); await tick(60);
  const panel = () => doc.getElementById('reportPanelBody');
  check('统计面板：按执行（项目甲 = 8 + 3.5 + 1 = 12.5h）', /按执行/.test(panel().textContent) && /项目甲/.test(panel().textContent) && /12\.5h/.test(panel().textContent));
  check('统计面板：任务 Top：接口联调 10h 排第一，写文档 2.5h 第二', (() => { const rows = [...panel().querySelectorAll('.report-bar-row')].map(r => r.textContent); const top = rows.filter(r => /接口联调|写文档/.test(r)); return /接口联调/.test(top[0]) && /10h/.test(top[0]) && /写文档/.test(top[top.length - 1]) && /2\.5h/.test(top[top.length - 1]); })(), [...panel().querySelectorAll('.report-bar-row')].map(r => r.textContent).join(' | '));

  // ── 全员视角 ──
  check('有「我的 / 全员」切换，默认「我的」', doc.querySelector('[data-report-lens="mine"]').classList.contains('active') && !doc.querySelector('[data-report-lens="team"]').classList.contains('active'));
  doc.querySelector('[data-report-lens="team"]').click(); await tick(80);
  const tcell = (d) => doc.querySelector(`[data-effort-day="2025-03-${pad(d)}"]`);
  check('切到全员：请求了全员工时', state.reqs.some(r => r.u === '/api/efforts/team?month=2025-03'));
  // 回归：补填 / 填报 / 修改之后，全员热力图要跟着重取（以前只重取"我的"，热力图停在改动之前，补过的日子仍是灰的）
  {
    const before = state.reqs.filter(r => r.u === '/api/efforts/team?month=2025-03').length;
    await win.ReportPage.refreshAfterWrite(); await tick(80);
    const after = state.reqs.filter(r => r.u === '/api/efforts/team?month=2025-03').length;
    check('写工时之后：全员工时（热力图的数据）也重新向后端要', after === before + 1, `${before} → ${after}`);
  }
  check('全员视角下今天同样高亮', !!tcell(20).querySelector('.report-today-tag'));
  check('全员格子：团队总工时 + 几个人填报', /团队 16h/.test(tcell(17).textContent) && /2\/3 人填报/.test(tcell(17).textContent), tcell(17).textContent);
  check('全员格子：所有人都填满才标绿；有人没填满标琥珀；没人填的过去工作日标红', tcell(18).classList.contains('is-partial') && !tcell(17).classList.contains('is-full') && tcell(19).classList.contains('is-missing') && /没人填工时/.test(tcell(19).textContent));
  check('全员页头：团队累计 27.5h、已填报 2/3 人', /27\.5h/.test(doc.getElementById('reportStats').textContent) && /2\/3 人/.test(doc.getElementById('reportStats').textContent), doc.getElementById('reportStats').textContent);
  check('全员周累计', /团队 27\.5h/.test(doc.querySelector('[data-report-key="2025-03-17"].report-week').textContent));
  const hm = doc.querySelector('.report-heatmap');
  check('热力图：每个成员一行（3 行），表头是当月每一天', hm && hm.querySelectorAll('tbody tr').length === 3 && hm.querySelectorAll('thead th').length === 2 + 31);
  check('热力图：吴凡 3/17 = 8h 满格（lv3）', hm.querySelectorAll('tbody tr')[0].querySelectorAll('.hm-cell')[16].classList.contains('lv3'));
  check('热力图：李佳成 3/18 = 3.5h（不足一半 lv1）', hm.querySelectorAll('tbody tr')[1].querySelectorAll('.hm-cell')[17].classList.contains('lv1'));
  check('热力图：周航过去的工作日没填标红，周末不标红', hm.querySelectorAll('tbody tr')[2].querySelectorAll('.hm-cell')[2].classList.contains('hm-miss') && !hm.querySelectorAll('tbody tr')[2].querySelectorAll('.hm-cell')[0].classList.contains('hm-miss'));
  check('热力图：成员合计列', /16h/.test(hm.querySelectorAll('tbody tr')[0].textContent) && /0h/.test(hm.querySelectorAll('tbody tr')[2].textContent));
  tcell(18).click(); await tick(20);
  const td = doc.getElementById('effortDrawer');
  check('全员抽屉：团队共 11.5h · 2/3 人已填 · 1 人未填', /团队共 11\.5h/.test(td.querySelector('[data-eff-meta]').textContent) && /2\/3 人已填/.test(td.querySelector('[data-eff-meta]').textContent) && /1 人未填/.test(td.querySelector('[data-eff-meta]').textContent), td.querySelector('[data-eff-meta]').textContent);
  check('全员抽屉：每人一行、没填的标「未填」，只读（没有填报表单）', td.querySelectorAll('.effort-member').length === 3 && /未填/.test(td.textContent) && !td.querySelector('.effort-form'));
  td.querySelector('[data-eff="close"]').click();
  doc.querySelector('[data-report-lens="mine"]').click(); await tick(20);
  check('切回我的：格子恢复为个人工时', /8h/.test(tcell(17).textContent) && !/团队/.test(tcell(17).textContent) && !!doc.getElementById('reportPanelBody').querySelector('.report-bar-row'));

  // 全员先画缓存再刷新 / 第一次慢的提示 / 失败
  ({ win, doc, state } = setup({ teamCache: true, teamDelay: 80 }));
  win.ReportPage.month = '2025-03'; win.ReportPage.lens = 'team'; win.ReportPage.show(); await tick(60);
  check('全员：缓存先画出来，提示「全员缓存 · 正在更新」', !!doc.querySelector('.report-heatmap') && /全员缓存/.test(doc.getElementById('reportSyncHint').textContent) && /更新/.test(doc.getElementById('reportSyncHint').textContent), doc.getElementById('reportSyncHint').textContent);
  await tick(120);
  check('全员：最新数据回来后提示「全员已同步」', /全员已同步/.test(doc.getElementById('reportSyncHint').textContent));
  ({ win, doc, state } = setup({ teamDelay: 80 }));
  win.ReportPage.month = '2025-03'; win.ReportPage.lens = 'team'; win.ReportPage.show(); await tick(60);
  check('全员没有缓存：提示第一次会比较慢', /第一次读取全员工时会比较慢/.test(doc.getElementById('reportSyncHint').textContent) && /读取中/.test(doc.getElementById('reportPanelBody').textContent), doc.getElementById('reportSyncHint').textContent);
  await tick(120);
  ({ win, doc, state } = setup({ teamFail: true }));
  win.ReportPage.month = '2025-03'; win.ReportPage.lens = 'team'; win.ReportPage.show(); await tick(60);
  check('全员读取失败：提示原因，页面不崩', /全员工时读取失败/.test(doc.getElementById('reportSyncHint').textContent));

  // 从待办跳过来：工时还没读到时先开抽屉，读到后自动补上内容
  ({ win, doc, state } = setup({ freshDelay: 80 }));
  win.ReportPage.month = '2025-03'; win.ReportPage.show(); win.EffortDrawer.open('2025-03-18'); await tick(30);
  check('工时还没读到：抽屉先显示「读取中」', /读取中/.test(doc.querySelector('#effortDrawer [data-eff-meta]').textContent));
  await tick(150);
  check('读到后抽屉自动更新', /已填 3\.5h/.test(doc.querySelector('#effortDrawer [data-eff-meta]').textContent), doc.querySelector('#effortDrawer [data-eff-meta]').textContent);

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
