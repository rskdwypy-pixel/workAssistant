// 导入禅道标签页管理器
importScripts('zentaoTabManager.js');

// API配置
const API_BASE_URL = 'http://localhost:3721';

// 同步频率控制常量
const SYNC_INTERVAL = 24 * 60 * 60 * 1000; // 24小时
const STORAGE_KEY_LAST_SYNC = 'zentao_last_sync_time';

/**
 * 获取上次同步时间
 * @returns {Promise<number>} 上次同步的时间戳（毫秒）
 */
async function getLastSyncTime() {
  const result = await chrome.storage.local.get([STORAGE_KEY_LAST_SYNC]);
  return result[STORAGE_KEY_LAST_SYNC] || 0;
}

/**
 * 更新同步时间戳
 */
async function updateLastSyncTime() {
  await chrome.storage.local.set({
    [STORAGE_KEY_LAST_SYNC]: Date.now()
  });
  console.log('[Background] 同步时间戳已更新');
}

/**
 * 获取禅道配置
 * @returns {Promise<Object>} 禅道配置
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
 * @param {boolean} force - 是否强制同步（跳过时间检查）
 */
async function checkAndSyncZentao(force = false) {
  console.log('[Background] ========== newtab 页面请求检查禅道同步 ==========');
  console.log('[Background] 强制同步:', force);

  try {
    // 1. 检查禅道配置
    const config = await fetchConfig();
    if (!config.zentao?.enabled) {
      console.log('[Background] 禅道未启用，跳过同步');
      return { success: false, reason: 'zentao_not_enabled' };
    }

    // 2. 检查上次同步时间（除非强制同步）
    // 【已注释】禁用24小时自动同步逻辑，只允许手动同步
    // if (!force) {
    //   const lastSyncTime = await getLastSyncTime();
    //   const now = Date.now();
    //   const timeSinceLastSync = now - lastSyncTime;

    //   if (lastSyncTime > 0 && timeSinceLastSync < SYNC_INTERVAL) {
    //     const hoursUntilNextSync = Math.ceil((SYNC_INTERVAL - timeSinceLastSync) / (60 * 60 * 1000));
    //     console.log(`[Background] 距离上次同步不足24小时，还需等待 ${hoursUntilNextSync} 小时`);
    //     console.log('[Background] 上次同步时间:', new Date(lastSyncTime).toLocaleString('zh-CN'));
    //     return { success: false, reason: 'too_soon', hoursUntilNextSync };
    //   }

    //   if (lastSyncTime === 0) {
    //     console.log('[Background] 首次同步，开始从禅道同步数据...');
    //   } else {
    //     console.log('[Background] 距离上次同步已超过24小时，开始同步...');
    //     console.log('[Background] 上次同步时间:', new Date(lastSyncTime).toLocaleString('zh-CN'));
    //   }
    // } else {
    //   console.log('[Background] 强制同步模式，跳过时间检查');
    // }
    console.log('[Background] 手动触发同步（自动同步已禁用）');

    // 3. 执行同步
    return await syncFromZentaoInBackground(config);
  } catch (err) {
    console.error('[Background] 检查同步条件失败:', err);
    return { success: false, reason: err.message };
  }
}

// 创建右键菜单
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'addTask',
    title: '添加到任务',
    contexts: ['selection']
  });
});

// 处理右键菜单点击
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'addTask') {
    const selectedText = info.selectionText.trim();

    if (selectedText) {
      try {
        const response = await fetch(`${API_BASE_URL}/api/task`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: selectedText })
        });

        const result = await response.json();

        if (result.success) {
          // 显示通知
          chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: '工作助手',
            message: `任务已添加：${result.data.title}`
          });
        } else {
          chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon128.png',
            title: '工作助手',
            message: '添加失败，请确保后端服务正在运行'
          });
        }
      } catch (err) {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: '工作助手',
          message: '连接失败，请确保后端服务正在运行'
        });
      }
    }
  }
});

/**
 * 获取看板页面的参数（从已渲染的 DOM 中获取）
 * 必须在消息处理器之前定义
 */
async function fetchKanbanPage(params) {
  console.log('[Background] ========== fetchKanbanPage 开始 ==========');
  console.log('[Background] 接收到的params:', JSON.stringify(params));

  try {
    const { url, laneType = 'task', columnType = 'wait' } = params;

    console.log('[Background] URL:', url);
    console.log('[Background] laneType:', laneType, 'columnType:', columnType);

    let logs = []; // 收集所有日志用于返回

    // 先列出所有标签页用于调试
    console.log('[Background] 准备查询标签页...');
    const allTabs = await chrome.tabs.query({});
    console.log('[Background] ✓ 查询成功，标签页数量:', allTabs.length);
    allTabs.forEach((tab, i) => {
      console.log(`[Background]   标签 ${i}: ${tab.url?.substring(0, 80)} (id=${tab.id})`);
    });

    // 从 URL 中提取禅道 baseUrl 和 executionId
    const urlObj = new URL(url);
    const baseUrl = `${urlObj.protocol}//${urlObj.host}`;
    const executionMatch = url.match(/execution-kanban-(\d+)/);
    const executionId = executionMatch ? executionMatch[1] : null;

    logs.push(`提取参数: baseUrl=${baseUrl}, executionId=${executionId}`);
    console.log('[Background]', logs[logs.length - 1]);

    // 使用 ZentaoTabManager 复用已存在的禅道标签页
    console.log('[Background] 使用 ZentaoTabManager 获取或创建标签页');
    let targetTab = await ZentaoTabManager.getOrCreateTab({
      baseUrl,
      kanbanId: executionId,
      targetUrl: url,
      active: false,
      reload: false  // 不自动刷新，避免不必要的加载
    });

    console.log('[Background] ✓ 标签页已就绪:', targetTab.id, targetTab.url);

    if (!targetTab) {
      console.error('[Background] 无法获取或创建禅道页面');
      return { success: false, reason: 'no_zentao_tab' };
    }

    // 如果当前页面不是目标看板页面，需要导航
    // 必须精确匹配URL，区分主看板和Bug看板
    const expectedUrlPattern = new URL(url).pathname; // 获取 /zentao/execution-kanban-148-bug.html
    const currentUrlPath = targetTab.url ? new URL(targetTab.url).pathname : '';

    console.log('[Background] URL 检查:', {
      expected: expectedUrlPattern,
      current: currentUrlPath,
      match: currentUrlPath === expectedUrlPattern
    });

    if (currentUrlPath !== expectedUrlPattern) {
      console.log('[Background] 当前页面不是目标看板页面，需要导航到:', url);
      await chrome.tabs.update(targetTab.id, { url: url });

      // 等待页面加载完成
      await new Promise(resolve => {
        const listener = (tabId, changeInfo) => {
          if (tabId === targetTab.id && changeInfo.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            // 短暂等待确保 DOM 完全渲染
            setTimeout(resolve, 1000);
          }
        };
        chrome.tabs.onUpdated.addListener(listener);

        // 超时保护
        setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }, 20000);
      });

      // 重新获取 tab 信息以获取更新后的 URL
      targetTab = await chrome.tabs.get(targetTab.id);
      console.log('[Background] 导航后 URL 已更新:', targetTab.url);
    } else {
      // 即使是正确的看板页面，也等待一下确保加载完成
      console.log('[Background] ✓ 当前已是目标看板页面，等待确保加载完成');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // 从 HTML 源代码中获取参数
    console.log('[Background] 获取看板参数，laneType=' + laneType + ', columnType=' + columnType);
    console.log('[Background] 目标 URL:', targetTab.url);

    try {
      // 使用 fetch 获取页面 HTML 源代码
      console.log('[Background] 正在获取页面 HTML 源代码...');
      const response = await fetch(targetTab.url);
      const html = await response.text();
      console.log('[Background] ✓ 成功获取 HTML，长度:', html.length);

      // 从 HTML 源代码中提取参数
      console.log('[Background] ========== 开始从 HTML 源代码提取参数 ==========');

      let productId = null;    // 产品ID
      let projectId = null;    // 项目ID
      let regionId = null;
      let laneId = null;
      let columnId = null;

      // 提取 productID - 产品ID，用于构建 Bug 创建 URL
      console.log('[Background] 提取 productID...');
      const productMatch = html.match(/productID\s*=\s*(\d+);/);
      if (productMatch) {
        productId = productMatch[1];
        console.log('[Background] ✓ 找到 productID:', productId);
      } else {
        console.log('[Background] ✗ 未找到 productID');
      }

      // 提取 execution.project - 项目ID，用于表单的 project 字段
      console.log('[Background] 提取 execution.project...');
      const executionProjectMatch = html.match(/"project"\s*:\s*"(\d+)"/);
      if (executionProjectMatch) {
        projectId = executionProjectMatch[1];
        console.log('[Background] ✓ 找到 execution.project:', projectId);
      } else {
        console.log('[Background] ✗ 未找到 execution.project');
      }

      // 提取 regions 或 kanbanData
      console.log('[Background] 提取 regions/kanbanData...');

      // 辅助函数：提取嵌套对象
      function extractNestedObject(html, varName) {
        const startPattern = new RegExp(varName + '\\s*=\\s*(\\{)');
        const startMatch = html.match(startPattern);
        if (!startMatch) return null;

        const startPos = startMatch.index + startMatch[0].length - 1;
        let depth = 1;
        let endPos = startPos + 1;

        while (depth > 0 && endPos < html.length) {
          if (html[endPos] === '{') depth++;
          else if (html[endPos] === '}') depth--;
          endPos++;
        }

        if (depth !== 0) return null;
        return html.substring(startPos, endPos);
      }

      const regionsStr = extractNestedObject(html, 'regions');
      const kanbanDataStr = extractNestedObject(html, 'kanbanData');

      if (regionsStr || kanbanDataStr) {
        const dataStr = regionsStr || kanbanDataStr;
        console.log('[Background] ✓ 找到 regions/kanbanData，长度:', dataStr.length);
        try {
          // 替换 Unicode 转义序列
          const unescapedStr = dataStr.replace(/\\u([\d\w]{4})/gi, (match, grp) => {
            return String.fromCharCode(parseInt(grp, 16));
          });

          const data = JSON.parse(unescapedStr);
          console.log('[Background] ✓ 解析 regions/kanbanData 成功，keys:', Object.keys(data));

          // 提取 regionId
          const regionKeys = Object.keys(data);
          if (regionKeys.length > 0) {
            regionId = regionKeys[0];
            console.log('[Background] ✓ 找到 regionId:', regionId);

            const region = data[regionId];
            if (region.groups && region.groups.length > 0) {
              for (const group of region.groups) {
                // 提取 laneId
                if (!laneId && group.lanes && group.lanes.length > 0) {
                  for (const lane of group.lanes) {
                    if (lane.type === laneType) {
                      laneId = lane.id;
                      console.log('[Background] ✓ 找到 laneId (type=' + laneType + '):', laneId);
                      break;
                    }
                  }
                }

                // 提取 columnId
                if (!columnId && group.columns && group.columns.length > 0) {
                  for (const column of group.columns) {
                    if (column.type === columnType) {
                      columnId = column.id;
                      console.log('[Background] ✓ 找到 columnId (type=' + columnType + '):', columnId);
                      break;
                    }
                  }
                }

                if (laneId && columnId) break;
              }
            }
          }
        } catch (parseErr) {
          console.error('[Background] 解析 regions/kanbanData 失败:', parseErr);
        }
      } else {
        console.log('[Background] ✗ 未找到 regions 或 kanbanData');
      }

      // 参数提取结果总结
      console.log('[Background] ========== 参数提取总结 ==========');
      console.log('[Background] 📋 参数提取状态：');
      console.log('[Background]   - productId (产品ID):', productId ? '✓ ' + productId : '✗ 未找到');
      console.log('[Background]   - projectId (项目ID):', projectId ? '✓ ' + projectId : '✗ 未找到');
      console.log('[Background]   - regionId:', regionId ? '✓ ' + regionId : '✗ 未找到');
      console.log('[Background]   - laneId (type=' + laneType + '):', laneId ? '✓ ' + laneId : '✗ 未找到');
      console.log('[Background]   - columnId (type=' + columnType + '):', columnId ? '✓ ' + columnId : '✗ 未找到');

      // ========== 严格参数验证：所有必需参数必须存在 ==========
      const requiredParams = {
        productId: !!productId,
        regionId: !!regionId,
        laneId: !!laneId,
        columnId: !!columnId
      };

      const missingParams = Object.keys(requiredParams).filter(key => !requiredParams[key]);

      if (missingParams.length > 0) {
        console.error('[Background] ✗ 参数提取失败，缺少必需参数:', missingParams);
        return {
          success: false,
          reason: 'missing_required_params',
          missing: missingParams,
          message: '缺少必需参数: ' + missingParams.join(', ')
        };
      }

      console.log('[Background] ✓ 所有必需参数提取成功:', {
        productId,
        projectId,
        regionId,
        laneId,
        columnId
      });

      return {
        success: true,
        productId,
        projectId,
        regionId,
        laneId,
        columnId
      };
    } catch (err) {
      console.error('[Background] ✗ 获取参数异常:', err);
      return { success: false, reason: err.message };
    }

    // 二次验证：确保所有必需参数都存在
    const requiredParams = ['productId', 'regionId', 'laneId', 'columnId'];
    const missing = requiredParams.filter(param => !result[param]);

    if (missing.length > 0) {
      console.error('[Background] ✗ 参数验证失败，缺少必需参数:', missing);
      return {
        success: false,
        reason: 'missing_required_params',
        missing,
        message: '缺少必需参数: ' + missing.join(', ')
      };
    }

    console.log('[Background] ✓ 所有必需参数验证通过:', {
      productId: result.productId,
      projectId: result.projectId,
      regionId: result.regionId,
      laneId: result.laneId,
      columnId: result.columnId
    });

    if (!result) {
      return { success: false, reason: 'no_result', logs };
    }

    if (!result.success && result.debug) {
      console.log('[Background] 调试信息:', result.debug);
      // 将日志添加到调试信息中
      result.debug.logs = logs;
    }

    return result;
  } catch (outerErr) {
    console.error('[Background] fetchKanbanPage 外层异常:', outerErr.message);
    console.error('[Background] 错误堆栈:', outerErr.stack);
    return { success: false, reason: outerErr.message };
  }
}

