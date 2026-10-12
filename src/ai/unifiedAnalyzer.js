/**
 * 统一任务分析：一次 AI 调用同时完成「字段抽取 + 执行归属」
 *
 * 为什么合并：
 *   原实现分两次独立请求 —— analyzeTask 拆标题/状态/时间，
 *   analyzeTaskForExecution 选执行。两次请求各自理解一遍输入，
 *   像「明天上午和中信对一下黄金任务进度」这种跨字段的句子容易被拆错
 *   （时间归到一边、项目归到另一边）。合并后共享同一份上下文。
 *
 * 关键设计：
 *   时间不由 AI 推算绝对时间戳，而是返回「相对量」，由 resolveReminderTime 在代码里算。
 *   AI 直接推 ISO 时间戳时，跨天/跨周/跨月容易算错，且无法验证。
 */

import { config } from '../config.js';
import { buildLearningHint } from '../services/executionLearning.js';
import { rankCandidates } from './candidateRanker.js';

/**
 * 把 AI 返回的时间描述解析为绝对 ISO 时间
 *
 * AI 只回答「什么时候」，具体日期由代码基于 now 计算，保证时区与跨天正确。
 * 支持形如：
 *   { dayOffset: 1, timeOfDay: "15:00" }      → 明天下午3点
 *   { dayOffset: 0, timeOfDay: "18:30" }      → 今天18:30
 *   { dayOffset: 3, timeOfDay: null }         → 3天后（默认上午9点）
 *   { dayOfWeek: 5, timeOfDay: "10:00" }      → 本周五10点
 *   null                                        → 未提及时间
 *
 * @param {Object} spec - AI 返回的时间描述
 * @param {Date} now - 当前时间
 * @returns {string|null} ISO 字符串
 */
export function resolveReminderTime(spec, now = new Date()) {
  if (!spec) return null;

  const timeOfDay = typeof spec.timeOfDay === 'string' && /^\d{1,2}:\d{2}$/.test(spec.timeOfDay)
    ? spec.timeOfDay.trim()
    : null;

  const base = new Date(now);

  if (Number.isInteger(spec.dayOfWeek)) {
    // 指向本周第 N 天（0=周日），若已过则顺延到下周
    const target = ((spec.dayOfWeek % 7) + 7) % 7;
    const currentDow = base.getDay();
    let delta = target - currentDow;
    if (delta <= 0) delta += 7;
    base.setDate(base.getDate() + delta);
  } else if (Number.isInteger(spec.dayOffset)) {
    base.setDate(base.getDate() + spec.dayOffset);
  } else {
    // 没有任何偏移信息 → 视为未提及
    return null;
  }

  if (timeOfDay) {
    const [h, m] = timeOfDay.split(':').map(Number);
    base.setHours(h, m, 0, 0);
  } else {
    // 只说了「几天后」没说具体时刻 → 默认上午 9:00
    base.setHours(9, 0, 0, 0);
  }

  // 已经过去的时间点（就在今天且时刻已过）顺延到明天，避免建出过期提醒
  if (base.getTime() <= now.getTime()) {
    base.setDate(base.getDate() + 1);
  }

  return base.toISOString();
}

/**
 * 把 AI 返回的工期/截止描述解析为绝对日期
 *
 * 与 reminderTime 分开：
 *   - "预计3天完成""工期一周" → dueDate（3天后 / 7天后）
 *   - "明天上午提醒我"        → reminderTime
 *   两者语义不同，混用会导致「3天的工期」被当成「3天后的提醒」而丢失。
 *
 * @param {Object} spec - { durationDays, deadline }
 * @param {Date} now - 当前时间
 * @returns {string|null} YYYY-MM-DD
 */
