/**
 * 报告页：基于禅道数据的日报 / 周报 / 月报（我的 + 全员）
 *
 * 数据来源（禅道「动态」对本账号只返回自己的操作，全员数据只能这样汇总）：
 *   - 本地执行清单里每个执行的任务列表（负责人、状态、完成人 / 时间、截止日期）
 *   - 周期内有改动的任务的工时记录（谁、哪天、多少小时、工作内容）
 *   - 我的 Bug（我提交的 / 我解决的）
 * 覆盖范围 = 本账号能看到的执行；团队 = 「我的地盘 → 团队」全员（不含 admin），
 * 设置里配置了「全员报告关注的用户」时只统计这些人（「我的」部分不受影响）。
 *
 * 报告生成后保存为快照（data/reports.json）：之后补填的工时不会改动已保存的报告，「重新生成」才会更新。
 * 生成时间与晚间日报配置一致：日报每天晚间（周末仅当天有人有工作记录时）、周报周五 17:00、
 * 月报当月最后一个工作日晚间。
 */
import { join } from 'path';
import { config } from '../config.js';
import { decodeZentaoText } from '../utils/text.js';
import { readJSON, writeJSON, readHistory } from '../utils/storage.js';
import { isRestDay, dayKind } from '../utils/workCalendar.js';

const KIND_LABEL = { daily: '日报', weekly: '周报', monthly: '月报' };
const STATUS_LABEL = { wait: '未开始', doing: '进行中', pause: '已暂停', done: '已完成', closed: '已关闭', cancel: '已取消' };
const OPEN_STATUSES = new Set(['wait', 'doing', 'pause']);
const EXCLUDED_ACCOUNTS = new Set(['admin']);

// ==================== 日期 ====================
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
const dayOf = (v) => { const s = String(v || ''); return /^\d{4}-\d{2}-\d{2}/.test(s) && !s.startsWith('0000') ? s.slice(0, 10) : ''; };
// 「不用上班」：周末 + 节假日，调休上班的周末不算（见 utils/workCalendar.js）
const isWeekend = (s) => isRestDay(s);
const round1 = (n) => Math.round(n * 10) / 10;
const cnDate = (s) => { const d = parseYmd(s); return `${d.getMonth() + 1}月${d.getDate()}日`; };

/** 某天所在周的周一 */
function mondayOf(s) {
  const d = parseYmd(s);
  const w = d.getDay() || 7;
  d.setDate(d.getDate() - w + 1);
  return ymd(d);
}

/** 当月最后一个工作日（周一至周五；不含法定节假日调休） */
function lastWorkdayOfMonth(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  let s = ymd(new Date(y, m, 0));
  while (isWeekend(s)) s = addDays(s, -1);
  return s;
}

/**
 * 报告周期
 * @param {'daily'|'weekly'|'monthly'} kind
 * @param {string} key - daily: YYYY-MM-DD；weekly: 周一的 YYYY-MM-DD（传当周任意一天也会归到周一）；monthly: YYYY-MM
 */
function periodOf(kind, key) {
  if (kind === 'daily') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error('日期格式应为 YYYY-MM-DD');
    return { kind, key, begin: key, end: key, label: `${cnDate(key)} ${KIND_LABEL.daily}` };
  }
  if (kind === 'weekly') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error('日期格式应为 YYYY-MM-DD');
    const begin = mondayOf(key);
    const end = addDays(begin, 6);
    return { kind, key: begin, begin, end, label: `${cnDate(begin)}–${cnDate(end)} ${KIND_LABEL.weekly}` };
  }
  if (kind === 'monthly') {
    if (!/^\d{4}-\d{2}$/.test(key)) throw new Error('月份格式应为 YYYY-MM');
    const [y, m] = key.split('-').map(Number);
    return { kind, key, begin: `${key}-01`, end: ymd(new Date(y, m, 0)), label: `${y}年${m}月 ${KIND_LABEL.monthly}` };
  }
  throw new Error(`不支持的报告类型: ${kind}`);
}

