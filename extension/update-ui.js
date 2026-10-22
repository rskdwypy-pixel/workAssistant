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
    document.querySelector('[data-panel="p-about"]')?.addEventListener('click', () => this.load());
    this.load();
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

  async check() {
    const btn = document.getElementById('updateCheckBtn');
    btn.disabled = true;
    btn.textContent = '检查中…';
    this.setText('正在检查新版本…');
    try {
      const res = await this.request('/api/update/check', {});
      this.render(res.data, res.success ? '' : res.message);
    } catch {
      this.render(null);
    } finally {
      btn.disabled = false;
      btn.textContent = '检查更新';
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
      case 'downloading': return this.setText(`正在下载 ${s.latest}…`);
      case 'ready':
        if (s.readyIsBad) return this.setText(`${s.readyVersion} 上次安装后启动失败、已退回，不会自动安装；确需安装可点「立即更新」`, 'warn');
        return this.setText(`新版本 ${s.readyVersion} 已下载好，${s.auto ? '会在空闲时自动安装，也可以' : '可以'}点「立即更新」`, 'ok');
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
