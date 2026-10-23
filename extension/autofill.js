/**
 * 工时自动补填的界面（调试模式下，工作日历里的「补」）。设计见 docs/AUTOFILL-PRD.md。
 *
 *   AutofillApi     后端 /api/efforts/autofill/* 的封装
 *   AutofillDialog  弹窗：生成方案 → 预览并逐条编辑 → 确认写入（后台进度）→ 结果与撤销
 *
 * 所有写入都要先预览、再确认；方案里的任务只能从当天的候选任务（进行中、当天已存在、剩余 > 0）里选。
 * 这里不存任何东西：方案、补填记录都在后端。
 */

const AutofillApi = {
  base() { return typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : 'http://127.0.0.1:3721'; },
  async request(path, init) {
    const resp = await fetch(`${this.base()}${path}`, init);
    const json = await resp.json().catch(() => ({ success: false, message: `HTTP ${resp.status}` }));
    if (!json.success) { const e = new Error(json.message || `HTTP ${resp.status}`); e.code = json.code; throw e; }
    return json;
  },
  post(path, body) { return this.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); },
  plan(body) { return this.post('/api/efforts/autofill/plan', body); },
  rewrite(body) { return this.post('/api/efforts/autofill/rewrite', body); },
  execute(body) { return this.post('/api/efforts/autofill/execute', body); },
  job(id) { return this.request(`/api/efforts/autofill/jobs/${encodeURIComponent(id)}`); },
  stop(id) { return this.post(`/api/efforts/autofill/jobs/${encodeURIComponent(id)}/stop`); },
  undo(batchId) { return this.post('/api/efforts/autofill/undo', { batchId }); }
};

const afEsc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
const afH = (n) => `${Math.round((Number(n) || 0) * 10) / 10}h`;
const AF_WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const afWeek = (date) => { const [y, m, d] = date.split('-').map(Number); return AF_WEEK[new Date(y, m - 1, d).getDay()]; };
const afMD = (date) => { const [, m, d] = date.split('-').map(Number); return `${m}月${d}日`; };
const afSleep = (ms) => new Promise(r => setTimeout(r, ms));

