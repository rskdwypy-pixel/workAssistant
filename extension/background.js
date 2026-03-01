// API配置
const API_BASE_URL = 'http://localhost:3721';

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
            iconUrl: 'icons/icon48.png',
            title: '工作助手',
            message: `任务已添加：${result.data.title}`
          });
        } else {
          chrome.notifications.create({
            type: 'basic',
            iconUrl: 'icons/icon48.png',
            title: '工作助手',
            message: '添加失败，请确保后端服务正在运行'
          });
        }
      } catch (err) {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icons/icon48.png',
          title: '工作助手',
          message: '连接失败，请确保后端服务正在运行'
        });
      }
    }
  }
});

// 处理来自前端的特权API请求
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'performZenTaoLogin') {
    console.log('[Background] 启动全自动标签页模拟登录流...');
    const baseUrl = request.url.replace(/\/$/, '');
    const loginUrl = `${baseUrl}/zentao/user-login.html`;
    console.log('[Background] 登录URL:', loginUrl);

    chrome.tabs.create({ url: loginUrl, active: false }, (tab) => {
      if (chrome.runtime.lastError) {
        console.error('[Background] 创建标签页失败:', chrome.runtime.lastError);
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
            console.error('[Background] 脚本注入失败:', err);
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
});

// 在禅道页面中执行请求（使用 content script）
async function executeInZentaoPage(params) {
  const { baseUrl, executionId, username, taskData } = params;
  const createTaskUrl = `${baseUrl}/zentao/task-create-${executionId}-0-0.html`;

  console.log('[Background] 尝试在禅道页面中执行请求');

  // 查找是否已经打开禅道页面的标签
  const tabs = await chrome.tabs.query({ url: `${baseUrl}/*` });
  let targetTab = tabs.find(tab => tab.url.includes('zentao') && !tab.url.includes('user-login'));

  // 如果没有找到，创建一个隐藏标签
  if (!targetTab) {
    console.log('[Background] 未找到禅道标签，创建新标签');
    targetTab = await chrome.tabs.create({ url: createTaskUrl, active: false });

    // 等待页面加载
    await new Promise(resolve => {
      const listener = (tabId, changeInfo) => {
        if (tabId === targetTab.id && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });

    // 额外等待一下确保页面完全加载
    await new Promise(r => setTimeout(r, 1000));
  }

  // 在禅道页面中注入脚本执行请求
  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTab.id },
    func: (executionId, username, taskData, uid) => {
      return new Promise((resolve) => {
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

        fetch(endpoint, {
          method: 'POST',
          headers: {
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: formData
        })
        .then(r => r.text())
        .then(text => {
          try {
            const data = JSON.parse(text);
            resolve({ success: true, data });
          } catch (e) {
            resolve({ success: false, reason: 'invalid_json', responseText: text.substring(0, 500) });
          }
        })
        .catch(err => {
          resolve({ success: false, reason: err.message });
        });
      });
    },
    args: [executionId, username, taskData, generateUid()]
  });

  return results[0].result;
}

// 更新禅道任务状态
async function updateZentaoTaskStatus(params) {
  const { baseUrl, taskId, status } = params;

  console.log('[Background] 更新禅道任务状态:', { taskId, status });

  // 查找禅道标签页
  const tabs = await chrome.tabs.query({ url: `${baseUrl}/*` });
  let targetTab = tabs.find(tab => tab.url.includes('zentao') && !tab.url.includes('user-login'));

  if (!targetTab) {
    return { success: false, reason: '未找到禅道页面，请先打开禅道网站' };
  }

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
  const { baseUrl, taskId, comment, consumedTime, leftTime } = params;

  console.log('[Background] 记录禅道任务工时:', { taskId, consumedTime, comment });

  // 查找禅道标签页
  const tabs = await chrome.tabs.query({ url: `${baseUrl}/*` });
  let targetTab = tabs.find(tab => tab.url.includes('zentao') && !tab.url.includes('user-login'));

  if (!targetTab) {
    return { success: false, reason: '未找到禅道页面，请先打开禅道网站' };
  }

  // 获取当前日期
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTab.id },
    func: (taskId, comment, consumedTime, leftTime, today) => {
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
        .then(r => r.text())
        .then(text => {
          // 检查是否成功（返回的 HTML 中可能包含成功信息）
          if (text.includes('class="alert alert-success"') || text.includes('保存成功') || text.includes('记录成功')) {
            resolve({ success: true });
          } else if (text.includes('class="alert alert-danger"') || text.includes('错误')) {
            // 尝试提取错误信息
            const errorMatch = text.match(/<div class="alert alert-success"[^>]*>([^<]+)</);
            if (errorMatch) {
              resolve({ success: false, reason: errorMatch[1] });
            } else {
              resolve({ success: false, reason: '记录工时失败' });
            }
          } else {
            // 可能是重定向或其他情况，认为成功
            resolve({ success: true });
          }
        })
        .catch(err => {
          resolve({ success: false, reason: err.message });
        });
      });
    },
    args: [taskId, comment, consumedTime, leftTime, today]
  });

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

  // 查找禅道标签页
  const tabs = await chrome.tabs.query({ url: `${baseUrl}/*` });
  let targetTab = tabs.find(tab => tab.url.includes('zentao') && !tab.url.includes('user-login'));

  if (!targetTab) {
    return { success: false, reason: '未找到禅道页面，请先打开禅道网站' };
  }

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

  // 查找禅道标签页
  const tabs = await chrome.tabs.query({ url: `${baseUrl}/*` });
  let targetTab = tabs.find(tab => tab.url.includes('zentao') && !tab.url.includes('user-login'));

  if (!targetTab) {
    return { success: false, reason: '未找到禅道页面，请先打开禅道网站' };
  }

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
