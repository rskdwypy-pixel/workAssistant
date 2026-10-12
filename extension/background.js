// ============================================================================
// 工作助手 - background service worker
// 所有禅道操作统一走后端直连（纯 HTTP + session cookie），
// 不再通过 chrome.tabs / chrome.scripting 注入禅道标签页，
// 因此执行任何操作都不会再打开新的禅道标签页。
// ============================================================================

// API配置（后端只监听 IPv4，必须用 127.0.0.1，不能用 localhost）
const API_BASE_URL = 'http://127.0.0.1:3721';

// 后端自动拉起所需的 Native Messaging 宿主名（由 scripts/install-native-host.sh 注册）
const NATIVE_HOST = 'com.workassistant.backend';

/**
 * 检查后端是否已在运行
 */
async function isBackendAlive(timeout = 1500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch(`${API_BASE_URL}/api/config`, { signal: ctrl.signal });
    return resp.ok;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 通过 Native Messaging 让 Chrome 自动拉起本地后端
 *
 * MV3 扩展无法直接 fork 进程（无 child_process，且 service worker 随时被回收），
 * 官方做法是 connectNative：Chrome 看到请求就会启动已注册的宿主进程，
 * 我们的宿主脚本再把 Node 后端拉起来，从而实现「插件里启动后端」。
 *
 * @returns {Promise<{started: boolean, reason?: string}>}
 */
async function launchBackendViaNative() {
  if (!chrome.runtime.connectNative) {
    return { started: false, reason: '当前浏览器不支持 Native Messaging' };
  }

  return new Promise((resolve) => {
    let settled = false;
    let port = null;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch (e) {
      return done({ started: false, reason: e.message });
    }

    // Chrome 启动宿主需要时间，超时则判定失败
    const timer = setTimeout(async () => {
      if (await isBackendAlive()) {
        done({ started: true });
      } else {
        done({ started: false, reason: '宿主已请求但后端未就绪，请确认已执行 scripts/install-native-host.sh' });
      }
    }, 6000);

    port.onMessage.addListener(async (msg) => {
      // 宿主回报状态
      if (msg && msg.type === 'ready') {
        clearTimeout(timer);
        done({ started: true });
      }
    });

    port.onDisconnect.addListener(async () => {
      // Chrome 关闭了端口：宿主被终止。此时检查后端是否还活着。
      const alive = await isBackendAlive();
      clearTimeout(timer);
      if (!settled) {
        // 宿主已退出（通常是浏览器/插件重启），后端多半也被清理了
        done({
          started: alive,
          reason: alive ? undefined : '后端宿主已断开'
        });
      }
    });

    // 主动发一条消息，触发 Chrome 启动宿主
    try {
      port.postMessage({ type: 'launch' });
    } catch (e) {
      clearTimeout(timer);
      done({ started: false, reason: e.message });
    }
  });
}

/**
 * 确保后端可用：未运行时尝试自动拉起
 * @param {boolean} autoStart - 是否允许自动启动（默认允许）
 */
async function ensureBackend(autoStart = true) {
  if (await isBackendAlive()) {
    return { ok: true, started: false };
  }
  if (!autoStart) {
    return { ok: false, reason: 'backend_down' };
  }
  console.log('[Background] 后端未运行，尝试通过 Native Messaging 拉起...');
  const r = await launchBackendViaNative();
  if (r.started) {
    console.log('[Background] ✅ 后端已拉起');
    return { ok: true, started: true };
  }
  console.warn('[Background] ❌ 后端拉起失败:', r.reason);
  return { ok: false, reason: r.reason || 'backend_start_failed' };
}

// 同步频率控制常量
const SYNC_INTERVAL = 24 * 60 * 60 * 1000; // 24小时
const STORAGE_KEY_LAST_SYNC = 'zentao_last_sync_time';

/**
 * 调用后端接口（JSON 请求）
 *
 * 后端未运行时自动拉起并重试一次：
 * 插件是使用入口，不该要求用户先手动开一个终端。
 *
 * @param {string} path - 以 /api/ 开头的路径（GET 时把 query 直接拼在 path 上）
 * @param {Object} options - { method, body }
 * @returns {Promise<Object>} 后端返回的 JSON
 */
async function callBackendZentao(path, options = {}, attempt = 0) {
  let resp;
  try {
    resp = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method || 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
  } catch (err) {
    // 连接被拒 = 后端没在跑 → 拉起后重试一次
    if (attempt === 0) {
      console.warn('[Background] 后端连接失败，尝试自动拉起后重试:', err.message);
      const r = await launchBackendViaNative();
      if (r.started) {
        return callBackendZentao(path, options, 1);
      }
      throw new Error(`后端未运行，且自动拉起失败：${r.reason || '未知原因'}`);
    }
    throw err;
  }

  const text = await resp.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`后端返回非 JSON（HTTP ${resp.status}）: ${text.slice(0, 200)}`);
  }
}

