#!/usr/bin/env node
/**
 * 回归测试：新指派提醒（别人把任务 / Bug / 需求指派给我时提醒）
 *
 * 临时数据目录 + 模拟禅道（替换 globalThis.fetch），通知出口换成假的（不真的弹系统通知 / 发群消息）。
 *
 * 覆盖：
 *   首次只建基线不提醒；新指派给我的提醒（含操作人姓名）；自己指派给自己的不提醒；新出现但已完成 / 已关闭的不提醒；
 *   改派走又回来算新指派；多条合并成一条推送；系统通知 / Webhook 分别可关；没配 Webhook 不推；
 *   换禅道地址或账号后重新建基线并清掉旧记录；读取失败的那一类不产生误报；总开关；标记已读；测试推送
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import http from 'node:http';

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });

// ---------- 模拟禅道 ----------
const zt = {
  tasks: [], bugs: [], stories: [], reviewStories: [], ccBugs: [], ccStories: [],
  failKind: '',           // 'bug' = 读 Bug 列表失败
  actions: {}             // `${kind}:${id}` → [{actor, action, date}]
};
const json = (o, h = {}) => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json', ...h } });
const zj = (inner) => json({ status: 'success', data: JSON.stringify(inner) });
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (!url.startsWith('http://z.test') && !url.startsWith('http://z2.test')) return originalFetch(input, init);
  if (url.includes('user-refreshRandom')) return new Response('1234');
  if (url.includes('user-login') && (init.method || 'GET') === 'GET') return new Response('<html></html>', { headers: { 'Set-Cookie': 'zentaosid=s1; path=/' } });
  if (url.includes('user-login')) return json({ result: 'success' }, { 'Set-Cookie': 'za=u; path=/' });
  const m = url.match(/my-(task|bug|story)-(assignedTo|reviewedBy|mailto)/);
  if (m) {
    if (zt.failKind === m[1]) return new Response('boom', { status: 500 });
    const key = { task: 'tasks', bug: 'bugs', story: 'stories' }[m[1]];
    const src = m[2] === 'assignedTo' ? zt[key] : m[2] === 'reviewedBy' ? zt.reviewStories : (m[1] === 'bug' ? zt.ccBugs : zt.ccStories);
    return zj({ [key]: src, pager: { pageTotal: 1 }, users: {} });
  }
  const v = url.match(/(task|bug|story)-view-(\d+)\.json/);
  if (v) {
    const key = { task: 'tasks', bug: 'bugs', story: 'stories' }[v[1]];
    const item = zt[key].find(x => String(x.id) === v[2]) || { id: v[2] };
    return zj({ [v[1]]: item, actions: zt.actions[`${v[1]}:${v[2]}`] || [] });
  }
  return new Response('not mocked ' + url, { status: 404 });
};

// ---------- 环境 ----------
const tmp = mkdtempSync(join(tmpdir(), 'wa-notify-'));
const { config } = await import('../src/config.js');
config.paths.data = tmp;
Object.assign(config.zentao, { enabled: true, url: 'http://z.test', username: 'me', password: 'pw', users: { yangkai: '杨凯', wangrui: '王锐', me: '我' } });
Object.assign(config.webhook, { url: '' });
const nt = await import('../src/services/assignNotify.js');

const sent = { system: [], webhook: [] };
nt.setTransport({
  system: async (t, b) => { sent.system.push({ t, b }); },
  webhook: async (t, c, items) => { sent.webhook.push({ t, c, items }); }
});
const reset = () => { sent.system = []; sent.webhook = []; };
const mkTask = (id, over = {}) => ({ id, name: `任务${id}`, status: 'wait', pri: 2, deadline: '2026-11-05', assignedTo: 'me', assignedDate: '2026-10-26 10:00:00', ...over });
const mkBug = (id, over = {}) => ({ id, title: `Bug${id}`, status: 'active', pri: 3, assignedTo: 'me', assignedDate: '2026-10-26 10:00:00', ...over });
const act = (actor, action, date, id = 1) => ({ id, actor, action, date });

try {
  // ---------- 首次：只建基线 ----------
  zt.tasks = [mkTask(1), mkTask(2)];
  zt.bugs = [mkBug(10)];
  let r = await nt.pollOnce();
  check('首次检查：只建基线，存量不提醒', r.baseline === true && r.notified === 0 && sent.system.length === 0 && nt.listNotifications().items.length === 0, JSON.stringify(r));
  r = await nt.pollOnce();
  check('列表没变：什么都不提醒', r.found === 0 && sent.system.length === 0);

  // ---------- 新指派给我 ----------
  zt.tasks.push(mkTask(3, { assignedDate: '2026-10-26 11:30:00' }));
  zt.actions['task:3'] = [act('yangkai', 'opened', '2026-10-26 11:00:00', 1), act('yangkai', 'assigned', '2026-10-26 11:30:00', 2), act('me', 'commented', '2026-10-26 11:31:00', 3)];
  r = await nt.pollOnce();
  let list = nt.listNotifications();
  check('新指派给我的任务：提醒 1 条', r.found === 1 && r.notified === 1 && list.items.length === 1 && list.unread === 1, JSON.stringify(r));
  const n1 = list.items[0];
  check('记录里有对象、标题、操作人姓名、截止日、链接', n1.kind === 'task' && n1.objectId === '3' && n1.title === '任务3' && n1.actor === 'yangkai' && n1.actorName === '杨凯' && n1.deadline === '2026-11-05' && n1.url === 'http://z.test/zentao/task-view-3.html', JSON.stringify(n1));
  check('操作人取「指派时间」附近那条，不会被我之后的备注顶掉', n1.actor === 'yangkai');
  check('系统通知：标题写明谁、指派了什么', sent.system.length === 1 && /杨凯 指派了任务 #3/.test(sent.system[0].t) && /任务「任务3」/.test(sent.system[0].b), JSON.stringify(sent.system));
  check('Webhook 没配置：不推送', sent.webhook.length === 0);

  // ---------- 自己指派给自己 ----------
  reset();
  zt.tasks.push(mkTask(4));
  zt.actions['task:4'] = [act('me', 'opened', '2026-10-26 10:00:00', 1)];
  r = await nt.pollOnce();
  check('自己建的、指派给自己的：不提醒', r.found === 1 && r.notified === 0 && r.selfAssigned === 1 && sent.system.length === 0, JSON.stringify(r));

  // ---------- 新出现但已完成 / 已关闭 ----------
  zt.tasks.push(mkTask(5, { status: 'done' }), mkTask(6, { status: 'closed' }));
  zt.bugs.push(mkBug(11, { status: 'resolved' }));
  r = await nt.pollOnce();
  check('新出现但已完成 / 已关闭 / 已解决的：不提醒', r.found === 0 && sent.system.length === 0, JSON.stringify(r));

  // ---------- 改派走又回来 ----------
  zt.tasks = zt.tasks.filter(t => t.id !== 3);
  await nt.pollOnce();
  zt.tasks.push(mkTask(3, { assignedDate: '2026-10-26 15:00:00' }));
  zt.actions['task:3'].push(act('wangrui', 'assigned', '2026-10-26 15:00:00', 4));
  reset();
  r = await nt.pollOnce();
  check('改派走又被指派回来：算新指派，操作人是这次的', r.notified === 1 && nt.listNotifications().items[0].actor === 'wangrui' && /王锐/.test(sent.system[0].t));

  // ---------- Bug / 需求 + 合并 ----------
  reset();
  zt.bugs.push(mkBug(12));
  zt.stories = [{ id: 20, title: '需求20', status: 'active', pri: 1, assignedTo: 'me', assignedDate: '2026-10-26 16:00:00' }];
  zt.tasks.push(mkTask(7));
  zt.actions['bug:12'] = [act('yangkai', 'assigned', '2026-10-26 10:00:00')];
  zt.actions['story:20'] = [act('wangrui', 'assigned', '2026-10-26 16:00:00')];
  zt.actions['task:7'] = [act('yangkai', 'assigned', '2026-10-26 10:00:00')];
  r = await nt.pollOnce();
  // 需求这一类是第一次看到 → 只建基线（story 列表此前一直是空的 []，不是 undefined，所以应当被识别为新指派）
  check('同一轮多条（任务 + Bug + 需求）：合并成一条系统通知', r.notified === 3 && sent.system.length === 1 && /有 3 项提醒/.test(sent.system[0].t) && /需求 #20/.test(sent.system[0].b), JSON.stringify([r, sent.system]));
  check('未读列表里有 3 条，类型齐全', nt.listNotifications().items.filter(n => n.id && !n.read).length >= 3 && new Set(nt.listNotifications().items.map(n => n.kind)).size === 3);

  // ---------- 两个出口分别可关 / Webhook ----------
  reset();
  config.webhook.url = 'http://hook.test/x'; config.webhook.type = 'generic';
  nt.saveSettings({ system: false, webhook: true });
  zt.tasks.push(mkTask(8)); zt.actions['task:8'] = [act('yangkai', 'assigned', '2026-10-26 10:00:00')];
  await nt.pollOnce();
  check('只开 Webhook：不弹系统通知，推送带标题、操作人和链接', sent.system.length === 0 && sent.webhook.length === 1 && /杨凯/.test(sent.webhook[0].t) && sent.webhook[0].items.some(i => i.includes('http://z.test/zentao/task-view-8.html')), JSON.stringify(sent.webhook));
  reset();
  nt.saveSettings({ system: true, webhook: false });
  zt.tasks.push(mkTask(9)); zt.actions['task:9'] = [act('yangkai', 'assigned', '2026-10-26 10:00:00')];
  await nt.pollOnce();
  check('只开系统通知：不推 Webhook', sent.system.length === 1 && sent.webhook.length === 0);
  nt.saveSettings({ system: true, webhook: true });

  // ---------- 读取失败不产生误报 ----------
  reset();
  zt.failKind = 'bug';
  r = await nt.pollOnce();
  zt.failKind = '';
  check('某一类读取失败：这一轮跳过，不报错', r.notified === 0);
  zt.bugs.push(mkBug(13)); zt.actions['bug:13'] = [act('yangkai', 'assigned', '2026-10-26 10:00:00')];
  r = await nt.pollOnce();
  check('恢复后：失败期间新指派的 Bug 正常提醒，之前已有的不会重复提醒', r.notified === 1 && nt.listNotifications().items[0].objectId === '13', JSON.stringify(r));

  // ---------- 总开关 ----------
  reset();
  nt.saveSettings({ enabled: false });
  zt.tasks.push(mkTask(14)); zt.actions['task:14'] = [act('yangkai', 'assigned', '2026-10-26 10:00:00')];
  r = await nt.pollOnce();
  check('总开关关闭：不检查、不提醒', r.skipped === 'disabled' && sent.system.length === 0);
  nt.saveSettings({ enabled: true });
  r = await nt.pollOnce();
  check('重新打开：关闭期间新指派的会补提醒', r.notified === 1 && nt.listNotifications().items[0].objectId === '14');

  // ---------- 标记已读 ----------
  const before = nt.listNotifications();
  const one = before.items[0].id;
  let mr = nt.markRead([one]);
  check('标记已读：未读数减 1', mr.changed === 1 && mr.unread === before.unread - 1);
  mr = nt.markRead('all');
  check('全部已读', nt.listNotifications().unread === 0);

  // ---------- 测试推送 ----------
  reset();
  const t = await nt.sendTest();
  check('发送测试：系统通知和 Webhook 都发出，内容标明是测试', t.system && t.webhook && /测试/.test(sent.system[0].b));

  // ---------- 待我评审 ----------
  reset();
  zt.reviewStories = [{ id: 30, title: '待评审需求', status: 'reviewing', openedBy: 'wangrui', pri: 2 }];
  r = await nt.pollOnce();
  check('待我评审：新出现的“评审中”需求提醒，写明提交人', r.notified === 1 && nt.listNotifications().items[0].type === 'review' && nt.listNotifications().items[0].objectId === '30' && /王锐 请你评审需求 #30/.test(sent.system[0].t), JSON.stringify([r, sent.system]));
  reset();
  zt.reviewStories.push({ id: 32, title: '已评审通过的', status: 'active', openedBy: 'wangrui' }, { id: 33, title: '我自己提的', status: 'reviewing', openedBy: 'me' });
  r = await nt.pollOnce();
  check('待我评审：已通过的、自己提的不提醒', r.notified === 0 && r.selfAssigned === 1 && sent.system.length === 0, JSON.stringify(r));

  // ---------- 需求变更待确认 ----------
  reset();
  zt.tasks.find(t => t.id === 1).needConfirm = '1';
  r = await nt.pollOnce();
  const cf = nt.listNotifications().items[0];
  check('需求变更待确认：任务的 needConfirm 新变成 1 时提醒', r.notified === 1 && cf.type === 'confirm' && cf.objectId === '1' && /任务 #1 关联的需求变更了/.test(sent.system[0].t), JSON.stringify([r, sent.system]));
  r = await nt.pollOnce();
  check('需求变更待确认：同一个任务不重复提醒', r.notified === 0);

  // ---------- 抄送给我（默认关）----------
  reset();
  zt.ccBugs = [mkBug(40)];
  r = await nt.pollOnce();
  check('抄送默认关：不读也不提醒', r.notified === 0 && sent.system.length === 0);
  nt.saveSettings({ types: { cc: true } });
  r = await nt.pollOnce();
  check('刚打开抄送：当前已有的只建基线，不提醒', r.notified === 0 && sent.system.length === 0);
  zt.ccBugs.push(mkBug(41, { openedBy: 'yangkai' }));
  r = await nt.pollOnce();
  check('抄送：新抄送给我的 Bug 提醒', r.notified === 1 && /杨凯 抄送了Bug #41 给你/.test(sent.system[0].t), JSON.stringify([r, sent.system]));
  nt.saveSettings({ types: { cc: false } });

  // ---------- 截止日 ----------
  reset();
  const D = (s) => new Date(`${s}T10:00:00`);
  zt.tasks.forEach(t => { t.deadline = '2026-12-31'; });
  zt.bugs.forEach(b => { b.deadline = ''; });
  const monday = D('2026-10-26');
  r = await nt.pollOnce({ now: monday });
  check('截止日：第一次建基线，已有的临近截止不提醒', r.notified === 0 && sent.system.length === 0);
  zt.tasks.find(t => t.id === 2).deadline = '2026-10-27';        // 明天
  zt.tasks.find(t => t.id === 9).deadline = '2026-10-25';        // 昨天，逾期 1 天
  zt.tasks.find(t => t.id === 8).deadline = '2026-10-10';        // 逾期太久，不提醒
  zt.bugs.find(b => b.id === 10).deadline = '2026-10-26';        // 今天
  r = await nt.pollOnce({ now: monday });
  const dl = nt.listNotifications().items.filter(n => n.type === 'deadline');
  check('截止日：明天截止 / 今天截止 / 刚逾期 各提醒一次，逾期太久的不提醒', r.notified === 3 && dl.length === 3 && dl.some(n => n.objectId === '2' && n.days === 1) && dl.some(n => n.objectId === '10' && n.kind === 'bug' && n.days === 0) && dl.some(n => n.objectId === '9' && n.days === -1) && !dl.some(n => n.objectId === '8'), JSON.stringify(dl.map(n => [n.kind, n.objectId, n.days])));
  check('截止日：文案', /任务 #2 明天截止/.test(sent.system[0].b + sent.system[0].t) || sent.system[0].b.includes('明天截止'), JSON.stringify(sent.system));
  reset();
  r = await nt.pollOnce({ now: monday });
  check('截止日：同一档不重复提醒', r.notified === 0);
  r = await nt.pollOnce({ now: D('2026-10-27') });
  check('截止日：第二天“明天截止”升级成“今天截止”，再提醒一次', r.notified >= 1 && nt.listNotifications().items.some(n => n.type === 'deadline' && n.objectId === '2' && n.days === 0), JSON.stringify(r));
  zt.tasks.find(t => t.id === 2).deadline = '2026-11-10';       // 延期
  r = await nt.pollOnce({ now: D('2026-10-27') });
  check('截止日：延期后档位回退，不提醒', !nt.listNotifications().items.slice(0, r.notified).some(n => n.objectId === '2'));
  reset();
  zt.tasks.find(t => t.id === 7).deadline = '2026-11-01';       // 周日是“明天”... 先在周六检查
  const saturday = D('2026-10-31');
  r = await nt.pollOnce({ now: saturday });
  check('休息日（周六）：不处理截止日，不提醒', !nt.listNotifications().items.slice(0, r.notified).some(n => n.type === 'deadline') && sent.system.length === 0, JSON.stringify([r, sent.system]));
  r = await nt.pollOnce({ now: D('2026-11-02') });
  check('回到上班日：这时才提醒（周一看到的是已逾期 1 天）', nt.listNotifications().items.some(n => n.objectId === '7' && n.type === 'deadline'), JSON.stringify(r));
  nt.saveSettings({ types: { deadline: false } });
  zt.tasks.find(t => t.id === 6).deadline = '2026-11-03';
  reset();
  r = await nt.pollOnce({ now: D('2026-11-02') });
  check('截止日提醒可关', r.notified === 0 && sent.system.length === 0);
  nt.saveSettings({ types: { deadline: true } });

  // ---------- 换了禅道 / 账号：重新建基线，清旧记录 ----------
  reset();
  config.zentao.url = 'http://z2.test';
  zt.tasks = [mkTask(1), mkTask(50)];
  r = await nt.pollOnce();
  check('换了禅道地址：重新建基线，不把新禅道的存量当成新指派', r.baseline === true && r.notified === 0 && sent.system.length === 0);
  check('换了禅道地址：旧禅道的通知记录被清掉', nt.listNotifications().items.length === 0);
  config.zentao.username = 'other';
  zt.tasks.push(mkTask(51));
  r = await nt.pollOnce();
  check('换了账号：同样重新建基线', r.baseline === true && r.notified === 0 && sent.system.length === 0);

  // ---------- 接口 ----------
  config.zentao.url = 'http://z.test'; config.zentao.username = 'me';
  const router = (await import('../src/routes/notify.js')).default;
  const app = express(); app.use(express.json()); app.use('/api', router);
  const server = await new Promise(rs => { const s = app.listen(0, '127.0.0.1', () => rs(s)); });
  const call = (method, path, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: `/api${path}`, method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve(JSON.parse(b)));
    });
    req.on('error', reject); req.end(data);
  });
  let a = await call('GET', '/notify/settings');
  check('接口：读设置（带 Webhook 是否已配置）', a.success && a.data.enabled === true && a.data.webhookConfigured === true);
  a = await call('POST', '/notify/settings', { webhook: false, bogus: 1 });
  check('接口：改设置，只认 enabled / system / webhook 三个布尔值', a.data.webhook === false && !('bogus' in a.data));
  a = await call('POST', '/notifications/check');
  check('接口：立即检查', a.success && typeof a.data.unread === 'number');
  a = await call('GET', '/notifications');
  check('接口：未读列表', a.success && Array.isArray(a.data.items));
  server.close();
} catch (err) {
  check(`异常：${err.stack}`, false);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

for (const x of results) console.log(`  ${x.pass ? '✓' : '✗'} ${x.name}${x.pass || !x.extra ? '' : `   → ${String(x.extra).slice(0, 300)}`}`);
const passed = results.filter(x => x.pass).length;
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
