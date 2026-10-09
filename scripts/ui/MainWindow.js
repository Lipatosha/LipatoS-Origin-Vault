import { ovText } from '../utils/locale.js';
// 现有的 $() 调用还是历史债，后面继续按触达文件慢慢收。
// 这个文件已经够胖了，新逻辑优先往 mixin 里放，别再继续往主窗体里堆。
/**
 * Origin Vault - 咱们的店铺大堂 (Main Window)
 * ---------------------------------------------------
 * 嘿，欢迎光临！这里是 Origin Vault 的门面。
 * 为了让各位“上帝”（GM们）能爽快地挑素材，我特意搞了这个全屏覆盖的大展厅。
 * 左手边是我的私藏素材库，右手边是通往你硬盘深处的文件浏览器。
 * 
 * 看着挺正经？其实背地里全是胶带和胶水粘起来的。
 * 
 * Log:
 * 2026-01-01: 新店开张！代码还是热乎的（指刚从屎山上扒下来）。
 * 2026-01-15: 决定用双面板设计，虽然感觉屏幕小的用户会想打我。
 * 2026-02-01: 终于把这该死的布局对齐了。
 */

import { MODULE_ID, MODULE_TITLE, UI, SPECIAL_FOLDERS, SMART_FOLDER_PREFIX, EVENTS } from '../constants.js';
import { applyGridLayoutMixin } from './mixins/GridLayoutMixin.js';
import { applyDialogMixin } from './mixins/DialogMixin.js';
import { applyMediaPreviewMixin } from './mixins/MediaPreviewMixin.js';
import { applyVirtualScrollMixin } from './mixins/VirtualScrollMixin.js';
import { applyDragDropMixin } from './mixins/DragDropMixin.js';
import { applyContextMenuMixin } from './mixins/ContextMenuMixin.js';
import { applySidebarMixin } from './mixins/SidebarMixin.js';
// 仓库管理员，虽然偶尔会搞丢数据但大部分时候还算靠谱
import { LibraryData } from '../data/LibraryData.js';
// 业务经理，负责统筹全局，实际上也是个甩手掌柜
import { LibraryManager } from '../data/LibraryManager.js';
// 那个负责跑腿去硬盘里翻箱倒柜的伙计
import { FileBrowser } from './FileBrowser.js';
import { LibrarySelector } from './LibrarySelector.js';
// 快速预览，因为大家都没耐心慢慢点开看
import { QuickLook } from './QuickLook.js';
import { ComparisonPanel } from './comparison/ComparisonPanel.js';
// 波形图绘制员，这玩意儿费了我好大劲才不让它卡死浏览器
import { WaveformManager } from '../utils/WaveformManager.js';
// 缩略图生成器，这可是个苦力活，专门处理那些不显示图片的文件
import { ThumbnailManager } from '../utils/ThumbnailManager.js';
// 进出口贸易专员，虽然现在还只是个搬运工
import { ExportImportManager } from '../data/ExportImportManager.js';
import { FILE_TYPES, ASSET_TYPES, IS_MAD_EDITION } from '../constants.js';
import { FileSystemAdapter } from '../adapters/FileSystemAdapter.js';
import { SceneAdapter } from '../adapters/SceneAdapter.js';
import { ItemAdapter } from '../adapters/ItemAdapter.js';
import { ActorAdapter } from '../adapters/ActorAdapter.js';
import { extractSystemFieldValues, getSubTypeLabel } from '../data/SystemConfigs.js';
// 场景渲染师，为了让你们能预览场景，我头发都掉了一把
import { SceneRenderer } from './SceneRenderer.js';
import { FilterPanel } from './FilterPanel.js';
// 物品浏览器 mixin，杂货铺相关逻辑全在这里
import { applyItemBrowserMixin } from './mixins/ItemBrowserMixin.js';
// 角色浏览器 mixin，角色经纪人相关逻辑
import { applyActorBrowserMixin } from './mixins/ActorBrowserMixin.js';
// 后台导入悬浮窗，关了 OV 也能看到导入进度
import { ImportFloater } from './ImportFloater.js';
import { applySceneBrowserMixin } from './mixins/SceneBrowserMixin.js';
import { applyFilePickerMixin } from './mixins/FilePickerMixin.js';
import { applyKeyboardMixin } from './mixins/KeyboardMixin.js';
import { applyWindowMixin } from './mixins/WindowMixin.js';
import { applyPreviewMixin } from './mixins/PreviewMixin.js';
import { applyImportMixin } from './mixins/ImportMixin.js';
import { applyDetailsPanelMixin } from './mixins/DetailsPanelMixin.js';
import { applyLibraryDialogsMixin } from './mixins/LibraryDialogsMixin.js';
import { applyCompendiumBatchImportMixin } from './mixins/CompendiumBatchImportMixin.js';
import { hasTranslation, t, tf } from '../utils/i18n.js';
import { ovDebug, ovLog } from '../utils/logger.js';
import { getWorldSceneId } from '../utils/worldSceneBindings.js';
import { getActorBadgeLabel, getActorPreviewMeta } from '../utils/actorDisplay.js';
import { naturalCompare } from '../utils/sort.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;
const LARGE_LIBRARY_SUBFOLDER_THRESHOLD = 10000;
const LARGE_LIBRARY_SUBFOLDER_NOTICE_KEY = 'largeLibrarySubfolderNoticeSeen';

export class MainWindow extends HandlebarsApplicationMixin(ApplicationV2) {
  /** @type {MainWindow} */
  static #instance = null;

  /** @type {boolean} 是否可见 */
  static #isVisible = false;

  /** @type {object|null} 后台导入任务状态 */
  _backgroundTask = null;

  /**
   * 获取或创建主窗口实例
   * @returns {MainWindow}
   */
  static getInstance() {
    if (!MainWindow.#instance) {
      MainWindow.#instance = new MainWindow();
    }
    return MainWindow.#instance;
  }

  /**
   * 切换窗口显示/隐藏
   */
  static toggle() {
    if (MainWindow.#isVisible) {
      MainWindow.hide();
    } else {
      MainWindow.show();
    }
  }

  /**
   * 显示窗口
   */
  static show() {
    const instance = MainWindow.getInstance();

    instance._setWorkspaceShellSuspended?.(false);

    // Reset scroll state so grid starts at top on reopen
    instance._fallbackScrollTop = 0;
    instance._restoreScrollIndex = -1;
    instance._scrollAnchorIds = [];
    instance._resetScrollOnRender = true;
    instance._skipScrollRestore = true; // Direct flag: skip scroll restoration in _initVirtualScroll

    // 非文件选择器模式下，清除预览状态，避免上次的预览残留
    if (!instance.filePickerMode) {
      instance.previewItem = null;
    }

    instance._syncGlobalLayerManagement?.({ clearElevations: false });

    if (!instance.rendered) {
      instance.render(true);
    } else {
      // 如果窗口只是被 CSS 隐藏（场景配置过渡），恢复可见性
      if (instance.element) {
        instance.element.style.opacity = '';
        instance.element.style.pointerEvents = '';
        instance.element.style.transition = '';
      }
      instance.render({ force: true, window: { bringToTop: true } });
    }
    MainWindow.#isVisible = true;
    requestAnimationFrame(() => instance._syncWorkspaceShellState?.());

    // 如果重新打开时有后台悬浮窗，关闭它（进度回到 OV 内部显示）
    const floater = ImportFloater.getInstance();
    if (floater.isVisible()) {
      floater.hide(true);
    }

    // 如果有后台任务在跑，渲染完成后恢复底部进度条
    if (instance._backgroundTask) {
      requestAnimationFrame(() => {
        const { completed, total, label, targetFolderId } = instance._backgroundTask;
        instance._showBottomProgressBar(completed, total, label);
        instance._setFolderImporting(targetFolderId, true);
      });
    }
  }

  /**
   * 隐藏窗口
   */
  static hide() {
    const instance = MainWindow.getInstance();

    instance._syncWorkspaceShellState?.({ forceActive: false });

    // 如果有后台任务，关窗口时弹出悬浮进度窗
    if (instance._backgroundTask) {
      const floater = ImportFloater.getInstance();
      floater.show(instance._backgroundTask);
    }

    // V2 close method
    instance.close();
    MainWindow.#isVisible = false;

    // 移除 ESC 键监听器
    if (instance._boundKeyHandler) {
      document.removeEventListener('keydown', instance._boundKeyHandler, true);
      instance._boundKeyHandler = null;
    }
  }

  /**
   * 打开主窗口（兼容旧 API）
   */
  static open() {
    MainWindow.show();
  }

  /**
   * 检查是否可见
   */
  static get isVisible() {
    return MainWindow.#isVisible;
  }

  /**
   * 以文件选择器模式打开 Origin Vault
   * @param {object} options
   * @param {Function} options.callback - 选择完成后的回调 (path) => void
   * @param {string} [options.type] - 文件类型过滤 ('image', 'audio', 'video', 'any')
   * @param {string} [options.current] - 当前已选路径
   */
  static openAsFilePicker({ callback, field, type = 'any', current = '', fpInstance = null } = {}) {
    // MAD 版：禁用 FilePicker 替代模式
    if (IS_MAD_EDITION) {
      ovDebug(`${MODULE_ID} | MAD Edition: FilePicker mode disabled`);
      return;
    }
    const instance = MainWindow.getInstance();

    // 保存原始窗口模式，退出时恢复
    instance._savedIsWindowed = instance.isWindowed;

    instance.filePickerMode = true;
    instance.filePickerCallback = callback;
    instance.filePickerField = field;  // V13: {{filePicker}} 绑定的目标 input 元素
    instance.filePickerInstance = fpInstance;
    instance.filePickerOptions = { type, current };

    // 文件选择器模式下不提升其他窗口的 z-index，清理已有的提升
    instance._clearManagedZLayers();

    // 文件选择器模式强制窗口化
    if (!instance.isWindowed) {
      instance.isWindowed = true;
    }
    instance._syncWorkspaceShellState?.({ forceActive: false });

    // 显示窗口
    MainWindow.show();

    // 延迟渲染确定按钮栏 + 置顶（等待 Foundry 异步 render 完成）
    setTimeout(() => {
      instance._renderPickerBar();

      // ★ 文件选择器模式下，确保 OV 窗口在最顶层
      if (instance.element) {
        instance._bringPickerToFront?.();
        const el = instance.element instanceof jQuery ? instance.element[0] : instance.element;
        if (el) {
          // OV 自身也需要点击置顶
          if (!el._ovPickerPointerHandler) {
            el._ovPickerPointerHandler = true;
            el.addEventListener('pointerdown', () => {
              if (instance.filePickerMode) {
                instance._bringPickerToFront?.();
              }
            }, true);
          }
        }
      }
    }, 150);
  }

  /**
   * ApplicationV2 Configuration
   */
  static DEFAULT_OPTIONS = {
    id: 'origin-vault-main',
    tag: 'section',
    window: {
      title: MODULE_TITLE,
      icon: 'fas fa-vault',
      resizable: true,
      minimizable: true,
      // V2 window.controls are hidden in fullscreen mode (custom .ov-header used instead).
      // Keep controls empty to avoid referencing non-existent action handlers.
      controls: []
    },
    position: {
      width: 1024,
      height: 768
    },
    // Actions are primarily bound via jQuery in activateListeners / _activateSidebarListeners.
    // Only list actions that use data-action attributes in templates.
    actions: {},
    classes: ['origin-vault', 'window-app-v2', 'main-window']
  };

  /**
   * Override title to prevent folder name from appending
   */
  get title() {
    return MODULE_TITLE;
  }

  /**
   * Reset FilePicker mode without recursively calling hide() again.
   */
  _cleanupFilePickerModeState({ closeNative = false } = {}) {
    const fpInstance = this.filePickerInstance;

    // Reset FilePicker state only. Global z-index management is handled by show/close lifecycle.
    this.filePickerMode = false;
    this.filePickerCallback = null;
    this.filePickerField = null;
    this.filePickerInstance = null;
    this.filePickerOptions = null;
    // Remove the picker UI and restore windowed mode if we forced it.
    const bar = this.element?.querySelector('.ov-picker-bar');
    if (bar) bar.remove();

    if (this._pickerMouseHandler) {
      document.removeEventListener('mousedown', this._pickerMouseHandler, true);
      this._pickerMouseHandler = null;
    }

    this._pickerZIndex = null;
    this.element?.classList.remove('ov-picker-mode');
    this.element?.style.removeProperty('z-index');

    if (this._savedIsWindowed !== undefined) {
      this.isWindowed = this._savedIsWindowed;
      delete this._savedIsWindowed;
    }

    if (closeNative && fpInstance) {
      try {
        fpInstance._ovSkipIntercept = true;
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
        console.warn(`${MODULE_ID} | Failed to close native FilePicker during MainWindow.close():`, e);
      }
    }
  }

  _ensureVisibleCurrentFolderId() {
    if (!this.currentFolderId || this.currentFolderId === SPECIAL_FOLDERS.ROOT) {
      this.currentFolderId = SPECIAL_FOLDERS.ALL;
      return;
    }

    if (typeof this.currentFolderId !== 'string') {
      this.currentFolderId = SPECIAL_FOLDERS.ALL;
      return;
    }

    if (this._isSmartFolderView(this.currentFolderId)) {
      if (!this.library.getSmartFolder(this.currentFolderId)) {
        ovLog(`${MODULE_ID} | Smart folder ${this.currentFolderId} not found, resetting to ALL`);
        this.currentFolderId = SPECIAL_FOLDERS.ALL;
      }
      return;
    }

    if (!this.currentFolderId.startsWith('__') && !this.library.getFolder(this.currentFolderId)) {
      ovLog(`${MODULE_ID} | Folder ${this.currentFolderId} not found, resetting to ALL`);
      this.currentFolderId = SPECIAL_FOLDERS.ALL;
    }
  }

  _isSmartFolderView(folderId = this.currentFolderId) {
    return typeof folderId === 'string'
      && (folderId.startsWith(SMART_FOLDER_PREFIX) || this.library?.isSmartFolderId?.(folderId));
  }

  _getCurrentFolderLike(folderId = this.currentFolderId) {
    return this._isSmartFolderView(folderId)
      ? this.library.getSmartFolder(folderId)
      : this.library.getFolder(folderId);
  }

  _buildSpecialFolderEntries(stats = this.library.getStats()) {
    return [
      { id: SPECIAL_FOLDERS.ALL, name: t('origin-vault.folders.all'), icon: 'fas fa-layer-group', count: stats.totalItems },
      { id: SPECIAL_FOLDERS.FAVORITES, name: t('origin-vault.folders.favorites'), icon: 'fas fa-star', count: this.library.getItemsByFolder(SPECIAL_FOLDERS.FAVORITES).length },
      { id: SPECIAL_FOLDERS.RECENT, name: t('origin-vault.folders.recent'), icon: 'fas fa-clock', count: this.library.getItemsByFolder(SPECIAL_FOLDERS.RECENT).length }
    ];
  }

  _buildSmartFolderEntries() {
    return this.library.getAllSmartFolders().map(folder => ({
      ...folder,
      itemCount: this.library.getSmartFolderItemCount(folder.id),
      isSelected: folder.id === this.currentFolderId
    }));
  }

  _applySubfolderBrowsingDefault() {
    if (!this.library?.loaded) return;

    const libraryKey = this.library.basePath || 'default';
    if (this._subfolderDefaultLibraryKey === libraryKey) return;
    this._subfolderDefaultLibraryKey = libraryKey;

    const isLargeLibrary = (this.library.itemsCache?.size || 0) > LARGE_LIBRARY_SUBFOLDER_THRESHOLD;
    this.showSubfolderItems = !isLargeLibrary;

    if (isLargeLibrary) {
      this._queueLargeLibrarySubfolderNotice();
    }
  }

  _queueLargeLibrarySubfolderNotice() {
    if (this._largeLibrarySubfolderNoticeQueued) return;
    if (this.library.getSetting(LARGE_LIBRARY_SUBFOLDER_NOTICE_KEY)) return;

    this._largeLibrarySubfolderNoticeQueued = true;
    this.library.setSetting(LARGE_LIBRARY_SUBFOLDER_NOTICE_KEY, true);

    setTimeout(() => {
      this._largeLibrarySubfolderNoticeQueued = false;
      this._showLargeLibrarySubfolderNotice();
    }, 250);
  }

  async _showLargeLibrarySubfolderNotice() {
    const title = t('origin-vault.dialog.largeLibrarySubfolder.title');
    const content = `
      <p>${tf('origin-vault.dialog.largeLibrarySubfolder.content', {
        count: (this.library.itemsCache?.size || 0).toLocaleString()
      })}</p>
      <p>${t('origin-vault.dialog.largeLibrarySubfolder.note')}</p>
    `;

    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (!DialogV2) {
      ui.notifications.info(`${title} ${t('origin-vault.dialog.largeLibrarySubfolder.note')}`);
      return;
    }

    await DialogV2.wait({
      window: { title },
      content,
      modal: false,
      rejectClose: false,
      buttons: [{
        action: 'ok',
        icon: 'fas fa-check',
        label: t('origin-vault.dialog.confirm'),
        default: true
      }]
    });
  }

  _refreshTagPanels() {
    if (this.filterPanel) {
      if (this.filterPanel.isOpen && typeof this.filterPanel._updateDropdown === 'function') {
        this.filterPanel._updateDropdown();
      } else if (typeof this.filterPanel._updateButton === 'function') {
        this.filterPanel._updateButton();
      }
    }

    if (this.itemFilterPanel) {
      if (this.itemFilterPanel.isOpen && typeof this.itemFilterPanel._renderDropdown === 'function') {
        this.itemFilterPanel._renderDropdown();
      }
      if (typeof this.itemFilterPanel._updateButton === 'function') {
        this.itemFilterPanel._updateButton();
      }
    }
  }

