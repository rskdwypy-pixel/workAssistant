/**
 * 真函数测试：updateTaskPriority 的回滚行为。
 *
 * 同样直接从newtab.js 抽取源码执行，测的是浏览器里跑的那份代码。
 * 运行：
 *   NODE_PATH=/Users/qiance/.workbuddy/binaries/node/workspace/node_modules \
 *   node scripts/test-priority-real.cjs
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const EXT = path.join(__dirname, '..', 'extension');
const newtabSrc = fs.readFileSync(path.join(EXT, 'newtab.js'), 'utf8');

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });

/**
 * 轮询等待条件成立。
 *
 * 不用固定 sleep 次数：不同 jsdom 版本的 microtask / Promise 调度时序不同，
 * 写死「等 N 拍」会在某些版本上过早判定。这里等待真正的条件本身。
 */
const waitFor = async (predicate, timeoutMs = 2000) => {
  const step = 10;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, step));
  }
  return predicate();
};

function extractFunction(name) {
  const start = newtabSrc.indexOf(`async function ${name}(`);
  if (start < 0) throw new Error(`源码里找不到 async function ${name}`);
  let depth = 0;
  for (let j = newtabSrc.indexOf('{', start); j < newtabSrc.length; j++) {
    if (newtabSrc[j] === '{') depth++;
    else if (newtabSrc[j] === '}') { depth--; if (depth === 0) return newtabSrc.slice(start, j + 1); }
  }
  throw new Error(`函数 ${name} 大括号没配平`);
}

function makeWindow() {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body></body></html>`,
    { url: 'http://localhost/', runScripts: 'outside-only' }
  );
  const win = dom.window;
  win.eval(fs.readFileSync(path.join(EXT, 'optimistic.js'), 'utf8'));
  return win;
}

function install(win, { backend = 'ok', tasks, putCalls = [] }) {
  win.API_BASE_URL = 'http://127.0.0.1:3721';
  win.allTasks = tasks;
  win.__events = { toasts: [], renders: 0, zentaoEdits: 0 };
  win.Toast = {
    success: m => win.__events.toasts.push({ type: 'success', m }),
    error: m => win.__events.toasts.push({ type: 'error', m }),
    warning: m => win.__events.toasts.push({ type: 'warning', m })
  };
  win.renderTasks = () => { win.__events.renders++; };

  // ⚠️ 必须走 OptimisticUI.register()，不能写 win.allTasks = [...]
  //   后者会挂到 window 上、绕过「let/const 不挂 window」这个真实 bug。
  win.OptimisticUI.register({
    allTasks: () => (win.allTasks || []),
    Toast: win.Toast,
    renderTasks: win.renderTasks
  });
  win.ZentaoBrowserClient = {
    editTask: async () => { win.__events.zentaoEdits++; return { success: true }; }
  };
  win.fetch = async (url, init = {}) => {
    if (/\/api\/task\/[^/?]+$/.test(url) && (init.method || 'GET') === 'PUT') {
      putCalls.push({ url, body: init.body });
      if (backend === 'throw') throw new TypeError('Failed to fetch');
      if (backend === 'fail') return { ok: false, json: async () => ({ success: false, error: '拒绝' }) };
      return { ok: true, json: async () => ({ success: true, data: {} }) };
    }
    return { ok: true, json: async () => ({ success: true, data: {} }) };
  };
  win.eval([extractFunction('updateTaskPriority'), 'this.updateTaskPriority = updateTaskPriority;'].join('\n'));
  return win;
}

const mkTask = (o = {}) => ({
  id: 't1', title: '任务一', status: 'todo', progress: 0, priority: 3,
  totalConsumedTime: 0, zentaoId: null, zentaoExecution: null, ...o
});

async function main() {
  // 正常路径
  {
    const putCalls = [];
    const win = makeWindow();
    const tasks = [mkTask()];
    install(win, { backend: 'ok', tasks, putCalls });
    await win.updateTaskPriority('t1', 1);
    check('正常路径优先级已更新', tasks[0].priority === 1, `${tasks[0].priority}`);
    check('正常路径发出请求', putCalls.length === 1, `${putCalls.length}`);
    check('正常路径不弹失败 Toast',
      !win.__events.toasts.some(t => t.type === 'error'), JSON.stringify(win.__events.toasts));
  }

  // 后端拒绝 → 回滚，且**不应**推送禅道
  {
    const win = makeWindow();
    const tasks = [mkTask({ zentaoId: 945, zentaoExecution: '174' })];
    install(win, { backend: 'fail', tasks });
    await win.updateTaskPriority('t1', 1);
    check('后端拒绝时优先级回滚', tasks[0].priority === 3, `${tasks[0].priority}`);
    check('后端拒绝时不推送禅道', win.__events.zentaoEdits === 0, `推了 ${win.__events.zentaoEdits} 次`);
  }

  // fetch 抛异常 → 回滚
  {
    const win = makeWindow();
    const tasks = [mkTask({ priority: 2 })];
    install(win, { backend: 'throw', tasks });
    await win.updateTaskPriority('t1', 4);
    check('网络异常时优先级回滚', tasks[0].priority === 2, `${tasks[0].priority}`);
    check('网络异常弹失败 Toast',
      win.__events.toasts.some(t => t.type === 'error' && t.m === '更新优先级失败'),
      JSON.stringify(win.__events.toasts));
  }

  // 成功 + 有禅道 → 才推送禅道
  {
    const win = makeWindow();
    const tasks = [mkTask({ zentaoId: 945, zentaoExecution: '174' })];
    install(win, { backend: 'ok', tasks });
    await win.updateTaskPriority('t1', 1);
    // trackSync 内部用 inflight Promise 串行化。若调用时队列还是空的，
    // waitAll 会立刻返回，此时同步可能尚未登记 —— 表现为「推了 0 次」。
    // 这在不同 jsdom 版本下 microtask 调度时序不同，所以这里轮询等待，
    // 断言真正的条件（推送发生），而不是依赖固定的等待次数。
    await waitFor(() => win.__events.zentaoEdits > 0, 2000);
    await win.OptimisticUI.waitAll('t1');
    check('成功后推送禅道', win.__events.zentaoEdits === 1, `推了 ${win.__events.zentaoEdits} 次`);
  }

  // 任务不存在
  {
    const win = makeWindow();
    install(win, { backend: 'ok', tasks: [] });
    await win.updateTaskPriority('nope', 1);
    check('任务不报错且不改UI',
      win.__events.toasts.some(t => t.type === 'error'), JSON.stringify(win.__events.toasts));
  }

  const pass = results.filter(r => r.pass).length;
  console.log('');
  results.forEach(r => console.log(`${r.pass ? '  ✓' : '  ✗'} ${r.name}${r.pass ? '' : '   → ' + r.extra}`));
  console.log(`\n${pass}/${results.length} 通过\n`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch(e => { console.error('测试自身崩溃：', e); process.exit(1); });