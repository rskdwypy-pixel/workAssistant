/**
 * 需求拆任务 / Bug 转任务的界面。设计见 docs/STORY-BUG-TASK-PRD.md，接口见 src/routes/taskLink.js。
 *
 *   TaskLinkApi     后端接口封装
 *   TaskLinkDialog  弹窗：Bug 转任务（单个）、需求拆任务（多行表格，逐个创建、失败的留下可重试）
 *
 * 这里不存任何东西；已转过的 Bug 以禅道里的 toTask 为准（打开弹窗时现查）。
 */

const TaskLinkApi = {
  base() { return typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : 'http://127.0.0.1:3721'; },
  async request(path, init) {
    const resp = await fetch(`${this.base()}${path}`, init);
    const json = await resp.json().catch(() => ({ success: false, message: `HTTP ${resp.status}` }));
    return json;
  },
  post(path, body) { return this.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }); },
  bugLink(zid) { return this.request(`/api/bugs/${encodeURIComponent(zid)}/task-link`); },
  bugToTask(zid, body) { return this.post(`/api/bugs/${encodeURIComponent(zid)}/to-task`, body); },
  storyTasks(id) { return this.request(`/api/stories/${encodeURIComponent(id)}/tasks`); },
  storySuggest(id) { return this.post(`/api/stories/${encodeURIComponent(id)}/tasks/suggest`, {}); },
  storySplit(id, body) { return this.post(`/api/stories/${encodeURIComponent(id)}/tasks`, body); },
  executions() { return this.request('/api/executions'); }
};

