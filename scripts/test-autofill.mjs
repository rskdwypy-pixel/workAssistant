/**
 * 真函数测试：工时自动补填（后端，设计见 docs/AUTOFILL-PRD.md）
 *   纯函数：候选池硬条件、小时分配（总和 = 缺口、0.5 步长、上下限）、选任务（数量、唯一、权重、月内频次）、
 *           逐日方案（跳过今天 / 周末 / 已满 / 无候选）、可复现的随机、AI 输出解析与降级模板
 *   模拟禅道的完整流程：方案 → 用户编辑 → 后台写入（剩余沿用任务当前值）→ 补填记录 → 撤销；
 *           写入前重读当天工时防重复；方案校验（任务不在候选池 / 小时非法 / 重复任务 / 过期方案）
 */
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });

// ---------- 模拟禅道 ----------
const zt = { realFetch: globalThis.fetch, adds: [], deletes: [], efforts: {}, nextId: 5000, failTask: '' };
const T = (o) => ({ status: 'doing', assignedTo: 'lijc', openedBy: 'lijc', openedDate: '2025-01-01 10:00:00', estStarted: '0000-00-00', realStarted: '0000-00-00 00:00:00', deadline: '0000-00-00', estimate: '0', consumed: '0', left: '0', executionName: '迭代A', deleted: '0', lastEditedDate: '2025-03-19 10:00:00', ...o });
const TASKS = [
  T({ id: '10', name: '接口联调', left: '6', estimate: '20', desc: '<p>和后端联调订单接口</p>' }),
  T({ id: '11', name: '写文档', left: '4', openedDate: '2025-03-05 09:00:00', desc: '补接口文档' }),
  T({ id: '12', name: '未开始的任务', status: 'wait', left: '8' }),
  T({ id: '13', name: '已完成的任务', status: 'done', left: '0' }),
  T({ id: '14', name: '剩余为 0 的任务', left: '0' }),
  T({ id: '15', name: '实际开始较晚的任务', left: '5', realStarted: '2025-03-12 09:00:00' })
];
const reset = () => {
  zt.adds = []; zt.deletes = []; zt.nextId = 5000; zt.failTask = '';
  zt.efforts = {
    10: [{ id: '4001', account: 'lijc', date: '2025-03-17', consumed: '2', left: '6', work: '设计接口', deleted: '0' }, { id: '4002', account: 'lijc', date: '2025-03-18', consumed: '8', left: '6', work: '联调订单接口', deleted: '0' }, { id: '4003', account: 'lijc', date: '2025-03-14', consumed: '1', left: '6', work: '更新进度至 30%', deleted: '0' }],
    11: [], 15: []
  };
};
const json = (o) => new Response(JSON.stringify({ status: 'success', data: JSON.stringify(o) }), { headers: { 'Content-Type': 'application/json' } });
const consumedOf = (id) => (zt.efforts[id] || []).filter(e => e.deleted !== '1').reduce((n, e) => n + Number(e.consumed), 0);
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (!url.startsWith('http://z.test')) return zt.realFetch(input, init);
  const method = (init.method || 'GET').toUpperCase();
  if (url.includes('user-refreshRandom')) return new Response('1234');
  if (url.includes('user-login') && method === 'GET') return new Response('<html></html>', { headers: { 'Set-Cookie': 'zentaosid=sid1; path=/' } });
  if (url.includes('user-login')) return new Response(JSON.stringify({ result: 'success' }), { headers: { 'Content-Type': 'application/json' } });
  let m;
  if ((m = url.match(/my-task-(\w+)-0-/))) {
    const list = m[1] === 'assignedTo' ? TASKS.map(t => ({ ...t, consumed: String(consumedOf(t.id)), lastEditedDate: zt.efforts[t.id] && zt.efforts[t.id].length ? `2025-03-19 10:00:${String(consumedOf(t.id) % 60).padStart(2, '0')}` : t.lastEditedDate })) : [];
    return json({ tasks: Object.fromEntries(list.map(t => [t.id, t])), pager: { pageTotal: 1 } });
  }
  if ((m = url.match(/task-view-(\d+)\.json/))) return json({ task: TASKS.find(t => t.id === m[1]) || {} });
  if ((m = url.match(/task-recordEstimate-(\d+)\.json/))) return json({ efforts: zt.efforts[m[1]] || [] });
  if ((m = url.match(/task-recordEstimate-(\d+)\.html/)) && method === 'POST') {
    const b = new URLSearchParams(init.body);
    if (zt.failTask === m[1]) return new Response("<script>alert('任务状态不允许记录工时');</script>");
    zt.adds.push({ task: m[1], date: b.get('dates[1]'), consumed: b.get('consumed[1]'), left: b.get('left[1]'), work: b.get('work[1]') });
    (zt.efforts[m[1]] = zt.efforts[m[1]] || []).push({ id: String(zt.nextId++), account: 'lijc', date: b.get('dates[1]'), consumed: b.get('consumed[1]'), left: b.get('left[1]'), work: b.get('work[1]'), deleted: '0' });
    return new Response("<script>if(typeof(parent.parent.ajaxRefresh) == 'function') parent.parent.ajaxRefresh()</script>");
  }
  if ((m = url.match(/task-deleteEstimate-(\d+)-yes\.html/))) {
    zt.deletes.push(m[1]);
    for (const list of Object.values(zt.efforts)) { const e = list.find(x => x.id === m[1]); if (e) e.deleted = '1'; }
    return new Response('<html><script>if(parent !== window) parent.location.reload(true);</script>');
  }
  return new Response('not found', { status: 404 });
};

