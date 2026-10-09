/**
 * Origin Vault - 资源库选择器组件
 * 显示在侧边栏顶部，用于切换和管理资源库
 */

import { MODULE_ID, OV_LAYERS } from '../constants.js';
import { LibraryManager } from '../data/LibraryManager.js';
import { StoreApp } from './StoreApp.js';
import { t, tf } from '../utils/i18n.js';
import { appendToOverlayHost } from '../utils/overlayHost.js';

export class LibrarySelector {
  /**
   * @param {HTMLElement} container - 容器元素
   * @param {object} options - 选项
   */
  constructor(container, options = {}) {
    this.container = container;
    this.options = options;
    this.libraryManager = LibraryManager.getInstance();
    this._boundHandleClick = this._handleClick.bind(this);
    this._boundHandleOutsideClick = this._handleOutsideClick.bind(this);
  }

  /**
   * 渲染选择器
   */
  async render() {
    const activeLibrary = this.libraryManager.getActiveLibrary();
    const allLibraries = this.libraryManager.getAllLibraries();

    const html = `
      <div class="ov-library-selector">
        <div class="ov-library-current" data-action="toggle-dropdown">
          <div class="ov-library-color-dot" style="background-color: ${activeLibrary?.color || '#5b9bd5'}"></div>
          <span class="ov-library-name">${activeLibrary?.name || t('origin-vault.dialog.selector.switch')}</span>
          <i class="fas fa-chevron-down ov-library-chevron"></i>
        </div>
        <div class="ov-library-dropdown hidden">
          <div class="ov-library-list">
            ${allLibraries.map(lib => {
              const isActive = lib.id === activeLibrary?.id && lib.path === activeLibrary?.path;
              return `
              <div class="ov-library-item ${isActive ? 'active' : ''}" 
                   data-action="switch-library" 
                   data-library-id="${lib.id}"
                   data-library-path="${lib.path}">
                <div class="ov-library-color-dot" style="background-color: ${lib.color}"></div>
                <div class="ov-library-info">
                  <span class="ov-library-item-name">${lib.global ? '<i class="fas fa-globe" title="' + t('origin-vault.dialog.selector.globalBadge') + '" style="margin-right: 4px; opacity: 0.7;"></i>' : ''}${lib.name}</span>
                  <span class="ov-library-item-count">${tf('origin-vault.ui.itemsCount', { count: lib.itemCount || 0 })}</span>
                </div>
                ${isActive ? '<i class="fas fa-check"></i>' : ''}
              </div>
            `;
            }).join('')}
          </div>
          <div class="ov-library-actions">
            <!-- Store temporarily disabled
            <button class="ov-library-action-btn" data-action="open-store">
              <i class="fas fa-shopping-bag"></i> ${t('origin-vault.store.title')}
            </button>
            -->
            <button class="ov-library-action-btn" data-action="create-library">
              <i class="fas fa-plus"></i> ${t('origin-vault.dialog.selector.create')}
            </button>
            <button class="ov-library-action-btn" data-action="manage-libraries">
              <i class="fas fa-cog"></i> ${t('origin-vault.dialog.selector.manage')}
            </button>
          </div>
        </div>
      </div>
    `;

    this.container.innerHTML = html;
    this._attachListeners();
  }

  /**
   * 添加事件监听
   */
  _attachListeners() {
    this.container.removeEventListener('click', this._boundHandleClick);
    this.container.addEventListener('click', this._boundHandleClick);
  }

  /**
   * 移除事件监听
   */
  destroy() {
    this.container.removeEventListener('click', this._boundHandleClick);
    document.removeEventListener('click', this._boundHandleOutsideClick);
  }