const tlEsc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
const TL_TYPES = [['devel', '开发'], ['design', '设计'], ['test', '测试'], ['study', '研究'], ['discuss', '讨论'], ['ui', '界面'], ['request', '需求'], ['affair', '事务'], ['misc', '其他']];
const TL_STATUS = { wait: '未开始', doing: '进行中', done: '已完成', pause: '已暂停', cancel: '已取消', closed: '已关闭' };
// Bug 严重程度 → 任务优先级（致命 1、严重 2、一般 3、提示 4）
const tlPriFromSeverity = (s) => Math.min(4, Math.max(1, Number(s) || 3));
const tlStripHtml = (h) => String(h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();

const TaskLinkDialog = {
  el: null,
  ctx: null,        // {kind:'bug'|'story', ...}
  executions: [],
  users: {},
  me: '',
  busy: false,

  ensureDom() {
    if (this.el) return this.el;
    const el = document.createElement('div');
    el.className = 'af-overlay';
    el.hidden = true;
    el.innerHTML = `<div class="af-dialog tl-dialog" role="dialog" aria-modal="true">
      <header class="af-head"><h3 data-tl-title></h3><span class="af-sub" data-tl-sub></span><button type="button" class="af-x" data-tl="close" aria-label="关闭">×</button></header>
      <div class="af-body" data-tl-body></div>
      <footer class="af-foot" data-tl-foot></footer>
    </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => {
      const t = e.target.closest('[data-tl]');
      if (e.target === el && !this.busy) return this.close();
      if (!t) return;
      const act = t.dataset.tl;
      if (act === 'close') { if (!this.busy) this.close(); }
      else if (act === 'submit') this.submit();
      else if (act === 'suggest') this.suggest();
      else if (act === 'add-row') { this.collectRows(); this.ctx.rows.push(this.blankRow()); this.renderStory(); }
      else if (act === 'del-row') { this.collectRows(); this.ctx.rows.splice(Number(t.dataset.i), 1); this.renderStory(); }
      else if (act === 'open-task') { if (typeof openInZentao === 'function') openInZentao('task', t.dataset.id); }
    });
    // 换执行：重画提示"需求有没有关联到这个执行"（只在需求拆任务里）
    el.addEventListener('change', (e) => {
      if (this.ctx && this.ctx.kind === 'story' && e.target.matches('[data-f="executionId"]')) { this.collectRows(); this.renderStory(); }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.isOpen() && !this.busy) this.close(); });
    this.el = el;
    return el;
  },

  isOpen() { return !!(this.el && !this.el.hidden); },
  close() { if (this.el) this.el.hidden = true; },
  q(sel) { return this.el.querySelector(sel); },
  setBusy(v) {
    this.busy = v;
    this.el.querySelectorAll('button, input, select, textarea').forEach(n => { if (!n.matches('[data-tl="close"]')) n.disabled = v; });
    const sub = this.q('[data-tl="submit"]');
    if (sub) {
      if (v) { sub.dataset.label = sub.textContent; sub.textContent = '创建中…'; }
      else if (sub.dataset.label) { sub.textContent = sub.dataset.label; delete sub.dataset.label; }
    }
  },

  async loadCommon() {
    try {
      const r = await TaskLinkApi.executions();
      this.executions = (r && r.success && Array.isArray(r.data)) ? r.data : [];
    } catch { this.executions = []; }
    try { this.users = (typeof ZentaoBrowserClient !== 'undefined' && await ZentaoBrowserClient.getUsers()) || {}; } catch { this.users = {}; }
    try { this.me = (typeof ConfigStore !== 'undefined' && ConfigStore.flat().zentaoUsername) || ''; } catch { this.me = ''; }
  },

  /** @param {string[]} [linked] 需求所属产品关联的执行：排在最前并标注，避免把任务建到别的项目里 */
  execOptions(selected, linked) {
    if (!this.executions.length) return '<option value="">（还没有同步执行，请先在任务页同步）</option>';
    const isLinked = (e) => !!(linked && linked.includes(String(e.id)));
    const ordered = linked && linked.length ? [...this.executions.filter(isLinked), ...this.executions.filter(e => !isLinked(e))] : this.executions;
    return ordered.map(e => `<option value="${tlEsc(e.id)}"${String(e.id) === String(selected) ? ' selected' : ''}>${isLinked(e) ? '🔗 ' : ''}${e.isFavorite || e.favorite ? '★ ' : ''}${tlEsc((e.projectName ? e.projectName + ' / ' : '') + (e.name || '执行 ' + e.id))}${isLinked(e) ? '（需求所属产品）' : ''}</option>`).join('');
  },
  defaultExec() {
    const d = this.executions.find(e => e.isDefault) || this.executions.find(e => e.isFavorite || e.favorite) || this.executions[0];
    return d ? d.id : '';
  },
  userOptions(selected) {
    const accounts = Object.keys(this.users);
    if (this.me && !accounts.includes(this.me)) accounts.unshift(this.me);
    return accounts.map(a => `<option value="${tlEsc(a)}"${a === selected ? ' selected' : ''}>${tlEsc(this.users[a] || a)}</option>`).join('') || `<option value="${tlEsc(this.me)}">${tlEsc(this.me || '我')}</option>`;
  },
  typeOptions(selected) { return TL_TYPES.map(([v, l]) => `<option value="${v}"${v === selected ? ' selected' : ''}>${l}</option>`).join(''); },

  /* ───────────── Bug 转任务 ───────────── */

  /** @param {{zentaoId:string,title:string,steps?:string,severity?:number|string,assignedTo?:string}} bug */
  async openForBug(bug) {
    if (!bug || !bug.zentaoId) { if (typeof Toast !== 'undefined') Toast.info('这个 Bug 还没有关联禅道编号，先「关联禅道 Bug」'); return; }
    this.ensureDom();
    this.ctx = { kind: 'bug', bug };
    this.q('[data-tl-title]').textContent = 'Bug 转任务';
    this.q('[data-tl-sub]').textContent = `#${bug.zentaoId} ${bug.title || ''}`;
    this.q('[data-tl-body]').innerHTML = '<div class="af-center"><div class="af-spin"></div>正在向禅道确认…</div>';
    this.q('[data-tl-foot]').innerHTML = '';
    this.el.hidden = false;
    const [link] = await Promise.all([TaskLinkApi.bugLink(bug.zentaoId).catch(() => null), this.loadCommon()]);
    if (link && link.success && link.data && link.data.toTask) {
      this.q('[data-tl-body]').innerHTML = `<div class="af-center"><p>这个 Bug 已经转成任务 #${tlEsc(link.data.toTask)}</p><p class="tl-muted">不能重复转。</p><button type="button" class="btn-secondary" data-tl="open-task" data-id="${tlEsc(link.data.toTask)}">在禅道打开任务</button></div>`;
      this.q('[data-tl-foot]').innerHTML = '<span class="af-spacer"></span><button type="button" class="btn-secondary" data-tl="close">关闭</button>';
      return;
    }
    // 默认：Bug 自己所在的执行 > Bug 所属产品关联的执行 > 全局默认；避免任务建到别的项目
    const info = (link && link.success && link.data) || {};
    const known = (id) => this.executions.some(e => String(e.id) === String(id));
    const linked = Array.isArray(info.executionIds) ? info.executionIds : null;
    const ownExec = info.executionId && known(info.executionId) ? info.executionId : '';
    const execSel = ownExec || (linked || []).find(known) || this.defaultExec();
    this.ctx.linkedExecs = linked;
    const steps = tlStripHtml(bug.steps);
    const desc = [steps, `来源：Bug #${bug.zentaoId}`].filter(Boolean).join('\n\n');
    const acct = (Array.isArray(bug.assignedTo) ? bug.assignedTo[0] : String(bug.assignedTo || '').split(/[\s,]+/)[0]) || '';
    this.q('[data-tl-body]').innerHTML = `
      <div class="tl-form">
        <label>创建到执行<select data-f="executionId">${this.execOptions(execSel, linked && ownExec ? [ownExec, ...linked.filter(x => x !== ownExec)] : (linked || (ownExec ? [ownExec] : null)))}</select></label>
        <label>任务标题<input type="text" data-f="name" maxlength="255" value="${tlEsc(`【Bug#${bug.zentaoId}】${bug.title || ''}`)}"></label>
        <div class="tl-row">
          <label>类型<select data-f="type">${this.typeOptions('devel')}</select></label>
          <label>指派给<select data-f="assignedTo">${this.userOptions(this.users[acct] || acct === this.me ? acct : this.me)}</select></label>
          <label>优先级<select data-f="pri">${[1, 2, 3, 4].map(n => `<option value="${n}"${n === tlPriFromSeverity(bug.severity) ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
          <label>预计(h)<input type="number" min="0" step="0.5" data-f="estimate" placeholder="可空"></label>
          <label>截止<input type="date" data-f="deadline"></label>
        </div>
        <label>描述<textarea data-f="desc" rows="6">${tlEsc(desc)}</textarea></label>
        <p class="tl-muted">转成任务后，Bug 自己的状态和指派不会变；任务建在所选执行里，并在禅道里与这个 Bug 互相关联。</p>
        <p class="tl-msg" data-tl-msg></p>
      </div>`;
    this.q('[data-tl-foot]').innerHTML = '<span class="af-spacer"></span><button type="button" class="btn-secondary" data-tl="close">取消</button><button type="button" class="btn-primary" data-tl="submit">转为任务</button>';
  },

  /* ───────────── 需求拆任务 ───────────── */

  blankRow(over = {}) { return { name: '', type: 'devel', assignedTo: this.me, estimate: '', deadline: '', ...over }; },

  templateRows() {
    return [this.blankRow({ name: '方案设计', type: 'design' }), this.blankRow({ name: '开发实现' }), this.blankRow({ name: '联调与自测' }), this.blankRow({ name: '测试验证', type: 'test' })];
  },

  /** @param {{id:string|number,title:string}} story */
  async openForStory(story) {
    this.ensureDom();
    this.ctx = { kind: 'story', story, rows: [], existing: [], results: [] };
    this.q('[data-tl-title]').textContent = '需求拆任务';
    this.q('[data-tl-sub]').textContent = `#${story.id} ${story.title || ''}`;
    this.q('[data-tl-body]').innerHTML = '<div class="af-center"><div class="af-spin"></div>正在加载…</div>';
    this.q('[data-tl-foot]').innerHTML = '';
    this.el.hidden = false;
    const [ex] = await Promise.all([TaskLinkApi.storyTasks(story.id).catch(() => null), this.loadCommon()]);
    this.ctx.existing = (ex && ex.success && ex.data && Array.isArray(ex.data.tasks)) ? ex.data.tasks : [];
    this.ctx.linkedExecs = (ex && ex.success && ex.data && Array.isArray(ex.data.executionIds)) ? ex.data.executionIds : null;   // null：没拿到，不提示
    // 默认选需求所属产品关联的执行（任务必须建在需求所属的执行里）；都没关联才退回全局默认
    const linkedFirst = (this.ctx.linkedExecs || []).find(id => this.executions.some(e => String(e.id) === String(id)));
    this.ctx.executionId = linkedFirst || this.defaultExec();
    this.ctx.rows = this.templateRows();
    this.renderStory();
  },

  renderStory() {
    const c = this.ctx;
    const existing = c.existing.length
      ? `<div class="tl-existing">已有 ${c.existing.length} 个任务（继续拆会新增）：${c.existing.map(t => `<span>${tlEsc(t.name)} · ${tlEsc(this.users[t.assignedTo] || t.assignedTo || '未指派')} · ${tlEsc(TL_STATUS[t.status] || t.status || '')}</span>`).join('')}</div>` : '';
    const rows = c.rows.map((r, i) => `
      <div class="tl-grid-row" data-i="${i}">
        <input type="text" data-r="name" placeholder="任务标题" maxlength="255" value="${tlEsc(r.name)}">
        <select data-r="type">${this.typeOptions(r.type)}</select>
        <select data-r="assignedTo">${this.userOptions(r.assignedTo)}</select>
        <input type="number" data-r="estimate" min="0" step="0.5" placeholder="预计h" value="${tlEsc(r.estimate)}">
        <input type="date" data-r="deadline" value="${tlEsc(r.deadline)}">
        <button type="button" class="tl-del" data-tl="del-row" data-i="${i}" aria-label="删除这一行">✕</button>
        ${r.error ? `<div class="tl-row-err">${tlEsc(r.error)}</div>` : ''}
      </div>`).join('');
    this.q('[data-tl-body]').innerHTML = `
      <div class="tl-form">
        ${existing}
        <label>创建到执行<select data-f="executionId">${this.execOptions(c.executionId, c.linkedExecs)}</select></label>
        ${this.linkWarn()}
        <div class="tl-ai"><button type="button" class="btn-secondary" data-tl="suggest">✨ AI 拆分建议</button><span class="tl-muted" data-tl-ai-msg>${tlEsc(c.aiMsg || '根据需求内容给出拆分，填进下面的表格，你可以随意改')}</span></div>
        <div class="tl-grid-head"><span>标题</span><span>类型</span><span>指派给</span><span>预计</span><span>截止</span><span></span></div>
        ${rows || '<p class="tl-muted">没有任务行，点下面「添加一行」。</p>'}
        <button type="button" class="btn-secondary tl-add" data-tl="add-row">＋ 添加一行</button>
        ${c.results.length ? `<div class="tl-results">${c.results.map(r => `<div class="${r.success ? 'is-ok' : 'is-fail'}">${r.success ? '✓' : '✗'} ${tlEsc(r.name)} — ${tlEsc(r.message)}${r.success && r.taskId ? ` <a href="#" data-tl="open-task" data-id="${tlEsc(r.taskId)}">#${tlEsc(r.taskId)}</a>` : ''}</div>`).join('')}</div>` : ''}
        <p class="tl-msg" data-tl-msg></p>
      </div>`;
    const total = c.rows.reduce((n, r) => n + (Number(r.estimate) || 0), 0);
    this.q('[data-tl-foot]').innerHTML = `<span class="tl-muted">${c.rows.length} 个任务 · 合计 ${Math.round(total * 10) / 10}h</span><span class="af-spacer"></span><button type="button" class="btn-secondary" data-tl="close">${c.results.some(r => r.success) && !c.rows.length ? '完成' : '取消'}</button>${c.rows.length ? `<button type="button" class="btn-primary" data-tl="submit">创建 ${c.rows.length} 个任务</button>` : ''}`;
  },

  /** 所选执行没关联这个需求时的提示（任务能建，但不会挂在需求下） */
  linkWarn() {
    const c = this.ctx;
    if (!c.linkedExecs || !c.executionId) return '<p class="tl-muted">需求要先在禅道里关联到这个执行（激活状态），任务才会挂在需求下。</p>';
    return c.linkedExecs.includes(String(c.executionId))
      ? '<p class="tl-muted">✓ 这是需求所属产品关联的执行。</p>'
      : '<p class="tl-warn">所选执行不属于这个需求所在的产品（可能是另一个项目）。请换一个带「🔗」的执行。</p>';
  },

  /** AI 拆分建议：填进表格（保留手填的执行和已输入的内容不丢——只替换任务行）。没配 AI / 出错会得到通用模板，不影响使用 */
  async suggest() {
    if (this.busy) return;
    this.collectRows();
    const c = this.ctx;
    const edited = c.rows.some(r => r.name.trim() && !this.templateRows().some(t => t.name === r.name.trim()));
    if (edited && typeof Confirm !== 'undefined') {
      const ok = await Confirm.show('替换任务行', '表格里已有你填写的任务，AI 拆分建议会把它们替换掉。继续吗？', '替换', '取消');
      if (!ok) return;
    }
    this.setBusy(true);
    const msgEl = this.q('[data-tl-ai-msg]'); if (msgEl) msgEl.textContent = 'AI 正在拆分…';
    let r;
    try { r = await TaskLinkApi.storySuggest(c.story.id); } catch (e) { r = { success: false, message: e.message || '网络错误' }; }
    this.setBusy(false);
    if (!r.success) { c.aiMsg = `获取建议失败：${r.message || ''}`; return this.renderStory(); }
    c.rows = r.data.tasks.map(t => this.blankRow({ name: t.name, type: t.type, estimate: t.estimate === '' ? '' : String(t.estimate) }));
    c.aiMsg = r.data.aiUsed ? `AI 给出 ${c.rows.length} 个任务，请检查后再创建` : (r.data.reason || '用了通用模板');
    this.renderStory();
  },

  collectRows() {
    if (!this.ctx || this.ctx.kind !== 'story') return;
    const ex = this.q('[data-f="executionId"]'); if (ex) this.ctx.executionId = ex.value;
    this.el.querySelectorAll('.tl-grid-row').forEach((row) => {
      const r = this.ctx.rows[Number(row.dataset.i)]; if (!r) return;
      row.querySelectorAll('[data-r]').forEach(inp => { r[inp.dataset.r] = inp.value; });
    });
  },

  msg(text, bad = true) { const m = this.q('[data-tl-msg]'); if (m) { m.textContent = text || ''; m.className = `tl-msg${bad ? ' is-bad' : ''}`; } },

  /* ───────────── 提交 ───────────── */

  async submit() {
    if (this.busy) return;
    if (this.ctx.kind === 'bug') return this.submitBug();
    return this.submitStory();
  },

  async submitBug() {
    const f = (k) => this.q(`[data-f="${k}"]`).value;
    const body = { executionId: f('executionId'), name: f('name').trim(), type: f('type'), assignedTo: f('assignedTo'), pri: Number(f('pri')), estimate: f('estimate'), deadline: f('deadline'), desc: f('desc') };
    if (!body.executionId) return this.msg('请先选择执行');
    const lk = this.ctx.linkedExecs;
    if (lk && lk.length && !lk.includes(String(body.executionId)) && typeof Confirm !== 'undefined') {
      const ok = await Confirm.show('执行与 Bug 不一致', '所选执行不属于这个 Bug 所在的产品：任务会建到另一个项目里。确定要这样创建吗？', '仍然创建', '返回修改');
      if (!ok) return;
    }
    if (!body.name) return this.msg('请填写任务标题');
    this.msg('正在创建…', false); this.setBusy(true);
    let r;
    try { r = await TaskLinkApi.bugToTask(this.ctx.bug.zentaoId, body); } catch (e) { r = { success: false, message: e.message || '网络错误' }; }
    this.setBusy(false);
    if (!r.success) return this.msg(r.message || '创建失败');
    if (typeof Toast !== 'undefined') { if (r.linked === false) Toast.warning(r.message || '任务已创建'); else Toast.success(r.message || '任务已创建'); }   // 不能把方法摘出来调用：Toast 内部用 this
    this.close();
    try { if (typeof loadTasks === 'function') loadTasks(); } catch { /* 刷新失败不影响 */ }
  },

  async submitStory() {
    this.collectRows();
    const c = this.ctx;
    if (!c.executionId) return this.msg('请先选择执行');
    if (c.linkedExecs && c.linkedExecs.length && !c.linkedExecs.includes(String(c.executionId)) && typeof Confirm !== 'undefined') {
      const ok = await Confirm.show('执行与需求不一致', '所选执行不属于这个需求所在的产品：任务会建到另一个项目里，且不会挂在需求下。确定要这样创建吗？', '仍然创建', '返回修改');
      if (!ok) return;
    }
    const names = c.rows.map(r => r.name.trim());
    if (names.some(n => !n)) return this.msg('有任务没填标题（不要的行请删除）');
    if (new Set(names).size !== names.length) return this.msg('有标题完全相同的任务，请先改名');
    this.msg('正在逐个创建…', false); this.setBusy(true);
    let r;
    try {
      r = await TaskLinkApi.storySplit(c.story.id, { executionId: c.executionId, tasks: c.rows.map(x => ({ name: x.name.trim(), type: x.type, assignedTo: x.assignedTo, estimate: x.estimate, deadline: x.deadline, pri: 3 })) });
    } catch (e) { r = { success: false, message: e.message || '网络错误' }; }
    this.setBusy(false);
    if (!r.success) return this.msg(r.message || '创建失败');
    const results = r.data.results;
    // 成功的从表格里拿掉（再点创建不会重复建），失败的留下并标原因
    const failedNames = new Set(results.filter(x => !x.success).map(x => x.name));
    c.rows = c.rows.filter(x => failedNames.has(x.name.trim())).map(x => ({ ...x, error: (results.find(y => y.name === x.name.trim()) || {}).message }));
    c.results = results;
    this.renderStory();
    if (typeof Toast !== 'undefined') {
      if (r.data.failed) Toast.warning(`成功 ${r.data.created} 个，失败 ${r.data.failed} 个（失败的还在表格里，可改后重试）`);
      else Toast.success(`已创建 ${r.data.created} 个任务`);
    }
    try { if (r.data.created && typeof loadTasks === 'function') loadTasks(); } catch { /* 刷新失败不影响 */ }
  }
};

if (typeof window !== 'undefined') window.TaskLinkDialog = TaskLinkDialog;
