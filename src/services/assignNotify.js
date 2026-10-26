/**
 * 提醒：别人把任务 / Bug / 需求指派给我，以及几类同样「需要我处理」的事。设计见 docs/ASSIGN-NOTIFY-PRD.md。
 *
 * 类型（设置里分别可关）：
 *   assigned  新指派给我的任务 / Bug / 需求            （默认开）
 *   review    待我评审的需求                           （默认开）
 *   confirm   我的任务关联的需求变更了，待我确认        （默认开）
 *   deadline  任务 / Bug 明天或今天截止、刚逾期        （默认开）
 *   cc        抄送给我的 Bug / 需求                    （默认关，比较吵）
 *
 * 为什么不直接读禅道「动态」判断：动态里的「指派」记录不全——新版新建时直接指派有、旧版只有「创建」；
 * 在编辑表单里改指派人两个版本都只记「编辑」；站内消息通道（message-ajaxGetMessage）也没有被管理员打开。
 * 所以用「我的列表」做权威：每次读这些列表，和上次看到的比，新出现的就是新来的
 * （新建时指派、改派、编辑里改、转交都能抓到，新旧版本通用）。动态只用来补充「是谁指派的」——读新对象详情里的操作历史。
 *
 * 通知通道：后台系统通知（浏览器关着也能弹）+ Webhook（群机器人）+ 插件里的未读列表。
 * 首次（或换了禅道地址 / 账号、或某一类刚打开）只建基线，不会把存量全弹一遍。
 */
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { fetchMyList, getTaskView, getZentaoJson, isConfigured } from './zentaoService.js';
import { sendNotification } from '../utils/webhook.js';
import { isRestToday } from '../utils/workCalendar.js';

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

/** 提醒类型：设置里的开关名 → 说明 */
const TYPES = {
  assigned: { label: '新指派给我' },
  review: { label: '待我评审' },
  confirm: { label: '需求变更待确认' },
  deadline: { label: '截止日提醒' },
  cc: { label: '抄送给我' }
};
const DEFAULT_TYPES = { assigned: true, review: true, confirm: true, deadline: true, cc: false };

/**
 * 要读的「列表」。key 是 notify-state.json 里记录这一类 ID 的名字（assigned 的三个沿用旧名 task / bug / story，升级后不用重建基线）。
 */
const LISTS = [
  { key: 'task', type: 'assigned', kind: 'task', fetch: ['task', 'assignedTo'] },
  { key: 'bug', type: 'assigned', kind: 'bug', fetch: ['bug', 'assignedTo'] },
  { key: 'story', type: 'assigned', kind: 'story', fetch: ['story', 'assignedTo'] },
  { key: 'review:story', type: 'review', kind: 'story', fetch: ['story', 'reviewedBy'], isOpen: (i) => i.status === 'reviewing' },
  { key: 'cc:bug', type: 'cc', kind: 'bug', fetch: ['bug', 'mailto'] },
  { key: 'cc:story', type: 'cc', kind: 'story', fetch: ['story', 'mailto'] }
];

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

const DEFAULT_SETTINGS = { enabled: true, system: true, webhook: true, types: DEFAULT_TYPES };

function getSettings() {
  const saved = readJson(dataFile('notify-settings.json'), {});
  return { ...DEFAULT_SETTINGS, ...saved, types: { ...DEFAULT_TYPES, ...(saved.types || {}) } };
}

