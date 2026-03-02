import cron from 'node-cron';
import { config } from '../config.js';
import { getTodayTasks } from './taskManager.js';
import { readHistory, writeHistory } from '../utils/storage.js';
import { generateSummary } from '../ai/openai.js';
import { sendEveningSummary } from '../utils/webhook.js';
import { sendSystemNotification } from './reminder.js';
import { v4 as uuidv4 } from 'uuid';
import { getAllTasks } from './taskManager.js';

let summaryTask = null;

/**
 * 晚间日报
 */
async function eveningSummary() {
  try {
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0=周日, 6=周六
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

    console.log('🌙 执行晚间日报...', `isWeekend=${isWeekend}`);

    // 如果是周末，检查今天是否有任务更新
    if (isWeekend) {
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const allTasks = await getAllTasks();

      // 检查今天是否有任务被创建或更新
      const hasTodayUpdates = allTasks.some(t => {
        const createdTime = new Date(t.createdAt).getTime();
        const updatedTime = new Date(t.updatedAt || t.createdAt).getTime();
        return createdTime >= todayStart || updatedTime >= todayStart;
      });

      if (!hasTodayUpdates) {
        console.log('📅 周末无任务更新，跳过日报生成');
        return;
      }

      console.log('💼 周末检测到任务更新（加班），生成日报');
    }

    const tasks = await getTodayTasks();
    const todoTasks = tasks.filter(t => t.status === 'todo');
    const inProgressTasks = tasks.filter(t => t.status === 'in_progress');
    const doneTasks = tasks.filter(t => t.status === 'done');

    // AI生成日报
    const { data: summary } = await generateSummary(todoTasks, inProgressTasks, doneTasks, 'daily');

    // 保存历史
    const history = await readHistory();
    if (!history.reports) history.reports = history.dailySummaries || []; // Migrate
    const today = new Date().toISOString().split('T')[0];

    // 检查是否已存在今日日报
    const existingIndex = history.reports.findIndex(s => s.date === today && s.type === 'daily');

    const dailyReport = {
      id: existingIndex >= 0 ? history.reports[existingIndex].id : uuidv4(),
      type: 'daily',
      date: today,
      summary: summary.summary || '',
      completed: summary.completed || [],
      tomorrowFocus: summary.tomorrowFocus || [],
      risks: summary.risks || [],
      stats: {
        total: tasks.length,
        todo: todoTasks.length,
        inProgress: inProgressTasks.length,
        done: doneTasks.length
      },
      createdAt: new Date().toISOString()
    };

    if (existingIndex >= 0) {
      history.reports[existingIndex] = dailyReport;
    } else {
      history.reports.unshift(dailyReport);
    }

    // 只保留最近90天的记录
    if (history.reports.length > 300) {
      history.reports = history.reports.slice(0, 300);
    }

    history.dailySummaries = history.reports; // back compatibility

    await writeHistory(history);

    // 发送系统通知
    const message = `今日完成 ${doneTasks.length} 项任务${summary.tomorrowFocus?.length > 0 ? `，明日重点: ${summary.tomorrowFocus.length} 项` : ''}`;
    await sendSystemNotification('🌙 晚安！工作日报', message);

    // 发送Webhook
    await sendEveningSummary(summary);

    console.log('✅ 晚间日报完成');
  } catch (err) {
    console.error('❌ 晚间日报失败:', err.message);
  }
}

/**
 * 启动定时日报
 */
function startSummary() {
  if (summaryTask) {
    console.log('⚠️  定时日报已在运行');
    return;
  }

  const { eveningHour } = config.schedule;
  const cronExpression = `0 ${eveningHour} * * *`; // 每天21点

  summaryTask = cron.schedule(cronExpression, eveningSummary, {
    scheduled: true,
    timezone: 'Asia/Shanghai'
  });

  console.log(`⏰ 定时日报已启动: 每天 ${eveningHour}:00`);
}

/**
 * 停止定时日报
 */
function stopSummary() {
  if (summaryTask) {
    summaryTask.stop();
    summaryTask = null;
    console.log('⏰ 定时日报已停止');
  }
}

