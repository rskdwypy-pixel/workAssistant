/**
 * 首次安装引导 + 更新说明
 *
 * 首次安装引导（只显示一次）：4 步，只配置、不涉及禅道业务
 *   1 连接禅道    就是登录卡片（未登录自动弹出），这里只给它加步骤条；登录后页面会整页刷新，所以进度必须存下来
 *   2 配置 AI     可选；测试连接通过才能保存
 *   3 报告与推送时间   早间提醒 / 日报生成并推送的钟点
 *   4 节假日      法定节假日 / 调休上班日
 *
 * 更新说明：自动更新或手动更新后，第一次打开新标签页时展示这次更新的内容（每个版本一次）。
 *
 * 状态存在 chrome.storage.local（扩展自己的存储，更新、重载都不丢）：
 *   waOnboarding = { introDone, step, seenVersion }
 * 写入时机：background.js 的 onInstalled（install → 要引导；update 且还没有记录 → 老用户，静默记下版本，不引导）。
 * 页面取不到这个记录（极少见）时：没登录且没配 AI 的当新用户，否则当老用户。
 */

const OB_KEY = 'waOnboarding';
const OB_STEPS = ['zentao', 'ai', 'schedule', 'holidays'];
const OB_WHATS_NEW_MAX = 3;   // 一次最多展示几个版本，更早的折叠

const obEsc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** 更新记录里的 **粗体** 和 `代码`（先转义再替换） */
const obInline = (s) => obEsc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');

const ObStore = {
  async get() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const r = await chrome.storage.local.get(OB_KEY);
        return r[OB_KEY] || null;
      }
      return JSON.parse(localStorage.getItem('waOnboarding') || 'null');
    } catch { return null; }
  },
  async set(v) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) await chrome.storage.local.set({ [OB_KEY]: v });
      else localStorage.setItem('waOnboarding', JSON.stringify(v));
    } catch { /* 存不上就算了：最坏是下次再弹一次 */ }
  },
  async clear() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) await chrome.storage.local.remove(OB_KEY);
      else localStorage.removeItem('waOnboarding');
    } catch { /* ignore */ }
  }
};

