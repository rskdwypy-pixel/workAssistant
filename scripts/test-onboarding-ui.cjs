/**
 * 真函数测试：首次安装引导 + 更新说明（前端）
 *   - 全新安装：登录卡片带「第 1 步 / 共 4 步」；稍后再说 → 配置 AI → 报告与推送时间 → 节假日 → 完成，之后不再出现
 *   - AI：测试连接通过才能保存；改任何一项测试结果作废；失败有原因；以后再说直接下一步
 *   - 推送时间：非法值不发请求；后端拒绝时显示原因并留在这一步
 *   - 节假日：后端拒绝格式时显示原因；先不配置也能完成
 *   - 登录后页面刷新：进度从存储接上（已登录 → 直接第 2 步）；已配好 AI 的跳过 AI 步
 *   - 老用户（没记录）不引导；导入旧配置、重置、重新查看
 *   - 更新说明：版本升高才弹、每版一次、最多 3 个版本其余折叠、取不到内容不记版本、没写更新记录静默记版本
 * jsdom 加载真实 newtab.html，原样执行 onboarding.js / account.js；网络换成模拟。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const EXT = path.join(__dirname, '..', 'extension');
const ONB = fs.readFileSync(path.join(EXT, 'onboarding.js'), 'utf8');
const ACC = fs.readFileSync(path.join(EXT, 'account.js'), 'utf8');
const REP = fs.readFileSync(path.join(EXT, 'reports.js'), 'utf8');
const HTML = fs.readFileSync(path.join(EXT, 'newtab.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

const profile = { account: 'zhangs', realname: '张三', role: 'qa', roleLabel: '测试', dept: '产研部', email: 'z@x.com' };
const stateOf = (state, over = {}) => ({
  state, zentaoUrl: state === 'unconfigured' ? '' : 'http://10.0.0.1:8088', username: state === 'unconfigured' ? '' : 'zhangs',
  dataOwner: '', dataOwnerName: '', aiConfigured: false, profile: state === 'unconfigured' ? null : profile, message: '', ...over
});
const ver = (version, date, items) => ({ version, date, groups: [{ title: '修复', items }] });

/** storage：同一份 localStorage 模拟浏览器重开（页面刷新后记录还在） */
function setup(s, storage) {
  const dom = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  if (storage) for (const [k, v] of Object.entries(storage)) win.localStorage.setItem(k, v);
  s.requests = [];
  s.reloads = 0;
  s.toasts = [];
  win.fetch = async (url, init = {}) => {
    const u = String(url).replace('http://127.0.0.1:3721', '');
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    s.requests.push({ method, url: u, body });
    const reply = (b, status = 200) => ({ ok: status < 400, status, json: async () => b });
    if (u.startsWith('/api/account')) return reply({ success: true, data: s.state });
    if (u === '/api/ai/test') return reply(s.aiTest ? s.aiTest(body) : { success: true, message: '连接成功' });
    if (u === '/api/config' && method === 'POST') return reply(s.config ? s.config(body) : { success: true });
    if (u.startsWith('/api/changelog')) {
      if (s.changelogDown) throw new TypeError('Failed to fetch');
      return reply({ success: true, data: s.changelog || { current: s.version, versions: [] } });
    }
    return reply({ success: false, message: 'not mocked' }, 404);
  };
  win.Toast = { success: (m) => s.toasts.push(m), error: (m) => s.toasts.push(m), info: (m) => s.toasts.push(m), warning: () => {} };
  win.Confirm = { show: async () => true };
  win.openSettingsModal = (g) => { s.settingsOpened = g || 'default'; };
  win.eval(`var API_BASE_URL = 'http://127.0.0.1:3721'; var WA_EXT_VERSION = ${JSON.stringify(s.version)};
    var AI_PROVIDERS = { zhipu: { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4/', model: 'glm-4-flash', keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys' }, deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', keyUrl: 'https://platform.deepseek.com/api_keys' }, custom: { label: '自定义', baseUrl: '', model: '', keyUrl: null } };
    var ConfigStore = { async sync() {}, flat() { return window.__flat || {}; }, get() { return window.__snap || null; } };
    ${REP}\n${ONB}\n${ACC.replace(/if \(typeof document !== 'undefined'\) \{[\s\S]*?\n\}\n?$/, '')}\nwindow.Account = Account; Account.reload = () => { window.__s.reloads++; };`);
  win.__s = s;
  return { win, doc: win.document, $: (id) => win.document.getElementById(id), storage: () => ({ ...win.localStorage }) };
}
const obRec = (win) => JSON.parse(win.localStorage.getItem('waOnboarding') || 'null');
const bar = (doc) => (doc.querySelector('#obOverlay .ob-steps span, #loginOverlay .ob-steps span') || {}).textContent;
const type = (win, el, v) => { el.value = v; el.dispatchEvent(new win.Event('input', { bubbles: true })); };

