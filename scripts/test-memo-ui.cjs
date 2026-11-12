/**
 * 真函数测试：备忘录（前端）
 *   - 列表渲染：卡片、标题、预览、标签、日期、操作按钮
 *   - 空状态
 *   - 搜索过滤
 *   - 置顶排序
 *   - 待同步标记
 *   - 新建弹窗
 *   - 删除确认
 *   - 同步状态条（未启用 / 已启用）
 *
 * jsdom 加载真实 newtab.html，原样执行 memo.js；网络换成模拟。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const EXT = path.join(__dirname, '..', 'extension');
const MEMO = fs.readFileSync(path.join(EXT, 'memo.js'), 'utf8');
const HTML = fs.readFileSync(path.join(EXT, 'newtab.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

const MEMOS = [
  { id: '1', docId: '', title: '周会要点', content: '1. Q4 排期\n2. 人员安排', tags: ['工作', '会议'], pinned: true, createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T10:00:00Z', syncDirty: false, deleted: false, attachments: [{ id: '88', name: '排期表.xlsx', size: 20480 }] },
  { id: '2', docId: '', title: '取快递', content: '下午去取', tags: ['生活'], pinned: false, createdAt: '2026-11-10T00:00:00Z', updatedAt: '2026-11-10T10:00:00Z', syncDirty: false, deleted: false, attachments: [] },
  { id: '3', docId: '', title: '重构想法', content: '考虑用策略模式重构 zentaoService', tags: ['工作'], pinned: false, createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T10:00:00Z', syncDirty: true, deleted: false, attachments: [] }
];

function setup(memos = MEMOS, syncState = { enabled: false }, opts = {}) {
  const dom = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  const state = { memos, syncState, calls: [], defaultLibId: opts.defaultLibId || '' };

  win.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    state.calls.push({ method, url: u, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });

    if (u.includes('/api/memos/sync/config') && method === 'GET') {
      return { json: async () => ({ success: true, data: { defaultLibId: state.defaultLibId } }) };
    }
    if (u.includes('/api/memos/sync/config') && method === 'POST') {
      state.defaultLibId = (typeof init.body === 'string' ? JSON.parse(init.body).defaultLibId : '') || '';
      return { json: async () => ({ success: true, data: {} }) };
    }
    if (u.includes('/api/memos/sync/config')) {
      return { json: async () => ({ success: true, data: { defaultLibId: state.defaultLibId } }) };
    }
    if (u.includes('/api/memos') && u.includes('keyword')) {
      const kw = u.includes('keyword=') && u.split('keyword=')[1] ? decodeURIComponent(u.split('keyword=')[1]).toLowerCase() : '';
      const filtered = kw ? memos.filter(m => m.title.toLowerCase().includes(kw) || m.content.toLowerCase().includes(kw) || (m.tags || []).some(t => t.toLowerCase().includes(kw))) : memos;
      return { json: async () => ({ success: true, data: filtered }) };
    }
    if (u.includes('/api/memos/sync/state')) {
      return { json: async () => ({ success: true, data: syncState }) };
    }
    if (u.includes('/api/memos/sync/libs')) {
      return { json: async () => ({ success: true, data: [{ id: '202', name: '个人空间', space: 'custom', spaceLabel: '自定义库' }] }) };
    }
    if (u.includes('/api/memos/sync/enable')) {
      return { json: async () => ({ success: true, data: { enabled: true, libId: '202' } }) };
    }
    if (u.includes('/api/memos/sync/disable')) {
      return { json: async () => ({ success: true, data: { enabled: false } }) };
    }
    if (u.includes('/api/memos/sync/pull') || u.includes('/api/memos/sync/push')) {
      return { json: async () => ({ success: true, data: { uploaded: 0, deleted: 0, failed: 0, errors: [] } }) };
    }
    if (u.includes('/api/memos/') && u.endsWith('/sync') && method === 'POST') {
      return { json: async () => ({ success: true, data: { uploaded: 1, deleted: 0, failed: 0, errors: [] } }) };
    }
    if (u.includes('/api/memos/') && u.endsWith('/sync-lib') && method === 'POST') {
      return { json: async () => ({ success: true, data: {} }) };
    }
    if (u.includes('/api/memos/') && u.includes('/attachments') && method === 'POST') {
      return { json: async () => ({ success: true, data: { id: '1', file: { id: '99', name: '新附件.pdf', size: 1024 } } }) };
    }
    if (u.includes('/api/memos') && method === 'POST' && !u.includes('/sync/') && !u.includes('/pin')) {
      return { json: async () => ({ success: true, data: { id: 'new', ...state.calls[state.calls.length - 1].body, syncDirty: false, createdAt: '2026-11-11T00:00:00Z', updatedAt: '2026-11-11T00:00:00Z' } }) };
    }
    if (u.includes('/api/memos/') && method === 'PUT') {
      return { json: async () => ({ success: true, data: { id: u.split('/').pop(), ...state.calls[state.calls.length - 1].body, updatedAt: '2026-11-11T10:00:00Z' } }) };
    }
    if (u.includes('/api/memos/') && method === 'DELETE') {
      return { json: async () => ({ success: true, data: {} }) };
    }
    if (u.includes('/api/memos/') && u.endsWith('/pin')) {
      const id = u.split('/').pop();
      const m = memos.find(x => x.id === id);
      return { json: async () => ({ success: true, data: { ...m, pinned: !m.pinned } }) };
    }
    return { json: async () => ({ success: true, data: [] }) };
  };

  win.eval(MEMO);
  return { win, state, dom };
}

(async () => {
  // 1. 初始渲染
  const { win } = setup();
  win.MemoPage.show();
  await tick(50);
  check('渲染：搜索框存在', !!win.document.querySelector('.memo-search'));
  check('渲染：新建按钮存在', !!win.document.querySelector('.memo-new-btn'));
  check('渲染：列表容器存在', !!win.document.querySelector('#memoList'));

  // 2. 卡片渲染
  const cards = win.document.querySelectorAll('.memo-card');
  check('卡片：数量正确', cards.length === 3, `${cards.length}`);
  check('卡片：置顶排最前', cards[0].querySelector('.memo-card-title').textContent.includes('周会要点'));
  check('卡片：标题显示', cards[0].querySelector('.memo-card-title').textContent.includes('周会要点'));
  check('卡片：预览显示', cards[0].querySelector('.memo-card-preview') !== null);
  check('卡片：标签显示', cards[0].querySelectorAll('.memo-tag').length === 2);
  check('卡片：操作按钮 3 个（置顶/编辑/删除）', cards[0].querySelectorAll('.memo-card-actions button').length === 3);
  check('卡片：附件角标显示数量', (cards[0].querySelector('.memo-attach-badge') || {}).textContent?.includes('1'));
  check('卡片：无附件不显示角标', cards[1].querySelector('.memo-attach-badge') === null);
  check('头部：同步全部按钮存在', !!win.document.querySelector('.memo-sync-all-btn'));

  // 3. 置顶标识
  check('卡片：置顶标识显示', cards[0].querySelector('.memo-pin-icon') !== null);
  check('卡片：非置顶无标识', cards[1].querySelector('.memo-pin-icon') === null);

  // 4. 待同步标记
  const dirtyCard = win.document.querySelectorAll('.memo-card')[2];
  check('卡片：待同步标记显示', dirtyCard.querySelector('.memo-dirty') !== null);

  // 5. 搜索过滤（输入有 300ms 防抖，要等防抖窗口过去）
  const searchInput = win.document.querySelector('.memo-search');
  searchInput.value = '快递';
  searchInput.dispatchEvent(new win.Event('input'));
  await tick(400);
  const searchedCards = win.document.querySelectorAll('.memo-card');
  check('搜索：命中 1 条', searchedCards.length === 1, `${searchedCards.length}`);
  check('搜索：命中正确', searchedCards[0].querySelector('.memo-card-title').textContent.includes('快递'));

  // 清空搜索（同样等防抖）
  searchInput.value = '';
  searchInput.dispatchEvent(new win.Event('input'));
  await tick(400);

  // 6. 空状态
  const { win: win2 } = setup([]);
  win2.MemoPage.show();
  await tick(50);
  check('空状态：显示提示', win2.document.querySelector('.memo-empty') !== null);

  // 7. 新建弹窗
  const { win: win3 } = setup();
  win3.MemoPage.show();
  await tick(50);
  win3.document.querySelector('.memo-new-btn').click();
  await tick(50);
  check('新建弹窗：弹窗显示', !!win3.document.querySelector('.memo-modal'));
  check('新建弹窗：标题输入框', !!win3.document.querySelector('#memoEditTitle'));
  check('新建弹窗：正文输入框', !!win3.document.querySelector('#memoEditContent'));
  check('新建弹窗：标签输入框', !!win3.document.querySelector('#memoEditTags'));
  check('新建弹窗：保存按钮', !!win3.document.querySelector('#memoEditSave'));
  check('新建弹窗：添加附件按钮', !!win3.document.querySelector('#memoEditAttachPick'));
  // 取消关闭
  win3.document.querySelector('.memo-modal .memo-btn-cancel').click();
  await tick(50);
  check('新建弹窗：取消后关闭', !win3.document.querySelector('.memo-modal'));

  // 8. 删除确认
  const { win: win4 } = setup();
  win4.MemoPage.show();
  await tick(50);
  const firstCard4 = win4.document.querySelector('.memo-card');
  firstCard4.querySelector('.memo-delete').click();
  await tick(50);
  check('删除确认：弹窗显示', !!win4.document.querySelector('.memo-modal'));
  check('删除确认：确认按钮', !!win4.document.querySelector('.memo-modal .memo-btn-danger'));
  win4.document.querySelector('.memo-modal .memo-btn-cancel').click();
  await tick(50);

  // 9. 卡片显示创建时间、同步目标
  const { win: win5 } = setup();
  win5.MemoPage.show();
  await tick(50);
  const card5 = win5.document.querySelector('.memo-card');
  check('卡片：显示创建时间', card5.querySelector('.memo-card-meta').textContent.includes('创建'));
  check('卡片：显示更新时间', card5.querySelector('.memo-card-meta').textContent.includes('更新'));
  check('卡片：显示同步目标', card5.querySelector('.memo-card-meta').textContent.includes('同步'));

  // 10. 卡片 meta 显示同步目标（不再是裸 ID 的按钮）
  check('卡片：meta 显示同步', card5.querySelector('.memo-card-sync') !== null);

  // 11. 单击预览（卡片主体），预览里有同步目标行
  card5.click();
  await tick(50);
  check('单击：弹出预览弹窗', !!win5.document.querySelector('.memo-modal'));
  check('预览：显示内容', !!win5.document.querySelector('.memo-preview-content') || !!win5.document.querySelector('.memo-modal-title'));
  check('预览：同步目标行', !!win5.document.querySelector('#memoPreviewChangeLib') && !!win5.document.querySelector('#memoPreviewSyncNow'));
  check('预览：附件列表显示文件名和下载', (() => {
    const box = win5.document.querySelector('.memo-preview-attachments');
    return !!box && box.textContent.includes('排期表.xlsx') && !!box.querySelector('a[download]');
  })());
  check('预览：加附件按钮存在', !!win5.document.querySelector('#memoPreviewAddAttach'));
  // 关闭预览
  const previewClose = win5.document.querySelector('#memoPreviewClose');
  if (previewClose) previewClose.click();
  await tick(50);

  // 12. 新建后自动同步：配置了默认库 → 自动 setSyncLib，不弹选择
  const { win: win8, state: state8 } = setup(MEMOS, { enabled: false }, { defaultLibId: '202' });
  win8.MemoPage.show();
  await tick(50);
  win8.document.querySelector('.memo-new-btn').click();
  await tick(50);
  win8.document.querySelector('#memoEditTitle').value = '自动同步测试';
  win8.document.querySelector('#memoEditContent').value = '测试内容';
  win8.document.querySelector('#memoEditSave').click();
  await tick(200);
  const syncLibCalls8 = state8.calls.filter(c => c.url.includes('/sync-lib'));
  check('自动同步：已配默认库时自动 setSyncLib', syncLibCalls8.length > 0, `syncLib calls: ${syncLibCalls8.length}`);
  check('自动同步：不弹文档库选择', !win8.document.querySelector('.memo-lib-item'));

  // 13. 未配默认库 → 提示去设置，不弹选择、不自动分配
  const { win: win9, state: state9 } = setup(MEMOS, { enabled: false }, { defaultLibId: '' });
  win9.MemoPage.show();
  await tick(50);
  const dirtyCard9 = win9.document.querySelectorAll('.memo-card')[2]; // fixture id3 syncDirty=true
  check('场景准备：有待同步便签', !!dirtyCard9 && dirtyCard9.querySelector('.memo-dirty') !== null);
  win9.MemoPage.afterEdit();
  await tick(200);
  check('自动同步：未配默认库不弹选择', !win9.document.querySelector('.memo-lib-item'));
  check('自动同步：未配默认库不自动分配', state9.calls.filter(c => c.url.includes('/sync-lib')).length === 0);

  // 14. 新建便签带附件：保存后自动上传到该便签
  const { win: win10, state: state10 } = setup(MEMOS, { enabled: false }, { defaultLibId: '202' });
  win10.MemoPage.show();
  await tick(50);
  win10.document.querySelector('.memo-new-btn').click();
  await tick(50);
  win10.document.querySelector('#memoEditTitle').value = '带附件的便签';
  const fileInput = win10.document.querySelector('#memoEditAttachInput');
  const fakeFile = new win10.File(['hello'], '说明.txt', { type: 'text/plain' });
  Object.defineProperty(fileInput, 'files', { value: [fakeFile], configurable: true });
  fileInput.dispatchEvent(new win10.Event('change'));
  await tick(50);
  check('附件：选中后显示待上传项', !!win10.document.querySelector('.memo-attach-pending'));
  win10.document.querySelector('#memoEditSave').click();
  await tick(300);
  const attachCalls = state10.calls.filter(c => c.url.includes('/attachments') && c.method === 'POST');
  check('附件：保存后自动上传', attachCalls.length === 1, `attach calls: ${attachCalls.length}`);
  check('附件：上传请求带文件名', attachCalls.length > 0 && attachCalls[0].url.includes(encodeURIComponent('说明.txt')));
  check('附件：上传后弹窗关闭', !win10.document.querySelector('#memoEditSave'));

  // 汇总
  const pass = results.filter(r => r.pass).length;
  const total = results.length;
  for (const r of results) {
    console.log(`${r.pass ? '✅' : '❌'} ${r.name}${r.extra ? `  (${r.extra})` : ''}`);
  }
  console.log(`\n备忘录前端：${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
})();
