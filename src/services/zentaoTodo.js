/**
 * 禅道个人待办（地盘 → 我的待办）：列表 / 详情 / 新建 / 编辑 / 改状态 / 删除 / 描述里的图片。
 *
 * 新旧版禅道的差别（真实环境逐项核对过）：
 *   · 新版（22.x）：写操作都走 .json，POST 用 FormData，成功返回 {result:'success'}；
 *   · 旧版（18.x）：写操作走 .html，必须带 Referer（指向对应的表单页，否则禅道只回表单、不执行），成功返回一段 <script>；
 *   · 关联任务 / Bug / 需求：新版用 task= / bug= / story= 传编号，旧版用 idvalue=（两个都带，互不影响）；
 *   · 列表里日期是 2026-10-27、时间 15:00；详情里是 20261027、1500；没设时间是 2400，没设日期是 2030-01-01 —— 这里统一成
 *     日期 YYYY-MM-DD（空 = 待定）、时间 HH:MM（空 = 没设）。
 * 写完一律回读核对，禅道静默失败时不能报成功。
 */
import {
  zentaoFetch, getZentaoCookies, cookiesToString, isModernZentao, readZentaoJson, uploadEditorImage, zentaoBase, describeZentaoTransportError
} from './zentaoService.js';
import { config } from '../config.js';

const PAGE_SIZE = 500;
const NO_DATE = '2030-01-01';
const LINKED = ['task', 'bug', 'story'];
export const TODO_TYPES = { custom: '自定义', task: '任务', bug: 'Bug', story: '需求', cycle: '周期' };
export const TODO_STATUS = ['wait', 'doing', 'done', 'closed'];

/** "20261027" / "2026-10-27" → "2026-10-27"；空、0000、2030-01-01（长期）→ '' */
export function normDate(v) {
  const s = String(v ?? '').trim();
  const m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  if (!m || m[1] === '0000') return '';
  const d = `${m[1]}-${m[2]}-${m[3]}`;
  return d === NO_DATE ? '' : d;
}

/** "1500" / "15:00" → "15:00"；2400 / 空 → '' */
export function normTime(v) {
  const m = String(v ?? '').trim().match(/^(\d{1,2}):?(\d{2})$/);
  if (!m || m[1] === '24') return '';
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

const toHHMM = (v) => (normTime(v) || '24:00').replace(':', '');

/** 禅道原始待办 → 统一结构 */
export function normalizeTodo(t) {
  const type = String(t.type || 'custom');
  const objectId = String(t.idvalue ?? t.objectID ?? '');
  return {
    id: String(t.id),
    name: String(t.name || '').trim(),
    type,
    objectId: objectId && objectId !== '0' ? objectId : '',
    pri: Number(t.pri) >= 1 && Number(t.pri) <= 4 ? Number(t.pri) : 3,
    status: TODO_STATUS.includes(t.status) ? t.status : 'wait',
    desc: String(t.desc || ''),
    date: normDate(t.date),
    begin: normTime(t.begin),
    end: normTime(t.end),
    private: String(t.private) === '1',
    assignedTo: String(t.assignedTo || ''),
    assignedBy: String(t.assignedBy || ''),
    account: String(t.account || ''),
    cycle: type === 'cycle' || String(t.cycle) === '1',
    deleted: String(t.deleted) === '1'
  };
}

const isObj = (o) => o && typeof o === 'object';
function messageOf(m) {
  if (!m) return '';
  if (typeof m === 'string') return m;
  if (isObj(m)) return Object.values(m).flat().map(messageOf).filter(Boolean).join('；');
  return String(m);
}

async function session() {
  return { CH: cookiesToString(await getZentaoCookies()), modern: await isModernZentao() };
}

/** 我的全部待办（含已完成 / 已关闭，不含已删除），自动翻页 */
export async function listTodos() {
  const { CH } = await session();
  const items = [];
  for (let page = 1; page <= 20; page++) {
    const resp = await zentaoFetch(`${zentaoBase()}/zentao/my-todo-all-0-all-date_desc-0-${PAGE_SIZE}-${page}.json`, {
      headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Cookie: CH }
    });
    const inner = await readZentaoJson(resp);
    const list = inner && inner.todos;
    const pageItems = Array.isArray(list) ? list : Object.values(list || {});
    items.push(...pageItems);
    const pageTotal = Number(inner?.pager?.pageTotal) || 1;
    if (page >= pageTotal || pageItems.length === 0) break;
  }
  return items.map(normalizeTodo).filter(t => !t.deleted);
}

