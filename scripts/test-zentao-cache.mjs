/**
 * 真函数测试：禅道本地缓存（需求 / 文档）
 *   - diffById：新增 / 变更 / 删除
 *   - createCache：读写落盘、换禅道账号后作废、坏文件不报错、clear
 *   - singleFlight：并发共用一次请求
 *   - trimDetails：详情缓存只留最近用的 120 条
 */
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmp = mkdtempSync(join(tmpdir(), 'wa-cache-'));
process.env.WA_DATA_DIR = tmp;
process.env.WA_ENV_FILE = join(tmp, '.env');
writeFileSync(process.env.WA_ENV_FILE, '');
const { config } = await import('../src/config.js');
const { createCache, diffById, singleFlight, trimDetails } = await import('../src/services/zentaoCache.js');

let pass = 0, total = 0;
const check = (name, ok, extra = '') => { total++; if (ok) pass++; console.log(`${ok ? '✅' : '❌'} ${name}${extra ? `  (${extra})` : ''}`); };

// diffById
const sig = (i) => i.v;
const d = diffById([{ id: 1, v: 'a' }, { id: 2, v: 'b' }, { id: 3, v: 'c' }], [{ id: 2, v: 'b' }, { id: 3, v: 'C' }, { id: 4, v: 'd' }], sig);
check('diff：新增 4', d.added.join() === '4');
check('diff：变更 3', d.changed.join() === '3');
check('diff：删除 1', d.removed.join() === '1');
const none = diffById([{ id: 1, v: 'a' }], [{ id: 1, v: 'a' }], sig);
check('diff：没变化时三项皆空', !none.added.length && !none.changed.length && !none.removed.length);
const first = diffById(null, [{ id: 1, v: 'a' }], sig);
check('diff：没有旧缓存时全是新增', first.added.join() === '1' && !first.removed.length);
check('diff：id 数字 / 字符串视为同一个', diffById([{ id: 1, v: 'a' }], [{ id: '1', v: 'a' }], sig).added.length === 0);

// createCache
config.zentao.url = 'http://zt.local:8088';
config.zentao.username = 'alice';
const c = createCache('t-items');
check('没有缓存时 read 返回 null', c.read() === null);
c.write({ items: [{ id: 1 }], syncedAt: 123 });
check('写入后能读到', c.read().items.length === 1 && c.read().syncedAt === 123);
check('落盘到 data/cache/', existsSync(join(tmp, 'cache', 't-items.json')));
check('再写一个字段不丢旧字段（合并）', (c.write({ extra: 1 }), c.read().items.length === 1 && c.read().extra === 1));
const c2 = createCache('t-items');
check('另一个实例（模拟重启）能从磁盘读回', c2.read() && c2.read().syncedAt === 123);
config.zentao.username = 'bob';
check('换账号后缓存作废', createCache('t-items').read() === null);
config.zentao.username = 'alice'; config.zentao.url = 'http://other:8088';
check('换禅道地址后缓存作废', createCache('t-items').read() === null);
config.zentao.url = 'http://zt.local:8088';
writeFileSync(join(tmp, 'cache', 'bad.json'), '{坏的');
check('缓存文件损坏时当作没有，不抛错', createCache('bad').read() === null);
c.clear();
check('clear 后读不到、文件已删', c.read() === null && !existsSync(join(tmp, 'cache', 't-items.json')));
check('写盘不留临时文件', !readdirSync(join(tmp, 'cache')).some(f => f.endsWith('.tmp')));

// singleFlight
let calls = 0;
const slow = () => new Promise(r => setTimeout(() => r(++calls), 20));
const [a, b] = await Promise.all([singleFlight('k', slow), singleFlight('k', slow)]);
check('并发调用只执行一次', calls === 1 && a === b);
await singleFlight('k', slow);
check('完成后再调用会重新执行', calls === 2);

// trimDetails
const many = {};
for (let i = 0; i < 150; i++) many[i] = { at: i };
const trimmed = trimDetails(many);
check('详情只留 120 条', Object.keys(trimmed).length === 120);
check('留下的是最近用的（at 大的）', trimmed[149] && !trimmed[0]);

console.log(`\n禅道缓存：${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
