/**
 * 真函数测试：禅道个人待办弹窗（前端）
 * jsdom 里原样执行 zentao-todo.js；fetch、Toast、Confirm 换成模拟（后端 /api/zentao-todos 的行为按真实接口约定）。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'extension', 'zentao-todo.js'), 'utf8');
const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

const BASE_TODO = { id: '7', name: '回电话', type: 'custom', objectId: '', pri: 2, status: 'wait', desc: '<p>内容</p><img src="http://127.0.0.1:3721/api/zentao-todos/file?path=%2Fzentao%2Ffile-read-1.png">', date: '2026-10-27', begin: '15:00', end: '15:30', private: true, assignedTo: 'me', cycle: false };

function setup({ todo = BASE_TODO, confirm = true } = {}) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  const s = { calls: [], toasts: [], changed: 0, opened: [], failNext: null, state: { ...todo } };
  win.fetch = async (url, init = {}) => {
    const u = String(url).replace('http://127.0.0.1:3721', '');
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    s.calls.push({ method, u, body });
    const reply = (data, ok = true, message = '') => ({ ok: true, status: 200, json: async () => (ok ? { success: true, data } : { success: false, message }) });
    if (s.failNext) { const m = s.failNext; s.failNext = null; return reply(null, false, m); }
    if (u === '/api/zentao/users') return { json: async () => ({ success: true, data: { me: '我', zhang: '张三' } }) };
    if (u.startsWith('/api/zentao-todos/candidates')) return reply([{ id: '856', title: '蔻驰小程序部署' }, { id: '991', title: '华夏银行破解' }]);
    if (u.startsWith('/api/zentao-todos/image')) return reply({ url: 'http://127.0.0.1:3721/api/zentao-todos/file?path=%2Fzentao%2Ffile-read-9.png' });
    if (method === 'GET' && /^\/api\/zentao-todos\/\d+$/.test(u)) return reply(s.state);
    if (method === 'POST' && u === '/api/zentao-todos') { s.state = { ...BASE_TODO, ...body, id: '99', status: 'wait', cycle: false }; return reply(s.state); }
    if (method === 'PUT') { s.state = { ...s.state, ...body }; return reply(s.state); }
    if (method === 'POST' && u.endsWith('/status')) { s.state = { ...s.state, status: body.status }; return reply(s.state); }
    if (method === 'DELETE') return reply({ success: true });
    return reply(null, false, 'not mocked ' + u);
  };
  win.Toast = { success: (m) => s.toasts.push('ok:' + m), error: (m) => s.toasts.push('err:' + m) };
  win.Confirm = { show: async () => confirm };
  win.TodoPage = { load: () => { s.changed++; } };
  win.openInZentao = (t, id) => s.opened.push(`${t}:${id}`);
  win.eval(`const API_BASE_URL='http://127.0.0.1:3721';\n${SRC}`);
  return { win, doc: win.document, s, Z: win.ZtTodo };
}
const box = (doc) => doc.querySelector('.zt-box');
const field = (doc, n) => box(doc).querySelector(`[name="${n}"]`);
const setv = (el, v) => { el.value = v; el.dispatchEvent(new el.ownerDocument.defaultView.Event('input', { bubbles: true })); el.dispatchEvent(new el.ownerDocument.defaultView.Event('change', { bubbles: true })); };
const click = (doc, sel) => box(doc).querySelector(sel).click();

(async () => {
  // ---------- 描述清洗 ----------
  let { Z } = setup();
  const dirty = '<p onclick="x()">你好<script>alert(1)</script></p><img src="javascript:alert(1)"><img src="https://a/b.png" onerror="x()" alt="图"><a href="javascript:evil()">坏</a><a href="https://ok.example/">好</a><iframe src="x"></iframe><font color="red">字</font>';
  const clean = Z.sanitize(dirty);
  check('清洗：去掉脚本 / 事件属性 / javascript: 链接 / iframe，保留正常图片和链接', !/script|onclick|onerror|javascript:|iframe/i.test(clean) && clean.includes('https://a/b.png') && clean.includes('https://ok.example/') && clean.includes('你好'));
  check('清洗：未知标签留内容、去外壳；链接带 noopener', clean.includes('字') && !/<font/i.test(clean) && /rel="noopener noreferrer"/.test(clean));
  check('清洗：空 / null 安全', Z.sanitize('') === '' && Z.sanitize(null) === '');
  check('下一步按钮：未开始→开始，进行中→完成，其它→重做', Z.nextAction('wait').to === 'doing' && Z.nextAction('doing').to === 'done' && Z.nextAction('done').to === 'wait' && Z.nextAction('closed').to === 'wait');

  // ---------- 新建 ----------
  let { doc, s, win } = setup();
  Z = win.ZtTodo;
  await Z.open(); await tick(10);
  check('新建：弹窗里有 类型 / 优先级 / 状态 / 指派给 / 名称 / 日期 / 时间 / 私人 / 描述', ['type', 'pri', 'status', 'assignedTo', 'name', 'date', 'begin', 'end', 'private'].every(n => field(doc, n)) && box(doc).querySelector('.zt-desc'));
  check('新建：类型选项是 自定义 / 任务 / Bug / 需求；指派给默认“我自己”，列出同事', [...field(doc, 'type').options].map(o => o.value).join() === 'custom,task,bug,story' && field(doc, 'assignedTo').options[0].textContent === '我自己' && [...field(doc, 'assignedTo').options].some(o => o.value === 'zhang'));
  check('新建：优先级默认 3，状态默认未开始，默认不设时间', field(doc, 'pri').value === '3' && field(doc, 'status').value === 'wait' && field(doc, 'notime').checked && field(doc, 'begin').disabled);
  click(doc, '[data-zt="save"]'); await tick();
  check('新建：名称为空 → 提示，不发请求', /请填写待办名称/.test(box(doc).querySelector('.zt-error').textContent) && !s.calls.some(c => c.method === 'POST'));
  setv(field(doc, 'name'), '给客户回电话'); setv(field(doc, 'pri'), '1'); setv(field(doc, 'assignedTo'), 'zhang');
  field(doc, 'private').checked = true;
  field(doc, 'notime').checked = false; field(doc, 'notime').dispatchEvent(new win.Event('change'));
  setv(field(doc, 'begin'), '15:00');
  click(doc, '[data-zt="save"]'); await tick();
  check('新建：填了开始没填结束 → 提示', /开始和结束时间/.test(box(doc).querySelector('.zt-error').textContent));
  setv(field(doc, 'end'), '14:00'); click(doc, '[data-zt="save"]'); await tick();
  check('新建：结束早于开始 → 提示', /不能早于/.test(box(doc).querySelector('.zt-error').textContent));
  setv(field(doc, 'end'), '15:30');
  box(doc).querySelector('.zt-desc').innerHTML = '<p>备注</p>';
  setv(field(doc, 'status'), 'doing');
  click(doc, '[data-zt="save"]'); await tick(20);
  const post = s.calls.find(c => c.method === 'POST' && c.u === '/api/zentao-todos');
  check('新建：提交的字段（类型 / 名称 / 优先级 / 指派 / 私人 / 日期时间 / 描述 / 编辑会话）', post && post.body.type === 'custom' && post.body.name === '给客户回电话' && post.body.pri === 1 && post.body.assignedTo === 'zhang' && post.body.private === true && post.body.begin === '15:00' && post.body.end === '15:30' && post.body.desc === '<p>备注</p>' && /^wa\d+/.test(post.body.uid), JSON.stringify(post && post.body));
  check('新建：选了“进行中” → 创建后再改状态', s.calls.some(c => c.u === '/api/zentao-todos/99/status' && c.body.status === 'doing'));
  check('新建：成功后关闭弹窗、提示、刷新待办页', !doc.querySelector('.zt-overlay') && s.toasts.includes('ok:待办已创建') && s.changed === 1);

  // 待定日期
  ({ doc, s, win } = setup()); Z = win.ZtTodo;
  await Z.open(); await tick(10);
  setv(field(doc, 'name'), '长期事项'); field(doc, 'nodate').checked = true; field(doc, 'nodate').dispatchEvent(new win.Event('change'));
  check('勾“待定”：日期输入框不可用', field(doc, 'date').disabled);
  click(doc, '[data-zt="save"]'); await tick(20);
  const p2 = s.calls.find(c => c.method === 'POST' && c.u === '/api/zentao-todos');
  check('待定 + 不设时间：提交空日期、空时间', p2 && p2.body.date === '' && p2.body.begin === '' && p2.body.end === '');

  // 关联任务
  ({ doc, s, win } = setup()); Z = win.ZtTodo;
  await Z.open(); await tick(10);
  setv(field(doc, 'type'), 'task'); await tick(20);
  check('选“任务”：出现关联对象列表（读自后端候选），名称输入隐藏', !box(doc).querySelector('.zt-link').hidden && box(doc).querySelector('.zt-name-row').hidden && field(doc, 'objectId').options.length === 2 && s.calls.some(c => c.u === '/api/zentao-todos/candidates?type=task'));
  click(doc, '[data-zt="save"]'); await tick();
  check('关联任务：没选 → 提示', field(doc, 'objectId').value === '856' ? true : /请选择关联的任务/.test(box(doc).querySelector('.zt-error').textContent));
  setv(field(doc, 'filter'), '华夏'); await tick();
  check('关联对象可按关键字筛选', field(doc, 'objectId').options.length === 1 && field(doc, 'objectId').options[0].value === '991');
  setv(field(doc, 'objectId'), '991'); click(doc, '[data-zt="save"]'); await tick(20);
  const p3 = s.calls.find(c => c.method === 'POST' && c.u === '/api/zentao-todos');
  check('关联任务：提交 type=task 和 objectId', p3 && p3.body.type === 'task' && p3.body.objectId === '991', JSON.stringify(p3 && p3.body));

  // ---------- 编辑 ----------
  ({ doc, s, win } = setup()); Z = win.ZtTodo;
  await Z.open({ id: '7' }); await tick(10);
  check('编辑：带出已有的 名称 / 优先级 / 日期 / 时间 / 私人', field(doc, 'name').value === '回电话' && field(doc, 'pri').value === '2' && field(doc, 'date').value === '2026-10-27' && field(doc, 'begin').value === '15:00' && field(doc, 'private').checked && !field(doc, 'notime').checked);
  check('编辑：描述里的图片显示出来（走本地代理地址）', box(doc).querySelector('.zt-desc img') && box(doc).querySelector('.zt-desc img').src.includes('/api/zentao-todos/file'));
  check('编辑：有“删除”和“在禅道打开”', box(doc).querySelector('[data-zt="delete"]') && box(doc).querySelector('[data-zt="open"]'));
  click(doc, '[data-zt="open"]'); check('在禅道打开：用 todo 类型', s.opened.join() === 'todo:7');
  setv(field(doc, 'pri'), '4'); click(doc, '[data-zt="save"]'); await tick(20);
  check('编辑：保存走 PUT，状态没变不再调状态接口', s.calls.some(c => c.method === 'PUT' && c.u === '/api/zentao-todos/7' && c.body.pri === 4) && !s.calls.some(c => c.u.endsWith('/status')));

  // 保存失败：保留弹窗和内容
  ({ doc, s, win } = setup()); Z = win.ZtTodo;
  await Z.open({ id: '7' }); await tick(10);
  setv(field(doc, 'name'), '新名字'); s.failNext = '禅道没有接受这次修改';
  click(doc, '[data-zt="save"]'); await tick(20);
  check('保存失败：弹窗保留、内容保留、显示原因、按钮可再点', doc.querySelector('.zt-overlay') && field(doc, 'name').value === '新名字' && /没有接受/.test(box(doc).querySelector('.zt-error').textContent) && !box(doc).querySelector('[data-zt="save"]').disabled);

  // 删除
  ({ doc, s, win } = setup({ confirm: false })); Z = win.ZtTodo;
  await Z.open({ id: '7' }); await tick(10);
  click(doc, '[data-zt="delete"]'); await tick(10);
  check('删除：确认框点取消 → 不删除', !s.calls.some(c => c.method === 'DELETE') && doc.querySelector('.zt-overlay'));
  ({ doc, s, win } = setup({ confirm: true })); Z = win.ZtTodo;
  await Z.open({ id: '7' }); await tick(10);
  click(doc, '[data-zt="delete"]'); await tick(20);
  check('删除：确认后删除、关闭、刷新', s.calls.some(c => c.method === 'DELETE' && c.u === '/api/zentao-todos/7') && !doc.querySelector('.zt-overlay') && s.changed === 1);

  // 周期待办
  ({ doc, s, win } = setup({ todo: { ...BASE_TODO, type: 'cycle', cycle: true, status: 'doing' } })); Z = win.ZtTodo;
  await Z.open({ id: '7' }); await tick(10);
  check('周期待办：只读提示，名称 / 类型不可改，状态可改', /周期待办/.test(box(doc).textContent) && field(doc, 'name').disabled && field(doc, 'type').disabled && !field(doc, 'status').disabled && box(doc).querySelector('.zt-desc').getAttribute('contenteditable') === 'false');
  setv(field(doc, 'status'), 'done'); click(doc, '[data-zt="save"]'); await tick(20);
  check('周期待办：只调状态接口，不走编辑', s.calls.some(c => c.u === '/api/zentao-todos/7/status' && c.body.status === 'done') && !s.calls.some(c => c.method === 'PUT'));

  // 读取失败
  ({ doc, s, win } = setup()); Z = win.ZtTodo; s.failNext = '待办不存在或没有权限';
  await Z.open({ id: '7' }); await tick(10);
  check('读取失败：显示原因，可关闭', /不存在/.test(box(doc).textContent) && box(doc).querySelector('[data-zt="cancel"]'));
  click(doc, '[data-zt="cancel"]'); check('关闭按钮有效', !doc.querySelector('.zt-overlay'));

  // ---------- 描述里粘贴截图 ----------
  ({ doc, s, win } = setup()); Z = win.ZtTodo;
  await Z.open(); await tick(10);
  const desc = box(doc).querySelector('.zt-desc');
  const file = new win.File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
  const ev = new win.Event('paste', { bubbles: true, cancelable: true }); ev.clipboardData = { files: [file] };
  desc.dispatchEvent(ev); await tick(20);
  const up = s.calls.find(c => c.u.startsWith('/api/zentao-todos/image'));
  check('粘贴截图：上传到后端（带编辑会话编号），插入图片', up && /uid=wa\d+/.test(up.u) && desc.querySelector('img') && desc.querySelector('img').src.includes('file-read-9') && !desc.querySelector('.zt-uploading') && ev.defaultPrevented);
  setv(field(doc, 'name'), '带图'); click(doc, '[data-zt="save"]'); await tick(20);
  const p4 = s.calls.find(c => c.method === 'POST' && c.u === '/api/zentao-todos');
  const uidInUpload = (up.u.match(/uid=(wa\d+)/) || [])[1];
  check('保存：描述含图片，且编辑会话编号和上传时一致（禅道据此归档图片）', p4 && p4.body.desc.includes('<img') && p4.body.uid === uidInUpload);
  const ev2 = new win.Event('paste', { bubbles: true, cancelable: true }); ev2.clipboardData = { files: [new win.File(['x'], 'a.txt', { type: 'text/plain' })] };
  desc.dispatchEvent(ev2);
  check('粘贴非图片：不拦截（按普通文字粘贴）', !ev2.defaultPrevented);

  let bad = 0;
  for (const r of results) { console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${!r.pass && r.extra ? '\n      ' + r.extra : ''}`); if (!r.pass) bad++; }
  console.log(`\n${results.length - bad}/${results.length} 通过`);
  process.exit(bad ? 1 : 0);
})();
