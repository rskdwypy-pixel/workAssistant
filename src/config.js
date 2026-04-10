import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// .env 文件路径
const envFilePath = join(__dirname, '../.env');

// 加载 .env 文件
dotenv.config({ path: envFilePath });

// 加载禅道用户列表
function loadZentaoUsers() {
  const usersFilePath = join(__dirname, '../data/zentao-users.json');
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

const config = {
  // AI 配置
  ai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    // 推荐使用 gpt-4o-mini 以获得最佳性能和成本平衡
    // gpt-4o-mini 支持 Structured Outputs，输出更稳定，速度更快，成本更低
    // 如果使用旧模型（如 gpt-3.5-turbo），将自动降级到 JSON mode
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini'
  },

  // 服务配置
  server: {
    port: parseInt(process.env.PORT || '3721', 10),
    host: 'localhost'
  },

  // 定时任务配置
  schedule: {
    morningHour: parseInt(process.env.MORNING_HOUR || '9', 10),
    eveningHour: parseInt(process.env.EVENING_HOUR || '21', 10)
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
    createTaskUrl: process.env.ZENTAO_CREATE_TASK_URL || '',
    users: loadZentaoUsers(),
    usersUpdatedAt: null
  },

  // 数据目录
  paths: {
    root: join(__dirname, '..'),
    data: join(__dirname, '../data'),
    tasks: join(__dirname, '../data/tasks.json'),
    history: join(__dirname, '../data/history.json')
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
  if (!config.ai.apiKey) {
    console.warn('⚠️  警告: OPENAI_API_KEY 未设置');
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
function updateEnvFile(updates) {
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

    // 写回文件
    writeFileSync(envFilePath, updatedLines.join('\n') + '\n');
    console.log('[Config] .env 文件已更新');
    return true;
  } catch (err) {
    console.error('[Config] 更新 .env 文件失败:', err.message);
    return false;
  }
}

export { config, validateConfig, updateEnvFile };
