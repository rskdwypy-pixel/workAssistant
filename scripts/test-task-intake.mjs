/**
 * 回归测试：新建任务流程（先开弹窗、预览不落库、保存不调模型、无 AI 降级）
 *
 * 使用临时数据目录 + 本地模拟大模型服务（http），不读写真实 data/，不访问外网。
 *
 * 覆盖：
 *   - 本地规则解析：相对日期、工期、优先级、进度、提醒、标题去噪
 *   - 未配置 AI：预览走本地规则，不请求模型
 *   - 短句且执行已确定（学习记录命中）：跳过模型
 *   - 模型超时 / 返回非法 JSON：降级本地，且不重试
 *   - 预览（preview）不落库；弹窗保存不调用模型；右键菜单入口仍完整分析后落库
 *   - 已关闭的执行不作为候选
 */
import { createServer } from 'http';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';

const results = [];
const check = (name, pass, extra = '') => results.push({ name, pass: !!pass, extra });

// ---------- 模拟大模型 ----------
const llm = { calls: 0, delayMs: 0, reply: null };
const llmServer = createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    llm.calls++;
    setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'x', object: 'chat.completion', created: 0, model: 'mock',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: llm.reply } }]
      }));
    }, llm.delayMs);
  });
});
await new Promise(r => llmServer.listen(0, '127.0.0.1', r));
const llmUrl = `http://127.0.0.1:${llmServer.address().port}/v1`;

// ---------- 临时数据 ----------
const tmp = mkdtempSync(join(tmpdir(), 'wa-intake-'));
const { config } = await import('../src/config.js');
config.paths.data = tmp;
config.paths.tasks = join(tmp, 'tasks.json');
writeFileSync(config.paths.tasks, JSON.stringify({ version: '1.0', tasks: [] }));

// 执行清单、学习记录都按 config.paths.data 读写，落在临时目录里
const { readFileSync } = await import('fs');
writeFileSync(join(tmp, 'executions.json'), JSON.stringify({
  executions: [
    { id: '149', name: '阿迪达斯项目交付', projectName: '阿迪达斯', status: 'doing', type: 'kanban' },
    { id: '167', name: '2026 年工作日志记录', projectName: '工作日志', status: 'doing', type: 'stage' },
    { id: '8', name: '需求', projectName: '上海张园小程序', status: 'closed', type: 'stage' }
  ],
  defaultExecutionId: '167',
  favoriteExecutionIds: []
}));

const { parseTaskLocally } = await import('../src/ai/localTaskParser.js');
const { analyzeTaskInput } = await import('../src/services/taskIntake.js');
const { getAiCandidateExecutions } = await import('../src/services/executionManager.js');
const learning = await import('../src/services/executionLearning.js');
const apiRouter = (await import('../src/routes/api.js')).default;

const app = express();
app.use(express.json());
app.use('/api', apiRouter);
const apiServer = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const api = (body) => fetch(`http://127.0.0.1:${apiServer.address().port}/api/task`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
}).then(r => r.json());
const readTasks = () => JSON.parse(readFileSync(config.paths.tasks, 'utf8')).tasks;

const setAi = (on) => {
  config.ai.apiKey = on ? 'test-key' : '';
  config.ai.baseURL = llmUrl;
};
const aiJson = (o) => JSON.stringify({
  title: '修复阿迪登录页兼容性', status: 'todo', progress: 0, priority: 1, executionId: '149', confidence: 0.9,
  durationDays: 2, reminder: null, ...o
});