// 处理来自前端的特权API请求
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('[Background] ========== 收到消息 ==========');
  console.log('[Background] 消息 action:', request.action);

  if (request.action === 'performZenTaoLogin') {
    console.log('[Background] 启动全自动标签页模拟登录流...');
    const baseUrl = request.url.replace(/\/$/, '');
    const loginUrl = `${baseUrl}/zentao/user-login.html`;
    console.log('[Background] 登录URL:', loginUrl);

    chrome.tabs.create({ url: loginUrl, active: false }, (tab) => {
      if (chrome.runtime.lastError) {
        console.warn('[Background] 创建标签页失败:', chrome.runtime.lastError);
        sendResponse({ success: false, error: '创建标签页失败' });
        return;
      }
      console.log('[Background] 标签页已创建, ID:', tab.id);

      const tabId = tab.id;
      let injected = false;
      let loginCompleted = false;

      // 监听该标签页的加载状态和跳转
      const listener = (updatedTabId, changeInfo, updatedTab) => {
        if (updatedTabId !== tabId) return;

        console.log('[Background] 标签页更新:', updatedTabId, changeInfo.status, updatedTab?.url?.substring(0, 50));

        // 1. 登录页加载完成，开始注入填充脚本
        if (changeInfo.status === 'complete' && updatedTab.url && updatedTab.url.includes('user-login')) {
          if (injected) return; // 防连击
          injected = true;
          console.log('[Background] 登录页加载完成，开始注入脚本...');

          chrome.scripting.executeScript({
            target: { tabId: tabId },
            func: (account, password) => {
              console.log('[Content Script] 登录脚本已执行');
              const u = document.querySelector('input[name="account"]');
              const p = document.querySelector('input[name="password"]');
              const k = document.querySelector('input[name="keepLogin"]');
              const f = document.querySelector('form');
              const b = document.getElementById('submit');
              console.log('[Content Script] 找到元素 - account:', !!u, 'password:', !!p, 'form:', !!f, 'submit:', !!b);
              if (u && p) {
                u.value = account;
                p.value = password;
                if (k) k.checked = true;
                if (b) {
                  console.log('[Content Script] 点击提交按钮');
                  b.click();
                } else if (f) {
                  console.log('[Content Script] 提交表单');
                  f.submit();
                }
              } else {
                console.log('[Content Script] 未找到登录表单元素');
              }
            },
            args: [request.username, request.password]
          }).then(() => {
            console.log('[Background] 脚本注入成功');
          }).catch(err => {
            console.warn('[Background] 脚本注入失败:', err);
          });
          return;
        }

        // 2. 监听页面是否跳转离开了 login 页面（代表提交成功）
        if (updatedTab.url && !updatedTab.url.includes('user-login') && updatedTab.url.includes(baseUrl)) {
          if (loginCompleted) return;
          loginCompleted = true;
          console.log('[Background] 标签页跳转完毕，认为登录成功', updatedTab.url);

          chrome.tabs.onUpdated.removeListener(listener);
          chrome.tabs.remove(tabId);

          chrome.cookies.get({ url: loginUrl, name: 'zentaosid' }, (cookie) => {
            if (cookie && cookie.value) {
              console.log('[Background] 标签页原生登录完毕，成功取得 SID:', cookie.value);
              sendResponse({ success: true, token: cookie.value });
            } else {
              chrome.cookies.getAll({ domain: new URL(baseUrl).hostname, name: 'zentaosid' }, (cookies) => {
                if (cookies && cookies.length > 0) {
                  sendResponse({ success: true, token: cookies[0].value });
                } else {
                  sendResponse({ success: false, error: '登录流程走完但未检测到 Cookie' });
                }
              });
            }
          });
        }
      };

      chrome.tabs.onUpdated.addListener(listener);

      setTimeout(() => {
        if (!loginCompleted) {
          console.log('[Background] 登录超时，清理资源');
          chrome.tabs.onUpdated.removeListener(listener);
          try { chrome.tabs.remove(tabId); } catch (e) { }
          sendResponse({ success: false, error: '静默登录标签页超时或账号密码有误' });
        }
      }, 30000);

    });

    return true; // 保持异步返回
  }

  if (request.action === 'executeInZentaoPage') {
    executeInZentaoPage(request)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, reason: err.message }));
    return true; // 保持异步返回
  }

  if (request.action === 'executeBugInZentaoPage') {
    executeBugInZentaoPage(request)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, reason: err.message }));
    return true;
  }

  if (request.action === 'getExecutionProductId') {
    getExecutionProductId(request)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, reason: err.message }));
    return true;
  }

  if (request.action === 'executeNormalExecutionBugInZentaoPage') {
    executeNormalExecutionBugInZentaoPage(request)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, reason: err.message }));
    return true;
  }

  if (request.action === 'updateZentaoTaskStatus') {
    updateZentaoTaskStatus(request)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, reason: err.message }));
    return true; // 保持异步返回
  }

  if (request.action === 'recordZentaoEffort') {
    recordZentaoEffort(request)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, reason: err.message }));
    return true; // 保持异步返回
  }

  if (request.action === 'deleteZentaoTask') {
    deleteZentaoTask(request)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, reason: err.message }));
    return true; // 保持异步返回
  }

  if (request.action === 'editZentaoTask') {
    editZentaoTask(request)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, reason: err.message }));
    return true; // 保持异步返回
  }

  // 看板相关操作
  if (request.action === 'createKanbanCard') {
    createKanbanCard(request)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, reason: err.message }));
    return true;
  }

  if (request.action === 'createKanbanTask') {
    createKanbanTask(request)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, reason: err.message }));
    return true;
  }

  if (request.action === 'updateKanbanCardStatus') {
    updateKanbanCardStatus(request)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, reason: err.message }));
    return true;
  }

  if (request.action === 'quickCheckKanban') {
    quickCheckKanban(request)
      .then(sendResponse)
      .catch(err => sendResponse({ isKanban: false, reason: err.message }));
    return true;
  }

  if (request.action === 'getKanbanView') {
    getKanbanView(request)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, reason: err.message }));
    return true;
  }

  if (request.action === 'fetchKanbanPage') {
    fetchKanbanPage(request)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, reason: err.message }));
    return true;
  }
});

// 在禅道页面中执行请求创建 Bug
async function executeBugInZentaoPage(params) {
  const { baseUrl, productId, bugData } = params;
  const executionId = bugData.executionId || '';
  const projectId = bugData.projectId || '';

  console.log('[Background] 尝试在禅道页面中执行创建 Bug');

  const targetTab = await ensureZentaoTab(baseUrl);
  if (!targetTab) {
    return { success: false, reason: 'no_zentao_tab' };
  }

  // 构建端点 URL（在 background.js 中构建，避免 window 未定义问题）
  let endpoint;
  if (bugData.regionId && bugData.laneId && bugData.columnId) {
    endpoint = `${baseUrl}/zentao/bug-create-${productId}-0-regionID=${bugData.regionId},laneID=${bugData.laneId},columnID=${bugData.columnId},executionID=${executionId}.html?onlybody=yes`;
  } else {
    endpoint = `${baseUrl}/zentao/bug-create-${productId}-${executionId}.html`;
  }

  console.log('[Background] Bug 创建端点:', endpoint);

  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTab.id },
    func: (productId, executionId, projectId, bugData, endpoint) => {
      return new Promise((resolve) => {
        console.log('[Bug Create] 准备创建 Bug:', { productId, executionId, projectId, title: bugData.title });
        console.log('[Bug Create] 请求端点:', endpoint);

        const formData = new FormData();
        formData.append('product', productId);
        formData.append('module', '0');
        if (projectId) formData.append('project', projectId);
        if (executionId) formData.append('execution', executionId);
        formData.append('openedBuild[]', bugData.openedBuild || 'trunk');

        // 处理指派人（兼容新旧格式）
        const assignedTo = bugData.assignedTo || (bugData.assignedToList && bugData.assignedToList.length > 0 ? bugData.assignedToList[0] : '');
        if (assignedTo) formData.append('assignedTo', assignedTo);

        formData.append('deadline', '');
        formData.append('feedbackBy', '');
        formData.append('notifyEmail', '');
        formData.append('type', bugData.type || 'codeerror');

        // 添加缺失的必需字段
        formData.append('os[]', '');
        formData.append('browser[]', '');

        // 看板相关参数
        if (bugData.regionId) formData.append('region', bugData.regionId);
        if (bugData.laneId) formData.append('lane', bugData.laneId);

        formData.append('title', bugData.title);
        formData.append('color', '');
        formData.append('severity', String(bugData.severity || 3));
        formData.append('pri', String(bugData.pri || 3));
        formData.append('steps', bugData.steps || '');
        formData.append('story', '');
        formData.append('task', '');
        formData.append('oldTaskID', '0'); // 必需字段

        // 处理抄送人列表（支持，放在 keywords 之前）
        if (bugData.cc && Array.isArray(bugData.cc)) {
          bugData.cc.forEach(ccAccount => {
            if (ccAccount) formData.append('mailto[]', ccAccount);
          });
        }

        formData.append('keywords', '');
        formData.append('status', 'active'); // 看板创建 Bug 必须使用 active、resolved 或 closed
        formData.append('issueKey', '');

        // 注意：不发送 comment 字段（看板创建 Bug 不支持此字段）

        formData.append('uid', Math.random().toString(36).substring(2, 14));
        formData.append('case', '0');
        formData.append('caseVersion', '0');
        formData.append('result', '0');
        formData.append('testtask', '0');

        fetch(endpoint, {
          method: 'POST',
          headers: {
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: formData
        })
        .then(async r => {
          console.log('[Bug Create] 响应 HTTP 状态:', r.status);
          const text = await r.text();
          return { status: r.status, text };
        })
        .then(({ status, text }) => {
          console.log('[Bug Create] ========== 响应分析 ==========');
          console.log('[Bug Create] 响应 HTTP 状态:', status);
          console.log('[Bug Create] 响应内容长度:', text.length);
          console.log('[Bug Create] 响应内容 (前1000字符):', text.substring(0, 1000));
          if (text.length > 1000) {
            console.log('[Bug Create] 响应内容 (后500字符):', text.substring(text.length - 500));
          }
          console.log('[Bug Create] 响应完整内容:', text);

          try {
            const data = JSON.parse(text);
            console.log('[Bug Create] ✓ JSON 解析成功');
            console.log('[Bug Create] data.result:', data.result);
            console.log('[Bug Create] data.message:', data.message);
            console.log('[Bug Create] data.locate:', data.locate);
            console.log('[Bug Create] data.id:', data.id);
            console.log('[Bug Create] data.bug?.id:', data.bug?.id);
            console.log('[Bug Create] data.data?.id:', data.data?.id);
            console.log('[Bug Create] data.callback (存在?):', !!data.callback);
            if (data.callback) {
              console.log('[Bug Create] data.callback 长度:', data.callback.length);
              console.log('[Bug Create] data.callback (前500字符):', data.callback.substring(0, 500));
              console.log('[Bug Create] data.callback (后500字符):', data.callback.substring(data.callback.length - 500));
            }
            console.log('[Bug Create] 完整 data 对象:', JSON.stringify(data, null, 2));
            resolve({ success: true, data });
          } catch (e) {
            console.error('[Bug Create] ✗ JSON 解析失败:', e);
            console.error('[Bug Create] 解析错误详情:', e.message);
            resolve({ success: false, reason: 'invalid_json', responseText: text.substring(0, 1000) });
          }
          console.log('[Bug Create] ========== 响应分析结束 ==========');
        })
        .catch(err => {
          console.error('[Bug Create] 请求失败:', err);
          resolve({ success: false, reason: err.message });
        });
      });
    },
    args: [productId, executionId, projectId, bugData, endpoint]
  });

  return results[0].result;
}

// 获取普通执行的 productID
async function getExecutionProductId(params) {
  const { baseUrl, executionId } = params;

  console.log('[Background] 获取普通执行的 productID, executionId:', executionId);

  const targetTab = await ensureZentaoTab(baseUrl);
  if (!targetTab) {
    return { success: false, reason: 'no_zentao_tab' };
  }

  // 导航到执行页面
  const executionUrl = `${baseUrl}/zentao/execution-bug-${executionId}.html`;
  console.log('[Background] 导航到执行页面:', executionUrl);

  await chrome.tabs.update(targetTab.id, { url: executionUrl });

  // 等待页面加载完成
  await new Promise(resolve => {
    const listener = (tabId, changeInfo) => {
      if (tabId === targetTab.id && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 500); // 额外等待确保页面稳定
      }
    };
    chrome.tabs.onUpdated.addListener(listener);

    // 超时保护
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
  });

  console.log('[Background] 执行页面已加载，从 DOM 中提取 productID');

  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTab.id },
    func: (executionId) => {
      return new Promise((resolve) => {
        console.log('[Get ProductID] 从页面 DOM 中查找提Bug链接');

        // 查找 iframe
        const iframe = document.getElementById('appIframe-execution');
        if (!iframe) {
          console.error('[Get ProductID] 未找到 appIframe-execution iframe');
          resolve({ success: false, reason: 'iframe_not_found' });
          return;
        }

        console.log('[Get ProductID] 找到 iframe');

        // 等待 iframe 加载完成
        if (!iframe.contentDocument || !iframe.contentDocument.body) {
          console.log('[Get ProductID] iframe 还未加载完成，等待...');
          iframe.addEventListener('load', () => {
            console.log('[Get ProductID] iframe 加载完成');
            extractProductId();
          });

          // 超时保护
          setTimeout(() => {
            console.error('[Get ProductID] iframe 加载超时');
            resolve({ success: false, reason: 'iframe_load_timeout' });
          }, 5000);
        } else {
          console.log('[Get ProductID] iframe 已加载完成');
          extractProductId();
        }

        function extractProductId() {
          try {
            const iframeDoc = iframe.contentDocument;
            if (!iframeDoc) {
              console.error('[Get ProductID] 无法访问 iframe contentDocument');
              resolve({ success: false, reason: 'iframe_access_denied' });
              return;
            }

            // 从 iframe DOM 中查找提Bug链接
            const allLinks = iframeDoc.querySelectorAll('a[href*="bug-create"]');
            console.log('[Get ProductID] 在 iframe 中找到', allLinks.length, '个 bug-create 链接');

            // 构建动态正则表达式
            const regexPattern = new RegExp(`/zentao/bug-create-(\\d+)-0-executionID=${executionId}\\.html`, 'i');
            console.log('[Get ProductID] 使用正则:', regexPattern);

            let productId = null;
            for (const link of allLinks) {
              const href = link.getAttribute('href');
              console.log('[Get ProductID] 检查链接:', href);

              // 匹配格式：/zentao/bug-create-{productID}-0-executionID={executionId}.html
              const match = href.match(regexPattern);
              if (match) {
                productId = match[1];
                console.log('[Get ProductID] ✓ 找到匹配的链接, productID:', productId);
                break;
              }
            }

            if (!productId) {
              console.error('[Get ProductID] ✗ 未找到匹配的提Bug链接');
              console.log('[Get ProductID] iframe URL:', iframe.src);
              // 打印 iframe 部分内容用于调试
              console.log('[Get ProductID] iframe body (前2000字符):', iframeDoc.body.innerHTML.substring(0, 2000));
              resolve({ success: false, reason: 'bug_create_link_not_found' });
              return;
            }

            console.log('[Get ProductID] ✓✓✓ 成功提取 productID:', productId);
            resolve({ success: true, productId });
          } catch (err) {
            console.error('[Get ProductID] 提取 productID 异常:', err);
            resolve({ success: false, reason: err.message });
          }
        }
      });
    },
    args: [executionId]
  });

  return results[0].result;
}

