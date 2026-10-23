import { config } from '../config.js';
import { decodeZentaoText } from '../utils/text.js';
import { createHash } from 'crypto';

// 存储 cookie（内存中）
let zentaoCookies = null;
let zentaoCookieExpiry = null;
// 正在进行的登录（并发请求共用一次登录，避免同时打出多次登录）
let loginInFlight = null;

// 禅道登录用的 md5（与前台 md5.js 行为一致：小写十六进制）
const md5 = (s) => createHash('md5').update(String(s), 'utf8').digest('hex');

// 关键修复：禅道对「缺少浏览器 User-Agent 的写操作 POST」只返回表单视图、不真正执行动作
// （状态变更 task-start/task-finish、工时记录 task-recordEstimate 都会静默失败）。
// 这里为发往禅道的请求注入浏览器头，使后端行为与浏览器一致。
const ZENTAO_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// 单个禅道请求的超时：内网不可达时 Node 默认要等 10s（连接）~300s（响应头）
const ZENTAO_TIMEOUT_MS = 15000;
const globalFetch = globalThis.fetch.bind(globalThis);

function zentaoBase() {
  return (config.zentao?.url || '').replace(/\/$/, '');
}

function parseCookieHeader(header) {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}

/**
 * 小响应体里是否是「会话已失效」：
 *   - JSON：{"result":false,"message":"登录已超时，请重新登入!"}
 *   - HTML：一段跳转到 user-login 的脚本
 * 正常页面都远大于这个长度，只检查小响应，避免误判和额外开销。
 */
function looksLikeSessionExpired(resp, text) {
  if (resp.status >= 300 && resp.status < 400) {
    return /user-login/.test(resp.headers.get('location') || '');
  }
  if (text.length > 4000) return false;
  return /登录已超时|\\u767b\\u5f55\\u5df2\\u8d85\\u65f6/.test(text) ||
    /location(\.href)?\s*=\s*['"][^'"]*user-login/.test(text);
}

/**
 * 发往禅道的 fetch：
 *   1. 注入浏览器 UA / Referer / Origin（只对禅道请求，不再全局改写 fetch）
 *   2. 统一超时
 *   3. 会话失效时自动重新登录并重试一次（init._noSessionRetry 可关闭，登录流程自身使用）
 *
 * 模块内的 fetch 都指向它，因此本文件里所有禅道请求自动获得以上能力。
 */
async function zentaoFetch(input, init = {}) {
  const { _noSessionRetry, timeout, ...rest } = init;
  const base = zentaoBase();
  const headers = new Headers(rest.headers || {});
  if (!headers.has('User-Agent')) headers.set('User-Agent', ZENTAO_UA);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json, text/javascript, */*; q=0.01');
  if (!headers.has('Accept-Language')) headers.set('Accept-Language', 'zh-CN,zh;q=0.9');
  const method = (rest.method || 'GET').toUpperCase();
  // 禅道对写操作会校验来源，缺失 UA/Referer/Origin 时只返回表单、不执行动作
  if (!headers.has('Referer')) headers.set('Referer', `${base}/zentao/`);
  if (method !== 'GET' && method !== 'HEAD' && !headers.has('Origin')) headers.set('Origin', base);

  const send = (h) => globalFetch(input, {
    ...rest,
    headers: h,
    signal: rest.signal || AbortSignal.timeout(timeout || ZENTAO_TIMEOUT_MS)
  });

  const resp = await send(headers);
  const sentCookie = headers.get('Cookie');
  if (_noSessionRetry || !sentCookie) return resp;

  const text = await resp.clone().text();
  if (!looksLikeSessionExpired(resp, text)) return resp;

  // 会话失效：如果缓存里已经是别人刷新过的新会话就直接用，否则作废后重新登录
  const sentSid = parseCookieHeader(sentCookie).zentaosid;
  if (!zentaoCookies || zentaoCookies.zentaosid === sentSid) {
    console.log('[ZentaoService] 会话已失效，重新登录后重试');
    clearCookies();
  }
  const fresh = await getZentaoCookies();
  const retryHeaders = new Headers(headers);
  retryHeaders.set('Cookie', cookiesToString({ ...parseCookieHeader(sentCookie), ...fresh }));
  return send(retryHeaders);
}

// 本模块内的禅道请求一律走 zentaoFetch
const fetch = zentaoFetch;

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

  try {
    // 1. 初始会话
    const loginPageResp = await fetch(`${base}/zentao/user-login.html`, { _noSessionRetry: true });
    collectCookies(loginPageResp, cookies);
    await loginPageResp.text();

    // 2. 获取随机数 rand
    const randResp = await fetch(`${base}/zentao/user-refreshRandom.html`, {
      _noSessionRetry: true,
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
      _noSessionRetry: true,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'Cookie': cookiesToString(cookies),
        'Referer': `${base}/zentao/user-login.html`,
        'Origin': base
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
  } catch (err) {
    if (/^登录失败/.test(err.message)) throw err;
    throw new Error(describeZentaoTransportError(err, base));
  }
}

/**
 * 获取有效的禅道 cookie（带缓存；并发调用只登录一次）
 * @returns {Promise<Object>} cookies 对象
 */
async function getZentaoCookies() {
  if (!config.zentao.enabled) {
    throw new Error('禅道未启用');
  }
  if (!config.zentao.url || !config.zentao.username || !config.zentao.password) {
    throw new Error('禅道配置不完整');
  }

  // 缓存 1 小时；会话提前失效由 zentaoFetch 检测后自动重登
  if (zentaoCookies && zentaoCookieExpiry && Date.now() < zentaoCookieExpiry) {
    return zentaoCookies;
  }

  if (!loginInFlight) {
    console.log('[ZentaoService] Cookie 过期或不存在，重新登录...');
    loginInFlight = loginZentao(config.zentao.url, config.zentao.username, config.zentao.password)
      .then((cookies) => {
        zentaoCookies = cookies;
        zentaoCookieExpiry = Date.now() + 60 * 60 * 1000;
        return cookies;
      })
      .finally(() => {
        loginInFlight = null;
      });
  }
  return loginInFlight;
}

/**
 * 作废缓存的会话（配置变更、会话失效时调用）
 */
function clearCookies() {
  zentaoCookies = null;
  zentaoCookieExpiry = null;
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
 * 日期 → 禅道日期字段（deadline / estStarted / begin）能接受的 YYYY-MM-DD
 *
 * 新建任务表单的截止日期是 datetime-local，存下来是「2026-10-30T13:51」，
 * 原样提交禅道会报「『截止日期』应当为合法的日期」，整个任务建不出来。
 * 带时区的 ISO 时间（toISOString 产物）按本地日期取，其余直接取字面上的日期部分。
 * @returns {string} 无法识别时返回空串（禅道视为未填）
 */
function toZentaoDate(value) {
  if (!value) return '';
  const str = String(value).trim();
  if (/^0000/.test(str)) return '';
  const p = (n) => String(n).padStart(2, '0');
  const hasZone = /T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(str);
  const m = !hasZone && str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]|$)/);
  if (m) return `${m[1]}-${p(m[2])}-${p(m[3])}`;
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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
    formData.append('estStarted', toZentaoDate(taskData.estStarted));
    formData.append('deadline', toZentaoDate(taskData.dueDate));
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
 * @param {string} [baseUrl] - 目标禅道地址（默认取配置）
 * @returns {string}
 */
function describeZentaoTransportError(err, baseUrl) {
  const msg = String((err && err.message) || err || '未知错误');
  const base = (baseUrl || zentaoBase()) || '(未配置禅道地址)';
  if (err && (err.name === 'TimeoutError' || /timeout|timed out|aborted/i.test(msg))) {
    return `连接禅道 ${base} 超时（${ZENTAO_TIMEOUT_MS / 1000} 秒无响应：请确认已连内网 / VPN）`;
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ECONNRESET|EAI_AGAIN|network/i.test(msg)) {
    return `无法连接禅道 ${base}（网络不可达：请确认已连内网 / VPN，以及地址与端口是否正确）`;
  }
  return msg;
}

/**
 * 解析禅道 `{status, data:"<json 字符串>"}` 外壳
 */
async function readZentaoJson(resp) {
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const outer = await resp.json();
  if (outer && outer.result === false) {
    throw new Error(outer.message || '禅道返回失败');
  }
  return typeof outer.data === 'string' ? JSON.parse(outer.data) : outer.data;
}

/** 「我的地盘」列表每页条数（禅道默认 20，只取第一页会漏数据） */
const MY_LIST_PAGE_SIZE = 500;

/**
 * 拉取「我的地盘」下的完整列表（自动翻页）
 * @param {'task'|'bug'} kind - my-task / my-bug
 * @param {string} type - assignedTo / openedBy 等
 * @param {string} [cookieHeader] - 不传则自动取会话
 * @returns {Promise<{items: Array, users: Object}>}
 */
async function fetchMyList(kind, type = 'assignedTo', cookieHeader) {
  const CH = cookieHeader || cookiesToString(await getZentaoCookies());
  const listKey = kind === 'bug' ? 'bugs' : kind === 'story' ? 'stories' : 'tasks';
  const items = [];
  let users = {};
  for (let page = 1; page <= 50; page++) {
    const endpoint = `${zentaoBase()}/zentao/my-${kind}-${type}-0-id_desc-0-${MY_LIST_PAGE_SIZE}-${page}.json`;
    const resp = await fetch(endpoint, {
      headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'Cookie': CH }
    });
    const inner = await readZentaoJson(resp);
    const list = inner && inner[listKey];
    const pageItems = Array.isArray(list) ? list : Object.values(list || {});
    items.push(...pageItems);
    if (inner && inner.users && typeof inner.users === 'object') users = { ...users, ...inner.users };
    const pageTotal = Number(inner?.pager?.pageTotal) || 1;
    if (page >= pageTotal || pageItems.length === 0) break;
  }
  return { items, users };
}

