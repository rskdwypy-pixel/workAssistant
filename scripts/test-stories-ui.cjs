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
  pri: 3, category: 'feature', product: '18', productName: '真机拨测', openedBy: '杨凯', assignedTo: '何俞龙', openedDate: '2025-01-01', lastEditedDate: '',
  specHtml: '<p>需求描述 <img src="/api/zentao/files/9/content?ext=png" alt="" /></p>',
  verifyHtml: '<ul><li>验收点一</li></ul>', files: [{ id: '50', name: '原型.pdf', ext: 'pdf', size: 1024 }]
};

function setup(state = {}) {
  const win = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true }).window;
  state.opened = [];
  win.fetch = async (url) => {
    const u = String(url).replace('http://127.0.0.1:3721', '');
    const reply = (b, s = 200) => ({ ok: s < 400, status: s, json: async () => b });
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