/**
 * 获取上次同步时间
 */
async function getLastSyncTime() {
  const result = await chrome.storage.local.get([STORAGE_KEY_LAST_SYNC]);
  return result[STORAGE_KEY_LAST_SYNC] || 0;
}

/**
 * 更新同步时间戳
 */
async function updateLastSyncTime() {
  await chrome.storage.local.set({ [STORAGE_KEY_LAST_SYNC]: Date.now() });
  console.log('[Background] 同步时间戳已更新');
}

/**
 * 获取禅道配置
 */
async function fetchConfig() {
  try {
    const response = await fetch(`${API_BASE_URL}/api/config`);
    const data = await response.json();
    return data.data || {};
  } catch (err) {
    console.error('[Background] 获取配置失败:', err);
    return {};
  }
}

/**
 * 检查并执行禅道同步（由 newtab 页面调用）
 */
async function checkAndSyncZentao(force = false) {
  console.log('[Background] ========== newtab 页面请求检查禅道同步 ==========');
  try {
    const config = await fetchConfig();
    if (!config.zentao?.enabled) {
      console.log('[Background] 禅道未启用，跳过同步');
      return { success: false, reason: 'zentao_not_enabled' };
    }
    // 手动触发同步（自动同步已禁用）
    return await syncFromZentaoViaBackend();
  } catch (err) {
    console.error('[Background] 检查同步条件失败:', err);
    return { success: false, reason: err.message };
  }
}

/**
 * 从禅道同步「我的任务」到本地（后端直连）
 */
async function syncFromZentaoViaBackend() {
  console.log('[Background] ========== 开始后端同步我的任务 ==========');
  try {
    sendProgressUpdate(1, 2, '正在从禅道拉取我的任务...');
    const data = await callBackendZentao('/api/zentao/sync', { body: {} });

    if (!data.success) {
      console.warn('[Background] 后端同步失败:', data.message);
      return { success: false, reason: data.message || 'sync_failed' };
    }

    sendProgressUpdate(2, 2, '同步完成');
    await updateLastSyncTime();

    const d = data.data || {};
    console.log('[Background] ✓ 后端同步完成:', d);

    try {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: '工作助手 - 禅道同步',
        message: `已同步我的任务：更新 ${d.updated || 0} 个，新增 ${d.added || 0} 个`
      });
    } catch (e) { /* 通知失败忽略 */ }

    return {
      success: true,
      data: { tasksSynced: d.total || 0, added: d.added || 0, updated: d.updated || 0 }
    };
  } catch (err) {
    console.error('[Background] 后端同步异常:', err);
    return { success: false, reason: err.message };
  }
}

// ============================================================================
// 禅道操作（全部后端直连，不打开标签页）
// ============================================================================

