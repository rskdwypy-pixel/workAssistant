/**
 * 回归测试：报告页（后端）
 *
 * 临时数据目录 + 模拟禅道（替换 globalThis.fetch）+ 本地模拟 AI 服务，不读写真实 data/、不访问网络。
 *
 * 覆盖：
 *   - 周期：日 / 周（任意一天归到周一）/ 月；当月最后一个工作日；应填工时的工作日（今天要过晚间时刻才算）
 *   - 采集：执行任务分页、子任务、只读周期开始后改过的任务的工时、工时按日期过滤、我的 Bug 按日期过滤
 *   - 统计：按人（工时、按天、按任务聚合工作内容、完成数、未填工时日）、按项目、逾期、不含 admin
 *   - AI：我的 / 全员两次调用；全员按人 / 按项目只保留真实存在的账号与项目；AI 失败仍保存统计
 *   - 生成：并发只生成一次；未来日期拒绝；周末无记录不生成；晚间任务在当月最后一个工作日顺带生成月报
 *   - 日历：日报 / 周报 / 月报状态、旧版日报标记
 *   - 接口：日历、读取、生成、未配置推送地址时推送报错（不再误报「已推送」）
 *   - 设置：禅道地址 / 账号 / 密码留空不覆盖已保存的值
 */
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });

// ---------- 模拟禅道 ----------
const zt = { listCalls: 0, effortCalls: [], realFetch: globalThis.fetch };
const json = (o) => new Response(JSON.stringify({ status: 'success', data: JSON.stringify(o) }), { headers: { 'Content-Type': 'application/json' } });
const T = (o) => ({ status: 'doing', assignedTo: '', finishedBy: '', finishedDate: '0000-00-00 00:00:00', openedBy: 'lijc', openedDate: '2025-01-01 10:00:00', deadline: '0000-00-00', ...o });
const TASKS = {
  1: [
    [T({ id: '101', name: '接口联调', assignedTo: 'lijc', lastEditedDate: '2025-03-12 18:00:00', deadline: '2025-03-10' })],
    [T({ id: '102', name: '旧任务', status: 'done', lastEditedDate: '2025-02-01 10:00:00' }),
     T({ id: '106', name: '直接关闭的任务', status: 'closed', closedBy: 'lijc', closedDate: '2025-03-12 21:00:00', closedReason: '', lastEditedDate: '2025-03-12 21:00:00' }),
     T({ id: '107', name: '取消后关闭的任务', status: 'closed', canceledBy: 'lijc', closedBy: 'lijc', closedDate: '2025-03-12 21:00:00', closedReason: 'cancel', lastEditedDate: '2025-03-12 21:00:00' })]
  ],
  2: [[
    T({ id: '103', name: '看板卡片', status: 'done', assignedTo: 'closed', finishedBy: 'wuf', finishedDate: '2025-03-12 17:00:00', lastEditedDate: '2025-03-12 17:00:00', openedBy: 'wuf', openedDate: '2025-03-12 09:00:00' }),
    T({ id: '105', name: '父任务', lastEditedDate: '2025-03-01 10:00:00', children: { 104: T({ id: '104', name: '子任务', assignedTo: 'zhouh', lastEditedDate: '2025-03-13 10:00:00' }) } })
  ]]
};
const EFFORTS = {
  101: [
    { account: 'lijc', date: '2025-03-12', consumed: '3', work: '接口联调' },
    { account: 'lijc', date: '2025-03-12', consumed: '0.5', work: '更新进度至 60%' },
    { account: 'lijc', date: '2025-03-11', consumed: '2', work: '设计' },
    { account: 'zhouh', date: '2025-03-12', consumed: '4', work: '开发' },
    { account: 'lijc', date: '2025-03-12', consumed: '1', work: '已删除的记录', deleted: '1' }
  ],
  102: [{ account: 'lijc', date: '2025-03-12', consumed: '9', work: '不应读到' }],
  103: [
    { account: 'wuf', date: '2025-03-12', consumed: '6', work: '上线' },
    { account: 'admin', date: '2025-03-12', consumed: '1', work: '管理员' }
  ],
  104: [{ account: 'zhouh', date: '2025-03-13', consumed: '2', work: '子任务开发' }],
  105: [],
  106: [],
  107: []
};
const BUGS = {
  openedBy: [{ id: '1', title: '登录失败', openedDate: '2025-03-12 10:00:00', status: 'active', productName: '产品A' }, { id: '2', title: '旧 Bug', openedDate: '2025-02-01 10:00:00' }],
  resolvedBy: [{ id: '3', title: '列表错位', openedDate: '2025-03-01 10:00:00', resolvedDate: '2025-03-12 16:00:00', status: 'resolved', productName: '产品A' }]
};

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (!url.startsWith('http://z.test')) return zt.realFetch(input, init);
  if (url.includes('user-refreshRandom')) return new Response('1234');
  if (url.includes('user-login') && (init.method || 'GET') === 'GET') return new Response('<html></html>', { headers: { 'Set-Cookie': 'zentaosid=sid1; path=/' } });
  if (url.includes('user-login')) return new Response(JSON.stringify({ result: 'success' }), { headers: { 'Content-Type': 'application/json' } });
  let m;
  if (url.includes('/zentao/my-team')) {
    return json({ users: { 1: { account: 'lijc', realname: '李佳成', role: 'qa' }, 2: { account: 'zhouh', realname: '周航', role: 'dev' }, 3: { account: 'wuf', realname: '吴凡', role: 'qd' }, 4: { account: 'admin', realname: 'admin' }, 5: { account: 'suny', realname: '孙悦', role: 'dev' } } });
  }
  if ((m = url.match(/execution-task-(\d+)-all-0-id_desc-0-500-(\d+)\.json/))) {
    zt.listCalls++;
    const pages = TASKS[m[1]] || [[]];
    const page = Number(m[2]);
    const tasks = Object.fromEntries((pages[page - 1] || []).map(t => [t.id, t]));
    return json({ tasks, pager: { pageTotal: pages.length, pageID: page } });
  }
  if ((m = url.match(/task-recordEstimate-(\d+)\.json/))) {
    zt.effortCalls.push(m[1]);
    return json({ efforts: EFFORTS[m[1]] || [] });
  }
  if ((m = url.match(/my-bug-(openedBy|resolvedBy)-0-id_desc-0-\d+-1\.json/))) {
    return json({ bugs: BUGS[m[1]], pager: { pageTotal: 1 } });
  }
  return new Response('not found', { status: 404 });
};

// ---------- 模拟 AI ----------
const ai = { calls: [], fail: false, prose: 0 };
const aiApp = express();
aiApp.use(express.json({ limit: '5mb' }));
aiApp.post('/v1/chat/completions', (req, res) => {
  const system = req.body.messages[0].content;
  const user = req.body.messages[1].content;
  const kind = system.includes('团队') ? 'team' : 'mine';
  ai.calls.push({ kind, user, messages: req.body.messages });
  if (ai.fail) return res.status(500).json({ error: { message: '模拟：AI 服务出错' } });
  // 模拟不执行 JSON mode 的中转：写成一篇文字日报
  if (ai.prose > 0) {
    ai.prose--;
    return res.json({ id: 'x', object: 'chat.completion', created: 0, model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '已整理如下：\n【日报】\n- 当日工时：3.5h' } }] });
  }
  const content = kind === 'team'
    ? (() => {
      // 按模板填：模板里给了哪些键就填哪些，另外多填一个不存在的人 / 项目（应被丢弃）
      const tpl = JSON.parse(user.slice(user.lastIndexOf('{"overall"')));
      ai.template = tpl;
      const byPerson = Object.fromEntries(Object.keys(tpl.byPerson).map(k => [k, `${k} 的总结`]));
      byPerson.ghost = '不存在的人';
      const byProject = Object.fromEntries(Object.keys(tpl.byProject).map(k => [k, `${k}项目的进展`]));
      byProject.P99 = 'x';
      return { overall: '推进了P1、P2等项目，P1 优先级任务已完成', risks: ['逾期未完成任务 1 个，最近到期的是 A', '接口联调（李佳成，截止 2025-03-10）', '1 人没有工时记录', '4 人中 1 人未填工时', '投入集中在项目甲'], byPerson, byProject };
    })()
    : { summary: '今天主要在联调接口', done: Array.from({ length: 12 }, (_, i) => `完成 ${i + 1}`), progress: ['接口联调'], next: ['继续联调'], risks: [] };
  res.json({ id: 'x', object: 'chat.completion', created: 0, model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '```json\n' + JSON.stringify(content) + '\n```' } }] });
});
const aiServer = await new Promise(r => { const s = aiApp.listen(0, '127.0.0.1', () => r(s)); });

