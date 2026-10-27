/**
 * 我的待办：任务 / Bug / 与我相关的需求 / 禅道个人待办（地盘 → 我的待办），四块各自成组。
 *
 *   getTodos()  → { groups:[{key,label,items:[...]}], total, today, errors:[] }
 *
 * 每个数据源独立取，某个源失败（如禅道没连上）只记进 errors，不影响其它分组。
 * 任务 / Bug / 需求按紧急度排序：逾期 > 今天到期 > 3 天内 > 优先级；禅道待办只列未完成的（未开始 / 进行中），按 优先级 → 状态 → 日期排。
 * 「与我相关」：需求 = 与我相关（指派 / 我提的 / 我评审的 / 抄送）里，指派给我的，或评审中的；
 *               禅道待办 = 禅道里我自己的个人待办（和插件自己聚合的任务 / Bug 是两套东西，这里直接显示禅道的）。
 */
import { getAllTasks } from './taskManager.js';
import { getBugs } from './bugManager.js';
import { listStories } from './storyService.js';
import { listTodos } from './zentaoTodo.js';
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

const TODO_TYPE_LABEL = { custom: '自定义', cycle: '周期', task: '任务', bug: 'Bug', story: '需求' };
const TODO_STATUS_RANK = { doing: 0, wait: 1, done: 2, closed: 3 };
const TODO_STATUS_LABEL = { wait: '未开始', doing: '进行中', done: '已完成', closed: '已关闭' };

/** 禅道待办的显示顺序：优先级(1 最高) → 状态(进行中 > 未开始 > 已完成 > 已关闭) → 日期(有日期的先、待定的后) → 开始时间 */
function sortTodos(list) {
  return [...list].sort((a, b) => (a.pri || 3) - (b.pri || 3)
    || (TODO_STATUS_RANK[a.status] ?? 9) - (TODO_STATUS_RANK[b.status] ?? 9)
    || (a.date ? 0 : 1) - (b.date ? 0 : 1)
    || String(a.date).localeCompare(String(b.date))
    || (a.begin || '99:99').localeCompare(b.begin || '99:99'));
}

/** 禅道图片地址的白名单（代理接口只放行这些，防止被拿去访问别的地址） */
const ZENTAO_IMG_PATH = /^\/zentao\/(file-read-\d+(\.\w+)?|data\/upload\/[\w./%-]+)(\?[\w=&.%-]*)?$/;
const isZentaoImagePath = (p) => ZENTAO_IMG_PATH.test(String(p || ''));

/**
 * 描述里的图片：禅道存的是 /zentao/file-read-N.png，新版需要登录才能看，浏览器直接请求不一定带登录状态；
 * 所以给插件页面显示时改成走本地后端代理（带会话取图），保存时再还原成禅道的原地址。
 */
function withAbsoluteImages(html, origin) {
  if (!origin) return html;
  return String(html || '').replace(/(<img[^>]+src=["'])(\/zentao\/[^"']+)/gi, (m, pre, path) => (
    isZentaoImagePath(path.replace(/&amp;/g, '&')) ? `${pre}${origin}/api/zentao-todos/file?path=${encodeURIComponent(path.replace(/&amp;/g, '&'))}` : m));
}
function withRelativeImages(html, origin) {
  if (!origin) return html;
  const esc = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(html || '').replace(new RegExp(`(<img[^>]+src=["'])${esc}/api/zentao-todos/file\\?path=([^"']+)`, 'gi'), (m, pre, enc) => {
    try { const p = decodeURIComponent(enc); return isZentaoImagePath(p) ? `${pre}${p}` : m; } catch { return m; }
  });
}

/** 禅道待办 → 待办页的一条（kind: 'todo'）。meta 里放 日期 / 时间 / 类型 / 指派给谁 */
function todoItem(t, today, users = {}) {
  const when = !t.date ? '待定' : t.date === today ? '今天' : t.date.slice(5);
  const time = t.begin ? (t.end && t.end !== t.begin ? `${t.begin}-${t.end}` : t.begin) : '';
  const linked = t.type !== 'custom' && t.type !== 'cycle' && t.objectId;
  const title = t.name || (linked ? `${TODO_TYPE_LABEL[t.type] || t.type} #${t.objectId}` : '(无标题)');
  const me = String(config.zentao.username || '').toLowerCase();
  const other = t.assignedTo && t.assignedTo.toLowerCase() !== me && t.assignedTo !== 'closed' ? (users[t.assignedTo] || t.assignedTo) : '';
  return {
    kind: 'todo', id: t.id, title, pri: t.pri, due: t.date ? dueState(t.date, today) : '', dueDate: t.date,
    status: t.status, type: t.type, private: t.private, assignedTo: t.assignedTo, cycle: t.cycle,
    meta: [TODO_STATUS_LABEL[t.status], [when, time].filter(Boolean).join(' '), t.type !== 'custom' ? TODO_TYPE_LABEL[t.type] : '', other ? `指派给 ${other}` : ''].filter(Boolean).join(' · ')
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

  // 禅道个人待办：未完成的进卡片，已完成 / 已关闭的放在 doneItems（卡片上“显示已完成”才看）
  try {
    const sorted = sortTodos(await listTodos());
    const open = sorted.filter(t => t.status === 'wait' || t.status === 'doing');
    groups.push({
      key: 'todo', label: '禅道待办',
      items: open.map(t => todoItem(t, today, config.zentao.users || {})),
      doneItems: sorted.filter(t => t.status === 'done' || t.status === 'closed').map(t => todoItem(t, today, config.zentao.users || {})).slice(0, 50)
    });
  } catch (e) { errors.push(`禅道待办：${e.message}`); }

  // 工时缺填提醒：最近几个工作日里不满标准工时的（取不到就不提醒，不算错误）
  let effortGaps = [];
  try { effortGaps = await getEffortGaps({ now }); } catch { /* 没连禅道等：不提醒 */ }

  const total = groups.reduce((n, g) => n + g.items.length, 0);
  return { today, total, groups, errors, effortGaps };
}

export { getTodos, dueState, bySeverity, pickStories, sortTodos, todoItem, withAbsoluteImages, withRelativeImages, isZentaoImagePath };
