// ==================== 同步 UI 组件（集成到设置页面）====================

/**
 * 同步设置 UI 管理器 - 集成到主设置页面
 */
class SyncUI {
  constructor(syncManager) {
    this.syncManager = syncManager;
    this.statusIndicator = null;
  }

  /**
   * 初始化同步UI
   */
  init() {
    this.setupSettingsButton();
    this.setupSettingsEvents();
    this.updateConnectionStatus();
  }

  /**
   * 设置设置按钮
   */
  setupSettingsButton() {
    const settingsBtn = document.getElementById('settingsBtn');
    if (settingsBtn) {
      // 移除旧的事件监听器
      const newBtn = settingsBtn.cloneNode(true);
      settingsBtn.parentNode.replaceChild(newBtn, settingsBtn);

      newBtn.addEventListener('click', () => {
        this.openSettings();
      });
    }
  }

  /**
   * 打开设置页面（并加载同步配置）
   */
  openSettings() {
    loadSettings();
    this.loadCurrentSyncSettings();
    document.getElementById('settingsModal').classList.add('active');
    checkServiceStatus();
  }

  /**
   * 加载当前同步配置到设置页面
   */
  loadCurrentSyncSettings() {
    const config = this.syncManager.syncConfig;

    document.getElementById('syncWebdavUrl').value = config.webdav.url || '';
    document.getElementById('syncWebdavUsername').value = config.webdav.username || '';
    document.getElementById('syncWebdavPassword').value = config.webdav.password || '';
    document.getElementById('syncAutoEnabled').checked = config.autoSync !== false;

    // 根据 url 判断初始所在 tab
    const url = config.webdav.url || '';
    const isJianguo = url === 'https://dav.jianguoyun.com/dav/' || url === '';

    document.querySelectorAll('.sync-tab').forEach(t => t.classList.remove('active'));
    if (isJianguo) {
      document.querySelector('.sync-tab[data-provider="jianguoyun"]').classList.add('active');
      this.switchProvider('jianguoyun');
    } else {
      document.querySelector('.sync-tab[data-provider="custom"]').classList.add('active');
      this.switchProvider('custom');
    }

    // 更新连接状态
    this.updateConnectionStatus();
  }

  /**
   * 设置设置页面中的同步相关事件
   */
  setupSettingsEvents() {
    // Provider tabs
    document.querySelectorAll('.sync-tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        document.querySelectorAll('.sync-tab').forEach(t => t.classList.remove('active'));
        e.target.classList.add('active');
        this.switchProvider(e.target.dataset.provider);
      });
    });

    // 测试连接
    document.getElementById('testSyncConnection').addEventListener('click', () => {
      this.testConnection();
    });

    // 立即同步
    document.getElementById('syncNowBtn').addEventListener('click', () => {
      this.syncNow();
    });
  }

  /**
   * 切换服务商
   */
  switchProvider(provider) {
    const urlInput = document.getElementById('syncWebdavUrl');
    const helpDiv = document.getElementById('jianguoyunHelp');

    if (provider === 'jianguoyun') {
      // 坚果云根目录是 /dav/，文件名包含子文件夹路径会自动创建
      urlInput.value = 'https://dav.jianguoyun.com/dav/';
      urlInput.disabled = true;
      if (helpDiv) helpDiv.style.display = 'block';
    } else {
      urlInput.disabled = false;
      if (helpDiv) helpDiv.style.display = 'none';
    }
  }

  /**
   * 测试连接
   */
  async testConnection() {
    const resultEl = document.getElementById('syncTestResult');
    resultEl.textContent = '测试中...';
    resultEl.className = 'test-result';

    // 临时更新配置以测试
    const tempConfig = {
      enabled: true,
      webdav: {
        url: document.getElementById('syncWebdavUrl').value,
        username: document.getElementById('syncWebdavUsername').value,
        password: document.getElementById('syncWebdavPassword').value,
        dirname: 'workassistant'
      }
    };

    await this.syncManager.updateStorageConfig(tempConfig);

    try {
      const result = await this.syncManager.testConnection();
      if (result.success) {
        resultEl.textContent = '✅ 连接成功';
        resultEl.className = 'test-result success';
        document.getElementById('syncNowBtn').disabled = false;
      } else {
        resultEl.textContent = '❌ ' + result.message;
        resultEl.className = 'test-result error';
      }
    } catch (err) {
      resultEl.textContent = '❌ ' + err.message;
      resultEl.className = 'test-result error';
    }
  }

  /**
   * 保存同步配置（从设置页面调用）
   */
  saveSyncSettingsFromSettings() {
    const config = {
      enabled: true,
      type: 'webdav',
      webdav: {
        url: document.getElementById('syncWebdavUrl').value,
        username: document.getElementById('syncWebdavUsername').value,
        password: document.getElementById('syncWebdavPassword').value,
        dirname: 'workassistant'
      },
      autoSync: document.getElementById('syncAutoEnabled').checked
    };

    // 如果有填写配置，则保存
    if (config.webdav.url && config.webdav.username && config.webdav.password) {
      this.syncManager.saveSyncConfig(config);
      this.syncManager.updateStorageConfig(config);
      this.updateConnectionStatus();
    }
  }

  /**
   * 更新连接状态显示
   */
  updateConnectionStatus() {
    const config = this.syncManager.syncConfig;
    const syncNowBtn = document.getElementById('syncNowBtn');

    if (config.webdav.url && config.webdav.username && config.webdav.password) {
      if (syncNowBtn) syncNowBtn.disabled = false;
    } else {
      if (syncNowBtn) syncNowBtn.disabled = true;
    }
  }

  /**
   * 立即同步
   */
  async syncNow() {
    const syncBtn = document.getElementById('syncNowBtn');
    const originalText = syncBtn.textContent;
    syncBtn.textContent = '🔄 同步中...';
    syncBtn.disabled = true;

    try {
      const result = await this.syncManager.syncNow();
      if (result.success) {
        Toast.show('同步完成', 'success');
        this.updateStatusDisplay();
      }
    } catch (err) {
      Toast.show('同步失败: ' + err.message, 'error');
    } finally {
      syncBtn.textContent = originalText;
      syncBtn.disabled = false;
    }
  }

  /**
   * 更新设置面板中的同步信息显示
   */
  updateStatusDisplay() {
    const status = this.syncManager.getSyncStatus();

    // 更新设置面板中的信息
    const lastTimeEl = document.getElementById('syncLastTime');
    if (lastTimeEl && status.lastSync) {
      lastTimeEl.textContent = '上次同步: ' + new Date(status.lastSync).toLocaleString('zh-CN');
    } else if (lastTimeEl) {
      lastTimeEl.textContent = '';
    }
  }

  /**
   * 显示同步结果
   */
  showSyncResult(message, isSuccess = true) {
    const resultEl = document.getElementById('syncTestResult');
    if (resultEl) {
      resultEl.textContent = (isSuccess ? '✅ ' : '❌ ') + message;
      resultEl.className = 'test-result ' + (isSuccess ? 'success' : 'error');
    }
  }
}