const Onboarding = {
  rec: null,
  active: false,       // 引导进行中
  step: 'zentao',
  accountState: null,
  _busy: false,

  version() {
    try { if (typeof WA_EXT_VERSION !== 'undefined') return WA_EXT_VERSION; } catch { /* 没定义 */ }
    try { return chrome.runtime.getManifest().version; } catch { return ''; }
  },

  api(path, body) {
    const base = typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : 'http://127.0.0.1:3721';
    const init = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    return fetch(`${base}${path}`, init).then(async r => {
      const j = await r.json().catch(() => ({ success: false, message: `HTTP ${r.status}` }));
      if (r.status === 409) j.success = false;
      return j;
    });
  },

  /** 页面启动时调用（账号状态已读到）：决定要不要引导，以及从第几步继续 */
  async init(accountState) {
    this.accountState = accountState || null;
    const ver = this.version();
    let rec = await ObStore.get();
    if (!rec) {
      const fresh = accountState && accountState.state === 'unconfigured' && !accountState.aiConfigured;
      rec = fresh ? { introDone: false, step: 'zentao', seenVersion: ver } : { introDone: true, seenVersion: ver };
      await ObStore.set(rec);
    }
    this.rec = rec;
    this.active = !rec.introDone;
    this.step = OB_STEPS.includes(rec.step) ? rec.step : 'zentao';
    if (!this.active) return;
    // 用真实状态跳过已经完成的步骤（用户自己在别处配好了、或登录后页面刷新回来）
    const s = accountState || {};
    if (this.step === 'zentao' && (s.state !== 'unconfigured' || this.loginSkipped())) await this.goto('ai');
    if (this.step === 'ai' && s.aiConfigured) await this.goto('schedule');
  },

  loginSkipped() {
    try { return localStorage.getItem('waLoginSkipped') === '1'; } catch { return false; }
  },

  async goto(step) {
    this.step = step;
    this.rec = { ...(this.rec || {}), introDone: false, step };
    await ObStore.set(this.rec);
  },

  async finish() {
    this.active = false;
    this.closeCard();
    this.rec = { ...(this.rec || {}), introDone: true, step: 'zentao', seenVersion: (this.rec && this.rec.seenVersion) || this.version() };
    await ObStore.set(this.rec);
  },

  /** 设置里「重新查看新手引导」 */
  async restart() {
    document.getElementById('settingsModal')?.classList.remove('active');
    const s = this.accountState || {};
    this.active = true;
    await this.goto(s.state && s.state !== 'unconfigured' ? 'ai' : 'zentao');
    if (this.step === 'zentao' && typeof Account !== 'undefined') {
      try { localStorage.removeItem('waLoginSkipped'); } catch { /* ignore */ }
      Account.showLogin({ mode: 'first' });
    } else {
      this.show();
    }
  },

  /** 「调试 → 重置为首次使用」：清掉引导记录，下次打开当新用户 */
  async reset() {
    await ObStore.clear();
    this.rec = null;
    this.active = false;
  },

  // ==================== 展示 ====================

  /** 登录卡片顶部的步骤条（引导第 1 步时才有） */
  stepBarHtml() {
    return this.active && this.step === 'zentao' ? this.barHtml('zentao') : '';
  },

  barHtml(step) {
    const i = OB_STEPS.indexOf(step);
    return `<div class="ob-steps" aria-label="第 ${i + 1} 步，共 ${OB_STEPS.length} 步"><span>第 ${i + 1} 步 / 共 ${OB_STEPS.length} 步</span>`
      + `<span class="ob-dots">${OB_STEPS.map((_, k) => `<i class="${k < i ? 'is-done' : k === i ? 'is-current' : ''}"></i>`).join('')}</span></div>`;
  },

  /** 页面里该显示什么：引导的当前步骤，或更新说明。登录卡片在时让位 */
  async show() {
    if (document.getElementById('loginOverlay') || document.getElementById('obOverlay')) return;
    if (this.active) {
      if (this.step === 'zentao') return;   // 登录卡片负责（未登录会自动弹出）
      return this.renderStep(this.step);
    }
    return this.maybeWhatsNew();
  },

  /** 登录卡片点了「稍后再说」：进入本地模式，继续下一步 */
  async onLoginSkipped() {
    if (!this.active) return;
    await this.goto('ai');
    this.show();
  },

  /** 登录卡片点了「导入旧配置」：配置会整体恢复，引导到此结束 */
  async onImport() {
    if (this.active) await this.finish();
  },

  closeCard() {
    document.getElementById('obOverlay')?.remove();
  },

  mount(html, onKey) {
    this.closeCard();
    const overlay = document.createElement('div');
    overlay.id = 'obOverlay';
    overlay.className = 'login-overlay ob-overlay';
    overlay.innerHTML = `<div class="login-card ob-card" role="dialog" aria-modal="true" aria-labelledby="obTitle">${html}</div>`;
    document.body.appendChild(overlay);
    if (onKey) overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') onKey(e); });
    return overlay;
  },

  renderStep(step) {
    if (step === 'ai') return this.renderAi();
    if (step === 'schedule') return this.renderSchedule();
    return this.renderHolidays();
  },

  /** 往后走一步；最后一步之后结束引导 */
  async next(from) {
    const i = OB_STEPS.indexOf(from);
    if (i < 0 || i >= OB_STEPS.length - 1) {
      await this.finish();
      if (typeof Toast !== 'undefined') Toast.success('设置完成。之后可在 设置 → 关于 里重新查看新手引导');
      return;
    }
    await this.goto(OB_STEPS[i + 1]);
    this.renderStep(OB_STEPS[i + 1]);
  },

  footHtml(skipText, primaryText) {
    return `<div class="login-foot"><button type="button" class="login-link" data-ob="skip">${skipText}</button>`
      + `<button type="submit" class="login-submit ob-primary" data-ob="save">${primaryText}</button></div>`;
  },

  // ----- 第 2 步：AI -----

  renderAi() {
    const providers = typeof AI_PROVIDERS !== 'undefined' ? AI_PROVIDERS : { zhipu: { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4/', model: 'glm-4-flash', keyUrl: '', hint: '' } };
    const first = Object.keys(providers)[0];
    const overlay = this.mount(`
      ${this.barHtml('ai')}
      <h2 id="obTitle">配置 AI（可选）</h2>
      <p class="login-sub">新建任务、日报周报会用到。不配也能用，会改用本地规则解析。</p>
      <form class="login-form" novalidate>
        <label class="login-field"><span>服务商</span>
          <select name="provider" class="ob-select">${Object.entries(providers).map(([k, p]) => `<option value="${obEsc(k)}">${obEsc(p.label)}</option>`).join('')}</select>
        </label>
        <label class="login-field"><span>接口地址</span><input name="baseUrl" type="text" spellcheck="false" autocomplete="off"></label>
        <label class="login-field"><span>API Key <a class="ob-keylink" data-ob="keyurl" href="#" hidden target="_blank" rel="noopener">去获取</a></span>
          <input name="apiKey" type="password" placeholder="粘贴你的 API Key" autocomplete="off" spellcheck="false"></label>
        <label class="login-field"><span>模型</span><input name="model" type="text" spellcheck="false" autocomplete="off"></label>
        <div class="ob-test"><button type="button" class="ob-test-btn" data-ob="test">测试连接</button><span class="ob-test-result" role="status"></span></div>
        <div class="login-error" role="alert"></div>
        ${this.footHtml('以后再说', '保存并继续')}
      </form>`, () => this.next('ai'));
    const form = overlay.querySelector('form');
    const f = (n) => form.elements[n];
    const save = form.querySelector('[data-ob="save"]');
    save.disabled = true;
    const applyPreset = () => {
      const p = providers[f('provider').value] || providers[first];
      f('baseUrl').value = p.baseUrl || '';
      f('model').value = p.model || '';
      const a = form.querySelector('[data-ob="keyurl"]');
      a.hidden = !p.keyUrl;
      if (p.keyUrl) a.href = p.keyUrl;
      invalidate();
    };
    const invalidate = () => {   // 改了任何一项，之前的测试结果就不算数
      save.disabled = true;
      form.querySelector('.ob-test-result').textContent = '';
      form.querySelector('.ob-test-result').className = 'ob-test-result';
    };
    f('provider').addEventListener('change', applyPreset);
    ['baseUrl', 'apiKey', 'model'].forEach(n => f(n).addEventListener('input', invalidate));
    applyPreset();

    overlay.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-ob]') && e.target.closest('[data-ob]').dataset.ob;
      if (act === 'skip') { e.preventDefault(); this.next('ai'); }
      if (act === 'test') await this.testAi(form);
    });
    form.addEventListener('submit', (e) => { e.preventDefault(); this.saveAi(form); });
    setTimeout(() => f('apiKey').focus(), 50);
  },

  async testAi(form) {
    const f = (n) => form.elements[n];
    const out = form.querySelector('.ob-test-result');
    const err = form.querySelector('.login-error');
    err.textContent = '';
    const body = { baseUrl: f('baseUrl').value.trim(), apiKey: f('apiKey').value.trim(), model: f('model').value.trim(), purpose: 'task' };
    if (!body.baseUrl || !body.apiKey || !body.model) { err.textContent = '请填写接口地址、API Key 和模型'; return; }
    const btn = form.querySelector('[data-ob="test"]');
    btn.disabled = true;
    out.className = 'ob-test-result';
    out.textContent = '测试中…';
    try {
      const r = await this.api('/api/ai/test', body);
      out.textContent = `${r.success ? '✅' : '❌'} ${r.message || (r.success ? '连接成功' : '连接失败')}`;
      out.className = `ob-test-result ${r.success ? 'is-ok' : 'is-bad'}`;
      form.querySelector('[data-ob="save"]').disabled = !r.success;
    } catch (e) {
      out.textContent = `❌ 连接失败：${e.message}`;
      out.className = 'ob-test-result is-bad';
    } finally {
      btn.disabled = false;
    }
  },

  async saveAi(form) {
    if (this._busy) return;
    const f = (n) => form.elements[n];
    const err = form.querySelector('.login-error');
    this._busy = true;
    try {
      const r = await this.api('/api/config', {
        apiKey: f('apiKey').value.trim(), apiBaseUrl: f('baseUrl').value.trim(), aiModel: f('model').value.trim(),
        client: { aiProvider: f('provider').value }
      });
      if (!r.success) { err.textContent = r.message || r.error || '保存失败'; return; }
      if (typeof ConfigStore !== 'undefined') ConfigStore.sync({ force: true });
      if (typeof Toast !== 'undefined') Toast.success('AI 已配置，可在 设置 → AI 配置 修改');
      await this.next('ai');
    } catch (e) {
      err.textContent = `保存失败：${e.message}`;
    } finally {
      this._busy = false;
    }
  },

  // ----- 第 3 步：报告与推送时间 -----

  renderSchedule() {
    const flat = typeof ConfigStore !== 'undefined' ? ConfigStore.flat() : {};
    const overlay = this.mount(`
      ${this.barHtml('schedule')}
      <h2 id="obTitle">报告与推送时间</h2>
      <p class="login-sub">每天按这两个时间点提醒和生成报告。周末和法定节假日不会推送。</p>
      <form class="login-form" novalidate>
        <label class="login-field"><span>早间提醒（推送今日待办）</span>
          <span class="ob-hour"><input name="morningHour" type="number" min="0" max="23" step="1" value="${obEsc(flat.morningHour || 9)}"> 点</span></label>
        <label class="login-field"><span>日报生成并推送</span>
          <span class="ob-hour"><input name="eveningHour" type="number" min="0" max="23" step="1" value="${obEsc(flat.eveningHour || 21)}"> 点</span></label>
        <p class="ob-note">周报固定在每周五 17:00 生成。推送到企业微信 / 钉钉 / 飞书的地址，可在 设置 → 通知推送 里配置。</p>
        <div class="login-error" role="alert"></div>
        ${this.footHtml('使用默认', '保存并继续')}
      </form>`, () => this.next('schedule'));
    const form = overlay.querySelector('form');
    overlay.addEventListener('click', (e) => {
      if (e.target.closest('[data-ob="skip"]')) { e.preventDefault(); this.next('schedule'); }
    });
    form.addEventListener('submit', (e) => { e.preventDefault(); this.saveSchedule(form); });
    setTimeout(() => form.elements.morningHour.focus(), 50);
  },

  async saveSchedule(form) {
    if (this._busy) return;
    const err = form.querySelector('.login-error');
    const morningHour = form.elements.morningHour.value.trim();
    const eveningHour = form.elements.eveningHour.value.trim();
    const ok = (v) => /^\d{1,2}$/.test(v) && Number(v) <= 23;
    if (!ok(morningHour) || !ok(eveningHour)) { err.textContent = '时间应是 0~23 之间的整数'; return; }
    this._busy = true;
    try {
      const r = await this.api('/api/config', { morningHour, eveningHour });
      if (!r.success) { err.textContent = r.message || r.error || '保存失败'; return; }
      if (typeof ConfigStore !== 'undefined') ConfigStore.sync({ force: true });
      await this.next('schedule');
    } catch (e) {
      err.textContent = `保存失败：${e.message}`;
    } finally {
      this._busy = false;
    }
  },

  // ----- 第 4 步：节假日 -----

  renderHolidays() {
    const flat = typeof ConfigStore !== 'undefined' ? ConfigStore.flat() : {};
    const overlay = this.mount(`
      ${this.barHtml('holidays')}
      <h2 id="obTitle">节假日</h2>
      <p class="login-sub">法定节假日不算缺填工时，也不会推送提醒；调休上班的周末照常提醒。没有的可以留空，之后随时在设置里补。</p>
      <form class="login-form" novalidate>
        <label class="login-field"><span>法定节假日（不上班的工作日）</span>
          <textarea name="holidays" rows="2" placeholder="2026-10-01~2026-10-07, 2026-12-25">${obEsc(flat.workHolidays || '')}</textarea></label>
        <label class="login-field"><span>调休日（要上班的周末）</span>
          <textarea name="makeup" rows="2" placeholder="2026-09-20, 2026-10-10">${obEsc(flat.workMakeup || '')}</textarea></label>
        <p class="ob-note">单个日期或「起~止」范围，多项用逗号分隔。</p>
        <div class="login-error" role="alert"></div>
        ${this.footHtml('先不配置，完成', '保存并完成')}
      </form>`, () => this.next('holidays'));
    const form = overlay.querySelector('form');
    overlay.addEventListener('click', (e) => {
      if (e.target.closest('[data-ob="skip"]')) { e.preventDefault(); this.next('holidays'); }
    });
    form.addEventListener('submit', (e) => { e.preventDefault(); this.saveHolidays(form); });
    setTimeout(() => form.elements.holidays.focus(), 50);
  },

  async saveHolidays(form) {
    if (this._busy) return;
    const err = form.querySelector('.login-error');
    this._busy = true;
    try {
      const r = await this.api('/api/config', { workHolidays: form.elements.holidays.value.trim(), workMakeup: form.elements.makeup.value.trim() });
      if (!r.success) { err.textContent = r.message || r.error || '保存失败'; return; }
      if (typeof ConfigStore !== 'undefined') ConfigStore.sync({ force: true });
      await this.next('holidays');
    } catch (e) {
      err.textContent = `保存失败：${e.message}`;
    } finally {
      this._busy = false;
    }
  },

  // ==================== 更新说明 ====================

  /** 版本升高后的第一次打开：展示这次更新的内容。取不到内容时不写 seenVersion，下次再试 */
  async maybeWhatsNew() {
    const ver = this.version();
    const rec = this.rec;
    if (!ver || !rec || !rec.introDone || !rec.seenVersion || rec.seenVersion === ver) return;
    let data = null;
    try {
      const r = await this.api(`/api/changelog?since=${encodeURIComponent(rec.seenVersion)}`);
      if (r.success) data = r.data;
    } catch { /* 后端没起来：下次再说 */ }
    if (!data) return;
    if (document.getElementById('loginOverlay') || document.getElementById('obOverlay')) return;
    if (!data.versions || !data.versions.length) {   // 这一版没写更新记录：不打扰，记下版本
      this.rec = { ...rec, seenVersion: ver };
      await ObStore.set(this.rec);
      return;
    }
    this.renderWhatsNew(data.versions, ver, true);
  },

  /** 设置 → 关于 →「更新记录」：全部版本 */
  async showAllChangelog() {
    const r = await this.api('/api/changelog');
    if (!r.success || !r.data) { if (typeof Toast !== 'undefined') Toast.error('读取更新记录失败'); return; }
    document.getElementById('settingsModal')?.classList.remove('active');
    this.renderWhatsNew(r.data.versions || [], r.data.current || this.version(), false, true);
  },

  versionHtml(v) {
    return `<section class="ob-ver"><h3>${obEsc(v.version)}<small>${obEsc(v.date)}</small></h3>${v.groups.map(g =>
      `${g.title ? `<h4>${obEsc(g.title)}</h4>` : ''}<ul>${g.items.map(i => `<li>${obInline(i)}</li>`).join('')}</ul>`).join('')}</section>`;
  },

  renderWhatsNew(versions, current, markSeen, showAll = false) {
    const shown = showAll ? versions : versions.slice(0, OB_WHATS_NEW_MAX);
    const more = versions.length - shown.length;
    const overlay = this.mount(`
      <h2 id="obTitle">${markSeen ? `🎉 已更新到 ${obEsc(current)}` : '更新记录'}</h2>
      <div class="ob-notes">${shown.map(v => this.versionHtml(v)).join('')}
        ${more > 0 ? `<p class="ob-note">还有 ${more} 个更早的版本，点「查看完整更新记录」。</p>` : ''}</div>
      <div class="login-foot">
        ${markSeen && versions.length > shown.length ? '<button type="button" class="login-link" data-ob="all">查看完整更新记录</button>' : '<span></span>'}
        <button type="button" class="login-submit ob-primary" data-ob="close">知道了</button>
      </div>`, () => this.closeNotes(markSeen));
    overlay.addEventListener('click', async (e) => {
      const act = e.target.closest('[data-ob]') && e.target.closest('[data-ob]').dataset.ob;
      if (act === 'close') this.closeNotes(markSeen);
      if (act === 'all') { await this.closeNotes(markSeen); this.showAllChangelog(); }
    });
    overlay.querySelector('[data-ob="close"]').focus();
  },

  async closeNotes(markSeen) {
    this.closeCard();
    if (markSeen && this.rec) {
      this.rec = { ...this.rec, seenVersion: this.version() };
      await ObStore.set(this.rec);
    }
  },

  bindSettings() {
    document.getElementById('obRestartBtn')?.addEventListener('click', () => this.restart());
    document.getElementById('obChangelogBtn')?.addEventListener('click', () => this.showAllChangelog());
  }
};

if (typeof window !== 'undefined') {
  window.Onboarding = Onboarding;
  window.ObStore = ObStore;
}
if (typeof document !== 'undefined') {
  const bind = () => Onboarding.bindSettings();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
}
