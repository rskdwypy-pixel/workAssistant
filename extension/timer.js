/**
 * 工时计时器（右上角 ⏱）：开始 → 干活 → 停止时自动算出消耗工时，填个工作内容就记进禅道。
 *
 *   · 点 ⏱ 选一个任务开始计时；计时中右上角显示「⏱ 00:23:11 任务名」，点它停止
 *   · 计时状态存在后端（data/timer.json），不放浏览器：关页面、换浏览器、清浏览器数据都不丢；多个标签页每 30 秒 / 切回来时同步
 *   · 停止时弹出表单：消耗（按计时算，四舍五入到 0.1 小时，至少 0.1）、剩余（按任务当前剩余减去这次消耗）、日期（开始计时那天）、工作内容
 *   · 记工时走和工作日历一样的接口（EffortApi.add）：剩余填 0 会让禅道把任务标成已完成，先确认
 *
 * 依赖：EffortApi（efforts.js）、Toast、Confirm（调用时才访问）；任务详情里也能点“开始计时”。
 */
const WorkTimer = {
  tick: null,
  nowMs: () => Date.now(),   // 本机时钟（测试里可替换）
  now() { return this.nowMs() + this.skew; },

  // ---------- 纯计算（单测用）----------
  /** 毫秒 → 00:23:11 */
  format(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const p = (n) => String(n).padStart(2, '0');
    return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
  },
  /** 毫秒 → 小时，四舍五入到 0.1，至少 0.1，最多 24 */
  hours(ms) {
    return Math.min(24, Math.max(0.1, Math.round((ms / 3600000) * 10) / 10));
  },
  /** 剩余工时的建议值：当前剩余 − 这次消耗，不小于 0，保留 1 位小数 */
  suggestLeft(left, consumed) {
    return Math.max(0, Math.round(((Number(left) || 0) - consumed) * 10) / 10);
  },
  ymd(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },

  // ---------- 状态（真身在后端 data/timer.json，这里只留一份内存副本）----------
  timer: null,        // { taskId, name, startedAt }
  skew: 0,            // 后端时间 − 本机时间（毫秒），用来校准“已计时多久”
  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },
  toast(kind, msg) {
    if (typeof Toast !== 'undefined' && Toast[kind]) Toast[kind](msg);
  },
  base() {
    return typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : 'http://127.0.0.1:3721';
  },
  async api(path, body) {
    const init = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const resp = await fetch(`${this.base()}${path}`, init);
    return resp.json();
  },
  /** 把后端给的计时状态收进内存 */
  take(data) {
    if (!data) return;
    this.timer = data.timer || null;
    if (data.now) this.skew = data.now - this.nowMs();
  },
  current() {
    return this.timer;
  },
  elapsed() {
    const c = this.current();
    return c ? this.now() - c.startedAt : 0;
  },
  /** 从后端读一次（打开页面、切回来、定时） */
  async refresh() {
    try {
      const r = await this.api('/api/timer');
      if (r.success) this.take(r.data);
    } catch { /* 连不上后台：保持现状 */ }
    this.render();
  },

  async start(task) {
    if (this.current()) { this.toast('warning', '已经有一个任务在计时了，请先停止'); return false; }
    try {
      const r = await this.api('/api/timer/start', { taskId: String(task.id), name: String(task.name || '') });
      this.take(r.data);
      if (!r.success) { this.render(); this.toast('warning', r.message || '没能开始计时'); return false; }
    } catch (err) {
      this.toast('error', `没能开始计时：${err.message}`);
      return false;
    }
    this.toast('success', `开始计时：${task.name || '#' + task.id}`);
    this.render();
    return true;
  },

  async cancel() {
    try { this.take((await this.api('/api/timer/clear', {})).data); } catch { this.timer = null; }
    this.timer = null;
    this.render();
  },

  // ---------- 界面 ----------
  init() {
    document.getElementById('timerBtn')?.addEventListener('click', (e) => { e.stopPropagation(); this.onBtn(); });
    document.getElementById('timerPill')?.addEventListener('click', (e) => { e.stopPropagation(); this.showStop(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.refresh(); });
    setInterval(() => this.refresh(), 30 * 1000);
    document.addEventListener('click', (e) => { if (this.pickerOpen && !e.target.closest('.timer-picker')) this.closePicker(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { this.closePicker(); } });
    this.refresh();
  },

  onBtn() {
    if (this.current()) return this.showStop();
    if (this.pickerOpen) this.closePicker(); else this.showPicker();
  },

  render() {
    const c = this.current();
    const btn = document.getElementById('timerBtn');
    const pill = document.getElementById('timerPill');
    clearInterval(this.tick);
    this.tick = null;
    if (btn) btn.hidden = !!c;
    if (!pill) return;
    pill.hidden = !c;
    if (c) {
      const draw = () => {
        const cur = this.current();
        if (!cur) return this.render();
        pill.innerHTML = `<span class="timer-dot" aria-hidden="true"></span><span class="timer-time">${this.format(this.elapsed())}</span><span class="timer-name">${this.esc(cur.name || '#' + cur.taskId)}</span>`;
        pill.title = `正在计时：${cur.name || '#' + cur.taskId}（点击停止并填工时）`;
      };
      draw();
      this.tick = setInterval(draw, 1000);
    }
  },

  // ----- 选任务开始 -----
  async showPicker() {
    this.closePicker();
    this.pickerOpen = true;
    const panel = document.createElement('div');
    panel.className = 'timer-picker';
    panel.innerHTML = `
      <div class="tp-head">选一个任务开始计时</div>
      <input class="tp-input" type="text" placeholder="筛选任务…" aria-label="筛选任务">
      <div class="tp-list"><div class="tp-empty">读取我的任务…</div></div>`;
    document.getElementById('accountArea')?.appendChild(panel);
    panel.addEventListener('click', (e) => e.stopPropagation());
    let tasks = [];
    const draw = () => {
      const q = panel.querySelector('.tp-input').value.trim().toLowerCase();
      const list = tasks.filter(t => !q || t.name.toLowerCase().includes(q) || t.execName.toLowerCase().includes(q) || t.id === q.replace('#', ''));
      panel.querySelector('.tp-list').innerHTML = list.length ? list.slice(0, 30).map(t => `
        <div class="tp-item" role="button" tabindex="0" data-tp-id="${this.esc(t.id)}">
          <span class="tp-name">${this.esc(t.name)}</span>
          <span class="tp-sub">${t.status === 'doing' ? '进行中 · ' : ''}${this.esc(t.execName)}${t.left ? ` · 剩 ${Math.round(t.left * 10) / 10}h` : ''}</span>
        </div>`).join('') : '<div class="tp-empty">没有可计时的任务（只有未开始 / 进行中 / 暂停的任务能记工时）</div>';
    };
    panel.querySelector('.tp-input').addEventListener('input', draw);
    const begin = (id) => {
      const t = tasks.find(x => x.id === id);
      if (!t) return;
      this.closePicker();
      this.start({ id: t.id, name: t.name });   // 失败的提示在 start 里
    };
    panel.querySelector('.tp-list').addEventListener('click', (e) => { const r = e.target.closest('[data-tp-id]'); if (r) begin(r.dataset.tpId); });
    panel.querySelector('.tp-list').addEventListener('keydown', (e) => { const r = e.target.closest('[data-tp-id]'); if (r && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); begin(r.dataset.tpId); } });
    setTimeout(() => panel.querySelector('.tp-input')?.focus(), 0);
    try {
      tasks = (await EffortApi.tasks()).data || [];
      this.tasksCache = tasks;
      if (this.pickerOpen) draw();
    } catch (err) {
      panel.querySelector('.tp-list').innerHTML = `<div class="tp-empty">读取失败：${this.esc(err.message)}</div>`;
    }
  },

  closePicker() {
    document.querySelectorAll('.timer-picker').forEach(p => p.remove());
    this.pickerOpen = false;
  },

  // ----- 停止并填工时 -----
  async showStop() {
    const c = this.current();
    if (!c) return;
    this.closePicker();
    document.querySelectorAll('.timer-overlay').forEach(o => o.remove());
    const ms = this.elapsed();
    const consumed = this.hours(ms);
    const day = this.ymd(c.startedAt);
    const warn = ms > 12 * 3600000 ? '计时已经超过 12 小时，可能忘了停止，请核对下面的消耗工时。'
      : ms < 60000 ? '计时不到 1 分钟，消耗工时按最小的 0.1 小时算。' : '';
    const overlay = document.createElement('div');
    overlay.className = 'timer-overlay';
    overlay.innerHTML = `
      <div class="timer-box" role="dialog" aria-modal="true" aria-label="停止计时并填工时">
        <h3>停止计时 · 记工时</h3>
        <div class="tm-task">${this.esc(c.name || '#' + c.taskId)} <span class="tm-muted">#${this.esc(c.taskId)}</span></div>
        <div class="tm-elapsed">本次计时 <b>${this.format(ms)}</b></div>
        ${warn ? `<div class="tm-warn">${this.esc(warn)}</div>` : ''}
        <div class="tm-grid">
          <label>日期<input type="date" name="date" value="${day}" max="${this.ymd(this.now())}"></label>
          <label>消耗（小时）<input type="number" name="consumed" step="0.1" min="0.1" max="24" value="${consumed}"></label>
          <label>剩余（小时）<input type="number" name="left" step="0.1" min="0" value="" placeholder="读取中…"></label>
        </div>
        <label class="tm-work">工作内容（会进日报）<textarea name="work" rows="3" maxlength="500" placeholder="这段时间做了什么"></textarea></label>
        <div class="tm-error" role="alert"></div>
        <div class="tm-actions">
          <button type="button" class="btn-secondary" data-tm="discard">放弃这次计时</button>
          <span class="tm-spacer"></span>
          <button type="button" class="btn-secondary" data-tm="back">继续计时</button>
          <button type="button" class="btn-primary" data-tm="save">记录工时</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const $ = (sel) => overlay.querySelector(sel);
    const field = (n) => overlay.querySelector(`[name="${n}"]`);
    // 剩余工时：按任务当前剩余减去这次消耗给个建议
    EffortApi.tasks().then((r) => {
      const t = (r.data || []).find(x => x.id === c.taskId);
      if (!field('left')) return;
      this.taskInfo = t || null;
      if (t) { field('left').value = this.suggestLeft(t.left, Number(field('consumed').value) || consumed); field('left').placeholder = ''; }
      else { field('left').placeholder = '请填写'; $('.tm-error').textContent = '这个任务现在不能记工时了（可能已完成 / 关闭 / 转给别人了），保存可能会失败。'; }
    }).catch(() => { if (field('left')) field('left').placeholder = '请填写'; });
    field('consumed').addEventListener('input', () => {
      if (this.taskInfo && !field('left').dataset.touched) field('left').value = this.suggestLeft(this.taskInfo.left, Number(field('consumed').value) || 0);
    });
    field('left').addEventListener('input', () => { field('left').dataset.touched = '1'; });
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-tm]');
      if (!act) return;
      if (act.dataset.tm === 'back') overlay.remove();
      else if (act.dataset.tm === 'discard') {
        const ok = typeof Confirm !== 'undefined' && Confirm.show ? await Confirm.show('放弃这次计时', '这段时间不会记进禅道。确定放弃吗？', '放弃', '取消', { danger: true }) : true;
        if (ok) { overlay.remove(); await this.cancel(); this.toast('info', '已放弃这次计时'); }
      } else if (act.dataset.tm === 'save') this.save(overlay, c);
    });
    setTimeout(() => field('work')?.focus(), 0);
  },

  async save(overlay, c) {
    const field = (n) => overlay.querySelector(`[name="${n}"]`);
    const err = (m) => { overlay.querySelector('.tm-error').textContent = m; };
    const date = field('date').value;
    const consumed = Number(field('consumed').value);
    const leftRaw = field('left').value;
    const work = field('work').value.trim();
    if (!date) return err('请选择日期');
    if (!(consumed > 0) || consumed > 24) return err('消耗工时应大于 0 且不超过 24 小时');
    if (leftRaw === '' || !(Number(leftRaw) >= 0)) return err('请填写剩余工时（填 0 表示这个任务做完了）');
    if (!work) return err('请写一下工作内容（它会进入日报）');
    err('');
    const btn = overlay.querySelector('[data-tm="save"]');
    btn.disabled = true; btn.textContent = '保存中…';
    const body = { taskId: c.taskId, date, consumed, left: Number(leftRaw), work };
    try {
      try {
        await EffortApi.add(body);
      } catch (e) {
        if (e.code !== 'CONFIRM_FINISH') throw e;
        // 剩余填 0：禅道会把任务标成已完成，先问一下
        const ok = typeof Confirm !== 'undefined' && Confirm.show ? await Confirm.show('任务将标记为已完成', '剩余工时填了 0，禅道会把这个任务标记为「已完成」。确认吗？', '完成任务', '再改改') : true;
        if (!ok) { btn.disabled = false; btn.textContent = '记录工时'; return; }
        await EffortApi.add({ ...body, finish: true });
      }
      overlay.remove();
      await this.cancel();
      this.toast('success', `已记录 ${consumed} 小时`);
      if (typeof ReportPage !== 'undefined' && ReportPage.rendered && typeof ReportPage.refresh === 'function') ReportPage.refresh();
    } catch (e) {
      err(e.message || '保存失败');
      btn.disabled = false; btn.textContent = '记录工时';
    }
  }
};

if (typeof window !== 'undefined') window.WorkTimer = WorkTimer;
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => WorkTimer.init());
  else WorkTimer.init();
}
