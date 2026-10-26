/**
 * 真函数测试：全局搜索（⌘K）前端
 * jsdom 加载真实 newtab.html，原样执行 quick-search.js；网络换成模拟。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const EXT = path.join(__dirname, '..', 'extension');
const SRC = fs.readFileSync(path.join(EXT, 'quick-search.js'), 'utf8');
const HTML = fs.readFileSync(path.join(EXT, 'newtab.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const it = (type, id, title, sub = '', local = true) => ({ type, id: String(id), title, sub, local });

function setup(s) {
  const dom = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  s.requests = []; s.opened = [];
  win.fetch = async (url) => {
    const u = String(url).replace('http://127.0.0.1:3721', '');
    s.requests.push(u);
    const q = decodeURIComponent((u.match(/q=([^&]*)/) || [])[1] || '');
    const scope = (u.match(/scope=(\w+)/) || [])[1];
    const reply = (b) => ({ ok: true, status: 200, json: async () => b });
    if (s.down) throw new TypeError('Failed to fetch');
    const data = (s[scope] && s[scope](q)) || {};
    if (s.delayRemote && scope === 'remote') await tick(s.delayRemote);
    return reply({ success: true, data: { tasks: [], bugs: [], stories: [], docs: [], ...data } });
  };
  win.openInZentao = (t, id) => s.opened.push([t, id]);
  win.eval(`var API_BASE_URL = 'http://127.0.0.1:3721';\n${SRC.replace(/if \(typeof document !== 'undefined'\) \{[\s\S]*?\n\}\n?$/, '')}\nwindow.QuickSearch = QuickSearch; QuickSearch.localMs = 5; QuickSearch.remoteMs = 20; QuickSearch.init();`);
  return { win, doc: win.document, $: (sel) => win.document.querySelector(sel) };
}
const type = async (win, text) => { const i = win.document.querySelector('.qs-input'); i.value = text; i.dispatchEvent(new win.Event('input')); };
const key = (win, k, extra = {}) => win.document.querySelector('.qs-input').dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, ...extra }));

(async () => {
  let s = {
    local: (q) => ({ tasks: [it('task', 2, '修复登录超时', '进行中')], bugs: [it('bug', 1, '登录页白屏', '已确认')], stories: [it('story', 50, '登录模块需求', '激活 · 真机拨测')], docs: [it('doc', 70, '登录设计文档', 'Markdown · lijc')] }),
    remote: (q) => ({ tasks: [it('task', 2, '修复登录超时', '', false), it('task', 901, '服务端的登录任务', '进行中 · 杨凯', false)], bugs: [it('bug', 801, '服务端 Bug', '激活', false)] })
  };
  let { win, doc, $ } = setup(s);
  check('右上角有放大镜按钮', !!$('#quickSearchBtn'));
  $('#quickSearchBtn').click();
  check('点放大镜：弹出搜索框，输入框已聚焦', !!$('.qs-overlay') && $('.qs-input') && /输入标题里的几个字/.test($('.qs-list').textContent));
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
  check('⌘K 再按一次：关闭', !$('.qs-overlay'));
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  check('Ctrl+K：打开', !!$('.qs-overlay'));
  key(win, 'Escape');
  check('Esc：关闭', !$('.qs-overlay'));
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: '/', bubbles: true }));
  check('在不输入文字的地方按 / 也能打开', !!$('.qs-overlay'));
  key(win, 'Escape');
  const ta = doc.createElement('textarea'); doc.body.appendChild(ta);
  ta.dispatchEvent(new win.KeyboardEvent('keydown', { key: '/', bubbles: true }));
  check('在文本框里打 / 不会呼出搜索', !$('.qs-overlay'));

  // 输入：先 local 再 remote
  $('#quickSearchBtn').click();
  await type(win, '登录');
  await tick(10);
  let groups = [...doc.querySelectorAll('.qs-group')].map(g => g.textContent);
  check('先出本地结果：任务 / Bug / 需求 / 文档四组都有', groups.join('|') === '📋 任务|🐞 Bug|📝 需求|📁 文档', groups.join('|'));
  check('每条显示标题、状态说明、编号；命中的关键词加粗', /修复<mark>登录<\/mark>超时/.test($('.qs-list').innerHTML) && /#2/.test($('.qs-list').textContent) && /进行中/.test($('.qs-list').textContent));
  check('此时还没有服务端结果', !/服务端的登录任务/.test($('.qs-list').textContent));
  await tick(40);
  check('随后补上禅道服务端的结果（任务 / Bug），同一个对象只留一条', /服务端的登录任务/.test($('.qs-list').textContent) && /服务端 Bug/.test($('.qs-list').textContent) && [...doc.querySelectorAll('.qs-item')].filter(e => /#2$/.test(e.querySelector('.qs-id').textContent)).length === 1);
  check('请求带关键词和范围（local / remote 各一次）', s.requests.some(u => /q=%E7%99%BB%E5%BD%95&scope=local/.test(u)) && s.requests.some(u => /q=%E7%99%BB%E5%BD%95&scope=remote/.test(u)));

  // 键盘选择
  const items = () => [...doc.querySelectorAll('.qs-item')];
  check('默认选中第一条', items()[0].classList.contains('is-active'));
  key(win, 'ArrowDown');
  check('↓ 选下一条', items()[1].classList.contains('is-active') && !items()[0].classList.contains('is-active'));
  key(win, 'ArrowUp'); key(win, 'ArrowUp');
  check('↑ 到顶再按回到最后一条（循环）', items()[items().length - 1].classList.contains('is-active'));
  key(win, 'ArrowDown');
  key(win, 'ArrowDown');
  key(win, 'Enter');
  check('回车：打开选中的那条（这里是第 2 条：任务 #901），搜索框关闭', s.opened.length === 1 && s.opened[0].join(':') === 'task:901' && !$('.qs-overlay'), JSON.stringify(s.opened));

  // 鼠标点
  $('#quickSearchBtn').click();
  await type(win, '登录'); await tick(40);
  const row = items().find(e => /登录设计文档/.test(e.textContent));
  row.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
  check('鼠标点一条：打开（文档 → doc #70）', s.opened.pop().join(':') === 'doc:70' && !$('.qs-overlay'));

  // 编号 / 单字不请求 remote
  s.requests.length = 0;
  $('#quickSearchBtn').click();
  await type(win, '#944'); await tick(40);
  check('纯编号：只查本地，不请求服务端搜索', s.requests.length === 1 && /scope=local/.test(s.requests[0]));
  s.requests.length = 0;
  await type(win, '登'); await tick(40);
  check('只输一个字：只查本地', s.requests.length === 1 && /scope=local/.test(s.requests[0]));

  // 过时的结果丢弃
  s.local = (q) => ({ tasks: [it('task', q === 'ab' ? 1 : 2, q === 'ab' ? '旧结果ab' : '新结果abc')] });
  s.remote = () => ({});
  await type(win, 'ab'); await type(win, 'abc'); await tick(40);
  check('连续输入：只显示最后一次输入的结果', /新结果abc/.test($('.qs-list').textContent) && !/旧结果ab/.test($('.qs-list').textContent));
  await type(win, ''); await tick(20);
  check('清空输入：回到提示文字', /输入标题里的几个字/.test($('.qs-list').textContent));

  // 没结果 / 连不上
  s.local = () => ({}); s.remote = () => ({});
  await type(win, '完全没有的东西'); await tick(40);
  check('没有结果：说明，并告知已在禅道里一起搜过', /没有找到「完全没有的东西」/.test($('.qs-list').textContent) && /已同时在禅道里搜了/.test($('.qs-list').textContent));
  s.down = true;
  await type(win, '连不上'); await tick(40);
  check('连不上后台：不报错，保持界面', !!$('.qs-overlay'));
  key(win, 'Escape');

  // 转义
  s = { local: () => ({ tasks: [it('task', 1, '<img src=x onerror=alert(1)>登录', '<b>状态</b>')] }) };
  ({ win, doc, $ } = setup(s));
  $('#quickSearchBtn').click();
  await type(win, '登录'); await tick(30);
  check('标题 / 状态里的 HTML 一律转义', !$('.qs-list img') && !$('.qs-list b') && /<img src=x/.test($('.qs-list').textContent));
  doc.querySelector('.qs-overlay').dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
  check('点遮罩关闭', !$('.qs-overlay'));
  check('页面引入了 quick-search.js', /<script src="quick-search\.js"><\/script>/.test(fs.readFileSync(path.join(EXT, 'newtab.html'), 'utf8')));

  for (const x of results) console.log(`  ${x.pass ? '✓' : '✗'} ${x.name}${x.pass || !x.extra ? '' : `   → ${String(x.extra).slice(0, 300)}`}`);
  const passed = results.filter(x => x.pass).length;
  console.log(`\n${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