// 在禅道页面中执行普通执行 Bug 创建
async function executeNormalExecutionBugInZentaoPage(params) {
  const { baseUrl, productId, bugData } = params;
  const executionId = bugData.executionId || '';
  const projectId = bugData.projectId || '';
  const bugTitle = bugData.title || '';

  console.log('[Background] 尝试在禅道页面中执行普通执行 Bug 创建');

  const targetTab = await ensureZentaoTab(baseUrl);
  if (!targetTab) {
    return { success: false, reason: 'no_zentao_tab' };
  }

  // 构建端点 URL（普通执行不需要看板位置参数）
  const endpoint = `${baseUrl}/zentao/bug-create-${productId}-0-executionID=${executionId}.html`;

  console.log('[Background] 普通 Bug 创建端点:', endpoint);

  // 记录创建时间
  const createTime = Date.now();

  // 第一步：在当前页面中提交 Bug 创建请求
  const createResults = await chrome.scripting.executeScript({
    target: { tabId: targetTab.id },
    func: (productId, executionId, projectId, bugData, endpoint) => {
      return new Promise((resolve) => {
        console.log('[Normal Bug Create] 准备创建 Bug:', { productId, executionId, projectId, title: bugData.title });
        console.log('[Normal Bug Create] 请求端点:', endpoint);

        const formData = new FormData();
        formData.append('product', productId);
        formData.append('module', '0');
        formData.append('project', projectId || '');
        formData.append('execution', executionId);
        formData.append('openedBuild[]', bugData.openedBuild || 'trunk');

        // 处理指派人
        const assignedTo = bugData.assignedTo || (bugData.assignedToList && bugData.assignedToList.length > 0 ? bugData.assignedToList[0] : '');
        if (assignedTo) formData.append('assignedTo', assignedTo);

        formData.append('deadline', '');
        formData.append('feedbackBy', '');
        formData.append('notifyEmail', '');
        formData.append('type', bugData.type || 'codeerror');
        formData.append('os[]', '');
        formData.append('browser[]', '');
        formData.append('title', bugData.title);
        formData.append('color', '');
        formData.append('severity', String(bugData.severity || 3));
        formData.append('pri', String(bugData.pri || 3));
        formData.append('steps', bugData.steps || '');
        formData.append('story', '');
        formData.append('task', '');
        formData.append('oldTaskID', '0');

        // 处理抄送人列表
        if (bugData.cc && Array.isArray(bugData.cc)) {
          bugData.cc.forEach(ccAccount => {
            if (ccAccount) formData.append('mailto[]', ccAccount);
          });
        }

        formData.append('keywords', '');
        formData.append('status', 'active');
        formData.append('issueKey', '');
        formData.append('uid', Math.random().toString(36).substring(2, 14));
        formData.append('case', '0');
        formData.append('caseVersion', '0');
        formData.append('result', '0');
        formData.append('testtask', '0');

        fetch(endpoint, {
          method: 'POST',
          headers: {
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: formData
        })
        .then(async r => {
          console.log('[Normal Bug Create] 响应 HTTP 状态:', r.status);
          const text = await r.text();
          return { status: r.status, text };
        })
        .then(({ status, text }) => {
          console.log('[Normal Bug Create] 响应 HTTP 状态:', status);

          if (status !== 200) {
            resolve({ success: false, reason: 'http_error', status });
            return;
          }

          try {
            const data = JSON.parse(text);
            console.log('[Normal Bug Create] 解析成功:', data);

            if (data.result !== 'success') {
              resolve({ success: false, reason: 'api_error', message: data.message });
              return;
            }

            // 返回 locate URL，让 background.js 处理导航
            const locateUrl = data.locate;
            console.log('[Normal Bug Create] locate URL:', locateUrl);

            if (!locateUrl) {
              resolve({ success: false, reason: 'no_locate_url' });
              return;
            }

            resolve({ success: true, locateUrl });
          } catch (e) {
            console.error('[Normal Bug Create] JSON 解析失败:', e);
            resolve({ success: false, reason: 'invalid_json', responseText: text.substring(0, 1000) });
          }
        })
        .catch(err => {
          console.error('[Normal Bug Create] 请求失败:', err);
          resolve({ success: false, reason: err.message });
        });
      });
    },
    args: [productId, executionId, projectId, bugData, endpoint]
  });

  const createResult = createResults[0].result;

  if (!createResult.success) {
    return createResult;
  }

  const locateUrl = createResult.locateUrl;
  console.log('[Background] Bug 创建成功，准备导航到列表页面:', locateUrl);

  // 第二步：导航到列表页面
  const fullLocateUrl = locateUrl.startsWith('http') ? locateUrl : `${baseUrl}${locateUrl}`;

  // 第三步：尝试匹配BugID，最多刷新页面2次
  const maxAttempts = 3; // 总共尝试3次（初始1次 + 刷新2次）
  let bugId = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log('[Background] ========== 第 ' + attempt + ' 次尝试匹配 BugID ==========');

    // 导航到列表页面（首次或刷新）
    if (attempt === 1) {
      console.log('[Background] 导航到列表页面:', fullLocateUrl);
      await chrome.tabs.update(targetTab.id, { url: fullLocateUrl });
    } else {
      console.log('[Background] 第 ' + attempt + ' 次刷新页面');
      await chrome.tabs.reload(targetTab.id);
    }

    // 等待页面加载完成
    await new Promise(resolve => {
      const listener = (tabId, changeInfo) => {
        if (tabId === targetTab.id && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          setTimeout(resolve, 1000); // 等待1秒让页面稳定
        }
      };
      chrome.tabs.onUpdated.addListener(listener);

      // 超时保护
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 15000);
    });

    // 再等待1秒让数据充分加载
    await new Promise(r => setTimeout(r, 1000));

    console.log('[Background] 页面已加载，从 DOM 中提取 BugID');

    // 从 DOM 中提取 BugID
    const bugIdResults = await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      func: (bugTitle, createTime) => {
        return new Promise((resolve) => {
          console.log('[Get BugID] 从列表页面 DOM 中查找 BugID, 标题:', bugTitle, '创建时间:', createTime);

          // 查找 iframe
          const iframe = document.getElementById('appIframe-execution');
          if (!iframe) {
            console.error('[Get BugID] 未找到 appIframe-execution iframe');
            resolve({ success: false, reason: 'iframe_not_found' });
            return;
          }

          console.log('[Get BugID] 找到 iframe');

          // 等待 iframe 加载完成
          if (!iframe.contentDocument || !iframe.contentDocument.body) {
            console.log('[Get BugID] iframe 还未加载完成，等待...');
            iframe.addEventListener('load', () => {
              console.log('[Get BugID] iframe 加载完成');
              setTimeout(() => extractBugId(), 1000); // 额外等待1秒
            });

            // 超时保护
            setTimeout(() => {
              console.error('[Get BugID] iframe 加载超时');
              resolve({ success: false, reason: 'iframe_load_timeout' });
            }, 10000);
          } else {
            console.log('[Get BugID] iframe 已加载完成');
            setTimeout(() => extractBugId(), 1000); // 等待1秒让数据充分加载
          }

          function extractBugId() {
            try {
              const iframeDoc = iframe.contentDocument;
              if (!iframeDoc) {
                console.error('[Get BugID] 无法访问 iframe contentDocument');
                resolve({ success: false, reason: 'iframe_access_denied' });
                return;
              }

              // 从 iframe DOM 中查找 bugList 表格
              const bugList = iframeDoc.getElementById('bugList');
              if (!bugList) {
                console.error('[Get BugID] 未找到 bugList 表格');
                resolve({ success: false, reason: 'buglist_not_found' });
                return;
              }

              console.log('[Get BugID] 找到 bugList 表格');

              // 获取所有行（排除表头）
              const tbody = bugList.querySelector('tbody');
              if (!tbody) {
                console.error('[Get BugID] 未找到 tbody');
                resolve({ success: false, reason: 'tbody_not_found' });
                return;
              }

              const rows = tbody.querySelectorAll('tr');
              console.log('[Get BugID] 找到', rows.length, '个 Bug');

              if (rows.length === 0) {
                console.error('[Get BugID] 未找到任何行');
                resolve({ success: false, reason: 'no_rows_found' });
                return;
              }

              // 遍历所有行，查找标题匹配且创建时间最接近的 Bug
              let matchedBug = null;
              let minTimeDiff = Infinity;

              for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const bugId = row.getAttribute('data-id');

                // 提取标题
                const titleCell = row.querySelector('.c-title');
                if (!titleCell) continue;

                const titleLink = titleCell.querySelector('a');
                if (!titleLink) continue;

                const title = titleLink.textContent.trim();
                const titleAttr = titleLink.getAttribute('title');
                const displayTitle = titleAttr || title;

                // 提取创建时间
                const dateCell = row.querySelector('.c-openedDate');
                let createdTime = null;
                if (dateCell) {
                  const dateText = dateCell.textContent.trim();
                  console.log('[Get BugID] Bug', bugId, '标题:', displayTitle, '日期:', dateText);

                  // 解析日期格式：04-01 10:11
                  const dateMatch = dateText.match(/(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
                  if (dateMatch) {
                    const month = parseInt(dateMatch[1]) - 1; // 月份从0开始
                    const day = parseInt(dateMatch[2]);
                    const hour = parseInt(dateMatch[3]);
                    const minute = parseInt(dateMatch[4]);

                    const bugDate = new Date();
                    bugDate.setMonth(month);
                    bugDate.setDate(day);
                    bugDate.setHours(hour);
                    bugDate.setMinutes(minute);
                    bugDate.setSeconds(0);
                    bugDate.setMilliseconds(0);

                    createdTime = bugDate.getTime();
                    const timeDiff = Math.abs(createTime - createdTime);

                    console.log('[Get BugID] Bug', bugId, '解析时间:', new Date(createdTime), '时间差:', timeDiff, 'ms');

                    // 检查标题是否匹配
                    if (displayTitle === bugTitle) {
                      console.log('[Get BugID] ✓ Bug', bugId, '标题匹配');
                      if (timeDiff < minTimeDiff) {
                        minTimeDiff = timeDiff;
                        matchedBug = { bugId, createdTime, title: displayTitle };
                        console.log('[Get BugID] ✓✓ 更新匹配Bug:', matchedBug, '时间差:', minTimeDiff);
                      }
                    } else {
                      console.log('[Get BugID] ✗ Bug', bugId, '标题不匹配, 期望:', bugTitle, '实际:', displayTitle);
                    }
                  }
                }
              }

              if (!matchedBug) {
                console.error('[Get BugID] ✗ 未找到匹配的 Bug');
                console.log('[Get BugID] 搜索标题:', bugTitle);
                resolve({ success: false, reason: 'no_matching_bug', searchedTitle: bugTitle });
                return;
              }

              console.log('[Get BugID] ✓✓✓ 成功匹配 Bug, ID:', matchedBug.bugId, '标题:', matchedBug.title, '时间差:', minTimeDiff, 'ms');
              resolve({ success: true, bugId: matchedBug.bugId });
            } catch (err) {
              console.error('[Get BugID] 提取 BugID 异常:', err);
              resolve({ success: false, reason: err.message });
            }
          }
        });
      },
      args: [bugTitle, createTime]
    });

    const bugIdResult = bugIdResults[0].result;

    // 如果找到了匹配的Bug，直接返回
    if (bugIdResult.success) {
      console.log('[Background] ✓✓✓ 第 ' + attempt + ' 次尝试成功找到 BugID:', bugIdResult.bugId);
      bugId = bugIdResult.bugId;
      break;
    }

    // 如果是最后一次尝试仍然失败，放弃
    if (attempt === maxAttempts) {
      console.error('[Background] ✗✗✗ 所有尝试都失败，无法找到 BugID');
      return { success: false, reason: 'all_attempts_failed', searchedTitle: bugTitle };
    }

    console.log('[Background] 第 ' + attempt + ' 次尝试失败，准备刷新页面重试');
  }

  return { success: true, data: { id: bugId } };
}

// 在禅道页面中执行请求（使用 content script）
async function executeInZentaoPage(params) {
  const { baseUrl, executionId, username, taskData } = params;
  const createTaskUrl = `${baseUrl}/zentao/task-create-${executionId}-0-0.html`;

  console.log('[Background] 尝试在禅道页面中执行请求');

  // 使用 ZentaoTabManager 复用已存在的禅道标签页
  let targetTab = await ZentaoTabManager.getOrCreateTab({
    baseUrl,
    targetUrl: createTaskUrl,
    active: false
  });

  console.log('[Background] 使用标签页:', targetTab.id);

  // 在禅道页面中注入脚本执行请求
  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTab.id },
    func: (executionId, username, taskData, uid) => {
      return new Promise((resolve) => {
        console.log('[Task Create] 准备创建任务:', { executionId, username, title: taskData.title });

        const formData = new FormData();
        formData.append('execution', executionId);
        formData.append('type', 'test');
        formData.append('module', '0');
        formData.append('assignedTo[]', username);
        formData.append('teamMember', '');
        formData.append('mode', 'linear');
        formData.append('status', 'wait');
        formData.append('story', '');
        formData.append('color', '');
        formData.append('name', taskData.title);
        formData.append('storyEstimate', '');
        formData.append('storyDesc', '');
        formData.append('storyPri', '');
        formData.append('pri', '3');
        formData.append('estimate', '');
        formData.append('desc', taskData.content || taskData.title);
        formData.append('estStarted', '');
        formData.append('deadline', taskData.dueDate || '');
        formData.append('after', 'toTaskList');
        formData.append('uid', uid);

        for (let i = 0; i < 5; i++) {
          formData.append('team[]', '');
          formData.append('teamSource[]', '');
          formData.append('teamEstimate[]', '');
        }

        const endpoint = `${window.location.origin}/zentao/task-create-${executionId}-0-0.html`;
        console.log('[Task Create] 请求端点:', endpoint);

        fetch(endpoint, {
          method: 'POST',
          headers: {
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: formData
        })
        .then(r => {
          console.log('[Task Create] 响应状态:', r.status);
          return r.text();
        })
        .then(text => {
          console.log('[Task Create] 响应内容 (前200字符):', text.substring(0, 200));
          try {
            const data = JSON.parse(text);
            console.log('[Task Create] 解析成功:', data);
            resolve({ success: true, data });
          } catch (e) {
            console.error('[Task Create] JSON 解析失败:', e);
            resolve({ success: false, reason: 'invalid_json', responseText: text.substring(0, 500) });
          }
        })
        .catch(err => {
          console.error('[Task Create] 请求失败:', err);
          resolve({ success: false, reason: err.message });
        });
      });
    },
    args: [executionId, username, taskData, generateUid()]
  });

  return results[0].result;
}

// 确保禅道页面存在，如果不存在则创建一个
// kanbanId: 可选，如果提供则尝试找到匹配的看板页面
async function ensureZentaoTab(baseUrl, kanbanId) {
  console.log('[Background] ensureZentaoTab 调用:', { baseUrl, kanbanId });

  // 使用 ZentaoTabManager 统一管理标签页
  const targetUrl = kanbanId ? `${baseUrl}/zentao/execution-kanban-${kanbanId}.html` : null;

  return await ZentaoTabManager.getOrCreateTab({
    baseUrl,
    kanbanId,
    targetUrl,
    active: true,  // 保持原有的行为，设为可见
    reload: false  // 不自动刷新，让调用方决定
  });
}

// 更新禅道任务状态
async function updateZentaoTaskStatus(params) {
  const { baseUrl, taskId, status } = params;

  console.log('[Background] 更新禅道任务状态:', { taskId, status });

  // 确保禅道页面存在
  const targetTab = await ensureZentaoTab(baseUrl);

  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTab.id },
    func: (taskId, status) => {
      return new Promise((resolve) => {
        const endpoint = `${window.location.origin}/zentao/task.json/${taskId}`;

        fetch(endpoint, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: JSON.stringify({ status })
        })
        .then(async r => {
          const text = await r.text();
          if (!text || !text.trim()) {
            console.warn('[Background] 更新状态响应为空');
            return { success: false, reason: 'empty_response', status: r.status };
          }
          try {
            return { success: true, data: JSON.parse(text), status: r.status };
          } catch (e) {
            console.warn('[Background] 解析响应失败:', text.substring(0, 200));
            return { success: false, reason: 'invalid_json', responseText: text.substring(0, 200) };
          }
        })
        .then(result => {
          if (result.success && result.data && result.data.result === 'success') {
            resolve({ success: true });
          } else {
            resolve({ success: false, reason: result.reason || result.data?.message || '更新失败' });
          }
        })
        .catch(err => {
          resolve({ success: false, reason: err.message });
        });
      });
    },
    args: [taskId, status]
  });

  return results[0].result;
}

// 记录禅道任务工时
async function recordZentaoEffort(params) {
  const { baseUrl, taskId, comment, consumedTime, leftTime, kanbanId, progress } = params;

  console.log('[Background] 记录禅道任务工时:', { taskId, consumedTime, comment, kanbanId, progress });

  // 确保禅道页面存在（如果提供了 kanbanId，尝试找到匹配的页面）
  const targetTab = await ensureZentaoTab(baseUrl, kanbanId);
  console.log('[Background] recordZentaoEffort 使用禅道页面:', targetTab?.url);

  // 获取当前日期
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTab.id },
    func: (taskId, comment, consumedTime, leftTime, today, progress) => {
      return new Promise((resolve) => {
        const endpoint = `${window.location.origin}/zentao/task-recordEstimate-${taskId}.html?onlybody=yes`;

        // 构建表单数据（URL 编码格式）
        const params = new URLSearchParams();
        params.append('dates[1]', today);
        params.append('id[1]', '1');
        params.append('work[1]', comment || '工作内容进度更新');
        params.append('consumed[1]', consumedTime);
        params.append('left[1]', leftTime);

        // 添加4个空的表单项
        for (let i = 2; i <= 5; i++) {
          params.append(`dates[${i}]`, today);
          params.append(`id[${i}]`, i);
          params.append(`work[${i}]`, '');
          params.append(`consumed[${i}]`, '');
          params.append(`left[${i}]`, '');
        }

        fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: params.toString()
        })
        .then(r => {
          console.log('[Background Content] recordEstimate 响应状态:', r.status);
          return r.text();
        })
        .then(text => {
          console.log('[Background Content] recordEstimate 响应长度:', text.length, '前200字符:', text.substring(0, 200));
          // 检查是否成功（返回的 HTML 中可能包含成功信息）
          if (text.includes('class="alert alert-success"') || text.includes('保存成功') || text.includes('记录成功')) {
            console.log('[Background Content] ✓ 工时记录成功 (明确成功标识)');
            resolve({ success: true });
          } else if (text.includes('class="alert alert-danger"') || text.includes('错误')) {
            // 尝试提取错误信息
            const errorMatch = text.match(/<div class="alert alert-danger"[^>]*>([^<]+)</);
            const errorMsg = errorMatch ? errorMatch[1] : '记录工时失败';
            console.log('[Background Content] ✗ 工时记录失败:', errorMsg);
            resolve({ success: false, reason: errorMsg });
          } else if (text.includes('user-login') || text.includes('登录')) {
            console.log('[Background Content] ✗ 会话已过期，需要重新登录');
            resolve({ success: false, reason: '会话已过期' });
          } else {
            // 可能是重定向或其他情况
            console.log('[Background Content] ⚠ 工时记录 - 无明确标识，假定成功。响应内容:', text.substring(0, 500));
            resolve({ success: true, assumed: true });
          }
        })
        .catch(err => {
          console.log('[Background Content] ✗ 工时记录请求异常:', err.message);
          resolve({ success: false, reason: err.message });
        });
      });
    },
    args: [taskId, comment, consumedTime, leftTime, today, progress]
  });

  console.log('[Background] recordZentaoEffort 执行结果:', results[0]?.result);
  return results[0].result;
}

// 生成随机 UID
function generateUid() {
  return Math.random().toString(36).substring(2, 14);
}

// 删除禅道任务
async function deleteZentaoTask(params) {
  const { baseUrl, executionId, zentaoId } = params;

  console.log('[Background] 删除禅道任务:', { executionId, zentaoId });

  // 确保禅道页面存在
  const targetTab = await ensureZentaoTab(baseUrl);

  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTab.id },
    func: (executionId, zentaoId) => {
      return new Promise((resolve) => {
        // 使用 GET 请求访问删除页面（会自动执行删除操作）
        const endpoint = `${window.location.origin}/zentao/task-delete-${executionId}-${zentaoId}-yes-.html?onlybody=yes`;

        console.log('[Delete Zentao Task] 访问删除URL:', endpoint);

        fetch(endpoint, {
          method: 'GET',
          headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          },
          redirect: 'manual'
        })
        .then(r => {
          console.log('[Delete Zentao Task] 响应状态:', r.status, r.statusText);
          return r.text();
        })
        .then(text => {
          console.log('[Delete Zentao Task] 响应内容（前200字符）:', text.substring(0, 200));
          // 检查是否成功（返回的 HTML 中可能包含成功信息）
          if (text.includes('class="alert alert-success"') || text.includes('删除成功') || text.includes('success') || text.includes('已删除') || text.includes('该任务已经被删除')) {
            resolve({ success: true });
          } else if (text.includes('class="alert alert-danger"') || text.includes('错误') || text.includes('不存在')) {
            // 尝试提取错误信息
            const errorMatch = text.match(/<div class="alert alert-danger"[^>]*>([^<]+)</);
            if (errorMatch) {
              resolve({ success: false, reason: errorMatch[1] });
            } else {
              resolve({ success: false, reason: '删除禅道任务失败' });
            }
          } else {
            // 可能是重定向或其他情况，认为成功
            resolve({ success: true });
          }
        })
        .catch(err => {
          console.error('[Delete Zentao Task] 请求失败:', err);
          resolve({ success: false, reason: err.message });
        });
      });
    },
    args: [executionId, zentaoId]
  });

  return results[0].result;
}

