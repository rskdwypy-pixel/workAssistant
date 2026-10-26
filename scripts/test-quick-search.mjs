#!/usr/bin/env node
/**
 * 回归测试：全局搜索（⌘K）后端
 * 临时数据目录 + 预置本地任务 / 需求 / 文档缓存 + 模拟禅道全局搜索（替换 globalThis.fetch）。
 *
 * 覆盖：本地阶段（任务 / Bug / 需求 / 文档，大小写不敏感，编号精确匹配排最前，标题开头匹配其次）、
 *       没有缓存时不卡住（直接返回空）、禅道搜索阶段（任务 / Bug，至少 2 个字，纯编号不去搜）、
 *       一边失败不影响另一边、没配置禅道时跳过、每组最多 8 条
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });

const zt = { searchCalls: [], failBugSearch: false };
const json = (o, h = {}) => new Response(JSON.stringify(o), { headers: { 'Content-Type': 'application/json', ...h } });
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (!url.startsWith('http://z.test')) return new Response('', { status: 404 });
  if (url.includes('mode=getconfig')) return json({ version: '18.3' });
  if (url.includes('user-refreshRandom')) return new Response('1234');
  if (url.includes('user-login') && (init.method || 'GET') === 'GET') return new Response('<html></html>', { headers: { 'Set-Cookie': 'zentaosid=s1; path=/' } });
  if (url.includes('user-login')) return json({ result: 'success' }, { 'Set-Cookie': 'za=u; path=/' });
  if (url.includes('search-index.json')) {
    const words = decodeURIComponent((url.match(/words=([^&]*)/) || [])[1] || '');
    zt.searchCalls.push(words);
    return json({ status: 'success', data: JSON.stringify({ results: [
      { objectType: 'task', objectID: 901, title: `服务端任务 <span>${words}</span>`, summary: '摘要', editedDate: '2026-10-20 10:00:00' },
      { objectType: 'task', objectID: 3, title: `本地也有的任务 ${words}`, summary: '', editedDate: '2026-10-21 10:00:00' },
      { objectType: 'bug', objectID: 801, title: `服务端 Bug ${words}`, summary: '', editedDate: '2026-10-22 10:00:00' }
    ] }) });
  }
  return new Response('not mocked ' + url, { status: 404 });
};

const tmp = mkdtempSync(join(tmpdir(), 'wa-qs-'));
const { config } = await import('../src/config.js');
config.paths.data = tmp;
config.paths.tasks = join(tmp, 'tasks.json');
config.paths.history = join(tmp, 'history.json');
Object.assign(config.zentao, { enabled: true, url: 'http://z.test', username: 'me', password: 'pw' });
const mk = (id, title, type, status, updatedAt) => ({ id: `l${id}`, zentaoId: String(id), type, title, status, updatedAt });
writeFileSync(join(tmp, 'tasks.json'), JSON.stringify({ tasks: [
  mk(1, '登录页白屏问题', 'bug', 'activated', '2026-10-20T10:00:00Z'),
  mk(2, '修复登录超时', 'task', 'in_progress', '2026-10-21T10:00:00Z'),
  mk(3, '本地也有的任务 登录', 'task', 'todo', '2026-10-22T10:00:00Z'),
  mk(44, '不相关', 'task', 'todo', '2026-10-23T10:00:00Z'),
  mk(45, 'Fix LOGIN crash', 'task', 'todo', '2026-10-24T10:00:00Z'),
  { id: 'x', type: 'task', title: '没同步的登录任务', status: 'todo' },    // 没有禅道编号：不出现
  ...Array.from({ length: 12 }, (_, i) => mk(100 + i, `批量任务登录${i}`, 'task', 'todo', `2026-10-0${(i % 9) + 1}T10:00:00Z`))
] }));

const { quickSearch } = await import('../src/services/quickSearch.js');
const { createCache } = await import('../src/services/zentaoCache.js');

try {
  // 预置缓存（必须在第一次搜索前：服务里的缓存对象会把文件内容留一份在内存里）
  createCache('stories').write({ items: [{ id: '50', title: '登录模块需求', statusLabel: '激活', productName: '真机拨测' }, { id: '51', title: '别的需求', statusLabel: '草稿', productName: 'X' }], syncedAt: Date.now() });
  createCache('docs').write({ items: [{ id: '70', title: '登录设计文档', typeLabel: 'Markdown', editedBy: 'lijc' }, { id: '71', title: '无关', typeLabel: '正文', editedBy: 'a' }], syncedAt: Date.now() });
  let r;

  // ---------- 本地阶段 ----------
  r = await quickSearch('登录');
  check('任务 / Bug / 需求 / 文档四组都能搜到，不相关的和没同步的不出现', r.tasks.some(t => t.id === '2') && r.bugs.some(b => b.id === '1') && r.stories.length === 1 && r.stories[0].id === '50' && r.docs.length === 1 && r.docs[0].id === '70' && !r.tasks.some(t => t.id === '44') && !r.tasks.some(t => t.title === '没同步的登录任务'), JSON.stringify(r).slice(0, 300));
  check('每条带类型、禅道编号、标题、状态说明', r.tasks[0].type === 'task' && /^\d+$/.test(r.tasks[0].id) && r.tasks[0].sub && r.bugs[0].sub === '已确认' && r.stories[0].sub === '激活 · 真机拨测' && r.docs[0].sub === 'Markdown · lijc');
  check('每组最多 8 条', r.tasks.length === 8);
  check('不分大小写（英文）', (await quickSearch('login')).tasks.some(t => t.id === '45') && (await quickSearch('LOGIN')).tasks.some(t => t.id === '45'));
  r = await quickSearch('#2');
  check('编号（#2 或 2）：按禅道编号精确匹配', r.tasks.length === 1 && r.tasks[0].id === '2', JSON.stringify(r.tasks));
  r = await quickSearch('3');
  check('编号精确匹配排在标题里恰好含这个数字的前面', r.tasks[0].id === '3');
  const t2 = await quickSearch('本地');
  check('标题以关键词开头的排在中间才包含的前面', t2.tasks[0].title.startsWith('本地'), JSON.stringify(t2.tasks.map(t => t.title)));
  check('空 / 全空格：什么都不返回', (await quickSearch('   ')).tasks.length === 0 && (await quickSearch('')).docs.length === 0);
  check('超长关键词被截断，不报错', (await quickSearch('登'.repeat(500))).query.length === 80);
  check('同一类里更新时间新的在前', (await quickSearch('批量任务登录')).tasks[0].title.startsWith('批量任务登录'));

  // ---------- 禅道搜索阶段 ----------
  zt.searchCalls = [];
  r = await quickSearch('登录', { scope: 'remote' });
  check('禅道阶段：任务和 Bug 各搜一次，返回服务端结果（标题里的高亮标签已去掉）', zt.searchCalls.length === 2 && r.tasks.some(t => t.id === '901' && t.title.includes('服务端任务') && !t.title.includes('<span>')) && r.bugs.some(b => b.id === '801') && r.tasks.every(t => t.local === false), JSON.stringify(r).slice(0, 260));
  zt.searchCalls = [];
  check('一个字不去搜（服务端要求至少 2 个字）', (await quickSearch('登', { scope: 'remote' })).tasks.length === 0 && zt.searchCalls.length === 0);
  check('纯编号不去搜', (await quickSearch('#944', { scope: 'remote' })).tasks.length === 0 && (await quickSearch('944', { scope: 'remote' })).bugs.length === 0 && zt.searchCalls.length === 0);
  const savedUrl = config.zentao.url;
  config.zentao.url = '';
  check('没配置禅道：禅道阶段直接返回空', (await quickSearch('登录', { scope: 'remote' })).tasks.length === 0);
  config.zentao.url = savedUrl;
} catch (err) {
  check(`异常：${err.stack}`, false);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

for (const x of results) console.log(`  ${x.pass ? '✓' : '✗'} ${x.name}${x.pass || !x.extra ? '' : `   → ${String(x.extra).slice(0, 300)}`}`);
const passed = results.filter(x => x.pass).length;
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
