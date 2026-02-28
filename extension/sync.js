// ==================== 数据同步核心模块 ====================

/**
 * 同步管理器 - 处理数据同步的核心逻辑
 */
class SyncManager {
  constructor() {
    this.apiBaseUrl = 'http://localhost:3721';
    this.storage = null;
    this.isSyncing = false;
    this.lastSyncTime = null;
    this.deviceId = this.getOrCreateDeviceId();
    this.syncConfig = this.loadSyncConfig();
    this.debouncedUploadTimer = null;
  }

  /**
   * 获取或创建设备ID
   */
  getOrCreateDeviceId() {
    let deviceId = localStorage.getItem('workassistant_device_id');
    if (!deviceId) {
      deviceId = 'device_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      localStorage.setItem('workassistant_device_id', deviceId);
    }
    return deviceId;
  }

  /**
   * 加载同步配置
   */
  loadSyncConfig() {
    const config = localStorage.getItem('workassistant_sync_config');
    const defaultConfig = {
      enabled: false,
      type: 'webdav',
      webdav: {
        url: 'https://dav.jianguoyun.com/dav/',
        username: '',
        password: '',
        dirname: 'workassistant'
      },
      autoSync: true,
      syncInterval: 300000 // 5分钟
    };

    if (config) {
      const parsed = JSON.parse(config);
      // 兼容旧配置
      if (parsed.webdav && parsed.webdav.filename) {
        // 旧配置有 filename，删除它，使用新的 dirname
        delete parsed.webdav.filename;
      }
      return { ...defaultConfig, ...parsed };
    }
    return defaultConfig;
  }

  /**
   * 保存同步配置
   */
  saveSyncConfig(config) {
    this.syncConfig = { ...this.syncConfig, ...config };
    localStorage.setItem('workassistant_sync_config', JSON.stringify(this.syncConfig));
  }

  /**
   * 初始化同步管理器
   */
  async init() {
    if (!this.syncConfig.enabled) {
      console.log('[Sync] 同步未启用');
      return;
    }

    // 加载存储适配器
    await this.loadStorageAdapter();

    // 不再启动时自动下载，避免触发浏览器登录对话框
    // 用户可以手动点击"立即同步"按钮来同步
    console.log('[Sync] 同步已就绪，可手动同步');
  }

  /**
   * 加载存储适配器
   */
  async loadStorageAdapter() {
    if (typeof WebDAVStorage === 'undefined') {
      console.warn('[Sync] WebDAVStorage 未加载，等待加载...');
      return;
    }

    if (this.syncConfig.type === 'webdav') {
      this.storage = new WebDAVStorage({
        url: this.syncConfig.webdav.url,
        username: this.syncConfig.webdav.username,
        password: this.syncConfig.webdav.password,
        dirname: this.syncConfig.webdav.dirname || 'workassistant'
      });
    }
  }

  /**
   * 更新存储配置
   */
  async updateStorageConfig(config) {
    this.saveSyncConfig(config);
    await this.loadStorageAdapter();
  }

  /**
   * 从本地后端导出数据
   */
  async exportLocalData() {
    const response = await fetch(`${this.apiBaseUrl}/api/sync/export`);
    if (!response.ok) {
      throw new Error('导出本地数据失败');
    }
    const result = await response.json();
    return result.data;
  }

