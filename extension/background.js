// ============================================================================
// 禅道助手 - background service worker
// 所有禅道操作统一走后端直连（纯 HTTP + session cookie），
// 不再通过 chrome.tabs / chrome.scripting 注入禅道标签页，
// 因此执行任何操作都不会再打开新的禅道标签页。
// ============================================================================

// 与系统有关的提示文字（安装命令、日志位置）
importScripts('platform.js');

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
let launchInFlight = null;
function launchBackendViaNative() {
  // 并发调用（SW 唤醒 + onStartup + 业务请求）共用同一次拉起，避免同时起多个宿主进程
  if (!launchInFlight) {
    launchInFlight = launchBackendViaNativeOnce().finally(() => {
      launchInFlight = null;
    });
  }
  return launchInFlight;
}

async function launchBackendViaNativeOnce() {
  if (!chrome.runtime.connectNative) {
    return {
      started: false,
      code: 'unsupported',
      reason: '当前浏览器不支持 Native Messaging'
    };
  }

  return new Promise((resolve) => {
    let settled = false;
    let port = null;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    try {
      port = chrome.runtime.connectNative(NATIVE_HOST);
    } catch (e) {
      return done({ started: false, code: classifyLaunchError(e.message), reason: e.message });
    }

    // 宿主会在后端就绪后回报 ready（最多等 15 秒），这里留出余量；超时再兜底探测一次
    const timer = setTimeout(async () => {
      if (await isBackendAlive()) {
        done({ started: true });
      } else {
        done({
          started: false,
          code: 'timeout',
          reason: '宿主已请求但后端未就绪，请重新运行一次安装命令'
        });
      }
    }, 20000);

    port.onMessage.addListener((msg) => {
      // 宿主回报状态：ready = 后端已就绪；error = 宿主明确报告启动失败
      if (msg && msg.type === 'ready') {
        clearTimeout(timer);
        done({ started: true, startedBy: msg.startedBy || (msg.reused ? 'existing' : '') });
      } else if (msg && msg.type === 'error') {
        clearTimeout(timer);
        done({ started: false, code: 'launch_failed', reason: msg.reason || '宿主报告后端启动失败' });
      }
    });

    port.onDisconnect.addListener(async () => {
      // 关键：lastError 只在 disconnect 事件触发时有效，必须在这里同步读取。
      // 宿主不存在（换机未注册 / 浏览器不是 Chrome）时，Chrome 不会同步抛错，
      // 而是通过 disconnect + lastError 报 "Specified native messaging host not found"。
      // 早期实现没读它，一律归为 disconnected，用户拿到的指引完全不对症。
      let lastErr = '';
      try {
        lastErr = (chrome.runtime.lastError && chrome.runtime.lastError.message) || '';
      } catch (e) {
        lastErr = e.message;
      }

      const alive = await isBackendAlive();
      clearTimeout(timer);
      if (!settled) {
        // 宿主已退出（通常是浏览器/插件重启），后端多半也被清理了
        const code = alive ? '' : (lastErr ? classifyLaunchError(lastErr) : 'disconnected');
        done({
          started: alive,
          code,
          reason: alive ? undefined : (lastErr || '后端宿主已断开')
        });
      }
    });

    // 主动发一条消息，触发浏览器启动宿主
    try {
      port.postMessage({ type: 'launch' });
    } catch (e) {
      clearTimeout(timer);
      done({ started: false, code: classifyLaunchError(e.message), reason: e.message });
    }
  });
}

/**
 * 把浏览器的原生报错归类，供前端给出针对性的修复指引。
 *
 * 这一步很关键：换过电脑的用户最常见的卡点就是「这台机器没装 Chrome，
 * 于是注册脚本写错了目录，connectNative 报 host not found」，
 * 但插件此前只把英文原文透传出去，用户完全不知道该做什么。
 */
function classifyLaunchError(message) {
  const m = String(message || '').toLowerCase();
  if (!m) return 'unknown';
  // 宿主未注册：绝大多数情况是「这台电脑用的不是 Chrome」或「没跑注册脚本」
  if (m.includes('not found') || m.includes('no such host') || m.includes('access to the specified native messaging host')) {
    return 'host_not_registered';
  }
  if (m.includes('not allowed') || m.includes('permission') || m.includes('denied')) {
    return 'permission_denied';
  }
  if (m.includes('manifest') || m.includes('parse')) {
    return 'bad_manifest';
  }
  if (m.includes('timeout') || m.includes('timed out')) {
    return 'timeout';
  }
  return 'unknown';
}

