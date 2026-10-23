/**
 * 真函数测试：创建 / 修改时间的显示（extension/time-line.js）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });
const ctx = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'time-line.js'), 'utf8') + '\nthis.api = { fmtZentaoTime, timesLineHTML, recordTimes };', ctx);
const { fmtZentaoTime, timesLineHTML, recordTimes } = ctx.api;
const NOW = new Date(2026, 9, 23, 12, 0);

check('今年的时间省略年份：10-23 14:30', fmtZentaoTime('2026-10-23 14:30:05', NOW) === '10-23 14:30');
check('往年的带年份', fmtZentaoTime('2025-12-31 09:05:00', NOW) === '2025-12-31 09:05');
check('零值 / 空 / 乱格式 → 空，不显示成怪日期', ['', null, undefined, '0000-00-00 00:00:00', 'abc'].every(v => fmtZentaoTime(v, NOW) === ''));

const line = timesLineHTML('2026-10-21 14:30:05', '2026-10-23 09:12:44');
check('有创建和修改：一行显示两个，tooltip 是完整时间到秒', /创建 10-21 14:30/.test(line) && /修改 10-23 09:12/.test(line) && /title="创建于 2026-10-21 14:30:05；最后修改 2026-10-23 09:12:44"/.test(line), line);
check('修改时间和创建相同 / 更早：只显示创建，不重复', !/修改/.test(timesLineHTML('2026-10-21 14:30:05', '2026-10-21 14:30:05')) && !/修改/.test(timesLineHTML('2026-10-21 14:30:05', '2026-10-20 00:00:00')));
check('只有修改时间（没有创建）也能显示', /修改 10-23 09:12/.test(timesLineHTML('', '2026-10-23 09:12:44')) && !/创建/.test(timesLineHTML('', '2026-10-23 09:12:44')));
check('两个都没有 → 什么都不输出', timesLineHTML('', '') === '' && timesLineHTML('0000-00-00 00:00:00', null) === '');
check('内容做了转义（防注入）', !/<script/.test(timesLineHTML('2026-10-21 14:30:05"><script>', '')));

check('已关联禅道的记录用禅道的创建 / 修改时间', JSON.stringify(recordTimes({ zentaoId: '5', openedAt: 'A', editedAt: 'B', createdAt: '2026-01-01T00:00:00Z' })) === JSON.stringify(['A', 'B']));
check('已关联禅道但还没同步到时间 → 空，不拿本地同步时间冒充', JSON.stringify(recordTimes({ zentaoId: '5', createdAt: '2026-01-01T00:00:00Z' })) === JSON.stringify(['', '']));
const local = recordTimes({ createdAt: new Date(2026, 0, 5, 8, 9).toISOString(), updatedAt: new Date(2026, 0, 6, 10, 11).toISOString() });
check('本地独有的记录用本地创建 / 更新时间', local[0] === '2026-01-05 08:09:00' && local[1] === '2026-01-06 10:11:00', JSON.stringify(local));

for (const x of results) console.log(`  ${x.pass ? '✓' : '✗'} ${x.name}${x.pass || !x.extra ? '' : `   → ${x.extra}`}`);
const passed = results.filter(x => x.pass).length;
console.log(`\n时间显示：${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