  _refreshTagUi({ rerenderGrid = true } = {}) {
    if (!MainWindow.#isVisible) return;

    this._ensureVisibleCurrentFolderId();
    if (typeof this._updateSidebarSelection === 'function') {
      void this._updateSidebarSelection(this.currentFolderId);
    }

    this._refreshTagPanels();

    if (rerenderGrid && this.currentFolderId && this.browserVisible === false) {
      this._renderAssetGrid();
    }

    if (this.selectedItems.size > 0) {
      this._scheduleDetailsPanelRender();
    }
  }

  _getTagFilterCount(filters = this.filters) {
    if (!filters) return 0;
    return (filters.tags?.length || 0)
      + (filters.excludeTags?.length || 0)
      + (filters.untagged ? 1 : 0);
  }

  _hasActiveTagFilters(filters = this.filters) {
    return this._getTagFilterCount(filters) > 0;
  }

  _shouldScrollToTopAfterTagFilterChange(previousFilters, nextFilters) {
    return this._getTagFilterCount(previousFilters) > 0
      && this._getTagFilterCount(nextFilters) === 0;
  }

  _haveFileTypeFiltersChanged(previousFilters, nextFilters) {
    const previousTypes = [...(previousFilters?.fileTypes || [])].sort().join('|');
    const nextTypes = [...(nextFilters?.fileTypes || [])].sort().join('|');
    return previousTypes !== nextTypes;
  }

  _shouldScrollToTopAfterPrimaryFilterChange(previousFilters, nextFilters) {
    return this._shouldScrollToTopAfterTagFilterChange(previousFilters, nextFilters)
      || this._haveFileTypeFiltersChanged(previousFilters, nextFilters);
  }

  _clearTagFilters({ scrollToTop = false, rerenderGrid = true } = {}) {
    if (!this.filters) return false;

    const hadActiveTagFilters = this._hasActiveTagFilters(this.filters);
    if (!hadActiveTagFilters) return false;

    this.filters.tags = [];
    this.filters.excludeTags = [];
    this.filters.untagged = false;

    if (this.filterPanel) {
      this.filterPanel.filters.tags = [];
      this.filterPanel.filters.excludeTags = [];
      this.filterPanel.filters.untagged = false;
    }

    if (this.itemFilterPanel) {
      this.itemFilterPanel.filters.tags = [];
      this.itemFilterPanel.filters.excludeTags = [];
    }

    this._refreshTagPanels();

    if (scrollToTop) {
      this._scrollToTop();
    }

    if (rerenderGrid) {
      this._renderAssetGrid();
    }

    return true;
  }

  _decodeSafeValue(value) {
    if (typeof value !== 'string') return '';
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  _getAssetType(item) {
    return item?.metadata?.type || item?.type || null;
  }

  _getAssetUuid(item) {
    return item?.metadata?.uuid || item?.uuid || null;
  }

  _getWorldDocumentSource(doc) {
    return doc?._stats?.compendiumSource || doc?.flags?.core?.sourceId || null;
  }

  _findWorldDocumentBySource(type, sourceUuid) {
    if (!type || !sourceUuid) return null;

    const collection = type === 'scene'
      ? game.scenes
      : type === 'item'
        ? game.items
        : type === 'actor'
          ? game.actors
          : null;

    return collection?.find(doc => doc?.uuid === sourceUuid || this._getWorldDocumentSource(doc) === sourceUuid) || null;
  }

  _resolveImportState(target = null, { type = null, uuid = null, worldSceneId = null } = {}) {
    const resolvedType = type || this._getAssetType(target);
    const sourceUuid = uuid ?? this._getAssetUuid(target);

    if (resolvedType === 'scene') {
      const persistedWorldSceneId = worldSceneId
        ?? getWorldSceneId(target, { library: this.library });
      if (persistedWorldSceneId) {
        const worldDoc = game.scenes?.get(persistedWorldSceneId) || null;
        return {
          imported: !!worldDoc,
          worldId: worldDoc?.id || null,
          worldUuid: worldDoc?.uuid || null,
          worldDoc,
          sourceUuid,
          type: resolvedType
        };
      }
    }

    const worldDoc = this._findWorldDocumentBySource(resolvedType, sourceUuid);
    return {
      imported: !!worldDoc,
      worldId: worldDoc?.id || null,
      worldUuid: worldDoc?.uuid || null,
      worldDoc,
      sourceUuid,
      type: resolvedType
    };
  }

  _buildDetailFolderList(folderIds = [], allFolders = this.library.getAllFolders()) {
    return folderIds
      .map(fid => {
        const folder = allFolders?.[fid] || this.library.getFolder(fid);
        if (!folder) return null;
        return {
          id: fid,
          name: folder.name || tf('origin-vault.folders.folderNameNum', { num: fid.slice(0, 6) }),
          color: folder.color || '#FFD700',
          isRoot: false
        };
      })
      .filter(Boolean);
  }

  _getSelectedDetailFileFormat(detailItem, type) {
    if (type === 'scene') return t('origin-vault.fileTypes.scene');
    if (type === 'item') {
      const itemType = detailItem.metadata?.itemType || detailItem.itemType || 'item';
      return hasTranslation(`TYPES.Item.${itemType}`)
        ? t(`TYPES.Item.${itemType}`)
        : itemType.charAt(0).toUpperCase() + itemType.slice(1);
    }
    if (type === 'actor') {
      return getActorBadgeLabel(detailItem);
    }
    return (detailItem.path || '').split('.').pop().toUpperCase();
  }

  async _buildSelectedDetail(detailItem, { allFolders = this.library.getAllFolders(), hydrateDocumentData = true } = {}) {
    if (!detailItem) return null;

    const type = this._getAssetType(detailItem);
    const uuid = this._getAssetUuid(detailItem);
    let dimensions = detailItem.metadata?.dimensions;
    if (!dimensions && detailItem.metadata?.width && detailItem.metadata?.height) {
      dimensions = `${detailItem.metadata.width} × ${detailItem.metadata.height}`;
    }

    const selectedDetail = {
      ...detailItem,
      type,
      uuid,
      name: this._decodeSafeValue(detailItem.name || ''),
      displayName: this._decodeSafeValue(
        detailItem.displayName
        || detailItem.name
        || (typeof detailItem.path === 'string' ? detailItem.path.split('/').pop().replace(/\.[^/.]+$/, '') : '')
        || ''
      ),
      folderName: allFolders?.[detailItem.folders?.[0]]?.name || t('origin-vault.folders.unknown'),
      folderList: this._buildDetailFolderList(detailItem.folders || [], allFolders),
      fileFormat: this._getSelectedDetailFileFormat(detailItem, type),
      formattedAddedDate: detailItem.addedDate ? new Date(detailItem.addedDate).toLocaleString() : '',
      decodedPath: this._decodeSafeValue(detailItem.path),
      dimensions: dimensions || ovText('Unknown', 'Неизвестно'),
      fileSize: detailItem.metadata?.size || ovText('Unknown', 'Неизвестно'),
      formattedDuration: detailItem.metadata?.duration ? this._formatVideoTime(detailItem.metadata.duration) : null,
      tags: (detailItem.tags || []).map(tagId => this.library.getTag(tagId)).filter(Boolean),
      stars: Array.from({ length: 5 }, (_, i) => ({
        value: i + 1,
        filled: (i + 1) <= (detailItem.rating || 0)
      })),
      thumbnail: detailItem.thumbnail || null,
      enrichedDescription: detailItem.enrichedDescription || null,
      systemFields: detailItem.systemFields || null,
      itemType: detailItem.itemType || detailItem.metadata?.itemType || null,
      itemSubtype: detailItem.itemSubtype || null,
      actorType: detailItem.actorType || detailItem.metadata?.actorType || null,
      actorBadgeLabel: detailItem.actorBadgeLabel || getActorBadgeLabel(detailItem),
      actorRace: detailItem.actorRace || detailItem.metadata?.actorRace || null,
      actorCr: detailItem.actorCr || detailItem.metadata?.actorCr || null,
      isImported: !!detailItem.isImported,
      worldId: detailItem.worldId || null,
      isItemImported: !!detailItem.isItemImported,
      worldItemUuid: detailItem.worldItemUuid || null,
      isActorImported: !!detailItem.isActorImported,
      worldActorUuid: detailItem.worldActorUuid || null,
      hasSceneLevels: false,
      hasMultipleSceneLevels: false,
      showScenePreviewLevelControl: false,
      sceneLevels: [],
      sceneLevelCount: 0,
      sceneLevelKey: null,
      activeSceneLevelId: null
    };

    const importState = this._resolveImportState(detailItem, { type, uuid });

    if (type === 'scene') {
      selectedDetail.isImported = importState.imported;
      selectedDetail.worldId = importState.worldId || null;

      const sceneDetail = {
        uuid,
        id: detailItem.id,
        folderId: detailItem.folderId || detailItem.metadata?.compendiumId,
        sceneData: detailItem.sceneData,
        metadata: detailItem.metadata,
        worldSceneId: getWorldSceneId(detailItem, { library: this.library })
      };

      let sceneData = null;
      if (typeof this._getFullSceneData === 'function') {
        try {
          sceneData = await this._getFullSceneData(sceneDetail);
        } catch (error) {
          sceneData = null;
        }
      }
      const sceneLevelOptions = SceneRenderer.getDetailLevelOptions();
      const sceneLevels = SceneRenderer.getSceneLevels(sceneData, sceneLevelOptions);
      if (sceneLevels.length > 0) {
        const sceneKey = typeof this._getSceneLevelStorageKey === 'function'
          ? this._getSceneLevelStorageKey(detailItem, sceneData)
          : (uuid
            || selectedDetail.worldId
            || sceneData?._id
            || detailItem.id
            || detailItem.path
            || selectedDetail.displayName);
        const sceneLevelStore = this._sceneLevelSelection || (this._sceneLevelSelection = new Map());
        const overrideLevelId = this._getPendingSceneLevelOverride?.(detailItem, sceneData);
        const activeSceneLevelId = SceneRenderer.resolveLevelId(sceneData, overrideLevelId || sceneLevelStore.get(sceneKey), sceneLevelOptions);

        if (activeSceneLevelId) {
          sceneLevelStore.set(sceneKey, activeSceneLevelId);
        }

        selectedDetail.hasSceneLevels = true;
        const sceneLevelChoices = [
          {
            id: SceneRenderer.OVERVIEW_LEVEL_ID,
            label: t('origin-vault.scenes.levelOverview'),
            overview: true
          },
          ...sceneLevels.map((level, index) => ({
            id: level.id,
            label: this._decodeSafeValue(
              level.name || tf('origin-vault.scenes.levelDefaultName', { index: index + 1 })
            )
          }))
        ];

        selectedDetail.hasMultipleSceneLevels = sceneLevelChoices.length > 1;
        selectedDetail.showScenePreviewLevelControl = sceneLevelChoices.length > 1;
        selectedDetail.sceneLevelCount = sceneLevels.length;
        selectedDetail.sceneLevelKey = sceneKey;
        selectedDetail.activeSceneLevelId = activeSceneLevelId;
        selectedDetail.sceneLevels = sceneLevelChoices.map(level => ({
          ...level,
          active: level.id === activeSceneLevelId
        }));
      }

      return selectedDetail;
    }

    if (type === 'item') {
      selectedDetail.isImported = importState.imported;
      selectedDetail.isItemImported = importState.imported;
      selectedDetail.worldId = importState.worldId || detailItem.worldId || null;
      selectedDetail.worldItemUuid = importState.worldUuid || detailItem.worldItemUuid || null;

      if (!hydrateDocumentData) return selectedDetail;

      const itemDoc = importState.worldDoc || (uuid ? await fromUuid(importState.worldUuid || uuid).catch(() => null) : null);
      if (!itemDoc) return selectedDetail;

      const rawDesc = itemDoc.system?.description?.value || '';
      if (rawDesc) {
        selectedDetail.enrichedDescription = await TextEditor.enrichHTML(rawDesc, {
          async: true,
          relativeTo: itemDoc
        });
      }
      selectedDetail.systemFields = extractSystemFieldValues({ systemData: itemDoc.system });
      selectedDetail.itemType = itemDoc.type;
      selectedDetail.itemSubtype = getSubTypeLabel(itemDoc.type);
      return selectedDetail;
    }

    if (type === 'actor') {
      selectedDetail.isImported = importState.imported;
      selectedDetail.isActorImported = importState.imported;
      selectedDetail.worldId = importState.worldId || detailItem.worldId || null;
      selectedDetail.worldActorUuid = importState.worldUuid || detailItem.worldActorUuid || null;

      if (!hydrateDocumentData) return selectedDetail;

      const actorDoc = importState.worldDoc || (uuid ? await fromUuid(importState.worldUuid || uuid).catch(() => null) : null);
      if (!actorDoc) return selectedDetail;

      const rawBio = actorDoc.system?.details?.biography?.value
        || actorDoc.system?.details?.biography
        || actorDoc.system?.description?.value
        || actorDoc.system?.biography?.value
        || '';
      if (rawBio) {
        selectedDetail.enrichedDescription = await TextEditor.enrichHTML(rawBio, {
          async: true,
          relativeTo: actorDoc
        });
      }
      const actorMeta = getActorPreviewMeta(detailItem, actorDoc);
      selectedDetail.actorType = actorMeta.actorType;
      selectedDetail.actorBadgeLabel = actorMeta.badgeLabel;
      selectedDetail.actorRace = actorMeta.race || null;
      selectedDetail.actorCr = actorMeta.cr || null;
      selectedDetail.fileFormat = actorMeta.badgeLabel || selectedDetail.fileFormat;
    }

    return selectedDetail;
  }

  _invalidateImportStateCache(type = null) {
    if (!type || type === 'scene') {
      if (this._importedSceneCacheTimer) {
        clearTimeout(this._importedSceneCacheTimer);
        this._importedSceneCacheTimer = null;
      }
      this._importedSceneUuids = null;
      this._importedSceneNames = null;
    }

    if (!type || type === 'item') {
      if (this._importedItemCacheTimer) {
        clearTimeout(this._importedItemCacheTimer);
        this._importedItemCacheTimer = null;
      }
      this._importedItemUuids = null;
    }
  }

  _ensureImportedSceneCache() {
    if (this._importedSceneUuids && this._importedSceneNames) return;

    this._importedSceneUuids = new Set();
    this._importedSceneNames = new Set();
    game.scenes?.forEach(scene => {
      const sourceUuid = this._getWorldDocumentSource(scene);
      if (sourceUuid) this._importedSceneUuids.add(sourceUuid);
      if (scene.name) this._importedSceneNames.add(scene.name.toLowerCase());
    });

    if (this._importedSceneCacheTimer) clearTimeout(this._importedSceneCacheTimer);
    this._importedSceneCacheTimer = setTimeout(() => this._invalidateImportStateCache('scene'), 30000);
  }

  _ensureImportedItemCache() {
    if (this._importedItemUuids) return;

    this._importedItemUuids = new Set();
    game.items?.forEach(item => {
      const sourceUuid = this._getWorldDocumentSource(item);
      if (sourceUuid) this._importedItemUuids.add(sourceUuid);
    });

    if (this._importedItemCacheTimer) clearTimeout(this._importedItemCacheTimer);
    this._importedItemCacheTimer = setTimeout(() => this._invalidateImportStateCache('item'), 30000);
  }

  _updateAssetCardImportBadge(itemId, { sceneImported = null, itemImported = null, actorImported = null } = {}) {
    const card = this.element?.querySelector(`.asset-card:not(.ov-compare-card)[data-item-id="${itemId}"]`);
    const badge = card?.querySelector('.file-type-badge');
    if (!badge) return;

    if (typeof sceneImported === 'boolean') {
      badge.classList.toggle('imported-scene', sceneImported);
      if (badge.classList.contains('mad-logo-badge')) {
        badge.classList.toggle('not-imported', !sceneImported);
      }
    }

    if (typeof itemImported === 'boolean') {
      badge.classList.toggle('imported-item', itemImported);
    }

    if (typeof actorImported === 'boolean') {
      badge.classList.toggle('imported-actor', actorImported);
    }
  }

  _refreshVisibleImportState(type, { resetCache = true } = {}) {
    if (!MainWindow.#isVisible) return false;

    if (resetCache) {
      this._invalidateImportStateCache(type);
    }

    let updated = false;

    for (const item of this.allItems || []) {
      if (this._getAssetType(item) !== type) continue;

      const importState = this._resolveImportState(item, { type });
      const nextImported = !!importState.imported;
      const nextWorldId = importState.worldId || null;

      if (item.isImported !== nextImported || (item.worldId || null) !== nextWorldId) {
        updated = true;
      }

      item.isImported = nextImported;
      item.worldId = nextWorldId;

      if (type === 'scene') {
        this._updateAssetCardImportBadge(item.id, { sceneImported: nextImported });
      } else if (type === 'item') {
        item.isItemImported = nextImported;
        item.worldItemUuid = importState.worldUuid || null;
        this._updateAssetCardImportBadge(item.id, { itemImported: nextImported });
      } else if (type === 'actor') {
        item.isActorImported = nextImported;
        item.worldActorUuid = importState.worldUuid || null;
        this._updateAssetCardImportBadge(item.id, { actorImported: nextImported });
      }
    }

    if (this.previewItem && this._getAssetType(this.previewItem) === type) {
      const importState = this._resolveImportState(this.previewItem, { type });
      this.previewItem.isImported = !!importState.imported;
      this.previewItem.worldId = importState.worldId || null;

      if (type === 'item') {
        this.previewItem.isItemImported = !!importState.imported;
        this.previewItem.worldItemUuid = importState.worldUuid || null;
      } else if (type === 'actor') {
        this.previewItem.isActorImported = !!importState.imported;
        this.previewItem.worldActorUuid = importState.worldUuid || null;
      }
    }

    if (updated && (this.selectedItems?.size > 0 || this.previewItem)) {
      this._scheduleDetailsPanelRender();
    }

    return updated;
  }

  _syncImportStateForWorldDocument(type, action, worldDoc) {
    if (!MainWindow.#isVisible) return;

    this._invalidateImportStateCache(type);

    const sourceUuid = this._getWorldDocumentSource(worldDoc);
    if (!sourceUuid) {
      return this._refreshVisibleImportState(type, { resetCache: false });
    }
    let updated = false;

    const resolveImmediateImportState = (target) => {
      const resolved = this._resolveImportState(target, { type, uuid: sourceUuid });
      if (resolved.imported) return resolved;

      if (action === 'create') {
        return {
          ...resolved,
          imported: true,
          worldId: worldDoc?.id || resolved.worldId || null,
          worldUuid: worldDoc?.uuid || resolved.worldUuid || null,
          worldDoc: resolved.worldDoc || worldDoc || null
        };
      }

      if (action === 'delete') {
        return {
          ...resolved,
          imported: false,
          worldId: null,
          worldUuid: null,
          worldDoc: null
        };
      }

      return resolved;
    };

    for (const item of this.allItems || []) {
      if (this._getAssetType(item) !== type) continue;
      if (this._getAssetUuid(item) !== sourceUuid) continue;

      const importState = resolveImmediateImportState(item);
      item.isImported = importState.imported;
      item.worldId = importState.worldId || null;

      if (type === 'item') {
        item.isItemImported = importState.imported;
        item.worldItemUuid = importState.worldUuid || null;
        this._updateAssetCardImportBadge(item.id, { itemImported: importState.imported });
      } else if (type === 'scene') {
        this._updateAssetCardImportBadge(item.id, { sceneImported: importState.imported });
      } else if (type === 'actor') {
        item.isActorImported = importState.imported;
        item.worldActorUuid = importState.worldUuid || null;
        this._updateAssetCardImportBadge(item.id, { actorImported: importState.imported });
      }

      updated = true;
    }

    if (this.previewItem && this._getAssetType(this.previewItem) === type && this._getAssetUuid(this.previewItem) === sourceUuid) {
      const importState = resolveImmediateImportState(this.previewItem);
      this.previewItem.isImported = importState.imported;
      this.previewItem.worldId = importState.worldId || null;

      if (type === 'item') {
        this.previewItem.isItemImported = importState.imported;
        this.previewItem.worldItemUuid = importState.worldUuid || null;
      } else if (type === 'actor') {
        this.previewItem.isActorImported = importState.imported;
        this.previewItem.worldActorUuid = importState.worldUuid || null;
      }

      updated = true;
    }

    if (updated && (this.selectedItems?.size > 0 || this.previewItem)) {
      this._scheduleDetailsPanelRender();
    }

    // 老素材里偶尔会缺 source 信息，精确命中不到时顺手全量校一遍当前视图。
    if (!updated && type === 'scene') {
      return this._refreshVisibleImportState(type, { resetCache: false });
    }

    return updated;
  }

  static PARTS = {
    main: {
      template: `modules/${MODULE_ID}/templates/main-window.hbs`,
      scrollable: ['.folder-tree-content', '.asset-grid']
    }
  };

  /**
   * 准备渲染数据 (V2 Replacement for getData)
   * 提供模板和各面板渲染方法所需的完整数据。
   * @param {object} options
   * @returns {Promise<object>}
   */
  async _prepareContext(options = {}) {
    if (!this.library.loaded) {
      // 库未加载，返回空壳数据
      return {
        currentFolder: null,
        items: [],
        subfolders: [],
        folderTree: {},
        smartFolders: [],
        stats: { totalItems: 0, totalFolders: 0, totalTags: 0 },
        currentFolderId: this.currentFolderId,
        activeType: this.activeType,
        searchQuery: this.searchQuery,
        searchMode: this.searchMode,
        filters: this.filters,
        viewMode: this.fileBrowserState?.viewMode || 'grid',
        sortOrder: 'date-desc',
        dragMode: this.dragMode,
        selectedItems: Array.from(this.selectedItems || []),
        selectedCount: 0,
        browserVisible: this.browserVisible,
        sceneBrowserVisible: this.sceneBrowserVisible,
        itemBrowserVisible: this.itemBrowserVisible,
        actorBrowserVisible: this.actorBrowserVisible,
        compendiumBatch: this._getCompendiumBatchContext(),
        isWindowed: this.isWindowed,
        previewItem: this.previewItem,
        isSmartFolderView: false,
        tab: options.tab
      };
    }

    // 预览模式：只需最小数据，跳过全量素材收集/排序
    this._ensureVisibleCurrentFolderId();

    if (this.previewItem) {
      // 为右侧详情面板构建 selectedDetail（不能跳过，否则面板会显示空状态）
      // ⚠️ 同步点 1/3：新增字段须同步到 _prepareContext 正常路径(2/3) 和 _closePreview(3/3)
      // 计划：抽取为 _buildSelectedDetail() 共享方法（见 计划/OV/抽取_buildSelectedDetail共享方法.md）
      const previewFolders = this.library.getAllFolders();
      const previewCurrentFolder = this._getCurrentFolderLike(this.currentFolderId);
      const previewStats = this.library.getStats();
      const previewFolderTree = this._buildFolderTree(SPECIAL_FOLDERS.ROOT, previewFolders);
      const pSelectedDetail = await this._buildSelectedDetail(this.previewItem, {
        allFolders: previewFolders,
        hydrateDocumentData: false
      });

      return {
        currentFolder: previewCurrentFolder,
        items: [],
        subfolders: [],
        folderTree: previewFolderTree,
        smartFolders: this._buildSmartFolderEntries(),
        stats: previewStats,
        currentFolderId: this.currentFolderId,
        activeType: this.activeType,
        searchQuery: this.searchQuery,
        searchMode: this.searchMode,
        filters: this.filters,
        viewMode: this.fileBrowserState?.viewMode || 'grid',
        sortOrder: 'date-desc',
        dragMode: this.dragMode,
        selectedItems: Array.from(this.selectedItems || []),
        selectedCount: this.selectedItems?.size || 0,
        browserVisible: this.browserVisible,
        sceneBrowserVisible: this.sceneBrowserVisible,
        isWindowed: this.isWindowed,
        previewItem: this.previewItem,
        isSmartFolderView: this._isSmartFolderView(this.currentFolderId),
        selectedDetail: pSelectedDetail,
        specialFolders: this._buildSpecialFolderEntries(previewStats),
        settings: this.library.config?.settings || {},
        currentFolderName: previewCurrentFolder?.name || t('origin-vault.folders.root'),
        currentFolderItemCount: 0,
        itemBrowserVisible: this.itemBrowserVisible,
        itemPackEntries: [],
        worldItems: [],
        actorBrowserVisible: this.actorBrowserVisible,
        actorPackEntries: [],
        compendiumBatch: this._getCompendiumBatchContext(),
        tab: options.tab
      };
    }

    // 获取当前文件夹
    const currentFolder = this._getCurrentFolderLike(this.currentFolderId);
    const isSmartFolderView = this._isSmartFolderView(this.currentFolderId);

    // 文件夹树结构
    const allFolders = this.library.getAllFolders();

    // 获取当前视图的素材
    const hasActiveFilters = this.filters && (
      (this.filters.tags && this.filters.tags.length > 0) ||
      (this.filters.excludeTags && this.filters.excludeTags.length > 0) ||
      (this.filters.minRating && this.filters.minRating > 0) ||
      (this.filters.fileTypes && this.filters.fileTypes.length > 0) ||
      this.filters.untagged
    );

    let items = (this.searchQuery || hasActiveFilters)
      ? this.library.searchItems(this.searchQuery || '', { ...this.filters, folderId: this.currentFolderId, includeSubfolders: this.showSubfolderItems, mode: this.searchMode })
      : (this.showSubfolderItems
        ? this.library.getItemsByFolder(this.currentFolderId)
        : this.library.getDirectItemsByFolder(this.currentFolderId));

    // 文件选择器模式下只展示真实文件，别把 Scene/Actor 这类复合素材混进来。
    if (this.filePickerMode) {
      items = items.filter(item => {
        // Exclude scene-type items
        if (item?.metadata?.type === 'scene' || item?.type === 'scene') return false;
        // Exclude .ov-scene files
        if (typeof item?.path === 'string' && item.path.endsWith('.ov-scene')) return false;
        // Exclude item-type items
        if (item?.metadata?.type === 'item') return false;
        // Exclude actor-type items
        if (item?.metadata?.type === 'actor') return false;
        return true;
      });
    }

    const decodeSafe = (value) => {
      if (typeof value !== 'string') return '';
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    };

    // 为瀑布流布局补充宽高比 + 排序（带缓存，避免每次渲染重复 O(n log n)）
    const sortCacheKey = `${this.currentFolderId}|${this.showSubfolderItems}|${this.searchQuery}|${JSON.stringify(this.filters)}`;
    if (this._sortedItemsCacheKey === sortCacheKey && this._sortedItemsCache) {
      // 缓存命中：直接复用上次的排序结果
      items = this._sortedItemsCache;
    } else {
      // 就地修补 aspectRatio / displayName，避免 spread 创建新对象
      for (const item of items) {
        // ★ 优先使用真实尺寸（来自缩略图生成器），忽略可能被持久化的错误 aspectRatio
        let ratio;
        if (item?.metadata?.width && item?.metadata?.height) {
          ratio = item.metadata.width / item.metadata.height;
        } else if (typeof item?.path === 'string' && item.path) {
          const ext = '.' + item.path.split('.').pop().toLowerCase();
          if (FILE_TYPES.VIDEO.includes(ext)) {
            ratio = 16 / 9;
          } else if (FILE_TYPES.AUDIO.includes(ext)) {
            ratio = 3;
          } else {
            ratio = 1;
          }
        } else {
          ratio = 1;
        }
        item.aspectRatio = ratio;

        if (!item._displayNameDecoded) {
          const rawDisplayName = item?.displayName || item?.name || (typeof item?.path === 'string' ? item.path.split('/').pop() : ovText('Untitled', 'Без названия'));
          item.displayName = decodeSafe(rawDisplayName);
          item.name = decodeSafe(item?.name || '');
          item._displayNameDecoded = true;
        }
      }

      // 按文件名自然排序
      items.sort((a, b) => naturalCompare(a.displayName, b.displayName));

      this._sortedItemsCache = items;
      this._sortedItemsCacheKey = sortCacheKey;
    }

    for (const item of items) {
      const isScene = item?.metadata?.type === 'scene' || item?.type === 'scene';
      if (isScene) {
        item.isWorldScene = !!getWorldSceneId(item, { library: this.library });
        item.isSceneImported = !!item.isImported;
      }
      if (item?.metadata?.type === 'actor' || item?.type === 'actor') {
        const actorImportState = this._resolveImportState(item, { type: 'actor' });
        item.isImported = actorImportState.imported;
        item.isActorImported = actorImportState.imported;
        item.worldActorUuid = actorImportState.worldUuid || null;
        item.actorBadgeLabel = getActorBadgeLabel(item);
      }
    }

    ovLog(`${MODULE_ID} | _prepareContext: folderId=${this.currentFolderId}, hasActiveFilters=${hasActiveFilters}, searchQuery='${this.searchQuery}', items.length=${items.length}`);

    // 获取子文件夹
    // showSubfolderItems=true: 深度穿透，显示所有后代文件夹
    // showSubfolderItems=false: 仅显示直接子文件夹
    let subfolders = [];
    if (!this.searchQuery && !isSmartFolderView) {
      // 封装封面图查找逻辑
      const addCoverImage = (folder) => {
        const folderItems = this.library.getItemsByFolder(folder.id);
        const coverItem = folderItems.find(item => {
          const ext = '.' + item.path.split('.').pop().toLowerCase();
          return FILE_TYPES.IMAGE.includes(ext) || (item.thumbnailGenerated && item.thumbnail);
        });
        return {
          ...folder,
          coverImage: coverItem ? (coverItem.thumbnail || coverItem.path) : null
        };
      };

      // 1. 全部素材模式
      if (this.currentFolderId === SPECIAL_FOLDERS.ALL) {
        const allFolderIds = Object.keys(allFolders).filter(id =>
          id !== SPECIAL_FOLDERS.ROOT &&
          !Object.values(SPECIAL_FOLDERS).includes(id)
        );

        if (this.showSubfolderItems) {
          // 穿透模式：显示所有文件夹
          subfolders = allFolderIds
            .map(id => this.library.getFolder(id))
            .filter(f => f)
            .sort((a, b) => naturalCompare(a.name, b.name))
            .map(addCoverImage);
        } else {
          // 非穿透：只显示顶层文件夹
          subfolders = this.library.getDirectChildFolders(SPECIAL_FOLDERS.ROOT)
            .map(addCoverImage);
        }
      }
      // 2. 普通文件夹模式
      else if (this.currentFolderId !== SPECIAL_FOLDERS.UNCATEGORIZED &&
        this.currentFolderId !== SPECIAL_FOLDERS.TRASH) {
        if (this.showSubfolderItems) {
          // 穿透模式：显示所有后代文件夹
          const descendantIds = this.library.getAllDescendantFolders(this.currentFolderId);
          subfolders = [...descendantIds]
            .map(id => this.library.getFolder(id))
            .filter(f => f)
            .sort((a, b) => naturalCompare(a.name, b.name))
            .map(addCoverImage);
        } else {
          // 非穿透：只显示直接子文件夹
          subfolders = this.library.getDirectChildFolders(this.currentFolderId)
            .map(addCoverImage);
        }
      }
    }

    // 统计数据
    const stats = {
      totalItems: this.library.itemsCache.size,
      totalFolders: Object.keys(allFolders).length,
      totalTags: 0
    };

    const selectedCount = this.selectedItems?.size || 0;

    // 构建文件夹树结构（sidebar 模板需要树形数组，不是扁平 object）
    const folderTree = this._buildFolderTree(SPECIAL_FOLDERS.ROOT, allFolders);

    // 计算选中项的详情数据 (用于右侧详情面板)
    // ⚠️ 同步点 2/3：新增字段须同步到 _prepareContext 预览路径(1/3) 和 _closePreview(3/3)
    // 计划：抽取为 _buildSelectedDetail() 共享方法（见 计划/OV/抽取_buildSelectedDetail共享方法.md）
    let selectedDetail = null;
    if (this.selectedItems?.size === 1) {
      const itemId = this.selectedItems.values().next().value;
      const detailItem = this.library.getItem(itemId) || this.previewItem || this.allItems?.find(i => i.id === itemId) || null;
      if (detailItem) {
        // 准备所属文件夹列表
        selectedDetail = await this._buildSelectedDetail(detailItem, { allFolders });
        /*

        // 这段是旧的内联导入状态逻辑，保留在这里等后面抽完详情构建再删。
        if (false && selectedDetail.type === 'scene') {
          // 世界场景现在走按世界隔离的绑定，不再直接信任旧的 metadata.worldSceneId。
          if (selectedDetail.metadata?.worldSceneId) {
            const wsId = selectedDetail.metadata.worldSceneId;
            const worldScene = game.scenes.get(wsId);
            selectedDetail.isImported = !!worldScene;
            selectedDetail.worldId = worldScene?.id || wsId;
          } else if (selectedDetail.uuid) {
            // 合集包场景：通过 UUID 检查
            if (this.previewItem?.isImported && this.previewItem?.uuid === selectedDetail.uuid) {
              selectedDetail.isImported = true;
              selectedDetail.worldId = this.previewItem.worldId || null;
            } else {
              const sceneUuid = selectedDetail.uuid;
              const worldScene = game.scenes.find(s =>
                s._stats?.compendiumSource === sceneUuid ||
                s.flags?.core?.sourceId === sceneUuid
              );
              selectedDetail.isImported = !!worldScene;
              selectedDetail.worldId = worldScene?.id || null;
            }
          }
        }

        // 对物品类型，获取富文本描述和系统字段
        if (false && selectedDetail.type === 'item' && selectedDetail.uuid) {
          // 先检查物品是否已导入到世界
          let worldItem = null;
          if (game.items) {
            worldItem = game.items.find(i =>
              i._stats?.compendiumSource === selectedDetail.uuid ||
              i.flags?.core?.sourceId === selectedDetail.uuid
            );
            selectedDetail.isItemImported = !!worldItem;
            selectedDetail.worldItemUuid = worldItem?.uuid || null;
          }

          // 已导入 → 从世界物品取数据（可编辑）；未导入 → 从 Compendium 取
          const docUuid = worldItem ? worldItem.uuid : selectedDetail.uuid;
          try {
            const itemDoc = await fromUuid(docUuid);
            if (itemDoc) {
              // 富文本描述
              const rawDesc = itemDoc.system?.description?.value || '';
              if (rawDesc) {
                selectedDetail.enrichedDescription = await TextEditor.enrichHTML(rawDesc, {
                  async: true,
                  relativeTo: itemDoc
                });
              }
              // 系统字段 (稀有度、价格、重量等)
              selectedDetail.systemFields = extractSystemFieldValues({ systemData: itemDoc.system });
              selectedDetail.itemType = itemDoc.type;
              selectedDetail.itemSubtype = getSubTypeLabel(itemDoc.type);
            }
          } catch (err) {
            // 物品可能不可达，静默忽略
          }
        }

        // 对角色类型，获取传记富文本和导入状态
        if (false && selectedDetail.type === 'actor' && selectedDetail.uuid) {
          // 检查角色是否已导入到世界
          let worldActor = null;
          if (game.actors) {
            worldActor = game.actors.find(a =>
              a._stats?.compendiumSource === selectedDetail.uuid ||
              a.flags?.core?.sourceId === selectedDetail.uuid
            );
            selectedDetail.isActorImported = !!worldActor;
            selectedDetail.worldActorUuid = worldActor?.uuid || null;
          }

          // 已导入 → 从世界角色取数据；未导入 → 从 Compendium 取
          const docUuid = worldActor ? worldActor.uuid : selectedDetail.uuid;
          try {
            const actorDoc = await fromUuid(docUuid);
            if (actorDoc) {
              // 传记描述（通用路径：大部分系统用 system.details.biography.value 或 system.description.value）
              const rawBio = actorDoc.system?.details?.biography?.value
                || actorDoc.system?.details?.biography
                || actorDoc.system?.description?.value
                || actorDoc.system?.biography?.value
                || '';
              if (rawBio) {
                selectedDetail.enrichedDescription = await TextEditor.enrichHTML(rawBio, {
                  async: true,
                  relativeTo: actorDoc
                });
              }
              selectedDetail.actorType = actorDoc.type;
            }
          } catch (err) {
            // 角色可能不可达，静默忽略
          }
        */
      }
    }

    // 多选详情 (用于批量操作面板)
    let multiSelectDetail = null;
    if (this.selectedItems?.size > 1) {
      const selectedArray = [];
      for (const id of this.selectedItems) {
        const item = this.library.getItem(id) || this.allItems?.find(i => i.id === id);
        if (item) selectedArray.push(item);
      }

      if (selectedArray.length > 1) {
        // Gather thumbnails for stacked preview (latest 4 — rolling window)
        const thumbnails = selectedArray.slice(-4).map(item =>
          item.thumbnail || item.path
        ).filter(Boolean);

        // Compute shared tags (intersection)
        const tagSets = selectedArray.map(item => new Set(item.tags || []));
        const sharedTagIds = [...tagSets[0]].filter(tagId =>
          tagSets.every(s => s.has(tagId))
        );
        const sharedTags = sharedTagIds.map(tagId => this.library.getTag(tagId)).filter(t => t);

        // Compute shared folders (intersection)
        const folderSets = selectedArray.map(item => new Set(item.folders || []));
        const sharedFolderIds = [...folderSets[0]].filter(folderId =>
          folderSets.every(s => s.has(folderId))
        );
        const sharedFolders = sharedFolderIds.map(fid => {
          const f = this.library.getFolder(fid);
          if (!f && fid !== SPECIAL_FOLDERS.ROOT) return null;
          return {
            id: fid,
            name: f?.name || (fid === SPECIAL_FOLDERS.ROOT ? t('origin-vault.folders.root') : fid.slice(0, 6)),
            color: f?.color || '#FFD700',
            isRoot: fid === SPECIAL_FOLDERS.ROOT
          };
        }).filter(f => f !== null);

        // Compute shared rating (if all same)
        const ratings = selectedArray.map(item => item.rating || 0);
        const sharedRating = ratings.every(r => r === ratings[0]) ? ratings[0] : null;

        // Stars for rating display
        const stars = Array.from({ length: 5 }, (_, i) => ({
          value: i + 1,
          filled: sharedRating !== null && (i + 1) <= sharedRating
        }));

        // 选中集里有几个音频，决定批量面板要不要冒出"加入播放清单"按钮
        const audioCount = selectedArray.filter(it =>
          FILE_TYPES.AUDIO.some(ext => (it.path || '').toLowerCase().endsWith(ext))
        ).length;

        multiSelectDetail = {
          count: selectedArray.length,
          audioCount,
          thumbnails,
          sharedTags,
          sharedFolders,
          sharedRating,
          stars
        };
      }
    }

    return {
      currentFolder,
      items,
      subfolders,
      folderTree,
      smartFolders: this._buildSmartFolderEntries(),
      stats,
      selectedDetail,
      multiSelectDetail,
      // UI 状态
      currentFolderId: this.currentFolderId,
      activeType: this.activeType,
      searchQuery: this.searchQuery,
      searchMode: this.searchMode,
      filters: this.filters,
      viewMode: this.fileBrowserState?.viewMode || 'grid',
      sortOrder: 'date-desc',
      // 拖拽状态
      dragMode: this.dragMode,
      // 选中状态
      selectedItems: Array.from(this.selectedItems || []),
      selectedCount,
      allSelected: items.length > 0 && items.length === selectedCount,
      // 界面显隐
      browserVisible: this.browserVisible,
      sceneBrowserVisible: this.sceneBrowserVisible,
      isWindowed: this.isWindowed,
      // 预览
      previewItem: this.previewItem,
      isSmartFolderView,
      // --- 以下为 V1 getData 中存在但 _prepareContext 遗漏的字段 ---
      specialFolders: this._buildSpecialFolderEntries(stats),
      settings: this.library.getAllSettings(),
      cacheBust: Date.now(),
      currentFolderName: currentFolder?.name || t('origin-vault.folders.root'),
      currentFolderItemCount: items.length,
      scenePacks: this._getScenePacks(),
      worldScenes: this._getWorldScenes(),
      // 物品浏览器数据
      itemBrowserVisible: this.itemBrowserVisible,
      itemPackEntries: this.itemBrowserVisible ? this._getItemPackEntries() : [],
      worldItems: [],
      // 角色浏览器数据
      actorBrowserVisible: this.actorBrowserVisible,
      actorPackEntries: this.actorBrowserVisible ? this._getActorPacks() : [],
      compendiumBatch: this._getCompendiumBatchContext(),
      // V2 Context
      tab: options.tab
    };
  }

  constructor(options = {}) {
    super(options);

    /** @type {LibraryData} */
    this.library = LibraryData.getInstance();

    /** @type {object} 资源适配器映射 */
    this.adapters = {
      [ASSET_TYPES.IMAGE]: new FileSystemAdapter(this.library.basePath),
      [ASSET_TYPES.SCENE]: new SceneAdapter(this.library.basePath),
      [ASSET_TYPES.ITEM]: new ItemAdapter(),
      [ASSET_TYPES.ACTOR]: new ActorAdapter()
    };

    /** @type {string} 当前激活的资源类型 */
    this.activeType = ASSET_TYPES.IMAGE;

    /** @type {VaultAdapter} 当前使用的适配器 */
    this.currentAdapter = this.adapters[this.activeType];

    /** @type {string} 当前选中的文件夹 ID */
    this.currentFolderId = SPECIAL_FOLDERS.ALL;

    /** @type {boolean} 是否显示子文件夹内容（文件夹穿透） */
    this.showSubfolderItems = true;

    /** @type {Set<string>} 选中的素材 ID */
    this.selectedItems = new Set();

    // 拖拽相关状态
    this.dragMode = 'move'; // 'move' or 'copy'
    this.dragExpandTimer = null;
    this.autoExpandedFolders = new Set();
    this.autoScrollInterval = null;
    this.dragLastFolderId = null;

    /** @type {boolean} 文件浏览器是否可见 */
    this.browserVisible = false;

    /** @type {boolean} 场景浏览器是否可见 */
    this.sceneBrowserVisible = false;

    /** @type {boolean} 物品浏览器是否可见 */
    this.itemBrowserVisible = false;

    /** @type {boolean} 角色浏览器是否可见 */
    this.actorBrowserVisible = false;

    /** @type {string} 文件浏览器当前路径 */
    this.browserPath = '';

    /** @type {string} 搜索关键词 */
    this.searchQuery = '';

    /** @type {string} 搜索模式 'fuzzy' | 'exact' */
    this.searchMode = 'fuzzy';

    /** @type {object} 筛选条件 */
    this.filters = {
      tags: [],
      minRating: 0,
      fileTypes: []
    };

    /** @type {FilterPanel} 筛选面板实例 */
    this.filterPanel = null;

    /** @type {FileBrowser} */
    this.fileBrowser = null;

    /** @type {LibrarySelector} */
    this.librarySelector = null;

    /** @type {object|null} 当前预览的素材 */
    this.previewItem = null;

    /** @type {object} 预览试图状态 (缩放/平移) */
    this.previewState = {
      scale: 1,
      panX: 0,
      panY: 0,
      isDragging: false,
      lastMouseX: 0,
      lastMouseY: 0,
      rotation: 0
    };

    /** @type {boolean} 是否为窗口模式 */
    this.isWindowed = false;

    /** @type {boolean} 是否临时让 OV 工作区壳让位 */
    this._workspaceShellSuspended = false;

    /** @type {object} 文件浏览器状态保持 */
    this.fileBrowserState = {
      currentPath: '',
      history: [],
      historyIndex: -1,
      viewMode: 'grid',
      gridSize: 100
    };

    /** @type {Map<string, HTMLVideoElement>} 视频预加载缓存 */
    this.videoPreloadCache = new Map();

    /** @type {IntersectionObserver} 视频预加载观察器 */
    this.videoPreloadObserver = null;

    // ===== 虚拟滚动相关状态 =====
    /** @type {Map<string, {top: number, left: number, width: number, height: number}>} 素材位置索引 */
    this.itemPositions = new Map();

    /** @type {number} 虚拟滚动容器总高度 */
    this.virtualTotalHeight = 0;

    /** @type {Set<string>} 当前已渲染的素材 ID */
    this.renderedItems = new Set();

    /** @type {number} 虚拟滚动缓冲区大小 (像素) */
    this.virtualBuffer = 300;

    /** @type {boolean} 是否启用虚拟滚动 */
    this.virtualScrollEnabled = true;

    /** @type {number} 虚拟滚动触发阈值 (素材数量): 0 = 始终使用虚拟滚动 */
    this.virtualScrollThreshold = 0;

    /** @type {Array} 当前文件夹的所有素材 (用于虚拟滚动计算) */
    this.allItems = [];

    /** @type {Array|null} 排序后的素材缓存 (避免重复 sort + map) */
    this._sortedItemsCache = null;
    /** @type {string} 排序缓存的 key */
    this._sortedItemsCacheKey = '';

    /** @type {number} 滚动防抖定时器 */
    this._scrollDebounceTimer = null;

    // 绑定事件处理函数，确保 context 正确并能在 close 时解绑
    this._boundTagCreated = this._onTagCreated.bind(this);
    this._boundTagUpdated = this._onTagUpdated.bind(this);
    this._boundTagDeleted = this._onTagDeleted.bind(this);
    this._boundItemUpdated = this._onItemUpdated.bind(this);

    // 注册全局 Hook 监听器
    Hooks.on(EVENTS.TAG_CREATED, this._boundTagCreated);
    Hooks.on(EVENTS.TAG_UPDATED, this._boundTagUpdated);
    Hooks.on(EVENTS.TAG_DELETED, this._boundTagDeleted);
    Hooks.on(EVENTS.ITEM_UPDATED, this._boundItemUpdated);

    // 注册场景变更 Hook (导入/删除时实时更新角标)
    this._boundOnSceneCreate = this._onSceneChange.bind(this, 'create');
    this._boundOnSceneDelete = this._onSceneChange.bind(this, 'delete');
    Hooks.on('createScene', this._boundOnSceneCreate);
    Hooks.on('deleteScene', this._boundOnSceneDelete);

    this._boundOnWorldItemCreate = this._onWorldItemChange.bind(this, 'create');
    this._boundOnWorldItemDelete = this._onWorldItemChange.bind(this, 'delete');
    Hooks.on('createItem', this._boundOnWorldItemCreate);
    Hooks.on('deleteItem', this._boundOnWorldItemDelete);

    this._boundOnWorldActorCreate = this._onWorldActorChange.bind(this, 'create');
    this._boundOnWorldActorDelete = this._onWorldActorChange.bind(this, 'delete');
    Hooks.on('createActor', this._boundOnWorldActorCreate);
    Hooks.on('deleteActor', this._boundOnWorldActorDelete);

    // ===== 文件选择器模式 =====
    /** @type {boolean} 是否处于文件选择器模式 */
    this.filePickerMode = false;

    /** @type {Function|null} 文件选择器回调 */
    this.filePickerCallback = null;
    this.filePickerField = null;

    /** @type {object|null} 文件选择器选项 */
    this.filePickerOptions = null;

    /** @type {object|null} 原始 FilePicker 实例引用 (用于 AA/V13 兼容) */
    this.filePickerInstance = null;

    // 这一阶段先把全局提层逻辑收起来。
    // 现在普通原生窗口回到 Foundry 自己管理，MainWindow 这里只保留一个轻量清理入口，
    // 方便窗口模式切换时顺手把历史残留的类名和内联样式擦干净。
    this._shouldManageFloatingLayers = false;
    this._floatingLayerSelectors = '';
    this._managedFloatingLayers = new Set();
    this._elevateKnownFloatingLayers = null;
    this._globalZObserverConnected = false;
    this._globalZObserver = null;
  }

  _clearManagedZLayers() {
    document.querySelectorAll('.ov-floating-above-vault').forEach(el => {
      el.classList.remove('ov-floating-above-vault');
      el.style.removeProperty('z-index');
    });
    this._managedFloatingLayers?.clear?.();
    document.documentElement.style.removeProperty('--ov-floating-z');
  }

  _syncGlobalLayerManagement({ clearElevations = true } = {}) {
    this._disconnectGlobalZObserver({ clearElevations });
  }

  _connectGlobalZObserver() {
    // 接口先留着，后面如果真要恢复某类特殊浮层处理，不用再改调用方。
    return;
  }

  _disconnectGlobalZObserver({ clearElevations = true } = {}) {
    if (this._globalZObserverConnected) {
      this._globalZObserver.disconnect();
      this._globalZObserverConnected = false;
    }

    if (clearElevations) {
      this._clearManagedZLayers();
    }
  }

  // ==================== 独立面板渲染方法 (模块化) ====================

  // _renderSidebar → SidebarMixin.js

  /**
   * 重新绑定侧边栏事件监听器
   * 用于 _renderSidebar 部分渲染后重新绑定
   * @param {jQuery} html - 侧边栏容器
   */
  _activateSidebarListeners(html) {
    // 新建文件夹按钮
    html.find('.btn-new-folder').on('click', () => {
      this._onCreateFolder();
    });

    html.find('.btn-new-smart-folder').on('click', (event) => {
      event.stopPropagation();
      this._onCreateSmartFolder();
    });

    html.find('.smart-folder').on('click', (event) => {
      event.stopPropagation();
      const folderId = event.currentTarget.dataset.folderId;
      if (folderId) this._onFolderClick(folderId);
    });

    html.find('.smart-folder').on('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const folderId = event.currentTarget.dataset.folderId;
      if (folderId) this._onSmartFolderContextMenu(event, folderId);
    });

    html.find('.btn-smart-folder-menu').on('click', (event) => {
      event.stopPropagation();
      const folderId = event.currentTarget.dataset.folderId;
      if (folderId) this._onSmartFolderContextMenu(event, folderId);
    });

    // 点击文件夹
    html.find('.folder-item').on('click', (event) => {
      event.stopPropagation();
      const folderId = event.currentTarget.dataset.folderId;
      if (folderId) this._onFolderClick(folderId);
    });

    // 资源类型切换
    html.find('.type-tab').on('click', (event) => {
      event.stopPropagation();
      const type = event.currentTarget.dataset.type;
      if (type) this._onSwitchType(type);
    });

    // 双击文件夹（重命名）
    html.find('.folder-item .folder-name').on('dblclick', (event) => {
      event.stopPropagation();
      const folderId = event.currentTarget.closest('.folder-item')?.dataset.folderId;
      if (folderId) this._onFolderRename(folderId);
    });

    // 文件夹折叠/展开
    html.find('.folder-toggle').on('click', (event) => {
      event.stopPropagation();
      const folderId = event.currentTarget.closest('.folder-item')?.dataset.folderId;
      if (folderId) this._onFolderToggle(folderId);
    });

    // 文件夹右键菜单
    html.find('.folder-item').on('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const folderId = event.currentTarget.dataset.folderId;
      if (folderId) this._onFolderContextMenu(event, folderId);
    });

    // Eagle 风格文件夹交互 - 悬停操作按钮
    html.find('.btn-add-subfolder').on('click', (event) => {
      event.stopPropagation();
      event.preventDefault();
      const folderId = event.currentTarget.dataset.folderId;
      console.warn(`${MODULE_ID} | btn-add-subfolder CLICKED for folderId=${folderId}`);
      if (folderId) this._onCreateSubfolderInline(folderId);
    });

    html.find('.btn-folder-menu').on('click', (event) => {
      event.stopPropagation();
      const folderId = event.currentTarget.dataset.folderId;
      if (folderId) this._onFolderContextMenu(event, folderId);
    });

    // 文件夹拖拽 - dragstart
    html.find('.folder-item[draggable="true"]').on('dragstart', (event) => {
      const folderId = event.currentTarget.dataset.folderId;
      if (folderId && folderId !== SPECIAL_FOLDERS.ROOT) {
        const dt = event.originalEvent.dataTransfer;
        dt.setData('text/folder-id', folderId);
        dt.effectAllowed = 'move';
        event.currentTarget.classList.add('dragging');

        // Create custom drag ghost (Eagle-style)
        const folderName = event.currentTarget.querySelector('.folder-name')?.innerText?.trim() || ovText('Folder', 'Папка');
        const ghost = document.createElement('div');
        ghost.className = 'ov-drag-ghost';
        ghost.innerHTML = `<i class="fas fa-folder"></i> <span>${folderName}</span>`;
        document.body.appendChild(ghost);

        // Set drag image (offset slightly so cursor is on the left)
        dt.setDragImage(ghost, 10, 10);

        // Remove ghost after it's captured
        setTimeout(() => ghost.remove(), 0);

      } else {
        event.preventDefault();
      }
    });


    // 文件夹拖拽 - dragend
    html.find('.folder-item[draggable="true"]').on('dragend', (event) => {
      event.currentTarget.classList.remove('dragging');
      html.find('.folder-item-wrapper').removeClass('drag-over drag-over-above drag-over-below');

      this._clearDragExpandTimer();
      this._stopAutoScroll();
      this.autoExpandedFolders.clear();
      this.dragLastFolderId = null;

      // 如果有待刷新的文件夹（子文件夹容器不存在的情况），现在可以安全刷新
      if (this._pendingFolderRefresh) {
        this._pendingFolderRefresh = false;
        this._renderSidebar();
      }
    });

    // 文件夹容器拖拽 - 边缘滚动
    html.find('.folder-tree-content').on('dragover', (event) => {
      event.preventDefault();
      const draggedFolderId = event.originalEvent.dataTransfer.types.includes('text/folder-id');
      if (draggedFolderId) {
        this._handleAutoScroll(event.originalEvent.clientY);
        event.originalEvent.dataTransfer.dropEffect = 'move';
      }
    });

    // 文件夹容器 - drop
    html.find('.folder-tree-content').on('drop', async (event) => {
      if (event.target === event.currentTarget) {
        event.preventDefault();
        this._stopAutoScroll();

        const draggedFolderId = event.originalEvent.dataTransfer.getData('text/folder-id');
        if (draggedFolderId) {
          const folder = this.library.getFolder(draggedFolderId);
          if (folder && folder.parent !== SPECIAL_FOLDERS.ROOT) {
            this.library.moveFolder(draggedFolderId, SPECIAL_FOLDERS.ROOT);
            await this._refreshAfterFolderTreeChange();
          }
        } else {
          await this._handleBrowserFileDrop(event.originalEvent, SPECIAL_FOLDERS.ROOT);
        }
      }
    });

    // 文件夹拖拽 - dragover (在 wrapper 上监听)
    html.find('.folder-item-wrapper').on('dragover', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const wrapper = event.currentTarget;
      const folderId = wrapper.dataset.folderId;

      const types = event.originalEvent.dataTransfer.types;
      const typesArray = types ? Array.from(types) : [];

      const hasFolderDrag = typesArray.includes('text/folder-id');
      const hasBrowserFiles = typesArray.includes('application/x-origin-vault-browser-files');
      const hasLibraryItem = typesArray.includes('application/x-origin-vault-item');
      const hasTextStr = typesArray.includes('text/plain');

      const isBrowserOrLibrary = hasBrowserFiles || hasLibraryItem || (hasTextStr && !hasFolderDrag);

      if ((hasFolderDrag || isBrowserOrLibrary) && folderId) {
        this._handleAutoScroll(event.originalEvent.clientY);

        html.find('.folder-item-wrapper').not(wrapper).removeClass('drag-over drag-over-above drag-over-below browser-file-drag-over');

        if (hasFolderDrag) {
          const rect = wrapper.getBoundingClientRect();
          const y = event.originalEvent.clientY - rect.top;
          const height = rect.height;

          let action = 'into';

          if (y < height * 0.25) {
            wrapper.classList.add('drag-over-above');
            wrapper.classList.remove('drag-over', 'drag-over-below', 'browser-file-drag-over');
            action = 'above';
          } else if (y > height * 0.75) {
            wrapper.classList.add('drag-over-below');
            wrapper.classList.remove('drag-over', 'drag-over-above', 'browser-file-drag-over');
            action = 'below';
          } else {
            wrapper.classList.add('drag-over');
            wrapper.classList.remove('drag-over-above', 'drag-over-below', 'browser-file-drag-over');
            action = 'into';
          }

          if (action === 'into') {
            this._handleDragExpandLogic(folderId);
          } else {
            this._clearDragExpandTimer();
            this.dragLastFolderId = null;
          }
        } else {
          let isRootRestricted = false;

          if (hasBrowserFiles) {
            isRootRestricted = false;
          } else if (hasLibraryItem) {
            isRootRestricted = false;
          } else {
            isRootRestricted = false;
          }

          if (isRootRestricted) {
            const folder = this.library.getFolder(folderId);
            const isRootFolder = folder && (folder.parent === SPECIAL_FOLDERS.ROOT);
            if (isRootFolder) {
              wrapper.classList.add('browser-file-drag-over');
              wrapper.classList.remove('drag-over', 'drag-over-above', 'drag-over-below');
              this._handleDragExpandLogic(folderId);
            }
          } else {
            wrapper.classList.add('drag-over');
            wrapper.classList.remove('drag-over-above', 'drag-over-below', 'browser-file-drag-over');
            this._handleDragExpandLogic(folderId);
          }
        }
      }
    });

    // 文件夹拖拽 - dragleave
    html.find('.folder-item-wrapper').on('dragleave', (event) => {
      const relatedTarget = event.originalEvent.relatedTarget;
      if (!event.currentTarget.contains(relatedTarget)) {
        const folderId = event.currentTarget.dataset.folderId;
        event.currentTarget.classList.remove('drag-over', 'drag-over-above', 'drag-over-below', 'browser-file-drag-over');

        if (this.dragLastFolderId === folderId) {
          this._clearDragExpandTimer();
          this.dragLastFolderId = null;
        }

        this._checkAutoCollapse(folderId);
      }
    });

    // 文件夹拖拽 - drop
    html.find('.folder-item-wrapper').on('drop', async (event) => {
      this._stopAutoScroll();

      event.preventDefault();
      event.stopPropagation();
      const wrapper = event.currentTarget;
      const targetFolderId = wrapper.dataset.folderId;
      const draggedFolderId = event.originalEvent.dataTransfer.getData('text/folder-id');

      wrapper.classList.remove('drag-over', 'drag-over-above', 'drag-over-below', 'browser-file-drag-over');

      if (draggedFolderId && targetFolderId && draggedFolderId !== targetFolderId) {
        const rect = wrapper.getBoundingClientRect();
        const y = event.originalEvent.clientY - rect.top;
        const height = rect.height;

        let action = 'into';
        if (y < height * 0.25) action = 'above';
        else if (y > height * 0.75) action = 'below';

        if (action === 'into') {
          await this._onFolderDrop(draggedFolderId, targetFolderId);
        } else {
          const targetFolder = this.library.getFolder(targetFolderId);
          if (targetFolder) {
            const parentId = targetFolder.parent || SPECIAL_FOLDERS.ROOT;

            if (this._isDescendant(targetFolderId, draggedFolderId)) {
              ui.notifications.warn(t('origin-vault.folders.cannotMoveToSub'));
              return;
            }

            if (parentId !== draggedFolderId) {
              const placement = action === 'above'
                ? { beforeId: targetFolderId }
                : { afterId: targetFolderId };
              this.library.moveFolder(draggedFolderId, parentId, placement);
              await this._refreshAfterFolderTreeChange();
            }
          }
        }
      } else if (targetFolderId) {
        // 优先处理库内素材拖拽 (origin-vault-item)
        let itemDataStr = event.originalEvent.dataTransfer.getData('application/x-origin-vault-item');
        if (!itemDataStr) itemDataStr = event.originalEvent.dataTransfer.getData('text/plain');

        let handled = false;
        if (itemDataStr) {
          try {
            const itemData = JSON.parse(itemDataStr);
            if (itemData.originVault && itemData.originVault.type === 'origin-vault-items') {
              const { itemIds, sourceFolderId } = itemData.originVault;
              // 虚拟文件夹（全部素材、收藏夹、最近使用等）下的拖拽始终为复制
              const isSpecialFolder = sourceFolderId.startsWith('__');

              for (const itemId of itemIds) {
                if (isSpecialFolder) {
                  this.library.copyItemToFolder(itemId, targetFolderId);
                } else {
                  // 穿透模式下，sourceFolderId 可能是父文件夹，但素材实际在子文件夹中
                  const item = this.library.getItem(itemId);
                  let actualSource = sourceFolderId;
                  if (item && !item.folders.includes(sourceFolderId)) {
                    actualSource = item.folders[0] || sourceFolderId;
                  }
                  this.library.moveItem(itemId, actualSource, targetFolderId);
                }
              }

              await this._renderSidebar();
              await this._renderAssetGrid();
              this._renderDetailsPanel();
              ui.notifications.info(isSpecialFolder
                ? t('origin-vault.notifications.itemCopied')
                : t('origin-vault.notifications.itemMoved'));
              handled = true;
            }
          } catch (e) {
            // 非 JSON 或解析失败，继续尝试浏览器文件
          }
        }

        // 如果不是库内素材，尝试处理浏览器文件拖拽
        if (!handled) {
          await this._handleBrowserFileDrop(event.originalEvent, targetFolderId);
        }
      }
    });

    // 特殊文件夹点击
    html.find('.special-folder').on('click', (event) => {
      const folderId = event.currentTarget.dataset.folderId;
      if (folderId) this._onFolderClick(folderId);
    });

    // 特殊文件夹 - dragover
    html.find('.special-folder').on('dragover', (event) => {
      event.preventDefault();
      const hasBrowserFiles = event.originalEvent.dataTransfer.types.includes('text/plain');
      if (hasBrowserFiles) {
        event.currentTarget.classList.add('browser-file-drag-over');
      }
    });

    // 特殊文件夹 - dragleave
    html.find('.special-folder').on('dragleave', (event) => {
      const relatedTarget = event.originalEvent.relatedTarget;
      if (!event.currentTarget.contains(relatedTarget)) {
        event.currentTarget.classList.remove('browser-file-drag-over');
      }
    });

    // 特殊文件夹 - drop
    html.find('.special-folder').on('drop', async (event) => {
      event.preventDefault();
      event.currentTarget.classList.remove('browser-file-drag-over');
      const folderId = event.currentTarget.dataset.folderId;

      const targetFolder = (folderId === SPECIAL_FOLDERS.ALL || folderId === SPECIAL_FOLDERS.UNCATEGORIZED)
        ? SPECIAL_FOLDERS.ROOT
        : SPECIAL_FOLDERS.ROOT;

      await this._handleBrowserFileDrop(event.originalEvent, targetFolder);
    });
  }

  /**
   * 获取当前视口顶部的锚点素材 ID 列表
   * 用于在重新布局（如缩放、删除）后恢复视觉位置
   * @returns {Array<{id: string, offset: number}>} 锚点对象列表
   */
  _capturePreferredScrollAnchors({ preferSelected = false } = {}) {
    if (!preferSelected) {
      return this._getAnchorItemIds();
    }

    const selectedItemId = this.selectedItems?.size === 1
      ? this.selectedItems.values().next().value
      : null;
    const gridContainer = $(this.element)?.find('.asset-grid');

    if (!selectedItemId || !gridContainer?.length || !this.itemPositions?.size) {
      return this._getAnchorItemIds();
    }

    const pos = this.itemPositions.get(selectedItemId);
    if (!pos) {
      return this._getAnchorItemIds();
    }

    const scrollTop = gridContainer.scrollTop() || 0;
    const viewportHeight = gridContainer.height() || 0;
    const subfoldersOffset = this._getSubfoldersOffset(gridContainer[0]);
    const itemTop = pos.top + subfoldersOffset;
    const itemBottom = itemTop + pos.height;
    const isVisible = itemBottom > scrollTop && itemTop < scrollTop + viewportHeight;

    if (!isVisible) {
      return this._getAnchorItemIds();
    }

    return [{ id: selectedItemId, offset: itemTop - scrollTop }];
  }

  _isSelectedItemCurrentlyVisible() {
    const selectedItemId = this.selectedItems?.size === 1
      ? this.selectedItems.values().next().value
      : null;

    if (!selectedItemId) return false;

    const gridContainer = $(this.element)?.find('.asset-grid');
    if (!gridContainer?.length) return false;

    const scrollTop = gridContainer.scrollTop() || 0;
    const viewportHeight = gridContainer.height() || 0;
    const pos = this.itemPositions?.get(selectedItemId);

    if (pos) {
      const subfoldersOffset = this._getSubfoldersOffset(gridContainer[0]);
      const itemTop = pos.top + subfoldersOffset;
      const itemBottom = itemTop + pos.height;
      return itemBottom > scrollTop && itemTop < scrollTop + viewportHeight;
    }

    const card = this.element?.querySelector(`.asset-card:not(.ov-compare-card)[data-item-id="${selectedItemId}"]`);
    if (!card) return false;

    const containerRect = gridContainer[0].getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    return cardRect.bottom > containerRect.top && cardRect.top < containerRect.bottom;
  }

  _scheduleKeepSelectedItemVisible() {
    const selectedItemId = this.selectedItems?.size === 1
      ? this.selectedItems.values().next().value
      : null;

    if (!selectedItemId || typeof this._ensureItemVisible !== 'function') return;

    if (this._keepSelectedVisibleTimer) {
      clearTimeout(this._keepSelectedVisibleTimer);
      this._keepSelectedVisibleTimer = null;
    }

    requestAnimationFrame(() => this._ensureItemVisible(selectedItemId));
    this._keepSelectedVisibleTimer = setTimeout(() => {
      this._ensureItemVisible(selectedItemId);
      this._keepSelectedVisibleTimer = null;
    }, 550);
  }

  _getAnchorItemIds() {
    ovLog(`${MODULE_ID} | [DEBUG] _getAnchorItemIds() called`);

    const gridContainer = $(this.element)?.find('.asset-grid');
    if (!gridContainer?.length) {
      ovLog(`${MODULE_ID} | [DEBUG] _getAnchorItemIds: NO .asset-grid container found!`);
      return [];
    }

    // 如果没有使用虚拟滚动或没有位置数据，无法计算
    if (!this.itemPositions || this.itemPositions.size === 0) {
      ovLog(`${MODULE_ID} | [DEBUG] _getAnchorItemIds: itemPositions is empty (size: ${this.itemPositions?.size || 0})`);
      return [];
    }

    const scrollTop = gridContainer.scrollTop() || 0;
    ovLog(`${MODULE_ID} | [DEBUG] _getAnchorItemIds: scrollTop=${scrollTop}, itemPositions.size=${this.itemPositions.size}, allItems.length=${this.allItems?.length || 0}`);

    const anchors = [];

    // 寻找位于 scrollTop 附近的项目
    // 简单遍历 (对于 10k items 也是毫秒级)
    // 优化：如果有 this.allItems，顺序通常是接近布局顺序的
    const items = this.allItems || [];

    // Account for subfolders row offset: pos.top is relative to .asset-grid-virtual,
    // but scrollTop is relative to .asset-grid which includes subfolders-row
    const subfoldersOffset = this._getSubfoldersOffset(gridContainer[0]);

    for (const item of items) {
      const pos = this.itemPositions.get(item.id);
      // 如果项目底部在视口顶部下方（即项目可见或部分可见）
      // Compare in .asset-grid coordinate space: item's actual position is pos.top + subfoldersOffset
      if (pos && (pos.top + subfoldersOffset + pos.height > scrollTop)) {
        // 记录相对偏移量: real position of item in scroll container is (pos.top + subfoldersOffset)
        // visibleOffset = how far below the viewport top the item appears
        const visibleOffset = (pos.top + subfoldersOffset) - scrollTop;

        anchors.push({ id: item.id, offset: visibleOffset });
        // 只需要前几个作为候选
        if (anchors.length >= 5) break;
      }
    }

    ovLog(`${MODULE_ID} | [DEBUG] _getAnchorItemIds: found ${anchors.length} anchors`, anchors.slice(0, 2));
    return anchors;
  }

  /**
   * 仅渲染中间素材网格
   * 用于：切换文件夹、搜索、添加/删除素材
   */
  /**
   * 滚动到网格顶部 (清除搜索/筛选时调用)
   */
  _scrollToTop() {
    const grid = $(this.element)?.find('.asset-grid');
    this._scrollAnchorIds = [];
    this._restoreScrollIndex = -1;
    this._fallbackScrollTop = 0;
    this._resetScrollOnRender = true;
    this._skipScrollRestore = true;
    this._forceTopScrollOnNextGridRender = true;

    if (grid?.length) grid.scrollTop(0);
  }

  async _renderAssetGrid() {
    if (!this.element) return;

    // 失效排序缓存，确保每次重渲染都使用最新数据
    this._sortedItemsCache = null;

    // 1. 在重新渲染前，捕获当前视觉锚点
    // 这解决了添加/删除文件时滚动条跳动的问题
    // 注意：如果 _scrollAnchorIds 已经由 render() 设置，不要覆盖它
    const forceTopScroll = !!this._forceTopScrollOnNextGridRender;
    const skipAnchorCapture = !!this._skipAnchorCaptureOnNextGridRender;
    if (forceTopScroll) {
      this._scrollAnchorIds = [];
      this._restoreScrollIndex = -1;
      this._fallbackScrollTop = 0;
      ovLog(`${MODULE_ID} | _renderAssetGrid: forcing top-of-grid render`);
    } else if (skipAnchorCapture) {
      this._scrollAnchorIds = [];
      this._restoreScrollIndex = -1;
      this._fallbackScrollTop = 0;
      this._skipAnchorCaptureOnNextGridRender = false;
      ovLog(`${MODULE_ID} | _renderAssetGrid: skipping anchor capture for folder navigation`);
    } else if (!this._scrollAnchorIds || this._scrollAnchorIds.length === 0) {
      this._scrollAnchorIds = this._getAnchorItemIds();

      // 备用方案：如果锚点逻辑失败，至少保存原始 scrollTop
      const gridContainer = $(this.element)?.find('.asset-grid');
      const oldScrollTop = gridContainer?.scrollTop() || 0;
      this._fallbackScrollTop = oldScrollTop;

      ovLog(`${MODULE_ID} | _renderAssetGrid: captured ${this._scrollAnchorIds.length} anchors, fallback scrollTop: ${oldScrollTop}`);
    } else {
      ovLog(`${MODULE_ID} | _renderAssetGrid: using previously captured ${this._scrollAnchorIds.length} anchors`);
    }

    const data = await this._prepareContext();

    // 缓存网格上下文（用于从预览返回时快速恢复）
    if (!data.previewItem) {
      this._cachedGridContext = data;
    }

    // 存储所有素材 (用于键盘导航和虚拟滚动)
    this.allItems = data.items;

    // 检查是否需要虚拟滚动
    const useVirtualScroll = !data.previewItem && this.virtualScrollEnabled &&
      data.items.length >= this.virtualScrollThreshold;

    ovLog(`${MODULE_ID} | [DEBUG] _renderAssetGrid decision: preview=${!!data.previewItem}, enabled=${this.virtualScrollEnabled}, count=${data.items.length}, threshold=${this.virtualScrollThreshold} -> useVirtualScroll=${useVirtualScroll}`);

    if (useVirtualScroll) {
      // 虚拟滚动模式
      ovLog(`${MODULE_ID} | Using virtual scroll for ${data.items.length} items`);

      // 存储所有素材 (用于虚拟滚动)
      this.allItems = data.items;
      this.renderedItems.clear();

      // 渲染虚拟滚动容器 (不包含素材卡片)
      const virtualGridHtml = await this._compileVirtualGridPartial(data);

      const mainContentEl = $(this.element).find('#ov-main-content');
      if (mainContentEl.length) {
        mainContentEl.html(virtualGridHtml);
        this._activateAssetGridListeners(mainContentEl);
        this._initMarqueeSelect();

        // ★ 预览模式下不初始化虚拟滚动（此时 .asset-grid 不存在）
        // 避免 initWithRetry 的 setTimeout 在退出预览后干扰新的布局
        if (data.previewItem) {
          ovLog(`${MODULE_ID} | Skipping virtual scroll init in preview mode`);
        } else {
          // 初始化虚拟滚动 - 等待容器获得有效尺寸
          // 取消之前可能残留的重试计时器
          if (this._initVirtualScrollRetryTimer) {
            clearTimeout(this._initVirtualScrollRetryTimer);
            this._initVirtualScrollRetryTimer = null;
          }

          const initWithRetry = (attempt = 0) => {
            const gridContainer = $(this.element)?.find('.asset-grid');
            const containerWidth = gridContainer?.width();

            if (containerWidth && containerWidth > 100) {
              this._initVirtualScroll();
            } else if (attempt < 15) {
              const delay = Math.min(50 + attempt * 30, 200);
              ovLog(`${MODULE_ID} | Waiting for container to render, attempt ${attempt + 1}, delay ${delay}ms`);
              this._initVirtualScrollRetryTimer = setTimeout(() => initWithRetry(attempt + 1), delay);
            } else {
              console.warn(`${MODULE_ID} | Container width still invalid after retries (width=${containerWidth})`);
              if (this.element) {
                void this.element.offsetHeight;
              }
              this._initVirtualScroll();
            }
          };

          requestAnimationFrame(() => initWithRetry(0));
        }
      }
    } else {
      // 传统模式 (小文件夹)
      ovLog(`${MODULE_ID} | [DEBUG] Using standard grid render for ${data.items.length} items`);
      const gridContent = await this._compileAssetGridPartial(data);

      const mainContentEl = $(this.element).find('#ov-main-content');
      if (mainContentEl.length) {
        mainContentEl.html(gridContent);
        this._activateAssetGridListeners(mainContentEl);
        this._initMarqueeSelect();

        // 传统模式下的滚动恢复 (即使不使用虚拟滚动也应该恢复位置)
        const gridContainer = $(this.element).find('.asset-grid');
        if (forceTopScroll) {
          gridContainer.scrollTop(0);
          this._forceTopScrollOnNextGridRender = false;
        } else if (this._fallbackScrollTop && this._fallbackScrollTop > 0) {
          ovLog(`${MODULE_ID} | [DEBUG] Standard render: restoring scrollTop: ${this._fallbackScrollTop}`);
          gridContainer.scrollTop(this._fallbackScrollTop);
          this._fallbackScrollTop = null;
        }

        // ★ 预览模式下不调度布局和比例检测（.asset-grid 不存在）
        // 否则 _scheduleLayoutRefresh 的 500ms 定时器会在退出预览后
        // 对新的虚拟滚动网格调用 _applyJustifiedLayout，覆盖正确的布局
        if (!data.previewItem) {
          // 重新应用布局
          this._scheduleLayoutRefresh();

          // ★ 修正缓存图片/视频的真实比例（修复瀑布流高度统一的偶发 bug）
          this._initRealTimeAspectRatioDetection(mainContentEl);

          // 重新绘制波形
          this._drawWaveforms();
        }

        // 初始化视频预加载 (需要 jQuery 包装)
        this._initVideoPreloading($(this.element));

        // 初始化悬停刷取 (需要 jQuery 包装)
        this._initHoverScrubbing($(this.element));
      }
    }

    if (!useVirtualScroll) {
      this._forceTopScrollOnNextGridRender = false;
      this._skipAnchorCaptureOnNextGridRender = false;
    }
  }

  /**
   * 使用预缓存的上下文数据渲染网格（跳过 _prepareContext）
   * 用于从预览返回网格时避免重新收集/排序全量素材
   */
  async _renderAssetGridFromContext(data) {
    if (!this.element) return;
    console.time('_renderAssetGridFromContext total');

    this.allItems = data.items;

    const useVirtualScroll = !data.previewItem && this.virtualScrollEnabled &&
      data.items.length >= this.virtualScrollThreshold;

    ovLog(`OriginVault | _renderAssetGridFromContext: items=${data.items.length}, virtualScroll=${useVirtualScroll}`);

    if (useVirtualScroll) {
      this.renderedItems.clear();
      console.time('  compileVirtualGridPartial');
      const virtualGridHtml = await this._compileVirtualGridPartial(data);
      console.timeEnd('  compileVirtualGridPartial');
      const mainContentEl = $(this.element).find('#ov-main-content');
      if (mainContentEl.length) {
        console.time('  DOM insert + listeners');
        mainContentEl.html(virtualGridHtml);
        this._activateAssetGridListeners(mainContentEl);
        this._initMarqueeSelect();
        console.timeEnd('  DOM insert + listeners');
        requestAnimationFrame(() => {
          console.time('  initVirtualScroll (rAF)');
          this._initVirtualScroll();
          console.timeEnd('  initVirtualScroll (rAF)');
        });
      }
    } else {
      console.time('  compileAssetGridPartial');
      const gridContent = await this._compileAssetGridPartial(data);
      console.timeEnd('  compileAssetGridPartial');
      const mainContentEl = $(this.element).find('#ov-main-content');
      if (mainContentEl.length) {
        console.time('  DOM insert + listeners');
        mainContentEl.html(gridContent);
        this._activateAssetGridListeners(mainContentEl);
        this._initMarqueeSelect();
        this._scheduleLayoutRefresh();
        this._drawWaveforms();
        this._initVideoPreloading($(this.element));
        this._initHoverScrubbing($(this.element));
        console.timeEnd('  DOM insert + listeners');
      }
    }
    console.timeEnd('_renderAssetGridFromContext total');

    // 重新保存缓存，下次返回时可复用
    this._cachedGridContext = data;
  }

  /**
   * 编译虚拟滚动网格容器 (不包含素材卡片)
   */
  async _compileVirtualGridPartial(data) {
    // 简化的容器结构
    const subfolderHtml = data.subfolders?.length ? `
      <div class="subfolders-row">
        ${data.subfolders.map(folder => `
          <div class="subfolder-card" data-folder-id="${folder.id}">
            <div class="subfolder-thumbnail" ${folder.coverImage ? `style="background-image: url('${folder.coverImage}');"` : ''}>
              ${folder.coverImage ?
        `<div class="folder-cover-overlay"><i class="fas fa-folder"></i></div>` :
        `<i class="fas fa-folder" style="color: ${folder.color || '#FFD700'}"></i>`
      }
            </div>
            <div class="subfolder-name" title="${folder.name}">${folder.name}</div>
          </div>
        `).join('')}
      </div>
    ` : '';

    return `
      <div class="toolbar">
        <div class="toolbar-left">
          <div class="search-box">
            <i class="fas fa-search"></i>
            <input type="text" class="search-input" placeholder="${t('origin-vault.search.placeholder')}" value="${data.searchQuery || ''}">
            ${data.searchQuery ? `<button class="btn-clear-search"><i class="fas fa-times"></i></button>` : ''}
          </div>
          <button class="btn-toggle-search-mode ${data.searchMode === 'exact' ? 'active' : ''}" 
                  title="${data.searchMode === 'exact' ? t('origin-vault.search.modeExact') : t('origin-vault.search.modeFuzzy')}">
            <i class="fas ${data.searchMode === 'exact' ? 'fa-align-left' : 'fa-magic'}"></i>
          </button>
          <div class="filter-panel-container" style="position: relative;"></div>
          <div class="item-filter-container" style="position: relative;"></div>
        </div>
        <div class="toolbar-center">
          <div class="breadcrumb">
            <span class="breadcrumb-item">${data.currentFolder?.name || t('origin-vault.folders.all')}</span>
            <span class="item-count-badge">${tf('origin-vault.ui.itemsCount', { count: data.items.length })}</span>
            ${data.isSmartFolderView ? '' : `<label class="ov-subfolder-toggle" title="${t('origin-vault.ui.showSubfolderItems')}">
              <input type="checkbox" class="ov-subfolder-checkbox" ${this.showSubfolderItems ? 'checked' : ''}>
              <i class="fas fa-folder-tree"></i>
              <span>${t('origin-vault.ui.showSubfolderItemsShort')}</span>
            </label>`}
          </div>
        </div>
        <div class="toolbar-right">
          <div class="grid-size-control" title="${t('origin-vault.ui.gridSizeTitle')}">
            <i class="fas fa-th-large"></i>
            <input type="range" class="ov-grid-slider" min="100" max="500" value="${data.settings?.gridSize || 200}" step="10">
          </div>
          
          <button class="btn-upload-files" title="${t('origin-vault.upload.title')}" ${!IS_MAD_EDITION && window._ovFileUploadEnabled ? '' : 'style="display:none"'}>
            <i class="fas fa-cloud-upload-alt"></i>
          </button>
          <button class="btn-toggle-browser ${data.browserVisible ? 'active' : ''}" title="${t('origin-vault.browser.title')}" ${!IS_MAD_EDITION && window._ovFileUploadEnabled ? '' : 'style="display:none"'}>
            <i class="fas fa-folder-open"></i>
          </button>
          <button class="btn-toggle-scene-browser ${data.sceneBrowserVisible ? 'active' : ''}" title="${t('origin-vault.scenes.browserTitle')}">
            <i class="fas fa-map"></i>
          </button>
          ${ /* ★★★ ITEM_ACTOR_TOGGLE [2/7] ★★★ 打开 */ ''}
          <button class="btn-toggle-item-browser ${data.itemBrowserVisible ? 'active' : ''}" title="${t('origin-vault.items.browserTitle')}">
            <i class="fas fa-box-open"></i>
          </button>
          <button class="btn-toggle-actor-browser ${data.actorBrowserVisible ? 'active' : ''}" title="${t('origin-vault.actors.browserTitle')}">
            <i class="fas fa-users"></i>
          </button>
          <button class="btn-locate-scene" title="${t('origin-vault.toolbar.locateScene')}">
            <i class="fas fa-crosshairs"></i>
          </button>
          <button class="btn-export-library" title="${t('origin-vault.toolbar.exportLibrary')}">
            <i class="fas fa-file-export"></i>
          </button>
          <button class="btn-import-library" title="${t('origin-vault.toolbar.importLibrary')}">
            <i class="fas fa-file-import"></i>
          </button>

        </div>
      </div>
      <div class="asset-grid grid-view layout-ready virtual-scroll-mode">
        ${subfolderHtml}
        <div class="asset-grid-virtual" style="position: relative; min-height: 100px;">
          <!-- 素材卡片将通过虚拟滚动动态渲染 -->
        </div>
      </div>
    `;
  }

  /**
   * 编译 sidebar partial
   */
  async _compileSidebarPartial(data) {
    const partialTemplate = Handlebars.partials['sidebar'];
    if (!partialTemplate) {
      console.warn('Sidebar partial not found, falling back to full render');
      return '';
    }
    const compiled = typeof partialTemplate === 'function'
      ? partialTemplate
      : Handlebars.compile(partialTemplate);
    return compiled(data);
  }

  /**
   * 编译 asset-grid partial
   */
  async _compileAssetGridPartial(data) {
    const partialTemplate = Handlebars.partials['asset-grid'];
    if (!partialTemplate) {
      console.warn('Asset-grid partial not found, falling back to full render');
      return '';
    }
    const compiled = typeof partialTemplate === 'function'
      ? partialTemplate
      : Handlebars.compile(partialTemplate);
    return compiled(data);
  }

  /**
   * 编译 details-panel partial
   */
  async _compileDetailsPanelPartial(data) {
    const partialTemplate = Handlebars.partials['details-panel'];
    if (!partialTemplate) {
      console.warn('Details-panel partial not found, falling back to full render');
      return '';
    }
    const compiled = typeof partialTemplate === 'function'
      ? partialTemplate
      : Handlebars.compile(partialTemplate);
    return compiled(data);
  }

  // ==================== 完整渲染方法 ====================

  /**
   * 渲染后设置全屏位置
   */
  /**
   * 渲染 (V2)
   * @param {object|boolean} [options={}] - Options object or force boolean (legacy compatibility)
   * @param {object} [legacyOptions={}] - Legacy options if first arg is boolean
   */
  async render(options = {}, legacyOptions = {}) {
    // Handle legacy signature: render(force, options)
    if (typeof options === 'boolean') {
      options = { force: options, ...legacyOptions };
    }

    this._applySubfolderBrowsingDefault();

    // 检查是否需要显示加载遮罩
    this._pendingLibraryLoad = !this.library.loaded;
    ovLog(`${MODULE_ID} | render() called: library.loaded=${this.library.loaded}, pendingLoad=${this._pendingLibraryLoad}, library.basePath=${this.library.basePath}`);

    // 捕获视觉锚点，防止重绘导致滚动位置丢失
    // 这对于缩放、全屏切换等导致的重绘非常重要
    // 但如果 _resetScrollOnRender 已设，说明要回顶，跳过重新捕获
    if (this._resetScrollOnRender) {
      this._scrollAnchorIds = [];
      this._fallbackScrollTop = 0;
      this._sidebarScrollTop = 0;
      this._restoreScrollIndex = -1;
      this._resetScrollOnRender = false;
    } else {
      this._scrollAnchorIds = this._getAnchorItemIds();

      // 备用：保存原始 scrollTop
      const gridContainer = this.element?.querySelector('.asset-grid');
      this._fallbackScrollTop = gridContainer?.scrollTop || 0;

      // 保存文件夹树的滚动位置
      const folderTree = this.element?.querySelector('.folder-tree-content');
      this._sidebarScrollTop = folderTree?.scrollTop || 0;
    }

    ovLog(`${MODULE_ID} | render(): captured ${this._scrollAnchorIds.length} anchors, fallback scrollTop: ${this._fallbackScrollTop}`);

    // 在渲染前保存文件浏览器状态 (如果存在)
    if (this.fileBrowser) {
      this.fileBrowserState = {
        currentPath: this.fileBrowser.currentPath,
        history: this.fileBrowser.history,
        historyIndex: this.fileBrowser.historyIndex,
        viewMode: this.fileBrowser.viewMode,
        gridSize: this.fileBrowser.gridSize,
        source: this.fileBrowser.source,
        bucket: this.fileBrowser.bucket
      };
    }

    return super.render(options);
  }

  /**
   * 渲染后生命周期 (V2)
   * @param {object} context - The prepared context data
   * @param {object} options - Render options
   */
  async _onRender(context, options) {
    await super._onRender(context, options);

    // 检查是否需要显示首次使用引导
    const libraryManager = LibraryManager.getInstance();
    if (!libraryManager.hasAnyLibrary() && !this._firstTimeSetupShown) {
      this._showFirstTimeSetup();
      return;
    }

    // 检查库是否已加载，如果没有则显示加载遮罩
    ovLog(`${MODULE_ID} | _onRender(): pendingLibraryLoad=${this._pendingLibraryLoad}`);
    if (this._pendingLibraryLoad) {
      ovLog(`${MODULE_ID} | _onRender(): Showing loading overlay...`);
      this._showLoadingOverlay();
      try {
        // 确保设置了库路径
        const activeLibrary = libraryManager.getActiveLibrary();
        if (activeLibrary && this.library.basePath !== activeLibrary.path) {
          this.library.setLibraryPath(activeLibrary.path);
        }
        ovLog(`${MODULE_ID} | _onRender(): Loading library data...`);
        await this.library.load();
        ovLog(`${MODULE_ID} | _onRender(): Library loaded, rendering content...`);

        // 同步素材计数到注册表
        const activeId = libraryManager.getActiveLibraryId();
        if (activeId && activeLibrary?.path) {
          libraryManager.updateLibraryStats(activeId, { itemCount: this.library.itemsCache.size }, { path: activeLibrary.path });
        }

        this._applySubfolderBrowsingDefault();

        // 加载完成后重新渲染
        // Since we are in _onRender, calling render() again might cause infinite loop if not careful.
        // But here we want to refresh with new data.
        // Better to wait for data then request re-render.
        this._pendingLibraryLoad = false;
        this.render(); // Re-trigger render to use new data
        return;
      } catch (err) {
        console.error("Origin Vault | Failed to load library:", err);
      } finally {
        this._hideLoadingOverlay();
      }
      return;
    }

    // 设置全屏样式
    this._setFullscreenPosition();

    // === Foundry V2 morphdom 修复 ===
    // morphdom 在重新渲染时可能把 .status-bar 错误地嵌套到 .ov-body 内部。
    // 当这种情况发生时，status-bar 会占据 flex 行空间，导致 .main-content 宽度被挤压为 0。
    // 这里检测并修复该问题：将 status-bar 移回 .origin-vault-container 的正确位置。
    if (this.element) {
      const ovBody = this.element.querySelector('.ov-body');
      const misplacedStatusBar = ovBody?.querySelector(':scope > .status-bar');
      if (misplacedStatusBar) {
        const container = this.element.querySelector('.origin-vault-container');
        if (container) {
          container.appendChild(misplacedStatusBar);
          console.warn(`${MODULE_ID} | Fixed: moved .status-bar from .ov-body back to .origin-vault-container`);
        }
      }
    }

    // 应用网格大小设置
    const baseGridSize = this.library.getSetting('gridSize') || 160;
    const gridSize = this.isWindowed ? baseGridSize * 0.5 : baseGridSize;
    if (this.element) {
      this.element.style.setProperty('--ov-row-height', `${gridSize * 1.2}px`);
      this.element.style.setProperty('--ov-card-width', `${gridSize}px`);
      const savedScenePreviewHeight = this.library?.getSetting?.('sceneDetailPreviewHeight');
      if (savedScenePreviewHeight) {
        this.element.style.setProperty('--ov-scene-detail-preview-height', `${savedScenePreviewHeight}px`);
      }

      // 早期绑定: 文件浏览器 & 场景浏览器 & 上传按钮 (event delegation on root)
      // 确保按钮在 _renderAssetGrid 之前就可用
      // 跟踪绑定到的元素，在元素重建时（切换窗口/全屏）重新绑定
      if (this._browserToggleBoundElement !== this.element) {
        this._browserToggleBoundElement = this.element;

        // 子文件夹内容切换
        this.element.addEventListener('change', (e) => {
          if (e.target.classList.contains('ov-subfolder-checkbox')) {
            this.showSubfolderItems = e.target.checked;
            this._renderAssetGrid();
          }
        });

        this.element.addEventListener('click', (e) => {
          const browserBtn = e.target.closest('.btn-toggle-browser');
          const sceneBtn = e.target.closest('.btn-toggle-scene-browser');
          const itemBtn = e.target.closest('.btn-toggle-item-browser');
          const actorBtn = e.target.closest('.btn-toggle-actor-browser');
          const uploadBtn = e.target.closest('.btn-upload-files');
          const locateBtn = e.target.closest('.btn-locate-scene');
          const backBtn = e.target.closest('.btn-back-grid');
          const scenePreviewLevelStepBtn = e.target.closest('.btn-scene-preview-level-step');
          const scenePreviewOverviewBtn = e.target.closest('.btn-scene-preview-overview');

          if (backBtn) {
            this._closePreview();
          } else if (scenePreviewLevelStepBtn) {
            e.preventDefault();
            e.stopPropagation();
            void this._shiftScenePreviewLevel(Number(scenePreviewLevelStepBtn.dataset.levelStep) || 1);
          } else if (scenePreviewOverviewBtn) {
            e.preventDefault();
            e.stopPropagation();
            void this._setScenePreviewLevel(SceneRenderer.OVERVIEW_LEVEL_ID);
          } else if (browserBtn) {
            this.browserVisible = !this.browserVisible;
            if (this.browserVisible) { this.sceneBrowserVisible = false; this.itemBrowserVisible = false; this.actorBrowserVisible = false; }
            $(this.element).find('.btn-toggle-browser').toggleClass('active', this.browserVisible);
            $(this.element).find('.btn-toggle-scene-browser').toggleClass('active', false);
            $(this.element).find('.btn-toggle-item-browser').toggleClass('active', false);
            $(this.element).find('.btn-toggle-actor-browser').toggleClass('active', false);
            this._renderDetailsPanel();
          } else if (sceneBtn) {
            this.sceneBrowserVisible = !this.sceneBrowserVisible;
            if (this.sceneBrowserVisible) { this.browserVisible = false; this.itemBrowserVisible = false; this.actorBrowserVisible = false; }
            $(this.element).find('.btn-toggle-scene-browser').toggleClass('active', this.sceneBrowserVisible);
            $(this.element).find('.btn-toggle-browser').toggleClass('active', false);
            $(this.element).find('.btn-toggle-item-browser').toggleClass('active', false);
            $(this.element).find('.btn-toggle-actor-browser').toggleClass('active', false);
            this._renderDetailsPanel();
          } else if (itemBtn && typeof this._toggleItemBrowser === 'function') {
            this._toggleItemBrowser();
            $(this.element).find('.btn-toggle-item-browser').toggleClass('active', this.itemBrowserVisible);
            $(this.element).find('.btn-toggle-browser').toggleClass('active', false);
            $(this.element).find('.btn-toggle-scene-browser').toggleClass('active', false);
            $(this.element).find('.btn-toggle-actor-browser').toggleClass('active', false);
          } else if (actorBtn && typeof this._toggleActorBrowser === 'function') {
            this._toggleActorBrowser();
            $(this.element).find('.btn-toggle-actor-browser').toggleClass('active', this.actorBrowserVisible);
            $(this.element).find('.btn-toggle-browser').toggleClass('active', false);
            $(this.element).find('.btn-toggle-scene-browser').toggleClass('active', false);
            $(this.element).find('.btn-toggle-item-browser').toggleClass('active', false);
          } else if (uploadBtn) {
            this._openUploadDialog();
          } else if (locateBtn) {
            this._locateCurrentScene();
          }
        });
      }
    }

    // V2: 模板已渲染骨架结构，但侧边栏和素材网格的实际内容
    // 是通过 partial 模板填充的，需要显式调用渲染方法来填充数据
    await this._renderSidebar();
    await this._renderAssetGrid();
    await this._renderDetailsPanel();

    // 恢复文件夹树的滚动位置（全量渲染后）
    if (this._sidebarScrollTop > 0) {
      const folderTree = this.element?.querySelector('.folder-tree-content');
      if (folderTree) {
        folderTree.scrollTop = this._sidebarScrollTop;
      }
      this._sidebarScrollTop = 0;
    }

    // V2: activateListeners 不再由框架自动调用，需要手动调用
    // 传入 jQuery 包装的 element，因为 activateListeners 内部使用 jQuery .find()
    this.activateListeners($(this.element));

    // 初始化可拖拽分割线 (列宽调整)
    this._bindResizeDividers();

    // 绘制音频波形
    this._drawWaveforms();

    // 注意：_renderAssetGrid 内部已处理虚拟滚动初始化，此处无需重复调用
    // _initVirtualScroll 或 _scheduleLayoutRefresh
  }

  // [GridLayout 方法已提取到 mixins/GridLayoutMixin.js]
  // _forceLayoutReflow, _scheduleLayoutRefresh

  /**
   * Override to prevent Foundry V2 from injecting its own window header controls
   * (configure gear, close button, etc.) — we use our own custom header.
   */
  _getHeaderControls() {
    return [];
  }


  /**
   * 切换资源类型
   * @param {string} type 
   */
  async _onSwitchType(type) {
    if (this.activeType === type) return;

    this.activeType = type;
    this.currentAdapter = this.adapters[type];

    // 重置当前文件夹到根目录
    this.currentFolderId = SPECIAL_FOLDERS.ALL;
    this.searchQuery = '';
    this.selectedItems.clear();

    // 强制完全重新渲染
    await this.render(true);
  }

  /**
   * 准备渲染数据
   */
  async getData(options = {}) {
    // 失效排序缓存，确保 render(false) 也使用最新数据
    this._sortedItemsCache = null;

    // 适配器模式分发
    if (this.activeType === ASSET_TYPES.SCENE) {
      return this._getDataForScenes(options);
    }

    // 默认素材模式逻辑...
    // 确保数据已加载 (若未加载，_render 中会处理并显示加载遮罩)
    // 注意：这里不再加载，避免遮罩无法显示
    if (!this.library.loaded) {
      // 返回最小化数据，让模板可以渲染空状态
      return {
        isLoading: true,
        folders: [],
        tags: {},
        items: [],
        subfolders: [],
        smartFolders: [],
        currentFolder: null,
        currentFolderName: t('origin-vault.browser.loading'),
        selectedItems: [],
        multiSelectMode: false,
        previewItem: null,
        isSmartFolderView: false,
        gridSize: 160,
        searchQuery: '',
        showBrowser: false,
        isWindowed: this.isWindowed,
        hasFolders: false,
        stats: { totalItems: 0, totalFolders: 0, totalTags: 0, itemsWithThumbnails: 0, averageRating: 0 }
      };
    }

    // Keep the current view on a visible, user-facing folder entry.
    this._ensureVisibleCurrentFolderId();

    // 检查并生成缺失的缩略图 (延后执行, 防抖: 同一时间只调度一次)
    if (!this._thumbnailCheckScheduled) {
      this._thumbnailCheckScheduled = true;
      setTimeout(() => {
        this._thumbnailCheckScheduled = false;
        this._checkMissingThumbnails();
      }, 2000);
    }

    const folders = this.library.getAllFolders();
    const tags = this.library.getAllTags();
    const currentFolder = this._getCurrentFolderLike(this.currentFolderId);
    const isSmartFolderView = this._isSmartFolderView(this.currentFolderId);

    // 获取当前文件夹的所有后代文件夹 (深度穿透)
    let subfolders = [];
    const targetFolderId = this.currentFolderId === SPECIAL_FOLDERS.ALL ? SPECIAL_FOLDERS.ROOT : this.currentFolderId;
    const targetFolder = this.library.getFolder(targetFolderId);

    if (targetFolder && !isSmartFolderView) {
      // 获取所有后代文件夹 ID
      const descendantIds = this.library.getAllDescendantFolders(targetFolderId);

      // 如果是 ROOT 或 ALL，且没有后代（空库），尝试获取直接子文件夹（虽然后代应该包含）
      // getAllDescendantFolders 逻辑是递归获取所有子集. 
      // 直接使用 descendantIds 即可.

      subfolders = [...descendantIds]
        .map(id => this.library.getFolder(id))
        .filter(f => f)
        // 按照层级和排序顺序排序? 或者纯字母序? 
        // 既然是打平显示，最好按名称排序，或者保持一定的层级感?
        // 用户期望"穿透"，通常意味着平铺.
        .sort((a, b) => naturalCompare(a.name, b.name))
        .map(folder => {
          // 获取该文件夹（及其子文件夹）中的所有素材
          const folderItems = this.library.getItemsByFolder(folder.id);

          // 找到第一个可用作封面的素材 (优先图片，其次是有缩略图的视频)
          const coverItem = folderItems.find(item => {
            const ext = '.' + item.path.split('.').pop().toLowerCase();
            return FILE_TYPES.IMAGE.includes(ext) || (item.thumbnailGenerated && item.thumbnail);
          });

          return {
            ...folder,
            coverImage: coverItem ? (coverItem.thumbnail || coverItem.path) : null
          };
        });
    }

    // 获取当前文件夹的素材
    // 如果有搜索关键词或任何筛选条件，使用 searchItems
    const hasActiveFilters = this.filters && (
      (this.filters.tags && this.filters.tags.length > 0) ||
      (this.filters.excludeTags && this.filters.excludeTags.length > 0) ||
      (this.filters.minRating && this.filters.minRating > 0) ||
      (this.filters.fileTypes && this.filters.fileTypes.length > 0) ||
      this.filters.untagged
    );

    let items = (this.searchQuery || hasActiveFilters)
      ? this.library.searchItems(this.searchQuery || '', { ...this.filters, folderId: this.currentFolderId, includeSubfolders: this.showSubfolderItems, mode: this.searchMode })
      : (this.showSubfolderItems
        ? this.library.getItemsByFolder(this.currentFolderId)
        : this.library.getDirectItemsByFolder(this.currentFolderId));

    // 为瀑布流布局计算宽高比 + 排序（带缓存）
    const sortCacheKey = `${this.currentFolderId}|${this.showSubfolderItems}|${this.searchQuery}|${JSON.stringify(this.filters)}`;
    if (this._sortedItemsCacheKey === sortCacheKey && this._sortedItemsCache) {
      items = this._sortedItemsCache;
    } else {
      for (const item of items) {
        // ★ 优先使用真实尺寸（来自缩略图生成器），忽略可能被持久化的错误 aspectRatio
        let ratio;
        if (item?.metadata?.width && item?.metadata?.height) {
          ratio = item.metadata.width / item.metadata.height;
        } else if (typeof item?.path === 'string' && item.path) {
          const ext = '.' + item.path.split('.').pop().toLowerCase();
          if (FILE_TYPES.VIDEO.includes(ext)) {
            ratio = 16 / 9;
          } else {
            ratio = 1;
          }
        } else {
          ratio = 1;
        }
        item.aspectRatio = ratio;
        if (!item._displayNameDecoded) {
          try {
            item.displayName = decodeURIComponent(item.displayName || item.name || ((typeof item.path === 'string' && item.path) ? item.path.split('/').pop() : ovText('Untitled', 'Без названия')));
            item.name = decodeURIComponent(item.name || '');
          } catch (e) {
            item.displayName = item.displayName || item.name || ovText('Untitled', 'Без названия');
            item.name = item.name || '';
          }
          item._displayNameDecoded = true;
        }
      }

      items.sort((a, b) => naturalCompare(a.displayName, b.displayName));

      this._sortedItemsCache = items;
      this._sortedItemsCacheKey = sortCacheKey;
    }

    // 关键修正：确保 allItems 始终与当前视图同步 (修复键盘导航数据源)
    this.allItems = items;

    // 构建文件夹树
    const folderTree = this._buildFolderTree(SPECIAL_FOLDERS.ROOT, folders);

    // 统计信息
    const stats = this.library.getStats();

    // 获取选中项详情 (单选时，或预览模式时)
    let selectedDetail = null;
    const detailItem = this.previewItem || (this.selectedItems.size === 1 ? this.library.getItem(this.selectedItems.values().next().value) : null);

    if (detailItem) {
      // 自动格式化尺寸（如果有 width/height 但没有 dimensions 字符串）
      let dimensionsStr = detailItem.metadata?.dimensions;
      if (!dimensionsStr && detailItem.metadata?.width && detailItem.metadata?.height) {
        dimensionsStr = `${detailItem.metadata.width} × ${detailItem.metadata.height}`;
      }

      // 准备所属文件夹列表
      const itemFolders = (detailItem.folders || [])
        .map(fid => {
          const f = this.library.getFolder(fid);
          ovLog('OriginVault | Folder lookup:', fid, '->', f);
          if (!f && fid !== SPECIAL_FOLDERS.ROOT) return null;
          const folderName = f?.name || (fid === SPECIAL_FOLDERS.ROOT ? t('origin-vault.folders.root') : tf('origin-vault.folders.folderNameNum', { num: fid.slice(0, 6) }));
          return {
            id: fid,
            name: folderName,
            color: f?.color || '#FFD700',
            isRoot: fid === SPECIAL_FOLDERS.ROOT
          };
        })
        .filter(f => f !== null);

      ovLog('OriginVault | itemFolders after construction:', JSON.stringify(itemFolders, null, 2));

      selectedDetail = {
        ...detailItem,
        // 从 metadata.type 提取到顶层，确保场景类型检测正常
        type: detailItem.metadata?.type || detailItem.type || null,
        uuid: detailItem.metadata?.uuid || detailItem.uuid || null,
        name: decodeURIComponent(detailItem.name || ''),
        displayName: decodeURIComponent(detailItem.displayName || detailItem.name || ''),
        folderName: folders[detailItem.folders?.[0]]?.name || t('origin-vault.folders.unknown'), // 保留兼容
        folderList: itemFolders, // 使用 folderList 避免与 detailItem.folders 冲突
        fileFormat: detailItem.path.split('.').pop().toUpperCase(),
        formattedAddedDate: new Date(detailItem.addedDate).toLocaleString(),
        dimensions: dimensionsStr || ovText('Unknown', 'Неизвестно'),
        fileSize: detailItem.metadata?.size || ovText('Unknown', 'Неизвестно'),
        formattedDuration: detailItem.metadata?.duration ? this._formatVideoTime(detailItem.metadata.duration) : null,
        tags: (detailItem.tags || []).map(tagId => this.library.getTag(tagId)).filter(t => t),
        stars: Array.from({ length: 5 }, (_, i) => ({
          value: i + 1,
          filled: (i + 1) <= (detailItem.rating || 0)
        }))
      };
    }

    return {
      moduleId: MODULE_ID,
      moduleTitle: MODULE_TITLE,
      folders,
      folderTree,
      smartFolders: this._buildSmartFolderEntries(),
      tags: Object.values(tags),
      items,
      currentFolder,
      currentFolderId: this.currentFolderId,
      currentFolderName: currentFolder?.name || t('origin-vault.folders.root'),
      currentFolderItemCount: items.length,
      selectedItems: Array.from(this.selectedItems),
      selectedDetail,
      browserVisible: this.browserVisible,
      subfolders, // 传递子文件夹数据
      browserPath: this.browserPath,
      searchQuery: this.searchQuery,
      searchMode: this.searchMode,
      filters: this.filters,
      stats,
      dragMode: this.dragMode, // 传递拖拽模式
      settings: this.library.getAllSettings(),
      specialFolders: this._buildSpecialFolderEntries(stats),
      previewItem: this.previewItem,
      isSmartFolderView,
      isWindowed: this.isWindowed,
      sceneBrowserVisible: this.sceneBrowserVisible,
      scenePacks: this._getScenePacks(),
      worldScenes: this._getWorldScenes(),
      cacheBust: Date.now()
    };
  }

  // _buildFolderTree → SidebarMixin.js

  // ==================== 虚拟滚动核心方法 ====================

  // ==================== 虚拟滚动 (已提取到 VirtualScrollMixin.js) ====================
  // _calculateItemPositions, _getVisibleItems, _renderVisibleItems, _createAssetCardHtml,
  // _getSubfoldersOffset, _onVirtualScroll, _bindVirtualCardEvents, _initVirtualScroll,


  // ==================== 悬停预览初始化 ====================
  // [已提取到 mixins/MediaPreviewMixin.js]
  // _initHoverScrubbing, _initVideoPreloading

  /**
   * @returns { string }
   */
  _formatFileSize(bytes) {
    if (!bytes || isNaN(bytes)) return ovText('Unknown', 'Неизвестно');
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    return `${size.toFixed(unitIndex > 0 ? 1 : 0)} ${units[unitIndex]} `;
  }

  /**
   * 激活事件监听器
   */
  activateListeners(html) {
    this.comparisonPanel ??= new ComparisonPanel(this);
    this.comparisonPanel.mount();
    // V2: ApplicationV2 没有 activateListeners, 跳过 super 调用
    if (typeof super.activateListeners === 'function') {
      super.activateListeners(html);
    }

    // 重新绑定侧边栏事件监听器 (确保全量渲染后也能正确绑定)
    const sidebarEl = html.find('#ov-sidebar');
    // if (sidebarEl.length) {
    //   this._activateSidebarListeners(sidebarEl);
    // }

    // Re-render picker bar if in file picker mode (survives full re-renders)
    if (this.filePickerMode) {
      this._renderPickerBar();
    }

    this._initHoverScrubbing(html);
    this._initRealTimeAspectRatioDetection(html);
    this._initVideoPreloading(html); // 视频预加载系统

    // 监听窗口调整大小 (Debounced)
    // 使用 _forceLayoutReflow 进行微调修复
    $(window).off('.ov-resize').on('resize.ov-resize', foundry.utils.debounce(() => {
      if (MainWindow.isVisible) {
        this._forceLayoutReflow(); // 使用微调逻辑
        this._setFullscreenPosition(); // 确保全屏覆盖
      }
    }, 100));

    // 解绑旧的全局事件
    $(window).off('.ov-preview');

    // ==================== 全局键盘事件处理 ====================
    // 必须绑定到 document，因为焦点可能不在窗口内
    // 使用 capture 阶段确保优先处理 (如 QuickLook 覆盖层)

    // 防止重复绑定
    if (this._boundKeyHandler) {
      document.removeEventListener('keydown', this._boundKeyHandler, true);
    }

    this._boundKeyHandler = this._onKeyDown.bind(this);
    document.addEventListener('keydown', this._boundKeyHandler, true);

    ovLog(`${MODULE_ID} | Keyboard listener activated(bound to document)`);


    // ==================== 初始化资源库选择器 ====================
    const selectorContainer = html.find('.library-selector-container')[0];
    if (selectorContainer) {
      if (this.librarySelector) {
        this.librarySelector.destroy();
      }
      this.librarySelector = new LibrarySelector(selectorContainer);
      this.librarySelector.render();
    }

    // ==================== 初始化筛选面板 ====================
    const filterContainer = html.find('.filter-panel-container')[0];
    if (filterContainer) {
      if (this.filterPanel) {
        this.filterPanel.destroy();
      }
      this.filterPanel = new FilterPanel(filterContainer, {
        currentFolderId: this.currentFolderId,
        onFilterChange: (filters) => {
          const previousFilters = {
            tags: [...(this.filters?.tags || [])],
            excludeTags: [...(this.filters?.excludeTags || [])],
            minRating: this.filters?.minRating || 0,
            fileTypes: [...(this.filters?.fileTypes || [])],
            untagged: !!this.filters?.untagged
          };
          const nextFilters = {
            tags: [...(filters.tags || [])],
            excludeTags: [...(filters.excludeTags || [])],
            minRating: filters.minRating || 0,
            fileTypes: [...(filters.fileTypes || [])],
            untagged: filters.untagged || false
          };
          // 主筛选改动后，直接刷新素材网格。
          this.filters = nextFilters;
          // 物品自动标签面板只管标签维度，这里顺手把按钮状态也同步一下。
          if (this.itemFilterPanel) {
            this.itemFilterPanel.filters.tags = [...this.filters.tags];
            this.itemFilterPanel.filters.excludeTags = [...this.filters.excludeTags];
            this.itemFilterPanel._updateButton();
          }
          if (this._shouldScrollToTopAfterPrimaryFilterChange(previousFilters, this.filters)) {
            this._scrollToTop();
          }
          this._renderAssetGrid();
        }
      });
      // 把当前缓存的筛选状态回填到新面板，避免局部重绘后丢选择。
      if (this.filters) {
        this.filterPanel.filters = {
          ...this.filterPanel.filters,
          ...this.filters,
          tags: [...(this.filters.tags || [])],
          excludeTags: [...(this.filters.excludeTags || [])],
          fileTypes: [...(this.filters.fileTypes || [])]
        };
      }
      this.filterPanel.render();
    }

    // ==================== 初始化物品标签筛选面板 (由扩展模块注册) ====================
    const itemFilterContainer = html.find('.item-filter-container')[0];
    const ItemFilterClass = window.OriginVault?.itemFilterClass;
    if (ItemFilterClass && itemFilterContainer) {
      if (this.itemFilterPanel) {
        this.itemFilterPanel.destroy();
      }
      this.itemFilterPanel = new ItemFilterClass(itemFilterContainer, {
        currentFolderId: this.currentFolderId,
        onFilterChange: (filters) => {
          const previousFilters = {
            tags: [...(this.filters?.tags || [])],
            excludeTags: [...(this.filters?.excludeTags || [])],
            untagged: !!this.filters?.untagged
          };
          const nextFilters = {
            ...this.filters,
            tags: [...(filters.tags || [])],
            excludeTags: [...(filters.excludeTags || [])]
          };
          this.filters = nextFilters;
          // 自动标签面板只改标签，所以这里回写主筛选按钮即可。
          if (this.filterPanel) {
            this.filterPanel.filters.tags = [...this.filters.tags];
            this.filterPanel.filters.excludeTags = [...this.filters.excludeTags];
            this.filterPanel._updateButton();
          }
          if (this._shouldScrollToTopAfterTagFilterChange(previousFilters, this.filters)) {
            this._scrollToTop();
          }
          this._renderAssetGrid();
        }
      });
      // 重建面板后，把当前标签选择带回来。
      if (this.filters) {
        this.itemFilterPanel.filters.tags = [...(this.filters.tags || [])];
        this.itemFilterPanel.filters.excludeTags = [...(this.filters.excludeTags || [])];
      }
      this.itemFilterPanel.render();
    }

    // ==================== 样式强制修复 (Critical Style Injection) ====================
    // 样式已移至 styles/origin-vault.css
    // ===========================================================================

    // ==================== 头部按钮 ====================

    // 关闭按钮
    html.find('.ov-header-close').on('click', () => {
      if (this.filePickerMode) {
        this._exitFilePickerMode();
      } else {
        MainWindow.hide();
      }
    });

    // 资源库管理
    html.find('.btn-library-manager').on('click', () => {
      this._onLibraryManagerClick();
    });

    // 帮助
    html.find('.btn-help').on('click', () => {
      // 停止闪烁，移除提示气泡，记录已点击
      html.find('.btn-help').removeClass('ov-help-pulse');
      html.find('.ov-help-tooltip').remove();
      if (game.settings?.get) {
        try { game.settings.set('origin-vault', 'helpSeen', true); } catch (e) { }
      }
      this._showHelpPanel();
    });

    // 如果用户从未点过帮助按钮，显示提示气泡
    try {
      if (!game.settings.get('origin-vault', 'helpSeen')) {
        const $btn = html.find('.btn-help');
        $btn.addClass('ov-help-pulse');
        const tipText = t('origin-vault.help.helpTooltip');
        const $tip = $(`<div class="ov-help-tooltip"><span>${tipText}</span><div class="ov-help-tooltip-arrow"></div></div>`);
        $btn.css('position', 'relative').append($tip);
      }
    } catch (e) { }

    // 标签管理
    html.find('.btn-tag-manager').on('click', () => {
      this._showTagManagerDialog();
    });

    // 切换窗口模式
    html.find('.btn-toggle-window').on('click', () => {
      // 保存当前滚动位置 (记录第一个可见的素材索引)
      const gridContainer = html.find('.asset-grid');
      if (gridContainer.length && this.virtualScrollEnabled) {
        const scrollTop = gridContainer.scrollTop();
        const viewportHeight = gridContainer.height();
        // 获取可见区域的 items
        const visibleItems = this._getVisibleItems(scrollTop, viewportHeight);
        if (visibleItems.length > 0) {
          // 找到第一个可见项在 allItems 中的索引
          const firstItem = visibleItems[0];
          this._restoreScrollIndex = this.allItems.findIndex(i => i.id === firstItem.id);
          ovLog(`${MODULE_ID} | Saving scroll position: item index ${this._restoreScrollIndex} `);
        }
      }

      this.isWindowed = !this.isWindowed;

      if (this.isWindowed) {
        // Switch to windowed: A4 landscape ratio (√2:1)
        this._userResized = false; // Reset so A4 ratio is enforced
        this._userMovedWindow = false;
        this.element.classList.add('windowed-mode');

        const bounds = this._rememberWindowBounds?.(this._getDefaultWindowBounds?.());
        this._applyWindowBounds?.(bounds);
        this.element.style.transform = '';
      } else {
        // Switch to fullscreen
        this.element.classList.remove('windowed-mode');
        this.setPosition({
          width: window.innerWidth,
          height: window.innerHeight,
          left: 0,
          top: 0
        });
      }

      this._syncWorkspaceShellState();
      this.render(false);
    });

    // 窗口拖动和缩放 (仅在窗口模式下)
    // Note: Drag and resize are initialized in _setFullscreenPosition which runs on every render


    // ==================== 文件夹树事件 ====================
    // 注意：所有文件夹事件（点击、双击、折叠、右键、子文件夹按钮、新建文件夹、
    // 类型切换、拖拽等）已在 _renderSidebar() → _activateSidebarListeners() 中绑定。
    // _onRender() 先调用 _renderSidebar()（绑定事件），再调用 activateListeners()。
    // 此处不再重复绑定，避免事件处理器叠加导致创建多个文件夹等 bug。


    // ==================== 素材网格事件 ====================

    // 子文件夹行 - 双击进入文件夹 (使用事件委托)
    html.on('dblclick', '.subfolder-card', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const folderId = event.currentTarget.dataset.folderId;
      if (folderId) this._onFolderClick(folderId);
    });

    // 子文件夹行 - 右键菜单
    html.on('contextmenu', '.subfolder-card', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const folderId = event.currentTarget.dataset.folderId;
      if (folderId) this._onFolderContextMenu(event, folderId);
    });

