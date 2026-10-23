/**
 * 文档中心（与任务、Bug、报告同级的标签页）
 *
 *   DocApi     后端 /api/docs/* 的封装
 *   DocPage    左侧文档库树 + 右侧文档列表 + 搜索
 *   DocViewer  文档详情（居中弹窗）：正文（已消毒 + 内联图走后端代理）或附件 / 外链；可在禅道打开
 *
 * 数据实时来自禅道（后端拉 doc-browse 全量再按库分组），不展示已删除文档。
 * 未登录禅道时给出登录入口（与报告页一致）。
 */

const DocApi = {
  base() {
    return typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : 'http://127.0.0.1:3721';
  },
  async request(path, init) {
    const resp = await fetch(`${this.base()}${path}`, init);
    const json = await resp.json().catch(() => ({ success: false, message: `HTTP ${resp.status}` }));
    if (!json.success) {
      const err = new Error(json.message || `HTTP ${resp.status}`);
      err.code = json.code;
      throw err;
    }
    return json;
  },
  libs() { return this.request('/api/docs/libs'); },
  list(keyword) { return this.request(`/api/docs/list${keyword ? `?keyword=${encodeURIComponent(keyword)}` : ''}`); },
  /** 只读后端本地缓存（没有缓存时 data 为 null），页面先画它，再等最新数据 */
  cachedLibs() { return this.request('/api/docs/libs?cache=only'); },
  cachedList() { return this.request('/api/docs/list?cache=only'); },
  get(id) { return this.request(`/api/docs/${encodeURIComponent(id)}`); },
  create(body) { return this.request('/api/docs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); },
  update(id, body) { return this.request(`/api/docs/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); },
  remove(id) { return this.request(`/api/docs/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
  /** 给文档追加一个附件（请求体就是文件本身，一次一个） */
  addFile(id, file) {
    return this.request(`/api/docs/${encodeURIComponent(id)}/files?name=${encodeURIComponent(file.name)}&mime=${encodeURIComponent(file.type || '')}`, { method: 'POST', body: file });
  },
  collect(id) { return this.request(`/api/docs/${encodeURIComponent(id)}/collect`, { method: 'POST' }); },
  fileUrl(fileId, { download = false, ext = '', name = '' } = {}) {
    const q = new URLSearchParams();
    if (download) q.set('download', '1');
    if (ext) q.set('ext', ext);
    if (name) q.set('name', name);
    const s = q.toString();
    return `${this.base()}/api/zentao/files/${encodeURIComponent(fileId)}/content${s ? `?${s}` : ''}`;
  }
};

const docEsc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
const DOC_OTHER_SPACE = '其他';

const docClock = (ms) => { if (!ms) return '--:--'; const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
/** 「已同步 14:03 · 新增 1 · 变更 2」；没变化就只显示时间 */
const docSyncText = (r) => {
  const d = r && r.diff || {};
  const parts = [d.added && `新增 ${d.added}`, d.changed && `变更 ${d.changed}`, d.removed && `移除 ${d.removed}`].filter(Boolean);
  return `已同步 ${docClock(r && r.syncedAt)}${parts.length ? ' · ' + parts.join(' · ') : ''}`;
};

const DocPage = {
  rendered: false,
  libs: [],
  docs: [],
  currentLib: 'all',   // 'all' | libId | 'other'
  keyword: '',
  loading: false,

  /** 切到文档标签时调用 */
  show() {
    const root = document.getElementById('docMode');
    if (!root) return;
    // 本地模式（没登录禅道）：文档来自禅道，给出登录入口
    if (typeof Account !== 'undefined' && Account.isLocalMode()) {
      this.rendered = false;
      root.innerHTML = `<div class="task-board-header"><div class="task-board-left"><h2>📁 文档</h2><div class="task-board-stats"><div class="stat-item"><span class="stat-label">文档</span><span class="stat-value" id="docStatAll">-</span></div></div><span class="sync-hint" id="docSyncHint"></span></div></div><section class="doc-page"><div class="doc-empty doc-login-empty">
        <p><strong>文档来自禅道</strong></p>
        <p class="doc-muted">这里浏览、查看、下载禅道里的文档，登录禅道后即可使用。</p>
        <button type="button" class="btn-primary" data-doc-login>登录禅道</button></div></section>`;
      const btn = root.querySelector('[data-doc-login]');
      if (btn) btn.addEventListener('click', () => Account.showLogin({ fromButton: true }));
      return;
    }
    if (!this.rendered) {
      this.rendered = true;
      root.innerHTML = `<div class="task-board-header"><div class="task-board-left"><h2>📁 文档</h2><div class="task-board-stats"><div class="stat-item"><span class="stat-label">文档</span><span class="stat-value" id="docStatAll">-</span></div></div><span class="sync-hint" id="docSyncHint"></span></div></div>
        <section class="doc-page">
          <aside class="doc-tree" id="docTree"></aside>
          <div class="doc-main">
            <div class="doc-toolbar">
              <div class="doc-search">
                <input type="search" id="docSearch" placeholder="搜索文档标题…" autocomplete="off" />
              </div>
              <button type="button" class="doc-new" id="docNew" title="新建文档">＋ 新建文档</button>
            </div>
            <div class="doc-list" id="docList"></div>
          </div>
        </section>`;
      const search = root.querySelector('#docSearch');
      if (search) {
        search.addEventListener('input', () => {
          this.keyword = search.value.trim();
          this.renderList();
        });
      }
      const neu = root.querySelector('#docNew');
      if (neu) neu.addEventListener('click', () => DocEditor.openNew());
    }
    this.load();
  },

  /** 新建 / 编辑 / 删除后刷新列表（保留当前库选择） */
  reload() { return this.load(); },

  /** 可写入的文档库（新建时的下拉）；默认选当前选中的库 */
  writableLibs() { return this.libs; },

  setHint(text) {
    const el = document.getElementById('docSyncHint');
    if (el) el.textContent = text || '';
  },

  /** 去掉可能把某篇文档藏起来的过滤（文档库 / 搜索词）；从待办页跳过来时用 */
  reveal() {
    this.currentLib = 'all'; this.keyword = '';
    const root = document.getElementById('docMode');
    if (!root || !this.rendered) return;
    const search = root.querySelector('#docSearch');
    if (search) search.value = '';
    this.renderTree(); this.renderList();
  },

  paint() {
    const st = document.getElementById('docStatAll'); if (st) st.textContent = String(this.docs.length);
    this.renderTree();
    this.renderList();
  },

  async load() {
    if (this.loading) return;
    this.loading = true;
    const listEl = document.getElementById('docList');
    const treeEl = document.getElementById('docTree');
    let showedCache = false;
    try {
      // 1. 先画本地缓存（后端读文件，几乎瞬时）
      try {
        const [cl, cd] = await Promise.all([DocApi.cachedLibs(), DocApi.cachedList()]);
        if (cl.data && cd.data) {
          this.libs = cl.data; this.docs = cd.data;
          this.paint();
          this.setHint(`缓存 ${docClock(cd.syncedAt)} · 正在更新…`);
          showedCache = true;
        }
      } catch { /* 没缓存就直接等最新的 */ }
      if (!showedCache && listEl) listEl.innerHTML = `<div class="doc-loading">正在从禅道加载文档…</div>`;
      // 2. 再向禅道要最新的；后端会和缓存比对，只让变化过的文档的详情缓存失效
      const [libsRes, docsRes] = await Promise.all([DocApi.libs(), DocApi.list()]);
      this.libs = libsRes.data || [];
      this.docs = docsRes.data || [];
      this.paint();
      this.setHint(docSyncText(docsRes));
    } catch (err) {
      if (showedCache) {
        this.setHint('更新失败，当前显示的是缓存');
      } else {
        const msg = err && err.code === 'ZENTAO_DISABLED' ? '请先在设置里登录禅道' : (err.message || '加载失败');
        if (listEl) listEl.innerHTML = `<div class="doc-empty"><p>${docEsc(msg)}</p></div>`;
        if (treeEl) treeEl.innerHTML = '';
        this.setHint('');
      }
    } finally {
      this.loading = false;
    }
  },

  /** 库 id → 实际分组后的文档数（禅道 docCount 有时不准，用真实分组数） */
  countByLib() {
    const m = new Map();
    for (const d of this.docs) m.set(d.lib, (m.get(d.lib) || 0) + 1);
    return m;
  },

  renderTree() {
    const el = document.getElementById('docTree');
    if (!el) return;
    const counts = this.countByLib();
    const known = new Set(this.libs.map(l => l.id));
    const otherCount = this.docs.filter(d => !known.has(d.lib)).length;

    // 按空间分组
    const bySpace = new Map();
    for (const lib of this.libs) {
      if (!bySpace.has(lib.spaceLabel)) bySpace.set(lib.spaceLabel, []);
      bySpace.get(lib.spaceLabel).push(lib);
    }

    let html = `<button type="button" class="doc-tree-all${this.currentLib === 'all' ? ' active' : ''}" data-lib="all">
      📚 全部文档 <span class="doc-tree-count">${this.docs.length}</span></button>`;

    for (const [space, libs] of bySpace) {
      html += `<div class="doc-tree-space">${docEsc(space)}</div>`;
      for (const lib of libs) {
        const n = counts.get(lib.id) || 0;
        html += `<button type="button" class="doc-tree-lib${this.currentLib === lib.id ? ' active' : ''}" data-lib="${docEsc(lib.id)}" title="${docEsc(lib.name)}">
          📁 <span class="doc-tree-name">${docEsc(lib.name)}</span> <span class="doc-tree-count">${n}</span></button>`;
      }
    }

    if (otherCount > 0) {
      html += `<div class="doc-tree-space">${DOC_OTHER_SPACE}</div>
        <button type="button" class="doc-tree-lib${this.currentLib === 'other' ? ' active' : ''}" data-lib="other">
          📁 <span class="doc-tree-name">未分组 / 其他库</span> <span class="doc-tree-count">${otherCount}</span></button>`;
    }

    el.innerHTML = html;
    el.querySelectorAll('[data-lib]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.currentLib = btn.dataset.lib;
        this.renderTree();
        this.renderList();
      });
    });
  },

  filteredDocs() {
    const known = new Set(this.libs.map(l => l.id));
    let items = this.docs;
    if (this.currentLib === 'other') items = items.filter(d => !known.has(d.lib));
    else if (this.currentLib !== 'all') items = items.filter(d => d.lib === this.currentLib);
    const kw = this.keyword.toLowerCase();
    if (kw) items = items.filter(d => d.title.toLowerCase().includes(kw));
    return items;
  },

  renderList() {
    const el = document.getElementById('docList');
    if (!el) return;
    const items = this.filteredDocs();
    if (!items.length) {
      el.innerHTML = `<div class="doc-empty"><p>${this.keyword ? '没有匹配的文档' : '这里还没有文档'}</p></div>`;
      return;
    }
    el.innerHTML = items.map(d => `
      <button type="button" class="doc-item" data-id="${docEsc(d.id)}">
        <span class="doc-item-icon">${docEsc(d.typeIcon)}</span>
        <span class="doc-item-body">
          <span class="doc-item-title">${docEsc(d.title)}${d.draft ? '<em class="doc-badge">草稿</em>' : ''}</span>
          <span class="doc-item-meta">${docEsc(d.typeLabel)} · ${docEsc(d.editedBy || '—')} · ${docEsc((d.editedDate || '').slice(0, 10))}</span>
        </span>
        <span class="doc-item-go">查看 ›</span>
      </button>`).join('');
    el.querySelectorAll('.doc-item').forEach(btn => {
      btn.addEventListener('click', () => DocViewer.open(btn.dataset.id));
    });
  }
};

const DocViewer = {
  el: null,

  ensure() {
    if (this.el) return this.el;
    const wrap = document.createElement('div');
    wrap.className = 'doc-viewer-overlay';
    wrap.hidden = true;
    wrap.innerHTML = `
      <div class="doc-viewer" role="dialog" aria-modal="true" aria-labelledby="docViewerTitle">
        <header class="doc-viewer-head">
          <h2 id="docViewerTitle" class="doc-viewer-title"></h2>
          <div class="doc-viewer-actions">
            <button type="button" class="doc-viewer-act" data-collect hidden title="收藏">☆</button>
            <button type="button" class="doc-viewer-act" data-edit hidden>✏️ 编辑</button>
            <button type="button" class="doc-viewer-act" data-delete hidden>🗑 删除</button>
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
    const titleEl = el.querySelector('[data-body]');
    el.querySelector('.doc-viewer-title').textContent = '加载中…';
    el.querySelector('[data-meta]').textContent = '';
    el.querySelector('[data-open]').hidden = true;
    titleEl.innerHTML = `<div class="doc-loading">正在加载文档…</div>`;
    try {
      const { data: doc } = await DocApi.get(id);
      this.render(doc);
    } catch (err) {
      el.querySelector('.doc-viewer-title').textContent = '打开失败';
      titleEl.innerHTML = `<div class="doc-empty"><p>${docEsc(err.message || '文档加载失败')}</p></div>`;
    }
  },

  render(doc) {
    const el = this.el;
    this.current = doc;
    el.querySelector('.doc-viewer-title').textContent = doc.title || '(无标题)';
    el.querySelector('[data-meta]').innerHTML =
      `${docEsc(doc.typeLabel || doc.type)} · ${docEsc(doc.editedBy || doc.addedBy || '—')} · 更新于 ${docEsc((doc.editedDate || doc.addedDate || '').slice(0, 16))}`;

    const openBtn = el.querySelector('[data-open]');
    openBtn.hidden = false;
    openBtn.onclick = () => {
      if (typeof openInZentao === 'function') openInZentao('doc', doc.id);
      else if (typeof Toast !== 'undefined') Toast.info('暂不支持在禅道打开');
    };

    // 编辑（仅正文型）
    const editBtn = el.querySelector('[data-edit]');
    editBtn.hidden = !doc.editable;
    editBtn.onclick = () => { this.close(); DocEditor.openEdit(doc); };

    // 删除
    const delBtn = el.querySelector('[data-delete]');
    delBtn.hidden = false;
    delBtn.onclick = async () => {
      const ok = typeof Confirm !== 'undefined'
        ? await Confirm.show('删除文档', `确定删除「${doc.title}」？将放入禅道回收站。`, '删除', '取消', { danger: true })
        : true;
      if (!ok) return;
      delBtn.disabled = true;
      try {
        await DocApi.remove(doc.id);
        if (typeof Toast !== 'undefined') Toast.success('文档已删除');
        this.close();
        DocPage.reload();
      } catch (err) {
        if (typeof Toast !== 'undefined') Toast.error(`删除失败：${err.message}`);
        delBtn.disabled = false;
      }
    };

    // 收藏（切换）
    const colBtn = el.querySelector('[data-collect]');
    colBtn.hidden = false;
    colBtn.textContent = '☆';
    colBtn.title = '收藏';
    colBtn.onclick = async () => {
      colBtn.disabled = true;
      try {
        const { data } = await DocApi.collect(doc.id);
        const collected = data && data.collected;
        colBtn.textContent = collected ? '★' : '☆';
        colBtn.title = collected ? '取消收藏' : '收藏';
        if (typeof Toast !== 'undefined') Toast.success(collected ? '已收藏' : '已取消收藏');
      } catch (err) {
        if (typeof Toast !== 'undefined') Toast.error(`操作失败：${err.message}`);
      } finally {
        colBtn.disabled = false;
      }
    };

    const body = el.querySelector('[data-body]');
    let html = '';

    // 外链型
    if (doc.type === 'url' && doc.externalUrl) {
      html += `<p class="doc-ext-link">🔗 <a href="${docEsc(doc.externalUrl)}" target="_blank" rel="noopener noreferrer">${docEsc(doc.externalUrl)}</a></p>`;
    }
    // 正文
    if (doc.contentHtml) {
      html += `<div class="doc-content doc-content-html">${doc.contentHtml}</div>`;
    } else if (doc.contentText) {
      html += `<pre class="doc-content doc-content-text">${docEsc(doc.contentText)}</pre>`;
    }
    // 附件
    const files = doc.files || [];
    if (files.length) {
      html += `<div class="doc-files"><div class="doc-files-title">附件（${files.length}）</div>` +
        files.map(f => {
          const preview = DocApi.fileUrl(f.id, { ext: f.ext, name: f.name });
          const download = DocApi.fileUrl(f.id, { download: true, ext: f.ext, name: f.name });
          const size = f.size ? ` · ${(f.size / 1024).toFixed(0)} KB` : '';
          return `<div class="doc-file">
            <span class="doc-file-name">📎 ${docEsc(f.name)}<span class="doc-file-size">${docEsc(size)}</span></span>
            <span class="doc-file-ops">
              <a href="${docEsc(preview)}" target="_blank" rel="noopener noreferrer">预览</a>
              <a href="${docEsc(download)}" download="${docEsc(f.name)}">下载</a>
            </span></div>`;
        }).join('') + `</div>`;
    }

    if (!html) html = `<div class="doc-empty"><p>这篇文档没有正文或附件内容。</p></div>`;
    body.innerHTML = html;
    body.scrollTop = 0;
  },

  close() {
    if (!this.el) return;
    this.el.hidden = true;
    document.removeEventListener('keydown', this._esc);
  }
};

const DOC_MAX_FILE = 50 * 1024 * 1024;
const docSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

const DocEditor = {
  el: null,
  mode: 'new',   // 'new' | 'edit'
  docId: null,
  files: [],     // 待上传的附件（File）

  showErr(msg) {
    const e = this.el.querySelector('[data-err]');
    e.textContent = msg; e.hidden = false;
  },

  renderFiles() {
    this.el.querySelector('[data-attach-list]').innerHTML = this.files.map((f, i) =>
      `<li><span class="doc-attach-name">${docEsc(f.name)}</span><span class="doc-attach-size">${docSize(f.size)}</span><button type="button" data-rm="${i}" aria-label="移除 ${docEsc(f.name)}">✕</button></li>`).join('');
  },

  ensure() {
    if (this.el) return this.el;
    const wrap = document.createElement('div');
    wrap.className = 'doc-viewer-overlay doc-editor-overlay';
    wrap.hidden = true;
    wrap.innerHTML = `
      <div class="doc-viewer doc-editor" role="dialog" aria-modal="true">
        <header class="doc-viewer-head">
          <h2 class="doc-viewer-title" data-etitle>新建文档</h2>
          <div class="doc-viewer-actions">
            <button type="button" class="doc-viewer-act doc-editor-save" data-save>保存</button>
            <button type="button" class="doc-viewer-close" data-close aria-label="关闭">✕</button>
          </div>
        </header>
        <div class="doc-editor-body">
          <label class="doc-field doc-field-lib" data-liband>
            <span class="doc-field-label">文档库</span>
            <select data-lib></select>
          </label>
          <label class="doc-field">
            <span class="doc-field-label">标题</span>
            <input type="text" data-title placeholder="文档标题" maxlength="200" />
          </label>
          <label class="doc-field">
            <span class="doc-field-label">正文（支持 Markdown）</span>
            <textarea data-content rows="14" placeholder="# 标题\n\n用 Markdown 书写，保存后按渲染效果展示"></textarea>
          </label>
          <div class="doc-field doc-attach">
            <span class="doc-field-label">附件（可选，单个不超过 50MB）</span>
            <div class="doc-attach-row">
              <input type="file" data-files multiple hidden />
              <button type="button" class="btn-secondary" data-pick>＋ 添加附件</button>
              <span class="doc-attach-hint">保存文档后上传到禅道；可以多选</span>
            </div>
            <ul class="doc-attach-list" data-attach-list></ul>
          </div>
          <div class="doc-editor-err" data-err hidden></div>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    wrap.querySelector('[data-close]').addEventListener('click', () => this.close());
    wrap.querySelector('[data-save]').addEventListener('click', () => this.save());
    wrap.querySelector('[data-pick]').addEventListener('click', () => wrap.querySelector('[data-files]').click());
    wrap.querySelector('[data-files]').addEventListener('change', (e) => {
      for (const f of e.target.files) {
        if (f.size > DOC_MAX_FILE) { this.showErr(`「${f.name}」超过 50MB，没有添加`); continue; }
        if (!f.size) { this.showErr(`「${f.name}」是空文件，没有添加`); continue; }
        if (!this.files.some(x => x.name === f.name && x.size === f.size)) this.files.push(f);
      }
      e.target.value = '';
      this.renderFiles();
    });
    wrap.querySelector('[data-attach-list]').addEventListener('click', (e) => {
      const b = e.target.closest('[data-rm]');
      if (b) { this.files.splice(Number(b.dataset.rm), 1); this.renderFiles(); }
    });
    this._esc = (e) => { if (e.key === 'Escape') this.close(); };
    this.el = wrap;
    return wrap;
  },

  openNew() {
    const el = this.ensure();
    this.mode = 'new'; this.docId = null;
    el.querySelector('[data-etitle]').textContent = '新建文档';
    el.querySelector('[data-err]').hidden = true;
    el.querySelector('[data-title]').value = '';
    el.querySelector('[data-content]').value = '';
    this.files = []; this.renderFiles();
    // 文档库下拉：可写入的库，默认选当前选中的库
    const libs = DocPage.writableLibs();
    const sel = el.querySelector('[data-lib]');
    el.querySelector('[data-liband]').style.display = '';
    if (!libs.length) {
      sel.innerHTML = `<option value="">（没有可写入的文档库）</option>`;
    } else {
      sel.innerHTML = libs.map(l => `<option value="${docEsc(l.id)}">${docEsc(l.spaceLabel)} / ${docEsc(l.name)}</option>`).join('');
      const cur = DocPage.currentLib;
      if (libs.some(l => l.id === cur)) sel.value = cur;
    }
    this.show();
  },

  openEdit(doc) {
    const el = this.ensure();
    this.mode = 'edit'; this.docId = doc.id;
    el.querySelector('[data-etitle]').textContent = '编辑文档';
    el.querySelector('[data-err]').hidden = true;
    el.querySelector('[data-title]').value = doc.title || '';
    el.querySelector('[data-content]').value = doc.raw || '';
    this.files = []; this.renderFiles();
    el.querySelector('[data-liband]').style.display = 'none'; // 编辑不换库
    this.show();
  },

  show() {
    this.el.hidden = false;
    document.addEventListener('keydown', this._esc);
    setTimeout(() => this.el.querySelector('[data-title]').focus(), 0);
  },

  async save() {
    const el = this.el;
    const title = el.querySelector('[data-title]').value.trim();
    const body = el.querySelector('[data-content]').value;
    const errEl = el.querySelector('[data-err]');
    const saveBtn = el.querySelector('[data-save]');
    errEl.hidden = true;
    if (!title) { errEl.textContent = '请填写标题'; errEl.hidden = false; return; }
    saveBtn.disabled = true;
    try {
      let docId = this.docId;
      if (this.mode === 'new') {
        const lib = el.querySelector('[data-lib]').value;
        if (!lib) throw new Error('请选择文档库');
        const r = await DocApi.create({ lib, module: '0', title, body, contentType: 'markdown' });
        docId = r.data && r.data.id;
        if (typeof Toast !== 'undefined') Toast.success('文档已创建');
      } else {
        await DocApi.update(this.docId, { title, body });
        if (typeof Toast !== 'undefined') Toast.success('文档已保存');
      }
      // 文档已经存好了，再逐个上传附件；失败的不影响文档，告诉用户哪些没传上
      const failed = [];
      if (this.files.length) {
        if (!docId) failed.push(...this.files.map(f => `${f.name}（没拿到新文档的编号）`));
        else {
          for (let i = 0; i < this.files.length; i++) {
            const f = this.files[i];
            saveBtn.textContent = `上传附件 ${i + 1}/${this.files.length}…`;
            try { await DocApi.addFile(docId, f); } catch (err) { failed.push(`${f.name}（${err.message}）`); }
          }
        }
      }
      if (failed.length && typeof Toast !== 'undefined') Toast.warning(`有 ${failed.length} 个附件没传上：${failed.join('；')}。文档已保存，可以编辑文档重新添加。`, 8000);
      else if (this.files.length && typeof Toast !== 'undefined') Toast.success(`${this.files.length} 个附件已上传`);
      this.files = [];
      this.close();
      DocPage.reload();
    } catch (err) {
      errEl.textContent = err.message || '保存失败';
      errEl.hidden = false;
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = '保存';
    }
  },

  close() {
    if (!this.el) return;
    this.el.hidden = true;
    document.removeEventListener('keydown', this._esc);
  }
};

if (typeof window !== 'undefined') {
  window.DocPage = DocPage;
  window.DocViewer = DocViewer;
  window.DocEditor = DocEditor;
}