function saveSettings(patch = {}) {
  const next = getSettings();
  for (const k of ['enabled', 'system', 'webhook']) if (typeof patch[k] === 'boolean') next[k] = patch[k];
  if (patch.types && typeof patch.types === 'object') {
    for (const k of Object.keys(DEFAULT_TYPES)) if (typeof patch.types[k] === 'boolean') next.types[k] = patch.types[k];
  }
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

/** 截止日距今天的天数（今天=0，明天=1，昨天=-1）；没有有效截止日返回 null */
function daysUntil(deadline, now = new Date()) {
  const m = String(deadline || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m || m[1] === '0000') return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((d.getTime() - t.getTime()) / 86400000);
}

/** 截止日提醒的档位：明天截止 / 今天截止 / 刚逾期（最近 3 天内）；其余不提醒 */
function deadlineLevel(days) {
  if (days === null) return '';
  if (days === 1) return 'tomorrow';
  if (days === 0) return 'today';
  if (days < 0 && days >= -3) return 'over';
  return '';
}
const LEVEL_RANK = { '': 0, tomorrow: 1, today: 2, over: 3 };

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

function buildRecord(type, kind, item, extra = {}) {
  const def = KINDS[kind];
  const deadline = String(item.deadline || '');
  return {
    id: randomUUID(),
    type,
    kind,
    objectId: String(item.id),
    title: String(def.nameOf(item) || `${def.label} #${item.id}`),
    actor: extra.actor || '',
    actorName: extra.actor ? realName(extra.actor) : '',
    pri: Number(item.pri) || 0,
    deadline: deadline && !deadline.startsWith('0000') ? deadline.slice(0, 10) : '',
    days: extra.days ?? null,
    url: `${String(config.zentao.url || '').replace(/\/$/, '')}/zentao/${kind}-view-${item.id}.html`,
    at: normTime(type === 'assigned' ? item.assignedDate : '') || new Date().toISOString(),
    detectedAt: new Date().toISOString(),
    read: false
  };
}

const whoText = (r) => r.actorName || '有人';

/** 一条提醒的一句话描述（系统通知 / Webhook / 插件列表共用） */
function describe(r) {
  const label = KINDS[r.kind].label;
  switch (r.type) {
    case 'review': return `${whoText(r)} 请你评审${label} #${r.objectId}`;
    case 'cc': return `${whoText(r)} 抄送了${label} #${r.objectId} 给你`;
    case 'confirm': return `${label} #${r.objectId} 关联的需求变更了，请确认`;
    case 'deadline':
      return r.days === 0 ? `${label} #${r.objectId} 今天截止` : r.days === 1 ? `${label} #${r.objectId} 明天截止` : `${label} #${r.objectId} 已逾期 ${Math.abs(r.days)} 天`;
    default: return `${whoText(r)} 指派了${label} #${r.objectId}`;
  }
}

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
  const title = one ? `📌 ${describe(one)}` : `📌 有 ${records.length} 项提醒`;
  const line = (r) => `${KINDS[r.kind].label}「${r.title}」${r.deadline && r.type !== 'deadline' ? `（截止 ${r.deadline}）` : ''}`;
  const body = one ? line(one) : records.slice(0, 5).map(r => `${describe(r)}：${r.title}`).join('\n');
  const out = { system: false, webhook: false };
  if (settings.system) {
    try {
      await transport.system(title, body);
      out.system = true;
    } catch (err) { console.warn('[AssignNotify] 系统通知失败:', err.message); }
  }
  if (settings.webhook && config.webhook && config.webhook.url) {
    try {
      const items = records.slice(0, 10).map(r => `• ${describe(r)}：${r.title}\n  🔗 ${r.url}`);
      await transport.webhook(title, one ? line(one) : `共 ${records.length} 项，最近的几项：`, items);
      out.webhook = true;
    } catch (err) { console.warn('[AssignNotify] Webhook 推送失败:', err.message); }
  }
  return out;
}

let busy = false;

/**
 * 检查一次。
 * @param {{force?:boolean, now?:Date}} [options] force：忽略「已关闭」开关（设置页的「立即检查」）；now：测试用
 * @returns {Promise<{skipped?:string, baseline?:boolean, found:number, notified:number, selfAssigned:number}>}
 */