/**
 * 手动触发日报（用于测试）
 */
async function triggerEveningSummary() {
  await eveningSummary();
}

/**
 * 获取历史日报列表
 */
async function getHistoryList(limit = 30) {
  const history = await readHistory();
  return (history.reports || history.dailySummaries || []).slice(0, limit);
}

/**
 * 获取指定日期的日报
 */
async function getHistoryByDate(dateStr) {
  const history = await readHistory();
  return (history.reports || history.dailySummaries || []).find(s => s.date === dateStr && (!s.type || s.type === 'daily')) || null;
}

/**
 * 手动生成特定类型汇报
 * @param {string} type - daily, weekly, monthly
 * @param {boolean} autoPush - 是否自动推送，默认 false
 * @param {string} date - 指定日期（格式：YYYY-MM-DD），仅用于日报
 * @param {number} workHours - 今日工时，仅用于日报
 */
async function generateReport(type, autoPush = false, date = null, workHours = null) { // type = daily, weekly, monthly
  let startMs = 0;
  let summaryDateLabel = new Date().toISOString().split('T')[0];

  const now = new Date();
  if (type === 'daily') {
    // 使用传入的日期，如果没有则使用今天
    const targetDate = date || summaryDateLabel;
    summaryDateLabel = targetDate;
    startMs = new Date(targetDate).getTime();
  } else if (type === 'weekly') {
    const day = now.getDay() || 7;
    startMs = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day + 1).getTime();
    summaryDateLabel = new Date(startMs).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) + ' - ' + now.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) + '周报';
  } else if (type === 'monthly') {
    startMs = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    summaryDateLabel = now.getFullYear() + '年' + (now.getMonth() + 1) + '月总结';
  }

  const allTasks = await getAllTasks();

  // 过滤时间段内的任务
  let tasks;
  if (type === 'daily') {
    // 日报：使用前端相同的日期过滤逻辑（getTasksByDate）
    const targetDate = summaryDateLabel;
    console.log(`[generateReport] 日报日期: ${targetDate}, 总任务数: ${allTasks.length}`);

    tasks = allTasks.filter(task => {
      const taskCreatedAtDateStr = new Date(task.createdAt).toISOString().split('T')[0];
      const taskUpdatedAtDateStr = new Date(task.updatedAt || task.createdAt).toISOString().split('T')[0];

      // 1. 在当前选中日期创建的所有任务，都显示
      if (taskCreatedAtDateStr === targetDate) {
        console.log(`[generateReport] 包含任务（今日创建）: ${task.title} [${task.status}]`);
        return true;
      }

      // 2. 如果任务是未完成状态（todo或in_progress），并且创建于选中日期之前或等于，则一直顺延携带显示
      if (task.status !== 'done' && taskCreatedAtDateStr <= targetDate) {
        console.log(`[generateReport] 包含任务（未完成顺延）: ${task.title} [${task.status}] 创建于: ${taskCreatedAtDateStr}`);
        return true;
      }

      // 3. 如果任务是已完成状态，但它的完成(更新)时间是在选中日期，也显示在这天
      if (task.status === 'done' && taskUpdatedAtDateStr === targetDate) {
        console.log(`[generateReport] 包含任务（今日完成）: ${task.title} [done]`);
        return true;
      }

      console.log(`[generateReport] 排除任务: ${task.title} [${task.status}] 创建于: ${taskCreatedAtDateStr}`);
      return false;
    });

    console.log(`[generateReport] 过滤后任务数: ${tasks.length}`);
  } else {
    // 周报/月报：包含时间段内的任务 + 所有未完成任务
    tasks = allTasks.filter(t => {
      const createdTime = new Date(t.createdAt).getTime();
      const updatedTime = new Date(t.updatedAt || t.createdAt).getTime();
      const inPeriod = createdTime >= startMs || updatedTime >= startMs;
      return inPeriod || t.status !== 'done';
    });
  }

  const todoTasks = tasks.filter(t => t.status === 'todo');
  const inProgressTasks = tasks.filter(t => t.status === 'in_progress');
  const doneTasks = tasks.filter(t => t.status === 'done');

  // 构建工时信息（仅日报）
  const workTimeInfo = (type === 'daily' && workHours !== null && workHours > 0) ? { hours: workHours } : null;

  const { data: summary } = await generateSummary(todoTasks, inProgressTasks, doneTasks, type, workTimeInfo);

  const history = await readHistory();
  if (!history.reports) history.reports = history.dailySummaries || [];

  const existingIndex = history.reports.findIndex(s => s.type === type && (type === 'daily' ? s.date === summaryDateLabel : s.dateLabel === summaryDateLabel));

  const reportData = {
    id: existingIndex >= 0 ? history.reports[existingIndex].id : uuidv4(),
    type: type,
    date: type === 'daily' ? summaryDateLabel : summaryDateLabel,
    dateLabel: summaryDateLabel,
    summary: summary.summary || '',
    completed: summary.completed || [],
    tomorrowFocus: summary.tomorrowFocus || [],
    risks: summary.risks || [],
    stats: {
      total: tasks.length,
      todo: todoTasks.length,
      inProgress: inProgressTasks.length,
      done: doneTasks.length
    },
    createdAt: new Date().toISOString()
  };

  if (existingIndex >= 0) {
    history.reports[existingIndex] = reportData;
  } else {
    history.reports.unshift(reportData);
  }

  history.dailySummaries = history.reports;
  await writeHistory(history);

  // 自动推送
  console.log(`[generateReport] autoPush=${autoPush}, type=${type}`);
  if (autoPush) {
    try {
      console.log(`[generateReport] 开始推送报告 ${reportData.id}`);
      await pushReport(reportData);
      console.log(`✅ ${type}报告已自动推送`);
    } catch (pushErr) {
      console.error(`❌ ${type}报告推送失败:`, pushErr.message);
      console.error(pushErr.stack);
      // 推送失败不影响报告生成
    }
  }

  return reportData;
}

