/**
 * 工作日历（原「报告」页，与任务、Bug 同级的标签页）
 *
 *   ReportApi     后端 /api/reports/* 的封装
 *   ReportPage    当月日历：每天的工时（以禅道为准，点开可填报 / 补填，见 efforts.js）、日报、每周周报、当月月报
 *   ReportViewer  报告窗口（居中弹窗）：「我的」/「全员」两部分；全员再分「按人」/「按项目」；
 *                 推送、复制、重新生成只作用于当前看的那部分；也承载「历史报告」列表
 *   ReportMembersPicker  设置 → 禅道集成：全员报告只统计哪些人
 *
 * 报告由后端按晚间日报的时间自动生成并保存；以前的日期第一次点开时现场生成。
 * 侧栏「智能总结」的按钮在这里绑定：脚本加载即绑定，不等页面初始化（以前要等任务、日历等加载完，
 * 打开新标签页后头几秒点了没反应）。
 */

const ReportApi = {
  base() {
    return typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : 'http://127.0.0.1:3721';
  },
  async request(path, init) {
    const resp = await fetch(`${this.base()}${path}`, init);
    const json = await resp.json().catch(() => ({ success: false, message: `HTTP ${resp.status}` }));
    if (!json.success) throw new Error(json.message || `HTTP ${resp.status}`);
    return json;
  },
  calendar(month) { return this.request(`/api/reports/calendar?month=${encodeURIComponent(month)}`); },
  get(kind, key) { return this.request(`/api/reports/${kind}/${encodeURIComponent(key)}`); },
  generate(kind, key, part) { return this.post(`/api/reports/${kind}/${encodeURIComponent(key)}/generate`, part ? { part } : {}); },
  push(kind, key, part) { return this.post(`/api/reports/${kind}/${encodeURIComponent(key)}/push`, { part }); },
  legacy(date) { return this.request(`/api/reports/legacy/${encodeURIComponent(date)}`); },
  list() { return this.request('/api/reports/list'); },
  members() { return this.request('/api/reports/members'); },
  saveMembers(accounts) { return this.post('/api/reports/members', { accounts }); },
  post(path, body) {
    return this.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
};

const REPORT_PART_LABEL = { mine: '我的', team: '全员' };

const REPORT_KIND_LABEL = { daily: '日报', weekly: '周报', monthly: '月报' };
const reportEsc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(String(s ?? '')) : String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
const reportPad = (n) => String(n).padStart(2, '0');
const reportYmd = (d) => `${d.getFullYear()}-${reportPad(d.getMonth() + 1)}-${reportPad(d.getDate())}`;
const reportClock = (ms) => { if (!ms) return '--:--'; const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const fmtHours = (h) => `${Math.round((Number(h) || 0) * 10) / 10}h`;
const shortDate = (s) => { const [, m, d] = String(s).split('-').map(Number); return `${m}/${d}`; };
const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

const ReportPage = {
  month: null,
  data: null,
  rendered: false,

  /** 切到报告标签时调用 */
  show() {
    const root = document.getElementById('reportMode');
    if (!root) return;
    // 本地模式（没登录禅道）：报告数据都来自禅道，给出登录入口
    if (typeof Account !== 'undefined' && Account.isLocalMode()) {
      this.rendered = false;
      root.innerHTML = `<div class="task-board-header"><div class="task-board-left"><h2>📅 工作日历</h2><div class="task-board-stats" id="reportStats"></div></div><span class="sync-hint" id="reportSyncHint"></span></div><section class="report-page"><div class="report-empty report-login-empty">
        <p><strong>工时与报告数据来自禅道</strong></p>
        <p class="report-muted">这里查看和填报禅道里的工时，并生成日报 / 周报 / 月报，登录禅道后即可使用。</p>
        <button type="button" class="btn-primary" data-report-login>登录禅道</button></div></section>`;
      root.querySelector('[data-report-login]').addEventListener('click', () => Account.showLogin({ fromButton: true }));
      return;
    }
    if (!this.rendered) {
      this.rendered = true;
      root.innerHTML = `<div class="task-board-header"><div class="task-board-left"><h2>📅 工作日历</h2><div class="task-board-stats" id="reportStats"></div></div><span class="sync-hint" id="reportSyncHint"></span></div>
        <section class="report-page">
          <div class="report-head">
            <div class="report-month-nav">
              <button type="button" class="report-nav-btn" data-report-nav="-1" title="上个月">‹</button>
              <h2 class="report-month-title"></h2>
              <button type="button" class="report-nav-btn" data-report-nav="1" title="下个月">›</button>
              <button type="button" class="report-today-btn" data-report-nav="0">本月</button>
              <button type="button" class="report-today-btn report-fill-month" data-fill-month title="补全本月缺少的工时（调试模式）" hidden>补</button>
            </div>
            <div class="report-lens" role="tablist" aria-label="工时范围">
              <button type="button" class="active" data-report-lens="mine" role="tab">我的</button>
              <button type="button" data-report-lens="team" role="tab">全员</button>
            </div>
            <button type="button" class="btn-secondary report-monthly-btn" data-report-open="monthly"></button>
          </div>
          <p class="report-hint"></p>
          <div class="report-calendar" role="grid"></div>
          <details class="report-panel" open>
            <summary>📈 本月统计</summary>
            <div class="report-panel-body" id="reportPanelBody"></div>
          </details>
        </section>`;
      root.addEventListener('click', (e) => this.onClick(e));
    }
    this.load(this.month || reportYmd(new Date()).slice(0, 7));
  },

  efforts: null,       // 当前月份我的工时（EffortApi.month 的整个响应）
  team: null,          // 当前月份全员工时（EffortApi.team 的整个响应）
  lens: 'mine',        // 'mine' | 'team'
  loadToken: 0,

  setHint(text) {
    const el = document.getElementById('reportSyncHint');
    if (el) el.textContent = text || '';
  },

  async load(month) {
    this.month = month;
    const token = ++this.loadToken;
    const root = document.getElementById('reportMode');
    const grid = root && root.querySelector('.report-calendar');
    if (!grid) return;
    if (!this.efforts || this.efforts.data.month !== month) this.efforts = null;
    if (!this.team || this.team.data.month !== month) this.team = null;
    if (!this.data || this.data.month !== month) grid.innerHTML = '<div class="report-loading">加载中…</div>';
    try {
      const { data } = await ReportApi.calendar(month);
      if (token !== this.loadToken) return;
      this.data = data;
      this.render();
    } catch (err) {
      grid.innerHTML = `<div class="report-error">读取报告日历失败：${reportEsc(err.message)}</div>`;
      return;
    }
    // 工时：先画后端的本地缓存（几乎瞬时），再向禅道要最新的
    try {
      const c = await EffortApi.month(month, { cacheOnly: true });
      if (token !== this.loadToken) return;
      if (c.data.days) {
        this.efforts = c;
        this.render();
        this.setHint(`缓存 ${reportClock(c.syncedAt)} · 正在更新…`);
        if (typeof EffortDrawer !== 'undefined' && EffortDrawer.isOpen()) EffortDrawer.render(true);
      } else {
        this.setHint('正在从禅道读取工时…（第一次会慢一点）');
      }
    } catch { /* 没缓存就等最新的 */ }
    await this.reloadEfforts(token);
    if (this.lens === 'team') await this.loadTeam(token);
  },

  /** 全员工时：先画缓存、再向禅道要最新的（第一次要读所有执行的任务，比较慢） */
  async loadTeam(token = this.loadToken) {
    try {
      const c = await EffortApi.team(this.month, { cacheOnly: true });
      if (token !== this.loadToken) return;
      if (c.data.days) {
        this.team = c;
        this.render();
        this.setHint(`全员缓存 ${reportClock(c.syncedAt)} · 正在更新…`);
      } else {
        this.setHint('第一次读取全员工时会比较慢（十几秒）…');
      }
    } catch { /* 没缓存就等最新的 */ }
    try {
      const t = await EffortApi.team(this.month);
      if (token !== this.loadToken) return;
      this.team = t;
      this.render();
      this.setHint(`全员已同步 ${reportClock(t.syncedAt)}`);
      if (typeof EffortDrawer !== 'undefined' && EffortDrawer.isOpen()) EffortDrawer.render(true);
    } catch (err) {
      if (token !== this.loadToken) return;
      this.setHint(this.team ? '全员更新失败，当前显示的是缓存' : `全员工时读取失败：${err.message}`);
    }
  },

  /** 向禅道要最新工时并重画（填报之后也调用） */
  async reloadEfforts(token = this.loadToken) {
    try {
      const e = await EffortApi.month(this.month);
      if (token !== this.loadToken) return;
      this.efforts = e;
      this.render();
      this.setHint(`已同步 ${reportClock(e.syncedAt)}`);
      if (typeof EffortDrawer !== 'undefined' && EffortDrawer.isOpen()) EffortDrawer.render(true);
    } catch (err) {
      if (token !== this.loadToken) return;
      this.setHint(this.efforts ? '更新失败，当前显示的是缓存' : `工时读取失败：${err.message}`);
    }
  },

  render() {
    const root = document.getElementById('reportMode');
    const d = this.data;
    const [y, m] = d.month.split('-').map(Number);
    root.querySelector('.report-month-title').textContent = `${y}年${m}月`;
    const monthlyBtn = root.querySelector('.report-monthly-btn');
    monthlyBtn.dataset.reportKey = d.month;
    monthlyBtn.disabled = d.monthly.future;
    monthlyBtn.textContent = d.monthly.report ? `📈 ${m}月月报 · ${fmtHours(d.monthly.report.myHours)}` : `📈 ${m}月月报`;
    root.querySelector('.report-hint').textContent =
      `日报每天 ${d.eveningHour}:00 自动生成（周末仅在当天有人有工作记录时），周报周五 17:00，月报在当月最后一个工作日（${shortDate(d.monthly.autoDate)}）${d.eveningHour}:00。以前的日期点开时现场生成。`;

    const head = ['一', '二', '三', '四', '五', '六', '日'].map(w => `<div class="report-col-head">${w}</div>`).join('') + '<div class="report-col-head report-col-week">周报</div>';
    const byDate = new Map(d.days.map(x => [x.date, x]));
    const rows = d.weeks.map(w => {
      const cells = [];
      for (let i = 0; i < 7; i++) {
        const dt = new Date(...w.begin.split('-').map((v, j) => (j === 1 ? Number(v) - 1 : Number(v))));
        dt.setDate(dt.getDate() + i);
        const s = reportYmd(dt);
        const day = byDate.get(s);
        cells.push(day ? this.dayCell(day, d) : '<div class="report-day is-outside"></div>');
      }
      cells.push(this.weekCell(w));
      return cells.join('');
    }).join('');
    root.querySelector('.report-calendar').innerHTML = head + rows;
    root.querySelectorAll('[data-report-lens]').forEach(b => b.classList.toggle('active', b.dataset.reportLens === this.lens));
    const fm = root.querySelector('[data-fill-month]');
    if (fm) {
      const show = this.isDebug() && this.lens === 'mine';
      fm.hidden = !show;
      if (show) {
        const n = this.data.days.filter(d => this.canFill(d)).length;
        fm.disabled = n === 0;
        fm.title = n ? `补全本月缺少工时的 ${n} 天（调试模式）` : '本月没有缺工时的日子';
      }
    }
    this.renderStats();
    this.renderPanel();
  },

  /** 某天的工时：{hours, items}；工时还没读到时 loaded=false */
  effortOf(date) {
    const days = this.efforts && this.efforts.data && this.efforts.data.days;
    return { loaded: !!days, entry: (days && days[date]) || { hours: 0, items: [] } };
  },

  /** 调试模式（设置 → 调试）：「补」只在调试模式下出现，关闭时连 DOM 都不生成 */
  isDebug() {
    try { return typeof debugMode !== 'undefined' && debugMode === true; } catch { return false; }
  },

  /** 这一天能不能补：过去的工作日（不含今天、周末、将来），而且工时不满标准工时 */
  canFill(day) {
    if (!this.isDebug() || this.lens !== 'mine' || day.weekend || day.future || day.today) return false;
    const { loaded, entry } = this.effortOf(day.date);
    return loaded && this.standard() - entry.hours >= 0.5;
  },

  standard() { return (this.efforts && this.efforts.data && this.efforts.data.standard) || 8; },

  /** 页头统计：本月累计、缺填天数（过去的工作日里一小时都没填的；填了但不满标准工时的不算缺填，只是格子显示琥珀色）。点「缺填」跳到第一个缺填日 */
  renderStats() {
    const el = document.getElementById('reportStats');
    if (!el) return;
    if (this.lens === 'team') {
      const t = this.team && this.team.data;
      if (!t || !t.days) { el.innerHTML = ''; return; }
      const total = t.members.reduce((n, m) => n + m.hours, 0);
      const active = t.members.filter(m => m.hours > 0).length;
      el.innerHTML = `
        <div class="stat-item"><span class="stat-label">团队累计</span><span class="stat-value">${fmtHours(total)}</span></div>
        <div class="stat-item"><span class="stat-label">已填报</span><span class="stat-value">${active}/${t.members.length} 人</span></div>`;
      return;
    }
    const days = this.efforts && this.efforts.data && this.efforts.data.days;
    if (!days || !this.data) { el.innerHTML = ''; return; }
    const std = this.standard();
    let total = 0;
    for (const v of Object.values(days)) total += v.hours;
    const missing = this.data.days.filter(d => !d.weekend && !d.future && !d.today && (days[d.date] ? days[d.date].hours : 0) <= 0);
    this.firstMissing = missing.length ? missing[0].date : null;
    el.innerHTML = `
      <div class="stat-item"><span class="stat-label">本月累计</span><span class="stat-value">${fmtHours(total)}</span></div>
      <div class="stat-item"><span class="stat-label">缺填</span><span class="stat-value${missing.length ? ' is-warn' : ''}"${missing.length ? ' data-effort-day="' + missing[0].date + '" style="cursor:pointer" title="点击跳到第一个缺填的日子"' : ''}>${missing.length} 天</span></div>`;
  },

  /** 全员视角的日格子：团队当天总工时 + 几个人填了；过去的工作日没人填标红，所有人都填满标绿 */
  teamDayCell(day) {
    const n = Number(day.date.slice(8));
    const t = this.team && this.team.data && this.team.data.days ? this.team.data : null;
    const std = (t && t.standard) || 8;
    const entry = (t && t.days[day.date]) || { total: 0, byMember: {} };
    const people = Object.keys(entry.byMember).length;
    const cls = ['report-day'];
    if (day.weekend) cls.push('is-weekend');
    if (day.today) cls.push('is-today');
    if (day.future) cls.push('is-future');
    let body = '';
    if (t && !day.future) {
      const everyone = t.members.length > 0 && t.members.every(m => (entry.byMember[m.account] || 0) >= std);
      if (everyone) cls.push('is-full');
      else if (entry.total > 0) cls.push('is-partial');
      else if (!day.weekend && !day.today) cls.push('is-missing');
      if (entry.total > 0) body = `<div class="report-day-mine">团队 ${fmtHours(entry.total)}</div><div class="report-day-team">${people}/${t.members.length} 人填报</div>`;
      else if (!day.weekend && !day.today) body = '<div class="report-day-mine">没人填工时</div>';
    }
    const attrs = day.future ? 'aria-disabled="true"' : `data-effort-day="${day.date}" tabindex="0" role="button"`;
    return `<div class="${cls.join(' ')}" ${attrs} title="${reportEsc(day.date)} ${WEEKDAY[day.weekday]}">
      <div class="report-day-num"><span class="report-day-n">${n}</span>${day.today ? '<span class="report-today-tag">今天</span>' : ''}${day.report ? '<span class="report-dot" title="已有日报"></span>' : ''}</div>${body}</div>`;
  },

  teamWeekCell(w) {
    const r = w.report;
    const attrs = w.future ? 'aria-disabled="true"' : `data-report-open="weekly" data-report-key="${w.key}" tabindex="0" role="button"`;
    let sum = null;
    if (this.team && this.team.data && this.team.data.days) {
      sum = 0;
      for (let i = 0; i < 7; i++) {
        const dt = new Date(...w.begin.split('-').map((v, j) => (j === 1 ? Number(v) - 1 : Number(v))));
        dt.setDate(dt.getDate() + i);
        const e = this.team.data.days[reportYmd(dt)];
        if (e) sum += e.total;
      }
    }
    return `<div class="report-week ${r ? 'has-report' : ''} ${w.future ? 'is-future' : ''}" ${attrs} title="${reportEsc(w.label)}">
      <div class="report-week-label">${shortDate(w.begin)}–${shortDate(w.end)}</div>
      ${sum !== null ? `<div class="report-day-mine">团队 ${fmtHours(sum)}</div>` : ''}${r ? '' : (w.future ? '' : '<div class="report-day-pending">周报</div>')}
    </div>`;
  },

  /** 统计面板：我的 = 按执行 / 任务 Top5；全员 = 成员 × 日期热力图 */
  renderPanel() {
    const el = document.getElementById('reportPanelBody');
    if (!el) return;
    if (this.lens === 'team') return this.renderHeatmap(el);
    const days = this.efforts && this.efforts.data && this.efforts.data.days;
    if (!days) { el.innerHTML = '<div class="report-muted">工时读取中…</div>'; return; }
    const byExec = new Map(), byTask = new Map();
    let total = 0;
    for (const d of Object.values(days)) {
      for (const i of d.items) {
        total += i.consumed;
        const ek = i.execName || '未归属执行';
        byExec.set(ek, (byExec.get(ek) || 0) + i.consumed);
        const t = byTask.get(i.taskId) || { name: i.taskName, exec: i.execName, hours: 0 };
        t.hours += i.consumed;
        byTask.set(i.taskId, t);
      }
    }
    if (!total) { el.innerHTML = '<div class="report-muted">这个月还没有工时记录</div>'; return; }
    const execs = [...byExec.entries()].sort((a, b) => b[1] - a[1]);
    const tasks = [...byTask.values()].sort((a, b) => b.hours - a.hours).slice(0, 5);
    const bar = (label, h, max, sub) => `<div class="report-bar-row"><span class="report-bar-label" title="${reportEsc(label)}">${reportEsc(label)}${sub ? `<em>${reportEsc(sub)}</em>` : ''}</span><span class="report-bar-track"><span style="width:${Math.max(3, Math.round((h / max) * 100))}%"></span></span><span class="report-bar-val">${fmtHours(h)}</span></div>`;
    el.innerHTML = `<div class="report-panel-cols">
      <div><div class="report-panel-title">按执行（${execs.length}）</div>${execs.slice(0, 8).map(([n, h]) => bar(n, h, execs[0][1])).join('')}${execs.length > 8 ? `<div class="report-muted">另有 ${execs.length - 8} 个执行…</div>` : ''}</div>
      <div><div class="report-panel-title">工时最多的任务 Top ${tasks.length}</div>${tasks.map(t => bar(t.name, t.hours, tasks[0].hours, t.exec)).join('')}</div>
    </div>`;
  },

  /** 成员 × 日期热力图：颜色按「当天工时 / 标准工时」分档，过去工作日没填的标红 */
  renderHeatmap(el) {
    const t = this.team && this.team.data && this.team.data.days ? this.team.data : null;
    if (!t || !this.data) { el.innerHTML = '<div class="report-muted">全员工时读取中…（第一次会慢一点）</div>'; return; }
    if (!t.members.length) { el.innerHTML = '<div class="report-muted">没有可统计的成员</div>'; return; }
    const std = t.standard || 8;
    const cols = this.data.days;
    const level = (h) => (h <= 0 ? 0 : h < std * 0.5 ? 1 : h < std ? 2 : h <= std * 1.25 ? 3 : 4);
    const head = `<th class="hm-name">成员</th><th class="hm-sum">合计</th>` + cols.map(d => `<th class="${d.weekend ? 'hm-weekend' : ''}${d.today ? ' hm-today' : ''}">${Number(d.date.slice(8))}</th>`).join('');
    const rows = t.members.map(m => `<tr><td class="hm-name" title="${reportEsc(m.account)}">${reportEsc(m.name)}</td><td class="hm-sum">${fmtHours(m.hours)}</td>` + cols.map(d => {
      const h = m.byDay[d.date] || 0;
      const miss = h === 0 && !d.weekend && !d.future && !d.today;
      return `<td class="hm-cell lv${level(h)}${miss ? ' hm-miss' : ''}${d.weekend ? ' hm-weekend' : ''}" title="${reportEsc(m.name)} ${shortDate(d.date)}：${h > 0 ? fmtHours(h) : (miss ? '未填' : '—')}"></td>`;
    }).join('') + '</tr>').join('');
    el.innerHTML = `<div class="report-heatmap-wrap"><table class="report-heatmap"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>
      <div class="report-heat-legend"><span>少</span><i class="lv1"></i><i class="lv2"></i><i class="lv3"></i><i class="lv4"></i><span>多（标准 ${std}h/天）</span><i class="hm-miss-sample"></i><span>未填</span></div>`;
  },

  dayCell(day, cal) {
    if (this.lens === 'team') return this.teamDayCell(day);
    const n = Number(day.date.slice(8));
    const r = day.report;
    const std = this.standard();
    const { loaded, entry } = this.effortOf(day.date);
    const cls = ['report-day'];
    if (day.weekend) cls.push('is-weekend');
    if (day.today) cls.push('is-today');
    if (day.future) cls.push('is-future');
    if (r) cls.push('has-report');
    let body = '';
    if (loaded && !day.future) {
      if (entry.hours >= std) cls.push('is-full');
      else if (entry.hours > 0) cls.push('is-partial');
      else if (!day.weekend && !day.today) cls.push('is-missing');
      if (entry.hours > 0) {
        const pct = Math.min(100, Math.round((entry.hours / std) * 100));
        body += `<div class="report-day-mine">${fmtHours(entry.hours)}</div><div class="report-day-bar"><span style="width:${pct}%"></span></div>`;
      } else if (!day.weekend && !day.today) {
        body += '<div class="report-day-mine">未填工时</div>';
      } else if (day.today) {
        body += '<div class="report-day-pending">今天还没填</div>';
      }
    } else if (!loaded && !day.future && r) {
      // 工时还没读到：先显示报告快照里的数
      if (r.myHours === 0 && !day.weekend) cls.push('is-missing');
      body += `<div class="report-day-mine">${r.myHours === 0 ? '未填工时' : `我 ${fmtHours(r.myHours)}`}</div>`;
    }
    if (r) body += `<div class="report-day-team">全员 ${fmtHours(r.teamHours)} · ${r.activeCount}/${r.memberCount} 人</div>`;
    else if (day.legacy) body += '<div class="report-day-pending">旧版日报</div>';
    if (this.canFill(day)) body += `<button type="button" class="report-fill-btn" data-fill-day="${day.date}" title="补填 ${day.date} 缺少的工时">补</button>`;
    const attrs = day.future ? 'aria-disabled="true"' : `data-effort-day="${day.date}" tabindex="0" role="button"`;
    return `<div class="${cls.join(' ')}" ${attrs} title="${reportEsc(day.date)} ${WEEKDAY[day.weekday]}">
      <div class="report-day-num"><span class="report-day-n">${n}</span>${day.today ? '<span class="report-today-tag">今天</span>' : ''}${r ? '<span class="report-dot" title="已有日报"></span>' : ''}</div>${body}</div>`;
  },

  weekCell(w) {
    if (this.lens === 'team') return this.teamWeekCell(w);
    const r = w.report;
    const attrs = w.future ? 'aria-disabled="true"' : `data-report-open="weekly" data-report-key="${w.key}" tabindex="0" role="button"`;
    // 本周累计工时：日历里这一周的每一天（跨月的那几天不在本月数据里，只统计本月内的）
    let live = null;
    if (this.efforts && this.efforts.data.days) {
      live = 0;
      for (let i = 0; i < 7; i++) {
        const dt = new Date(...w.begin.split('-').map((v, j) => (j === 1 ? Number(v) - 1 : Number(v))));
        dt.setDate(dt.getDate() + i);
        const e = this.efforts.data.days[reportYmd(dt)];
        if (e) live += e.hours;
      }
    }
    const mine = live !== null ? `<div class="report-day-mine">${fmtHours(live)}</div>` : (r ? `<div class="report-day-mine">我 ${fmtHours(r.myHours)}</div>` : '');
    return `<div class="report-week ${r ? 'has-report' : ''} ${w.future ? 'is-future' : ''}" ${attrs} title="${reportEsc(w.label)}">
      <div class="report-week-label">${shortDate(w.begin)}–${shortDate(w.end)}</div>
      ${mine}${r ? `<div class="report-day-team">全员 ${fmtHours(r.teamHours)}</div>` : (w.future ? '' : '<div class="report-day-pending">周报</div>')}
    </div>`;
  },

  onClick(e) {
    const nav = e.target.closest('[data-report-nav]');
    if (nav) {
      const step = Number(nav.dataset.reportNav);
      if (step === 0) return this.load(reportYmd(new Date()).slice(0, 7));
      const [y, m] = this.month.split('-').map(Number);
      const d = new Date(y, m - 1 + step, 1);
      return this.load(`${d.getFullYear()}-${reportPad(d.getMonth() + 1)}`);
    }
    const fillDay = e.target.closest('[data-fill-day]');
    if (fillDay) { e.stopPropagation(); return typeof AutofillDialog !== 'undefined' && AutofillDialog.openDay(fillDay.dataset.fillDay); }
    const fillMonth = e.target.closest('[data-fill-month]');
    if (fillMonth) return !fillMonth.disabled && typeof AutofillDialog !== 'undefined' && AutofillDialog.openMonth(this.month);
    const lens = e.target.closest('[data-report-lens]');
    if (lens) {
      if (lens.dataset.reportLens === this.lens) return;
      this.lens = lens.dataset.reportLens;
      this.render();
      if (this.lens === 'team' && !this.team) this.loadTeam();
      return;
    }
    const day = e.target.closest('[data-effort-day]');
    if (day) return EffortDrawer.open(day.dataset.effortDay);
    const open = e.target.closest('[data-report-open]');
    if (open && !open.disabled) ReportViewer.open(open.dataset.reportOpen, open.dataset.reportKey || this.month);
  },

  /** 外部入口（侧栏按钮）：打开报告页并直接打开某份报告 */
  openReport(kind, key) {
    if (typeof TabSwitcher !== 'undefined') TabSwitcher.switchMode('report');
    else this.show();
    ReportViewer.open(kind, key);
  },

  /** 报告生成后刷新日历上的状态 */
  refresh() {
    if (this.rendered && this.month) this.load(this.month);
  }
};

// 键盘：日历格子回车打开
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target && e.target.closest && e.target.closest('[data-fill-day]')) return;   // 焦点在「补」按钮上：回车就是点这个按钮，别当成点了整格
  const cell = e.target && e.target.closest && e.target.closest('.report-calendar [data-report-open], .report-calendar [data-effort-day]');
  if (cell) { e.preventDefault(); cell.click(); }
});