// 编辑禅道任务
async function editZentaoTask(params) {
  const { baseUrl, taskId, execution, name, pri, username } = params;

  console.log('[Background] 编辑禅道任务:', { taskId, execution, name, pri, username });

  // 确保禅道页面存在
  const targetTab = await ensureZentaoTab(baseUrl);

  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTab.id },
    func: (taskId, execution, name, pri, defaultUsername) => {
      // 在 injected script 中生成 UID
      function generateUid() {
        return Math.random().toString(36).substring(2, 14);
      }

      return new Promise(async (resolve) => {
        try {
          // 第一步：获取任务编辑页面，解析现有字段值
          const getEndpoint = `${window.location.origin}/zentao/task-edit-${taskId}.html`;

          const getResponse = await fetch(getEndpoint, {
            method: 'GET',
            headers: {
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            }
          });

          if (!getResponse.ok) {
            resolve({ success: false, reason: '获取任务信息失败' });
            return;
          }

          const html = await getResponse.text();

          // 从 HTML 中解析表单字段的当前值
          function getFormValue(name) {
            // 尝试匹配 input 的 value 属性（处理单引号和双引号）
            let inputMatch = html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`, 'i'));
            if (!inputMatch) {
              inputMatch = html.match(new RegExp(`name='${name}'[^>]*value='([^']*)'`, 'i'));
            }
            if (inputMatch) return inputMatch[1];

            // 尝试匹配 textarea 的内容（多种格式）
            let textareaMatch = html.match(new RegExp(`<textarea[^>]*name="${name}"[^>]*>([^<]*)</textarea>`, 'is'));
            if (!textareaMatch) {
              textareaMatch = html.match(new RegExp(`<textarea[^>]*name='${name}'[^>]*>([^<]*)</textarea>`, 'is'));
            }
            if (textareaMatch) return textareaMatch[1].trim();

            // 尝试匹配 select 的选中值
            const selectMatch = html.match(new RegExp(`<select[^>]*name="${name}"[^>]*>.*?<option[^>]*value="([^"]*)"[^>]*selected`, 'is'));
            if (selectMatch) return selectMatch[1];

            return '';
          }

          // 获取所有必要的字段值
          const lastEditedDate = getFormValue('lastEditedDate');
          const currentConsumed = getFormValue('consumed') || '0';
          const currentLeft = getFormValue('left') || '0';
          const currentEstimate = getFormValue('estimate') || '0';
          const currentModule = getFormValue('module') || '0';
          const currentType = getFormValue('type') || 'test';
          const currentStatus = getFormValue('status') || 'wait';
          // assignedTo: 优先使用解析的值，否则使用当前登录账号
          const currentAssignedTo = getFormValue('assignedTo') || defaultUsername || '';
          // desc: 如果解析不到则使用新的 name 值
          let currentDesc = getFormValue('desc');
          if (!currentDesc) {
            currentDesc = name;
          }
          const currentColor = getFormValue('color') || '';
          const currentParent = getFormValue('parent') || '';
          const currentEstStarted = getFormValue('estStarted') || '';
          const currentDeadline = getFormValue('deadline') || '';
          const currentRealStarted = getFormValue('realStarted') || '';
          const currentFinishedBy = getFormValue('finishedBy') || '';
          const currentFinishedDate = getFormValue('finishedDate') || '';
          const currentCanceledBy = getFormValue('canceledBy') || '';
          const currentCanceledDate = getFormValue('canceledDate') || '';
          const currentClosedBy = getFormValue('closedBy') || '';
          const currentClosedReason = getFormValue('closedReason') || '';
          const currentClosedDate = getFormValue('closedDate') || '';

          console.log('[Edit Zentao Task] 解析到的字段:', { lastEditedDate, currentStatus, currentAssignedTo, currentDesc, name });

          // 第二步：构建编辑请求
          const formData = new FormData();
          formData.append('color', currentColor);
          formData.append('name', name || '');
          formData.append('desc', currentDesc || name);  // 确保 desc 有值
          formData.append('comment', '');
          formData.append('lastEditedDate', lastEditedDate);
          formData.append('consumed', currentConsumed);
          formData.append('uid', generateUid());
          formData.append('execution', execution);
          formData.append('module', currentModule);
          formData.append('parent', currentParent);
          formData.append('mode', 'single');  // 添加 mode 字段
          formData.append('assignedTo', currentAssignedTo);
          formData.append('type', currentType);
          formData.append('status', currentStatus);
          formData.append('pri', pri.toString());
          formData.append('estStarted', currentEstStarted);
          formData.append('deadline', currentDeadline);
          formData.append('estimate', currentEstimate);
          formData.append('left', currentLeft);
          formData.append('realStarted', currentRealStarted);
          formData.append('finishedBy', currentFinishedBy);
          formData.append('finishedDate', currentFinishedDate);
          formData.append('canceledBy', currentCanceledBy);
          formData.append('canceledDate', currentCanceledDate);
          formData.append('closedBy', currentClosedBy);
          formData.append('closedReason', currentClosedReason);
          formData.append('closedDate', currentClosedDate);

          // 添加5个空的团队表单项
          for (let i = 0; i < 5; i++) {
            formData.append('team[]', '');
            formData.append('teamSource[]', '');
            formData.append('teamEstimate[]', '');
          }

          const postResponse = await fetch(getEndpoint, {
            method: 'POST',
            headers: {
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            },
            body: formData,
            redirect: 'manual'
          });

          const text = await postResponse.text();
          console.log('[Edit Zentao Task] 响应状态:', postResponse.status);

          // 检查是否成功
          if (text.includes('class="alert alert-success"') || text.includes('保存成功') || text.includes('记录成功') || postResponse.status === 302 || postResponse.status === 301) {
            resolve({ success: true });
          } else if (text.includes('class="alert alert-danger"') || text.includes('错误')) {
            const errorMatch = text.match(/<div class="alert alert-danger"[^>]*>([^<]+)</);
            if (errorMatch) {
              resolve({ success: false, reason: errorMatch[1] });
            } else {
              resolve({ success: false, reason: '编辑禅道任务失败' });
            }
          } else {
            resolve({ success: true });
          }
        } catch (err) {
          console.error('[Edit Zentao Task] 请求失败:', err);
          resolve({ success: false, reason: err.message });
        }
      });
    },
    args: [taskId, execution, name, pri, username]
  });

  return results[0].result;
}

// ============================================================================
// 看板相关操作
// ============================================================================

/**
 * 创建看板卡片
 */
async function createKanbanCard(params) {
  const { baseUrl, kanbanId, regionId, groupId, columnId, taskData } = params;

  console.log('[Background] 创建看板卡片:', { kanbanId, regionId, groupId, columnId, taskData });

  // 确保禅道页面存在
  const targetTab = await ensureZentaoTab(baseUrl, kanbanId);

  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTab.id },
    func: (kanbanId, regionId, groupId, columnId, taskData) => {
      return new Promise((resolve) => {
        const endpoint = `${window.location.origin}/zentao/kanban-createCard-${kanbanId}-${regionId}-${groupId}-${columnId}.json`;

        console.log('[Background Content] 请求端点:', endpoint);

        const formData = new FormData();
        formData.append('name', taskData.title || '');
        formData.append('spec', taskData.content || taskData.title || '');
        formData.append('pri', String(taskData.pri || 3));
        formData.append('assignedTo[]', taskData.assignedTo || '');
        formData.append('deadline', taskData.dueDate || '');
        formData.append('begin', taskData.begin || '');
        formData.append('estimate', taskData.estimate || '');
        formData.append('color', taskData.color || '');

        fetch(endpoint, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
            'Origin': window.location.origin,
            'Referer': `${window.location.origin}/zentao/execution-kanban-${kanbanId}.html`,
          },
          body: formData
        })
        .then(r => {
          console.log('[Background Content] 响应状态:', r.status);
          return r.text();
        })
        .then(text => {
          console.log('[Background Content] 响应内容:', text.substring(0, 1000));
          try {
            const data = JSON.parse(text);
            console.log('[Background Content] 解析后的数据:', data);

            // data.data 可能是 JSON 字符串，需要二次解析
            let innerData = data.data;
            if (typeof innerData === 'string') {
              try {
                innerData = JSON.parse(innerData);
              } catch (e) {
                console.log('[Background Content] data.data 不是有效的 JSON');
              }
            }

            // 检查 locate 是否指向 user-deny（权限拒绝）
            if (innerData?.locate && innerData.locate.includes('user-deny')) {
              console.log('[Background Content] 权限被拒绝:', innerData.locate);
              resolve({ success: false, reason: 'permission_denied', message: '没有创建看板卡片的权限', responseData: data });
              return;
            }

            if (data.result === 'success' || data.status === 'success') {
              // 尝试多种方式获取卡片ID
              const cardId = data.id || data.card?.id || innerData?.id || innerData?.cardId || data.cardId;
              console.log('[Background Content] 提取到的卡片ID:', cardId, '来源:', {
                'data.id': data.id,
                'data.card?.id': data.card?.id,
                'innerData?.id': innerData?.id,
                'innerData?.cardId': innerData?.cardId,
                'data.cardId': data.cardId
              });
              resolve({ success: true, cardId, responseData: data });
            } else {
              console.log('[Background Content] 创建失败:', data);
              resolve({ success: false, reason: data.message || '创建失败', responseData: data });
            }
          } catch (e) {
            console.log('[Background Content] JSON解析失败:', e, '原始文本:', text);
            resolve({ success: false, reason: 'invalid_json', responseText: text.substring(0, 500) });
          }
        })
        .catch(err => {
          console.log('[Background Content] 请求异常:', err);
          resolve({ success: false, reason: err.message });
        });
      });
    },
    args: [kanbanId, regionId, groupId, columnId, taskData]
  });

  const result = results[0]?.result;
  console.log('[Background] 创建结果:', result);
  return result;
}

/**
 * 使用 task-create 接口创建看板任务
 */
