/**
 * 真函数测试：协作区（任务 / Bug 详情里的评论、转交、最近动态）
 * jsdom 加载真实 newtab.html，原样执行 collab.js；网络换成模拟。
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const EXT = path.join(__dirname, '..', 'extension');
const SRC = fs.readFileSync(path.join(EXT, 'collab.js'), 'utf8');
const HTML = fs.readFileSync(path.join(EXT, 'newtab.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

function setup(s) {
  const dom = new JSDOM(HTML, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  s.requests = []; s.toasts = []; s.changed = 0;
  s.history = s.history || [{ id: '2', actor: 'yangkai', actorName: '杨凯', action: 'commented', date: '2026-10-26 10:00:00', comment: '先看看\n再说' }, { id: '1', actor: 'yangkai', actorName: '杨凯', action: 'opened', date: '2026-10-26 09:00:00', comment: '' }];
  win.fetch = async (url, init = {}) => {
    const u = String(url).replace('http://127.0.0.1:3721', '');
    const body = init.body ? JSON.parse(init.body) : null;
    s.requests.push({ method: (init.method || 'GET').toUpperCase(), url: u, body });
    const reply = (b) => ({ ok: true, status: 200, json: async () => b });
    if (u.startsWith('/api/zentao/history')) return reply(s.historyFail ? { success: false, message: '读不到' } : { success: true, data: s.history });
    if (u === '/api/zentao/comment') return reply(s.commentResult || { success: true });
    if (u === '/api/zentao/task/assign') return reply(s.assignResult || { success: true });
    return reply({ success: false });
  };
  win.Toast = { success: (m) => s.toasts.push(m), error: (m) => s.toasts.push(m), info: (m) => s.toasts.push(m), warning: () => {} };
  win.ZentaoBrowserClient = { getUsers: async () => ({ lijc: '李佳成', yangkai: '杨凯', wangrui: '王锐' }) };
  win.eval(`var API_BASE_URL = 'http://127.0.0.1:3721';\n${SRC}\nwindow.CollabPanel = CollabPanel;`);
  const host = win.document.createElement('div');
  win.document.body.appendChild(host);
  return { win, doc: win.document, host };
}

(async () => {
  // 没同步到禅道
  let s = {};
  let { win, host } = setup(s);
  await win.CollabPanel.mount(host, { id: 'a', title: '本地任务' }, { type: 'task' });
  check('还没同步到禅道：只给一句提示，不发请求', /还没同步到禅道/.test(host.textContent) && /转交/.test(host.textContent) && s.requests.length === 0);

  // 任务：动态 + 评论 + 转交
  s = {};
  ({ win, host } = setup(s));
  const task = { id: 'a', zentaoId: 7, status: 'in_progress', assignedTo: 'lijc' };
  await win.CollabPanel.mount(host, task, { type: 'task', onChanged: () => { s.changed++; } });
  const items = [...host.querySelectorAll('.collab-item')];
  check('读取并显示最近动态：谁、做了什么、时间、备注内容', items.length === 2 && /杨凯/.test(items[0].textContent) && /备注/.test(items[0].textContent) && /10-26 10:00/.test(items[0].textContent) && /先看看\n?再说/.test(items[0].querySelector('.collab-comment').textContent) && /创建/.test(items[1].textContent), items.map(i => i.textContent).join(' | '));
  check('动态请求带类型和禅道编号', s.requests[0].url.startsWith('/api/zentao/history?type=task&id=7'));
  const opts = [...host.querySelectorAll('.collab-assignee option')].map(o => o.value);
  check('转交下拉：可选的人里不含当前指派人自己', opts.includes('yangkai') && opts.includes('wangrui') && !opts.includes('lijc'), opts.join(','));
  check('转交按钮：没选人时禁用', host.querySelector('.collab-assign').disabled);

  // 发备注
  host.querySelector('.collab-input').value = '收到，周三给';
  host.querySelector('.collab-send').click();
  await tick(30);
  const cm = s.requests.find(r => r.url === '/api/zentao/comment');
  check('发送备注：带类型、禅道编号、内容', cm && cm.body.type === 'task' && cm.body.id === '7' && cm.body.comment === '收到，周三给');
  check('发送成功：清空输入、提示、重新读取动态', host.querySelector('.collab-input').value === '' && s.toasts.some(t => /备注已添加/.test(t)) && s.requests.filter(r => r.url.startsWith('/api/zentao/history')).length === 2);
  host.querySelector('.collab-send').click();
  await tick(10);
  check('内容为空：不发请求', s.requests.filter(r => r.url === '/api/zentao/comment').length === 1);
  s.commentResult = { success: false, message: '没有权限' };
  host.querySelector('.collab-input').value = 'x';
  host.querySelector('.collab-send').click();
  await tick(30);
  check('发送失败：提示原因，输入内容保留（不丢）', s.toasts.some(t => /没有发出去：没有权限/.test(t)) && host.querySelector('.collab-input').value === 'x' && !host.querySelector('.collab-send').disabled);
  s.commentResult = null;
  // Ctrl+回车发送
  host.querySelector('.collab-input').value = '快捷键发送';
  host.querySelector('.collab-input').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  await tick(30);
  check('Ctrl/⌘ + 回车发送', s.requests.filter(r => r.url === '/api/zentao/comment').length === 3 && s.requests.filter(r => r.url === '/api/zentao/comment').pop().body.comment === '快捷键发送');

  // 转交
  host.querySelector('.collab-input').value = '这个你来跟一下';
  const sel = host.querySelector('.collab-assignee');
  sel.value = 'yangkai';
  sel.dispatchEvent(new win.Event('change'));
  check('选了人：转交按钮可点', !host.querySelector('.collab-assign').disabled);
  host.querySelector('.collab-assign').click();
  await tick(40);
  const as = s.requests.find(r => r.url === '/api/zentao/task/assign');
  check('转交：带禅道任务编号、指派人、备注（输入框里的话）', as && as.body.taskId === '7' && as.body.assignedTo === 'yangkai' && as.body.comment === '这个你来跟一下', JSON.stringify(as));
  check('转交成功：提示转给了谁、通知页面刷新', s.toasts.some(t => /已转交给 杨凯/.test(t)) && s.changed === 1);
  s.assignResult = { success: false, message: '预计剩余不能为空' };
  sel.value = 'wangrui'; sel.dispatchEvent(new win.Event('change'));
  host.querySelector('.collab-assign').click();
  await tick(40);
  check('转交失败：提示原因，不通知刷新', s.toasts.some(t => /没有转交成功：预计剩余不能为空/.test(t)) && s.changed === 1 && !host.querySelector('.collab-assign').disabled);

  // 已完成的任务 / Bug：没有转交
  s = {};
  ({ win, host } = setup(s));
  await win.CollabPanel.mount(host, { zentaoId: 8, status: 'done' }, { type: 'task' });
  check('已完成的任务：不显示转交', !host.querySelector('.collab-assignee') && !!host.querySelector('.collab-send'));
  s = {};
  ({ win, host } = setup(s));
  await win.CollabPanel.mount(host, { zentaoId: 9, status: 'activated' }, { type: 'bug' });
  check('Bug：能评论，这里不放转交（详情里已有指派人入口）', !host.querySelector('.collab-assignee') && !!host.querySelector('.collab-send') && s.requests[0].url.startsWith('/api/zentao/history?type=bug&id=9'));

  // 读取失败
  s = { historyFail: true };
  ({ win, host } = setup(s));
  await win.CollabPanel.mount(host, { zentaoId: 7, status: 'in_progress' }, { type: 'task' });
  check('读取动态失败：说明原因，评论框仍可用', /读取动态失败：读不到/.test(host.textContent) && !!host.querySelector('.collab-send'));

  // 没有历史
  s = { history: [] };
  ({ win, host } = setup(s));
  await win.CollabPanel.mount(host, { zentaoId: 7, status: 'in_progress' }, { type: 'task' });
  check('没有动态：说明还没有', /还没有动态/.test(host.textContent));

  // 转义
  s = { history: [{ id: '1', actor: 'a', actorName: '<img src=x onerror=alert(1)>', action: 'commented', date: '2026-10-26 10:00:00', comment: '<script>x</script>' }] };
  ({ win, host } = setup(s));
  await win.CollabPanel.mount(host, { zentaoId: 7, status: 'in_progress' }, { type: 'task' });
  check('动态里的姓名 / 备注一律转义（不执行别人写的 HTML）', !host.querySelector('img') && !host.querySelector('script') && /<script>x<\/script>/.test(host.querySelector('.collab-comment').textContent));

  // 接进详情页
  const newtab = fs.readFileSync(path.join(EXT, 'newtab.js'), 'utf8');
  check('任务详情和 Bug 详情都挂了协作区', /CollabPanel\.mount\(body\.querySelector\('\.collab-section'\), task/.test(newtab) && /CollabPanel\.mount\(content\.querySelector\('\.collab-section'\), bug/.test(newtab));
  check('页面引入了 collab.js', /<script src="collab\.js"><\/script>/.test(fs.readFileSync(path.join(EXT, 'newtab.html'), 'utf8')));

  for (const x of results) console.log(`  ${x.pass ? '✓' : '✗'} ${x.name}${x.pass || !x.extra ? '' : `   → ${String(x.extra).slice(0, 300)}`}`);
  const passed = results.filter(x => x.pass).length;
  console.log(`\n${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((err) => { console.error(err); process.exit(1); });