/**
 * 查询"我的任务"（地盘 → 我的任务，指派给我，自动翻页）
 * @returns {Promise<Array>} 任务列表
 * @throws {Error} 禅道不可达、登录失败或返回异常时抛出（不再静默返回空数组）
 */
async function getMyTasks() {
  try {
    const { items } = await fetchMyList('task', 'assignedTo');
    return items.filter(t => String(t.deleted) !== '1').map(toMyTask);
  } catch (err) {
    console.error('[ZentaoService] 查询我的任务失败:', err.message);
    // 关键：这里不能 return []。空数组和「禅道不可达」在下游长得一模一样，
    // 结果是同步接口返回 success:true / 0 条，用户看到绿色「同步完成」，
    // 实际一条都没拉到。必须把失败抛出去，让调用方如实报错。
    throw new Error(describeZentaoTransportError(err));
  }
}

/** 禅道任务（列表项或详情）→ 同步用的字段 */
function toMyTask(t) {
  return {
    id: String(t.id),
    name: decodeZentaoText(t.name),
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
    executionName: decodeZentaoText(t.executionName),
    projectName: decodeZentaoText(t.projectName),
    progress: t.progress
  };
}

/**
 * 查禅道里一个任务 / Bug 是否还在
 *
 * 「我的地盘」列表只列指派给我 / 我提的，禅道里被删除的不在里面，
 * 本地却还留着记录（曾经 Bug 496 在禅道已删除，插件里一直显示），只能逐个查详情。
 * 看板里的任务，普通详情只返回跳转地址，onlybody 版才有数据。
 *
 * @param {'task'|'bug'} kind
 * @returns {Promise<'alive'|'gone'|'unknown'>}
 *   gone = 禅道里已删除或不存在；unknown = 查不了（网络、会话等），本地记录保持不动
 */
async function lookupZentaoObject(kind, id, CH) {
  try {
    const resp = await fetch(`${zentaoBase()}/zentao/${kind}-view-${id}.json?onlybody=yes`, {
      headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'Cookie': CH }
    });
    if (!resp.ok) return 'unknown';
    const text = await resp.text();
    let inner;
    try {
      const outer = JSON.parse(text);
      inner = typeof outer.data === 'string' ? JSON.parse(outer.data) : outer.data;
    } catch {
      // 对象不存在时禅道在失败结果后面又拼了一段跳转 JSON，整体不是合法 JSON，只取第一段
      const m = text.match(/^\s*\{"status":"[^"]*","data":"((?:[^"\\]|\\.)*)"/);
      if (!m) return 'unknown';
      inner = JSON.parse(JSON.parse(`"${m[1]}"`));
    }
    if (inner && inner.result === 'fail') {
      return /不存在/.test(String(inner.message || '')) ? 'gone' : 'unknown';
    }
    const item = inner && inner[kind];
    if (!item || !item.id) return 'unknown';
    return String(item.deleted) === '1' ? 'gone' : 'alive';
  } catch {
    return 'unknown';
  }
}

/**
 * 本地有、列表里没有的记录里，挑出禅道里已删除的（限制并发）
 *
 * 只删不刷新：本地有早年关联错的记录（插件建的任务记成了 2023 年别人的任务 ID），
 * 按 ID 拿详情覆盖会把本地任务改成另一个任务。
 * @returns {Promise<string[]>}
 */
async function findDeletedInZentao(kind, ids, CH, concurrency = 6) {
  const gone = [];
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      if (await lookupZentaoObject(kind, id, CH) === 'gone') gone.push(String(id));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
  return gone;
}

/** 和我有关的 Bug：「我的地盘 → Bug」的 指派给我 / 由我创建 / 抄送给我 / 由我指派 */
const MY_BUG_LISTS = ['assignedTo', 'openedBy', 'mailto', 'assignedBy'];

/**
 * 禅道 Bug 状态 → 本地状态
 * active 且未确认 = unconfirmed，active 且已确认 = activated
 */
function mapZentaoBugStatus(b) {
  if (b.status === 'resolved') return 'resolved';
  if (b.status === 'closed') return 'closed';
  return String(b.confirmed) === '1' ? 'activated' : 'unconfirmed';
}

/**
 * 同步「我的 Bug」到本地：
 *   - 和我有关的（「我的地盘 → Bug」里的 指派给我 / 由我创建 / 抄送给我 / 由我指派）、还没解决的（激活）：新增或更新
 *   - 已解决、已关闭的不新增；本地已有的照样按禅道刷新状态（在插件里解决的 Bug 会进「已解决」）
 *   - 本地有、这几个列表里都没有的：逐个查详情，禅道里已删除的删掉本地记录
 * 以前只新增「指派给我」的，「由我创建」的只刷新本地已有记录：没人指派给我时（实测 0 个），
 * 本地数据清空后 Bug 列表就一直是空的，自己提的 53 个激活 Bug 一个都看不到。
 * @returns {Promise<{added:number, updated:number, unchanged:number, skipped:number, removed:number, total:number}>}
 */
async function syncMyBugs() {
  const { importZentaoBugs } = await import('./bugManager.js');
  const { readTasks } = await import('../utils/storage.js');

  const { removeZentaoDeleted } = await import('./taskManager.js');

  let related;
  let CH;
  try {
    CH = cookiesToString(await getZentaoCookies());
    const live = (b) => String(b.deleted) !== '1';
    related = [];
    for (const type of MY_BUG_LISTS) related.push(...(await fetchMyList('bug', type, CH)).items.filter(live));
  } catch (err) {
    console.error('[ZentaoService] 查询我的Bug失败:', err.message);
    throw new Error(describeZentaoTransportError(err));
  }

  const localBugIds = new Set(
    ((await readTasks()).tasks || [])
      .filter(t => t.type === 'bug' && t.zentaoId)
      .map(t => String(t.zentaoId))
  );

  const listed = new Set(related.map(b => String(b.id)));
  const deleted = await findDeletedInZentao('bug', [...localBugIds].filter(id => !listed.has(id)), CH);

  const picked = new Map();
  related
    .filter(b => b.status === 'active' || localBugIds.has(String(b.id)))
    .forEach(b => picked.set(String(b.id), b));

  const mapped = [...picked.values()].map(b => ({
    zentaoId: Number(b.id),
    title: decodeZentaoText(b.title),
    status: mapZentaoBugStatus(b),
    severity: Number(b.severity) || 3,
    priority: Number(b.pri) || 3,
    bugType: b.type || 'codeerror',
    productId: b.product ? String(b.product) : '',
    productName: decodeZentaoText(b.productName || ''),
    openedBy: b.openedBy || '',
    resolvedBy: b.resolvedBy || '',
    resolution: b.resolution || '',
    confirmed: String(b.confirmed) === '1',
    assignedTo: b.assignedTo || '',
    assignedDate: b.assignedDate || '',
    executionId: b.execution && b.execution !== '0' ? String(b.execution) : null,
    projectId: b.project && b.project !== '0' ? String(b.project) : null
  }));

  const result = await importZentaoBugs(mapped);
  const removed = await removeZentaoDeleted('bug', deleted);
  return { ...result, removed, total: mapped.length };
}

/**
 * 从禅道拉取团队成员（我的地盘 → 团队），写入本地缓存 data/zentao-users.json
 * @returns {Promise<Object>} { account: realname }
 */
async function refreshZentaoUsers() {
  const { saveZentaoUsers } = await import('../config.js');
  const CH = cookiesToString(await getZentaoCookies());
  const resp = await fetch(`${zentaoBase()}/zentao/my-team-0-id_asc-0-500-1.json`, {
    headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'Cookie': CH }
  });
  const inner = await readZentaoJson(resp);
  const list = Array.isArray(inner?.users) ? inner.users : Object.values(inner?.users || {});
  const users = {};
  list.forEach(u => {
    if (u && u.account && u.deleted !== '1') users[u.account] = u.realname || u.account;
  });
  if (Object.keys(users).length === 0) {
    throw new Error('禅道返回的团队成员为空');
  }
  saveZentaoUsers(users);
  return users;
}

/**
 * 禅道任务进度：已完成/关闭 = 100；禅道给了进度就用；有预计工时就按消耗折算；
 * 都没有（未填预计工时）返回 null，表示「禅道算不出来」，同步时保留本地进度
 */
function zentaoProgress(t) {
  if (['done', 'closed'].includes(t.status)) return 100;
  if (Number(t.progress) > 0) return Number(t.progress);
  if (Number(t.estimate) > 0) return Math.min(100, Math.round((Number(t.consumed) / Number(t.estimate)) * 100));
  return null;
}

/** 禅道任务状态 → 本地状态 */
const TASK_STATUS_TO_LOCAL = {
  wait: 'todo', pause: 'todo', doing: 'in_progress',
  done: 'done', closed: 'done', cancel: 'done'
};

/**
 * 后端同步「我的任务」和「我的 Bug」到本地
 * 任务：拉取 my-task（全部分页）→ 新增/更新 wait / doing 的活跃任务；
 *       本地已有的任务无论禅道里是什么状态都刷新（禅道里被完成/关闭/取消的，本地也跟着完成），
 *       避免历史上上百个已完成任务全被拉进来，同时不让本地残留「禅道已完成、本地还开着」的任务
 *       本地有、但不在 my-task 里的逐个查详情，禅道里已删除的删掉本地记录
 * Bug：见 syncMyBugs；Bug 同步失败不影响任务同步结果，单独在 bugError 里报告
 * @returns {Promise<{added:number, updated:number, unchanged:number, skipped:number, removed:number, total:number, bugs:Object|null, bugError:string|null}>}
 */
async function syncMyTasks() {
  const { importZentaoTasks, removeZentaoDeleted } = await import('./taskManager.js');
  const { readTasks } = await import('../utils/storage.js');
  const raw = await getMyTasks();

  const localTaskIds = new Set(
    ((await readTasks()).tasks || [])
      .filter(t => t.type !== 'bug' && t.zentaoId)
      .map(t => String(t.zentaoId))
  );
  const listed = new Set(raw.map(t => t.id));
  const deleted = await findDeletedInZentao(
    'task',
    [...localTaskIds].filter(id => !listed.has(id)),
    cookiesToString(await getZentaoCookies())
  );
  const picked = raw.filter((t) =>
    t.status === 'wait' || t.status === 'doing' || localTaskIds.has(String(t.id)));
  const mapped = picked.map((t) => ({
    zentaoId: t.id,
    title: t.name,
    status: TASK_STATUS_TO_LOCAL[t.status] || 'todo',
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
    progress: zentaoProgress(t)
  }));

  const result = await importZentaoTasks(mapped);
  const removed = await removeZentaoDeleted('task', deleted);

  let bugs = null;
  let bugError = null;
  try {
    bugs = await syncMyBugs();
  } catch (err) {
    bugError = err.message;
  }

  const active = picked.filter((t) => t.status === 'wait' || t.status === 'doing').length;
  return { ...result, removed, total: active, refreshed: mapped.length, bugs, bugError };
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
/**
 * 从禅道动作表单里取出默认字段值（提交时原样带回，只覆盖要改的字段）
 *
 * 必须如实带回所有字段，否则提交会把没带的字段改成空值：
 *   - textarea 取原有内容（旧实现一律置空，再由 editTask 用标题填 desc ——
 *     改一次优先级/标题，禅道里的任务描述就被替换成标题）
 *   - 多选（mailto[] 抄送、team[] 等）取全部选中项（旧实现只取第一个，抄送人会丢）
 *
 * @returns {Object<string, string|string[]>} 多选字段的值为数组
 */
function extractFormFields(html) {
  const start = html.indexOf('<form');
  const end = html.indexOf('</form>', start);
  const region = start >= 0 ? html.slice(start, end > 0 ? end : html.length) : html;
  const attr = (s, n) => {
    const m = s.match(new RegExp('\\b' + n + `\\s*=\\s*['"]([^'"]*)['"]`, 'i'));
    return m ? m[1] : '';
  };
  const decode = (s) => String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  const fields = {};
  for (const m of region.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    const name = attr(tag, 'name');
    if (!name) continue;
    const type = (attr(tag, 'type') || 'text').toLowerCase();
    if (['file', 'submit', 'button', 'image', 'reset'].includes(type)) continue;
    if ((type === 'checkbox' || type === 'radio') && !/\bchecked\b/i.test(tag)) continue;
    let value = decode(attr(tag, 'value'));
    if (value.includes('+')) value = ''; // 模板占位（如 uid 的 " + kuid + "）
    fields[name] = value;
  }
  for (const m of region.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const name = attr(m[1], 'name');
    if (!name) continue;
    const selected = [...m[2].matchAll(/<option\b[^>]*>/gi)]
      .map(o => o[0])
      .filter(o => /\bselected\b/i.test(o))
      .map(o => decode(attr(o, 'value')));
    const multiple = /\bmultiple\b/i.test(m[1]) || name.endsWith('[]');
    fields[name] = multiple ? selected : (selected[0] ?? '');
  }
  for (const m of region.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
    const name = attr(m[1], 'name');
    if (name) fields[name] = decode(m[2]);
  }
  delete fields['labels[]'];
  delete fields['files[]'];
  delete fields.uid;
  return fields;
}

/**
 * 表单字段 → 提交体（数组字段逐项 append，空数组按禅道约定提交一个空值）
 */
function toFormBody(fields) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) {
      if (v.length === 0) params.append(k, '');
      else v.forEach(item => params.append(k, item == null ? '' : item));
    } else {
      params.append(k, v == null ? '' : v);
    }
  }
  return params;
}

