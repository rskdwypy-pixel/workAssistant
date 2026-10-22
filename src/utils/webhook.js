import { config } from '../config.js';

/**
 * 发一条机器人消息，并按平台的返回体判断是否真的成功
 *
 * 企业微信 / 钉钉 / 飞书出错时 HTTP 状态码照样是 200，错误写在返回体里
 * （企业微信、钉钉 errcode≠0，飞书 code / StatusCode≠0）。以前只看 HTTP 状态：
 * 地址是企业微信、类型却选成「通用」时，企业微信拒收格式不对的消息，日志和界面都显示「推送成功」，实际什么都没收到。
 * @returns {Promise<true>} 失败时抛出带平台原因的错误
 */
async function postMessage(webhookUrl, body) {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}${text ? `：${text.slice(0, 200)}` : ''}`);
  let data = null;
  try { data = JSON.parse(text); } catch { /* 通用 Webhook 可能不返回 JSON */ }
  if (data && typeof data === 'object') {
    const code = data.errcode ?? data.code ?? data.StatusCode;
    if (code !== undefined && code !== null && Number(code) !== 0) {
      throw new Error(`${data.errmsg || data.msg || data.StatusMessage || '平台拒收'}（错误码 ${code}）`);
    }
  }
  return true;
}

/** 按地址认出平台（地址是谁家的就用谁家的格式，避免类型选错导致平台拒收） */
function detectWebhookType(url) {
  let host = '';
  try { host = new URL(url).host.toLowerCase(); } catch { return ''; }
  if (host === 'qyapi.weixin.qq.com') return 'wecom';
  if (host === 'oapi.dingtalk.com') return 'dingtalk';
  if (host.endsWith('feishu.cn') || host.endsWith('larksuite.com')) return 'feishu';
  return '';
}

/** 按 UTF-8 字节数截断（企业微信 markdown 正文上限 4096 字节） */
function clipBytes(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  const suffix = '\n…（内容过长，已截断）';
  let out = buf.subarray(0, maxBytes - Buffer.byteLength(suffix)).toString('utf8');
  out = out.replace(/\uFFFD$/, '');
  return out + suffix;
}

/** 飞书文本消息 */
function sendFeishu(webhookUrl, content) {
  return postMessage(webhookUrl, { msg_type: 'text', content: { text: content } });
}

/** 飞书卡片消息（富文本） */
function sendFeishuCard(webhookUrl, title, items) {
  return postMessage(webhookUrl, {
    msg_type: 'interactive',
    card: {
      header: { title: { tag: 'plain_text', content: title } },
      elements: items.map(item => ({ tag: 'div', text: { tag: 'plain_text', content: item } }))
    }
  });
}

/** 钉钉文本消息 */
function sendDingtalk(webhookUrl, content) {
  return postMessage(webhookUrl, { msgtype: 'text', text: { content } });
}

/** 钉钉 Markdown 消息 */
function sendDingtalkMarkdown(webhookUrl, title, items) {
  const text = `### ${title}\n\n${items.map(i => `${i}`).join('\n')}`;
  return postMessage(webhookUrl, { msgtype: 'markdown', markdown: { text, title } });
}

/** 企业微信文本消息（上限 2048 字节） */
function sendWecom(webhookUrl, content) {
  return postMessage(webhookUrl, { msgtype: 'text', text: { content: clipBytes(content, 2048) } });
}

/** 企业微信 Markdown 消息（上限 4096 字节） */
function sendWecomMarkdown(webhookUrl, content) {
  return postMessage(webhookUrl, { msgtype: 'markdown', markdown: { content: clipBytes(content, 4096) } });
}

/** 通用 Webhook */
function sendGeneric(webhookUrl, data) {
  return postMessage(webhookUrl, data);
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

  // 地址能认出平台时以地址为准（设置里类型选错时照样能推）
  const type = detectWebhookType(webhook.url) || webhook.type;
  if (type !== webhook.type) console.log(`[Webhook] 地址是 ${type}，设置里的类型是 ${webhook.type}，按 ${type} 格式发送`);
  console.log(`[Webhook] 准备推送: ${title}, 类型: ${type}, URL: ${webhook.url?.substring(0, 30)}...`);

  try {
    let success = false;
    const fullContent = `${title}\n\n${content}${items.length > 0 ? '\n\n' + items.join('\n') : ''}`;

    console.log(`[Webhook] 推送内容项数:`, items.length);

    switch (type) {
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

    if (!success) throw new Error('Webhook发送失败');
    console.log(`[Webhook] 推送成功: ${title}`);
    return { success: true, message: 'Webhook发送成功' };
  } catch (err) {
    console.error(`[Webhook] 推送失败: ${title}：${err.message}`);
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

  // 先显示待办，再显示进行中，显示所有任务
  const todoTasks = tasks.filter(t => t.status === 'todo');
  const inProgressTasks = tasks.filter(t => t.status === 'in_progress');

  const items = [
    ...todoTasks.map(t => `⚪ ${t.title}`),
    ...inProgressTasks.map(t => {
      const progress = t.progress > 0 ? ` (${t.progress}%)` : '';
      return `🔵 ${t.title}${progress}`;
    })
  ];

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
  detectWebhookType,
  sendMorningReminder,
  sendEveningSummary,
  sendTaskReminder,
  testWebhook
};