/** 当天的报告是否已到自动生成时间（晚间日报时刻） */
function isPastGenerationTime(now = new Date()) {
  return now.getHours() >= (Number(config.schedule.eveningHour) || 21);
}

/**
 * 周期内「应当填工时」的工作日：周一至周五，且不晚于今天；今天要等到晚间日报时刻之后才算
 */
function workdaysOf(period, now = new Date()) {
  const today = ymd(now);
  const days = [];
  for (let s = period.begin; s <= period.end; s = addDays(s, 1)) {
    if (isWeekend(s) || s > today) continue;
    if (s === today && !isPastGenerationTime(now)) continue;
    days.push(s);
  }
  return days;
}

// ==================== 采集 ====================
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function slimTask(t, exec) {
  return {
    id: String(t.id),
    name: decodeZentaoText(t.name || ''),
    status: t.status || '',
    assignedTo: t.assignedTo || '',
    finishedBy: t.finishedBy || '',
    finishedDate: dayOf(t.finishedDate),
    closedBy: t.closedBy || '',
    closedDate: dayOf(t.closedDate),
    closedReason: t.closedReason || '',
    canceledBy: t.canceledBy || '',
    openedBy: t.openedBy || '',
    openedDate: dayOf(t.openedDate),
    lastEditedDate: dayOf(t.lastEditedDate),
    // 缓存键（精确到秒 + 累计消耗）：与工时日历共用任务工时缓存，没改过的任务不重复请求
    sig: `${t.lastEditedDate || ''}|${t.consumed ?? ''}`,
    deadline: dayOf(t.deadline),
    executionId: String(exec.id),
    executionName: decodeZentaoText(exec.name || ''),
    project: decodeZentaoText(exec.projectName || exec.name || '') || '未归属项目'
  };
}

/**
 * 从禅道采集周期内的原始数据
 * @returns {Promise<{tasks:Object[], efforts:Object[], myBugs:{opened:Object[],resolved:Object[]}, members:Object[], executionCount:number, errors:string[]}>}
 */
async function collectRaw(period, { onProgress } = {}) {
  const z = await import('./zentaoService.js');
  const { getExecutions } = await import('./executionManager.js');
  const executions = (await getExecutions()) || [];
  const CH = z.cookiesToString(await z.getZentaoCookies());
  const errors = [];
  const progress = (msg) => { if (onProgress) onProgress(msg); };

  progress(`读取团队成员与 ${executions.length} 个执行的任务…`);
  const [members, lists] = await Promise.all([
    z.getTeamMembers(),
    mapLimit(executions, 6, async (e) => {
      try {
        return (await z.listExecutionTasks(e.id, CH)).map(t => slimTask(t, e));
      } catch (err) {
        errors.push(`执行「${e.name}」：${err.message}`);
        return [];
      }
    })
  ]);

  const byId = new Map();
  for (const t of lists.flat()) if (!byId.has(t.id)) byId.set(t.id, t);
  const tasks = [...byId.values()];

  // 记工时会更新任务的最后编辑时间：周期开始后没改过的任务不可能有周期内的工时
  const candidates = tasks.filter(t => t.lastEditedDate && t.lastEditedDate >= period.begin);
  progress(`读取 ${candidates.length} 个任务的工时记录…`);
  const ec = await import('./effortService.js');
  const fetched = {};
  const effortLists = await mapLimit(candidates, 6, async (t) => {
    try {
      let all = ec.cachedTaskEfforts(t.id, t.sig);
      if (!all) { all = await z.getTaskEfforts(t.id, CH); fetched[t.id] = { sig: t.sig, efforts: all }; }
      return all
        .filter(e => e.date >= period.begin && e.date <= period.end && e.consumed > 0)
        .map(e => ({ ...e, taskId: t.id }));
    } catch (err) {
      errors.push(`任务 #${t.id} 工时：${err.message}`);
      return [];
    }
  });
  ec.storeTaskEfforts(fetched);

  const myBugs = { opened: [], resolved: [] };
  try {
    const [opened, resolved] = await Promise.all([z.fetchMyList('bug', 'openedBy', CH), z.fetchMyList('bug', 'resolvedBy', CH)]);
    const inRange = (d) => { const s = dayOf(d); return s && s >= period.begin && s <= period.end; };
    const slimBug = (b) => ({ id: String(b.id), title: decodeZentaoText(b.title || ''), status: b.status || '', severity: b.severity, productName: decodeZentaoText(b.productName || ''), openedDate: dayOf(b.openedDate), resolvedDate: dayOf(b.resolvedDate), resolution: b.resolution || '' });
    myBugs.opened = opened.items.filter(b => inRange(b.openedDate)).map(slimBug);
    myBugs.resolved = resolved.items.filter(b => inRange(b.resolvedDate)).map(slimBug);
  } catch (err) {
    errors.push(`我的 Bug：${err.message}`);
  }

  return { tasks, efforts: effortLists.flat(), myBugs, members, executionCount: executions.length, errors };
}

