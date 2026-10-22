/**
 * 真函数测试：新建任务弹窗「先打开、识别结果后到」的交互
 *
 * 用 jsdom 加载真实的 newtab.html，用 acorn 从 newtab.js 原样抽出相关函数执行，
 * 只把网络、Toast、指派人组件等外部依赖换成桩。
 *
 * 覆盖：
 *   - 回车后弹窗立即打开（不等识别），原文先填进标题，状态条显示识别中
 *   - 识别结果回来：只填用户没改过的字段；用户改过的标题不被覆盖
 *   - 关闭弹窗后才回来的识别结果被丢弃
 *   - 识别未完成时提交且执行为「自动」：等识别结果，提交体带 title / analysis / executionPickedByUser
 *   - 用户手动选执行：executionPickedByUser = true
 *   - 未配置 AI / 识别失败：状态条给出对应提示，弹窗仍可用
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

/** 按名字抽出顶层函数 / 变量声明的源码 */
function extract(names) {
  return names.map((name) => {
    const node = AST.body.find(n =>
      (n.type === 'FunctionDeclaration' && n.id.name === name) ||
      (n.type === 'VariableDeclaration' && n.declarations.some(d => d.id.name === name)));
    if (!node) throw new Error(`newtab.js 里找不到 ${name}`);
    return SRC.slice(node.start, node.end);
  }).join('\n');
}

const REAL = extract([
  'escapeHtml', 'resetListenerScope', 'taskAttachmentPicker', 'requestCloseTaskModal',
  'taskIntakeSession', 'TASK_INTAKE_FIELDS', 'TASK_PREVIEW_TIMEOUT_MS', 'TASK_SUBMIT_WAIT_MS',
  'setTaskAiStatus', 'fillUntouchedTaskField', 'toDueDateTimeLocal', 'describeTaskPreview', 'runTaskPreview',
  'addTask', 'openBlankTaskModal', 'showTaskModal', 'hideTaskModal', 'submitTaskFromModal', 'initTaskModal'
]);

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const ATTACHMENTS_SRC = fs.readFileSync(path.join(EXT, 'attachments.js'), 'utf8');

/**
 * 建一个装好真函数的 window
 * @returns {{win, ctl}} ctl.preview(result) / ctl.previewFail() 控制识别接口何时返回
 */
async function setup() {
  const dom = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  const ctl = {
    events: [],
    posts: [], previewCalls: 0, resolvePreview: null, rejectPreview: null,
    // 第一段（本地规则）默认结果：AI 可用、还有 AI 结果在路上
    localResult: {
      success: true, preview: true, source: 'local', aiAvailable: true, aiPending: true,
      analysis: { title: '本地标题', priority: 1, progress: 0, status: 'todo', dueDate: '2026-10-23', reminderTime: null, durationDays: 2 },
      suggestion: { executionId: '149', executionName: '阿迪达斯项目交付', matchedBy: 'rule', confidence: 0.9 },
      needConfirm: false, candidates: []
    }
  };
  win.__ctl = ctl;

  win.eval(`
    const API_BASE_URL = 'http://127.0.0.1:3721';
    const __ctl = window.__ctl;
    let allTasks = [];
    const Toast = { success(){}, error(m){ __ctl.lastError = m; }, warning(m){ __ctl.lastWarning = m; }, info(){} };
    const Confirm = { show: async (t, m) => { __ctl.confirms = (__ctl.confirms || 0) + 1; __ctl.confirmMessage = m; return !!__ctl.confirmAnswer; } };

    const ButtonStateManager = { setLoading(id, o){ __ctl.loadingText = o && o.loadingText; return () => { __ctl.loadingText = null; }; } };
    const ExecutionSelector = { getSelectedExecution: () => __ctl.selectorExecution || '' };
    const AiConfirmDialog = { show: async () => null };
    const getTaskSelectedUsers = () => [];
    const renderTasks = () => {};
    const clearTaskDraft = () => {};
    const saveTaskDraft = () => {};
    const loadTaskDraft = () => {};
    const loadCalendar = async () => {};
    const syncNewTaskToZentao = async (task) => { __ctl.events.push(['sync', task.id]); };
    const loadTasks = async () => { __ctl.events.push(['loadTasks']); };
    const initTaskUserSelects = async () => {};
    async function loadExecutionOptions() {
      const select = document.getElementById('taskExecution');
      select.innerHTML = '<option value="">自动选择 (AI分析)</option><option value="149">阿迪达斯项目交付</option><option value="167">工作日志</option>';
    }
    window.fetch = (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : {};
      if (body.preview && body.localOnly) {
        __ctl.localCalls = (__ctl.localCalls || 0) + 1;
        if (__ctl.localFail) return Promise.reject(new Error('Failed to fetch'));
        return Promise.resolve({ json: async () => __ctl.localResult });
      }
      if (body.preview) {
        __ctl.previewCalls++;
        return new Promise((resolve, reject) => {
          __ctl.resolvePreview = (r) => resolve({ json: async () => r });
          __ctl.rejectPreview = (e) => reject(e);
        });
      }
      __ctl.posts.push(body);
      return Promise.resolve({ json: async () => ({ success: true, data: { id: 'new', title: body.title } }) });
    };
    // jsdom 没有实现 Blob URL
    URL.createObjectURL = () => 'blob:test';
    URL.revokeObjectURL = () => {};
    ${ATTACHMENTS_SRC}
    // 附件上传接口换成桩，记录调用顺序
    AttachmentApi.uploadAll = async (recordId, items, opts) => { __ctl.events.push(['upload', recordId, items.map(i => i.name), opts]); return { uploaded: items, failed: [] }; };
    ${REAL}
    window.__api = { addTask, hideTaskModal, submitTaskFromModal, initTaskModal, requestCloseTaskModal, getSession: () => taskIntakeSession, getPicker: () => taskAttachmentPicker };
  `);
  await win.__api.initTaskModal();
  return { win, ctl, $: (id) => win.document.getElementById(id) };
}

