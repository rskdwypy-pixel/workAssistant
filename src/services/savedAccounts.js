/**
 * 已保存的账号（地址 + 账号 + 密码），用于从头像菜单一步切换。设计见 docs/ACCOUNT-SWITCH-PRD.md。
 *
 * 存在 data/accounts.json（权限 0600，和 .env 里的禅道密码同一安全级别）。
 * 对外（接口 / 界面）永远只给 publicView()，不含密码；密码只有 get() 在后端内部取。
 * 同一个「地址 + 账号」只有一条（地址已由调用方规整），重复登录就是更新密码和最近使用时间。
 */
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, chmodSync, renameSync } from 'fs';
import { createHash } from 'crypto';
import { config } from '../config.js';

const MAX_ACCOUNTS = 10;
const file = () => join(config.paths.data, 'accounts.json');

/** 地址（已规整）+ 账号 → 稳定的短 id */
function idOf(url, username) {
  return createHash('sha1').update(`${String(url || '').toLowerCase()}|${String(username || '')}`).digest('hex').slice(0, 12);
}

function read() {
  try {
    const v = existsSync(file()) ? JSON.parse(readFileSync(file(), 'utf-8')) : null;
    return v && Array.isArray(v.accounts) ? v.accounts.filter(a => a && a.id && a.url && a.username) : [];
  } catch {
    return [];
  }
}

function write(accounts) {
  try {
    const tmp = `${file()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ accounts }, null, 2), { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmp, file());
    try { chmodSync(file(), 0o600); } catch { /* Windows 没有 chmod 语义 */ }
  } catch (err) {
    console.warn('[SavedAccounts] 写入失败:', err.message);
  }
}

/**
 * 保存 / 更新一个账号。已存在则只改传进来的字段（密码留空不覆盖）。
 * 超过上限时淘汰最近最少使用的（不会淘汰刚保存的这条）。
 */
function upsert({ url, username, password, realname, roleLabel, version }) {
  if (!url || !username) return null;
  const id = idOf(url, username);
  const now = new Date().toISOString();
  const all = read();
  const at = all.findIndex(a => a.id === id);
  const prev = at >= 0 ? all[at] : null;
  const next = {
    id, url, username,
    password: password || (prev && prev.password) || '',
    realname: realname || (prev && prev.realname) || '',
    roleLabel: roleLabel || (prev && prev.roleLabel) || '',
    version: version || (prev && prev.version) || '',
    addedAt: (prev && prev.addedAt) || now,
    lastUsedAt: now
  };
  if (at >= 0) all[at] = next; else all.push(next);
  if (all.length > MAX_ACCOUNTS) {
    all.sort((a, b) => String(b.lastUsedAt).localeCompare(String(a.lastUsedAt)));
    all.length = MAX_ACCOUNTS;
  }
  write(all);
  return next;
}

/** 内部取（含密码） */
function get(id) {
  return read().find(a => a.id === id) || null;
}

function remove(id) {
  const all = read();
  const left = all.filter(a => a.id !== id);
  if (left.length === all.length) return false;
  write(left);
  return true;
}

/** 删掉整个文件（重置为首次使用） */
function clearAll() {
  write([]);
}

/** 按最近使用排序；给界面的版本，不含密码 */
function list(currentId = '') {
  return read()
    .sort((a, b) => String(b.lastUsedAt).localeCompare(String(a.lastUsedAt)))
    .map(a => ({
      id: a.id, url: a.url, username: a.username, realname: a.realname || '', roleLabel: a.roleLabel || '',
      version: a.version || '', lastUsedAt: a.lastUsedAt, current: a.id === currentId, hasPassword: !!a.password
    }));
}

export { idOf, upsert, get, remove, clearAll, list, MAX_ACCOUNTS };
