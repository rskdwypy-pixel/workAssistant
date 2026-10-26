/**
 * 工作负载（右上角柱状图标）：未来两周里，我名下未完成任务的剩余工时按截止日摊开，回答「这些截止日我来得及吗」。
 *
 * 看的是累计：到某天为止必须做完的工时（已逾期的算今天就要做）对比到那天为止的可用工时（工作日数 × 每日标准工时）。
 * 累计超出就标「来不及」并写出差多少。后端见 src/services/workload.js。
 * 依赖 newtab.js 里的全局（调用时才访问）：API_BASE_URL、openInZentao。
 */
const WorkloadPanel = {
  open: false,
  data: null,
  WEEK: ['日', '一', '二', '三', '四', '五', '六'],

  base() {
    return typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : 'http://127.0.0.1:3721';
  },
  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },
  h(n) {
    return `${Math.round((Number(n) || 0) * 10) / 10}h`;
  },

  init() {
    document.getElementById('workloadBtn')?.addEventListener('click', () => this.toggle());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.open) this.close(); });
  },

  toggle() {
    if (this.open) this.close(); else this.show();
  },

  async show() {
    this.close();
    this.open = true;
    const overlay = document.createElement('div');
    overlay.className = 'wl-overlay';
    overlay.innerHTML = `
      <div class="wl-box" role="dialog" aria-modal="true" aria-label="工作负载">
        <div class="wl-head"><b>工作负载 · 未来两周</b><button type="button" class="wl-close" aria-label="关闭">×</button></div>
        <div class="wl-body"><div class="wl-hint">读取中…</div></div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) this.close(); });
    overlay.querySelector('.wl-close').addEventListener('click', () => this.close());
    overlay.addEventListener('click', (e) => this.onClick(e));
    try {
      const resp = await fetch(`${this.base()}/api/workload?days=14`);
      const json = await resp.json();
      if (!json.success) throw new Error(json.message || '读取失败');
      if (!this.open) return;
      this.data = json.data;
      this.render();
    } catch (err) {
      const body = document.querySelector('.wl-body');
      if (body) body.innerHTML = `<div class="wl-hint">读取失败：${this.esc(err.message)}</div>`;
    }
  },

  close() {
    document.querySelectorAll('.wl-overlay').forEach(o => o.remove());
    this.open = false;
  },

  taskRow(t) {
    return `<div class="wl-task" data-wl-open="${this.esc(t.id)}" role="button" tabindex="0" title="在禅道里打开">
        <span class="wl-task-title">${this.esc(t.title)}</span>
        <span class="wl-task-meta">${t.where ? this.esc(t.where) + ' · ' : ''}${t.deadline ? '截止 ' + this.esc(t.deadline.slice(5).replace('-', '/')) + ' · ' : ''}剩 ${this.h(t.left)}</span>
        <span class="wl-task-id">#${this.esc(t.id)}</span>
      </div>`;
  },

  render() {
    const d = this.data;
    const body = document.querySelector('.wl-body');
    if (!d || !body) return;
    const s = d.summary;
    const chips = [
      `<span class="wl-chip">未完成 <b>${s.openTasks}</b> 个 · 剩余 <b>${this.h(s.totalLeft)}</b></span>`,
      s.overdueCount ? `<span class="wl-chip is-bad">已逾期 <b>${s.overdueCount}</b> 个 · ${this.h(s.overdueHours)}</span>` : '',
      s.noDeadlineCount ? `<span class="wl-chip">没设截止日 <b>${s.noDeadlineCount}</b> 个 · ${this.h(s.noDeadlineHours)}</span>` : '',
      `<span class="wl-chip">每天按 <b>${this.h(d.workHours)}</b> 算</span>`
    ].join('');
    const verdict = s.firstShortDate
      ? `<div class="wl-verdict is-bad">⚠ 到 <b>${this.esc(s.firstShortDate.slice(5).replace('-', '/'))}</b> 为止来不及：累计要做的比可用的多 <b>${this.h(s.maxShort)}</b>。可以把一部分转给别人、延后截止日，或者加班。</div>`
      : s.openTasks && (s.overdueCount || d.rows.some(r => r.tasks.length))
        ? '<div class="wl-verdict is-ok">✓ 按现在的截止日，未来两周的工时来得及。</div>'
        : '';
    const hasDeadline = s.overdueCount || d.rows.some(r => r.tasks.length) || s.laterCount;
    const overdue = d.overdue.length ? `
      <div class="wl-section">已逾期（${d.overdue.length}）· 今天就得做</div>
      ${d.overdue.map(t => this.taskRow(t)).join('')}` : '';
    const rows = d.rows.map((r, i) => {
      const cls = !r.workday ? 'is-rest' : r.short ? 'is-short' : '';
      const used = r.cumCapacity > 0 ? Math.min(100, Math.round((r.cumNeeded / r.cumCapacity) * 100)) : (r.cumNeeded > 0 ? 100 : 0);
      const label = `${r.date.slice(5).replace('-', '/')} 周${this.WEEK[r.weekday]}${i === 0 ? '（今天）' : ''}`;
      return `<div class="wl-day ${cls}">
          <div class="wl-day-main" ${r.tasks.length ? `data-wl-toggle="${this.esc(r.date)}" role="button" tabindex="0"` : ''}>
            <span class="wl-day-label">${this.esc(label)}${r.workday ? '' : ' <i>休</i>'}</span>
            <span class="wl-bar" title="累计要做 ${this.h(r.cumNeeded)} / 累计可用 ${this.h(r.cumCapacity)}"><span class="wl-bar-fill ${r.short ? 'is-short' : ''}" style="width:${used}%"></span></span>
            <span class="wl-day-due">${r.tasks.length ? `${r.tasks.length} 个截止 · ${this.h(r.dueHours)}` : ''}</span>
            <span class="wl-day-cum">${r.workday || r.cumNeeded ? `${this.h(r.cumNeeded)} / ${this.h(r.cumCapacity)}` : ''}${r.short ? ` <b class="wl-short">差 ${this.h(r.short)}</b>` : ''}</span>
          </div>
          ${r.tasks.length ? `<div class="wl-day-tasks" data-wl-tasks="${this.esc(r.date)}" hidden>${r.tasks.map(t => this.taskRow(t)).join('')}</div>` : ''}
        </div>`;
    }).join('');
    const noDl = d.noDeadline.length ? `
      <details class="wl-fold"><summary>没设截止日的任务（${d.noDeadline.length} 个 · ${this.h(s.noDeadlineHours)}）</summary>${d.noDeadline.map(t => this.taskRow(t)).join('')}</details>` : '';
    const later = d.later.length ? `
      <details class="wl-fold"><summary>两周以后截止（${d.later.length} 个 · ${this.h(s.laterHours)}）</summary>${d.later.map(t => this.taskRow(t)).join('')}</details>` : '';
    body.innerHTML = `
      <div class="wl-chips">${chips}</div>
      ${verdict}
      ${hasDeadline ? '' : '<div class="wl-hint">你的任务都没设截止日（或剩余工时为 0），没法判断来不来得及。给任务设上截止日和预计工时后，这里就会告诉你哪天开始排不下。</div>'}
      ${overdue}
      <div class="wl-section">未来两周 <small>（每行右侧：累计要做 / 累计可用）</small></div>
      <div class="wl-days">${rows}</div>
      ${later}${noDl}`;
  },

  onClick(e) {
    const t = e.target.closest('[data-wl-open]');
    if (t) { if (typeof openInZentao === 'function') openInZentao('task', t.dataset.wlOpen); return; }
    const tg = e.target.closest('[data-wl-toggle]');
    if (tg) {
      const box = document.querySelector(`[data-wl-tasks="${tg.dataset.wlToggle}"]`);
      if (box) box.hidden = !box.hidden;
    }
  }
};

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => WorkloadPanel.init());
  else WorkloadPanel.init();
}
