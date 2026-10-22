/**
 * 真函数测试：自动更新（前端，设置 → 关于）
 *   - 各状态的文字与按钮：已是最新 / 已下载好（显示「立即更新」）/ 需要重新运行安装命令 / 开发版 / 连不上后台
 *   - 检查更新、自动更新开关发出的请求
 *   - 立即更新：等后台换成新版本后通知 background 重新加载扩展
 *   - 页面上的操作记进 chrome.storage.session（扩展重新加载前据此判断是否空闲）
 *
 * jsdom 加载真实 newtab.html，原样执行 update-ui.js；网络与 chrome API 换成模拟。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const EXT = path.join(__dirname, '..', 'extension');
const SRC = fs.readFileSync(path.join(EXT, 'update-ui.js'), 'utf8');
const HTML = fs.readFileSync(path.join(EXT, 'newtab.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

const statusOf = (over = {}) => ({
  installed: true, current: '1.2.0', auto: true, lastCheck: '2026-10-22T08:30:00.000Z', lastUpdate: null,
  state: 'idle', latest: '1.2.0', readyVersion: '', error: '', ...over
});

function setup(s) {
  const dom = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  s.requests = [];
  s.messages = [];
  s.session = {};
  win.fetch = async (url, init = {}) => {
    const u = String(url).replace('http://127.0.0.1:3721', '');
    const method = (init.method || 'GET').toUpperCase();
    s.requests.push({ method, url: u, body: init.body ? JSON.parse(init.body) : null });
    const reply = (b) => ({ ok: true, status: 200, json: async () => b });
    if (s.down) throw new TypeError('Failed to fetch');
    if (u === '/health') return reply({ app: 'workassistant', version: s.healthVersion || s.status.current });
    if (u === '/api/update/status') return reply({ success: true, data: s.status });
    if (u === '/api/admin/about') return reply({ success: true, data: s.about || { version: '1.2.0', installed: true, platform: 'darwin', node: '22.20.0', installDir: '/Users/x/Library/Application Support/WorkAssistant', dataDir: '/Users/x/Library/Application Support/WorkAssistant/data', logFile: '/Users/x/Library/Logs/WorkAssistant/backend.log', extensionDir: '/Users/x/Library/Application Support/WorkAssistant/extension', port: 3721 } });
    if (u === '/api/update/check') return reply({ success: true, data: s.afterCheck || s.status });
    if (u === '/api/update/settings') { s.status = { ...s.status, auto: JSON.parse(init.body).auto }; return reply({ success: true, data: s.status }); }
    if (u === '/api/update/apply') return reply({ success: true, data: { ...s.status, state: 'restarting' } });
    return reply({ success: false });
  };
  win.chrome = {
    runtime: { sendMessage: (m) => { s.messages.push(m); return Promise.resolve({}); } },
    storage: { session: { set: (o) => { Object.assign(s.session, o); return Promise.resolve(); } } }
  };
  win.eval(`var API_BASE_URL = 'http://127.0.0.1:3721';\n${SRC}\nwindow.UpdateUI = UpdateUI;`);
  return { win, doc: win.document, $: (id) => win.document.getElementById(id) };
}

(async () => {
  // 已是最新
  let s = { status: statusOf() };
  let { win, $ } = setup(s);
  await tick(10);
  check('打开页面：让 background 看一下扩展文件是否已更新', s.messages.some(m => m.action === 'checkSelfUpdate'));
  check('已是最新：显示版本和检查时间，不显示「立即更新」', /v1\.2\.0 已是最新版本/.test($('updateStatusText').textContent) && /检查过/.test($('updateStatusText').textContent) && $('updateApplyBtn').hidden && $('updateAutoToggle').checked);

  const paths = [...win.document.querySelectorAll('.about-path')].map(e => `${e.querySelector('.ap-k').textContent}=${e.querySelector('.ap-v').textContent}`);
  check('关于：显示程序、扩展、数据、日志的位置', paths.length === 4 && /^程序=.*WorkAssistant$/.test(paths[0]) && /^扩展目录=.*extension$/.test(paths[1]) && /^数据=/.test(paths[2]) && /^日志=.*backend\.log$/.test(paths[3]), paths.join(' | '));
  Object.defineProperty(win.navigator, 'clipboard', { value: { writeText: async (t) => { s.copied = t; } }, configurable: true });
  win.document.querySelectorAll('.about-path .ap-copy')[1].click();
  await tick(10);
  check('关于：路径一键复制', s.copied === '/Users/x/Library/Application Support/WorkAssistant/extension');

  // 刚自动更新过
  s.status = statusOf({ lastUpdate: { from: '1.1.3', to: '1.2.0', at: '2026-10-22T02:00:00.000Z' } });
  await win.UpdateUI.load();
  check('刚自动更新过：说明从哪个版本更新来', /从 1\.1\.3 自动更新/.test($('updateStatusText').textContent));

  // 检查更新 → 已下载好
  s.afterCheck = statusOf({ state: 'ready', latest: '1.3.0', readyVersion: '1.3.0' });
  $('updateCheckBtn').click();
  await tick(10);
  check('检查更新：发请求，新版本已下载好时显示「立即更新」', s.requests.some(r => r.url === '/api/update/check' && r.method === 'POST') && !$('updateApplyBtn').hidden && /1\.3\.0 已下载好/.test($('updateStatusText').textContent) && !$('updateCheckBtn').disabled);

  // 自动更新开关
  $('updateAutoToggle').checked = false;
  $('updateAutoToggle').dispatchEvent(new win.Event('change'));
  await tick(10);
  const setReq = s.requests.find(r => r.url === '/api/update/settings');
  check('自动更新开关：关掉时发 auto=false', setReq && setReq.body.auto === false && $('updateAutoText').textContent === '关闭');

  // 立即更新
  s.status = statusOf({ state: 'ready', latest: '1.3.0', readyVersion: '1.3.0' });
  s.healthVersion = '1.3.0';
  s.messages.length = 0;
  s.session.waLastInteraction = Date.now();
  $('updateApplyBtn').click();
  await tick(1200);
  check('立即更新：后台换成新版本后通知 background 重新加载扩展（不用等空闲）', s.requests.some(r => r.url === '/api/update/apply') && s.messages.some(m => m.action === 'checkSelfUpdate') && s.session.waLastInteraction === 0);

  // 启动失败退回过
  s.status = statusOf({ current: '1.2.0', rolledBack: true, lastUpdate: { from: '1.2.0', to: '1.3.0', at: '2026-10-22T02:00:00.000Z' } });
  await win.UpdateUI.load();
  check('新版本启动失败已退回：说明', /1\.3\.0 安装后启动失败，已自动退回/.test($('updateStatusText').textContent));
  s.status = statusOf({ state: 'ready', latest: '1.3.0', readyVersion: '1.3.0', readyIsBad: true });
  await win.UpdateUI.load();
  check('失败过的版本又被下载：说明不会自动安装', /不会自动安装/.test($('updateStatusText').textContent) && !$('updateApplyBtn').hidden);

  // 需要重新运行安装命令
  s.status = statusOf({ state: 'needs-installer', latest: '2.0.0', error: '新版本 2.0.0 需要更新运行环境（Node 24.0.0），请重新运行一次安装命令' });
  await win.UpdateUI.load();
  check('需要更新运行环境：提示重新运行安装命令', /重新运行一次安装命令/.test($('updateStatusText').textContent) && $('updateApplyBtn').hidden);

  // 开发版
  ({ win, $ } = setup({ status: statusOf({ installed: false, state: 'dev', current: '1.2.0' }) }));
  await tick(10);
  check('开发版：说明不自动更新，按钮和开关不可用', /开发版/.test($('updateStatusText').textContent) && $('updateCheckBtn').disabled && $('updateAutoToggle').disabled);
  ({ win, $ } = setup({ status: statusOf({ installed: false, state: 'dev' }), about: { version: '1.2.0', installed: false, platform: 'darwin', node: '22.20.0', installDir: '/repo', dataDir: '/repo/data', logFile: '', extensionDir: '/repo/extension', port: 3721 } }));
  await tick(10);
  check('关于（开发版）：显示仓库目录，没有日志文件就不显示', [...win.document.querySelectorAll('#aboutInstall .about-path')].some(e => e.querySelector('.ap-k').textContent === '仓库（开发版）' && e.querySelector('.ap-v').textContent === '/repo') && win.document.querySelectorAll('#aboutData .about-path').length === 1);

  // 连不上后台
  ({ win, $ } = setup({ status: statusOf(), down: true }));
  await tick(10);
  check('连不上后台：说明原因', /连不上本地后台服务/.test($('updateStatusText').textContent) && /连不上本地后台服务/.test($('aboutInstall').textContent));

  // 页面操作记进 session
  s = { status: statusOf() };
  const env = setup(s);
  await tick(10);
  env.doc.body.dispatchEvent(new env.win.Event('pointerdown', { bubbles: true }));
  check('页面上的操作：记下时间（扩展重新加载前判断是否空闲）', s.session.waLastInteraction > Date.now() - 5000, JSON.stringify(s.session));

  let failed = 0;
  console.log('\n🔄 自动更新（设置 → 关于）');
  for (const r of results) {
    console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${!r.pass && r.extra ? `\n    ${r.extra}` : ''}`);
    if (!r.pass) failed++;
  }
  console.log(`\n${results.length - failed}/${results.length} 通过`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
