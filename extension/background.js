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
