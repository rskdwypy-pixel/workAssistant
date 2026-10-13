import { config } from '../config.js';
import { createHash } from 'crypto';

// 存储 cookie（内存中）
let zentaoCookies = null;
let zentaoCookieExpiry = null;

// 禅道登录用的 md5（与前台 md5.js 行为一致：小写十六进制）
const md5 = (s) => createHash('md5').update(String(s), 'utf8').digest('hex');

// 关键修复：禅道对「缺少浏览器 User-Agent 的写操作 POST」只返回表单视图、不真正执行动作
// （状态变更 task-start/task-finish、工时记录 task-recordEstimate 都会静默失败）。
// 这里统一为所有请求注入浏览器头，使后端行为与浏览器一致。
const ZENTAO_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const ZENTAO_BASE = (config.zentao?.url || '').replace(/\/$/, '');
const __originFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init = {}) => {
  const src = init.headers || (input && typeof input === 'object' && input.headers) || {};
  const headers = new Headers(src);
  if (!headers.has('User-Agent')) headers.set('User-Agent', ZENTAO_UA);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json, text/javascript, */*; q=0.01');
  if (!headers.has('Accept-Language')) headers.set('Accept-Language', 'zh-CN,zh;q=0.9');
  const method = (init.method || 'GET').toUpperCase();
  // 禅道对写操作会校验来源，缺失 UA/Referer/Origin 时只返回表单、不执行动作
  if (!headers.has('Referer')) headers.set('Referer', `${ZENTAO_BASE}/zentao/`);
  if (method !== 'GET' && method !== 'HEAD') {
    if (!headers.has('Origin')) headers.set('Origin', ZENTAO_BASE);
  }
  return __originFetch(input, { ...init, headers });
};

// 把响应里的 Set-Cookie 收集进给定的 cookie 对象
function collectCookies(resp, into = {}) {
  const setCookieHeaders = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
  for (const header of setCookieHeaders) {
    const match = header.match(/^([^=]+)=([^;]*)/);
    if (match) into[match[1]] = match[2];
  }
  return into;
}

/**
 * 登录禅道获取 cookie
 * 禅道 18.x 登录流程：
 *   1. GET  user-login.html        拿初始 session
 *   2. GET  user-refreshRandom.html 拿随机数 rand
 *   3. POST user-login.html        提交 account + md5(md5(pwd)+rand) + verifyRand
 * 登录成功后服务器下发 za/zp 等 cookie。
 * @param {string} baseUrl - 禅道基础URL
 * @param {string} username - 用户名
 * @param {string} password - 密码
 * @returns {Promise<Object>} cookies 对象
 */
async function loginZentao(baseUrl, username, password) {
  const base = baseUrl.replace(/\/$/, '');
  const cookies = {};

  // 1. 初始会话
  const loginPageResp = await fetch(`${base}/zentao/user-login.html`);
  collectCookies(loginPageResp, cookies);
  await loginPageResp.text();

  // 2. 获取随机数 rand
  const randResp = await fetch(`${base}/zentao/user-refreshRandom.html`, {
    headers: {
      'Cookie': cookiesToString(cookies),
      'X-Requested-With': 'XMLHttpRequest'
    }
  });
  collectCookies(randResp, cookies);
  const rand = (await randResp.text()).trim();

  // 3. 提交登录（密码需按禅道前台规则做两次 md5）
  const hashedPassword = md5(md5(password) + rand);
  const formResp = await fetch(`${base}/zentao/user-login.html`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      'Cookie': cookiesToString(cookies),
      'Referer': `${base}/zentao/user-login.html`
    },
    body: new URLSearchParams({
      account: username,
      password: hashedPassword,
      passwordStrength: '1',
      referer: '/zentao/',
      verifyRand: rand,
      keepLogin: '1',
      captcha: ''
    }),
    redirect: 'manual'
  });
  collectCookies(formResp, cookies);
  const respText = await formResp.text();

  // 成功判定：返回 result:success，或拿到 za/zp 登录 cookie
  const ok = /"result"\s*:\s*"success"/.test(respText) || cookies.za || cookies.zp ||
    (cookies.zentaosid && /locate/.test(respText));

  if (ok) {
    console.log('[ZentaoService] 登录成功, 账号:', username,
      'session:', (cookies.zentaosid || '').substring(0, 8) + '...');
    return cookies;
  }

  throw new Error(`登录失败: ${respText.substring(0, 120)}`);
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
 * @param {number} [taskData.estimate] - 预计工时/小时（可选）
 * @param {string} [taskData.estStarted] - 预计开始日期 (YYYY-MM-DD)
 * @param {string} [taskData.type] - 任务类型（可选，默认devel）
 * @param {Object} [taskData.kanban] - 看板位置参数（在看板中创建任务时使用）
 * @param {number} [taskData.kanban.regionId] - 区域ID
 * @param {number} [taskData.kanban.laneId] - 泳道ID（分组ID）
 * @param {number} [taskData.kanban.columnId] - 列ID
 * @param {string} [taskData.kanban.laneType] - 泳道类型，用于自动解析 ('task'=任务, 'story'=研发需求, 'bug'=Bug)
 * @param {string} [taskData.kanban.columnType] - 列类型，用于自动解析 ('wait'=未开始, 'developing'=研发中 等)
 * @returns {Promise<{success: boolean, taskId?: number, message?: string}>}
 */