  /**
   * 处理点击事件
   */
  async _handleClick(event) {
    const target = event.target.closest('[data-action]');
    if (!target) return;

    const action = target.dataset.action;

    switch (action) {
      case 'toggle-dropdown':
        this._toggleDropdown();
        break;

      case 'switch-library':
        const libraryId = target.dataset.libraryId;
        const libraryPath = target.dataset.libraryPath || '';
        await this._switchLibrary(libraryId, libraryPath);
        break;

      case 'create-library':
        this._hideDropdown();
        this._showCreateDialog();
        break;

      case 'manage-libraries':
        this._hideDropdown();
        this._showManageDialog();
        break;

      // case 'open-store':
      //   this._hideDropdown();
      //   new StoreApp().render(true);
      //   break;
    }
  }

  /**
   * 切换下拉菜单
   */
  _toggleDropdown() {
    const dropdown = this.container.querySelector('.ov-library-dropdown');
    const chevron = this.container.querySelector('.ov-library-chevron');

    if (dropdown.classList.contains('hidden')) {
      dropdown.classList.remove('hidden');
      chevron.classList.add('rotated');
      // 添加外部点击监听
      setTimeout(() => {
        document.addEventListener('click', this._boundHandleOutsideClick);
      }, 0);
    } else {
      this._hideDropdown();
    }
  }

  /**
   * 隐藏下拉菜单
   */
  _hideDropdown() {
    const dropdown = this.container.querySelector('.ov-library-dropdown');
    const chevron = this.container.querySelector('.ov-library-chevron');

    dropdown?.classList.add('hidden');
    chevron?.classList.remove('rotated');
    document.removeEventListener('click', this._boundHandleOutsideClick);
  }

  /**
   * 处理外部点击
   */
  _handleOutsideClick(event) {
    if (!this.container.contains(event.target)) {
      this._hideDropdown();
    }
  }

  /**
   * 切换资源库
   */
  async _switchLibrary(libraryId, libraryPath = '') {
    const currentLibrary = this.libraryManager.getActiveLibrary();
    if (libraryId === currentLibrary?.id && libraryPath === currentLibrary?.path) {
      this._hideDropdown();
      return;
    }

    await this.libraryManager.switchLibrary(libraryId, { path: libraryPath });
    this._hideDropdown();
    await this.render(); // 重新渲染
  }



