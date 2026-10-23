/**
 * 需求（与任务、Bug、文档同级的标签页）
 *
 *   StoryApi     后端 /api/stories/* 的封装
 *   StoryPage    左侧产品过滤 + 右侧需求卡片列表 + 状态过滤 + 搜索
 *   StoryViewer  需求详情（居中弹窗）：描述 + 验收标准 + 附件；可在禅道打开
 *
 * 需求数据实时来自禅道（我提的 / 指派我的 / 我评审的 / 抄送我的），不含已删除。只读视图。
 * 未登录禅道时给出登录入口（与报告 / 文档一致）。
 */

const StoryApi = {
  base() { return typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : 'http://127.0.0.1:3721'; },
  async request(path) {
    const resp = await fetch(`${this.base()}${path}`);
    const json = await resp.json().catch(() => ({ success: false, message: `HTTP ${resp.status}` }));
    if (!json.success) { const e = new Error(json.message || `HTTP ${resp.status}`); e.code = json.code; throw e; }
    return json;
  },
  list(keyword) { return this.request(`/api/stories${keyword ? `?keyword=${encodeURIComponent(keyword)}` : ''}`); },
  get(id) { return this.request(`/api/stories/${encodeURIComponent(id)}`); }
};

const stEsc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
const STORY_PRI = { 1: 'P1', 2: 'P2', 3: 'P3', 4: 'P4' };

