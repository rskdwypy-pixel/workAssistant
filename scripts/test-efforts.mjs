/**
 * 真函数测试：工时服务（后端）
 *   - aggregate：按账号 / 日期区间汇总（账号大小写不敏感、区间外和 0 小时的不算、同天多条累加）
 *   - monthRange：月份起止（含闰年二月）与格式校验
 *   - addEffort 入参校验：任务 / 日期格式 / 不能填将来 / 小时范围 / 剩余不能为负 / 工作内容必填
 *     （校验在请求禅道之前，不会发出任何网络请求）
 *   - standardHours：默认 8，配置可改，非法值回退 8
 *   - aggregateTeam：全员按人 / 按天汇总，admin 和成员名单之外的人不算
 *   - 全员只读缓存（不请求禅道）；报告采集共用的任务工时缓存（签名一致才命中）
 *   - getEffortGaps：最近几个工作日里一小时都没填的（跳过周末和今天，最近的在前，最多 3 个；填了但不足的不算）
 */
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tmp = mkdtempSync(join(tmpdir(), 'wa-eff-'));
process.env.WA_DATA_DIR = tmp;
process.env.WA_ENV_FILE = join(tmp, '.env');
writeFileSync(process.env.WA_ENV_FILE, '');
const { config } = await import('../src/config.js');
config.zentao.enabled = true;
config.zentao.url = 'http://127.0.0.1:1';     // 不可达：万一校验漏了发请求，会立刻报网络错误而不是通过
config.zentao.username = 'lijc';
config.zentao.password = 'x';
const { aggregate, aggregateTeam, monthRange, addEffort, standardHours, getEffortGaps, getTeamMonthEfforts, cachedTaskEfforts, storeTaskEfforts, _caches } = await import('../src/services/effortService.js');

let pass = 0, total = 0;
const check = (name, ok, extra = '') => { total++; if (ok) pass++; console.log(`${ok ? '✅' : '❌'} ${name}${extra ? `  (${extra})` : ''}`); };
const rejects = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(e.message); } };

// aggregate
const tasks = {
  10: { name: '接口联调', exec: '项目甲', efforts: [
    { id: '1', account: 'lijc', date: '2025-03-17', consumed: 2, left: 6, work: 'a' },
    { id: '2', account: 'LIJC', date: '2025-03-17', consumed: 1.5, left: 4.5, work: 'b' },
    { id: '3', account: 'wuf', date: '2025-03-17', consumed: 8, left: 0, work: '别人的' },
    { id: '4', account: 'lijc', date: '2025-02-28', consumed: 3, left: 0, work: '区间外' },
    { id: '5', account: 'lijc', date: '2025-03-18', consumed: 0, left: 0, work: '0 小时' }] },
  11: { name: '写文档', exec: '', efforts: [{ id: '6', account: 'lijc', date: '2025-03-17', consumed: 0.5, left: 1, work: 'c' }, { id: '7', account: 'lijc', date: '2025-03-31', consumed: 4, left: 0, work: 'd' }] }
};
const days = aggregate(tasks, 'lijc', '2025-03-01', '2025-03-31');
check('只统计我的（别人的不算，账号大小写不敏感）', days['2025-03-17'].items.length === 3 && !days['2025-03-17'].items.some(i => i.work === '别人的'));
check('同一天多条累加（2 + 1.5 + 0.5 = 4）', days['2025-03-17'].hours === 4, days['2025-03-17'].hours);
check('区间外的日期不算', !days['2025-02-28']);
check('0 小时的记录不算', !days['2025-03-18']);
check('月末当天（3/31）算在内', days['2025-03-31'] && days['2025-03-31'].hours === 4);
check('明细带任务名、执行名、工时记录 id、剩余、内容', JSON.stringify(days['2025-03-17'].items[0]) === JSON.stringify({ effortId: '1', taskId: '10', taskName: '接口联调', execName: '项目甲', consumed: 2, left: 6, work: 'a' }));
check('没有工时记录的任务集合 → 空', Object.keys(aggregate({}, 'lijc', '2025-03-01', '2025-03-31')).length === 0 && Object.keys(aggregate(null, 'lijc', '2025-03-01', '2025-03-31')).length === 0);

// monthRange
check('monthRange：3 月 1~31', JSON.stringify(monthRange('2025-03')) === '{"from":"2025-03-01","to":"2025-03-31"}');
check('monthRange：平年二月到 28', monthRange('2025-02').to === '2025-02-28');
check('monthRange：闰年二月到 29', monthRange('2024-02').to === '2024-02-29');
check('monthRange：格式不对抛错', (() => { try { monthRange('2025-3'); return false; } catch { return true; } })());

// addEffort 校验
const ok = { taskId: '10', date: '2025-03-17', consumed: 2, left: 4, work: '做了点事' };
check('没选任务被拒', await rejects(() => addEffort({ ...ok, taskId: '' }), /请选择任务/));
check('任务 id 不是数字被拒', await rejects(() => addEffort({ ...ok, taskId: '1;drop' }), /请选择任务/));
check('日期格式错被拒', await rejects(() => addEffort({ ...ok, date: '2025/03/17' }), /日期格式/));
check('将来的日期被拒', await rejects(() => addEffort({ ...ok, date: '2999-01-01' }), /将来/));
check('消耗为 0 被拒', await rejects(() => addEffort({ ...ok, consumed: 0 }), /消耗工时/));
check('消耗超过 24 小时被拒', await rejects(() => addEffort({ ...ok, consumed: 25 }), /消耗工时/));
check('消耗不是数字被拒', await rejects(() => addEffort({ ...ok, consumed: 'abc' }), /消耗工时/));
check('剩余为负被拒', await rejects(() => addEffort({ ...ok, left: -1 }), /剩余/));
check('工作内容为空被拒（它会进日报）', await rejects(() => addEffort({ ...ok, work: '   ' }), /工作内容/));

