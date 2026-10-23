/**
 * 工时（工作日历的数据层）。所有工时以禅道为准，本地只做缓存。
 *
 *   getMonthEfforts(month)   我这个月每天填了多少、填在哪些任务上
 *   getDayHours(date)        某天已填小时数（任务卡片「今日已工作」用）
 *   addEffort(...)           记工时（可补填过去的日期），写入禅道
 *   listFillableTasks()      填报下拉：我能记工时的任务
 *
 * 数据怎么来：
 *   1. 取「我相关的任务」（地盘 → 我的任务：指派给我 / 我创建 / 我完成 / 我关闭 / 我取消）并集，几个请求；
 *   2. 只看「周期开始后改动过」的任务（记工时会刷新任务的最后编辑时间，没改过的不可能有周期内工时）；
 *   3. 逐任务读工时记录，按「任务 id + 最后编辑时间 + 累计消耗」做缓存键：没变的任务不再请求禅道。
 * 局限：只覆盖「我相关的任务」。别人的任务上我记过工时、而我既不是负责人也没创建 / 完成过它，不会出现——
 * 等确认禅道有「我的日志」汇总接口后可以补齐。
 */
import { fetchMyList, getTaskEfforts, recordTaskEstimate, editTaskEstimate, deleteTaskEstimate, isConfigured, getZentaoCookies, cookiesToString, getTeamMembers, listExecutionTasks } from './zentaoService.js';
import { createCache, singleFlight } from './zentaoCache.js';
import { decodeZentaoText } from '../utils/text.js';
import { isRestDay } from '../utils/workCalendar.js';
import { config } from '../config.js';

const MY_TASK_LISTS = ['assignedTo', 'openedBy', 'finishedBy', 'closedBy', 'canceledBy'];
const FILLABLE_STATUS = new Set(['wait', 'doing', 'pause']);
const cache = createCache('efforts');            // 我的（我相关的任务）
const teamCache = createCache('efforts-team');  // 全员（所有执行的任务）；日报 / 周报 / 月报采集也共用它

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const round1 = (n) => Math.round(n * 10) / 10;
const dayPart = (v) => { const s = String(v || ''); return /^\d{4}-\d{2}-\d{2}/.test(s) && !s.startsWith('0000') ? s.slice(0, 10) : ''; };

/** 每天标准工时（小时），服务端配置，设置页可改 */
const standardHours = () => Number(config.schedule.workHours) > 0 ? Number(config.schedule.workHours) : 8;

function assertReady() {
  if (!isConfigured()) {
    const err = new Error('禅道未启用或未配置');
    err.code = 'ZENTAO_DISABLED';
    throw err;
  }
}

/** 并发上限的 map */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

/** 缓存条目最多信任多久：禅道网页上只改了某条工时的日期 / 内容时，任务签名不变，靠它兜底自愈 */
const ENTRY_TTL_MS = 6 * 60 * 60 * 1000;
const entryFresh = (e) => !!(e && e.at && Date.now() - e.at < ENTRY_TTL_MS);

/** 缓存键：任务改过 / 累计消耗变了，就重读它的工时 */
const taskSig = (t) => `${t.lastEditedDate || ''}|${t.consumed ?? ''}`;

/** 我相关的任务（几种关联取并集，并行请求；全部失败才报错） */
async function fetchMyTasks(CH) {
  const settled = await Promise.all(MY_TASK_LISTS.map(type => fetchMyList('task', type, CH).then(r => ({ r }), error => ({ error }))));
  const ok = settled.filter(x => x.r);
  if (!ok.length) throw (settled[0] && settled[0].error) || new Error('无法从禅道获取任务');
  const byId = new Map();
  for (const { r } of ok) for (const t of r.items) if (t && t.id && String(t.deleted) !== '1') byId.set(String(t.id), t);
  return [...byId.values()];
}

/**
 * 同步：保证 from 之后改动过的我相关任务的工时都在缓存里。
 * @returns {Promise<{syncedAt:number, reread:number, total:number}>}
 */