async function createKanbanTask(params) {
  const { baseUrl, executionId, regionId, laneId, columnId, taskData } = params;

  console.log('[Background] 创建看板任务 (task-create):', { executionId, regionId, laneId, columnId, taskData });

  try {
    // 确保禅道页面存在
    const targetTab = await ensureZentaoTab(baseUrl, executionId);

    if (!targetTab) {
      console.error('[Background] 无法获取禅道页面');
      return { success: false, reason: 'no_zentao_tab' };
    }

    console.log('[Background] 准备执行脚本，tab ID:', targetTab.id);

    const results = await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      func: (executionId, regionId, laneId, columnId, taskData) => {
        return new Promise((resolve) => {
          try {
            // URL 格式: /zentao/task-create-{executionId}-0-0-0-0-regionID={regionId},laneID={laneId},columnID={columnId}.html?onlybody=yes
            const endpoint = `${window.location.origin}/zentao/task-create-${executionId}-0-0-0-0-regionID=${regionId},laneID=${laneId},columnID=${columnId}.html?onlybody=yes`;

            console.log('[Background Content] 请求端点:', endpoint);

        const formData = new FormData();
        formData.append('type', taskData.type || 'devel');
        formData.append('module', '0');
        formData.append('assignedTo[]', taskData.assignedTo || '');
        formData.append('teamMember', '');
        formData.append('mode', 'linear');
        formData.append('region', String(regionId));
        formData.append('lane', String(laneId));
        formData.append('status', 'wait');
        formData.append('story', '');
        formData.append('color', '');
        formData.append('name', taskData.title || '');
        formData.append('storyEstimate', '');
        formData.append('storyDesc', '');
        formData.append('storyPri', '');
        formData.append('pri', String(taskData.pri || 3));
        formData.append('estimate', '');
        formData.append('desc', taskData.content || taskData.title || '');
        formData.append('estStarted', '');
        formData.append('deadline', taskData.dueDate || '');
        formData.append('uid', Math.random().toString(36).substring(2, 14));

        // 添加空的 team 数组（5个）
        for (let i = 0; i < 5; i++) {
          formData.append('team[]', '');
          formData.append('teamSource[]', '');
          formData.append('teamEstimate[]', '');
        }

        // 打印完整的请求数据
        const requestDataLogs = {};
        for (let [key, value] of formData.entries()) {
          requestDataLogs[key] = value;
        }
        console.log('[Background Content] =================== 预备发送创建请求 ===================');
        console.log('[Background Content] 创建 URL:', endpoint);
        console.log('[Background Content] 请求体参数 (FormData):', JSON.stringify(requestDataLogs, null, 2));

        fetch(endpoint, {
          method: 'POST',
          headers: {
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'X-Requested-With': 'XMLHttpRequest',
            'Origin': window.location.origin,
            'Referer': endpoint,
          },
          body: formData
        })
        .then(r => {
          console.log('[Background Content] 响应 HTTP 状态码:', r.status);
          return r.text();
        })
        .then(async text => {
          console.log('[Background Content] =================== 完整响应文本开始 ===================');
          console.log(text);
          console.log('[Background Content] =================== 完整响应文本结束 ===================');
          try {
            const data = JSON.parse(text);
            console.log('[Background Content] 解析后的数据:', data);

            // data.data 可能是 JSON 字符串，需要二次解析
            let innerData = data.data;
            if (typeof innerData === 'string') {
              try {
                innerData = JSON.parse(innerData);
              } catch (e) {
                console.log('[Background Content] data.data 不是有效的 JSON');
              }
            }

            // 检查 locate 是否指向 user-deny（权限拒绝）
            if (innerData?.locate && innerData.locate.includes('user-deny')) {
              console.log('[Background Content] 权限被拒绝:', innerData.locate);
              resolve({ success: false, reason: 'permission_denied', message: '没有创建看板任务的权限', responseData: data });
              return;
            }

            if (data.result === 'success' || data.status === 'success') {
              console.log('[Background Content] 创建成功，开始解析任务ID');

              // 尝试多种方式获取任务ID
              let taskId = data.id || data.task?.id || innerData?.id || innerData?.taskId || data.taskId;

              console.log('[Background Content] 初步提取的 taskId:', taskId, '有 callback:', !!data.callback);

              // 检查 callback 字段 - 看板任务返回的 callback 中包含新任务 ID
              if (!taskId && data.callback) {
                console.log('[Background Content] 开始解析 callback，长度:', data.callback.length);
                try {
                  // callback 格式: parent.updateKanban({...}, 0)
                  // 需要从中解析出看板数据，然后找到新创建的任务
                  const callbackMatch = data.callback.match(/parent\.updateKanban\((.+),\s*\d+\)/);
                  console.log('[Background Content] callback 匹配结果:', callbackMatch ? '成功' : '失败');
                  if (callbackMatch) {
                    const kanbanJson = callbackMatch[1];
                    console.log('[Background Content] 提取的 JSON 长度:', kanbanJson.length);
                    const kanbanData = JSON.parse(kanbanJson);
                    console.log('[Background Content] 解析后的看板数据键:', Object.keys(kanbanData));

                    // 遍历所有区域、分组、泳道，找到所有任务
                    let allTasks = [];
                    Object.values(kanbanData).forEach(region => {
                      if (region.groups) {
                        region.groups.forEach(group => {
                          if (group.lanes) {
                            group.lanes.forEach(lane => {
                              if (lane.items) {
                                Object.values(lane.items).forEach(items => {
                                  if (Array.isArray(items)) {
                                    items.forEach(item => {
                                      if (item.id) {
                                        allTasks.push(item);
                                      }
                                    });
                                  }
                                });
                              }
                            });
                          }
                        });
                      }
                    });

                    // 按照 ID 降序排序，从后往前遍历
                    allTasks.sort((a, b) => b.id - a.id);

                    const now = Date.now();
                    const targetTitle = taskData.title;

                    // 精准匹配：name 相同，且创建时间在 5 分钟内算成功
                    let matchedTask = allTasks.find(item => {
                      if (item.name !== targetTitle) return false;
                      const timeStr = item.openedDate || item.createdDate || item.addedDate || item.date;
                      if (!timeStr) return true; // 若无时间字段，降序且名称匹配即算数
                      const taskTime = new Date(timeStr.replace(/-/g, '/')).getTime();
                      return Math.abs(now - taskTime) <= 5 * 60 * 1000;
                    });

                    if (matchedTask) {
                      taskId = String(matchedTask.id);
                      console.log('[Background Content] 从 callback 中精准匹配到任务ID:', taskId);
                    } else {
                      console.log('[Background Content] 未能通过 name 和时间精准匹配到任务 ID');
                    }
                  }
                } catch (e) {
                  console.log('[Background Content] 解析 callback 失败:', e);
                }
              }

              // 检查 locate 中的任务ID
              if (!taskId && innerData?.locate) {
                const match = innerData.locate.match(/task-view-(\d+)/);
                if (match) {
                  taskId = match[1];
                }
              }

              // 【新增兜底方案】如果依然没有在 callback 中找到任务，使用看板 API 抓取当前所有看板卡片并比对
              if (!taskId) {
                console.log('[Background Content] 🔄 触发看板终极兜底: 通过 kanban-view API 抓取所有任务...');
                try {
                  const viewUrl = `${window.location.origin}/zentao/kanban-view-${executionId}.json`;
                  const viewResp = await fetch(viewUrl, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
                  });
                  if (viewResp.ok) {
                    const text = await viewResp.text();
                    let listData = JSON.parse(text);
                    let viewData = listData.data?.data || listData.data || listData;
                    if (typeof viewData === 'string') {
                       try { viewData = JSON.parse(viewData); } catch (e) {}
                    }
                    if (viewData && typeof viewData.data === 'string') {
                       try { viewData = JSON.parse(viewData.data); } catch (e) {}
                    }
                    
                    let tasksArray = [];
                    
                    // 递归提取对象中所有的 items
                    function extractItems(obj) {
                      if (!obj || typeof obj !== 'object') return;
                      // 如果发现是 items 对象，里面包含 wait/doing/done 数组
                      if (obj.items && typeof obj.items === 'object') {
                        Object.values(obj.items).forEach(itemsList => {
                          if (Array.isArray(itemsList)) {
                            itemsList.forEach(task => tasksArray.push(task));
                          }
                        });
                      }
                      // 如果是直接包含了项的数组（通常项含有 id, name 且没有 children 等特定标志）
                      if (Array.isArray(obj)) {
                        obj.forEach(item => {
                          if (item && item.id && item.name) tasksArray.push(item);
                          else extractItems(item);
                        });
                      } else {
                        Object.values(obj).forEach(val => extractItems(val));
                      }
                    }
                    
                    extractItems(viewData);
                    
                    if (tasksArray.length > 0) {
                      tasksArray.sort((a, b) => b.id - a.id);
                      const tNow = Date.now();
                      const tTitle = taskData.title;
                      const matchedFallback = tasksArray.find(item => {
                        if (item.name !== tTitle) return false;
                        const tStr = item.openedDate || item.createdDate || item.addedDate || item.date;
                        if (!tStr) return true;
                        const ttTime = new Date(tStr.replace(/-/g, '/')).getTime();
                        return Math.abs(tNow - ttTime) <= 5 * 60 * 1000;
                      });
                      
                      if (matchedFallback) {
                        taskId = String(matchedFallback.id);
                        console.log('[Background Content] 🎉 看板兜底匹配成功，找回最新卡片ID:', taskId);
                      } else {
                        console.log('[Background Content] ⚠️ 看板兜底拉取成功但也未找到该任务，抓取总记录数:', tasksArray.length);
                      }
                    }
                  } else {
                    console.log('[Background Content] 看板兜底网络异常 HTTP:', viewResp.status);
                  }
                } catch(err) {
                  console.log('[Background Content] 看板兜底发生异常:', err);
                }
              }

              console.log('[Background Content] 最终提取到的任务ID:', taskId);
              resolve({ success: true, taskId, cardId: taskId, responseData: data });
            } else {
              console.log('[Background Content] 创建失败:', data);
              resolve({ success: false, reason: data.message || '创建失败', responseData: data });
            }
          } catch (e) {
            console.log('[Background Content] JSON解析失败:', e, '原始文本:', text);
            resolve({ success: false, reason: 'invalid_json', responseText: text.substring(0, 500) });
          }
        })
        .catch(err => {
          console.log('[Background Content] 请求异常:', err);
          resolve({ success: false, reason: err.message });
        });
      } catch (error) {
        console.error('[Background Content] 脚本执行异常:', error);
        resolve({ success: false, reason: 'script_error: ' + error.message });
      }
      });
    },
    args: [executionId, regionId, laneId, columnId, taskData]
  });

  if (!results || results.length === 0) {
    console.error('[Background] 执行脚本无结果返回');
    return { success: false, reason: 'no_script_result' };
  }

  const result = results[0]?.result;
  console.log('[Background] 创建看板任务结果:', result);

  // 如果创建成功，尝试从 callback 中解析任务 ID
  if (result && result.success && result.responseData && result.responseData.callback) {
    console.log('[Background] 开始解析 callback 获取任务 ID');
    try {
      const callback = result.responseData.callback;
      console.log('[Background] callback 前100字符:', callback.substring(0, 100));
      console.log('[Background] callback 后100字符:', callback.substring(callback.length - 100));

      // callback 格式: parent.updateKanban({...}, 0)
      // 使用更健壮的方法：找到第一个 { 和最后一个 ), 然后找到最后的数字
      const startIdx = callback.indexOf('{');
      const lastCommaIdx = callback.lastIndexOf(',');
      const endIdx = callback.lastIndexOf(')');

      if (startIdx >= 0 && lastCommaIdx > startIdx && endIdx > lastCommaIdx) {
        const kanbanJson = callback.substring(startIdx, lastCommaIdx);
        console.log('[Background] 提取的 JSON 长度:', kanbanJson.length);

        const kanbanData = JSON.parse(kanbanJson);
        console.log('[Background] kanbanData 顶层键:', Object.keys(kanbanData));

        // 遍历看板数据，获取所有任务
        // 数据结构: kanbanData["20"].groups[].lanes[].items[status][] = tasks
        let allTasks = [];
        Object.values(kanbanData).forEach(region => {
          console.log('[Background] region:', region.id, region.name, 'groups 数量:', region.groups?.length);
          if (region.groups && Array.isArray(region.groups)) {
            region.groups.forEach(group => {
              console.log('[Background]   group:', group.id, '有 lanes:', !!group.lanes, 'lanes 数量:', group.lanes?.length);
              if (group.lanes && Array.isArray(group.lanes)) {
                group.lanes.forEach(lane => {
                  console.log('[Background]     lane:', lane.id, lane.name, '有 items:', !!lane.items);
                  if (lane.items) {
                    console.log('[Background]       items 键:', Object.keys(lane.items));
                    // items 是对象，键是状态名（如 wait, closed），值是数组
                    Object.entries(lane.items).forEach(([status, items]) => {
                      console.log('[Background]         status:', status, '数组长度:', items?.length);
                      if (Array.isArray(items)) {
                        items.forEach(item => {
                          console.log('[Background]           item id:', item.id, 'name:', item.name);
                          if (item.id) {
                            allTasks.push(item);
                          }
                        });
                      }
                    });
                  }
                });
              }
            });
          }
        });

        // 按照 ID 降序排序，从后往前遍历
        allTasks.sort((a, b) => b.id - a.id);

        const now = Date.now();
        const targetTitle = taskData.title;

        // 精准匹配：name 相同，且创建时间在 5 分钟内算成功
        let matchedTask = allTasks.find(item => {
          if (item.name !== targetTitle) return false;
          const timeStr = item.openedDate || item.createdDate || item.addedDate || item.date;
          if (!timeStr) return true; // 若无时间字段，降序且名称匹配即算数
          const taskTime = new Date(timeStr.replace(/-/g, '/')).getTime();
          return Math.abs(now - taskTime) <= 5 * 60 * 1000;
        });

        if (matchedTask) {
          result.taskId = String(matchedTask.id);
          result.cardId = String(matchedTask.id);
          console.log('[Background] ✅ 从 callback 中精准匹配到任务 ID:', result.taskId);
        } else {
          console.log('[Background] ⚠️ 未能通过 name 和时间精准匹配到任务 ID');
        }
      } else {
        console.log('[Background] ❌ 无法解析 callback 格式');
      }
    } catch (e) {
      console.log('[Background] ❌ 解析 callback 异常:', e.message, e.stack);
    }
  }

  return result || { success: false, reason: 'null_result' };
  } catch (error) {
    console.error('[Background] createKanbanTask 异常:', error);
    return { success: false, reason: 'exception: ' + error.message };
  }
}

/**
 * 更新看板卡片状态
 */
async function updateKanbanCardStatus(params) {
  const { baseUrl, cardId, kanbanId, status } = params;

  console.log('[Background] 更新看板卡片状态:', { cardId, kanbanId, status });

  // 确保使用正确的看板页面（匹配 kanbanId）
  const targetTab = await ensureZentaoTab(baseUrl, kanbanId);

  if (!targetTab) {
    console.error('[Background] 无法获取禅道页面');
    return { success: false, reason: 'no_zentao_tab' };
  }

  console.log('[Background] 使用禅道页面:', targetTab.url);

  // 根据状态选择API端点（在 content script 中使用 window.location.origin）
  let apiPath;
  if (status === 'done') {
    apiPath = `/zentao/kanban-finishCard-${cardId}-${kanbanId}.json`;
  } else if (status === 'in_progress') {
    apiPath = `/zentao/kanban-activateCard-${cardId}-${kanbanId}.json`;
  } else {
    // 对于其他状态，可能需要移动卡片
    apiPath = `/zentao/kanban-activateCard-${cardId}-${kanbanId}.json`;
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTab.id },
    func: (apiPath) => {
      return new Promise((resolve) => {
        const endpoint = `${window.location.origin}${apiPath}`;
        // 添加详细日志，包括当前页面URL
        console.log('[Background Content] ===== 更新看板卡片状态 =====');
        console.log('[Background Content] 当前页面 URL:', window.location.href);
        console.log('[Background Content] 请求 endpoint:', endpoint);
        console.log('[Background Content] apiPath:', apiPath);
        fetch(endpoint, {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
          }
        })
        .then(r => {
          console.log('[Background Content] 响应状态:', r.status);
          return r.json();
        })
        .then(data => {
          console.log('[Background Content] 响应数据:', data);
          if (data.result === 'success' || data.status === 'success') {
            console.log('[Background Content] ✓ 更新成功');
            resolve({ success: true });
          } else {
            console.log('[Background Content] ✗ 更新失败:', data);
            resolve({ success: false, reason: data.message || data.result || '更新失败' });
          }
        })
        .catch(err => {
          console.log('[Background Content] ✗ 请求异常:', err.message);
          resolve({ success: false, reason: err.message });
        });
      });
    },
    args: [apiPath]
  });

  return results[0].result;
}

/**
 * 快速检测执行是否为看板类型
 * 通过尝试获取看板视图来判断
 */
async function quickCheckKanban(params) {
  const { baseUrl, executionId } = params;
  console.log('[Background] 快速检测看板类型:', executionId);

  try {
    // 确保禅道页面存在
    const targetTab = await ensureZentaoTab(baseUrl, executionId);

    const results = await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      func: (executionId) => {
        return new Promise((resolve) => {
          // 尝试请求看板视图JSON接口
          const jsonUrl = `${window.location.origin}/zentao/kanban-view-${executionId}.json`;
          console.log('[Background Content] 检测看板:', jsonUrl);

          fetch(jsonUrl, {
            method: 'GET',
            headers: {
              'Accept': 'application/json',
            }
          })
          .then(r => {
            console.log('[Background Content] 响应状态:', r.status);
            return r.text();
          })
          .then(text => {
            console.log('[Background Content] 看板检测响应前200字符:', text.substring(0, 200));

            // 尝试解析JSON
            try {
              const data = JSON.parse(text);
              console.log('[Background Content] 解析后的JSON顶层键:', Object.keys(data));
              console.log('[Background Content] data.data类型:', typeof data.data);

              // 检查是否被拒绝访问（user-deny表示不是看板类型或权限不足）
              if (data.data && typeof data.data === 'string') {
                try {
                  const innerData = JSON.parse(data.data);
                  console.log('[Background Content] innerData键:', Object.keys(innerData));
                  if (innerData.locate && innerData.locate.includes('user-deny')) {
                    console.log('[Background Content] 返回user-deny，不是看板类型');
                    resolve({ isKanban: false, reason: 'not_kanban' });
                    return;
                  }
                  // 检查innerData中是否有regions
                  if (innerData.regions && Array.isArray(innerData.regions) && innerData.regions.length > 0) {
                    console.log('[Background Content] 在innerData中检测到regions');
                    resolve({ isKanban: true });
                    return;
                  }
                } catch (e) {
                  console.log('[Background Content] 解析innerData失败:', e.message);
                }
              }

              // 检查是否有regions数组（看板的特征）
              if (data.data && typeof data.data === 'object') {
                console.log('[Background Content] data.data是对象，键:', Object.keys(data.data));

                // 情况1: data.data.data 是JSON字符串
                if (data.data.data && typeof data.data.data === 'string') {
                  try {
                    const kanbanData = JSON.parse(data.data.data);
                    console.log('[Background Content] 解析data.data.data成功，键:', Object.keys(kanbanData));
                    if (kanbanData.regions && Array.isArray(kanbanData.regions) && kanbanData.regions.length > 0) {
                      console.log('[Background Content] 检测到看板结构(data.data.data解析后)');
                      resolve({ isKanban: true });
                      return;
                    }
                  } catch (e) {
                    console.log('[Background Content] 解析data.data.data失败:', e.message);
                  }
                }

                // 情况2: data.data 本身有regions
                if (data.data.regions && Array.isArray(data.data.regions) && data.data.regions.length > 0) {
                  console.log('[Background Content] 检测到看板结构(data.data.regions)');
                  resolve({ isKanban: true });
                  return;
                }

                // 情况3: 检查data.data的data属性（对象形式）
                if (data.data.data && typeof data.data.data === 'object') {
                  const kanbanData = data.data.data;
                  console.log('[Background Content] data.data.data是对象，键:', Object.keys(kanbanData));
                  if (kanbanData.regions && Array.isArray(kanbanData.regions) && kanbanData.regions.length > 0) {
                    console.log('[Background Content] 检测到看板结构(data.data.data对象)');
                    resolve({ isKanban: true });
                    return;
                  }
                }
              }

              // 其他情况：可能是普通的阶段/迭代
              console.log('[Background Content] 未检测到看板结构');
              resolve({ isKanban: false, reason: 'no_regions' });
            } catch (e) {
              // JSON解析失败，可能不是有效的看板响应
              console.log('[Background Content] JSON解析失败:', e.message);
              resolve({ isKanban: false, reason: 'parse_error' });
            }
          })
          .catch(err => {
            console.log('[Background Content] 请求失败:', err.message);
            // 请求失败也可能是网络问题，保守判断为不是看板
            resolve({ isKanban: false, reason: 'request_failed' });
          });
        });
      },
      args: [executionId]
    });

    return results[0]?.result || { isKanban: false, reason: 'no_result' };
  } catch (err) {
    console.log('[Background] 快速检测看板异常:', err.message);
    return { isKanban: false, reason: err.message };
  }
}

/**
 * 获取看板视图
 */
async function getKanbanView(params) {
  const { baseUrl, kanbanId } = params;

  console.log('[Background] 获取看板视图:', kanbanId);

  // 确保禅道页面存在
  const targetTab = await ensureZentaoTab(baseUrl, kanbanId);

  if (!targetTab) {
    console.error('[Background] 无法获取禅道页面，请确保已打开禅道');
    return { success: false, reason: 'no_zentao_tab' };
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTab.id },
    func: (kanbanId) => {
      return new Promise((resolve) => {
        // 尝试先获取HTML页面
        const htmlUrl = `${window.location.origin}/zentao/kanban-view-${kanbanId}.html`;

        console.log('[Background Content] 请求看板HTML页面:', htmlUrl);

        fetch(htmlUrl, {
          method: 'GET',
          headers: {
            'Accept': 'text/html',
            'X-Requested-With': 'XMLHttpRequest'
          }
        })
        .then(r => r.text())
        .then(html => {
          console.log('[Background Content] 看板HTML页面长度:', html.length);

          // 尝试从HTML中提取看板数据
          // 看板数据通常在 window.kanban 或类似的变量中
          // 或者页面中有 data 属性包含 JSON 数据

          // 查找页面中的 script 标签中的数据
          const dataMatch = html.match(/var kanban\s*=\s*(\{[\s\S]*?\});/);
          if (dataMatch) {
            try {
              const kanbanData = eval('(' + dataMatch[1] + ')');
              console.log('[Background Content] 从页面提取到看板数据:', kanbanData);
              resolve({ success: true, data: kanbanData });
              return;
            } catch (e) {
              console.log('[Background Content] 解析页面数据失败:', e);
            }
          }

          // 如果无法从HTML提取，尝试JSON接口
          const jsonUrl = `${window.location.origin}/zentao/kanban-view-${kanbanId}.json`;
          console.log('[Background Content] 尝试JSON接口:', jsonUrl);

          return fetch(jsonUrl, {
            method: 'GET',
            headers: {
              'Accept': 'application/json',
              'X-Requested-With': 'XMLHttpRequest'
            }
          })
          .then(r => {
            console.log('[Background Content] JSON接口响应状态:', r.status);
            return r.json();
          })
          .then(data => {
            console.log('[Background Content] JSON接口返回:', data);
            console.log('[Background Content] 当前页面URL:', window.location.href);
            resolve({ success: true, data: data });
          })
          .catch(err => {
            console.log('[Background Content] JSON接口失败:', err);
            resolve({ success: false, reason: err.message });
          });
        })
        .catch(err => {
          console.log('[Background Content] 请求失败:', err);
          resolve({ success: false, reason: err.message });
        });
      });
    },
    args: [kanbanId]
  });

  return results[0].result;
}

