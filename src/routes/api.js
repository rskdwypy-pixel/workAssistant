import express from 'express';
import * as taskManager from '../services/taskManager.js';
import * as summaryService from '../services/summary.js';
import * as reminderService from '../services/reminder.js';
import { testWebhook } from '../utils/webhook.js';

const router = express.Router();

// ==================== 任务相关接口 ====================

/**
 * POST /api/task - 添加任务（智能去重）
 */
/**
 * POST /api/task - 分析 / 新建任务
 *
 * 两种用法：
 *   1. 预览（preview=true）：只分析不落库。新建弹窗打开后在后台调用，结果回填到表单。
 *      body: { content, executionId? }
 *   2. 保存：
 *      - 弹窗提交（带 title）：用表单值 + 预览阶段的分析结果（analysis）落库，**不再调用大模型**；
 *        没有预览结果（AI 未返回 / 未配置）时用本地规则补全提醒、工期等字段。
 *        body: { content, title, executionId?, executionPickedByUser?, analysis?,
 *                priority?, status?, progress?, dueDate?, assignees?, cc?, zentaoId? }
 *      - 其他入口（右键菜单「添加到任务」，只有 content）：分析后直接落库。
 *
 * 表单字段优先级最高：弹窗里用户手动改过的值就是最终值（显式操作 > 模型推断）。
 */