/**
 * 推送报告
 */
async function pushReport(report) {
  const typeLabels = {
    daily: '🌙 每日工作总结',
    weekly: '📊 每周工作总结',
    monthly: '📈 每月工作总结'
  };
  const title = typeLabels[report.type] || '📊 工作总结';

  console.log(`[推送${report.type}报告] 开始推送:`, title);
  console.log(`[推送${report.type}报告] 报告数据:`, {
    id: report.id,
    type: report.type,
    completed: report.completed?.length || 0,
    tomorrowFocus: report.tomorrowFocus?.length || 0
  });

  // 构建推送内容
  const items = [
    `✅ 已完成: ${report.completed?.length || 0} 项`,
    ...((report.completed || []).map(i => `  - ${i}`)),
    ``,
    `🎯 待办/进行中: ${report.tomorrowFocus?.length || 0} 项`,
    ...((report.tomorrowFocus || []).map(i => `  - ${i}`))
  ].filter(Boolean);

  if (report.risks && report.risks.length > 0) {
    items.push('', '⚠️  风险提醒:', ...report.risks.map(r => `  - ${r}`));
  }

  console.log(`[推送${report.type}报告] 推送内容:`, items.length, '项');

  // 发送通知
  try {
    console.log(`[推送${report.type}报告] 正在导入 sendNotification...`);
    const { sendNotification } = await import('../utils/webhook.js');
    console.log(`[推送${report.type}报告] sendNotification 函数已导入`);
    await sendNotification(title, report.summary || '', items);
    console.log(`[推送${report.type}报告] 推送成功`);
  } catch (err) {
    console.error(`[推送${report.type}报告] 推送失败:`, err.message);
    console.error(`[推送${report.type}报告] 错误堆栈:`, err.stack);
    throw err;
  }
}

/**
 * 删除报告
 */
async function deleteReport(id) {
  const history = await readHistory();
  if (!history.reports) history.reports = history.dailySummaries || [];

  history.reports = history.reports.filter(r => r.id !== id);
  history.dailySummaries = history.reports;

  await writeHistory(history);
  return true;
}

export {
  startSummary,
  stopSummary,
  triggerEveningSummary,
  getHistoryList,
  getHistoryByDate,
  generateReport,
  deleteReport,
  pushReport
};
