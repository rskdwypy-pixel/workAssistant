/**
 * 任务 / Bug 附件（前端）
 *
 *   AttachmentRules   与后端一致的限制（先在前端拦，后端再校验一次）
 *   AttachmentApi     后端附件接口
 *   AttachmentPicker  新建 / 完成 / 解决弹窗里的附件选择区：粘贴截图、拖拽、选择文件，可删除、拖动排序
 *   AttachmentPanel   详情里的附件区：预览、下载、追加、删除、重试
 *   attachmentBadgeHTML 卡片上的附件角标（含「N 个未上传 · 重试」）
 *
 * 依赖 newtab.js 里的全局：API_BASE_URL、Toast、Confirm、escapeHtml、resetListenerScope（调用时才访问）。
 */

const AttachmentRules = {
  MAX_FILE_BYTES: 50 * 1024 * 1024,
  MAX_FILES: 10,
  MAX_TOTAL_BYTES: 100 * 1024 * 1024,
  KINDS: {
    image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'],
    video: ['mp4', 'mov', 'webm', 'avi', 'mkv', 'm4v'],
    document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'wps', 'et', 'dps', 'key', 'numbers', 'pages'],
    archive: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz'],
    text: ['txt', 'log', 'md', 'json', 'xml', 'yaml', 'yml', 'har']
  },
  ICONS: { image: '🖼️', video: '🎬', document: '📄', archive: '🗜️', text: '📝', other: '📎' },

  extOf(name) {
    const m = String(name || '').match(/\.([^.\\/]+)$/);
    return m ? m[1].toLowerCase() : '';
  },
  kindOf(name) {
    const ext = this.extOf(name);
    for (const [kind, list] of Object.entries(this.KINDS)) if (list.includes(ext)) return kind;
    return null;
  },
  accept() {
    return Object.values(this.KINDS).flat().map(e => `.${e}`).join(',');
  },
  formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)}KB`;
    return `${(n / 1024 / 1024).toFixed(1)}MB`;
  },
  /**
   * 校验一个文件能否加入
   * @param {{name:string,size:number}} file
   * @param {{count:number,total:number}} current - 已有附件数与总大小
   * @returns {string|null} 不通过的原因
   */
  validate(file, current) {
    const ext = this.extOf(file.name);
    if (!this.kindOf(file.name)) {
      return `「${file.name}」类型不支持${ext ? `（.${ext}）` : ''}：支持图片、视频、PDF、Office 文档、压缩包、日志和文本`;
    }
    if (!(file.size > 0)) return `「${file.name}」是空文件`;
    if (file.size > this.MAX_FILE_BYTES) return `「${file.name}」超过 50MB（${this.formatSize(file.size)}）`;
    if (current.count >= this.MAX_FILES) return `最多 ${this.MAX_FILES} 个附件`;
    if (current.total + file.size > this.MAX_TOTAL_BYTES) return '附件总大小不能超过 100MB';
    return null;
  }
};

const AttachmentApi = {
  base() {
    return typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : 'http://127.0.0.1:3721';
  },

  /**
   * 上传一个附件到记录
   * @param {string} recordId - 本地任务 / Bug ID
   * @param {{file:Blob,name:string}} item
   * @param {{inline?:boolean, hold?:boolean, push?:boolean}} [opts]
   */
  async upload(recordId, item, opts = {}) {
    const params = new URLSearchParams({ name: item.name, mime: item.file.type || '' });
    if (opts.inline) params.set('inline', '1');
    if (opts.hold) params.set('hold', '1');
    if (opts.push === false) params.set('push', '0');
    const resp = await fetch(`${this.base()}/api/records/${encodeURIComponent(recordId)}/attachments?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: item.file
    });
    const json = await resp.json().catch(() => ({ success: false, message: `HTTP ${resp.status}` }));
    if (!json.success) throw new Error(json.message || '上传失败');
    return json.data;
  },

  /**
   * 依次上传多个附件（一个失败不影响其他）
   * @returns {Promise<{uploaded:Array, failed:Array<{name:string,message:string}>}>}
   */
  async uploadAll(recordId, items, opts = {}) {
    const uploaded = [];
    const failed = [];
    for (const item of items) {
      try {
        uploaded.push(await this.upload(recordId, item, { ...opts, inline: opts.inline && item.kind === 'image' }));
      } catch (err) {
        failed.push({ name: item.name, message: err.message });
      }
    }
    return { uploaded, failed };
  },

  async list(recordId, { remote = true } = {}) {
    const resp = await fetch(`${this.base()}/api/records/${encodeURIComponent(recordId)}/attachments${remote ? '?remote=1' : ''}`);
    const json = await resp.json();
    if (!json.success) throw new Error(json.message || '读取附件失败');
    return json;
  },

  /** 立即推送待上传 / 失败的附件（也用作手动重试） */
  async sync(recordId) {
    const resp = await fetch(`${this.base()}/api/records/${encodeURIComponent(recordId)}/attachments/sync`, { method: 'POST' });
    return resp.json();
  },

  async remove(recordId, key) {
    const resp = await fetch(`${this.base()}/api/records/${encodeURIComponent(recordId)}/attachments/${encodeURIComponent(key)}`, { method: 'DELETE' });
    const json = await resp.json().catch(() => ({ success: false, message: `HTTP ${resp.status}` }));
    if (!json.success) throw new Error(json.message || '删除失败');
    return json;
  },

  /** 附件内容地址：未上传的读本地暂存，已上传的走后端转发禅道 */
  contentUrl(recordId, item, { download = false } = {}) {
    if (item.source === 'local') {
      return `${this.base()}/api/records/${encodeURIComponent(recordId)}/attachments/${encodeURIComponent(item.localId)}/content${download ? '?download=1' : ''}`;
    }
    const q = new URLSearchParams({ ext: item.ext || '', name: item.name || '' });
    if (download) q.set('download', '1');
    return `${this.base()}/api/zentao/files/${encodeURIComponent(item.zentaoFileId)}/content?${q}`;
  },

  /**
   * 读成 Blob URL：插件页面里 <img src> 直接指向后端不带 Origin，会被后端的来源校验拒绝，
   * 所以统一用 fetch（带插件 Origin）取回再生成 Blob URL。
   */
  async blobUrl(url) {
    const resp = await fetch(url);
    if (!resp.ok) {
      const json = await resp.json().catch(() => null);
      throw new Error((json && json.message) || `HTTP ${resp.status}`);
    }
    return URL.createObjectURL(await resp.blob());
  },

  async download(recordId, item) {
    const url = await this.blobUrl(this.contentUrl(recordId, item, { download: true }));
    const a = document.createElement('a');
    a.href = url;
    a.download = item.name || '附件';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
};

