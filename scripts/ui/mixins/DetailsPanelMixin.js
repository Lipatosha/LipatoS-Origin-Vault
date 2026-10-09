import { ovText } from '../../utils/locale.js';
/**
 * DetailsPanelMixin - 右侧详情面板
 * 从 MainWindow 提取的详情面板渲染与事件绑定方法
 * 
 * 包含：详情面板渲染、防抖调度、右侧面板事件监听
 * 混入后通过 this 访问 MainWindow 实例状态
 */

import { MODULE_ID, MODULE_TITLE, SPECIAL_FOLDERS, FILE_TYPES, ASSET_TYPES } from '../../constants.js';
import { QuickLook } from '../QuickLook.js';
import { t, tf, hasTranslation } from '../../utils/i18n.js';
import { ovLog } from '../../utils/logger.js';
import { setWorldSceneBinding } from '../../utils/worldSceneBindings.js';
import { getActorPreviewMeta } from '../../utils/actorDisplay.js';

const DEFAULT_ACTOR_IMAGE = 'icons/svg/mystery-man.svg';

function getAssetExtension(path) {
  if (typeof path !== 'string' || !path) return '';
  const cleanPath = path.split(/[?#]/)[0];
  const dotIndex = cleanPath.lastIndexOf('.');
  return dotIndex >= 0 ? cleanPath.slice(dotIndex).toLowerCase() : '';
}

function getActorImageForAsset(item) {
  const assetPath = item?.path || '';
  const assetExt = getAssetExtension(assetPath);
  if (FILE_TYPES.IMAGE.includes(assetExt)) return assetPath;

  const thumbnailPath = item?.thumbnail || '';
  const thumbnailExt = getAssetExtension(thumbnailPath);
  if (FILE_TYPES.IMAGE.includes(thumbnailExt)) return thumbnailPath;

  return DEFAULT_ACTOR_IMAGE;
}

function getFolderParentId(folder) {
  if (!folder) return null;
  if (typeof folder.folder === 'string') return folder.folder || null;
  return folder.folder?.id || null;
}

function getWorldActorAssetPath(actor) {
  const worldId = game.world?.id || 'world';
  const actorId = actor?.id || foundry.utils.randomID();
  return `worlds/${worldId}/actors/${actorId}.ov-actor`;
}

/**
 * 将方法混入目标类
 * @param {Function} cls - 目标类 (MainWindow)
 */
export function applyDetailsPanelMixin(cls) {
  cls.prototype._escapeDialogHtml = function (value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  };

  cls.prototype._syncCreatedSceneBackground = async function (scene, filePath) {
    if (!scene || !filePath) return;

    const sceneSource = scene.toObject ? scene.toObject() : foundry.utils.deepClone(scene._source || {});
    const updates = {};
    const canWriteSceneImage = ('img' in sceneSource) || (typeof scene.img === 'string');
    let sceneLevels = [];

    if (sceneSource?.background?.src !== filePath) {
      updates.background = foundry.utils.mergeObject(sceneSource.background || {}, { src: filePath }, { inplace: false });
    }

    if (canWriteSceneImage && (sceneSource?.img || null) !== filePath) {
      updates.img = filePath;
    }

    if (Array.isArray(sceneSource?.levels)) {
      sceneLevels = foundry.utils.deepClone(sceneSource.levels);
    } else if (Array.isArray(scene.levels)) {
      sceneLevels = scene.levels.map(level => level?.toObject ? level.toObject() : foundry.utils.deepClone(level));
    } else if (Array.isArray(scene.levels?.contents)) {
      sceneLevels = scene.levels.contents.map(level => level?.toObject ? level.toObject() : foundry.utils.deepClone(level));
    } else if (scene.levels && typeof scene.levels[Symbol.iterator] === 'function') {
      sceneLevels = Array.from(scene.levels, level => level?.toObject ? level.toObject() : foundry.utils.deepClone(level));
    }

    if (sceneLevels.length) {
      const initialLevelId = sceneSource?.initialLevel || scene.initialLevel || sceneLevels[0]?._id || sceneLevels[0]?.id || null;
      const levelIndex = sceneLevels.findIndex(level => (level?._id || level?.id) === initialLevelId);
      if (levelIndex >= 0) {
        const currentLevel = sceneLevels[levelIndex] || {};
        const nextBackground = foundry.utils.mergeObject(currentLevel.background || {}, { src: filePath }, { inplace: false });
        if (nextBackground.src !== currentLevel.background?.src) {
          sceneLevels[levelIndex] = foundry.utils.mergeObject(currentLevel, { background: nextBackground }, { inplace: false });
          updates.levels = sceneLevels;
        }
      }
    }

    if (!Object.keys(updates).length) return;
    await scene.update(updates);
  };

  cls.prototype._getAvailableActorTypes = function () {
    const declaredTypes = [
      ...(Array.isArray(game.system?.documentTypes?.Actor) ? game.system.documentTypes.Actor : []),
      ...(Array.isArray(game.documentTypes?.Actor) ? game.documentTypes.Actor : []),
      ...Object.keys(CONFIG.Actor?.typeLabels || {}),
      ...Object.keys(CONFIG.Actor?.dataModels || {})
    ].filter(Boolean);

    const actorTypes = [...new Set(declaredTypes)];
    if (actorTypes.length) return actorTypes;

    const fallbackType = game.actors?.find(actor => actor?.type)?.type || 'npc';
    return [fallbackType];
  };

  cls.prototype._resolveDefaultActorType = function () {
    const actorTypes = this._getAvailableActorTypes();
    if (actorTypes.length) {
      return ['npc', 'character', 'pc'].find(type => actorTypes.includes(type)) || actorTypes[0];
    }

    return game.actors?.find(actor => actor?.type)?.type || 'npc';
  };

  cls.prototype._getActorTypeLabel = function (actorType) {
    if (!actorType) return '';

    const typeKey = `TYPES.Actor.${actorType}`;
    if (hasTranslation(typeKey)) {
      return t(typeKey);
    }

    const configuredLabel = CONFIG.Actor?.typeLabels?.[actorType];
    if (typeof configuredLabel === 'string') {
      return hasTranslation(configuredLabel, false) ? t(configuredLabel) : configuredLabel;
    }

    return actorType.charAt(0).toUpperCase() + actorType.slice(1);
  };

  cls.prototype._isUsableAssetFolderId = function (folderId, { allowRoot = true } = {}) {
    const id = String(folderId || '');
    if (!id) return false;
    if (id === SPECIAL_FOLDERS.ROOT) return allowRoot;
    if ([SPECIAL_FOLDERS.ALL, SPECIAL_FOLDERS.FAVORITES, SPECIAL_FOLDERS.RECENT, SPECIAL_FOLDERS.UNCATEGORIZED].includes(id)) return false;
    if (id.startsWith('__') || this.library?.isSmartFolderId?.(id)) return false;
    return !!this.library?.getFolder?.(id);
  };

  cls.prototype._resolveAssetCollectionTargetFolderId = function (item, preferredFolderId = null) {
    const candidates = [
      preferredFolderId,
      this._resolveAssetCollectionFolderId?.(item),
      ...(Array.isArray(item?.folders) ? item.folders : []),
      this.currentFolderId
    ];

    for (const folderId of candidates) {
      if (this._isUsableAssetFolderId(folderId, { allowRoot: true })) return folderId;
    }

    return SPECIAL_FOLDERS.ROOT;
  };

  cls.prototype._getWorldDocumentSubfolderName = function (item, targetFolderId) {
    if (this._isUsableAssetFolderId(targetFolderId, { allowRoot: false })) {
      return this.library.getFolder(targetFolderId)?.name || ovText('Uncategorized', 'Без категории');
    }

    const sourceFolderId = (Array.isArray(item?.folders) ? item.folders : [])
      .find(folderId => this._isUsableAssetFolderId(folderId, { allowRoot: false }));
    if (sourceFolderId) return this.library.getFolder(sourceFolderId)?.name || ovText('Uncategorized', 'Без категории');

    return ovText('Uncategorized', 'Без категории');
  };

  cls.prototype._ensureOvWorldDocumentFolder = async function (documentType, subFolderName) {
    const folderName = String(subFolderName || '').trim() || ovText('Uncategorized', 'Без категории');
    let ovFolder = game.folders.find(folder =>
      folder.name === 'OV' && folder.type === documentType && !getFolderParentId(folder)
    );
    if (!ovFolder) {
      ovFolder = await Folder.create({ name: 'OV', type: documentType });
    }

    let subFolder = game.folders.find(folder =>
      folder.name === folderName && folder.type === documentType && getFolderParentId(folder) === ovFolder.id
    );
    if (!subFolder) {
      subFolder = await Folder.create({ name: folderName, type: documentType, folder: ovFolder.id });
    }

    return subFolder;
  };

  cls.prototype._collectWorldActor = async function (actor, sourceItem, targetFolderId = null) {
    if (!actor) return null;

    const folderId = this._resolveAssetCollectionTargetFolderId(sourceItem, targetFolderId);
    const actorImage = actor.img || getActorImageForAsset(sourceItem);
    const actorMeta = getActorPreviewMeta({
      displayName: actor.name,
      path: actorImage,
      metadata: {
        actorType: actor.type || 'npc',
        systemId: game.system?.id || ''
      }
    }, actor);

    const metadata = {
      type: 'actor',
      uuid: actor.uuid,
      worldActorId: actor.id,
      worldActorUuid: actor.uuid,
      actorType: actor.type || actorMeta.actorType || 'npc',
      actorRace: actorMeta.race || '',
      actorCr: actorMeta.cr || '',
      systemId: game.system?.id || ''
    };

    const itemId = await this.library.addItem(getWorldActorAssetPath(actor), folderId, {
      displayName: actor.name,
      metadata
    });
    if (!itemId) return null;

    const collectedItem = this.library.getItem(itemId);
    if (collectedItem) {
      await this.library.updateItem(itemId, {
        thumbnail: actorImage,
        thumbnailGenerated: !!actorImage,
        thumbnailVersion: collectedItem.thumbnailVersion || 1,
        metadata: { ...(collectedItem.metadata || {}), ...metadata }
      });
    }

    await this._renderSidebar?.();
    await this._renderAssetGrid?.();
    this._scheduleDetailsPanelRender?.();
    return itemId;
  };

  cls.prototype._promptActorCreationOptions = async function (item) {
    if (!item?.path) return null;

    const suggestedName = (item.displayName || item.path.split('/').pop() || ovText('New Actor', 'Новый персонаж')).replace(/\.[^/.]+$/, '');
    const actorTypes = this._getAvailableActorTypes();
    const defaultType = this._resolveDefaultActorType();
    const escapedName = this._escapeDialogHtml(suggestedName);
    const typeOptions = actorTypes.map(type => {
      const selected = type === defaultType ? ' selected' : '';
      const value = this._escapeDialogHtml(type);
      const label = this._escapeDialogHtml(this._getActorTypeLabel(type));
      return `<option value="${value}"${selected}>${label}</option>`;
    }).join('');

    const content = `
      <form class="ov-create-actor-dialog">
        <p>${t('origin-vault.actors.createActorConfirmContent')}</p>
        <div class="form-group">
          <label>${t('origin-vault.actors.createActorNameLabel')}</label>
          <input type="text" name="actor-name" value="${escapedName}" autofocus />
        </div>
        <div class="form-group">
          <label>${t('origin-vault.actors.createActorTypeLabel')}</label>
          <select name="actor-type">${typeOptions}</select>
        </div>
      </form>
    `;

    return await foundry.applications.api.DialogV2.wait({
      window: { title: t('origin-vault.actors.createActorConfirmTitle') },
      content,
      modal: true,
      rejectClose: false,
      buttons: [{
        action: 'create',
        icon: 'fas fa-user-plus',
        label: t('origin-vault.actors.createActorConfirm'),
        default: true,
        callback: (event, button) => {
          const form = button.form;
          const nameInput = form?.querySelector?.('[name="actor-name"]');
          const typeSelect = form?.querySelector?.('[name="actor-type"]');
          const actorName = String(nameInput?.value || '').trim() || suggestedName;
          const actorType = typeSelect?.value || defaultType;
          return { actorName, actorType };
        }
      }, {
        action: 'cancel',
        icon: 'fas fa-times',
        label: t('origin-vault.actors.createActorCancel')
      }]
    });
  };

  cls.prototype._createActorFromAsset = async function (item, { actorName = null, actorType = null } = {}) {
    if (!item?.path) return null;

    const filePath = item.path;
    const resolvedActorName = String(actorName || (item.displayName || filePath.split('/').pop() || ovText('New Actor', 'Новый персонаж'))).replace(/\.[^/.]+$/, '');
    const resolvedActorType = actorType || this._resolveDefaultActorType();
    const targetFolderId = this._resolveAssetCollectionTargetFolderId(item, this._resolveAssetCollectionFolderId?.(item));
    const worldFolder = await this._ensureOvWorldDocumentFolder('Actor', this._getWorldDocumentSubfolderName(item, targetFolderId));
    const actorData = {
      name: resolvedActorName,
      img: getActorImageForAsset(item),
      folder: worldFolder?.id || null,
      prototypeToken: {
        name: resolvedActorName,
        texture: { src: filePath }
      }
    };

    if (resolvedActorType) {
      actorData.type = resolvedActorType;
    }

    const actor = await Actor.implementation.create(actorData);
    if (!actor) return null;

    await this._collectWorldActor(actor, item, targetFolderId);
    this._syncImportStateForWorldDocument?.('actor', 'create', actor);

    actor.sheet?.render(true);
    ui.notifications.info(tf('origin-vault.actors.createActorSuccess', { name: actor.name }));
    return actor;
  };

  /**
   * 防抖渲染详情面板
   * 将同一帧内的多次调用合并为一次执行
   */
  cls.prototype._scheduleDetailsPanelRender = function () {
    if (this._detailsPanelRenderScheduled) return;
    this._detailsPanelRenderScheduled = true;
    requestAnimationFrame(() => {
      this._detailsPanelRenderScheduled = false;
      this._renderDetailsPanel();
    });
  };

  cls.prototype._teardownActorDescriptionLayout = function () {
    if (this._actorDescriptionResizeObserver) {
      this._actorDescriptionResizeObserver.disconnect();
      this._actorDescriptionResizeObserver = null;
    }

    this._actorDescriptionResizeFrame = null;
  };

  cls.prototype._measureActorDetailFooterHeight = function (descriptionEl, contentEl) {
    if (!descriptionEl || !contentEl) return 0;

    const actorActionsEl = descriptionEl.closest('.actor-actions');
    const footerEls = [
      actorActionsEl?.querySelector('.actor-detail-buttons'),
      contentEl.querySelector('.details-form > .tags-group'),
      contentEl.querySelector('.details-form > .folder-group'),
      contentEl.querySelector('.details-form > .basic-info')
    ].filter(el => el && el.getClientRects().length);

    if (!footerEls.length) return 0;

    const descriptionBottom = descriptionEl.getBoundingClientRect().bottom;
    const footerBottom = footerEls.reduce((bottom, el) => {
      return Math.max(bottom, el.getBoundingClientRect().bottom);
    }, descriptionBottom);

    return Math.max(0, footerBottom - descriptionBottom);
  };

  cls.prototype._syncActorDescriptionHeight = function (panelEl) {
    const panel = panelEl?.nodeType === 1 ? panelEl : panelEl?.[0];
    const descriptionEl = panel?.querySelector?.('.actor-description');
    const contentEl = panel?.querySelector?.('.details-content--actor');

    if (!panel || !descriptionEl || !contentEl) {
      this._teardownActorDescriptionLayout();
      return;
    }

    const applyHeight = () => {
      if (!panel.isConnected || !descriptionEl.isConnected) return;

      const panelRect = panel.getBoundingClientRect();
      const descriptionRect = descriptionEl.getBoundingClientRect();
      if (panelRect.height <= 0 || descriptionRect.height <= 0) return;

      const contentStyle = getComputedStyle(contentEl);
      const bottomPadding = Number.parseFloat(contentStyle.paddingBottom) || 0;
      const bottomInset = 12;
      const footerHeight = this._measureActorDetailFooterHeight(descriptionEl, contentEl);
      const availableHeight = panelRect.bottom - descriptionRect.top - footerHeight - bottomPadding - bottomInset;
      const readableMinimum = Math.min(220, Math.max(140, panelRect.height * 0.22));
      const safeAvailable = Math.max(120, availableHeight);
      const lowerBound = availableHeight >= readableMinimum ? readableMinimum : safeAvailable;
      const nextHeight = Math.max(lowerBound, Math.min(safeAvailable, 520));

      if (!Number.isFinite(nextHeight) || nextHeight <= 0) return;

      const roundedHeight = `${Math.round(nextHeight)}px`;
      if (descriptionEl.style.getPropertyValue('--ov-actor-description-max-height') !== roundedHeight) {
        descriptionEl.style.setProperty('--ov-actor-description-max-height', roundedHeight);
      }
    };

    const scheduleApplyHeight = () => {
      if (this._actorDescriptionResizeFrame) return;
      this._actorDescriptionResizeFrame = requestAnimationFrame(() => {
        this._actorDescriptionResizeFrame = null;
        applyHeight();
      });
    };

    this._teardownActorDescriptionLayout();
    scheduleApplyHeight();

    if (typeof ResizeObserver === 'function') {
      this._actorDescriptionResizeObserver = new ResizeObserver(scheduleApplyHeight);
      this._actorDescriptionResizeObserver.observe(panel);
      this._actorDescriptionResizeObserver.observe(contentEl);
    }
  };

  /**
   * 仅渲染右侧详情面板
   * 用于：选中素材变化、切换详情/文件浏览器
   */
  cls.prototype._renderDetailsPanel = async function (cachedData = null) {
    if (!this.element) {
      this._teardownActorDescriptionLayout();
      return;
    }

    // Save FileBrowser state before re-render
    if (this.browserVisible && this.fileBrowser) {
      const browserFilesEl = this.element.querySelector('.browser-files');
      this.fileBrowserState = {
        currentPath: this.fileBrowser.currentPath,
        history: this.fileBrowser.history,
        historyIndex: this.fileBrowser.historyIndex,
        viewMode: this.fileBrowser.viewMode,
        gridSize: this.fileBrowser.gridSize,
        scrollTop: browserFilesEl ? browserFilesEl.scrollTop : 0,
        source: this.fileBrowser.source,
        bucket: this.fileBrowser.bucket
      };
    }

    const data = cachedData || await this._prepareContext();
    const panelContent = await this._compileDetailsPanelPartial(data);
    const isActorDetailPanel = !this.browserVisible
      && !this.sceneBrowserVisible
      && !this.itemBrowserVisible
      && !this.actorBrowserVisible
      && data.selectedDetail?.type === 'actor';

    const rightPanelEl = $(this.element).find('#ov-right-panel');
    if (rightPanelEl.length) {
      // 更新面板类名
      const panelModeClass = this.browserVisible ? 'browser-panel' : 'details-panel';
      const actorPanelClass = isActorDetailPanel ? ' details-panel--actor' : '';
      rightPanelEl.attr('class', `${panelModeClass}${actorPanelClass} right-panel`);
      rightPanelEl.html(panelContent);
      this._activateRightPanelListeners(rightPanelEl);
      this._activateCompendiumBatchListeners?.(rightPanelEl);

      // 如果显示文件浏览器，重新初始化
      if (this.browserVisible) {
        const browserContent = rightPanelEl.find('.browser-content')[0];
        if (browserContent) {
          this._initFileBrowser(browserContent);
        }
      }

      // 如果选中的是场景类型，初始化场景渲染器
      if (data.selectedDetail?.type === 'scene') {
        await this._initSceneRenderer(rightPanelEl, data.selectedDetail);
      }

      // 如果选中的是音频类型，绘制详情波形
      const audioPlayer = rightPanelEl.find('.audio-details-player')[0];
      if (audioPlayer) {
        this._drawDetailsWaveform();
      }

      // 激活物品浏览器事件
      if (this.itemBrowserVisible) {
        this._activateItemBrowserListeners?.(rightPanelEl);
      }

      // 激活角色浏览器事件
      if (this.actorBrowserVisible) {
        this._activateActorBrowserListeners?.(rightPanelEl);
      }

      // 激活物品详情按钮事件
      if (data.selectedDetail?.type === 'item') {
        this._activateItemDetailListeners(rightPanelEl);
      }

      // 激活角色详情按钮事件
      if (isActorDetailPanel) {
        this._activateActorDetailListeners(rightPanelEl);
        this._syncActorDescriptionHeight(rightPanelEl[0]);
      } else {
        this._teardownActorDescriptionLayout();
      }
    } else {
      this._teardownActorDescriptionLayout();
    }

    // Update picker confirm button state if in file picker mode
    this._updatePickerConfirmState();
  };

  /**
   * 从详情面板导入或重新导入场景。
   * 这里只处理两类可追溯来源：
   * 1. Compendium UUID
   * 2. .ov-scene 文件
   */
  cls.prototype._importSceneFromDetailsItem = async function (itemId, item) {
    const itemType = item?.type || item?.metadata?.type;
    const itemUuid = item?.uuid || item?.metadata?.uuid;

    ovLog(`${MODULE_ID} | Attempting import. ItemId: ${itemId}, ItemType: ${itemType}, UUID: ${itemUuid}`, item);

    const isSceneType = itemType === ASSET_TYPES.SCENE || itemType === 'scene';
    const isOvSceneFile = item && (
      (item.fileFormat && item.fileFormat.toUpperCase() === 'OV-SCENE') ||
      (item.name && item.name.toLowerCase().endsWith('.ov-scene')) ||
      (item.path && item.path.toLowerCase().endsWith('.ov-scene'))
    );

    if (!(isSceneType || isOvSceneFile)) {
      console.warn(`${MODULE_ID} | Import conditions not met. Item: ${!!item}, Type: ${itemType}, IsOvScene: ${isOvSceneFile}`);
      if (!item) ui.notifications.warn(t('origin-vault.notifications.sceneDataNotFound'));
      return false;
    }

    const reimportUnavailableMessage = t('origin-vault.scenes.reimportUnavailable');
    const normalizedScenePath = typeof item?.path === 'string'
      ? item.path.replace(/\\/g, '/').toLowerCase()
      : '';
    const isWorldManagedSceneFile = normalizedScenePath.startsWith('worlds/scenes/')
      && normalizedScenePath.endsWith('.ov-scene');

    let importSource = null;
    if (isSceneType && itemUuid) {
      const doc = await fromUuid(itemUuid).catch((error) => {
        console.warn(`${MODULE_ID} | Scene source missing for UUID: ${itemUuid}`, error);
        return null;
      });

      if (!doc) {
        ui.notifications.warn(reimportUnavailableMessage);
        return false;
      }

      const sceneData = doc.toObject();
      sceneData._stats = sceneData._stats || {};
      sceneData._stats.compendiumSource = itemUuid;
      importSource = { kind: 'uuid', sceneData };
    } else if (isOvSceneFile) {
      if (isWorldManagedSceneFile) {
        ui.notifications.warn(reimportUnavailableMessage);
        return false;
      }

      try {
        const response = await fetch(item.path);
        if (!response.ok) {
          console.warn(`${MODULE_ID} | Scene source file is unavailable: ${item.path} (${response.status})`);
          ui.notifications.warn(reimportUnavailableMessage);
          return false;
        }

        const sceneData = await response.json();
        delete sceneData._id;
        sceneData.name = sceneData.name || (item.name || '').replace('.ov-scene', '');
        sceneData._stats = sceneData._stats || {};
        sceneData._stats.compendiumSource = item.path;
        importSource = { kind: 'file', sceneData };
      } catch (error) {
        console.warn(`${MODULE_ID} | Failed to read .ov-scene source: ${item.path}`, error);
        ui.notifications.warn(reimportUnavailableMessage);
        return false;
      }
    } else {
      ui.notifications.warn(reimportUnavailableMessage);
      return false;
    }

    const currentImportState = typeof this._resolveImportState === 'function'
      ? this._resolveImportState(item, { type: 'scene', uuid: itemUuid || item?.uuid || item?.metadata?.uuid || null })
      : null;

    if (currentImportState?.imported && currentImportState.worldDoc) {
      const oldScene = currentImportState.worldDoc;
      ovLog(`${MODULE_ID} | Overwrite import: deleting old scene ${oldScene.name} (ID: ${oldScene.id})`);
      await oldScene.delete();
      item.isImported = false;
      item.worldId = null;
    }

    if (importSource.kind === 'file' && !itemUuid) {
      item.uuid = item.path;
      await this.library.updateItem(itemId, { uuid: item.path });
    }

    const importedScene = await Scene.create(importSource.sceneData);
    ovLog(`${MODULE_ID} | Scene imported from ${importSource.kind}: ${importSource.kind === 'uuid' ? itemUuid : item.path}`);

    if (!importedScene) {
      console.warn(`${MODULE_ID} | Import returned false/null`);
      return false;
    }

    ui.notifications.info(tf('origin-vault.scenes.importSuccess', { count: 1, folder: 'Scenes' }));

    item.isImported = true;
    item.worldId = importedScene.id;
    if (!item.type) item.type = ASSET_TYPES.SCENE;

    if (!item.metadata) item.metadata = {};
    if (item.id) {
      if (isWorldManagedSceneFile) {
        setWorldSceneBinding(item, importedScene, {
          source: 'world-scene-import',
          backgroundSrc: importedScene.background?.src || item.metadata?.backgroundSrc || ''
        });
      } else {
        delete item.metadata.worldSceneId;
        if (!item.metadata.worldSceneBindings || Object.keys(item.metadata.worldSceneBindings).length === 0) {
          delete item.metadata.worldSceneOrigin;
        }
      }
      this.library._saveAssetMetadata?.(item.id, item);
    }

    if (this.previewItem && this.previewItem.id === item.id) {
      this.previewItem = item;
    }

    if (typeof this._refreshVisibleImportState === 'function') {
      this._refreshVisibleImportState('scene');
    } else if (typeof this._updateAssetCardImportBadge === 'function') {
      this._updateAssetCardImportBadge(item.id, { sceneImported: true });
    }

    this._renderDetailsPanel();
    return true;
  };

  cls.prototype._activateRightPanelListeners = function (panel) {
    // 详情输入变更 (支持多选批量)
    panel.find('.details-input').on('change', async (event) => {
      const $input = $(event.currentTarget);
      const field = $input.data('field');
      const value = $input.val();
      if (!field) return;

      // 多选：批量应用到所有选中项
      if (this.selectedItems.size > 1) {
        for (const itemId of this.selectedItems) {
          await this.library.updateItem(itemId, { [field]: value });
        }
        // displayName 变更：立即更新所有选中卡片的名称
        if (field === 'displayName') {
          for (const itemId of this.selectedItems) {
            const card = $(this.element).find(`.asset-card[data-item-id="${itemId}"]`);
            if (card.length) {
              card.find('.asset-name').text(value).attr('title', value);
            }
          }
        }
        this._renderDetailsPanel();
        return;
      }

      const itemId = $input.closest('.details-section').data('itemId') ||
        this.selectedItems.values().next().value;
      if (itemId) {
        await this.library.updateItem(itemId, { [field]: value });

        if (field === 'displayName') {
          const card = $(this.element).find(`.asset-card[data-item-id="${itemId}"]`);
          if (card.length) {
            card.find('.asset-name').text(value).attr('title', value);
          }
        }
        this._renderDetailsPanel();
      }
    });

    // 关闭详情面板
    panel.find('.btn-close-details').on('click', () => {
      this.selectedItems.clear();
      this._renderDetailsPanel();
    });

    // 添加标签 (即时生效，支持多选批量)
    panel.find('.btn-add-tag').on('click', async () => {
      if (this.selectedItems.size === 0) return;

      // 计算所有选中项标签的交集 (只显示每个文件都有的标签)
      const firstId = this.selectedItems.values().next().value;
      const allItemTags = [...this.selectedItems].map(id => {
        const item = this.library.getItem(id);
        return new Set(item?.tags || []);
      });
      const currentTags = allItemTags.length > 0
        ? [...allItemTags[0]].filter(tagId => allItemTags.every(s => s.has(tagId)))
        : [];

      // 对话框内即时生效，关闭后只需刷新面板
      await this._showTagPickerDialog(firstId, currentTags, this.selectedItems);
      this._renderDetailsPanel();
    });

    // 评分点击 (支持多选批量)
    panel.find('.stars i').on('click', async (event) => {
      const rating = parseInt(event.currentTarget.dataset.rating);
      if (!rating) return;

      // 判断新评分（基于第一个选中项的当前评分）
      const firstId = this.selectedItems.values().next().value;
      const currentRating = this.library.getItem(firstId)?.rating || 0;
      const newRating = (currentRating === rating) ? 0 : rating;

      // 对所有选中项应用评分
      for (const itemId of this.selectedItems) {
        await this.library.updateItem(itemId, { rating: newRating });
      }
      this._renderDetailsPanel();
    });

    // 移除标签 (支持多选批量)
    panel.find('.btn-remove-tag').on('click', async (event) => {
      event.stopPropagation();
      const tagEl = event.currentTarget.closest('.detail-tag');
      const tagId = String(tagEl?.dataset?.tagId || '');
      if (!tagId) return;

      // 对所有选中项移除该标签
      for (const itemId of this.selectedItems) {
        await this.library.removeTagFromItem(itemId, tagId);
      }
      this._renderDetailsPanel();
    });

    // 移出文件夹 (支持多选批量)
    panel.find('.btn-remove-from-folder').on('click', async (event) => {
      event.stopPropagation();
      const folderEl = event.currentTarget.closest('.folder-badge');
      const folderId = folderEl?.dataset?.folderId;
      if (!folderId) return;

      // 对所有选中项从该文件夹中移除
      for (const itemId of this.selectedItems) {
        await this._onRemoveItemFromFolder(itemId, folderId);
      }
    });

    // 点击文件夹标签跳转到该文件夹
    panel.find('.folder-badge').on('click', async (event) => {
      // 如果点击的是删除按钮，不触发跳转
      if ($(event.target).hasClass('btn-remove-from-folder') || $(event.target).closest('.btn-remove-from-folder').length) {
        return;
      }
      const folderId = event.currentTarget.dataset.folderId;
      if (folderId) {
        const itemId = panel.find('.details-input[data-item-id]').attr('data-item-id')
          || this.selectedItems.values().next().value
          || null;
        await this._navigateToFolder(folderId, {
          preserveSelection: !!itemId,
          selectedItemId: itemId,
          revealItemId: itemId
        });
        return;
      }
    });

    // 添加到文件夹 (支持多选批量 — _onAddToFolder 内部处理批量)
    panel.find('.btn-add-to-folder').on('click', async (event) => {
      const itemId = panel.find('.details-input[data-item-id]').attr('data-item-id') ||
        this.selectedItems.values().next().value;
      if (itemId) this._onAddToFolder(itemId);
    });

    // 加入播放清单：单选/多选统一——把选中项里的音频挑出来，弹清单选择浮层。
    // 判音频只按扩展名（音频 item 不写 metadata.type），混选也不会误伤图片。
    panel.find('.btn-add-to-playlist').on('click', () => {
      const audioItems = [...(this.selectedItems || [])]
        .map(id => this.library.getItem(id))
        .filter(it => it && FILE_TYPES.AUDIO.some(ext => (it.path || '').toLowerCase().endsWith(ext)));
      if (audioItems.length === 0) {
        ui.notifications.warn(t('origin-vault.playlist.noAudio'));
        return;
      }
      this._showPlaylistPickerDialog(audioItems);
    });

    // 导出文件
    panel.find('.btn-export-file').on('click', (event) => {
      const itemId = panel.find('.details-input[data-item-id]').data('item-id');
      // TODO: 实现单个文件导出
      ui.notifications.info(t('origin-vault.notifications.singleExportNotImplemented'));
    });

    // 场景导入
    panel.find('.btn-import-scene').on('click', async (event) => {
      event.preventDefault();
      const btn = $(event.currentTarget);
      const originalHtml = btn.html();
      btn.prop('disabled', true).html(`<i class="fas fa-spinner fa-spin"></i> ${t('origin-vault.scenes.importing')}`);

      try {
        const itemId = this.selectedItems.values().next().value;
        // 尝试从 allItems 查找
        let item = this.allItems.find(i => i.id === itemId);

        // 如果没找到，尝试从 library 找
        if (!item) {
          item = this.library.getItem(itemId);
        }

        await this._importSceneFromDetailsItem(itemId, item);
      } catch (err) {
        console.error(err);
      } finally {
        if (btn.length) { // 检查按钮是否还存在（可能面板已重绘）
          btn.prop('disabled', false).html(originalHtml);
        }
      }
    });

    // 查看场景
    panel.find('.btn-view-scene').on('click', async (event) => {
      const worldId = event.currentTarget.dataset.sceneId;
      const scene = game.scenes.get(worldId);
      if (scene) await scene.view();
    });

    // 激活场景
    panel.find('.btn-activate-scene').on('click', async (event) => {
      const worldId = event.currentTarget.dataset.sceneId;
      const scene = game.scenes.get(worldId);
      if (scene) {
        await scene.activate();
        ui.notifications.info(t('origin-vault.scenes.activateSuccess'));
      }
    });

    // 配置场景 (打开 Foundry 原生配置页)
    panel.find('.btn-configure-scene').on('click', async (event) => {
      const worldId = event.currentTarget.dataset.sceneId;
      const scene = game.scenes.get(worldId);
      if (!scene) return;
      scene.sheet.render(true);
    });

    // 从世界中删除场景
    panel.find('.btn-delete-scene').on('click', async (event) => {
      const worldId = event.currentTarget.dataset.sceneId;
      const scene = game.scenes.get(worldId);
      if (!scene) return;

      const confirmed = await this._showConfirmDialog(
        t('origin-vault.scenes.deleteFromWorld'),
        t('origin-vault.scenes.deleteConfirm'),
        true
      );
      if (confirmed) {
        await scene.delete();
        ui.notifications.info(t('origin-vault.scenes.deleteSuccess'));
        this._renderDetailsPanel(); // 刷新面板以更新状态
      }
    });



    // 关闭文件浏览器
    panel.find('.btn-close-browser').on('click', () => {
      this.browserVisible = false;
      this._renderDetailsPanel();
    });

    // 关闭场景浏览器
    panel.find('.btn-close-scene-browser').on('click', () => {
      this.sceneBrowserVisible = false;
      this._renderDetailsPanel();
    });

    // 导入整个场景合集包
    panel.find('.btn-import-pack').on('click', async (event) => {
      const packId = event.currentTarget.dataset.packId;
      if (packId) {
        await this._importPackScenes(packId);
      }
    });

    // 收录世界场景到素材库
    panel.find('.btn-collect-scene').on('click', async (event) => {
      event.stopPropagation();
      const sceneId = event.currentTarget.dataset.sceneId;
      await this._collectWorldScene(sceneId);
    });

    // 创建空白场景
    panel.find('.btn-create-blank-scene').on('click', async () => {
      const restoreUiState = this._captureSceneConfigReturnState?.() || null;
      this.constructor.hide();

      try {
        const sceneName = `New Scene ${game.scenes.size + 1}`;
        const scene = await Scene.create({
          name: sceneName,
          padding: 0.25
        });
        if (scene) {
          // 空白场景仍沿用“先收起 OV，再进 SceneConfig，收尾后恢复”的流程。
          // 这样中途即便从 SceneConfig 再次调起 OV 选文件，也不会把主窗口状态打乱。
          this._minimizeForSceneConfig(scene, {
            suspendOV: false,
            hideOV: true,
            collectOnClose: true,
            ovAlreadyHidden: true,
            restoreUiState
          });
          return;
        }

        await this._restoreSceneConfigReturnState?.(restoreUiState, { render: false });
        this.constructor.show();
      } catch (err) {
        console.error('origin-vault | Failed to create blank scene:', err);
        await this._restoreSceneConfigReturnState?.(restoreUiState, { render: false });
        this.constructor.show();
      }
    });

    // 从图片/视频创建场景
    panel.find('.btn-create-scene-from-asset').on('click', async (event) => {
      const itemId = event.currentTarget.dataset.itemId;
      const item = this.library.getItem(itemId);
      if (!item) return;

      try {
        const filePath = item.path;
        const sceneName = (item.displayName || filePath.split('/').pop()).replace(/\.[^/.]+$/, '');

        // 读取图片/视频原始尺寸
        let width = 3840, height = 2160;
        const ext = filePath.split('.').pop().toLowerCase();
        const isVideo = ['mp4', 'webm', 'ogg', 'mov'].includes(ext);

        try {
          if (isVideo) {
            const video = document.createElement('video');
            video.preload = 'metadata';
            video.src = filePath;
            await new Promise((resolve, reject) => {
              video.onloadedmetadata = resolve;
              video.onerror = reject;
              setTimeout(reject, 5000);
            });
            width = video.videoWidth || 3840;
            height = video.videoHeight || 2160;
          } else {
            const img = new Image();
            img.src = filePath;
            await new Promise((resolve, reject) => {
              img.onload = resolve;
              img.onerror = reject;
              setTimeout(reject, 5000);
            });
            width = img.naturalWidth || 3840;
            height = img.naturalHeight || 2160;
          }
        } catch (dimErr) {
          console.warn('origin-vault | Could not read asset dimensions:', dimErr);
        }

        // 创建场景并预填充背景
        const scene = await Scene.create({
          name: sceneName,
          width,
          height,
          padding: 0.25,
          img: filePath,
          background: { src: filePath }
        });
        if (scene) {
          await this._syncCreatedSceneBackground(scene, filePath);
          // 这里不再先额外隐藏 OV，直接在上层打开 SceneConfig 即可。
          this._minimizeForSceneConfig(scene, {
            suspendOV: false,
            targetFolderId: this._resolveAssetCollectionFolderId?.(item)
          });
        }
      } catch (err) {
        console.error('origin-vault | Failed to create scene from asset:', err);
      }
    });

    panel.find('.btn-create-actor-from-asset').on('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();

      const itemId = event.currentTarget.dataset.itemId;
      const item = this.library.getItem(itemId);
      if (!item) return;

      try {
        const actorOptions = await this._promptActorCreationOptions(item);
        if (!actorOptions) return;
        await this._createActorFromAsset(item, actorOptions);
      } catch (err) {
        console.error('origin-vault | Failed to create actor from asset:', err);
        ui.notifications.error(t('origin-vault.actors.createActorFailed'));
      }
    });

  };
}
