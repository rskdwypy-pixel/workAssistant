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
 * @param {Object} [taskData.kanban] - 看板位置参数（在看板中创建任务时使用）
 * @param {number} [taskData.kanban.regionId] - 区域ID
 * @param {number} [taskData.kanban.laneId] - 泳道ID（分组ID）
 * @param {number} [taskData.kanban.columnId] - 列ID
 * @param {string} [taskData.kanban.laneType] - 泳道类型，用于自动解析 ('task'=任务, 'story'=研发需求, 'bug'=Bug)
 * @param {string} [taskData.kanban.columnType] - 列类型，用于自动解析 ('wait'=未开始, 'developing'=研发中 等)
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

    // 判断是否在看板中创建任务
    let kanbanParams = taskData.kanban || {};

    // 如果提供了 laneType 和 columnType，但没有提供具体的 ID，则自动解析
    if ((kanbanParams.laneType || kanbanParams.columnType) &&
        (!kanbanParams.regionId || !kanbanParams.laneId || !kanbanParams.columnId)) {
      console.log('[ZentaoService] 自动解析看板参数...');
      const parsedParams = await getKanbanParams(
        executionId,
        kanbanParams.laneType || 'task',
        kanbanParams.columnType || 'wait'
      );
      if (parsedParams) {
        kanbanParams = { ...kanbanParams, ...parsedParams };
      }
    }

    const isKanbanTask = kanbanParams.regionId &&
      kanbanParams.laneId &&
      kanbanParams.columnId;

    let endpoint;
    if (isKanbanTask) {
      // 看板任务 URL 格式: task-create-{executionId}-0-0-0-0-regionID={regionId},laneID={laneId},columnID={columnId}.html
      endpoint = `${config.zentao.url}/zentao/task-create-${executionId}-0-0-0-0-regionID=${kanbanParams.regionId},laneID=${kanbanParams.laneId},columnID=${kanbanParams.columnId}.html?onlybody=yes`;
    } else {
      // 普通任务 URL 格式
      endpoint = `${config.zentao.url}/zentao/task-create-${executionId}-0-0.html`;
    }

    console.log('[ZentaoService] 创建任务:', taskData.title, isKanbanTask ? '(看板任务)' : '(普通任务)');

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

    // 看板任务需要额外的位置参数
    if (isKanbanTask) {
      formData.append('region', String(kanbanParams.regionId));
      formData.append('lane', String(kanbanParams.laneId));
    }

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
 * 记录任务工时（通过 task-recordEstimate API）
 * @param {number|string} taskId - 任务ID
 * @param {Object} effortData - 工时数据
 * @param {string} effortData.work - 工作内容描述
 * @param {number} effortData.consumed - 消耗工时（小时）
 * @param {number} effortData.left - 剩余工时（小时）
 * @returns {Promise<{success: boolean, message?: string}>}
 */