// ============================================================================
// Bug 操作相关方法
// ============================================================================

/**
 * 激活 Bug
 */
async function activateBugInZentao(params) {
  const { baseUrl, bugId, assignedTo, pri, type, ccList, comment } = params;
  console.log('[Background] ========== 激活 Bug 开始 ==========');
  console.log('[Background] 参数:', { baseUrl, bugId, assignedTo, pri, type, ccList, comment });

  // 使用普通禅道页面（不需要看板）
  const targetTab = await ensureZentaoTab(baseUrl);

  if (!targetTab) {
    console.error('[Background] 未找到禅道标签页');
    return { success: false, reason: 'no_zentao_tab' };
  }

  console.log('[Background] 使用标签页:', targetTab.id, targetTab.url);

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: targetTab.id },
      func: (bugId, assignedTo, pri, type, ccList, comment) => {
        console.log('[Bug Activate] 注入脚本开始执行，当前页面:', window.location.href);
        return new Promise((resolve) => {
          const formData = new URLSearchParams();
          formData.append('assignedTo', assignedTo || '');
          formData.append('type', type || 'codeerror');
          formData.append('pri', pri || '3');
          formData.append('status', 'active');
          if (assignedTo) formData.append('mailto[]', assignedTo);
          // 添加抄送人
          if (ccList && Array.isArray(ccList)) {
            ccList.forEach(cc => {
              if (cc) formData.append('mailto[]', cc);
            });
          }
          formData.append('comment', comment || '');
          formData.append('uid', Math.random().toString(36).substring(2, 14));

          const endpoint = `${window.location.origin}/zentao/bug-confirmbug-${bugId}.html?onlybody=yes`;
          console.log('[Bug Activate] 请求端点:', endpoint);
          console.log('[Bug Activate] 表单数据:', formData.toString());
          console.log('[Bug Activate] 完整参数:', { bugId, assignedTo, pri, type, ccList, comment, status: 'active' });

          fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'X-Requested-With': 'XMLHttpRequest'
            },
            body: formData.toString()
          })
          .then(r => {
            console.log('[Bug Activate] 响应状态:', r.status, r.statusText);
            // 只检查HTTP状态码，2xx都认为成功
            if (r.ok || (r.status >= 200 && r.status < 300)) {
              console.log('[Bug Activate] ✓ 激活成功（HTTP状态码正常）');
              resolve({ success: true });
            } else {
              console.error('[Bug Activate] ✗ 激活失败（HTTP状态码异常）');
              resolve({ success: false, reason: 'http_error', status: r.status });
            }
          })
          .catch(err => {
            console.error('[Bug Activate] ✗ 请求失败:', err);
            resolve({ success: false, reason: err.message });
          });
        });
      },
      args: [bugId, assignedTo, pri, type, ccList, comment]
    });

    console.log('[Background] executeScript 结果:', results);

    if (results && results.length > 0) {
      const result = results[0].result;
      console.log('[Background] 激活结果:', result);
      console.log('[Background] ========== 激活 Bug 结束 ==========');
      return result;
    } else {
      console.error('[Background] executeScript 返回结果为空');
      return { success: false, reason: 'no_result' };
    }
  } catch (error) {
    console.error('[Background] 激活 Bug 异常:', error);
    return { success: false, reason: error.message };
  }
}

// 确保指定的 URL 标签页存在
async function ensureZentaoTabByUrl(baseUrl, targetUrl) {
  console.log('[Background] ensureZentaoTabByUrl 调用:', { baseUrl, targetUrl });

  // 使用 ZentaoTabManager 统一管理标签页
  try {
    return await ZentaoTabManager.getOrCreateTab({
      baseUrl,
      targetUrl,
      active: false,
      reload: false
    });
  } catch (error) {
    console.error('[Background] 获取或创建标签页失败:', error);
    return null;
  }
}

/**
 * 修复 Bug
 */
async function resolveBugInZentao(params) {
  const { baseUrl, kanbanUrl, bugId, resolution, assignedTo, comment } = params;
  console.log('[Background] 修复 Bug:', { bugId, resolution, assignedTo });

  const targetTab = await ensureZentaoTab(baseUrl);
  if (!targetTab) {
    return { success: false, reason: 'no_zentao_tab' };
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTab.id },
    func: (bugId, resolution, assignedTo, comment) => {
      return new Promise((resolve) => {
        const formData = new FormData();
        formData.append('resolution', resolution);
        formData.append('duplicateBug', '0');
        formData.append('buildExecution', '');
        formData.append('resolvedBuild', 'trunk');
        formData.append('resolvedDate', '');
        if (assignedTo) formData.append('assignedTo', assignedTo);
        formData.append('status', 'resolved');
        formData.append('comment', comment || '');
        formData.append('uid', Math.random().toString(36).substring(2, 14));

        const endpoint = `${window.location.origin}/zentao/bug-resolve-${bugId}.html?onlybody=yes`;
        fetch(endpoint, {
          method: 'POST',
          headers: {
            'X-Requested-With': 'XMLHttpRequest'
          },
          body: formData
        })
        .then(r => {
          console.log('[Bug Resolve] 响应状态:', r.status, r.statusText);
          // 只检查HTTP状态码，2xx都认为成功
          if (r.ok || (r.status >= 200 && r.status < 300)) {
            console.log('[Bug Resolve] ✓ 修复成功（HTTP状态码正常）');
            resolve({ success: true });
          } else {
            console.error('[Bug Resolve] ✗ 修复失败（HTTP状态码异常）');
            resolve({ success: false, reason: 'http_error', status: r.status });
          }
        })
        .catch(err => resolve({ success: false, reason: err.message }));
      });
    },
    args: [bugId, resolution, assignedTo, comment]
  });

  return results[0].result;
}

/**
 * 删除 Bug
 */
async function deleteBugInZentao(params) {
  const { baseUrl, bugId } = params;
  console.log('[Background] 删除 Bug:', { bugId });

  const targetTab = await ensureZentaoTab(baseUrl);
  if (!targetTab) {
    return { success: false, reason: 'no_zentao_tab' };
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTab.id },
    func: (bugId) => {
      return new Promise((resolve) => {
        const endpoint = `${window.location.origin}/zentao/bug-delete-${bugId}.html`;
        fetch(endpoint, {
          method: 'POST',
          headers: {
            'X-Requested-With': 'XMLHttpRequest'
          }
        })
        .then(r => r.json())
        .then(data => {
          console.log('[Bug Delete] 响应:', data);
          // 检查返回的数据中 items 是否为空或删除成功
          resolve({ success: true, data });
        })
        .catch(err => resolve({ success: false, reason: err.message }));
      });
    },
    args: [bugId]
  });

  return results[0].result;
}

/**
 * 关闭 Bug
 */
async function closeBugInZentao(params) {
  const { baseUrl, bugId, comment } = params;
  console.log('[Background] 关闭 Bug:', { bugId, comment });

  const targetTab = await ensureZentaoTab(baseUrl);
  if (!targetTab) {
    return { success: false, reason: 'no_zentao_tab' };
  }

  console.log('[Background] 开始注入脚本到禅道标签页...');

  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTab.id },
    func: (bugId, comment) => {
      return new Promise((resolve) => {
        console.log('[Bug Close] 开始关闭 Bug:', bugId);
        const formData = new FormData();
        formData.append('status', 'closed');
        formData.append('comment', comment || '');
        formData.append('uid', Math.random().toString(36).substring(2, 14));

        const endpoint = `${window.location.origin}/zentao/bug-close-${bugId}.html?onlybody=yes`;
        console.log('[Bug Close] 请求端点:', endpoint);

        fetch(endpoint, {
          method: 'POST',
          headers: {
            'X-Requested-With': 'XMLHttpRequest'
          },
          body: formData
        })
        .then(r => {
          console.log('[Bug Close] 响应状态:', r.status, r.statusText);
          // 只检查HTTP状态码，2xx都认为成功
          if (r.ok || (r.status >= 200 && r.status < 300)) {
            console.log('[Bug Close] ✓ 关闭成功（HTTP状态码正常）');
            resolve({ success: true });
          } else {
            console.error('[Bug Close] ✗ 关闭失败（HTTP状态码异常）');
            resolve({ success: false, reason: 'http_error', status: r.status });
          }
        })
        .catch(err => {
          console.error('[Bug Close] ✗ 请求失败:', err);
          resolve({ success: false, reason: err.message });
        });
      });
    },
    args: [bugId, comment]
  });

  console.log('[Background] 脚本注入完成，结果:', results[0].result);
  return results[0].result;
}

// 在消息监听器中添加对应的 action 处理
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'checkAndSyncZentao') {
    checkAndSyncZentao(request.force)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, reason: err.message }));
    return true;
  }

  if (request.action === 'activateBugInZentao') {
    activateBugInZentao(request)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, reason: err.message }));
    return true;
  }

  if (request.action === 'resolveBugInZentao') {
    resolveBugInZentao(request)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, reason: err.message }));
    return true;
  }

  if (request.action === 'closeBugInZentao') {
    closeBugInZentao(request)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, reason: err.message }));
    return true;
  }

  if (request.action === 'deleteBugInZentao') {
    deleteBugInZentao(request)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, reason: err.message }));
    return true;
  }

  if (request.action === 'getLastSyncTime') {
    getLastSyncTime().then(sendResponse);
    return true;
  }

  if (request.action === 'manualSyncFromZentao') {
    checkAndSyncZentao(true)  // 强制同步
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, reason: err.message }));
    return true;
  }
});

/**
 * 发送进度更新到 newtab 页面
 * @param {number} currentStep - 当前步骤
 * @param {number} totalSteps - 总步骤数
 * @param {string} message - 进度消息
 */
function sendProgressUpdate(currentStep, totalSteps, message) {
  console.log(`[Background] 发送进度更新: ${currentStep}/${totalSteps} - ${message}`);

  // 查找所有标签页，找到扩展的 newtab 页面
  chrome.tabs.query({}).then(tabs => {
    // 扩展页面的 URL 可能是：
    // - chrome-extension://<id>/newtab.html
    // - moz-extension://<id>/newtab.html (Firefox)
    const newtabTabs = tabs.filter(tab => {
      if (!tab.url) return false;
      // 匹配扩展页面的 URL 格式
      return tab.url.includes('newtab.html') ||
             tab.url.includes('/newtab') ||
             tab.url.match(/chrome-extension:\/\/[^\/]+\/newtab/) ||
             tab.url.match(/moz-extension:\/\/[^\/]+\/newtab/);
    });

    if (newtabTabs.length > 0) {
      console.log(`[Background] 找到 ${newtabTabs.length} 个 newtab 标签页:`, newtabTabs.map(t => t.url));

      newtabTabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, {
          action: 'updateProgress',
          currentStep,
          totalSteps,
          message
        }).catch(err => {
          // 忽略错误，可能标签页未准备好
          console.log('[Background] 发送到标签页失败:', tab.id, err.message);
        });
      });
    } else {
      console.log('[Background] 未找到 newtab 标签页，跳过进度更新');
      console.log('[Background] 当前所有标签页 URL:', tabs.map(t => `${t.id}: ${t.url}`));
    }
  });
}

/**
 * 从禅道同步数据到本地（后台任务）
 * 正确流程：使用同一个标签页依次访问页面获取数据
 * @param {Object} config - 禅道配置（可选，如果不提供则自动获取）
 */
