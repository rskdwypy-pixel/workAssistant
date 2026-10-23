/**
 * 真函数测试：我的待办（前端）
 *   - 没有顶部总览卡；四张卡片排成两排：第一排 任务 | Bug，第二排 需求 | 文档
 *   - 逾期 / 今天标记；空卡片提示；页头统计与标签角标（总数，有紧急的变红）
 *   - 点击：切到对应标签页，并让目标那一条滚动 + 闪烁；需求 / 文档会先清掉过滤
 *   - 菜单顺序：待办 任务 Bug 需求 文档 报告；各页没有刷新按钮
 *   - 工时缺填提醒：没缺时不显示；缺了显示「昨天 3.5/8h、…」，点击跳到工作日历并打开最近缺填那天的抽屉
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const EXT = path.join(__dirname, '..', 'extension');
const SRC = fs.readFileSync(path.join(EXT, 'todos.js'), 'utf8');
const HTML = fs.readFileSync(path.join(EXT, 'newtab.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

const DATA = {
  today: '2026-10-23', total: 6, errors: [],
  groups: [
    { key: 'task', label: '待办任务', items: [
      { kind: 'task', id: 't-1', title: '改版联调', pri: 1, due: 'overdue', meta: '进行中 30%' },
      { kind: 'task', id: 't-2', title: '写文档', pri: 3, due: '', meta: '待办' } ] },
    { key: 'bug', label: '待处理 Bug', items: [
      { kind: 'bug', id: 'b-1', title: '登录超时', pri: 2, due: 'today', meta: '未确认' } ] },
    { key: 'story', label: '我的需求', items: [
      { kind: 'story', id: '172', title: '需求测试', pri: 3, due: '', meta: '评审中' } ] },
    { key: 'doc', label: '文档', items: [
      { kind: 'doc', id: '9', title: '接口说明', pri: 3, due: '', meta: '产品主库 · 2026-10-20' },
      { kind: 'doc', id: '10', title: '部署手册', pri: 3, due: '', meta: '产品主库 · 2026-10-19' } ] }
  ]
};

function setup(data) {
  const win = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true }).window;
  const st = { modes: [], revealed: [] };
  win.fetch = async () => ({ ok: true, status: 200, json: async () => (data.fail ? { success: false, message: '炸了' } : { success: true, data }) });
  win.TabSwitcher = { switchMode: (m) => st.modes.push(m) };
  win.StoryPage = { reveal: () => st.revealed.push('story') };
  win.DocPage = { reveal: () => st.revealed.push('doc') };
  win.ReportPage = { month: null };
  win.EffortDrawer = { open: (d) => { st.drawer = d; } };
  win.Element.prototype.scrollIntoView = function () { st.scrolled = (st.scrolled || 0) + 1; };
  win.eval(`const API_BASE_URL='http://127.0.0.1:3721';\nfunction escapeHtml(t){const d=document.createElement('div');d.textContent=t==null?'':String(t);return d.innerHTML;}\n${SRC}`);
  return { win, doc: win.document, st };
}

/** 在页面里造一个目标元素，模拟目标标签页渲染出来的卡片 */
const addTarget = (doc, parentSel, html) => { const p = doc.querySelector(parentSel) || doc.body; p.insertAdjacentHTML('beforeend', html); };

