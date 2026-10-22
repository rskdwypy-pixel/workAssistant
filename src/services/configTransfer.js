/**
 * 配置迁移：换机时把「用户自己配置的部分」加密导出，导入时解密写回后端
 *
 * 导出的（只有用户自己填 / 选的）：
 *   禅道：是否启用、地址、账号、密码、默认执行
 *   AI：接口地址、任务解析模型、报告总结模型、Key（含按地址保存的各个 Key）
 *   通知：早晚提醒时间、推送地址与类型
 *   提示词、全员报告成员、收藏的执行（只存 ID）
 *   设置页里各服务商的地址与模型（浏览器里的，由前端传入、导入后交还前端）
 * 不导出（能从禅道同步回来的或本机相关的）：禅道用户、执行 / 项目列表、任务、Bug、报告、端口等。
 *
 * 含账号密码与 Key，所以整份内容用口令加密：scrypt 由口令派生密钥，AES-256-GCM 加密并校验完整性。
 * 口令不保存在任何地方，忘了只能在原机器上重新导出。
 */
import crypto from 'crypto';
import {
  config, updateEnvFile, normalizeAiBaseUrl, aiKeyHost, parseAccountList
} from '../config.js';

const APP = 'workAssistant';
const VERSION = 2;
const KDF = { name: 'scrypt', N: 32768, r: 8, p: 1 };
const MIN_PASSPHRASE = 8;

/** 导出文件里明文列出的内容清单（不含任何值），导入前给用户看 */
const CONTENT_LABELS = {
  zentao: '禅道地址、账号与密码',
  ai: 'AI 接口地址、模型与 Key',
  notify: '提醒时间与推送地址',
  prompts: '自定义提示词',
  reportMembers: '全员报告成员',
  favorites: '收藏的执行',
  client: '设置页各服务商的地址与模型'
};

// ==================== 收集 ====================

/**
 * 当前「用户自己配置的部分」
 * @param {Object} [client] - 前端（浏览器）里的设置：aiProvider、aiProfiles
 */
async function collectSettings(client = {}) {
  const { getFavoriteExecutionIds } = await import('./executionManager.js');
  const z = config.zentao;
  return {
    zentao: {
      enabled: !!z.enabled,
      url: z.url || '',
      username: z.username || '',
      password: z.password || '',
      defaultExecution: z.createTaskUrl || ''
    },
    ai: {
      baseURL: config.ai.baseURL || '',
      model: config.ai.model || '',
      reportModel: config.ai.reportModel || '',
      apiKey: config.ai.apiKey || '',
      keys: { ...(config.ai.keys || {}) }
    },
    notify: {
      morningHour: config.schedule.morningHour,
      eveningHour: config.schedule.eveningHour,
      webhookUrl: config.webhook.url || '',
      webhookType: config.webhook.type || 'generic'
    },
    prompts: { ...config.prompts },
    reportMembers: [...(config.reports.members || [])],
    favorites: (getFavoriteExecutionIds() || []).map(String),
    client: {
      aiProvider: typeof client.aiProvider === 'string' ? client.aiProvider : '',
      aiProfiles: client.aiProfiles && typeof client.aiProfiles === 'object' ? client.aiProfiles : {}
    }
  };
}

// ==================== 加密 / 解密 ====================

function deriveKey(passphrase, salt, kdf = KDF) {
  return crypto.scryptSync(String(passphrase).normalize('NFC'), salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 128 * kdf.N * kdf.r * 2 });
}

/** 文件头（明文部分）同时作为 GCM 的附加认证数据：改了内容清单也会解密失败 */
const headerAad = (h) => Buffer.from(JSON.stringify([h.__app, h.__version, h.exportedAt, h.contents]), 'utf-8');

/**
 * 加密导出
 * @returns {Object} 导出文件（JSON 对象）
 */
