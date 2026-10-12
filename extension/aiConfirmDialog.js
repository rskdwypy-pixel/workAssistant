/**
 * AI 归属确认对话框
 *
 * 用途：当 AI 对「这条任务属于哪个执行」把握不足时，
 * 不静默填一个默认值，而是把候选摆给用户选。
 * 用户每一次确认/纠正都会写入学习库（POST /api/ai/learn），成为训练数据。
 *
 * 设计原则：可取消、可键盘操作、样式跟随现有 Toast/Modal 体系。
 */
const AiConfirmDialog = (() => {
  let overlayEl = null;

  /**
   * 显示确认对话框
   * @param {string} title - 标题
   * @param {string} message - 说明文字
   * @param {Array<{id, name, projectName}>} candidates - 候选执行
   * @param {string} currentId - 当前已选中的执行 id
   * @returns {Promise<{id,name,projectName}|null>} 选中项；取消返回 null
   */
  function show(title, message, candidates, currentId) {
    return new Promise((resolve) => {
      if (!Array.isArray(candidates) || candidates.length === 0) {
        resolve(null);
        return;
      }

      close();

      const safe = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

      overlayEl = document.createElement('div');
      overlayEl.id = 'aiConfirmOverlay';
      overlayEl.style.cssText = `
        position:fixed; inset:0; z-index:100000;
        background:rgba(0,0,0,0.45);
        display:flex; align-items:center; justify-content:center;
      `;

      const listHtml = candidates.map((c, i) => {
        const selected = String(c.id) === String(currentId);
        return `
          <button type="button" data-exec-id="${safe(c.id)}"
            style="display:block;width:100%;text-align:left;margin:6px 0;padding:10px 12px;
                   border:1.5px solid ${selected ? '#3b82f6' : '#e2e8f0'};
                   border-radius:8px;background:${selected ? '#eff6ff' : '#fff'};
                   cursor:pointer;font-size:14px;line-height:1.5;">
            <div style="font-weight:600;color:#1e293b;">${safe(c.name || '未命名执行')}</div>
            ${c.projectName ? `<div style="font-size:12px;color:#64748b;margin-top:2px;">${safe(c.projectName)}</div>` : ''}
          </button>`;
      }).join('');

      overlayEl.innerHTML = `
        <div style="background:#fff;border-radius:12px;max-width:420px;width:calc(100% - 40px);
                    max-height:80vh;overflow:auto;padding:20px;box-shadow:0 10px 40px rgba(0,0,0,.2);">
          <h3 style="margin:0 0 6px;font-size:16px;color:#0f172a;">${safe(title)}</h3>
          <p style="margin:0 0 12px;font-size:13px;color:#64748b;line-height:1.6;">${safe(message)}</p>
          <div id="aiConfirmList">${listHtml}</div>
          <div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end;">
            <button type="button" id="aiConfirmSkip"
              style="padding:7px 16px;border:1px solid #e2e8f0;background:#fff;border-radius:6px;
                     cursor:pointer;color:#64748b;font-size:13px;">跳过</button>
          </div>
        </div>`;

      document.body.appendChild(overlayEl);

      const finish = (value) => {
        close();
        resolve(value);
      };

      // 候选点击
      overlayEl.querySelectorAll('button[data-exec-id]').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-exec-id');
          const found = candidates.find(c => String(c.id) === String(id));
          finish(found || null);
        });
      });

      // 跳过
      const skip = overlayEl.querySelector('#aiConfirmSkip');
      if (skip) skip.addEventListener('click', () => finish(null));

      // 点击遮罩空白处 = 取消
      overlayEl.addEventListener('click', (e) => {
        if (e.target === overlayEl) finish(null);
      });

      // Esc 取消
      const onKey = (e) => {
        if (e.key === 'Escape') {
          document.removeEventListener('keydown', onKey);
          finish(null);
        }
      };
      document.addEventListener('keydown', onKey);
    });
  }

  function close() {
    if (overlayEl && overlayEl.parentNode) {
      overlayEl.parentNode.removeChild(overlayEl);
    }
    overlayEl = null;
  }

  return { show, close };
})();

if (typeof window !== 'undefined') {
  window.AiConfirmDialog = AiConfirmDialog;
}