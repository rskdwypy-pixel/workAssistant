// API配置
let API_BASE_URL = 'http://localhost:3721';

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

// 今日工时追踪
let todayWorkHours = 0; // 今日已工作时长（小时）
const DAILY_WORK_HOURS = 8; // 每日标准工时

// ==================== 禅道同步状态 ====================
const SYNC_INTERVAL = 24 * 60 * 60 * 1000; // 24小时
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
      Toast.info('正在从禅道同步数据...');

      // 通过 background.js 触发同步
      const response = await chrome.runtime.sendMessage({
        action: 'manualSyncFromZentao'
      });

      if (response && response.success) {
        Toast.success(`同步完成！已同步 ${response.data.tasksSynced} 个任务和 ${response.data.bugsSynced} 个Bug`);

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
        const reason = response ? response.reason : '未知错误';
        Toast.error(`同步失败: ${reason}`);
      }
    } catch (err) {
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
 * 在 newtab 页面打开时检查并执行禅道同步
 */
async function checkAndSyncZentaoOnNewTab() {
  console.log('[NewTab] ========== newtab 页面打开，检查禅道同步 ==========');

  try {
    // 异步调用 background.js 检查同步
    const response = await chrome.runtime.sendMessage({
      action: 'checkAndSyncZentao',
      force: false  // 不强制，遵守24小时限制
    });

    if (response && response.success) {
      console.log('[NewTab] ✓ 禅道同步完成');
      // 重新加载任务列表以显示同步的数据
      await loadTasks();
    } else if (response && response.reason === 'too_soon') {
      console.log('[NewTab] 距离上次同步不足24小时，跳过自动同步');
      console.log('[NewTab] 还需等待:', response.hoursUntilNextSync, '小时');
    } else if (response && response.reason === 'zentao_not_enabled') {
      console.log('[NewTab] 禅道未启用，跳过同步');
    }
  } catch (err) {
    console.error('[NewTab] 禅道同步检查失败:', err);
  }
}

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

// ==================== 确认对话框 ====================
const Confirm = {
  dialog: null,

  init() {
    this.dialog = document.getElementById('confirmDialog');
    this.titleEl = document.getElementById('confirmTitle');
    this.messageEl = document.getElementById('confirmMessage');
    this.cancelBtn = document.getElementById('confirmCancel');
    this.okBtn = document.getElementById('confirmOk');

    // 默认关闭事件
    this.cancelBtn.addEventListener('click', () => this.hide(false));
  },

  show(title, message, okText = '确定', cancelText = '取消') {
    if (!this.dialog) this.init();

    this.titleEl.textContent = title;
    this.messageEl.textContent = message;
    this.cancelBtn.textContent = cancelText;
    this.okBtn.textContent = okText;

    this.dialog.classList.add('active');

    return new Promise((resolve) => {
      const handleOk = () => {
        this.hide(false);
        this.okBtn.removeEventListener('click', handleOk);
        resolve(true);
      };

      this.okBtn.addEventListener('click', handleOk);

      // 点击遮罩关闭 = 取消
      this.dialog.addEventListener('click', (e) => {
        if (e.target === this.dialog) {
          this.hide(false);
          resolve(false);
        }
      }, { once: true });
    });
  },

  hide() {
    this.dialog.classList.remove('active');
  }
};

// ==================== 进度更新输入对话框 ====================
const ProgressInputDialog = {
  dialog: null,

  init() {
    this.dialog = document.getElementById('progressInputDialog');
    this.titleEl = document.getElementById('progressInputTitle');
    this.messageEl = document.getElementById('progressInputMessage');
    this.workInput = document.getElementById('progressInputWork');
    this.consumedInput = document.getElementById('progressInputConsumed');
    this.cancelBtn = document.getElementById('progressInputCancel');
    this.okBtn = document.getElementById('progressInputOk');

    // 默认关闭事件
    this.cancelBtn.addEventListener('click', () => this.hide(null));
  },

  show(title, message, placeholderWork = '', placeholderConsumed = '', defaultWork = '', defaultConsumed = 0) {
    if (!this.dialog) this.init();

    this.titleEl.textContent = title;
    this.messageEl.textContent = message;
    this.workInput.value = '';
    this.consumedInput.value = '';
    this.workInput.placeholder = placeholderWork || '请填写本次工作内容...';

    // 动态设置工时输入框的 placeholder，显示今日工时情况
    const workTimePlaceholder = getWorkTimePlaceholder();
    this.consumedInput.placeholder = placeholderConsumed || workTimePlaceholder;

    this.dialog.classList.add('active');

    // 聚焦到工作内容输入框
    setTimeout(() => this.workInput.focus(), 100);

    return new Promise((resolve) => {
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
        const finalWork = work || defaultWork;
        const finalConsumed = consumed ? parseFloat(consumed) : defaultConsumed;

        this.hide();
        this.okBtn.removeEventListener('click', handleOk);
        resolve({ work: finalWork, consumed: finalConsumed });
      };

      this.okBtn.addEventListener('click', handleOk);

      // 支持回车提交（输入法上屏时除外）
      const handleKeyPress = (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          handleOk();
        }
      };
      this.workInput.addEventListener('keydown', handleKeyPress);
      this.consumedInput.addEventListener('keydown', handleKeyPress);

      // 点击遮罩关闭 = 取消
      const handleMaskClick = (e) => {
        if (e.target === this.dialog) {
          this.hide();
          this.dialog.removeEventListener('click', handleMaskClick);
          this.workInput.removeEventListener('keydown', handleKeyPress);
          this.consumedInput.removeEventListener('keydown', handleKeyPress);
          resolve(null);
        }
      };
      this.dialog.addEventListener('click', handleMaskClick);

      // 清理函数
      this._cleanup = () => {
        this.okBtn.removeEventListener('click', handleOk);
        this.workInput.removeEventListener('keydown', handleKeyPress);
        this.consumedInput.removeEventListener('keydown', handleKeyPress);
        this.dialog.removeEventListener('click', handleMaskClick);
      };
    });
  },

  hide() {
    this.dialog.classList.remove('active');
    if (this._cleanup) {
      this._cleanup();
      this._cleanup = null;
    }
  }
};

// 快捷函数
function showToast(message, type = 'info', duration = 3000) {
  return Toast.show(message, type, duration);
}

function showConfirm(title, message, okText = '确定', cancelText = '取消') {
  return Confirm.show(title, message, okText, cancelText);
}

// ==================== 今日工时追踪 ====================

/**
 * 获取今日工时存储键
 */
function getTodayWorkTimeKey() {
  const today = new Date();
  return `workTime_${today.getFullYear()}_${today.getMonth() + 1}_${today.getDate()}`;
}

/**
 * 获取今日任务工时记录的存储键
 * 用于记录每个任务今日记录的工时，删除任务时可以减去
 */
function getTodayTaskWorkTimeKey() {
  const today = new Date();
  return `taskWorkTime_${today.getFullYear()}_${today.getMonth() + 1}_${today.getDate()}`;
}

/**
 * 记录任务今日工时
 */
function recordTaskWorkTime(taskId, hours) {
  const key = getTodayTaskWorkTimeKey();
  const record = JSON.parse(localStorage.getItem(key) || '{}');
  record[taskId] = (record[taskId] || 0) + hours;
  localStorage.setItem(key, JSON.stringify(record));
}

/**
 * 获取任务今日工时
 */
function getTaskWorkTime(taskId) {
  const key = getTodayTaskWorkTimeKey();
  const record = JSON.parse(localStorage.getItem(key) || '{}');
  return record[taskId] || 0;
}

/**
 * 移除任务今日工时记录（删除任务时调用）
 */
function removeTaskWorkTime(taskId) {
  const key = getTodayTaskWorkTimeKey();
  const record = JSON.parse(localStorage.getItem(key) || '{}');
  const hours = record[taskId] || 0;
  if (hours > 0) {
    delete record[taskId];
    localStorage.setItem(key, JSON.stringify(record));
    // 从今日总工时中减去
    todayWorkHours = Math.max(0, todayWorkHours - hours);
    const totalKey = getTodayWorkTimeKey();
    localStorage.setItem(totalKey, todayWorkHours.toString());
    updateTodayWorkTimeDisplay();
    // 同步到后端
    fetch(`${API_BASE_URL}/api/workHours`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hours: todayWorkHours })
    }).catch(() => {});
  }
  return hours;
}

/**
 * 初始化今日工时（从本地存储加载）
 */
function initTodayWorkTime() {
  const key = getTodayWorkTimeKey();
  const saved = localStorage.getItem(key);
  if (saved !== null) {
    todayWorkHours = parseFloat(saved);
  } else {
    todayWorkHours = 0;
  }
  updateTodayWorkTimeDisplay();
}

/**
 * 获取工时输入框的 placeholder 文本
 */
function getWorkTimePlaceholder() {
  if (todayWorkHours >= DAILY_WORK_HOURS) {
    const overtimeHours = (todayWorkHours - DAILY_WORK_HOURS).toFixed(1);
    return `今日已加班 ${overtimeHours}h`;
  } else {
    return `今日已工作 ${todayWorkHours.toFixed(1)}h`;
  }
}

/**
 * 更新今日工时（本地+后端）
 */
async function updateTodayWorkTime(hours) {
  todayWorkHours += hours;
  const key = getTodayWorkTimeKey();
  localStorage.setItem(key, todayWorkHours.toString());
  updateTodayWorkTimeDisplay();

  // 同步到后端
  try {
    await fetch(`${API_BASE_URL}/api/workHours`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hours: todayWorkHours })
    });
  } catch (err) {
    console.log('[WorkTime] 后端同步失败:', err.message);
  }
}

/**
 * 初始化时同步工时到后端
 */
