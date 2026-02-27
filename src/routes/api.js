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
    const { content } = req.body;

    if (!content) {
      return res.status(400).json({ error: '请输入任务内容' });
    }

    const result = await taskManager.addOrUpdateTask(content);
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
    const { progress } = req.body;

    if (progress < 0 || progress > 100) {
      return res.status(400).json({ error: '进度必须在0-100之间' });
    }

    const task = await taskManager.updateTask(id, { progress });

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
 */
router.post('/report/generate/:type', async (req, res) => {
  try {
    const { type } = req.params;
    if (!['daily', 'weekly', 'monthly'].includes(type)) {
      return res.status(400).json({ error: '不支持的合并类型' });
    }
    const autoPush = req.query.autoPush === 'true';
    console.log(`[API] 收到请求: 生成${type}报告, autoPush=${autoPush}`);
    console.log(`[API] 完整URL: ${req.originalUrl}`);
    const report = await summaryService.generateReport(type, autoPush);
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

export default router;