// 按标题在执行里回查最新的任务ID（用于禅道重名/未回传ID时定位）
async function findTaskIdByName(name, executionId) {
  if (!name) return null;
  try {
    const tasks = await getTasks({ executionId });
    const target = String(name).trim();
    const hits = (tasks || []).filter((t) => String(t.name).trim() === target);
    if (!hits.length) return null;
    hits.sort((a, b) => Number(b.id) - Number(a.id));
    return hits[0].id;
  } catch (e) {
    return null;
  }
}

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
      // 普通任务 URL 格式（用 .json 端点，保证返回 JSON；.html 在重名等情况下会退回整页 HTML）
      endpoint = `${config.zentao.url}/zentao/task-create-${executionId}-0-0.json`;
    }

    console.log('[ZentaoService] 创建任务:', taskData.title, isKanbanTask ? '(看板任务)' : '(普通任务)');

    // 构建表单数据（禅道 task-create 接口只接受 x-www-form-urlencoded，不能是 multipart）
    const formData = new URLSearchParams();
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
    formData.append('estimate', taskData.estimate != null ? String(taskData.estimate) : '');
    formData.append('desc', taskData.content || taskData.title);
    formData.append('estStarted', taskData.estStarted || '');
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
        'Content-Type': 'application/x-www-form-urlencoded',
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

    // 禅道可能把结果再包一层：{status:'success', data:'{"result":"success","id":123}'}
    if (data && typeof data.data === 'string') {
      try {
        const inner = JSON.parse(data.data);
        if (inner && typeof inner === 'object') data = { ...data, ...inner };
      } catch (e) { /* data 不是 JSON，忽略 */ }
    }

    // 检查禅道返回的结果
    const locate = data.locate || (typeof data.data === 'string' ? data.data : '');
    const dup = /已有|重复|exist/i.test(data.message || '');

    if (data.result === 'success' || data.status === 'success') {
      let taskId = data.id || data.task?.id || data.data?.id || null;
      if (!taskId && locate) {
        const m = String(locate).match(/task-view-(\d+)/);
        if (m) taskId = m[1];
      }
      // 重名时禅道只回 message 不给 ID，这里按标题回查
      if (!taskId) taskId = await findTaskIdByName(taskData.title, executionId);
      console.log('[ZentaoService] 任务创建成功, ID:', taskId, dup ? '（重名，已定位）' : '');
      return {
        success: true,
        taskId: taskId || null,
        duplicate: dup,
        message: taskId
          ? `${dup ? '任务已存在，已定位到' : '任务已创建'}（ID ${taskId}）`
          : (data.message || '任务已提交')
      };
    }

    // 禅道返回了错误信息（例如重名）
    const errorMessage = data.message || data.error || '未知错误';
    if (dup) {
      const taskId = await findTaskIdByName(taskData.title, executionId);
      if (taskId) {
        console.log('[ZentaoService] 任务已存在，定位到 ID:', taskId);
        return {
          success: true,
          taskId,
          duplicate: true,
          message: `任务已存在，已定位到（ID ${taskId}）`
        };
      }
    }
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
        'Accept': 'application/json, text/html, */*',
        'X-Requested-With': 'XMLHttpRequest',
        'Cookie': cookiesToString(cookies),
      },
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }

    const text = await resp.text();

    // 已登录时，该接口返回的是任务表格的 HTML 行（<tr data-id='t123' ...>）
    if (/data-id='t\d+'/.test(text)) {
      const tasks = [];
      const rowRe = /<tr\b[^>]*data-id='t(\d+)'[^>]*>([\s\S]*?)<\/tr>/g;
      let m;
      while ((m = rowRe.exec(text)) !== null) {
        const id = m[1];
        const rowHtml = m[2];
        const titleMatch = rowHtml.match(/task-view-\d+\.json'[^>]*>([\s\S]*?)<\/a>/);
        const title = titleMatch
          ? titleMatch[1].replace(/<[^>]+>/g, '').trim()
          : `任务 ${id}`;
        const assignedMatch = rowHtml.match(/data-assignedTo='([^']*)'/);
        const statusMatch = rowHtml.match(/data-status='([^']*)'/);
        tasks.push({
          id,
          name: title,
          assignedTo: assignedMatch ? assignedMatch[1] : '',
          status: statusMatch ? statusMatch[1] : '',
          raw: undefined
        });
      }
      return tasks;
    }

    // 兼容返回 JSON 的情况
    try {
      const data = JSON.parse(text);
      return data.tasks || data.data || [];
    } catch {
      return [];
    }
  } catch (err) {
    console.error('[ZentaoService] 查询任务失败:', err.message);
    return [];
  }
}

/**
 * 把底层传输错误翻译成用户能看懂的一句话
 *
 * 禅道跑在内网，最常见的失败就是「本机连不上那台机器」——VPN 没开、
 * 不在公司网络、主机名/端口写错。Node 的原生报错只有一句 `fetch failed`，
 * 直接抛给用户完全没法定位，所以在这里补上目标地址和可能原因。
 *
 * @param {Error|any} err
 * @returns {string}
 */
