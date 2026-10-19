/**
 * 真函数测试：用 jsdom 构造真实 DOM 环境，把 newtab.js 里的
 * updateTaskProgress / syncProgressToZentao **原样抽取出来**执行。
 *
 * 与 test-rollback.cjs / test-optimistic.cjs 的区别：
 * 那两个脚本把逻辑「重新实现」了一遍，所以即使线上函数有 bug 它们也会全绿。
 * 本脚本直接 eval 源码，测的就是浏览器里跑的那份代码。
 *
 * 运行：
 *   NODE_PATH=/Users/qiance/.workbuddy/binaries/node/workspace/node_modules \
 *   node scripts/test-progress-real.cjs
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const EXT = path.join(__dirname, '..', 'extension');
const newtabSrc = fs.readFileSync(path.join(EXT, 'newtab.js'), 'utf8');

const results = [];
function check(name, pass, extra = '') {
  results.push({ name, pass: !!pass, extra });
}

/**
 * 从源码里按大括号配平抽出一个顶层函数的完整定义文本。
 * （用行号硬编码容易随改动失效，抽不出来时宁可报错也不要静默跳过）
 */
function extractFunction(name) {
  const start = newtabSrc.indexOf(`async function ${name}(`);
  if (start < 0) throw new Error(`源码里找不到 async function ${name}`);
  let i = newtabSrc.indexOf('{', start);
  let depth = 0;
  for (let j = i; j < newtabSrc.length; j++) {
    const ch = newtabSrc[j];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return newtabSrc.slice(start, j + 1);
    }
  }
  throw new Error(`函数 ${name} 的大括号没配平`);
}