// ==================== 统计 ====================
/**
 * 原始数据 → 报告统计（纯函数，便于测试）
 * @param {Object} raw - collectRaw 的结果
 * @param {Object} period - periodOf 的结果
 * @param {{me:string, now?:Date, focus?:string[]}} options - focus：全员部分只统计这些账号（空 = 全员）
 */
function computeReport(raw, period, { me, now = new Date(), focus = [] }) {
  const focusSet = new Set(focus);
  const members = (raw.members || [])
    .filter(m => !EXCLUDED_ACCOUNTS.has(m.account))
    .filter(m => !focusSet.size || focusSet.has(m.account));
  const nameOf = new Map(members.map(m => [m.account, m.realname || m.account]));
  const taskById = new Map((raw.tasks || []).map(t => [t.id, t]));
  const workdays = workdaysOf(period, now);
  const inRange = (d) => d && d >= period.begin && d <= period.end;
  const statusLabel = (s) => STATUS_LABEL[s] || s;
  // 完成：走了「完成」动作的看完成人 / 完成时间；没走「完成」直接关闭的（插件把进度拉到 100% 时就是这样）
  // 看关闭人 / 关闭时间，取消的不算
  const finishedOf = (t) => {
    if (t.finishedDate) return { by: t.finishedBy, date: t.finishedDate };
    if (t.closedDate && !t.canceledBy && t.closedReason !== 'cancel') return { by: t.closedBy, date: t.closedDate };
    return null;
  };

  const personOf = (m) => {
    const efforts = (raw.efforts || []).filter(e => e.account === m.account);
    const byDay = {};
    const byTask = new Map();
    for (const e of efforts) {
      byDay[e.date] = round1((byDay[e.date] || 0) + e.consumed);
      const t = taskById.get(e.taskId);
      if (!byTask.has(e.taskId)) {
        byTask.set(e.taskId, {
          taskId: e.taskId, name: t ? t.name : `任务 #${e.taskId}`, project: t ? t.project : '未归属项目',
          executionName: t ? t.executionName : '', status: t ? t.status : '', statusLabel: t ? statusLabel(t.status) : '',
          hours: 0, works: []
        });
      }
      const agg = byTask.get(e.taskId);
      agg.hours = round1(agg.hours + e.consumed);
      if (e.work && !agg.works.includes(e.work)) agg.works.push(e.work);
    }
    const finished = (raw.tasks || [])
      .map(t => ({ t, f: finishedOf(t) }))
      .filter(({ f }) => f && f.by === m.account && inRange(f.date))
      .map(({ t, f }) => ({ id: t.id, name: t.name, project: t.project, finishedDate: f.date }));
    const opened = (raw.tasks || []).filter(t => t.openedBy === m.account && inRange(t.openedDate)).length;
    const tasks = [...byTask.values()].sort((a, b) => b.hours - a.hours);
    const hours = round1(efforts.reduce((s, e) => s + e.consumed, 0));
    return {
      account: m.account,
      name: m.realname || m.account,
      role: m.role || '',
      hours,
      byDay,
      tasks,
      finished,
      opened,
      missingDays: workdays.filter(d => !byDay[d])
    };
  };

  const people = members.map(personOf).sort((a, b) => b.hours - a.hours || a.name.localeCompare(b.name, 'zh'));
  const memberSet = new Set(members.map(m => m.account));

  // 按项目
  const projectMap = new Map();
  for (const e of raw.efforts || []) {
    if (!memberSet.has(e.account)) continue;
    const t = taskById.get(e.taskId);
    const project = t ? t.project : '未归属项目';
    if (!projectMap.has(project)) projectMap.set(project, { project, hours: 0, memberHours: new Map(), taskMap: new Map(), finished: 0 });
    const p = projectMap.get(project);
    p.hours += e.consumed;
    p.memberHours.set(e.account, (p.memberHours.get(e.account) || 0) + e.consumed);
    if (!p.taskMap.has(e.taskId)) p.taskMap.set(e.taskId, { taskId: e.taskId, name: t ? t.name : `任务 #${e.taskId}`, hours: 0, people: new Set(), status: t ? t.status : '', statusLabel: t ? statusLabel(t.status) : '' });
    const pt = p.taskMap.get(e.taskId);
    pt.hours += e.consumed;
    pt.people.add(nameOf.get(e.account) || e.account);
  }
  for (const t of raw.tasks || []) {
    const f = finishedOf(t);
    if (f && memberSet.has(f.by) && inRange(f.date) && projectMap.has(t.project)) projectMap.get(t.project).finished++;
  }
  const projects = [...projectMap.values()].map(p => ({
    project: p.project,
    hours: round1(p.hours),
    finished: p.finished,
    members: [...p.memberHours.entries()].map(([account, h]) => ({ account, name: nameOf.get(account) || account, hours: round1(h) })).sort((a, b) => b.hours - a.hours),
    tasks: [...p.taskMap.values()].map(t => ({ ...t, hours: round1(t.hours), people: [...t.people] })).sort((a, b) => b.hours - a.hours)
  })).sort((a, b) => b.hours - a.hours);

  // 逾期：截止日期早于周期末、仍未完成、负责人是团队成员
  const overdue = (raw.tasks || [])
    .filter(t => OPEN_STATUSES.has(t.status) && t.deadline && t.deadline < period.end && memberSet.has(t.assignedTo))
    .sort((a, b) => b.deadline.localeCompare(a.deadline))
    .map(t => ({ id: t.id, name: t.name, project: t.project, deadline: t.deadline, assignedTo: t.assignedTo, assignedToName: nameOf.get(t.assignedTo) || t.assignedTo, statusLabel: statusLabel(t.status) }));

  const team = {
    focused: focusSet.size > 0,
    totalHours: round1(people.reduce((s, p) => s + p.hours, 0)),
    activeCount: people.filter(p => p.hours > 0).length,
    members: people,
    projects,
    overdue: overdue.slice(0, 50),
    overdueTotal: overdue.length
  };

  // 「我」可能不在关注名单里：我的部分单独算，不受名单影响
  const meMember = (raw.members || []).find(m => m.account === me) || { account: me, realname: me };
  const meBase = people.find(p => p.account === me) || personOf(meMember);
  const myProjects = new Map();
  for (const t of meBase.tasks) myProjects.set(t.project, round1((myProjects.get(t.project) || 0) + t.hours));
  const openTasks = (raw.tasks || [])
    .filter(t => t.assignedTo === me && OPEN_STATUSES.has(t.status))
    .sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999'))
    .map(t => ({ id: t.id, name: t.name, project: t.project, deadline: t.deadline, statusLabel: statusLabel(t.status) }));
  const mine = {
    ...meBase,
    byProject: [...myProjects.entries()]
      .map(([project, hours]) => ({ project, hours }))
      .sort((a, b) => b.hours - a.hours),
    bugs: raw.myBugs || { opened: [], resolved: [] },
    openTasks: openTasks.slice(0, 50),
    overdue: overdue.filter(t => t.assignedTo === me)
  };

  return { mine, team, workdays };
}

