import { ovText } from '../utils/locale.js';
/**
 * Origin Vault - 后台导入悬浮进度窗口
 * ---------------------------------------------------
 * 当用户在导入/缩略图生成期间关闭 OV 窗口时，
 * 这个小浮窗会出现在 FVTT 主界面上，显示后台任务进度。
 * 
 * 可拖拽、可点击（重新打开 OV），任务完成后自动消失。
 * 挂在 document.body 上，独立于 OV 的 Application DOM。
 */

import { MODULE_ID } from '../constants.js';

export class ImportFloater {
    static #instance = null;

    static getInstance() {
        if (!ImportFloater.#instance) {
            ImportFloater.#instance = new ImportFloater();
        }
        return ImportFloater.#instance;
    }

    constructor() {
        /** @type {HTMLElement|null} */
        this._el = null;
        /** @type {boolean} */
        this._visible = false;
        /** @type {{x: number, y: number}|null} 记住上次拖拽位置 */
        this._savedPosition = null;

        // 拖拽状态
        this._dragging = false;
        this._dragOffset = { x: 0, y: 0 };
        this._onMouseMove = this._onMouseMove.bind(this);
        this._onMouseUp = this._onMouseUp.bind(this);
    }

    /** 当前是否可见 */
    isVisible() {
        return this._visible;
    }

    /**
     * 显示悬浮窗
     * @param {object} task - 后台任务信息
     * @param {string} task.label - 任务标题
     * @param {number} task.completed - 已完成数
     * @param {number} task.total - 总数
     */
    show(task) {
        if (!this._el) {
            this._createElement();
        }

        this.update(task.completed, task.total, task.label);
        this._el.classList.add('ov-floater-visible');
        this._visible = true;
    }

    /**
     * 更新进度
     * @param {number} current 
     * @param {number} total 
     * @param {string} [label] 
     */
    update(current, total, label) {
        if (!this._el) return;

        const pct = total > 0 ? Math.min(100, (current / total) * 100) : 0;
        const fill = this._el.querySelector('.ov-floater-progress-fill');
        const text = this._el.querySelector('.ov-floater-progress-text');
        const titleEl = this._el.querySelector('.ov-floater-title');

        if (fill) fill.style.width = `${pct}%`;
        if (text) text.textContent = `${current} / ${total}`;
        if (label && titleEl) titleEl.textContent = label;
    }

    /**
     * 隐藏并移除悬浮窗
     * @param {boolean} [immediate=false] - 是否跳过淡出动画
     */
    hide(immediate = false) {
        if (!this._el) return;

        if (immediate) {
            this._remove();
            return;
        }

        // 记住位置
        this._savedPosition = {
            x: parseInt(this._el.style.left) || null,
            y: parseInt(this._el.style.top) || null
        };

        this._el.classList.remove('ov-floater-visible');
        this._el.classList.add('ov-floater-hiding');
        setTimeout(() => this._remove(), 300);
    }

    /**
     * 任务完成 — 短暂显示完成状态后消失
     */
    complete() {
        if (!this._el) return;

        const fill = this._el.querySelector('.ov-floater-progress-fill');
        const text = this._el.querySelector('.ov-floater-progress-text');
        const titleEl = this._el.querySelector('.ov-floater-title');
        const icon = this._el.querySelector('.ov-floater-icon i');

        if (fill) fill.style.width = '100%';
        if (text) text.textContent = game.i18n?.localize('origin-vault.notifications.importComplete') || ovText('Complete!', 'Готово!');
        if (titleEl) titleEl.textContent = 'Origin Vault';
        if (icon) {
            icon.className = 'fas fa-check';
            icon.style.color = '#4ade80';
        }

        // 2 秒后自动消失
        setTimeout(() => this.hide(), 2000);
    }

    // ========== Private ==========

    _createElement() {
        const el = document.createElement('div');
        el.id = 'ov-import-floater';
        el.className = 'ov-import-floater';
        el.innerHTML = `
      <div class="ov-floater-header">
        <div class="ov-floater-icon">
          <i class="fas fa-spinner fa-spin"></i>
        </div>
        <div class="ov-floater-info">
          <div class="ov-floater-title">Origin Vault</div>
          <div class="ov-floater-progress-text">0 / 0</div>
        </div>
      </div>
      <div class="ov-floater-progress-track">
        <div class="ov-floater-progress-fill"></div>
      </div>
    `;

        // 恢复上次拖拽位置，或使用默认右下角
        if (this._savedPosition?.x != null) {
            el.style.left = `${this._savedPosition.x}px`;
            el.style.top = `${this._savedPosition.y}px`;
            el.style.right = 'auto';
            el.style.bottom = 'auto';
        }

        // 拖拽事件
        const header = el.querySelector('.ov-floater-header');
        header.addEventListener('mousedown', (e) => this._onMouseDown(e));

        // 点击打开 OV 窗口
        el.addEventListener('click', (e) => {
            // 不在拖拽中才触发
            if (!this._wasDragged) {
                this._openVault();
            }
            this._wasDragged = false;
        });

        document.body.appendChild(el);
        this._el = el;
    }

    _remove() {
        if (this._el) {
            this._el.remove();
            this._el = null;
        }
        this._visible = false;
    }

    _openVault() {
        // 动态导入避免循环依赖
        import('./MainWindow.js').then(({ MainWindow }) => {
            MainWindow.show();
        });
    }

    // ========== Drag ==========

    _onMouseDown(e) {
        // 只响应左键
        if (e.button !== 0) return;
        e.preventDefault();

        this._dragging = true;
        this._wasDragged = false;
        const rect = this._el.getBoundingClientRect();
        this._dragOffset.x = e.clientX - rect.left;
        this._dragOffset.y = e.clientY - rect.top;

        document.addEventListener('mousemove', this._onMouseMove);
        document.addEventListener('mouseup', this._onMouseUp);
        this._el.classList.add('ov-floater-dragging');
    }

    _onMouseMove(e) {
        if (!this._dragging || !this._el) return;

        this._wasDragged = true;
        const x = e.clientX - this._dragOffset.x;
        const y = e.clientY - this._dragOffset.y;

        // 限制在视窗内
        const maxX = window.innerWidth - this._el.offsetWidth;
        const maxY = window.innerHeight - this._el.offsetHeight;

        this._el.style.left = `${Math.max(0, Math.min(x, maxX))}px`;
        this._el.style.top = `${Math.max(0, Math.min(y, maxY))}px`;
        this._el.style.right = 'auto';
        this._el.style.bottom = 'auto';
    }

    _onMouseUp() {
        this._dragging = false;
        document.removeEventListener('mousemove', this._onMouseMove);
        document.removeEventListener('mouseup', this._onMouseUp);
        if (this._el) {
            this._el.classList.remove('ov-floater-dragging');
        }
    }
}
