/**
 * 真函数测试：我的待办（后端）
 *   - dueState：逾期 / 今天 / 3 天内 / 较远 / 无效日期
 *   - bySeverity：逾期 > 今天 > 3 天内 > 优先级（1 最高）
 *   - getTodos：任务 / Bug / 需求 / 文档四组；某个来源失败只进 errors，不影响其它
 */
import { dueState, bySeverity, getTodos, pickStories, pickTodos, todoItem } from '../src/services/todoService.js';

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
check('getTodos：分组顺序固定为 任务 / Bug / 需求 / 禅道待办（取不到的来源不出现）', 'task,bug,story,todo'.startsWith(t.groups.map(g => g.key).join()) && t.groups.length >= 2);
check('getTodos：不再有日报提醒分组', !t.groups.some(g => g.key === 'report'));
check('getTodos：禅道未配置时需求 / 禅道待办失败只进 errors，不影响任务 / Bug', t.errors.some(e => e.startsWith('需求')) && t.errors.some(e => e.startsWith('禅道待办')) && t.groups.some(g => g.key === 'task') && t.groups.some(g => g.key === 'bug'));

// 禅道个人待办：只留未完成，按紧急度排序，时间 / 日期 / 关联对象归一
const td = (o) => ({ id: '1', type: 'custom', pri: 3, date: '2026-10-23', begin: '2400', end: '2400', status: 'wait', name: 'x', idvalue: '0', ...o });
const picked2 = pickTodos([
  td({ id: '1', name: '今天下午', begin: '1500', end: '1530' }),
  td({ id: '2', name: '昨天的', date: '2026-10-22' }),
  td({ id: '3', name: '已完成', status: 'done' }),
  td({ id: '4', name: '已关闭', status: 'closed' }),
  td({ id: '5', name: '今天上午', begin: '09:30', end: '10:00' }),
  td({ id: '6', name: '长期', date: '2030-01-01' }),
  td({ id: '7', name: '进行中', status: 'doing', date: '2026-10-24' }),
  td({ id: '8', name: '已删除', deleted: '1' }),
  td({ id: '9', name: '较远', date: '2026-11-30' })
], T);
check('禅道待办：只留未开始 / 进行中，已完成 / 已关闭 / 已删除的不要', !picked2.some(i => ['3', '4', '8'].includes(i.id)), picked2.map(i => i.id).join());
check('禅道待办：逾期 > 今天(按开始时间) > 3 天内 > 较远 > 待定', picked2.map(i => i.id).join() === '2,5,1,7,9,6', picked2.map(i => i.id).join());
const a1 = todoItem(td({ begin: '1500', end: '1530' }), T), a2 = todoItem(td({ date: '2030-01-01' }), T), a3 = todoItem(td({ type: 'task', idvalue: '77', name: '' }), T);
check('禅道待办：时间段显示、2400 = 没设时间、长期显示待定', /今天 15:00-15:30/.test(a1.meta) && /待定/.test(a2.meta) && a2.due === '' && !/\d{2}:\d{2}/.test(todoItem(td(), T).meta));
check('禅道待办：关联任务且没有名字时用“任务 #编号”', a3.title === '任务 #77' && /任务/.test(a3.meta));
check('禅道待办：逾期标记', todoItem(td({ date: '2026-10-22' }), T).due === 'overdue' && a1.due === 'today');

console.log(`\n待办后端：${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