  /**
   * 显示创建资源库对话框
   */
  _showCreateDialog() {
    const overlay = document.createElement('div');
    overlay.className = 'ov-dialog-overlay';

    const content = `
      <div class="ov-dialog ov-create-dialog">
        <div class="ov-dialog-header">
          <h3>${t('origin-vault.dialog.selector.create')}</h3>
          <button class="ov-dialog-close"><i class="fas fa-times"></i></button>
        </div>
        <div class="ov-dialog-content">
          <form class="ov-create-library-form">
            <div class="form-group">
              <label>${t('origin-vault.dialog.firstTime.libraryName')}</label>
              <input type="text" name="name" placeholder="${t('origin-vault.dialog.firstTime.libraryNamePlaceholder')}" required autocomplete="off" />
            </div>
            <div class="form-group">
              <label>${t('origin-vault.dialog.firstTime.libraryIdSlug')}</label>
              <input type="text" name="slug" placeholder="${t('origin-vault.dialog.firstTime.libraryIdSlugPlaceholder')}" required pattern="[a-z0-9]+" autocomplete="off" />
              <p class="notes" style="font-size: 12px; color: var(--ov-text-secondary); margin-top: 4px;">${t('origin-vault.dialog.firstTime.libraryIdSlugNote')}</p>
              <div class="ov-slug-status" style="margin-top: 4px; font-size: 12px; min-height: 18px;"></div>
            </div>
            <div class="form-group">
              <label>${t('origin-vault.dialog.firstTime.colorLabel')}</label>
              <div class="color-picker-wrapper">
                <input type="color" name="color" value="#5b9bd5" />
                <span class="color-preview"></span>
              </div>
            </div>
            <div class="form-group">
              <label>${t('origin-vault.dialog.selector.description')}</label>
              <textarea name="description" rows="3" placeholder="${t('origin-vault.dialog.selector.descriptionPlaceholder')}"></textarea>
            </div>
            <div class="form-group">
              <label class="ov-checkbox-label" style="display: flex; align-items: center; gap: 6px; cursor: pointer;">
                <input type="checkbox" name="global" style="margin: 0;" />
                <i class="fas fa-globe" style="opacity: 0.7;"></i>
                <span>${t('origin-vault.dialog.firstTime.globalLabel')}</span>
              </label>
              <p class="notes" style="font-size: 12px; color: var(--ov-text-secondary); margin-top: 4px;">${t('origin-vault.dialog.firstTime.globalHint')}</p>
            </div>
          </form>
        </div>
        <div class="ov-dialog-footer">
          <button class="ov-btn ov-btn-secondary" data-action="cancel">
            <i class="fas fa-times"></i> ${t('origin-vault.dialog.cancel')}
          </button>
          <button class="ov-btn ov-btn-primary" data-action="create">
            <i class="fas fa-check"></i> ${t('origin-vault.dialog.confirm')}
          </button>
        </div>
      </div>
    `;

    overlay.innerHTML = content;
    appendToOverlayHost(overlay, { ownerElement: this.container });

    // Bind Events
    const close = () => {
      overlay.remove();
    };

    overlay.querySelector('.ov-dialog-close').addEventListener('click', close);
    overlay.querySelector('[data-action="cancel"]').addEventListener('click', close);

    // Color picker preview update
    const colorInput = overlay.querySelector('input[name="color"]');
    const colorPreview = overlay.querySelector('.color-preview');
    if (colorInput && colorPreview) {
      const updateColor = () => { colorPreview.style.backgroundColor = colorInput.value; };
      colorInput.addEventListener('input', updateColor);
      updateColor();
    }

    const slugInput = overlay.querySelector('input[name="slug"]');
    const slugStatus = overlay.querySelector('.ov-slug-status');
    if (slugInput && slugStatus) {
      slugInput.addEventListener('input', () => {
        const val = slugInput.value.trim();
        if (!val) {
          slugStatus.innerHTML = '';
          return;
        }
        if (!/^[a-z0-9]+$/.test(val)) {
          slugStatus.innerHTML = `<span style="color: #e74c3c;"><i class="fas fa-times-circle"></i> ${t('origin-vault.dialog.firstTime.slugInvalid')}</span>`;
          return;
        }
        const id = `lib_${val}`;
        // 注册表检查（同步）
        if (this.libraryManager.getLibrary(id)) {
          slugStatus.innerHTML = `<span style="color: #e74c3c;"><i class="fas fa-times-circle"></i> ${t('origin-vault.dialog.firstTime.slugTaken')}</span>`;
          return;
        }
        // 跨版本注册表检查（正式版 origin-vault 的 settings）
        try {
          const otherModuleId = MODULE_ID.includes('mad') ? 'origin-vault' : 'origin-vault-mad';
          const otherRegistry = game.settings.get(otherModuleId, 'registry');
          if (otherRegistry?.libraries?.[id]) {
            slugStatus.innerHTML = `<span style="color: #e74c3c;"><i class="fas fa-times-circle"></i> ${t('origin-vault.dialog.firstTime.slugTaken')}</span>`;
            return;
          }
        } catch(e) { /* 对方模块未安装或未注册 settings */ }
        // 这里别再碰文件系统了，Forge 上 browse/exists 很容易把人坑死
        slugStatus.innerHTML = `<span style="color: #2ecc71;"><i class="fas fa-check-circle"></i> ${t('origin-vault.dialog.firstTime.slugAvailable')}</span>`;
      });
    }

    // Create action
    overlay.querySelector('[data-action="create"]').addEventListener('click', async () => {
      const form = overlay.querySelector('form');
      const name = form.querySelector('[name="name"]').value.trim();
      const slug = form.querySelector('[name="slug"]').value.trim();
      const color = form.querySelector('[name="color"]').value;
      const description = form.querySelector('[name="description"]').value.trim();

      if (!name) {
        ui.notifications.warn(t('origin-vault.notifications.enterFolderName'));
        return;
      }
      if (!slug) {
        ui.notifications.warn(t('origin-vault.errors.invalidLibraryId'));
        return;
      }

      try {
        const libraryId = await this.libraryManager.createLibrary(name, slug, {
          color,
          description,
          global: form.querySelector('[name="global"]').checked
        });
        if (libraryId) {
          await this.libraryManager.switchLibrary(libraryId);
          await this.render();
          close();
        }
      } catch (e) {
        ui.notifications.error(e.message);
      }
    });

    // Close on outside click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
  }


