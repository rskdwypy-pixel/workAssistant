/**
 * 设置页里「各服务商记住的地址与模型」：aiProvider（当前服务商）、aiProfiles（各服务商的地址与两类模型）。
 *
 * 以前只存在浏览器里（清一次浏览器数据就丢，配置导出还得靠前端把它们交过来）。
 * 现在真身放后端 data/client-settings.json，浏览器只留缓存（见 extension/config-store.js）。
 * 里面没有密码和 Key（Key 按接口地址存在 .env）。
 */
import { join } from 'path';
import { config } from '../config.js';
import { readJSON, writeJSON } from '../utils/storage.js';

const file = () => join(config.paths.data, 'client-settings.json');
const MAX_BYTES = 100 * 1024;   // 防止异常数据把文件写爆

const EMPTY = () => ({ aiProvider: '', aiProfiles: {} });

/** 清洗：只留 aiProvider（字符串）和 aiProfiles（对象），其它丢掉 */
function sanitize(v) {
  const out = EMPTY();
  if (v && typeof v.aiProvider === 'string') out.aiProvider = v.aiProvider.slice(0, 64);
  if (v && v.aiProfiles && typeof v.aiProfiles === 'object' && !Array.isArray(v.aiProfiles)) out.aiProfiles = JSON.parse(JSON.stringify(v.aiProfiles));
  if (JSON.stringify(out).length > MAX_BYTES) throw new Error('服务商设置太大，已拒绝保存');
  return out;
}

async function readClientSettings() {
  try { return sanitize(await readJSON(file())); } catch { return EMPTY(); }
}

/** 保存（整体替换）。传进来的缺哪项就保持原值不动 */
async function saveClientSettings(patch = {}) {
  const cur = await readClientSettings();
  const next = sanitize({
    aiProvider: typeof patch.aiProvider === 'string' ? patch.aiProvider : cur.aiProvider,
    aiProfiles: patch.aiProfiles && typeof patch.aiProfiles === 'object' ? patch.aiProfiles : cur.aiProfiles
  });
  await writeJSON(file(), next);
  return next;
}

export { readClientSettings, saveClientSettings, sanitize as sanitizeClientSettings };
