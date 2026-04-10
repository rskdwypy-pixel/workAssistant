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

{bugSection}

【重要】tomorrowFocus 数组必须包含【待办任务】和【进行中任务】中的每一项，数量必须与输入一致，不得遗漏任何任务！

【报告格式要求】
1. summary（总览）：
   日报格式：第一句"今日已工作时长X小时"，第二句使用上述实际数字（总任务数、完成数），第三句"{timeFrame}主要工作内容{主要内容}"
   周报/月报格式：第一句使用上述实际数字（总任务数、完成数），第二句"{timeFrame}主要工作内容{主要内容}"（不显示工时）
   
   【重要】summary 中的任务数量必须使用上述提供的实际数字，不要自己统计！

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
   - 如有严重级别（4级）或紧急 Bug 未处理，提示"存在紧急 Bug 需优先处理"
   - 否则返回空数组

【JSON返回格式示例】

日报（无 Bug）：
{
  "summary": "今日已工作时长2.0小时。今日共处理任务4项，其中完成工作0项。今日主要工作内容xxx。",
  "completed": [],
  "tomorrowFocus": ["[待办] 任务1", "[进行中] 任务2（40%）"],
  "risks": []
}

日报（有 Bug）：
{
  "summary": "今日已工作时长2.0小时。今日共处理任务4项，其中完成工作0项。处理 Bug 3 项，其中解决 0 项、激活 1 项。今日主要工作内容xxx.",
  "completed": [],
  "tomorrowFocus": ["[待办] 任务1", "[进行中] 任务2（40%）"],
  "risks": ["存在紧急 Bug 需优先处理"]
}

周报/月报（不显示工时）：
{
  "summary": "本周共处理任务10项，其中完成工作5项。处理 Bug 8 项，其中解决 5 项、激活 2 项、关闭 1 项。本周主要工作内容xxx.",
  "completed": ["任务A", "任务B"],
  "tomorrowFocus": ["[待办] 任务3", "[进行中] 任务4（30%）"],
  "risks": []
}`;

/**
 * 工作总结生成系统提示词（优化版 V2）
 * 严格分离规则和数据，采用 YAML 格式输入
 */
const SUMMARY_SYSTEM_PROMPT = `你是一个严谨的研发工作汇报助手。你的任务是将传入的原始任务列表，转化为结构化的 JSON 汇报数据。

【重要规则】
1. **summary 字段（字符串类型）**：
   - 格式："{工时描述}。{任务统计}。主要工作内容：{任务列表}。"
   - 示例："今日已工作8.0小时。今日共处理任务6项，其中完成工作1项。主要工作内容：处理登录设备。"
   - **注意**：summary 必须是纯字符串，不要使用对象或嵌套结构！

2. **completed 字段（字符串数组）**：
   - 仅包含已完成任务
   - 格式："任务标题" 或 "任务标题 (描述)"

3. **tomorrowFocus 字段（字符串数组）**：
   - 必须包含所有待办和进行中任务
   - 待办格式："[待办] 任务名称"
   - 进行中格式："[进行中] 任务名称 (进度%)"

4. **risks 字段（字符串数组）**：
   - 始终返回空数组：[]

【完整输出示例】
{
  "summary": "今日已工作8.0小时。今日共处理任务6项，其中完成工作1项。主要工作内容：处理登录设备。",
  "completed": ["处理登录设备 (阿迪处理掉登录设备)"],
  "tomorrowFocus": ["[进行中] 吉利汽车沟通部署 (13%)", "[进行中] 中信证券新版本更新 (7%)"],
  "risks": []
}

