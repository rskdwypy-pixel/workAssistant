/**
 * 本地规则解析任务字段（不调用大模型）
 *
 * 用途：
 *   1. 没配置 AI / AI 超时 / AI 失败时的兜底 —— 以前这些情况下标题、时间、优先级全部回落默认值，
 *      用户只能手填；现在常见的中文说法（明天、下周三、预计2天、紧急、进度50%）本地就能识别。
 *   2. 短句且执行已确定时直接用本地结果，省掉一次 3~5 秒的模型调用。
 *
 * 返回字段与 analyzeTaskUnified 保持一致，便于两条路径结果互换。
 */
import { resolveReminderTime, resolveDueDate } from './unifiedAnalyzer.js';

const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const WEEKDAY = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0, 七: 0 };

/** 「12」「十二」「两」「二十五」→ 数字；无法识别返回 NaN */
function toNumber(s) {
  if (s == null) return NaN;
  const str = String(s).trim();
  if (/^\d+(\.\d+)?$/.test(str)) return Number(str);
  if (str === '十') return 10;
  const m = str.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? CN_DIGIT[m[1]] : 1) * 10 + (m[2] ? CN_DIGIT[m[2]] : 0);
  if (str.length === 1 && str in CN_DIGIT) return CN_DIGIT[str];
  return NaN;
}

const NUM = '(\\d{1,3}|[一二两三四五六七八九十]{1,3})';

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(now, n) {
  const d = new Date(now);
  d.setDate(d.getDate() + n);
  return d;
}

/**
 * 识别截止日期说法，返回 { date: Date, spec }（spec 供提醒时间换算），未识别返回 null
 */
function parseDay(text, now) {
  let m;
  if ((m = text.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})[日号]?/))) {
    return { date: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) };
  }
  if ((m = text.match(new RegExp(`${NUM}月${NUM}[日号]`)))) {
    const month = toNumber(m[1]);
    const day = toNumber(m[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      let d = new Date(now.getFullYear(), month - 1, day);
      // 远在过去的日期多半指明年（如 12 月说「1月5号」）
      if (d.getTime() < addDays(now, -30).getTime()) d = new Date(now.getFullYear() + 1, month - 1, day);
      return { date: d };
    }
  }
  if ((m = text.match(/大后天/))) return { date: addDays(now, 3), spec: { dayOffset: 3 } };
  if ((m = text.match(/后天/))) return { date: addDays(now, 2), spec: { dayOffset: 2 } };
  if ((m = text.match(/明天|明日|明早|明晚/))) return { date: addDays(now, 1), spec: { dayOffset: 1 } };
  if ((m = text.match(/今天|今日|今晚|今早/))) return { date: addDays(now, 0), spec: { dayOffset: 0 } };
  if ((m = text.match(/下(?:个)?(?:周|星期|礼拜)([一二三四五六日天七])/))) {
    const target = WEEKDAY[m[1]];
    // 下周 X = 下周一 + (X-1)，周日算一周的最后一天
    const dow = now.getDay() || 7;
    const nextMonday = addDays(now, 8 - dow);
    const offset = target === 0 ? 6 : target - 1;
    const d = addDays(nextMonday, offset);
    return { date: d, spec: { dayOffset: Math.round((new Date(ymd(d)) - new Date(ymd(now))) / 86400000) } };
  }
  if ((m = text.match(/(?:这|本)?(?:周|星期|礼拜)([一二三四五六日天七])/))) {
    const target = WEEKDAY[m[1]];
    let delta = target - now.getDay();
    if (delta < 0) delta += 7;
    return { date: addDays(now, delta), spec: { dayOfWeek: target } };
  }
  if ((m = text.match(new RegExp(`${NUM}[号日](?:之?前|前|截止|完成)?`)))) {
    const day = toNumber(m[1]);
    if (day >= 1 && day <= 31) {
      let d = new Date(now.getFullYear(), now.getMonth(), day);
      if (d.getTime() < addDays(now, -1).getTime()) d = new Date(now.getFullYear(), now.getMonth() + 1, day);
      return { date: d };
    }
  }
  if (/月底|月末/.test(text)) return { date: new Date(now.getFullYear(), now.getMonth() + 1, 0) };
  if (/下(?:个)?(?:周|星期|礼拜)/.test(text)) return { date: addDays(now, 7) };
  return null;
}