// ---------- 临时数据 ----------
const tmp = mkdtempSync(join(tmpdir(), 'wa-reports-'));
const { config, mergeZentaoSettings } = await import('../src/config.js');
config.paths.data = tmp;
config.paths.tasks = join(tmp, 'tasks.json');
config.paths.history = join(tmp, 'history.json');
Object.assign(config.zentao, { enabled: true, url: 'http://z.test', username: 'lijc', password: 'p' });
Object.assign(config.ai, { apiKey: 'test-key', baseURL: `http://127.0.0.1:${aiServer.address().port}/v1`, model: 'test-model' });
config.webhook.url = '';
// 不受本机 .env 里「全员报告成员」设置影响
config.reports.members = [];
config.schedule.eveningHour = 21;
writeFileSync(join(tmp, 'executions.json'), JSON.stringify({ executions: [
  { id: '1', name: '迭代A', projectName: '项目甲', status: 'doing', type: 'stage' },
  { id: '2', name: '看板B', projectName: '项目乙', status: 'doing', type: 'kanban' }
] }));
writeFileSync(config.paths.history, JSON.stringify({ reports: [{ id: 'old', type: 'daily', date: '2025-03-05', summary: '旧版日报' }] }));
writeFileSync(config.paths.tasks, JSON.stringify({ version: '1.0', tasks: [] }));

const rc = await import('../src/services/reportCenter.js');
const reportsRouter = (await import('../src/routes/reports.js')).default;
const app = express();
app.use(express.json());
app.use('/api', reportsRouter);
const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const call = (path, init) => zt.realFetch(`http://127.0.0.1:${server.address().port}${path}`, init).then(async r => ({ status: r.status, ...(await r.json()) }));

