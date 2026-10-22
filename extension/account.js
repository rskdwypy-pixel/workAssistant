/**
 * 账号：登录卡片、右上角头像与用户菜单、本地模式、重置为首次使用（调试）
 *
 * 登录状态由后端 GET /api/account 给出：
 *   unconfigured  第一次使用 / 退出登录 / 重置后 → 弹登录卡片（可「稍后再说」进入本地模式）
 *   invalid       账号密码失效（如在禅道里改了密码）→ 头像红点 + 弹「只需输入密码」的登录卡片
 *   offline       连不上禅道（VPN 等）→ 头像灰点，不弹登录卡片
 *   ok            已登录 → 头像绿点
 * 本地模式（未登录且点了「稍后再说」）：右上角「登录禅道」按钮；依赖禅道的功能给出提示而不是报错。
 */

const AccountApi = {
  base() {
    return typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : 'http://127.0.0.1:3721';
  },
  async request(path, init) {
    const resp = await fetch(`${this.base()}${path}`, init);
    const json = await resp.json().catch(() => ({ success: false, message: `HTTP ${resp.status}` }));
    // 403：后台在运行，但不认这个插件（多半是旧版本的后台，只认旧的扩展 ID）
    if (resp.status === 403) json.rejected = true;
    return json;
  },
  post(path, body) {
    return this.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  },
  state(refresh) { return this.request(`/api/account${refresh ? '?refresh=1' : ''}`); },
  login(body) { return this.post('/api/account/login', body); },
  logout() { return this.post('/api/account/logout'); },
  reset(includeData) { return this.post('/api/account/reset', { includeData }); }
};

const ACCOUNT_SKIP_KEY = 'waLoginSkipped';
const INSTALL_COMMAND = 'curl -fsSL https://github.com/rskdwypy-pixel/workAssistant/releases/latest/download/install.sh | bash';
const ACCOUNT_AI_HINT_KEY = 'waAiHintPending';
// 重置时清掉的浏览器数据（调试模式开关保留，方便连续测试）
const ACCOUNT_RESET_STORAGE = ['workAssistantConfig', 'taskDraft', 'bug_draft', 'lastTabMode', 'zentao_users', ACCOUNT_SKIP_KEY, ACCOUNT_AI_HINT_KEY];

const accountEsc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const storageGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const storageSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 无痕等环境 */ } };
const storageDel = (k) => { try { localStorage.removeItem(k); } catch { /* 无痕等环境 */ } };

/** 头像：姓名第一个字，底色按账号固定 */
function avatarOf(profile, account) {
  const name = (profile && profile.realname) || account || '?';
  const key = (profile && profile.account) || account || name;
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.codePointAt(0)) % 360;
  return { text: name.trim().charAt(0).toUpperCase(), color: `hsl(${h}, 48%, 46%)` };
}

const STATUS_TEXT = { ok: '已连接', offline: '无法连接禅道', invalid: '登录已失效' };

