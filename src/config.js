import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROOT_DIR = join(__dirname, '..');

/**
 * 数据目录与配置文件
 *   安装版：程序在 WorkAssistant/versions/<版本>/，数据和配置在 WorkAssistant/data/（与程序分开，更新、回滚不碰数据），
 *           由启动脚本通过 WA_DATA_DIR 传入，配置文件为 data/.env
 *   开发时（在仓库里直接运行）：仓库里的 data/ 和 .env
 *   WA_ENV_FILE 仅供测试：读写临时文件，不碰真实配置
 */
const DATA_DIR = process.env.WA_DATA_DIR || join(ROOT_DIR, 'data');
const envFilePath = process.env.WA_ENV_FILE || (process.env.WA_DATA_DIR ? join(DATA_DIR, '.env') : join(ROOT_DIR, '.env'));

/** 版本号（以 package.json 为准；扩展 manifest.json 的 version 与它保持一致） */
const APP_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf-8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// 加载 .env 文件
dotenv.config({ path: envFilePath });

// 加载禅道用户列表
function loadZentaoUsers() {
  const usersFilePath = join(DATA_DIR, 'zentao-users.json');
  try {
    if (existsSync(usersFilePath)) {
      const usersData = readFileSync(usersFilePath, 'utf-8');
      const users = JSON.parse(usersData);
      console.log('[Config] 已加载禅道用户列表，用户数量:', Object.keys(users).length);
      return users;
    }
  } catch (err) {
    console.warn('[Config] 加载禅道用户列表失败:', err.message);
  }
  return {};
}

