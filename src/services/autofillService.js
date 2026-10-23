/**
 * 工时自动补填（调试模式下的「补」）。设计见 docs/AUTOFILL-PRD.md。
 *
 *   buildPlan({dates|month, seed})   只生成方案（预览用），不写任何东西
 *   rewriteWorks(...)                重新写某天的工作内容
 *   startExecution({planId, days})   按（用户确认 / 编辑后的）方案后台逐条写入禅道，返回 jobId
 *   getJob(id) / stopJob(id)         进度 / 停止
 *   undoBatch(batchId)               撤销一批：逐条删除这批写入的、仍然存在且没被改过的工时
 *   getLog()                         补填记录
 *
 * 选任务的硬条件：只用「那一天正在做」的任务——
 *   · 现在「进行中」：当天已存在（创建 / 预计开始 / 实际开始都不晚于当天）且剩余工时 > 0；
 *   · 现在「已完成」但当天还没完成（当天已存在且 当天 ≤ 完成日）：补历史最需要的就是这类任务。
 *     已用真实禅道验证：在已完成的任务上补记工时，状态 / 完成日期都不变，剩余仍为 0。
 * 「未开始 / 暂停」不用：在未开始的任务上记工时会让禅道自动开始它，并把实际开始设成「现在」，删掉工时也回不去。
 * 进行中任务写入时剩余沿用当前值（不改剩余、不触发「完成」）；已完成任务传 0 并确认完成（它本来就完成了）。
 * 随机是可复现的（种子 = 日期 + 账号 + 点击次数）；写入的每一条都记在 data/autofill-log.json，可撤销。
 */
import { randomBytes } from 'crypto';
import { join } from 'path';
import { config } from '../config.js';
import { fetchMyList, getZentaoJson, getTaskEfforts, isConfigured, getZentaoCookies, cookiesToString } from './zentaoService.js';
import { getMonthEfforts, addEffort, deleteEffort, standardHours, myEffortsByTask } from './effortService.js';
import { readJSON, writeJSON } from '../utils/storage.js';
import { decodeZentaoText } from '../utils/text.js';
import { isRestDay, restReason } from '../utils/workCalendar.js';