function describeZentaoTransportError(err) {
  const msg = String((err && err.message) || err || '未知错误');
  const base = (config.zentao?.url || '').replace(/\/$/, '') || '(未配置禅道地址)';
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ECONNRESET|EAI_AGAIN|network|abort/i.test(msg)) {
    return `无法连接禅道 ${base}（网络不可达：请确认已连内网 / VPN，以及地址与端口是否正确）`;
  }
  return msg;
}

/**
 * 查询"我的任务"（地盘 → 我的任务）
 * @returns {Promise<Array>} 任务列表
 * @throws {Error} 禅道不可达、登录失败或返回异常时抛出（不再静默返回空数组）
 */
async function getMyTasks() {
  try {
    const cookies = await getZentaoCookies();
    const endpoint = `${config.zentao.url}/zentao/my-task.json`;

    const resp = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'Cookie': cookiesToString(cookies),
      },
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const outer = await resp.json();
    const inner = typeof outer.data === 'string' ? JSON.parse(outer.data) : outer.data;
    const tasks = (inner && inner.tasks) || [];

    return tasks.map((t) => ({
      id: String(t.id),
      name: t.name,
      status: t.status,
      estimate: t.estimate,
      consumed: t.consumed,
      left: t.left,
      deadline: t.deadline,
      assignedTo: t.assignedTo,
      execution: t.execution,
      project: t.project,
      priority: t.pri,
      type: t.type,
      openedBy: t.openedBy,
      executionName: t.executionName,
      projectName: t.projectName,
      progress: t.progress
    }));
  } catch (err) {
    console.error('[ZentaoService] 查询我的任务失败:', err.message);
    // 关键：这里不能 return []。空数组和「禅道不可达」在下游长得一模一样，
    // 结果是同步接口返回 success:true / 0 条，用户看到绿色「同步完成」，
    // 实际一条都没拉到。必须把失败抛出去，让调用方如实报错。
    throw new Error(describeZentaoTransportError(err));
  }
}

/**
 * 后端同步「我的任务」到本地：拉取 my-task.json → 映射为本地任务结构 → 写库
 * 用于替代扩展端「注入禅道标签页 + DOM 解析」的同步方式。
 * 与原 parseTaskList 行为对齐：只同步 wait / doing 的活跃任务。
 * @returns {Promise<{added:number, updated:number, skipped:number, total:number}>}
 */
async function syncMyTasks() {
  const { importZentaoTasks } = await import('./taskManager.js');
  const raw = await getMyTasks();

  const active = raw.filter((t) => t.status === 'wait' || t.status === 'doing');
  const mapped = active.map((t) => ({
    zentaoId: t.id,
    title: t.name,
    status: t.status === 'wait' ? 'todo' : 'in_progress',
    priority: Number(t.priority) || 3,
    projectId: t.project || null,
    projectName: t.projectName || '',
    executionId: t.execution || null,
    executionName: t.executionName || '',
    openedBy: t.openedBy || '',
    estimate: Number(t.estimate) || 0,
    consumed: Number(t.consumed) || 0,
    left: Number(t.left) || 0,
    deadline: t.deadline || '',
    progress: Number(t.progress) || (Number(t.estimate) > 0 ? Math.round((Number(t.consumed) / Number(t.estimate)) * 100) : 0)
  }));

  const result = await importZentaoTasks(mapped);
  return { ...result, total: mapped.length };
}

/**
 * 更新禅道任务状态
 * @param {number} taskId - 任务ID
 * @param {string} status - 新状态 (start/finish/close/pause/cancel/activate)
 * @returns {Promise<{success: boolean, message?: string}>}
 */
// 当前时间字符串 YYYY-MM-DD HH:mm:ss
function nowDateTime() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 从动作表单（task-start/finish/close...）里提取可回填的默认字段，镜像浏览器提交
function extractFormFields(html) {
  const start = html.indexOf('<form');
  const end = html.indexOf('</form>', start);
  const region = start >= 0 ? html.slice(start, end > 0 ? end : html.length) : html;
  const attr = (s, n) => {
    const m = s.match(new RegExp(n + `\\s*=\\s*['"]([^'"]*)['"]`, 'i'));
    return m ? m[1] : '';
  };
  const fields = {};
  for (const m of region.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    const name = attr(tag, 'name');
    if (!name) continue;
    const type = (attr(tag, 'type') || 'text').toLowerCase();
    if (['file', 'submit', 'button', 'image', 'reset'].includes(type)) continue;
    if ((type === 'checkbox' || type === 'radio') && !/\bchecked\b/i.test(tag)) continue;
    let value = attr(tag, 'value');
    if (value.includes('+')) value = ''; // 模板占位（如 uid 的 " + kuid + "）
    fields[name] = value;
  }
  for (const m of region.matchAll(/<select\b[^>]*name\s*=\s*['"]([^'"]+)['"][\s\S]*?<\/select>/gi)) {
    const opt = m[0].match(/<option[^>]*selected[^>]*value\s*=\s*['"]([^'"]*)['"]/i)
      || m[0].match(/<option[^>]*value\s*=\s*['"]([^'"]*)['"][^>]*selected/i);
    fields[m[1]] = opt ? opt[1] : '';
  }
  for (const m of region.matchAll(/<textarea\b[^>]*name\s*=\s*['"]([^'"]+)['"]/gi)) fields[m[1]] = '';
  delete fields['labels[]'];
  delete fields['files[]'];
  delete fields.uid;
  return fields;
}

