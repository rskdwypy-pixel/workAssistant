/**
 * 我的待办（与任务、需求、Bug、报告、文档同级的标签页）
 *
 *   TodoApi    后端 /api/todos 的封装
 *   TodoPage   分组列表：待办任务 / 待处理 Bug / 评审中与指派给我的需求 / 日报提醒；点一条跳到对应模块
 *
 * 汇总是实时算的（任务 / Bug 来自本地库，需求来自禅道）；某个来源失败只提示，不影响其它分组。
 * 标签上的角标 = 逾期 + 今天到期的条数，没有就不显示。
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
const TODO_KIND_ICON = { task: '📋', bug: '🐛', story: '📝', report: '📊' };
const TODO_DUE_LABEL = { overdue: '已逾期', today: '今天', soon: '3 天内' };

const TodoPage = {
  loading: false,
  data: null,

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
    const n = this.urgentCount(data);
    if (!n) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('span'); b.className = 'tab-badge'; btn.appendChild(b); }
    b.textContent = n > 99 ? '99+' : String(n);
  },

  /** 只刷新角标（不渲染页面）；页面启动和定时调用 */
  async refreshBadge() {
    try { this.renderBadge(await TodoApi.get()); } catch { /* 角标拿不到就不显示 */ }
  },

  show() {
    const root = document.getElementById('todoMode');
    if (!root) return;
    if (!root.firstChild) root.innerHTML = `<section class="todo-page"><div class="todo-head"><h2>我的待办</h2><span class="todo-sub" id="todoSub"></span><button type="button" class="story-refresh" id="todoRefresh" title="刷新">↻</button></div><div id="todoBody"></div></section>`;
    const refresh = root.querySelector('#todoRefresh');
    if (refresh && !refresh._bound) { refresh._bound = true; refresh.addEventListener('click', () => this.load()); }
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

  render() {
    const d = this.data;
    const body = document.getElementById('todoBody');
    const sub = document.getElementById('todoSub');
    if (!body || !d) return;
    if (sub) sub.textContent = d.total ? `共 ${d.total} 项待处理` : '';
    let html = '';
    const nonEmpty = d.groups.filter(g => g.items.length);
    if (!nonEmpty.length) {
      html += `<div class="story-empty"><p><strong>🎉 没有待处理的事项</strong></p><p class="story-muted">任务、Bug、需求和日报都清空了。</p></div>`;
    }
    for (const g of nonEmpty) {
      html += `<div class="todo-group todo-${tdEsc(g.tone)}">
        <div class="todo-group-title">${TODO_KIND_ICON[g.items[0].kind] || ''} ${tdEsc(g.label)} <span class="story-count">${g.items.length}</span></div>
        ${g.items.map(it => `
          <button type="button" class="todo-item" data-mode="${tdEsc(g.mode)}" data-kind="${tdEsc(it.kind)}" data-id="${tdEsc(it.id)}">
            ${it.due ? `<span class="todo-due due-${tdEsc(it.due)}">${TODO_DUE_LABEL[it.due]}</span>` : ''}
            <span class="todo-title">${tdEsc(it.title)}</span>
            <span class="todo-meta">${tdEsc(it.meta)}</span>
          </button>`).join('')}
      </div>`;
    }
    if (d.errors && d.errors.length) {
      html += `<div class="todo-errors">部分来源没取到：${d.errors.map(tdEsc).join('；')}</div>`;
    }
    body.innerHTML = html;
    body.querySelectorAll('.todo-item').forEach(b => b.addEventListener('click', () => this.go(b.dataset.mode, b.dataset.kind, b.dataset.id)));
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