function encryptSettings(settings, passphrase) {
  if (!passphrase || String(passphrase).length < MIN_PASSPHRASE) throw new Error(`口令至少 ${MIN_PASSPHRASE} 位`);
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const header = {
    __app: APP,
    __version: VERSION,
    exportedAt: new Date().toISOString(),
    contents: Object.keys(CONTENT_LABELS).map(k => CONTENT_LABELS[k])
  };
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  cipher.setAAD(headerAad(header));
  const data = Buffer.concat([cipher.update(JSON.stringify(settings), 'utf-8'), cipher.final()]);
  return {
    ...header,
    encrypted: true,
    kdf: { ...KDF, salt: salt.toString('base64') },
    cipher: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  };
}

/**
 * 解密导入文件
 * @returns {Object} settings
 */
function decryptSettings(file, passphrase) {
  if (!file || file.__app !== APP) throw new Error('不是禅道助手导出的配置文件');
  if (!file.encrypted) throw new Error('这是旧版导出的文件（不含密码与 Key，且旧版导入没有生效）：请在原机器上用新版本重新导出');
  if (file.__version > VERSION) throw new Error('配置文件来自更新的版本，请先升级插件');
  if (file.cipher !== 'aes-256-gcm' || !file.kdf || file.kdf.name !== 'scrypt') throw new Error('不支持的加密方式');
  const kdf = { N: Number(file.kdf.N), r: Number(file.kdf.r), p: Number(file.kdf.p) };
  // 防止恶意文件用超大参数把后端拖死
  if (!(kdf.N >= 1024 && kdf.N <= 1048576 && kdf.r >= 1 && kdf.r <= 32 && kdf.p >= 1 && kdf.p <= 4)) throw new Error('配置文件的加密参数不正确');
  let plain;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase || '', Buffer.from(file.kdf.salt, 'base64'), kdf), Buffer.from(file.iv, 'base64'));
    decipher.setAAD(headerAad(file));
    decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
    plain = Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]).toString('utf-8');
  } catch {
    throw new Error('口令不正确，或文件已损坏');
  }
  return JSON.parse(plain);
}

// ==================== 写回 ====================

const str = (v, max = 2000) => (v === undefined || v === null ? '' : String(v).slice(0, max));
const hour = (v, fallback) => {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : fallback;
};

/**
 * 把导入的配置写回后端（.env + 运行时配置 + 收藏的执行）
 * 只写文件里有的部分；Key 按地址合并（本机已有的其他地址的 Key 保留）
 * @returns {Promise<{applied:string[], client:Object}>}
 */
