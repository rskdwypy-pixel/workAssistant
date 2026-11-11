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

  show() {
    if (!this.container) {
      this.container = document.getElementById('memoMode');
      this.render();
      this.startAutoSync();
    }
    this.loadList();
    this.syncDownload();
  },

  startAutoSync() {
    if (this.autoSyncTimer) return;
    this.autoSyncTimer = setInterval(() => this.syncDownload(), 5 * 60 * 1000);
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
        <button class="memo-new-btn">＋ 新建</button>
      </div>
      <div class="memo-list" id="memoList"></div>
    `;
    this.container.querySelector('.memo-search').addEventListener('input', (e) => {
      this.keyword = e.target.value;
      this.loadList();
    });
    this.container.querySelector('.memo-new-btn').addEventListener('click', () => this.openEditor());
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
      // 双击 → 预览
      card.addEventListener('dblclick', (e) => {
        if (e.target.closest('.memo-card-actions')) return;
        this.previewMemo(id);
      });
      // 右键 → 预览
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.previewMemo(id);
      });
      card.querySelector('.memo-sync-single').addEventListener('click', (e) => {
        e.stopPropagation();
        this.syncSingle(id);
      });
      card.querySelector('.memo-sync-lib').addEventListener('click', (e) => {
        e.stopPropagation();
        this.setSyncLib(id);
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
    const createdAt = m.createdAt ? new Date(m.createdAt).toLocaleDateString() : '';
    const updatedAt = m.updatedAt ? new Date(m.updatedAt).toLocaleString() : '';
    const syncLib = m.syncLibId ? esc(m.syncLibId) : '未设置';

    return `
      <div class="memo-card ${m.pinned ? 'pinned' : ''}" data-id="${m.id}" style="border-left: 3px solid ${color};">
        ${pinHtml}
        <div class="memo-card-body">
          <div class="memo-card-title">${esc(m.title)} ${dirtyHtml}</div>
          ${preview ? `<div class="memo-card-preview">${esc(preview)}</div>` : ''}
          ${tagsHtml ? `<div class="memo-card-tags">${tagsHtml}</div>` : ''}
          <div class="memo-card-meta">
            <span>创建：${esc(createdAt)}</span>
            <span>更新：${esc(updatedAt)}</span>
            <span>同步：${syncLib}</span>
          </div>
        </div>
        <div class="memo-card-actions">
          <button class="memo-sync-single" title="立即同步">同步</button>
          <button class="memo-sync-lib" title="设置同步文档库">设置</button>
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

    const overlay = showModal(`
      <h3 class="memo-modal-title">${esc(memo.title)}</h3>
      ${tagsHtml ? `<div class="memo-preview-tags">${tagsHtml}</div>` : ''}
      ${dateStr ? `<div class="memo-preview-date">${esc(dateStr)}</div>` : ''}
      ${contentHtml}
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
    });
  },

  // ==================== 编辑器 ====================

  openEditor(id) {
    const memo = id ? this.memos.find(m => m.id === id) : null;
    if (id && !memo) return;

    const title = memo ? memo.title : '';
    const content = memo ? memo.content : '';
    const tags = memo ? (memo.tags || []).join(', ') : '';

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
      </div>
      <div class="memo-modal-actions">
        <button class="memo-btn memo-btn-cancel">取消</button>
        <button class="memo-btn memo-btn-primary" id="memoEditSave">保存</button>
      </div>
    `, (overlay) => {
      const input = overlay.querySelector('#memoEditTitle');
      input.focus();
      input.addEventListener('keydown', (e) => {
        // e.isComposing：输入法正在输入（组合状态）时为 true，避免回车上屏触发保存
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); overlay.querySelector('#memoEditSave').click(); }
      });
      overlay.querySelector('.memo-btn-cancel').addEventListener('click', () => overlay.remove());
      overlay.querySelector('#memoEditSave').addEventListener('click', async () => {
        const t = input.value.trim();
        if (!t) { _toast.warning('请填写标题'); return; }
        const c = overlay.querySelector('#memoEditContent').value;
        const tagStr = overlay.querySelector('#memoEditTags').value.trim();
        const tags = tagStr ? tagStr.split(/[,，]/).map(s => s.trim()).filter(Boolean) : [];
        try {
          if (memo) {
            await MemoApi.update(memo.id, { title: t, content: c, tags });
          } else {
            await MemoApi.create({ title: t, content: c, tags });
          }
          overlay.remove();
          await this.loadList();
          _toast.success(memo ? '已更新' : '已创建');
          await this.afterEdit();
        } catch (err) {
          _toast.error(err.message);
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

  async syncSingle(id) {
    const memo = this.memos.find(m => m.id === id);
    if (!memo) return;
    if (!memo.syncLibId) {
      this.setSyncLib(id);
      return;
    }
    try {
      const r = await MemoApi.syncPush();
      await this.loadList();
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

  async afterEdit() {
    const dirty = this.memos.filter(m => m.syncDirty);
    if (dirty.length === 0) return;

    const noSyncLib = dirty.filter(m => !m.syncLibId);
    if (noSyncLib.length > 0) {
      // 优先用全局默认文档库
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
        // 没有默认文档库，弹出选择
        this.openLibPicker((libId) => {
          Promise.all(noSyncLib.map(m =>
            MemoApi.setSyncLib(m.id, libId)
          )).then(() => {
            this.loadList();
            _toast.success('已自动同步');
          }).catch(err => _toast.error(err.message));
        });
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

  async syncAll() {
    try {
      const r = await MemoApi.syncPush();
      await this.loadList();
      if (r.failed > 0) {
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
