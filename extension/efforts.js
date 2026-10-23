/**
 * 工作日历里的工时：后端接口封装 + 「日抽屉」（点日历里的某一天打开）
 *
 *   EffortApi     后端 /api/efforts 的封装
 *   EffortDrawer  某一天的工时明细 + 填报表单（日期固定为所点的这一天，所以补填过去 = 点过去的格子）
 *
 * 工时以禅道为准，这里不存任何东西：数据都来自后端（后端读禅道并做缓存）。
 * 每条工时可以修改 / 删除（只能动自己的）；剩余工时填 0 会让禅道把任务标成已完成，界面会先让你确认。
 */

const EffortApi = {
  base() { return typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : 'http://127.0.0.1:3721'; },
  async request(path, init) {
    const resp = await fetch(`${this.base()}${path}`, init);
    const json = await resp.json().catch(() => ({ success: false, message: `HTTP ${resp.status}` }));
    if (!json.success) { const e = new Error(json.message || `HTTP ${resp.status}`); e.code = json.code; throw e; }
    return json;
  },
  /** 返回整个响应：{data:{month,standard,me,days}, syncedAt, fromCache}；cacheOnly 时没有缓存 days 为 null */
  month(month, { cacheOnly = false } = {}) { return this.request(`/api/efforts?month=${encodeURIComponent(month)}${cacheOnly ? '&cache=only' : ''}`); },
  /** 全员这个月的工时：{data:{month,standard,members:[{account,name,hours,byDay}],days:{date:{total,byMember}}}}；第一次比较慢 */
  team(month, { cacheOnly = false } = {}) { return this.request(`/api/efforts/team?month=${encodeURIComponent(month)}${cacheOnly ? '&cache=only' : ''}`); },
  tasks() { return this.request('/api/efforts/tasks'); },
  add(body) { return this.request('/api/efforts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); },
  update(id, body) { return this.request(`/api/efforts/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); },
  remove(id, taskId) { return this.request(`/api/efforts/${encodeURIComponent(id)}?taskId=${encodeURIComponent(taskId)}`, { method: 'DELETE' }); }
};

const efEsc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
const efHours = (n) => `${(Math.round((Number(n) || 0) * 10) / 10).toString()}h`;
/** 表单字段（不用 form.字段名：各环境对表单命名属性的支持不一致，用选择器最稳） */
const efField = (f, name) => f.querySelector(`[name="${name}"]`);
const EF_WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const EffortDrawer = {
  date: null,
  tasks: null,        // 填报下拉的任务（打开时拉一次）
  leftTouched: false,
  editingId: null,    // 正在修改的那条工时的 id
  busy: false,

  ensureDom() {
    let el = document.getElementById('effortDrawer');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'effortDrawer';
    el.className = 'report-drawer-mask';
    el.innerHTML = `
      <div class="report-drawer effort-drawer" role="dialog" aria-modal="true" aria-labelledby="effortDrawerTitle">
        <header class="report-drawer-head">
          <div>
            <div class="report-drawer-title"><span class="report-kind is-daily">工时</span><h3 id="effortDrawerTitle"></h3></div>
            <div class="report-drawer-meta" data-eff-meta></div>
          </div>
          <div class="report-drawer-actions"><button type="button" class="btn-secondary" data-eff="report">📄 查看日报</button></div>
          <button type="button" class="report-close" data-eff="close" aria-label="关闭">×</button>
        </header>
        <div class="report-drawer-body" data-eff-body></div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => {
      if (e.target === el) return this.close();
      const act = e.target.closest('[data-eff]');
      if (!act) return;
      if (act.dataset.eff === 'close') this.close();
      else if (act.dataset.eff === 'report') { const d = this.date; this.close(); if (typeof ReportViewer !== 'undefined') ReportViewer.open('daily', d); }
      else if (act.dataset.eff === 'fill') this.fillRest();
      else if (act.dataset.eff === 'edit') { this.editingId = act.dataset.id; this.render(true); }
      else if (act.dataset.eff === 'edit-cancel') { this.editingId = null; this.render(true); }
      else if (act.dataset.eff === 'del') this.remove(act.dataset.id);
      else if (act.dataset.eff === 'open-task') { e.preventDefault(); if (typeof openInZentao === 'function') openInZentao('task', act.dataset.taskId); }
    });
    el.addEventListener('submit', (e) => {
      e.preventDefault();
      if (e.target.closest && e.target.closest('.effort-edit-form')) this.saveEdit(e.target.closest('.effort-edit-form'));
      else this.submit();
    });
    el.addEventListener('input', (e) => this.onInput(e));
    el.addEventListener('change', (e) => this.onInput(e));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && el.classList.contains('active')) this.close();
    });
    return el;
  },

  /** 这一天的工时数据（来自日历页已加载的那份） */
  dayData() {
    const e = typeof ReportPage !== 'undefined' ? ReportPage.efforts : null;
    const days = e && e.data && e.data.days;
    return { entry: (days && days[this.date]) || { hours: 0, items: [] }, standard: (e && e.data && e.data.standard) || 8, loaded: !!days };
  },

  async open(date) {
    const el = this.ensureDom();
    this.date = date;
    this.leftTouched = false;
    this.editingId = null;
    el.classList.add('active');
    const [y, m, d] = date.split('-').map(Number);
    el.querySelector('#effortDrawerTitle').textContent = `${m}月${d}日 ${EF_WEEKDAY[new Date(y, m - 1, d).getDay()]}`;
    this.render();
    if (typeof ReportPage !== 'undefined' && ReportPage.lens === 'team') return;
    if (!this.tasks) {
      try { this.tasks = (await EffortApi.tasks()).data || []; } catch (err) { this.tasks = []; this.tasksError = err.message; }
      if (this.date === date && el.classList.contains('active')) this.render(true);
    }
  },

  close() {
    const el = document.getElementById('effortDrawer');
    if (el) el.classList.remove('active');
  },

  isOpen() {
    const el = document.getElementById('effortDrawer');
    return !!(el && el.classList.contains('active'));
  },

  /** 全员视角：这一天每个人填了多少（只读，不提供代填） */
  renderTeam() {
    const el = this.ensureDom();
    const t = typeof ReportPage !== 'undefined' ? ReportPage.team : null;
    const td = t && t.data && t.data.days ? t.data : null;
    const std = (td && td.standard) || 8;
    const day = (td && td.days[this.date]) || { total: 0, byMember: {} };
    const members = td ? td.members : [];
    const filled = members.filter(m => (day.byMember[m.account] || 0) > 0).length;
    el.querySelector('[data-eff-meta]').textContent = td
      ? `团队共 ${efHours(day.total)} · ${filled}/${members.length} 人已填${members.length - filled > 0 ? ` · ${members.length - filled} 人未填` : ''}`
      : '全员工时读取中…（第一次会慢一点）';
    const rows = members.map(m => {
      const h = day.byMember[m.account] || 0;
      const pct = Math.min(100, Math.round((h / std) * 100));
      return `<div class="effort-member${h === 0 ? ' is-empty' : ''}">
        <span class="effort-member-name">${efEsc(m.name)}</span>
        <span class="effort-member-bar"><span class="${h >= std ? 'is-full' : h > 0 ? 'is-partial' : ''}" style="width:${pct}%"></span></span>
        <span class="effort-member-hours">${h > 0 ? efHours(h) : '未填'}</span>
      </div>`;
    }).join('');
    el.querySelector('[data-eff-body]').innerHTML = `<div class="effort-section-title">全员工时 <span class="story-count">${members.length}</span></div>
      <div class="effort-members">${rows || '<div class="effort-empty">读取中…</div>'}</div>
      <div class="effort-note">全员视角只读。要填自己的工时，切回「我的」再点这一天。</div>`;
  },

  /** @param {boolean} [keepForm] 只刷新任务下拉时保留已填的表单内容 */
  render(keepForm = false) {
    if (typeof ReportPage !== 'undefined' && ReportPage.lens === 'team') return this.renderTeam();
    const el = this.ensureDom();
    const { entry, standard, loaded } = this.dayData();
    // 「今天」以日历（后端）为准，与格子的未来 / 今天判断一致
    const now = new Date();
    const clientToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const todayStr = (typeof ReportPage !== 'undefined' && ReportPage.data && ReportPage.data.today) || clientToday;
    const future = this.date > todayStr;
    const gap = Math.max(0, Math.round((standard - entry.hours) * 10) / 10);
    el.querySelector('[data-eff-meta]').textContent = loaded
      ? `已填 ${efHours(entry.hours)} / ${efHours(standard)}${gap > 0 ? ` · 还差 ${efHours(gap)}` : (entry.hours > standard ? ` · 加班 ${efHours(entry.hours - standard)}` : ' · 已填满')}`
      : '工时读取中…';

    const pct = Math.min(100, Math.round((entry.hours / standard) * 100));
    let html = `<div class="effort-progress"><span class="${entry.hours >= standard ? 'is-full' : entry.hours > 0 ? 'is-partial' : ''}" style="width:${pct}%"></span></div>`;

    html += `<div class="effort-section-title">当天工时 <span class="story-count">${entry.items.length}</span></div>`;
    html += entry.items.length
      ? `<div class="effort-list">${entry.items.map(i => this.itemHtml(i, todayStr)).join('')}</div>`
      : `<div class="effort-empty">${loaded ? '这一天还没有填工时' : '读取中…'}</div>`;

    if (future) {
      html += `<div class="effort-note">还没到的日期不能填工时。</div>`;
    } else {
      html += this.formHtml(gap, keepForm);
    }
    const body = el.querySelector('[data-eff-body]');
    const prevScroll = body.scrollTop;
    // 保留表单里已输入的内容（任务下拉刚加载完时会重绘）
    const saved = keepForm ? this.readForm() : null;
    body.innerHTML = html;
    if (saved) this.writeForm(saved);
    body.scrollTop = keepForm ? prevScroll : 0;
  },

  /** 一条工时：看的样子 / 正在修改的样子 */
  itemHtml(i, todayStr) {
    if (this.editingId && this.editingId === i.effortId) {
      return `<form class="effort-item effort-edit-form" novalidate data-effort-id="${efEsc(i.effortId)}" data-task-id="${efEsc(i.taskId)}">
        <div class="effort-main">
          <div class="effort-task">${efEsc(i.taskName)}${i.execName ? `<em>${efEsc(i.execName)}</em>` : ''}</div>
          <div class="story-field-row">
            <label class="doc-field"><span class="doc-field-label">日期</span><input name="date" type="date" max="${efEsc(todayStr)}" value="${efEsc(this.date)}" /></label>
            <label class="doc-field"><span class="doc-field-label">消耗（小时）</span><input name="consumed" type="number" min="0.1" max="24" step="0.5" value="${efEsc(i.consumed)}" /></label>
            <label class="doc-field"><span class="doc-field-label">剩余（小时）</span><input name="left" type="number" min="0" step="0.5" value="${efEsc(i.left)}" /></label>
          </div>
          <label class="doc-field"><span class="doc-field-label">工作内容</span><textarea name="work" rows="2">${efEsc(i.work)}</textarea></label>
          <div class="doc-editor-err" data-eff-edit-err hidden></div>
          <div class="effort-actions"><button type="button" class="btn-secondary" data-eff="edit-cancel">取消</button><button type="submit" class="btn-primary">保存修改</button></div>
        </div>
      </form>`;
    }
    const canEdit = !!i.effortId;
    return `<div class="effort-item">
      <span class="effort-hours">${efHours(i.consumed)}</span>
      <div class="effort-main">
        <div class="effort-task">${i.taskId ? `<a href="#" class="effort-task-id" data-eff="open-task" data-task-id="${efEsc(i.taskId)}" title="在禅道打开任务 #${efEsc(i.taskId)}">#${efEsc(i.taskId)}</a> ` : ''}${efEsc(i.taskName)}${i.execName ? `<em>${efEsc(i.execName)}</em>` : ''}</div>
        <div class="effort-work">${efEsc(i.work || '（没写工作内容）')}</div>
      </div>
      ${canEdit ? `<span class="effort-ops"><button type="button" data-eff="edit" data-id="${efEsc(i.effortId)}" title="修改">✎</button><button type="button" data-eff="del" data-id="${efEsc(i.effortId)}" title="删除">🗑</button></span>` : ''}
    </div>`;
  },

  /** 调写接口；剩余填 0 会让禅道把任务标成已完成，后端要求明确确认，这里弹确认后带 finish 重发 */
  async sendWithFinishConfirm(fn) {
    try {
      return await fn(false);
    } catch (err) {
      if (err && err.code === 'CONFIRM_FINISH') {
        const ok = typeof Confirm !== 'undefined'
          ? await Confirm.show('任务将标记为已完成', err.message, '确认完成', '取消')
          : true;
        if (!ok) { const e = new Error('已取消'); e.cancelled = true; throw e; }
        return fn(true);
      }
      throw err;
    }
  },

  /** 写完之后：刷新日历的工时、重画抽屉、任务下拉重新拉（剩余工时变了） */
  async afterWrite() {
    this.tasks = null;
    this.leftTouched = false;
    this.editingId = null;
    if (typeof ReportPage !== 'undefined') await ReportPage.refreshAfterWrite();
    this.render();
    EffortApi.tasks().then(r => { this.tasks = r.data || []; if (this.isOpen()) this.render(true); }).catch(() => {});
  },

  async saveEdit(form) {
    if (this.busy) return;
    const v = { date: efField(form, 'date').value, consumed: efField(form, 'consumed').value, left: efField(form, 'left').value, work: efField(form, 'work').value };
    const errEl = form.querySelector('[data-eff-edit-err]');
    const showErr = (m) => { errEl.textContent = m || ''; errEl.hidden = !m; };
    if (!(Number(v.consumed) > 0)) return showErr('请填写消耗工时');
    if (v.left === '') return showErr('请填写剩余工时（填 0 表示这个任务做完了）');
    if (!v.work.trim()) return showErr('请填写工作内容（它会进入日报）');
    this.busy = true;
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true; btn.textContent = '保存中…';
    showErr('');
    try {
      await this.sendWithFinishConfirm((finish) => EffortApi.update(form.dataset.effortId, {
        taskId: form.dataset.taskId, date: v.date || this.date, consumed: Number(v.consumed), left: Number(v.left), work: v.work.trim(), finish
      }));
      if (typeof Toast !== 'undefined') Toast.success('工时已修改');
      await this.afterWrite();
    } catch (err) {
      if (!err.cancelled) showErr(err.message || '保存失败');
      btn.disabled = false; btn.textContent = '保存修改';
    } finally {
      this.busy = false;
    }
  },

  async remove(effortId) {
    if (this.busy) return;
    const item = this.dayData().entry.items.find(i => i.effortId === String(effortId));
    if (!item) return;
    const ok = typeof Confirm !== 'undefined'
      ? await Confirm.show('删除工时', `确定删除这条工时（${efHours(item.consumed)} · ${item.taskName}）？删除后禅道里的记录也没了。`, '删除', '取消', { danger: true })
      : true;
    if (!ok) return;
    this.busy = true;
    try {
      await EffortApi.remove(item.effortId, item.taskId);
      if (typeof Toast !== 'undefined') Toast.success('工时已删除');
      await this.afterWrite();
    } catch (err) {
      if (typeof Toast !== 'undefined') Toast.error(`删除失败：${err.message}`);
    } finally {
      this.busy = false;
    }
  },

  formHtml(gap) {
    const tasks = this.tasks;
    const opts = tasks === null ? '<option value="">任务读取中…</option>'
      : tasks.length ? `<option value="">选择任务…</option>` + tasks.map(t => `<option value="${efEsc(t.id)}" data-left="${t.left}">${efEsc(t.name)}${t.execName ? ` · ${efEsc(t.execName)}` : ''}${t.status === 'doing' ? '' : '（未开始）'}</option>`).join('')
      : `<option value="">${efEsc(this.tasksError || '没有指派给你的未完成任务')}</option>`;
    return `<form class="effort-form" novalidate>
      <div class="effort-section-title">＋ 填报工时</div>
      <label class="doc-field"><span class="doc-field-label">任务</span><select name="taskId">${opts}</select></label>
      <div class="story-field-row">
        <label class="doc-field"><span class="doc-field-label">消耗工时（小时）</span><input name="consumed" type="number" min="0.1" max="24" step="0.5" placeholder="${gap > 0 ? gap : '2'}" /></label>
        <label class="doc-field"><span class="doc-field-label">剩余工时（小时）</span><input name="left" type="number" min="0" step="0.5" placeholder="必填，0 = 做完" /></label>
      </div>
      ${gap > 0 ? `<button type="button" class="effort-fill" data-eff="fill">按还差的 ${efHours(gap)} 填入</button>` : ''}
      <label class="doc-field"><span class="doc-field-label">工作内容（会进入日报）</span><textarea name="work" rows="3" placeholder="做了什么…"></textarea></label>
      <div class="doc-editor-err" data-eff-err hidden></div>
      <div class="effort-actions"><button type="submit" class="btn-primary" data-eff-submit>保存工时</button></div>
    </form>`;
  },

  readForm() {
    const f = this.ensureDom().querySelector('.effort-form');
    if (!f) return null;
    return { taskId: efField(f, 'taskId').value, consumed: efField(f, 'consumed').value, left: efField(f, 'left').value, work: efField(f, 'work').value };
  },
  writeForm(v) {
    const f = this.ensureDom().querySelector('.effort-form');
    if (!f) return;
    efField(f, 'taskId').value = v.taskId; efField(f, 'consumed').value = v.consumed; efField(f, 'left').value = v.left; efField(f, 'work').value = v.work;
  },

  /** 选任务 / 改小时 → 自动算剩余（用户手改过剩余就不再覆盖） */
  onInput(e) {
    const f = e.target.closest && e.target.closest('.effort-form');
    if (!f) return;
    if (e.target.name === 'left') { this.leftTouched = true; return; }
    if (e.target.name !== 'taskId' && e.target.name !== 'consumed') return;
    if (this.leftTouched) return;
    const opt = efField(f, 'taskId').selectedOptions && efField(f, 'taskId').selectedOptions[0];
    const left = opt && opt.dataset.left !== undefined ? Number(opt.dataset.left) : NaN;
    const used = Number(efField(f, 'consumed').value) || 0;
    if (!isNaN(left)) efField(f, 'left').value = String(Math.max(0, Math.round((left - used) * 10) / 10));
  },

  fillRest() {
    const f = this.ensureDom().querySelector('.effort-form');
    if (!f) return;
    const { entry, standard } = this.dayData();
    efField(f, 'consumed').value = String(Math.max(0, Math.round((standard - entry.hours) * 10) / 10));
    this.onInput({ target: efField(f, 'consumed') });
  },

  showErr(msg) {
    const err = this.ensureDom().querySelector('[data-eff-err]');
    if (!err) return;
    err.textContent = msg || '';
    err.hidden = !msg;
  },

  async submit() {
    if (this.busy) return;
    const f = this.ensureDom().querySelector('.effort-form');
    if (!f) return;
    const v = this.readForm();
    if (!v.taskId) return this.showErr('请选择任务');
    if (!(Number(v.consumed) > 0)) return this.showErr('请填写消耗工时');
    if (v.left === '') return this.showErr('请填写剩余工时（填 0 表示这个任务做完了）');
    if (!v.work.trim()) return this.showErr('请填写工作内容（它会进入日报）');
    this.busy = true;
    const btn = f.querySelector('[data-eff-submit]');
    btn.disabled = true; btn.textContent = '保存中…';
    this.showErr('');
    try {
      await this.sendWithFinishConfirm((finish) => EffortApi.add({ taskId: v.taskId, date: this.date, consumed: Number(v.consumed), left: Number(v.left), work: v.work.trim(), finish }));
      if (typeof Toast !== 'undefined') Toast.success('工时已记录');
      await this.afterWrite();
    } catch (err) {
      if (!err.cancelled) this.showErr(err.message || '保存失败');
      btn.disabled = false; btn.textContent = '保存工时';
    } finally {
      this.busy = false;
    }
  }
};

if (typeof window !== 'undefined') {
  window.EffortApi = EffortApi;
  window.EffortDrawer = EffortDrawer;
}
