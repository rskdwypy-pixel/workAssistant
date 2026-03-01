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
const SUMMARY_PROMPT = `你是专业的工作汇报助手。请根据以下任务数据，生成一份详细的{timeFrame}工作汇报。

【任务数据】
- 待办任务：{todoTasks}
- 进行中任务：{inProgressTasks}
- 已完成任务：{doneTasks}

注：任务数据中附带了用户的“(原始描述)”，请在生成汇报和概括主要工作时，综合提取其中的关键细节，让总结更丰富、更有深度。

【重要说明】
- 只有"已完成任务"列表中的任务才是真正完成的
- "待办任务"和"进行中任务"都是未完成的，不要把它们说成已完成
- 统计完成数量时只计算"已完成任务"的数量
- 任务列表中的时间格式为 "YYYY-MM-DD HH:MM" 或 "YYYY-MM-DD"，请在报告中以中文格式显示

【汇报要求】
1. summary（工作总结）：
   - 统计{timeFrame}任务完成情况（总数、完成数、待办数、进行中数）
   - 完成数 = 已完成任务列表的数量
   - 概括主要工作内容（务必结合原始描述，提炼出详实具体的进展细节）
   - 字数100-200字

2. completed（已完成事项）：
   - 列出所有已完成任务的具体标题（可参考原始描述使其更准确丰富）
   - 每项一行，不要遗漏
   - 格式："任务标题"

3. tomorrowFocus（重点待办/进行中）：
   - 区分列出待办任务和进行中任务
   - 如果有提醒时间或截止时间，以"(截止: 时间)"或"(提醒: 时间)"格式标注在任务后面
   - 格式示例："[待办] 任务标题 (截止: 2025-02-28 18:00)" 或 "[进行中] 任务标题 (提醒: 2025-02-27 09:00)"
   - 不要遗漏任何未完成任务

4. risks（风险建议）：
   - 如待办+进行中任务超过5项，提示"待办任务较多，建议合理规划"
   - 如有任务已过期（提醒时间/截止时间早于当前时间），提示"存在已过期任务，请及时处理"
   - 如无风险则返回空数组[]

请严格按以下JSON格式返回，不要有任何额外内容：
{
  "summary": "{timeFrame}工作总结（100-200字）",
  "completed": ["已完成任务1", "已完成任务2", "..."],
  "tomorrowFocus": ["[待办/进行中] 任务标题 (时间信息)", "..."],
  "risks": ["风险提示"]或[]
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

    const content = response.choices[0].message.content.trim();
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
 * 生成日报
 */
/**
 * 格式化任务信息（包含时间）
 */
function formatTaskInfo(task, status) {
  let info = `[${status === 'todo' ? '待办' : '进行中'}] 标题: ${task.title}`;
  if (task.content && task.content !== task.title) {
    info += ` (原始描述: ${task.content})`;
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
 */
async function generateSummary(todoTasks, inProgressTasks, doneTasks, type = 'daily') {
  const timeFrameMap = {
    daily: '今日',
    weekly: '本周',
    monthly: '本月'
  };
  const timeFrame = timeFrameMap[type] || '今日';

  try {
    // 格式化任务信息，包含状态和时间
    const formattedTodoTasks = todoTasks.map(t => formatTaskInfo(t, 'todo'));
    const formattedInProgressTasks = inProgressTasks.map(t => formatTaskInfo(t, 'in_progress'));
    const formattedDoneTasks = doneTasks.map(t => {
      let info = `[已完成] 标题: ${t.title}`;
      if (t.content && t.content !== t.title) {
        info += ` (原始描述: ${t.content})`;
      }
      return info;
    });

    const promptTemplate = config.prompts[type] || SUMMARY_PROMPT;

    const prompt = promptTemplate
      .replace(/{timeFrame}/g, timeFrame)
      .replace('{todoTasks}', JSON.stringify(formattedTodoTasks))
      .replace('{inProgressTasks}', JSON.stringify(formattedInProgressTasks))
      .replace('{doneTasks}', JSON.stringify(formattedDoneTasks));

    const response = await client.chat.completions.create({
      model: config.ai.model,
      messages: [
        { role: 'system', content: `你是专业的工作助手，擅长总结${timeFrame}工作内容。请确保列出所有任务，不要遗漏任何一项。` },
        { role: 'user', content: prompt }
      ],
      temperature: 0.5,
      max_tokens: 2000
    });

    const content = response.choices[0].message.content.trim();
    const result = JSON.parse(content);

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
