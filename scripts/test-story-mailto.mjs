#!/usr/bin/env node
/**
 * 回归测试：「我的需求」里的抄送列表
 * 禅道的 my-story-mailto 不按抄送过滤、会返回所有需求（真实环境：155 条里 0 条抄送了我），
 * 所以必须用需求自己的 mailto 字段把关；Bug 的 mailto 列表是准的，不能被误过滤。
 */
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });
const json = (o, h = {}) => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json', ...h } });
const zj = (inner) => json({ status: 'success', data: JSON.stringify(inner) });
const STORIES = [
  { id: 1, title: '抄送了我', mailto: ',lijc,wangwu', status: 'active', assignedTo: 'x', openedBy: 'x' },
  { id: 2, title: '没抄送', mailto: '', status: 'active', assignedTo: 'x', openedBy: 'x' },
  { id: 3, title: '抄送了别人（账号只是包含 lijc）', mailto: ',lijc2,mylijc', status: 'active', assignedTo: 'x', openedBy: 'x' },
  { id: 4, title: '大小写', mailto: 'LIJC', status: 'active', assignedTo: 'x', openedBy: 'x' },
  { id: 5, title: 'mailto 为 null', mailto: null, status: 'active', assignedTo: 'x', openedBy: 'x' }
];
const BUGS = [{ id: 9, title: 'Bug 抄送', mailto: ',lijc', status: 'active' }, { id: 10, title: 'Bug 抄送(字段没带)', status: 'active' }];
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (!url.startsWith('http://z.test')) return new Response('', { status: 404 });
  if (url.includes('mode=getconfig')) return json({ version: '22.3' });
  if (url.includes('user-refreshRandom')) return new Response('1234');
  if (url.includes('user-login') && (init.method || 'GET') === 'GET') return new Response('<html></html>', { headers: { 'Set-Cookie': 'zentaosid=s1; path=/' } });
  if (url.includes('user-login')) return json({ result: 'success' }, { 'Set-Cookie': 'za=u; path=/' });
  const m = url.match(/my-(story|bug)-(\w+)-/);
  if (m && m[1] === 'story') return zj({ stories: m[2] === 'mailto' ? STORIES : [STORIES[1]], users: {}, pager: { pageTotal: 1 } });
  if (m && m[1] === 'bug') return zj({ bugs: BUGS, users: {}, pager: { pageTotal: 1 } });
  return new Response('not mocked ' + url, { status: 404 });
};

const tmp = mkdtempSync(join(tmpdir(), 'wa-mailto-'));
const { config } = await import('../src/config.js');
config.paths.data = tmp;
Object.assign(config.zentao, { enabled: true, url: 'http://z.test', username: 'lijc', password: 'pw', users: {} });
const Z = await import('../src/services/zentaoService.js');

try {
  const cc = (await Z.fetchMyList('story', 'mailto')).items.map(s => s.id).sort();
  check('需求抄送列表：只留自己的抄送字段里真有我的（精确匹配账号，忽略大小写，null 安全）', cc.join() === '1,4', cc.join());
  const other = (await Z.fetchMyList('story', 'openedBy')).items.map(s => s.id);
  check('需求的其它关联列表（我提的等）不受影响', other.join() === '2', other.join());
  const bugs = (await Z.fetchMyList('bug', 'mailto')).items.map(s => s.id);
  check('Bug 的抄送列表是准的，不被误过滤', bugs.join() === '9,10', bugs.join());
} catch (err) {
  check('测试本身没有异常', false, err.stack);
}
let bad = 0;
for (const r of results) { console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${!r.pass && r.extra ? '\n      ' + r.extra : ''}`); if (!r.pass) bad++; }
console.log(`\n${results.length - bad}/${results.length} 通过`);
process.exit(bad ? 1 : 0);
