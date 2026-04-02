/**
 * 禅道标签页管理器
 * 统一管理禅道相关标签页的查找、创建、复用、导航等操作
 */
const ZentaoTabManager = {
  // 缓存当前活跃的禅道标签页
  _activeTab: null,
  _tabCache: new Map(), // tabId -> tab info

  /**
   * 获取或创建禅道标签页
   * @param {Object} options - 配置选项
   * @param {string} options.baseUrl - 禅道基础URL
   * @param {string} options.kanbanId - 可选的看板ID
   * @param {string} options.targetUrl - 可选的目标URL（优先级高于kanbanId）
   * @param {boolean} options.active - 是否激活标签页（默认false）
   * @param {boolean} options.reload - 是否刷新现有标签页（默认false）
   * @returns {Promise<Tab>} 标签页对象
   */
  async getOrCreateTab(options = {}) {
    const { baseUrl, kanbanId, targetUrl, active = false, reload = false } = options;

    console.log('[ZentaoTabManager] getOrCreateTab 调用:', { baseUrl, kanbanId, targetUrl, active, reload });

    // 1. 优先查找任何禅道标签页（排除登录页），只要匹配 baseUrl 即可
    const zentaoTab = await this._findAnyZentaoTab(baseUrl);
    if (zentaoTab) {
      console.log('[ZentaoTabManager] ✓ 找到禅道标签页:', zentaoTab.id, zentaoTab.url);

      // 如果需要导航到特定URL
      if (targetUrl && !zentaoTab.url.includes(targetUrl)) {
        console.log('[ZentaoTabManager] 需要导航:', {
          current: zentaoTab.url,
          target: targetUrl,
          reason: '当前URL不包含目标URL'
        });
        await this._navigateTo(zentaoTab, targetUrl);
      } else if (reload) {
        console.log('[ZentaoTabManager] 需要刷新当前页面');
        await this._reloadTab(zentaoTab);
      } else {
        console.log('[ZentaoTabManager] ✓ 无需导航，标签页已就绪');
      }

      return zentaoTab;
    }

    // 2. 如果提供了kanbanId，尝试查找匹配的看板标签页
    if (kanbanId) {
      const kanbanTab = await this._findKanbanTab(kanbanId);
      if (kanbanTab) {
        console.log('[ZentaoTabManager] ✓ 找到看板标签页:', kanbanTab.id, kanbanTab.url);

        if (reload) {
          console.log('[ZentaoTabManager] 需要刷新看板标签页');
          await this._reloadTab(kanbanTab);
        }

        // 如果需要导航到特定URL
        if (targetUrl && !kanbanTab.url.includes(targetUrl)) {
          console.log('[ZentaoTabManager] 需要导航看板标签页:', {
            current: kanbanTab.url,
            target: targetUrl
          });
          await this._navigateTo(kanbanTab, targetUrl);
        } else {
          console.log('[ZentaoTabManager] ✓ 看板标签页已就绪，无需导航');
        }

        return kanbanTab;
      }
    }

    // 3. 创建新标签页
    console.log('[ZentaoTabManager] 未找到现有标签页，创建新标签页');
    const createUrl = targetUrl || `${baseUrl}/zentao/my.html`;
    return await this._createTab(createUrl, active);
  },

  /**
   * 导航到指定URL
   * @param {Tab} tab - 标签页对象
   * @param {string} url - 目标URL
   * @param {Object} options - 选项
   * @param {number} options.waitTimeout - 等待超时时间（毫秒）
   * @returns {Promise<boolean>} 是否成功
   */
  async navigateTo(tab, url, options = {}) {
    const { waitTimeout = 15000 } = options;

    console.log('[ZentaoTabManager] navigateTo 调用:', { tabId: tab.id, url, waitTimeout });

    try {
      await chrome.tabs.update(tab.id, { url });
      await this.waitForTabLoad(tab.id, waitTimeout);
      console.log('[ZentaoTabManager] ✓ 导航成功');
      return true;
    } catch (error) {
      console.error('[ZentaoTabManager] ✗ 导航失败:', error);
      return false;
    }
  },

  /**
   * 在标签页中执行脚本
   * @param {Tab} tab - 标签页对象
   * @param {Function} func - 要执行的函数
   * @param {Array} args - 函数参数
   * @returns {Promise<any>} 执行结果
   */
  async executeScript(tab, func, args = []) {
    console.log('[ZentaoTabManager] executeScript 调用:', { tabId: tab.id, argsCount: args.length });

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func,
        args
      });

      const result = results && results.length > 0 ? results[0].result : null;
      console.log('[ZentaoTabManager] ✓ 脚本执行成功');
      return result;
    } catch (error) {
      console.error('[ZentaoTabManager] ✗ 脚本执行失败:', error);
      throw error;
    }
  },

  /**
   * 等待标签页加载完成
   * @param {number} tabId - 标签页ID
   * @param {number} timeout - 超时时间（毫秒）
   * @returns {Promise<boolean>} 是否成功加载
   */
  async waitForTabLoad(tabId, timeout = 15000) {
    console.log('[ZentaoTabManager] waitForTabLoad 调用:', { tabId, timeout });

    return new Promise(async (resolve) => {
      let resolved = false;

      // 先检查标签页当前状态，如果已经加载完成则直接返回
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab.status === 'complete') {
          console.log('[ZentaoTabManager] ✓ 标签页已加载完成（检查时已complete）');
          // 额外等待确保DOM渲染完成
          setTimeout(() => resolve(true), 1000);
          return;
        }
      } catch (err) {
        console.error('[ZentaoTabManager] 获取标签页状态失败:', err);
      }

      const listener = (updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          if (resolved) return;  // 防止重复调用
          resolved = true;

          chrome.tabs.onUpdated.removeListener(listener);
          // 额外等待确保DOM渲染完成
          setTimeout(() => {
            console.log('[ZentaoTabManager] ✓ 标签页加载完成');
            resolve(true);
          }, 1000);
        }
      };

      chrome.tabs.onUpdated.addListener(listener);

      // 超时保护
      setTimeout(() => {
        if (resolved) return;  // 已经 resolve，不再执行超时逻辑
        resolved = true;

        chrome.tabs.onUpdated.removeListener(listener);
        console.warn('[ZentaoTabManager] ⚠ 标签页加载超时');
        resolve(false);
      }, timeout);
    });
  },

  /**
   * 查找匹配URL的标签页
   * @private
   */
  async _findTabByUrl(url) {
    const allTabs = await chrome.tabs.query({});
    return allTabs.find(tab => tab.url && tab.url.includes(url));
  },

  /**
   * 查找看板标签页
   * @private
   */
  async _findKanbanTab(kanbanId) {
    const allTabs = await chrome.tabs.query({});
    return allTabs.find(tab =>
      tab.url &&
      tab.url.includes('zentao') &&
      !tab.url.includes('user-login') &&
      (tab.url.includes(`execution-kanban-${kanbanId}`) ||
       tab.url.includes(`kanban-view-${kanbanId}`))
    );
  },

  /**
   * 查找任何禅道标签页（排除登录页）
   * @private
   */
  async _findAnyZentaoTab(baseUrl) {
    const allTabs = await chrome.tabs.query({});
    return allTabs.find(tab =>
      tab.url &&
      tab.url.includes(baseUrl) &&  // 必须包含 baseUrl
      tab.url.includes('zentao') &&
      !tab.url.includes('user-login')
    );
  },

  /**
   * 刷新标签页
   * @private
   */
  async _reloadTab(tab) {
    console.log('[ZentaoTabManager] _reloadTab 调用:', tab.id);
    await chrome.tabs.reload(tab.id);
    await this.waitForTabLoad(tab.id, 10000);
  },

  /**
   * 导航到指定URL
   * @private
   */
  async _navigateTo(tab, url) {
    console.log('[ZentaoTabManager] _navigateTo 调用:', { tabId: tab.id, currentUrl: tab.url, targetUrl: url });

    // 如果已经在目标 URL，直接返回
    if (tab.url === url) {
      console.log('[ZentaoTabManager] ✓ 标签页已在目标URL，无需导航');
      return tab;
    }

    console.log('[ZentaoTabManager] 开始导航...');
    await chrome.tabs.update(tab.id, { url });
    await this.waitForTabLoad(tab.id, 20000);  // 增加超时到 20 秒
    console.log('[ZentaoTabManager] ✓ 导航完成');
  },

  /**
   * 创建新标签页
   * @private
   */
  async _createTab(url, active = false) {
    console.log('[ZentaoTabManager] _createTab 调用:', { url, active });
    const newTab = await chrome.tabs.create({ url, active });
    await this.waitForTabLoad(newTab.id, 15000);

    // 重新获取标签页信息以确保URL已更新
    const updatedTab = await chrome.tabs.get(newTab.id);
    this._activeTab = updatedTab;
    this._tabCache.set(updatedTab.id, updatedTab);

    console.log('[ZentaoTabManager] ✓ 新标签页创建成功:', updatedTab.id, updatedTab.url);
    return updatedTab;
  },

  /**
   * 清理缓存
   */
  clearCache() {
    console.log('[ZentaoTabManager] clearCache 调用');
    this._activeTab = null;
    this._tabCache.clear();
  }
};