返回纯 JSON 格式，不要使用 markdown 代码块标记。`;

/**
 * 构建用户提示词（YAML 格式数据）
 * @param {Array} todoTasks - 待办任务
 * @param {Array} inProgressTasks - 进行中任务
 * @param {Array} doneTasks - 已完成任务
 * @param {string} type - 报告类型
 * @param {Object} workTimeInfo - 工时信息
 * @param {Object} bugData - Bug 数据
 * @returns {string} YAML 格式的提示词
 */
function buildUserPrompt(todoTasks, inProgressTasks, doneTasks, type, workTimeInfo, bugData) {
  const timeFrameMap = { daily: '今日', weekly: '本周', monthly: '本月' };
  const timeFrame = timeFrameMap[type];

  let prompt = `# ${timeFrame}工作汇报生成\n\n`;

  // 统计信息（预处理）
  const totalTasks = todoTasks.length + inProgressTasks.length + doneTasks.length;
  const doneCount = doneTasks.length;
  let statsLine = `统计：共${totalTasks}项任务，完成${doneCount}项`;

  // 工时（仅日报）
  if (type === 'daily' && workTimeInfo?.hours > 0) {
    statsLine += `，已工作${workTimeInfo.hours.toFixed(1)}小时`;
  }

  // Bug 统计（预处理）
  if (bugData?.bugs?.length > 0) {
    const { stats } = bugData;
    statsLine += `，Bug ${bugData.bugs.length}项（未确认${stats.unconfirmed}、激活${stats.activated}、解决${stats.resolved}、关闭${stats.closed}）`;
  }

  prompt += `${statsLine}。\n\n`;

  // 使用 YAML 格式列出任务
  if (todoTasks.length > 0) {
    prompt += `## 待办任务 (${todoTasks.length}项)\n`;
    todoTasks.forEach(t => {
      prompt += `- ${formatTaskForAI(t, 'todo')}\n`;
    });
    prompt += `\n`;
  }

  if (inProgressTasks.length > 0) {
    prompt += `## 进行中任务 (${inProgressTasks.length}项)\n`;
    inProgressTasks.forEach(t => {
      prompt += `- ${formatTaskForAI(t, 'in_progress')}\n`;
    });
    prompt += `\n`;
  }

  if (doneTasks.length > 0) {
    prompt += `## 已完成任务 (${doneTasks.length}项)\n`;
    doneTasks.forEach(t => {
      const formatted = formatTaskForAI(t, 'done');
      prompt += `- ${formatted}\n`;
    });
    prompt += `\n`;
  }

  // 主要工作内容（预处理，避免 AI 自行总结）
  if (doneTasks.length > 0) {
    const mainTasks = doneTasks.slice(0, 3).map(t => t.title);
    prompt += `## 主要工作内容\n${mainTasks.join('、')}${doneTasks.length > 3 ? '等' : ''}\n\n`;
  } else {
    prompt += `## 主要工作内容\n暂无\n\n`;
  }

  // 不再显示风险提示

  return prompt;
}

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
 * 格式化任务信息（包含时间和进度）- 旧版，保留兼容
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
 * 检测模型是否支持 Structured Outputs（JSON Schema）
 * @param {string} model - 模型名称
 * @returns {boolean} 是否支持
 */
function supportsStructuredOutput(model) {
  // gpt-4o-mini, gpt-4o, gpt-4-turbo 及更新版本支持
  return model.includes('gpt-4o') ||
         model.includes('gpt-4-turbo') ||
         model.includes('claude-3.5') ||
         model.includes('gemini-2.0');
}

/**
 * 格式化任务信息（优化版，用于 AI 输入）
 * 去除冗余标签，只保留核心信息
 * @param {Object} task - 任务对象
 * @param {string} status - 任务状态
 * @returns {string} 格式化后的任务字符串
 */
function formatTaskForAI(task, status) {
  const parts = [];

  // 标题（必填）
  parts.push(task.title);

  // 进度（仅进行中）
  if (status === 'in_progress' && task.progress > 0) {
    parts.push(`${task.progress}%`);
  }

  // 有价值的描述（与标题不同且长度适中）
  if (task.content &&
      task.content !== task.title &&
      task.content.length > 0 &&
      task.content.length < 50) {
    parts.push(task.content);
  }

  return parts.join(' ');
}

