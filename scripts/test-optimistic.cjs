/**
 * optimistic.js 状态机的无浏览器自测
 * 用最小 DOM 替身验证：同步中→成功/失败、串行化、状态保留
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'extension', 'optimistic.js'), 'utf8');

// ---- 最小 DOM 替身 ----
// 真实页面里卡片节点由 renderTasks 每次重建（新节点），所以用独立
// nodes map 存节点，而不是挂在 task 对象上——否则整表替换后节点会丢。
const nodes = new Map();
function makeNode() {
  return {
    children: [],
    appendChild(c) { this.children.push(c); c._parent = this; },
    // 与浏览器一致：class 选择器按 class 列表包含匹配
    querySelectorAll(sel) {
      if (sel.startsWith('.')) {
        const cls = sel.slice(1);
        return this.children.filter(c => String(c.className).split(' ').includes(cls));
      }
      return [];
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    removeChild(c) { this.children = this.children.filter(x => x !== c); },
    remove() { const p = this._parent; if (p && p.removeChild) p.removeChild(this); }
  };
}
const toasts = [];
const sandbox = {
  console,
  CSS: { escape: (s) => String(s).replace(/["\\]/g, '\\$&') },
  document: {
    createElement() {
      const n = makeNode();
      n.className = ''; n.textContent = ''; n.title = '';
      return n;
    },
    querySelector(sel) {
      const m = /data-task-id="([^"]+)"/.exec(sel);
      if (!m) return null;
      if (!nodes.has(m[1])) nodes.set(m[1], makeNode());
      return nodes.get(m[1]);
    }
  },
  Toast: {
    success: (m) => toasts.push({ type: 'success', m }),
    error: (m) => toasts.push({ type: 'error', m })
  },
  setTimeout, clearTimeout
};
sandbox.window = sandbox;
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox);

const O = sandbox.OptimisticUI;
let renderCount = 0;
sandbox.renderTasks = () => { renderCount++; };
sandbox.allTasks = [{ id: 't1', title: '任务一' }];

// 注册依赖（2026-10-14 起 optimistic.js 不再直接读 window.allTasks）。
// 传函数而非数组：allTasks 会被整体替换（见下方 map 那行），存引用会过期。
O.register({
  allTasks: () => sandbox.allTasks,
  Toast: sandbox.Toast,
  renderTasks: () => sandbox.renderTasks()
});

function badgeOf(id) {
  const node = nodes.get(String(id));
  if (!node) return null;
  const all = node.querySelectorAll('.sync-state-badge');
  return all.length ? all[all.length - 1].textContent : null;
}

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, pass: !!cond, extra });
}

// ---- 1. 状态推导 ----
check('statusOf(0)=todo', O.statusOf(0) === 'todo');
check('statusOf(50)=in_progress', O.statusOf(50) === 'in_progress');
check('statusOf(100)=done', O.statusOf(100) === 'done');
check('statusOf(undefined)=todo', O.statusOf(undefined) === 'todo');

// ---- 2. 乐观插入 ----
const before = renderCount;
O.insertTask({ id: 't2', title: '任务二' });
check('insertTask 后 allTasks 有 t2', sandbox.allTasks.some(t => t.id === 't2'));
check('insertTask 触发重渲染', renderCount > before);
check('insertTask 不重复插入', (() => { O.insertTask({ id: 't2', title: '任务二2' }); return sandbox.allTasks.filter(t => t.id === 't2').length === 1; })());

// ---- 3. 同步成功 ----
(async () => {
  toasts.length = 0;
  let onSuccessRan = false;
  await O.trackSync({
    taskId: 't1',
    syncFn: async () => { await new Promise(r => setTimeout(r, 20)); return { success: true, taskId: 999 }; },
    onSuccess: async () => { onSuccessRan = true; },
    successMessage: () => '已同步 #999'
  });
  check('同步成功时 onSuccess 被调用', onSuccessRan);
  check('同步成功后 __sync 清除', !sandbox.allTasks.find(t => t.id === 't1').__sync);
  check('同步成功弹 success Toast', toasts.some(t => t.type === 'success' && t.m.includes('999')));
  check('同步成功不弹 error', !toasts.some(t => t.type === 'error'));

  // ---- 4. 同步失败 ----
  toasts.length = 0;
  await O.trackSync({
    taskId: 't2',
    syncFn: async () => ({ success: false, reason: 'not_configured' }),
    failureMessage: (r) => `失败：${O.explainFailure(r)}`
  });
  const t2 = sandbox.allTasks.find(t => t.id === 't2');
  check('同步失败保留 __sync.failed', t2.__sync && t2.__sync.state === 'failed');
  check('同步失败原因已记录', t2.__sync && t2.__sync.reason === 'not_configured');
  check('同步失败弹 error Toast', toasts.some(t => t.type === 'error'));
  check('失败提示已翻译原因', toasts.some(t => t.m.includes('禅道未配置')));
  check('失败后角标渲染为「未同步」', badgeOf('t2') === '未同步');
  check('同步失败后不残留「同步中」角标', (() => {
    const n = nodes.get('t2');
    return n.querySelectorAll('.sync-state-badge').length === 1;
  })());

  // ---- 4b. 重渲染后角标状态仍在（真实页面切日期/刷新会整表替换）----
  // 模拟后端回包替换任务对象：__sync 若没被 carryOverSyncState 保住就会丢
  sandbox.allTasks = sandbox.allTasks.map(t => ({ ...t }));
  sandbox.renderTasks();
  nodes.clear();   // 卡片节点被重建，旧节点作废
  O.setCardSyncState('t2', 'failed', 'not_configured');
  check('重渲染后角标可恢复', badgeOf('t2') === '未同步');
  check('重渲染后 __sync 字段仍在', !!sandbox.allTasks.find(t => t.id === 't2').__sync);

  // ---- 5. 同步中角标 ----
  toasts.length = 0;
  let sawSyncingBadge = false;
  await O.trackSync({
    taskId: 't1',
    syncFn: async () => {
      // 同步期间检查角标状态
      await new Promise(r => setTimeout(r, 15));
      const st = sandbox.allTasks.find(t => t.id === 't1').__sync;
      sawSyncingBadge = st && st.state === 'syncing';
      return { success: true, taskId: 123 };
    },
    quiet: true
  });
  check('同步期间 __sync= syncing', sawSyncingBadge);

  // ---- 6. 同一任务串行化（防乱序）----
  const order = [];
  await Promise.all([
    O.trackSync({ taskId: 't1', quiet: true, syncFn: async () => { order.push('A-start'); await new Promise(r => setTimeout(r, 40)); order.push('A-end'); return { success: true }; } }),
    O.trackSync({ taskId: 't1', quiet: true, syncFn: async () => { order.push('B-start'); order.push('B-end'); return { success: true }; } })
  ]);
  check('同一任务同步串行不交错', order.join(',') === 'A-start,A-end,B-start,B-end', order.join(','));

  // ---- 7. 异常被兜住 ----
  toasts.length = 0;
  await O.trackSync({
    taskId: 't1',
    syncFn: async () => { throw new Error('网络炸了'); },
    failureMessage: (r) => `失败：${O.explainFailure(r)}`
  });
  check('syncFn 抛异常不会外泄', sandbox.allTasks.find(t => t.id === 't1').__sync.state === 'failed');
  check('异常原因写入 __sync', sandbox.allTasks.find(t => t.id === 't1').__sync.reason === '网络炸了');

  // ---- 8. quiet 模式不弹成功 Toast ----
  toasts.length = 0;
  await O.trackSync({ taskId: 't1', quiet: true, syncFn: async () => ({ success: true }) });
  check('quiet 模式不弹 Toast', toasts.length === 0);

  // ---- 9. explainFailure 覆盖 ----
  check('explain: invalid_execution_id', O.explainFailure({ reason: 'invalid_execution_id' }).includes('所属执行'));
  check('explain: no_cookie', O.explainFailure({ reason: 'no_cookie' }).includes('登录态'));
  check('explain: 兜底用 message', O.explainFailure({ message: '服务器 500' }) === '服务器 500');

  // ---- 输出 ----
  const pass = results.filter(r => r.pass).length;
  console.log('\n=========== optimistic.js 自测 ===========');
  for (const r of results) {
    console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${r.extra ? '  → ' + r.extra : ''}`);
  }
  console.log(`\n  ${pass}/${results.length} 通过`);
  if (pass !== results.length) process.exitCode = 1;
})();