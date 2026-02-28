import { config } from '../config.js';

/**
 * 禅道 API 服务
 * 支持自动登录和会话管理
 * 禅道开源版 API 文档: https://www.zentao.net/book/api/zentao-1142.html
 */

// 禅道 API 端点常量（开源版使用 .json 后缀）
const API_ENDPOINTS = {
  LOGIN: '/zentao/user-login.json',
  USER: '/zentao/user.json',
  PROJECTS: '/zentao/project.json',
  PROJECT_STAGES: '/zentao/project-build',
  TASKS: '/zentao/task-create.json',
  TASK: '/zentao/task.json',
  EFFORT: '/zentao/effort-create.json',
  BUILD: '/zentao/build.json'
};

class ZentaoClient {
  constructor() {
    this.session = null;           // 存储 session
    this.sessionExpiry = null;     // session 过期时间
    this.lastLoginTime = null;     // 上次登录时间
  }

  // 获取最新配置（使用动态 import）
  getConfig() {
    // 由于这是 getter，不能使用 import，直接返回当前配置
    return config.zentao || {};
  }

  /**
   * 获取完整 URL
   */
  getUrl(path) {
    const baseUrl = this.getConfig().url?.replace(/\/$/, '') || '';
    return `${baseUrl}${path}`;
  }

  /**
   * 解析响应中的 session
   * 禅道使用多个 Cookie 存储 session，需要提取所有
   */
  extractSession(response) {
    // 获取所有的 Set-Cookie 头（可能有多行）
    const cookies = [];

    // 解析 Set-Cookie 头
    const getAllCookies = (headers) => {
      const cookieHeader = headers.get('set-cookie');
      if (!cookieHeader) return [];

      // Set-Cookie 可能是字符串（单个）或数组（多个）
      const headerArray = Array.isArray(cookieHeader) ? cookieHeader : [cookieHeader];

      const cookies = [];
      headerArray.forEach(header => {
        // 提取 cookie 名称和值（在第一个分号之前）
        const match = header.match(/^([^=]+)=([^;]+)/);
        if (match) {
          cookies.push(`${match[1]}=${match[2]}`);
        }
      });

      return cookies;
    };

    const extractedCookies = getAllCookies(response.headers);

    if (extractedCookies.length > 0) {
      console.log(`[Zentao] 提取到 ${extractedCookies.length} 个 Cookie:`, extractedCookies);
      // 返回所有 Cookie 用分号分隔
      return extractedCookies.join('; ');
    }

    return null;
  }

  /**
   * 发起请求并处理会话
   */
  async fetchWithSession(endpoint, options = {}) {
    const url = this.getUrl(endpoint);

    // 添加 Cookie 头
    const headers = {
      ...options.headers,
      'Content-Type': options.headers?.['Content-Type'] || 'application/json'
    };

    if (this.session) {
      headers['Cookie'] = this.session;
    }

    console.log(`[Zentao] 请求: ${options.method || 'GET'} ${endpoint}`);

    const response = await fetch(url, {
      ...options,
      headers
    });

    // 更新 session（如果有新的 Set-Cookie）
    const newSession = this.extractSession(response);
    if (newSession && newSession !== this.session) {
      console.log('[Zentao] Session 已更新');
      this.session = newSession;
    }

    return response;
  }

  /**
   * 验证当前 session 是否有效
   */
  async validate() {
    if (!this.session) {
      console.log('[Zentao] 无 session，需要登录');
      return false;
    }

    try {
      console.log('[Zentao] 验证 session 有效性...');
      const response = await this.fetchWithSession(API_ENDPOINTS.USER);

      if (response.ok) {
        const text = await response.text();
        // 禅道返回 HTML 表示需要重新登录，返回 JSON 表示已登录
        if (text.startsWith('{')) {
          const data = JSON.parse(text);
          if (data && (data.user || data.status === 'success')) {
            console.log(`[Zentao] Session 有效`);
            return true;
          }
        }
      }

      console.log('[Zentao] Session 无效或已过期');
      return false;
    } catch (err) {
      console.error('[Zentao] 验证 session 失败:', err.message);
      return false;
    }
  }

