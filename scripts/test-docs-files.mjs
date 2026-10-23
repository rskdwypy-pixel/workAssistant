/**
 * 真函数测试：给文档追加附件（docService.addDocFile + POST /api/docs/:id/files），模拟的禅道按真实实测（ZenTao 18.3）：
 *   - 附件走文档编辑表单：multipart 的 files[] + labels[]（标题 = 去掉扩展名的文件名），editedDate 照常回传
 *   - 禅道对不允许的类型 / 超限的文件静默不收（仍回成功）：必须回读附件数，没多就报错，不能报成功
 *   - 只有正文型文档可以追加
 */
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });

const zt = { realFetch: globalThis.fetch, posts: [], docs: {}, rejectExt: /\.(php|exe)$/i, nextFile: 500 };
const reset = () => {
  zt.posts = []; zt.nextFile = 500;
  zt.docs = {
    12: { id: '12', title: '接口说明', type: 'text', contentType: 'markdown', content: '正文', lib: '59', module: '0', editedDate: '2026-10-20 10:00:00', acl: 'open', files: [], deleted: '0' },
    20: { id: '20', title: '附件型', type: 'attachment', contentType: 'html', content: '', lib: '59', module: '0', editedDate: '2026-10-20 10:00:00', acl: 'open', files: [], deleted: '0' }
  };
};
const wrap = (o) => new Response(JSON.stringify({ status: 'success', data: JSON.stringify(o) }), { headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (!url.startsWith('http://z.test')) return zt.realFetch(input, init);
  const method = (init.method || 'GET').toUpperCase();
  if (url.includes('user-refreshRandom')) return new Response('1234');
  if (url.includes('user-login') && method === 'GET') return new Response('<html></html>', { headers: { 'Set-Cookie': 'zentaosid=sid1; path=/' } });
  if (url.includes('user-login')) return new Response(JSON.stringify({ result: 'success' }), { headers: { 'Content-Type': 'application/json' } });
  let m;
  if ((m = url.match(/doc-view-(\d+)\.json/))) return wrap({ doc: zt.docs[m[1]], lib: { id: '59', type: 'custom' } });
  if ((m = url.match(/doc-edit-(\d+)-false-custom-0-59\.html/)) && method === 'POST') {
    const doc = zt.docs[m[1]];
    const fields = {}; const files = [], labels = [];
    for (const [k, v] of init.body.entries()) {
      if (k === 'files[]') files.push(v); else if (k === 'labels[]') labels.push(v); else fields[k] = v;
    }
    zt.posts.push({ id: m[1], fields, files: files.map(f => f.name), labels, xhr: new Headers(init.headers).get('x-requested-with') });
    files.forEach((f, i) => { if (!zt.rejectExt.test(f.name)) doc.files.push({ id: String(zt.nextFile++), title: labels[i], extension: f.name.split('.').pop(), size: f.size }); });
    return new Response(JSON.stringify({ result: 'success', message: '保存成功' }));
  }
  return new Response('not found', { status: 404 });
};

const tmp = mkdtempSync(join(tmpdir(), 'wa-docfiles-'));
process.env.WA_DATA_DIR = tmp;
process.env.WA_ENV_FILE = join(tmp, '.env');
writeFileSync(process.env.WA_ENV_FILE, '');
const { config } = await import('../src/config.js');
Object.assign(config.zentao, { enabled: true, url: 'http://z.test', username: 'lijc', password: 'p' });
const ds = await import('../src/services/docService.js');
const router = (await import('../src/routes/docs.js')).default;
const app = express();
app.use(express.json());
app.use('/api', router);
const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const up = (id, name, body, mime = 'text/plain') => zt.realFetch(`http://127.0.0.1:${server.address().port}/api/docs/${id}/files?name=${encodeURIComponent(name)}&mime=${encodeURIComponent(mime)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body }).then(async r => ({ status: r.status, ...(await r.json()) }));
const rejects = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(e.message); } };

try {
  reset();
  const r = await ds.addDocFile({ id: '12', file: { name: '测试附件.txt', mime: 'text/plain', buffer: Buffer.from('hello') } });
  const p = zt.posts[0];
  check('追加成功并回读到新附件(id/名称/大小)', r.file.id === '500' && r.file.name === '测试附件.txt' && r.file.size === 5, JSON.stringify(r));
  check('走文档编辑表单：files[] + labels[]，标题是去掉扩展名的文件名', p.files.join() === '测试附件.txt' && p.labels.join() === '测试附件', JSON.stringify(p));
  check('正文 / 标题 / editedDate 原样带回（追加附件不改文档内容）', p.fields.content === '正文' && p.fields.title === '接口说明' && p.fields.editedDate === '2026-10-20 10:00:00' && p.xhr === 'XMLHttpRequest');

  const r2 = await ds.addDocFile({ id: '12', file: { name: '第二个.csv', buffer: Buffer.from('a,b') } });
  check('再追加一个：只认新增的那个，已有的不重复', r2.file.id === '501' && zt.docs[12].files.length === 2);

  check('禅道静默不收的类型 → 回读发现没多，报错而不是成功', await rejects(() => ds.addDocFile({ id: '12', file: { name: 'a.php', buffer: Buffer.from('<?php') } }), /没有收下/) && zt.docs[12].files.length === 2);
  check('附件型文档不能追加，且不发请求', await rejects(() => ds.addDocFile({ id: '20', file: { name: 'a.txt', buffer: Buffer.from('x') } }), /不能追加附件/) && zt.posts.length === 3);
  check('空文件 / 没文件被拒', await rejects(() => ds.addDocFile({ id: '12', file: { name: 'a.txt', buffer: Buffer.alloc(0) } }), /没有收到文件/) && await rejects(() => ds.addDocFile({ id: '12' }), /没有收到文件/));
  check('文档 ID 非数字被拒', await rejects(() => ds.addDocFile({ id: 'x', file: { name: 'a.txt', buffer: Buffer.from('x') } }), /非法的文档 ID/));

  const ok = await up('12', '接口说明.pdf', Buffer.from('%PDF-1.4'), 'application/pdf');
  check('接口：POST /api/docs/:id/files 成功，文件名(中文)与内容正确到达禅道', ok.status === 200 && ok.success && ok.data.file.name === '接口说明.pdf' && zt.posts.at(-1).files[0] === '接口说明.pdf');
  const noName = await zt.realFetch(`http://127.0.0.1:${server.address().port}/api/docs/12/files`, { method: 'POST', body: Buffer.from('x') }).then(r => r.status);
  check('接口：缺文件名 → 400', noName === 400);
  const empty = await up('12', 'e.txt', Buffer.alloc(0));
  check('接口：空文件 → 400', empty.status === 400);
  const bad = await up('12', 'evil.exe', Buffer.from('MZ'));
  check('接口：禅道没收 → 500 + 原因', bad.status === 500 && /没有收下/.test(bad.message), JSON.stringify(bad));
} catch (err) {
  check(`异常：${err.stack}`, false);
} finally {
  server.close();
}

for (const x of results) console.log(`  ${x.pass ? '✓' : '✗'} ${x.name}${x.pass || !x.extra ? '' : `   → ${x.extra}`}`);
const passed = results.filter(x => x.pass).length;
console.log(`\n文档附件：${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