try {
  // ============ 本地规则解析 ============
  const now = new Date(2026, 9, 21, 14, 0); // 周三 14:00
  const p1 = parseTaskLocally('【紧急】修复阿迪登录页兼容性，预计2天', now);
  check('本地解析：紧急 → 优先级 1、预计2天 → 截止 2 天后、标题去噪',
    p1.priority === 1 && p1.dueDate === '2026-10-23' && p1.title === '修复阿迪登录页兼容性', JSON.stringify(p1));
  const p2 = parseTaskLocally('明天下午3点和中信对一下黄金任务进度', now);
  check('本地解析：明天下午3点 → 截止明天 + 15:00 提醒，标题去掉时间',
    p2.dueDate === '2026-10-22' && new Date(p2.reminderTime).getHours() === 15 && p2.title === '和中信对一下黄金任务进度', JSON.stringify(p2));
  check('本地解析：下周三前 → 下周三', parseTaskLocally('下周三前提交交付文档', now).dueDate === '2026-10-28');
  const p4 = parseTaskLocally('接口联调 进度50%', now);
  check('本地解析：进度50% → 进行中', p4.progress === 50 && p4.status === 'in_progress' && p4.title === '接口联调');
  check('本地解析：挺急的 → 高优先级、比较急 → 次高', parseTaskLocally('这个挺急的', now).priority === 1 && parseTaskLocally('比较急', now).priority === 2);
  check('本地解析：有空 → 低优先级', parseTaskLocally('有空整理一下测试用例', now).priority === 4);
  check('本地解析：两周内完成 → 工期 14 天', parseTaskLocally('两周内完成数据迁移', now).durationDays === 14);

  // ============ 候选执行 ============
  const { candidates } = await getAiCandidateExecutions();
  check('已关闭的执行不作为候选', !candidates.some(e => e.id === '8') && candidates.length === 2);

  // ============ 未配置 AI ============
  setAi(false);
  llm.calls = 0;
  const noAi = await api({ content: '【紧急】修复阿迪达斯项目交付登录页，预计2天', preview: true });
  check('未配置 AI：预览走本地规则', noAi.success && noAi.source === 'local' && noAi.aiAvailable === false, JSON.stringify(noAi).slice(0, 200));
  check('未配置 AI：本地识别出优先级与截止日期', noAi.analysis.priority === 1 && !!noAi.analysis.dueDate);
  check('未配置 AI：按关键词匹配到执行', noAi.suggestion && noAi.suggestion.executionId === '149', JSON.stringify(noAi.suggestion));
  check('未配置 AI：不请求模型', llm.calls === 0);

  // ============ 预览不落库 ============
  check('预览不落库（取消弹窗不会留下任务）', readTasks().length === 0);

  // ============ AI 正常 ============
  setAi(true);
  llm.calls = 0; llm.delayMs = 0; llm.reply = aiJson();
  const ok = await api({ content: '帮我看下那个登录页在新浏览器上显示错位的问题，挺急的，估计要两天', preview: true });
  check('AI 可用：预览使用模型结果', ok.source === 'ai' && ok.analysis.priority === 1 && ok.suggestion.executionId === '149', JSON.stringify(ok).slice(0, 200));
  check('AI 可用：一次预览只调用一次模型', llm.calls === 1, `${llm.calls} 次`);

  // ============ 两段式：localOnly 秒回本地结果，aiPending 提示还有 AI 结果 ============
  llm.calls = 0;
  const t1 = Date.now();
  const lo = await api({ content: '帮我看下阿迪那个登录页在新版浏览器上显示错位的问题，挺急的', preview: true, localOnly: true });
  check('localOnly：不调用模型、立即返回本地结果', lo.source === 'local' && llm.calls === 0 && Date.now() - t1 < 500, `${Date.now() - t1}ms calls=${llm.calls}`);
  check('localOnly：长句仍标记 aiPending（AI 会再整理标题）', lo.aiPending === true);
  const lo2 = await api({ content: '阿迪登录页修复', preview: true, localOnly: true });
  check('localOnly：短句且执行已确定 → 不再等 AI', lo2.aiPending === false && lo2.suggestion && lo2.suggestion.executionId === '149', JSON.stringify(lo2.suggestion));
  setAi(false);
  const lo3 = await api({ content: '帮我看下阿迪那个登录页在新版浏览器上显示错位的问题', preview: true, localOnly: true });
  check('localOnly：未配置 AI → aiPending=false', lo3.aiPending === false && lo3.aiAvailable === false);
  setAi(true);

  // ============ 短句 + 学习记录命中 → 跳过模型 ============
  learning.learnFromCorrection('整理周报', '167');
  llm.calls = 0;
  const fast = await api({ content: '整理周报', preview: true });
  check('短句且学习记录已确定执行：跳过模型', fast.source === 'local' && fast.suggestion.executionId === '167' && llm.calls === 0,
    `source=${fast.source} calls=${llm.calls}`);

  // ============ 模型超时 → 降级本地且不重试 ============
  llm.calls = 0; llm.delayMs = 1500; llm.reply = aiJson();
  const t0 = Date.now();
  const slow = await analyzeTaskInput('帮我看下那个登录页在新浏览器上显示错位的问题，挺急的，估计要两天', { timeoutMs: 300 });
  const elapsed = Date.now() - t0;
  check('模型超时：降级为本地解析', slow.source === 'ai-timeout' && slow.fields.priority === 1, `source=${slow.source} err=${slow.aiError}`);
  check('模型超时：不重试，按超时时间返回', llm.calls === 1 && elapsed < 1200, `${llm.calls} 次 / ${elapsed}ms`);
  llm.delayMs = 0;

  // ============ 模型返回非法内容 → 降级本地 ============
  llm.reply = '这不是 JSON';
  const bad = await analyzeTaskInput('帮我看下那个登录页在新浏览器上显示错位的问题，下周三前搞定', {});
  check('模型返回非法内容：降级为本地解析', bad.source === 'ai-failed' && bad.fields.dueDate, JSON.stringify(bad.fields));

  // ============ 弹窗保存：不调模型，用表单值 ============
  llm.calls = 0; llm.reply = aiJson();
  const saved = await api({
    content: '帮我看下登录页错位\n\n新版 Chrome 上复现', title: '修复登录页错位', executionId: '149',
    executionPickedByUser: false, priority: 2, progress: 0, status: 'todo', dueDate: '2026-10-30',
    analysis: { reminderTime: '2026-10-22T07:00:00.000Z', durationDays: 2 }
  });
  const t = readTasks()[0];
  check('弹窗保存：不调用模型', saved.success && llm.calls === 0, `${llm.calls} 次`);
  check('弹窗保存：标题/执行/优先级/截止日期以表单为准', t && t.title === '修复登录页错位' && t.executionId === '149' &&
    t.priority === 2 && t.dueDate === '2026-10-30', JSON.stringify(t && { title: t.title, executionId: t.executionId, priority: t.priority, dueDate: t.dueDate }));
  check('弹窗保存：沿用预览识别的提醒时间', t && t.reminderTime === '2026-10-22T07:00:00.000Z');

  // 只采纳识别建议不算纠正，不写入学习库
  check('弹窗保存：采纳识别建议不写入学习库', learning.lookupLearned('帮我看下登录页错位\n\n新版 Chrome 上复现') !== '149');

  // ============ 弹窗保存：未选执行且无识别结果 → 本地匹配/默认执行 ============
  setAi(false);
  await api({ content: '随便记一笔', title: '随便记一笔' });
  check('弹窗保存：未选执行且识别不到 → 默认执行', readTasks().find(x => x.title === '随便记一笔')?.executionId === '167');

  // ============ 右键菜单入口（只有 content）：完整分析后落库 ============
  setAi(true);
  llm.calls = 0; llm.reply = aiJson({ title: '对齐阿迪登录方案', executionId: '149' });
  // 不含执行关键词 → 本地确定不了执行，需要模型
  const ctx = await api({ content: '整理一下登录方案的评审意见，比较急，大概两天搞定' });
  check('右键菜单入口：分析一次后落库', ctx.success && llm.calls === 1 && readTasks().some(x => x.title === '对齐阿迪登录方案' && x.executionId === '149'),
    `calls=${llm.calls} source=${ctx.source}`);
} finally {
  apiServer.close();
  llmServer.close();
  rmSync(tmp, { recursive: true, force: true });
}

for (const r of results) {
  console.log(`  ${r.pass ? '✓' : '✗'} ${r.name}${r.pass || !r.extra ? '' : `   → ${r.extra}`}`);
}
const passed = results.filter(r => r.pass).length;
console.log(`\n${passed}/${results.length} 通过`);
process.exit(passed === results.length ? 0 : 1);
