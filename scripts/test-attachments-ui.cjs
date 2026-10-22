/**
 * 真函数测试：附件前端（extension/attachments.js + newtab.js 里的相关改动）
 *
 * 用 jsdom 加载真实 newtab.html，原样执行 attachments.js，并从 newtab.js 抽出
 * Confirm / ProgressInputDialog / BugManager.resolveBug 等真实代码；只把网络换成模拟后端。
 *
 * 覆盖：
 *   - 选择区：类型 / 大小 / 数量校验、粘贴截图（自动命名）、纯文本粘贴不受影响、拖入文件、删除、排序
 *   - 详情附件区：各状态展示、未同步提示、禅道不可达提示、重试、删除（确认）、追加（截图插正文）
 *   - 卡片角标：数量、待上传、失败可点重试（全局委托）
 *   - 确认框：取消会结算；取消过的确认不会被下一次「确定」连带触发
 *   - 进度弹窗：取消会结算；完成时显示附件区并返回附件
 *   - 解决 Bug：附件先暂扣上传、随解决提交；解决失败回收暂扣附件
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');
const { JSDOM } = require('jsdom');

const EXT = path.join(__dirname, '..', 'extension');
const SRC = fs.readFileSync(path.join(EXT, 'newtab.js'), 'utf8');
const ATT = fs.readFileSync(path.join(EXT, 'attachments.js'), 'utf8');
const HTML = fs.readFileSync(path.join(EXT, 'newtab.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
const AST = acorn.parse(SRC, { ecmaVersion: 'latest', sourceType: 'script' });

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

function extract(names) {
  return names.map((name) => {
    const node = AST.body.find(n =>
      (n.type === 'FunctionDeclaration' && n.id.name === name) ||
      (n.type === 'VariableDeclaration' && n.declarations.some(d => d.id.name === name)));
    if (!node) throw new Error(`newtab.js 里找不到 ${name}`);
    return SRC.slice(node.start, node.end);
  }).join('\n');
}

/** 抽出对象字面量里的一个方法（如 BugManager.resolveBug） */
function extractMethod(objName, method) {
  for (const n of AST.body) {
    if (n.type !== 'VariableDeclaration') continue;
    const d = n.declarations.find(x => x.id.name === objName);
    if (!d) continue;
    const p = d.init.properties.find(x => (x.key.name || x.key.value) === method);
    if (p) return SRC.slice(p.start, p.end);
  }
  throw new Error(`找不到 ${objName}.${method}`);
}

/**
 * 模拟后端：记录请求，按路径返回
 * @param {object} state - { items, syncResult, removeFails, resolveResult }
 */
function makeFetch(win, state) {
  state.requests = [];
  return async (url, init = {}) => {
    const u = new URL(String(url));
    const method = (init.method || 'GET').toUpperCase();
    state.requests.push({ method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: init.body });
    const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o, blob: async () => new win.Blob(['x']) });
    let m;
    if ((m = u.pathname.match(/^\/api\/records\/([^/]+)\/attachments$/)) && method === 'GET') {
      return json({ success: true, zentaoId: state.zentaoId ?? '952', items: state.items, remoteError: state.remoteError || '' });
    }
    if ((m = u.pathname.match(/^\/api\/records\/([^/]+)\/attachments$/)) && method === 'POST') {
      if (state.uploadFails && state.uploadFails.includes(u.searchParams.get('name'))) return json({ success: false, message: '模拟：上传失败' }, 400);
      const meta = { id: `att-${state.requests.length}`, name: u.searchParams.get('name'), status: u.searchParams.get('hold') ? 'held' : 'pending' };
      return json({ success: true, data: meta });
    }
    if ((m = u.pathname.match(/^\/api\/records\/([^/]+)\/attachments\/sync$/))) {
      return json(state.syncResult || { success: true, uploaded: 1, message: '附件已上传' });
    }
    if ((m = u.pathname.match(/^\/api\/records\/([^/]+)\/attachments\/(.+)$/)) && method === 'DELETE') {
      return json({ success: true, message: '附件已删除' });
    }
    if (/\/content$/.test(u.pathname)) return json({});
    return json({ success: false, message: `未模拟的请求 ${method} ${u.pathname}` }, 404);
  };
}

