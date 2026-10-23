// API配置
// 后端只监听 IPv4，且扩展只申请了 127.0.0.1 的主机权限，统一用 127.0.0.1
let API_BASE_URL = (typeof ConfigStore !== 'undefined') ? ConfigStore.backendUrl() : 'http://127.0.0.1:3721';

// 当前状态
let currentYear, currentMonth;
let selectedDate = null;
let allTasks = [];
let selectedTaskId = null;  // 当前选中的任务ID（用于键盘删除）
let deletingTaskIds = new Set();  // 正在删除的任务ID集合（防止重复调用）

// 调试模式状态
let debugMode = false;

// 进度条拖拽状态
let draggingProgressTask = null; // 正在拖拽的任务 ID
let draggingProgressElement = null; // 正在拖拽的进度条元素
let draggingProgressOriginalValue = null; // 拖拽前的原始进度值

// 今日工时：以禅道为准，由后端汇总（GET /api/workHours）；这里只在内存里持有显示用的数字，不写任何本地存储
let todayWorkHours = 0; // 今日已工作时长（小时）
let dailyWorkHours = 8; // 每日标准工时（后端配置，随 /api/workHours 一起返回）

// ==================== 禅道同步状态 ====================
const STORAGE_KEY_LAST_SYNC = 'zentao_last_sync_time';

const ZentaoSync = {
  _lastSyncTimestamp: null,
  _lastFormattedTime: null,
  _intervalId: null,

  /**
   * 获取最后同步时间（带缓存）
   * @returns {Promise<number>} 上次同步的时间戳（毫秒）
   */
  async getLastSyncTime() {
    const result = await chrome.storage.local.get([STORAGE_KEY_LAST_SYNC]);
    this._lastSyncTimestamp = result[STORAGE_KEY_LAST_SYNC] || 0;
    return this._lastSyncTimestamp;
  },

  /**
   * 格式化显示最后同步时间
   * @returns {Promise<string>} 格式化的时间字符串
   */
  async getFormattedLastSyncTime() {
    const lastSync = await this.getLastSyncTime();
    if (lastSync === 0) {
      return '从未同步';
    }

    const now = Date.now();
    const diff = now - lastSync;
    const minutes = Math.floor(diff / (60 * 1000));
    const hours = Math.floor(diff / (60 * 60 * 1000));
    const days = Math.floor(diff / (24 * 60 * 60 * 1000));

    if (minutes < 1) {
      return '刚刚';
    } else if (minutes < 60) {
      return `${minutes} 分钟前`;
    } else if (hours < 24) {
      return `${hours} 小时前`;
    } else if (days < 7) {
      return `${days} 天前`;
    } else {
      const date = new Date(lastSync);
      return date.toLocaleDateString('zh-CN');
    }
  },

  /**
   * 更新同步状态显示
   */
  async updateSyncStatusDisplay() {
    const syncStatusElement = document.getElementById('zentaoSyncStatus');
    if (!syncStatusElement) return;

    // 使用缓存的值或获取新值
    const lastSyncTimestamp = this._lastSyncTimestamp !== null
      ? this._lastSyncTimestamp
      : await this.getLastSyncTime();

    const formattedTime = this._lastFormattedTime || this.formatRelativeTime(lastSyncTimestamp);
    this._lastFormattedTime = formattedTime;

    syncStatusElement.textContent = `上次同步: ${formattedTime}`;

    // 立即同步按钮始终可用，不受24小时限制（用户可以随时手动同步）
    const syncButton = document.getElementById('manualSyncButton');
    if (syncButton) {
      syncButton.disabled = false;
      syncButton.title = '立即从禅道同步数据';
    }
  },

  /**
   * 格式化相对时间
   */
  formatRelativeTime(timestamp) {
    if (timestamp === 0) return '从未同步';

    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / (60 * 1000));
    const hours = Math.floor(diff / (60 * 60 * 1000));
    const days = Math.floor(diff / (24 * 60 * 60 * 1000));

    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes} 分钟前`;
    if (hours < 24) return `${hours} 小时前`;
    if (days < 7) return `${days} 天前`;
    return new Date(timestamp).toLocaleDateString('zh-CN');
  },

  /**
   * 手动触发同步
   */
  async manualSync() {
    const syncButton = document.getElementById('manualSyncButton');
    if (syncButton) {
      syncButton.disabled = true;
      syncButton.textContent = '同步中...';
    }

    try {
      // 进度 Toast：与 background.js 的 sendProgressUpdate 步数保持一致（共 2 步）
      ProgressToast.show('正在登录禅道...', 1, 2);

      // 通过 background.js 触发同步
      const response = await chrome.runtime.sendMessage({
        action: 'manualSyncFromZentao'
      });

      ProgressToast.hide();

      if (response && response.success) {
        // 只拼真实存在的字段：以前直接读 data.bugsSynced，而后端从不返回它，
        // 于是用户在界面上看到「已同步 0 个任务和 undefined 个Bug」。
        const d = response.data || {};
        const added = Number(d.added) || 0;
        const updated = Number(d.updated) || 0;
        const total = Number(d.tasksSynced) || 0;
        const bugs = Number(d.bugsSynced) || 0;
        const detail = (added || updated)
          ? `新增 ${added} 个，更新 ${updated} 个`
          : `共 ${total} 条，无变化`;
        Toast.success(`禅道同步完成：${detail}${bugs ? `，Bug 变更 ${bugs} 个` : ''}`);
        if (d.bugError) {
          Toast.warning(`Bug 同步失败：${d.bugError}`, 8000);
        }

        // 重新加载任务列表
        await loadTasks();

        // 重新加载 Bug 列表
        if (typeof BugManager !== 'undefined' && BugManager.loadBugs) {
          console.log('[ZentaoSync] 重新加载 Bug 列表...');
          await BugManager.loadBugs();
        }

        // 更新同步状态显示
        await this.updateSyncStatusDisplay();
      } else {
        const reason = (response && response.reason) || '未知错误';
        Toast.error(`同步失败: ${reason}`, 8000);
      }
    } catch (err) {
      ProgressToast.hide();
      console.error('[ZentaoSync] 手动同步失败:', err);
      Toast.error(`同步失败: ${err.message}`);
    } finally {
      if (syncButton) {
        syncButton.disabled = false;
        syncButton.textContent = '立即同步';
      }

      // 恢复按钮状态
      await this.updateSyncStatusDisplay();
    }
  },

  /**
   * 初始化禅道同步状态显示
   */
  async init() {
    // 更新同步状态显示
    await this.updateSyncStatusDisplay();

    // 绑定手动同步按钮事件
    const syncButton = document.getElementById('manualSyncButton');
    if (syncButton) {
      syncButton.addEventListener('click', () => {
        this.manualSync();
      });
    }

    // 监听存储变化，而不是轮询
    this._storageListener = (changes, areaName) => {
      if (areaName === 'local' && changes[STORAGE_KEY_LAST_SYNC]) {
        this._lastSyncTimestamp = changes[STORAGE_KEY_LAST_SYNC].newValue;
        this._lastFormattedTime = this.formatRelativeTime(this._lastSyncTimestamp);
        this.updateSyncStatusDisplay();
      }
    };
    chrome.storage.onChanged.addListener(this._storageListener);

    // 页面卸载时清理监听器
    window.addEventListener('beforeunload', () => {
      if (this._storageListener) {
        chrome.storage.onChanged.removeListener(this._storageListener);
      }
    });
  }
};

/**
 * 为「会被重复初始化的组件」提供可撤销的监听作用域
 *
 * 弹窗里的下拉组件每次打开都会重新初始化，而 display、document 这些元素是常驻的：
 * 直接 addEventListener 会越绑越多（绑两次 = 点一下开、又立刻关，下拉打不开）。
 * 用法：const signal = resetListenerScope(container); el.addEventListener(type, fn, { signal });
 * 再次调用时会撤掉上一次通过该 signal 绑定的全部监听。
 *
 * @param {Element} owner - 常驻的宿主元素（用于挂载 AbortController）
 * @returns {AbortSignal}
 */
function resetListenerScope(owner) {
  if (owner._listenerScope) owner._listenerScope.abort();
  owner._listenerScope = new AbortController();
  return owner._listenerScope.signal;
}

/**
 * 在浏览器里打开禅道任务 / Bug 页面，必要时自动登录
 *
 * 流程：
 *   1. 申请禅道地址的访问权限（首次会弹浏览器授权框；必须在点击的用户手势内调用）
 *   2. 读浏览器里现有的禅道会话，交给后端检查是否有效
 *   3. 失效则后端用配置的账号单独登录一次，插件把会话 cookie 写进浏览器
 *   4. 打开页面（看板任务由后端换成 onlybody 详情页）
 * 没授权时照常打开，需要在禅道页面手动登录。
 *
 * @param {task|bug} type
 * @param {string|number} zentaoId
 */
/**
 * 请求本地后端；连不上（后端正在重启：开机自启、插件拉起、更新后重载，期间十几秒不响应）时，
 * 等后端恢复（最多 8 秒）再重试一次，仍失败给出能看懂的原因，而不是浏览器的「Failed to fetch」
 */
async function fetchBackendWithRetry(url, init, waitMs = 8000) {
  try {
    return await fetch(url, init);
  } catch (err) {
    // 网络层失败（连接被拒、重置）浏览器抛 TypeError；按名字判断，跨窗口 / 跨环境也可靠
    if (!err || err.name !== 'TypeError') throw err;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
      const ok = await fetch(`${API_BASE_URL}/health`).then(r => r.ok).catch(() => false);
      if (ok) return fetch(url, init);
    }
    throw new Error('本地服务暂时连不上（可能正在重启），请稍后再试');
  }
}

async function openInZentao(type, zentaoId) {
  const cachedBase = ZentaoBrowserClient.getBaseUrl();
  let granted = false;
  if (cachedBase && chrome.permissions) {
    const origins = [`${new URL(cachedBase).origin}/*`];
    try {
      granted = await chrome.permissions.contains({ origins }) || await chrome.permissions.request({ origins });
    } catch (err) {
      console.warn('[OpenZentao] 申请禅道地址访问权限失败:', err.message);
    }
  }

  try {
    let browserSid = null;
    if (granted && chrome.cookies) {
      const c = await chrome.cookies.get({ url: `${cachedBase}/zentao/`, name: 'zentaosid' }).catch(() => null);
      browserSid = c ? c.value : null;
    }
    const resp = await fetchBackendWithRetry(`${API_BASE_URL}/api/zentao/open`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, id: String(zentaoId), browserSid })
    });
    const result = await resp.json();
    if (!result.success) throw new Error(result.message || '打开失败');

    if (Array.isArray(result.cookies) && result.cookies.length) {
      if (granted && chrome.cookies) {
        for (const c of result.cookies) {
          await chrome.cookies.set({ url: `${result.base}${c.path}`, name: c.name, value: c.value, path: c.path, httpOnly: !!c.httpOnly });
        }
      } else {
        Toast.info('未授权插件访问禅道地址，需要在打开的禅道页面里手动登录', 5000);
      }
    }
    chrome.tabs.create({ url: result.url });
  } catch (err) {
    console.warn('[OpenZentao] 打开禅道页面失败:', err.message);
    Toast.error(`打开禅道页面失败：${err.message}`);
  }
}

/**
 * 修改任务所属执行的选择浮层（卡片上点执行标签打开）
 *
 * 未同步的任务：任选，只改本地。
 * 已同步的任务：禅道只允许在同一项目的执行之间直接移动；其他执行标「需重建」，
 * 选中后二次确认，在新执行里重建任务并取消旧任务。
 */
const ExecutionPicker = {
  _close: null,
  _busy: false,

  async open(task, anchor) {
    if (this._close) this._close();
    const pop = document.createElement('div');
    pop.className = 'exec-picker';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', '修改所属执行');
    pop.innerHTML = `
      <div class="exec-picker-head">修改所属执行${task.zentaoId ? ` <span class="exec-picker-sub">任务 #${escapeHtml(task.zentaoId)}</span>` : ''}</div>
      <input type="search" class="exec-picker-search" placeholder="搜索执行或项目" aria-label="搜索执行或项目">
      <div class="exec-picker-list" role="listbox"><div class="exec-picker-empty">加载中…</div></div>`;
    this._close = placePopover(pop, anchor, () => { this._close = null; });
    const listEl = pop.querySelector('.exec-picker-list');
    const search = pop.querySelector('.exec-picker-search');
    setTimeout(() => search.focus(), 0);

    let executions = [];
    let favorites = new Set();
    let allowed = null;
    try {
      const [execResp, favResp, optResp] = await Promise.all([
        fetch(`${API_BASE_URL}/api/executions`).then(r => r.json()),
        fetch(`${API_BASE_URL}/api/executions/favorites`).then(r => r.json()).catch(() => ({})),
        fetch(`${API_BASE_URL}/api/tasks/${encodeURIComponent(task.id)}/execution-options`).then(r => r.json())
      ]);
      executions = (execResp && execResp.data) || [];
      favorites = new Set(((favResp && favResp.data) || []).map(e => String(e.id)));
      if (!optResp.success) throw new Error(optResp.message || '读取可选执行失败');
      allowed = optResp.allowed ? new Set(optResp.allowed.map(String)) : null;
    } catch (err) {
      listEl.innerHTML = `<div class="exec-picker-empty">加载失败：${escapeHtml(err.message)}</div>`;
      return;
    }

    const current = String(task.executionId || '');
    const inactive = new Set(['closed', 'cancel', '已关闭', '已取消']);
    const candidates = executions.filter(e => !inactive.has(e.status) || String(e.id) === current);

    const render = (keyword) => {
      const kw = String(keyword || '').trim().toLowerCase();
      const match = (e) => !kw || `${e.name} ${e.projectName || ''}`.toLowerCase().includes(kw);
      const groups = new Map();
      const favs = candidates.filter(e => favorites.has(String(e.id)) && match(e));
      if (favs.length) groups.set('★ 收藏', favs);
      candidates.filter(match).forEach(e => {
        const g = e.projectName || '未分组';
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(e);
      });
      if (!groups.size) {
        listEl.innerHTML = '<div class="exec-picker-empty">没有匹配的执行</div>';
        return;
      }
      listEl.innerHTML = [...groups.entries()].map(([g, list]) => `
        <div class="exec-picker-group">${escapeHtml(g)}</div>
        ${list.map(e => {
          const id = String(e.id);
          const isCurrent = id === current;
          const tag = isCurrent ? '当前' : (allowed && !allowed.has(id) ? '需重建' : (allowed ? '直接移动' : ''));
          return `<button type="button" class="exec-picker-item${isCurrent ? ' is-current' : ''}" role="option" data-exec-id="${escapeHtml(id)}" ${isCurrent ? 'aria-selected="true" disabled' : ''}>
            <span class="exec-picker-name">${escapeHtml(e.name)}${e.status && inactive.has(e.status) ? '（已关闭）' : ''}</span>
            ${tag ? `<span class="exec-picker-tag tag-${tag === '需重建' ? 'rebuild' : tag === '当前' ? 'current' : 'move'}">${tag}</span>` : ''}
          </button>`;
        }).join('')}`).join('');
      listEl.querySelectorAll('.exec-picker-item:not([disabled])').forEach(btn => {
        btn.addEventListener('click', () => {
          const exec = candidates.find(e => String(e.id) === btn.dataset.execId);
          if (this._close) this._close();
          this.choose(task, exec);
        });
      });
    };
    render('');
    search.addEventListener('input', () => render(search.value));
  },

  async choose(task, exec) {
    if (!exec || this._busy) return;
    this._busy = true;
    const post = (rebuild) => fetch(`${API_BASE_URL}/api/tasks/${encodeURIComponent(task.id)}/execution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ executionId: exec.id, rebuild })
    }).then(r => r.json());
    try {
      let result = await post(false);
      if (result.needRebuild) {
        const ok = await Confirm.show(
          '在新执行中重建任务？',
          `禅道不支持把任务移到其他项目。将在「${exec.name}」新建任务，复制标题、描述、优先级、截止日期、剩余工时和附件；` +
          `旧任务 #${task.zentaoId} 会在禅道里取消。\n\n注意：旧任务的工时记录和操作历史不会带过去。`,
          '重建',
          '取消'
        );
        if (!ok) return;
        ProgressToast.show(`正在「${exec.name}」重建任务…`);
        try {
          result = await post(true);
        } finally {
          ProgressToast.hide();
        }
      }
      if (!result.success) {
        Toast.error(`修改所属执行失败：${result.message || '未知错误'}`, 6000);
        return;
      }
      if (result.mode === 'unchanged') return;
      Toast.success(result.message);
      (result.warnings || []).forEach(w => Toast.warning(w, 8000));
      await loadTasks();
    } catch (err) {
      Toast.error(`修改所属执行失败：${err.message}`);
    } finally {
      this._busy = false;
    }
  }
};

// 卡片上的执行标签：全局委托一次（卡片频繁重建，不逐个绑定）
document.addEventListener('click', (e) => {
  const btn = e.target && e.target.closest && e.target.closest('[data-exec-task]');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const task = (typeof allTasks !== 'undefined' ? allTasks : []).find(t => String(t.id) === btn.dataset.execTask);
  if (task) ExecutionPicker.open(task, btn);
}, true);

// 附件变化（角标上点了重试等）后刷新任务与 Bug 列表
window.onAttachmentsChanged = () => {
  loadTasks().catch(() => { });
  if (typeof BugManager !== 'undefined' && BugManager.loadBugs) BugManager.loadBugs();
};

// ==================== Toast 通知系统 ====================
const Toast = {
  container: null,

  init() {
    this.container = document.getElementById('toastContainer');
  },

  show(message, type = 'info', duration = 3000) {
    if (!this.container) this.init();

    const icons = {
      success: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/><path d="M11 20a2 2 0 0 0 2 2v0a2 2 0 0 0-2-2v-2"/></svg>',
      error: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
      warning: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3.16L8 14.29a2 2 0 0 1 1.41 1.41L12 14l1.59-1.59a2 2 0 0 1 1.41-1.41L14.29 8a2 2 0 0 1 3.16-1.71L17.14 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="9"/></svg>',
      info: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
    };

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
      ${icons[type] || icons.info}
      <span class="toast-message">${this.escapeHtml(message)}</span>
      <button class="toast-close">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    `;

    const closeBtn = toast.querySelector('.toast-close');
    closeBtn.addEventListener('click', () => this.remove(toast));

    this.container.appendChild(toast);

    setTimeout(() => this.remove(toast), duration);

    return toast;
  },

  remove(toast) {
    if (toast && toast.parentNode) {
      toast.classList.add('removing');
      setTimeout(() => {
        if (toast.parentNode) {
          toast.parentNode.removeChild(toast);
        }
      }, 200);
    }
  },

  success(message, duration) {
    return this.show(message, 'success', duration);
  },

  error(message, duration) {
    return this.show(message, 'error', duration);
  },

  warning(message, duration) {
    return this.show(message, 'warning', duration);
  },

  info(message, duration) {
    return this.show(message, 'info', duration);
  },

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
};

// ==================== 进度 Toast 系统 ====================
const ProgressToast = {
  container: null,
  currentToast: null,
  currentStep: 0,
  totalSteps: 0,

  init() {
    this.container = document.getElementById('progressToastContainer');
  },

  /**
   * 显示进度 toast
   * @param {string} message - 进度消息
   * @param {number} currentStep - 当前步骤（可选）
   * @param {number} totalSteps - 总步骤数（可选）
   */
  show(message, currentStep = null, totalSteps = null) {
    if (!this.container) this.init();

    console.log(`[ProgressToast] show() 被调用: message="${message}", currentStep=${currentStep}, totalSteps=${totalSteps}`);

    // 如果提供了步骤信息，更新格式
    let displayMessage = message;
    if (currentStep !== null && totalSteps !== null) {
      this.currentStep = currentStep;
      this.totalSteps = totalSteps;
      displayMessage = `${currentStep}/${totalSteps} ${message}`;
    }

    console.log(`[ProgressToast] displayMessage="${displayMessage}", hasToast=${!!this.currentToast}, inDOM=${this.currentToast?.parentNode ? 'yes' : 'no'}`);

    // 如果已有 toast，只更新消息
    if (this.currentToast && this.currentToast.parentNode) {
      const messageEl = this.currentToast.querySelector('.progress-toast-message');
      if (messageEl) {
        messageEl.textContent = displayMessage;
        console.log(`[ProgressToast] 更新已有 toast: "${displayMessage}"`);
      }
      return this.currentToast;
    }

    // 创建新的进度 toast
    console.log(`[ProgressToast] 创建新 toast: "${displayMessage}"`);
    const toast = document.createElement('div');
    toast.className = 'progress-toast';
    toast.innerHTML = `
      <div class="progress-toast-spinner"></div>
      <span class="progress-toast-message">${this.escapeHtml(displayMessage)}</span>
    `;

    this.container.appendChild(toast);
    this.currentToast = toast;

    return toast;
  },

  /**
   * 更新进度 toast 消息
   * @param {string} message - 新的进度消息
   * @param {number} currentStep - 当前步骤（可选）
   * @param {number} totalSteps - 总步骤数（可选）
   */
  update(message, currentStep = null, totalSteps = null) {
    return this.show(message, currentStep, totalSteps);
  },

  /**
   * 隐藏进度 toast
   */
  hide() {
    if (this.currentToast && this.currentToast.parentNode) {
      this.currentToast.style.opacity = '0';
      setTimeout(() => {
        if (this.currentToast && this.currentToast.parentNode) {
          this.currentToast.parentNode.removeChild(this.currentToast);
        }
        this.currentToast = null;
        this.currentStep = 0;
        this.totalSteps = 0;
      }, 200);
    }
  },

  /**
   * 显示进度 toast 并在异步操作期间保持显示
   * @param {string} message - 进度消息
   * @param {Function} asyncOperation - 异步操作函数
   * @param {number} currentStep - 当前步骤（可选）
   * @param {number} totalSteps - 总步骤数（可选）
   */
  async withProgress(message, asyncOperation, currentStep = null, totalSteps = null) {
    this.show(message, currentStep, totalSteps);
    try {
      const result = await asyncOperation();
      return result;
    } finally {
      this.hide();
    }
  },

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
};

// ==================== 确认对话框 ====================
const Confirm = {
  dialog: null,

  init() {
    this.dialog = document.getElementById('confirmDialog');
    this.titleEl = document.getElementById('confirmTitle');
    this.messageEl = document.getElementById('confirmMessage');
    this.cancelBtn = document.getElementById('confirmCancel');
    this.okBtn = document.getElementById('confirmOk');
  },

  /**
   * 插件内的确认框（不要用浏览器原生 confirm：样式与插件不协调，还会带上扩展的标题栏）
   * @param {{danger?:boolean}} [options] - danger：删除、停止服务等不可逆操作，确认按钮标红
   * @returns {Promise<boolean>}
   */
  show(title, message, okText = '确定', cancelText = '取消', options = {}) {
    if (!this.dialog) this.init();
    // 上一次还没结算（例如被新的确认顶掉）：先按取消处理，再显示这一次
    if (this._settle) this._settle(false);

    this.titleEl.textContent = title;
    this.messageEl.textContent = message;
    this.cancelBtn.textContent = cancelText;
    this.okBtn.textContent = okText;
    this.dialog.classList.toggle('is-danger', !!options.danger);
    // 图标：一般确认用「i」，危险操作用「!」
    const icon = this.dialog.querySelector('.confirm-icon svg');
    if (icon) icon.innerHTML = options.danger
      ? '<circle cx="12" cy="12" r="10"></circle><path d="M12 8v4"></path><path d="M12 16h.01"></path>'
      : '<circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4"></path><path d="M12 8h.01"></path>';

    this.dialog.classList.add('active');

    // 每次 show 的确定 / 取消 / 遮罩监听只属于这一次，任一出口都会全部撤掉并只结算一次。
    // 旧实现取消按钮不结算 Promise，且确定按钮的监听残留：取消一次删除 A，
    // 之后在另一次确认里点「确定」删除 B，残留的监听会让 A 也被删除。
    return new Promise((resolve) => {
      const controller = new AbortController();
      const settle = (value) => {
        if (this._settle !== settle) return;
        this._settle = null;
        controller.abort();
        this.hide();
        resolve(value);
      };
      this._settle = settle;
      const { signal } = controller;
      this.okBtn.addEventListener('click', () => settle(true), { signal });
      this.cancelBtn.addEventListener('click', () => settle(false), { signal });
      // 点击遮罩关闭 = 取消
      this.dialog.addEventListener('click', (e) => { if (e.target === this.dialog) settle(false); }, { signal });
    });
  },

  hide() {
    this.dialog.classList.remove('active');
  }
};

// ==================== 进度更新输入对话框 ====================
const ProgressInputDialog = {
  dialog: null,
  picker: null,

  init() {
    this.dialog = document.getElementById('progressInputDialog');
    this.titleEl = document.getElementById('progressInputTitle');
    this.messageEl = document.getElementById('progressInputMessage');
    this.workInput = document.getElementById('progressInputWork');
    this.consumedInput = document.getElementById('progressInputConsumed');
    this.cancelBtn = document.getElementById('progressInputCancel');
    this.okBtn = document.getElementById('progressInputOk');
    this.attachmentsBox = document.getElementById('progressInputAttachments');
  },

  /**
   * @param {Object} [options]
   * @param {boolean} [options.allowAttachments] - 显示附件区（完成任务时附上验证截图）
   * @returns {Promise<{work:string, consumed:number, attachments:Array}|null>} 取消返回 null
   */
  show(title, message, placeholderWork = '', placeholderConsumed = '', defaultWork = '', defaultConsumed = 0, options = {}) {
    if (!this.dialog) this.init();
    // 上一次还没结算：按取消处理
    if (this._settle) this._settle(null);

    this.titleEl.textContent = title;
    this.messageEl.textContent = message;
    this.workInput.value = '';
    this.consumedInput.value = '';
    this.workInput.placeholder = placeholderWork || '请填写本次工作内容...';

    // 动态设置工时输入框的 placeholder，显示今日工时情况
    const workTimePlaceholder = getWorkTimePlaceholder();
    this.consumedInput.placeholder = placeholderConsumed || workTimePlaceholder;

    const withAttachments = !!(options.allowAttachments && this.attachmentsBox && typeof AttachmentPicker !== 'undefined');
    if (this.attachmentsBox) this.attachmentsBox.hidden = !withAttachments;
    if (withAttachments) {
      if (!this.picker) {
        this.picker = new AttachmentPicker(this.attachmentsBox.querySelector('.att-host'), {
          hint: '可附上验证截图、录屏等，提交后上传到禅道（不插入任务描述）'
        });
      }
      this.picker.clear();
      this.picker.bindPaste(this.dialog);
    }

    this.dialog.classList.add('active');

    // 聚焦到工作内容输入框
    setTimeout(() => this.workInput.focus(), 100);

    // 确定 / 取消 / 遮罩 / 回车的监听只属于这一次，任一出口全部撤掉并只结算一次。
    // 旧实现「取消」按钮不结算 Promise，调用方一直等待，拖动的进度也不会回滚。
    return new Promise((resolve) => {
      const controller = new AbortController();
      const { signal } = controller;
      const settle = (value) => {
        if (this._settle !== settle) return;
        this._settle = null;
        controller.abort();
        this.hide();
        resolve(value);
      };
      this._settle = settle;

      const handleOk = () => {
        const work = this.workInput.value.trim();
        const consumed = this.consumedInput.value.trim();

        // 验证消耗工时
        if (consumed && (isNaN(parseFloat(consumed)) || parseFloat(consumed) < 0)) {
          Toast.warning('请输入有效的工时数值');
          this.consumedInput.focus();
          return;
        }

        // 只有当工作内容和消耗工时都没有填写时，才使用默认值
        const attachments = withAttachments ? this.picker.getItems() : [];
        if (withAttachments) this.picker.clear();
        settle({
          work: work || defaultWork,
          consumed: consumed ? parseFloat(consumed) : defaultConsumed,
          attachments
        });
      };

      this.okBtn.addEventListener('click', handleOk, { signal });
      this.cancelBtn.addEventListener('click', () => settle(null), { signal });

      // 支持回车提交（输入法上屏时除外）
      const handleKeyPress = (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          handleOk();
        }
      };
      this.workInput.addEventListener('keydown', handleKeyPress, { signal });
      this.consumedInput.addEventListener('keydown', handleKeyPress, { signal });

      // 点击遮罩关闭 = 取消
      this.dialog.addEventListener('click', (e) => { if (e.target === this.dialog) settle(null); }, { signal });
    });
  },

  hide() {
    this.dialog.classList.remove('active');
    if (this.picker) this.picker.clear();
  }
};

// ==================== 乐观 UI 依赖注册 ====================
// 必须在任何乐观操作（改进度 / 改优先级 / 建任务）发生前执行，
// 否则 OptimisticUI 拿不到任务列表，会抛
// 「Cannot read properties of undefined (reading 'find')」。
//
// 为什么要显式注册：allTasks 是 `let`、Toast 是 `const`，
// 全局脚本里的 let/const 只是脚本级绑定，**不会**挂到 window 上
// （只有 var 和函数声明才会），所以 optimistic.js 里读 window.allTasks
// 拿到的永远是 undefined。
//
// allTasks 必须传函数而不是数组本身 —— 它会被整体重新赋值
// （loadTasks / loadTasksByDate / searchTasks），存引用会拿到过期数组。
if (window.OptimisticUI) {
  window.OptimisticUI.register({
    allTasks: () => allTasks,
    Toast: Toast,
    renderTasks: () => renderTasks()
  });
}

// 快捷函数
function showToast(message, type = 'info', duration = 3000) {
  return Toast.show(message, type, duration);
}

function showConfirm(title, message, okText = '确定', cancelText = '取消') {
  return Confirm.show(title, message, okText, cancelText);
}

// ==================== 今日工时 ====================
// 今日已填工时以禅道为准：后端读禅道汇总，前端不做任何累加或本地存储。
// （以前用 localStorage 自己累加：在禅道网页上填的、换浏览器 / 电脑都对不上。）

// 缓存当前日期，用于检测跨天
let currentDateStr = null;

/**
 * 获取当前日期字符串（YYYY_M_D 格式），只用来检测跨天
 */
function getCurrentDateStr() {
  const today = new Date();
  return `${today.getFullYear()}_${today.getMonth() + 1}_${today.getDate()}`;
}

/**
 * 检查日期是否变化，如果变化则重新向后端要今日工时
 */
function checkDateChange() {
  const newDateStr = getCurrentDateStr();
  if (currentDateStr && currentDateStr !== newDateStr) {
    currentDateStr = newDateStr;
    todayWorkHours = 0;
    updateTodayWorkTimeDisplay();
    refreshTodayWorkHours();
  } else if (!currentDateStr) {
    currentDateStr = newDateStr;
  }
}

/**
 * 向后端要今日已填工时（后端读禅道，60 秒内走缓存）
 */
async function refreshTodayWorkHours() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/workHours`);
    const data = await res.json();
    if (data.success) {
      todayWorkHours = data.data.hours || 0;
      if (data.data.standard > 0) dailyWorkHours = data.data.standard;
      updateTodayWorkTimeDisplay();
    }
  } catch (err) {
    console.log('[WorkTime] 获取今日工时失败:', err.message);
  }
}

/**
 * 刚记了一笔工时：先在界面上加上（只在内存里，不存储），
 * 禅道写入在后台完成，过几秒再向后端核对一次，以禅道的数为准
 */
function updateTodayWorkTime(hours) {
  todayWorkHours += hours;
  updateTodayWorkTimeDisplay();
  setTimeout(refreshTodayWorkHours, 4000);
  setTimeout(refreshTodayWorkHours, 15000);
}

/**
 * 获取工时输入框的 placeholder 文本
 */
function getWorkTimePlaceholder() {
  if (todayWorkHours >= dailyWorkHours) {
    const overtimeHours = (todayWorkHours - dailyWorkHours).toFixed(1);
    return `今日已加班 ${overtimeHours}h`;
  } else {
    return `今日已工作 ${todayWorkHours.toFixed(1)}h`;
  }
}

/**
 * 更新页面上的今日工时显示
 */
function updateTodayWorkTimeDisplay() {
  const el = document.getElementById('todayWorkTime');
  if (el) {
    if (todayWorkHours >= dailyWorkHours) {
      const overtimeHours = (todayWorkHours - dailyWorkHours).toFixed(1);
      el.textContent = `今日已加班 ${overtimeHours}h`;
      el.style.color = '#ef4444'; // 红色表示加班
    } else {
      el.textContent = `今日已工作 ${todayWorkHours.toFixed(1)}h`;
      el.style.color = '#10b981'; // 绿色表示正常
    }
  }
}

/**
 * 获取今日工时记录话术（用于报告生成）
 */
function getTodayWorkTimeReport() {
  if (todayWorkHours >= dailyWorkHours) {
    const overtimeHours = (todayWorkHours - dailyWorkHours).toFixed(1);
    return `今日已工作 ${todayWorkHours.toFixed(1)}h（加班 ${overtimeHours}h）`;
  } else {
    return `今日已工作 ${todayWorkHours.toFixed(1)}h`;
  }
}


// ==================== 进度条拖拽处理 ====================

/**
 * 根据鼠标位置更新进度显示（不提交）
 */
function updateProgressFromMouse(e) {
  if (!draggingProgressElement) return;
  const { progressTrack, progressFill, progressInput } = draggingProgressElement;
  const rect = progressTrack.getBoundingClientRect();
  const percent = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
  progressFill.style.width = `${percent}%`;
  if (progressInput) {
    progressInput.value = Math.round(percent);
  }
}

/**
 * 设置进度条拖拽的全局事件
 */
function setupProgressDragEvents() {
  // 鼠标移动事件
  document.addEventListener('mousemove', (e) => {
    if (draggingProgressTask) {
      e.preventDefault();
      updateProgressFromMouse(e);
    }
  });

  // 鼠标释放事件
  document.addEventListener('mouseup', (e) => {
    if (draggingProgressTask) {
      const { progressTrack, progressFill, progressInput } = draggingProgressElement;
      const rect = progressTrack.getBoundingClientRect();
      const percent = Math.round(((e.clientX - rect.left) / rect.width) * 100);
      const clampedPercent = Math.max(0, Math.min(100, percent));
      const taskId = draggingProgressTask;
      const originalValue = draggingProgressOriginalValue;

      console.log('[Progress Drag] 鼠标释放:', { taskId, originalValue, newValue: clampedPercent });

      // 立即清空拖拽状态，防止在对话框显示期间鼠标移动继续更新进度
      draggingProgressTask = null;
      draggingProgressElement = null;
      draggingProgressOriginalValue = null;

      // 提交进度更新（updateTaskProgress 内部已做乐观渲染，成功后无需再整表刷新）
      updateTaskProgress(taskId, clampedPercent).then((result) => {
        console.log('[Progress Drag] updateTaskProgress 返回:', result);

        // 用户取消时，本地数据没变，需要从后端重新拉一次把界面刷回去
        if (result === false) {
          console.log('[Progress Drag] 用户取消，恢复UI到原始值:', originalValue);
          if (progressFill) progressFill.style.width = `${originalValue}%`;
          if (progressInput) progressInput.value = originalValue;
          loadTasks().catch(err => console.warn('[Progress Drag] 刷新任务失败:', err));
        }

        // 重置光标
        document.body.style.cursor = '';
        if (progressTrack) progressTrack.style.cursor = 'pointer';
      }).catch(err => {
        console.warn('[Progress Drag] 更新进度失败:', err);
        // 恢复UI到原始值
        if (progressFill) progressFill.style.width = `${originalValue}%`;
        if (progressInput) progressInput.value = originalValue;
        // 重置光标
        document.body.style.cursor = '';
        if (progressTrack) progressTrack.style.cursor = 'pointer';
      });
    }
  });

  // 触摸事件支持
  document.addEventListener('touchmove', (e) => {
    if (draggingProgressTask) {
      const touch = e.touches[0];
      if (draggingProgressElement) {
        const { progressTrack, progressFill, progressInput } = draggingProgressElement;
        const rect = progressTrack.getBoundingClientRect();
        const percent = Math.max(0, Math.min(100, ((touch.clientX - rect.left) / rect.width) * 100));
        progressFill.style.width = `${percent}%`;
        if (progressInput) {
          progressInput.value = Math.round(percent);
        }
      }
    }
  });

  document.addEventListener('touchend', (e) => {
    if (draggingProgressTask) {
      const touch = e.changedTouches[0];
      const { progressTrack, progressFill, progressInput } = draggingProgressElement;
      const rect = progressTrack.getBoundingClientRect();
      const percent = Math.round(((touch.clientX - rect.left) / rect.width) * 100);
      const clampedPercent = Math.max(0, Math.min(100, percent));
      const taskId = draggingProgressTask;
      const originalValue = draggingProgressOriginalValue;

      // 立即清空拖拽状态，防止在对话框显示期间触摸移动继续更新进度
      draggingProgressTask = null;
      draggingProgressElement = null;
      draggingProgressOriginalValue = null;

      // 提交进度更新
      updateTaskProgress(taskId, clampedPercent).then((result) => {
        // 如果用户取消，立即恢复UI到原始值
        if (result === false) {
          console.log('[Progress Drag] 触摸用户取消，恢复UI到原始值:', originalValue);
          if (progressFill) progressFill.style.width = `${originalValue}%`;
          if (progressInput) progressInput.value = originalValue;
          // 刷新任务列表以确保完全同步
          loadTasks().catch(err => console.warn('[Progress Drag] 刷新任务失败:', err));
        }
        // 重置光标
        document.body.style.cursor = '';
        if (progressTrack) progressTrack.style.cursor = 'pointer';
      }).catch(err => {
        console.warn('[Progress Drag] 更新进度失败:', err);
        // 恢复UI到原始值
        if (progressFill) progressFill.style.width = `${originalValue}%`;
        if (progressInput) progressInput.value = originalValue;
        // 重置光标
        document.body.style.cursor = '';
        if (progressTrack) progressTrack.style.cursor = 'pointer';
      });
    }
  });
}

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
  // 初始化 ZentaoBrowserClient（从缓存加载用户列表）
  ZentaoBrowserClient.init();
  // 预取禅道地址：点卡片上的禅道 ID 时要在用户手势内同步申请访问权限，来不及再请求配置
  ZentaoBrowserClient.initConfig().catch(() => { });

  // 清掉老版本留在浏览器里的业务数据副本（今日工时累加值、用户列表缓存）；这些数据现在只在后端 / 禅道
  try { Object.keys(localStorage).filter(k => /^(workTime_|taskWorkTime_)/.test(k) || k === 'zentao_users').forEach(k => localStorage.removeItem(k)); } catch { /* 无痕等环境 */ } // legacy-cleanup

  // 初始化今日工时（向后端要，以禅道为准）
  currentDateStr = getCurrentDateStr();
  refreshTodayWorkHours();

  // 初始化 Toast
  Toast.init();

  // 初始化 ProgressToast
  if (typeof ProgressToast !== 'undefined') {
    ProgressToast.init();
  }

  // 检查 AI 可用性并给出顶部提示（避免用户误以为「AI 不聪明」其实是没配 key）
  checkAiAvailability();

  // 检查后端连通性；未运行时由插件自动拉起
  checkBackendHealth();

  // 监听来自 background.js 的进度更新消息
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[NewTab] 收到消息:', message.action, message);

    if (message.action === 'updateProgress') {
      const { currentStep, totalSteps, message: progressMessage } = message;
      console.log(`[NewTab] 收到进度更新: ${currentStep}/${totalSteps} - ${progressMessage}`);
      console.log(`[NewTab] ProgressToast 是否存在:`, typeof ProgressToast !== 'undefined');

      if (typeof ProgressToast !== 'undefined') {
        ProgressToast.update(progressMessage, currentStep, totalSteps);
      } else {
        console.log('[NewTab] ProgressToast 未定义');
      }
    }
    // 注意：不返回 true，因为这是单向消息，不需要响应
  });

  // 恢复调试模式状态
  const savedDebugMode = localStorage.getItem('debugMode');
  const debugModeToggle = document.getElementById('debugModeToggle');
  if (savedDebugMode === 'true') {
    debugMode = true;
    const testButtons = document.getElementById('testButtons');
    if (testButtons) testButtons.classList.add('visible');
    if (debugModeToggle) debugModeToggle.checked = true;
    // 调试模式下才显示「更新用户列表」等维护操作（见 settings.css 的 .debug-only）
    document.body.classList.add('debug-on');
    console.log('%c[调试模式] 已自动开启', 'color: #f59e0b; font-size: 14px; font-weight: bold;');
  }

  // 调试模式切换（设置页面中的复选框）
  if (debugModeToggle) {
    debugModeToggle.addEventListener('change', () => {
      debugMode = debugModeToggle.checked;
      if (typeof ReportPage !== 'undefined' && ReportPage.rendered && ReportPage.data) ReportPage.render();   // 日历里的「补」随调试开关出现 / 消失
      const testButtons = document.getElementById('testButtons');

      if (debugMode) {
        if (testButtons) testButtons.classList.add('visible');
        document.body.classList.add('debug-on');
        localStorage.setItem('debugMode', 'true');
        Toast.success('调试模式已开启');
        console.log('%c[调试模式] 测试按钮已显示', 'color: #f59e0b; font-size: 14px; font-weight: bold;');
      } else {
        if (testButtons) testButtons.classList.remove('visible');
        document.body.classList.remove('debug-on');
        localStorage.removeItem('debugMode');
        Toast.info('调试模式已关闭');
      }
    });
  }

  // 设置以后端为准，浏览器里只留缓存：先迁移老版本的本地设置，再启动静默校对
  // （启动时、回到页面时、每 10 分钟；后端的设置变了，设置页正开着且没改过内容就自动刷新）
  ConfigStore.migrateLegacy().catch(() => { });
  ConfigStore.onChange(() => {
    const modal = document.getElementById('settingsModal');
    const open = modal && modal.classList.contains('active');
    if (open && window.settingsUI && window.settingsUI.isDirty()) return;   // 你正在改，不覆盖
    if (open) loadSettings();
  });
  ConfigStore.start();

  // 初始化日历
  const now = new Date();
  currentYear = now.getFullYear();
  currentMonth = now.getMonth() + 1;
  selectedDate = now.toISOString().split('T')[0];

  await loadCalendar();
  await loadTasks();
  await loadHistoryPreview();
  await checkTodayReports();

  // 初始化任务弹框
  await initTaskModal();

  // 初始化禅道同步状态显示
  ZentaoSync.init().catch(err => {
    console.error('[ZentaoSync] 初始化失败:', err);
  });

  // 绑定事件
  bindEvents();

  // 页面获得焦点时检查日期变化（防止跨天累积）
  window.addEventListener('focus', () => {
    checkDateChange();
    updateTodayWorkTimeDisplay();
  });

  // 定时检查日期变化（每分钟检查一次）
  setInterval(() => {
    checkDateChange();
    updateTodayWorkTimeDisplay();
  }, 60 * 1000); // 每分钟检查一次
});

// ====================================
// AI 服务商预设表
// ====================================

/**
 * 支持的 AI 服务商。
 * 覆盖国内主流 + 海外 + 本地部署，均为 OpenAI 兼容协议（除标注外）。
 * key 与 <select id="aiProvider"> 的 option value 一一对应。
 */
const AI_PROVIDERS = {
  zhipu: {
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4/',
    model: 'glm-4-flash',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    hint: '国产全能，GLM-4-Flash 速度快成本低，推荐用于任务解析'
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    hint: '性价比高，JSON 遵循度好，适合结构化任务'
  },
  moonshot: {
    label: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    hint: '长文本能力强，适合日报/周报生成'
  },
  qwen: {
    label: '通义千问 DashScope',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-turbo',
    keyUrl: 'https://bailian.console.aliyun.com/',
    hint: '阿里出品，qwen-turbo 速度快，支持超长上下文'
  },
  doubao: {
    label: '豆包（火山方舟）',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-pro-32k',
    keyUrl: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey',
    hint: '字节出品，需在火山方舟控制台开通服务后使用'
  },
  ernie: {
    label: '百度文心一言',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    model: 'ernie-4.0-8k',
    keyUrl: 'https://console.bce.baidu.com/qianfan/ais/console/apikey',
    hint: '百度千帆平台，需 Access Key 而非普通 API Key'
  },
  minimax: {
    label: 'MiniMax',
    baseUrl: 'https://api.minimax.chat/v1',
    model: 'abab6.5s-chat',
    keyUrl: 'https://platform.minimaxi.com/user-center/basic-api/interface-key',
    hint: '国内大模型，长文本处理稳定'
  },
  siliconflow: {
    label: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    hint: '一站式接入多个开源模型，有免费额度'
  },
  together: {
    label: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    keyUrl: 'https://api.together.ai/settings/api-keys',
    hint: '海外聚合平台，模型丰富'
  },
  openai: {
    label: 'OpenAI 官方',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
    hint: '需海外网络环境'
  },
  anthropic: {
    label: 'Anthropic Claude',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-3-5-sonnet-20241022',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    hint: '⚠️ 官方接口非 OpenAI 协议，建议改用支持 Claude 的聚合服务'
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-3.5-sonnet',
    keyUrl: 'https://openrouter.ai/keys',
    hint: '聚合平台，一个 Key 访问 Claude/GPT/Llama 等'
  },
  ollama: {
    label: 'Ollama 本地部署',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen3:8b',
    keyUrl: null,
    hint: '数据完全不出本机；Key 填任意非空值即可（本地校验用）'
  },
  custom: {
    label: '自定义（OpenAI 兼容）',
    baseUrl: '',
    model: '',
    keyUrl: null,
    hint: '适用于自建网关、代理服务等任何 OpenAI 兼容接口'
  }
};

/** 设置页里 AI 相关的后端请求：带上当前填写的接口地址与 Key（Key 留空时后端用该地址保存过的） */
async function postAiSettings(path, extra = {}) {
  const resp = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      baseUrl: document.getElementById('apiBaseUrl').value.trim(),
      apiKey: document.getElementById('apiKey').value.trim(),
      ...extra
    })
  });
  return resp.json().catch(() => ({ success: false, message: `HTTP ${resp.status}` }));
}

/**
 * 设置页的模型选择
 *   - 各服务商分别记住接口地址、两类模型（profiles，存浏览器）；Key 按接口地址保存在后端
 *   - 切换服务商：先记下当前的（含刚填、还没保存的 Key，只在本页内存里），再恢复目标服务商的；
 *     没配过的用预设。切回来不用重填
 *   - 获取到的模型列表填进两个下拉框；测速推荐给两类用途各推荐几个
 */
const AiModelPicker = {
  profiles: {},
  typedKeys: {},
  savedKeyHosts: [],
  models: [],
  provider: null,

  init(config) {
    this.profiles = { ...(config.aiProfiles || {}) };
    this.provider = config.aiProvider || 'zhipu';
    this.typedKeys = {};
    this.models = [];
    ['aiModelSelect', 'aiReportModelSelect'].forEach(id => { const el = document.getElementById(id); if (el) { el.style.display = 'none'; el.innerHTML = ''; } });
    const bench = document.getElementById('benchAiModels');
    if (bench) bench.disabled = true;
    const box = document.getElementById('aiBenchResult');
    if (box) { box.hidden = true; box.innerHTML = ''; }
    this.loadKeyStatus();
  },

  /**
   * 设置以后端为准回填：浏览器里的设置可能是空的（扩展 ID 变了、换了浏览器、重置过），
   * 以前此时显示默认值，一保存就把后端的真实配置（AI 地址、推送地址等）冲掉
   */
  applyBackendConfig(d) {
    const set = (id, v) => { const el = document.getElementById(id); if (el && v !== undefined && v !== null && v !== '') el.value = v; };
    const ai = d.ai || {};
    if (ai.apiBaseUrl) {
      set('apiBaseUrl', ai.apiBaseUrl);
      const host = this.hostOf(ai.apiBaseUrl);
      const match = Object.keys(AI_PROVIDERS).find(p => AI_PROVIDERS[p].baseUrl && this.hostOf(AI_PROVIDERS[p].baseUrl) === host);
      const provider = match || 'custom';
      const select = document.getElementById('aiProvider');
      if (select && select.value !== provider && [...select.options].some(o => o.value === provider)) select.value = provider;
      this.provider = provider;
    }
    set('aiModel', ai.aiModel);
    if (ai.aiReportModel !== undefined) { const el = document.getElementById('aiReportModel'); if (el) el.value = ai.aiReportModel || ''; }
    if (d.schedule) { set('morningHour', d.schedule.morningHour); set('eveningHour', d.schedule.eveningHour); set('workHours', d.schedule.workHours); set('workHolidays', d.schedule.holidays); set('workMakeup', d.schedule.makeup); }
    if (d.autofill) { set('afMaxTasks', d.autofill.maxTasksPerDay); set('afMinChunk', d.autofill.minChunk); set('afMaxChunk', d.autofill.maxChunk); set('afMaxDays', d.autofill.maxDaysPerTask); set('afMaxOvertime', d.autofill.maxOvertime); const afp = document.getElementById('afPrompt'); if (afp) afp.value = d.autofill.prompt || ''; }
    if (d.webhook) {
      if (d.webhook.url !== undefined) { const el = document.getElementById('webhookUrl'); if (el) el.value = d.webhook.url || ''; }
      set('webhookType', d.webhook.type);
    }
  },

  /** 后端告诉我们哪些接口地址保存过 Key（不回传 Key 本身） */
  async loadKeyStatus() {
    try {
      const resp = await fetch(`${API_BASE_URL}/api/config`);
      const result = await resp.json();
      this.savedKeyHosts = (result && result.data && result.data.ai && result.data.ai.savedKeyHosts) || [];
      if (result && result.data) this.applyBackendConfig(result.data);
    } catch {
      this.savedKeyHosts = [];
    }
    this.refreshKeyPlaceholder();
    if (window.settingsUI && window.settingsUI.refreshBaseline) window.settingsUI.refreshBaseline();
  },

  hostOf(url) {
    try {
      return new URL(String(url).trim().replace(/\/(chat\/completions|models)\/?$/i, '')).host.toLowerCase();
    } catch {
      return '';
    }
  },

  refreshKeyPlaceholder() {
    const keyEl = document.getElementById('apiKey');
    if (!keyEl) return;
    const host = this.hostOf(document.getElementById('apiBaseUrl').value);
    keyEl.placeholder = host && this.savedKeyHosts.includes(host)
      ? '已保存（留空即使用已保存的 Key）'
      : (this.provider === 'ollama' ? '本地部署可填任意值，如 ollama' : '请输入 API Key');
  },

  /** 记下当前服务商的地址、模型，以及填了但还没保存的 Key */
  rememberCurrent() {
    const baseUrl = document.getElementById('apiBaseUrl').value.trim();
    this.profiles[this.provider] = {
      apiBaseUrl: baseUrl,
      aiModel: document.getElementById('aiModel').value.trim(),
      aiReportModel: document.getElementById('aiReportModel').value.trim()
    };
    const key = document.getElementById('apiKey').value.trim();
    const host = this.hostOf(baseUrl);
    if (key && host) this.typedKeys[host] = key;
  },

  switchProvider(provider) {
    this.rememberCurrent();
    this.provider = provider;
    const saved = this.profiles[provider];
    if (saved && (saved.apiBaseUrl || saved.aiModel)) {
      applyAiProviderPreset(provider);
      document.getElementById('apiBaseUrl').value = saved.apiBaseUrl || document.getElementById('apiBaseUrl').value;
      document.getElementById('aiModel').value = saved.aiModel || document.getElementById('aiModel').value;
      document.getElementById('aiReportModel').value = saved.aiReportModel || '';
    } else {
      applyAiProviderPreset(provider);
      document.getElementById('aiReportModel').value = '';
    }
    // Key：本页刚填过的直接恢复；后端保存过的留空（占位提示「已保存」）；都没有才需要填
    const host = this.hostOf(document.getElementById('apiBaseUrl').value);
    document.getElementById('apiKey').value = (host && this.typedKeys[host]) || '';
    this.refreshKeyPlaceholder();
    // 换了服务商，之前获取的模型列表不再适用
    this.setModels([]);
    const box = document.getElementById('aiBenchResult');
    if (box) { box.hidden = true; box.innerHTML = ''; }
  },

  setModels(models) {
    this.models = models || [];
    const bench = document.getElementById('benchAiModels');
    if (bench) bench.disabled = !this.models.length;
    [['aiModelSelect', 'aiModel'], ['aiReportModelSelect', 'aiReportModel']].forEach(([selectId, inputId]) => {
      const select = document.getElementById(selectId);
      if (!select) return;
      if (!this.models.length) { select.style.display = 'none'; select.innerHTML = ''; return; }
      const current = document.getElementById(inputId).value.trim();
      select.innerHTML = `<option value="">从 ${this.models.length} 个模型中选择…</option>` +
        this.models.map(m => `<option value="${escapeHtml(m)}"${m === current ? ' selected' : ''}>${escapeHtml(m)}</option>`).join('');
      select.style.display = '';
    });
  },

  pick(inputId, model) {
    const input = document.getElementById(inputId);
    if (!input) return;
    input.value = model;
    // 让设置页的「未保存修改」检测感知到变化
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const select = document.querySelector(`.ai-model-select[data-target="${inputId}"]`);
    if (select) select.value = model;
  },

  renderBenchmark(box, result) {
    const mark = { good: '✅', slow: '⚠️', bad: '❌' };
    const chips = (list, target, label) => (list.length
      ? list.map(m => `<button type="button" class="ai-bench-pick" data-pick-target="${target}" data-pick-model="${escapeHtml(m)}" title="设为${label}">${escapeHtml(m)}</button>`).join('')
      : '<span class="ai-bench-none">没有合适的</span>');
    box.innerHTML = `
      <div class="ai-bench-rec"><strong>任务解析推荐</strong>（实测最快、能稳定返回 JSON）：${chips(result.recommend.task, 'aiModel', '任务解析模型')}</div>
      <div class="ai-bench-rec"><strong>报告总结推荐</strong>（实测可用的里面档位更高的）：${chips(result.recommend.report, 'aiReportModel', '报告总结模型')}</div>
      <table class="ai-bench-table"><thead><tr><th>模型</th><th>耗时</th><th>任务解析</th><th>报告总结</th></tr></thead><tbody>
        ${result.results.map(r => `<tr>
          <td>${escapeHtml(r.model)}${r.reasoning ? ' <span class="ai-bench-tag">推理</span>' : ''}</td>
          <td title="${(r.samples || [r.seconds]).map(x => `${x}s`).join(' / ')}">${r.seconds}s</td>
          <td title="${escapeHtml(r.task.text)}">${mark[r.task.level]}</td>
          <td title="${escapeHtml(r.report.text)}">${mark[r.report.level]}</td></tr>`).join('')}
      </tbody></table>
      <div class="ai-bench-note">共测 ${result.tested} 个（cn: 前缀与同名模型只测一个）${(result.skipped || []).length ? `；未测：${escapeHtml(result.skipped.join('、'))}` : ''}。耗时取两次里较慢的那次（中转延迟波动较大）；任务解析要在 8 秒内返回，报告不受这个限制。点推荐的模型名即可填入，记得保存。</div>`;
  }
};

/**
 * 应用服务商预设：自动填入接口地址、模型与提示
 * @param {string} provider - 服务商 key
 */
function applyAiProviderPreset(provider) {
  const preset = AI_PROVIDERS[provider];
  if (!preset) return;

  const baseUrlEl = document.getElementById('apiBaseUrl');
  const modelEl = document.getElementById('aiModel');
  const hintEl = document.getElementById('aiProviderHint');
  const modelHintEl = document.getElementById('aiModelHint');
  const keyEl = document.getElementById('apiKey');

  if (baseUrlEl && preset.baseUrl) baseUrlEl.value = preset.baseUrl;
  if (modelEl && preset.model) modelEl.value = preset.model;

  if (hintEl) {
    hintEl.textContent = preset.hint + (preset.keyUrl ? ` · 获取 Key：${preset.keyUrl}` : '');
  }
  if (modelHintEl) {
    modelHintEl.textContent = provider === 'ollama'
      ? '本地模型名需与 `ollama list` 输出一致'
      : (preset.model ? `默认模型：${preset.model}` : '');
  }

  if (keyEl && !keyEl.value && provider === 'ollama') {
    keyEl.placeholder = '本地部署可填任意值，如 ollama';
  } else if (keyEl) {
    keyEl.placeholder = '请输入 API Key';
  }
}

// 绑定事件
function bindEvents() {
  bindDragAndDrop();

  // 进度条拖拽全局事件
  setupProgressDragEvents();
  // 添加任务
  document.getElementById('addTaskBtn').addEventListener('click', addTask);
  // 看板头部「添加任务」：手动填写表单（弹窗已开着时不重复打开）
  document.getElementById('headerAddTaskBtn').addEventListener('click', () => {
    const modal = document.getElementById('taskCreateModal');
    if (modal && modal.style.display === 'flex') return;
    openBlankTaskModal();
  });
  document.getElementById('taskInput').addEventListener('keydown', async function (e) {
    if (e.key === 'Enter') {
      // 正在使用输入法拼音选词的时候按下回车不应该触发添加
      if (e.isComposing || e.keyCode === 229) {
        return;
      }

      if (!e.shiftKey) {
        e.preventDefault();
        // 根据 TabSwitcher 的当前模式决定调用哪个函数
        if (TabSwitcher.currentMode === 'bug') {
          // Bug 模式：获取执行选择和内容
          const executionSelect = document.getElementById('executionSelect');
          const selectedExecutionId = executionSelect ? executionSelect.value : null;
          const content = this.value.trim();

          // 必须输入内容
          if (!content) {
            Toast.error('请输入 Bug 描述');
            return;
          }

          // 获取执行名称和项目ID（如果选择了具体执行）
          let executionName = '';
          let projectId = '';
          if (selectedExecutionId && executionSelect.selectedIndex >= 0) {
            executionName = executionSelect.options[executionSelect.selectedIndex]?.text || '';
            // 从 ExecutionSelector 的收藏列表中查找 projectId
            if (typeof ExecutionSelector !== 'undefined' && ExecutionSelector.favoriteExecutions) {
              const exec = ExecutionSelector.favoriteExecutions.find(e => e.id === selectedExecutionId);
              if (exec) {
                projectId = exec.projectId || '';
                console.log('[Bug模式] 从执行选择器获取项目ID:', projectId, '执行:', exec.name);
              }
            }
          }

          console.log('[Bug模式] 准备提交 - executionId:', selectedExecutionId, 'projectId:', projectId, 'content:', content.substring(0, 50));

          // 调用 BugManager 打开弹窗并预填信息
          // 如果 selectedExecutionId 为空，AI 会自动匹配执行
          console.log('[Bug模式] BugManager 对象:', typeof BugManager, 'quickSubmit 方法:', typeof BugManager?.quickSubmit);
          if (typeof BugManager !== 'undefined' && BugManager.quickSubmit) {
            console.log('[Bug模式] 调用 quickSubmit...');
            await BugManager.quickSubmit(selectedExecutionId, executionName, projectId, content);
            this.value = ''; // 清空输入框
            console.log('[Bug模式] quickSubmit 完成');
          } else {
            console.error('[Bug模式] BugManager 或 quickSubmit 不可用');
          }
        } else {
          // 任务模式：添加任务
          addTask();
        }
      } else {
        // 明确实现 Shift+Enter 换行功能
        e.preventDefault();
        const start = this.selectionStart;
        const end = this.selectionEnd;
        const val = this.value;
        this.value = val.substring(0, start) + '\n' + val.substring(end);
        this.selectionStart = this.selectionEnd = start + 1;
      }
    }
  });


  // 全局键盘事件：删除任务
  document.addEventListener('keydown', async (e) => {
    // 如果焦点在输入框、textarea 或模态框中，不处理
    const target = e.target;
    if (target.matches('input, textarea, [contenteditable]') ||
        target.closest('.modal') || target.closest('.confirm-dialog')) {
      return;
    }

    // Delete 或 Backspace 键：弹出确认删除对话框
    if ((e.key === 'Delete' || e.key === 'Backspace') && selectedTaskId) {
      e.preventDefault();
      const task = allTasks.find(t => t.id === selectedTaskId);
      if (task) {
        showDeleteConfirmDialog(task);
      }
    }

    // Enter 键：直接删除（不弹确认）
    if (e.key === 'Enter' && selectedTaskId) {
      e.preventDefault();
      await deleteSelectedTask();
    }

    // Escape 键：取消选中
    if (e.key === 'Escape' && selectedTaskId) {
      e.preventDefault();
      document.querySelectorAll('.task-card.selected').forEach(c => c.classList.remove('selected'));
      selectedTaskId = null;
    }
  });

  // 日历导航
  document.getElementById('prevMonth').addEventListener('click', () => {
    currentMonth--;
    if (currentMonth < 1) {
      currentMonth = 12;
      currentYear--;
    }
    loadCalendar();
  });

  document.getElementById('nextMonth').addEventListener('click', () => {
    currentMonth++;
    if (currentMonth > 12) {
      currentMonth = 1;
      currentYear++;
    }
    loadCalendar();
  });

  // 设置

  document.getElementById('closeSettings').addEventListener('click', () => {
    document.getElementById('settingsModal').classList.remove('active');
  });

  // ========== 提示词（提示词读写见顶层 loadPrompts / savePrompts）==========

  // 顶栏「提示词」按钮：直接打开设置面板并定位到「提示词」分组
  document.getElementById('promptSettingsBtn').addEventListener('click', () => openSettingsModal('p-prompt'));

  // 「恢复默认」= 清空输入框（空即使用系统默认提示词）
  const promptResetMap = {
    resetAddTaskPromptBtn: 'promptAddTask',
    resetDailyPromptBtn: 'promptDaily',
    resetWeeklyPromptBtn: 'promptWeekly',
    resetMonthlyPromptBtn: 'promptMonthly'
  };
  Object.keys(promptResetMap).forEach((btnId) => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', () => {
      const input = document.getElementById(promptResetMap[btnId]);
      if (!input) return;
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      Toast.success('已恢复默认，保存配置后生效');
    });
  });

// ====================================
// 配置导出 / 导入（换机迁移）
// ====================================

/**
 * 加密导出：用户自己配置的部分（含禅道密码与 AI Key）由后端用口令加密成一个 JSON 文件
 * 设置页各服务商的地址与模型只存在浏览器里，一并交给后端放进文件
 */
async function exportAllConfig() {
  const resultEl = document.getElementById('configTransferResult');
  const pass = document.getElementById('exportPassphrase');
  const pass2 = document.getElementById('exportPassphrase2');
  const show = (text, cls) => { if (resultEl) { resultEl.textContent = text; resultEl.className = `test-result ${cls || ''}`; } };
  if (pass.value.length < 8) { show('✗ 口令至少 8 位', 'error'); pass.focus(); return; }
  if (pass.value !== pass2.value) { show('✗ 两次输入的口令不一致', 'error'); pass2.focus(); return; }
  try {
    const response = await fetch(`${API_BASE_URL}/api/config/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase: pass.value })
    });
    const json = await response.json();
    if (!json.success) throw new Error(json.message || '导出失败');

    const blob = new Blob([JSON.stringify(json.data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `workAssistant-config-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    pass.value = '';
    pass2.value = '';
    show('✅ 已加密导出（含禅道密码与 AI Key）。请记住口令，导入时需要', 'success');
    Toast.success('配置已加密导出');
  } catch (err) {
    show('✗ 导出失败：' + err.message, 'error');
    Toast.error('导出失败：' + err.message);
  }
}

/** 选中的待导入文件（解析后的 JSON） */
let pendingImportFile = null;

/** 选了文件：显示导出时间与包含的内容，等用户输入口令 */
async function prepareImport(file) {
  const resultEl = document.getElementById('configTransferResult');
  const info = document.getElementById('importConfigInfo');
  const pass = document.getElementById('importPassphrase');
  const btn = document.getElementById('importConfirmBtn');
  pendingImportFile = null;
  [info, pass, btn].forEach(el => { el.hidden = true; });
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed || parsed.__app !== 'workAssistant') throw new Error('不是禅道助手导出的配置文件');
    if (!parsed.encrypted) throw new Error('这是旧版导出的文件（不含密码与 Key）：请在原机器上用新版本重新导出');
    pendingImportFile = parsed;
    const at = parsed.exportedAt ? new Date(parsed.exportedAt).toLocaleString('zh-CN') : '未知时间';
    info.innerHTML = `<b>${escapeHtml(file.name)}</b><br>导出于 ${escapeHtml(at)}<br>包含：${escapeHtml((parsed.contents || []).join('、'))}`;
    [info, pass, btn].forEach(el => { el.hidden = false; });
    pass.value = '';
    pass.focus();
    if (resultEl) { resultEl.textContent = ''; resultEl.className = 'test-result'; }
  } catch (err) {
    if (resultEl) { resultEl.textContent = '✗ ' + err.message; resultEl.className = 'test-result error'; }
  }
}

/** 解密并导入：后端写回 .env 与运行时配置；浏览器里的设置（各服务商地址与模型等）一并回填 */
async function importAllConfig() {
  const resultEl = document.getElementById('configTransferResult');
  const pass = document.getElementById('importPassphrase');
  const show = (text, cls) => { if (resultEl) { resultEl.textContent = text; resultEl.className = `test-result ${cls || ''}`; } };
  if (!pendingImportFile) return;
  if (!pass.value) { show('✗ 请输入导出时设置的口令', 'error'); pass.focus(); return; }
  if (!(await Confirm.show('导入配置', '导入会覆盖当前的禅道、AI、通知、提示词等设置（其他地址已保存的 AI Key 保留）。继续吗？', '导入'))) return;
  show('解密并导入中…');
  try {
    const response = await fetch(`${API_BASE_URL}/api/config/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: pendingImportFile, passphrase: pass.value })
    });
    const json = await response.json();
    if (!json.success) throw new Error(json.message || '导入失败');
    // 设置都已写进后端；浏览器里的缓存向后端要最新的（页面随后会刷新）
    await ConfigStore.sync({ force: true });
    pass.value = '';
    pendingImportFile = null;
    show(`✅ 已导入：${json.data.applied.join('、')}。正在刷新…`, 'success');
    Toast.success('配置已导入');
    setTimeout(() => location.reload(), 1200);
  } catch (err) {
    show('✗ 导入失败：' + err.message, 'error');
    if (/口令/.test(err.message)) pass.select();
  }
}

// AI服务选择切换
  document.getElementById('aiProvider').addEventListener('change', (e) => {
    AiModelPicker.switchProvider(e.target.value);
  });
  document.getElementById('apiBaseUrl').addEventListener('input', () => AiModelPicker.refreshKeyPlaceholder());

  // 模型选型说明展开/收起
  const aiModelHelpBtn = document.getElementById('aiModelHelpBtn');
  const aiModelHelp = document.getElementById('aiModelHelp');
  if (aiModelHelpBtn && aiModelHelp) {
    aiModelHelpBtn.addEventListener('click', () => {
      aiModelHelp.style.display = aiModelHelp.style.display === 'none' ? 'block' : 'none';
    });
  }

  // 配置导出 / 导入
  document.getElementById('exportConfigBtn')?.addEventListener('click', exportAllConfig);
  document.getElementById('importConfigBtn')?.addEventListener('click', () => {
    document.getElementById('importConfigFile').click();
  });
  document.getElementById('importConfigFile')?.addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) prepareImport(file);
    e.target.value = ''; // 允许重复选择同一个文件
  });
  document.getElementById('importConfirmBtn')?.addEventListener('click', importAllConfig);
  document.getElementById('importPassphrase')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); importAllConfig(); }
  });

  // 获取模型列表：由后端请求服务商的 /models（扩展页直连会受跨域限制）
  document.getElementById('fetchAiModels').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const hint = document.getElementById('aiModelsHint');
    btn.disabled = true;
    hint.textContent = '正在获取模型列表…';
    try {
      const result = await postAiSettings('/api/ai/models');
      if (!result.success) throw new Error(result.message || '获取失败');
      AiModelPicker.setModels(result.models);
      // 地址填的是完整聊天地址时，后端会规整成 base URL，这里同步回填
      if (result.baseUrl) document.getElementById('apiBaseUrl').value = result.baseUrl;
      hint.textContent = `已获取 ${result.models.length} 个模型，可在下面两个模型里直接选择；不确定选哪个，点「测速推荐」`;
    } catch (err) {
      hint.textContent = `❌ ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });

  // 测速推荐：后端给每个模型发一条任务解析请求，按实测给两类用途各推荐几个
  document.getElementById('benchAiModels').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const box = document.getElementById('aiBenchResult');
    btn.disabled = true;
    box.hidden = false;
    box.innerHTML = '<div class="ai-bench-wait">正在逐个测试（最多 24 个模型，每个最长 25 秒），通常需要 30~60 秒…</div>';
    try {
      const result = await postAiSettings('/api/ai/benchmark', { models: AiModelPicker.models });
      if (!result.success) throw new Error(result.message || '测速失败');
      AiModelPicker.renderBenchmark(box, result);
    } catch (err) {
      box.innerHTML = `<div class="ai-bench-wait">❌ ${escapeHtml(err.message)}</div>`;
    } finally {
      btn.disabled = false;
    }
  });
  document.getElementById('aiBenchResult').addEventListener('click', (e) => {
    const pick = e.target.closest('[data-pick-model]');
    if (pick) AiModelPicker.pick(pick.dataset.pickTarget, pick.dataset.pickModel);
  });
  document.querySelectorAll('.ai-model-select').forEach(select => {
    select.addEventListener('change', (e) => {
      if (e.target.value) AiModelPicker.pick(e.target.dataset.target, e.target.value);
    });
  });

  // 测试连接：任务解析模型、报告总结模型分别按各自用途测（经后端）
  document.getElementById('testAi').addEventListener('click', async () => {
    const resultEl = document.getElementById('aiTestResult');
    const taskModel = document.getElementById('aiModel').value.trim();
    const reportModel = document.getElementById('aiReportModel').value.trim();
    resultEl.textContent = '测试中...';
    resultEl.className = 'test-result';
    const line = (label, r) => `${r.success ? (r.verdict && r.verdict.level === 'good' ? '✅' : '⚠️') : '❌'} ${label}：${r.message || (r.success ? '连接成功' : '连接失败')}`;
    try {
      const lines = [];
      const task = await postAiSettings('/api/ai/test', { model: taskModel, purpose: 'task' });
      lines.push(line(`任务解析（${taskModel || '未填'}）`, task));
      if (reportModel && reportModel !== taskModel) {
        const report = await postAiSettings('/api/ai/test', { model: reportModel, purpose: 'report' });
        lines.push(line(`报告总结（${reportModel}）`, report));
      }
      resultEl.textContent = lines.join('\n');
      resultEl.className = `test-result ${lines.every(l => l.startsWith('✅')) ? 'success' : lines.some(l => l.startsWith('❌')) ? 'error' : ''}`;
      resultEl.style.whiteSpace = 'pre-line';
    } catch (err) {
      resultEl.textContent = `❌ 连接失败: ${err.message}`;
      resultEl.className = 'test-result error';
    }
  });

  // 填了企业微信 / 钉钉 / 飞书机器人地址：类型跟着选好（类型选错时平台会拒收消息，以前还会显示「推送成功」）
  document.getElementById('webhookUrl').addEventListener('input', (e) => {
    let host = '';
    try { host = new URL(e.target.value.trim()).host.toLowerCase(); } catch { return; }
    const type = host === 'qyapi.weixin.qq.com' ? 'wecom'
      : host === 'oapi.dingtalk.com' ? 'dingtalk'
        : (host.endsWith('feishu.cn') || host.endsWith('larksuite.com')) ? 'feishu' : '';
    const select = document.getElementById('webhookType');
    if (type && select.value !== type) {
      select.value = type;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  // 测试 Webhook
  document.getElementById('testWebhook').addEventListener('click', async () => {
    const url = document.getElementById('webhookUrl').value.trim();
    const type = document.getElementById('webhookType').value;
    const resultEl = document.getElementById('webhookTestResult');

    if (!url) {
      resultEl.textContent = '❌ 请先输入 Webhook 地址';
      resultEl.className = 'test-result error';
      return;
    }

    resultEl.textContent = '⏳ 测试发送中...';
    resultEl.className = 'test-result';

    try {
      const response = await fetch(`${API_BASE_URL}/api/webhook/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, type })
      });

      const result = await response.json();
      if (response.ok && result.success) {
        resultEl.textContent = '✅ 推送成功！';
        resultEl.className = 'test-result success';
      } else {
        resultEl.textContent = `❌ ${result.error || result.message || '连接失败'}`;
        resultEl.className = 'test-result error';
      }
    } catch (err) {
      resultEl.textContent = `❌ 连接失败: ${err.message}`;
      resultEl.className = 'test-result error';
    }
  });

  // ========== 禅道相关事件 ==========

  // 测试禅道连接
  document.getElementById('testZentao').addEventListener('click', async () => {
    const url = document.getElementById('zentaoUrl').value.trim();
    const username = document.getElementById('zentaoUsername').value.trim();
    const password = document.getElementById('zentaoPassword').value.trim();
    const resultEl = document.getElementById('zentaoTestResult');

    // 密码不回显：留空表示使用已保存的密码
    if (!url || !username) {
      resultEl.textContent = '❌ 请先填写禅道地址和账号';
      resultEl.className = 'test-result error';
      return;
    }

    resultEl.textContent = '⏳ 测试连接中...';
    resultEl.className = 'test-result';

    try {
      // 由后端用表单里的地址/账号/密码试登录（不影响已保存的配置与会话）
      const resp = await fetch(`${API_BASE_URL}/api/zentao/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, username, password })
      });
      const result = await resp.json();

      if (result.success) {
        resultEl.textContent = '✅ 连接并登录成功';
        resultEl.className = 'test-result success';
      } else {
        resultEl.textContent = `❌ 连接失败：${result.message || '请检查地址、账号和密码'}`;
        resultEl.className = 'test-result error';
      }
    } catch (err) {
      resultEl.textContent = `❌ 连接异常: ${err.message}`;
      resultEl.className = 'test-result error';
    }
  });

  // 更新禅道用户列表
  document.getElementById('updateZentaoUsers').addEventListener('click', async () => {
    const resultEl = document.getElementById('zentaoUsersResult');

    resultEl.textContent = '⏳ 正在更新用户列表...';
    resultEl.className = 'test-result';

    try {
      const users = await ZentaoBrowserClient.refreshUsersFromZentao();
      const userCount = Object.keys(users).length;

      if (userCount > 0) {
        resultEl.textContent = `✅ 用户列表已更新，共 ${userCount} 个用户`;
        resultEl.className = 'test-result success';
      } else {
        resultEl.textContent = '❌ 未获取到用户列表，请确保已登录禅道';
        resultEl.className = 'test-result error';
      }
    } catch (err) {
      resultEl.textContent = `❌ 更新失败: ${err.message}`;
      resultEl.className = 'test-result error';
    }
  });

  // 保存配置（配置与提示词一起提交——设置面板只有一个保存入口）
  document.getElementById('saveSettings').addEventListener('click', async () => {
    const saveBtn = document.getElementById('saveSettings');
    setBtnLoading(saveBtn, '保存中…');

    const typedKey = document.getElementById('apiKey').value.trim();
    AiModelPicker.rememberCurrent();
    const config = {
      apiBaseUrl: document.getElementById('apiBaseUrl').value.trim(),
      aiModel: document.getElementById('aiModel').value.trim(),
      aiReportModel: document.getElementById('aiReportModel').value.trim(),
      aiProfiles: AiModelPicker.profiles,
      morningHour: document.getElementById('morningHour').value,
      eveningHour: document.getElementById('eveningHour').value,
      webhookUrl: document.getElementById('webhookUrl').value.trim(),
      webhookType: document.getElementById('webhookType').value,
      aiProvider: document.getElementById('aiProvider').value,
      // 禅道配置
      zentaoEnabled: document.getElementById('zentaoEnabled')?.checked || false,
      zentaoUrl: document.getElementById('zentaoUrl')?.value.trim() || '',
      zentaoUsername: document.getElementById('zentaoUsername')?.value.trim() || '',
      zentaoCreateTaskUrl: document.getElementById('zentaoCreateTaskUrl')?.value.trim() || ''
    };

    let savedOk = false;

    // 禅道密码只发给后端（存在本机 .env），不写进浏览器
    const typedZentaoPassword = document.getElementById('zentaoPassword')?.value.trim() || '';

    try {
      // 同步所有配置到后端（会持久化到 .env 文件）
      try {
        const response = await fetch(`${API_BASE_URL}/api/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            // 留空 = 用这个地址以前保存的 Key（Key 只存在后端 .env，按地址分别保存）
            apiKey: typedKey,
            apiBaseUrl: config.apiBaseUrl || '',
            aiModel: config.aiModel || '',
            aiReportModel: config.aiReportModel || '',
            morningHour: config.morningHour || '9',
            eveningHour: config.eveningHour || '21',
            // 每日标准工时只存后端，不放进 config（config 会被存成浏览器里的副本）
            workHours: document.getElementById('workHours')?.value || '8',
            // 上班日历（节假日 / 调休日）同样只存后端
            workHolidays: document.getElementById('workHolidays')?.value ?? '',
            workMakeup: document.getElementById('workMakeup')?.value ?? '',
            // 工时补填参数（调试页）同样只存后端
            autofill: document.getElementById('afMaxTasks') ? {
              maxTasksPerDay: document.getElementById('afMaxTasks').value, minChunk: document.getElementById('afMinChunk').value,
              maxChunk: document.getElementById('afMaxChunk').value, maxDaysPerTask: document.getElementById('afMaxDays').value,
              maxOvertime: document.getElementById('afMaxOvertime').value,
              prompt: document.getElementById('afPrompt').value
            } : undefined,
            webhookUrl: config.webhookUrl || '',
            webhookType: config.webhookType || 'generic',
            // 各服务商记住的地址与模型：真身在后端
            client: { aiProvider: config.aiProvider || '', aiProfiles: config.aiProfiles || {} },
            // 冲突检测：带上本地缓存的 rev，后端已被别处改过就拒绝
            baseRev: ConfigStore.rev || undefined
          })
        });

        const result = await response.json();
        if (response.status === 409 || result.code === 'CONFIG_CONFLICT') {
          // 别处改过：用后端最新的刷新缓存和表单，请用户确认后再保存（这次什么都没写）
          await ConfigStore.sync({ force: true });
          ConfigStore.hold(false);
          loadSettings();
          Toast.warning(result.message || '配置已在别处被修改，已刷新为最新，请确认后再保存');
          return;
        }
        if (result.success) {
          console.log('[前端] 配置已保存到后端 .env 文件');
        } else {
          console.warn('[前端] 保存配置失败:', result.error);
        }
      } catch (err) {
        console.warn('同步配置失败:', err);
      }

      // 同步禅道配置到后端
      try {
        const response = await fetch(`${API_BASE_URL}/api/zentao/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            enabled: config.zentaoEnabled,
            url: config.zentaoUrl,
            username: config.zentaoUsername,
            password: typedZentaoPassword,
            createTaskUrl: config.zentaoCreateTaskUrl
          })
        });

        const result = await response.json();
        if (result.success) {
          console.log('[前端] 禅道配置已保存');
        } else {
          console.warn('[前端] 禅道配置保存失败:', result.error);
        }
      } catch (err) {
        console.warn('同步禅道配置失败:', err);
      }

      // 全员报告关注的用户（存后端 .env，下次生成报告时生效）
      if (typeof ReportMembersPicker !== 'undefined') {
        try {
          await ReportMembersPicker.save();
        } catch (err) {
          Toast.error('报告成员保存失败：' + err.message);
        }
      }

      // 提示词与配置同属「设置」，一次保存一起写盘
      try {
        await savePrompts();
      } catch (promptErr) {
        console.warn('保存提示词失败:', promptErr);
        Toast.error('提示词保存失败：' + promptErr.message);
      }

      // 保存完成：缓存向后端要最新的（新的 rev），之后恢复静默校对的界面刷新
      ConfigStore.hold(false);
      await ConfigStore.sync({ force: true });

      // 与旧版不同：保存后不再自动关闭面板，用户可继续改其它分组。
      // 底部状态条会变为「所有更改已保存」，需要关闭时点右上角 ×。
      if (typedZentaoPassword) {
        const pwEl = document.getElementById('zentaoPassword');
        pwEl.value = '';
        pwEl.placeholder = '已保存（留空表示不修改）';
      }
      Toast.success('配置已保存');
      savedOk = true;
    } catch (err) {
      console.warn('[前端] 保存配置异常:', err);
      Toast.error('保存失败：' + err.message);
    } finally {
      // 先还原按钮，再刷新基线：refreshBaseline 会按「是否仍有改动」决定
      // 保存按钮的禁用态，顺序反了会把它的结果覆盖掉。
      setBtnLoading(saveBtn, null);
    }

    if (savedOk && window.settingsUI) window.settingsUI.refreshBaseline();
    loadTasks();
    loadCalendar();
  });

  // 重置配置：由设置页 UI 层（settings-ui.js）实现「二次确认」交互，
  // 这里不再重复绑定，避免一次点击触发两套逻辑。

  // 关闭任务详情弹窗
  document.getElementById('closeModal').addEventListener('click', () => {
    document.getElementById('taskModal').classList.remove('active');
  });

  // 点击弹窗外部关闭
  document.getElementById('taskModal').addEventListener('click', (e) => {
    if (e.target.id === 'taskModal') {
      document.getElementById('taskModal').classList.remove('active');
    }
  });

  document.getElementById('settingsModal').addEventListener('click', (e) => {
    if (e.target.id === 'settingsModal') {
      document.getElementById('settingsModal').classList.remove('active');
    }
  });

  // ==================== 测试按钮事件 ====================
  // 早9点通知测试
  document.getElementById('testMorningBtn')?.addEventListener('click', async () => {
    await testScheduledTask('morning', '早间提醒');
  });

  // 晚9点日报测试
  document.getElementById('testEveningBtn')?.addEventListener('click', async () => {
    await testScheduledTask('evening', '晚间日报');
  });

  // 周五晚周报测试
  document.getElementById('testWeeklyBtn')?.addEventListener('click', async () => {
    await testScheduledTask('weekly', '周报');
  });

  // 月末晚月报测试
  document.getElementById('testMonthlyBtn')?.addEventListener('click', async () => {
    await testScheduledTask('monthly', '月报');
  });

  // 设置时间模态框关闭事件
  document.getElementById('closeDatetimeModal').addEventListener('click', () => {
    document.getElementById('datetimeModal').classList.remove('active');
  });

  document.getElementById('datetimeModal').addEventListener('click', (e) => {
    if (e.target.id === 'datetimeModal') {
      document.getElementById('datetimeModal').classList.remove('active');
    }
  });

  // 全局点击关闭所有优先级菜单
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.priority-dropdown') && !e.target.closest('.priority-menu')) {
      document.querySelectorAll('.priority-menu').forEach(m => {
        m.style.display = 'none';
      });
    }
  });
}

// ==================== 测试定时任务 ====================
async function testScheduledTask(taskType, taskName) {
  const btn = document.getElementById(`test${taskType.charAt(0).toUpperCase() + taskType.slice(1)}Btn`);
  if (!btn) return;

  const originalText = btn.textContent;
  btn.textContent = '执行中...';
  btn.disabled = true;

  try {
    // 推送地址以后端保存的为准（设置页保存时已写入），这里直接触发

    let response;
    if (taskType === 'morning') {
      // 早间提醒
      console.log(`[前端] 调用早间提醒 API`);
      response = await fetch(`${API_BASE_URL}/api/test/morning`, { method: 'POST' });
    } else if (taskType === 'evening') {
      // 晚间日报
      console.log(`[前端] 调用晚间日报 API`);
      response = await fetch(`${API_BASE_URL}/api/test/evening`, { method: 'POST' });
    } else if (taskType === 'weekly') {
      // 周报 - 添加 autoPush=true 自动推送
      console.log(`[前端] 调用周报 API，autoPush=true`);
      response = await fetch(`${API_BASE_URL}/api/report/generate/weekly?autoPush=true`, { method: 'POST' });
    } else if (taskType === 'monthly') {
      // 月报 - 添加 autoPush=true 自动推送
      console.log(`[前端] 调用月报 API，autoPush=true`);
      response = await fetch(`${API_BASE_URL}/api/report/generate/monthly?autoPush=true`, { method: 'POST' });
    }

    console.log(`[前端] API响应状态:`, response.status);
    const result = await response.json();
    console.log(`[前端] API响应数据:`, result);

    if (result.success) {
      // 静默成功，刷新报告状态
      console.log(`[前端] ${taskName}执行成功`);
      await checkTodayReports();
      Toast.success(`${taskName}执行成功`);
    } else {
      Toast.error(`${taskName}执行失败: ${result.error || result.message}`);
    }
  } catch (err) {
    console.warn(`[前端] ${taskName}执行出错:`, err.message);
    Toast.error(`${taskName}执行出错: ${err.message}`);
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

// ==================== 开发模式：显示测试按钮 ====================
// 在控制台输入 showTestButtons() 来显示测试按钮
window.showTestButtons = function () {
  const testButtons = document.getElementById('testButtons');
  if (testButtons) {
    testButtons.style.display = 'flex';
    console.log('测试按钮已显示');
  }
};

// 在控制台输入 hideTestButtons() 来隐藏测试按钮
window.hideTestButtons = function () {
  const testButtons = document.getElementById('testButtons');
  if (testButtons) {
    testButtons.style.display = 'none';
    console.log('测试按钮已隐藏');
  }
};

// ==================== 侧栏「智能总结」 ====================
// 报告已移到「📊 报告」标签页（基于禅道数据，按日历查看）。侧栏按钮与历史报告按钮由 reports.js 绑定。

/** 兼容旧调用点（测试按钮执行后）：刷新报告页日历 */
async function checkTodayReports() {
  if (typeof ReportPage !== 'undefined') ReportPage.refresh();
}

// 加载日历数据
async function loadCalendar() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/calendar/${currentYear}/${currentMonth}`);
    const result = await response.json();

    if (result.success) {
      renderCalendar(result.data);
    }
  } catch (err) {
    Toast.error('加载日历失败');
    console.warn('加载日历失败:', err);
  }
}

// 渲染日历
function renderCalendar(data) {
  document.getElementById('currentMonth').textContent = `${data.year}年${data.month}月`;

  const container = document.getElementById('calendarContainer');
  container.innerHTML = '';

  const daysInMonth = new Date(data.year, data.month, 0).getDate();

  // 获取当月第一天是星期几（0=周日, 1=周一, ...）
  const firstDayOfMonth = new Date(data.year, data.month - 1, 1).getDay();

  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];

  // 添加空格子（月初前的空白）
  for (let i = 0; i < firstDayOfMonth; i++) {
    const emptyDiv = document.createElement('div');
    emptyDiv.className = 'calendar-day empty';
    container.appendChild(emptyDiv);
  }

  // 添加日期格子
  for (let day = 1; day <= daysInMonth; day++) {
    const dayDiv = document.createElement('div');
    dayDiv.className = 'calendar-day';

    const dateStr = `${data.year}-${String(data.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    // 检查是否是未来日期
    const checkDate = new Date(dateStr + 'T00:00:00');
    const isFuture = checkDate > new Date();

    // 检查是否是今天
    const isToday = dateStr === todayStr;

    // 检查是否有任务
    const dayData = data.days[String(day)] || { total: 0, done: 0 };
    const hasTasks = dayData.total > 0;

    // 计算达成等级
    let level = 0;
    if (dayData.done === 0) level = 0;
    else if (dayData.done <= 2) level = 1;
    else if (dayData.done <= 4) level = 2;
    else if (dayData.done <= 6) level = 3;
    else level = 4;

    if (isFuture) {
      dayDiv.classList.add('future');
      dayDiv.classList.add('level-0');
    } else {
      dayDiv.classList.add(`level-${level}`);
    }

    if (isToday) {
      dayDiv.classList.add('today');
    }

    // 高亮选中日期
    if (dateStr === selectedDate) {
      dayDiv.classList.add('selected');
    }

    // 创建日期数字
    const dayNum = document.createElement('div');
    dayNum.className = 'calendar-day-number';
    dayNum.textContent = day;
    dayDiv.appendChild(dayNum);

    // 如果有任务，给格子上添加 hover title 提示
    if (!isFuture && hasTasks) {
      dayDiv.title = `${dayData.done}/${dayData.total} 完成`;
    }

    // 点击事件（非未来日期）
    if (!isFuture) {
      dayDiv.addEventListener('click', () => {
        document.querySelectorAll('.calendar-day').forEach(d => d.classList.remove('selected'));
        dayDiv.classList.add('selected');
        selectedDate = dateStr;
        loadTasksByDate(dateStr);
      });
    }

    container.appendChild(dayDiv);
  }
}

// 加载任务
/**
 * 后端返回的任务列表里没有 __sync（它只是前端 UI 状态）。
 * 整表替换 allTasks 之前先把本地同步状态按 taskId 捞回来，
 * 否则切日期 / 刷新后，正在同步或同步失败的角标会凭空消失。
 */
function carryOverSyncState(freshTasks) {
  if (!Array.isArray(freshTasks)) return freshTasks;
  const prev = new Map();
  for (const t of allTasks || []) {
    if (t && t.id !== undefined && t.__sync) prev.set(String(t.id), t.__sync);
  }
  for (const t of freshTasks) {
    if (!t || t.id === undefined) continue;
    const s = prev.get(String(t.id));
    if (s) t.__sync = s;
    else delete t.__sync;
  }
  return freshTasks;
}

async function loadTasks() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/tasks?date=${selectedDate}`);
    const result = await response.json();

    if (result.success) {
      allTasks = carryOverSyncState(result.data);
      renderTasks();
    }
    await updateTaskStats();
  } catch (err) {
    Toast.error('加载任务失败');
    console.warn('加载任务失败:', err);
    showEmptyState();
  }
}

// 按日期加载任务
async function loadTasksByDate(dateStr) {
  selectedDate = dateStr;
  document.getElementById('taskBoardTitle').textContent = `📋 ${dateStr} 任务`;

  try {
    const response = await fetch(`${API_BASE_URL}/api/tasks/date/${dateStr}`);
    const result = await response.json();

    if (result.success) {
      allTasks = carryOverSyncState(result.data);
      renderTasks();
    }
  } catch (err) {
    Toast.error('加载任务失败');
    console.warn('加载任务失败:', err);
  }
}

function renderTasks() {
  // 优先级菜单挂在 body 上，随卡片重建；先清掉旧的，避免已删除任务的菜单残留
  document.querySelectorAll('.priority-menu').forEach(m => m.remove());

  let filteredTasks = [...allTasks];

  // 排序规则：手动拖拽 > 优先级 > 修改时间
  filteredTasks.sort((a, b) => {
    // 1. 手动拖拽位置（order）- 只有当 order 有具体数值时才认为有手动排序
    const aHasOrder = typeof a.order === 'number';
    const bHasOrder = typeof b.order === 'number';

    if (aHasOrder && bHasOrder) return a.order - b.order;
    if (aHasOrder) return -1;
    if (bHasOrder) return 1;

    // 2. 优先级（1最高，4最低）
    const aPriority = a.priority ?? 3;
    const bPriority = b.priority ?? 3;
    if (aPriority !== bPriority) return aPriority - bPriority;

    // 3. 最后修改时间
    const aTime = new Date(a.updatedAt || a.createdAt).getTime();
    const bTime = new Date(b.updatedAt || b.createdAt).getTime();
    return bTime - aTime;
  });

  // 更新计数
  updateCounts();

  // 清空列表
  document.getElementById('todoList').innerHTML = '';
  document.getElementById('inProgressList').innerHTML = '';
  document.getElementById('doneList').innerHTML = '';

  if (filteredTasks.length === 0) {
    showEmptyState();
    return;
  }

  // 按状态分组
  const todoTasks = filteredTasks.filter(t => t.status === 'todo');
  const inProgressTasks = filteredTasks.filter(t => t.status === 'in_progress');
  const doneTasks = filteredTasks.filter(t => t.status === 'done');

  // 渲染
  todoTasks.forEach(t => document.getElementById('todoList').appendChild(createTaskCard(t)));
  inProgressTasks.forEach(t => document.getElementById('inProgressList').appendChild(createTaskCard(t)));
  doneTasks.forEach(t => document.getElementById('doneList').appendChild(createTaskCard(t)));

  // 更新列计数
  document.getElementById('todoColumnCount').textContent = todoTasks.length;
  document.getElementById('inProgressColumnCount').textContent = inProgressTasks.length;
  document.getElementById('doneColumnCount').textContent = doneTasks.length;
}

// 任务卡片上的「来源」标签：这个任务是从哪个需求拆出来的 / 从哪个 Bug 转来的（数据来自禅道，同步时带下来）
function originChipsHTML(task) {
  const chips = [];
  if (task.storyId) chips.push(`<a href="#" class="task-origin" data-origin="story" data-id="${escapeHtml(task.storyId)}" title="${escapeHtml(task.storyTitle || '来源需求')}（点击在禅道打开）">需求 #${escapeHtml(task.storyId)}</a>`);
  if (task.fromBug) chips.push(`<a href="#" class="task-origin" data-origin="bug" data-id="${escapeHtml(task.fromBug)}" title="来源 Bug（点击在禅道打开）">Bug #${escapeHtml(task.fromBug)}</a>`);
  return chips.join('');
}

// 创建任务卡片
function createTaskCard(task) {
  const card = document.createElement('div');
  card.className = 'task-card';
  card.dataset.taskId = task.id;
  card.draggable = true;

  // 获取优先级，默认为3
  const priority = task.priority ?? 3;

  // 优先级颜色映射
  const priorityColors = {
    1: { bg: 'rgba(239, 68, 68, 0.1)', border: '#ef4444', badge: '#ef4444' },  // 红色
    2: { bg: 'rgba(245, 158, 11, 0.1)', border: '#f59e0b', badge: '#f59e0b' },  // 黄色
    3: { bg: 'rgba(59, 130, 246, 0.1)', border: '#3b82f6', badge: '#3b82f6' },  // 蓝色
    4: { bg: 'rgba(156, 163, 175, 0.1)', border: '#9ca3af', badge: '#9ca3af' }   // 灰色
  };

  const color = priorityColors[priority] || priorityColors[3];

  // 设置优先级边框
  if (task.status !== 'done') {
    card.style.borderLeft = `3px solid ${color.border}`;
  }

  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', task.id);
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => card.classList.add('dragging'), 0);
  });

  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
  });

  // 点击选中任务（用于键盘删除）
  card.addEventListener('click', (e) => {
    // 如果点击的是复选框、按钮或链接，不处理选中
    if (e.target.matches('input, button, a, .priority-toggle, .task-reminder-btn')) {
      return;
    }
    // 移除之前的选中状态
    document.querySelectorAll('.task-card.selected').forEach(c => c.classList.remove('selected'));
    // 选中当前任务
    card.classList.add('selected');
    selectedTaskId = task.id;
  });

  const progress = task.progress ?? (task.status === 'done' ? 100 : (task.status === 'in_progress' ? 10 : 0));

  if (task.status === 'in_progress') {
    card.style.background = `linear-gradient(to right, rgba(99, 102, 241, 0.08) 0%, rgba(16, 185, 129, 0.15) ${progress}%, var(--bg-surface) ${progress}%)`;
  } else if (task.status === 'done') {
    card.style.background = '#f1f5f9';
  }

  let progressHTML = `
      <div class="task-progress">
        <div class="task-progress-bar">
          <div class="task-progress-track" data-task-id="${task.id}">
            <div class="task-progress-fill" style="width: ${progress}%"></div>
          </div>
          <input type="number" class="task-progress-input" value="${progress}" min="0" max="100" data-task-id="${task.id}">
          <span class="task-progress-value">%</span>
        </div>
      </div>
    `;

  // 优先级HTML - 下拉菜单选择（不显示当前优先级）
  const priorityHTML = task.status !== 'done' ? `
    <div class="priority-dropdown" style="position:relative;">
      <button class="priority-toggle" data-task-id="${task.id}" data-priority="${priority}"
        style="background:${color.bg}; color:${color.badge}; padding:4px 10px; border-radius:6px; font-size:11px; font-weight:600; border:none; cursor:pointer; transition:all 0.2s;"
        title="点击选择优先级">
        P${priority} <span style="margin-left:2px; font-size:8px;">▼</span>
      </button>
    </div>
  ` : '';

  // 同步状态角标：禅道同步中/ 失败未同步。状态存在 task.__sync 上，
  // 这样整表重渲染后角标不会丢（详见 optimistic.js）。
  const syncState = task.__sync;
  const syncBadgeHTML = syncState
    ? (syncState.state === 'syncing'
      ? `<span class="sync-state-badge syncing" title="${syncState.reason || '正在与禅道同步'}">同步中</span>`
      : `<span class="sync-state-badge failed" title="${escapeHtml(syncState.reason || '同步到禅道失败，点击「同步」重试')}">未同步</span>`)
    : '';

  card.innerHTML = `
    <div class="task-title" style="display: flex; align-items: flex-start; gap: 8px; width:100%;">
      <input type="checkbox" class="task-checkbox" data-task-id="${task.id}" ${task.status === 'done' ? 'checked' : ''} style="margin-top: 4px; cursor: pointer;">
      <div style="flex:1;">
        <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 4px;">
          <span class="task-title-text" data-task-id="${task.id}" title="点击编辑标题"
            style="cursor: pointer; padding: 2px 4px; border-radius: 4px; transition: background 0.2s;">
            ${escapeHtml(task.title)}
          </span>
          ${task.zentaoId
            ? `<a class="zentao-task-link" href="#" role="button" data-task-id="${task.zentaoId}" title="在禅道中打开 #${task.zentaoId}" style="color: #3b82f6; text-decoration: none; font-size: 12px; cursor: pointer;">#${task.zentaoId}</a>`
            : `<button class="sync-to-zentao-btn" data-task-id="${task.id}" style="background: #10b981; color: white; border: none; padding: 2px 6px; border-radius: 3px; font-size: 11px; cursor: pointer; transition: background 0.2s;" title="同步到禅道">同步</button>`
          }
          ${syncBadgeHTML}
          ${attachmentBadgeHTML(task)}
        </div>
        <button type="button" class="execution-tag execution-tag-btn${task.executionName ? '' : ' is-empty'}" data-exec-task="${escapeHtml(task.id)}" title="点击修改所属执行" style="margin-top: 4px;">${task.executionName ? escapeHtml(task.executionName) : '＋ 设置执行'}</button>
        ${originChipsHTML(task)}
        ${typeof timesLineHTML === 'function' ? timesLineHTML(...recordTimes(task)) : ''}
      </div>
      ${priorityHTML}
    </div>
    ${task.status !== 'done' ? `
    <div class="task-meta">
      <div class="task-reminder-container" style="display:flex; align-items:center;">
        <button class="task-reminder-btn" style="background:none;border:none;cursor:pointer;font-size:12px;color:#7f8c8d;padding:0;display:flex;align-items:center;gap:4px;" data-task-id="${task.id}" title="${task.status === 'in_progress' ? '设置截止时间' : '设置提醒时间'}">
          ⏰ <span class="reminder-text">${task.reminderTime ? new Date(task.reminderTime).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : (task.status === 'in_progress' ? '设置截止时间' : '设置提醒时间')}</span>
        </button>
      </div>
    </div>
    ` : ''
    }
    ${progressHTML}
  `;

  // 绑定复选框事件
  const checkbox = card.querySelector('.task-checkbox');
  if (checkbox) {
    checkbox.addEventListener('click', (e) => e.stopPropagation());
    checkbox.addEventListener('change', async (e) => {
      e.stopPropagation();
      const isChecked = e.target.checked;
      const newProgress = isChecked ? 100 : 0;
      const originalChecked = e.target.checked;
      const originalProgress = task.progress;

      // 临时修改任务进度，确保 updateTaskProgress 能检测到变化并弹框
      // 如果目标进度与当前进度相同，先设为不同的值
      if (task.progress === newProgress) {
        task.progress = newProgress === 100 ? 99 : 1;
      }

      // 调用更新进度，如果用户取消则恢复复选框状态和进度
      const result = await updateTaskProgress(task.id, newProgress);

      // updateTaskProgress 返回 false 表示用户取消
      if (result === false) {
        e.target.checked = !originalChecked; // 恢复复选框状态
        task.progress = originalProgress; // 恢复进度
      }
    });
  }

  // 绑定优先级下拉菜单事件
  const priorityBtn = card.querySelector('.priority-toggle');

  if (priorityBtn) {
    // 菜单挂载到 body（避免被 overflow 裁剪）。每次渲染卡片都重建：
    // 旧实现复用 body 上的菜单、却每次渲染都再绑一遍点击事件，渲染 N 次后点一下就发 N 次更新
    // （禅道按 lastEditedDate 拒绝并发编辑，于是报「同步失败」）；菜单选项也停留在第一次的优先级。
    document.querySelectorAll(`.priority-menu-${task.id}`).forEach(m => m.remove());
    const priorityMenu = document.createElement('div');
    priorityMenu.className = `priority-menu priority-menu-${task.id}`;
    priorityMenu.style.cssText = 'display:none; position:fixed; background:white; border:1px solid #e2e8f0; border-radius:6px; box-shadow:0 4px 12px rgba(0,0,0,0.15); z-index:99999; min-width:60px; padding:4px 0;';
    priorityMenu.innerHTML = `
      ${priority !== 1 ? `<div class="priority-option" data-priority="1" style="padding:6px 12px; cursor:pointer; font-size:12px; font-weight:500; color:#ef4444; text-align:center;">P1</div>` : ''}
      ${priority !== 2 ? `<div class="priority-option" data-priority="2" style="padding:6px 12px; cursor:pointer; font-size:12px; font-weight:500; color:#f59e0b; text-align:center;">P2</div>` : ''}
      ${priority !== 3 ? `<div class="priority-option" data-priority="3" style="padding:6px 12px; cursor:pointer; font-size:12px; font-weight:500; color:#3b82f6; text-align:center;">P3</div>` : ''}
      ${priority !== 4 ? `<div class="priority-option" data-priority="4" style="padding:6px 12px; cursor:pointer; font-size:12px; font-weight:500; color:#9ca3af; text-align:center;">P4</div>` : ''}
    `;
    document.body.appendChild(priorityMenu);

    // 绑定菜单选项事件
    priorityMenu.querySelectorAll('.priority-option').forEach(option => {
      option.addEventListener('click', (e) => {
        e.stopPropagation();
        const newPriority = parseInt(e.currentTarget.dataset.priority);
        updateTaskPriority(task.id, newPriority);
        priorityMenu.style.display = 'none';
      });
      option.addEventListener('mouseenter', () => {
        option.style.background = '#f1f5f9';
      });
      option.addEventListener('mouseleave', () => {
        option.style.background = 'transparent';
      });
    });

    // 点击按钮切换菜单显示
    priorityBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // 关闭其他所有菜单
      document.querySelectorAll('.priority-menu').forEach(m => {
        m.style.display = 'none';
      });

      if (priorityMenu.style.display === 'none' || !priorityMenu.style.display) {
        // 计算菜单位置（按钮下方）
        const rect = priorityBtn.getBoundingClientRect();
        priorityMenu.style.top = (rect.bottom + 2) + 'px';
        priorityMenu.style.left = rect.left + 'px';
        priorityMenu.style.display = 'block';
      } else {
        priorityMenu.style.display = 'none';
      }
    });
  }

  // 绑定进度条事件
  const progressTrack = card.querySelector('.task-progress-track');
  const progressFill = card.querySelector('.task-progress-fill');
  const progressInput = card.querySelector('.task-progress-input');
  const progressBar = card.querySelector('.task-progress-bar');

  if (progressTrack && progressFill && progressBar) {
    // 阻止进度条区域的拖拽事件冒泡到卡片
    progressBar.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      e.preventDefault();
    });

    // 鼠标按下开始拖拽
    const startDrag = (e) => {
      draggingProgressTask = task.id;
      draggingProgressElement = { progressTrack, progressFill, progressInput };
      // 保存原始进度值
      draggingProgressOriginalValue = task.progress ?? (task.status === 'done' ? 100 : (task.status === 'in_progress' ? 10 : 0));
      e.preventDefault(); // 阻止默认拖拽行为
      e.stopPropagation();
      document.body.style.cursor = 'ew-resize';
      progressTrack.style.cursor = 'ew-resize';
      updateProgressFromMouse(e);
    };

    progressTrack.addEventListener('mousedown', startDrag);
    progressFill.addEventListener('mousedown', startDrag);
  }

  // 输入框修改进度（保留手动输入功能）
  if (progressInput) {
    progressInput.addEventListener('change', (e) => {
      e.stopPropagation();
      let value = parseInt(e.target.value) || 0;
      value = Math.max(0, Math.min(100, value));
      updateTaskProgress(task.id, value);
    });

    // 输入框阻止冒泡
    progressInput.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  }

  // 绑定提醒时间事件
  const reminderBtn = card.querySelector('.task-reminder-btn');
  if (reminderBtn) {
    reminderBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openDatetimeModal(task);
    });
  }

  // 绑定标题点击编辑事件
  const titleText = card.querySelector('.task-title-text');
  if (titleText) {
    titleText.addEventListener('click', (e) => {
      e.stopPropagation();
      onTitleClick(e);
    });

    // 鼠标悬停效果
    titleText.addEventListener('mouseenter', () => {
      titleText.style.background = '#f1f5f9';
    });
    titleText.addEventListener('mouseleave', () => {
      titleText.style.background = 'transparent';
    });
  }

  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showTaskDetail(task);
  });

  // 任务 ID 链接点击事件 - 在扩展内展示详情（不再打开禅道标签页）
  // 禅道 ID：在浏览器里打开禅道任务页（自动登录）；插件内详情点卡片打开
  const taskLink = card.querySelector('.zentao-task-link');
  if (taskLink && task.zentaoId) {
    taskLink.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openInZentao('task', task.zentaoId);
    });
  }

  // 来源标签（需求 / Bug）：在禅道里打开
  card.querySelectorAll('.task-origin').forEach((chip) => {
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openInZentao(chip.dataset.origin, chip.dataset.id);
    });
  });

  // 同步到禅道按钮点击事件
  const syncBtn = card.querySelector('.sync-to-zentao-btn');
  if (syncBtn) {
    syncBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const taskId = syncBtn.dataset.taskId;
      await syncTaskToZentao(taskId, syncBtn);
    });

    // 鼠标悬停效果
    syncBtn.addEventListener('mouseenter', () => {
      syncBtn.style.background = '#059669';
    });
    syncBtn.addEventListener('mouseleave', () => {
      syncBtn.style.background = '#10b981';
    });
  }

  return card;
}

/**
 * 同步任务到禅道
 * @param {string} taskId - 任务 ID
 * @param {HTMLElement} syncBtn - 同步按钮元素
 */
/**
 * 恢复「同步」按钮的可点击状态
 *
 * 禅道操作失败时必须调用：按钮要回到「同步」可点状态，
 * 用户才能在处理完问题（配好禅道、选好执行）后一键重试。
 *
 * @param {HTMLButtonElement} syncBtn
 * @param {string} [label='同步']
 */
function restoreSyncBtn(syncBtn, label = '同步') {
  if (!syncBtn) return;
  syncBtn.disabled = false;
  syncBtn.textContent = label;
  syncBtn.style.background = '#10b981';
  syncBtn.style.cursor = 'pointer';
}

/**
 * 把本地任务同步到禅道（手动点「同步」按钮时调用）
 *
 * 行为约定：
 *   - 点击后立刻打「同步中」角标，按钮不再重复响应
 *   - 成功 → 角标消失，标题旁出现禅道 ID，Toast 报出该 ID
 *   - 失败 → 角标变「未同步」，按钮恢复可点，Toast 说明原因
 */
async function syncTaskToZentao(taskId, syncBtn) {
  const task = allTasks.find(t => String(t.id) === String(taskId));
  if (!task) {
    Toast.error('任务不存在');
    return;
  }

  console.log('[SyncToZentao] 开始同步任务到禅道:', task);

  await OptimisticUI.trackSync({
    taskId: taskId,
    successMessage: () => `已同步到禅道，任务ID: #${task.zentaoId}`,
    failureMessage: (res) => `同步失败：${OptimisticUI.explainFailure(res)}`,
    syncFn: async () => {
      // 调用 ZentaoBrowserClient 创建任务
      const result = await ZentaoBrowserClient.createTask({
        title: task.title,
        executionId: task.executionId,
        executionType: task.executionType,
        desc: task.content || task.title
      });
      // 兼容 taskId / zentaoId 两种字段
      const zentaoId = result && (result.zentaoId || result.taskId);
      return (result && result.success && zentaoId)
        ? { success: true, zentaoId }
        : { success: false, reason: result && result.reason, message: result && result.message };
    },
    onSuccess: async (result) => {
      const zentaoId = result.zentaoId;

      // 保存到后端
      await fetch(`${API_BASE_URL}/api/task/${taskId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ zentaoId })
      });

      // 更新本地任务并重渲染：角标在 trackSync 的 onSuccess 之后已清理
      OptimisticUI.patchTask(taskId, {
        zentaoId: zentaoId,
        zentaoExecution: task.executionId
      });
    }
  });
}

// 更新计数
function updateCounts() {
  document.getElementById('todoColumnCount').textContent = allTasks.filter(t => t.status === 'todo').length;
  document.getElementById('inProgressColumnCount').textContent = allTasks.filter(t => t.status === 'in_progress').length;
  document.getElementById('doneColumnCount').textContent = allTasks.filter(t => t.status === 'done').length;
}

// 获取并更新统计数据
async function updateTaskStats() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/stats`);
    const result = await response.json();
    if (result.success) {
      document.getElementById('weekDone').textContent = result.data.weekDone || 0;
      document.getElementById('monthDone').textContent = result.data.monthDone || 0;
      document.getElementById('streak').textContent = result.data.streak || 0;
    }
  } catch (err) {
    console.warn('获取统计数据失败:', err);
  }
}

// 显示空状态
function showEmptyState() {
  const emptyHTML = `
    <div class="empty-state">
      <div class="empty-state-icon">📝</div>
      <p>暂无任务</p>
    </div>
  `;
  document.getElementById('todoList').innerHTML = emptyHTML;
  document.getElementById('inProgressList').innerHTML = emptyHTML;
  document.getElementById('doneList').innerHTML = emptyHTML;
}

let isAddingTask = false;

// ==================== 任务弹框管理 ====================

/**
 * 初始化任务弹框事件监听器
 */
async function initTaskModal() {
  // 关闭按钮
  const closeBtn = document.getElementById('closeTaskCreateModal');
  if (closeBtn) {
    closeBtn.addEventListener('click', requestCloseTaskModal);
  }

  // 取消按钮
  const cancelBtn = document.getElementById('cancelTaskCreateBtn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', requestCloseTaskModal);
  }

  // 点击弹框外部关闭
  const taskModal = document.getElementById('taskCreateModal');
  if (taskModal) {
    taskModal.addEventListener('click', (e) => {
      if (e.target === taskModal) {
        requestCloseTaskModal();
      }
    });
  }

  // 提交按钮
  const submitBtn = document.getElementById('submitTaskCreateBtn');
  if (submitBtn) {
    submitBtn.addEventListener('click', submitTaskFromModal);
  }

  // ESC 键关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const modal = document.getElementById('taskCreateModal');
      // 确认框开着时 Esc 交给确认框，不连带关掉弹窗
      if (modal && modal.style.display === 'flex' && !document.querySelector('#confirmDialog.active')) {
        requestCloseTaskModal();
      }
    }
  });

  // 加载执行列表
  await loadExecutionOptions();

  // 初始化指派人和抄送人的 multi-select（页面初始化阶段无 initialData）
  await initTaskUserSelects();

  // 附件选择区：可在弹窗任意位置粘贴截图
  const attachmentsHost = document.getElementById('taskAttachments');
  if (attachmentsHost && typeof AttachmentPicker !== 'undefined') {
    taskAttachmentPicker = new AttachmentPicker(attachmentsHost);
    taskAttachmentPicker.bindPaste(taskModal);
  }

  // 记录用户亲手改过的字段：识别结果晚到时不覆盖这些字段
  TASK_INTAKE_FIELDS.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const mark = () => { if (taskIntakeSession) taskIntakeSession.touched.add(id); };
    el.addEventListener('input', mark);
    el.addEventListener('change', mark);
  });

  // 草稿自动保存
  const taskInputs = ['taskTitle', 'taskDescription', 'taskExecution', 'taskPriority', 'taskProgress', 'taskDueDate'];
  taskInputs.forEach(id => {
    const input = document.getElementById(id);
    if (input) {
      input.addEventListener('input', saveTaskDraft);
      input.addEventListener('change', saveTaskDraft);
    }
  });

  // 加载草稿
  loadTaskDraft();
}

/**
 * 显示任务弹框
 * @param {Object} initialData - 初始数据（可选）
 */
async function showTaskModal(initialData = {}) {
  const modal = document.getElementById('taskCreateModal');
  if (!modal) return;

  // 先加载执行列表（等待完成）
  await loadExecutionOptions();

  // 每次打开都重置指派人组件，再按 initialData / 默认账号填入，
  // 否则上一次打开时残留的选择会带到这一次。
  await initTaskUserSelects(initialData);

  // 如果有初始数据，填充表单
  if (initialData.title) {
    document.getElementById('taskTitle').value = initialData.title;
  }
  if (initialData.description) {
    document.getElementById('taskDescription').value = initialData.description;
  }
  if (initialData.executionId) {
    document.getElementById('taskExecution').value = initialData.executionId;
    console.log('[TaskModal] 预选执行ID:', initialData.executionId);
  }
  // 显式传入（含默认值）时必须覆盖，否则会残留上一次打开时的值
  if ('priority' in initialData) {
    document.getElementById('taskPriority').value = initialData.priority || 3;
  }
  // 进度：AI 明确识别出进度才填，否则一律归 0。
  // 这里必须「无条件赋值」而不能只在有值时赋值 ——
  // 否则 AI 失败/未识别时，表单会残留上一次打开时的进度值，
  // 用户看到的就是一个凭空出现的 10%/50%。
  document.getElementById('taskProgress').value = Number.isFinite(initialData.progress)
    ? initialData.progress
    : 0;
  if ('dueDate' in initialData) {
    document.getElementById('taskDueDate').value = toDueDateTimeLocal(initialData.dueDate);
  }

  modal.style.display = 'flex';

  // 聚焦到标题输入框
  setTimeout(() => {
    const titleInput = document.getElementById('taskTitle');
    if (titleInput && !initialData.title) {
      titleInput.focus();
    }
  }, 100);
}

/**
 * 隐藏任务弹框
 */
function hideTaskModal() {
  const modal = document.getElementById('taskCreateModal');
  if (modal) {
    modal.style.display = 'none';
  }
  // 关闭即放弃本次识别：晚到的识别结果不会再回填，也不会落库
  taskIntakeSession = null;
  setTaskAiStatus(null);
  if (taskAttachmentPicker) taskAttachmentPicker.clear();
}

/**
 * 用户主动关闭新建任务弹窗（关闭按钮 / 取消 / 遮罩 / Esc）：已添加附件时先确认，避免截图白截
 */
async function requestCloseTaskModal() {
  const count = taskAttachmentPicker ? taskAttachmentPicker.count : 0;
  if (count > 0) {
    const ok = await Confirm.show('放弃附件？', `已添加 ${count} 个附件，关闭后不会保存。`, '关闭', '继续编辑');
    if (!ok) return;
  }
  hideTaskModal();
}

/**
 * 执行列表缓存
 *
 * 本函数在每次打开「添加任务」弹窗时都会跑，不加缓存就会反复打后端。
 * 缓存只活在这一页里，刷新即失效；TTL 兜住「刚在禅道建了执行」的场景。
 */
let executionOptionsCache = { list: null, at: 0 };
const EXECUTION_CACHE_TTL = 3 * 60 * 1000;

/**
 * 带超时的 JSON 请求
 *
 * 执行列表有两个数据源，其中「实时拉禅道」要先连内网再解析 HTML，
 * 内网不通时能挂住好几秒 —— 而 loadExecutionOptions() 是在弹窗显示前
 * 被 await 的，一挂住用户就会觉得「点了没反应」。这里统一加个上限。
 */
async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 加载执行选项列表
 *
 * 数据源是「后端用配置里的禅道账号拉到的全部执行」，不再依赖用户收藏 ——
 * 旧实现只读 /api/executions/favorites，收藏一空下拉就只剩「自动选择」，
 * 等于把这个功能关掉了。
 *
 * 取数顺序按「快 → 慢」排：
 *   1. 内存缓存（3 分钟）—— 弹窗反复开关时不重复请求
 *   2. /api/executions —— 后端已同步的全量执行清单，本地命中，毫秒级
 *   3. /api/zentao/executions —— 内网实时拉取，仅当本地清单为空时兜底
 * 实时接口在禅道不可达时会静默返回空数组（success 仍为 true），
 * 所以不能把它放在首选，否则每次打开弹窗都要白等一轮超时。
 */
async function loadExecutionOptions() {
  const select = document.getElementById('taskExecution');
  if (!select) return;

  let executions = [];

  if (executionOptionsCache.list && Date.now() - executionOptionsCache.at < EXECUTION_CACHE_TTL) {
    executions = executionOptionsCache.list;
  } else {
    // 2) 本地全量执行清单（后端从禅道同步而来）
    try {
      const result = await fetchJsonWithTimeout(`${API_BASE_URL}/api/executions`, 4000);
      if (result.success && Array.isArray(result.data)) executions = result.data;
    } catch (err) {
      console.warn('[TaskModal] 读取本地执行清单失败:', err.message);
    }

    // 3) 本地清单为空时才去实时拉禅道（需要内网可达，慢）
    if (executions.length === 0) {
      try {
        const result = await fetchJsonWithTimeout(`${API_BASE_URL}/api/zentao/executions`, 8000);
        if (result.success && Array.isArray(result.data)) executions = result.data;
      } catch (err) {
        console.error('[TaskModal] 实时拉取禅道执行列表失败:', err.message);
      }
    }

    if (executions.length > 0) {
      executionOptionsCache = { list: executions, at: Date.now() };
    }
  }

  select.innerHTML = '<option value="">自动选择 (AI分析)</option>';

  executions.forEach(exec => {
    const option = document.createElement('option');
    option.value = exec.id;
    // 全部执行里必然混着已关闭的，标出来免得选错
    const project = exec.projectName ? ` (${exec.projectName})` : '';
    const closed = exec.status === 'closed' ? '（已关闭）' : '';
    option.textContent = `${exec.name}${project}${closed}`;
    select.appendChild(option);
  });

  console.log('[TaskModal] 执行候选数量:', executions.length);
}

/**
 * 初始化任务弹框的指派人和抄送人多选组件
 * @param {Object} initialData - 弹框初始数据（可含 assignedToList）
 */
async function initTaskUserSelects(initialData = {}) {
  // 获取用户列表
  let users = await ZentaoBrowserClient.getUsers();
  console.log('[TaskModal] 缓存的用户数量:', users ? Object.keys(users).length : 0);

  if (!users || Object.keys(users).length === 0) {
    console.warn('[TaskModal] 用户列表未加载，尝试从禅道加载...');
    try {
      await ZentaoBrowserClient.refreshUsersFromZentao();
      users = await ZentaoBrowserClient.getUsers();
      console.log('[TaskModal] 从禅道加载后的用户数量:', users ? Object.keys(users).length : 0);
    } catch (err) {
      console.warn('[TaskModal] 无法加载用户列表:', err);
    }
  }

  if (!users || Object.keys(users).length === 0) {
    console.warn('[TaskModal] 无法获取用户列表，跳过用户选择器初始化');
    return;
  }

  // 初始化指派人多选组件
  initTaskMultiSelect('taskAssignee', users);

  // 初始化抄送人多选组件
  initTaskMultiSelect('taskCc', users);

  // 默认指派人：优先用草稿/初始数据，否则用当前禅道登录账号
  let defaultAssignee = initialData.assignedToList && initialData.assignedToList.length
    ? initialData.assignedToList
    : null;

  if (!defaultAssignee) {
    const me = await getCurrentZentaoAccount();
    if (me && Object.prototype.hasOwnProperty.call(users, me)) {
      defaultAssignee = [me];
      console.log('[TaskModal] 默认指派给当前禅道账号:', me, users[me]);
    } else {
      console.log('[TaskModal] 未取到当前禅道账号或该账号不在用户列表中，指派人留空');
    }
  }

  if (defaultAssignee) {
    setTaskMultiSelectValues('taskAssignee', defaultAssignee);
  }

  // 草稿里可能有抄送人
  if (initialData.ccList && initialData.ccList.length) {
    setTaskMultiSelectValues('taskCc', initialData.ccList);
  }

  console.log('[TaskModal] 用户选择器初始化完成');
}

/**
 * 初始化任务弹框的多选组件（指派人/抄送人）
 * @param {string} fieldId - 字段 ID（taskAssignee 或 taskCc）
 * @param {Object} users - 用户列表 {account: name}
 */
function initTaskMultiSelect(fieldId, users) {
  const container = document.getElementById(`${fieldId}Container`);
  const display = document.getElementById(`${fieldId}Display`);
  const dropdown = document.getElementById(`${fieldId}Dropdown`);
  const optionsContainer = document.getElementById(`${fieldId}Options`);

  if (!container || !display || !dropdown || !optionsContainer) {
    console.error(`[TaskModal] 多选组件元素不存在: ${fieldId}`);
    return;
  }

  // 每次打开弹窗都会重新初始化：先撤掉上一次绑定的监听，避免同一元素上越绑越多
  const listenerSignal = resetListenerScope(container);

  // 存储选中的用户
  const selectedUsers = new Set();

  // 生成用户选项
  const renderOptions = () => {
    optionsContainer.innerHTML = '';

    if (Object.keys(users).length === 0) {
      optionsContainer.innerHTML = '<div class="multi-select-no-data">暂无用户数据</div>';
      return;
    }

    Object.entries(users).forEach(([account, name]) => {
      const option = document.createElement('div');
      option.className = 'multi-select-option';
      if (selectedUsers.has(account)) {
        option.classList.add('selected');
      }

      option.innerHTML = `
        <div class="multi-select-option-text">
          ${name}
          <span class="multi-select-option-account">(${account})</span>
        </div>
        <div class="multi-select-option-check"></div>
      `;

      option.addEventListener('click', (e) => {
        e.stopPropagation();
        if (selectedUsers.has(account)) {
          selectedUsers.delete(account);
          option.classList.remove('selected');
        } else {
          selectedUsers.add(account);
          option.classList.add('selected');
        }
        updateTaskMultiSelectDisplay(fieldId, selectedUsers, users);
      }, { signal: listenerSignal });

      optionsContainer.appendChild(option);
    });
  };

  // 更新显示区域
  updateTaskMultiSelectDisplay(fieldId, selectedUsers, users);

  // 点击显示/隐藏下拉列表
  display.addEventListener('click', (e) => {
    if (!e.target.closest('.multi-select-tag-remove')) {
      const isVisible = dropdown.style.display !== 'none';
      dropdown.style.display = isVisible ? 'none' : 'block';
      display.classList.toggle('active', !isVisible);
    }
  }, { signal: listenerSignal });

  // 点击其他地方关闭下拉
  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) {
      dropdown.style.display = 'none';
      display.classList.remove('active');
    }
  }, { signal: listenerSignal });

  // 初始化渲染选项
  renderOptions();

  // 保存引用以便后续访问
  container._selectedUsers = selectedUsers;
  container._users = users;
  // 保存渲染函数，setTaskMultiSelectValues 需要重新渲染选中态
  container._renderOptions = renderOptions;
}

/**
 * 设置任务弹框多选组件的选中值
 * @param {string} fieldId - taskAssignee / taskCc
 * @param {Array<string>} accounts - 要选中的账号数组
 */
function setTaskMultiSelectValues(fieldId, accounts) {
  const container = document.getElementById(`${fieldId}Container`);
  if (!container || !container._selectedUsers || !container._users) return false;

  const users = container._users;
  const set = container._selectedUsers;

  set.clear();
  (accounts || []).forEach(acc => {
    // 只有确实存在于用户列表中的账号才选中，避免显示成裸账号
    if (acc && Object.prototype.hasOwnProperty.call(users, acc)) {
      set.add(acc);
    }
  });

  if (container._renderOptions) container._renderOptions();
  updateTaskMultiSelectDisplay(fieldId, set, users);
  return true;
}

/**
 * 读取当前禅道登录账号，作为任务指派人的默认值
 *
 * 绝大多数情况下任务就是指派给自己，默认填好可以少一次手动选择。
 * @returns {Promise<string|null>} 账号，找不到返回 null
 */
let _currentZentaoAccountCache = null;

async function getCurrentZentaoAccount() {
  if (_currentZentaoAccountCache) return _currentZentaoAccountCache;
  try {
    const resp = await fetch(`${API_BASE_URL}/api/zentao/config`);
    const json = await resp.json();
    const username = json && json.success && json.data && json.data.username;
    if (username) {
      _currentZentaoAccountCache = username;
      return username;
    }
  } catch (e) {
    console.warn('[TaskModal] 获取当前禅道账号失败:', e.message);
  }
  return null;
}

/**
 * 更新任务弹框多选组件的显示区域
 * @param {string} fieldId - 字段 ID
 * @param {Set} selectedUsers - 选中的用户集合
 * @param {Object} users - 用户列表
 */
function updateTaskMultiSelectDisplay(fieldId, selectedUsers, users) {
  const display = document.getElementById(`${fieldId}Display`);
  if (!display) return;

  if (selectedUsers.size === 0) {
    display.innerHTML = '<span class="multi-select-placeholder">请选择用户</span>';
  } else {
    display.innerHTML = '';
    selectedUsers.forEach(account => {
      const name = users[account] || account;
      const tag = document.createElement('span');
      tag.className = 'multi-select-tag';
      tag.innerHTML = `
        ${name}
        <span class="multi-select-tag-remove" data-account="${account}">×</span>
      `;

      // 点击移除标签
      tag.querySelector('.multi-select-tag-remove').addEventListener('click', (e) => {
        e.stopPropagation();
        selectedUsers.delete(account);
        updateTaskMultiSelectDisplay(fieldId, selectedUsers, users);

        // 更新选项的选中状态
        const container = document.getElementById(`${fieldId}Container`);
        if (container && container._selectedUsers) {
          container._selectedUsers = selectedUsers;
        }
      });

      display.appendChild(tag);
    });
  }
}

/**
 * 获取任务弹框中选中的用户
 * @param {string} fieldId - 字段 ID（taskAssignee 或 taskCc）
 * @returns {Array} 选中的用户账号列表
 */
function getTaskSelectedUsers(fieldId) {
  const container = document.getElementById(`${fieldId}Container`);
  if (!container || !container._selectedUsers) {
    return [];
  }
  return Array.from(container._selectedUsers);
}

/**
 * 从弹框提交任务
 */
async function submitTaskFromModal() {
  const session = taskIntakeSession;

  // 识别还没回来、执行又留在「自动选择」：等识别结果（最多 8 秒），
  // 否则会直接落到默认执行。用户自己选了执行就不用等。
  const execSelect = document.getElementById('taskExecution');
  if (session && session.pending && !session.settled && execSelect && !execSelect.value) {
    const restoreWait = ButtonStateManager.setLoading('submitTaskCreateBtn', { loadingText: '等待识别…' });
    await Promise.race([session.pending, new Promise(resolve => setTimeout(resolve, TASK_SUBMIT_WAIT_MS))]);
    restoreWait();
    if (taskIntakeSession !== session) return; // 等待期间弹窗被关掉了
  }

  const title = document.getElementById('taskTitle').value.trim();
  const description = document.getElementById('taskDescription').value.trim();
  const executionId = document.getElementById('taskExecution').value;
  const priority = parseInt(document.getElementById('taskPriority').value) || 3;
  const progress = parseInt(document.getElementById('taskProgress').value) || 0;
  const dueDate = document.getElementById('taskDueDate').value;

  // 根据进度自动计算状态
  let status = 'todo';
  if (progress > 0 && progress < 100) {
    status = 'in_progress';
  } else if (progress === 100) {
    status = 'done';
  }

  // 获取指派人和抄送人
  const assignees = getTaskSelectedUsers('taskAssignee');
  const ccUsers = getTaskSelectedUsers('taskCc');

  // 表单验证
  if (!title) {
    Toast.warning('请输入任务标题');
    return;
  }

  // 使用 ButtonStateManager 管理按钮状态
  const restoreButton = ButtonStateManager.setLoading('submitTaskCreateBtn', {
    loadingText: '提交中...'
  });

  try {
    // 构建任务内容（标题 + 描述）
    const content = description ? `${title}\n\n${description}` : title;

    console.log('[TaskModal] ========== 开始创建任务 ==========');
    console.log('[TaskModal] 任务标题:', title);
    console.log('[TaskModal] 执行ID:', executionId || '(AI自动选择)');
    console.log('[TaskModal] 优先级:', priority);
    console.log('[TaskModal] 进度:', progress);
    console.log('[TaskModal] 状态（自动计算）:', status);
    console.log('[TaskModal] 指派人:', assignees);
    console.log('[TaskModal] 抄送人:', ccUsers);

    // 调用 API 创建任务
    const response = await fetch(`${API_BASE_URL}/api/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        // 带 title = 弹窗提交：后端直接用表单值落库，不再调用大模型
        title,
        executionId: executionId || undefined,
        // 只有用户亲手选/改的执行才记入学习库，单纯采纳识别建议不算
        executionPickedByUser: session
          ? !!session.userExecutionId || session.touched.has('taskExecution')
          : !!executionId,
        // 预览阶段的识别结果（提醒时间、工期等表单里没有的字段）
        analysis: session && session.analysis ? session.analysis : undefined,
        priority,
        status,
        progress,
        dueDate: dueDate || undefined,
        assignees: assignees.length > 0 ? assignees : undefined,
        cc: ccUsers.length > 0 ? ccUsers : undefined
      })
    });

    const result = await response.json();

    if (result.success) {
      const task = result.data;
      // 先取出附件（关闭弹窗会清空选择区）
      const attachmentItems = taskAttachmentPicker ? taskAttachmentPicker.getItems() : [];

      // —— 乐观 UI：本地任务已落库，立刻上屏并关掉表单 ——
      // 禅道同步是 1~3 秒级的慢操作，放在后台跑，不阻塞用户下一步动作。
      allTasks.push(task);
      renderTasks();
      clearTaskDraft();
      hideTaskModal();
      Toast.success('任务已创建，正在同步到禅道…');

      // 后台同步日历（同样不阻塞界面）
      loadCalendar().catch(err => console.warn('[TaskModal] 日历刷新失败:', err));

      // —— 后台：先把附件存进本地附件区，再同步禅道 ——
      // 任务拿到禅道 ID 后，后端会把附件推送上去（截图同时插进任务描述）
      const attachmentsSaved = attachmentItems.length
        ? AttachmentApi.uploadAll(task.id, attachmentItems, { inline: true }).then(({ failed }) => {
          if (failed.length) Toast.error(`${failed.length} 个附件添加失败：${failed.map(f => f.message).join('；')}`, 6000);
        }).catch(err => Toast.error(`附件添加失败：${err.message}`, 6000))
        : Promise.resolve();
      attachmentsSaved.finally(async () => {
        await syncNewTaskToZentao(task, {
          executionId,
          priority,
          dueDate,
          assignees,
          ccUsers
        });
        // 带附件的：任务拿到禅道 ID 后后端开始推送附件，刷新一次列表，
        // 角标显示「上传中」并由观察器在推送结束后再刷新
        if (attachmentItems.length) loadTasks().catch(() => { });
      });
    } else {
      Toast.error(result.error || '创建任务失败');
    }
  } catch (err) {
    console.error('[TaskModal] 创建任务失败:', err);
    Toast.error('创建任务失败: ' + err.message);
  } finally {
    // 按钮一定恢复：本地保存完成后立刻恢复，禅道同步不再占用按钮
    restoreButton();
  }
}

/**
 * 后台把新建的本地任务同步到禅道
 *
 * 与用户界面的关系：
 *   - 同步中：卡片显示「同步中」角标
 *   - 成功：角标消失，标题旁出现禅道任务 ID（#1234），可点击跳转
 *   - 失败：角标变「未同步」，卡片保留「同步」按钮 + Toast 说明原因
 *
 * @param {object} task 后端返回的本地任务对象
 * @param {object} formData 表单里用户填的禅道相关字段
 */
async function syncNewTaskToZentao(task, formData = {}) {
  const { executionId, priority, dueDate, assignees, ccUsers } = formData;

  try {
    await ZentaoBrowserClient.initConfig();
    if (!ZentaoBrowserClient.isConfigured()) {
      // 没配置禅道不是错误 —— 任务本地已建好，卡片保留「同步」按钮即可
      OptimisticUI.patchTask(task.id, { __sync: null });
      return;
    }

    console.log('[TaskModal] 后台同步禅道任务...');
    console.log('[TaskModal] 用户选择的执行ID:', executionId);

    const zentaoResult = await ZentaoBrowserClient.createTask({
      executionId: executionId || task.executionId,
      title: task.title,
      desc: task.content,
      priority: priority,
      assignedTo: assignees && assignees.length > 0 ? assignees[0] : undefined,
      cc: ccUsers && ccUsers.length > 0 ? ccUsers : undefined,
      dueDate: dueDate || undefined
    });

    // 兼容两种返回形态：{ success, taskId } 或裸数字
    const zentaoId = (zentaoResult && typeof zentaoResult === 'object')
      ? zentaoResult.taskId
      : zentaoResult;

    if (!zentaoResult || !zentaoResult.success || !zentaoId) {
      const reason = OptimisticUI.explainFailure(zentaoResult);
      OptimisticUI.setCardSyncState(task.id, 'failed', reason);

      let msg = `任务已创建，但同步禅道失败：${reason}`;
      if (zentaoResult && zentaoResult.reason === 'invalid_execution_id') {
        msg = '任务已创建，但未同步到禅道：请选择「所属执行」后点同步';
      }
      Toast.error(msg);
      return;
    }

    // 成功：写回后端并更新界面
    await fetch(`${API_BASE_URL}/api/task/${task.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zentaoId })
    });

    OptimisticUI.setCardSyncState(task.id, 'idle');
    OptimisticUI.patchTask(task.id, { zentaoId, zentaoExecution: executionId || task.executionId });
    Toast.success(`已同步到禅道，任务 ID：#${zentaoId}`);
    console.log('[TaskModal] ✓ 禅道同步成功，ID:', zentaoId);
  } catch (err) {
    console.warn('[TaskModal] 后台同步禅道失败:', err);
    OptimisticUI.setCardSyncState(task.id, 'failed', err.message || '网络异常');
    Toast.error(`任务已创建，但同步禅道失败：${err.message}`);
  }
}

/**
 * 保存任务草稿
 */
function saveTaskDraft() {
  const draft = {
    title: document.getElementById('taskTitle').value,
    description: document.getElementById('taskDescription').value,
    executionId: document.getElementById('taskExecution').value,
    priority: document.getElementById('taskPriority').value,
    status: document.getElementById('taskStatus').value,
    progress: document.getElementById('taskProgress').value,
    dueDate: document.getElementById('taskDueDate').value,
    savedAt: new Date().toISOString()
  };

  localStorage.setItem('taskDraft', JSON.stringify(draft));

  const savedEl = document.getElementById('taskDraftSaved');
  if (savedEl) {
    savedEl.style.display = 'inline';
    setTimeout(() => {
      savedEl.style.display = 'none';
    }, 2000);
  }
}

/**
 * 加载任务草稿
 */
function loadTaskDraft() {
  const draftStr = localStorage.getItem('taskDraft');
  if (!draftStr) return;

  try {
    const draft = JSON.parse(draftStr);

    // 检查草稿是否过期（24小时）
    const savedAt = new Date(draft.savedAt);
    const now = new Date();
    const hoursDiff = (now - savedAt) / (1000 * 60 * 60);

    if (hoursDiff > 24) {
      clearTaskDraft();
      return;
    }

    // 填充表单
    if (draft.title) document.getElementById('taskTitle').value = draft.title;
    if (draft.description) document.getElementById('taskDescription').value = draft.description;
    if (draft.executionId) document.getElementById('taskExecution').value = draft.executionId;
    if (draft.priority) document.getElementById('taskPriority').value = draft.priority;
    if (draft.status) document.getElementById('taskStatus').value = draft.status;
    if (draft.progress) document.getElementById('taskProgress').value = draft.progress;
    if (draft.dueDate) document.getElementById('taskDueDate').value = draft.dueDate;
  } catch (err) {
    console.error('[TaskModal] 加载草稿失败:', err);
    clearTaskDraft();
  }
}

/**
 * 清除任务草稿
 */
function clearTaskDraft() {
  localStorage.removeItem('taskDraft');
}

// ==================== 原有任务添加逻辑 ====================

// 添加任务
/**
 * 新建任务弹窗的识别会话
 *
 * 流程：回车 → 弹窗立即打开（原文先填进标题）→ 后台调用预览接口识别 →
 * 结果回来后只填用户**还没动过**的字段。确认时才落库，取消即真的取消。
 *
 * touched：用户亲手改过的字段 id。程序赋值不会触发 input/change 事件，
 * 所以只有真实的用户操作会被记进来。
 */
let taskIntakeSession = null;
/** 新建任务弹窗的附件选择区（initTaskModal 里创建） */
let taskAttachmentPicker = null;
const TASK_INTAKE_FIELDS = ['taskTitle', 'taskDescription', 'taskExecution', 'taskPriority', 'taskProgress', 'taskDueDate'];
const TASK_PREVIEW_TIMEOUT_MS = 12000;
const TASK_SUBMIT_WAIT_MS = 8000;

function setTaskAiStatus(kind, text) {
  const el = document.getElementById('taskAiStatus');
  if (!el) return;
  if (!kind) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.className = `task-ai-status is-${kind}`;
  el.textContent = text;
}

/** 把识别结果填入未被用户改过的字段，并短暂高亮被填的字段 */
function fillUntouchedTaskField(session, id, value) {
  if (value === undefined || value === null || value === '') return false;
  if (session.touched.has(id)) return false;
  const el = document.getElementById(id);
  if (!el || String(el.value) === String(value)) return false;
  if (el.tagName === 'SELECT' && !Array.from(el.options).some(o => o.value === String(value))) return false;
  el.value = value;
  el.classList.add('task-ai-filled');
  setTimeout(() => el.classList.remove('task-ai-filled'), 1500);
  return true;
}

/**
 * 截止日期 → datetime-local 输入框能接受的值（YYYY-MM-DDTHH:mm）
 *
 * 识别结果只有日期（YYYY-MM-DD），直接塞给 datetime-local 会被浏览器静默丢弃，
 * 截止日期就永远预填不上。补上时刻：同一天有提醒时间就用提醒时刻，否则按 18:00 下班前。
 */
function toDueDateTimeLocal(dueDate, reminderTime) {
  if (!dueDate) return '';
  const str = String(dueDate);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(str)) return str.slice(0, 16);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return '';
  if (reminderTime) {
    const d = new Date(reminderTime);
    const p = (n) => String(n).padStart(2, '0');
    if (!Number.isNaN(d.getTime()) && `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` === str) {
      return `${str}T${p(d.getHours())}:${p(d.getMinutes())}`;
    }
  }
  return `${str}T18:00`;
}

/** 识别来源 → 状态条文案 */
function describeTaskPreview(result) {
  const s = result.suggestion;
  const execText = s && s.executionName
    ? `执行「${s.executionName}」`
    : '未识别到执行，保存时使用默认执行';
  switch (result.source) {
    case 'ai':
      return { kind: 'ok', text: `✨ AI 已识别：${execText}。已自动填入你没改过的字段` };
    case 'local':
      if (!result.aiAvailable) {
        return { kind: 'fallback', text: `AI 未配置，已按本地规则识别时间、优先级和进度；${execText}` };
      }
      return { kind: 'ok', text: `⚡ 已根据${s && s.matchedBy === 'learning' ? '历史记录' : s && s.matchedBy === 'user' ? '你选择的执行' : '关键词'}快速识别：${execText}` };
    case 'ai-timeout':
      return { kind: 'fallback', text: `AI 响应超时，已按本地规则识别；${execText}，请检查后提交` };
    default:
      return { kind: 'fallback', text: `AI 识别失败，已按本地规则识别；${execText}，请检查后提交` };
  }
}

/**
 * 后台请求识别结果并回填
 * @param {Object} session
 * @param {{localOnly?: boolean}} [opts] - localOnly：只要本地规则结果（毫秒级），用于先秒填
 * @returns {Promise<Object|null>} 识别结果；失败或会话已失效返回 null
 */
async function runTaskPreview(session, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TASK_PREVIEW_TIMEOUT_MS);
  try {
    const resp = await fetch(`${API_BASE_URL}/api/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: session.content,
        executionId: session.userExecutionId || undefined,
        preview: true,
        localOnly: !!opts.localOnly
      }),
      signal: controller.signal
    });
    const result = await resp.json();
    if (taskIntakeSession !== session) return null; // 弹窗已关闭或已开始新的一次
    if (!result.success) throw new Error(result.error || '识别失败');

    session.analysis = result.analysis || null;
    session.suggestion = result.suggestion || null;
    session.source = result.source;

    const a = result.analysis || {};
    fillUntouchedTaskField(session, 'taskTitle', a.title);
    fillUntouchedTaskField(session, 'taskPriority', a.priority);
    if (Number.isFinite(a.progress) && a.progress > 0) fillUntouchedTaskField(session, 'taskProgress', a.progress);
    fillUntouchedTaskField(session, 'taskDueDate', toDueDateTimeLocal(a.dueDate, a.reminderTime));
    if (!session.userExecutionId && result.suggestion) {
      fillUntouchedTaskField(session, 'taskExecution', result.suggestion.executionId);
    }

    const { kind, text } = describeTaskPreview(result);
    if (result.aiPending) {
      // 本地结果先填上了，AI 还在路上：保持「识别中」样式
      const execText = result.suggestion && result.suggestion.executionName ? `（执行「${result.suggestion.executionName}」）` : '';
      setTaskAiStatus('loading', `⚡ 已按本地规则快速填入${execText}，AI 正在补充…`);
    } else {
      setTaskAiStatus(kind, text);
    }
    if (result.aiError) console.warn('[AddTask] AI 识别降级:', result.aiError);

    // 低置信度：让用户确认执行归属（用户已经自己选了执行就不打扰）
    if (result.needConfirm && Array.isArray(result.candidates) && result.candidates.length > 0 &&
        !session.touched.has('taskExecution')) {
      try {
        const picked = await AiConfirmDialog.show(
          '确认任务归属',
          'AI 无法确定这条任务属于哪个执行，请选择：',
          result.candidates,
          document.getElementById('taskExecution')?.value || ''
        );
        if (picked && taskIntakeSession === session) {
          const selectEl = document.getElementById('taskExecution');
          if (selectEl) {
            selectEl.value = picked.id;
            selectEl.dispatchEvent(new Event('change', { bubbles: true }));
          }
          setTaskAiStatus('ok', `已选择执行「${picked.name}」，提交后会记住，下次同类任务自动匹配`);
        }
      } catch (e) {
        console.warn('[AddTask] 归属确认取消:', e.message);
      }
    }
    return result;
  } catch (err) {
    if (taskIntakeSession !== session) return null;
    console.warn('[AddTask] 识别失败:', err.message);
    setTaskAiStatus('error', err.name === 'AbortError'
      ? '识别超时，请手动填写；保存时会按默认执行处理'
      : '识别失败，请手动填写；保存时会按默认执行处理');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 打开空白的新建任务表单（手动填写，不做识别） */
async function openBlankTaskModal() {
  taskIntakeSession = null;
  setTaskAiStatus(null);
  await showTaskModal();
}

async function addTask() {
  const input = document.getElementById('taskInput');
  const content = input.value.trim();

  // 弹框已打开时再次触发 = 关闭
  const taskModal = document.getElementById('taskCreateModal');
  if (taskModal && taskModal.style.display === 'flex') {
    await requestCloseTaskModal();
    return;
  }

  if (!content) {
    // 输入框为空：直接打开空白弹框
    await openBlankTaskModal();
    return;
  }

  const selectedExecutionId = ExecutionSelector.getSelectedExecution();
  input.value = '';

  const session = {
    content,
    userExecutionId: selectedExecutionId || '',
    touched: new Set(),
    analysis: null,
    suggestion: null,
    source: null,
    pending: null,
    settled: false
  };
  taskIntakeSession = session;

  // 先开弹窗：原文先填进标题，识别结果回来再补其他字段
  const firstLine = content.split('\n')[0];
  await showTaskModal({
    title: firstLine,
    description: content.includes('\n') ? content.substring(content.indexOf('\n') + 1) : '',
    executionId: selectedExecutionId || '',
    priority: 3,
    progress: 0,
    dueDate: ''
  });
  if (taskIntakeSession !== session) return;

  setTaskAiStatus('loading', '正在识别执行归属、优先级和时间…你可以先改其他字段');
  // 两段式：先要本地规则结果（毫秒级）秒填；需要时再等 AI 补充未改过的字段
  session.pending = (async () => {
    try {
      const local = await runTaskPreview(session, { localOnly: true });
      if (local && local.aiPending && taskIntakeSession === session) {
        await runTaskPreview(session);
      }
    } finally {
      session.settled = true;
    }
  })();
}

/**
 * 检查后端 AI 是否可用，不可用时在页面顶部常驻提示条
 *
 * 背景：AI 不可用时后端会降级为本地规则，用户看到的效果是
 * "标题没拆好、时间没识别" —— 很容易误判成模型能力差。
 * 这里把真实原因直接摆在页面上。
 */
let _aiStatusCache = null;

/**
 * 检查后端连通性；不可用时由 background 通过 Native Messaging 自动拉起
 *
 * 正常情况下用户无需手动启动后端。这里只在自动拉起也失败时，
 * 才给出一条带「重试」按钮的提示。
 */
async function checkBackendHealth() {
  try {
    const resp = await fetch(`${API_BASE_URL}/api/config`);
    if (resp.ok) {
      removeBackendOfflineBanner();
      console.log('[后端状态] ✅ 已连接');
      return true;
    }
  } catch (e) {
    // 落到下面处理
  }

  console.warn('[后端状态] ❌ 后端未响应，尝试由插件自动拉起...');

  // 交给 background 尝试拉起（connectNative 需要 background 权限）
  let started = false;
  try {
    const r = await chrome.runtime.sendMessage({ action: 'startBackend' });
    started = !!(r && r.success);
    if (r && r.reason) console.warn('[后端状态] 拉起未成功:', r.reason);
  } catch (e) {
    console.warn('[后端状态] 无法与 background 通信:', e.message);
  }

  if (started) {
    removeBackendOfflineBanner();
    Toast.success('已自动启动本地服务');
    // 后端就绪后重新走一遍 AI 可用性检查
    setTimeout(() => checkAiAvailability(true), 800);
    return true;
  }

  showBackendOfflineBanner();
  return false;
}

function showBackendOfflineBanner() {
  const ID = 'backendOfflineBanner';
  if (document.getElementById(ID)) return;

  const banner = document.createElement('div');
  banner.id = ID;
  banner.style.cssText = `
    position:fixed; top:0; left:0; right:0; z-index:99999;
    background:#fef2f2; border-bottom:1px solid #fecaca; color:#991b1b;
    padding:8px 16px; font-size:13px; line-height:1.5;
    display:flex; align-items:center; gap:10px; justify-content:center;
    box-shadow:0 1px 4px rgba(0,0,0,.06);
  `;
  banner.innerHTML = `
    <span>⚠️ <b>本地服务未运行</b>：任务同步、AI 解析等功能暂不可用。</span>
    <button type="button" data-backend-retry
      style="padding:4px 12px;border:1px solid #fca5a5;background:#fff;color:#991b1b;
             border-radius:6px;cursor:pointer;font-size:13px;">重试启动</button>
    <button type="button" data-backend-dismiss
      style="border:none;background:transparent;cursor:pointer;font-size:16px;color:#991b1b;line-height:1;">×</button>
  `;
  document.body.appendChild(banner);

  banner.querySelector('[data-backend-retry]').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = '启动中...';
    // 先清掉上一次的说明
    const prev = banner.querySelector('[data-backend-hint]');
    if (prev) prev.remove();

    const ok = await checkBackendHealth();
    if (!ok) {
      e.target.disabled = false;
      e.target.textContent = '重试启动';
      // 启动失败时把原因和修复命令直接摊在横幅上。
      // 换机场景最常见的卡点是「这台机器用的不是 Chrome，宿主没注册」，
      // 静默失败会让用户反复点重试却永远起不来。
      const resp = await chrome.runtime.sendMessage({ action: 'startBackend' }).catch(() => null);
      const help = resp && resp.help;
      const code = (resp && resp.code) || '';
      if (help) {
        const hint = document.createElement('span');
        hint.setAttribute('data-backend-hint', '');
        hint.style.cssText = 'flex-basis:100%;text-align:center;margin-top:4px;font-size:12px;opacity:.92;';
        const cmd = (code === 'host_not_registered' || code === 'bad_manifest'
          || code === 'permission_denied' || code === 'unsupported')
          ? '（重新运行一次安装命令即可）'
          : '';
        hint.textContent = help + cmd;
        banner.appendChild(hint);
      }
    }
  });
  banner.querySelector('[data-backend-dismiss]').addEventListener('click', removeBackendOfflineBanner);
}

function removeBackendOfflineBanner() {
  const el = document.getElementById('backendOfflineBanner');
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

// ============================================================================
// 本地服务管理（设置面板）
// ============================================================================

/**
 * 统一切换按钮的加载态。
 *
 * 不能直接改 textContent —— 新版按钮是「图标 + 文字」结构，
 * 覆写 textContent 会把 SVG 图标一起抹掉，所以这里保存/还原整段 innerHTML。
 */
function setBtnLoading(btn, loadingLabel) {
  if (!btn) return;
  if (loadingLabel) {
    if (!btn.dataset.origHtml) btn.dataset.origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.innerHTML = '<span class="btn-spinner"></span><span class="btn-label">' + loadingLabel + '</span>';
  } else {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    if (btn.dataset.origHtml) {
      btn.innerHTML = btn.dataset.origHtml;
      delete btn.dataset.origHtml;
    }
  }
}

/**
 * 刷新「本地服务」状态卡
 *
 * 状态如实展示：是否在跑、由谁启动、是否装了开机自启。
 * 特别是「装了开机自启」这一项 —— 直接决定点「停止」能不能真停住，
 * 不提前告知的话用户会看到服务秒回，误以为按钮坏了。
 *
 * 四格元数据（PID / 监听地址 / 来源 / 开机自启）用等宽字体呈现，
 * 让「谁拉起的、连在哪、能不能自启」这三个排障高频问题一眼可答。
 */
async function checkServiceStatus() {
  const dot = document.getElementById('serviceStatusDot');
  const text = document.getElementById('serviceStatusText');
  const detail = document.getElementById('serviceStatusDetail');
  const startBtn = document.getElementById('serviceStartBtn');
  const stopBtn = document.getElementById('serviceStopBtn');
  const restartBtn = document.getElementById('serviceRestartBtn');
  const metaPid = document.getElementById('serviceMetaPid');
  const metaPort = document.getElementById('serviceMetaPort');
  const metaSource = document.getElementById('serviceMetaSource');
  const metaAuto = document.getElementById('serviceMetaAuto');
  if (!dot || !text) return;

  const setMeta = (el, val) => { if (el) el.textContent = val; };

  text.textContent = '检测中…';
  if (detail) detail.textContent = '';

  let resp = null;
  try {
    resp = await chrome.runtime.sendMessage({ action: 'getServiceStatus' });
  } catch (e) {
    resp = { success: false, reason: e.message };
  }

  const alive = !!(resp && resp.success && resp.alive && resp.data);

  if (alive) {
    const d = resp.data;
    // 复用已有的 status-dot 样式类，不另起内联样式，保持与主题一致
    dot.className = 'status-dot online';
    dot.title = '本地服务运行中';

    const mins = Math.floor((d.uptimeSeconds || 0) / 60);
    const uptime = mins >= 60
      ? `${Math.floor(mins / 60)} 小时 ${mins % 60} 分`
      : `${mins} 分钟`;

    const sourceMap = {
      native: '由插件自动拉起',
      launchd: '开机自启',
      supervisor: '开机自启（守护进程）',
      manual: '手动启动'
    };

    text.textContent = `运行中 · 已运行 ${uptime}`;
    setMeta(metaPid, String(d.pid || '—'));
    setMeta(metaPort, d.port ? `127.0.0.1:${d.port}` : '127.0.0.1:3721');
    setMeta(metaSource, sourceMap[d.launchedBy] || d.launchedBy || '未知');
    // 「已安装」只说明 plist 文件在；launchd 是否真的加载了它要另说。
    // 分开显示，用户才有可核对的东西。
    setMeta(metaAuto, d.launchAgentInstalled
      ? (d.launchAgentLoaded ? '已加载' : '待下次登录')
      : '未安装');
    syncAutoStartToggle(!!d.launchAgentInstalled, {
      alive: true,
      loaded: d.launchAgentLoaded
    });

    if (detail && d.launchAgentInstalled) {
      detail.textContent = d.launchAgentLoaded
        ? '开机自启已生效：点「停止服务」时会一并停用，否则服务会被系统立刻拉回。'
        : '已注册登录项，将在下次登录时生效；点「停止服务」时会一并停用。';
    }
  } else {
    dot.className = 'status-dot offline';
    dot.title = '本地服务未运行';
    text.textContent = '未运行';
    setMeta(metaPid, '—');
    setMeta(metaPort, '—');
    setMeta(metaSource, '—');
    setMeta(metaAuto, '—');
    // 服务没跑就没法改自启（配置要由后端落盘），
    // 这里只禁用开关、不改勾选态 —— 未知状态不该伪装成「未开启」。
    syncAutoStartToggle(undefined, { alive: false });
    if (detail) {
      detail.textContent = resp && resp.reason
        ? `原因：${resp.reason}`
        : '点击「启动服务」拉起（需已用安装命令安装）';
    }
  }

  // 运行中才给「重启 / 停止」，未运行只给「启动」
  if (startBtn) startBtn.style.display = alive ? 'none' : '';
  if (stopBtn) stopBtn.style.display = alive ? '' : 'none';
  if (restartBtn) restartBtn.style.display = alive ? '' : 'none';
  if (startBtn) startBtn.disabled = false;
  if (stopBtn) stopBtn.disabled = false;
  if (restartBtn) restartBtn.disabled = false;
}

/** 把服务动作结果写到卡片内的结果区 */
function setServiceResult(resultEl, ok, text) {
  if (!resultEl) return;
  resultEl.className = 'test-result ' + (ok ? 'success' : 'error');
  resultEl.textContent = (ok ? '✓ ' : '✗ ') + text;
}

/**
 * 同步「开机自启」开关的显示
 *
 * @param {boolean|undefined} installed true/false 表示已确认的状态；
 *        传 undefined 表示状态未知（服务未运行），此时只禁用、不改勾选。
 * @param {{alive?: boolean, busy?: boolean, loaded?: boolean}} [opts]
 *        loaded 表示 launchd 是否已加载该 job（后端 /api/admin/status 返回），
 *        用来区分「已生效」与「已注册，下次登录生效」。
 */
function syncAutoStartToggle(installed, opts) {
  const toggle = document.getElementById('autoStartToggle');
  const text = document.getElementById('autoStartToggleText');
  const wrap = document.getElementById('autoStartSwitch');
  const hint = document.getElementById('autoStartHint');
  if (!toggle) return;

  opts = opts || {};
  const alive = opts.alive !== false;
  const busy = !!opts.busy;
  const loaded = opts.loaded;

  if (typeof installed === 'boolean') toggle.checked = installed;
  toggle.disabled = !alive || busy;
  if (wrap) wrap.classList.toggle('is-busy', busy);

  if (text) {
    if (!alive) text.textContent = '服务未运行';
    else if (busy) text.textContent = toggle.checked ? '开启中…' : '关闭中…';
    else if (toggle.checked && loaded === false) text.textContent = '已开启（待下次登录生效）';
    else text.textContent = toggle.checked ? '已开启' : '未开启';
  }
  if (hint) {
    if (!alive) {
      hint.textContent = '后端未运行，无法修改。请先点上方「启动服务」。';
    } else if (toggle.checked) {
      // macOS 对 LaunchAgent 不会弹任何「要添加开机自启项吗」的确认框，
      // 系统设置里的列表也只在 job 真正被 launchd 加载后才出现 ——
      // 不写清楚，用户只能得出「这个开关是假的」。
      hint.textContent = (typeof WA_IS_WINDOWS !== 'undefined' && WA_IS_WINDOWS)
        ? '已注册为 Windows 启动项（任务管理器的「启动应用」里显示为 Windows Based Script Host）。'
        : '已注册为 macOS 登录项（LaunchAgent）。系统不会弹窗确认；'
          + '可执行 launchctl print gui/$(id -u)/com.workassistant.backend 核对。';
    } else {
      hint.textContent = '开启后无需打开浏览器，早间提醒与晚间日报也会准时生成';
    }
  }
}

/**
 * 开关开机自启
 *
 * 实际写文件与 launchctl 由后端代劳（扩展沙箱做不到），
 * 后端返回什么状态就以什么状态回填，不假装成功。
 */
async function setAutoStart(enabled) {
  const toggle = document.getElementById('autoStartToggle');
  const resultEl = document.getElementById('autoStartResult');
  if (!toggle) return;

  if (!enabled && !(await Confirm.show(
    '关闭开机自启',
    `关闭后，下次登录 ${typeof WA_OS_NAME !== 'undefined' ? WA_OS_NAME : 'macOS'} 不会再自动启动后端，早间提醒与晚间日报需要后端在运行才能触发。\n当前正在运行的服务不会受影响。`,
    '关闭自启'
  ))) {
    toggle.checked = true; // 撤销这次勾选
    return;
  }

  if (resultEl) { resultEl.textContent = ''; resultEl.className = 'test-result'; resultEl.title = ''; }
  syncAutoStartToggle(undefined, { alive: true, busy: true });

  let resp = null;
  try {
    resp = await chrome.runtime.sendMessage({ action: 'setAutoStart', enabled });
  } catch (e) {
    resp = { success: false, reason: e.message };
  }

  if (resp && resp.success) {
    setServiceResult(resultEl, true, resp.message || (enabled ? '已开启开机自启' : '已关闭开机自启'));
  } else {
    // resp 为空 = 后台脚本没应答。最常见的成因是只刷新了新标签页、
    // 没有在 chrome://extensions 里重新加载扩展 ——
    // 页面脚本会从磁盘读新版，但 background 的 Service Worker 仍是旧代码，
    // 于是新消息无人处理。这里必须点明，否则只有一句「未知错误」。
    const reason = !resp
      ? '扩展后台未响应。请在 chrome://extensions 重新加载扩展后重试'
      : ((resp.reason || resp.message) || '未知错误');
    setServiceResult(resultEl, false, reason);
    // 脚本原始输出放 title 里，鼠标悬停可看，避免正文过长
    if (resultEl && resp && resp.output) resultEl.title = resp.output;
  }

  // 先自己解除 busy 再交给 checkServiceStatus 校正。
  // 不依赖后者收尾：它在状态节点缺失时会提前 return，
  // 那样开关会永久停在「未运行」的禁用态，用户再也点不动。
  syncAutoStartToggle(undefined, { alive: true });

  // 以后端回报的真实状态为准重新同步，失败时开关会自动弹回原位
  await checkServiceStatus();
}

/**
 * 停止本地服务
 */
async function stopBackendService() {
  const btn = document.getElementById('serviceStopBtn');
  const resultEl = document.getElementById('serviceActionResult');
  const disableAuto = document.getElementById('serviceDisableAutoStart');

  if (!(await Confirm.show(
    '停止本地服务',
    '停止后，任务同步、AI 解析、日报定时生成都会暂停（日报定时任务依赖后端常驻，请确认现在不需要）。',
    '停止服务', '取消', { danger: true }
  ))) return;

  setBtnLoading(btn, '停止中…');
  if (resultEl) { resultEl.textContent = ''; resultEl.className = 'test-result'; }

  try {
    const resp = await chrome.runtime.sendMessage({
      action: 'stopBackend',
      disableAutoStart: !!(disableAuto && disableAuto.checked)
    });

    if (resp && resp.success) {
      const notes = (resp.notes && resp.notes.length) ? `（${resp.notes.join('；')}）` : '';
      setServiceResult(resultEl, true, '已停止' + notes);
      Toast.success('本地服务已停止');
      // 服务已停，隐藏离线提示条由后台判断，这里直接移除避免重复提示
      removeBackendOfflineBanner();
    } else {
      const why = (resp && (resp.reason || resp.message)) || '未知原因';
      setServiceResult(resultEl, false, '停止失败：' + why);
      Toast.error('停止失败：' + why);
    }
  } catch (e) {
    setServiceResult(resultEl, false, '停止异常：' + e.message);
    Toast.error('停止异常：' + e.message);
  } finally {
    setBtnLoading(btn, null);
    await checkServiceStatus();
  }
}

/**
 * 启动本地服务
 */
async function startBackendService() {
  const btn = document.getElementById('serviceStartBtn');
  const resultEl = document.getElementById('serviceActionResult');

  setBtnLoading(btn, '启动中…');
  if (resultEl) { resultEl.textContent = ''; resultEl.className = 'test-result'; }

  try {
    const resp = await chrome.runtime.sendMessage({ action: 'startBackend' });

    if (resp && resp.success) {
      setServiceResult(resultEl, true, '已启动');
      Toast.success('本地服务已启动');
    } else {
      // 优先展示 background 归类好的中文指引；没有 help 时退回原始报错。
      // 换机场景最常见的是「这台机器没装 Chrome / 用的不是 Chrome」，
      // 直接把英文原生报错透给用户等于没给任何帮助。
      const why = (resp && resp.help) || (resp && resp.reason) || '未知原因';
      const code = (resp && resp.code) || '';
      if (resultEl) {
        resultEl.className = 'test-result error';
        resultEl.innerHTML = '';
        const head = document.createElement('div');
        head.textContent = '✗ 启动失败' + (code ? `（${code}）` : '');
        head.style.fontWeight = '600';
        resultEl.appendChild(head);
        const detail = document.createElement('div');
        detail.textContent = why;
        detail.style.marginTop = '4px';
        detail.style.lineHeight = '1.6';
        resultEl.appendChild(detail);
        // 宿主未注册时，把要执行的命令直接给出来，用户照抄即可
        if (code === 'host_not_registered' || code === 'bad_manifest' || code === 'permission_denied') {
          const cmd = document.createElement('div');
          cmd.textContent = typeof WA_INSTALL_COMMAND !== 'undefined' ? WA_INSTALL_COMMAND : 'curl -fsSL https://github.com/rskdwypy-pixel/workAssistant/releases/latest/download/install.sh | bash';
          cmd.style.cssText = 'margin-top:6px;padding:4px 8px;background:var(--bg-secondary,#f3f4f6);'
            + 'border-radius:4px;font-family:monospace;font-size:11px;display:inline-block;'
            + 'user-select:all;cursor:pointer;';
          cmd.title = '点击复制';
          cmd.addEventListener('click', () => {
            navigator.clipboard.writeText(cmd.textContent)
              .then(() => Toast.success('命令已复制'))
              .catch(() => Toast.info('请手动选中复制'));
          });
          resultEl.appendChild(cmd);
        }
      }
      Toast.error('启动失败，请看下方提示');
    }
  } catch (e) {
    setServiceResult(resultEl, false, '启动异常：' + e.message);
    Toast.error('启动异常：' + e.message);
  } finally {
    setBtnLoading(btn, null);
    await checkServiceStatus();
  }
}

/**
 * 重启本地服务
 *
 * 先停再启。后端收到 shutdown 后会延迟退出，所以中间留一小段等待，
 * 否则「启动」会撞上还占着端口的旧进程。
 */
async function restartBackendService() {
  const btn = document.getElementById('serviceRestartBtn');
  const resultEl = document.getElementById('serviceActionResult');

  setBtnLoading(btn, '重启中…');
  if (resultEl) { resultEl.textContent = ''; resultEl.className = 'test-result'; }

  try {
    const stopResp = await chrome.runtime.sendMessage({ action: 'stopBackend', disableAutoStart: false });
    await new Promise(r => setTimeout(r, 900));

    if (stopResp && !stopResp.success) {
      const why = stopResp.reason || stopResp.message || '停止阶段失败';
      setServiceResult(resultEl, false, '重启失败：' + why);
      Toast.error('重启失败：' + why);
      return;
    }

    const startResp = await chrome.runtime.sendMessage({ action: 'startBackend' });
    if (startResp && startResp.success) {
      setServiceResult(resultEl, true, '已重启');
      Toast.success('本地服务已重启');
    } else {
      const why = (startResp && (startResp.help || startResp.reason)) || '未知原因';
      setServiceResult(resultEl, false, '重启失败：' + why);
      Toast.error('重启失败：' + why);
    }
  } catch (e) {
    setServiceResult(resultEl, false, '重启异常：' + e.message);
    Toast.error('重启异常：' + e.message);
  } finally {
    setBtnLoading(btn, null);
    await checkServiceStatus();
  }
}

// 绑定本地服务管理按钮（DOMContentLoaded 时元素才存在）
document.addEventListener('DOMContentLoaded', () => {
  const stopBtn = document.getElementById('serviceStopBtn');
  const startBtn = document.getElementById('serviceStartBtn');
  const restartBtn = document.getElementById('serviceRestartBtn');
  const autoStartToggle = document.getElementById('autoStartToggle');
  if (stopBtn) stopBtn.addEventListener('click', stopBackendService);
  if (startBtn) startBtn.addEventListener('click', startBackendService);
  if (restartBtn) restartBtn.addEventListener('click', restartBackendService);
  if (autoStartToggle) {
    autoStartToggle.addEventListener('change', () => setAutoStart(autoStartToggle.checked));
  }
});

async function checkAiAvailability(force = false) {
  if (_aiStatusCache && !force) return _aiStatusCache;

  try {
    const resp = await fetch(`${API_BASE_URL}/api/config`);
    const json = await resp.json();
    const ai = json && json.data && json.data.ai;
    if (!ai) return null;

    _aiStatusCache = {
      available: !!ai.available,
      reason: ai.unavailableReason || '',
      model: ai.aiModel || '',
      baseURL: ai.apiBaseUrl || ''
    };
  } catch (e) {
    console.warn('[AI状态] 获取配置失败:', e.message);
    return null;
  }

  if (_aiStatusCache.available) {
    console.log('[AI状态] ✅ AI 可用:', _aiStatusCache.model);
    removeAiUnavailableBanner();
    return _aiStatusCache;
  }

  console.warn('[AI状态] ⚠️ AI 不可用:', _aiStatusCache.reason);
  showAiUnavailableBanner(_aiStatusCache);
  return _aiStatusCache;
}

function showAiUnavailableBanner(info) {
  const ID = 'aiUnavailableBanner';
  if (document.getElementById(ID)) return;

  const banner = document.createElement('div');
  banner.id = ID;
  banner.style.cssText = `
    position:fixed; top:0; left:0; right:0; z-index:99999;
    background:#fffbeb; border-bottom:1px solid #fcd34d; color:#92400e;
    padding:8px 16px; font-size:13px; line-height:1.5;
    display:flex; align-items:center; gap:10px; justify-content:center;
    box-shadow:0 1px 4px rgba(0,0,0,.06);
  `;
  banner.innerHTML = `
    <span>⚠️ <b>AI 智能解析未启用</b>：后端未配置 API Key，任务标题/时间/优先级将按原文保存，需手动填写。</span>
    <span style="opacity:.75">（填写 .env 的 OPENAI_API_KEY 后重启后端即可启用）</span>
    <button type="button" data-ai-dismiss
      style="margin-left:8px;border:none;background:transparent;cursor:pointer;font-size:16px;color:#92400e;line-height:1;">×</button>
  `;
  document.body.appendChild(banner);

  banner.querySelector('[data-ai-dismiss]').addEventListener('click', removeAiUnavailableBanner);
}

function removeAiUnavailableBanner() {
  const el = document.getElementById('aiUnavailableBanner');
  if (el && el.parentNode) el.parentNode.removeChild(el);
}

// 更新任务进度
//
// 交互约定（乐观 UI）：
//   1. 用户拖动进度条 → 本地立即改状态/进度并重渲染（进度条不再「弹回去」）
//   2. 后端持久化
//   3. 禅道状态与工时在后台同步，期间卡片显示「同步中」角标
//   4. 禅道失败 → 角标变「未同步」+ Toast 说明；禅道里那条仍停留在旧进度，
//      本地不受影响，可稍后在禅道里改，或重新触发同步
//
// 回滚约定（重要）：
//   无论失败发生在哪一步（后端拒绝 / fetch 抛异常 / JSON 解析失败），
//   UI 都必须回到改动前的样子。否则界面显示 90%、库里还是 30%，
//   用户和后端会永久错位。snapshot 因此必须声明在 try **外面** ——
//   放try 里的话catch 分支根本拿不到它，回滚代码编译都过不了。
async function updateTaskProgress(taskId, progress) {
  // 快照必须在任何改动之前取。注意 task 是 allTasks 里的同一个对象引用，
  // patchTask 会直接改它，所以回滚只能用这里的值，不能回头读 task.*
  const target = allTasks.find(t => String(t.id) === String(taskId));
  const snapshot = target
    ? {
      progress: target.progress,
      status: target.status,
      totalConsumedTime: target.totalConsumedTime
    }
    : null;

  // 统一的失败回滚：把 UI 还原到 snapshot，并刷新统计
  const rollback = () => {
    if (!snapshot) return;
    OptimisticUI.patchTask(taskId, {
      progress: snapshot.progress,
      status: snapshot.status,
      totalConsumedTime: snapshot.totalConsumedTime
    });
    updateTaskStats().catch(() => { });
  };

  try {
    // 获取任务信息，用于弹窗提示
    const task = target;
    if (!task) return false;

    console.log('[Progress] updateTaskProgress 调用:', { taskId, taskProgress: snapshot.progress, newProgress: progress });

    let progressComment = '';
    let consumedTime = 0;
    let completionAttachments = [];

    // 如果进度有变化，弹出输入框让用户填写工作内容和消耗工时
    if (snapshot.progress !== progress) {
      const result = await ProgressInputDialog.show(
        '更新进度',
        `更新进度至 ${progress}%`,
        '',                              // placeholder 工作
        '',                              // placeholder 消耗工时
        `更新进度至 ${progress}%`,         // 默认工作
        1,                                // 默认消耗工时（1小时）
        { allowAttachments: progress === 100 } // 完成任务时可附上验证截图
      );

      // 用户取消则不更新，返回 false
      if (result === null) {
        console.log('[Progress] 用户取消进度更新');
        return false;
      }

      progressComment = result.work;
      consumedTime = result.consumed;
      completionAttachments = result.attachments || [];
    }

    // —— 第一步：乐观更新本地 UI，不等任何网络请求 ——
    const nextStatus = OptimisticUI.statusOf(progress);
    const previousTotal = snapshot.totalConsumedTime || 0;
    OptimisticUI.patchTask(taskId, {
      progress: progress,
      status: nextStatus,
      totalConsumedTime: consumedTime > 0 ? previousTotal + consumedTime : previousTotal
    });
    updateTaskStats().catch(() => { });

    // —— 第二步：写后端（这个很快，失败要如实告知并回滚）——
    const response = await fetch(`${API_BASE_URL}/api/task/${taskId}/progress`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ progress, progressComment, consumedTime })
    });

    const result = await response.json();
    if (!result.success) {
      // 后端没存住 → 回滚，避免「界面显示 50%、后端还是 0%」的错位
      rollback();
      Toast.error('更新进度失败');
      console.warn('更新进度失败:', result.error);
      return false;
    }

    // —— 第三步：后端确认存住了，才结算工时 ——
    // 放在这一步之前记工时的话，一旦进度写失败就会出现
    // 「进度没更新、工时却加了」的账目错乱。
    if (consumedTime > 0) {
      updateTodayWorkTime(consumedTime);
    }

    // —— 第四步：禅道同步放到后台，不再阻塞界面 ——
    // 完成时附带的附件：先存进本地附件区，已同步禅道的先推送附件、再改状态
    // （禅道「关闭任务」表单不带附件，任务关闭后再编辑可能被拒，所以附件必须在状态之前到位）
    const attachmentsReady = completionAttachments.length
      ? uploadCompletionAttachments(task, completionAttachments)
      : Promise.resolve();
    if (task.zentaoId) {
      attachmentsReady.then(() => syncProgressToZentao(
        {
          id: taskId,
          zentaoId: task.zentaoId,
          executionId: task.executionId,
          executionType: task.executionType
        },
        {
          progress,
          progressComment,
          consumedTime,
          totalConsumedTime: previousTotal + consumedTime
        }
      ));
    }

    console.log('[Progress] 进度更新成功，本地状态已更新');
    return true;
  } catch (err) {
    // fetch 失败（服务没起/被拦截）、响应不是合法 JSON 等都会走到这里。
    // 之前这里只弹 Toast 不回滚，导致界面停留在新进度而后端还是旧值。
    rollback();
    Toast.error('更新进度失败');
    console.warn('更新进度失败:', err);
    return false;
  }
}

/**
 * 完成任务时附带的附件：存进本地附件区；任务已同步禅道则立即推送并等待完成，
 * 调用方在它之后才改禅道状态。失败不阻塞状态更新（卡片会显示「未上传 · 重试」）。
 */
async function uploadCompletionAttachments(task, items) {
  try {
    const { uploaded, failed } = await AttachmentApi.uploadAll(task.id, items, { inline: false, push: false });
    if (failed.length) {
      Toast.error(`${failed.length} 个附件添加失败：${failed.map(f => f.message).join('；')}`, 6000);
    }
    if (uploaded.length && task.zentaoId) {
      const r = await AttachmentApi.sync(task.id);
      if (!r.success) Toast.error(`附件上传到禅道失败：${r.message}（可在任务详情里重试）`, 6000);
    }
  } catch (err) {
    Toast.error(`附件上传失败：${err.message}（可在任务详情里重试）`, 6000);
  } finally {
    loadTasks().catch(() => { });
  }
}

/**
 * 后台把进度/状态同步到禅道（并按需登记工时）
 *
 * 复用 OptimisticUI 的同步状态机：卡片显示「同步中」→「同步完成」或「未同步」。
 *
 * @param {object} task 本地任务快照（需带 zentaoId / executionId / executionType）
 * @param {object} payload progress / progressComment / consumedTime / totalConsumedTime
 */
async function syncProgressToZentao(task, payload) {
  const { progress, progressComment, consumedTime, totalConsumedTime } = payload;
  const taskId = task.id;

  // 根据进度确定禅道侧状态
  const zentaoStatus = OptimisticUI.statusOf(progress);

  // 执行类型（判断是否为看板），优先用任务上存的，其次查缓存
  let executionType = task.executionType;
  if (!executionType && task.executionId) {
    try {
      executionType = ExecutionFavorites.getExecutionType(task.executionId);
      console.log('[Progress] 从缓存获取执行类型:', task.executionId, '=>', executionType);
    } catch (e) {
      console.warn('[Progress] 取执行类型失败:', e);
    }
  }
  // 看板类型下 kanbanId 就是 executionId
  const kanbanId = executionType === 'kanban' ? task.executionId : null;
  console.log('[Progress] 执行类型:', executionType, '看板ID:', kanbanId);

  // 剩余工时：总累计消耗 / 进度 - 总累计消耗（与原实现一致）
  let leftTime = 0;
  if (progress > 0 && progress < 100 && totalConsumedTime > 0) {
    leftTime = Math.round((totalConsumedTime / (progress / 100) - totalConsumedTime) * 10) / 10;
    if (leftTime < 0) leftTime = 0;
  } else if (progress === 100) {
    leftTime = 0;
  } else if (totalConsumedTime > 0) {
    leftTime = totalConsumedTime * 2;
  }

  await OptimisticUI.trackSync({
    taskId: taskId,
    // 静默：状态同步是每次拖动的常规动作，不该每拖一次就弹一个成功 Toast
    quiet: true,
    successMessage: () => `进度已同步到禅道（${progress}%）`,
    failureMessage: (res) => `本地已更新，但同步禅道失败：${OptimisticUI.explainFailure(res)}`,
    syncFn: async () => {
      const statusRes = await ZentaoBrowserClient.updateTaskStatus(task.zentaoId, zentaoStatus, progress, {
        executionType,
        kanbanId
      });
      if (!statusRes || !statusRes.success) {
        return { success: false, reason: statusRes && statusRes.reason, message: statusRes && statusRes.message };
      }
      console.log('[Progress] 浏览器端更新禅道状态成功');

      // 仅当用户输入了消耗时间或工作内容时才上传日志
      if (consumedTime > 0 || progressComment) {
        console.log(`[Progress] 累计消耗 ${totalConsumedTime}h, 进度=${progress}%, 计算剩余=${leftTime}h`);
        const effortRes = await ZentaoBrowserClient.recordEffort(
          task.zentaoId, progressComment, consumedTime, leftTime, kanbanId, progress
        );
        if (!effortRes || !effortRes.success) {
          return { success: false, reason: effortRes && effortRes.reason, message: effortRes && effortRes.message };
        }
        console.log('[Progress] 浏览器端记录禅道工时成功');
      }
      return { success: true };
    },
    onSuccess: async () => {
      // 把累计工时落库（放在 onSuccess，避免每次拖动都多一次 PUT）
      if (consumedTime > 0) {
        await fetch(`${API_BASE_URL}/api/task/${taskId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ totalConsumedTime })
        }).catch(e => console.warn('[Progress] 累计工时写库失败:', e));
      }
    }
  });
}

// 更新任务优先级
//
// 同样采用乐观 UI：先改本地任务并整表重渲染（优先级按钮、边框色、
// 排序位置都会立刻反映新值），再写后端，禅道放后台。
//
// 与 updateTaskProgress 同理：
//   - 快照必须在改之前取（task 是 allTasks 里的引用）
//   - fetch 抛异常时也要回滚，否则界面优先级与库里永久不一致
//   - 禅道同步必须等后端确认成功后再发，否则后端没存住却已经把禅道改了
async function updateTaskPriority(taskId, priority) {
  const task = allTasks.find(t => String(t.id) === String(taskId));
  if (!task) {
    Toast.error('更新优先级失败');
    return;
  }
  const prevPriority = task.priority;

  // —— 乐观更新：界面立刻变 ——
  OptimisticUI.patchTask(taskId, { priority: priority });

  try {
    const response = await fetch(`${API_BASE_URL}/api/task/${taskId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority, order: null })
    });

    const result = await response.json();

    if (!result.success) {
      // 后端没存住 → 回滚，避免界面显示的优先级与库里不一致
      OptimisticUI.patchTask(taskId, { priority: prevPriority });
      Toast.error('更新优先级失败');
      console.warn('更新优先级失败:', result.error);
      return;
    }
  } catch (err) {
    OptimisticUI.patchTask(taskId, { priority: prevPriority });
    Toast.error('更新优先级失败');
    console.warn('更新优先级失败:', err);
    return;
  }

  // 后端确认存住了，此时才推送禅道
  if (task.zentaoId && (task.zentaoExecution || task.executionId)) {
    OptimisticUI.trackSync({
      taskId: taskId,
      quiet: true,
      successMessage: () => '优先级已同步到禅道',
      failureMessage: (res) => `本地已更新，但同步禅道失败：${OptimisticUI.explainFailure(res)}`,
      syncFn: () => ZentaoBrowserClient.editTask({
        zentaoId: task.zentaoId,
        execution: task.zentaoExecution || task.executionId,
        name: task.title,  // 传入任务标题，用于 desc 字段
        pri: priority
      })
    });
  }

  // 详情弹窗若正开着，其内部的优先级展示可能已过期，关闭以免与卡片不一致
  const detailModal = document.querySelector('.task-detail-modal.active');
  if (detailModal && detailModal.dataset && detailModal.dataset.taskId === String(taskId)) {
    detailModal.remove();
  }
}

// 标题内联编辑
function makeTitleInlineEdit(element, taskId) {
  const task = allTasks.find(t => t.id === taskId);
  if (!task) return;

  const currentTitle = task.title;

  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentTitle;
  input.style.cssText = 'font-size: 14px; padding: 4px 8px; border: 1px solid #3b82f6; border-radius: 4px; outline: none; width: 100%; box-sizing: border-box;';

  // 保存原始元素用于恢复
  const originalHTML = element.innerHTML;
  element.innerHTML = '';
  element.appendChild(input);
  input.focus();
  // 光标移到文字尾部
  input.setSelectionRange(input.value.length, input.value.length);

  const save = async () => {
    const newTitle = input.value.trim();
    if (newTitle && newTitle !== currentTitle) {
      await updateTaskTitle(taskId, newTitle);
    } else {
      // 恢复原始内容
      element.innerHTML = originalHTML;
      // 重新绑定点击事件
      element.addEventListener('click', onTitleClick);
    }
  };

  const cancel = () => {
    element.innerHTML = originalHTML;
    element.addEventListener('click', onTitleClick);
  };

  // 移除之前的点击事件，避免重复触发
  element.removeEventListener('click', onTitleClick);

  input.addEventListener('blur', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      input.removeEventListener('blur', save);
      cancel();
    }
  });
}

// 标题点击事件处理器
function onTitleClick(e) {
  // 如果点击的是禅道链接，不触发编辑
  if (e.target.classList.contains('zentao-link')) return;
  const taskId = e.currentTarget.dataset.taskId;
  makeTitleInlineEdit(e.currentTarget, taskId);
}

// 更新任务标题（接受新标题参数）
async function updateTaskTitle(taskId, newTitle) {
  const task = allTasks.find(t => t.id === taskId);
  if (!task) return;

  const trimmedTitle = newTitle?.trim();
  if (!trimmedTitle) {
    return; // 标题为空，不更新
  }

  try {
    // 如果有 zentaoId 和 zentaoExecution，先同步到禅道
    if (task.zentaoId && (task.zentaoExecution || task.executionId)) {
      try {
        const zentaoResult = await ZentaoBrowserClient.editTask({
          zentaoId: task.zentaoId,
          execution: task.zentaoExecution || task.executionId,
          name: trimmedTitle
        });
        if (zentaoResult.success) {
          console.log('[Title] 禅道标题已同步');
        } else {
          console.log('[Title] 禅道标题同步失败:', zentaoResult.reason);
        }
      } catch (err) {
        console.log('[Title] 同步禅道标题出错:', err.message);
      }
    }

    const response = await fetch(`${API_BASE_URL}/api/task/${taskId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: trimmedTitle })
    });

    const result = await response.json();

    if (result.success) {
      Toast.success('标题已更新');
      await loadTasks();
    } else {
      console.warn('更新标题失败:', result.error);
      Toast.error('更新失败');
    }
  } catch (err) {
    console.warn('更新标题失败:', err);
    Toast.error('更新失败');
  }
}

// 显示确认删除对话框（用于键盘 Delete/Backspace）
function showDeleteConfirmDialog(task) {
  const dialog = document.getElementById('confirmDialog');
  const title = document.getElementById('confirmTitle');
  const message = document.getElementById('confirmMessage');
  const okBtn = document.getElementById('confirmOk');
  const cancelBtn = document.getElementById('confirmCancel');

  title.textContent = '删除任务';
  message.innerHTML = `确定要删除任务「${escapeHtml(task.title)}」吗？<br><small style="color:#999;">按 Enter 确认删除，按 Esc 取消</small>`;

  dialog.classList.add('active');

  // 清除之前的事件监听器
  const newOkBtn = okBtn.cloneNode(true);
  const newCancelBtn = cancelBtn.cloneNode(true);
  okBtn.parentNode.replaceChild(newOkBtn, okBtn);
  cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);

  // 确认删除
  newOkBtn.addEventListener('click', async () => {
    dialog.classList.remove('active');
    await deleteSelectedTask();
  });

  // 取消删除
  newCancelBtn.addEventListener('click', () => {
    dialog.classList.remove('active');
  });

  // 按 Enter 确认，按 Esc 取消
  const handleKey = async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      dialog.classList.remove('active');
      document.removeEventListener('keydown', handleKey);
      await deleteSelectedTask();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      dialog.classList.remove('active');
      document.removeEventListener('keydown', handleKey);
    }
  };
  document.addEventListener('keydown', handleKey);
}

// 直接删除选中的任务（用于键盘 Enter 或确认对话框）
async function deleteSelectedTask() {
  if (!selectedTaskId) return;

  const taskId = selectedTaskId;

  // 防止重复调用
  if (deletingTaskIds.has(taskId)) {
    console.log('[DeleteTask] 任务正在删除中，跳过重复调用');
    return;
  }
  deletingTaskIds.add(taskId);

  const task = allTasks.find(t => t.id === taskId);

  if (!task) {
    deletingTaskIds.delete(taskId);
    return;
  }

  try {
    // 先调用后端 API 删除任务
    const response = await fetch(`${API_BASE_URL}/api/task/${taskId}`, { method: 'DELETE' });
    const result = await response.json();

    if (result.success) {
      // 如果任务有 zentaoId，也删除禅道中的对应任务
      if (task.zentaoId) {
        try {
          await ZentaoBrowserClient.initConfig();
          if (ZentaoBrowserClient.isConfigured()) {
            const zentaoResult = await ZentaoBrowserClient.deleteZentaoTask(task.zentaoId);
            if (zentaoResult.success) {
              console.log('[Keyboard Delete] 禅道任务已删除:', task.zentaoId);
            } else {
              console.log('[Keyboard Delete] 删除禅道任务失败:', zentaoResult.reason);
            }
          }
        } catch (err) {
          console.log('[Keyboard Delete] 删除禅道任务出错:', err.message);
        }
      }

      // 清除选中状态
      document.querySelectorAll('.task-card.selected').forEach(c => c.classList.remove('selected'));
      selectedTaskId = null;

      Toast.success('任务已删除');
      await loadTasks();
      await loadCalendar();
    } else {
      Toast.error('删除任务失败: ' + (result.error || '未知错误'));
    }
  } catch (err) {
    Toast.error('操作失败');
    console.warn('删除任务错误:', err);
  } finally {
    // 清除删除中状态
    deletingTaskIds.delete(taskId);
  }
}

// 处理任务操作
async function handleTaskAction(taskId, action) {
  try {
    if (action === 'delete') {
      // 防止重复调用
      if (deletingTaskIds.has(taskId)) {
        console.log('[HandleTask] 任务正在删除中，跳过重复调用');
        return;
      }

      const confirmed = await showConfirm('删除任务', '确定要删除这个任务吗？');
      if (!confirmed) return;

      // 标记为正在删除
      deletingTaskIds.add(taskId);

      // 获取任务信息（需要 zentaoId 和 executionId）
      const task = allTasks.find(t => t.id === taskId);
      if (!task) {
        deletingTaskIds.delete(taskId);
        return;
      }

      // 先调用后端 API 删除任务
      const response = await fetch(`${API_BASE_URL}/api/task/${taskId}`, { method: 'DELETE' });
      const result = await response.json();

      if (result.success) {
        // 如果任务有 zentaoId，也删除禅道中的对应任务
        if (task.zentaoId) {
          try {
            await ZentaoBrowserClient.initConfig();
            if (ZentaoBrowserClient.isConfigured()) {
              const zentaoResult = await ZentaoBrowserClient.deleteZentaoTask(task.zentaoId);
              if (zentaoResult.success) {
                console.log('[HandleTask] 禅道任务已删除:', task.zentaoId);
              } else {
                console.log('[HandleTask] 删除禅道任务失败:', zentaoResult.reason);
              }
            }
          } catch (err) {
            console.log('[HandleTask] 删除禅道任务出错:', err.message);
          }
        }

        Toast.success('任务已删除');
      } else {
        Toast.error('删除任务失败: ' + (result.error || '未知错误'));
      }
    } else {
      await fetch(`${API_BASE_URL}/api/task/${taskId}/status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: action })
      });
      Toast.success('任务状态已更新');
    }

    await loadTasks();
    await loadCalendar();
  } catch (err) {
    Toast.error('操作失败');
    console.warn('处理任务操作错误:', err);
  } finally {
    // 清除删除中状态（仅在删除操作时）
    if (action === 'delete') {
      deletingTaskIds.delete(taskId);
    }
  }
}

/**
 * 搜索任务 / Bug：从禅道搜（禅道「全局搜索」，覆盖本账号能看到的全部任务 / Bug，不只是看板上同步下来的）
 *
 * 结果列在搜索框下方：已在看板上的点开本地卡片，其余在禅道里打开。
 * 禅道连不上 / 未启用时，任务搜索退回以前的本地搜索（过滤看板）。
 */
const ZentaoSearch = {
  token: 0,

  attach(inputId, type) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const wrap = input.parentElement;
    wrap.classList.add('zsearch-wrap');
    const panel = document.createElement('div');
    panel.className = 'zsearch-panel';
    panel.setAttribute('role', 'listbox');
    panel.hidden = true;
    wrap.appendChild(panel);
    const state = { input, panel, type, localFiltered: false, last: '' };
    input.setAttribute('autocomplete', 'off');
    input.addEventListener('input', debounce(() => this.run(state), 400));
    input.addEventListener('focus', () => { if (input.value.trim() && panel.innerHTML) panel.hidden = false; });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { panel.hidden = true; input.blur(); }
      if (e.key === 'ArrowDown') { const first = panel.querySelector('.zsearch-item'); if (first) { e.preventDefault(); first.focus(); } }
    });
    panel.addEventListener('keydown', (e) => {
      const items = [...panel.querySelectorAll('.zsearch-item')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' && i >= 0) { e.preventDefault(); (items[i + 1] || items[i]).focus(); }
      if (e.key === 'ArrowUp' && i >= 0) { e.preventDefault(); (items[i - 1] || input).focus(); }
      if (e.key === 'Escape') { panel.hidden = true; input.focus(); }
    });
    panel.addEventListener('click', (e) => {
      const item = e.target.closest('.zsearch-item');
      if (item) this.open(state, item.dataset);
    });
    document.addEventListener('click', (e) => {
      if (!wrap.contains(e.target)) panel.hidden = true;
    });
  },

  async run(state) {
    const q = state.input.value.trim();
    if (q === state.last) return;
    state.last = q;
    const token = ++this.token;
    if (!q) {
      state.panel.hidden = true;
      state.panel.innerHTML = '';
      // 之前退回过本地搜索（看板被过滤了）：恢复看板
      if (state.localFiltered) { state.localFiltered = false; await handleSearch(); }
      return;
    }
    const label = state.type === 'bug' ? 'Bug' : '任务';
    state.panel.hidden = false;
    // 本地模式（没登录禅道）：任务走本地搜索，并提示登录后可搜禅道里的全部
    if (window.Account && Account.isLocalMode()) {
      if (state.type === 'task') {
        state.localFiltered = true;
        await handleSearch();
      }
      if (token !== this.token) return;
      state.panel.innerHTML = `<div class="zsearch-status">${state.type === 'task' ? '看板中已显示本地搜索结果。' : ''}登录禅道后可搜索禅道里的全部${label}<br><button type="button" class="tab-login-btn zsearch-login">登录禅道</button></div>`;
      state.panel.querySelector('.zsearch-login').addEventListener('click', () => { state.panel.hidden = true; Account.showLogin({ fromButton: true }); });
      return;
    }
    state.panel.innerHTML = `<div class="zsearch-status"><span class="zsearch-spinner"></span>正在禅道中搜索${label}…</div>`;
    // 两步：先只要命中（约 0.3 秒）马上列出，再查状态 / 指派人等详情补全（约 3 秒）
    const fetchResults = async (details) => {
      const resp = await fetch(`${API_BASE_URL}/api/zentao/search?type=${state.type}&q=${encodeURIComponent(q)}${details ? '' : '&details=0'}`);
      const result = await resp.json().catch(() => ({ success: false, message: `HTTP ${resp.status}` }));
      if (!result.success) throw new Error(result.message || '搜索失败');
      return result.data;
    };
    try {
      const quick = await fetchResults(false);
      if (token !== this.token) return;
      this.render(state, q, quick, true);
      if (!quick.items.length) return;
      const full = await fetchResults(true);
      if (token !== this.token) return;
      this.render(state, q, full);
    } catch (err) {
      if (token !== this.token) return;
      if (state.type === 'task') {
        // 退回本地搜索：过滤看板
        state.localFiltered = true;
        await handleSearch();
        state.panel.innerHTML = `<div class="zsearch-status is-error">禅道搜索失败：${escapeHtml(err.message)}<br>已在看板中显示本地搜索结果</div>`;
      } else {
        state.panel.innerHTML = `<div class="zsearch-status is-error">禅道搜索失败：${escapeHtml(err.message)}</div>`;
      }
    }
  },

  render(state, q, { items, total }, loading = false) {
    const label = state.type === 'bug' ? 'Bug' : '任务';
    if (!items.length) {
      state.panel.innerHTML = `<div class="zsearch-status">禅道里没有找到包含「${escapeHtml(q)}」的${label}</div>`;
      return;
    }
    const closed = new Set(['done', 'closed', 'cancel', 'resolved']);
    const head = `<div class="zsearch-head">禅道中找到 ${total} 个${label}${total > items.length ? `，显示最近编辑的 ${items.length} 个` : ''}${loading ? '<span class="zsearch-spinner zsearch-loading" title="正在读取状态、指派人"></span>' : ''}</div>`;
    state.panel.innerHTML = head + items.map(x => `
      <button type="button" class="zsearch-item ${closed.has(x.status) ? 'is-closed' : ''}" role="option"
        data-type="${x.type}" data-id="${escapeHtml(x.id)}" data-local-id="${escapeHtml(x.localId || '')}">
        <span class="zsearch-title"><span class="zsearch-id">#${escapeHtml(x.id)}</span>${escapeHtml(x.title)}</span>
        <span class="zsearch-meta">
          ${x.statusLabel ? `<span class="zsearch-status-tag is-${escapeHtml(x.status)}">${escapeHtml(x.statusLabel)}</span>` : ''}
          ${x.assignedToName ? `<span>${escapeHtml(x.assignedToName)}</span>` : ''}
          ${x.where ? `<span class="zsearch-where">${escapeHtml(x.where)}</span>` : ''}
          ${!x.statusLabel && x.editedDate ? `<span>${escapeHtml(x.editedDate)} 编辑</span>` : ''}
          ${x.localId ? '<span class="zsearch-local">看板中</span>' : ''}
        </span>
      </button>`).join('');
  },

  /** 已在看板上的打开本地卡片详情，其余在禅道里打开 */
  open(state, data) {
    state.panel.hidden = true;
    if (data.localId) {
      if (data.type === 'bug' && typeof BugManager !== 'undefined') return BugManager.showBugDetail(data.localId);
      const task = allTasks.find(t => t.id === data.localId);
      if (task) return showTaskDetail(task);
    }
    openInZentao(data.type, data.id);
  }
};

// 页面一解析完就绑定（不放进 bindEvents：那要等日历、任务、弹窗等初始化完，打开后头几秒输入没反应）
document.addEventListener('DOMContentLoaded', () => {
  ZentaoSearch.attach('searchInput', 'task');
  ZentaoSearch.attach('bugSearchInput', 'bug');
});

// 搜索任务（本地，禅道搜索不可用时的退路）
async function handleSearch() {
  const keyword = document.getElementById('searchInput').value.trim();

  if (!keyword) {
    await loadTasks();
    return;
  }

  try {
    const response = await fetch(`${API_BASE_URL}/api/tasks/search?q=${encodeURIComponent(keyword)}`);
    const result = await response.json();

    if (result.success) {
      allTasks = carryOverSyncState(result.data);
      renderTasks();
    }
  } catch (err) {
    console.warn('搜索失败:', err);
  }
}

// 显示任务详情
function showTaskDetail(task) {
  const modal = document.getElementById('taskModal');
  const body = document.getElementById('modalBody');

  const statusLabels = { todo: '待办', in_progress: '进行中', done: '已完成' };

  // 优先级相关
  const priority = task.priority ?? 3;
  const priorityColors = {
    1: { bg: '#fee2e2', text: '#dc2626' },
    2: { bg: '#fef3c7', text: '#d97706' },
    3: { bg: '#dbeafe', text: '#2563eb' },
    4: { bg: '#f3f4f6', text: '#6b7280' }
  };
  const pColor = priorityColors[priority] || priorityColors[3];

  // 构建进度更新历史HTML
  let progressUpdatesHtml = '';
  if (task.progressUpdates && task.progressUpdates.length > 0) {
    progressUpdatesHtml = `
      <div style="margin-top: 16px;">
        <h4 style="margin-bottom: 8px; font-size: 14px; color: #333;">📊 进度更新记录</h4>
        <div style="max-height: 200px; overflow-y: auto; background: #f9f9f9; border-radius: 6px; padding: 12px;">
          ${task.progressUpdates.slice().reverse().map((update, idx) => `
            <div style="padding: 10px; margin-bottom: ${idx < task.progressUpdates.length - 1 ? '8px' : '0'}; background: white; border-radius: 4px; border-left: 3px solid #3b82f6;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                <span style="font-size: 12px; color: #6b7280;">${new Date(update.timestamp).toLocaleString('zh-CN')}</span>
                <span style="font-size: 13px; font-weight: 600; color: #3b82f6;">
                  ${update.oldProgress ?? 0}% → ${update.progress}%
                </span>
              </div>
              ${update.workContent ? `<div style="font-size: 13px; color: #333; margin-bottom: 4px; white-space: pre-wrap;">${escapeHtml(update.workContent)}</div>` : ''}
              ${update.consumedTime ? `<div style="font-size: 12px; color: #10b981;">⏱ 消耗工时: ${update.consumedTime}h</div>` : ''}
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  body.innerHTML = `
    <div style="margin-bottom: 16px;">
      <div style="display:flex; align-items:center; gap:12px; margin-bottom:12px;">
        <h4 id="detailTaskTitle" style="margin:0; flex:1; cursor: pointer; padding: 4px 8px; border-radius: 4px; transition: background 0.2s;" title="点击编辑标题" data-task-id="${task.id}">${escapeHtml(task.title)}</h4>
        ${task.status !== 'done' ? `
        <div class="detail-priority-selector" style="position:relative;">
          <button class="detail-priority-btn" data-priority="${priority}"
            style="background:${pColor.bg}; color:${pColor.text}; padding:6px 12px; border-radius:6px; font-size:12px; font-weight:600; border:none; cursor:pointer;">
            P${priority} ▼
          </button>
          <div class="detail-priority-menu" style="display:none; position:absolute; top:100%; right:0; margin-top:4px; background:white; border:1px solid #e2e8f0; border-radius:6px; box-shadow:0 4px 12px rgba(0,0,0,0.1); z-index:100; min-width:60px; padding:4px 0;">
            ${priority !== 1 ? `<div class="detail-priority-option" data-priority="1" style="padding:8px 16px; cursor:pointer; font-size:13px; font-weight:500; color:#dc2626; text-align:center;">P1</div>` : ''}
            ${priority !== 2 ? `<div class="detail-priority-option" data-priority="2" style="padding:8px 16px; cursor:pointer; font-size:13px; font-weight:500; color:#d97706; text-align:center;">P2</div>` : ''}
            ${priority !== 3 ? `<div class="detail-priority-option" data-priority="3" style="padding:8px 16px; cursor:pointer; font-size:13px; font-weight:500; color:#2563eb; text-align:center;">P3</div>` : ''}
            ${priority !== 4 ? `<div class="detail-priority-option" data-priority="4" style="padding:8px 16px; cursor:pointer; font-size:13px; font-weight:500; color:#6b7280; text-align:center;">P4</div>` : ''}
          </div>
        </div>
        ` : ''}
      </div>
      <div style="background-color: #f9f9f9; padding: 10px; border-radius: 6px; margin-bottom: 12px;">
        <strong style="font-size: 13px; color: #555;">原始输入内容:</strong>
        <p style="color: #666; margin-top: 6px; font-size: 14px; white-space: pre-wrap;">${escapeHtml(task.content || task.title)}</p>
      </div>
    </div>
    <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 16px;">
      <div><strong>状态:</strong> ${statusLabels[task.status]}</div>
      ${task.status !== 'done' ? `<div><strong>${task.status === 'in_progress' ? '截止时间' : '提醒时间'}:</strong> ${task.reminderTime ? new Date(task.reminderTime).toLocaleString('zh-CN') : '未设置'}</div>` : ''}
      <div><strong>进度:</strong> ${task.progress ?? 0}%</div>
      <div><strong>创建时间:</strong> ${task.zentaoId && task.openedAt ? escapeHtml(task.openedAt) : new Date(task.createdAt).toLocaleString('zh-CN')}</div>
      ${task.zentaoId && task.editedAt ? `<div><strong>最后修改:</strong> ${escapeHtml(task.editedAt)}</div>` : ''}
    </div>
    ${progressUpdatesHtml}
    <div class="att-section" style="margin: 16px 0;"></div>
    <div style="display: flex; gap: 8px;">
      ${task.status !== 'done' ? `<button class="btn-primary detail-action-btn" data-action="done">标记完成</button>` : ''}
      <button class="btn-secondary detail-action-btn" style="border-color: #e74c3c; color: #e74c3c;" data-action="delete">删除</button>
    </div>
  `;

  // 绑定优先级选择事件
  const priorityBtn = body.querySelector('.detail-priority-btn');
  const priorityMenu = body.querySelector('.detail-priority-menu');

  if (priorityBtn && priorityMenu) {
    priorityBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      priorityMenu.style.display = priorityMenu.style.display === 'none' ? 'block' : 'none';
    });

    priorityMenu.querySelectorAll('.detail-priority-option').forEach(option => {
      option.addEventListener('click', (e) => {
        e.stopPropagation();
        const newPriority = parseInt(e.currentTarget.dataset.priority);
        updateTaskPriority(task.id, newPriority);
        priorityMenu.style.display = 'none';
        // 刷新弹窗内容
        setTimeout(() => {
          // 重新获取任务数据
          fetch(`${API_BASE_URL}/api/tasks`)
            .then(r => r.json())
            .then(result => {
              if (result.success) {
                const updatedTask = result.data.find(t => t.id === task.id);
                if (updatedTask) {
                  showTaskDetail(updatedTask);
                }
              }
            });
        }, 100);
      });
      option.addEventListener('mouseenter', () => {
        option.style.background = '#f1f5f9';
      });
      option.addEventListener('mouseleave', () => {
        option.style.background = 'transparent';
      });
    });

    // 点击弹窗其他地方关闭菜单
    modal.addEventListener('click', (e) => {
      if (!e.target.closest('.detail-priority-selector')) {
        priorityMenu.style.display = 'none';
      }
    });
  }

  // 绑定事件解决 CSP 内联执行阻断问题
  body.querySelectorAll('.detail-action-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      handleTaskAction(task.id, btn.dataset.action);
      document.getElementById('taskModal').classList.remove('active');
    });
  });

  // 绑定标题点击编辑事件
  const detailTitle = body.querySelector('#detailTaskTitle');
  if (detailTitle) {
    detailTitle.addEventListener('click', (e) => {
      const taskId = e.currentTarget.dataset.taskId;
      makeTitleInlineEdit(e.currentTarget, taskId);
    });
    detailTitle.addEventListener('mouseenter', () => {
      detailTitle.style.background = '#f1f5f9';
    });
    detailTitle.addEventListener('mouseleave', () => {
      detailTitle.style.background = 'transparent';
    });
  }

  // 附件区：预览、下载、追加（可直接粘贴截图）、删除、重试
  if (typeof AttachmentPanel !== 'undefined') {
    AttachmentPanel.mount(body.querySelector('.att-section'), task, { onChanged: () => loadTasks().catch(() => { }) });
  }

  modal.classList.add('active');
}

// 加载历史日报预览
async function loadHistoryPreview() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/history?limit=5`);
    const result = await response.json();

    if (result.success && result.data.length > 0) {
      const container = document.getElementById('historyPreview');
      if (container) {
        container.innerHTML = result.data.map(item => `
          <div class="history-item">
            <div class="history-date">${item.date}</div>
            <div>${item.summary || `完成 ${item.stats?.done || 0} 项任务`}</div>
          </div>
        `).join('');
      }
    }
  } catch (err) {
    console.warn('加载历史失败:', err);
  }
}

// 工具函数
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 获取禅道任务URL
function getZentaoTaskUrl(taskId) {
  // 禅道地址取自设置缓存（以后端为准，静默校对）
  const baseUrl = (ConfigStore.flat().zentaoUrl || '').replace(/\/$/, '');
  return baseUrl ? `${baseUrl}/zentao/task-view-${taskId}.html` : `#`;
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

let activeDatetimeTask = null;

/**
 * 进行中任务的「截止时间」推送到禅道任务的截止日期（禅道只有日期，时间部分丢掉）
 * 「提醒时间」（未开始的任务）只是本地提醒，不推送
 * @param {string} value - datetime-local 的值，空串 = 清除截止日期
 */
function syncDeadlineToZentao(task, value) {
  if (task.type === 'bug' || task.status !== 'in_progress' || !task.zentaoId) return;
  OptimisticUI.trackSync({
    taskId: task.id,
    successMessage: () => (value ? '截止日期已同步到禅道' : '已清除禅道里的截止日期'),
    failureMessage: (res) => `本地已保存，但截止日期同步禅道失败：${OptimisticUI.explainFailure(res)}`,
    syncFn: () => ZentaoBrowserClient.editTask({
      zentaoId: task.zentaoId,
      execution: task.zentaoExecution || task.executionId,
      deadline: value || ''
    })
  });
}

function openDatetimeModal(task) {
  activeDatetimeTask = task;
  const modal = document.getElementById('datetimeModal');
  const input = document.getElementById('dtModalInput');
  const title = document.getElementById('dtModalTitle');

  title.textContent = task.status === 'in_progress' ? '设置截止时间' : '设置提醒时间';

  // Set current value
  if (task.reminderTime) {
    const dt = new Date(task.reminderTime);
    const tzOffset = dt.getTimezoneOffset() * 60000;
    const localISOTime = new Date(dt.getTime() - tzOffset).toISOString().slice(0, 16);
    input.value = localISOTime;
  } else {
    input.value = '';
  }

  // Quick buttons
  document.getElementById('dtBtnTomorrow').onclick = () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(d.getHours(), 0, 0, 0); // round to current hour
    input.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };

  document.getElementById('dtBtnThisWeek').onclick = () => {
    const d = new Date();
    const day = d.getDay();
    // 计算本周日：0=周日时不变，其他情况加 (7-day) 天
    const diff = d.getDate() + (day === 0 ? 0 : (7 - day));
    d.setDate(diff);
    d.setHours(18, 0, 0, 0); // 18:00 on Sunday
    input.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };

  document.getElementById('dtBtnThisMonth').onclick = () => {
    const d = new Date();
    d.setMonth(d.getMonth() + 1);
    d.setDate(0); // last day of month
    d.setHours(18, 0, 0, 0);
    input.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };

  // Confirm button
  document.getElementById('dtModalConfirmBtn').onclick = async () => {
    const val = input.value;
    let reminderTime = null;
    if (val) {
      const dt = new Date(val);
      reminderTime = dt.toISOString();
    }

    document.getElementById('dtModalConfirmBtn').textContent = '保存中...';
    try {
      const resp = await fetch(`${API_BASE_URL}/api/task/${task.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reminderTime })
      });
      const result = await resp.json().catch(() => ({}));
      if (!result.success) throw new Error(result.error || '保存失败');
      await loadTasks();
      modal.classList.remove('active');
      syncDeadlineToZentao(task, val);
    } catch (err) {
      console.warn('更新时间失败:', err);
      Toast.error(`更新时间失败：${err.message}`);
    } finally {
      document.getElementById('dtModalConfirmBtn').textContent = '确定保存';
    }
  };

  modal.classList.add('active');
}


// ==================== 设置相关函数 ====================

// 预设配置
const CONFIG_PRESETS = {
  zhipu: {
    apiKey: '',
    apiBaseUrl: 'https://open.bigmodel.cn/api/paas/v4/',
    aiModel: 'glm-4-flash',
    aiProvider: 'zhipu'
  },
  openai: {
    apiKey: '',
    apiBaseUrl: 'https://api.openai.com/v1',
    aiModel: 'gpt-4o-mini',
    aiProvider: 'openai'
  }
};

// 加载设置
// ============================================================================
// 提示词（添加任务分析 / 日报 / 周报 / 月报）
// 说明：提示词已并入设置面板，不再有独立弹窗；
//      读写通过顶层 loadPrompts / savePrompts，与主配置共用「保存配置」入口。
// ============================================================================
let defaultSummaryPrompt = '';
let defaultAddTaskPrompt = '';

/**
 * 拉取后端提示词：默认值 + 当前自定义值。
 * 输入框展示「自定义值」，为空时回落到默认值（让用户能看到默认文案长什么样）。
 */
async function loadPrompts() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/prompts`);
    const result = await response.json();
    if (!result.success) return;
    defaultSummaryPrompt = (result.data.default && result.data.default.summary) || '';
    defaultAddTaskPrompt = (result.data.default && result.data.default.addTask) || '';
    const custom = result.data.custom || {};
    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.value = val;
    };
    setVal('promptAddTask', custom.addTask || defaultAddTaskPrompt);
    setVal('promptDaily', custom.daily || defaultSummaryPrompt);
    setVal('promptWeekly', custom.weekly || defaultSummaryPrompt);
    setVal('promptMonthly', custom.monthly || defaultSummaryPrompt);
  } catch (err) {
    console.warn('获取提示词失败:', err);
  } finally {
    // 提示词是异步回填的，填完必须重设基线，否则会被误判成「未保存的修改」
    if (window.settingsUI) window.settingsUI.refreshBaseline();
  }
}

/**
 * 保存提示词。
 * 与默认值完全相同的输入按「空字符串」提交，让后端继续使用默认提示词，
 * 避免把整段默认文案固化进用户配置、日后无法随版本升级。
 */
async function savePrompts() {
  const read = (id) => {
    const el = document.getElementById(id);
    return el ? el.value.trim() : '';
  };
  let addTaskVal = read('promptAddTask');
  let dailyVal = read('promptDaily');
  let weeklyVal = read('promptWeekly');
  let monthlyVal = read('promptMonthly');

  if (addTaskVal === defaultAddTaskPrompt) addTaskVal = '';
  if (dailyVal === defaultSummaryPrompt) dailyVal = '';
  if (weeklyVal === defaultSummaryPrompt) weeklyVal = '';
  if (monthlyVal === defaultSummaryPrompt) monthlyVal = '';

  const response = await fetch(`${API_BASE_URL}/api/prompts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ addTask: addTaskVal, daily: dailyVal, weekly: weeklyVal, monthly: monthlyVal })
  });
  const result = await response.json();
  if (!result.success) throw new Error(result.error || '保存提示词失败');
}

/**
 * 打开设置弹窗（可直接定位到某个分组，如 'p-data'）
 * 右上角头像菜单、登录卡片「导入配置」、AI 未配置提示等都从这里进
 */
function openSettingsModal(group) {
  ConfigStore.hold(false);   // 上次点过「恢复默认」又没保存就关了：这次重新以后端为准
  loadSettings();
  ConfigStore.sync();   // 静默校对；变了且你还没改内容，会自动刷新表单
  document.getElementById('settingsModal').classList.add('active');
  checkServiceStatus();
  setTimeout(() => ExecutionFavorites.loadFavorites(), 100);
  if (group && window.settingsUI) window.settingsUI.showGroup(group);
}

function loadSettings() {
  // 先用缓存（打开即有值），后端的设置变了会静默校对后自动刷新；缓存还是空的（第一次）用预设
  const cached = ConfigStore.flat();
  const config = Object.keys(cached).length ? cached : { ...CONFIG_PRESETS.zhipu };

  // 安全获取元素并设置值
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  };

  setVal('aiProvider', config.aiProvider || 'zhipu');
  // Key 只保存在后端（按接口地址分别保存），不回显
  setVal('apiKey', '');
  setVal('apiBaseUrl', config.apiBaseUrl || CONFIG_PRESETS.zhipu.apiBaseUrl);
  setVal('aiModel', config.aiModel || CONFIG_PRESETS.zhipu.aiModel);
  setVal('aiReportModel', config.aiReportModel || '');
  AiModelPicker.init(config);
  setVal('morningHour', config.morningHour || 9);
  setVal('eveningHour', config.eveningHour || 21);
  setVal('workHours', config.workHours || 8);
  setVal('workHolidays', config.workHolidays || '');
  setVal('workMakeup', config.workMakeup || '');
  const afc = config.autofill || {};
  setVal('afMaxTasks', afc.maxTasksPerDay || 3);
  setVal('afMinChunk', afc.minChunk || 1);
  setVal('afMaxChunk', afc.maxChunk || 4);
  setVal('afMaxDays', afc.maxDaysPerTask || 8);
  setVal('afMaxOvertime', afc.maxOvertime !== undefined ? afc.maxOvertime : 2);
  setVal('afPrompt', afc.prompt || '');
  setVal('webhookUrl', config.webhookUrl || '');
  setVal('webhookType', config.webhookType || 'generic');

  // 加载禅道配置
  const zentaoEnabled = document.getElementById('zentaoEnabled');
  if (zentaoEnabled) {
    zentaoEnabled.checked = config.zentaoEnabled || false;
  }
  setVal('zentaoUrl', config.zentaoUrl || '');
  setVal('zentaoUsername', config.zentaoUsername || '');
  // 禅道密码只存在后端，不回显；是否已保存由 loadZentaoConfigStatus 按后端状态提示
  setVal('zentaoPassword', '');
  setVal('zentaoCreateTaskUrl', config.zentaoCreateTaskUrl || '');

  // 同步调试模式复选框状态
  const debugModeToggle = document.getElementById('debugModeToggle');
  if (debugModeToggle) {
    debugModeToggle.checked = debugMode;
  }

  // 动态更新关于页面的版本号（以 manifest 真实版本为准）
  const aboutVerEl = document.getElementById('aboutVersionDesc');
  if (aboutVerEl) {
    const manifestVer = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest)
      ? chrome.runtime.getManifest().version
      : '1.1.0';
    aboutVerEl.textContent = `禅道助手 v${manifestVer}`;
  }

  // 提示词与主配置不在同一接口，单独拉取（完成后会刷新「已保存」基线）
  loadPrompts();


  // 加载禅道配置状态（异步回填，完成后会刷新基线）
  loadZentaoConfigStatus();
  if (typeof ReportMembersPicker !== 'undefined') ReportMembersPicker.load();

  // 交给设置页 UI 层：回到默认分组并记录「已保存」基线
  if (window.settingsUI) window.settingsUI.onOpen();
}

// 加载禅道配置状态
// 加载禅道配置状态
async function loadZentaoConfigStatus() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/zentao/config`);
    if (response.ok) {
      const result = await response.json();
      if (result.success && result.data) {
        console.log('[前端] 禅道配置状态:', result.data);
        // 禅道操作全部由后端用 .env 里的配置完成，以后端为准回填
        // （以前只在浏览器缓存里没有地址时才回填，密码「已保存」的提示也就不出现，看起来像没填密码）
        const d = result.data;
        const setIf = (id, v) => { const el = document.getElementById(id); if (el && v) el.value = v; };
        const enabledEl = document.getElementById('zentaoEnabled');
        if (enabledEl) enabledEl.checked = !!d.enabled;
        // 后端回传的字段是 url（以前读不存在的 urlPrefix，回填成空，一保存设置就把禅道地址清空）
        setIf('zentaoUrl', d.url);
        setIf('zentaoUsername', d.username);
        const execEl = document.getElementById('zentaoCreateTaskUrl');
        if (execEl) execEl.value = d.createTaskUrl || '';
        // 后端不回传密码；已保存时给出提示，留空保存即保持不变
        const pwEl = document.getElementById('zentaoPassword');
        if (pwEl) pwEl.placeholder = d.hasPassword ? '已保存（留空表示不修改）' : '请输入禅道密码';
      }
    }
  } catch (err) {
    console.log('[前端] 获取禅道配置状态失败（可能后端未启动）');
  } finally {
    // 异步回填完成后重设基线，避免刚打开设置就被判定为「未保存的修改」
    if (window.settingsUI) window.settingsUI.refreshBaseline();
  }
}

// 检查服务状态
// 说明：完整实现（状态卡 + 启动/停止）见文件后段 checkServiceStatus()，
// 此处原有的精简版已移除，避免重复声明。

// ==================== 拖拽排序控制 ====================
function bindDragAndDrop() {
  const lists = ['todoList', 'inProgressList', 'doneList'];

  lists.forEach(listId => {
    const list = document.getElementById(listId);

    list.addEventListener('dragover', e => {
      e.preventDefault();
      const afterElement = getDragAfterElement(list, e.clientY);
      const draggable = document.querySelector('.dragging');
      if (!draggable) return;
      if (afterElement == null) {
        list.appendChild(draggable);
      } else {
        list.insertBefore(draggable, afterElement);
      }
    });

    list.addEventListener('drop', e => {
      e.preventDefault();
      setTimeout(handleDragEnd, 50);
    });
  });
}

function getDragAfterElement(container, y) {
  const draggableElements = [...container.querySelectorAll('.task-card:not(.dragging)')];

  return draggableElements.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) {
      return { offset: offset, element: child };
    } else {
      return closest;
    }
  }, { offset: Number.NEGATIVE_INFINITY }).element;
}

async function handleDragEnd() {
  // 找出被拖拽的任务（状态或列发生变化的任务）
  const draggedTask = findDraggedTask();
  if (!draggedTask) {
    // 没有任务被拖拽到不同列，只更新排序
    await updateTaskOrder();
    renderTasks();
    updateCounts();
    return;
  }

  const { taskId, oldStatus, oldProgress, newStatus, newProgress, card, oldListId } = draggedTask;
  console.log('[Drag] 检测到被拖拽的任务:', { taskId, oldStatus, oldProgress, newStatus, newProgress });

  // 如果进度有变化，调用 updateTaskProgress
  if (newProgress !== oldProgress) {
    // 确保 allTasks 中的任务状态和进度保持原值
    const task = allTasks.find(t => t.id === taskId);
    if (task) {
      task.status = oldStatus;
      task.progress = oldProgress;
    }

    const result = await updateTaskProgress(taskId, newProgress);
    if (result === false) {
      // 用户取消，将卡片移回原来的列
      console.log('[Drag] 用户取消，将卡片移回原位置');
      const oldList = document.getElementById(oldListId);
      if (oldList && card) {
        // 移回原来的列
        oldList.appendChild(card);
      }
      // 恢复本地任务状态
      if (task) {
        task.status = oldStatus;
        task.progress = oldProgress;
      }
      return;
    }
  }

  // 用户确认或进度没变化，更新排序
  await updateTaskOrder();
  await loadTasks();
  updateCounts();
}

// 找出被拖拽的任务（状态或列发生变化的任务）
function findDraggedTask() {
  for (const listId of ['todoList', 'inProgressList', 'doneList']) {
    const listStatus = listId === 'todoList' ? 'todo' : (listId === 'inProgressList' ? 'in_progress' : 'done');
    const cards = document.getElementById(listId).querySelectorAll('.task-card');

    for (const card of cards) {
      const taskId = card.dataset.taskId;
      const task = allTasks.find(t => t.id === taskId);
      if (!task) continue;

      // 如果任务状态与所在列的状态不同，说明这个任务被拖拽了
      if (task.status !== listStatus) {
        let newProgress = task.progress;

        // 计算新进度
        if (listStatus === 'in_progress') newProgress = 10;
        else if (listStatus === 'done') newProgress = 100;
        else if (listStatus === 'todo') newProgress = 0;

        // 找到原始列的 ID
        let oldListId;
        if (task.status === 'todo') oldListId = 'todoList';
        else if (task.status === 'in_progress') oldListId = 'inProgressList';
        else oldListId = 'doneList';

        return {
          taskId,
          oldStatus: task.status,
          oldProgress: task.progress,
          newStatus: listStatus,
          newProgress,
          card,
          oldListId
        };
      }
    }
  }
  return null;
}

// 更新所有任务的排序
async function updateTaskOrder() {
  const updates = [];
  let indexCounter = 0;

  ['todoList', 'inProgressList', 'doneList'].forEach(listId => {
    const cards = document.getElementById(listId).querySelectorAll('.task-card');

    cards.forEach(card => {
      const taskId = card.dataset.taskId;
      const task = allTasks.find(t => t.id === taskId);
      if (!task) return;

      updates.push({
        id: taskId,
        order: indexCounter++,
        status: task.status,
        progress: task.progress
      });
    });
  });

  if (updates.length > 0) {
    try {
      await fetch(`${API_BASE_URL}/api/tasks/batch`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates })
      });
    } catch (err) {
      console.warn('批量更新排序失败:', err);
    }
  }
}

// ==================== 禅道数据提取纯函数 ====================

/**
 * 从禅道团队页面提取用户数据的纯函数
 * 这个函数会被注入到禅道页面执行，必须是纯函数（不能引用外部变量）
 * 参考 Gemini 方案设计
 * @returns {Object} { status: 'success'|'error'|'fatal', count: number, data: Object, message?: string }
 */
function scrapeUserDataFromZentao() {
  // 收集所有日志信息，返回给主调用方
  const logs = [];

  function log(msg, ...args) {
    logs.push({ msg, args });
  }

  try {
    log('[scrapeUserData] 开始提取用户数据');
    log('[scrapeUserData] 当前页面 URL:', window.location.href);
    log('[scrapeUserData] 当前页面标题:', document.title);

    // 查找 iframe
    const iframe = document.getElementById('appIframe-system');
    log('[scrapeUserData] iframe #appIframe-system 存在:', !!iframe);

    if (!iframe) {
      return {
        status: 'error',
        message: '未找到 iframe #appIframe-system',
        data: {},
        logs: logs
      };
    }

    // 获取 iframe 的 document
    let iframeDoc;
    try {
      iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
      log('[scrapeUserData] 成功获取 iframe document');
    } catch (e) {
      log('[scrapeUserData] 获取 iframe document 失败:', e.toString());
      return {
        status: 'error',
        message: '无法访问 iframe document（可能是跨域限制）',
        data: {},
        logs: logs
      };
    }

    // 在 iframe document 中查找 #userList
    const userTable = iframeDoc.getElementById('userList');
    log('[scrapeUserData] iframe 中 #userList 元素存在:', !!userTable);

    if (!userTable) {
      // 打印 iframe 中所有 id 以便调试
      const iframeElementsWithId = iframeDoc.querySelectorAll('[id]');
      const iframeIds = Array.from(iframeElementsWithId).map(el => el.id);
      log('[scrapeUserData] iframe 中所有带 id 的元素（前 50 个）:', iframeIds.slice(0, 50));
      log('[scrapeUserData] iframe 中包含 "user" 的 id:', iframeIds.filter(id => id.toLowerCase().includes('user')));

      return {
        status: 'error',
        message: 'iframe 中未找到 #userList 元素',
        data: {},
        logs: logs
      };
    }

    const tbody = userTable.querySelector('tbody');
    log('[scrapeUserData] tbody 元素存在:', !!tbody);

    if (!tbody) {
      return {
        status: 'error',
        message: '找到表格但未找到 tbody 元素',
        data: {},
        logs: logs
      };
    }

    const rows = tbody.querySelectorAll('tr');
    log('[scrapeUserData] 找到表格行数:', rows.length);

    const users = {};
    const usersList = [];

    Array.from(rows).forEach((row, index) => {
      const tds = row.querySelectorAll('td');

      if (tds.length < 3) {
        log(`[scrapeUserData] 第 ${index} 行单元格数量不足: ${tds.length}`);
        return;
      }

      // 提取单元格文本内容
      const getText = (idx) => tds[idx] ? tds[idx].textContent.trim() : '';

      const no = getText(0);      // 序号
      const name = getText(1);    // 姓名
      const account = getText(2); // 用户名

      log(`[scrapeUserData] 行 ${index}: no=${no}, name=${name}, account=${account}`);

      // 过滤表头和无效数据
      if (name && account &&
          name !== '姓名' &&
          account !== '用户名' &&
          account !== 'account' &&
          !no.includes('共')) {
        users[account] = name;
        usersList.push({ no, name, account });
      }
    });

    const userCount = Object.keys(users).length;
    log('[scrapeUserData] 提取成功，用户数量:', userCount);

    if (userCount > 0) {
      return {
        status: 'success',
        count: userCount,
        data: users,
        list: usersList,
        logs: logs
      };
    } else {
      return {
        status: 'error',
        message: '表格存在但未提取到有效用户数据',
        data: {},
        logs: logs
      };
    }
  } catch (error) {
    log('[scrapeUserData] 提取过程发生错误:', error.toString());
    return {
      status: 'fatal',
      message: error.toString(),
      data: {},
      logs: logs
    };
  }
}

// ==================== 禅道浏览器客户端 ====================

/**
 * 禅道浏览器客户端
 * 利用浏览器的登录状态直接调用禅道 API
 */
const ZentaoBrowserClient = {
  config: null,
  users: {}, // 用户列表缓存 {account: name}
  usersLoaded: false, // 用户列表是否已加载

  /**
   * 初始化。用户列表以后端为准（data/zentao-users.json），前端不再留本地副本，用到时再向后端要
   */
  init() {},

  /**
   * 初始化配置（每次都重新获取，确保使用最新配置）
   */
  async initConfig() {
    try {
      const response = await fetch(`${API_BASE_URL}/api/zentao/config`);
      const result = await response.json();
      if (result.success) {
        this.config = result.data;
      }
    } catch (err) {
      console.warn('[ZentaoBrowser] 获取配置失败:', err);
    }
    return this.config;
  },

  /**
   * 获取禅道基础 URL
   */
  getBaseUrl() {
    return this.config?.url?.replace(/\/$/, '') || '';
  },

  /**
   * 检查是否已配置
   */
  isConfigured() {
    return this.config?.enabled && this.config.url && this.config.username;
  },

  /**
   * 让后端从禅道重新拉取团队成员（我的地盘 → 团队），失败时退回后端缓存
   */
  async refreshUsersFromZentao() {
    try {
      const resp = await fetch(`${API_BASE_URL}/api/zentao/users/refresh`, { method: 'POST' });
      const result = await resp.json();
      if (result.success && result.data && Object.keys(result.data).length > 0) {
        this.users = result.data;
        this.usersLoaded = true;
        return this.users;
      }
      console.warn('[ZentaoBrowser] 从禅道刷新用户列表失败:', result.message || result.error);
    } catch (err) {
      console.warn('[ZentaoBrowser] 从禅道刷新用户列表异常:', err.message);
    }
    const cached = await this.loadUsersFromBackend();
    return Object.keys(cached).length > 0 ? cached : (this.users || {});
  },

  /**
   * 从后端加载用户列表
   */
  async loadUsersFromBackend() {
    try {
      console.log('[ZentaoBrowser] 从后端加载用户列表...');
      const response = await fetch(`${API_BASE_URL}/api/zentao/users`);
      const result = await response.json();
      if (result.success && result.data && Object.keys(result.data).length > 0) {
        this.users = result.data;
        this.usersLoaded = true;
        console.log('[ZentaoBrowser] ✓ 从后端加载用户列表成功:', Object.keys(this.users).length, '个用户');
        return this.users;
      } else {
        console.log('[ZentaoBrowser] 后端暂无用户列表数据');
        return {};
      }
    } catch (err) {
      console.error('[ZentaoBrowser] 从后端加载用户列表异常:', err.message);
      return {};
    }
  },

  /**
   * 获取用户列表（供外部调用）
   * 优先从内存获取，如果没有则从后端加载
   */
  async getUsers() {
    // 内存中没有用户列表时从后端取
    if (!this.usersLoaded || Object.keys(this.users).length === 0) {
      // 从后端加载
      if (Object.keys(this.users).length === 0) {
        const backendUsers = await this.loadUsersFromBackend();
        if (Object.keys(backendUsers).length > 0) {
          return backendUsers;
        }
      }
    }
    return this.users;
  },


  /**
   * 创建任务
   * @param {Object} taskData - 任务数据
   * @param {string} [taskData.executionId] - 可选的执行 ID，如果不传则使用全局配置
   * @param {string} [taskData.executionType] - 执行类型 (kanban/sprint/stage)，可选
   */
  async createTask(taskData) {
    await this.initConfig();

    if (!this.isConfigured()) {
      console.log('[ZentaoBrowser] 禅道未配置或不完整');
      return { success: false, reason: 'not_configured' };
    }

    // 优先使用传入的执行 ID，否则使用全局配置
    const executionId = taskData.executionId || this.config.createTaskUrl || '';
    console.log('[ZentaoBrowser] 创建任务使用的执行 ID:', {
      fromTaskData: taskData.executionId,
      fromConfig: this.config.createTaskUrl,
      final: executionId
    });
    if (!executionId || executionId === '0') {
      console.warn('[ZentaoBrowser] 未配置 execution ID:', executionId);
      return { success: false, reason: 'invalid_execution_id' };
    }

    // 检查执行类型，如果是看板则使用看板API
    let executionType = taskData.executionType;

    // 如果 taskData 中没有执行类型，尝试从缓存的执行列表中获取
    if (!executionType) {
      executionType = ExecutionFavorites.getExecutionType(executionId);
      console.log('[ZentaoBrowser] 从缓存获取执行类型:', executionId, '=>', executionType);
    }

    let useKanbanAPI = executionType === 'kanban';

    // 自动检测执行类型：如果本地类型不是看板，尝试获取看板视图来判断
    // 这样可以解决本地数据中 type 字段不准确的问题
    if (!useKanbanAPI) {
      console.log('[ZentaoBrowser] 本地类型不是看板(', executionType, ')，尝试自动检测...');
      const quickCheck = await this.quickCheckKanban(executionId);
      if (quickCheck.isKanban) {
        console.log('[ZentaoBrowser] ✓ 检测到看板类型，使用看板API');
        useKanbanAPI = true;
      } else {
        console.log('[ZentaoBrowser] × 不是看板类型，使用普通任务API，原因:', quickCheck.reason);
      }
    }

    // 如果是看板类型，尝试获取看板视图信息
    if (useKanbanAPI) {
      console.log('[ZentaoBrowser] 使用看板API创建卡片');

      // 看板需要额外的参数：regionId, groupId, columnId
      // 这些必须是数字ID，需要先从看板视图中获取
      let regionId = taskData.regionId;
      let groupId = taskData.groupId;
      let columnId = taskData.columnId;

      // 如果没有提供这些参数，先获取看板视图来获取正确的参数
      if (!regionId || !groupId || !columnId || columnId === 'backlog') {
        console.log('[ZentaoBrowser] 看板参数不完整，从看板页面HTML解析...');

        // 使用HTML解析方式获取看板参数
        const htmlParams = await this.getKanbanParamsFromHtml(executionId, 'task', 'wait');

        if (htmlParams) {
          regionId = htmlParams.regionId;
          groupId = htmlParams.laneId;   // laneId 对应 groupId
          columnId = htmlParams.columnId;
          console.log('[ZentaoBrowser] 从HTML解析成功获取到参数:', { regionId, groupId, columnId });
        } else {
          console.warn('[ZentaoBrowser] HTML解析失败，使用默认值');
          regionId = regionId || '20';
          groupId = groupId || '117';
          columnId = columnId || '1047';
        }
      }

      console.log('[ZentaoBrowser] 最终使用的看板参数:', { regionId, groupId, columnId });

      // 使用 task-create 接口创建看板任务
      const kanbanResult = await this.createKanbanTask({
        executionId,
        regionId,
        laneId: groupId,  // groupId 对应 laneID
        columnId,
        taskData
      });

      console.log('[ZentaoBrowser] 看板任务创建结果:', kanbanResult);

      // 看板任务创建失败，直接返回错误（不降级）
      if (!kanbanResult.success) {
        console.error('[ZentaoBrowser] ✗ 看板任务创建失败:', kanbanResult.reason);
        return { success: false, reason: kanbanResult.reason || '看板任务创建失败' };
      }

      // 看板任务创建成功，返回结果
      console.log('[ZentaoBrowser] ✓ 看板任务创建成功:', kanbanResult);
      return kanbanResult;
    }

    // 普通任务（阶段/迭代）使用原有API
    // 包括：看板任务失败后的降级情况
    const username = this.config.username || 'admin';
    const baseUrl = this.getBaseUrl();

    console.log('[ZentaoBrowser] 准备创建任务:', taskData.title, '执行 ID:', executionId);

    try {
      // 通过 background.js 在禅道页面中执行请求
      const result = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'executeInZentaoPage',
          baseUrl,
          executionId,
          username,
          taskData
        }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[ZentaoBrowser] Background 通信失败:', chrome.runtime.lastError.message);
            resolve({ success: false, reason: 'background_error' });
          } else if (response) {
            resolve(response);
          } else {
            console.warn('[ZentaoBrowser] Background 未返回响应');
            resolve({ success: false, reason: 'no_response' });
          }
        });
      });

      if (!result.success) {
        console.warn('[ZentaoBrowser] 创建任务失败:', result.reason);
        return result;
      }

      // 后端直连返回 { success, taskId, duplicate, message }
      if (result.taskId) {
        console.log('[ZentaoBrowser] ✓ 任务创建成功，taskId:', result.taskId);
        return { success: true, taskId: parseInt(result.taskId, 10) };
      }
      console.warn('[ZentaoBrowser] 创建任务未返回任务ID:', result);
      return { success: false, reason: result.reason || result.message || 'unrecognized_response' };
    } catch (err) {
      console.warn('[ZentaoBrowser] 创建任务异常:', err.message);
      return { success: false, reason: err.message };
    }
  },

  /**
   * 更新任务状态
   * @param {string} taskId - 任务ID
   * @param {string} status - 状态 (todo/in_progress/done)
   * @param {number} progress - 进度 (0-100)
   * @param {Object} options - 可选参数
   * @param {string} options.executionType - 执行类型 (kanban/sprint/stage)
   * @param {string} options.kanbanId - 看板ID（如果是看板类型）
   */
  async updateTaskStatus(taskId, status, progress, options = {}) {
    await this.initConfig();

    if (!this.isConfigured()) {
      return { success: false, reason: 'not_configured' };
    }

    // 如果是看板类型，使用看板API
    if (options.executionType === 'kanban') {
      console.log('[ZentaoBrowser] 更新看板卡片状态:', { taskId, status, kanbanId: options.kanbanId });
      return await this.updateKanbanCardStatus({
        cardId: taskId,
        kanbanId: options.kanbanId || taskId,  // 看板ID通常就是执行ID
        status
      });
    }

    // 普通任务（阶段/迭代）使用原有API
    const statusMap = {
      'done': 'closed',
      'in_progress': 'doing',
      'todo': 'wait'
    };

    const zentaoStatus = statusMap[status] || 'wait';
    const baseUrl = this.getBaseUrl();

    console.log('[ZentaoBrowser] 更新任务状态:', { taskId, status: zentaoStatus, progress });

    try {
      // 通过 background.js 在禅道页面中执行
      const result = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'updateZentaoTaskStatus',
          baseUrl,
          taskId,
          status: zentaoStatus
        }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[ZentaoBrowser] Background 通信失败:', chrome.runtime.lastError.message);
            resolve({ success: false, reason: 'background_error' });
          } else if (response) {
            resolve(response);
          } else {
            console.warn('[ZentaoBrowser] Background 未返回响应');
            resolve({ success: false, reason: 'no_response' });
          }
        });
      });

      return result;
    } catch (err) {
      console.warn('[ZentaoBrowser] 更新状态异常:', err.message);
      return { success: false, reason: err.message };
    }
  },

  /**
   * 记录工时 (Effort)
   */
  async recordEffort(taskId, comment, consumedTime, leftTime = 0, kanbanId = null, progress = null) {
    await this.initConfig();

    if (!this.isConfigured()) {
      return { success: false, reason: 'not_configured' };
    }

    const baseUrl = this.getBaseUrl();

    console.log(`[ZentaoBrowser] 记录工时 (Task ID: ${taskId}): consumed=${consumedTime}, comment=${comment}, kanbanId=${kanbanId}, progress=${progress}`);

    try {
      // 通过 background.js 在禅道页面中执行
      const result = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'recordZentaoEffort',
          baseUrl,
          taskId,
          comment,
          consumedTime,
          leftTime,
          kanbanId,
          progress
        }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[ZentaoBrowser] Background 通信失败:', chrome.runtime.lastError.message);
            resolve({ success: false, reason: 'background_error' });
          } else if (response) {
            resolve(response);
          } else {
            console.warn('[ZentaoBrowser] Background 未返回响应');
            resolve({ success: false, reason: 'no_response' });
          }
        });
      });

      return result;
    } catch (err) {
      console.warn('[ZentaoBrowser] 记录工时异常:', err.message);
      return { success: false, reason: err.message };
    }
  },

  /**
   * 删除禅道任务
   */
  async deleteZentaoTask(zentaoId) {
    await this.initConfig();

    if (!this.isConfigured()) {
      return { success: false, reason: 'not_configured' };
    }

    const executionId = this.config.createTaskUrl || '';
    if (!executionId || executionId === '0') {
      return { success: false, reason: 'invalid_execution_id' };
    }
    const baseUrl = this.getBaseUrl();

    console.log('[ZentaoBrowser] 准备删除禅道任务:', { executionId, zentaoId });

    try {
      // 通过 background.js 在禅道页面中执行
      const result = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'deleteZentaoTask',
          baseUrl,
          executionId,
          zentaoId
        }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[ZentaoBrowser] Background 通信失败:', chrome.runtime.lastError.message);
            resolve({ success: false, reason: 'background_error' });
          } else if (response) {
            resolve(response);
          } else {
            console.warn('[ZentaoBrowser] Background 未返回响应');
            resolve({ success: false, reason: 'no_response' });
          }
        });
      });

      return result;
    } catch (err) {
      console.warn('[ZentaoBrowser] 删除禅道任务异常:', err.message);
      return { success: false, reason: err.message };
    }
  },

  /**
   * 编辑禅道任务（修改标题、优先级等）
   * @param {Object} options - 编辑选项
   * @param {string} options.zentaoId - 禅道任务ID
   * @param {string} options.execution - 执行ID
   * @param {string} [options.name] - 任务标题
   * @param {number} [options.pri] - 优先级 (1-4)
   * @param {string} [options.deadline] - 截止时间（只取日期；空串 = 清除，不传 = 不改）
   */
  async editTask({ zentaoId, execution, name, pri, deadline }) {
    await this.initConfig();

    if (!this.isConfigured()) {
      return { success: false, reason: 'not_configured' };
    }

    const baseUrl = this.getBaseUrl();
    const username = this.config.username || 'admin';

    console.log('[ZentaoBrowser] 准备编辑禅道任务:', { zentaoId, execution, name, pri, deadline, username });

    try {
      // 通过 background.js 在禅道页面中执行
      const result = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'editZentaoTask',
          baseUrl,
          taskId: zentaoId,
          execution,
          name: name || '',
          // 没传就不改：以前默认 3，改个标题会把禅道里的优先级也改成 3
          pri: pri || '',
          deadline,
          username
        }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[ZentaoBrowser] Background 通信失败:', chrome.runtime.lastError.message);
            resolve({ success: false, reason: 'background_error' });
          } else if (response) {
            resolve(response);
          } else {
            console.warn('[ZentaoBrowser] Background 未返回响应');
            resolve({ success: false, reason: 'no_response' });
          }
        });
      });

      return result;
    } catch (err) {
      console.warn('[ZentaoBrowser] 编辑禅道任务异常:', err.message);
      return { success: false, reason: err.message };
    }
  },

  /**
   * 创建看板卡片
   * @param {Object} options - 创建选项
   * @param {string} options.kanbanId - 看板ID
   * @param {string} options.regionId - 区域ID
   * @param {string} options.groupId - 分组ID
   * @param {string} options.columnId - 列ID
   * @param {Object} options.taskData - 任务数据
   */
  async createKanbanCard({ kanbanId, regionId, groupId, columnId, taskData }) {
    await this.initConfig();

    if (!this.isConfigured()) {
      return { success: false, reason: 'not_configured' };
    }

    const baseUrl = this.getBaseUrl();

    console.log('[ZentaoBrowser] 准备创建看板卡片:', { kanbanId, regionId, groupId, columnId, taskData });

    try {
      const result = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'createKanbanCard',
          baseUrl,
          kanbanId,
          regionId,
          groupId,
          columnId,
          taskData
        }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[ZentaoBrowser] Background 通信失败:', chrome.runtime.lastError.message);
            resolve({ success: false, reason: 'background_error' });
          } else if (response) {
            console.log('[ZentaoBrowser] Background 返回完整结果:', response);
            resolve(response);
          } else {
            console.warn('[ZentaoBrowser] Background 未返回响应');
            resolve({ success: false, reason: 'no_response' });
          }
        });
      });

      // 如果创建成功，添加看板URL用于跳转
      if (result.success) {
        result.kanbanUrl = `${baseUrl}/zentao/kanban-view-${kanbanId}.html`;
      }

      return result;
    } catch (err) {
      console.warn('[ZentaoBrowser] 创建看板卡片异常:', err.message);
      return { success: false, reason: err.message };
    }
  },

  /**
   * 使用 task-create 接口创建看板任务
   * @param {Object} options - 创建选项
   * @param {string} options.executionId - 执行ID
   * @param {string} options.regionId - 区域ID
   * @param {string} options.laneId - 泳道ID
   * @param {string} options.columnId - 列ID
   * @param {Object} options.taskData - 任务数据
   */
  async createKanbanTask({ executionId, regionId, laneId, columnId, taskData }) {
    await this.initConfig();

    if (!this.isConfigured()) {
      return { success: false, reason: 'not_configured' };
    }

    const baseUrl = this.getBaseUrl();
    const username = this.config.username || '';

    // 默认指派给自己
    if (username && !taskData.assignedTo) {
      taskData.assignedTo = username;
    }

    console.log('[ZentaoBrowser] 准备创建看板任务 (task-create接口):', {
      executionId, regionId, laneId, columnId, taskData, assignedTo: taskData.assignedTo
    });

    try {
      const result = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'createKanbanTask',
          baseUrl,
          executionId,
          regionId,
          laneId,
          columnId,
          taskData
        }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[ZentaoBrowser] Background 通信失败:', chrome.runtime.lastError.message);
            resolve({ success: false, reason: 'background_error' });
          } else if (response) {
            console.log('[ZentaoBrowser] Background 返回完整结果:', response);
            resolve(response);
          } else {
            console.warn('[ZentaoBrowser] Background 未返回响应');
            resolve({ success: false, reason: 'no_response' });
          }
        });
      });

      // 如果创建成功，添加看板URL用于跳转
      if (result.success) {
        result.kanbanUrl = `${baseUrl}/zentao/kanban-view-${executionId}.html`;
      }

      return result;
    } catch (err) {
      console.warn('[ZentaoBrowser] 创建看板任务异常:', err.message);
      return { success: false, reason: err.message };
    }
  },

  /**
   * 更新看板卡片状态
   * @param {Object} options - 更新选项
   * @param {string} options.cardId - 卡片ID
   * @param {string} options.kanbanId - 看板ID
   * @param {string} options.status - 状态 (todo/in_progress/done)
   */
  async updateKanbanCardStatus({ cardId, kanbanId, status }) {
    await this.initConfig();

    if (!this.isConfigured()) {
      return { success: false, reason: 'not_configured' };
    }

    const baseUrl = this.getBaseUrl();

    console.log('[ZentaoBrowser] 准备更新看板卡片状态:', { cardId, kanbanId, status });

    try {
      const result = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'updateKanbanCardStatus',
          baseUrl,
          cardId,
          kanbanId,
          status
        }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[ZentaoBrowser] Background 通信失败:', chrome.runtime.lastError.message);
            resolve({ success: false, reason: 'background_error' });
          } else if (response) {
            resolve(response);
          } else {
            console.warn('[ZentaoBrowser] Background 未返回响应');
            resolve({ success: false, reason: 'no_response' });
          }
        });
      });

      return result;
    } catch (err) {
      console.warn('[ZentaoBrowser] 更新看板卡片状态异常:', err.message);
      return { success: false, reason: err.message };
    }
  },

  /**
   * 快速检测执行是否为看板类型
   * 通过尝试获取看板视图来判断，如果返回有效的看板数据则是看板类型
   * @param {string} executionId - 执行ID
   * @returns {Promise<Object>} { isKanban: boolean, reason?: string }
   */
  async quickCheckKanban(executionId) {
    try {
      await this.initConfig();
      if (!this.isConfigured()) {
        return { isKanban: false, reason: 'not_configured' };
      }

      const baseUrl = this.getBaseUrl();
      const result = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'quickCheckKanban',
          baseUrl,
          executionId
        }, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ isKanban: false, reason: 'background_error' });
          } else {
            resolve(response);
          }
        });
      });

      return result || { isKanban: false, reason: 'no_response' };
    } catch (err) {
      console.warn('[ZentaoBrowser] 快速检测看板异常:', err.message);
      return { isKanban: false, reason: err.message };
    }
  },

  /**
   * 获取看板视图
   * @param {string} kanbanId - 看板ID
   * @returns {Promise<Object>} 看板视图数据
   */
  async getKanbanView(kanbanId) {
    await this.initConfig();

    if (!this.isConfigured()) {
      return { success: false, reason: 'not_configured' };
    }

    const baseUrl = this.getBaseUrl();
    console.log('[ZentaoBrowser] 获取看板视图:', kanbanId);

    try {
      // 使用 background.js 在禅道页面中执行请求
      const result = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'getKanbanView',
          baseUrl,
          kanbanId
        }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[ZentaoBrowser] Background 通信失败:', chrome.runtime.lastError.message);
            resolve({ success: false, reason: 'background_error' });
          } else if (response) {
            resolve(response);
          } else {
            console.warn('[ZentaoBrowser] Background 未返回响应');
            resolve({ success: false, reason: 'no_response' });
          }
        });
      });

      console.log('[ZentaoBrowser] 看板视图数据:', result);
      return result;
    } catch (err) {
      console.warn('[ZentaoBrowser] 获取看板视图异常:', err.message);
      return null;
    }
  },

  /**
   * 从看板页面HTML中解析 regionId、laneId、columnId
   * @param {number|string} executionId - 执行ID
   * @param {string} [laneType='task'] - 泳道类型 ('task'=任务, 'story'=研发需求, 'bug'=Bug)
   * @param {string} [columnType='wait'] - 列类型 ('wait'=未开始, 'developing'=研发中 等)
   * @returns {Promise<{regionId?: string, laneId?: string, columnId?: string} | null>}
   */
  async getKanbanParamsFromHtml(executionId, laneType = 'task', columnType = 'wait') {
    await this.initConfig();

    if (!this.isConfigured()) {
      console.warn('[ZentaoBrowser] 禅道未配置');
      return null;
    }

    const baseUrl = this.getBaseUrl();
    // 根据类型访问不同的看板页面：bug 类型访问 bug 看板，task 类型访问主看板
    const kanbanUrl = laneType === 'bug'
      ? `${baseUrl}/zentao/execution-kanban-${executionId}-bug.html`
      : `${baseUrl}/zentao/execution-kanban-${executionId}.html`;

    console.log('[ZentaoBrowser] 从看板页面DOM获取参数:', { executionId, laneType, columnType, url: kanbanUrl });

    try {
      // 使用 background.js 在禅道页面中执行请求
      const result = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'fetchKanbanPage',
          url: kanbanUrl,
          laneType: laneType,
          columnType: columnType
        }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[ZentaoBrowser] Background 通信失败:', chrome.runtime.lastError.message);
            resolve(null);
          } else {
            resolve(response);
          }
        });
      });

      if (!result || !result.success) {
        console.warn('[ZentaoBrowser] 获取看板参数失败:', result?.reason);
        if (result?.debug) {
          console.log('[ZentaoBrowser] 调试信息:', result.debug);
        }
        return null;
      }

      // 新的格式直接返回解析好的参数
      const { productId, projectId, regionId, laneId, columnId } = result;
      console.log('[ZentaoBrowser] 解析成功:', {
        productId,    // 产品ID，用于URL (67)
        projectId,    // 项目ID，用于表单 (130)
        regionId, laneId, columnId
      });

      return {
        productId: productId ? String(productId) : null,    // 产品ID
        projectId: projectId ? String(projectId) : null,    // 项目ID
        regionId: String(regionId),
        laneId: String(laneId),
        columnId: String(columnId)
      };
    } catch (err) {
      console.error('[ZentaoBrowser] 解析看板参数失败:', err.message);
      return null;
    }
  }
};

// ==================== 执行选择器管理 ====================

const ExecutionSelector = {
  executions: [],
  favoriteExecutions: [],
  currentExecutionId: null,

  /**
   * 初始化：加载执行列表（云标签筛选等处要用）
   *
   * 侧栏「添加任务 / 提交 Bug」上方的「所属执行」选择卡片已去掉：执行默认由 AI 推断，
   * 需要指定时在弹出的表单里选。没有选择框时 getSelectedExecution() 返回 null，即交给 AI。
   */
  async init() {
    await this.loadExecutions();
  },

  /**
   * 从后端获取禅道配置
   */
  async getZentaoConfig() {
    try {
      const response = await fetch(`${API_BASE_URL}/api/zentao/config`);
      const result = await response.json();
      return result.success ? result.data : null;
    } catch (err) {
      console.error('[ExecutionSelector] 获取禅道配置失败:', err);
      return null;
    }
  },

  /**
   * 加载执行列表（只加载收藏的执行用于选择器）
   */
  async loadExecutions() {
    try {
      // 同时获取所有执行和收藏的执行
      const [allResp, favResp] = await Promise.all([
        fetch(`${API_BASE_URL}/api/executions`),
        fetch(`${API_BASE_URL}/api/executions/favorites`)
      ]);

      const allResult = await allResp.json();
      const favResult = await favResp.json();

      if (allResult.success && allResult.data) {
        this.executions = allResult.data;
      }
      if (favResult.success && favResult.data) {
        this.favoriteExecutions = favResult.data;
        console.log('[ExecutionSelector] ========== 收藏的执行列表 ==========');
        console.log('[ExecutionSelector] 收藏数量:', this.favoriteExecutions.length, '个');
        this.favoriteExecutions.forEach((exec, index) => {
          console.log(`[ExecutionSelector] ${index + 1}. ID: ${exec.id} | 名称: ${exec.name} | 项目: ${exec.projectName || '未设置'}`);
        });
        console.log('[ExecutionSelector] ======================================');
      }
      this.populateSelect();
    } catch (err) {
      console.error('[ExecutionSelector] 加载执行列表失败:', err);
    }
  },

  /**
   * 从禅道同步执行列表
   * 使用和设置中相同的同步逻辑，保留用户收藏的执行
   */
  async refreshExecutions() {
    const refreshBtn = document.getElementById('refreshExecutionsBtn');
    const select = document.getElementById('executionSelect');
    const aiIndicator = document.getElementById('aiIndicator');

    try {
      // 显示加载状态
      if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.style.opacity = '0.5';
      }

      // 使用 ExecutionFavorites 的同步方法（和设置中的同步保持一致）
      await ExecutionFavorites.syncExecutions();

      // 同步后重新加载执行列表
      await this.loadExecutions();

      // 恢复之前的选择
      const currentValue = select?.value;
      if (currentValue && currentValue !== 'no-favorites') {
        select.value = currentValue;
      }

    } catch (err) {
      console.error('[ExecutionSelector] 同步执行列表失败:', err);
      Toast.error('同步失败: ' + err.message);
    } finally {
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.style.opacity = '1';
      }
    }
  },

  /**
   * 填充执行选择器（只显示收藏的执行）
   */
  populateSelect() {
    const select = document.getElementById('executionSelect');
    if (!select) return;

    // 保存当前选择
    const currentValue = select.value;

    // 清空选项
    select.innerHTML = '';

    // 添加"自动选择"选项（默认选中）
    const autoOption = document.createElement('option');
    autoOption.value = '';
    autoOption.textContent = '自动选择 (AI分析)';
    select.appendChild(autoOption);

    // 只显示收藏的执行
    if (this.favoriteExecutions.length === 0) {
      // 没有收藏的执行时显示提示
      const hintOption = document.createElement('option');
      hintOption.value = 'no-favorites';
      hintOption.textContent = '请先在设置中收藏执行';
      hintOption.disabled = true;
      hintOption.style.color = '#999';
      select.appendChild(hintOption);
    } else {
      // 添加收藏的执行，格式：项目名称 - 执行名称
      this.favoriteExecutions.forEach(exec => {
        const option = document.createElement('option');
        option.value = exec.id;
        const projectPrefix = exec.projectName || '未分类';
        option.textContent = `${projectPrefix} - ${exec.name}`;
        if (exec.isDefault) {
          option.textContent += ' (默认)';
        }
        select.appendChild(option);
      });
    }

    // 恢复选择或默认选中"自动选择"
    if (currentValue && currentValue !== 'no-favorites' && this.favoriteExecutions.some(e => e.id === currentValue)) {
      select.value = currentValue;
    } else {
      // 默认选中"自动选择"
      select.value = '';
    }
  },

  /**
   * 获取当前选择的执行ID
   */
  getSelectedExecution() {
    const select = document.getElementById('executionSelect');
    if (!select) return null;
    const value = select.value;
    // 排除提示选项
    if (value === 'no-favorites') return null;
    return value || null;
  },

  /**
   * 设置执行ID
   */
  setExecution(executionId) {
    const select = document.getElementById('executionSelect');
    if (select && executionId) {
      select.value = executionId;
    }
  }
};

// 在页面加载时初始化执行选择器
document.addEventListener('DOMContentLoaded', () => {
  ExecutionSelector.init();
});

// ==================== 云标签筛选 ====================

const TagCloud = {
  isOpen: false,
  activeExecutionId: null,
  executionCounts: {},

  /**
   * 初始化云标签
   */
  init() {
    const toggle = document.getElementById('tagCloudToggle');
    const refreshBtn = document.getElementById('refreshTagsBtn');
    const tagCloud = document.getElementById('tagCloud');

    if (!tagCloud) return;

    // 切换按钮事件
    if (toggle) {
      toggle.addEventListener('click', () => this.toggle());
    }

    // 刷新按钮事件
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => this.refresh());
    }

    // 初始化时加载执行列表和计数
    this.updateExecutionCounts();
    this.renderTags();
  },

  /**
   * 切换云标签显示/隐藏
   */
  toggle() {
    const tagCloud = document.getElementById('tagCloud');
    if (!tagCloud) return;

    this.isOpen = !this.isOpen;
    if (this.isOpen) {
      tagCloud.classList.remove('collapsed');
    } else {
      tagCloud.classList.add('collapsed');
    }
  },

  /**
   * 更新执行计数
   */
  updateExecutionCounts() {
    // 获取所有任务并统计每个执行的任务数量
    const taskCards = document.querySelectorAll('.task-card');
    this.executionCounts = { all: taskCards.length };

    taskCards.forEach(card => {
      const taskId = card.dataset.taskId;
      // 从全局任务列表中获取任务
      const task = window.allTasks?.find(t => t.id === taskId);
      if (task && task.executionId) {
        this.executionCounts[task.executionId] = (this.executionCounts[task.executionId] || 0) + 1;
      }
    });
  },

  /**
   * 渲染标签列表
   */
  async renderTags() {
    const tagList = document.getElementById('tagList');
    if (!tagList) return;

    // 获取执行列表
    const executions = ExecutionSelector.executions;

    let html = '';

    // 添加"全部"选项
    const allCount = this.executionCounts.all || 0;
    html += `
      <div class="tag-item ${!this.activeExecutionId ? 'active' : ''}" data-execution-id="">
        <span class="tag-item-name">全部任务</span>
        <span class="tag-item-count">${allCount}</span>
      </div>
    `;

    // 添加执行选项
    for (const exec of executions) {
      const count = this.executionCounts[exec.id] || 0;
      html += `
        <div class="tag-item ${this.activeExecutionId === exec.id ? 'active' : ''}" data-execution-id="${exec.id}">
          <span class="tag-item-name">${escapeHtml(exec.name)}</span>
          <span class="tag-item-count">${count}</span>
        </div>
      `;
    }

    tagList.innerHTML = html;

    // 绑定点击事件
    tagList.querySelectorAll('.tag-item').forEach(item => {
      item.addEventListener('click', () => {
        const executionId = item.dataset.executionId;
        this.filterByExecution(executionId);
      });
    });
  },

  /**
   * 按执行筛选任务
   */
  filterByExecution(executionId) {
    this.activeExecutionId = executionId || null;

    // 更新标签高亮
    const tagList = document.getElementById('tagList');
    if (tagList) {
      tagList.querySelectorAll('.tag-item').forEach(item => {
        if (item.dataset.executionId === (executionId || '')) {
          item.classList.add('active');
        } else {
          item.classList.remove('active');
        }
      });
    }

    // 筛选任务卡片
    const taskCards = document.querySelectorAll('.task-card');
    taskCards.forEach(card => {
      const taskId = card.dataset.taskId;
      const task = window.allTasks?.find(t => t.id === taskId);

      if (!executionId) {
        // 显示全部
        card.style.display = '';
      } else if (task && task.executionId === executionId) {
        card.style.display = '';
      } else {
        card.style.display = 'none';
      }
    });
  },

  /**
   * 清除筛选
   */
  clearFilter() {
    this.filterByExecution('');
  },

  /**
   * 刷新云标签
   */
  async refresh() {
    await ExecutionSelector.refreshExecutions();
    this.updateExecutionCounts();
    this.renderTags();
    Toast.success('标签已刷新');
  }
};

// 在页面加载时初始化云标签（已删除功能）
// document.addEventListener('DOMContentLoaded', () => {
//   TagCloud.init();
// });

// ==================== Bug 模式切换 ====================

// ==================== BugMode 已移除 ====================
// 旧的 BugMode 系统已被 TabSwitcher 替代
// 现在使用独立的 taskMode/bugMode 内容区域进行切换

// ==================== Tab 切换 ====================

const TabSwitcher = {
  currentMode: 'todo', // 'todo' | 'task' | 'bug' | 'story' | 'report' | 'doc'

  init() {
    const tabButtons = document.querySelectorAll('.tab-btn');
    tabButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        this.switchMode(mode);
      });
    });
    // 恢复上次选择的标签页
    const lastMode = localStorage.getItem('lastTabMode') || 'todo';
    this.switchMode(lastMode);
    // 待办角标：启动时取一次，之后每 5 分钟刷新
    if (typeof TodoPage !== 'undefined') {
      TodoPage.refreshBadge();
      setInterval(() => TodoPage.refreshBadge(), 5 * 60 * 1000);
    }
  },

  switchMode(mode) {
    this.currentMode = mode;

    // 1. 保存标签页选择
    localStorage.setItem('lastTabMode', mode);

    // 回到任务页：日历的热度跟着本地任务走（补填工时、别处同步之后会变），切回来时重取一次
    if (mode === 'task' && typeof loadCalendar === 'function') loadCalendar().catch(() => {});

    // 2. 更新 Tab 按钮
    document.querySelectorAll('.tab-btn').forEach(btn => {
      if (btn.dataset.mode === mode) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    // 3. 更新主内容区域
    document.querySelectorAll('.mode-content').forEach(content => {
      if (content.id === `${mode}Mode`) {
        content.classList.add('active');
      } else {
        content.classList.remove('active');
      }
    });

    // 4. 处理左侧区域的显示状态和标题更新
    // 4.1 更新左侧标题
    const addTaskTitle = document.querySelector('.add-task-title');
    if (addTaskTitle) {
      addTaskTitle.textContent = mode === 'bug' ? '🐛 快速提交 Bug' : '📝 添加任务';
    }

    // 4.2 更新提示文字
    const addTaskHint = document.querySelector('.add-task-hint');
    if (addTaskHint) {
      addTaskHint.textContent = mode === 'bug' ? '选择执行后，输入 Bug 描述，按回车提交' : '按回车添加 · Shift+回车换行';
    }

    // 4.4 输入框在两种模式下都显示
    const taskInputWrapper = document.querySelector('.task-input-wrapper');
    if (taskInputWrapper) {
      taskInputWrapper.style.display = '';
    }

    // 4.5 更新输入框 placeholder
    const taskInput = document.getElementById('taskInput');
    if (taskInput) {
      taskInput.placeholder = mode === 'bug' ? '描述 Bug 现象...' : ' ';
    }

    // 4.6 处理整个 add-task-form 区域（兼容 Gemini 的代码）
    const addTaskForm = document.getElementById('addTaskForm');
    if (addTaskForm) {
      addTaskForm.style.display = ''; // 两种模式都显示
    }

    // 5. 优化：加载对应模式的数据
    if (mode === 'report') {
      if (typeof ReportPage !== 'undefined') ReportPage.show();
    } else if (mode === 'doc') {
      if (typeof DocPage !== 'undefined') DocPage.show();
    } else if (mode === 'story') {
      if (typeof StoryPage !== 'undefined') StoryPage.show();
    } else if (mode === 'todo') {
      if (typeof TodoPage !== 'undefined') TodoPage.show();
    } else if (mode === 'bug') {
      if (typeof BugManager !== 'undefined' && BugManager.loadBugs) {
        BugManager.loadBugs();
      }
    } else if (mode === 'task') {
      // 切换回任务模式时，如果本地已有数据，直接通过 renderTasks 更新 DOM，更加流畅
      // 避免不必要的全量 HTTP 刷新请求
      if (typeof renderTasks === 'function' && window.allTasks && window.allTasks.length > 0) {
        renderTasks();
      } else if (typeof loadTasks === 'function') {
        loadTasks();
      }
    }
  }
};

// 在页面加载时初始化 Tab 切换
document.addEventListener('DOMContentLoaded', () => {
  TabSwitcher.init();
});

// ==================== 执行收藏管理 ====================

const ExecutionFavorites = {
  executions: [],
  favoriteIds: [],
  showClosed: false,  // 默认不显示已关闭的执行

  init() {
    const syncBtn = document.getElementById('syncExecutionsBtn');
    if (syncBtn) {
      syncBtn.addEventListener('click', () => this.syncExecutions());
    }

    // 绑定"显示已关闭执行"复选框事件
    const showClosedCheckbox = document.getElementById('showClosedExecutions');
    if (showClosedCheckbox) {
      showClosedCheckbox.addEventListener('change', (e) => {
        this.showClosed = e.target.checked;
        this.renderExecutionList();
      });
    }

    // 加载收藏列表
    this.loadFavorites();
  },

  /**
   * 根据执行ID获取执行类型
   * @param {string} executionId - 执行ID
   * @returns {string|null} 执行类型 (kanban/sprint/stage) 或 null
   */
  getExecutionType(executionId) {
    if (!executionId || !this.executions || this.executions.length === 0) {
      return null;
    }
    const exec = this.executions.find(e => String(e.id) === String(executionId));
    return exec ? exec.type : null;
  },

  async loadFavorites() {
    try {
      // 加载完整的执行列表
      const execResponse = await fetch(`${API_BASE_URL}/api/executions`);
      const execResult = await execResponse.json();
      if (execResult.success && execResult.data) {
        this.executions = execResult.data;
        console.log('[ExecutionFavorites] 加载执行列表成功，数量:', this.executions.length);
        console.log('[ExecutionFavorites] 执行类型分布:', this.executions.reduce((acc, ex) => {
          acc[ex.type] = (acc[ex.type] || 0) + 1;
          return acc;
        }, {}));
      }

      // 加载收藏的ID列表
      const favResponse = await fetch(`${API_BASE_URL}/api/executions/favorites`);
      const favResult = await favResponse.json();
      if (favResult.success) {
        this.favoriteIds = favResult.data.map(e => e.id);
      }

      // 渲染列表
      this.renderExecutionList();
    } catch (err) {
      console.error('[ExecutionFavorites] 加载收藏执行失败:', err);
    }
  },

  async syncExecutions() {
    const syncBtn = document.getElementById('syncExecutionsBtn');
    const resultSpan = document.getElementById('syncExecutionsResult');

    try {
      syncBtn.disabled = true;
      syncBtn.textContent = '同步中...';
      resultSpan.textContent = '';

      // 后端直连禅道拉取执行列表并落盘（同时刷新项目列表）
      const saveResp = await fetch(`${API_BASE_URL}/api/executions/sync`, { method: 'POST' });
      const saveResult = await saveResp.json();
      const formattedExecutions = Array.isArray(saveResult.data) ? saveResult.data : [];

      if (saveResult.success) {
        this.executions = formattedExecutions;
        this.renderExecutionList();
        resultSpan.textContent = `已同步 ${formattedExecutions.length} 个执行`;
        resultSpan.style.color = 'var(--success)';
        Toast.success(`已同步 ${formattedExecutions.length} 个执行`);
      } else {
        throw new Error(saveResult.message || saveResult.error || '同步失败');
      }
    } catch (err) {
      console.error('[ExecutionFavorites] 同步执行失败:', err);
      resultSpan.textContent = '同步失败: ' + err.message;
      resultSpan.style.color = 'var(--danger)';
      Toast.error('同步失败: ' + err.message);
    } finally {
      syncBtn.disabled = false;
      syncBtn.textContent = '🔄 从禅道同步执行';
    }
  },

  renderExecutionList() {
    const listContainer = document.getElementById('executionFavoritesList');
    if (!listContainer) return;

    console.log('[ExecutionFavorites] renderExecutionList, 执行数量:', this.executions.length);
    console.log('[ExecutionFavorites] 前3个执行的type:', this.executions.slice(0, 3).map(e => ({ id: e.id, name: e.name, type: e.type })));

    if (this.executions.length === 0) {
      listContainer.innerHTML = '<p class="hint">暂无执行</p>';
      return;
    }

    // 按项目分组，只显示有项目信息的执行
    const grouped = {};
    this.executions.forEach(exec => {
      // 只处理有项目信息的执行
      if (exec.projectName && exec.projectName !== '未分类') {
        if (!grouped[exec.projectName]) {
          grouped[exec.projectName] = [];
        }
        grouped[exec.projectName].push(exec);
      }
    });

    if (Object.keys(grouped).length === 0) {
      listContainer.innerHTML = '<p class="hint">暂无执行（或执行项目信息未加载）</p>';
      return;
    }

    let html = '';
    // 按项目名称排序
    const sortedProjects = Object.keys(grouped).sort();

    sortedProjects.forEach(projectName => {
      let projectExecs = grouped[projectName];

      // 如果不显示已关闭的执行，过滤掉已关闭的
      if (!this.showClosed) {
        projectExecs = projectExecs.filter(exec => exec.status !== 'closed');
      }

      // 如果项目下没有执行（都已关闭），跳过该项目
      if (projectExecs.length === 0) {
        return;
      }

      html += `
        <div class="execution-group">
          <div class="execution-group-header">
            <span class="execution-group-name">${escapeHtml(projectName)}</span>
            <span class="execution-group-count">${projectExecs.length}</span>
          </div>
          <div class="execution-group-items">
      `;

      projectExecs.forEach(exec => {
        const isFavorite = this.favoriteIds.includes(exec.id);
        const statusClass = exec.status === 'closed' ? 'closed' : '';
        const statusText = exec.status === 'closed' ? '已关闭' : '进行中';

        // 执行类型标签
        const typeLabels = {
          'kanban': '<span class="execution-type-label execution-type-kanban">看板</span>',
          'sprint': '<span class="execution-type-label execution-type-sprint">迭代</span>',
          'stage': '<span class="execution-type-label execution-type-stage">阶段</span>'
        };
        const typeLabel = typeLabels[exec.type] || '';

        html += `
          <label class="project-favorite-item ${exec.status === 'closed' ? 'item-closed' : ''}">
            <input type="checkbox" value="${exec.id}" ${isFavorite ? 'checked' : ''}>
            <div class="execution-favorite-info">
              <span class="project-favorite-name">${escapeHtml(exec.name)}</span>
              ${typeLabel}
            </div>
            <span class="project-favorite-status ${statusClass}">${statusText}</span>
          </label>
        `;
      });

      html += `
          </div>
        </div>
      `;
    });

    // 如果没有任何项目显示
    if (html === '') {
      listContainer.innerHTML = '<p class="hint">暂无执行（所有执行已关闭）</p>';
      return;
    }

    listContainer.innerHTML = html;

    // 绑定复选框事件
    listContainer.querySelectorAll('input[type="checkbox"]').forEach(checkbox => {
      checkbox.addEventListener('change', () => this.updateFavorites());
    });
  },

  async updateFavorites() {
    const listContainer = document.getElementById('executionFavoritesList');
    const checkedIds = Array.from(listContainer.querySelectorAll('input[type="checkbox"]:checked'))
      .map(cb => cb.value);

    try {
      const response = await fetch(`${API_BASE_URL}/api/executions/favorites`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ executionIds: checkedIds })
      });
      const result = await response.json();

      if (result.success) {
        this.favoriteIds = checkedIds;
        Toast.success('收藏执行已更新');
        // 刷新执行选择器
        ExecutionSelector.loadExecutions();
      }
    } catch (err) {
      console.error('[ExecutionFavorites] 更新收藏失败:', err);
      Toast.error('更新收藏失败');
    }
  }
};


// ==================== Bug 管理 ====================

/** Bug 优先级 / 严重程度的可选值（卡片与详情共用） */
const BUG_PRIORITY_CHOICES = [
  { value: 1, label: 'P1', cls: 'bug-pri-1' }, { value: 2, label: 'P2', cls: 'bug-pri-2' },
  { value: 3, label: 'P3', cls: 'bug-pri-3' }, { value: 4, label: 'P4', cls: 'bug-pri-4' }
];
const BUG_SEVERITY_CHOICES = [
  { value: 1, label: '致命', cls: 'bug-severity-1' }, { value: 2, label: '严重', cls: 'bug-severity-2' },
  { value: 3, label: '一般', cls: 'bug-severity-3' }, { value: 4, label: '提示', cls: 'bug-severity-4' }
];
/** 看板三列对应的本地状态 */
const BUG_COLUMN_STATUS = { bugUnconfirmedList: 'unconfirmed', bugActivatedList: 'activated', bugClosedList: 'resolved' };

const BugManager = {
  bugs: [],
  draft: null,

  init() {
    // 加载草稿
    this.loadDraft();

    // 添加 Bug 按钮
    const addBugBtn = document.getElementById('addBugBtn');
    if (addBugBtn) {
      addBugBtn.addEventListener('click', () => this.showBugModal());
    }

    // 关闭 Bug 弹窗
    const closeBtn = document.getElementById('closeBugModal');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.requestCloseBugModal());
    }

    // 点击弹框外部关闭
    const bugModal = document.getElementById('bugModal');
    if (bugModal) {
      bugModal.addEventListener('click', (e) => {
        if (e.target === bugModal) {
          this.requestCloseBugModal();
        }
      });
    }

    // 截图 / 附件选择区：可在弹窗任意位置粘贴截图
    const attachmentsHost = document.getElementById('bugAttachments');
    if (attachmentsHost && bugModal && typeof AttachmentPicker !== 'undefined') {
      this.attachmentPicker = new AttachmentPicker(attachmentsHost, {
        hint: '单个文件不超过 50MB，最多 10 个；截图会同时插入禅道的重现步骤'
      });
      this.attachmentPicker.bindPaste(bugModal);
    }

    // 提交 Bug
    const submitBtn = document.getElementById('submitBugBtn');
    if (submitBtn) {
      submitBtn.addEventListener('click', () => this.submitBug());
    }

    // 自动保存草稿
    const bugInputs = ['bugTitle', 'bugSeverity', 'bugType', 'bugSteps'];
    bugInputs.forEach(id => {
      const input = document.getElementById(id);
      if (input) {
        input.addEventListener('input', () => this.saveDraftDebounced());
      }
    });

    // 项目选择改变时保存
    const bugProject = document.getElementById('bugProject');
    if (bugProject) {
      bugProject.addEventListener('change', () => this.saveDraftDebounced());
    }

    // Bug 详情弹窗关闭按钮
    const closeBugDetailBtn = document.getElementById('closeBugDetailModal');
    if (closeBugDetailBtn) {
      closeBugDetailBtn.addEventListener('click', () => this.hideBugDetail());
    }

    // 点击弹框外部关闭
    const bugDetailModal = document.getElementById('bugDetailModal');
    if (bugDetailModal) {
      bugDetailModal.addEventListener('click', (e) => {
        if (e.target === bugDetailModal) {
          this.hideBugDetail();
        }
      });
    }

    // Bug 修复弹窗关闭按钮
    const closeBugResolveBtn = document.getElementById('closeBugResolveModal');
    if (closeBugResolveBtn) {
      closeBugResolveBtn.addEventListener('click', () => this.hideResolveModal());
    }

    // 取消修复按钮
    const cancelResolveBtn = document.getElementById('cancelResolveBtn');
    if (cancelResolveBtn) {
      cancelResolveBtn.addEventListener('click', () => this.hideResolveModal());
    }

    // 点击弹框外部关闭
    const bugResolveModal = document.getElementById('bugResolveModal');
    if (bugResolveModal) {
      bugResolveModal.addEventListener('click', (e) => {
        if (e.target === bugResolveModal) {
          this.hideResolveModal();
        }
      });
    }

    // 确认修复按钮
    const confirmResolveBtn = document.getElementById('confirmResolveBtn');
    if (confirmResolveBtn) {
      confirmResolveBtn.addEventListener('click', () => {
        const modal = document.getElementById('bugResolveModal');
        const bugId = modal?.dataset.bugId;
        if (bugId) {
          this.resolveBug(bugId);
        }
      });
    }

    // Bug 激活弹窗关闭按钮
    const closeBugActivateBtn = document.getElementById('closeBugActivateModal');
    if (closeBugActivateBtn) {
      closeBugActivateBtn.addEventListener('click', () => this.hideActivateModal());
    }

    // 取消激活按钮
    const cancelActivateBtn = document.getElementById('cancelActivateBtn');
    if (cancelActivateBtn) {
      cancelActivateBtn.addEventListener('click', () => this.hideActivateModal());
    }

    // 点击弹框外部关闭
    const bugActivateModal = document.getElementById('bugActivateModal');
    if (bugActivateModal) {
      bugActivateModal.addEventListener('click', (e) => {
        if (e.target === bugActivateModal) {
          this.hideActivateModal();
        }
      });
    }

    // 确认激活按钮
    const confirmActivateBtn = document.getElementById('confirmActivateBtn');
    if (confirmActivateBtn) {
      confirmActivateBtn.addEventListener('click', () => this.confirmActivation());
    }

    // Bug 关闭弹窗关闭按钮
    const closeBugCloseBtn = document.getElementById('closeBugCloseModal');
    if (closeBugCloseBtn) {
      closeBugCloseBtn.addEventListener('click', () => this.hideCloseModal());
    }

    // 取消关闭按钮
    const cancelCloseBtn = document.getElementById('cancelCloseBtn');
    if (cancelCloseBtn) {
      cancelCloseBtn.addEventListener('click', () => this.hideCloseModal());
    }

    // 点击弹框外部关闭
    const bugCloseModal = document.getElementById('bugCloseModal');
    if (bugCloseModal) {
      bugCloseModal.addEventListener('click', (e) => {
        if (e.target === bugCloseModal) {
          this.hideCloseModal();
        }
      });
    }

    // 确认关闭按钮
    const confirmCloseBtn = document.getElementById('confirmCloseBtn');
    if (confirmCloseBtn) {
      confirmCloseBtn.addEventListener('click', () => {
        const modal = document.getElementById('bugCloseModal');
        const bugId = modal?.dataset.bugId;
        if (bugId) {
          this.closeBug(bugId);
        }
      });
    }
  },

  async loadBugs() {
    // 从本地或后端加载 Bug 列表
    console.log('[BugManager] ========== loadBugs 开始 ==========');
    try {
      // 先执行数据迁移（确保所有Bug都有必需的字段）
      try {
        const migrateResponse = await fetch(`${API_BASE_URL}/api/bugs/migrate`, {
          method: 'POST'
        });
        const migrateResult = await migrateResponse.json();
        if (migrateResult.success) {
          console.log('[BugManager] Bug数据迁移完成:', migrateResult.message);
        }
      } catch (err) {
        console.warn('[BugManager] Bug数据迁移失败（可忽略）:', err.message);
      }

      const response = await fetch(`${API_BASE_URL}/api/bugs`);
      const result = await response.json();
      console.log('[BugManager] API 响应 success:', result.success);

      if (result.success) {
        // 过滤掉已关闭的 Bug，只显示未确认、已激活、已解决三种状态
        this.bugs = (result.data || []).filter(bug => bug.status !== 'closed');
        console.log('[BugManager] 获取到的 Bug 数量:', this.bugs.length, '(已过滤 closed 状态)');

        // 详细打印每个 Bug 的信息
        this.bugs.forEach((bug, index) => {
          console.log(`[BugManager] Bug ${index + 1}:`, {
            id: bug.id,
            title: bug.title,
            type: bug.type,
            zentaoId: bug.zentaoId,
            status: bug.status,
            executionId: bug.executionId,
            projectId: bug.projectId
          });
        });

        // 统计不同类型的任务
        const bugCount = this.bugs.filter(t => t.type === 'bug').length;
        const taskCount = this.bugs.filter(t => t.type !== 'bug').length;
        console.log('[BugManager] type=bug 的数量:', bugCount);
        console.log('[BugManager] type!=bug 的数量:', taskCount);

        await this.renderBugs();
      } else {
        console.error('[BugManager] API 返回失败:', result.error);
      }
    } catch (err) {
      console.error('[BugManager] 加载 Bug 列表失败:', err);
    }
    console.log('[BugManager] ========== loadBugs 结束 ==========');
  },

  async renderBugs() {
    console.log('[BugManager] ========== renderBugs 开始 ==========');
    console.log('[BugManager] 待渲染的 Bug 数量:', this.bugs.length);

    // 检查是否有重复的 Bug（通过 id 去重）
    const uniqueBugs = [];
    const seenIds = new Set();
    for (const bug of this.bugs) {
      if (!seenIds.has(bug.id)) {
        seenIds.add(bug.id);
        uniqueBugs.push(bug);
      } else {
        console.warn('[BugManager] ⚠ 发现重复 Bug:', bug.id, bug.title);
      }
    }
    if (uniqueBugs.length !== this.bugs.length) {
      console.error('[BugManager] ✗ 发现重复 Bug，已去重:', {
        原始数量: this.bugs.length,
        去重后数量: uniqueBugs.length
      });
      this.bugs = uniqueBugs;
    }

    this.bindBugDropZones();

    // 渲染 Bug 到各个列
    const unconfirmedList = document.getElementById('bugUnconfirmedList');
    const activatedList = document.getElementById('bugActivatedList');
    const closedList = document.getElementById('bugClosedList');

    console.log('[BugManager] 列容器查找结果:', {
      unconfirmed: !!unconfirmedList,
      activated: !!activatedList,
      closed: !!closedList
    });

    if (!unconfirmedList || !activatedList || !closedList) {
      console.error('[BugManager] ✗ Bug 列容器未找到，无法渲染');
      return;
    }

    // 清空列表
    unconfirmedList.innerHTML = '';
    activatedList.innerHTML = '';
    closedList.innerHTML = '';

    // 统计
    let unconfirmedCount = 0;
    let activatedCount = 0;
    let closedCount = 0;

    console.log('[BugManager] 开始遍历 Bug 并渲染...');

    // 使用 for...of 循环以便使用 await
    for (let index = 0; index < this.bugs.length; index++) {
      const bug = this.bugs[index];

      // 跳过已关闭的 Bug（双保险）
      if (bug.status === 'closed') {
        console.warn(`[BugManager] ⚠ 跳过已关闭的 Bug: ${bug.title}`);
        continue;
      }
      console.log(`[BugManager] 处理 Bug ${index + 1}:`, {
        id: bug.id,
        title: bug.title,
        type: bug.type,
        status: bug.status,
        zentaoId: bug.zentaoId
      });

      // 检查 Bug 的 type 字段
      if (bug.type !== 'bug') {
        console.warn(`[BugManager] ⚠ Bug ${index + 1} 的 type 不是 'bug':`, bug.type, bug.title);
      }

      const card = await this.createBugCard(bug);

      if (bug.status === 'unconfirmed') {
        unconfirmedList.appendChild(card);
        unconfirmedCount++;
        console.log(`[BugManager] → Bug "${bug.title}" 渲染到未确认列`);
      } else if (bug.status === 'activated') {
        activatedList.appendChild(card);
        activatedCount++;
        console.log(`[BugManager] → Bug "${bug.title}" 渲染到已确认列`);
      } else if (bug.status === 'resolved' || bug.status === 'closed') {
        // resolved 和 closed 状态都渲染到已解决列
        closedList.appendChild(card);
        closedCount++;
        console.log(`[BugManager] → Bug "${bug.title}" 渲染到已解决列 (状态: ${bug.status})`);
      } else {
        console.log(`[BugManager] → Bug "${bug.title}" 状态未知: ${bug.status}`);
      }
    }

    console.log('[BugManager] 渲染统计:', {
      unconfirmed: unconfirmedCount,
      activated: activatedCount,
      closed: closedCount,
      total: unconfirmedCount + activatedCount + closedCount
    });
    console.log('[BugManager] ========== renderBugs 结束 ==========');

    // 更新计数
    document.getElementById('bugUnconfirmedListCount').textContent = unconfirmedCount;
    document.getElementById('bugActivatedListCount').textContent = activatedCount;
    document.getElementById('bugClosedListCount').textContent = closedCount;
    document.getElementById('bugUnconfirmedCount').textContent = unconfirmedCount;
    document.getElementById('bugActivatedCount').textContent = activatedCount;
    document.getElementById('bugClosedCount').textContent = closedCount;
  },

  async createBugCard(bug) {
    const card = document.createElement('div');
    // 状态配色：已确认浅蓝、已解决浅绿（见 newtab.css 的 .bug-status-*）
    card.className = `task-card bug-card bug-status-${bug.status}`;
    card.dataset.bugId = bug.id;
    card.draggable = true;

    const severityClass = `bug-severity-${bug.severity || 3}`;
    const severityText = ['', '致命', '严重', '一般', '提示'][bug.severity || 3];

    // 获取用户列表用于显示名称（账号 -> 姓名的映射）
    const users = await ZentaoBrowserClient.getUsers() || {};

    // 调试日志
    console.log('[BugManager] createBugCard - Bug:', bug.id, 'assignedTo:', bug.assignedTo, 'users:', users);

    // 辅助函数：将用户账号或姓名转换为显示文本
    // 如果是账号（如 "lijc"），从 users 映射中查找姓名
    // 如果是姓名（如 "李佳成"），直接使用
    const getDisplayName = (user) => {
      if (!user) return '';
      // 如果已经在 users 映射中找到，说明是账号
      if (users[user]) {
        console.log('[BugManager] getDisplayName - 账号转姓名:', user, '->', users[user]);
        return users[user];
      }
      // 否则判断是否是账号（通常账号较短，不含中文）
      // 如果包含中文，认为是姓名，直接返回
      if (/[\u4e00-\u9fa5]/.test(user)) {
        console.log('[BugManager] getDisplayName - 已经是姓名:', user);
        return user;
      }
      // 否则返回原文
      console.log('[BugManager] getDisplayName - 无法识别，返回原文:', user);
      return user;
    };

    // 格式化指派人显示
    let assigneeDisplay = '';
    if (bug.assignedTo) {
      let assigneeNames = '';
      if (Array.isArray(bug.assignedTo)) {
        assigneeNames = bug.assignedTo.map(getDisplayName).filter(n => n).join(', ');
      } else {
        assigneeNames = getDisplayName(bug.assignedTo);
      }
      if (assigneeNames) {
        assigneeDisplay = `<button type="button" class="bug-assignee bug-assignee-btn" title="点击修改指派人">👤 ${escapeHtml(assigneeNames)}</button>`;
      }
    }
    if (!assigneeDisplay) {
      assigneeDisplay = '<button type="button" class="bug-assignee bug-assignee-btn is-empty" title="点击指派">👤 未指派</button>';
    }
    const priority = Number(bug.priority) || 3;
    const priorityBtn = `<button type="button" class="bug-priority-toggle bug-pri-${priority}" title="点击修改优先级">P${priority} <span class="bug-pri-caret">▼</span></button>`;

    // Bug ID 显示和链接（直接在标题后面）
    let bugIdSuffix = '';
    let addBugIdBtn = '';
    if (bug.zentaoId) {
      bugIdSuffix = ` <a class="bug-id-link-inline" href="#" role="button" data-bug-id="${bug.zentaoId}" title="在禅道中打开 #${bug.zentaoId}">#${bug.zentaoId}</a>`;
    } else {
      // 没有BugID时显示同步按钮
      addBugIdBtn = `<button class="bug-sync-to-zentao-btn" title="同步到禅道创建Bug" data-bug-id="${bug.id}">同步</button>`;
    }

    // 根据状态显示不同的快捷按钮
    let quickActionButton = '';
    if (bug.status === 'unconfirmed') {
      quickActionButton = `<button class="bug-quick-btn bug-activate-btn" title="确认 Bug">⚡ 确认</button>`;
    } else if (bug.status === 'activated') {
      quickActionButton = `<button class="bug-quick-btn bug-resolve-btn" title="解决 Bug">🔧 解决</button>`;
    } else if (bug.status === 'closed') {
      quickActionButton = `<button class="bug-quick-btn bug-close-btn" title="关闭 Bug">🔒 关闭</button>`;
    }

    card.innerHTML = `
      <div class="task-title">
        <span class="bug-severity ${severityClass}">${severityText}</span>
        <span class="task-title-text">${escapeHtml(bug.title)}${bugIdSuffix}</span>
        ${addBugIdBtn}
        ${attachmentBadgeHTML(bug)}
      </div>
      ${bug.projectName ? `<span class="execution-tag">${escapeHtml(bug.projectName)}</span>` : ''}
      <div class="bug-meta">${priorityBtn}${assigneeDisplay}</div>
      ${typeof timesLineHTML === 'function' ? timesLineHTML(...recordTimes(bug)) : ''}
      ${bug.comment ? `<div class="bug-comment-preview">${escapeHtml(bug.comment.substring(0, 50))}${bug.comment.length > 50 ? '...' : ''}</div>` : ''}
      <div class="bug-card-actions">
        ${quickActionButton}
      </div>
    `;

    // Bug ID 点击事件 - 在扩展内展示详情（不再打开禅道标签页）
    const bugIdLink = card.querySelector('.bug-id-link-inline');
    if (bugIdLink) {
      bugIdLink.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openInZentao('bug', bug.zentaoId);
      });
    }

    // 同步到禅道按钮事件
    const syncBtn = card.querySelector('.bug-sync-to-zentao-btn');
    if (syncBtn) {
      syncBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await this.syncBugToZentao(bug.id, syncBtn);
      });

      // 鼠标悬停效果
      syncBtn.addEventListener('mouseenter', () => {
        syncBtn.style.background = '#059669';
      });
      syncBtn.addEventListener('mouseleave', () => {
        syncBtn.style.background = '#10b981';
      });
    }

    // 添加右键事件
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.showBugDetail(bug.id);
    });

    // 与任务卡片一致：点标题原地编辑、P▼ 改优先级、点指派人改指派
    const titleText = card.querySelector('.task-title-text');
    if (titleText) {
      titleText.classList.add('bug-title-editable');
      titleText.title = '点击编辑标题';
      titleText.addEventListener('click', (e) => {
        if (e.target.closest('.bug-id-link-inline')) return;
        e.stopPropagation();
        this.editBugTitleInline(titleText, bug.id);
      });
    }
    card.querySelector('.bug-priority-toggle').addEventListener('click', (e) => {
      e.stopPropagation();
      this.openChoiceMenu(e.currentTarget, BUG_PRIORITY_CHOICES, Number(bug.priority) || 3, (value) => this.saveBugFields(bug.id, { priority: value }));
    });
    card.querySelector('.bug-assignee-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      this.openAssignPopover(e.currentTarget, bug.id);
    });

    // 拖拽改状态（放下后弹出对应的确认 / 解决 / 激活表单，取消则卡片留在原列）
    card.addEventListener('dragstart', (e) => {
      if (e.target.closest('input, textarea')) { e.preventDefault(); return; }
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', bug.id);
      this.dragging = { bugId: bug.id, from: bug.status };
      card.classList.add('bug-dragging');
      this.markDropTargets(bug);
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('bug-dragging');
      this.dragging = null;
      this.markDropTargets(null);
    });

    // 添加快捷按钮事件
    const activateBtn = card.querySelector('.bug-activate-btn');
    if (activateBtn) {
      activateBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.activateBug(bug.id);
      });
    }

    const resolveBtn = card.querySelector('.bug-resolve-btn');
    if (resolveBtn) {
      resolveBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showResolveModal(bug.id);
      });
    }

    const closeBtn = card.querySelector('.bug-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showCloseModal(bug.id);
      });
    }

    return card;
  },

  // ==================== 卡片 / 详情里的编辑 ====================

  /** 当前登录账号：确认 / 解决 / 激活默认指派给自己 */
  currentAccount() {
    return (window.Account && Account.state && Account.state.username) ||
      (ZentaoBrowserClient.config && ZentaoBrowserClient.config.username) || '';
  },

  /** 账号或姓名 → 账号（本地记录里的指派人有时存的是姓名） */
  accountOf(user, users) {
    if (!user) return '';
    if (users[user]) return user;
    return Object.keys(users).find(a => users[a] === user) || user;
  },

  /** 单选指派人组件设值（确认 / 解决表单） */
  setSingleSelectValue(displayId, account, users) {
    const display = document.getElementById(displayId);
    if (!display || !account) return;
    display.dataset.value = account;
    display.innerHTML = `<span class="multi-select-tag"><span class="multi-select-tag-name">${escapeHtml(users[account] || account)}</span></span>`;
    const box = display.parentElement;
    if (box) box.querySelectorAll('.multi-select-option').forEach(o => o.classList.toggle('selected', o.dataset.value === account));
  },

  /** 关闭卡片 / 详情上打开的浮层（优先级菜单、指派浮层） */
  closePopovers() {
    document.querySelectorAll('.bug-choice-menu, .bug-assign-pop').forEach(el => el.remove());
  },

  /** 浮层定位在按钮下方（贴边时往左收） */
  placePopover(el, anchor) {
    document.body.appendChild(el);
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    el.style.top = `${Math.min(r.bottom + 4, window.innerHeight - el.offsetHeight - 8)}px`;
    el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    const close = (e) => {
      if (!el.isConnected) return document.removeEventListener('mousedown', close, true);
      if (!el.contains(e.target) && e.target !== anchor) { el.remove(); document.removeEventListener('mousedown', close, true); }
    };
    setTimeout(() => document.addEventListener('mousedown', close, true), 0);
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { el.remove(); anchor.focus(); } });
  },

  /** 选项菜单（优先级 / 严重程度），样式同任务卡片的 P▼ 菜单 */
  openChoiceMenu(anchor, choices, current, onPick) {
    this.closePopovers();
    const menu = document.createElement('div');
    menu.className = 'bug-choice-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = choices.map(c => `<button type="button" role="menuitem" class="bug-choice ${c.cls} ${c.value === current ? 'is-current' : ''}" data-value="${c.value}">${c.label}</button>`).join('');
    menu.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-value]');
      if (!btn) return;
      e.stopPropagation();
      menu.remove();
      const value = Number(btn.dataset.value);
      if (value !== current) onPick(value);
    });
    this.placePopover(menu, anchor);
    (menu.querySelector('.is-current') || menu.querySelector('button')).focus();
  },

  /** 指派浮层：搜索成员、选人，可填备注（写进禅道的指派历史） */
  async openAssignPopover(anchor, bugId) {
    const bug = this.bugs.find(b => b.id === bugId);
    if (!bug) return;
    this.closePopovers();
    const users = await ZentaoBrowserClient.getUsers() || {};
    const current = this.accountOf(Array.isArray(bug.assignedTo) ? bug.assignedTo[0] : bug.assignedTo, users);
    const me = this.currentAccount();
    let picked = current;
    const pop = document.createElement('div');
    pop.className = 'bug-assign-pop';
    pop.innerHTML = `
      <div class="bap-head">指派给</div>
      <input type="text" class="bap-search" placeholder="搜索姓名或账号" aria-label="搜索成员">
      <div class="bap-list" role="listbox"></div>
      <textarea class="bap-comment" rows="2" placeholder="备注（选填，会写进禅道的指派记录）"></textarea>
      <div class="bap-actions"><button type="button" data-bap="cancel">取消</button><button type="button" class="is-primary" data-bap="ok">确定</button></div>`;
    const list = pop.querySelector('.bap-list');
    const render = (q = '') => {
      const kw = q.trim().toLowerCase();
      const entries = Object.entries(users)
        .filter(([a, n]) => !kw || a.toLowerCase().includes(kw) || String(n).includes(q.trim()))
        .sort(([a], [b]) => (b === me) - (a === me));
      list.innerHTML = entries.length
        ? entries.map(([a, n]) => `<button type="button" role="option" class="bap-user ${a === picked ? 'is-picked' : ''}" data-account="${escapeHtml(a)}">${escapeHtml(n)} <span>${escapeHtml(a)}${a === me ? ' · 我' : ''}</span></button>`).join('')
        : '<div class="bap-empty">没有匹配的成员</div>';
    };
    render();
    pop.querySelector('.bap-search').addEventListener('input', (e) => render(e.target.value));
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-account]');
      if (!btn) return;
      picked = btn.dataset.account;
      list.querySelectorAll('.bap-user').forEach(b => b.classList.toggle('is-picked', b === btn));
    });
    pop.addEventListener('click', (e) => {
      const act = e.target.closest('[data-bap]');
      if (!act) return;
      if (act.dataset.bap === 'cancel') return pop.remove();
      if (!picked) return Toast.warning('请选择指派人');
      const comment = pop.querySelector('.bap-comment').value.trim();
      pop.remove();
      if (picked === current && !comment) return;
      this.saveBugFields(bugId, { assignedTo: picked }, { comment, assigneeName: users[picked] || picked });
    });
    this.placePopover(pop, anchor);
    pop.querySelector('.bap-search').focus();
  },

  /** 卡片标题原地编辑：回车保存、Esc 取消、失焦保存（同任务卡片） */
  editBugTitleInline(el, bugId) {
    const bug = this.bugs.find(b => b.id === bugId);
    if (!bug || el.querySelector('input')) return;
    const original = el.innerHTML;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'bug-title-input';
    input.value = bug.title;
    el.innerHTML = '';
    el.appendChild(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const title = input.value.trim();
      if (save && title && title !== bug.title) {
        this.saveBugFields(bugId, { title });
      } else {
        el.innerHTML = original;
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  },

  /**
   * 保存 Bug 的标题 / 优先级 / 严重程度 / 指派人：先改界面，写回禅道成功再存本地；失败回滚并提示
   * 指派走禅道「指派」动作（记历史、通知对方，可带备注）；其余走「编辑」表单（其他字段原样带回）
   */
  async saveBugFields(bugId, changes, { comment = '', assigneeName = '' } = {}) {
    const bug = this.bugs.find(b => b.id === bugId);
    if (!bug) return;
    const before = {};
    Object.keys(changes).forEach(k => { before[k] = bug[k]; });
    Object.assign(bug, changes);
    await this.refreshBugViews(bugId);
    try {
      if (bug.zentaoId) {
        const path = 'assignedTo' in changes ? '/api/zentao/bug/assign' : '/api/zentao/bug/edit';
        const body = 'assignedTo' in changes
          ? { bugId: bug.zentaoId, assignedTo: changes.assignedTo, comment }
          : { bugId: bug.zentaoId, title: changes.title, pri: changes.priority, severity: changes.severity };
        const r = await (await fetch(`${API_BASE_URL}${path}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        })).json();
        if (!r.success) throw new Error(r.message || '禅道拒绝了这次修改');
      }
      const local = await (await fetch(`${API_BASE_URL}/api/bug/${bugId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...changes, ...(comment ? { comment } : {}) })
      })).json();
      if (!local.success) throw new Error(local.error || '本地保存失败');
      const what = 'assignedTo' in changes ? `已指派给 ${assigneeName}` : 'title' in changes ? '标题已更新' : 'priority' in changes ? `优先级已改为 P${changes.priority}` : '严重程度已更新';
      Toast.success(bug.zentaoId ? `${what}，已同步到禅道` : what);
    } catch (err) {
      Object.assign(bug, before);
      await this.refreshBugViews(bugId);
      Toast.error(`修改失败：${err.message}`);
    }
  },

  /** 改完后刷新卡片，以及正开着的这条 Bug 的详情 */
  async refreshBugViews(bugId) {
    await this.renderBugs();
    const modal = document.getElementById('bugDetailModal');
    if (modal && modal.style.display === 'flex' && modal.dataset.bugId === bugId) await this.showBugDetail(bugId);
  },

  // ==================== 拖拽改状态 ====================

  /**
   * 从某状态拖到另一列：返回要做的禅道动作，或不允许的原因
   * @returns {{action:'confirm'|'resolve'|'reactivate'}|{reason:string}|null} null = 同一列
   */
  dropRule(from, to) {
    const f = from === 'closed' ? 'resolved' : from;
    if (f === to) return null;
    if (f === 'unconfirmed' && to === 'activated') return { action: 'confirm' };
    if (to === 'resolved') return { action: 'resolve' };
    if (f === 'resolved' && to === 'activated') return { action: 'reactivate' };
    if (f === 'activated' && to === 'unconfirmed') return { reason: '禅道不支持把已确认的 Bug 改回未确认' };
    return { reason: '已解决的 Bug 激活后是「已确认」，请拖到「已确认」列' };
  },

  /** 拖拽中：能放的列高亮，不能放的变灰 */
  markDropTargets(bug) {
    Object.entries(BUG_COLUMN_STATUS).forEach(([id, status]) => {
      const col = document.getElementById(id) && document.getElementById(id).closest('.task-column');
      if (!col) return;
      const rule = bug ? this.dropRule(bug.status, status) : null;
      col.classList.toggle('bug-drop-ok', !!(rule && rule.action));
      col.classList.toggle('bug-drop-no', !!(rule && rule.reason));
      col.classList.remove('bug-drop-over');
    });
  },

  /** 绑定三列的放置事件（只绑一次） */
  bindBugDropZones() {
    if (this.dropZonesBound) return;
    this.dropZonesBound = true;
    Object.entries(BUG_COLUMN_STATUS).forEach(([id, status]) => {
      const list = document.getElementById(id);
      const col = list && list.closest('.task-column');
      if (!col) return;
      col.addEventListener('dragover', (e) => {
        if (!this.dragging) return;
        e.preventDefault();
        const bug = this.bugs.find(b => b.id === this.dragging.bugId);
        const rule = bug && this.dropRule(bug.status, status);
        e.dataTransfer.dropEffect = rule && rule.action ? 'move' : 'none';
        col.classList.add('bug-drop-over');
      });
      col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('bug-drop-over'); });
      col.addEventListener('drop', (e) => {
        e.preventDefault();
        const bugId = this.dragging ? this.dragging.bugId : e.dataTransfer.getData('text/plain');
        this.markDropTargets(null);
        this.handleBugDrop(bugId, status);
      });
    });
  },

  /** 放下：弹出对应的表单；卡片在动作成功、重新加载后才换列，取消则留在原列 */
  handleBugDrop(bugId, toStatus) {
    const bug = this.bugs.find(b => b.id === bugId);
    if (!bug) return;
    const rule = this.dropRule(bug.status, toStatus);
    if (!rule) return;
    if (rule.reason) return Toast.warning(rule.reason);
    if (!bug.zentaoId) return Toast.warning('这个 Bug 还没有同步到禅道，请先点卡片上的「同步」');
    if (rule.action === 'confirm') return this.activateBug(bugId);
    if (rule.action === 'resolve') return this.showResolveModal(bugId);
    return this.showReactivateModal(bugId);
  },

  /** 激活（重新打开）已解决的 Bug：指派人默认自己，可填备注 */
  async showReactivateModal(bugId) {
    const bug = this.bugs.find(b => b.id === bugId);
    if (!bug) return;
    this.hideBugDetail();
    document.getElementById('bugReactivateModal')?.remove();
    const users = await ZentaoBrowserClient.getUsers() || {};
    const me = this.currentAccount();
    const modal = document.createElement('div');
    modal.id = 'bugReactivateModal';
    modal.className = 'modal active';
    modal.style.display = 'flex';
    modal.innerHTML = `
      <div class="modal-content bug-small-modal" role="dialog" aria-modal="true" aria-labelledby="bugReactivateTitle">
        <div class="modal-header"><h3 id="bugReactivateTitle">激活 Bug</h3><button type="button" class="close-btn" data-ra="cancel" aria-label="关闭">&times;</button></div>
        <div class="modal-body">
          <p class="bug-small-subject">#${escapeHtml(bug.zentaoId)} ${escapeHtml(bug.title)}</p>
          <label class="bug-small-field"><span>指派给</span>
            <select data-ra="assignee">${Object.entries(users).map(([a, n]) => `<option value="${escapeHtml(a)}" ${a === me ? 'selected' : ''}>${escapeHtml(n)}（${escapeHtml(a)}）</option>`).join('')}</select>
          </label>
          <label class="bug-small-field"><span>备注</span><textarea data-ra="comment" rows="3" placeholder="为什么重新打开（选填）"></textarea></label>
          <div class="bug-small-error" role="alert"></div>
        </div>
        <div class="modal-footer bug-small-footer"><button type="button" class="btn-secondary" data-ra="cancel">取消</button><button type="button" class="btn-primary" data-ra="ok">激活</button></div>
      </div>`;
    document.body.appendChild(modal);
    const close = () => modal.remove();
    modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    modal.addEventListener('click', async (e) => {
      if (e.target === modal) return close();
      const act = e.target.closest('[data-ra]') && e.target.closest('[data-ra]').dataset.ra;
      if (act === 'cancel') return close();
      if (act !== 'ok') return;
      const ok = e.target.closest('[data-ra="ok"]');
      const assignedTo = modal.querySelector('[data-ra="assignee"]').value;
      const comment = modal.querySelector('[data-ra="comment"]').value.trim();
      ok.disabled = true;
      ok.textContent = '激活中…';
      try {
        const r = await (await fetch(`${API_BASE_URL}/api/zentao/bug/reactivate`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bugId: bug.zentaoId, assignedTo, comment })
        })).json();
        if (!r.success) throw new Error(r.message || '激活失败');
        const status = r.bug && String(r.bug.confirmed) === '1' ? 'activated' : 'unconfirmed';
        await fetch(`${API_BASE_URL}/api/bug/${bugId}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status, assignedTo, ...(comment ? { comment } : {}) })
        });
        close();
        Toast.success('Bug 已激活');
        await this.loadBugs();
      } catch (err) {
        modal.querySelector('.bug-small-error').textContent = err.message;
        ok.disabled = false;
        ok.textContent = '激活';
      }
    });
    modal.querySelector('[data-ra="comment"]').focus();
  },

  /**
   * 关联禅道 Bug（原「编辑 BugID」）：输入编号后先到禅道核对，显示标题确认后才能保存
   */
  showEditBugIdModal(bugId, currentZentaoId) {
    const bug = this.bugs.find(b => b.id === bugId);
    if (!bug) return;
    document.getElementById('editBugIdModal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'editBugIdModal';
    modal.className = 'modal active';
    modal.style.display = 'flex';
    modal.innerHTML = `
      <div class="modal-content bug-small-modal" role="dialog" aria-modal="true" aria-labelledby="editBugIdTitle">
        <div class="modal-header"><h3 id="editBugIdTitle">关联禅道 Bug</h3><button type="button" class="close-btn" data-eb="cancel" aria-label="关闭">&times;</button></div>
        <div class="modal-body">
          <p class="bug-small-subject">${escapeHtml(bug.title)}</p>
          <label class="bug-small-field"><span>禅道 Bug 编号</span>
            <input type="text" inputmode="numeric" data-eb="id" value="${escapeHtml(currentZentaoId || '')}" placeholder="如 468" autocomplete="off">
          </label>
          <div class="bug-small-hint" data-eb="result">${currentZentaoId ? `当前关联 #${escapeHtml(currentZentaoId)}；改成其他编号会关联到那个 Bug` : '当前未关联禅道 Bug'}</div>
        </div>
        <div class="modal-footer bug-small-footer"><button type="button" class="btn-secondary" data-eb="cancel">取消</button><button type="button" class="btn-primary" data-eb="save" disabled>保存</button></div>
      </div>`;
    document.body.appendChild(modal);
    const input = modal.querySelector('[data-eb="id"]');
    const result = modal.querySelector('[data-eb="result"]');
    const save = modal.querySelector('[data-eb="save"]');
    let verified = '';
    let token = 0;
    const close = () => modal.remove();

    // 输入停顿后到禅道核对这个编号
    const verify = debounce(async () => {
      const id = input.value.trim();
      verified = '';
      save.disabled = true;
      result.className = 'bug-small-hint';
      if (!id) { result.textContent = '请输入禅道 Bug 编号'; return; }
      if (!/^\d{1,10}$/.test(id)) { result.textContent = '编号应为数字'; result.classList.add('is-error'); return; }
      if (id === String(currentZentaoId || '')) { result.textContent = `当前已关联 #${id}`; return; }
      const my = ++token;
      result.textContent = '正在禅道中核对…';
      try {
        const r = await (await fetch(`${API_BASE_URL}/api/zentao/bug/brief?bugId=${id}`)).json();
        if (my !== token) return;
        if (!r.success) throw new Error(r.message || '核对失败');
        if (!r.data.exists) { result.textContent = `禅道里没有 Bug #${id}（或已删除）`; result.classList.add('is-error'); return; }
        verified = id;
        save.disabled = false;
        result.innerHTML = `将关联：<b>#${escapeHtml(id)} ${escapeHtml(r.data.title)}</b>`;
        result.classList.add('is-ok');
      } catch (err) {
        if (my !== token) return;
        result.textContent = `核对失败：${err.message}`;
        result.classList.add('is-error');
      }
    }, 400);
    input.addEventListener('input', verify);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !save.disabled) save.click();
      if (e.key === 'Escape') close();
    });
    modal.addEventListener('click', async (e) => {
      if (e.target === modal) return close();
      const act = e.target.closest('[data-eb]') && e.target.closest('[data-eb]').dataset.eb;
      if (act === 'cancel') return close();
      if (act !== 'save' || !verified) return;
      save.disabled = true;
      try {
        const r = await (await fetch(`${API_BASE_URL}/api/bug/${bugId}/zentaoId`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ zentaoId: verified })
        })).json();
        if (!r.success) throw new Error(r.error || r.message || '保存失败');
        close();
        Toast.success(`已关联禅道 Bug #${verified}`);
        await this.loadBugs();
      } catch (err) {
        result.textContent = `保存失败：${err.message}`;
        result.className = 'bug-small-hint is-error';
        save.disabled = false;
      }
    });
    setTimeout(() => { input.focus(); input.select(); }, 50);
  },

  /**
   * 同步 Bug 到禅道
   * @param {string} bugId - Bug ID
   * @param {HTMLElement} syncBtn - 同步按钮元素
   */
  async syncBugToZentao(bugId, syncBtn) {
    try {
      // 查找 Bug
      const bug = this.bugs.find(b => b.id === bugId);
      if (!bug) {
        Toast.error('Bug不存在');
        return;
      }

      // 禁用按钮，显示加载状态
      syncBtn.disabled = true;
      syncBtn.textContent = '同步中...';
      syncBtn.style.background = '#6b7280';
      syncBtn.style.cursor = 'wait';

      console.log('[SyncToZentao] 开始同步Bug到禅道:', bug);

      // 获取禅道配置
      const configResp = await fetch(`${API_BASE_URL}/api/zentao/config`);
      const configResult = await configResp.json();
      const baseUrl = configResult.data?.url?.replace(/\/$/, '') || null;

      if (!baseUrl) {
        Toast.error('禅道未配置，请先在设置中配置禅道');
        // 恢复按钮状态，让用户配好禅道后可再次点击
        restoreSyncBtn(syncBtn);
        return;
      }

      // 检查执行类型，决定使用哪种同步方式
      let executionType = null;
      try {
        executionType = ExecutionFavorites.getExecutionType(bug.executionId);
        console.log('[SyncToZentao] 执行类型:', bug.executionId, '=>', executionType);
      } catch (e) {
        console.warn('[SyncToZentao] 获取执行类型失败:', e);
      }

      let result;
      if (executionType === 'kanban') {
        // 看板执行 Bug 同步
        console.log('[SyncToZentao] 使用看板逻辑同步 Bug');

        // 获取看板参数
        const kanbanParams = await ZentaoBrowserClient.getKanbanParamsFromHtml(bug.executionId, 'bug', 'unconfirmed');
        if (!kanbanParams) {
          throw new Error('无法获取看板参数');
        }

        const requiredParams = ['productId', 'regionId', 'laneId', 'columnId'];
        const missingParams = requiredParams.filter(param => !kanbanParams[param]);
        if (missingParams.length > 0) {
          throw new Error('看板参数不完整: ' + missingParams.join(', '));
        }

        // 准备 Bug 数据
        const syncBugData = {
          title: bug.title,
          severity: bug.severity,
          type: bug.bugType,
          openedBuild: bug.openedBuild || 'trunk',
          steps: bug.content || bug.steps || '',
          executionId: bug.executionId,
          projectId: bug.projectId || '',
          assignedTo: Array.isArray(bug.assignedTo) ? bug.assignedTo[0] : bug.assignedTo,
          // 看板参数
          regionId: kanbanParams.regionId,
          laneId: kanbanParams.laneId,
          columnId: kanbanParams.columnId
        };

        result = await new Promise(resolve => {
          const timeout = setTimeout(() => {
            console.log('[SyncToZentao] 看 Bug 创建请求超时');
            resolve({ success: false, reason: 'timeout' });
          }, 30000);

          chrome.runtime.sendMessage({
            action: 'executeBugInZentaoPage',
            baseUrl,
            productId: kanbanParams.productId,
            bugData: syncBugData
          }, (response) => {
            clearTimeout(timeout);
            resolve(response);
          });
        });
      } else {
        // 普通执行 Bug 同步
        console.log('[SyncToZentao] 使用普通执行逻辑同步 Bug');

        // 首先需要获取 productId
        const productIdResponse = await new Promise(resolve => {
          const timeout = setTimeout(() => {
            console.log('[SyncToZentao] 获取 productID 请求超时');
            resolve({ success: false, reason: 'timeout' });
          }, 15000);

          chrome.runtime.sendMessage({
            action: 'getExecutionProductId',
            baseUrl,
            executionId: bug.executionId
          }, (response) => {
            clearTimeout(timeout);
            resolve(response);
          });
        });

        if (!productIdResponse || !productIdResponse.success) {
          throw new Error(productIdResponse?.reason || '获取 productID 失败');
        }

        const productId = productIdResponse.productId;
        console.log('[SyncToZentao] 获取到 productID:', productId);

        // 准备 Bug 数据
        const syncBugData = {
          title: bug.title,
          severity: bug.severity,
          type: bug.bugType,
          openedBuild: bug.openedBuild || 'trunk',
          steps: bug.content || bug.steps || '',
          executionId: bug.executionId,
          projectId: bug.projectId || '',
          assignedTo: Array.isArray(bug.assignedTo) ? bug.assignedTo[0] : bug.assignedTo
        };

        result = await new Promise(resolve => {
          const timeout = setTimeout(() => {
            console.log('[SyncToZentao] 普通 Bug 创建请求超时');
            resolve({ success: false, reason: 'timeout' });
          }, 60000);

          chrome.runtime.sendMessage({
            action: 'executeNormalExecutionBugInZentaoPage',
            baseUrl,
            productId,
            bugData: syncBugData
          }, (response) => {
            clearTimeout(timeout);
            resolve(response);
          });
        });
      }

      // 判断是否成功并提取 Bug ID
      if (result.success) {
        // 适配返回结构，提取 bugId
        const data = result.data;

        console.log('[SyncToZentao] Bug 创建响应数据:', JSON.stringify(data).substring(0, 500));

        let bugId = data?.id || data?.bug?.id || data?.data?.id;

        // 如果响应中包含看板回调数据，尝试从中提取 Bug ID
        if (!bugId && data?.callback) {
          console.log('[SyncToZentao] 尝试从 callback 中提取 Bug ID');

          try {
            // 提取 parent.updateKanban(...) 中的 JSON
            const kanbanMatch = data.callback.match(/parent\.updateKanban\((.+)\)\)/);
            if (kanbanMatch) {
              const kanbanJson = kanbanMatch[1];
              const kanbanData = JSON.parse(kanbanJson);

              // 遍历所有 region
              for (const regionKey in kanbanData) {
                const region = kanbanData[regionKey];
                if (region.groups) {
                  for (const group of region.groups) {
                    if (group.columns) {
                      for (const column of group.columns) {
                        if (column.type === 'unconfirmed' && column.items && column.items.length > 0) {
                          // 根据标题匹配查找 Bug ID
                          for (const item of column.items) {
                            if (item.title === bug.title) {
                              bugId = item.id;
                              console.log('[SyncToZentao] ✓ 从 callback 找到 Bug ID:', bugId);
                              break;
                            }
                          }
                          if (bugId) break;
                        }
                      }
                      if (bugId) break;
                    }
                  }
                  if (bugId) break;
                }
              }
            }
          } catch (parseErr) {
            console.error('[SyncToZentao] 解析 callback 失败:', parseErr);
          }
        }

        if (!bugId && data?.locate) {
          const match = data.locate.match(/bug-view-(\d+)/);
          if (match) {
            bugId = parseInt(match[1]);
            console.log('[SyncToZentao] ✓ 从 locate 找到 Bug ID:', bugId);
          }
        }

        console.log('[SyncToZentao] 最终提取的 Bug ID:', bugId);

        if (bugId) {
          console.log('[SyncToZentao] Bug创建成功，zentaoId:', bugId);

          // 更新本地 Bug 的 zentaoId
          bug.zentaoId = bugId;
          bug.updatedAt = new Date().toISOString();

          // 保存到后端
          await fetch(`${API_BASE_URL}/api/bug/${bug.id}/zentaoId`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ zentaoId: bugId })
          });

          Toast.success('已同步到禅道，BugID: #' + bugId);

          // 刷新 Bug 卡片显示
          await this.loadBugs();
        } else {
        console.error('[SyncToZentao] Bug创建失败:', result);

        // 恢复按钮状态（用户可随时重试）
        restoreSyncBtn(syncBtn);

        // 统一走OptimisticUI 的失败原因翻译
        Toast.error('同步失败：' + OptimisticUI.explainFailure(result));
        }
      }
    } catch (err) {
      console.error('[SyncToZentao] 同步Bug异常:', err);

      // 恢复按钮状态
      restoreSyncBtn(syncBtn);

      Toast.error('同步失败: ' + err.message);
    }
  },

  /**
   * 在扩展内展示 Bug 详情（不再打开禅道标签页）
   * @param {string|number} bugId - 本地 Bug ID 或禅道 Bug ID
   */
  async openBugDetailInZentao(bugId) {
    const local = (this.bugs || []).find(b => b.id === bugId || String(b.zentaoId) === String(bugId));
    if (local) {
      return this.showBugDetail(local.id);
    }
    Toast.error('未找到对应的 Bug 详情');
  },

  getBugTypeText(type) {
    const types = {
      codeerror: '代码错误',
      config: '配置相关',
      install: '安装部署',
      security: '安全相关',
      performance: '性能问题',
      standard: '标准规范',
      automation: '测试脚本',
      designdefect: '设计缺陷',
      others: '其他'
    };
    return types[type] || type;
  },

  async showBugModal(initialContent = '') {
    const modal = document.getElementById('bugModal');
    if (!modal) return;

    // 加载项目列表
    await this.loadProjectOptions();

    // 加载指派人选项
    await this.loadAssigneeOptions();

    // 如果有初始内容，预填到 bugSteps 字段
    if (initialContent) {
      const bugSteps = document.getElementById('bugSteps');
      if (bugSteps) {
        bugSteps.value = initialContent;
      }
    } else {
      // 恢复草稿（只有在没有初始内容时）
      if (this.draft) {
        console.log('[BugManager] 草稿中的 type:', this.draft.type);
        this.restoreDraft();
        console.log('[BugManager] 恢复草稿后的 bugType.value:', document.getElementById('bugType').value);
      }
    }

    // 强制设置默认类型为代码错误（覆盖草稿中的值）
    const bugType = document.getElementById('bugType');
    if (bugType) {
      console.log('[BugManager] 强制设置 bugType 为 codeerror，当前值:', bugType.value);
      bugType.value = 'codeerror';
      console.log('[BugManager] 设置后的 bugType.value:', bugType.value);
    }

    modal.style.display = 'flex';
  },

  hideBugModal() {
    const modal = document.getElementById('bugModal');
    if (modal) {
      modal.style.display = 'none';
    }
    if (this.attachmentPicker) this.attachmentPicker.clear();
  },

  /** 用户主动关闭（关闭按钮 / 遮罩）：已添加附件时先确认。文字内容有草稿，附件没有 */
  async requestCloseBugModal() {
    const count = this.attachmentPicker ? this.attachmentPicker.count : 0;
    if (count > 0) {
      const ok = await Confirm.show('放弃附件？', `已添加 ${count} 个截图 / 附件，关闭后不会保存（文字内容会保留在草稿里）。`, '关闭', '继续编辑');
      if (!ok) return;
    }
    this.hideBugModal();
  },

  /**
   * 快速提交 Bug（从左侧输入框触发）
   * @param {string} executionId - 执行 ID（可能为空，表示需要 AI 匹配）
   * @param {string} executionName - 执行名称
   * @param {string} projectId - 项目 ID
   * @param {string} steps - Bug 复现步骤
   */
  async quickSubmit(executionId, executionName, projectId, steps) {
    try {
      Toast.info('AI 正在分析 Bug...');

      // 1. 如果 executionId 为空，调用 AI 匹配执行
      if (!executionId) {
        const matchResponse = await fetch(`${API_BASE_URL}/api/ai/match-execution`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: steps })
        });
        const matchResult = await matchResponse.json();

        if (matchResult.success && matchResult.data) {
          executionId = matchResult.data.executionId;
          executionName = matchResult.data.executionName || matchResult.data.projectName || '';
          projectId = matchResult.data.projectId || '';
          console.log('[BugManager] AI 匹配到执行:', executionId, executionName, projectId);
        } else {
          // AI 匹配失败，提示用户手动选择
          Toast.warning('AI 无法确定执行，请在弹窗中手动选择');
          // 不设置 executionId，让用户在弹窗中选择
        }
      }

      // 2. 调用 AI 分析生成标题和类型
      const analysisResponse = await fetch(`${API_BASE_URL}/api/ai/analyze-bug`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ steps })
      });
      const analysisResult = await analysisResponse.json();

      let bugTitle = '未知 Bug';
      let bugType = 'codeerror';  // 默认为代码错误
      let bugSeverity = '3';

      if (analysisResult.success && analysisResult.data) {
        bugTitle = analysisResult.data.title || bugTitle;
        bugType = analysisResult.data.type || bugType;
        bugSeverity = String(analysisResult.data.severity || 3);
      }

      // 3. 加载项目列表并打开弹窗
      await this.showBugModalWithData(executionId, executionName, projectId, steps, bugTitle, bugType, bugSeverity);

    } catch (err) {
      console.error('[BugManager] 快速提交失败:', err);
      Toast.error('分析失败，请重试');
    }
  },

  /**
   * 显示 Bug 弹窗并预填数据
   */
  async showBugModalWithData(executionId, executionName, projectId, steps, title, type, severity) {
    const modal = document.getElementById('bugModal');
    if (!modal) return;

    // 加载项目列表
    await this.loadProjectOptions();

    // 加载指派人选项
    await this.loadAssigneeOptions();

    // 预填数据
    // 标题
    const bugTitle = document.getElementById('bugTitle');
    if (bugTitle) {
      bugTitle.value = title;
    }

    // 严重程度
    const bugSeverity = document.getElementById('bugSeverity');
    if (bugSeverity) {
      bugSeverity.value = severity;
    }

    // 类型
    const bugType = document.getElementById('bugType');
    if (bugType) {
      bugType.value = type;
    }

    // 复现步骤
    const bugSteps = document.getElementById('bugSteps');
    if (bugSteps) {
      bugSteps.value = steps;
    }

    // 根据 projectId 自动选择项目
    if (projectId) {
      const bugProject = document.getElementById('bugProject');
      if (bugProject) {
        // 确保类型匹配（尝试字符串和数字两种形式）
        bugProject.value = projectId;
        if (bugProject.value !== projectId) {
          // 尝试查找匹配的 option
          for (const option of bugProject.options) {
            if (option.value === projectId || option.value === String(projectId) || option.value === Number(projectId).toString()) {
              bugProject.value = option.value;
              break;
            }
          }
        }
        console.log('[BugManager] 选择项目:', projectId, '当前值:', bugProject.value);
      }
    }

    // 保存执行信息到 modal 的 dataset 中，提交时使用
    modal.dataset.executionId = executionId || '';
    modal.dataset.executionName = executionName || '';

    // 显示弹窗
    modal.style.display = 'flex';
  },

  async loadProjectOptions() {
    const select = document.getElementById('bugProject');
    if (!select) return;

    try {
      // 同时获取本地项目列表和执行列表
      const [projectsResp, executionsResp] = await Promise.all([
        fetch(`${API_BASE_URL}/api/projects`),
        fetch(`${API_BASE_URL}/api/executions`)
      ]);
      const projectsResult = await projectsResp.json();
      const executionsResult = await executionsResp.json();

      // 收集所有项目
      const projectsMap = new Map(); // 使用 Map 去重

      // 1. 添加本地项目列表中的项目
      if (projectsResult.success && projectsResult.data) {
        projectsResult.data.forEach(p => {
          projectsMap.set(p.id, { id: p.id, name: p.name });
        });
      }

      // 2. 从执行列表中提取项目（补充本地可能缺失的项目）
      if (executionsResult.success && executionsResult.data) {
        executionsResult.data.forEach(exec => {
          if (exec.projectId && !projectsMap.has(exec.projectId)) {
            projectsMap.set(exec.projectId, {
              id: exec.projectId,
              name: exec.projectName || `项目${exec.projectId}`
            });
          }
        });
      }

      // 转换为数组并排序
      const allProjects = Array.from(projectsMap.values()).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

      // 保存当前选中的值（如果有）
      const currentValue = select.value;

      select.innerHTML = '<option value="">请选择项目</option>';
      allProjects.forEach(project => {
        const option = document.createElement('option');
        option.value = project.id;
        option.textContent = project.name;
        select.appendChild(option);
      });

      // 如果之前有选中的值，恢复它
      if (currentValue) {
        select.value = currentValue;
      }

      // 如果草稿有项目选择，恢复它
      if (this.draft && this.draft.projectId && !currentValue) {
        select.value = this.draft.projectId;
      }
    } catch (err) {
      console.error('[BugManager] 加载项目失败:', err);
    }
  },

  /**
   * 加载指派人选项到下拉框
   */
  async loadAssigneeOptions() {
    console.log('[BugManager] loadAssigneeOptions 开始执行');

    // 获取用户列表
    let users = await ZentaoBrowserClient.getUsers();
    console.log('[BugManager] 缓存的用户数量:', users ? Object.keys(users).length : 0);

    if (!users || Object.keys(users).length === 0) {
      console.warn('[BugManager] 用户列表未加载，尝试从禅道加载...');
      await ZentaoBrowserClient.refreshUsersFromZentao();
      users = await ZentaoBrowserClient.getUsers();
      console.log('[BugManager] 从禅道加载后的用户数量:', users ? Object.keys(users).length : 0);
    }

    if (!users || Object.keys(users).length === 0) {
      console.warn('[BugManager] 无法获取用户列表');
      return;
    }

    console.log('[BugManager] 加载用户列表到下拉框，用户数量:', Object.keys(users).length);

    // 初始化指派人多选组件
    this.initMultiSelect('bugAssignee', users);

    // 初始化抄送人多选组件
    this.initMultiSelect('bugCc', users);

    console.log('[BugManager] 用户选项加载完成');
  },

  /**
   * 初始化多选组件
   * @param {string} fieldId - 字段 ID（bugAssignee 或 bugCc）
   * @param {Object} users - 用户列表 {account: name}
   */
  initMultiSelect(fieldId, users) {
    const container = document.getElementById(`${fieldId}Container`);
    const display = document.getElementById(`${fieldId}Display`);
    const dropdown = document.getElementById(`${fieldId}Dropdown`);
    const optionsContainer = document.getElementById(`${fieldId}Options`);

    if (!container || !display || !dropdown || !optionsContainer) {
      console.error(`[BugManager] 多选组件元素不存在: ${fieldId}`);
      return;
    }

    // 每次打开弹窗都会重新初始化：先撤掉上一次绑定的监听，避免同一元素上越绑越多
    const listenerSignal = resetListenerScope(container);

    // 存储选中的用户
    const selectedUsers = new Set();

    // 生成用户选项
    const renderOptions = () => {
      optionsContainer.innerHTML = '';

      if (Object.keys(users).length === 0) {
        optionsContainer.innerHTML = '<div class="multi-select-no-data">暂无用户数据</div>';
        return;
      }

      Object.entries(users).forEach(([account, name]) => {
        const option = document.createElement('div');
        option.className = 'multi-select-option';
        if (selectedUsers.has(account)) {
          option.classList.add('selected');
        }

        option.innerHTML = `
          <div class="multi-select-option-text">
            ${name}
            <span class="multi-select-option-account">(${account})</span>
          </div>
          <div class="multi-select-option-check"></div>
        `;

        option.addEventListener('click', (e) => {
          e.stopPropagation();
          if (selectedUsers.has(account)) {
            selectedUsers.delete(account);
            option.classList.remove('selected');
          } else {
            selectedUsers.add(account);
            option.classList.add('selected');
          }
          this.updateMultiSelectDisplay(fieldId, selectedUsers, users);
        }, { signal: listenerSignal });

        optionsContainer.appendChild(option);
      });
    };

    // 更新显示区域
    this.updateMultiSelectDisplay(fieldId, selectedUsers, users);

    // 点击显示/隐藏下拉列表
    display.addEventListener('click', (e) => {
      if (!e.target.closest('.multi-select-tag-remove')) {
        const isVisible = dropdown.style.display !== 'none';
        dropdown.style.display = isVisible ? 'none' : 'block';
        display.classList.toggle('active', !isVisible);
      }
    }, { signal: listenerSignal });

    // 点击其他地方关闭下拉
    document.addEventListener('click', (e) => {
      if (!container.contains(e.target)) {
        dropdown.style.display = 'none';
        display.classList.remove('active');
      }
    }, { signal: listenerSignal });

    // 初始化渲染选项
    renderOptions();

    // 保存引用以便后续访问
    container._selectedUsers = selectedUsers;
    container._users = users;
  },

  /**
   * 更新多选组件的显示区域
   * @param {string} fieldId - 字段 ID
   * @param {Set} selectedUsers - 选中的用户集合
   * @param {Object} users - 用户列表
   */
  updateMultiSelectDisplay(fieldId, selectedUsers, users) {
    const display = document.getElementById(`${fieldId}Display`);
    if (!display) return;

    if (selectedUsers.size === 0) {
      display.innerHTML = '<span class="multi-select-placeholder">请选择用户</span>';
    } else {
      display.innerHTML = '';
      selectedUsers.forEach(account => {
        const name = users[account] || account;
        const tag = document.createElement('span');
        tag.className = 'multi-select-tag';
        tag.innerHTML = `
          <span class="multi-select-tag-name">${name}</span>
          <span class="multi-select-tag-remove" data-account="${account}">×</span>
        `;

        // 移除标签事件
        tag.querySelector('.multi-select-tag-remove').addEventListener('click', (e) => {
          e.stopPropagation();
          selectedUsers.delete(account);
          this.updateMultiSelectDisplay(fieldId, selectedUsers, users);

          // 更新下拉列表中的选中状态
          const container = document.getElementById(`${fieldId}Container`);
          if (container && container._selectedUsers) {
            // 重新渲染选项以更新选中状态
            const optionsContainer = document.getElementById(`${fieldId}Options`);
            const options = optionsContainer.querySelectorAll('.multi-select-option');
            options.forEach(option => {
              const optionText = option.querySelector('.multi-select-option-text').textContent;
              if (optionText.includes(`(${account})`)) {
                option.classList.remove('selected');
              }
            });
          }
        });

        display.appendChild(tag);
      });
    }
  },

  /**
   * 获取多选组件的选中值
   * @param {string} fieldId - 字段 ID
   * @returns {Array} 选中的用户账号数组
   */
  getMultiSelectValues(fieldId) {
    const container = document.getElementById(`${fieldId}Container`);
    if (container && container._selectedUsers) {
      return Array.from(container._selectedUsers);
    }
    return [];
  },

  /**
   * 设置多选组件的选中值
   * @param {string} fieldId - 字段 ID
   * @param {Array} values - 要选中的用户账号数组
   */
  setMultiSelectValues(fieldId, values) {
    const container = document.getElementById(`${fieldId}Container`);
    if (container && container._selectedUsers && container._users) {
      container._selectedUsers.clear();
      values.forEach(value => container._selectedUsers.add(value));
      this.updateMultiSelectDisplay(fieldId, container._selectedUsers, container._users);
    }
  },

  /**
   * 清空多选组件的选中值
   * @param {string} fieldId - 字段 ID
   */
  clearMultiSelectValues(fieldId) {
    this.setMultiSelectValues(fieldId, []);
  },

  async submitBug() {
    console.log('[BugManager] submitBug 被调用');
    const modal = document.getElementById('bugModal');

    const projectId = document.getElementById('bugProject').value;
    const title = document.getElementById('bugTitle').value.trim();
    const severity = document.getElementById('bugSeverity').value;
    const type = document.getElementById('bugType').value;
    const steps = document.getElementById('bugSteps').value.trim();

    // 获取指派人（多选）
    const assignedToList = this.getMultiSelectValues('bugAssignee');

    // 获取抄送人（多选）
    const ccList = this.getMultiSelectValues('bugCc');

    console.log('[BugManager] 表单数据:', { projectId, title, severity, type, assignedToList, ccList, steps: steps?.substring(0, 50) });

    // 从 modal 获取执行信息（如果有）
    const executionId = modal?.dataset.executionId;
    const executionName = modal?.dataset.executionName;
    console.log('[BugManager] 执行信息:', executionId, executionName);

    // 验证必填项
    if (!projectId) {
      Toast.warning('请选择所属项目');
      return;
    }
    if (!title) {
      Toast.warning('请输入 Bug 标题');
      return;
    }
    if (!steps) {
      Toast.warning('请输入重现步骤');
      return;
    }

    // 使用 ButtonStateManager 管理按钮状态
    const restoreButton = ButtonStateManager.setLoading('submitBugBtn', {
      loadingText: '提交中...'
    });

    try {

    const bugData = {
      projectId,
      title,
      severity: parseInt(severity),
      type,
      steps,
      assignedToList,  // 改为数组，支持多个指派人
      assignedTo: assignedToList.length > 0 ? assignedToList[0] : '',  // 兼容旧API，取第一个作为主指派人
      cc: ccList,
      comment: '',  // 创建时没有备注字段，初始化为空
      // 如果有执行信息，添加到 Bug 数据中
      ...(executionId && { executionId: parseInt(executionId) }),
      ...(executionName && { executionName })
    };

    console.log('[BugManager] 准备提交 Bug 数据:', bugData);

    try {
      console.log('[BugManager] 准备通过浏览器扩展前端推送禅道 Bug...');

      const configResp = await fetch(`${API_BASE_URL}/api/zentao/config`);
      const configResult = await configResp.json();
      const baseUrl = configResult.data?.url?.replace(/\/$/, '') || null;

      if (baseUrl) {
        // 初始化 syncResponse，默认为失败（未同步到禅道）
        let syncResponse = { success: false, reason: 'not_attempted' };

        // 检查是否有执行ID
        if (!executionId) {
          console.warn('[BugManager] ⚠ 未选择执行，将 Bug 保存到本地，稍后可手动同步');
          ProgressToast.hide();
          Toast.info('未选择执行，Bug 已保存到本地。请在选择执行后点击同步按钮同步到禅道。');
          // 不 return，继续保存到本地（zentaoId 保持为 null）
          // syncResponse 已经初始化为失败状态，直接跳到保存逻辑
        } else {
          // 获取执行类型（判断是否为看板）
          let executionType = null;
          try {
            executionType = ExecutionFavorites.getExecutionType(executionId);
            console.log('[BugManager] 执行类型:', executionId, '=>', executionType);
          } catch (e) {
            console.warn('[BugManager] 获取执行类型失败:', e);
          }

        if (executionType === 'kanban') {
          // ========== 看板执行 Bug 创建 ==========
          console.log('[BugManager] 使用看板逻辑创建 Bug');

          ProgressToast.show('正在创建禅道 Bug...');

          try {
            console.log('[BugManager] 尝试获取看板参数, executionId:', executionId);
            const kanbanParams = await ZentaoBrowserClient.getKanbanParamsFromHtml(executionId, 'bug', 'unconfirmed');

            if (!kanbanParams) {
              console.error('[BugManager] ✗ 无法获取看板参数');
              console.warn('[BugManager] 禅道连通失败，将 Bug 保存到本地，稍后可手动同步');
              ProgressToast.hide();
              Toast.warning('禅道无法连通，Bug 已保存到本地，稍后可点击同步按钮重新同步');
              // syncResponse 已经是失败状态，直接跳到保存逻辑
            } else {
              console.log('[BugManager] 获取到看板参数:', kanbanParams);

              // ========== 严格参数验证：所有必需参数必须存在 ==========
              const requiredParams = ['productId', 'regionId', 'laneId', 'columnId'];
              const missingParams = requiredParams.filter(param => !kanbanParams[param]);

              if (missingParams.length > 0) {
                console.error('[BugManager] ✗ 看板参数不完整，缺少必需参数:', missingParams);
                console.error('[BugManager] 获取到的参数:', kanbanParams);
                console.warn('[BugManager] 禅道连通失败，将 Bug 保存到本地，稍后可手动同步');
                ProgressToast.hide();
                Toast.warning('禅道无法连通，Bug 已保存到本地，稍后可点击同步按钮重新同步');
                // syncResponse 已经是失败状态，直接跳到保存逻辑
              } else {
                // 所有必需参数都存在，继续处理
                bugData.productId = kanbanParams.productId;
                bugData.projectId = kanbanParams.projectId || bugData.projectId; // projectId 可选，优先使用看板解析的
                bugData.regionId = kanbanParams.regionId;
                bugData.laneId = kanbanParams.laneId;
                bugData.columnId = kanbanParams.columnId;

                console.log('[BugManager] ✓ 所有看板参数验证通过:', {
                  productId: bugData.productId,
                  projectId: bugData.projectId,
                  regionId: bugData.regionId,
                  laneId: bugData.laneId,
                  columnId: bugData.columnId
                });

                // 使用看板 Bug 创建接口
                syncResponse = await new Promise(resolve => {
                  const timeout = setTimeout(() => {
                    console.error('[BugManager] 看板 Bug 创建请求超时');
                    resolve({ success: false, reason: 'timeout', data: null });
                  }, 30000); // 30秒超时

                  chrome.runtime.sendMessage({
                    action: 'executeBugInZentaoPage',
                    baseUrl,
                    // productId 是必需的，不允许使用默认值
                    productId: bugData.productId,
                    bugData
                  }, (response) => {
                    clearTimeout(timeout);
                    resolve(response);
                  });
                });
              }
            }
          } catch (e) {
            console.error('[BugManager] 获取看板参数异常:', e);
            console.warn('[BugManager] 禅道连通失败，将 Bug 保存到本地，稍后可手动同步');
            ProgressToast.hide();
            Toast.warning('禅道无法连通，Bug 已保存到本地，稍后可点击同步按钮重新同步');
            // syncResponse 已经是失败状态，直接跳到保存逻辑
          }
        } else {
          // ========== 普通执行 Bug 创建 ==========
          console.log('[BugManager] 使用普通执行逻辑创建 Bug');

          ProgressToast.show('正在创建禅道 Bug...');

          // 获取 productID
          const productIdResponse = await new Promise(resolve => {
            const timeout = setTimeout(() => {
              console.error('[BugManager] 获取 productID 请求超时');
              resolve({ success: false, reason: 'timeout' });
            }, 15000); // 15秒超时

            chrome.runtime.sendMessage({
              action: 'getExecutionProductId',
              baseUrl,
              executionId
            }, (response) => {
              clearTimeout(timeout);
              resolve(response);
            });
          });

          if (!productIdResponse || !productIdResponse.success) {
            console.log('[BugManager] 获取 productID 失败:', productIdResponse?.reason, '- 保存到本地');
            console.warn('[BugManager] 禅道连通失败，将 Bug 保存到本地，稍后可手动同步');
            ProgressToast.hide();
            Toast.warning('禅道无法连通，Bug 已保存到本地，稍后可点击同步按钮重新同步');
            // syncResponse 已经是失败状态，跳到保存逻辑
          } else {
            // 成功获取 productID，继续创建 Bug
            const productId = productIdResponse.productId;
            console.log('[BugManager] ✓ 获取到 productID:', productId);

            bugData.productId = productId;

            // 使用普通执行 Bug 创建接口
            syncResponse = await new Promise(resolve => {
              const timeout = setTimeout(() => {
                console.error('[BugManager] 普通 Bug 创建请求超时');
                resolve({ success: false, reason: 'timeout', data: null });
              }, 60000); // 60秒超时（包括轮询等待时间）

              chrome.runtime.sendMessage({
                action: 'executeNormalExecutionBugInZentaoPage',
                baseUrl,
                productId,
                bugData
              }, (response) => {
                clearTimeout(timeout);
                resolve(response);
              });
            });
          }
        } // 结束 else (普通执行)
        } // 结束 if (executionId) 块

        // 检查同步结果，如果成功则提取 bugId
        if (syncResponse && syncResponse.success) {
          // 适配返回结构，提取 bugId
          const data = syncResponse.data;

          // ========== 添加详细日志：响应数据结构 ==========
          console.log('[BugManager] ========== Bug 创建响应分析 ==========');
          console.log('[BugManager] 完整响应数据:', JSON.stringify(data, null, 2));
          console.log('[BugManager] data.id:', data?.id);
          console.log('[BugManager] data.bug?.id:', data?.bug?.id);
          console.log('[BugManager] data.data?.id:', data?.data?.id);
          console.log('[BugManager] data.callback (前500字符):', data?.callback?.substring(0, 500));
          console.log('[BugManager] data.callback (后500字符):', data?.callback?.substring(data.callback.length - 500));
          console.log('[BugManager] data.locate:', data?.locate);

          let bugId = data?.id || data?.bug?.id || data?.data?.id;

          // 如果响应中包含看板回调数据，尝试从中提取 Bug ID
          if (!bugId && data?.callback) {
            console.log('[BugManager] ========== 尝试从 callback 中提取 Bug ID ==========');
            console.log('[BugManager] callback 长度:', data.callback.length);
            console.log('[BugManager] 查找的 Bug 标题:', bugData.title);

            // 方法1: 从 callback 中解析 updateKanban 的参数
            try {
              // 提取 parent.updateKanban(...) 中的 JSON
              const kanbanMatch = data.callback.match(/parent\.updateKanban\((.+)\)\)/);
              console.log('[BugManager] updateKanban 匹配结果:', kanbanMatch ? '成功' : '失败');
              if (kanbanMatch) {
                const kanbanJson = kanbanMatch[1];
                console.log('[BugManager] 提取到 kanban JSON (前500字符):', kanbanJson.substring(0, 500));

                // 解析 JSON
                const kanbanData = JSON.parse(kanbanJson);
                console.log('[BugManager] 解析 kanbanData 成功，顶层键:', Object.keys(kanbanData));

                // 遍历所有 region
                let regionCount = 0;
                let groupCount = 0;
                let columnCount = 0;
                let itemCount = 0;

                for (const regionKey in kanbanData) {
                  regionCount++;
                  const region = kanbanData[regionKey];
                  console.log('[BugManager] Region ' + regionCount + ':', regionKey, 'groups 数量:', region.groups?.length);

                  if (region.groups) {
                    // 遍历所有 groups
                    for (const group of region.groups) {
                      groupCount++;
                      console.log('[BugManager]   Group ' + groupCount + ':', group.id, 'columns 数量:', group.columns?.length);

                      if (group.columns) {
                        // 遍历所有 columns
                        for (const column of group.columns) {
                          columnCount++;
                          console.log('[BugManager]     Column ' + columnCount + ': type=' + column.type + ', items 数量:', column.items?.length);

                          // 查找 unconfirmed 类型的 column
                          if (column.type === 'unconfirmed' && column.items && column.items.length > 0) {
                            console.log('[BugManager]       ✓ 找到 unconfirmed column，包含 ' + column.items.length + ' 个 items');

                            // 遍历 items，根据标题匹配查找 Bug ID
                            for (const item of column.items) {
                              itemCount++;
                              console.log('[BugManager]         Item ' + itemCount + ': id=' + item.id + ', title="' + item.title + '"');

                              if (item.title === bugData.title) {
                                bugId = item.id;
                                console.log('[BugManager]         ✓✓✓ 标题匹配找到 Bug ID:', bugId);
                                break;
                              }
                            }

                            if (bugId) break;
                          }
                        }
                      }
                      if (bugId) break;
                    }
                  }
                  if (bugId) break;
                }
                console.log('[BugManager] 遍历统计: region=' + regionCount + ', group=' + groupCount + ', column=' + columnCount + ', item=' + itemCount);
              }
            } catch (parseErr) {
              console.error('[BugManager] ✗ 解析 callback JSON 失败:', parseErr.message);
              console.error('[BugManager] 错误堆栈:', parseErr.stack);
            }

            // 方法2: 如果方法1失败，尝试用正则匹配 Bug ID（回退方案）
            if (!bugId) {
              console.log('[BugManager] ========== 方法1失败，尝试正则匹配 ==========');

              // 尝试多种正则模式
              const patterns = [
                { name: 'items.unconfirmed.id', pattern: /"items":\{[^}]*"unconfirmed":\s*\[\{[^}]*"id":\s*"(\d+)"/ },
                { name: 'unconfirmed array', pattern: /"unconfirmed":\s*\[\s*\{[^}]*"id":\s*"(\d+)"/ },
                { name: 'generic id in callback', pattern: /"id":\s*"(\d+)"/g },
                { name: 'bug-view in callback', pattern: /bug-view-(\d+)/ }
              ];

              for (const { name, pattern } of patterns) {
                const match = data.callback.match(pattern);
                if (match) {
                  if (match.length > 1 && match[1]) {
                    bugId = parseInt(match[1]);
                    console.log('[BugManager] ✓ 通过 ' + name + ' 匹配到 Bug ID:', bugId);
                    break;
                  }
                  // 对于全局匹配，取最后一个（最新的）
                  if (name === 'generic id in callback') {
                    const allMatches = [...data.callback.matchAll(pattern)];
                    if (allMatches.length > 0) {
                      bugId = parseInt(allMatches[allMatches.length - 1][1]);
                      console.log('[BugManager] ✓ 通过 ' + name + ' 匹配到 Bug ID (最后匹配):', bugId);
                      break;
                    }
                  }
                }
              }

              if (!bugId) {
                console.log('[BugManager] ✗ 所有正则模式都未匹配到 Bug ID');
              }
            }
            console.log('[BugManager] ========== callback 提取结束 ==========');
          }

          if (!bugId && data?.locate) {
            console.log('[BugManager] ========== 尝试从 locate 提取 Bug ID ==========');
            console.log('[BugManager] locate:', data.locate);
            const match = data.locate.match(/bug-view-(\d+)/);
            if (match) {
              bugId = parseInt(match[1]);
              console.log('[BugManager] ✓ 从 locate 匹配到 Bug ID:', bugId);
            } else {
              console.log('[BugManager] ✗ locate 中未找到 bug-view-XXX 模式');
            }
          }

          console.log('[BugManager] ========== 最终结果 ==========');
          console.log('[BugManager] 最终提取的 Bug ID:', bugId);
          if (!bugId) {
            console.error('[BugManager] ✗✗✗ Bug ID 提取失败 ✗✗✗');
            console.error('[BugManager] 可用字段:', {
              'data.id': data?.id,
              'data.bug?.id': data?.bug?.id,
              'data.data?.id': data?.data?.id,
              'data.locate': data?.locate,
              'data.callback 存在': !!data?.callback,
              'data.callback 长度': data?.callback?.length
            });
          }
          console.log('[BugManager] ========== 响应分析结束 ==========');

          if (bugId) {
            bugData.zentaoId = bugId;
            console.log('[BugManager] ✓ 禅道 Bug 创建成功，ID:', bugId);
            console.log('[BugManager] Bug 数据（保存前）:', {
              title: bugData.title,
              zentaoId: bugData.zentaoId,
              executionId: bugData.executionId,
              projectId: bugData.projectId
            });
          } else {
             console.log('[BugManager] ✗ 禅道 Bug 可能创建成功，但无法提取 ID', data);
          }
          ProgressToast.hide();
        } else if (syncResponse === null || syncResponse === undefined) {
          ProgressToast.hide();
          console.error('[BugManager] 禅道 Bug 同步响应为空，可能消息处理失败');
          Toast.error('禅道同步失败：未收到响应，请检查扩展是否正常工作');
          return;
        } else if (syncResponse && syncResponse.success !== undefined) {
          console.warn('[BugManager] 禅道 Bug 同步失败, success:', syncResponse.success, 'reason:', syncResponse.reason, 'data:', syncResponse.data);
          // 会话过期由后端自动重新登录；走到这里是真失败（网络/权限/参数），本地照常保存
          ProgressToast.hide();
          Toast.warning('禅道同步失败，将在本地保存 (' + (syncResponse.reason || '未知错误') + ')');
        }
      }
    } catch (syncError) {
      ProgressToast.hide();
      console.error('[BugManager] 禅道同步失败，将继续保存到本地:', syncError);
      // 禅道同步失败不影响本地保存，继续执行
    }

    // 保存到本地
    console.log('[BugManager] ========== 保存 Bug 到本地 ==========');
      console.log('[BugManager] 准备保存的 Bug 数据:', JSON.stringify(bugData, null, 2));
      console.log('[BugManager] Bug 数据关键字段:', {
        title: bugData.title,
        zentaoId: bugData.zentaoId,
        executionId: bugData.executionId,
        projectId: bugData.projectId,
        type: typeof bugData.type,
        severity: bugData.severity
      });

      const response = await fetch(`${API_BASE_URL}/api/bug`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bugData)
      });
      const result = await response.json();

      console.log('[BugManager] 本地保存响应:', result);
      console.log('[BugManager] 本地保存 success:', result.success);

      if (result.success) {
        console.log('[BugManager] ✓ Bug 保存到本地成功');
        console.log('[BugManager] 返回的 Bug 数据:', result.data);

        // 根据同步状态显示不同的提示
        if (bugData.zentaoId) {
          Toast.success('Bug 已创建并同步到禅道');
        } else {
          Toast.success('Bug 已保存到本地，稍后可点击"同步"按钮同步到禅道');
        }

        // 先取出附件（关闭弹窗会清空选择区），本地保存成功后上传；
        // Bug 已在禅道创建的，后端会立即推送（截图同时插进重现步骤），否则同步到禅道后自动上传
        const attachmentItems = this.attachmentPicker ? this.attachmentPicker.getItems() : [];
        const localBugId = result.data && result.data.id;
        this.clearDraft();
        this.hideBugModal();
        if (attachmentItems.length && localBugId) {
          AttachmentApi.uploadAll(localBugId, attachmentItems, { inline: true })
            .then(({ failed }) => {
              if (failed.length) Toast.error(`${failed.length} 个附件添加失败：${failed.map(f => f.message).join('；')}`, 6000);
            })
            .catch(err => Toast.error(`附件添加失败：${err.message}`, 6000))
            .finally(() => this.loadBugs());
        }
        // 清除 modal 中的执行信息
        if (modal) {
          delete modal.dataset.executionId;
          delete modal.dataset.executionName;
        }

        // 延迟一下再加载，确保数据已保存
        setTimeout(() => {
          console.log('[BugManager] 准备重新加载 Bug 列表...');
          this.loadBugs(); // 重新加载 Bug 列表
        }, 100);
      } else {
        console.error('[BugManager] ✗ Bug 保存到本地失败:', result.error);
        Toast.error('创建失败: ' + (result.error || '未知错误'));
      }
      console.log('[BugManager] ========== 本地保存结束 ==========');
    } catch (err) {
      console.error('[BugManager] 创建 Bug 失败:', err);
      Toast.error('创建失败: ' + err.message);
    } finally {
      restoreButton();
    }
  },

  saveDraftDebounced() {
    clearTimeout(this.draftTimeout);
    this.draftTimeout = setTimeout(() => this.saveDraft(), 500);
  },

  saveDraft() {
    // 获取指派人（多选）
    const assignedToList = this.getMultiSelectValues('bugAssignee');

    // 获取抄送人（多选）
    const ccList = this.getMultiSelectValues('bugCc');

    const draft = {
      projectId: document.getElementById('bugProject').value,
      title: document.getElementById('bugTitle').value,
      severity: document.getElementById('bugSeverity').value,
      type: document.getElementById('bugType').value,
      steps: document.getElementById('bugSteps').value,
      assignedToList,  // 保存指派人列表
      ccList,          // 保存抄送人列表
      savedAt: new Date().toISOString()
    };

    localStorage.setItem('bug_draft', JSON.stringify(draft));
    this.draft = draft;

    // 显示保存提示
    const savedSpan = document.getElementById('bugDraftSaved');
    if (savedSpan) {
      savedSpan.style.display = 'inline';
      setTimeout(() => savedSpan.style.display = 'none', 2000);
    }
  },

  loadDraft() {
    const draftStr = localStorage.getItem('bug_draft');
    if (draftStr) {
      try {
        this.draft = JSON.parse(draftStr);
      } catch (e) {
        console.error('[BugManager] 解析草稿失败:', e);
        this.draft = null;
      }
    }
  },

  restoreDraft() {
    if (!this.draft) return;

    document.getElementById('bugProject').value = this.draft.projectId || '';
    document.getElementById('bugTitle').value = this.draft.title || '';
    document.getElementById('bugSeverity').value = this.draft.severity || '3';
    document.getElementById('bugType').value = this.draft.type || 'codeerror';
    document.getElementById('bugSteps').value = this.draft.steps || '';

    // 恢复指派人（多选）
    if (this.draft.assignedToList && this.draft.assignedToList.length > 0) {
      this.setMultiSelectValues('bugAssignee', this.draft.assignedToList);
    }

    // 恢复抄送人（多选）
    if (this.draft.ccList && this.draft.ccList.length > 0) {
      this.setMultiSelectValues('bugCc', this.draft.ccList);
    }
  },

  clearDraft() {
    localStorage.removeItem('bug_draft');
    this.draft = null;

    // 清空表单
    document.getElementById('bugProject').value = '';
    document.getElementById('bugTitle').value = '';
    document.getElementById('bugSeverity').value = '3';
    document.getElementById('bugType').value = 'codeerror';
    document.getElementById('bugSteps').value = '';

    // 清空指派人选择
    this.clearMultiSelectValues('bugAssignee');

    // 清空抄送人选择
    this.clearMultiSelectValues('bugCc');
  },

  /**
   * 删除所有 Bug 卡片
   */
  async deleteAllBugs() {
    if (!(await Confirm.show('删除所有 Bug 卡片', '会删除插件里的全部 Bug 卡片（禅道里的 Bug 不受影响），此操作不可恢复。', '全部删除', '取消', { danger: true }))) {
      return;
    }

    try {
      const response = await fetch(`${API_BASE_URL}/api/bugs/all`, {
        method: 'DELETE'
      });
      const result = await response.json();

      if (result.success) {
        Toast.success(`已删除 ${result.deletedCount} 个 Bug`);
        // 重新加载 Bug 列表
        await this.loadBugs();
      } else {
        Toast.error('删除失败: ' + (result.error || '未知错误'));
      }
    } catch (err) {
      console.error('[BugManager] 删除所有 Bug 失败:', err);
      Toast.error('删除失败: ' + err.message);
    }
  },

  /**
   * 显示 Bug 详情弹窗
   */
  async showBugDetail(bugId) {
    const bug = this.bugs.find(b => b.id === bugId);
    if (!bug) return;

    const modal = document.getElementById('bugDetailModal');
    const headerInfo = document.getElementById('bugDetailHeaderInfo');
    const content = document.getElementById('bugDetailContent');
    const actions = document.getElementById('bugDetailActions');

    if (!modal || !headerInfo || !content || !actions) return;

    modal.dataset.bugId = bugId;
    const severityText = ['', '致命', '严重', '一般', '提示'][bug.severity || 3];
    // 已解决的状态是 resolved（以前只认 closed，已解决的 Bug 会显示英文 resolved）
    const statusText = { unconfirmed: '未确认', activated: '已确认', resolved: '已解决', closed: '已关闭' }[bug.status] || bug.status;

    // 在标题栏显示优先级和状态
    headerInfo.innerHTML = `
      <span class="bug-severity bug-severity-${bug.severity || 3}" style="font-size: 12px; padding: 2px 8px;">${severityText}</span>
      <span style="font-size: 12px; color: var(--text-secondary);">${statusText}</span>
    `;

    // 获取用户列表用于显示名称（账号 -> 姓名的映射）
    const users = await ZentaoBrowserClient.getUsers() || {};

    // 辅助函数：将用户账号或姓名转换为显示文本
    const getDisplayName = (user) => {
      if (!user) return '';
      // 如果已经在 users 映射中找到，说明是账号
      if (users[user]) {
        return users[user];
      }
      // 否则判断是否是账号（通常账号较短，不含中文）
      // 如果包含中文，认为是姓名，直接返回
      if (/[\u4e00-\u9fa5]/.test(user)) {
        return user;
      }
      // 否则返回原文
      return user;
    };

    // 格式化指派人
    let assigneeText = '';
    if (bug.assignedTo) {
      let assigneeList = [];
      if (Array.isArray(bug.assignedTo)) {
        assigneeList = bug.assignedTo;
      } else if (typeof bug.assignedTo === 'string') {
        // 字符串格式，按空格或逗号分隔
        assigneeList = bug.assignedTo.split(/[\s,]+/).filter(a => a);
      }
      if (assigneeList.length > 0) {
        assigneeText = assigneeList.map(getDisplayName).join(', ');
      }
    }

    // 格式化抄送人
    let ccText = '';
    if (bug.cc) {
      let ccList = [];
      if (Array.isArray(bug.cc)) {
        ccList = bug.cc;
      } else if (typeof bug.cc === 'string') {
        // 字符串格式，按空格分隔
        ccList = bug.cc.split(/\s+/).filter(cc => cc);
      }
      if (ccList.length > 0) {
        ccText = ccList.map(getDisplayName).join(', ');
      }
    }

    const priority = Number(bug.priority) || 3;
    const severity = Number(bug.severity) || 3;
    const typeText = this.getBugTypeText ? this.getBugTypeText(bug.bugType) : (bug.bugType || '');
    content.innerHTML = `
      <div style="margin-bottom: 16px;">
        <h4 class="bug-detail-title" tabindex="0" role="button" title="点击编辑标题"><span class="bdt-text">${escapeHtml(bug.title)}</span><span class="bdt-pen" aria-hidden="true">✎</span></h4>
        <div class="bug-detail-fields">
          <div class="bdf"><span class="bdf-k">优先级</span><button type="button" class="bug-priority-toggle bug-pri-${priority}" data-bd="priority">P${priority} <span class="bug-pri-caret">▼</span></button></div>
          <div class="bdf"><span class="bdf-k">严重程度</span><button type="button" class="bug-severity bug-severity-${severity} bug-severity-toggle" data-bd="severity">${severityText} <span class="bug-pri-caret">▼</span></button></div>
          <div class="bdf"><span class="bdf-k">指派人</span><button type="button" class="bug-assignee bug-assignee-btn ${assigneeText ? '' : 'is-empty'}" data-bd="assignee">👤 ${escapeHtml(assigneeText || '未指派')} <span class="bug-pri-caret">▼</span></button></div>
          <div class="bdf"><span class="bdf-k">禅道</span>${bug.zentaoId ? `<a href="#" class="bug-id-link-inline" data-bd="zentao" style="margin-left:0">#${escapeHtml(bug.zentaoId)}</a>` : '<span class="bdf-v is-muted">未关联</span>'}</div>
          ${typeText ? `<div class="bdf"><span class="bdf-k">类型</span><span class="bdf-v">${escapeHtml(typeText)}</span></div>` : ''}
          ${bug.productName || bug.projectName ? `<div class="bdf"><span class="bdf-k">所属</span><span class="bdf-v">${escapeHtml(bug.productName || bug.projectName)}</span></div>` : ''}
          ${bug.openedBy ? `<div class="bdf"><span class="bdf-k">创建人</span><span class="bdf-v">${escapeHtml(getDisplayName(bug.openedBy))}</span></div>` : ''}
          ${(() => { if (typeof recordTimes !== 'function') return ''; const [c, e] = recordTimes(bug); return (c ? `<div class="bdf"><span class="bdf-k">创建时间</span><span class="bdf-v">${escapeHtml(c.slice(0, 16))}</span></div>` : '') + (e && e > c ? `<div class="bdf"><span class="bdf-k">最后修改</span><span class="bdf-v">${escapeHtml(e.slice(0, 16))}</span></div>` : ''); })()}
          ${bug.assignedDate && !String(bug.assignedDate).startsWith('0000') ? `<div class="bdf"><span class="bdf-k">指派时间</span><span class="bdf-v">${escapeHtml(bug.assignedDate)}</span></div>` : ''}
        </div>
        ${bug.steps ? `
          <div style="margin-top: 12px;">
            <p style="margin: 0 0 8px 0; font-size: 13px; font-weight: 500;">重现步骤:</p>
            <div style="padding: 12px; background: var(--bg-secondary); border-radius: 6px;">
              <p style="margin: 0; font-size: 13px; white-space: pre-wrap;">${escapeHtml(bug.steps)}</p>
            </div>
          </div>
        ` : ''}
        <div class="att-section" style="margin-top: 12px;"></div>
        ${bug.history && bug.history.length > 0 ? `
          <div style="margin-top: 12px;">
            <p style="margin: 0 0 8px 0; font-size: 13px; font-weight: 500;">历史记录:</p>
            ${bug.history.map((item, index) => `
              <div style="padding: 12px; background: var(--bg-secondary); border-radius: 6px; margin-bottom: ${index < bug.history.length - 1 ? '8px' : '0'};">
                <p style="margin: 0 0 4px 0; font-size: 12px; color: var(--text-muted);">${escapeHtml(item.text)}</p>
                ${item.comment ? `<p style="margin: 4px 0 0 0; font-size: 13px; white-space: pre-wrap; color: var(--text-secondary);">${escapeHtml(item.comment)}</p>` : ''}
              </div>
            `).join('')}
          </div>
        ` : ''}
        ${bug.comments && bug.comments.length > 0 ? `
          <div style="margin-top: 12px;">
            <p style="margin: 0 0 8px 0; font-size: 13px; font-weight: 500;">备注:</p>
            ${bug.comments.map((comment, index) => {
              const date = new Date(comment.timestamp);
              const dateStr = `${date.getMonth() + 1}月${date.getDate()}日 ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
              return `
                <div key="${index}" style="padding: 12px; background: var(--bg-secondary); border-radius: 6px; margin-bottom: ${index < bug.comments.length - 1 ? '8px' : '0'};">
                  <p style="margin: 0 0 4px 0; font-size: 11px; color: var(--text-muted);">${dateStr} ${comment.author || ''}</p>
                  <p style="margin: 0; font-size: 13px; white-space: pre-wrap;">${escapeHtml(comment.content)}</p>
                </div>
              `;
            }).join('')}
          </div>
        ` : ''}
        ${ccText ? `<div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border);"><p style="margin: 4px 0; font-size: 13px; color: var(--text-secondary);">抄送人: ${escapeHtml(ccText)}</p></div>` : ''}
      </div>
    `;

    // 详情里的编辑：与卡片一致（标题原地编辑；优先级 / 严重程度 / 指派人点击即改，写回禅道）
    const titleEl = content.querySelector('.bug-detail-title');
    const editTitle = () => this.editBugTitleInline(titleEl.querySelector('.bdt-text'), bugId);
    titleEl.addEventListener('click', editTitle);
    titleEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === titleEl) { e.preventDefault(); editTitle(); } });
    content.querySelector('[data-bd="priority"]').addEventListener('click', (e) => {
      e.stopPropagation();
      this.openChoiceMenu(e.currentTarget, BUG_PRIORITY_CHOICES, priority, (value) => this.saveBugFields(bugId, { priority: value }));
    });
    content.querySelector('[data-bd="severity"]').addEventListener('click', (e) => {
      e.stopPropagation();
      this.openChoiceMenu(e.currentTarget, BUG_SEVERITY_CHOICES, severity, (value) => this.saveBugFields(bugId, { severity: value }));
    });
    content.querySelector('[data-bd="assignee"]').addEventListener('click', (e) => {
      e.stopPropagation();
      this.openAssignPopover(e.currentTarget, bugId);
    });
    content.querySelector('[data-bd="zentao"]')?.addEventListener('click', (e) => {
      e.preventDefault();
      openInZentao('bug', bug.zentaoId);
    });

    // 清空并重新创建按钮，避免 CSP 问题
    // 附件区：截图 / 录屏预览、下载、追加（可直接粘贴截图）、删除、重试
    if (typeof AttachmentPanel !== 'undefined') {
      AttachmentPanel.mount(content.querySelector('.att-section'), bug, { onChanged: () => this.loadBugs() });
    }

    actions.innerHTML = '';
    const addAction = (text, cls, onClick) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = cls;
      btn.textContent = text;
      btn.onclick = onClick;
      actions.appendChild(btn);
    };
    // 「关联禅道 Bug」（原「编辑BugID」）；状态动作按当前状态：确认 / 解决 / 激活（原来的「已解决」是动作，改名「解决」）
    addAction('关联禅道 Bug', 'btn-secondary', () => this.showEditBugIdModal(bugId, bug.zentaoId));
    if (bug.status === 'unconfirmed') addAction('确认', 'btn-primary', () => this.activateBug(bugId));
    if (bug.status === 'unconfirmed' || bug.status === 'activated') addAction('解决', 'btn-primary', () => this.showResolveModal(bugId));
    if (bug.status === 'resolved' && bug.zentaoId) addAction('激活', 'btn-primary', () => this.showReactivateModal(bugId));
    if ((bug.status === 'unconfirmed' || bug.status === 'activated') && bug.zentaoId && typeof TaskLinkDialog !== 'undefined') {
      addAction('转任务', 'btn-secondary', () => { this.hideBugDetail(); TaskLinkDialog.openForBug(bug); });
    }
    addAction('删除', 'btn-danger', () => this.deleteBug(bugId));
    actions.classList.add('bug-detail-actions');

    modal.style.display = 'flex';
  },

  /**
   * 隐藏 Bug 详情弹窗
   */
  hideBugDetail() {
    const modal = document.getElementById('bugDetailModal');
    if (modal) {
      modal.style.display = 'none';
    }
  },

  /**
   * 显示修复弹窗
   */
  async showResolveModal(bugId) {
    const bug = this.bugs.find(b => b.id === bugId);
    if (!bug) return;

    // 先隐藏详情弹窗
    this.hideBugDetail();

    const modal = document.getElementById('bugResolveModal');
    if (!modal) return;

    // 加载用户列表到指派人下拉框
    await this.loadResolveUserOptions();

    // 保存当前操作的 Bug ID
    modal.dataset.bugId = bugId;

    // 默认指派给当前登录用户（可改）
    this.setSingleSelectValue('resolveAssigneeDisplay', this.currentAccount(), await ZentaoBrowserClient.getUsers() || {});

    // 验证截图 / 附件：随「解决」动作一起提交到禅道（出现在该次解决的历史记录下）
    const resolveAttachmentsHost = document.getElementById('resolveAttachments');
    if (resolveAttachmentsHost && typeof AttachmentPicker !== 'undefined') {
      if (!this.resolveAttachmentPicker) {
        this.resolveAttachmentPicker = new AttachmentPicker(resolveAttachmentsHost, {
          hint: '可附上修复后的验证截图，随「解决」一起提交到禅道'
        });
      }
      this.resolveAttachmentPicker.clear();
      this.resolveAttachmentPicker.bindPaste(modal);
    }
    modal.style.display = 'flex';
  },

  /**
   * 隐藏修复弹窗
   */
  hideResolveModal() {
    const modal = document.getElementById('bugResolveModal');
    if (modal) {
      modal.style.display = 'none';
      // 清空表单
      document.getElementById('resolveResolution').value = 'fixed';

      // 清空自定义多选组件的指派人选择
      const assigneeDisplay = document.getElementById('resolveAssigneeDisplay');
      if (assigneeDisplay) {
        assigneeDisplay.dataset.value = '';
        assigneeDisplay.innerHTML = '<span class="multi-select-placeholder">请选择指派人</span>';
      }

      document.getElementById('resolveComment').value = '';
    }
    if (this.resolveAttachmentPicker) this.resolveAttachmentPicker.clear();
  },

  /**
   * 激活 Bug
   */
  async activateBug(bugId) {
    console.log('[BugManager] ========== 激活 Bug 开始 ==========');
    console.log('[BugManager] Bug ID:', bugId);

    const bug = this.bugs.find(b => b.id === bugId);
    if (!bug) {
      console.error('[BugManager] 未找到 Bug:', bugId);
      return;
    }

    console.log('[BugManager] Bug 信息:', { id: bug.id, zentaoId: bug.zentaoId, title: bug.title, executionId: bug.executionId });

    if (!bug.zentaoId) {
      Toast.warning('该 Bug 未同步到禅道');
      return;
    }

    // 激活 Bug 不需要执行信息，直接显示激活表单
    this.showActivateModal(bugId);
  },

  /**
   * 显示激活弹窗
   */
  async showActivateModal(bugId) {
    const bug = this.bugs.find(b => b.id === bugId);
    if (!bug) return;

    const modal = document.getElementById('bugActivateModal');
    if (!modal) return;

    // 隐藏详情弹窗
    this.hideBugDetail();

    // 加载用户列表到下拉框
    await this.loadActivateUserOptions();

    // 强制清空抄送人选择（避免带入上次的值）
    const ccContainer = document.getElementById('activateCcContainer');
    if (ccContainer && ccContainer._selectedUsers) {
      ccContainer._selectedUsers.clear();
    }
    const ccDisplay = document.getElementById('activateCcDisplay');
    if (ccDisplay) {
      ccDisplay.innerHTML = '<span class="multi-select-placeholder">请选择抄送人</span>';
    }

    // 保存当前操作的 Bug ID
    modal.dataset.bugId = bugId;
    modal.dataset.zentaoBugId = bug.zentaoId;
    // 注意：激活 Bug 不需要 executionId，所以不再保存它

    // 带入 Bug 原来的优先级与类型（以前固定重置为 3 / 代码错误，确认时会悄悄改掉禅道里的值）
    document.getElementById('activatePri').value = String(Number(bug.priority) || 3);
    const typeSelect = document.getElementById('activateType');
    typeSelect.value = bug.bugType || 'codeerror';
    if (!typeSelect.value) typeSelect.value = 'codeerror';
    document.getElementById('activateComment').value = '';

    // 如果 Bug 缺少 assignedTo 或 cc 字段（用户手动添加的 BugID），从禅道获取 Bug 详情
    if (!bug.assignedTo || !bug.cc) {
      console.log('[BugManager] Bug 缺少指派人或抄送人信息，尝试从禅道获取...');
      const bugDetail = await this.fetchBugDetailFromZentao(bug.zentaoId);
      if (bugDetail) {
        // 更新 Bug 对象
        if (bugDetail.assignedTo) {
          bug.assignedTo = bugDetail.assignedTo;
          console.log('[BugManager] 从禅道获取到指派人:', bugDetail.assignedTo);
        }
        if (bugDetail.cc) {
          bug.cc = bugDetail.cc;
          console.log('[BugManager] 从禅道获取到抄送人:', bug.cc);
        }

        // 保存更新后的 Bug 数据
        await this.updateBugData(bug);
      }
    }

    // 默认指派给当前登录用户（可改）
    this.setSingleSelectValue('activateAssigneeDisplay', this.currentAccount(), await ZentaoBrowserClient.getUsers() || {});

    // 设置默认抄送人（使用 Bug 创建时的抄送人）
    if (bug.cc) {
      let ccList = [];

      // 处理不同的 cc 格式
      if (Array.isArray(bug.cc)) {
        ccList = bug.cc;
      } else if (typeof bug.cc === 'string' && bug.cc.trim() !== '') {
        // 字符串格式，按空格分隔
        ccList = bug.cc.split(/\s+/).filter(cc => cc);
      }

      if (ccList.length > 0) {
        const ccContainer = document.getElementById('activateCcContainer');
        if (ccContainer && ccContainer._selectedUsers) {
          const users = await ZentaoBrowserClient.getUsers();

          // 清空现有选择
          ccContainer._selectedUsers.clear();

          // 添加 Bug 的抄送人（需要转换为账号）
          ccList.forEach(ccItem => {
            let ccAccount = ccItem;

            // 如果是姓名，尝试反向查找账号
            if (/[\u4e00-\u9fa5]/.test(ccItem) && users) {
              const foundAccount = Object.keys(users).find(account => users[account] === ccItem);
              if (foundAccount) {
                ccAccount = foundAccount;
              }
            }

            // 只有当是有效的账号格式（不包含中文）或者是查找成功时才添加
            if (!/[\u4e00-\u9fa5]/.test(ccAccount) || ccItem === ccAccount) {
              ccContainer._selectedUsers.add(ccAccount);
            }
          });

          console.log('[BugManager] 设置的抄送人账号:', Array.from(ccContainer._selectedUsers));

          // 更新显示
          this.updateMultiSelectDisplayById('activateCc', ccContainer._selectedUsers, users);
          // 更新下拉列表中的选中状态
          const optionsContainer = document.getElementById('activateCcOptions');
          if (optionsContainer) {
            optionsContainer.querySelectorAll('.multi-select-option').forEach(option => {
              const account = option.dataset.value;
              if (ccContainer._selectedUsers.has(account)) {
                option.classList.add('selected');
              } else {
                option.classList.remove('selected');
              }
            });
          }
        }
      }
    }

    modal.style.display = 'flex';
  },

  /**
   * 隐藏激活弹窗
   */
  hideActivateModal() {
    const modal = document.getElementById('bugActivateModal');
    if (modal) {
      modal.style.display = 'none';

      // 清空表单
      document.getElementById('activatePri').value = '3';
      document.getElementById('activateType').value = 'codeerror';
      document.getElementById('activateComment').value = '';

      // 清空自定义多选组件
      const assigneeDisplay = document.getElementById('activateAssigneeDisplay');
      if (assigneeDisplay) {
        assigneeDisplay.dataset.value = '';
        assigneeDisplay.innerHTML = '<span class="multi-select-placeholder">请选择指派人</span>';
      }

      const ccContainer = document.getElementById('activateCcContainer');
      if (ccContainer && ccContainer._selectedUsers) {
        ccContainer._selectedUsers.clear();
      }
      const ccDisplay = document.getElementById('activateCcDisplay');
      if (ccDisplay) {
        ccDisplay.innerHTML = '<span class="multi-select-placeholder">请选择抄送人</span>';
      }
    }
  },

  /**
   * 加载激活表单的用户选项
   */
  async loadActivateUserOptions() {
    const assigneeContainer = document.getElementById('activateAssigneeContainer');
    const ccContainer = document.getElementById('activateCcContainer');

    if (!assigneeContainer || !ccContainer) return;

    // 获取用户列表
    let users = await ZentaoBrowserClient.getUsers();
    const userCount = users ? Object.keys(users).length : 0;
    console.log('[BugManager] 获取到用户列表，用户数量:', userCount);

    // 如果用户列表为空或数量太少（可能加载失败），尝试重新加载
    if (!users || userCount === 0) {
      console.warn('[BugManager] 用户列表未加载，尝试从禅道加载...');
      await ZentaoBrowserClient.refreshUsersFromZentao();
      users = await ZentaoBrowserClient.getUsers();
      console.log('[BugManager] 从禅道加载后用户数量:', Object.keys(users).length);
    } else if (userCount < 5) {
      // 用户列表数量太少，可能是加载不完整，尝试重新加载
      console.warn('[BugManager] 用户列表数量过少(', userCount, '个)，可能加载不完整，尝试重新加载...');
      await ZentaoBrowserClient.refreshUsersFromZentao();
      users = await ZentaoBrowserClient.getUsers();
      console.log('[BugManager] 重新加载后用户数量:', Object.keys(users).length);
    }

    if (!users || Object.keys(users).length === 0) {
      console.warn('[BugManager] 无法获取用户列表');
      return;
    }

    console.log('[BugManager] 加载用户列表到激活表单，用户数量:', Object.keys(users).length);

    // 填充指派人下拉框（单选）
    const assigneeSelect = document.getElementById('activateAssigneeDisplay');
    this.initSingleSelect(assigneeContainer, users);

    // 填充抄送人下拉框（多选）
    const ccSelect = document.getElementById('activateCcDisplay');
    this.initMultiSelectById('activateCc', users);
  },

  /**
   * 加载修复表单的用户选项（自定义多选组件）
   */
  async loadResolveUserOptions() {
    const container = document.getElementById('resolveAssigneeContainer');
    if (!container) return;

    // 获取用户列表
    let users = await ZentaoBrowserClient.getUsers();
    const userCount = users ? Object.keys(users).length : 0;
    console.log('[BugManager] 获取到用户列表，用户数量:', userCount);

    if (!users || userCount === 0) {
      console.warn('[BugManager] 用户列表未加载，尝试加载...');
      await ZentaoBrowserClient.refreshUsersFromZentao();
      users = await ZentaoBrowserClient.getUsers();
      console.log('[BugManager] 从禅道加载后用户数量:', Object.keys(users).length);
    }

    if (!users || Object.keys(users).length === 0) {
      console.warn('[BugManager] 无法获取用户列表');
      return;
    }

    console.log('[BugManager] 加载用户列表到解决表单，用户数量:', Object.keys(users).length);

    // 初始化单选组件
    this.initSingleSelect(container, users);

    console.log('[BugManager] 解决表单用户选项加载完成');
  },

  /**
   * 初始化单选组件
   */
  initSingleSelect(container, users) {
    const display = container.querySelector('.multi-select-display');
    const dropdown = container.querySelector('.multi-select-dropdown');
    const optionsContainer = container.querySelector('.multi-select-options');

    if (!display || !dropdown || !optionsContainer) {
      console.warn('[BugManager] initSingleSelect: 容器元素未找到');
      return;
    }

    // 每次打开弹窗都会重新初始化：先撤掉上一次绑定的监听，避免同一元素上越绑越多
    const listenerSignal = resetListenerScope(container);

    const userCount = Object.keys(users).length;
    console.log('[BugManager] initSingleSelect: 初始化单选组件，用户数量:', userCount);

    if (userCount === 0) {
      console.warn('[BugManager] initSingleSelect: 用户列表为空，跳过初始化');
      return;
    }

    const selectedValue = display.dataset.value || '';

    // 填充选项
    optionsContainer.innerHTML = '';
    Object.entries(users).forEach(([account, name]) => {
      const option = document.createElement('div');
      option.className = 'multi-select-option';
      option.dataset.value = account;
      option.innerHTML = `
        <div class="multi-select-option-text">${name} (${account})</div>
        <div class="multi-select-option-check"></div>
      `;

      option.addEventListener('click', (e) => {
        e.stopPropagation();
        // 清除其他选中状态
        optionsContainer.querySelectorAll('.multi-select-option').forEach(opt => {
          opt.classList.remove('selected');
        });
        option.classList.add('selected');
        display.dataset.value = account;
        display.innerHTML = `<span class="multi-select-tag"><span class="multi-select-tag-name">${name}</span></span>`;
        dropdown.style.display = 'none';
        display.classList.remove('active');
      }, { signal: listenerSignal });

      optionsContainer.appendChild(option);
    });

    // 显示/隐藏下拉列表
    display.addEventListener('click', (e) => {
      dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
      display.classList.toggle('active', dropdown.style.display !== 'none');
    }, { signal: listenerSignal });

    // 点击其他地方关闭下拉
    document.addEventListener('click', (e) => {
      if (!container.contains(e.target)) {
        dropdown.style.display = 'none';
        display.classList.remove('active');
      }
    }, { signal: listenerSignal });

    // 如果有选中的值，恢复显示
    if (selectedValue) {
      display.innerHTML = `<span class="multi-select-tag"><span class="multi-select-tag-name">${users[selectedValue]}</span></span>`;
    }
  },

  /**
   * 根据 ID 初始化多选组件
   */
  initMultiSelectById(fieldId, users) {
    const container = document.getElementById(`${fieldId}Container`);
    if (!container) return;

    const display = container.querySelector(`#${fieldId}Display`);
    const dropdown = container.querySelector(`#${fieldId}Dropdown`);
    const optionsContainer = container.querySelector(`#${fieldId}Options`);

    if (!display || !dropdown || !optionsContainer) return;

    // 每次打开弹窗都会重新初始化：先撤掉上一次绑定的监听，避免同一元素上越绑越多
    const listenerSignal = resetListenerScope(container);

    const selectedUsers = new Set();

    const renderOptions = () => {
      optionsContainer.innerHTML = '';
      Object.entries(users).forEach(([account, name]) => {
        const option = document.createElement('div');
        option.className = 'multi-select-option';
        option.dataset.value = account;  // 保存 account 到 dataset
        if (selectedUsers.has(account)) {
          option.classList.add('selected');
        }

        option.innerHTML = `
          <div class="multi-select-option-text">
            ${name}
            <span class="multi-select-option-account">(${account})</span>
          </div>
          <div class="multi-select-option-check"></div>
        `;

        option.addEventListener('click', (e) => {
          e.stopPropagation();
          if (selectedUsers.has(account)) {
            selectedUsers.delete(account);
            option.classList.remove('selected');
          } else {
            selectedUsers.add(account);
            option.classList.add('selected');
          }
          this.updateMultiSelectDisplayById(fieldId, selectedUsers, users);
        }, { signal: listenerSignal });

        optionsContainer.appendChild(option);
      });
    };

    // 更新显示区域
    this.updateMultiSelectDisplayById = (fieldId, selectedUsers, users) => {
      const display = document.getElementById(`${fieldId}Display`);
      if (!display) return;

      if (selectedUsers.size === 0) {
        display.innerHTML = '<span class="multi-select-placeholder">请选择用户</span>';
      } else {
        display.innerHTML = '';
        selectedUsers.forEach(account => {
          const name = users[account] || account;
          const tag = document.createElement('span');
          tag.className = 'multi-select-tag';
          tag.innerHTML = `
            <span class="multi-select-tag-name">${name}</span>
            <span class="multi-select-tag-remove" data-account="${account}">×</span>
          `;

          tag.querySelector('.multi-select-tag-remove').addEventListener('click', (e) => {
            e.stopPropagation();
            selectedUsers.delete(account);
            this.updateMultiSelectDisplayById(fieldId, selectedUsers, users);

            // 更新下拉列表中的选中状态
            const options = optionsContainer.querySelectorAll('.multi-select-option');
            options.forEach(option => {
              if (option.dataset.value === account) {
                option.classList.remove('selected');
              }
            });
          }, { signal: listenerSignal });

          display.appendChild(tag);
        });
      }
    };

    // 显示/隐藏下拉列表
    display.addEventListener('click', (e) => {
      dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
      display.classList.toggle('active', dropdown.style.display !== 'none');
    }, { signal: listenerSignal });

    // 点击其他地方关闭下拉
    document.addEventListener('click', (e) => {
      if (!container.contains(e.target)) {
        dropdown.style.display = 'none';
        display.classList.remove('active');
      }
    }, { signal: listenerSignal });

    // 初始化渲染选项
    renderOptions();

    // 保存引用
    container._selectedUsers = selectedUsers;
    container._users = users;
  },

  /**
   * 从禅道获取 Bug 详情
   */
  async fetchBugDetailFromZentao(zentaoBugId) {
    // 后端直连：不再打开 bug-view 标签页
    try {
      const resp = await fetch(`${API_BASE_URL}/api/zentao/bug/detail?bugId=${encodeURIComponent(zentaoBugId)}`);
      const result = await resp.json();
      if (result && result.success && result.data) {
        console.log('[BugManager] 从后端获取到 Bug 详情:', result.data);
        return result.data;
      }
      return null;
    } catch (err) {
      console.error('[BugManager] 获取 Bug 详情失败:', err);
      return null;
    }
  },

  /**
   * 更新 Bug 数据
   */
  async updateBugData(bug) {
    try {
      const response = await fetch(`${API_BASE_URL}/api/bug/${bug.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assignedTo: bug.assignedTo,
          cc: bug.cc || []
        })
      });

      const result = await response.json();
      if (result.success) {
        console.log('[BugManager] Bug 数据已更新');
      } else {
        console.warn('[BugManager] 更新 Bug 数据失败:', result.error);
      }
    } catch (err) {
      console.error('[BugManager] 更新 Bug 数据异常:', err);
    }
  },

  /**
   * 确认激活 Bug
   */
  async confirmActivation() {
    const modal = document.getElementById('bugActivateModal');
    if (!modal) return;

    const bugId = modal.dataset.bugId;
    const zentaoBugId = modal.dataset.zentaoBugId;

    if (!bugId || !zentaoBugId) {
      Toast.error('Bug 信息不完整');
      return;
    }

    // 获取表单数据
    const assigneeDisplay = document.getElementById('activateAssigneeDisplay');
    const assignedTo = assigneeDisplay?.dataset.value || '';

    const ccContainer = document.getElementById('activateCcContainer');
    const ccList = ccContainer && ccContainer._selectedUsers ? Array.from(ccContainer._selectedUsers) : [];

    const pri = document.getElementById('activatePri').value;
    const type = document.getElementById('activateType').value;
    const comment = document.getElementById('activateComment').value;

    console.log('[BugManager] 确认激活，参数:', {
      bugId,
      zentaoBugId,
      assignedTo,
      ccList,
      pri,
      type,
      comment
    });

    ProgressToast.show('正在确认 Bug...');

    try {
      const configResp = await fetch(`${API_BASE_URL}/api/zentao/config`);
      const configResult = await configResp.json();
      const baseUrl = configResult.data?.url?.replace(/\/$/, '');

      if (!baseUrl) {
        ProgressToast.hide();
        Toast.error('禅道未配置');
        return;
      }

      // 调用 background.js 激活 Bug（不需要看板 URL）
      const response = await chrome.runtime.sendMessage({
        action: 'activateBugInZentao',
        baseUrl,
        bugId: zentaoBugId,
        assignedTo,
        ccList,
        pri,
        type,
        comment
      });

      ProgressToast.hide();

      if (response && response.success) {
        Toast.success('Bug 已激活');
        // 更新本地 Bug 状态和数据
        await this.updateBugStatus(bugId, 'activated', {
          assignedTo,
          assignedToList: assignedTo ? [assignedTo] : [],
          cc: ccList,
          comment,
          author: '当前用户'  // TODO: 获取真实用户名
        });
        this.hideActivateModal();
        this.hideBugDetail();
      } else {
        console.error('[BugManager] ✗ 激活失败:', response);
        Toast.error('确认失败: ' + (response?.reason || '未知错误'));
      }
    } catch (err) {
      ProgressToast.hide();
      console.error('[BugManager] 激活 Bug 异常:', err);
      Toast.error('确认失败: ' + err.message);
    }
  },

  /**
   * 解决 Bug
   */
  async resolveBug(bugId) {
    const bug = this.bugs.find(b => b.id === bugId);
    if (!bug) return;

    if (!bug.zentaoId) {
      Toast.warning('该 Bug 未同步到禅道');
      return;
    }

    // 移除 executionId 检查，解决 Bug 不需要执行信息

    const modal = document.getElementById('bugResolveModal');
    const resolution = document.getElementById('resolveResolution').value;

    // 从自定义多选组件获取指派人
    const assigneeDisplay = document.getElementById('resolveAssigneeDisplay');
    const assignedTo = assigneeDisplay?.dataset.value || '';

    const comment = document.getElementById('resolveComment').value;

    // 使用 ButtonStateManager 管理按钮状态
    const restoreButton = ButtonStateManager.setLoading('confirmResolveBtn', {
      loadingText: '修复中...'
    });

    ProgressToast.show('正在解决 Bug...');

    try {
      const configResp = await fetch(`${API_BASE_URL}/api/zentao/config`);
      const configResult = await configResp.json();
      const baseUrl = configResult.data?.url?.replace(/\/$/, '');

      if (!baseUrl) {
        ProgressToast.hide();
        Toast.error('禅道未配置');
        return;
      }

      // 构造看板页面 URL
      const kanbanUrl = `${baseUrl}/zentao/execution-kanban-${bug.executionId}-bug.html`;

      // 验证截图 / 附件：先作为「暂扣」存进本地附件区，再随解决动作一起提交
      const attachmentItems = this.resolveAttachmentPicker ? this.resolveAttachmentPicker.getItems() : [];
      let heldIds = [];
      if (attachmentItems.length) {
        const { uploaded, failed } = await AttachmentApi.uploadAll(bugId, attachmentItems, { hold: true });
        if (failed.length) {
          // 有附件没存进去：回收已存的，让用户处理后再提交，避免解决了却少了证据
          await Promise.all(uploaded.map(a => AttachmentApi.remove(bugId, `local:${a.id}`).catch(() => { })));
          ProgressToast.hide();
          Toast.error(`附件添加失败，未提交解决：${failed.map(f => f.message).join('；')}`, 6000);
          return;
        }
        heldIds = uploaded.map(a => a.id);
      }

      // 调用 background.js 修复 Bug（后端直连）
      const response = await chrome.runtime.sendMessage({
        action: 'resolveBugInZentao',
        baseUrl,
        kanbanUrl,
        bugId: bug.zentaoId,
        resolution,
        assignedTo,
        comment,
        localId: bugId,
        attachmentIds: heldIds
      });

      ProgressToast.hide();

      if (!(response && response.success) && heldIds.length) {
        // 解决没成功：回收这次暂扣的附件，重新提交时会重新上传
        await Promise.all(heldIds.map(id => AttachmentApi.remove(bugId, `local:${id}`).catch(() => { })));
      }

      if (response && response.success) {
        Toast.success('Bug 已修复');
        // 更新本地 Bug 状态和数据（修复后状态为 resolved）
        await this.updateBugStatus(bugId, 'resolved', {
          assignedTo,
          cc: [],  // 修复时没有抄送人字段
          comment,
          author: '当前用户'  // TODO: 获取真实用户名
        });
        this.hideResolveModal();
        this.hideBugDetail(); // 同时关闭详情弹窗
      } else {
        Toast.error('解决失败: ' + (response?.reason || response?.message || '未知错误'));
      }
    } catch (err) {
      ProgressToast.hide();
      console.error('[BugManager] 修复 Bug 失败:', err);
      Toast.error('解决失败: ' + err.message);
    } finally {
      restoreButton();
    }
  },

  /**
   * 显示关闭弹窗
   */
  async showCloseModal(bugId) {
    const bug = this.bugs.find(b => b.id === bugId);
    if (!bug) return;

    // 先隐藏详情弹窗
    this.hideBugDetail();

    const modal = document.getElementById('bugCloseModal');
    if (!modal) return;

    // 保存当前操作的 Bug ID
    modal.dataset.bugId = bugId;

    // 清空表单
    document.getElementById('closeComment').value = '';

    modal.style.display = 'flex';
  },

  /**
   * 隐藏关闭弹窗
   */
  hideCloseModal() {
    const modal = document.getElementById('bugCloseModal');
    if (modal) {
      modal.style.display = 'none';
      // 清空表单
      document.getElementById('closeComment').value = '';
    }
  },

  /**
   * 关闭 Bug
   */
  async closeBug(bugId) {
    const bug = this.bugs.find(b => b.id === bugId);
    if (!bug) return;

    if (!bug.zentaoId) {
      Toast.warning('该 Bug 未同步到禅道');
      return;
    }

    const modal = document.getElementById('bugCloseModal');
    const comment = document.getElementById('closeComment').value.trim();

    // 使用 ButtonStateManager 管理按钮状态
    const restoreButton = ButtonStateManager.setLoading('confirmCloseBtn', {
      loadingText: '关闭中...'
    });

    ProgressToast.show('正在关闭 Bug...');

    try {
      const configResp = await fetch(`${API_BASE_URL}/api/zentao/config`);
      const configResult = await configResp.json();
      const baseUrl = configResult.data?.url?.replace(/\/$/, '');

      if (!baseUrl) {
        ProgressToast.hide();
        Toast.error('禅道未配置');
        return;
      }

      // 调用 background.js 关闭 Bug
      console.log('[BugManager] 开始关闭禅道 Bug:', bug.zentaoId);

      const response = await chrome.runtime.sendMessage({
        action: 'closeBugInZentao',
        baseUrl,
        bugId: bug.zentaoId,
        comment
      });

      console.log('[BugManager] 禅道关闭响应:', response);

      ProgressToast.hide();

      if (response && response.success) {
        console.log('[BugManager] 禅道关闭成功，开始更新本地状态...');
        // 更新后端 Bug 状态为 closed
        try {
          const updateResp = await fetch(`${API_BASE_URL}/api/bug/${bugId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'closed' })
          });
          const updateResult = await updateResp.json();

          console.log('[BugManager] 本地状态更新响应:', updateResult);

          if (updateResult.success) {
            Toast.success('Bug 已关闭');
            // 从列表中移除已关闭的 Bug
            await this.removeBug(bugId);
            this.hideCloseModal();
            this.hideBugDetail(); // 同时关闭详情弹窗
          } else {
            console.error('[BugManager] 本地状态更新失败:', updateResult.error);
            Toast.warning('禅道已关闭，但本地状态更新失败');
          }
        } catch (updateErr) {
          console.error('[BugManager] 更新本地状态异常:', updateErr);
          Toast.warning('禅道已关闭，但本地状态更新失败');
        }
      } else {
        console.error('[BugManager] 禅道关闭失败:', response);
        Toast.error('关闭失败: ' + (response?.reason || '未知错误'));
      }
    } catch (err) {
      ProgressToast.hide();
      console.error('[BugManager] 关闭 Bug 失败:', err);
      Toast.error('关闭失败: ' + err.message);
    } finally {
      restoreButton();
    }
  },

  /**
   * 从列表中移除 Bug
   */
  async removeBug(bugId) {
    const index = this.bugs.findIndex(b => b.id === bugId);
    if (index !== -1) {
      this.bugs.splice(index, 1);
      await this.renderBugs();
    }
  },

  /**
   * 删除 Bug
   */
  async deleteBug(bugId) {
    const bug = this.bugs.find(b => b.id === bugId);
    if (!bug) return;

    const confirmDelete = await Confirm.show(
      '删除 Bug',
      `确定删除「${bug.title}」吗？${bug.zentaoId ? `会同时删除禅道中的 Bug #${bug.zentaoId}，` : ''}此操作不可恢复。`,
      '删除', '取消', { danger: true }
    );
    if (!confirmDelete) return;

    Toast.info('正在删除 Bug...');

    try {
      // 如果有禅道 ID，先删除禅道中的 Bug
      if (bug.zentaoId) {
        const configResp = await fetch(`${API_BASE_URL}/api/zentao/config`);
        const configResult = await configResp.json();
        const baseUrl = configResult.data?.url?.replace(/\/$/, '');

        if (baseUrl) {
          console.log('[BugManager] 准备删除Bug，Bug数据:', {
            id: bug.id,
            title: bug.title,
            zentaoId: bug.zentaoId,
            executionId: bug.executionId,
            projectId: bug.projectId
          });

          const response = await chrome.runtime.sendMessage({
            action: 'deleteBugInZentao',
            baseUrl,
            bugId: bug.zentaoId,
            executionId: bug.executionId,
            projectId: bug.projectId
          });

          console.log('[BugManager] 禅道删除响应:', response);

          if (!response || !response.success) {
            const reason = response?.reason || '未知错误';
            console.warn('[BugManager] 禅道 Bug 删除失败:', reason);
            Toast.warning(`禅道 Bug 删除失败: ${reason}，但将删除本地记录`);
          } else {
            console.log('[BugManager] ✓ 禅道 Bug 删除成功');
          }
        }
      }

      // 删除本地 Bug
      console.log('[BugManager] 开始删除本地 Bug...');
      const deleteResp = await fetch(`${API_BASE_URL}/api/bug/${bugId}`, {
        method: 'DELETE'
      });
      const deleteResult = await deleteResp.json();

      console.log('[BugManager] 本地删除响应:', deleteResult);

      if (deleteResult.success) {
        Toast.success('Bug 已删除');
        this.hideBugDetail();
        await this.loadBugs();
      } else {
        console.error('[BugManager] 本地删除失败:', deleteResult);
        Toast.error('删除失败: ' + (deleteResult.error || '未知错误'));
      }
    } catch (err) {
      console.error('[BugManager] 删除 Bug 失败:', err);
      Toast.error('删除失败: ' + err.message);
    }
  },

  /**
   * 更新 Bug 状态
   * @param {string} bugId - Bug ID
   * @param {string} newStatus - 新状态
   * @param {Object} extraData - 额外数据 { assignedTo, assignedToList, cc, comment }
   */
  async updateBugStatus(bugId, newStatus, extraData = {}) {
    console.log('[BugManager] updateBugStatus:', bugId, '->', newStatus, extraData);

    // 先在内存中更新 Bug 状态和数据
    const bug = this.bugs.find(b => b.id === bugId);
    if (bug) {
      console.log('[BugManager] 更新前状态:', bug.status);
      bug.status = newStatus;

      // 更新额外数据
      if (extraData.assignedTo !== undefined) {
        bug.assignedTo = extraData.assignedTo;
        bug.assignedToList = extraData.assignedToList || [];
      }
      if (extraData.cc !== undefined) {
        bug.cc = extraData.cc;
      }
      if (extraData.comment !== undefined) {
        bug.comment = extraData.comment;
      }

      console.log('[BugManager] 更新后状态:', bug.status);

      // 重新渲染 Bug 列表
      await this.renderBugs();
      console.log('[BugManager] Bug 列表已重新渲染');
    } else {
      console.error('[BugManager] 未找到 Bug:', bugId);
      return;
    }

    // 同步状态到后端数据库
    try {
      console.log('[BugManager] 同步 Bug 状态到后端...');
      const response = await fetch(`${API_BASE_URL}/api/bug/${bugId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: newStatus,
          ...extraData
        })
      });

      const result = await response.json();
      if (result.success) {
        console.log('[BugManager] ✓ Bug 状态已同步到后端');
      } else {
        console.error('[BugManager] ✗ 同步 Bug 状态到后端失败:', result.error);
      }
    } catch (err) {
      console.error('[BugManager] ✗ 同步 Bug 状态到后端异常:', err.message);
    }
  }
};

// ==================== 全局工具函数 ====================

/**
 * 删除所有 Bug 卡片（全局函数）
 * 在控制台调用: deleteAllBugs()
 */
window.deleteAllBugs = function() {
  if (typeof BugManager !== 'undefined') {
    BugManager.deleteAllBugs();
  } else {
    console.error('BugManager 未初始化');
  }
};

// ==================== 测试函数 ====================

/**
 * 测试看板视图 API
 * 在控制台调用: testKanbanView(149) 或 testKanbanView(148)
 */
window.testKanbanView = async function(kanbanId) {
  console.log('==================== 测试看板视图 API ====================');
  console.log('[Test] 请求看板 ID:', kanbanId);

  try {
    // 直接从后端获取禅道配置
    const configResp = await fetch(`${API_BASE_URL}/api/zentao/config`);
    const configResult = await configResp.json();

    if (!configResult.success || !configResult.data || !configResult.data.url) {
      console.error('[Test] 禅道未配置');
      return;
    }

    const config = configResult.data;
    const baseUrl = config.url.replace(/\/$/, '');
    const viewUrl = `${baseUrl}/zentao/kanban-view-${kanbanId}.json`;

    console.log('[Test] 禅道 URL:', baseUrl);
    console.log('[Test] 请求 URL:', viewUrl);

    const response = await fetch(viewUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest'
      }
    });

    console.log('[Test] 响应状态:', response.status, response.statusText);

    if (!response.ok) {
      console.error('[Test] HTTP 请求失败:', response.status);
      return;
    }

    const text = await response.text();
    console.log('[Test] 响应原始长度:', text.length, '字符');
    console.log('[Test] 响应前500字符:', text.substring(0, 500));

    // 尝试解析 JSON
    try {
      const data = JSON.parse(text);
      console.log('[Test] ✓ JSON 解析成功');
      console.log('[Test] 顶层键:', Object.keys(data));
      console.log('[Test] data.type:', data.type);
      console.log('[Test] data.status:', data.status);

      // 打印 data.data 的结构和类型
      if (data.data) {
        console.log('[Test] data.data 类型:', typeof data.data);
        console.log('[Test] data.data 键:', Object.keys(data.data));

        // 如果 data.data 是字符串，尝试解析
        if (typeof data.data === 'string') {
          try {
            const parsedData = JSON.parse(data.data);
            console.log('[Test] data.data 解析后的键:', Object.keys(parsedData));
            console.log('[Test] data.data 解析后的完整数据:', parsedData);
          } catch (e) {
            console.log('[Test] data.data 解析失败:', e.message);
          }
        } else {
          console.log('[Test] data.data 完整数据:', data.data);
        }
      }

      // 查找任务数据
      function findTasks(obj, path = 'data') {
        if (!obj || typeof obj !== 'object') return;

        // 检查是否包含 items 或 tasks 数组
        for (let key in obj) {
          const value = obj[key];
          const currentPath = `${path}.${key}`;

          if (key === 'items' && Array.isArray(value)) {
            console.log(`[Test] 找到 items 数组在 ${currentPath}, 长度:`, value.length);
            value.forEach((item, idx) => {
              console.log(`[Test]   [${idx}] id: ${item.id}, name: ${item.name}, status: ${item.status || '(无状态)'}`);
            });
          } else if (key === 'tasks' && Array.isArray(value)) {
            console.log(`[Test] 找到 tasks 数组在 ${currentPath}, 长度:`, value.length);
          } else if (typeof value === 'object' && value !== null) {
            findTasks(value, currentPath);
          }
        }
      }

      findTasks(data);
      return data;
    } catch (e) {
      console.error('[Test] ✗ JSON 解析失败:', e.message);
      console.log('[Test] 原始响应:', text);
    }
  } catch (err) {
    console.error('[Test] ✗ 请求失败:', err.message);
  }

  console.log('==================== 测试结束 ====================');
};

// 测试获取看板参数（走后端，不打开标签页）
// 用法: testGetKanbanParamsSimple(148)
window.testGetKanbanParamsSimple = async function(executionId = 148, laneType = 'task', columnType = 'wait') {
  console.log('==================== 测试获取看板参数（后端）====================');
  try {
    const resp = await fetch(`${API_BASE_URL}/api/zentao/kanban/params?executionId=${encodeURIComponent(executionId)}&laneType=${encodeURIComponent(laneType)}&columnType=${encodeURIComponent(columnType)}`);
    const data = await resp.json();
    console.log('[Test] 后端返回:', data);
  } catch (err) {
    console.error('[Test] ✗ 异常:', err.message);
  }
  console.log('==================== 测试结束 ====================');
};

// 测试获取看板参数（regionId, laneId, columnId）
// 用法: testGetKanbanParams(148) 或 testGetKanbanParams(148, 'task', 'wait')
window.testGetKanbanParams = async function(executionId, laneType = 'task', columnType = 'wait') {
  console.log('==================== 测试获取看板参数 ====================');
  console.log('[Test] 执行 ID:', executionId, '泳道类型:', laneType, '列类型:', columnType);

  try {
    // 直接从后端获取禅道配置
    const configResp = await fetch(`${API_BASE_URL}/api/zentao/config`);
    const configResult = await configResp.json();

    if (!configResult.success || !configResult.data || !configResult.data.url) {
      console.error('[Test] 禅道未配置');
      return;
    }

    const config = configResult.data;
    const baseUrl = config.url.replace(/\/$/, '');
    const kanbanUrl = `${baseUrl}/zentao/execution-kanban-${executionId}.html`;

    console.log('[Test] 禅道 URL:', baseUrl);
    console.log('[Test] 看板 URL:', kanbanUrl);
    console.log('[Test] ========== 使用 fetchKanbanPage 获取参数 ==========');

    // 直接使用 fetchKanbanPage action
    const result = await new Promise((resolve) => {
      chrome.runtime.sendMessage({
        action: 'fetchKanbanPage',
        url: kanbanUrl
      }, (response) => {
        console.log('[Test] 收到响应:', response);
        if (chrome.runtime.lastError) {
          console.warn('[Test] Background 通信失败:', chrome.runtime.lastError.message);
          resolve(null);
        } else {
          resolve(response);
        }
      });
    });

    if (result && result.success) {
      console.log('[Test] ✓ 成功获取参数:');
      console.log('  - regionId:', result.regionId);
      console.log('  - laneId:', result.laneId);
      console.log('  - columnId:', result.columnId);
      console.log('');
      console.log('[Test] 创建任务时使用:');
      console.log(`  { regionId: '${result.regionId}', laneId: '${result.laneId}', columnId: '${result.columnId}' }`);
    } else {
      console.log('[Test] ✗ 获取失败');
      console.log('  - 原因:', result?.reason);
      if (result?.debug) {
        console.log('  - 调试信息:', result.debug);
      }
    }
  } catch (err) {
    console.error('[Test] ✗ 异常:', err.message);
  }

  console.log('==================== 测试结束 ====================');
};

// 在页面加载时初始化 Bug 管理器
// 初始化函数（只执行一次）
let initialized = false;
function initManagers() {
  if (initialized) return;
  initialized = true;

  BugManager.init();
  ExecutionFavorites.init();
  TabSwitcher.init();
}

// 如果 DOM 已经加载完成，立即初始化
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  initManagers();
} else {
  // 否则等待 DOMContentLoaded 事件
  document.addEventListener('DOMContentLoaded', () => {
    initManagers();
  });
}