async function pollOnce({ force = false, now = new Date() } = {}) {
  const settings = getSettings();
  const none = { found: 0, notified: 0, selfAssigned: 0 };
  if (!settings.enabled && !force) return { skipped: 'disabled', ...none };
  if (!isConfigured() || !config.zentao.password) return { skipped: 'unconfigured', ...none };
  if (busy) return { skipped: 'busy', ...none };
  busy = true;
  try {
    const scope = scopeKey();
    const prev = readJson(dataFile('notify-state.json'), null);
    const sameScope = !!prev && prev.scope === scope && prev.ids && typeof prev.ids === 'object';
    const ids = sameScope ? { ...prev.ids } : {};
    const deadlines = sameScope && prev.deadlines && typeof prev.deadlines === 'object' ? { ...prev.deadlines } : null;   // null = 还没建过截止日基线
    const types = settings.types;
    const fresh = [];   // { type, kind, item, extra? }
    let baselineKeys = 0;
    const fetched = {}; // key → 当前列表（供 confirm / deadline 复用）

    // 1) 读各个「列表」，新出现的 = 新来的
    const needTask = types.assigned || types.confirm || types.deadline;
    const needBug = types.assigned || types.deadline;
    for (const def of LISTS) {
      const wanted = def.type === 'assigned'
        ? (def.kind === 'task' ? needTask : def.kind === 'bug' ? needBug : types.assigned)
        : types[def.type];
      if (!wanted) continue;
      let items;
      try {
        items = (await fetchMyList(def.fetch[0], def.fetch[1])).items || [];
      } catch (err) {
        console.warn(`[AssignNotify] 读取「${def.key}」失败，这一轮跳过:`, err.message);
        continue;   // 这一类保持上次的记录，下一轮再比较
      }
      const current = items.filter(i => i && i.id != null);
      fetched[def.key] = current;
      const isOpen = def.isOpen || KINDS[def.kind].isOpen;
      if (!sameScope || !Array.isArray(ids[def.key])) {
        baselineKeys++;   // 第一次看到这一类：只建基线
      } else if (def.type !== 'assigned' || types.assigned) {
        const seen = new Set(ids[def.key].map(String));
        for (const i of current) if (!seen.has(String(i.id)) && isOpen(i)) fresh.push({ type: def.type, kind: def.kind, item: i });
      }
      ids[def.key] = current.map(i => String(i.id));
    }

    // 2) 需求变更待确认：「指派给我」的任务里 needConfirm 新变成 1 的
    if (types.confirm && fetched.task) {
      const flagged = fetched.task.filter(t => (t.needConfirm === true || String(t.needConfirm) === '1') && KINDS.task.isOpen(t));
      if (!sameScope || !Array.isArray(ids['confirm:task'])) baselineKeys++;
      else {
        const seen = new Set(ids['confirm:task'].map(String));
        for (const t of flagged) if (!seen.has(String(t.id))) fresh.push({ type: 'confirm', kind: 'task', item: t });
      }
      ids['confirm:task'] = flagged.map(t => String(t.id));
    }

    // 3) 截止日：任务 / Bug 的档位升高（无 → 明天 → 今天 → 刚逾期）时各提醒一次；休息日不处理（上班日再算）
    let nextDeadlines = deadlines;
    if (types.deadline && !isRestToday(now)) {
      const levels = {};
      for (const kind of ['task', 'bug']) {
        for (const i of fetched[kind] || []) {
          if (!KINDS[kind].isOpen(i)) continue;
          const days = daysUntil(i.deadline, now);
          const level = deadlineLevel(days);
          if (level) levels[`${kind}:${i.id}`] = { level, kind, item: i, days };
        }
      }
      nextDeadlines = {};
      for (const [k, v] of Object.entries(levels)) {
        nextDeadlines[k] = v.level;
        // 第一次建基线时不提醒（免得升级后一下子弹出一堆）；之后档位升高（明天→今天→逾期）才提醒，延期导致档位回退不提醒
        if (deadlines !== null && LEVEL_RANK[v.level] > LEVEL_RANK[deadlines[k] || '']) {
          fresh.push({ type: 'deadline', kind: v.kind, item: v.item, extra: { days: v.days } });
        }
      }
      if (deadlines === null) baselineKeys++;
    }

    if (!sameScope) writeNotifications([]);   // 换了禅道 / 账号：旧的通知记录不属于这个账号
    writeJson(dataFile('notify-state.json'), { scope, ids, deadlines: nextDeadlines, at: new Date().toISOString() });
    if (!fresh.length) return { baseline: baselineKeys > 0, ...none };

    // 4) 补充「是谁」；自己指派给自己的不提醒
    const me = String(config.zentao.username || '');
    const records = [];
    let selfAssigned = 0;
    for (const f of fresh) {
      let actor = '';
      if (f.type === 'assigned') {
        actor = await findAssigner(f.kind, f.item);
        if (actor && actor === me) { selfAssigned++; continue; }
      } else if (f.type === 'review' || f.type === 'cc') {
        actor = String(f.item.openedBy || '');
        if (actor && actor === me) { selfAssigned++; continue; }
      }
      records.push(buildRecord(f.type, f.kind, f.item, { actor, ...(f.extra || {}) }));
    }
    if (records.length) {
      writeNotifications([...records, ...readNotifications()]);   // 新收到的排最前（同一轮的保持原顺序）
      if (settings.enabled) await deliver(records, settings);
    }
    console.log(`[AssignNotify] 新提醒 ${fresh.length} 项，发出 ${records.length} 项${selfAssigned ? `，自己指派 / 创建的 ${selfAssigned} 项不提醒` : ''}`);
    return { found: fresh.length, notified: records.length, selfAssigned };
  } finally {
    busy = false;
  }
}

/** 发一条测试通知（设置页的「发送测试」）：验证系统通知和 Webhook 是否通 */
async function sendTest() {
  const settings = getSettings();
  const fake = [{ type: 'assigned', kind: 'task', objectId: '0', title: '这是一条测试提醒，不是真的任务', actor: 'test', actorName: '禅道助手', deadline: '', url: `${config.zentao.url || ''}/zentao/` }];
  const r = await deliver(fake, settings);
  return { ...r, webhookConfigured: !!(config.webhook && config.webhook.url) };
}

let timers = [];
function start() {
  stop();
  const run = () => pollOnce().catch(err => console.warn('[AssignNotify] 检查失败:', err.message));
  timers.push(setTimeout(run, FIRST_POLL_DELAY_MS));
  timers.push(setInterval(run, POLL_MS));
  timers.forEach(t => t.unref && t.unref());
  console.log('📌 提醒已启动: 每 5 分钟检查一次');
}
function stop() {
  timers.forEach(t => { clearTimeout(t); clearInterval(t); });
  timers = [];
}

export {
  start, stop, pollOnce, sendTest, getSettings, saveSettings, listNotifications, markRead, setTransport,
  describe, daysUntil, deadlineLevel, KINDS, TYPES, DEFAULT_TYPES, NOT_ASSIGNING
};
