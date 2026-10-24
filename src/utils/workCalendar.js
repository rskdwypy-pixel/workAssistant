/**
 * 上班日历：在「周一到周五上班」的基础上叠加法定节假日和调休。
 *
 *   节假日   不上班的工作日（如国庆）          设置里写：2026-10-01~2026-10-07, 2026-12-25
 *   调休日   要上班的周末（如国庆后的周六）     设置里写：2026-10-10
 *
 * 禅道没有这份数据，所以由用户在设置里配（存后端 .env：WORK_HOLIDAYS / WORK_MAKEUP_DAYS）。
 * 用在：工作日历（缺填、补）、工时缺填提醒、自动补填、报告里「应填工时的工作日」。
 * 优先级：调休日 > 节假日 > 周末。
 */
import { config } from '../config.js';

const MAX_RANGE_DAYS = 62;   // 单段范围最长天数，防止写错一个年份展开成几千天

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };
const validYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && ymd(parseYmd(s)) === s;

/**
 * 解析日期清单。支持逗号 / 分号 / 换行 / 空格分隔；每项是单个日期，或 起~止 的范围（也可以用 – 或 至）。
 * @returns {{dates:Set<string>, errors:string[]}}
 */
function parseDateList(text) {
  const dates = new Set();
  const errors = [];
  for (const raw of String(text || '').split(/[,，;；\n\s]+/).map(x => x.trim()).filter(Boolean)) {
    const m = raw.match(/^(\d{4}-\d{1,2}-\d{1,2})(?:[~～–—至-]{1,2}|到)(\d{4}-\d{1,2}-\d{1,2})$/);
    const norm = (s) => s.replace(/^(\d{4})-(\d{1,2})-(\d{1,2})$/, (_, y, mo, d) => `${y}-${pad(mo)}-${pad(d)}`);
    if (m) {
      const a = norm(m[1]), b = norm(m[2]);
      if (!validYmd(a) || !validYmd(b) || a > b) { errors.push(raw); continue; }
      let n = 0;
      for (let d = parseYmd(a); ymd(d) <= b; d.setDate(d.getDate() + 1)) { dates.add(ymd(d)); if (++n > MAX_RANGE_DAYS) break; }
      if (n > MAX_RANGE_DAYS) errors.push(`${raw}（范围超过 ${MAX_RANGE_DAYS} 天）`);
      continue;
    }
    const one = norm(raw);
    if (validYmd(one)) dates.add(one); else errors.push(raw);
  }
  return { dates, errors };
}

let cacheKey = null, cacheVal = null;
function sets() {
  const w = config.workCalendar || {};
  const key = `${w.holidays || ''}|${w.makeup || ''}`;
  if (key !== cacheKey) {
    cacheKey = key;
    cacheVal = { holidays: parseDateList(w.holidays).dates, makeup: parseDateList(w.makeup).dates };
  }
  return cacheVal;
}

/** 'work' 普通工作日 | 'weekend' 周末 | 'holiday' 节假日 | 'makeup' 调休上班的周末 */
function dayKind(s) {
  const { holidays, makeup } = sets();
  const wd = parseYmd(s).getDay();
  const weekend = wd === 0 || wd === 6;
  if (makeup.has(s)) return 'makeup';
  if (holidays.has(s)) return 'holiday';
  return weekend ? 'weekend' : 'work';
}

/** 这天不用上班吗（周末 / 节假日；调休上班的周末不算） */
const isRestDay = (s) => { const k = dayKind(s); return k === 'weekend' || k === 'holiday'; };
const isWorkday = (s) => !isRestDay(s);
/** 今天（本地时间）是休息日吗 */
const isRestToday = (now = new Date()) => isRestDay(ymd(now));
const restReason = (s) => (dayKind(s) === 'holiday' ? '节假日' : '周末');

export { parseDateList, dayKind, isRestDay, isRestToday, isWorkday, restReason };
