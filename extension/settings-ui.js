/* ============================================================================
   禅道助手 · 设置页 UI 层
   ----------------------------------------------------------------------------
   职责边界：只负责「展示与交互」
     · 左侧分组导航（含 ↑↓ 方向键、roving tabindex、aria-selected）
     · 底部保存栏的脏状态跟踪（有 N 项未保存的修改 / 保存按钮启用态）
     · 密码字段显示切换
     · 调试模式对 body 类的同步（决定 .debug-only 元素是否可见）
     · 「重置默认」二次确认（防误触丢配置）

   数据读写仍由 newtab.js 负责（loadSettings / saveSettings / 校验逻辑）。
   协作方式：newtab.js 在合适的时机调用 window.settingsUI 上的钩子。
     · onOpen()          打开设置后调用 → 回到默认分组并记录「已保存」基线
     · refreshBaseline() 配置加载 / 保存 / 重置完成后调用 → 重设基线
     · showGroup(id)     由外部指定要打开的分组（顶栏「提示词」按钮用）
   ============================================================================ */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var modal = $('settingsModal');
  var nav = $('settingsNav');
  var content = $('settingsContent');
  var draftBox = $('draftIndicator');
  var draftText = $('draftText');
  var resetBtn = $('resetSettings');
  var saveBtn = $('saveSettings');
  var debugToggle = $('debugModeToggle');

  if (!modal || !nav || !content) return;   // 设置弹窗不存在时静默退出

  var navButtons = Array.prototype.slice.call(nav.querySelectorAll('button[data-panel]'));
  var panels = Array.prototype.slice.call(content.querySelectorAll('.set-panel'));
  var baseline = [];

  /* ============================================================
     分组切换
     ============================================================ */
  function setBtnLabel(btn, text) {
    if (!btn) return;
    var label = btn.querySelector('.btn-label');
    if (label) label.textContent = text;
    else btn.textContent = text;
  }

  function showGroup(panelId, shouldFocus) {
    var target = null;
    navButtons.forEach(function (b) {
      var active = b.getAttribute('data-panel') === panelId;
      if (active) target = b;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
      b.setAttribute('tabindex', active ? '0' : '-1');
    });
    if (!target) return;
    panels.forEach(function (p) {
      p.classList.toggle('active', p.id === panelId);
    });
    if (shouldFocus) target.focus();
    // 切换分组后内容区回到顶部，避免继承上一组的滚动位置
    content.scrollTop = 0;
  }

  navButtons.forEach(function (b) {
    b.addEventListener('click', function () {
      showGroup(b.getAttribute('data-panel'));
    });
  });

  // 键盘导航：↑↓ 在分组间移动，Home/End 跳到首尾
  nav.addEventListener('keydown', function (e) {
    var idx = navButtons.indexOf(document.activeElement);
    if (idx < 0) return;
    var next = -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (idx + 1) % navButtons.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (idx - 1 + navButtons.length) % navButtons.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = navButtons.length - 1;
    if (next >= 0) {
      e.preventDefault();
      showGroup(navButtons[next].getAttribute('data-panel'), true);
    }
  });

  /* ============================================================
     脏状态跟踪 —— 底部保存栏
     ============================================================ */
  function fields() {
    // 排除两类控件：
    //  · 文件选择框：值不是「配置内容」，且选过文件后无法回到空值
    //  · data-no-track：动作开关（如「同时停用开机自启」），不随保存写入配置
    return Array.prototype.slice.call(
      content.querySelectorAll('input:not([type="file"]):not([data-no-track]), select, textarea')
    );
  }

  function valueOf(el) {
    return el.type === 'checkbox' ? el.checked : el.value;
  }

  function labelOf(el) {
    var row = el.closest('.set-row') || el.closest('.set-prompt-item');
    if (!row) return el.id || '未命名字段';
    var label = row.querySelector('.sr-label') || row.querySelector('.pi-head label');
    if (!label) return el.id || '未命名字段';
    // 去掉必填星号与副标题，只留主标签
    var clone = label.cloneNode(true);
    Array.prototype.forEach.call(clone.querySelectorAll('small, .req'), function (n) { n.remove(); });
    return clone.textContent.trim();
  }

  function refreshBaseline() {
    baseline = fields().map(valueOf);
    renderFooter();
  }

  function renderFooter() {
    var items = fields();
    var changed = [];
    items.forEach(function (el, i) {
      if (valueOf(el) !== baseline[i]) changed.push(labelOf(el));
    });

    if (changed.length) {
      draftBox.classList.add('is-dirty');
      draftText.textContent = '有 ' + changed.length + ' 项未保存的修改';
      draftBox.title = '未保存：' + changed.join('、');
      saveBtn.disabled = false;
    } else {
      draftBox.classList.remove('is-dirty');
      draftText.textContent = '所有更改已保存';
      draftBox.title = '';
      saveBtn.disabled = true;
    }
  }

  fields().forEach(function (el) {
    el.addEventListener('input', renderFooter);
    el.addEventListener('change', renderFooter);
  });

  /* ============================================================
     密码字段显示切换
     ============================================================ */
  Array.prototype.forEach.call(
    modal.querySelectorAll('[data-pw-toggle]'),
    function (btn) {
      btn.addEventListener('click', function () {
        var input = $(btn.getAttribute('data-pw-toggle'));
        if (!input) return;
        var show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        setBtnLabel(btn, show ? '隐藏' : '显示');
        input.focus();
      });
    }
  );

  /* ============================================================
     调试模式对 body 类的影响（.debug-only 元素是否可见）
     状态本身由 newtab.js 维护，这里只在打开面板时做一次同步，
     避免两边各写一份造成的状态漂移。
     ============================================================ */
  function syncDebugClass() {
    var on = !!(debugToggle && debugToggle.checked);
    document.body.classList.toggle('debug-on', on);
  }

  /* ============================================================
     「重置默认」二次确认
     ============================================================ */
  var resetArmed = false;
  var resetTimer = null;

  function disarmReset() {
    resetArmed = false;
    if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
    setBtnLabel(resetBtn, '重置默认');
    resetBtn.classList.remove('set-btn-danger');
    resetBtn.classList.add('set-btn-ghost');
    resetBtn.removeAttribute('aria-pressed');
  }

  resetBtn.addEventListener('click', function () {
    if (!resetArmed) {
      resetArmed = true;
      setBtnLabel(resetBtn, '确认重置？');
      resetBtn.classList.remove('set-btn-ghost');
      resetBtn.classList.add('set-btn-danger');
      resetBtn.setAttribute('aria-pressed', 'true');
      resetTimer = setTimeout(disarmReset, 3000);
      return;
    }
    disarmReset();
    var ok = false;
    try {
      localStorage.removeItem('workAssistantConfig');
      ok = true;
    } catch (err) {
      console.warn('[设置] 重置本地配置失败:', err);
    }
    if (typeof loadSettings === 'function') loadSettings();
    refreshBaseline();
    if (typeof Toast !== 'undefined') {
      ok ? Toast.success('已恢复默认设置') : Toast.error('重置失败，请重试');
    }
  });

  // 点到别处自动取消「确认重置」状态，避免长时间停留在危险态
  document.addEventListener('click', function (e) {
    if (resetArmed && !resetBtn.contains(e.target)) disarmReset();
  });

  /* ============================================================
     对外钩子
     ============================================================ */
  function onOpen() {
    showGroup('p-service');
    disarmReset();
    syncDebugClass();
    refreshBaseline();
  }

  // 服务动作的结果展示在服务卡内，样式收敛到一处
  var serviceResult = $('serviceActionResult');
  if (serviceResult) serviceResult.classList.add('test-result');

  window.settingsUI = {
    onOpen: onOpen,
    refreshBaseline: refreshBaseline,
    showGroup: showGroup
  };
})();