async function recordTaskEstimate(taskId, effortData) {
  try {
    const cookies = await getZentaoCookies();

    const endpoint = `${config.zentao.url}/zentao/task-recordEstimate-${taskId}.html?onlybody=yes`;

    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    console.log('[ZentaoService] 记录任务工时:', { taskId, ...effortData });

    // 构建表单数据（URL 编码格式）
    const params = new URLSearchParams();
    params.append('dates[1]', today);
    params.append('id[1]', '1');
    params.append('work[1]', effortData.work || '工作内容进度更新');
    params.append('consumed[1]', String(effortData.consumed || 0));
    params.append('left[1]', String(effortData.left || 0));

    // 添加4个空的表单项（禅道表单要求）
    for (let i = 2; i <= 5; i++) {
      params.append(`dates[${i}]`, today);
      params.append(`id[${i}]`, String(i));
      params.append(`work[${i}]`, '');
      params.append(`consumed[${i}]`, '');
      params.append(`left[${i}]`, '');
    }

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'Cookie': cookiesToString(cookies),
      },
      body: params.toString()
    });

    const text = await resp.text();

    // 检查响应
    if (text.includes('alert-success') || text.includes('保存成功') || text.includes('记录成功')) {
      console.log('[ZentaoService] 工时记录成功:', taskId);
      return { success: true, message: '工时已记录' };
    } else if (text.includes('alert-danger') || text.includes('错误')) {
      console.error('[ZentaoService] 工时记录失败:', text.substring(0, 200));
      return { success: false, message: '记录工时失败' };
    }

    // 其他情况（可能是重定向），也认为成功
    console.log('[ZentaoService] 工时记录 - 无明确成功/失败标识，假定成功');
    return { success: true, message: '工时已记录（推测）' };
  } catch (err) {
    console.error('[ZentaoService] 记录工时异常:', err.message);
    return { success: false, message: err.message };
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
 * 获取所有执行列表（从HTML页面解析，获取准确的type字段）
 * @returns {Promise<Array>} 执行列表
 */
async function getExecutions() {
  try {
    const cookies = await getZentaoCookies();

    // 改用HTML页面获取，因为JSON接口不返回type字段
    const endpoint = `${config.zentao.url}/zentao/execution-all-all-order_asc-0.html`;

    console.log('[ZentaoService] 获取执行列表（HTML页面）');

    const resp = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'Accept': 'text/html',
        'Cookie': cookiesToString(cookies),
      },
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }

    const html = await resp.text();

    // 从HTML中提取 <script>data = "[...]"</script> 中的数据
    const dataMatch = html.match(/<script>\s*data\s*=\s*"(\\[^]|[^\\"])*"/);
    if (!dataMatch) {
      console.error('[ZentaoService] 未找到执行数据');
      return [];
    }

    // 提取并解析JSON字符串
    const jsonStr = dataMatch[0].replace(/<script>\s*data\s*=\s*"/, '').replace(/"\s*<\/script>\s*$/, '');
    // 解码转义字符
    const decodedJsonStr = JSON.parse(`"${jsonStr}"`);
    const executions = JSON.parse(decodedJsonStr);

    console.log('[ZentaoService] 解析到', executions.length, '个执行');

    // 格式化执行列表，保留type字段
    return executions.map(ex => {
      // 从name中提取纯名称（去掉HTML标签）
      let cleanName = ex.name || ex.title || `执行 ${ex.id}`;
      // 移除HTML标签获取纯文本名称
      cleanName = cleanName.replace(/<[^>]+>/g, '').trim();
      // 提取链接中的文本作为名称
      const nameMatch = cleanName.match(/>([^<]+)</);
      if (nameMatch) {
        cleanName = nameMatch[1].trim();
      }

      return {
        id: String(ex.id),
        name: cleanName,
        projectId: String(ex.project),
        projectName: ex.projectName || '',
        status: ex.status || 'doing',
        begin: ex.begin || '',
        end: ex.end || '',
        // 关键：使用准确的type字段
        type: ex.type || 'execution',  // kanban, sprint, stage
        kanbanId: ex.type === 'kanban' ? String(ex.id) : null
      };
    });
  } catch (err) {
    console.error('[ZentaoService] 获取执行列表失败:', err.message);
    return [];
  }
}

/**
 * 根据项目ID获取执行列表
 * @param {number} projectId - 项目ID
 * @returns {Promise<Array>} 执行列表
 */
async function getExecutionsByProject(projectId) {
  try {
    const cookies = await getZentaoCookies();

    const endpoint = `${config.zentao.url}/zentao/project-ajaxGetExecutions-${projectId}----.json`;

    console.log('[ZentaoService] 获取项目执行列表:', projectId);

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
    let executions = data?.data || [];

    return executions.map(ex => ({
      id: String(ex.id),
      name: ex.name || ex.title || `执行 ${ex.id}`,
      projectId: String(projectId),
      status: ex.status || 'doing',
      begin: ex.begin || '',
      end: ex.end || ''
    }));
  } catch (err) {
    console.error('[ZentaoService] 获取项目执行列表失败:', err.message);
    return [];
  }
}

// ============================================================================
// 看板相关 API
// ============================================================================