(async () => {
  let { win, doc, st } = setup(DATA);
  const tabs = [...doc.querySelectorAll('.mode-tabs .tab-btn')].map(b => b.dataset.mode);
  check('菜单顺序：待办 任务 Bug 需求 文档 报告', tabs.join() === 'todo,task,bug,story,doc,report', tabs.join());
  check('四个页面容器都用统一外框 mode-card', ['todoMode', 'storyMode', 'docMode', 'reportMode'].every(i => doc.getElementById(i).classList.contains('mode-card')));

  win.TodoPage.show(); await tick(20);
  check('没有顶部总览卡', !doc.querySelector('.todo-hero') && !doc.querySelector('.todo-chip'));
  check('没有刷新按钮', !doc.getElementById('todoRefresh'));
  const cards = [...doc.querySelectorAll('#todoBody .todo-card')].map(x => x.dataset.card);
  check('四张卡片按 任务、Bug、需求、文档 的顺序平铺（CSS 网格排成两排）', cards.join() === 'task,bug,story,doc', cards.join());
  const css = fs.readFileSync(path.join(EXT, 'newtab.css'), 'utf8');
  const grid = (css.match(/\.todo-grid \{[^}]*\}/) || [''])[0];
  check('网格是 2 列 × 2 行，每排各占一半高度', /grid-template-columns:\s*1fr 1fr/.test(grid) && /grid-template-rows:\s*1fr 1fr/.test(grid));
  check('不再有按列分组的容器', !doc.querySelector('.todo-col'));
  check('卡片头部显示条数', doc.querySelector('[data-card="task"] .todo-count').textContent === '2' && doc.querySelector('[data-card="doc"] .todo-count').textContent === '2');
  check('逾期 / 今天有标记', doc.querySelector('.due-overdue') && doc.querySelector('.due-today'));
  check('页头统计：待处理 6 / 逾期+今天 2', doc.getElementById('todoStatTotal').textContent === '6' && doc.getElementById('todoStatUrgent').textContent === '2');
  const badge = doc.querySelector('.tab-badge');
  check('角标 = 待办总数 6，有紧急所以变红', badge && badge.textContent === '6' && badge.classList.contains('urgent'));

  // ── 点击跳转 + 闪烁 ──
  doc.querySelector('[data-kind="task"][data-id="t-1"]').click();
  check('点任务 → 切到任务标签页', st.modes.pop() === 'task');
  addTarget(doc, 'body', '<div class="task-card" data-task-id="t-1">卡片</div>');
  await tick(250);
  check('任务目标：滚动到视野并闪烁', doc.querySelector('.task-card[data-task-id="t-1"]').classList.contains('wa-flash') && st.scrolled >= 1);

  doc.querySelector('[data-kind="bug"][data-id="b-1"]').click();
  check('点 Bug → 切到 Bug 标签页', st.modes.pop() === 'bug');
  addTarget(doc, 'body', '<div class="task-card bug-card" data-bug-id="b-1">Bug</div>');
  await tick(250);
  check('Bug 目标闪烁', doc.querySelector('.bug-card[data-bug-id="b-1"]').classList.contains('wa-flash'));

  doc.querySelector('[data-kind="story"][data-id="172"]').click();
  check('点需求 → 切到需求标签页并清掉过滤', st.modes.pop() === 'story' && st.revealed.includes('story'));
  addTarget(doc, 'body', '<div id="storyList"><button class="story-card" data-id="172">需求</button></div>');
  await tick(250);
  check('需求目标闪烁（不再直接弹详情）', doc.querySelector('#storyList [data-id="172"]').classList.contains('wa-flash'));

  doc.querySelector('[data-kind="doc"][data-id="9"]').click();
  check('点文档 → 切到文档标签页并清掉过滤', st.modes.pop() === 'doc' && st.revealed.includes('doc'));
  addTarget(doc, 'body', '<div id="docList"><button class="doc-item" data-id="9">文档</button></div>');
  await tick(250);
  check('文档目标闪烁', doc.querySelector('#docList [data-id="9"]').classList.contains('wa-flash'));

  // 列表重绘换了新节点（先缓存后最新）：对新节点再闪一次
  const oldEl = doc.querySelector('#docList [data-id="9"]');
  doc.querySelector('[data-kind="doc"][data-id="9"]').click();
  await tick(150);
  oldEl.remove();
  doc.getElementById('docList').insertAdjacentHTML('beforeend', '<button class="doc-item" data-id="9">新节点</button>');
  await tick(250);
  check('重绘后的新节点也会闪', doc.querySelector('#docList [data-id="9"]').classList.contains('wa-flash'));

  // 闪烁会自己结束
  await tick(2200);
  check('闪烁约 2 秒后自动结束', !doc.querySelector('#docList [data-id="9"]').classList.contains('wa-flash'));

  // ── 工时缺填提醒 ──
  ({ win, doc, st } = setup({ ...DATA, today: '2026-10-23', effortGaps: [{ date: '2026-10-22', hours: 3.5, standard: 8 }, { date: '2026-10-20', hours: 0, standard: 8 }] }));
  win.TodoPage.show(); await tick(20);
  const gap = doc.getElementById('todoGap');
  check('有缺填：显示提醒，昨天 / 具体日期 + 小时', !gap.hidden && /工时待补/.test(gap.textContent) && /昨天 3\.5\/8h/.test(gap.textContent) && /10月20日 0\/8h/.test(gap.textContent), gap.textContent);
  gap.querySelector('.todo-gap-btn').click();
  check('点提醒：切到工作日历，月份定位到该日，打开最近缺填那天的抽屉', st.modes.pop() === 'report' && win.ReportPage.month === '2026-10' && st.drawer === '2026-10-22');
  ({ win, doc, st } = setup({ ...DATA, effortGaps: [] }));
  win.TodoPage.show(); await tick(20);
  check('没有缺填：不显示提醒', doc.getElementById('todoGap').hidden);
  ({ win, doc, st } = setup({ ...DATA }));
  win.TodoPage.show(); await tick(20);
  check('后端没返回缺填信息：不显示提醒（兼容）', doc.getElementById('todoGap').hidden);

  // ── 空卡片 / 缺分组 ──
  ({ win, doc, st } = setup({ today: 'x', total: 0, errors: [], groups: [{ key: 'task', label: '任务', items: [] }] }));
  win.TodoPage.show(); await tick(20);
  check('取不到的来源也显示空卡片和提示', doc.querySelectorAll('.todo-card').length === 4 && /没有指派给你或评审中的需求/.test(doc.getElementById('todoBody').textContent));
  check('全空：不显示角标', !doc.querySelector('.tab-badge'));

  ({ win, doc, st } = setup({ ...DATA, errors: ['需求：禅道未启用或未配置'] }));
  win.TodoPage.show(); await tick(20);
  check('部分失败：提示哪些来源没取到', /部分来源没取到.*需求/.test(doc.getElementById('todoBody').textContent));

  ({ win, doc, st } = setup({ fail: true }));
  win.TodoPage.show(); await tick(20);
  check('接口失败：显示错误', /炸了/.test(doc.getElementById('todoBody').textContent));

  // 其它页面没有刷新按钮
  const stories = fs.readFileSync(path.join(EXT, 'stories.js'), 'utf8');
  const docs = fs.readFileSync(path.join(EXT, 'docs.js'), 'utf8');
  check('需求页、文档页没有刷新按钮', !/storyRefresh|docRefresh/.test(stories + docs));

  const passed = results.filter(r => r.pass).length;
  for (const r of results) console.log(`${r.pass ? '✅' : '❌'} ${r.name}${r.extra ? `  (${r.extra})` : ''}`);
  console.log(`\n待办前端：${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
})();
