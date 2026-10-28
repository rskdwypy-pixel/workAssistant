/**
 * 真函数测试：需求拆任务 / Bug 转任务 的前端弹窗（task-link.js）
 *   - Bug 转任务：已转过 → 只显示"已转"不给提交；否则预填（标题前缀 / 步骤 / 优先级映射）并提交到正确接口
 *   - 需求拆任务：默认模板行、增删行、合计；标题为空 / 重名拦在前端；
 *     部分失败时成功的行被拿掉、失败的留下并标原因（再点创建不会重复建）
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'extension', 'task-link.js'), 'utf8');
const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

function setup(state) {
  const win = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true }).window;
  state.reqs = []; state.toasts = [];
  win.escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // 与真实 Toast 一致：方法内部用 this（摘出来单独调用会抛错）
  win.Toast = { list: state.toasts, add(k, m) { this.list.push([k, m]); }, success(m) { this.add('ok', m); }, warning(m) { this.add('warn', m); }, info(m) { this.add('info', m); }, error(m) { this.add('err', m); } };
  win.ZentaoBrowserClient = { getUsers: async () => ({ lijc: '李佳成', nuanshu: '何俞龙' }) };
  win.ConfigStore = { flat: () => ({ zentaoUsername: 'lijc' }) };
  win.loadTasks = () => { state.reloaded = (state.reloaded || 0) + 1; };
  win.fetch = async (url, init = {}) => {
    const u = String(url).replace('http://127.0.0.1:3721', '');
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    state.reqs.push({ u, method, body });
    const reply = (b) => ({ ok: true, status: 200, json: async () => b });
    if (u === '/api/executions') return reply({ success: true, data: [{ id: '61', name: '真机拨测看板', projectId: '39', isFavorite: true }, { id: '180', name: '工作日志', isDefault: true }] });
    if (/\/api\/bugs\/\d+\/task-link$/.test(u)) return reply({ success: true, data: state.bugLink || { exists: true, toTask: '' } });
    if (/\/api\/bugs\/\d+\/to-task$/.test(u)) return reply(state.bugResult || { success: true, taskId: '900', linked: true, message: '任务已创建（#900）' });
    if (/\/api\/stories\/\d+\/tasks$/.test(u) && method === 'GET') return reply({ success: true, data: { tasks: state.existing || [], executionIds: state.linkedExecs || [] } });
    if (/\/api\/stories\/\d+\/tasks\/suggest$/.test(u)) return reply(state.suggest || { success: true, data: { aiUsed: false, reason: '还没有配置 AI', tasks: [{ name: '方案设计', type: 'design', estimate: '' }] } });
    if (/\/api\/stories\/\d+\/tasks$/.test(u) && method === 'POST') return reply({ success: true, data: state.splitResult(body) });
    return reply({ success: false, message: 'nf' });
  };
  win.eval(SRC + '\n;window.__TL = TaskLinkDialog;');
  return win;
}
const $ = (win, sel) => win.document.querySelector(sel);
const $$ = (win, sel) => [...win.document.querySelectorAll(sel)];

(async () => {
  try {
    // ---- Bug 转任务 ----
    let st = { bugLink: { exists: true, toTask: '', executionId: '180', executionIds: [] } }, win = setup(st);
    await win.__TL.openForBug({ zentaoId: '88', title: '登录超时', steps: '<p>步骤一</p><p>步骤二</p>', severity: 2, assignedTo: 'lijc' });
    await tick(20);
    check('Bug：标题带【Bug#编号】前缀', $(win, '[data-f="name"]').value === '【Bug#88】登录超时');
    check('Bug：严重程度 2 → 优先级 2', $(win, '[data-f="pri"]').value === '2');
    check('Bug：描述 = 去标签的步骤 + 来源编号', $(win, '[data-f="desc"]').value === '步骤一\n步骤二\n\n来源：Bug #88' || /步骤一\n步骤二/.test($(win, '[data-f="desc"]').value) && /来源：Bug #88/.test($(win, '[data-f="desc"]').value), JSON.stringify($(win, '[data-f="desc"]').value));
    check('Bug：默认执行取 Bug 自己所在的执行，指派默认自己', $(win, '[data-f="executionId"]').value === '180' && $(win, '[data-f="assignedTo"]').value === 'lijc');
    const subBtn = $(win, '[data-tl="submit"]');
    subBtn.click();
    check('Bug：提交过程中按钮置灰、文案变"创建中…"，再点不会重复提交', subBtn.disabled && subBtn.textContent === '创建中…' && (subBtn.click(), true));
    await tick(20);
    check('Bug：只发了一次创建请求', st.reqs.filter(r => r.method === 'POST').length === 1);
    const post = st.reqs.find(r => r.method === 'POST');
    check('Bug：POST /api/bugs/88/to-task，带执行 / 标题 / 类型 / 优先级', post && post.u === '/api/bugs/88/to-task' && post.body.executionId === '180' && post.body.name === '【Bug#88】登录超时' && post.body.type === 'devel' && post.body.pri === 2, JSON.stringify(post));
    check('Bug：成功后关闭弹窗、提示、刷新任务看板', win.__TL.el.hidden === true && st.toasts[0][0] === 'ok' && st.reloaded === 1);

    st = { bugLink: { exists: true, toTask: '777' } }; win = setup(st);
    await win.__TL.openForBug({ zentaoId: '89', title: '已转' }); await tick(20);
    check('Bug：已转过 → 显示已转任务号，没有提交按钮', /已经转成任务 #777/.test($(win, '[data-tl-body]').textContent) && !$(win, '[data-tl="submit"]'));

    st = { bugLink: { exists: true, toTask: '', executionId: '', executionIds: ['61'] } }; win = setup(st);
    await win.__TL.openForBug({ zentaoId: '91', title: '产品有关联执行' }); await tick(20);
    check('Bug：默认执行取 Bug 所属产品关联的执行(61)，不用全局默认(180)', $(win, '[data-f="executionId"]').value === '61');
    st = { bugLink: { exists: true, toTask: '', executionId: '180', executionIds: ['61'] } }; win = setup(st);
    await win.__TL.openForBug({ zentaoId: '92', title: 'Bug 自己所在执行' }); await tick(20);
    check('Bug：Bug 自己所在的执行优先', $(win, '[data-f="executionId"]').value === '180');
    st = { bugLink: { exists: true, toTask: '', executionId: '47', executionIds: ['61'] } }; win = setup(st);
    await win.__TL.openForBug({ zentaoId: '94', title: 'Bug 的执行不在本地列表' }); await tick(20);
    check('Bug：Bug 所在执行不在本地列表（如 47）→ 仍默认选它，并能在下拉里看到', $(win, '[data-f="executionId"]').value === '47' && /#47/.test($(win, '[data-f="executionId"]').selectedOptions[0].textContent));
    st = { bugLink: { exists: true, toTask: '', executionId: '', projectId: '39', executionIds: [] } }; win = setup(st);
    await win.__TL.openForBug({ zentaoId: '96', title: '没有执行但有项目' }); await tick(20);
    check('Bug：没有执行但有项目 → 默认选该项目下的执行(61)', $(win, '[data-f="executionId"]').value === '61');
    st = { bugLink: { exists: true, toTask: '', executionId: '', projectId: '999', executionIds: [] } };
    win = setup(st); win.fetch = win.fetch; await win.__TL.openForBug({ zentaoId: '95', title: '只有项目' }); await tick(20);
    check('Bug：没有执行也没有项目下的执行、产品也无候选 → 不退回全局默认，要用户自己选', $(win, '[data-f="executionId"]').value === '' && /请选择执行/.test($(win, '[data-f="executionId"]').selectedOptions[0].textContent));
    $(win, '[data-tl="submit"]').click(); await tick(20);
    check('Bug：没选执行就提交 → 提示请先选择执行，不发请求', /请先选择执行/.test($(win, '[data-tl-msg]').textContent) && !st.reqs.some(r => r.method === 'POST'));
    st = { bugLink: { exists: true, toTask: '', executionId: '', executionIds: ['61'] } }; win = setup(st);
    await win.__TL.openForBug({ zentaoId: '93', title: 'x' }); await tick(20);
    $(win, '[data-f="executionId"]').value = '180'; let asked2 = 0; win.Confirm = { show: async () => { asked2++; return false; } };
    $(win, '[data-tl="submit"]').click(); await tick(20);
    check('Bug：选了产品之外的执行 → 提交前确认，取消则不发请求', asked2 === 1 && !st.reqs.some(r => r.method === 'POST'));

    st = { bugLink: { exists: true, toTask: '', executionId: '180', executionIds: [] }, bugResult: { success: false, message: '该 Bug 已转为任务 #5', code: 'ALREADY_LINKED' } }; win = setup(st);
    await win.__TL.openForBug({ zentaoId: '90', title: 't' }); await tick(20);
    $(win, '[data-tl="submit"]').click(); await tick(20);
    check('Bug：后端拒绝时弹窗保持打开并显示原因', !win.__TL.el.hidden && /已转为任务 #5/.test($(win, '[data-tl-msg]').textContent));

    st = {}; win = setup(st);
    win.__TL.ensureDom(); win.TaskLinkDialog = win.__TL;
    await win.__TL.openForBug({ title: '没编号' });
    check('Bug：没有禅道编号 → 不开弹窗，提示先关联', win.__TL.el === null || win.__TL.el.hidden !== false);

    // ---- 需求拆任务 ----
    st = { existing: [{ id: '1', name: '已有任务', assignedTo: 'lijc', status: 'doing' }] };
    st.splitResult = (b) => ({ results: b.tasks.map(t => t.name === '联调与自测' ? { name: t.name, success: false, message: '『任务类型』不能为空', code: 'REJECTED' } : { name: t.name, success: true, taskId: '9' + t.name.length, linked: true, message: '任务已创建' }), created: b.tasks.length - 1, failed: 1 });
    win = setup(st);
    await win.__TL.openForStory({ id: '120', title: 'waitTextList' }); await tick(20);
    check('需求：默认 4 行模板，合计显示', $$(win, '.tl-grid-row').length === 4 && /4 个任务/.test($(win, '[data-tl-foot]').textContent));
    check('需求：顶部显示已有任务', /已有 1 个任务/.test($(win, '.tl-existing').textContent) && /已有任务/.test($(win, '.tl-existing').textContent));
    $$(win, '[data-r="estimate"]')[0].value = '3'; $$(win, '[data-r="estimate"]')[1].value = '5';
    $(win, '[data-tl="add-row"]').click();
    check('需求：加一行后输入不丢失，行数 5', $$(win, '.tl-grid-row').length === 5 && $$(win, '[data-r="estimate"]')[1].value === '5');
    $$(win, '[data-r="name"]')[4].value = '方案设计';
    $(win, '[data-tl="submit"]').click(); await tick(20);
    check('需求：重名在前端拦住，不发请求', /标题完全相同/.test($(win, '[data-tl-msg]').textContent) && !st.reqs.some(r => r.method === 'POST'));
    $$(win, '[data-tl="del-row"]')[4].click();
    check('需求：删除行', $$(win, '.tl-grid-row').length === 4);
    $$(win, '[data-r="name"]')[1].value = '';
    $(win, '[data-tl="submit"]').click(); await tick(20);
    check('需求：标题为空拦在前端', /没填标题/.test($(win, '[data-tl-msg]').textContent) && !st.reqs.some(r => r.method === 'POST'));
    $$(win, '[data-r="name"]')[1].value = '开发实现';
    $(win, '[data-tl="submit"]').click(); await tick(20);
    const sp = st.reqs.find(r => r.method === 'POST');
    check('需求：POST /api/stories/120/tasks，带执行与每行字段', sp && sp.u === '/api/stories/120/tasks' && sp.body.executionId === '180' && sp.body.tasks.length === 4 && sp.body.tasks[0].estimate === '3' && sp.body.tasks[0].type === 'design', JSON.stringify(sp && sp.body.tasks[0]));
    check('需求：部分失败 → 成功的行拿掉、失败的留下并标原因', $$(win, '.tl-grid-row').length === 1 && $$(win, '[data-r="name"]')[0].value === '联调与自测' && /不能为空/.test($(win, '.tl-row-err').textContent));
    check('需求：结果区列出 3 成功 1 失败 + 警告提示', $$(win, '.tl-results .is-ok').length === 3 && $$(win, '.tl-results .is-fail').length === 1 && st.toasts.some(t => t[0] === 'warn'));
    check('需求：创建后刷新任务看板', st.reloaded === 1);
    check('需求：按钮文案随剩余行数变化', /创建 1 个任务/.test($(win, '[data-tl="submit"]').textContent));

    // ---- AI 拆分建议 / 关联提示 ----
    st = { linkedExecs: ['61'] };
    st.suggest = { success: true, data: { aiUsed: true, tasks: [{ name: '设计匹配规则', type: 'design', estimate: 2 }, { name: '实现正则匹配', type: 'devel', estimate: 6 }] } };
    st.splitResult = () => ({ results: [], created: 0, failed: 0 });
    win = setup(st);
    await win.__TL.openForStory({ id: '120', title: 't' }); await tick(20);
    check('关联提示：需求所属产品关联了执行(61) → 默认就选它，没有黄色提醒', !$(win, '.tl-warn') && $(win, '[data-f="executionId"]').value === '61' && /需求所属产品关联的执行/.test($(win, '[data-tl-body]').textContent));
    check('关联提示：关联的执行排在下拉最前并带标记', $(win, '[data-f="executionId"]').options[0].value === '61' && /需求所属产品/.test($(win, '[data-f="executionId"]').options[0].textContent));
    const exSel = $(win, '[data-f="executionId"]'); exSel.value = '180'; exSel.dispatchEvent(new win.Event('change', { bubbles: true })); await tick(10);
    check('关联提示：换到无关的执行(180) → 出现黄色提醒', !!$(win, '.tl-warn') && /不属于这个需求所在的产品/.test($(win, '.tl-warn').textContent));
    let asked = 0; win.Confirm = { show: async () => { asked++; return false; } };
    $(win, '[data-tl="submit"]').click(); await tick(20);
    check('关联提示：选了无关的执行提交 → 先确认，取消则不发请求', asked === 1 && !st.reqs.some(r => r.method === 'POST'));
    const exSel2 = $(win, '[data-f="executionId"]'); exSel2.value = '61'; exSel2.dispatchEvent(new win.Event('change', { bubbles: true })); await tick(10);
    check('关联提示：换回(61) → 提醒消失', !$(win, '.tl-warn') && $(win, '[data-f="executionId"]').value === '61');
    $(win, '[data-tl="suggest"]').click(); await tick(30);
    check('AI 建议：任务行被替换为 AI 给的 2 行（含类型 / 工时），执行选择保留', $$(win, '.tl-grid-row').length === 2 && $$(win, '[data-r="name"]')[1].value === '实现正则匹配' && $$(win, '[data-r="estimate"]')[1].value === '6' && $$(win, '[data-r="type"]')[0].value === 'design' && $(win, '[data-f="executionId"]').value === '61');
    check('AI 建议：请求了 /suggest，提示"AI 给出 2 个任务"', st.reqs.some(r => r.u === '/api/stories/120/tasks/suggest' && r.method === 'POST') && /AI 给出 2 个任务/.test($(win, '[data-tl-ai-msg]').textContent));
    st.suggest = { success: true, data: { aiUsed: false, reason: '还没有配置 AI，先用通用模板', tasks: [{ name: '方案设计', type: 'design', estimate: '' }, { name: '开发实现', type: 'devel', estimate: '' }] } };
    $$(win, '[data-r="name"]')[0].value = '我自己写的任务';
    win.Confirm = { show: async () => false };
    $(win, '[data-tl="suggest"]').click(); await tick(30);
    check('AI 建议：表格里有手写任务时先确认，选取消则保持不变', $$(win, '[data-r="name"]')[0].value === '我自己写的任务');
    win.Confirm = { show: async () => true };
    $(win, '[data-tl="suggest"]').click(); await tick(30);
    check('没配 AI：确认替换后得到模板，并显示原因（不报错）', $$(win, '[data-r="name"]')[0].value === '方案设计' && /还没有配置 AI/.test($(win, '[data-tl-ai-msg]').textContent));
    st.suggest = { success: false, message: '服务异常' };
    $(win, '[data-tl="suggest"]').click(); await tick(30);
    check('建议接口失败：给出提示，表格保持原样，可继续手填', /获取建议失败/.test($(win, '[data-tl-ai-msg]').textContent) && $$(win, '.tl-grid-row').length === 2);
  } catch (e) {
    check(`异常：${e.stack}`, false);
  }
  for (const x of results) console.log(`  ${x.pass ? '✓' : '✗'} ${x.name}${x.pass || !x.extra ? '' : `   → ${x.extra}`}`);
  const passed = results.filter(x => x.pass).length;
  console.log(`\n拆任务 / 转任务界面：${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
})();