// 回读「我的任务」里某任务的状态（用于校验写操作是否真的生效）
async function readMyTaskStatus(taskId, cookieHeader, base) {
  try {
    const resp = await fetch(`${base}/zentao/my-task.json`, { headers: { Cookie: cookieHeader } });
    const j = await resp.json();
    const data = JSON.parse(j.data);
    const t = (data.tasks || []).find((x) => String(x.id) === String(taskId));
    return t ? t.status : null;
  } catch (e) {
    return null;
  }
}

// 回读某任务的累计消耗工时（用于校验工时记录是否生效）
async function readMyTaskConsumed(taskId, cookieHeader, base) {
  try {
    const resp = await fetch(`${base}/zentao/my-task.json`, { headers: { Cookie: cookieHeader } });
    const j = await resp.json();
    const data = JSON.parse(j.data);
    const t = (data.tasks || []).find((x) => String(x.id) === String(taskId));
    return t ? Number(t.consumed) : null;
  } catch (e) {
    return null;
  }
}

/**
 * 更新禅道任务状态（镜像浏览器：取动作表单 → 回填 → 提交 → 回读校验）
 * @param {number|string} taskId - 任务ID
 * @param {string} status - 目标状态 wait/doing/done/closed/cancel/activate
 * @param {Object} [options] - 附加项 { consumed, comment }
 * @returns {Promise<{success: boolean, message: string, taskId: string, status: string|null}>}
 */
async function updateTaskStatus(taskId, status, options = {}) {
  try {
    const cookies = await getZentaoCookies();
    const base = config.zentao.url.replace(/\/$/, '');
    const CH = cookiesToString(cookies);

    const statusActionMap = {
      start: 'start', doing: 'start',
      finish: 'finish', done: 'finish',
      close: 'close', closed: 'close',
      pause: 'pause', wait: 'pause',
      cancel: 'cancel', activate: 'activate'
    };
    const expectedMap = {
      start: 'doing', doing: 'doing',
      finish: 'done', done: 'done',
      close: 'closed', closed: 'closed',
      cancel: 'cancel'
    };

    const action = statusActionMap[status];
    if (!action) return { success: false, message: `不支持的状态: ${status}`, taskId: String(taskId), status: null };

    const formUrl = `${base}/zentao/task-${action}-${taskId}.html?onlybody=yes`;
    console.log('[ZentaoService] 更新任务状态:', taskId, '->', status, `(${action})`);

    // 1) 取动作表单，复用其默认字段
    const formResp = await fetch(formUrl, { headers: { Cookie: CH } });
    const html = await formResp.text();
    const fields = extractFormFields(html);

    // 2) 覆盖/补充关键字段
    if (options.comment) fields.comment = options.comment;
    if (action === 'finish') {
      const prev = Number(fields.consumed || 0);
      const cur = options.consumed != null ? Number(options.consumed) : 0;
      fields.currentConsumed = String(cur);
      fields.consumed = String(prev + cur);
      fields.status = 'done';
      if (!fields.finishedDate) fields.finishedDate = nowDateTime();
    } else if (action === 'start') {
      fields.status = 'doing';
      if (!fields.realStarted) fields.realStarted = nowDateTime();
    } else if (action === 'close') {
      fields.status = 'closed';
    }

    // 3) 提交
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) params.append(k, v == null ? '' : v);
    const postResp = await fetch(formUrl, {
      method: 'POST',
      headers: { Cookie: CH, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      redirect: 'manual'
    });
    const postText = await postResp.text();
    // 禅道动作成功后返回含 selfClose 的收尾页；失败/校验不通过会退回表单
    const submitted = /selfClose|closeModal/.test(postText);

    // 4) 回读校验。注意：任务被 done/closed 后会从「我的任务」消失，
    //    此时 observed 为 null，不能据此判失败，改以 selfClose 为准。
    const observed = await readMyTaskStatus(taskId, CH, base);
    const expected = expectedMap[status];
    let ok;
    if (expected === 'done' || expected === 'closed') {
      ok = submitted || observed === expected;
    } else if (expected) {
      ok = observed === expected;
    } else {
      ok = submitted || !!observed;
    }
    return {
      success: ok,
      message: ok
        ? `状态已更新为 ${observed || expected}`
        : `更新未生效（当前仍为 ${observed || '未知'}）`,
      taskId: String(taskId),
      status: observed || (ok ? expected : null)
    };
  } catch (err) {
    console.error('[ZentaoService] 更新任务状态失败:', err.message);
    return { success: false, message: err.message, taskId: String(taskId), status: null };
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

    const base = config.zentao.url.replace(/\/$/, '');
    const CH = cookiesToString(cookies);
    const consumedBefore = await readMyTaskConsumed(taskId, CH, base);

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'Cookie': CH,
      },
      body: params.toString(),
      redirect: 'manual'
    });

    const text = await resp.text();
    const consumedAfter = await readMyTaskConsumed(taskId, CH, base);

    // 以「累计消耗是否增加」为准；若任务已不在「我的任务」（如已 done），改用 selfClose 收尾页判定
    const grew = consumedBefore != null && consumedAfter != null && consumedAfter > consumedBefore;
    const submitted = /selfClose|closeModal/.test(text);
    if (grew || submitted || text.includes('alert-success') || text.includes('保存成功') || text.includes('记录成功')) {
      console.log('[ZentaoService] 工时记录成功:', taskId, `${consumedBefore} -> ${consumedAfter}`);
      return { success: true, message: `工时已记录（累计消耗 ${consumedAfter != null ? consumedAfter : '?'} 小时）`, consumed: consumedAfter };
    }

    console.error('[ZentaoService] 工时记录未生效:', taskId, 'resp:', text.substring(0, 160));
    return { success: false, message: '工时记录未生效，请检查任务状态或参数' };
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

