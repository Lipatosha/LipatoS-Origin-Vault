/**
 * FilePickerMixin - 文件选择器模式
 * 从 MainWindow 提取的 FilePicker 拦截相关方法
 * 
 * 包含：FilePicker 模式打开/关闭、确认栏渲染、文件选择确认
 * 混入后通过 this 访问 MainWindow 实例状态
 */

import { MODULE_ID, OV_LAYERS } from '../../constants.js';
import { t } from '../../utils/i18n.js';

const PICKER_WINDOW_QUERY = '.application, .app, .window-app, .window-app-v2';

/**
 * 将方法混入目标类
 * @param {Function} cls - 目标类 (MainWindow)
 */
export function applyFilePickerMixin(cls) {
  cls.prototype._getPickerTopZIndex = function () {
    const managed = Number(window._ovWindowZ) || 0;
    const current = Number(this._pickerZIndex) || 0;
    const allZ = Array.from(document.querySelectorAll(PICKER_WINDOW_QUERY))
      .filter(el => el !== this.element)
      .map(el => Number.parseInt(window.getComputedStyle(el).zIndex, 10))
      .filter(Number.isFinite);

    return Math.max(OV_LAYERS.WINDOWED, managed, current, ...allZ);
  };

  cls.prototype._applyPickerZIndex = function (zIndex) {
    if (!this.element) return;
    this._pickerZIndex = zIndex;
    this.element.style.setProperty('z-index', String(zIndex), 'important');
  };

  cls.prototype._bringPickerToFront = function () {
    const next = this._getPickerTopZIndex() + 1;
    window._ovWindowZ = next;
    this._applyPickerZIndex(next);
    return next;
  };
  /**
   * 渲染底部确认栏
   */
  cls.prototype._renderPickerBar = function () {
    if (!this.element) return;

    // 移除旧的
    const existing = this.element.querySelector('.ov-picker-bar');
    if (existing) existing.remove();

    if (!this.filePickerMode) return;

    const bar = document.createElement('div');
    bar.className = 'ov-picker-bar';
    bar.innerHTML = `
        <div class="ov-picker-bar-info">
          <i class="fas fa-mouse-pointer"></i>
          <span>${t('origin-vault.picker.hint')}</span>
        </div>
        <div class="ov-picker-bar-actions">
          <button class="ov-picker-switch-native" type="button" title="${t('origin-vault.picker.switchNativeHint')}">
            <i class="fas fa-exchange-alt"></i> ${t('origin-vault.picker.switchNative')}
          </button>
          <button class="ov-picker-cancel" type="button">
            <i class="fas fa-times"></i> ${t('origin-vault.picker.cancel')}
          </button>
          <button class="ov-picker-confirm" type="button" disabled>
            <i class="fas fa-check"></i> ${t('origin-vault.picker.confirm')}
          </button>
        </div>
      `;

    // 事件绑定
    bar.querySelector('.ov-picker-cancel').addEventListener('click', () => {
      this._exitFilePickerMode();
    });
    bar.querySelector('.ov-picker-confirm').addEventListener('click', () => {
      if (this.selectedItems.size === 1) {
        const itemId = [...this.selectedItems][0];
        const item = this.library.getItem(itemId);
        if (item) {
          this._confirmFilePicker(item.path);
        }
      }
    });
    bar.querySelector('.ov-picker-switch-native').addEventListener('click', () => {
      this._switchToNativeFilePicker();
    });

    this.element.appendChild(bar);

    // 添加标记样式
    this.element.classList.add('ov-picker-mode');

    // 先给 picker 一个兜底值，然后立刻按当前窗口栈重算层级。
    this._pickerZIndex = 100;
    this._bringPickerToFront();

    if (this._pickerMouseHandler) {
      document.removeEventListener('mousedown', this._pickerMouseHandler, true);
      this._pickerMouseHandler = null;
    }

    this._pickerMouseHandler = (e) => {
      if (!this.filePickerMode || !this.element) return;
      if (this.element.contains(e.target)) {
        // 点回 OV 时，按当前窗口栈重新申请一个最高层级。
        this._bringPickerToFront();
      } else {
        // 点击其他窗口：降低 OV 的 z-index，让被点击的窗口自然浮到上方
        this._applyPickerZIndex(1);
      }
    };
    document.addEventListener('mousedown', this._pickerMouseHandler, true);
  };

  /**
   * 更新确认按钮状态（选中时启用）
   */
  cls.prototype._updatePickerConfirmState = function () {
    if (!this.filePickerMode) return;
    const btn = this.element?.querySelector('.ov-picker-confirm');
    if (btn) {
      btn.disabled = this.selectedItems.size !== 1;
    }
  };

  /**
   * 确认选择文件
   * @param {string} path - 文件路径
   */
  cls.prototype._confirmFilePicker = function (path) {
    if (!this.filePickerMode) return;

    const callback = this.filePickerCallback;
    const field = this.filePickerField;
    const fpInstance = this.filePickerInstance;
    // 先清除实例引用，防止 _exitFilePickerMode 重复关闭
    this.filePickerInstance = null;
    this._exitFilePickerMode();

    // 先调用回调（直接更新调用方的值）
    if (typeof callback === 'function') {
      callback(path);
    }

    // V13 兼容: {{filePicker}} 通过 fromButton() 只设置 field 而不设置 callback
    // 需要手动更新 field 的值并触发 change 事件
    if (field && (!callback || typeof callback !== 'function')) {
      field.value = path;
      field.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // 然后关闭隐藏的原生 FilePicker（触发 Foundry 的 close hook）
    // FVTTFilePickerControl 通过监听 close 事件来完成其生命周期
    if (fpInstance) {
      try {
        fpInstance.result = path;
        fpInstance.request = path;
        // 先让原生 picker 可见（否则 close 可能跳过动画逻辑）
        if (fpInstance.element) {
          const el = fpInstance.element instanceof jQuery
            ? fpInstance.element[0]
            : fpInstance.element;
          if (el) el.style.display = '';
        }
        if (typeof fpInstance.close === 'function') {
          fpInstance.close();
        }
      } catch (e) {
        console.warn(`${MODULE_ID} | Failed to close native FilePicker:`, e);
      }
    }
  };

  /**
   * 退出文件选择器模式
   */
  cls.prototype._exitFilePickerMode = function () {
    // 关闭隐藏的原生 FilePicker（如果存在且没被 _confirmFilePicker 处理）
    if (this.filePickerInstance) {
      try {
        const fpInstance = this.filePickerInstance;
        if (fpInstance.element) {
          const el = fpInstance.element instanceof jQuery
            ? fpInstance.element[0]
            : fpInstance.element;
          if (el) el.style.display = '';
        }
        if (typeof fpInstance.close === 'function') {
          fpInstance.close();
        }
      } catch (e) {
        // 静默处理，可能已经被关闭
      }
    }

    this.filePickerMode = false;
    this.filePickerCallback = null;
    this.filePickerField = null;
    this.filePickerInstance = null;
    this.filePickerOptions = null;

    // 移除确认栏
    const bar = this.element?.querySelector('.ov-picker-bar');
    if (bar) bar.remove();

    // 移除标记样式和动态 z-index
    if (this._pickerMouseHandler) {
      document.removeEventListener('mousedown', this._pickerMouseHandler, true);
      this._pickerMouseHandler = null;
    }
    this._pickerZIndex = null;
    this.element?.classList.remove('ov-picker-mode');

    // 恢复原始窗口模式
    if (this._savedIsWindowed !== undefined) {
      this.isWindowed = this._savedIsWindowed;
      delete this._savedIsWindowed;
    }

    // 隐藏窗口
    this.constructor.hide();
  };

  /**
   * 切换到原生文件选择器：恢复被隐藏的原生 FilePicker，关闭 OV
   */
  cls.prototype._switchToNativeFilePicker = function () {
    const fpInstance = this.filePickerInstance;
    if (fpInstance) {
      // 标记此实例跳过 OV 拦截，避免文件夹导航时重新触发
      fpInstance._ovSkipIntercept = true;

      if (fpInstance.element) {
        const el = fpInstance.element instanceof jQuery
          ? fpInstance.element[0]
          : fpInstance.element;
        if (el) {
          // 恢复原生 FilePicker 的所有样式
          el.style.display = '';
          el.style.position = '';
          el.style.left = '';
          el.style.top = '';
          el.style.opacity = '';
          el.style.pointerEvents = '';
        }
      }
    }

    // 清理 OV 的 picker 模式（不关闭原生 picker）
    this.filePickerMode = false;
    this.filePickerCallback = null;
    this.filePickerField = null;
    this.filePickerInstance = null;
    this.filePickerOptions = null;

    const bar = this.element?.querySelector('.ov-picker-bar');
    if (bar) bar.remove();
    if (this._pickerMouseHandler) {
      document.removeEventListener('mousedown', this._pickerMouseHandler, true);
      this._pickerMouseHandler = null;
    }
    this._pickerZIndex = null;
    this.element?.classList.remove('ov-picker-mode');

    // 恢复原始窗口模式
    if (this._savedIsWindowed !== undefined) {
      this.isWindowed = this._savedIsWindowed;
      delete this._savedIsWindowed;
    }

    this.constructor.hide();
  };
}
