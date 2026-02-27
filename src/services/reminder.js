import cron from 'node-cron';
import { config } from '../config.js';
import { getTodayTasks, getAllTasks, updateTask } from './taskManager.js';
import { sendMorningReminder, sendTaskReminder } from '../utils/webhook.js';

let reminderTask = null;
let customReminderInterval = null;

async function checkTaskReminders() {
  try {
    const tasks = await getAllTasks();
    const now = new Date();

    for (const task of tasks) {
      if (task.reminderTime && (!task.reminder3hTriggered || !task.reminderExactTriggered) && task.status !== 'done') {
        const reminderDate = new Date(task.reminderTime);
        const isDeadline = task.status === 'in_progress';
        const threeHoursBefore = new Date(reminderDate.getTime() - 3 * 60 * 60 * 1000);

        let updates = {};

        // 如果未触发 3 小时前提醒，并且已经达到或超过了 3 小时前的节点
        if (!task.reminder3hTriggered && now >= threeHoursBefore) {
          if (isDeadline) {
            console.log(`⏰ 任务即将截止提醒: ${task.title}`);
            await sendSystemNotification('⏰ 任务距离截止仅剩 3 小时', task.title);
            await sendTaskReminder(task, 'deadline_3h');
          } else {
            console.log(`⏰ 任务提醒 (提前3小时): ${task.title}`);
            await sendSystemNotification('⏰ 任务将在 3 小时后提醒', task.title);
            await sendTaskReminder(task, 'reminder_3h');
          }
          updates.reminder3hTriggered = true;
        }

        // 如果未触发准确时间提醒，并且已经达到或超过了准确时间
        if (!task.reminderExactTriggered && now >= reminderDate) {
          if (isDeadline) {
            console.log(`⏰ 任务已到达截止时间: ${task.title}`);
            await sendSystemNotification('⏰ 任务已到达截止时间', task.title);
            await sendTaskReminder(task, 'deadline_exact');
          } else {
            console.log(`⏰ 任务提醒触发: ${task.title}`);
            await sendSystemNotification('⏰ 任务提醒', task.title);
            await sendTaskReminder(task, 'reminder_exact');
          }
          updates.reminderExactTriggered = true;
        }

        if (Object.keys(updates).length > 0) {
          await updateTask(task.id, updates);
        }
      }
    }
  } catch (err) {
    console.error('检查任务提醒失败:', err.message);
  }
}

/**
 * 发送系统通知 (macOS)
 */
async function sendSystemNotification(title, message) {
  try {
    // 使用 macOS osascript 发送通知
    const { exec } = await import('child_process');
    const cmd = `osascript -e 'display notification "${message.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}" sound name "default"'`;

    exec(cmd, (error) => {
      if (error) {
        console.error('系统通知发送失败:', error.message);
      }
    });
  } catch (err) {
    console.error('系统通知错误:', err.message);
  }
}

/**
 * 早间提醒
 */
async function morningReminder() {
  try {
    console.log('🌅 执行早间提醒...');

    const tasks = await getTodayTasks();
    const todoTasks = tasks.filter(t => t.status === 'todo');
    const inProgressTasks = tasks.filter(t => t.status === 'in_progress');

    // 构建提醒消息
    const message = `今日待办: ${todoTasks.length} 项 | 进行中: ${inProgressTasks.length} 项`;

    // 发送系统通知
    await sendSystemNotification('☀️ 早安！工作助手', message);

    // 发送Webhook
    await sendMorningReminder(tasks);

    console.log('✅ 早间提醒完成');
  } catch (err) {
    console.error('❌ 早间提醒失败:', err.message);
  }
}

/**
 * 启动定时提醒
 */
function startReminder() {
  if (reminderTask) {
    console.log('⚠️  定时提醒已在运行');
    return;
  }

  const { morningHour } = config.schedule;
  const cronExpression = `0 ${morningHour} * * *`; // 每天9点

  reminderTask = cron.schedule(cronExpression, morningReminder, {
    scheduled: true,
    timezone: 'Asia/Shanghai'
  });

  if (!customReminderInterval) {
    customReminderInterval = setInterval(checkTaskReminders, 60 * 1000);
    checkTaskReminders();
  }

  console.log(`⏰ 定时提醒已启动: 每天 ${morningHour}:00`);
}

/**
 * 停止定时提醒
 */
function stopReminder() {
  if (reminderTask) {
    reminderTask.stop();
    reminderTask = null;
    console.log('⏰ 定时提醒已停止');
  }
  if (customReminderInterval) {
    clearInterval(customReminderInterval);
    customReminderInterval = null;
  }
}

/**
 * 手动触发提醒（用于测试）
 */
async function triggerMorningReminder() {
  await morningReminder();
}

export {
  startReminder,
  stopReminder,
  triggerMorningReminder,
  sendSystemNotification
};
