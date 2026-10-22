/**
 * 真函数测试：报告页（前端）
 *   - 日历：月份标题、星期表头 + 周报列、已生成 / 未填工时 / 旧版日报 / 未来日期的格子、周报格子、月报按钮
 *   - 点以前的日期：没有报告则直接生成，显示「我的」AI 总结与统计
 *   - 全员：整体总结、未填工时名单、按人卡片（含 AI 按人总结、无工时记录）、按项目卡片（含 AI 按项目总结）
 *   - 今天未到生成时间：提示时刻 + 立即生成，不自动生成
 *   - AI 失败：提示原因并照常显示统计
 *   - 切月、Esc 关闭、禅道 ID 链接、推送失败提示
 *   - 侧栏「今日日报」等按钮打开报告页（脚本加载即绑定）；切到报告标签时渲染日历
 *   - 报告窗口：推送 / 复制 / 重新生成只作用于当前部分（我的 / 全员）；历史报告列表
 *   - 页面结构：设置按钮在标签栏，历史报告是侧栏图标；设置 → 全员报告成员
 *
 * jsdom 加载真实 newtab.html，原样执行 reports.js，从 newtab.js 抽出真实代码；网络换成模拟。
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const { JSDOM } = require('jsdom');

const EXT = path.join(__dirname, '..', 'extension');
const SRC = fs.readFileSync(path.join(EXT, 'newtab.js'), 'utf8');
const REP = fs.readFileSync(path.join(EXT, 'reports.js'), 'utf8');
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

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function calendarFixture() {
  const days = [];
  for (let d = 1; d <= 31; d++) {
    const date = `2025-03-${pad(d)}`;
    const wd = new Date(2025, 2, d).getDay();
    days.push({ date, weekday: wd, weekend: wd === 0 || wd === 6, future: d > 28, today: false, legacy: d === 5,
      report: d === 12 ? { myHours: 3, teamHours: 13, activeCount: 3, memberCount: 3, myMissing: 0 } : d === 11 ? { myHours: 0, teamHours: 4, activeCount: 1, memberCount: 3, myMissing: 1 } : null });
  }
  const weeks = ['2025-02-24', '2025-03-03', '2025-03-10', '2025-03-17', '2025-03-24', '2025-03-31'].map((k, i) => {
    const b = new Date(...k.split('-').map((v, j) => (j === 1 ? Number(v) - 1 : Number(v))));
    const e = new Date(b); e.setDate(e.getDate() + 6);
    return { key: k, label: `${k} 周报`, begin: k, end: ymd(e), future: i === 5, report: k === '2025-03-10' ? { myHours: 5, teamHours: 17, activeCount: 3, memberCount: 3 } : null };
  });
  return { month: '2025-03', today: '2025-03-28', eveningHour: 21, days, weeks, monthly: { key: '2025-03', label: '2025年3月 月报', future: false, report: null, autoDate: '2025-03-31' } };
}

function reportFixture(over = {}) {
  return {
    id: 'daily:2025-03-12', kind: 'daily', key: '2025-03-12', begin: '2025-03-12', end: '2025-03-12', label: '3月12日 日报',
    generatedAt: '2025-03-12T13:00:00.000Z', auto: true, durationMs: 12000,
    coverage: { executions: 52, members: 3, workdays: 1 }, warnings: [],
    mine: {
      account: 'lijc', name: '李佳成', hours: 3, byDay: { '2025-03-12': 3 }, missingDays: [],
      tasks: [{ taskId: '101', name: '接口联调', project: '项目甲', statusLabel: '进行中', hours: 3, works: ['和后端对齐字段'] }],
      finished: [], opened: 0, byProject: [{ project: '项目甲', hours: 3 }],
      bugs: { opened: [{ id: '1', title: '登录失败', productName: '产品A' }], resolved: [] },
      openTasks: [], overdue: [{ id: '101', name: '接口联调', deadline: '2025-03-10', statusLabel: '进行中' }],
      ai: { summary: '今天主要在联调接口', done: [], progress: ['接口联调过半'], next: ['继续联调'], risks: ['接口联调已逾期'] }, aiError: ''
    },
    team: {
      totalHours: 13, activeCount: 2, overdueTotal: 1,
      members: [
        { account: 'wuf', name: '吴凡', role: 'qd', hours: 10, byDay: {}, tasks: [{ taskId: '103', name: '看板卡片', project: '项目乙', hours: 10, works: ['上线'] }], finished: [{ id: '103', name: '看板卡片' }], opened: 1, missingDays: [] },
        { account: 'lijc', name: '李佳成', role: 'qa', hours: 3, byDay: {}, tasks: [{ taskId: '101', name: '接口联调', project: '项目甲', hours: 3, works: [] }], finished: [], opened: 0, missingDays: [] },
        { account: 'zhouh', name: '周航', role: 'dev', hours: 0, byDay: {}, tasks: [], finished: [], opened: 0, missingDays: ['2025-03-12'] }
      ],
      projects: [
        { project: '项目乙', hours: 10, finished: 1, members: [{ account: 'wuf', name: '吴凡', hours: 10 }], tasks: [{ taskId: '103', name: '看板卡片', hours: 10, people: ['吴凡'], statusLabel: '已完成' }] },
        { project: '项目甲', hours: 3, finished: 0, members: [{ account: 'lijc', name: '李佳成', hours: 3 }], tasks: [{ taskId: '101', name: '接口联调', hours: 3, people: ['李佳成'], statusLabel: '进行中' }] }
      ],
      overdue: [{ id: '101', name: '接口联调', assignedToName: '李佳成', deadline: '2025-03-10', project: '项目甲' }],
      ai: { overall: '团队今天主要推进项目乙上线', risks: ['周航未填工时'], byPerson: [{ account: 'wuf', summary: '吴凡完成了看板卡片上线' }], byProject: [{ project: '项目乙', summary: '项目乙已上线' }] },
      aiError: ''
    },
    ...over
  };
}

function setup(state) {
  const dom = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  state.requests = [];
  state.toasts = [];
  state.opened = [];
  win.__s = state;
  win.fetch = async (url, init = {}) => {
    const u = String(url).replace('http://127.0.0.1:3721', '');
    const method = (init.method || 'GET').toUpperCase();
    state.requests.push({ method, url: u, body: init.body ? JSON.parse(init.body) : null });
    const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (u.startsWith('/api/reports/calendar')) {
      const month = new URL(`http://x${u}`).searchParams.get('month');
      return reply({ success: true, data: { ...calendarFixture(), month } });
    }
    if (u.startsWith('/api/reports/legacy/')) return reply({ success: true, data: state.legacy || null });
    if (u === '/api/reports/list') return reply({ success: true, data: state.list || [] });
    if (u === '/api/reports/members' && method === 'GET') return reply({ success: true, data: { members: state.members || [], selected: state.selected || [], message: '' } });
    if (u === '/api/reports/members') return reply({ success: true, data: { selected: JSON.parse(init.body).accounts } });
    let m;
    if ((m = u.match(/^\/api\/reports\/(\w+)\/([\w-]+)\/generate$/))) {
      await new Promise(r => setTimeout(r, 30));
      return reply(state.generateFail ? { success: false, message: '模拟：禅道连不上' } : { success: true, data: state.generated || reportFixture() }, state.generateFail ? 500 : 200);
    }
    if ((m = u.match(/^\/api\/reports\/(\w+)\/([\w-]+)\/push$/))) return reply(state.pushFail ? { success: false, message: '还没有配置推送地址' } : { success: true }, state.pushFail ? 500 : 200);
    if ((m = u.match(/^\/api\/reports\/(\w+)\/([\w-]+)$/))) {
      const [, kind, key] = m;
      const begin = kind === 'monthly' ? `${key}-01` : key;
      return reply({ success: true, data: (state.stored || {})[`${kind}:${key}`] || null, period: { kind, key, begin, end: kind === 'monthly' ? `${key}-31` : key, label: `${key} ${kind}` }, status: { generating: false } });
    }
    return reply({ success: false, message: 'not mocked' }, 404);
  };
  win.Toast = { success: (m) => state.toasts.push(['success', m]), error: (m) => state.toasts.push(['error', m]), info: () => {}, warning: () => {} };
  win.Confirm = { show: async () => true };
  win.openInZentao = (type, id) => state.opened.push([type, id]);
  win.navigator.clipboard = { writeText: async (t) => { state.copied = t; } };
  win.eval(`const API_BASE_URL = 'http://127.0.0.1:3721';\n${REP}\nwindow.ReportApi = ReportApi;`);
  return { win, doc: win.document };
}

(async () => {
  // ============ 日历 ============
  let s = {};
  let { win, doc } = setup(s);
  win.ReportPage.month = '2025-03';
  win.ReportPage.show();
  await tick(20);
  const root = doc.getElementById('reportMode');
  check('标题显示月份', root.querySelector('.report-month-title').textContent === '2025年3月');
  const heads = [...root.querySelectorAll('.report-col-head')].map(h => h.textContent).join('');
  check('表头：周一到周日 + 周报', heads === '一二三四五六日周报', heads);
  const cell = (d) => root.querySelector(`[data-report-key="2025-03-${pad(d)}"]`);
  check('已生成的日报显示我的 / 全员工时', /我 3h/.test(cell(12).textContent) && /全员 13h · 3\/3 人/.test(cell(12).textContent) && cell(12).classList.contains('has-report'));
  check('工作日我没填工时：标红「未填工时」', cell(11).classList.contains('is-missing') && /未填工时/.test(cell(11).textContent));
  check('旧版日报标记', /旧版日报/.test(cell(5).textContent));
  const future = [...root.querySelectorAll('.report-day.is-future')];
  check('未来日期不可点', future.length === 3 && future.every(c => !c.dataset.reportOpen));
  check('周报格子：已生成显示工时，未来的周不可点', /我 5h/.test(root.querySelector('[data-report-key="2025-03-10"].report-week').textContent) && !root.querySelector('.report-week.is-future').dataset.reportOpen);
  check('跨月的日期留空（3 月前 5 天 + 后 6 天）', root.querySelectorAll('.report-day.is-outside').length === 11, root.querySelectorAll('.report-day.is-outside').length);
  check('月报按钮与生成时间说明', root.querySelector('.report-monthly-btn').textContent.includes('3月月报') && /3\/31/.test(root.querySelector('.report-hint').textContent));

  // 切月
  root.querySelector('[data-report-nav="1"]').click();
  await tick(20);
  check('切到下个月请求新月份', s.requests.some(r => r.url === '/api/reports/calendar?month=2025-04'));
  root.querySelector('[data-report-nav="-1"]').click();
  await tick(20);

  // ============ 点以前的日期：直接生成 ============
  cell(13).click();
  await tick(5);
  const drawer = () => doc.getElementById('reportDrawer');
  check('没有报告的以前日期：显示生成中', /正在从禅道读取数据/.test(drawer().textContent));
  await tick(80);
  check('自动调用生成接口', s.requests.some(r => r.method === 'POST' && r.url === '/api/reports/daily/2025-03-13/generate'));
  const body = () => drawer().querySelector('.report-drawer-body');
  check('我的：AI 总结与分组', /今天主要在联调接口/.test(body().textContent) && /接口联调过半/.test(body().textContent) && /继续联调/.test(body().textContent));
  check('我的：统计、工作明细、Bug、逾期', /涉及任务/.test(body().textContent) && /和后端对齐字段/.test(body().textContent) && /登录失败/.test(body().textContent) && /已逾期/.test(body().textContent));
  check('生成后刷新日历', s.requests.filter(r => r.url.startsWith('/api/reports/calendar')).length >= 4);

  // 全员
  drawer().querySelector('[data-report-tab="team"]').click();
  check('全员：整体 AI 总结与需要关注', /团队今天主要推进项目乙上线/.test(body().textContent) && /周航未填工时/.test(body().textContent));
  check('全员：未填工时名单', /未填工时：周航/.test(body().querySelector('.report-missing').textContent));
  const persons = [...body().querySelectorAll('.report-card')];
  check('按人：有记录的人一张卡片，AI 按人总结不用展开就能看到', persons.length === 2 && /吴凡完成了看板卡片上线/.test(persons[0].querySelector(':scope > .report-card-ai').textContent));
  check('按人：任务明细折叠在卡片里', persons[0].querySelector('details.report-card-more') && !persons[0].querySelector('details.report-card-more').open);
  check('按人：没有任何记录的人合成一行', /没有工时记录（1 人）：周航/.test(body().querySelector('.report-idle').textContent));
  body().querySelector('[data-report-teamtab="project"]').click();
  const projects = [...body().querySelectorAll('.report-card')];
  check('按项目：每个项目一张卡片，AI 按项目总结与参与人直接可见', projects.length === 2 && /项目乙已上线/.test(projects[0].querySelector(':scope > .report-card-ai').textContent) && /吴凡 10h/.test(projects[0].querySelector(':scope > .report-chips').textContent));
  check('数据范围说明', /52 个执行/.test(body().textContent) && /不含管理员/.test(body().textContent));

  // 禅道链接
  body().querySelector('[data-report-zentao]').click();
  check('点任务 ID 打开禅道页面', s.opened.length === 1 && s.opened[0][0] === 'task');

  // 只作用于当前部分：现在在「全员」
  check('标题旁显示当前部分的生成时间', /「全员」/.test(drawer().querySelector('.report-drawer-meta').textContent));
  drawer().querySelector('[data-report-act="push"]').click();
  await tick(20);
  const pushReq = s.requests.find(r => r.url.endsWith('/push'));
  check('全员下点推送：只推全员部分', pushReq && pushReq.body.part === 'team' && s.toasts.some(t => t[0] === 'success' && /「全员」/.test(t[1])), JSON.stringify(pushReq));
  drawer().querySelector('[data-report-act="copy"]').click();
  await tick(5);
  check('全员下点复制：只复制全员部分', /（全员）/.test(s.copied) && /团队今天主要推进项目乙上线/.test(s.copied) && !/今天主要在联调接口/.test(s.copied));
  const gensBefore = s.requests.filter(r => r.url.endsWith('/generate')).length;
  drawer().querySelector('[data-report-act="generate"]').click();
  await tick(80);
  const genReq = s.requests.filter(r => r.url.endsWith('/generate'))[gensBefore];
  check('全员下点重新生成：只重新生成全员部分', genReq && genReq.body && genReq.body.part === 'team', JSON.stringify(genReq));
  check('重新生成后仍停在全员', drawer().querySelector('.report-tab.active').dataset.reportTab === 'team');
  drawer().querySelector('[data-report-tab="mine"]').click();
  drawer().querySelector('[data-report-act="push"]').click();
  await tick(20);
  check('切回我的：推送的是我的部分', s.requests.filter(r => r.url.endsWith('/push')).pop().body.part === 'mine');

  // 推送失败
  s.pushFail = true;
  drawer().querySelector('[data-report-act="push"]').click();
  await tick(20);
  check('推送失败：提示原因', s.toasts.some(t => t[0] === 'error' && /推送地址/.test(t[1])));

  // Esc 关闭
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' }));
  check('Esc 关闭报告窗口', !drawer().classList.contains('active'));

  // ============ 今天未到生成时间 ============
  s = { legacy: null };
  ({ win, doc } = setup(s));
  const today = ymd(new Date());
  await win.ReportViewer.open('daily', today);
  await tick(20);
  check('今天还没生成：提示生成时刻，不自动生成', /自动生成/.test(doc.getElementById('reportDrawer').textContent) && !s.requests.some(r => r.method === 'POST'));
  doc.querySelector('#reportDrawer [data-report-act="generate"]').click();
  await tick(80);
  check('点「立即生成」才生成', s.requests.some(r => r.method === 'POST' && r.url === `/api/reports/daily/${today}/generate`));

  // ============ AI 失败 / 生成失败 ============
  s = { generated: reportFixture({ mine: { ...reportFixture().mine, ai: null, aiError: '未配置 AI（设置 → AI 模型），仅显示统计数据' } }) };
  ({ win, doc } = setup(s));
  await win.ReportViewer.open('daily', '2025-03-12');
  await tick(80);
  const t1 = doc.querySelector('#reportDrawer .report-drawer-body').textContent;
  check('AI 失败：说明原因并照常显示统计', /未配置 AI/.test(t1) && /涉及任务/.test(t1) && doc.querySelector('#reportDrawer .report-ai.is-error'));
  s = { generateFail: true };
  ({ win, doc } = setup(s));
  await win.ReportViewer.open('daily', '2025-03-12');
  await tick(80);
  check('生成失败：显示原因与重试', /模拟：禅道连不上/.test(doc.getElementById('reportDrawer').textContent) && doc.querySelector('#reportDrawer [data-report-act="generate"]'));

  // ============ 已保存的周报直接显示 ============
  s = { stored: { 'weekly:2025-03-10': reportFixture({ kind: 'weekly', key: '2025-03-10', begin: '2025-03-10', end: '2025-03-16', label: '周报', mine: { ...reportFixture().mine, byDay: { '2025-03-11': 2, '2025-03-12': 3 }, missingDays: ['2025-03-10'] } }) } };
  ({ win, doc } = setup(s));
  await win.ReportViewer.open('weekly', '2025-03-10');
  await tick(20);
  check('已保存的报告直接显示，不重新生成', !s.requests.some(r => r.method === 'POST') && /今天主要在联调接口/.test(doc.getElementById('reportDrawer').textContent));
  const strip = doc.querySelectorAll('#reportDrawer .report-strip-day');
  check('周报：按天工时条，未填工时的工作日标红', strip.length === 7 && doc.querySelector('#reportDrawer .report-strip-day.is-missing'));

  // ============ 侧栏按钮 / 标签切换 ============
  s = { list: [
    { kind: 'weekly', key: '2025-03-10', label: '3月10日–3月16日 周报', myHours: 5, teamHours: 20, summary: '本周联调' },
    { kind: 'daily', key: '2025-03-12', label: '3月12日 日报', myHours: 3, teamHours: 13, summary: '' }
  ] };
  ({ win, doc } = setup(s));
  // reports.js 加载即绑定侧栏按钮，不等页面初始化
  const openCalls = [];
  win.ReportPage.openReport = (kind, key) => openCalls.push([kind, key]);
  doc.getElementById('genDailyBtn').click();
  doc.getElementById('genMonthlyBtn').click();
  check('侧栏「今日日报」「本月月报」打开报告页对应报告', openCalls[0][0] === 'daily' && openCalls[0][1] === today && openCalls[1][0] === 'monthly' && openCalls[1][1] === today.slice(0, 7), JSON.stringify(openCalls));
  check('侧栏按钮文案', doc.getElementById('genDailyBtn').textContent === '今日日报');
  const historyBtn = doc.getElementById('viewAllHistory');
  check('历史报告：侧栏「智能总结」标题旁的图标按钮', historyBtn && historyBtn.closest('.summary-head-actions') && !historyBtn.textContent.trim() && historyBtn.title === '历史报告');
  historyBtn.click();
  await tick(20);
  const items = doc.querySelectorAll('#reportDrawer .report-history-item');
  check('历史报告：列出已生成的报告（与报告页同一份数据）', items.length === 2 && /本周联调/.test(items[0].textContent) && doc.getElementById('reportDrawer').classList.contains('active'));
  s.stored = { 'daily:2025-03-12': reportFixture() };
  items[1].click();
  await tick(20);
  check('历史报告：点开即在窗口中查看，可返回列表', /今天主要在联调接口/.test(doc.getElementById('reportDrawer').textContent) && doc.querySelector('#reportDrawer [data-report-act="history"]'));
  check('设置按钮在标签栏右侧（报告页也能打开），看板头部不再有设置 / 历史按钮',
    doc.querySelector('.mode-tabs #settingsBtn') && !doc.querySelector('.task-board-header #settingsBtn') && !doc.getElementById('bugSettingsBtn'));

  // ============ 设置 → 全员报告成员 ============
  s = { members: [{ account: 'lijc', realname: '李佳成', role: 'dev' }, { account: 'wangr', realname: '周航', role: '' }], selected: ['wangr', 'gone'] };
  ({ win, doc } = setup(s));
  await win.ReportMembersPicker.load();
  const boxes = [...doc.querySelectorAll('#reportMembersList input[type="checkbox"]')];
  check('成员：列出团队成员，已选的勾上；已选但不在团队里的也列出', boxes.length === 3 && boxes.filter(b => b.checked).map(b => b.value).join() === 'wangr,gone', boxes.map(b => `${b.value}:${b.checked}`).join());
  check('成员：勾选框不计入设置页改动跟踪（用隐藏输入框）', boxes.every(b => b.hasAttribute('data-no-track')) && doc.getElementById('reportMembers').value === 'wangr,gone');
  boxes[0].checked = true;
  boxes[2].checked = false;
  boxes[0].dispatchEvent(new win.Event('change', { bubbles: true }));
  check('成员：勾选后写回隐藏输入框', doc.getElementById('reportMembers').value === 'lijc,wangr', doc.getElementById('reportMembers').value);
  await win.ReportMembersPicker.save();
  const saveReq = s.requests.find(r => r.method === 'POST' && r.url === '/api/reports/members');
  check('成员：保存时提交选中的账号', saveReq && saveReq.body.accounts.join() === 'lijc,wangr');
  win.eval(`${extract(['TabSwitcher'])}\nwindow.TabSwitcher = TabSwitcher;`);
  let shown = 0;
  win.ReportPage.show = () => { shown++; };
  win.TabSwitcher.switchMode('report');
  check('切到「报告」标签：显示报告页并渲染日历', doc.getElementById('reportMode').classList.contains('active') && shown === 1 && !doc.getElementById('taskMode').classList.contains('active'));
  check('标签栏有「报告」', !!doc.querySelector('.tab-btn[data-mode="report"]'));

  for (const x of results) console.log(`  ${x.pass ? '✓' : '✗'} ${x.name}${x.pass || !x.extra ? '' : `   → ${x.extra}`}`);
  const passed = results.filter(x => x.pass).length;
  console.log(`\n${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
