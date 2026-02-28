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
    this.session = null;           // 存储 session Cookie
    this.sessionExpiry = null;     // session 过期时间
    this.lastLoginTime = null;     // 上次登录时间
    this.sessionToken = null;       // 存储 session token (从登录响应的 data.s 获取)
    this.keepAliveTimer = null;     // 会话保活定时器
    this.isLoginInProgress = false; // 登录进行中标志
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
   * 返回一个 Map，key 是 cookie 名称，value 是 cookie 值
   */
  extractSession(response) {
    // 解析 Set-Cookie 头
    const getAllCookies = (headers) => {
      const cookies = new Map();

      // 获取所有 set-cookie 头
      const getAllValues = (headers, name) => {
        // 尝试获取所有值（fetch API 的 entries()）
        const values = [];
        for (const [key, value] of headers.entries()) {
          if (key.toLowerCase() === name.toLowerCase()) {
            values.push(value);
          }
        }
        return values;
      };

      const cookieHeaders = getAllValues(headers, 'set-cookie');

      for (const header of cookieHeaders) {
        // 提取 cookie 名称和值（在第一个分号之前）
        const match = header.match(/^([^=]+)=([^;]+)/);
        if (match) {
          cookies.set(match[1], match[2]);
        }
      }

      return cookies;
    };

    const extractedCookies = getAllCookies(response.headers);

    if (extractedCookies.size > 0) {
      const cookieArray = Array.from(extractedCookies.entries()).map(([k, v]) => `${k}=${v}`);
      console.log(`[Zentao] 提取到 ${extractedCookies.size} 个 Cookie:`, cookieArray);
      return extractedCookies; // 返回 Map 而不是字符串
    }

    return null;
  }

  /**
   * 检查响应是否表示登录失效
   */
  isLoginExpired(response, text) {
    // 检查状态码（某些禅道版本返回 302 重定向）
    if (response.status === 302 || response.status === 301) {
      const location = response.headers.get('Location') || '';
      if (location.includes('login') || location.includes('Login')) {
        console.log('[Zentao] 检测到登录重定向');
        return true;
      }
    }

    // 检查响应文本中的登录失效标志
    if (text) {
      const expiredSignals = [
        '登录已超时',
        '请重新登入',
        'session expired',
        'not logged in',
        '请先登录',
        '登录失败'
      ];
      const lowerText = text.toLowerCase();
      if (expiredSignals.some(signal => lowerText.includes(signal.toLowerCase()))) {
        console.log('[Zentao] 检测到登录失效:', expiredSignals.find(s => lowerText.includes(s.toLowerCase())));
        return true;
      }

      // 检查是否是重定向到登录页的 JSON 响应
      try {
        const data = JSON.parse(text);
        if (data.locate && (data.locate.includes('login') || data.locate.includes('Login'))) {
          console.log('[Zentao] 检测到登录重定向 (JSON)');
          return true;
        }
        // 检查 result: false 且 message 包含登录失效关键字的情况
        if (data.result === false && data.message) {
          const msgLower = data.message.toLowerCase();
          if (expiredSignals.some(signal => msgLower.includes(signal.toLowerCase()))) {
            console.log('[Zentao] 检测到登录失效 (result=false):', data.message);
            return true;
          }
        }
      } catch (e) {
        // 不是 JSON，忽略
      }
    }

    // 额外检查：如果响应中丢失了 zentaosid Cookie，且之前有，可能是登录失效
    const newCookies = this.extractSession(response);
    if (newCookies && newCookies.size > 0) {
      const hasZentaoSid = Array.from(newCookies.keys()).some(k => k.toLowerCase() === 'zentaosid');
      // 如果之前有 zentaosid，但响应中没有返回，可能是登录失效
      if (this.session && this.session.includes('zentaosid=') && !hasZentaoSid && !text.includes('登录成功')) {
        console.log('[Zentao] 检测到 zentaosid 丢失，可能是登录失效');
      }
    }

    return false;
  }

  /**
   * 发起请求并处理会话（支持自动重试）
   */
  async fetchWithSession(endpoint, options = {}, retryCount = 0) {
    const url = this.getUrl(endpoint);

    // 添加默认请求头（禅道需要这些来返回 JSON 而不是 HTML）
    const headers = {
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
    };

    // 合并传入的请求头
    if (options.headers) {
      Object.assign(headers, options.headers);
    }

    // 设置默认 Content-Type（如果未指定）
    if (!headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    // 添加 Referer 头（某些禅道版本需要）
    if (!headers['Referer']) {
      headers['Referer'] = this.getConfig().url || this.getUrl('/zentao/');
    }

    if (this.session) {
      headers['Cookie'] = this.session;
      console.log('[Zentao] 发送 Cookie:', this.session);
    }

    console.log(`[Zentao] 请求: ${options.method || 'GET'} ${endpoint}`);
    console.log('[Zentao] 请求头:', JSON.stringify({
      Accept: headers['Accept'],
      'X-Requested-With': headers['X-Requested-With'],
      'Content-Type': headers['Content-Type']
    }));

    const response = await fetch(url, {
      ...options,
      headers
    });

    // 更新 session（如果有新的 Set-Cookie，需要合并而不是替换）
    const newCookies = this.extractSession(response);
    if (newCookies) {
      // 合并 Cookie：解析现有 Cookie 和新 Cookie，然后合并
      this.session = this.mergeCookies(this.session, newCookies);
      console.log('[Zentao] Session 已更新');
    }

    // 检查登录是否失效，如果失效则重新登录并重试
    const responseText = await response.text();
    if (this.isLoginExpired(response, responseText)) {
      if (retryCount < 2) {
        console.log(`[Zentao] 登录已失效，尝试重新登录并重试 (第 ${retryCount + 1} 次)...`);

        // 清除旧的 session
        this.session = null;
        this.sessionToken = null;

        // 重新登录
        const loginSuccess = await this.login();
        if (loginSuccess) {
          console.log('[Zentao] 重新登录成功，重试原请求');
          // 重试原请求
          return await this.fetchWithSession(endpoint, options, retryCount + 1);
        } else {
          console.error('[Zentao] 重新登录失败');
          throw new Error('重新登录失败');
        }
      } else {
        console.error('[Zentao] 重试次数已达上限');
        throw new Error('登录已失效，重试失败');
      }
    }

    // 返回一个新的 Response 对象，包含之前读取的文本
    return new Response(responseText, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }

  /**
   * 清理 Cookie 字符串，移除无效的 Cookie（如 tab=deleted）
   */
  cleanCookies(cookieStr) {
    if (!cookieStr) return cookieStr;

    const invalidNames = ['tab'];
    const cookies = cookieStr.split(';').filter(cookie => {
      const name = cookie.trim().split('=')[0];
      return !invalidNames.includes(name);
    });

    return cookies.join('; ');
  }

  /**
   * 合并现有 Cookie 和新返回的 Cookie Map
   * 策略：只合并名称相同的 Cookie，其他保持不变
   * 新 Cookie 会覆盖同名的旧 Cookie
   * 注意：保持 Cookie 顺序，zentaosid 必须在最前面（禅道对顺序敏感）
   */
  mergeCookies(existingCookieStr, newCookieMap) {
    if (!newCookieMap || newCookieMap.size === 0) {
      return existingCookieStr; // 没有新 Cookie，保持原样
    }

    // 解析现有 Cookie 为数组（保持顺序）
    const existingList = [];
    if (existingCookieStr) {
      // 先清理无效 Cookie
      const cleanedStr = this.cleanCookies(existingCookieStr);
      cleanedStr.split(';').forEach(cookie => {
        const trimmed = cookie.trim();
        if (!trimmed) return;
        const [name, value] = trimmed.split('=');
        if (name && value !== undefined) {
          existingList.push({ name, value });
        }
      });
    }

    // 将新 Cookie 合并到列表中（覆盖同名，添加新名）
    for (const [name, value] of newCookieMap.entries()) {
      // 跳过无效的 Cookie
      if (value === 'deleted' || name === 'tab') {
        continue;
      }
      const existingIndex = existingList.findIndex(c => c.name === name);
      if (existingIndex >= 0) {
        // 覆盖同名 Cookie
        existingList[existingIndex].value = value;
      } else {
        // 添加新 Cookie（zentaosid 优先放在最前面）
        if (name === 'zentaosid') {
          existingList.unshift({ name, value });
        } else {
          existingList.push({ name, value });
        }
      }
    }

    // 重新组合成字符串（保持顺序，不排序）
    const result = existingList.map(c => `${c.name}=${c.value}`).join('; ');
    console.log('[Zentao] 合并后 Cookie:', result);
    return result;
  }

  /**
   * 验证当前 session 是否有效
   */
  async validate() {
    if (!this.session) {
      console.log('[Zentao] 无 session，需要登录');
      return false;
    }

    // 如果没有 session token，认为无效
    if (!this.sessionToken) {
      console.log('[Zentao] 无 session token，需要登录');
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
    // 防止并发登录
    if (this.isLoginInProgress) {
      console.log('[Zentao] 正在登录中，等待完成...');
      // 等待最多 10 秒
      const maxWait = 10;
      let waited = 0;
      while (this.isLoginInProgress && waited < maxWait) {
        await new Promise(resolve => setTimeout(resolve, 500));
        waited += 0.5;
      }
      if (this.isLoginInProgress) {
        throw new Error('登录等待超时');
      }
      // 登录已完成，检查是否成功
      if (this.session && this.sessionToken) {
        return true;
      }
    }

    if (!this.getConfig().url || !this.getConfig().username || !this.getConfig().password) {
      throw new Error('禅道配置不完整，请检查配置');
    }

    this.isLoginInProgress = true;
    console.log(`[Zentao] 开始登录，用户: ${this.getConfig().username}`);
    console.log(`[Zentao] 登录 URL: ${this.getUrl(API_ENDPOINTS.LOGIN)}`);

    try {
      // 禅道使用表单编码
      const params = new URLSearchParams();
      params.append('account', this.getConfig().username);
      params.append('password', this.getConfig().password);

      // 直接使用 fetch 而不是 fetchWithSession，避免递归
      const url = this.getUrl(API_ENDPOINTS.LOGIN);
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json, text/javascript, */*; q=0.01',
          'X-Requested-With': 'XMLHttpRequest',
        },
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
      const sessionCookies = this.extractSession(response);
      if (sessionCookies && sessionCookies.size > 0) {
        // 过滤无效 Cookie，然后将 Map 转换为字符串
        const validEntries = Array.from(sessionCookies.entries())
          .filter(([k, v]) => v !== 'deleted' && k !== 'tab');
        this.session = validEntries.map(([k, v]) => `${k}=${v}`).join('; ');
        console.log('[Zentao] Session 已保存:', this.session);
      }

      // 检查登录结果（禅道返回格式: { status: 'success', data: "{...}" }）
      if (data.status === 'success') {
        // 解析 data 字段（它是一个 JSON 字符串）
        let dataData = {};
        try {
          dataData = JSON.parse(data.data);
        } catch (e) {
          console.warn('[Zentao] 无法解析 data.data');
        }

        console.log('[Zentao] 登录成功');
        this.lastLoginTime = Date.now();

        // 保存 session token（如果有）
        if (dataData.s) {
          this.sessionToken = dataData.s;
          console.log('[Zentao] Session Token 已保存:', dataData.s.substring(0, 20) + '...');
        }

        return true;
      } else {
        console.error('[Zentao] 登录返回失败状态:', data);
        throw new Error('登录失败: ' + (data.reason || data.msg || '未知错误'));
      }
    } catch (err) {
      console.error('[Zentao] 登录异常:', err.message);
      throw err;
    } finally {
      this.isLoginInProgress = false;
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
   * 使用 multipart/form-data 格式，从 HTML 页面提取任务ID
   */
  async createTask(taskData) {
    await this.ensureLoggedIn();

    const createTaskUrl = this.getConfig().createTaskUrl || '';

    if (!createTaskUrl) {
      console.error('[Zentao] 未配置新建任务地址');
      return { success: false, error: '未配置新建任务地址' };
    }

    let executionId = '0';
    const match = createTaskUrl.match(/task-create-(\d+)/);
    if (match) {
      executionId = match[1];
    }

    console.log('[Zentao] 创建任务:', {
      title: taskData.title,
      createTaskUrl,
      executionId,
      deadline: taskData.dueDate
    });

    try {
      // 直接使用表单提交方式创建任务
      // 禅道的 task-create-{id}.json 端点返回的是表单页面数据，不是创建 API
      return await this.createTaskViaForm(taskData, executionId, createTaskUrl);

    } catch (err) {
      console.error('[Zentao] 创建任务异常:', err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * 使用表单提交方式创建任务（备用方案）
   */
  async createTaskViaForm(taskData, executionId, createTaskUrl) {
    // 获取当前用户名
    const username = this.getConfig().username || '';
    console.log('[Zentao] 指派给用户:', username);
    console.log('[Zentao] 任务标题:', taskData.title);
    console.log('[Zentao] 任务描述:', taskData.content || taskData.title);

    // 构建 multipart/form-data
    const fieldList = [
      { name: 'execution', value: executionId },
      { name: 'type', value: 'test' },
      { name: 'module', value: '0' },
      { name: 'assignedTo[]', value: username },
      { name: 'teamMember', value: '' },
      { name: 'mode', value: 'linear' },
      { name: 'status', value: 'wait' },
      { name: 'story', value: '' },
      { name: 'color', value: '' },
      { name: 'name', value: taskData.title },
      { name: 'storyEstimate', value: '' },
      { name: 'storyDesc', value: '' },
      { name: 'storyPri', value: '' },
      { name: 'pri', value: this.mapPriority(taskData.priority).toString() },
      { name: 'estimate', value: '' },
      { name: 'desc', value: taskData.content || taskData.title },
      { name: 'estStarted', value: '' },
      { name: 'deadline', value: taskData.dueDate || '' },
      { name: 'after', value: 'toTaskList' },
      { name: 'uid', value: this.generateUid() },
      // team[] 等字段重复5次
      { name: 'team[]', value: '' },
      { name: 'teamSource[]', value: '' },
      { name: 'teamEstimate[]', value: '' },
      { name: 'team[]', value: '' },
      { name: 'teamSource[]', value: '' },
      { name: 'teamEstimate[]', value: '' },
      { name: 'team[]', value: '' },
      { name: 'teamSource[]', value: '' },
      { name: 'teamEstimate[]', value: '' },
      { name: 'team[]', value: '' },
      { name: 'teamSource[]', value: '' },
      { name: 'teamEstimate[]', value: '' },
      { name: 'team[]', value: '' },
      { name: 'teamSource[]', value: '' },
      { name: 'teamEstimate[]', value: '' },
    ];

    const { boundary, formData } = this.buildMultipartFormData(fieldList);

    console.log('[Zentao] 使用表单提交方式创建任务');
    console.log('[Zentao] 请求端点:', createTaskUrl);
    console.log('[Zentao] FormData长度:', formData.length);

    let endpoint = createTaskUrl;
    const urlObj = new URL(createTaskUrl.startsWith('http') ? createTaskUrl : `http://localhost${createTaskUrl}`);
    if (this.sessionToken) {
      urlObj.searchParams.set('s', this.sessionToken);
      endpoint = createTaskUrl.startsWith('http') ? urlObj.toString() : `${urlObj.pathname}${urlObj.search}`;
    }

    const response = await this.fetchWithSession(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body: formData
    });

    const responseText = await response.text();
    console.log('[Zentao] 表单提交响应状态:', response.status);
    console.log('[Zentao] 表单提交响应内容:', responseText);

    if (!response.ok) {
      throw new Error(`创建任务失败: ${response.status}`);
    }

    let data;
    try {
      data = JSON.parse(responseText);
      console.log('[Zentao] 解析后的响应数据:', JSON.stringify(data, null, 2));
    } catch (e) {
      throw new Error('响应不是有效的 JSON 格式');
    }

    if (data && data.result === 'success' && data.locate) {
      console.log('[Zentao] 任务创建成功，locate:', data.locate);

      // 先尝试从 locate URL 中提取任务ID
      let taskId = null;
      const locateMatch = data.locate.match(/task[-_]view[-_]?(\d+)/) ||
        data.locate.match(/execution-task[-_][^/-]+-(\d+)/);
      if (locateMatch) {
        taskId = locateMatch[1];
        console.log('[Zentao] 从 locate 提取到任务ID:', taskId);
        return { success: true, taskId };
      }

      // 如果直接提取失败，尝试访问页面
      console.log('[Zentao] 尝试从页面提取任务ID');
      taskId = await this.extractTaskIdFromHtml(data.locate);
      if (taskId) {
        return { success: true, taskId };
      }
    }

    console.log('[Zentao] 表单提交未返回有效的任务ID');
    return { success: false, error: '无效响应' };
  }

  /**
   * 构建 multipart/form-data 格式的请求体
   * 接受字段列表 { name, value }[]，支持重复字段名
   * 返回 { boundary, formData }
   */
  buildMultipartFormData(fieldList) {
    const boundary = `----WebKitFormBoundary${Math.random().toString(36).substring(2, 14)}`;
    let body = '';

    for (const field of fieldList) {
      body += `--${boundary}\r\n`;
      body += `Content-Disposition: form-data; name="${field.name}"\r\n\r\n`;
      body += `${field.value}\r\n`;
    }

    body += `--${boundary}--\r\n`;
    return { boundary, formData: body };
  }

  /**
   * 生成随机 UID
   */
  generateUid() {
    return Math.random().toString(36).substring(2, 14);
  }

  /**
   * 从 HTML 页面提取任务ID
   * 请求任务列表页面，解析第一行的 data-id 属性
   */
  async extractTaskIdFromHtml(locatePath) {
    try {
      // locatePath 格式: /zentao/execution-task-167-unclosed-0-id_desc.html
      // 添加 session token 到 URL
      const urlWithToken = `${locatePath}${this.sessionToken ? `?s=${this.sessionToken}` : ''}`;

      const response = await this.fetchWithSession(urlWithToken);

      if (!response.ok) {
        console.error('[Zentao] 获取任务列表页面失败:', response.status);
        return null;
      }

      const html = await response.text();

      // 使用正则提取第一个 data-id
      // 匹配 <tr data-id='数字' 或 <tr data-id="数字"
      const match = html.match(/<tr\s+data-id=['"](\d+)['"]/);

      if (match && match[1]) {
        return match[1];
      }

      console.error('[Zentao] HTML 中未找到任务ID');
      return null;
    } catch (err) {
      console.error('[Zentao] 提取任务ID异常:', err.message);
      return null;
    }
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
      project: this.getConfig().executionId,
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
   * 记录工时（使用表单方式）
   * 用于用户手动记录进度和工时
   */
  async recordEstimate(zentaoTaskId, work, consumedHours) {
    await this.ensureLoggedIn();

    const today = new Date().toISOString().split('T')[0];

    // 构建表单数据
    const params = new URLSearchParams();
    // 第一行：实际数据
    params.append('dates[1]', today);
    params.append('id[1]', '1');
    params.append('work[1]', work);
    params.append('consumed[1]', String(consumedHours));
    params.append('left[1]', '20'); // 固定剩余20小时
    // 其他4行空数据（禅道表单需要）
    for (let i = 2; i <= 5; i++) {
      params.append(`dates[${i}]`, today);
      params.append(`id[${i}]`, String(i));
      params.append(`work[${i}]`, '');
      params.append(`consumed[${i}]`, '');
      params.append(`left[${i}]`, '');
    }

    const endpoint = `/zentao/task-recordEstimate-${zentaoTaskId}.html?onlybody=yes`;

    console.log('[Zentao] 记录工时:', {
      taskId: zentaoTaskId,
      date: today,
      work: work.substring(0, 50) + '...',
      consumed: consumedHours
    });

    try {
      const response = await this.fetchWithSession(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: params
      });

      const responseText = await response.text();
      console.log('[Zentao] 记录工时响应状态:', response.status);

      if (!response.ok) {
        console.error('[Zentao] 记录工时失败响应:', responseText);
        return { success: false, error: `HTTP ${response.status}` };
      }

      // 检查响应是否包含错误信息
      if (responseText.includes('登录已超时') || responseText.includes('请重新登入')) {
        console.error('[Zentao] 登录已超时');
        return { success: false, error: '登录已超时' };
      }

      // 检查 session 中是否仍然有 zentaosid
      const hasZentaoSid = this.session && this.session.includes('zentaosid=');
      if (!hasZentaoSid) {
        console.warn('[Zentao] 工时记录后丢失了 zentaosid，尝试重新获取');
        // 尝试重新登录以获取新的 session
        const loginSuccess = await this.login();
        if (!loginSuccess) {
          return { success: false, error: '重新登录失败' };
        }
      }

      console.log('[Zentao] 工时记录成功');
      return { success: true };
    } catch (err) {
      console.error('[Zentao] 记录工时异常:', err.message);
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

  /**
   * 会话保活检测（定时调用）
   * 检测当前会话是否有效，如果无效则重新登录
   */
  async keepAliveCheck() {
    if (!this.getConfig().enabled) {
      return;
    }

    // 如果正在登录中，跳过本次检测
    if (this.isLoginInProgress) {
      console.log('[Zentao] 正在登录中，跳过本次会话检测');
      return;
    }

    try {
      // 验证当前会话
      const isValid = await this.validate();
      if (isValid) {
        console.log('[Zentao] 会话保活检测: 正常');
      } else {
        console.log('[Zentao] 会话保活检测: 失效，正在重新登录...');
        await this.login();
        console.log('[Zentao] 会话保活检测: 已重新登录');
      }
    } catch (err) {
      console.error('[Zentao] 会话保活检测失败:', err.message);
    }
  }

  /**
   * 启动会话保活定时器
   * @param {number} intervalMinutes - 检测间隔（分钟），默认 5 分钟
   */
  startKeepAlive(intervalMinutes = 5) {
    if (!this.getConfig().enabled) {
      console.log('[Zentao] 禅道未启用，不启动会话保活');
      return;
    }

    // 如果已有定时器在运行，先清除
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
    }

    const intervalMs = intervalMinutes * 60 * 1000;

    console.log(`[Zentao] 启动会话保活定时器，检测间隔: ${intervalMinutes} 分钟`);

    // 立即执行一次检测
    this.keepAliveCheck().catch(err => {
      console.error('[Zentao] 初次会话检测失败:', err.message);
    });

    // 启动定时器
    this.keepAliveTimer = setInterval(() => {
      this.keepAliveCheck().catch(err => {
        console.error('[Zentao] 定时会话检测失败:', err.message);
      });
    }, intervalMs);
  }

  /**
   * 停止会话保活定时器
   */
  stopKeepAlive() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
      console.log('[Zentao] 会话保活定时器已停止');
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