/** 「下午3点」「15:30」「晚上8点半」→ "15:00" / "15:30" / "20:30"，未识别返回 null */
function parseTimeOfDay(text) {
  let m = text.match(/(\d{1,2})[:：](\d{2})/);
  let hour;
  let minute = 0;
  let period = '';
  if (m) {
    hour = Number(m[1]);
    minute = Number(m[2]);
    const before = text.slice(0, m.index);
    const p = before.match(/(上午|早上|早晨|中午|下午|傍晚|晚上|今晚|明晚)\s*$/);
    period = p ? p[1] : '';
  } else {
    m = text.match(new RegExp(`(上午|早上|早晨|中午|下午|傍晚|晚上|今晚|明晚)?\\s*${NUM}\\s*点(半|${NUM}分?)?`));
    if (!m) return null;
    period = m[1] || '';
    hour = toNumber(m[2]);
    if (m[3] === '半') minute = 30;
    else if (m[3]) minute = toNumber(m[3].replace('分', ''));
  }
  if (!Number.isFinite(hour) || hour > 24 || !Number.isFinite(minute) || minute > 59) return null;
  if (/下午|傍晚|晚上|今晚|明晚/.test(period) && hour < 12) hour += 12;
  if (period === '中午' && hour < 6) hour += 12;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parsePriority(text) {
  if (/\bP0\b|\bP1\b|紧急|加急|特急|十万火急|尽快|马上|立刻|立即|高优|最优先|(?:很|挺|特别|非常|超)急|着急|急需|急用/i.test(text)) return 1;
  if (/\bP2\b|重要|优先|较急|比较急|有点急/i.test(text)) return 2;
  if (/\bP4\b|不急|有空|低优|空闲时|顺手/i.test(text)) return 4;
  return 3;
}

function parseProgress(text) {
  let m = text.match(/(?:进度|完成|做了|已完成)?\s*(\d{1,3})\s*%/);
  if (m) return Math.max(0, Math.min(100, Number(m[1])));
  if (/(?:已经|已)?(?:完成|做完|搞定|弄完)了(?!.{0,4}(?:一半|部分))/.test(text) || /^已完成/.test(text)) return 100;
  if (/(?:完成|做)了?一半|过半/.test(text)) return 50;
  return 0;
}

function parseDurationDays(text) {
  let m = text.match(new RegExp(`(?:预计|预估|大概|大约|约|需要|要|工期|估计)\\s*${NUM}\\s*(?:个)?(工作日|天|日|周|星期|礼拜)`));
  if (!m) m = text.match(new RegExp(`${NUM}\\s*(?:个)?(工作日|天|周|星期|礼拜)(?:内|左右)?(?:完成|搞定|做完)`));
  if (!m) return null;
  const n = toNumber(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return /周|星期|礼拜/.test(m[2]) ? n * 7 : n;
}

/**
 * 标题：取首行，去掉已被结构化的噪声片段（优先级标记、工期说明、进度说明）
 */
function cleanTitle(firstLine) {
  let t = firstLine
    .replace(/^[【\[(（]?\s*(?:紧急|加急|重要|高优|低优|P[0-4])\s*[】\])）:：]?\s*/i, '')
    .replace(new RegExp(`[，,；;。\\s]*(?:预计|预估|大概|大约|约|工期|估计)\\s*${NUM}\\s*(?:个)?(?:工作日|天|日|周|星期|礼拜)(?:完成|左右)?`, 'g'), '')
    .replace(/[，,；;。\s]*(?:进度|已完成|完成了?)\s*\d{1,3}\s*%/g, '')
    .replace(/[，,；;。\s]+$/, '')
    .trim();
  // 句首的「提醒我 / 今天下午3点 / 下周三前」已拆进提醒、截止日期字段，标题里去掉
  const lead = new RegExp('^(?:请?提醒我|记得)?\\s*' +
    '(?:(?:今天|今日|今晚|今早|明天|明日|明早|明晚|后天|大后天|下(?:个)?(?:周|星期|礼拜)[一二三四五六日天七]?|(?:这|本)?(?:周|星期|礼拜)[一二三四五六日天七])' +
    '(?:\\s*(?:上午|早上|早晨|中午|下午|傍晚|晚上))?' +
    '(?:\\s*(?:\\d{1,2}|[一二两三四五六七八九十]{1,3})\\s*点(?:半|\\d{1,2}分?)?|\\s*\\d{1,2}[:：]\\d{2})?' +
    '(?:之?前)?)\\s*[，,、]?\\s*(?:要|需要|得)?\\s*');
  const stripped = t.replace(lead, '').replace(/^(?:请?提醒我|记得)\s*/, '').trim();
  if (stripped.length >= 2) t = stripped;
  if (!t) t = firstLine.trim();
  return t.length > 50 ? t.slice(0, 50) : t;
}

/**
 * 本地解析任务描述
 * @param {string} content
 * @param {Date} [now]
 * @returns {{failed:false, source:'local', title:string, status:string, progress:number, priority:number,
 *            dueDate:string|null, reminderTime:string|null, durationDays:number|null}}
 */
function parseTaskLocally(content, now = new Date()) {
  const text = String(content || '').trim();
  const firstLine = text.split('\n')[0] || text;

  const progress = parseProgress(text);
  let status = 'todo';
  if (progress > 0 && progress < 100) status = 'in_progress';
  if (progress >= 100) status = 'done';

  const durationDays = parseDurationDays(text);
  const day = parseDay(text, now);
  const timeOfDay = parseTimeOfDay(text);

  // 截止日期：明确日期优先，其次按工期推算
  let dueDate = day ? ymd(day.date) : null;
  if (!dueDate && durationDays) dueDate = resolveDueDate({ durationDays }, now);

  // 提醒：原文说了「提醒」或给了具体时刻才设提醒，避免把截止日期当成提醒
  let reminderTime = null;
  if (/提醒|叫我|通知我/.test(text) || timeOfDay) {
    const spec = day && day.spec ? { ...day.spec } : (day ? { dayOffset: Math.round((new Date(ymd(day.date)) - new Date(ymd(now))) / 86400000) } : null);
    if (spec || timeOfDay) {
      reminderTime = resolveReminderTime({ ...(spec || { dayOffset: 0 }), timeOfDay }, now);
    }
  }

  return {
    failed: false,
    source: 'local',
    title: cleanTitle(firstLine),
    status,
    progress,
    priority: parsePriority(text),
    dueDate,
    reminderTime,
    durationDays
  };
}

/**
 * 短句判定：一行、不超过 20 个字。这类输入原文本身就是合格的标题，
 * 执行已确定时用本地解析就够了；更长的句子仍交给模型整理标题。
 */
function isSimpleInput(content) {
  const text = String(content || '').trim();
  return !text.includes('\n') && text.length <= 20;
}

export { parseTaskLocally, isSimpleInput };
