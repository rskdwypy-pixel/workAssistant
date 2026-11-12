/**
 * 便签页：卡片便签式列表 + 双击/右键预览 + 自动同步
 *
 * 挂 window.MemoPage = MemoPage
 * 同步：加密内容存禅道文档库，标题明文、正文密文
 * 每条便签可单独设置同步目标（syncLibId）
 */

// ==================== API ====================

const MEMO_API_BASE = (typeof API_BASE_URL !== 'undefined') ? API_BASE_URL
  : ((typeof ConfigStore !== 'undefined') ? ConfigStore.backendUrl() : 'http://127.0.0.1:3721');

const MemoApi = {
  async list(keyword = '') {
    const r = await fetch(`${MEMO_API_BASE}/api/memos?keyword=${encodeURIComponent(keyword)}`);
    const j = await r.json();
    return j.success ? j.data : [];
  },
  async create({ title, content, tags, syncLibId }) {
    const r = await fetch(`${MEMO_API_BASE}/api/memos`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, content, tags, syncLibId })
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.message || '创建失败');
    return j.data;
  },
  async update(id, patch) {
    const r = await fetch(`${MEMO_API_BASE}/api/memos/${id}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.message || '更新失败');
    return j.data;
  },
  async delete(id) {
    const r = await fetch(`${MEMO_API_BASE}/api/memos/${id}`, { method: 'DELETE' });
    const j = await r.json();
    if (!j.success) throw new Error(j.message || '删除失败');
    return j.data;
  },
  async togglePin(id) {
    const r = await fetch(`${MEMO_API_BASE}/api/memos/${id}/pin`, { method: 'POST' });
    const j = await r.json();
    if (!j.success) throw new Error(j.message || '操作失败');
    return j.data;
  },
  async setSyncLib(id, libId) {
    const r = await fetch(`${MEMO_API_BASE}/api/memos/${id}/sync-lib`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ libId })
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.message || '设置失败');
    return j.data;
  },
  async syncOne(id) {
    const r = await fetch(`${MEMO_API_BASE}/api/memos/${id}/sync`, { method: 'POST' });
    const j = await r.json();
    if (!j.success) throw new Error(j.message || '同步失败');
    return j.data;
  },
  /** 给便签追加附件（文件传到它对应的禅道文档；请求体就是文件本身） */
  async addAttachment(id, file) {
    const r = await fetch(`${MEMO_API_BASE}/api/memos/${encodeURIComponent(id)}/attachments?name=${encodeURIComponent(file.name)}&mime=${encodeURIComponent(file.type || '')}`, {
      method: 'POST', body: file
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.message || '上传失败');
    return j.data;
  },
  /** 附件下载 / 预览地址（后端带禅道会话代理） */
  fileUrl(fileId, name, download) {
    const q = new URLSearchParams();
    if (download) q.set('download', '1');
    if (name) q.set('name', name);
    const s = q.toString();
    return `${MEMO_API_BASE}/api/zentao/files/${encodeURIComponent(fileId)}/content${s ? `?${s}` : ''}`;
  },
  async syncLibs() {
    const r = await fetch(`${MEMO_API_BASE}/api/memos/sync/libs`);
    const j = await r.json();
    return j.success ? j.data : [];
  },
  async syncPull() {
    const r = await fetch(`${MEMO_API_BASE}/api/memos/sync/pull`, { method: 'POST' });
    const j = await r.json();
    return j.success ? j.data : { skipped: true };
  },
  async syncPush() {
    const r = await fetch(`${MEMO_API_BASE}/api/memos/sync/push`, { method: 'POST' });
    const j = await r.json();
    return j.success ? j.data : { skipped: true };
  },
  async getSyncConfig() {
    const r = await fetch(`${MEMO_API_BASE}/api/memos/sync/config`);
    const j = await r.json();
    return j.success ? j.data : { defaultLibId: '' };
  },
  async setSyncConfig(defaultLibId) {
    const r = await fetch(`${MEMO_API_BASE}/api/memos/sync/config`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultLibId })
    });
    const j = await r.json();
    if (!j.success) throw new Error(j.message || '设置失败');
    return j.data;
  },
};

// ==================== 工具 ====================

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 标签 → 卡片左边框颜色 */
const TAG_COLORS = {
  '工作': '#3b82f6',
  '会议': '#10b981',
  '生活': '#f59e0b',
  '学习': '#8b5cf6',
  '想法': '#ec4899',
  '购物': '#06b6d4',
  '旅行': '#f97316',
  '其他': '#6b7280'
};

function renderMarkdown(md) {
  if (!md) return '<p class="memo-preview-empty">（无内容）</p>';
  let html = esc(md);
  html = html.replace(/```([\s\S]*?)```/g, (m, code) => `<pre class="memo-preview-code">${code}</pre>`);
  html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>')
    .replace(/^#####\s+(.+)$/gm, '<h5>$1</h5>')
    .replace(/^####\s+(.+)$/gm, '<h4>$1</h4>')
    .replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
    .replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
    .replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(?<!\*)\*(.+?)\*(?!\*)/g, '<em>$1</em>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  html = html.replace(/(?:^|\n)((?:- .+(?:\n|$))+)/g, (m, block) => {
    const items = block.trim().split('\n').map(l => l.replace(/^- /, '')).map(l => `<li>${l}</li>`).join('');
    return `\n<ul>${items}</ul>`;
  });
  html = html.replace(/(?:^|\n)((?:\d+\. .+(?:\n|$))+)/g, (m, block) => {
    const items = block.trim().split('\n').map(l => l.replace(/^\d+\. /, '')).map(l => `<li>${l}</li>`).join('');
    return `\n<ol>${items}</ol>`;
  });
  html = html.replace(/\n{2,}/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  return `<div class="memo-preview-content">${html}</div>`;
}

const _toast = (typeof Toast !== 'undefined') ? Toast : {
  success: (m) => console.log('[memo]', m),
  error: (m) => console.error('[memo]', m),
  warning: (m) => console.warn('[memo]', m)
};

// ==================== 模态框 ====================

function showModal(html, onMount) {
  const overlay = document.createElement('div');
  overlay.className = 'memo-modal-overlay';
  overlay.innerHTML = `<div class="memo-modal">${html}</div>`;
  document.body.appendChild(overlay);
  if (onMount) onMount(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  // Esc 关闭最上层的便签弹窗（不影响别的模块）
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
    }
  };
  document.addEventListener('keydown', onKey, true);
  const origRemove = overlay.remove.bind(overlay);
  overlay.remove = () => {
    document.removeEventListener('keydown', onKey, true);
    origRemove();
  };
  return overlay;
}

function showConfirm(message, onOk) {
  const overlay = showModal(`
    <h3 class="memo-modal-title">确认</h3>
    <p class="memo-modal-text">${esc(message)}</p>
    <div class="memo-modal-actions">
      <button class="memo-btn memo-btn-cancel">取消</button>
      <button class="memo-btn memo-btn-danger">确定</button>
    </div>
  `, (overlay) => {
    overlay.querySelector('.memo-btn-cancel').addEventListener('click', () => overlay.remove());
    overlay.querySelector('.memo-btn-danger').addEventListener('click', async () => {
      overlay.remove();
      await onOk();
    });
  });
}

// ==================== 页面 ====================

const MemoPage = {
  container: null,
  memos: [],
  keyword: '',
  activeTag: '',
  libNameMap: {},   // libId → 库名（卡片/预览里显示库名而不是裸 ID）
  _searchTimer: null,

  show() {
    if (!this.container) {
      this.container = document.getElementById('memoMode');
      this.render();
    }
    this.loadList();
    this.loadLibNames();
    this.syncDownload();
  },
  // 定时同步由全局 AutoSync 统一负责（与任务 / Bug 同节奏），这里不再自设计时器

  async loadLibNames() {
    try {
      const libs = await MemoApi.syncLibs();
      const map = {};
      (libs || []).forEach(l => { map[String(l.id)] = l.name || ''; });
      this.libNameMap = map;
      // 库名是异步到的，列表已经画过一轮的话补画一次，别让「同步：185」留在界面上
      if (this.memos.length) this.renderList();
    } catch {
      // 拿不到库名就按原样显示
    }
  },

  libNameOf(id) {
    return this.libNameMap[String(id)] || (id ? `库 ${id}` : '');
  },

  async syncDownload() {
    try {
      await MemoApi.syncPull();
      await this.loadList();
    } catch (err) {
      // 忽略同步失败，下次定时再试
    }
  },

  async loadList() {
    try {
      let memos = await MemoApi.list(this.keyword);
      if (this.activeTag) {
        memos = memos.filter(m => (m.tags || []).includes(this.activeTag));
      }
      this.memos = memos;
      this.renderList();
      this.renderTagsCloud();
    } catch (err) {
      const list = this.container.querySelector('#memoList');
      if (list) list.innerHTML = `<div class="memo-error">加载失败：${esc(err.message)}</div>`;
    }
  },

  render() {
    this.container.innerHTML = `
      <div class="memo-header">
        <input type="text" class="memo-search" placeholder="搜索便签..." value="${esc(this.keyword)}">
        <div class="memo-tags-cloud" id="memoTagsCloud"></div>
        <div class="memo-header-actions">
          <button class="memo-sync-all-btn" title="与禅道双向同步全部便签">⇅ 同步</button>
          <button class="memo-new-btn">＋ 新建</button>
        </div>
      </div>
      <div class="memo-list" id="memoList"></div>
    `;
    this.container.querySelector('.memo-search').addEventListener('input', (e) => {
      // 防抖：停顿 300ms 才查一次，避免每个按键都打一次后端
      clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => {
        this.keyword = e.target.value;
        this.loadList();
      }, 300);
    });
    this.container.querySelector('.memo-new-btn').addEventListener('click', () => this.openEditor());
    this.container.querySelector('.memo-sync-all-btn').addEventListener('click', () => this.syncAll());
  },

  renderList() {
    const list = this.container.querySelector('#memoList');
    if (!list) return;
    if (this.memos.length === 0) {
      list.innerHTML = '<div class="memo-empty">暂无便签，点「＋ 新建」记一条</div>';
      return;
    }
    list.innerHTML = this.memos.map(m => this.renderCard(m)).join('');
    list.querySelectorAll('.memo-card').forEach(card => {
      const id = card.dataset.id;
      // 单击卡片 → 预览（按钮区域除外）；不再劫持右键菜单
      card.addEventListener('click', (e) => {
        if (e.target.closest('.memo-card-actions')) return;
        this.previewMemo(id);
      });
      card.querySelector('.memo-pin').addEventListener('click', (e) => {
        e.stopPropagation();
        this.togglePin(id);
      });
      card.querySelector('.memo-edit').addEventListener('click', (e) => {
        e.stopPropagation();
        this.openEditor(id);
      });
      card.querySelector('.memo-delete').addEventListener('click', (e) => {
        e.stopPropagation();
        this.confirmDelete(id);
      });
    });
  },

  renderTagsCloud() {
    const cloud = this.container.querySelector('#memoTagsCloud');
    if (!cloud) return;
    const tagCount = {};
    this.memos.forEach(m => {
      (m.tags || []).forEach(t => {
        tagCount[t] = (tagCount[t] || 0) + 1;
      });
    });
    const tags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]);
    if (tags.length === 0) {
      cloud.innerHTML = '<span class="memo-tag-empty">无标签</span>';
      return;
    }
    const activeTag = this.activeTag || '';
    cloud.innerHTML = `<span class="memo-tag-all ${!activeTag ? 'active' : ''}" data-tag="">全部</span>` +
      tags.map(([tag, count]) => `<span class="memo-tag-item ${activeTag === tag ? 'active' : ''}" data-tag="${esc(tag)}">#${esc(tag)} (${count})</span>`).join('');
    cloud.querySelectorAll('.memo-tag-item, .memo-tag-all').forEach(item => {
      item.addEventListener('click', () => {
        this.activeTag = item.dataset.tag;
        this.loadList();
      });
    });
  },

  renderCard(m) {
    const tag = (m.tags || [])[0] || '';
    const color = TAG_COLORS[tag] || '#6b7280';
    const preview = String(m.content || '').slice(0, 120).replace(/\n/g, ' ');
    const tagsHtml = (m.tags || []).map(t => `<span class="memo-tag">#${esc(t)}</span>`).join('');
    const pinHtml = m.pinned ? '<span class="memo-pin-icon">📌</span>' : '';
    const dirtyHtml = m.syncDirty ? '<span class="memo-dirty">待同步</span>' : '';
    const attachHtml = (m.attachments && m.attachments.length) ? `<span class="memo-attach-badge" title="${m.attachments.length} 个附件">📎 ${m.attachments.length}</span>` : '';
    const createdAt = m.createdAt ? new Date(m.createdAt).toLocaleDateString() : '';
    const updatedAt = m.updatedAt ? new Date(m.updatedAt).toLocaleString() : '';
    // 显示库名而不是裸 ID；没设过同步目标的显示「仅本地」
    const syncLib = m.syncLibId ? esc(this.libNameOf(m.syncLibId)) : '仅本地';

    return `
      <div class="memo-card ${m.pinned ? 'pinned' : ''}" data-id="${m.id}" style="border-left: 3px solid ${color};">
        ${pinHtml}
        <div class="memo-card-body">
          <div class="memo-card-title">${esc(m.title)} ${dirtyHtml} ${attachHtml}</div>
          ${preview ? `<div class="memo-card-preview">${esc(preview)}</div>` : ''}
          ${tagsHtml ? `<div class="memo-card-tags">${tagsHtml}</div>` : ''}
          <div class="memo-card-meta">
            <span>创建：${esc(createdAt)}</span>
            <span>更新：${esc(updatedAt)}</span>
            <span class="memo-card-sync">同步：${syncLib}</span>
          </div>
        </div>
        <div class="memo-card-actions">
          <button class="memo-pin">${m.pinned ? '取消置顶' : '置顶'}</button>
          <button class="memo-edit">编辑</button>
          <button class="memo-delete">删除</button>
        </div>
      </div>
    `;
  },

  // ==================== 预览 ====================

  previewMemo(id) {
    const memo = this.memos.find(m => m.id === id);
    if (!memo) return;

    const tagsHtml = (memo.tags || []).map(t => `<span class="memo-tag">#${esc(t)}</span>`).join('');
    const dateStr = memo.updatedAt ? new Date(memo.updatedAt).toLocaleString() : '';
    const contentHtml = renderMarkdown(memo.content || '');
    const dirtyHtml = memo.syncDirty ? '<span class="memo-dirty">待同步</span>' : '';
    const syncLibName = memo.syncLibId ? esc(this.libNameOf(memo.syncLibId)) : '仅本地（未同步到禅道）';
    const attachments = memo.attachments || [];
    const attachHtml = attachments.length ? `
      <div class="memo-preview-attachments">
        <div class="memo-preview-attach-title">附件（${attachments.length}）</div>
        ${attachments.map(f => `
          <div class="memo-attach-item">
            <span class="memo-attach-name">📎 ${esc(f.name)}${f.size ? ` · ${(f.size / 1024).toFixed(0)} KB` : ''}</span>
            <a href="${esc(MemoApi.fileUrl(f.id, f.name, true))}" download="${esc(f.name)}">下载</a>
          </div>
        `).join('')}
      </div>` : '';

    const overlay = showModal(`
      <h3 class="memo-modal-title">${esc(memo.title)} ${dirtyHtml}</h3>
      ${tagsHtml ? `<div class="memo-preview-tags">${tagsHtml}</div>` : ''}
      ${dateStr ? `<div class="memo-preview-date">${esc(dateStr)}</div>` : ''}
      ${contentHtml}
      ${attachHtml}
      <div class="memo-preview-sync-row">
        <span class="memo-preview-sync-label">同步目标</span>
        <span class="memo-preview-sync-lib">${syncLibName}</span>
        <button class="memo-btn memo-btn-ghost memo-btn-sm" id="memoPreviewAddAttach">＋ 附件</button>
        <button class="memo-btn memo-btn-ghost memo-btn-sm" id="memoPreviewChangeLib">更换</button>
        <button class="memo-btn memo-btn-ghost memo-btn-sm" id="memoPreviewSyncNow">立即同步</button>
      </div>
      <div class="memo-modal-actions">
        <button class="memo-btn memo-btn-danger" id="memoPreviewDelete">删除</button>
        <button class="memo-btn memo-btn-cancel" id="memoPreviewClose">关闭</button>
        <button class="memo-btn memo-btn-primary" id="memoPreviewEdit">编辑</button>
      </div>
    `, (overlay) => {
      overlay.querySelector('#memoPreviewClose').addEventListener('click', () => overlay.remove());
      overlay.querySelector('#memoPreviewEdit').addEventListener('click', () => {
        overlay.remove();
        this.openEditor(id);
      });
      overlay.querySelector('#memoPreviewDelete').addEventListener('click', () => {
        overlay.remove();
        this.confirmDelete(id);
      });
      overlay.querySelector('#memoPreviewChangeLib').addEventListener('click', () => {
        overlay.remove();
        this.setSyncLib(id);
      });
      // 预览里直接加附件：选完立即上传（大文件逐个传，完成后刷新预览）
      overlay.querySelector('#memoPreviewAddAttach').addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.onchange = async () => {
          const list = [...input.files];
          if (!list.length) return;
          let ok = 0; const failed = [];
          for (const f of list) {
            if (f.size > 50 * 1024 * 1024) { failed.push(`${f.name}（超过 50MB）`); continue; }
            try { await MemoApi.addAttachment(id, f); ok++; }
            catch (err) { failed.push(`${f.name}（${err.message}）`); }
          }
          if (ok) {
            _toast.success(`已上传 ${ok} 个附件`);
            await this.loadList();
            overlay.remove();
            this.previewMemo(id); // 重新打开以显示新附件
          }
          if (failed.length) _toast.warning(`附件没传上去：${failed.join('、')}`);
        };
        input.click();
      });
      overlay.querySelector('#memoPreviewSyncNow').addEventListener('click', async () => {
        await this.syncSingle(id);
        overlay.remove();
      });
    });
  },

  // ==================== 编辑器 ====================

  openEditor(id) {
    const memo = id ? this.memos.find(m => m.id === id) : null;
    if (id && !memo) return;

    const title = memo ? memo.title : '';
    const content = memo ? memo.content : '';
    const tags = memo ? (memo.tags || []).join(', ') : '';
    const existingFiles = memo ? (memo.attachments || []) : [];

    const overlay = showModal(`
      <h3 class="memo-modal-title">${memo ? '编辑便签' : '新建便签'}</h3>
      <div class="memo-form">
        <div class="memo-form-row">
          <label>标题 <span class="memo-required">*</span></label>
          <input type="text" class="memo-input" id="memoEditTitle" value="${esc(title)}" placeholder="给这条便签起个标题">
        </div>
        <div class="memo-form-row">
          <label>正文</label>
          <textarea class="memo-textarea" id="memoEditContent" rows="8" placeholder="支持 Markdown...">${esc(content)}</textarea>
        </div>
        <div class="memo-form-row">
          <label>标签</label>
          <input type="text" class="memo-input" id="memoEditTags" value="${esc(tags)}" placeholder="用逗号分隔，如：工作, 会议">
        </div>
        <div class="memo-form-row">
          <label>附件 <small class="memo-attach-hint">存到禅道文档，单个不超过 50MB；多端可见（文件本身不加密）</small></label>
          <div class="memo-attach-box" id="memoEditAttach">
            ${existingFiles.map(f => `
              <div class="memo-attach-item memo-attach-existing">📎 ${esc(f.name)}${f.size ? ` · ${(f.size / 1024).toFixed(0)} KB` : ''}</div>
            `).join('')}
            <button type="button" class="memo-btn memo-btn-ghost memo-btn-sm" id="memoEditAttachPick">＋ 添加附件</button>
            <input type="file" id="memoEditAttachInput" multiple hidden>
          </div>
        </div>
      </div>
      <div class="memo-modal-actions">
        <button class="memo-btn memo-btn-cancel">取消</button>
        <button class="memo-btn memo-btn-primary" id="memoEditSave">保存</button>
      </div>
    `, (overlay) => {
      const input = overlay.querySelector('#memoEditTitle');
      input.focus();
      const pending = []; // 保存后一起上传的附件

      const renderPending = () => {
        overlay.querySelectorAll('.memo-attach-pending').forEach(el => el.remove());
        const pick = overlay.querySelector('#memoEditAttachPick');
        pending.forEach((f, i) => {
          const div = document.createElement('div');
          div.className = 'memo-attach-item memo-attach-pending';
          div.innerHTML = `<span>⏳ ${esc(f.name)} · ${(f.size / 1024).toFixed(0)} KB</span><button type="button" class="memo-attach-rm" title="不上传">✕</button>`;
          div.querySelector('.memo-attach-rm').addEventListener('click', () => { pending.splice(i, 1); renderPending(); });
          overlay.querySelector('#memoEditAttach').insertBefore(div, pick);
        });
      };
      overlay.querySelector('#memoEditAttachPick').addEventListener('click', () => overlay.querySelector('#memoEditAttachInput').click());
      overlay.querySelector('#memoEditAttachInput').addEventListener('change', (e) => {
        for (const f of e.target.files) {
          if (f.size > 50 * 1024 * 1024) { _toast.warning(`${f.name} 超过 50MB`); continue; }
          if (!pending.some(x => x.name === f.name && x.size === f.size)) pending.push(f);
        }
        e.target.value = '';
        renderPending();
      });

      const trySave = () => overlay.querySelector('#memoEditSave').click();
      input.addEventListener('keydown', (e) => {
        // e.isComposing：输入法正在输入（组合状态）时为 true，避免回车上屏触发保存
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); trySave(); }
      });
      // 正文里 Ctrl/⌘+Enter 也能保存；Esc 关闭由 showModal 统一处理
      overlay.querySelector('#memoEditContent').addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) { e.preventDefault(); trySave(); }
      });
      overlay.querySelector('.memo-btn-cancel').addEventListener('click', () => overlay.remove());
      overlay.querySelector('#memoEditSave').addEventListener('click', async () => {
        const t = input.value.trim();
        if (!t) { _toast.warning('请填写标题'); return; }
        const c = overlay.querySelector('#memoEditContent').value;
        const tagStr = overlay.querySelector('#memoEditTags').value.trim();
        const tags = tagStr ? tagStr.split(/[,，]/).map(s => s.trim()).filter(Boolean) : [];
        const saveBtn = overlay.querySelector('#memoEditSave');
        try {
          saveBtn.disabled = true;
          saveBtn.textContent = pending.length ? '保存并上传附件…' : '保存中…';
          let saved;
          if (memo) {
            saved = await MemoApi.update(memo.id, { title: t, content: c, tags });
          } else {
            saved = await MemoApi.create({ title: t, content: c, tags });
          }
          // 附件在便签保存成功后逐个上传（新便签此时已有 id；没同步目标的会得到明确提示）
          if (pending.length) {
            const failed = [];
            for (const f of pending) {
              try { await MemoApi.addAttachment(saved.id, f); }
              catch (err) { failed.push(`${f.name}（${err.message}）`); }
            }
            if (failed.length) _toast.warning(`附件没传上去：${failed.join('、')}`);
          }
          overlay.remove();
          await this.loadList();
          _toast.success(memo ? '已更新' : '已创建');
          await this.afterEdit();
        } catch (err) {
          _toast.error(err.message);
          saveBtn.disabled = false;
          saveBtn.textContent = '保存';
        }
      });
    });
  },

  async confirmDelete(id) {
    const memo = this.memos.find(m => m.id === id);
    if (!memo) return;
    showConfirm(`确定删除「${memo.title}」吗？`, async () => {
      try {
        await MemoApi.delete(id);
        await this.loadList();
        _toast.success('已删除');
        await this.afterEdit();
      } catch (err) {
        _toast.error(err.message);
      }
    });
  },

  async togglePin(id) {
    try {
      await MemoApi.togglePin(id);
      await this.loadList();
    } catch (err) {
      _toast.error(err.message);
    }
  },

  // ==================== 同步 ====================

  /** 单条同步：只上传这一条，不再牵连全部待同步 */
  async syncSingle(id) {
    const memo = this.memos.find(m => m.id === id);
    if (!memo) return;
    if (!memo.syncLibId) {
      this.setSyncLib(id);
      return;
    }
    try {
      const r = await MemoApi.syncOne(id);
      await this.loadList();
      if (r.skipped) {
        _toast.warning(r.reason || '同步未执行');
      } else if (r.failed > 0) {
        _toast.warning(`同步失败：${(r.errors && r.errors[0] && r.errors[0].error) || '未知错误'}`);
      } else {
        _toast.success('已同步');
      }
    } catch (err) {
      _toast.error(`同步失败：${err.message}`);
    }
  },

  setSyncLib(id) {
    const memo = this.memos.find(m => m.id === id);
    if (!memo) return;
    this.openLibPicker((libId) => {
      MemoApi.setSyncLib(id, libId).then(() => {
        this.loadList();
        _toast.success('已设置同步文档库');
        this.syncSingle(id);
      }).catch(err => _toast.error(err.message));
      MemoApi.setSyncConfig(libId).catch(() => {});
    }, memo.syncLibId);
  },

  /**
   * 编辑 / 新建 / 删除后的自动上传：
   *   - 有默认库但便签还没分配目标 → 先按默认库分配，再上传
   *   - 什么都没配 → 提示一次去设置里配，不打断输入
   */
  async afterEdit() {
    const dirty = this.memos.filter(m => m.syncDirty);
    if (dirty.length === 0) return;

    const noSyncLib = dirty.filter(m => !m.syncLibId);
    if (noSyncLib.length > 0) {
      const config = await MemoApi.getSyncConfig();
      if (config.defaultLibId) {
        // 用默认文档库设置 syncLibId（setSyncLib 会自动创建文档并同步）
        try {
          await Promise.all(noSyncLib.map(m =>
            MemoApi.setSyncLib(m.id, config.defaultLibId)
          ));
          await this.loadList();
          _toast.success('已自动同步');
        } catch (err) {
          _toast.warning('自动同步失败，将稍后重试');
        }
      } else {
        // 没有默认文档库：提示去设置，不弹窗打断（设置入口在 设置 → 禅道集成）
        _toast.warning('未配置同步：可在 设置 → 禅道集成 →「便签默认同步文档库」里开启，便签将加密备份到禅道');
      }
      return;
    }

    try {
      const r = await MemoApi.syncPush();
      await this.loadList();
      if (r.failed > 0) {
        _toast.warning(`自动同步：成功 ${(r.uploaded || 0) + (r.deleted || 0)}，失败 ${r.failed}`);
      } else if ((r.uploaded || 0) + (r.deleted || 0) > 0) {
        _toast.success(`已自动同步 ${(r.uploaded || 0) + (r.deleted || 0)} 条`);
      }
    } catch (err) {
      _toast.error(`自动同步失败：${err.message}`);
    }
  },

  /** 头部「⇅ 同步」：先上传待同步的，再拉取远端 */
  async syncAll() {
    try {
      const r = await MemoApi.syncPush();
      await this.syncDownload();
      if (r.skipped) {
        _toast.warning(r.reason || '同步未执行');
      } else if (r.failed > 0) {
        _toast.warning(`同步完成：成功 ${(r.uploaded || 0) + (r.deleted || 0)}，失败 ${r.failed}`);
      } else if ((r.uploaded || 0) + (r.deleted || 0) > 0) {
        _toast.success(`已同步 ${(r.uploaded || 0) + (r.deleted || 0)} 条`);
      } else {
        _toast.success('已是最新');
      }
    } catch (err) {
      _toast.error(`同步失败：${err.message}`);
    }
  },

  // ==================== 文档库选择 ====================

  openLibPicker(callback, currentLibId) {
    MemoApi.syncLibs().then(libs => {
      if (libs.length === 0) {
        _toast.warning('没有可用的文档库，请先在禅道里创建');
        return;
      }
      const items = libs.map(l => `
        <div class="memo-lib-item ${String(l.id) === String(currentLibId) ? 'selected' : ''}" data-id="${l.id}" data-name="${esc(l.name)}">
          <span class="memo-lib-name">${esc(l.name)}</span>
          <span class="memo-lib-space">${esc(l.spaceLabel || '')}</span>
          ${String(l.id) === String(currentLibId) ? '<span class="memo-lib-check">✓ 当前</span>' : ''}
        </div>
      `).join('');
      const overlay = showModal(`
        <h3 class="memo-modal-title">选择同步文档库</h3>
        <p class="memo-modal-text">便签将加密后存到选定的文档库中，每条便签对应一个文档。修改文档库会删除原文档并在新库重建。</p>
        <div class="memo-lib-list">${items}</div>
        <div class="memo-modal-actions">
          <button class="memo-btn memo-btn-cancel">取消</button>
        </div>
      `, (overlay) => {
        overlay.querySelector('.memo-btn-cancel').addEventListener('click', () => overlay.remove());
        overlay.querySelectorAll('.memo-lib-item').forEach(item => {
          item.addEventListener('click', () => {
            const libId = item.dataset.id;
            overlay.remove();
            if (callback) callback(libId);
          });
        });
      });
    }).catch(err => {
      _toast.error(`获取文档库失败：${err.message}`);
    });
  },
};

window.MemoPage = MemoPage;