/**
 * 获取看板详情（包括区域、分组、列等信息）
 * @param {number|string} kanbanId - 看板ID
 * @returns {Promise<Object>} 看板详情
 */
async function getKanbanView(kanbanId) {
  try {
    const cookies = await getZentaoCookies();
    const endpoint = `${config.zentao.url}/zentao/kanban-view-${kanbanId}.json`;

    console.log('[ZentaoService] 获取看板详情:', kanbanId);

    const resp = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Cookie': cookiesToString(cookies),
      },
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }

    const data = await resp.json();
    return data;
  } catch (err) {
    console.error('[ZentaoService] 获取看板详情失败:', err.message);
    return null;
  }
}

/**
 * 创建看板卡片
 * @param {Object} cardData - 卡片数据
 * @param {number|string} cardData.kanbanId - 看板ID
 * @param {number|string} cardData.regionId - 区域ID
 * @param {number|string} cardData.groupId - 分组ID
 * @param {number|string} cardData.columnId - 列ID
 * @param {string} cardData.name - 卡片名称
 * @param {string} [cardData.spec] - 卡片描述
 * @param {number} [cardData.pri] - 优先级
 * @param {string} [cardData.assignedTo] - 指派给
 * @param {string} [cardData.deadline] - 截止日期
 * @returns {Promise<{success: boolean, cardId?: number, message?: string}>}
 */
async function createKanbanCard(cardData) {
  try {
    const cookies = await getZentaoCookies();

    const { kanbanId, regionId, groupId, columnId, ...rest } = cardData;

    if (!kanbanId || !regionId || !groupId || !columnId) {
      return {
        success: false,
        message: '缺少必要参数: kanbanId, regionId, groupId, columnId'
      };
    }

    const endpoint = `${config.zentao.url}/zentao/kanban-createCard-${kanbanId}-${regionId}-${groupId}-${columnId}.json`;

    console.log('[ZentaoService] 创建看板卡片:', cardData.name);

    const formData = new FormData();
    formData.append('name', rest.name || '');
    formData.append('spec', rest.spec || '');
    formData.append('pri', String(rest.pri ?? 3));
    if (rest.assignedTo) {
      formData.append('assignedTo[]', rest.assignedTo);
    } else {
      formData.append('assignedTo[]', '');
    }
    formData.append('deadline', rest.deadline || '');
    formData.append('begin', rest.begin || '');
    formData.append('estimate', rest.estimate || '');
    formData.append('color', rest.color || '');

    const zentaoResp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
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

    if (data.result === 'success' || data.status === 'success') {
      const cardId = data.id || data.card?.id || data.data?.id;
      console.log('[ZentaoService] 看板卡片创建成功, ID:', cardId);
      return {
        success: true,
        cardId: cardId,
        message: '看板卡片已创建'
      };
    }

    const errorMessage = data.message || data.error || '未知错误';
    console.error('[ZentaoService] 禅道返回错误:', errorMessage);
    return {
      success: false,
      message: errorMessage
    };
  } catch (err) {
    console.error('[ZentaoService] 创建看板卡片异常:', err.message);
    return {
      success: false,
      message: err.message
    };
  }
}

/**
 * 编辑看板卡片
 * @param {number|string} cardId - 卡片ID
 * @param {Object} updates - 更新的字段
 * @returns {Promise<{success: boolean, message?: string}>}
 */
