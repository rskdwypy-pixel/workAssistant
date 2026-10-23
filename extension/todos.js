/**
 * 我的待办（与任务、需求、Bug、报告、文档同级的标签页）
 *
 *   TodoApi    后端 /api/todos 的封装
 *   TodoPage   分组列表：待办任务 / 待处理 Bug / 评审中与指派给我的需求 / 日报提醒；点一条跳到对应模块
 *
 * 汇总是实时算的（任务 / Bug 来自本地库，需求来自禅道）；某个来源失败只提示，不影响其它分组。
 * 标签上的角标 = 待办总数（有逾期 / 今天到期的变红），没有就不显示。
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

  filter: 'all',   // 'all' | 分组 key

  show() {
    const root = document.getElementById('todoMode');
    if (!root) return;
    if (!root.firstChild) {
      root.innerHTML = `<div class="task-board-header"><div class="task-board-left"><h2>📌 我的待办</h2><div class="task-board-stats"><div class="stat-item"><span class="stat-label">待处理</span><span class="stat-value" id="todoStatTotal">-</span></div><div class="stat-item"><span class="stat-label">逾期/今天</span><span class="stat-value" id="todoStatUrgent">-</span></div></div></div><button type="button" class="story-refresh" id="todoRefresh" title="刷新">↻</button></div>
        <section class="todo-page"><div id="todoBody"></div></section>`;
      root.querySelector('#todoRefresh').addEventListener('click', () => this.load());
    }
    this.load();
  },

  /** 问候语 + 日期，放在概览卡顶部 */
  helloText() {
    const now = new Date();
    const h = now.getHours();
    const hello = h < 6 ? '夜深了' : h < 12 ? '早上好' : h < 18 ? '下午好' : '晚上好';
    const wk = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
    return `${hello} · ${now.getMonth() + 1} 月 ${now.getDate()} 日 星期${wk}`;
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

  /** 概览卡：总数 + 紧急数 + 各分组计数（点分组计数 = 只看这一组，再点取消） */
  renderHero(d, nonEmpty) {
    const total = this.totalCount(d);
    const urgent = this.urgentCount(d);
    const sub = !total ? '都处理完了，今天可以轻松一点'
      : urgent ? `其中 <b>${urgent}</b> 项已逾期或今天到期，建议先处理` : '没有逾期或今天到期的事项';
    const chips = nonEmpty.map(g => `
      <button type="button" class="todo-chip${this.filter === g.key ? ' active' : ''}" data-filter="${tdEsc(g.key)}">
        <span class="todo-chip-n">${g.items.length}</span><span class="todo-chip-l">${tdEsc(g.label)}</span>
      </button>`).join('');
    return `<div class="todo-hero">
      <div class="todo-hero-main">
        <div class="todo-hero-label">${tdEsc(this.helloText())}</div>
        <div class="todo-hero-num">${total}</div>
        <div class="todo-hero-sub">${sub}</div>
      </div>
      ${chips ? `<div class="todo-chips">${chips}</div>` : ''}
    </div>`;
  },

  render() {
    const d = this.data;
    const body = document.getElementById('todoBody');
    if (!body || !d) return;
    const nonEmpty = d.groups.filter(g => g.items.length);
    if (this.filter !== 'all' && !nonEmpty.some(g => g.key === this.filter)) this.filter = 'all';
    const ta = document.getElementById('todoStatTotal'), tu = document.getElementById('todoStatUrgent');
    if (ta) ta.textContent = String(this.totalCount(d));
    if (tu) tu.textContent = String(this.urgentCount(d));
    let html = this.renderHero(d, nonEmpty);
    if (!nonEmpty.length) {
      html += `<div class="todo-allclear"><div class="todo-allclear-ico">✓</div><p>没有待处理的事项</p><span>任务、Bug、需求和日报都清空了</span></div>`;
    }
    const shown = this.filter === 'all' ? nonEmpty : nonEmpty.filter(g => g.key === this.filter);
    for (const g of shown) {
      html += `<section class="todo-group todo-${tdEsc(g.tone)}">
        <div class="todo-group-title"><span class="todo-dot"></span>${tdEsc(g.label)}<span class="todo-count">${g.items.length}</span></div>
        <div class="todo-list">
        ${g.items.map(it => `
          <button type="button" class="todo-item pri-${it.pri >= 1 && it.pri <= 4 ? it.pri : 3}" data-mode="${tdEsc(g.mode)}" data-kind="${tdEsc(it.kind)}" data-id="${tdEsc(it.id)}">
            <span class="todo-title">${tdEsc(it.title)}</span>
            ${it.due ? `<span class="todo-due due-${tdEsc(it.due)}">${TODO_DUE_LABEL[it.due]}</span>` : ''}
            <span class="todo-meta">${tdEsc(it.meta)}</span>
            <span class="todo-arrow" aria-hidden="true">›</span>
          </button>`).join('')}
        </div>
      </section>`;
    }
    if (d.errors && d.errors.length) {
      html += `<div class="todo-errors">部分来源没取到：${d.errors.map(tdEsc).join('；')}</div>`;
    }
    body.innerHTML = html;
    body.querySelectorAll('.todo-item').forEach(b => b.addEventListener('click', () => this.go(b.dataset.mode, b.dataset.kind, b.dataset.id)));
    body.querySelectorAll('.todo-chip').forEach(b => b.addEventListener('click', () => {
      this.filter = this.filter === b.dataset.filter ? 'all' : b.dataset.filter;
      this.render();
    }));
  },

  /** 跳到对应模块；需求直接打开详情 */
  go(mode, kind, id) {
    if (typeof TabSwitcher !== 'undefined') TabSwitcher.switchMode(mode);
    if (kind === 'story' && typeof StoryViewer !== 'undefined') setTimeout(() => StoryViewer.open(id), 0);
  }
};

if (typeof window !== 'undefined') {
  window.TodoPage = TodoPage;
  window.TodoApi = TodoApi;
}
