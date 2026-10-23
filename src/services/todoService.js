/**
 * 我的待办：把任务 / Bug / 需求 / 日报汇到一个落地页。
 *
 *   getTodos()  → { groups:[{key,label,tone,items:[...]}], total, today, errors:[] }
 *
 * 每个数据源独立取，某个源失败（如禅道没连上）只记进 errors，不影响其它分组。
 * 排序：逾期 > 今天到期 > 优先级高 > 其余。
 */
import { getAllTasks } from './taskManager.js';
import { getBugs } from './bugManager.js';
import { listStories } from './storyService.js';
import { getCalendar } from './reportCenter.js';
import { config } from '../config.js';

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 截止日期 → 'overdue' | 'today' | 'soon'(3 天内) | ''（无/较远） */
function dueState(dueDate, today) {
  const d = String(dueDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return '';
  if (d < today) return 'overdue';
  if (d === today) return 'today';
  const soon = new Date(`${today}T00:00:00`);
  soon.setDate(soon.getDate() + 3);
  return d <= ymd(soon) ? 'soon' : '';
}

const DUE_RANK = { overdue: 0, today: 1, soon: 2, '': 3 };

/** 紧急度排序：逾期 > 今天 > 3 天内 > 优先级(1 最高) */
function bySeverity(a, b) {
  const r = DUE_RANK[a.due] - DUE_RANK[b.due];
  if (r) return r;
  return (a.pri || 3) - (b.pri || 3);
}

function taskItem(t, today) {
  return {
    kind: 'task', id: String(t.id), title: t.title || '(无标题)',
    pri: Number(t.priority) || 3, due: dueState(t.dueDate, today), dueDate: t.dueDate || '',
    meta: [t.status === 'in_progress' ? `进行中 ${t.progress || 0}%` : '待办', t.executionName].filter(Boolean).join(' · ')
  };
}

function bugItem(b, today) {
  const sev = Number(b.severity) || 0;
  return {
    kind: 'bug', id: String(b.id), title: b.title || '(无标题)',
    pri: Number(b.priority) || sev || 3, due: dueState(b.deadline, today), dueDate: b.deadline || '',
    meta: [b.status === 'activated' ? '已确认' : '未确认', b.productName].filter(Boolean).join(' · ')
  };
}

function storyItem(s) {
  return {
    kind: 'story', id: String(s.id), title: s.title,
    pri: Number(s.pri) || 3, due: '', dueDate: '',
    meta: [s.statusLabel, s.stageLabel, s.productName].filter(Boolean).join(' · ')
  };
}

async function getTodos(now = new Date()) {
  const today = ymd(now);
  const errors = [];
  const me = String(config.zentao.username || '').toLowerCase();
  const groups = [];

  // 任务（本地库，含禅道同步来的）：未完成
  try {
    const all = await getAllTasks({});
    const items = all
      .filter(t => t.type !== 'bug' && t.status !== 'done')
      .map(t => taskItem(t, today)).sort(bySeverity);
    groups.push({ key: 'task', label: '待办任务', tone: 'task', mode: 'task', items });
  } catch (e) { errors.push(`任务：${e.message}`); }

  // Bug：未确认 / 已确认（未解决）
  try {
    const bugs = (await getBugs({}))
      .filter(b => b.status === 'unconfirmed' || b.status === 'activated')
      .map(b => bugItem(b, today)).sort(bySeverity);
    groups.push({ key: 'bug', label: '待处理 Bug', tone: 'bug', mode: 'bug', items: bugs });
  } catch (e) { errors.push(`Bug：${e.message}`); }

  // 需求：指派给我、未关闭；评审中的单独成组（要我评审/确认）
  try {
    const mine = (await listStories({ maxAge: 60 * 1000 }))
      .filter(s => s.status !== 'closed' && s.assignedToAccount && s.assignedToAccount.toLowerCase() === me);
    const review = mine.filter(s => s.status === 'reviewing' || s.status === 'changing').map(storyItem).sort(bySeverity);
    const rest = mine.filter(s => s.status !== 'reviewing' && s.status !== 'changing').map(storyItem).sort(bySeverity);
    groups.push({ key: 'story-review', label: '评审中的需求', tone: 'review', mode: 'story', items: review });
    groups.push({ key: 'story', label: '指派给我的需求', tone: 'story', mode: 'story', items: rest });
  } catch (e) { errors.push(`需求：${e.message}`); }

  // 日报：今天是工作日且还没生成 → 提醒
  try {
    const cal = await getCalendar(today.slice(0, 7), now);
    const day = cal.days.find(d => d.today);
    const items = day && !day.weekend && !day.report
      ? [{ kind: 'report', id: today, title: '今天的日报还没生成', pri: 3, due: 'today', dueDate: today, meta: `${cal.eveningHour}:00 后会自动生成，也可手动生成` }]
      : [];
    groups.push({ key: 'report', label: '日报', tone: 'report', mode: 'report', items });
  } catch (e) { errors.push(`日报：${e.message}`); }

  const total = groups.reduce((n, g) => n + g.items.length, 0);
  return { today, total, groups, errors };
}

export { getTodos, dueState, bySeverity };