// ==================== 存储 ====================
const storePath = () => join(config.paths.data, 'reports.json');
let storeLock = Promise.resolve();

async function readStore() {
  const data = await readJSON(storePath());
  return data && data.reports ? data : { version: 1, reports: {} };
}

function updateStore(mutator) {
  const run = storeLock.then(async () => {
    const data = await readStore();
    await mutator(data);
    await writeJSON(storePath(), data);
    return data;
  });
  storeLock = run.then(() => undefined, () => undefined);
  return run;
}

const reportId = (kind, key) => `${kind}:${key}`;

async function getReport(kind, key) {
  const period = periodOf(kind, key);
  const store = await readStore();
  return store.reports[reportId(kind, period.key)] || null;
}

/**
 * 已生成的报告（历史报告列表），按周期倒序；只给列表需要的字段
 * @param {number} [limit=100]
 */
async function listReports(limit = 100) {
  const store = await readStore();
  const order = { monthly: 0, weekly: 1, daily: 2 };
  return Object.values(store.reports)
    .sort((a, b) => b.end.localeCompare(a.end) || order[a.kind] - order[b.kind])
    .slice(0, limit)
    .map(r => ({
      kind: r.kind,
      key: r.key,
      label: r.label,
      generatedAt: r.generatedAt,
      auto: !!r.auto,
      ...brief(r),
      summary: (r.mine.ai && r.mine.ai.summary) || ''
    }));
}