// ============================================================================
// 后端直连补全：看板 / 任务删除编辑 / Bug（替代扩展端标签页注入）
// 说明：全局 fetch 已统一注入浏览器 UA / Referer / Origin 头，因此这些写操作
//       在纯 Node 环境下行为与浏览器一致，不再需要打开禅道标签页。
// ============================================================================

function genUid() {
  return Math.random().toString(36).substring(2, 14);
}

/**
 * 从看板页面 HTML 解析创建任务/Bug 所需的全部参数
 * @param {string|number} executionId - 执行ID
 * @param {string} [laneType='task'] - 泳道类型 task/story/bug
 * @param {string} [columnType='wait'] - 列类型
 * @returns {Promise<{productId?, projectId?, regionId, laneId, columnId}|null>}
 */
/** 从 HTML 中按变量名提取嵌套对象字面量（花括号配平） */
function extractNestedObject(html, varName) {
  const start = html.match(new RegExp(varName + '\\s*=\\s*(\\{)'));
  if (!start) return null;
  const startPos = start.index + start[0].length - 1;
  let depth = 1;
  let endPos = startPos + 1;
  while (depth > 0 && endPos < html.length) {
    if (html[endPos] === '{') depth++;
    else if (html[endPos] === '}') depth--;
    endPos++;
  }
  return depth === 0 ? html.slice(startPos, endPos) : null;
}

