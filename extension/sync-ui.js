// ==================== 备份 UI 组件（集成到设置页面）====================

/**
 * 备份设置 UI 管理器 - 集成到主设置页面
 */
class BackupUI {
  constructor(backupManager) {
    this.backupManager = backupManager;
    this.statusIndicator = null;
  }

  /**
   * 初始化备份UI
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
   * 打开设置页面（并加载备份配置）
   */
  openSettings() {
    loadSettings();
    this.loadCurrentBackupSettings();
    document.getElementById('settingsModal').classList.add('active');
    checkServiceStatus();
  }

  /**
   * 加载当前备份配置到设置页面
   */
  loadCurrentBackupSettings() {
    const config = this.backupManager.backupConfig;

    document.getElementById('backupWebdavUrl').value = config.webdav.url || '';
    document.getElementById('backupWebdavUsername').value = config.webdav.username || '';
    document.getElementById('backupWebdavPassword').value = config.webdav.password || '';
    document.getElementById('backupAutoEnabled').checked = config.autoBackup !== false;

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
    this.updateBackupStatusDisplay();
  }

  /**
   * 设置设置页面中的备份相关事件
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
    const testBtn = document.getElementById('testBackupConnection');
    if (testBtn) {
      testBtn.addEventListener('click', () => {
        this.testConnection();
      });
    }

    // 立即备份
    const backupBtn = document.getElementById('backupNowBtn');
    if (backupBtn) {
      backupBtn.addEventListener('click', () => {
        this.backupNow();
      });
    }

    // 恢复数据
    const restoreBtn = document.getElementById('restoreNowBtn');
    if (restoreBtn) {
      restoreBtn.addEventListener('click', () => {
        this.restoreNow();
      });
    }
  }

  /**
   * 切换服务商
   */
  switchProvider(provider) {
    const urlInput = document.getElementById('backupWebdavUrl');
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
    const resultEl = document.getElementById('backupTestResult');
    resultEl.textContent = '测试中...';
    resultEl.className = 'test-result';

    // 临时更新配置以测试
    const tempConfig = {
      enabled: true,
      webdav: {
        url: document.getElementById('backupWebdavUrl').value,
        username: document.getElementById('backupWebdavUsername').value,
        password: document.getElementById('backupWebdavPassword').value,
        dirname: 'workassistant_backup'
      }
    };

    await this.backupManager.saveBackupConfig(tempConfig);
    await this.backupManager.loadStorageAdapter();

    try {
      const result = await this.backupManager.checkConnection();
      if (result.success) {
        resultEl.textContent = '✅ 连接成功';
        resultEl.className = 'test-result success';
        document.getElementById('backupNowBtn').disabled = false;
        document.getElementById('restoreNowBtn').disabled = false;
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
   * 保存备份配置（从设置页面调用）
   */
  saveBackupSettingsFromSettings() {
    const config = {
      enabled: true,
      webdav: {
        url: document.getElementById('backupWebdavUrl').value,
        username: document.getElementById('backupWebdavUsername').value,
        password: document.getElementById('backupWebdavPassword').value,
        dirname: 'workassistant_backup'
      },
      autoBackup: document.getElementById('backupAutoEnabled').checked
    };

    // 如果有填写配置，则保存
    if (config.webdav.url && config.webdav.username && config.webdav.password) {
      this.backupManager.saveBackupConfig(config);
      this.backupManager.loadStorageAdapter();
      this.updateConnectionStatus();
    }
  }

  /**
   * 更新连接状态显示
   */
  updateConnectionStatus() {
    const config = this.backupManager.backupConfig;
    const backupNowBtn = document.getElementById('backupNowBtn');
    const restoreNowBtn = document.getElementById('restoreNowBtn');

    if (config.webdav.url && config.webdav.username && config.webdav.password) {
      if (backupNowBtn) backupNowBtn.disabled = false;
      if (restoreNowBtn) restoreNowBtn.disabled = false;
    } else {
      if (backupNowBtn) backupNowBtn.disabled = true;
      if (restoreNowBtn) restoreNowBtn.disabled = true;
    }
  }

  /**
   * 立即备份
   */
  async backupNow() {
    const backupBtn = document.getElementById('backupNowBtn');
    const originalText = backupBtn.textContent;
    backupBtn.textContent = '💾 备份中...';
    backupBtn.disabled = true;

    try {
      const result = await this.backupManager.backup();
      if (result.success) {
        const stats = result.stats;
        const message = `备份完成！✅\n` +
          `📋 任务: ${stats.tasks} 个\n` +
          `📊 报告: ${stats.history} 个\n` +
          `⚙️ 配置: ${(stats.configSize / 1024).toFixed(1)} KB\n` +
          `⏰ 时间: ${new Date(result.timestamp).toLocaleString('zh-CN')}`;
        Toast.show(message, 'success', 5000);
        this.updateBackupStatusDisplay();
      }
    } catch (err) {
      Toast.show('备份失败: ' + err.message, 'error');
    } finally {
      backupBtn.textContent = originalText;
      backupBtn.disabled = false;
    }
  }

  /**
   * 恢复数据
   */
  async restoreNow() {
    const restoreBtn = document.getElementById('restoreNowBtn');
    const originalText = restoreBtn.textContent;
    restoreBtn.textContent = '📥 恢复中...';
    restoreBtn.disabled = true;

    try {
      // 确认对话框
      const confirmed = confirm('⚠️ 恢复操作将覆盖本地数据，确定要继续吗？');
      if (!confirmed) {
        restoreBtn.textContent = originalText;
        restoreBtn.disabled = false;
        return;
      }

      const result = await this.backupManager.restore();
      if (result.success) {
        if (result.action === 'no_backup') {
          Toast.show('云端无备份数据', 'info');
        } else {
          Toast.show('恢复完成！页面即将刷新...', 'success');
          setTimeout(() => {
            location.reload();
          }, 1500);
        }
      }
    } catch (err) {
      Toast.show('恢复失败: ' + err.message, 'error');
    } finally {
      if (restoreBtn.textContent === '📥 恢复中...') {
        restoreBtn.textContent = originalText;
        restoreBtn.disabled = false;
      }
    }
  }

  /**
   * 更新设置面板中的备份信息显示
   */
  updateBackupStatusDisplay() {
    const stats = this.backupManager.getBackupStats();

    // 更新设置面板中的信息
    const lastTimeEl = document.getElementById('backupLastTime');
    if (lastTimeEl && stats.lastBackupTime) {
      lastTimeEl.textContent = '上次备份: ' + new Date(stats.lastBackupTime).toLocaleString('zh-CN');
    } else if (lastTimeEl) {
      lastTimeEl.textContent = '';
    }
  }

  /**
   * 显示备份结果
   */
  showBackupResult(message, isSuccess = true) {
    const resultEl = document.getElementById('backupTestResult');
    if (resultEl) {
      resultEl.textContent = (isSuccess ? '✅ ' : '❌ ') + message;
      resultEl.className = 'test-result ' + (isSuccess ? 'success' : 'error');
    }
  }
}
