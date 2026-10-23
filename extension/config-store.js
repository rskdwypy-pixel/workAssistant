/**
 * 设置的前端缓存（以后端为准）。
 *
 * 真身在后端：.env + data/client-settings.json；GET /api/config 返回快照和内容指纹 rev。
 * 浏览器里只留一份缓存，目的是打开页面时立刻有值、后端没起来时界面也不空：
 *
 *   waSettingsCache   {rev, fetchedAt, snap}  后端快照的副本（不含密码与 Key）
 *   waBackendUrl      后端地址——前端得先知道后端在哪才能去问它，属引导信息，必须留在本地
 *
 * 怎么保持一致：
 *   - 启动时、窗口重新获得焦点（距上次校对超过 2 分钟）、之后每 10 分钟，带着本地 rev 静默问后端一次：
 *     没变只回一个很小的响应；变了就替换缓存并通知界面（设置页正开着且你已经改了内容时不会覆盖你的修改）
 *   - 保存设置时带着本地 rev，后端发现已被别处改过会拒绝（409），界面刷新为最新后请你确认再保存
 *
 * 老版本的 workAssistantConfig 会在第一次运行时迁移：后端地址搬到 waBackendUrl，
 * 「各服务商记住的地址与模型」上传到后端（以前只在浏览器里），然后删掉旧键。
 */