  _showManageDialog() {
    const allLibraries = this.libraryManager.getAllLibraries();
    const overlay = document.createElement('div');
    overlay.className = 'ov-dialog-overlay';

    const content = `
      <div class="ov-dialog ov-manage-dialog" style="width: 450px;">
        <div class="ov-dialog-header">
          <h3>${t('origin-vault.dialog.selector.manage')}</h3>
          <button class="ov-dialog-close"><i class="fas fa-times"></i></button>
        </div>
        <div class="ov-dialog-content ov-manage-libraries">
          <p class="ov-dialog-intro">
            ${t('origin-vault.dialog.selector.intro')}
          </p>
          <div class="ov-library-manage-list">
            ${allLibraries.map(lib => `
              <div class="ov-library-manage-item" data-id="${lib.id}">
                <div class="ov-library-color-dot" style="background-color: ${lib.color}"></div>
                <div class="ov-library-manage-info">
                    <span class="ov-library-manage-name" title="${lib.name}">${lib.global ? '<i class="fas fa-globe" title="' + t('origin-vault.dialog.selector.globalBadge') + '" style="margin-right: 4px; opacity: 0.7;"></i>' : ''}${lib.name}</span>
                    <span class="ov-library-manage-path" title="${lib.path}">${lib.path}</span>
                </div>
                <span class="ov-library-manage-count">${tf('origin-vault.ui.itemsCount', { count: lib.itemCount || 0 })}</span>
                <button class="ov-library-rename-btn" data-id="${lib.id}" data-path="${lib.path}" title="${t('origin-vault.ui.rename')}">
                  <i class="fas fa-pencil-alt"></i>
                </button>
                ${allLibraries.length > 1 ? `
                  <button class="ov-library-delete-btn" data-id="${lib.id}" data-path="${lib.path}" title="${t('origin-vault.folders.delete')}">
                    <i class="fas fa-trash"></i>
                  </button>
                ` : '<div class="ov-library-manage-spacer"></div>'}
              </div>
            `).join('')}
          </div>
        </div>
        <div class="ov-dialog-footer">
          <button class="ov-btn ov-btn-primary" data-action="close">
            <i class="fas fa-times"></i> ${t('origin-vault.toolbar.close')}
          </button>
        </div>
      </div>
    `;

    overlay.innerHTML = content;
    appendToOverlayHost(overlay, { ownerElement: this.container });

    const close = () => overlay.remove();

    // Bind Close
    overlay.querySelector('.ov-dialog-close').addEventListener('click', close);
    overlay.querySelector('[data-action="close"]').addEventListener('click', close);

    // Bind Rename
    overlay.querySelectorAll('.ov-library-rename-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const path = btn.dataset.path || '';
        const lib = this.libraryManager.getLibrary(id, { path });
        if (!lib) return;

        const newName = await this._promptLibraryRename(lib);
        if (newName && newName.trim() && newName.trim() !== lib.name) {
          await this.libraryManager.renameLibrary(id, newName.trim(), { path });
          await this.render();
          close();
          this._showManageDialog(); // Re-open to refresh list
        }
      });
    });

    // Bind Delete
    overlay.querySelectorAll('.ov-library-delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const id = btn.dataset.id;
        const path = btn.dataset.path || '';
        const lib = this.libraryManager.getLibrary(id, { path });

        const confirmed = await this._confirmDelete(lib);
        if (confirmed) {
          await this.libraryManager.deleteLibrary(id, { path });
          await this.render();
          close();
          this._showManageDialog(); // Re-open to refresh list
        }
      });
    });

    // Close on outside click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });
  }

  /**
   * Rename library dialog helper.
   */
  _promptLibraryRename(lib) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'ov-dialog-overlay';
      overlay.style.zIndex = String(OV_LAYERS.NESTED_DIALOG);

      overlay.innerHTML = `
        <div class="ov-dialog ov-rename-dialog" style="width: 420px;">
          <div class="ov-dialog-header">
            <h3>${t('origin-vault.ui.rename')}</h3>
            <button class="ov-dialog-close"><i class="fas fa-times"></i></button>
          </div>
          <div class="ov-dialog-content">
            <div class="form-group">
              <label for="ov-library-rename-input">${t('origin-vault.folders.rename')}</label>
              <input id="ov-library-rename-input" type="text" name="library-name" class="ov-input" autocomplete="off" spellcheck="false">
            </div>
          </div>
          <div class="ov-dialog-footer">
            <button class="ov-btn ov-btn-secondary" data-action="cancel">
              <i class="fas fa-times"></i> ${t('origin-vault.dialog.cancel')}
            </button>
            <button class="ov-btn ov-btn-primary" data-action="confirm">
              <i class="fas fa-check"></i> ${t('origin-vault.dialog.confirm')}
            </button>
          </div>
        </div>
      `;

      appendToOverlayHost(overlay, { ownerElement: this.container });

      const input = overlay.querySelector('input[name="library-name"]');
      input.value = lib.name || '';

      const close = (result) => {
        overlay.remove();
        resolve(result);
      };

      const submit = () => {
        const value = input.value.trim();
        if (!value) {
          ui.notifications.warn(t('origin-vault.notifications.enterFolderName'));
          input.focus();
          return;
        }
        close(value);
      };

      overlay.querySelector('.ov-dialog-close').addEventListener('click', () => close(null));
      overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => close(null));
      overlay.querySelector('[data-action="confirm"]').addEventListener('click', submit);
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close(null);
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          submit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          close(null);
        }
      });

      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    });
  }

  /**
   * Confirm delete dialog helper.
   */
  _confirmDelete(lib) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'ov-dialog-overlay';
      overlay.style.zIndex = String(OV_LAYERS.NESTED_DIALOG);

      overlay.innerHTML = `
        <div class="ov-dialog ov-confirm-dialog">
          <div class="ov-dialog-header">
            <h3>${t('origin-vault.dialog.selector.confirmDelete')}</h3>
            <button class="ov-dialog-close"><i class="fas fa-times"></i></button>
          </div>
          <div class="ov-dialog-content">
            <p style="margin-bottom: 10px;">${tf('origin-vault.dialog.selector.confirmDeleteText', { name: lib.name })}</p>
            <p class="notes" style="color: var(--ov-text-secondary); font-size: 13px;">
              <i class="fas fa-info-circle"></i> ${t('origin-vault.dialog.selector.confirmDeleteNote')}
            </p>
          </div>
          <div class="ov-dialog-footer">
            <button class="ov-btn ov-btn-secondary" data-action="cancel">
              <i class="fas fa-times"></i> ${t('origin-vault.dialog.cancel')}
            </button>
            <button class="ov-btn ov-btn-danger" data-action="confirm">
              <i class="fas fa-trash"></i> ${t('origin-vault.folders.delete')}
            </button>
          </div>
        </div>
      `;

      appendToOverlayHost(overlay, { ownerElement: this.container });

      const close = (result) => {
        overlay.remove();
        resolve(result);
      };

      overlay.querySelector('.ov-dialog-close').addEventListener('click', () => close(false));
      overlay.querySelector('[data-action="cancel"]').addEventListener('click', () => close(false));
      overlay.querySelector('[data-action="confirm"]').addEventListener('click', () => close(true));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
    });
  }
}