    // 使用延迟区分单击和双击 - 事件代理以支持虚拟滚动
    // 根元素会经历多次 render，命名空间先清一次，避免委托监听越叠越多。
    html.off('.ovAssetSelection');
    html.on('click.ovAssetSelection', '.asset-card:not(.ov-compare-card):not(.folder-card)', (event) => {
      const itemId = event.currentTarget.dataset.itemId;
      const isCtrl = event.ctrlKey || event.metaKey;
      const isShift = event.shiftKey;

      if (!itemId) return;

      // 清除之前的定时器（如果用户快速双击）
      if (this._clickTimer) {
        clearTimeout(this._clickTimer);
        this._clickTimer = null;
      }

      // 延迟执行单击逻辑，给双击事件时间触发
      this._clickTimer = setTimeout(() => {
        this._clickTimer = null;
        this._onItemClick(itemId, isCtrl, isShift);
      }, 200); // 200ms 内如果有双击，则取消单击
    });

    // 双击素材 - 事件代理以支持虚拟滚动
    html.on('dblclick.ovAssetSelection', '.asset-card:not(.ov-compare-card)', (event) => {
      // 取消单击的延迟操作
      if (this._clickTimer) {
        clearTimeout(this._clickTimer);
        this._clickTimer = null;
      }

      const itemId = event.currentTarget.dataset.itemId;
      if (itemId) {
        // 先选中该项
        this.selectedItems.clear();
        this.selectedItems.add(itemId);
        this._onItemDoubleClick(itemId);
      }
    });

