/**
 * 新指派提醒（页面这一侧）
 *
 *   · 右上角铃铛：未读数 + 下拉列表（谁把什么指派给我），点一条标记已读并在禅道里打开
 *   · 设置 → 通知推送：总开关、系统通知、Webhook 推送、发送测试、立即检查（修改即时生效）
 *
 * 检测在后台做（每 5 分钟读一次「指派给我」的列表，见 src/services/assignNotify.js），
 * 这里只是读结果：每分钟拉一次未读列表，回到页面时再拉一次。
 */
const NotifyUI = {
  items: [],
  unread: 0,
  open: false,
  pollMs: 60 * 1000,
  kindMeta: { task: ['📋', '任务'], bug: ['🐞', 'Bug'], story: ['📝', '需求'] },
  typeIcon: { review: '🔎', confirm: '🔄', deadline: '⏰', cc: '📨' },

  /** 一条提醒的一句话描述（和后端 assignNotify.describe 保持一致） */
  describe(n) {
    const label = (this.kindMeta[n.kind] || ['', ''])[1];
    const who = n.actorName || '有人';
    switch (n.type) {
      case 'review': return `${who} 请你评审${label} #${n.objectId}`;
      case 'cc': return `${who} 抄送了${label} #${n.objectId} 给你`;
      case 'confirm': return `${label} #${n.objectId} 关联的需求变更了，请确认`;
      case 'deadline': return n.days === 0 ? `${label} #${n.objectId} 今天截止` : n.days === 1 ? `${label} #${n.objectId} 明天截止` : `${label} #${n.objectId} 已逾期 ${Math.abs(n.days)} 天`;
      default: return `${who} 指派了${label} #${n.objectId}`;
    }
  },

  base() {
    return typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : 'http://127.0.0.1:3721';
  },
  async request(path, body) {
    const init = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const resp = await fetch(`${this.base()}${path}`, init);
    return resp.json();
  },
  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },
  toast(kind, msg) {
    if (typeof Toast !== 'undefined' && Toast[kind]) Toast[kind](msg);
  },

  init() {
    document.getElementById('notifyBellBtn')?.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });
    document.addEventListener('click', (e) => { if (this.open && !e.target.closest('.notify-panel')) this.close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.open) { this.close(); document.getElementById('notifyBellBtn')?.focus(); } });
    document.getElementById('notifyEnabled')?.addEventListener('change', () => this.saveSettings());
    document.getElementById('notifySystem')?.addEventListener('change', () => this.saveSettings());
    document.getElementById('notifyWebhook')?.addEventListener('change', () => this.saveSettings());
    document.querySelectorAll('[data-notify-type]').forEach(b => b.addEventListener('change', () => this.saveSettings()));
    document.getElementById('notifyTestBtn')?.addEventListener('click', () => this.sendTest());
    document.getElementById('notifyCheckBtn')?.addEventListener('click', () => this.checkNow());
    document.querySelector('[data-panel="p-notify"]')?.addEventListener('click', () => this.loadSettings());
    this.loadSettings();
    this.refresh();
    setInterval(() => this.refresh(), this.pollMs);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.refresh(); });
  },

  /** 登录了才显示铃铛（本地模式 / 没配置禅道时没有“指派给我”可言） */
  loggedIn() {
    return typeof Account !== 'undefined' && !!Account.state && Account.state.state !== 'unconfigured';
  },

  async refresh() {
    const bell = document.getElementById('notifyBellBtn');
    if (!bell) return;
    if (!this.loggedIn()) {
      // 账号状态还没读回来：稍后再试一次
      bell.hidden = true;
      if (typeof Account !== 'undefined' && !Account.state) setTimeout(() => this.refresh(), 2000);
      return;
    }
    try {
      const res = await this.request('/api/notifications');
      if (res.success) {
        this.items = res.data.items || [];
        this.unread = res.data.unread || 0;
      }
    } catch {
      /* 连不上后台：保持现状 */
    }
    this.renderBell();
    if (this.open) this.renderPanel();
  },

  renderBell() {
    const bell = document.getElementById('notifyBellBtn');
    const count = document.getElementById('notifyCount');
    if (!bell || !count) return;
    bell.hidden = !this.loggedIn();
    count.hidden = this.unread === 0;
    count.textContent = this.unread > 99 ? '99+' : String(this.unread);
    bell.title = this.unread ? `${this.unread} 条提醒` : '提醒';
    bell.setAttribute('aria-label', bell.title);
  },

  // ==================== 下拉列表 ====================

  toggle() {
    if (this.open) this.close(); else this.show();
  },

  async show() {
    this.close();
    this.open = true;
    document.getElementById('notifyBellBtn')?.setAttribute('aria-expanded', 'true');
    const panel = document.createElement('div');
    panel.className = 'notify-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '新指派提醒');
    panel.addEventListener('click', (e) => this.onPanelClick(e));
    panel.addEventListener('keydown', (e) => {
      const row = e.target.closest && e.target.closest('[data-np-open]');
      if (row && (e.key === 'Enter' || e.key === ' ') && e.target === row) { e.preventDefault(); this.openItem(row.dataset.npOpen); }
    });
    document.getElementById('accountArea')?.appendChild(panel);
    this.renderPanel();
    this.refresh();
  },

  close() {
    document.querySelectorAll('.notify-panel').forEach(p => p.remove());
    this.open = false;
    document.getElementById('notifyBellBtn')?.setAttribute('aria-expanded', 'false');
  },

  rel(iso) {
    const t = new Date(iso).getTime();
    if (!t) return '';
    const m = Math.floor((Date.now() - t) / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return `${m} 分钟前`;
    if (m < 60 * 24) return `${Math.floor(m / 60)} 小时前`;
    const d = new Date(t);
    return `${d.getMonth() + 1}-${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  },

  renderPanel() {
    const panel = document.querySelector('.notify-panel');
    if (!panel) return;
    const rows = this.items.map((n) => {
      const icon = this.typeIcon[n.type] || (this.kindMeta[n.kind] || ['📌'])[0];
      return `<div class="np-item ${n.read ? '' : 'is-unread'}" role="button" tabindex="0" data-np-open="${this.esc(n.id)}">
          <span class="np-icon" aria-hidden="true">${icon}</span>
          <span class="np-body">
            <div class="np-title" title="${this.esc(this.describe(n))}">${this.esc(this.describe(n))}</div>
            <div class="np-title" style="font-weight:400" title="${this.esc(n.title)}">${this.esc(n.title)}</div>
            <div class="np-meta">${this.esc(this.rel(n.at))}${n.deadline && n.type !== 'deadline' ? ` · 截止 ${this.esc(n.deadline)}` : ''}${n.pri ? ` · P${this.esc(n.pri)}` : ''}</div>
          </span>
          ${n.read ? '' : '<span class="np-dot" aria-label="未读"></span>'}
        </div>`;
    }).join('');
    panel.innerHTML = `
      <div class="np-head"><span>提醒${this.unread ? `（${this.unread} 条未读）` : ''}</span>
        <span class="np-head-actions">
          <button type="button" class="np-link" data-np="check">立即检查</button>
          ${this.unread ? '<button type="button" class="np-link" data-np="readall">全部已读</button>' : ''}
        </span></div>
      <div class="np-list">${rows || '<div class="np-empty">暂时没有提醒。<br>别人把任务、Bug、需求指派给你，或有待评审、临近截止的事项时，会在这里提醒你（每 5 分钟检查一次）。</div>'}</div>
      <div class="np-foot"><span class="np-meta">新指派、待评审、截止日等</span><button type="button" class="np-link" data-np="settings">提醒设置</button></div>`;
  },

  async onPanelClick(e) {
    const row = e.target.closest('[data-np-open]');
    if (row) return this.openItem(row.dataset.npOpen);
    const act = e.target.closest('[data-np]');
    if (!act) return;
    if (act.dataset.np === 'readall') {
      await this.request('/api/notifications/read', { ids: 'all' }).catch(() => {});
      await this.refresh();
    } else if (act.dataset.np === 'check') {
      act.textContent = '检查中…';
      await this.checkNow(true);
    } else if (act.dataset.np === 'settings') {
      this.close();
      if (typeof openSettingsModal === 'function') openSettingsModal('p-notify');
    }
  },

  async openItem(id) {
    const n = this.items.find(x => x.id === id);
    if (!n) return;
    this.close();
    if (!n.read) {
      n.read = true;
      this.unread = Math.max(0, this.unread - 1);
      this.renderBell();
      this.request('/api/notifications/read', { ids: [id] }).catch(() => {});
    }
    if (typeof openInZentao === 'function') openInZentao(n.kind, n.objectId);
  },

  /** 不等 5 分钟，立即读一次「指派给我」的列表 */
  async checkNow(fromPanel = false) {
    const btn = document.getElementById('notifyCheckBtn');
    if (btn && !fromPanel) { btn.disabled = true; btn.querySelector('.btn-label').textContent = '检查中…'; }
    try {
      const res = await this.request('/api/notifications/check', {});
      if (!res.success) throw new Error(res.message || '检查失败');
      const d = res.data;
      this.items = d.items || this.items;
      this.unread = d.unread ?? this.unread;
      this.renderBell();
      if (this.open) this.renderPanel();
      const msg = d.skipped === 'unconfigured' ? '还没有登录禅道'
        : d.baseline ? '已记下当前的任务 / Bug / 需求，之后新指派给你的会提醒'
        : d.notified ? `有 ${d.notified} 项新指派给你`
        : '没有新的指派';
      this.toast(d.notified ? 'success' : 'info', msg);
      const r = document.getElementById('notifyTestResult');
      if (r && !fromPanel) { r.textContent = msg; r.className = 'test-result'; }
    } catch (err) {
      this.toast('error', `检查失败：${err.message}`);
    } finally {
      if (btn && !fromPanel) { btn.disabled = false; btn.querySelector('.btn-label').textContent = '立即检查'; }
    }
  },

  // ==================== 设置 ====================

  async loadSettings() {
    try {
      const res = await this.request('/api/notify/settings');
      if (res.success) this.renderSettings(res.data);
    } catch {
      /* 连不上后台：保持现状 */
    }
  },

  renderSettings(s) {
    const en = document.getElementById('notifyEnabled');
    const sys = document.getElementById('notifySystem');
    const hook = document.getElementById('notifyWebhook');
    if (!en || !sys || !hook) return;
    en.checked = !!s.enabled;
    sys.checked = !!s.system;
    hook.checked = !!s.webhook;
    sys.disabled = !s.enabled;
    hook.disabled = !s.enabled;
    const hint = document.getElementById('notifyHint');
    if (hint) {
      hint.textContent = s.webhookConfigured
        ? '每 5 分钟检查一次「指派给我」的列表。浏览器关着时系统通知和 Webhook 也会发。'
        : '每 5 分钟检查一次「指派给我」的列表。想推到群里，先在下面填好 Webhook 地址并保存。';
    }
    document.querySelectorAll('[data-notify-type]').forEach((box) => {
      box.checked = !!(s.types && s.types[box.dataset.notifyType]);
      box.disabled = !s.enabled;
    });
    this.settings = s;
  },

  async saveSettings() {
    const body = {
      enabled: document.getElementById('notifyEnabled').checked,
      system: document.getElementById('notifySystem').checked,
      webhook: document.getElementById('notifyWebhook').checked,
      types: Object.fromEntries([...document.querySelectorAll('[data-notify-type]')].map(b => [b.dataset.notifyType, b.checked]))
    };
    try {
      const res = await this.request('/api/notify/settings', body);
      if (res.success) this.renderSettings(res.data);
      else this.toast('error', res.message || '保存失败');
    } catch (err) {
      this.toast('error', `保存失败：${err.message}`);
    }
  },

  async sendTest() {
    const btn = document.getElementById('notifyTestBtn');
    const out = document.getElementById('notifyTestResult');
    btn.disabled = true;
    btn.querySelector('.btn-label').textContent = '发送中…';
    try {
      const res = await this.request('/api/notifications/test', {});
      if (!res.success) throw new Error(res.message || '发送失败');
      const d = res.data;
      const parts = [];
      parts.push(d.system ? '系统通知 ✓' : '系统通知 未发送（已关闭或失败）');
      parts.push(d.webhook ? 'Webhook ✓' : (d.webhookConfigured ? 'Webhook 未发送（已关闭或失败）' : 'Webhook 未配置'));
      out.textContent = parts.join('　');
      out.className = `test-result ${d.system || d.webhook ? 'success' : 'error'}`;
    } catch (err) {
      out.textContent = `发送失败：${err.message}`;
      out.className = 'test-result error';
    } finally {
      btn.disabled = false;
      btn.querySelector('.btn-label').textContent = '发送测试';
    }
  }
};

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => NotifyUI.init());
  else NotifyUI.init();
}
