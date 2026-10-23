/**
 * 真函数测试：我的待办（后端）
 *   - dueState：逾期 / 今天 / 3 天内 / 较远 / 无效日期
 *   - bySeverity：逾期 > 今天 > 3 天内 > 优先级（1 最高）
 *   - getTodos：任务 / Bug / 需求 / 文档四组；某个来源失败只进 errors，不影响其它
 */
import { dueState, bySeverity, getTodos, pickStories } from '../src/services/todoService.js';

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

// 需求筛选：指派给我 或 评审中；已关闭的不要
const st = (id, status, assignedToAccount, pri = 3) => ({ id: String(id), status, assignedToAccount, pri });
const picked = pickStories([
  st(1, 'active', 'lijc'),            // 指派给我
  st(2, 'active', 'zhangsan'),        // 别人的、非评审 → 不要
  st(3, 'reviewing', 'zhangsan'),     // 评审中（不是我的）→ 要
  st(4, 'closed', 'lijc'),            // 已关闭 → 不要
  st(5, 'reviewing', 'lijc', 1),      // 评审中且指派给我 → 要，排最前
  st(6, 'draft', 'LIJC'),             // 账号大小写不敏感 → 要
  st(7, 'changing', 'zhangsan')       // 变更中不算评审中 → 不要
], 'lijc');
check('需求：只留 指派给我 或 评审中，已关闭的不要', picked.map(s => s.id).sort().join() === '1,3,5,6', picked.map(s => s.id).join());
check('需求：评审中的排前面，同组按优先级', picked[0].id === '5' && picked[1].id === '3', picked.map(s => s.id).join());
check('需求：没配账号时只留评审中的', pickStories([st(1, 'active', 'lijc'), st(2, 'reviewing', 'x')], '').map(s => s.id).join() === '2');

const t = await getTodos(new Date('2026-10-23T10:00:00'));
check('getTodos：返回 groups / total / errors', Array.isArray(t.groups) && typeof t.total === 'number' && Array.isArray(t.errors));
check('getTodos：分组顺序固定为 任务 / Bug / 需求 / 文档（取不到的来源不出现）', 'task,bug,story,doc'.startsWith(t.groups.map(g => g.key).join()) && t.groups.length >= 2);
check('getTodos：不再有日报提醒分组', !t.groups.some(g => g.key === 'report'));
check('getTodos：禅道未配置时需求 / 文档失败只进 errors，不影响任务 / Bug', t.errors.some(e => e.startsWith('需求')) && t.errors.some(e => e.startsWith('文档')) && t.groups.some(g => g.key === 'task') && t.groups.some(g => g.key === 'bug'));

console.log(`\n待办后端：${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
