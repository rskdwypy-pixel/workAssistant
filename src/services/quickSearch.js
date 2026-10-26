/**
 * 全局搜索（⌘K）：一个输入框同时搜任务、Bug、需求、文档。
 *
 * 分两段，界面先显示第一段再补第二段，输入时不卡：
 *   local   本地的任务 / Bug（已同步的）+ 需求 / 文档的缓存列表——毫秒级
 *   remote  禅道服务端的全局搜索（任务、Bug，能搜到不在我名下的）——要几百毫秒到几秒
 * 结果统一成 { type, id, title, sub, local }，id 是禅道里的编号（点开就是在禅道里打开）。
 */
import { readTasks } from '../utils/storage.js';
import { searchZentao, isConfigured } from './zentaoService.js';
import { loadStories } from './storyService.js';
import { loadDocs } from './docService.js';

const PER_GROUP = 8;
const CACHE_TRUST_MS = 10 * 60 * 1000;

const TASK_STATUS = { todo: '待办', in_progress: '进行中', done: '已完成' };
const BUG_STATUS = { unconfirmed: '未确认', activated: '已确认', resolved: '已解决', closed: '已关闭' };

const norm = (s) => String(s || '').toLowerCase();

/** 标题包含关键词（不分大小写），或编号完全一致 */
function matches(title, id, query) {
  const q = norm(query).replace(/^#/, '');
  return norm(title).includes(norm(query)) || (/^\d+$/.test(q) && String(id) === q);
}

/** 排序：编号完全一致 > 标题以关键词开头 > 其余（保持原有顺序） */
function rank(item, query) {
  const q = norm(query).replace(/^#/, '');
  if (/^\d+$/.test(q) && String(item.id) === q) return 0;
  return norm(item.title).startsWith(norm(query)) ? 1 : 2;
}
const sortByRank = (arr, query) => arr.map((x, i) => [x, i]).sort((a, b) => rank(a[0], query) - rank(b[0], query) || a[1] - b[1]).map(x => x[0]);

async function localTasksAndBugs(query) {
  const all = ((await readTasks()).tasks || []).filter(t => t.zentaoId);
  const byUpdated = [...all].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  const pick = (isBug) => sortByRank(byUpdated
    .filter(t => (t.type === 'bug') === isBug && matches(t.title, t.zentaoId, query)), query)
    .slice(0, PER_GROUP)
    .map(t => ({
      type: isBug ? 'bug' : 'task',
      id: String(t.zentaoId),
      title: String(t.title || ''),
      sub: (isBug ? BUG_STATUS : TASK_STATUS)[t.status] || t.status || '',
      local: true
    }));
  return { tasks: pick(false), bugs: pick(true) };
}

/** 只读缓存（不能让第一次搜索卡在整拉一遍需求 / 文档上）；没有缓存就在后台预热，这次先不显示这一组 */
async function cachedItems(load) {
  try {
    const cached = await load({ cacheOnly: true });
    if (cached && Array.isArray(cached.items)) return cached.items;
    load({ maxAge: CACHE_TRUST_MS }).catch(() => {});
  } catch { /* 读不到就不显示这一组 */ }
  return [];
}

async function storiesAndDocs(query) {
  const [stories, docs] = await Promise.all([cachedItems(loadStories), cachedItems(loadDocs)]);
  return {
    stories: sortByRank(stories.filter(s => matches(s.title, s.id, query)), query).slice(0, PER_GROUP)
      .map(s => ({ type: 'story', id: String(s.id), title: s.title, sub: [s.statusLabel, s.productName].filter(Boolean).join(' · '), local: true })),
    docs: sortByRank(docs.filter(d => matches(d.title, d.id, query)), query).slice(0, PER_GROUP)
      .map(d => ({ type: 'doc', id: String(d.id), title: d.title, sub: [d.typeLabel, d.editedBy].filter(Boolean).join(' · '), local: true }))
  };
}

async function remoteTasksAndBugs(query) {
  const out = { tasks: [], bugs: [] };
  const map = (type) => (r) => (r.items || []).slice(0, PER_GROUP).map(i => ({
    type, id: String(i.id), title: i.title, sub: [i.statusLabel, i.assignedToName].filter(Boolean).join(' · ') || i.summary || '', local: false
  }));
  const [t, b] = await Promise.allSettled([
    searchZentao(query, 'task', { limit: PER_GROUP, details: false }),
    searchZentao(query, 'bug', { limit: PER_GROUP, details: false })
  ]);
  if (t.status === 'fulfilled') out.tasks = map('task')(t.value);
  if (b.status === 'fulfilled') out.bugs = map('bug')(b.value);
  return out;
}

/**
 * @param {string} q
 * @param {{scope?:'local'|'remote'}} [options]
 * @returns {Promise<{query:string, scope:string, tasks:Array, bugs:Array, stories:Array, docs:Array}>}
 */
async function quickSearch(q, { scope = 'local' } = {}) {
  const query = String(q || '').trim().slice(0, 80);
  const empty = { query, scope, tasks: [], bugs: [], stories: [], docs: [] };
  if (!query) return empty;
  if (scope === 'remote') {
    // 服务端搜索要求至少 2 个字；纯编号的在本地和缓存里按编号找，不去搜
    if (!isConfigured() || query.length < 2 || /^#?\d+$/.test(query)) return empty;
    return { ...empty, ...(await remoteTasksAndBugs(query)) };
  }
  const [tb, sd] = await Promise.all([localTasksAndBugs(query), storiesAndDocs(query)]);
  return { ...empty, ...tb, ...sd };
}

export { quickSearch, matches, rank };