const ReportViewer = {
  kind: null,
  key: null,
  report: null,
  tab: 'mine',
  teamTab: 'person',
  token: 0,

  ensureDom() {
    let el = document.getElementById('reportDrawer');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'reportDrawer';
    el.className = 'report-drawer-mask';
    el.innerHTML = `
      <div class="report-drawer" role="dialog" aria-modal="true" aria-labelledby="reportDrawerTitle">
        <header class="report-drawer-head">
          <div>
            <div class="report-drawer-title">
              <span class="report-kind"></span>
              <h3 id="reportDrawerTitle"></h3>
            </div>
            <div class="report-drawer-meta"></div>
          </div>
          <nav class="report-tabs" role="tablist" aria-label="报告范围">
            <button type="button" class="report-tab" data-report-tab="mine" role="tab">我的</button>
            <button type="button" class="report-tab" data-report-tab="team" role="tab">全员</button>
          </nav>
          <div class="report-drawer-actions"></div>
          <button type="button" class="report-close" data-report-act="close" aria-label="关闭">×</button>
        </header>
        <div class="report-drawer-body"></div>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', (e) => this.onClick(e));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && el.classList.contains('active')) this.close();
    });
    return el;
  },

  /**
   * @param {{fromHistory?:boolean}} [options] - 从历史报告列表点开的：标题旁给「‹ 历史报告」返回
   */
  async open(kind, key, { fromHistory = false } = {}) {
    const el = this.ensureDom();
    this.fromHistory = fromHistory;
    this.kind = kind;
    this.key = key;
    this.report = null;
    this.legacy = null;
    const token = ++this.token;
    el.classList.add('active');
    this.setHead(REPORT_KIND_LABEL[kind], '');
    this.setBody('<div class="report-loading">读取中…</div>');
    try {
      const res = await ReportApi.get(kind, key);
      if (token !== this.token) return;
      this.period = res.period;
      this.key = res.period.key;
      if (res.data) {
        this.report = res.data;
        return this.render();
      }
      if (res.status && res.status.generating) return this.generate();
      return this.renderEmpty();
    } catch (err) {
      if (token === this.token) this.setBody(`<div class="report-error">读取失败：${reportEsc(err.message)}</div>`);
    }
  },

  close() {
    this.token++;
    const el = document.getElementById('reportDrawer');
    if (el) el.classList.remove('active');
  },

  setHead(title, meta, actions = '') {
    const el = this.ensureDom();
    const kind = el.querySelector('.report-kind');
    const history = this.kind === 'history';
    kind.textContent = history ? '历史' : (REPORT_KIND_LABEL[this.kind] || '');
    kind.className = `report-kind is-${this.kind}`;
    el.querySelector('#reportDrawerTitle').textContent = title;
    // 从历史报告列表点进来的，标题前给一个返回
    const back = this.fromHistory && !history ? '<button type="button" class="report-back" data-report-act="history">‹ 历史报告</button> ' : '';
    el.querySelector('.report-drawer-meta').innerHTML = back + reportEsc(meta);
    el.querySelector('.report-drawer-actions').innerHTML = actions;
  },

  setBody(html) {
    const el = this.ensureDom();
    el.querySelector('.report-drawer-body').innerHTML = html;
    el.querySelector('.report-drawer-body').scrollTop = 0;
    el.querySelector('.report-tabs').style.display = this.report ? '' : 'none';
    el.querySelectorAll('.report-tab').forEach(b => {
      const on = b.dataset.reportTab === this.tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
  },

  /** 历史报告：已生成的报告列表（新的在前），点开即在本窗口查看 */
  async openHistory() {
    const el = this.ensureDom();
    const token = ++this.token;
    this.kind = 'history';
    this.report = null;
    this.fromHistory = true;
    el.classList.add('active');
    this.setHead('历史报告', '读取中…');
    this.setBody('<div class="report-loading">读取中…</div>');
    try {
      const { data } = await ReportApi.list();
      if (token !== this.token) return;
      this.setHead('历史报告', `共 ${data.length} 份 · 报告页日历上的报告都在这里`);
      if (!data.length) return this.setBody('<div class="report-empty"><p>还没有生成过报告。</p><p class="report-muted">日报每天晚间自动生成，也可以在「📊 报告」页的日历上点任意一天生成。</p></div>');
      const groups = new Map();
      for (const r of data) {
        const month = (r.kind === 'monthly' ? r.key : r.key.slice(0, 7));
        if (!groups.has(month)) groups.set(month, []);
        groups.get(month).push(r);
      }
      this.setBody([...groups.entries()].map(([month, list]) => {
        const [y, m] = month.split('-').map(Number);
        return `<section class="report-history-group"><h4>${y}年${m}月</h4>${list.map(r => `
          <button type="button" class="report-history-item" data-report-open-kind="${r.kind}" data-report-open-key="${reportEsc(r.key)}">
            <span class="report-kind is-${r.kind}">${REPORT_KIND_LABEL[r.kind]}</span>
            <span><div class="report-history-label">${reportEsc(r.label)}</div>${r.summary ? `<div class="report-history-summary">${reportEsc(r.summary)}</div>` : ''}</span>
            <span class="report-history-num">我 ${fmtHours(r.myHours)}<br>全员 ${fmtHours(r.teamHours)}</span>
          </button>`).join('')}</section>`;
      }).join(''));
    } catch (err) {
      if (token === this.token) this.setBody(`<div class="report-error">读取失败：${reportEsc(err.message)}</div>`);
    }
  },

  /** 还没有报告：今天未到时间 → 说明 + 立即生成；以前的日期 → 直接生成 */
  async renderEmpty() {
    const p = this.period;
    const today = reportYmd(new Date());
    const cal = ReportPage.data;
    const hour = cal ? cal.eveningHour : 21;
    // 自动生成的时刻：日报当天晚间、周报当周周五、月报当月最后一个工作日
    const friday = (() => { const [y, m, d] = p.begin.split('-').map(Number); return reportYmd(new Date(y, m - 1, d + 4)); })();
    const autoDay = this.kind === 'daily' ? p.key : this.kind === 'weekly' ? friday : (cal && cal.monthly.key === p.key ? cal.monthly.autoDate : p.end);
    this.setHead(p.label, '尚未生成');
    // 还没到自动生成的那天之后（含当天）才提示等待；已经过了的直接现场生成
    if (today > autoDay || p.begin > today) return this.generate();

    let legacyHtml = '';
    if (this.kind === 'daily') {
      try {
        const { data } = await ReportApi.legacy(p.key);
        if (data) legacyHtml = this.legacyHtml(data);
      } catch { /* 旧版日报读不到不影响 */ }
    }
    const when = this.kind === 'daily' ? `今天 ${hour}:00` : this.kind === 'weekly' ? `${shortDate(friday)}（周五）17:00` : `${shortDate(autoDay)} ${hour}:00`;
    this.setBody(`
      <div class="report-empty">
        <p>这份${REPORT_KIND_LABEL[this.kind]}将于 <strong>${reportEsc(when)}</strong> 自动生成。</p>
        <p class="report-muted">现在生成会读取截至此刻的禅道数据；到点后会自动重新生成。</p>
        <button type="button" class="btn-primary" data-report-act="generate">立即生成</button>
      </div>${legacyHtml}`);
  },

  /**
   * 生成报告；part 给定时只重新生成这一部分（另一部分保持原样）
   * @param {'mine'|'team'} [part]
   */
  async generate(part) {
    const token = ++this.token;
    const p = this.period;
    const previous = part ? this.report : null;
    this.setHead(p.label, part ? `正在重新生成「${REPORT_PART_LABEL[part]}」部分…` : '生成中…');
    this.report = null;
    this.setBody('<div class="report-generating"><div class="report-spinner"></div><div class="report-progress">正在从禅道读取数据…</div><p class="report-muted">需要读取所有执行的任务和工时记录，通常 10~30 秒</p></div>');
    // 生成期间轮询进度文案
    const poll = setInterval(async () => {
      try {
        const res = await ReportApi.get(this.kind, this.key);
        const el = document.querySelector('#reportDrawer .report-progress');
        if (token === this.token && el && res.status && res.status.progress) el.textContent = res.status.progress;
      } catch { /* 轮询失败忽略 */ }
    }, 1500);
    try {
      const { data } = await ReportApi.generate(this.kind, this.key, part);
      if (token !== this.token) return;
      this.report = data;
      this.render();
      ReportPage.refresh();
    } catch (err) {
      if (token !== this.token) return;
      if (previous) {
        // 只重新生成一部分失败：原报告还在，照旧显示并提示原因
        this.report = previous;
        this.render();
        if (typeof Toast !== 'undefined') Toast.error(`重新生成失败：${err.message}`);
        return;
      }
      this.setHead(p.label, '生成失败');
      this.setBody(`<div class="report-error">生成失败：${reportEsc(err.message)}</div>
        <div class="report-empty"><button type="button" class="btn-secondary" data-report-act="generate">重试</button></div>`);
    } finally {
      clearInterval(poll);
    }
  },

  render() {
    const r = this.report;
    const part = this.tab === 'team' ? 'team' : 'mine';
    const label = REPORT_PART_LABEL[part];
    // 两部分可以分别重新生成，各自显示自己的生成时间
    const at = new Date(r[part].generatedAt || r.generatedAt);
    const auto = r[part].generatedAt ? r[part].auto : r.auto;
    const meta = `「${label}」${auto ? '自动生成' : '手动生成'}于 ${at.getMonth() + 1}/${at.getDate()} ${reportPad(at.getHours())}:${reportPad(at.getMinutes())}`;
    this.setHead(r.label, meta, `
      <button type="button" class="btn-secondary report-act" data-report-act="copy" title="复制「${label}」部分">复制</button>
      <button type="button" class="btn-secondary report-act" data-report-act="push" title="把「${label}」部分推送到通知 / 群机器人">推送</button>
      <button type="button" class="btn-secondary report-act" data-report-act="generate" title="重新读取禅道数据，只重新生成「${label}」部分">重新生成</button>`);
    this.setBody(part === 'team' ? this.teamHtml(r) : this.mineHtml(r));
  },

  // ---------- 我的 ----------
  mineHtml(r) {
    const m = r.mine;
    const ai = m.ai;
    const periodic = r.kind !== 'daily';
    const stats = [
      ['工时', fmtHours(m.hours)],
      ['涉及任务', m.tasks.length],
      ['完成任务', m.finished.length],
      ['提交 / 解决 Bug', `${m.bugs.opened.length} / ${m.bugs.resolved.length}`],
      ...(periodic ? [['未填工时', `${m.missingDays.length} 天`]] : [])
    ];
    const section = (html) => (html ? `<section class="report-section">${html}</section>` : '');
    return `
      ${this.aiBlock(ai, m.aiError, ai && `
        <p class="report-ai-summary">${reportEsc(ai.summary)}</p>
        <div class="report-ai-groups">${this.aiList('✅ 已完成', ai.done)}${this.aiList('🔄 进行中', ai.progress)}${this.aiList('🎯 接下来', ai.next)}${this.aiList('⚠️ 风险', ai.risks, 'is-risk')}</div>`)}
      ${this.statsHtml(stats)}
      ${section(`${periodic ? `<h4 class="report-h">每天工时</h4>${this.dayStrip(m.byDay, r, m.missingDays)}` : ''}
        ${m.byProject.length ? `<h4 class="report-h">项目分布</h4>${this.bars(m.byProject.map(p => [p.project, p.hours]), m.hours)}` : ''}`.trim())}
      ${section(`<h4 class="report-h">工作明细</h4>${this.taskTable(m.tasks)}`)}
      ${section(m.finished.length ? `<h4 class="report-h">完成的任务</h4><ul class="report-list">${m.finished.map(t => `<li>${this.zLink('task', t.id)} ${reportEsc(t.name)} <span class="report-muted">${reportEsc(t.project)} · ${shortDate(t.finishedDate)}</span></li>`).join('')}</ul>` : '')}
      ${section(m.bugs.opened.length || m.bugs.resolved.length ? `<h4 class="report-h">Bug</h4><ul class="report-list">
        ${m.bugs.opened.map(b => `<li>${this.zLink('bug', b.id)} 提交：${reportEsc(b.title)} <span class="report-muted">${reportEsc(b.productName)}</span></li>`).join('')}
        ${m.bugs.resolved.map(b => `<li>${this.zLink('bug', b.id)} 解决：${reportEsc(b.title)} <span class="report-muted">${reportEsc(b.productName)}</span></li>`).join('')}</ul>` : '')}
      ${section(m.overdue.length ? `<h4 class="report-h">已逾期</h4><ul class="report-list is-risk">${m.overdue.map(t => `<li>${this.zLink('task', t.id)} ${reportEsc(t.name)} <span class="report-muted">截止 ${reportEsc(t.deadline)} · ${reportEsc(t.statusLabel)}</span></li>`).join('')}</ul>` : '')}
      ${this.footer(r)}`;
  },

  // ---------- 全员 ----------
  teamHtml(r) {
    const t = r.team;
    const ai = t.ai;
    const missing = t.members.filter(p => p.missingDays.length);
    const stats = [
      ['总工时', fmtHours(t.totalHours)],
      ['有工时记录', `${t.activeCount} / ${t.members.length} 人`],
      ['涉及项目', t.projects.length],
      ['逾期任务', t.overdueTotal]
    ];
    const missingText = r.kind === 'daily'
      ? missing.map(p => p.name).join('、')
      : missing.map(p => `${p.name}（${p.missingDays.length} 天）`).join('、');
    return `
      ${this.aiBlock(ai, t.aiError, ai && `
        <p class="report-ai-summary">${reportEsc(ai.overall)}</p>${this.aiList('⚠️ 需要关注', ai.risks, 'is-risk')}`)}
      ${this.statsHtml(stats)}
      ${missing.length ? `<div class="report-missing"><strong>未填工时：</strong>${reportEsc(missingText)}</div>` : ''}
      <nav class="report-subtabs">
        <button type="button" class="report-subtab ${this.teamTab === 'person' ? 'active' : ''}" data-report-teamtab="person">按人</button>
        <button type="button" class="report-subtab ${this.teamTab === 'project' ? 'active' : ''}" data-report-teamtab="project">按项目</button>
      </nav>
      ${this.teamTab === 'project' ? this.projectCards(r) : this.personCards(r)}
      ${t.overdue.length ? `<section class="report-section"><h4 class="report-h">逾期未完成（${t.overdueTotal}）</h4><ul class="report-list is-risk">${t.overdue.slice(0, 20).map(x => `<li>${this.zLink('task', x.id)} ${reportEsc(x.name)} <span class="report-muted">${reportEsc(x.assignedToName)} · 截止 ${reportEsc(x.deadline)} · ${reportEsc(x.project)}</span></li>`).join('')}</ul></section>` : ''}
      ${this.footer(r, true)}`;
  },

  /** 按人：有记录的人一张卡片（AI 总结直接可见，任务明细折叠）；没有任何记录的人合成一行 */
  personCards(r) {
    const aiOf = new Map(((r.team.ai && r.team.ai.byPerson) || []).map(x => [x.account, x.summary]));
    const active = r.team.members.filter(p => p.hours || p.finished.length);
    const idle = r.team.members.filter(p => !(p.hours || p.finished.length));
    const cards = active.map(p => `
      <section class="report-card">
        <div class="report-card-head">
          <span class="report-card-title">${reportEsc(p.name)}${p.role ? `<span class="report-role">${reportEsc(p.role)}</span>` : ''}</span>
          <span class="report-card-num">${fmtHours(p.hours)} · ${p.tasks.length} 个任务 · 完成 ${p.finished.length}</span>
        </div>
        ${aiOf.get(p.account) ? `<p class="report-card-ai">${reportEsc(aiOf.get(p.account))}</p>` : ''}
        ${r.kind !== 'daily' ? this.dayStrip(p.byDay, r, p.missingDays) : ''}
        ${p.tasks.length || p.finished.length ? `<details class="report-card-more"><summary>明细（${p.tasks.length} 个任务）</summary>
          ${p.tasks.length ? this.taskTable(p.tasks) : ''}
          ${p.finished.length ? `<div class="report-muted report-card-foot">完成：${p.finished.map(t => reportEsc(t.name)).join('、')}</div>` : ''}
        </details>` : ''}
      </section>`).join('');
    const idleLine = idle.length
      ? `<div class="report-idle">没有工时记录（${idle.length} 人）：${idle.map(p => reportEsc(p.name)).join('、')}</div>`
      : '';
    return (cards || '<div class="report-empty-line">这段时间没有团队成员的工时记录</div>') + idleLine;
  },

  /** 按项目：AI 总结与参与人直接可见，任务明细折叠 */
  projectCards(r) {
    if (!r.team.projects.length) return '<div class="report-empty-line">这段时间没有团队成员的工时记录</div>';
    const aiOf = new Map(((r.team.ai && r.team.ai.byProject) || []).map(x => [x.project, x.summary]));
    return r.team.projects.map(p => `
      <section class="report-card">
        <div class="report-card-head">
          <span class="report-card-title">${reportEsc(p.project)}</span>
          <span class="report-card-num">${fmtHours(p.hours)} · ${p.members.length} 人 · 完成 ${p.finished}</span>
        </div>
        ${aiOf.get(p.project) ? `<p class="report-card-ai">${reportEsc(aiOf.get(p.project))}</p>` : ''}
        <div class="report-chips">${p.members.map(m => `<span class="report-chip">${reportEsc(m.name)} ${fmtHours(m.hours)}</span>`).join('')}</div>
        <details class="report-card-more"><summary>明细（${p.tasks.length} 个任务）</summary>
          <table class="report-table"><thead><tr><th>任务</th><th>参与</th><th class="num">工时</th></tr></thead><tbody>
            ${p.tasks.map(t => `<tr><td>${this.zLink('task', t.taskId)} ${reportEsc(t.name)} <span class="report-muted">${reportEsc(t.statusLabel)}</span></td><td>${reportEsc(t.people.join('、'))}</td><td class="num">${fmtHours(t.hours)}</td></tr>`).join('')}
          </tbody></table>
        </details>
      </section>`).join('');
  },

  // ---------- 组件 ----------
  aiBlock(ai, error, inner) {
    if (ai) return `<section class="report-ai"><div class="report-ai-tag">AI 总结</div>${inner}</section>`;
    return `<section class="report-ai is-error"><div class="report-ai-tag">AI 总结</div><p>${reportEsc(error || 'AI 总结不可用')}，下面是统计数据。可点「重新生成」重试。</p></section>`;
  },

  aiList(title, items, cls = '') {
    if (!items || !items.length) return '';
    return `<div class="report-ai-group ${cls}"><div class="report-ai-group-title">${title}</div><ul>${items.map(x => `<li>${reportEsc(x)}</li>`).join('')}</ul></div>`;
  },

  statsHtml(stats) {
    return `<div class="report-stats">${stats.map(([k, v]) => `<div class="report-stat"><div class="report-stat-v">${reportEsc(v)}</div><div class="report-stat-k">${reportEsc(k)}</div></div>`).join('')}</div>`;
  },

  /** 周 / 月：每天的工时条，未填工时的工作日标红 */
  dayStrip(byDay, r, missingDays) {
    const days = [];
    const [y, m, d] = r.begin.split('-').map(Number);
    const cur = new Date(y, m - 1, d);
    const today = reportYmd(new Date());
    while (reportYmd(cur) <= r.end && reportYmd(cur) <= today) { days.push(reportYmd(cur)); cur.setDate(cur.getDate() + 1); }
    const miss = new Set(missingDays || []);
    const max = Math.max(8, ...days.map(s => byDay[s] || 0));
    return `<div class="report-strip">${days.map(s => {
      const h = byDay[s] || 0;
      const wk = new Date(...s.split('-').map((v, j) => (j === 1 ? Number(v) - 1 : Number(v)))).getDay();
      return `<div class="report-strip-day ${miss.has(s) ? 'is-missing' : ''} ${wk === 0 || wk === 6 ? 'is-weekend' : ''}" title="${s} ${WEEKDAY[wk]}：${fmtHours(h)}${miss.has(s) ? '（未填工时）' : ''}">
        <div class="report-strip-bar"><span style="height:${Math.round((h / max) * 100)}%"></span></div>
        <div class="report-strip-label">${r.kind === 'weekly' ? WEEKDAY[wk] : Number(s.slice(8))}</div></div>`;
    }).join('')}</div>`;
  },

  bars(rows, total) {
    return `<div class="report-bars">${rows.map(([name, h]) => `
      <div class="report-bar-row"><span class="report-bar-name" title="${reportEsc(name)}">${reportEsc(name)}</span>
        <span class="report-bar"><span style="width:${total ? Math.round((h / total) * 100) : 0}%"></span></span>
        <span class="report-bar-v">${fmtHours(h)}</span></div>`).join('')}</div>`;
  },

  taskTable(tasks) {
    if (!tasks.length) return '<div class="report-empty-line">没有工时记录</div>';
    return `<table class="report-table"><thead><tr><th>任务</th><th>工作内容</th><th class="num">工时</th></tr></thead><tbody>
      ${tasks.map(t => `<tr>
        <td>${this.zLink('task', t.taskId)} ${reportEsc(t.name)}<div class="report-muted">${reportEsc(t.project)}${t.statusLabel ? ` · ${reportEsc(t.statusLabel)}` : ''}</div></td>
        <td>${(t.works || []).map(w => `<div>${reportEsc(w)}</div>`).join('') || '<span class="report-muted">—</span>'}</td>
        <td class="num">${fmtHours(t.hours)}</td></tr>`).join('')}
    </tbody></table>`;
  },

  zLink(type, id) {
    return `<a href="#" class="report-zlink" data-report-zentao="${type}" data-id="${reportEsc(id)}">#${reportEsc(id)}</a>`;
  },

  footer(r, team = false) {
    const warn = (r.warnings || []).length ? `<div class="report-warn">部分数据没有读到（${r.warnings.length} 处）：${reportEsc(r.warnings.slice(0, 3).join('；'))}${r.warnings.length > 3 ? ' …' : ''}</div>` : '';
    const who = team && r.team.focused
      ? `设置里选定的 ${r.team.members.length} 人`
      : `团队 ${team ? r.team.members.length : r.coverage.members} 人（不含管理员）`;
    const scope = team
      ? `数据范围：你在禅道能看到的 ${r.coverage.executions} 个执行里的任务与工时记录；${who}。禅道没有对你开放的执行里的工作不会计入。`
      : `数据来自禅道：工时记录、任务与 Bug（${r.coverage.executions} 个执行）。`;
    return `<footer class="report-footer">${warn}<div>${scope}</div><div>生成用时 ${Math.round((r.durationMs || 0) / 1000)} 秒；之后补填的工时不会自动计入，可点「重新生成」更新。</div></footer>`;
  },

  legacyHtml(old) {
    const list = (title, items) => (items && items.length ? `<h4 class="report-h">${title}</h4><ul class="report-list">${items.map(x => `<li>${reportEsc(x)}</li>`).join('')}</ul>` : '');
    return `<section class="report-legacy"><div class="report-ai-tag">旧版日报（基于本地任务）</div>
      <p class="report-ai-summary">${reportEsc(old.summary || '')}</p>${list('已完成', old.completed)}${list('待办 / 进行中', old.tomorrowFocus)}${list('风险', old.risks)}</section>`;
  },

  /** 当前看的是哪一部分 */
  part() {
    return this.tab === 'team' ? 'team' : 'mine';
  },

  /** 复制当前标签的内容（纯文本） */
  copyText() {
    const body = document.querySelector('#reportDrawer .report-drawer-body');
    const text = `${this.report.label}（${REPORT_PART_LABEL[this.part()]}）\n\n${body ? (body.innerText || body.textContent).trim() : ''}`;
    return navigator.clipboard.writeText(text);
  },

  async onClick(e) {
    const el = this.ensureDom();
    if (e.target === el) return this.close();
    const z = e.target.closest('[data-report-zentao]');
    if (z) {
      e.preventDefault();
      if (typeof openInZentao === 'function') openInZentao(z.dataset.reportZentao, z.dataset.id);
      return;
    }
    const item = e.target.closest('[data-report-open-kind]');
    if (item) return this.open(item.dataset.reportOpenKind, item.dataset.reportOpenKey, { fromHistory: true });
    const tab = e.target.closest('[data-report-tab]');
    if (tab && this.report) {
      this.tab = tab.dataset.reportTab;
      return this.render();
    }
    const sub = e.target.closest('[data-report-teamtab]');
    if (sub) {
      this.teamTab = sub.dataset.reportTeamtab;
      return this.render();
    }
    const act = e.target.closest('[data-report-act]');
    if (!act) return;
    const action = act.dataset.reportAct;
    if (action === 'close') return this.close();
    if (action === 'history') return this.openHistory();
    // 推送、复制、重新生成只作用于当前看的那部分（我的 / 全员）
    const part = this.part();
    const label = REPORT_PART_LABEL[part];
    if (action === 'generate') {
      // 已有报告：只重新生成当前这部分；还没有报告（首次 / 失败重试）：整份生成
      if (!this.report) return this.generate();
      if (typeof Confirm !== 'undefined' && Confirm.show) {
        const other = REPORT_PART_LABEL[part === 'team' ? 'mine' : 'team'];
        const ok = await Confirm.show('重新生成', `会重新读取禅道数据并由 AI 重新总结「${label}」部分，覆盖现在的内容；「${other}」部分不变。继续吗？`);
        if (!ok) return;
      }
      return this.generate(part);
    }
    if (action === 'push') {
      act.disabled = true;
      try {
        await ReportApi.push(this.kind, this.key, part);
        if (typeof Toast !== 'undefined') Toast.success(`已推送「${label}」部分`);
      } catch (err) {
        if (typeof Toast !== 'undefined') Toast.error(err.message);
      } finally {
        act.disabled = false;
      }
      return;
    }
    if (action === 'copy') {
      try {
        await this.copyText();
        if (typeof Toast !== 'undefined') Toast.success(`已复制「${label}」部分`);
      } catch (err) {
        if (typeof Toast !== 'undefined') Toast.error(`复制失败：${err.message}`);
      }
    }
  }
};