const DEFAULTS = {
  minChunk: 1,          // 单条最少小时（缺口不足 1 小时时例外）
  maxChunk: 4,          // 单条最多小时
  maxDaysPerTask: 8,    // 同一任务一个月里最多被抽几天
  maxOvertime: 2,       // 每天最多额外加班几小时（设置里可调，0 = 不加班）
  maxDays: 31,          // 一次最多几天
  maxEntries: 100,      // 一次最多几条
  writeGapMs: 300,      // 两次写入之间的间隔
  planTtlMs: 30 * 60 * 1000
};

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const day10 = (v) => { const s = String(v || ''); return /^\d{4}-\d{2}-\d{2}/.test(s) && !s.startsWith('0000') ? s.slice(0, 10) : ''; };
const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); return ymd(new Date(y, m - 1, d + n)); };
const isWeekend = (s) => isRestDay(s);   // 周末 / 节假日；调休上班的周末算工作日
const round05 = (n) => Math.round(n * 2) / 2;
const round1 = (n) => Math.round(n * 10) / 10;
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00`) - new Date(`${a}T00:00:00`)) / 86400000);

function assertReady() {
  if (!isConfigured()) {
    const err = new Error('禅道未启用或未配置');
    err.code = 'ZENTAO_DISABLED';
    throw err;
  }
}

/* ───────────────────────── 可复现的随机 ───────────────────────── */

function seedFrom(str) {
  let h = 2166136261;
  for (const c of String(str)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 按权重不放回地抽 n 个 */
function weightedSample(items, weights, n, rng) {
  const idx = items.map((_, i) => i);
  const out = [];
  while (out.length < n && idx.length) {
    const total = idx.reduce((s, i) => s + weights[i], 0);
    let r = rng() * total;
    let pick = idx.length - 1;
    for (let k = 0; k < idx.length; k++) { r -= weights[idx[k]]; if (r <= 0) { pick = k; break; } }
    out.push(items[idx[pick]]);
    idx.splice(pick, 1);
  }
  return out;
}

/* ───────────────────────── 候选池 ───────────────────────── */

/** 我的任务（指派给我）精简成选任务需要的字段 */
function slimPoolTask(t) {
  return {
    id: String(t.id),
    name: decodeZentaoText(t.name || ''),
    execName: decodeZentaoText(t.executionName || ''),
    status: String(t.status || ''),
    estimate: Number(t.estimate) || 0,
    consumed: Number(t.consumed) || 0,
    left: Number(t.left) || 0,
    opened: day10(t.openedDate),
    estStarted: day10(t.estStarted),
    realStarted: day10(t.realStarted),
    deadline: day10(t.deadline),
    lastEdited: day10(t.lastEditedDate),
    finishedBy: String(t.finishedBy || ''),
    finished: day10(t.finishedDate)
  };
}

/**
 * 某一天的候选池：只用「那一天正在做」的任务（先要求当天已存在：创建 / 预计开始 / 实际开始都不晚于当天）——
 *   · 进行中：剩余工时 > 0
 *   · 已完成：当天还没完成（当天 ≤ 完成日）。已验证禅道允许在已完成的任务上补记工时且不改变其状态
 * 其它状态不进池：未开始 / 暂停（记工时会让禅道自动开始它）、已关闭 / 已取消（没验证过）。
 */
function poolFor(date, tasks) {
  return tasks.filter(t => {
    if ((t.opened && t.opened > date) || (t.estStarted && t.estStarted > date) || (t.realStarted && t.realStarted > date)) return false;
    if (t.status === 'doing') return t.left > 0;
    if (t.status === 'done') return !t.finished || date <= t.finished;
    return false;
  });
}

/* ───────────────────────── 选任务 + 分配小时 ───────────────────────── */

/** 缺口大小决定抽几个任务：≤2h 一个；≤5h 一到两个；更大两到三个 */
function chooseCount(gap, available, rng, { maxTasks = 3, minChunk = DEFAULTS.minChunk } = {}) {
  let n = gap <= 2 ? 1 : gap <= 5 ? 1 + (rng() < 0.5 ? 1 : 0) : 2 + (rng() < 0.5 ? 1 : 0);
  n = Math.min(n, available, maxTasks, Math.max(1, Math.floor(gap / minChunk)));
  return Math.max(1, n);
}

/** 一条最多分多少小时：不超过 maxChunk，也不超过该任务剩余工时的 1.5 倍（剩 0.9h 的任务不该一天记 3.5h），至少 1h */
function chunkCap(task, maxChunk = DEFAULTS.maxChunk) {
  if (task.status === 'done') return maxChunk;   // 已完成的任务没有「剩余」可参照
  return Math.max(1, Math.min(maxChunk, round05((Number(task.left) || 0) * 1.5)));
}

/**
 * 把缺口（0.5 的倍数）分给 n 条：每条至少 minChunk（缺口太小时例外），总和恰好等于缺口。
 * 每条的上限默认 maxChunk；传 caps（小时）可以按条各自限制（见 chunkCap）。
 * 所有条都到上限了还有剩：先让剩余充足的任务多承担（最多 8h），再放宽到 maxChunk，最后才放进最大的那条（保证总和等于缺口）。
 */
function allocateHours(gap, n, rng, { minChunk = DEFAULTS.minChunk, maxChunk = DEFAULTS.maxChunk, caps } = {}) {
  const units = Math.round(gap * 2);
  const maxU = Math.round(maxChunk * 2);
  const capU = Array.from({ length: n }, (_, i) => Math.min(maxU, caps && caps[i] ? Math.round(caps[i] * 2) : maxU));
  const minU = Math.max(1, Math.min(Math.round(minChunk * 2), Math.floor(units / n), ...capU));
  const alloc = Array(n).fill(minU);
  let rest = units - minU * n;
  const fill = (limits) => {
    while (rest > 0) {
      const open = alloc.map((u, i) => (u < limits[i] ? i : -1)).filter(i => i >= 0);
      if (!open.length) return;
      const i = open[Math.floor(rng() * open.length)];
      const step = Math.min(rest, limits[i] - alloc[i], 1 + Math.floor(rng() * 3));
      alloc[i] += step; rest -= step;
    }
  };
  fill(capU);
  // 都到各自的封顶了还有剩：先让「剩余工时充足」的任务（本来就到 maxChunk 的）多承担，最多一整天 8h，
  // 剩余很小的任务仍守着自己的封顶；还不够再放宽所有条到 maxChunk，最后才放进最大的那条
  if (rest > 0) fill(capU.map(u => (u >= maxU ? Math.max(maxU, 16) : u)));
  if (rest > 0) fill(Array(n).fill(maxU));
  if (rest > 0) alloc[alloc.indexOf(Math.max(...alloc))] += rest;
  return alloc.map(u => u / 2);
}

/**
 * 给一天选任务并分配小时。
 * @param {{date,gap,pool,history,dayExecs,monthUse,rng,maxDaysPerTask}} c
 *   history: Map(taskId → [已有工时的日期])；dayExecs: 当天已有工时所在的执行名；monthUse: Map(taskId → 本月已被抽的天数)
 * @returns {Array<{taskId,taskName,execName,hours}>}
 */
/** 补填参数：调用方（测试 / 方案）显式传的优先，其次设置里的（调试页），最后默认值 */
function limits(c = {}) {
  const cfg = config.autofill || {};
  const pick = (a, b, d) => (a > 0 ? a : b > 0 ? b : d);
  return {
    maxTasks: pick(c.maxTasks, cfg.maxTasksPerDay, 3),
    minChunk: pick(c.minChunk, cfg.minChunk, DEFAULTS.minChunk),
    maxChunk: pick(c.maxChunk, cfg.maxChunk, DEFAULTS.maxChunk),
    maxDaysPerTask: pick(c.maxDaysPerTask, cfg.maxDaysPerTask, DEFAULTS.maxDaysPerTask),
    // 加班上限允许为 0（= 不加班），所以不能和上面一样「0 当作没设」
    maxOvertime: c.maxOvertime !== undefined ? Number(c.maxOvertime) : (Number.isFinite(cfg.maxOvertime) ? cfg.maxOvertime : DEFAULTS.maxOvertime)
  };
}

/**
 * 这一天在「补到标准工时」之外再加几小时（小幅加班，让数据不是每天刚好 8 小时）。
 * 0.5 步长、0 ~ maxOvertime，越小越常见（maxOvertime=2 时大约：不加班 33%、0.5h 27%、1h 20%、1.5h 13%、2h 7%）。
 * 只加不减：补的总量永远 ≥ 补到标准工时所需的量。
 */
function pickOvertime(rng, maxOvertime) {
  const steps = Math.max(0, Math.round((Number(maxOvertime) || 0) * 2));
  if (!steps) return 0;
  const weights = Array.from({ length: steps + 1 }, (_, k) => steps + 1 - k);   // [steps+1, …, 1]
  let r = rng() * weights.reduce((a, b) => a + b, 0);
  for (let k = 0; k <= steps; k++) { r -= weights[k]; if (r <= 0) return k / 2; }
  return 0;
}

function planDay(c) {
  const { date, gap, history, dayExecs = [], monthUse = new Map(), rng } = c;
  const lim = limits(c);
  const cap = lim.maxDaysPerTask;
  const pool = c.pool.filter(t => (monthUse.get(t.id) || 0) < cap);
  if (!pool.length || gap < 0.5) return [];
  const weights = pool.map(t => {
    let w = 1;
    const near = (history.get(t.id) || []).some(d => Math.abs(daysBetween(d, date)) <= 3);
    if (near) w += 2;                                                      // 前后几天在这个任务上有工时：工作有连续性
    if (t.execName && dayExecs.includes(t.execName)) w += 1.5;             // 与当天已有工时同一个执行
    if (t.deadline && daysBetween(date, t.deadline) >= 0 && daysBetween(date, t.deadline) <= 7) w += 1;   // 临近截止
    if (t.lastEdited && Math.abs(daysBetween(t.lastEdited, date)) <= 3) w += 1;                          // 最近编辑过
    if (t.status === 'done' && t.finished && daysBetween(date, t.finished) <= 7) w += 1.5;                 // 当时在做、不久后完成的任务
    const used = monthUse.get(t.id) || 0;
    if (used > 0) w *= Math.max(0.25, 1 - used * 0.12);                    // 本月已经被抽过的降权
    if (t.estimate > 0 && t.consumed >= t.estimate) w *= 0.4;              // 预计工时已用完
    return Math.max(0.1, w);
  });
  const maxChunk = lim.maxChunk;
  const n = chooseCount(gap, pool.length, rng, { maxTasks: lim.maxTasks, minChunk: lim.minChunk });
  const picked = weightedSample(pool, weights, n, rng);
  // 按各任务的剩余工时封顶后，容量不够补满缺口：再多抽几个任务（最多 3 个）；还不够就放宽封顶
  const capacity = () => picked.reduce((s, t) => s + chunkCap(t, maxChunk), 0);
  while (capacity() < gap && picked.length < Math.min(lim.maxTasks, pool.length)) {
    const rest = pool.filter(t => !picked.includes(t));
    picked.push(...weightedSample(rest, rest.map(t => weights[pool.indexOf(t)]), 1, rng));
  }
  const hours = allocateHours(gap, picked.length, rng, { minChunk: lim.minChunk, maxChunk, caps: picked.map(t => chunkCap(t, maxChunk)) });
  return picked.map((t, i) => ({ taskId: t.id, taskName: t.name, execName: t.execName, taskStatus: t.status, hours: hours[i] }));
}

/**
 * 给一批日期做方案（纯函数，便于测试）。日期按从早到晚处理，同一任务整月被抽的天数累计限制。
 * @returns {{days:Array, skipped:Array}}
 */
function planDates(ctx) {
  const { dates, tasks, daysMap, standard, today, seed } = ctx;
  const historyByTask = ctx.history || new Map();
  const monthUse = new Map();
  const days = [], skipped = [];
  for (const date of [...dates].sort()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { skipped.push({ date, reason: '日期格式不对' }); continue; }
    if (date >= today) { skipped.push({ date, reason: date === today ? '今天还没过完，不补' : '将来的日期不能补' }); continue; }
    if (isWeekend(date)) { skipped.push({ date, reason: `${restReason(date)}不补` }); continue; }
    const entryDay = daysMap[date] || { hours: 0, items: [] };
    const existing = entryDay.hours || 0;
    // 要补的量：至少补到标准工时（向上取到 0.5，所以不会比标准工时少；已经 ≥ 标准工时的不动），再加上随机的小幅加班
    const raw = standard - existing;
    const need = raw > 1e-9 ? Math.ceil(raw * 2 - 1e-9) / 2 : 0;
    if (need <= 0) { skipped.push({ date, reason: '这天的工时已经满了' }); continue; }
    const pool = poolFor(date, tasks);
    if (!pool.length) { skipped.push({ date, reason: '这天没有你在做的任务可用（进行中，或当时还没完成的）' }); continue; }
    const rng = mulberry32(seedFrom(`${date}|${ctx.account || ''}|${seed || 0}`));
    const overtime = pickOvertime(rng, limits(ctx).maxOvertime);
    const gap = need + overtime;
    const dayExecs = [...new Set((entryDay.items || []).map(i => i.execName).filter(Boolean))];
    const entries = planDay({ date, gap, pool, history: historyByTask, dayExecs, monthUse, rng, maxDaysPerTask: ctx.maxDaysPerTask });
    if (!entries.length) { skipped.push({ date, reason: '候选任务这个月已经用得太多了' }); continue; }
    for (const e of entries) monthUse.set(e.taskId, (monthUse.get(e.taskId) || 0) + 1);
    days.push({ date, existing: round1(existing), need, overtime, gap, pool: pool.map(t => ({ id: t.id, name: t.name, execName: t.execName, left: t.left, status: t.status })), entries });
  }
  return { days, skipped };
}

/* ───────────────────────── 工作内容 ───────────────────────── */

const AUTO_WORK = /更新进度至|^工作内容进度更新$|^进度更新/;
const FORBIDDEN_WORK = /已完成|已上线|验收通过|#\d+|\d+\s*%|v\d+\.\d+/i;
// 含账号 / 密码 / 链接 / 长数字串的内容：既不能原样抄进新的工时记录，也不能当「写作样例」发给 AI 服务商
const SENSITIVE_WORK = /账号|账户|密码|口令|password|passwd|pwd|token|secret|api[_-]?key|https?:\/\/|[A-Za-z]+\d{5,}|\d{6,}/i;

/** 这条历史内容能不能拿来当样例 / 模板：长度合适、不是系统自动生成的、不含敏感信息 */
function usableWork(w) {
  return typeof w === 'string' && w.length >= 4 && w.length <= 80 && !AUTO_WORK.test(w) && !SENSITIVE_WORK.test(w);
}

/** 去掉任务描述里的链接和「账号 / 密码：xxx」，再发给 AI */
function redact(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/(账号|账户|密码|口令|password|passwd|token)\s*[:：=]?\s*\S+/gi, '')
    .replace(/\s+/g, ' ').trim();
}

/** 用户自己写过的内容（去掉系统自动生成的、含敏感信息的），用来学口吻 */
function styleSamples(history, limit = 8) {
  const all = [];
  for (const list of history.values()) for (const h of list) if (usableWork(h.work)) all.push(h);
  return all.sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit).map(h => h.work);
}

/** AI 不可用时的内容：该任务自己以前写过的 → 没有就用任务名 */
function templateWork(task, history, rng) {
  const own = (history.get(task.taskId) || []).map(h => h.work).filter(usableWork);
  if (own.length) return own[Math.floor(rng() * own.length)];
  return `推进「${task.taskName}」相关工作`;
}

const taskDescCache = new Map();   // taskId → {at, text}
async function describeTask(taskId, CH) {
  const hit = taskDescCache.get(taskId);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.text;
  let text = '';
  try {
    const d = await getZentaoJson(`task-view-${taskId}.json?onlybody=yes`, CH);
    text = redact(decodeZentaoText(String((d && d.task && d.task.desc) || '')).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')).slice(0, 200);
  } catch { /* 取不到描述就只用任务名 */ }
  taskDescCache.set(taskId, { at: Date.now(), text });
  return text;
}

function buildWorkPrompt({ date, items, samples, extra = '' }) {
  return `你在帮用户补写工时的“工作内容”。用户是软件团队成员，这些内容会显示在禅道的工时记录里。