// ==================== 生成 ====================
const inflight = new Map();
const progressOf = new Map();

/**
 * 生成并保存一份报告（同一份报告并发请求只生成一次）
 * @param {'daily'|'weekly'|'monthly'} kind
 * @param {string} key
 * @param {{auto?:boolean, skipIfIdle?:boolean, now?:Date, part?:'mine'|'team'}} [options]
 *   skipIfIdle：没有任何工作记录时不保存（周末自动日报）
 *   part：只重新生成这一部分（报告窗口里在「我的」/「全员」下点「重新生成」），另一部分保持原样
 * @returns {Promise<Object|null>} 报告；skipIfIdle 且无记录时返回 null
 */
function generateReport(kind, key, options = {}) {
  const period = periodOf(kind, key);
  const id = reportId(kind, period.key);
  if (inflight.has(id)) return inflight.get(id);
  const job = (async () => {
    const now = options.now || new Date();
    if (period.begin > ymd(now)) throw new Error('不能生成未来日期的报告');
    if (!config.zentao.enabled) throw new Error('禅道未启用，报告页的数据来自禅道');
    const me = config.zentao.username;
    const started = Date.now();
    const old = options.part ? await getReport(kind, period.key) : null;
    const part = old ? options.part : null;
    const raw = await collectRaw(period, { onProgress: (m) => progressOf.set(id, m) });
    const { mine, team, workdays } = computeReport(raw, period, { me, now, focus: config.reports.members });

    const idle = team.activeCount === 0 && !mine.hours && !team.members.some(p => p.finished.length || p.opened)
      && !mine.bugs.opened.length && !mine.bugs.resolved.length;
    if (options.skipIfIdle && idle) {
      console.log(`[Report] ${period.label}：没有任何工作记录，跳过`);
      return null;
    }

    progressOf.set(id, 'AI 正在总结…');
    const { summarizeMine, summarizeTeam } = await import('../ai/reportAI.js');
    const skip = Promise.resolve(null);
    const [mineAi, teamAi] = await Promise.allSettled([
      part === 'team' ? skip : summarizeMine(mine, period),
      part === 'mine' ? skip : summarizeTeam(team, period)
    ]);
    const generatedAt = new Date().toISOString();
    const withAi = (data, ai) => ({
      ...data,
      generatedAt,
      auto: !!options.auto,
      ai: ai.status === 'fulfilled' ? ai.value : null,
      aiError: ai.status === 'rejected' ? ai.reason.message : ''
    });

    // 保留的那一部分：以前的报告没有分部分记生成时间，补上原来的
    const kept = (data) => ({ generatedAt: old.generatedAt, auto: !!old.auto, ...data });
    const report = {
      id,
      kind,
      key: period.key,
      begin: period.begin,
      end: period.end,
      label: period.label,
      generatedAt,
      auto: !!options.auto,
      durationMs: Date.now() - started,
      coverage: { executions: raw.executionCount, members: team.members.length, workdays: workdays.length },
      warnings: raw.errors.slice(0, 20),
      mine: part === 'team' ? kept(old.mine) : withAi(mine, mineAi),
      team: part === 'mine' ? kept(old.team) : withAi(team, teamAi)
    };
    // 保留的那一部分沿用它自己的统计范围
    if (part === 'mine') report.coverage.members = old.coverage.members;
    await updateStore((data) => { data.reports[id] = report; });
    console.log(`[Report] ${period.label}${part ? `（${part === 'mine' ? '我的' : '全员'}部分）` : ''} 已生成（${report.durationMs}ms，我 ${mine.hours}h，全员 ${team.totalHours}h，警告 ${raw.errors.length}）`);
    return report;
  })().finally(() => { inflight.delete(id); progressOf.delete(id); });
  inflight.set(id, job);
  return job;
}

