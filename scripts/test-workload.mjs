#!/usr/bin/env node
/**
 * 回归测试：工作负载（未来两周能不能按截止日做完）
 * 纯计算 + 接口，不访问网络。
 *
 * 覆盖：只算未完成的任务；逾期的算进今天；截止日在窗口内 / 窗口后 / 没设；休息日不计产能；累计（不是单日）判断来不来得及，
 *       差多少、第一天来不及是哪天；剩余工时为 0 / 非数字；每天标准工时可调；窗口天数；接口参数边界
 */
import { buildWorkload } from '../src/services/workload.js';

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });

// 2026-10-26 是周一；用本地时间中午避免时区边界
const NOW = new Date(2026, 9, 26, 12, 0, 0);
const rest = (s) => { const d = new Date(`${s}T00:00:00`).getDay(); return d === 0 || d === 6; };
const t = (id, left, deadline, over = {}) => ({ id, name: `任务${id}`, left, estimate: left, consumed: 0, pri: 3, status: 'wait', deadline, executionName: '执行A', ...over });
const W = (items, o = {}) => buildWorkload(items, { now: NOW, isRest: rest, workHours: 8, ...o });
const row = (w, date) => w.rows.find(r => r.date === date);

// ---------- 基本分桶 ----------
let w = W([t(1, 4, '2026-10-26'), t(2, 6, '2026-10-28'), t(3, 3, '2026-11-20'), t(4, 5, ''), t(5, 2, '2026-10-20'), t(6, 8, '0000-00-00')]);
check('分成：逾期 / 窗口内 / 两周以后 / 没设截止日（0000-00-00 也算没设）', w.overdue.length === 1 && w.overdue[0].id === '5' && w.later.length === 1 && w.later[0].id === '3' && w.noDeadline.map(x => x.id).sort().join() === '4,6' && row(w, '2026-10-26').tasks[0].id === '1' && row(w, '2026-10-28').tasks[0].id === '2');
check('窗口默认 14 天，从今天起', w.rows.length === 14 && w.rows[0].date === '2026-10-26' && w.rows[13].date === '2026-11-08');
check('汇总：未完成数、总剩余、逾期、没设截止日', w.summary.openTasks === 6 && w.summary.totalLeft === 28 && w.summary.overdueCount === 1 && w.summary.overdueHours === 2 && w.summary.noDeadlineCount === 2 && w.summary.noDeadlineHours === 13 && w.summary.laterHours === 3, JSON.stringify(w.summary));

// ---------- 只算未完成 ----------
w = W([t(1, 4, '2026-10-27', { status: 'done' }), t(2, 4, '2026-10-27', { status: 'closed' }), t(3, 4, '2026-10-27', { status: 'cancel' }), t(4, 4, '2026-10-27', { status: 'doing' }), t(5, 4, '2026-10-27', { status: 'pause' }), t(6, 4, '2026-10-27')]);
check('已完成 / 已关闭 / 已取消不算；未开始、进行中、暂停都算', w.summary.openTasks === 3 && row(w, '2026-10-27').dueHours === 12);

// ---------- 累计判断 ----------
w = W([t(1, 20, '2026-10-27')]);   // 周二截止，要 20h；周一二两天可用 16h
check('累计：周二截止要 20h，到周二可用 16h → 来不及，差 4h，第一天来不及是周二', row(w, '2026-10-27').cumNeeded === 20 && row(w, '2026-10-27').cumCapacity === 16 && row(w, '2026-10-27').short === 4 && w.summary.firstShortDate === '2026-10-27' && w.summary.maxShort === 4, JSON.stringify(row(w, '2026-10-27')));
check('周一还来得及（累计需要 0）', row(w, '2026-10-26').short === 0);
check('只在截止那天标“来不及”；过了那天累计可用继续增加，后面的日子不再标红', row(w, '2026-10-28').short === 0 && row(w, '2026-10-28').cumNeeded === 20 && w.rows.filter(r => r.short > 0).length === 1, JSON.stringify(w.rows.slice(0, 6).map(r => r.short)));
w = W([t(1, 8, '2026-10-26'), t(2, 8, '2026-10-27'), t(3, 8, '2026-10-28')]);
check('每天正好一天的量：刚好来得及，没有“差”', w.rows.every(r => r.short === 0) && w.summary.firstShortDate === '');
w = W([t(1, 30, '2026-10-29')]);   // 周四前（周一到周四）4 个工作日 = 32h
check('提前做也行：单个任务比一天大但累计够 → 来得及', row(w, '2026-10-29').short === 0 && row(w, '2026-10-29').cumCapacity === 32);

