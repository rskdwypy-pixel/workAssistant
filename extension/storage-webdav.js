// ==================== WebDAV 存储适配器（按日期分文件存储）====================

/**
 * WebDAV 存储适配器
 * 支持坚果云、NextCloud、iCloud 等 WebDAV 服务
 * 按日期分文件存储，方便查找和历史回溯
 *
 * 存储结构：
 * workassistant/
 * ├── index.json          # 索引文件，记录所有日期
 * ├── 2026-02-28.json     # 今日数据
 * ├── 2026-02-27.json     # 历史数据
 * └── ...
 */
class WebDAVStorage {
  constructor(config) {
    this.url = config.url;
    this.username = config.username;
    this.password = config.password;
    this.dirname = config.dirname || 'workassistant';
    this.indexFilename = 'index.json';
  }

  /**
   * 获取认证头
   */
  getAuthHeader() {
    return 'Basic ' + btoa(this.username + ':' + this.password);
  }

  /**
   * 获取基础URL（确保以/结尾）
   */
  getBaseUrl() {
    return this.url.endsWith('/') ? this.url : this.url + '/';
  }

  /**
   * 获取工作目录URL
   */
  getWorkDirUrl() {
    const baseUrl = this.getBaseUrl();
    return baseUrl + this.dirname + '/';
  }

  /**
   * 获取索引文件URL
   */
  getIndexUrl() {
    return this.getWorkDirUrl() + this.indexFilename;
  }

  /**
   * 获取指定日期的文件URL
   */
  getDateFileUrl(date) {
    return this.getWorkDirUrl() + date + '.json';
  }

  /**
   * 获取今天的日期字符串 (YYYY-MM-DD)
   */
  getTodayDate() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /**
   * 通用请求方法
   */
  async fetch(url, options = {}) {
    const headers = {
      'Authorization': this.getAuthHeader(),
      ...options.headers
    };

    const response = await fetch(url, { ...options, headers });
    return response;
  }

  /**
   * 创建工作目录（如果不存在）
   */
  async ensureWorkDirExists() {
    const dirUrl = this.getWorkDirUrl();

    const response = await this.fetch(dirUrl, {
      method: 'MKCOL'
    });

    // 201 Created 或 405 Method Not Allowed（目录已存在）都是成功的
    return response.status === 201 || response.status === 405;
  }