    // .btn-back-grid 已由 L1929 的事件代理处理，不再重复绑定

    // 预览工具栏事件
    html.find('.btn-zoom-in').on('click', () => this._setZoom(this.previewState.scale + 0.1));
    html.find('.btn-zoom-out').on('click', () => this._setZoom(this.previewState.scale - 0.1));
    html.find('.zoom-slider').on('input', (e) => this._setZoom(parseFloat(e.target.value) / 100));
    html.find('.btn-rotate-left').on('click', () => this._rotatePreview(-90));
    html.find('.btn-rotate-right').on('click', () => this._rotatePreview(90));
    html.find('.btn-fit-screen').on('click', () => this._fitScreen());
    html.find('.btn-original-size').on('click', () => this._setZoom(1));



    // ==================== 预览模式交互 (缩放/平移) ====================
    const previewContainer = html.find('.preview-container');

    // 滚轮交互
    previewContainer.on('wheel', (event) => {
      if (!this.previewItem) return;

      // 场景类型由 SceneRenderer 自行处理交互，不拦截
      const isSceneType = this.previewItem.metadata?.type === 'scene' || this.previewItem.type === 'scene';
      if (isSceneType) return;

      // 物品类型不需要缩放/快进交互，让浏览器正常滚动内容
      const isItemType = this.previewItem.metadata?.type === 'item' || this.previewItem.type === 'item';
      if (isItemType) return;

      event.preventDefault();

      const ext = '.' + this.previewItem.path.split('.').pop().toLowerCase();

      if (FILE_TYPES.IMAGE.includes(ext)) {
        // 图片：滚轮缩放
        const delta = event.originalEvent.deltaY > 0 ? -0.1 : 0.1;
        this._setZoom(this.previewState.scale + delta);
      } else if (FILE_TYPES.VIDEO.includes(ext) || FILE_TYPES.AUDIO.includes(ext)) {
        // 视频/音频：滚轮快进/后退
        const media = previewContainer.find('video, audio')[0];
        if (media && media.duration) {
          const seek = event.originalEvent.deltaY < 0 ? 5 : -5;
          media.currentTime = Math.max(0, Math.min(media.duration, media.currentTime + seek));
        }
      }
    });

