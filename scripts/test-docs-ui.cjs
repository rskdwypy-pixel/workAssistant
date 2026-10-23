/**
 * 真函数测试：文档中心（前端）
 *   - 库树：全部文档 + 各空间的库 + 「其他（未分组）」，计数用真实分组数
 *   - 列表：默认全部；点库过滤；搜索按标题过滤
 *   - 详情弹窗：正文（消毒后的 HTML，内联图走后端代理）、附件（预览 / 下载链接）、外链、在禅道打开
 *   - 未登录禅道：给出登录入口
 *   - 文档不存在：弹窗内提示
 *
 * jsdom 加载真实 newtab.html，原样执行 docs.js；网络换成模拟。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const EXT = path.join(__dirname, '..', 'extension');
const DOCS = fs.readFileSync(path.join(EXT, 'docs.js'), 'utf8');
const HTML = fs.readFileSync(path.join(EXT, 'newtab.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

const LIBS = [
  { id: '75', name: '产品主库', space: 'product', spaceLabel: '产品库', docCount: 3 },
  { id: '109', name: '项目主库', space: 'project', spaceLabel: '项目库', docCount: 0 },
  { id: '59', name: '接口文档库', space: 'custom', spaceLabel: '自定义库', docCount: 0 }
];
const DOCLIST = [
  { id: '2', lib: '60', module: '0', title: 'test', type: 'text', typeIcon: '📄', typeLabel: '正文', editedBy: 'yangkai', editedDate: '2024-10-08 15:47:25', draft: false },
  { id: '4', lib: '75', module: '0', title: '需求分析', type: 'text', typeIcon: '📄', typeLabel: '正文', editedBy: 'luotw', editedDate: '2025-02-20 15:12:15', draft: false },
  { id: '5', lib: '75', module: '0', title: '概要设计', type: 'text', typeIcon: '📄', typeLabel: '正文', editedBy: 'luotw', editedDate: '2025-02-20 15:13:36', draft: false },
  { id: '9', lib: '75', module: '0', title: '详细设计', type: 'text', typeIcon: '📄', typeLabel: '正文', editedBy: 'luotw', editedDate: '2025-02-20 15:44:05', draft: true },
  { id: '11', lib: '89', module: '0', title: '质量改进一期 -- 总结', type: 'text', typeIcon: '📄', typeLabel: '正文', editedBy: 'luotw', editedDate: '2025-05-19 10:15:05', draft: false },
  { id: '12', lib: '90', module: '0', title: '质量改进二期 -- 总结', type: 'text', typeIcon: '📄', typeLabel: '正文', editedBy: 'luotw', editedDate: '2025-06-03 10:06:57', draft: false }
];
const DOC12 = {
  id: '12', title: '质量改进二期 -- 总结', type: 'text', typeLabel: '正文', contentType: 'markdown',
  contentHtml: '<p>完成情况：<img src="/api/zentao/files/196/content?ext=png" alt="" /></p>',
  contentText: '', raw: '# 质量改进\n\n完成情况', editable: true, keywords: '', files: [], lib: '90', module: '0', editedBy: 'luotw', editedDate: '2025-06-03 10:06:57', addedBy: 'luotw', externalUrl: ''
};
const DOC_WITH_FILE = {
  id: '20', title: '接口文档.pdf', type: 'attachment', typeLabel: '附件', contentType: 'html',
  contentHtml: '', contentText: '', lib: '59', module: '0', editedBy: 'lijc', editedDate: '2025-07-01 09:00:00', addedBy: 'lijc', externalUrl: '',
  files: [{ id: '301', name: '接口文档.pdf', ext: 'pdf', size: 204800 }]
};
const DOC_URL = {
  id: '21', title: '竞品分析', type: 'url', typeLabel: '链接', contentType: 'html',
  contentHtml: '', contentText: '', files: [], lib: '59', module: '0', editedBy: 'lijc', editedDate: '2025-07-02 09:00:00', addedBy: 'lijc',
  externalUrl: 'https://example.com/a'
};

function setup(state = {}) {
  const dom = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  state.opened = [];
  state.calls = [];
  win.fetch = async (url, init = {}) => {
    const u = String(url).replace('http://127.0.0.1:3721', '');
    const method = (init.method || 'GET').toUpperCase();
    state.calls.push({ method, url: u, body: init.body ? JSON.parse(init.body) : null });
    const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (u === '/api/docs/libs') return reply({ success: true, data: state.libs || LIBS });
    if (u.startsWith('/api/docs/list')) {
      const kw = new URL(`http://x${u}`).searchParams.get('keyword');
      let data = state.docs || DOCLIST;
      if (kw) data = data.filter(d => d.title.includes(kw));
      return reply({ success: true, data });
    }
    let m;
    if ((m = u.match(/^\/api\/docs\/(\d+)\/collect$/)) && method === 'POST') {
      state.collected = !state.collected;
      return reply({ success: true, data: { collected: state.collected } });
    }
    if ((m = u.match(/^\/api\/docs\/(\d+)$/)) && method === 'PUT') return reply({ success: true, data: { id: m[1], message: '保存成功' } });
    if ((m = u.match(/^\/api\/docs\/(\d+)$/)) && method === 'DELETE') return reply({ success: true, data: { success: true } });
    if (u === '/api/docs' && method === 'POST') return reply({ success: true, data: { id: '99', message: '保存成功' } });
    if ((m = u.match(/^\/api\/docs\/(\d+)$/))) {
      const id = m[1];
      const map = { '12': DOC12, '20': DOC_WITH_FILE, '21': DOC_URL };
      if (map[id]) return reply({ success: true, data: map[id] });
      return reply({ success: false, code: 'DOC_NOT_FOUND', message: '文档不存在或已删除' }, 404);
    }
    return reply({ success: false, message: 'not mocked' }, 404);
  };
  win.Toast = { success() {}, error() {}, info() {}, warning() {} };
  win.Confirm = { show: async () => (state.confirmAnswer !== undefined ? state.confirmAnswer : true) };
  win.openInZentao = (type, id) => state.opened.push([type, id]);
  win.Account = { isLocalMode: () => !!state.localMode, showLogin: () => { state.loginShown = true; } };
  win.eval(`const API_BASE_URL='http://127.0.0.1:3721';\nfunction escapeHtml(t){const d=document.createElement('div');d.textContent=t==null?'':String(t);return d.innerHTML;}\n${DOCS}`);
  return { win, doc: win.document, state };
}

(async () => {
  // ============ 库树 + 列表 ============
  let { win, doc, state } = setup();
  win.DocPage.show();
  await tick(20);

  const tree = doc.getElementById('docTree');
  check('库树有「全部文档」且计数为 6', /全部文档/.test(tree.textContent) && tree.querySelector('[data-lib="all"] .doc-tree-count').textContent === '6');
  check('产品库下有「产品主库」，真实分组计数 3', tree.querySelector('[data-lib="75"]') && tree.querySelector('[data-lib="75"] .doc-tree-count').textContent === '3');
  check('无权限的库（lib 60/89/90）归入「其他/未分组」，计数 3', tree.querySelector('[data-lib="other"]') && tree.querySelector('[data-lib="other"] .doc-tree-count').textContent === '3');
  check('空库也展示（项目主库 0）', tree.querySelector('[data-lib="109"]') && tree.querySelector('[data-lib="109"] .doc-tree-count').textContent === '0');

  const list = doc.getElementById('docList');
  check('列表默认显示全部 6 篇', list.querySelectorAll('.doc-item').length === 6);
  check('草稿标记显示', /草稿/.test(list.querySelector('[data-id="9"]').textContent));
  check('列表项含作者与日期', /luotw · 2025-02-20/.test(list.querySelector('[data-id="4"]').textContent));

  // 点产品主库过滤
  tree.querySelector('[data-lib="75"]').click();
  await tick(10);
  check('点「产品主库」只剩 3 篇', list.querySelectorAll('.doc-item').length === 3 && [...list.querySelectorAll('.doc-item-title')].every(t => /分析|设计/.test(t.textContent)));

  // 点「其他」
  tree.querySelector('[data-lib="other"]').click();
  await tick(10);
  check('点「其他」显示未分组的 3 篇', list.querySelectorAll('.doc-item').length === 3 && list.querySelector('[data-id="2"]'));

  // 回到全部 + 搜索
  tree.querySelector('[data-lib="all"]').click();
  await tick(10);
  const search = doc.getElementById('docSearch');
  search.value = '设计';
  search.dispatchEvent(new win.Event('input'));
  await tick(10);
  check('搜索「设计」命中 2 篇', list.querySelectorAll('.doc-item').length === 2);
  search.value = '不存在的词';
  search.dispatchEvent(new win.Event('input'));
  await tick(10);
  check('搜索无结果给出空提示', /没有匹配/.test(list.textContent) && list.querySelectorAll('.doc-item').length === 0);

  // ============ 详情弹窗：正文 + 内联图代理 ============
  search.value = ''; search.dispatchEvent(new win.Event('input')); await tick(10);
  list.querySelector('[data-id="12"]').click();
  await tick(30);
  const viewer = doc.querySelector('.doc-viewer-overlay');
  check('弹窗打开', viewer && !viewer.hidden);
  check('标题正确', viewer.querySelector('.doc-viewer-title').textContent === '质量改进二期 -- 总结');
  const img = viewer.querySelector('.doc-content-html img');
  check('正文内联图走后端代理', img && img.getAttribute('src') === '/api/zentao/files/196/content?ext=png');
  check('正文无 script 注入', !/<script/i.test(viewer.querySelector('.doc-viewer-body').innerHTML));
  // 在禅道打开
  viewer.querySelector('[data-open]').click();
  check('「在禅道打开」调用 openInZentao(doc, 12)', state.opened.some(([t, id]) => t === 'doc' && id === '12'));
  // Esc 关闭
  doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape' }));
  check('Esc 关闭弹窗', viewer.hidden);

  // ============ 详情弹窗：附件型 ============
  list.querySelector('[data-id="12"]'); // 列表仍在
  win.DocViewer.open('20');
  await tick(30);
  const vb = viewer.querySelector('.doc-viewer-body');
  check('附件型：显示附件区', /附件（1）/.test(vb.textContent));
  const dl = [...vb.querySelectorAll('.doc-file-ops a')];
  check('附件有预览与下载链接', dl.length === 2 && dl[1].getAttribute('href').includes('/api/zentao/files/301/content') && /download=1/.test(dl[1].getAttribute('href')));

  // ============ 详情弹窗：外链型 ============
  win.DocViewer.open('21');
  await tick(30);
  check('外链型：渲染外部链接', viewer.querySelector('.doc-ext-link a') && viewer.querySelector('.doc-ext-link a').getAttribute('href') === 'https://example.com/a');

  // ============ 文档不存在 ============
  win.DocViewer.open('99999');
  await tick(30);
  check('不存在的文档：弹窗提示', /不存在|删除/.test(viewer.querySelector('.doc-viewer-body').textContent));

  // ============ 新建文档 ============
  win.DocEditor.openNew();
  await tick(10);
  const editor = doc.querySelector('.doc-editor-overlay');
  check('新建：编辑器打开', editor && !editor.hidden);
  check('新建：有文档库下拉且含库选项', editor.querySelector('[data-lib]').options.length === LIBS.length);
  check('新建：文档库可见', editor.querySelector('[data-liband]').style.display !== 'none');
  editor.querySelector('[data-title]').value = '新文档标题';
  editor.querySelector('[data-content]').value = '# 正文\n\n内容';
  editor.querySelector('[data-lib]').value = '75';
  editor.querySelector('[data-save]').click();
  await tick(20);
  const createCall = state.calls.find(c => c.url === '/api/docs' && c.method === 'POST');
  check('新建：POST /api/docs 带 lib/title/body/markdown', createCall && createCall.body.lib === '75' && createCall.body.title === '新文档标题' && createCall.body.contentType === 'markdown');
  check('新建：保存后关闭编辑器', editor.hidden);
  check('新建：保存后刷新列表', state.calls.filter(c => c.url.startsWith('/api/docs/list')).length >= 2);

  // 标题为空不提交
  win.DocEditor.openNew(); await tick(10);
  editor.querySelector('[data-title]').value = '';
  editor.querySelector('[data-save]').click(); await tick(10);
  check('新建：标题为空给出错误、不关闭', !editor.hidden && !editor.querySelector('[data-err]').hidden);
  win.DocEditor.close();

  // ============ 编辑文档（从详情进入，回填原始 markdown） ============
  win.DocViewer.open('12'); await tick(30);
  check('详情：正文型显示「编辑」按钮', !viewer.querySelector('[data-edit]').hidden);
  viewer.querySelector('[data-edit]').click();
  await tick(10);
  check('编辑：编辑器以原始 markdown 回填（不是渲染后的 HTML）', editor.querySelector('[data-content]').value === DOC12.raw);
  check('编辑：隐藏文档库选择（不换库）', editor.querySelector('[data-liband]').style.display === 'none');
  editor.querySelector('[data-content]').value = '# 改\n\n新内容';
  editor.querySelector('[data-save]').click();
  await tick(20);
  const putCall = state.calls.find(c => c.method === 'PUT' && c.url === '/api/docs/12');
  check('编辑：PUT /api/docs/12 带新正文', putCall && putCall.body.body === '# 改\n\n新内容');

  // ============ 收藏切换 ============
  win.DocViewer.open('12'); await tick(30);
  const colBtn = viewer.querySelector('[data-collect]');
  check('详情：显示收藏按钮（初始空心）', !colBtn.hidden && colBtn.textContent === '☆');
  colBtn.click(); await tick(10);
  check('收藏：点一次变实心 ★', colBtn.textContent === '★');
  colBtn.click(); await tick(10);
  check('收藏：再点取消变空心 ☆', colBtn.textContent === '☆');

  // ============ 删除（确认后调用 DELETE 并刷新） ============
  state.confirmAnswer = true;
  win.DocViewer.open('12'); await tick(30);
  const callsBefore = state.calls.length;
  viewer.querySelector('[data-delete]').click();
  await tick(20);
  check('删除：确认后 DELETE /api/docs/12', state.calls.some(c => c.method === 'DELETE' && c.url === '/api/docs/12'));
  check('删除：成功后关闭详情', viewer.hidden);
  // 取消删除
  state.confirmAnswer = false;
  win.DocViewer.open('12'); await tick(30);
  const delCount = state.calls.filter(c => c.method === 'DELETE').length;
  viewer.querySelector('[data-delete]').click(); await tick(20);
  check('删除：点取消不发 DELETE', state.calls.filter(c => c.method === 'DELETE').length === delCount);
  win.DocViewer.close();

  // ============ 未登录禅道 ============
  ({ win, doc, state } = setup({ localMode: true }));
  win.DocPage.show();
  await tick(10);
  const root = doc.getElementById('docMode');
  check('未登录：显示登录入口', /登录禅道/.test(root.textContent) && root.querySelector('[data-doc-login]'));
  root.querySelector('[data-doc-login]').click();
  check('点登录触发 Account.showLogin', state.loginShown === true);

  // ============ 汇总 ============
  const passed = results.filter(r => r.pass).length;
  for (const r of results) console.log(`${r.pass ? '✅' : '❌'} ${r.name}${r.extra ? `  (${r.extra})` : ''}`);
  console.log(`\n文档中心前端：${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
})();