要求：
- 中文，每条 1~2 句，长度和下面“用户以前的写法”相近，口吻也要像他自己；
- 只写这个任务范围内合理的日常工作（梳理、联调、修复、整理文档、评审、测试验证等），结合任务名和描述；
- 不要编造具体数字、缺陷编号、人名、版本号；不要写“已完成 / 已上线 / 验收通过”这类结论；
- 同一批里各条的措辞不要雷同；工时长的写具体一些，工时短的写简短。

${extra ? `用户的额外要求（优先遵守，但不得违反上面的约束）：\n${extra}\n\n` : ''}用户以前的写法（学习口吻，不要照抄）：
${samples.length ? samples.map(s => `- ${s}`).join('\n') : '- （暂无，写简洁的工作描述即可）'}

日期：${date}。需要写 ${items.length} 条，每条对应一个任务：
${JSON.stringify(items.map((it, i) => ({ i, task: it.taskName, project: it.execName, desc: it.desc, hours: it.hours, recent: it.recent })), null, 0)}

只输出 JSON 数组，不要解释：[{"i":0,"work":"..."}]`;
}

function parseWorks(text, n) {
  const m = String(text || '').match(/\[[\s\S]*\]/);
  if (!m) return null;
  let arr;
  try { arr = JSON.parse(m[0]); } catch {
    // AI 偶尔在 JSON 里多打 / 少打一个引号，整段就解析不了：退一步，逐条把 {"i":N, "work":"…"} 抠出来
    arr = [...m[0].matchAll(/"i"\s*:\s*"?(\d+)"?\s*,\s*"work"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map(x => ({ i: Number(x[1]), work: x[2].replace(/\\(.)/g, '$1') }));
    if (!arr.length) return null;
  }
  if (!Array.isArray(arr)) return null;
  const out = new Array(n).fill(null);
  for (const x of arr) {
    if (x && Number.isInteger(x.i) && x.i >= 0 && x.i < n && typeof x.work === 'string') {
      const w = x.work.replace(/\s+/g, ' ').trim();
      if (w.length >= 4 && w.length <= 120 && !FORBIDDEN_WORK.test(w)) out[x.i] = w;
    }
  }
  return out;
}

/**
 * 给一天的若干条写内容。返回 [{work, source:'ai'|'template'}]，长度与 entries 一致。
 * AI 没配置 / 失败 / 某条不合格（雷同、含禁用说法）时该条退回模板。
 */
async function writeWorks({ date, entries, history, CH, ai, rng }) {
  const samples = styleSamples(history);
  const items = [];
  for (const e of entries) {
    items.push({ ...e, desc: ai ? await describeTask(e.taskId, CH) : '', recent: (history.get(e.taskId) || []).map(h => h.work).filter(usableWork).slice(-3) });
  }
  let works = null;
  if (ai) {
    const prompt = buildWorkPrompt({ date, items, samples, extra: (config.autofill && config.autofill.prompt) || '' });
    // 一次没写好（调用失败 / 解析不出 / 超过一半条目不合格）再试一次，还不行才退回模板
    for (let attempt = 0; attempt < 2; attempt++) {
      try { works = parseWorks(await ai(prompt, 700), entries.length); }
      catch (err) { console.warn('[Autofill] AI 写内容失败:', err.message); works = null; }
      if (works && works.filter(Boolean).length * 2 >= entries.length) break;
    }
  }
  const used = new Set();
  return entries.map((e, i) => {
    let w = works && works[i];
    let source = 'ai';
    if (!w || used.has(w)) { w = templateWork(e, history, rng); source = 'template'; }
    used.add(w);
    return { work: w, source };
  });
}

const aiAvailable = () => !!(config.ai.apiKey && config.ai.apiKey.trim());

/* ───────────────────────── 方案（预览） ───────────────────────── */

const plans = new Map();   // planId → {createdAt, dates, poolIds:{date:Set}, existing:{date:hours}}
function gcPlans() {
  for (const [id, p] of plans) if (Date.now() - p.createdAt > DEFAULTS.planTtlMs) plans.delete(id);
}

/** 某月里「过去的工作日」 */
function pastWorkdaysOfMonth(month, today) {
  const [y, m] = month.split('-').map(Number);
  const out = [];
  for (let d = new Date(y, m - 1, 1); d.getMonth() === m - 1; d.setDate(d.getDate() + 1)) {
    const s = ymd(d);
    if (s < today && !isWeekend(s)) out.push(s);
  }
  return out;
}

/** 候选来源：指派给我的任务（进行中 / 已完成等），加上我完成的（已完成）。按任务 id 去重 */
async function fetchPoolTasks(CH) {
  const [assigned, finished] = await Promise.all([
    fetchMyList('task', 'assignedTo', CH),
    fetchMyList('task', 'finishedBy', CH).catch(() => ({ items: [] }))
  ]);
  const byId = new Map();
  for (const t of assigned.items) if (t && t.id && String(t.deleted) !== '1') byId.set(String(t.id), slimPoolTask(t));
  for (const t of finished.items) if (t && t.id && String(t.deleted) !== '1' && t.status === 'done' && !byId.has(String(t.id))) byId.set(String(t.id), slimPoolTask(t));
  return [...byId.values()];
}

/**
 * 生成方案（不写任何东西）。
 * @param {{dates?:string[], month?:string, seed?:number}} opts  dates 与 month 二选一
 * @param {{ai?:Function|null, now?:Date}} deps 测试用：注入 AI / 当前时间
 */
async function buildPlan(opts = {}, deps = {}) {
  assertReady();
  const now = deps.now || new Date();
  const today = ymd(now);
  const standard = standardHours();
  let dates = Array.isArray(opts.dates) ? [...new Set(opts.dates.map(String))] : null;
  if (!dates) {
    if (!/^\d{4}-\d{2}$/.test(String(opts.month || ''))) throw new Error('请给出要补的日期或月份');
    dates = pastWorkdaysOfMonth(opts.month, today);
  }
  if (!dates.length) throw new Error('没有可补的日期');
  if (dates.length > DEFAULTS.maxDays) throw new Error(`一次最多补 ${DEFAULTS.maxDays} 天，请分批`);

  // 先把涉及的月份工时刷到最新（缺口要以禅道当前为准）
  const months = [...new Set(dates.map(d => d.slice(0, 7)))];
  const daysMap = {};
  for (const m of months) {
    const r = await getMonthEfforts(m, { maxAge: 60 * 1000 });
    Object.assign(daysMap, r.days || {});
  }
  const CH = cookiesToString(await getZentaoCookies());
  const tasks = await fetchPoolTasks(CH);
  const history = deps.history || myEffortsByTask();
  const historyDates = new Map([...history].map(([id, list]) => [id, list.map(h => h.date)]));
  const seed = Number(opts.seed) || 0;

  const { days, skipped } = planDates({
    dates, tasks, daysMap, standard, today, seed, account: config.zentao.username,
    history: historyDates, maxDaysPerTask: deps.maxDaysPerTask
  });

  const ai = deps.ai !== undefined ? deps.ai : (aiAvailable() ? (await import('../ai/openai.js')).generateResponse : null);
  let aiUsed = false;
  const queue = [...days];
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
    while (queue.length) {
      const day = queue.shift();
      const rng = mulberry32(seedFrom(`work|${day.date}|${seed}`));
      const works = await writeWorks({ date: day.date, entries: day.entries, history, CH, ai, rng });
      day.entries.forEach((e, i) => { e.work = works[i].work; e.source = works[i].source; if (e.source === 'ai') aiUsed = true; });
    }
  }));

  gcPlans();
  // 带 planId 来：把这几天并进已有的方案（月补里单独「换一批」某一天，不会让其它天的方案失效）
  const merging = opts.planId && plans.get(opts.planId);
  const planId = merging ? opts.planId : randomBytes(8).toString('hex');
  const plan = merging || { createdAt: Date.now(), poolIds: {}, existing: {}, standard };
  for (const d of days) { plan.poolIds[d.date] = new Set(d.pool.map(t => t.id)); plan.existing[d.date] = d.existing; }
  plan.createdAt = Date.now();
  plans.set(planId, plan);
  return { planId, standard, days, skipped, aiUsed, aiAvailable: !!ai };
}

/** 重写某天的内容（任务 / 小时是用户改过的，内容跟着重写） */
async function rewriteWorks({ planId, date, entries, seed } = {}, deps = {}) {
  assertReady();
  const plan = plans.get(planId);
  if (!plan || !plan.poolIds[date]) throw new Error('方案已过期，请重新点「补」');
  const list = (Array.isArray(entries) ? entries : []).filter(e => plan.poolIds[date].has(String(e.taskId)));
  if (!list.length) return [];
  const CH = cookiesToString(await getZentaoCookies());
  const tasks = await fetchPoolTasks(CH);
  const byId = new Map(tasks.map(t => [t.id, t]));
  const history = deps.history || myEffortsByTask();
  const ai = deps.ai !== undefined ? deps.ai : (aiAvailable() ? (await import('../ai/openai.js')).generateResponse : null);
  const es = list.map(e => ({ taskId: String(e.taskId), taskName: (byId.get(String(e.taskId)) || {}).name || '', execName: (byId.get(String(e.taskId)) || {}).execName || '', hours: Number(e.hours) || 0 }));
  return writeWorks({ date, entries: es, history, CH, ai, rng: mulberry32(seedFrom(`rewrite|${date}|${seed || Date.now()}`)) });
}

/* ───────────────────────── 补填记录 / 写入 / 撤销 ───────────────────────── */

const logFile = () => join(config.paths.data, 'autofill-log.json');
const MAX_BATCHES = 50;
async function readLog() {
  const j = await readJSON(logFile());
  return j && Array.isArray(j.batches) ? j : { batches: [] };
}
let logLock = Promise.resolve();
function updateLog(mutator) {
  const run = async () => {
    const log = await readLog();
    mutator(log);
    log.batches = log.batches.slice(-MAX_BATCHES);
    await writeJSON(logFile(), log);
  };
  const p = logLock.then(run, run);
  logLock = p.catch(() => { });
  return p;
}
async function getLog() {
  const log = await readLog();
  return { batches: [...log.batches].reverse().map(b => ({ ...b, hours: round1((b.entries || []).filter(e => e.status === 'written').reduce((s, e) => s + e.hours, 0)) })) };
}

const jobs = new Map();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 校验用户确认的方案：来自本机生成的方案、任务在当天候选池里、小时 / 内容合法、没超过上限 */
function validateExecution(plan, days) {
  if (!Array.isArray(days) || !days.length) throw new Error('没有要写入的内容');
  if (days.length > DEFAULTS.maxDays) throw new Error(`一次最多补 ${DEFAULTS.maxDays} 天`);
  let total = 0;
  const out = [];
  for (const d of days) {
    const date = String(d.date || '');
    if (!plan.poolIds[date]) throw new Error(`${date} 不在这次的方案里`);
    const seen = new Set();
    const entries = [];
    for (const e of Array.isArray(d.entries) ? d.entries : []) {
      const taskId = String(e.taskId || '');
      if (!plan.poolIds[date].has(taskId)) throw new Error(`任务 #${taskId} 不在 ${date} 的候选任务里`);
      if (seen.has(taskId)) throw new Error(`${date} 里同一个任务出现了两次`);
      seen.add(taskId);
      const hours = Number(e.hours);
      if (!(hours >= 0.5) || hours > 24 || Math.round(hours * 2) !== hours * 2) throw new Error(`${date} 的小时数应是 0.5 的倍数，范围 0.5~24`);
      const work = String(e.work || '').trim();
      if (!work) throw new Error(`${date} 有一条没写工作内容`);
      if (work.length > 500) throw new Error(`${date} 有一条工作内容太长`);
      entries.push({ taskId, hours, work });
      total++;
    }
    if (entries.length) out.push({ date, entries });
  }
  if (!total) throw new Error('没有要写入的内容');
  if (total > DEFAULTS.maxEntries) throw new Error(`一次最多写 ${DEFAULTS.maxEntries} 条，请分批`);
  return out;
}