/** 各类失败对应的用户指引（中文、可直接展示） */
const LAUNCH_ERROR_HELP = {
  host_not_registered:
    '未找到后端宿主。通常是这台电脑没有用安装命令安装过，或用的浏览器安装时还没装。'
    + `在${WA_TERMINAL}里重新运行一次安装命令即可（会为本机的浏览器注册宿主），完成后重新加载插件。`,
  permission_denied:
    `浏览器拒绝了宿主启动（宿主程序没有执行权限）。请在${WA_TERMINAL}里重新运行一次安装命令。`,
  bad_manifest:
    `宿主配置文件格式有误，请在${WA_TERMINAL}里重新运行一次安装命令覆盖它。`,
  timeout:
    '宿主已拉起但后端未就绪。首次启动需加载配置与禅道登录，约需 3-8 秒；'
    + `若持续失败请查看日志 ${WA_LOG_PATH}。`,
  unsupported:
    `当前浏览器不支持 Native Messaging。后端由开机自启运行；没在运行时请在${WA_TERMINAL}里重新运行一次安装命令。`,
  disconnected: `宿主启动后立即断开，请查看 ${WA_LOG_PATH} 中的错误。`,
  launch_failed: `宿主未能启动后端，请查看 ${WA_LOG_PATH} 中的错误。`,
  unknown: `请在${WA_TERMINAL}里重新运行一次安装命令（会重新注册宿主）后重试。`
};

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
 * 更新同步时间戳
 */
async function updateLastSyncTime() {
  await chrome.storage.local.set({ [STORAGE_KEY_LAST_SYNC]: Date.now() });
  console.log('[Background] 同步时间戳已更新');
}

/**
 * 发送进度更新到已打开的 newtab 页面
 * newtab 是扩展页面，runtime.sendMessage 直接广播即可，不需要 tabs 权限
 */
function sendProgressUpdate(currentStep, totalSteps, message) {
  chrome.runtime.sendMessage({ action: 'updateProgress', currentStep, totalSteps, message })
    .catch(() => { /* 没有打开的 newtab 页面时会报「无接收方」，忽略 */ });
}

/**
 * 从禅道同步「我的任务」「我的 Bug」到本地（后端直连）
 * 禅道是否启用由后端判断；后端没在跑时 callBackendZentao 会先自动拉起
 */
async function syncFromZentaoViaBackend() {
  console.log('[Background] ========== 开始后端同步 ==========');
  try {
    sendProgressUpdate(1, 2, '正在从禅道拉取我的任务和 Bug...');
    const data = await callBackendZentao('/api/zentao/sync', { body: {} });

    if (!data.success) {
      console.warn('[Background] 后端同步失败:', data.message);
      return { success: false, reason: data.message || 'sync_failed' };
    }

    sendProgressUpdate(2, 2, '同步完成');
    await updateLastSyncTime();

    const d = data.data || {};
    console.log('[Background] ✓ 后端同步完成:', d);
    const removed = (d.removed || 0) + (d.bugs ? d.bugs.removed || 0 : 0);

    try {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: '禅道助手 - 禅道同步',
        message: `已同步我的任务：更新 ${d.updated || 0} 个，新增 ${d.added || 0} 个` +
          (d.bugs ? `；Bug：更新 ${d.bugs.updated || 0} 个，新增 ${d.bugs.added || 0} 个` : '') +
          (removed ? `；禅道里已删除的 ${removed} 条已从插件移除` : '')
      });
    } catch (e) { /* 通知失败忽略 */ }

    // 字段要齐全：前端会拼「已同步 N 个任务和 M 个Bug」，
    // 少一个就是这个字面量 undefined 出现在用户眼前（曾经的真实 bug）。
    return {
      success: true,
      data: {
        tasksSynced: d.total || 0,
        added: d.added || 0,
        updated: d.updated || 0,
        skipped: d.skipped || 0,
        removed,
        bugsSynced: d.bugs ? (d.bugs.added || 0) + (d.bugs.updated || 0) : 0,
        bugError: d.bugError || ''
      }
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
  const { taskId, execution, name, pri, deadline } = params;
  console.log('[Background] 编辑禅道任务（后端直连）:', { taskId, execution, name, pri, deadline });
  try {
    const data = await callBackendZentao('/api/zentao/task/edit', {
      body: { taskId, execution, name, pri, deadline }
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
  const { bugId, resolution, assignedTo, comment, localId, attachmentIds } = params;
  try {
    // localId + attachmentIds：随解决动作一起提交的验证截图（已暂存在本地附件区）
    return await callBackendZentao('/api/zentao/bug/resolve', {
      body: { bugId, resolution, assignedTo, comment, localId, attachmentIds }
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
        title: '禅道助手',
        message: result.success ? `任务已添加：${result.data.title}` : '添加失败，请确保后端服务正在运行'
      });
    } catch (err) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: '禅道助手',
        message: '连接失败，请确保后端服务正在运行'
      });
    }
  }
});

