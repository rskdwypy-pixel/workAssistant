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
router.post('/task', async (req, res) => {
  try {
    const { content, zentaoId, executionId } = req.body;

    if (!content) {
      return res.status(400).json({ error: '请输入任务内容' });
    }

    // 如果没有提供 executionId，使用 AI 分析自动选择
    let finalExecutionId = executionId;
    if (!finalExecutionId || finalExecutionId === '') {
      console.log('[API] 未提供执行ID，使用 AI 分析自动选择');
      console.log('[API] 任务内容:', content);
      // 获取收藏的执行列表
      const { getFavoriteExecutions } = await import('../services/executionManager.js');
      const favoriteExecutions = await getFavoriteExecutions();
      console.log('[API] 收藏的执行列表:', favoriteExecutions.map(e => `ID:${e.id} 名称:${e.name} 项目:${e.projectName || '未分类'}`).join(', '));
      if (favoriteExecutions.length > 0) {
        // 有收藏的执行，使用 AI 匹配
        const { analyzeTaskForExecution } = await import('../ai/openai.js');
        const matchedExecutionId = await analyzeTaskForExecution(content, favoriteExecutions);
        if (matchedExecutionId) {
          finalExecutionId = matchedExecutionId;
          const matchedExec = favoriteExecutions.find(e => e.id === matchedExecutionId);
          console.log('[API] ✓ AI 匹配到执行:', finalExecutionId, matchedExec?.name);
        } else {
          console.log('[API] ✗ AI 匹配失败，未找到匹配的执行');
        }
      } else {
        console.log('[API] ! 没有收藏的执行，请先收藏需要使用的执行');
      }
      // 如果没有匹配到，使用默认执行
      if (!finalExecutionId) {
        const { getDefaultExecution } = await import('../services/executionManager.js');
        const defaultExec = await getDefaultExecution();
        if (defaultExec) {
          finalExecutionId = defaultExec.id;
          console.log('[API] 使用默认执行:', finalExecutionId, defaultExec.name);
        } else {
          // 最后的后备：使用配置中的 executionId
          const { config } = await import('../config.js');
          if (config.zentao.executionId) {
            finalExecutionId = String(config.zentao.executionId);
            console.log('[API] 使用配置中的执行ID:', finalExecutionId);
          }
        }
      }
    } else {
      console.log('[API] 用户手动选择执行ID:', finalExecutionId);
    }

    console.log('[API] 最终使用的执行ID:', finalExecutionId);

    const result = await taskManager.addOrUpdateTask(content, { zentaoId, executionId: finalExecutionId });
    res.json({
      success: true,
      data: result.task,
      isNew: result.isNew,
      message: result.isNew ? '任务已添加' : '检测到重复任务，已更新进度'
    });
  } catch (err) {
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
router.post('/config', async (req, res) => {
  try {
    const {
      apiKey,
      apiBaseUrl,
      aiModel,
      morningHour,
      eveningHour,
      webhookUrl,
      webhookType
    } = req.body;

    // 更新运行时配置
    const configModule = await import('../config.js');
    if (apiKey !== undefined) configModule.config.ai.apiKey = apiKey;
    if (apiBaseUrl !== undefined) configModule.config.ai.baseURL = apiBaseUrl;
    if (aiModel !== undefined) configModule.config.ai.model = aiModel;
    if (morningHour !== undefined) configModule.config.schedule.morningHour = parseInt(morningHour);
    if (eveningHour !== undefined) configModule.config.schedule.eveningHour = parseInt(eveningHour);
    if (webhookUrl !== undefined) configModule.config.webhook.url = webhookUrl;
    if (webhookType !== undefined) configModule.config.webhook.type = webhookType;

    // 持久化到 .env 文件
    const envUpdates = {};
    if (apiKey !== undefined) envUpdates.OPENAI_API_KEY = apiKey;
    if (apiBaseUrl !== undefined) envUpdates.OPENAI_BASE_URL = apiBaseUrl;
    if (aiModel !== undefined) envUpdates.OPENAI_MODEL = aiModel;
    if (morningHour !== undefined) envUpdates.MORNING_HOUR = morningHour;
    if (eveningHour !== undefined) envUpdates.EVENING_HOUR = eveningHour;
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
          aiModel: cfg.ai.model
        },
        schedule: {
          morningHour: cfg.schedule.morningHour,
          eveningHour: cfg.schedule.eveningHour
        },
        webhook: {
          hasUrl: !!cfg.webhook.url,
          type: cfg.webhook.type || 'generic',
          urlPrefix: cfg.webhook.url ? cfg.webhook.url.substring(0, 30) + '...' : '(空)'
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

/**
 * GET /api/sync/export - 导出完整数据用于同步
 */
router.get('/sync/export', async (req, res) => {
  try {
    // 获取所有任务
    const tasks = await taskManager.getAllTasks();

    // 获取历史报告
    const summaryService = await import('../services/summary.js');
    const history = await summaryService.getHistoryList(1000);

    // 生成校验和
    const crypto = await import('crypto');
    const dataStr = JSON.stringify({ tasks, history });
    const checksum = crypto.createHash('sha256').update(dataStr).digest('hex');

    res.json({
      success: true,
      data: {
        version: '1.0',
        timestamp: new Date().toISOString(),
        tasks,
        history,
        checksum
      }
    });
  } catch (err) {
    console.error('[API] 导出同步数据失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/sync/import - 导入同步数据（智能合并）
 */
router.post('/sync/import', async (req, res) => {
  try {
    const { tasks, history, deletedTaskIds } = req.body;

    if (!tasks || !Array.isArray(tasks)) {
      return res.status(400).json({ error: '无效的同步数据' });
    }

    // 验证校验和
    const crypto = await import('crypto');
    const dataStr = JSON.stringify({ tasks, history });
    const expectedChecksum = crypto.createHash('sha256').update(dataStr).digest('hex');

    if (req.body.checksum && req.body.checksum !== expectedChecksum) {
      return res.status(400).json({ error: '数据校验失败，可能已损坏' });
    }

    let importedCount = 0;
    let updatedCount = 0;
    let skippedCount = 0;
    const existingTasks = await taskManager.getAllTasks();
    const existingTaskMap = new Map(existingTasks.map(t => [t.id, t]));

    // 处理任务同步（最新修改优先）
    for (const remoteTask of tasks) {
      const localTask = existingTaskMap.get(remoteTask.id);

      if (!localTask) {
        // 新任务，直接添加
        await taskManager.addOrUpdateTask(remoteTask.content, remoteTask);
        importedCount++;
      } else {
        // 已存在，比较更新时间
        const localTime = new Date(localTask.updatedAt || localTask.createdAt);
        const remoteTime = new Date(remoteTask.updatedAt || remoteTask.createdAt);

        if (remoteTime > localTime) {
          // 远程更新，更新本地
          await taskManager.updateTask(remoteTask.id, remoteTask);
          updatedCount++;
        } else {
          skippedCount++;
        }
      }
    }

    // 发送删除动作
    if (deletedTaskIds && Array.isArray(deletedTaskIds)) {
      for (const taskId of deletedTaskIds) {
        if (existingTaskMap.has(taskId)) {
          await taskManager.deleteTask(taskId);
        }
      }
    }

    // 处理历史报告同步
    let historyImportedCount = 0;
    let historyUpdatedCount = 0;
    if (history && Array.isArray(history)) {
      const storageModule = await import('../utils/storage.js');
      const localHistoryData = await storageModule.readHistory();
      if (!localHistoryData.reports) localHistoryData.reports = localHistoryData.dailySummaries || [];

      const existingHistoryMap = new Map(localHistoryData.reports.map(r => [r.id, r]));

      for (const remoteReport of history) {
        const localReport = existingHistoryMap.get(remoteReport.id);

        if (!localReport) {
          // 新的历史报告
          localHistoryData.reports.push(remoteReport);
          existingHistoryMap.set(remoteReport.id, remoteReport);
          historyImportedCount++;
        } else {
          // 比较更新时间，通常报告生成后不会有大量修改，但仍需确保同步
          const localTime = new Date(localReport.createdAt).getTime();
          const remoteTime = new Date(remoteReport.createdAt).getTime();
          if (remoteTime > localTime) {
            Object.assign(localReport, remoteReport);
            historyUpdatedCount++;
          }
        }
      }

      // 按创建时间倒序排序
      localHistoryData.reports.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      localHistoryData.dailySummaries = localHistoryData.reports;
      await storageModule.writeHistory(localHistoryData);
    }

    console.log(`[API] 同步导入完成: 新增${importedCount}, 更新${updatedCount}, 跳过${skippedCount}`);

    res.json({
      success: true,
      data: {
        imported: importedCount,
        updated: updatedCount,
        skipped: skippedCount
      }
    });
  } catch (err) {
    console.error('[API] 导入同步数据失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sync/summary - 获取本地数据摘要（用于快速判断是否需要同步）
 */
router.get('/sync/summary', async (req, res) => {
  try {
    const tasks = await taskManager.getAllTasks();
    const summaryService = await import('../services/summary.js');
    const history = await summaryService.getHistoryList(1);

    // 找到最新更新时间
    let lastUpdate = null;
    for (const task of tasks) {
      const taskTime = new Date(task.updatedAt || task.createdAt);
      if (!lastUpdate || taskTime > lastUpdate) {
        lastUpdate = taskTime;
      }
    }

    // 生成校验和
    const crypto = await import('crypto');
    const dataStr = JSON.stringify({ tasks, history });
    const checksum = crypto.createHash('sha256').update(dataStr).digest('hex');

    res.json({
      success: true,
      data: {
        taskCount: tasks.length,
        historyCount: history.length,
        lastUpdate: lastUpdate ? lastUpdate.toISOString() : null,
        checksum
      }
    });
  } catch (err) {
    console.error('[API] 获取同步摘要失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== 工时相关接口 ====================

/**
 * POST /api/workHours - 保存今日工时
 */
router.post('/workHours', async (req, res) => {
  try {
    const { hours } = req.body;
    if (typeof hours !== 'number' || hours < 0) {
      return res.status(400).json({ error: '无效的工时数据' });
    }
    const { saveTodayWorkHours } = await import('../utils/storage.js');
    await saveTodayWorkHours(hours);
    console.log(`[API] 今日工时已保存: ${hours} 小时`);
    res.json({ success: true, data: { hours } });
  } catch (err) {
    console.error('[API] 保存工时失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/workHours - 获取今日工时
 */
router.get('/workHours', async (req, res) => {
  try {
    const { readTodayWorkHours } = await import('../utils/storage.js');
    const hours = await readTodayWorkHours();
    res.json({ success: true, data: { hours } });
  } catch (err) {
    console.error('[API] 获取工时失败:', err.message);
    res.status(500).json({ error: err.message });
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
        password: zentaoConfig.password || '', // 返回密码供浏览器端使用
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

    // 更新运行时配置
    const configModule = await import('../config.js');
    configModule.config.zentao.enabled = enabled === true || enabled === 'true';
    configModule.config.zentao.url = url || '';
    configModule.config.zentao.username = username || '';
    configModule.config.zentao.password = password || '';
    configModule.config.zentao.createTaskUrl = createTaskUrl || '';

    // 持久化到 .env 文件
    const envUpdates = {
      ZENTAO_ENABLED: enabled === true || enabled === 'true' ? 'true' : 'false',
      ZENTAO_URL: url || '',
      ZENTAO_USERNAME: username || '',
      ZENTAO_PASSWORD: password || '',
      ZENTAO_CREATE_TASK_URL: createTaskUrl || ''
    };
    configModule.updateEnvFile(envUpdates);

    console.log('[API] 禅道配置已保存');
    res.json({ success: true, message: '禅道配置已保存' });
  } catch (err) {
    console.error('[API] 保存禅道配置失败:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== 禅道代理接口（已废弃） ====================
// 注意：所有禅道操作已迁移到浏览器端，通过 ZentaoBrowserClient 完成
// 以下函数和接口已废弃，保留仅为向后兼容，不再使用后端 cookie

/**
 * @deprecated 已废弃，请使用浏览器端 ZentaoBrowserClient
 * 登录禅道获取 cookie（已废弃）
 */
async function loginZentao(baseUrl, username, password) {
  console.warn('[API] loginZentao 已废弃，请使用浏览器端 ZentaoBrowserClient');
  throw new Error('已废弃：请使用浏览器端 ZentaoBrowserClient');
}

/**
 * @deprecated 已废弃，请使用浏览器端 ZentaoBrowserClient
 * 获取有效的禅道 cookie（已废弃）
 */
async function getZentaoCookies() {
  console.warn('[API] getZentaoCookies 已废弃，请使用浏览器端 ZentaoBrowserClient');
  throw new Error('已废弃：请使用浏览器端 ZentaoBrowserClient');
}

/**
 * @deprecated 已废弃，请使用浏览器端 ZentaoBrowserClient
 * 将 cookie 对象转换为 Cookie header 字符串（已废弃）
 */
function cookiesToString(cookies) {
  console.warn('[API] cookiesToString 已废弃');
  return '';
}

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
 * POST /api/projects/sync - 从禅道同步项目列表
 */
router.post('/projects/sync', async (req, res) => {
  try {
    const { syncProjectsFromZentao } = await import('../services/projectManager.js');
    const { projects } = req.body; // 可选：从前端传来的项目数据
    const syncedProjects = await syncProjectsFromZentao(projects);
    res.json({ success: true, data: syncedProjects, message: '项目列表已同步' });
  } catch (err) {
    console.error('[API] 同步项目列表失败:', err);
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

    // 获取收藏的执行
    const { getFavoriteExecutions } = await import('../services/executionManager.js');
    const favoriteExecutions = await getFavoriteExecutions();

    if (favoriteExecutions.length === 0) {
      return res.json({ success: true, data: null, message: '没有收藏的执行' });
    }

    // 调用 AI 分析匹配执行
    const { analyzeTaskForExecution } = await import('../ai/openai.js');
    const matchedExecutionId = await analyzeTaskForExecution(content, favoriteExecutions);

    let matchResult = null;
    if (matchedExecutionId) {
      const matchedExec = favoriteExecutions.find(e => e.id === matchedExecutionId);
      console.log('[API] 匹配到的执行对象:', JSON.stringify(matchedExec));
      matchResult = {
        executionId: matchedExecutionId,
        executionName: matchedExec?.name || '',
        projectName: matchedExec?.projectName || '',
        projectId: matchedExec?.projectId || ''
      };
      console.log('[API] ✓ AI 匹配到执行:', JSON.stringify(matchResult));
    } else {
      console.log('[API] ✗ AI 匹配失败，未找到匹配的执行');
    }

    res.json({ success: true, data: matchResult });
  } catch (err) {
    console.error('[API] AI 匹配执行失败:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==================== Bug 相关接口 ====================

/**
 * GET /api/bugs - 获取 Bug 列表
 */
router.get('/bugs', async (req, res) => {
  try {
    const { getBugs } = await import('../services/bugManager.js');
    const filters = {
      status: req.query.status,
      executionId: req.query.executionId
    };
    const bugs = await getBugs(filters);
    res.json({ success: true, data: bugs });
  } catch (err) {
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

    console.log('[API] 创建 Bug 请求数据:', bugData);

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
    const { status } = req.body;

    const bug = await updateBugStatus(id, status);
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
 * POST /api/executions/sync - 从禅道同步执行列表
 */
router.post('/executions/sync', async (req, res) => {
  try {
    const { executions } = req.body; // 可选：从前端传来的执行数据
    const { syncExecutionsFromZentao } = await import('../services/executionManager.js');
    const syncedExecutions = await syncExecutionsFromZentao(executions);
    res.json({ success: true, data: syncedExecutions, message: '执行列表已同步' });
  } catch (err) {
    console.error('[API] 同步执行列表失败:', err);
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

/**
 * @deprecated POST /api/zentao/task/create - 代理创建禅道任务（已废弃）
 * 请使用浏览器端 ZentaoBrowserClient.createTask()
 */
router.post('/zentao/task/create', async (req, res) => {
  console.warn('[API] /api/zentao/task/create 已废弃，请使用浏览器端 ZentaoBrowserClient');
  res.status(410).json({
    success: false,
    error: '此接口已废弃，请使用浏览器端 ZentaoBrowserClient.createTask()',
    message: '所有禅道操作已迁移到浏览器端，通过注入脚本到禅道标签页完成'
  });
});

/**
 * @deprecated GET /api/zentao/kanban/params - 从看板页面解析参数（已废弃）
 * 请使用浏览器端 ZentaoBrowserClient.getKanbanParamsFromHtml()
 */
router.get('/zentao/kanban/params', async (req, res) => {
  console.warn('[API] /api/zentao/kanban/params 已废弃，请使用浏览器端 ZentaoBrowserClient');
  res.status(410).json({
    success: false,
    error: '此接口已废弃，请使用浏览器端 ZentaoBrowserClient.getKanbanParamsFromHtml()',
    message: '所有禅道操作已迁移到浏览器端，通过注入脚本到禅道标签页完成'
  });
});

export default router;


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
