import { createHash } from 'crypto';
import { join } from 'path';

/**
 * 请求来源校验
 *
 * 后端只监听 127.0.0.1，但这不等于「只有自己人能访问」：浏览器里任何网页都能
 * fetch http://127.0.0.1:3721，请求的源 IP 同样是 127.0.0.1。旧实现 CORS 全放行、
 * 只校验 IP，任意网页都能读走禅道密码、改 AI 地址、关掉后端。
 *
 * 规则：
 *   1. Host 必须是 127.0.0.1 / localhost（防 DNS rebinding）
 *   2. 带 Origin 的请求（浏览器跨源请求一定带）：只放行本插件和后端自身
 *   3. 不带 Origin 的请求：命令行 / 脚本 / 直接在地址栏打开，放行；
 *      但浏览器标记为跨站（Sec-Fetch-Site: cross-site / same-site）的一律拒绝
 */

/**
 * unpacked 扩展的 ID 由扩展目录绝对路径派生（与 scripts/install-native-host.sh 同一算法）：
 * SHA-256 前 32 个十六进制字符，0-9a-f 映射为 a-p
 */
function extensionIdFromPath(dir) {
  const hex = createHash('sha256').update(dir).digest('hex').slice(0, 32);
  return [...hex].map(ch => String.fromCharCode(97 + parseInt(ch, 16))).join('');
}

/**
 * 允许访问后端的扩展 ID：按当前仓库路径计算 + WORKASSISTANT_EXT_IDS（逗号分隔）补充
 * （从其他目录加载插件、或使用打包后的固定 ID 时用环境变量补充）
 */
function allowedExtensionIds(projectRoot) {
  const ids = new Set([extensionIdFromPath(join(projectRoot, 'extension'))]);
  String(process.env.WORKASSISTANT_EXT_IDS || process.env.WORKASSISTANT_EXT_ID || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .forEach(id => ids.add(id));
  return ids;
}

/**
 * @param {{ port: number, projectRoot: string }} options
 * @returns {import('express').RequestHandler}
 */
function createRequestGuard({ port, projectRoot }) {
  const extIds = allowedExtensionIds(projectRoot);
  const allowedOrigins = new Set([
    ...[...extIds].map(id => `chrome-extension://${id}`),
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`
  ]);
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  console.log('[Guard] 允许的扩展 ID:', [...extIds].join(', '));

  const reject = (req, res, reason) => {
    console.warn(`[Guard] 拒绝请求 ${req.method} ${req.path}: ${reason}`);
    res.status(403).json({
      success: false,
      error: 'forbidden',
      message: `请求来源不被允许（${reason}）。若插件从其他目录加载，请在 .env 中设置 WORKASSISTANT_EXT_IDS=<扩展ID> 后重启服务`
    });
  };

  return (req, res, next) => {
    const host = String(req.headers.host || '').toLowerCase();
    if (!allowedHosts.has(host)) {
      return reject(req, res, `Host ${host || '(空)'}`);
    }

    const origin = req.headers.origin;
    if (origin) {
      if (!allowedOrigins.has(origin)) {
        return reject(req, res, `Origin ${origin}`);
      }
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Vary', 'Origin');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
    } else {
      const site = req.headers['sec-fetch-site'];
      if (site === 'cross-site' || site === 'same-site') {
        return reject(req, res, `Sec-Fetch-Site ${site}`);
      }
    }

    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  };
}

export { createRequestGuard, extensionIdFromPath };
