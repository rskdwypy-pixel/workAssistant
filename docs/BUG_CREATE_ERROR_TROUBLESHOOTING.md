# Bug 创建失败错误分析与解决方案

## 📋 错误日志分析

### 完整错误流程

```
1. [BugManager] 执行类型: 167 => stage
2. [BugManager] 使用普通执行逻辑创建 Bug
3. [ProgressToast] 正在创建禅道 Bug...
4. [Background] 获取普通执行的 productID, executionId: 167
5. [ZentaoTabManager] ✓ 找到禅道标签页: 361196583
6. [Background] 导航到执行页面: http://10.128.1.8:8088/zentao/execution-bug-167.html
7. [Background] 执行页面已加载，从 DOM 中提取 productID
8. ❌ [BugManager] ✗ 获取 productID 失败: Frame with ID 0 is showing error page
9. [Background] 登录超时，清理资源
10. [ZentaoBrowser] 后台注入登录失败: 静默登录标签页超时或账号密码有误
11. Uncaught Error: No tab with id: 361196645
```

### 🔍 错误根本原因

**主要错误**: `Frame with ID 0 is showing error page`

这个错误表明：
1. 禅道标签页显示的是**错误页面**，而不是正常的执行页面
2. Chrome 扩展无法访问页面的 iframe，因为页面本身就是一个错误页面
3. 可能的**错误页面类型**：
   - 404 页面（执行不存在）
   - 403 页面（权限不足）
   - 500 页面（服务器错误）
   - 登录页面（session 过期）
   - 网络错误页面（无法连接）

---

## 🛠️ 解决方案

### 方案 1: 检查禅道页面访问权限

**问题**: 执行ID 167 可能不存在或用户无权访问

**验证步骤**:

1. **手动访问执行页面**:
   ```
   http://10.128.1.8:8088/zentao/execution-bug-167.html
   ```

2. **检查可能的错误**:
   - ✅ **正常显示**: 执行存在且有权限
   - ❌ **404错误**: 执行不存在，需要检查执行ID
   - ❌ **403错误**: 权限不足，需要联系管理员
   - ❌ **登录页面**: Session过期，需要重新登录

**解决方案**:

```javascript
// 在 background.js 中添加页面状态检测
async function checkPageStatus(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        return {
          title: document.title,
          url: window.location.href,
          bodyText: document.body ? document.body.innerText.substring(0, 200) : '',
          isErrorPage: document.body?.innerText.includes('404') ||
                       document.body?.innerText.includes('403') ||
                       document.body?.innerText.includes('500') ||
                       document.title.includes('登录')
        };
      }
    });

    return results[0].result;
  } catch (error) {
    return { isErrorPage: true, error: error.message };
  }
}
```

### 方案 2: 增强错误检测和处理

**改进代码**: 在 `background.js` 中的 `getExecutionProductId` 函数

```javascript
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
        setTimeout(resolve, 500);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);

    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
  });

  // ⭐ 新增：检查页面状态
  console.log('[Background] 执行页面已加载，检查页面状态');
  const pageStatus = await checkPageStatus(targetTab.id);
  console.log('[Background] 页面状态:', pageStatus);

  if (pageStatus.isErrorPage) {
    console.error('[Background] ❌ 页面显示错误页面:', pageStatus);
    return {
      success: false,
      reason: 'error_page',
      pageTitle: pageStatus.title,
      pageUrl: pageStatus.url,
      bodyPreview: pageStatus.bodyText
    };
  }

  // 继续原有的 productID 提取逻辑
  console.log('[Background] ✓ 页面正常，从 DOM 中提取 productID');

  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTab.id },
    func: (executionId) => {
      // ... 原有的提取逻辑 ...
    },
    args: [executionId]
  });

  return results[0].result;
}

// 页面状态检测函数
async function checkPageStatus(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        const bodyText = document.body ? document.body.innerText : '';
        return {
          title: document.title,
          url: window.location.href,
          bodyText: bodyText.substring(0, 200),
          isErrorPage: bodyText.includes('404') ||
                       bodyText.includes('403') ||
                       bodyText.includes('500') ||
                       bodyText.includes('无法访问') ||
                       bodyText.includes('Access denied') ||
                       document.title.includes('登录') ||
                       document.title.includes('Error')
        };
      }
    });

    return results[0].result;
  } catch (error) {
    console.error('[Background] 页面状态检测失败:', error);
    return { isErrorPage: true, error: error.message };
  }
}
```

### 方案 3: 改进前端错误提示

**改进代码**: 在 `newtab.js` 中的 `submitBug` 函数

```javascript
// 在 newtab.js:8583 附近
if (!productIdResponse || !productIdResponse.success) {
  console.error('[BugManager] ✗ 获取 productID 失败:', productIdResponse?.reason);
  ProgressToast.hide();

  // ⭐ 改进错误提示
  let errorMessage = '获取 productID 失败';
  let errorDetail = productIdResponse?.reason || '未知错误';

  // 根据错误原因提供具体的解决建议
  if (productIdResponse?.reason === 'error_page') {
    errorMessage = '禅道页面显示错误';
    errorDetail = `页面: ${productIdResponse.pageTitle}\n请检查:\n` +
                  `1. 执行ID是否正确\n` +
                  `2. 是否有访问权限\n` +
                  `3. 网络连接是否正常`;

    // 如果是登录页面，提示重新登录
    if (productIdResponse.pageTitle?.includes('登录')) {
      errorDetail = '禅道登录已过期，请先在禅道标签页登录';
    }
  } else if (productIdResponse?.reason === 'iframe_not_found') {
    errorMessage = '页面结构异常';
    errorDetail = '禅道页面可能正在加载或版本不兼容，请稍后重试';
  } else if (productIdResponse?.reason === 'bug_create_link_not_found') {
    errorMessage = '无法创建Bug';
    errorDetail = '当前执行可能没有创建Bug的权限，请联系管理员';
  } else if (productIdResponse?.reason === 'no_zentao_tab') {
    errorMessage = '未找到禅道标签页';
    errorDetail = '请确保已打开禅道页面';
  }

  Toast.error(`${errorMessage}: ${errorDetail}`);
  return;
}
```