export function resolveDueDate(spec, now = new Date()) {
  if (!spec) return null;

  // 优先用明确的绝对截止日期
  if (typeof spec.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(spec.deadline.trim())) {
    return spec.deadline.trim();
  }

  const days = Number(spec.durationDays);
  if (!Number.isFinite(days) || days <= 0) return null;

  const d = new Date(now);
  d.setDate(d.getDate() + Math.round(days));
  // 用本地日期拼，避免 toISOString 的 UTC 偏移导致差一天
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 构建统一分析提示词
 */
function buildUnifiedPrompt({ content, candidates, history, learningHint, now }) {
  const candidateList = candidates.map(e => ({
    id: e.id,
    name: e.name,
    project: e.projectName || '未分类',
    type: e.type || ''
  }));

  const historyBlock = history.length > 0
    ? `\n【用户近期任务（了解其表达习惯与项目黑话，仅供理解，不要照抄标题）】\n${history.map(h => `- ${h}`).join('\n')}\n`
    : '';

  return `你是研发团队的任务管理助手。当前时间：${now.toLocaleString('zh-CN', { hour12: false })}
今天是 ${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()]}。

请一次性完成两件事：抽取任务字段、判断归属执行。

【可用执行列表】（已按相关度排序，越靠前越可能相关）
${JSON.stringify(candidateList, null, 0)}
${learningHint}
${historyBlock}
【抽取规则】
1. title：保留完整项目名与关键修饰词，5-30字。**不要**把工期、日期、进度等塞进标题。
2. status：判断依据必须来自原文明确表述：
   - 明确说"已完成/搞定/做完了/100%" → done
   - 明确说"正在做/进行中/已开始"，或原文给出 1-99 的进度 → in_progress
   - 其他一律 todo
   ⚠️ "预计3天完成""工期一周""下周交付"只是排期说明，**不代表任务已经在做**，status 应为 todo。
3. progress：只在原文**明确给出进度**时填写（"50%"、"一半"、"已完成一半"、"1/2"）。
   ⚠️ 原文完全没提进度时必须填 0，不要凭空给 10。
4. priority：1最急（紧急/马上/P1/!!!）、2较高（尽快/优先/P2）、4最低（不急/暂缓/可以晚点）、3默认。
5. 时间（重要）：**不要自己推算日期**，只回答「相对今天的时间」。
   - durationDays：工期天数。用户说"预计3天完成""工期一周""3天内搞定"→ 填天数（"一周"=7）。
     没说工期填 null。
   - dayOffset：提醒时间相对今天的天数偏移。今天=0，明天=1，后天=2。
   - dayOfWeek：用户明确说了周几才填（周一=1…周日=0），否则 null。
   - timeOfDay：24小时制 "HH:mm"（下午3点→"15:00"）；没给具体钟点 null；没提时间则整个 reminder 填 null。
   - deadline：明确写了绝对截止日期时填 "YYYY-MM-DD"，否则 null。
     ⚠️ 工期(durationDays) → dueDate；明确的提醒时间 → reminderTime；两者是不同字段，不要混用。
6. executionId：从【可用执行列表】里挑 id 填数字（列表已按相关度排序，第一个通常最相关）。
   只有当列表里没有任何一个与任务相关时（例如"去楼下拿快递"）才填 0。
7. confidence：0-1 的置信度。拿不准填 0.5，不要填 0。

【示例1】
输入："把卡中心的登录bug搞完了"
输出：{"title":"卡中心登录bug处理","status":"done","progress":100,"priority":3,"durationDays":null,"reminder":null,"deadline":null,"executionId":148,"confidence":0.9}

【示例2】
输入："群控真机拨测脚本写到一半，下周五交付"
输出：{"title":"群控真机拨测脚本编写","status":"in_progress","progress":50,"priority":2,"durationDays":null,"reminder":{"dayOffset":0,"dayOfWeek":5,"timeOfDay":null},"deadline":null,"executionId":61,"confidence":0.85}

【示例3】
输入："平安银行与招商银行竞品分析，预计3天完成，poc项目"
输出：{"title":"平安银行与招商银行竞品分析","status":"todo","progress":0,"priority":3,"durationDays":3,"reminder":null,"deadline":null,"executionId":176,"confidence":0.85}

【示例4】
输入："去楼下拿个快递"
输出：{"title":"取快递","status":"todo","progress":0,"priority":4,"durationDays":null,"reminder":null,"deadline":null,"executionId":0,"confidence":0.5}

【用户输入】
"""${content}"""

只返回一行 JSON，不要任何解释文字：`;
}

/**
 * 统一分析任务：一次调用产出字段 + 执行归属
 *
 * @param {string} content - 用户输入
 * @param {Object} options
 * @param {Array} options.candidates - 候选执行
 * @param {Array<string>} options.history - 近期任务标题（可选）
 * @param {Object} options.client - 注入的 OpenAI 客户端（便于测试）
 * @returns {Promise<Object>} 分析结果
 */
export async function analyzeTaskUnified(content, options = {}) {
  const { candidates = [], history = [], client } = options;
  const now = options.now || new Date();

  if (!client) {
    // 未注入客户端时返回降级结果，避免在无 key 环境下抛错
    return {
      failed: true,
      error: 'AI 客户端不可用',
      title: String(content).slice(0, 30),
      status: 'todo',
      progress: 0,
      priority: 3,
      reminderTime: null,
      executionId: null,
      confidence: 0
    };
  }

  const prompt = buildUnifiedPrompt({
    content,
    // 本地先按相关度压缩候选：实测把 52 个执行一次性丢给 glm-4-flash，
    // 模型无法 discrimination，直接返回 executionId:0 放弃选择。
    // 压缩到 12 个后判断质量明显改善，token 成本也大幅下降。
    candidates: rankCandidates(content, candidates, { limit: 12 }),
    history,
    learningHint: buildLearningHint(content),
    now
  });

  try {
    const response = await client.chat.completions.create({
      model: config.ai.model,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: '你是研发任务管理助手，擅长从中文口语中抽取任务结构化信息。只返回合法JSON。'
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      max_tokens: 400
    });

    let raw = response?.choices?.[0]?.message?.content?.trim() || '';
    if (raw.startsWith('```')) {
      raw = raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return {
        failed: true,
        error: `AI 返回解析失败: ${raw.slice(0, 120)}`,
        title: String(content).slice(0, 30),
        status: 'todo',
        progress: 0,
        priority: 3,
        reminderTime: null,
        executionId: null,
        confidence: 0
      };
    }

    // 防御：JSON 合法但不是对象（例如模型返回了裸字符串或数组）
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        failed: true,
        error: `AI 返回结构异常（${Array.isArray(parsed) ? '数组' : typeof parsed}）`,
        title: String(content).slice(0, 30),
        status: 'todo',
        progress: 0,
        priority: 3,
        reminderTime: null,
        executionId: null,
        confidence: 0
      };
    }

    // —— 字段归一化与校验 ——
    let progress = Number(parsed.progress);
    if (!Number.isFinite(progress)) progress = 0;
    progress = Math.max(0, Math.min(100, Math.round(progress)));

    let status = ['todo', 'in_progress', 'done'].includes(parsed.status) ? parsed.status : 'todo';
    // 进度与状态强一致
    if (progress > 0 && progress < 100) status = 'in_progress';
    if (progress >= 100) status = 'done';
    // progress=0 表示「原文没提进度」，此时不应是 in_progress
    // （旧提示词会无中生有给 10，这里兜底回 todo）
    if (progress === 0 && status === 'in_progress') status = 'todo';

    let priority = Number(parsed.priority);
    if (!Number.isFinite(priority) || priority < 1 || priority > 4) priority = 3;
    priority = Math.round(priority);

    const reminderTime = resolveReminderTime(parsed.reminder, now);
    // 工期 → 截止日期（与 reminderTime 是两个不同语义，不能混用）
    const dueDate = resolveDueDate({
      durationDays: parsed.durationDays,
      deadline: parsed.deadline
    }, now);

    const rawExecId = parsed.executionId;
    const exists = rawExecId != null && candidates.some(e => String(e.id) === String(rawExecId));
    const executionId = exists ? String(rawExecId) : null;

    let confidence = Number(parsed.confidence);
    if (!Number.isFinite(confidence)) confidence = 0.5;
    confidence = Math.max(0, Math.min(1, confidence));

    const title = String(parsed.title || '').trim() || String(content).split('\n')[0].slice(0, 30);

    return {
      failed: false,
      title,
      status,
      progress,
      priority,
      reminderTime,
      dueDate,
      durationDays: Number.isFinite(Number(parsed.durationDays)) ? Number(parsed.durationDays) : null,
      executionId,
      confidence,
      reason: executionId
        ? `归属「${candidates.find(e => String(e.id) === executionId)?.name || executionId}」`
        : '未能确定执行归属'
    };
  } catch (err) {
    return {
      failed: true,
      error: err.message,
      title: String(content).slice(0, 30),
      status: 'todo',
      progress: 0,
      priority: 3,
      reminderTime: null,
      executionId: null,
      confidence: 0
    };
  }
}