/**
 * 真函数测试：工时计时器（前端）
 * jsdom 加载真实 newtab.html，原样执行 timer.js；EffortApi、Toast、Confirm 换成模拟，时间可控。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const EXT = path.join(__dirname, '..', 'extension');
const SRC = fs.readFileSync(path.join(EXT, 'timer.js'), 'utf8');
const HTML = fs.readFileSync(path.join(EXT, 'newtab.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const T0 = new Date(2026, 9, 26, 9, 0, 0).getTime();   // 2026-10-26 09:00
const tasks = [
  { id: '7', name: '兼容性通杀工具开发', execName: '执行A', status: 'doing', left: 5, estimate: 8, consumed: 3 },
  { id: '8', name: '蔻驰小程序部署', execName: '执行B', status: 'wait', left: 0, estimate: 0, consumed: 0 }
];

async function setup(s, { preset } = {}) {
  const dom = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  s.toasts = []; s.added = []; s.confirms = []; s.refreshed = 0; s.timerCalls = [];
  s.clock = s.clock || T0;
  if (preset) s.timer = preset;
  win.fetch = async (url, init = {}) => {
    const u = String(url).replace('http://127.0.0.1:3721', '');
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    const reply = (b, status = 200) => ({ ok: status < 400, status, json: async () => b });
    if (s.down) throw new TypeError('Failed to fetch');
    s.timerCalls.push(`${method} ${u}`);
    const now = () => ({ now: s.clock + (s.skew || 0) });
    if (u === '/api/timer') return reply({ success: true, data: { timer: s.timer || null, ...now() } });
    if (u === '/api/timer/start') {
      if (s.timer) return reply({ success: false, code: 'RUNNING', message: '已经有一个任务在计时了，请先停止', data: { timer: s.timer, ...now() } }, 409);
      s.timer = { taskId: body.taskId, name: body.name, startedAt: s.clock };
      return reply({ success: true, data: { timer: s.timer, ...now() } });
    }
    if (u === '/api/timer/clear') { s.timer = null; return reply({ success: true, data: { timer: null, ...now() } }); }
    return reply({ success: false }, 404);
  };
  win.EffortApi = {
    tasks: async () => { if (s.tasksFail) throw new Error('读不到任务'); return { data: s.tasks || tasks }; },
    add: async (body) => {
      s.added.push(body);
      if (s.addErrors && s.addErrors.length) { const e = s.addErrors.shift(); throw Object.assign(new Error(e.message), { code: e.code }); }
      return { success: true };
    }
  };
  win.Toast = { success: (m) => s.toasts.push(m), error: (m) => s.toasts.push(m), info: (m) => s.toasts.push(m), warning: (m) => s.toasts.push(m) };
  win.Confirm = { show: async (t, m) => { s.confirms.push(t); return s.confirmAnswer !== false; } };
  win.Account = { state: { state: 'ok', username: s.owner === undefined ? 'lijc' : s.owner } };
  win.ReportPage = { rendered: true, refresh: () => { s.refreshed++; } };
  win.__s = s;
  win.eval(`${SRC.replace(/if \(typeof window !== 'undefined'\) window.WorkTimer = WorkTimer;\nif \(typeof document !== 'undefined'\) \{[\s\S]*?\n\}\n?$/, '')}\nwindow.WorkTimer = WorkTimer; WorkTimer.nowMs = () => window.__s.clock; WorkTimer.init();`);
  await tick(15);   // 等 init 里的第一次读取（GET /api/timer）完成
  return { win, doc: win.document, $: (sel) => win.document.querySelector(sel) };
}

(async () => {
  // ---------- 纯计算 ----------
  let s = {};
  let { win, doc, $ } = await setup(s);
  const W = win.WorkTimer;
  check('格式化 00:23:11 / 超过 100 小时', W.format(23 * 60000 + 11000) === '00:23:11' && W.format(0) === '00:00:00' && W.format(101 * 3600000) === '101:00:00' && W.format(-5) === '00:00:00');
  check('消耗工时：25 分钟=0.4，90 分钟=1.5，不到 3 分钟按最小 0.1，超过 24 小时封顶 24', W.hours(25 * 60000) === 0.4 && W.hours(90 * 60000) === 1.5 && W.hours(60000) === 0.1 && W.hours(0) === 0.1 && W.hours(30 * 3600000) === 24);
  check('剩余建议：剩 5h − 消耗 1.5h = 3.5h；不会出现负数；非数字当 0', W.suggestLeft(5, 1.5) === 3.5 && W.suggestLeft(1, 3) === 0 && W.suggestLeft('x', 1) === 0);

  // ---------- 开始计时 ----------
  check('没有计时：显示 ⏱ 按钮，不显示计时条', !$('#timerBtn').hidden && $('#timerPill').hidden);
  $('#timerBtn').click();
  await tick(20);
  check('点 ⏱：弹出任务选择，列出可记工时的任务', !!$('.timer-picker') && doc.querySelectorAll('.tp-item').length === 2 && /进行中 · 执行A · 剩 5h/.test($('.tp-item').textContent));
  $('.tp-input').value = '蔻驰'; $('.tp-input').dispatchEvent(new win.Event('input'));
  check('可以筛选（按任务名）', doc.querySelectorAll('.tp-item').length === 1 && /蔻驰/.test($('.tp-item').textContent));
  $('.tp-input').value = '#7'; $('.tp-input').dispatchEvent(new win.Event('input'));
  check('也可以按编号筛选', doc.querySelectorAll('.tp-item').length === 1 && /兼容性/.test($('.tp-item').textContent));
  $('.tp-item').click();
  await tick(20);
  check('点任务：开始计时，选择框关闭，提示', !$('.timer-picker') && s.toasts.some(t => /开始计时：兼容性通杀工具开发/.test(t)));
  check('计时条出现：时间 + 任务名；⏱ 按钮隐藏', !$('#timerPill').hidden && /00:00:00/.test($('#timerPill').textContent) && /兼容性通杀工具开发/.test($('#timerPill').textContent) && $('#timerBtn').hidden);
  check('计时存在后端：任务、开始时间（不放浏览器）', s.timer && s.timer.taskId === '7' && s.timer.name === '兼容性通杀工具开发' && s.timer.startedAt === T0 && win.localStorage.length === 0, JSON.stringify(s.timer));
  s.clock = T0 + 83 * 60000 + 5000;
  W.render();
  check('时间走起来：01:23:05', /01:23:05/.test($('#timerPill').textContent));
  check('计时中再开始另一个：被拒绝，原来的不受影响', (await W.start({ id: '8', name: 'x' })) === false && s.timer.taskId === '7');

  // ---------- 停止并填工时 ----------
  $('#timerPill').click();
  await tick(20);
  const f = (n) => doc.querySelector(`.timer-box [name="${n}"]`);
  check('点计时条：弹出表单，显示任务和本次时长', /兼容性通杀工具开发/.test($('.timer-box').textContent) && /01:23:05/.test($('.timer-box').textContent));
  check('消耗按计时算（83 分钟 → 1.4h）、日期是开始那天、剩余 = 5 − 1.4', f('consumed').value === '1.4' && f('date').value === '2026-10-26' && f('left').value === '3.6', [f('consumed').value, f('date').value, f('left').value].join());
  f('consumed').value = '2'; f('consumed').dispatchEvent(new win.Event('input'));
  check('改消耗：剩余建议跟着变（5 − 2 = 3）', f('left').value === '3');
  f('left').value = '2.5'; f('left').dispatchEvent(new win.Event('input'));
  f('consumed').value = '1.5'; f('consumed').dispatchEvent(new win.Event('input'));
  check('手动改过剩余后：不再自动覆盖', f('left').value === '2.5');
  $('[data-tm="save"]').click(); await tick(10);
  check('没写工作内容：提示，不提交', /工作内容/.test($('.tm-error').textContent) && s.added.length === 0);
  f('work').value = '联调了通杀工具的设备接入';
  f('left').value = '';
  $('[data-tm="save"]').click(); await tick(10);
  check('没填剩余：提示，不提交', /剩余工时/.test($('.tm-error').textContent) && s.added.length === 0);
  f('left').value = '2.5'; f('consumed').value = '0';
  $('[data-tm="save"]').click(); await tick(10);
  check('消耗为 0 / 超过 24：提示', /消耗工时应大于 0/.test($('.tm-error').textContent));
  f('consumed').value = '1.5';

  // 失败：保留计时
  s.addErrors = [{ message: '禅道没有接受这条工时' }];
  $('[data-tm="save"]').click(); await tick(20);
  check('保存失败：显示原因，计时和已填内容都保留', /禅道没有接受/.test($('.tm-error').textContent) && !!W.current() && f('work').value === '联调了通杀工具的设备接入' && !$('[data-tm="save"]').disabled);
  $('[data-tm="save"]').click(); await tick(20);
  const a = s.added.pop();
  check('提交的工时：任务、日期、消耗、剩余、工作内容', a.taskId === '7' && a.date === '2026-10-26' && a.consumed === 1.5 && a.left === 2.5 && a.work === '联调了通杀工具的设备接入' && !a.finish, JSON.stringify(a));
  check('保存成功：计时结束、表单关闭、提示、刷新工作日历', !W.current() && !$('.timer-overlay') && $('#timerPill').hidden && !$('#timerBtn').hidden && s.toasts.some(t => /已记录 1.5 小时/.test(t)) && s.refreshed === 1);
  check('后端的计时记录已清掉', s.timer === null && s.timerCalls.includes('POST /api/timer/clear'));

  // ---------- 剩余填 0：先确认 ----------
  s = { clock: T0 }; ({ win, doc, $ } = await setup(s)); const W2 = win.WorkTimer;
  await W2.start({ id: '7', name: '任务A' }); s.clock = T0 + 30 * 60000; W2.render();
  $('#timerPill').click(); await tick(20);
  const g = (n) => doc.querySelector(`.timer-box [name="${n}"]`);
  g('work').value = '收尾'; g('left').value = '0';
  s.addErrors = [{ message: '剩余工时为 0：禅道会把这个任务标记为已完成', code: 'CONFIRM_FINISH' }];
  s.confirmAnswer = false;
  $('[data-tm="save"]').click(); await tick(30);
  check('剩余 0：禅道要求确认，选“再改改”→ 不完成任务，表单还在', s.confirms.includes('任务将标记为已完成') && s.added.length === 1 && !!$('.timer-overlay') && !!W2.current());
  s.confirmAnswer = true; s.addErrors = [{ message: 'x', code: 'CONFIRM_FINISH' }];
  $('[data-tm="save"]').click(); await tick(30);
  check('确认后：带 finish:true 再提交一次，计时结束', s.added.slice(-1)[0].finish === true && !W2.current());

  // ---------- 放弃 / 继续计时 ----------
  s = { clock: T0 }; ({ win, doc, $ } = await setup(s)); const W3 = win.WorkTimer;
  await W3.start({ id: '7', name: '任务A' }); s.clock = T0 + 20 * 60000; W3.render();
  $('#timerPill').click(); await tick(20);
  $('[data-tm="back"]').click();
  check('继续计时：关掉表单，计时不受影响', !$('.timer-overlay') && !!W3.current());
  $('#timerPill').click(); await tick(20);
  s.confirmAnswer = false; $('[data-tm="discard"]').click(); await tick(20);
  check('放弃但在确认框里取消：什么都不变', !!W3.current() && !!$('.timer-overlay'));
  s.confirmAnswer = true; $('[data-tm="discard"]').click(); await tick(20);
  check('放弃：计时清掉，表单关闭，没有提交工时', !W3.current() && !$('.timer-overlay') && s.added.length === 0);

  // ---------- 提示 ----------
  s = { clock: T0 }; ({ win, doc, $ } = await setup(s)); await win.WorkTimer.start({ id: '7', name: 'A' }); s.clock = T0 + 30000;
  $('#timerPill').click(); await tick(20);
  check('不到 1 分钟：提示按最小 0.1 小时算', /不到 1 分钟/.test($('.tm-warn').textContent) && doc.querySelector('.timer-box [name="consumed"]').value === '0.1');
  s = { clock: T0 }; ({ win, doc, $ } = await setup(s)); await win.WorkTimer.start({ id: '7', name: 'A' }); s.clock = T0 + 15 * 3600000;
  $('#timerPill').click(); await tick(20);
  check('超过 12 小时：提示可能忘了停止', /超过 12 小时/.test($('.tm-warn').textContent));
  s = { clock: T0, tasks: [] }; ({ win, doc, $ } = await setup(s)); await win.WorkTimer.start({ id: '99', name: '已完成的任务' }); s.clock = T0 + 3600000;
  $('#timerPill').click(); await tick(30);
  check('任务现在不能记工时了（不在可填列表里）：提示，剩余让用户自己填', /不能记工时了/.test($('.tm-error').textContent) && doc.querySelector('.timer-box [name="left"]').placeholder === '请填写');

  // ---------- 持久化 / 多标签 ----------
  s = { clock: T0 + 3600000 };
  ({ win, doc, $ } = await setup(s, { preset: { taskId: '7', name: '重开浏览器前就在计的', startedAt: T0 } }));
  check('重新打开页面（或换个浏览器）：从后端读到计时，接着前面的时间算', !$('#timerPill').hidden && /01:00:00/.test($('#timerPill').textContent) && /重开浏览器前就在计的/.test($('#timerPill').textContent) && s.timerCalls[0] === 'GET /api/timer');
  s = { clock: T0 + 3600000, skew: 5 * 60000 };   // 后端时钟比本机快 5 分钟
  ({ win, doc, $ } = await setup(s, { preset: { taskId: '7', name: 'A', startedAt: T0 } }));
  check('后端和本机时钟有差：以后端的时间为准校准（这里后端快 5 分钟 → 1 小时 5 分）', /01:05:00/.test($('#timerPill').textContent), $('#timerPill').textContent);
  s = { clock: T0 };
  ({ win, doc, $ } = await setup(s));
  s.timer = { taskId: '9', name: '另一个标签页开的', startedAt: T0 };
  await win.WorkTimer.refresh();
  check('别处（另一个标签页 / 浏览器）开始计时：这里刷新后同步显示', !$('#timerPill').hidden && /另一个标签页开的/.test($('#timerPill').textContent));
  s.timer = null;
  await win.WorkTimer.refresh();
  check('别处结束计时：这里刷新后同步消失', $('#timerPill').hidden && !$('#timerBtn').hidden);
  s.down = true;
  s.timer = { taskId: '9', name: '连不上时', startedAt: T0 };
  await win.WorkTimer.refresh();
  check('连不上后台：保持现状，不报错', $('#timerPill').hidden);
  s.down = false;
  s = { clock: T0 };
  ({ win, doc, $ } = await setup(s));
  s.timer = { taskId: '5', name: '别处已经在计时', startedAt: T0 };   // 本页还不知道
  check('别处已经在计时、本页不知道时再点开始：后端拒绝，本页同步成别处的计时', (await win.WorkTimer.start({ id: '7', name: 'x' })) === false && win.WorkTimer.current().taskId === '5' && s.toasts.some(t => /已经有一个任务在计时/.test(t)));

  // ---------- 选任务失败 / 转义 ----------
  s = { tasksFail: true }; ({ win, doc, $ } = await setup(s));
  $('#timerBtn').click(); await tick(30);
  check('读不到任务：说明原因', /读取失败：读不到任务/.test($('.timer-picker').textContent));
  s = { tasks: [{ id: '1', name: '<img src=x onerror=alert(1)>', execName: '<b>x</b>', status: 'wait', left: 1 }] }; ({ win, doc, $ } = await setup(s));
  $('#timerBtn').click(); await tick(30);
  check('任务名一律转义', !$('.timer-picker img') && !$('.timer-picker b'));
  const newtabSrc = fs.readFileSync(path.join(EXT, 'newtab.js'), 'utf8');
  const detailFn = newtabSrc.slice(newtabSrc.indexOf('function showTaskDetail(task) {'), newtabSrc.indexOf('\n}\n', newtabSrc.indexOf('function showTaskDetail(task) {')));
  check('“开始计时”按钮和点击处理都在任务详情函数里（不在别的函数里）', /detail-timer-btn" type="button">⏱ 开始计时/.test(detailFn) && /querySelector\('\.detail-timer-btn'\)/.test(detailFn) && /CollabPanel\.mount\(body\.querySelector\('\.collab-section'\), task/.test(detailFn));
  check('页面引入了 timer.js', /<script src="timer\.js"><\/script>/.test(fs.readFileSync(path.join(EXT, 'newtab.html'), 'utf8')));
  check('计时器不用浏览器本地存储（业务状态在后端）', !/localStorage|sessionStorage/.test(fs.readFileSync(path.join(EXT, 'timer.js'), 'utf8')));

  for (const x of results) console.log(`  ${x.pass ? '✓' : '✗'} ${x.name}${x.pass || !x.extra ? '' : `   → ${String(x.extra).slice(0, 300)}`}`);
  const passed = results.filter(x => x.pass).length;
  console.log(`\n${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