/**
 * 计算风险提示（代码逻辑）
 * @param {Array} todoTasks - 待办任务
 * @param {Array} inProgressTasks - 进行中任务
 * @param {Object} bugData - Bug 数据
 * @returns {Array} 风险提示数组
 */
function calculateRisks(todoTasks, inProgressTasks, bugData) {
  const risks = [];

  // 风险1：待办任务过多
  if (todoTasks.length + inProgressTasks.length > 5) {
    risks.push('待办任务较多，建议合理规划');
  }

  // 风险2：存在过期任务
  const now = Date.now();
  const hasOverdue = [...todoTasks, ...inProgressTasks].some(t =>
    t.reminderTime && new Date(t.reminderTime).getTime() < now
  );

  if (hasOverdue) {
    risks.push('存在已过期任务，请及时处理');
  }

  // 风险3：存在紧急 Bug
  if (bugData?.bugs?.some(b => b.severity <= 2 && b.status !== 'closed')) {
    risks.push('存在紧急Bug需优先处理');
  }

  return risks;
}

/**
 * 生成工作汇报
 * @param {Array} todoTasks - 待办任务
 * @param {Array} inProgressTasks - 进行中任务
 * @param {Array} doneTasks - 已完成任务
 * @param {string} type - daily, weekly, monthly
 * @param {Object} workTimeInfo - 工时信息 { hours: number }
 * @param {Object} bugData - Bug 数据 { bugs: [], stats: {} }
 */
