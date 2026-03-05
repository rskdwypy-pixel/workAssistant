import OpenAI from 'openai';
import { config } from '../config.js';

// 创建 OpenAI 客户端
const client = new OpenAI({
  apiKey: config.ai.apiKey,
  baseURL: config.ai.baseURL
});

/**
 * 任务分析提示词
 */
const TASK_ANALYSIS_PROMPT = `你是智能任务管理助手。当前时间是：{currentDate}。请分析用户的工作内容，提取结构化信息并返回JSON格式。

分析规则：
1. title: 提取完整的项目名和具体修饰事项作为标题，不要随意删减长关键词或项目名，长度控制在5-30字以内。
2. status: 根据内容判断状态
   - 包含"完成、搞定、done、100%"等 → done
   - 包含"正在、进行、doing"等，或进度介于1-99之间 → in_progress
   - 其他 → todo
3. reminderTime: 提取文本中的提醒时间或截止时间（需精确到YYYY-MM-DDTHH:mm:ss格式的标准ISO时间戳，如自动推算的"明天下午3点"等。若文本中未提及明确或隐晦的时间点，则返回null）
4. progress: 任务进度（0-100的整数）
   - 识别格式如 "50%", "50 percent", "一半", "1/2", "进行中(50%)" 等
   - 如果是进行中状态但未明确进度，默认为 10
   - 如果进度介于1-99之间，status必须是 in_progress
   - 待办状态为 0，完成状态为 100
5. priority: 任务优先级（1-4的整数）
   - 优先级1（最高）：包含"紧急、重要、P1、!!!、马上、立即"等关键词
   - 优先级2（高）：包含"尽快、抓紧、优先、重要、P2、!!"等关键词
   - 优先级4（最低）：包含"不急、空闲、暂缓、P4、可以晚点"等关键词
   - 优先级3（默认）：其他情况或未明确提及

用户输入：{userInput}

请只返回JSON，不要其他内容：
{
  "title": "完整任务标题",
  "status": "todo|in_progress|done",
  "reminderTime": "YYYY-MM-DDTHH:mm:ss或null",
  "progress": 0,
  "priority": 3
}`;


/**
 * 工作总结生成提示词
 */
const SUMMARY_PROMPT = `你是专业的工作汇报助手。请根据以下任务数据，生成一份{timeFrame}工作汇报。

【待办任务】
{todoTasks}

【进行中任务】
{inProgressTasks}

【已完成任务】
{doneTasks}

【重要】tomorrowFocus 数组必须包含【待办任务】和【进行中任务】中的每一项，数量必须与输入一致，不得遗漏任何任务！

【报告格式要求】
1. summary（总览）：
   日报格式：第一句"今日已工作时长X小时"，第二句"{timeFrame}共处理任务{总数}项，其中完成工作{完成数}项"，第三句"{timeFrame}主要工作内容{主要内容}"
   周报/月报格式：第一句"{timeFrame}共处理任务{总数}项，其中完成工作{完成数}项"，第二句"{timeFrame}主要工作内容{主要内容}"（不显示工时）

   主要工作内容的确定规则：
   - 优先级1：如果有已完成任务，选择最重要的已完成任务
2. completed（已完成事项）：
   - 列出所有已完成任务
   - 格式：智能融合标题和描述，例如："民生卡竞品分析（完成）" 或 "处理阿迪达斯登录问题"
   - 每项一行
   - 【重要】只将【已完成任务】中的任务放入completed数组，不要将【进行中任务】放入completed，不要根据任务描述中的"已完成"等文字判断状态
   - 每项一行

3. tomorrowFocus（重点待办/进行中）：
   - 数量必须等于：待办任务数 + 进行中任务数
   - 必须去掉"标题:"、"描述:"、"已完成] 标题:"、"提醒:"等标签字样
   - 智能融合：如果原始描述与标题基本相同，只保留标题；如果原始描述有额外信息，则融合
   - 待办任务格式："[待办] 精简后的任务名称"
   - 进行中任务格式："[进行中] 精简后的任务名称（进度%）" - 必须保留进度
   - 先列出所有待办任务，再列出所有进行中任务
   - 逐项处理，确保每个任务都被转换后放入数组

4. risks（风险建议）：
   - 如待办+进行中超过5项提示"待办任务较多，建议合理规划"
   - 如有已过期任务提示"存在已过期任务，请及时处理"
   - 否则返回空数组

【JSON返回格式示例】

日报：
{
  "summary": "今日已工作时长2.0小时。今日共处理任务4项，其中完成工作0项。今日主要工作内容xxx。",
  "completed": [],
  "tomorrowFocus": ["[待办] 任务1", "[进行中] 任务2（40%）"],
  "risks": []
}

周报/月报（不显示工时）：
{
  "summary": "本周共处理任务10项，其中完成工作5项。本周主要工作内容xxx。",
  "completed": ["任务A", "任务B"],
  "tomorrowFocus": ["[待办] 任务3", "[进行中] 任务4（30%）"],
  "risks": []
}`;

/**
 * 分析任务（AI自动解析用户输入）
 */