async function syncWorkHoursToBackend() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/workHours`);
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.data.hours > 0 && todayWorkHours === 0) {
        // 后端有工时数据但本地没有，使用后端数据
        todayWorkHours = data.data.hours;
        const key = getTodayWorkTimeKey();
        localStorage.setItem(key, todayWorkHours.toString());
        updateTodayWorkTimeDisplay();
      }
    }
  } catch (err) {
    console.log('[WorkTime] 获取后端工时失败:', err.message);
  }
}

/**
 * 更新页面上的今日工时显示
 */
function updateTodayWorkTimeDisplay() {
  const el = document.getElementById('todayWorkTime');
  if (el) {
    if (todayWorkHours >= DAILY_WORK_HOURS) {
      const overtimeHours = (todayWorkHours - DAILY_WORK_HOURS).toFixed(1);
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
  if (todayWorkHours >= DAILY_WORK_HOURS) {
    const overtimeHours = (todayWorkHours - DAILY_WORK_HOURS).toFixed(1);
    return `今日已工作 ${todayWorkHours.toFixed(1)}h（加班 ${overtimeHours}h）`;
  } else {
    return `今日已工作 ${todayWorkHours.toFixed(1)}h`;
  }
}

// 报告状态：存储最后一次生成的报告ID
let lastReports = {
  daily: null,
  weekly: null,
  monthly: null
};

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

      // 提交进度更新
      updateTaskProgress(taskId, clampedPercent).then((result) => {
        console.log('[Progress Drag] updateTaskProgress 返回:', result);

        // 如果用户取消，立即恢复UI到原始值
        if (result === false) {
          console.log('[Progress Drag] 用户取消，恢复UI到原始值:', originalValue);
          if (progressFill) progressFill.style.width = `${originalValue}%`;
          if (progressInput) progressInput.value = originalValue;
        }

        // 无论成功还是取消，都刷新任务列表以同步 UI
        console.log('[Progress Drag] 刷新任务列表');
        loadTasks().catch(err => console.warn('[Progress Drag] 刷新任务失败:', err));

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

  // 初始化今日工时
  initTodayWorkTime();
  syncWorkHoursToBackend(); // 同步后端工时数据

  // 初始化 Toast
  Toast.init();

  // 恢复调试模式状态
  const savedDebugMode = localStorage.getItem('debugMode');
  const debugModeToggle = document.getElementById('debugModeToggle');
  if (savedDebugMode === 'true') {
    debugMode = true;
    const testButtons = document.getElementById('testButtons');
    testButtons.classList.add('visible');
    if (debugModeToggle) debugModeToggle.checked = true;
    console.log('%c[调试模式] 已自动开启', 'color: #f59e0b; font-size: 14px; font-weight: bold;');
  }

  // 调试模式切换（设置页面中的复选框）
  if (debugModeToggle) {
    debugModeToggle.addEventListener('change', () => {
      debugMode = debugModeToggle.checked;
      const testButtons = document.getElementById('testButtons');

      if (debugMode) {
        testButtons.classList.add('visible');
        localStorage.setItem('debugMode', 'true');
        Toast.success('调试模式已开启');
        console.log('%c[调试模式] 测试按钮已显示', 'color: #f59e0b; font-size: 14px; font-weight: bold;');
      } else {
        testButtons.classList.remove('visible');
        localStorage.removeItem('debugMode');
        Toast.info('调试模式已关闭');
      }
    });
  }

  // 加载保存的配置
  const savedConfig = localStorage.getItem('workAssistantConfig');
  if (savedConfig) {
    const config = JSON.parse(savedConfig);
    // 使用后端服务地址（不要与AI API地址混淆）
    if (config.backendUrl) {
      API_BASE_URL = config.backendUrl;
    } else if (config.apiBaseUrl && !config.apiBaseUrl.includes('open.bigmodel.cn')) {
      // 兼容旧配置：只有在不包含AI API地址时才使用
      API_BASE_URL = config.apiBaseUrl;
    }
  }

  // 初始化日历
  const now = new Date();
  currentYear = now.getFullYear();
  currentMonth = now.getMonth() + 1;
  selectedDate = now.toISOString().split('T')[0];

  await loadCalendar();
  await loadTasks();
  await loadHistoryPreview();
  await checkTodayReports();

  // 自动登录禅道（如果已配置）
  ZentaoBrowserClient.autoInit().catch(err => {
    console.log('[ZentaoBrowser] 自动登录跳过:', err.message);
  });

  // 初始化同步功能
  if (typeof syncManager !== 'undefined' && typeof SyncUI !== 'undefined') {
    await syncManager.init();
    const syncUI = new SyncUI(syncManager);
    syncUI.init();
    window.syncUI = syncUI; // 保存到全局以便后续使用
  }

  // 初始化禅道同步状态显示
  ZentaoSync.init().catch(err => {
    console.error('[ZentaoSync] 初始化失败:', err);
  });

  // 检查并执行禅道同步（在 newtab 页面打开时）
  checkAndSyncZentaoOnNewTab().catch(err => {
    console.error('[NewTab] 禅道同步检查失败:', err);
  });

  // 绑定事件
  bindEvents();
});

// 绑定事件
function bindEvents() {
  bindReportEvents();
  bindDragAndDrop();

  // 进度条拖拽全局事件
  setupProgressDragEvents();
  // 添加任务
  document.getElementById('addTaskBtn').addEventListener('click', addTask);
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

  // 搜索
  document.getElementById('searchInput').addEventListener('input', debounce(handleSearch, 300));

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
  document.getElementById('settingsBtn').addEventListener('click', () => {
    loadSettings();
    document.getElementById('settingsModal').classList.add('active');
    checkServiceStatus();
  });

  // Bug 标签页的设置按钮
  const bugSettingsBtn = document.getElementById('bugSettingsBtn');
  if (bugSettingsBtn) {
    bugSettingsBtn.addEventListener('click', () => {
      loadSettings();
      document.getElementById('settingsModal').classList.add('active');
      checkServiceStatus();
    });
  }

  document.getElementById('closeSettings').addEventListener('click', () => {
    document.getElementById('settingsModal').classList.remove('active');
  });

  // ========== 提示词设置相关 ==========
  let defaultSummaryPrompt = '';
  let defaultAddTaskPrompt = '';
  document.getElementById('promptSettingsBtn').addEventListener('click', async () => {
    const modal = document.getElementById('promptModal');
    modal.classList.add('active');

    // 获取当前配置的提示词
    try {
      const response = await fetch(`${API_BASE_URL}/api/prompts`);
      const result = await response.json();
      if (result.success) {
        defaultSummaryPrompt = result.data.default?.summary || '';
        defaultAddTaskPrompt = result.data.default?.addTask || '';
        document.getElementById('promptAddTask').value = result.data.custom.addTask || defaultAddTaskPrompt;
        document.getElementById('promptDaily').value = result.data.custom.daily || defaultSummaryPrompt;
        document.getElementById('promptWeekly').value = result.data.custom.weekly || defaultSummaryPrompt;
        document.getElementById('promptMonthly').value = result.data.custom.monthly || defaultSummaryPrompt;
      }
    } catch (err) {
      console.warn('获取提示词失败:', err);
      Toast.error('获取提示词失败');
    }
  });

  document.getElementById('closePromptModal').addEventListener('click', () => {
    document.getElementById('promptModal').classList.remove('active');
  });

  document.getElementById('promptModal').addEventListener('click', (e) => {
    if (e.target.id === 'promptModal') {
      document.getElementById('promptModal').classList.remove('active');
    }
  });

  document.getElementById('resetAddTaskPromptBtn').addEventListener('click', () => {
    document.getElementById('promptAddTask').value = defaultAddTaskPrompt;
  });
  document.getElementById('resetDailyPromptBtn').addEventListener('click', () => {
    document.getElementById('promptDaily').value = defaultSummaryPrompt;
  });
  document.getElementById('resetWeeklyPromptBtn').addEventListener('click', () => {
    document.getElementById('promptWeekly').value = defaultSummaryPrompt;
  });
  document.getElementById('resetMonthlyPromptBtn').addEventListener('click', () => {
    document.getElementById('promptMonthly').value = defaultSummaryPrompt;
  });

  document.getElementById('savePromptBtn').addEventListener('click', async () => {
    const btn = document.getElementById('savePromptBtn');
    const originalText = btn.textContent;
    btn.textContent = '保存中...';
    btn.disabled = true;

    try {
      let addTaskVal = document.getElementById('promptAddTask').value.trim();
      let dailyVal = document.getElementById('promptDaily').value.trim();
      let weeklyVal = document.getElementById('promptWeekly').value.trim();
      let monthlyVal = document.getElementById('promptMonthly').value.trim();

      // 如果和默认一样，则传递空字符串让其使用默认
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
      if (result.success) {
        Toast.success('提示词已保存');
        document.getElementById('promptModal').classList.remove('active');
      } else {
        Toast.error(`保存失败: ${result.error}`);
      }
    } catch (err) {
      console.warn('保存提示词失败:', err);
      Toast.error('保存提示词失败');
    } finally {
      btn.textContent = originalText;
      btn.disabled = false;
    }
  });
  // ====================================

  // AI服务选择切换
  document.getElementById('aiProvider').addEventListener('change', (e) => {
    const provider = e.target.value;
    const presets = {
      zhipu: {
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4/',
        model: 'glm-4-flash'
      },
      openai: {
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini'
      },
      custom: {
        baseUrl: '',
        model: ''
      }
    };

    if (presets[provider]) {
      document.getElementById('apiBaseUrl').value = presets[provider].baseUrl;
      document.getElementById('aiModel').value = presets[provider].model;
    }
  });

  // 测试AI连接
  document.getElementById('testAi').addEventListener('click', async () => {
    const resultEl = document.getElementById('aiTestResult');
    resultEl.textContent = '测试中...';
    resultEl.className = 'test-result';

    try {
      const apiKey = document.getElementById('apiKey').value.trim();
      const baseUrl = document.getElementById('apiBaseUrl').value.trim();
      const model = document.getElementById('aiModel').value.trim();

      if (!apiKey) {
        resultEl.textContent = '请先输入 API Key';
        resultEl.className = 'test-result error';
        return;
      }

      // 测试调用
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: model,
          messages: [{ role: 'user', content: '你好' }],
          max_tokens: 10
        })
      });

      if (response.ok) {
        resultEl.textContent = '✅ 连接成功';
        resultEl.className = 'test-result success';
      } else {
        const error = await response.json();
        resultEl.textContent = `❌ ${error.error?.message || '连接失败'}`;
        resultEl.className = 'test-result error';
      }
    } catch (err) {
      resultEl.textContent = `❌ 连接失败: ${err.message}`;
      resultEl.className = 'test-result error';
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

    if (!url || !username || !password) {
      resultEl.textContent = '❌ 请先填写禅道地址、账号和密码';
      resultEl.className = 'test-result error';
      return;
    }

    resultEl.textContent = '⏳ 测试连接中...';
    resultEl.className = 'test-result';

    try {
      // 通过配置对象临时覆盖浏览器客户端配置进行测试
      const tempConfig = {
        enabled: true,
        url,
        username,
        password,
        _isManualTest: true
      };
      ZentaoBrowserClient.config = tempConfig;

      const loginSuccess = await ZentaoBrowserClient.login();

      if (loginSuccess) {
        resultEl.textContent = '✅ 连接并登录成功！浏览器已获取认证信息。';
        resultEl.className = 'test-result success';
      } else {
        resultEl.textContent = '❌ 连接失败，请检查账号密码或跨域设置';
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
      const users = await ZentaoBrowserClient.loadUsersFromTeamPage();
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

  // 保存配置
  document.getElementById('saveSettings').addEventListener('click', async () => {
    const config = {
      apiKey: document.getElementById('apiKey').value.trim(),
      apiBaseUrl: document.getElementById('apiBaseUrl').value.trim(),
      aiModel: document.getElementById('aiModel').value.trim(),
      morningHour: document.getElementById('morningHour').value,
      eveningHour: document.getElementById('eveningHour').value,
      webhookUrl: document.getElementById('webhookUrl').value.trim(),
      webhookType: document.getElementById('webhookType').value,
      aiProvider: document.getElementById('aiProvider').value,
      // 禅道配置
      zentaoEnabled: document.getElementById('zentaoEnabled')?.checked || false,
      zentaoUrl: document.getElementById('zentaoUrl')?.value.trim() || '',
      zentaoUsername: document.getElementById('zentaoUsername')?.value.trim() || '',
      zentaoPassword: document.getElementById('zentaoPassword')?.value.trim() || '',
      zentaoCreateTaskUrl: document.getElementById('zentaoCreateTaskUrl')?.value.trim() || '',
      // 后端服务URL（与AI API URL分开）
      backendUrl: 'http://localhost:3721'
    };

    // 保存到localStorage
    localStorage.setItem('workAssistantConfig', JSON.stringify(config));

    // 同步所有配置到后端（会持久化到 .env 文件）
    try {
      const response = await fetch(`${API_BASE_URL}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: config.apiKey || '',
          apiBaseUrl: config.apiBaseUrl || '',
          aiModel: config.aiModel || '',
          morningHour: config.morningHour || '9',
          eveningHour: config.eveningHour || '21',
          webhookUrl: config.webhookUrl || '',
          webhookType: config.webhookType || 'generic'
        })
      });

      const result = await response.json();
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
          password: config.zentaoPassword,
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

    // 更新后端服务地址
    API_BASE_URL = config.backendUrl || 'http://localhost:3721';

    // 保存同步配置
    if (window.syncUI) {
      window.syncUI.saveSyncSettingsFromSettings();
    }

    document.getElementById('settingsModal').classList.remove('active');
    loadTasks();
    loadCalendar();
  });

  // 重置配置
  document.getElementById('resetSettings').addEventListener('click', async () => {
    const confirmed = await showConfirm('重置配置', '确定要重置为默认配置吗？此操作无法撤销。');
    if (confirmed) {
      localStorage.removeItem('workAssistantConfig');
      loadSettings();
      Toast.success('配置已重置');
    }
  });

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

  // 历史日报按钮
  document.getElementById('viewAllHistory').addEventListener('click', async () => {
    await showHistoryModal();
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

  document.getElementById('closeReportModal').addEventListener('click', () => {
    document.getElementById('reportModal').classList.remove('active');
  });

  document.getElementById('reportModal').addEventListener('click', (e) => {
    if (e.target.id === 'reportModal') {
      document.getElementById('reportModal').classList.remove('active');
    }
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
    // 首先同步 webhook 配置到后端（确保后端有最新的 webhook 配置）
    const savedConfig = localStorage.getItem('workAssistantConfig');
    if (savedConfig) {
      const config = JSON.parse(savedConfig);
      console.log(`[前端] 读取配置:`, { webhookUrl: config.webhookUrl ? '***' : '未配置', webhookType: config.webhookType });
      if (config.webhookUrl) {
        console.log(`[前端] 同步webhook配置到后端...`);
        await fetch(`${API_BASE_URL}/api/webhook/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: config.webhookUrl,
            type: config.webhookType || 'generic'
          })
        });
        // 验证 webhook 配置是否正确设置
        const checkRes = await fetch(`${API_BASE_URL}/api/webhook/config`);
        const checkResult = await checkRes.json();
        console.log(`[前端] Webhook配置验证:`, checkResult.data);
      }
    }

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

// 报告相关逻辑
let currentReportAction = null;

// 检查今天是否生成过报告
async function checkTodayReports() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/history?limit=100`);
    const result = await response.json();

    if (result.success) {
      const today = new Date().toISOString().split('T')[0];
      const currentWeek = getWeekRange();
      const currentMonth = getMonthRange();

      // 查找最后一次的各类报告
      const dailyReport = result.data.find(r => r.type === 'daily' && r.date === today);
      const weeklyReport = result.data.find(r => r.type === 'weekly' && r.dateLabel === currentWeek.label);
      const monthlyReport = result.data.find(r => r.type === 'monthly' && r.dateLabel === currentMonth.label);

      // 更新按钮状态
      updateReportButton('daily', dailyReport, '日报');
      updateReportButton('weekly', weeklyReport, '周报');
      updateReportButton('monthly', monthlyReport, '月报');
    }
  } catch (err) {
    console.warn('检查报告状态失败:', err);
  }
}

// 获取本周范围
function getWeekRange() {
  const now = new Date();
  const day = now.getDay() || 7;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1);
  const label = `${start.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })} - ${now.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}周报`;
  return { label, start: start.toISOString().split('T')[0] };
}

// 获取本月范围
function getMonthRange() {
  const now = new Date();
  const label = `${now.getFullYear()}年${now.getMonth() + 1}月总结`;
  return { label, start: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01` };
}

// 更新报告按钮状态
function updateReportButton(type, report, typeName) {
  const btn = document.getElementById(`gen${type.charAt(0).toUpperCase() + type.slice(1)}Btn`);

  if (report) {
    lastReports[type] = report;
    btn.textContent = `打开${typeName}`;
    btn.dataset.mode = 'open';
    btn.dataset.reportId = report.id;
  } else {
    lastReports[type] = null;
    btn.textContent = `生成${typeName}`;
    btn.dataset.mode = 'generate';
    delete btn.dataset.reportId;
  }
}

function bindReportEvents() {
  const types = { daily: '日报', weekly: '周报', monthly: '月报' };

  Object.keys(types).forEach(type => {
    const btn = document.getElementById(`gen${type.charAt(0).toUpperCase() + type.slice(1)}Btn`);
    if (btn) {
      btn.addEventListener('click', () => handleReportClick(type, btn, types[type]));
    }
  });
}

async function handleReportClick(type, btnElement, typeName) {
  const mode = btnElement.dataset.mode || 'generate';

  if (mode === 'open' && btnElement.dataset.reportId) {
    // 打开现有报告
    await openReportById(btnElement.dataset.reportId, type, btnElement, typeName);
  } else {
    // 生成新报告
    await handleGenerateReport(type, btnElement, typeName);
  }
}

async function handleGenerateReport(type, btnElement, typeName) {
  try {
    const originalText = btnElement.textContent;
    btnElement.textContent = '生成中...';
    btnElement.disabled = true;

    // 同步 webhook 配置到后端（确保推送能正常工作）
    const savedConfig = localStorage.getItem('workAssistantConfig');
    if (savedConfig) {
      const config = JSON.parse(savedConfig);
      if (config.webhookUrl) {
        await fetch(`${API_BASE_URL}/api/webhook/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: config.webhookUrl,
            type: config.webhookType || 'generic'
          })
        });
      }
    }

    // 传递选择的日期参数和今日工时信息
    const dateParam = selectedDate || new Date().toISOString().split('T')[0];
    const workHours = todayWorkHours > 0 ? todayWorkHours : null;
    const params = new URLSearchParams({ date: dateParam });
    if (workHours) params.append('workHours', workHours.toString());

    const response = await fetch(`${API_BASE_URL}/api/report/generate/${type}?${params.toString()}`, { method: 'POST' });
    const result = await response.json();

    if (result.success) {
      // 更新按钮状态为打开
      lastReports[type] = result.data;
      btnElement.textContent = `打开${typeName}`;
      btnElement.dataset.mode = 'open';
      btnElement.dataset.reportId = result.data.id;

      showReportModal(result.data, type, btnElement, typeName);
    } else {
      Toast.error(`生成失败: ${result.error}`);
      btnElement.textContent = originalText;
    }
  } catch (err) {
    Toast.error(`网络错误: ${err.message}`);
    btnElement.textContent = `生成${typeName}`;
  } finally {
    btnElement.disabled = false;
  }
}

// 根据ID打开报告
async function openReportById(reportId, type, btnElement, typeName) {
  try {
    const response = await fetch(`${API_BASE_URL}/api/history?limit=100`);
    const result = await response.json();

    if (result.success) {
      const report = result.data.find(r => r.id === reportId);
      if (report) {
        showReportModal(report, type, btnElement, typeName);
      } else {
        Toast.warning('报告不存在，请重新生成');
        btnElement.textContent = `生成${typeName}`;
        btnElement.dataset.mode = 'generate';
        delete btnElement.dataset.reportId;
      }
    }
  } catch (err) {
    Toast.error('加载报告失败: ' + err.message);
  }
}

// 格式化报告项（高亮状态标签）
function formatReportItem(item) {
  let html = escapeHtml(item);

  // 高亮 [待办] 标签 - 橙色
  html = html.replace(/\[待办\]/g, '<span style="display: inline-block; padding: 2px 6px; border-radius: 3px; background: #fff3cd; color: #856404; font-size: 11px; margin-right: 4px;">[待办]</span>');

  // 高亮 [进行中] 标签 - 蓝色
  html = html.replace(/\[进行中\]/g, '<span style="display: inline-block; padding: 2px 6px; border-radius: 3px; background: #cfe2ff; color: #084298; font-size: 11px; margin-right: 4px;">[进行中]</span>');

  // 高亮时间信息 - 灰色斜体
  html = html.replace(/$$提醒: ([^)]+)$$/g, '<span style="color: #6c757d; font-size: 12px; font-style: italic;">(提醒: $1)</span>');
  html = html.replace(/$$截止: ([^)]+)$$/g, '<span style="color: #dc3545; font-size: 12px; font-weight: 500;">(截止: $1)</span>');

  return html;
}

function showReportModal(report, type, originBtn, typeName) {
  const modal = document.getElementById('reportModal');
  const title = document.getElementById('reportModalTitle');
  const body = document.getElementById('reportModalBody');

  title.textContent = report.dateLabel || report.date || '智能汇报';

  body.innerHTML = `
    <div style="margin-bottom: 16px;">
      <h4 style="margin-bottom: 8px;">总览</h4>
      <p style="color: #666; font-size: 14px;">${escapeHtml(report.summary)}</p>
    </div>
    ${report.completed?.length ? `
    <div style="margin-bottom: 16px;">
      <h4 style="margin-bottom: 8px;">✅ 已完成</h4>
      <ul style="padding-left: 20px; color: #555; font-size: 14px;">
        ${report.completed.map(c => `<li style="margin-bottom: 4px;">${formatReportItem(c)}</li>`).join('')}
      </ul>
    </div>` : ''}
    ${report.tomorrowFocus?.length ? `
    <div style="margin-bottom: 16px;">
      <h4 style="margin-bottom: 8px;">🎯 待办/进行中</h4>
      <ul style="padding-left: 20px; color: #555; font-size: 14px;">
        ${report.tomorrowFocus.map(c => `<li style="margin-bottom: 4px;">${formatReportItem(c)}</li>`).join('')}
      </ul>
    </div>` : ''}
    ${report.risks?.length ? `
    <div style="margin-bottom: 16px;">
      <h4 style="margin-bottom: 8px; color: #e74c3c;">⚠️ 风险建议</h4>
      <ul style="padding-left: 20px; color: #e74c3c; font-size: 14px;">
        ${report.risks.map(c => `<li style="margin-bottom: 4px;">${escapeHtml(c)}</li>`).join('')}
      </ul>
    </div>` : ''}
  `;

  // 绑定 Modal 按钮
  const delBtn = document.getElementById('deleteReportBtn');
  const regenBtn = document.getElementById('regenReportBtn');
  const pushBtn = document.getElementById('pushReportBtn');

  // 确保按钮可见
  delBtn.style.display = 'inline-block';
  regenBtn.style.display = 'inline-block';
  pushBtn.style.display = 'inline-block';

  // 清除旧事件
  const newDelBtn = delBtn.cloneNode(true);
  delBtn.parentNode.replaceChild(newDelBtn, delBtn);
  const newRegenBtn = regenBtn.cloneNode(true);
  regenBtn.parentNode.replaceChild(newRegenBtn, regenBtn);
  const newPushBtn = pushBtn.cloneNode(true);
  pushBtn.parentNode.replaceChild(newPushBtn, pushBtn);

  newDelBtn.onclick = async () => {
    const confirmed = await showConfirm('删除报告', '确定要删除此报告吗？删除后无法恢复。');
    if (confirmed) {
      await fetch(`${API_BASE_URL}/api/report/${report.id}`, { method: 'DELETE' });
      modal.classList.remove('active');
      originBtn.textContent = `生成${typeName}`;
      originBtn.dataset.mode = 'generate';
      delete originBtn.dataset.reportId;
      lastReports[type] = null;
      loadHistoryPreview();
      Toast.success('报告已删除');
    }
  };


  newRegenBtn.onclick = () => {
    // 使用报告的原始日期，而不是当前选中日期
    if (report.date) {
      selectedDate = report.date;
    }
    modal.classList.remove('active');
    handleGenerateReport(type, originBtn, typeName);
  };
  newPushBtn.onclick = async () => {
    newPushBtn.textContent = '推送中...';
    newPushBtn.disabled = true;
    try {
      const res = await fetch(`${API_BASE_URL}/api/report/${report.id}/push`, { method: 'POST' });
      const resJson = await res.json();
      if (!resJson.success) {
        Toast.error('推送失败:' + resJson.error);
      } else {
        Toast.success('推送成功');
      }
    } catch (err) {
      Toast.error('网络错误:' + err.message);
    } finally {
      newPushBtn.textContent = '推送通知';
      newPushBtn.disabled = false;
    }
  };

  modal.classList.add('active');
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
async function loadTasks() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/tasks?date=${selectedDate}`);
    const result = await response.json();

    if (result.success) {
      allTasks = result.data;
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
      allTasks = result.data;
      renderTasks();
    }
  } catch (err) {
    Toast.error('加载任务失败');
    console.warn('加载任务失败:', err);
  }
}

function renderTasks() {
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

  card.innerHTML = `
    <div class="task-title" style="display: flex; align-items: flex-start; gap: 8px; width:100%;">
      <input type="checkbox" class="task-checkbox" data-task-id="${task.id}" ${task.status === 'done' ? 'checked' : ''} style="margin-top: 4px; cursor: pointer;">
      <div style="flex:1;">
        <div style="display: flex; align-items: center; flex-wrap: wrap; gap: 4px;">
          <span class="task-title-text" data-task-id="${task.id}" title="点击编辑标题"
            style="cursor: pointer; padding: 2px 4px; border-radius: 4px; transition: background 0.2s;">
            ${escapeHtml(task.title)}
          </span>
          ${task.zentaoId ? `<span class="zentao-task-link" data-task-id="${task.zentaoId}" style="color: #3b82f6; text-decoration: none; font-size: 12px; cursor: pointer;">#${task.zentaoId}</span>` : ''}
        </div>
        ${task.executionName ? `<span class="execution-tag" style="margin-top: 4px;">${escapeHtml(task.executionName)}</span>` : ''}
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
    // 创建菜单（挂载到 body，避免被 overflow 裁剪）
    let priorityMenu = document.querySelector(`.priority-menu-${task.id}`);
    if (!priorityMenu) {
      priorityMenu = document.createElement('div');
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
    }

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

    // 点击选项更新优先级
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

  // 任务 ID 链接点击事件 - 复用禅道标签页
  const taskLink = card.querySelector('.zentao-task-link');
  if (taskLink && task.zentaoId) {
    taskLink.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      try {
        // 获取禅道配置
        const configResp = await fetch(`${API_BASE_URL}/api/zentao/config`);
        const configResult = await configResp.json();

        if (!configResult.success || !configResult.data || !configResult.data.url) {
          Toast.error('禅道未配置');
          return;
        }

        const baseUrl = configResult.data.url.replace(/\/$/, '');
        const taskUrl = `${baseUrl}/zentao/task-view-${task.zentaoId}.html`;

        // 使用 ZentaoTabManager 复用已存在的禅道标签页
        const tab = await ZentaoTabManager.getOrCreateTab({
          baseUrl,
          targetUrl: taskUrl,
          active: true  // 激活标签页
        });

        console.log('[TaskCard] 已在标签页', tab.id, '中打开任务详情');
      } catch (err) {
        console.error('[TaskCard] 打开任务详情失败:', err);
        Toast.error('打开任务详情失败: ' + err.message);
      }
    });
  }

  return card;
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