function generationStatus(kind, key) {
  const id = reportId(kind, periodOf(kind, key).key);
  return { generating: inflight.has(id), progress: progressOf.get(id) || '' };
}

/**
 * 推送报告的一部分；定时生成只推「我的」（全员数据默认不外发），
 * 「全员」只在报告窗口里切到全员后手动推送
 * @param {'mine'|'team'} [part='mine']
 */
async function pushReport(report, part = 'mine') {
  // 没配置推送地址时 sendNotification 也返回成功：这里先拦下，避免界面提示「已推送」
  if (!config.webhook.url) throw new Error('还没有配置推送地址（设置 → 通知推送 → Webhook）');
  const { title, summary, items } = part === 'team' ? teamPushContent(report) : minePushContent(report);
  const { sendNotification } = await import('../utils/webhook.js');
  const r = await sendNotification(title, summary, items);
  if (r && r.success === false) throw new Error(r.message || r.error || '推送失败');
}

function minePushContent(report) {
  const ai = report.mine.ai;
  const items = [
    `⏱ 工时 ${report.mine.hours}h · 完成任务 ${report.mine.finished.length} 个`,
    ...(ai ? [
      ...(ai.done.length ? ['', '✅ 已完成', ...ai.done.map(x => `  - ${x}`)] : []),
      ...(ai.progress.length ? ['', '🔄 进行中', ...ai.progress.map(x => `  - ${x}`)] : []),
      ...(ai.next.length ? ['', '🎯 接下来', ...ai.next.map(x => `  - ${x}`)] : []),
      ...(ai.risks.length ? ['', '⚠️ 风险', ...ai.risks.map(x => `  - ${x}`)] : [])
    ] : report.mine.tasks.map(t => `  - ${t.name}（${t.hours}h）`))
  ];
  return { title: `📊 ${report.label}`, summary: ai ? ai.summary : '', items };
}