try {
  // ============ 周期 ============
  check('周报：任意一天归到当周周一', rc.periodOf('weekly', '2025-03-16').key === '2025-03-10' && rc.periodOf('weekly', '2025-03-16').end === '2025-03-16');
  check('月报周期：首日到末日', rc.periodOf('monthly', '2025-02').end === '2025-02-28');
  check('当月最后一个工作日（月末是周六则取周五）', rc.lastWorkdayOfMonth('2025-05') === '2025-05-30' && rc.lastWorkdayOfMonth('2025-03') === '2025-03-31');
  const wk = rc.periodOf('weekly', '2025-03-12');
  check('应填工时的工作日：今天未到晚间时刻不算', rc.workdaysOf(wk, new Date(2025, 2, 12, 20)).join(',') === '2025-03-10,2025-03-11');
  check('应填工时的工作日：过了晚间时刻算上今天、不含周末', rc.workdaysOf(wk, new Date(2025, 2, 16, 22)).join(',') === '2025-03-10,2025-03-11,2025-03-12,2025-03-13,2025-03-14');
  let bad = null;
  try { rc.periodOf('daily', '2025/03/12'); } catch (err) { bad = err; }
  check('非法日期被拒绝', bad && /YYYY-MM-DD/.test(bad.message));

  // ============ 采集 ============
  const raw = await rc.collectRaw(wk);
  check('执行任务分页取完、包含子任务', ['101', '102', '103', '104', '105'].every(id => raw.tasks.some(t => t.id === id)), raw.tasks.map(t => t.id).join(','));
  check('只读周期开始后改过的任务的工时（旧任务、没改过的父任务不读）', !zt.effortCalls.includes('102') && !zt.effortCalls.includes('105') && ['101', '103', '104'].every(id => zt.effortCalls.includes(id)), zt.effortCalls.join(','));
  check('工时只保留周期内、已删除的不算', raw.efforts.every(e => e.date >= '2025-03-10' && e.date <= '2025-03-16') && !raw.efforts.some(e => e.work === '已删除的记录'));
  check('我的 Bug 按日期过滤', raw.myBugs.opened.map(b => b.id).join() === '1' && raw.myBugs.resolved.map(b => b.id).join() === '3');

  // ============ 统计 ============
  const day = rc.periodOf('daily', '2025-03-12');
  const rawDay = await rc.collectRaw(day);
  const { mine, team } = rc.computeReport(rawDay, day, { me: 'lijc', now: new Date(2025, 2, 12, 22) });
  check('全员不含 admin', team.members.length === 4 && !team.members.some(p => p.account === 'admin'));
  check('按人工时（日报）', team.members.find(p => p.account === 'lijc').hours === 3.5 && team.members.find(p => p.account === 'zhouh').hours === 4 && team.members.find(p => p.account === 'wuf').hours === 6 && team.totalHours === 13.5, JSON.stringify(team.members.map(p => [p.account, p.hours])));
  check('按人排序：工时多的在前', team.members[0].account === 'wuf');
  check('完成任务按完成人和完成日期统计', team.members.find(p => p.account === 'wuf').finished.map(t => t.id).join() === '103');
  check('按项目：工时与参与人', team.projects[0].project === '项目甲' && team.projects[0].hours === 7.5 && team.projects[0].members.map(m => m.name).join() === '周航,李佳成' && team.projects.find(p => p.project === '项目乙').finished === 1, JSON.stringify(team.projects.map(p => [p.project, p.hours, p.finished])));
  check('我的：工时、按任务聚合工作内容、Bug、逾期', mine.hours === 3.5 && mine.tasks.length === 1 && mine.tasks[0].works.join() === '接口联调,更新进度至 60%' && mine.bugs.opened.length === 1 && mine.bugs.resolved.length === 1 && mine.overdue.map(t => t.id).join() === '101', JSON.stringify({ h: mine.hours, t: mine.tasks, o: mine.overdue }));
  check('我的：进行中的任务列入「接下来」的依据', mine.openTasks.some(t => t.id === '101'));
  check('完成：没走「完成」直接关闭的算完成，取消的不算', mine.finished.map(t => t.id).join() === '106' && team.projects.find(p => p.project === '项目甲').finished === 1, JSON.stringify(mine.finished));

  const week = rc.computeReport(raw, wk, { me: 'lijc', now: new Date(2025, 2, 16, 22) });
  const lijcW = week.team.members.find(p => p.account === 'lijc');
  check('周报：按天工时', lijcW.byDay['2025-03-11'] === 2 && lijcW.byDay['2025-03-12'] === 3.5 && lijcW.hours === 5.5);
  check('周报：未填工时的工作日', lijcW.missingDays.join(',') === '2025-03-10,2025-03-13,2025-03-14', lijcW.missingDays.join(','));
  check('周报：子任务的工时计入', week.team.members.find(p => p.account === 'zhouh').hours === 6);

  // ============ 生成 ============
  const listBefore = zt.listCalls;
  const [g1, g2] = await Promise.all([
    rc.generateReport('daily', '2025-03-12', { now: new Date(2025, 2, 12, 22) }),
    rc.generateReport('daily', '2025-03-12', { now: new Date(2025, 2, 12, 22) })
  ]);
  check('同一份报告并发生成只执行一次', g1 === g2 && zt.listCalls - listBefore === 3, `listCalls=${zt.listCalls - listBefore}`);
  check('生成：我的 AI 总结', g1.mine.ai && g1.mine.ai.summary === '今天主要在联调接口' && g1.mine.ai.next[0] === '继续联调');
  check('全员 AI：按模板要求每个有记录的人、每个项目都写（项目用编号作键）', ai.template && Object.keys(ai.template.byPerson).sort().join() === 'lijc,wuf,zhouh' && Object.keys(ai.template.byProject).join() === 'P1,P2', JSON.stringify(ai.template));
  check('生成：全员 AI 总结分整体 / 按人 / 按项目', g1.team.ai && g1.team.ai.overall && g1.team.ai.byPerson.length === 3 && g1.team.ai.byProject.length === 2 && g1.team.ai.byProject[0].project === '项目甲' && g1.team.ai.byProject[0].summary === '项目甲的进展', JSON.stringify(g1.team.ai));
  check('全员 AI：正文里残留的项目编号换回项目名', g1.team.ai.overall === '推进了项目甲、项目乙等项目，P1 优先级任务已完成' && g1.team.ai.byProject[1].summary === '项目乙的进展', JSON.stringify([g1.team.ai.overall, g1.team.ai.byProject]));
  check('全员 风险：逾期、未填工时由代码给出（数字准确），模型写的这两类与只罗列逾期任务名的条目丢弃', g1.team.ai.risks[0].startsWith('逾期未完成任务 1 个，最近到期的是「接口联调」（李佳成，截止 2025-03-10）') && g1.team.ai.risks[1] === '4 人中 1 人没有工时记录' && g1.team.ai.risks[2] === '投入集中在项目甲' && g1.team.ai.risks.length === 3, JSON.stringify(g1.team.ai.risks));
  check('我的 风险：逾期由代码给出，不带自己的名字', g1.mine.ai.risks[0].startsWith('逾期未完成任务 1 个') && !g1.mine.ai.risks[0].includes('李佳成'), JSON.stringify(g1.mine.ai.risks));
  check('我的：模型列太多条时合成「等另外 N 项」', g1.mine.ai.done.length === 8 && g1.mine.ai.done[7] === '等另外 5 项（见下方「完成的任务」）', JSON.stringify(g1.mine.ai.done));
  check('全员 AI：同一类风险只保留一条', g1.team.ai.risks.length === 3, JSON.stringify(g1.team.ai.risks));
  check('全员 AI：不存在的账号 / 项目被丢弃', !g1.team.ai.byPerson.some(p => p.account === 'ghost') && g1.team.ai.byProject.length === 2);
  const teamCall = ai.calls.find(c => c.kind === 'team');
  check('交给 AI 的是统计好的数据（含工作内容）', teamCall && teamCall.user.includes('周航') && teamCall.user.includes('开发') && teamCall.user.includes('总工时 13.5h'), teamCall && teamCall.user.slice(0, 300));
  check('交给 AI：没有任何记录的人只列名字，不展开、不要求写总结', /没有任何工时 \/ 完成记录的人】孙悦/.test(teamCall.user) && !teamCall.user.includes('## 孙悦'));
  check('交给 AI：插件自动写的「更新进度至 N%」备注不送', ai.calls.every(c => !c.user.includes('更新进度至 60%')));
  check('交给 AI：任务数与完成数分开表述', /有工时记录的任务 1 个；完成（含关闭）的任务 1 个/.test(teamCall.user), teamCall.user.match(/## 李佳成[^\n]*/));
  check('报告已保存', (await rc.getReport('daily', '2025-03-12')).generatedAt === g1.generatedAt);

  ai.fail = true;
  const g3 = await rc.generateReport('weekly', '2025-03-12', { now: new Date(2025, 2, 16, 22) });
  ai.fail = false;
  check('AI 失败：统计照常保存，并记录原因', g3 && g3.mine.ai === null && g3.team.ai === null && g3.mine.aiError && g3.team.totalHours === 17.5 && (await rc.getReport('weekly', '2025-03-10')), JSON.stringify({ e: g3 && g3.mine.aiError, h: g3 && g3.team.totalHours }));

  const idle = await rc.generateReport('daily', '2025-03-15', { skipIfIdle: true, now: new Date(2025, 2, 15, 22) });
  check('周末没有任何工作记录：不生成', idle === null && !(await rc.getReport('daily', '2025-03-15')));
  let future = null;
  try { await rc.generateReport('daily', '2025-03-20', { now: new Date(2025, 2, 12, 22) }); } catch (err) { future = err; }
  check('未来日期不能生成', future && /未来/.test(future.message));

  // ============ 定时 ============
  const aiBefore = ai.calls.length;
  const evening = await rc.runEveningReports(new Date(2025, 2, 31, 21, 0));
  check('晚间：生成当天日报', evening && evening.key === '2025-03-31' && evening.auto === true);
  check('当月最后一个工作日：顺带生成月报', !!(await rc.getReport('monthly', '2025-03')) && ai.calls.length - aiBefore === 4);
  await rc.runEveningReports(new Date(2025, 2, 28, 21, 0));
  check('不是最后一个工作日：不生成月报', (await rc.getReport('monthly', '2025-03')).key === '2025-03' && !(await rc.getReport('monthly', '2025-02')));

  // ============ 日历 ============
  const cal = await rc.getCalendar('2025-03', new Date(2025, 2, 31, 22));
  const d12 = cal.days.find(d => d.date === '2025-03-12');
  check('日历：已生成的日报带我的 / 全员工时', d12.report && d12.report.myHours === 3.5 && d12.report.teamHours === 13.5 && d12.report.activeCount === 3 && d12.report.memberCount === 4);
  check('日历：旧版日报标记', cal.days.find(d => d.date === '2025-03-05').legacy === true);
  check('日历：覆盖当月的每一周（含跨月周）', cal.weeks[0].key === '2025-02-24' && cal.weeks[cal.weeks.length - 1].key === '2025-03-31' && cal.weeks.find(w => w.key === '2025-03-10').report);
  check('日历：月报状态与自动生成日', cal.monthly.report && cal.monthly.autoDate === '2025-03-31');

  // ============ 接口 ============
  let r = await call('/api/reports/calendar?month=2025-03');
  check('接口：日历', r.success && r.data.days.length === 31);
  r = await call('/api/reports/daily/2025-03-20');
  check('接口：未生成的报告返回 null 与周期', r.success && r.data === null && r.period.label.includes('3月20日'));
  r = await call('/api/reports/monthly/2025-13x');
  check('接口：非法参数 400', r.status === 400);
  r = await call('/api/reports/daily/2025-03-13/generate', { method: 'POST' });
  check('接口：生成并返回报告', r.success && r.data.key === '2025-03-13' && r.data.team.members.find(p => p.account === 'zhouh').hours === 2);
  r = await call('/api/reports/daily/2025-03-13/push', { method: 'POST' });
  check('接口：没配置推送地址时推送报错（不误报已推送）', !r.success && /推送地址/.test(r.message), r.message);
  r = await call('/api/reports/legacy/2025-03-05');
  check('接口：读取旧版日报', r.success && r.data && r.data.summary === '旧版日报');

  const full0 = await rc.getReport('daily', '2025-03-12');

  // ============ 全员报告只统计选定的人 ============
  const focused = rc.computeReport(rawDay, day, { me: 'lijc', now: new Date(2025, 2, 12, 22), focus: ['zhouh', 'wuf'] });
  check('选定成员：全员部分只统计选定的人', focused.team.focused && focused.team.members.map(p => p.account).sort().join() === 'wuf,zhouh' && focused.team.totalHours === 10, JSON.stringify(focused.team.members.map(p => [p.account, p.hours])));
  check('选定成员：按项目只算选定的人', !focused.team.projects.some(p => p.members.some(m => m.account === 'lijc')));
  check('选定成员：「我的」不受影响（我不在名单里也照常统计）', focused.mine.hours === 3.5 && focused.mine.byProject.length === 1 && focused.mine.byProject[0].hours === 3.5, JSON.stringify(focused.mine.byProject));
  const { parseAccountList } = await import('../src/config.js');
  check('选定成员：账号列表去重、去掉非法字符', parseAccountList(' a.b ,c-d,a.b,,x y,e@f ').join() === 'a.b,c-d,e@f');
  r = await call('/api/reports/members');
  check('接口：团队成员（不含 admin）与已选', r.success && r.data.members.length >= 4 && !r.data.members.some(m => m.account === 'admin') && Array.isArray(r.data.selected), JSON.stringify(r.data && r.data.members.map(m => m.account)));
  config.reports.members = ['wuf'];
  const gf = await rc.generateReport('daily', '2025-03-12', { now: new Date(2025, 2, 12, 22) });
  config.reports.members = [];
  check('选定成员：生成报告时按设置过滤', gf.team.focused && gf.team.members.length === 1 && gf.coverage.members === 1);

  // ============ 模型不按 JSON 输出 ============
  const { summarizeMine } = await import('../src/ai/reportAI.js');
  const aiBeforeProse = ai.calls.length;
  ai.prose = 1;
  const proseOut = await summarizeMine(full0.mine, rc.periodOf('daily', '2025-03-12'));
  const proseCalls = ai.calls.slice(aiBeforeProse);
  check('「我的」：用户消息末尾再给一次 JSON 键名（有的模型不重视系统提示）', /只输出一个 JSON 对象，键名固定为：\{"summary"/.test(proseCalls[0].user));
  check('回答不是 JSON：把原回答发回去要求改成 JSON，重试一次即可', proseOut.summary === '今天主要在联调接口' && proseCalls.length === 2 && proseCalls[1].messages.length === 4 && proseCalls[1].messages[2].role === 'assistant', proseCalls.length);
  ai.prose = 2;
  let proseErr = null;
  try { await summarizeMine(full0.mine, rc.periodOf('daily', '2025-03-12')); } catch (err) { proseErr = err; }
  check('重试还不是 JSON：报出模型名，提示换报告模型', proseErr && /不是 JSON/.test(proseErr.message) && /换个报告模型/.test(proseErr.message), proseErr && proseErr.message);
  ai.prose = 0;

  // ============ 只重新生成一部分 ============
  const full = await rc.generateReport('daily', '2025-03-13', { now: new Date(2025, 2, 13, 22) });
  const aiBeforePart = ai.calls.length;
  await new Promise(res => setTimeout(res, 5));
  const onlyMine = await rc.generateReport('daily', '2025-03-13', { now: new Date(2025, 2, 13, 22), part: 'mine' });
  check('只重新生成「我的」：只调一次 AI，「全员」原样保留', ai.calls.length - aiBeforePart === 1 && onlyMine.team.generatedAt === full.team.generatedAt && JSON.stringify(onlyMine.team.ai) === JSON.stringify(full.team.ai) && onlyMine.team.totalHours === full.team.totalHours && onlyMine.mine.generatedAt > full.mine.generatedAt, `aiCalls=${ai.calls.length - aiBeforePart}`);
  r = await call('/api/reports/daily/2025-03-13/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ part: 'team' }) });
  const saved = await rc.getReport('daily', '2025-03-13');
  check('接口：只重新生成「全员」，「我的」原样保留', r.success && saved.mine.generatedAt === onlyMine.mine.generatedAt && saved.team.generatedAt > onlyMine.team.generatedAt);
  const noOld = await rc.generateReport('daily', '2025-03-14', { now: new Date(2025, 2, 14, 22), part: 'team' });
  check('还没有报告时指定部分：整份生成', noOld.mine.ai && noOld.team.ai);

  // ============ 推送当前部分 ============
  const hooks = [];
  aiApp.post('/hook', (req, res) => { hooks.push(req.body); res.json({ ok: true }); });
  Object.assign(config.webhook, { url: `http://127.0.0.1:${aiServer.address().port}/hook`, type: 'generic' });
  r = await call('/api/reports/daily/2025-03-13/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ part: 'team' }) });
  check('推送「全员」：标题标明全员，内容是团队统计与按人总结', r.success && hooks[0] && /（全员）/.test(hooks[0].title) && hooks[0].items.some(x => /总工时/.test(x)) && hooks[0].items.some(x => /按人/.test(x)), JSON.stringify(hooks[0]));
  r = await call('/api/reports/daily/2025-03-13/push', { method: 'POST' });
  check('推送默认「我的」', r.success && hooks[1] && !/全员/.test(hooks[1].title) && hooks[1].items[0].startsWith('⏱ 工时'), JSON.stringify(hooks[1]));
  // 平台把错误写在 HTTP 200 的返回体里（企业微信 errcode 40008 等）：必须报失败，不能显示「已推送」
  aiApp.post('/hook-reject', (req, res) => res.json({ errcode: 40008, errmsg: 'invalid message type' }));
  config.webhook.url = `http://127.0.0.1:${aiServer.address().port}/hook-reject`;
  r = await call('/api/reports/daily/2025-03-13/push', { method: 'POST' });
  check('推送：平台在返回体里拒收时报失败并给出原因', !r.success && /invalid message type/.test(r.message) && /40008/.test(r.message), r.message);
  config.webhook.url = '';
  const { detectWebhookType } = await import('../src/utils/webhook.js');
  check('推送：按地址认出平台（类型选错也按平台格式发）',
    detectWebhookType('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x') === 'wecom' &&
    detectWebhookType('https://oapi.dingtalk.com/robot/send?access_token=x') === 'dingtalk' &&
    detectWebhookType('https://open.feishu.cn/open-apis/bot/v2/hook/x') === 'feishu' &&
    detectWebhookType('http://127.0.0.1:9/hook') === '');

  // ============ 历史报告列表 ============
  r = await call('/api/reports/list');
  const order = r.data ? r.data.map(x => x.key).join() : '';
  check('接口：历史报告按周期结束日倒序（同一天月报在前）', r.success && order === '2025-03,2025-03-31,2025-03-28,2025-03-10,2025-03-14,2025-03-13,2025-03-12' && r.data.every(x => x.label && 'myHours' in x), order);

  // ============ 设置：禅道配置留空不覆盖 ============
  const cur = { url: 'http://10.0.0.1:8088', username: 'lijc', password: 'secret' };
  const kept = mergeZentaoSettings({ enabled: true, url: '', username: ' ', password: '', createTaskUrl: '167' }, cur);
  check('设置：地址 / 账号 / 密码留空保持原值', kept.url === cur.url && kept.username === 'lijc' && kept.password === 'secret' && kept.enabled === true);
  const changed = mergeZentaoSettings({ enabled: 'true', url: ' http://new:1 ', username: 'u2', password: 'p2' }, cur);
  check('设置：填了新值就更新', changed.url === 'http://new:1' && changed.username === 'u2' && changed.password === 'p2');
} catch (err) {
  check(`异常：${err.stack}`, false);
} finally {
  server.close();
  aiServer.close();
  rmSync(tmp, { recursive: true, force: true });
}

for (const x of results) {
  console.log(`  ${x.pass ? '✓' : '✗'} ${x.name}${x.pass || !x.extra ? '' : `   → ${x.extra}`}`);
}
const passed = results.filter(x => x.pass).length;
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