### 方案 4: 添加重试机制

```javascript
// 在 newtab.js 中添加重试逻辑
async function getProductWithRetry(executionId, maxRetries = 2) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await new Promise(resolve => {
        chrome.runtime.sendMessage({
          action: 'getExecutionProductId',
          baseUrl: config.zentaoUrl,
          executionId
        }, resolve);
      });

      if (response.success) {
        return response;
      }

      // 如果是错误页面，不重试
      if (response.reason === 'error_page') {
        return response;
      }

      // 其他错误，等待后重试
      if (i < maxRetries - 1) {
        console.log(`[BugManager] 第${i + 1}次获取productID失败，2秒后重试...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    } catch (error) {
      console.error(`[BugManager] 获取productID异常（第${i + 1}次）:`, error);
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  return { success: false, reason: 'max_retries_exceeded' };
}
```

---

## 🔧 快速修复步骤

### 步骤 1: 验证禅道访问

1. **手动打开禅道执行页面**:
   ```
   http://10.128.1.8:8088/zentao/execution-bug-167.html
   ```

2. **检查页面状态**:
   - ✅ 如果页面正常显示 → 继续步骤2
   - ❌ 如果显示错误 → 根据错误类型处理：
     - **404**: 检查执行ID是否正确
     - **403**: 联系管理员获取权限
     - **登录页面**: 重新登录禅道

### 步骤 2: 检查执行配置

1. **确认执行ID正确**:
   - 进入禅道 → 执行 → 查看执行列表
   - 确认执行ID 167 是否存在

2. **确认执行类型**:
   - 检查是 `stage`、`sprint` 还是 `kanban`
   - 不同类型的执行，Bug创建流程可能不同

### 步骤 3: 重新登录禅道

1. **在禅道标签页重新登录**
2. **刷新扩展**:
   - 打开 `chrome://extensions/`
   - 点击工作助手的"重新加载"按钮

### 步骤 4: 重试创建Bug

1. **重新打开Bug创建弹窗**
2. **确认执行ID正确**
3. **提交Bug**

---

## 🎯 预防措施

### 1. 定期检查禅道Session

```javascript
// 在后台定期检查禅道登录状态
setInterval(async () => {
  const config = await getZentaoConfig();
  if (config.enabled) {
    const isLoggedIn = await checkZentaoLoginStatus(config.url);
    if (!isLoggedIn) {
      console.warn('[Background] 禅道Session已过期');
      // 通知用户重新登录
      notifyUserToRelogin();
    }
  }
}, 5 * 60 * 1000); // 每5分钟检查一次
```

### 2. 添加执行验证

```javascript
// 在创建Bug前验证执行是否存在
async function validateExecution(executionId) {
  try {
    const response = await fetch(`${config.zentaoUrl}/zentao/execution-view-${executionId}.html`);
    const text = await response.text();

    // 检查是否是错误页面
    if (text.includes('404') || text.includes('无法访问')) {
      return { valid: false, reason: 'execution_not_found' };
    }

    return { valid: true };
  } catch (error) {
    return { valid: false, reason: 'network_error' };
  }
}
```

### 3. 改进用户提示

1. **在选择执行时提示用户**:
   ```
   已选择执行: [执行名称]
   执行ID: 167
   执行类型: stage
   ```

2. **在创建Bug前显示详细信息**:
   ```
   即将创建Bug:
   - 执行: [执行名称] (ID: 167)
   - 产品: [产品名称] (ID: xxx)
   - 标题: [Bug标题]
   ```

---

## 📊 错误代码参考

| 错误代码 | 错误描述 | 解决方案 |
|---------|---------|---------|
| `error_page` | 禅道页面显示错误页面 | 检查执行ID和权限 |
| `iframe_not_found` | 找不到页面iframe | 刷新页面或重试 |
| `bug_create_link_not_found` | 找不到创建Bug链接 | 检查执行权限 |
| `no_zentao_tab` | 找不到禅道标签页 | 打开禅道页面 |
| `max_retries_exceeded` | 重试次数超限 | 检查网络连接 |
| `execution_not_found` | 执行不存在 | 检查执行ID |
| `network_error` | 网络错误 | 检查网络连接 |

---

## ✅ 验证修复

修复后，按以下步骤验证：

1. **重新加载扩展**
2. **打开禅道并登录**
3. **创建测试Bug**:
   ```
   标题: 测试Bug
   类型: 代码错误
   严重程度: 3
   步骤: 测试Bug创建功能
   ```
4. **检查结果**:
   - ✅ Bug成功创建
   - ✅ 显示Bug ID
   - ✅ 可点击Bug ID查看详情

---

## 🎓 总结

这个错误的根本原因是**禅道标签页显示错误页面**，导致扩展无法访问页面元素提取productID。

**关键点**:
1. 🔍 首先手动访问禅道页面，确认页面是否正常
2. 🔧 添加页面状态检测，在提取数据前验证页面
3. 💡 改进错误提示，提供具体的解决建议
4. 🔄 添加重试机制，处理临时性错误
5. ✅ 定期检查登录状态，预防Session过期

按照这些步骤，应该能够解决Bug创建失败的问题！