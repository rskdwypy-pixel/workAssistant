/**
 * 新指派提醒：别人把任务 / Bug / 需求指派给我时提醒。
 *
 * 为什么不直接读禅道「动态」判断：动态里的「指派」记录不全——新版新建时直接指派有、旧版只有「创建」；
 * 在编辑表单里改指派人两个版本都只记「编辑」；站内消息通道（message-ajaxGetMessage）也没有被管理员打开。
 * 所以用「我的列表」做权威：每次读「指派给我」的任务 / Bug / 需求，和上次看到的比，新出现的就是新指派给我的
 * （新建时指派、改派、编辑里改、转交都能抓到，新旧版本通用）。动态只用来补充「是谁指派的」——读新对象详情里的操作历史。
 *
 * 通知通道：后台系统通知（浏览器关着也能弹）+ Webhook（群机器人）+ 插件里的未读列表。
 * 首次（或换了禅道地址 / 账号之后）只建基线，不会把存量全弹一遍。
 */
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { fetchMyList, getTaskView, getZentaoJson, isConfigured } from './zentaoService.js';
import { sendNotification } from '../utils/webhook.js';

const POLL_MS = 5 * 60 * 1000;
const FIRST_POLL_DELAY_MS = 45 * 1000;
const MAX_KEPT = 100;
/** 不会改变指派人的操作：判断「是谁指派的」时跳过 */
const NOT_ASSIGNING = new Set(['commented', 'recordestimate', 'editestimate', 'deleteestimate', 'login', 'logout', 'svncommit', 'gitcommit', 'linked2build', 'linked2release']);

const KINDS = {
  task: { label: '任务', nameOf: (i) => i.name, isOpen: (i) => !['done', 'closed', 'cancel'].includes(i.status) },
  bug: { label: 'Bug', nameOf: (i) => i.title, isOpen: (i) => !['resolved', 'closed'].includes(i.status) },
  story: { label: '需求', nameOf: (i) => i.title, isOpen: (i) => i.status !== 'closed' }
};

const dataFile = (name) => join(config.paths.data, name);
const scopeKey = () => `${String(config.zentao.url || '').replace(/\/$/, '').toLowerCase()}|${config.zentao.username || ''}`;

function readJson(file, fallback) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : fallback; } catch { return fallback; }
}
function writeJson(file, value) {
  try {
    mkdirSync(config.paths.data, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), 'utf-8');
    renameSync(tmp, file);
  } catch (err) {
    console.warn('[AssignNotify] 写入失败:', err.message);
  }
}

// ==================== 设置 ====================

const DEFAULT_SETTINGS = { enabled: true, system: true, webhook: true };

function getSettings() {
  return { ...DEFAULT_SETTINGS, ...readJson(dataFile('notify-settings.json'), {}) };
}

function saveSettings(patch = {}) {
  const next = { ...getSettings() };
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (typeof patch[k] === 'boolean') next[k] = patch[k];
  writeJson(dataFile('notify-settings.json'), next);
  return next;
}

// ==================== 通知记录（插件里的未读列表）====================

function readNotifications() {
  const v = readJson(dataFile('notifications.json'), null);
  return v && v.scope === scopeKey() && Array.isArray(v.items) ? v.items : [];
}
function writeNotifications(items) {
  writeJson(dataFile('notifications.json'), { scope: scopeKey(), items: items.slice(0, MAX_KEPT) });
}

function listNotifications() {
  const items = readNotifications();
  return { items, unread: items.filter(n => !n.read).length };
}

/** @param {string[]|'all'} ids */
function markRead(ids) {
  const items = readNotifications();
  const all = ids === 'all';
  const set = new Set(Array.isArray(ids) ? ids.map(String) : []);
  let changed = 0;
  for (const n of items) if (!n.read && (all || set.has(n.id))) { n.read = true; changed++; }
  if (changed) writeNotifications(items);
  return { changed, unread: items.filter(n => !n.read).length };
}

// ==================== 检测 ====================