/** 粘贴的截图命名：截图-20261021-231302.png（同一次粘贴多张加序号） */
function screenshotName(index, ext) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `截图-${stamp}${index ? `-${index + 1}` : ''}.${ext || 'png'}`;
}

/**
 * 附件选择区
 *
 * 只在前端暂存所选文件（File 对象），提交时由调用方拿 getItems() 上传。
 * 宿主元素是常驻的，重复 mount 会先撤掉上一次的监听。
 */
class AttachmentPicker {
  /**
   * @param {HTMLElement} root - 放置选择区的容器
   * @param {{hint?:string, onChange?:Function}} [opts]
   */
  constructor(root, opts = {}) {
    this.root = root;
    this.opts = opts;
    this.items = [];
    this._seq = 0;
    this.render();
  }

  render() {
    const signal = resetListenerScope(this.root);
    this.root.classList.add('att-picker');
    this.root.innerHTML = `
      <div class="att-drop" tabindex="0" role="button" aria-label="添加附件">
        <span class="att-drop-text">📎 粘贴截图（Ctrl+V）、拖入文件，或</span>
        <button type="button" class="att-add-btn">选择文件</button>
        <input type="file" class="att-file-input" multiple hidden accept="${AttachmentRules.accept()}">
      </div>
      <div class="att-list" role="list"></div>
      <div class="att-hint">${escapeHtml(this.opts.hint || '单个文件不超过 50MB，最多 10 个；截图会同时插入禅道正文')}</div>
    `;
    this.listEl = this.root.querySelector('.att-list');
    const input = this.root.querySelector('.att-file-input');
    const drop = this.root.querySelector('.att-drop');

    this.root.querySelector('.att-add-btn').addEventListener('click', () => input.click(), { signal });
    drop.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    }, { signal });
    input.addEventListener('change', () => {
      this.add(Array.from(input.files || []));
      input.value = '';
    }, { signal });

    // 从系统拖入文件
    this.root.addEventListener('dragover', (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
        e.preventDefault();
        drop.classList.add('is-dragover');
      }
    }, { signal });
    this.root.addEventListener('dragleave', (e) => {
      if (!this.root.contains(e.relatedTarget)) drop.classList.remove('is-dragover');
    }, { signal });
    this.root.addEventListener('drop', (e) => {
      drop.classList.remove('is-dragover');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        e.preventDefault();
        this.add(Array.from(e.dataTransfer.files));
      }
    }, { signal });

    this.renderList();
  }

  /**
   * 在某个元素上监听粘贴（一般是整个弹窗）：剪贴板里有文件才接管，纯文本照常粘贴
   * @param {HTMLElement} target
   */
  bindPaste(target) {
    const signal = resetListenerScope(target._attPasteOwner || (target._attPasteOwner = {}));
    target.addEventListener('paste', (e) => {
      // 监听挂在弹窗上，弹窗隐藏时收不到粘贴事件；这里只防选择区已被移除的情况
      if (!this.root.isConnected) return;
      const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
      if (files.length === 0) return;
      e.preventDefault();
      const named = files.map((f, i) => (f.name && f.name !== 'image.png')
        ? f
        : new File([f], screenshotName(files.length > 1 ? i : 0, AttachmentRules.extOf(f.name) || (f.type.split('/')[1] || 'png')), { type: f.type }));
      this.add(named);
    }, { signal });
  }

  current() {
    return { count: this.items.length, total: this.items.reduce((s, i) => s + i.size, 0) };
  }

  /** 加入文件：逐个校验，不通过的给出原因 */
  add(files) {
    const errors = [];
    for (const file of files) {
      const reason = AttachmentRules.validate(file, this.current());
      if (reason) { errors.push(reason); continue; }
      const kind = AttachmentRules.kindOf(file.name);
      this.items.push({
        uid: `a${++this._seq}`,
        file,
        name: file.name,
        size: file.size,
        kind,
        previewUrl: kind === 'image' ? URL.createObjectURL(file) : null
      });
    }
    if (errors.length && typeof Toast !== 'undefined') Toast.warning(errors.join('；'), 5000);
    this.renderList();
    return errors;
  }

  remove(uid) {
    const it = this.items.find(i => i.uid === uid);
    if (it && it.previewUrl) URL.revokeObjectURL(it.previewUrl);
    this.items = this.items.filter(i => i.uid !== uid);
    this.renderList();
  }

  move(uid, beforeUid) {
    const from = this.items.findIndex(i => i.uid === uid);
    if (from < 0 || uid === beforeUid) return;
    const [it] = this.items.splice(from, 1);
    const to = beforeUid ? this.items.findIndex(i => i.uid === beforeUid) : -1;
    if (to < 0) this.items.push(it); else this.items.splice(to, 0, it);
    this.renderList();
  }

  renderList() {
    if (!this.listEl) return;
    this.listEl.innerHTML = this.items.map(it => `
      <div class="att-item" role="listitem" draggable="true" data-uid="${it.uid}" title="${escapeHtml(it.name)}（拖动可调整顺序）">
        ${it.previewUrl
          ? `<img class="att-thumb" src="${it.previewUrl}" alt="${escapeHtml(it.name)}">`
          : `<span class="att-icon">${AttachmentRules.ICONS[it.kind] || AttachmentRules.ICONS.other}</span>`}
        <span class="att-name">${escapeHtml(it.name)}</span>
        <span class="att-size">${AttachmentRules.formatSize(it.size)}</span>
        <button type="button" class="att-remove" data-uid="${it.uid}" aria-label="移除 ${escapeHtml(it.name)}" title="移除">×</button>
      </div>
    `).join('');

    this.listEl.querySelectorAll('.att-remove').forEach(btn => {
      btn.addEventListener('click', (e) => { e.stopPropagation(); this.remove(btn.dataset.uid); });
    });
    // 拖动排序（区分「从系统拖入文件」）
    this.listEl.querySelectorAll('.att-item').forEach(el => {
      el.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/x-att-uid', el.dataset.uid);
        e.dataTransfer.effectAllowed = 'move';
        el.classList.add('is-dragging');
      });
      el.addEventListener('dragend', () => el.classList.remove('is-dragging'));
      el.addEventListener('dragover', (e) => {
        if (Array.from(e.dataTransfer.types || []).includes('application/x-att-uid')) e.preventDefault();
      });
      el.addEventListener('drop', (e) => {
        const uid = e.dataTransfer.getData('application/x-att-uid');
        if (!uid) return;
        e.preventDefault();
        e.stopPropagation();
        this.move(uid, el.dataset.uid);
      });
    });
    if (this.opts.onChange) this.opts.onChange(this.items);
  }

  getItems() {
    return this.items.map(({ file, name, size, kind }) => ({ file, name, size, kind }));
  }

  get count() {
    return this.items.length;
  }

  clear() {
    this.items.forEach(i => i.previewUrl && URL.revokeObjectURL(i.previewUrl));
    this.items = [];
    this.renderList();
  }
}