/** OPENAI_API_KEYS：base64 编码的 {主机: Key}（.env 一行，避免 JSON 里的引号与等号） */
function parseKeyring(raw) {
  if (!raw) return {};
  try {
    const obj = JSON.parse(Buffer.from(String(raw), 'base64').toString('utf-8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

const config = {
  app: { version: APP_VERSION },

  // AI 配置
  ai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    // 推荐使用 gpt-4o-mini 以获得最佳性能和成本平衡
    // gpt-4o-mini 支持 Structured Outputs，输出更稳定，速度更快，成本更低
    // 如果使用旧模型（如 gpt-3.5-turbo），将自动降级到 JSON mode
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    // 报告总结（日报 / 周报 / 月报）用的模型；留空与 model（任务解析）相同。
    // 报告不赶时间，可以用推理更强但更慢的模型；任务解析要在 8 秒内返回，需要快的模型
    reportModel: process.env.OPENAI_REPORT_MODEL || '',
    // 各个接口地址（按主机）各自保存的 Key：切换服务商再切回来不用重填
    keys: parseKeyring(process.env.OPENAI_API_KEYS)
  },

  // 服务配置
  // host 不能用 'localhost'：Node 会把 localhost 解析为 ::1 并只绑 IPv6，
  // 而扩展端固定访问 http://127.0.0.1:3721（IPv4），会连不上。
  // 绑定 127.0.0.1 仅限本机访问；确需对外时用 HOST=0.0.0.0 覆盖。
  server: {
    port: parseInt(process.env.PORT || '3721', 10),
    host: process.env.HOST || '127.0.0.1'
  },

  // 定时任务配置
  schedule: {
    morningHour: parseInt(process.env.MORNING_HOUR || '9', 10),
    eveningHour: parseInt(process.env.EVENING_HOUR || '21', 10)
  },

  // 报告页：全员部分只统计这些账号（逗号分隔；空 = 团队全员）
  reports: {
    members: parseAccountList(process.env.REPORT_MEMBERS)
  },

  // Webhook 配置
  webhook: {
    url: process.env.WEBHOOK_URL || '',
    type: process.env.WEBHOOK_TYPE || 'generic'
  },

  // 禅道配置
  zentao: {
    enabled: process.env.ZENTAO_ENABLED === 'true',
    url: process.env.ZENTAO_URL || '',
    username: process.env.ZENTAO_USERNAME || '',
    password: process.env.ZENTAO_PASSWORD || '',
    // 「默认执行 ID」——设置页里是选填项，留空表示不兜底。
    // 兼容两个 env 键名：ZENTAO_CREATE_TASK_URL 是安装脚本写的，
    // ZENTAO_EXECUTION_ID 是早期版本/手工写入的，两者同义。
    createTaskUrl: process.env.ZENTAO_CREATE_TASK_URL || process.env.ZENTAO_EXECUTION_ID || '',
    // 别名：executionManager / api.js 的兜底逻辑按 executionId 读，
    // 过去这里没有这个字段，导致「配置了执行 ID 也兜不住」。
    // 做成读写别名，赋值不会在严格模式下抛错，且与 createTaskUrl 始终同步。
    get executionId() { return this.createTaskUrl; },
    set executionId(v) { this.createTaskUrl = v || ''; },
    users: loadZentaoUsers(),
    usersUpdatedAt: null
  },

  // 数据目录
  paths: {
    root: ROOT_DIR,
    data: DATA_DIR,
    tasks: join(DATA_DIR, 'tasks.json'),
    history: join(DATA_DIR, 'history.json')
  },

  // 提示词配置
  prompts: {
    addTask: process.env.PROMPT_ADD_TASK ? Buffer.from(process.env.PROMPT_ADD_TASK, 'base64').toString('utf-8') : '',
    daily: process.env.PROMPT_DAILY ? Buffer.from(process.env.PROMPT_DAILY, 'base64').toString('utf-8') : '',
    weekly: process.env.PROMPT_WEEKLY ? Buffer.from(process.env.PROMPT_WEEKLY, 'base64').toString('utf-8') : '',
    monthly: process.env.PROMPT_MONTHLY ? Buffer.from(process.env.PROMPT_MONTHLY, 'base64').toString('utf-8') : ''
  }
};

// 验证必需的配置
function validateConfig() {
  if (!config.ai.apiKey || !config.ai.apiKey.trim()) {
    console.warn('');
    console.warn('╔══════════════════════════════════════════════════════════════╗');
    console.warn('║  ⚠️  AI 功能不可用：OPENAI_API_KEY 未配置                        ║');
    console.warn('║                                                              ║');
    console.warn('║  影响：任务自动拆解、执行归属匹配、日报生成均会降级为本地规则    ║');
    console.warn('║  修复：在 .env 中填入有效的 API Key                             ║');
    console.warn('║        OPENAI_API_KEY=你的密钥                                  ║');
    console.warn('║        OPENAI_BASE_URL=https://open.bigmodel.cn/api/paas/v4/    ║');
    console.warn('║        OPENAI_MODEL=glm-4-flash                                 ║');
    console.warn('╚══════════════════════════════════════════════════════════════╝');
    console.warn('');
  } else {
    console.log(`✅ AI 已启用: ${config.ai.model} @ ${config.ai.baseURL}`);
  }
  if (!config.webhook.url) {
    console.log('ℹ️  Webhook 未配置，将仅使用系统通知');
  }

  // 禅道配置验证
  if (config.zentao.enabled) {
    if (!config.zentao.url) {
      console.warn('⚠️  禅道已启用但未配置 URL');
    }
  } else {
    console.log('ℹ️  禅道同步未启用');
  }

  return true;
}

/**
 * 更新 .env 文件中的配置
 * @param {Object} updates - 要更新的配置键值对
 * @returns {boolean} 是否成功
 */
/** 逗号分隔的禅道账号 → 去重后的数组（只保留账号里可能出现的字符） */
function parseAccountList(value) {
  return [...new Set(String(value || '').split(',').map(s => s.trim()).filter(s => /^[\w.@-]{1,64}$/.test(s)))];
}

function updateEnvFile(updates) {
  // 值里带换行就能往 .env 里「多写一行」任意配置（如改掉 ZENTAO_URL），必须拒绝
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      throw new Error(`非法的配置项名: ${key}`);
    }
    if (/[\r\n\0]/.test(String(value ?? ''))) {
      throw new Error(`配置项 ${key} 的值不能包含换行符`);
    }
  }

  try {
    let envContent = '';
    try {
      envContent = readFileSync(envFilePath, 'utf-8');
    } catch (err) {
      // 文件不存在，创建基本结构
      envContent = '# AI配置\nOPENAI_API_KEY=\nOPENAI_BASE_URL=\nOPENAI_MODEL=\n\n# 服务配置\nPORT=3721\nMORNING_HOUR=9\nEVENING_HOUR=21\n\n# Webhook通知配置\nWEBHOOK_URL=\nWEBHOOK_TYPE=generic\n';
    }

    const envLines = envContent.split('\n');
    const processedKeys = new Set();

    // 更新已存在的键或添加新键
    const updatedLines = envLines.map(line => {
      // 跳过注释和空行
      if (line.trim().startsWith('#') || line.trim() === '') {
        return line;
      }

      const eqIndex = line.indexOf('=');
      if (eqIndex === -1) return line;

      const key = line.substring(0, eqIndex).trim();

      // 检查是否需要更新这个键
      if (key in updates) {
        processedKeys.add(key);
        return `${key}=${updates[key]}`;
      }
      return line;
    });

    // 添加未存在的新键（在文件末尾）
    for (const [key, value] of Object.entries(updates)) {
      if (!processedKeys.has(key)) {
        updatedLines.push(`${key}=${value}`);
      }
    }

    // 写回文件（含密钥，仅本人可读写）
    writeFileSync(envFilePath, updatedLines.join('\n') + '\n', { mode: 0o600 });
    chmodSync(envFilePath, 0o600);
    console.log('[Config] .env 文件已更新');
    return true;
  } catch (err) {
    console.error('[Config] 更新 .env 文件失败:', err.message);
    return false;
  }
}

/**
 * 保存禅道用户列表到运行时配置与 data/zentao-users.json
 * @param {Object} users - { account: realname }
 */
function saveZentaoUsers(users) {
  config.zentao.users = users;
  config.zentao.usersUpdatedAt = new Date().toISOString();
  mkdirSync(config.paths.data, { recursive: true });
  writeFileSync(join(config.paths.data, 'zentao-users.json'), JSON.stringify(users, null, 2), 'utf-8');
  console.log('[Config] 禅道用户列表已更新，用户数量:', Object.keys(users).length);
}

/**
 * 设置页保存禅道配置：计算要保存的值
 *
 * 密码、地址、账号留空都表示「不修改」：设置页不回显密码；地址曾因回填读错字段而为空，
 * 一保存就把禅道地址清空，之后所有禅道操作都失败。要停用禅道请关掉开关。
 * @param {{enabled:any, url?:string, username?:string, password?:string, createTaskUrl?:string}} body
 * @param {{url?:string, username?:string, password?:string}} current
 */
function mergeZentaoSettings(body, current) {
  const keepIfBlank = (v, old) => (String(v || '').trim() ? String(v).trim() : (old || ''));
  return {
    enabled: body.enabled === true || body.enabled === 'true',
    url: keepIfBlank(body.url, current.url),
    username: keepIfBlank(body.username, current.username),
    password: body.password ? String(body.password) : (current.password || ''),
    createTaskUrl: String(body.createTaskUrl || '')
  };
}

/**
 * AI 接口地址规整为 OpenAI SDK 需要的 base URL（SDK 会自己拼 /chat/completions）
 *
 * 中转 / 服务商文档常给完整的聊天地址（…/v1/chat/completions），原样填进去会变成
 * …/chat/completions/chat/completions。这里去掉末尾的 /chat/completions、/models 和多余斜杠。
 */
function normalizeAiBaseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '').replace(/\/(chat\/completions|completions|models)$/i, '').replace(/\/+$/, '');
}