const normTime = (s) => {
  const v = String(s || '');
  if (!v || v.startsWith('0000')) return '';
  const d = new Date(v.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
};
const realName = (account) => (config.zentao.users && config.zentao.users[account]) || account || '';

/**
 * 是谁把它指派给我的：取详情里的操作历史，找「指派时间」附近（没有指派时间就取最近）那条会改指派人的操作。
 * @returns {Promise<string>} 操作人账号；查不到返回 ''
 */
async function findAssigner(kind, item) {
  try {
    const inner = kind === 'task' ? await getTaskView(item.id) : await getZentaoJson(`${kind}-view-${item.id}.json?onlybody=yes`);
    const raw = inner && inner.actions;
    const list = (Array.isArray(raw) ? raw : Object.values(raw || {}))
      .filter(a => a && a.actor && !NOT_ASSIGNING.has(String(a.action)));
    if (!list.length) return '';
    const stamp = (a) => new Date(String(a.date || '').replace(' ', 'T')).getTime() || 0;
    list.sort((a, b) => stamp(a) - stamp(b) || Number(a.id) - Number(b.id));
    const at = new Date(String(item.assignedDate || '').replace(' ', 'T')).getTime();
    const near = Number.isFinite(at) ? list.filter(a => stamp(a) <= at + 60 * 1000) : [];
    return String((near.length ? near : list).slice(-1)[0].actor);
  } catch {
    return '';
  }
}

function buildRecord(kind, item, actor) {
  const def = KINDS[kind];
  const deadline = String(item.deadline || '');
  return {
    id: randomUUID(),
    kind,
    objectId: String(item.id),
    title: String(def.nameOf(item) || `${def.label} #${item.id}`),
    actor,
    actorName: actor ? realName(actor) : '',
    pri: Number(item.pri) || 0,
    deadline: deadline && !deadline.startsWith('0000') ? deadline.slice(0, 10) : '',
    url: `${String(config.zentao.url || '').replace(/\/$/, '')}/zentao/${kind}-view-${item.id}.html`,
    at: normTime(item.assignedDate) || new Date().toISOString(),
    detectedAt: new Date().toISOString(),
    read: false
  };
}

const whoText = (r) => r.actorName || '有人';

/** 实际发送的两个出口（测试里换成假的，免得真的弹系统通知 / 发群消息） */
let transport = {
  system: async (title, body) => (await import('./reminder.js')).sendSystemNotification(title, body),
  webhook: (title, content, items) => sendNotification(title, content, items)
};
function setTransport(t) { transport = { ...transport, ...t }; }

/** 推送到系统通知和 Webhook。多条合并成一条，免得一次来好几个时刷屏。 */
async function deliver(records, settings) {
  if (!records.length) return { system: false, webhook: false };
  const one = records.length === 1 ? records[0] : null;
  const title = one ? `📌 ${whoText(one)} 指派给你一个${KINDS[one.kind].label}` : `📌 有 ${records.length} 项新指派给你`;
  const line = (r) => `${KINDS[r.kind].label} #${r.objectId}「${r.title}」${r.deadline ? `（截止 ${r.deadline}）` : ''}`;
  const body = one ? line(one) : records.slice(0, 5).map(r => `${whoText(r)}：${line(r)}`).join('\n');
  const out = { system: false, webhook: false };
  if (settings.system) {
    try {
      await transport.system(title, body);
      out.system = true;
    } catch (err) { console.warn('[AssignNotify] 系统通知失败:', err.message); }
  }
  if (settings.webhook && config.webhook && config.webhook.url) {
    try {
      const items = records.slice(0, 10).map(r => `• ${whoText(r)} → ${line(r)}\n  🔗 ${r.url}`);
      await transport.webhook(title, one ? `${whoText(one)} 把${KINDS[one.kind].label}指派给你了` : `共 ${records.length} 项，最近的几项：`, items);
      out.webhook = true;
    } catch (err) { console.warn('[AssignNotify] Webhook 推送失败:', err.message); }
  }
  return out;
}

let busy = false;

/**
 * 检查一次。
 * @param {{force?:boolean}} [options] force：忽略「已关闭」开关（设置页的「立即检查」）
 * @returns {Promise<{skipped?:string, baseline?:boolean, found:number, notified:number, selfAssigned:number}>}
 */
async function pollOnce({ force = false } = {}) {
  const settings = getSettings();
  if (!settings.enabled && !force) return { skipped: 'disabled', found: 0, notified: 0, selfAssigned: 0 };
  if (!isConfigured() || !config.zentao.password) return { skipped: 'unconfigured', found: 0, notified: 0, selfAssigned: 0 };
  if (busy) return { skipped: 'busy', found: 0, notified: 0, selfAssigned: 0 };
  busy = true;
  try {
    const scope = scopeKey();
    const prev = readJson(dataFile('notify-state.json'), null);
    const sameScope = !!prev && prev.scope === scope && prev.ids && typeof prev.ids === 'object';
    const ids = sameScope ? { ...prev.ids } : {};
    const fresh = [];
    let baselineKinds = 0;
    for (const kind of Object.keys(KINDS)) {
      let items;
      try {
        items = (await fetchMyList(kind, 'assignedTo')).items || [];
      } catch (err) {
        console.warn(`[AssignNotify] 读取「指派给我的${KINDS[kind].label}」失败，这一轮跳过:`, err.message);
        continue;   // 这一类保持上次的记录，下一轮再比较
      }
      const current = items.filter(i => i && i.id != null);
      if (!sameScope || !Array.isArray(ids[kind])) {
        baselineKinds++;   // 第一次看到这一类：只建基线
      } else {
        const seen = new Set(ids[kind].map(String));
        for (const i of current) if (!seen.has(String(i.id)) && KINDS[kind].isOpen(i)) fresh.push({ kind, item: i });
      }
      ids[kind] = current.map(i => String(i.id));
    }
    if (!sameScope) writeNotifications([]);   // 换了禅道 / 账号：旧的通知记录不属于这个账号
    writeJson(dataFile('notify-state.json'), { scope, ids, at: new Date().toISOString() });
    if (!fresh.length) return { baseline: baselineKinds > 0, found: 0, notified: 0, selfAssigned: 0 };

    // 补充「是谁指派的」；自己指派给自己的不提醒
    const me = String(config.zentao.username || '');
    const records = [];
    let selfAssigned = 0;
    for (const { kind, item } of fresh) {
      const actor = await findAssigner(kind, item);
      if (actor && actor === me) { selfAssigned++; continue; }
      records.push(buildRecord(kind, item, actor));
    }
    if (records.length) {
      writeNotifications([...records, ...readNotifications()]);   // 新收到的排最前（同一轮的保持原顺序）
      if (settings.enabled) await deliver(records, settings);
    }
    console.log(`[AssignNotify] 新指派给我 ${fresh.length} 项，提醒 ${records.length} 项${selfAssigned ? `，自己指派的 ${selfAssigned} 项不提醒` : ''}`);
    return { found: fresh.length, notified: records.length, selfAssigned };
  } finally {
    busy = false;
  }
}

/** 发一条测试通知（设置页的「发送测试」）：验证系统通知和 Webhook 是否通 */
async function sendTest() {
  const settings = getSettings();
  const fake = [{ kind: 'task', objectId: '0', title: '这是一条测试提醒，不是真的任务', actor: 'test', actorName: '禅道助手', deadline: '', url: `${config.zentao.url || ''}/zentao/` }];
  const r = await deliver(fake, { ...settings, system: settings.system, webhook: settings.webhook });
  return { ...r, webhookConfigured: !!(config.webhook && config.webhook.url) };
}

let timers = [];
function start() {
  stop();
  const run = () => pollOnce().catch(err => console.warn('[AssignNotify] 检查失败:', err.message));
  timers.push(setTimeout(run, FIRST_POLL_DELAY_MS));
  timers.push(setInterval(run, POLL_MS));
  timers.forEach(t => t.unref && t.unref());
  console.log('📌 新指派提醒已启动: 每 5 分钟检查一次');
}
function stop() {
  timers.forEach(t => { clearTimeout(t); clearInterval(t); });
  timers = [];
}

export { start, stop, pollOnce, sendTest, getSettings, saveSettings, listNotifications, markRead, setTransport, KINDS, NOT_ASSIGNING };