// ---------- 临时数据 ----------
const tmp = mkdtempSync(join(tmpdir(), 'wa-autofill-'));
process.env.WA_DATA_DIR = tmp;
process.env.WA_ENV_FILE = join(tmp, '.env');
writeFileSync(process.env.WA_ENV_FILE, '');
const { config } = await import('../src/config.js');
Object.assign(config.zentao, { enabled: true, url: 'http://z.test', username: 'lijc', password: 'p' });
config.schedule.workHours = 8;
const af = await import('../src/services/autofillService.js');
const es = await import('../src/services/effortService.js');

const NOW = new Date(2025, 2, 20, 10, 0);   // 2025-03-20 周四，今天
const rejects = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(e.message); } };

try {
  // ============ 候选池 ============
  const slim = TASKS.map(af.slimPoolTask);
  const pool0303 = af.poolFor('2025-03-03', slim).map(t => t.id);
  check('候选池：只有「进行中 + 剩余 > 0 + 那天已存在」的任务', pool0303.join() === '10', pool0303.join());
  check('候选池：不含未开始 / 已完成 / 剩余为 0 的任务', !['12', '13', '14'].some(id => af.poolFor('2025-03-18', slim).some(t => t.id === id)));
  check('候选池：任务创建在当天之后不进池（11 号任务 3/5 才创建）', !af.poolFor('2025-03-04', slim).some(t => t.id === '11') && af.poolFor('2025-03-05', slim).some(t => t.id === '11'));
  check('候选池：实际开始在当天之后不进池（15 号任务 3/12 才开始）', !af.poolFor('2025-03-11', slim).some(t => t.id === '15') && af.poolFor('2025-03-12', slim).some(t => t.id === '15'));

  // ============ 小时分配 ============
  let ok = true, why = '';
  for (let seed = 1; seed <= 400 && ok; seed++) {
    const rng = af.mulberry32(seed);
    for (const gap of [0.5, 1, 1.5, 2, 3.5, 5, 6, 7.5, 8]) {
      const n = af.chooseCount(gap, 5, rng);
      const hs = af.allocateHours(gap, n, rng);
      const sum = hs.reduce((a, b) => a + b, 0);
      if (Math.abs(sum - gap) > 1e-9) { ok = false; why = `gap ${gap} n ${n} → ${hs} 总和 ${sum}`; break; }
      if (hs.some(h => h * 2 !== Math.round(h * 2))) { ok = false; why = `非 0.5 倍数 ${hs}`; break; }
      if (gap >= 2 && hs.some(h => h < 1)) { ok = false; why = `gap ${gap} 有小于 1h 的条 ${hs}`; break; }
      if (hs.some(h => h > 4) && gap <= 4 * n) { ok = false; why = `超过 4h 上限 ${hs}`; break; }
    }
  }
  check('分配：总和恰好等于缺口，0.5 步长，缺口 ≥ 2h 时每条 ≥ 1h，不超 4h（400 个种子 × 9 种缺口）', ok, why);
  const ns = new Set(); for (let s = 1; s <= 200; s++) { ns.add(af.chooseCount(7, 5, af.mulberry32(s))); }
  check('数量：缺口大时抽 2~3 个；缺口 ≤ 2h 只抽 1 个', [...ns].every(n => n === 2 || n === 3) && af.chooseCount(2, 5, af.mulberry32(1)) === 1);
  check('数量：候选只有 1 个时只抽 1 个', af.chooseCount(8, 1, af.mulberry32(1)) === 1);

  // ============ 按剩余工时封顶 ============
  check('封顶：剩 0.9h 的任务一条最多 1.5h；剩 10h 的最多 4h；剩 0.2h 也至少 1h', af.chunkCap({ left: 0.9 }) === 1.5 && af.chunkCap({ left: 10 }) === 4 && af.chunkCap({ left: 0.2 }) === 1);
  let capOk = true, capWhy = '';
  for (let s = 1; s <= 300 && capOk; s++) {
    const small = { id: '1', name: '快做完的任务', execName: '', left: 0.9, estimate: 0, consumed: 0, deadline: '', lastEdited: '' };
    const big = { id: '2', name: '大任务', execName: '', left: 12, estimate: 0, consumed: 0, deadline: '', lastEdited: '' };
    const e = af.planDay({ date: '2025-03-14', gap: 7, pool: [small, big], history: new Map(), rng: af.mulberry32(s) });
    const sm = e.find(x => x.taskId === '1');
    if (sm && sm.hours > 1.5) { capOk = false; capWhy = `seed ${s} 小任务被分到 ${sm.hours}h`; }
    if (Math.abs(e.reduce((n, x) => n + x.hours, 0) - 7) > 1e-9) { capOk = false; capWhy = `seed ${s} 总和 ${e.map(x => x.hours)}`; }
  }
  check('封顶：剩余很小的任务不会被分到超过 1.5h，且总和仍等于缺口（300 个种子）', capOk, capWhy);
  const onlySmall = af.planDay({ date: '2025-03-14', gap: 7, pool: [{ id: '1', name: '唯一的小任务', execName: '', left: 0.9, estimate: 0, consumed: 0, deadline: '', lastEdited: '' }], history: new Map(), rng: af.mulberry32(1) });
  check('封顶：候选只有一个小任务时放宽封顶，仍然补满缺口（不留空）', onlySmall.length === 1 && onlySmall[0].hours === 4 || onlySmall.reduce((n, x) => n + x.hours, 0) === 7, JSON.stringify(onlySmall));

  // ============ 调试页参数 ============
  const poolLim = [10, 11, 15].map(i => slim.find(t => t.id === String(i)));
  config.autofill.maxTasksPerDay = 1;
  let manyTasks = 0; for (let s = 1; s <= 100; s++) if (af.planDay({ date: '2025-03-14', gap: 8, pool: poolLim, history: new Map(), rng: af.mulberry32(s) }).length > 1) manyTasks++;
  check('参数：每天最多任务数设成 1 → 每天只抽 1 个任务', manyTasks === 0, `${manyTasks}`);
  config.autofill.maxTasksPerDay = 3; config.autofill.minChunk = 2; config.autofill.maxChunk = 3;
  let chunkOk = true; for (let s = 1; s <= 200; s++) { const e = af.planDay({ date: '2025-03-14', gap: 8, pool: poolLim, history: new Map(), rng: af.mulberry32(s) }); if (e.some(x => x.hours < 2) || Math.abs(e.reduce((n, x) => n + x.hours, 0) - 8) > 1e-9) chunkOk = false; }
  check('参数：单条下限 2h → 每条不少于 2h，总和仍等于缺口', chunkOk);
  config.autofill.minChunk = 1; config.autofill.maxChunk = 4; config.autofill.maxDaysPerTask = 2;
  check('参数：同一任务单月最多 2 天 → 被抽过 2 天的不再入选', Array.from({ length: 60 }, (_, i) => af.planDay({ date: '2025-03-14', gap: 6, pool: poolLim, history: new Map(), monthUse: new Map([['10', 2]]), rng: af.mulberry32(i + 1) })).every(e => !e.some(x => x.taskId === '10')));
  config.autofill.maxDaysPerTask = 8;
  reset();   // 模拟禅道回到初始数据（下面要真的生成方案，会读工时）
  config.autofill.prompt = '每条不超过 40 字，多用「配合」';
  const promptsSeen = [];
  await af.buildPlan({ dates: ['2025-03-17'], seed: 1 }, { ai: async (p) => { promptsSeen.push(p); return '[]'; }, now: NOW });
  check('参数：额外要求会附在 AI 提示词里，并声明不得违反上面的约束', promptsSeen.length === 1 && /用户的额外要求/.test(promptsSeen[0]) && /每条不超过 40 字，多用「配合」/.test(promptsSeen[0]) && /不得违反上面的约束/.test(promptsSeen[0]));
  config.autofill.prompt = '';
  const promptsNone = [];
  await af.buildPlan({ dates: ['2025-03-17'], seed: 1 }, { ai: async (p) => { promptsNone.push(p); return '[]'; }, now: NOW });
  check('参数：没填额外要求时提示词里没有这一段', !/用户的额外要求/.test(promptsNone[0]));

  // ============ 选任务 ============
  const poolT = [10, 11, 15].map(i => slim.find(t => t.id === String(i)));
  const one = (seed, extra = {}) => af.planDay({ date: '2025-03-14', gap: 6, pool: poolT, history: new Map(), rng: af.mulberry32(seed), ...extra });
  let uniq = true, inPool = true;
  for (let s = 1; s <= 200; s++) { const e = one(s); if (new Set(e.map(x => x.taskId)).size !== e.length) uniq = false; if (!e.every(x => poolT.some(t => t.id === x.taskId))) inPool = false; }
  check('选任务：同一天同一个任务只出现一次，且都在候选池里', uniq && inPool);
  check('选任务：相同种子给出相同方案（可复现），不同种子能给出不同方案', JSON.stringify(one(7)) === JSON.stringify(one(7)) && new Set(Array.from({ length: 30 }, (_, i) => JSON.stringify(one(i + 1)))).size > 3);
  const hist = new Map([['11', ['2025-03-13', '2025-03-14']]]);
  let near = 0, plain = 0;
  for (let s = 1; s <= 600; s++) {
    if (one(s, { history: hist }).some(e => e.taskId === '11')) near++;
    if (one(s, { history: new Map() }).some(e => e.taskId === '11')) plain++;
  }
  check('权重：前后几天在这个任务上有工时的，被抽到的概率更高', near > plain, `${near} vs ${plain}`);
  const used = new Map([['10', 8]]);
  check('月内频次：一个月里被抽满 8 天的任务不再入选', Array.from({ length: 100 }, (_, i) => one(i + 1, { monthUse: used })).every(es2 => !es2.some(e => e.taskId === '10')));
  check('候选全部用满时返回空', af.planDay({ date: '2025-03-14', gap: 6, pool: [poolT[0]], history: new Map(), monthUse: new Map([['10', 8]]), rng: af.mulberry32(1) }).length === 0);

  // ============ 逐日方案 ============
  const daysMap = { '2025-03-17': { hours: 2, items: [{ execName: '迭代A' }] }, '2025-03-18': { hours: 8, items: [] }, '2025-03-14': { hours: 7.8, items: [] } };
  const ctx = { dates: ['2025-03-14', '2025-03-15', '2025-03-17', '2025-03-18', '2025-03-19', '2025-03-20', '2025-03-24', '2025-03-03', '20250301'], tasks: slim, daysMap, standard: 8, today: '2025-03-20', seed: 1, account: 'lijc', history: new Map() };
  const p = af.planDates(ctx);
  const why2 = Object.fromEntries(p.skipped.map(s => [s.date, s.reason]));
  check('跳过：周末 / 今天 / 将来 / 已满 / 日期格式不对，都说明原因', /周末/.test(why2['2025-03-15']) && /今天/.test(why2['2025-03-20']) && /将来/.test(why2['2025-03-24']) && /满了/.test(why2['2025-03-18']) && /格式/.test(why2['20250301']), JSON.stringify(why2));
  check('缺口不足 0.5h（已填 7.8h）视为已满，不补', /满了/.test(why2['2025-03-14']));
  const d17 = p.days.find(d => d.date === '2025-03-17');
  check('逐日：补的小时 = 缺口（17 日已填 2h → 补 6h），候选来自当天池', d17 && d17.gap === 6 && d17.entries.reduce((n, e) => n + e.hours, 0) === 6 && d17.entries.every(e => d17.pool.some(t => t.id === e.taskId)));
  check('逐日：已有工时的执行（迭代A）出现在权重里不报错，方案有 1~3 条', d17.entries.length >= 1 && d17.entries.length <= 3);
  const none = af.planDates({ ...ctx, dates: ['2025-03-19'], tasks: slim.filter(t => t.id !== '10' && t.id !== '11' && t.id !== '15') });
  check('当天没有候选任务：跳过并说明，不硬凑', none.days.length === 0 && /没有当天已存在的进行中任务/.test(none.skipped[0].reason));

  // ============ AI 输出解析 / 降级 ============
  check('解析：合法数组按 i 对位', JSON.stringify(af.parseWorks('说明[{"i":1,"work":"整理接口文档并补充示例"},{"i":0,"work":"和后端联调订单接口"}]', 2)) === JSON.stringify(['和后端联调订单接口', '整理接口文档并补充示例']));
  const bad = af.parseWorks('[{"i":0,"work":"接口联调已完成并上线"},{"i":1,"work":"修复了 #1234 号缺陷"},{"i":2,"work":"进度推进到 80%"},{"i":3,"work":"太短"},{"i":4,"work":"正常的工作内容描述"}]', 5);
  check('解析：含「已完成 / 已上线」「#编号」「百分比」、过短的内容被丢弃（退回模板）', bad.slice(0, 4).every(w => w === null) && bad[4] === '正常的工作内容描述');
  check('解析：不是 JSON 返回 null', af.parseWorks('抱歉我不能', 2) === null && af.parseWorks('[坏的', 2) === null);
  const hmap = new Map([['10', [{ date: '2025-03-17', work: '设计接口' }, { date: '2025-03-14', work: '更新进度至 30%' }]]]);
  check('模板：用该任务自己以前的内容，自动生成的「更新进度至…」不用', af.templateWork({ taskId: '10', taskName: '接口联调' }, hmap, af.mulberry32(1)) === '设计接口');
  check('模板：没有历史就用任务名', af.templateWork({ taskId: '99', taskName: '新任务' }, new Map(), af.mulberry32(1)) === '推进「新任务」相关工作');
  check('学口吻：样本去掉自动生成的、按日期取最近', JSON.stringify(af.styleSamples(hmap)) === JSON.stringify(['设计接口']));

  // ============ 完整流程（模拟禅道） ============
  reset();
  const aiCalls = [];
  const fakeAi = async (prompt) => {
    aiCalls.push(prompt);
    const n = Number((prompt.match(/需要写 (\d+) 条/) || [])[1]);
    return '```json\n' + JSON.stringify(Array.from({ length: n }, (_, i) => ({ i, work: `第${i + 1}项：推进相关开发与联调 ${aiCalls.length}-${i}` }))) + '\n```';
  };
  const plan = await af.buildPlan({ month: '2025-03', seed: 3 }, { ai: fakeAi, now: NOW });
  const planDates = plan.days.map(d => d.date);
  check('方案：本月过去的工作日里缺工时的天（不含 18 日已满、不含今天及以后）', !planDates.includes('2025-03-18') && !planDates.includes('2025-03-20') && planDates.includes('2025-03-17') && planDates.includes('2025-03-03') && planDates.every(d => d < '2025-03-20' && ![0, 6].includes(new Date(`${d}T00:00:00`).getDay())), planDates.join());
  check('方案：每天补的小时 = 缺口；任务都在当天候选池里；不含未开始 / 已完成 / 剩余 0', plan.days.every(d => d.entries.reduce((n, e) => n + e.hours, 0) === d.gap && d.entries.every(e => d.pool.some(t => t.id === e.taskId) && !['12', '13', '14'].includes(e.taskId))));
  check('方案：3/3、3/4 只有接口联调可选（写文档 3/5 才创建）', plan.days.filter(d => ['2025-03-03', '2025-03-04'].includes(d.date)).every(d => d.entries.every(e => e.taskId === '10')));
  check('方案：内容来自 AI，带 source=ai，并按天各调一次（共 ' + aiCalls.length + ' 次）', plan.aiUsed && plan.days.every(d => d.entries.every(e => e.source === 'ai' && e.work.length > 4)) && aiCalls.length === plan.days.length);
  check('方案：提示词里带了任务名、任务描述和用户自己以前的写法，并有不得编造的约束', aiCalls.some(p => /接口联调/.test(p) && /订单接口/.test(p) && /设计接口/.test(p)) && aiCalls.every(p => /不要编造/.test(p) && /不要写“已完成/.test(p)));
  check('方案：生成方案阶段没有任何写入', zt.adds.length === 0 && zt.deletes.length === 0);
  const again = await af.buildPlan({ month: '2025-03', seed: 3 }, { ai: fakeAi, now: NOW });
  check('同样的种子：任务和小时可复现', JSON.stringify(again.days.map(d => d.entries.map(e => [e.taskId, e.hours]))) === JSON.stringify(plan.days.map(d => d.entries.map(e => [e.taskId, e.hours]))));
  const reroll = await af.buildPlan({ month: '2025-03', seed: 4 }, { ai: fakeAi, now: NOW });
  check('换种子（换一批）：方案会变', JSON.stringify(reroll.days.map(d => d.entries.map(e => [e.taskId, e.hours]))) !== JSON.stringify(plan.days.map(d => d.entries.map(e => [e.taskId, e.hours]))));

  const noAi = await af.buildPlan({ dates: ['2025-03-17'], seed: 1 }, { ai: null, now: NOW });
  check('没配 AI：仍生成方案，内容用模板并标注 source=template', !noAi.aiUsed && noAi.days[0].entries.every(e => e.source === 'template' && e.work));
  const aiFail = await af.buildPlan({ dates: ['2025-03-17'], seed: 1 }, { ai: async () => { throw new Error('AI 出错'); }, now: NOW });
  check('AI 出错：该天退回模板，不影响方案', aiFail.days[0].entries.every(e => e.source === 'template'));
  const aiDup = await af.buildPlan({ dates: ['2025-03-12'], seed: 2 }, { ai: async () => '[{"i":0,"work":"完全一样的内容描述"},{"i":1,"work":"完全一样的内容描述"},{"i":2,"work":"完全一样的内容描述"}]', now: NOW });
  check('AI 给出雷同内容：重复的退回模板', new Set(aiDup.days[0].entries.map(e => e.work)).size === aiDup.days[0].entries.length);

  const merged = await af.buildPlan({ dates: ['2025-03-12'], seed: 9, planId: plan.planId }, { ai: fakeAi, now: NOW });
  check('换一批：带 planId 重抽某一天会并进同一个方案，其它天（3/4）仍然有效', merged.planId === plan.planId && merged.days.length === 1 && await rejects(() => af.startExecution({ planId: plan.planId, days: [{ date: '2025-03-04', entries: [{ taskId: '10', hours: 1, work: ' ' }] }] }), /没写工作内容/));

  // ---- 校验 ----
  const day17 = plan.days.find(d => d.date === '2025-03-17');
  const good = { date: '2025-03-17', entries: day17.entries.map(e => ({ taskId: e.taskId, hours: e.hours, work: e.work })) };
  check('执行校验：方案过期 / 不存在被拒', await rejects(() => af.startExecution({ planId: 'nope', days: [good] }), /方案已过期/));
  check('执行校验：任务不在当天候选池被拒（未开始的 12 号）', await rejects(() => af.startExecution({ planId: plan.planId, days: [{ date: '2025-03-17', entries: [{ taskId: '12', hours: 2, work: 'x 内容内容' }] }] }), /不在 2025-03-17 的候选任务里/));
  check('执行校验：日期不在方案里被拒（18 日是满的）', await rejects(() => af.startExecution({ planId: plan.planId, days: [{ date: '2025-03-18', entries: [{ taskId: '10', hours: 1, work: 'x 内容内容' }] }] }), /不在这次的方案里/));
  check('执行校验：小时不是 0.5 倍数 / 超范围被拒', await rejects(() => af.startExecution({ planId: plan.planId, days: [{ date: '2025-03-17', entries: [{ taskId: '10', hours: 1.3, work: 'x 内容内容' }] }] }), /0\.5 的倍数/) && await rejects(() => af.startExecution({ planId: plan.planId, days: [{ date: '2025-03-17', entries: [{ taskId: '10', hours: 25, work: 'x 内容内容' }] }] }), /0\.5/));
  check('执行校验：内容为空 / 同一任务出现两次被拒', await rejects(() => af.startExecution({ planId: plan.planId, days: [{ date: '2025-03-17', entries: [{ taskId: '10', hours: 1, work: ' ' }] }] }), /没写工作内容/) && await rejects(() => af.startExecution({ planId: plan.planId, days: [{ date: '2025-03-17', entries: [{ taskId: '10', hours: 1, work: '内容内容内容' }, { taskId: '10', hours: 1, work: '内容内容内容二' }] }] }), /出现了两次/));
  check('执行校验：没有任何写入发生', zt.adds.length === 0);

  // ---- 写入（用户编辑过：把 17 日的第一条内容改掉）----
  good.entries[0].work = '我手工改过的内容：核对订单接口返回值';
  const started = await af.startExecution({ planId: plan.planId, days: [good] }, { writeGapMs: 0 });
  for (let i = 0; i < 100 && af.getJob(started.jobId).state === 'running'; i++) await new Promise(r => setTimeout(r, 30));
  const job = af.getJob(started.jobId);
  check('写入：后台跑完，每条都成功', job.state === 'done' && job.written === good.entries.length && job.results.every(r => r.status === 'written'), JSON.stringify(job));
  check('写入：日期 = 那天，小时 / 内容用的是用户编辑后的', zt.adds.length === good.entries.length && zt.adds.every(a => a.date === '2025-03-17') && zt.adds[0].work === '我手工改过的内容：核对订单接口返回值' && zt.adds.reduce((n, a) => n + Number(a.consumed), 0) === 6);
  const leftOf = (id) => TASKS.find(t => t.id === id).left;
  check('写入：剩余一律沿用任务当前值（不改任务剩余、不触发完成，绝不传 0）', zt.adds.every(a => a.left === leftOf(a.task) && Number(a.left) > 0));
  check('写入后：这天补满了 8h', Math.round(Object.values(zt.efforts).flat().filter(e => e.date === '2025-03-17' && e.deleted !== '1').reduce((n, e) => n + Number(e.consumed), 0) * 10) / 10 === 8);
  const log = await af.getLog();
  const batch = log.batches.find(b => b.id === started.batchId);
  check('补填记录：记下了每条写入（工时记录编号、任务、日期、小时、内容）', batch && batch.state === 'done' && batch.entries.length === good.entries.length && batch.entries.every(e => e.effortId && e.status === 'written' && e.taskName), JSON.stringify(batch).slice(0, 200));

  // ---- 防重复：生成方案后，这天又被别处补满了 ----
  const plan2 = await af.buildPlan({ dates: ['2025-03-12'], seed: 5 }, { ai: null, now: NOW });
  zt.efforts[10].push({ id: '9001', account: 'lijc', date: '2025-03-12', consumed: '8', left: '6', work: '别处刚补的', deleted: '0' });
  const before = zt.adds.length;
  const s2 = await af.startExecution({ planId: plan2.planId, days: [{ date: '2025-03-12', entries: plan2.days[0].entries.map(e => ({ taskId: e.taskId, hours: e.hours, work: e.work })) }] }, { writeGapMs: 0 });
  for (let i = 0; i < 100 && af.getJob(s2.jobId).state === 'running'; i++) await new Promise(r => setTimeout(r, 30));
  const j2 = af.getJob(s2.jobId);
  check('防重复：写入前重读当天最新工时，已被补满就整天跳过，不写任何东西', j2.state === 'done' && j2.written === 0 && zt.adds.length === before && j2.results.every(r => r.status === 'skipped' && /补满/.test(r.error)), JSON.stringify(j2.results[0]));

  // ---- 任务状态变了 / 禅道拒绝 ----
  const plan3 = await af.buildPlan({ dates: ['2025-03-19'], seed: 6 }, { ai: null, now: NOW });
  zt.failTask = plan3.days[0].entries[0].taskId;
  const s3 = await af.startExecution({ planId: plan3.planId, days: [{ date: '2025-03-19', entries: plan3.days[0].entries.map(e => ({ taskId: e.taskId, hours: e.hours, work: e.work })) }] }, { writeGapMs: 0 });
  for (let i = 0; i < 100 && af.getJob(s3.jobId).state === 'running'; i++) await new Promise(r => setTimeout(r, 30));
  const j3 = af.getJob(s3.jobId);
  check('禅道拒绝其中一条：该条标失败并带原因，其它条继续', j3.results.some(r => r.status === 'failed' && /未生效|任务状态/.test(r.error)) && (plan3.days[0].entries.length === 1 || j3.results.some(r => r.status === 'written')), JSON.stringify(j3.results.map(r => r.status)));
  zt.failTask = '';

  // ---- 撤销 ----
  const written = batch.entries.map(e => e.effortId);
  zt.efforts[Number(batch.entries[0].taskId)].find(e => e.id === batch.entries[0].effortId).work = batch.entries[0].work + '（后来在禅道里又改了）';
  const undo = await af.undoBatch(started.batchId);
  check('撤销：删除这批写入的、没被改过的；被改过的跳过并说明', undo.undone === batch.entries.length - 1 && undo.kept.length === 1 && /改过/.test(undo.kept[0].reason), JSON.stringify(undo));
  check('撤销：禅道里只删了该删的，别的工时（如 17 日原有的 2h）还在', zt.deletes.length === batch.entries.length - 1 && zt.efforts[10].some(e => e.id === '4001' && e.deleted !== '1'));
  const log2 = await af.getLog();
  check('撤销后补填记录里对应条目标为 undone', log2.batches.find(b => b.id === started.batchId).entries.filter(e => e.status === 'undone').length === batch.entries.length - 1);
  check('撤销不存在的批次被拒', await rejects(() => af.undoBatch('bnope'), /找不到这批/));

  // ---- 上限 ----
  check('一次最多 31 天', await rejects(() => af.buildPlan({ dates: Array.from({ length: 32 }, (_, i) => `2025-01-${String(i + 1).padStart(2, '0')}`) }, { ai: null, now: NOW }), /最多补 31 天/));
  check('日期和月份都没给被拒', await rejects(() => af.buildPlan({}, { ai: null, now: NOW }), /请给出/));
} catch (err) {
  check(`异常：${err.stack}`, false);
}

for (const x of results) console.log(`  ${x.pass ? '✓' : '✗'} ${x.name}${x.pass || !x.extra ? '' : `   → ${x.extra}`}`);
const passed = results.filter(x => x.pass).length;
console.log(`\n工时自动补填：${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
