/**
 * 协作：在任务 / Bug 的详情里直接评论、转交（任务），并看最近的动态（谁、做了什么、备注）。
 *
 *   CollabPanel.mount(host, obj, { type: 'task' | 'bug' | 'story', onChanged })
 *
 * obj.zentaoId 是禅道里的编号，没有就说明还没同步到禅道，只给一句提示。
 * 后端：GET /api/zentao/history、POST /api/zentao/comment、POST /api/zentao/task/assign（见 src/services/zentaoService.js）。
 * 依赖 newtab.js 里的全局（调用时才访问）：API_BASE_URL、Toast、ZentaoBrowserClient（用户列表）。
 */
const CollabPanel = {
  ACTION_LABEL: {
    opened: '创建', edited: '编辑', commented: '备注', assigned: '指派', started: '开始', finished: '完成', paused: '暂停', canceled: '取消',
    restarted: '继续', closed: '关闭', activated: '激活', resolved: '解决', bugconfirmed: '确认', confirmed: '确认', reviewed: '评审',
    submitreview: '提交评审', changed: '变更', recordestimate: '记录工时', edited_estimate: '修改工时', deleted: '删除', undeleted: '还原'
  },

  base() {
    return typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : 'http://127.0.0.1:3721';
  },
  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },
  toast(kind, msg) {
    if (typeof Toast !== 'undefined' && Toast[kind]) Toast[kind](msg);
  },
  async api(path, body) {
    const init = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const resp = await fetch(`${this.base()}${path}`, init);
    return resp.json();
  },

  /** 用户列表 {账号: 姓名}；取不到就空（转交的下拉里没有人可选） */
  async users() {
    try {
      if (typeof ZentaoBrowserClient !== 'undefined' && ZentaoBrowserClient.getUsers) return (await ZentaoBrowserClient.getUsers()) || {};
      const r = await this.api('/api/zentao/users');
      return (r && (r.data || r.users)) || {};
    } catch {
      return {};
    }
  },

  rel(dateStr) {
    const t = new Date(String(dateStr || '').replace(' ', 'T')).getTime();
    if (!t) return '';
    const d = new Date(t);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}-${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  },

  async mount(host, obj, { type = 'task', onChanged } = {}) {
    if (!host) return;
    const zid = obj && obj.zentaoId;
    if (!zid) {
      host.innerHTML = '<div class="collab-hint">还没同步到禅道，同步后可以在这里评论' + (type === 'task' ? '、转交' : '') + '。</div>';
      return;
    }
    const canAssign = type === 'task' && obj.status !== 'done';
    const users = canAssign ? await this.users() : {};
    const options = Object.entries(users)
      .filter(([account]) => account !== (obj.assignedTo || ''))
      .map(([account, name]) => `<option value="${this.esc(account)}">${this.esc(name)}（${this.esc(account)}）</option>`).join('');
    host.innerHTML = `
      <div class="collab-box">
        <div class="collab-title">协作</div>
        <textarea class="collab-input" rows="2" maxlength="5000" placeholder="写一条备注，会记在禅道里（Ctrl/⌘ + 回车发送）"></textarea>
        <div class="collab-row">
          <button type="button" class="btn-secondary collab-send">发送备注</button>
          ${canAssign && options ? `
          <span class="collab-spacer"></span>
          <select class="collab-assignee" aria-label="转交给"><option value="">转交给…</option>${options}</select>
          <button type="button" class="btn-secondary collab-assign" disabled>转交</button>` : ''}
        </div>
        <div class="collab-history" aria-live="polite"><div class="collab-hint">读取动态…</div></div>
      </div>`;
    const $ = (sel) => host.querySelector(sel);
    const input = $('.collab-input');
    const send = $('.collab-send');
    const sel = $('.collab-assignee');
    const assignBtn = $('.collab-assign');

    const reload = async () => {
      const box = $('.collab-history');
      if (!box) return;
      try {
        const r = await this.api(`/api/zentao/history?type=${encodeURIComponent(type)}&id=${encodeURIComponent(zid)}&limit=8`);
        if (!r.success) throw new Error(r.message || '读取失败');
        const rows = r.data || [];
        box.innerHTML = rows.length ? rows.map((a) => `
          <div class="collab-item">
            <span class="collab-who">${this.esc(a.actorName)}</span>
            <span class="collab-act">${this.esc(this.ACTION_LABEL[a.action] || a.action)}</span>
            <span class="collab-time">${this.esc(this.rel(a.date))}</span>
            ${a.comment ? `<div class="collab-comment">${this.esc(a.comment)}</div>` : ''}
          </div>`).join('') : '<div class="collab-hint">还没有动态</div>';
      } catch (err) {
        box.innerHTML = `<div class="collab-hint">读取动态失败：${this.esc(err.message)}</div>`;
      }
    };

    const doSend = async () => {
      const text = input.value.trim();
      if (!text) { input.focus(); return; }
      send.disabled = true;
      send.textContent = '发送中…';
      try {
        const r = await this.api('/api/zentao/comment', { type, id: String(zid), comment: text });
        if (!r.success) throw new Error(r.message || '发送失败');
        input.value = '';
        this.toast('success', '备注已添加');
        await reload();
      } catch (err) {
        this.toast('error', `备注没有发出去：${err.message}`);
      } finally {
        send.disabled = false;
        send.textContent = '发送备注';
      }
    };
    send.addEventListener('click', doSend);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doSend(); } });

    if (sel && assignBtn) {
      sel.addEventListener('change', () => { assignBtn.disabled = !sel.value; });
      assignBtn.addEventListener('click', async () => {
        const to = sel.value;
        if (!to) return;
        const name = users[to] || to;
        assignBtn.disabled = true;
        assignBtn.textContent = '转交中…';
        try {
          const r = await this.api('/api/zentao/task/assign', { taskId: String(zid), assignedTo: to, comment: input.value.trim() });
          if (!r.success) throw new Error(r.message || '转交失败');
          input.value = '';
          this.toast('success', `已转交给 ${name}，同步后会从你的任务里消失`);
          await reload();
          if (typeof onChanged === 'function') onChanged();
        } catch (err) {
          this.toast('error', `没有转交成功：${err.message}`);
        } finally {
          assignBtn.textContent = '转交';
          assignBtn.disabled = !sel.value;
        }
      });
    }
    await reload();
  }
};

if (typeof window !== 'undefined') window.CollabPanel = CollabPanel;
