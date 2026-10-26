/**
 * 真函数测试：账号（前端）
 *   - 第一次使用：弹登录卡片（可「稍后再说」进入本地模式）；右上角「登录禅道」+ 设置
 *   - 登录：漏填 / 账号密码错误的提示与聚焦；换账号先确认；成功后依次同步执行、团队、任务再刷新
 *   - 已登录：右上角头像（姓名首字 + 状态点）；菜单里的用户信息、设置、切换账号、退出
 *   - 登录失效：头像红点 + 「只需输入密码」的登录卡片；连不上：灰点、不弹卡片
 *   - 本地模式：搜索走本地并提示登录；报告页给出登录入口
 *   - 重置为首次使用：输入「重置」才能确认；可选清空本地数据；清浏览器设置但保留调试模式
 *   - AI 未配置提示
 *
 * jsdom 加载真实 newtab.html，原样执行 account.js；网络换成模拟。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const EXT = path.join(__dirname, '..', 'extension');
const ACC = fs.readFileSync(path.join(EXT, 'account.js'), 'utf8');
const REP = fs.readFileSync(path.join(EXT, 'reports.js'), 'utf8');
const HTML = fs.readFileSync(path.join(EXT, 'newtab.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

const profile = { account: 'zhangs', realname: '张三', role: 'qa', roleLabel: '测试', dept: '产研部', email: 'z@x.com' };
const stateOf = (state, over = {}) => ({
  state, zentaoUrl: state === 'unconfigured' && !over.keepUrl ? '' : 'http://10.0.0.1:8088', username: state === 'unconfigured' && !over.keepUrl ? '' : 'zhangs',
  dataOwner: '', dataOwnerName: '', aiConfigured: true, profile: state === 'unconfigured' ? null : profile, message: '', ...over
});

function setup(s) {
  const dom = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  s.requests = [];
  s.reloads = 0;
  s.confirms = [];
  s.toasts = [];
  win.fetch = async (url, init = {}) => {
    const u = String(url).replace('http://127.0.0.1:3721', '');
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    s.requests.push({ method, url: u, body });
    const reply = (b, status = 200) => ({ ok: status < 400, status, json: async () => b });
    // down：true 一直连不上；数字 = 前几次连不上（后台还在启动）
    if (s.down) { if (typeof s.down === 'number') s.down--; throw new TypeError('Failed to fetch'); }
    if (s.reject) return reply({ success: false, message: 'Forbidden' }, 403);
    if (u.startsWith('/api/account/login')) return reply(s.login ? s.login(body) : { success: false, message: 'x' });
    if (u.startsWith('/api/account/logout')) return reply({ success: true, data: stateOf('unconfigured') });
    if (u.startsWith('/api/account/reset')) return reply({ success: true, data: { cleared: [] } });
    if (u === '/api/account/saved' && method === 'GET') return reply({ success: true, data: { accounts: s.saved || [] } });
    if (u.startsWith('/api/account/saved/') && method === 'DELETE') return reply(s.removeResult || { success: true });
    if (u === '/api/account/switch') return reply(s.switchResp ? s.switchResp(body) : { success: false, message: 'x', data: {} });
    if (u.startsWith('/api/account')) return reply({ success: true, data: s.state });
    if (['/api/executions/sync', '/api/zentao/users/refresh', '/api/zentao/sync'].includes(u)) return reply({ success: true });
    return reply({ success: false, message: 'not mocked' }, 404);
  };
  win.Toast = { success: (m) => s.toasts.push(m), error: (m) => s.toasts.push(m), info: (m) => s.toasts.push(m), warning: () => {} };
  win.Confirm = { show: async (t, m) => { s.confirms.push(m); return s.confirmAnswer !== false; } };
  win.openSettingsModal = (g) => { s.settingsOpened = g || 'default'; };
  win.eval(`var API_BASE_URL = 'http://127.0.0.1:3721';\n${REP}\n${ACC.replace(/if \(typeof document !== 'undefined'\) \{[\s\S]*?\n\}\n?$/, '')}\nwindow.Account = Account; Account.reload = () => { window.__s.reloads++; }; Account.connectRetryMs = 5;`);
  win.__s = s;
  return { win, doc: win.document, $: (id) => win.document.getElementById(id) };
}

(async () => {
  // ============ 第一次使用 ============
  let s = { state: stateOf('unconfigured') };
  let { win, doc, $ } = setup(s);
  check('读取账号时：右上角显示加载提示，头像、「登录禅道」、设置图标都不显示',
    !$('accountLoading').hidden && /正在读取禅道账号/.test($('accountLoading').textContent) && $('accountAvatarBtn').hidden && $('accountLoginBtn').hidden && $('accountSettingsBtn').hidden);
  await win.Account.init();
  check('读取完成：加载提示消失', $('accountLoading').hidden);
  let overlay = $('loginOverlay');
  check('第一次使用：弹出登录卡片（地址、账号、密码、登录、导入配置、稍后再说）',
    overlay && /登录禅道/.test(overlay.querySelector('h2').textContent) && overlay.querySelectorAll('.login-form input').length === 3 &&
    overlay.querySelector('[data-login="import"]') && /稍后再说/.test(overlay.querySelector('[data-login="skip"]').textContent));
  check('未登录：右上角显示「登录禅道」和设置图标，不显示头像', !$('accountLoginBtn').hidden && !$('accountSettingsBtn').hidden && $('accountAvatarBtn').hidden);
  win.openSettingsModal = (g) => { s.settingsOpened = g || 'default'; };
  $('accountSettingsBtn').click();
  check('未登录：点设置图标打开设置', s.settingsOpened === 'default');

  overlay.querySelector('.login-submit').click();
  await tick(10);
  check('漏填：提示并聚焦，不发请求', /请填写禅道地址/.test(overlay.querySelector('.login-error').textContent) && !s.requests.some(r => r.url === '/api/account/login'));

  overlay.querySelector('[data-login="skip"]').click();
  check('稍后再说：关闭卡片，进入本地模式（记住选择）', !$('loginOverlay') && win.localStorage.getItem('waLoginSkipped') === '1' && win.Account.isLocalMode());
  ({ win, doc, $ } = setup(s));
  win.localStorage.setItem('waLoginSkipped', '1');
  await win.Account.init();
  check('本地模式：再打开不再弹卡片', !$('loginOverlay'));
  $('accountLoginBtn').click();
  check('本地模式：点「登录禅道」打开卡片（可取消）', $('loginOverlay') && $('loginOverlay').querySelector('[data-login="cancel"]'));
  $('loginOverlay').querySelector('[data-login="cancel"]').click();

  // 本地模式下的报告页
  win.ReportPage.show();
  check('本地模式：报告页提示数据来自禅道，给出登录入口', /报告数据来自禅道/.test($('reportMode').textContent) && $('reportMode').querySelector('[data-report-login]'));
  $('reportMode').querySelector('[data-report-login]').click();
  check('本地模式：报告页的登录按钮打开登录卡片', !!$('loginOverlay'));
  $('loginOverlay').remove();

  // ============ 登录 ============
  s = { state: stateOf('unconfigured') };
  ({ win, doc, $ } = setup(s));
  await win.Account.init();
  overlay = $('loginOverlay');
  const fill = (url, user, pw) => {
    overlay.querySelector('[name="url"]').value = url;
    overlay.querySelector('[name="username"]').value = user;
    overlay.querySelector('[name="password"]').value = pw;
  };
  s.login = () => ({ success: false, message: '登录失败，请检查您的用户名或密码是否填写正确。', data: { ok: false, error: { kind: 'credentials' } } });
  fill('10.0.0.1:8088', 'zhangs', 'bad');
  overlay.querySelector('.login-submit').click();
  await tick(20);
  check('账号密码错误：显示禅道的原因，聚焦密码框', /用户名或密码/.test(overlay.querySelector('.login-error').textContent) && doc.activeElement === overlay.querySelector('[name="password"]'));
  const sent = s.requests.find(r => r.url === '/api/account/login');
  check('登录请求带上填写的地址、账号、密码', sent.body.url === '10.0.0.1:8088' && sent.body.username === 'zhangs' && sent.body.password === 'bad' && sent.body.confirmSwitch === false);

  s.login = () => ({ success: false, message: '该地址不是禅道', data: { ok: false, error: { kind: 'not_zentao' } } });
  overlay.querySelector('.login-submit').click();
  await tick(20);
  check('地址不是禅道：聚焦地址框', doc.activeElement === overlay.querySelector('[name="url"]'));

  // 换账号：先确认
  s.login = (b) => (b.confirmSwitch
    ? { success: true, data: { ok: true, switched: true, state: stateOf('ok', { aiConfigured: false, profile: { ...profile, account: 'lisi', realname: '李四' }, username: 'lisi' }) } }
    : { success: false, data: { ok: false, needConfirm: true, previous: { account: 'zhangs', realname: '张三' } } });
  fill('http://10.0.0.1:8088', 'lisi', 'pw');
  overlay.querySelector('.login-submit').click();
  await tick(50);
  check('换成别的账号：先确认（写明本地数据属于谁、会清空）', /张三（zhangs）/.test(s.confirms[0]) && /清空本地任务/.test(s.confirms[0]));
  const logins = s.requests.filter(r => r.url === '/api/account/login');
  check('确认后带 confirmSwitch 重新登录', logins[logins.length - 1].body.confirmSwitch === true);
  await tick(50);
  const steps = s.requests.filter(r => ['/api/executions/sync', '/api/zentao/users/refresh', '/api/zentao/sync'].includes(r.url)).map(r => r.url);
  check('登录成功：欢迎语，依次同步执行、团队成员、我的任务', /欢迎，李四/.test(overlay.textContent) && steps.join() === '/api/executions/sync,/api/zentao/users/refresh,/api/zentao/sync', steps.join());
  await tick(700);
  check('同步完成后刷新页面；AI 未配置时记下要提示', s.reloads === 1 && win.localStorage.getItem('waAiHintPending') === '1' && !win.localStorage.getItem('waLoginSkipped'));

  // ============ 已登录 ============
  s = { state: stateOf('ok', { aiConfigured: false }) };
  ({ win, doc, $ } = setup(s));
  win.localStorage.setItem('waAiHintPending', '1');
  await win.Account.init();
  const avatar = $('accountAvatarBtn');
  check('已登录：右上角是头像（姓名首字 + 绿点），设置按钮收进菜单', !avatar.hidden && avatar.textContent.trim() === '张' && avatar.querySelector('.account-dot.is-ok') && !$('settingsBtn') && $('accountSettingsBtn').hidden && $('accountLoginBtn').hidden && !$('loginOverlay'));
  check('登录后第一次打开：提示 AI 未配置（只提示一次）', doc.querySelector('.account-hint') && /AI 未配置/.test(doc.querySelector('.account-hint').textContent) && !win.localStorage.getItem('waAiHintPending'));
  doc.querySelector('.account-hint .ah-go').click();
  check('AI 提示「去配置」打开设置的 AI 分组', s.settingsOpened === 'p-ai' && !doc.querySelector('.account-hint'));
  avatar.click();
  await tick(10);
  const menu = doc.querySelector('.account-menu');
  check('点头像：用户信息（姓名、账号、角色、部门、禅道地址、连接状态）', menu && /张三/.test(menu.textContent) && /zhangs · 测试 · 产研部/.test(menu.textContent) && /http:\/\/10\.0\.0\.1:8088/.test(menu.textContent) && /已连接/.test(menu.textContent));
  check('菜单操作：设置、切换账号、退出登录', ['settings', 'switch', 'logout'].every(a => menu.querySelector(`[data-am="${a}"]`)));
  check('设置页「登录账号」显示当前账号', /张三（zhangs）/.test($('settingsAccountText').textContent) && /切换账号/.test($('settingsSwitchAccountBtn').textContent));
  menu.querySelector('[data-am="settings"]').click();
  check('菜单「设置」打开设置弹窗', s.settingsOpened === 'default' && !doc.querySelector('.account-menu'));
  avatar.click();
  await tick(10);
  doc.querySelector('.account-menu [data-am="switch"]').click();
  overlay = $('loginOverlay');
  check('切换账号：登录卡片预填地址、账号留空，可取消', /切换账号/.test(overlay.querySelector('h2').textContent) && overlay.querySelector('[name="url"]').value === 'http://10.0.0.1:8088' && !overlay.querySelector('[name="username"]').value && overlay.querySelector('[data-login="cancel"]'));
  overlay.querySelector('[data-login="cancel"]').click();
  avatar.click();
  await tick(10);
  doc.querySelector('.account-menu [data-am="logout"]').click();
  await tick(20);
  check('退出登录：确认后请求退出并刷新', /重新输入禅道密码/.test(s.confirms.pop()) && s.requests.some(r => r.url === '/api/account/logout') && s.reloads === 1);

  // ============ 已保存的账号：快速切换 ============
  const saved = (over = []) => [
    { id: 'cur', url: 'http://10.0.0.1:8088', username: 'zhangs', realname: '张三', version: '22.3', current: true, hasPassword: true },
    { id: 'a2', url: 'http://10.128.1.8:8088', username: 'lisi', realname: '李四', version: '18.3', current: false, hasPassword: true },
    { id: 'a3', url: 'http://10.0.0.1:8088', username: 'wangw', realname: '王五', version: '22.3', current: false, hasPassword: true },
    ...over
  ];
  s = { state: stateOf('ok'), saved: saved() };
  ({ win, doc, $ } = setup(s));
  await win.Account.init();
  $('accountAvatarBtn').click();
  await tick(60);
  let menu2 = doc.querySelector('.account-menu');
  let rows = [...menu2.querySelectorAll('[data-am-switch]')];
  check('菜单：列出其他已保存的账号（不含当前），按服务端给的顺序', rows.length === 2 && rows[0].dataset.amSwitch === 'a2' && rows[1].dataset.amSwitch === 'a3' && !menu2.querySelector('[data-am-switch="cur"]'));
  check('菜单：每个账号显示姓名、账号 · 禅道主机 · 版本', /李四/.test(rows[0].textContent) && /lisi · 10\.128\.1\.8:8088 · 禅道 18\.3/.test(rows[0].textContent), rows[0].textContent);
  check('菜单：「切换账号」改名「添加账号」', /添加账号/.test(menu2.querySelector('[data-am="switch"]').textContent));
  menu2.querySelector('[data-am="switch"]').click();
  check('添加账号：打开登录卡片，顶部列出已保存的账号（可点的只有其他账号）', (await tick(60), true) && !!$('loginOverlay').querySelector('.login-saved-row[data-login-switch="a2"]') && !$('loginOverlay').querySelector('[data-login-switch="cur"]'));
  const curRow = $('loginOverlay').querySelector('.login-saved-row.is-current');
  check('切换账号页面：当前账号也列出来，标「当前」且不能点', curRow && /张三/.test(curRow.textContent) && /当前/.test(curRow.textContent) && curRow.tagName !== 'BUTTON' && !curRow.dataset.loginSwitch);
  check('切换账号页面：有其他账号时没有「还没有其他账号」的说明', !/还没有其他账号/.test($('loginOverlay').textContent));
  $('loginOverlay').remove();
  // 只有当前账号：不是一片空白，说明登录过的账号会保存在这里
  s.saved = [saved()[0]];
  $('accountAvatarBtn').click();
  await tick(60);
  doc.querySelector('.account-menu [data-am="switch"]').click();
  await tick(60);
  check('只有当前账号时：切换账号页面显示当前账号和一句说明（登录过的账号会自动保存在这里）', !!$('loginOverlay').querySelector('.login-saved-row.is-current') && /还没有其他账号/.test($('loginOverlay').textContent) && /自动保存/.test($('loginOverlay').textContent));
  $('loginOverlay').remove();
  s.saved = saved();

  // 没有其他账号：不显示切换分组
  s.saved = [saved()[0]];
  $('accountAvatarBtn').click();
  await tick(60);
  check('只有当前账号：菜单没有「切换账号」分组，只有添加账号', !doc.querySelector('.account-menu .am-accounts') && !!doc.querySelector('.account-menu [data-am="switch"]'));
  doc.querySelector('.account-menu').remove(); win.Account.menuOpen = false;

  // 点击切换：成功 → 进度 → 刷新
  s.saved = saved();
  s.switchResp = () => ({ success: true, data: { ok: true, switched: true, state: stateOf('ok', { username: 'lisi' }) } });
  $('accountAvatarBtn').click();
  await tick(60);
  doc.querySelector('.account-menu [data-am-switch="a2"]').click();
  await tick(90);
  const swReq = s.requests.filter(r => r.url === '/api/account/switch').pop();
  check('点账号：用保存的账号请求切换（不带确认）', swReq && swReq.body.id === 'a2' && swReq.body.confirmSwitch === false);
  check('切换成功：显示同步进度并依次同步执行、团队、任务', $('loginOverlay') && /欢迎/.test($('loginOverlay').textContent) && ['/api/executions/sync', '/api/zentao/users/refresh', '/api/zentao/sync'].every(u => s.requests.some(r => r.url === u)));
  await tick(2700);
  check('切换成功：刷新页面', s.reloads === 1);

  // 有只存在本机的内容：先确认，条数写清楚
  s = { state: stateOf('ok'), saved: saved(), confirmAnswer: false };
  s.switchResp = (b) => (b.confirmSwitch ? { success: true, data: { ok: true, switched: true, state: stateOf('ok') } }
    : { success: false, data: { ok: false, needConfirm: true, unsynced: 3, previous: { account: 'zhangs', realname: '张三', url: 'http://10.0.0.1:8088' } } });
  ({ win, doc, $ } = setup(s));
  await win.Account.init();
  $('accountAvatarBtn').click();
  await tick(60);
  doc.querySelector('.account-menu [data-am-switch="a3"]').click();
  await tick(90);
  check('有未同步内容：弹确认，写明条数和会备份', s.confirms.length === 1 && /3 条只存在本机/.test(s.confirms[0]) && /备份/.test(s.confirms[0]));
  check('取消确认：不再请求，什么都没切', s.requests.filter(r => r.url === '/api/account/switch').length === 1 && s.reloads === 0 && !$('loginOverlay'));
  s.confirmAnswer = true;
  $('accountAvatarBtn').click();
  await tick(60);
  doc.querySelector('.account-menu [data-am-switch="a3"]').click();
  await tick(120);
  const sw2 = s.requests.filter(r => r.url === '/api/account/switch');
  check('确认后：带 confirmSwitch 再请求一次并切换', sw2.length === 3 && sw2[2].body.confirmSwitch === true && !!$('loginOverlay'));
  await tick(2700);

  // 保存的密码失效：只输密码
  s = { state: stateOf('ok'), saved: saved() };
  s.switchResp = () => ({ success: false, message: '登录失败，请检查您的用户名或密码是否填写正确。', data: { ok: false, error: { kind: 'credentials' } } });
  ({ win, doc, $ } = setup(s));
  await win.Account.init();
  $('accountAvatarBtn').click();
  await tick(60);
  doc.querySelector('.account-menu [data-am-switch="a2"]').click();
  await tick(180);
  overlay = $('loginOverlay');
  check('保存的密码失效：打开只输密码的卡片，地址、账号已填好且只读', overlay && /登录已失效/.test(overlay.querySelector('h2').textContent) && overlay.querySelector('[name="url"]').value === 'http://10.128.1.8:8088' && overlay.querySelector('[name="url"]').readOnly && overlay.querySelector('[name="username"]').value === 'lisi' && overlay.querySelector('[name="username"]').readOnly);
  check('保存的密码失效：说明原因，且不显示已保存账号列表', /李四 保存的密码已失效/.test(overlay.querySelector('.login-notice').textContent) && overlay.querySelector('.login-saved').hidden);
  check('保存的密码失效：当前账号没被动', !s.requests.some(r => r.url === '/api/account/logout') && s.reloads === 0);
  overlay.remove();

  // 连不上
  s = { state: stateOf('ok'), saved: saved() };
  s.switchResp = () => ({ success: false, message: '无法连接 10.128.1.8:8088，请检查网络 / VPN', data: { ok: false, error: { kind: 'offline' } } });
  ({ win, doc, $ } = setup(s));
  await win.Account.init();
  $('accountAvatarBtn').click();
  await tick(60);
  doc.querySelector('.account-menu [data-am-switch="a2"]').click();
  await tick(120);
  check('连不上：提示原因，不弹卡片、不刷新（当前账号不变）', s.toasts.some(t => /无法连接/.test(t)) && !$('loginOverlay') && s.reloads === 0);

  // 移除
  s = { state: stateOf('ok'), saved: saved(), confirmAnswer: false };
  ({ win, doc, $ } = setup(s));
  await win.Account.init();
  $('accountAvatarBtn').click();
  await tick(60);
  doc.querySelector('.account-menu [data-am-remove="a2"]').click();
  await tick(90);
  check('移除：先确认（写明账号，说明会删除保存的密码）', /李四/.test(s.confirms[0] || '') && /密码/.test(s.confirms[0] || ''));
  check('移除：取消则不请求；点 × 不会同时触发切换', !s.requests.some(r => r.method === 'DELETE') && !s.requests.some(r => r.url === '/api/account/switch'));
  s.confirmAnswer = true;
  $('accountAvatarBtn').click();
  await tick(60);
  doc.querySelector('.account-menu [data-am-remove="a2"]').click();
  await tick(90);
  check('移除：确认后请求删除并提示', s.requests.some(r => r.method === 'DELETE' && r.url === '/api/account/saved/a2') && s.toasts.some(t => /已移除/.test(t)));

  // 退出后 / 未登录：登录卡片里的快速登录
  s = { state: stateOf('unconfigured', { keepUrl: true, username: 'zhangs' }), saved: [{ ...saved()[0], current: false }, saved()[1]] };
  s.switchResp = () => ({ success: true, data: { ok: true, state: stateOf('ok') } });
  ({ win, doc, $ } = setup(s));
  await win.Account.init();
  await tick(120);
  overlay = $('loginOverlay');
  const qrows = overlay ? [...overlay.querySelectorAll('.login-saved-row')] : [];
  check('退出后的登录卡片：顶部列出所有已保存的账号，可一键登录', qrows.length === 2 && !overlay.querySelector('.login-saved').hidden);
  qrows[1].click();
  await tick(120);
  check('点已保存的账号：直接用保存的密码登录', s.requests.some(r => r.url === '/api/account/switch' && r.body.id === 'a2'));
  await tick(2700);

  // ============ 登录失效 / 连不上 ============
  s = { state: stateOf('invalid', { message: '登录失败，请检查您的用户名或密码是否填写正确。' }) };
  ({ win, doc, $ } = setup(s));
  await win.Account.init();
  await tick(80);
  overlay = $('loginOverlay');
  check('登录失效：头像红点，弹「只需输入密码」的卡片（地址、账号只读，写明原因）',
    $('accountAvatarBtn').querySelector('.account-dot.is-invalid') && /登录已失效/.test(overlay.querySelector('h2').textContent) &&
    overlay.querySelector('[name="url"]').readOnly && overlay.querySelector('[name="username"]').readOnly && /用户名或密码/.test(overlay.querySelector('.login-notice').textContent) &&
    doc.activeElement === overlay.querySelector('[name="password"]'));
  s = { state: stateOf('offline', { message: '无法连接禅道 http://10.0.0.1:8088（网络不可达）' }) };
  ({ win, doc, $ } = setup(s));
  await win.Account.init();
  check('连不上：灰点，不弹登录卡片，提示里写原因', $('accountAvatarBtn').querySelector('.account-dot.is-offline') && !$('loginOverlay') && /无法连接禅道/.test($('accountAvatarBtn').title));

  // 退出后：卡片写明本地数据属于谁
  s = { state: stateOf('unconfigured', { keepUrl: true, dataOwner: 'zhangs', dataOwnerName: '张三' }) };
  ({ win, doc, $ } = setup(s));
  await win.Account.init();
  overlay = $('loginOverlay');
  check('退出后再登录：预填地址与账号，写明本地数据属于谁', overlay.querySelector('[name="username"]').value === 'zhangs' && /本地数据属于 张三（zhangs）/.test(overlay.querySelector('.login-notice').textContent));

  // ============ 重置 ============
  s = { state: stateOf('ok') };
  ({ win, doc, $ } = setup(s));
  await win.Account.init();
  ['waSettingsCache', 'taskDraft', 'lastTabMode', 'waLoginSkipped'].forEach(k => win.localStorage.setItem(k, 'x'));
  win.localStorage.setItem('debugMode', 'true');
  check('重置入口只在调试模式显示', $('resetZone').classList.contains('debug-only'));
  $('resetAllBtn').click();
  const dlg = $('resetDialog');
  const go = dlg.querySelector('[data-reset="go"]');
  check('重置：列出清空内容，提供「先导出配置」，默认不清本地数据', /禅道地址/.test(dlg.textContent) && dlg.querySelector('[data-reset="export"]') && !dlg.querySelector('[data-reset="data"]').checked);
  check('重置：没输入「重置」时不能确认', go.disabled);
  const word = dlg.querySelector('[data-reset="word"]');
  word.value = '重置';
  word.dispatchEvent(new win.Event('input'));
  dlg.querySelector('[data-reset="data"]').checked = true;
  go.click();
  await tick(20);
  const reset = s.requests.find(r => r.url === '/api/account/reset');
  check('重置：带上「同时清空本地数据」并刷新', reset && reset.body.includeData === true && s.reloads === 1);
  check('重置：清掉浏览器里的设置与草稿，保留调试模式', ['waSettingsCache', 'taskDraft', 'lastTabMode', 'waLoginSkipped'].every(k => win.localStorage.getItem(k) === null) && win.localStorage.getItem('debugMode') === 'true');

  // ============ 首次安装：后台还在启动 ============
  s = { state: stateOf('unconfigured'), down: 3 };
  ({ win, doc, $ } = setup(s));
  const initing = win.Account.init();
  await tick(8);
  check('后台还在启动：右上角提示「正在连接本地后台服务」，先不报错', !$('accountLoading').hidden && /正在连接本地后台服务/.test($('accountLoading').textContent) && !$('backendNotice'));
  await initing;
  check('后台起来后：照常弹出登录卡片（本地没有禅道配置）', $('loginOverlay') && /登录禅道/.test($('loginOverlay').querySelector('h2').textContent) && !$('backendNotice') && $('accountLoading').hidden);

  // ============ 连不上后台 / 后台太旧 ============
  s = { state: stateOf('unconfigured'), down: true };
  ({ win, doc, $ } = setup(s));
  await win.Account.init();
  let notice = $('backendNotice');
  check('连不上后台：明确提示并给出安装命令，不弹登录卡片', notice && /连不上本地后台服务/.test(notice.textContent) && /releases\/latest\/download\/install\.sh/.test(notice.querySelector('.bn-cmd').textContent) && !$('loginOverlay'));
  check('连不上后台：加载提示不会一直转', $('accountLoading').hidden);
  s.down = false;
  notice.querySelector('[data-bn="retry"]').click();
  await tick(20);
  check('后台恢复后点重试：刷新页面', s.reloads === 1);
  s = { state: stateOf('unconfigured'), reject: true };
  ({ win, doc, $ } = setup(s));
  await win.Account.init();
  notice = $('backendNotice');
  check('后台不认这个插件（403，多半是旧后台还在跑）：提示后台版本过旧、重新运行安装命令', notice && /后台服务版本过旧/.test(notice.textContent) && /重新运行安装命令/.test(notice.textContent));

  // ============ 不用浏览器原生弹框 ============
  const native = [];
  for (const f of fs.readdirSync(EXT).filter(n => /\.(js|html)$/.test(n))) {
    fs.readFileSync(path.join(EXT, f), 'utf8').split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');
      if (/(^|[^.\w])(window\.)?(alert|confirm|prompt)\s*\(/.test(code) && !/async confirm\(|this\.confirm\(/.test(code)) native.push(`${f}:${i + 1}`);
    });
  }
  check('扩展里不再用浏览器原生 alert / confirm / prompt（统一用插件的确认框与提示）', native.length === 0, native.join(', '));

  for (const x of results) console.log(`  ${x.pass ? '✓' : '✗'} ${x.name}${x.pass || !x.extra ? '' : `   → ${x.extra}`}`);
  const passed = results.filter(x => x.pass).length;
  console.log(`\n${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
