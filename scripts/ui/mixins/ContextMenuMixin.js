import { ovText } from '../../utils/locale.js';
// 未来的我：别再用 jQuery ($) 了！所有 DOM 操作用原生 API
// 现有的 $() 调用是历史债务，重构时逐步干掉
/**
 * ContextMenuMixin - 右键菜单系统
 * 从 MainWindow 提取的右键菜单相关方法
 * 
 * 包含：文件夹右键菜单（Eagle 风格增强版）、素材右键菜单
 * 混入后通过 this 访问 MainWindow 实例状态
 */

import { MODULE_ID, SPECIAL_FOLDERS, FILE_TYPES, OV_LAYERS } from '../../constants.js';
import { t, tf } from '../../utils/i18n.js';
import { appendJQueryToOverlayHost, getOverlayHostRect } from '../../utils/overlayHost.js';

/**
 * 将右键菜单方法混入目标类
 * @param {Function} cls - 目标类 (MainWindow)
 */
export function applyContextMenuMixin(cls) {

    /**
     * 文件夹右键入口
     */
    cls.prototype._onFolderContextMenu = function (event, folderId) {
        console.warn(`${MODULE_ID} | _onFolderContextMenu CALLED: folderId=${folderId}`);
        const folder = this.library.getFolder(folderId);
        if (!folder) return;

        const isRoot = folderId === SPECIAL_FOLDERS.ROOT;

        // Eagle 风格增强右键菜单
        this._showEnhancedContextMenu(event, folderId, folder, isRoot);
    };

    /**
     * 显示增强版右键菜单 (Eagle 风格)
     */
    cls.prototype._showEnhancedContextMenu = function (event, folderId, folder, isRoot) {
        $('.ov-context-menu').remove();

        const colors = [
            '#607D8B', '#F44336', '#E91E63', '#FF9800',
            '#FFEB3B', '#4CAF50', '#00BCD4', '#2196F3',
            '#9C27B0', '#FF4081'
        ];

        const menu = $(`<div class="ov-context-menu"></div>`);

        // 新建子文件夹
        const addItem = $(`
        <div class="ov-context-menu-item">
          <i class="fas fa-folder-plus"></i>
          <span>${t('origin-vault.folders.newSub')}</span>
        </div>
      `);
        addItem.on('click', () => {
            menu.remove();
            this._onCreateSubfolderInline(folderId);
        });
        menu.append(addItem);

        if (!isRoot) {
            // 重命名
            const renameItem = $(`
          <div class="ov-context-menu-item">
            <i class="fas fa-edit"></i>
            <span>${t('origin-vault.folders.rename')}</span>
          </div>
        `);
            renameItem.on('click', () => {
                menu.remove();
                this._startInlineRename(folderId);
            });
            menu.append(renameItem);

            // 分隔线
            menu.append('<div class="ov-context-menu-divider"></div>');

            // 展开/收起
            const toggleItem = $(`
          <div class="ov-context-menu-item">
            <i class="fas ${folder.collapsed ? 'fa-chevron-down' : 'fa-chevron-up'}"></i>
            <span>${folder.collapsed ? t('origin-vault.ui.expandFolder') : t('origin-vault.ui.collapseFolder')}</span>
          </div>
        `);
            toggleItem.on('click', () => {
                menu.remove();
                this._onFolderToggle(folderId);
            });
            menu.append(toggleItem);

            // 分隔线
            menu.append('<div class="ov-context-menu-divider"></div>');

            // 颜色选择器标题
            menu.append(`
          <div class="ov-context-menu-item" style="cursor: default; opacity: 0.7;">
            <i class="fas fa-palette"></i>
            <span>${t('origin-vault.folders.folderColor')}</span>
          </div>
        `);

            // 颜色选择器
            const colorContainer = $('<div class="ov-context-menu-colors"></div>');
            for (const color of colors) {
                const dot = $(`<div class="ov-color-dot ${folder.color === color ? 'active' : ''}" style="background-color: ${color};"></div>`);
                dot.on('click', () => {
                    folder.color = color;
                    this.library._markDirty();
                    menu.remove();
                    this._renderSidebar();

                    // Hot-swap: Immediately update folder icon in main grid (subfolders-row)
                    // without full re-render to avoid losing scroll position
                    const gridFolderIcon = this.element.querySelector(`.subfolder-card[data-folder-id="${folderId}"] .fa-folder`);
                    if (gridFolderIcon) {
                        gridFolderIcon.style.color = color;
                    }
                });
                colorContainer.append(dot);
            }
            menu.append(colorContainer);

            // 重新生成缩略图
            const regenItem = $(`
          <div class="ov-context-menu-item">
            <i class="fas fa-image"></i>
            <span>${t('origin-vault.notifications.regenFolderThumbnails') || '重新生成缩略图'}</span>
          </div>
        `);
            regenItem.on('click', () => {
                menu.remove();
                // 获取此文件夹下所有素材
                const folderItems = this.library.getItemsByFolder(folderId);
                if (folderItems.length === 0) {
                    ui.notifications.info(t('origin-vault.notifications.noItemsToGen') || ovText('No items in this folder', 'В этой папке нет предметов'));
                    return;
                }
                this._regenerateThumbnailsForItems(folderItems, folderId);
            });
            menu.append(regenItem);

            // 分隔线
            menu.append('<div class="ov-context-menu-divider"></div>');

            // 移除文件夹（仅移除引用，不删除素材）
            const removeItem = $(`
          <div class="ov-context-menu-item">
            <i class="fas fa-folder-minus"></i>
            <span>${t('origin-vault.folders.remove')}</span>
          </div>
        `);
            removeItem.on('click', () => {
                menu.remove();
                this._onRemoveFolder(folderId);
            });
            menu.append(removeItem);

            // 删除文件夹（连同素材一起删除）
            const deleteItem = $(`
          <div class="ov-context-menu-item danger">
            <i class="fas fa-trash"></i>
            <span>${t('origin-vault.folders.deleteWithItems')}</span>
          </div>
        `);
            deleteItem.on('click', () => {
                menu.remove();
                this._onDeleteFolderWithItems(folderId);
            });
            menu.append(deleteItem);
        }

        // 定位菜单
        // Keep the context menu inside OV's own layer stack.
        const { rect: hostRect } = getOverlayHostRect({ owner: this });
        const initialLeft = event.clientX - hostRect.left;
        const initialTop = event.clientY - hostRect.top;
        menu.css({
            position: 'absolute',
            left: `${initialLeft}px`,
            top: `${initialTop}px`,
            zIndex: OV_LAYERS.CONTEXT_MENU
        });

        appendJQueryToOverlayHost(menu, { owner: this });

        // 确保菜单不超出屏幕
        const menuWidth = menu.outerWidth() || 0;
        const menuHeight = menu.outerHeight() || 0;
        const clampedLeft = Math.max(5, Math.min(initialLeft, hostRect.width - menuWidth - 5));
        const clampedTop = Math.max(5, Math.min(initialTop, hostRect.height - menuHeight - 5));

        menu.css({
            left: `${clampedLeft}px`,
            top: `${clampedTop}px`
        });

        // 点击外部关闭菜单
        const closeMenu = (e) => {
            if (!$(e.target).closest('.ov-context-menu').length) {
                menu.remove();
                $(document).off('click', closeMenu);
            }
        };
        setTimeout(() => $(document).on('click', closeMenu), 0);
    };

    /**
     * 素材右键菜单
     */
    cls.prototype._onItemContextMenu = function (event, itemId, context = {}) {
        // File picker mode: no context menu, just select
        if (this.filePickerMode) {
            event.preventDefault();
            event.stopPropagation();
            if (!context.preserveSelection) {
                this.selectedItems.clear();
                this.selectedItems.add(itemId);
                this._updateSelectionVisuals();
                this._updatePickerConfirmState();
            }
            return;
        }

        // 如果右键的项不在当前选中集合中，则替换选择
        if (!context.preserveSelection && !this.selectedItems.has(itemId)) {
            this.selectedItems.clear();
            this.selectedItems.add(itemId);
            this._updateSelectionVisuals();
            this._renderDetailsPanel();
        }
        // 否则保持多选不变

        const item = context.item || this.library.getItem(itemId);
        if (!item) return;

        // 菜单绑定当前卡片的候选集合，异步回调不读取后来变化的主网格选择。
        const selection = context.selectedItems || new Set(this.selectedItems);
        const folderId = context.folderId || this.currentFolderId;
        const managed = this.library.getItem(itemId) === item;
        const isMulti = selection.size > 1;
        const selectedCount = selection.size;

        const isItemType = item.metadata?.type === 'item';
        const isSmartFolderView = this.library.isSmartFolderId?.(folderId);

        const menuItems = [
            {
                name: t('origin-vault.items.viewDetails'),
                icon: '<i class="fas fa-info-circle"></i>',
                callback: () => context.onOpen ? context.onOpen(item) : this._onItemDoubleClick(itemId, item)
            },
            // 物品类型没有文件路径，不显示复制路径
            ...(!isItemType ? [{
                name: t('origin-vault.items.copyPath'),
                icon: '<i class="fas fa-copy"></i>',
                callback: () => {
                    navigator.clipboard.writeText(item.path);
                    ui.notifications.info(t('origin-vault.notifications.pathCopied'));
                }
            }] : []),
            // 展示给玩家（仅图片）
            ...(!isItemType && item.path && FILE_TYPES.IMAGE.some(ext => item.path.toLowerCase().endsWith(ext)) ? [{
                name: t('origin-vault.items.showToPlayers'),
                icon: '<i class="fas fa-eye"></i>',
                callback: () => {
                    const ip = new ImagePopout(item.path, { title: item.displayName || item.path, shareable: true });
                    ip.render(true);
                    ip.shareImage();
                }
            }] : []),
            ...(managed && !isSmartFolderView ? [{
                name: t('origin-vault.ui.removeFromFolder'),
                icon: '<i class="fas fa-folder-minus"></i>',
                callback: async () => {
                    const isSpecialFolder = folderId.startsWith('__');
                    // 批量：对所有选中项执行
                    for (const iid of selection) {
                        if (!isSpecialFolder) {
                            await this._onRemoveItemFromFolder(iid, folderId);
                        } else {
                            const itm = this.library.getItem(iid);
                            if (itm?.folders?.length > 0) {
                                const realFolders = itm.folders.filter(fid => !fid.startsWith('__'));
                                if (realFolders.length === 1) {
                                    await this._onRemoveItemFromFolder(iid, realFolders[0]);
                                }
                            }
                        }
                    }
                }
            }] : []),
            ...(managed ? [{
                name: t('origin-vault.notifications.regenThumbnail') || '重新生成缩略图',
                icon: '<i class="fas fa-image"></i>',
                callback: () => {
                    const regenItems = [];
                    for (const iid of selection) {
                        const itm = this.library.getItem(iid);
                        if (itm) regenItems.push({ ...itm, id: iid });
                    }
                    this._regenerateThumbnailsForItems(regenItems, folderId);
                }
            },
            {
                name: isMulti
                    ? `${t('origin-vault.items.delete')} (${selectedCount})`
                    : t('origin-vault.items.delete'),
                icon: '<i class="fas fa-trash"></i>',
                callback: async () => {
                    if (isMulti) {
                        // 批量删除 — 只弹一次确认
                        const ids = [...selection];
                        const confirmed = await this._showConfirmDialog(
                            `${t('origin-vault.items.delete')} (${ids.length})`,
                            `${tf('origin-vault.items.deleteBatchConfirm', { count: ids.length })}<br><br><em style="color: var(--ov-text-secondary);">${t('origin-vault.items.deleteNote')}</em>`,
                            true
                        );
                        if (confirmed) {
                            for (const iid of ids) {
                                await this.library.removeItem(iid);
                                this.selectedItems.delete(iid);
                            }
                            this.render(false);
                        }
                    } else {
                        this._onDeleteItem(itemId);
                    }
                }
            }] : [])
        ];

        this._showContextMenu(event, menuItems);
    };
}