function setup(state = {}, extra = '') {
  const dom = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  win.__state = state;
  win.__toasts = [];
  win.fetch = makeFetch(win, state);
  win.eval(`
    const API_BASE_URL = 'http://127.0.0.1:3721';
    URL.createObjectURL = () => 'blob:test';
    URL.revokeObjectURL = () => {};
    const Toast = {
      success(m){ window.__toasts.push(['success', m]); }, error(m){ window.__toasts.push(['error', m]); },
      warning(m){ window.__toasts.push(['warning', m]); }, info(m){ window.__toasts.push(['info', m]); }
    };
    const ProgressToast = { show(){}, hide(){} };
    const ButtonStateManager = { setLoading(){ return () => {}; } };
    const getWorkTimePlaceholder = () => '今日已记 0h';
    ${extract(['escapeHtml', 'resetListenerScope', 'Confirm', 'ProgressInputDialog'])}
    ${ATT}
    window.__api = { AttachmentPicker, AttachmentPanel, AttachmentRules, attachmentBadgeHTML, AttachmentWatcher, Confirm, ProgressInputDialog };
    ${extra}
  `);
  return win;
}

const fakeFile = (win, name, size, type = '') => {
  const f = new win.File([new Uint8Array(Math.min(size, 16))], name, { type });
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

async function main() {
  // ============ 选择区 ============
  {
    const win = setup();
    const doc = win.document;
    const host = doc.getElementById('taskAttachments');
    const picker = new win.__api.AttachmentPicker(host);
    picker.add([
      fakeFile(win, '截图.png', 1000, 'image/png'),
      fakeFile(win, 'virus.exe', 10),
      fakeFile(win, 'big.mp4', 50 * 1024 * 1024 + 1, 'video/mp4'),
      fakeFile(win, 'empty.txt', 0)
    ]);
    const warning = (win.__toasts.find(t => t[0] === 'warning') || [])[1] || '';
    check('选择区：只接受合规文件', picker.count === 1, `count=${picker.count}`);
    check('选择区：不合规的逐条说明原因', /类型不支持/.test(warning) && /超过 50MB/.test(warning) && /空文件/.test(warning), warning);

    for (let i = 0; i < 12; i++) picker.add([fakeFile(win, `f${i}.txt`, 10)]);
    check('选择区：最多 10 个', picker.count === 10);
    picker.clear();
    picker.add([fakeFile(win, 'a.mp4', 45 * 1024 * 1024), fakeFile(win, 'b.mp4', 45 * 1024 * 1024), fakeFile(win, 'c.mp4', 20 * 1024 * 1024)]);
    check('选择区：总大小不超过 100MB', picker.count === 2);
    picker.clear();

    // 粘贴截图：剪贴板里的图片被接管并重命名；纯文本粘贴不拦截
    const modal = doc.getElementById('taskCreateModal');
    picker.bindPaste(modal);
    const img = new win.File([new Uint8Array([1])], 'image.png', { type: 'image/png' });
    const pasteEvt = new win.Event('paste', { bubbles: true, cancelable: true });
    pasteEvt.clipboardData = { files: [img] };
    doc.getElementById('taskTitle').dispatchEvent(pasteEvt);
    check('粘贴截图：加入选择区并自动命名', picker.count === 1 && /^截图-\d{8}-\d{6}\.png$/.test(picker.getItems()[0].name) && pasteEvt.defaultPrevented, picker.getItems()[0] && picker.getItems()[0].name);
    const textEvt = new win.Event('paste', { bubbles: true, cancelable: true });
    textEvt.clipboardData = { files: [] };
    doc.getElementById('taskTitle').dispatchEvent(textEvt);
    check('粘贴纯文本：不拦截，照常粘贴', !textEvt.defaultPrevented && picker.count === 1);

    // 再绑一次（弹窗重复初始化）不会叠加：粘贴一次只加一个
    picker.bindPaste(modal);
    const again = new win.Event('paste', { bubbles: true, cancelable: true });
    again.clipboardData = { files: [new win.File([new Uint8Array([2])], 'image.png', { type: 'image/png' })] };
    modal.dispatchEvent(again);
    check('重复绑定粘贴不叠加：粘贴一次只加一个', picker.count === 2, `count=${picker.count}`);

    // 拖入文件
    const dropEvt = new win.Event('drop', { bubbles: true, cancelable: true });
    dropEvt.dataTransfer = { files: [fakeFile(win, 'log.txt', 5)], types: ['Files'] };
    host.dispatchEvent(dropEvt);
    check('拖入文件：加入选择区', picker.count === 3 && picker.getItems()[2].name === 'log.txt');

    // 排序与删除
    const [a, b, c] = picker.items.map(i => i.uid);
    picker.move(c, a);
    check('拖动排序：移到最前', picker.items[0].uid === c);
    host.querySelector(`.att-remove[data-uid="${b}"]`).click();
    check('点 × 移除附件', picker.count === 2 && !picker.items.some(i => i.uid === b));
  }

  // ============ 卡片角标 ============
  {
    const win = setup({ syncResult: { success: true, uploaded: 2, message: '附件已上传' } });
    const { attachmentBadgeHTML } = win.__api;
    check('角标：无附件不显示', attachmentBadgeHTML({ id: 't', attachments: [] }) === '');
    const notSynced = attachmentBadgeHTML({ id: 't0', attachments: [{ status: 'uploaded' }, { status: 'pending' }] });
    check('角标：未同步到禅道 → 数量 + 待上传', /📎 2/.test(notSynced) && /1 个待上传/.test(notSynced));
    win.__api.AttachmentWatcher.INTERVAL_MS = 10;
    win.__state.items = [{ status: 'pending' }];
    win.__state.zentaoId = '1';
    let refreshCount = 0;
    win.onAttachmentsChanged = () => { refreshCount++; };
    const pendingHtml = attachmentBadgeHTML({ id: 't', zentaoId: '1', attachments: [{ status: 'uploaded' }, { status: 'pending' }] });
    check('角标：已同步到禅道 → 显示「上传中」而不是「待上传」', /1 个上传中/.test(pendingHtml) && !/待上传/.test(pendingHtml), pendingHtml);
    attachmentBadgeHTML({ id: 't', zentaoId: '1', attachments: [{ status: 'pending' }] }); // 重复渲染不重复观察
    await tick(40);
    check('观察器：推送未结束时不刷新', refreshCount === 0);
    win.__state.items = [{ status: 'uploaded' }];
    await tick(60);
    check('观察器：推送结束后刷新一次列表（角标随之更新）', refreshCount === 1, `刷新 ${refreshCount} 次`);
    win.__state.items = [];
    win.__state.zentaoId = undefined;
    const failedHtml = attachmentBadgeHTML({ id: 'task-x', attachments: [{ status: 'failed' }, { status: 'failed' }] });
    check('角标：失败显示「重试」', /2 个未上传 · 重试/.test(failedHtml) && /data-att-retry="task-x"/.test(failedHtml));

    let refreshed = 0;
    win.onAttachmentsChanged = () => { refreshed++; };
    const card = win.document.createElement('div');
    let cardClicked = 0;
    card.addEventListener('click', () => { cardClicked++; });
    card.innerHTML = failedHtml;
    win.document.body.appendChild(card);
    card.querySelector('[data-att-retry]').click();
    await tick(20);
    const syncReq = win.__state.requests.find(r => r.path === '/api/records/task-x/attachments/sync');
    check('角标重试：调用推送接口并刷新列表', syncReq && refreshed === 1);
    check('角标重试：不触发卡片点击（不打开详情）', cardClicked === 0);
  }

  // ============ 详情附件区 ============
  {
    const items = [
      { key: 'zentao:302', source: 'zentao', zentaoFileId: '302', name: '截图.png', size: 70, ext: 'png', kind: 'image', status: 'uploaded' },
      { key: 'local:a1', source: 'local', localId: 'a1', name: 'app.log', size: 10, ext: 'log', kind: 'text', status: 'failed', error: '禅道拒绝', attempts: 5 },
      { key: 'zentao:303', source: 'zentao', zentaoFileId: '303', name: '网页上传.pdf', size: 3, ext: 'pdf', kind: 'document', status: 'uploaded', addedBy: 'lijc' }
    ];
    const win = setup({ items });
    const doc = win.document;
    const host = doc.createElement('div');
    doc.getElementById('modalBody').appendChild(host);
    await win.__api.AttachmentPanel.mount(host, { id: 'task-1', zentaoId: '952' });
    check('详情：列出全部附件（含禅道网页上传的）', host.querySelectorAll('.att-card').length === 3 && /附件（3）/.test(host.textContent));
    check('详情：失败附件显示原因', /上传失败：禅道拒绝/.test(host.textContent));
    check('详情：有失败附件时显示「重试上传」', !host.querySelector('.att-panel-retry').hidden && host.querySelector('.att-panel-retry').textContent === '重试上传');
    check('详情：显示禅道上传者', /lijc 在禅道上传/.test(host.textContent));

    host.querySelector('.att-panel-retry').click();
    await tick(20);
    check('详情：点重试调用推送接口', win.__state.requests.some(r => r.path === '/api/records/task-1/attachments/sync'));

    // 删除：确认后调用删除接口
    win.__api.Confirm.show = async (t, m) => { win.__confirmMsg = m; return true; };
    host.querySelector('.att-card[data-key="zentao:302"] .att-delete').click();
    await tick(20);
    const del = win.__state.requests.find(r => r.method === 'DELETE');
    check('详情：删除已上传附件前提示会同时删除禅道里的文件（图片还会提到正文里的图）', /禅道里的这个附件(以及正文里对应的图片)?也会被删除/.test(win.__confirmMsg || ''), win.__confirmMsg);
    check('详情：确认后调用删除接口', del && decodeURIComponent(del.path).endsWith('/attachments/zentao:302'), del && del.path);

    // 追加：截图插正文、校验
    const before = win.__state.requests.length;
    await win.__api.AttachmentPanel.addFiles(host, { id: 'task-1', zentaoId: '952' }, [fakeFile(win, '补充.png', 100, 'image/png'), fakeFile(win, 'x.exe', 10)]);
    const ups = win.__state.requests.slice(before).filter(r => r.method === 'POST' && /\/attachments$/.test(r.path));
    check('详情：追加的截图上传并标记插入正文', ups.length === 1 && ups[0].query.inline === '1' && ups[0].query.name === '补充.png', JSON.stringify(ups.map(u => u.query)));
    check('详情：不合规文件被拦下', win.__toasts.some(t => t[0] === 'warning' && /类型不支持/.test(t[1])));
  }
  {
    // 已同步禅道的 pending → 详情显示「上传中」；结束后通知列表刷新
    const win = setup({ items: [{ key: 'local:p', source: 'local', localId: 'p', name: 'p.png', size: 1, kind: 'image', status: 'pending' }] });
    const host = win.document.createElement('div');
    win.document.body.appendChild(host);
    let changed = 0;
    await win.__api.AttachmentPanel.mount(host, { id: 'task-5', zentaoId: '950' }, { onChanged: () => { changed++; } });
    check('详情：已同步禅道的附件显示「上传中」', /上传中/.test(host.querySelector('.att-status').textContent) && !/待上传/.test(host.textContent));
    check('详情：上传中不显示「立即上传」按钮', host.querySelector('.att-panel-retry').hidden);
    win.__state.items = [{ key: 'zentao:320', source: 'zentao', zentaoFileId: '320', name: 'p.png', size: 1, kind: 'image', status: 'uploaded' }];
    await win.__api.AttachmentPanel.refresh(host, { id: 'task-5', zentaoId: '950' });
    check('详情：上传完成后不再显示状态，并通知列表刷新', !host.querySelector('.att-status') && changed === 1, `changed=${changed}`);
  }
  {
    // 未同步到禅道 / 禅道不可达
    const win = setup({ items: [{ key: 'local:a', source: 'local', localId: 'a', name: 'a.png', size: 1, kind: 'image', status: 'pending' }], zentaoId: null });
    const host = win.document.createElement('div');
    win.document.body.appendChild(host);
    await win.__api.AttachmentPanel.mount(host, { id: 'task-2' });
    check('详情：未同步到禅道时提示「同步后自动上传」', /同步到禅道后自动上传/.test(host.querySelector('.att-panel-notice').textContent));
    check('详情：未同步时不显示「立即上传」', host.querySelector('.att-panel-retry').hidden);
    win.__state.remoteError = '无法连接禅道';
    await win.__api.AttachmentPanel.refresh(host, { id: 'task-2', zentaoId: '1' });
    check('详情：禅道不可达时提示并可重试', /无法读取禅道里的附件：无法连接禅道/.test(host.textContent) && !!host.querySelector('.att-reload'));
  }

  {
    // 没有附件时不提示错误：禅道读不到 / 后端列表读不到，都只显示「暂无附件」
    const win = setup({ items: [], remoteError: '读取禅道任务 #950 失败（禅道要求跳转到 /zentao/execution-kanban-149.json）' });
    const host = win.document.createElement('div');
    win.document.body.appendChild(host);
    await win.__api.AttachmentPanel.mount(host, { id: 'task-3', zentaoId: '950' });
    check('无附件 + 禅道读取失败：不显示错误，只显示暂无附件', host.querySelector('.att-panel-notice').hidden && /暂无附件/.test(host.textContent) && !/失败/.test(host.textContent), host.textContent.replace(/\s+/g, ' '));
    win.fetch = async () => { throw new Error('Failed to fetch'); };
    const host2 = win.document.createElement('div');
    win.document.body.appendChild(host2);
    await win.__api.AttachmentPanel.mount(host2, { id: 'task-4', zentaoId: '1' });
    check('无附件 + 附件列表读取失败：不显示错误', /暂无附件/.test(host2.textContent) && !/失败/.test(host2.textContent), host2.textContent.replace(/\s+/g, ' '));
    check('无附件时不出现错误 Toast', !win.__toasts.some(t => t[0] === 'error' || t[0] === 'warning'), JSON.stringify(win.__toasts));
  }

  // ============ 确认框修复 ============
  {
    const win = setup();
    const { Confirm } = win.__api;
    const doc = win.document;
    const p1 = Confirm.show('删除 A', '确定删除 A？');
    doc.getElementById('confirmCancel').click();
    const r1 = await Promise.race([p1, tick(50).then(() => 'pending')]);
    check('确认框：点取消会结算为 false（原来一直挂起）', r1 === false, String(r1));
    const p2 = Confirm.show('删除 B', '确定删除 B？');
    doc.getElementById('confirmOk').click();
    const r2 = await p2;
    check('确认框：取消过的确认不会被下一次「确定」连带触发', r2 === true && r1 === false);
    // 新的确认顶掉未结算的旧确认
    const p3 = Confirm.show('C', 'C?');
    const p4 = Confirm.show('D', 'D?');
    const r3 = await Promise.race([p3, tick(50).then(() => 'pending')]);
    doc.getElementById('confirmOk').click();
    check('确认框：被顶掉的旧确认按取消处理，只有新的生效', r3 === false && (await p4) === true && doc.getElementById('confirmDialog').classList.contains('active') === false);
  }

  // ============ 进度弹窗修复与完成附件 ============
  {
    const win = setup();
    const { ProgressInputDialog } = win.__api;
    const doc = win.document;
    const p1 = ProgressInputDialog.show('更新进度', '50%', '', '', '默认', 1);
    check('进度弹窗：非完成时不显示附件区', doc.getElementById('progressInputAttachments').hidden === true);
    doc.getElementById('progressInputCancel').click();
    const r1 = await Promise.race([p1, tick(50).then(() => 'pending')]);
    check('进度弹窗：点取消结算为 null（原来一直挂起、进度不回滚）', r1 === null, String(r1));

    const p2 = ProgressInputDialog.show('更新进度', '100%', '', '', '完成', 1, { allowAttachments: true });
    check('进度弹窗：完成时显示附件区', doc.getElementById('progressInputAttachments').hidden === false);
    ProgressInputDialog.picker.add([fakeFile(win, '验证.png', 10, 'image/png')]);
    doc.getElementById('progressInputOk').click();
    const r2 = await p2;
    check('进度弹窗：确定后返回所选附件', r2 && r2.attachments.length === 1 && r2.attachments[0].name === '验证.png' && r2.work === '完成', JSON.stringify(r2 && { work: r2.work, n: r2.attachments.length }));
    check('进度弹窗：返回后清空附件区', ProgressInputDialog.picker.count === 0);
  }

  // ============ 解决 Bug：附件暂扣上传、随解决提交 ============
  async function runResolve({ resolveResponse, uploadFails }) {
    const win = setup({ uploadFails }, `
      window.__bm = {
        bugs: [{ id: 'bug-1', zentaoId: 516, executionId: '167' }],
        resolveAttachmentPicker: new AttachmentPicker(document.getElementById('resolveAttachments')),
        updateBugStatus: async () => { window.__updated = true; },
        hideResolveModal() { window.__hidden = true; },
        hideBugDetail() {},
        ${extractMethod('BugManager', 'resolveBug')}
      };
    `);
    win.__sent = [];
    win.chrome = { runtime: { sendMessage: async (msg) => { win.__sent.push(msg); return resolveResponse; } } };
    // fetch /api/zentao/config 也要能答
    const baseFetch = win.fetch;
    win.fetch = async (url, init) => /\/api\/zentao\/config$/.test(new URL(String(url)).pathname)
      ? { ok: true, json: async () => ({ success: true, data: { url: 'http://z.test/' } }) }
      : baseFetch(url, init);
    win.document.getElementById('resolveResolution').value = 'fixed';
    win.__bm.resolveAttachmentPicker.add([fakeFile(win, '验证.png', 10, 'image/png'), fakeFile(win, 'log.txt', 5)]);
    await win.__bm.resolveBug('bug-1');
    return win;
  }
  {
    const win = await runResolve({ resolveResponse: { success: true } });
    const ups = win.__state.requests.filter(r => r.method === 'POST' && /\/attachments$/.test(r.path));
    check('解决 Bug：附件以「暂扣」方式先存进本地附件区', ups.length === 2 && ups.every(u => u.query.hold === '1' && !u.query.inline), JSON.stringify(ups.map(u => u.query)));
    const msg = win.__sent[0] || {};
    check('解决 Bug：解决请求带上本地 Bug ID 与附件 ID', msg.localId === 'bug-1' && Array.isArray(msg.attachmentIds) && msg.attachmentIds.length === 2, JSON.stringify(msg));
    check('解决 Bug：成功后更新状态并关闭弹窗', win.__updated && win.__hidden);
  }
  {
    const win = await runResolve({ resolveResponse: { success: false, message: '解决方案不合法' } });
    const dels = win.__state.requests.filter(r => r.method === 'DELETE');
    check('解决失败：回收这次暂扣的附件', dels.length === 2);
    check('解决失败：提示禅道给出的原因（不再是「未知错误」）', win.__toasts.some(t => t[0] === 'error' && /解决方案不合法/.test(t[1])), JSON.stringify(win.__toasts));
  }
  {
    const win = await runResolve({ resolveResponse: { success: true }, uploadFails: ['log.txt'] });
    check('附件没存进去：不提交解决，并回收已存的附件', win.__sent.length === 0 && win.__state.requests.filter(r => r.method === 'DELETE').length === 1);
  }

  for (const r of results) {
    console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${r.pass || !r.extra ? '' : `   → ${r.extra}`}`);
  }
  const passed = results.filter(r => r.pass).length;
  console.log(`\n${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