const Account = {
  state: null,
  menuOpen: false,
  // 连不上后台时的自动重试：刚装好或刚开机，后台可能还在启动（浏览器宿主正在拉起它）
  connectRetries: 12,
  connectRetryMs: 1500,

  async init() {
    this.bind();
    await this.refresh();
    for (let i = 0; !this.state && this.backendProblem === 'down' && i < this.connectRetries; i++) {
      this.setLoadingText('正在连接本地后台服务…');
      await new Promise(r => setTimeout(r, this.connectRetryMs));
      await this.refresh();
    }
    const s = this.state;
    // 连不上后台 / 后台不认这个插件：明确提示（以前静默停在默认界面，看起来像旧版插件）
    if (!s) return this.showBackendNotice();
    // 报告页可能在状态读回来之前就按已登录渲染了
    if (s.state === 'unconfigured' && typeof TabSwitcher !== 'undefined' && TabSwitcher.currentMode === 'report' && typeof ReportPage !== 'undefined') ReportPage.show();
    if (s.state === 'unconfigured' && storageGet(ACCOUNT_SKIP_KEY) !== '1') this.showLogin({ mode: 'first' });
    else if (s.state === 'invalid') this.showLogin({ mode: 'relogin' });
    if (s.state === 'ok' && !s.aiConfigured && storageGet(ACCOUNT_AI_HINT_KEY) === '1') this.showAiHint();
    storageDel(ACCOUNT_AI_HINT_KEY);
    // 定期与回到页面时刷新状态（密码失效、VPN 断开能及时反映到头像上）
    setInterval(() => this.refresh(), 5 * 60 * 1000);
    let lastFocus = Date.now();
    window.addEventListener('focus', () => {
      if (Date.now() - lastFocus > 60 * 1000) { lastFocus = Date.now(); this.refresh(); }
    });
  },

  /** 右上角加载提示的文字（保留前面的转圈图标） */
  setLoadingText(text) {
    const el = document.getElementById('accountLoading');
    if (el && el.lastChild) el.lastChild.textContent = text;
  },

  /** 未登录（含点了「稍后再说」的本地模式） */
  isLocalMode() {
    return !!this.state && this.state.state === 'unconfigured';
  },

  async refresh(force) {
    try {
      const res = await AccountApi.state(force);
      if (res.success) {
        this.state = res.data;
        this.backendProblem = null;
      } else {
        this.backendProblem = res.rejected ? 'rejected' : 'error';
      }
    } catch {
      // 后端连不上：保持原状
      this.backendProblem = 'down';
    }
    this.render();
    return this.state;
  },

  bind() {
    const avatar = document.getElementById('accountAvatarBtn');
    const loginBtn = document.getElementById('accountLoginBtn');
    if (avatar) avatar.addEventListener('click', (e) => { e.stopPropagation(); this.toggleMenu(); });
    if (loginBtn) loginBtn.addEventListener('click', () => this.showLogin({ mode: 'first', fromButton: true }));
    document.getElementById('settingsSwitchAccountBtn')?.addEventListener('click', () => {
      document.getElementById('settingsModal')?.classList.remove('active');
      this.showLogin({ mode: this.isLocalMode() ? 'first' : 'switch', fromButton: true });
    });
    document.getElementById('resetAllBtn')?.addEventListener('click', () => this.showReset());
    document.addEventListener('click', (e) => {
      if (this.menuOpen && !e.target.closest('.account-menu')) this.closeMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.menuOpen) { this.closeMenu(); document.getElementById('accountAvatarBtn')?.focus(); }
    });
  },

  /** 右上角：读取中 → 加载提示；已登录 → 头像（设置收进菜单）；未登录 → 「登录禅道」 */
  render() {
    const s = this.state;
    const avatar = document.getElementById('accountAvatarBtn');
    const loginBtn = document.getElementById('accountLoginBtn');
    // 读到账号状态就撤掉加载提示；一直连不上后台时由 showBackendNotice 撤掉并说明原因
    const loading = document.getElementById('accountLoading');
    if (loading && s) loading.hidden = true;
    if (!avatar || !s) return;
    const loggedIn = s.state !== 'unconfigured';
    avatar.hidden = !loggedIn;
    loginBtn.hidden = loggedIn;
    if (loggedIn) {
      const a = avatarOf(s.profile, s.username);
      avatar.style.background = a.color;
      avatar.innerHTML = `${accountEsc(a.text)}<span class="account-dot is-${s.state}"></span>`;
      const who = s.profile ? `${s.profile.realname}（${s.profile.account}）` : s.username;
      avatar.title = `${who} · ${STATUS_TEXT[s.state] || ''}${s.state !== 'ok' && s.message ? `：${s.message}` : ''}`;
      avatar.setAttribute('aria-label', avatar.title);
    }
    const text = document.getElementById('settingsAccountText');
    if (text) {
      text.textContent = loggedIn
        ? `${s.profile ? `${s.profile.realname}（${s.profile.account}）` : s.username} · ${s.zentaoUrl}${s.state !== 'ok' ? ` · ${STATUS_TEXT[s.state]}` : ''}`
        : '未登录';
      const btn = document.getElementById('settingsSwitchAccountBtn');
      if (btn) btn.querySelector('.btn-label').textContent = loggedIn ? '切换账号' : '登录禅道';
    }
  },

  // ==================== 用户菜单 ====================

  toggleMenu() {
    if (this.menuOpen) this.closeMenu();
    else this.openMenu();
  },

  async openMenu() {
    this.closeMenu();
    const s = this.state;
    if (!s) return;
    const p = s.profile || { realname: s.username, account: s.username };
    const a = avatarOf(s.profile, s.username);
    let sync = '';
    try {
      if (typeof ZentaoSync !== 'undefined') sync = ZentaoSync.formatRelativeTime(await ZentaoSync.getLastSyncTime());
    } catch { /* 没有同步记录 */ }
    const sub = [p.account, p.roleLabel, p.dept].filter(Boolean).join(' · ');
    const statusLine = s.state === 'ok'
      ? `已连接${sync ? ` · ${sync === '从未同步' ? '还没有同步过' : `${sync}同步`}` : ''}`
      : `${STATUS_TEXT[s.state]}${s.message ? `：${s.message}` : ''}`;
    const menu = document.createElement('div');
    menu.className = 'account-menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `
      <div class="am-head">
        <span class="account-avatar is-lg" style="background:${a.color}">${accountEsc(a.text)}</span>
        <div class="am-who"><div class="am-name">${accountEsc(p.realname)}</div><div class="am-sub">${accountEsc(sub)}</div></div>
      </div>
      <div class="am-status is-${s.state}"><span class="account-dot is-${s.state}"></span><span>${accountEsc(statusLine)}</span></div>
      ${s.state === 'invalid' ? '<button type="button" class="am-relogin" data-am="relogin">重新登录</button>' : ''}
      <div class="am-info">
        <div class="am-k">禅道</div><a class="am-v" href="${accountEsc(s.zentaoUrl)}/zentao/" target="_blank" rel="noopener">${accountEsc(s.zentaoUrl)}</a>
        ${p.email ? `<div class="am-k">邮箱</div><div class="am-v">${accountEsc(p.email)}</div>` : ''}
      </div>
      <div class="am-actions">
        <button type="button" role="menuitem" data-am="settings"><svg viewBox="0 0 24 24"><path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>设置</button>
        <button type="button" role="menuitem" data-am="switch"><svg viewBox="0 0 24 24"><path d="M16 3h5v5"/><path d="M21 3l-7 7"/><path d="M8 21H3v-5"/><path d="M3 21l7-7"/></svg>切换账号</button>
        <button type="button" role="menuitem" data-am="logout" class="is-danger"><svg viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>退出登录</button>
      </div>`;
    document.getElementById('accountArea').appendChild(menu);
    menu.addEventListener('click', (e) => this.onMenu(e));
    this.menuOpen = true;
    document.getElementById('accountAvatarBtn').setAttribute('aria-expanded', 'true');
    // 打开时顺便刷新一次状态（缓存 60 秒，不会频繁请求禅道）
    this.refresh();
  },

  closeMenu() {
    document.querySelectorAll('.account-menu').forEach(m => m.remove());
    this.menuOpen = false;
    document.getElementById('accountAvatarBtn')?.setAttribute('aria-expanded', 'false');
  },

  async onMenu(e) {
    const btn = e.target.closest('[data-am]');
    if (!btn) return;
    const act = btn.dataset.am;
    this.closeMenu();
    if (act === 'settings') return typeof openSettingsModal === 'function' && openSettingsModal();
    if (act === 'relogin') return this.showLogin({ mode: 'relogin', fromButton: true });
    if (act === 'switch') return this.showLogin({ mode: 'switch', fromButton: true });
    if (act === 'logout') {
      const ok = await this.confirm('退出登录', '退出后需要重新输入禅道密码。本地的任务、Bug、报告保留，用同一个账号登录后照常使用。', '退出登录');
      if (!ok) return;
      const res = await AccountApi.logout();
      if (!res.success) return typeof Toast !== 'undefined' && Toast.error(res.message || '退出失败');
      storageDel(ACCOUNT_SKIP_KEY);
      this.reload();
    }
  },

  /** 登录 / 退出 / 重置后整页刷新：任务、执行、报告等都按新状态重新加载 */
  reload() {
    location.reload();
  },

  /** 插件内的确认框（不用浏览器原生 confirm） */
  async confirm(title, message, okText = '确定', options = {}) {
    if (typeof Confirm === 'undefined' || !Confirm.show) return false;
    return Confirm.show(title, message, okText, '取消', options);
  },

  // ==================== 登录卡片 ====================

  /**
   * @param {{mode:'first'|'relogin'|'switch', fromButton?:boolean}} options
   *   first：第一次使用 / 退出后（可「稍后再说」）；relogin：密码失效，只需输入密码；switch：换一个账号
   */
  showLogin({ mode = 'first', fromButton = false } = {}) {
    this.closeLogin();
    const s = this.state || {};
    const owner = s.dataOwner;
    const ownerName = s.dataOwnerName || owner;
    const titles = { first: '登录禅道', relogin: '登录已失效', switch: '切换账号' };
    let notice = '';
    if (mode === 'relogin') {
      notice = `禅道提示：${String(s.message || '账号或密码错误').replace(/[。.]+$/, '')}。请重新输入密码。`;
    } else if (owner && (mode === 'switch' || (mode === 'first' && s.state === 'unconfigured'))) {
      notice = `本地数据属于 ${ownerName}${ownerName !== owner ? `（${owner}）` : ''}。用其他账号登录会清空本地任务、Bug、报告和附件，改为同步新账号的数据。`;
    }
    const url = s.zentaoUrl || '';
    const username = mode === 'switch' ? '' : (s.username || '');
    const overlay = document.createElement('div');
    overlay.id = 'loginOverlay';
    overlay.className = 'login-overlay';
    overlay.innerHTML = `
      <div class="login-card" role="dialog" aria-modal="true" aria-labelledby="loginTitle">
        <div class="login-view" data-view="form">
          <div class="login-brand" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg></div>
          <h2 id="loginTitle">${titles[mode]}</h2>
          <p class="login-sub">工作助手的任务、Bug、报告都来自禅道</p>
          ${notice ? `<div class="login-notice ${mode === 'relogin' ? 'is-warn' : ''}">${accountEsc(notice)}</div>` : ''}
          <form class="login-form" novalidate>
            <label class="login-field"><span>禅道地址</span>
              <input name="url" type="text" placeholder="http://10.x.x.x:8088" value="${accountEsc(url)}" autocomplete="url" spellcheck="false" ${mode === 'relogin' ? 'readonly' : ''}>
            </label>
            <label class="login-field"><span>账号</span>
              <input name="username" type="text" placeholder="禅道登录账号" value="${accountEsc(username)}" autocomplete="username" spellcheck="false" ${mode === 'relogin' ? 'readonly' : ''}>
            </label>
            <label class="login-field"><span>密码</span>
              <span class="login-pw">
                <input name="password" type="password" placeholder="禅道登录密码" autocomplete="current-password">
                <button type="button" class="login-eye" aria-label="显示密码" data-login="eye">显示</button>
              </span>
            </label>
            <div class="login-error" role="alert"></div>
            <button type="submit" class="login-submit">登录</button>
          </form>
          <div class="login-foot">
            ${mode === 'first' ? '<button type="button" class="login-link" data-login="import">已有配置文件？导入</button>' : '<span></span>'}
            <button type="button" class="login-link" data-login="${mode === 'first' && !fromButton ? 'skip' : 'cancel'}">${mode === 'first' && !fromButton ? '稍后再说' : '取消'}</button>
          </div>
        </div>
        <div class="login-view" data-view="progress" hidden></div>
      </div>`;
    document.body.appendChild(overlay);
    const form = overlay.querySelector('.login-form');
    form.addEventListener('submit', (e) => { e.preventDefault(); this.submitLogin(overlay); });
    overlay.addEventListener('click', (e) => this.onLoginClick(e, overlay));
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.querySelector('[data-login="cancel"]')) this.closeLogin();
    });
    const first = [...form.querySelectorAll('input')].find(i => !i.value && !i.readOnly) || form.querySelector('input[name="password"]');
    setTimeout(() => first.focus(), 50);
  },

  closeLogin() {
    document.getElementById('loginOverlay')?.remove();
  },

  onLoginClick(e, overlay) {
    const btn = e.target.closest('[data-login]');
    if (!btn) return;
    const act = btn.dataset.login;
    if (act === 'eye') {
      const input = overlay.querySelector('input[name="password"]');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? '隐藏' : '显示';
      btn.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
    } else if (act === 'skip') {
      storageSet(ACCOUNT_SKIP_KEY, '1');
      this.closeLogin();
      if (typeof Toast !== 'undefined') Toast.info('已进入本地模式：任务只保存在本机，随时可点右上角「登录禅道」');
    } else if (act === 'cancel') {
      this.closeLogin();
    } else if (act === 'import') {
      this.closeLogin();
      if (typeof openSettingsModal === 'function') openSettingsModal('p-data');
    }
  },

  async submitLogin(overlay, confirmSwitch = false) {
    const form = overlay.querySelector('.login-form');
    const errEl = overlay.querySelector('.login-error');
    const submit = overlay.querySelector('.login-submit');
    const val = (n) => form.querySelector(`[name="${n}"]`).value.trim();
    const body = { url: val('url'), username: val('username'), password: form.querySelector('[name="password"]').value, confirmSwitch };
    const missing = !body.url ? 'url' : !body.username ? 'username' : !body.password ? 'password' : '';
    if (missing) {
      errEl.textContent = { url: '请填写禅道地址', username: '请填写账号', password: '请填写密码' }[missing];
      form.querySelector(`[name="${missing}"]`).focus();
      return;
    }
    errEl.textContent = '';
    submit.disabled = true;
    submit.textContent = '登录中…';
    let res;
    try {
      res = await AccountApi.login(body);
    } catch (err) {
      res = { success: false, message: `连不上本地后端：${err.message}` };
    }
    submit.disabled = false;
    submit.textContent = '登录';
    const data = res.data || {};
    if (data.needConfirm) {
      const prev = data.previous || {};
      const ok = await this.confirm('切换账号', `当前本地数据属于 ${prev.realname}（${prev.account}）。用 ${body.username} 登录会清空本地任务、Bug、报告和附件，改为同步 ${body.username} 的数据。继续吗？`, '清空并切换', { danger: true });
      if (ok) return this.submitLogin(overlay, true);
      return;
    }
    if (!res.success) {
      const kind = data.error && data.error.kind;
      errEl.textContent = res.message || '登录失败';
      const field = kind === 'credentials' ? 'password' : (kind === 'not_zentao' || kind === 'offline') ? 'url' : '';
      if (field) {
        const input = form.querySelector(`[name="${field}"]`);
        if (field === 'password') input.select();
        input.focus();
      }
      return;
    }
    await this.afterLogin(overlay, data.state);
  },

  /** 登录成功：欢迎 + 拉取执行、团队成员、我的任务，完成后刷新页面 */
  async afterLogin(overlay, state) {
    this.state = state;
    storageDel(ACCOUNT_SKIP_KEY);
    if (state && !state.aiConfigured) storageSet(ACCOUNT_AI_HINT_KEY, '1');
    // 设置页的禅道字段以后端为准，浏览器里的旧值顺手更新
    try {
      const saved = JSON.parse(storageGet('workAssistantConfig') || '{}');
      Object.assign(saved, { zentaoEnabled: true, zentaoUrl: state.zentaoUrl, zentaoUsername: state.username });
      delete saved.zentaoPassword;
      storageSet('workAssistantConfig', JSON.stringify(saved));
    } catch { /* 忽略 */ }
    overlay.querySelector('[data-view="form"]').hidden = true;
    const view = overlay.querySelector('[data-view="progress"]');
    view.hidden = false;
    const name = (state && state.profile && state.profile.realname) || (state && state.username) || '';
    const steps = [
      ['同步执行列表', '/api/executions/sync'],
      ['同步团队成员', '/api/zentao/users/refresh'],
      ['同步我的任务与 Bug', '/api/zentao/sync']
    ];
    view.innerHTML = `
      <div class="login-welcome"><span class="account-avatar is-lg" style="background:${avatarOf(state && state.profile, state && state.username).color}">${accountEsc(avatarOf(state && state.profile, state && state.username).text)}</span>
        <h2>欢迎，${accountEsc(name)}</h2><p class="login-sub">正在从禅道读取你的数据…</p></div>
      <ol class="login-steps">${steps.map(([label], i) => `<li data-step="${i}"><span class="ls-icon"></span>${label}</li>`).join('')}</ol>`;
    for (let i = 0; i < steps.length; i++) {
      const li = view.querySelector(`[data-step="${i}"]`);
      li.className = 'is-running';
      try {
        const r = await AccountApi.post(steps[i][1]);
        li.className = r.success === false ? 'is-warn' : 'is-done';
        if (r.success === false) li.title = r.message || r.error || '';
      } catch (err) {
        li.className = 'is-warn';
        li.title = err.message;
      }
    }
    view.querySelector('.login-sub').textContent = '完成，正在打开…';
    setTimeout(() => this.reload(), 600);
  },

  // ==================== 连不上后台 ====================

  /** 连不上本地后台 / 后台太旧不认这个插件：说清楚原因和怎么修，可一键复制安装命令、重试 */
  showBackendNotice() {
    document.getElementById('backendNotice')?.remove();
    const loading = document.getElementById('accountLoading');
    if (loading) loading.hidden = true;
    const kind = this.backendProblem || 'down';
    const text = {
      down: '连不上本地后台服务（127.0.0.1:3721）。请在终端重新运行安装命令；仍不行时查看日志 ~/Library/Logs/WorkAssistant/backend.log。',
      rejected: '本地后台服务版本过旧，不认识当前插件（通常是以前用旧方式启动的后台还在运行）。请在终端重新运行安装命令，会自动停掉旧的后台并启动新的。',
      error: '本地后台服务返回异常。请在终端重新运行安装命令；仍不行时查看日志 ~/Library/Logs/WorkAssistant/backend.log。'
    }[kind];
    const el = document.createElement('div');
    el.id = 'backendNotice';
    el.className = 'account-hint backend-notice';
    el.setAttribute('role', 'alert');
    el.innerHTML = `<div class="ah-text"><b>${kind === 'rejected' ? '后台服务版本过旧' : '连不上本地后台服务'}</b><span>${accountEsc(text)}</span>
        <code class="bn-cmd">${accountEsc(INSTALL_COMMAND)}</code></div>
      <div class="ah-actions bn-actions"><button type="button" class="ah-go" data-bn="copy">复制安装命令</button><button type="button" class="bn-retry" data-bn="retry">重试</button></div>`;
    document.body.appendChild(el);
    el.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-bn]') && e.target.closest('[data-bn]').dataset.bn;
      if (act === 'copy') {
        try {
          await navigator.clipboard.writeText(INSTALL_COMMAND);
          e.target.textContent = '已复制';
        } catch { /* 复制失败时命令就在上面，可以手动选中 */ }
      }
      if (act === 'retry') {
        e.target.textContent = '重试中…';
        await this.refresh(true);
        if (this.state) this.reload();
        else { e.target.textContent = '重试'; this.showBackendNotice(); }
      }
    });
  },

  // ==================== AI 未配置提示 ====================

  showAiHint() {
    const el = document.createElement('div');
    el.className = 'account-hint';
    el.setAttribute('role', 'status');
    el.innerHTML = `<div class="ah-text"><b>AI 未配置</b><span>新建任务将使用本地规则解析；配置后可自动识别执行、优先级和时间，并生成报告总结。</span></div>
      <div class="ah-actions"><button type="button" class="ah-go">去配置</button><button type="button" class="ah-close" aria-label="关闭">×</button></div>`;
    document.body.appendChild(el);
    el.querySelector('.ah-go').addEventListener('click', () => { el.remove(); if (typeof openSettingsModal === 'function') openSettingsModal('p-ai'); });
    el.querySelector('.ah-close').addEventListener('click', () => el.remove());
  },

  // ==================== 重置为首次使用（调试） ====================

  showReset() {
    document.getElementById('resetDialog')?.remove();
    const dlg = document.createElement('div');
    dlg.id = 'resetDialog';
    dlg.className = 'reset-overlay';
    dlg.innerHTML = `
      <div class="reset-card" role="dialog" aria-modal="true" aria-labelledby="resetTitle">
        <h3 id="resetTitle">重置为首次使用</h3>
        <p>将清空：禅道地址 / 账号 / 密码 / 默认执行、AI 接口与全部 Key、提醒时间与推送、提示词、全员报告成员、收藏的执行、用户信息，以及浏览器里保存的设置与草稿。端口与调试模式保留。</p>
        <div class="reset-export"><span>建议先导出配置（含密码与 Key，可完整恢复）。</span><button type="button" data-reset="export">先导出配置</button></div>
        <label class="reset-check"><input type="checkbox" data-reset="data"> 同时清空本地任务、Bug、报告、附件、执行学习记录（完全还原成新机器）</label>
        <label class="reset-confirm">输入「重置」以确认<input type="text" data-reset="word" autocomplete="off"></label>
        <div class="reset-error" role="alert"></div>
        <div class="reset-actions"><button type="button" data-reset="cancel">取消</button><button type="button" class="is-danger" data-reset="go" disabled>重置</button></div>
      </div>`;
    document.body.appendChild(dlg);
    const word = dlg.querySelector('[data-reset="word"]');
    const go = dlg.querySelector('[data-reset="go"]');
    word.addEventListener('input', () => { go.disabled = word.value.trim() !== '重置'; });
    dlg.addEventListener('keydown', (e) => { if (e.key === 'Escape') dlg.remove(); });
    dlg.addEventListener('click', async (e) => {
      if (e.target === dlg) return dlg.remove();
      const act = e.target.closest('[data-reset]') && e.target.closest('[data-reset]').dataset.reset;
      if (act === 'cancel') return dlg.remove();
      if (act === 'export') {
        dlg.remove();
        document.getElementById('exportPassphrase')?.focus();
        return;
      }
      if (act !== 'go' || go.disabled) return;
      go.disabled = true;
      go.textContent = '重置中…';
      const res = await AccountApi.reset(dlg.querySelector('[data-reset="data"]').checked).catch(err => ({ success: false, message: err.message }));
      if (!res.success) {
        dlg.querySelector('.reset-error').textContent = `重置失败：${res.message || ''}`;
        go.disabled = false;
        go.textContent = '重置';
        return;
      }
      ACCOUNT_RESET_STORAGE.forEach(storageDel);
      this.reload();
    });
    setTimeout(() => word.focus(), 50);
  }
};

if (typeof window !== 'undefined') {
  window.Account = Account;
  window.AccountApi = AccountApi;
}
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => Account.init());
  else Account.init();
}
