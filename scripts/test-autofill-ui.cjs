/**
 * 真函数测试：工时自动补填的界面（调试模式下的「补」，设计见 docs/AUTOFILL-PRD.md）
 *   - 可见性：调试模式关 → 日历里没有任何「补」（连 DOM 都没有）；开 → 只出现在「过去的工作日且工时 < 标准」的格子，
 *     今天 / 周末 / 将来 / 已满的没有；关掉调试后重绘即消失；月补按钮跟随调试开关，没有缺口时置灰
 *   - 日补：点「补」不会打开工时抽屉；生成方案时有加载态；预览能改任务 / 小时 / 内容、删除 / 添加、合计实时变化；
 *     同一天同一任务不能出现两次；换一批并入同一方案；重写内容
 *   - 确认写入：提交的是编辑后的内容；进度；完成汇总；失败 / 跳过原因；重试失败项；撤销本次补填
 *   - 月补：按天列出、可取消勾选、只提交所选的天；跳过的天说明原因
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const EXT = path.join(__dirname, '..', 'extension');
const SRC = ['reports.js', 'efforts.js', 'autofill.js'].map(f => fs.readFileSync(path.join(EXT, f), 'utf8')).join('\n');
const HTML = fs.readFileSync(path.join(EXT, 'newtab.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');

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
const EFFORTS = { month: '2025-03', standard: 8, me: 'lijc', days: {
  '2025-03-17': { hours: 8, items: [{ effortId: '1', taskId: '10', taskName: '接口联调', execName: '项目甲', consumed: 8, left: 0, work: '联调完成' }] },
  '2025-03-18': { hours: 3.5, items: [{ effortId: '2', taskId: '10', taskName: '接口联调', execName: '项目甲', consumed: 3.5, left: 6, work: '对字段' }] }
} };
const POOL = [{ id: '10', name: '接口联调', execName: '项目甲', left: 6, status: 'doing' }, { id: '11', name: '写文档', execName: '项目甲', left: 4, status: 'doing' }, { id: '15', name: '新任务', execName: '', left: 0, status: 'done' }];
const dayPlan = (date, variant = 0) => {
  const existing = date === '2025-03-18' ? 3.5 : 0, gap = 8 - existing;
  const a = variant ? 2 : (gap > 5 ? 5 : 3), tid = variant ? '15' : '10';
  const e1 = { taskId: tid, taskName: variant ? '新任务' : '接口联调', execName: '项目甲', taskStatus: variant ? 'done' : 'doing', hours: a, work: variant ? '梳理新需求并评估' : '联调订单接口并核对字段', source: 'ai' };
  const e2 = { taskId: '11', taskName: '写文档', execName: '项目甲', taskStatus: 'doing', hours: gap - a, work: '整理接口文档', source: variant ? 'template' : 'ai' };
  return { date, existing, gap, pool: POOL, entries: [e1, e2] };
};

function setup(state = {}) {
  const win = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true }).window;
  state.reqs = []; state.toasts = []; state.confirms = [];
  win.fetch = async (url, init = {}) => {
    const u = String(url).replace('http://127.0.0.1:3721', '');
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    state.reqs.push({ u, method, body });
    const reply = (b, s = 200) => ({ ok: s < 400, status: s, json: async () => b });
    if (u.startsWith('/api/reports/calendar')) return reply({ success: true, data: calendar() });
    if (u === '/api/efforts?month=2025-03&cache=only') return reply({ success: true, data: { ...EFFORTS, days: null }, syncedAt: 0 });
    if (u === '/api/efforts?month=2025-03') return reply({ success: true, data: EFFORTS, syncedAt: Date.now() });
    if (u === '/api/efforts/tasks') return reply({ success: true, data: [] });
    if (u === '/api/efforts/autofill/plan') {
      if (state.planDelay) await new Promise(r => setTimeout(r, state.planDelay));
      if (state.planFail) return reply({ success: false, message: '一次最多补 31 天，请分批' }, 400);
      if (state.emptyPlan) return reply({ success: true, data: { planId: 'p0', standard: 8, aiUsed: false, aiAvailable: true, days: [], skipped: [{ date: (body.dates || ['2025-03-19'])[0], reason: '这天没有你在做的任务可用（进行中，或当时还没完成的）' }] } });
      const dates = body.dates || ['2025-03-03', '2025-03-18', '2025-03-19'];
      return reply({ success: true, data: { planId: body.planId || 'p1', standard: 8, aiUsed: state.noAi ? false : true, aiAvailable: !state.noAi, days: dates.map(d => dayPlan(d, body.seed ? 1 : 0)), skipped: body.dates ? [] : [{ date: '2025-03-04', reason: '没有当天已存在的进行中任务（剩余工时 > 0）' }] } });
    }
    if (u === '/api/efforts/autofill/rewrite') { state.rewriteBody = body; return reply({ success: true, data: body.entries.map((e, i) => ({ work: `重写后的内容 ${i + 1}`, source: 'ai' })) }); }
    if (u === '/api/efforts/autofill/execute') { state.executed = body; state.polls = 0; return reply({ success: true, data: { jobId: 'b1', batchId: 'b1', total: body.days.reduce((n, d) => n + d.entries.length, 0) } }); }
    if (u === '/api/efforts/autofill/jobs/b1') {
      state.polls++;
      const total = state.executed.days.reduce((n, d) => n + d.entries.length, 0);
      if (state.polls < 3) return reply({ success: true, data: { id: 'b1', batchId: 'b1', state: 'running', total, done: state.polls, written: state.polls, hours: state.polls * 2, results: [] } });
      const flat = state.executed.days.flatMap(d => d.entries.map(e => ({ date: d.date, ...e })));
      const res = flat.map((e, i) => state.withFail && i === 0 ? { ...e, taskName: '接口联调', status: 'failed', error: '工时记录未生效' } : state.withFail && i === 1 ? { ...e, status: 'skipped', error: '这天的工时已被补满，跳过' } : { ...e, taskName: '接口联调', status: 'written', effortId: String(100 + i) });
      const written = res.filter(r => r.status === 'written');
      return reply({ success: true, data: { id: 'b1', batchId: 'b1', state: 'done', total, done: total, written: written.length, hours: written.reduce((n, r) => n + r.hours, 0), results: res } });
    }
    if (u === '/api/efforts/autofill/undo') { state.undone = body; return reply({ success: true, data: { undone: 2, kept: [{ reason: '这条工时后来被改过，没有删' }], failed: [] } }); }
    return reply({ success: false, message: 'not mocked' }, 404);
  };
  win.Toast = { success: (m) => state.toasts.push(['success', m]), error: (m) => state.toasts.push(['error', m]), warning: (m) => state.toasts.push(['warning', m]), info: (m) => state.toasts.push(['info', m]) };
  win.Confirm = { show: async (title) => { state.confirms.push(title); return state.confirmAnswer !== false; } };
  win.eval(`const API_BASE_URL='http://127.0.0.1:3721';\nvar debugMode = ${state.debug ? 'true' : 'false'};\n${SRC}\nwindow.AutofillDialog.pollMs = 10;`);
  return { win, doc: win.document, state };
}

const input = (win, el, v) => { el.value = v; el.dispatchEvent(new win.Event('input', { bubbles: true })); el.dispatchEvent(new win.Event('change', { bubbles: true })); };

(async () => {
  // ============ 可见性 ============
  let { win, doc, state } = setup({ debug: false });
  win.ReportPage.month = '2025-03'; win.ReportPage.show(); await tick(60);
  check('调试模式关：日历里没有任何「补」按钮（DOM 里都没有）', doc.querySelectorAll('.report-fill-btn').length === 0 && doc.querySelector('[data-fill-month]').hidden);

  ({ win, doc, state } = setup({ debug: true }));
  win.ReportPage.month = '2025-03'; win.ReportPage.show(); await tick(60);
  const fillDates = [...doc.querySelectorAll('.report-fill-btn')].map(b => b.dataset.fillDay);
  check('调试模式开：只出现在过去的工作日里工时 < 标准的格子（3/3~3/7、3/10~3/14、3/18、3/19）', fillDates.join() === '2025-03-03,2025-03-04,2025-03-05,2025-03-06,2025-03-07,2025-03-10,2025-03-11,2025-03-12,2025-03-13,2025-03-14,2025-03-18,2025-03-19', fillDates.join());
  check('已满（3/17）、今天（3/20）、周末、将来都没有「补」', !doc.querySelector('[data-effort-day="2025-03-17"] .report-fill-btn') && !doc.querySelector('[data-effort-day="2025-03-20"] .report-fill-btn') && !doc.querySelector('[data-effort-day="2025-03-15"] .report-fill-btn') && !doc.querySelector('[data-effort-day="2025-03-21"] .report-fill-btn'));
  const fm = doc.querySelector('[data-fill-month]');
  check('月补按钮：在「本月」后面，可见可点，提示有几天要补', !fm.hidden && !fm.disabled && /12 天/.test(fm.title) && fm.previousElementSibling.dataset.reportNav === '0', fm.title);
  win.eval('debugMode = false'); win.ReportPage.render();
  check('关掉调试模式后重绘：按钮全部消失', doc.querySelectorAll('.report-fill-btn').length === 0 && doc.querySelector('[data-fill-month]').hidden);
  win.eval('debugMode = true'); win.ReportPage.lens = 'team'; win.ReportPage.render();
  check('全员视角没有「补」（只补自己的）', doc.querySelectorAll('.report-fill-btn').length === 0 && doc.querySelector('[data-fill-month]').hidden);
  win.ReportPage.lens = 'mine'; win.ReportPage.render();

  // ============ 日补 ============
  ({ win, doc, state } = setup({ debug: true, planDelay: 60 }));
  win.ReportPage.month = '2025-03'; win.ReportPage.show(); await tick(60);
  doc.querySelector('[data-fill-day="2025-03-19"]').click(); await tick(15);
  const dlg = () => doc.getElementById('autofillDialog');
  check('点「补」：不会打开工时抽屉，而是弹出补填窗，先显示加载态', !doc.getElementById('effortDrawer') && !dlg().hidden && /正在生成方案/.test(dlg().textContent));
  await tick(100);
  const pr = state.reqs.find(r => r.u === '/api/efforts/autofill/plan');
  check('请求方案：只带这一天的日期（不写任何东西）', pr && JSON.stringify(pr.body.dates) === '["2025-03-19"]' && !state.reqs.some(r => r.u.endsWith('/execute')));
  check('预览：标题带日期和星期，列出 2 条，每条有任务下拉 / 小时 / 内容 / 来源标记', /3月19日 周三/.test(doc.getElementById('afTitle').textContent) && dlg().querySelectorAll('.af-entry').length === 2 && dlg().querySelector('.af-entry select').options.length === 3 && dlg().querySelector('.af-src').textContent === 'AI 撰写');
  check('预览：已填 0h → 补 8h，合计正好补满', /已填 0h → 补 8h/.test(dlg().textContent) && /正好补满/.test(dlg().querySelector('[data-af-tip]').textContent));
  const hoursEl = () => dlg().querySelectorAll('.af-entry input')[1];
  input(win, hoursEl(), '2');
  check('改小时（第二条 3h → 2h，合计 7h）：实时变成「还差 1h」，输入框不丢焦点（没有整体重绘）', /还差 1h/.test(dlg().querySelector('[data-af-tip]').textContent) && dlg().querySelectorAll('.af-entry input')[1] === hoursEl());
  input(win, hoursEl(), '5');
  check('改大了：提示「超出 2h」', /超出 2h/.test(dlg().querySelector('[data-af-tip]').textContent));
  input(win, hoursEl(), '3');
  const wk = dlg().querySelectorAll('.af-entry textarea')[0];
  input(win, wk, '我自己改的内容');
  check('改内容：来源标记变成「已手改」', dlg().querySelectorAll('.af-src')[0].textContent === '已手改');
  const sel1 = dlg().querySelectorAll('.af-entry select')[0];
  input(win, sel1, '11');
  check('同一天同一个任务不能出现两次：选了已有的任务会被拒绝并还原', sel1.value === '10' && state.toasts.some(t => /已经有这个任务/.test(t[1])));
  input(win, sel1, '15');
  check('可以换成候选池里的别的任务', sel1.value === '15');
  dlg().querySelectorAll('.af-del')[1].click();
  check('删掉一条：只剩 1 条（5h），提示还差 3h', dlg().querySelectorAll('.af-entry').length === 1 && /还差 3h/.test(dlg().querySelector('[data-af-tip]').textContent));
  dlg().querySelector('[data-af="add"]').click();
  check('添加一条：用候选池里还没用的任务', dlg().querySelectorAll('.af-entry').length === 2 && dlg().querySelectorAll('.af-entry select')[1].value === '10');

  // 重写内容
  dlg().querySelector('[data-af="rewrite-day"]').click(); await tick(30);
  check('重写内容：请求带当前的任务和小时，内容换成新的', state.rewriteBody && state.rewriteBody.planId === 'p1' && state.rewriteBody.entries.length === 2 && dlg().querySelectorAll('.af-entry textarea')[0].value === '重写后的内容 1');
  // 换一批
  dlg().querySelector('[data-af="reroll-day"]').click(); await tick(60);
  const rr = state.reqs.filter(r => r.u === '/api/efforts/autofill/plan').pop();
  check('换一批任务：用新的种子重新要方案，并带上 planId 并入同一个方案', rr.body.seed > 0 && rr.body.planId === 'p1' && JSON.stringify(rr.body.dates) === '["2025-03-19"]');
  check('换一批后预览换成新方案（新任务）', dlg().querySelectorAll('.af-entry select')[0].value === '15' && dlg().querySelectorAll('.af-src')[1].textContent === '模板内容');

  check('已完成的任务在下拉里标「已完成」，并且用到时有一条说明', /新任务 · 已完成/.test(dlg().querySelector('.af-entry select').textContent) && /部分条目补在「已完成」的任务上/.test(dlg().textContent));

  // 校验
  input(win, dlg().querySelectorAll('.af-entry input')[0], '0.3');
  dlg().querySelector('[data-af="confirm"]').click(); await tick(10);
  check('小时不是 0.5 的倍数：提示且不提交', state.toasts.some(t => /0\.5 的倍数/.test(t[1])) && !state.reqs.some(r => r.u.endsWith('/execute')));
  input(win, dlg().querySelectorAll('.af-entry input')[0], '2');
  input(win, dlg().querySelectorAll('.af-entry textarea')[0], '   ');
  dlg().querySelector('[data-af="confirm"]').click(); await tick(10);
  check('内容为空：提示且不提交', state.toasts.some(t => /没写工作内容/.test(t[1])) && !state.reqs.some(r => r.u.endsWith('/execute')));
  input(win, dlg().querySelectorAll('.af-entry textarea')[0], '梳理新需求并评估');

  // 确认写入
  const effReqsBefore = state.reqs.filter(r => r.u === '/api/efforts?month=2025-03').length;
  dlg().querySelector('[data-af="confirm"]').click(); await tick(10);
  check('确认：提交的是编辑后的内容（planId、日期、任务、小时、内容）', state.executed && state.executed.planId === 'p1' && state.executed.days.length === 1 && state.executed.days[0].date === '2025-03-19' && state.executed.days[0].entries[0].taskId === '15' && state.executed.days[0].entries[0].hours === 2 && state.executed.days[0].entries[0].work === '梳理新需求并评估', JSON.stringify(state.executed));
  check('写入中：显示进度', /写入/.test(dlg().textContent) && !!dlg().querySelector('.af-progress') && !!dlg().querySelector('[data-af="stop"]'));
  await tick(150);
  check('写入完成：汇总成功条数和小时，出现「撤销本次补填」', /写入完成/.test(dlg().textContent) && /成功 2 条（8h）/.test(dlg().textContent) && !!dlg().querySelector('[data-af="undo"]'), dlg().querySelector('.af-body').textContent);
  check('写入完成后日历向禅道重新要工时', state.reqs.filter(r => r.u === '/api/efforts?month=2025-03').length > effReqsBefore);
  dlg().querySelector('[data-af="undo"]').click(); await tick(40);
  check('撤销：先确认，再请求撤销这一批，并说明有一条因后来被改过没删', state.confirms.some(c => /撤销/.test(c)) && state.undone && state.undone.batchId === 'b1' && /已撤销 2 条/.test(dlg().textContent) && /被改过/.test(dlg().textContent) && !dlg().querySelector('[data-af="undo"]'));
  dlg().querySelector('[data-af="close"]').click();
  check('关闭补填窗', dlg().hidden);

  // 失败 / 跳过 / 重试
  ({ win, doc, state } = setup({ debug: true, withFail: true }));
  win.ReportPage.month = '2025-03'; win.ReportPage.show(); await tick(60);
  doc.querySelector('[data-fill-day="2025-03-19"]').click(); await tick(60);
  dlg().querySelector('[data-af="confirm"]').click(); await tick(200);
  check('有失败 / 跳过：汇总里列出每一条的原因，并提供「重试失败项」', /失败 1 条/.test(dlg().textContent) && /跳过 1 条/.test(dlg().textContent) && /工时记录未生效/.test(dlg().textContent) && /已被补满/.test(dlg().textContent) && !!dlg().querySelector('[data-af="retry"]'));
  state.withFail = false;
  dlg().querySelector('[data-af="retry"]').click(); await tick(200);
  check('重试失败项：只提交失败的那一条', state.executed.days.length === 1 && state.executed.days[0].entries.length === 1 && /写入完成/.test(dlg().textContent));
  dlg().querySelector('[data-af="close"]').click();

  // 生成方案失败
  ({ win, doc, state } = setup({ debug: true, planFail: true }));
  win.ReportPage.month = '2025-03'; win.ReportPage.show(); await tick(60);
  doc.querySelector('[data-fill-day="2025-03-19"]').click(); await tick(60);
  check('生成方案失败：窗里显示原因，只有关闭按钮', /一次最多补 31 天/.test(dlg().textContent) && !dlg().querySelector('[data-af="confirm"]'));
  win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' }));
  check('Esc 可以关闭', dlg().hidden);

  // 一天都补不了：原因直接摆出来
  ({ win, doc, state } = setup({ debug: true, emptyPlan: true }));
  win.ReportPage.month = '2025-03'; win.ReportPage.show(); await tick(60);
  doc.querySelector('[data-fill-day="2025-03-19"]').click(); await tick(60);
  check('一天都补不了：直接显示「没有可补的日子」和原因（不折叠），没有确认按钮可点', /没有可补的日子/.test(dlg().textContent) && /这天没有你在做的任务可用/.test(dlg().textContent) && !dlg().querySelector('.af-skipped') && dlg().querySelector('[data-af="confirm"]').disabled);
  dlg().querySelector('[data-af="close"]').click();

  // 没配 AI
  ({ win, doc, state } = setup({ debug: true, noAi: true }));
  win.ReportPage.month = '2025-03'; win.ReportPage.show(); await tick(60);
  doc.querySelector('[data-fill-day="2025-03-19"]').click(); await tick(60);
  check('没配 AI：预览顶部提示，内容可改', /没有配置 AI/.test(dlg().textContent));
  dlg().querySelector('[data-af="close"]').click();

  // ============ 月补 ============
  ({ win, doc, state } = setup({ debug: true }));
  win.ReportPage.month = '2025-03'; win.ReportPage.show(); await tick(60);
  doc.querySelector('[data-fill-month]').click(); await tick(80);
  const mp = state.reqs.find(r => r.u === '/api/efforts/autofill/plan');
  check('月补：按月份要方案', mp && mp.body.month === '2025-03' && !mp.body.dates);
  check('月补：标题是月份；按天列出（3 天），每天一个勾选框；只有第一天展开', /2025年03月|2025年3月/.test(doc.getElementById('afTitle').textContent) && dlg().querySelectorAll('.af-day').length === 3 && dlg().querySelectorAll('.af-day input[type="checkbox"]').length === 3 && dlg().querySelectorAll('.af-day.is-open').length === 1);
  check('月补：顶部合计（3 天 · 6 条 · 共 20.5h）', /3\/3 天 · 6 条 · 共 20\.5h/.test(dlg().querySelector('[data-af-sub]').textContent), dlg().querySelector('[data-af-sub]').textContent);
  check('月补：跳过的天折叠列出原因', /跳过的 1 天/.test(dlg().textContent) && /没有当天已存在的进行中任务/.test(dlg().textContent));
  const second = dlg().querySelectorAll('.af-day')[1];
  second.querySelector('[data-af="toggle"]').click();
  check('点一天展开它的明细', dlg().querySelectorAll('.af-day')[1].classList.contains('is-open'));
  dlg().querySelectorAll('.af-day input[type="checkbox"]')[0].click();
  check('取消勾选 3/3：合计变成 2 天', /2\/3 天/.test(dlg().querySelector('[data-af-sub]').textContent) && /所选 2 天/.test(dlg().querySelector('[data-af="confirm"]').textContent));
  dlg().querySelector('[data-af="confirm"]').click(); await tick(200);
  check('月补确认：只提交勾选的天（3/18、3/19）', state.executed.days.map(d => d.date).join() === '2025-03-18,2025-03-19', state.executed.days.map(d => d.date).join());
  check('月补完成：汇总', /写入完成/.test(dlg().textContent) && /成功 4 条/.test(dlg().textContent));
  dlg().querySelector('[data-af="close"]').click();
  win.document.querySelector('[data-fill-month]'); 
  win.ReportPage.efforts = { data: { ...EFFORTS, days: { ...EFFORTS.days, '2025-03-03': { hours: 8, items: [] } } } };
  // 没有缺口时置灰：把所有过去工作日都填满
  const full = {}; for (let d = 3; d <= 19; d++) { const s = `2025-03-${pad(d)}`; full[s] = { hours: 8, items: [] }; }
  win.ReportPage.efforts = { data: { ...EFFORTS, days: full } }; win.ReportPage.render();
  check('本月没有缺工时的日子：月补按钮置灰并说明', doc.querySelector('[data-fill-month]').disabled && /没有缺工时/.test(doc.querySelector('[data-fill-month]').title));

  const passed = results.filter(r => r.pass).length;
  for (const r of results) console.log(`${r.pass ? '✅' : '❌'} ${r.name}${r.extra ? `  (${r.extra})` : ''}`);
  console.log(`\n补填界面：${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
})();
