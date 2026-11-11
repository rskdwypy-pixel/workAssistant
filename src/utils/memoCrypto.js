/**
 * 备忘录加密：scrypt 口令派生密钥 + AES-256-GCM
 *
 * 复用 configTransfer.js 的加密思路，适配备忘录场景：
 *   - 口令 = 禅道用户 ID（String(user.id)），登录即用、无需设置
 *   - 每条备忘录一个加密包（salt/iv/tag 随密文存禅道文档正文）
 *   - 文档正文格式：MEMO_V1:base64(JSON.stringify(encrypted))
 *
 * 禅道上看到的是 MEMO_V1:U2FsdGVkX1... 这样的文本，无法解读。
 */
import crypto from 'crypto';

const KDF = { name: 'scrypt', N: 32768, r: 8, p: 1 };
const PREFIX = 'MEMO_V1:';

/** scrypt 口令派生密钥（与 configTransfer 一致） */
function deriveKey(passphrase, salt, kdf = KDF) {
  return crypto.scryptSync(String(passphrase).normalize('NFC'), salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 128 * kdf.N * kdf.r * 2 });
}

/**
 * 加密备忘录正文
 * @param {Object} memo - 备忘录明文（不含 title，标题以文档标题为准）
 * @param {string|number} userId - 禅道用户 ID（口令）
 * @returns {string} 文档正文 = MEMO_V1:base64(encrypted)
 */
function encryptMemo(memo, userId) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const plain = JSON.stringify({ v: 1, ...memo });
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(String(userId), salt), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()]);
  const encrypted = {
    userId: Number(userId),
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    updatedAt: memo.updatedAt || new Date().toISOString(),
    data: data.toString('base64')
  };
  return PREFIX + Buffer.from(JSON.stringify(encrypted), 'utf-8').toString('base64');
}

/**
 * 解密备忘录正文
 * @param {string} bodyText - 文档正文（MEMO_V1:base64(...)）
 * @param {string|number} userId - 禅道用户 ID（口令）
 * @returns {Object} 备忘录明文
 * @throws {Error} 前缀不对 / 格式不对 / 用户不匹配 / 口令不正确 / 密文被篡改
 */
function decryptMemo(bodyText, userId) {
  if (!bodyText || !String(bodyText).startsWith(PREFIX)) {
    throw new Error('不是备忘录加密内容');
  }
  const json = Buffer.from(String(bodyText).slice(PREFIX.length), 'base64').toString('utf-8');
  let body;
  try { body = JSON.parse(json); } catch { throw new Error('备忘录加密包格式不对'); }
  if (!body || typeof body !== 'object' || !body.salt || !body.iv || !body.tag || !body.data) {
    throw new Error('备忘录加密包不完整');
  }
  if (body.userId !== Number(userId)) {
    throw new Error('这份备忘录属于其他用户');
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(String(userId), Buffer.from(body.salt, 'base64')), Buffer.from(body.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(body.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(body.data, 'base64')), decipher.final()]).toString('utf-8');
    return JSON.parse(plain);
  } catch {
    throw new Error('解密失败：口令不正确或密文已被篡改');
  }
}

/** 判断正文是否是备忘录加密内容 */
function isMemoEncrypted(bodyText) {
  return !!bodyText && String(bodyText).startsWith(PREFIX);
}

export { encryptMemo, decryptMemo, isMemoEncrypted, deriveKey };