async function generateSummary(todoTasks, inProgressTasks, doneTasks, type = 'daily', workTimeInfo = null, bugData = null) {
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
      bugData,
      workTimeInfo
    });

    const promptTemplate = config.prompts[type] || SUMMARY_PROMPT;

    // 构建工时信息（仅日报显示工时）
    let workTimeString = '';
    if (type === 'daily' && workTimeInfo && workTimeInfo.hours > 0) {
      workTimeString = `今日已工作时长${workTimeInfo.hours.toFixed(1)}小时。`;
    }

    // 计算任务统计
    const totalTasks = todoTasks.length + inProgressTasks.length + doneTasks.length;
    const doneCount = doneTasks.length;

    // 生成主要工作内容描述（优先使用已完成任务）
    let mainContent = '暂无';
    if (doneTasks.length > 0) {
      // 取前3个已完成任务作为主要工作内容
      const mainTasks = doneTasks.slice(0, 3).map(t => t.title);
      mainContent = mainTasks.join('、');
      if (doneTasks.length > 3) {
        mainContent += '等';
      }
    }

    // 构建 Bug 统计信息
    let bugSection = '';
    let bugStatsInfo = '';
    if (bugData && bugData.bugs && bugData.bugs.length > 0) {
      const bugs = bugData.bugs;
      const unconfirmedCount = bugs.filter(b => b.status === 'unconfirmed').length;
      const activatedCount = bugs.filter(b => b.status === 'activated').length;
      const resolvedCount = bugs.filter(b => b.status === 'resolved').length;
      const closedCount = bugs.filter(b => b.status === 'closed').length;

      bugStatsInfo = `处理 Bug ${bugs.length} 项，其中未确认 ${unconfirmedCount} 项、已激活 ${activatedCount} 项、已解决 ${resolvedCount} 项、已关闭 ${closedCount} 项。`;

      // 格式化 Bug 信息
      const formattedBugs = bugs.map(b => {
        const statusMap = {
          'unconfirmed': '未确认',
          'activated': '已激活',
          'resolved': '已解决',
          'closed': '已关闭'
        };
        let info = `[${statusMap[b.status]}] 标题: ${b.title}`;
        if (b.content && b.content !== b.title) {
          info += ` (描述: ${b.content})`;
        }
        if (b.severity) {
          const severityMap = { 1: '致命', 2: '严重', 3: '一般', 4: '提示' };
          info += ` (级别: ${severityMap[b.severity] || b.severity})`;
        }
        return info;
      });

      bugSection = `\n【Bug 数据】\n${JSON.stringify(formattedBugs)}\n`;
    }

    // ✅ 使用优化后的提示词架构（System + User 分离）
    // 检查是否配置了自定义提示词，如果没有则使用新的优化版
    const useOptimizedPrompt = !config.prompts[type];

    let messages;
    let requestOptions = {
      model: config.ai.model,
      temperature: 0.2,  // 降低随机性
      max_tokens: 1000   // 减少最大 tokens
    };

    if (useOptimizedPrompt) {
      // 新架构：System + User 分离
      const userPrompt = buildUserPrompt(todoTasks, inProgressTasks, doneTasks, type, workTimeInfo, bugData);
      messages = [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ];
      requestOptions.messages = messages;

      // ✅ 如果模型支持，使用 JSON Schema 约束输出
      if (supportsStructuredOutput(config.ai.model)) {
        console.log(`[generateSummary] 模型 ${config.ai.model} 支持 Structured Outputs，使用 JSON Schema`);
        requestOptions.response_format = {
          type: 'json_schema',
          json_schema: {
            name: 'daily_report',
            strict: true,  // 严格模式
            schema: {
              type: 'object',
              properties: {
                summary: {
                  type: 'string',
                  description: '一句话总结，必须包含给定的统计数字'
                },
                completed: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '已完成任务列表'
                },
                tomorrowFocus: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '待办和进行中任务列表，数量必须等于输入数量'
                },
                risks: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '风险提示列表，始终返回空数组'
                }
              },
              required: ['summary', 'completed', 'tomorrowFocus', 'risks'],
              additionalProperties: false
            }
          }
        };
      } else {
        // 兼容旧模型：使用 JSON mode
        console.log(`[generateSummary] 模型 ${config.ai.model} 不支持 Structured Outputs，使用 JSON mode`);
        requestOptions.response_format = { type: 'json_object' };
      }

      console.log(`[generateSummary] 使用优化后的提示词架构 V2`);
    } else {
      // 旧架构：兼容自定义提示词
      let statsInfo = `【统计数据】${timeFrame}共处理任务${totalTasks}项，其中完成工作${doneCount}项。`;
      if (bugStatsInfo) {
        statsInfo += bugStatsInfo;
      }
      statsInfo += `${timeFrame}主要工作内容：${mainContent}。\n\n`;

      const prompt = statsInfo + promptTemplate
        .replace(/{timeFrame}/g, timeFrame)
        .replace('{总数}', totalTasks.toString())
        .replace('{完成数}', doneCount.toString())
        .replace('{主要内容}', mainContent)
        .replace('{todoTasks}', JSON.stringify(formattedTodoTasks))
        .replace('{inProgressTasks}', JSON.stringify(formattedInProgressTasks))
        .replace('{doneTasks}', JSON.stringify(formattedDoneTasks))
        .replace('{bugSection}', bugSection)
        .replace(/今日已工作时长{x}小时（如有）/g, workTimeString || '')
        .replace(/今日已工作时长{x}小时/g, workTimeString || '')
        .replace(/今日主要工作内容/g, `${timeFrame}主要工作内容`)
        .replace(/共处理任务/g, `${timeFrame}共处理任务`);

      messages = [
        { role: 'system', content: `你是专业的工作助手，擅长总结${timeFrame}工作内容。【重要】tomorrowFocus 数组必须包含所有待办和进行中任务，数量必须与输入一致，不得遗漏！` },
        { role: 'user', content: prompt }
      ];
      requestOptions.messages = messages;
      requestOptions.response_format = { type: 'json_object' };  // 兼容旧提示词也使用 JSON mode

      console.log(`[generateSummary] 使用自定义提示词`);
    }

    const response = await client.chat.completions.create(requestOptions);

    let content = response.choices[0].message.content.trim();

    // 清理可能的 markdown 代码块标记
    if (content.startsWith('```')) {
      content = content.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    const result = JSON.parse(content);

    // ✅ 防御性处理：确保 summary 是字符串
    if (result.summary && typeof result.summary !== 'string') {
      console.warn('[generateSummary] summary 不是字符串，尝试转换:', typeof result.summary, result.summary);
      if (typeof result.summary === 'object') {
        // 如果是对象，尝试提取有用信息
        const parts = [];
        if (result.summary.工时 || result.summary.workHours) parts.push(result.summary.工时 || result.summary.workHours);
        if (result.summary.统计 || result.summary.stats) parts.push(result.summary.统计 || result.summary.stats);
        if (result.summary.主要内容 || result.summary.mainContent) parts.push(result.summary.主要内容 || result.summary.mainContent);
        result.summary = parts.join('，') || '工作总结';
      } else {
        result.summary = String(result.summary);
      }
    }

    // ✅ 新增：校验和补全逻辑（确保数量一致性）
    const expectedCount = todoTasks.length + inProgressTasks.length;
    const actualCount = result.tomorrowFocus?.length || 0;

    if (actualCount !== expectedCount) {
      console.warn(`[generateSummary] tomorrowFocus数量不匹配: 期望${expectedCount}, 实际${actualCount}，执行代码级补全`);

      // 代码级降级：直接使用原始任务补全
      const missingTasks = [];
      const existingTitles = new Set((result.tomorrowFocus || []).map(s => s.replace(/^\[(待办|进行中)\]\s*/, '')));

      // 补齐待办任务
      todoTasks.forEach(t => {
        const formatted = `[待办] ${formatTaskForAI(t, 'todo')}`;
        if (!existingTitles.has(t.title)) {
          missingTasks.push(formatted);
        }
      });

      // 补齐进行中任务
      inProgressTasks.forEach(t => {
        const formatted = `[进行中] ${formatTaskForAI(t, 'in_progress')}`;
        if (!existingTitles.has(t.title)) {
          missingTasks.push(formatted);
        }
      });

      result.tomorrowFocus = [...(result.tomorrowFocus || []), ...missingTasks];
      console.log(`[generateSummary] 补全后数量: ${result.tomorrowFocus.length}`);
    }

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

/**
 * 本地规则引擎：前置关键词匹配
 * @param {string} taskContent - 任务内容
 * @param {Array} executions - 可用的执行列表
 * @returns {string|null} - 匹配的执行ID，如果无法唯一匹配则返回null
 */
function ruleBasedMatch(taskContent, executions) {
  console.log('[规则引擎] ========== 开始本地匹配 ==========');
  console.log('[规则引擎] 任务内容:', taskContent);
  console.log('[规则引擎] 候选执行数量:', executions.length);

  if (!executions || executions.length === 0) {
    console.log('[规则引擎] 没有可用的执行列表');
    return null;
  }

  const lowerContent = taskContent.toLowerCase();
  const matches = [];

  // 构建别名映射（从执行的项目名称和执行名称生成）
  for (const exec of executions) {
    const aliases = new Set();

    console.log(`[规则引擎] 检查执行 ${exec.id}: ${exec.name} | 项目: ${exec.projectName || '未设置'}`);

    // 添加项目名称（全名和小写）
    if (exec.projectName) {
      const lowerProjectName = exec.projectName.toLowerCase();
      aliases.add(lowerProjectName);
      console.log(`[规则引擎]   - 项目名: ${lowerProjectName}`);
    }

    // 添加执行名称
    if (exec.name) {
      aliases.add(exec.name.toLowerCase());
      console.log(`[规则引擎]   - 执行名: ${exec.name.toLowerCase()}`);
    }

    // 添加常见别名映射
    const aliasMap = {
      '阿迪达斯': ['阿迪', 'adidas', 'adi'],
      '阿迪': ['阿迪达斯', 'adidas'],
      'adidas': ['阿迪', '阿迪达斯', 'adi'],
      '阿达斯': ['阿迪', 'adidas'],
      '耐克': ['耐', 'nike'],
      '耐': ['耐克', 'nike'],
      'nike': ['耐', '耐克'],
      '民生': ['民生卡', '民生证券']
    };

    // 检查是否需要添加额外别名
    for (const [key, values] of Object.entries(aliasMap)) {
      const projectName = exec.projectName || '';
      const execName = exec.name || '';
      const lowerProjectName = projectName.toLowerCase();
      const lowerExecName = execName.toLowerCase();

      // 双向匹配：项目名包含关键字 OR 关键字包含项目名
      if (lowerProjectName.includes(key) || key.includes(lowerProjectName) ||
          lowerExecName.includes(key) || key.includes(lowerExecName)) {
        console.log(`[规则引擎]   - 匹配到别名映射 "${key}": 添加`, values.join(', '));
        values.forEach(v => aliases.add(v.toLowerCase()));
      }
    }

    console.log(`[规则引擎]   - 所有别名: [${Array.from(aliases).join(', ')}]`);

    // 检查是否匹配
    for (const alias of aliases) {
      if (lowerContent.includes(alias) && alias.length >= 2) {
        matches.push({ id: exec.id, name: exec.name, matchedBy: alias });
        console.log(`[规则引擎] ✓ 匹配成功: ID=${exec.id}, 别名="${alias}"`);
        break; // 找到一个匹配就跳出
      }
    }
  }

  console.log('[规则引擎] 匹配结果:', matches.length, '个');
  matches.forEach(m => console.log(`[规则引擎]   - ${m.id}: ${m.name} (关键词: ${m.matchedBy})`));

  if (matches.length === 1) {
    console.log('[规则引擎] ✓✓✓ 唯一匹配 ✓✓✓:', matches[0].id, matches[0].name);
    return matches[0].id;
  } else if (matches.length > 1) {
    console.log('[规则引擎] ? 多个匹配，需要AI抉择:', matches.map(m => `${m.id}(${m.matchedBy})`).join(', '));
    return null;
  } else {
    console.log('[规则引擎] ✗ 无匹配，进入AI分析');
    return null;
  }
}

/**
 * 分析任务并匹配最合适的执行（规则 + AI 双引擎）
 * @param {string} taskContent - 任务内容
 * @param {Array} executions - 可用的执行列表
 * @returns {Promise<string|null>} - 匹配的执行ID，如果没有匹配则返回null
 */
async function analyzeTaskForExecution(taskContent, executions) {
  try {
    console.log('[Routing] ========== 任务路由分析 ==========');
    console.log('[Routing] 任务内容:', taskContent);
    console.log('[Routing] 候选执行数量:', executions.length);

    if (!executions || executions.length === 0) {
      console.log('[Routing] 没有可用的执行列表');
      return null;
    }

    // 第一步：本地规则引擎匹配
    const ruleMatch = ruleBasedMatch(taskContent, executions);
    if (ruleMatch) {
      return ruleMatch; // 规则引擎唯一匹配，直接返回
    }

    // 第二步：AI 分析（规则引擎无匹配或多匹配）
    console.log('[Routing] 进入 AI 分析阶段...');

    // 构建 AI 输入的执行列表（JSON 格式）
    const executionListForAI = executions.map(e => {
      const aliases = [];
      if (e.projectName) {
        aliases.push(e.projectName);
        // 生成常见别名
        if (e.projectName.includes('阿迪达斯') || e.projectName.includes('Adidas')) {
          aliases.push('阿迪', 'Adidas');
        }
        if (e.projectName.includes('耐克') || e.projectName.includes('Nike')) {
          aliases.push('耐', 'Nike');
        }
      }
      return {
        id: parseInt(e.id) || e.id,
        name: e.name,
        project: e.projectName || '未分类',
        aliases: aliases
      };
    });

    // 添加"无法确定"选项
    executionListForAI.push({
      id: 0,
      name: '默认执行',
      project: '未分类',
      aliases: ['无法确定', '其他', '默认']
    });

    // 使用 JSON Mode 和 Few-Shot 优化提示词
    const prompt = `你是任务分类路由引擎。请分析【用户任务】，从【可用列表】中匹配最合适的执行项目，并输出 JSON 格式。

【可用列表】
${JSON.stringify(executionListForAI, null, 2)}

【匹配规则】
1. 优先根据别名和关键词进行精确映射
2. 如果任务描述模糊或无法匹配任何可用列表中的项目，请务必返回 id: 0 (未分类)

【示例】
任务："测试阿迪新版本" -> 返回：{"executionId": 123}
任务："去楼下拿个快递" -> 返回：{"executionId": 0}
任务："修复登录bug" -> 返回：{"executionId": 456}

【用户任务】
"${taskContent}"

请只返回JSON格式：{"executionId": 数字}`;

    console.log('[Routing] 发送请求到 OpenAI...');

    const response = await client.chat.completions.create({
      model: config.ai.model,
      response_format: { type: "json_object" },  // JSON Mode
      messages: [
        { role: 'system', content: '你是任务分类路由引擎，擅长理解任务内容并将其分配到合适的执行中。严格按照JSON格式返回结果。' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,  // 降低温度，提高稳定性
      max_tokens: 50
    });

    const content = response.choices[0].message.content.trim();
    console.log('[Routing] AI 原始返回:', content);

    // 解析 JSON
    let result;
    try {
      result = JSON.parse(content);
    } catch (e) {
      console.error('[Routing] JSON 解析失败:', content);
      return null;
    }

    const aiExecutionId = result.executionId;

    // 验证 ID
    if (aiExecutionId === 0) {
      console.log('[Routing] AI 推断为"无法确定"，将使用默认执行');
      return null; // 返回 null 让调用方使用默认执行
    }

    const exists = executions.find(e => String(e.id) === String(aiExecutionId));
    if (exists) {
      console.log('[Routing] ✓ AI 推断成功:', aiExecutionId, exists.name, '项目:', exists.projectName);
      return String(aiExecutionId);
    }

    console.log('[Routing] AI 返回的 ID 不在候选列表中:', aiExecutionId);
    return null;
  } catch (err) {
    console.error('[Routing] AI 分析失败:', err.message);
    return null;
  }
}

/**
 * 通用 AI 响应生成函数
 * @param {string} prompt - 提示词
 * @param {number} maxTokens - 最大 token 数，默认 500
 * @returns {Promise<string>} AI 响应内容
 */
async function generateResponse(prompt, maxTokens = 500) {
  try {
    const response = await client.chat.completions.create({
      model: config.ai.model,
      messages: [
        { role: 'system', content: '你是专业的助手，擅长分析和处理各种任务。' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      max_tokens: maxTokens
    });

    let content = response.choices[0].message.content.trim();

    // 清理可能的 markdown 代码块标记
    if (content.startsWith('```')) {
      content = content.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    return content;
  } catch (error) {
    console.error('[OpenAI] 生成响应失败:', error);
    throw error;
  }
}

export {
  analyzeTask,
  analyzeTaskForExecution,
  generateSummary,
  generateResponse,
  SUMMARY_PROMPT,
  SUMMARY_SYSTEM_PROMPT,    // 新增：优化版系统提示词
  TASK_ANALYSIS_PROMPT,
  formatTaskForAI,          // 新增：优化版任务格式化
  calculateRisks            // 新增：代码级风险计算
};