/**
 * 判断禅道动作表单/工时接口的响应是否代表「操作成功」。
 *
 * 背景（真实 bug，2026-10-14）：工时记录明明成功，却一直报「工时记录未生效」。
 * 原因是禅道的收尾脚本不止一种形态，原先只认 selfClose / closeModal，
 * 而 recordEstimate 接口实际返回的是：
 *   <script>if(typeof(parent.parent.ajaxRefresh) == 'function') parent.parent.ajaxRefresh()</script>
 * 这是禅道操作成功后的标准收尾脚本（ajaxRefresh 表示要刷新父页面），
 * 被漏判成失败 —— 禅道里工时其实已经记上了。
 *
 * 判定原则：**宁可信任禅道的成功标志，也不要因为回读校验失败就报错**。
 * 回读（readMyTaskStatus 等）只能查「我的任务」列表，任务一旦closed/done
 * 就会从列表消失、读不到，任何依赖它的判定都会误报。
 */
/**
 * 从禅道提交失败的响应里取出报错文案
 * 失败时禅道返回 {"result":"fail","message":{"字段":["原因"]}} 或带 alert('原因') 的页面
 * @returns {string} 没有可识别的原因时返回空串
 */
function extractZentaoError(text) {
  const t = String(text || '');
  try {
    const j = JSON.parse(t);
    const m = j && j.message;
    if (typeof m === 'string') return m;
    if (m && typeof m === 'object') {
      return Object.values(m).flat().map(String).join('；');
    }
  } catch { /* 不是 JSON */ }
  const alert = t.match(/alert\(\s*['"]((?:\\.|[^'"\\])+)['"]/);
  if (alert) {
    try { return JSON.parse(`"${alert[1]}"`); } catch { return alert[1]; }
  }
  return '';
}

function isZentaoSubmitSuccess(text) {
  if (!text) return false;
  const t = String(text);
  // 禅道各类收尾脚本：刷新父页面 / 关闭弹窗 / 直接关窗
  if (/parent\.parent\.ajaxRefresh/.test(t)) return true;
  if (/selfClose|closeModal|window\.close\(\)/.test(t)) return true;
  // 显式的成功文案（部分版本直接回显提示）
  if (/alert-success|保存成功|记录成功|操作成功|更新成功/.test(t)) return true;
  // 跳转到详情/列表页、或刷新父页面：编辑任务成功后禅道返回
  //   <script>parent.location='/zentao/task-view-952.html';</script>
  // 旧实现不认这种收尾，编辑明明成功却报「编辑未生效」（2026-10-21 实测）。
  // 跳转到登录页是会话失效，不算成功。
  if (!/user-login/.test(t) && (
    /location(?:\.href)?\s*=\s*['"][^'"]*-(?:view|browse)-/.test(t) ||
    /location\.reload\(/.test(t)
  )) return true;
  return false;
}

/**
 * 只提交、不回读的动作（Bug 激活/解决/关闭/删除）用它判断结果
 *
 * 禅道拒绝提交（必填项缺失、状态不允许等）时 HTTP 状态仍是 200，
 * 旧实现只看 resp.ok，会把被拒绝的操作报成成功。
 * 规则：有成功收尾 → 成功；有明确报错 → 失败并带原因；都没有 → 按 HTTP 状态（兼容未知的成功形态）。
 */
async function judgeActionResponse(resp, successMessage) {
  const text = await resp.text();
  if (isZentaoSubmitSuccess(text)) return { success: true, message: successMessage };
  const reason = extractZentaoError(text);
  if (reason) {
    console.warn('[ZentaoService] 禅道拒绝操作:', reason);
    return { success: false, message: reason };
  }
  if (resp.ok) return { success: true, message: successMessage };
  return { success: false, message: `HTTP ${resp.status}` };
}

// 回读「我的任务」里某任务的状态（用于校验写操作是否真的生效）
//
// ⚠️ 这个回读**不可靠**：任务被 done/closed 后会从「我的任务」列表消失，
// 此时返回 null。据此判定失败会产生大量假阴性（真如 943/884 已关闭却报
// 「更新未生效」）。所以它现在只用于「补充状态信息」，不再决定成败。
// 回读「我的任务」里某任务的状态（用于校验写操作是否真的生效）
//
// ⚠️ 这个回读**不可靠**：任务被 done/closed 后可能不在「我的任务」里，
// 此时返回 null。据此判定失败会产生大量假阴性，所以它只用于「补充状态信息」，不决定成败。
async function readMyTask(taskId, cookieHeader) {
  try {
    const { items } = await fetchMyList('task', 'assignedTo', cookieHeader);
    return items.find((x) => String(x.id) === String(taskId)) || null;
  } catch (e) {
    return null;
  }
}

async function readMyTaskStatus(taskId, cookieHeader) {
  const t = await readMyTask(taskId, cookieHeader);
  return t ? t.status : null;
}

// 回读某任务的累计消耗工时（用于校验工时记录是否生效）
// 同样注意：任务不在「我的任务」里就返回 null，不能据此判定失败。
// 回读某任务的累计消耗工时（用于校验工时记录是否生效）
// 同样注意：任务不在「我的任务」里就返回 null，不能据此判定失败。
async function readMyTaskConsumed(taskId, cookieHeader) {
  const t = await readMyTask(taskId, cookieHeader);
  return t ? Number(t.consumed) : null;
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
      // 禅道规定开始任务时「总计消耗」和「预计剩余」不能同时为 0；
      // 没填预计工时的任务（estimate=0）直接提交会被退回表单。先给一个预计剩余，
      // 后续登记工时（recordEstimate）会写入真实的消耗与剩余。
      if (!(Number(fields.consumed) > 0) && !(Number(fields.left) > 0)) {
        fields.left = String(options.left > 0 ? options.left : 1);
      }
    } else if (action === 'close') {
      fields.status = 'closed';
    }

    // 3) 提交
    const params = toFormBody(fields);
    const postResp = await fetch(formUrl, {
      method: 'POST',
      headers: { Cookie: CH, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      redirect: 'manual'
    });
    const postText = await postResp.text();
    // 禅道动作成功后返回收尾页/收尾脚本；失败或校验不通过会退回表单
    const submitted = isZentaoSubmitSuccess(postText);

    // 4) 回读校验。注意：任务被 done/closed 后会从「我的任务」消失，
    //    此时 observed 为 null，**不能据此判失败**。
    //    所以主判据是禅道的提交标志，observed 只用于补充状态文案。
    const observed = await readMyTaskStatus(taskId, CH);
    const expected = expectedMap[status];

    let ok;
    if (submitted) {
      // 禅道明确收尾了 —— 这是权威的成功信号，优先采信
      ok = true;
    } else if (observed != null) {
      // 回读得到状态：与预期一致才算成功
      ok = expected ? observed === expected : true;
    } else {
      // 既没拿到收尾标志、又回读不到状态（任务多半已从列表消失）：
      // 没有证据说失败，不该报错让用户以为没同步
      ok = false;
    }

    const statusText = observed || expected || '未知';
    const reason = ok ? '' : extractZentaoError(postText);
    if (!ok) console.warn('[ZentaoService] 更新任务状态未生效:', taskId, status, reason || '(禅道未返回原因)');
    return {
      success: ok,
      message: ok
        ? `状态已更新为 ${statusText}`
        : `更新未生效（当前仍为 ${observed || '未知'}）${reason ? `：${reason}` : ''}`,
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
    const consumedBefore = await readMyTaskConsumed(taskId, CH);

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
    const consumedAfter = await readMyTaskConsumed(taskId, CH);

    // 判定顺序：禅道收尾脚本 > 累计消耗增长 > 成功文案
    // ⚠️ 不能只看「累计消耗是否增长」：任务已 closed/done 时不在「我的任务」里，
    //    consumedBefore/After 都是 null，会把成功的操作判成失败（真实发生过多次）。
    const submitted = isZentaoSubmitSuccess(text);
    const grew = consumedBefore != null && consumedAfter != null && consumedAfter > consumedBefore;

    if (submitted || grew) {
      const detail = consumedAfter != null ? `累计消耗 ${consumedAfter} 小时` : '禅道已确认';
      console.log('[ZentaoService] 工时记录成功:', taskId,
        `${consumedBefore} -> ${consumedAfter}`, submitted ? '(禅道收尾脚本确认)' : '(回读确认)');
      return { success: true, message: `工时已记录（${detail}）`, consumed: consumedAfter };
    }

    console.error('[ZentaoService] 工时记录未生效:', taskId, 'resp:', text.substring(0, 160));
    return { success: false, message: '工时记录未生效，请检查任务状态或参数' };
  } catch (err) {
    console.error('[ZentaoService] 记录工时异常:', err.message);
    return { success: false, message: err.message };
  }
}

/**
 * 获取所有执行列表（从HTML页面解析，获取准确的type字段）
 * @returns {Promise<Array>} 执行列表
 * @throws {Error} 禅道不可达或页面结构变化导致解析失败时抛出（不再静默返回空数组）
 */
async function getExecutions() {
  let html;
  try {
    const cookies = await getZentaoCookies();
    // 用 HTML 页面获取，因为 JSON 接口不返回 type 字段
    const resp = await fetch(`${zentaoBase()}/zentao/execution-all-all-order_asc-0.html`, {
      method: 'GET',
      headers: {
        'Accept': 'text/html',
        'Cookie': cookiesToString(cookies),
      },
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    html = await resp.text();
  } catch (err) {
    console.error('[ZentaoService] 获取执行列表失败:', err.message);
    throw new Error(describeZentaoTransportError(err));
  }

  // 页面里的数据形如 <script>data = "<转义后的 JSON 字符串>"</script>
  // 必须用捕获组只取引号内的内容：旧实现把结尾引号一起带进来，JSON.parse 恒报错，执行列表永远为空
  const dataMatch = html.match(/<script>\s*data\s*=\s*"((?:\\[\s\S]|[^\\"])*)"/);
  if (!dataMatch) {
    throw new Error('未在执行列表页面中找到数据（禅道页面结构可能已变化）');
  }

  let executions;
  try {
    executions = JSON.parse(JSON.parse(`"${dataMatch[1]}"`));
  } catch (err) {
    throw new Error(`解析执行列表失败: ${err.message}`);
  }

  console.log('[ZentaoService] 解析到', executions.length, '个执行');

  // 页面上的状态是中文文案，转换为禅道内部状态码（与其他接口保持一致）
  const STATUS_CODE = { '未开始': 'wait', '进行中': 'doing', '已挂起': 'suspended', '已关闭': 'closed' };

  return executions
    .filter(ex => String(ex.deleted) !== '1')
    .map(ex => {
      // name 是 HTML：<span 类型标签>看板</span> <a ...>执行名</a> <span>已延期</span>，取链接文字
      const rawName = String(ex.name || ex.title || '');
      const linkText = rawName.match(/<a\b[^>]*>([^<]+)<\/a>/);
      const cleanName = (linkText ? linkText[1] : rawName.replace(/<[^>]+>/g, '')).trim() || `执行 ${ex.id}`;
      // project 字段在该页面里是项目名称；项目 ID 取 path（,项目ID,执行ID,）的第一段
      const projectId = String(ex.path || '').split(',').filter(Boolean)[0] || '';

      return {
        id: String(ex.id),
        name: cleanName,
        projectId,
        projectName: ex.projectName || ex.project || '',
        productName: ex.productName || '',
        status: STATUS_CODE[ex.status] || ex.status || 'doing',
        begin: ex.begin || '',
        end: ex.end || '',
        // 关键：使用准确的type字段
        type: ex.type || 'execution',  // kanban, sprint, stage
        kanbanId: ex.type === 'kanban' ? String(ex.id) : null
      };
    });
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
    formData.append('deadline', toZentaoDate(rest.deadline));
    formData.append('begin', toZentaoDate(rest.begin));
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
 * 更新看板执行里任务的状态
 *
 * 执行看板（execution type=kanban）里的卡片就是普通任务，状态必须走任务自身的
 * start / close 等动作。旧实现调用 kanban-finishCard，那是独立看板模块的卡片接口，
 * 对执行里的任务不生效（任务在禅道里一直停在「未开始」）。
 *
 * @param {number|string} cardId - 任务 ID（看板执行里卡片 ID 即任务 ID）
 * @param {number|string} kanbanId - 看板执行 ID（保留参数以兼容调用方）
 * @param {string} status - 本地状态 todo / in_progress / done（也接受禅道状态）
 */
async function updateKanbanCardStatus(cardId, kanbanId, status) {
  const toZentao = { done: 'closed', closed: 'closed', in_progress: 'doing', doing: 'doing', todo: 'wait', wait: 'wait' };
  return updateTaskStatus(cardId, toZentao[status] || status);
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
    const successMark = /alert-success|删除成功|已删除|已经被删除/.test(text)
      || isZentaoSubmitSuccess(text);   // 禅道删除成功也会走 ajaxRefresh 收尾脚本
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
async function editTask({ taskId, execution, name, pri, assignedTo, deadline }) {
  try {
    const cookies = await getZentaoCookies();
    const base = config.zentao.url.replace(/\/$/, '');
    const CH = cookiesToString(cookies);
    const formUrl = `${base}/zentao/task-edit-${taskId}.html?onlybody=yes`;

    const getResp = await fetch(formUrl, { headers: { Cookie: CH } });
    const html = await getResp.text();
    const fields = extractFormFields(html);

    if (!('name' in fields) || !('lastEditedDate' in fields)) {
      return { success: false, message: '没有取到禅道任务编辑表单（任务可能已删除或无权限）' };
    }

    // 只改调用方给出的字段；其余字段（描述、抄送、工时等）按表单原值带回
    if (name) fields.name = name;
    if (pri != null && pri !== '') fields.pri = String(pri);
    if (assignedTo) fields.assignedTo = assignedTo;
    if (execution) fields.execution = String(execution);
    // 截止日期：传了才改（空串 = 清除）；禅道只认日期，时间部分丢掉
    if (deadline !== undefined && deadline !== null) fields.deadline = toZentaoDate(deadline);
    fields.uid = genUid();
    if (!('mode' in fields)) fields.mode = 'single';

    const params = toFormBody(fields);

    const postResp = await fetch(`${base}/zentao/task-edit-${taskId}.html`, {
      method: 'POST',
      headers: { Cookie: CH, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      redirect: 'manual'
    });
    const text = await postResp.text();
    // 统一走isZentaoSubmitSuccess：原先只认 alert-success/保存成功，
    // 漏掉禅道的 ajaxRefresh 收尾脚本，会把成功的编辑报成「编辑未生效」
    const ok = isZentaoSubmitSuccess(text)
      || postResp.status === 301 || postResp.status === 302;
    if (ok) return { success: true, message: '任务已更新' };
    const errMatch = text.match(/alert-danger[^>]*>([^<]+)</);
    const reason = extractZentaoError(text) || (errMatch ? errMatch[1].trim() : '');
    console.warn('[ZentaoService] 编辑任务未生效:', taskId, reason || '(禅道未返回原因)');
    return { success: false, message: reason ? `编辑未生效：${reason}` : '编辑未生效' };
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

    // 首选「我提的 Bug」（按 ID 倒序）：插件以当前账号建 Bug，这里一定能找到。
    // 产品 / 执行的 Bug 列表受禅道里的筛选与权限影响，实测会返回空列表（2026-10-21），
    // 导致新建的 Bug 拿不到 ID：本地显示未同步、附件推不上去，再点同步还会重复创建。
    try {
      const { items } = await fetchMyList('bug', 'openedBy', CH);
      const hit = items
        .filter((b) => String(b.title || '').trim() === target)
        .sort((a, b) => Number(b.id) - Number(a.id))[0];
      if (hit) return String(hit.id);
    } catch { /* 继续尝试其他列表 */ }

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
    return judgeActionResponse(resp, 'Bug 已激活');
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/** 解决 Bug（bug-resolve） */
async function resolveBug({ bugId, resolution, assignedTo, comment, files = [] }) {
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
    // 解决时附上的验证截图等，随解决动作一起提交（禅道解决表单本身支持附件）
    for (const f of files) {
      fd.append('files[]', new Blob([f.buffer], { type: f.mime || 'application/octet-stream' }), f.name);
      fd.append('labels[]', zentaoFileLabel(f.name));
    }
    const resp = await fetch(`${base}/zentao/bug-resolve-${bugId}.html?onlybody=yes`, {
      method: 'POST',
      headers: { Cookie: CH, 'X-Requested-With': 'XMLHttpRequest' },
      body: fd,
      timeout: files.length ? 300000 : undefined
    });
    return judgeActionResponse(resp, 'Bug 已解决');
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
    return judgeActionResponse(resp, 'Bug 已关闭');
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * 走禅道的 Bug 动作表单（edit / assignTo / activate）：取表单 → 只改给定字段、其余原样带回 → 提交 → 回读详情确认
 * 禅道表单被退回时 HTTP 照样是 200，只看响应会误报成功，所以以回读结果为准。
 * @param {'edit'|'assignTo'|'activate'} action
 * @param {(fields:Object) => void} mutate - 改表单字段
 * @param {(bug:Object) => boolean} verify - 回读的禅道 Bug 是否符合预期
 */
async function submitBugForm(bugId, action, mutate, verify, okMessage) {
  try {
    const CH = cookiesToString(await getZentaoCookies());
    const page = `${zentaoBase()}/zentao/bug-${action}-${bugId}.html?onlybody=yes`;
    const html = await (await fetch(page, { headers: { Accept: 'text/html', Cookie: CH } })).text();
    const fields = extractFormFields(html);
    if (!('assignedTo' in fields)) {
      return { success: false, message: `没有取到禅道 Bug #${bugId} 的表单（可能已删除、已关闭或无权限）` };
    }
    mutate(fields);
    fields.uid = genUid();
    const resp = await fetch(page, {
      method: 'POST',
      headers: { Cookie: CH, 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
      body: toFormBody(fields).toString(),
      redirect: 'manual'
    });
    const text = await resp.text();
    const reason = extractZentaoError(text);
    if (reason) return { success: false, message: reason };
    const view = await getZentaoJson(`bug-view-${bugId}.json?onlybody=yes`, CH);
    if (view && view.bug && verify(view.bug)) return { success: true, message: okMessage, bug: view.bug };
    return { success: false, message: '禅道没有保存这次修改（表单被退回）' };
  } catch (err) {
    return { success: false, message: describeZentaoTransportError(err) };
  }
}

/** 编辑 Bug 的标题 / 优先级 / 严重程度（只改给出的字段） */
function editBug({ bugId, title, pri, severity }) {
  const t = title != null ? String(title).trim() : null;
  if (t === '') return Promise.resolve({ success: false, message: '标题不能为空' });
  return submitBugForm(bugId, 'edit', (f) => {
    if (t !== null) f.title = t;
    if (pri != null && pri !== '') f.pri = String(pri);
    if (severity != null && severity !== '') f.severity = String(severity);
  }, (b) => (t === null || b.title === t) && (pri == null || pri === '' || String(b.pri) === String(pri)) &&
    (severity == null || severity === '' || String(b.severity) === String(severity)), 'Bug 已更新');
}

/** 指派 Bug（禅道「指派」动作：会记一条历史并通知对方），可带备注 */
function assignBug({ bugId, assignedTo, comment }) {
  if (!assignedTo) return Promise.resolve({ success: false, message: '请选择指派人' });
  return submitBugForm(bugId, 'assignTo', (f) => {
    f.assignedTo = String(assignedTo);
    f.comment = comment || '';
  }, (b) => b.assignedTo === String(assignedTo), 'Bug 已指派');
}

/** 激活（重新打开）已解决的 Bug；与「确认」（bug-confirmBug）不是一回事 */
function reactivateBug({ bugId, assignedTo, comment }) {
  return submitBugForm(bugId, 'activate', (f) => {
    if (assignedTo) f.assignedTo = String(assignedTo);
    f.comment = comment || '';
    delete f['files[]'];
    delete f['labels[]'];
  }, (b) => b.status === 'active', 'Bug 已激活');
}

/**
 * 按编号查禅道 Bug（关联前核对）
 * @returns {Promise<{exists:boolean, id?:string, title?:string, status?:string}>}
 */
async function getBugBrief(bugId) {
  try {
    const inner = await getZentaoJson(`bug-view-${bugId}.json?onlybody=yes`);
    const b = inner && inner.bug;
    if (!b || !b.id || String(b.deleted) === '1') return { exists: false };
    return { exists: true, id: String(b.id), title: decodeZentaoText(b.title || ''), status: b.status || '' };
  } catch (err) {
    // 不存在时禅道返回的不是合法 JSON（失败结果后面拼着跳转），解析失败即视为不存在
    if (/JSON|Unexpected/.test(err.message)) return { exists: false };
    throw err;
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
    return judgeActionResponse(resp, 'Bug 已删除');
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

// ============================================================================
// 在浏览器里打开禅道页面（自动登录）、任务换执行
// ============================================================================

/**
 * 浏览器里的禅道会话是否仍然有效
 * 用浏览器自己的 zentaosid 发一个最轻的请求；不经过自动重登（这里就是要知道它是否失效）
 */
async function isBrowserSessionValid(sid) {
  if (!sid || !/^[A-Za-z0-9,-]{8,128}$/.test(String(sid))) return false;
  try {
    const resp = await fetch(`${zentaoBase()}/zentao/my-task-assignedTo-0-id_desc-0-1-1.json`, {
      _noSessionRetry: true,
      headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'Cookie': `zentaosid=${sid}` }
    });
    const text = await resp.text();
    return resp.ok && /"status"\s*:\s*"success"/.test(text) && !looksLikeSessionExpired(resp, text);
  } catch {
    return false;
  }
}

/**
 * 为浏览器单独登录一次，返回要写进浏览器的 cookie
 * 与后端自己的会话分开：浏览器里退出登录不影响后端，反之亦然
 * @returns {Promise<Array<{name:string,value:string,path:string,httpOnly:boolean}>>}
 */
async function createBrowserSession() {
  const cookies = await loginZentao(config.zentao.url, config.zentao.username, config.zentao.password);
  if (!cookies.zentaosid) throw new Error('登录禅道未返回会话');
  // 与禅道自己下发的属性一致（path=/zentao/、HttpOnly），否则浏览器里会出现同名的新旧两个 cookie
  return [{ name: 'zentaosid', value: cookies.zentaosid, path: '/zentao/', httpOnly: true }];
}

/**
 * 任务 / Bug 在浏览器里应打开的地址
 *
 * 禅道 18 的页面单独开在标签页里时，自带脚本（js/all.js）会先把它跳进主框架
 * index-index.html，主框架再在「执行」等应用里重新加载这一页 —— 用户会看到
 * 详情页 → 任务列表 → 详情页的多次跳转。所以直接打开主框架地址，由它加载详情页。
 *
 * 看板执行里的任务，普通详情页会被禅道跳到整个看板，要用 onlybody 版详情页；
 * onlybody 页只能放在框架里（单独打开会被脚本去掉 onlybody 重新加载，又落到看板），
 * 正好由主框架承载。onlybody 地址主框架识别不出所属应用，因此显式带上 app。
 */
const VIEW_APPS = { task: 'execution', bug: 'qa', doc: 'doc', story: 'product' };

async function resolveViewPath(type, objectId, sid) {
  let page = `/zentao/${type}-view-${objectId}.html`;
  if (type === 'task') {
    try {
      const resp = await fetch(`${zentaoBase()}/zentao/task-view-${objectId}.json`, {
        _noSessionRetry: true,
        headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'Cookie': `zentaosid=${sid}` }
      });
      const outer = await resp.json();
      const inner = typeof outer.data === 'string' ? JSON.parse(outer.data) : outer.data;
      if (inner && inner.locate) page += '?onlybody=yes';
    } catch { /* 判断不了就打开普通详情页 */ }
  }
  return `/zentao/index-index.html#app=${VIEW_APPS[type]}&url=${encodeURIComponent(page)}`;
}

/**
 * 读取禅道任务详情（换执行重建时复制字段用）
 */
async function getTaskDetail(taskId) {
  const CH = cookiesToString(await getZentaoCookies());
  const resp = await fetch(`${zentaoBase()}/zentao/task-view-${taskId}.json?onlybody=yes`, {
    headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'Cookie': CH }
  });
  const inner = await readZentaoJson(resp);
  if (!inner || !inner.task) throw new Error(`读取禅道任务 #${taskId} 失败（可能已删除或无权限）`);
  return inner.task;
}

/**
 * 任务在禅道编辑页里允许选择的执行（禅道只允许在同一项目的执行之间移动任务）
 * @returns {Promise<string[]>} 执行 ID
 */
async function getTaskExecutionOptions(taskId) {
  const CH = cookiesToString(await getZentaoCookies());
  const resp = await fetch(`${zentaoBase()}/zentao/task-edit-${taskId}.html?onlybody=yes`, { headers: { 'Accept': 'text/html', 'Cookie': CH } });
  const html = await resp.text();
  const select = html.match(/<select\b[^>]*name=['"]execution['"][\s\S]*?<\/select>/i);
  if (!select) throw new Error('没有取到禅道任务编辑表单（任务可能已删除或无权限）');
  return [...select[0].matchAll(/<option\b[^>]*value=['"](\d+)['"]/g)].map(m => m[1]);
}

// ============================================================================
// 附件（文件上传）
// ============================================================================

/**
 * 任务 / Bug 在禅道里的编辑表单、详情、正文字段、标题字段
 * 详情 JSON 必须带 onlybody=yes：看板类型执行里的任务不带时，禅道只返回 {locate: 看板页}，
 * 拿不到任务数据（2026-10-22 实测 #950），附件上传会报「找不到任务」。
 */
const ZENTAO_OBJECTS = {
  task: { edit: (id) => `task-edit-${id}.html?onlybody=yes`, submit: (id) => `task-edit-${id}.html`, view: (id) => `task-view-${id}.json?onlybody=yes`, body: 'desc', title: 'name' },
  bug: { edit: (id) => `bug-edit-${id}.html?onlybody=yes`, submit: (id) => `bug-edit-${id}.html`, view: (id) => `bug-view-${id}.json?onlybody=yes`, body: 'steps', title: 'title' }
};

function zentaoObject(type) {
  const o = ZENTAO_OBJECTS[type];
  if (!o) throw new Error(`不支持的对象类型: ${type}`);
  return o;
}

/**
 * 列出任务 / Bug 在禅道里的附件（不含正文里的内嵌图片）
 * @returns {Promise<Array<{id:string,title:string,extension:string,size:number,addedBy:string,addedDate:string}>>}
 */
async function listObjectFiles(type, objectId) {
  const o = zentaoObject(type);
  const CH = cookiesToString(await getZentaoCookies());
  const resp = await fetch(`${zentaoBase()}/zentao/${o.view(objectId)}`, {
    headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'Cookie': CH }
  });
  const inner = await readZentaoJson(resp);
  const obj = inner && inner[type];
  if (!obj) {
    const why = inner && inner.locate ? `禅道要求跳转到 ${String(inner.locate).replace(/^https?:\/\/[^/]+/, '')}` : '可能已删除或无权限';
    throw new Error(`读取禅道${type === 'bug' ? ' Bug' : '任务'} #${objectId} 失败（${why}）`);
  }
  const files = obj.files ? Object.values(obj.files) : [];
  return files
    .filter(f => String(f.deleted) !== '1')
    .map(f => ({
      id: String(f.id),
      title: f.title || '',
      extension: f.extension || '',
      size: Number(f.size) || 0,
      addedBy: f.addedBy || '',
      addedDate: f.addedDate || ''
    }))
    .sort((a, b) => Number(a.id) - Number(b.id));
}

/**
 * 编辑器图片上传（插进正文用）。需与随后提交的表单使用同一个 uid，禅道保存时才会把图片关联到该对象。
 * @returns {Promise<string>} 图片地址，如 /zentao/file-read-299.png
 */
async function uploadEditorImage(uid, file, CH) {
  const fd = new FormData();
  fd.append('imgFile', new Blob([file.buffer], { type: file.mime || 'application/octet-stream' }), file.name);
  const resp = await fetch(`${zentaoBase()}/zentao/file-ajaxUpload-${uid}.html`, {
    method: 'POST',
    headers: { 'Cookie': CH, 'X-Requested-With': 'XMLHttpRequest' },
    body: fd,
    timeout: 120000
  });
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`正文图片上传失败：${text.slice(0, 80)}`); }
  if (json.error !== 0 || !json.url) throw new Error(`正文图片上传失败：${json.message || '禅道未返回图片地址'}`);
  return json.url;
}

/** 文件名去掉扩展名作为禅道里的附件标题（禅道下载时会自动拼上扩展名） */
function zentaoFileLabel(name) {
  const n = String(name || '附件');
  const i = n.lastIndexOf('.');
  return i > 0 ? n.slice(0, i) : n;
}

function escapeHtmlAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 给禅道里已存在的任务 / Bug 追加附件（走编辑表单，一次提交）
 *
 * inline 的图片同时插入正文（任务描述 / Bug 重现步骤），并保留一份附件。
 * 编辑表单的其他字段按原值带回；禅道按 lastEditedDate 做并发控制，被拒时重取表单重试一次。
 *
 * @param {'task'|'bug'} type
 * @param {string} objectId - 禅道 ID
 * @param {Array<{id:string,name:string,mime:string,buffer:Buffer,inline?:boolean}>} files
 * @returns {Promise<{success:boolean, message:string, files?:Array<{id:string,zentaoFileId:string|null,inlineUrl:string|null}>}>}
 */
async function attachFilesToObject(type, objectId, files) {
  const o = zentaoObject(type);
  if (!files || files.length === 0) return { success: true, message: '没有需要上传的附件', files: [] };

  let lastMessage = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const CH = cookiesToString(await getZentaoCookies());
      const formResp = await fetch(`${zentaoBase()}/zentao/${o.edit(objectId)}`, { headers: { 'Accept': 'text/html', 'Cookie': CH } });
      const html = await formResp.text();
      const fields = extractFormFields(html);
      const uid = (html.match(/var kuid = ['"]([^'"]+)['"]/) || [])[1];
      if (!(o.title in fields) || !uid) {
        return { success: false, message: `没有取到禅道${type === 'bug' ? ' Bug' : '任务'}编辑表单（可能已删除或无权限）` };
      }

      const before = new Set((await listObjectFiles(type, objectId)).map(f => f.id));

      // 正文内嵌图片：先上传拿到地址，追加到正文末尾
      const inlineUrls = new Map();
      const inlineHtml = [];
      for (const f of files) {
        if (!f.inline) continue;
        const url = await uploadEditorImage(uid, f, CH);
        inlineUrls.set(f.id, url);
        inlineHtml.push(`<p><img src="${escapeHtmlAttr(url)}" alt="${escapeHtmlAttr(f.name)}" /></p>`);
      }
      if (inlineHtml.length) fields[o.body] = `${fields[o.body] || ''}${inlineHtml.join('')}`;
      fields.uid = uid;

      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) {
        const values = Array.isArray(v) ? (v.length ? v : ['']) : [v];
        values.forEach(x => fd.append(k, x == null ? '' : x));
      }
      for (const f of files) {
        fd.append('files[]', new Blob([f.buffer], { type: f.mime || 'application/octet-stream' }), f.name);
        fd.append('labels[]', zentaoFileLabel(f.name));
      }

      const postResp = await fetch(`${zentaoBase()}/zentao/${o.submit(objectId)}`, {
        method: 'POST',
        headers: { 'Cookie': CH },
        body: fd,
        redirect: 'manual',
        timeout: 300000
      });
      const text = await postResp.text();
      if (!isZentaoSubmitSuccess(text) && postResp.status !== 302 && postResp.status !== 301) {
        lastMessage = extractZentaoError(text) || '禅道未接受附件';
        // 并发编辑（lastEditedDate 变了）：重取表单再试一次
        if (attempt === 0 && /改动|修改|刷新/.test(lastMessage)) continue;
        return { success: false, message: lastMessage };
      }

      // 新增的附件 ID 按提交顺序对应
      const added = (await listObjectFiles(type, objectId)).filter(f => !before.has(f.id));
      const results = files.map((f, i) => {
        const label = zentaoFileLabel(f.name);
        const match = added.find(a => a.title === label && a.size === f.buffer.length) || added[i] || null;
        return { id: f.id, zentaoFileId: match ? match.id : null, inlineUrl: inlineUrls.get(f.id) || null };
      });
      console.log(`[ZentaoService] ${type}#${objectId} 已上传附件 ${files.length} 个`);
      return { success: true, message: '附件已上传', files: results };
    } catch (err) {
      console.error('[ZentaoService] 上传附件失败:', err.message);
      return { success: false, message: describeZentaoTransportError(err) };
    }
  }
  return { success: false, message: lastMessage || '禅道未接受附件' };
}

/**
 * 在正文 HTML 里找出某个附件对应的内嵌图片
 *
 * 插件上传截图时，正文图片是单独的编辑器文件（file-read-N），附件是另一个文件，
 * 两者只靠 alt（= 附件文件名）和上传顺序（编辑器文件先传，ID 更小）关联：
 *   - 有 inlineUrl（插件上传、本地有记录）→ 按地址精确匹配
 *   - 否则按 alt 等于附件名、文件 ID 小于附件 ID，取最近的一张
 * 都匹配不上就不动正文（例如在禅道网页里粘贴的图片）。
 * @returns {{tag:string, fileId:string}|null}
 */
function findInlineImage(html, { inlineUrl, name, zentaoFileId }) {
  const imgs = [...String(html || '').matchAll(/<img\b[^>]*>/gi)].map(m => {
    const tag = m[0];
    const src = (tag.match(/\bsrc\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    const alt = (tag.match(/\balt\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    const fileId = (src.match(/file-read-(\d+)/) || [])[1] || '';
    return { tag, src, alt: alt.replace(/&quot;/g, '"').replace(/&amp;/g, '&'), fileId };
  });
  if (inlineUrl) {
    const hit = imgs.find(i => i.src === inlineUrl || (i.fileId && i.fileId === (String(inlineUrl).match(/file-read-(\d+)/) || [])[1]));
    if (hit) return hit;
  }
  if (!name) return null;
  const limit = Number(zentaoFileId) || Infinity;
  const candidates = imgs.filter(i => i.alt === name && i.fileId && Number(i.fileId) < limit);
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => (Number(b.fileId) > Number(a.fileId) ? b : a));
}

/** 从正文 HTML 里去掉一张图片（连同只包着它的 <p>） */
function stripImageTag(html, tag) {
  const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wrapped = new RegExp(`<p>\\s*${esc}\\s*</p>`);
  return wrapped.test(html) ? html.replace(wrapped, '') : html.replace(tag, '');
}

/**
 * 删除附件后，把正文（任务描述 / Bug 重现步骤）里对应的内嵌图片一起去掉，并删除该图片文件
 * @param {'task'|'bug'} type
 * @param {string} objectId
 * @param {{inlineUrl?:string, name?:string, zentaoFileId?:string}} attachment
 * @returns {Promise<{success:boolean, removed:boolean, message:string}>}
 */
async function removeInlineImage(type, objectId, attachment) {
  const o = zentaoObject(type);
  let lastMessage = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const CH = cookiesToString(await getZentaoCookies());
      const formResp = await fetch(`${zentaoBase()}/zentao/${o.edit(objectId)}`, { headers: { 'Accept': 'text/html', 'Cookie': CH } });
      const html = await formResp.text();
      const fields = extractFormFields(html);
      if (!(o.title in fields)) return { success: false, removed: false, message: '没有取到禅道编辑表单' };
      const img = findInlineImage(fields[o.body], attachment);
      if (!img) return { success: true, removed: false, message: '正文里没有对应的图片' };

      fields[o.body] = stripImageTag(fields[o.body], img.tag);
      const uid = (html.match(/var kuid = ['"]([^'"]+)['"]/) || [])[1];
      if (uid) fields.uid = uid;
      const postResp = await fetch(`${zentaoBase()}/zentao/${o.submit(objectId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': CH },
        body: toFormBody(fields),
        redirect: 'manual'
      });
      const text = await postResp.text();
      if (!isZentaoSubmitSuccess(text) && postResp.status !== 302 && postResp.status !== 301) {
        lastMessage = extractZentaoError(text) || '禅道未接受修改';
        if (attempt === 0 && /改动|修改|刷新/.test(lastMessage)) continue;
        return { success: false, removed: false, message: lastMessage };
      }
      if (img.fileId) await deleteZentaoFile(img.fileId).catch(() => {});
      console.log(`[ZentaoService] ${type}#${objectId} 已从正文移除图片 file-read-${img.fileId || '?'}`);
      return { success: true, removed: true, message: '已从正文移除对应图片' };
    } catch (err) {
      return { success: false, removed: false, message: describeZentaoTransportError(err) };
    }
  }
  return { success: false, removed: false, message: lastMessage || '禅道未接受修改' };
}

// ==================== 报告页：团队数据 ====================
// 注意：禅道「动态」对本账号只返回自己的操作（2026-10-22 实测），
// 全员数据只能从各执行的任务列表 + 任务的工时记录汇总。

async function getZentaoJson(path, CH) {
  const resp = await fetch(`${zentaoBase()}/zentao/${path}`, {
    headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'Cookie': CH || cookiesToString(await getZentaoCookies()) }
  });
  return readZentaoJson(resp);
}

const SEARCH_STATUS_LABEL = {
  task: { wait: '未开始', doing: '进行中', pause: '已暂停', done: '已完成', closed: '已关闭', cancel: '已取消' },
  bug: { active: '激活', resolved: '已解决', closed: '已关闭' }
};

/** 搜索结果里的 HTML 摘要 → 纯文本（去掉高亮标签与实体） */
function plainSummary(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;?/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 在禅道里搜索任务 / Bug（禅道「全局搜索」search-index，按相关度排序）
 *
 * 实测禅道 18.3 的 search-index：
 *   - GET 传 type=task 反而一条都搜不到、type[]= 被忽略，只能搜全部再按 objectType 过滤；
 *   - 每页条数由 cookie pagerSearchIndex 决定（默认 10）；
 *   - 每页条数调大后结果按 ID 升序（不再按相关度），这里按最后编辑时间倒序取最近的；
 *   - 结果只有标题、摘要和 ID，状态、指派人、所属执行要再查详情；搜索索引里可能还留着已删除的，详情里 deleted=1 的去掉。
 * 搜索本身约 0.3 秒，查 20 条详情约 3 秒：details=false 先只返回命中（界面先显示），再带详情查一次补全。
 * 两次都按最后编辑时间倒序，补全时列表不跳动。
 * 只返回本账号在禅道里有权限看到的。
 *
 * @param {string} words
 * @param {'task'|'bug'} type
 * @param {{limit?:number, details?:boolean}} [options] - limit：最多返回几条；details：是否查详情（状态、指派人等）
 * @returns {Promise<{items:Object[], total:number}>} total：禅道里这一类的命中数（可能多于 items）
 */
async function searchZentao(words, type, { limit = 20, details: withDetails = true } = {}) {
  const q = String(words || '').trim();
  if (!q) return { items: [], total: 0 };
  const CH = cookiesToString(await getZentaoCookies());
  const inner = await getZentaoJson(`search-index.json?words=${encodeURIComponent(q)}`, `${CH}; pagerSearchIndex=200`);
  const results = Array.isArray(inner && inner.results) ? inner.results : Object.values((inner && inner.results) || {});
  const hits = results
    .filter(r => r.objectType === type)
    .sort((a, b) => String(b.editedDate || b.addedDate || '').localeCompare(String(a.editedDate || a.addedDate || '')));

  if (!withDetails) {
    return {
      items: hits.slice(0, limit).map(hit => ({
        type, id: String(hit.objectID), title: plainSummary(hit.title), summary: plainSummary(hit.summary).slice(0, 160),
        status: '', statusLabel: '', assignedTo: '', assignedToName: '', where: '', deadline: '',
        editedDate: String(hit.editedDate || '').slice(0, 10), partial: true
      })),
      total: hits.length
    };
  }

  const details = new Array(Math.min(limit, hits.length));
  let next = 0;
  const worker = async () => {
    while (next < details.length) {
      const i = next++;
      const hit = hits[i];
      try {
        const d = await getZentaoJson(`${type}-view-${hit.objectID}.json?onlybody=yes`, CH);
        details[i] = { hit, d };
      } catch {
        details[i] = { hit, d: null };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, details.length) }, worker));

  const items = [];
  for (const { hit, d } of details) {
    const item = d && d[type];
    if (item && String(item.deleted) === '1') continue;
    const users = (d && d.users) || {};
    const product = d && (typeof d.product === 'string' ? d.product : d.product && d.product.name);
    items.push({
      type,
      id: String(hit.objectID),
      title: decodeZentaoText((item && (item.name || item.title)) || '') || plainSummary(hit.title),
      summary: plainSummary(hit.summary).slice(0, 160),
      status: item ? item.status : '',
      statusLabel: item ? (SEARCH_STATUS_LABEL[type][item.status] || item.status) : '',
      assignedTo: item ? item.assignedTo : '',
      assignedToName: item ? (users[item.assignedTo] || (item.assignedTo === 'closed' ? 'Closed' : item.assignedTo || '')) : '',
      where: decodeZentaoText((d && d.execution && d.execution.name) || (item && item.executionName) || product || ''),
      deadline: item && item.deadline && !String(item.deadline).startsWith('0000') ? item.deadline : '',
      editedDate: String(hit.editedDate || '').slice(0, 10)
    });
  }
  return { items, total: hits.length };
}

/**
 * 团队成员（「我的地盘 → 团队」，即本部门全员）
 * @returns {Promise<Array<{account:string, realname:string, role:string}>>}
 */
async function getTeamMembers() {
  const inner = await getZentaoJson('my-team-0-id_asc-0-500-1.json');
  const users = Object.values((inner && inner.users) || {});
  return users
    .filter(u => u && u.account && String(u.deleted) !== '1')
    .map(u => ({ account: String(u.account), realname: u.realname || u.account, role: u.role || '' }));
}

/**
 * 一个执行里的全部任务（含子任务，分页取完）
 * @returns {Promise<Object[]>}
 */
async function listExecutionTasks(executionId, CH) {
  const all = [];
  for (let page = 1; page <= 20; page++) {
    const inner = await getZentaoJson(`execution-task-${executionId}-all-0-id_desc-0-500-${page}.json`, CH);
    if (!inner || !inner.tasks) {
      if (inner && inner.locate) throw new Error(`执行 #${executionId} 无法访问`);
      break;
    }
    const tasks = Array.isArray(inner.tasks) ? inner.tasks : Object.values(inner.tasks);
    for (const t of tasks) {
      all.push(t);
      for (const c of Object.values(t.children || {})) all.push(c);
    }
    const pageTotal = Number(inner.pager && inner.pager.pageTotal) || 1;
    if (page >= pageTotal || tasks.length === 0) break;
  }
  return all;
}

/**
 * 任务的工时记录（谁、哪天、多少小时、工作内容）
 * @returns {Promise<Array<{account:string, date:string, consumed:number, work:string}>>}
 */
async function getTaskEfforts(taskId, CH) {
  const inner = await getZentaoJson(`task-recordEstimate-${taskId}.json?onlybody=yes`, CH);
  return ((inner && inner.efforts) || [])
    .filter(e => String(e.deleted) !== '1')
    .map(e => ({ account: String(e.account), date: String(e.date).slice(0, 10), consumed: Number(e.consumed) || 0, work: e.work || '' }));
}

/** 删除禅道里的一个附件 */
async function deleteZentaoFile(fileId) {
  if (!/^\d+$/.test(String(fileId))) return { success: false, message: '非法的文件 ID' };
  try {
    const CH = cookiesToString(await getZentaoCookies());
    const resp = await fetch(`${zentaoBase()}/zentao/file-delete-${fileId}-yes.html`, {
      headers: { 'Accept': 'text/html', 'Cookie': CH, 'X-Requested-With': 'XMLHttpRequest' },
      redirect: 'manual'
    });
    const text = await resp.text();
    const reason = extractZentaoError(text);
    if (reason && !/删除/.test(reason)) return { success: false, message: reason };
    return { success: resp.status < 400, message: resp.status < 400 ? '附件已删除' : `HTTP ${resp.status}` };
  } catch (err) {
    return { success: false, message: describeZentaoTransportError(err) };
  }
}

/**
 * 读取禅道附件内容（由后端转发给插件页面预览 / 下载）
 * @returns {Promise<Response>}
 */
async function fetchZentaoFile(fileId, extension, { download = false } = {}) {
  if (!/^\d+$/.test(String(fileId))) throw new Error('非法的文件 ID');
  const ext = String(extension || '').replace(/[^a-z0-9]/gi, '').slice(0, 10);
  const CH = cookiesToString(await getZentaoCookies());
  const path = download || !ext
    ? `file-download-${fileId}-download.html`
    : `file-read-${fileId}.${ext}`;
  return fetch(`${zentaoBase()}/zentao/${path}`, { headers: { 'Cookie': CH }, timeout: 120000 });
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
  getZentaoJson,
  getZentaoCookies,
  cookiesToString,
  clearCookies,
  describeZentaoTransportError,
  zentaoFetch,
  createTask,
  toZentaoDate,
  getTasks,
  getMyTasks,
  syncMyTasks,
  syncMyBugs,
  refreshZentaoUsers,
  updateTaskStatus,
  recordTaskEstimate,
  getExecutions,
  isConfigured,
  getKanbanParams,
  // 看板相关 API
  getKanbanView,
  createKanbanCard,
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
  getBugDetail,
  // 浏览器打开禅道 / 换执行
  isBrowserSessionValid,
  createBrowserSession,
  resolveViewPath,
  getTaskDetail,
  getTaskExecutionOptions,
  // 报告页
  getTeamMembers,
  searchZentao,
  editBug,
  assignBug,
  reactivateBug,
  getBugBrief,
  listExecutionTasks,
  getTaskEfforts,
  fetchMyList,
  // 附件
  listObjectFiles,
  attachFilesToObject,
  zentaoFileLabel,
  removeInlineImage,
  findInlineImage,
  deleteZentaoFile,
  fetchZentaoFile
};