const AI_RESULT = {
  success: true, preview: true, source: 'ai', aiAvailable: true,
  analysis: { title: 'AI 整理后的标题', priority: 1, progress: 0, status: 'todo', dueDate: '2026-10-23', reminderTime: '2026-10-22T07:00:00.000Z', durationDays: 2 },
  suggestion: { executionId: '149', executionName: '阿迪达斯项目交付', matchedBy: 'ai-unified', confidence: 0.9 },
  needConfirm: false, candidates: []
};

async function main() {
  // ============ 1. 弹窗立即打开 → 本地秒填 → AI 补充未改过的字段 ============
  {
    const { win, ctl, $ } = await setup();
    $('taskInput').value = '修复阿迪登录页，挺急的，预计2天';
    const opening = win.__api.addTask();
    await opening;
    check('回车后弹窗立即打开（不等 AI）', $('taskCreateModal').style.display === 'flex');
    check('输入框立即清空，可以继续输入', $('taskInput').value === '');
    check('状态条显示识别中', !$('taskAiStatus').hidden && $('taskAiStatus').className.includes('is-loading'));
    await tick(10);
    check('第一段：本地规则结果秒填（标题/优先级/截止/执行）',
      $('taskTitle').value === '本地标题' && $('taskPriority').value === '1' &&
      $('taskDueDate').value === '2026-10-23T18:00' && $('taskExecution').value === '149',
      [$('taskTitle').value, $('taskPriority').value, $('taskDueDate').value, $('taskExecution').value].join(' | '));
    check('第一段后 AI 仍在补充：状态条保持识别中', $('taskAiStatus').className.includes('is-loading') &&
      $('taskAiStatus').textContent.includes('AI 正在补充') && ctl.previewCalls === 1);

    // 两段之间用户改了优先级：AI 结果不能覆盖它，但可以替换程序填的标题
    $('taskPriority').value = '3';
    $('taskPriority').dispatchEvent(new win.Event('change', { bubbles: true }));
    ctl.resolvePreview({ ...AI_RESULT, analysis: { ...AI_RESULT.analysis, priority: 2 } });
    await tick(10);
    check('第二段：AI 替换程序填入的标题', $('taskTitle').value === 'AI 整理后的标题');
    check('第二段：用户在两段之间改过的优先级不被覆盖', $('taskPriority').value === '3');
    check('状态条提示 AI 已识别及执行名', $('taskAiStatus').className.includes('is-ok') && $('taskAiStatus').textContent.includes('阿迪达斯项目交付'));

    await win.__api.submitTaskFromModal();
    const body = ctl.posts[0] || {};
    check('提交体带表单标题与识别结果（保存时不再调模型）',
      body.title === 'AI 整理后的标题' && body.analysis && body.analysis.reminderTime === AI_RESULT.analysis.reminderTime, JSON.stringify(body).slice(0, 160));
    check('采纳识别建议：executionPickedByUser=false', body.executionPickedByUser === false && body.executionId === '149');
    check('提交后弹窗关闭、会话清空', $('taskCreateModal').style.display === 'none' && win.__api.getSession() === null);
  }

  // ============ 2. 用户先改标题，识别结果不覆盖 ============
  {
    const { win, ctl, $ } = await setup();
    $('taskInput').value = '修复阿迪登录页';
    await win.__api.addTask();
    $('taskTitle').value = '我自己改的标题';
    $('taskTitle').dispatchEvent(new win.Event('input', { bubbles: true }));
    await tick(10);
    ctl.resolvePreview(AI_RESULT);
    await tick(10);
    check('用户改过的标题：本地与 AI 结果都不覆盖', $('taskTitle').value === '我自己改的标题');
  }

  // ============ 3. 关闭弹窗后晚到的结果被丢弃 ============
  {
    const { win, ctl, $ } = await setup();
    ctl.localResult = { ...ctl.localResult, suggestion: null };
    $('taskInput').value = '整理周报';
    await win.__api.addTask();
    await tick(10);
    const before = [$('taskTitle').value, $('taskPriority').value, $('taskExecution').value].join('|');
    win.__api.hideTaskModal();
    ctl.resolvePreview(AI_RESULT);
    await tick(10);
    const after = [$('taskTitle').value, $('taskPriority').value, $('taskExecution').value].join('|');
    check('关闭后晚到的 AI 结果不回填', before === after, `${before} → ${after}`);
    check('关闭后不会落库', ctl.posts.length === 0);
  }

  // ============ 4. 本地没定出执行、AI 未返回时提交：等 AI ============
  {
    const { win, ctl, $ } = await setup();
    ctl.localResult = { ...ctl.localResult, suggestion: null };
    $('taskInput').value = '和那边对一下登录方案';
    await win.__api.addTask();
    await tick(10);
    const submitting = win.__api.submitTaskFromModal();
    await tick(10);
    check('执行为自动且 AI 未返回：按钮显示等待识别', ctl.loadingText === '等待识别…' && ctl.posts.length === 0, ctl.loadingText);
    ctl.resolvePreview(AI_RESULT);
    await submitting;
    check('AI 回来后用识别出的执行提交', ctl.posts[0] && ctl.posts[0].executionId === '149');
  }

  // ============ 5. 本地已定出执行：AI 未返回也不用等 ============
  {
    const { win, ctl, $ } = await setup();
    $('taskInput').value = '和阿迪对一下登录方案';
    await win.__api.addTask();
    await tick(10);
    await win.__api.submitTaskFromModal();
    check('本地已定出执行：不等 AI 直接提交', ctl.posts.length === 1 && ctl.posts[0].executionId === '149');
  }

  // ============ 6. 用户手动选执行：记为用户选择 ============
  {
    const { win, ctl, $ } = await setup();
    $('taskInput').value = '和阿迪对一下登录方案';
    await win.__api.addTask();
    await tick(10);
    $('taskExecution').value = '167';
    $('taskExecution').dispatchEvent(new win.Event('change', { bubbles: true }));
    ctl.resolvePreview(AI_RESULT);
    await tick(10);
    check('手动选的执行不被 AI 结果覆盖', $('taskExecution').value === '167');
    await win.__api.submitTaskFromModal();
    check('手动选了执行：executionPickedByUser=true', ctl.posts[0] && ctl.posts[0].executionPickedByUser === true && ctl.posts[0].executionId === '167');
  }

  // ============ 7. 未配置 AI：只有本地一段 ============
  {
    const { win, ctl, $ } = await setup();
    ctl.localResult = { ...ctl.localResult, aiAvailable: false, aiPending: false, suggestion: null, analysis: { ...ctl.localResult.analysis, title: '修复登录页' } };
    $('taskInput').value = '【紧急】修复登录页，预计2天';
    await win.__api.addTask();
    await tick(10);
    const st = $('taskAiStatus');
    check('未配置 AI：不再请求 AI 预览', ctl.previewCalls === 0);
    check('未配置 AI：状态条提示按本地规则识别', st.className.includes('is-fallback') && st.textContent.includes('AI 未配置'), st.textContent);
    check('未配置 AI：识别不到执行时提示将用默认执行', st.textContent.includes('默认执行'));
    check('未配置 AI：本地识别的字段照常填入', $('taskTitle').value === '修复登录页' && $('taskPriority').value === '1');
    await win.__api.submitTaskFromModal();
    check('未配置 AI：提交不等待', ctl.posts.length === 1 && ctl.loadingText !== '等待识别…');
  }

  // ============ 8. 识别请求失败 ============
  {
    const { win, ctl, $ } = await setup();
    ctl.localFail = true;
    $('taskInput').value = '随便记一笔';
    await win.__api.addTask();
    await tick(10);
    check('识别请求失败：状态条报错，弹窗仍可编辑',
      $('taskAiStatus').className.includes('is-error') && $('taskCreateModal').style.display === 'flex');
    await win.__api.submitTaskFromModal();
    check('识别失败后仍可提交（不等待、不带识别结果）', ctl.posts.length === 1 && ctl.posts[0].analysis === undefined);
  }

  // ============ 9. 附件：提交后先存附件、再同步禅道；关闭前确认 ============
  {
    const { win, ctl, $ } = await setup();
    $('taskInput').value = '修复登录页';
    await win.__api.addTask();
    await tick(10);
    const picker = win.__api.getPicker();
    check('新建任务弹窗有附件选择区', !!picker && !!$('taskAttachments').querySelector('.att-drop'));
    const png = new win.File([new Uint8Array([1, 2, 3])], '截图.png', { type: 'image/png' });
    const exe = new win.File([new Uint8Array([1])], 'a.exe', { type: 'application/octet-stream' });
    picker.add([png, exe]);
    check('不支持的类型被拦下并提示', picker.count === 1 && /类型不支持/.test(ctl.lastWarning || ''), ctl.lastWarning);
    check('选择区展示已添加的附件', $('taskAttachments').querySelectorAll('.att-item').length === 1);

    // 关闭前确认：选「继续编辑」不关闭
    ctl.confirmAnswer = false;
    await win.__api.requestCloseTaskModal();
    check('有附件时关闭先确认，选继续编辑则不关闭', ctl.confirms === 1 && $('taskCreateModal').style.display === 'flex' && picker.count === 1);

    ctl.resolvePreview(AI_RESULT);
    await tick(10);
    await win.__api.submitTaskFromModal();
    await tick(10);
    const up = ctl.events.find(e => e[0] === 'upload');
    const syncIdx = ctl.events.findIndex(e => e[0] === 'sync');
    check('提交后上传附件到新任务（截图插入正文）', up && up[1] === 'new' && up[2][0] === '截图.png' && up[3].inline === true, JSON.stringify(ctl.events));
    check('附件存好之后才开始同步禅道', syncIdx > ctl.events.indexOf(up), JSON.stringify(ctl.events));
    check('提交后选择区清空', picker.count === 0);
    const loadIdx = ctl.events.findIndex(e => e[0] === 'loadTasks');
    check('带附件：同步到禅道后刷新一次列表（角标进入「上传中」并由观察器跟进）', loadIdx > syncIdx, JSON.stringify(ctl.events));
  }
  {
    const { win, ctl, $ } = await setup();
    await win.__api.addTask(); // 空白弹窗
    ctl.confirmAnswer = true;
    await win.__api.requestCloseTaskModal();
    check('没有附件时直接关闭不打扰', !ctl.confirms && $('taskCreateModal').style.display === 'none');
  }

  for (const r of results) {
    console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${r.pass || !r.extra ? '' : `   → ${r.extra}`}`);
  }
  const passed = results.filter(r => r.pass).length;
  console.log(`\n${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