function sync(from) {
  return singleFlight(`efforts:${from}`, async () => {
    assertReady();
    const CH = cookiesToString(await getZentaoCookies());
    const mine = await fetchMyTasks(CH);
    const old = (cache.read() && cache.read().tasks) || {};
    const tasks = {};
    const todo = [];
    for (const t of mine) {
      const id = String(t.id);
      const sig = taskSig(t);
      // 周期开始后没改过的任务不可能有周期内的工时；已经缓存过的、签名没变的直接沿用
      if (old[id] && old[id].sig === sig && entryFresh(old[id])) { tasks[id] = old[id]; continue; }
      const edited = dayPart(t.lastEditedDate);
      if (edited && edited < from) { if (old[id]) tasks[id] = old[id]; continue; }
      todo.push({ id, sig, t });
    }
    await mapLimit(todo, 6, async ({ id, sig, t }) => {
      try {
        const efforts = await getTaskEfforts(id, CH);
        tasks[id] = {
          sig,
          at: Date.now(),
          name: decodeZentaoText(t.name || `任务 #${id}`),
          exec: decodeZentaoText(t.executionName || ''),
          efforts
        };
      } catch {
        if (old[id]) tasks[id] = old[id];   // 读失败就沿用旧的，不让一个任务拖垮整页
      }
    });
    const syncedAt = Date.now();
    cache.write({ tasks, syncedAt });
    return { syncedAt, reread: todo.length, total: mine.length };
  });
}

/** 某账号在 [from,to] 内的工时按天汇总 */
function aggregate(tasks, account, from, to) {
  const me = String(account || '').toLowerCase();
  const days = {};
  for (const [taskId, t] of Object.entries(tasks || {})) {
    for (const e of t.efforts || []) {
      if (String(e.account).toLowerCase() !== me) continue;
      if (e.date < from || e.date > to || !(e.consumed > 0)) continue;
      const d = days[e.date] || (days[e.date] = { hours: 0, items: [] });
      d.hours = round1(d.hours + e.consumed);
      d.items.push({ effortId: e.id, taskId, taskName: t.name, execName: t.exec, consumed: e.consumed, left: e.left, work: e.work });
    }
  }
  return days;
}

function monthRange(month) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('月份格式应为 YYYY-MM');
  const [y, m] = month.split('-').map(Number);
  return { from: `${month}-01`, to: ymd(new Date(y, m, 0)) };
}

/**
 * 我这个月的工时。
 * @param {string} month YYYY-MM
 * @param {{cacheOnly?:boolean, maxAge?:number}} opts  cacheOnly 只读缓存（没有返回 days:null）；maxAge 缓存够新就不请求禅道
 */
async function getMonthEfforts(month, { cacheOnly = false, maxAge = 0 } = {}) {
  assertReady();
  const { from, to } = monthRange(month);
  const base = { month, standard: standardHours(), me: config.zentao.username || '' };
  const c = cache.read();
  if (cacheOnly) {
    return { ...base, days: c ? aggregate(c.tasks, base.me, from, to) : null, syncedAt: c ? c.syncedAt || 0 : 0, fromCache: true };
  }
  if (c && maxAge > 0 && Date.now() - (c.syncedAt || 0) < maxAge) {
    return { ...base, days: aggregate(c.tasks, base.me, from, to), syncedAt: c.syncedAt, fromCache: true };
  }
  const r = await sync(from);
  const fresh = cache.read();
  return { ...base, days: aggregate(fresh.tasks, base.me, from, to), syncedAt: r.syncedAt, fromCache: false, reread: r.reread };
}

/** 某天已填小时数（任务卡片「今日已工作」）。缓存 60 秒内的直接用 */
async function getDayHours(date = ymd(new Date())) {
  const r = await getMonthEfforts(date.slice(0, 7), { maxAge: 60 * 1000 });
  const d = r.days[date];
  return { date, hours: d ? d.hours : 0, standard: r.standard, syncedAt: r.syncedAt };
}

/** 填报下拉：指派给我、还没完成的任务（进行中的排前面） */
async function listFillableTasks() {
  assertReady();
  const CH = cookiesToString(await getZentaoCookies());
  const { items } = await fetchMyList('task', 'assignedTo', CH);
  const rank = { doing: 0, wait: 1, pause: 2 };
  return items
    .filter(t => t && t.id && String(t.deleted) !== '1' && FILLABLE_STATUS.has(t.status))
    .map(t => ({
      id: String(t.id),
      name: decodeZentaoText(t.name || ''),
      execName: decodeZentaoText(t.executionName || ''),
      status: t.status,
      estimate: Number(t.estimate) || 0,
      consumed: Number(t.consumed) || 0,
      left: Number(t.left) || 0,
      lastEditedDate: String(t.lastEditedDate || '')
    }))
    .sort((a, b) => rank[a.status] - rank[b.status] || b.lastEditedDate.localeCompare(a.lastEditedDate));
}

