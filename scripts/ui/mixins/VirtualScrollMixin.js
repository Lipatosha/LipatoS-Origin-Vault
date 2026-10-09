// 未来的我：别再用 jQuery ($) 了！所有 DOM 操作用原生 API
// 现有的 $() 调用是历史债务，重构时逐步干掉
/**
 * VirtualScrollMixin - 虚拟滚动引擎
 * 从 MainWindow 提取的虚拟滚动相关方法
 * 
 * 包含：位置计算、可见项检测、卡片渲染、滚动事件、卡片事件绑定、初始化与重布局
 * 混入后通过 this 访问 MainWindow 实例状态
 */

import { MODULE_ID, IS_MAD_EDITION, FILE_TYPES, RARITY_COLORS } from '../../constants.js';
import { hasTranslation, t } from '../../utils/i18n.js';
import { ovLog } from '../../utils/logger.js';
import { getWorldSceneId } from '../../utils/worldSceneBindings.js';
import { getActorBadgeLabel, escapeActorDisplayText as escapeText } from '../../utils/actorDisplay.js';
import { buildThumbnailSrc } from '../../utils/thumbnailUrl.js';

/**
 * 将虚拟滚动方法混入目标类
 * @param {Function} cls - 目标类 (MainWindow)
 */
export function applyVirtualScrollMixin(cls) {

    /**
     * 计算所有素材的布局位置
     * 使用 Justified Gallery（两端对齐画廊）算法 - Eagle 风格
     * 每行内的图片高度相同，图片被缩放以填满整行
     * @param {Array} items - 素材数组（需包含 aspectRatio）
     * @param {number} containerWidth - 容器宽度
     * @param {number} gridSize - 目标行高的基准
     * @param {number} gap - 卡片间距
     */
    cls.prototype._calculateItemPositions = function (items, containerWidth, gridSize = 200, gap = 12) {
        this.itemPositions.clear();
        this._positionsByTop = [];

        if (!items.length) {
            this.virtualTotalHeight = 0;
            return;
        }

        // 固定的信息栏高度
        const INFO_HEIGHT = 32;
        // 目标缩略图行高（基于 gridSize）
        const targetThumbnailHeight = gridSize;

        ovLog(`${MODULE_ID} | Justified layout: containerWidth=${containerWidth}, targetHeight=${targetThumbnailHeight}`);

        let currentRow = [];
        let currentRowWidth = 0;
        let y = 0;
        let itemIndex = 0;

        // 处理每个图片
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const ratio = item.aspectRatio || 1;
            // 以目标行高计算理想宽度
            const idealWidth = targetThumbnailHeight * ratio;

            currentRow.push({ item, idealWidth, ratio, originalIndex: i });
            currentRowWidth += idealWidth + (currentRow.length > 1 ? gap : 0);

            // 检查是否应该换行
            const isLastItem = i === items.length - 1;
            const rowFull = currentRowWidth >= containerWidth;

            if (rowFull || isLastItem) {
                // 计算实际行高以使该行填满容器宽度
                const totalGap = (currentRow.length - 1) * gap;
                const totalIdealWidth = currentRow.reduce((sum, it) => sum + it.idealWidth, 0);

                // 缩放因子：使总宽度（不含间隙）等于可用宽度
                let scale = (containerWidth - totalGap) / totalIdealWidth;

                // 如果是最后一行且未填满，不强制拉伸（保持目标行高）
                if (isLastItem && !rowFull) {
                    scale = Math.min(scale, 1); // 不放大，最多保持原大小
                }

                const actualThumbnailHeight = Math.round(targetThumbnailHeight * scale);
                const actualCardHeight = actualThumbnailHeight + INFO_HEIGHT;

                // 布局当前行
                let x = 0;
                for (const rowItem of currentRow) {
                    const width = Math.round(rowItem.idealWidth * scale);

                    const pos = {
                        top: y,
                        left: Math.round(x),
                        width,
                        height: actualCardHeight,
                        thumbnailHeight: actualThumbnailHeight,
                        index: itemIndex++
                    };
                    this.itemPositions.set(rowItem.item.id, pos);
                    this._positionsByTop.push({
                        id: rowItem.item.id,
                        item: rowItem.item,
                        pos,
                        top: pos.top,
                        bottom: pos.top + pos.height
                    });

                    x += width + gap;
                }

                // 下一行
                y += actualCardHeight + gap;
                currentRow = [];
                currentRowWidth = 0;
            }
        }

        this._positionsByTop.sort((a, b) => (a.top - b.top) || (a.pos.left - b.pos.left));

        // 总高度
        this.virtualTotalHeight = y - gap;
    };

    /**
     * 获取可见区域内的素材
     * @param {number} scrollTop - 当前滚动位置
     * @param {number} viewportHeight - 视口高度
     * @returns {Array} 可见素材数组
     */
    cls.prototype._getVisibleItems = function (scrollTop, viewportHeight) {
        const visibleItems = [];
        const buffer = this.virtualBuffer;
        const minTop = scrollTop - buffer;
        const maxTop = scrollTop + viewportHeight + buffer;
        const positions = this._positionsByTop;

        if (!Array.isArray(positions) || positions.length === 0) {
            for (const item of this.allItems) {
                const pos = this.itemPositions.get(item.id);
                if (!pos) continue;

                const itemBottom = pos.top + pos.height;
                if (itemBottom >= minTop && pos.top <= maxTop) {
                    visibleItems.push({ ...item, _pos: pos });
                }
            }
            return visibleItems;
        }

        let low = 0;
        let high = positions.length - 1;
        let startIndex = positions.length;

        while (low <= high) {
            const mid = (low + high) >> 1;
            if (positions[mid].bottom >= minTop) {
                startIndex = mid;
                high = mid - 1;
            } else {
                low = mid + 1;
            }
        }

        for (let i = startIndex; i < positions.length; i++) {
            const entry = positions[i];
            if (entry.top > maxTop) break;
            visibleItems.push({ ...entry.item, _pos: entry.pos });
        }

        return visibleItems;
    };

    /**
     * 渲染可见的素材卡片
     * @param {Array} visibleItems - 可见素材数组
     */
    cls.prototype._renderVisibleItems = function (visibleItems) {
        const container = $(this.element)?.find('.asset-grid-virtual');
        if (!container?.length) return;

        const newRenderedIds = new Set(visibleItems.map(item => item.id));

        // 移除不再可见的卡片
        for (const id of this.renderedItems) {
            if (!newRenderedIds.has(id)) {
                container.find(`.asset-card[data-item-id="${id}"]`).remove();
            }
        }

        // 添加新进入视口的卡片
        for (const item of visibleItems) {
            if (!this.renderedItems.has(item.id)) {
                const cardHtml = this._createAssetCardHtml(item);
                container.append(cardHtml);
            }
        }

        // 更新已渲染集合
        this.renderedItems = newRenderedIds;
    };

    /**
     * 创建单个素材卡片的 HTML
     * @param {object} item - 素材对象 (包含 _pos 位置信息)
     * @returns {string} HTML 字符串
     */
    cls.prototype._renderVirtualItemsAtTop = function (gridContainer) {
        if (!gridContainer?.length) return;

        gridContainer.scrollTop(0);

        const viewportHeight = gridContainer.height();
        const visibleItems = this._getVisibleItems(0, viewportHeight);
        this._renderVisibleItems(visibleItems);
        this._bindVirtualCardEvents();
        this._initHoverScrubbing($(this.element));
        this._drawWaveforms();
    };

    // 主网格和对比面板共用卡片；布局位置与选择状态由各自容器提供。
    cls.prototype._createAssetCardHtml = function (item, { position = item._pos, selected = this.selectedItems.has(item.id) } = {}) {
        const pos = position;
        const isSelected = selected;
        const ext = '.' + item.path.split('.').pop().toLowerCase();
        const isVideo = FILE_TYPES.VIDEO.includes(ext);
        const isAudio = FILE_TYPES.AUDIO.includes(ext);
        const isScene = item.metadata?.type === 'scene' || item.type === 'scene' || ext === '.ov-scene';
        const isItem = item.metadata?.type === 'item';
        const isActor = item.metadata?.type === 'actor';
        let fileExt;
        if (isScene) {
            fileExt = t('origin-vault.fileTypes.scene') || '场景';
        } else if (isItem) {
            const itemType = item.metadata?.itemType || 'item';
            fileExt = hasTranslation(`TYPES.Item.${itemType}`)
                ? t(`TYPES.Item.${itemType}`)
                : itemType.charAt(0).toUpperCase() + itemType.slice(1);
        } else if (isActor) {
            fileExt = getActorBadgeLabel(item);
        } else {
            fileExt = item.path.split('.').pop().toUpperCase();
        }

        // 检测已导入场景
        let isImportedScene = false;
        let isCurrentWorldScene = false;
        if (isScene) {
            const persistedWorldSceneId = getWorldSceneId(item, { library: this.library });
            isCurrentWorldScene = !!persistedWorldSceneId;
            if (persistedWorldSceneId && game.scenes?.get(persistedWorldSceneId)) {
                isImportedScene = true;
            } else {
                this._ensureImportedSceneCache();
                const uuid = item.metadata?.uuid || item.uuid;
                if (uuid && this._importedSceneUuids.has(uuid)) {
                    isImportedScene = true;
                } else {
                    const sceneName = (item.metadata?.sceneName || item.name || item.displayName || '').toLowerCase();
                    if (sceneName && this._importedSceneNames?.has(sceneName)) {
                        isImportedScene = true;
                    }
                }
            }
        }

        // 检测已导入物品
        let isImportedItem = false;
        if (isItem) {
            this._ensureImportedItemCache();
            const uuid = item.metadata?.uuid || item.uuid;
            if (uuid && this._importedItemUuids.has(uuid)) {
                isImportedItem = true;
            }
        }

        let isImportedActor = false;
        if (isActor) {
            const importState = this._resolveImportState?.(item, { type: 'actor' });
            isImportedActor = !!importState?.imported;
        }

        let badgeClass = 'file-type-badge';
        if (isImportedScene) badgeClass += ' imported-scene';
        if (isCurrentWorldScene) badgeClass += ' world-scene';
        if (isItem) badgeClass += ' item-badge';
        if (isImportedItem) badgeClass += ' imported-item';
        if (isActor) badgeClass += ' actor-badge';
        if (isImportedActor) badgeClass += ' imported-actor';
        // MAD 版场景卡片：用 logo 角标替代文字角标
        if (IS_MAD_EDITION && isScene) {
            badgeClass += ' mad-logo-badge';
            if (!isImportedScene) badgeClass += ' not-imported';
        }

        // 稀有度角标颜色（从 metadata 读取，不依赖系统类型）
        let badgeStyle = '';
        if (isItem) {
            const rarity = item.metadata?.rarity || '';
            const rarityColor = rarity ? (RARITY_COLORS[rarity] || '') : '';
            if (rarityColor) {
                if (isImportedItem) {
                    // 已导入：实心填充稀有度颜色
                    badgeStyle = `background: ${rarityColor}dd; border-color: ${rarityColor}66;`;
                } else {
                    // 未导入：白底 + 稀有度颜色边框 + 彩色字
                    badgeStyle = `background: rgba(255,255,255,0.95); border: 1.5px solid ${rarityColor}; color: ${rarityColor}; text-shadow: none;`;
                }
            } else {
                // 无稀有度（法术、职业等）：保持默认紫色，但区分导入状态
                if (!isImportedItem) {
                    badgeStyle = `background: rgba(255,255,255,0.95); border: 1.5px solid #7e57c2; color: #7e57c2; text-shadow: none;`;
                }
            }
        }

        const displayName = escapeText(item.displayName || item.name || item.path.split('/').pop());
        const safeId = escapeText(item.id);

        let thumbnailContent = '';
        if (item.thumbnailGenerated && item.thumbnail) {
            thumbnailContent = `<img src="${escapeText(buildThumbnailSrc(item))}" alt="${displayName}" loading="lazy">`;
        } else {
            const icon = isVideo ? 'fa-film' : (isAudio ? 'fa-music' : 'fa-image');
            // 后台导入中的素材显示骨架屏动画，已完成的显示静态占位图标
            const skeletonClass = this._backgroundTask ? 'thumbnail-placeholder ov-skeleton' : 'thumbnail-placeholder';
            thumbnailContent = `<div class="${skeletonClass}"><i class="fas ${icon}"></i></div>`;
        }

        // 预览角标 (非视频/音频)
        const previewBadge = (!isVideo && !isAudio) ?
            `<div class="preview-badge ov-preview-badge"><i class="fas fa-eye"></i></div>` : '';

        // 进度条 (视频/音频)
        const progressBar = (isVideo || isAudio) ?
            `<div class="inline-progress ov-inline-progress"><div class="bar ov-inline-progress-bar"></div></div>` : '';

        // 音频波形
        const waveform = isAudio ?
            `<div class="waveform-container ov-waveform-container" data-item-id="${safeId}"><canvas class="ov-waveform-canvas"></canvas></div>` : '';

        return `
      <div class="asset-card ${isSelected ? 'selected' : ''}" 
           data-item-id="${safeId}"
           data-aspect-ratio="${item.aspectRatio || 1}"
           draggable="true"
           ${pos ? `style="position: absolute; top: ${pos.top}px; left: ${pos.left}px; width: ${pos.width}px; height: ${pos.height}px;"` : ''}>
        <div class="asset-thumbnail" style="${pos ? `height: ${pos.thumbnailHeight || pos.height - 32}px;` : `aspect-ratio: ${Number(item.aspectRatio) || 1};`}">
          <div class="${badgeClass}"${badgeStyle ? ` style="${badgeStyle}"` : ''}>${escapeText(fileExt)}</div>
          ${thumbnailContent}
          ${previewBadge}
          ${progressBar}
          ${waveform}
        </div>
        <div class="asset-info">
          <div class="asset-name" title="${displayName}">${displayName}</div>
        </div>
      </div>
    `;
    };

    /**
     * Get the pixel offset of the subfolders row within the scroll container.
     * Virtual scroll items are positioned relative to .asset-grid-virtual,
     * but scrollTop is relative to .asset-grid (which includes subfolders-row).
     * @param {HTMLElement} scrollContainer - The .asset-grid element
     * @returns {number} The height of the subfolders row (including margin)
     */
    cls.prototype._getSubfoldersOffset = function (scrollContainer) {
        const subfoldersRow = scrollContainer?.querySelector?.('.subfolders-row');
        if (!subfoldersRow) return 0;
        // Include the element's full height + margin-bottom
        const style = getComputedStyle(subfoldersRow);
        return subfoldersRow.offsetHeight + parseFloat(style.marginBottom || 0);
    };

    /**
     * 虚拟滚动事件处理器
     */
    cls.prototype._onVirtualScroll = function (event) {
        if (!this.virtualScrollEnabled) return;

        // 防抖处理
        if (this._scrollDebounceTimer) {
            cancelAnimationFrame(this._scrollDebounceTimer);
        }

        this._scrollDebounceTimer = requestAnimationFrame(() => {
            const container = event.target;
            const scrollTop = container.scrollTop;
            const viewportHeight = container.clientHeight;

            // Adjust scrollTop for the subfolders row offset
            // Items are positioned relative to .asset-grid-virtual which starts after subfolders-row
            const subfoldersOffset = this._getSubfoldersOffset(container);
            const adjustedScrollTop = Math.max(0, scrollTop - subfoldersOffset);

            const visibleItems = this._getVisibleItems(adjustedScrollTop, viewportHeight);
            this._renderVisibleItems(visibleItems);

            // 重新绑定事件
            this._bindVirtualCardEvents();

            // 新渲染的卡片需要重新绑定悬停刷取事件
            this._initHoverScrubbing($(this.element));

            // 绘制新卡片的波形
            this._drawWaveforms();
        });
    };

    /**
     * 绑定虚拟滚动卡片的事件
     */
    cls.prototype._bindVirtualCardEvents = function () {
        // V2: this.element is native HTMLElement, wrap with jQuery
        const html = $(this.element);
        if (!html.length) return;

        // 只绑定新添加的卡片 (未绑定过的)
        html.find('.asset-card:not(.ov-compare-card):not([data-events-bound])').each((i, card) => {
            const $card = $(card);
            $card.attr('data-events-bound', 'true');

            const itemId = $card.data('item-id');

            // 注意: click/dblclick 已由 activateListeners 中的事件代理处理，
            // 不在此重复绑定，避免双重触发导致多选失效

            // 右键菜单
            $card.on('contextmenu', (e) => {
                e.preventDefault();
                this._onItemContextMenu(e, itemId);
            });

            // 拖拽开始
            $card.on('dragstart', (e) => {
                this._onItemDragStart(e, itemId);
            });

            // 预览徽章 (Eagle 风格 - 悬停/点击)
            this._bindAssetPreviewBadges($card);
        });
    };

    /**
     * 初始化虚拟滚动
     */
    cls.prototype._initVirtualScroll = function () {
        ovLog('[OV-TRACE] _initVirtualScroll called', new Error().stack.split('\n').slice(1,4).join(' <- '));
        const gridContainer = $(this.element)?.find('.asset-grid');
        if (!gridContainer?.length) return;

        // 强制浏览器重排以确保获取正确的尺寸
        const forceReflow = gridContainer[0].offsetHeight;

        // 获取容器尺寸 (使用 clientWidth 以排除滚动条宽度，确保一致性)
        const containerWidth = gridContainer[0].clientWidth - 32; // padding

        // 如果容器宽度无效，稍后重试 (防止无限循环)
        if (containerWidth < 100) {
            ovLog(`${MODULE_ID} | Container width invalid (${containerWidth}), scheduling retry`);
            if (!this._virtualScrollRetryScheduled) {
                this._virtualScrollRetryScheduled = true;
                setTimeout(() => {
                    this._virtualScrollRetryScheduled = false;
                    this._initVirtualScroll();
                }, 100);
            }
            return;
        }

        const baseGridSize = this.library.getSetting('gridSize') || 200;
        // 窗口模式下缩小 50%
        const gridSize = this.isWindowed ? baseGridSize * 0.5 : baseGridSize;

        ovLog(`${MODULE_ID} | Virtual scroll init: containerWidth=${containerWidth}, gridSize=${gridSize}, items=${this.allItems.length}, lastWidth=${this._lastVirtualContainerWidth || 'N/A'}, isWindowed=${this.isWindowed}`);

        // 计算所有位置
        this._calculateItemPositions(this.allItems, containerWidth, gridSize);

        // 获取虚拟容器
        const virtualContainer = gridContainer.find('.asset-grid-virtual');

        // 设置容器高度
        virtualContainer.css('height', this.virtualTotalHeight + 'px');

        // 清除所有已渲染的卡片 (重新布局时必须清除)
        // 移除这一行以减少闪烁：virtualContainer.removeClass('layout-ready');
        virtualContainer.find('.asset-card').remove();
        this.renderedItems.clear();

        // 恢复滚动位置 (如有)
        ovLog(`${MODULE_ID} | [DEBUG] _initVirtualScroll: checking scroll restoration...`);
        ovLog(`${MODULE_ID} | [DEBUG]   _scrollAnchorIds:`, this._scrollAnchorIds);
        ovLog(`${MODULE_ID} | [DEBUG]   _restoreScrollIndex:`, this._restoreScrollIndex);
        ovLog(`${MODULE_ID} | [DEBUG]   _fallbackScrollTop:`, this._fallbackScrollTop);

        let scrollRestored = false;
        const forceTopRender = !!this._skipScrollRestore || !!this._forceTopScrollOnNextGridRender;

        // If _skipScrollRestore is set, force scrollTop=0 and skip all restoration
        if (this._skipScrollRestore) {
            this._skipScrollRestore = false;
            gridContainer.scrollTop(0);
            this._scrollAnchorIds = null;
            this._restoreScrollIndex = -1;
            this._fallbackScrollTop = null;
            scrollRestored = true;
            ovLog(`${MODULE_ID} | [DEBUG] _skipScrollRestore: forced scrollTop=0`);
        }

        // Handle pending scene locate
        let pendingLocateId = null;
        if (this._pendingLocateItemId) {
            pendingLocateId = this._pendingLocateItemId;
            this._pendingLocateItemId = null;
            this._scrollAnchorIds = null;
            this._restoreScrollIndex = -1;
            this._fallbackScrollTop = null;
        }

        // Calculate subfolders row offset (pos.top is relative to .asset-grid-virtual,
        // but scrollTop is relative to .asset-grid which includes subfolders-row above)
        const scrollSubfoldersOffset = this._getSubfoldersOffset(gridContainer[0]);

        // Pending locate: scroll to the target item position and highlight it
        if (pendingLocateId) {
            const pos = this.itemPositions.get(pendingLocateId);
            if (pos) {
                const targetTop = Math.max(0, pos.top + scrollSubfoldersOffset - (gridContainer.height() / 2) + (pos.height / 2));
                ovLog(`${MODULE_ID} | [LOCATE] Scrolling to item ${pendingLocateId}, pos.top=${pos.top}, targetScrollTop=${targetTop}`);
                gridContainer.scrollTop(targetTop);
                scrollRestored = true;
            } else {
                console.warn(`${MODULE_ID} | [LOCATE] Item ${pendingLocateId} not found in itemPositions`);
            }
        }

        // 优先使用锚点ID恢复 (用于缩放、添加删除等改变布局的情况)
        if (!pendingLocateId && this._scrollAnchorIds && this._scrollAnchorIds.length > 0) {
            ovLog(`${MODULE_ID} | [DEBUG] Trying anchor restoration with ${this._scrollAnchorIds.length} anchors`);
            for (const anchor of this._scrollAnchorIds) {
                // 兼容旧格式(string)和新格式({id, offset})
                const id = typeof anchor === 'string' ? anchor : anchor.id;
                const offset = typeof anchor === 'object' ? anchor.offset : 0;

                // 检查该 ID 是否还在
                if (this.itemPositions.has(id)) {
                    const pos = this.itemPositions.get(id);
                    // 目标 scrollTop = itemTop - visibleOffset
                    // 确保不小于0
                    const targetTop = Math.max(0, pos.top + scrollSubfoldersOffset - offset);

                    ovLog(`${MODULE_ID} | [DEBUG] SUCCESS: Restoring scroll to anchor item ${id}, pos.top: ${pos.top}, subfoldersOffset: ${scrollSubfoldersOffset}, offset: ${offset} -> scrollTop: ${targetTop}`);
                    gridContainer.scrollTop(targetTop);
                    scrollRestored = true;
                    this._fallbackScrollTop = null;
                    this._restoreScrollIndex = -1;
                    // 找到一个就够了
                    break;
                } else {
                    ovLog(`${MODULE_ID} | [DEBUG] Anchor ${id} not found in itemPositions`);
                }
            }
            this._scrollAnchorIds = null;
        }
        // 后备：使用索引恢复 (兼容旧逻辑)
        else if (!pendingLocateId && this._restoreScrollIndex !== undefined && this._restoreScrollIndex !== -1) {
            ovLog(`${MODULE_ID} | [DEBUG] Trying index restoration with index ${this._restoreScrollIndex}`);
            if (this.allItems[this._restoreScrollIndex]) {
                const item = this.allItems[this._restoreScrollIndex];
                const pos = this.itemPositions.get(item.id);
                if (pos) {
                    ovLog(`${MODULE_ID} | [DEBUG] SUCCESS: Restoring scroll position to item index ${this._restoreScrollIndex}, top: ${pos.top}`);
                    gridContainer.scrollTop(pos.top + scrollSubfoldersOffset);
                    scrollRestored = true;
                    this._fallbackScrollTop = null;
                }
            }
            this._restoreScrollIndex = -1;
        }
        // 最后备用：直接使用保存的 scrollTop (可能不完美，但至少不会回顶)
        else if (!pendingLocateId && this._fallbackScrollTop && this._fallbackScrollTop > 0) {
            ovLog(`${MODULE_ID} | [DEBUG] Trying fallback scrollTop restoration`);
            // 简单的比例换算：如果新高度变了，按比例调整
            const scrollRatio = this._fallbackScrollTop / (this._lastVirtualTotalHeight || this.virtualTotalHeight || this._fallbackScrollTop);
            const targetTop = Math.round(scrollRatio * this.virtualTotalHeight);
            ovLog(`${MODULE_ID} | [DEBUG] SUCCESS: Fallback restoring scrollTop from ${this._fallbackScrollTop} to ${targetTop} (ratio: ${scrollRatio.toFixed(3)})`);
            gridContainer.scrollTop(targetTop);
            scrollRestored = true;
            this._fallbackScrollTop = null;
        } else {
            ovLog(`${MODULE_ID} | [DEBUG] NO restoration method available!`);
        }

        ovLog(`${MODULE_ID} | [DEBUG] Scroll restoration complete. scrollRestored=${scrollRestored}, final scrollTop=${gridContainer.scrollTop()}`);

        // 保存当前总高度，供下次比例计算使用
        this._lastVirtualTotalHeight = this.virtualTotalHeight;

        // 初始渲染
        const scrollTop = gridContainer.scrollTop();
        const viewportHeight = gridContainer.height();
        // Adjust scrollTop for the subfolders row offset
        const subfoldersOffset = this._getSubfoldersOffset(gridContainer[0]);
        const adjustedScrollTop = Math.max(0, scrollTop - subfoldersOffset);
        const visibleItems = this._getVisibleItems(adjustedScrollTop, viewportHeight);
        this._renderVisibleItems(visibleItems);

        if (forceTopRender) {
            this._renderVirtualItemsAtTop(gridContainer);
            this._forceTopScrollOnNextGridRender = false;
        }

        // 布局完成后立即显示 (使用 requestAnimationFrame 确保渲染完成)
        requestAnimationFrame(() => {
            if (forceTopRender) {
                this._renderVirtualItemsAtTop(gridContainer);
                this._forceTopScrollOnNextGridRender = false;
            }
            virtualContainer.addClass('layout-ready');

            // Highlight the located item (scene locate)
            if (pendingLocateId) {
                const card = this.element?.querySelector(`.asset-card[data-item-id="${pendingLocateId}"]`);
                if (card) {
                    card.classList.add('locate-highlight');
                    setTimeout(() => card.classList.remove('locate-highlight'), 2000);
                }
            }
        });

        // 绑定滚动事件
        gridContainer.off('scroll.virtual').on('scroll.virtual', (e) => this._onVirtualScroll(e));

        // 绑定卡片事件
        this._bindVirtualCardEvents();

        // 绑定窗口大小变化事件 (使用 ResizeObserver)
        if (this._virtualResizeObserver) {
            this._virtualResizeObserver.disconnect();
        }

        // 保存当前宽度到实例变量
        this._lastVirtualContainerWidth = containerWidth;

        this._virtualResizeObserver = new ResizeObserver((entries) => {
            // 防抖处理
            if (this._resizeDebounceTimer) {
                clearTimeout(this._resizeDebounceTimer);
            }
            this._resizeDebounceTimer = setTimeout(() => {
                const newWidth = gridContainer[0].clientWidth - 32;

                // 只有当新宽度有效且变化超过阈值时才重新计算
                if (newWidth > 100 && Math.abs(newWidth - this._lastVirtualContainerWidth) > 10) {
                    ovLog(`${MODULE_ID} | Container resized from ${this._lastVirtualContainerWidth} to ${newWidth}`);
                    this._initVirtualScroll();
                }
            }, 150);
        });

        this._virtualResizeObserver.observe(gridContainer[0]);

        // 绘制波形
        setTimeout(() => this._drawWaveforms(), 100);

        // 初始化视频预加载 (虚拟滚动模式)
        this._initVideoPreloading($(this.element));

        // 初始化悬停刷取 (使用 element 上完整的事件代理)
        this._initHoverScrubbing($(this.element));
    };

    /**
     * 虚拟滚动重新布局 (用于网格缩放)
     * 清空已渲染卡片，重新计算布局后只重绘可见区域
     * 5K 素材也只渲染 ~30-50 个可见卡片，性能无影响
     */
    cls.prototype._relayoutVirtualScroll = function () {
        ovLog('[OV-TRACE] _relayoutVirtualScroll called', new Error().stack.split('\n').slice(1,4).join(' <- '));
        const gridContainer = $(this.element)?.find('.asset-grid');
        if (!gridContainer?.length) return;

        const containerWidth = gridContainer[0].clientWidth - 32;
        if (containerWidth < 100) return;

        const baseGridSize = this.library.getSetting('gridSize') || 200;
        const gridSize = this.isWindowed ? baseGridSize * 0.5 : baseGridSize;

        // 1. 重新计算所有位置
        this._calculateItemPositions(this.allItems, containerWidth, gridSize);

        // 2. 更新虚拟容器高度
        const virtualContainer = gridContainer.find('.asset-grid-virtual');
        if (!virtualContainer.length) return;
        virtualContainer.css('height', this.virtualTotalHeight + 'px');

        // 3. 清空所有已渲染的卡片 DOM
        virtualContainer.find('.asset-card').remove();
        this.renderedItems = new Set();

        // 4. 确保 scrollTop 不超出新的总高度（含子文件夹行）
        const subfoldersOffset = this._getSubfoldersOffset(gridContainer[0]);
        const maxScroll = Math.max(0, this.virtualTotalHeight + subfoldersOffset - gridContainer.height());
        const currentScroll = gridContainer.scrollTop();
        if (currentScroll > maxScroll) {
            gridContainer.scrollTop(maxScroll);
        }

        // 5. 重新渲染当前可见区域（减去子文件夹偏移量）
        const scrollTop = gridContainer.scrollTop();
        const adjustedScrollTop = Math.max(0, scrollTop - subfoldersOffset);
        const viewportHeight = gridContainer.height();
        const visibleItems = this._getVisibleItems(adjustedScrollTop, viewportHeight);
        this._renderVisibleItems(visibleItems);

        // 6. 保存容器尺寸
        this._lastVirtualContainerWidth = containerWidth;
        this._lastVirtualTotalHeight = this.virtualTotalHeight;
    };

}