  /**
   * 登录禅道
   */
  async login() {
    if (!this.getConfig().url || !this.getConfig().username || !this.getConfig().password) {
      throw new Error('禅道配置不完整，请检查配置');
    }

    console.log(`[Zentao] 开始登录，用户: ${this.getConfig().username}`);
    console.log(`[Zentao] 登录 URL: ${this.getUrl(API_ENDPOINTS.LOGIN)}`);

    try {
      // 禅道使用表单编码
      const params = new URLSearchParams();
      params.append('account', this.getConfig().username);
      params.append('password', this.getConfig().password);

      const response = await this.fetchWithSession(API_ENDPOINTS.LOGIN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params
      });

      const text = await response.text();
      console.log('[Zentao] 登录响应状态:', response.status);
      console.log('[Zentao] 登录响应内容（前500字符）:', text.substring(0, 500));

      if (!response.ok) {
        console.error('[Zentao] 登录失败，响应:', text);
        throw new Error(`登录失败: ${response.status}`);
      }

      // 尝试解析 JSON
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        console.error('[Zentao] 无法解析 JSON 响应:', text);
        throw new Error('登录失败: 无效的响应格式');
      }

      console.log('[Zentao] 登录响应数据:', data);

      // 保存 session（从 Cookie）
      const session = this.extractSession(response);
      if (session) {
        this.session = session;
        console.log('[Zentao] Session 已保存');
      }