async function analyzeTask(userInput) {
  try {
    const promptTemplate = config.prompts.addTask || TASK_ANALYSIS_PROMPT;

    // 获取当前日期信息
    const now = new Date();
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const currentWeekday = weekdays[now.getDay()];
    const dateStr = now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
    const fullDateStr = `${dateStr} (${currentWeekday}) ${now.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })}`;

    const prompt = promptTemplate
      .replace('{userInput}', userInput)
      .replace('{currentDate}', fullDateStr);

    const response = await client.chat.completions.create({
      model: config.ai.model,
      messages: [
        { role: 'system', content: '你是专业的任务管理助手，擅长从自然语言中提取结构化信息。计算日期时请准确：今天是' + fullDateStr + '，请基于此计算"明天"、"后天"、"周五"、"下周"等相对时间。' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 500
    });

    let content = response.choices[0].message.content.trim();

    // 清理可能的 markdown 代码块标记
    if (content.startsWith('```')) {
      content = content.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    const result = JSON.parse(content);

    return {
      success: true,
      data: result
    };
  } catch (err) {
    console.error('AI分析失败:', err.message);

    // 失败时返回基础解析
    return {
      success: false,
      data: {
        title: userInput.slice(0, 20),
        status: 'todo',
        priority: 3,
        reminderTime: null,
        progress: 0
      }
    };
  }
}

/**
 * 格式化任务信息（包含时间和进度）
 */
function formatTaskInfo(task, status) {
  let info = `[${status === 'todo' ? '待办' : '进行中'}] 标题: ${task.title}`;

  // 进行中任务添加进度
  if (status === 'in_progress' && task.progress > 0) {
    info += ` (${task.progress}%)`;
  }

  if (task.content && task.content !== task.title) {
    info += ` (描述: ${task.content})`;
  }

  if (task.reminderTime) {
    const date = new Date(task.reminderTime);
    const dateStr = date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
    info += ` (提醒: ${dateStr})`;
  }

  return info;
}

/**
 * 生成工作汇报
 * @param {Array} todoTasks - 待办任务
 * @param {Array} inProgressTasks - 进行中任务
 * @param {Array} doneTasks - 已完成任务
 * @param {string} type - daily, weekly, monthly
 * @param {Object} workTimeInfo - 工时信息 { hours: number }
 */
async function generateSummary(todoTasks, inProgressTasks, doneTasks, type = 'daily', workTimeInfo = null) {
  const timeFrameMap = {
    daily: '今日',
    weekly: '本周',
    monthly: '本月'
  };
  const timeFrame = timeFrameMap[type] || '今日';

  try {
    // 格式化任务信息，包含状态、时间和进度
    const formattedTodoTasks = todoTasks.map(t => formatTaskInfo(t, 'todo'));
    const formattedInProgressTasks = inProgressTasks.map(t => formatTaskInfo(t, 'in_progress'));
    const formattedDoneTasks = doneTasks.map(t => {
      let info = `[已完成] 标题: ${t.title}`;
      if (t.content && t.content !== t.title) {
        info += ` (描述: ${t.content})`;
      }
      return info;
    });

    // 添加调试日志
    console.log(`[generateSummary] ${timeFrame}任务数据:`, {
      todoTasks: formattedTodoTasks,
      inProgressTasks: formattedInProgressTasks,
      doneTasks: formattedDoneTasks,
      workTimeInfo
    });

    const promptTemplate = config.prompts[type] || SUMMARY_PROMPT;

    // 构建工时信息（仅日报显示工时）
    let workTimeString = '';
    if (type === 'daily' && workTimeInfo && workTimeInfo.hours > 0) {
      workTimeString = `今日已工作时长${workTimeInfo.hours.toFixed(1)}小时。`;
    }

    const prompt = promptTemplate
      .replace(/{timeFrame}/g, timeFrame)
      .replace('{todoTasks}', JSON.stringify(formattedTodoTasks))
      .replace('{inProgressTasks}', JSON.stringify(formattedInProgressTasks))
      .replace('{doneTasks}', JSON.stringify(formattedDoneTasks))
      .replace(/今日已工作时长{x}小时（如有）/g, workTimeString || '')
      .replace(/今日已工作时长{x}小时/g, workTimeString || '')
      // 替换提示词中的"今日"为对应时间框架
      .replace(/今日主要工作内容/g, `${timeFrame}主要工作内容`)
      .replace(/共处理任务/g, `${timeFrame}共处理任务`);

    const response = await client.chat.completions.create({
      model: config.ai.model,
      messages: [
        { role: 'system', content: `你是专业的工作助手，擅长总结${timeFrame}工作内容。【重要】tomorrowFocus 数组必须包含所有待办和进行中任务，数量必须与输入一致，不得遗漏！` },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 2000
    });

    let content = response.choices[0].message.content.trim();

    // 清理可能的 markdown 代码块标记
    if (content.startsWith('```')) {
      content = content.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    const result = JSON.parse(content);

    // 添加调试日志：AI 返回的结果
    console.log(`[generateSummary] AI返回结果:`, {
      completed: result.completed,
      tomorrowFocus: result.tomorrowFocus,
      risks: result.risks
    });

    return {
      success: true,
      data: result
    };
  } catch (err) {
    console.error(`${timeFrame}汇报生成失败:`, err.message);

    // 失败时返回简单摘要（包含状态和时间）
    const completedTitles = doneTasks.map(t => t.title);
    const todoTitles = [
      ...todoTasks.map(t => formatTaskInfo(t, 'todo')),
      ...inProgressTasks.map(t => formatTaskInfo(t, 'in_progress'))
    ];

    return {
      success: false,
      data: {
        summary: `${timeFrame}完成 ${doneTasks.length} 项任务，待办 ${todoTasks.length} 项，进行中 ${inProgressTasks.length} 项`,
        completed: completedTitles,
        tomorrowFocus: todoTitles,
        risks: []
      }
    };
  }
}

export {
  analyzeTask,
  generateSummary,
  SUMMARY_PROMPT,
  TASK_ANALYSIS_PROMPT
};
