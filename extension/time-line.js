/**
 * 创建 / 修改时间的显示（任务、Bug、需求的卡片和详情共用）。
 * 时间来自禅道（"YYYY-MM-DD HH:mm:ss"，禅道所在时区的本地时间，不做时区换算）；没有的就不显示。
 */

/** "2026-10-23 14:30:05" → 今年 "10-23 14:30"，往年 "2025-10-23 14:30"；不认识的格式返回空 */
function fmtZentaoTime(s, now = new Date()) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m || m[1] === '0000') return '';
  return `${Number(m[1]) === now.getFullYear() ? '' : m[1] + '-'}${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
}

/** 一行小字：创建 10-21 14:30 · 修改 10-23 09:12（修改和创建是同一刻或更早就不重复显示）。两个都没有返回空字符串 */
function timesLineHTML(created, edited) {
  const esc = (v) => (typeof escapeHtml === 'function' ? escapeHtml(v) : String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const c = fmtZentaoTime(created);
  const e = String(edited || '') > String(created || '') ? fmtZentaoTime(edited) : '';
  if (!c && !e) return '';
  const full = [created && `创建于 ${String(created).slice(0, 19)}`, e && `最后修改 ${String(edited).slice(0, 19)}`].filter(Boolean).join('；');
  return `<div class="times-line" title="${esc(full)}">${[c && `创建 ${esc(c)}`, e && `修改 ${esc(e)}`].filter(Boolean).join(' · ')}</div>`;
}

/** 任务 / Bug 记录该显示哪两个时间：已关联禅道的用禅道的创建 / 修改时间；本地独有的用本地记录时间 */
function recordTimes(rec) {
  if (rec.zentaoId) return [rec.openedAt || '', rec.editedAt || ''];
  const iso = (v) => { const d = v ? new Date(v) : null; if (!d || isNaN(d)) return ''; const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00`; };
  return [iso(rec.createdAt), iso(rec.updatedAt)];
}

if (typeof window !== 'undefined') Object.assign(window, { fmtZentaoTime, timesLineHTML, recordTimes });