/** 工时入参校验（新增和修改共用），返回规整后的值；不合格直接抛带原因的错 */
function normalizeEffortInput({ date, consumed, left, work, finish } = {}) {
  const today = ymd(new Date());
  const day = date || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('日期格式应为 YYYY-MM-DD');
  if (day > today) throw new Error('不能给将来的日期填工时');
  const hours = Number(consumed);
  if (!(hours > 0) || hours > 24) throw new Error('消耗工时应大于 0 且不超过 24 小时');
  if (left === undefined || left === null || String(left).trim() === '') throw new Error('请填写剩余工时（填 0 表示这个任务做完了）');
  const remain = Number(left);
  if (!(remain >= 0)) throw new Error('剩余工时不能为负数');
  if (!String(work || '').trim()) throw new Error('请填写工作内容（它会进入日报）');
  // 剩余填 0：禅道网页上会弹确认「任务将标记为已完成」；直接调接口没有这个确认，会静默把任务标成已完成，
  // 所以必须由调用方（界面）明确确认后带 finish:true 再来
  if (remain === 0 && finish !== true) {
    const err = new Error('剩余工时为 0：禅道会把这个任务标记为「已完成」。确认要完成吗？');
    err.code = 'CONFIRM_FINISH';
    throw err;
  }
  return { date: day, consumed: hours, left: remain, work: String(work).trim() };
}

/**
 * 记工时（写入禅道）。date 可以是过去的日期（补填），不能是将来。
 * 成功后让该任务的工时缓存失效，下次读取会重新向禅道要。
 */
async function addEffort({ taskId, date, consumed, left, work, finish } = {}) {
  assertReady();
  if (!/^\d+$/.test(String(taskId || ''))) throw new Error('请选择任务');
  const v = normalizeEffortInput({ date, consumed, left, work, finish });
  const r = await recordTaskEstimate(taskId, { work: v.work, consumed: v.consumed, left: v.left, date: v.date });
  if (r && r.success) invalidateTask(taskId);
  return r;
}

/** 读出这条工时（必须是我自己的）。找不到 / 不是我的就抛错 */
async function loadOwnEffort(taskId, effortId, CH) {
  if (!/^\d+$/.test(String(taskId || ''))) throw new Error('请选择任务');
  if (!/^\d+$/.test(String(effortId || ''))) throw new Error('非法的工时记录 ID');
  const list = await getTaskEfforts(taskId, CH);
  const e = list.find(x => x.id === String(effortId));
  if (!e) throw new Error('这条工时已经不存在了（可能已在别处删除），请刷新后再试');
  if (String(e.account).toLowerCase() !== String(config.zentao.username || '').toLowerCase()) throw new Error('只能修改自己的工时');
  return e;
}

/**
 * 修改一条工时（日期 / 消耗 / 剩余 / 工作内容）。禅道返回的是 HTML 脚本片段，没有可靠的成功标志，
 * 所以改完会重新读一次工时记录核对，核对不上就报错，不让界面误以为成功。
 */
async function editEffort({ taskId, effortId, date, consumed, left, work, finish } = {}) {
  assertReady();
  const v = normalizeEffortInput({ date, consumed, left, work, finish });
  const CH = cookiesToString(await getZentaoCookies());
  await loadOwnEffort(taskId, effortId, CH);
  const r = await editTaskEstimate(effortId, v);
  invalidateTask(taskId);
  if (!r.success) throw new Error(r.message || '禅道没有接受这次修改');
  const after = (await getTaskEfforts(taskId, CH)).find(x => x.id === String(effortId));
  if (!after || after.date !== v.date || Math.abs(after.consumed - v.consumed) > 1e-9) throw new Error('禅道没有接受这次修改（回读核对不一致），请刷新后重试');
  return { success: true, message: '工时已修改' };
}

/** 删除一条工时（必须是我自己的）。删完回读核对记录确实没了 */
async function deleteEffort({ taskId, effortId } = {}) {
  assertReady();
  const CH = cookiesToString(await getZentaoCookies());
  await loadOwnEffort(taskId, effortId, CH);
  const r = await deleteTaskEstimate(effortId);
  invalidateTask(taskId);
  if (!r.success) throw new Error(r.message || '禅道没有删除这条工时');
  const still = (await getTaskEfforts(taskId, CH)).some(x => x.id === String(effortId));
  if (still) throw new Error('删除没有生效（回读核对这条工时还在），请刷新后重试');
  return { success: true, message: '工时已删除' };
}

