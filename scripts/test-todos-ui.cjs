/**
 * 真函数测试：我的待办（前端）
 *   - 分组渲染、逾期 / 今天标记、空分组不显示、全空时的提示
 *   - 点击条目：切到对应模块；需求直接打开详情
 *   - 标签角标 = 逾期 + 今天到期条数，为 0 时不显示
 *   - 部分来源失败的提示
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
  today: '2026-10-23', total: 4, errors: [],
  groups: [
    { key: 'task', label: '待办任务', tone: 'task', mode: 'task', items: [
      { kind: 'task', id: '1', title: '改版联调', pri: 2, due: 'overdue', meta: '进行中 30%' },
      { kind: 'task', id: '2', title: '写文档', pri: 3, due: '', meta: '待办' } ] },
    { key: 'bug', label: '待处理 Bug', tone: 'bug', mode: 'bug', items: [] },
    { key: 'story-review', label: '评审中的需求', tone: 'review', mode: 'story', items: [
      { kind: 'story', id: '172', title: '需求测试', pri: 3, due: '', meta: '评审中' } ] },
    { key: 'report', label: '日报', tone: 'report', mode: 'report', items: [
      { kind: 'report', id: '2026-10-23', title: '今天的日报还没生成', pri: 3, due: 'today', meta: '' } ] }
  ]
};

function setup(data) {
  const win = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true }).window;
  const st = { modes: [], stories: [] };
  win.fetch = async () => ({ ok: true, status: 200, json: async () => (data.fail ? { success: false, message: '炸了' } : { success: true, data }) });
  win.TabSwitcher = { switchMode: (m) => st.modes.push(m) };
  win.StoryViewer = { open: (id) => st.stories.push(id) };
  win.eval(`const API_BASE_URL='http://127.0.0.1:3721';\nfunction escapeHtml(t){const d=document.createElement('div');d.textContent=t==null?'':String(t);return d.innerHTML;}\n${SRC}`);
  return { win, doc: win.document, st };
}

(async () => {
  let { win, doc, st } = setup(DATA);
  check('HTML 里有「待办」标签和容器', !!doc.querySelector('.tab-btn[data-mode="todo"]') && !!doc.getElementById('todoMode'));
  win.TodoPage.show(); await tick(20);
  const body = doc.getElementById('todoBody');
  check('渲染 3 个非空分组（空的 Bug 组不显示）', body.querySelectorAll('.todo-group').length === 3 && !/待处理 Bug/.test(body.textContent));
  check('逾期 / 今天有标记', body.querySelector('.due-overdue') && body.querySelector('.due-today'));
  check('概览卡显示总数 4 与紧急提示', doc.querySelector('.todo-hero-num').textContent === '4' && /其中 2 项/.test(doc.querySelector('.todo-hero-sub').textContent));
  check('概览卡显示问候语与日期', /月.*日.*星期/.test(doc.querySelector('.todo-hero-label').textContent));
  check('外框头部有标题与统计（待处理 4 / 紧急 2）', /我的待办/.test(doc.querySelector('.task-board-header h2').textContent) && doc.getElementById('todoStatTotal').textContent === '4' && doc.getElementById('todoStatUrgent').textContent === '2');
  check('容器使用统一外框 mode-card', ['todoMode', 'storyMode', 'docMode', 'reportMode'].every(i => doc.getElementById(i).classList.contains('mode-card')));
  const badge = doc.querySelector('.tab-badge');
  check('角标 = 待办总数 4（不是紧急数）', badge && badge.textContent === '4');
  check('有逾期 / 今天到期时角标变红', badge.classList.contains('urgent'));
  const chips = [...doc.querySelectorAll('.todo-chip')];
  check('概览卡有 3 个分组计数（空组不出现）', chips.length === 3);
  chips.find(c => c.dataset.filter === 'task').click();
  check('点分组计数 → 只看该组', doc.querySelectorAll('.todo-group').length === 1 && /待办任务/.test(doc.getElementById('todoBody').textContent) && !/评审中的需求/.test(doc.getElementById('todoBody').querySelector('.todo-group').textContent));
  doc.querySelector('.todo-chip.active').click();
  check('再点一次 → 恢复全部', doc.querySelectorAll('.todo-group').length === 3);

  body.querySelector('[data-kind="task"][data-id="1"]').click();
  check('点任务 → 切到任务模块', st.modes.pop() === 'task');
  body.querySelector('[data-kind="story"]').click(); await tick(10);
  check('点需求 → 切到需求并打开详情', st.modes.pop() === 'story' && st.stories[0] === '172');
  body.querySelector('[data-kind="report"]').click();
  check('点日报 → 切到报告', st.modes.pop() === 'report');

  // 全空
  ({ win, doc, st } = setup({ today: 'x', total: 0, errors: [], groups: [{ key: 'task', label: '待办任务', tone: 'task', mode: 'task', items: [] }] }));
  win.TodoPage.show(); await tick(20);
  check('全空：显示「没有待处理的事项」', /没有待处理的事项/.test(doc.getElementById('todoBody').textContent));
  check('全空：不显示角标', !doc.querySelector('.tab-badge'));

  // 部分来源失败
  ({ win, doc, st } = setup({ ...DATA, errors: ['需求：禅道未启用或未配置'] }));
  win.TodoPage.show(); await tick(20);
  check('部分失败：提示哪些来源没取到', /部分来源没取到.*需求/.test(doc.getElementById('todoBody').textContent));

  // 接口失败
  ({ win, doc, st } = setup({ fail: true }));
  win.TodoPage.show(); await tick(20);
  check('接口失败：显示错误', /炸了/.test(doc.getElementById('todoBody').textContent));

  const passed = results.filter(r => r.pass).length;
  for (const r of results) console.log(`${r.pass ? '✅' : '❌'} ${r.name}${r.extra ? `  (${r.extra})` : ''}`);
  console.log(`\n待办前端：${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
})();