// ---------- 逾期 ----------
w = W([t(1, 10, '2026-10-20')]);
check('逾期的算今天就要做：今天可用 8h，要 10h → 今天就差 2h', row(w, '2026-10-26').cumNeeded === 10 && row(w, '2026-10-26').short === 2 && w.summary.firstShortDate === '2026-10-26');

// ---------- 休息日 ----------
w = W([t(1, 8, '2026-10-31'), t(2, 8, '2026-11-01')]);   // 周六、周日截止
check('休息日不计产能：周五之后的周六周日可用不增加', row(w, '2026-10-30').cumCapacity === 40 && row(w, '2026-10-31').cumCapacity === 40 && row(w, '2026-11-01').cumCapacity === 40 && row(w, '2026-10-31').workday === false);
check('周六周日截止的任务要在周五之前做完：周五累计可用 40h 够 16h', row(w, '2026-11-01').short === 0);
w = W([t(1, 45, '2026-10-31')]);
check('休息日截止、累计需要超过周五前的产能 → 来不及（差 5h）', row(w, '2026-10-31').short === 5);
w = W([t(1, 8, '2026-10-31')], { isRest: (s) => s === '2026-10-26' });   // 把周一当休息日
check('用的是设置里的上班日历（这里把周一当休息日）', row(w, '2026-10-26').cumCapacity === 0 && row(w, '2026-10-27').cumCapacity === 8);

// ---------- 边界 ----------
w = W([t(1, 0, '2026-10-27'), t(2, 'abc', '2026-10-27'), t(3, -3, '2026-10-27'), t(4, null, '2026-10-27')]);
check('剩余工时为 0 / 非数字 / 负数 / 空：按 0 算，不报错', row(w, '2026-10-27').dueHours === 0 && row(w, '2026-10-27').tasks.length === 4 && w.summary.totalLeft === 0);
check('每天标准工时可调（4h/天）', row(W([t(1, 20, '2026-10-27')], { workHours: 4 }), '2026-10-27').cumCapacity === 8 && row(W([t(1, 20, '2026-10-27')], { workHours: 4 }), '2026-10-27').short === 12);
check('窗口天数可调（7 天），7 天以后的归到“以后”', W([t(1, 1, '2026-11-05')], { days: 7 }).rows.length === 7 && W([t(1, 1, '2026-11-05')], { days: 7 }).later.length === 1);
w = W([]);
check('没有任务：全是空，不报错', w.summary.openTasks === 0 && w.rows.length === 14 && w.rows.every(r => r.short === 0));
w = W(null);
check('传 null 也不报错', w.summary.openTasks === 0);
w = W([t(1, 2, '2026-10-27'), t(2, 5, '2026-10-27', { pri: 2 }), t(3, 5, '2026-10-27', { pri: 1 })]);
check('同一天里：剩余多的在前，一样多的优先级高的在前', row(w, '2026-10-27').tasks.map(x => x.id).join() === '3,2,1', row(w, '2026-10-27').tasks.map(x => x.id).join());
check('四舍五入到 0.1h', row(W([t(1, 1.04, '2026-10-27'), t(2, 1.04, '2026-10-27')]), '2026-10-27').dueHours === 2.1);
check('截止日带时间也认（2026-10-27 18:00:00）', row(W([t(1, 2, '2026-10-27 18:00:00')]), '2026-10-27').tasks.length === 1);

for (const x of results) console.log(`  ${x.pass ? '✓' : '✗'} ${x.name}${x.pass || !x.extra ? '' : `   → ${String(x.extra).slice(0, 300)}`}`);
const passed = results.filter(x => x.pass).length;
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