async function editKanbanCard(cardId, updates) {
  try {
    const cookies = await getZentaoCookies();

    const endpoint = `${config.zentao.url}/zentao/kanban-editCard-${cardId}.json`;

    console.log('[ZentaoService] 编辑看板卡片:', cardId);

    const formData = new FormData();
    if (updates.name !== undefined) formData.append('name', updates.name);
    if (updates.spec !== undefined) formData.append('spec', updates.spec);
    if (updates.pri !== undefined) formData.append('pri', String(updates.pri));
    if (updates.assignedTo !== undefined) formData.append('assignedTo[]', updates.assignedTo || '');
    if (updates.deadline !== undefined) formData.append('deadline', updates.deadline || '');
    if (updates.begin !== undefined) formData.append('begin', updates.begin || '');
    if (updates.estimate !== undefined) formData.append('estimate', updates.estimate || '');
    if (updates.color !== undefined) formData.append('color', updates.color || '');
    if (updates.progress !== undefined) formData.append('progress', String(updates.progress));

    const zentaoResp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'Cookie': cookiesToString(cookies),
      },
      body: formData,
    });

    const data = await zentaoResp.json();

    if (data.result === 'success' || data.status === 'success') {
      return {
        success: true,
        message: '卡片已更新'
      };
    }

    return {
      success: false,
      message: data.message || '更新失败'
    };
  } catch (err) {
    console.error('[ZentaoService] 编辑看板卡片失败:', err.message);
    return {
      success: false,
      message: err.message
    };
  }
}

/**
 * 完成看板卡片
 * @param {number|string} cardId - 卡片ID
 * @param {number|string} kanbanId - 看板ID
 * @returns {Promise<{success: boolean, message?: string}>}
 */
async function finishKanbanCard(cardId, kanbanId) {
  try {
    const cookies = await getZentaoCookies();

    const endpoint = `${config.zentao.url}/zentao/kanban-finishCard-${cardId}-${kanbanId}.json`;

    console.log('[ZentaoService] 完成看板卡片:', cardId);

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
        message: '卡片已完成'
      };
    }

    return {
      success: false,
      message: data.message || '操作失败'
    };
  } catch (err) {
    console.error('[ZentaoService] 完成看板卡片失败:', err.message);
    return {
      success: false,
      message: err.message
    };
  }
}

/**
 * 激活看板卡片
 * @param {number|string} cardId - 卡片ID
 * @param {number|string} kanbanId - 看板ID
 * @returns {Promise<{success: boolean, message?: string}>}
 */
async function activateKanbanCard(cardId, kanbanId) {
  try {
    const cookies = await getZentaoCookies();

    const endpoint = `${config.zentao.url}/zentao/kanban-activateCard-${cardId}-${kanbanId}.json`;

    console.log('[ZentaoService] 激活看板卡片:', cardId);

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
        message: '卡片已激活'
      };
    }

    return {
      success: false,
      message: data.message || '操作失败'
    };
  } catch (err) {
    console.error('[ZentaoService] 激活看板卡片失败:', err.message);
    return {
      success: false,
      message: err.message
    };
  }
}

/**
 * 移动看板卡片
 * @param {Object} moveData - 移动数据
 * @param {number|string} moveData.cardId - 卡片ID
 * @param {number|string} moveData.fromColId - 原列ID
 * @param {number|string} moveData.toColId - 目标列ID
 * @param {number|string} moveData.fromLaneId - 原泳道ID
 * @param {number|string} moveData.toLaneId - 目标泳道ID
 * @param {number|string} moveData.kanbanId - 看板ID
 * @returns {Promise<{success: boolean, message?: string}>}
 */
async function moveKanbanCard(moveData) {
  try {
    const cookies = await getZentaoCookies();

    const { cardId, fromColId, toColId, fromLaneId, toLaneId, kanbanId } = moveData;

    const endpoint = `${config.zentao.url}/zentao/kanban-moveCard-${cardId}-${fromColId}-${toColId}-${fromLaneId}-${toLaneId}-${kanbanId}.json`;

    console.log('[ZentaoService] 移动看板卡片:', cardId);

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Cookie': cookiesToString(cookies),
      },
    });

    const data = await resp.json();

    if (data.result === 'success' || data.status === 'success') {
      return {
        success: true,
        message: '卡片已移动'
      };
    }

    return {
      success: false,
      message: data.message || '移动失败'
    };
  } catch (err) {
    console.error('[ZentaoService] 移动看板卡片失败:', err.message);
    return {
      success: false,
      message: err.message
    };
  }
}

/**
 * 删除看板卡片
 * @param {number|string} cardId - 卡片ID
 * @param {string} [confirm='no'] - 确认删除
 * @returns {Promise<{success: boolean, message?: string}>}
 */
