/**
 * 真函数测试：我的待办（后端）
 *   - dueState：逾期 / 今天 / 3 天内 / 较远 / 无效日期
 *   - bySeverity：逾期 > 今天 > 3 天内 > 优先级（1 最高）
 *   - getTodos：任务 / Bug / 需求 / 文档四组；某个来源失败只进 errors，不影响其它
 */
import { dueState, bySeverity, getTodos, pickStories, sortTodos, todoItem, withAbsoluteImages, withRelativeImages, isZentaoImagePath } from '../src/services/todoService.js';

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

// 禅道个人待办：显示顺序 = 优先级 → 状态 → 日期 → 开始时间
const td = (o) => ({ id: '1', type: 'custom', objectId: '', pri: 3, date: '2026-10-23', begin: '', end: '', status: 'wait', name: 'x', private: false, assignedTo: 'lijc', cycle: false, ...o });
const order = (list) => sortTodos(list).map(i => i.id).join();
check('禅道待办：先按优先级（1 最高）', order([td({ id: 'a', pri: 3 }), td({ id: 'b', pri: 1 }), td({ id: 'c', pri: 2 })]) === 'b,c,a');
check('禅道待办：同优先级，进行中在未开始前，已完成在最后', order([td({ id: 'a', status: 'done' }), td({ id: 'b', status: 'wait' }), td({ id: 'c', status: 'doing' }), td({ id: 'd', status: 'closed' })]) === 'c,b,a,d');
check('禅道待办：同优先级同状态，有日期的在前（早的先），待定在最后', order([td({ id: 'a', date: '' }), td({ id: 'b', date: '2026-10-25' }), td({ id: 'c', date: '2026-10-22' })]) === 'c,b,a');
check('禅道待办：同一天按开始时间，没设时间的在后', order([td({ id: 'a', begin: '' }), td({ id: 'b', begin: '15:00' }), td({ id: 'c', begin: '09:30' })]) === 'c,b,a');
check('禅道待办：优先级压过状态和日期', order([td({ id: 'a', pri: 2, status: 'doing', date: '2026-10-20' }), td({ id: 'b', pri: 1, status: 'wait', date: '' })]) === 'b,a');
const a1 = todoItem(td({ begin: '15:00', end: '15:30', date: T }), T), a2 = todoItem(td({ date: '' }), T), a3 = todoItem(td({ type: 'task', objectId: '77', name: '' }), T);
check('禅道待办：时间段、待定、状态显示在 meta 里', /未开始/.test(a1.meta) && /今天 15:00-15:30/.test(a1.meta) && /待定/.test(a2.meta) && a2.due === '');
check('禅道待办：关联任务没有名字时用“任务 #编号”，meta 标类型', a3.title === '任务 #77' && /任务/.test(a3.meta));
check('禅道待办：逾期 / 今天标记；私人、状态、优先级带出去', todoItem(td({ date: '2026-10-22' }), T).due === 'overdue' && a1.due === 'today' && todoItem(td({ private: true, pri: 1, status: 'doing' }), T).private === true && todoItem(td({ pri: 1 }), T).pri === 1);
check('禅道待办：指派给别人时 meta 里标出', /指派给 张三/.test(todoItem(td({ assignedTo: 'zhangsan' }), T, { zhangsan: '张三' }).meta));

// 描述里的图片：显示走本地代理，保存还原；只放行禅道自己的图片路径
const O = 'http://127.0.0.1:3721';
const shown = withAbsoluteImages('<p>a</p><img src="/zentao/file-read-12.png" alt="x"><img src="https://evil.example/a.png">', O);
check('描述图片：禅道图片改走本地代理，外部图片不动', shown.includes(`${O}/api/zentao-todos/file?path=${encodeURIComponent('/zentao/file-read-12.png')}`) && shown.includes('https://evil.example/a.png'));
check('描述图片：保存时还原成禅道原地址', withRelativeImages(shown, O).includes('src="/zentao/file-read-12.png"'));
check('描述图片：代理只放行禅道图片路径', isZentaoImagePath('/zentao/file-read-12.png') && isZentaoImagePath('/zentao/data/upload/1/202610/a.png') && !isZentaoImagePath('/zentao/user-login.html') && !isZentaoImagePath('http://evil/x.png') && !isZentaoImagePath('/etc/passwd'));
check('描述图片：不是图片标签的文字不受影响', withAbsoluteImages('路径 /zentao/file-read-1.png', O) === '路径 /zentao/file-read-1.png');

console.log(`\n待办后端：${pass}/${total} 通过`);
process.exit(pass === total ? 0 : 1);
