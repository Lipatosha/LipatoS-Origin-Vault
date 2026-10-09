import { ovText } from '../../utils/locale.js';
/**
 * ItemBrowserMixin - 物品浏览器引擎（aka 杂货铺前台）
 * ---------------------------------------------------
 * 从 MainWindow 提取出来的物品浏览器相关方法，
 * 仿照 GridLayoutMixin 的 mixin 模式。
 * 
 * 包含：面板切换、Pack 列表、批量导入、原生 Sheet 打开、
 *       详情面板渲染、事件监听
 * 混入后通过 this 访问 MainWindow 实例状态
 */

import { MODULE_ID, SPECIAL_FOLDERS } from '../../constants.js';
import { extractSystemFieldValues, getSubTypeLabel, getDescriptionPath } from '../../data/SystemConfigs.js';
import { t, tf } from '../../utils/i18n.js';
import {
    bindCompendiumPackGroupToggles,
    buildCompendiumPackGroups,
    getCompendiumPackGroupCollapsed,
    getCompendiumPackSourceMeta,
    setCompendiumPackGroupCollapsed
} from '../../utils/compendiumPackDisplay.js';
import { naturalCompare } from '../../utils/sort.js';
import { ImportFloater } from '../ImportFloater.js';

/**
 * 将物品浏览器方法混入目标类
 * @param {Function} cls - 目标类 (MainWindow)
 */