/** 让某任务的工时缓存失效（写操作之后调用）：「我的」和「全员」两份都清 */
function invalidateTask(taskId) {
  const id = String(taskId);
  const c = cache.read();
  if (c && c.tasks) {
    const tasks = { ...c.tasks };
    delete tasks[id];
    cache.write({ tasks, syncedAt: 0 });
  }
  const t = teamCache.read();
  if (t && t.tasks && t.tasks[id]) {
    const tasks = { ...t.tasks };
    delete tasks[id];
    teamCache.write({ tasks, syncedAt: 0 });
  }
}

/* ───────────────────────── 全员 ───────────────────────── */

const EXCLUDED_ACCOUNTS = new Set(['admin']);

/** 执行下的全部任务（所有执行并行拉，带最后编辑时间与累计消耗） */
async function fetchAllExecutionTasks(CH) {
  const { getExecutions } = await import('./executionManager.js');
  const executions = (await getExecutions()) || [];
  const lists = await mapLimit(executions, 12, async (e) => {
    try {
      return (await listExecutionTasks(e.id, CH)).map(t => ({ ...t, executionName: e.name, projectName: e.projectName || e.name }));
    } catch { return []; }
  });
  const byId = new Map();
  for (const t of lists.flat()) if (t && t.id && String(t.deleted) !== '1' && !byId.has(String(t.id))) byId.set(String(t.id), t);
  return [...byId.values()];
}

/** 全员同步：和「我的」同样按任务缓存，只重读改动过的任务的工时 */
function syncTeam(from) {
  return singleFlight(`efforts-team:${from}`, async () => {
    assertReady();
    const CH = cookiesToString(await getZentaoCookies());
    const all = await fetchAllExecutionTasks(CH);
    const old = (teamCache.read() && teamCache.read().tasks) || {};
    const tasks = {};
    const todo = [];
    for (const t of all) {
      const id = String(t.id);
      const sig = taskSig(t);
      const meta = { name: decodeZentaoText(t.name || `任务 #${id}`), exec: decodeZentaoText(t.executionName || ''), project: decodeZentaoText(t.projectName || '') };
      if (old[id] && old[id].sig === sig && entryFresh(old[id])) { tasks[id] = { ...old[id], ...meta }; continue; }
      const edited = dayPart(t.lastEditedDate);
      if (edited && edited < from) { if (old[id]) tasks[id] = { ...old[id], ...meta }; continue; }
      todo.push({ id, sig, meta });
    }
    await mapLimit(todo, 6, async ({ id, sig, meta }) => {
      try { tasks[id] = { sig, at: Date.now(), ...meta, efforts: await getTaskEfforts(id, CH) }; }
      catch { if (old[id]) tasks[id] = old[id]; }
    });
    const syncedAt = Date.now();
    teamCache.write({ tasks, syncedAt });
    return { syncedAt, reread: todo.length, total: all.length };
  });
}

/** 全员在 [from,to] 内的工时：按人、按天汇总 */
function aggregateTeam(tasks, members, from, to) {
  const byAccount = new Map(members.map(m => [m.account.toLowerCase(), m]));
  const people = new Map(members.map(m => [m.account, { account: m.account, name: m.realname || m.account, role: m.role || '', hours: 0, byDay: {} }]));
  const days = {};
  for (const t of Object.values(tasks || {})) {
    for (const e of t.efforts || []) {
      const m = byAccount.get(String(e.account).toLowerCase());
      if (!m || e.date < from || e.date > to || !(e.consumed > 0)) continue;
      const p = people.get(m.account);
      p.hours = round1(p.hours + e.consumed);
      p.byDay[e.date] = round1((p.byDay[e.date] || 0) + e.consumed);
      const d = days[e.date] || (days[e.date] = { total: 0, byMember: {} });
      d.total = round1(d.total + e.consumed);
      d.byMember[m.account] = round1((d.byMember[m.account] || 0) + e.consumed);
    }
  }
  return { members: [...people.values()].sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name, 'zh')), days };
}

/** 全员统计的成员范围：团队全员（不含 admin）；设置里配了「全员报告关注的用户」就只统计这些人 */
async function teamMembers({ offline = false } = {}) {
  const focus = new Set(config.reports && config.reports.members || []);
  // offline：只读缓存时不去请求禅道，用本地已有的用户列表（账号 → 姓名）
  const list = offline
    ? Object.entries(config.zentao.users || {}).map(([account, realname]) => ({ account, realname, role: '' }))
    : await getTeamMembers();
  return list
    .filter(m => !EXCLUDED_ACCOUNTS.has(m.account))
    .filter(m => !focus.size || focus.has(m.account));
}