  /**
   * 导入数据到本地后端
   */
  async importToLocal(data) {
    const response = await fetch(`${this.apiBaseUrl}/api/sync/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!response.ok) {
      throw new Error('导入数据失败');
    }
    const result = await response.json();
    return result.data;
  }

  /**
   * 上传本地数据到云端
   */
  async upload() {
    if (!this.storage || !this.syncConfig.enabled || this.isSyncing) {
      return;
    }

    this.isSyncing = true;
    console.log('[Sync] 开始上传数据...');

    try {
      // 1. 导出本地数据
      const localData = await this.exportLocalData();

      // 2. 检查云端是否有更新的数据
      const remoteData = await this.storage.read();
      if (remoteData && remoteData.timestamp) {
        const remoteTime = new Date(remoteData.timestamp);
        const localTime = new Date(localData.timestamp);

        if (remoteTime > localTime) {
          console.log('[Sync] 云端数据更新，先下载再上传');
          await this.mergeAndSync(localData, remoteData);
          return;
        }
      }

      // 3. 生成同步包
      const syncPackage = {
        version: '1.0',
        deviceId: this.deviceId,
        timestamp: new Date().toISOString(),
        tasks: localData.tasks,
        history: localData.history,
        checksum: localData.checksum
      };

      // 4. 上传到云端
      await this.storage.write(syncPackage);

      this.lastSyncTime = new Date();
      localStorage.setItem('workassistant_last_sync', this.lastSyncTime.toISOString());

      console.log('[Sync] 上传完成');
      return { success: true, action: 'uploaded' };
    } catch (err) {
      console.error('[Sync] 上传失败:', err);
      throw err;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * 从云端下载数据
   */
  async download() {
    if (!this.storage || !this.syncConfig.enabled || this.isSyncing) {
      return;
    }

    this.isSyncing = true;
    console.log('[Sync] 开始下载数据...');

    try {
      // 1. 读取云端数据
      const remoteData = await this.storage.read();
      if (!remoteData) {
        console.log('[Sync] 云端无数据');
        return { success: true, action: 'no_remote_data' };
      }

      // 2. 导出本地数据
      const localData = await this.exportLocalData();

      // 3. 合并同步
      await this.mergeAndSync(localData, remoteData);

      this.lastSyncTime = new Date();
      localStorage.setItem('workassistant_last_sync', this.lastSyncTime.toISOString());

      console.log('[Sync] 下载完成');
      return { success: true, action: 'downloaded' };
    } catch (err) {
      console.error('[Sync] 下载失败:', err);
      throw err;
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * 合并本地和远程数据
   */
  async mergeAndSync(localData, remoteData) {
    // 使用后端的智能合并功能
    const result = await this.importToLocal({
      tasks: remoteData.tasks || [],
      history: remoteData.history || [],
      checksum: remoteData.checksum
    });

    // 合并后重新上传（确保云端有完整数据）
    const mergedData = await this.exportLocalData();
    const syncPackage = {
      version: '1.0',
      deviceId: this.deviceId,
      timestamp: new Date().toISOString(),
      tasks: mergedData.tasks,
      history: mergedData.history,
      checksum: mergedData.checksum
    };
    await this.storage.write(syncPackage);

    return result;
  }

  /**
   * 启动时自动下载
   */
  async downloadOnStartup() {
    try {
      await this.download();
    } catch (err) {
      console.warn('[Sync] 启动同步失败（可能是离线）:', err.message);
    }
  }

  /**
   * 防抖上传（数据变更后调用）
   */
  debouncedUpload() {
    if (this.debouncedUploadTimer) {
      clearTimeout(this.debouncedUploadTimer);
    }
    this.debouncedUploadTimer = setTimeout(() => {
      this.upload().catch(err => {
        console.warn('[Sync] 自动上传失败:', err.message);
      });
    }, 3000); // 3秒防抖
  }

  /**
   * 手动触发同步
   */
  async syncNow() {
    if (!this.storage || !this.syncConfig.enabled) {
      throw new Error('同步未配置或未启用');
    }

    if (this.isSyncing) {
      throw new Error('同步正在进行中');
    }

    try {
      // 先尝试下载，再上传
      await this.download();
      await this.upload();
      return { success: true, action: 'synced' };
    } catch (err) {
      throw err;
    }
  }

  /**
   * 获取同步状态
   */
  getSyncStatus() {
    return {
      enabled: this.syncConfig.enabled,
      configured: !!(this.syncConfig.webdav.url && this.syncConfig.webdav.username && this.syncConfig.webdav.password),
      lastSync: this.lastSyncTime || localStorage.getItem('workassistant_last_sync'),
      isSyncing: this.isSyncing,
      deviceId: this.deviceId
    };
  }

  /**
   * 测试连接
   */
  async testConnection() {
    if (!this.storage) {
      throw new Error('存储适配器未加载');
    }
    return await this.storage.checkConnection();
  }
}

// 创建全局实例
const syncManager = new SyncManager();
