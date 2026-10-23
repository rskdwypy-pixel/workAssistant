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
  async request(path, init) {
    const resp = await fetch(`${this.base()}${path}`, init);
    const json = await resp.json().catch(() => ({ success: false, message: `HTTP ${resp.status}` }));
    if (!json.success) { const e = new Error(json.message || `HTTP ${resp.status}`); e.code = json.code; throw e; }
    return json;
  },
  list(keyword) { return this.request(`/api/stories${keyword ? `?keyword=${encodeURIComponent(keyword)}` : ''}`); },
  /** 只读后端本地缓存（没有缓存时 data 为 null），页面先画它，再等最新数据 */
  cached() { return this.request('/api/stories?cache=only'); },
  get(id) { return this.request(`/api/stories/${encodeURIComponent(id)}`); },
  meta(product) { return this.request(`/api/stories/meta${product ? `?product=${encodeURIComponent(product)}` : ''}`); },
  create(body) { return this.request('/api/stories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); },
  update(id, body) { return this.request(`/api/stories/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); },
  remove(id) { return this.request(`/api/stories/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
};

/** 纯文本 ↔ 禅道正文 HTML（需求模块无 markdown，正文恒为 <p> 段落）。 */
const storyText = {
  toHtml(text) {
    return String(text || '').replace(/\r\n/g, '\n').split('\n')
      .map(line => `<p>${line ? stEsc(line) : '<br>'}</p>`).join('');
  },
  fromHtml(html) {
    if (!html) return '';
    let t = String(html)
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
      .replace(/<li[^>]*>/gi, '· ')
      .replace(/<[^>]+>/g, '');
    const ta = document.createElement('textarea');
    ta.innerHTML = t;
    return ta.value.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
  }
};

const stEsc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
const STORY_PRI = { 1: 'P1', 2: 'P2', 3: 'P3', 4: 'P4' };
const stClock = (ms) => { if (!ms) return '--:--'; const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
/** 「已同步 14:03 · 新增 1 · 变更 2」；没变化就只显示时间 */
const stSyncText = (r) => {
  const d = r && r.diff || {};
  const parts = [d.added && `新增 ${d.added}`, d.changed && `变更 ${d.changed}`, d.removed && `移除 ${d.removed}`].filter(Boolean);
  return `已同步 ${stClock(r && r.syncedAt)}${parts.length ? ' · ' + parts.join(' · ') : ''}`;
};

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
      root.innerHTML = `<div class="task-board-header"><div class="task-board-left"><h2>📝 需求</h2><div class="task-board-stats"><div class="stat-item"><span class="stat-label">全部</span><span class="stat-value" id="storyStatAll">-</span></div><div class="stat-item"><span class="stat-label">进行中</span><span class="stat-value" id="storyStatOpen">-</span></div></div></div><span class="sync-hint" id="storySyncHint"></span></div><section class="story-page"><div class="story-empty story-login-empty">
        <p><strong>需求来自禅道</strong></p>
        <p class="story-muted">这里查看与你相关的需求（你提的 / 指派你的 / 你评审的），登录禅道后即可使用。</p>
        <button type="button" class="btn-primary" data-story-login>登录禅道</button></div></section>`;
      const btn = root.querySelector('[data-story-login]');
      if (btn) btn.addEventListener('click', () => Account.showLogin({ fromButton: true }));
      return;
    }
    if (!this.rendered) {
      this.rendered = true;
      root.innerHTML = `<div class="task-board-header"><div class="task-board-left"><h2>📝 需求</h2><div class="task-board-stats"><div class="stat-item"><span class="stat-label">全部</span><span class="stat-value" id="storyStatAll">-</span></div><div class="stat-item"><span class="stat-label">进行中</span><span class="stat-value" id="storyStatOpen">-</span></div></div></div><span class="sync-hint" id="storySyncHint"></span></div>
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
              <button type="button" class="btn-primary story-new" id="storyNew">＋ 新建需求</button>
            </div>
            <div class="story-list" id="storyList"></div>
          </div>
        </section>`;
      root.querySelector('#storySearch').addEventListener('input', (e) => { this.keyword = e.target.value.trim(); this.renderList(); });
      root.querySelector('#storyNew').addEventListener('click', () => StoryEditor.openNew({ product: this.product !== 'all' ? this.product : '' }));
      root.querySelector('#storyStatus').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-st]'); if (!btn) return;
        this.status = btn.dataset.st;
        root.querySelectorAll('#storyStatus [data-st]').forEach(b => b.classList.toggle('active', b === btn));
        this.renderSide(); this.renderList();
      });
    }
    this.load();
  },

  /** 页头右侧的同步状态：缓存时间 / 更新中 / 已同步（带新增、变更、移除条数） */
  setHint(text) {
    const el = document.getElementById('storySyncHint');
    if (el) el.textContent = text || '';
  },

  async load() {
    if (this.loading) return;
    this.loading = true;
    const listEl = document.getElementById('storyList');
    let showedCache = false;
    try {
      // 1. 先画本地缓存（后端读文件，几乎瞬时）
      try {
        const c = await StoryApi.cached();
        if (c.data) {
          this.stories = c.data;
          this.renderStats(); this.renderSide(); this.renderList();
          this.setHint(`缓存 ${stClock(c.syncedAt)} · 正在更新…`);
          showedCache = true;
        }
      } catch { /* 没缓存就直接等最新的 */ }
      if (!showedCache && listEl) listEl.innerHTML = `<div class="story-loading">正在从禅道加载需求…</div>`;
      // 2. 再向禅道要最新的；后端会和缓存比对，只让变化过的需求的详情缓存失效
      const r = await StoryApi.list();
      this.stories = r.data || [];
      this.renderStats(); this.renderSide(); this.renderList();
      this.setHint(stSyncText(r));
    } catch (err) {
      if (showedCache) {
        this.setHint('更新失败，当前显示的是缓存');
      } else {
        const msg = err && err.code === 'ZENTAO_DISABLED' ? '请先在设置里登录禅道' : (err.message || '加载失败');
        if (listEl) listEl.innerHTML = `<div class="story-empty"><p>${stEsc(msg)}</p></div>`;
        const side = document.getElementById('storySide'); if (side) side.innerHTML = '';
        this.setHint('');
      }
    } finally {
      this.loading = false;
    }
  },

  /** 去掉可能把某条需求藏起来的过滤（状态 / 产品 / 搜索词）；从待办页跳过来时用 */
  reveal() {
    this.status = 'all'; this.product = 'all'; this.keyword = '';
    const root = document.getElementById('storyMode');
    if (!root || !this.rendered) return;
    const search = root.querySelector('#storySearch');
    if (search) search.value = '';
    root.querySelectorAll('#storyStatus [data-st]').forEach(b => b.classList.toggle('active', b.dataset.st === 'all'));
    this.renderSide(); this.renderList();
  },

  renderStats() {
    const a = document.getElementById('storyStatAll');
    const o = document.getElementById('storyStatOpen');
    if (a) a.textContent = String(this.stories.length);
    if (o) o.textContent = String(this.stories.filter(x => x.status !== 'closed').length);
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
            <button type="button" class="doc-viewer-act" data-split hidden>拆任务</button>
            <button type="button" class="doc-viewer-act" data-edit hidden>编辑</button>
            <button type="button" class="doc-viewer-act doc-viewer-del" data-del hidden>删除</button>
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
    el.querySelector('[data-edit]').hidden = true;
    el.querySelector('[data-split]').hidden = true;
    el.querySelector('[data-del]').hidden = true;
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

    // 拆任务只对「激活」的需求开放（禅道里其他状态建不了关联任务）；草稿 / 评审中 / 已关闭置灰并说明
    const splitBtn = el.querySelector('[data-split]');
    if (typeof TaskLinkDialog !== 'undefined') {
      splitBtn.hidden = false;
      const canSplit = s.status === 'active';
      splitBtn.disabled = !canSplit;
      splitBtn.title = canSplit ? '把需求拆成任务，建好后与需求自动关联' : `需求是「${s.statusLabel || s.status}」状态，激活后才能拆任务`;
      splitBtn.onclick = () => { this.close(); TaskLinkDialog.openForStory({ id: s.id, title: s.title }); };
    }

    const editBtn = el.querySelector('[data-edit]');
    editBtn.hidden = false;
    editBtn.onclick = () => { this.close(); StoryEditor.openEdit(s); };

    const delBtn = el.querySelector('[data-del]');
    delBtn.hidden = false;
    delBtn.onclick = async () => {
      const ok = typeof Confirm !== 'undefined'
        ? await Confirm.show('删除需求', `确定删除需求 #${s.id}「${s.title}」？将放入禅道回收站。`, '删除', '取消', { danger: true })
        : true;
      if (!ok) return;
      delBtn.disabled = true;
      try {
        await StoryApi.remove(s.id);
        if (typeof Toast !== 'undefined') Toast.success('需求已删除');
        this.close();
        StoryPage.load();
      } catch (err) {
        if (typeof Toast !== 'undefined') Toast.error(err.message || '删除失败');
        delBtn.disabled = false;
      }
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

const StoryEditor = {
  el: null,
  mode: 'new',    // 'new' | 'edit'
  storyId: null,
  meta: null,

  ensure() {
    if (this.el) return this.el;
    const wrap = document.createElement('div');
    wrap.className = 'doc-viewer-overlay doc-editor-overlay story-editor-overlay';
    wrap.hidden = true;
    wrap.innerHTML = `
      <div class="doc-viewer doc-editor story-editor" role="dialog" aria-modal="true">
        <header class="doc-viewer-head">
          <h2 class="doc-viewer-title" data-etitle>新建需求</h2>
          <div class="doc-viewer-actions">
            <button type="button" class="doc-viewer-act doc-editor-save" data-save>保存</button>
            <button type="button" class="doc-viewer-close" data-close aria-label="关闭">✕</button>
          </div>
        </header>
        <div class="doc-editor-body">
          <div class="story-field-row">
            <label class="doc-field" data-prodfield>
              <span class="doc-field-label">所属产品</span>
              <select data-product></select>
            </label>
            <label class="doc-field">
              <span class="doc-field-label">模块</span>
              <select data-module></select>
            </label>
          </div>
          <label class="doc-field">
            <span class="doc-field-label">标题</span>
            <input type="text" data-title placeholder="需求标题" maxlength="200" />
          </label>
          <label class="doc-field">
            <span class="doc-field-label">需求描述（纯文本，每行一段）</span>
            <textarea data-spec rows="7" placeholder="描述这个需求要解决什么…"></textarea>
          </label>
          <label class="doc-field">
            <span class="doc-field-label">验收标准</span>
            <textarea data-verify rows="4" placeholder="怎样算做完 / 验收通过…"></textarea>
          </label>
          <div class="story-field-row">
            <label class="doc-field">
              <span class="doc-field-label">评审人（必填，可多选）</span>
              <select data-reviewer multiple size="3"></select>
            </label>
            <label class="doc-field">
              <span class="doc-field-label">指派给</span>
              <select data-assigned></select>
            </label>
          </div>
          <div class="story-field-row">
            <label class="doc-field">
              <span class="doc-field-label">分类</span>
              <select data-category></select>
            </label>
            <label class="doc-field">
              <span class="doc-field-label">来源</span>
              <select data-source></select>
            </label>
            <label class="doc-field story-field-pri">
              <span class="doc-field-label">优先级</span>
              <select data-pri></select>
            </label>
          </div>
          <div class="doc-editor-err" data-err hidden></div>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.querySelector('[data-close]').addEventListener('click', () => this.close());
    wrap.querySelector('[data-save]').addEventListener('click', () => this.save());
    // 新建时换产品要重拉该产品的模块/评审人
    wrap.querySelector('[data-product]').addEventListener('change', (e) => {
      if (this.mode === 'new') this.loadMeta(e.target.value);
    });
    this._esc = (e) => { if (e.key === 'Escape') this.close(); };
    this.el = wrap;
    return wrap;
  },

  opts(list, selected) {
    const sel = Array.isArray(selected) ? selected.map(String) : [String(selected ?? '')];
    return (list || []).map(o => `<option value="${stEsc(o.value)}"${sel.includes(String(o.value)) ? ' selected' : ''}>${stEsc(o.label)}</option>`).join('');
  },

  /** 拉取某产品的下拉项并填充；preserve 为编辑时要保留的已选值 */
  async loadMeta(product, preserve) {
    const el = this.el;
    const errEl = el.querySelector('[data-err]');
    try {
      const { data } = await StoryApi.meta(product);
      this.meta = data;
      const p = preserve || {};
      if (!el.querySelector('[data-product]').options.length || this.mode === 'new') {
        el.querySelector('[data-product]').innerHTML = this.opts(data.products, p.product != null ? p.product : data.product);
      }
      el.querySelector('[data-module]').innerHTML = this.opts(data.modules, p.module != null ? p.module : '0');
      el.querySelector('[data-reviewer]').innerHTML = this.opts(data.reviewers, p.reviewers || []);
      el.querySelector('[data-assigned]').innerHTML = this.opts(
        [{ value: '', label: '（不指派）' }, ...data.assignees],
        p.assignedTo != null ? p.assignedTo : (data.defaultAssignedTo || ''));
      el.querySelector('[data-category]').innerHTML = this.opts(data.categories, p.category != null ? p.category : 'feature');
      el.querySelector('[data-source]').innerHTML = this.opts([{ value: '', label: '（不填）' }, ...data.sources], p.source != null ? p.source : '');
      el.querySelector('[data-pri]').innerHTML = this.opts(data.pris, p.pri != null ? String(p.pri) : '3');
      errEl.hidden = true;
    } catch (err) {
      errEl.textContent = err.message || '加载表单选项失败';
      errEl.hidden = false;
    }
  },

  async openNew({ product } = {}) {
    const el = this.ensure();
    this.mode = 'new'; this.storyId = null;
    el.querySelector('[data-etitle]').textContent = '新建需求';
    el.querySelector('[data-prodfield]').style.display = '';
    el.querySelector('[data-err]').hidden = true;
    el.querySelector('[data-title]').value = '';
    el.querySelector('[data-spec]').value = '';
    el.querySelector('[data-verify]').value = '';
    ['data-product', 'data-module', 'data-reviewer', 'data-assigned', 'data-category', 'data-source', 'data-pri']
      .forEach(a => { el.querySelector(`[${a}]`).innerHTML = '<option>加载中…</option>'; });
    this.show();
    await this.loadMeta(product || '');
  },

  async openEdit(s) {
    const el = this.ensure();
    this.mode = 'edit'; this.storyId = s.id;
    el.querySelector('[data-etitle]').textContent = `编辑需求 #${s.id}`;
    el.querySelector('[data-err]').hidden = true;
    el.querySelector('[data-title]').value = s.title || '';
    el.querySelector('[data-spec]').value = storyText.fromHtml(s.specRaw || s.specHtml || '');
    el.querySelector('[data-verify]').value = storyText.fromHtml(s.verifyRaw || s.verifyHtml || '');
    // 编辑不换产品：产品固定展示为当前产品
    el.querySelector('[data-product]').innerHTML = `<option value="${stEsc(s.product)}" selected>${stEsc(s.productName || ('产品 ' + s.product))}</option>`;
    el.querySelector('[data-prodfield]').style.display = '';
    el.querySelector('[data-product]').disabled = true;
    if (s.status === 'reviewing' || s.status === 'changing') {
      const note = el.querySelector('[data-err]');
      note.textContent = '该需求当前为「' + (s.statusLabel || s.status) + '」，保存时会自动撤回评审再提交，提交后仍回到评审中。';
      note.hidden = false;
      note.classList.add('story-note');
    } else {
      el.querySelector('[data-err]').classList.remove('story-note');
    }
    this.show();
    await this.loadMeta(s.product, {
      module: s.module, category: s.category, source: s.source,
      pri: s.pri, assignedTo: s.assignedToAccount
    });
  },

  show() {
    this.el.hidden = false;
    document.addEventListener('keydown', this._esc);
    setTimeout(() => this.el.querySelector('[data-title]').focus(), 0);
  },

  selectedReviewers() {
    return [...this.el.querySelector('[data-reviewer]').selectedOptions].map(o => o.value).filter(Boolean);
  },

  async save() {
    const el = this.el;
    const errEl = el.querySelector('[data-err]');
    errEl.classList.remove('story-note');
    const title = el.querySelector('[data-title]').value.trim();
    const reviewers = this.selectedReviewers();
    const body = {
      title,
      spec: storyText.toHtml(el.querySelector('[data-spec]').value),
      verify: storyText.toHtml(el.querySelector('[data-verify]').value),
      reviewers,
      module: el.querySelector('[data-module]').value,
      assignedTo: el.querySelector('[data-assigned]').value,
      category: el.querySelector('[data-category]').value,
      source: el.querySelector('[data-source]').value,
      pri: el.querySelector('[data-pri]').value
    };
    if (!title) { errEl.textContent = '请填写标题'; errEl.hidden = false; return; }
    if (!reviewers.length) { errEl.textContent = '请至少选择一位评审人'; errEl.hidden = false; return; }
    const saveBtn = el.querySelector('[data-save]');
    saveBtn.disabled = true;
    errEl.hidden = true;
    try {
      if (this.mode === 'new') {
        body.product = el.querySelector('[data-product]').value;
        if (!body.product) throw new Error('请选择所属产品');
        await StoryApi.create(body);
        if (typeof Toast !== 'undefined') Toast.success('需求已创建');
      } else {
        await StoryApi.update(this.storyId, body);
        if (typeof Toast !== 'undefined') Toast.success('需求已保存');
      }
      this.close();
      StoryPage.load();
    } catch (err) {
      errEl.textContent = err.message || '保存失败';
      errEl.hidden = false;
    } finally {
      saveBtn.disabled = false;
    }
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
  window.StoryEditor = StoryEditor;
}