const AutofillDialog = {
  el: null,
  mode: 'day',        // 'day' | 'month'
  month: '',
  plan: null,         // {planId, standard, days:[{date, existing, gap, pool, entries, selected, open}], skipped, aiUsed, aiAvailable}
  state: 'idle',      // 'loading' | 'preview' | 'running' | 'done' | 'error'
  job: null,
  batchId: null,
  seed: 0,
  busy: false,
  message: '',

  ensureDom() {
    if (this.el) return this.el;
    const el = document.createElement('div');
    el.id = 'autofillDialog';
    el.className = 'af-overlay';
    el.hidden = true;
    el.innerHTML = `<div class="af-dialog" role="dialog" aria-modal="true" aria-labelledby="afTitle">
      <header class="af-head"><h3 id="afTitle"></h3><span class="af-sub" data-af-sub></span><button type="button" class="af-x" data-af="close" aria-label="关闭">×</button></header>
      <div class="af-body" data-af-body></div>
      <footer class="af-foot" data-af-foot></footer>
    </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => this.onClick(e));
    el.addEventListener('input', (e) => this.onInput(e));
    el.addEventListener('change', (e) => this.onInput(e));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.isOpen() && this.state !== 'running') this.close(); });
    this.el = el;
    return el;
  },

  isOpen() { return !!(this.el && !this.el.hidden); },
  close() {
    if (this.el) this.el.hidden = true;
    this._poll = false;
  },

  /* ───────────── 入口 ───────────── */

  async openDay(date) {
    this.mode = 'day'; this.month = date.slice(0, 7); this.seed = 0;
    await this.generate({ dates: [date] });
  },

  async openMonth(month) {
    this.mode = 'month'; this.month = month; this.seed = 0;
    await this.generate({ month });
  },

  async generate(body, { keepPlan = false } = {}) {
    this.ensureDom();
    this.el.hidden = false;
    this.state = 'loading'; this.message = '';
    this.render();
    try {
      const { data } = await AutofillApi.plan({ ...body, seed: this.seed, planId: keepPlan && this.plan ? this.plan.planId : undefined });
      if (keepPlan && this.plan) {
        // 单天重抽：并进现有方案
        for (const d of data.days) {
          const old = this.plan.days.find(x => x.date === d.date);
          Object.assign(old || {}, { ...d, selected: true, open: true });
          if (!old) this.plan.days.push({ ...d, selected: true, open: true });
        }
        this.plan.skipped = data.skipped.length ? [...(this.plan.skipped || []).filter(s => !data.skipped.some(x => x.date === s.date)), ...data.skipped] : this.plan.skipped;
        this.plan.days.sort((a, b) => a.date.localeCompare(b.date));
      } else {
        this.plan = { ...data, days: data.days.map((d, i) => ({ ...d, selected: true, open: this.mode === 'day' || i === 0 })) };
      }
      this.state = 'preview';
    } catch (err) {
      this.state = 'error'; this.message = err.message || '生成方案失败';
    }
    this.render();
  },

  /* ───────────── 渲染 ───────────── */

  render() {
    const el = this.ensureDom();
    const title = this.mode === 'day' && this.plan && this.plan.days[0]
      ? `补填工时 · ${afMD(this.plan.days[0].date)} ${afWeek(this.plan.days[0].date)}`
      : this.mode === 'month' ? `补填工时 · ${this.month.replace('-', '年')}月` : '补填工时';
    el.querySelector('#afTitle').textContent = title;
    const body = el.querySelector('[data-af-body]');
    const foot = el.querySelector('[data-af-foot]');
    const sub = el.querySelector('[data-af-sub]');
    sub.textContent = '';

    if (this.state === 'loading') {
      body.innerHTML = `<div class="af-center"><div class="af-spin"></div><p>正在生成方案…</p><span>从你真实的进行中任务里挑，并让 AI 结合任务写工作内容（几秒到几十秒）</span></div>`;
      foot.innerHTML = '';
      return;
    }
    if (this.state === 'error') {
      body.innerHTML = `<div class="af-center"><p class="af-err">${afEsc(this.message)}</p></div>`;
      foot.innerHTML = `<button type="button" class="btn-secondary" data-af="close">关闭</button>`;
      return;
    }
    if (this.state === 'running' || this.state === 'done') return this.renderRun(body, foot, sub);

    // 预览
    const p = this.plan;
    const days = p.days;
    const picked = days.filter(d => d.selected);
    const totalH = picked.reduce((n, d) => n + d.entries.reduce((m, e) => m + (Number(e.hours) || 0), 0), 0);
    const totalN = picked.reduce((n, d) => n + d.entries.length, 0);
    sub.textContent = days.length ? `${picked.length}/${days.length} 天 · ${totalN} 条 · 共 ${afH(totalH)}` : '';
    let html = '';
    if (!p.aiAvailable) html += `<div class="af-note">没有配置 AI：工作内容用了你以前写过的内容或任务名，可以逐条修改；到「设置 → AI」配置后能写得更贴合。</div>`;
    else if (days.length && !p.aiUsed) html += `<div class="af-note">AI 这次没有返回可用的内容，已改用模板，可以逐条修改或点「重写内容」重试。</div>`;
    const doneUsed = days.some(d => d.entries.some(e => e.taskStatus === 'done'));
    if (doneUsed) html += `<div class="af-note af-note-info">部分条目补在「已完成」的任务上：这些任务当时正在做，禅道允许补记工时，任务状态和完成日期不会变。</div>`;
    if (!days.length) {
      // 一天都补不了：原因直接摆出来（以前折叠在底下，只看到一句「没有可补的日子」）
      html += `<div class="af-center"><p>没有可补的日子</p></div>` + (p.skipped || []).map(s => `<div class="af-why"><b>${afEsc(s.date)}</b> ${afEsc(s.reason)}</div>`).join('');
    }
    html += days.map(d => this.dayHtml(d)).join('');
    if (days.length && p.skipped && p.skipped.length) {
      html += `<details class="af-skipped"><summary>跳过的 ${p.skipped.length} 天（点开看原因）</summary>${p.skipped.map(s => `<div><b>${afEsc(s.date)}</b> ${afEsc(s.reason)}</div>`).join('')}</details>`;
    }
    body.innerHTML = html;
    foot.innerHTML = `${this.mode === 'month' ? `<button type="button" class="btn-secondary" data-af="reroll-all" title="整月重新抽">整月换一批</button>` : ''}
      <span class="af-spacer"></span>
      <button type="button" class="btn-secondary" data-af="close">取消</button>
      <button type="button" class="btn-primary" data-af="confirm" ${totalN ? '' : 'disabled'}>确认写入${this.mode === 'month' ? `所选 ${picked.length} 天` : ''}</button>`;
  },

  dayHtml(d) {
    const sum = d.entries.reduce((n, e) => n + (Number(e.hours) || 0), 0);
    const diff = Math.round((d.gap - sum) * 10) / 10;
    const summary = d.entries.map(e => `${afEsc(e.taskName || (d.pool.find(t => t.id === e.taskId) || {}).name || e.taskId)} ${afH(e.hours)}`).join(' ｜ ');
    const cls = diff === 0 ? 'is-ok' : diff > 0 ? 'is-less' : 'is-more';
    const tip = diff === 0 ? '正好补满' : diff > 0 ? `还差 ${afH(diff)}` : `超出 ${afH(-diff)}`;
    return `<section class="af-day${d.open ? ' is-open' : ''}" data-date="${afEsc(d.date)}">
      <div class="af-day-head">
        ${this.mode === 'month' ? `<input type="checkbox" data-af="pick" ${d.selected ? 'checked' : ''} aria-label="选中这一天" />` : ''}
        <button type="button" class="af-day-toggle" data-af="toggle"><b>${afMD(d.date)} ${afWeek(d.date)}</b>
          <span class="af-day-meta">已填 ${afH(d.existing)} → 补 ${afH(d.gap)}</span>
          <span class="af-day-sum">${d.open ? '' : summary}</span></button>
        <span class="af-day-tip ${cls}" data-af-tip>${tip}</span>
      </div>
      ${d.open ? `<div class="af-day-body">
        ${d.entries.map((e, i) => this.entryHtml(d, e, i)).join('')}
        <div class="af-day-ops">
          <button type="button" class="af-link" data-af="add">＋ 添加一条</button>
          <button type="button" class="af-link" data-af="reroll-day">换一批任务</button>
          <button type="button" class="af-link" data-af="rewrite-day">重写内容</button>
        </div>
      </div>` : ''}
    </section>`;
  },

  entryHtml(d, e, i) {
    return `<div class="af-entry" data-i="${i}">
      <select data-af-field="taskId" aria-label="任务">${d.pool.map(t => `<option value="${afEsc(t.id)}"${t.id === e.taskId ? ' selected' : ''}>${afEsc(t.name)}${t.execName ? ` · ${afEsc(t.execName)}` : ''}${t.status === 'done' ? ' · 已完成' : ''}</option>`).join('')}</select>
      <input type="number" data-af-field="hours" min="0.5" max="24" step="0.5" value="${afEsc(e.hours)}" aria-label="小时" />
      <button type="button" class="af-del" data-af="del" title="删掉这一条" aria-label="删除">✕</button>
      <textarea data-af-field="work" rows="2" aria-label="工作内容">${afEsc(e.work)}</textarea>
      <span class="af-src ${e.source === 'ai' ? 'is-ai' : 'is-tpl'}">${e.source === 'ai' ? 'AI 撰写' : e.source === 'edited' ? '已手改' : '模板内容'}</span>
    </div>`;
  },

  renderRun(body, foot, sub) {
    const j = this.job || { total: 0, done: 0, written: 0, hours: 0, results: [], state: 'running' };
    const pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
    const failed = j.results.filter(r => r.status === 'failed');
    const skipped = j.results.filter(r => r.status === 'skipped');
    sub.textContent = this.state === 'running' ? `写入中 ${j.done}/${j.total}` : '';
    let html = `<div class="af-progress"><span style="width:${pct}%"></span></div>`;
    if (this.state === 'running') {
      html += `<p class="af-run">正在逐条写入禅道…已写入 ${j.written} 条 · ${afH(j.hours)}（${j.done}/${j.total}）</p>`;
    } else {
      const label = j.state === 'stopped' ? '已停止' : j.state === 'aborted' ? '已中止' : '写入完成';
      html += `<p class="af-run ${failed.length ? 'has-fail' : 'is-ok'}"><b>${label}</b>：成功 ${j.written} 条（${afH(j.hours)}）${skipped.length ? `，跳过 ${skipped.length} 条` : ''}${failed.length ? `，失败 ${failed.length} 条` : ''}</p>`;
      if (j.message) html += `<div class="af-note">${afEsc(j.message)}</div>`;
    }
    if (failed.length || skipped.length) {
      html += `<div class="af-results">${[...failed, ...skipped].map(r => `<div class="af-res ${r.status}"><b>${afEsc(r.date)}</b> ${afEsc(r.taskName || r.taskId)} ${afH(r.hours)} — ${afEsc(r.error || '')}</div>`).join('')}</div>`;
    }
    if (this.undoResult) {
      const u = this.undoResult;
      html += `<div class="af-note">已撤销 ${u.undone} 条${u.kept.length ? `；${u.kept.length} 条没删（${afEsc(u.kept.map(k => k.reason).filter((x, i, a) => a.indexOf(x) === i).join('；'))}）` : ''}${u.failed.length ? `；${u.failed.length} 条撤销失败：${afEsc(u.failed[0].reason)}` : ''}</div>`;
    }
    body.innerHTML = html;
    if (this.state === 'running') {
      foot.innerHTML = `<span class="af-spacer"></span><button type="button" class="btn-secondary" data-af="stop">停止</button>`;
    } else {
      foot.innerHTML = `${j.written && !this.undoResult ? `<button type="button" class="btn-secondary af-danger" data-af="undo">撤销本次补填</button>` : ''}
        ${failed.length ? `<button type="button" class="btn-secondary" data-af="retry">重试失败项</button>` : ''}
        <span class="af-spacer"></span><button type="button" class="btn-primary" data-af="close">完成</button>`;
    }
  },

  /* ───────────── 交互 ───────────── */

  dayOf(target) {
    const sec = target.closest && target.closest('.af-day');
    return sec ? this.plan.days.find(d => d.date === sec.dataset.date) : null;
  },

  /** 只更新这一天的合计提示和顶部合计，不重绘（重绘会让输入框丢焦点） */
  refreshTotals(d, sec) {
    const sum = d.entries.reduce((n, e) => n + (Number(e.hours) || 0), 0);
    const diff = Math.round((d.gap - sum) * 10) / 10;
    const tip = sec.querySelector('[data-af-tip]');
    tip.textContent = diff === 0 ? '正好补满' : diff > 0 ? `还差 ${afH(diff)}` : `超出 ${afH(-diff)}`;
    tip.className = `af-day-tip ${diff === 0 ? 'is-ok' : diff > 0 ? 'is-less' : 'is-more'}`;
    const picked = this.plan.days.filter(x => x.selected);
    const totalH = picked.reduce((n, x) => n + x.entries.reduce((m, e) => m + (Number(e.hours) || 0), 0), 0);
    const totalN = picked.reduce((n, x) => n + x.entries.length, 0);
    this.el.querySelector('[data-af-sub]').textContent = `${picked.length}/${this.plan.days.length} 天 · ${totalN} 条 · 共 ${afH(totalH)}`;
    const btn = this.el.querySelector('[data-af="confirm"]');
    if (btn) { btn.disabled = !totalN; if (this.mode === 'month') btn.textContent = `确认写入所选 ${picked.length} 天`; }
  },

  onInput(e) {
    if (this.state !== 'preview') return;
    const t = e.target;
    const field = t.dataset && t.dataset.afField;
    const d = this.dayOf(t);
    if (!field || !d) return;
    const row = t.closest('.af-entry');
    const entry = d.entries[Number(row.dataset.i)];
    if (!entry) return;
    if (field === 'hours') entry.hours = Number(t.value) || 0;
    else if (field === 'work') { entry.work = t.value; entry.source = 'edited'; row.querySelector('.af-src').textContent = '已手改'; row.querySelector('.af-src').className = 'af-src is-tpl'; }
    else if (field === 'taskId') {
      if (d.entries.some((x, i) => i !== Number(row.dataset.i) && x.taskId === t.value)) {   // 同一天同一个任务只能出现一次
        t.value = entry.taskId;
        if (typeof Toast !== 'undefined') Toast.warning('这一天已经有这个任务了');
        return;
      }
      const tk = d.pool.find(x => x.id === t.value);
      entry.taskId = t.value; entry.taskName = tk ? tk.name : ''; entry.execName = tk ? tk.execName : ''; entry.taskStatus = tk ? tk.status : '';
    }
    this.refreshTotals(d, t.closest('.af-day'));
  },

  async onClick(e) {
    const btn = e.target.closest('[data-af]');
    if (e.target === this.el && this.state !== 'running') return this.close();
    if (!btn) return;
    const act = btn.dataset.af;
    if (act === 'close') return this.close();
    if (this.busy && act !== 'stop') return;
    const d = this.state === 'preview' ? this.dayOf(btn) : null;
    if (act === 'toggle' && d) { d.open = !d.open; return this.render(); }
    if (act === 'pick' && d) { d.selected = btn.checked; return this.refreshTotals(d, btn.closest('.af-day')); }
    if (act === 'del' && d) { d.entries.splice(Number(btn.closest('.af-entry').dataset.i), 1); return this.render(); }
    if (act === 'add' && d) {
      const used = new Set(d.entries.map(x => x.taskId));
      const next = d.pool.find(t => !used.has(t.id));
      if (!next) { if (typeof Toast !== 'undefined') Toast.info('候选任务都用上了'); return; }
      d.entries.push({ taskId: next.id, taskName: next.name, execName: next.execName, hours: Math.max(0.5, Math.min(1, Math.round((d.gap - d.entries.reduce((n, x) => n + Number(x.hours), 0)) * 2) / 2) || 1), work: `推进「${next.name}」相关工作`, source: 'edited' });
      return this.render();
    }
    if (act === 'rewrite-day' && d) return this.rewriteDay(d);
    if (act === 'reroll-day' && d) { this.seed = Date.now(); return this.generate({ dates: [d.date] }, { keepPlan: true }); }
    if (act === 'reroll-all') { this.seed = Date.now(); return this.generate(this.mode === 'day' ? { dates: [this.plan.days[0].date] } : { month: this.month }); }
    if (act === 'confirm') return this.confirm();
    if (act === 'stop') { if (this.job) AutofillApi.stop(this.job.id).catch(() => { }); return; }
    if (act === 'undo') return this.undo();
    if (act === 'retry') return this.retryFailed();
  },

  async rewriteDay(d) {
    this.busy = true;
    const sec = this.el.querySelector(`.af-day[data-date="${d.date}"]`);
    const btn = sec && sec.querySelector('[data-af="rewrite-day"]');
    if (btn) { btn.textContent = '正在重写…'; }
    try {
      const { data } = await AutofillApi.rewrite({ planId: this.plan.planId, date: d.date, seed: Date.now(), entries: d.entries.map(e => ({ taskId: e.taskId, hours: e.hours })) });
      data.forEach((w, i) => { if (d.entries[i]) { d.entries[i].work = w.work; d.entries[i].source = w.source; } });
    } catch (err) {
      if (typeof Toast !== 'undefined') Toast.error(`重写失败：${err.message}`);
    } finally {
      this.busy = false;
      this.render();
    }
  },

  /** 把当前预览里选中的天 / 条整理成要提交的内容；有问题就提示并返回 null */
  collect() {
    const days = [];
    for (const d of this.plan.days.filter(x => x.selected)) {
      const entries = d.entries.map(e => ({ taskId: e.taskId, hours: Number(e.hours), work: String(e.work || '').trim() }));
      for (const e of entries) {
        if (!(e.hours >= 0.5) || Math.round(e.hours * 2) !== e.hours * 2) { this.warn(`${afMD(d.date)} 的小时数要是 0.5 的倍数`); return null; }
        if (!e.work) { this.warn(`${afMD(d.date)} 有一条没写工作内容`); return null; }
      }
      if (entries.length) days.push({ date: d.date, entries });
    }
    if (!days.length) { this.warn('没有要写入的内容'); return null; }
    return days;
  },

  warn(msg) { if (typeof Toast !== 'undefined') Toast.warning(msg); },

  async confirm() {
    const days = this.collect();
    if (!days) return;
    this.busy = true;
    try {
      const { data } = await AutofillApi.execute({ planId: this.plan.planId, days });
      this.batchId = data.batchId; this.undoResult = null;
      this.state = 'running'; this.job = { id: data.jobId, total: data.total, done: 0, written: 0, hours: 0, results: [], state: 'running' };
      this.busy = false;
      this.render();
      await this.poll();
    } catch (err) {
      this.busy = false;
      if (typeof Toast !== 'undefined') Toast.error(err.message || '写入失败');
    }
  },

  async poll() {
    this._poll = true;
    while (this._poll) {
      try {
        const { data } = await AutofillApi.job(this.job.id);
        this.job = data;
        if (data.state !== 'running') break;
        this.render();
      } catch (err) {
        this.job.state = 'aborted'; this.job.message = `查询进度失败：${err.message}（后端可能重启过，已写入的可在禅道里确认）`;
        break;
      }
      await afSleep(this.pollMs || 700);
    }
    this._poll = false;
    this.state = 'done';
    this.render();
    if (typeof ReportPage !== 'undefined') ReportPage.reloadEfforts();
    if (typeof Toast !== 'undefined' && this.job.written) Toast.success(`已补填 ${this.job.written} 条（${afH(this.job.hours)}）`);
  },

  async retryFailed() {
    const failed = this.job.results.filter(r => r.status === 'failed');
    const byDate = new Map();
    for (const r of failed) { if (!byDate.has(r.date)) byDate.set(r.date, []); byDate.get(r.date).push({ taskId: r.taskId, hours: r.hours, work: r.work }); }
    const days = [...byDate].map(([date, entries]) => ({ date, entries }));
    this.busy = true;
    try {
      const { data } = await AutofillApi.execute({ planId: this.plan.planId, days });
      this.batchId = data.batchId; this.undoResult = null;
      this.state = 'running'; this.job = { id: data.jobId, total: data.total, done: 0, written: 0, hours: 0, results: [], state: 'running' };
      this.busy = false;
      this.render();
      await this.poll();
    } catch (err) {
      this.busy = false;
      if (typeof Toast !== 'undefined') Toast.error(err.message || '重试失败');
    }
  },

  async undo() {
    const ok = typeof Confirm !== 'undefined'
      ? await Confirm.show('撤销本次补填', `会删除这一批写入的 ${this.job.written} 条工时（${afH(this.job.hours)}）。只删仍然存在、且没被改过的。`, '撤销', '取消', { danger: true })
      : true;
    if (!ok) return;
    this.busy = true;
    try {
      const { data } = await AutofillApi.undo(this.job.batchId || this.batchId);
      this.undoResult = data;
      if (typeof ReportPage !== 'undefined') ReportPage.reloadEfforts();
      if (typeof Toast !== 'undefined') Toast.success(`已撤销 ${data.undone} 条`);
    } catch (err) {
      if (typeof Toast !== 'undefined') Toast.error(`撤销失败：${err.message}`);
    } finally {
      this.busy = false;
      this.render();
    }
  }
};

if (typeof window !== 'undefined') {
  window.AutofillApi = AutofillApi;
  window.AutofillDialog = AutofillDialog;
}
