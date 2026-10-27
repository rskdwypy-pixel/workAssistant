/**
 * 禅道个人待办（地盘 → 我的待办）：在「我的待办」页的“禅道待办”卡片里新建 / 编辑 / 改状态 / 删除。
 *
 *   ZtTodoApi   后端 /api/zentao-todos 的封装
 *   ZtTodo      弹窗：类型（自定义 / 任务 / Bug / 需求）、指派人、状态、私人事务、优先级、日期时间、
 *               描述（可以粘贴 / 拖入截图）；周期待办只能改状态，其余请在禅道里改
 *
 * 数据都在禅道里，这里只做显示和提交（前端不存业务数据）。
 * 依赖 newtab.js / todos.js 里的全局（调用时才访问）：API_BASE_URL、Toast、Confirm、TodoPage、openInZentao、tdEsc。
 */

const ZT_STATUS = { wait: '未开始', doing: '进行中', done: '已完成', closed: '已关闭' };
const ZT_TYPE = { custom: '自定义', task: '任务', bug: 'Bug', story: '需求', cycle: '周期' };
const ZT_PRI = { 1: '1（最高）', 2: '2', 3: '3', 4: '4（最低）' };

const ZtTodoApi = {
  base() { return typeof API_BASE_URL !== 'undefined' ? API_BASE_URL : 'http://127.0.0.1:3721'; },
  async call(method, path, body) {
    const init = { method, headers: {} };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    const resp = await fetch(`${this.base()}/api/zentao-todos${path}`, init);
    const json = await resp.json().catch(() => ({ success: false, message: `HTTP ${resp.status}` }));
    if (!json.success) throw new Error(json.message || `HTTP ${resp.status}`);
    return json.data;
  },
  get: (id) => ZtTodoApi.call('GET', `/${encodeURIComponent(id)}`),
  create: (b) => ZtTodoApi.call('POST', '', b),
  update: (id, b) => ZtTodoApi.call('PUT', `/${encodeURIComponent(id)}`, b),
  status: (id, status) => ZtTodoApi.call('POST', `/${encodeURIComponent(id)}/status`, { status }),
  remove: (id) => ZtTodoApi.call('DELETE', `/${encodeURIComponent(id)}`),
  candidates: (type) => ZtTodoApi.call('GET', `/candidates?type=${encodeURIComponent(type)}`),
  async image(uid, file) {
    const name = file.name || 'image.png';
    const resp = await fetch(`${this.base()}/api/zentao-todos/image?uid=${encodeURIComponent(uid)}&name=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { 'Content-Type': file.type || 'image/png' }, body: file
    });
    const json = await resp.json().catch(() => ({ success: false, message: `HTTP ${resp.status}` }));
    if (!json.success) throw new Error(json.message || `HTTP ${resp.status}`);
    return json.data.url;
  },
  async users() {
    try {
      const r = await (await fetch(`${this.base()}/api/zentao/users`)).json();
      return (r && (r.data || r.users)) || {};
    } catch { return {}; }
  }
};

const ZtTodo = {
  ALLOWED: new Set(['P', 'BR', 'DIV', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'CODE', 'BLOCKQUOTE', 'A', 'IMG', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH']),

  /** 描述是禅道里别人也能写的 HTML：只留常见的排版标签，去掉脚本 / 事件属性 / 奇怪的链接 */
  sanitize(html) {
    const doc = new DOMParser().parseFromString(`<body>${String(html || '')}</body>`, 'text/html');
    const walk = (node) => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === 3) continue;
        if (child.nodeType !== 1) { child.remove(); continue; }
        if (!this.ALLOWED.has(child.tagName)) {
          if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'SVG', 'MATH'].includes(child.tagName)) { child.remove(); continue; }
          walk(child);
          child.replaceWith(...child.childNodes);   // 未知标签：留内容、去外壳
          continue;
        }
        for (const attr of [...child.attributes]) {
          const n = attr.name.toLowerCase(), v = attr.value;
          const keep = (child.tagName === 'A' && n === 'href' && /^(https?:|mailto:)/i.test(v.trim()))
            || (child.tagName === 'IMG' && n === 'src' && /^(https?:\/\/|data:image\/(png|jpe?g|gif|webp|bmp);)/i.test(v.trim()))
            || (child.tagName === 'IMG' && n === 'alt');
          if (!keep) child.removeAttribute(attr.name);
        }
        if (child.tagName === 'A') { child.setAttribute('target', '_blank'); child.setAttribute('rel', 'noopener noreferrer'); }
        walk(child);
      }
    };
    walk(doc.body);
    return doc.body.innerHTML;
  },

  esc(s) { return typeof tdEsc === 'function' ? tdEsc(s) : String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
  toast(kind, msg) { if (typeof Toast !== 'undefined' && Toast[kind]) Toast[kind](msg); },
  changed() { if (typeof TodoPage !== 'undefined' && TodoPage.load) TodoPage.load(); },
  close() { document.querySelectorAll('.zt-overlay').forEach(o => o.remove()); },

  /** 状态按钮：下一步能做什么 */
  nextAction(status) {
    return status === 'wait' ? { to: 'doing', label: '开始', title: '开始做（改成进行中）' }
      : status === 'doing' ? { to: 'done', label: '完成', title: '标记为已完成' }
      : { to: 'wait', label: '重做', title: '重新打开（改回未开始）' };
  },

  async quickStatus(id, status) {
    try {
      await ZtTodoApi.status(id, status);
      this.toast('success', `已改成「${ZT_STATUS[status]}」`);
    } catch (err) {
      this.toast('error', `没有改成功：${err.message}`);
    }
    this.changed();
  },

  /** 打开弹窗：不传 id = 新建 */
  async open({ id } = {}) {
    this.close();
    const overlay = document.createElement('div');
    overlay.className = 'zt-overlay';
    overlay.innerHTML = `<div class="zt-box" role="dialog" aria-modal="true" aria-label="${id ? '待办详情' : '新建待办'}"><div class="zt-loading">${id ? '读取中…' : '准备中…'}</div></div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) this.close(); });
    const onKey = (e) => { if (e.key === 'Escape') { this.close(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);

    let todo = null;
    try {
      todo = id ? await ZtTodoApi.get(id) : { id: '', type: 'custom', objectId: '', name: '', pri: 3, status: 'wait', desc: '', date: this.today(), begin: '', end: '', private: false, assignedTo: '', cycle: false };
    } catch (err) {
      overlay.querySelector('.zt-box').innerHTML = `<div class="zt-loading">读取失败：${this.esc(err.message)}</div><div class="zt-actions"><button type="button" class="btn-secondary" data-zt="cancel">关闭</button></div>`;
      overlay.querySelector('[data-zt="cancel"]').addEventListener('click', () => this.close());
      return;
    }
    const users = await ZtTodoApi.users();
    this.render(overlay, todo, users);
  },

  today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },

  render(overlay, todo, users) {
    const E = (s) => this.esc(s);
    const isNew = !todo.id;
    const readOnly = !!todo.cycle;   // 周期待办：配置复杂，只允许改状态
    const uid = `wa${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const opt = (map, cur) => Object.entries(map).map(([k, v]) => `<option value="${E(k)}"${String(k) === String(cur) ? ' selected' : ''}>${E(v)}</option>`).join('');
    const userOptions = `<option value="">我自己</option>` + Object.entries(users).map(([a, n]) => `<option value="${E(a)}"${a === todo.assignedTo ? ' selected' : ''}>${E(n)}（${E(a)}）</option>`).join('');
    const typeMap = readOnly ? { cycle: '周期' } : { custom: '自定义', task: '任务', bug: 'Bug', story: '需求' };
    const dis = readOnly ? ' disabled' : '';
    overlay.querySelector('.zt-box').innerHTML = `
      <h3>${isNew ? '新建待办' : '待办详情'}${todo.id ? ` <span class="zt-muted">#${E(todo.id)}</span>` : ''}</h3>
      ${readOnly ? '<div class="zt-note">这是周期待办，名称 / 周期等请在禅道里改；这里可以改状态。</div>' : ''}
      <div class="zt-grid">
        <label>类型<select name="type"${dis}>${opt(typeMap, todo.type)}</select></label>
        <label>优先级<select name="pri"${dis}>${opt(ZT_PRI, todo.pri)}</select></label>
        <label>状态<select name="status">${opt(ZT_STATUS, todo.status)}</select></label>
        <label>指派给<select name="assignedTo"${dis}>${userOptions}</select></label>
      </div>
      <label class="zt-row zt-link" hidden>关联的对象<input type="search" name="filter" placeholder="输入关键字或编号筛选" autocomplete="off"><select name="objectId" size="5"></select></label>
      <label class="zt-row zt-name-row">名称<input type="text" name="name" maxlength="255" value="${E(todo.name)}" placeholder="要做什么"${dis}></label>
      <div class="zt-grid zt-when">
        <label>日期<input type="date" name="date" value="${E(todo.date)}"${dis}></label>
        <label class="zt-check"><input type="checkbox" name="nodate"${todo.date ? '' : ' checked'}${dis}>待定（不设日期）</label>
        <label>开始<input type="time" name="begin" step="600" value="${E(todo.begin)}"${dis}></label>
        <label>结束<input type="time" name="end" step="600" value="${E(todo.end)}"${dis}></label>
        <label class="zt-check"><input type="checkbox" name="notime"${todo.begin ? '' : ' checked'}${dis}>不设时间</label>
        <label class="zt-check"><input type="checkbox" name="private"${todo.private ? ' checked' : ''}${dis}>私人事务</label>
      </div>
      <div class="zt-row">描述 <span class="zt-muted">（可以粘贴或拖入截图）</span>
        <div class="zt-desc" contenteditable="${readOnly ? 'false' : 'true'}" role="textbox" aria-multiline="true" data-placeholder="补充说明…"></div>
      </div>
      <div class="zt-error" role="alert"></div>
      <div class="zt-actions">
        ${isNew ? '' : '<button type="button" class="btn-secondary zt-danger" data-zt="delete">删除</button><button type="button" class="btn-secondary" data-zt="open">在禅道打开</button>'}
        <span class="zt-spacer"></span>
        <button type="button" class="btn-secondary" data-zt="cancel">取消</button>
        ${readOnly ? '' : '<button type="button" class="btn-primary" data-zt="save">保存</button>'}
        ${readOnly ? '<button type="button" class="btn-primary" data-zt="save">保存状态</button>' : ''}
      </div>`;
    const box = overlay.querySelector('.zt-box');
    const $ = (sel) => box.querySelector(sel);
    const f = (n) => box.querySelector(`[name="${n}"]`);
    const desc = $('.zt-desc');
    desc.innerHTML = this.sanitize(todo.desc);
    const err = (m) => { $('.zt-error').textContent = m || ''; };

    // 类型 ↔ 关联对象
    let candidates = [];
    const syncType = async () => {
      const type = f('type').value;
      const linked = type === 'task' || type === 'bug' || type === 'story';
      $('.zt-link').hidden = !linked;
      $('.zt-name-row').hidden = linked;
      if (!linked) return;
      f('objectId').innerHTML = '<option>读取中…</option>';
      try { candidates = await ZtTodoApi.candidates(type); } catch (e) { candidates = []; err(`读取${ZT_TYPE[type]}列表失败：${e.message}`); }
      fillCandidates();
    };
    const fillCandidates = () => {
      const q = f('filter').value.trim().toLowerCase();
      const cur = f('objectId').dataset.cur || todo.objectId;
      const list = candidates.filter(c => !q || String(c.id).includes(q) || String(c.title).toLowerCase().includes(q));
      const keepCur = cur && !list.some(c => String(c.id) === String(cur)) && !q ? [{ id: cur, title: todo.type === f('type').value && todo.name ? todo.name : `#${cur}` }] : [];
      f('objectId').innerHTML = [...keepCur, ...list].slice(0, 200).map(c => `<option value="${E(c.id)}"${String(c.id) === String(cur) ? ' selected' : ''}>#${E(c.id)} ${E(c.title)}</option>`).join('') || '<option value="">没有可选的</option>';
    };
    f('objectId').addEventListener('change', () => { f('objectId').dataset.cur = f('objectId').value; });
    f('filter').addEventListener('input', fillCandidates);
    f('type').addEventListener('change', () => { f('objectId').dataset.cur = ''; syncType(); });
    if (todo.type === 'task' || todo.type === 'bug' || todo.type === 'story') syncType();

    const syncWhen = () => {
      f('date').disabled = readOnly || f('nodate').checked;
      f('begin').disabled = f('end').disabled = readOnly || f('notime').checked;
    };
    f('nodate').addEventListener('change', syncWhen);
    f('notime').addEventListener('change', syncWhen);
    syncWhen();

    // 描述里的图片：粘贴 / 拖入 → 上传到禅道 → 插入
    const insertImage = async (file) => {
      const ph = document.createElement('span');
      ph.className = 'zt-uploading'; ph.textContent = '图片上传中…';
      desc.appendChild(ph);
      try {
        const url = await ZtTodoApi.image(uid, file);
        const img = document.createElement('img'); img.src = url; img.alt = file.name || '截图';
        ph.replaceWith(img);
      } catch (e) {
        ph.remove(); err(`图片没有传上去：${e.message}`);
      }
    };
    const imagesOf = (dt) => [...((dt && dt.files) || [])].filter(x => /^image\//.test(x.type));
    desc.addEventListener('paste', (e) => {
      const imgs = imagesOf(e.clipboardData);
      if (!imgs.length) return;
      e.preventDefault(); imgs.forEach(insertImage);
    });
    desc.addEventListener('drop', (e) => {
      const imgs = imagesOf(e.dataTransfer);
      if (!imgs.length) return;
      e.preventDefault(); imgs.forEach(insertImage);
    });

    $('[data-zt="cancel"]').addEventListener('click', () => this.close());
    const openBtn = $('[data-zt="open"]');
    if (openBtn) openBtn.addEventListener('click', () => { if (typeof openInZentao === 'function') openInZentao('todo', todo.id); });
    const delBtn = $('[data-zt="delete"]');
    if (delBtn) delBtn.addEventListener('click', async () => {
      const ok = typeof Confirm !== 'undefined' && Confirm.show ? await Confirm.show('删除待办', `确定删除「${todo.name || '#' + todo.id}」吗？禅道里也会删掉。`, '删除', '取消') : true;
      if (!ok) return;
      delBtn.disabled = true;
      try { await ZtTodoApi.remove(todo.id); this.close(); this.toast('success', '待办已删除'); this.changed(); }
      catch (e) { err(e.message); delBtn.disabled = false; }
    });

    $('[data-zt="save"]').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget;
      err('');
      if (desc.querySelector('.zt-uploading')) return err('图片还在上传，稍等一下再保存');
      const clone = desc.cloneNode(true);
      const type = readOnly ? 'cycle' : f('type').value;
      const linked = type === 'task' || type === 'bug' || type === 'story';
      const body = {
        type, name: f('name').value.trim(), objectId: linked ? (f('objectId').value || '') : '',
        pri: Number(f('pri').value), assignedTo: f('assignedTo').value,
        date: f('nodate').checked ? '' : f('date').value,
        begin: f('notime').checked ? '' : f('begin').value, end: f('notime').checked ? '' : f('end').value,
        private: f('private').checked, desc: this.sanitize(clone.innerHTML), uid
      };
      const want = f('status').value;
      if (!readOnly) {
        if (type === 'custom' && !body.name) return err('请填写待办名称');
        if (linked && !body.objectId) return err(`请选择关联的${ZT_TYPE[type]}`);
        if (!f('nodate').checked && !body.date) return err('请选择日期，或勾选“待定”');
        if (!f('notime').checked && (!body.begin || !body.end)) return err('请填写开始和结束时间，或勾选“不设时间”');
        if (body.begin && body.end && body.end < body.begin) return err('结束时间不能早于开始时间');
      }
      btn.disabled = true; btn.textContent = '保存中…';
      try {
        let saved = todo;
        if (!readOnly) saved = isNew ? await ZtTodoApi.create(body) : await ZtTodoApi.update(todo.id, body);
        if (saved.status !== want) await ZtTodoApi.status(saved.id, want);
        this.close();
        this.toast('success', isNew ? '待办已创建' : '待办已保存');
        this.changed();
      } catch (e) {
        err(e.message);
        btn.disabled = false; btn.textContent = readOnly ? '保存状态' : '保存';
      }
    });
    setTimeout(() => (readOnly ? $('[data-zt="cancel"]') : (isNew ? f('name') : $('[data-zt="save"]')))?.focus(), 0);
  }
};

if (typeof window !== 'undefined') { window.ZtTodo = ZtTodo; window.ZtTodoApi = ZtTodoApi; }
