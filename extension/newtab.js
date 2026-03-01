// API配置
let API_BASE_URL = 'http://localhost:3721';

// 当前状态
let currentYear, currentMonth;
let selectedDate = null;
let allTasks = [];
let selectedTaskId = null;  // 当前选中的任务ID（用于键盘删除）

// 调试模式状态
let debugMode = false;

// 进度条拖拽状态
let draggingProgressTask = null; // 正在拖拽的任务 ID
let draggingProgressElement = null; // 正在拖拽的进度条元素

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
    this.consumedInput.placeholder = placeholderConsumed || '如: 1.5';

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

      // 支持回车提交
      const handleKeyPress = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
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

// 报告状态：存储最后一次生成的报告ID
let lastReports = {
  daily: null,
  weekly: null,
  monthly: null
};

// ==================== 进度条拖拽处理 ====================

/**
 * 设置进度条拖拽的全局事件
 */
function setupProgressDragEvents() {
  // 根据鼠标位置更新进度显示（不提交）
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

  // 鼠标移动事件
  document.addEventListener('mousemove', (e) => {
    if (draggingProgressTask) {
      e.preventDefault();
      updateProgressFromMouse(e);
    }
  });

  // 鼠标释放事件
  document.addEventListener('mouseup', async (e) => {
    if (draggingProgressTask) {
      const { progressTrack } = draggingProgressElement;
      const rect = progressTrack.getBoundingClientRect();
      const percent = Math.round(((e.clientX - rect.left) / rect.width) * 100);
      const clampedPercent = Math.max(0, Math.min(100, percent));

      // 重置状态
      document.body.style.cursor = '';
      if (progressTrack) progressTrack.style.cursor = 'pointer';

      // 保存任务 ID 并重置拖拽状态
      const taskId = draggingProgressTask;
      draggingProgressTask = null;
      draggingProgressElement = null;

      // 提交进度更新
      await updateTaskProgress(taskId, clampedPercent);
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

  document.addEventListener('touchend', async (e) => {
    if (draggingProgressTask) {
      const touch = e.changedTouches[0];
      const { progressTrack } = draggingProgressElement;
      const rect = progressTrack.getBoundingClientRect();
      const percent = Math.round(((touch.clientX - rect.left) / rect.width) * 100);
      const clampedPercent = Math.max(0, Math.min(100, percent));

      // 重置状态
      document.body.style.cursor = '';
      if (progressTrack) progressTrack.style.cursor = 'pointer';

      // 保存任务 ID 并重置拖拽状态
      const taskId = draggingProgressTask;
      draggingProgressTask = null;
      draggingProgressElement = null;

      // 提交进度更新
      await updateTaskProgress(taskId, clampedPercent);
    }
  });
}

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
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
  document.getElementById('taskInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      // 正在使用输入法拼音选词的时候按下回车不应该触发添加
      if (e.isComposing || e.keyCode === 229) {
        return;
      }

      if (!e.shiftKey) {
        e.preventDefault();
        addTask();
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
      console.error('获取提示词失败:', err);
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
      console.error('保存提示词失败:', err);
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
        console.error('[前端] 保存配置失败:', result.error);
      }
    } catch (err) {
      console.error('同步配置失败:', err);
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
        console.error('[前端] 禅道配置保存失败:', result.error);
      }
    } catch (err) {
      console.error('同步禅道配置失败:', err);
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
    console.error(`[前端] ${taskName}执行出错:`, err.message);
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
    console.error('检查报告状态失败:', err);
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

    const response = await fetch(`${API_BASE_URL}/api/report/generate/${type}`, { method: 'POST' });
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
    console.error('加载日历失败:', err);
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
    console.error('加载任务失败:', err);
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
    console.error('加载任务失败:', err);
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
      <span style="flex:1;" class="task-title-text" data-task-id="${task.id}">
        ${escapeHtml(task.title)}
        ${task.zentaoId ? `<a href="${getZentaoTaskUrl(task.zentaoId)}" target="_blank" class="zentao-link" style="margin-left: 6px; color: #3b82f6; text-decoration: none; font-size: 12px;">#${task.zentaoId}</a>` : ''}
      </span>
      <button class="task-title-edit-btn" data-task-id="${task.id}" style="background:none; border:none; cursor:pointer; color:#9ca3af; font-size:14px; padding:2px 4px; opacity:0; transition:opacity 0.2s;" title="编辑标题">✏️</button>
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
      const newProgress = e.target.checked ? 100 : 0;
      const originalChecked = e.target.checked;

      // 调用更新进度，如果用户取消则恢复复选框状态
      const result = await updateTaskProgress(task.id, newProgress);

      // updateTaskProgress 返回 false 表示用户取消
      if (result === false) {
        e.target.checked = !originalChecked; // 恢复原始状态
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

  if (progressTrack && progressFill) {
    // 鼠标按下开始拖拽
    progressTrack.addEventListener('mousedown', (e) => {
      draggingProgressTask = task.id;
      draggingProgressElement = { progressTrack, progressFill, progressInput };
      e.stopPropagation();
      document.body.style.cursor = 'ew-resize';
      progressTrack.style.cursor = 'ew-resize';
      updateProgressFromMouse(e);
    });
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

  // 绑定标题编辑按钮事件
  const titleEditBtn = card.querySelector('.task-title-edit-btn');
  const titleText = card.querySelector('.task-title-text');
  if (titleEditBtn && titleText) {
    // 鼠标悬停显示编辑按钮
    card.addEventListener('mouseenter', () => {
      titleEditBtn.style.opacity = '1';
    });
    card.addEventListener('mouseleave', () => {
      titleEditBtn.style.opacity = '0';
    });

    titleEditBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      updateTaskTitle(task.id);
    });
  }

  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showTaskDetail(task);
  });

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
    console.error('获取统计数据失败:', err);
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
  if (isAddingTask) return;

  const input = document.getElementById('taskInput');
  const btn = document.getElementById('addTaskBtn');
  const content = input.value.trim();

  if (!content) {
    Toast.warning('请输入任务内容');
    return;
  }

  isAddingTask = true;
  const originalVal = content;

  // 立即清空输入框，防止用户觉得自己没触发，并显示提示
  input.value = '';
  input.disabled = true;
  if (btn) btn.disabled = true;
  const originalPlaceholder = input.placeholder;
  input.placeholder = '✨ AI 正在努力分析并提取任务属性，请稍候...';

  // 浏览器端禅道任务 ID（如果成功创建）
  let browserZentaoId = null;

  try {
    // 第一步：调用服务端 API 获取 AI 提取的任务数据
    const response = await fetch(`${API_BASE_URL}/api/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content
      })
    });

    const result = await response.json();

    if (result.success) {
      // AI 提取的任务标题
      const aiTitle = result.data?.title || result.data?.content || content;
      console.log('[AddTask] AI 提取的标题:', aiTitle);

      // 第二步：尝试在浏览器端创建禅道任务（使用 AI 提取的标题）
      try {
        await ZentaoBrowserClient.initConfig();
        if (ZentaoBrowserClient.isConfigured()) {
          console.log('[AddTask] 尝试使用浏览器端创建禅道任务...');
          const zentaoResult = await ZentaoBrowserClient.createTask({
            title: aiTitle,
            content: content,
            dueDate: null
          });

          if (zentaoResult.success && zentaoResult.taskId) {
            browserZentaoId = zentaoResult.taskId;
            console.log('[AddTask] 浏览器端创建禅道任务成功:', browserZentaoId);
          } else {
            console.log('[AddTask] 浏览器端创建禅道任务失败:', zentaoResult.reason);
          }
        }
      } catch (err) {
        console.log('[AddTask] 浏览器端创建禅道任务出错:', err.message);
      }

      // 更新任务的 zentaoId（如果禅道端创建成功）
      if (browserZentaoId) {
        // 获取 executionId 用于后续编辑操作
        const executionId = ZentaoBrowserClient.config.createTaskUrl || '';

        // 使用通用更新接口更新 zentaoId 和 zentaoExecution
        const updateResp = await fetch(`${API_BASE_URL}/api/task/${result.data.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            zentaoId: browserZentaoId,
            zentaoExecution: executionId
          })
        });
        if (updateResp.ok) {
          console.log('[AddTask] zentaoId 和 zentaoExecution 已保存到任务:', browserZentaoId, executionId);
        } else {
          console.error('[AddTask] 保存 zentaoId 失败:', updateResp.status);
        }
      }

      // 检查 AI 分析出的任务进度，如果有进度则同步到禅道
      const taskProgress = result.data?.progress || 0;
      if (browserZentaoId && taskProgress > 0) {
        console.log('[AddTask] 任务有初始进度，准备同步到禅道:', taskProgress + '%');

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
            await ZentaoBrowserClient.updateTaskStatus(browserZentaoId, status, taskProgress);
            console.log('[AddTask] 禅道任务状态已更新为:', status);

            // 记录工时到禅道
            if (consumedTime > 0 || progressComment) {
              const effortResult = await ZentaoBrowserClient.recordEffort(browserZentaoId, progressComment, consumedTime, leftTime);
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
    console.error('添加任务错误:', err);
  } finally {
    isAddingTask = false;
    input.disabled = false;
    input.placeholder = originalPlaceholder;
    if (btn) btn.disabled = false;
    input.focus();
  }
}