async function applySettings(s) {
  if (!s || typeof s !== 'object') throw new Error('配置内容为空');
  const env = {};
  const applied = [];

  if (s.zentao) {
    const z = s.zentao;
    const next = {
      enabled: z.enabled === true,
      url: str(z.url, 300).trim(),
      username: str(z.username, 100).trim(),
      password: str(z.password, 300),
      createTaskUrl: str(z.defaultExecution, 50).trim()
    };
    Object.assign(env, {
      ZENTAO_ENABLED: next.enabled ? 'true' : 'false',
      ZENTAO_URL: next.url,
      ZENTAO_USERNAME: next.username,
      ZENTAO_PASSWORD: next.password,
      ZENTAO_CREATE_TASK_URL: next.createTaskUrl
    });
    s.zentao = next;
    applied.push('zentao');
  }

  let mergedKeys;
  if (s.ai) {
    const a = s.ai;
    const baseURL = normalizeAiBaseUrl(str(a.baseURL, 300));
    const keys = a.keys && typeof a.keys === 'object' && !Array.isArray(a.keys)
      ? Object.fromEntries(Object.entries(a.keys).filter(([h, k]) => /^[\w.:-]{1,200}$/.test(h) && typeof k === 'string' && k).map(([h, k]) => [h, k.slice(0, 500)]))
      : {};
    s.ai = { baseURL, model: str(a.model, 200).trim(), reportModel: str(a.reportModel, 200).trim(), apiKey: str(a.apiKey, 500).trim(), keys };
    Object.assign(env, {
      OPENAI_BASE_URL: baseURL,
      OPENAI_MODEL: s.ai.model,
      OPENAI_REPORT_MODEL: s.ai.reportModel,
      OPENAI_API_KEY: s.ai.apiKey
    });
    applied.push('ai');
  }

  if (s.notify) {
    const n = s.notify;
    s.notify = {
      morningHour: hour(n.morningHour, config.schedule.morningHour),
      eveningHour: hour(n.eveningHour, config.schedule.eveningHour),
      webhookUrl: str(n.webhookUrl, 1000).trim(),
      webhookType: ['generic', 'feishu', 'dingtalk', 'wecom'].includes(n.webhookType) ? n.webhookType : 'generic'
    };
    Object.assign(env, {
      MORNING_HOUR: String(s.notify.morningHour),
      EVENING_HOUR: String(s.notify.eveningHour),
      WEBHOOK_URL: s.notify.webhookUrl,
      WEBHOOK_TYPE: s.notify.webhookType
    });
    applied.push('notify');
  }

  if (s.prompts) {
    const b64 = (t) => (t ? Buffer.from(t, 'utf-8').toString('base64') : '');
    const p = s.prompts;
    s.prompts = { addTask: str(p.addTask, 8000), daily: str(p.daily, 8000), weekly: str(p.weekly, 8000), monthly: str(p.monthly, 8000) };
    Object.assign(env, {
      PROMPT_ADD_TASK: b64(s.prompts.addTask),
      PROMPT_DAILY: b64(s.prompts.daily),
      PROMPT_WEEKLY: b64(s.prompts.weekly),
      PROMPT_MONTHLY: b64(s.prompts.monthly)
    });
    applied.push('prompts');
  }

  if (Array.isArray(s.reportMembers)) {
    s.reportMembers = parseAccountList(s.reportMembers.join(','));
    env.REPORT_MEMBERS = s.reportMembers.join(',');
    applied.push('reportMembers');
  }

  // 各地址的 Key：本机已有的保留，导入的覆盖同一地址的
  if (s.ai) {
    const host = aiKeyHost(s.ai.baseURL);
    mergedKeys = { ...(config.ai.keys || {}), ...s.ai.keys, ...(host && s.ai.apiKey ? { [host]: s.ai.apiKey } : {}) };
    env.OPENAI_API_KEYS = Buffer.from(JSON.stringify(mergedKeys), 'utf-8').toString('base64');
  }
  // 先写 .env（含换行校验）；失败则运行时配置一项都不改
  updateEnvFile(env);

  if (s.zentao) {
    Object.assign(config.zentao, s.zentao);
    const { clearCookies } = await import('./zentaoService.js');
    clearCookies();
    (await import('./account.js')).invalidateState();
  }
  if (s.ai) {
    Object.assign(config.ai, { baseURL: s.ai.baseURL, model: s.ai.model, reportModel: s.ai.reportModel, apiKey: s.ai.apiKey, keys: mergedKeys });
  }
  if (s.notify) {
    Object.assign(config.schedule, { morningHour: s.notify.morningHour, eveningHour: s.notify.eveningHour });
    Object.assign(config.webhook, { url: s.notify.webhookUrl, type: s.notify.webhookType });
  }
  if (s.prompts) Object.assign(config.prompts, s.prompts);
  if (s.reportMembers) config.reports.members = s.reportMembers;

  if (Array.isArray(s.favorites)) {
    const { setFavoriteExecutions } = await import('./executionManager.js');
    await setFavoriteExecutions(s.favorites.map(String).filter(id => /^\d{1,10}$/.test(id)));
    applied.push('favorites');
  }

  return {
    applied: applied.map(k => CONTENT_LABELS[k]),
    // 交还前端写进浏览器：设置页回填用（不含密码与 Key）
    client: {
      ...(s.client || {}),
      ...(s.ai ? { apiBaseUrl: s.ai.baseURL, aiModel: s.ai.model, aiReportModel: s.ai.reportModel } : {}),
      ...(s.notify ? { morningHour: String(s.notify.morningHour), eveningHour: String(s.notify.eveningHour), webhookUrl: s.notify.webhookUrl, webhookType: s.notify.webhookType } : {}),
      ...(s.zentao ? { zentaoEnabled: s.zentao.enabled, zentaoUrl: s.zentao.url, zentaoUsername: s.zentao.username, zentaoCreateTaskUrl: s.zentao.createTaskUrl } : {})
    }
  };
}

export { collectSettings, encryptSettings, decryptSettings, applySettings, CONTENT_LABELS, MIN_PASSPHRASE };
