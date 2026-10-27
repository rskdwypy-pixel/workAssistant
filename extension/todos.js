/**
 * 我的待办（与任务、Bug、需求、文档、报告同级的标签页）
 *
 *   TodoApi      后端 /api/todos 的封装
 *   TodoPage     四张卡片排成两排：第一排 任务 | Bug，第二排 需求 | 禅道待办（每排各占一半高度）；
 *                点一条跳到对应标签页，并让那一条高亮闪烁
 *   WaHighlight  滚动到目标并闪烁（目标可能还在加载，会等它出现；列表重绘后会对新节点再闪一次）
 *
 * 任务 / Bug 来自本地库，需求来自禅道（本地缓存），禅道待办是禅道「地盘 → 我的待办」里的个人待办（实时读取）；某个来源失败只提示，不影响其它卡片。
 * 标签上的角标 = 待办总数（有逾期 / 今天到期的变红），没有就不显示。
 * 页面顶部有「工时待补」提醒（最近几个工作日不满标准工时），点一下去工作日历补填。
 * 没有刷新按钮：刷新浏览器页面即可；每次切到这个标签页都会重新汇总。
 */

const TodoApi = {
  base() { return typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : 'http://127.0.0.1:3721'; },
  async get() {
    const resp = await fetch(`${this.base()}/api/todos`);
    const json = await resp.json().catch(() => ({ success: false, message: `HTTP ${resp.status}` }));
    if (!json.success) throw new Error(json.message || `HTTP ${resp.status}`);
    return json.data;
  }
};

const tdEsc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
const TODO_DUE_LABEL = { overdue: '已逾期', today: '今天', soon: '3 天内' };

/** 四张卡片：key 对应后端分组 */
const TODO_CARDS = [
  { key: 'task', icon: '📋', title: '任务', empty: '没有未完成的任务' },
  { key: 'bug', icon: '🐛', title: 'Bug', empty: '没有待处理的 Bug' },
  { key: 'story', icon: '📝', title: '我的需求', empty: '没有指派给你或待你评审的需求' },
  { key: 'todo', icon: '🗒️', title: '禅道待办', empty: '没有未完成的个人待办，点右上角“新建”添加' }
];

const WaHighlight = {
  /** 立刻滚动到 el 并闪烁一次 */
  flash(el) {
    if (!el) return;
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch { /* 老环境忽略 */ }
    el.classList.remove('wa-flash');
    void el.offsetWidth;   // 强制重排，连续点同一条也能重新播放动画
    el.classList.add('wa-flash');
    setTimeout(() => el.classList.remove('wa-flash'), 2000);
  },

  /**
   * 等 selector 对应的元素出现再闪（目标页刚切过去，列表还在加载）。
   * 每 100ms 查一次，最多等 4 秒；列表重绘换了新节点（先画缓存、再画最新数据）会对新节点再闪一次。
   */
  flashWhenReady(selector, { timeout = 4000, interval = 100 } = {}) {
    const started = Date.now();
    let last = null;
    const timer = setInterval(() => {
      const el = document.querySelector(selector);
      if (el && el !== last) { last = el; this.flash(el); }
      if (Date.now() - started > timeout) clearInterval(timer);
    }, interval);
    return timer;
  }
};