    // 鼠标按下 (开始拖拽 - 仅图片，场景由 SceneRenderer 处理)
    previewContainer.on('mousedown', (event) => {
      if (!this.previewItem) return;

      // 场景/物品类型不处理拖拽
      const isSceneType = this.previewItem.metadata?.type === 'scene' || this.previewItem.type === 'scene';
      if (isSceneType) return;
      const isItemType = this.previewItem.metadata?.type === 'item' || this.previewItem.type === 'item';
      if (isItemType) return;

      const ext = '.' + this.previewItem.path.split('.').pop().toLowerCase();
      if (!FILE_TYPES.IMAGE.includes(ext)) return; // 只有图片可以拖拽

      event.preventDefault();
      this.previewState.isDragging = true;
      this.previewState.lastMouseX = event.clientX;
      this.previewState.lastMouseY = event.clientY;
      html.find('.preview-container img').css('cursor', 'grabbing');
      previewContainer.css('cursor', 'grabbing');
    });

    // 鼠标移动 (拖拽中)
    $(window).on('mousemove.ov-preview', (event) => {
      if (this.previewState.isDragging) {
        event.preventDefault();
        const dx = event.clientX - this.previewState.lastMouseX;
        const dy = event.clientY - this.previewState.lastMouseY;

        this.previewState.panX += dx;
        this.previewState.panY += dy;
        this.previewState.lastMouseX = event.clientX;
        this.previewState.lastMouseY = event.clientY;

        this._updatePreviewTransform();
      }
    });

