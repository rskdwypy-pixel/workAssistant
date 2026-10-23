/**
 * 真函数测试：上班日历（法定节假日 / 调休），utils/workCalendar.js 及它在各处的用法
 *   - 解析：单个日期、范围、混用分隔符（含全角）、不补零的写法、错误项、范围长度上限
 *   - 判定：周末 / 节假日不用上班；调休日要上班；调休优先于节假日；普通周末照旧
 *   - 用法：工作日历（weekend / holiday / makeup 标志）、工时缺填提醒、自动补填
 */
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmp = mkdtempSync(join(tmpdir(), 'wa-workcal-'));
process.env.WA_DATA_DIR = tmp;
process.env.WA_ENV_FILE = join(tmp, '.env');
writeFileSync(process.env.WA_ENV_FILE, '');
const { config } = await import('../src/config.js');
Object.assign(config.zentao, { enabled: true, url: 'http://z.test', username: 'lijc', password: 'p' });
const wc = await import('../src/utils/workCalendar.js');

let pass = 0, total = 0;
const check = (name, ok, extra = '') => { total++; if (ok) pass++; console.log(`${ok ? '✅' : '❌'} ${name}${extra ? `  (${extra})` : ''}`); };
const list = (t) => [...wc.parseDateList(t).dates].sort().join(',');

// ── 解析 ──
check('单个日期', list('2025-10-11') === '2025-10-11');
check('范围展开（含首尾）', list('2025-10-01~2025-10-03') === '2025-10-01,2025-10-02,2025-10-03');
check('逗号 / 分号 / 换行 / 全角逗号混用', list('2025-10-01，2025-10-02;2025-10-03\n2025-10-04 2025-10-05') === '2025-10-01,2025-10-02,2025-10-03,2025-10-04,2025-10-05');
check('范围写法：～ 、至、到', list('2025-10-01～2025-10-02') === '2025-10-01,2025-10-02' && list('2025-10-01至2025-10-02') === '2025-10-01,2025-10-02' && list('2025-10-01到2025-10-02') === '2025-10-01,2025-10-02');
check('不补零的写法 2025-9-5 也认', list('2025-9-5') === '2025-09-05');
check('跨月 / 跨年的范围', list('2025-12-30~2026-01-02') === '2025-12-30,2025-12-31,2026-01-01,2026-01-02');
const bad = wc.parseDateList('2025-10-01, abc, 2025-13-40, 2025-10-05~2025-10-01');
check('错误项被收集：不是日期 / 不存在的日期 / 起止颠倒；好的照常解析', bad.errors.length === 3 && bad.dates.size === 1, bad.errors.join('|'));
check('单段范围超过 62 天：报错并截断', wc.parseDateList('2025-01-01~2025-12-31').errors.length === 1 && wc.parseDateList('2025-01-01~2025-12-31').dates.size <= 63);
check('空 / null → 空集合，无错误', wc.parseDateList('').dates.size === 0 && wc.parseDateList(null).errors.length === 0);

// ── 判定 ──
config.workCalendar.holidays = '2025-10-01~2025-10-03';   // 周三~周五
config.workCalendar.makeup = '2025-10-11, 2025-10-02';    // 周六；以及一个和节假日重复的（调休优先）
check('普通工作日', wc.dayKind('2025-10-06') === 'work' && wc.isWorkday('2025-10-06'));
check('普通周末', wc.dayKind('2025-10-04') === 'weekend' && wc.isRestDay('2025-10-04') && wc.isRestDay('2025-10-05'));
check('节假日（周五）不用上班', wc.dayKind('2025-10-03') === 'holiday' && wc.isRestDay('2025-10-03') && wc.restReason('2025-10-03') === '节假日');
check('调休的周六要上班', wc.dayKind('2025-10-11') === 'makeup' && wc.isWorkday('2025-10-11'));
check('调休优先于节假日', wc.dayKind('2025-10-02') === 'makeup' && wc.isWorkday('2025-10-02'));
check('周末的原因文案', wc.restReason('2025-10-04') === '周末');
config.workCalendar.holidays = ''; config.workCalendar.makeup = '';
check('清空后回到「只看周末」', wc.isWorkday('2025-10-03') && wc.isRestDay('2025-10-04') && wc.isRestDay('2025-10-11'));

// ── 工作日历接口的标志 ──
config.workCalendar.holidays = '2025-10-01~2025-10-03';
config.workCalendar.makeup = '2025-10-11';
const rc = await import('../src/services/reportCenter.js');
const cal = await rc.getCalendar('2025-10', new Date(2025, 9, 20));
const day = (d) => cal.days.find(x => x.date === d);
check('日历：节假日 weekend=true、holiday=true（前端据此不算缺填、不出「补」）', day('2025-10-02').weekend === true && day('2025-10-02').holiday === true && day('2025-10-02').makeup === false);
check('日历：调休周六 weekend=false、makeup=true（要上班）', day('2025-10-11').weekend === false && day('2025-10-11').makeup === true && day('2025-10-11').weekday === 6);
check('日历：普通周末 weekend=true、不是 holiday', day('2025-10-04').weekend === true && day('2025-10-04').holiday === false);
check('日历：weekday 仍是真实的星期（节假日不改）', day('2025-10-02').weekday === 4);
const wd1 = rc.workdaysOf(rc.periodOf('weekly', '2025-09-29'), new Date(2025, 9, 20, 22));
const wd2 = rc.workdaysOf(rc.periodOf('weekly', '2025-10-06'), new Date(2025, 9, 20, 22));
check('报告「应填工时的工作日」：国庆几天（10/1~10/3）不算', wd1.join() === '2025-09-29,2025-09-30', wd1.join());
check('报告「应填工时的工作日」：调休上班的周六（10/11）要算', wd2.includes('2025-10-11') && !wd2.includes('2025-10-12'), wd2.join());

// ── 缺填提醒 ──
const es = await import('../src/services/effortService.js');
es._caches.mine.write({ syncedAt: Date.now(), tasks: {} });
config.workCalendar.holidays = '2025-10-06~2025-10-08';   // 周一~周三放假
config.workCalendar.makeup = '2025-10-11';
const gaps = await es.getEffortGaps({ now: new Date(2025, 9, 13, 10), lookback: 7, limit: 9 });   // 今天 10-13 周一
check('缺填提醒：节假日（10/6~10/8）不提醒；调休上班的周六（10/11）要提醒；周日不提醒', gaps.map(g => g.date).join() === '2025-10-11,2025-10-10,2025-10-09', gaps.map(g => g.date).join());

// ── 自动补填 ──
const af = await import('../src/services/autofillService.js');
const task = { id: '1', name: 't', execName: '', status: 'doing', estimate: 0, consumed: 0, left: 10, opened: '2025-01-01', estStarted: '', realStarted: '', deadline: '', lastEdited: '' };
const plan = af.planDates({ dates: ['2025-10-07', '2025-10-09', '2025-10-11', '2025-10-12'], tasks: [task], daysMap: {}, standard: 8, today: '2025-10-13', seed: 1, account: 'lijc', history: new Map() });
const why = Object.fromEntries(plan.skipped.map(s => [s.date, s.reason]));
check('补填：节假日跳过并说明「节假日不补」；周日「周末不补」', why['2025-10-07'] === '节假日不补' && why['2025-10-12'] === '周末不补', JSON.stringify(why));
check('补填：普通工作日（10/9）和调休上班的周六（10/11）都会补', plan.days.map(d => d.date).join() === '2025-10-09,2025-10-11');

console.log(`\n上班日历：${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