/**
 * 附件推送观察器
 *
 * 附件交给后端后，推送到禅道是异步的（几秒）。卡片上的角标来自任务 / Bug 列表，
 * 推送完成后不会自己更新，会一直停在「待上传」。这里对正在推送的记录轮询它的附件状态
 * （只读本地，不访问禅道），都结束后刷新一次列表。同一记录只观察一次。
 */
const AttachmentWatcher = {
  _watching: new Map(),
  INTERVAL_MS: 2000,
  MAX_ROUNDS: 45,

  /** 记录是否还有正在推送的附件（已同步禅道的 pending 也算：后端会立即推送） */
  inFlight(items, zentaoId) {
    return (items || []).some(a => a.status === 'uploading' || (a.status === 'pending' && zentaoId));
  },

  watch(recordId) {
    if (!recordId || this._watching.has(recordId)) return;
    let rounds = 0;
    const tick = async () => {
      rounds++;
      let done = rounds >= this.MAX_ROUNDS;
      try {
        const data = await AttachmentApi.list(recordId, { remote: false });
        if (!this.inFlight(data.items, data.zentaoId)) done = true;
      } catch {
        done = true;
      }
      if (done) {
        this._watching.delete(recordId);
        if (typeof window.onAttachmentsChanged === 'function') window.onAttachmentsChanged();
      } else {
        this._watching.set(recordId, setTimeout(tick, this.INTERVAL_MS));
      }
    };
    this._watching.set(recordId, setTimeout(tick, this.INTERVAL_MS));
  }
};