/** 获取看板页面参数（productId / projectId / regionId / laneId / columnId） */
async function fetchKanbanPage(params) {
  const { url, laneType = 'task', columnType = 'wait' } = params;
  const m = String(url || '').match(/execution-kanban-(\d+)/);
  const executionId = m ? m[1] : null;
  if (!executionId) return { success: false, reason: 'invalid_url' };
  try {
    const data = await callBackendZentao(
      '/api/zentao/kanban/params?executionId=' + encodeURIComponent(executionId) +
      '&laneType=' + encodeURIComponent(laneType) + '&columnType=' + encodeURIComponent(columnType),
      { method: 'GET' }
    );
    if (data.success && data.productId && data.regionId && data.laneId && data.columnId) {
      return {
        success: true,
        productId: data.productId,
        projectId: data.projectId,
        regionId: data.regionId,
        laneId: data.laneId,
        columnId: data.columnId
      };
    }
    return {
      success: false,
      reason: 'missing_required_params',
      message: '缺少必需参数: productId/regionId/laneId/columnId'
    };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

/** 创建任务（阶段/迭代，后端直连） */
async function executeInZentaoPage(params) {
  const { executionId, username, taskData } = params;
  console.log('[Background] 创建任务（后端直连）:', { executionId, title: taskData.title });
  try {
    return await callBackendZentao('/api/zentao/task/create', {
      body: {
        name: taskData.title,
        desc: taskData.content || taskData.title,
        executionId,
        estimate: taskData.estimate,
        dueDate: taskData.dueDate,
        priority: taskData.priority,
        assignedTo: taskData.assignedTo || username,
        type: taskData.type
      }
    });
  } catch (err) {
    console.warn('[Background] 创建任务失败（后端）:', err.message);
    return { success: false, reason: err.message };
  }
}

/** 创建看板任务（后端直连） */
async function createKanbanTask(params) {
  const { executionId, regionId, laneId, columnId, taskData } = params;
  console.log('[Background] 创建看板任务（后端直连）:', { executionId, regionId, laneId, columnId });
  try {
    const data = await callBackendZentao('/api/zentao/task/create', {
      body: {
        name: taskData.title,
        desc: taskData.content || taskData.title,
        executionId,
        estimate: taskData.estimate,
        dueDate: taskData.dueDate,
        priority: taskData.pri,
        assignedTo: taskData.assignedTo,
        type: taskData.type,
        regionId,
        laneId,
        columnId
      }
    });
    if (data.success) {
      return { success: true, taskId: data.taskId, cardId: data.taskId, duplicate: data.duplicate, responseData: data };
    }
    return { success: false, reason: data.message || '创建失败', responseData: data };
  } catch (err) {
    console.warn('[Background] 创建看板任务失败（后端）:', err.message);
    return { success: false, reason: err.message };
  }
}

/** 创建看板卡片（后端直连） */
async function createKanbanCard(params) {
  const { kanbanId, regionId, groupId, columnId, taskData } = params;
  console.log('[Background] 创建看板卡片（后端直连）:', { kanbanId, regionId, groupId, columnId });
  try {
    const data = await callBackendZentao('/api/zentao/kanban/card/create', {
      body: {
        kanbanId, regionId, groupId, columnId,
        name: taskData.title,
        spec: taskData.content || taskData.title,
        pri: taskData.pri,
        assignedTo: taskData.assignedTo,
        deadline: taskData.dueDate,
        begin: taskData.begin,
        estimate: taskData.estimate,
        color: taskData.color
      }
    });
    if (data.success) return { success: true, cardId: data.cardId, responseData: data };
    return { success: false, reason: data.message || '创建失败', responseData: data };
  } catch (err) {
    console.warn('[Background] 创建看板卡片失败（后端）:', err.message);
    return { success: false, reason: err.message };
  }
}

/** 更新任务状态（后端直连） */
async function updateZentaoTaskStatus(params) {
  const { taskId, status } = params;
  console.log('[Background] 更新禅道任务状态（后端直连）:', { taskId, status });
  try {
    const data = await callBackendZentao('/api/zentao/task/status', { body: { taskId, status } });
    if (data.success) return { success: true, status: data.status };
    return { success: false, reason: data.message || '更新失败' };
  } catch (err) {
    console.warn('[Background] 更新任务状态失败（后端）:', err.message);
    return { success: false, reason: err.message };
  }
}

/** 更新看板卡片状态（后端直连） */
async function updateKanbanCardStatus(params) {
  const { cardId, kanbanId, status } = params;
  console.log('[Background] 更新看板卡片状态（后端直连）:', { cardId, kanbanId, status });
  try {
    const data = await callBackendZentao('/api/zentao/kanban/card/status', {
      body: { cardId, kanbanId, status }
    });
    if (data.success) return { success: true };
    return { success: false, reason: data.message || '更新失败' };
  } catch (err) {
    console.warn('[Background] 更新看板卡片状态失败（后端）:', err.message);
    return { success: false, reason: err.message };
  }
}

/** 记录任务工时（后端直连） */
async function recordZentaoEffort(params) {
  const { taskId, comment, consumedTime, leftTime } = params;
  console.log('[Background] 记录禅道任务工时（后端直连）:', { taskId, consumedTime, comment });
  try {
    const data = await callBackendZentao('/api/zentao/task/estimate', {
      body: { taskId, work: comment, consumed: consumedTime, left: leftTime }
    });
    if (data.success) return { success: true, consumed: data.consumed };
    return { success: false, reason: data.message || '记录工时失败' };
  } catch (err) {
    console.warn('[Background] 记录工时失败（后端）:', err.message);
    return { success: false, reason: err.message };
  }
}

/** 删除任务（后端直连） */
async function deleteZentaoTask(params) {
  const { executionId, zentaoId } = params;
  console.log('[Background] 删除禅道任务（后端直连）:', { executionId, zentaoId });
  try {
    const data = await callBackendZentao('/api/zentao/task/delete', {
      body: { executionId, taskId: zentaoId }
    });
    if (data.success) return { success: true };
    return { success: false, reason: data.message || '删除失败' };
  } catch (err) {
    console.warn('[Background] 删除任务失败（后端）:', err.message);
    return { success: false, reason: err.message };
  }
}

/** 编辑任务（后端直连） */
async function editZentaoTask(params) {
  const { taskId, execution, name, pri } = params;
  console.log('[Background] 编辑禅道任务（后端直连）:', { taskId, execution, name, pri });
  try {
    const data = await callBackendZentao('/api/zentao/task/edit', {
      body: { taskId, execution, name, pri }
    });
    if (data.success) return { success: true };
    return { success: false, reason: data.message || '编辑失败' };
  } catch (err) {
    console.warn('[Background] 编辑任务失败（后端）:', err.message);
    return { success: false, reason: err.message };
  }
}

/** 检测执行是否为看板类型（后端直连） */
async function quickCheckKanban(params) {
  const { executionId } = params;
  try {
    const data = await callBackendZentao(
      '/api/zentao/kanban/check?executionId=' + encodeURIComponent(executionId),
      { method: 'GET' }
    );
    return { isKanban: !!data.isKanban, reason: data.reason };
  } catch (err) {
    return { isKanban: false, reason: err.message };
  }
}

/** 获取看板视图数据（后端直连） */
async function getKanbanView(params) {
  const { kanbanId } = params;
  try {
    const data = await callBackendZentao(
      '/api/zentao/kanban/view?kanbanId=' + encodeURIComponent(kanbanId),
      { method: 'GET' }
    );
    if (data.success) return { success: true, data: data.data };
    return { success: false, reason: data.message || 'no_data' };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

/** 获取普通执行关联的产品ID（后端直连） */
async function getExecutionProductId(params) {
  const { executionId } = params;
  try {
    return await callBackendZentao('/api/zentao/execution/product-id', { body: { executionId } });
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

/** 创建 Bug（看板，后端直连） */
async function executeBugInZentaoPage(params) {
  const { bugData } = params;
  console.log('[Background] 创建 Bug（看板，后端直连）:', bugData && bugData.title);
  try {
    const data = await callBackendZentao('/api/zentao/bug/create', { body: { ...bugData } });
    if (data.success) {
      return { success: true, data: { id: data.bugId }, bugId: data.bugId, responseData: data };
    }
    return { success: false, reason: data.message, responseData: data };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

/** 创建 Bug（普通执行，后端直连） */
async function executeNormalExecutionBugInZentaoPage(params) {
  const { productId, bugData } = params;
  console.log('[Background] 创建 Bug（普通执行，后端直连）:', bugData && bugData.title);
  try {
    const data = await callBackendZentao('/api/zentao/bug/create', { body: { ...bugData, productId } });
    if (data.success) {
      return { success: true, data: { id: data.bugId }, bugId: data.bugId, responseData: data };
    }
    return { success: false, reason: data.message, responseData: data };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

/** 激活 Bug（后端直连） */
async function activateBugInZentao(params) {
  const { bugId, assignedTo, pri, type, ccList, comment } = params;
  try {
    return await callBackendZentao('/api/zentao/bug/activate', {
      body: { bugId, assignedTo, pri, type, ccList, comment }
    });
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

/** 解决 Bug（后端直连） */
async function resolveBugInZentao(params) {
  const { bugId, resolution, assignedTo, comment } = params;
  try {
    return await callBackendZentao('/api/zentao/bug/resolve', {
      body: { bugId, resolution, assignedTo, comment }
    });
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

/** 关闭 Bug（后端直连） */
async function closeBugInZentao(params) {
  const { bugId, comment } = params;
  try {
    return await callBackendZentao('/api/zentao/bug/close', { body: { bugId, comment } });
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

/** 删除 Bug（后端直连） */
async function deleteBugInZentao(params) {
  const { bugId } = params;
  try {
    return await callBackendZentao('/api/zentao/bug/delete', { body: { bugId } });
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

/** 禅道登录（后端直连，复用后端 .env 凭据，不打开标签页） */
async function performZentaoLogin() {
  console.log('[Background] 禅道登录（后端直连）');
  try {
    const data = await callBackendZentao('/api/zentao/login', { body: {} });
    if (data.success) {
      const cookies = data.data || {};
      return { success: true, token: cookies.zentaosid || cookies.za || 'session' };
    }
    return { success: false, error: data.message || '登录失败' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============================================================================
// 右键菜单
// ============================================================================
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'addTask',
    title: '添加到任务',
    contexts: ['selection']
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'addTask') {
    const selectedText = (info.selectionText || '').trim();
    if (!selectedText) return;
    try {
      const response = await fetch(`${API_BASE_URL}/api/task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: selectedText })
      });
      const result = await response.json();
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: '工作助手',
        message: result.success ? `任务已添加：${result.data.title}` : '添加失败，请确保后端服务正在运行'
      });
    } catch (err) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: '工作助手',
        message: '连接失败，请确保后端服务正在运行'
      });
    }
  }
});

// ============================================================================
// 消息处理
// ============================================================================
const ACTION_HANDLERS = {
  performZenTaoLogin: () => performZentaoLogin(),
  executeInZentaoPage: (req) => executeInZentaoPage(req),
  createKanbanTask: (req) => createKanbanTask(req),
  createKanbanCard: (req) => createKanbanCard(req),
  executeBugInZentaoPage: (req) => executeBugInZentaoPage(req),
  getExecutionProductId: (req) => getExecutionProductId(req),
  executeNormalExecutionBugInZentaoPage: (req) => executeNormalExecutionBugInZentaoPage(req),
  updateZentaoTaskStatus: (req) => updateZentaoTaskStatus(req),
  updateKanbanCardStatus: (req) => updateKanbanCardStatus(req),
  recordZentaoEffort: (req) => recordZentaoEffort(req),
  deleteZentaoTask: (req) => deleteZentaoTask(req),
  editZentaoTask: (req) => editZentaoTask(req),
  quickCheckKanban: (req) => quickCheckKanban(req),
  getKanbanView: (req) => getKanbanView(req),
  fetchKanbanPage: (req) => fetchKanbanPage(req),
  activateBugInZentao: (req) => activateBugInZentao(req),
  resolveBugInZentao: (req) => resolveBugInZentao(req),
  closeBugInZentao: (req) => closeBugInZentao(req),
  deleteBugInZentao: (req) => deleteBugInZentao(req)
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const { action } = request;

  if (action === 'checkAndSyncZentao' || action === 'manualSyncFromZentao') {
    checkAndSyncZentao(action === 'manualSyncFromZentao')
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, reason: err.message }));
    return true;
  }

  if (action === 'getLastSyncTime') {
    getLastSyncTime().then((t) => sendResponse({ success: true, time: t }));
    return true;
  }

  // —— 后端状态与生命周期 ——
  if (action === 'getBackendStatus') {
    isBackendAlive()
      .then(async (alive) => {
        sendResponse({ success: true, alive, url: API_BASE_URL });
      });
    return true;
  }

  if (action === 'startBackend') {
    launchBackendViaNative()
      .then(async (r) => {
        const alive = await isBackendAlive();
        sendResponse({ success: alive, started: r.started, reason: r.reason || '', url: API_BASE_URL });
      })
      .catch(err => sendResponse({ success: false, reason: err.message }));
    return true;
  }

  // —— 本地服务管理（状态 / 停止） ——
  if (action === 'getServiceStatus') {
    fetch(`${API_BASE_URL}/api/admin/status`)
      .then(async (resp) => {
        if (!resp.ok) {
          sendResponse({ success: false, alive: false, reason: `服务返回异常 (HTTP ${resp.status})` });
          return;
        }
        const json = await resp.json();
        sendResponse({ success: true, alive: true, data: json.data });
      })
      // 连接被拒是「服务没开」的正常表现，不是错误。
      // 直接把英文的 "Failed to fetch" 抛给用户没有意义，
      // 这里翻译成明确的中文状态，让前端能正常展示「未运行」。
      .catch(() => sendResponse({ success: false, alive: false, reason: '' }));
    return true;
  }

  if (action === 'stopBackend') {
    // 必须真正停掉再回包，否则用户看到「已停止」但服务还在
    fetch(`${API_BASE_URL}/api/admin/shutdown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disableAutoStart: !!request.disableAutoStart })
    })
      .then(async (resp) => {
        const json = await resp.json().catch(() => ({}));
        // 后端是回包后才延迟 2 秒退出，这里再轮询确认端口已释放
        let alive = true;
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 500));
          alive = !(await isBackendAlive(1200));
          if (!alive) break;
        }
        sendResponse({
          success: !alive,
          alive,
          message: json.message || (alive ? '停止失败，服务仍在运行' : '本地服务已关闭'),
          notes: json.notes || []
        });
      })
      .catch(err => sendResponse({ success: false, alive: true, reason: err.message }));
    return true;
  }

  const handler = ACTION_HANDLERS[action];
  if (handler) {
    Promise.resolve()
      .then(() => handler(request))
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, reason: err.message }));
    return true; // 异步返回
  }
});

// ============================================================================
// 后端自动拉起：插件启动 / 浏览器启动时检查并按需拉起
// ============================================================================

// 记录拉起状态，供页面查询
let backendAutoStart = { attempted: false, ok: false, reason: '' };

/**
 * 尝试确保后端运行（幂等）
 */
async function bootstrapBackend() {
  if (backendAutoStart.ok) return backendAutoStart;

  if (await isBackendAlive()) {
    backendAutoStart = { attempted: true, ok: true, reason: 'already_running' };
    return backendAutoStart;
  }

  backendAutoStart.attempted = true;
  const r = await launchBackendViaNative();
  backendAutoStart = { attempted: true, ok: !!r.started, reason: r.reason || '' };
  return backendAutoStart;
}

// service worker 每次被唤醒都会执行这里，实现「按需拉起」
bootstrapBackend();

// 浏览器启动时也检查一次（覆盖「新标签页还没打开」的场景）
chrome.runtime.onStartup.addListener(() => {
  backendAutoStart = { attempted: false, ok: false, reason: '' };
  bootstrapBackend();
});

// 插件更新/重载后同样检查
chrome.runtime.onInstalled.addListener(() => {
  bootstrapBackend();
});

/**
 * 发送进度更新到 newtab 页面（仅复用已打开页面，不新建标签页）
 */
function sendProgressUpdate(currentStep, totalSteps, message) {
  chrome.tabs.query({}).then(tabs => {
    const newtabTabs = tabs.filter(tab => {
      if (!tab.url) return false;
      return tab.url.includes('newtab.html') || tab.url.includes('/newtab');
    });
    newtabTabs.forEach(tab => {
      chrome.tabs.sendMessage(tab.id, {
        action: 'updateProgress',
        currentStep,
        totalSteps,
        message
      }).catch(err => {
        console.log('[Background] 发送到标签页失败:', tab.id, err.message);
      });
    });
  }).catch(() => { /* 忽略 */ });
}