/**
 * 全员这个月的工时（热力图 / 全员视角用）。参数含义同 getMonthEfforts。
 * 第一次要读所有执行的任务和工时，比较慢（几十秒量级，视任务数）；之后只读改动过的任务。
 */
async function getTeamMonthEfforts(month, { cacheOnly = false, maxAge = 0 } = {}) {
  assertReady();
  const { from, to } = monthRange(month);
  const base = { month, standard: standardHours() };
  const c = teamCache.read();
  const build = async (src, syncedAt, fromCache, extra = {}) => {
    const members = await teamMembers({ offline: fromCache }).catch(() => []);
    return { ...base, ...aggregateTeam(src.tasks, members, from, to), syncedAt, fromCache, ...extra };
  };
  if (cacheOnly) {
    if (!c) return { ...base, members: null, days: null, syncedAt: 0, fromCache: true };
    return build(c, c.syncedAt || 0, true);
  }
  if (c && maxAge > 0 && Date.now() - (c.syncedAt || 0) < maxAge) return build(c, c.syncedAt, true);
  const r = await syncTeam(from);
  return build(teamCache.read(), r.syncedAt, false, { reread: r.reread });
}

/* ───────────────────────── 报告共用的工时缓存 ───────────────────────── */

/** 报告采集用：缓存里有这个任务（签名一致）的工时就直接用，否则返回 null */
function cachedTaskEfforts(taskId, sig) {
  const c = teamCache.read();
  const e = c && c.tasks && c.tasks[String(taskId)];
  return e && e.sig === sig && entryFresh(e) ? e.efforts : null;
}

/** 报告采集用：把刚读到的任务工时批量写进缓存（一次落盘） */
function storeTaskEfforts(entries) {
  const keys = Object.keys(entries || {});
  if (!keys.length) return;
  const c = teamCache.read();
  const tasks = { ...((c && c.tasks) || {}) };
  for (const id of keys) tasks[id] = { ...(tasks[id] || {}), at: Date.now(), ...entries[id] };
  teamCache.write({ tasks, syncedAt: (c && c.syncedAt) || 0 });
}

/**
 * 我自己在各任务上填过的工时（来自缓存）：taskId → [{date, work, consumed}]，按日期升序。
 * 自动补填用它来判断哪些任务前后几天在做、学习我平时的写法。
 */
function myEffortsByTask() {
  const me = String(config.zentao.username || '').toLowerCase();
  const out = new Map();
  const c = cache.read();
  for (const [taskId, t] of Object.entries((c && c.tasks) || {})) {
    const mine = (t.efforts || []).filter(e => String(e.account).toLowerCase() === me && e.consumed > 0)
      .map(e => ({ date: e.date, work: String(e.work || ''), consumed: e.consumed }))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (mine.length) out.set(taskId, mine);
  }
  return out;
}

/* ───────────────────────── 缺填提醒 ───────────────────────── */

/**
 * 最近几个工作日里「一小时都没填」的日子（待办页提醒用）。有工时就不算缺填（哪怕不满标准工时）；不含今天，周末不算。
 * @returns {Promise<Array<{date:string, hours:number, standard:number}>>} 最近的在前
 */
async function getEffortGaps({ now = new Date(), lookback = 7, limit = 3 } = {}) {
  const dates = [];
  for (let i = 1; i <= lookback; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    if (isRestDay(ymd(d))) continue;   // 周末 / 节假日不提醒；调休上班的周末要提醒
    dates.push(ymd(d));
  }
  const months = [...new Set(dates.map(d => d.slice(0, 7)))];
  const byMonth = {};
  for (const m of months) byMonth[m] = await getMonthEfforts(m, { maxAge: 60 * 1000 });
  const std = standardHours();
  return dates
    .map(date => ({ date, hours: (byMonth[date.slice(0, 7)].days[date] || { hours: 0 }).hours, standard: std }))
    .filter(g => g.hours <= 0)
    .slice(0, limit);
}

export {
  getMonthEfforts, getTeamMonthEfforts, getDayHours, listFillableTasks, addEffort, editEffort, deleteEffort, invalidateTask, getEffortGaps, normalizeEffortInput,
  cachedTaskEfforts, storeTaskEfforts, aggregate, aggregateTeam, monthRange, standardHours, myEffortsByTask
};

/** 仅供测试：服务内部用的缓存实例（同名缓存各实例各有内存镜像，测试必须操作同一个实例） */
export const _caches = { mine: cache, team: teamCache };