/** 附件状态 → 角标文案 */
const ATTACHMENT_STATUS_TEXT = {
  pending: '待上传',
  held: '待随操作提交',
  uploading: '上传中…',
  failed: '上传失败',
  uploaded: ''
};

/**
 * 详情里的附件区
 */
const AttachmentPanel = {
  _previewUrls: new Set(),

  /**
   * @param {HTMLElement} container
   * @param {{id:string, zentaoId?:string}} record
   * @param {{onChanged?:Function}} [opts]
   */
  async mount(container, record, opts = {}) {
    if (!container) return;
    container.classList.add('att-panel');
    container.dataset.recordId = record.id;
    container._attOpts = opts;
    container.innerHTML = `
      <div class="att-panel-head">
        <strong class="att-panel-title">📎 附件</strong>
        <span class="att-panel-actions">
          <button type="button" class="att-panel-retry" hidden>立即上传</button>
          <button type="button" class="att-panel-add">添加附件</button>
          <input type="file" class="att-file-input" multiple hidden accept="${AttachmentRules.accept()}">
        </span>
      </div>
      <div class="att-panel-notice" hidden></div>
      <div class="att-panel-body"><div class="att-panel-empty">加载中…</div></div>
      <div class="att-hint">可直接粘贴截图或拖入文件；截图会同时插入禅道正文</div>
    `;
    const signal = resetListenerScope(container);
    const input = container.querySelector('.att-file-input');
    container.querySelector('.att-panel-add').addEventListener('click', () => input.click(), { signal });
    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      input.value = '';
      this.addFiles(container, record, files);
    }, { signal });
    container.querySelector('.att-panel-retry').addEventListener('click', () => this.retry(container, record), { signal });
    container.addEventListener('dragover', (e) => {
      if (Array.from(e.dataTransfer.types || []).includes('Files')) { e.preventDefault(); container.classList.add('is-dragover'); }
    }, { signal });
    container.addEventListener('dragleave', (e) => { if (!container.contains(e.relatedTarget)) container.classList.remove('is-dragover'); }, { signal });
    container.addEventListener('drop', (e) => {
      container.classList.remove('is-dragover');
      if (e.dataTransfer.files && e.dataTransfer.files.length) { e.preventDefault(); this.addFiles(container, record, Array.from(e.dataTransfer.files)); }
    }, { signal });
    // 详情打开时直接粘贴截图。监听挂在常驻的弹窗上，作用域也要挂在弹窗上，
    // 否则每次打开详情（附件区容器会重建）都多一个粘贴监听
    const host = container.closest('.modal') || document.body;
    const hostSignal = resetListenerScope(host._attPanelPasteOwner || (host._attPanelPasteOwner = {}));
    host.addEventListener('paste', (e) => {
      if (!container.isConnected) return;
      const target = e.target;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName) && !(e.clipboardData && e.clipboardData.files.length)) return;
      const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
      if (!files.length) return;
      e.preventDefault();
      this.addFiles(container, record, files.map((f, i) => (f.name && f.name !== 'image.png') ? f
        : new File([f], screenshotName(files.length > 1 ? i : 0, (f.type.split('/')[1] || 'png')), { type: f.type })));
    }, { signal: hostSignal });

    await this.refresh(container, record);
  },

  async refresh(container, record) {
    if (!container.isConnected && container.dataset.recordId !== record.id) return;
    const body = container.querySelector('.att-panel-body');
    const notice = container.querySelector('.att-panel-notice');
    let data;
    try {
      data = await AttachmentApi.list(record.id, { remote: true });
    } catch (err) {
      // 读不到列表时，已知有附件才报错；没有附件就安静地显示「暂无附件」
      const known = container._attItems || [];
      console.warn('[Attachments] 读取附件失败:', err.message);
      body.innerHTML = known.length
        ? `<div class="att-panel-empty">读取附件失败：${escapeHtml(err.message)}</div>`
        : '<div class="att-panel-empty">暂无附件</div>';
      return;
    }
    container._attItems = data.items;

    // 禅道里的附件读不到：只有本地确实有附件时才提示，避免没有附件也弹错误
    if (data.remoteError && data.items.length === 0) {
      console.warn('[Attachments] 读取禅道附件失败（无附件，不提示）:', data.remoteError);
      notice.hidden = true;
    } else if (data.remoteError) {
      notice.hidden = false;
      notice.innerHTML = `无法读取禅道里的附件：${escapeHtml(data.remoteError)} <button type="button" class="att-link-btn att-reload">重试</button>`;
      notice.querySelector('.att-reload').addEventListener('click', () => this.refresh(container, record));
    } else if (!record.zentaoId && data.items.some(i => i.status === 'pending')) {
      notice.hidden = false;
      notice.textContent = '尚未同步到禅道：附件已保存在本地，同步到禅道后自动上传';
    } else {
      notice.hidden = true;
    }

    const retryBtn = container.querySelector('.att-panel-retry');
    const needRetry = data.items.some(i => i.status === 'failed');
    retryBtn.hidden = !needRetry;
    retryBtn.textContent = data.items.some(i => i.status === 'failed') ? '重试上传' : '立即上传';

    const title = container.querySelector('.att-panel-title');
    title.textContent = `📎 附件${data.items.length ? `（${data.items.length}）` : ''}`;

    if (data.items.length === 0) {
      body.innerHTML = '<div class="att-panel-empty">暂无附件</div>';
      return;
    }
    body.innerHTML = `<div class="att-grid">${data.items.map(it => this.itemHtml(it, record)).join('')}</div>`;

    body.querySelectorAll('.att-card').forEach(card => {
      const it = data.items.find(i => i.key === card.dataset.key);
      if (!it) return;
      card.querySelector('.att-open').addEventListener('click', () => this.open(record, it));
      const dl = card.querySelector('.att-download');
      if (dl) dl.addEventListener('click', () => AttachmentApi.download(record.id, it).catch(err => Toast.error(`下载失败：${err.message}`)));
      const del = card.querySelector('.att-delete');
      if (del) del.addEventListener('click', () => this.remove(container, record, it));
      const thumb = card.querySelector('img[data-lazy]');
      if (thumb) {
        AttachmentApi.blobUrl(AttachmentApi.contentUrl(record.id, it))
          .then(url => { this._previewUrls.add(url); thumb.src = url; thumb.removeAttribute('data-lazy'); })
          .catch(() => { thumb.replaceWith(Object.assign(document.createElement('span'), { className: 'att-icon', textContent: AttachmentRules.ICONS.image })); });
      }
    });

    // 有上传中的：稍后自动刷新状态；从「上传中」变为结束时通知列表刷新（卡片角标跟着更新）
    clearTimeout(container._attPoll);
    const inFlight = AttachmentWatcher.inFlight(data.items, record.zentaoId);
    if (inFlight) {
      container._attPollCount = (container._attPollCount || 0) + 1;
      if (container._attPollCount <= 40) {
        container._attPoll = setTimeout(() => this.refresh(container, record), 1500);
      }
    } else {
      if (container._attWasInFlight && container._attOpts && container._attOpts.onChanged) container._attOpts.onChanged();
      container._attPollCount = 0;
    }
    container._attWasInFlight = inFlight;
  },

  itemHtml(it, record) {
    // 记录已同步到禅道时 pending 是排队推送中，显示「上传中」；未同步才是真正的「待上传」
    const status = it.status === 'pending' && record && record.zentaoId ? 'uploading' : it.status;
    const statusText = ATTACHMENT_STATUS_TEXT[status] || '';
    const isImage = it.kind === 'image';
    const meta = [AttachmentRules.formatSize(it.size), it.addedBy ? `${it.addedBy} 在禅道上传` : ''].filter(Boolean).join(' · ');
    return `
      <div class="att-card${it.status === 'failed' ? ' is-failed' : ''}" data-key="${escapeHtml(it.key)}">
        <button type="button" class="att-open" title="${isImage ? '预览' : '下载'} ${escapeHtml(it.name)}">
          ${isImage ? `<img class="att-thumb" alt="${escapeHtml(it.name)}" data-lazy="1">` : `<span class="att-icon">${AttachmentRules.ICONS[it.kind] || AttachmentRules.ICONS.other}</span>`}
        </button>
        <div class="att-card-info">
          <div class="att-name" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</div>
          <div class="att-size">${escapeHtml(meta)}</div>
          ${statusText ? `<div class="att-status att-status-${status}" ${it.error ? `title="${escapeHtml(it.error)}"` : ''}>${statusText}${it.status === 'failed' && it.error ? `：${escapeHtml(it.error).slice(0, 60)}` : ''}${it.stale ? '（已等待超过 7 天）' : ''}</div>` : ''}
        </div>
        <div class="att-card-actions">
          <button type="button" class="att-link-btn att-download">下载</button>
          ${it.status !== 'uploading' ? '<button type="button" class="att-link-btn att-delete">删除</button>' : ''}
        </div>
      </div>
    `;
  },

  /** 图片在当前页预览，其他文件直接下载 */
  async open(record, it) {
    if (it.kind !== 'image') {
      AttachmentApi.download(record.id, it).catch(err => Toast.error(`下载失败：${err.message}`));
      return;
    }
    // 详情里有多张图时可左右切换
    const container = document.querySelector(`.att-panel[data-record-id="${CSS.escape(record.id)}"]`);
    const images = ((container && container._attItems) || [it]).filter(i => i.kind === 'image');
    AttachmentPreview.gallery(record.id, images, Math.max(0, images.findIndex(i => i.key === it.key)));
  },

  async addFiles(container, record, files) {
    const items = container._attItems || [];
    const current = { count: items.length, total: items.reduce((s, i) => s + (Number(i.size) || 0), 0) };
    const accepted = [];
    const errors = [];
    for (const f of files) {
      const reason = AttachmentRules.validate(f, current);
      if (reason) { errors.push(reason); continue; }
      current.count++;
      current.total += f.size;
      accepted.push({ file: f, name: f.name, size: f.size, kind: AttachmentRules.kindOf(f.name) });
    }
    if (errors.length) Toast.warning(errors.join('；'), 5000);
    if (!accepted.length) return;

    const { uploaded, failed } = await AttachmentApi.uploadAll(record.id, accepted, { inline: true });
    if (failed.length) Toast.error(`${failed.length} 个附件添加失败：${failed.map(f => f.message).join('；')}`, 6000);
    if (uploaded.length) {
      Toast.success(record.zentaoId ? `已添加 ${uploaded.length} 个附件，正在上传到禅道…` : `已添加 ${uploaded.length} 个附件，同步到禅道后自动上传`);
    }
    container._attPollCount = 0;
    await this.refresh(container, record);
    if (container._attOpts && container._attOpts.onChanged) container._attOpts.onChanged();
    if (record.zentaoId) AttachmentWatcher.watch(record.id);
  },

  async retry(container, record) {
    const btn = container.querySelector('.att-panel-retry');
    btn.disabled = true;
    try {
      const r = await AttachmentApi.sync(record.id);
      if (r.success && r.uploaded) Toast.success(`已上传 ${r.uploaded} 个附件`);
      else if (!r.success) Toast.error(`上传失败：${r.message}`);
      else Toast.info(r.message);
    } catch (err) {
      Toast.error(`上传失败：${err.message}`);
    } finally {
      btn.disabled = false;
      container._attPollCount = 0;
      await this.refresh(container, record);
      if (container._attOpts && container._attOpts.onChanged) container._attOpts.onChanged();
    }
  },

  async remove(container, record, it) {
    const inZentao = it.source === 'zentao' || it.status === 'uploaded';
    const ok = await Confirm.show(
      '删除附件',
      inZentao
        ? `确定删除「${it.name}」吗？禅道里的这个附件${it.kind === 'image' ? '以及正文里对应的图片' : ''}也会被删除，无法恢复。`
        : `确定删除「${it.name}」吗？`
    );
    if (!ok) return;
    try {
      const r = await AttachmentApi.remove(record.id, it.key);
      // 附件删掉了、正文图片没删掉：如实提示，而不是报成功
      if (/未能移除/.test(r.message || '')) Toast.warning(r.message, 8000);
      else Toast.success('附件已删除');
    } catch (err) {
      Toast.error(`删除失败：${err.message}`);
    }
    await this.refresh(container, record);
    if (container._attOpts && container._attOpts.onChanged) container._attOpts.onChanged();
  },

  /** 详情关闭时释放预览占用的内存 */
  releasePreviews() {
    this._previewUrls.forEach(u => URL.revokeObjectURL(u));
    this._previewUrls.clear();
  }
};

