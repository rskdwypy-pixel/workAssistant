/**
 * 需求拆任务 / Bug 转任务
 *
 *   GET  /api/bugs/:zid/task-link      Bug 是否已转过任务 {toTask, status}
 *   POST /api/bugs/:zid/to-task        Bug 转任务 {executionId, name, type, pri, assignedTo, estimate, deadline, desc}
 *   GET  /api/stories/:id/tasks        需求下已有的任务
 *   POST /api/stories/:id/tasks/suggest 拆分建议（AI 用「生成报告」选的模型；没配 AI 或出错退回通用模板，永远有结果）
 *   POST /api/stories/:id/tasks        需求拆任务 {executionId, tasks:[{name,…}]}，逐个创建，返回每一条的结果（成功的不回滚）
 *
 * :zid 是禅道里的 Bug 编号（不是本地 ID）。创建成功后顺带刷新本地任务缓存，看板马上能看到。
 */
import express from 'express';
import * as taskLink from '../services/taskLink.js';
import { config } from '../config.js';
import * as storyService from '../services/storyService.js';
import { getZentaoCookies, cookiesToString, syncMyTasks } from '../services/zentaoService.js';

const router = express.Router();
const idOk = (v) => /^\d+$/.test(String(v));

async function syncQuietly() {
  try { await syncMyTasks(); } catch { /* 同步失败不影响创建结果 */ }
}

router.get('/bugs/:zid/task-link', async (req, res) => {
  if (!idOk(req.params.zid)) return res.status(400).json({ success: false, message: 'Bug 编号不正确' });
  try {
    const CH = cookiesToString(await getZentaoCookies());
    res.json({ success: true, data: await taskLink.getBugLink(req.params.zid, CH) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/bugs/:zid/to-task', async (req, res) => {
  if (!idOk(req.params.zid)) return res.status(400).json({ success: false, message: 'Bug 编号不正确' });
  const { executionId, ...draft } = req.body || {};
  const r = await taskLink.createLinkedTask({ executionId, bugId: req.params.zid }, draft);
  if (r.success) await syncQuietly();
  res.json(r);
});

router.get('/stories/:id/tasks', async (req, res) => {
  if (!idOk(req.params.id)) return res.status(400).json({ success: false, message: '需求编号不正确' });
  try {
    const CH = cookiesToString(await getZentaoCookies());
    res.json({ success: true, data: await taskLink.getStoryTasks(req.params.id, CH) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/stories/:id/tasks/suggest', async (req, res) => {
  if (!idOk(req.params.id)) return res.status(400).json({ success: false, message: '需求编号不正确' });
  try {
    const story = await storyService.getStory(req.params.id);
    const hasAi = !!(config.ai.apiKey && config.ai.apiKey.trim());
    const ai = hasAi ? async (prompt, maxTokens) => (await import('../ai/openai.js')).generateResponse(prompt, maxTokens, 'report') : null;
    res.json({ success: true, data: await taskLink.suggestTasks({ title: story.title, spec: story.specHtml || story.specRaw, verify: story.verifyHtml || story.verifyRaw }, { ai }) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/stories/:id/tasks', async (req, res) => {
  if (!idOk(req.params.id)) return res.status(400).json({ success: false, message: '需求编号不正确' });
  const { executionId, tasks } = req.body || {};
  if (!Array.isArray(tasks) || !tasks.length) return res.status(400).json({ success: false, message: '没有要创建的任务' });
  if (tasks.length > 20) return res.status(400).json({ success: false, message: '一次最多创建 20 个任务' });
  const names = tasks.map((t) => String(t && t.name || '').trim());
  if (new Set(names).size !== names.length) return res.status(400).json({ success: false, message: '同一次创建里有标题完全相同的任务，请先改名' });
  const results = [];
  for (const t of tasks) {
    const r = await taskLink.createLinkedTask({ executionId, storyId: req.params.id }, t);
    results.push({ name: String(t && t.name || '').trim(), ...r });
    if (r.code === 'NOT_ACCEPTED' && !r.success && results.length === 1) break;   // 第一条就被拒：后面也一样，别刷屏
  }
  if (results.some((r) => r.success)) await syncQuietly();
  res.json({ success: true, data: { results, created: results.filter((r) => r.success).length, failed: results.filter((r) => !r.success).length } });
});

export default router;
