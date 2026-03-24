import { config } from '../config.js';

// 存储 cookie（内存中）
let zentaoCookies = null;
let zentaoCookieExpiry = null;

/**
 * 登录禅道获取 cookie
 * @param {string} baseUrl - 禅道基础URL
 * @param {string} username - 用户名
 * @param {string} password - 密码
 * @returns {Promise<Object>} cookies 对象
 */
async function loginZentao(baseUrl, username, password) {
  const loginUrl = `${baseUrl}/zentao/user-login.html`;

  // 首先获取登录页面，提取必要的参数
  const loginPageResp = await fetch(loginUrl);
  const loginPageHtml = await loginPageResp.text();

  // 提取 verify 参数（如果有）
  const verifyMatch = loginPageHtml.match(/name="verify"[^>]*value="([^"]+)"/);
  const verify = verifyMatch ? verifyMatch[1] : '';

  // 提交登录表单
  const formResp = await fetch(`${baseUrl}/zentao/user-login.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      account: username,
      password: password,
      verify: verify || '',
      keepLogin: 'on',
    }),
    redirect: 'manual'
  });

  // 获取响应的 set-cookie
  const setCookieHeaders = formResp.headers.getSetCookie();
  const cookies = {};
  for (const header of setCookieHeaders) {
    const match = header.match(/^([^=]+)=([^;]+)/);
    if (match) {
      cookies[match[1]] = match[2];
    }
  }

  if (cookies.zentaosid) {
    console.log('[ZentaoService] 登录成功, session:', cookies.zentaosid.substring(0, 8) + '...');
    return cookies;
  }

  throw new Error('登录失败，未获取到 session cookie');
}

/**
 * 获取有效的禅道 cookie
 * @returns {Promise<Object>} cookies 对象
 */
async function getZentaoCookies() {
  // 检查配置
  if (!config.zentao.enabled) {
    throw new Error('禅道未启用');
  }
  if (!config.zentao.url || !config.zentao.username || !config.zentao.password) {
    throw new Error('禅道配置不完整');
  }

  // 检查 cookie 是否有效（1小时过期）
  if (zentaoCookies && zentaoCookieExpiry && Date.now() < zentaoCookieExpiry) {
    return zentaoCookies;
  }

  // 重新登录
  console.log('[ZentaoService] Cookie 过期或不存在，重新登录...');
  zentaoCookies = await loginZentao(
    config.zentao.url,
    config.zentao.username,
    config.zentao.password
  );
  zentaoCookieExpiry = Date.now() + 60 * 60 * 1000; // 1小时后过期
  return zentaoCookies;
}

/**
 * 将 cookie 对象转换为 Cookie header 字符串
 * @param {Object} cookies - cookies 对象
 * @returns {string} Cookie header 字符串
 */
function cookiesToString(cookies) {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

/**
 * 创建禅道任务
 * @param {Object} taskData - 任务数据
 * @param {string} taskData.title - 任务标题
 * @param {string} [taskData.content] - 任务描述
 * @param {string} [taskData.dueDate] - 截止日期 (YYYY-MM-DD)
 * @param {number} [taskData.executionId] - 执行ID（可选，默认使用配置的执行）
 * @param {string} [taskData.assignedTo] - 指派给（可选）
 * @param {number} [taskData.priority] - 优先级（可选，默认3）
 * @param {string} [taskData.type] - 任务类型（可选，默认devel）
 * @returns {Promise<{success: boolean, taskId?: number, message?: string}>}
 */
async function createTask(taskData) {
  try {
    const cookies = await getZentaoCookies();

    // 获取默认执行ID
    let executionId = taskData.executionId;
    if (!executionId) {
      const { getExecutionById } = await import('./executionManager.js');
      const { getDefaultExecution } = await import('./executionManager.js');
      const defaultExecution = await getDefaultExecution();
      executionId = defaultExecution?.id;
    }

    if (!executionId) {
      return {
        success: false,
        message: '未指定执行ID，且没有配置默认执行'
      };
    }

    const endpoint = `${config.zentao.url}/zentao/task-create-${executionId}-0-0.html`;

    console.log('[ZentaoService] 创建任务:', taskData.title);

    // 构建 FormData
    const formData = new FormData();
    formData.append('execution', executionId);
    formData.append('type', taskData.type || 'devel');
    formData.append('module', '0');
    if (taskData.assignedTo) {
      formData.append('assignedTo[]', taskData.assignedTo);
    } else {
      formData.append('assignedTo[]', '');
    }
    formData.append('teamMember', '');
    formData.append('mode', 'linear');
    formData.append('status', 'wait');
    formData.append('story', '');
    formData.append('color', '');
    formData.append('name', taskData.title);
    formData.append('storyEstimate', '');
    formData.append('storyDesc', '');
    formData.append('storyPri', '');
    formData.append('pri', String(taskData.priority ?? 3));
    formData.append('estimate', '');
    formData.append('desc', taskData.content || taskData.title);
    formData.append('estStarted', '');
    formData.append('deadline', taskData.dueDate || '');
    formData.append('after', 'toTaskList');
    formData.append('uid', Math.random().toString(36).substring(2, 14));

    for (let i = 0; i < 5; i++) {
      formData.append('team[]', '');
      formData.append('teamSource[]', '');
      formData.append('teamEstimate[]', '');
    }

    // 发送请求到禅道
    const zentaoResp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest',
        'Cookie': cookiesToString(cookies),
      },
      body: formData,
    });

    const responseText = await zentaoResp.text();

    if (!zentaoResp.ok) {
      console.error('[ZentaoService] HTTP 错误:', zentaoResp.status, responseText.substring(0, 200));
      return {
        success: false,
        message: `HTTP ${zentaoResp.status}`
      };
    }

    // 解析响应
    let data;
    try {
      data = JSON.parse(responseText);
    } catch (e) {
      console.error('[ZentaoService] 响应解析失败:', responseText.substring(0, 200));
      return {
        success: false,
        message: '响应解析失败'
      };
    }

    // 检查禅道返回的结果
    if (data.result === 'success' || data.status === 'success') {
      // 尝试从响应中获取任务ID
      const taskId = data.id || data.task?.id || data.data?.id;
      console.log('[ZentaoService] 任务创建成功, ID:', taskId);
      return {
        success: true,
        taskId: taskId,
        message: '任务已同步到禅道'
      };
    }

    // 检查是否是定位到任务列表的成功响应
    if (data.locate && data.locate.includes('task-view')) {
      const match = data.locate.match(/task-view-(\d+)/);
      if (match) {
        const taskId = parseInt(match[1]);
        console.log('[ZentaoService] 任务创建成功, ID:', taskId);
        return {
          success: true,
          taskId: taskId,
          message: '任务已同步到禅道'
        };
      }
    }

    // 禅道返回了错误信息
    const errorMessage = data.message || data.error || '未知错误';
    console.error('[ZentaoService] 禅道返回错误:', errorMessage);
    return {
      success: false,
      message: errorMessage
    };
  } catch (err) {
    console.error('[ZentaoService] 创建任务异常:', err.message);
    return {
      success: false,
      message: err.message
    };
  }
}

/**
 * 查询禅道任务
 * @param {Object} filters - 筛选条件
 * @param {number} [filters.executionId] - 执行ID
 * @param {string} [filters.status] - 任务状态 (wait/doing/done/closed)
 * @param {string} [filters.assignedTo] - 指派给
 * @returns {Promise<Array>} 任务列表
 */
async function getTasks(filters = {}) {
  try {
    const cookies = await getZentaoCookies();

    // 获取执行ID
    let executionId = filters.executionId;
    if (!executionId) {
      const { getDefaultExecution } = await import('./executionManager.js');
      const defaultExecution = await getDefaultExecution();
      executionId = defaultExecution?.id;
    }

    if (!executionId) {
      throw new Error('未指定执行ID，且没有配置默认执行');
    }

    // 构建查询参数
    const params = [];
    if (filters.status) params.push(`status=${filters.status}`);
    if (filters.assignedTo) params.push(`assignedTo=${filters.assignedTo}`);

    const queryString = params.length > 0 ? `?${params.join('&')}` : '';
    const endpoint = `${config.zentao.url}/zentao/task-ajaxGetTasks-${executionId}.json${queryString}`;

    console.log('[ZentaoService] 查询任务列表');

    const resp = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'Cookie': cookiesToString(cookies),
      },
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }

    const data = await resp.json();
    return data.tasks || data.data || [];
  } catch (err) {
    console.error('[ZentaoService] 查询任务失败:', err.message);
    return [];
  }
}

/**
 * 更新禅道任务状态
 * @param {number} taskId - 任务ID
 * @param {string} status - 新状态 (start/finish/close/pause/cancel/activate)
 * @returns {Promise<{success: boolean, message?: string}>}
 */
async function updateTaskStatus(taskId, status) {
  try {
    const cookies = await getZentaoCookies();

    // 状态映射到对应的操作
    const statusActionMap = {
      'start': 'start',
      'doing': 'start',
      'finish': 'finish',
      'done': 'finish',
      'close': 'close',
      'closed': 'close',
      'pause': 'pause',
      'wait': 'pause',
      'cancel': 'cancel',
      'activate': 'activate'
    };

    const action = statusActionMap[status];
    if (!action) {
      return {
        success: false,
        message: `不支持的状态: ${status}`
      };
    }

    const endpoint = `${config.zentao.url}/zentao/task-${action}-${taskId}.json`;

    console.log('[ZentaoService] 更新任务状态:', taskId, '->', status);

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'Cookie': cookiesToString(cookies),
      },
    });

    const data = await resp.json();

    if (data.result === 'success' || data.status === 'success') {
      return {
        success: true,
        message: '状态已更新'
      };
    }

    return {
      success: false,
      message: data.message || '更新失败'
    };
  } catch (err) {
    console.error('[ZentaoService] 更新任务状态失败:', err.message);
    return {
      success: false,
      message: err.message
    };
  }
}

/**
 * 清除缓存的 cookie（用于测试或重新登录）
 */
function clearCookies() {
  zentaoCookies = null;
  zentaoCookieExpiry = null;
  console.log('[ZentaoService] Cookie 已清除');
}

/**
 * 检查禅道是否已配置
 * @returns {boolean}
 */
function isConfigured() {
  return config.zentao.enabled &&
    !!config.zentao.url &&
    !!config.zentao.username &&
    !!config.zentao.password;
}

export {
  loginZentao,
  getZentaoCookies,
  cookiesToString,
  createTask,
  getTasks,
  updateTaskStatus,
  clearCookies,
  isConfigured
};
