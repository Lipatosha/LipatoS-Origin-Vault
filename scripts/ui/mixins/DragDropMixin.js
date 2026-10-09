// 未来的我：别再用 jQuery ($) 了！所有 DOM 操作用原生 API
// 现有的 $() 调用是历史债务，重构时逐步干掉
/**
 * DragDropMixin - 拖拽与框选系统
 * 从 MainWindow 提取的拖拽/框选相关方法
 * 
 * 包含：框选(marquee)、拖拽展开文件夹、自动滚动、浏览器文件拖入
 * 混入后通过 this 访问 MainWindow 实例状态
 */

import { MODULE_ID, IS_MAD_EDITION } from '../../constants.js';
import { ovDebug } from '../../utils/logger.js';

/**
 * 将拖拽/框选方法混入目标类
 * @param {Function} cls - 目标类 (MainWindow)
 */
export function applyDragDropMixin(cls) {

    /**
     * 初始化框选功能 (Marquee/Lasso Selection)
     * 在网格空白区域按住鼠标拖拽画出矩形，选中矩形内的所有卡片
     */
    cls.prototype._initMarqueeSelect = function () {
        const gridContainer = this.element?.querySelector('.asset-grid');
        if (!gridContainer) return;

        // Cleanup previous handlers
        if (this._marqueeCleanup) {
            this._marqueeCleanup();
            this._marqueeCleanup = null;
        }

        let isMarquee = false;
        let startX = 0, startY = 0, startScrollTop = 0;
        let marqueeEl = null;
        let ctrlHeld = false;
        let autoScrollRAF = null;
        let lastMouseEvent = null; // 记录最新鼠标位置，供自动滚动时更新框选

        const AUTO_SCROLL_EDGE = 40; // 触发自动滚动的边缘距离(px)
        const AUTO_SCROLL_MAX_SPEED = 12; // 最大滚动速度(px/frame)

        // 更新框选矩形和选中状态
        const updateMarquee = (clientX, clientY) => {
            if (!isMarquee || !marqueeEl) return;
            const gridRect = gridContainer.getBoundingClientRect();
            const scrollTop = gridContainer.scrollTop;

            // 将起始点和当前点都转换到滚动空间坐标
            const startYInScroll = startY - gridRect.top + startScrollTop;
            const currentYInScroll = clientY - gridRect.top + scrollTop;
            const x1 = Math.min(startX, clientX) - gridRect.left;
            const y1 = Math.min(startYInScroll, currentYInScroll);
            const x2 = Math.max(startX, clientX) - gridRect.left;
            const y2 = Math.max(startYInScroll, currentYInScroll);

            marqueeEl.style.left = `${x1}px`;
            marqueeEl.style.top = `${y1}px`;
            marqueeEl.style.width = `${x2 - x1}px`;
            marqueeEl.style.height = `${y2 - y1}px`;

            this._updateMarqueeSelection(x1, y1, x2, y2, ctrlHeld, gridContainer);
        };

        // 自动滚动循环
        const autoScrollLoop = () => {
            if (!isMarquee || !lastMouseEvent) {
                autoScrollRAF = null;
                return;
            }

            const gridRect = gridContainer.getBoundingClientRect();
            const mouseY = lastMouseEvent.clientY;
            let scrollDelta = 0;

            // 鼠标接近顶部边缘 → 向上滚动
            if (mouseY < gridRect.top + AUTO_SCROLL_EDGE) {
                const proximity = Math.max(0, gridRect.top + AUTO_SCROLL_EDGE - mouseY);
                scrollDelta = -Math.ceil((proximity / AUTO_SCROLL_EDGE) * AUTO_SCROLL_MAX_SPEED);
            }
            // 鼠标接近底部边缘 → 向下滚动
            else if (mouseY > gridRect.bottom - AUTO_SCROLL_EDGE) {
                const proximity = Math.max(0, mouseY - (gridRect.bottom - AUTO_SCROLL_EDGE));
                scrollDelta = Math.ceil((proximity / AUTO_SCROLL_EDGE) * AUTO_SCROLL_MAX_SPEED);
            }

            if (scrollDelta !== 0) {
                gridContainer.scrollTop += scrollDelta;
                // 滚动后更新框选矩形（因为 scrollTop 变了）
                updateMarquee(lastMouseEvent.clientX, lastMouseEvent.clientY);
            }

            autoScrollRAF = requestAnimationFrame(autoScrollLoop);
        };

        const onMouseDown = (e) => {
            // Only start marquee on left-click in empty grid area (not on cards)
            if (e.button !== 0) return;
            if (e.target.closest('.asset-card, .subfolder-card')) return;

            // Don't start marquee in preview mode
            if (this.previewItem) return;

            startX = e.clientX;
            startY = e.clientY;
            startScrollTop = gridContainer.scrollTop;
            ctrlHeld = e.ctrlKey || e.metaKey;
            isMarquee = false; // Will become true after 5px movement

            const onMouseMove = (e2) => {
                const dx = e2.clientX - startX;
                const dy = e2.clientY - startY;

                if (!isMarquee && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
                    isMarquee = true;
                    // Create marquee rectangle element
                    marqueeEl = document.createElement('div');
                    marqueeEl.className = 'marquee-rect';
                    gridContainer.appendChild(marqueeEl);
                    // Prevent text selection during drag
                    e2.preventDefault();

                    // 启动自动滚动循环
                    if (!autoScrollRAF) {
                        autoScrollRAF = requestAnimationFrame(autoScrollLoop);
                    }
                }

                if (isMarquee) {
                    e2.preventDefault();
                    lastMouseEvent = e2;
                    updateMarquee(e2.clientX, e2.clientY);
                }
            };

            const onMouseUp = () => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);

                // 停止自动滚动
                if (autoScrollRAF) {
                    cancelAnimationFrame(autoScrollRAF);
                    autoScrollRAF = null;
                }
                lastMouseEvent = null;

                if (isMarquee) {
                    if (marqueeEl) {
                        marqueeEl.remove();
                        marqueeEl = null;
                    }
                    // Final selection update
                    this._updateSelectionVisuals();
                    this._updatePickerConfirmState();
                    this._renderDetailsPanel();
                }
                isMarquee = false;
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        };

        gridContainer.addEventListener('mousedown', onMouseDown);

        this._marqueeCleanup = () => {
            gridContainer.removeEventListener('mousedown', onMouseDown);
            if (autoScrollRAF) {
                cancelAnimationFrame(autoScrollRAF);
                autoScrollRAF = null;
            }
        };
    };

    /**
     * 计算框选矩形覆盖的卡片并更新选中状态
     */
    cls.prototype._updateMarqueeSelection = function (x1, y1, x2, y2, ctrlHeld, gridContainer) {
        const intersectedIds = new Set();

        if (this.virtualScrollEnabled && this.itemPositions.size > 0) {
            // Virtual scroll mode: use itemPositions map (faster, no DOM query needed)
            const subfoldersOffset = this._getSubfoldersOffset(gridContainer);
            for (const [id, pos] of this.itemPositions) {
                const itemTop = pos.top + subfoldersOffset;
                const itemBottom = itemTop + pos.height;
                const itemLeft = pos.left;
                const itemRight = itemLeft + pos.width;

                if (itemRight > x1 && itemLeft < x2 && itemBottom > y1 && itemTop < y2) {
                    intersectedIds.add(id);
                }
            }
        } else {
            // Standard mode: use getBoundingClientRect()
            const gridRect = gridContainer.getBoundingClientRect();
            const scrollTop = gridContainer.scrollTop;
            gridContainer.querySelectorAll('.asset-card').forEach(card => {
                const rect = card.getBoundingClientRect();
                const cardTop = rect.top - gridRect.top + scrollTop;
                const cardBottom = cardTop + rect.height;
                const cardLeft = rect.left - gridRect.left;
                const cardRight = cardLeft + rect.width;

                if (cardRight > x1 && cardLeft < x2 && cardBottom > y1 && cardTop < y2) {
                    const id = card.dataset.itemId;
                    if (id) intersectedIds.add(id);
                }
            });
        }

        // Apply selection
        if (ctrlHeld) {
            // Ctrl+drag: toggle intersected items
            // We need to track the original selection before drag started
            if (!this._marqueeOriginalSelection) {
                this._marqueeOriginalSelection = new Set(this.selectedItems);
            }
            this.selectedItems = new Set(this._marqueeOriginalSelection);
            for (const id of intersectedIds) {
                if (this._marqueeOriginalSelection.has(id)) {
                    this.selectedItems.delete(id);
                } else {
                    this.selectedItems.add(id);
                }
            }
        } else {
            this._marqueeOriginalSelection = null;
            this.selectedItems = new Set(intersectedIds);
        }

        this._updateSelectionVisuals();
    };

    // ==================== 拖拽辅助方法 ====================

    cls.prototype._clearDragExpandTimer = function () {
        if (this.dragExpandTimer) {
            clearTimeout(this.dragExpandTimer);
            this.dragExpandTimer = null;
        }
    };

    /**
     * 处理拖拽时的文件夹自动展开逻辑
     * @param {string} folderId - 当前悬停的文件夹 ID
     */
    cls.prototype._handleDragExpandLogic = function (folderId) {
        // 如果悬停在同一个文件夹上，且文件夹是折叠的
        if (this.dragLastFolderId !== folderId) {
            this._clearDragExpandTimer();
            this.dragLastFolderId = folderId;

            const folder = this.library.getFolder(folderId);
            if (folder && folder.collapsed) {
                this.dragExpandTimer = setTimeout(() => {
                    folder.collapsed = false;
                    this.library._markDirty();
                    this.autoExpandedFolders.add(folderId);

                    // 使用 DOM 操作直接展开文件夹，避免重新渲染导致拖拽状态丢失
                    this._expandFolderDOM(folderId);
                }, 600); // 600ms 后展开
            }
        }
    };

    /**
     * 通过 DOM 操作直接展开文件夹（不重新渲染整个侧边栏）
     * @param {string} folderId - 文件夹 ID
     */
    cls.prototype._expandFolderDOM = function (folderId) {
        const wrapper = $(this.element).find(`.folder-item-wrapper[data-folder-id="${folderId}"]`);
        if (!wrapper.length) return;

        const folderItem = wrapper.find('.folder-item').first();
        const toggle = wrapper.find('.folder-toggle i').first();
        const folderIcon = wrapper.find('.folder-icon i').first();

        // 更新折叠图标
        if (toggle.length) {
            toggle.removeClass('fa-chevron-right').addClass('fa-chevron-down');
        }

        // 更新文件夹图标
        if (folderIcon.hasClass('fa-folder')) {
            folderIcon.removeClass('fa-folder').addClass('fa-folder-open');
        }

        // 显示子文件夹容器（如果存在）
        let childrenContainer = wrapper.find('> .folder-children');
        if (childrenContainer.length) {
            childrenContainer.show();
        } else {
            // 如果子文件夹容器不存在，需要动态创建（这种情况需要重新渲染）
            // 但为了保持拖拽状态，延迟到拖拽结束后再处理
            // 标记需要在 dragend 时刷新
            this._pendingFolderRefresh = true;
        }
    };

    /**
     * 通过 DOM 操作直接折叠文件夹
     * @param {string} folderId - 文件夹 ID
     */
    cls.prototype._collapseFolderDOM = function (folderId) {
        const wrapper = $(this.element).find(`.folder-item-wrapper[data-folder-id="${folderId}"]`);
        if (!wrapper.length) return;

        const toggle = wrapper.find('.folder-toggle i').first();
        const folderIcon = wrapper.find('.folder-icon i').first();

        // 更新折叠图标
        if (toggle.length) {
            toggle.removeClass('fa-chevron-down').addClass('fa-chevron-right');
        }

        // 更新文件夹图标
        if (folderIcon.hasClass('fa-folder-open')) {
            folderIcon.removeClass('fa-folder-open').addClass('fa-folder');
        }

        // 隐藏子文件夹容器
        let childrenContainer = wrapper.find('> .folder-children');
        if (childrenContainer.length) {
            childrenContainer.hide();
        }
    };

    /**
     * 处理从文件浏览器拖放的文件
     * @param {DragEvent} event - 原生拖拽事件
     * @param {string} targetFolderId - 目标文件夹 ID
     */
    cls.prototype._handleBrowserFileDrop = async function (event, targetFolderId) {
        // 完整版专属：文件拖入导入（需要 features/FileUpload.js）
        if (IS_MAD_EDITION || !window._ovFileUploadEnabled) {
            ovDebug(`${MODULE_ID} | File drop import not available (features module not loaded)`);
            return;
        }
        let dataStr = event.dataTransfer.getData('application/x-origin-vault-browser-files');
        if (!dataStr) dataStr = event.dataTransfer.getData('text/plain');
        if (!dataStr) return;

        try {
            const data = JSON.parse(dataStr);
            if (data.type === 'origin-vault-browser-files') {
                await this._handleBrowserDrop(data, targetFolderId);
            }
        } catch (e) {
            // 非 JSON 数据，忽略
            ovDebug(`${MODULE_ID} | Ignoring non - JSON drop data`);
        }
    };

    cls.prototype._checkAutoCollapse = function (currentHoverFolderId) {
        // 遍历所有自动展开的文件夹，收起不再悬停且非父级的文件夹
        for (const expandedId of this.autoExpandedFolders) {
            if (expandedId !== currentHoverFolderId) {
                // 检查是否是当前悬停文件夹的父级（父级应保持展开）
                let isParent = false;
                if (currentHoverFolderId) {
                    let checkId = currentHoverFolderId;
                    while (checkId) {
                        const f = this.library.getFolder(checkId);
                        if (!f || !f.parent || f.parent === '__root__') break;
                        if (f.parent === expandedId) { isParent = true; break; }
                        checkId = f.parent;
                    }
                }

                if (!isParent) {
                    this._collapseFolderDOM(expandedId);
                    this.autoExpandedFolders.delete(expandedId);
                    // 同步数据状态
                    const folder = this.library.getFolder(expandedId);
                    if (folder) {
                        folder.collapsed = true;
                        this.library._markDirty();
                    }
                }
            }
        }
    };

    cls.prototype._handleAutoScroll = function (clientY) {
        const container = $(this.element).find('.folder-tree-content')[0];
        if (!container) return;

        const rect = container.getBoundingClientRect();
        const threshold = 50; // 边缘阈值
        const speed = 10; // 滚动速度

        if (clientY < rect.top + threshold) {
            // 向上滚动
            this._startAutoScroll(container, -speed);
        } else if (clientY > rect.bottom - threshold) {
            // 向下滚动
            this._startAutoScroll(container, speed);
        } else {
            this._stopAutoScroll();
        }
    };

    cls.prototype._startAutoScroll = function (container, amount) {
        if (this.autoScrollInterval) return;
        this.autoScrollInterval = setInterval(() => {
            container.scrollTop += amount;
        }, 20);
    };

    cls.prototype._stopAutoScroll = function () {
        if (this.autoScrollInterval) {
            clearInterval(this.autoScrollInterval);
            this.autoScrollInterval = null;
        }
    };
}