const StoryPage = {
  rendered: false,
  stories: [],
  product: 'all',     // 'all' | productId
  status: 'open',     // 'open'(未关闭) | 'all' | 具体 status
  keyword: '',
  loading: false,

  show() {
    const root = document.getElementById('storyMode');
    if (!root) return;
    if (typeof Account !== 'undefined' && Account.isLocalMode()) {
      this.rendered = false;
      root.innerHTML = `<section class="story-page"><div class="story-empty story-login-empty">
        <p><strong>需求来自禅道</strong></p>
        <p class="story-muted">这里查看与你相关的需求（你提的 / 指派你的 / 你评审的），登录禅道后即可使用。</p>
        <button type="button" class="btn-primary" data-story-login>登录禅道</button></div></section>`;
      const btn = root.querySelector('[data-story-login]');
      if (btn) btn.addEventListener('click', () => Account.showLogin({ fromButton: true }));
      return;
    }
    if (!this.rendered) {
      this.rendered = true;
      root.innerHTML = `
        <section class="story-page">
          <aside class="story-side" id="storySide"></aside>
          <div class="story-main">
            <div class="story-toolbar">
              <div class="story-status-filter" id="storyStatus">
                <button type="button" data-st="open" class="active">进行中</button>
                <button type="button" data-st="active">激活</button>
                <button type="button" data-st="reviewing">评审中</button>
                <button type="button" data-st="closed">已关闭</button>
                <button type="button" data-st="all">全部</button>
              </div>
              <div class="story-search"><input type="search" id="storySearch" placeholder="搜索需求标题 / 编号…" autocomplete="off" /></div>
              <button type="button" class="story-refresh" id="storyRefresh" title="刷新">↻</button>
            </div>
            <div class="story-list" id="storyList"></div>
          </div>
        </section>`;
      root.querySelector('#storySearch').addEventListener('input', (e) => { this.keyword = e.target.value.trim(); this.renderList(); });
      root.querySelector('#storyRefresh').addEventListener('click', () => this.load());
      root.querySelector('#storyStatus').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-st]'); if (!btn) return;
        this.status = btn.dataset.st;
        root.querySelectorAll('#storyStatus [data-st]').forEach(b => b.classList.toggle('active', b === btn));
        this.renderSide(); this.renderList();
      });
    }
    this.load();
  },

  async load() {
    if (this.loading) return;
    this.loading = true;
    const listEl = document.getElementById('storyList');
    if (listEl) listEl.innerHTML = `<div class="story-loading">正在从禅道加载需求…</div>`;
    try {
      this.stories = (await StoryApi.list()).data || [];
      this.renderSide();
      this.renderList();
    } catch (err) {
      const msg = err && err.code === 'ZENTAO_DISABLED' ? '请先在设置里登录禅道' : (err.message || '加载失败');
      if (listEl) listEl.innerHTML = `<div class="story-empty"><p>${stEsc(msg)}</p></div>`;
      const side = document.getElementById('storySide'); if (side) side.innerHTML = '';
    } finally {
      this.loading = false;
    }
  },

  /** 当前状态过滤下的需求（不含产品 / 搜索过滤），用于左侧产品计数 */
  statusFiltered() {
    if (this.status === 'all') return this.stories;
    if (this.status === 'open') return this.stories.filter(s => s.status !== 'closed');
    return this.stories.filter(s => s.status === this.status);
  },

  renderSide() {
    const el = document.getElementById('storySide');
    if (!el) return;
    const items = this.statusFiltered();
    const counts = new Map();
    for (const s of items) {
      const key = s.product || '0';
      if (!counts.has(key)) counts.set(key, { name: s.productName || `产品 ${key}`, n: 0 });
      counts.get(key).n++;
    }
    let html = `<button type="button" class="story-prod${this.product === 'all' ? ' active' : ''}" data-prod="all">
      🗂 全部产品 <span class="story-count">${items.length}</span></button>`;
    for (const [id, info] of [...counts.entries()].sort((a, b) => b[1].n - a[1].n)) {
      html += `<button type="button" class="story-prod${this.product === id ? ' active' : ''}" data-prod="${stEsc(id)}" title="${stEsc(info.name)}">
        <span class="story-prod-name">${stEsc(info.name)}</span> <span class="story-count">${info.n}</span></button>`;
    }
    el.innerHTML = html;
    el.querySelectorAll('[data-prod]').forEach(b => b.addEventListener('click', () => {
      this.product = b.dataset.prod; this.renderSide(); this.renderList();
    }));
  },

  filtered() {
    let items = this.statusFiltered();
    if (this.product !== 'all') items = items.filter(s => (s.product || '0') === this.product);
    const kw = this.keyword.toLowerCase();
    if (kw) items = items.filter(s => s.title.toLowerCase().includes(kw) || s.id.includes(kw));
    return items;
  },

  renderList() {
    const el = document.getElementById('storyList');
    if (!el) return;
    const items = this.filtered();
    if (!items.length) {
      el.innerHTML = `<div class="story-empty"><p>${this.keyword ? '没有匹配的需求' : '没有符合条件的需求'}</p></div>`;
      return;
    }
    el.innerHTML = items.map(s => `
      <button type="button" class="story-card tone-${stEsc(s.tone)}" data-id="${stEsc(s.id)}">
        <span class="story-id">#${stEsc(s.id)}</span>
        <span class="story-body">
          <span class="story-title">${stEsc(s.title)}</span>
          <span class="story-meta">
            <span class="story-badge st-${stEsc(s.tone)}">${stEsc(s.statusLabel)}</span>
            ${s.stageLabel ? `<span class="story-stage">${stEsc(s.stageLabel)}</span>` : ''}
            ${s.pri ? `<span class="story-pri pri-${s.pri}">${STORY_PRI[s.pri] || 'P' + s.pri}</span>` : ''}
            <span class="story-dim">${stEsc(s.productName)}</span>
            ${s.assignedTo ? `<span class="story-dim">指派：${stEsc(s.assignedTo)}</span>` : ''}
          </span>
        </span>
      </button>`).join('');
    el.querySelectorAll('.story-card').forEach(b => b.addEventListener('click', () => StoryViewer.open(b.dataset.id)));
  }
};

