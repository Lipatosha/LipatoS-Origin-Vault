/**
 * WindowMixin - 窗口管理
 * 从 MainWindow 提取的窗口位置、拖拽、缩放相关方法
 * 
 * 包含：全屏定位、窗口拖拽、窗口缩放、加载遮罩
 * 混入后通过 this 访问 MainWindow 实例状态
 */

import { MODULE_ID, OV_LAYERS } from '../../constants.js';
import { t } from '../../utils/i18n.js';
import { ovLog } from '../../utils/logger.js';

const OV_FULLSCREEN_SHELL_Z = String(OV_LAYERS.SHELL);
const OV_WORKSPACE_BODY_CLASS = 'ov-workspace-active';
const OV_WINDOW_MIN_WIDTH = 800;
const OV_WINDOW_MIN_HEIGHT = 565;

function readFiniteNumber(value) {
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * 将方法混入目标类
 * @param {Function} cls - 目标类 (MainWindow)
 */
export function applyWindowMixin(cls) {
  /**
   * 现在这个状态下，OV 要不要接管整张工作台。
   * 窗口模式和 FilePicker 都别掺和外围 UI。
   */
  cls.prototype._shouldActivateWorkspaceShell = function() {
    return !this.isWindowed && !this.filePickerMode && !this._workspaceShellSuspended;
  };

  /**
   * 把 body 上那层工作区状态和当前模式对齐。
   * 第一阶段先靠这个类藏掉外围 UI，别再让 OV 用 z-index 硬压全场。
   *
   * @param {object} [options]
   * @param {boolean} [options.forceActive]
   */
  cls.prototype._syncWorkspaceShellState = function({ forceActive } = {}) {
    const shouldActivate = forceActive ?? this._shouldActivateWorkspaceShell();

    if (document.body) {
      document.body.classList.toggle(OV_WORKSPACE_BODY_CLASS, shouldActivate);
    }

    if (this.element) {
      this.element.classList.toggle('ov-workspace-shell-active', shouldActivate);
    }

    // 这里顺手让 MainWindow 清一下历史残留的浮层状态，
    // 省得模式切换后还挂着旧 class 或内联 z-index。
    this._syncGlobalLayerManagement?.();
  };

  cls.prototype._getDefaultWindowBounds = function() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let width = Math.round(vw * 0.70);
    width = Math.max(OV_WINDOW_MIN_WIDTH, Math.min(width, 1280));
    let height = Math.round(width / 1.414);
    height = Math.max(OV_WINDOW_MIN_HEIGHT, Math.min(height, vh * 0.85));

    return {
      width,
      height,
      left: Math.max(0, (vw - width) / 2),
      top: Math.max(0, (vh - height) / 2)
    };
  };

  cls.prototype._readWindowBounds = function(el = this.element) {
    if (!el) return null;

    const rect = typeof el.getBoundingClientRect === 'function'
      ? el.getBoundingClientRect()
      : null;

    const width = readFiniteNumber(el.style.width) ?? rect?.width;
    const height = readFiniteNumber(el.style.height) ?? rect?.height;
    const left = readFiniteNumber(el.style.left) ?? rect?.left;
    const top = readFiniteNumber(el.style.top) ?? rect?.top;

    if (![width, height, left, top].every(Number.isFinite)) return null;
    if (width <= 0 || height <= 0) return null;

    return { left, top, width, height };
  };

  cls.prototype._rememberWindowBounds = function(bounds = this._readWindowBounds()) {
    if (!bounds) return null;

    this._windowedBounds = {
      left: bounds.left,
      top: bounds.top,
      width: Math.max(OV_WINDOW_MIN_WIDTH, bounds.width),
      height: Math.max(OV_WINDOW_MIN_HEIGHT, bounds.height)
    };
    return this._windowedBounds;
  };

  cls.prototype._applyWindowBounds = function(bounds) {
    const el = this.element;
    if (!el || !bounds) return;

    el.style.left = `${bounds.left}px`;
    el.style.top = `${bounds.top}px`;
    el.style.width = `${bounds.width}px`;
    el.style.height = `${bounds.height}px`;
  };

  /**
   * 临时让 OV 工作区壳让位。
   * 主要给 SceneConfig 这种流程用，OV 会淡出去，但别把外面也一起锁死。
   *
   * @param {boolean} [suspended=true]
   */
  cls.prototype._setWorkspaceShellSuspended = function(suspended = true) {
    this._workspaceShellSuspended = suspended;
    this._syncWorkspaceShellState();
  };

  /**
   * 设置全屏位置
   */
  cls.prototype._setFullscreenPosition = function() {
    if (!this.element) return;

    // V2: this.element IS the native HTMLElement
    const el = this.element;
    const header = el.querySelector('.ov-header');

    // 清除旧的拖拽实例（如果有）以防止冲突
    if (this._dragHandler) {
      // Foundry 的 Draggable 没有 destroy 方法，通常我们只需要重新实例化
    }

    if (this.isWindowed) {
      el.classList.add('windowed-mode');

      const bounds = this._windowedBounds || this._rememberWindowBounds(this._getDefaultWindowBounds());
      this._applyWindowBounds(bounds);
      el.style.transform = '';
      el.style.margin = '';
      el.style.position = '';

      // 文件选择器模式：使用 inline !important 设置动态 z-index
      // inline !important 优先级高于所有 CSS !important 规则
      if (this.filePickerMode) {
        const z = this._pickerZIndex || 100;
        el.style.setProperty('z-index', String(z), 'important');
      } else {
        // 窗口化时回到 Foundry 原生窗口栈，别再把 OV 钉死在高层。
        // 这样侧边栏新开的 sheet 才能正常靠 bringToTop 压到 OV 上面。
        el.style.removeProperty('z-index');
      }
      el.style.padding = '';
      el.style.border = '';

      // 绑定自定义拖拽和缩放（不使用 Foundry 的 Draggable，避免冲突）
      if (header) {
        this._bindWindowDrag(header, el);
        this._bindWindowResize(el);
      }

      this._syncWorkspaceShellState();

    } else {
      el.classList.remove('windowed-mode');
      // 强制全屏样式
      el.style.width = '100vw';
      el.style.height = '100vh';
      el.style.left = '0';
      el.style.top = '0';
      el.style.position = 'fixed';
      el.style.zIndex = OV_FULLSCREEN_SHELL_Z;
      el.style.margin = '0';
      el.style.padding = '0';
      el.style.borderRadius = '0';
      el.style.border = 'none';
      el.style.boxShadow = 'none';

      // CRITICAL FIX: Reparent to body to escape UI container constraints
      if (el.parentElement !== document.body) {
        document.body.appendChild(el);
      }

      this._syncWorkspaceShellState();
    }
  };

  /**
   * Custom drag handler for windowed mode header.
   * More reliable than Foundry's Draggable for custom headers full of interactive elements.
   */
  cls.prototype._bindWindowDrag = function(header, el) {
    if (this._windowDragCleanup) {
      this._windowDragCleanup();
      this._windowDragCleanup = null;
    }

    let isDragging = false;
    let startX, startY, startLeft, startTop;

    const onPointerDown = (e) => {
      // Only left button
      if (e.button !== 0) return;
      // Skip if clicking directly on button/input/select
      if (e.target.closest('button, input, select, textarea, a')) return;

      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = parseInt(el.style.left) || 0;
      startTop = parseInt(el.style.top) || 0;
      header.setPointerCapture(e.pointerId);
      e.preventDefault();
    };

    const onPointerMove = (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      el.style.left = `${startLeft + dx}px`;
      el.style.top = `${startTop + dy}px`;
    };

    const onPointerUp = () => {
      if (isDragging) {
        this._userMovedWindow = true;
        this._rememberWindowBounds();
      }
      isDragging = false;
    };

    header.addEventListener('pointerdown', onPointerDown);
    header.addEventListener('pointermove', onPointerMove);
    header.addEventListener('pointerup', onPointerUp);
    header.addEventListener('pointercancel', onPointerUp);

    this._windowDragCleanup = () => {
      header.removeEventListener('pointerdown', onPointerDown);
      header.removeEventListener('pointermove', onPointerMove);
      header.removeEventListener('pointerup', onPointerUp);
      header.removeEventListener('pointercancel', onPointerUp);
    };
  };

  /**
   * Custom resize handler for windowed mode.
   * Creates an invisible resize zone at bottom-right corner.
   */
  cls.prototype._bindWindowResize = function(el) {
    if (this._windowResizeCleanup) {
      this._windowResizeCleanup();
      this._windowResizeCleanup = null;
    }

    // Create or reuse resize handle
    let handle = el.querySelector('.ov-resize-handle');
    if (!handle) {
      handle = document.createElement('div');
      handle.className = 'ov-resize-handle';
      el.appendChild(handle);
    }

    let isResizing = false;
    let startX, startY, startW, startH;

    const onPointerDown = (e) => {
      if (e.button !== 0) return;
      isResizing = true;
      startX = e.clientX;
      startY = e.clientY;
      startW = el.getBoundingClientRect().width;
      startH = el.getBoundingClientRect().height;
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    };

    const onPointerMove = (e) => {
      if (!isResizing) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      const newW = Math.max(OV_WINDOW_MIN_WIDTH, startW + dx);
      const newH = Math.max(600, startH + dy);
      el.style.width = `${newW}px`;
      el.style.height = `${newH}px`;
    };

    const onPointerUp = () => {
      if (isResizing) {
        this._userResized = true;
        this._rememberWindowBounds();
      }
      isResizing = false;
    };

    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', onPointerUp);
    handle.addEventListener('pointercancel', onPointerUp);

    this._windowResizeCleanup = () => {
      handle.removeEventListener('pointerdown', onPointerDown);
      handle.removeEventListener('pointermove', onPointerMove);
      handle.removeEventListener('pointerup', onPointerUp);
      handle.removeEventListener('pointercancel', onPointerUp);
    };
  };

  /**
   * Override setPosition to prevent V2 from resetting our fullscreen styles
   * @param {object} position 
   */
  cls.prototype.setPosition = function(position = {}) {
    if (!this.isWindowed) {
      // In fullscreen mode, ignore all positioning requests
      // and force our specific styles
      const el = this.element;
      if (el) {
        el.style.width = '100vw';
        el.style.height = '100vh';
        el.style.left = '0';
        el.style.top = '0';
        el.style.position = 'fixed';
        el.style.zIndex = OV_FULLSCREEN_SHELL_Z;
      }
      return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight, scale: 1 };
    }
    // In windowed mode: if this is a user-initiated drag/resize, honor it.
    // Otherwise, enforce A4 landscape ratio to prevent Foundry from
    // re-applying DEFAULT_OPTIONS (1024x768).
    const el = this.element;
    if (!el) return position;

    const bounds = this._windowedBounds || this._rememberWindowBounds(this._getDefaultWindowBounds());
    this._applyWindowBounds(bounds);
    return { ...position, ...bounds };
  };

  /**
   * 显示加载遮罩
   * @param {string} [message] - loading message
   */
  cls.prototype._showLoadingOverlay = function(message) {
    const container = $(this.element).find('.origin-vault-container');
    if (!container.length) {
      console.warn('Origin Vault | Cannot show loading overlay: container not found');
      return;
    }

    const msg = message || t('origin-vault.browser.loading');

    // 如果已存在，更新文本
    const existing = container.find('.ov-loading-overlay');
    // container is already a jQuery object from above
    if (existing.length) {
      existing.find('p').text(msg);
      return;
    }

    const overlay = $(`
      <div class="ov-loading-overlay">
        <div class="ov-loading-spinner">
          <i class="fas fa-circle-notch fa-spin fa-3x"></i>
          <p>${msg}</p>
        </div>
      </div>
    `);
    container.append(overlay);
    ovLog('Origin Vault | Loading overlay shown');
  };

  /**
   * 隐藏加载遮罩
   */
  cls.prototype._hideLoadingOverlay = function() {
    this.element?.querySelector('.ov-loading-overlay')?.remove();
    ovLog('Origin Vault | Loading overlay hidden');
  };
}