/** 一条待办的详情（描述是 HTML）；不存在 / 无权限抛错 */
export async function getTodo(id) {
  if (!/^\d+$/.test(String(id))) throw new Error('非法的待办编号');
  const { CH } = await session();
  const resp = await zentaoFetch(`${zentaoBase()}/zentao/todo-view-${id}.json`, {
    headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Cookie: CH }
  });
  let inner;
  try { inner = await readZentaoJson(resp); } catch (e) { throw new Error('待办不存在或没有权限'); }
  if (!inner || !inner.todo) throw new Error('待办不存在或没有权限');
  const todo = normalizeTodo(inner.todo);
  if (todo.deleted) throw new Error('待办已被删除');
  return todo;
}

/** 校验并整理表单（新建 / 编辑共用）。返回禅道要的字段 */
export function buildFields(input = {}, { me = '' } = {}) {
  const type = LINKED.includes(input.type) ? input.type : 'custom';
  const name = String(input.name || '').trim();
  const objectId = String(input.objectId || '').trim();
  if (type === 'custom') {
    if (!name) throw new Error('请填写待办名称');
    if (name.length > 255) throw new Error('待办名称不能超过 255 个字');
  } else if (!/^\d+$/.test(objectId)) {
    throw new Error(`请选择关联的${TODO_TYPES[type]}`);
  }
  const pri = Number(input.pri);
  if (!(pri >= 1 && pri <= 4)) throw new Error('优先级应为 1 到 4');
  const date = String(input.date || '').trim();
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期格式不对');
  const begin = normTime(input.begin), end = normTime(input.end);
  if ((begin && !end) || (!begin && end)) throw new Error('开始和结束时间要一起填，或都不填');
  if (begin && end && end < begin) throw new Error('结束时间不能早于开始时间');
  const desc = String(input.desc || '');
  if (desc.length > 100000) throw new Error('描述太长了');
  const fields = {
    type, pri: String(pri), name: type === 'custom' ? name : (name || ''), desc,
    date: date || NO_DATE, begin: toHHMM(begin), end: toHHMM(end),
    assignedTo: String(input.assignedTo || me || ''), status: 'wait', uid: String(input.uid || `wa${Date.now()}`)
  };
  if (type !== 'custom') { fields.idvalue = objectId; fields[type] = objectId; }
  if (input.private) fields.private = '1';
  return fields;
}

