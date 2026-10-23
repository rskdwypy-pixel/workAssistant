/**
 * 建「关联需求 / Bug」的任务（需求拆任务、Bug 转任务）。
 *
 * 实测（ZenTao 18.3，2026-10-23，执行 61 看板型 + 普通执行）：
 *   - 必须 multipart/form-data + X-Requested-With；用 urlencoded 禅道只会把表单页原样回来（HTTP 200、无错误、任务没建）。
 *   - 需求：POST task-create-{执行}-{需求}-0.html，字段 story；成功不改需求的 stage / status。
 *   - Bug：POST task-create-{执行}-0-0-0-0-projectID={项目}-{BugID}.html，没有 fromBug 字段，Bug 只在 URL 里；
 *     成功后任务 fromBug=BugID、Bug.toTask=任务ID，Bug 状态不变；重复转不会被拒绝（会再建一个并覆盖 toTask），所以这里自己拦。
 *   - 响应都不带新任务 ID，只能按标题回查；回读用 task-view-{id}.json?onlybody=yes（不带 onlybody 会回看板刷新指令）。
 *   - 看板型执行要带 region / lane（取自看板页）。
 */
import { config } from '../config.js';
import { getZentaoCookies, cookiesToString, getZentaoJson, getKanbanParams, getTasks } from './zentaoService.js';

const TASK_TYPES = ['design', 'devel', 'request', 'test', 'study', 'discuss', 'ui', 'affair', 'misc'];
const base = () => String(config.zentao.url || '').replace(/\/$/, '');

/** 禅道失败响应里的 message 可能是 {字段:[错误…]} */
export function flattenMessage(m) {
  if (!m) return '';
  if (typeof m === 'string') return m;
  if (typeof m === 'object') return Object.values(m).flat().map(String).join('；');
  return String(m);
}

/** 校验并规整一条任务（纯函数，便于单测） */
export function normalizeDraft(d = {}) {
  const name = String(d.name ?? '').trim();
  if (!name) throw new Error('任务标题不能为空');
  const type = d.type || 'devel';
  if (!TASK_TYPES.includes(type)) throw new Error(`不支持的任务类型：${type}`);
  const estimate = d.estimate === '' || d.estimate == null ? '' : Number(d.estimate);
  if (estimate !== '' && (!Number.isFinite(estimate) || estimate < 0)) throw new Error('预计工时必须是不小于 0 的数字');
  const pri = Number(d.pri ?? 3);
  if (![1, 2, 3, 4].includes(pri)) throw new Error('优先级只能是 1~4');
  const date = (v) => (v ? String(v).slice(0, 10) : '');
  return {
    name, type, pri, estimate,
    assignedTo: String(d.assignedTo || '').trim(),
    desc: String(d.desc ?? ''),
    estStarted: date(d.estStarted), deadline: date(d.deadline)
  };
}

/** 组装表单（不含看板字段时就是普通执行表单） */
export function buildTaskForm(draft, { storyId, kanban } = {}) {
  const fd = new FormData();
  const put = (k, v) => fd.append(k, v == null ? '' : String(v));
  put('type', draft.type); put('module', '0'); put('assignedTo[]', draft.assignedTo);
  put('teamMember', ''); put('mode', 'linear');
  if (kanban && kanban.region && kanban.lane) { put('region', kanban.region); put('lane', kanban.lane); }
  put('status', 'wait'); put('story', storyId || ''); put('color', '');
  put('name', draft.name);
  put('storyEstimate', ''); put('storyDesc', ''); put('storyPri', '');
  put('pri', draft.pri); put('estimate', draft.estimate); put('desc', draft.desc);
  put('estStarted', draft.estStarted); put('deadline', draft.deadline);
  put('after', 'toTaskList'); put('uid', Math.random().toString(36).slice(2, 14));
  return fd;
}

async function cookieHeader() { return cookiesToString(await getZentaoCookies()); }

/** 执行所属项目 + 是否看板型 + 看板 region/lane */
export async function getExecutionMeta(executionId, CH) {
  const d = await getZentaoJson(`execution-view-${executionId}.json?onlybody=yes`, CH);
  const ex = (d && (d.execution || d)) || {};
  const meta = { id: String(executionId), name: ex.name || '', project: String(ex.project || ''), kanban: null };
  if (String(ex.type) === 'kanban') {
    const k = await getKanbanParams(executionId, 'task', 'wait');
    if (k && k.regionId && k.laneId) meta.kanban = { region: String(k.regionId), lane: String(k.laneId) };
  }
  return meta;
}