// standardHours
config.schedule.workHours = undefined;
check('标准工时默认 8', standardHours() === 8);
config.schedule.workHours = 7.5;
check('配置后用配置值', standardHours() === 7.5);
config.schedule.workHours = -3;
check('非法值回退 8', standardHours() === 8);

// ── 全员汇总 ──
const members = [{ account: 'lijc', realname: '李佳成', role: 'qa' }, { account: 'wuf', realname: '吴凡', role: 'dev' }, { account: 'zhouh', realname: '周航', role: 'dev' }];
const tt = aggregateTeam({
  10: { efforts: [{ account: 'lijc', date: '2025-03-17', consumed: 2 }, { account: 'WUF', date: '2025-03-17', consumed: 6 }, { account: 'admin', date: '2025-03-17', consumed: 9 }, { account: 'lijc', date: '2025-03-18', consumed: 1 }] },
  11: { efforts: [{ account: 'wuf', date: '2025-03-17', consumed: 1.5 }, { account: 'lijc', date: '2025-04-01', consumed: 5 }] }
}, members, '2025-03-01', '2025-03-31');
check('全员：成员名单之外的人（admin）不算', !tt.members.some(m => m.account === 'admin') && tt.days['2025-03-17'].total === 9.5, tt.days['2025-03-17'].total);
check('全员：按人汇总并按工时排序', tt.members.map(m => `${m.account}:${m.hours}`).join() === 'wuf:7.5,lijc:3,zhouh:0', tt.members.map(m => `${m.account}:${m.hours}`).join());
check('全员：按天按人', tt.days['2025-03-17'].byMember.wuf === 7.5 && tt.days['2025-03-17'].byMember.lijc === 2 && tt.members[0].byDay['2025-03-17'] === 7.5);
check('全员：区间外不算', !tt.days['2025-04-01']);

// ── 全员只读缓存：不请求禅道 ──
config.zentao.users = { lijc: '李佳成', wuf: '吴凡', admin: 'admin' };
const teamCache = _caches.team;
teamCache.write({ syncedAt: 1741000000000, tasks: { 10: { sig: 's1', name: '联调', exec: '项目甲', efforts: [{ account: 'lijc', date: '2025-03-17', consumed: 2 }, { account: 'wuf', date: '2025-03-17', consumed: 6 }] } } });
const tc = await getTeamMonthEfforts('2025-03', { cacheOnly: true });
check('全员只读缓存：不联网也能出结果，成员取本地用户列表（去掉 admin）', tc.fromCache && tc.members.map(m => m.account).sort().join() === 'lijc,wuf' && tc.days['2025-03-17'].total === 8);
teamCache.clear();
const empty = await getTeamMonthEfforts('2025-03', { cacheOnly: true });
check('全员没有缓存：days 为 null（页面据此提示第一次会慢）', empty.days === null && empty.members === null);

// ── 报告采集共用的任务工时缓存 ──
check('没缓存时不命中', cachedTaskEfforts('10', 's1') === null);
storeTaskEfforts({ 10: { sig: 's1', efforts: [{ account: 'lijc', date: '2025-03-17', consumed: 2 }] } });
check('签名一致才命中', cachedTaskEfforts('10', 's1').length === 1 && cachedTaskEfforts('10', 's2') === null);
storeTaskEfforts({ 10: { sig: 's2', name: '联调', efforts: [] } });
check('任务改过（签名变了）后旧缓存不再命中，并保留已有的名称等字段', cachedTaskEfforts('10', 's1') === null && cachedTaskEfforts('10', 's2').length === 0);
teamCache.clear();

// ── 缺填提醒（用缓存造数据，不联网）──
config.schedule.workHours = 8;
const mk = (date, consumed) => ({ account: 'lijc', date, consumed, left: 0, work: 'w', id: date });
_caches.mine.write({ syncedAt: Date.now(), tasks: { 10: { sig: 'x', name: '联调', exec: '项目甲', efforts: [
  mk('2025-03-18', 3.5), mk('2025-03-17', 8), mk('2025-03-14', 0.0001 > 1 ? 1 : 0), mk('2025-03-13', 8), mk('2025-03-12', 8), mk('2025-03-19', 1)] } } });
// 今天 = 周三 3/19：往前 7 天里的工作日是 18、17、14、13、12（15、16 是周末）
const gaps = await getEffortGaps({ now: new Date(2025, 2, 19, 10) });
check('缺填：只算一小时都没填的工作日（14 日 0h），跳过今天和周末', gaps.map(g => `${g.date}:${g.hours}`).join() === '2025-03-14:0', gaps.map(g => `${g.date}:${g.hours}`).join());
check('缺填：填了但不足的（18 日 3.5h）和满了的（17、13、12）都不算', !gaps.some(g => ['2025-03-18', '2025-03-17', '2025-03-13', '2025-03-12'].includes(g.date)));
_caches.mine.write({ syncedAt: Date.now(), tasks: { 10: { sig: 'x', name: 'a', exec: '', efforts: ['2025-03-18', '2025-03-17', '2025-03-14', '2025-03-13', '2025-03-12'].map(d => mk(d, 8)) } } });
check('缺填：都填满时没有提醒', (await getEffortGaps({ now: new Date(2025, 2, 19, 10) })).length === 0);
_caches.mine.write({ syncedAt: Date.now(), tasks: {} });
check('缺填：最多提醒 3 天', (await getEffortGaps({ now: new Date(2025, 2, 19, 10) })).length === 3);

console.log(`\n工时服务：${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