    // 鼠标松开 (结束拖拽)
    $(window).on('mouseup.ov-preview', () => {
      if (this.previewState.isDragging) {
        this.previewState.isDragging = false;
        html.find('.preview-container img').css('cursor', 'grab');
        previewContainer.css('cursor', 'default');
      }
    });



    // 清理事件 (在重新渲染前清理 window 绑定的事件，避免重复)
    // 注意：Foundry 的 activateListeners 每次渲染都会调用，所以要在渲染前清理
    // 这里其实每次 render 都是新的 DOM，但 window 是全局的。
    // 更好的做法是在 getData 或 render 钩子里清理，或者用 namespace 绑定
    // 上面用了 .ov-preview namespace，所以可以在这里先 off 一次
    // 但 activateListeners 是在 DOM 插入后调用的。
    // 我们需要在 close 或重新 render 时清理。
    // 简单起见，我们在 activateListeners 开头解绑旧的 window 事件。

    // 素材右键菜单 - 事件代理以支持虚拟滚动
    html.on('contextmenu', '.asset-card:not(.ov-compare-card)', (event) => {
      event.preventDefault();
      const itemId = event.currentTarget.dataset.itemId;
      if (itemId) this._onItemContextMenu(event, itemId);
    });

    // 预览徽章交互 (Eagle 风格 - 悬停/点击)
    this._bindAssetPreviewBadges(html.find('.asset-card:not(.ov-compare-card)'));

    // 视频/音频悬停播放与进度控制 (Eagle 风格)
    html.find('.asset-card:not(.ov-compare-card)').each((i, el) => {
      const itemId = el.dataset.itemId;
      const item = this.library.getItem(itemId);
      if (!item) return;

      const ext = '.' + item.path.split('.').pop().toLowerCase();

      // 视频处理
      if (FILE_TYPES.VIDEO.includes(ext)) {
        const video = el.querySelector('video'); // 如果使用 video 标签作为缩略图
        // 或者动态插入视频

        el.addEventListener('mouseenter', () => this._playMediaPreview(el, item.path, 'video'));
        el.addEventListener('mouseleave', () => this._stopMediaPreview(el, 'video'));
        el.addEventListener('mousemove', (e) => this._scrubMediaPreview(el, e));
      }
      // 音频处理
      else if (FILE_TYPES.AUDIO.includes(ext)) {
        el.addEventListener('mouseenter', () => this._playMediaPreview(el, item.path, 'audio'));
        el.addEventListener('mouseleave', () => this._stopMediaPreview(el, 'audio'));
        // 改为点击跳转进度，取消悬停拖动
        el.addEventListener('click', (e) => this._scrubMediaPreview(el, e));
      }
    });

    // ==================== 工具栏事件 ====================

    // ==================== 搜索相关事件 ====================
    // 使用 jQuery 命名空间事件代理：
    // - 命名空间 (.ov-toolbar) 确保每次 activateListeners 先解绑旧 handler，防止堆叠
    // - 事件代理 (第二参数选择器) 确保 _renderAssetGrid 重建 DOM 后仍能正常触发

    // 搜索框
    html.off('input.ov-toolbar', '.search-input')
      .on('input.ov-toolbar', '.search-input', foundry.utils.debounce((event) => {
        const cursorPos = event.target.selectionStart;
        this.searchQuery = event.target.value;
        this._renderAssetGrid();
        // _renderAssetGrid 会重建工具栏 DOM，需要恢复搜索框焦点和光标位置
        requestAnimationFrame(() => {
          const newInput = this.element?.querySelector('.search-input');
          if (newInput) {
            newInput.focus();
            newInput.setSelectionRange(cursorPos, cursorPos);
          }
        });
      }, 300));

    // 清除搜索
    html.off('click.ov-toolbar', '.btn-clear-search')
      .on('click.ov-toolbar', '.btn-clear-search', () => {
        this.searchQuery = '';
        this._scrollToTop();
        this._renderAssetGrid();
      });

    // 切换搜索模式 (模糊/精确)
    html.off('click.ov-toolbar', '.btn-toggle-search-mode')
      .on('click.ov-toolbar', '.btn-toggle-search-mode', (event) => {
        this.searchMode = this.searchMode === 'exact' ? 'fuzzy' : 'exact';

        // 更新按钮状态 (局部更新优化体验)
        const btn = $(event.currentTarget);
        btn.toggleClass('active', this.searchMode === 'exact');
        btn.attr('title', this.searchMode === 'exact'
          ? t('origin-vault.search.modeExact')
          : t('origin-vault.search.modeFuzzy')
        );

        const icon = btn.find('i');
        icon.attr('class', this.searchMode === 'exact' ? 'fas fa-align-left' : 'fas fa-magic');

        // 仅刷新素材网格
        this._renderAssetGrid();
      });

    // 新建文件夹按钮 - 已移至 _activateSidebarListeners 中绑定

    // 切换文件浏览器 - 已移至 _onRender 事件委托处理 (避免重复绑定)



    // 设置按钮
    html.find('.btn-settings').on('click', () => {
      this._onOpenSettings();
    });

    // NOTE: export/import 按钮在 toolbar (属于 #ov-main-content) 内，
    // 事件已由 _activateAssetGridListeners() 绑定，此处不再重复绑定

    // ==================== 拖放事件 ====================

    // 素材拖拽开始
    html.find('.asset-card:not(.ov-compare-card)[draggable="true"]').on('dragstart', (event) => {
      const itemId = event.currentTarget.dataset.itemId;
      if (itemId) this._onItemDragStart(event, itemId);
    });

    // 文件夹拖放目标
    html.find('.folder-item').on('dragover', (event) => {
      event.preventDefault();
      event.currentTarget.classList.add('drag-over');
    });

    html.find('.folder-item').on('dragleave', (event) => {
      event.currentTarget.classList.remove('drag-over');
    });

    html.find('.folder-item').on('drop', (event) => {
      event.preventDefault();
      event.currentTarget.classList.remove('drag-over');
      const folderId = event.currentTarget.dataset.folderId;
      if (folderId) this._onDropToFolder(event, folderId);
    });

    // ==================== 详情面板事件 ====================

    // 输入框更新 (名称、注释、链接)
    html.find('.details-input').on('change', async (event) => {
      const input = event.currentTarget;
      const itemId = input.dataset.itemId;
      const field = input.dataset.field;
      const value = input.value.trim();

      if (itemId && field) {
        await this.library.updateItem(itemId, { [field]: value });

        // displayName 变更：立即更新网格卡片上的名称
        if (field === 'displayName') {
          const card = $(this.element).find(`.asset-card:not(.ov-compare-card)[data-item-id="${itemId}"]`);
          if (card.length) {
            card.find('.asset-name').text(value);
            card.find('.asset-name').attr('title', value);
          }
        }

        this._renderDetailsPanel();
      }
    });

    // 关闭详情面板
    html.find('.btn-close-details').on('click', () => {
      this.selectedItems.clear();
      this.render(false);
    });

    // 添加标签 (即时生效)
    html.find('.btn-add-tag').on('click', async (event) => {
      if (this.selectedItems.size !== 1) return;
      const itemId = this.selectedItems.values().next().value;
      const item = this.library.getItem(itemId);
      const currentTags = item?.tags || [];

      await this._showTagPickerDialog(itemId, currentTags, this.selectedItems);
      this.render(false);
    });

    // 移除标签 (点击标签移除) - 简单的交互
    html.find('.detail-tag').on('click', (event) => {
      // 这里需要实现移除逻辑，暂时略过，或者弹出确认?
      // 为了简单，暂时不做移除交互，或者双击移除?
    });

    // 导出文件
    html.find('.btn-export-file').on('click', () => {
      ui.notifications.info(t('origin-vault.notifications.exportNotImplemented'));
    });

    // NOTE: assetGrid drop/dragover/dragleave handlers are bound in
    // _activateAssetGridListeners() — do NOT duplicate them here.

    // ==================== 文件浏览器初始化 ====================
    if (this.browserVisible) {
      const browserContent = html.find('.browser-content')[0];
      if (browserContent) {
        this._initFileBrowser(browserContent);
      }
    }

    // ==================== 全屏音频预览初始化 ====================
    const audioFullscreenPlayer = html.find('.audio-fullscreen-player')[0];
    if (audioFullscreenPlayer) {
      this._drawPreviewWaveform(audioFullscreenPlayer);
    }

    // ==================== 场景预览初始化 ====================
    // 当处于预览模式且预览项是场景类型时，初始化 SceneRenderer
    const scenePreviewContainer = html.find('.scene-preview-container')[0];
    if (scenePreviewContainer && this.previewItem) {
      const isSceneType = this.previewItem.metadata?.type === 'scene' || this.previewItem.type === 'scene';
      ovLog(`${MODULE_ID} | [SCENE PREVIEW INIT] Found.scene - preview - container in activateListeners, isSceneType: `, isSceneType);
      if (isSceneType) {
        ovLog(`${MODULE_ID} | [SCENE PREVIEW INIT] Initializing SceneRenderer for preview mode`);
        this._initPreviewSceneRenderer(scenePreviewContainer, this.previewItem);
      }
    }

    // 关闭文件浏览器按钮
    html.find('.btn-close-browser').on('click', () => {
      this.browserVisible = false;
      this.render(false);
    });

    // ==================== 键盘快捷键 ====================
    html.find('.origin-vault-container').on('keydown', (event) => {
      this._onKeyDown(event);
    });

    // 聚焦容器以接收键盘事件 (每次渲染后都恢复焦点)
    const container = html.find('.origin-vault-container')[0];
    if (container && !QuickLook.getInstance().isOpen) {
      container.focus();
    }

    // 网格大小滑块
    html.find('.ov-grid-slider').on('input', (event) => {
      const size = event.target.value;
      // 实时调整行高
      this.element.style.setProperty('--ov-row-height', `${size * 1.2}px`);
      this.element.style.setProperty('--ov-card-width', `${size}px`);

      // 虚拟滚动模式下重新计算布局
      if (this.allItems.length >= this.virtualScrollThreshold) {
        // 防抖处理
        const shouldKeepSelectedVisible = this._isSelectedItemCurrentlyVisible();
        if (this._gridSliderDebounce) clearTimeout(this._gridSliderDebounce);
        this._gridSliderDebounce = setTimeout(() => {
          this._scrollAnchorIds = this._capturePreferredScrollAnchors({ preferSelected: true });
          const gridContainer = $(this.element)?.find('.asset-grid');
          this._fallbackScrollTop = gridContainer?.scrollTop() || 0;
          this._relayoutVirtualScroll();
          if (shouldKeepSelectedVisible) this._scheduleKeepSelectedItemVisible();
        }, 100);
      } else {
        // 实时更新 Justified Gallery 布局
        const shouldKeepSelectedVisible = this._isSelectedItemCurrentlyVisible();
        this._scheduleLayoutRefresh();
        if (shouldKeepSelectedVisible) this._scheduleKeepSelectedItemVisible();
      }
    });