/**
 * 图片预览层（全页共用一个）
 *   show(url, name)                 单张
 *   gallery(recordId, items, index) 多张，左右切换（按需读取，已读过的缓存）
 */
const AttachmentPreview = {
  _items: null,
  _index: 0,
  _recordId: null,
  _cache: new Map(),

  ensure() {
    let el = document.getElementById('attPreview');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'attPreview';
    el.className = 'att-preview';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.innerHTML = `
      <figure><img alt=""><figcaption></figcaption></figure>
      <button type="button" class="att-preview-nav att-preview-prev" aria-label="上一张">‹</button>
      <button type="button" class="att-preview-nav att-preview-next" aria-label="下一张">›</button>
      <button type="button" class="att-preview-close" aria-label="关闭预览">×</button>`;
    el.addEventListener('click', (e) => {
      if (e.target === el || e.target.classList.contains('att-preview-close')) this.hide();
      else if (e.target.classList.contains('att-preview-prev')) this.step(-1);
      else if (e.target.classList.contains('att-preview-next')) this.step(1);
    });
    document.addEventListener('keydown', (e) => {
      if (!el.classList.contains('active')) return;
      if (e.key === 'Escape') { e.stopPropagation(); this.hide(); }
      else if (e.key === 'ArrowLeft') this.step(-1);
      else if (e.key === 'ArrowRight') this.step(1);
    }, true);
    document.body.appendChild(el);
    return el;
  },

  show(url, name) {
    this._items = null;
    this.render(url, name, false);
  },

  async gallery(recordId, items, index = 0) {
    this._recordId = recordId;
    this._items = items;
    this._index = index;
    await this.showCurrent();
  },

  async showCurrent() {
    const it = this._items[this._index];
    const key = `${this._recordId}|${it.key}`;
    let url = this._cache.get(key);
    const el = this.ensure();
    if (!url) {
      el.querySelector('figcaption').textContent = `${it.name}（加载中…）`;
      el.classList.add('active');
      try {
        url = await AttachmentApi.blobUrl(AttachmentApi.contentUrl(this._recordId, it));
        this._cache.set(key, url);
      } catch (err) {
        el.querySelector('figcaption').textContent = `${it.name}：预览失败（${err.message}）`;
        return;
      }
    }
    const caption = this._items.length > 1 ? `${it.name}（${this._index + 1} / ${this._items.length}）` : it.name;
    this.render(url, caption, this._items.length > 1);
  },

  step(delta) {
    if (!this._items || this._items.length < 2) return;
    this._index = (this._index + delta + this._items.length) % this._items.length;
    this.showCurrent();
  },

  render(url, caption, withNav) {
    const el = this.ensure();
    const img = el.querySelector('img');
    img.src = url;
    img.alt = caption || '';
    el.querySelector('figcaption').textContent = caption || '';
    el.querySelectorAll('.att-preview-nav').forEach(b => { b.hidden = !withNav; });
    el.classList.add('active');
  },

  hide() {
    const el = document.getElementById('attPreview');
    if (el) el.classList.remove('active');
  }
};

