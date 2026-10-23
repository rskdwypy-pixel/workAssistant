/**
 * 我的待办：任务 / Bug / 与我相关的需求 / 与我相关的文档，四块各自成组。
 *
 *   getTodos()  → { groups:[{key,label,items:[...]}], total, today, errors:[] }
 *
 * 每个数据源独立取，某个源失败（如禅道没连上）只记进 errors，不影响其它分组。
 * 任务 / Bug / 需求按紧急度排序：逾期 > 今天到期 > 3 天内 > 优先级；文档按最近修改。
 * 「与我相关」：需求 = 禅道里指派给我 / 我提的 / 我评审的 / 抄送我的（未关闭）；
 *               文档 = 我创建或最后由我修改的。
 */
import { getAllTasks } from './taskManager.js';
import { getBugs } from './bugManager.js';
import { listStories } from './storyService.js';
import { listDocs, listLibs } from './docService.js';
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

/** 文档最多列这么多条（最近修改的在前），再多的去文档页找 */
const DOC_LIMIT = 50;

function docItem(d, libName) {
  return {
    kind: 'doc', id: String(d.id), title: d.title, pri: 3, due: '', dueDate: '',
    meta: [libName, String(d.editedDate || '').slice(0, 10)].filter(Boolean).join(' · ')
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

  // 需求：与我相关（四种关联之一）、未关闭；评审中 / 变更中的排前面
  try {
    const rank = (s) => (s.status === 'reviewing' || s.status === 'changing' ? 0 : 1);
    const items = (await listStories({ maxAge: 60 * 1000 }))
      .filter(s => s.status !== 'closed')
      .sort((a, b) => rank(a) - rank(b) || (a.pri || 3) - (b.pri || 3) || Number(b.id) - Number(a.id))
      .map(storyItem);
    groups.push({ key: 'story', label: '我的需求', items });
  } catch (e) { errors.push(`需求：${e.message}`); }

  // 文档：我创建或最后由我修改的，最近修改的在前
  try {
    const [docs, libs] = await Promise.all([listDocs({ maxAge: 60 * 1000 }), listLibs().catch(() => [])]);
    const libName = new Map(libs.map(l => [l.id, l.name]));
    const items = docs
      .filter(d => me && (String(d.editedBy || '').toLowerCase() === me || String(d.addedBy || '').toLowerCase() === me))
      .sort((a, b) => String(b.editedDate).localeCompare(String(a.editedDate)))
      .slice(0, DOC_LIMIT)
      .map(d => docItem(d, libName.get(d.lib) || ''));
    groups.push({ key: 'doc', label: '我的文档', items });
  } catch (e) { errors.push(`文档：${e.message}`); }

  const total = groups.reduce((n, g) => n + g.items.length, 0);
  return { today, total, groups, errors };
}

export { getTodos, dueState, bySeverity };
