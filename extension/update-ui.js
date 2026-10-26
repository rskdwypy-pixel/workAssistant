/**
 * 自动更新（页面这一侧）
 *   · 记录页面上的操作时间：扩展重新加载前先看最近有没有人在用（background.js checkSelfUpdate）
 *   · 页面打开 / 切回来时让 background 看一下扩展文件是不是已被换成新版本
 *   · 设置 → 关于：当前版本、检查更新、立即更新、自动更新开关
 */
const UpdateUI = {
  base() {
    return typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : 'http://127.0.0.1:3721';
  },
  async request(path, body) {
    const init = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const resp = await fetch(`${this.base()}${path}`, init);
    return resp.json();
  },

  init() {
    this.trackInteraction();
    this.pingSelfUpdate();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.pingSelfUpdate();
    });
    document.getElementById('updateCheckBtn')?.addEventListener('click', () => this.check());
    document.getElementById('updateApplyBtn')?.addEventListener('click', () => this.apply());
    document.getElementById('updateAutoToggle')?.addEventListener('change', (e) => this.setAuto(e.target.checked));
    // 打开「关于」时刷新一次
    document.querySelector('[data-panel="p-about"]')?.addEventListener('click', () => { this.load(); this.loadAbout(); });
    this.load();
    this.loadAbout();
  },

  trackInteraction() {
    let last = 0;
    const mark = () => {
      const now = Date.now();
      if (now - last < 10 * 1000) return;
      last = now;
      try { chrome.storage.session.set({ waLastInteraction: now }); } catch { /* 非扩展环境 */ }
    };
    ['pointerdown', 'keydown'].forEach(t => document.addEventListener(t, mark, { capture: true, passive: true }));
  },

  pingSelfUpdate() {
    try { chrome.runtime.sendMessage({ action: 'checkSelfUpdate' }).catch(() => {}); } catch { /* 非扩展环境 */ }
  },

  async load() {
    try {
      const res = await this.request('/api/update/status');
      if (res.success) this.render(res.data);
    } catch {
      this.render(null);
    }
  },

  /** 关于：安装位置、数据、日志（路径可一键复制） */
  async loadAbout() {
    const install = document.getElementById('aboutInstall');
    const data = document.getElementById('aboutData');
    if (!install || !data) return;
    let a = null;
    try {
      const res = await this.request('/api/admin/about');
      if (res.success) a = res.data;
    } catch { /* 下面显示连不上 */ }
    if (!a) {
      install.innerHTML = data.innerHTML = '<span class="input-hint">连不上本地后台服务，读不到</span>';
      return;
    }
    const row = (label, value) => {
      const el = document.createElement('div');
      el.className = 'about-path';
      el.innerHTML = '<span class="ap-k"></span><code class="ap-v"></code><button type="button" class="set-btn set-btn-ghost set-btn-sm ap-copy">复制</button>';
      el.querySelector('.ap-k').textContent = label;
      el.querySelector('.ap-v').textContent = value;
      el.querySelector('.ap-copy').addEventListener('click', async (e) => {
        try {
          await navigator.clipboard.writeText(value);
          e.target.textContent = '已复制';
          setTimeout(() => { e.target.textContent = '复制'; }, 1500);
        } catch { /* 复制失败时可手动选中 */ }
      });
      return el;
    };
    install.replaceChildren(
      row(a.installed ? '程序' : '仓库（开发版）', a.installDir),
      row('扩展目录', a.extensionDir)
    );
    data.replaceChildren(row('数据', a.dataDir), ...(a.logFile ? [row('日志', a.logFile)] : []));
    const hint = document.createElement('span');
    hint.className = 'input-hint';
    hint.textContent = `本地服务 127.0.0.1:${a.port} · Node ${a.node}`;
    data.appendChild(hint);
  },

  /**
   * 检查更新：检查 → 发现新版本 → 下载（进度条）→ 立即更新。
   * 后台发现新版本就立刻返回（state=downloading），下载在后台进行，这里轮询状态把进度画出来。
   */
  async check() {
    const btn = document.getElementById('updateCheckBtn');
    btn.disabled = true;
    btn.textContent = '检查中…';
    this.setText('正在检查新版本…');
    this.showProgress(null);
    try {
      const res = await this.request('/api/update/check', {});
      this.render(res.data, res.success ? '' : res.message);
      if (res.data && res.data.state === 'downloading') await this.poll();
    } catch {
      this.render(null);
    } finally {
      this.resetCheckBtn();
    }
  },

  resetCheckBtn() {
    const btn = document.getElementById('updateCheckBtn');
    if (!btn || this.polling) return;
    btn.disabled = false;
    btn.textContent = '检查更新';
  },

  /** 下载中：每隔一会儿读一次状态，刷新进度条，直到下载结束（就绪 / 失败） */
  async poll() {
    if (this.polling) return;
    this.polling = true;
    const btn = document.getElementById('updateCheckBtn');
    if (btn) { btn.disabled = true; btn.textContent = '下载中…'; }
    try {
      for (let i = 0; i < 2400; i++) {   // 最多约 20 分钟（后台下载本身 15 分钟超时）
        await new Promise(r => setTimeout(r, this.pollMs));
        let res;
        try { res = await this.request('/api/update/status'); } catch { this.render(null); return; }
        if (!res.success) return;
        this.render(res.data);
        if (res.data.state !== 'downloading') return;
      }
    } finally {
      this.polling = false;
      this.resetCheckBtn();
    }
  },
  pollMs: 500,

  /** 进度条：p = {received,total,percent}；null 隐藏；percent 为 null（不知道总大小）时显示来回滑动的不确定进度 */
  showProgress(p) {
    const box = document.getElementById('updateProgress');
    const bar = document.getElementById('updateProgressBar');
    if (!box || !bar) return;
    if (!p) { box.hidden = true; return; }
    box.hidden = false;
    box.classList.toggle('is-indeterminate', p.percent === null || p.percent === undefined);
    if (p.percent === null || p.percent === undefined) {
      bar.style.width = '';
      box.removeAttribute('aria-valuenow');
    } else {
      bar.style.width = `${p.percent}%`;
      box.setAttribute('aria-valuenow', String(p.percent));
    }
  },

  async apply() {
    const btn = document.getElementById('updateApplyBtn');
    btn.disabled = true;
    btn.textContent = '正在更新…';
    try {
      const res = await this.request('/api/update/apply', {});
      if (!res.success) {
        this.render(res.data, res.message);
        return;
      }
      this.setText(`正在安装 ${res.data.readyVersion}，后台重启后插件会自动重新加载…`);
      // 后台重启、扩展文件已换：等后台回来后让扩展重新加载（页面上刚有操作，不能等 3 分钟的空闲判断）
      try { chrome.storage.session.set({ waLastInteraction: 0 }); } catch { /* 非扩展环境 */ }
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 1000));
        try {
          const h = await (await fetch(`${this.base()}/health`)).json();
          if (h.version === res.data.readyVersion) { this.pingSelfUpdate(); return; }
        } catch { /* 还在重启 */ }
      }
      this.setText('后台还没有重启完成，请稍后刷新页面');
    } catch {
      this.render(null);
    } finally {
      btn.disabled = false;
      btn.textContent = '立即更新';
    }
  },

  async setAuto(auto) {
    try {
      const res = await this.request('/api/update/settings', { auto });
      if (res.success) this.render(res.data);
    } catch {
      this.render(null);
    }
  },

  setText(text, kind) {
    const el = document.getElementById('updateStatusText');
    if (!el) return;
    el.textContent = text;
    el.className = `input-hint${kind ? ` is-${kind}` : ''}`;
  },

  /** @param {object|null} s  /api/update/status 的结果；null = 连不上后台 */
  render(s, message) {
    const checkBtn = document.getElementById('updateCheckBtn');
    const applyBtn = document.getElementById('updateApplyBtn');
    const toggle = document.getElementById('updateAutoToggle');
    const toggleText = document.getElementById('updateAutoText');
    if (!checkBtn) return;
    if (!s) {
      this.setText('连不上本地后台服务，无法检查更新', 'warn');
      applyBtn.hidden = true;
      return;
    }
    toggle.checked = !!s.auto;
    toggleText.textContent = s.auto ? '开启' : '关闭';
    applyBtn.hidden = s.state !== 'ready';
    this.showProgress(s.state === 'downloading' ? (s.progress || { percent: null }) : null);
    // 后台正在下载（自动检查触发的）：打开设置时也要把进度显示出来
    if (s.state === 'downloading' && !this.polling) setTimeout(() => this.poll(), 0);
    if (!s.installed) {
      toggle.disabled = true;
      checkBtn.disabled = true;
      this.setText(`v${s.current} · 开发版（在仓库里运行），不自动更新`);
      return;
    }
    const fmt = (iso) => {
      if (!iso) return '';
      const d = new Date(iso);
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getMonth() + 1}-${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    const lastCheck = s.lastCheck ? `，${fmt(s.lastCheck)} 检查过` : '';
    const lastUpdate = s.lastUpdate && s.lastUpdate.to === s.current ? `（${fmt(s.lastUpdate.at)} 从 ${s.lastUpdate.from} 自动更新）` : '';
    const rolledBack = s.rolledBack ? `；${s.lastUpdate.to} 安装后启动失败，已自动退回` : '';
    if (message) return this.setText(message, 'warn');
    switch (s.state) {
      case 'checking': return this.setText('正在检查新版本…');
      case 'downloading': {
        const p = s.progress || {};
        const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
        const detail = p.total > 0 ? `${p.percent}%（${mb(p.received)} / ${mb(p.total)}）` : (p.received > 0 ? `已下载 ${mb(p.received)}` : '准备下载…');
        return this.setText(`发现新版本 v${s.latest}（当前 v${s.current}），正在下载 ${detail}`);
      }
      case 'ready':
        if (s.readyIsBad) return this.setText(`${s.readyVersion} 上次安装后启动失败、已退回，不会自动安装；确需安装可点「立即更新」`, 'warn');
        return this.setText(`新版本 v${s.readyVersion} 已下载完成，${s.auto ? '会在空闲时自动安装，也可以' : '可以'}点「立即更新」`, 'ok');
      case 'restarting': return this.setText('正在安装新版本，后台重启中…');
      case 'needs-installer': return this.setText(s.error, 'warn');
      case 'error': return this.setText(`检查更新失败：${s.error}`, 'warn');
      default:
        return this.setText(s.latest && s.latest === s.current
          ? `v${s.current} 已是最新版本${lastUpdate}${lastCheck}${rolledBack}`
          : `v${s.current}${lastUpdate}${lastCheck}${rolledBack}`, s.rolledBack ? 'warn' : '');
    }
  }
};

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => UpdateUI.init());
  else UpdateUI.init();
}