const StoryViewer = {
  el: null,
  ensure() {
    if (this.el) return this.el;
    const wrap = document.createElement('div');
    wrap.className = 'doc-viewer-overlay';
    wrap.hidden = true;
    wrap.innerHTML = `
      <div class="doc-viewer" role="dialog" aria-modal="true">
        <header class="doc-viewer-head">
          <h2 class="doc-viewer-title" data-title></h2>
          <div class="doc-viewer-actions">
            <button type="button" class="doc-viewer-open" data-open hidden>在禅道打开</button>
            <button type="button" class="doc-viewer-close" data-close aria-label="关闭">✕</button>
          </div>
        </header>
        <div class="doc-viewer-meta" data-meta></div>
        <div class="doc-viewer-body" data-body></div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) this.close(); });
    wrap.querySelector('[data-close]').addEventListener('click', () => this.close());
    this._esc = (e) => { if (e.key === 'Escape') this.close(); };
    this.el = wrap;
    return wrap;
  },

  async open(id) {
    const el = this.ensure();
    el.hidden = false;
    document.addEventListener('keydown', this._esc);
    el.querySelector('[data-title]').textContent = '加载中…';
    el.querySelector('[data-meta]').textContent = '';
    el.querySelector('[data-open]').hidden = true;
    el.querySelector('[data-body]').innerHTML = `<div class="story-loading">正在加载需求…</div>`;
    try {
      const { data: s } = await StoryApi.get(id);
      this.render(s);
    } catch (err) {
      el.querySelector('[data-title]').textContent = '打开失败';
      el.querySelector('[data-body]').innerHTML = `<div class="story-empty"><p>${stEsc(err.message || '需求加载失败')}</p></div>`;
    }
  },

  render(s) {
    const el = this.el;
    el.querySelector('[data-title]').textContent = `#${s.id} ${s.title}`;
    el.querySelector('[data-meta]').innerHTML =
      `<span class="story-badge st-${stEsc(s.tone)}">${stEsc(s.statusLabel)}</span>` +
      (s.stageLabel ? ` · ${stEsc(s.stageLabel)}` : '') +
      (s.pri ? ` · ${STORY_PRI[s.pri] || 'P' + s.pri}` : '') +
      ` · ${stEsc(s.productName || '—')} · 提出：${stEsc(s.openedBy || '—')}` +
      (s.assignedTo ? ` · 指派：${stEsc(s.assignedTo)}` : '');

    const openBtn = el.querySelector('[data-open]');
    openBtn.hidden = false;
    openBtn.onclick = () => {
      if (typeof openInZentao === 'function') openInZentao('story', s.id);
      else if (typeof Toast !== 'undefined') Toast.info('暂不支持在禅道打开');
    };

    let html = `<div class="story-section-title">需求描述</div>`;
    html += s.specHtml ? `<div class="doc-content doc-content-html">${s.specHtml}</div>` : `<p class="story-muted">（无描述）</p>`;
    if (s.verifyHtml) html += `<div class="story-section-title">验收标准</div><div class="doc-content doc-content-html">${s.verifyHtml}</div>`;
    const files = s.files || [];
    if (files.length) {
      html += `<div class="doc-files"><div class="doc-files-title">附件（${files.length}）</div>` +
        files.map(f => {
          const base = StoryApi.base();
          const q = (dl) => `ext=${encodeURIComponent(f.ext || '')}&name=${encodeURIComponent(f.name)}${dl ? '&download=1' : ''}`;
          return `<div class="doc-file"><span class="doc-file-name">📎 ${stEsc(f.name)}</span>
            <span class="doc-file-ops">
              <a href="${base}/api/zentao/files/${encodeURIComponent(f.id)}/content?${q(false)}" target="_blank" rel="noopener noreferrer">预览</a>
              <a href="${base}/api/zentao/files/${encodeURIComponent(f.id)}/content?${q(true)}" download="${stEsc(f.name)}">下载</a>
            </span></div>`;
        }).join('') + `</div>`;
    }
    const body = el.querySelector('[data-body]');
    body.innerHTML = html;
    body.scrollTop = 0;
  },

  close() {
    if (!this.el) return;
    this.el.hidden = true;
    document.removeEventListener('keydown', this._esc);
  }
};

if (typeof window !== 'undefined') {
  window.StoryPage = StoryPage;
  window.StoryViewer = StoryViewer;
}
