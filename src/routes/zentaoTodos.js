/**
 * 禅道个人待办接口（地盘 → 我的待办）
 *
 *   GET    /api/zentao-todos                 我的待办（含已完成，已按 优先级 → 状态 → 日期 排好）
 *   GET    /api/zentao-todos/candidates      可关联的任务 / Bug / 需求（type=task|bug|story）
 *   GET    /api/zentao-todos/:id             详情（描述里的图片地址已补全成可直接显示）
 *   POST   /api/zentao-todos                 新建 {type,objectId,name,pri,desc,date,begin,end,assignedTo,private,uid}
 *   PUT    /api/zentao-todos/:id             编辑（同上）
 *   POST   /api/zentao-todos/:id/status      改状态 {status: wait|doing|done|closed}
 *   DELETE /api/zentao-todos/:id             删除
 *   POST   /api/zentao-todos/image?uid=&name=  描述里粘贴的图片（请求体就是图片本身，Content-Type: image/*，≤10MB）→ {url}
 */
import express from 'express';
import { listTodos, getTodo, createTodo, updateTodo, setTodoStatus, deleteTodo, uploadTodoImage } from '../services/zentaoTodo.js';
import { sortTodos, withAbsoluteImages, withRelativeImages, isZentaoImagePath } from '../services/todoService.js';
import { getAllTasks } from '../services/taskManager.js';
import { getBugs } from '../services/bugManager.js';
import { listStories } from '../services/storyService.js';
import { zentaoFetch, getZentaoCookies, cookiesToString, zentaoBase } from '../services/zentaoService.js';

const router = express.Router();
const fail = (res, err, code = 500) => res.status(code).json({ success: false, message: (err && err.message) || '服务异常' });
const origin = (req) => `${req.protocol}://${req.get('host')}`;
const out = (req, t) => ({ ...t, desc: withAbsoluteImages(t.desc, origin(req)) });
const body = (req) => ({ ...(req.body || {}), desc: withRelativeImages(String((req.body || {}).desc || ''), origin(req)) });
const OK = (res, data) => res.json({ success: true, data });
const guard = (fn) => async (req, res) => { try { await fn(req, res); } catch (err) { fail(res, err, /非法|请|不能|只能|只支持|周期|应为|格式|缺少|太长|空的|超过/.test(err.message || '') ? 400 : 500); } };

router.get('/zentao-todos', guard(async (req, res) => {
  OK(res, sortTodos(await listTodos()).map(t => out(req, t)));
}));

router.get('/zentao-todos/candidates', guard(async (req, res) => {
  const type = String(req.query.type || '');
  let items = [];
  if (type === 'task') items = (await getAllTasks({})).filter(t => t.type !== 'bug' && t.zentaoId && t.status !== 'done').map(t => ({ id: String(t.zentaoId), title: t.title }));
  else if (type === 'bug') items = (await getBugs({})).filter(b => b.zentaoId && b.status !== 'closed').map(b => ({ id: String(b.zentaoId), title: b.title }));
  else if (type === 'story') items = (await listStories({ maxAge: 60 * 1000 })).filter(s => s.status !== 'closed').map(s => ({ id: String(s.id), title: s.title }));
  else return fail(res, new Error('type 应为 task / bug / story'), 400);
  OK(res, items);
}));

router.post('/zentao-todos/image', express.raw({ type: 'image/*', limit: '10mb' }), guard(async (req, res) => {
  const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const url = await uploadTodoImage({ uid: req.query.uid, name: String(req.query.name || 'image.png'), mime: req.headers['content-type'], buffer });
  OK(res, { url: withAbsoluteImages(`<img src="${url}">`, origin(req)).match(/src="([^"]+)"/)[1] });
}));

/** 图片代理：带着禅道会话取描述里的图片（新版禅道要登录才能看） */
router.get('/zentao-todos/file', async (req, res) => {
  try {
    const path = String(req.query.path || '');
    if (!isZentaoImagePath(path)) return res.status(400).end();
    const CH = cookiesToString(await getZentaoCookies());
    const r = await zentaoFetch(`${zentaoBase()}${path}`, { headers: { Cookie: CH } });
    const type = r.headers.get('content-type') || '';
    if (!r.ok || !type.startsWith('image/')) return res.status(404).end();
    res.set('Content-Type', type).set('Cache-Control', 'private, max-age=3600').send(Buffer.from(await r.arrayBuffer()));
  } catch { res.status(502).end(); }
});

router.get('/zentao-todos/:id', guard(async (req, res) => OK(res, out(req, await getTodo(req.params.id)))));
router.post('/zentao-todos', guard(async (req, res) => OK(res, out(req, await createTodo(body(req))))));
router.put('/zentao-todos/:id', guard(async (req, res) => OK(res, out(req, await updateTodo(req.params.id, body(req))))));
router.post('/zentao-todos/:id/status', guard(async (req, res) => OK(res, out(req, await setTodoStatus(req.params.id, (req.body || {}).status)))));
router.delete('/zentao-todos/:id', guard(async (req, res) => OK(res, await deleteTodo(req.params.id))));

export default router;