/**
 * 把浮层放在锚点元素下方（放不下就放上方），并在点击外部 / Esc / 滚动时关闭
 * @returns {Function} 关闭函数
 */
function placePopover(popover, anchor, onClose) {
  document.body.appendChild(popover);
  const rect = anchor.getBoundingClientRect();
  const width = popover.offsetWidth || 320;
  const height = popover.offsetHeight || 240;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
  const below = rect.bottom + 6;
  const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 6) : below;
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;

  const controller = new AbortController();
  const close = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    popover.remove();
    if (onClose) onClose();
  };
  // 推迟到下一轮再监听，避免打开它的那次点击立刻把它关掉
  setTimeout(() => {
    if (controller.signal.aborted) return;
    document.addEventListener('mousedown', (e) => { if (!popover.contains(e.target) && !document.querySelector('#attPreview.active')) close(); }, { signal: controller.signal, capture: true });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !document.querySelector('#attPreview.active')) close(); }, { signal: controller.signal });
    window.addEventListener('resize', close, { signal: controller.signal });
  }, 0);
  return close;
}

/**
 * 卡片上点附件角标：一张图直接预览；一个文件直接下载；多个时弹出附件浮层
 */
const AttachmentQuickView = {
  _close: null,

  async open(recordId, anchor) {
    if (this._close) this._close();
    let data;
    try {
      data = await AttachmentApi.list(recordId, { remote: true });
    } catch (err) {
      Toast.error(`读取附件失败：${err.message}`);
      return;
    }
    const items = data.items || [];
    if (items.length === 0) {
      Toast.info('暂无附件');
      return;
    }
    const images = items.filter(i => i.kind === 'image');
    if (items.length === 1) {
      if (images.length === 1) AttachmentPreview.gallery(recordId, images, 0);
      else AttachmentApi.download(recordId, items[0]).catch(err => Toast.error(`下载失败：${err.message}`));
      return;
    }

    const pop = document.createElement('div');
    pop.className = 'att-quickview';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', '附件');
    pop.innerHTML = `
      <div class="att-quickview-head">📎 附件（${items.length}）</div>
      <div class="att-quickview-grid">
        ${items.map((it, i) => `
          <button type="button" class="att-quickview-item" data-index="${i}" title="${it.kind === 'image' ? '预览' : '下载'} ${escapeHtml(it.name)}">
            ${it.kind === 'image' ? '<img class="att-thumb" alt="" data-lazy="1">' : `<span class="att-icon">${AttachmentRules.ICONS[it.kind] || AttachmentRules.ICONS.other}</span>`}
            <span class="att-name">${escapeHtml(it.name)}</span>
            <span class="att-size">${AttachmentRules.formatSize(it.size)}${it.status !== 'uploaded' ? ` · ${escapeHtml(ATTACHMENT_STATUS_TEXT[it.status] || '')}` : ''}</span>
          </button>`).join('')}
      </div>`;
    this._close = placePopover(pop, anchor, () => { this._close = null; });

    pop.querySelectorAll('.att-quickview-item').forEach(btn => {
      const it = items[Number(btn.dataset.index)];
      btn.addEventListener('click', () => {
        if (it.kind === 'image') AttachmentPreview.gallery(recordId, images, images.indexOf(it));
        else AttachmentApi.download(recordId, it).catch(err => Toast.error(`下载失败：${err.message}`));
      });
      const thumb = btn.querySelector('img[data-lazy]');
      if (thumb) {
        AttachmentApi.blobUrl(AttachmentApi.contentUrl(recordId, it))
          .then(url => { AttachmentPreview._cache.set(`${recordId}|${it.key}`, url); thumb.src = url; })
          .catch(() => { thumb.replaceWith(Object.assign(document.createElement('span'), { className: 'att-icon', textContent: AttachmentRules.ICONS.image })); });
      }
    });
  }
};