  /**
   * 读取索引文件
   */
  async readIndex() {
    const url = this.getIndexUrl();
    const response = await this.fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });

    if (response.status === 404 || response.status === 409) {
      // 索引文件不存在，返回空索引
      return { dates: [], lastUpdated: null };
    }

    if (!response.ok) {
      throw new Error(`读取索引失败: ${response.status} ${response.statusText}`);
    }

    const text = await response.text();
    if (!text) {
      return { dates: [], lastUpdated: null };
    }

    try {
      return JSON.parse(text);
    } catch (err) {
      console.warn('索引文件格式错误，重置索引');
      return { dates: [], lastUpdated: null };
    }
  }

  /**
   * 写入索引文件
   */
  async writeIndex(index) {
    const url = this.getIndexUrl();

    const response = await this.fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(index, null, 2)
    });

    if (!response.ok) {
      throw new Error(`写入索引失败: ${response.status} ${response.statusText}`);
    }

    return true;
  }

  /**
   * 读取指定日期的数据
   */
  async readDateFile(date) {
    const url = this.getDateFileUrl(date);
    const response = await this.fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });

    if (response.status === 404 || response.status === 409) {
      return null;
    }

    if (!response.ok) {
      console.warn(`读取 ${date} 数据失败: ${response.status}`);
      return null;
    }

    const text = await response.text();
    if (!text) {
      return null;
    }

    try {
      return JSON.parse(text);
    } catch (err) {
      console.warn(`${date} 数据格式错误`);
      return null;
    }
  }

  /**
   * 写入指定日期的数据
   */
  async writeDateFile(date, tasks) {
    const url = this.getDateFileUrl(date);

    const data = {
      date: date,
      tasks: tasks,
      lastUpdated: new Date().toISOString()
    };

    const response = await this.fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data, null, 2)
    });

    if (!response.ok) {
      throw new Error(`写入 ${date} 数据失败: ${response.status} ${response.statusText}`);
    }

    return true;
  }

  /**
   * 读取云端同步数据（合并所有日期的数据）
   */
  async read() {
    try {
      // 先确保工作目录存在
      await this.ensureWorkDirExists();

      // 读取索引文件
      const index = await this.readIndex();

      if (!index.dates || index.dates.length === 0) {
        return null;
      }

      // 合并所有日期的数据
      const allTasks = [];
      let latestTimestamp = null;

      for (const date of index.dates) {
        const dateData = await this.readDateFile(date);
        if (dateData && dateData.tasks) {
          allTasks.push(...dateData.tasks);
          if (dateData.lastUpdated) {
            if (!latestTimestamp || new Date(dateData.lastUpdated) > new Date(latestTimestamp)) {
              latestTimestamp = dateData.lastUpdated;
            }
          }
        }
      }

      // 去重（基于ID，保留最新的）
      const taskMap = new Map();
      for (const task of allTasks) {
        if (task.id) {
          const existing = taskMap.get(task.id);
          if (!existing || new Date(task.updatedAt) > new Date(existing.updatedAt)) {
            taskMap.set(task.id, task);
          }
        }
      }

      const deduplicatedTasks = Array.from(taskMap.values());

      return {
        tasks: deduplicatedTasks,
        timestamp: latestTimestamp,
        dates: index.dates
      };
    } catch (err) {
      // 如果是首次使用，返回 null
      if (err.message.includes('404') || err.message.includes('409')) {
        return null;
      }
      throw err;
    }
  }

  /**
   * 写入云端同步数据（按今天的日期存储）
   */
  async write(data) {
    // 先确保工作目录存在
    await this.ensureWorkDirExists();

    const today = this.getTodayDate();

    // 读取当前索引
    let index = await this.readIndex();

    // 更新索引
    if (!index.dates) {
      index.dates = [];
    }

    // 将今天的日期添加到索引（如果不存在）
    if (!index.dates.includes(today)) {
      index.dates.unshift(today);
    }

    // 保留最近 90 天的数据索引
    const maxDays = 90;
    if (index.dates.length > maxDays) {
      index.dates = index.dates.slice(0, maxDays);
    }

    index.lastUpdated = new Date().toISOString();

    // 写入今天的数据
    await this.writeDateFile(today, data.tasks || data);

    // 更新索引文件
    await this.writeIndex(index);

    return true;
  }

  /**
   * 检查连接状态
   */
  async checkConnection() {
    try {
      // 使用 PROPFIND 请求来验证连接（坚果云等 WebDAV 服务推荐方式）
      const baseUrl = this.getBaseUrl();

      const response = await this.fetch(baseUrl, {
        method: 'PROPFIND',
        headers: { 'Depth': '0' }
      });

      // 207 Multi-Status 是 WebDAV PROPFIND 的成功响应
      if (response.status === 207 || response.status === 200 || response.status === 404) {
        return { success: true, message: '连接成功' };
      }

      // 如果 PROPFIND 不支持，尝试 GET 请求
      if (response.status === 405 || response.status === 409) {
        const getResponse = await this.fetch(this.getWorkDirUrl(), {
          method: 'GET'
        });

        if (getResponse.status === 404 || getResponse.ok) {
          return { success: true, message: '连接成功' };
        }
        throw new Error(`认证失败: ${getResponse.status}`);
      }

      throw new Error(`认证失败: ${response.status} ${response.statusText}`);
    } catch (err) {
      return { success: false, message: err.message || '连接失败，请检查网络和配置' };
    }
  }

  /**
   * 删除云端文件（指定日期）
   */
  async deleteDate(date) {
    const url = this.getDateFileUrl(date);

    const response = await this.fetch(url, {
      method: 'DELETE'
    });

    if (response.status === 404) {
      return true;
    }

    if (!response.ok) {
      throw new Error(`删除 ${date} 数据失败: ${response.status} ${response.statusText}`);
    }

    // 更新索引
    const index = await this.readIndex();
    index.dates = index.dates.filter(d => d !== date);
    await this.writeIndex(index);

    return true;
  }

  /**
   * 获取所有可用的日期列表
   */
  async getAvailableDates() {
    const index = await this.readIndex();
    return index.dates || [];
  }

  /**
   * 获取指定日期的数据
   */
  async getDataByDate(date) {
    await this.ensureWorkDirExists();
    const dateData = await this.readDateFile(date);
    return dateData ? dateData.tasks : null;
  }
}

/**
 * 坚果云配置帮助
 */
const JianguoyunHelper = {
  name: '坚果云',
  webdavUrl: 'https://dav.jianguoyun.com/dav/',
  instructions: `
    <h4>坚果云 WebDAV 配置步骤：</h4>
    <ol>
      <li>登录坚果云网页版</li>
      <li>点击右上角头像 → 账户信息</li>
      <li>找到「安全选项」</li>
      <li>勾选「启用第三方应用管理」</li>
      <li>点击「生成应用密码」</li>
      <li>使用生成的密码（非登录密码）进行配置</li>
    </ol>
    <p class="hint">⚠️ 请勿使用坚果云登录密码，必须使用应用密码！</p>
    <p class="info">💾 数据按日期分文件存储在 workassistant 目录下</p>
  `
};

/**
 * iCloud 配置帮助
 */
const iCloudHelper = {
  name: 'iCloud',
  webdavUrl: 'https://dav.icloud.com/',
  instructions: `
    <h4>iCloud WebDAV 配置步骤：</h4>
    <ol>
      <li>打开 iPhone 设置 → 你的名字 → iCloud</li>
      <li>开启「iCloud 云盘」</li>
      <li>在 Mac 上打开 Finder → 网络位置</li>
      <li>连接到服务器后获取 WebDAV 地址</li>
    </ol>
    <p class="hint">⚠️ 需要开启 Apple 两步验证并生成应用专用密码。</p>
  `
};