// 更新任务进度
async function updateTaskProgress(taskId, progress) {
  try {
    // 获取任务信息，用于弹窗提示
    const task = allTasks.find(t => t.id === taskId);
    if (!task) return;

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
    }

    // 第一步：尝试在浏览器端更新禅道任务状态（如果有 zentaoId）
    if (task.zentaoId) {
      try {
        // 根据进度确定状态
        let status = 'todo';
        if (progress > 0 && progress < 100) status = 'in_progress';
        else if (progress === 100) status = 'done';

        const zentaoResult = await ZentaoBrowserClient.updateTaskStatus(task.zentaoId, status, progress);
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

          const effortResult = await ZentaoBrowserClient.recordEffort(task.zentaoId, progressComment, consumedTime, leftTime);
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
      // 只重新渲染任务列表，不重新加载
      await loadTasks();
      return true;
    } else {
      console.error('更新进度失败:', result.error);
      return false;
    }
  } catch (err) {
    console.error('更新进度失败:', err);
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
      console.error('更新优先级失败:', result.error);
    }
  } catch (err) {
    console.error('更新优先级失败:', err);
  }
}

// 更新任务标题
async function updateTaskTitle(taskId) {
  const task = allTasks.find(t => t.id === taskId);
  if (!task) return;

  // 使用简单的 prompt 获取新标题
  const newTitle = prompt('编辑任务标题:', task.title);
  if (newTitle === null || newTitle.trim() === '') {
    return; // 用户取消或输入为空
  }

  const trimmedTitle = newTitle.trim();

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
      console.error('更新标题失败:', result.error);
      Toast.error('更新失败');
    }
  } catch (err) {
    console.error('更新标题失败:', err);
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
  const task = allTasks.find(t => t.id === taskId);

  if (!task) return;

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
    console.error('删除任务错误:', err);
  }
}