async function getKanbanPageParams(executionId, laneType = 'task', columnType = 'wait') {
  try {
    const cookies = await getZentaoCookies();
    const base = config.zentao.url.replace(/\/$/, '');
    const resp = await fetch(`${base}/zentao/execution-kanban-${executionId}.html`, {
      headers: { Accept: 'text/html', Cookie: cookiesToString(cookies) }
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const html = await resp.text();

    const productMatch = html.match(/productID\s*=\s*(\d+);/);
    const projectMatch = html.match(/"project"\s*:\s*"(\d+)"/);

    // 从页面内嵌的 regions 数据解析 region / lane / column（最可靠）
    let regionId = null, laneId = null, columnId = null;
    const regionsStr = extractNestedObject(html, 'regions');
    if (regionsStr && regionsStr.includes('groups')) {
      try {
        const regions = JSON.parse(regionsStr);
        for (const rk of Object.keys(regions)) {
          const region = regions[rk];
          for (const g of (region.groups || [])) {
            if (!laneId) {
              const lane = (g.lanes || []).find((l) => l.type === laneType);
              if (lane) { laneId = lane.id; regionId = region.id || parseInt(rk); }
            }
            if (!columnId) {
              const col = (g.columns || []).find((c) => c.type === columnType);
              if (col) columnId = col.id;
            }
          }
          if (!regionId) regionId = region.id || parseInt(rk);
          if (laneId && columnId) break;
        }
      } catch (e) {
        console.warn('[ZentaoService] regions 解析失败，回退正则:', e.message);
      }
    }

    // 正则回退
    if (!regionId) {
      const rm = html.match(/<div\s+class="region[^"]*"\s+data-id="(\d+)"/)
        || html.match(/class="region[^"]*"[^>]*data-id="(\d+)"/);
      if (rm) regionId = parseInt(rm[1]);
    }
    if (!columnId) {
      const cm = html.match(new RegExp(`data-id="(\\d+)"\\s+data-type="${columnType}"`));
      if (cm) columnId = parseInt(cm[1]);
    }

    const result = {
      productId: productMatch ? productMatch[1] : null,
      projectId: projectMatch ? projectMatch[1] : null,
      regionId,
      laneId,
      columnId
    };
    console.log('[ZentaoService] 解析看板页面参数:', { executionId, laneType, columnType, ...result });
    return result;
  } catch (err) {
    console.error('[ZentaoService] 解析看板页面参数失败:', err.message);
    return null;
  }
}

/**
 * 快速检测执行是否为看板类型
 * @param {number|string} executionId
 * @returns {Promise<{isKanban: boolean, reason?: string}>}
 */
async function quickCheckKanban(executionId) {
  try {
    const cookies = await getZentaoCookies();
    const base = config.zentao.url.replace(/\/$/, '');
    // 直接看看板页面是否存在 .region 结构（kanban-view.json 对普通账号会返回 user-deny，无法用于判定）
    const resp = await fetch(`${base}/zentao/execution-kanban-${executionId}.html`, {
      headers: { Accept: 'text/html', Cookie: cookiesToString(cookies) }
    });
    if (!resp.ok) return { isKanban: false, reason: `HTTP ${resp.status}` };
    const html = await resp.text();
    const regionsStr = extractNestedObject(html, 'regions');
    if (regionsStr && regionsStr.includes('"groups"') && html.includes('kanban-lane')) {
      return { isKanban: true };
    }
    return { isKanban: false, reason: 'not_kanban' };
  } catch (err) {
    return { isKanban: false, reason: err.message };
  }
}

/**
 * 更新看板卡片状态（done → finishCard；in_progress/todo → activateCard）
 * @returns {Promise<{success: boolean, message?: string}>}
 */
async function updateKanbanCardStatus(cardId, kanbanId, status) {
  if (status === 'done' || status === 'closed') {
    return finishKanbanCard(cardId, kanbanId);
  }
  return activateKanbanCard(cardId, kanbanId);
}

/**
 * 删除禅道任务
 * @param {number|string} executionId
 * @param {number|string} taskId
 */
async function deleteTask(executionId, taskId) {
  try {
    const cookies = await getZentaoCookies();
    const base = config.zentao.url.replace(/\/$/, '');
    const CH = cookiesToString(cookies);
    const endpoint = `${base}/zentao/task-delete-${executionId}-${taskId}-yes-.html?onlybody=yes`;
    console.log('[ZentaoService] 删除任务:', endpoint);
    const resp = await fetch(endpoint, { method: 'GET', headers: { Cookie: CH }, redirect: 'manual' });
    const text = await resp.text();
    const successMark = /alert-success|删除成功|已删除|已经被删除/.test(text);
    // 回查：任务仍在执行列表说明未删除
    const remaining = await getTasks({ executionId });
    const stillThere = (remaining || []).some((t) => String(t.id) === String(taskId));
    if (!stillThere) return { success: true, message: '任务已删除' };
    if (successMark) return { success: true, message: '任务已删除' };
    return { success: false, message: '删除未生效' };
  } catch (err) {
    console.error('[ZentaoService] 删除任务失败:', err.message);
    return { success: false, message: err.message };
  }
}

/**
 * 编辑禅道任务（标题 / 优先级 / 指派）
 * 镜像浏览器：GET 编辑表单 → 回填 → POST 提交
 */
async function editTask({ taskId, execution, name, pri, assignedTo }) {
  try {
    const cookies = await getZentaoCookies();
    const base = config.zentao.url.replace(/\/$/, '');
    const CH = cookiesToString(cookies);
    const formUrl = `${base}/zentao/task-edit-${taskId}.html?onlybody=yes`;

    const getResp = await fetch(formUrl, { headers: { Cookie: CH } });
    const html = await getResp.text();
    const fields = extractFormFields(html);

    if (name) fields.name = name;
    if (pri != null && pri !== '') fields.pri = String(pri);
    if (assignedTo) fields.assignedTo = assignedTo;
    if (!fields.desc) fields.desc = name || fields.name || '';
    fields.uid = genUid();
    if (!('mode' in fields)) fields.mode = 'single';
    for (let i = 0; i < 5; i++) {
      if (!(`team[${i}]` in fields)) { fields['team[]'] = fields['team[]'] ?? ''; }
    }

    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) params.append(k, v == null ? '' : v);

    const postResp = await fetch(`${base}/zentao/task-edit-${taskId}.html`, {
      method: 'POST',
      headers: { Cookie: CH, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      redirect: 'manual'
    });
    const text = await postResp.text();
    const ok = /alert-success|保存成功|记录成功|selfClose|location/.test(text)
      || postResp.status === 301 || postResp.status === 302;
    if (ok) return { success: true, message: '任务已更新' };
    const errMatch = text.match(/alert-danger[^>]*>([^<]+)</);
    return { success: false, message: errMatch ? errMatch[1] : '编辑未生效' };
  } catch (err) {
    console.error('[ZentaoService] 编辑任务失败:', err.message);
    return { success: false, message: err.message };
  }
}

/**
 * 获取普通执行关联的产品ID（用于创建 Bug）
 */
async function getExecutionProductId(executionId) {
  try {
    const cookies = await getZentaoCookies();
    const base = config.zentao.url.replace(/\/$/, '');
    const CH = cookiesToString(cookies);
    const resp = await fetch(`${base}/zentao/execution-bug-${executionId}.html`, {
      headers: { Accept: 'text/html', Cookie: CH }
    });
    const html = await resp.text();
    let m = html.match(new RegExp(`bug-create-(\\d+)-0-executionID=${executionId}`))
      || html.match(new RegExp(`bug-create-(\\d+)-[\\d-]*executionID=${executionId}`))
      || html.match(/bug-create-(\d+)-/);
    if (m) return { success: true, productId: m[1] };
    return { success: false, reason: 'product_id_not_found' };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

/** 组装创建 Bug 的表单（与浏览器注入脚本保持完全一致） */
function buildBugForm(bugData, productId, executionId, projectId) {
  const fd = new FormData();
  fd.append('product', productId);
  fd.append('module', '0');
  if (projectId) fd.append('project', projectId);
  if (executionId) fd.append('execution', executionId);
  fd.append('openedBuild[]', bugData.openedBuild || 'trunk');
  const assignedTo = bugData.assignedTo
    || (Array.isArray(bugData.assignedToList) && bugData.assignedToList[0]) || '';
  if (assignedTo) fd.append('assignedTo', assignedTo);
  fd.append('deadline', '');
  fd.append('feedbackBy', '');
  fd.append('notifyEmail', '');
  fd.append('type', bugData.type || 'codeerror');
  fd.append('os[]', '');
  fd.append('browser[]', '');
  if (bugData.regionId) fd.append('region', bugData.regionId);
  if (bugData.laneId) fd.append('lane', bugData.laneId);
  fd.append('title', bugData.title);
  fd.append('color', '');
  fd.append('severity', String(bugData.severity || 3));
  fd.append('pri', String(bugData.pri || 3));
  fd.append('steps', bugData.steps || '');
  fd.append('story', '');
  fd.append('task', '');
  fd.append('oldTaskID', '0');
  if (Array.isArray(bugData.cc)) bugData.cc.forEach((c) => { if (c) fd.append('mailto[]', c); });
  fd.append('keywords', '');
  fd.append('status', 'active');
  fd.append('issueKey', '');
  fd.append('uid', genUid());
  fd.append('case', '0');
  fd.append('caseVersion', '0');
  fd.append('result', '0');
  fd.append('testtask', '0');
  return fd;
}

/** 从禅道 Bug 列表 JSON 中按标题查找 Bug ID（列表按 id 倒序，新建的排在最前） */
async function findBugIdByTitle(title, productId, executionId) {
  if (!title) return null;
  try {
    const cookies = await getZentaoCookies();
    const base = config.zentao.url.replace(/\/$/, '');
    const CH = cookiesToString(cookies);
    const target = String(title).trim();

    const tryList = async (path) => {
      const resp = await fetch(`${base}/zentao/${path}`, {
        headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Cookie: CH }
      });
      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); } catch { return null; }
      let inner = data.data;
      if (typeof inner === 'string') { try { inner = JSON.parse(inner); } catch { /* noop */ } }
      const bugs = inner && inner.bugs;
      if (!Array.isArray(bugs)) return null;
      const hit = bugs.find((b) => String(b.title || '').trim() === target);
      return hit && hit.id != null ? String(hit.id) : null;
    };

    if (productId) {
      const id = await tryList(`bug-browse-${productId}-0-all-0-id_desc.json?onlybody=yes`);
      if (id) return id;
    }
    if (executionId) {
      const id = await tryList(`execution-bug-${executionId}-0-all-0-id_desc.json?onlybody=yes`);
      if (id) return id;
    }
    return null;
  } catch (e) {
    return null;
  }
}

/**
 * 创建 Bug（看板 / 普通执行通用）
 * @param {Object} bugData - 同浏览器端 executeBugInZentaoPage 的 bugData
 */
async function createBug(bugData) {
  try {
    const cookies = await getZentaoCookies();
    const base = config.zentao.url.replace(/\/$/, '');
    const CH = cookiesToString(cookies);
    const executionId = bugData.executionId || '';
    const projectId = bugData.projectId || '';
    let productId = bugData.productId;
    if (!productId) {
      const p = await getExecutionProductId(executionId);
      productId = p.productId;
    }
    if (!productId) return { success: false, message: '缺少 productId' };

    const isKanban = bugData.regionId && bugData.laneId && bugData.columnId;
    const endpoint = isKanban
      ? `${base}/zentao/bug-create-${productId}-0-regionID=${bugData.regionId},laneID=${bugData.laneId},columnID=${bugData.columnId},executionID=${executionId}.html?onlybody=yes`
      : `${base}/zentao/bug-create-${productId}-0-executionID=${executionId}.html`;

    console.log('[ZentaoService] 创建 Bug:', bugData.title, isKanban ? '(看板)' : '(普通)', endpoint);

    const fd = buildBugForm(bugData, productId, executionId, projectId);
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Cookie: CH,
        Accept: 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: fd
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { return { success: false, message: '响应解析失败', responseText: text.slice(0, 300) }; }

    let inner = data.data;
    if (typeof inner === 'string') { try { inner = JSON.parse(inner); } catch { /* noop */ } }

    if (inner && inner.locate && String(inner.locate).includes('user-deny')) {
      return { success: false, message: '没有创建 Bug 的权限', responseData: data };
    }

    if (data.result === 'success' || data.status === 'success' || data.locate || data.callback) {
      let bugId = data.id || data.bug?.id || inner?.id || null;
      if (!bugId && data.callback) {
        const m = String(data.callback).match(/bug-view-(\d+)/);
        if (m) bugId = m[1];
      }
      if (!bugId) bugId = await findBugIdByTitle(bugData.title, productId, executionId);
      return {
        success: true,
        bugId: bugId || null,
        message: bugId ? `Bug 已创建（ID ${bugId}）` : 'Bug 已提交',
        responseData: data
      };
    }
    return { success: false, message: data.message || '创建 Bug 失败', responseData: data };
  } catch (err) {
    console.error('[ZentaoService] 创建 Bug 异常:', err.message);
    return { success: false, message: err.message };
  }
}

/** 激活 Bug（bug-confirmbug） */
async function activateBug({ bugId, assignedTo, pri, type, ccList, comment }) {
  try {
    const cookies = await getZentaoCookies();
    const base = config.zentao.url.replace(/\/$/, '');
    const CH = cookiesToString(cookies);
    const params = new URLSearchParams();
    params.append('assignedTo', assignedTo || '');
    params.append('type', type || 'codeerror');
    params.append('pri', String(pri || '3'));
    params.append('status', 'active');
    if (assignedTo) params.append('mailto[]', assignedTo);
    if (Array.isArray(ccList)) ccList.forEach((c) => { if (c) params.append('mailto[]', c); });
    params.append('comment', comment || '');
    params.append('uid', genUid());
    const resp = await fetch(`${base}/zentao/bug-confirmbug-${bugId}.html?onlybody=yes`, {
      method: 'POST',
      headers: { Cookie: CH, 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
      body: params.toString()
    });
    if (resp.ok) return { success: true, message: 'Bug 已激活' };
    return { success: false, message: `HTTP ${resp.status}` };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/** 解决 Bug（bug-resolve） */
async function resolveBug({ bugId, resolution, assignedTo, comment }) {
  try {
    const cookies = await getZentaoCookies();
    const base = config.zentao.url.replace(/\/$/, '');
    const CH = cookiesToString(cookies);
    const fd = new FormData();
    fd.append('resolution', resolution || 'fixed');
    fd.append('duplicateBug', '0');
    fd.append('buildExecution', '');
    fd.append('resolvedBuild', 'trunk');
    fd.append('resolvedDate', '');
    if (assignedTo) fd.append('assignedTo', assignedTo);
    fd.append('status', 'resolved');
    fd.append('comment', comment || '');
    fd.append('uid', genUid());
    const resp = await fetch(`${base}/zentao/bug-resolve-${bugId}.html?onlybody=yes`, {
      method: 'POST',
      headers: { Cookie: CH, 'X-Requested-With': 'XMLHttpRequest' },
      body: fd
    });
    if (resp.ok) return { success: true, message: 'Bug 已解决' };
    return { success: false, message: `HTTP ${resp.status}` };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/** 关闭 Bug（bug-close） */
async function closeBug({ bugId, comment }) {
  try {
    const cookies = await getZentaoCookies();
    const base = config.zentao.url.replace(/\/$/, '');
    const CH = cookiesToString(cookies);
    const fd = new FormData();
    fd.append('status', 'closed');
    fd.append('comment', comment || '');
    fd.append('uid', genUid());
    const resp = await fetch(`${base}/zentao/bug-close-${bugId}.html?onlybody=yes`, {
      method: 'POST',
      headers: { Cookie: CH, 'X-Requested-With': 'XMLHttpRequest' },
      body: fd
    });
    if (resp.ok) return { success: true, message: 'Bug 已关闭' };
    return { success: false, message: `HTTP ${resp.status}` };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/** 删除 Bug（bug-delete-{id}-yes） */
async function deleteBug(bugId) {
  try {
    const cookies = await getZentaoCookies();
    const base = config.zentao.url.replace(/\/$/, '');
    const CH = cookiesToString(cookies);
    const resp = await fetch(`${base}/zentao/bug-delete-${bugId}-yes-.html`, {
      method: 'GET',
      headers: { Cookie: CH }
    });
    if (resp.ok) return { success: true, message: 'Bug 已删除' };
    return { success: false, message: `HTTP ${resp.status}` };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/** 读取 Bug 详情中的指派人 / 抄送人（用于同步前的预填） */
async function getBugDetail(bugId) {
  try {
    const cookies = await getZentaoCookies();
    const base = config.zentao.url.replace(/\/$/, '');
    const CH = cookiesToString(cookies);
    const result = { assignedTo: '', cc: [] };
    // 内页（onlybody）优先，失败再退回整页
    for (const url of [
      `${base}/zentao/bug-view-${bugId}.html?onlybody=yes`,
      `${base}/zentao/bug-view-${bugId}.html`
    ]) {
      const resp = await fetch(url, { headers: { Accept: 'text/html', Cookie: CH } });
      const html = await resp.text();
      const openerMatch = html.match(/name=["']openedBy["'][^>]*value=["']([^"']*)["']/i);
      if (openerMatch && !result.assignedTo) result.assignedTo = openerMatch[1].trim();
      const ccRe = /name=["']cc\[\]["'][^>]*value=["']([^"']*)["']/gi;
      let m;
      while ((m = ccRe.exec(html)) !== null) {
        if (m[1].trim()) result.cc.push(m[1].trim());
      }
      if (result.assignedTo || result.cc.length) break;
    }
    return result;
  } catch (err) {
    return { assignedTo: '', cc: [] };
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
  getMyTasks,
  syncMyTasks,
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
  deleteKanbanCard,
  // 后端直连补全（替代扩展端标签页注入）
  getKanbanPageParams,
  quickCheckKanban,
  updateKanbanCardStatus,
  deleteTask,
  editTask,
  getExecutionProductId,
  createBug,
  activateBug,
  resolveBug,
  closeBug,
  deleteBug,
  getBugDetail
};