(async () => {
  // ============ 全新安装：完整走一遍 ============
  let s = { state: stateOf('unconfigured'), version: '1.6.0' };
  let { win, doc, $ } = setup(s, { waOnboarding: JSON.stringify({ introDone: false, step: 'zentao', seenVersion: '1.6.0' }) });
  await win.Account.init();
  check('全新安装：弹登录卡片，顶部是「第 1 步 / 共 4 步」', $('loginOverlay') && bar(doc) === '第 1 步 / 共 4 步');
  check('第 1 步：不同时弹出别的引导卡片', !$('obOverlay'));
  $('loginOverlay').querySelector('[data-login="skip"]').click();
  await tick(10);
  check('稍后再说：进入第 2 步（AI），进度记下来了', $('obOverlay') && bar(doc) === '第 2 步 / 共 4 步' && /配置 AI/.test($('obOverlay').querySelector('h2').textContent) && obRec(win).step === 'ai');

  let ov = $('obOverlay');
  let form = ov.querySelector('form');
  check('AI：服务商有预设，接口地址和模型自动填好', form.elements.baseUrl.value === 'https://open.bigmodel.cn/api/paas/v4/' && form.elements.model.value === 'glm-4-flash' && !ov.querySelector('[data-ob="keyurl"]').hidden);
  check('AI：没测试通过前「保存并继续」不可点', ov.querySelector('[data-ob="save"]').disabled);
  ov.querySelector('[data-ob="test"]').click();
  await tick(10);
  check('AI：没填 Key 就测试 → 提示，不发请求', /API Key/.test(ov.querySelector('.login-error').textContent) && !s.requests.some(r => r.url === '/api/ai/test'));

  type(win, form.elements.apiKey, 'sk-bad');
  s.aiTest = () => ({ success: false, message: 'API Key 无效' });
  ov.querySelector('[data-ob="test"]').click();
  await tick(10);
  check('AI：测试失败显示原因，仍不能保存', /❌ API Key 无效/.test(ov.querySelector('.ob-test-result').textContent) && ov.querySelector('[data-ob="save"]').disabled);

  type(win, form.elements.apiKey, 'sk-good');
  s.aiTest = () => ({ success: true, message: '连接成功，约 3 秒' });
  ov.querySelector('[data-ob="test"]').click();
  await tick(10);
  const testReq = s.requests.filter(r => r.url === '/api/ai/test').pop();
  check('AI：测试请求带地址、Key、模型，按任务解析测', testReq.body.baseUrl === 'https://open.bigmodel.cn/api/paas/v4/' && testReq.body.apiKey === 'sk-good' && testReq.body.model === 'glm-4-flash' && testReq.body.purpose === 'task');
  check('AI：测试通过后可以保存', !ov.querySelector('[data-ob="save"]').disabled && /✅/.test(ov.querySelector('.ob-test-result').textContent));
  type(win, form.elements.model, 'glm-4');
  check('AI：改了任何一项，测试结果作废、需要重新测', ov.querySelector('[data-ob="save"]').disabled && ov.querySelector('.ob-test-result').textContent === '');
  ov.querySelector('[data-ob="test"]').click();
  await tick(10);
  form.dispatchEvent(new win.Event('submit', { cancelable: true }));
  await tick(20);
  const saveAi = s.requests.find(r => r.url === '/api/config' && r.body && r.body.apiKey);
  check('AI：保存把 Key、地址、模型、服务商存到后端', saveAi && saveAi.body.apiKey === 'sk-good' && saveAi.body.apiBaseUrl.startsWith('https://open.bigmodel') && saveAi.body.aiModel === 'glm-4' && saveAi.body.client.aiProvider === 'zhipu');
  check('AI 保存后：进入第 3 步（报告与推送时间）', bar(doc) === '第 3 步 / 共 4 步' && /报告与推送时间/.test($('obOverlay').querySelector('h2').textContent) && obRec(win).step === 'schedule');

  ov = $('obOverlay'); form = ov.querySelector('form');
  check('推送时间：默认 9 点 / 21 点', form.elements.morningHour.value === '9' && form.elements.eveningHour.value === '21');
  type(win, form.elements.eveningHour, '25');
  form.dispatchEvent(new win.Event('submit', { cancelable: true }));
  await tick(10);
  check('推送时间：25 点前端直接拦下，不发请求', /0~23/.test(ov.querySelector('.login-error').textContent) && !s.requests.some(r => r.body && r.body.morningHour));
  s.config = (b) => b.morningHour ? { success: false, message: '早间提醒时间应是 0~23 之间的整数' } : { success: true };
  type(win, form.elements.eveningHour, '20');
  form.dispatchEvent(new win.Event('submit', { cancelable: true }));
  await tick(20);
  check('推送时间：后端拒绝时显示原因，停在这一步', /早间提醒时间/.test($('obOverlay').querySelector('.login-error').textContent) && bar(doc) === '第 3 步 / 共 4 步');
  s.config = null;
  type(win, form.elements.morningHour, '8');
  form.dispatchEvent(new win.Event('submit', { cancelable: true }));
  await tick(20);
  const sch = s.requests.filter(r => r.url === '/api/config' && r.body && r.body.morningHour).pop();
  check('推送时间：保存 8 点 / 20 点', sch.body.morningHour === '8' && sch.body.eveningHour === '20');
  check('保存后：进入第 4 步（节假日）', bar(doc) === '第 4 步 / 共 4 步' && /节假日/.test($('obOverlay').querySelector('h2').textContent) && obRec(win).step === 'holidays');

  ov = $('obOverlay'); form = ov.querySelector('form');
  s.config = (b) => /abc/.test(b.workHolidays) ? { success: false, message: '节假日的格式不对：abc' } : { success: true };
  form.elements.holidays.value = 'abc';
  form.dispatchEvent(new win.Event('submit', { cancelable: true }));
  await tick(20);
  check('节假日：格式不对显示后端原因，停在这一步', /格式不对：abc/.test($('obOverlay').querySelector('.login-error').textContent) && !obRec(win).introDone);
  form.elements.holidays.value = '2026-10-01~2026-10-07, 2026-12-25';
  form.elements.makeup.value = '2026-10-10';
  form.dispatchEvent(new win.Event('submit', { cancelable: true }));
  await tick(20);
  const hol = s.requests.filter(r => r.url === '/api/config' && r.body && r.body.workHolidays).pop();
  check('节假日：保存节假日与调休日', hol.body.workHolidays === '2026-10-01~2026-10-07, 2026-12-25' && hol.body.workMakeup === '2026-10-10');
  check('完成：卡片关闭、记为已完成、给出提示', !$('obOverlay') && obRec(win).introDone === true && s.toasts.some(t => /重新查看新手引导/.test(t)));

  // 之后再打开不再出现
  ({ win, doc, $ } = setup(s, { waOnboarding: win.localStorage.getItem('waOnboarding'), waLoginSkipped: '1' }));
  s.state = stateOf('unconfigured');
  await win.Account.init();
  await tick(10);
  check('引导完成后再打开：不再显示任何引导', !$('obOverlay') && !win.Onboarding.active);

  // ============ 登录后页面刷新：进度接上 ============
  s = { state: stateOf('ok'), version: '1.6.0' };
  ({ win, doc, $ } = setup(s, { waOnboarding: JSON.stringify({ introDone: false, step: 'zentao', seenVersion: '1.6.0' }) }));
  await win.Account.init();
  await tick(10);
  check('登录成功刷新后：直接是第 2 步 AI，不再弹登录卡片', !$('loginOverlay') && bar(doc) === '第 2 步 / 共 4 步' && obRec(win).step === 'ai');
  check('引导中不重复弹「AI 未配置」小提示', !doc.querySelector('.account-hint'));

  s = { state: stateOf('ok', { aiConfigured: true }), version: '1.6.0' };
  ({ win, doc, $ } = setup(s, { waOnboarding: JSON.stringify({ introDone: false, step: 'ai', seenVersion: '1.6.0' }) }));
  await win.Account.init();
  await tick(10);
  check('AI 已经配好（自己去设置里配的 / 导入的）：跳过 AI 步，直接第 3 步', bar(doc) === '第 3 步 / 共 4 步' && obRec(win).step === 'schedule');

  // AI 步「以后再说」
  s = { state: stateOf('ok'), version: '1.6.0' };
  ({ win, doc, $ } = setup(s, { waOnboarding: JSON.stringify({ introDone: false, step: 'ai', seenVersion: '1.6.0' }) }));
  await win.Account.init();
  await tick(10);
  $('obOverlay').querySelector('[data-ob="skip"]').click();
  await tick(10);
  check('AI 以后再说：不发保存请求，进入第 3 步', bar(doc) === '第 3 步 / 共 4 步' && !s.requests.some(r => r.url === '/api/config'));
  $('obOverlay').querySelector('[data-ob="skip"]').click();
  await tick(10);
  check('推送时间使用默认：不发请求，进入第 4 步', bar(doc) === '第 4 步 / 共 4 步' && !s.requests.some(r => r.url === '/api/config'));
  $('obOverlay').querySelector('[data-ob="skip"]').click();
  await tick(10);
  check('节假日先不配置：直接完成', !$('obOverlay') && obRec(win).introDone === true);
  s.settingsOpened = '';

  // Esc 等同跳过
  s = { state: stateOf('ok'), version: '1.6.0' };
  ({ win, doc, $ } = setup(s, { waOnboarding: JSON.stringify({ introDone: false, step: 'schedule', seenVersion: '1.6.0' }) }));
  await win.Account.init();
  await tick(10);
  $('obOverlay').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await tick(10);
  check('按 Esc 等同跳过当前步', bar(doc) === '第 4 步 / 共 4 步');

  // ============ 老用户 / 导入 / 重置 / 重新查看 ============
  s = { state: stateOf('ok', { aiConfigured: true }), version: '1.6.0' };
  ({ win, doc, $ } = setup(s));
  await win.Account.init();
  await tick(10);
  check('老用户升级（没有记录、已登录）：不引导，静默记下版本', !$('obOverlay') && !$('loginOverlay') && obRec(win).introDone === true && obRec(win).seenVersion === '1.6.0' && !s.requests.some(r => r.url.startsWith('/api/changelog')));

  s = { state: stateOf('unconfigured'), version: '1.6.0' };
  ({ win, doc, $ } = setup(s));
  await win.Account.init();
  check('没有记录但没登录也没配 AI：当新用户引导', $('loginOverlay') && bar(doc) === '第 1 步 / 共 4 步' && obRec(win).introDone === false);

  $('loginOverlay').querySelector('[data-login="import"]').click();
  await tick(10);
  check('导入旧配置：引导结束，打开设置的数据迁移', !win.Onboarding.active && obRec(win).introDone === true && s.settingsOpened === 'p-data');

  // 重新查看：永远从第 1 步开始，每一步带出已有配置，可以回上一步
  s = { state: stateOf('ok', { aiConfigured: true }), version: '1.6.0' };
  ({ win, doc, $ } = setup(s, { waOnboarding: JSON.stringify({ introDone: true, seenVersion: '1.6.0' }) }));
  win.__flat = { apiBaseUrl: 'https://api.deepseek.com/v1', aiModel: 'deepseek-chat', aiProvider: 'deepseek', morningHour: '8', eveningHour: '20', workHolidays: '2026-12-25', workMakeup: '2026-10-10' };
  win.__snap = { ai: { apiKey: '***已设置***' } };
  await win.Account.init();
  $('obRestartBtn').click();
  await tick(20);
  check('设置里「重新查看」：已登录也从第 1 步开始，显示当前连接的地址和账号', bar(doc) === '第 1 步 / 共 4 步' && /已连接/.test($('obOverlay').textContent) && /10\.0\.0\.1:8088/.test($('obOverlay').textContent) && /zhangs/.test($('obOverlay').textContent) && obRec(win).step === 'zentao');
  check('第 1 步没有「上一步」', !$('obOverlay').querySelector('[data-ob="back"]'));
  $('obOverlay').querySelector('[data-ob="next"]').click();
  await tick(20);
  ov = $('obOverlay'); form = ov.querySelector('form');
  check('第 2 步（AI 已配置）：没有跳过，显示已有的服务商、地址、模型', bar(doc) === '第 2 步 / 共 4 步' && form.elements.provider.value === 'deepseek' && form.elements.baseUrl.value === 'https://api.deepseek.com/v1' && form.elements.model.value === 'deepseek-chat');
  check('第 2 步：Key 不回显，提示「已保存」；跳过按钮写「不修改，下一步」', form.elements.apiKey.value === '' && /已保存/.test(form.elements.apiKey.placeholder) && /不修改，下一步/.test(ov.querySelector('[data-ob="skip"]').textContent));
  check('第 2 步：原样保存可点；改了任何一项就要重新测试', !ov.querySelector('[data-ob="save"]').disabled && (type(win, form.elements.model, 'deepseek-reasoner'), ov.querySelector('[data-ob="save"]').disabled));
  ov.querySelector('[data-ob="test"]').click();
  await tick(10);
  const t2 = s.requests.filter(r => r.url === '/api/ai/test').pop();
  check('第 2 步：Key 留空也能测试（用已保存的），请求里 Key 为空', t2 && t2.body.apiKey === '' && t2.body.model === 'deepseek-reasoner' && !/请填写/.test(ov.querySelector('.login-error').textContent));
  ov.querySelector('[data-ob="back"]').click();
  await tick(20);
  check('第 2 步「上一步」：回到第 1 步', bar(doc) === '第 1 步 / 共 4 步' && /连接禅道/.test($('obOverlay').querySelector('h2').textContent) && obRec(win).step === 'zentao');
  $('obOverlay').querySelector('[data-ob="next"]').click();
  await tick(20);
  $('obOverlay').querySelector('[data-ob="skip"]').click();
  await tick(20);
  ov = $('obOverlay'); form = ov.querySelector('form');
  check('第 3 步：显示已有的 8 点 / 20 点，不是默认值', bar(doc) === '第 3 步 / 共 4 步' && form.elements.morningHour.value === '8' && form.elements.eveningHour.value === '20');
  ov.querySelector('[data-ob="back"]').click();
  await tick(20);
  check('第 3 步「上一步」：回到第 2 步，且仍是已有配置', bar(doc) === '第 2 步 / 共 4 步' && $('obOverlay').querySelector('form').elements.model.value === 'deepseek-chat');
  $('obOverlay').querySelector('[data-ob="skip"]').click();
  await tick(20);
  $('obOverlay').querySelector('[data-ob="skip"]').click();
  await tick(20);
  ov = $('obOverlay'); form = ov.querySelector('form');
  check('第 4 步：显示已有的节假日和调休日；「上一步」可用', bar(doc) === '第 4 步 / 共 4 步' && form.elements.holidays.value === '2026-12-25' && form.elements.makeup.value === '2026-10-10' && ov.querySelector('[data-ob="back"]'));
  s.requests.length = 0;
  ov.querySelector('[data-ob="skip"]').click();
  await tick(20);
  check('重新查看走完（全部「不修改」）：不发保存请求，引导结束，下次不再是重看状态', !$('obOverlay') && obRec(win).introDone === true && !obRec(win).review && !s.requests.some(r => r.url === '/api/config'));

  // 重新查看时未登录（本地模式）
  s = { state: stateOf('unconfigured'), version: '1.6.0' };
  ({ win, doc, $ } = setup(s, { waOnboarding: JSON.stringify({ introDone: true, seenVersion: '1.6.0' }), waLoginSkipped: '1' }));
  await win.Account.init();
  $('obRestartBtn').click();
  await tick(20);
  check('重新查看（本地模式）：第 1 步提示未登录，给「登录禅道」入口', bar(doc) === '第 1 步 / 共 4 步' && /本地模式/.test($('obOverlay').textContent) && /登录禅道/.test($('obOverlay').querySelector('[data-ob="login"]').textContent));
  $('obOverlay').querySelector('[data-ob="login"]').click();
  await tick(10);
  check('点「登录禅道」：打开登录卡片（带步骤条）', $('loginOverlay') && !$('obOverlay') && bar(doc) === '第 1 步 / 共 4 步');
  $('loginOverlay').querySelector('[data-login="cancel"]').click();
  await tick(10);
  check('登录卡片取消：回到引导第 1 步，不会什么都不剩', !$('loginOverlay') && $('obOverlay') && bar(doc) === '第 1 步 / 共 4 步');

  // 重置为首次使用
  await win.Onboarding.reset();
  check('重置：引导记录被清掉', obRec(win) === null && !win.Onboarding.active);

  // ============ 更新说明 ============
  const rec = (v, over = {}) => ({ waOnboarding: JSON.stringify({ introDone: true, seenVersion: v, ...over }) });

  s = { state: stateOf('ok', { aiConfigured: true }), version: '1.6.0', changelog: { current: '1.6.0', versions: [ver('1.6.0', '2026-10-25', ['**新增了引导**：说明'])] } };
  ({ win, doc, $ } = setup(s, rec('1.5.2')));
  await win.Account.init();
  await tick(20);
  const req = s.requests.find(r => r.url.startsWith('/api/changelog'));
  check('版本升高：向后端取 1.5.2 之后的更新内容', req && req.url === '/api/changelog?since=1.5.2');
  check('更新说明：标题带版本号，粗体渲染，不出现 ** 字符', $('obOverlay') && /已更新到 1\.6\.0/.test($('obOverlay').querySelector('h2').textContent) && $('obOverlay').querySelector('li b') && !/\*\*/.test($('obOverlay').textContent));
  check('更新说明：没点「知道了」前不记版本', obRec(win).seenVersion === '1.5.2');
  $('obOverlay').querySelector('[data-ob="close"]').click();
  await tick(10);
  check('点「知道了」：关闭并记下当前版本', !$('obOverlay') && obRec(win).seenVersion === '1.6.0');

  ({ win, doc, $ } = setup(s, rec('1.6.0')));
  await win.Account.init();
  await tick(20);
  check('同一版本再打开：不请求、不弹', !$('obOverlay') && !s.requests.some(r => r.url.startsWith('/api/changelog')));

  s.changelogDown = true;
  ({ win, doc, $ } = setup(s, rec('1.5.2')));
  await win.Account.init();
  await tick(20);
  check('取不到更新内容（后端不通）：不弹，也不记版本（下次再试）', !$('obOverlay') && obRec(win).seenVersion === '1.5.2');
  s.changelogDown = false;

  s.changelog = { current: '1.6.0', versions: [] };
  ({ win, doc, $ } = setup(s, rec('1.5.2')));
  await win.Account.init();
  await tick(20);
  check('这一版没写更新记录：不打扰，静默记下版本', !$('obOverlay') && obRec(win).seenVersion === '1.6.0');

  s.changelog = { current: '1.9.0', versions: ['1.9.0', '1.8.0', '1.7.0', '1.6.0', '1.5.5'].map(v => ver(v, '2026-10-2x', [`${v} 的改动`])) };
  s.version = '1.9.0';
  ({ win, doc, $ } = setup(s, rec('1.5.2')));
  await win.Account.init();
  await tick(20);
  const shown = [...$('obOverlay').querySelectorAll('.ob-ver h3')].map(h => h.firstChild.textContent);
  check('跨多个版本：最多展示 3 个，其余折叠', shown.join() === '1.9.0,1.8.0,1.7.0' && /还有 2 个更早的版本/.test($('obOverlay').textContent), shown.join());
  $('obOverlay').querySelector('[data-ob="all"]').click();
  await tick(20);
  check('「查看完整更新记录」：打开全部版本的列表', $('obOverlay') && $('obOverlay').querySelectorAll('.ob-ver').length === 5 && /更新记录/.test($('obOverlay').querySelector('h2').textContent));

  // 登录卡片在时，更新说明让位
  s = { state: stateOf('invalid', { aiConfigured: true }), version: '1.6.0', changelog: { current: '1.6.0', versions: [ver('1.6.0', 'd', ['x'])] } };
  ({ win, doc, $ } = setup(s, rec('1.5.2')));
  await win.Account.init();
  await tick(20);
  check('需要重新登录时：先登录，更新说明不叠上去，也不记版本', $('loginOverlay') && !$('obOverlay') && obRec(win).seenVersion === '1.5.2');

  // 设置里的更新记录入口
  s = { state: stateOf('ok', { aiConfigured: true }), version: '1.6.0', changelog: { current: '1.6.0', versions: [ver('1.6.0', 'd', ['全部里的一条'])] } };
  ({ win, doc, $ } = setup(s, rec('1.6.0')));
  await win.Account.init();
  $('obChangelogBtn').click();
  await tick(20);
  check('设置 → 更新记录：展示全部，不影响已看版本', $('obOverlay') && /全部里的一条/.test($('obOverlay').textContent) && obRec(win).seenVersion === '1.6.0');
  s.requests.length = 0;
  $('obOverlay').querySelector('[data-ob="close"]').click();
  check('更新记录：关闭后不改版本记录', !$('obOverlay') && obRec(win).seenVersion === '1.6.0');

  // 引导进行中不弹更新说明
  s = { state: stateOf('ok', { aiConfigured: true }), version: '1.6.0', changelog: { current: '1.6.0', versions: [ver('1.6.0', 'd', ['x'])] } };
  ({ win, doc, $ } = setup(s, { waOnboarding: JSON.stringify({ introDone: false, step: 'schedule', seenVersion: '1.5.2' }) }));
  await win.Account.init();
  await tick(20);
  check('引导进行中：只显示引导，不弹更新说明', bar(doc) === '第 3 步 / 共 4 步' && !s.requests.some(r => r.url.startsWith('/api/changelog')));

  const failed = results.filter(r => !r.pass);
  for (const r of results) console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${r.pass || !r.extra ? '' : `   → ${r.extra}`}`);
  console.log(`\n新手引导与更新说明（前端）：${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