const ConfigStore = {
  CACHE_KEY: 'waSettingsCache',
  BACKEND_KEY: 'waBackendUrl',
  LEGACY_KEY: 'workAssistantConfig',
  DEFAULT_BACKEND: 'http://127.0.0.1:3721',
  REFRESH_MS: 10 * 60 * 1000,      // 定期静默校对
  FOCUS_MIN_MS: 2 * 60 * 1000,     // 回到页面时，距上次校对超过这么久才再问
  snap: null,
  rev: '',
  fetchedAt: 0,
  listeners: [],
  _held: false,
  _inflight: null,
  _started: false,

  _read(key) { try { return localStorage.getItem(key); } catch { return null; } },
  _write(key, v) { try { localStorage.setItem(key, v); } catch { /* 无痕等环境：不缓存也能用 */ } },
  _local: /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/,

  /** 读出缓存（同步，页面启动时第一件事） */
  init() {
    try {
      const c = JSON.parse(this._read(this.CACHE_KEY) || 'null');
      if (c && c.snap && typeof c.snap === 'object') { this.snap = c.snap; this.rev = c.rev || ''; this.fetchedAt = c.fetchedAt || 0; }
    } catch { /* 缓存损坏就当没有 */ }
    // 老版本把后端地址存在 workAssistantConfig 里：先搬出来，保证启动时就能找到后端
    if (!this._read(this.BACKEND_KEY)) {
      try {
        const old = JSON.parse(this._read(this.LEGACY_KEY) || 'null');   // legacy-cleanup
        const u = old && (old.backendUrl || (!old.backendUrl && old.apiBaseUrl));
        if (u && this._local.test(u)) this.setBackendUrl(u);
      } catch { /* ignore */ }
    }
    return this;
  },

  backendUrl() {
    const u = this._read(this.BACKEND_KEY);
    return u && this._local.test(u) ? u.replace('//localhost:', '//127.0.0.1:').replace(/\/$/, '') : this.DEFAULT_BACKEND;
  },

  /** 只接受本机地址：否则整个插件会把任务数据发到别的服务器去 */
  setBackendUrl(u) {
    if (typeof u === 'string' && this._local.test(u)) this._write(this.BACKEND_KEY, u.replace('//localhost:', '//127.0.0.1:').replace(/\/$/, ''));
  },

  /** 后端快照（可能为 null：还没同步过） */
  get() { return this.snap; },

  /** 旧版平铺字段名，方便原有读取方沿用；还没有缓存时返回空对象 */
  flat() {
    const s = this.snap;
    if (!s) return {};
    const ai = s.ai || {}, sc = s.schedule || {}, wh = s.webhook || {}, z = s.zentao || {}, c = s.client || {};
    return {
      apiBaseUrl: ai.apiBaseUrl || '', aiModel: ai.aiModel || '', aiReportModel: ai.aiReportModel || '',
      morningHour: sc.morningHour !== undefined ? String(sc.morningHour) : '', eveningHour: sc.eveningHour !== undefined ? String(sc.eveningHour) : '',
      workHours: sc.workHours !== undefined ? String(sc.workHours) : '',
      webhookUrl: wh.url || '', webhookType: wh.type || 'generic',
      zentaoEnabled: !!z.enabled, zentaoUrl: z.url || '', zentaoUsername: z.username || '', zentaoCreateTaskUrl: z.createTaskUrl || '',
      aiProvider: c.aiProvider || '', aiProfiles: c.aiProfiles || {}
    };
  },

  onChange(fn) { this.listeners.push(fn); },

  /** 暂停 / 恢复「变了就通知界面」（设置页点了「恢复默认」后，不能让静默校对把表单刷回后端的值） */
  hold(v) { this._held = !!v; },

  clear() {
    this.snap = null; this.rev = ''; this.fetchedAt = 0;
    try { localStorage.removeItem(this.CACHE_KEY); } catch { /* ignore */ }
  },

  _persist() {
    this._write(this.CACHE_KEY, JSON.stringify({ rev: this.rev, fetchedAt: this.fetchedAt, snap: this.snap }));
  },

  /**
   * 向后端校对一次。
   * @param {{force?:boolean}} opts force：忽略本地 rev，直接要完整快照（保存之后、冲突之后用）
   * @returns {Promise<boolean>} 缓存是否更新了
   */
  sync({ force = false } = {}) {
    if (this._inflight && !force) return this._inflight;
    const p = (async () => {
      try {
        const q = this.rev && !force ? `?rev=${encodeURIComponent(this.rev)}` : '';
        const resp = await fetch(`${this.backendUrl()}/api/config${q}`);
        const json = await resp.json();
        if (!json || !json.success) return false;
        this.fetchedAt = Date.now();
        if (json.unchanged) { this._persist(); return false; }
        const changed = json.rev !== this.rev;
        this.snap = json.data; this.rev = json.rev;
        this._persist();
        if (changed && !this._held) this.listeners.forEach(fn => { try { fn(this.snap); } catch (e) { console.warn('[ConfigStore] 监听器出错:', e); } });
        return changed;
      } catch {
        return false;   // 后端没起来 / 网络问题：继续用缓存
      }
    })();
    this._inflight = p;
    p.finally(() => { if (this._inflight === p) this._inflight = null; });
    return p;
  },

  /** 启动静默校对：现在一次，回到页面时一次，之后定期 */
  start() {
    if (this._started) return;
    this._started = true;
    this.sync();
    const again = () => { if (Date.now() - this.fetchedAt > this.FOCUS_MIN_MS) this.sync(); };
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) again(); });
    setInterval(() => this.sync(), this.REFRESH_MS);
  },

  /**
   * 迁移老版本的 workAssistantConfig：服务商设置上传后端（以前只在浏览器里），然后删掉旧键。
   * 后端连不上时不删，下次启动再试，避免丢数据。
   */
  async migrateLegacy() {
    let old = null;
    try { old = JSON.parse(this._read(this.LEGACY_KEY) || 'null'); } catch { old = null; }   // legacy-cleanup
    if (!old) return;
    await this.sync({ force: true });
    if (!this.snap) return;   // 后端连不上：先留着旧键
    const c = this.snap.client || {};
    const backendEmpty = !c.aiProvider && !Object.keys(c.aiProfiles || {}).length;
    const hasOld = old.aiProvider || Object.keys(old.aiProfiles || {}).length;
    if (backendEmpty && hasOld) {
      try {
        const r = await fetch(`${this.backendUrl()}/api/config`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client: { aiProvider: old.aiProvider || '', aiProfiles: old.aiProfiles || {} } })
        });
        const j = await r.json();
        if (!j.success) return;
        await this.sync({ force: true });
      } catch { return; }
    }
    try { localStorage.removeItem(this.LEGACY_KEY); } catch { /* ignore */ }   // legacy-cleanup
  }
};

ConfigStore.init();

if (typeof window !== 'undefined') window.ConfigStore = ConfigStore;
