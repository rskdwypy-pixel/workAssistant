/**
 * 真函数测试：重复渲染 / 重复初始化不会叠加事件监听
 *
 * 真实 bug：改一次优先级，后端收到 9 次更新、禅道收到 9 次编辑（第 2 次起被禅道的
 * lastEditedDate 并发锁拒绝 → 提示「同步失败」）。原因是优先级菜单挂在 body 上复用，
 * 卡片每重新渲染一次就给菜单选项多绑一遍点击事件。
 * 同类问题：指派人 / 抄送下拉每次打开弹窗都重新初始化，常驻元素上的监听越绑越多，
 * 绑了偶数次时点一下开、又立刻关，下拉打不开。
 *
 * 用 jsdom 加载真实 newtab.html，从 newtab.js 原样抽出 createTaskCard / initTaskMultiSelect 等函数执行。
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const { JSDOM } = require('jsdom');

const EXT = path.join(__dirname, '..', 'extension');
const SRC = fs.readFileSync(path.join(EXT, 'newtab.js'), 'utf8');
const HTML = fs.readFileSync(path.join(EXT, 'newtab.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
const AST = acorn.parse(SRC, { ecmaVersion: 'latest', sourceType: 'script' });

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });

function extract(names) {
  return names.map((name) => {
    const node = AST.body.find(n =>
      (n.type === 'FunctionDeclaration' && n.id.name === name) ||
      (n.type === 'VariableDeclaration' && n.declarations.some(d => d.id.name === name)));
    if (!node) throw new Error(`newtab.js 里找不到 ${name}`);
    return SRC.slice(node.start, node.end);
  }).join('\n');
}

function setup() {
  const dom = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  win.__calls = { priority: [] };
  win.eval(`
    let selectedTaskId = null;
    let draggingProgressTask = null, draggingProgressElement = null, draggingProgressOriginalValue = null;
    const updateTaskProgress = async () => {};
    const updateTaskPriority = (id, p) => { window.__calls.priority.push([id, p]); };
    const updateProgressFromMouse = () => {};
    const openDatetimeModal = () => {};
    const onTitleClick = () => {};
    const showTaskDetail = () => {};
    const syncTaskToZentao = () => {};
    const openInZentao = (t, id) => { (window.__calls.opened = window.__calls.opened || []).push([t, id]); };
    ${extract(['escapeHtml', 'originChipsHTML', 'resetListenerScope', 'createTaskCard', 'initTaskMultiSelect', 'updateTaskMultiSelectDisplay'])}
    ${fs.readFileSync(path.join(EXT, 'attachments.js'), 'utf8')}
    window.__api = { createTaskCard, initTaskMultiSelect };
  `);
  return win;
}

function main() {
  // ============ 优先级菜单：重复渲染后点一次只更新一次 ============
  {
    const win = setup();
    const doc = win.document;
    const list = doc.getElementById('todoList') || doc.body;
    const task = { id: 't952', title: '阿迪新增confirmed小程序', status: 'todo', priority: 3, progress: 0, createdAt: new Date().toISOString() };

    // 模拟列表刷新 5 次：每次重建卡片
    let card;
    for (let i = 0; i < 5; i++) {
      list.innerHTML = '';
      card = win.__api.createTaskCard(task);
      list.appendChild(card);
    }
    const menus = doc.querySelectorAll('.priority-menu-t952');
    check('重复渲染 5 次后 body 上只有 1 个优先级菜单', menus.length === 1, `${menus.length} 个`);

    card.querySelector('.priority-toggle').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    check('点击优先级按钮打开菜单', menus[0].style.display === 'block');
    menus[0].querySelector('.priority-option[data-priority="2"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    check('选一次优先级只触发一次更新（原来渲染几次就触发几次）', win.__calls.priority.length === 1, `${win.__calls.priority.length} 次`);
    check('更新的是正确的任务和优先级', JSON.stringify(win.__calls.priority[0]) === JSON.stringify(['t952', 2]));

    // 优先级变成 2 后重新渲染：菜单选项随之更新
    list.innerHTML = '';
    card = win.__api.createTaskCard({ ...task, priority: 2 });
    list.appendChild(card);
    const opts = [...doc.querySelectorAll('.priority-menu-t952 .priority-option')].map(o => o.dataset.priority).join(',');
    check('重新渲染后菜单选项反映新优先级（不再停留在第一次）', opts === '1,3,4', opts);
  }

  // ============ 来源标签：需求 / Bug ============
  {
    const win = setup();
    const doc = win.document;
    const mk = (extra) => win.__api.createTaskCard({ id: 'tx', title: 't', status: 'todo', priority: 3, progress: 0, createdAt: new Date().toISOString(), ...extra });
    check('没有来源的任务不显示来源标签', mk({}).querySelectorAll('.task-origin').length === 0);
    const card = mk({ storyId: '165', storyTitle: '某需求', fromBug: '88' });
    doc.body.appendChild(card);
    const chips = [...card.querySelectorAll('.task-origin')];
    check('有来源需求 / Bug：显示「需求 #165」「Bug #88」', chips.map(c => c.textContent).join('|') === '需求 #165|Bug #88');
    chips[0].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    chips[1].dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    check('点标签在禅道打开对应的需求 / Bug（不触发卡片的其它点击）', JSON.stringify(win.__calls.opened) === JSON.stringify([['story', '165'], ['bug', '88']]));
  }

  // ============ 指派人下拉：弹窗反复打开后仍能正常展开 ============
  {
    const win = setup();
    const doc = win.document;
    const users = { lijc: '李佳成', qianj: '钱进' };
    for (let i = 0; i < 4; i++) win.__api.initTaskMultiSelect('taskAssignee', users); // 打开弹窗 4 次
    const display = doc.getElementById('taskAssigneeDisplay');
    const dropdown = doc.getElementById('taskAssigneeDropdown');
    display.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    check('初始化 4 次后点击指派人仍能展开（原来偶数次绑定会立即收起）', dropdown.style.display === 'block', dropdown.style.display);
    doc.body.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    check('点击外部收起下拉', dropdown.style.display === 'none');
  }

  for (const r of results) {
    console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${r.pass || !r.extra ? '' : `   → ${r.extra}`}`);
  }
  const passed = results.filter(r => r.pass).length;
  console.log(`\n${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
}

main();