// 添加任务
async function addTask() {
  const input = document.getElementById('taskInput');
  const btn = document.getElementById('addTaskBtn');
  const content = input.value.trim();

  if (!content) {
    Toast.warning('请输入任务内容');
    return;
  }

  const originalVal = content;

  // 使用 ButtonStateManager 管理按钮状态
  const restoreButton = ButtonStateManager.setLoading('addTaskBtn', {
    loadingText: '添加中...',
    disableInput: true,
    inputId: 'taskInput'
  });

  // 立即清空输入框，防止用户觉得自己没触发，并显示提示
  input.value = '';
  const originalPlaceholder = input.placeholder;
  input.placeholder = '✨ AI 正在努力分析并提取任务属性，请稍候...';

  // 浏览器端禅道任务 ID（如果成功创建）
  let browserZentaoId = null;

  try {
    // 获取选择的执行ID
    const selectedExecutionId = ExecutionSelector.getSelectedExecution();
    console.log('[AddTask] ========== 开始添加任务 ==========');
    console.log('[AddTask] 任务内容:', content);
    console.log('[AddTask] 用户选择的执行ID:', selectedExecutionId, selectedExecutionId ? '(手动选择)' : '(AI自动选择)');

    // 如果是 AI 自动选择，显示可用的收藏执行列表
    if (!selectedExecutionId) {
      console.log('[AddTask] --- AI 推断项目过程 ---');
      console.log('[AddTask] 可用的收藏执行列表:');
      ExecutionSelector.favoriteExecutions.forEach((exec, index) => {
        console.log(`[AddTask]   ${index + 1}. ID: ${exec.id} | ${exec.name} | 项目: ${exec.projectName || '未设置'}`);
      });
      console.log('[AddTask] --------------------------');
    }

    // 第一步：调用服务端 API 获取 AI 提取的任务数据
    const response = await fetch(`${API_BASE_URL}/api/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        executionId: selectedExecutionId
      })
    });

    const result = await response.json();

    if (result.success) {
      // AI 提取的任务标题
      const aiTitle = result.data?.title || result.data?.content || content;
      console.log('[AddTask] ✓ AI 提取的标题:', aiTitle);

      // 打印 AI 推断结果
      const aiExecutionId = result.data?.executionId;
      const aiExecutionName = result.data?.executionName;

      // 获取执行类型（判断是否为看板）
      let executionType = null;
      if (aiExecutionId) {
        executionType = ExecutionFavorites.getExecutionType(aiExecutionId);
        console.log('[AddTask] 执行类型:', aiExecutionId, '=>', executionType);
      }

      if (!selectedExecutionId) {
        // AI 自动选择模式
        if (aiExecutionId) {
          console.log('[AddTask] ✓✓✓ AI 推断成功 ✓✓✓');
          console.log('[AddTask] 推断的执行ID:', aiExecutionId);
          console.log('[AddTask] 推断的执行名称:', aiExecutionName || '未知');
        } else {
          console.log('[AddTask] ✗✗✗ AI 推断失败 ✗✗✗');
          console.log('[AddTask] 原因: 无法从任务内容推断出所属项目');
          console.log('[AddTask] 解决: 将使用默认执行');
        }
      }

      // 详细打印后端返回的数据，便于调试
      console.log('[AddTask] 后端返回的完整数据:', {
        id: result.data?.id,
        title: result.data?.title,
        executionId: result.data?.executionId,
        executionName: result.data?.executionName,
        zentaoExecution: result.data?.zentaoExecution
      });

      // 第二步：尝试在浏览器端创建禅道任务（使用 AI 提取的标题和执行 ID）
      try {
        await ZentaoBrowserClient.initConfig();
        if (ZentaoBrowserClient.isConfigured()) {
          console.log('[AddTask] 尝试使用浏览器端创建禅道任务...');
          console.log('[AddTask] AI 分析的执行 ID:', aiExecutionId, '类型:', typeof aiExecutionId);

          const zentaoResult = await ZentaoBrowserClient.createTask({
            title: aiTitle,
            content: content,
            dueDate: null,
            executionId: aiExecutionId,  // 传入 AI 分析的执行 ID
            executionType: executionType  // 传入执行类型
          });

          console.log('[AddTask] 禅道创建结果:', zentaoResult);

          // 看板返回 cardId，普通任务返回 taskId
          const zentaoObjectId = zentaoResult.taskId || zentaoResult.cardId;
          if (zentaoResult.success && zentaoObjectId) {
            browserZentaoId = zentaoObjectId;
            console.log('[AddTask] 浏览器端创建成功:', executionType === 'kanban' ? '看板卡片' : '禅道任务', 'ID:', browserZentaoId);
          } else if (zentaoResult.success && !zentaoObjectId) {
            console.log('[AddTask] 创建成功但没有返回ID， responseData:', zentaoResult.responseData);
            // 对于看板，可能创建成功但没有返回ID，可以跳过关联
            console.log('[AddTask] 跳过禅道ID关联（看板卡片可能不返回ID）');
          } else {
            console.log('[AddTask] 浏览器端创建失败:', zentaoResult.reason);
          }
        }
      } catch (err) {
        console.log('[AddTask] 浏览器端创建禅道任务出错:', err.message);
      }

      // 更新任务的 zentaoId（如果禅道端创建成功）
      if (browserZentaoId) {
        // 使用 AI 分析后的执行 ID，如果没有则使用全局配置
        const executionId = aiExecutionId || ZentaoBrowserClient.config.createTaskUrl || '';
        console.log('[AddTask] 使用的执行 ID:', executionId);

        // 使用通用更新接口更新 zentaoId、zentaoExecution 和 executionType
        const updateResp = await fetch(`${API_BASE_URL}/api/task/${result.data.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            zentaoId: browserZentaoId,
            zentaoExecution: executionId,
            executionType: executionType  // 存储执行类型，避免后续更新时需要再次查找
          })
        });
        if (updateResp.ok) {
          console.log('[AddTask] zentaoId、zentaoExecution 和 executionType 已保存到任务:', browserZentaoId, executionId, executionType);
        } else {
          console.warn('[AddTask] 保存 zentaoId 失败:', updateResp.status);
        }
      }

      // 检查 AI 分析出的任务进度，如果有进度则同步到禅道
      const taskProgress = result.data?.progress || 0;
      if (browserZentaoId && taskProgress > 0) {
        console.log('[AddTask] 任务有初始进度，准备同步到禅道:', taskProgress + '%');

        // 获取执行ID和看板ID
        const executionId = result.data?.executionId || ZentaoBrowserClient.config.createTaskUrl || '';
        let kanbanId = null;
        let executionType = null;
        if (executionId) {
          const execution = ExecutionSelector.executions.find(e => e.id === executionId) ||
                            ExecutionSelector.favoriteExecutions.find(e => e.id === executionId);
          if (execution) {
            kanbanId = execution.kanbanId || execution.id;
            executionType = execution.type;
          }
        }

        // 准备默认值（当用户两个都没填时使用）
        const defaultWork = taskProgress === 100 ? '任务完成' : `初始进度 ${taskProgress}%`;
        const defaultConsumed = 1;  // 默认1小时

        // 弹出填写工时对话框
        const progressResult = await ProgressInputDialog.show(
          taskProgress === 100 ? '完成任务' : '更新进度',
          taskProgress === 100 ? '任务已完成，请填写消耗工时' : `任务初始进度为 ${taskProgress}%，请填写工时`,
          '',           // placeholder 工作
          '',           // placeholder 消耗工时
          defaultWork,  // 默认工作（用户两个都没填时使用）
          defaultConsumed  // 默认消耗工时
        );

        // 如果用户填写了工时，同步到禅道
        if (progressResult !== null) {
          const progressComment = progressResult.work;
          const consumedTime = progressResult.consumed;

          // 计算剩余工时
          let leftTime = 0;
          if (taskProgress > 0 && taskProgress < 100 && consumedTime > 0) {
            leftTime = Math.round((consumedTime / (taskProgress / 100) - consumedTime) * 10) / 10;
            if (leftTime < 0) leftTime = 0;
          } else if (taskProgress === 100) {
            leftTime = 0;
          } else if (consumedTime > 0) {
            leftTime = consumedTime * 2;
          }

          // 更新禅道任务状态
          let status = 'todo';
          if (taskProgress > 0 && taskProgress < 100) status = 'in_progress';
          else if (taskProgress === 100) status = 'done';

          try {
            await ZentaoBrowserClient.updateTaskStatus(browserZentaoId, status, taskProgress, {
              executionType,
              kanbanId
            });
            console.log('[AddTask] 禅道任务状态已更新为:', status);

            // 记录工时到禅道
            if (consumedTime > 0 || progressComment) {
              const effortResult = await ZentaoBrowserClient.recordEffort(browserZentaoId, progressComment, consumedTime, leftTime, kanbanId, taskProgress);
              if (effortResult.success) {
                console.log('[AddTask] 禅道工时已记录');

                // 更新本地任务的累计消耗工时
                await fetch(`${API_BASE_URL}/api/task/${result.data.id}`, {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ totalConsumedTime: consumedTime })
                });
              }
            }
          } catch (err) {
            console.log('[AddTask] 同步进度到禅道失败:', err.message);
          }
        }
      }

      await loadTasks();
      await loadCalendar();

      // 显示操作结果
      if (result.isNew === false) {
        Toast.info(result.message || '已更新现有任务');
      } else {
        Toast.success('任务已添加' + (browserZentaoId ? ' (已同步至禅道)' : ''));
      }

      // 触发同步
      triggerSync();
    } else {
      input.value = originalVal; // 失败时恢复原来的输入
      const errorMsg = typeof result.error === 'object'
        ? JSON.stringify(result.error)
        : result.error || '未知错误';
      Toast.error('添加失败: ' + errorMsg);
    }
  } catch (err) {
    input.value = originalVal; // 失败时恢复原来的输入
    Toast.error('添加失败，请确保后端服务正在运行');
    console.warn('添加任务错误:', err);
  } finally {
    restoreButton();
    input.placeholder = originalPlaceholder;
    input.focus();
  }
}

