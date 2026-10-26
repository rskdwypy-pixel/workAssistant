/**
 * 真函数测试：新指派提醒（前端）
 *   - 右上角铃铛：登录后才显示；未读数；下拉列表（谁指派了什么、时间、截止）；点一条标记已读并在禅道里打开；全部已读
 *   - 设置 → 通知推送：总开关 / 系统通知 / Webhook 即时保存；Webhook 没配置的提示；发送测试；立即检查
 *
 * jsdom 加载真实 newtab.html，原样执行 notify-ui.js；网络换成模拟。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const EXT = path.join(__dirname, '..', 'extension');
const SRC = fs.readFileSync(path.join(EXT, 'notify-ui.js'), 'utf8');
const HTML = fs.readFileSync(path.join(EXT, 'newtab.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

const document_types = (doc) => Object.fromEntries([...doc.querySelectorAll('[data-notify-type]')].map(b => [b.dataset.notifyType, b.checked]));
const item = (id, over = {}) => ({ id: `n${id}`, kind: 'task', objectId: String(id), title: `任务${id}`, actor: 'yangkai', actorName: '杨凯', pri: 2, deadline: '2026-11-05', at: new Date(Date.now() - 5 * 60000).toISOString(), read: false, ...over });

function setup(s) {
  const dom = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  s.requests = []; s.toasts = []; s.opened = []; s.settingsOpened = null;
  s.items = s.items || []; s.settings = s.settings || { enabled: true, system: true, webhook: true, webhookConfigured: true };
  win.fetch = async (url, init = {}) => {
    const u = String(url).replace('http://127.0.0.1:3721', '');
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    s.requests.push({ method, url: u, body });
    const reply = (b) => ({ ok: true, status: 200, json: async () => b });
    const unread = () => s.items.filter(i => !i.read).length;
    if (s.down) throw new TypeError('Failed to fetch');
    if (u === '/api/notifications') return reply({ success: true, data: { items: s.items, unread: unread() } });
    if (u === '/api/notifications/read') {
      s.items.forEach(i => { if (body.ids === 'all' || body.ids.includes(i.id)) i.read = true; });
      return reply({ success: true, data: { unread: unread() } });
    }
    if (u === '/api/notifications/check') return reply({ success: true, data: s.checkResult || { found: 0, notified: 0, items: s.items, unread: unread() } });
    if (u === '/api/notifications/test') return reply({ success: true, data: s.testResult || { system: true, webhook: true, webhookConfigured: true } });
    if (u === '/api/notify/settings') {
      if (method === 'POST') s.settings = { ...s.settings, ...body };
      return reply({ success: true, data: s.settings });
    }
    return reply({ success: false });
  };
  win.Toast = { success: (m) => s.toasts.push(m), error: (m) => s.toasts.push(m), info: (m) => s.toasts.push(m), warning: () => {} };
  win.openInZentao = (t, id) => s.opened.push([t, id]);
  win.openSettingsModal = (g) => { s.settingsOpened = g; };
  win.Account = { state: s.account === undefined ? { state: 'ok' } : s.account };
  win.eval(`var API_BASE_URL = 'http://127.0.0.1:3721';\n${SRC.replace(/if \(typeof document !== 'undefined'\) \{[\s\S]*?\n\}\n?$/, '')}\nwindow.NotifyUI = NotifyUI;`);
  win.NotifyUI.init();
  return { win, doc: win.document, $: (id) => win.document.getElementById(id) };
}

(async () => {
  // ============ 铃铛 ============
  let s = { account: { state: 'unconfigured' }, items: [item(1)] };
  let { win, doc, $ } = setup(s);
  await tick(30);
  check('没登录 / 本地模式：不显示铃铛', $('notifyBellBtn').hidden);

  s = { items: [item(1), item(2), item(3, { read: true })] };
  ({ win, doc, $ } = setup(s));
  await tick(30);
  check('登录后显示铃铛，角标是未读数', !$('notifyBellBtn').hidden && !$('notifyCount').hidden && $('notifyCount').textContent === '2', $('notifyCount').textContent);
  check('铃铛的提示文字带未读数', /2 条提醒/.test($('notifyBellBtn').title));

  s.items = [item(1, { read: true })];
  await win.NotifyUI.refresh();
  check('全部已读后：角标消失', $('notifyCount').hidden);

  // ============ 下拉列表 ============
  s = { items: [item(3, { at: new Date(Date.now() - 2 * 3600000).toISOString() }), item(2, { kind: 'bug', actor: 'wangrui', actorName: '王锐', deadline: '', pri: 3, title: '登录页白屏' }), item(1, { kind: 'story', read: true, title: '新需求' })] };
  ({ win, doc, $ } = setup(s));
  await tick(30);
  $('notifyBellBtn').click();
  await tick(30);
  let panel = doc.querySelector('.notify-panel');
  const rows = [...panel.querySelectorAll('[data-np-open]')];
  check('点铃铛：弹出列表，每条一行', panel && rows.length === 3);
  check('每条写明谁指派了什么：杨凯 指派了任务 #3 / 王锐 指派了Bug #2 / 需求', /杨凯 指派了任务 #3/.test(rows[0].textContent) && /王锐 指派了Bug #2/.test(rows[1].textContent) && /指派了需求 #1/.test(rows[2].textContent), rows.map(r => r.textContent.replace(/\s+/g, ' ')).join(' | '));
  check('显示标题、相对时间、截止日、优先级', /任务3/.test(rows[0].textContent) && /2 小时前/.test(rows[0].textContent) && /截止 2026-11-05/.test(rows[0].textContent) && /P2/.test(rows[0].textContent));
  check('未读有红点和底色，已读没有', rows[0].classList.contains('is-unread') && rows[0].querySelector('.np-dot') && !rows[2].classList.contains('is-unread') && !rows[2].querySelector('.np-dot'));
  check('标题栏写未读数，有「全部已读」', /2 条未读/.test(panel.querySelector('.np-head').textContent) && panel.querySelector('[data-np="readall"]'));

  // 其他类型的提醒：文案和图标
  const typed = [
    item(5, { type: 'review', kind: 'story', actorName: '王锐', title: '待评审' }),
    item(6, { type: 'confirm', title: '变更' }),
    item(7, { type: 'deadline', days: 1, deadline: '2026-10-27', title: '明天交' }),
    item(8, { type: 'deadline', days: -2, deadline: '2026-10-24', title: '逾期的' }),
    item(9, { type: 'cc', kind: 'bug', actorName: '杨凯', title: '抄送的' })
  ];
  s.items = typed; await win.NotifyUI.refresh();
  const trows = [...doc.querySelectorAll('.notify-panel [data-np-open]')];
  const tt = trows.map(r => r.querySelector('.np-title').textContent);
  check('不同类型的提醒文案：评审 / 变更待确认 / 明天截止 / 已逾期 / 抄送', /王锐 请你评审需求 #5/.test(tt[0]) && /任务 #6 关联的需求变更了，请确认/.test(tt[1]) && /任务 #7 明天截止/.test(tt[2]) && /任务 #8 已逾期 2 天/.test(tt[3]) && /杨凯 抄送了Bug #9 给你/.test(tt[4]), tt.join(' | '));
  check('不同类型有各自的图标', /🔎/.test(trows[0].textContent) && /🔄/.test(trows[1].textContent) && /⏰/.test(trows[2].textContent) && /📨/.test(trows[4].textContent));
  check('截止日提醒的元信息里不再重复写“截止”', !/截止 2026-10-27/.test(trows[2].querySelector('.np-meta').textContent));
  s.items = [item(3, { at: new Date(Date.now() - 2 * 3600000).toISOString() }), item(2, { kind: 'bug', actor: 'wangrui', actorName: '王锐', deadline: '', pri: 3, title: '登录页白屏' }), item(1, { kind: 'story', read: true, title: '新需求' })];
  await win.NotifyUI.refresh();
  panel = doc.querySelector('.notify-panel');

  // 点一条：标记已读 + 在禅道里打开
  [...doc.querySelectorAll('.notify-panel [data-np-open]')][1].click();
  await tick(30);
  const readReq = s.requests.find(r => r.url === '/api/notifications/read' && Array.isArray(r.body.ids));
  check('点一条：标记这一条已读，并在禅道里打开它', readReq && readReq.body.ids[0] === 'n2' && s.opened.length === 1 && s.opened[0][0] === 'bug' && s.opened[0][1] === '2');
  check('点完：列表收起，角标减 1', !doc.querySelector('.notify-panel') && $('notifyCount').textContent === '1');

  // 全部已读
  $('notifyBellBtn').click();
  await tick(30);
  doc.querySelector('.notify-panel [data-np="readall"]').click();
  await tick(40);
  check('全部已读：请求 ids=all，角标消失', s.requests.some(r => r.url === '/api/notifications/read' && r.body.ids === 'all') && $('notifyCount').hidden);
  check('全部已读后：标题栏没有「全部已读」', !doc.querySelector('.notify-panel [data-np="readall"]'));

  // 关闭方式
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('按 Esc 关闭列表', !doc.querySelector('.notify-panel'));
  $('notifyBellBtn').click();
  await tick(10);
  doc.body.click();
  check('点列表外面关闭', !doc.querySelector('.notify-panel'));

  // 空状态 + 设置入口
  s = { items: [] };
  ({ win, doc, $ } = setup(s));
  await tick(30);
  $('notifyBellBtn').click();
  await tick(30);
  check('没有提醒：写明什么时候会出现、多久检查一次', /暂时没有提醒/.test(doc.querySelector('.notify-panel').textContent) && /每 5 分钟/.test(doc.querySelector('.notify-panel').textContent));
  doc.querySelector('.notify-panel [data-np="settings"]').click();
  check('列表底部「提醒设置」打开设置的通知推送分组', s.settingsOpened === 'p-notify' && !doc.querySelector('.notify-panel'));

  // 立即检查
  s.checkResult = { found: 1, notified: 1, items: [item(9)], unread: 1 };
  $('notifyBellBtn').click();
  await tick(30);
  doc.querySelector('.notify-panel [data-np="check"]').click();
  await tick(40);
  check('列表里「立即检查」：请求检查、角标和列表更新、提示有新指派', s.requests.some(r => r.url === '/api/notifications/check') && $('notifyCount').textContent === '1' && s.toasts.some(t => /1 项新指派给你/.test(t)) && /#9/.test(doc.querySelector('.notify-panel').textContent));
  s.checkResult = { baseline: true, found: 0, notified: 0, items: [], unread: 0 };
  await win.NotifyUI.checkNow();
  check('第一次检查：说明已记下当前的，之后新指派的才提醒', s.toasts.some(t => /已记下当前/.test(t)));

  // ============ 设置 ============
  s = { items: [], settings: { enabled: true, system: true, webhook: false, webhookConfigured: false, types: { assigned: true, review: true, confirm: true, deadline: true, cc: false } } };
  ({ win, doc, $ } = setup(s));
  await tick(30);
  check('设置：显示当前的开关状态', $('notifyEnabled').checked && $('notifySystem').checked && !$('notifyWebhook').checked);
  check('设置：Webhook 没配置时提示先填地址', /先在下面填好 Webhook 地址/.test($('notifyHint').textContent));
  $('notifyWebhook').checked = true;
  $('notifyWebhook').dispatchEvent(new win.Event('change'));
  await tick(30);
  let post = s.requests.filter(r => r.url === '/api/notify/settings' && r.method === 'POST').pop();
  check('改一个开关：立即保存三个值', post && post.body.enabled === true && post.body.system === true && post.body.webhook === true);
  $('notifyEnabled').checked = false;
  $('notifyEnabled').dispatchEvent(new win.Event('change'));
  await tick(30);
  check('关掉总开关：系统通知 / Webhook 两个子开关置灰', $('notifySystem').disabled && $('notifyWebhook').disabled);
  $('notifyEnabled').checked = true;
  $('notifyEnabled').dispatchEvent(new win.Event('change'));
  await tick(30);
  check('重新打开：子开关恢复可选', !$('notifySystem').disabled && !$('notifyWebhook').disabled);

  // 提醒类型开关
  check('设置：显示五类提醒的当前开关（默认抄送关）', document_types(doc).assigned && document_types(doc).review && !document_types(doc).cc);
  doc.querySelector('[data-notify-type="cc"]').checked = true;
  doc.querySelector('[data-notify-type="cc"]').dispatchEvent(new win.Event('change'));
  await tick(30);
  post = s.requests.filter(r => r.url === '/api/notify/settings' && r.method === 'POST').pop();
  check('改一类提醒：立即保存，带上五个类型的值', post.body.types && post.body.types.cc === true && post.body.types.assigned === true && Object.keys(post.body.types).length === 5, JSON.stringify(post.body));
  $('notifyEnabled').checked = false; $('notifyEnabled').dispatchEvent(new win.Event('change')); await tick(30);
  check('总开关关掉：五类开关也置灰', [...doc.querySelectorAll('[data-notify-type]')].every(b => b.disabled));
  $('notifyEnabled').checked = true; $('notifyEnabled').dispatchEvent(new win.Event('change')); await tick(30);

  // 发送测试
  $('notifyTestBtn').click();
  await tick(40);
  check('发送测试：显示系统通知 ✓ Webhook ✓', /系统通知 ✓/.test($('notifyTestResult').textContent) && /Webhook ✓/.test($('notifyTestResult').textContent) && $('notifyTestResult').classList.contains('success') && !$('notifyTestBtn').disabled);
  s.testResult = { system: true, webhook: false, webhookConfigured: false };
  $('notifyTestBtn').click();
  await tick(40);
  check('测试时 Webhook 没配置：说明「Webhook 未配置」', /Webhook 未配置/.test($('notifyTestResult').textContent));
  s.testResult = { system: false, webhook: false, webhookConfigured: true };
  $('notifyTestBtn').click();
  await tick(40);
  check('两个出口都没发出去：标红', $('notifyTestResult').classList.contains('error'));

  // 设置页的「立即检查」
  s.checkResult = { found: 0, notified: 0, items: [], unread: 0 };
  $('notifyCheckBtn').click();
  await tick(40);
  check('设置页「立即检查」：没有新指派时给出说明，按钮恢复', /没有新的指派/.test($('notifyTestResult').textContent) && !$('notifyCheckBtn').disabled);

  // 连不上后台
  s = { items: [], down: true };
  ({ win, doc, $ } = setup(s));
  await tick(30);
  check('连不上后台：不报错，铃铛保持显示', !$('notifyBellBtn').hidden);

  for (const x of results) console.log(`  ${x.pass ? '✓' : '✗'} ${x.name}${x.pass || !x.extra ? '' : `   → ${String(x.extra).slice(0, 300)}`}`);
  const passed = results.filter(x => x.pass).length;
  console.log(`\n${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