// ============================================================================
// 消息处理
// ============================================================================
const ACTION_HANDLERS = {
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

  if (action === 'checkSelfUpdate') {
    checkSelfUpdate().then(sendResponse).catch(err => sendResponse({ updated: false, reason: err.message }));
    return true;
  }

  if (action === 'manualSyncFromZentao') {
    syncFromZentaoViaBackend()
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, reason: err.message }));
    return true;
  }

  // —— 后端状态与生命周期 ——
  if (action === 'startBackend') {
    launchBackendViaNative()
      .then(async (r) => {
        const alive = await isBackendAlive();
        const code = alive ? undefined : (r.code || 'unknown');
        sendResponse({
          success: alive,
          started: r.started,
          code: code || '',
          reason: r.reason || '',
          // 前端直接展示这段中文指引，省去用户自己解读英文原生报错
          help: code ? (LAUNCH_ERROR_HELP[code] || LAUNCH_ERROR_HELP.unknown) : '',
          url: API_BASE_URL
        });
      })
      .catch(err => sendResponse({
        success: false,
        code: 'unknown',
        reason: err.message,
        help: LAUNCH_ERROR_HELP.unknown
      }));
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

  // 开机自启（写 LaunchAgent，必须由本机后端代劳：
  // 扩展沙箱既不能写文件也不能执行 launchctl）
  if (action === 'setAutoStart') {
    fetch(`${API_BASE_URL}/api/admin/autostart`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !!request.enabled })
    })
      .then(async (resp) => {
        const json = await resp.json().catch(() => ({}));

        // 404 说明后端还是旧版本（进程没重启，代码没加载）。
        // 必须单独说清楚：否则前端只能显示一句「操作失败」，
        // 用户完全猜不到问题出在「后端该重启了」。
        if (resp.status === 404) {
          sendResponse({
            success: false,
            message: '后端服务版本过旧，没有「开机自启」接口。请重启本地服务后重试。',
            output: ''
          });
          return;
        }
        if (!resp.ok) {
          sendResponse({
            success: false,
            message: `后端返回异常 (HTTP ${resp.status})`,
            output: (json && json.message) ? String(json.message) : ''
          });
          return;
        }

        sendResponse({
          success: !!json.success,
          // 以接口回报的实际状态为准，不要假设操作成功
          enabled: !!json.enabled,
          message: json.message || (json.success ? '操作完成' : '操作失败'),
          output: json.output || ''
        });
      })
      .catch(err => sendResponse({ success: false, reason: err.message }));
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

// ============================================================================
// 自动更新：后台把安装目录里的扩展文件换成新版本后，扩展重新加载自己
// ============================================================================
// 扩展从 WorkAssistant/extension 以「已解压」方式加载：文件被换掉后，浏览器仍在运行旧代码，
// 但读 manifest.json 拿到的是磁盘上的新版本号，据此判断要不要重新加载。
// 重新加载会让打开着的新标签页变成空白，所以先记下这些标签页，加载完再把它们导航回新标签页。
const SELF_UPDATE_ALARM = 'wa-self-update';
const RELOAD_TABS_KEY = 'waReloadTabs';
// 页面上最近有操作（打字、点击）就先不重新加载，免得打断正在填的内容
const SELF_UPDATE_IDLE_MS = 3 * 60 * 1000;

async function checkSelfUpdate() {
  const loaded = chrome.runtime.getManifest().version;
  let onDisk = '';
  try {
    const resp = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
    onDisk = (await resp.json()).version || '';
  } catch {
    return { updated: false, reason: 'manifest_unreadable' };
  }
  if (!onDisk || onDisk === loaded) return { updated: false };
  const { waLastInteraction = 0 } = await chrome.storage.session.get('waLastInteraction').catch(() => ({}));
  if (Date.now() - waLastInteraction < SELF_UPDATE_IDLE_MS) return { updated: false, reason: 'busy', version: onDisk };
  const contexts = chrome.runtime.getContexts ? await chrome.runtime.getContexts({ contextTypes: ['TAB'] }) : [];
  const tabs = [...new Set(contexts.filter(c => /\/newtab\.html/.test(c.documentUrl || '') && c.tabId >= 0).map(c => c.tabId))];
  await chrome.storage.local.set({ [RELOAD_TABS_KEY]: tabs });
  console.log(`[SelfUpdate] ${loaded} → ${onDisk}，重新加载扩展`);
  chrome.runtime.reload();
  return { updated: true, version: onDisk };
}

chrome.runtime.onInstalled.addListener(async (details) => {
  chrome.alarms.create(SELF_UPDATE_ALARM, { periodInMinutes: 5 });
  if (details.reason !== 'update') return;
  const { [RELOAD_TABS_KEY]: tabs } = await chrome.storage.local.get(RELOAD_TABS_KEY);
  await chrome.storage.local.remove(RELOAD_TABS_KEY);
  if (!Array.isArray(tabs) || !tabs.length) return;
  // 刚加载完时新标签页的替换还没生效，稍等再导航（直接 reload 会停在空白页）
  await new Promise(r => setTimeout(r, 1000));
  for (const id of tabs) chrome.tabs.update(id, { url: 'chrome://newtab/' }).catch(() => { /* 标签页已关闭 */ });
});

chrome.runtime.onStartup.addListener(() => chrome.alarms.create(SELF_UPDATE_ALARM, { periodInMinutes: 5 }));
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SELF_UPDATE_ALARM) checkSelfUpdate();
});
checkSelfUpdate();
