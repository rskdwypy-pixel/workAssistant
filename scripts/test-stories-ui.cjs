/**
 * 真函数测试：需求（story）前端
 *   - 左侧产品过滤 + 计数（随状态过滤联动）
 *   - 状态过滤：进行中（默认，不含关闭）/ 激活 / 评审中 / 已关闭 / 全部
 *   - 卡片：状态徽标 / 阶段 / 优先级 / 产品 / 指派
 *   - 搜索：按标题或编号
 *   - 详情弹窗：描述 + 验收标准（消毒 + 内联图代理）+ 附件 + 在禅道打开
 *   - 未登录禅道：登录入口
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const EXT = path.join(__dirname, '..', 'extension');
const SRC = fs.readFileSync(path.join(EXT, 'stories.js'), 'utf8');
const HTML = fs.readFileSync(path.join(EXT, 'newtab.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

const st = (id, title, status, tone, stage, pri, product, productName, assignedTo) =>
  ({ id, title, status, statusLabel: status, tone, stage, stageLabel: stage, pri, estimate: 0, category: 'feature', product, productName, openedBy: '张三', assignedTo });
const STORIES = [
  st('171', 'iOS通用自动化方案', 'active', 'active', '未开始', 3, '18', '真机拨测', '何俞龙'),
  st('170', 'controller改版A', 'closed', 'closed', '已关闭', 3, '7', 'iOS移动端', ''),
  st('169', 'controller改版B', 'reviewing', 'review', '', 1, '7', 'iOS移动端', ''),
  st('168', '云管需求', 'active', 'active', '研发中', 2, '30', '云管平台', '李四')
];
const STORY171 = {
  id: '171', title: 'iOS通用自动化方案', status: 'active', statusLabel: '激活', tone: 'active', stage: 'wait', stageLabel: '未开始',
  pri: 3, category: 'feature', source: 'customer', module: '0', product: '18', productName: '真机拨测',
  openedBy: '杨凯', assignedTo: '何俞龙', assignedToAccount: 'nuanshu', openedDate: '2025-01-01', lastEditedDate: '',
  specRaw: '<p>需求描述</p><p>第二段</p>', verifyRaw: '<p>验收点一</p>',
  specHtml: '<p>需求描述 <img src="/api/zentao/files/9/content?ext=png" alt="" /></p>',
  verifyHtml: '<ul><li>验收点一</li></ul>', files: [{ id: '50', name: '原型.pdf', ext: 'pdf', size: 1024 }]
};
const META = {
  product: '18',
  products: [{ value: '18', label: '真机拨测' }, { value: '7', label: 'iOS移动端' }],
  modules: [{ value: '0', label: '/' }],
  reviewers: [{ value: 'luotw', label: '罗天文' }, { value: 'wangrui', label: '王锐' }],
  assignees: [{ value: 'lijc', label: '李佳成' }, { value: 'nuanshu', label: '何俞龙' }],
  plans: [], categories: [{ value: 'feature', label: '功能' }, { value: 'interface', label: '接口' }],
  sources: [{ value: 'customer', label: '客户' }, { value: 'user', label: '用户' }],
  pris: [{ value: '1', label: '1' }, { value: '2', label: '2' }, { value: '3', label: '3' }, { value: '4', label: '4' }],
  defaultAssignedTo: 'lijc'
};

function setup(state = {}) {
  const win = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true }).window;
  state.opened = [];
  state.reqs = [];
  win.fetch = async (url, init = {}) => {
    const u = String(url).replace('http://127.0.0.1:3721', '');
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    state.reqs.push({ u, method, body });
    const reply = (b, s = 200) => ({ ok: s < 400, status: s, json: async () => b });
    if (u === '/api/stories?cache=only') return reply({ success: true, data: state.cache === undefined ? null : state.cache, syncedAt: 1760000000000, fromCache: true });
    if (u === '/api/stories' && method === 'GET') {
      if (state.freshDelay) await new Promise(r => setTimeout(r, state.freshDelay));
      if (state.freshFail) return reply({ success: false, message: '禅道连不上' }, 500);
      return reply({ success: true, data: state.stories || STORIES, syncedAt: Date.now(), diff: state.diff });
    }
    if (u.startsWith('/api/stories/meta')) return reply({ success: true, data: META });
    if (u === '/api/stories' && method === 'POST') return reply({ success: true, data: { id: '200', message: '保存成功' } });
    if (/^\/api\/stories\/\d+$/.test(u) && method === 'PUT') return reply({ success: true, data: { id: u.split('/').pop(), message: '保存成功' } });
    if (/^\/api\/stories\/\d+$/.test(u) && method === 'DELETE') return reply({ success: true, data: { success: true } });
    if (u.startsWith('/api/stories/')) {
      const id = u.split('/').pop();
      if (id === '171') return reply({ success: true, data: STORY171 });
      return reply({ success: false, code: 'STORY_NOT_FOUND', message: '需求不存在或已删除' }, 404);
    }
    if (u.startsWith('/api/stories')) return reply({ success: true, data: state.stories || STORIES });
    return reply({ success: false, message: 'not mocked' }, 404);
  };
  win.Toast = { success() {}, error() {}, info() {}, warning() {} };
  win.openInZentao = (type, id) => state.opened.push([type, id]);
  win.Account = { isLocalMode: () => !!state.localMode, showLogin: () => { state.loginShown = true; } };
  win.eval(`const API_BASE_URL='http://127.0.0.1:3721';\nfunction escapeHtml(t){const d=document.createElement('div');d.textContent=t==null?'':String(t);return d.innerHTML;}\n${SRC}`);
  return { win, doc: win.document, state };
}

(async () => {
  let { win, doc, state } = setup();
  win.StoryPage.show();
  await tick(20);

  const side = doc.getElementById('storySide');
  const list = doc.getElementById('storyList');
  // 默认「进行中」= 不含 closed（4 条里去掉 1 条 closed = 3）
  check('默认进行中：全部产品计数 3', side.querySelector('[data-prod="all"] .story-count').textContent === '3');
  check('默认进行中：列表 3 条（不含已关闭）', list.querySelectorAll('.story-card').length === 3);
  check('侧栏按产品分组', side.querySelector('[data-prod="7"]') && side.querySelector('[data-prod="18"]'));

  // 卡片内容
  const c171 = list.querySelector('[data-id="171"]');
  check('卡片含状态徽标 / 阶段 / 产品 / 指派', /激活|active/.test(c171.textContent) && /未开始/.test(c171.textContent) && /真机拨测/.test(c171.textContent) && /何俞龙/.test(c171.textContent));
  check('高优先级 P1 卡片存在（评审中那条）', list.querySelector('[data-id="169"] .pri-1'));

  // 状态过滤：已关闭
  doc.querySelector('#storyStatus [data-st="closed"]').click();
  await tick(10);
  check('切「已关闭」只剩 1 条', list.querySelectorAll('.story-card').length === 1 && list.querySelector('[data-id="170"]'));
  // 全部
  doc.querySelector('#storyStatus [data-st="all"]').click();
  await tick(10);
  check('切「全部」显示 4 条', list.querySelectorAll('.story-card').length === 4);

  // 产品过滤（iOS移动端 = 产品 7，有 170/169 两条）
  side.querySelector('[data-prod="7"]').click();
  await tick(10);
  check('点产品「iOS移动端」只剩该产品 2 条', list.querySelectorAll('.story-card').length === 2);

  // 搜索（回到全部产品）
  side.querySelector('[data-prod="all"]').click(); await tick(10);
  const search = doc.getElementById('storySearch');
  search.value = '云管'; search.dispatchEvent(new win.Event('input')); await tick(10);
  check('搜索「云管」命中 1 条', list.querySelectorAll('.story-card').length === 1 && list.querySelector('[data-id="168"]'));
  search.value = '169'; search.dispatchEvent(new win.Event('input')); await tick(10);
  check('按编号「169」搜索命中', list.querySelectorAll('.story-card').length === 1 && list.querySelector('[data-id="169"]'));
  search.value = ''; search.dispatchEvent(new win.Event('input')); await tick(10);

  // 详情弹窗
  list.querySelector('[data-id="171"]').click();
  await tick(30);
  const viewer = doc.querySelector('.doc-viewer-overlay');
  check('详情弹窗打开', viewer && !viewer.hidden);
  check('标题含编号', /#171/.test(viewer.querySelector('[data-title]').textContent));
  check('描述区渲染 + 内联图走代理', /需求描述/.test(viewer.textContent) && viewer.querySelector('.doc-content-html img').getAttribute('src') === '/api/zentao/files/9/content?ext=png');
  check('有验收标准区', /验收标准/.test(viewer.textContent) && /验收点一/.test(viewer.textContent));
  check('附件有预览 / 下载链接', [...viewer.querySelectorAll('.doc-file-ops a')].length === 2 && viewer.querySelector('.doc-file-ops a[download]').getAttribute('href').includes('/api/zentao/files/50/content'));
  viewer.querySelector('[data-open]').click();
  check('「在禅道打开」调用 openInZentao(story, 171)', state.opened.some(([t, id]) => t === 'story' && id === '171'));
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' }));
  check('Esc 关闭弹窗', viewer.hidden);

  // 不存在的需求
  win.StoryViewer.open('99999'); await tick(30);
  check('不存在的需求：弹窗提示', /不存在|删除/.test(viewer.querySelector('[data-body]').textContent));

  // ── 新建需求 ──
  check('工具栏有「新建需求」按钮', !!doc.getElementById('storyNew'));
  doc.getElementById('storyNew').click();
  await tick(30);
  const editor = doc.querySelector('.story-editor-overlay');
  check('新建弹窗打开', editor && !editor.hidden);
  check('产品下拉来自 meta', [...editor.querySelectorAll('[data-product] option')].some(o => o.value === '7'));
  check('评审人下拉来自 meta（多选）', editor.querySelector('[data-reviewer]').multiple && [...editor.querySelectorAll('[data-reviewer] option')].length === 2);
  check('默认指派为 defaultAssignedTo', editor.querySelector('[data-assigned]').value === 'lijc');
  // 不选评审人直接保存 → 拦截
  editor.querySelector('[data-title]').value = '新需求A';
  editor.querySelector('[data-save]').click(); await tick(10);
  check('缺评审人被拦截（未发 POST）', !editor.hidden && !state.reqs.some(r => r.method === 'POST') && /评审/.test(editor.querySelector('[data-err]').textContent));
  // 选产品 7、评审人、填描述 → 保存
  editor.querySelector('[data-product]').value = '7';
  const rv = editor.querySelector('[data-reviewer]'); rv.options[0].selected = true;
  editor.querySelector('[data-spec]').value = '第一行\n第二行';
  editor.querySelector('[data-save]').click(); await tick(20);
  const post = state.reqs.find(r => r.method === 'POST' && r.u === '/api/stories');
  check('新建发出 POST /api/stories', !!post);
  check('POST 带产品与评审人', post && post.body.product === '7' && Array.isArray(post.body.reviewers) && post.body.reviewers.includes('luotw'));
  check('描述转成 <p> 段落 HTML', post && post.body.spec === '<p>第一行</p><p>第二行</p>');
  check('保存成功后关闭弹窗', editor.hidden);

  // ── 编辑需求 ──（从详情弹窗进入）
  list.querySelector('[data-id="171"]'); // 确保列表在
  win.StoryViewer.open('171'); await tick(30);
  viewer.querySelector('[data-edit]').click(); await tick(30);
  check('编辑弹窗打开且标题含编号', !editor.hidden && /#171/.test(editor.querySelector('[data-etitle]').textContent));
  check('编辑：产品锁定为当前产品', editor.querySelector('[data-product]').disabled && editor.querySelector('[data-product]').value === '18');
  check('编辑：描述由 HTML 反解析为纯文本', editor.querySelector('[data-spec]').value === '需求描述\n第二段');
  check('编辑：带回已有指派人', editor.querySelector('[data-assigned]').value === 'nuanshu');
  editor.querySelector('[data-title]').value = 'iOS通用自动化方案-改';
  editor.querySelector('[data-reviewer]').options[0].selected = true;
  editor.querySelector('[data-save]').click(); await tick(20);
  const put = state.reqs.find(r => r.method === 'PUT' && r.u === '/api/stories/171');
  check('编辑发出 PUT /api/stories/171', !!put && put.body.title === 'iOS通用自动化方案-改');

  // ── 删除需求 ──（详情弹窗里）
  win.Confirm = { show: async () => true };
  win.StoryViewer.open('171'); await tick(30);
  viewer.querySelector('[data-del]').click(); await tick(20);
  check('删除发出 DELETE /api/stories/171', state.reqs.some(r => r.method === 'DELETE' && r.u === '/api/stories/171'));

  // ── 本地缓存：先画缓存，再用最新数据刷新 ──
  ({ win, doc, state } = setup({ cache: [STORIES[0]], freshDelay: 60, diff: { added: 3, changed: 1, removed: 0 } }));
  win.StoryPage.show(); await tick(20);
  check('缓存先画出来（最新数据还没回来）', doc.querySelectorAll('#storyList .story-card').length === 1 && /缓存/.test(doc.getElementById('storySyncHint').textContent) && /更新/.test(doc.getElementById('storySyncHint').textContent));
  await tick(100);
  check('最新数据回来后刷新列表', doc.querySelectorAll('#storyList .story-card').length === 3);
  check('页头显示已同步 + 新增 / 变更条数', /已同步/.test(doc.getElementById('storySyncHint').textContent) && /新增 3/.test(doc.getElementById('storySyncHint').textContent) && /变更 1/.test(doc.getElementById('storySyncHint').textContent));
  check('页头统计：全部 4 / 进行中 3', doc.getElementById('storyStatAll').textContent === '4' && doc.getElementById('storyStatOpen').textContent === '3');
  ({ win, doc, state } = setup({ cache: [STORIES[0]], freshFail: true }));
  win.StoryPage.show(); await tick(40);
  check('更新失败时保留缓存列表并提示', doc.querySelectorAll('#storyList .story-card').length === 1 && /更新失败/.test(doc.getElementById('storySyncHint').textContent));

  // 未登录
  ({ win, doc, state } = setup({ localMode: true }));
  win.StoryPage.show(); await tick(10);
  const root = doc.getElementById('storyMode');
  check('未登录：显示登录入口', /登录禅道/.test(root.textContent) && root.querySelector('[data-story-login]'));
  root.querySelector('[data-story-login]').click();
  check('点登录触发 Account.showLogin', state.loginShown === true);

  const passed = results.filter(r => r.pass).length;
  for (const r of results) console.log(`${r.pass ? '✅' : '❌'} ${r.name}${r.extra ? `  (${r.extra})` : ''}`);
  console.log(`\n需求前端：${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
})();
