// 未来的我：别再用 jQuery ($) 了！所有 DOM 操作用原生 API
// 现有的 $() 调用是历史债务，重构时逐步干掉
/**
 * SidebarMixin - 侧边栏渲染与文件夹操作
 * 从 MainWindow 提取的侧边栏相关方法
 * 
 * 包含：侧边栏渲染、文件夹树构建、文件夹点击/折叠/创建/重命名/拖放/删除
 * 混入后通过 this 访问 MainWindow 实例状态
 */

import { SPECIAL_FOLDERS } from '../../constants.js';
import { t, tf } from '../../utils/i18n.js';
import { SmartFolderDialog } from '../SmartFolderDialog.js';

/**
 * 将侧边栏方法混入目标类
 * @param {Function} cls - 目标类 (MainWindow)
 */
export function applySidebarMixin(cls) {

    // ==================== 渲染方法 ====================

    /**
     * 仅渲染左侧边栏
     * 用于：文件夹增删改、展开/折叠
     */
    cls.prototype._renderSidebar = async function () {
        if (!this.element) return;

        const data = await this._prepareContext();
        const sidebarContent = await this._compileSidebarPartial(data);

        const sidebarEl = $(this.element).find('#ov-sidebar');
        if (sidebarEl.length) {
            // 保存文件夹树的滚动位置
            const folderTree = sidebarEl.find('.folder-tree-content')[0];
            const savedScrollTop = folderTree ? folderTree.scrollTop : 0;

            sidebarEl.html(sidebarContent);
            this._activateSidebarListeners(sidebarEl);

            // 重新初始化库选择器
            this._initLibrarySelector();

            // 恢复文件夹树的滚动位置（等待 DOM 布局完成后再恢复）
            if (savedScrollTop > 0) {
                requestAnimationFrame(() => {
                    const newFolderTree = sidebarEl.find('.folder-tree-content')[0];
                    if (newFolderTree) {
                        newFolderTree.scrollTop = savedScrollTop;
                    }
                });
            }

            // 恢复导入中文件夹的脉冲动画
            if (this._backgroundTask?.targetFolderId) {
                this._setFolderImporting(this._backgroundTask.targetFolderId, true);
            }
        }
    };

    cls.prototype._refreshAfterFolderTreeChange = async function () {
        await this._renderSidebar();
        await this._renderAssetGrid();
        this._renderDetailsPanel();
    };

    /**
     * 构建文件夹树结构
     */
    cls.prototype._buildFolderTree = function (parentId, folders, depth = 0) {
        const parent = folders[parentId];
        if (!parent) return [];

        return parent.children.map(childId => {
            const folder = folders[childId];
            if (!folder) return null;

            const itemCount = this.library.getItemCountByFolder(childId);

            return {
                ...folder,
                depth,
                itemCount,
                isSelected: childId === this.currentFolderId,
                children: this._buildFolderTree(childId, folders, depth + 1)
            };
        }).filter(f => f !== null);
    };

    /**
     * 更新侧边栏选中状态 (支持自动展开父文件夹和滚动)
     */
    cls.prototype._updateSidebarSelection = async function (folderId) {
        if (!this.element) return;

        // 1. 确保父文件夹展开 (Sync expansion)
        let needsRender = false;
        if (folderId && folderId !== SPECIAL_FOLDERS.ROOT && !this.library.isSmartFolderId?.(folderId)) {
            const folder = this.library.getFolder(folderId);
            if (folder) {
                let parentId = folder.parent;
                // 向上遍历所有父级，如果有折叠的则展开
                while (parentId && parentId !== SPECIAL_FOLDERS.ROOT) {
                    const parent = this.library.getFolder(parentId);
                    if (parent && parent.collapsed) {
                        parent.collapsed = false;
                        needsRender = true;
                    }
                    parentId = parent ? parent.parent : null;
                }
            }
        }

        if (needsRender) {
            this.library._markDirty();
            await this._renderSidebar();
        }

        // 2. 更新选中样式
        // 移除所有选中状态
        this.element.querySelectorAll('.special-folder, .smart-folder, .folder-item').forEach(el => {
            el.classList.remove('selected', 'active');
        });

        // 添加新选中状态
        const targetSelector = `.special-folder[data-folder-id="${folderId}"], .smart-folder[data-folder-id="${folderId}"], .folder-item[data-folder-id="${folderId}"]`;
        const targets = this.element.querySelectorAll(targetSelector);
        targets.forEach(t => t.classList.add('selected', 'active'));

        // 3. 滚动到可视区域 (如果刚才进行了重绘，需要等待 DOM 更新)
        if (targets.length > 0) {
            setTimeout(() => {
                // 使用该元素滚动，优先滚动 sidebar 里的 folder-item
                // targets 可能包含 special-folder 或 folder-item
                const itemToScroll = targets[0];
                // 检查是否已经在视口可见，避免不必要的滚动干扰
                if (itemToScroll) {
                    itemToScroll.scrollIntoView({ block: 'center', behavior: 'smooth' });
                }
            }, needsRender ? 50 : 0);
        }
    };

    /**
     * 在侧边栏给指定文件夹添加/移除"导入中"动画
     */
    cls.prototype._setFolderImporting = function (folderId, importing, _retries = 0) {
        if (!folderId) return;
        const el = this.element;
        if (!el) {
            if (importing && _retries < 5) {
                requestAnimationFrame(() => this._setFolderImporting(folderId, importing, _retries + 1));
            }
            return;
        }
        const folderEl = el.querySelector(`.folder-item[data-folder-id="${folderId}"]`);
        if (folderEl) {
            folderEl.classList.toggle('ov-importing', importing);
        } else if (importing && _retries < 5) {
            // DOM 还没重建完成，下一帧再试
            requestAnimationFrame(() => this._setFolderImporting(folderId, importing, _retries + 1));
        }
    };

    // ==================== 交互方法 ====================

    /**
     * Reveal an item inside the current grid view.
     */
    cls.prototype._revealItemInGrid = function (itemId, attempt = 0) {
        if (!itemId || !this.element) return;

        const gridContainer = this.element.querySelector('.asset-grid');
        const retry = () => {
            if (attempt >= 10) return;
            window.setTimeout(() => this._revealItemInGrid(itemId, attempt + 1), 60);
        };

        if (!gridContainer) {
            retry();
            return;
        }

        const highlightCard = () => {
            const card = this.element?.querySelector(`.asset-card[data-item-id="${itemId}"]`);
            if (!card) return;
            card.classList.add('locate-highlight');
            window.setTimeout(() => card.classList.remove('locate-highlight'), 2000);
        };

        const isVirtualView = this.virtualScrollEnabled
            && Array.isArray(this.allItems)
            && this.allItems.length >= this.virtualScrollThreshold
            && !!gridContainer.querySelector('.asset-grid-virtual');

        if (isVirtualView && this.itemPositions?.has(itemId)) {
            const pos = this.itemPositions.get(itemId);
            const subfoldersOffset = typeof this._getSubfoldersOffset === 'function'
                ? this._getSubfoldersOffset(gridContainer)
                : 0;
            const targetTop = Math.max(
                0,
                pos.top + subfoldersOffset - (gridContainer.clientHeight / 2) + ((pos.height || 0) / 2)
            );

            if (typeof gridContainer.scrollTo === 'function') {
                gridContainer.scrollTo({ top: targetTop, behavior: 'smooth' });
            } else {
                gridContainer.scrollTop = targetTop;
            }

            window.setTimeout(() => {
                if (typeof this._onVirtualScroll === 'function') {
                    this._onVirtualScroll({ target: gridContainer });
                }
                highlightCard();
            }, 120);
            return;
        }

        const card = this.element.querySelector(`.asset-card[data-item-id="${itemId}"]`);
        if (!card) {
            retry();
            return;
        }

        if (!gridContainer.classList.contains('layout-ready')) {
            retry();
            return;
        }

        const cardRect = card.getBoundingClientRect();
        const containerRect = gridContainer.getBoundingClientRect();
        const targetTop = Math.max(
            0,
            gridContainer.scrollTop + (cardRect.top - containerRect.top) - (gridContainer.clientHeight / 2) + (cardRect.height / 2)
        );

        if (typeof gridContainer.scrollTo === 'function') {
            gridContainer.scrollTo({ top: targetTop, behavior: 'smooth' });
        } else {
            gridContainer.scrollTop = targetTop;
        }

        window.setTimeout(() => highlightCard(), 140);
    };

    /**
     * Navigate to a folder and optionally keep one asset selected and visible.
     */
    cls.prototype._navigateToFolder = async function (folderId, options = {}) {
        const {
            preserveSelection = false,
            selectedItemId = null,
            revealItemId = null
        } = options;

        const sameFolder = this.currentFolderId === folderId;
        const keptItemId = preserveSelection
            ? (selectedItemId || (this.selectedItems?.size === 1 ? this.selectedItems.values().next().value : null))
            : null;
        const targetRevealItemId = revealItemId || keptItemId || null;

        if (sameFolder && !keptItemId && !targetRevealItemId) return;

        if (!sameFolder) {
            this.currentFolderId = folderId;
            this.previewItem = null;

            const gridContainer = this.element?.querySelector('.asset-grid');
            if (gridContainer) gridContainer.scrollTop = 0;
            this._skipAnchorCaptureOnNextGridRender = true;
            this._scrollAnchorIds = [];
            this._restoreScrollIndex = -1;
            this._fallbackScrollTop = 0;
            this._skipScrollRestore = true;

            if (this.filters) {
                this.filters.tags = [];
                this.filters.excludeTags = [];
                this.filters.untagged = false;
            }

            if (this.filterPanel) {
                this.filterPanel.filters.tags = [];
                this.filterPanel.filters.excludeTags = [];
                this.filterPanel.filters.untagged = false;
                this.filterPanel.setCurrentFolder(folderId);
            }
        }

        if (keptItemId) {
            this.selectedItems.clear();
            this.selectedItems.add(keptItemId);
            this._lastClickedItemId = keptItemId;
        } else if (!sameFolder) {
            this.selectedItems.clear();
        }

        if (typeof this._updatePickerConfirmState === 'function') {
            this._updatePickerConfirmState();
        }

        if (!sameFolder) {
            this._pendingLocateItemId = targetRevealItemId || null;
            await this._updateSidebarSelection(folderId);
            await this._renderAssetGrid();
            this._scheduleDetailsPanelRender();

            const useVirtualScroll = this.virtualScrollEnabled
                && Array.isArray(this.allItems)
                && this.allItems.length >= this.virtualScrollThreshold
                && !this.previewItem;

            if (targetRevealItemId && !useVirtualScroll) {
                requestAnimationFrame(() => this._revealItemInGrid(targetRevealItemId));
            }
            if (targetRevealItemId && typeof this._scheduleKeepSelectedItemVisible === 'function') {
                this._scheduleKeepSelectedItemVisible();
            }
            return;
        }

        this._pendingLocateItemId = null;

        if (keptItemId && typeof this._updateSelectionVisuals === 'function') {
            this._updateSelectionVisuals();
        }

        if (targetRevealItemId) {
            this._revealItemInGrid(targetRevealItemId);
            if (typeof this._scheduleKeepSelectedItemVisible === 'function') {
                this._scheduleKeepSelectedItemVisible();
            }
        }

        this._scheduleDetailsPanelRender();
    };

    /**
     * Folder click.
     */
    cls.prototype._onFolderClick = function (folderId) {
        if (this.currentFolderId === folderId) {
            if (typeof this._clearTagFilters === 'function') {
                this._clearTagFilters({ scrollToTop: true, rerenderGrid: true });
            }
            return;
        }
        void this._navigateToFolder(folderId);
    };

    cls.prototype._openSmartFolderDialog = async function (smartFolderId = null) {
        const smartFolder = smartFolderId ? this.library.getSmartFolder(smartFolderId) : null;
        const saved = await SmartFolderDialog.show(this, smartFolder);
        if (!saved) return;

        this.currentFolderId = saved.id;
        this.previewItem = null;
        this.selectedItems.clear();
        this._scrollToTop?.();
        await this._renderSidebar();
        await this._renderAssetGrid();
        this._renderDetailsPanel();
    };

    cls.prototype._onCreateSmartFolder = function () {
        void this._openSmartFolderDialog(null);
    };

    cls.prototype._onSmartFolderRename = async function (smartFolderId) {
        const smartFolder = this.library.getSmartFolder(smartFolderId);
        if (!smartFolder) return;

        const newName = await this._showInputDialog(
            t('origin-vault.smartFolders.rename'),
            t('origin-vault.smartFolders.name'),
            smartFolder.name
        );

        if (!newName || newName === smartFolder.name) return;

        this.library.renameSmartFolder(smartFolderId, newName);
        await this._renderSidebar();
        if (this.currentFolderId === smartFolderId) {
            await this._renderAssetGrid();
        }
    };

    cls.prototype._onSmartFolderDelete = async function (smartFolderId) {
        const smartFolder = this.library.getSmartFolder(smartFolderId);
        if (!smartFolder) return;

        const confirmed = await this._showConfirmDialog(
            t('origin-vault.smartFolders.delete'),
            tf('origin-vault.smartFolders.deleteConfirm', { name: smartFolder.name }),
            true
        );
        if (!confirmed) return;

        this.library.deleteSmartFolder(smartFolderId);
        if (this.currentFolderId === smartFolderId) {
            this.currentFolderId = SPECIAL_FOLDERS.ALL;
            this.selectedItems.clear();
            this.previewItem = null;
        }
        await this._renderSidebar();
        await this._renderAssetGrid();
        this._renderDetailsPanel();
    };

    cls.prototype._onSmartFolderContextMenu = function (event, smartFolderId) {
        const smartFolder = this.library.getSmartFolder(smartFolderId);
        if (!smartFolder) return;

        this._showContextMenu(event, [
            {
                name: t('origin-vault.smartFolders.edit'),
                icon: '<i class="fas fa-pen"></i>',
                callback: () => this._openSmartFolderDialog(smartFolderId)
            },
            {
                name: t('origin-vault.smartFolders.rename'),
                icon: '<i class="fas fa-i-cursor"></i>',
                callback: () => this._onSmartFolderRename(smartFolderId)
            },
            {
                name: t('origin-vault.smartFolders.delete'),
                icon: '<i class="fas fa-trash"></i>',
                callback: () => this._onSmartFolderDelete(smartFolderId)
            }
        ]);
    };

    /**
     * 展开/折叠文件夹
     */
    cls.prototype._onFolderToggle = function (folderId) {
        const folder = this.library.getFolder(folderId);
        if (folder) {
            folder.collapsed = !folder.collapsed;
            this.library._markDirty();
            // 只刷新侧边栏
            this._renderSidebar();
        }
    };

    /**
     * 展开目标文件夹的所有父文件夹，确保该文件夹在侧边栏可见
     * @param {string} folderId - 目标文件夹 ID
     */
    cls.prototype._expandParentFolders = function (folderId) {
        const folder = this.library.getFolder(folderId);
        if (!folder) return;

        let needsRender = false;
        let parentId = folder.parent;

        // 向上遍历所有父文件夹
        while (parentId && parentId !== SPECIAL_FOLDERS.ROOT) {
            const parentFolder = this.library.getFolder(parentId);
            if (parentFolder && parentFolder.collapsed) {
                parentFolder.collapsed = false;
                needsRender = true;
            }
            parentId = parentFolder?.parent;
        }

        if (needsRender) {
            this.library._markDirty();
            this._renderSidebar();
        }
    };

    /**
     * 重命名文件夹（对话框方式）
     */
    cls.prototype._onFolderRename = async function (folderId) {
        if (folderId === SPECIAL_FOLDERS.ROOT) return;

        const folder = this.library.getFolder(folderId);
        if (!folder) return;

        const newName = await this._showInputDialog(t('origin-vault.folders.rename'), t('origin-vault.folders.folderName'), folder.name);

        if (newName && newName !== folder.name) {
            this.library.renameFolder(folderId, newName);
            this.render(false);
        }
    };

    /**
     * 创建文件夹入口
     */
    cls.prototype._onCreateFolder = async function () {
        // Eagle 风格：直接在树中创建可编辑的新文件夹
        const parentId = this.currentFolderId.startsWith('__') ? SPECIAL_FOLDERS.ROOT : this.currentFolderId;
        this._createInlineFolder(parentId);
    };

    /**
     * 在树中创建内联可编辑的新文件夹 (Eagle 风格)
     */
    cls.prototype._createInlineFolder = function (parentId) {
        // 先创建文件夹
        const newFolderId = this.library.createFolder(parentId, t('origin-vault.folders.new'));

        // 展开父文件夹
        const parentFolder = this.library.getFolder(parentId);
        if (parentFolder) {
            parentFolder.collapsed = false;
            this.library._markDirty();
        }

        // 重新渲染并启动内联编辑
        this.render(false);

        // 等待 DOM 更新后启动内联编辑
        setTimeout(() => {
            this._startInlineRename(newFolderId);
        }, 50);
    };

    /**
     * 创建子文件夹 (悬停按钮点击)
     */
    cls.prototype._onCreateSubfolderInline = function (parentFolderId) {
        this._createInlineFolder(parentFolderId);
    };

    /**
     * 启动内联重命名模式
     */
    cls.prototype._startInlineRename = function (folderId) {
        const folderItem = $(this.element).find(`.folder-item[data-folder-id="${folderId}"]`);
        if (!folderItem.length) return;

        const folder = this.library.getFolder(folderId);
        if (!folder) return;

        // 找到文件夹名称元素
        const nameSpan = folderItem.find('.folder-name');
        if (!nameSpan.length) return;

        // 隐藏原来的名称，插入输入框
        const originalName = folder.name;
        nameSpan.hide();

        const input = $(`<input type="text" class="folder-name-input" value="${originalName}" />`);
        nameSpan.after(input);

        // 添加编辑状态类
        folderItem.addClass('editing');

        // 选中全部文本
        input[0].select();
        input[0].focus();

        // 保存函数
        const saveRename = () => {
            const newName = input.val().trim() || t('origin-vault.folders.new');
            if (newName !== originalName) {
                this.library.renameFolder(folderId, newName);
            }
            this.render(false);
        };

        // 取消编辑
        const cancelRename = () => {
            this.render(false);
        };

        // 事件监听
        input.on('blur', saveRename);
        input.on('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                saveRename();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelRename();
            }
        });
    };

    /**
     * 文件夹拖拽放置处理
     */
    cls.prototype._onFolderDrop = async function (draggedFolderId, targetFolderId) {
        // 不能将文件夹拖到自己或自己的子文件夹中
        const draggedFolder = this.library.getFolder(draggedFolderId);
        const targetFolder = this.library.getFolder(targetFolderId);

        if (!draggedFolder || !targetFolder) return;

        // 检查是否试图移动到自己的子文件夹
        if (this._isDescendant(targetFolderId, draggedFolderId)) {
            ui.notifications.warn(t('origin-vault.folders.cannotMoveToSub'));
            return;
        }

        // 移动文件夹
        this.library.moveFolder(draggedFolderId, targetFolderId);
        await this._refreshAfterFolderTreeChange();
        ui.notifications.info(tf('origin-vault.notifications.itemMoved', { count: 1 }));
    };

    /**
     * 检查 childId 是否是 parentId 的后代
     */
    cls.prototype._isDescendant = function (childId, parentId) {
        const parent = this.library.getFolder(parentId);
        if (!parent) return false;

        if (parent.children.includes(childId)) return true;

        for (const child of parent.children) {
            if (this._isDescendant(childId, child)) return true;
        }

        return false;
    };

    /**
     * 移除文件夹（仅移除文件夹引用，素材保留）
     */
    cls.prototype._onRemoveFolder = async function (folderId) {
        const folder = this.library.getFolder(folderId);
        if (!folder) return;

        const hasChildren = folder.children.length > 0;

        let content = tf('origin-vault.folders.removeConfirm', { name: folder.name });
        if (hasChildren) {
            content += `<br><br><strong style="color: var(--ov-warning);">${t('origin-vault.folders.removeWarning')}</strong>`;
        }
        content += `<br><br><em style="color: var(--ov-text-secondary);">${t('origin-vault.folders.removeNote')}</em>`;

        const confirmed = await this._showConfirmDialog(t('origin-vault.folders.remove'), content, true);

        if (confirmed) {
            try {
                this.library.deleteFolder(folderId, true);
                if (this.currentFolderId === folderId) {
                    this.currentFolderId = SPECIAL_FOLDERS.ALL;
                }
                this.render(false);
            } catch (error) {
                ui.notifications.error(tf('origin-vault.notifications.deleteFailed', { message: error.message }));
            }
        }
    };

    /**
     * 删除文件夹（连同所有素材一起删除）
     */
    cls.prototype._onDeleteFolderWithItems = async function (folderId) {
        const folder = this.library.getFolder(folderId);
        if (!folder) return;

        // 收集该文件夹及所有子文件夹中的素材
        const items = this.library.getItemsByFolder(folderId);
        const itemCount = items.length;
        const hasChildren = folder.children.length > 0;

        let content = tf('origin-vault.folders.deleteWithItemsConfirm', { name: folder.name, count: itemCount });
        if (hasChildren) {
            content += `<br><br><strong style="color: var(--ov-warning);">${t('origin-vault.folders.deleteWithItemsWarning')}</strong>`;
        }
        content += `<br><br><em style="color: var(--ov-text-secondary);">${t('origin-vault.folders.deleteWithItemsNote')}</em>`;

        const deletedFolderIds = this.library.getAllDescendantFolders(folderId);
        deletedFolderIds.add(folderId);

        await this._showAsyncConfirmDialog(t('origin-vault.folders.deleteWithItems'), content, {
            isDanger: true,
            loadingLabel: t('origin-vault.browser.loading'),
            onConfirm: async ({ setStatus }) => {
                try {
                    if (itemCount > 0) {
                        for (let i = 0; i < items.length; i++) {
                            const item = items[i];
                            const current = i + 1;
                            const pct = Math.round((current / itemCount) * 100);

                            setStatus(tf('origin-vault.notifications.processing', {
                                current,
                                total: itemCount,
                                pct
                            }));

                            await this.library.removeItem(item.id);
                            this.selectedItems.delete(item.id);

                            if (current % 10 === 0) {
                                await new Promise(resolve => setTimeout(resolve, 0));
                            }
                        }
                    }

                    setStatus(t('origin-vault.browser.loading'));
                    this.library.deleteFolder(folderId, true);

                    if (deletedFolderIds.has(this.currentFolderId)) {
                        this.currentFolderId = SPECIAL_FOLDERS.ALL;
                    }

                    this.render(false);
                    ui.notifications.info(tf('origin-vault.notifications.folderDeletedWithItems', { name: folder.name, count: itemCount }));
                    return true;
                } catch (error) {
                    ui.notifications.error(tf('origin-vault.notifications.deleteFailed', { message: error.message }));
                    return false;
                }
            }
        });

        return;

        if (confirmed) {
            try {
                // 先删除所有素材
                for (const item of items) {
                    await this.library.removeItem(item.id);
                    this.selectedItems.delete(item.id);
                }
                // 再删除文件夹
                this.library.deleteFolder(folderId, true);
                if (this.currentFolderId === folderId) {
                    this.currentFolderId = SPECIAL_FOLDERS.ALL;
                }
                this.render(false);
                ui.notifications.info(tf('origin-vault.notifications.folderDeletedWithItems', { name: folder.name, count: itemCount }));
            } catch (error) {
                ui.notifications.error(tf('origin-vault.notifications.deleteFailed', { message: error.message }));
            }
        }
    };
}
