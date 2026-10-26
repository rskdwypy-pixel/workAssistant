#!/usr/bin/env node
/**
 * 回归测试：协作（评论 / 转交任务 / 操作历史）
 * 临时数据目录 + 模拟禅道（替换 globalThis.fetch），不访问网络。
 *
 * 覆盖：评论请求的内容（HTML 转义、换行）、旧版 / 新版的地址差异、提交后回读确认（禅道静默失败时不能报成功）、
 *       空内容 / 超长 / 非法参数、转交任务带上执行 ID 和预计剩余（新版缺了会失败还清空指派人）、
 *       已完成的任务不能转交、操作历史（新的在前、备注转纯文本、姓名）
 */
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });

const zt = { version: '22.3', task: null, actions: [], posts: [], acceptComment: true, acceptAssign: true };
const json = (o, h = {}) => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json', ...h } });
const zj = (inner) => json({ status: 'success', data: JSON.stringify(inner) });
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (!url.startsWith('http://z.test') && !url.startsWith('http://old.test')) return new Response('', { status: 404 });
  if (url.includes('mode=getconfig')) return json({ version: url.startsWith('http://old.test') ? '18.3' : '22.3' });
  if (url.includes('user-refreshRandom')) return new Response('1234');
  if (url.includes('user-login') && (init.method || 'GET') === 'GET') return new Response('<html></html>', { headers: { 'Set-Cookie': 'zentaosid=s1; path=/' } });
  if (url.includes('user-login')) return json({ result: 'success' }, { 'Set-Cookie': 'za=u; path=/' });
  const method = (init.method || 'GET').toUpperCase();
  if (method === 'POST') {
    const body = new URLSearchParams(String(init.body));
    zt.posts.push({ url: url.replace(/^http:\/\/[^/]+\/zentao\//, ''), body: Object.fromEntries(body) });
    if (url.includes('action-comment-')) {
      if (zt.acceptComment) zt.actions.push({ id: String(zt.actions.length + 100), actor: 'me', action: 'commented', date: '2026-10-26 12:00:00', comment: body.get('comment') });
      return new Response('<html><script>parent.location.reload()</script></html>');
    }
    if (url.includes('task-assignTo-')) {
      if (zt.acceptAssign && body.get('left') !== null && body.get('left') !== '') { zt.task.assignedTo = body.get('assignedTo'); zt.actions.push({ id: String(zt.actions.length + 100), actor: 'me', action: 'assigned', date: '2026-10-26 12:01:00', extra: body.get('assignedTo'), comment: body.get('comment') }); return json({ result: 'success' }); }
      if (url.startsWith('http://z.test')) zt.task.assignedTo = '';   // 新版缺了 left 会失败还把指派人清空
      return json({ result: 'fail', message: { left: '『预计剩余』不能为空。' } });
    }
  }
  const tv = url.match(/task-view-(\d+)\.json/);
  if (tv) return zj({ task: zt.task, actions: zt.actions });
  if (url.match(/(bug|story)-view-\d+\.json/)) return zj({ [url.match(/(bug|story)-view/)[1]]: { id: 1 }, actions: zt.actions });
  return new Response('not mocked ' + url, { status: 404 });
};

const tmp = mkdtempSync(join(tmpdir(), 'wa-collab-'));
const { config } = await import('../src/config.js');
config.paths.data = tmp;
Object.assign(config.zentao, { enabled: true, url: 'http://z.test', username: 'me', password: 'pw', users: { me: '我', yangkai: '杨凯' } });
const Z = await import('../src/services/zentaoService.js');
const useVersion = (v) => { config.zentao.url = v === '18.3' ? 'http://old.test' : 'http://z.test'; };
const reset = (version = '22.3') => {
  useVersion(version); zt.version = version; zt.acceptComment = true; zt.acceptAssign = true; zt.posts = [];
  zt.task = { id: 7, execution: 167, status: 'doing', left: '2.50', assignedTo: 'me' };
  zt.actions = [{ id: '1', actor: 'yangkai', action: 'opened', date: '2026-10-26 09:00:00' }, { id: '2', actor: 'me', action: 'commented', date: '2026-10-26 10:00:00', comment: '<p>先看看<br />再说 &amp; 好的</p>' }];
};

try {
  // ---------- 评论 ----------
  reset();
  let r = await Z.addComment('task', 7, '收到\n第二行 <b>粗</b> & 符号');
  const p = zt.posts[0];
  check('评论成功：回读到多了一条备注', r.success && /已添加/.test(r.message), JSON.stringify(r));
  check('新版评论走 .json，纯文本被转成安全的 HTML（转义 + 换行变 <br>）', p.url.startsWith('action-comment-task-7.json') && p.body.comment === '收到<br />第二行 &lt;b&gt;粗&lt;/b&gt; &amp; 符号' && !!p.body.uid, JSON.stringify(p));
  useVersion('18.3'); zt.posts = [];
  r = await Z.addComment('bug', 9, 'hi');
  check('旧版评论走 .html', zt.posts[0].url.startsWith('action-comment-bug-9.html'), JSON.stringify(zt.posts));
  check('支持需求', (await Z.addComment('story', 3, 'ok')).success);
  useVersion('22.3'); zt.acceptComment = false;
  r = await Z.addComment('task', 7, '禅道静默不收');
  check('禅道没有真的加上这条备注：不能报成功', !r.success && /没有接受/.test(r.message), JSON.stringify(r));
  zt.acceptComment = true;
  check('空内容被拒绝', !(await Z.addComment('task', 7, '  \n ')).success);
  check('超长被拒绝', /太长/.test((await Z.addComment('task', 7, 'x'.repeat(5001))).message));
  check('非法类型 / 编号被拒绝', !(await Z.addComment('user', 7, 'a')).success && !(await Z.addComment('task', 'x1', 'a')).success);

  // ---------- 历史 ----------
  reset();
  const h = await Z.getObjectHistory('task', 7);
  check('历史：新的在前，带姓名', h.length === 2 && h[0].action === 'commented' && h[0].actorName === '我' && h[1].actorName === '杨凯', JSON.stringify(h));
  check('历史：备注转成纯文本（标签、换行、实体）', h[0].comment === '先看看\n再说 & 好的', JSON.stringify(h[0].comment));
  check('历史：参数不合法时报错', await Z.getObjectHistory('x', 1).then(() => false, () => true));

  // ---------- 转交 ----------
  reset();
  r = await Z.assignTask({ taskId: 7, assignedTo: 'yangkai', comment: '你来跟一下' });
  const a = zt.posts[0];
  check('转交成功：回读指派人已变', r.success && zt.task.assignedTo === 'yangkai', JSON.stringify(r));
  check('转交请求带执行 ID、预计剩余、备注、指派人（新版缺预计剩余会失败）', a.url.startsWith('task-assignTo-167-7.json') && a.body.left === '2.5' && a.body.comment === '你来跟一下' && a.body.assignedTo === 'yangkai', JSON.stringify(a));
  reset('18.3'); zt.posts = [];
  r = await Z.assignTask({ taskId: 7, assignedTo: 'yangkai' });
  check('旧版转交走 .html', r.success && zt.posts[0].url.startsWith('task-assignTo-167-7.html'));
  reset(); zt.acceptAssign = false;
  r = await Z.assignTask({ taskId: 7, assignedTo: 'yangkai' });
  check('禅道没接受：报失败并带原因', !r.success && /预计剩余/.test(r.message), JSON.stringify(r));
  reset(); zt.task.status = 'done';
  r = await Z.assignTask({ taskId: 7, assignedTo: 'yangkai' });
  check('已完成的任务不能转交，也没有发请求', !r.success && /不能转交/.test(r.message) && zt.posts.length === 0);
  check('没选人 / 非法编号被拒绝', !(await Z.assignTask({ taskId: 7, assignedTo: '' })).success && !(await Z.assignTask({ taskId: 'a', assignedTo: 'x' })).success);
} catch (err) {
  check(`异常：${err.stack}`, false);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

for (const x of results) console.log(`  ${x.pass ? '✓' : '✗'} ${x.name}${x.pass || !x.extra ? '' : `   → ${String(x.extra).slice(0, 300)}`}`);
const passed = results.filter(x => x.pass).length;
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
