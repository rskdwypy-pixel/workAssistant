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
import { fetchMyList, getTaskEfforts, recordTaskEstimate, isConfigured, getZentaoCookies, cookiesToString } from './zentaoService.js';
import { createCache, singleFlight } from './zentaoCache.js';
import { decodeZentaoText } from '../utils/text.js';
import { config } from '../config.js';

const MY_TASK_LISTS = ['assignedTo', 'openedBy', 'finishedBy', 'closedBy', 'canceledBy'];
const FILLABLE_STATUS = new Set(['wait', 'doing', 'pause']);
const cache = createCache('efforts');

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
      if (old[id] && old[id].sig === sig) { tasks[id] = old[id]; continue; }
      const edited = dayPart(t.lastEditedDate);
      if (edited && edited < from) { if (old[id]) tasks[id] = old[id]; continue; }
      todo.push({ id, sig, t });
    }
    await mapLimit(todo, 6, async ({ id, sig, t }) => {
      try {
        const efforts = await getTaskEfforts(id, CH);
        tasks[id] = {
          sig,
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

/**
 * 记工时（写入禅道）。date 可以是过去的日期（补填），不能是将来。
 * 成功后让该任务的工时缓存失效，下次读取会重新向禅道要。
 */
async function addEffort({ taskId, date, consumed, left, work } = {}) {
  assertReady();
  if (!/^\d+$/.test(String(taskId || ''))) throw new Error('请选择任务');
  const today = ymd(new Date());
  const day = date || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('日期格式应为 YYYY-MM-DD');
  if (day > today) throw new Error('不能给将来的日期填工时');
  const hours = Number(consumed);
  if (!(hours > 0) || hours > 24) throw new Error('消耗工时应大于 0 且不超过 24 小时');
  const remain = left === undefined || left === null || left === '' ? 0 : Number(left);
  if (!(remain >= 0)) throw new Error('剩余工时不能为负数');
  if (!String(work || '').trim()) throw new Error('请填写工作内容（它会进入日报）');

  const r = await recordTaskEstimate(taskId, { work: String(work).trim(), consumed: hours, left: remain, date: day });
  if (r && r.success) invalidateTask(taskId);
  return r;
}

/** 让某任务的工时缓存失效（写操作之后调用） */
function invalidateTask(taskId) {
  const c = cache.read();
  if (!c || !c.tasks) return;
  const tasks = { ...c.tasks };
  delete tasks[String(taskId)];
  cache.write({ tasks, syncedAt: 0 });
}

export { getMonthEfforts, getDayHours, listFillableTasks, addEffort, invalidateTask, aggregate, monthRange, standardHours };
