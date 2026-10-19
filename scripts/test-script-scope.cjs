/**
 * 回归测试：跨脚本的 let/const 作用域陷阱
 *
 * 真实 bug（用户报的）：
 *   [Progress Drag] 更新进度失败: TypeError: Cannot read properties of undefined (reading 'find')
 *
 * 根因：optimistic.js 读 window.allTasks，但 newtab.js 里它是 `let allTasks = []`。
 * 全局脚本作用域中的 let/const 只是「脚本级绑定」，**不会**成为 window 的属性
 * （只有 var 和函数声明会）。于是 window.allTasks === undefined，
 * `global.allTasks.find()` 必炸。
 *
 * ⚠️ 为什么之前没测出来：
 *   旧的 test-progress-real.cjs 里写的是 `win.allTasks = [...]` —— 直接赋值到
 *   window 上，**恰好绕过了这个 bug**。本测试改成按浏览器真实方式加载：
 *   脚本里用 let/const 声明，全程不碰 window，忠实复现线上环境。
 *
 * ⚠️ jsdom 的 eval 限制（踩过一次）：
 *   每次 win.eval() 是**独立作用域**，`let x` 后续赋值会落进本次 eval 的局部变量，
 *   别的 eval 看不见。这是测试环境限制，不是浏览器行为 —— 真实浏览器里多个
 *   <script> 共享同一个全局词法环境。所以下面把「声明 + 注册 + 调用」放进
 *   **同一个** eval 里，才等价于真实浏览器。
 *
 * 运行：
 *   NODE_PATH=/Users/qiance/.workbuddy/binaries/node/workspace/node_modules \
 *   node scripts/test-script-scope.cjs
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const EXT = path.join(__dirname, '..', 'extension');
const optimisticSrc = fs.readFileSync(path.join(EXT, 'optimistic.js'), 'utf8');

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });

/**
 * 模拟浏览器：先加载真实 optimistic.js，再在同一作用域里模拟 newtab.js。
 * @param {string} body 业务代码片段，在注册完成后执行，可访问 out / allTasks / OptimisticUI
 * @returns {object} body 往 out 里塞的观测数据
 */
function run(body, { registerDeps = true } = {}) {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><body>
    <div id="todoList"></div><div id="inProgressList"></div><div id="doneList"></div>
    </body></html>`,
    { url: 'http://localhost/', runScripts: 'outside-only' }
  );
  const win = dom.window;
  win.eval(optimisticSrc);   // 真实文件，顺序与浏览器一致（optimistic.js 在前）

  return win.eval(`(() => {
    const out = { toasts: [], renders: 0, threw: null };

    // ==== 模拟 newtab.js：刻意用 let/const，且不往 window 挂任何东西 ====
    let allTasks = [];
    const Toast = {
      success(m){ out.toasts.push(['s', m]); },
      error(m){ out.toasts.push(['e', m]); },
      warning(m){ out.toasts.push(['w', m]); }
    };
    function renderTasks() { out.renders++; }
    // =========================================================

    ${registerDeps ? `
    // ==== 原样粘贴 newtab.js 里的注册代码 ====
    if (window.OptimisticUI) {
      window.OptimisticUI.register({
        allTasks: () => allTasks,
        Toast: Toast,
        renderTasks: () => renderTasks()
      });
    }
    // =========================================
    ` : ''}

    try {
      ${body}
    } catch (e) {
      out.threw = e && e.message;
    }
    return out;
  })()`);
}

function main() {
  // ---- 前置：确认 JS 语义本身 ----
  {
    const w = new JSDOM('<!DOCTYPE html><body></body>', { runScripts: 'outside-only' }).window;
    w.eval('let x = []; var y = []; function z(){}');
    check('let 声明不会挂到 window（这正是 bug 根因）',
      w.x === undefined && Array.isArray(w.y) && typeof w.z === 'function');
  }

  // ---- 未注册时优雅降级，绝不抛异常 ----
  {
    const out = run(`
      OptimisticUI.patchTask('t1', { progress: 50 });
      OptimisticUI.insertTask({ id: 't9', progress: 1 });
      OptimisticUI.setCardSyncState('t1', 'failed', 'x');
    `, { registerDeps: false });
    check('未注册依赖时优雅降级而不是抛异常', out.threw === null, out.threw || '');
  }

  // ---- 核心：patchTask 能真的改到 allTasks ----
  {
    const out = run(`
      allTasks = [{ id: 't1', title: 'A', progress: 0, status: 'todo' }];
      out.ret = OptimisticUI.patchTask('t1', { progress: 66 });
      out.after = allTasks[0].progress;
      out.len = allTasks.length;
    `);
    check('patchTask 不抛 reading find 异常', out.threw === null, out.threw || '');
    check('patchTask 能找到任务（返回非 null）', out.ret !== null && out.ret !== undefined,
      `${out.ret}`);
    check('patchTask 真的改到了 allTasks 里的对象', out.after === 66, `progress=${out.after}`);
    check('任务数组长度未被破坏', out.len === 1, `${out.len}`);
    check('patchTask 触发了重渲染', out.renders >= 1, `${out.renders}`);
  }

  // ---- allTasks 被整体重赋值后仍生效（getter 而非快照）----
  {
    const out = run(`
      allTasks = [{ id: 't2', progress: 0 }];
      OptimisticUI.patchTask('t2', { progress: 10 });
      allTasks = [{ id: 't3', progress: 0 }];   // 模拟 loadTasks 整体替换
      OptimisticUI.patchTask('t3', { progress: 30 });
      out.a = allTasks[0].progress;
    `);
    check('allTasks 整体替换后仍能改到（getter 而非快照）',
      out.a === 30 && out.threw === null, `progress=${out.a} ${out.threw || ''}`);
  }

  // ---- insertTask ----
  {
    const out = run(`
      allTasks = [{ id: 't1' }];
      OptimisticUI.insertTask({ id: 't3', progress: 10 });
      out.has = allTasks.some(t => t.id === 't3');
      out.len = allTasks.length;
    `);
    check('insertTask 能插入新任务', out.has === true && out.threw === null,
      `${out.has} ${out.threw || ''}`);
    check('insertTask 后长度正确', out.len === 2, `${out.len}`);
  }

  // ---- Toast 依赖 ----
  {
    const out = run(`
      OptimisticUI.trackSync({
        taskId: 't3', quiet: false, successMessage: '同步成功',
        syncFn: async () => ({ success: true })
      }).then(r => { out.syncRes = r; });
    `);
    // trackSync 是异步的，等它跑完
    return new Promise(resolve => setTimeout(resolve, 50)).then(() => {
      check('trackSync 成功路径不崩', out.threw === null, out.threw || '');
      check('Toast 依赖可用（能真的弹提示）',
        out.toasts.some(([type, m]) => type === 's' && m === '同步成功'),
        JSON.stringify(out.toasts));
      report();
    });
  }
}

function report() {
  const pass = results.filter(r => r.pass).length;
  console.log('');
  results.forEach(r => console.log(`${r.pass ? '  ✓' : '  ✗'} ${r.name}${r.pass ? '' : '   → ' + r.extra}`));
  console.log(`\n${pass}/${results.length} 通过\n`);
  process.exit(pass === results.length ? 0 : 1);
}

main();