    html.find('.ov-grid-slider').on('change', (event) => {
      const size = parseInt(event.target.value);
      this.library.setSetting('gridSize', size);
    });

    // Shift+滚轮调整网格大小
    // 每次 activateListeners 都重新绑定，因为 DOM 可能已被替换
    // 尝试多种方式获取容器
    let mainContainer = html.find('.origin-vault-container')[0];
    if (!mainContainer && this.element) {
      mainContainer = this.element.querySelector('.origin-vault-container');
    }
    if (!mainContainer && html.hasClass && html.hasClass('origin-vault-container')) {
      mainContainer = html[0];
    }

    if (mainContainer) {
      // MAD 版：添加版本标识 class 以激活 MAD 配色
      if (IS_MAD_EDITION) {
        mainContainer.classList.add('mad-edition');

        // MAD 版：注入 Patreon 推广按钮（右下角悬浮）
        if (!mainContainer.querySelector('.ov-mad-promo')) {
          const promo = document.createElement('div');
          promo.className = 'ov-mad-promo';
          promo.innerHTML = `
            <div class="ov-mad-promo-popup">
              <span>${t('origin-vault.mad.promoPopup')}</span>
            </div>
            <a class="ov-mad-promo-btn" href="https://www.patreon.com/c/Reslinfvtt" target="_blank" rel="noopener noreferrer">
              <i class="fas fa-gem"></i>
              <span>${t('origin-vault.mad.promoBtn')}</span>
            </a>
          `;
          mainContainer.appendChild(promo);
        }
      }
      // 创建处理函数 (保存引用以便调试)
      const wheelHandler = (event) => {
        // 只在素材网格区域内响应
        const isInAssetGrid = event.target.closest('.asset-grid') ||
          event.target.closest('#ov-main-content');

        if (isInAssetGrid && event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();



          const slider = $(this.element)?.find('.ov-grid-slider')[0];
          if (slider) {
            const delta = event.deltaY > 0 ? -20 : 20;
            let newSize = parseInt(slider.value) + delta;
            newSize = Math.min(Math.max(100, newSize), 500);
            slider.value = newSize;

            // 触发更新
            const scale = this.isWindowed ? 0.5 : 1.0;
            this.element.style.setProperty('--ov-row-height', `${newSize * scale * 1.2}px`);
            this.element.style.setProperty('--ov-card-width', `${newSize * scale}px`);

            this.library.setSetting('gridSize', newSize);

            // 检查是否处于虚拟滚动模式 (通过检测 DOM 元素)
            const isVirtualScrollMode = $(this.element)?.find('.asset-grid-virtual').length > 0;

            if (isVirtualScrollMode && this.allItems.length > 0) {
              // 虚拟滚动模式下重新计算布局
              const shouldKeepSelectedVisible = this._isSelectedItemCurrentlyVisible();
              if (this._gridSliderDebounce) clearTimeout(this._gridSliderDebounce);
              this._gridSliderDebounce = setTimeout(() => {
                // 重要：在重新布局前捕获锚点，否则会丢失滚动位置
                this._scrollAnchorIds = this._capturePreferredScrollAnchors({ preferSelected: true });
                // 备用：保存原始 scrollTop
                const gridContainer = $(this.element)?.find('.asset-grid');
                this._fallbackScrollTop = gridContainer?.scrollTop() || 0;
                this._relayoutVirtualScroll();
                if (shouldKeepSelectedVisible) this._scheduleKeepSelectedItemVisible();
              }, 100);
            } else {
              // 非虚拟模式：更新 Justified Gallery 布局

              const shouldKeepSelectedVisible = this._isSelectedItemCurrentlyVisible();
              this._scheduleLayoutRefresh();
              if (shouldKeepSelectedVisible) this._scheduleKeepSelectedItemVisible();
            }
          }
        }
      };

      // 直接绑定到当前元素 (DOM 已是新的，无需检查重复)
      mainContainer.addEventListener('wheel', wheelHandler, { passive: false, capture: true });
      ovLog(`${MODULE_ID} | Shift + wheel handler bound to container`);
    }
  }

  /**
   * 初始化文件浏览器
   */
  _initFileBrowser(container) {
    this.fileBrowser = new FileBrowser(container, {
      fileFilter: ['image', 'video', 'audio'],
      onFileSelect: (paths, addToLibrary) => {
        if (addToLibrary) {
          this._addFilesToLibrary(paths);
        }
      },
      onFileDrag: () => { },
      // Pass saved state to restore browser position
      initialState: this.fileBrowserState
    });
    this.fileBrowser.init();
  }

  /**
   * 更新后刷新视图 (局部更新，防止闪烁)
   * @param {string} targetFolderId - 发生变动的文件夹 ID (可选)
   */
  _refreshViewAfterUpdate(targetFolderId) {
    // 始终刷新侧边栏 (计数变化)
    this._renderSidebar();

    // 检查是否需要刷新素材网格
    // 1. 如果当前就在该文件夹
    // 2. 或者当前在查看 "全部" / "最近" 等聚合列表
    // 3. 或者没有指定 targetFolderId (默认全刷)
    const isCurrentFolder = targetFolderId && targetFolderId === this.currentFolderId;
    const isSpecialView = this.currentFolderId.startsWith('__'); // __all__, __recent__, etc.

    if (!targetFolderId || isCurrentFolder || isSpecialView) {
      this._renderAssetGrid();
    }
  }

  // _setFolderImporting → SidebarMixin.js

  /**
   * 处理拖放到素材网格
   */
  async _onDropToAssetGrid(event) {
    try {
      let dataStr = event.dataTransfer.getData('application/x-origin-vault-browser-files');
      if (!dataStr) dataStr = event.dataTransfer.getData('text/plain');

      ovLog(`${MODULE_ID} | Drop to asset grid, dataStr:`, dataStr);

      if (!dataStr) {
        console.warn(`${MODULE_ID} | Drop: No data received`);
        return;
      }

      const data = JSON.parse(dataStr);
      ovLog(`${MODULE_ID} | Drop parsed data:`, data);

      if (data.type === 'origin-vault-browser-files') {
        let targetFolderId = this.currentFolderId.startsWith('__')
          ? SPECIAL_FOLDERS.ROOT
          : this.currentFolderId;
        // 验证文件夹在当前库中存在（切换库后 currentFolderId 可能失效）
        if (!this.library.getFolder(targetFolderId)) {
          targetFolderId = SPECIAL_FOLDERS.ROOT;
        }
        ovLog(`${MODULE_ID} | Handling browser drop to folder:`, targetFolderId);
        await this._handleBrowserDrop(data, targetFolderId);
      } else {
        console.warn(`${MODULE_ID} | Unknown drop type:`, data.type);
      }
    } catch (error) {
      console.error('Drop to asset grid error:', error);
    }
  }

  // ==================== 文件夹操作 (已提取到 SidebarMixin.js) ====================
  // _onFolderClick, _onFolderToggle, _expandParentFolders, _onFolderRename,
  // _onCreateFolder, _createInlineFolder, _onCreateSubfolderInline, _startInlineRename,
  // _onFolderDrop, _isDescendant, _onRemoveFolder, _onDeleteFolderWithItems
  // ==================== 素材操作 ====================

  async _onItemClick(itemId, isCtrl, isShift) {
    ovLog(`OriginVault | Item clicked: ${itemId}, Ctrl: ${isCtrl}, Shift: ${isShift}`);

    // ★ 选中文件时，自动关闭右侧浏览器面板，切换为详情面板
    if (this.sceneBrowserVisible || this.browserVisible || this.itemBrowserVisible || this.actorBrowserVisible) {
      this.sceneBrowserVisible = false;
      this.browserVisible = false;
      this.itemBrowserVisible = false;
      this.actorBrowserVisible = false;
      // 更新工具栏按钮状态
      $(this.element).find('.btn-toggle-scene-browser, .btn-toggle-browser').removeClass('active');
    }

    if (isCtrl) {
      // Ctrl+click: toggle individual item
      if (this.selectedItems.has(itemId)) {
        this.selectedItems.delete(itemId);
      } else {
        this.selectedItems.add(itemId);
      }
    } else if (isShift && this._lastClickedItemId && this.allItems?.length) {
      // Shift+click: range select between last clicked and current
      const items = this.allItems;
      const anchorIdx = items.findIndex(i => i.id === this._lastClickedItemId);
      const targetIdx = items.findIndex(i => i.id === itemId);
      if (anchorIdx !== -1 && targetIdx !== -1) {
        const start = Math.min(anchorIdx, targetIdx);
        const end = Math.max(anchorIdx, targetIdx);
        // Shift+click: accumulate range without clearing prior selection
        for (let i = start; i <= end; i++) {
          this.selectedItems.add(items[i].id);
        }
      } else {
        // Fallback: just add the item
        this.selectedItems.add(itemId);
      }
    } else {
      // Plain click: single select
      this.selectedItems.clear();
      this.selectedItems.add(itemId);
    }

    // Track last clicked item for Shift+range
    this._lastClickedItemId = itemId;

    // Update selection visuals
    this._updateSelectionVisuals();

    // Update picker confirm button state immediately (before async _renderDetailsPanel)
    this._updatePickerConfirmState();

    // Update details panel (async, full re-render)
    ovLog("OriginVault | Calling _renderDetailsPanel...");
    await this._renderDetailsPanel();
  }


  /**
   * 仅更新选中项的视觉样式 (高性能)
   */
  _updateSelectionVisuals() {
    // 1. 移除所有选中样式
    this.element.querySelectorAll('.asset-card:not(.ov-compare-card)').forEach(el => el.classList.remove('selected'));
    this.element.querySelectorAll('.browser-item').forEach(el => el.classList.remove('selected'));

    // 2. 为当前选中项添加样式
    for (const itemId of this.selectedItems) {
      const card = this.element.querySelector(`.asset-card:not(.ov-compare-card)[data-item-id="${itemId}"]`);
      if (card) card.classList.add('selected');

      const browserItem = $(this.element).find(`.browser-item[data-path]`).filter((i, el) => {
        // 这里的逻辑稍微复杂，因为 browser-item 使用 path 而不是 id
        // 我们尽量匹配 asset card，或者暂时只处理 asset card
        // 如果是文件浏览器模式，逻辑不同。目前专注于 Asset Grid。
        return false;
      });
    }

    // 更新选择计数 (如果 UI 有显示的话)
  }

  // _initMarqueeSelect, _updateMarqueeSelection -> [已提取到 mixins/DragDropMixin.js]

  /**
   * 初始化可拖拽调整列宽的分割线
   */
  _bindResizeDividers() {
    const container = this.element?.querySelector('.ov-body');
    if (!container) return;

    // Restore saved widths
    const savedSidebarWidth = this.library?.getSetting?.('sidebarWidth');
    const savedRightPanelWidth = this.library?.getSetting?.('rightPanelWidth');
    if (savedSidebarWidth) container.style.setProperty('--ov-sidebar-width', `${savedSidebarWidth}px`);
    if (savedRightPanelWidth) container.style.setProperty('--ov-right-panel-width', `${savedRightPanelWidth}px`);

    const dividers = container.querySelectorAll('.ov-resize-divider');
    dividers.forEach(divider => {
      const resizeTarget = divider.dataset.resize; // 'sidebar' or 'right-panel'

      divider.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        divider.classList.add('dragging');
        divider.setPointerCapture(e.pointerId);

        const targetEl = resizeTarget === 'sidebar'
          ? container.querySelector('.sidebar')
          : container.querySelector('.right-panel');
        if (!targetEl) return;

        const startX = e.clientX;
        const startWidth = targetEl.getBoundingClientRect().width;

        const onPointerMove = (e2) => {
          const delta = resizeTarget === 'sidebar'
            ? e2.clientX - startX
            : startX - e2.clientX; // Right panel grows when dragging left
          let newWidth = Math.round(startWidth + delta);

          // Enforce min/max
          const minW = resizeTarget === 'sidebar' ? 160 : 200;
          const maxW = resizeTarget === 'sidebar' ? 400 : 500;
          newWidth = Math.max(minW, Math.min(maxW, newWidth));

          const cssVar = resizeTarget === 'sidebar' ? '--ov-sidebar-width' : '--ov-right-panel-width';
          container.style.setProperty(cssVar, `${newWidth}px`);

          // 拖拽过程中节流刷新瀑布流布局
          if (!this._resizeRAF) {
            this._resizeRAF = requestAnimationFrame(() => {
              this._applyJustifiedLayout();
              if (this.virtualScrollEnabled) this._initVirtualScroll();
              this._resizeRAF = null;
            });
          }
        };

        const onPointerUp = () => {
          divider.classList.remove('dragging');
          divider.removeEventListener('pointermove', onPointerMove);
          divider.removeEventListener('pointerup', onPointerUp);

          // Cancel any pending resize RAF
          if (this._resizeRAF) {
            cancelAnimationFrame(this._resizeRAF);
            this._resizeRAF = null;
          }

          // Persist the new width
          const finalWidth = Math.round(targetEl.getBoundingClientRect().width);
          const settingKey = resizeTarget === 'sidebar' ? 'sidebarWidth' : 'rightPanelWidth';
          if (this.library?.setSetting) {
            this.library.setSetting(settingKey, finalWidth);
          }

          // 松手后统一执行一次最终布局（不再分别调两个方法）
          requestAnimationFrame(() => {
            this._applyJustifiedLayout();
            if (this.virtualScrollEnabled) this._initVirtualScroll();
          });
        };

        divider.addEventListener('pointermove', onPointerMove);
        divider.addEventListener('pointerup', onPointerUp);
      });
    });
  }

  async _getScenePreviewLevelContext() {
    const selectedItemId = this.selectedItems?.size === 1
      ? this.selectedItems.values().next().value
      : null;
    const sceneItem = this.previewItem || (selectedItemId ? this.library?.getItem?.(selectedItemId) : null);
    if (!sceneItem) return null;

    const sceneDataFromRenderer = this.previewSceneRenderer?.sceneData || this.sceneRenderer?.sceneData || null;
    const sceneDetail = {
      uuid: sceneItem.uuid || sceneItem.metadata?.uuid,
      id: sceneItem.id,
      folderId: sceneItem.folderId || sceneItem.metadata?.compendiumId,
      sceneData: sceneItem.sceneData,
      metadata: sceneItem.metadata,
      worldSceneId: getWorldSceneId(sceneItem, { library: this.library })
    };

    const sceneData = sceneDataFromRenderer || await this._getFullSceneData?.(sceneDetail);
    if (!sceneData) return null;

    const levelOptions = SceneRenderer.getDetailLevelOptions();
    const levels = SceneRenderer._sortLevelsForRender(SceneRenderer.getSceneLevels(sceneData, levelOptions));
    if (!levels.length) return null;

    const sceneLevelKey = this._getSceneLevelStorageKey?.(sceneItem, sceneData)
      || sceneItem.sceneLevelKey
      || sceneItem.uuid
      || sceneItem.metadata?.uuid
      || sceneItem.id
      || sceneItem.path
      || null;
    const levelStore = this._sceneLevelSelection || (this._sceneLevelSelection = new Map());
    const storedLevelId = sceneLevelKey ? levelStore.get(sceneLevelKey) : null;
    const currentLevelId = this.previewSceneRenderer?._activeLevelId
      || this.sceneRenderer?._activeLevelId
      || sceneItem.activeSceneLevelId
      || storedLevelId;
    const activeLevelId = SceneRenderer.resolveLevelId(sceneData, currentLevelId, levelOptions);

    return {
      sceneItem,
      sceneLevelKey,
      levelStore,
      activeLevelId,
      levels
    };
  }

  async _setScenePreviewLevel(levelId) {
    const context = await this._getScenePreviewLevelContext();
    if (!context || !levelId) return;

    this._pendingPreviewSceneLevelOverride = null;
    if (context.sceneLevelKey) context.levelStore.set(context.sceneLevelKey, levelId);
    context.sceneItem.activeSceneLevelId = levelId;
    if (this.previewItem) {
      this.previewItem.activeSceneLevelId = levelId;
    }

    const refreshes = [this.previewSceneRenderer, this.sceneRenderer]
      .filter(Boolean)
      .map(renderer => renderer.setLevel(levelId));
    await Promise.allSettled(refreshes);

    const syncDetail = (detail) => {
      if (!detail || detail.type !== 'scene') return;
      detail.activeSceneLevelId = levelId;
      if (Array.isArray(detail.sceneLevels)) {
        detail.sceneLevels = detail.sceneLevels.map(level => ({
          ...level,
          active: level.id === levelId
        }));
      }
    };
    syncDetail(this._cachedGridContext?.selectedDetail);

    this.element?.querySelectorAll('.scene-level-tab').forEach((button) => {
      button.classList.toggle('active', button.dataset.levelId === levelId);
    });
    this.element?.querySelectorAll('.scene-canvas-container').forEach((container) => {
      container.dataset.sceneLevelId = levelId;
    });
  }

  async _shiftScenePreviewLevel(direction = 1) {
    const context = await this._getScenePreviewLevelContext();
    if (!context) return;

    const { activeLevelId, levels } = context;
    let nextLevel = null;
    if (SceneRenderer.isOverviewLevelId(activeLevelId)) {
      nextLevel = direction > 0 ? levels[levels.length - 1] : levels[0];
    } else {
      const activeIndex = Math.max(0, levels.findIndex(level => level.id === activeLevelId));
      nextLevel = levels[(activeIndex + direction + levels.length) % levels.length];
    }

    if (nextLevel?.id) {
      await this._setScenePreviewLevel(nextLevel.id);
    }
  }

  // ==================== 模块化面板事件监听器 ====================
  // 注意: _activateSidebarListeners 已定义在类顶部（完整版，包含拖拽处理）

  /**
   * 激活素材网格事件监听器 (用于局部渲染)
   */
  _activateAssetGridListeners(container) {

    // 素材右键菜单
    container.find('.asset-card:not(.ov-compare-card)').on('contextmenu', (event) => {
      event.preventDefault();
      const itemId = event.currentTarget.dataset.itemId;
      if (itemId) this._onItemContextMenu(event, itemId);
    });

    // 素材拖拽
    container.find('.asset-card:not(.ov-compare-card)[draggable="true"]').on('dragstart', (event) => {
      const itemId = event.currentTarget.dataset.itemId;
      if (itemId) this._onItemDragStart(event, itemId);
    });

    // 视频悬停播放
    let hoverVideoTimer = null;
    container.find('.asset-card:not(.ov-compare-card)').hover(
      (event) => {
        const card = $(event.currentTarget);
        const itemId = card.attr('data-item-id');
        if (!itemId) return;

        if (hoverVideoTimer) clearTimeout(hoverVideoTimer);

        hoverVideoTimer = setTimeout(async () => {
          const item = this.library.getItem(itemId);
          if (!item) return;

          let videoSrc = null;

          // 1. 检查本身是否为视频文件
          if (item.path) {
            const ext = item.path.split('.').pop().toLowerCase();
            if (['webm', 'mp4', 'm4v'].includes(ext)) {
              videoSrc = item.path;
            }
          }

          // 2. 如果是场景，检查背景图是否为视频
          // 放宽条件：只要有 background.src 或 img 且是视频格式即可
          if (!videoSrc) {
            const bgSrc = item.metadata?.background?.src || item.metadata?.img;
            if (bgSrc) {
              const bgExt = bgSrc.split('.').pop().toLowerCase();
              if (['webm', 'mp4', 'm4v'].includes(bgExt)) {
                videoSrc = bgSrc;
              }
            }
          }


          if (!videoSrc) return;

          // 避免重复创建
          if (card.find('video.hover-preview').length > 0) return;

          const thumbnailDiv = card.find('.asset-thumbnail');
          const video = $(`<video class="hover-preview" src="${videoSrc}" loop muted playsinline preload="metadata" style="width:100%; height:100%; object-fit:cover; position:absolute; top:0; left:0;"></video>`);

          // 隐藏图片，显示视频
          thumbnailDiv.find('img').css('opacity', 0);
          thumbnailDiv.append(video);

          try {
            await video[0].play();
          } catch (e) {
            ovDebug("Auto-play prevented on hover", e);
          }
        }, 300); // 300ms 延迟，避免快速划过时触发
      },
      (event) => {
        if (hoverVideoTimer) clearTimeout(hoverVideoTimer);
        const card = $(event.currentTarget);
        const video = card.find('video.hover-preview');
        if (video.length > 0) {
          video[0].pause();
          video.remove();
          card.find('.asset-thumbnail img').css('opacity', 1);
        }
      }
    );

    // 预览徽章
    this._bindAssetPreviewBadges(container.find('.asset-card:not(.ov-compare-card)'));

    // 搜索框
    container.find('.search-input').on('input', foundry.utils.debounce((event) => {
      this.searchQuery = event.target.value;
      this._renderAssetGrid(); // 只刷新网格
    }, 300));

    // 清除搜索
    container.find('.btn-clear-search').on('click', () => {
      this.searchQuery = '';
      this._scrollToTop();
      this._renderAssetGrid();
    });

    // 注意: .btn-toggle-browser / .btn-toggle-scene-browser / .btn-upload-files
    // 的点击事件已由 _onRender 中的根级事件委托处理，此处不再重复绑定

    // 设置按钮
    container.find('.btn-settings').on('click', () => {
      this._onOpenSettings();
    });

    // 移动/复制模式切换
    container.find('.btn-toggle-drag-mode').on('click', () => {
      this._onToggleDragMode();
    });

    // 导出素材库
    container.find('.btn-export-library').on('click', async () => {
      await ExportImportManager.exportLibrary();
    });

    // 导入素材库
    container.find('.btn-import-library').on('click', async (event) => {
      await ExportImportManager.importLibrary();
      this.render(false);
    });

    // 全局导出 (克隆)
    container.find('.btn-export-all').on('click', async () => {
      await ExportImportManager.exportAll();
    });

    // 全局导入 (克隆)
    container.find('.btn-import-all').on('click', async () => {
      await ExportImportManager.importAll();
    });

    // 素材网格拖放接收
    const assetGrid = container.find('.asset-grid')[0];
    if (assetGrid) {
      assetGrid.addEventListener('dragover', (e) => {
        e.preventDefault();
        assetGrid.classList.add('drag-target');
      });

      assetGrid.addEventListener('dragleave', () => {
        assetGrid.classList.remove('drag-target');
      });

      assetGrid.addEventListener('drop', (e) => {
        e.preventDefault();
        assetGrid.classList.remove('drag-target');
        this._onDropToAssetGrid(e);
      });
    }


    // .btn-back-grid 已由 L1929 的事件代理处理，不再重复绑定

    // 预览模式工具栏按钮
    container.find('.btn-zoom-in').on('click', () => this._setZoom(this.previewState.scale + 0.1));
    container.find('.btn-zoom-out').on('click', () => this._setZoom(this.previewState.scale - 0.1));
    container.find('.zoom-slider').on('input', (e) => this._setZoom(parseFloat(e.target.value) / 100));
    container.find('.btn-rotate-left').on('click', () => this._rotatePreview(-90));
    container.find('.btn-rotate-right').on('click', () => this._rotatePreview(90));
    container.find('.btn-fit-screen').on('click', () => this._fitScreen());
    container.find('.btn-original-size').on('click', () => this._setZoom(1));
    container.find('.btn-scene-preview-level-step')
      .off('click.ov-scene-preview-level-step')
      .on('click.ov-scene-preview-level-step', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this._shiftScenePreviewLevel(Number(event.currentTarget.dataset.levelStep) || 1);
      });
    container.find('.btn-scene-preview-overview')
      .off('click.ov-scene-preview-overview')
      .on('click.ov-scene-preview-overview', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this._setScenePreviewLevel(SceneRenderer.OVERVIEW_LEVEL_ID);
      });

    // 预览模式：滚轮缩放 + 鼠标拖拽平移
    // 必须在这里绑定，因为 activateListeners 时 .preview-container 还不存在
    const previewContainer = container.find('.preview-container');
    if (previewContainer.length && this.previewItem) {
      // 滚轮交互
      previewContainer.on('wheel', (event) => {
        // 场景类型由 SceneRenderer 自行处理
        const isSceneType = this.previewItem?.metadata?.type === 'scene' || this.previewItem?.type === 'scene';
        if (isSceneType) return;

        // 物品类型不需要缩放/快进交互
        const isItemType = this.previewItem?.metadata?.type === 'item' || this.previewItem?.type === 'item';
        if (isItemType) return;

        event.preventDefault();
        const ext = '.' + this.previewItem.path.split('.').pop().toLowerCase();

        if (FILE_TYPES.IMAGE.includes(ext)) {
          // 图片：滚轮缩放
          const delta = event.originalEvent.deltaY > 0 ? -0.1 : 0.1;
          this._setZoom(this.previewState.scale + delta);
        } else if (FILE_TYPES.VIDEO.includes(ext) || FILE_TYPES.AUDIO.includes(ext)) {
          // 视频/音频：滚轮快进/后退
          const media = previewContainer.find('video, audio')[0];
          if (media && media.duration) {
            const seek = event.originalEvent.deltaY < 0 ? 5 : -5;
            media.currentTime = Math.max(0, Math.min(media.duration, media.currentTime + seek));
          }
        }
      });

      // 鼠标按下 (开始拖拽 - 仅图片)
      previewContainer.on('mousedown', (event) => {
        if (!this.previewItem) return;
        const isSceneType = this.previewItem.metadata?.type === 'scene' || this.previewItem.type === 'scene';
        if (isSceneType) return;
        const isItemType = this.previewItem.metadata?.type === 'item' || this.previewItem.type === 'item';
        if (isItemType) return;

        const ext = '.' + this.previewItem.path.split('.').pop().toLowerCase();
        if (!FILE_TYPES.IMAGE.includes(ext)) return;

        event.preventDefault();
        this.previewState.isDragging = true;
        this.previewState.lastMouseX = event.clientX;
        this.previewState.lastMouseY = event.clientY;
        previewContainer.find('img').css('cursor', 'grabbing');
        previewContainer.css('cursor', 'grabbing');
      });

      // 鼠标移动 (拖拽中)
      $(window).off('mousemove.ov-preview-grid').on('mousemove.ov-preview-grid', (event) => {
        if (this.previewState?.isDragging) {
          event.preventDefault();
          const dx = event.clientX - this.previewState.lastMouseX;
          const dy = event.clientY - this.previewState.lastMouseY;
          this.previewState.panX += dx;
          this.previewState.panY += dy;
          this.previewState.lastMouseX = event.clientX;
          this.previewState.lastMouseY = event.clientY;
          this._updatePreviewTransform();
        }
      });

      // 鼠标松开 (结束拖拽)
      $(window).off('mouseup.ov-preview-grid').on('mouseup.ov-preview-grid', () => {
        if (this.previewState?.isDragging) {
          this.previewState.isDragging = false;
          previewContainer.find('img').css('cursor', 'grab');
          previewContainer.css('cursor', 'default');
        }
      });
    }



    // 场景预览模式：初始化 SceneRenderer
    // 检查是否在预览模式下且是场景类型
    const scenePreviewContainer = container.find('.scene-preview-container')[0];
    if (scenePreviewContainer && this.previewItem) {
      const isSceneType = this.previewItem.metadata?.type === 'scene' || this.previewItem.type === 'scene';

      ovLog(`${MODULE_ID} | [PREVIEW INIT] Found scene container, isSceneType:`, isSceneType);
      ovLog(`${MODULE_ID} | [PREVIEW INIT] previewItem:`, this.previewItem);

      if (isSceneType) {
        ovLog(`${MODULE_ID} | Initializing SceneRenderer for preview mode`);
        this._initPreviewSceneRenderer(scenePreviewContainer, this.previewItem);
      }
    }

    // ==================== 重新绑定筛选面板 ====================
    // 因为 #ov-main-content 被重新渲染，需要重新绑定 FilterPanel 到新容器
    // 注意：使用 this.element 而不是 container，因为 container 可能只是局部区域
    const filterContainer = this.element.querySelector('.filter-panel-container');
    if (filterContainer) {
      if (this.filterPanel) {
        // 先记住当前状态，避免局部重绘把筛选条件清空。
        const currentFilters = this.filterPanel.getFilters();
        const wasOpen = this.filterPanel.isOpen;

        // 换掉容器引用后原地重绘，尽量不打断用户当前操作。
        this.filterPanel.container = filterContainer;
        this.filterPanel.filters = currentFilters;
        this.filterPanel.render();

        // 如果面板之前是打开的，保持打开状态
        if (wasOpen) {
          this.filterPanel.open();
        }
      } else {
        // 这里只是兜底，正常首轮会在初始化阶段完成创建。
        this.filterPanel = new FilterPanel(filterContainer, {
          currentFolderId: this.currentFolderId,
          onFilterChange: (filters) => {
            const previousFilters = {
              tags: [...(this.filters?.tags || [])],
              excludeTags: [...(this.filters?.excludeTags || [])],
              minRating: this.filters?.minRating || 0,
              fileTypes: [...(this.filters?.fileTypes || [])],
              untagged: !!this.filters?.untagged
            };
            const nextFilters = {
              tags: [...(filters.tags || [])],
              excludeTags: [...(filters.excludeTags || [])],
              minRating: filters.minRating || 0,
              fileTypes: [...(filters.fileTypes || [])],
              untagged: filters.untagged || false
            };
            // 主筛选改动后，直接刷新素材网格。
            this.filters = nextFilters;
            if (this._shouldScrollToTopAfterPrimaryFilterChange(previousFilters, this.filters)) {
              this._scrollToTop();
            }
            this._renderAssetGrid();
          }
        });
        this.filterPanel.render();
      }
    }

    // ==================== 重新绑定物品标签筛选面板 (由扩展模块注册) ====================
    const itemFilterContainer = this.element.querySelector('.item-filter-container');
    const ItemFilterClass2 = window.OriginVault?.itemFilterClass;
    if (ItemFilterClass2 && itemFilterContainer) {
      if (this.itemFilterPanel) {
        // 这块优先复用已有实例，避免面板开关状态跳来跳去。
        const wasOpen = this.itemFilterPanel.isOpen;
        this.itemFilterPanel.container = itemFilterContainer;
        this.itemFilterPanel.currentFolderId = this.currentFolderId;
        // 重绘前把当前标签条件同步回去。
        if (this.filters) {
          this.itemFilterPanel.filters.tags = [...(this.filters.tags || [])];
          this.itemFilterPanel.filters.excludeTags = [...(this.filters.excludeTags || [])];
        }
        this.itemFilterPanel.render();
        if (wasOpen) this.itemFilterPanel.open();
      } else {
        // 这里只有在实例还不存在时才会新建。
        this.itemFilterPanel = new ItemFilterClass2(itemFilterContainer, {
          currentFolderId: this.currentFolderId,
          onFilterChange: (filters) => {
            const previousFilters = {
              tags: [...(this.filters?.tags || [])],
              excludeTags: [...(this.filters?.excludeTags || [])],
              untagged: !!this.filters?.untagged
            };
            const nextFilters = {
              ...this.filters,
              tags: [...(filters.tags || [])],
              excludeTags: [...(filters.excludeTags || [])]
            };
            this.filters = nextFilters;
            if (this.filterPanel) {
              this.filterPanel.filters.tags = [...this.filters.tags];
              this.filterPanel.filters.excludeTags = [...this.filters.excludeTags];
              this.filterPanel._updateButton();
            }
            if (this._shouldScrollToTopAfterTagFilterChange(previousFilters, this.filters)) {
              this._scrollToTop();
            }
            this._renderAssetGrid();
          }
        });
        if (this.filters) {
          this.itemFilterPanel.filters.tags = [...(this.filters.tags || [])];
          this.itemFilterPanel.filters.excludeTags = [...(this.filters.excludeTags || [])];
        }
        this.itemFilterPanel.render();
      }
    }
  }

  /**
   * 初始化资源库选择器
   */
  _initLibrarySelector() {
    const selectorContainer = this.element?.querySelector('.library-selector-container');
    if (selectorContainer) {
      if (this.librarySelector) {
        this.librarySelector.destroy();
      }
      this.librarySelector = new LibrarySelector(selectorContainer);
      this.librarySelector.render();
    }
  }

  // 辅助：单独激活右侧面板监听器
  /**
   * 检查文件是否为音频类型
   */
  _isValidAudio(filePath) {
    if (!filePath) return false;
    const ext = filePath.split('.').pop().toLowerCase();
    return FILE_TYPES.AUDIO.includes(ext);
  }

  /**
   * 检查文件是否为视频类型
   */
  _isValidVideo(filePath) {
    if (!filePath) return false;
    const ext = filePath.split('.').pop().toLowerCase();
    return FILE_TYPES.VIDEO.includes(ext);
  }

  // ==================== 预览模式 ====================

  _isValidImage(path) {
    const ext = '.' + path.split('.').pop().toLowerCase();
    return FILE_TYPES.IMAGE.includes(ext);
  }

  // ==================== 文件选择器模式 ====================

  // _onItemContextMenu → ContextMenuMixin.js

  async _onDeleteItem(itemId) {
    const item = this.library.getItem(itemId);
    if (!item) return;

    const confirmed = await this._showConfirmDialog(
      t('origin-vault.items.delete'),
      `${tf('origin-vault.items.deleteConfirm', { name: item.displayName || item.path.split('/').pop() })}<br><br><em style="color: var(--ov-text-secondary);">${t('origin-vault.items.deleteNote')}</em>`,
      true
    );

    if (confirmed) {
      await this.library.removeItem(itemId);
      this.selectedItems.delete(itemId);
      this.render(false);
    }
  }

  // ==================== 拖放操作 ====================

  _onItemDragStart(event, itemId, sourceItem = null) {
    // 合集浏览器的条目尚未入库，仍能拖进对比或使用原生文档拖放。
    if (this.activeType === ASSET_TYPES.SCENE && !sourceItem) {
      const asset = this.comparisonPanel?.assetForId(itemId);
      if (asset?.uuid) event.originalEvent.dataTransfer.setData('text/plain', JSON.stringify({ type: 'Scene', uuid: asset.uuid }));
      return;
    }
    const itemIds = !sourceItem && this.selectedItems.has(itemId)
      ? Array.from(this.selectedItems)
      : [itemId];

    const item = sourceItem || this.library.getItem(itemId);
    if (!item) return;

    // 物品/角色类型走 Foundry 原生拖拽格式，保持和系统自己的 drop 行为一致。
    if ((item?.metadata?.type === 'item' || item?.metadata?.type === 'actor') && item.metadata?.uuid) {
      const uuid = item.metadata.uuid;
      const documentType = item.metadata.type === 'actor' ? 'Actor' : 'Item';
      const collection = documentType === 'Actor' ? game.actors : game.items;

      const worldDocument = collection?.find(doc =>
        doc.flags?.core?.sourceId === uuid ||
        doc._stats?.compendiumSource === uuid
      );

      let dragData;
      if (worldDocument) {
        // 已导入：优先使用世界文档 UUID，Actor 拖到画布时才能直接走原生 Token 创建。
        dragData = {
          type: documentType,
          uuid: worldDocument.uuid
        };
      } else {
        dragData = {
          type: documentType,
          uuid: uuid
        };
      }

      const dataStr = JSON.stringify(dragData);
      event.originalEvent.dataTransfer.setData('text/plain', dataStr);
    } else if (sourceItem && this.library.getItem(itemId) !== sourceItem) {
      // 未入库的候选沿用文件浏览器/原生场景格式，不能把临时 ID 交给画布查库。
      const data = item.metadata?.type === 'scene' && item.metadata?.uuid
        ? { type: 'Scene', uuid: item.metadata.uuid }
        : { type: 'origin-vault-browser-files', paths: [item.path], source: item.source || 'data', bucket: item.bucket || '' };
      const dataStr = JSON.stringify(data);
      if (data.paths) event.originalEvent.dataTransfer.setData('application/x-origin-vault-browser-files', dataStr);
      event.originalEvent.dataTransfer.setData('text/plain', dataStr);
    } else {
      // 非物品类型：使用 origin-vault-item 格式 (图片/场景等)
      const dragData = {
        type: 'origin-vault-item',
        itemId: itemId,
        originVault: {
          type: 'origin-vault-items',
          itemIds,
          sourceFolderId: this.currentFolderId
        },
        img: item.path,
        texture: { src: item.path }
      };

      const dataStr = JSON.stringify(dragData);
      event.originalEvent.dataTransfer.setData('application/x-origin-vault-item', dataStr);
      event.originalEvent.dataTransfer.setData('text/plain', dataStr);
    }

    // 如果在窗口化模式下，拖拽开始时隐藏界面 (Drag-to-Hide)
    // 这样用户可以方便地拖拽到地图上
    ovLog(`${MODULE_ID} | DragStart: isWindowed=${this.isWindowed}`);
    if (this.isWindowed && !this.comparisonPanel?.isOpen) {
      ovLog(`${MODULE_ID} | Applying dragging-hidden class`);
      this.element.classList.add('dragging-hidden');
      // 注意：不能设置 pointer-events: none，否则会中断拖拽
    }

    // 设置拖拽图像 - 使用实际尺寸以便精确放置到画布
    const card = event.currentTarget;
    const thumbnailImg = card.querySelector('.asset-thumbnail img');
    if (thumbnailImg) {
      // 获取素材的实际尺寸 (从元数据)
      let dragWidth = 100;  // 默认值
      let dragHeight = 100;

      if (item.metadata?.width && item.metadata?.height) {
        // 使用实际像素尺寸，但如果太大则限制最大值
        const maxSize = 300;
        const scale = Math.min(1, maxSize / Math.max(item.metadata.width, item.metadata.height));
        dragWidth = Math.round(item.metadata.width * scale);
        dragHeight = Math.round(item.metadata.height * scale);
      }

      // Clone the image for drag preview
      const dragImg = thumbnailImg.cloneNode(true);
      dragImg.style.width = `${dragWidth}px`;
      dragImg.style.height = `${dragHeight}px`;
      dragImg.style.objectFit = 'contain';
      dragImg.style.borderRadius = '4px';
      dragImg.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.5)';
      dragImg.style.position = 'absolute';
      dragImg.style.left = '-9999px'; // Hide off-screen
      dragImg.style.top = '-9999px';
      document.body.appendChild(dragImg);

      // 让拖拽图像中心对准鼠标 (方便精确放置)
      const offsetX = dragWidth / 2;
      const offsetY = dragHeight / 2;

      event.originalEvent.dataTransfer.setDragImage(dragImg, offsetX, offsetY);

      // Clean up when drag ends (not immediately)
      const cleanup = () => {
        if (dragImg.parentNode) {
          document.body.removeChild(dragImg);
        }
        // 恢复界面显示
        if (this.isWindowed) {
          this.element.classList.remove('dragging-hidden');
        }
        card.removeEventListener('dragend', cleanup);
      };
      card.addEventListener('dragend', cleanup);
    }
  }

  async _onDropToFolder(event, folderId) {
    try {
      let dataStr = event.originalEvent.dataTransfer.getData('application/x-origin-vault-item');
      if (!dataStr) dataStr = event.originalEvent.dataTransfer.getData('application/x-origin-vault-browser-files');
      if (!dataStr) dataStr = event.originalEvent.dataTransfer.getData('text/plain');

      const data = JSON.parse(dataStr);

      // 检查是否为 Origin Vault 内部拖拽
      if (data.originVault && data.originVault.type === 'origin-vault-items') {
        const { itemIds, sourceFolderId } = data.originVault;
        const isSpecialFolder = sourceFolderId.startsWith('__');

        for (const itemId of itemIds) {
          if (isSpecialFolder) {
            this.library.copyItemToFolder(itemId, folderId);
          } else {
            // 穿透模式下，sourceFolderId 可能是父文件夹
            const item = this.library.getItem(itemId);
            let actualSource = sourceFolderId;
            if (item && !item.folders.includes(sourceFolderId)) {
              actualSource = item.folders[0] || sourceFolderId;
            }
            this.library.moveItem(itemId, actualSource, folderId);
          }
        }

        await this._renderSidebar();
        await this._renderAssetGrid();
        this._renderDetailsPanel();
      } else if (data.type === 'origin-vault-browser-files') {
        await this._handleBrowserDrop(data, folderId);
      }
    } catch (error) {
      console.error('Drop error:', error);
    }
  }

  // ==================== 其他操作 ====================



  _onOpenSettings() {
    ui.notifications.info(t('origin-vault.notifications.settingsOpening'));
  }

  // ==================== 拖拽模式与文件夹管理 ====================

  /**
   * 切换拖拽模式 (移动/复制)
   */
  _onToggleDragMode() {
    this.dragMode = this.dragMode === 'move' ? 'copy' : 'move';
    ui.notifications.info(this.dragMode === 'copy' ? t('origin-vault.ui.dragModeCopy') : t('origin-vault.ui.dragModeMove'));
    // 更新按钮状态
    const btn = $(this.element)?.find('.btn-toggle-drag-mode');
    if (btn?.length) {
      btn.toggleClass('copy-mode', this.dragMode === 'copy');
      btn.find('i').attr('class', this.dragMode === 'copy' ? 'fas fa-copy' : 'fas fa-cut');
    }
  }

  /**
   * 从文件夹中移除素材
   */
  async _onRemoveItemFromFolder(itemId, folderId) {
    const item = this.library.getItem(itemId);
    const folder = this.library.getFolder(folderId);

    if (!item || !folder) return;

    const confirmed = await this._showConfirmDialog(
      t('origin-vault.ui.removeFromFolder'),
      `${tf('origin-vault.ui.removeFromFolderConfirm', { asset: item.displayName || item.name || t('origin-vault.folders.unknown'), folder: folder.name })}<br><small>${t('origin-vault.ui.removeFromFolderNote')}</small>`,
      true
    );
    if (confirmed) {
      await this.library.removeItemFromFolder(itemId, folderId);
      this._renderDetailsPanel();
      this._renderSidebar();
      if (this.currentFolderId === folderId) {
        this._renderAssetGrid();
      }
    }
  }

  // 备用：基于索引的导航 (用于 DOM 未渲染或逻辑回退)
  // ==================== 媒体预览逻辑 ====================
  // [已提取到 mixins/MediaPreviewMixin.js]
  // _playMediaPreview, _stopMediaPreview, _scrubMediaPreview, _drawWaveforms,
  // _drawDetailsWaveform, _initAudioPlayerLogic, _drawPreviewWaveform,
  // _initAudioPreviewLogic, _showHoverZoom, _updateHoverZoomPosition, _hideHoverZoom



  // ==================== Dialog/Popup UI ====================
  // [已提取到 mixins/DialogMixin.js]
  // _showContextMenu, _showInputDialog, _showTagPickerDialog, _showTagManagerDialog, _showHelpPanel, _showConfirmDialog


  // ==================== 拖拽辅助方法 ====================
  // _clearDragExpandTimer, _handleDragExpandLogic, _expandFolderDOM, _collapseFolderDOM,
  // _handleBrowserFileDrop, _checkAutoCollapse, _handleAutoScroll, _startAutoScroll, _stopAutoScroll
  // -> [已提取到 mixins/DragDropMixin.js]


  // _formatVideoTime -> [已提取到 mixins/MediaPreviewMixin.js]


  // ==================== Justified Gallery Layout Engine ====================
  // [已提取到 mixins/GridLayoutMixin.js]
  // _calculateJustifiedLayout, _applyJustifiedLayout, _onLayoutResize, _initRealTimeAspectRatioDetection
  async close(options = {}) {
    this.comparisonPanel?.destroy();
    this.comparisonPanel = null;
    this._previewReturnSelection = null;
    this._previewRequest = (this._previewRequest || 0) + 1;
    this._workspaceShellSuspended = false;
    this._syncWorkspaceShellState?.({ forceActive: false });
    this._disconnectGlobalZObserver();

    if (this.filePickerMode || this.filePickerCallback || this.filePickerField || this.filePickerInstance || this.filePickerOptions || this._pickerMouseHandler) {
      this._cleanupFilePickerModeState({ closeNative: true });
    }
    // 清除预览/选中状态，防止重新打开时残留上次的详情视图
    this.previewItem = null;
    this.selectedItems.clear();

    $('.ov-context-menu').remove();

    await this.library.flushPendingPersistence();

    MainWindow.#isVisible = false;
    return super.close(options);
  }

  /**
   * 处理标签创建事件
   * @param {object} tag - 新建的标签数据
   */
  _onTagCreated(tag) {
    this._refreshTagUi({ rerenderGrid: false });
  }

  /**
   * 处理标签更新事件
   * @param {object} tag - 更新的标签数据
   */
  _onTagUpdated(tag) {
    const changedKeys = Array.isArray(tag?.__ovChangedKeys) ? tag.__ovChangedKeys : [];
    const onlyCosmeticChange = changedKeys.length > 0 && changedKeys.every((key) => key === 'color' || key === 'name');
    this._refreshTagUi({ rerenderGrid: !onlyCosmeticChange });
  }

  /**
   * 处理标签删除事件
   * @param {object} tag - 删除的标签数据
   */
  _onTagDeleted(tag) {
    this._refreshTagUi({ rerenderGrid: true });
  }

  /**
   * 处理素材更新事件
   * @param {object} item - 更新的素材数据
   */
  _onItemUpdated(item) {
    if (!MainWindow.#isVisible) return;

    // 如果选中的是该素材，刷新详情面板 - 使用防抖避免重复渲染
    if (this.selectedItems.has(item.id)) {
      this._scheduleDetailsPanelRender();
    }

    // 这里不刷新整个 Grid，太重了。只在必要时刷新
    // 但是为了确保标签变化能实时反映在 Grid 上，还是刷新吧，或者做 DOM 局部更新
    // 考虑到性能，这里暂不刷新 Grid，除非该 Item 就在当前显示列表中
    // 如果需要，可以在这里找到对应的 DOM 元素并更新标签 HTML
    if (this.renderedItems.has(item.id)) {
      // 简单起见，这里重新渲染 Grid
      // 如果性能有问题，后续再优化为局部 DOM 更新
      // this._renderAssetGrid(); 
      // 为了更好的体验，我们尝试仅更新特定卡片的标签部分
      // 这里省略复杂 DOM 操作，因为 _renderDetailsPanel 已经覆盖了大部分交互
      // 但对于批量操作，Grid View 也需要更新
      this._updateItemCardInGrid(item);
    }
  }

  /**
   * 处理场景创建/删除事件 (热更新角标)
   * @param {'create'|'delete'} action - 操作类型
   * @param {Scene} scene - Foundry Scene 文档
   */
  _onSceneChange(action, scene) {
    this._syncImportStateForWorldDocument('scene', action, scene);
    return;
    /*

    // 获取场景的 compendiumSource (用于匹配 Origin Vault 中的 item)
    const compendiumSource = scene._stats?.compendiumSource
      || scene.flags?.core?.sourceId
      || null;

    if (!compendiumSource) return;

    ovLog(`${MODULE_ID} | Scene ${action}: ${scene.name}, source: ${compendiumSource} `);

    const isImported = (action === 'create');
    const worldId = isImported ? scene.id : null;
    let updated = false;

    // 1. 更新 allItems 中匹配的 item
    for (const item of this.allItems) {
      const itemUuid = item.uuid || item.metadata?.uuid;
      if (itemUuid && itemUuid === compendiumSource) {
        item.isImported = isImported;
        item.worldId = worldId;
        updated = true;

        // 2. 直接更新 DOM 上的角标 (精准 DOM 操作，无需完整重渲染)
        const card = this.element?.querySelector(`.asset-card:not(.ov-compare-card)[data-item-id="${item.id}"]`);
        if (card) {
          const badge = card.querySelector('.file-type-badge');
          if (badge) {
            badge.classList.toggle('imported', isImported);
          }
        }
      }
    }

    // 3. 更新 previewItem
    if (this.previewItem) {
      const previewUuid = this.previewItem.uuid || this.previewItem.metadata?.uuid;
      if (previewUuid && previewUuid === compendiumSource) {
        this.previewItem.isImported = isImported;
        this.previewItem.worldId = worldId;
        updated = true;
      }
    }

    // 4. 如果有更新，且当前选中了该场景，刷新详情面板 - 使用防抖避免重复渲染
    if (updated && this.selectedItems?.size > 0) {
      this._scheduleDetailsPanelRender();
    }
    */
  }
  _onWorldItemChange(action, item) {
    this._syncImportStateForWorldDocument('item', action, item);
  }

  _onWorldActorChange(action, actor) {
    this._syncImportStateForWorldDocument('actor', action, actor);
  }

  /**
   * 局部更新 Grid 中的素材卡片 (仅更新标签部分)
   * @param {object} item 
   */
  _updateItemCardInGrid(item) {
    const card = $(this.element).find(`.asset-card:not(.ov-compare-card)[data-id="${item.id}"]`);
    if (!card.length) return;

    // 重新生成标签 HTML
    const tagsHtml = (item.tags || []).map(tagId => {
      const tag = this.library.tags[tagId];
      if (!tag) return '';
      return `<span class="tag-dot" style="background-color: ${tag.color}" title="${tag.name}"></span>`;
    }).join('');

    card.find('.asset-tags').html(tagsHtml);
  }
}

// 应用 Mixin —— 将提取的方法混入 MainWindow 原型
applyGridLayoutMixin(MainWindow);
applyDialogMixin(MainWindow);
applyMediaPreviewMixin(MainWindow);
applyItemBrowserMixin(MainWindow);
applyActorBrowserMixin(MainWindow);
applyVirtualScrollMixin(MainWindow);
applyDragDropMixin(MainWindow);
applyContextMenuMixin(MainWindow);
applySidebarMixin(MainWindow);
applySceneBrowserMixin(MainWindow);
applyFilePickerMixin(MainWindow);
applyKeyboardMixin(MainWindow);
applyWindowMixin(MainWindow);
applyPreviewMixin(MainWindow);
applyImportMixin(MainWindow);
applyDetailsPanelMixin(MainWindow);
applyLibraryDialogsMixin(MainWindow);
applyCompendiumBatchImportMixin(MainWindow);