/** Bug 是否已转过任务 */
export async function getBugLink(bugId, CH) {
  const d = await getZentaoJson(`bug-view-${bugId}.json?onlybody=yes`, CH);
  const b = (d && d.bug) || {};
  const toTask = String(b.toTask || '0');
  return { exists: !!b.id, toTask: toTask === '0' ? '' : toTask, status: b.status || '', title: b.title || '' };
}

/** 需求下已有的任务（来自需求详情的 tasks 字段，时有时无） */
export async function getStoryTasks(storyId, CH) {
  const d = await getZentaoJson(`story-view-${storyId}.json?onlybody=yes`, CH);
  const tasks = (d && d.story && d.tasks) || (d && d.tasks) || {};
  return Object.values(tasks).flat().map((t) => ({
    id: String(t.id), name: t.name, assignedTo: t.assignedTo, status: t.status,
    execution: String(t.execution), consumed: t.consumed, left: t.left
  }));
}

/**
 * 创建一个关联需求或 Bug 的任务。
 * @param {{executionId:string, storyId?:string, bugId?:string}} link  storyId 与 bugId 至多一个
 * @param {object} draft  见 normalizeDraft
 * @returns {{success:boolean, taskId?:string, linked?:boolean, message:string, code?:string}}
 */
export async function createLinkedTask(link, draft) {
  const { executionId, storyId, bugId } = link || {};
  if (!executionId) return { success: false, message: '请选择执行' };
  if (storyId && bugId) return { success: false, message: '一个任务只能关联需求或 Bug 之一' };
  let d;
  try { d = normalizeDraft(draft); } catch (e) { return { success: false, message: e.message, code: 'INVALID' }; }
  try {
    const CH = await cookieHeader();
    if (bugId) {
      const cur = await getBugLink(bugId, CH);
      if (!cur.exists) return { success: false, message: 'Bug 不存在或无权查看', code: 'NOT_FOUND' };
      if (cur.toTask) return { success: false, message: `该 Bug 已转为任务 #${cur.toTask}`, code: 'ALREADY_LINKED', taskId: cur.toTask };
    }
    const meta = await getExecutionMeta(executionId, CH);
    if (bugId && !meta.project) return { success: false, message: '无法确定该执行所属的项目', code: 'NO_PROJECT' };
    const url = bugId
      ? `${base()}/zentao/task-create-${executionId}-0-0-0-0-projectID=${meta.project}-${bugId}.html`
      : `${base()}/zentao/task-create-${executionId}-${storyId || 0}-0.html`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Cookie: CH, 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*; q=0.01', Referer: url },
      body: buildTaskForm(d, { storyId, kanban: meta.kanban }),
      redirect: 'manual'
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { return { success: false, message: '禅道没有接受这次提交（返回了页面而不是结果）', code: 'NOT_ACCEPTED' }; }
    if (data.result !== 'success') return { success: false, message: flattenMessage(data.message) || '禅道返回失败', code: 'REJECTED' };

    // 响应不带任务 ID：按标题回查最新的
    const tasks = await getTasks({ executionId });
    const hits = (tasks || []).filter((t) => String(t.name).trim() === d.name).sort((a, b) => Number(b.id) - Number(a.id));
    const taskId = hits[0] ? String(hits[0].id) : null;
    if (!taskId) return { success: true, linked: false, message: '已提交，但没能在执行里找到新任务，请到禅道确认' };
    // 回读确认真的关联上了
    let linked = false;
    try {
      const t = (await getZentaoJson(`task-view-${taskId}.json?onlybody=yes`, CH)).task || {};
      linked = bugId ? String(t.fromBug) === String(bugId) : storyId ? String(t.story) === String(storyId) : true;
    } catch { /* 回读失败不影响创建结果 */ }
    return { success: true, taskId, linked, message: linked ? `任务已创建（#${taskId}）` : `任务已创建（#${taskId}），但没能确认关联，请到禅道核对` };
  } catch (err) {
    return { success: false, message: err.message };
  }
}