function teamPushContent(report) {
  const t = report.team;
  const ai = t.ai;
  const aiOf = new Map(((ai && ai.byPerson) || []).map(x => [x.account, x.summary]));
  const active = t.members.filter(p => p.hours || p.finished.length);
  const missing = t.members.filter(p => p.missingDays.length).map(p => p.name);
  const items = [
    `⏱ 总工时 ${t.totalHours}h · 有工时记录 ${t.activeCount}/${t.members.length} 人 · 逾期任务 ${t.overdueTotal} 个`,
    ...(ai && ai.risks.length ? ['', '⚠️ 需要关注', ...ai.risks.map(x => `  - ${x}`)] : []),
    ...(active.length ? ['', '👥 按人', ...active.map(p => `  - ${p.name}（${p.hours}h）${aiOf.get(p.account) ? `：${aiOf.get(p.account)}` : ''}`)] : []),
    ...(missing.length ? ['', `📝 未填工时：${missing.join('、')}`] : [])
  ];
  return { title: `📊 ${report.label}（全员）`, summary: ai ? ai.overall : '', items };
}

/** 定时生成后的自动推送：没配置推送地址就不推 */
async function autoPush(report, what) {
  if (!report || !config.webhook.url) return;
  await pushReport(report).catch(err => console.error(`[Report] ${what}推送失败:`, err.message));
}

// ==================== 日历 ====================
const brief = (r) => r && {
  generatedAt: r.generatedAt,
  myHours: r.mine.hours,
  teamHours: r.team.totalHours,
  activeCount: r.team.activeCount,
  memberCount: r.team.members.length,
  myMissing: (r.mine.missingDays || []).length,
  aiOk: !!(r.mine.ai && r.team.ai)
};

/**
 * 某月的日历：每天的日报状态、覆盖该月的每一周的周报、当月月报
 * @param {string} month - YYYY-MM
 */
async function getCalendar(month, now = new Date()) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('月份格式应为 YYYY-MM');
  const store = await readStore();
  const history = await readHistory().catch(() => ({}));
  const legacy = new Set((history.reports || history.dailySummaries || []).filter(r => (!r.type || r.type === 'daily') && r.date).map(r => r.date));
  const today = ymd(now);
  const period = periodOf('monthly', month);

  const days = [];
  for (let s = period.begin; s <= period.end; s = addDays(s, 1)) {
    const r = store.reports[reportId('daily', s)];
    days.push({
      date: s,
      weekday: parseYmd(s).getDay(),
      weekend: isWeekend(s),
      holiday: dayKind(s) === 'holiday',
      makeup: dayKind(s) === 'makeup',
      future: s > today,
      today: s === today,
      report: brief(r),
      legacy: legacy.has(s)
    });
  }
  const weeks = [];
  for (let w = mondayOf(period.begin); w <= period.end; w = addDays(w, 7)) {
    const wp = periodOf('weekly', w);
    weeks.push({ key: w, label: wp.label, begin: wp.begin, end: wp.end, future: w > today, report: brief(store.reports[reportId('weekly', w)]) });
  }
  return {
    month,
    today,
    eveningHour: Number(config.schedule.eveningHour) || 21,
    days,
    weeks,
    monthly: { key: month, label: period.label, future: period.begin > today, report: brief(store.reports[reportId('monthly', month)]), autoDate: lastWorkdayOfMonth(month) }
  };
}

// ==================== 定时生成 ====================
/** 晚间：当天日报（周末仅在有工作记录时）；当月最后一个工作日再生成月报 */
async function runEveningReports(now = new Date()) {
  const today = ymd(now);
  const daily = await generateReport('daily', today, { auto: true, skipIfIdle: isWeekend(today), now });
  await autoPush(daily, '日报');
  const month = today.slice(0, 7);
  if (today === lastWorkdayOfMonth(month)) {
    const monthly = await generateReport('monthly', month, { auto: true, now });
    await autoPush(monthly, '月报');
  }
  return daily;
}

/** 周五：本周周报 */
async function runWeeklyReport(now = new Date()) {
  const weekly = await generateReport('weekly', ymd(now), { auto: true, now });
  await autoPush(weekly, '周报');
  return weekly;
}

export {
  periodOf,
  mondayOf,
  lastWorkdayOfMonth,
  workdaysOf,
  computeReport,
  collectRaw,
  generateReport,
  generationStatus,
  getReport,
  listReports,
  getCalendar,
  pushReport,
  runEveningReports,
  runWeeklyReport,
  ymd
};
