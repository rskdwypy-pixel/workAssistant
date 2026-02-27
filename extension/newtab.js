// API配置
let API_BASE_URL = 'http://localhost:3721';

// 当前状态
let currentYear, currentMonth;
let selectedDate = null;
let allTasks = [];

// 调试模式状态
let debugMode = false;

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

// 初始化
document.addEventListener('DOMContentLoaded', async () => {
  // 初始化 Toast
  Toast.init();

  // 恢复调试模式状态
  const savedDebugMode = localStorage.getItem('debugMode');
  if (savedDebugMode === 'true') {
    debugMode = true;
    const testButtons = document.getElementById('testButtons');
    const debugBtn = document.getElementById('debugToggleBtn');
    testButtons.classList.add('visible');
    debugBtn.classList.add('active');
    console.log('%c[调试模式] 已自动开启', 'color: #f59e0b; font-size: 14px; font-weight: bold;');
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

  // 绑定事件
  bindEvents();
});

// 绑定事件
function bindEvents() {
  bindReportEvents();
  bindDragAndDrop();
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

  // 调试模式切换
  document.getElementById('debugToggleBtn').addEventListener('click', () => {
    debugMode = !debugMode;
    const testButtons = document.getElementById('testButtons');
    const debugBtn = document.getElementById('debugToggleBtn');

    if (debugMode) {
      testButtons.classList.add('visible');
      debugBtn.classList.add('active');
      localStorage.setItem('debugMode', 'true');
      Toast.success('调试模式已开启');
      console.log('%c[调试模式] 测试按钮已显示', 'color: #f59e0b; font-size: 14px; font-weight: bold;');
    } else {
      testButtons.classList.remove('visible');
      debugBtn.classList.remove('active');
      localStorage.removeItem('debugMode');
      Toast.info('调试模式已关闭');
    }
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

  // 检查服务状态
  document.getElementById('checkService').addEventListener('click', checkServiceStatus);

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

    // 更新后端服务地址
    API_BASE_URL = config.backendUrl || 'http://localhost:3721';

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

  filteredTasks.sort((a, b) => {
    if (a.order !== undefined && b.order !== undefined) return a.order - b.order;
    if (a.order !== undefined) return -1;
    if (b.order !== undefined) return 1;
    return new Date(b.createdAt) - new Date(a.createdAt);
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

  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', task.id);
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => card.classList.add('dragging'), 0);
  });

  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
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
  card.innerHTML = `
    <div class="task-title" style="display: flex; align-items: flex-start; gap: 8px;">
      <input type="checkbox" class="task-checkbox" data-task-id="${task.id}" ${task.status === 'done' ? 'checked' : ''} style="margin-top: 4px; cursor: pointer;">
      <span>${escapeHtml(task.title)}</span>
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
    checkbox.addEventListener('change', (e) => {
      e.stopPropagation();
      const newProgress = e.target.checked ? 100 : 0;
      updateTaskProgress(task.id, newProgress);
    });
  }

  // 绑定进度条事件
  const progressTrack = card.querySelector('.task-progress-track');
  const progressInput = card.querySelector('.task-progress-input');

  if (progressTrack && progressInput) {
    // 点击进度条更新进度
    progressTrack.addEventListener('click', (e) => {
      e.stopPropagation();
      const rect = progressTrack.getBoundingClientRect();
      const percent = Math.round(((e.clientX - rect.left) / rect.width) * 100);
      updateTaskProgress(task.id, Math.max(0, Math.min(100, percent)));
    });

    // 输入框修改进度
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

  try {
    const response = await fetch(`${API_BASE_URL}/api/task`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });

    const result = await response.json();

    if (result.success) {
      await loadTasks();
      await loadCalendar();

      // 显示操作结果
      if (result.isNew === false) {
        Toast.info(result.message || '已更新现有任务');
      } else {
        Toast.success('任务已添加');
      }
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
    const response = await fetch(`${API_BASE_URL}/api/task/${taskId}/progress`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ progress })
    });

    const result = await response.json();

    if (result.success) {
      // 只重新渲染任务列表，不重新加载
      await loadTasks();
    } else {
      console.error('更新进度失败:', result.error);
    }
  } catch (err) {
    console.error('更新进度失败:', err);
  }
}

// 处理任务操作
async function handleTaskAction(taskId, action) {
  try {
    if (action === 'delete') {
      const confirmed = await showConfirm('删除任务', '确定要删除这个任务吗？');
      if (!confirmed) return;
      await fetch(`${API_BASE_URL}/api/task/${taskId}`, { method: 'DELETE' });
      Toast.success('任务已删除');
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

  body.innerHTML = `
    <div style="margin-bottom: 16px;">
      <h4 style="margin-bottom: 12px;">${escapeHtml(task.title)}</h4>
      <div style="background-color: #f9f9f9; padding: 10px; border-radius: 6px; margin-bottom: 12px;">
        <strong style="font-size: 13px; color: #555;">原始输入内容:</strong>
        <p style="color: #666; margin-top: 6px; font-size: 14px; white-space: pre-wrap;">${escapeHtml(task.content || task.title)}</p>
      </div>
    </div>
    <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 16px;">
      <div><strong>状态:</strong> ${statusLabels[task.status]}</div>
      ${task.status !== 'done' ? `<div><strong>${task.status === 'in_progress' ? '截止时间' : '提醒时间'}:</strong> ${task.reminderTime ? new Date(task.reminderTime).toLocaleString('zh-CN') : '未设置'}</div>` : ''}
      <div><strong>创建时间:</strong> ${new Date(task.createdAt).toLocaleString('zh-CN')}</div>
    </div>
    <div style="display: flex; gap: 8px;">
      ${task.status !== 'done' ? `<button class="btn-primary detail-action-btn" data-action="done">标记完成</button>` : ''}
      <button class="btn-secondary detail-action-btn" style="border-color: #e74c3c; color: #e74c3c;" data-action="delete">删除</button>
    </div>
  `;

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
    const diff = d.getDate() + (6 - day); // Saturday this week
    d.setDate(diff);
    d.setHours(18, 0, 0, 0); // 18:00 on Saturday
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
}

// 检查服务状态
async function checkServiceStatus() {
  const statusDot = document.getElementById('serviceStatusDot');
  const statusText = document.getElementById('serviceStatusText');

  statusDot.className = 'status-dot unknown';
  statusText.textContent = '检测中...';

  try {
    const response = await fetch(`${API_BASE_URL}/health`);
    if (response.ok) {
      statusDot.className = 'status-dot online';
      statusText.textContent = '后端服务在线';
    } else {
      throw new Error('服务异常');
    }
  } catch (err) {
    statusDot.className = 'status-dot offline';
    statusText.textContent = '后端服务离线';
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
    } catch (err) {
      console.error('批量更新状态失败:', err);
    }
  }
}
