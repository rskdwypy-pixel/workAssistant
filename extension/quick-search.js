/**
 * 全局搜索（⌘K / Ctrl+K，或点右上角放大镜）：一个输入框同时搜任务、Bug、需求、文档，回车直接在禅道里打开。
 *
 * 后端分两段（见 src/services/quickSearch.js）：先 local（本地 + 缓存，毫秒级）把结果画出来，
 * 输入停下后再请求 remote（禅道服务端搜索，能搜到不在我名下的任务 / Bug）合并进来。
 * 依赖 newtab.js 里的全局（调用时才访问）：API_BASE_URL、openInZentao。
 */
const QuickSearch = {
  GROUPS: [['tasks', '📋 任务'], ['bugs', '🐞 Bug'], ['stories', '📝 需求'], ['docs', '📁 文档']],
  open: false,
  seq: 0,
  results: { tasks: [], bugs: [], stories: [], docs: [] },
  active: 0,
  timers: { local: null, remote: null },
  localMs: 120,
  remoteMs: 450,

  base() {
    return typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : 'http://127.0.0.1:3721';
  },
  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },

  init() {
    document.getElementById('quickSearchBtn')?.addEventListener('click', () => this.toggle());
    document.addEventListener('keydown', (e) => {
      const key = String(e.key || '').toLowerCase();
      if ((e.metaKey || e.ctrlKey) && key === 'k') { e.preventDefault(); this.toggle(); return; }
      // “/” 在不输入文字的地方也能呼出
      if (key === '/' && !this.open && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const t = e.target;
        const typing = t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName || ''));
        if (!typing) { e.preventDefault(); this.show(); }
      }
    });
  },

  toggle() {
    if (this.open) this.close(); else this.show();
  },

  show() {
    this.close();
    this.open = true;
    this.results = { tasks: [], bugs: [], stories: [], docs: [] };
    this.active = 0;
    const overlay = document.createElement('div');
    overlay.className = 'qs-overlay';
    overlay.innerHTML = `
      <div class="qs-box" role="dialog" aria-modal="true" aria-label="搜索">
        <input class="qs-input" type="text" placeholder="搜索任务、Bug、需求、文档（标题关键词，或编号如 #944）" autocomplete="off" spellcheck="false" aria-label="搜索">
        <div class="qs-list" role="listbox"></div>
        <div class="qs-foot"><span>↑↓ 选择</span><span>回车 打开</span><span>Esc 关闭</span></div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) this.close(); });
    const input = overlay.querySelector('.qs-input');
    input.addEventListener('input', () => this.onInput(input.value));
    input.addEventListener('keydown', (e) => this.onKey(e));
    overlay.querySelector('.qs-list').addEventListener('mousedown', (e) => {
      const row = e.target.closest('[data-qs-index]');
      if (row) { e.preventDefault(); this.openIndex(Number(row.dataset.qsIndex)); }
    });
    this.render('');
    setTimeout(() => input.focus(), 0);
  },

  close() {
    document.querySelectorAll('.qs-overlay').forEach(o => o.remove());
    clearTimeout(this.timers.local);
    clearTimeout(this.timers.remote);
    this.open = false;
    this.seq++;
  },

  flat() {
    return this.GROUPS.flatMap(([key]) => this.results[key] || []);
  },

  onInput(value) {
    const q = value.trim();
    clearTimeout(this.timers.local);
    clearTimeout(this.timers.remote);
    const seq = ++this.seq;
    if (!q) { this.results = { tasks: [], bugs: [], stories: [], docs: [] }; this.render(''); return; }
    this.timers.local = setTimeout(() => this.run(q, 'local', seq), this.localMs);
    if (q.length >= 2 && !/^#?\d+$/.test(q)) this.timers.remote = setTimeout(() => this.run(q, 'remote', seq), this.remoteMs);
  },

  async run(q, scope, seq) {
    try {
      const resp = await fetch(`${this.base()}/api/quick-search?q=${encodeURIComponent(q)}&scope=${scope}`);
      const json = await resp.json();
      if (seq !== this.seq || !this.open || !json.success) return;   // 已经又输入了别的 / 关了：丢掉
      if (scope === 'local') {
        this.results = { tasks: json.data.tasks, bugs: json.data.bugs, stories: json.data.stories, docs: json.data.docs };
      } else {
        // 禅道服务端的结果补在本地结果后面，同一个对象只留一条
        for (const key of ['tasks', 'bugs']) {
          const seen = new Set((this.results[key] || []).map(i => `${i.type}:${i.id}`));
          this.results[key] = [...(this.results[key] || []), ...(json.data[key] || []).filter(i => !seen.has(`${i.type}:${i.id}`))];
        }
      }
      this.active = Math.min(this.active, Math.max(0, this.flat().length - 1));
      this.render(q);
    } catch {
      /* 后台连不上：保持现状 */
    }
  },

  render(q) {
    const list = document.querySelector('.qs-overlay .qs-list');
    if (!list) return;
    if (!q) { list.innerHTML = '<div class="qs-empty">输入标题里的几个字，或者编号（如 <b>#944</b>）。<br>结果里按回车直接在禅道里打开。</div>'; return; }
    let index = 0;
    const html = this.GROUPS.map(([key, label]) => {
      const items = this.results[key] || [];
      if (!items.length) return '';
      return `<div class="qs-group">${label}</div>` + items.map((it) => {
        const i = index++;
        return `<div class="qs-item ${i === this.active ? 'is-active' : ''}" role="option" aria-selected="${i === this.active}" data-qs-index="${i}">
            <span class="qs-title">${this.highlight(it.title, q)}</span>
            <span class="qs-sub">${this.esc(it.sub || '')}</span>
            <span class="qs-id">#${this.esc(it.id)}</span>
          </div>`;
      }).join('');
    }).join('');
    list.innerHTML = html || `<div class="qs-empty">没有找到「${this.esc(q)}」。${q.length < 2 ? '' : '<br>已同时在禅道里搜了任务和 Bug。'}</div>`;
    list.querySelector('.is-active')?.scrollIntoView?.({ block: 'nearest' });
  },

  /** 标题里命中的关键词加粗（先转义再加标签，不会执行标题里的 HTML） */
  highlight(title, q) {
    const t = String(title ?? '');
    const at = t.toLowerCase().indexOf(q.toLowerCase());
    if (at < 0 || !q) return this.esc(t);
    return `${this.esc(t.slice(0, at))}<mark>${this.esc(t.slice(at, at + q.length))}</mark>${this.esc(t.slice(at + q.length))}`;
  },

  onKey(e) {
    const n = this.flat().length;
    if (e.key === 'Escape') { e.preventDefault(); this.close(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!n) return;
      this.active = (this.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      this.render(document.querySelector('.qs-input').value.trim());
    } else if (e.key === 'Enter') {
      e.preventDefault();
      this.openIndex(this.active);
    }
  },

  openIndex(i) {
    const it = this.flat()[i];
    if (!it) return;
    this.close();
    if (typeof openInZentao === 'function') openInZentao(it.type, it.id);
  }
};

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => QuickSearch.init());
  else QuickSearch.init();
}