export function applyItemBrowserMixin(cls) {

    /**
     * 切换物品浏览器面板
     * 互斥：打开物品浏览器时关闭场景浏览器和文件浏览器
     */
    cls.prototype._toggleItemBrowser = function () {
        this.itemBrowserVisible = !this.itemBrowserVisible;
        if (this.itemBrowserVisible) {
            this.sceneBrowserVisible = false;
            this.browserVisible = false;
            this._primeItemPackDisplayData?.();
        }
        this._renderDetailsPanel();
    };

    cls.prototype._normalizeCompendiumFolderId = function (folderLike) {
        if (!folderLike) return null;
        if (typeof folderLike === 'string') return folderLike;
        return folderLike.id || folderLike._id || null;
    };

    cls.prototype._getCompendiumFolderParentId = function (folderLike) {
        if (!folderLike || typeof folderLike === 'string') return null;
        if (typeof folderLike.folder === 'string') return folderLike.folder;
        if (folderLike.folder?.id) return folderLike.folder.id;
        if (folderLike.folder?._id) return folderLike.folder._id;
        if (folderLike._source?.folder) return folderLike._source.folder;
        return null;
    };

    cls.prototype._getPackFolderCollection = function (pack) {
        if (!pack?.folders) return [];
        if (Array.isArray(pack.folders)) return pack.folders;
        if (Array.isArray(pack.folders.contents)) return pack.folders.contents;
        if (typeof pack.folders.values === 'function') return Array.from(pack.folders.values());
        return Array.from(pack.folders);
    };

    cls.prototype._getItemPackIndex = async function (pack) {
        return pack.getIndex({ fields: ['img', 'type', 'system', 'folder'] });
    };

    cls.prototype._getVisibleItemPackEntries = function (index) {
        const entries = Array.from(index?.values?.() || index || []);
        const entryIds = new Set(entries.map(entry => entry?._id).filter(Boolean));
        return entries.filter(entry => {
            const containerId = entry?.system?.container;
            return !(containerId && entryIds.has(containerId));
        });
    };

    cls.prototype._getVisibleItemPackCount = function (pack) {
        this._itemPackVisibleCountCache ??= new Map();

        const cachedCount = this._itemPackVisibleCountCache.get(pack.collection);
        if (Number.isInteger(cachedCount)) return cachedCount;

        if (pack?.index?.size) {
            const visibleCount = this._getVisibleItemPackEntries(pack.index).length;
            this._itemPackVisibleCountCache.set(pack.collection, visibleCount);
            return visibleCount;
        }

        return '?';
    };

    cls.prototype._primeItemPackDisplayData = function () {
        this._itemPackVisibleCountCache ??= new Map();
        if (this._itemPackVisibleCountPromise) return this._itemPackVisibleCountPromise;

        const packs = game.packs.filter(p => p.documentName === 'Item');
        this._itemPackVisibleCountPromise = Promise.allSettled(
            packs.map(async pack => {
                const index = await this._getItemPackIndex(pack);
                const visibleCount = this._getVisibleItemPackEntries(index).length;
                this._itemPackVisibleCountCache.set(pack.collection, visibleCount);
            })
        ).finally(() => {
            this._itemPackVisibleCountPromise = null;
            if (this.itemBrowserVisible) {
                this._renderDetailsPanel();
            }
        });

        return this._itemPackVisibleCountPromise;
    };

    cls.prototype._createItemPackFolderMap = function (pack, rootFolderId, entries) {
        const folderMap = new Map();
        const packFolders = this._getPackFolderCollection(pack);
        if (!packFolders.length) return folderMap;

        const foldersById = new Map(
            packFolders
                .map(folder => [this._normalizeCompendiumFolderId(folder), folder])
                .filter(([id]) => !!id)
        );

        const requiredFolderIds = new Set();
        for (const entry of entries) {
            let folderId = this._normalizeCompendiumFolderId(entry?.folder);
            while (folderId && foldersById.has(folderId) && !requiredFolderIds.has(folderId)) {
                requiredFolderIds.add(folderId);
                folderId = this._getCompendiumFolderParentId(foldersById.get(folderId));
            }
        }

        const depthCache = new Map();
        const getDepth = (folderId) => {
            if (!folderId || !foldersById.has(folderId)) return 0;
            if (depthCache.has(folderId)) return depthCache.get(folderId);

            const folder = foldersById.get(folderId);
            const depth = getDepth(this._getCompendiumFolderParentId(folder)) + 1;
            depthCache.set(folderId, depth);
            return depth;
        };

        const foldersToCreate = Array.from(requiredFolderIds)
            .map(folderId => foldersById.get(folderId))
            .filter(Boolean)
            .sort((a, b) => {
                const idA = this._normalizeCompendiumFolderId(a);
                const idB = this._normalizeCompendiumFolderId(b);
                const depthDiff = getDepth(idA) - getDepth(idB);
                if (depthDiff !== 0) return depthDiff;

                const sortA = Number(a.sort ?? a._source?.sort ?? 0);
                const sortB = Number(b.sort ?? b._source?.sort ?? 0);
                if (sortA !== sortB) return sortA - sortB;

                return naturalCompare(a.name, b.name);
            });

        for (const folder of foldersToCreate) {
            const folderId = this._normalizeCompendiumFolderId(folder);
            const parentCompendiumId = this._getCompendiumFolderParentId(folder);
            const parentOvFolderId = folderMap.get(parentCompendiumId) || rootFolderId;
            const ovFolderId = this.library.createFolder(parentOvFolderId, folder.name);
            folderMap.set(folderId, ovFolderId);
        }

        return folderMap;
    };

    /**
     * 获取所有 Item 类型的 Compendium Pack 列表
     * @returns {Array<{id, name, count}>} Pack 列表
     */
    cls.prototype._getItemPackSourceMeta = function (pack) {
        return getCompendiumPackSourceMeta(pack);
    };

    cls.prototype._getItemPackGroupCollapsed = function (groupKey) {
        return getCompendiumPackGroupCollapsed(this, '_itemPackGroupState', groupKey);
    };

    cls.prototype._setItemPackGroupCollapsed = function (groupKey, collapsed) {
        setCompendiumPackGroupCollapsed(this, '_itemPackGroupState', groupKey, collapsed);
    };

    cls.prototype._getItemPackEntries = function () {
        return buildCompendiumPackGroups(this, game.packs.filter(p => p.documentName === 'Item'), {
            stateKey: '_itemPackGroupState',
            getCount: pack => this._getVisibleItemPackCount(pack),
            isSelected: packId => this._isCompendiumPackSelected?.(packId) || false
        });
    };

    // _getWorldItems 已移除：物品导入器不再显示世界物品

    /**
     * 批量导入 Compendium Pack 中的所有物品
     * 使用后台导入模式：底部进度条 + ImportFloater 悬浮窗
     * 
     * @param {string} packId - Compendium Pack 的 collection ID
     */
    cls.prototype._importPackItems = async function (packId, options = {}) {
        const pack = game.packs.get(packId);
        if (!pack) {
            if (options.notify !== false) ui.notifications.error(t('origin-vault.items.importFailed'));
            return { success: false, imported: 0, error: new Error(`Pack not found: ${packId}`) };
        }

        // 防止重复导入
        if (this._hasCompendiumImportInFlight?.() || (this._compendiumBatchState?.running && !options.fromBatch)) {
            ui.notifications.warn(t('origin-vault.notifications.bgImportRunning') || ovText('A background import is already running.', 'Фоновый импорт уже выполняется.'));
            return { success: false, imported: 0, busy: true };
        }

        this._itemPackImportPending = true;
        try {
            const folderName = pack.metadata.label;
            const batchPrefix = options.batchPosition
                ? `${options.batchPosition.current}/${options.batchPosition.total} · `
                : '';
            const label = `${batchPrefix}${t('origin-vault.items.importing')} ${folderName}`;
            const index = await this._getItemPackIndex(pack);
            const entries = this._getVisibleItemPackEntries(index);
            const totalCount = entries.length;

            if (!totalCount) {
                this._itemPackImportPending = false;
                this._itemPackImportActive = false;
                if (options.notify !== false) ui.notifications.warn(t('origin-vault.items.importFailed'));
                return { success: false, imported: 0, error: new Error(`Pack is empty: ${packId}`) };
            }

            const folderId = this.library.createFolder(SPECIAL_FOLDERS.ROOT, folderName);
            const folderMap = this._createItemPackFolderMap(pack, folderId, entries);

            // 注册后台任务
            this._backgroundTask = {
                type: 'item-import',
                label,
                total: totalCount,
                completed: 0,
                targetFolderId: folderId
            };

            // 侧边栏导入中动画
            this._setFolderImporting(folderId, true);

            // 显示底部进度条
            this._showBottomProgressBar(0, totalCount, label);

            // 刷新侧边栏显示新文件夹
            this._renderSidebar();

            // 返回任务本身，单包导入和批量队列都走同一条完成语义。
            return this._doItemImportAsync(pack, entries, folderMap, folderId, folderName, label, totalCount, options);
        } catch (error) {
            this._itemPackImportPending = false;
            this._itemPackImportActive = false;
            console.error(`${MODULE_ID} | Failed to prepare item pack import:`, error);
            if (options.notify !== false) ui.notifications.error(t('origin-vault.items.importFailed'));
            return { success: false, imported: 0, error };
        }
    };

    /**
     * 异步执行物品导入（后台任务）
     */
    cls.prototype._doItemImportAsync = async function (pack, entries, folderMap, folderId, folderName, label, totalCount, options = {}) {
        if (this._itemPackImportActive) {
            console.warn(`${MODULE_ID} | Item import already active, skipping duplicate start for ${pack?.collection}`);
            return { success: false, imported: 0, busy: true };
        }

        this._itemPackImportActive = true;

        try {
            let importCount = 0;
            const { MainWindow } = await import('../MainWindow.js');

            for (const entry of entries) {
                const imgPath = entry.img || 'icons/svg/item-bag.svg';
                const compendiumUuid = `Compendium.${pack.collection}.${entry._id}`;
                const targetFolderId = folderMap.get(this._normalizeCompendiumFolderId(entry?.folder)) || folderId;

                const ovItemId = await this.library.addItem(imgPath, targetFolderId, {
                    displayName: entry.name,
                    metadata: {
                        type: 'item',
                        uuid: compendiumUuid,
                        compendiumId: pack.collection,
                        itemType: entry.type || 'item',
                        rarity: entry.system?.rarity || ''
                    }
                });

                // 调用已注册的自动标签器（由扩展模块如 ov5e 注册）
                if (ovItemId && window.OriginVault?.autoTaggers?.length) {
                    for (const tagger of window.OriginVault.autoTaggers) {
                        try { await tagger(this.library, ovItemId, entry); } catch (e) { console.warn('Auto-tagger error:', e); }
                    }
                }

                importCount++;

                // 更新后台任务状态
                if (this._backgroundTask) {
                    this._backgroundTask.completed = importCount;
                }

                // 更新 ImportFloater（OV 窗口关闭时可见）
                const floater = ImportFloater.getInstance();
                if (floater.isVisible()) {
                    floater.update(importCount, totalCount, label);
                }

                // 更新底部进度条（OV 窗口打开时可见）
                if (MainWindow.isVisible && this.rendered) {
                    this._showBottomProgressBar(importCount, totalCount, label);
                }
            }

            // 保存素材库
            await this.library.save();

            // 清除后台任务
            this._backgroundTask = null;
            this._itemPackImportPending = false;
            this._itemPackImportActive = false;
            this._setFolderImporting(folderId, false);
            this._syncCompendiumBatchControls?.();

            const floater = ImportFloater.getInstance();
            if (!options.fromBatch && floater.isVisible()) {
                floater.complete();
            }

            if (!options.fromBatch && MainWindow.isVisible && this.rendered) {
                this._hideBottomProgressBar();
                this._refreshViewAfterUpdate(folderId);
            }

            if (options.notify !== false) {
                ui.notifications.info(tf('origin-vault.items.importSuccess', {
                    count: importCount,
                    pack: folderName
                }));
            }

            return { success: true, imported: importCount, total: totalCount, folderId };

        } catch (error) {
            console.error(`${MODULE_ID} | Item batch import failed:`, error);
            this._backgroundTask = null;
            this._itemPackImportPending = false;
            this._itemPackImportActive = false;
            this._setFolderImporting(folderId, false);
            this._syncCompendiumBatchControls?.();
            if (!options.fromBatch) this._hideBottomProgressBar();

            const floater = ImportFloater.getInstance();
            if (!options.fromBatch && floater.isVisible()) {
                floater.hide();
            }

            if (options.notify !== false) ui.notifications.error(t('origin-vault.items.importFailed'));
            return { success: false, imported: 0, error, folderId };
        }
    };

    /**
     * 打开原生 Item Sheet
     * 这里只负责把原生 sheet 打开，层级交给当前的窗口栈自己处理。
     * 
     * @param {string} itemUuid - 物品的 UUID（可以是 World 或 Compendium UUID）
     */
    cls.prototype._openNativeItemSheet = async function (itemUuid) {
        // 这里也保持朴素：打开原生 sheet 就停，别在 OV 里再造一套卡片。
        try {
            const doc = await fromUuid(itemUuid);
            if (!doc) {
                ui.notifications.warn(ovText('Item not found', 'Предмет не найден'));
                return;
            }

            doc.sheet.render(true);
        } catch (err) {
            console.error(`${MODULE_ID} | Failed to open item sheet:`, err);
            ui.notifications.error(`Failed to open item sheet: ${err.message}`);
        }
    };

    /**
     * 从世界中删除物品
     * 
     * @param {string} worldItemId - 世界中的物品 ID
     */
    cls.prototype._deleteWorldItem = async function (worldItemId) {
        const item = game.items?.get(worldItemId);
        if (!item) return;

        const confirmed = await Dialog.confirm({
            title: t('origin-vault.items.deleteConfirmTitle'),
            content: `<p>${tf('origin-vault.items.deleteConfirmContent', { name: item.name })}</p>`,
        });

        if (!confirmed) return;

        try {
            await item.delete();
            ui.notifications.info(tf('origin-vault.items.deleteSuccess', { name: item.name }));
            this._renderDetailsPanel();
        } catch (err) {
            console.error(`${MODULE_ID} | Failed to delete item:`, err);
            ui.notifications.error(`Failed to delete item: ${err.message}`);
        }
    };

    /**
     * 导入单个物品（从 Compendium 到世界）
     * 
     * @param {string} packId - Pack collection ID
     * @param {string} itemId - Pack 内的物品 ID
     */
    cls.prototype._importSingleItem = async function (packId, itemId) {
        try {
            const pack = game.packs.get(packId);
            if (!pack) throw new Error(`Pack not found: ${packId}`);

            const doc = await pack.getDocument(itemId);
            const itemObj = doc.toObject();
            const compendiumUuid = `Compendium.${pack.collection}.${itemId}`;
            itemObj._stats = itemObj._stats || {};
            itemObj._stats.compendiumSource = compendiumUuid;

            const created = await Item.implementation.create(itemObj);
            this._syncImportStateForWorldDocument?.('item', 'create', {
                _stats: { compendiumSource: compendiumUuid },
                flags: { core: { sourceId: compendiumUuid } },
                id: created.id,
                uuid: created.uuid
            });

            ui.notifications.info(tf('origin-vault.items.importItemSuccess', {
                name: created.name
            }));

            // 刷新详情面板（更新导入状态）
            this._renderDetailsPanel();
        } catch (err) {
            console.error(`${MODULE_ID} | Failed to import item:`, err);
            ui.notifications.error(`Import failed: ${err.message}`);
        }
    };

    /**
     * 激活物品浏览器的事件监听器
     * 在 _renderDetailsPanel 之后调用
     * 
     * @param {jQuery} panelEl - 详情面板的 jQuery 元素
     */
    cls.prototype._activateItemBrowserListeners = function (panelEl) {
        bindCompendiumPackGroupToggles(panelEl, this, { stateKey: '_itemPackGroupState' });
        // 关闭物品浏览器
        panelEl.find('.btn-close-item-browser').off('click').on('click', () => {
            this._toggleItemBrowser();
        });

        // 批量导入 Pack
        panelEl.find('.item-pack-item .btn-import-item-pack').off('click').on('click', async (event) => {
            event.stopPropagation();
            const packId = $(event.currentTarget).data('pack-id');
            if (packId) {
                await this._importPackItems(packId);
            }
        });

        // 点击世界物品 → 打开 Sheet
        panelEl.find('.world-item-entry[data-item-uuid]').on('dblclick', (event) => {
            const uuid = $(event.currentTarget).data('item-uuid');
            if (uuid) {
                this._openNativeItemSheet(uuid);
            }
        });
    };

    /**
     * 激活物品详情面板的事件监听器
     * 处理导入、打开 Sheet、删除等按钮
     * 
     * @param {jQuery} panelEl - 详情面板的 jQuery 元素
     */
    cls.prototype._activateItemDetailListeners = function (panelEl) {
        // 导入单个物品（物品浏览器面板的旧按钮，保留兼容）
        panelEl.find('.btn-import-item').on('click', async (event) => {
            const itemId = $(event.currentTarget).data('item-id');
            const packId = $(event.currentTarget).data('pack-id');
            if (itemId && packId) {
                await this._importSingleItem(packId, itemId);
            }
        });

        // 浏览物品卡（打开 Compendium 物品，只读）
        panelEl.find('.btn-browse-item-sheet').on('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const uuid = $(event.currentTarget).data('item-uuid');
            if (uuid) {
                setTimeout(() => this._openNativeItemSheet(uuid), 50);
            }
        });

        // 导入到世界
        panelEl.find('.btn-import-item-to-world').on('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const uuid = $(event.currentTarget).data('item-uuid');
            if (uuid) {
                await this._importItemToWorld(uuid);
            }
        });

        // 打开世界物品（可编辑，关闭后同步描述）
        panelEl.find('.btn-open-world-item').on('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const uuid = $(event.currentTarget).data('item-uuid');
            if (uuid) {
                setTimeout(() => this._openWorldItemWithSync(uuid), 50);
            }
        });

        // 删除世界物品
        panelEl.find('.btn-delete-item').on('click', async (event) => {
            const worldId = $(event.currentTarget).data('item-world-id');
            if (worldId) {
                await this._deleteWorldItem(worldId);
            }
        });
    };

    /**
     * 导入物品到世界
     * 在 Foundry 的 Items 中创建 OV 根文件夹和以 OV 文件夹名命名的子文件夹
     * 
     * @param {string} compendiumUuid - Compendium 物品的 UUID
     */
    cls.prototype._importItemToWorld = async function (compendiumUuid) {
        try {
            const doc = await fromUuid(compendiumUuid);
            if (!doc) {
                ui.notifications.warn(ovText('Item not found', 'Предмет не найден'));
                return;
            }

            // 1. 确定子文件夹名 = 当前 OV 文件夹名
            let subFolderName = null;
            if (this.currentFolderId && this.currentFolderId !== 'root' && this.currentFolderId !== '__all__') {
                const currentFolder = this.library.getFolder(this.currentFolderId);
                subFolderName = currentFolder?.name || null;
            }
            // 如果在"全部素材"或根目录，取该物品所属的第一个文件夹名
            if (!subFolderName) {
                const selectedId = this.selectedItems?.values()?.next()?.value;
                if (selectedId) {
                    const selectedItem = this.library.getItem(selectedId);
                    if (selectedItem?.folderIds?.length) {
                        const firstFolder = this.library.getFolder(selectedItem.folderIds[0]);
                        subFolderName = firstFolder?.name || null;
                    }
                }
            }
            if (!subFolderName) subFolderName = ovText('Uncategorized', 'Без категории');

            // 2. 创建/获取 "OV" 根文件夹
            let ovFolder = game.folders.find(f => f.name === 'OV' && f.type === 'Item' && !f.folder);
            if (!ovFolder) {
                ovFolder = await Folder.create({ name: 'OV', type: 'Item' });
            }

            // 3. 创建/获取子文件夹
            let subFolder = game.folders.find(f =>
                f.name === subFolderName && f.type === 'Item' && f.folder?.id === ovFolder.id
            );
            if (!subFolder) {
                subFolder = await Folder.create({
                    name: subFolderName,
                    type: 'Item',
                    folder: ovFolder.id
                });
            }

            // 4. 导入物品到世界
            const itemObj = doc.toObject();
            itemObj._stats = itemObj._stats || {};
            itemObj._stats.compendiumSource = compendiumUuid;
            itemObj.folder = subFolder.id;

            const created = await Item.implementation.create(itemObj);
            this._syncImportStateForWorldDocument?.('item', 'create', {
                _stats: { compendiumSource: compendiumUuid },
                flags: { core: { sourceId: compendiumUuid } },
                id: created.id,
                uuid: created.uuid
            });

            ui.notifications.info(tf('origin-vault.items.importItemSuccess', {
                name: created.name
            }));

            const previewUuid = this.previewItem?.uuid || this.previewItem?.metadata?.uuid;
            if (previewUuid && previewUuid === compendiumUuid) {
                this.previewItem.isItemImported = true;
                this.previewItem.worldItemUuid = created.uuid;
                this.previewItem.isImported = true;
                this.previewItem.worldId = created.id;
            }

            // 5. 刷新详情面板（按钮从"导入到世界"变为"打开物品卡"）
            this._renderDetailsPanel();
        } catch (err) {
            console.error(`${MODULE_ID} | Failed to import item to world:`, err);
            ui.notifications.error(`Import failed: ${err.message}`);
        }
    };

    /**
     * 打开世界物品（可编辑），关闭后同步描述回 OV
     * 
     * @param {string} worldItemUuid - 世界物品的 UUID
     */
    cls.prototype._openWorldItemWithSync = async function (worldItemUuid) {
        try {
            const doc = await fromUuid(worldItemUuid);
            if (!doc) {
                ui.notifications.warn(ovText('Item not found', 'Предмет не найден'));
                return;
            }

            const sheet = doc.sheet;
            sheet.render(true);

            const waitForSheet = setInterval(() => {
                const el = document.getElementById(sheet.id);
                if (!el) return;

                clearInterval(waitForSheet);

                const checkClose = setInterval(() => {
                    if (document.getElementById(sheet.id)) return;

                    clearInterval(checkClose);
                    this._renderDetailsPanel();
                }, 500);
            }, 50);

            setTimeout(() => clearInterval(waitForSheet), 3000);
        } catch (err) {
            console.error(`${MODULE_ID} | Failed to open world item:`, err);
            ui.notifications.error(`Failed to open item: ${err.message}`);
        }
    };

    /**
     * 为物品类型的 selectedDetail 注入增强数据
     * 在 _prepareContext 中调用，添加 systemFields 和 itemDescription
     * 
     * @param {object} detail - selectedDetail 对象
     * @param {object} itemData - 完整的物品数据（从 adapter 获取）
     * @returns {object} 增强后的 detail 对象
     */
    cls.prototype._enrichItemDetail = function (detail, itemData) {
        if (!detail || detail.type !== 'item') return detail;

        // 系统增强字段
        detail.systemFields = extractSystemFieldValues(itemData);

        // 子类型标签
        detail.subTypeLabel = getSubTypeLabel(itemData?.subType);

        // 物品描述
        if (itemData?.systemData) {
            const descPath = getDescriptionPath();
            const descFieldPath = descPath.replace(/^system\./, '');
            const desc = foundry.utils.getProperty(itemData.systemData, descFieldPath);
            if (desc) {
                detail.itemDescription = desc;
            }
        }

        return detail;
    };

}
