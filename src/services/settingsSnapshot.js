/**
 * 设置的「快照」与内容指纹（rev）。
 *
 * GET /api/config 返回的就是快照；rev 是快照内容的指纹，前端缓存带着它来问「变了没」，
 * 保存时带着它做冲突检测（后端已被别处改过就拒绝，见 POST /api/config 的 baseRev）。
 * 快照里没有密码和 Key（只有「是否已设置」）。
 */
import { createHash } from 'crypto';
import { readClientSettings } from './clientSettings.js';

/** 键排序后序列化，保证同样的内容永远得到同样的字符串 */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}

const revOf = (data) => createHash('sha1').update(canonical(data)).digest('hex').slice(0, 16);

/** @returns {Promise<{data:Object, rev:string}>} */
async function buildSnapshot() {
  const configModule = await import('../config.js');
  const cfg = configModule.config;
  const client = await readClientSettings();
  const data = {
    ai: {
      apiKey: cfg.ai.apiKey ? '***已设置***' : '',
      apiBaseUrl: cfg.ai.baseURL,
      aiModel: cfg.ai.model,
      aiReportModel: cfg.ai.reportModel || '',
      // 哪些接口地址（主机）保存过 Key：设置页据此提示「已保存，留空即可」，不回传 Key 本身
      savedKeyHosts: [...new Set([...Object.keys(cfg.ai.keys || {}), ...(cfg.ai.apiKey ? [configModule.aiKeyHost(cfg.ai.baseURL)] : [])])].filter(Boolean),
      // 前端据此提示用户：AI 未配置时功能会降级，避免误以为「AI 不聪明」
      available: !!(cfg.ai.apiKey && cfg.ai.apiKey.trim()),
      unavailableReason: (!cfg.ai.apiKey || !cfg.ai.apiKey.trim())
        ? 'OPENAI_API_KEY 未配置，AI 解析与执行匹配已降级为本地规则'
        : ''
    },
    schedule: {
      morningHour: cfg.schedule.morningHour,
      eveningHour: cfg.schedule.eveningHour,
      workHours: cfg.schedule.workHours
    },
    webhook: {
      hasUrl: !!cfg.webhook.url,
      type: cfg.webhook.type || 'generic',
      // 完整地址：设置页以后端为准回填（只有本插件能访问本接口，见 requestGuard）
      url: cfg.webhook.url || '',
      urlPrefix: cfg.webhook.url ? cfg.webhook.url.substring(0, 30) + '...' : '(空)'
    },
    zentao: {
      enabled: cfg.zentao.enabled,
      url: cfg.zentao.url,
      username: cfg.zentao.username,
      hasPassword: !!cfg.zentao.password,
      createTaskUrl: cfg.zentao.createTaskUrl || ''
    },
    // 各服务商记住的地址与模型（真身在后端 data/client-settings.json，浏览器只留缓存）
    client
  };
  return { data, rev: revOf(data) };
}

export { buildSnapshot, revOf, canonical };