// 处理任务操作
async function handleTaskAction(taskId, action) {
  try {
    if (action === 'delete') {
      const confirmed = await showConfirm('删除任务', '确定要删除这个任务吗？');
      if (!confirmed) return;

      // 获取任务信息（需要 zentaoId 和 executionId）
      const task = allTasks.find(t => t.id === taskId);
      if (!task) return;

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
    console.error('处理任务操作错误:', err);
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
    console.error('搜索失败:', err);
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

  body.innerHTML = `
    <div style="margin-bottom: 16px;">
      <div style="display:flex; align-items:center; gap:12px; margin-bottom:12px;">
        <h4 style="margin:0; flex:1;">${escapeHtml(task.title)}</h4>
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
    console.error('加载历史失败:', err);
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
      console.error('更新时间失败:', err);
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
async function regenerateReport(_oldReportId, type, btnElement) {
  const typeNames = { daily: '日报', weekly: '周报', monthly: '月报' };
  const confirmed = await showConfirm('重新生成报告', `确定要重新生成${typeNames[type]}吗？这将使用相同的时间范围。`, '重新生成', '取消');
  if (!confirmed) {
    return;
  }

  const originalText = btnElement.textContent;
  btnElement.textContent = '生成中...';
  btnElement.disabled = true;

  try {
    const response = await fetch(`${API_BASE_URL}/api/report/generate/${type}`, { method: 'POST' });
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
  const updates = [];
  let indexCounter = 0;

  ['todoList', 'inProgressList', 'doneList'].forEach(listId => {
    const listStatus = listId === 'todoList' ? 'todo' : (listId === 'inProgressList' ? 'in_progress' : 'done');
    const cards = document.getElementById(listId).querySelectorAll('.task-card');

    cards.forEach(card => {
      const taskId = card.dataset.taskId;
      const task = allTasks.find(t => t.id === taskId);
      if (!task) return;

      let newProgress = task.progress;
      let newStatus = listStatus;

      if (task.status !== newStatus) {
        if (newStatus === 'in_progress') newProgress = 10;
        else if (newStatus === 'done') newProgress = 100;
        else if (newStatus === 'todo') newProgress = 0;
      }

      updates.push({
        id: taskId,
        order: indexCounter++,
        status: newStatus,
        progress: newProgress
      });

      task.status = newStatus;
      task.progress = newProgress;
      task.order = updates[updates.length - 1].order;
    });
  });

  if (updates.length > 0) {
    try {
      await fetch(`${API_BASE_URL}/api/tasks/batch`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates })
      });
      renderTasks();
      // 这里也一并更新左侧状态面板的数据
      updateCounts();

      // 触发同步
      triggerSync();
    } catch (err) {
      console.error('批量更新状态失败:', err);
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
      console.error('[ZentaoBrowser] 获取配置失败:', err);
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
            console.error('[ZentaoBrowser] 后台通信失败:', chrome.runtime.lastError);
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
            console.error('[ZentaoBrowser] 后台注入登录失败:', response?.error);
            if (this.config._isManualTest) Toast.error('禅道登录失败: ' + (response?.error || ''));
            resolve(false);
          }
        });
      });
    } catch (err) {
      console.error('[ZentaoBrowser] 登录异常:', err.message);
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

        // 直接检查浏览器中的禅道 session cookie（zentaosid）
        chrome.cookies.get({ url: url, name: 'zentaosid' }, (cookie) => {
          if (chrome.runtime.lastError) {
            console.error('[ZentaoBrowser] 检查 cookie 失败:', chrome.runtime.lastError.message);
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
        console.error('[ZentaoBrowser] 验证 session 失败:', err.message);
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
      console.error('[ZentaoBrowser] 刷新 Cookie 失败:', err.message);
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
      console.error('[ZentaoBrowser] 会话保活检查失败:', err.message);
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
            console.error('[ZentaoBrowser] 获取 cookies 失败:', chrome.runtime.lastError.message);
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
        console.error('[ZentaoBrowser] 获取 cookies 异常:', err.message);
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
      console.error('[ZentaoBrowser] 获取 session token 失败:', err);
    }
    return null;
  },

  /**
   * 创建任务
   */
  async createTask(taskData) {
    await this.initConfig();

    if (!this.isConfigured()) {
      console.log('[ZentaoBrowser] 禅道未配置或不完整');
      return { success: false, reason: 'not_configured' };
    }

    // createTaskUrl 现在直接存储 execution ID（如 167）
    const executionId = this.config.createTaskUrl || '';
    if (!executionId || executionId === '0') {
      console.error('[ZentaoBrowser] 未配置 execution ID:', executionId);
      return { success: false, reason: 'invalid_execution_id' };
    }
    const username = this.config.username || 'admin';
    const baseUrl = this.getBaseUrl();

    console.log('[ZentaoBrowser] 准备创建任务:', taskData.title);

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
            console.error('[ZentaoBrowser] Background 通信失败:', chrome.runtime.lastError.message);
            resolve({ success: false, reason: 'background_error' });
          } else if (response) {
            resolve(response);
          } else {
            console.error('[ZentaoBrowser] Background 未返回响应');
            resolve({ success: false, reason: 'no_response' });
          }
        });
      });

      if (!result.success) {
        console.error('[ZentaoBrowser] 创建任务失败:', result.reason);
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
        const locateMatch = data.locate.match(/task[-_]view[-_]?(\d+)/) ||
          data.locate.match(/execution-task[-_][^/-]+-(\d+)/) ||
          data.locate.match(/taskID=(\d+)/); // 有些带参数的 locate

        if (locateMatch) {
          taskId = locateMatch[1];
          console.log('[ZentaoBrowser] 从 locate 提取到任务ID:', taskId);
          return { success: true, taskId };
        }

        // 尝试解析 JSON 如果服务端直接返回 id（极少数情况）
        if (data.id) {
          return { success: true, taskId: data.id };
        }

        // 如果直接提取失败，尝试访问页面
        console.log('[ZentaoBrowser] 尝试从页面提取任务ID');
        taskId = await this.extractTaskIdFromHtml(data.locate);
        if (taskId) {
          return { success: true, taskId };
        }
      } else if (data && data.message) {
        console.warn('[ZentaoBrowser] 创建任务失败，提示:', data.message);
        // 作为 JSON 数组或者字符串对象解析出来给前端提示
        return { success: false, reason: typeof data.message === 'string' ? data.message : JSON.stringify(data.message) };
      }

      console.log('[ZentaoBrowser] 创建任务未返回有效结果', data);
      return { success: false, reason: 'unrecognized_response' };
    } catch (err) {
      console.error('[ZentaoBrowser] 创建任务异常:', err.message);
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
        console.error('[ZentaoBrowser] 获取任务列表页面失败:', response.status);
        return null;
      }

      const html = await response.text();
      const match = html.match(/<tr\s+data-id=['"](\d+)['"]/);

      if (match && match[1]) {
        return match[1];
      }

      console.error('[ZentaoBrowser] HTML 中未找到任务ID');
      return null;
    } catch (err) {
      console.error('[ZentaoBrowser] 提取任务ID异常:', err.message);
      return null;
    }
  },

  /**
   * 更新任务状态
   */
  async updateTaskStatus(taskId, status, progress) {
    await this.initConfig();

    if (!this.isConfigured()) {
      return { success: false, reason: 'not_configured' };
    }

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
            console.error('[ZentaoBrowser] Background 通信失败:', chrome.runtime.lastError.message);
            resolve({ success: false, reason: 'background_error' });
          } else if (response) {
            resolve(response);
          } else {
            console.error('[ZentaoBrowser] Background 未返回响应');
            resolve({ success: false, reason: 'no_response' });
          }
        });
      });

      return result;
    } catch (err) {
      console.error('[ZentaoBrowser] 更新状态异常:', err.message);
      return { success: false, reason: err.message };
    }
  },

  /**
   * 记录工时 (Effort)
   */
  async recordEffort(taskId, comment, consumedTime, leftTime = 0) {
    await this.initConfig();

    if (!this.isConfigured()) {
      return { success: false, reason: 'not_configured' };
    }

    const baseUrl = this.getBaseUrl();

    console.log(`[ZentaoBrowser] 记录工时 (Task ID: ${taskId}): consumed=${consumedTime}, comment=${comment}`);

    try {
      // 通过 background.js 在禅道页面中执行
      const result = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          action: 'recordZentaoEffort',
          baseUrl,
          taskId,
          comment,
          consumedTime,
          leftTime
        }, (response) => {
          if (chrome.runtime.lastError) {
            console.error('[ZentaoBrowser] Background 通信失败:', chrome.runtime.lastError.message);
            resolve({ success: false, reason: 'background_error' });
          } else if (response) {
            resolve(response);
          } else {
            console.error('[ZentaoBrowser] Background 未返回响应');
            resolve({ success: false, reason: 'no_response' });
          }
        });
      });

      return result;
    } catch (err) {
      console.error('[ZentaoBrowser] 记录工时异常:', err.message);
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
            console.error('[ZentaoBrowser] Background 通信失败:', chrome.runtime.lastError.message);
            resolve({ success: false, reason: 'background_error' });
          } else if (response) {
            resolve(response);
          } else {
            console.error('[ZentaoBrowser] Background 未返回响应');
            resolve({ success: false, reason: 'no_response' });
          }
        });
      });

      return result;
    } catch (err) {
      console.error('[ZentaoBrowser] 删除禅道任务异常:', err.message);
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
            console.error('[ZentaoBrowser] Background 通信失败:', chrome.runtime.lastError.message);
            resolve({ success: false, reason: 'background_error' });
          } else if (response) {
            resolve(response);
          } else {
            console.error('[ZentaoBrowser] Background 未返回响应');
            resolve({ success: false, reason: 'no_response' });
          }
        });
      });

      return result;
    } catch (err) {
      console.error('[ZentaoBrowser] 编辑禅道任务异常:', err.message);
      return { success: false, reason: err.message };
    }
  }
};