async function send(url, { fields, formPage } = {}) {
  const { CH, modern } = await session();
  const ext = modern ? 'json' : 'html';
  const full = `${zentaoBase()}/zentao/${url.replace('{ext}', ext)}`;
  const headers = { Cookie: CH, 'X-Requested-With': 'XMLHttpRequest', Accept: modern ? 'application/json' : 'text/html,*/*' };
  const init = { headers };
  if (fields) {
    init.method = 'POST';
    if (modern) {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      init.body = fd;
    } else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = new URLSearchParams(fields).toString();
    }
  }
  // 旧版必须带 Referer（指向对应表单页），否则只回表单、不执行
  if (!modern) headers.Referer = `${zentaoBase()}/zentao/${(formPage || url).replace('{ext}', 'html')}`;
  let text;
  try { text = await (await zentaoFetch(full, init)).text(); } catch (err) { throw new Error(describeZentaoTransportError(err)); }
  if (modern) {
    let j = null;
    try { j = JSON.parse(text); } catch { /* 不是 JSON：交给回读核对 */ }
    if (j && j.result === 'fail') throw new Error(messageOf(j.message) || '禅道没有接受');
    return j || {};
  }
  const alert = text.match(/alert\((['"])(.*?)\1\)/);
  if (alert) throw new Error(alert[2]);
  return { text };
}

const me = () => String(config.zentao.username || '');

/** 新建待办，返回新待办 */
export async function createTodo(input) {
  const fields = buildFields(input, { me: me() });
  const before = new Set((await listTodos()).map(t => t.id));
  const r = await send('todo-create.{ext}', { fields, formPage: 'todo-create.{ext}' });
  let id = r && r.id ? String(r.id) : '';
  if (!id) {
    // 旧版不返回编号：找新出现的那条
    const added = (await listTodos()).filter(t => !before.has(t.id));
    const hit = added.find(t => t.type === fields.type && (fields.type !== 'custom' || t.name === fields.name)) || added[0];
    id = hit ? hit.id : '';
  }
  if (!id) throw new Error('禅道没有接受这条待办（回读没找到），请检查内容后重试');
  return getTodo(id);
}

/** 编辑待办（周期待办不支持：配置复杂，请在禅道里改） */
export async function updateTodo(id, input) {
  const cur = await getTodo(id);
  if (cur.cycle) throw new Error('周期待办请在禅道里编辑');
  const fields = buildFields({ ...input, objectId: input.objectId ?? cur.objectId }, { me: cur.assignedTo || me() });
  fields.status = cur.status === 'closed' ? 'wait' : cur.status;
  await send(`todo-edit-${id}.{ext}`, { fields, formPage: `todo-edit-${id}.{ext}` });
  const after = await getTodo(id);
  const wantName = fields.type === 'custom' ? fields.name : null;
  if ((wantName !== null && after.name !== wantName) || after.pri !== Number(fields.pri)) throw new Error('禅道没有接受这次修改（回读核对不一致），请刷新后重试');
  return after;
}

const ACTION_OF = { start: 'start', finish: 'finish', activate: 'activate', close: 'close' };

async function act(id, action) {
  await send(`todo-${ACTION_OF[action]}-${id}.{ext}`);
}

/** 把待办改到目标状态（wait / doing / done / closed），按禅道允许的流转一步步走，最后回读核对 */
export async function setTodoStatus(id, target) {
  if (!TODO_STATUS.includes(target)) throw new Error('非法的状态');
  let cur = await getTodo(id);
  if (cur.status === target) return cur;
  // 禅道的流转：wait→doing 用 start；wait / doing→done 用 finish；done / closed→wait 用 activate；→closed 要先 done 再 close
  const steps = [];
  const from = cur.status;
  if (target === 'doing') steps.push(...(from === 'wait' ? ['start'] : ['activate', 'start']));
  else if (target === 'wait') steps.push('activate');
  else if (target === 'done') steps.push(...(from === 'closed' ? ['activate', 'finish'] : ['finish']));
  else if (target === 'closed') steps.push(...(from === 'done' ? ['close'] : from === 'closed' ? [] : ['finish', 'close']));
  for (const s of steps) await act(id, s);
  cur = await getTodo(id);
  if (cur.status !== target) throw new Error(`禅道没有把待办改成「${{ wait: '未开始', doing: '进行中', done: '已完成', closed: '已关闭' }[target]}」（现在是 ${cur.status}）`);
  return cur;
}

export async function deleteTodo(id) {
  if (!/^\d+$/.test(String(id))) throw new Error('非法的待办编号');
  const cur = await getTodo(id);
  if (cur.account && me() && cur.account.toLowerCase() !== me().toLowerCase() && cur.assignedTo.toLowerCase() !== me().toLowerCase()) {
    throw new Error('只能删除自己的待办');
  }
  await send(`todo-delete-${id}-yes.{ext}`);
  const still = (await listTodos()).some(t => t.id === String(id));
  if (still) throw new Error('禅道没有删除这条待办');
  return { success: true };
}

/** 描述里粘贴的图片：上传到禅道编辑器，返回可放进 <img src> 的地址（相对地址，保存时原样写进描述） */
export async function uploadTodoImage({ uid, name, mime, buffer }) {
  if (!/^[\w-]{3,64}$/.test(String(uid || ''))) throw new Error('缺少编辑会话编号');
  if (!buffer || !buffer.length) throw new Error('图片是空的');
  if (buffer.length > 10 * 1024 * 1024) throw new Error('图片不能超过 10MB');
  if (!/^image\/(png|jpe?g|gif|webp|bmp)$/i.test(mime || '')) throw new Error('只支持图片');
  const { CH } = await session();
  return uploadEditorImage(uid, { name: name || 'image.png', mime, buffer }, CH);
}