/**
 * 设置 → 禅道集成 → 全员报告成员
 * 勾选框只是编辑界面，选中的账号写在隐藏输入框 #reportMembers 里（设置页按输入框判断有没有未保存的修改）
 */
const ReportMembersPicker = {
  loaded: false,

  els() {
    return {
      input: document.getElementById('reportMembers'),
      list: document.getElementById('reportMembersList'),
      hint: document.getElementById('reportMembersHint')
    };
  },

  selected() {
    const { input } = this.els();
    return input && input.value ? input.value.split(',').filter(Boolean) : [];
  },

  /** 打开设置时读取团队成员与已保存的选择 */
  async load() {
    const { input, list, hint } = this.els();
    if (!list) return;
    this.bind();
    list.innerHTML = '<span class="input-hint">正在读取禅道团队…</span>';
    try {
      const { data } = await ReportApi.members();
      this.members = data.members;
      input.value = data.selected.join(',');
      this.render();
      if (hint) hint.textContent = data.message || '';
    } catch (err) {
      list.innerHTML = `<span class="input-hint">读取团队成员失败：${reportEsc(err.message)}</span>`;
    } finally {
      if (window.settingsUI) window.settingsUI.refreshBaseline();
    }
  },

  render() {
    const { list, hint } = this.els();
    const picked = new Set(this.selected());
    // 已选但不在团队里的（离职等）也列出来，免得悄悄丢掉
    const all = [...(this.members || [])];
    for (const a of picked) if (!all.some(m => m.account === a)) all.push({ account: a, realname: a, role: '不在团队中' });
    list.innerHTML = all.length
      ? all.map(m => `<label class="report-member"><input type="checkbox" data-no-track value="${reportEsc(m.account)}" ${picked.has(m.account) ? 'checked' : ''}>
          ${reportEsc(m.realname)}${m.role ? ` <span class="report-member-role">${reportEsc(m.role)}</span>` : ''}</label>`).join('')
      : '<span class="input-hint">禅道团队里没有成员</span>';
    if (hint && this.members) hint.textContent = picked.size ? `已选 ${picked.size} 人` : '未选择 = 统计团队全员';
  },

  /** 勾选变化 → 写回隐藏输入框，并通知设置页「有未保存的修改」 */
  sync() {
    const { input, list } = this.els();
    input.value = [...list.querySelectorAll('input[type="checkbox"]:checked')].map(c => c.value).join(',');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    this.render();
  },

  bind() {
    if (this.bound) return;
    this.bound = true;
    const { list } = this.els();
    list.addEventListener('change', () => this.sync());
    const setAll = (on) => {
      list.querySelectorAll('input[type="checkbox"]').forEach(c => { c.checked = on; });
      this.sync();
    };
    document.getElementById('reportMembersAll')?.addEventListener('click', () => setAll(true));
    document.getElementById('reportMembersNone')?.addEventListener('click', () => setAll(false));
  },

  /** 随设置页「保存配置」一起保存 */
  async save() {
    if (!this.els().input || !this.members) return;
    await ReportApi.saveMembers(this.selected());
  }
};

/** 侧栏「智能总结」：今日日报 / 本周周报 / 本月月报打开报告页对应的报告；历史报告打开已生成报告列表 */
function bindReportSidebar() {
  const today = () => reportYmd(new Date());
  const targets = { daily: () => today(), weekly: () => today(), monthly: () => today().slice(0, 7) };
  Object.keys(targets).forEach(type => {
    const btn = document.getElementById(`gen${type.charAt(0).toUpperCase() + type.slice(1)}Btn`);
    if (btn) btn.addEventListener('click', () => ReportPage.openReport(type, targets[type]()));
  });
  const history = document.getElementById('viewAllHistory');
  if (history) history.addEventListener('click', () => ReportViewer.openHistory());
}

if (typeof window !== 'undefined') {
  window.ReportPage = ReportPage;
  window.ReportViewer = ReportViewer;
  window.ReportMembersPicker = ReportMembersPicker;
}
if (typeof document !== 'undefined') bindReportSidebar();