router.post('/task', async (req, res) => {
  try {
    const body = req.body || {};
    const { content, zentaoId } = body;
    if (!content) {
      return res.status(400).json({ error: '请输入任务内容' });
    }

    const { analyzeTaskInput } = await import('../services/taskIntake.js');
    const { parseTaskLocally, isSimpleInput } = await import('../ai/localTaskParser.js');
    const userExecutionId = body.executionId ? String(body.executionId) : '';

    // —— 预览：只分析不落库 ——
    if (body.preview) {
      // localOnly：只做本地解析（毫秒级），前端先用它秒填，再发一次完整预览等 AI 补充
      const localOnly = !!body.localOnly;
      const r = await analyzeTaskInput(content, { executionId: userExecutionId, allowAi: !localOnly });
      const exec = r.execution && r.candidates.find(e => String(e.id) === String(r.execution.executionId));
      return res.json({
        success: true,
        preview: true,
        source: r.source,
        aiAvailable: r.aiAvailable,
        // 本地结果之后还会有 AI 结果：AI 可用、本次只做了本地、且这句话不属于「本地就够了」的短句
        aiPending: localOnly && r.aiAvailable && !(r.execution && isSimpleInput(content)),
        aiError: r.aiError || '',
        analysis: r.fields,
        suggestion: r.execution ? {
          executionId: r.execution.executionId,
          executionName: exec?.name || '',
          projectName: exec?.projectName || '',
          matchedBy: r.execution.matchedBy,
          confidence: r.execution.confidence,
          reason: r.execution.reason
        } : null,
        needConfirm: r.needConfirm,
        candidates: r.needConfirm
          ? r.candidates.slice(0, 8).map(e => ({ id: e.id, name: e.name, projectName: e.projectName || '' }))
          : [],
        meta: { totalCount: r.totalCount, candidateCount: r.candidates.length }
      });
    }

    // —— 保存 ——
    const fromForm = typeof body.title === 'string' && body.title.trim() !== '';
    let fields;
    let execution = null;
    let source = 'form';
    if (fromForm) {
      // 弹窗提交：不调用大模型。预览结果只取表单里没有的字段（提醒时间、工期）
      const local = parseTaskLocally(content);
      const pre = body.analysis && typeof body.analysis === 'object' ? body.analysis : {};
      fields = {
        ...local,
        reminderTime: typeof pre.reminderTime === 'string' ? pre.reminderTime : local.reminderTime,
        durationDays: Number.isFinite(Number(pre.durationDays)) ? Number(pre.durationDays) : local.durationDays,
        title: body.title.trim()
      };
      if (!userExecutionId) {
        const { matchExecutionLocally } = await import('../services/taskIntake.js');
        const { getAiCandidateExecutions } = await import('../services/executionManager.js');
        execution = await matchExecutionLocally(content, (await getAiCandidateExecutions()).candidates);
      }
    } else {
      // 其他入口：完整分析（AI 可用时调用模型，失败自动降级本地）
      const r = await analyzeTaskInput(content, { executionId: userExecutionId });
      fields = r.fields;
      execution = r.execution;
      source = r.source;
    }

    // 执行归属：用户选择 > 分析结果 > 默认执行
    let finalExecutionId = userExecutionId || execution?.executionId || null;
    if (!finalExecutionId) {
      const { getDefaultExecution } = await import('../services/executionManager.js');
      const { config } = await import('../config.js');
      const defaultExec = await getDefaultExecution();
      finalExecutionId = defaultExec ? defaultExec.id : (config.zentao.executionId ? String(config.zentao.executionId) : null);
    }

    // 用户在弹窗里改了执行 = 一次纠正，写入学习库（只采纳 AI 建议不算）
    const pickedByUser = body.executionPickedByUser !== undefined ? !!body.executionPickedByUser : !!userExecutionId;
    if (userExecutionId && pickedByUser) {
      const { learnFromCorrection } = await import('../services/executionLearning.js');
      learnFromCorrection(content, userExecutionId);
    }

    // 用户在弹窗里显式设置的值（未设置则为 undefined）
    const formData = {};
    const num = (v) => (v === '' || v == null ? undefined : Number(v));
    const pri = num(body.priority);
    const prog = num(body.progress);
    if (pri !== undefined && Number.isFinite(pri)) formData.priority = pri;
    if (prog !== undefined && Number.isFinite(prog)) formData.progress = prog;
    if (typeof body.status === 'string' && body.status) formData.status = body.status;
    if (body.dueDate) formData.dueDate = body.dueDate;
    if (Array.isArray(body.assignees)) formData.assignees = body.assignees;
    if (Array.isArray(body.cc)) formData.cc = body.cc;

    const result = await taskManager.addOrUpdateTask(content, {
      zentaoId,
      executionId: finalExecutionId,
      preAnalysis: fields,
      formData
    });

    res.json({
      success: true,
      data: result.task,
      isNew: result.isNew,
      executionId: finalExecutionId,
      source,
      message: result.isNew ? '任务已添加' : '检测到重复任务，已更新进度'
    });
  } catch (err) {
    console.error('[API] 添加任务失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/tasks - 获取所有任务
 */
router.get('/tasks', async (req, res) => {
  try {
    const filters = {
      status: req.query.status,
      priority: req.query.priority,
      category: req.query.category,
      date: req.query.date
    };

    const tasks = await taskManager.getAllTasks(filters);
    res.json({ success: true, data: tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/tasks/today - 获取今日任务
 */
router.get('/tasks/today', async (req, res) => {
  try {
    const tasks = await taskManager.getTodayTasks();
    res.json({ success: true, data: tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/tasks/date/:date - 获取指定日期的任务
 */
router.get('/tasks/date/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const tasks = await taskManager.getTasksByDateFilter(date);
    res.json({ success: true, data: tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/tasks/search - 搜索任务
 */
router.get('/tasks/search', async (req, res) => {
  try {
    const { q } = req.query;

    if (!q) {
      return res.status(400).json({ error: '请输入搜索关键词' });
    }

    const tasks = await taskManager.searchTasks(q);
    res.json({ success: true, data: tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/tasks/batch - 批量更新任务（用于拖动排序与状态更改）
 */
router.put('/tasks/batch', async (req, res) => {
  try {
    const { updates } = req.body;
    if (!updates || !Array.isArray(updates)) {
      return res.status(400).json({ error: '请提供有效的updates数组' });
    }

    const tasks = await taskManager.batchUpdateTasks(updates);
    res.json({ success: true, count: updates.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/task/:id/status - 更新任务状态
 */
router.put('/task/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status || !['todo', 'in_progress', 'done'].includes(status)) {
      return res.status(400).json({ error: '无效的状态值' });
    }

    const task = await taskManager.updateTaskStatus(id, status);
    res.json({ success: true, data: task });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/task/:id - 更新任务
 */
router.put('/task/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const task = await taskManager.updateTask(id, updates);
    // 任务刚拿到禅道 ID（后台建到禅道成功）：推送积压的附件
    if (updates && updates.zentaoId) {
      const { schedulePush } = await import('../services/attachmentSync.js');
      schedulePush(id);
    }
    res.json({ success: true, data: task });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/task/:id/progress - 更新任务进度
 */
router.put('/task/:id/progress', async (req, res) => {
  try {
    const { id } = req.params;
    const { progress, progressComment, consumedTime } = req.body;

    if (progress < 0 || progress > 100) {
      return res.status(400).json({ error: '进度必须在0-100之间' });
    }

    // 传递进度、工作内容和工时到 updateTask，以便记录历史
    const task = await taskManager.updateTask(id, {
      progress,
      progressComment,
      consumedTime
    });

    // 根据进度自动更新状态
    let status = task.status;
    if (progress === 100 && status !== 'done') {
      status = 'done';
      await taskManager.updateTaskStatus(id, 'done');
    } else if (progress > 0 && progress < 100 && status !== 'in_progress') {
      status = 'in_progress';
      await taskManager.updateTaskStatus(id, 'in_progress');
    } else if (progress === 0 && status !== 'todo') {
      status = 'todo';
      await taskManager.updateTaskStatus(id, 'todo');
    }

    res.json({ success: true, data: { ...task, progress, status } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/task/:id - 删除任务
 */
router.delete('/task/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await taskManager.deleteTask(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/tasks/all - 删除所有本地任务（不影响禅道任务）
 */
router.delete('/tasks/all', async (req, res) => {
  try {
    const result = await taskManager.deleteAllTasks();
    res.json({ success: true, deletedCount: result.deletedCount });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== 统计相关接口 ====================

/**
 * GET /api/stats - 获取任务统计
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await taskManager.getTaskStats();
    res.json({ success: true, data: stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/calendar/:year/:month - 获取日历数据
 */
router.get('/calendar/:year/:month', async (req, res) => {
  try {
    const { year, month } = req.params;
    const data = await taskManager.getCalendarData(
      parseInt(year),
      parseInt(month)
    );
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== 历史日报接口 ====================

/**
 * GET /api/history - 获取历史日报列表
 */
router.get('/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit || '30');
    const history = await summaryService.getHistoryList(limit);
    res.json({ success: true, data: history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/history/:date - 获取指定日期的日报
 */
router.get('/history/:date', async (req, res) => {
  try {
    const { date } = req.params;
    const report = await summaryService.getHistoryByDate(date);

    if (!report) {
      return res.status(404).json({ error: '日报不存在' });
    }

    res.json({ success: true, data: report });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/history/restore - 恢复历史报告（用于备份恢复）
 */
router.post('/history/restore', async (req, res) => {
  try {
    const { history } = req.body;

    if (!history || !Array.isArray(history)) {
      return res.status(400).json({ error: '无效的历史报告数据' });
    }

    // 读取现有历史
    const summaryData = await summaryService.getHistoryList(1000);
    const existingIds = new Set(summaryData.map(h => h.id));

    // 合并历史报告（只添加不存在的）
    let added = 0;
    for (const report of history) {
      if (!existingIds.has(report.id)) {
        summaryData.push(report);
        added++;
      }
    }

    // 按日期排序
    summaryData.sort((a, b) => new Date(b.date) - new Date(a.date));

    // 保存到文件
    await summaryService.saveHistory(summaryData);

    res.json({ success: true, added, total: summaryData.length });
  } catch (err) {
    console.error('[API] 恢复历史报告失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== 报告生成接口 ====================

/**
 * POST /api/report/generate/:type - 生成汇报 (daily/weekly/monthly)
 * 支持查询参数 autoPush=true 自动推送
 * 支持查询参数 date=YYYY-MM-DD 指定日期（仅用于日报）
 * 支持查询参数 workHours=x.x 今日工时（仅用于日报）
 */
router.post('/report/generate/:type', async (req, res) => {
  try {
    const { type } = req.params;
    if (!['daily', 'weekly', 'monthly'].includes(type)) {
      return res.status(400).json({ error: '不支持的合并类型' });
    }
    const autoPush = req.query.autoPush === 'true';
    const date = req.query.date || null; // 获取日期参数
    const workHours = req.query.workHours ? parseFloat(req.query.workHours) : null; // 获取工时参数
    console.log(`[API] 收到请求: 生成${type}报告, autoPush=${autoPush}, date=${date}, workHours=${workHours}`);
    console.log(`[API] 完整URL: ${req.originalUrl}`);
    const report = await summaryService.generateReport(type, autoPush, date, workHours);
    console.log(`[API] 报告生成完成:`, report.id, report.dateLabel);
    res.json({ success: true, data: report });
  } catch (err) {
    console.error(`[API] 生成报告失败:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/report/:id - 删除报告
 */
router.delete('/report/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await summaryService.deleteReport(id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/report/:id/push - 推送报告
 */
router.post('/report/:id/push', async (req, res) => {
  try {
    const { id } = req.params;
    const history = await summaryService.getHistoryList(300);
    const report = history.find(r => r.id === id);
    if (!report) {
      return res.status(404).json({ error: '未找到报告' });
    }

    // 根据报告类型生成标题
    const typeLabels = {
      daily: '🌙 每日工作总结',
      weekly: '📊 每周工作总结',
      monthly: '📈 每月工作总结'
    };
    const title = typeLabels[report.type] || '📊 工作总结';

    // 构建推送内容
    const items = [
      '',
      `✅ 已完成: ${report.completed?.length || 0} 项`,
      ...((report.completed || []).map(i => `${i}`)),
      '',
      `🎯 待办/进行中: ${report.tomorrowFocus?.length || 0} 项`,
      ...((report.tomorrowFocus || []).map(i => `${i}`))
    ];

    if (report.risks && report.risks.length > 0) {
      items.push('', '⚠️  风险提醒:', ...report.risks);
    }

    // 发送通知
    const { sendNotification } = await import('../utils/webhook.js');
    await sendNotification(title, report.summary || '', items);

    res.json({ success: true, message: '推送成功' });
  } catch (err) {
    console.error('推送报告失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// ==================== 手动触发接口（用于测试） ====================

/**
 * POST /api/test/morning - 手动触发早间提醒
 */
router.post('/test/morning', async (req, res) => {
  try {
    await reminderService.triggerMorningReminder();
    res.json({ success: true, message: '早间提醒已触发' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/test/evening - 手动触发晚间日报
 */
router.post('/test/evening', async (req, res) => {
  try {
    await summaryService.triggerEveningSummary();
    res.json({ success: true, message: '晚间日报已触发' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/webhook/test - 测试 Webhook
 */
router.post('/webhook/test', async (req, res) => {
  try {
    const { url, type } = req.body;
    if (!url) {
      return res.status(400).json({ error: '请输入 Webhook 地址' });
    }

    // We send a generic test message via testWebhook
    const result = await testWebhook(url, type);

    if (result.success) {
      res.json({ success: true, message: '测试消息发送成功' });
    } else {
      res.status(400).json({ error: result.message || '测试消息发送失败' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/webhook/config - 设置 Webhook 配置（持久化到 .env）
 */
router.post('/webhook/config', async (req, res) => {
  try {
    const { url, type } = req.body;

    // 更新运行时配置
    const configModule = await import('../config.js');
    configModule.config.webhook.url = url || '';
    configModule.config.webhook.type = type || 'generic';

    // 持久化到 .env 文件
    const envUpdates = {
      WEBHOOK_URL: url || '',
      WEBHOOK_TYPE: type || 'generic'
    };
    configModule.updateEnvFile(envUpdates);

    console.log(`[API] Webhook配置已更新并保存:`, { url: url ? '***' : '(空)', type });

    res.json({ success: true, message: 'Webhook 配置已保存' });
  } catch (err) {
    console.error(`[API] Webhook配置更新失败:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/webhook/config - 获取当前 Webhook 配置状态
 */
router.get('/webhook/config', async (req, res) => {
  try {
    const configModule = await import('../config.js');
    const webhookConfig = configModule.config.webhook;
    res.json({
      success: true,
      data: {
        hasUrl: !!webhookConfig.url,
        type: webhookConfig.type || 'generic',
        urlPrefix: webhookConfig.url ? webhookConfig.url.substring(0, 20) + '...' : '(空)'
      }
    });
  } catch (err) {
    console.error(`[API] 获取Webhook配置失败:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/config - 保存所有配置（持久化到 .env）
 */
/**
 * 设置页「获取模型列表」「测试连接」用的目标：接口地址 + Key
 *
 * 由后端去请求（扩展页直连服务商会受跨域限制）。没填 Key 时只在地址与已保存的一致时用已保存的 Key，
 * 不会把已保存的 Key 发给别的地址。
 */
async function resolveAiTarget(body) {
  const { config, normalizeAiBaseUrl, savedKeyFor } = await import('../config.js');
  const base = normalizeAiBaseUrl((body && body.baseUrl) || config.ai.baseURL);
  if (!/^https?:\/\/[^/\s]+/i.test(base)) return { error: '接口地址应以 http:// 或 https:// 开头' };
  let apiKey = String((body && body.apiKey) || '').trim();
  // 没填：用这个地址以前保存过的 Key（按主机保存，不会发给别的地址）
  if (!apiKey) apiKey = savedKeyFor(base);
  if (!apiKey) return { error: '请先填写 API Key' };
  return { base, apiKey };
}

function describeAiHttpError(status, data) {
  const msg = (data && (data.error?.message || data.message || data.msg)) || '';
  if (status === 401 || status === 403) return `API Key 无效或没有权限（HTTP ${status}）${msg ? `：${msg}` : ''}`;
  if (status === 404) return `接口地址不对（HTTP 404），一般应以 /v1 结尾${msg ? `：${msg}` : ''}`;
  return `HTTP ${status}${msg ? `：${msg}` : ''}`;
}

/**
 * POST /api/ai/models - 读取服务商的模型列表（OpenAI 兼容的 GET /models）
 * body: { baseUrl?, apiKey? }
 */
router.post('/ai/models', async (req, res) => {
  try {
    const target = await resolveAiTarget(req.body);
    if (target.error) return res.status(400).json({ success: false, message: target.error });
    const resp = await fetch(`${target.base}/models`, {
      headers: { Authorization: `Bearer ${target.apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000)
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) return res.status(502).json({ success: false, message: `获取模型列表失败：${describeAiHttpError(resp.status, data)}` });
    const list = Array.isArray(data) ? data : (data && (data.data || data.models)) || [];
    const models = [...new Set(list.map(m => (typeof m === 'string' ? m : m && (m.id || m.name))).filter(Boolean).map(String))]
      .sort((a, b) => a.localeCompare(b));
    if (!models.length) return res.status(502).json({ success: false, message: '服务商没有返回模型列表（可能不支持 /models），请手动填写模型名' });
    res.json({ success: true, models, baseUrl: target.base });
  } catch (err) {
    const timeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    res.status(502).json({ success: false, message: timeout ? '获取模型列表超时（15 秒）' : `获取模型列表失败：${err.message}` });
  }
});

/**
 * POST /api/ai/test - 测试连接：按用途发一条与真实场景同类的请求，给出是否适合的结论
 * body: { baseUrl?, apiKey?, model, purpose: 'task' | 'report' }
 */
router.post('/ai/test', async (req, res) => {
  try {
    const target = await resolveAiTarget(req.body);
    if (target.error) return res.status(400).json({ success: false, message: target.error });
    const model = String((req.body && req.body.model) || '').trim();
    if (!model) return res.status(400).json({ success: false, message: '请先填写模型' });
    const purpose = req.body.purpose === 'report' ? 'report' : 'task';
    const { probeModel, verdictFor } = await import('../services/aiProbe.js');
    const r = await probeModel({ ...target, model, purpose });
    const verdict = verdictFor(purpose, r);
    res.status(r.ok ? 200 : 502).json({ success: r.ok, ...r, verdict, message: r.ok ? verdict.text : r.error });
  } catch (err) {
    res.status(502).json({ success: false, message: `连接失败：${err.message}` });
  }
});

/**
 * POST /api/ai/benchmark - 测速推荐：对模型列表逐个发一条任务解析请求，给两类用途各推荐几个
 * body: { baseUrl?, apiKey?, models: string[] }（最多测 24 个；cn:xxx 与 xxx 只测一个）
 */
router.post('/ai/benchmark', async (req, res) => {
  try {
    const target = await resolveAiTarget(req.body);
    if (target.error) return res.status(400).json({ success: false, message: target.error });
    const { pickCandidates, benchmark, recommend, verdictFor } = await import('../services/aiProbe.js');
    const { models, skipped } = pickCandidates(Array.isArray(req.body.models) ? req.body.models : []);
    if (!models.length) return res.status(400).json({ success: false, message: '没有可测试的模型，请先获取模型列表' });
    const results = await benchmark({ ...target, models });
    res.json({
      success: true,
      results: results.map(r => ({ ...r, task: verdictFor('task', r), report: verdictFor('report', r) }))
        .sort((a, b) => (b.ok - a.ok) || a.seconds - b.seconds),
      recommend: recommend(results),
      tested: models.length,
      skipped
    });
  } catch (err) {
    res.status(502).json({ success: false, message: `测速失败：${err.message}` });
  }
});

router.post('/config', async (req, res) => {
  try {
    const {
      apiKey,
      apiBaseUrl,
      aiModel,
      aiReportModel,
      morningHour,
      eveningHour,
      workHours,
      webhookUrl,
      webhookType
    } = req.body;

    // 更新运行时配置
    const configModule = await import('../config.js');
    // 换地址前先把当前 Key 记到原地址下：以前直接换掉，原服务商的 Key 就丢了（切回去要重填）
    const prevKeyring = configModule.rememberKey(configModule.config.ai.baseURL, configModule.config.ai.apiKey);
    if (apiBaseUrl !== undefined) configModule.config.ai.baseURL = configModule.normalizeAiBaseUrl(apiBaseUrl);
    // Key 留空 = 用这个地址以前保存的 Key（切换服务商再切回来不用重填；也不会把已保存的 Key 冲成空）
    let keyring = prevKeyring;
    if (apiKey !== undefined) {
      const typed = String(apiKey || '').trim();
      configModule.config.ai.apiKey = typed || configModule.savedKeyFor(configModule.config.ai.baseURL);
      keyring = configModule.rememberKey(configModule.config.ai.baseURL, configModule.config.ai.apiKey);
    }
    if (aiModel !== undefined) configModule.config.ai.model = String(aiModel).trim();
    if (aiReportModel !== undefined) configModule.config.ai.reportModel = String(aiReportModel || '').trim();
    if (morningHour !== undefined) configModule.config.schedule.morningHour = parseInt(morningHour);
    if (eveningHour !== undefined) configModule.config.schedule.eveningHour = parseInt(eveningHour);
    if (workHours !== undefined) {
      const wh = parseFloat(workHours);
      if (!(wh > 0 && wh <= 24)) return res.status(400).json({ success: false, message: '每日标准工时应大于 0 且不超过 24 小时' });
      configModule.config.schedule.workHours = wh;
    }
    if (webhookUrl !== undefined) configModule.config.webhook.url = webhookUrl;
    if (webhookType !== undefined) configModule.config.webhook.type = webhookType;

    // 持久化到 .env 文件
    const envUpdates = {};
    if (apiKey !== undefined) envUpdates.OPENAI_API_KEY = configModule.config.ai.apiKey;
    if (apiKey !== undefined || apiBaseUrl !== undefined) envUpdates.OPENAI_API_KEYS = keyring;
    if (apiBaseUrl !== undefined) envUpdates.OPENAI_BASE_URL = configModule.config.ai.baseURL;
    if (aiModel !== undefined) envUpdates.OPENAI_MODEL = configModule.config.ai.model;
    if (aiReportModel !== undefined) envUpdates.OPENAI_REPORT_MODEL = configModule.config.ai.reportModel;
    if (morningHour !== undefined) envUpdates.MORNING_HOUR = morningHour;
    if (eveningHour !== undefined) envUpdates.EVENING_HOUR = eveningHour;
    if (workHours !== undefined) envUpdates.WORK_HOURS_PER_DAY = configModule.config.schedule.workHours;
    if (webhookUrl !== undefined) envUpdates.WEBHOOK_URL = webhookUrl;
    if (webhookType !== undefined) envUpdates.WEBHOOK_TYPE = webhookType;

    configModule.updateEnvFile(envUpdates);

    console.log(`[API] 配置已保存到 .env 文件`);

    res.json({ success: true, message: '配置已保存' });
  } catch (err) {
    console.error(`[API] 保存配置失败:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/config/export - 加密导出用户自己配置的部分（含禅道密码与 AI Key）
 * body: { passphrase, client: { aiProvider, aiProfiles } } → 导出文件（JSON）
 */
router.post('/config/export', async (req, res) => {
  try {
    const { collectSettings, encryptSettings } = await import('../services/configTransfer.js');
    const b = req.body || {};
    const settings = await collectSettings(b.client || {});
    res.json({ success: true, data: encryptSettings(settings, b.passphrase) });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/config/import - 用口令解密导出文件并写回后端
 * body: { file, passphrase } → { applied: 已导入的内容, client: 交给浏览器回填的设置（不含密码与 Key） }
 */
router.post('/config/import', async (req, res) => {
  try {
    const { decryptSettings, applySettings } = await import('../services/configTransfer.js');
    const b = req.body || {};
    const settings = decryptSettings(b.file, b.passphrase);
    const result = await applySettings(settings);
    console.log(`[API] 已导入配置：${result.applied.join('、')}`);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/config - 获取所有配置
 */
router.get('/config', async (req, res) => {
  try {
    const configModule = await import('../config.js');
    const cfg = configModule.config;
    res.json({
      success: true,
      data: {
        ai: {
          apiKey: cfg.ai.apiKey ? '***已设置***' : '',
          apiBaseUrl: cfg.ai.baseURL,
          aiModel: cfg.ai.model,
          aiReportModel: cfg.ai.reportModel || '',
          // 哪些接口地址（主机）保存过 Key：设置页据此提示「已保存，留空即可」，不回传 Key 本身
          savedKeyHosts: [...new Set([...Object.keys(cfg.ai.keys || {}), ...(cfg.ai.apiKey ? [configModule.aiKeyHost(cfg.ai.baseURL)] : [])])].filter(Boolean),
          // 前端据此提示用户：AI 未配置时功能会降级，避免误以为「AI 不聪明」
          available: !!(cfg.ai.apiKey && cfg.ai.apiKey.trim()),
          unavailableReason: (!cfg.ai.apiKey || !cfg.ai.apiKey.trim())
            ? 'OPENAI_API_KEY 未配置，AI 解析与执行匹配已降级为本地规则'
            : ''
        },
        schedule: {
          morningHour: cfg.schedule.morningHour,
          eveningHour: cfg.schedule.eveningHour,
          workHours: cfg.schedule.workHours
        },
        webhook: {
          hasUrl: !!cfg.webhook.url,
          type: cfg.webhook.type || 'generic',
          // 完整地址：设置页以后端为准回填（只有本插件能访问本接口，见 requestGuard）
          url: cfg.webhook.url || '',
          urlPrefix: cfg.webhook.url ? cfg.webhook.url.substring(0, 30) + '...' : '(空)'
        },
        zentao: {
          enabled: cfg.zentao.enabled,
          url: cfg.zentao.url,
          username: cfg.zentao.username,
          hasPassword: !!cfg.zentao.password
        }
      }
    });
  } catch (err) {
    console.error(`[API] 获取配置失败:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/prompts - 获取提示词配置
 */
router.get('/prompts', async (req, res) => {
  try {
    const configModule = await import('../config.js');
    const openaiModule = await import('../ai/openai.js');
    res.json({
      success: true,
      data: {
        custom: configModule.config.prompts,
        default: {
          addTask: openaiModule.TASK_ANALYSIS_PROMPT,
          summary: openaiModule.SUMMARY_PROMPT
        }
      }
    });
  } catch (err) {
    console.error(`[API] 获取提示词配置失败:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/prompts - 保存提示词配置（持久化到 .env）
 */
router.post('/prompts', async (req, res) => {
  try {
    const { addTask, daily, weekly, monthly } = req.body;

    // 更新运行时配置
    const configModule = await import('../config.js');
    if (addTask !== undefined) configModule.config.prompts.addTask = addTask;
    if (daily !== undefined) configModule.config.prompts.daily = daily;
    if (weekly !== undefined) configModule.config.prompts.weekly = weekly;
    if (monthly !== undefined) configModule.config.prompts.monthly = monthly;

    // 持久化到 .env 文件 (使用 base64 编码存放多行文本)
    const envUpdates = {};
    if (addTask !== undefined) envUpdates.PROMPT_ADD_TASK = addTask ? Buffer.from(addTask).toString('base64') : '';
    if (daily !== undefined) envUpdates.PROMPT_DAILY = daily ? Buffer.from(daily).toString('base64') : '';
    if (weekly !== undefined) envUpdates.PROMPT_WEEKLY = weekly ? Buffer.from(weekly).toString('base64') : '';
    if (monthly !== undefined) envUpdates.PROMPT_MONTHLY = monthly ? Buffer.from(monthly).toString('base64') : '';

    configModule.updateEnvFile(envUpdates);

    console.log(`[API] 提示词已保存到 .env 文件`);
    res.json({ success: true, message: '提示词已保存' });
  } catch (err) {
    console.error(`[API] 保存提示词失败:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== 数据同步接口 ====================

// ==================== 工时相关接口 ====================

/**
 * GET /api/workHours - 今日已填工时（以禅道为准，由工时服务汇总；缓存 60 秒内不重复请求禅道）
 * 返回 { hours, standard, date }。以前的 POST（前端自己累加再存）已去掉：工时只有一个来源，就是禅道。
 */
router.get('/workHours', async (req, res) => {
  try {
    const { getDayHours } = await import('../services/effortService.js');
    const r = await getDayHours();
    res.json({ success: true, data: { hours: r.hours, standard: r.standard, date: r.date } });
  } catch (err) {
    // 禅道没配置 / 连不上：今日工时记为 0，不影响其它功能
    if (err && err.code === 'ZENTAO_DISABLED') return res.json({ success: true, data: { hours: 0, standard: 8, date: '' } });
    console.error('[API] 获取工时失败:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== 禅道集成接口 ====================

/**
 * GET /api/zentao/config - 获取禅道配置状态
 */
router.get('/zentao/config', async (req, res) => {
  try {
    const configModule = await import('../config.js');
    const zentaoConfig = configModule.config.zentao;

    res.json({
      success: true,
      data: {
        enabled: zentaoConfig.enabled || false,
        url: zentaoConfig.url || '',
        username: zentaoConfig.username || '',
        // 密码绝不回传（禅道操作全部由后端完成，前端用不到明文密码）
        hasPassword: !!zentaoConfig.password,
        createTaskUrl: zentaoConfig.createTaskUrl || ''
      }
    });
  } catch (err) {
    console.error('[API] 获取禅道配置失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/zentao/config - 保存禅道配置
 */
router.post('/zentao/config', async (req, res) => {
  try {
    const {
      enabled,
      url,
      username,
      password,
      createTaskUrl
    } = req.body;

    console.log('[API] 保存禅道配置:', {
      enabled,
      url: url ? url.substring(0, 30) + '...' : '(空)',
      username,
      createTaskUrl
    });

    const configModule = await import('../config.js');
    const next = configModule.mergeZentaoSettings({ enabled, url, username, password, createTaskUrl }, configModule.config.zentao);

    // 先持久化（含输入校验，失败时运行时配置保持不变）
    configModule.updateEnvFile({
      ZENTAO_ENABLED: next.enabled ? 'true' : 'false',
      ZENTAO_URL: next.url,
      ZENTAO_USERNAME: next.username,
      ZENTAO_PASSWORD: next.password,
      ZENTAO_CREATE_TASK_URL: next.createTaskUrl
    });

    // 更新运行时配置
    Object.assign(configModule.config.zentao, next);

    // 账号或地址可能变了，作废旧会话与登录状态缓存
    const { clearCookies } = await import('../services/zentaoService.js');
    clearCookies();
    (await import('../services/account.js')).invalidateState();

    console.log('[API] 禅道配置已保存');
    res.json({ success: true, message: '禅道配置已保存' });
  } catch (err) {
    console.error('[API] 保存禅道配置失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== 禅道后端直连接口 ====================
// 这些接口直接调用 src/services/zentaoService.js（纯 HTTP + session cookie），
// 凭据来自后端 .env，无需浏览器打开禅道标签页。用于替代历史上的标签页注入方式。

/** 统一读取后端禅道配置并判断是否可用 */
async function loadZentaoConfigOrError(res) {
  const configModule = await import('../config.js');
  const z = configModule.config.zentao || {};
  if (!z.enabled) {
    res.status(400).json({ success: false, message: '还没有登录禅道（点右上角「登录禅道」）' });
    return null;
  }
  if (!z.url || !z.username || !z.password) {
    res.status(400).json({ success: false, message: '还没有登录禅道（点右上角「登录禅道」）' });
    return null;
  }
  return z;
}

/**
 * GET /api/zentao/my-tasks - 我的任务（地盘 → 我的任务）
 */
router.get('/zentao/my-tasks', async (req, res) => {
  try {
    if (!(await loadZentaoConfigOrError(res))) return;
    const { getMyTasks } = await import('../services/zentaoService.js');
    const tasks = await getMyTasks();
    res.json({ success: true, data: tasks, count: tasks.length });
  } catch (err) {
    console.error('[API] 获取我的任务失败:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/zentao/tasks?executionId=167&assignedTo=&status= - 查询某执行下的任务
 */
router.get('/zentao/tasks', async (req, res) => {
  try {
    if (!(await loadZentaoConfigOrError(res))) return;
    const { getTasks } = await import('../services/zentaoService.js');
    const { executionId, assignedTo, status } = req.query;
    const tasks = await getTasks({ executionId, assignedTo, status });
    res.json({ success: true, data: tasks, count: tasks.length });
  } catch (err) {
    console.error('[API] 查询任务失败:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/zentao/executions - 执行列表
 */
router.get('/zentao/executions', async (req, res) => {
  try {
    if (!(await loadZentaoConfigOrError(res))) return;
    const { getExecutions } = await import('../services/zentaoService.js');
    const executions = await getExecutions();
    res.json({ success: true, data: executions, count: executions.length });
  } catch (err) {
    console.error('[API] 获取执行列表失败:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/zentao/task/estimate - 登记工时
 * body: { taskId, work, consumed, left }
 */
router.post('/zentao/task/estimate', async (req, res) => {
  try {
    if (!(await loadZentaoConfigOrError(res))) return;
    const { taskId, work, consumed, left } = req.body || {};
    if (!taskId) return res.status(400).json({ success: false, message: '缺少 taskId' });
    const { recordTaskEstimate } = await import('../services/zentaoService.js');
    const result = await recordTaskEstimate(taskId, {
      work,
      consumed: Number(consumed) || 0,
      left: left != null && left !== '' ? Number(left) : undefined
    });
    res.json(result);
  } catch (err) {
    console.error('[API] 登记工时失败:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/zentao/task/status - 更新任务状态
 * body: { taskId, status, consumed?, comment? }  status: wait/doing/done/closed
 */
router.post('/zentao/task/status', async (req, res) => {
  try {
    if (!(await loadZentaoConfigOrError(res))) return;
    const { taskId, status, consumed, comment } = req.body || {};
    if (!taskId || !status) {
      return res.status(400).json({ success: false, message: '缺少 taskId 或 status' });
    }
    const { updateTaskStatus } = await import('../services/zentaoService.js');
    const result = await updateTaskStatus(taskId, status, { consumed, comment });
    res.json(result);
  } catch (err) {
    console.error('[API] 更新任务状态失败:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ==================== 项目相关接口 ====================

/**
 * GET /api/projects - 获取项目列表
 */
router.get('/projects', async (req, res) => {
  try {
    const { getProjects, getFavoriteProjects } = await import('../services/projectManager.js');
    const projects = await getProjects();
    const favorites = await getFavoriteProjects();

    // 标记收藏的项目
    const projectsWithFavorite = projects.map(p => ({
      ...p,
      isFavorite: favorites.some(f => f.id === p.id)
    }));

    res.json({ success: true, data: projectsWithFavorite });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/projects/favorites - 获取收藏的项目列表
 */
router.get('/projects/favorites', async (req, res) => {
  try {
    const { getFavoriteProjects } = await import('../services/projectManager.js');
    const projects = await getFavoriteProjects();
    res.json({ success: true, data: projects });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/projects/favorites - 设置收藏项目
 */
router.post('/projects/favorites', async (req, res) => {
  try {
    const { projectIds } = req.body;
    if (!Array.isArray(projectIds)) {
      return res.status(400).json({ success: false, error: 'projectIds 必须是数组' });
    }
    const { setFavoriteProjects } = await import('../services/projectManager.js');
    await setFavoriteProjects(projectIds);
    res.json({ success: true, message: '收藏项目已设置' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/projects/favorites/add - 添加收藏项目
 */
router.post('/projects/favorites/add', async (req, res) => {
  try {
    const { projectId } = req.body;
    if (!projectId) {
      return res.status(400).json({ success: false, error: '缺少 projectId' });
    }
    const { addFavoriteProject } = await import('../services/projectManager.js');
    await addFavoriteProject(projectId);
    res.json({ success: true, message: '已添加到收藏' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/projects/favorites/remove - 移除收藏项目
 */
router.post('/projects/favorites/remove', async (req, res) => {
  try {
    const { projectId } = req.body;
    if (!projectId) {
      return res.status(400).json({ success: false, error: '缺少 projectId' });
    }
    const { removeFavoriteProject } = await import('../services/projectManager.js');
    await removeFavoriteProject(projectId);
    res.json({ success: true, message: '已从收藏移除' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/ai/match-project - AI 匹配项目
 */
router.post('/ai/match-project', async (req, res) => {
  try {
    const { content } = req.body;
    if (!content) {
      return res.status(400).json({ success: false, error: '缺少 content' });
    }

    // 获取收藏项目
    const { getFavoriteProjects } = await import('../services/projectManager.js');
    const favoriteProjects = await getFavoriteProjects();

    if (favoriteProjects.length === 0) {
      return res.json({ success: true, data: null, message: '没有收藏的项目' });
    }

    // 构建 AI 提示词
    const projectsList = favoriteProjects.map(p => `- ${p.id}: ${p.name}`).join('\n');

    const prompt = `你是项目分类助手。根据任务内容，判断其归属于哪个项目。

【可用项目列表】
${projectsList}

【分析规则】
1. 根据项目名称判断任务归属
2. 返回置信度（0-1）
3. 如果无法确定，返回 null

用户输入：${content}

请只返回JSON：
{
  "projectId": "项目ID或null",
  "projectName": "项目名称",
  "confidence": 0.95,
  "reason": "判断原因"
}`;

    // 调用 AI
    const { generateResponse } = await import('../ai/openai.js');
    const aiResponse = await generateResponse(prompt);

    // 解析 AI 响应
    let matchResult = null;
    try {
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        matchResult = JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      console.error('[API] 解析 AI 响应失败:', e);
    }

    res.json({ success: true, data: matchResult });
  } catch (err) {
    console.error('[API] AI 匹配项目失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/ai/analyze-bug - AI 分析 Bug 生成标题和类型
 */
router.post('/ai/analyze-bug', async (req, res) => {
  try {
    const { steps } = req.body;
    if (!steps) {
      return res.status(400).json({ success: false, error: '缺少 steps' });
    }

    const prompt = `你是 Bug 分析助手。根据用户提供的 Bug 复现步骤，生成简洁的 Bug 标题并判断类型。

【Bug 类型列表】
- codeerror: 代码错误（程序报错、异常、崩溃）
- config: 配置相关（配置错误、环境问题）
- install: 安装部署（部署失败、依赖问题）
- security: 安全相关（权限、数据泄露）
- performance: 性能问题（慢、卡顿、内存占用高）
- standard: 标准规范（代码风格、命名规范）
- automation: 测试脚本（测试用例问题）
- designdefect: 设计缺陷（逻辑错误、交互问题）
- others: 其他

【分析规则】
1. 标题要简洁，不超过20字，突出核心问题
2. 根据复现步骤判断 Bug 类型
3. 严重程度默认为 3（一般），明显严重的可以设为 2（严重）

用户输入的复现步骤：
${steps}

请只返回JSON：
{
  "title": "简洁的Bug标题",
  "type": "bug类型代码",
  "severity": 3
}`;

    const { generateResponse } = await import('../ai/openai.js');
    const aiResponse = await generateResponse(prompt);

    // 解析 AI 响应
    let analysisResult = { title: '未知Bug', type: 'others', severity: 3 };
    try {
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        analysisResult = { ...analysisResult, ...parsed };
      }
    } catch (e) {
      console.error('[API] 解析 AI 响应失败:', e);
    }

    console.log('[API] Bug 分析结果:', analysisResult);
    res.json({ success: true, data: analysisResult });
  } catch (err) {
    console.error('[API] AI 分析 Bug 失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/ai/match-execution - AI 匹配执行
 */
router.post('/ai/match-execution', async (req, res) => {
  try {
    const { content } = req.body;
    if (!content) {
      return res.status(400).json({ success: false, error: '缺少 content' });
    }

    // 获取候选执行（收藏优先 + 全部执行兜底）
    const { getAiCandidateExecutions } = await import('../services/executionManager.js');
    const { candidates, totalCount, truncated } = await getAiCandidateExecutions();

    if (candidates.length === 0) {
      return res.json({
        success: true,
        data: null,
        matchedBy: 'none',
        reason: '本地没有执行数据，请先同步禅道执行'
      });
    }

    // 调用 AI 分析匹配执行
    const { analyzeTaskForExecution } = await import('../ai/openai.js');
    const match = await analyzeTaskForExecution(content, candidates);
    const matchedExecutionId = match && match.executionId;

    let matchResult = null;
    if (matchedExecutionId) {
      const matchedExec = candidates.find(e => String(e.id) === String(matchedExecutionId));
      matchResult = {
        executionId: matchedExecutionId,
        executionName: matchedExec?.name || '',
        projectName: matchedExec?.projectName || '',
        projectId: matchedExec?.projectId || ''
      };
      console.log('[API] ✓ 匹配到执行:', JSON.stringify(matchResult), 'via', match.matchedBy);
    } else {
      console.log('[API] ✗ 未匹配到执行，reason:', match && match.reason);
    }

    res.json({
      success: true,
      data: matchResult,
      matchedBy: match?.matchedBy || 'none',
      reason: match?.reason || '',
      confidence: match?.confidence ?? 0,
      meta: { totalCount, candidateCount: candidates.length, truncated }
    });
  } catch (err) {
    console.error('[API] AI 匹配执行失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== AI 执行匹配学习 ====================

/**
 * GET /api/ai/candidates - 查看当前 AI 候选集构成
 * 用于排查「AI 匹配不准」：先看候选里到底有没有正确的执行
 */
router.get('/ai/candidates', async (req, res) => {
  try {
    const { getAiCandidateExecutions } = await import('../services/executionManager.js');
    const { candidates, totalCount, truncated } = await getAiCandidateExecutions();
    res.json({
      success: true,
      data: candidates.map(c => ({
        id: c.id,
        name: c.name,
        projectName: c.projectName || '',
        type: c.type || '',
        isFavorite: !!c.isFavorite,
        isDefault: !!c.isDefault
      })),
      meta: { totalCount, candidateCount: candidates.length, truncated }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/ai/learn - 记录一次用户纠正
 * body: { content, executionId }
 * 前端在用户手动改了执行后调用，形成学习闭环
 */
router.post('/ai/learn', async (req, res) => {
  try {
    const { content, executionId } = req.body || {};
    if (!content || !executionId) {
      return res.status(400).json({ success: false, error: '缺少 content 或 executionId' });
    }
    const { learnFromCorrection, getLearningStats } = await import('../services/executionLearning.js');
    learnFromCorrection(content, executionId);
    res.json({ success: true, stats: getLearningStats() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/ai/learning-stats - 学习数据统计
 */
router.get('/ai/learning-stats', async (req, res) => {
  try {
    const { getLearningStats } = await import('../services/executionLearning.js');
    res.json({ success: true, data: getLearningStats() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/ai/learning-stats - 清空学习数据
 */
router.delete('/ai/learning-stats', async (req, res) => {
  try {
    const { clearLearningData } = await import('../services/executionLearning.js');
    clearLearningData();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== Bug 相关接口 ====================

/**
 * GET /api/bugs - 获取 Bug 列表
 */
router.get('/bugs', async (req, res) => {
  try {
    console.log('[API] GET /api/bugs 调用，查询参数:', req.query);
    const { getBugs } = await import('../services/bugManager.js');
    const filters = {
      status: req.query.status,
      executionId: req.query.executionId
    };
    const bugs = await getBugs(filters);
    console.log('[API] GET /api/bugs 返回，Bug数量:', bugs.length);
    res.json({ success: true, data: bugs });
  } catch (err) {
    console.error('[API] GET /api/bugs 错误:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/bug - 创建 Bug
 */
router.post('/bug', async (req, res) => {
  try {
    const { createBugWithSync } = await import('../services/bugManager.js');
    const bugData = req.body;

    console.log('[API] 创建 Bug:', bugData && bugData.title);

    // 如果前端没有传递 executionId，尝试从项目信息获取
    if (!bugData.executionId && bugData.projectId) {
      const { getProjectById } = await import('../services/projectManager.js');
      const project = await getProjectById(bugData.projectId);
      if (project && project.executionId) {
        bugData.executionId = project.executionId;
        bugData.executionName = project.name;
        console.log('[API] 从项目获取执行ID:', project.executionId);
      }
    }

    const result = await createBugWithSync(bugData);
    
    if (result.syncResult && result.syncResult.needRelogin) {
      res.json({ success: true, data: result.localBug, needRelogin: true, message: 'Bug 已在本地创建，但在向禅道同步时登录超时，请重新登录' });
    } else if (result.syncResult && !result.syncResult.success) {
      res.json({ success: true, data: result.localBug, message: 'Bug已经本地创建，但同步到禅道失败: ' + result.syncResult.message });
    } else {
      res.json({ success: true, data: result.localBug, message: 'Bug 已创建并同步至禅道' });
    }
  } catch (err) {
    console.error('[API] 创建 Bug 失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PUT /api/bug/:id - 更新 Bug
 */
router.put('/bug/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { updateBugStatus } = await import('../services/bugManager.js');
    const { status, assignedTo, assignedToList, cc, comment, title, priority, severity } = req.body;

    const extraData = {};
    if (title !== undefined) extraData.title = title;
    if (priority !== undefined) extraData.priority = priority;
    if (severity !== undefined) extraData.severity = severity;
    if (assignedTo !== undefined) extraData.assignedTo = assignedTo;
    if (assignedToList !== undefined) extraData.assignedToList = assignedToList;
    if (cc !== undefined) extraData.cc = cc;
    if (comment !== undefined) extraData.comment = comment;

    const bug = await updateBugStatus(id, status, extraData);
    res.json({ success: true, data: bug, message: 'Bug 已更新' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/bug/:id - 删除 Bug
 */
router.delete('/bug/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { deleteBug } = await import('../services/bugManager.js');
    await deleteBug(id);
    res.json({ success: true, message: 'Bug 已删除' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/bugs/all - 删除所有 Bug
 */
router.delete('/bugs/all', async (req, res) => {
  try {
    const { deleteAllBugs } = await import('../services/bugManager.js');
    const result = await deleteAllBugs();
    res.json({ success: true, deletedCount: result.deletedCount, message: `已删除 ${result.deletedCount} 个 Bug` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/bugs/migrate - 迁移Bug数据
 */
router.post('/bugs/migrate', async (req, res) => {
  try {
    const { migrateBugData } = await import('../services/bugManager.js');
    const result = await migrateBugData();
    res.json({
      success: true,
      migratedCount: result.migratedCount,
      total: result.total,
      message: `已迁移 ${result.migratedCount}/${result.total} 个Bug`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/bugs/stats - 获取 Bug 统计
 */
router.get('/bugs/stats', async (req, res) => {
  try {
    const { getBugStats } = await import('../services/bugManager.js');
    const stats = await getBugStats();
    res.json({ success: true, data: stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PUT /api/bug/:id/zentaoId - 更新 Bug 的禅道ID
 */
router.put('/bug/:id/zentaoId', async (req, res) => {
  try {
    const { id } = req.params;
    const { zentaoId } = req.body;

    console.log('[API] 更新 Bug 禅道ID, BugID:', id, 'ZentaoID:', zentaoId);

    const { updateTasks } = await import('../utils/storage.js');
    let bug = null;
    await updateTasks((data) => {
      bug = data.tasks.find(t => t.id === id);
      if (bug) {
        bug.zentaoId = zentaoId;
        bug.updatedAt = new Date().toISOString();
      }
      return data;
    });
    if (!bug) {
      return res.status(404).json({ success: false, error: 'Bug not found' });
    }

    console.log('[API] Bug 禅道ID已更新');
    // Bug 刚同步到禅道：推送积压的附件
    if (zentaoId) {
      const { schedulePush } = await import('../services/attachmentSync.js');
      schedulePush(id);
    }
    res.json({ success: true, data: bug });
  } catch (err) {
    console.error('[API] 更新 Bug 禅道ID失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/executions - 获取执行列表（收藏的排在前面）
 */
router.get('/executions', async (req, res) => {
  try {
    const { getExecutionsOrdered } = await import('../services/executionManager.js');
    const executions = await getExecutionsOrdered();
    res.json({ success: true, data: executions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/executions/update-types - 更新执行类型字段
 */
router.post('/executions/update-types', async (req, res) => {
  try {
    const { getExecutions } = await import('../services/executionManager.js');
    // 触发getExecutions会自动更新type字段
    const executions = await getExecutions();
    res.json({ success: true, data: executions, message: '执行类型已更新' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/executions/default - 设置默认执行
 */
router.post('/executions/default', async (req, res) => {
  try {
    const { executionId } = req.body;
    if (!executionId) {
      return res.status(400).json({ success: false, error: '缺少执行ID' });
    }
    const { setDefaultExecution } = await import('../services/executionManager.js');
    await setDefaultExecution(executionId);
    res.json({ success: true, message: '默认执行已设置' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/executions/favorites - 获取收藏的执行列表
 */
router.get('/executions/favorites', async (req, res) => {
  try {
    const { getFavoriteExecutions } = await import('../services/executionManager.js');
    const executions = await getFavoriteExecutions();
    res.json({ success: true, data: executions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/executions/favorites - 设置收藏的执行列表
 */
router.post('/executions/favorites', async (req, res) => {
  try {
    const { executionIds } = req.body;
    if (!Array.isArray(executionIds)) {
      return res.status(400).json({ success: false, error: 'executionIds 必须是数组' });
    }
    const { setFavoriteExecutions } = await import('../services/executionManager.js');
    await setFavoriteExecutions(executionIds);
    res.json({ success: true, message: '收藏执行已设置' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/executions/favorites/add - 添加收藏执行
 */
router.post('/executions/favorites/add', async (req, res) => {
  try {
    const { executionId } = req.body;
    if (!executionId) {
      return res.status(400).json({ success: false, error: '缺少 executionId' });
    }
    const { addFavoriteExecution } = await import('../services/executionManager.js');
    await addFavoriteExecution(executionId);
    res.json({ success: true, message: '已添加到收藏' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/executions/favorites/remove - 移除收藏执行
 */
router.post('/executions/favorites/remove', async (req, res) => {
  try {
    const { executionId } = req.body;
    if (!executionId) {
      return res.status(400).json({ success: false, error: '缺少 executionId' });
    }
    const { removeFavoriteExecution } = await import('../services/executionManager.js');
    await removeFavoriteExecution(executionId);
    res.json({ success: true, message: '已从收藏移除' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== 禅道双向同步接口 ====================

/**
 * POST /api/zentao/task/create - 创建禅道任务（后端直连）
 * body: { name|title, desc|content, executionId|exec, estimate, estStarted, dueDate|deadline, priority|pri, assignedTo|assign, type }
 */
router.post('/zentao/task/create', async (req, res) => {
  try {
    if (!(await loadZentaoConfigOrError(res))) return;
    const b = req.body || {};
    const title = b.name || b.title;
    if (!title) return res.status(400).json({ success: false, message: '缺少任务名称（name/title）' });
    const { createTask } = await import('../services/zentaoService.js');
    const kanban = b.kanban
      ? b.kanban
      : (b.regionId && b.laneId && b.columnId)
        ? { regionId: b.regionId, laneId: b.laneId, columnId: b.columnId }
        : undefined;
    const result = await createTask({
      title,
      content: b.desc || b.content || '',
      executionId: b.executionId || b.exec,
      estimate: b.estimate,
      estStarted: b.estStarted,
      dueDate: b.dueDate || b.deadline,
      priority: b.priority != null ? b.priority : b.pri,
      assignedTo: b.assignedTo || b.assign,
      type: b.type,
      kanban
    });
    res.status(result.success ? 200 : 400).json(result);
  } catch (err) {
    console.error('[API] 创建任务失败:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/zentao/kanban/params?executionId=148&laneType=task&columnType=wait
 * 后端解析看板页面参数（productId/projectId/regionId/laneId/columnId）
 */
router.get('/zentao/kanban/params', async (req, res) => {
  try {
    if (!(await loadZentaoConfigOrError(res))) return;
    const { executionId, laneType = 'task', columnType = 'wait' } = req.query;
    if (!executionId) return res.status(400).json({ success: false, message: '缺少 executionId' });
    const { getKanbanPageParams } = await import('../services/zentaoService.js');
    const result = await getKanbanPageParams(executionId, laneType, columnType);
    if (!result) return res.status(500).json({ success: false, message: '解析看板参数失败' });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/zentao/kanban/view?kanbanId=148 - 看板视图数据
 */
router.get('/zentao/kanban/view', async (req, res) => {
  try {
    if (!(await loadZentaoConfigOrError(res))) return;
    const { kanbanId } = req.query;
    if (!kanbanId) return res.status(400).json({ success: false, message: '缺少 kanbanId' });
    const { getKanbanView } = await import('../services/zentaoService.js');
    const data = await getKanbanView(kanbanId);
    res.json({ success: !!data, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/zentao/kanban/check?executionId=148 - 检测是否为看板类型
 */
router.get('/zentao/kanban/check', async (req, res) => {
  try {
    if (!(await loadZentaoConfigOrError(res))) return;
    const { executionId } = req.query;
    if (!executionId) return res.status(400).json({ success: false, message: '缺少 executionId' });
    const { quickCheckKanban } = await import('../services/zentaoService.js');
    const result = await quickCheckKanban(executionId);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/zentao/kanban/card/status - 更新看板卡片状态
 * body: { cardId, kanbanId, status }  status: todo/in_progress/done
 */
router.post('/zentao/kanban/card/status', async (req, res) => {
  try {
    if (!(await loadZentaoConfigOrError(res))) return;
    const { cardId, kanbanId, status } = req.body || {};
    if (!cardId || !kanbanId || !status) {
      return res.status(400).json({ success: false, message: '缺少 cardId / kanbanId / status' });
    }
    const { updateKanbanCardStatus } = await import('../services/zentaoService.js');
    const result = await updateKanbanCardStatus(cardId, kanbanId, status);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/zentao/kanban/card/create - 创建看板卡片
 * body: { kanbanId, regionId, groupId, columnId, name, spec, pri, assignedTo, deadline, begin, estimate, color }
 */
router.post('/zentao/kanban/card/create', async (req, res) => {
  try {
    if (!(await loadZentaoConfigOrError(res))) return;
    const { createKanbanCard } = await import('../services/zentaoService.js');
    const result = await createKanbanCard(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/zentao/task/delete - 删除任务
 * body: { executionId, taskId }
 */
router.post('/zentao/task/delete', async (req, res) => {
  try {
    if (!(await loadZentaoConfigOrError(res))) return;
    const { executionId, taskId } = req.body || {};
    if (!executionId || !taskId) return res.status(400).json({ success: false, message: '缺少 executionId / taskId' });
    const { deleteTask } = await import('../services/zentaoService.js');
    const result = await deleteTask(executionId, taskId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/zentao/search?q=关键词&type=task|bug[&details=0] - 在禅道里搜索任务 / Bug
 * 每条带上本地记录的 id（已在看板上的可以直接打开卡片）；details=0 只返回命中（快），不查状态 / 指派人
 */
router.get('/zentao/search', async (req, res) => {
  try {
    if (!(await loadZentaoConfigOrError(res))) return;
    const type = req.query.type === 'bug' ? 'bug' : 'task';
    const q = String(req.query.q || '').trim().slice(0, 100);
    const { searchZentao } = await import('../services/zentaoService.js');
    const { items, total } = await searchZentao(q, type, { details: req.query.details !== '0' });
    const { readTasks } = await import('../utils/storage.js');
    const localOf = new Map(((await readTasks()).tasks || [])
      .filter(t => t.zentaoId && (type === 'bug' ? t.type === 'bug' : t.type !== 'bug'))
      .map(t => [String(t.zentaoId), t.id]));
    res.json({ success: true, data: { items: items.map(x => ({ ...x, localId: localOf.get(x.id) || null })), total } });
  } catch (err) {
    const { describeZentaoTransportError } = await import('../services/zentaoService.js');
    res.status(502).json({ success: false, message: describeZentaoTransportError(err) });
  }
});

/**
 * POST /api/zentao/task/edit - 编辑任务
 * body: { taskId, execution, name, pri, assignedTo, deadline }
 */
router.post('/zentao/task/edit', async (req, res) => {
  try {
    if (!(await loadZentaoConfigOrError(res))) return;
    const { taskId } = req.body || {};
    if (!taskId) return res.status(400).json({ success: false, message: '缺少 taskId' });
    const { editTask } = await import('../services/zentaoService.js');
    const result = await editTask(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/zentao/execution/product-id - 获取执行关联的产品ID
 * body: { executionId }
 */
router.post('/zentao/execution/product-id', async (req, res) => {
  try {
    if (!(await loadZentaoConfigOrError(res))) return;
    const { executionId } = req.body || {};
    if (!executionId) return res.status(400).json({ success: false, message: '缺少 executionId' });
    const { getExecutionProductId } = await import('../services/zentaoService.js');
    const result = await getExecutionProductId(executionId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/zentao/bug/create - 创建 Bug（看板 / 普通通用）
 */
router.post('/zentao/bug/create', async (req, res) => {
  try {
    if (!(await loadZentaoConfigOrError(res))) return;
    const { createBug } = await import('../services/zentaoService.js');
    const result = await createBug(req.body || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/** POST /api/zentao/bug/activate */
router.post('/zentao/bug/activate', async (req, res) => {
  try {
    if (!(await loadZentaoConfigOrError(res))) return;
    const { activateBug } = await import('../services/zentaoService.js');
    res.json(await activateBug(req.body || {}));
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

/** POST /api/zentao/bug/edit - { bugId, title?, pri?, severity? } 只改给出的字段，提交后回读确认 */
router.post('/zentao/bug/edit', async (req, res) => {
  try {
    if (!(await loadZentaoConfigOrError(res))) return;
    const { editBug } = await import('../services/zentaoService.js');
    const b = req.body || {};
    if (!b.bugId) return res.status(400).json({ success: false, message: '缺少 bugId' });
    res.json(await editBug(b));
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

/** POST /api/zentao/bug/assign - { bugId, assignedTo, comment? } 禅道「指派」动作 */
router.post('/zentao/bug/assign', async (req, res) => {
  try {
    if (!(await loadZentaoConfigOrError(res))) return;
    const { assignBug } = await import('../services/zentaoService.js');
    const b = req.body || {};
    if (!b.bugId) return res.status(400).json({ success: false, message: '缺少 bugId' });
    res.json(await assignBug(b));
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

/** POST /api/zentao/bug/reactivate - { bugId, assignedTo?, comment? } 激活（重新打开）已解决的 Bug */
router.post('/zentao/bug/reactivate', async (req, res) => {
  try {
    if (!(await loadZentaoConfigOrError(res))) return;
    const { reactivateBug } = await import('../services/zentaoService.js');
    const b = req.body || {};
    if (!b.bugId) return res.status(400).json({ success: false, message: '缺少 bugId' });
    res.json(await reactivateBug(b));
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

/** GET /api/zentao/bug/brief?bugId=1 - 关联前核对：禅道里有没有这个 Bug、标题是什么 */
router.get('/zentao/bug/brief', async (req, res) => {
  try {
    if (!(await loadZentaoConfigOrError(res))) return;
    const id = String(req.query.bugId || '');
    if (!/^\d{1,10}$/.test(id)) return res.status(400).json({ success: false, message: 'Bug 编号应为数字' });
    const { getBugBrief } = await import('../services/zentaoService.js');
    res.json({ success: true, data: await getBugBrief(id) });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

/** POST /api/zentao/bug/resolve */
router.post('/zentao/bug/resolve', async (req, res) => {
  try {
    if (!(await loadZentaoConfigOrError(res))) return;
    const { localId, attachmentIds, ...params } = req.body || {};
    // 带了附件：随解决动作一起提交（localId 为本地 Bug ID，附件挂在它上面）
    if (localId && Array.isArray(attachmentIds) && attachmentIds.length) {
      const { resolveBugWithAttachments } = await import('../services/attachmentSync.js');
      return res.json(await resolveBugWithAttachments(String(localId), params, attachmentIds.map(String)));
    }
    const { resolveBug } = await import('../services/zentaoService.js');
    res.json(await resolveBug(params));
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

/** POST /api/zentao/bug/close */
router.post('/zentao/bug/close', async (req, res) => {
  try {
    if (!(await loadZentaoConfigOrError(res))) return;
    const { closeBug } = await import('../services/zentaoService.js');
    res.json(await closeBug(req.body || {}));
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

/** POST /api/zentao/bug/delete */
router.post('/zentao/bug/delete', async (req, res) => {
  try {
    if (!(await loadZentaoConfigOrError(res))) return;
    const { bugId } = req.body || {};
    if (!bugId) return res.status(400).json({ success: false, message: '缺少 bugId' });
    const { deleteBug } = await import('../services/zentaoService.js');
    res.json(await deleteBug(bugId));
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

/** GET /api/zentao/bug/detail?bugId=1 - 读取指派人/抄送人 */
router.get('/zentao/bug/detail', async (req, res) => {
  try {
    if (!(await loadZentaoConfigOrError(res))) return;
    const { bugId } = req.query;
    if (!bugId) return res.status(400).json({ success: false, message: '缺少 bugId' });
    const { getBugDetail } = await import('../services/zentaoService.js');
    const detail = await getBugDetail(bugId);
    res.json({ success: true, data: detail });
  } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});


/**
 * POST /api/test/weekly - 测试周报生成（手动触发）
 */
router.post('/test/weekly', async (req, res) => {
  try {
    const { summaryService } = await import('../services/summary.js');
    const report = await summaryService.generateReport('weekly', true);
    res.json({ success: true, data: report, message: '周报已生成并推送' });
  } catch (err) {
    console.error('测试周报失败:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/zentao/users - 获取禅道用户列表（本地缓存为空时自动从禅道拉一次）
 */
router.get('/zentao/users', async (req, res) => {
  try {
    const { config } = await import('../config.js');
    let users = config.zentao.users || {};
    if (Object.keys(users).length === 0 && config.zentao.enabled && config.zentao.url) {
      try {
        const { refreshZentaoUsers } = await import('../services/zentaoService.js');
        users = await refreshZentaoUsers();
      } catch (err) {
        console.warn('[API] 自动拉取禅道用户列表失败:', err.message);
      }
    }
    res.json({ success: true, data: users });
  } catch (err) {
    console.error('[API] 获取禅道用户列表失败:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/zentao/users/refresh - 从禅道重新拉取团队成员
 */
router.post('/zentao/users/refresh', async (req, res) => {
  try {
    if (!(await loadZentaoConfigOrError(res))) return;
    const { refreshZentaoUsers } = await import('../services/zentaoService.js');
    const users = await refreshZentaoUsers();
    res.json({ success: true, data: users, count: Object.keys(users).length });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/zentao/test - 测试禅道连接
 * body: { url, username, password? }  password 留空时用已保存的密码
 * 只验证能否登录，不改动后端已缓存的会话，也不回传 cookie。
 */
router.post('/zentao/test', async (req, res) => {
  try {
    const { config } = await import('../config.js');
    const b = req.body || {};
    const url = String(b.url || config.zentao.url || '').trim();
    const username = String(b.username || config.zentao.username || '').trim();
    const password = b.password ? String(b.password) : config.zentao.password;
    if (!url || !username || !password) {
      return res.status(400).json({ success: false, message: '请填写禅道地址、账号和密码' });
    }
    const { loginZentao } = await import('../services/zentaoService.js');
    await loginZentao(url, username, password);
    res.json({ success: true, message: '连接并登录成功' });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/executions/sync - 从禅道同步执行列表（后端直连，同时刷新项目列表）
 */
router.post('/executions/sync', async (req, res) => {
  try {
    if (!(await loadZentaoConfigOrError(res))) return;
    const { syncExecutionsFromZentao } = await import('../services/executionManager.js');
    const executions = await syncExecutionsFromZentao();
    res.json({ success: true, data: executions, message: `已同步 ${executions.length} 个执行` });
  } catch (err) {
    console.error('[API] 同步执行列表失败:', err.message);
    res.status(500).json({ success: false, error: err.message, message: err.message });
  }
});

/**
 * POST /api/zentao/sync - 后端拉取「我的任务」「我的 Bug」并写入本地库
 * 返回: { success, data:{ added, updated, unchanged, skipped, total, bugs, bugError } }
 */
router.post('/zentao/sync', async (req, res) => {
  try {
    if (!(await loadZentaoConfigOrError(res))) return;
    const { syncMyTasks } = await import('../services/zentaoService.js');
    const result = await syncMyTasks();
    res.json({
      success: true,
      data: result,
      message: `任务同步完成: 新增 ${result.added} 个，更新 ${result.updated} 个，无变化 ${result.unchanged} 个`
    });
  } catch (err) {
    console.error('[API] 后端同步失败:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});


/**
 * POST /api/zentao/open - 在浏览器里打开禅道任务 / Bug 页面（自动登录）
 * body: { type: 'task'|'bug', id: 禅道ID, browserSid?: 浏览器当前的 zentaosid }
 * 返回: { url, cookies? }  浏览器会话已失效时，cookies 为新登录的会话，插件写入后再打开 url
 *
 * 会话 cookie 只返回给本插件（全局来源校验），且与后端自己的会话相互独立。
 */
router.post('/zentao/open', async (req, res) => {
  try {
    if (!(await loadZentaoConfigOrError(res))) return;
    const { type, id, browserSid } = req.body || {};
    if (!['task', 'bug', 'doc', 'story'].includes(type) || !/^\d+$/.test(String(id))) {
      return res.status(400).json({ success: false, message: '参数不正确' });
    }
    const z = await import('../services/zentaoService.js');
    const { config } = await import('../config.js');
    let sid = (await z.isBrowserSessionValid(browserSid)) ? String(browserSid) : null;
    let cookies = null;
    if (!sid) {
      cookies = await z.createBrowserSession();
      sid = cookies[0].value;
    }
    const base = config.zentao.url.replace(/\/$/, '');
    const url = base + (await z.resolveViewPath(type, String(id), sid));
    res.json({ success: true, base, url, cookies });
  } catch (err) {
    console.error('[API] 打开禅道页面失败:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * POST /api/tasks/:id/execution - 修改任务所属执行
 * body: { executionId, rebuild?: boolean }
 * 禅道不允许直接移动时返回 { needRebuild: true }，调用方向用户确认后带 rebuild:true 再调用
 */
router.post('/tasks/:id/execution', async (req, res) => {
  try {
    const { executionId, rebuild } = req.body || {};
    if (!executionId) return res.status(400).json({ success: false, message: '缺少 executionId' });
    const { changeTaskExecution } = await import('../services/taskExecution.js');
    const result = await changeTaskExecution(req.params.id, String(executionId), { rebuild: !!rebuild });
    res.status(result.success || result.needRebuild ? 200 : 400).json(result);
  } catch (err) {
    console.error('[API] 修改所属执行失败:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});


/**
 * GET /api/tasks/:id/execution-options - 换执行时可直接移动到的执行
 * 未同步的任务可改到任意执行（allowed 为 null）；已同步的只能在禅道允许的执行之间直接移动，其余需重建
 */
router.get('/tasks/:id/execution-options', async (req, res) => {
  try {
    const { getRecord } = await import('../services/attachmentStore.js');
    const record = await getRecord(req.params.id);
    if (!record || record.type === 'bug') return res.status(404).json({ success: false, message: '任务不存在' });
    if (!record.zentaoId) return res.json({ success: true, synced: false, allowed: null });
    const { getTaskExecutionOptions } = await import('../services/zentaoService.js');
    const allowed = await getTaskExecutionOptions(String(record.zentaoId));
    res.json({ success: true, synced: true, allowed });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

export default router;