/** 建一个装了真 optimistic.js 的 jsdom window */
function makeWindow() {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body>
      <div id="todoList"></div><div id="inProgressList"></div><div id="doneList"></div>
      <div id="todoColumnCount"></div><div id="inProgressColumnCount"></div><div id="doneColumnCount"></div>
      <div id="progressInputDialog"></div><div id="progressInputTitle"></div><div id="progressInputMessage"></div>
      <input id="progressInputWork"><input id="progressInputConsumed">
      <button id="progressInputCancel"></button><button id="progressInputOk"></button>
    </body></html>`,
    // runScripts:'outside-only' 才会把 window 暴露为脚本里的全局变量
    { url: 'http://localhost/', pretendToBeVisual: true, runScripts: 'outside-only' }
  );
  const win = dom.window;
  // optimistic.js 是 (function(global){...})(window)，直接跑真的那份
  win.eval(fs.readFileSync(path.join(EXT, 'optimistic.js'), 'utf8'));
  return win;
}

/**
 * 在给定 window 里装好 updateTaskProgress 所需的全部依赖。
 * @param {object} opts
 *   opts.backend        'ok' | 'fail' | 'throw'  —— 控制 PUT 进度接口行为
 *   opts.dialogResult   弹窗返回值（null 表示用户取消）
 *   opts.putCalls       记录 PUT 调用
 */
function install(win, opts) {
  const { backend = 'ok', dialogResult = { work: 'w', consumed: 1 }, putCalls = [] } = opts;

  win.__events = { toasts: [], renders: 0, statsCalls: 0, workHoursPosts: 0, synced: [] };

  win.API_BASE_URL = 'http://127.0.0.1:3721';

  win.allTasks = opts.tasks || [];

  // 弹窗：可控返回值
  win.ProgressInputDialog = {
    show: async () => {
      win.__events.dialogShown = true;
      return dialogResult;
    }
  };

  // Toast：记录，便于断言「到底弹了什么」
  win.Toast = {
    success: (m) => win.__events.toasts.push({ type: 'success', m }),
    error: (m) => win.__events.toasts.push({ type: 'error', m }),
    warning: (m) => win.__events.toasts.push({ type: 'warning', m })
  };

  // 统计刷新：真函数会调它，测试里只需要计数
  win.updateTaskStats = async () => { win.__events.statsCalls++; };

  // 今日工时：真实现会 POST /api/workHours
  win.updateTodayWorkTime = async () => { win.__events.workHoursPosts++; };
  win.recordTaskWorkTime = () => {};

  // 禅道同步：用假的，但保留可观测
  win.ZentaoBrowserClient = {
    updateTaskStatus: async () => ({ success: true }),
    recordEffort: async () => ({ success: true })
  };
  win.ExecutionFavorites = { getExecutionType: () => 'devel' };

  // fetch：只关心进度 PUT，其余放行
  win.fetch = async (url, init = {}) => {
    if (/\/api\/task\/[^/]+\/progress$/.test(url) && (init.method || 'GET') === 'PUT') {
      putCalls.push({ url, body: init.body });
      if (backend === 'throw') throw new TypeError('Failed to fetch');
      if (backend === 'fail') {
        return { ok: false, json: async () => ({ success: false, error: '模拟后端拒绝' }) };
      }
      return { ok: true, json: async () => ({ success: true, data: {} }) };
    }
    return { ok: true, json: async () => ({ success: true, data: {} }) };
  };

  // renderTasks 计数（乐观渲染必须真的发生了）
  win.renderTasks = () => { win.__events.renders++; };

  // ⚠️ 必须走 OptimisticUI.register()，不能写 win.allTasks = [...]
  //   后者会挂到 window 上、绕过「let/const 不挂 window」这个真实 bug，
  //   导致测试全绿却线上崩溃（2026-10-14 踩过）。
  win.OptimisticUI.register({
    allTasks: () => (win.allTasks || []),
    Toast: win.Toast,
    renderTasks: win.renderTasks
  });

  // 注入被抽出来的真函数。
  // 注意 eval 作用域里拿不到宿主的 win，要用 this（即 jsdom 的 window）。
  const code = [
    extractFunction('updateTaskProgress'),
    extractFunction('syncProgressToZentao'),
    'this.updateTaskProgress = updateTaskProgress;',
    'this.syncProgressToZentao = syncProgressToZentao;'
  ].join('\n');
  win.eval(code);

  return win;
}

// package.json 里有 "type": "module"，.cjs 不允许顶层 await，整体包一层
async function main() {
const mkTask = (over = {}) => ({
  id: 't1', title: '任务一', status: 'todo', progress: 0, priority: 3,
  totalConsumedTime: 0, zentaoId: null, executionId: null, executionType: null,
  ...over
});

// ============ 用例 1：正常路径 ============
{
  const putCalls = [];
  const win = makeWindow();
  const tasks = [mkTask()];
  install(win, { backend: 'ok', tasks, putCalls });
  const ret = await win.updateTaskProgress('t1', 60);

  check('正常路径返回 true', ret === true, `实际 ${ret}`);
  check('PUT 请求确实发出去了', putCalls.length === 1, `发出 ${putCalls.length} 次`);
  check('乐观渲染先于请求发生', win.__events.renders >= 1, `renders=${win.__events.renders}`);
  check('UI 立即反映新进度', tasks[0].progress === 60, `progress=${tasks[0].progress}`);
  check('状态由进度推导为 in_progress', tasks[0].status === 'in_progress', tasks[0].status);
  check('累计工时累加', tasks[0].totalConsumedTime === 1, `${tasks[0].totalConsumedTime}`);
  check('PUT 体含进度/工时/备注', (() => {
    if (!putCalls[0]) return false;
    const b = JSON.parse(putCalls[0].body);
    return b.progress === 60 && b.consumedTime === 1 && b.progressComment === 'w';
  })());
  check('成功路径不弹失败 Toast',
    !win.__events.toasts.some(t => t.type === 'error'),
    JSON.stringify(win.__events.toasts));
}

// ============ 用例 2：后端返回失败 → 必须回滚 ============
{
  const win = makeWindow();
  const tasks = [mkTask({ progress: 20, status: 'in_progress', totalConsumedTime: 4 })];
  install(win, { backend: 'fail', tasks, dialogResult: { work: 'x', consumed: 2 } });
  const ret = await win.updateTaskProgress('t1', 80);

  check('后端失败返回 false', ret === false, `实际 ${ret}`);
  check('后端失败时 UI 回滚到原进度', tasks[0].progress === 20, `progress=${tasks[0].progress}`);
  check('后端失败时状态回滚', tasks[0].status === 'in_progress', tasks[0].status);
  check('后端失败时累计工时回滚', tasks[0].totalConsumedTime === 4, `${tasks[0].totalConsumedTime}`);
  check('后端失败弹「更新进度失败」',
    win.__events.toasts.some(t => t.type === 'error' && t.m === '更新进度失败'),
    JSON.stringify(win.__events.toasts));
  check('后端失败不应记工时（账目不错乱）',
    win.__events.workHoursPosts === 0, `记了 ${win.__events.workHoursPosts} 次`);
}

// ============ 用例 3：网络异常（fetch throw）→ 同样回滚 ============
{
  const win = makeWindow();
  const tasks = [mkTask({ progress: 30, status: 'in_progress', totalConsumedTime: 5 })];
  install(win, { backend: 'throw', tasks, dialogResult: { work: 'x', consumed: 3 } });
  const ret = await win.updateTaskProgress('t1', 90);

  check('网络异常返回 false', ret === false, `实际 ${ret}`);
  check('网络异常时 UI 回滚', tasks[0].progress === 30, `progress=${tasks[0].progress}`);
  check('网络异常时工时回滚', tasks[0].totalConsumedTime === 5, `${tasks[0].totalConsumedTime}`);
  check('网络异常弹「更新进度失败」',
    win.__events.toasts.some(t => t.type === 'error' && t.m === '更新进度失败'),
    JSON.stringify(win.__events.toasts));
  check('网络异常不记工时',
    win.__events.workHoursPosts === 0, `记了 ${win.__events.workHoursPosts} 次`);
}

// ============ 用例 3b：后端返回的不是合法 JSON ============
{
  const putCalls = [];
  const win = makeWindow();
  const tasks = [mkTask({ progress: 50, status: 'in_progress', totalConsumedTime: 2 })];
  install(win, { backend: 'ok', tasks, putCalls, dialogResult: { work: 'x', consumed: 1 } });
  // 让 json() 抛异常，模拟网关返回 HTML 错误页
  win.fetch = async () => ({ ok: false, json: async () => { throw new SyntaxError('Unexpected token < in JSON'); } });

  const ret = await win.updateTaskProgress('t1', 85);
  check('响应非法 JSON 返回 false', ret === false, `实际 ${ret}`);
  check('响应非法 JSON 时 UI 回滚', tasks[0].progress === 50, `progress=${tasks[0].progress}`);
  check('响应非法 JSON 时工时回滚', tasks[0].totalConsumedTime === 2, `${tasks[0].totalConsumedTime}`);
}

// ============ 用例 4：用户取消弹窗 ============
{
  const putCalls = [];
  const win = makeWindow();
  const tasks = [mkTask({ progress: 10, status: 'in_progress' })];
  install(win, { backend: 'ok', tasks, dialogResult: null, putCalls });
  const ret = await win.updateTaskProgress('t1', 70);

  check('取消返回 false', ret === false, `实际 ${ret}`);
  check('取消不发请求', putCalls.length === 0, `发出 ${putCalls.length} 次`);
  check('取消不改 UI', tasks[0].progress === 10, `progress=${tasks[0].progress}`);
  check('取消不记工时', tasks[0].totalConsumedTime === 0, `${tasks[0].totalConsumedTime}`);
}

// ============ 用例 5：进度到 100 → done ============
{
  const putCalls = [];
  const win = makeWindow();
  const tasks = [mkTask({ progress: 40, status: 'in_progress' })];
  install(win, { backend: 'ok', tasks, putCalls });
  await win.updateTaskProgress('t1', 100);
  check('100% 映射为 done', tasks[0].status === 'done', tasks[0].status);
}

// ============ 用例 6：进度到 0 → todo ============
{
  const putCalls = [];
  const win = makeWindow();
  const tasks = [mkTask({ progress: 70, status: 'in_progress' })];
  install(win, { backend: 'ok', tasks, putCalls });
  await win.updateTaskProgress('t1', 0);
  check('0% 映射为 todo', tasks[0].status === 'todo', tasks[0].status);
}

// ============ 用例 7：任务不存在 ============
{
  const win = makeWindow();
  install(win, { backend: 'ok', tasks: [] });
  const ret = await win.updateTaskProgress('不存在', 50);
  check('任务不存在返回 false', ret === false, `实际 ${ret}`);
}

// ============ 汇总 ============
const pass = results.filter(r => r.pass).length;
console.log('');
results.forEach(r => {
  console.log(`${r.pass ? '  ✓' : '  ✗'} ${r.name}${r.pass ? '' : '   → ' + r.extra}`);
});
console.log(`\n${pass}/${results.length} 通过\n`);
process.exit(pass === results.length ? 0 : 1);
}

main().catch(err => {
  console.error('测试自身崩溃：', err);
  process.exit(1);
});