// 更新任务进度
async function updateTaskProgress(taskId, progress) {
  try {
    // 获取任务信息，用于弹窗提示
    const task = allTasks.find(t => t.id === taskId);
    if (!task) return;

    console.log('[Progress] updateTaskProgress 调用:', { taskId, taskProgress: task.progress, newProgress: progress });

    let progressComment = '';
    let consumedTime = 0;

    // 如果进度有变化，弹出输入框让用户填写工作内容和消耗工时
    if (task.progress !== progress) {
      const result = await ProgressInputDialog.show(
        '更新进度',
        `更新进度至 ${progress}%`,
        '',                              // placeholder 工作
        '',                              // placeholder 消耗工时
        `更新进度至 ${progress}%`,         // 默认工作
        1                                 // 默认消耗工时（1小时）
      );

      // 用户取消则不更新，返回 false
      if (result === null) {
        console.log('[Progress] 用户取消进度更新');
        return false;
      }

      progressComment = result.work;
      consumedTime = result.consumed;

      // 更新今日工时
      if (consumedTime > 0) {
        updateTodayWorkTime(consumedTime);
        // 记录该任务今日工时，用于删除时减去
        recordTaskWorkTime(taskId, consumedTime);
      }
    }

    // 第一步：尝试在浏览器端更新禅道任务状态（如果有 zentaoId）
    if (task.zentaoId) {
      try {
        // 根据进度确定状态
        let status = 'todo';
        if (progress > 0 && progress < 100) status = 'in_progress';
        else if (progress === 100) status = 'done';

        // 获取执行类型（判断是否为看板）
        // 优先使用任务中已存储的 executionType，如果没有则查找
        let executionType = task.executionType;
        let kanbanId = null;

        if (!executionType && task.executionId) {
          // 从 ExecutionFavorites 获取执行类型
          executionType = ExecutionFavorites.getExecutionType(task.executionId);
          console.log('[Progress] 从缓存获取执行类型:', task.executionId, '=>', executionType);
        }

        // 对于看板类型，kanbanId 就是 executionId
        if (executionType === 'kanban') {
          kanbanId = task.executionId;
        }

        console.log('[Progress] 执行类型:', executionType, '看板ID:', kanbanId);

        const zentaoResult = await ZentaoBrowserClient.updateTaskStatus(task.zentaoId, status, progress, {
          executionType,
          kanbanId
        });
        if (zentaoResult.success) {
          console.log('[Progress] 浏览器端更新禅道状态成功');
        } else {
          console.log('[Progress] 浏览器端更新禅道状态失败:', zentaoResult.reason);
        }

        // 仅当用户输入了消耗时间或工作内容时才上传日志
        if (consumedTime > 0 || progressComment) {
          // 获取任务的历史累计消耗工时，加上本次消耗，得到总累计消耗工时
          const previousTotalConsumed = task.totalConsumedTime || 0;
          const totalConsumedTime = previousTotalConsumed + consumedTime;

          // 根据公式自动计算剩余工时：剩余工时 = 总累计消耗工时 / 进度 - 总累计消耗工时
          // 例如：累计消耗4小时，进度50% → 剩余 = 4/0.5 - 4 = 4小时
          let leftTime = 0;
          if (progress > 0 && progress < 100 && totalConsumedTime > 0) {
            leftTime = Math.round((totalConsumedTime / (progress / 100) - totalConsumedTime) * 10) / 10; // 保留1位小数
            // 确保剩余工时不为负数
            if (leftTime < 0) leftTime = 0;
          } else if (progress === 100) {
            leftTime = 0;
          } else if (totalConsumedTime > 0) {
            // 进度为0但有消耗工时，暂设为累计消耗工时的2倍作为估算
            leftTime = totalConsumedTime * 2;
          }
          console.log(`[Progress] 累计消耗: ${previousTotalConsumed}h + ${consumedTime}h = ${totalConsumedTime}h, 进度=${progress}%, 计算剩余=${leftTime}h`);
          console.log('[Progress] 调用 recordEffort，参数:', { zentaoId: task.zentaoId, kanbanId, comment: progressComment });

          const effortResult = await ZentaoBrowserClient.recordEffort(task.zentaoId, progressComment, consumedTime, leftTime, kanbanId, progress);
          if (effortResult.success) {
            console.log('[Progress] 浏览器端记录禅道工时成功');
            // 更新本地任务的累计消耗工时
            await fetch(`${API_BASE_URL}/api/task/${taskId}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ totalConsumedTime })
            });
          } else {
            console.log('[Progress] 浏览器端记录禅道工时失败:', effortResult.reason);
          }
        }
      } catch (err) {
        console.log('[Progress] 浏览器端更新禅道状态出错:', err.message);
      }
    }

    // 第二步：调用服务端 API 更新进度
    const response = await fetch(`${API_BASE_URL}/api/task/${taskId}/progress`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ progress, progressComment, consumedTime })
    });

    const result = await response.json();

    if (result.success) {
      // 直接在本地更新任务状态和进度
      const localTask = allTasks.find(t => t.id === taskId);
      if (localTask) {
        localTask.progress = progress;
        // 根据进度更新状态
        if (progress === 100) {
          localTask.status = 'done';
        } else if (progress > 0 && progress < 100) {
          localTask.status = 'in_progress';
        } else if (progress === 0) {
          localTask.status = 'todo';
        }
        // 更新累计消耗工时
        if (consumedTime > 0) {
          localTask.totalConsumedTime = (localTask.totalConsumedTime || 0) + consumedTime;
        }
      }
      // 重新渲染任务列表
      renderTasks();
      // 更新统计数据
      await updateTaskStats();
      console.log('[Progress] 进度更新成功，本地状态已更新');
      return true;
    } else {
      Toast.error('更新进度失败');
      console.warn('更新进度失败:', result.error);
      return false;
    }
  } catch (err) {
    Toast.error('更新进度失败');
    console.warn('更新进度失败:', err);
    return false;
  }
}

// 更新任务优先级
async function updateTaskPriority(taskId, priority) {
  try {
    // 获取任务信息，用于同步到禅道
    const task = allTasks.find(t => t.id === taskId);

    // 如果有 zentaoId 和 zentaoExecution，先同步到禅道
    if (task && task.zentaoId && task.zentaoExecution) {
      try {
        const zentaoResult = await ZentaoBrowserClient.editTask({
          zentaoId: task.zentaoId,
          execution: task.zentaoExecution,
          name: task.title,  // 传入任务标题，用于 desc 字段
          pri: priority
        });
        if (zentaoResult.success) {
          console.log('[Priority] 禅道优先级已同步');
        } else {
          console.log('[Priority] 禅道优先级同步失败:', zentaoResult.reason);
        }
      } catch (err) {
        console.log('[Priority] 同步禅道优先级出错:', err.message);
      }
    }

    const response = await fetch(`${API_BASE_URL}/api/task/${taskId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority, order: null })
    });

    const result = await response.json();

    if (result.success) {
      // 先重新加载任务数据
      await loadTasks();

      // 更新任务卡片的优先级显示
      const taskCard = document.querySelector(`.task-card[data-task-id="${taskId}"]`);
      if (taskCard) {
        const updatedTask = allTasks.find(t => t.id === taskId);
        if (updatedTask) {
          // 重新生成优先级按钮和菜单
          const priorityBtn = taskCard.querySelector('.priority-toggle');
          const priorityMenu = document.querySelector(`.priority-menu-${taskId}`);

          // 移除旧的菜单
          if (priorityMenu) priorityMenu.remove();

          // 更新优先级按钮样式
          const priorityColors = { 1: '#ef4444', 2: '#f59e0b', 3: '#3b82f6', 4: '#9ca3af' };
          priorityBtn.style.color = priorityColors[priority];
          priorityBtn.textContent = `P${priority}`;

          // 创建新的菜单（排除当前优先级）
          const newMenu = document.createElement('div');
          newMenu.className = `priority-menu priority-menu-${taskId}`;
          newMenu.style.cssText = 'display:none; position:fixed; background:white; border:1px solid #e2e8f0; border-radius:6px; box-shadow:0 4px 12px rgba(0,0,0,0.15); z-index:99999; min-width:60px; padding:4px 0;';
          newMenu.innerHTML = `
            ${priority !== 1 ? `<div class="priority-option" data-priority="1" style="padding:6px 12px; cursor:pointer; font-size:12px; font-weight:500; color:#ef4444; text-align:center;">P1</div>` : ''}
            ${priority !== 2 ? `<div class="priority-option" data-priority="2" style="padding:6px 12px; cursor:pointer; font-size:12px; font-weight:500; color:#f59e0b; text-align:center;">P2</div>` : ''}
            ${priority !== 3 ? `<div class="priority-option" data-priority="3" style="padding:6px 12px; cursor:pointer; font-size:12px; font-weight:500; color:#3b82f6; text-align:center;">P3</div>` : ''}
            ${priority !== 4 ? `<div class="priority-option" data-priority="4" style="padding:6px 12px; cursor:pointer; font-size:12px; font-weight:500; color:#9ca3af; text-align:center;">P4</div>` : ''}
          `;
          document.body.appendChild(newMenu);

          // 重新绑定菜单事件
          const newPriorityMenu = document.querySelector(`.priority-menu-${taskId}`);
          newPriorityMenu.querySelectorAll('.priority-option').forEach(option => {
            option.addEventListener('click', (e) => {
              e.stopPropagation();
              const newPriority = parseInt(e.currentTarget.dataset.priority);
              updateTaskPriority(taskId, newPriority);
              newPriorityMenu.style.display = 'none';
            });
            option.addEventListener('mouseenter', () => {
              option.style.background = '#f1f5f9';
            });
            option.addEventListener('mouseleave', () => {
              option.style.background = 'transparent';
            });
          });

          // 重新绑定按钮点击事件（使用新菜单）
          priorityBtn.onclick = (e) => {
            e.stopPropagation();
            document.querySelectorAll('.priority-menu').forEach(m => {
              if (!m.classList.contains(`priority-menu-${taskId}`)) {
                m.style.display = 'none';
              }
            });
            newPriorityMenu.style.display = newPriorityMenu.style.display === 'none' ? 'block' : 'none';
            const rect = priorityBtn.getBoundingClientRect();
            newPriorityMenu.style.top = (rect.bottom + 2) + 'px';
            newPriorityMenu.style.left = rect.left + 'px';
          };
        }
      }

      // 如果详情弹窗打开，也要更新
      const detailModal = document.querySelector('.task-detail-modal.active');
      if (detailModal) {
        const detailTaskId = detailModal.querySelector('.detail-priority-btn')?.closest('.task-detail-modal')?.querySelector('.detail-priority-btn')?.parentElement?.querySelector('[data-action="close"]')?.dataset?.taskId;
        // 简单的做法：关闭弹窗
        if (detailTaskId === taskId) {
          detailModal.remove();
        }
      }
    } else {
      Toast.error('更新优先级失败');
      console.warn('更新优先级失败:', result.error);
    }
  } catch (err) {
    console.warn('更新优先级失败:', err);
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
    if (task.zentaoId && task.zentaoExecution) {
      try {
        const zentaoResult = await ZentaoBrowserClient.editTask({
          zentaoId: task.zentaoId,
          execution: task.zentaoExecution,
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
    // 从今日工时中减去该任务今日记录的工时
    const removedHours = removeTaskWorkTime(taskId);
    if (removedHours > 0) {
      console.log(`[DeleteTask] 已从今日工时中减去: ${removedHours}h`);
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

      // 从今日工时中减去该任务今日记录的工时
      const removedHours = removeTaskWorkTime(taskId);
      if (removedHours > 0) {
        console.log(`[HandleTask] 已从今日工时中减去: ${removedHours}h`);
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

// 搜索任务
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
      allTasks = result.data;
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
      <div><strong>创建时间:</strong> ${new Date(task.createdAt).toLocaleString('zh-CN')}</div>
    </div>
    ${progressUpdatesHtml}
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
  // 从本地存储获取禅道配置
  const config = localStorage.getItem('workAssistantConfig');
  if (config) {
    const parsed = JSON.parse(config);
    const baseUrl = parsed.zentaoUrl?.replace(/\/$/, '') || '';
    return `${baseUrl}/zentao/task-view-${taskId}.html`;
  }
  return `#`;
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
      await fetch(`${API_BASE_URL}/api/task/${task.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reminderTime })
      });
      await loadTasks();
      modal.classList.remove('active');
    } catch (err) {
      console.warn('更新时间失败:', err);
      alert('更新时间失败');
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
function loadSettings() {
  const saved = localStorage.getItem('workAssistantConfig');
  const config = saved ? JSON.parse(saved) : { ...CONFIG_PRESETS.zhipu };

  // 安全获取元素并设置值
  const setVal = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  };

  setVal('aiProvider', config.aiProvider || 'zhipu');
  setVal('apiKey', config.apiKey || '');
  setVal('apiBaseUrl', config.apiBaseUrl || CONFIG_PRESETS.zhipu.apiBaseUrl);
  setVal('aiModel', config.aiModel || CONFIG_PRESETS.zhipu.aiModel);
  setVal('morningHour', config.morningHour || 9);
  setVal('eveningHour', config.eveningHour || 21);
  setVal('webhookUrl', config.webhookUrl || '');
  setVal('webhookType', config.webhookType || 'generic');

  // 加载禅道配置
  const zentaoEnabled = document.getElementById('zentaoEnabled');
  if (zentaoEnabled) {
    zentaoEnabled.checked = config.zentaoEnabled || false;
  }
  setVal('zentaoUrl', config.zentaoUrl || '');
  setVal('zentaoUsername', config.zentaoUsername || '');
  setVal('zentaoPassword', config.zentaoPassword || '');
  setVal('zentaoCreateTaskUrl', config.zentaoCreateTaskUrl || '');

  // 同步调试模式复选框状态
  const debugModeToggle = document.getElementById('debugModeToggle');
  if (debugModeToggle) {
    debugModeToggle.checked = debugMode;
  }

  // 加载同步配置
  if (window.syncUI) {
    window.syncUI.loadCurrentSyncSettings();
  }

  // 加载禅道配置状态
  loadZentaoConfigStatus();
}

// 加载禅道配置状态
async function loadZentaoConfigStatus() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/zentao/config`);
    if (response.ok) {
      const result = await response.json();
      if (result.success && result.data) {
        console.log('[前端] 禅道配置状态:', result.data);
        // 如果后端有配置，可以使用后端的配置覆盖前端的
        if (result.data.enabled && !document.getElementById('zentaoUrl').value) {
          document.getElementById('zentaoEnabled').checked = true;
          document.getElementById('zentaoUrl').value = result.data.urlPrefix?.replace('...', '') || '';
          document.getElementById('zentaoUsername').value = result.data.username || '';
          document.getElementById('zentaoPassword').value = result.data.password || '';
          document.getElementById('zentaoCreateTaskUrl').value = result.data.createTaskUrl || '';
        }
      }
    }
  } catch (err) {
    console.log('[前端] 获取禅道配置状态失败（可能后端未启动）');
  }
}

// 检查服务状态
async function checkServiceStatus() {
  const statusDot = document.getElementById('serviceStatusDot');

  statusDot.className = 'status-dot unknown';
  statusDot.title = '检测中...';

  try {
    const response = await fetch(`${API_BASE_URL}/health`);
    if (response.ok) {
      statusDot.className = 'status-dot online';
      statusDot.title = '后端服务在线';
    } else {
      throw new Error('服务异常');
    }
  } catch (err) {
    statusDot.className = 'status-dot offline';
    statusDot.title = '后端服务离线';
  }
}

// 显示历史日报列表
async function showHistoryModal() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/history?limit=50`);
    const result = await response.json();

    if (result.success) {
      const modal = document.getElementById('reportModal');
      const title = document.getElementById('reportModalTitle');
      const body = document.getElementById('reportModalBody');

      title.textContent = '📊 历史报告';

      if (result.data.length === 0) {
        body.innerHTML = '<p style="text-align: center; color: #7f8c8d; padding: 40px;">暂无历史报告</p>';
      } else {
        body.innerHTML = `
          <div>
            ${result.data.map(item => `
              <div class="history-report-item" data-report-id="${item.id}" data-report-type="${item.type}" style="border: 1px solid var(--border-color); border-radius: 8px; padding: 16px; margin-bottom: 12px; transition: all 0.2s;">
                <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
                  <div style="flex: 1;">
                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                      <strong style="font-size: 14px;">${item.dateLabel || item.date}</strong>
                      <span class="report-type-badge" style="font-size: 11px; padding: 2px 6px; border-radius: 4px; background: ${item.type === 'daily' ? '#3498db' : item.type === 'weekly' ? '#9b59b6' : '#e67e22'}; color: white;">${item.type === 'daily' ? '日报' : item.type === 'weekly' ? '周报' : '月报'}</span>
                    </div>
                    <p style="font-size: 13px; color: #555; margin: 0;">${escapeHtml(item.summary || '').slice(0, 100)}${item.summary && item.summary.length > 100 ? '...' : ''}</p>
                    <div style="margin-top: 8px; font-size: 12px; color: #7f8c8d;">
                      完成 ${item.stats?.done || 0} 项 | 待办 ${item.stats?.todo || 0} 项
                    </div>
                  </div>
                </div>
                <div class="report-actions" style="display: flex; gap: 8px; margin-top: 12px; padding-top: 12px; border-top: 1px solid #eee;">
                  <button class="history-btn history-open-btn" data-id="${item.id}" style="padding: 4px 12px; font-size: 12px; border: 1px solid #3498db; background: white; color: #3498db; border-radius: 4px; cursor: pointer;">打开</button>
                  <button class="history-btn history-regen-btn" data-id="${item.id}" data-type="${item.type}" style="padding: 4px 12px; font-size: 12px; border: 1px solid #f39c12; background: white; color: #f39c12; border-radius: 4px; cursor: pointer;">重新生成</button>
                  <button class="history-btn history-delete-btn" data-id="${item.id}" style="padding: 4px 12px; font-size: 12px; border: 1px solid #e74c3c; background: white; color: #e74c3c; border-radius: 4px; cursor: pointer;">删除</button>
                </div>
              </div>
            `).join('')}
          </div>
        `;

        // 绑定按钮事件
        bindHistoryListButtons();
      }

      // 隐藏不需要的按钮
      document.getElementById('deleteReportBtn').style.display = 'none';
      document.getElementById('regenReportBtn').style.display = 'none';
      document.getElementById('pushReportBtn').style.display = 'none';

      modal.classList.add('active');
    }
  } catch (err) {
    Toast.error('加载历史报告失败: ' + err.message);
  }
}

// 绑定历史列表按钮事件
function bindHistoryListButtons() {
  // 打开按钮
  document.querySelectorAll('.history-open-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const reportId = btn.dataset.id;
      openHistoryReportDetail(reportId);
    });
  });

  // 重新生成按钮
  document.querySelectorAll('.history-regen-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const reportId = btn.dataset.id;
      const type = btn.dataset.type;
      regenerateReport(reportId, type, btn);
    });
  });

  // 删除按钮
  document.querySelectorAll('.history-delete-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const reportId = btn.dataset.id;
      deleteHistoryReport(reportId, btn);
    });
  });
}

// 打开历史报告详情
async function openHistoryReportDetail(reportId) {
  try {
    const response = await fetch(`${API_BASE_URL}/api/history?limit=100`);
    const result = await response.json();

    if (result.success) {
      const report = result.data.find(r => r.id === reportId);
      if (report) {
        const modal = document.getElementById('reportModal');
        const title = document.getElementById('reportModalTitle');
        const body = document.getElementById('reportModalBody');

        title.textContent = report.dateLabel || report.date;

        body.innerHTML = `
          <div style="margin-bottom: 16px;">
            <h4 style="margin-bottom: 8px;">总览</h4>
            <p style="color: #666; font-size: 14px;">${escapeHtml(report.summary)}</p>
          </div>
          ${report.completed?.length ? `
          <div style="margin-bottom: 16px;">
            <h4 style="margin-bottom: 8px;">✅ 已完成</h4>
            <ul style="padding-left: 20px; color: #555; font-size: 14px;">
              ${report.completed.map(c => `<li style="margin-bottom: 4px;">${formatReportItem(c)}</li>`).join('')}
            </ul>
          </div>` : ''}
          ${report.tomorrowFocus?.length ? `
          <div style="margin-bottom: 16px;">
            <h4 style="margin-bottom: 8px;">🎯 待办/进行中</h4>
            <ul style="padding-left: 20px; color: #555; font-size: 14px;">
              ${report.tomorrowFocus.map(c => `<li style="margin-bottom: 4px;">${formatReportItem(c)}</li>`).join('')}
            </ul>
          </div>` : ''}
          ${report.risks?.length ? `
          <div style="margin-bottom: 16px;">
            <h4 style="margin-bottom: 8px; color: #e74c3c;">⚠️ 风险建议</h4>
            <ul style="padding-left: 20px; color: #e74c3c; font-size: 14px;">
              ${report.risks.map(c => `<li style="margin-bottom: 4px;">${escapeHtml(c)}</li>`).join('')}
            </ul>
          </div>` : ''}
          <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border-color); display: flex; gap: 8px;">
            <button id="historyBackBtn" class="btn-secondary">返回列表</button>
            <button id="historyPushBtn" class="btn-primary">推送</button>
          </div>
        `;

        // 绑定按钮事件
        document.getElementById('historyBackBtn').addEventListener('click', () => showHistoryModal());
        document.getElementById('historyPushBtn').addEventListener('click', () => pushHistoryReport(report.id));

        modal.classList.add('active');
      }
    }
  } catch (err) {
    Toast.error('加载报告详情失败: ' + err.message);
  }
}

// 重新生成报告
async function regenerateReport(oldReportId, type, btnElement) {
  const typeNames = { daily: '日报', weekly: '周报', monthly: '月报' };
  const confirmed = await showConfirm('重新生成报告', `确定要重新生成${typeNames[type]}吗？这将使用相同的时间范围。`, '重新生成', '取消');
  if (!confirmed) {
    return;
  }

  const originalText = btnElement.textContent;
  btnElement.textContent = '生成中...';
  btnElement.disabled = true;

  try {
    // 先获取原始报告的日期信息
    const historyRes = await fetch(`${API_BASE_URL}/api/history?limit=100`);
    const historyResult = await historyRes.json();
    let dateParam = null;
    
    if (historyResult.success) {
      const oldReport = historyResult.data.find(r => r.id === oldReportId);
      if (oldReport && oldReport.date) {
        dateParam = oldReport.date;
      }
    }

    // 构建请求参数
    const params = new URLSearchParams();
    if (dateParam) {
      params.append('date', dateParam);
    }
    
    const response = await fetch(`${API_BASE_URL}/api/report/generate/${type}?${params.toString()}`, { method: 'POST' });
    const result = await response.json();

    if (result.success) {
      await showHistoryModal(); // 刷新列表
      Toast.success(`${typeNames[type]}已重新生成`);
    } else {
      Toast.error(`生成失败: ${result.error}`);
    }
  } catch (err) {
    Toast.error(`网络错误: ${err.message}`);
  } finally {
    btnElement.textContent = originalText;
    btnElement.disabled = false;
  }
}

// 删除历史报告
async function deleteHistoryReport(reportId, btnElement) {
  const confirmed = await showConfirm('删除报告', '确定要删除此报告吗？删除后无法恢复。', '删除', '取消');
  if (!confirmed) {
    return;
  }

  try {
    await fetch(`${API_BASE_URL}/api/report/${reportId}`, { method: 'DELETE' });

    // 从DOM中移除该报告项
    const reportItem = btnElement.closest('.history-report-item');
    if (reportItem) {
      reportItem.remove();
    }

    // 检查是否需要更新按钮状态
    await checkTodayReports();

    // 如果没有报告了，刷新整个列表
    const remainingItems = document.querySelectorAll('.history-report-item');
    if (remainingItems.length === 0) {
      await showHistoryModal();
    }

    Toast.success('报告已删除');
  } catch (err) {
    Toast.error('删除失败: ' + err.message);
  }
}

// 查看历史日报详情（保留向后兼容）
window.viewHistoryDetail = async function (reportId) {
  try {
    const response = await fetch(`${API_BASE_URL}/api/history`);
    const result = await response.json();

    if (result.success) {
      const report = result.data.find(r => r.id === reportId);
      if (report) {
        const modal = document.getElementById('reportModal');
        const title = document.getElementById('reportModalTitle');
        const body = document.getElementById('reportModalBody');

        title.textContent = report.dateLabel || report.date;

        body.innerHTML = `
          <div style="margin-bottom: 16px;">
            <h4 style="margin-bottom: 8px;">总览</h4>
            <p style="color: #666; font-size: 14px;">${escapeHtml(report.summary)}</p>
          </div>
          ${report.completed?.length ? `
          <div style="margin-bottom: 16px;">
            <h4 style="margin-bottom: 8px;">✅ 已完成</h4>
            <ul style="padding-left: 20px; color: #555; font-size: 14px;">
              ${report.completed.map(c => `<li style="margin-bottom: 4px;">${formatReportItem(c)}</li>`).join('')}
            </ul>
          </div>` : ''}
          ${report.tomorrowFocus?.length ? `
          <div style="margin-bottom: 16px;">
            <h4 style="margin-bottom: 8px;">🎯 待办/进行中</h4>
            <ul style="padding-left: 20px; color: #555; font-size: 14px;">
              ${report.tomorrowFocus.map(c => `<li style="margin-bottom: 4px;">${formatReportItem(c)}</li>`).join('')}
            </ul>
          </div>` : ''}
          ${report.risks?.length ? `
          <div style="margin-bottom: 16px;">
            <h4 style="margin-bottom: 8px; color: #e74c3c;">⚠️ 风险建议</h4>
            <ul style="padding-left: 20px; color: #e74c3c; font-size: 14px;">
              ${report.risks.map(c => `<li style="margin-bottom: 4px;">${escapeHtml(c)}</li>`).join('')}
            </ul>
          </div>` : ''}
          <div style="margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border-color); display: flex; gap: 8px;">
            <button class="btn-secondary" onclick="showHistoryModal()">返回列表</button>
            <button class="btn-primary" onclick="pushHistoryReport('${report.id}')">推送</button>
          </div>
        `;

        modal.classList.add('active');
      }
    }
  } catch (err) {
    Toast.error('加载日报详情失败: ' + err.message);
  }
};

// 推送历史日报
window.pushHistoryReport = async function (reportId) {
  try {
    const res = await fetch(`${API_BASE_URL}/api/report/${reportId}/push`, { method: 'POST' });
    const resJson = await res.json();
    if (!resJson.success) {
      Toast.error('推送失败: ' + resJson.error);
    } else {
      Toast.success('推送成功');
    }
  } catch (err) {
    Toast.error('网络错误: ' + err.message);
  }
};

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
  triggerSync();
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

// ==================== 数据同步触发 ====================

/**
 * 触发数据同步（数据变更时调用）
 */
function triggerSync() {
  if (typeof syncManager !== 'undefined' && syncManager.syncConfig.enabled && syncManager.syncConfig.autoSync) {
    syncManager.debouncedUpload();
    // 更新UI状态
    if (window.syncUI) {
      window.syncUI.updateStatusDisplay();
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
  isLoggedIn: false,
  sessionToken: null,
  cookies: null, // 手动存储的 Cookie 字符串
  keepAliveTimer: null,
  users: {}, // 用户列表缓存 {account: name}
  usersLoaded: false, // 用户列表是否已加载

  /**
   * 初始化（从 localStorage 加载缓存的用户列表）
   */
  init() {
    // 尝试从 localStorage 加载用户列表
    try {
      const cachedUsers = localStorage.getItem('zentao_users');
      if (cachedUsers) {
        this.users = JSON.parse(cachedUsers);
        this.usersLoaded = true;
        console.log('[ZentaoBrowser] 从缓存加载用户列表成功:', Object.keys(this.users).length, '个用户');
      }
    } catch (e) {
      console.warn('[ZentaoBrowser] 从缓存加载用户列表失败:', e);
    }
  },

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
   * 登录禅道
   */
  async login() {
    await this.initConfig();

    if (!this.isConfigured()) {
      console.log('[ZentaoBrowser] 禅道未配置');
      return false;
    }

    // Force re-login if we are running a manual test where config is passed
    if (this.isLoggedIn && !this.config._isManualTest) {
      console.log('[ZentaoBrowser] 已登录，跳过');
      return true;
    }

    if (this._isLoggingIn) {
      console.log('[ZentaoBrowser] 正在登录中，防重入...');
      // 简单等待锁释放，实际中可以选择用 Promise
      return false;
    }

    this._isLoggingIn = true;
    console.log('[ZentaoBrowser] 开始全自动标签页模拟登录流...');

    try {
      // 通过 background.js 发起真正的浏览器原生登陆流程，因为只有 background 具备跨站操作和保存 Session 原生安全 Cookie 的特权
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'performZenTaoLogin',
          url: this.getBaseUrl(),
          username: this.config.username,
          password: this.config.password
        }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[ZentaoBrowser] 后台通信失败:', chrome.runtime.lastError);
            Toast.error('内部通信异常');
            resolve(false);
            return;
          }

          if (response && response.success) {
            this.sessionToken = response.token;
            localStorage.setItem('zentao_sessionToken', this.sessionToken);
            this.isLoggedIn = true;
            if (this.config._isManualTest) Toast.success('禅道登录成功');
            console.log('[ZentaoBrowser] 隐形标签页自动登录已同步完成');
            resolve(true);
          } else {
            console.warn('[ZentaoBrowser] 后台注入登录失败:', response?.error);
            if (this.config._isManualTest) Toast.error('禅道登录失败: ' + (response?.error || ''));
            resolve(false);
          }
        });
      });
    } catch (err) {
      console.warn('[ZentaoBrowser] 登录异常:', err.message);
      if (this.config._isManualTest) Toast.error('禅道登录异常');
      return false;
    } finally {
      this._isLoggingIn = false;
    }
  },

  /**
   * 自动初始化（页面加载时调用）
   * 检查浏览器中是否已经登录禅道，如果没有则执行登录
   */
  async autoInit() {
    await this.initConfig();
    if (this.isConfigured()) {
      // 先检查浏览器中是否已经登录禅道
      const isValid = await this.validateSession();
      if (isValid) {
        console.log('[ZentaoBrowser] 检测到浏览器中已登录禅道，无需重复登录');
        this.isLoggedIn = true;
        this.startKeepAlive();
        return;
      }

      // 浏览器中未登录，执行自动登录
      console.log('[ZentaoBrowser] 浏览器中未登录禅道，开始自动登录...');
      const loginSuccess = await this.login();
      if (loginSuccess) {
        this.startKeepAlive();
      }
    }
  },

  /**
   * 验证当前 session 是否有效
   * 直接检查浏览器中的禅道 cookie，因为扩展页面的 fetch 请求不会自动携带其他域的 cookie
   */
  async validateSession() {
    return new Promise((resolve) => {
      try {
        const url = this.getBaseUrl();
        if (!url) {
          resolve(false);
          return;
        }

        // 使用禅道首页 URL 来检查 cookie，确保能正确找到 cookie
        const zentaoUrl = `${url}/zentao/`;

        // 直接检查浏览器中的禅道 session cookie（zentaosid）
        chrome.cookies.get({ url: zentaoUrl, name: 'zentaosid' }, (cookie) => {
          if (chrome.runtime.lastError) {
            console.warn('[ZentaoBrowser] 检查 cookie 失败:', chrome.runtime.lastError.message);
            resolve(false);
            return;
          }

          if (cookie && cookie.value) {
            // cookie 存在且有值，说明浏览器已登录禅道
            console.log('[ZentaoBrowser] 检测到浏览器中禅道登录状态有效');
            resolve(true);
          } else {
            // 没有找到 cookie，说明未登录
            console.log('[ZentaoBrowser] 浏览器中未检测到禅道登录 cookie');
            resolve(false);
          }
        });
      } catch (err) {
        console.warn('[ZentaoBrowser] 验证 session 失败:', err.message);
        resolve(false);
      }
    });
  },

  /**
   * 启动定时保活检查
   */
  startKeepAlive(intervalMinutes = 2) {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
    }

    const intervalMs = intervalMinutes * 60 * 1000;
    console.log(`[ZentaoBrowser] 启动会话保活，检测间隔: ${intervalMinutes} 分钟`);

    // 不立即执行检查，等定时器第一次触发时再检查
    // 这样可以避免在登录过程中重复登录
    this.keepAliveTimer = setInterval(() => {
      this.keepAliveCheck();
    }, intervalMs);
  },

  /**
   * 停止定时保活检查
   */
  stopKeepAlive() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
      console.log('[ZentaoBrowser] 会话保活定时器已停止');
    }
  },

  /**
   * 刷新 Cookie（直接在浏览器端重新登录）
   */
  async refreshCookies() {
    try {
      console.log('[ZentaoBrowser] 正在重新登录以刷新 Cookie...');
      this.isLoggedIn = false;
      const success = await this.login();
      if (success) {
        // 更新 localStorage
        try {
          localStorage.setItem('zentao_sessionToken', this.sessionToken);
        } catch (e) {
          // 忽略存储错误
        }
        return true;
      }
      return false;
    } catch (err) {
      console.warn('[ZentaoBrowser] 刷新 Cookie 失败:', err.message);
      return false;
    }
  },

  /**
   * 会话保活检查
   * 直接检查浏览器中的禅道 cookie，确保登录状态与用户实际浏览器状态同步
   */
  async keepAliveCheck() {
    if (!this.isConfigured()) return;

    try {
      const isValid = await this.validateSession();
      if (!isValid) {
        console.log('[ZentaoBrowser] 检测到浏览器登录失效，正在重新登录...');
        this.isLoggedIn = false;
        await this.login();
      } else {
        console.log('[ZentaoBrowser] 浏览器会话正常');
      }
    } catch (err) {
      console.warn('[ZentaoBrowser] 会话保活检查失败:', err.message);
    }
  },

  /**
   * 生成随机 UID
   */
  generateUid() {
    return Math.random().toString(36).substring(2, 14);
  },

  /**
   * 获取浏览器中禅道的所有 cookie
   * 用于手动设置请求头，因为扩展页面的 fetch 不会自动携带跨域 cookie
   */
  async getCookies() {
    return new Promise((resolve) => {
      try {
        const url = this.getBaseUrl();
        if (!url) {
          resolve('');
          return;
        }

        const zentaoUrl = new URL(url);

        // 获取所有匹配的 cookie（包括主域和子域）
        chrome.cookies.getAll({ domain: zentaoUrl.hostname }, (cookies) => {
          if (chrome.runtime.lastError) {
            console.warn('[ZentaoBrowser] 获取 cookies 失败:', chrome.runtime.lastError.message);
            resolve('');
            return;
          }

          if (cookies && cookies.length > 0) {
            // 构造 Cookie header 格式: name1=value1; name2=value2
            const cookieHeader = cookies
              .map(c => `${c.name}=${c.value}`)
              .join('; ');
            console.log('[ZentaoBrowser] 获取到浏览器 cookies:', cookies.length, '个');
            resolve(cookieHeader);
          } else {
            console.log('[ZentaoBrowser] 未找到浏览器 cookies');
            resolve('');
          }
        });
      } catch (err) {
        console.warn('[ZentaoBrowser] 获取 cookies 异常:', err.message);
        resolve('');
      }
    });
  },

  /**
   * 获取 session token（通过 GET 请求获取用户信息页面）
   */
  async getSessionToken() {
    try {
      const response = await fetch(`${this.getBaseUrl()}/zentao/api.php?mode=getconfig`);
      if (!response.ok) return null;

      const text = await response.text();
      // 尝试从响应中提取 session token
      const match = text.match(/"s":"([^"]+)"/);
      if (match) {
        return match[1];
      }
    } catch (err) {
      console.warn('[ZentaoBrowser] 获取 session token 失败:', err);
    }
    return null;
  },

  /**
   * 从团队页面加载用户列表
   * 通过创建临时标签页访问 my-team.html，注入脚本提取用户信息
   */
  async loadUsersFromTeamPage() {
    const config = await this.initConfig();
    const baseUrl = config?.url?.replace(/\/$/, '');
    if (!baseUrl) {
      console.warn('[ZentaoBrowser] 无法获取 baseUrl，跳过用户列表加载');
      return {};
    }

    console.log('[ZentaoBrowser] 开始从禅道页面加载用户列表...');

    // 创建临时标签页获取用户列表（不使用 ZentaoTabManager，避免关闭用户标签页）
    const targetUrl = `${baseUrl}/zentao/my-team.html`;
    const tab = await ZentaoTabManager.getOrCreateTab({
      baseUrl,
      targetUrl,
      active: false,
      reload: false
    });

    // 标记这是临时标签页，需要在加载完成后关闭
    let shouldCloseTab = false;

    // 如果标签页不在目标页面，导航过去
    if (!tab.url.includes('my-team.html')) {
      console.log('[ZentaoBrowser] 标签页不在 my-team.html，导航中...');
      await ZentaoTabManager.navigateTo(tab, targetUrl, { waitTimeout: 10000 });
      // 导航后不关闭，因为这是复用的标签页
    } else {
      // 如果已经在目标页面，说明是复用的标签页，不关闭
      console.log('[ZentaoBrowser] 标签页已在目标页面，复用现有标签页');
    }

    // 注入脚本提取用户 - 参考 Gemini 方案的纯函数设计
    console.log('[ZentaoBrowser] 准备注入脚本，tab ID:', tab.id, 'URL:', tab.url);

    // 先获取 tab 信息确认页面已加载
    const updatedTab = await chrome.tabs.get(tab.id);
    console.log('[ZentaoBrowser] Tab 当前状态:', {
      id: updatedTab.id,
      url: updatedTab.url,
      status: updatedTab.status,
      title: updatedTab.title
    });

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: scrapeUserDataFromZentao
    });

    console.log('[ZentaoBrowser] 脚本注入完成，results:', results);

    if (results && results.length > 0) {
      const data = results[0].result;
      console.log('[ZentaoBrowser] 返回数据:', data);

      // 打印所有从注入脚本返回的日志
      if (data && data.logs && Array.isArray(data.logs)) {
        console.log('[ZentaoBrowser] ========== 注入脚本日志开始 ==========');
        data.logs.forEach(logEntry => {
          console.log('[scrapeUserData]', ...logEntry.args);
        });
        console.log('[ZentaoBrowser] ========== 注入脚本日志结束 ==========');
      }

      if (data && data.status === 'success' && data.data) {
        const newUserCount = Object.keys(data.data).length;
        const existingUserCount = Object.keys(this.users).length;

        // 只有当新加载的用户数量大于已有数量时才更新
        if (newUserCount > existingUserCount) {
          this.users = data.data;
          this.usersLoaded = true;
          console.log('[ZentaoBrowser] 从禅道页面加载用户列表成功:', newUserCount, '个用户 (之前:', existingUserCount, '个)');
          console.log('[ZentaoBrowser] 用户列表:', this.users);
          if (data.list) {
            console.log('[ZentaoBrowser] 用户详细信息:', data.list);
          }

          // 保存用户列表到后端
          await this.saveUsersToBackend(this.users);
        } else {
          console.log('[ZentaoBrowser] 新加载的用户数量(', newUserCount, ') 不多于已有数量(', existingUserCount, ')，保留现有数据');
        }
      } else if (data && data.status === 'error') {
        console.warn('[ZentaoBrowser] 提取用户失败:', data.message);
        // 不覆盖已有数据
        if (Object.keys(this.users).length === 0) {
          this.users = {};
          this.usersLoaded = true;
        }
      } else if (data && data.status === 'fatal') {
        console.error('[ZentaoBrowser] 提取过程发生致命错误:', data.message);
        // 不覆盖已有数据
        if (Object.keys(this.users).length === 0) {
          this.users = {};
          this.usersLoaded = true;
        }
      } else {
        console.warn('[ZentaoBrowser] 返回数据格式异常:', data);
        // 不覆盖已有数据
        if (Object.keys(this.users).length === 0) {
          this.users = {};
          this.usersLoaded = true;
        }
      }
    } else {
      console.warn('[ZentaoBrowser] 用户列表加载失败，无结果');
      this.users = {};
      this.usersLoaded = true;
    }

    // 不关闭标签页，因为它是通过 ZentaoTabManager 复用的，可能是用户正在使用的标签页
    console.log('[ZentaoBrowser] 用户列表加载完成，保留标签页');

    return this.users;
  },

  /**
   * 保存用户列表到后端
   */
  async saveUsersToBackend(users) {
    try {
      console.log('[ZentaoBrowser] 保存用户列表到后端和localStorage，用户数量:', Object.keys(users).length);

      // 同时保存到 localStorage 作为缓存
      try {
        localStorage.setItem('zentao_users', JSON.stringify(users));
        console.log('[ZentaoBrowser] ✓ 用户列表已保存到 localStorage');
      } catch (e) {
        console.warn('[ZentaoBrowser] 保存用户列表到 localStorage 失败:', e);
      }

      // 保存到后端
      const response = await fetch(`${API_BASE_URL}/api/zentao/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ users })
      });
      const result = await response.json();
      if (result.success) {
        console.log('[ZentaoBrowser] ✓ 用户列表已保存到后端:', result.message);
      } else {
        console.warn('[ZentaoBrowser] 保存用户列表到后端失败:', result.error);
      }
    } catch (err) {
      console.error('[ZentaoBrowser] 保存用户列表到后端异常:', err.message);
    }
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
   * 优先从内存获取，如果没有则尝试从 localStorage 和后端加载
   */
  async getUsers() {
    // 如果内存中没有用户列表，尝试从 localStorage 恢复
    if (!this.usersLoaded || Object.keys(this.users).length === 0) {
      try {
        const cachedUsers = localStorage.getItem('zentao_users');
        if (cachedUsers) {
          this.users = JSON.parse(cachedUsers);
          this.usersLoaded = true;
          console.log('[ZentaoBrowser] 从 localStorage 恢复用户列表:', Object.keys(this.users).length, '个用户');
        }
      } catch (e) {
        console.warn('[ZentaoBrowser] 从 localStorage 恢复用户列表失败:', e);
      }

      // 如果 localStorage 也没有，尝试从后端加载
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

      // 看板创建失败，直接返回错误，不降级到普通任务
      if (!kanbanResult.success) {
        return { success: false, reason: kanbanResult.reason || '看板任务创建失败' };
      }

      // 返回看板任务结果
      return kanbanResult;
    }

    // 普通任务（阶段/迭代）使用原有API
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

      const data = result.data;

      // 检查是否是登录失效
      if (data.result === false && data.message && (
        data.message.includes('登录已超时') ||
        data.message.includes('请重新登入') ||
        data.message.includes('请先登录')
      )) {
        console.log('[ZentaoBrowser] 检测到登录失效，尝试刷新 Cookie...');

        // 直接在浏览器端重新登录，获取新的 Cookie，仅重试一次防死循环
        const refreshSuccess = await this.refreshCookies();

        if (refreshSuccess) {
          if (taskData._retryCount) {
            console.log('[ZentaoBrowser] Cookie 已刷新但重试仍失败，放弃。');
            return { success: false, fallbackNeeded: true, reason: 'retry_failed' };
          }
          console.log('[ZentaoBrowser] Cookie 已刷新，重试创建任务');
          taskData._retryCount = 1;
          return await this.createTask(taskData);
        }

        console.log('[ZentaoBrowser] Cookie 刷新失败');
        return { success: false, fallbackNeeded: true, reason: 'not_logged_in' };
      }

      // 检查创建结果
      if (data && data.result === 'success' && data.locate) {
        console.log('[ZentaoBrowser] 任务创建成功，locate:', data.locate);

        // 如果是 .json 接口，locate 有时会带参数，也可能是重定向 URL
        let taskId = null;

        // 尝试多种正则模式提取任务ID
        const patterns = [
          /task[-_]view[-_]?(\d+)/,   // task-view-123
          /taskID=(\d+)/,             // taskID=123
          /tasks.*?id=(\d+)/,         // tasks?id=123
          /taskId[=:](\d+)/,          // taskId:123 或 taskId=123
          /["']id["']:\s*(\d+)/       // "id": 123 (从JSON中提取)
        ];

        // 注意：execution-task-{id}-xxx 中的 id 是执行ID，不是任务ID，不能直接使用
        // 如果 locate 是执行任务列表页，需要从页面中提取第一个任务ID

        for (const pattern of patterns) {
          const match = data.locate.match(pattern);
          if (match) {
            taskId = match[1];
            console.log('[ZentaoBrowser] ✓ 从 locate 提取到任务ID:', taskId, '模式:', pattern.source);
            break;
          }
        }

        if (taskId) {
          return { success: true, taskId: parseInt(taskId, 10) };
        }

        // 尝试解析 JSON 如果服务端直接返回 id（极少数情况）
        if (data.id) {
          const taskId = parseInt(data.id, 10);
          console.log('[ZentaoBrowser] ✓ 从响应中获取到任务ID:', taskId);
          return { success: true, taskId };
        }

        // 如果直接提取失败，尝试访问页面
        console.log('[ZentaoBrowser] 尝试从页面提取任务ID');
        taskId = await this.extractTaskIdFromHtml(data.locate);
        if (taskId) {
          const numericTaskId = parseInt(taskId, 10);
          console.log('[ZentaoBrowser] ✓ 从页面提取到任务ID:', numericTaskId);
          return { success: true, taskId: numericTaskId };
        }
      } else if (data && data.message) {
        console.warn('[ZentaoBrowser] 创建任务失败，提示:', data.message);
        // 作为 JSON 数组或者字符串对象解析出来给前端提示
        return { success: false, reason: typeof data.message === 'string' ? data.message : JSON.stringify(data.message) };
      }

      console.log('[ZentaoBrowser] 创建任务未返回有效结果', data);
      return { success: false, reason: 'unrecognized_response' };
    } catch (err) {
      console.warn('[ZentaoBrowser] 创建任务异常:', err.message);
      return { success: false, reason: err.message };
    }
  },

  /**
   * 从 HTML 页面提取任务ID
   */
  async extractTaskIdFromHtml(locatePath) {
    try {
      const cookieHeader = await this.getCookies();
      const headers = {};
      if (cookieHeader) {
        headers['Cookie'] = cookieHeader;
      }

      const response = await fetch(`${this.getBaseUrl()}${locatePath}`, {
        headers
      });

      if (!response.ok) {
        console.warn('[ZentaoBrowser] 获取任务列表页面失败:', response.status);
        return null;
      }

      const html = await response.text();

      // 尝试多种正则模式提取任务ID
      const patterns = [
        /<tr\s+data-id=['"](\d+)['"]/,           // data-id="123"
        /value=['"](\d+)['"].*?title=['"][^>]*>/,  // <option value="123" title="...">
        /<a\s+href=['"][^'"]*task[-_]view[-_](\d+)/, // task-view-123
        /\/task[-_]view[-_]?(\d+)/,               // /task-view-123
        /['"]taskId['"]:\s*(\d+)/,               // "taskId": 123
        /['"]id['"]:\s*['"]?(\d+)['"]?/          // "id": "123" 或 id: 123
      ];

      for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match && match[1]) {
          const taskId = parseInt(match[1], 10);
          console.log('[ZentaoBrowser] ✓ 从 HTML 提取到任务ID:', taskId, '模式:', pattern.source);
          return taskId;
        }
      }

      console.warn('[ZentaoBrowser] ✗ HTML 中未找到任务ID，尝试获取最新任务');

      // 后备方案：尝试获取该执行下的最新任务
      const executionId = locatePath.match(/execution-task-(\d+)-/)?.[1];
      if (executionId) {
        const latestTaskId = await this.getLatestTaskId(executionId);
        if (latestTaskId) {
          console.log('[ZentaoBrowser] ✓ 获取到最新任务ID:', latestTaskId);
          return parseInt(latestTaskId, 10);
        }
      }

      return null;
    } catch (err) {
      console.warn('[ZentaoBrowser] 提取任务ID异常:', err.message);
      return null;
    }
  },

  /**
   * 获取指定执行下的最新任务ID
   */
  async getLatestTaskId(executionId) {
    try {
      const baseUrl = this.getBaseUrl();
      const cookieHeader = await this.getCookies();
      const headers = { 'Cookie': cookieHeader };

      // 访问执行的任务列表页面
      const listUrl = `${baseUrl}/zentao/execution-task-${executionId}-unclosed-0-order_desc.html`;
      const response = await fetch(listUrl, { headers });

      if (!response.ok) {
        return null;
      }

      const html = await response.text();

      // 尝试从页面提取第一个任务ID
      const patterns = [
        /<tr\s+data-id=['"](\d+)['"]/,
        /value=['"](\d+)['"].*?title=['"][^>]*>/,
      ];

      for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match && match[1]) {
          return match[1];
        }
      }

      return null;
    } catch (err) {
      console.log('[ZentaoBrowser] 获取最新任务ID失败:', err.message);
      return null;
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
   */
  async editTask({ zentaoId, execution, name, pri }) {
    await this.initConfig();

    if (!this.isConfigured()) {
      return { success: false, reason: 'not_configured' };
    }

    const baseUrl = this.getBaseUrl();
    const username = this.config.username || 'admin';

    console.log('[ZentaoBrowser] 准备编辑禅道任务:', { zentaoId, execution, name, pri, username });

    try {
      // 通过 background.js 在禅道页面中执行
      const result = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'editZentaoTask',
          baseUrl,
          taskId: zentaoId,
          execution,
          name: name || '',
          pri: pri || 3,
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
   * 初始化执行选择器
   */
  async init() {
    const selectorWrapper = document.getElementById('executionSelectorWrapper');
    const refreshBtn = document.getElementById('refreshExecutionsBtn');
    const select = document.getElementById('executionSelect');

    if (!selectorWrapper) return;

    // 刷新按钮事件
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => this.refreshExecutions());
    }

    // 加载执行列表
    await this.loadExecutions();

    // 检查禅道是否已配置，如果已配置则显示选择器
    const config = await this.getZentaoConfig();
    if (config && config.enabled) {
      selectorWrapper.style.display = 'block';
    }
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
  currentMode: 'task', // 'task' or 'bug'

  init() {
    const tabButtons = document.querySelectorAll('.tab-btn');
    tabButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        this.switchMode(mode);
      });
    });
    // 恢复上次选择的标签页
    const lastMode = localStorage.getItem('lastTabMode') || 'task';
    this.switchMode(lastMode);
  },

  switchMode(mode) {
    this.currentMode = mode;

    // 1. 保存标签页选择
    localStorage.setItem('lastTabMode', mode);

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

    // 4.3 执行选择器在两种模式下都显示
    const executionSelectorWrapper = document.getElementById('executionSelectorWrapper');
    const executionLabel = document.querySelector('.execution-label');
    if (executionSelectorWrapper) {
      executionSelectorWrapper.style.display = '';
    }
    // 更新执行选择器标签
    if (executionLabel) {
      executionLabel.textContent = mode === 'bug' ? '所属执行:' : '所属执行:';
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
    if (mode === 'bug') {
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

      // 从后端获取禅道配置
      const configResponse = await fetch(`${API_BASE_URL}/api/zentao/config`);
      const configResult = await configResponse.json();

      if (!configResult.success || !configResult.data.url) {
        throw new Error('禅道未配置');
      }

      const zentaoUrl = configResult.data.url.replace(/\/$/, '');

      // 使用浏览器 cookie 调用禅道 API 获取执行列表
      const cookie = await this.getZentaoCookie(zentaoUrl);
      if (!cookie) {
        throw new Error('无法获取禅道会话，请先在浏览器中登录禅道');
      }

      // 调用禅道 API 获取执行列表
      // 先获取项目列表
      let projects = [];
      try {
        const projResp = await fetch(`${zentaoUrl}/zentao/project-browse-all-all--------.json`, {
          headers: { 'Cookie': cookie }
        });
        console.log('[ExecutionFavorites] 项目列表响应状态:', projResp.status);
        if (projResp.ok) {
          const projData = await projResp.json();
          console.log('[ExecutionFavorites] 项目列表原始数据:', projData);
          // 禅道返回的数据在 data 字段中，且是 JSON 字符串
          if (projData && projData.status === 'success' && projData.data) {
            try {
              const nested = JSON.parse(projData.data);
              console.log('[ExecutionFavorites] 解析后的数据键:', Object.keys(nested));
              if (Array.isArray(nested.projects)) {
                projects = nested.projects;
                console.log('[ExecutionFavorites] 获取到项目列表 (nested.projects):', projects.length);
              } else if (nested.projectStats && typeof nested.projectStats === 'object') {
                // projectStats 是一个对象 {id: projectInfo}
                projects = Object.values(nested.projectStats);
                console.log('[ExecutionFavorites] 获取到项目列表 (projectStats):', projects.length);
              } else if (Array.isArray(nested)) {
                projects = nested;
                console.log('[ExecutionFavorites] 获取到项目列表 (nested):', projects.length);
              } else {
                console.log('[ExecutionFavorites] 数据结构不匹配，projects:', nested.projects, 'nested:', nested);
              }
            } catch (parseErr) {
              console.error('[ExecutionFavorites] 解析项目数据失败:', parseErr);
            }
          } else if (projData && Array.isArray(projData.projects)) {
            projects = projData.projects;
            console.log('[ExecutionFavorites] 获取到项目列表 (直接):', projects.length);
          }
        }
      } catch (e) {
        console.error('[ExecutionFavorites] 获取项目列表失败:', e.message);
      }

      if (projects.length === 0) {
        throw new Error('未获取到项目列表');
      }

      console.log('[ExecutionFavorites] 开始遍历', projects.length, '个项目获取执行...');

      // 按项目分组存储执行
      const executionsByProject = {};

      // 先获取全局执行列表
      let allExecutionsData = null;
      try {
        // 使用之前成功的 execution-browse API
        const resp = await fetch(`${zentaoUrl}/zentao/execution-browse-all-all--------0-200-1.json`, {
          headers: { 'Cookie': cookie }
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data && data.status === 'success' && data.data) {
            const nested = JSON.parse(data.data);
            console.log('[ExecutionFavorites] execution-browse 数据键:', Object.keys(nested));

            // 尝试获取执行列表
            if (nested.executions && typeof nested.executions === 'object') {
              allExecutionsData = Object.entries(nested.executions).map(([id, name]) => ({
                id,
                name: name || `执行 ${id}`
              }));
            } else if (nested.executionStats && typeof nested.executionStats === 'object') {
              allExecutionsData = Object.entries(nested.executionStats).map(([id, name]) => ({
                id,
                name: name || `执行 ${id}`
              }));
            } else if (Array.isArray(nested.executionStats)) {
              allExecutionsData = nested.executionStats;
            } else if (Array.isArray(nested.executions)) {
              allExecutionsData = nested.executions;
            }
            console.log('[ExecutionFavorites] 获取到全局执行列表:', allExecutionsData?.length);
          }
        }
      } catch (e) {
        console.log('[ExecutionFavorites] 获取全局执行列表失败:', e.message);
      }

      if (!allExecutionsData || allExecutionsData.length === 0) {
        throw new Error('未找到执行数据');
      }

      // 创建项目 ID 到项目名称的映射
      const projectMap = {};
      projects.forEach(p => {
        projectMap[p.id] = p.name || p.title;
      });
      console.log('[ExecutionFavorites] 项目映射:', projectMap);

      // 对每个执行获取详情（包括项目信息）
      const batchSize = 10;
      for (let i = 0; i < allExecutionsData.length; i += batchSize) {
        const batch = allExecutionsData.slice(i, i + batchSize);
        const details = await Promise.all(batch.map(async (exec) => {
          try {
            const detailResp = await fetch(`${zentaoUrl}/zentao/execution-view-${exec.id}.json`, {
              headers: { 'Cookie': cookie }
            });
            if (detailResp.ok) {
              const detailData = await detailResp.json();
              if (detailData && detailData.status === 'success' && detailData.data) {
                const nested = JSON.parse(detailData.data);
                // 打印前几个执行的详情
                if (allExecutionsData.indexOf(exec) < 3) {
                  console.log(`[ExecutionFavorites] 执行 ${exec.id} 详情数据键:`, Object.keys(nested));
                  console.log(`[ExecutionFavorites] 执行 ${exec.id} nested.execution.type:`, nested.execution?.type);
                  console.log(`[ExecutionFavorites] 执行 ${exec.id} nested.type:`, nested.type);
                }
                // 正确处理 project 对象
                let projectName = '';
                let projectId = '';
                if (nested.project && typeof nested.project === 'object') {
                  projectId = nested.project.id || '';
                  projectName = projectId ? (projectMap[projectId] || nested.project.name || '') : '';
                } else if (typeof nested.project === 'string') {
                  projectName = nested.project;
                }
                if (!projectName && nested.projectID && projectMap[nested.projectID]) {
                  projectName = projectMap[nested.projectID];
                  projectId = nested.projectID;
                }
                // 关键：执行类型在 nested.execution.type 中，不是 nested.type
                const executionType = nested.execution?.type || 'execution';
                return {
                  id: exec.id,
                  name: exec.name,
                  projectName: projectName,
                  projectId: projectId,
                  status: nested.execution?.status || 'open',
                  // 执行类型: kanban, sprint, stage
                  type: executionType
                };
              }
            }
          } catch (e) {
            console.log(`[ExecutionFavorites] 执行 ${exec.id} 详情获取失败:`, e.message);
          }
          return null;
        }));

        details.forEach(detail => {
          if (detail && detail.projectName) {
            if (!executionsByProject[detail.projectName]) {
              executionsByProject[detail.projectName] = {
                project: null,
                executions: []
              };
            }
            executionsByProject[detail.projectName].executions.push(detail);
          }
        });

        console.log('[ExecutionFavorites] 已处理', Math.min(i + batchSize, allExecutionsData.length), '/', allExecutionsData.length);
      }

      console.log('[ExecutionFavorites] 共有', Object.keys(executionsByProject).length, '个项目有执行');

      if (Object.keys(executionsByProject).length === 0) {
        throw new Error('未找到执行数据，请尝试手动在禅道中打开执行列表页面');
      }

      // 将数据转换为扁平数组格式
      executions = [];
      Object.entries(executionsByProject).forEach(([projectName, data]) => {
        data.executions.forEach(exec => {
          if (exec) { // 确保 exec 不为 null
            executions.push({
              id: String(exec.id),
              name: exec.name || exec.title || `执行 ${exec.id}`,
              projectName: projectName,
              projectId: exec.projectId || data.project?.id || '',
              status: exec.status || 'open',
              // 关键：保留执行类型字段
              type: exec.type || 'execution'
            });
          }
        });
      });

      console.log('[ExecutionFavorites] 最终执行列表长度:', executions.length);
      console.log('[ExecutionFavorites] 执行类型分布:', executions.reduce((acc, ex) => {
        acc[ex.type] = (acc[ex.type] || 0) + 1;
        return acc;
      }, {}));

      // 格式化执行数据（已包含项目信息和类型）
      const formattedExecutions = executions.map(ex => {
        // 直接使用从 API 获取的准确 type 字段
        const executionType = ex.type || 'execution';

        return {
          id: ex.id,
          name: ex.name,
          projectName: ex.projectName,
          projectId: ex.projectId,
          productName: ex.productName || '',
          status: ex.status || 'open',
          type: executionType,  // 使用从 API 获取的执行类型: kanban, sprint, stage
          kanbanId: executionType === 'kanban' ? ex.id : null,  // 看板ID
          isDefault: ex.id === String(configResult.data.executionId)
        };
      });

      // 保存到后端
      console.log('[ExecutionFavorites] 准备保存到后端，执行数量:', formattedExecutions.length);
      console.log('[ExecutionFavorites] 执行类型分布:', formattedExecutions.reduce((acc, ex) => {
        acc[ex.type] = (acc[ex.type] || 0) + 1;
        return acc;
      }, {}));

      const saveResp = await fetch(`${API_BASE_URL}/api/executions/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ executions: formattedExecutions })
      });
      const saveResult = await saveResp.json();

      console.log('[ExecutionFavorites] 后端保存结果:', saveResult);

      if (saveResult.success) {
        this.executions = formattedExecutions;
        this.renderExecutionList();
        resultSpan.textContent = `已同步 ${formattedExecutions.length} 个执行`;
        resultSpan.style.color = 'var(--success)';
        Toast.success(`已同步 ${formattedExecutions.length} 个执行`);
      } else {
        throw new Error(saveResult.error || '保存失败');
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

  async getZentaoCookie(zentaoUrl) {
    return new Promise((resolve) => {
      chrome.cookies.get({ url: `${zentaoUrl}/zentao/`, name: 'zentaosid' }, (cookie) => {
        if (cookie && cookie.value) {
          resolve(`zentaosid=${cookie.value}`);
        } else {
          resolve(null);
        }
      });
    });
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

// 在设置弹窗打开时加载执行收藏
const originalSettingsBtn = document.getElementById('settingsBtn');
if (originalSettingsBtn) {
  originalSettingsBtn.addEventListener('click', () => {
    setTimeout(() => ExecutionFavorites.loadFavorites(), 100);
  });
}

// ==================== Bug 管理 ====================

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
      closeBtn.addEventListener('click', () => this.hideBugModal());
    }

    // 点击弹框外部关闭
    const bugModal = document.getElementById('bugModal');
    if (bugModal) {
      bugModal.addEventListener('click', (e) => {
        if (e.target === bugModal) {
          this.hideBugModal();
        }
      });
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
        this.bugs = result.data || [];
        console.log('[BugManager] 获取到的 Bug 数量:', this.bugs.length);

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
        console.log(`[BugManager] → Bug "${bug.title}" 渲染到已激活列`);
      } else if (bug.status === 'closed') {
        closedList.appendChild(card);
        closedCount++;
        console.log(`[BugManager] → Bug "${bug.title}" 渲染到已关闭列`);
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
    card.className = 'task-card bug-card';
    card.dataset.bugId = bug.id;

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
        assigneeDisplay = `<span class="bug-assignee">👤 ${escapeHtml(assigneeNames)}</span>`;
      }
      console.log('[BugManager] assigneeDisplay:', assigneeDisplay);
    }

    // Bug ID 显示和链接（直接在标题后面）
    let bugIdSuffix = '';
    let addBugIdBtn = '';
    if (bug.zentaoId) {
      bugIdSuffix = ` <a class="bug-id-link-inline" href="javascript:void(0)" data-bug-id="${bug.zentaoId}" title="点击查看禅道详情">#${bug.zentaoId}</a>`;
    } else {
      // 没有BugID时显示加号按钮
      addBugIdBtn = `<button class="bug-add-id-btn" title="添加禅道BugID" data-bug-id="${bug.id}">➕</button>`;
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
      </div>
      ${bug.projectName ? `<span class="execution-tag">${escapeHtml(bug.projectName)}</span>` : ''}
      ${assigneeDisplay ? `<div class="bug-meta">${assigneeDisplay}</div>` : ''}
      ${bug.comment ? `<div class="bug-comment-preview">${escapeHtml(bug.comment.substring(0, 50))}${bug.comment.length > 50 ? '...' : ''}</div>` : ''}
      <div class="bug-card-actions">
        ${quickActionButton}
      </div>
    `;

    // Bug ID 点击事件 - 跳转到禅道详情页面
    const bugIdLink = card.querySelector('.bug-id-link-inline');
    if (bugIdLink) {
      bugIdLink.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const zentaoBugId = bugIdLink.dataset.bugId;
        this.openBugDetailInZentao(zentaoBugId);
      });
    }

    // 添加 BugID 按钮事件
    const addIdBtn = card.querySelector('.bug-add-id-btn');
    if (addIdBtn) {
      addIdBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.showEditBugIdModal(bug.id, bug.zentaoId);
      });
    }

    // 添加右键事件
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.showBugDetail(bug.id);
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

  /**
   * 显示编辑 BugID 弹窗
   */
  showEditBugIdModal(bugId, currentZentaoId) {
    const bug = this.bugs.find(b => b.id === bugId);
    if (!bug) return;

    // 创建弹窗
    const modal = document.createElement('div');
    modal.id = 'editBugIdModal';
    modal.className = 'modal';
    modal.style.display = 'flex';
    modal.innerHTML = `
      <div class="modal-content" style="max-width: 400px; word-wrap: break-word; overflow-wrap: break-word;">
        <h3>编辑禅道 BugID</h3>
        <div style="margin-bottom: 16px; color: var(--text-secondary); word-break: break-all;">
          Bug标题: <strong>${escapeHtml(bug.title)}</strong>
        </div>
        <div style="margin-bottom: 16px;">
          <label style="display: block; margin-bottom: 8px; font-weight: 500;">禅道 BugID:</label>
          <input type="number" id="editBugZentaoIdInput" class="form-input" value="${currentZentaoId || ''}" placeholder="请输入禅道BugID" style="width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: 4px; font-size: 14px; box-sizing: border-box;">
          <small style="display: block; margin-top: 4px; color: var(--text-muted); word-break: break-all;">
            ${currentZentaoId ? '当前BugID: ' + currentZentaoId : '当前未关联禅道Bug'}
          </small>
        </div>
        <div style="display: flex; justify-content: flex-end; gap: 8px;">
          <button id="cancelEditBugIdBtn" class="btn-secondary">取消</button>
          <button id="saveEditBugIdBtn" class="btn-primary">保存</button>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // 取消按钮
    document.getElementById('cancelEditBugIdBtn').addEventListener('click', () => {
      document.body.removeChild(modal);
    });

    // 保存按钮
    document.getElementById('saveEditBugIdBtn').addEventListener('click', async () => {
      const input = document.getElementById('editBugZentaoIdInput');
      const newZentaoId = input.value.trim();

      if (!newZentaoId) {
        Toast.warning('请输入禅道BugID');
        return;
      }

      // 更新到后端
      try {
        const response = await fetch(`${API_BASE_URL}/api/bug/${bugId}/zentaoId`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ zentaoId: newZentaoId })
        });

        const result = await response.json();
        if (result.success) {
          // 更新本地数据
          bug.zentaoId = newZentaoId;
          bug.updatedAt = new Date().toISOString();

          // 重新渲染 Bug 卡片
          await this.loadBugs();

          document.body.removeChild(modal);
          Toast.success('BugID已更新');
        } else {
          Toast.error('更新失败: ' + (result.error || '未知错误'));
        }
      } catch (err) {
        console.error('[BugManager] 更新BugID失败:', err);
        Toast.error('更新失败: ' + err.message);
      }
    });

    // 点击背景关闭
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        document.body.removeChild(modal);
      }
    });

    // 输入框回车保存
    const input = document.getElementById('editBugZentaoIdInput');
    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        document.getElementById('saveEditBugIdBtn').click();
      }
    });

    // 自动聚焦并选中文本
    setTimeout(() => {
      input.focus();
      input.select();
    }, 100);
  },

  /**
   * 在禅道中打开 Bug 详情页面
   * @param {string|number} bugId - Bug ID
   */
  async openBugDetailInZentao(bugId) {
    try {
      const configResp = await fetch(`${API_BASE_URL}/api/zentao/config`);
      const configResult = await configResp.json();
      const baseUrl = configResult.data?.url?.replace(/\/$/, '');

      if (!baseUrl) {
        Toast.error('未配置禅道地址');
        return;
      }

      const bugDetailUrl = `${baseUrl}/zentao/bug-view-${bugId}.html`;

      // 使用 ZentaoTabManager 复用已存在的禅道标签页
      const tab = await ZentaoTabManager.getOrCreateTab({
        baseUrl,
        targetUrl: bugDetailUrl,
        active: true
      });

      console.log('[BugManager] 使用标签页', tab.id, '打开禅道 Bug 详情:', bugDetailUrl);
    } catch (error) {
      console.error('[BugManager] 打开 Bug 详情失败:', error);
      Toast.error('打开 Bug 详情失败');
    }
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
      await ZentaoBrowserClient.loadUsersFromTeamPage();
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
        });

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
    });

    // 点击其他地方关闭下拉
    document.addEventListener('click', (e) => {
      if (!container.contains(e.target)) {
        dropdown.style.display = 'none';
        display.classList.remove('active');
      }
    });

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
      let needRelogin = false;

      if (baseUrl) {
        // 检查是否有执行ID
        if (!executionId) {
          console.error('[BugManager] ✗ 缺少 executionId，无法创建Bug');
          Toast.error('缺少执行ID，无法创建Bug');
          return;
        }

        // 获取执行类型（判断是否为看板）
        let executionType = null;
        try {
          executionType = ExecutionFavorites.getExecutionType(executionId);
          console.log('[BugManager] 执行类型:', executionId, '=>', executionType);
        } catch (e) {
          console.warn('[BugManager] 获取执行类型失败:', e);
        }

        let syncResponse;

        if (executionType === 'kanban') {
          // ========== 看板执行 Bug 创建 ==========
          console.log('[BugManager] 使用看板逻辑创建 Bug');

          try {
            console.log('[BugManager] 尝试获取看板参数, executionId:', executionId);
            const kanbanParams = await ZentaoBrowserClient.getKanbanParamsFromHtml(executionId, 'bug', 'unconfirmed');

            if (!kanbanParams) {
              console.error('[BugManager] ✗ 无法获取看板参数');
              Toast.error('无法获取看板参数，请确保已打开禅道Bug看板页面');
              return;
            }

            console.log('[BugManager] 获取到看板参数:', kanbanParams);

            // ========== 严格参数验证：所有必需参数必须存在 ==========
            const requiredParams = ['productId', 'regionId', 'laneId', 'columnId'];
            const missingParams = requiredParams.filter(param => !kanbanParams[param]);

            if (missingParams.length > 0) {
              console.error('[BugManager] ✗ 看板参数不完整，缺少必需参数:', missingParams);
              console.error('[BugManager] 获取到的参数:', kanbanParams);
              Toast.error('看板参数获取失败，缺少: ' + missingParams.join(', ') + '。请刷新禅道页面后重试。');
              return;
            }

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
          } catch (e) {
            console.error('[BugManager] 获取看板参数异常:', e);
            Toast.error('获取看板参数失败: ' + e.message);
            return;
          }

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
        } else {
          // ========== 普通执行 Bug 创建 ==========
          console.log('[BugManager] 使用普通执行逻辑创建 Bug');

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
            console.error('[BugManager] ✗ 获取 productID 失败:', productIdResponse?.reason);
            Toast.error('获取 productID 失败: ' + (productIdResponse?.reason || '未知错误'));
            return;
          }

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
        } else if (syncResponse === null || syncResponse === undefined) {
          console.error('[BugManager] 禅道 Bug 同步响应为空，可能消息处理失败');
          Toast.error('禅道同步失败：未收到响应，请检查扩展是否正常工作');
          return;
        } else if (syncResponse && syncResponse.success !== undefined) {
          console.warn('[BugManager] 禅道 Bug 同步失败, success:', syncResponse.success, 'reason:', syncResponse.reason, 'data:', syncResponse.data);
          if (syncResponse.reason === 'no_zentao_tab') {
             Toast.error('未找到禅道标签页，请先在浏览器中登录禅道');
             return;
          } else if (typeof syncResponse.reason === 'string' && (syncResponse.reason.includes('超时') || syncResponse.reason.includes('登录'))) {
             needRelogin = true;
          } else {
             Toast.warning('禅道同步失败，将在本地保存 (' + (syncResponse.reason || '未知错误') + ')');
          }
        }
      }

      if (needRelogin) {
        console.log('[BugManager] 需要重新登录禅道');
        Toast.warning('禅道登录已超时，正在重新登录...');

        // 调用浏览器端的 ZentaoBrowser 刷新 Cookie
        if (typeof ZentaoBrowser !== 'undefined' && ZentaoBrowser.refreshCookies) {
          const refreshSuccess = await ZentaoBrowser.refreshCookies();
          if (refreshSuccess) {
            Toast.success('禅道登录成功，请重新提交 Bug');
            return;
          } else {
            Toast.error('禅道自动登录失败，请手动在浏览器标签页登录');
            return;
          }
        } else {
          Toast.error('请手动在浏览器中重新登录禅道标签页');
          return;
        }
      }
    } catch (syncError) {
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

        Toast.success('Bug 已创建');
        this.clearDraft();
        this.hideBugModal();
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
    if (!confirm('确定要删除所有 Bug 卡片吗？此操作不可恢复！')) {
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

    const severityText = ['', '致命', '严重', '一般', '提示'][bug.severity || 3];
    const statusText = { unconfirmed: '未确认', activated: '已确认', closed: '已解决' }[bug.status] || bug.status;

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

    content.innerHTML = `
      <div style="margin-bottom: 16px;">
        ${bug.projectName ? `<p style="margin: 4px 0; font-size: 13px; color: var(--text-secondary);">项目: ${escapeHtml(bug.projectName)}</p>` : ''}
        <p style="margin: 8px 0 4px 0; font-size: 13px; font-weight: 500;">标题: ${escapeHtml(bug.title)}</p>
        ${bug.zentaoId ? `<p style="margin: 4px 0; font-size: 13px; color: var(--text-secondary);">禅道BugID: <span class="bug-detail-zentao-id">${escapeHtml(bug.zentaoId)}</span></p>` : '<p style="margin: 4px 0; font-size: 13px; color: var(--text-muted);">禅道BugID: 未关联</p>'}
        ${bug.steps ? `
          <div style="margin-top: 12px;">
            <p style="margin: 0 0 8px 0; font-size: 13px; font-weight: 500;">重现步骤:</p>
            <div style="padding: 12px; background: var(--bg-secondary); border-radius: 6px;">
              <p style="margin: 0; font-size: 13px; white-space: pre-wrap;">${escapeHtml(bug.steps)}</p>
            </div>
          </div>
        ` : ''}
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
        <div style="margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border);">
          ${assigneeText ? `<p style="margin: 4px 0; font-size: 13px; color: var(--text-secondary);">指派人: ${escapeHtml(assigneeText)}</p>` : ''}
          ${bug.assignedDate ? `<p style="margin: 4px 0; font-size: 13px; color: var(--text-secondary);">指派时间: ${escapeHtml(bug.assignedDate)}</p>` : ''}
          ${ccText ? `<p style="margin: 4px 0; font-size: 13px; color: var(--text-secondary);">抄送人: ${escapeHtml(ccText)}</p>` : ''}
        </div>
      </div>
    `;

    // 清空并重新创建按钮，避免 CSP 问题
    actions.innerHTML = '';

    // 编辑 BugID 按钮（始终显示）
    const editBugIdBtn = document.createElement('button');
    editBugIdBtn.className = 'btn-secondary';
    editBugIdBtn.textContent = '编辑BugID';
    editBugIdBtn.onclick = () => this.showEditBugIdModal(bugId, bug.zentaoId);
    actions.appendChild(editBugIdBtn);

    if (bug.status === 'unconfirmed') {
      const activateBtn = document.createElement('button');
      activateBtn.className = 'btn-primary';
      activateBtn.textContent = '确认';
      activateBtn.style.marginLeft = '8px';
      activateBtn.onclick = () => this.activateBug(bugId);
      actions.appendChild(activateBtn);

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn-danger';
      deleteBtn.textContent = '删除';
      deleteBtn.style.marginLeft = '8px';
      deleteBtn.onclick = () => this.deleteBug(bugId);
      actions.appendChild(deleteBtn);
    } else if (bug.status === 'activated') {
      const resolveBtn = document.createElement('button');
      resolveBtn.className = 'btn-primary';
      resolveBtn.textContent = '已解决';
      resolveBtn.style.marginLeft = '8px';
      resolveBtn.onclick = () => this.showResolveModal(bugId);
      actions.appendChild(resolveBtn);

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn-danger';
      deleteBtn.textContent = '删除';
      deleteBtn.style.marginLeft = '8px';
      deleteBtn.onclick = () => this.deleteBug(bugId);
      actions.appendChild(deleteBtn);
    } else {
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn-danger';
      deleteBtn.textContent = '删除';
      deleteBtn.style.marginLeft = '8px';
      deleteBtn.onclick = () => this.deleteBug(bugId);
      actions.appendChild(deleteBtn);
    }

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

    // 设置默认指派人（使用 Bug 的指派人）
    if (bug.assignedTo && bug.assignedTo !== '') {
      const assigneeDisplay = document.getElementById('resolveAssigneeDisplay');
      if (assigneeDisplay) {
        // 获取用户列表
        const users = await ZentaoBrowserClient.getUsers();

        let userAccount = bug.assignedTo;
        let displayName = bug.assignedTo;
        let foundValidAccount = false;

        // 如果 assignedTo 是账号
        if (users && users[bug.assignedTo]) {
          displayName = users[bug.assignedTo];
          foundValidAccount = true;
        } else {
          // 如果 assignedTo 是姓名（包含中文），尝试反向查找账号
          if (/[\u4e00-\u9fa5]/.test(bug.assignedTo)) {
            console.log('[BugManager] assignedTo 是姓名，尝试反向查找账号:', bug.assignedTo);
            const foundAccount = Object.keys(users).find(account => users[account] === bug.assignedTo);
            if (foundAccount) {
              userAccount = foundAccount;
              foundValidAccount = true;
              console.log('[BugManager] 找到账号:', foundAccount);
            } else {
              // 如果找不到账号，使用姓名作为显示文本，但设置 dataset.value 为空
              console.log('[BugManager] 未找到对应账号，使用姓名');
              assigneeDisplay.dataset.value = '';
              assigneeDisplay.innerHTML = `<span class="multi-select-tag"><span class="multi-select-tag-name">${displayName}</span></span>`;
            }
          } else {
            // 不是中文也不是账号中的用户，直接使用
            foundValidAccount = true;
          }
        }

        // 只有找到有效账号时才设置显示值
        if (foundValidAccount) {
          assigneeDisplay.dataset.value = userAccount;
          assigneeDisplay.innerHTML = `<span class="multi-select-tag"><span class="multi-select-tag-name">${displayName}</span></span>`;
        }
      }
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

    // 重置表单
    document.getElementById('activatePri').value = '3';
    document.getElementById('activateType').value = 'codeerror';
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

    // 设置默认指派人（使用 Bug 创建时的指派人）
    if (bug.assignedTo && bug.assignedTo !== '') {
      const assigneeDisplay = document.getElementById('activateAssigneeDisplay');
      if (assigneeDisplay) {
        // 获取用户列表
        const users = await ZentaoBrowserClient.getUsers();

        let userAccount = bug.assignedTo;
        let displayName = bug.assignedTo;
        let foundValidAccount = false;

        // 如果 assignedTo 是账号
        if (users && users[bug.assignedTo]) {
          displayName = users[bug.assignedTo];
          foundValidAccount = true;
        } else {
          // 如果 assignedTo 是姓名（包含中文），尝试反向查找账号
          if (/[\u4e00-\u9fa5]/.test(bug.assignedTo)) {
            console.log('[BugManager] assignedTo 是姓名，尝试反向查找账号:', bug.assignedTo);
            const foundAccount = Object.keys(users).find(account => users[account] === bug.assignedTo);
            if (foundAccount) {
              userAccount = foundAccount;
              foundValidAccount = true;
              console.log('[BugManager] 找到账号:', foundAccount);
            } else {
              // 如果找不到账号，使用姓名作为显示文本，但设置 dataset.value 为空
              console.log('[BugManager] 未找到对应账号，使用姓名');
              assigneeDisplay.dataset.value = '';
              assigneeDisplay.innerHTML = `<span class="multi-select-tag"><span class="multi-select-tag-name">${displayName}</span></span>`;
            }
          } else {
            // 不是中文也不是账号中的用户，直接使用
            foundValidAccount = true;
          }
        }

        // 只有找到有效账号时才设置显示值
        if (foundValidAccount) {
          assigneeDisplay.dataset.value = userAccount;
          assigneeDisplay.innerHTML = `<span class="multi-select-tag"><span class="multi-select-tag-name">${displayName}</span></span>`;
        }
      }
    }

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
      await ZentaoBrowserClient.loadUsersFromTeamPage();
      users = await ZentaoBrowserClient.getUsers();
      console.log('[BugManager] 从禅道加载后用户数量:', Object.keys(users).length);
    } else if (userCount < 5) {
      // 用户列表数量太少，可能是加载不完整，尝试重新加载
      console.warn('[BugManager] 用户列表数量过少(', userCount, '个)，可能加载不完整，尝试重新加载...');
      await ZentaoBrowserClient.loadUsersFromTeamPage();
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
      await ZentaoBrowserClient.loadUsersFromTeamPage();
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
      });

      optionsContainer.appendChild(option);
    });

    // 显示/隐藏下拉列表
    display.addEventListener('click', (e) => {
      dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
      display.classList.toggle('active', dropdown.style.display !== 'none');
    });

    // 点击其他地方关闭下拉
    document.addEventListener('click', (e) => {
      if (!container.contains(e.target)) {
        dropdown.style.display = 'none';
        display.classList.remove('active');
      }
    });

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
        });

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
          });

          display.appendChild(tag);
        });
      }
    };

    // 显示/隐藏下拉列表
    display.addEventListener('click', (e) => {
      dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
      display.classList.toggle('active', dropdown.style.display !== 'none');
    });

    // 点击其他地方关闭下拉
    document.addEventListener('click', (e) => {
      if (!container.contains(e.target)) {
        dropdown.style.display = 'none';
        display.classList.remove('active');
      }
    });

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
    try {
      const config = await ZentaoBrowserClient.initConfig();
      const baseUrl = config?.url?.replace(/\/$/, '');
      if (!baseUrl) {
        console.warn('[BugManager] 无法获取 baseUrl');
        return null;
      }

      // 使用 ZentaoTabManager 复用已存在的禅道标签页获取 Bug 详情
      const bugDetailUrl = `${baseUrl}/zentao/bug-view-${zentaoBugId}.html`;
      const tab = await ZentaoTabManager.getOrCreateTab({
        baseUrl,
        targetUrl: bugDetailUrl,
        active: false
      });

      // 注入脚本提取 Bug 详情
      const results = await ZentaoTabManager.executeScript(tab, () => {
        // 提取指派人
        const assignedToElement = document.querySelector('#openedBy');
        const assignedTo = assignedToElement ? assignedToElement.value.trim() : '';

        // 提取抄送人列表
        const ccList = [];
        const ccElements = document.querySelectorAll('input[name="cc[]"]');
        ccElements.forEach(element => {
          if (element.value) {
            ccList.push(element.value.trim());
          }
        });

        return {
          assignedTo,
          cc: ccList
        };
      });

      // 不关闭标签页，因为它是复用的已存在的标签页

      if (results && results.length > 0 && results[0].result) {
        console.log('[BugManager] 从禅道获取到 Bug 详情:', results[0].result);
        return results[0].result;
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

    Toast.info('正在确认 Bug...');

    try {
      const configResp = await fetch(`${API_BASE_URL}/api/zentao/config`);
      const configResult = await configResp.json();
      const baseUrl = configResult.data?.url?.replace(/\/$/, '');

      if (!baseUrl) {
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

    Toast.info('正在解决 Bug...');

    try {
      const configResp = await fetch(`${API_BASE_URL}/api/zentao/config`);
      const configResult = await configResp.json();
      const baseUrl = configResult.data?.url?.replace(/\/$/, '');

      if (!baseUrl) {
        Toast.error('禅道未配置');
        return;
      }

      // 构造看板页面 URL
      const kanbanUrl = `${baseUrl}/zentao/execution-kanban-${bug.executionId}-bug.html`;

      // 调用 background.js 修复 Bug（使用看板页面）
      const response = await chrome.runtime.sendMessage({
        action: 'resolveBugInZentao',
        baseUrl,
        kanbanUrl,
        bugId: bug.zentaoId,
        resolution,
        assignedTo,
        comment
      });

      if (response && response.success) {
        Toast.success('Bug 已修复');
        // 更新本地 Bug 状态和数据
        await this.updateBugStatus(bugId, 'closed', {
          assignedTo,
          cc: [],  // 修复时没有抄送人字段
          comment,
          author: '当前用户'  // TODO: 获取真实用户名
        });
        this.hideResolveModal();
        this.hideBugDetail(); // 同时关闭详情弹窗
      } else {
        Toast.error('解决失败: ' + (response?.reason || '未知错误'));
      }
    } catch (err) {
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

    Toast.info('正在关闭 Bug...');

    try {
      const configResp = await fetch(`${API_BASE_URL}/api/zentao/config`);
      const configResult = await configResp.json();
      const baseUrl = configResult.data?.url?.replace(/\/$/, '');

      if (!baseUrl) {
        Toast.error('禅道未配置');
        return;
      }

      // 调用 background.js 关闭 Bug
      const response = await chrome.runtime.sendMessage({
        action: 'closeBugInZentao',
        baseUrl,
        bugId: bug.zentaoId,
        comment
      });

      if (response && response.success) {
        Toast.success('Bug 已关闭');
        // 从列表中移除该 Bug
        await this.removeBug(bugId);
        this.hideCloseModal();
        this.hideBugDetail(); // 同时关闭详情弹窗
      } else {
        Toast.error('关闭失败: ' + (response?.reason || '未知错误'));
      }
    } catch (err) {
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

    const confirmDelete = confirm('确定要删除这个 Bug 吗？此操作将同时删除禅道中的 Bug。');
    if (!confirmDelete) return;

    Toast.info('正在删除 Bug...');

    try {
      // 如果有禅道 ID，先删除禅道中的 Bug
      if (bug.zentaoId) {
        const configResp = await fetch(`${API_BASE_URL}/api/zentao/config`);
        const configResult = await configResp.json();
        const baseUrl = configResult.data?.url?.replace(/\/$/, '');

        if (baseUrl) {
          // 获取 regionId（如果有）
          const regionId = bug.regionId || '0';

          const response = await chrome.runtime.sendMessage({
            action: 'deleteBugInZentao',
            baseUrl,
            bugId: bug.zentaoId,
            regionId
          });

          if (!response || !response.success) {
            Toast.warning('禅道 Bug 删除失败，但将删除本地记录');
          }
        }
      }

      // 删除本地 Bug
      const deleteResp = await fetch(`${API_BASE_URL}/api/bug/${bugId}`, {
        method: 'DELETE'
      });
      const deleteResult = await deleteResp.json();

      if (deleteResult.success) {
        Toast.success('Bug 已删除');
        this.hideBugDetail();
        await this.loadBugs();
      } else {
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

// 测试获取看板参数（通过直接打开禅道标签页）
// 用法: testGetKanbanParamsSimple(148)
window.testGetKanbanParamsSimple = async function(executionId = 148) {
  console.log('==================== 测试获取看板参数（简化版）====================');

  try {
    // 获取禅道配置
    const configResp = await fetch(`${API_BASE_URL}/api/zentao/config`);
    const configResult = await configResp.json();

    if (!configResult.success || !configResult.data || !configResult.data.url) {
      console.error('[Test] 禅道未配置');
      return;
    }

    const config = configResult.data;
    const baseUrl = config.url.replace(/\/$/, '');
    const kanbanUrl = `${baseUrl}/zentao/execution-kanban-${executionId}.html`;

    console.log('[Test] 将打开禅道标签页:', kanbanUrl);
    console.log('[Test] 请在新打开的标签页控制台中运行以下代码获取参数:');
    console.log('');
    console.log('```');
    console.log('// 获取 regionId');
    console.log('const regionId = document.querySelector(".region")?.getAttribute("data-id");');
    console.log('console.log("regionId:", regionId);');
    console.log('');
    console.log('// 获取 laneId (任务)');
    console.log('const lanes = document.querySelectorAll(".kanban-lane");');
    console.log('let laneId; for (const lane of lanes) { const name = lane.querySelector(".kanban-lane-name"); if (name?.getAttribute("title") === "任务") { laneId = lane.getAttribute("data-id"); break; } }');
    console.log('console.log("laneId:", laneId);');
    console.log('');
    console.log('// 获取 columnId (未开始)');
    console.log('const columnId = document.querySelector(".kanban-col[data-type=\\"wait\\"]")?.getAttribute("data-id");');
    console.log('console.log("columnId:", columnId);');
    console.log('```');
    console.log('');
    console.log('[Test] 正在打开禅道标签页...');

    // 使用 ZentaoTabManager 复用已存在的禅道标签页
    const newTab = await ZentaoTabManager.getOrCreateTab({
      baseUrl: configResult.data.url,
      targetUrl: kanbanUrl,
      active: true
    });

    console.log('[Test] ✓ 标签页已打开，ID:', newTab.id);
    console.log('[Test] 请切换到新标签页，在控制台中运行上面的代码');
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
document.addEventListener('DOMContentLoaded', () => {
  BugManager.init();
  ExecutionFavorites.init();
  TabSwitcher.init();
});

// 如果 DOM 已经加载完成，立即初始化
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  BugManager.init();
  ExecutionFavorites.init();
  TabSwitcher.init();
}
