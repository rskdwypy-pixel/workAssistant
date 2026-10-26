/**
 * 工作负载：未来几天里，我名下未完成任务的剩余工时按截止日摊开，回答「这些截止日我来得及吗」。
 *
 * 判断的是累计：到某天为止必须做完的工时（已逾期的算今天就要做 + 截止日在那天及以前的）
 * 对比到那天为止的可用工时（工作日数 × 每日标准工时）。累计超出就是「来不及」，差多少工时一并给出。
 * 不看每天的“当天截止工时”是否超过一天的产能——提前做、拆开做都可以，只要累计够。
 *
 * 数据：「指派给我」的任务（fetchMyList），用剩余工时 left；没有截止日的单独列。休息日 / 调休沿用设置里的上班日历。
 */
import { config } from '../config.js';
import { fetchMyList } from './zentaoService.js';
import { isRestDay } from '../utils/workCalendar.js';

const OPEN = new Set(['wait', 'doing', 'pause']);
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; };
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
const standardHours = () => (Number(config.schedule.workHours) > 0 ? Number(config.schedule.workHours) : 8);

function slim(t) {
  const left = Number(t.left);
  return {
    id: String(t.id),
    title: String(t.name || ''),
    left: Number.isFinite(left) && left > 0 ? left : 0,
    estimate: Number(t.estimate) || 0,
    consumed: Number(t.consumed) || 0,
    pri: Number(t.pri) || 0,
    status: String(t.status || ''),
    deadline: /^\d{4}-\d{2}-\d{2}/.test(String(t.deadline || '')) && !String(t.deadline).startsWith('0000') ? String(t.deadline).slice(0, 10) : '',
    where: String(t.executionName || t.projectName || '')
  };
}

/**
 * @param {Array} items  「指派给我」的任务（禅道原始字段即可：id, name, left, deadline, status, pri…）
 * @param {{now?:Date, days?:number, workHours?:number, isRest?:(ymd:string)=>boolean}} [options]
 */
function buildWorkload(items, { now = new Date(), days = 14, workHours = standardHours(), isRest = isRestDay } = {}) {
  const today = ymd(now);
  const open = (items || []).filter(t => t && OPEN.has(String(t.status))).map(slim);
  const byDate = new Map();
  const overdue = [], later = [], noDeadline = [];
  const last = ymd(addDays(now, days - 1));
  for (const t of open) {
    if (!t.deadline) noDeadline.push(t);
    else if (t.deadline < today) overdue.push(t);
    else if (t.deadline > last) later.push(t);
    else { if (!byDate.has(t.deadline)) byDate.set(t.deadline, []); byDate.get(t.deadline).push(t); }
  }
  const sum = (arr) => round1(arr.reduce((a, t) => a + t.left, 0));
  const byLeft = (a, b) => b.left - a.left || a.pri - b.pri;

  // 已逾期的：今天就得做，算进今天的累计
  let needed = sum(overdue);
  let capacity = 0;
  const rows = [];
  let firstShort = '';
  for (let i = 0; i < days; i++) {
    const date = ymd(addDays(now, i));
    const work = !isRest(date);
    const tasks = (byDate.get(date) || []).sort(byLeft);
    needed = round1(needed + sum(tasks));
    if (work) capacity = round1(capacity + workHours);
    const short = round1(Math.max(0, needed - capacity));
    if (short > 0 && !firstShort) firstShort = date;
    rows.push({ date, weekday: new Date(`${date}T00:00:00`).getDay(), workday: work, dueHours: sum(tasks), tasks, cumNeeded: needed, cumCapacity: capacity, short });
  }
  const totalLeft = round1(sum(overdue) + sum(noDeadline) + sum(later) + rows.reduce((a, r) => a + r.dueHours, 0));
  return {
    today, days, workHours,
    summary: {
      openTasks: open.length,
      totalLeft,
      overdueCount: overdue.length, overdueHours: sum(overdue),
      noDeadlineCount: noDeadline.length, noDeadlineHours: sum(noDeadline),
      laterCount: later.length, laterHours: sum(later),
      firstShortDate: firstShort,
      maxShort: round1(Math.max(0, ...rows.map(r => r.short)))
    },
    overdue: overdue.sort((a, b) => a.deadline.localeCompare(b.deadline) || byLeft(a, b)),
    rows,
    later: later.sort((a, b) => a.deadline.localeCompare(b.deadline)),
    noDeadline: noDeadline.sort(byLeft)
  };
}

let memo = null;
/** 读我名下的任务并计算；2 分钟内复用上次读到的任务（反复打开面板不重复请求禅道） */
async function getWorkload({ days = 14, now = new Date() } = {}) {
  if (!memo || Date.now() - memo.at > 2 * 60 * 1000 || memo.scope !== `${config.zentao.url}|${config.zentao.username}`) {
    const { items } = await fetchMyList('task', 'assignedTo');
    memo = { at: Date.now(), items, scope: `${config.zentao.url}|${config.zentao.username}` };
  }
  return buildWorkload(memo.items, { now, days: Math.max(1, Math.min(60, Number(days) || 14)) });
}

export { buildWorkload, getWorkload };
