/**
 * optimistic.js —— 禅道相关的乐观 UI 支持
 *
 * 背景：禅道操作（建任务、改状态、记工时）都要走浏览器端注入脚本或
 * Native Messaging，单次往返常常 1~3 秒，网络差时更久。旧实现是
 * 「等禅道返回 → 再改 UI」，导致点击进度条、提交表单之后界面像卡住一样，
 * 用户会以为没点上而重复点击。
 *
 * 这里提供三件事：
 *   1. OptimisticUI.insertTask / patchTask  —— 先把任务放进 UI 并立刻渲染
 *   2. OptimisticUI.setCardSyncState       —— 在卡片上打「同步中」角标
 *   3. OptimisticUI.trackSync              —— 把「后台同步 + 成功回填 / 失败留按钮」
 *      这套流程收敛成一个函数，各调用点只需描述同步动作与回填函数
 *
 * 设计原则：
 *   - 乐观更新只发生在**本地数据与本地 UI**，永远以「用户已表达意图」为准
 *   - 禅道失败不吞掉：卡片保留同步按钮 + 顶部提示，用户可一键重试
 *   - 同一任务的同步串行化，避免进度连点导致禅道请求乱序
 *
 * ⚠️ 依赖注入（重要，改动前先读）：
 *   本模块**不能**直接读 window.allTasks / window.Toast。
 *   newtab.js 里它们是 `let allTasks` / `const Toast = {...}` 声明的 ——
 *   全局脚本里的 let/const 只是「脚本级绑定」，**不会**成为 window 的属性
 *   （只有 var 和函数声明才会）。所以 window.allTasks === undefined，
 *   直接 `global.allTasks.find()` 必然抛
 *   「Cannot read properties of undefined (reading 'find')」。
 *
 *   正确做法：newtab.js 主动调用 OptimisticUI.register({ allTasks, Toast, renderTasks })
 *   把引用交进来。这里用 getter 读取，保证拿到的是**当前**值而非快照 ——
 *   allTasks 会被整体重新赋值（loadTasks 等），存引用会拿到过期数组。
 */

