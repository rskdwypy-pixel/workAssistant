// ==================== 备份管理器 ====================

/**
 * 备份管理器 - 备份所有非禅道数据到坚果云
 *
 * 备份内容：
 * 1. 配置文件（AI、Webhook、提醒时间等）
 * 2. 历史报告（日汇总、周汇总、月汇总）
 * 3. 本地任务（排除已同步到禅道的）
 * 4. 草稿数据
 * 5. 用户偏好设置
 *
 * 不备份：
 * - 禅道会话令牌（会重新生成）
 * - 已有 zentaoId 的任务和Bug（已在禅道中）
 */
class BackupManager {
  constructor() {
    this.apiBaseUrl = 'http://localhost:3721';
    this.storage = null;
    this.isBackingUp = false;
    this.deviceId = this.getOrCreateDeviceId();
    this.backupConfig = this.loadBackupConfig();
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
   * 加载备份配置
   */
  loadBackupConfig() {
    const config = localStorage.getItem('workassistant_backup_config');
    const defaultConfig = {
      enabled: false,
      webdav: {
        url: 'https://dav.jianguoyun.com/dav/',
        username: '',
        password: '',
        dirname: 'workassistant_backup'
      },
      autoBackup: true,
      backupInterval: 3600000, // 1小时
      lastBackupTime: null
    };

    if (config) {
      return { ...defaultConfig, ...JSON.parse(config) };
    }
    return defaultConfig;
  }

  /**
   * 保存备份配置
   */
  saveBackupConfig(config) {
    this.backupConfig = { ...this.backupConfig, ...config };
    localStorage.setItem('workassistant_backup_config', JSON.stringify(this.backupConfig));
  }

  /**
   * 初始化备份管理器
   */
  async init() {
    if (!this.backupConfig.enabled) {
      console.log('[Backup] 备份未启用');
      return;
    }

    await this.loadStorageAdapter();
    console.log('[Backup] 备份已就绪');
  }

  /**
   * 加载存储适配器
   */
  async loadStorageAdapter() {
    if (typeof WebDAVStorage === 'undefined') {
      console.warn('[Backup] WebDAVStorage 未加载');
      return;
    }

    this.storage = new WebDAVStorage({
      url: this.backupConfig.webdav.url,
      username: this.backupConfig.webdav.username,
      password: this.backupConfig.webdav.password,
      dirname: this.backupConfig.webdav.dirname || 'workassistant_backup'
    });
  }

  /**
   * 生成简单的校验和（浏览器兼容）
   */
  generateChecksum(dataStr) {
    // 使用简单的字符串哈希算法（FNV-1a 32-bit）
    let hash = 2166136261;
    for (let i = 0; i < dataStr.length; i++) {
      hash ^= dataStr.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(16);
  }

  /**
   * 导出所有需要备份的数据
   */
  async exportAllData() {
    try {
      // 1. 从后端获取任务数据（过滤掉已同步到禅道的）
      const tasksResponse = await fetch(`${this.apiBaseUrl}/api/tasks?all=true`);
      const tasksResult = await tasksResponse.json();

      // 过滤掉有 zentaoId 的任务（这些已在禅道中）
      const localTasks = (tasksResult.data || []).filter(task => !task.zentaoId);

      // 2. 获取历史报告
      const historyResponse = await fetch(`${this.apiBaseUrl}/api/history?limit=1000`);
      const historyResult = await historyResponse.json();

      // 3. 收集 localStorage 中的配置和偏好设置
      const localData = this.exportLocalStorageData();

      // 4. 生成备份包
      const backupPackage = {
        version: '2.0',
        type: 'backup',
        deviceId: this.deviceId,
        timestamp: new Date().toISOString(),
        data: {
          tasks: localTasks,
          history: historyResult.data || [],
          config: localData.config,
          preferences: localData.preferences,
          drafts: localData.drafts
        },
        checksum: null // 将在下面生成
      };

      // 5. 生成校验和（浏览器兼容方式）
      const dataStr = JSON.stringify(backupPackage);
      backupPackage.checksum = this.generateChecksum(dataStr);

      return backupPackage;
    } catch (err) {
      console.error('[Backup] 导出数据失败:', err);
      throw err;
    }
  }

  /**
   * 导出 localStorage 中的数据
   */
  exportLocalStorageData() {
    const data = {
      config: {},
      preferences: {},
      drafts: {}
    };

    // 配置数据
    const configKeys = [
      'workAssistantConfig',
      'workassistant_sync_config',
      'workassistant_backup_config'
    ];

    configKeys.forEach(key => {
      const value = localStorage.getItem(key);
      if (value) {
        try {
          data.config[key] = JSON.parse(value);
        } catch {
          data.config[key] = value;
        }
      }
    });

    // 用户偏好设置
    const preferenceKeys = [
      'lastTabMode',
      'debugMode'
    ];

    preferenceKeys.forEach(key => {
      const value = localStorage.getItem(key);
      if (value !== null) {
        data.preferences[key] = value;
      }
    });

    // 草稿数据
    const draftKeys = [
      'bug_draft'
    ];

    draftKeys.forEach(key => {
      const value = localStorage.getItem(key);
      if (value) {
        try {
          data.drafts[key] = JSON.parse(value);
        } catch {
          data.drafts[key] = value;
        }
      }
    });

    return data;
  }

  /**
   * 备份数据到云端
   */
  async backup() {
    if (!this.storage || !this.backupConfig.enabled || this.isBackingUp) {
      return;
    }

    this.isBackingUp = true;
    console.log('[Backup] ========== 开始备份数据 ==========');

    try {
      // 1. 导出所有数据
      console.log('[Backup] 正在导出本地数据...');
      const backupPackage = await this.exportAllData();
      console.log('[Backup] 导出完成:');
      console.log(`  - 任务: ${backupPackage.data.tasks.length} 个`);
      console.log(`  - 报告: ${backupPackage.data.history.length} 个`);
      console.log(`  - 配置项: ${Object.keys(backupPackage.data.config).length} 个`);
      console.log(`  - 偏好设置: ${Object.keys(backupPackage.data.preferences).length} 个`);
      console.log(`  - 草稿: ${Object.keys(backupPackage.data.drafts).length} 个`);

      // 2. 上传到云端
      console.log('[Backup] 正在上传到云端...');
      await this.storage.write(backupPackage);

      // 3. 更新最后备份时间
      this.backupConfig.lastBackupTime = new Date().toISOString();
      this.saveBackupConfig({ lastBackupTime: this.backupConfig.lastBackupTime });

      console.log('[Backup] ========== 备份完成 ==========');
      return {
        success: true,
        timestamp: backupPackage.timestamp,
        stats: {
          tasks: backupPackage.data.tasks.length,
          history: backupPackage.data.history.length,
          configSize: JSON.stringify(backupPackage.data.config).length
        }
      };
    } catch (err) {
      console.error('[Backup] ========== 备份失败 ==========');
      console.error('[Backup] 错误:', err.message);
      throw err;
    } finally {
      this.isBackingUp = false;
    }
  }

  /**
   * 从云端恢复数据
   */
  async restore() {
    if (!this.storage || !this.backupConfig.enabled || this.isBackingUp) {
      return;
    }

    this.isBackingUp = true;
    console.log('[Backup] 开始恢复数据...');

    try {
      // 1. 从云端读取备份
      const remoteData = await this.storage.read();
      if (!remoteData) {
        console.log('[Backup] 云端无备份数据');
        return { success: true, action: 'no_backup' };
      }

      // 2. 验证备份类型（只恢复 v2.0 的备份）
      if (remoteData.version !== '2.0' || remoteData.type !== 'backup') {
        throw new Error('不兼容的备份版本');
      }

      // 3. 恢复数据到后端
      await this.restoreDataToBackend(remoteData.data);

      // 4. 恢复 localStorage 数据
      this.restoreLocalStorageData(remoteData.data);

      console.log('[Backup] 恢复完成');
      return { success: true, action: 'restored', timestamp: remoteData.timestamp };
    } catch (err) {
      console.error('[Backup] 恢复失败:', err);
      throw err;
    } finally {
      this.isBackingUp = false;
    }
  }

  /**
   * 恢复数据到后端
   */
  async restoreDataToBackend(data) {
    // 1. 恢复任务（逐个添加或更新）
    if (data.tasks && data.tasks.length > 0) {
      for (const task of data.tasks) {
        try {
          await fetch(`${this.apiBaseUrl}/api/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(task)
          });
        } catch (err) {
          console.error('[Backup] 恢复任务失败:', task.id, err);
        }
      }
    }

    // 2. 恢复历史报告（直接写入）
    if (data.history && data.history.length > 0) {
      try {
        await fetch(`${this.apiBaseUrl}/api/history/restore`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ history: data.history })
        });
      } catch (err) {
        console.error('[Backup] 恢复历史报告失败:', err);
        // 历史报告恢复失败不影响整体恢复
      }
    }
  }

  /**
   * 恢复 localStorage 数据
   */
  restoreLocalStorageData(data) {
    // 恢复配置
    if (data.config) {
      Object.keys(data.config).forEach(key => {
        const value = data.config[key];
        if (typeof value === 'object') {
          localStorage.setItem(key, JSON.stringify(value));
        } else {
          localStorage.setItem(key, value);
        }
      });
    }

    // 恢复偏好设置
    if (data.preferences) {
      Object.keys(data.preferences).forEach(key => {
        localStorage.setItem(key, data.preferences[key]);
      });
    }

    // 恢复草稿
    if (data.drafts) {
      Object.keys(data.drafts).forEach(key => {
        const value = data.drafts[key];
        if (typeof value === 'object') {
          localStorage.setItem(key, JSON.stringify(value));
        } else {
          localStorage.setItem(key, value);
        }
      });
    }
  }

  /**
   * 检查连接状态
   */
  async checkConnection() {
    if (!this.storage) {
      return { success: false, message: '存储未初始化' };
    }

    return await this.storage.checkConnection();
  }

  /**
   * 获取备份统计信息
   */
  getBackupStats() {
    return {
      enabled: this.backupConfig.enabled,
      lastBackupTime: this.backupConfig.lastBackupTime,
      deviceId: this.deviceId,
      autoBackup: this.backupConfig.autoBackup,
      backupInterval: this.backupConfig.backupInterval
    };
  }
}

// 创建全局备份管理器实例
const backupManager = new BackupManager();