      // 检查登录结果（禅道返回格式: { status: 'success', user: {...} }）
      if (data.status === 'success' || data.user) {
        console.log('[Zentao] 登录成功');
        this.lastLoginTime = Date.now();
        return true;
      } else {
        console.error('[Zentao] 登录返回失败状态:', data);
        throw new Error('登录失败: ' + (data.reason || data.msg || '未知错误'));
      }
    } catch (err) {
      console.error('[Zentao] 登录异常:', err.message);
      throw err;
    }
  }

  /**
   * 确保已登录（每次 API 调用前调用）
   */
  async ensureLoggedIn() {
    // 如果未启用禅道，直接返回
    if (!this.getConfig().enabled) {
      console.log('[Zentao] 禅道同步未启用');
      return false;
    }

    // 验证当前 session
    if (this.session && await this.validate()) {
      return true;
    }

    // session 无效，重新登录
    console.log('[Zentao] Session 无效，重新登录...');
    await this.login();
    return true;
  }

  /**
   * 测试连接
   */
  async testConnection() {
    try {
      console.log('[Zentao] 测试连接...');

      // 先尝试登录
      await this.login();

      // 验证登录状态
      const isValid = await this.validate();

      if (isValid) {
        console.log('[Zentao] 连接测试成功');
        return { success: true, message: '连接成功' };
      } else {
        console.log('[Zentao] 连接测试失败');
        return { success: false, message: '连接失败' };
      }
    } catch (err) {
      console.error('[Zentao] 测试连接失败:', err.message);
      return { success: false, message: err.message };
    }
  }

  /**
   * 获取项目列表
   */
  async getProjects() {
    await this.ensureLoggedIn();

    try {
      console.log('[Zentao] 获取项目列表...');
      const response = await this.fetchWithSession(API_ENDPOINTS.PROJECTS);

      if (!response.ok) {
        const text = await response.text();
        console.error('[Zentao] 获取项目列表失败响应:', text);
        throw new Error(`获取项目列表失败: ${response.status}`);
      }

      const text = await response.text();
      console.log('[Zentao] 项目列表响应（前500字符）:', text.substring(0, 500));

      const data = JSON.parse(text);

      // 检查是否是重定向响应（session过期）- 禅道返回的 data 可能是 JSON 字符串
      let parsedData = data;
      if (data.data && typeof data.data === 'string') {
        try {
          parsedData = JSON.parse(data.data);
        } catch (e) {
          console.warn('[Zentao] 无法解析 data.data 字符串');
        }
      }

      if (parsedData.locate || data.locate) {
        console.log('[Zentao] 检测到重定向响应，session可能已过期，重新登录...');
        await this.login();
        // 重试一次
        const retryResponse = await this.fetchWithSession(API_ENDPOINTS.PROJECTS);
        if (!retryResponse.ok) {
          throw new Error(`重试后获取项目列表失败: ${retryResponse.status}`);
        }
        const retryText = await retryResponse.text();
        const retryData = JSON.parse(retryText);
        // 处理重试响应的 data 字符串
        let retryProjects = retryData.projects || [];
        if (retryData.data) {
          if (typeof retryData.data === 'string') {
            try {
              const parsed = JSON.parse(retryData.data);
              retryProjects = parsed.projects || [];
            } catch (e) {
              // 忽略解析错误
            }
          } else {
            retryProjects = retryData.data.projects || [];
          }
        }

        if (retryProjects && typeof retryProjects === 'object' && !Array.isArray(retryProjects)) {
          retryProjects = Object.keys(retryProjects).map(key => {
            const val = retryProjects[key];
            return typeof val === 'object' ? val : { id: key, name: val };
          });
        }
        if (!Array.isArray(retryProjects)) retryProjects = [];

        console.log(`[Zentao] 获取到 ${retryProjects.length} 个项目`);
        return retryProjects;
      }

      // 禅道返回格式: { projects: [...] } 或 { data: { projects: [...] } } 或直接是数组
      let projects = data.projects || [];
      if (data.data) {
        if (typeof data.data === 'string') {
          try {
            const parsed = JSON.parse(data.data);
            projects = parsed.projects || [];
          } catch (e) {
            console.warn('[Zentao] 无法解析 data.data 字符串');
          }
        } else {
          projects = data.data.projects || data.data || [];
        }
      }
      // 禅道可能返回对象 { "1": "项目A", "2": "项目B" }，需要转为数组
      if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
        projects = Object.keys(projects).map(key => {
          const val = projects[key];
          return typeof val === 'object' ? val : { id: key, name: val };
        });
      }

      if (!Array.isArray(projects)) {
        console.warn('[Zentao] 解析后 projects 仍然不是数组:', projects);
        projects = [];
      }

      console.log(`[Zentao] 获取到 ${projects.length} 个项目`);
      return projects;
    } catch (err) {
      console.error('[Zentao] 获取项目列表失败:', err.message);
      throw err;
    }
  }

  /**
   * 获取项目的阶段（瀑布流项目的阶段）
   */
  async getProjectStages(projectId) {
    await this.ensureLoggedIn();

    try {
      console.log(`[Zentao] 获取项目 ${projectId} 的阶段...`);

      // 禅道获取项目构建/阶段: /zentao/project-build-{projectId}.json
      const response = await this.fetchWithSession(`/zentao/project-build-${projectId}.json`);

      if (!response.ok) {
        const text = await response.text();
        console.error('[Zentao] 获取阶段失败响应:', text);
        throw new Error(`获取阶段失败: ${response.status}`);
      }

      const text = await response.text();
      const data = JSON.parse(text);

      // 检查是否是重定向响应（session过期）- 禅道返回的 data 可能是 JSON 字符串
      let parsedData = data;
      if (data.data && typeof data.data === 'string') {
        try {
          parsedData = JSON.parse(data.data);
        } catch (e) {
          console.warn('[Zentao] 无法解析 data.data 字符串');
        }
      }

      if (parsedData.locate || data.locate) {
        console.log('[Zentao] 检测到重定向响应，session可能已过期，重新登录...');
        await this.login();
        // 重试一次
        const retryResponse = await this.fetchWithSession(`/zentao/project-build-${projectId}.json`);
        if (!retryResponse.ok) {
          throw new Error(`重试后获取阶段失败: ${retryResponse.status}`);
        }
        const retryText = await retryResponse.text();
        const retryData = JSON.parse(retryText);
        let retryStages = retryData.builds || [];
        if (retryData.data) {
          if (typeof retryData.data === 'string') {
            try {
              const parsed = JSON.parse(retryData.data);
              retryStages = parsed.builds || [];
            } catch (e) {
              // 忽略解析错误
            }
          } else {
            retryStages = retryData.data.builds || [];
          }
        }

        if (retryStages && typeof retryStages === 'object' && !Array.isArray(retryStages)) {
          retryStages = Object.keys(retryStages).map(key => {
            const val = retryStages[key];
            return typeof val === 'object' ? val : { id: key, name: val };
          });
        }
        if (!Array.isArray(retryStages)) retryStages = [];

        console.log(`[Zentao] 获取到 ${retryStages.length} 个阶段`);
        return retryStages.map(s => ({
          id: s.id || s.build || String(s),
          name: s.name || s.title || (s.build ? `阶段 ${s.build}` : String(s))
        }));
      }

      // 禅道返回格式: { builds: [...] } 或 { data: { builds: [...] } } 或直接是数组
      let stages = data.builds || [];
      if (data.data) {
        if (typeof data.data === 'string') {
          try {
            const parsed = JSON.parse(data.data);
            stages = parsed.builds || [];
          } catch (e) {
            console.warn('[Zentao] 无法解析 data.data 字符串');
          }
        } else {
          stages = data.data.builds || data.data || [];
        }
      }

      if (stages && typeof stages === 'object' && !Array.isArray(stages)) {
        stages = Object.keys(stages).map(key => {
          const val = stages[key];
          return typeof val === 'object' ? val : { id: key, name: val };
        });
      }
      if (!Array.isArray(stages)) stages = [];

      console.log(`[Zentao] 获取到 ${stages.length} 个阶段`);

      // 转换格式，确保有 id 和 name 字段
      return stages.map(s => ({
        id: s.id || s.build || String(s),
        name: s.name || s.title || (s.build ? `阶段 ${s.build}` : String(s))
      }));
    } catch (err) {
      console.error('[Zentao] 获取项目阶段失败:', err.message);
      throw err;
    }
  }

  /**
   * 创建任务
   */
  async createTask(taskData) {
    await this.ensureLoggedIn();

    // 判断阶段
    const stageId = this.determineStageId(taskData.title);

    const payload = new URLSearchParams();
    // 依据用户抓包，实际提交到 execution 字段的不是总级的 projectId，而是具体执行的 stageId (如162)
    payload.append('execution', stageId || this.getConfig().projectId);
    payload.append('type', 'test'); // 用户抓包用的 test，可根据项目实际约定用 devel 或 test
    payload.append('module', '0');
    payload.append('assignedTo[]', this.getConfig().username || ''); // 自动指派给绑定的用户名
    payload.append('teamMember', '');
    payload.append('mode', 'linear');
    payload.append('status', 'wait');
    payload.append('story', '');
    payload.append('color', '');
    payload.append('name', taskData.title);
    payload.append('storyEstimate', '');
    payload.append('storyDesc', '');
    payload.append('storyPri', '');
    payload.append('pri', this.mapPriority(taskData.priority).toString());
    payload.append('estimate', '');
    payload.append('desc', taskData.content || taskData.title);
    payload.append('estStarted', '');
    payload.append('deadline', taskData.dueDate || '');
    payload.append('after', 'toTaskList');
    payload.append('uid', '69a286e9ac5b1'); // 模拟UID防止拦截（可为任意固定字符串或随机）

    console.log('[Zentao] 创建任务:', {
      title: taskData.title,
      stage: stageId === this.getConfig().pocStageId ? 'POC' : '交付',
      executionId: stageId || this.getConfig().projectId,
      deadline: taskData.dueDate
    });

    try {
      // 禅道开源版接口，路径中的 executionId 实际上是阶段ID（stageId）
      const targetExecutionId = stageId || this.getConfig().projectId;
      const endpoint = `/zentao/task-create-${targetExecutionId}-0-0.json`;

      const response = await this.fetchWithSession(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: payload
      });

      if (!response.ok) {
        const text = await response.text();
        console.error('[Zentao] 创建任务失败响应:', text);
        throw new Error(`创建任务失败: ${response.status}`);
      }

      const data = await response.json();

      if (data && data.id) {
        console.log(`[Zentao] 任务创建成功，ID: ${data.id}`);
        return { success: true, taskId: data.id, stageId };
      }

      console.error('[Zentao] 创建任务返回无效数据:', data);
      return { success: false, error: '无效响应' };
    } catch (err) {
      console.error('[Zentao] 创建任务异常:', err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * 确定任务所属阶段
   * 标题包含 "POC" 则为 POC 阶段，否则为交付阶段
   */
  determineStageId(title) {
    const hasPOC = /poc|poc|proof.?of.?concept/i.test(title);

    if (hasPOC && this.getConfig().pocStageId) {
      console.log(`[Zentao] 任务 "${title}" 归类为 POC 阶段`);
      return this.getConfig().pocStageId;
    }

    if (this.getConfig().deliveryStageId) {
      console.log(`[Zentao] 任务 "${title}" 归类为交付阶段`);
      return this.getConfig().deliveryStageId;
    }

    console.warn('[Zentao] 未配置阶段 ID，使用项目默认');
    return null;
  }

  /**
   * 映射优先级
   * 前端: 1=最高, 2=高, 3=中, 4=低
   * 禅道: 1=最高, 2=高, 3=中, 4=低
   */
  mapPriority(priority) {
    const p = priority ?? 3;
    return Math.max(1, Math.min(4, p));
  }

  /**
   * 添加工时记录
   */
  async addEffort(zentaoTaskId, effortData) {
    await this.ensureLoggedIn();

    const payload = {
      objectType: 'task',
      objectID: zentaoTaskId,
      product: '',
      project: this.getConfig().projectId,
      work: effortData.work || effortData.content,
      consumed: effortData.consumed || 0,
      left: effortData.remaining || 0,
      date: effortData.date || new Date().toISOString().split('T')[0]
    };

    console.log('[Zentao] 添加工时:', {
      taskId: zentaoTaskId,
      work: payload.work,
      consumed: payload.consumed,
      left: payload.left,
      date: payload.date
    });

    try {
      const response = await this.fetchWithSession(API_ENDPOINTS.EFFORT, {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const text = await response.text();
        console.error('[Zentao] 添加工时失败响应:', text);
        return { success: false, error: `HTTP ${response.status}` };
      }

      const data = await response.json();

      if (data && data.result === 'success') {
        console.log(`[Zentao] 工时添加成功`);
        return { success: true };
      }

      console.error('[Zentao] 添加工时返回失败:', data);
      return { success: false, error: data?.message || '未知错误' };
    } catch (err) {
      console.error('[Zentao] 添加工时异常:', err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * 更新任务状态
   */
  async updateTaskStatus(zentaoTaskId, status, progress) {
    await this.ensureLoggedIn();

    // 映射状态
    const statusMap = {
      'done': 'closed',
      'in_progress': 'doing',
      'todo': 'wait'
    };

    const zentaoStatus = statusMap[status] || 'wait';

    const payload = {
      status: zentaoStatus,
      finishedDate: status === 'done' ? new Date().toISOString() : null,
      comment: progress === 100 ? '任务已完成' : '进度更新'
    };

    console.log('[Zentao] 更新任务状态:', {
      taskId: zentaoTaskId,
      status: zentaoStatus,
      progress
    });

    try {
      const response = await this.fetchWithSession(`${API_ENDPOINTS.TASK}/${zentaoTaskId}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const text = await response.text();
        console.error('[Zentao] 更新状态失败响应:', text);
        return { success: false, error: `HTTP ${response.status}` };
      }

      const data = await response.json();

      if (data && data.result === 'success') {
        console.log(`[Zentao] 任务状态更新成功`);
        return { success: true };
      }

      console.error('[Zentao] 更新状态返回失败:', data);
      return { success: false, error: data?.message || '未知错误' };
    } catch (err) {
      console.error('[Zentao] 更新状态异常:', err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * 关闭任务
   */
  async closeTask(zentaoTaskId) {
    await this.ensureLoggedIn();

    console.log(`[Zentao] 关闭任务: ${zentaoTaskId}`);

    const payload = {
      status: 'closed',
      finishedDate: new Date().toISOString(),
      comment: '从前端关闭任务'
    };

    try {
      const response = await this.fetchWithSession(`${API_ENDPOINTS.TASK}/${zentaoTaskId}`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        console.error('[Zentao] 关闭任务失败:', response.status);
        return { success: false };
      }

      console.log(`[Zentao] 任务关闭成功`);
      return { success: true };
    } catch (err) {
      console.error('[Zentao] 关闭任务异常:', err.message);
      return { success: false, error: err.message };
    }
  }
}

// 单例实例
let clientInstance = null;

/**
 * 获取 ZentaoClient 单例
 */
export function getZentaoClient() {
  if (!clientInstance) {
    clientInstance = new ZentaoClient();
  }
  return clientInstance;
}

/**
 * 计算消耗工时（小时）
 */
export function calculateConsumedHours(createdAt) {
  const created = new Date(createdAt).getTime();
  const now = Date.now();
  return Math.max(0, (now - created) / (1000 * 60 * 60));
}

/**
 * 计算剩余工时（小时）
 */
export function calculateRemainingHours(dueDate) {
  if (!dueDate) {
    return 48; // 默认 48 小时
  }

  const due = new Date(dueDate).getTime();
  const now = Date.now();
  const remaining = (due - now) / (1000 * 60 * 60);

  return Math.max(0, remaining);
}

export default ZentaoClient;
