/**
 * 我的待办：任务 / Bug / 与我相关的需求 / 禅道个人待办（地盘 → 我的待办），四块各自成组。
 *
 *   getTodos()  → { groups:[{key,label,items:[...]}], total, today, errors:[] }
 *
 * 每个数据源独立取，某个源失败（如禅道没连上）只记进 errors，不影响其它分组。
 * 任务 / Bug / 需求按紧急度排序：逾期 > 今天到期 > 3 天内 > 优先级；禅道待办只列未完成的（未开始 / 进行中），同样按日期紧急度，再按时间。
 * 「与我相关」：需求 = 与我相关（指派 / 我提的 / 我评审的 / 抄送）里，指派给我的，或评审中的；
 *               禅道待办 = 禅道里我自己的个人待办（和插件自己聚合的任务 / Bug 是两套东西，这里直接显示禅道的）。
 */
import { getAllTasks } from './taskManager.js';
import { getBugs } from './bugManager.js';
import { listStories } from './storyService.js';
import { getMyTodos } from './zentaoService.js';
import { getEffortGaps } from './effortService.js';
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

/** 待办里的需求：未关闭，且 指派给我 或 处于评审中（评审中的排前面） */
function pickStories(stories, me) {
  const mine = String(me || '').toLowerCase();
  const reviewing = (s) => s.status === 'reviewing';
  return stories
    .filter(s => s.status !== 'closed' && (reviewing(s) || (mine && String(s.assignedToAccount || '').toLowerCase() === mine)))
    .sort((a, b) => (reviewing(a) ? 0 : 1) - (reviewing(b) ? 0 : 1) || (a.pri || 3) - (b.pri || 3) || Number(b.id) - Number(a.id));
}

const TODO_TYPE_LABEL = { custom: '自定义', cycle: '周期', task: '任务', bug: 'Bug', story: '需求', testtask: '测试单', feedback: '反馈', review: '评审' };
/** 禅道待办的日期：2030-01-01（长期）和空都当“没有日期” */
const TODO_NO_DATE = (d) => !/^\d{4}-\d{2}-\d{2}/.test(d) || d.startsWith('2030-01-01') || d.startsWith('0000');
/** "1030" / "10:30" → "10:30"；"2400" / 空 → ''（没设时间） */
function todoTime(v) {
  const m = String(v ?? '').match(/^(\d{1,2}):?(\d{2})$/);
  if (!m || m[1] === '24') return '';
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

function todoItem(t, today) {
  const date = String(t.date || '').slice(0, 10);
  const noDate = TODO_NO_DATE(date);
  const begin = todoTime(t.begin), end = todoTime(t.end);
  const when = noDate ? '待定' : date === today ? '今天' : date.slice(5);
  const time = begin ? (end && end !== begin ? `${begin}-${end}` : begin) : '';
  const linked = t.type && t.type !== 'custom' && t.idvalue && String(t.idvalue) !== '0';
  const title = String(t.name || '').trim() || (linked ? `${TODO_TYPE_LABEL[t.type] || t.type} #${t.idvalue}` : '(无标题)');
  return {
    kind: 'todo', id: String(t.id), title,
    pri: Number(t.pri) || 3, due: noDate ? '' : dueState(date, today), dueDate: noDate ? '' : date, begin,
    meta: [t.status === 'doing' ? '进行中' : '未开始', [when, time].filter(Boolean).join(' '), TODO_TYPE_LABEL[t.type] && t.type !== 'custom' ? TODO_TYPE_LABEL[t.type] : ''].filter(Boolean).join(' · ')
  };
}

/** 禅道待办只留未完成的；按 逾期 > 今天 > 3 天内 > 其余（有日期的先、待定的后），同档按日期、开始时间、优先级 */
function pickTodos(raw, today) {
  return raw
    .filter(t => t && (t.status === 'wait' || t.status === 'doing') && String(t.deleted ?? '0') !== '1')
    .map(t => todoItem(t, today))
    .sort((a, b) => (DUE_RANK[a.due] - DUE_RANK[b.due])
      || (a.dueDate ? 0 : 1) - (b.dueDate ? 0 : 1)
      || String(a.dueDate).localeCompare(String(b.dueDate))
      || (a.begin || '99:99').localeCompare(b.begin || '99:99')
      || (a.pri || 3) - (b.pri || 3));
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
    groups.push({ key: 'task', label: '待办任务', items });
  } catch (e) { errors.push(`任务：${e.message}`); }

  // Bug：未确认 / 已确认（未解决）
  try {
    const bugs = (await getBugs({}))
      .filter(b => b.status === 'unconfirmed' || b.status === 'activated')
      .map(b => bugItem(b, today)).sort(bySeverity);
    groups.push({ key: 'bug', label: '待处理 Bug', items: bugs });
  } catch (e) { errors.push(`Bug：${e.message}`); }

  // 需求：指派给我的，或评审中的（未关闭）
  try {
    const items = pickStories(await listStories({ maxAge: 60 * 1000 }), me).map(storyItem);
    groups.push({ key: 'story', label: '我的需求', items });
  } catch (e) { errors.push(`需求：${e.message}`); }

  // 禅道个人待办：未完成的（取不到只提示，不影响其它分组）
  try {
    groups.push({ key: 'todo', label: '禅道待办', items: pickTodos(await getMyTodos(), today) });
  } catch (e) { errors.push(`禅道待办：${e.message}`); }

  // 工时缺填提醒：最近几个工作日里不满标准工时的（取不到就不提醒，不算错误）
  let effortGaps = [];
  try { effortGaps = await getEffortGaps({ now }); } catch { /* 没连禅道等：不提醒 */ }

  const total = groups.reduce((n, g) => n + g.items.length, 0);
  return { today, total, groups, errors, effortGaps };
}

export { getTodos, dueState, bySeverity, pickStories, pickTodos, todoItem };