const TodoPage = {
  loading: false,
  data: null,

  /** 待办总条数 */
  totalCount(data) {
    let n = 0;
    for (const g of (data && data.groups) || []) n += g.items.length;
    return n;
  },

  /** 紧急条数：逾期 + 今天到期 */
  urgentCount(data) {
    let n = 0;
    for (const g of (data && data.groups) || []) for (const it of g.items) if (it.due === 'overdue' || it.due === 'today') n++;
    return n;
  },

  renderBadge(data) {
    const btn = document.querySelector('.tab-btn[data-mode="todo"]');
    if (!btn) return;
    let b = btn.querySelector('.tab-badge');
    const n = this.totalCount(data);
    const urgent = this.urgentCount(data);
    if (!n) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('span'); b.className = 'tab-badge'; btn.appendChild(b); }
    b.textContent = n > 99 ? '99+' : String(n);
    b.classList.toggle('urgent', urgent > 0);
    b.title = urgent ? `共 ${n} 项待处理，其中 ${urgent} 项逾期或今天到期` : `共 ${n} 项待处理`;
  },

  /** 只刷新角标（不渲染页面）；页面启动和定时调用 */
  async refreshBadge() {
    try { this.renderBadge(await TodoApi.get()); } catch { /* 角标拿不到就不显示 */ }
  },

  show() {
    const root = document.getElementById('todoMode');
    if (!root) return;
    if (!root.firstChild) {
      root.innerHTML = `<div class="task-board-header"><div class="task-board-left"><h2>📌 我的待办</h2><div class="task-board-stats"><div class="stat-item"><span class="stat-label">待处理</span><span class="stat-value" id="todoStatTotal">-</span></div><div class="stat-item"><span class="stat-label">逾期/今天</span><span class="stat-value" id="todoStatUrgent">-</span></div></div></div></div>
        <section class="todo-page"><div class="todo-gap" id="todoGap" hidden></div><div class="todo-grid" id="todoBody"></div></section>`;
    }
    this.load();
  },

  async load() {
    if (this.loading) return;
    this.loading = true;
    const body = document.getElementById('todoBody');
    if (body && !this.data) body.innerHTML = `<div class="story-loading">正在汇总待办…</div>`;
    try {
      this.data = await TodoApi.get();
      this.render();
      this.renderBadge(this.data);
    } catch (err) {
      if (body) body.innerHTML = `<div class="story-empty"><p>${tdEsc(err.message || '加载失败')}</p></div>`;
    } finally {
      this.loading = false;
    }
  },

  showDone: false,

  /** 优先级小标签 + 状态 + 下一步按钮：禅道待办一条 */
  renderZtItem(it) {
    const act = typeof ZtTodo !== 'undefined' ? ZtTodo.nextAction(it.status) : { to: 'doing', label: '开始', title: '' };
    const done = it.status === 'done' || it.status === 'closed';
    return `<div class="todo-item todo-zt pri-${it.pri >= 1 && it.pri <= 4 ? it.pri : 3}${done ? ' is-done' : ''}" role="button" tabindex="0" data-kind="todo" data-id="${tdEsc(it.id)}" data-status="${tdEsc(it.status)}">
      <span class="zt-pri p${it.pri}" title="优先级 ${tdEsc(it.pri)}">P${tdEsc(it.pri)}</span>
      <span class="todo-title">${it.private ? '🔒 ' : ''}${tdEsc(it.title)}</span>
      ${it.due ? `<span class="todo-due due-${tdEsc(it.due)}">${TODO_DUE_LABEL[it.due]}</span>` : ''}
      <span class="todo-meta">${tdEsc(it.meta)}</span>
      ${it.status === 'closed' || it.cycle && done ? '' : `<button type="button" class="zt-quick" data-zt-to="${act.to}" data-zt-id="${tdEsc(it.id)}" title="${tdEsc(act.title)}">${act.label}</button>`}
    </div>`;
  },

  renderCard(card, group) {
    const items = (group && group.items) || [];
    if (card.key === 'todo') {
      const doneItems = (group && group.doneItems) || [];
      const shown = this.showDone ? [...items, ...doneItems] : items;
      return `<section class="todo-card todo-${card.key}" data-card="${card.key}">
        <div class="todo-card-head"><span class="todo-card-title">${card.icon} ${tdEsc(card.title)}</span><span class="todo-count">${items.length}</span>
          <span class="todo-head-spacer"></span>
          ${doneItems.length ? `<button type="button" class="zt-link-btn" data-zt-toggle-done>${this.showDone ? '隐藏已完成' : `显示已完成 (${doneItems.length})`}</button>` : ''}
          <button type="button" class="zt-add" data-zt-add title="在禅道里新建一条个人待办">＋ 新建</button></div>
        <div class="todo-list">${shown.length ? shown.map(it => this.renderZtItem(it)).join('') : `<div class="todo-empty">${tdEsc(card.empty)}</div>`}</div>
      </section>`;
    }
    return `<section class="todo-card todo-${card.key}" data-card="${card.key}">
      <div class="todo-card-head"><span class="todo-card-title">${card.icon} ${tdEsc(card.title)}</span><span class="todo-count">${items.length}</span></div>
      <div class="todo-list">${items.length ? items.map(it => `
        <button type="button" class="todo-item pri-${it.pri >= 1 && it.pri <= 4 ? it.pri : 3}" data-kind="${tdEsc(it.kind)}" data-id="${tdEsc(it.id)}">
          <span class="todo-title">${tdEsc(it.title)}</span>
          ${it.due ? `<span class="todo-due due-${tdEsc(it.due)}">${TODO_DUE_LABEL[it.due]}</span>` : ''}
          <span class="todo-meta">${tdEsc(it.meta)}</span>
        </button>`).join('') : `<div class="todo-empty">${tdEsc(card.empty)}</div>`}
      </div>
    </section>`;
  },

  render() {
    const d = this.data;
    const body = document.getElementById('todoBody');
    if (!body || !d) return;
    const ta = document.getElementById('todoStatTotal'), tu = document.getElementById('todoStatUrgent');
    if (ta) ta.textContent = String(this.totalCount(d));
    if (tu) tu.textContent = String(this.urgentCount(d));
    const byKey = new Map(d.groups.map(g => [g.key, g]));
    // 按顺序平铺，由 CSS 网格排成两排：任务 | Bug / 需求 | 禅道待办
    let html = TODO_CARDS.map(c => this.renderCard(c, byKey.get(c.key))).join('');
    if (d.errors && d.errors.length) {
      html += `<div class="todo-errors">部分来源没取到：${d.errors.map(tdEsc).join('；')}</div>`;
    }
    body.innerHTML = html;
    this.renderGap(d);
    body.querySelectorAll('.todo-item').forEach(b => {
      b.addEventListener('click', (e) => { if (!e.target.closest('.zt-quick')) this.go(b.dataset.kind, b.dataset.id); });
      b.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === b) { e.preventDefault(); this.go(b.dataset.kind, b.dataset.id); } });
    });
    body.querySelectorAll('.zt-quick').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (typeof ZtTodo !== 'undefined') ZtTodo.quickStatus(b.dataset.ztId, b.dataset.ztTo);
    }));
    const add = body.querySelector('[data-zt-add]');
    if (add) add.addEventListener('click', () => { if (typeof ZtTodo !== 'undefined') ZtTodo.open(); });
    const tg = body.querySelector('[data-zt-toggle-done]');
    if (tg) tg.addEventListener('click', () => { this.showDone = !this.showDone; this.render(); });
  },

  /** 工时缺填提醒：最近几个工作日里一小时都没填的；点一下跳到工作日历并打开最近那天的抽屉 */
  renderGap(d) {
    const el = document.getElementById('todoGap');
    if (!el) return;
    const gaps = (d && d.effortGaps) || [];
    if (!gaps.length) { el.hidden = true; el.innerHTML = ''; return; }
    const today = d.today || '';
    const label = (date) => {
      const diff = today ? Math.round((new Date(today + 'T00:00:00') - new Date(date + 'T00:00:00')) / 86400000) : 0;
      return diff === 1 ? '昨天' : diff === 2 ? '前天' : `${Number(date.slice(5, 7))}月${Number(date.slice(8))}日`;
    };
    const parts = gaps.map(g => label(g.date));
    el.hidden = false;
    el.innerHTML = `<button type="button" class="todo-gap-btn" data-date="${tdEsc(gaps[0].date)}">⏱ 这几天一小时工时都没填：${parts.map(tdEsc).join('、')} <span>去补填 ›</span></button>`;
    el.querySelector('.todo-gap-btn').addEventListener('click', (e) => this.goEffort(e.currentTarget.dataset.date));
  },

  /** 跳到工作日历并打开某天的工时抽屉 */
  goEffort(date) {
    if (typeof ReportPage !== 'undefined') ReportPage.month = date.slice(0, 7);
    if (typeof TabSwitcher !== 'undefined') TabSwitcher.switchMode('report');
    if (typeof EffortDrawer !== 'undefined') EffortDrawer.open(date);
  },

  /** 跳到对应标签页，并让目标那一条高亮闪烁 */
  go(kind, id) {
    const sw = (m) => { if (typeof TabSwitcher !== 'undefined') TabSwitcher.switchMode(m); };
    const sel = (s) => s.replace('__ID__', (window.CSS && CSS.escape) ? CSS.escape(String(id)) : String(id));
    if (kind === 'task') {
      sw('task');
      WaHighlight.flashWhenReady(sel('.task-card[data-task-id="__ID__"]'));
    } else if (kind === 'bug') {
      sw('bug');
      WaHighlight.flashWhenReady(sel('.bug-card[data-bug-id="__ID__"]'));
    } else if (kind === 'story') {
      sw('story');
      // 去掉可能把它藏起来的过滤（状态 / 产品 / 搜索词）
      if (typeof StoryPage !== 'undefined' && StoryPage.reveal) StoryPage.reveal();
      WaHighlight.flashWhenReady(sel('#storyList [data-id="__ID__"]'));
    } else if (kind === 'todo') {
      // 禅道个人待办：弹窗里看 / 改（描述、状态、指派等都在里面）
      if (typeof ZtTodo !== 'undefined') ZtTodo.open({ id });
    } else if (kind === 'doc') {
      sw('doc');
      if (typeof DocPage !== 'undefined' && DocPage.reveal) DocPage.reveal();
      WaHighlight.flashWhenReady(sel('#docList [data-id="__ID__"]'));
    }
  }
};

if (typeof window !== 'undefined') {
  window.TodoPage = TodoPage;
  window.TodoApi = TodoApi;
  window.WaHighlight = WaHighlight;
}
