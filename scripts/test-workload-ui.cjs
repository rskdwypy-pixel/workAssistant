/**
 * 真函数测试：工作负载面板（前端）
 * jsdom 加载真实 newtab.html，原样执行 workload.js；网络换成模拟。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const EXT = path.join(__dirname, '..', 'extension');
const SRC = fs.readFileSync(path.join(EXT, 'workload.js'), 'utf8');
const HTML = fs.readFileSync(path.join(EXT, 'newtab.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

const task = (id, left, deadline, over = {}) => ({ id: String(id), title: `任务${id}`, left, estimate: left, pri: 3, status: 'wait', deadline, where: '执行A', ...over });
const day = (date, tasks = [], over = {}) => ({ date, weekday: new Date(`${date}T00:00:00`).getDay(), workday: ![0, 6].includes(new Date(`${date}T00:00:00`).getDay()), dueHours: tasks.reduce((a, t) => a + t.left, 0), tasks, cumNeeded: 0, cumCapacity: 8, short: 0, ...over });
const base = (over = {}) => ({
  today: '2026-10-26', days: 14, workHours: 8,
  summary: { openTasks: 3, totalLeft: 20, overdueCount: 0, overdueHours: 0, noDeadlineCount: 0, noDeadlineHours: 0, laterCount: 0, laterHours: 0, firstShortDate: '', maxShort: 0 },
  overdue: [], rows: [day('2026-10-26'), day('2026-10-27', [task(2, 6, '2026-10-27')], { cumNeeded: 6, cumCapacity: 16 }), day('2026-10-31', [], { workday: false })], later: [], noDeadline: [], ...over
});

function setup(s) {
  const dom = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  s.requests = []; s.opened = [];
  win.fetch = async (url) => {
    s.requests.push(String(url).replace('http://127.0.0.1:3721', ''));
    if (s.down) throw new TypeError('Failed to fetch');
    if (s.fail) return { ok: true, json: async () => ({ success: false, message: '读取失败了' }) };
    return { ok: true, json: async () => ({ success: true, data: s.data }) };
  };
  win.openInZentao = (t, id) => s.opened.push([t, id]);
  win.eval(`var API_BASE_URL = 'http://127.0.0.1:3721';\n${SRC.replace(/if \(typeof document !== 'undefined'\) \{[\s\S]*?\n\}\n?$/, '')}\nwindow.WorkloadPanel = WorkloadPanel; WorkloadPanel.init();`);
  return { win, doc: win.document, $: (sel) => win.document.querySelector(sel) };
}

(async () => {
  let s = { data: base() };
  let { win, doc, $ } = setup(s);
  check('右上角有工作负载按钮', !!$('#workloadBtn'));
  $('#workloadBtn').click();
  check('点开：先显示“读取中”', !!$('.wl-overlay') && /读取中/.test($('.wl-body').textContent));
  await tick(20);
  check('请求未来 14 天', s.requests[0] === '/api/workload?days=14');
  check('汇总：未完成个数、剩余工时、每天按几小时算', /未完成 3 个/.test($('.wl-chips').textContent) && /剩余 20h/.test($('.wl-chips').textContent) && /每天按 8h/.test($('.wl-chips').textContent));
  check('来得及：绿色结论', /来得及/.test($('.wl-verdict').textContent) && $('.wl-verdict').classList.contains('is-ok'));
  const days = [...doc.querySelectorAll('.wl-day')];
  check('逐日列出：日期周几、今天标注、休息日置灰并标“休”', days.length === 3 && /10\/26 周一（今天）/.test(days[0].textContent) && days[2].classList.contains('is-rest') && /休/.test(days[2].textContent));
  check('有任务的那天显示 N 个截止 · 工时，累计要做 / 可用', /1 个截止 · 6h/.test(days[1].textContent) && /6h \/ 16h/.test(days[1].textContent));
  check('任务默认收起，点那一天展开', doc.querySelector('[data-wl-tasks="2026-10-27"]').hidden === true);
  doc.querySelector('[data-wl-toggle="2026-10-27"]').click();
  check('展开后能看到任务、剩余工时、所属执行', doc.querySelector('[data-wl-tasks="2026-10-27"]').hidden === false && /任务2/.test(doc.querySelector('[data-wl-tasks="2026-10-27"]').textContent) && /剩 6h/.test(doc.querySelector('[data-wl-tasks="2026-10-27"]').textContent) && /执行A/.test(doc.querySelector('[data-wl-tasks="2026-10-27"]').textContent));
  doc.querySelector('[data-wl-tasks="2026-10-27"] [data-wl-open]').click();
  check('点任务：在禅道里打开', s.opened.length === 1 && s.opened[0].join(':') === 'task:2');
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('Esc 关闭', !$('.wl-overlay'));

  // 来不及 + 逾期
  s = { data: base({
    summary: { openTasks: 4, totalLeft: 40, overdueCount: 1, overdueHours: 10, noDeadlineCount: 2, noDeadlineHours: 9, laterCount: 1, laterHours: 3, firstShortDate: '2026-10-26', maxShort: 2 },
    overdue: [task(5, 10, '2026-10-20')],
    rows: [day('2026-10-26', [], { cumNeeded: 10, cumCapacity: 8, short: 2 }), day('2026-10-27', [task(2, 6, '2026-10-27')], { cumNeeded: 16, cumCapacity: 16 })],
    later: [task(7, 3, '2026-11-20')], noDeadline: [task(8, 5, ''), task(9, 4, '')]
  }) };
  ({ win, doc, $ } = setup(s));
  $('#workloadBtn').click(); await tick(20);
  check('来不及：红色结论，写明从哪天起、差多少', $('.wl-verdict').classList.contains('is-bad') && /10\/26/.test($('.wl-verdict').textContent) && /2h/.test($('.wl-verdict').textContent));
  check('逾期单独列在最前，并提示今天就得做', /已逾期（1）/.test($('.wl-body').textContent) && /任务5/.test($('.wl-body').textContent) && $('.wl-chip.is-bad') && /已逾期 1 个/.test($('.wl-chip.is-bad').textContent));
  check('来不及的那天标红，写明差几小时', $('.wl-day.is-short') && /差 2h/.test($('.wl-day.is-short').textContent) && $('.wl-bar-fill.is-short'));
  check('没设截止日 / 两周以后：折叠区，写明个数和工时', /没设截止日的任务（2 个 · 9h）/.test($('.wl-body').textContent) && /两周以后截止（1 个 · 3h）/.test($('.wl-body').textContent));

  // 没设截止日
  s = { data: base({ summary: { openTasks: 22, totalLeft: 0, overdueCount: 0, overdueHours: 0, noDeadlineCount: 22, noDeadlineHours: 0, laterCount: 0, laterHours: 0, firstShortDate: '', maxShort: 0 }, rows: [day('2026-10-26')], noDeadline: [task(1, 0, '')] }) };
  ({ win, doc, $ } = setup(s));
  $('#workloadBtn').click(); await tick(20);
  check('任务都没设截止日：说明怎么才能用上这个视图，不给“来得及”的假结论', /都没设截止日/.test($('.wl-body').textContent) && !$('.wl-verdict'));

  // 失败
  s = { fail: true, data: base() };
  ({ win, doc, $ } = setup(s));
  $('#workloadBtn').click(); await tick(20);
  check('读取失败：说明原因', /读取失败：读取失败了/.test($('.wl-body').textContent));
  s = { down: true };
  ({ win, doc, $ } = setup(s));
  $('#workloadBtn').click(); await tick(20);
  check('连不上后台：说明，不崩', /读取失败/.test($('.wl-body').textContent));
  $('.wl-close').click();
  check('点 × 关闭', !$('.wl-overlay'));

  // 转义
  s = { data: base({ overdue: [task(5, 1, '2026-10-20', { title: '<img src=x onerror=alert(1)>' })], summary: { ...base().summary, overdueCount: 1, overdueHours: 1 } }) };
  ({ win, doc, $ } = setup(s));
  $('#workloadBtn').click(); await tick(20);
  check('任务标题一律转义', !$('.wl-body img') && /<img src=x/.test($('.wl-body').textContent));
  check('页面引入了 workload.js', /<script src="workload\.js"><\/script>/.test(fs.readFileSync(path.join(EXT, 'newtab.html'), 'utf8')));

  for (const x of results) console.log(`  ${x.pass ? '✓' : '✗'} ${x.name}${x.pass || !x.extra ? '' : `   → ${String(x.extra).slice(0, 300)}`}`);
  const passed = results.filter(x => x.pass).length;
  console.log(`\n${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