/**
 * 开始后台写入。返回 {jobId, batchId}；进度用 getJob 查。
 * @param {{planId:string, days:Array<{date, entries:[{taskId,hours,work}]}>}} body
 * @param {{writeGapMs?:number}} deps
 */
async function startExecution(body = {}, deps = {}) {
  assertReady();
  gcPlans();
  const plan = plans.get(body.planId);
  if (!plan) throw new Error('方案已过期，请重新点「补」');
  const days = validateExecution(plan, body.days);
  const batchId = `b${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  const job = {
    id: batchId, batchId, state: 'running', startedAt: Date.now(), stop: false,
    total: days.reduce((n, d) => n + d.entries.length, 0), done: 0, written: 0, hours: 0,
    results: [], message: ''
  };
  jobs.set(batchId, job);
  await updateLog((log) => log.batches.push({ id: batchId, createdAt: new Date().toISOString(), state: 'running', entries: [] }));
  runJob(job, plan, days, deps).catch((err) => { job.state = 'error'; job.message = err.message; });
  return { jobId: batchId, batchId, total: job.total };
}

async function runJob(job, plan, days, deps) {
  const gap = deps.writeGapMs !== undefined ? deps.writeGapMs : DEFAULTS.writeGapMs;
  const std = plan.standard || standardHours();
  const CH = cookiesToString(await getZentaoCookies());
  const tasksNow = new Map((await fetchPoolTasks(CH)).map(t => [t.id, t]));
  const monthLatest = {};
  const known = new Map();   // taskId → 已知的工时记录 id（用来找出刚写入的那条）
  const knownFor = async (taskId) => {
    if (!known.has(taskId)) known.set(taskId, new Set((await getTaskEfforts(taskId, CH)).map(e => e.id)));
    return known.get(taskId);
  };
  let aborted = false;
  const addResult = (r) => { job.results.push(r); job.done++; };

  for (const d of days) {
    if (job.stop) break;
    const m = d.date.slice(0, 7);
    if (!monthLatest[m]) monthLatest[m] = (await getMonthEfforts(m)).days || {};   // 每个月开始前以禅道当前为准
    const latest = (monthLatest[m][d.date] || { hours: 0 }).hours;
    const planned = plan.existing[d.date] || 0;
    // 这天自从生成方案之后又被别处补过：按最新的算剩余容量，容量不够就跳过，防止重复补
    let capacity = latest > planned + 1e-9 ? Math.max(0, Math.ceil((std - latest) * 2 - 1e-9) / 2) : Infinity;   // 向上取到 0.5，保证补完不少于标准工时
    for (const e of d.entries) {
      if (job.stop) break;
      const base = { date: d.date, taskId: e.taskId, hours: e.hours, work: e.work };
      const t = tasksNow.get(e.taskId);
      if (latest >= std && latest > planned + 1e-9) { addResult({ ...base, status: 'skipped', error: '这天的工时已被补满，跳过' }); continue; }
      if (e.hours > capacity + 1e-9) { addResult({ ...base, status: 'skipped', error: '这天已有新增工时，剩余容量不够，跳过' }); continue; }
      if (!t || !poolFor(d.date, [t]).length) { addResult({ ...base, status: 'skipped', error: '任务的状态变了，这天已经不适合补在它上面，跳过' }); continue; }
      try {
        const ids = await knownFor(e.taskId);
        // 进行中的任务：剩余沿用当前值（不改剩余、不触发「完成」）；已完成的任务：传 0 并确认完成（它本来就完成了，
        // 已验证禅道会忽略剩余、任务状态和完成日期都不变）
        const isDone = t.status === 'done';
        const r = await addEffort({ taskId: e.taskId, date: d.date, consumed: e.hours, left: isDone ? 0 : t.left, work: e.work, finish: isDone });
        if (!r || !r.success) throw new Error((r && r.message) || '禅道没有接受');
        const list = await getTaskEfforts(e.taskId, CH);
        const rec = list.find(x => !ids.has(x.id) && x.date === d.date && x.work === e.work);
        list.forEach(x => ids.add(x.id));
        if (capacity !== Infinity) capacity = round05(capacity - e.hours);
        job.written++; job.hours = round1(job.hours + e.hours);
        const entry = { ...base, taskName: t.name, status: 'written', effortId: rec ? rec.id : '' };
        addResult(entry);
        await updateLog((log) => { const b = log.batches.find(x => x.id === job.batchId); if (b) b.entries.push(entry); });
      } catch (err) {
        addResult({ ...base, taskName: t.name, status: 'failed', error: err.message });
        if (/登录|会话|超时/.test(err.message)) { aborted = true; job.message = '禅道登录失效，已停止；已写入的保留，可撤销'; break; }
      }
      if (gap) await sleep(gap);
    }
    if (aborted) break;
  }
  // 先把补填记录写好，再对外宣布完成：别人（界面、撤销）一看到 done，记录里的状态就已经是最终的
  const finalState = aborted ? 'aborted' : job.stop ? 'stopped' : 'done';
  await updateLog((log) => { const b = log.batches.find(x => x.id === job.batchId); if (b) { b.state = finalState; b.finishedAt = new Date().toISOString(); } });
  job.finishedAt = Date.now();
  job.state = finalState;
  // 补过工时的任务（哪怕已完成）顺手同步进任务页，按日期看才找得到；失败不影响补填结果
  if (job.written > 0 && deps.syncTasks !== false) {
    import('./zentaoService.js').then((z) => z.syncMyTasks()).catch((err) => console.warn('[Autofill] 补填后同步任务失败（忽略）:', err.message));
  }
}

function getJob(id) {
  const j = jobs.get(id);
  if (!j) return null;
  return { id: j.id, batchId: j.batchId, state: j.state, total: j.total, done: j.done, written: j.written, hours: j.hours, message: j.message, results: j.results };
}

function stopJob(id) {
  const j = jobs.get(id);
  if (!j) return false;
  j.stop = true;
  return true;
}

/**
 * 撤销一批补填：逐条删除这批写入的工时。
 * 只删仍然存在、且日期 / 小时 / 内容和写入时一致的；被改过或已经不在的跳过并说明。
 */
async function undoBatch(batchId) {
  assertReady();
  const log = await readLog();
  const batch = log.batches.find(b => b.id === batchId);
  if (!batch) throw new Error('找不到这批补填记录');
  if (jobs.get(batchId) && jobs.get(batchId).state === 'running') throw new Error('这批还在写入，先停止再撤销');
  const CH = cookiesToString(await getZentaoCookies());
  const out = { undone: 0, kept: [], failed: [] };
  for (const e of batch.entries.filter(x => x.status === 'written')) {
    try {
      if (!e.effortId) { out.kept.push({ ...e, reason: '没有记下这条工时的编号，请到禅道里手工删除' }); continue; }
      const cur = (await getTaskEfforts(e.taskId, CH)).find(x => x.id === e.effortId);
      if (!cur) { out.kept.push({ ...e, reason: '这条工时已经不存在了' }); continue; }
      if (cur.date !== e.date || Math.abs(cur.consumed - e.hours) > 1e-9 || cur.work !== e.work) { out.kept.push({ ...e, reason: '这条工时后来被改过，没有删' }); continue; }
      await deleteEffort({ taskId: e.taskId, effortId: e.effortId });
      out.undone++;
      await updateLog((l) => { const b = l.batches.find(x => x.id === batchId); const t = b && b.entries.find(x => x.effortId === e.effortId); if (t) t.status = 'undone'; });
    } catch (err) {
      out.failed.push({ ...e, reason: err.message });
    }
  }
  await updateLog((l) => { const b = l.batches.find(x => x.id === batchId); if (b) { b.undoneAt = new Date().toISOString(); } });
  return out;
}

export {
  buildPlan, rewriteWorks, startExecution, getJob, stopJob, undoBatch, getLog,
  poolFor, planDay, planDates, allocateHours, chooseCount, chunkCap, pickOvertime, seedFrom, mulberry32, slimPoolTask,
  parseWorks, templateWork, styleSamples, usableWork, redact, validateExecution, pastWorkdaysOfMonth, DEFAULTS
};