/**
 * 卡片上的附件角标：总数 +（有的话）待上传 / 失败提示
 * 只统计本地记录的附件；在禅道网页上加的附件在详情里能看到。
 */
function attachmentBadgeHTML(record) {
  const list = (record && record.attachments) || [];
  if (!list.length) return '';
  const failed = list.filter(a => a.status === 'failed').length;
  const pending = list.filter(a => a.status === 'pending' || a.status === 'uploading').length;
  const parts = [`<button type="button" class="att-badge att-badge-view" data-att-view="${escapeHtml(record.id)}" title="查看附件（${list.length} 个）">📎 ${list.length}</button>`];
  if (failed) {
    parts.push(`<button type="button" class="att-badge att-badge-error" data-att-retry="${escapeHtml(record.id)}" title="点击重试上传">${failed} 个未上传 · 重试</button>`);
  } else if (pending && record.zentaoId) {
    // 已同步到禅道：后端正在推送。观察到推送结束后自动刷新角标
    parts.push(`<span class="att-badge att-badge-pending" title="正在上传到禅道">${pending} 个上传中</span>`);
    AttachmentWatcher.watch(record.id);
  } else if (pending) {
    parts.push(`<span class="att-badge att-badge-pending" title="同步到禅道后自动上传">${pending} 个待上传</span>`);
  }
  return parts.join('');
}

// 角标上的「查看附件」：全局委托一次
document.addEventListener('click', (e) => {
  const btn = e.target && e.target.closest && e.target.closest('[data-att-view]');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  AttachmentQuickView.open(btn.dataset.attView, btn);
}, true);

// 角标上的「重试」：全局委托一次（卡片会频繁重建，不能逐个绑定）
document.addEventListener('click', async (e) => {
  const btn = e.target && e.target.closest && e.target.closest('[data-att-retry]');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  btn.disabled = true;
  try {
    const r = await AttachmentApi.sync(btn.dataset.attRetry);
    if (r.success) Toast.success(r.uploaded ? `已上传 ${r.uploaded} 个附件` : r.message);
    else Toast.error(`上传失败：${r.message}`);
  } catch (err) {
    Toast.error(`上传失败：${err.message}`);
  }
  if (typeof window.onAttachmentsChanged === 'function') window.onAttachmentsChanged();
}, true);