/** 接口地址 → 保存 Key 用的键（主机 + 端口）；地址不合法返回空串 */
function aiKeyHost(url) {
  try {
    return new URL(normalizeAiBaseUrl(url)).host.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 某个接口地址保存的 Key：先查按主机保存的，再看是不是当前使用的地址
 * （升级前只保存了当前那一个 Key）
 */
function savedKeyFor(url) {
  const host = aiKeyHost(url);
  if (!host) return '';
  if (config.ai.keys[host]) return config.ai.keys[host];
  return host === aiKeyHost(config.ai.baseURL) ? config.ai.apiKey : '';
}

/** 把 Key 记到对应地址下，返回要写进 .env 的值 */
function rememberKey(url, key) {
  const host = aiKeyHost(url);
  if (host && key) config.ai.keys = { ...config.ai.keys, [host]: key };
  return Buffer.from(JSON.stringify(config.ai.keys), 'utf-8').toString('base64');
}

/**
 * 某类 AI 调用用的模型
 * @param {'task'|'report'} purpose - task：新建任务 / Bug 解析、执行匹配（交互中，要快）；report：日报 / 周报 / 月报
 */
function aiModelFor(purpose) {
  if (purpose === 'report' && config.ai.reportModel) return config.ai.reportModel;
  return config.ai.model;
}

export {
  config, validateConfig, updateEnvFile, saveZentaoUsers, mergeZentaoSettings, normalizeAiBaseUrl,
  aiKeyHost, savedKeyFor, rememberKey, aiModelFor, parseAccountList
};