(function (global) {
  'use strict';

  /** 正在同步中的任务，taskId -> Promise，用于串行化同一任务的多次同步 */
  const inflight = new Map();

  /**
   * 由宿主（newtab.js）注入的依赖。
   * @type {{allTasks:()=>Array, Toast?:object, renderTasks?:Function}}
   */
  const deps = {
    allTasks: () => [],
    Toast: null,
    renderTasks: null
  };

  /**
   * 注册宿主依赖。必须在任何 OptimisticUI 方法被调用之前执行。
   * @param {object} d
   * @param {Function|Array} d.allTasks   返回当前任务数组的函数（不是数组本身）
   * @param {object} [d.Toast]            Toast 对象
   * @param {Function} [d.renderTasks]    重渲染函数
   */
  function register(d = {}) {
    if (typeof d.allTasks === 'function') deps.allTasks = d.allTasks;
    else if (Array.isArray(d.allTasks)) deps.allTasks = () => d.allTasks;
    if (d.Toast) deps.Toast = d.Toast;
    if (typeof d.renderTasks === 'function') deps.renderTasks = d.renderTasks;
  }

  /** 取当前任务数组，永远返回数组，避免调用方到处判空 */
  function tasks() {
    try {
      const list = deps.allTasks();
      return Array.isArray(list) ? list : [];
    } catch (e) {
      console.warn('[Optimistic] 读取任务列表失败:', e);
      return [];
    }
  }

  function toast() {
    return deps.Toast || { success() { }, error() { }, warning() { } };
  }

  /** 触发重渲染，未注册时静默跳过 */
  function rerender() {
    if (typeof deps.renderTasks === 'function') {
      try { deps.renderTasks(); }
      catch (e) { console.warn('[Optimistic] 重渲染失败:', e); }
    }
  }

  /**
   * 判断进度对应的任务状态（与后端 status 推导规则保持一致）
   * @param {number} progress
   * @returns {'todo'|'in_progress'|'done'}
   */
  function statusOf(progress) {
    const p = Number(progress) || 0;
    if (p >= 100) return 'done';
    if (p > 0) return 'in_progress';
    return 'todo';
  }

  /**
   * 把任务塞进 allTasks 并立刻重渲染（不重新请求后端）
   * @param {object} task 任务对象，需带 id
   */
  function insertTask(task) {
    if (!task || task.id === undefined) return;
    const list = tasks();
    const idx = list.findIndex(t => t.id === task.id);
    if (idx >= 0) list[idx] = task;
    else list.push(task);
    rerender();
  }

  /**
   * 就地修改 allTasks 中的任务并局部重渲染
   * @param {string|number} taskId
   * @param {object} patch 要覆盖的字段
   * @param {object} [options]
   * @param {boolean} [options.rerender=true] 是否整表重渲染
   */
  function patchTask(taskId, patch, options = {}) {
    const { rerender: shouldRerender = true } = options;
    const task = tasks().find(t => String(t.id) === String(taskId));
    if (!task) return null;
    Object.assign(task, patch);
    if (shouldRerender) rerender();
    return task;
  }

  /**
   * 更新卡片上的同步状态角标。
   *
   * 卡片由 renderTasks 重建，所以这里不能只依赖节点存活 ——
   * 一旦被重建，角标会丢。因此同时把状态记在 task.__sync 字段上，
   * 由 createTaskCard 在渲染时读取。
   *
   * @param {string|number} taskId
   * @param {'idle'|'syncing'|'failed'} state
   * @param {string} [reason] 失败原因，用于 title 提示
   * @param {object} [options]
   * @param {boolean} [options.rerender=true] 是否重渲染。
   *        批量更新时传false，最后统一渲染一次，避免连续多次重绘。
   */
  function setCardSyncState(taskId, state, reason = '', options = {}) {
    const { rerender: shouldRerender = true } = options;
    const task = tasks().find(t => String(t.id) === String(taskId));
    if (!task) return;
    task.__sync = state === 'idle' ? null : { state, reason };

    // 重渲染后节点已是新的，所以先渲染再取节点
    if (shouldRerender) rerender();

    const card = document.querySelector(`.task-card[data-task-id="${CSS.escape(String(taskId))}"]`);
    if (!card) return;

    if (state === 'idle') {
      card.querySelectorAll('.sync-state-badge').forEach(b => b.remove());
      return;
    }

    // 复用第一个角标，并把多余的清掉。
    // （历史节点若因重渲染残留下来，不清理会出现两个角标叠在一起）
    const badges = card.querySelectorAll('.sync-state-badge');
    let badge = badges[0];
    for (let i = 1; i < badges.length; i++) badges[i].remove();

    if (!badge) {
      badge = document.createElement('span');
      card.appendChild(badge);
    }

    if (state === 'syncing') {
      badge.className = 'sync-state-badge syncing';
      badge.textContent = '同步中';
      badge.title = '正在与禅道同步';
    } else {
      badge.className = 'sync-state-badge failed';
      badge.textContent = '未同步';
      badge.title = reason || '同步到禅道失败，点击卡片上的「同步」重试';
    }
  }

  /**
   * 统一的后台同步流程。
   *
   * @param {object} options
   * @param {string|number} options.taskId       任务 ID
   * @param {Function} options.syncFn            真正调禅道的函数，返回 {success, ...}
   * @param {Function} [options.onSuccess]       成功回调，参数为 syncFn 的返回值
   * @param {Function} [options.onFailure]       失败回调，参数为 syncFn 的返回值或 Error
   * @param {string}   [options.successMessage]  成功 Toast 文案
   * @param {string}   [options.failureMessage]  失败 Toast 文案（函数，可接收返回值）
   * @param {boolean}  [options.markCard=true]   是否在卡片上显示同步状态
   * @param {boolean}  [options.quiet=false]     成功时不弹 Toast（例如静默补同步）
   * @returns {Promise<boolean>} 是否同步成功
   *
   * 说明：这里**不 await** 禅道结果给调用方，调用方可以立即继续做别的事；
   * 但返回的 Promise 仍可用于需要等待的场景（如「等待全部同步完成」测试）。
   */
  async function trackSync(options) {
    const {
      taskId,
      syncFn,
      onSuccess,
      onFailure,
      successMessage,
      failureMessage,
      markCard = true,
      quiet = false
    } = options;

    // 同一任务串行化：上一次没跑完就先排队，避免禅道状态被乱序覆盖
    const prev = inflight.get(String(taskId)) || Promise.resolve();
    const run = prev.then(async () => {
      if (markCard) setCardSyncState(taskId, 'syncing');

      let result;
      try {
        result = await syncFn();
      } catch (err) {
        result = { success: false, message: err && err.message ? err.message : String(err) };
      }

      if (result && result.success) {
        if (markCard) setCardSyncState(taskId, 'idle');
        if (typeof onSuccess === 'function') {
          try { await onSuccess(result); } catch (e) { console.warn('[Optimistic] onSuccess 出错:', e); }
        }
        if (!quiet && successMessage) {
          // successMessage 既可以是字符串也可以是函数，
          // 无条件当函数调用会在传字符串时抛「successMessage is not a function」
          const text = typeof successMessage === 'function'
            ? successMessage(result)
            : successMessage;
          toast().success(text);
        }
        return true;
      }

      // 失败：保留同步按钮，让用户能手动重试
      const reason = (result && (result.message || result.reason)) || '未知错误';
      if (markCard) setCardSyncState(taskId, 'failed', reason);
      if (typeof onFailure === 'function') {
        try { await onFailure(result); } catch (e) { console.warn('[Optimistic] onFailure 出错:', e); }
      }
      const msg = typeof failureMessage === 'function'
        ? failureMessage(result)
        : (failureMessage || `同步到禅道失败：${reason}`);
      toast().error(msg);
      console.warn('[Optimistic] 禅道同步失败:', reason, result);
      return false;
    });

    inflight.set(String(taskId), run.then(() => {}, () => {}));
    run.finally(() => {
      // 只有当队列里轮到自己时才清理，避免误删后继任务
      if (inflight.get(String(taskId)) === run) inflight.delete(String(taskId));
    });
    return run;
  }

  /**
   * 等待某任务的同步队列排空（供测试/退出场景使用）
   * @param {string|number} [taskId] 不传则等待全部
   */
  async function waitAll(taskId) {
    if (taskId === undefined) {
      await Promise.all([...inflight.values()]);
      return;
    }
    const p = inflight.get(String(taskId));
    if (p) await p;
  }

  /**
   * 把禅道返回的失败原因翻译成人话
   * @param {object} result
   * @returns {string}
   */
  function explainFailure(result) {
    if (!result) return '未知错误';
    switch (result.reason) {
      case 'not_configured': return '禅道未配置，请先在设置中配置禅道';
      case 'invalid_execution_id': return '未选择「所属执行」，禅道没有落点';
      case 'no_cookie': return '禅道登录态已失效，请重新登录禅道';
      case 'permission': return '禅道账号没有该操作的权限';
      case 'timeout': return '禅道响应超时';
      default:
        return result.message ? String(result.message) : (result.reason || '未知错误');
    }
  }

  global.OptimisticUI = {
    register,
    statusOf,
    insertTask,
    patchTask,
    setCardSyncState,
    trackSync,
    waitAll,
    explainFailure
  };
})(window);