/**
 * 自动同步：打开页面、从别的标签切回来时同步一次，页面开着时每 5 分钟再同步一次，
 * 这样在禅道上改的进度 / 状态 / 指派不用手动点同步也会出现。
 *   · 离上次同步不到 2 分钟就跳过；页面在后台时不同步；上一次还没完成时不重叠
 *   · 悄悄进行：失败（没配置禅道、连不上）不打扰；只有任务 / Bug 真的有变化才刷新列表
 * 后端：POST /api/zentao/sync。依赖 newtab.js 里的全局（调用时才访问）：API_BASE_URL、loadTasks、BugManager。
 */
const AutoSync = {
  MIN_GAP: 2 * 60 * 1000,
  EVERY: 5 * 60 * 1000,
  lastAt: 0,
  running: false,
  now: () => Date.now(),

  changed(d) {
    if (!d) return false;
    const n = (o) => (Number(o && o.added) || 0) + (Number(o && o.updated) || 0) + (Number(o && o.removed) || 0);
    return n(d) + n(d.bugs) > 0;
  },

  async run({ force = false } = {}) {
    if (this.running) return false;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
    if (!force && this.now() - this.lastAt < this.MIN_GAP) return false;
    this.running = true;
    this.lastAt = this.now();
    try {
      const base = typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : 'http://127.0.0.1:3721';
      const resp = await fetch(`${base}/api/zentao/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const r = await resp.json();
      if (!r || !r.success) return false;
      if (this.changed(r.data)) {
        if (typeof loadTasks === 'function') await loadTasks();
        if (typeof BugManager !== 'undefined' && BugManager.loadBugs) await BugManager.loadBugs();
      }
      return true;
    } catch (err) {
      console.warn('[AutoSync] 自动同步失败（忽略）:', err && err.message);
      return false;
    } finally {
      this.running = false;
    }
  },

  init() {
    if (this.started) return;
    this.started = true;
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.run(); });
    setInterval(() => this.run({ force: true }), this.EVERY);
    this.run();
  }
};

if (typeof window !== 'undefined') window.AutoSync = AutoSync;
if (typeof document !== 'undefined' && !document.documentElement.hasAttribute('data-no-autosync')) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => AutoSync.init());
  else AutoSync.init();
}