async function deleteKanbanCard(cardId, confirm = 'yes') {
  try {
    const cookies = await getZentaoCookies();

    const endpoint = `${config.zentao.url}/zentao/kanban-deleteCard-${cardId}-${confirm}.json`;

    console.log('[ZentaoService] 删除看板卡片:', cardId);

    const resp = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Cookie': cookiesToString(cookies),
      },
    });

    const data = await resp.json();

    if (data.result === 'success' || data.status === 'success') {
      return {
        success: true,
        message: '卡片已删除'
      };
    }

    return {
      success: false,
      message: data.message || '删除失败'
    };
  } catch (err) {
    console.error('[ZentaoService] 删除看板卡片失败:', err.message);
    return {
      success: false,
      message: err.message
    };
  }
}

/**
 * 从看板页面HTML中解析 regionID、laneID、columnID
 * @param {number|string} executionId - 执行ID
 * @param {string} [laneType='task'] - 泳道类型 ('task'=任务, 'story'=研发需求, 'bug'=Bug)
 * @param {string} [columnType='wait'] - 列类型 ('wait'=未开始, 'developing'=研发中, 'developed'=研发完毕 等)
 * @returns {Promise<{regionId?: number, laneId?: number, columnId?: number} | null>}
 */
async function getKanbanParams(executionId, laneType = 'task', columnType = 'wait') {
  try {
    const cookies = await getZentaoCookies();
    const endpoint = `${config.zentao.url}/zentao/execution-kanban-${executionId}.html`;

    console.log('[ZentaoService] 解析看板页面参数:', { executionId, laneType, columnType });

    const resp = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'Accept': 'text/html',
        'Cookie': cookiesToString(cookies),
      },
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }

    const html = await resp.text();

    // 解析 regionId: 从 .region 元素的 data-id 属性
    const regionMatch = html.match(/<div\s+class="region[^"]*"\s+data-id="(\d+)"/);
    if (!regionMatch) {
      console.error('[ZentaoService] 未找到 region 元素');
      return null;
    }
    const regionId = parseInt(regionMatch[1]);

    // 解析 laneId: 根据 title 找到对应的 kanban-lane 元素
    // laneType 映射到 title
    const laneTitleMap = {
      'task': '任务',
      'story': '研发需求',
      'bug': 'Bug'
    };
    const laneTitle = laneTitleMap[laneType] || '任务';

    // 匹配 <div class="kanban-lane" data-id="114" ... 中包含 title="任务" 的元素
    const laneMatch = html.match(new RegExp(
      `<div\\s+class="kanban-lane[^"]*"\\s+data-id="(\\d+)"[^>]*>[\\s\\S]*?title="${laneTitle}"`,
      'i'
    ));
    if (!laneMatch) {
      console.error('[ZentaoService] 未找到 lane 元素, title:', laneTitle);
      return null;
    }
    const laneId = parseInt(laneMatch[1]);

    // 解析 columnId: 根据列类型找到对应的 column data-id
    // columnType 映射到 data-type
    const columnMatch = html.match(new RegExp(
      `<div\\s+class="kanban-col[^"]*"\\s+data-id="(\\d+)"\\s+data-type="${columnType}"`,
      'i'
    ));
    if (!columnMatch) {
      console.error('[ZentaoService] 未找到 column 元素, type:', columnType);
      return null;
    }
    const columnId = parseInt(columnMatch[1]);

    console.log('[ZentaoService] 解析成功:', { regionId, laneId, columnId });

    return {
      regionId,
      laneId,
      columnId
    };
  } catch (err) {
    console.error('[ZentaoService] 解析看板参数失败:', err.message);
    return null;
  }
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
  recordTaskEstimate,
  getExecutions,
  getExecutionsByProject,
  clearCookies,
  isConfigured,
  getKanbanParams,
  // 看板相关 API
  getKanbanView,
  createKanbanCard,
  editKanbanCard,
  finishKanbanCard,
  activateKanbanCard,
  moveKanbanCard,
  deleteKanbanCard
};
