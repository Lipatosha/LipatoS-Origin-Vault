import { ovText } from '../../utils/locale.js';
/**
 * ActorBrowserMixin - 角色浏览器引擎（aka 角色经纪人前台）
 * ---------------------------------------------------
 * 从 MainWindow 提取出来的角色浏览器相关方法，
 * 仿照 ItemBrowserMixin 的 mixin 模式。
 * 
 * 包含：面板切换、Pack 列表、批量导入、原生 Sheet 打开、
 *       详情面板渲染、事件监听
 * 混入后通过 this 访问 MainWindow 实例状态
 * 
 * 只使用 Foundry Core API，不依赖任何特定系统。
 */

import { MODULE_ID, SPECIAL_FOLDERS } from '../../constants.js';
import { t, tf } from '../../utils/i18n.js';
import { bindCompendiumPackGroupToggles, buildCompendiumPackGroups } from '../../utils/compendiumPackDisplay.js';
import { ImportFloater } from '../ImportFloater.js';
import { getActorPreviewMeta } from '../../utils/actorDisplay.js';

/**
 * 将角色浏览器方法混入目标类
 * @param {Function} cls - 目标类 (MainWindow)
 */
export function applyActorBrowserMixin(cls) {

    /**
     * 切换角色浏览器面板
     * 互斥：打开角色浏览器时关闭场景浏览器、物品浏览器和文件浏览器
     */
    cls.prototype._toggleActorBrowser = function () {
        this.actorBrowserVisible = !this.actorBrowserVisible;
        if (this.actorBrowserVisible) {
            this.sceneBrowserVisible = false;
            this.itemBrowserVisible = false;
            this.browserVisible = false;
            this._primeActorPackDisplayData?.();
        }
        this._renderDetailsPanel();
    };

    cls.prototype._getActorPackIndex = async function (pack) {
        return pack.getIndex({ fields: ['img', 'type', 'system'] });
    };

    cls.prototype._getActorPackCount = function (pack) {
        this._actorPackCountCache ??= new Map();

        const cachedCount = this._actorPackCountCache.get(pack.collection);
        if (Number.isInteger(cachedCount)) return cachedCount;

        if (pack?.index?.size) {
            this._actorPackCountCache.set(pack.collection, pack.index.size);
            return pack.index.size;
        }

        return '?';
    };

    cls.prototype._primeActorPackDisplayData = function () {
        this._actorPackCountCache ??= new Map();
        if (this._actorPackCountPromise) return this._actorPackCountPromise;

        const packs = game.packs.filter(p => p.documentName === 'Actor');
        this._actorPackCountPromise = Promise.allSettled(
            packs.map(async pack => {
                const index = await this._getActorPackIndex(pack);
                this._actorPackCountCache.set(pack.collection, index.size);
            })
        ).finally(() => {
            this._actorPackCountPromise = null;
            if (this.actorBrowserVisible) {
                this._renderDetailsPanel();
            }
        });

        return this._actorPackCountPromise;
    };

    /**
     * 获取所有 Actor 类型的 Compendium Pack 列表
     * @returns {Array<{id, name, count}>} Pack 列表
     */
    cls.prototype._getActorPacks = function () {
        return buildCompendiumPackGroups(this, game.packs.filter(p => p.documentName === 'Actor'), {
            stateKey: '_actorPackGroupState',
            getCount: pack => this._getActorPackCount(pack),
            isSelected: packId => this._isCompendiumPackSelected?.(packId) || false
        });
    };

    /**
     * 批量导入 Compendium Pack 中的所有角色
     * 使用后台导入模式：底部进度条 + ImportFloater 悬浮窗
     * 
     * @param {string} packId - Compendium Pack 的 collection ID
     */
    cls.prototype._importPackActors = async function (packId, options = {}) {
        const pack = game.packs.get(packId);
        if (!pack) {
            if (options.notify !== false) ui.notifications.error(t('origin-vault.actors.importFailed'));
            return { success: false, imported: 0, error: new Error(`Pack not found: ${packId}`) };
        }

        // 防止重复导入
        if (this._hasCompendiumImportInFlight?.() || (this._compendiumBatchState?.running && !options.fromBatch)) {
            ui.notifications.warn(t('origin-vault.notifications.bgImportRunning') || 'A background import is already running.');
            return { success: false, imported: 0, busy: true };
        }

        this._actorPackImportPending = true;
        try {
            const folderName = pack.metadata.label;
            const batchPrefix = options.batchPosition
                ? `${options.batchPosition.current}/${options.batchPosition.total} · `
                : '';
            const label = `${batchPrefix}${t('origin-vault.actors.importing')} ${folderName}`;

            // 获取 Pack 索引
            const index = await this._getActorPackIndex(pack);
            const totalCount = index.size;

            if (!totalCount) {
                this._actorPackImportPending = false;
                this._actorPackImportActive = false;
                if (options.notify !== false) ui.notifications.warn(t('origin-vault.actors.importFailed'));
                return { success: false, imported: 0, error: new Error(`Pack is empty: ${packId}`) };
            }

            const folderId = this.library.createFolder(SPECIAL_FOLDERS.ROOT, folderName);

            // 注册后台任务
            this._backgroundTask = {
                type: 'actor-import',
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

            // 返回任务本身，队列才能等这一包真正结束后再跑下一包。
            return this._doActorImportAsync(pack, index, folderId, folderName, label, totalCount, options);
        } catch (error) {
            this._actorPackImportPending = false;
            this._actorPackImportActive = false;
            console.error(`${MODULE_ID} | Failed to prepare actor pack import:`, error);
            if (options.notify !== false) ui.notifications.error(t('origin-vault.actors.importFailed'));
            return { success: false, imported: 0, error };
        }
    };

    /**
     * 异步执行角色导入（后台任务）
     */
    cls.prototype._doActorImportAsync = async function (pack, index, folderId, folderName, label, totalCount, options = {}) {
        if (this._actorPackImportActive) {
            console.warn(`${MODULE_ID} | Actor import already active, skipping duplicate start for ${pack?.collection}`);
            return { success: false, imported: 0, busy: true };
        }

        this._actorPackImportActive = true;

        try {
            let importCount = 0;
            const { MainWindow } = await import('../MainWindow.js');

            for (const entry of index) {
                const imgPath = entry.img || 'icons/svg/mystery-man.svg';
                const compendiumUuid = `Compendium.${pack.collection}.${entry._id}`;

                const actorMeta = getActorPreviewMeta({
                    displayName: entry.name,
                    path: imgPath,
                    metadata: {
                        actorType: entry.type || 'npc',
                        systemData: entry.system || {},
                        systemId: game.system?.id || ''
                    }
                });

                await this.library.addItem(imgPath, folderId, {
                    displayName: entry.name,
                    metadata: {
                        type: 'actor',
                        uuid: compendiumUuid,
                        compendiumId: pack.collection,
                        actorType: entry.type || 'npc',
                        actorRace: actorMeta.race || '',
                        actorCr: actorMeta.cr || '',
                        systemId: game.system?.id || ''
                    }
                });

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
            this._actorPackImportPending = false;
            this._actorPackImportActive = false;
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
                ui.notifications.info(tf('origin-vault.actors.importSuccess', {
                    count: importCount,
                    pack: folderName
                }));
            }

            return { success: true, imported: importCount, total: totalCount, folderId };

        } catch (error) {
            console.error(`${MODULE_ID} | Actor batch import failed:`, error);
            this._backgroundTask = null;
            this._actorPackImportPending = false;
            this._actorPackImportActive = false;
            this._setFolderImporting(folderId, false);
            this._syncCompendiumBatchControls?.();
            if (!options.fromBatch) this._hideBottomProgressBar();

            const floater = ImportFloater.getInstance();
            if (!options.fromBatch && floater.isVisible()) {
                floater.hide();
            }

            if (options.notify !== false) ui.notifications.error(t('origin-vault.actors.importFailed'));
            return { success: false, imported: 0, error, folderId };
        }
    };

    /**
     * 打开原生 Actor Sheet
     * 这里只负责把原生 sheet 打开，层级交给当前的窗口栈自己处理。
     * 
     * @param {string} actorUuid - 角色的 UUID（可以是 World 或 Compendium UUID）
     */
    cls.prototype._openNativeActorSheet = async function (actorUuid) {
        // 这里保持最朴素：找到文档，然后交给 Foundry 自己打开 sheet。
        try {
            const doc = await fromUuid(actorUuid);
            if (!doc) {
                ui.notifications.warn(ovText('Actor not found', 'Персонаж не найден'));
                return;
            }

            doc.sheet.render(true);
        } catch (err) {
            console.error(`${MODULE_ID} | Failed to open actor sheet:`, err);
            ui.notifications.error(`Failed to open actor sheet: ${err.message}`);
        }
    };

    /**
     * 从世界中删除角色
     * 
     * @param {string} worldActorId - 世界中的角色 ID
     */
    cls.prototype._deleteWorldActor = async function (worldActorId) {
        const actor = game.actors?.get(worldActorId);
        if (!actor) return;

        const confirmed = await Dialog.confirm({
            title: t('origin-vault.actors.deleteConfirmTitle'),
            content: `<p>${tf('origin-vault.actors.deleteConfirmContent', { name: actor.name })}</p>`,
        });

        if (!confirmed) return;

        try {
            await actor.delete();
            ui.notifications.info(tf('origin-vault.actors.deleteSuccess', { name: actor.name }));
            this._renderDetailsPanel();
        } catch (err) {
            console.error(`${MODULE_ID} | Failed to delete actor:`, err);
            ui.notifications.error(`Failed to delete actor: ${err.message}`);
        }
    };

    /**
     * 导入单个角色（从 Compendium 到世界）
     * 
     * @param {string} packId - Pack collection ID
     * @param {string} actorId - Pack 内的角色 ID
     */
    cls.prototype._importSingleActor = async function (packId, actorId) {
        try {
            const pack = game.packs.get(packId);
            if (!pack) throw new Error(`Pack not found: ${packId}`);

            const doc = await pack.getDocument(actorId);
            const actorObj = doc.toObject();
            const compendiumUuid = `Compendium.${pack.collection}.${actorId}`;
            actorObj._stats = actorObj._stats || {};
            actorObj._stats.compendiumSource = compendiumUuid;

            const created = await Actor.implementation.create(actorObj);
            this._syncImportStateForWorldDocument?.('actor', 'create', {
                _stats: { compendiumSource: compendiumUuid },
                flags: { core: { sourceId: compendiumUuid } },
                id: created.id,
                uuid: created.uuid
            });

            ui.notifications.info(tf('origin-vault.actors.importActorSuccess', {
                name: created.name
            }));

            // 刷新详情面板（更新导入状态）
            this._renderDetailsPanel();
        } catch (err) {
            console.error(`${MODULE_ID} | Failed to import actor:`, err);
            ui.notifications.error(`Import failed: ${err.message}`);
        }
    };

    /**
     * 激活角色浏览器的事件监听器
     * 在 _renderDetailsPanel 之后调用
     * 
     * @param {jQuery} panelEl - 详情面板的 jQuery 元素
     */
    cls.prototype._activateActorBrowserListeners = function (panelEl) {
        bindCompendiumPackGroupToggles(panelEl, this, { stateKey: '_actorPackGroupState' });

        // 关闭角色浏览器
        panelEl.find('.btn-close-actor-browser').off('click').on('click', () => {
            this._toggleActorBrowser();
        });

        // 批量导入 Pack
        panelEl.find('.actor-pack-item .btn-import-actor-pack').off('click').on('click', async (event) => {
            event.stopPropagation();
            const packId = $(event.currentTarget).data('pack-id');
            if (packId) {
                await this._importPackActors(packId);
            }
        });
    };

    /**
     * 激活角色详情面板的事件监听器
     * 处理导入、打开 Sheet、删除等按钮
     * 
     * @param {jQuery} panelEl - 详情面板的 jQuery 元素
     */
    cls.prototype._activateActorDetailListeners = function (panelEl) {
        // 浏览角色卡（打开 Compendium 角色，只读）
        panelEl.find('.btn-browse-actor-sheet').on('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const uuid = $(event.currentTarget).data('actor-uuid');
            if (uuid) {
                setTimeout(() => this._openNativeActorSheet(uuid), 50);
            }
        });

        // 导入到世界
        panelEl.find('.btn-import-actor-to-world').on('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            const uuid = $(event.currentTarget).data('actor-uuid');
            if (uuid) {
                await this._importActorToWorld(uuid);
            }
        });

        // 打开世界角色（可编辑，关闭后同步）
        panelEl.find('.btn-open-world-actor').on('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const uuid = $(event.currentTarget).data('actor-uuid');
            if (uuid) {
                setTimeout(() => this._openWorldActorWithSync(uuid), 50);
            }
        });

        // 删除世界角色
        panelEl.find('.btn-delete-actor').on('click', async (event) => {
            const worldId = $(event.currentTarget).data('actor-world-id');
            if (worldId) {
                await this._deleteWorldActor(worldId);
            }
        });
    };

    /**
     * 导入角色到世界
     * 在 Foundry 的 Actors 中创建 OV 根文件夹和以 OV 文件夹名命名的子文件夹
     * 
     * @param {string} compendiumUuid - Compendium 角色的 UUID
     */
    cls.prototype._importActorToWorld = async function (compendiumUuid) {
        try {
            const doc = await fromUuid(compendiumUuid);
            if (!doc) {
                ui.notifications.warn(ovText('Actor not found', 'Персонаж не найден'));
                return;
            }

            // 1. 确定子文件夹名 = 当前 OV 文件夹名
            let subFolderName = null;
            if (this.currentFolderId && this.currentFolderId !== 'root' && this.currentFolderId !== '__all__') {
                const currentFolder = this.library.getFolder(this.currentFolderId);
                subFolderName = currentFolder?.name || null;
            }
            // 如果在"全部素材"或根目录，取该角色所属的第一个文件夹名
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
            let ovFolder = game.folders.find(f => f.name === 'OV' && f.type === 'Actor' && !f.folder);
            if (!ovFolder) {
                ovFolder = await Folder.create({ name: 'OV', type: 'Actor' });
            }

            // 3. 创建/获取子文件夹
            let subFolder = game.folders.find(f =>
                f.name === subFolderName && f.type === 'Actor' && f.folder?.id === ovFolder.id
            );
            if (!subFolder) {
                subFolder = await Folder.create({
                    name: subFolderName,
                    type: 'Actor',
                    folder: ovFolder.id
                });
            }

            // 4. 导入角色到世界
            const actorObj = doc.toObject();
            actorObj._stats = actorObj._stats || {};
            actorObj._stats.compendiumSource = compendiumUuid;
            actorObj.folder = subFolder.id;

            const created = await Actor.implementation.create(actorObj);
            this._syncImportStateForWorldDocument?.('actor', 'create', {
                _stats: { compendiumSource: compendiumUuid },
                flags: { core: { sourceId: compendiumUuid } },
                id: created.id,
                uuid: created.uuid
            });

            ui.notifications.info(tf('origin-vault.actors.importActorSuccess', {
                name: created.name
            }));

            const previewUuid = this.previewItem?.uuid || this.previewItem?.metadata?.uuid;
            if (previewUuid && previewUuid === compendiumUuid) {
                this.previewItem.isActorImported = true;
                this.previewItem.worldActorUuid = created.uuid;
                this.previewItem.isImported = true;
                this.previewItem.worldId = created.id;
            }

            // 5. 刷新详情面板（按钮从"导入到世界"变为"编辑角色"）
            this._renderDetailsPanel();
        } catch (err) {
            console.error(`${MODULE_ID} | Failed to import actor to world:`, err);
            ui.notifications.error(`Import failed: ${err.message}`);
        }
    };

    /**
     * 打开世界角色（可编辑），关闭后同步回 OV
     * 
     * @param {string} worldActorUuid - 世界角色的 UUID
     */
    cls.prototype._openWorldActorWithSync = async function (worldActorUuid) {
        try {
            const doc = await fromUuid(worldActorUuid);
            if (!doc) {
                ui.notifications.warn(ovText('Actor not found', 'Персонаж не найден'));
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
            console.error(`${MODULE_ID} | Failed to open world actor:`, err);
            ui.notifications.error(`Failed to open actor: ${err.message}`);
        }
    };

}
