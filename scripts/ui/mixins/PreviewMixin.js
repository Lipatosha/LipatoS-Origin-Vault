/**
 * PreviewMixin - 素材预览
 * 从 MainWindow 提取的双击预览、缩放、旋转、QuickLook 等方法
 * 
 * 包含：预览打开/关闭、缩放/旋转/重置、QuickLook
 * 混入后通过 this 访问 MainWindow 实例状态
 */

import { MODULE_ID, FILE_TYPES } from '../../constants.js';
import { QuickLook } from '../QuickLook.js';
import { SceneRenderer } from '../SceneRenderer.js';
import { hasTranslation, t } from '../../utils/i18n.js';
import { ovLog } from '../../utils/logger.js';
import { extractSystemFieldValues } from '../../data/SystemConfigs.js';

/**
 * 将方法混入目标类
 * @param {Function} cls - 目标类 (MainWindow)
 */
export function applyPreviewMixin(cls) {
  cls.prototype._clearPreviewReturnScrollRestore = function () {
    if (this._previewReturnScrollRestoreRaf) {
      cancelAnimationFrame(this._previewReturnScrollRestoreRaf);
      this._previewReturnScrollRestoreRaf = null;
    }

    if (Array.isArray(this._previewReturnScrollRestoreTimers)) {
      for (const timer of this._previewReturnScrollRestoreTimers) {
        clearTimeout(timer);
      }
    }
    this._previewReturnScrollRestoreTimers = [];
  };

  cls.prototype._schedulePreviewReturnScrollRestore = function (scrollTop) {
    if (!(scrollTop >= 0)) return;

    this._clearPreviewReturnScrollRestore();

    const token = (this._previewReturnScrollRestoreToken || 0) + 1;
    this._previewReturnScrollRestoreToken = token;

    const applyRestore = () => {
      if (this._previewReturnScrollRestoreToken !== token) return;
      const gridContainer = this.element?.querySelector('.asset-grid');
      if (!gridContainer) return;
      if (Math.abs(gridContainer.scrollTop - scrollTop) > 1) {
        gridContainer.scrollTop = scrollTop;
      }
    };

    this._previewReturnScrollRestoreRaf = requestAnimationFrame(() => {
      this._previewReturnScrollRestoreRaf = null;
      applyRestore();
    });

    this._previewReturnScrollRestoreTimers = [80, 220, 520].map(delay =>
      setTimeout(() => {
        applyRestore();
        if (delay === 520 && this._previewReturnScrollRestoreToken === token) {
          this._previewReturnScrollRestoreTimers = [];
        }
      }, delay)
    );
  };

  cls.prototype._onItemDoubleClick = function (itemId, item = this.library.getItem(itemId), options = {}) {
    if (!item) return;

    // 文件选择器模式：双击直接确认选择
    if (this.filePickerMode) {
      this._confirmFilePicker(item.path);
      return;
    }

    // 物品类型：直接打开中央预览（渲染物品卡）
    if (item.metadata?.type === 'item') {
      return this._openPreview(itemId, item, options);
    }

    // 角色类型：直接打开 Actor Sheet（不进入大面板预览）
    if (item.metadata?.type === 'actor') {
      const compendiumUuid = item.metadata?.uuid;
      if (!compendiumUuid) return;
      // 检查是否已导入到世界
      const importState = this._resolveImportState(item, { type: 'actor', uuid: compendiumUuid });
      if (importState.imported && importState.worldUuid) {
        // 已导入 → 打开世界角色卡（可编辑）
        this._openWorldActorWithSync(importState.worldUuid);
      } else {
        // 未导入 → 浏览合集包角色卡（只读）
        this._openNativeActorSheet(compendiumUuid);
      }
      return;
    }

    // 音频文件不支持双击打开预览
    const ext = item.path.substring(item.path.lastIndexOf('.')).toLowerCase();
    if (FILE_TYPES.AUDIO.includes(ext)) return;

    const isSceneAsset = item.metadata?.type === 'scene'
      || item.type === 'scene'
      || ext === '.json'
      || ext === '.ov-scene'
      || !!item.metadata?.background?.src;
    if (isSceneAsset) {
      const sceneLevelKey = this._getSceneLevelStorageKey?.(item, null) || item.id;
      this._pendingPreviewSceneLevelOverride = {
        itemId,
        sceneLevelKey,
        levelId: SceneRenderer.OVERVIEW_LEVEL_ID
      };
      item.activeSceneLevelId = SceneRenderer.OVERVIEW_LEVEL_ID;

      if (sceneLevelKey) {
        const levelStore = this._sceneLevelSelection || (this._sceneLevelSelection = new Map());
        levelStore.set(sceneLevelKey, SceneRenderer.OVERVIEW_LEVEL_ID);
      }
    }

    // 正常模式：打开中间区域详情预览
    return this._openPreview(itemId, item, options);
  };

  cls.prototype._openPreview = async function (itemId, item = this.library.getItem(itemId), options = {}) {
    if (!item) return;
    // 对比只借用中央预览，返回时恢复主网格原本的选择。
    if (options.returnSelection && !this._previewReturnSelection) {
      this._previewReturnSelection = [...options.returnSelection];
    }
    const request = this._previewRequest = (this._previewRequest || 0) + 1;

    this._clearPreviewReturnScrollRestore();
    this._savedPreviewReturnAnchors = [];
    this._savedScrollTop = 0;

    // 强制关闭悬停放大
    this._hideHoverZoom();

    // 保存当前滚动位置
    const gridContainer = this.element?.querySelector('.asset-grid');
    if (gridContainer) {
      this._savedScrollTop = gridContainer.scrollTop;
      if (typeof this._capturePreferredScrollAnchors === 'function') {
        const anchors = this._capturePreferredScrollAnchors({ preferSelected: true });
        this._savedPreviewReturnAnchors = Array.isArray(anchors)
          ? anchors.map(anchor => (typeof anchor === 'object' ? { ...anchor } : anchor))
          : [];
      } else {
        this._savedPreviewReturnAnchors = [];
      }
      ovLog(`[OV-DEBUG] _openPreview: saved scrollTop=${this._savedScrollTop}`);
    }

    this.previewItem = item;

    // ★ 预览模式下，自动关闭右侧浏览器面板，切换为详情面板
    this.sceneBrowserVisible = false;
    this.browserVisible = false;
    this.itemBrowserVisible = false;
    this.actorBrowserVisible = false;

    // 物品类型：获取文档以丰富预览数据
    if (item.metadata?.type === 'item' && item.metadata?.uuid) {
      // 先检查是否已导入到世界
      const compendiumUuid = item.metadata.uuid;
      const importState = this._resolveImportState(item, { type: 'item', uuid: compendiumUuid });
      item.isImported = importState.imported;
      item.isItemImported = importState.imported;
      item.worldId = importState.worldId || null;
      item.worldItemUuid = importState.worldUuid || null;

      // 已导入 → 从世界物品取数据；未导入 → 从 Compendium 取
      const docUuid = importState.worldUuid || compendiumUuid;
      // 预设物品类型标签（兜底：即使 fromUuid 失败也能显示）
      const fallbackType = item.metadata.itemType || 'item';
      item.itemTypeLabel = hasTranslation(`TYPES.Item.${fallbackType}`)
        ? t(`TYPES.Item.${fallbackType}`)
        : fallbackType.charAt(0).toUpperCase() + fallbackType.slice(1);

      try {
        const itemDoc = await fromUuid(docUuid);
        if (itemDoc) {
          // 富文本描述
          const rawDesc = itemDoc.system?.description?.value || '';
          if (rawDesc) {
            item.enrichedDescription = await TextEditor.enrichHTML(rawDesc, {
              async: true,
              relativeTo: itemDoc
            });
          }
          // 系统字段
          item.systemFields = extractSystemFieldValues({ systemData: itemDoc.system });
          // 物品类型本地化标签
          const itemType = item.metadata.itemType || itemDoc.type || 'item';
          item.itemTypeLabel = hasTranslation(`TYPES.Item.${itemType}`)
            ? t(`TYPES.Item.${itemType}`)
            : itemType.charAt(0).toUpperCase() + itemType.slice(1);

          // 自动标签 (从 OV 库读取)
          const ovTags = item.tags || [];
          const allTags = options.tags || this.library.getAllTags();
          item.autoTags = ovTags
            .map(tagId => allTags[tagId])
            .filter(Boolean);
        }
      } catch (err) {
        // 物品可能不可达
      }
    }
    if (request !== this._previewRequest || this.previewItem !== item) return;
    // 重置视图状态 (缩放/平移/旋转)
    this.previewState = {
      scale: 1,
      panX: 0,
      panY: 0,
      rotation: 0,
      isDragging: false,
      lastMouseX: 0,
      lastMouseY: 0
    };

    // 同时也作为选中项，以便右侧详情面板显示
    this.selectedItems.clear();
    this.selectedItems.add(itemId);

    await this._renderAssetGrid();
    await this._renderDetailsPanel();
    if (options.returnSelection) {
      const preview = this.element?.querySelector('.preview-container');
      if (preview) { preview.tabIndex = -1; preview.focus({ preventScroll: true }); }
    }
  };

  cls.prototype._closePreview = async function () {
    // 防止多次触发（多个事件监听器可能同时触发）
    if (this._closingPreview) {
      ovLog('[OV-DEBUG] _closePreview: already closing, skipping duplicate call');
      return;
    }
    this._closingPreview = true;

    console.time('_closePreview total');

    // ★ 保存预览项目 ID，确保返回后右侧详情面板显示的是刚预览的项目（而非之前选中的旧项目）
    const returnSelection = this._previewReturnSelection;
    const previewedItemId = returnSelection ? returnSelection[0] : this.previewItem?.id;
    this._previewReturnSelection = null;
    this._previewRequest = (this._previewRequest || 0) + 1;

    this.previewItem = null;
    $(window).off('.ov-preview');

    // ★ 确保 selectedItems 指向刚预览的项目
    if (returnSelection) {
      this.selectedItems = new Set(returnSelection);
    } else if (previewedItemId) {
      this.selectedItems.clear();
      this.selectedItems.add(previewedItemId);
    }

    // ★ 取消 _openPreview → _renderAssetGrid 遗留的所有计时器
    if (this._initVirtualScrollRetryTimer) {
      clearTimeout(this._initVirtualScrollRetryTimer);
      this._initVirtualScrollRetryTimer = null;
    }
    // ★ 取消 _scheduleLayoutRefresh 遗留的定时器（根因修复）
    // _openPreview 中的 _renderAssetGrid 调用 _scheduleLayoutRefresh，
    // 其 500ms 定时器会在退出预览后调用 _applyJustifiedLayout 覆盖正确布局
    if (this._layoutRefreshTimer) {
      clearTimeout(this._layoutRefreshTimer);
      this._layoutRefreshTimer = null;
    }
    if (this._layoutRetryTimer) {
      clearTimeout(this._layoutRetryTimer);
      this._layoutRetryTimer = null;
    }

    const savedScrollTop = this._savedScrollTop || 0;
    const savedPreviewReturnAnchors = Array.isArray(this._savedPreviewReturnAnchors)
      ? this._savedPreviewReturnAnchors.map(anchor => (typeof anchor === 'object' ? { ...anchor } : anchor))
      : [];
    ovLog(`[OV-DEBUG] _closePreview: savedScrollTop=${savedScrollTop}`);

    if (savedPreviewReturnAnchors.length > 0) {
      this._scrollAnchorIds = savedPreviewReturnAnchors;
    }

    // ★ 在渲染前设置 _fallbackScrollTop，让标准网格和锚点恢复失败时仍有兜底滚动位置
    if (savedScrollTop > 0) {
      this._fallbackScrollTop = savedScrollTop;
    }

    // 局部渲染（优先使用缓存上下文以支持大资源库）
    console.time('_closePreview grid render');
    if (this._cachedGridContext) {
      ovLog(`[OV-DEBUG] _closePreview: using cached context (${this._cachedGridContext.items?.length} items)`);
      this._cachedGridContext.previewItem = null;
      await this._renderAssetGridFromContext(this._cachedGridContext);
    } else {
      ovLog('[OV-DEBUG] _closePreview: NO cache, full _renderAssetGrid');
      await this._renderAssetGrid();
    }
    this._schedulePreviewReturnScrollRestore(savedScrollTop);
    console.timeEnd('_closePreview grid render');

    console.time('_closePreview details panel');
    /*
    // ★ 修补缓存：只重建 selectedDetail（O(1)），避免全量 _prepareContext()（O(n) 对万级素材库）
    // ⚠️ 同步点 3/3：新增字段须同步到 _prepareContext 预览路径(1/3) 和正常路径(2/3)
    // 计划：抽取为 _buildSelectedDetail() 共享方法（见 计划/OV/抽取_buildSelectedDetail共享方法.md）
    if (this._cachedGridContext && previewedItemId) {
      if (this._cachedGridContext && previewedItemId) {
        const detailItem = this.library.getItem(previewedItemId);
      if (detailItem) {
        this._cachedGridContext.selectedDetail = await this._buildSelectedDetail(detailItem, {
          allFolders: this.library.getAllFolders(),
          hydrateDocumentData: false
        });
      }
      // 同步面板状态标志
      this._cachedGridContext.previewItem = null;
      this._cachedGridContext.sceneBrowserVisible = this.sceneBrowserVisible;
      this._cachedGridContext.browserVisible = this.browserVisible;
      this._cachedGridContext.itemBrowserVisible = this.itemBrowserVisible;
      this._cachedGridContext.actorBrowserVisible = this.actorBrowserVisible;
      this._cachedGridContext.selectedItems = Array.from(this.selectedItems || []);
      this._cachedGridContext.selectedCount = this.selectedItems?.size || 0;
      await this._renderDetailsPanel(this._cachedGridContext);
    } else {
      // 无缓存时 fallback 到全量
      await this._renderDetailsPanel();
    }
    */
    if (this._cachedGridContext && previewedItemId) {
      const detailItem = this.library.getItem(previewedItemId);
      if (detailItem) {
        this._cachedGridContext.selectedDetail = await this._buildSelectedDetail(detailItem, {
          allFolders: this.library.getAllFolders(),
          hydrateDocumentData: false
        });
      }

      this._cachedGridContext.previewItem = null;
      this._cachedGridContext.sceneBrowserVisible = this.sceneBrowserVisible;
      this._cachedGridContext.browserVisible = this.browserVisible;
      this._cachedGridContext.itemBrowserVisible = this.itemBrowserVisible;
      this._cachedGridContext.actorBrowserVisible = this.actorBrowserVisible;
      this._cachedGridContext.selectedItems = Array.from(this.selectedItems || []);
      this._cachedGridContext.selectedCount = this.selectedItems?.size || 0;
      await this._renderDetailsPanel(this._cachedGridContext);
    } else {
      await this._renderDetailsPanel();
    }
    console.timeEnd('_closePreview details panel');
    console.timeEnd('_closePreview total');

    this._savedPreviewReturnAnchors = [];
    this._savedScrollTop = 0;

    // 释放重入锁
    this._closingPreview = false;
    if (returnSelection) this.comparisonPanel?.select(this.comparisonPanel.selection.activeKey, true);
  };

  cls.prototype._updatePreviewTransform = function () {
    // 只对图片应用变换 (视频不支持缩放/旋转)
    const img = this.element.querySelector('.preview-container img');
    if (img) {
      img.style.transform = `translate(${this.previewState.panX}px, ${this.previewState.panY}px) scale(${this.previewState.scale}) rotate(${this.previewState.rotation}deg)`;
    }

    // 更新工具栏状态
    const zoomText = this.element.querySelector('.zoom-percentage');
    if (zoomText) zoomText.textContent = `${Math.round(this.previewState.scale * 100)}%`;

    const zoomSlider = this.element.querySelector('.zoom-slider');
    if (zoomSlider) zoomSlider.value = Math.round(this.previewState.scale * 100);

    // 更新导航器
    this._updateNavigator();
  };

  cls.prototype._setZoom = function (scale) {
    this.previewState.scale = Math.min(Math.max(0.1, scale), 5);
    this._updatePreviewTransform();
  };

  cls.prototype._rotatePreview = function (deg) {
    this.previewState.rotation += deg;
    this._updatePreviewTransform();
  };

  cls.prototype._resetPreview = function () {
    this.previewState = {
      scale: 1,
      panX: 0,
      panY: 0,
      isDragging: false,
      lastMouseX: 0,
      lastMouseY: 0,
      rotation: 0
    };
    this._updatePreviewTransform();
  };

  cls.prototype._fitScreen = function () {
    // 简单实现：重置为 100% 或计算适应比例
    // 这里简化为重置
    this._resetPreview();
  };

  cls.prototype._updateNavigator = function () {
    // 简单的导航器视口更新逻辑
    // 实际需要计算比例
    // 暂时略过复杂计算
  };

  cls.prototype._openQuickLook = function (itemId, item = this.library.getItem(itemId), options = {}) {
    // 保留此方法兼容性，但内部转向 _openPreview
    return this._openPreview(itemId, item, options);
  };
}