async function syncFromZentaoInBackground(config) {
  let zentaoTab = null;

  try {
    console.log('[Background] ========== 开始从禅道同步数据 ==========');

    // 如果没有提供配置，则获取配置
    if (!config) {
      config = await fetchConfig();
    }

    if (!config.zentao?.enabled) {
      console.log('[Background] 禅道未启用，取消同步');
      return { success: false, reason: 'zentao_not_enabled' };
    }

    const zentaoConfig = config.zentao;
    const baseUrl = zentaoConfig.url;

    console.log('[Background] 禅道配置:', { baseUrl });

    // 1. 先登录禅道获取 cookie
    console.log('[Background] ========== 步骤1: 登录禅道 ==========');
    sendProgressUpdate(1, 7, '正在登录禅道...');
    const loginResult = await fetch(`${API_BASE_URL}/api/zentao/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    }).then(r => r.json());

    if (!loginResult.success) {
      throw new Error(loginResult.message || '登录禅道失败');
    }

    const cookies = loginResult.data;
    const cookieString = Object.entries(cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');

    console.log('[Background] ✓ 登录成功');

    // 2. 使用 ZentaoTabManager 获取或创建禅道标签页
    console.log('[Background] ========== 步骤2: 获取禅道标签页 ==========');
    sendProgressUpdate(2, 7, '正在获取禅道标签页...');
    const myUrl = `${baseUrl}/zentao/my.html`;
    zentaoTab = await ZentaoTabManager.getOrCreateTab({
      baseUrl,
      targetUrl: myUrl,
      active: false,
      reload: false
    });

    console.log('[Background] ✓ 禪道标签页已就绪:', zentaoTab.id, zentaoTab.url);

    // 等待页面加载完成
    await waitForTabLoad(zentaoTab.id);
    console.log('[Background] ✓ 页面加载完成');

    // 额外等待确保JavaScript执行完成（从2秒减少到500ms）
    await new Promise(resolve => setTimeout(resolve, 500));

    // 3. 从我的地盘页面获取任务和Bug数量
    console.log('[Background] ========== 步骤3: 获取任务和Bug数量 ==========');
    sendProgressUpdate(3, 7, '正在获取任务和Bug数量...');
    const countResults = await chrome.scripting.executeScript({
      target: { tabId: zentaoTab.id },
      func: () => {
        // 查找 iframe
        const iframe = document.querySelector('#appIframe-my');
        if (!iframe) {
          console.log('[Content] 未找到 iframe');
          return { taskCount: 0, bugCount: 0 };
        }

        // 从 iframe 内容中提取
        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
        if (!iframeDoc) {
          console.log('[Content] 无法访问 iframe document');
          return { taskCount: 0, bugCount: 0 };
        }

        // 查找任务数量 - 尝试多种选择器
        let taskCount = 0;
        const taskLink1 = iframeDoc.querySelector('a[href="/zentao/my-work-task.html"]');
        const taskLink2 = iframeDoc.querySelector('a[href*="my-work-task"]');
        const taskLink3 = iframeDoc.querySelector('.text-primary[href*="task"]');
        // 新增：尝试查找所有包含"task"的链接，且文本是数字
        const allTaskLinks = Array.from(iframeDoc.querySelectorAll('a[href*="task"], a[href*="Task"]'));
        const taskLinkWithNumber = allTaskLinks.find(link => {
          const text = link.textContent.trim();
          return !isNaN(text) && parseInt(text) > 0;
        });

        console.log('[Content] 任务链接选择器测试:');
        console.log('  - a[href="/zentao/my-work-task.html"]:', taskLink1);
        console.log('  - a[href*="my-work-task"]:', taskLink2);
        console.log('  - .text-primary[href*="task"]:', taskLink3);
        console.log('  - 包含数字的task链接:', taskLinkWithNumber);

        if (taskLink1) {
          taskCount = parseInt(taskLink1.textContent) || 0;
        } else if (taskLink2) {
          taskCount = parseInt(taskLink2.textContent) || 0;
        } else if (taskLink3) {
          taskCount = parseInt(taskLink3.textContent) || 0;
        } else if (taskLinkWithNumber) {
          taskCount = parseInt(taskLinkWithNumber.textContent) || 0;
        }

        // 查找Bug数量 - 尝试多种选择器
        let bugCount = 0;
        const bugLink1 = iframeDoc.querySelector('a[href="/zentao/my-work-bug.html"]');
        const bugLink2 = iframeDoc.querySelector('a[href*="my-work-bug"]');
        const bugLink3 = iframeDoc.querySelector('.text-primary[href*="bug"]');

        console.log('[Content] Bug链接选择器测试:');
        console.log('  - a[href="/zentao/my-work-bug.html"]:', bugLink1);
        console.log('  - a[href*="my-work-bug"]:', bugLink2);
        console.log('  - .text-primary[href*="bug"]:', bugLink3);

        if (bugLink1) {
          bugCount = parseInt(bugLink1.textContent) || 0;
        } else if (bugLink2) {
          bugCount = parseInt(bugLink2.textContent) || 0;
        } else if (bugLink3) {
          bugCount = parseInt(bugLink3.textContent) || 0;
        }

        // 如果还是找不到，尝试查找所有带数字的链接
        if (taskCount === 0 || bugCount === 0) {
          console.log('[Content] 使用通用方法查找所有带数字的链接:');
          const allLinks = Array.from(iframeDoc.querySelectorAll('a'));
          const numericLinks = allLinks.filter(link => {
            const text = link.textContent.trim();
            return text && !isNaN(text) && parseInt(text) > 0;
          });

          console.log('[Content] 找到', numericLinks.length, '个带数字的链接:');
          numericLinks.forEach(link => {
            const text = link.textContent.trim();
            const href = link.getAttribute('href');
            const className = link.className;
            console.log(`  - href="${href}" class="${className}" text="${text}"`);

            // 根据href或class判断是任务还是bug
            if (taskCount === 0 && (href?.includes('task') || href?.includes('Task'))) {
              taskCount = parseInt(text);
              console.log('    → 识别为任务链接');
            } else if (bugCount === 0 && (href?.includes('bug') || href?.includes('Bug'))) {
              bugCount = parseInt(text);
              console.log('    → 识别为Bug链接');
            }
          });
        }

        console.log('[Content] 最终结果 - 任务:', taskCount, 'Bug:', bugCount);

        return { taskCount, bugCount };
      }
    });

    const { taskCount, bugCount } = countResults[0]?.result || { taskCount: 0, bugCount: 0 };
    console.log('[Background] ✓ 禅道数据统计 - 任务:', taskCount, 'Bug:', bugCount);

    // 4. 跳转到任务列表页面并获取数据
    console.log('[Background] ========== 步骤4: 获取任务列表 ==========');
    sendProgressUpdate(4, 7, '正在获取任务列表...');
    let zentaoTasks = [];

    if (taskCount > 0) {
      const taskUrl = `${baseUrl}/zentao/my-work-task-assignedTo-myQueryID-status_asc-${taskCount}-500-1.html`;
      console.log('[Background] 导航到任务列表:', taskUrl);

      await chrome.tabs.update(zentaoTab.id, { url: taskUrl });
      await waitForTabLoad(zentaoTab.id);

      // 使用轮询检测任务列表是否加载完成，而不是固定等待5秒
      const maxRetries = 10;  // 最多重试10次
      const retryDelay = 500;  // 每次等待500ms
      let taskResults = null;

      for (let i = 0; i < maxRetries; i++) {
        console.log(`[Background] 尝试获取任务列表 (${i + 1}/${maxRetries})...`);

        const tempResults = await chrome.scripting.executeScript({
          target: { tabId: zentaoTab.id },
          func: () => {
          const tasks = [];

          // 首先尝试直接查找 #myTaskList
          let tbody = document.querySelector('#myTaskList');

          // 如果没找到，尝试在 iframe 中查找
          if (!tbody) {
            const iframe = document.querySelector('#appIframe-my');
            if (iframe) {
              console.log('[Content] 在iframe中查找 #myTaskList');
              const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
              if (iframeDoc) {
                tbody = iframeDoc.querySelector('#myTaskList');
              }
            }
          }

          if (!tbody) {
            console.log('[Content] 未找到 #myTaskList（主页面和iframe都没找到）');
            return { tasks, tbodyFound: false };
          }

          const rows = tbody.querySelectorAll('tr[data-status="wait"], tr[data-status="doing"]');
          console.log('[Content] 找到任务行数:', rows.length);

          // 如果没找到，尝试查看所有行的状态
          if (rows.length === 0) {
            console.log('[Content] 未找到wait或doing状态的任务，检查所有行:');
            const allRows = tbody.querySelectorAll('tr');
            console.log('[Content] 总行数:', allRows.length);

            // 列出前10行的状态
            Array.from(allRows).slice(0, 10).forEach((row, i) => {
              console.log(`[Content] 行${i}: data-status="${row.dataset.status}", data-id="${row.dataset.id}"`);
            });
          }

          rows.forEach(row => {
            try {
              const taskId = row.dataset.id;
              const status = row.dataset.status;
              const estimate = row.dataset.estimate || '0';
              const consumed = row.dataset.consumed || '0';

              const titleLink = row.querySelector('.c-name a');
              const title = titleLink?.textContent?.trim() || '';

              const priSpan = row.querySelector('.c-pri .label-pri');
              const priority = priSpan ? parseInt(priSpan.textContent) : 3;

              // 获取项目和执行信息
              // 任务列表有 TWO 个 .c-project 列：第1个是项目，第2个是执行
              let projectName = '';
              let projectId = null;
              let executionName = '';
              let executionId = null;

              // 获取所有 .c-project 单元格
              const projectCells = row.querySelectorAll('.c-project');
              console.log(`[Content] 任务${taskId} 找到 ${projectCells.length} 个 .c-project 单元格`);

              if (projectCells.length >= 1) {
                // 第1个 .c-project 是所属项目
                const projectCell = projectCells[0];
                const projectLink = projectCell.querySelector('a');
                if (projectLink) {
                  projectName = projectLink.textContent?.trim() || projectLink.getAttribute('title') || '';
                  const projectHref = projectLink.getAttribute('href') || '';
                  const projectIdMatch = projectHref.match(/project-index-(\d+)\.html/);
                  if (projectIdMatch) {
                    projectId = parseInt(projectIdMatch[1]);
                  }
                  console.log(`[Content]   项目: "${projectName}" (${projectId})`);
                }
              }

              if (projectCells.length >= 2) {
                // 第2个 .c-project 是所属执行
                const executionCell = projectCells[1];
                const executionLink = executionCell.querySelector('a');
                if (executionLink) {
                  executionName = executionLink.textContent?.trim() || executionLink.getAttribute('title') || '';
                  const executionHref = executionLink.getAttribute('href') || '';
                  const executionIdMatch = executionHref.match(/execution-task-(\d+)\.html/);
                  if (executionIdMatch) {
                    executionId = parseInt(executionIdMatch[1]);
                  }
                  console.log(`[Content]   执行: "${executionName}" (${executionId})`);
                }
              }

              console.log(`[Content] 任务${taskId} - 项目: "${projectName}"(${projectId}), 执行: "${executionName}"(${executionId})`);

              const openedBy = row.querySelector('.c-user')?.textContent?.trim() || '';

              // 从 data 属性获取预计工时
              const estimateNum = parseFloat(estimate) || 0;

              // 从 .c-hours 单元格获取消耗工时和剩余工时
              // 第2个 c-hours（索引1）是消耗工时，第3个（索引2）是剩余工时
              const hoursCells = row.querySelectorAll('.c-hours');
              let consumedNum = parseFloat(consumed) || 0;  // 默认使用 data-consumed
              let leftNum = 0;

              if (hoursCells.length >= 3) {
                // 尝试从单元格提取工时数据
                const consumedText = hoursCells[1]?.textContent?.trim() || '';  // 第2个：消耗工时
                const leftText = hoursCells[2]?.textContent?.trim() || '';      // 第3个：剩余工时

                // 移除 'h' 后缀并转换为数字
                consumedNum = parseFloat(consumedText.replace('h', '')) || consumedNum;
                leftNum = parseFloat(leftText.replace('h', '')) || 0;

                console.log(`[Content] 任务${taskId} - 预计:${estimate}h, 消耗:${consumedNum}h, 剩余:${leftNum}h`);
              } else {
                console.log(`[Content] 任务${taskId} - 未找到足够的工时单元格，使用data属性`);
                // 如果没有找到单元格，尝试使用 data-left
                leftNum = parseFloat(row.dataset.left) || 0;
              }

              // 计算进度：消耗工时 / (消耗工时 + 剩余工时) * 100%
              const totalHours = consumedNum + leftNum;
              const progress = totalHours > 0 ? Math.round((consumedNum / totalHours) * 100) : 0;

              tasks.push({
                zentaoId: parseInt(taskId),
                title,
                status: status === 'wait' ? 'todo' : 'in_progress',
                priority,
                projectId,
                projectName,
                executionId,
                executionName,
                openedBy,
                estimate: estimateNum,
                consumed: consumedNum,
                left: leftNum,
                progress
              });
            } catch (err) {
              console.error('[Content] 解析任务失败:', err);
            }
          });

          return { tasks, tbodyFound: true };
        }
      });

      const result = tempResults[0]?.result;
      if (result && result.tbodyFound) {
        // tbody 找到了，即使任务为空也认为成功
        taskResults = tempResults;
        zentaoTasks = result.tasks || [];
        console.log('[Background] ✓ 找到任务列表，解析到', zentaoTasks.length, '个任务');
        break;  // 成功获取，退出循环
      } else {
        console.log('[Background] 任务列表尚未加载，等待', retryDelay, 'ms后重试...');
        if (i < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    }

    if (!taskResults) {
      console.log('[Background] 警告: 未能找到任务列表，可能页面加载异常');
      zentaoTasks = [];
    }

    console.log('[Background] ✓ 解析到', zentaoTasks.length, '个任务');
      if (zentaoTasks.length > 0) {
        console.log('[Background] 任务数据示例:', JSON.stringify(zentaoTasks[0], null, 2));
      }
    } else {
      console.log('[Background] 任务数量为0，跳过任务列表');
    }

    // 5. 跳转到Bug列表页面并获取数据
    console.log('[Background] ========== 步骤5: 获取Bug列表 ==========');
    sendProgressUpdate(5, 7, '正在获取Bug列表...');
    let zentaoBugs = [];

    if (bugCount > 0) {
      const bugUrl = `${baseUrl}/zentao/my-work-bug-assignedTo-0-id_desc-${bugCount}-500-1.html`;
      console.log('[Background] 导航到Bug列表:', bugUrl);

      await chrome.tabs.update(zentaoTab.id, { url: bugUrl });
      await waitForTabLoad(zentaoTab.id);

      // 使用轮询检测Bug列表是否加载完成，而不是固定等待5秒
      const maxRetries = 10;  // 最多重试10次
      const retryDelay = 500;  // 每次等待500ms
      let bugResults = null;

      for (let i = 0; i < maxRetries; i++) {
        console.log(`[Background] 尝试获取Bug列表 (${i + 1}/${maxRetries})...`);

        const tempResults = await chrome.scripting.executeScript({
          target: { tabId: zentaoTab.id },
          func: () => {
          const bugs = [];

          // 首先尝试直接查找 #bugList
          let table = document.querySelector('#bugList');

          // 如果没找到，尝试在 iframe 中查找
          if (!table) {
            const iframe = document.querySelector('#appIframe-my');
            if (iframe) {
              console.log('[Content] 在iframe中查找 #bugList');
              const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
              if (iframeDoc) {
                table = iframeDoc.querySelector('#bugList');
              }
            }
          }

          if (!table) {
            console.log('[Content] 未找到 #bugList（主页面和iframe都没找到）');
            console.log('[Content] 主页面表格数:', document.querySelectorAll('table').length);
            return { bugs, tableFound: false };
          }

          const tbody = table.querySelector('tbody');
          if (!tbody) {
            console.log('[Content] 未找到 tbody');
            return { bugs, tableFound: false };
          }

          const rows = tbody.querySelectorAll('tr');
          console.log('[Content] 找到Bug行数:', rows.length);

          rows.forEach(row => {
            try {
              const idInput = row.querySelector('input[name="bugIDList[]"]');
              if (!idInput) return;

              const zentaoId = parseInt(idInput.value);

              const titleLink = row.querySelector('.c-id + td.text-left a, td.text-left.nobr a');
              const title = titleLink?.getAttribute('title') || titleLink?.textContent?.trim() || '';

              const severitySpan = row.querySelector('.c-severity .label-severity');
              const severity = severitySpan ? parseInt(severitySpan.getAttribute('data-severity')) : 3;

              const priSpan = row.querySelector('.c-pri .label-pri');
              const priority = priSpan ? parseInt(priSpan.getAttribute('title')) : 3;

              const typeCell = row.querySelector('.c-type');
              const bugType = typeCell?.textContent?.trim() || 'codeerror';

              const productLink = row.querySelector('.c-product a');
              const productName = productLink?.getAttribute('title') || '';

              const openedBy = row.querySelector('.c-user')?.textContent?.trim() || '';

              // 根据实际的 HTML 结构解析 bug 状态
              // 从示例可以看到：
              // - 第 7 个 td（索引 6）：确认状态 <td class="text-center"><span class="confirmed">已确认</span></td>
              // - 第 11 个 td（索引 10）：解决状态 <td>已解决</td>

              const allTds = row.querySelectorAll('td');
              let isConfirmed = false;
              let isUnconfirmed = false;
              let isResolved = false;
              let resolvedBy = '';
              let resolution = '';

              console.log('[Content] Bug', zentaoId, `总共有 ${allTds.length} 个 td 单元格`);

              // 输出所有 td 的详细信息，帮助确定列结构
              allTds.forEach((td, index) => {
                const text = td.textContent?.trim().substring(0, 20);
                const className = td.className;
                console.log(`[Content]   [${index}] class="${className}" text="${text}"`);
              });

              // 检查第 8 个 td（索引 7）- 确认状态
              if (allTds.length > 7) {
                const confirmedCell = allTds[7];
                const confirmedText = confirmedCell.textContent?.trim() || '';

                console.log('[Content] Bug', zentaoId, `第8个td(索引7): "${confirmedText}"`);

                if (confirmedText === '已确认') {
                  isConfirmed = true;
                } else if (confirmedText === '未确认') {
                  isUnconfirmed = true;
                }
              }

              // 检查第 11 个 td（索引 10）- 解决状态
              if (allTds.length > 10) {
                const resolvedCell = allTds[10];
                resolution = resolvedCell.textContent?.trim() || '';

                console.log('[Content] Bug', zentaoId, `第11个td(索引10): "${resolution}"`);

                if (resolution === '已解决') {
                  isResolved = true;
                  // 解决者在第 10 个 td（索引 9）
                  if (allTds.length > 9) {
                    resolvedBy = allTds[9].textContent?.trim() || '';
                    console.log('[Content] Bug', zentaoId, `解决者: ${resolvedBy}`);
                  }
                }
              }

              console.log('[Content] Bug', zentaoId, '状态判断:', {
                isConfirmed,
                isUnconfirmed,
                isResolved,
                resolvedBy,
                resolution
              });

              // 根据确认状态和解决状态设置状态
              let status = 'unconfirmed';
              if (isResolved) {
                status = 'closed';  // 已解决的 Bug 状态为 closed
              } else if (isConfirmed) {
                status = 'activated';  // 已确认但未解决的 Bug 状态为 activated
              } else if (isUnconfirmed) {
                status = 'unconfirmed';  // 未确认的 Bug 状态为 unconfirmed
              }

              // 打印完整的 bug 信息
              console.log('[Content] ========== Bug 信息示例 ==========');
              console.log('[Content]', {
                zentaoId,
                title,
                status,
                severity,
                priority,
                bugType,
                productName,
                openedBy,
                resolvedBy,
                resolution,
                confirmed: isConfirmed
              });
              console.log('[Content] ======================================');
              console.log('[Content] Bug', zentaoId, '最终状态:', status);

              bugs.push({
                zentaoId,
                title,
                status,
                severity,
                priority,
                bugType,
                productName,
                openedBy,
                resolvedBy,
                resolution,
                confirmed: isConfirmed
              });
            } catch (err) {
              console.error('[Content] 解析Bug失败:', err);
            }
          });

          return { bugs, tableFound: true };
        }
      });

      const result = tempResults[0]?.result;
      if (result && result.tableFound) {
        // table 找到了，即使Bug为空也认为成功
        bugResults = tempResults;
        zentaoBugs = result.bugs || [];
        console.log('[Background] ✓ 找到Bug列表，解析到', zentaoBugs.length, '个Bug');
        break;  // 成功获取，退出循环
      } else {
        console.log('[Background] Bug列表尚未加载，等待', retryDelay, 'ms后重试...');
        if (i < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    }

    if (!bugResults) {
      console.log('[Background] 警告: 未能找到Bug列表，可能页面加载异常');
      zentaoBugs = [];
    }

    console.log('[Background] ✓ 解析到', zentaoBugs.length, '个Bug');
    } else {
      console.log('[Background] Bug数量为0，跳过Bug列表');
    }

    // 5.5. 为每个 Bug 获取详情信息（重现步骤、历史记录、指派人、抄送人）
    if (zentaoBugs.length > 0) {
      console.log('[Background] ========== 步骤6: 获取 Bug 详情信息 ==========');
      sendProgressUpdate(6, 7, `正在获取 ${zentaoBugs.length} 个 Bug 的详情信息...`);
      console.log('[Background] 开始为', zentaoBugs.length, '个 Bug 获取详情信息...');

      // 为每个 Bug 获取详情
      for (let i = 0; i < zentaoBugs.length; i++) {
        const bug = zentaoBugs[i];
        console.log(`[Background] [${i + 1}/${zentaoBugs.length}] 获取 Bug ${bug.zentaoId} 详情...`);

        try {
          const bugDetail = await fetchBugDetail(baseUrl, bug.zentaoId);

          // 将详情信息合并到 Bug 对象
          bug.steps = bugDetail.steps;
          bug.history = bugDetail.history;
          bug.assignedTo = bugDetail.assignedTo;
          bug.assignedDate = bugDetail.assignedDate;
          bug.cc = bugDetail.cc;

          console.log(`[Background] ✓ Bug ${bug.zentaoId} 详情获取完成，包含:`, {
            steps: bug.steps.substring(0, 50),
            historyCount: bug.history.length,
            assignedTo: bug.assignedTo,
            assignedDate: bug.assignedDate,
            cc: bug.cc
          });
        } catch (err) {
          console.error(`[Background] ✗ Bug ${bug.zentaoId} 详情获取失败:`, err);
          // 即使失败也保留 Bug，只是详情信息为空
          bug.steps = '';
          bug.history = [];
          bug.assignedTo = '';
          bug.assignedDate = '';
          bug.cc = '';
        }

        // 添加延迟避免请求过快（从500ms减少到100ms）
        if (i < zentaoBugs.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      console.log('[Background] ✓ 所有 Bug 详情获取完成');

      // 打印第一个 Bug 的完整信息，验证数据是否正确合并
      if (zentaoBugs.length > 0) {
        console.log('[Background] Bug 数据示例（详情合并后）:', JSON.stringify(zentaoBugs[0], null, 2));
      }
    }

    // 6. 发送到后端API保存
    console.log('[Background] ========== 步骤7: 保存到本地数据库 ==========');
    sendProgressUpdate(7, 7, '正在保存到本地数据库...');
    console.log('[Background] 准备发送任务数据:', zentaoTasks.length, '个任务');
    console.log('[Background] 准备发送Bug数据:', zentaoBugs.length, '个Bug');

    // 打印 Bug 数据样本，验证新字段是否被包含
    if (zentaoBugs.length > 0) {
      const sampleBug = zentaoBugs[0];
      console.log('[Background] Bug 数据样本（发送到后端前）:', {
        zentaoId: sampleBug.zentaoId,
        title: sampleBug.title,
        hasSteps: !!sampleBug.steps,
        stepsLength: sampleBug.steps?.length || 0,
        hasHistory: !!sampleBug.history,
        historyCount: sampleBug.history?.length || 0,
        assignedTo: sampleBug.assignedTo,
        assignedDate: sampleBug.assignedDate,
        cc: sampleBug.cc
      });
    }

    // 串行同步任务和 Bug，避免并发写入同一个文件导致文件损坏
    console.log('[Background] ========== 步骤6: 保存到本地数据库（串行执行） ==========');
    console.log('[Background] 准备发送任务数据:', zentaoTasks.length, '个任务');
    console.log('[Background] 准备发送Bug数据:', zentaoBugs.length, '个Bug');

    // 打印 Bug 数据样本，验证新字段是否被包含
    if (zentaoBugs.length > 0) {
      const sampleBug = zentaoBugs[0];
      console.log('[Background] Bug 数据样本（发送到后端前）:', {
        zentaoId: sampleBug.zentaoId,
        title: sampleBug.title,
        hasSteps: !!sampleBug.steps,
        stepsLength: sampleBug.steps?.length || 0,
        hasHistory: !!sampleBug.history,
        historyCount: sampleBug.history?.length || 0,
        assignedTo: sampleBug.assignedTo,
        assignedDate: sampleBug.assignedDate,
        cc: sampleBug.cc
      });
    }

    // 先同步任务
    console.log('[Background] 开始同步任务...');
    const tasksResult = await fetch(`${API_BASE_URL}/api/zentao/sync-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasks: zentaoTasks })
    }).then(r => r.json());
    console.log('[Background] ✓ 任务同步完成:', tasksResult);

    // 再同步 Bug
    console.log('[Background] 开始同步 Bug...');
    const bugsResult = await fetch(`${API_BASE_URL}/api/zentao/sync-bugs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bugs: zentaoBugs })
    }).then(r => r.json());
    console.log('[Background] ✓ Bug 同步完成:', bugsResult);

    console.log('[Background] ✓ 同步结果 - 任务:', tasksResult, 'Bug:', bugsResult);

    // 7. 更新同步时间戳（只在成功时更新）
    console.log('[Background] ========== 步骤7: 更新同步时间戳 ==========');
    await updateLastSyncTime();
    console.log('[Background] ✓ 同步时间戳已更新');

    // 8. 显示通知
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: '工作助手 - 禅道同步',
      message: `已从禅道同步 ${zentaoTasks.length} 个任务和 ${zentaoBugs.length} 个Bug`
    });

    console.log('[Background] ========== ✅ 禅道同步成功完成 ==========');

    return {
      success: true,
      data: {
        tasksSynced: zentaoTasks.length,
        bugsSynced: zentaoBugs.length,
        tasksResult,
        bugsResult
      }
    };
  } catch (err) {
    console.error('[Background] ========== ❌ 禅道同步失败 ==========');
    console.error('[Background] 错误详情:', err.message);
    console.error('[Background] 错误堆栈:', err.stack);
    console.log('[Background] 提示: 由于同步失败，未更新同步时间戳，可以立即重试');

    // 显示错误通知
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: '工作助手 - 禅道同步失败',
      message: `同步失败: ${err.message}，请检查网络或禅道配置`,
      requireInteraction: true
    });

    return { success: false, reason: err.message };
  } finally {
    // 清理：不要关闭用户自己的禅道标签页
    // 只关闭我们创建的临时标签页（如果用户原本没有禅道标签页）
    // 这里暂时不关闭，让用户自己决定
  }
}

/**
 * 解析禅道我的地盘页面，获取任务和Bug数量
 * @param {string} html - 页面HTML
 * @returns {Object} { taskCount, bugCount }
 */
function parseMyDashboard(html) {
  // 使用正则表达式提取
  const taskMatch = html.match(/<a[^>]*href="\/zentao\/my-work-task\.html"[^>]*class="text-primary"[^>]*>(\d+)<\/a>/);
  const bugMatch = html.match(/<a[^>]*href="\/zentao\/my-work-bug\.html"[^>]*class="text-primary"[^>]*>(\d+)<\/a>/);

  return {
    taskCount: taskMatch ? parseInt(taskMatch[1]) : 0,
    bugCount: bugMatch ? parseInt(bugMatch[1]) : 0
  };
}

/**
 * 解析禅道任务列表页面（使用正则表达式，Service Worker 兼容）
 * @param {string} html - 页面HTML
 * @returns {Array} 任务列表
 */
function parseTaskList(html) {
  const tasks = [];

  // 找到 tbody 开始和结束位置
  const tbodyStartMatch = html.match(/<tbody[^>]*id="myTaskList"[^>]*>/i);
  if (!tbodyStartMatch) {
    console.warn('[Background] 未找到 #myTaskList tbody');
    return [];
  }

  const tbodyStartIndex = html.indexOf(tbodyStartMatch[0]);
  const tbodyEndIndex = html.indexOf('</tbody>', tbodyStartIndex);
  if (tbodyEndIndex === -1) return [];

  const tbodyContent = html.substring(tbodyStartIndex, tbodyEndIndex);

  // 匹配所有 data-status="wait" 或 data-status="doing" 的 tr 标签
  const rowPattern = /<tr[^>]*\sdata-status="(wait|doing)"[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;

  while ((match = rowPattern.exec(tbodyContent)) !== null) {
    try {
      const rowHtml = match[0];
      const status = match[1];

      // 提取 data-id
      const idMatch = rowHtml.match(/data-id="(\d+)"/);
      const zentaoId = idMatch ? parseInt(idMatch[1]) : null;
      if (!zentaoId) continue;

      // 提取 data-estimate, data-consumed, data-left
      const estimateMatch = rowHtml.match(/data-estimate="(\d+(?:\.\d+)?)"/);
      const consumedMatch = rowHtml.match(/data-consumed="(\d+(?:\.\d+)?)"/);
      const leftMatch = rowHtml.match(/data-left="(\d+(?:\.\d+)?)"/);
      const estimate = estimateMatch ? parseFloat(estimateMatch[1]) : 0;
      const consumed = consumedMatch ? parseFloat(consumedMatch[1]) : 0;
      const left = leftMatch ? parseFloat(leftMatch[1]) : 0;

      // 提取任务标题
      const titleMatch = rowHtml.match(/<td class="c-name[^"]*"[^>]*>\s*<a[^>]*href="[^"]*"[^>]*>([^<]+)<\/a>/);
      const title = titleMatch ? titleMatch[1].trim() : '';

      // 提取优先级
      const priMatch = rowHtml.match(/<span class="label-pri[^"]*"[^>]*>(\d+)<\/span>/);
      const priority = priMatch ? parseInt(priMatch[1]) : 3;

      // 提取项目链接（第一个 c-project a 标签）
      const projectMatch = rowHtml.match(/<td class="c-project"[^>]*>\s*<a[^>]*href="\/zentao\/project-index-(\d+)\.html"[^>]*title="([^"]+)"/);
      const projectId = projectMatch ? parseInt(projectMatch[1]) : null;
      const projectName = projectMatch ? projectMatch[2] : '';

      // 提取执行链接（第二个 c-project a 标签）
      const executionMatch = rowHtml.match(/<td class="c-project"[^>]*>.*?<a[^>]*href="\/zentao\/execution-task-(\d+)\.html"[^>]*title="([^"]+)"/);
      const executionId = executionMatch ? parseInt(executionMatch[1]) : null;
      const executionName = executionMatch ? executionMatch[2] : '';

      // 提取创建人（第一个 c-user）
      const openedByMatch = rowHtml.match(/<td class="c-user"[^>]*>([^<]+)<\/td>/);
      const openedBy = openedByMatch ? openedByMatch[1].trim() : '';

      // 提取截止日期
      const deadlineMatch = rowHtml.match(/<td class="text-center delayed"[^>]*>\s*<span>([^<]+)<\/span>/);
      const deadline = deadlineMatch ? deadlineMatch[1].trim() : '';

      tasks.push({
        zentaoId,
        title,
        status: status === 'wait' ? 'todo' : 'in_progress',
        priority,
        projectId,
        projectName,
        executionId,
        executionName,
        openedBy,
        estimate,
        consumed,
        left,
        deadline,
        progress: estimate > 0 ? Math.round((consumed / estimate) * 100) : 0
      });
    } catch (err) {
      console.error('[Background] 解析任务行失败:', err);
    }
  }

  return tasks;
}

/**
 * 解析禅道Bug列表页面（使用正则表达式，Service Worker 兼容）
 * @param {string} html - 页面HTML
 * @returns {Array} Bug列表
 */
function parseBugList(html) {
  const bugs = [];

  // 找到 table 开始和结束位置
  const tableStartMatch = html.match(/<table[^>]*id="bugList"[^>]*>/i);
  if (!tableStartMatch) {
    console.warn('[Background] 未找到 #bugList table');
    return [];
  }

  const tableStartIndex = html.indexOf(tableStartMatch[0]);
  const tableEndIndex = html.indexOf('</table>', tableStartIndex);
  if (tableEndIndex === -1) return [];

  const tableContent = html.substring(tableStartIndex, tableEndIndex);

  // 匹配所有包含 bugIDList 的 tr 标签
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;

  while ((match = rowPattern.exec(tableContent)) !== null) {
    try {
      const rowHtml = match[0];

      // 检查是否包含 bugIDList（排除表头）
      if (!rowHtml.includes('name="bugIDList[]"')) continue;

      // 提取 Bug ID
      const idMatch = rowHtml.match(/name="bugIDList\[\]"\s*value="(\d+)"/);
      const zentaoId = idMatch ? parseInt(idMatch[1]) : null;
      if (!zentaoId) continue;

      // 提取Bug标题
      const titleMatch = rowHtml.match(/<a[^>]*href="\/zentao\/bug-view-\d+\.html"[^>]*>([^<]+)<\/a>/);
      const title = titleMatch ? titleMatch[1].trim() : '';

      // 提取严重程度
      const severityMatch = rowHtml.match(/<span class="label-severity"[^>]*data-severity="(\d+)"/);
      const severity = severityMatch ? parseInt(severityMatch[1]) : 3;

      // 提取优先级
      const priMatch = rowHtml.match(/<span class="label-pri label-pri-\d+"[^>]*title="(\d+)"/);
      const priority = priMatch ? parseInt(priMatch[1]) : 3;

      // 提取Bug类型
      const typeMatch = rowHtml.match(/<td class="c-type"[^>]*>([^<]+)<\/td>/);
      const bugType = typeMatch ? typeMatch[1].trim() : 'codeerror';

      // 提取产品名称
      const productMatch = rowHtml.match(/<td class="c-product"[^>]*>\s*<a[^>]*title="([^"]+)"/);
      const productName = productMatch ? productMatch[1] : '';

      // 提取创建者
      const openedByMatch = rowHtml.match(/<td class="c-user"[^>]*>([^<]+)<\/td>/);
      const openedBy = openedByMatch ? openedByMatch[1].trim() : '';

      // 检查确认状态
      const confirmed = rowHtml.includes('<span class="confirmed"') ||
                       rowHtml.includes('title="已确认"');

      // 提取解决者（第二个 c-user）
      const userMatches = rowHtml.match(/<td class="c-user"[^>]*>([^<]+)<\/td>/g);
      const resolvedBy = userMatches && userMatches.length > 1 ? userMatches[1].replace(/<[^>]+>/g, '').trim() : '';

      // 提取解决方案
      const resolutionMatch = rowHtml.match(/<td class="c-resolution"[^>]*>([^<]*)<\/td>/);
      const resolution = resolutionMatch ? resolutionMatch[1].trim() : '';

      // 判断Bug状态
      let status = 'unconfirmed';
      if (resolvedBy) {
        status = 'resolved';
      } else if (confirmed) {
        status = 'activated';
      }

      bugs.push({
        zentaoId,
        title,
        status,
        severity,
        priority,
        bugType,
        productName,
        openedBy,
        resolvedBy,
        resolution,
        confirmed
      });
    } catch (err) {
      console.error('[Background] 解析Bug行失败:', err);
    }
  }

  return bugs;
}

async function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        // 额外等待确保DOM渲染完成（从1000ms减少到100ms）
        setTimeout(resolve, 100);
      }
    };

    chrome.tabs.onUpdated.addListener(listener);

    // 超时保护（30秒）
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 30000);
  });
}

/**
 * 从 Bug 详情页面提取额外信息
 * @param {string} baseUrl - 禅道基础URL
 * @param {number} bugId - Bug ID
 * @returns {Promise<Object>} Bug 详情信息
 */
async function fetchBugDetail(baseUrl, bugId) {
  console.log('[Background] 开始获取 Bug 详情:', bugId);

  try {
    // 使用 ZentaoTabManager 获取或创建标签页
    const bugUrl = `${baseUrl}/zentao/bug-view-${bugId}.html`;
    const tab = await ZentaoTabManager.getOrCreateTab({
      baseUrl,
      targetUrl: bugUrl,
      active: false
    });

    console.log('[Background] Bug 详情标签页:', tab.id, tab.url);

    // 等待页面加载完成
    await ZentaoTabManager.waitForTabLoad(tab.id, 15000);

    // 在页面中执行脚本提取信息
    const bugDetail = await ZentaoTabManager.executeScript(tab, () => {
      const result = {
        steps: '',
        history: [],
        assignedTo: '',
        assignedDate: '',
        cc: ''
      };

      try {
        // 在 iframe 中查找内容
        const iframe = document.querySelector('#appIframe-qa');
        if (!iframe) {
          console.warn('[Bug Detail] 未找到 iframe #appIframe-qa');
          return result;
        }

        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
        if (!iframeDoc) {
          console.warn('[Bug Detail] 无法访问 iframe document');
          return result;
        }

        // 1. 提取重现步骤
        const stepsDiv = iframeDoc.querySelector('.detail-content.article-content');
        if (stepsDiv) {
          result.steps = stepsDiv.textContent?.trim() || '';
          console.log('[Bug Detail] 重现步骤:', result.steps.substring(0, 100));
        }

        // 2. 提取历史记录
        const historyList = iframeDoc.querySelector('.histories-list');
        if (historyList) {
          const historyItems = historyList.querySelectorAll('li');
          historyItems.forEach((item, index) => {
            const historyText = item.textContent?.trim() || '';
            console.log(`[Bug Detail] 历史[${index}]:`, historyText.substring(0, 100));

            // 提取备注内容（如果有）
            const commentDiv = item.querySelector('.comment-content');
            const comment = commentDiv ? commentDiv.textContent?.trim() : '';

            result.history.push({
              text: historyText,
              comment: comment
            });
          });
          console.log('[Bug Detail] 提取到', result.history.length, '条历史记录');
        }

        // 3. 提取指派人（从基本信息表格中）
        const table = iframeDoc.querySelector('table.table-data');
        if (table) {
          const rows = table.querySelectorAll('tr');
          rows.forEach(row => {
            const th = row.querySelector('th');
            const td = row.querySelector('td');
            if (!th || !td) return;

            const thText = th.textContent?.trim();
            const tdText = td.textContent?.trim();

            if (thText === '当前指派') {
              // 格式：李佳成 于 2026-04-01 10:16:23
              const match = tdText.match(/^(.+)\s+于\s+(.+)$/);
              if (match) {
                result.assignedTo = match[1];
                result.assignedDate = match[2];
              } else {
                result.assignedTo = tdText;
              }
              console.log('[Bug Detail] 指派人:', result.assignedTo, '日期:', result.assignedDate);
            } else if (thText === '抄送给') {
              result.cc = tdText;
              console.log('[Bug Detail] 抄送人:', result.cc);
            }
          });
        }

        console.log('[Bug Detail] 提取完成:', result);
        return result;
      } catch (err) {
        console.error('[Bug Detail] 提取失败:', err);
        return result;
      }
    });

    console.log('[Background] ✓ Bug 详情提取完成:', bugDetail);
    return bugDetail;
  } catch (err) {
    console.error('[Background] ✗ 获取 Bug 详情失败:', err);
    return {
      steps: '',
      history: [],
      assignedTo: '',
      assignedDate: '',
      cc: ''
    };
  }
}

