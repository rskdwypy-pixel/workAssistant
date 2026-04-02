/**
 * 按钮状态管理器
 * 统一管理按钮的加载状态、禁用状态和恢复
 */
const ButtonStateManager = {
  // 存储按钮的原始状态
  _buttonStates: new Map(),

  /**
   * 设置按钮为加载状态
   * @param {string|HTMLElement} button - 按钮ID或按钮元素
   * @param {Object} options - 配置选项
   * @param {string} options.loadingText - 加载时显示的文本
   * @param {boolean} options.disableInput - 是否同时禁用关联的输入框
   * @param {string} options.inputId - 关联的输入框ID
   * @returns {Function} 恢复函数
   */
  setLoading(button, options = {}) {
    const {
      loadingText = '处理中...',
      disableInput = false,
      inputId = null
    } = options;

    console.log('[ButtonStateManager] setLoading 调用:', { button, loadingText, disableInput, inputId });

    // 获取按钮元素
    const btn = typeof button === 'string'
      ? document.getElementById(button)
      : button;

    if (!btn) {
      console.warn('[ButtonStateManager] ⚠ 按钮未找到:', button);
      return () => {};
    }

    // 保存原始状态
    const buttonId = btn.id || `btn_${Date.now()}`;
    const originalState = {
      text: btn.textContent,
      disabled: btn.disabled,
      className: btn.className
    };

    this._buttonStates.set(buttonId, originalState);

    console.log('[ButtonStateManager] 保存按钮原始状态:', originalState);

    // 设置加载状态
    btn.textContent = loadingText;
    btn.disabled = true;
    btn.classList.add('loading');

    // 如果需要，禁用关联的输入框
    let inputState = null;
    if (disableInput && inputId) {
      const input = document.getElementById(inputId);
      if (input) {
        inputState = {
          disabled: input.disabled,
          placeholder: input.placeholder
        };
        input.disabled = true;
        console.log('[ButtonStateManager] 禁用输入框:', inputId);
      }
    }

    // 返回恢复函数
    return () => {
      this.restore(button, { inputState, inputId });
    };
  },

  /**
   * 恢复按钮状态
   * @param {string|HTMLElement} button - 按钮ID或按钮元素
   * @param {Object} options - 配置选项
   * @param {Object} options.inputState - 输入框的原始状态
   * @param {string} options.inputId - 输入框的ID
   */
  restore(button, options = {}) {
    const { inputState = null, inputId = null } = options;

    console.log('[ButtonStateManager] restore 调用:', { button, inputState, inputId });

    // 获取按钮元素
    const btn = typeof button === 'string'
      ? document.getElementById(button)
      : button;

    if (!btn) {
      console.warn('[ButtonStateManager] ⚠ 按钮未找到:', button);
      return;
    }

    const buttonId = btn.id || `btn_${Date.now()}`;
    const originalState = this._buttonStates.get(buttonId);

    if (originalState) {
      // 恢复原始状态
      btn.textContent = originalState.text;
      btn.disabled = originalState.disabled;
      btn.className = originalState.className;
      btn.classList.remove('loading');

      this._buttonStates.delete(buttonId);
      console.log('[ButtonStateManager] ✓ 按钮状态已恢复');
    } else {
      console.warn('[ButtonStateManager] ⚠ 未找到按钮的原始状态');
    }

    // 恢复输入框状态
    if (inputState && inputId) {
      const input = document.getElementById(inputId);
      if (input) {
        input.disabled = inputState.disabled;
        if (inputState.placeholder !== undefined) {
          input.placeholder = inputState.placeholder;
        }
        console.log('[ButtonStateManager] ✓ 输入框状态已恢复');
      }
    }
  },

  /**
   * 包装异步操作，自动管理按钮状态
   * @param {string|HTMLElement} button - 按钮ID或按钮元素
   * @param {Function} asyncOperation - 异步操作函数
   * @param {Object} options - 配置选项
   * @returns {Promise<any>} 异步操作的结果
   */
  async wrap(button, asyncOperation, options = {}) {
    console.log('[ButtonStateManager] wrap 调用:', { button, options });
    const restore = this.setLoading(button, options);

    try {
      const result = await asyncOperation();
      console.log('[ButtonStateManager] ✓ 异步操作成功');
      return result;
    } catch (error) {
      console.error('[ButtonStateManager] ✗ 异步操作失败:', error);
      throw error;
    } finally {
      restore();
      console.log('[ButtonStateManager] 按钮状态已恢复');
    }
  },

  /**
   * 批量管理多个按钮
   * @param {Array<string|HTMLElement>} buttons - 按钮ID或元素数组
   * @param {Function} asyncOperation - 异步操作函数
   * @param {Object} options - 配置选项
   * @returns {Promise<any>} 异步操作的结果
   */
  async wrapMultiple(buttons, asyncOperation, options = {}) {
    console.log('[ButtonStateManager] wrapMultiple 调用:', { buttonCount: buttons.length, options });
    const restoreFunctions = buttons.map(btn =>
      this.setLoading(btn, options)
    );

    try {
      const result = await asyncOperation();
      console.log('[ButtonStateManager] ✓ 批量异步操作成功');
      return result;
    } catch (error) {
      console.error('[ButtonStateManager] ✗ 批量异步操作失败:', error);
      throw error;
    } finally {
      restoreFunctions.forEach(restore => restore());
      console.log('[ButtonStateManager] 所有按钮状态已恢复');
    }
  },

  /**
   * 清除所有缓存的状态
   */
  clearCache() {
    console.log('[ButtonStateManager] clearCache 调用');
    this._buttonStates.clear();
  }
};
