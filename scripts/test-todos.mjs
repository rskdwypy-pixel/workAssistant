/**
 * 真函数测试：我的待办（后端）
 *   - dueState：逾期 / 今天 / 3 天内 / 较远 / 无效日期
 *   - bySeverity：逾期 > 今天 > 3 天内 > 优先级（1 最高）
 *   - getTodos：各分组齐全；某个来源失败只进 errors，不影响其它
 */
import { dueState, bySeverity, getTodos } from '../src/services/todoService.js';

let pass = 0, total = 0;
const check = (name, ok, extra = '') => { total++; if (ok) pass++; console.log(`${ok ? '✅' : '❌'} ${name}${extra ? `  (${extra})` : ''}`); };

const T = '2026-10-23';
check('过去 → overdue', dueState('2026-10-22', T) === 'overdue');
check('今天 → today', dueState('2026-10-23', T) === 'today');
check('带时间的今天 → today', dueState('2026-10-23 18:00:00', T) === 'today');
check('3 天后 → soon', dueState('2026-10-26', T) === 'soon');
check('4 天后 → 空', dueState('2026-10-27', T) === '');
check('空 / 无效日期 → 空', dueState('', T) === '' && dueState(null, T) === '' && dueState('abc', T) === '');
check('跨月：10-31 → 11-02 算 soon', dueState('2026-11-02', '2026-10-31') === 'soon');

const items = [
  { id: 'a', due: '', pri: 1 },
  { id: 'b', due: 'today', pri: 4 },
  { id: 'c', due: 'overdue', pri: 4 },
  { id: 'd', due: '', pri: 3 },
  { id: 'e', due: 'soon', pri: 3 }
].sort(bySeverity).map(i => i.id).join('');
check('排序：逾期 > 今天 > 3 天内 > 优先级', items === 'cbead', items);

const t = await getTodos(new Date('2026-10-23T10:00:00'));
check('getTodos：返回 groups / total / errors', Array.isArray(t.groups) && typeof t.total === 'number' && Array.isArray(t.errors));
check('getTodos：任务 / Bug / 日报分组都在', ['task', 'bug', 'report'].every(k => t.groups.some(g => g.key === k)));
check('getTodos：禅道未配置时需求失败只进 errors', t.errors.some(e => e.startsWith('需求')) && t.groups.some(g => g.key === 'task'));

console.log(`\n待办后端：${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
