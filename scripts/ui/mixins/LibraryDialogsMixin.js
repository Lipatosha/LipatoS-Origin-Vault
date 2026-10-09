/**
 * LibraryDialogsMixin - 资源库管理对话框
 * 从 MainWindow 提取的资源库管理、切换、新建、首次引导等方法
 * 
 * 包含：资源库管理器弹窗、切换/新建库、添加到文件夹、首次设置、重命名
 * 混入后通过 this 访问 MainWindow 实例状态
 */

import { MODULE_ID, SPECIAL_FOLDERS } from '../../constants.js';
import { LibrarySelector } from '../LibrarySelector.js';
import { LibraryManager } from '../../data/LibraryManager.js';
import { createFilePickerApp, createFilePickerDirectory } from '../../utils/filePicker.js';
import { t, tf } from '../../utils/i18n.js';
import { appendJQueryToOverlayHost } from '../../utils/overlayHost.js';

/**
 * 将方法混入目标类
 * @param {Function} cls - 目标类 (MainWindow)
 */
export function applyLibraryDialogsMixin(cls) {
  /**
   * 打开资源库管理器 (OV Custom Dialog)
   */
  cls.prototype._onLibraryManagerClick = function() {
    const overlay = $(`
        <div class="ov-dialog-overlay">
          <div class="ov-dialog" style="width: 420px;">
            <div class="ov-dialog-header">
              <h3 class="ov-dialog-title">${t('origin-vault.dialog.selector.title')}</h3>
              <button class="ov-dialog-close"><i class="fas fa-times"></i></button>
            </div>
            <div class="ov-dialog-content" style="padding: 16px;">
              <p style="margin: 0 0 8px 0; color: #ccc;">${tf('origin-vault.dialog.selector.current', { path: this.library.basePath })}</p>
              <hr style="border: 0; border-top: 1px solid #3e3e42; margin: 12px 0;">
              <p style="margin: 0; color: #aaa; font-size: 13px;">${t('origin-vault.dialog.selector.switchDesc')}</p>
            </div>
            <div class="ov-dialog-footer">
              <button class="ov-dialog-btn primary switch-btn"><i class="fas fa-folder-open"></i> ${t('origin-vault.dialog.selector.switch')}</button>
              <button class="ov-dialog-btn create-btn"><i class="fas fa-plus"></i> ${t('origin-vault.dialog.selector.create')}</button>
              <button class="ov-dialog-btn cancel-btn"><i class="fas fa-times"></i> ${t('origin-vault.dialog.cancel')}</button>
            </div>
          </div>
        </div>
      `);

    const close = () => overlay.remove();

    overlay.find('.ov-dialog-close, .cancel-btn').on('click', close);
    overlay.find('.switch-btn').on('click', () => { close(); this._onSwitchLibrary(); });
    overlay.find('.create-btn').on('click', () => { close(); this._onCreateLibrary(); });
    overlay.on('click', (e) => { if (e.target === overlay[0]) close(); });

    appendJQueryToOverlayHost(overlay, { owner: this });
  };

  /**
   * 切换资源库
   */
  cls.prototype._onSwitchLibrary = async function() {
    createFilePickerApp({
      type: "folder",
      current: this.library.basePath,
      callback: async (path) => {
        // 更新设置
        await game.settings.set(MODULE_ID, 'currentLibraryPath', path);

        // 重新加载库
        this.library.setLibraryPath(path);
        const success = await this.library.load();

        if (success) {
          ui.notifications.info(tf('origin-vault.notifications.switchedLibrary', { path }));
          this.render(false);
        } else {
          ui.notifications.warn(t('origin-vault.notifications.initNewLibrary'));
          this.render(false);
        }
      }
    }).render(true);
  };

  /**
   * 新建资源库 (OV Custom Dialog)
   */
  cls.prototype._onCreateLibrary = function() {
    const overlay = $(`
        <div class="ov-dialog-overlay">
          <div class="ov-dialog" style="width: 450px;">
            <div class="ov-dialog-header">
              <h3 class="ov-dialog-title">${t('origin-vault.dialog.selector.create')}</h3>
              <button class="ov-dialog-close"><i class="fas fa-times"></i></button>
            </div>
            <div class="ov-dialog-content" style="padding: 16px;">
              <div style="margin-bottom: 14px;">
                <label style="display: block; margin-bottom: 6px; color: #ccc; font-size: 13px;">${t('origin-vault.dialog.firstTime.libraryName')}</label>
                <input type="text" name="libraryName" placeholder="${t('origin-vault.dialog.firstTime.libraryNamePlaceholder')}"
                  style="width: 100%; box-sizing: border-box; padding: 8px 12px; background: #1e1e1e; border: 1px solid #3e3e42; border-radius: 6px; color: #eee; font-size: 14px;" />
              </div>
              <div style="margin-bottom: 14px;">
                <label style="display: block; margin-bottom: 6px; color: #ccc; font-size: 13px;">Library ID</label>
                <input type="text" name="libraryId" placeholder="e.g., campaign1"
                  style="width: 100%; box-sizing: border-box; padding: 8px 12px; background: #1e1e1e; border: 1px solid #3e3e42; border-radius: 6px; color: #eee; font-size: 14px;" />
                <p style="margin: 4px 0 0; font-size: 11px; color: #888;">Folder: origin-vault/lib_{id}. Lowercase letters & numbers only.</p>
              </div>
              <div style="margin-bottom: 14px;">
                <label style="display: block; margin-bottom: 6px; color: #ccc; font-size: 13px;">${t('origin-vault.dialog.firstTime.colorLabel')}</label>
                <input type="color" name="libraryColor" value="#5b9bd5"
                  style="width: 40px; height: 40px; padding: 2px; background: #1e1e1e; border: 1px solid #3e3e42; border-radius: 6px; cursor: pointer;" />
              </div>
              <div style="margin-bottom: 0;">
                <label style="display: block; margin-bottom: 6px; color: #ccc; font-size: 13px;">${t('origin-vault.dialog.selector.description')}</label>
                <textarea name="libraryDesc" rows="3" placeholder="${t('origin-vault.dialog.selector.descriptionPlaceholder')}"
                  style="width: 100%; box-sizing: border-box; padding: 8px 12px; background: #1e1e1e; border: 1px solid #3e3e42; border-radius: 6px; color: #eee; font-size: 13px; resize: vertical;"></textarea>
              </div>
            </div>
            <div class="ov-dialog-footer">
              <button class="ov-dialog-btn primary confirm-btn"><i class="fas fa-check"></i> ${t('origin-vault.dialog.confirm')}</button>
              <button class="ov-dialog-btn cancel-btn"><i class="fas fa-times"></i> ${t('origin-vault.dialog.cancel')}</button>
            </div>
          </div>
        </div>
      `);

    const close = () => overlay.remove();

    overlay.find('.ov-dialog-close, .cancel-btn').on('click', close);
    overlay.on('click', (e) => { if (e.target === overlay[0]) close(); });

    overlay.find('.confirm-btn').on('click', async () => {
      const name = overlay.find('input[name="libraryName"]').val().trim();
      const id = overlay.find('input[name="libraryId"]').val().trim();
      if (!name) {
        ui.notifications.error(t('origin-vault.notifications.enterFolderName'));
        return;
      }

      const folderName = id ? `lib_${id}` : name.toLowerCase().replace(/[^a-z0-9]/g, '_');
      close();

      // 选择父目录
      createFilePickerApp({
        type: "folder",
        current: this.library.basePath,
        callback: async (parentPath) => {
          const newPath = `${parentPath}/${folderName}`;

          try {
            await createFilePickerDirectory('data', newPath);
            await game.settings.set(MODULE_ID, 'currentLibraryPath', newPath);
            this.library.setLibraryPath(newPath);
            await this.library.load();

            ui.notifications.info(tf('origin-vault.notifications.libraryCreated', { path: newPath }));
            this.render(false);
          } catch (err) {
            console.error(err);
            ui.notifications.error(tf('origin-vault.notifications.libraryCreateFailed', { message: err.message }));
          }
        }
      }).render(true);
    });

    appendJQueryToOverlayHost(overlay, { owner: this });
    overlay.find('input[name="libraryName"]').focus();
  };

  /**
   * 显示首次使用引导 (OV Custom Dialog)
   */
  cls.prototype._showFirstTimeSetup = function() {
    this._firstTimeSetupShown = true;
    const overlay = $(`
      <div class="ov-dialog-overlay">
        <div class="ov-dialog" style="width: 460px;">
          <div class="ov-dialog-header">
            <h3 class="ov-dialog-title">${t('origin-vault.dialog.firstTime.title')}</h3>
            <button class="ov-dialog-close"><i class="fas fa-times"></i></button>
          </div>
          <div class="ov-dialog-content" style="padding: 20px;">
            <h2 style="margin: 0 0 12px; font-size: 18px; color: #eee;"><i class="fas fa-info-circle" style="color: var(--ov-accent, #5b9bd5);"></i> ${t('origin-vault.dialog.firstTime.welcome')}</h2>
            <p style="margin: 0 0 16px; color: #aaa; line-height: 1.5;">${t('origin-vault.dialog.firstTime.desc')}</p>
            <div style="margin-bottom: 14px;">
              <label style="display: block; margin-bottom: 6px; color: #ccc; font-size: 13px;">${t('origin-vault.dialog.firstTime.libraryName')}</label>
              <input type="text" name="name" placeholder="${t('origin-vault.dialog.firstTime.libraryNamePlaceholder')}" value="${t('origin-vault.dialog.firstTime.defaultLibraryName')}" required autocomplete="off"
                style="width: 100%; box-sizing: border-box; padding: 8px 12px; background: #1e1e1e; border: 1px solid #3e3e42; border-radius: 6px; color: #eee; font-size: 14px;" />
            </div>
            <div style="margin-bottom: 14px;">
              <label style="display: block; margin-bottom: 6px; color: #ccc; font-size: 13px;">${t('origin-vault.dialog.firstTime.libraryIdSlug')}</label>
              <input type="text" name="slug" placeholder="${t('origin-vault.dialog.firstTime.libraryIdSlugPlaceholder')}" required pattern="[a-z0-9]+" autocomplete="off"
                style="width: 100%; box-sizing: border-box; padding: 8px 12px; background: #1e1e1e; border: 1px solid #3e3e42; border-radius: 6px; color: #eee; font-size: 14px;" />
              <p style="font-size: 12px; color: #888; margin: 4px 0 0;">${t('origin-vault.dialog.firstTime.libraryIdSlugNote')}</p>
            </div>
            <div style="margin-bottom: 14px;">
              <label style="display: block; margin-bottom: 6px; color: #ccc; font-size: 13px;">${t('origin-vault.dialog.firstTime.colorLabel')}</label>
              <input type="color" name="color" value="#5b9bd5"
                style="width: 40px; height: 40px; padding: 2px; background: #1e1e1e; border: 1px solid #3e3e42; border-radius: 6px; cursor: pointer;" />
            </div>
            <div style="margin-bottom: 0;">
              <label style="display: inline-flex; align-items: center; gap: 8px; color: #ccc; font-size: 13px; cursor: pointer;">
                <input type="checkbox" name="global" style="margin: 0;" />
                <i class="fas fa-globe" style="opacity: 0.7;"></i>
                <span>${t('origin-vault.dialog.firstTime.globalLabel')}</span>
              </label>
              <p style="font-size: 12px; color: #888; margin: 6px 0 0;">${t('origin-vault.dialog.firstTime.globalHint')}</p>
            </div>
          </div>
          <div class="ov-dialog-footer">
            <button class="ov-dialog-btn primary create-btn"><i class="fas fa-plus"></i> ${t('origin-vault.dialog.firstTime.createLibrary')}</button>
          </div>
        </div>
      </div>
    `);

    const close = () => {
      overlay.remove();
      // 如果用户关闭对话框但没有创建资源库，隐藏主窗口
      const libraryManager = LibraryManager.getInstance();
      if (!libraryManager.hasAnyLibrary()) {
        this.constructor.hide();
        ui.notifications.warn(t('origin-vault.notifications.needLibrary'));
      }
    };

    overlay.find('.ov-dialog-close').on('click', close);
    overlay.on('click', (e) => { if (e.target === overlay[0]) close(); });

    overlay.find('.create-btn').on('click', async () => {
      const name = overlay.find('input[name="name"]').val().trim() || t('origin-vault.dialog.firstTime.defaultLibraryName');
      const slug = overlay.find('input[name="slug"]').val().trim();
      const color = overlay.find('input[name="color"]').val();
      const isGlobal = overlay.find('input[name="global"]').is(':checked');

      if (!slug || !/^[a-z0-9]+$/.test(slug)) {
        ui.notifications.warn(t('origin-vault.errors.invalidLibraryId'));
        return;
      }

      try {
        const libraryManager = LibraryManager.getInstance();
        const libraryId = await libraryManager.createLibrary(name, slug, { color, global: isGlobal });
        if (libraryId) {
          await libraryManager.switchLibrary(libraryId);
          const newLibrary = libraryManager.getLibrary(libraryId);
          if (newLibrary) {
            this.library.setLibraryPath(newLibrary.path);
          }
          await this.library.load();
          overlay.remove();
          this.render(true);
        }
      } catch (err) {
        console.error(`${MODULE_ID} | First-time library creation failed:`, err);
        ui.notifications.error(err.message);
      }
    });

    appendJQueryToOverlayHost(overlay, { owner: this });
    overlay.find('input[name="name"]').focus();
  };

  /**
   * 添加素材到文件夹 (Eagle 风格多选对话框) - OV Custom Dialog
   */
  cls.prototype._onAddToFolder = async function(itemId) {
    const item = this.library.getItem(itemId);
    if (!item) return;

    const folders = this.library.getAllFolders();
    const existingFolders = new Set(item.folders || []);

    // 递归构建可折叠的文件夹树 HTML
    const buildFolderTree = (parentId, depth = 0) => {
      let html = '';
      const parent = folders[parentId];
      if (!parent) return '';

      const children = parent.children || [];

      for (const childId of children) {
        const child = folders[childId];
        if (!child) continue;

        const hasChildren = (child.children || []).length > 0;
        const isSelected = existingFolders.has(childId);
        const isDisabled = isSelected ? 'disabled' : '';
        const checked = isSelected ? 'checked' : '';
        const indent = depth * 16;
        const folderColor = child.color || '#FFD700';

        html += `
          <div class="ov-folder-picker-item" data-folder-id="${childId}" data-depth="${depth}">
            <div class="ov-folder-picker-row" style="padding-left: ${indent}px;">
              ${hasChildren ? `
                <span class="ov-folder-toggle expanded" data-folder-id="${childId}">
                  <i class="fas fa-chevron-down"></i>
                </span>
              ` : `<span class="ov-folder-toggle-placeholder"></span>`}
              <input type="checkbox" class="ov-folder-checkbox" id="picker_${childId}" 
                     name="folders" value="${childId}" ${isDisabled} ${checked}>
              <label for="picker_${childId}" class="ov-folder-label">
                <i class="fas fa-folder" style="color: ${folderColor};"></i>
                <span class="ov-folder-name">${child.name}</span>
              </label>
            </div>
            ${hasChildren ? `
              <div class="ov-folder-children" data-parent="${childId}" style="display: block;">
                ${buildFolderTree(childId, depth + 1)}
              </div>
            ` : ''}
          </div>
          `;
      }
      return html;
    };

    const overlay = $(`
        <div class="ov-dialog-overlay">
          <div class="ov-dialog" style="width: 400px;">
            <div class="ov-dialog-header">
              <h3 class="ov-dialog-title">${t('origin-vault.ui.addToFolderCopy')}</h3>
              <button class="ov-dialog-close"><i class="fas fa-times"></i></button>
            </div>
            <div class="ov-dialog-content" style="padding: 12px;">
              <p style="margin: 0 0 10px; color: #aaa; font-size: 13px;">${t('origin-vault.ui.selectFolderHint')}</p>
              <div class="ov-folder-picker-tree">
                ${buildFolderTree(SPECIAL_FOLDERS.ROOT)}
              </div>
            </div>
            <div class="ov-dialog-footer">
              <button class="ov-dialog-btn primary confirm-btn"><i class="fas fa-check"></i> ${t('origin-vault.dialog.confirm')}</button>
              <button class="ov-dialog-btn cancel-btn"><i class="fas fa-times"></i> ${t('origin-vault.dialog.cancel')}</button>
            </div>
          </div>
        </div>
      `);

    const close = () => overlay.remove();

    overlay.find('.ov-dialog-close, .cancel-btn').on('click', close);
    overlay.on('click', (e) => { if (e.target === overlay[0]) close(); });

    // 绑定折叠/展开事件
    overlay.find('.ov-folder-toggle').on('click', (event) => {
      event.stopPropagation();
      const toggle = $(event.currentTarget);
      const fid = toggle.data('folder-id');
      const childrenDiv = overlay.find(`.ov-folder-children[data-parent="${fid}"]`);
      const icon = toggle.find('i');

      if (childrenDiv.is(':visible')) {
        childrenDiv.slideUp(150);
        icon.removeClass('fa-chevron-down').addClass('fa-chevron-right');
      } else {
        childrenDiv.slideDown(150);
        icon.removeClass('fa-chevron-right').addClass('fa-chevron-down');
      }
    });

    overlay.find('.confirm-btn').on('click', async () => {
      const selectedIds = [];
      overlay.find('input[name="folders"]:checked:not(:disabled)').each((i, el) => {
        selectedIds.push(el.value);
      });

      if (selectedIds.length > 0) {
        // 对所有选中项批量添加到文件夹
        const itemIds = this.selectedItems.size > 1 ? [...this.selectedItems] : [itemId];
        for (const iid of itemIds) {
          for (const fid of selectedIds) {
            await this.library.copyItemToFolder(iid, fid);
          }
        }
        ui.notifications.info(tf('origin-vault.notifications.addedToFolders', { count: selectedIds.length }));
        this._renderDetailsPanel();
        this._renderSidebar();
      }
      close();
    });

    appendJQueryToOverlayHost(overlay, { owner: this });
  };

  /**
   * 重命名素材
   */
  cls.prototype._onItemRename = async function(itemId) {
    const item = this.library.getItem(itemId);
    if (!item) return;

    const oldName = item.displayName || item.name;
    const newName = await this._showInputDialog(
      t('origin-vault.ui.rename'),
      t('origin-vault.ui.itemName'),
      oldName
    );

    if (newName && newName !== oldName) {
      await this.library.updateItem(itemId, { displayName: newName });

      // 更新 DOM 文本，避免全量刷新
      const card = $(this.element).find(`.asset-card[data-item-id="${itemId}"]`);
      if (card.length) {
        card.find('.asset-name').text(newName);
        card.find('.asset-name').attr('title', newName);
      }
      this._renderDetailsPanel();
    }
  };
}
