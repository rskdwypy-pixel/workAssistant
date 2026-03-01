import { config } from '../config.js';

/**
 * 发送飞书消息
 */
async function sendFeishu(webhookUrl, content) {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      msg_type: 'text',
      content: { text: content }
    })
  });
  return response.ok;
}

/**
 * 发送飞书卡片消息（富文本）
 */
async function sendFeishuCard(webhookUrl, title, items) {
  const card = {
    msg_type: 'interactive',
    card: {
      header: {
        title: {
          tag: 'plain_text',
          content: title
        }
      },
      elements: items.map(item => ({
        tag: 'div',
        text: {
          tag: 'plain_text',
          content: item
        }
      }))
    }
  };

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(card)
  });
  return response.ok;
}

/**
 * 发送钉钉消息
 */
async function sendDingtalk(webhookUrl, content) {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      msgtype: 'text',
      text: { content: content }
    })
  });
  return response.ok;
}

/**
 * 发送钉钉Markdown消息
 */
async function sendDingtalkMarkdown(webhookUrl, title, items) {
  const text = `### ${title}\n\n${items.map(i => `${i}`).join('\n')}`;

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      msgtype: 'markdown',
      markdown: { text, title }
    })
  });
  return response.ok;
}

/**
 * 发送企业微信消息
 */
async function sendWecom(webhookUrl, content) {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      msgtype: 'text',
      text: { content: content }
    })
  });
  return response.ok;
}

/**
 * 发送企业微信Markdown消息
 */
async function sendWecomMarkdown(webhookUrl, content) {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      msgtype: 'markdown',
      markdown: { content }
    })
  });
  return response.ok;
}

/**
 * 发送通用Webhook
 */
async function sendGeneric(webhookUrl, data) {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return response.ok;
}

/**
 * 发送Webhook通知
 */
async function sendNotification(title, content, items = [], overrideConfig = null) {
  const webhook = overrideConfig || config.webhook;

  // 未配置webhook则跳过
  if (!webhook.url) {
    console.warn('[Webhook] 未配置webhook URL，跳过推送');
    return { success: true, message: 'Webhook未配置' };
  }

  console.log(`[Webhook] webhook配置:`, { type: webhook.type, hasUrl: !!webhook.url, urlPrefix: webhook.url?.substring(0, 20) + '...' });
  console.log(`[Webhook] 准备推送: ${title}, 类型: ${webhook.type}, URL: ${webhook.url?.substring(0, 30)}...`);

  try {
    let success = false;
    const fullContent = `${title}\n\n${content}${items.length > 0 ? '\n\n' + items.join('\n') : ''}`;

    console.log(`[Webhook] 推送内容项数:`, items.length);

    switch (webhook.type) {
      case 'feishu':
        if (items.length > 0) {
          console.log('[Webhook] 使用飞书卡片格式');
          success = await sendFeishuCard(webhook.url, title, [content, ...items]);
        } else {
          console.log('[Webhook] 使用飞书文本格式');
          success = await sendFeishu(webhook.url, fullContent);
        }
        break;

      case 'dingtalk':
        if (items.length > 0) {
          console.log('[Webhook] 使用钉钉Markdown格式');
          success = await sendDingtalkMarkdown(webhook.url, title, [content, ...items]);
        } else {
          console.log('[Webhook] 使用钉钉文本格式');
          success = await sendDingtalk(webhook.url, fullContent);
        }
        break;

      case 'wecom':
        if (items.length > 0) {
          console.log('[Webhook] 使用企业微信Markdown格式');
          const mdContent = `### ${title}\n\n${content}\n\n${items.map(i => `${i}`).join('\n')}`;
          success = await sendWecomMarkdown(webhook.url, mdContent);
        } else {
          console.log('[Webhook] 使用企业微信文本格式');
          success = await sendWecom(webhook.url, fullContent);
        }
        break;

      case 'generic':
      default:
        console.log('[Webhook] 使用通用格式');
        success = await sendGeneric(webhook.url, { title, content, items, timestamp: new Date().toISOString() });
        break;
    }

    if (success) {
      console.log(`[Webhook] 推送成功: ${title}`);
      return { success: true, message: 'Webhook发送成功' };
    } else {
      console.error(`[Webhook] 推送失败: ${title}, success=false`);
      throw new Error('Webhook发送失败');
    }
  } catch (err) {
    console.error('[Webhook] 发送错误:', err.message);
    console.error('[Webhook] 错误堆栈:', err.stack);
    throw err;
  }
}

/**
 * 发送早间提醒
 */
async function sendMorningReminder(tasks) {
  const todoCount = tasks.filter(t => t.status === 'todo').length;
  const inProgressCount = tasks.filter(t => t.status === 'in_progress').length;

  const title = '🌅 早安！今日待办提醒';
  const content = `待办任务: ${todoCount} 项 | 进行中: ${inProgressCount} 项`;

  const items = tasks
    .filter(t => t.status === 'todo' || t.status === 'in_progress')
    .slice(0, 10)
    .map(t => `${t.status === 'in_progress' ? '🔵' : '⚪'} ${t.title}`);

  return await sendNotification(title, content, items);
}

/**
 * 发送晚间日报
 */
async function sendEveningSummary(summary) {
  const title = '🌙 晚安！今日工作总结';

  const items = [
    '',
    `✅ 今日完成: ${summary.completed?.length || 0} 项`,
    ...((summary.completed || []).map(i => `${i}`)),
    '',
    `📋 明日重点:`,
    ...((summary.tomorrowFocus || []).map(i => `${i}`))
  ];

  if (summary.risks && summary.risks.length > 0) {
    items.push('', '⚠️  风险提醒:', ...summary.risks);
  }

  return await sendNotification(title, summary.summary || '', items);
}

/**
 * 发送任务提醒
 */
async function sendTaskReminder(task, triggerType) {
  let title = '';
  let content = '';

  switch (triggerType) {
    case 'deadline_3h':
      title = '⏰ 任务即将截止提醒';
      content = `你的任务将在约 3 小时后截止：\n\n${task.title}\n${task.content !== task.title ? '\n' + task.content : ''}`;
      break;
    case 'deadline_exact':
      title = '⏰ 任务已到达截止时间';
      content = `你的任务已到达截止时间：\n\n${task.title}\n${task.content !== task.title ? '\n' + task.content : ''}`;
      break;
    case 'reminder_3h':
      title = '⏰ 任务提醒 (提前3小时)';
      content = `你的任务将在约 3 小时后提醒：\n\n${task.title}\n${task.content !== task.title ? '\n' + task.content : ''}`;
      break;
    case 'reminder_exact':
      title = '⏰ 任务提醒';
      content = `你的任务提醒已到：\n\n${task.title}\n${task.content !== task.title ? '\n' + task.content : ''}`;
      break;
  }

  return await sendNotification(title, content, []);
}

/**
 * 测试 Webhook
 */
async function testWebhook(webhookUrl, webhookType) {
  const title = '🔔 测试推送';
  const content = '这是一条来自工作助手的测试通知。如果您收到此消息，说明 Webhook 配置成功！';
  return await sendNotification(title, content, [], { url: webhookUrl, type: webhookType });
}

export {
  sendNotification,
  sendMorningReminder,
  sendEveningSummary,
  sendTaskReminder,
  testWebhook
};
