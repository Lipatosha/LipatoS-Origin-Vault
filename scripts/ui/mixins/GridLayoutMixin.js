// 未来的我：别再用 jQuery ($) 了！所有 DOM 操作用原生 API
// 现有的 $() 调用是历史债务，重构时逐步干掉
/**
 * GridLayoutMixin - 瀑布流布局引擎
 * 从 MainWindow 提取的 Justified Gallery 布局相关方法
 * 
 * 包含：布局计算、DOM 应用、调度刷新、实时比例检测
 * 混入后通过 this 访问 MainWindow 实例状态
 */

import { MODULE_ID } from '../../constants.js';
import { ovLog } from '../../utils/logger.js';

/**
 * 将瀑布流布局方法混入目标类
 * @param {Function} cls - 目标类 (MainWindow)
 */
export function applyGridLayoutMixin(cls) {

    /**
     * 强制触发布局重排 (Wiggle Fix)
     * 通过微调 gridSize 来强制 Justified Gallery 重新计算布局
     * 这是一种 "曲线救国" 的修复方案，用于解决调整窗口大小时布局不刷新的问题
     */
    cls.prototype._forceLayoutReflow = function () {
        ovLog('[OV-TRACE] _forceLayoutReflow called', new Error().stack.split('\n').slice(1,4).join(' <- '));
        const baseGridSize = this.library.getSetting('gridSize') || 160;
        const currentSize = this.isWindowed ? baseGridSize * 0.5 : baseGridSize;

        // 微调 1px
        const tempSize = currentSize + 1;

        // 应用临时大小
        this.element.style.setProperty('--ov-row-height', `${tempSize * 1.2}px`);
        this.element.style.setProperty('--ov-card-width', `${tempSize}px`);

        // 强制浏览器重绘
        const _force = this.element.offsetHeight;

        // 恢复原始大小并重新应用布局
        requestAnimationFrame(() => {
            this.element.style.setProperty('--ov-row-height', `${currentSize * 1.2}px`);
            this.element.style.setProperty('--ov-card-width', `${currentSize}px`);
            this._applyJustifiedLayout();
        });
    };

    /**
     * 调度布局刷新，确保瀑布流正确渲染
     * 使用递增延迟重试机制，防止容器尺寸未就绪时布局失败
     */
    cls.prototype._scheduleLayoutRefresh = function () {
        ovLog('[OV-TRACE] _scheduleLayoutRefresh called', new Error().stack.split('\n').slice(1,4).join(' <- '));
        // 取消之前的调度
        if (this._layoutRefreshTimer) {
            clearTimeout(this._layoutRefreshTimer);
            this._layoutRefreshTimer = null;
        }
        if (this._layoutRetryTimer) {
            clearTimeout(this._layoutRetryTimer);
            this._layoutRetryTimer = null;
        }

        const tryLayout = (attempt = 0) => {
            const grid = this.element?.querySelector('.asset-grid');
            const containerWidth = grid ? grid.clientWidth - 32 : 0;

            if (containerWidth > 100) {
                // 容器有效，执行布局
                this._applyJustifiedLayout();
            } else if (attempt < 8) {
                // 容器可能还没就绪，递增延迟重试
                const delay = 50 + attempt * 50; // 50, 100, 150, 200...
                ovLog(`${MODULE_ID} | _scheduleLayoutRefresh: containerWidth=${containerWidth}, retry ${attempt + 1} in ${delay}ms`);
                this._layoutRetryTimer = setTimeout(() => tryLayout(attempt + 1), delay);
                return; // 不要继续到 延迟最终布局
            } else {
                console.warn(`${MODULE_ID} | _scheduleLayoutRefresh: containerWidth still invalid after ${attempt} retries, forcing layout`);
                // 强制一次 reflow 再布局
                if (this.element) void this.element.offsetHeight;
                this._applyJustifiedLayout();
            }

            // 延迟执行一次最终布局，确保图片/视频元数据加载完成后比例正确
            this._layoutRefreshTimer = setTimeout(() => {
                this._applyJustifiedLayout();
                this._layoutRefreshTimer = null;
            }, 500);
        };

        // 首次尝试在下一帧
        requestAnimationFrame(() => tryLayout(0));
    };

    // ==================== Justified Gallery Layout Engine ====================

    /**
     * 计算两端对齐的瀑布流布局 (Eagle 风格)
     * @param {Array} items - 包含 aspectRatio 的素材数组
     * @param {number} containerWidth - 容器宽度
     * @param {number} targetRowHeight - 目标行高 (包含缩略图+文件名)
     * @param {number} gap - 间距
     * @returns {Array} 布局结果，每项包含 { id, width, height, thumbnailHeight, left, top }
     */
    cls.prototype._calculateJustifiedLayout = function (items, containerWidth, targetRowHeight, gap = 12) {
        if (!items || items.length === 0) return [];

        // 固定的文件名区域高度 (CSS: .asset-card .asset-info = height:38px + margin-top:4px = 42px)
        const INFO_HEIGHT = 42;
        // 实际用于计算的缩略图高度
        const thumbnailRowHeight = targetRowHeight - INFO_HEIGHT;

        const layoutItems = [];
        let currentRow = [];
        let currentRowWidth = 0;
        let y = 0;

        // 处理每个图片
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const ratio = item.aspectRatio || 1;
            // 以缩略图行高计算理想宽度
            const idealWidth = thumbnailRowHeight * ratio;

            currentRow.push({ ...item, idealWidth, ratio });
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

                const actualThumbnailHeight = thumbnailRowHeight * scale;
                const actualCardHeight = actualThumbnailHeight + INFO_HEIGHT;

                // 布局当前行
                let x = 0;
                for (const rowItem of currentRow) {
                    const width = rowItem.idealWidth * scale;
                    layoutItems.push({
                        id: rowItem.id,
                        width: Math.round(width),
                        height: Math.round(actualCardHeight),
                        thumbnailHeight: Math.round(actualThumbnailHeight),
                        left: Math.round(x),
                        top: Math.round(y)
                    });
                    x += width + gap;
                }

                // 下一行
                y += actualCardHeight + gap;
                currentRow = [];
                currentRowWidth = 0;
            }
        }

        return layoutItems;
    };

    /**
     * 应用 Justified Gallery 布局到 DOM
     */
    cls.prototype._applyJustifiedLayout = function () {
        ovLog('[OV-TRACE] _applyJustifiedLayout called', new Error().stack.split('\n').slice(1,4).join(' <- '));
        const grid = $(this.element)?.find('.asset-grid')[0];
        if (!grid) {
            return; // 预览模式下无网格，静默退出
        }

        const containerWidth = grid.clientWidth - 32; // 减去 padding
        if (containerWidth <= 0) {
            console.warn(`${MODULE_ID} | _applyJustifiedLayout: containerWidth = ${containerWidth}, skipping`);
            return; // 容器无效
        }

        // 直接从滑块读取当前值，而不是保存的设置
        const slider = $(this.element)?.find('.ov-grid-slider')[0];
        const targetRowHeight = slider ? parseInt(slider.value) : (this.library.getSetting('gridSize') || 160);
        const gap = 12;

        // 计算子文件夹行的高度偏移
        const subfoldersRow = grid.querySelector('.subfolders-row');
        const subfoldersOffset = subfoldersRow ? subfoldersRow.offsetHeight + 16 : 0; // 16 = margin-bottom

        // 获取所有卡片并读取 aspectRatio
        const cards = grid.querySelectorAll('.asset-card');
        const items = [];

        cards.forEach(card => {
            const id = card.dataset.itemId;
            const ratio = parseFloat(card.dataset.aspectRatio) || 1;
            items.push({ id, aspectRatio: ratio, element: card });
        });

        ovLog(`${MODULE_ID} | _applyJustifiedLayout: containerWidth = ${containerWidth}, cards = ${items.length}, targetRowHeight = ${targetRowHeight} `);

        // 即使没有素材，也要设置容器高度以显示子文件夹
        if (items.length === 0) {
            if (subfoldersOffset > 0) {
                grid.style.height = `${subfoldersOffset + 32}px`;
                grid.style.position = 'relative';
            }
            grid.classList.add('layout-ready');
            return;
        }

        // 计算布局
        const layout = this._calculateJustifiedLayout(items, containerWidth, targetRowHeight, gap);

        // 禁用过渡效果以防止初始加载时的位置跳变
        const isFirstLayout = !grid.classList.contains('layout-ready');

        // 如果是首次布局，强制没有任何过渡
        if (isFirstLayout) {
            grid.classList.add('no-transition');
        }

        // 应用布局
        layout.forEach(layoutItem => {
            const card = grid.querySelector(`[data-item-id="${layoutItem.id}"]`);
            if (card) {
                card.style.position = 'absolute';
                card.style.width = `${layoutItem.width}px`;
                card.style.height = `${layoutItem.height}px`;
                card.style.left = `${layoutItem.left}px`;
                card.style.top = `${layoutItem.top + subfoldersOffset}px`; // 添加偏移

                // 设置缩略图高度 (卡片高度 - 文件名区域高度)
                const thumbnail = card.querySelector('.asset-thumbnail');
                if (thumbnail) {
                    thumbnail.style.height = `${layoutItem.thumbnailHeight}px`;
                }
            }
        });

        // 设置容器高度
        if (layout.length > 0) {
            const lastItem = layout[layout.length - 1];
            grid.style.height = `${lastItem.top + lastItem.height + subfoldersOffset + 32}px`; // 32 = bottom padding
            grid.style.position = 'relative';
        }

        // 恢复过渡效果并显示
        if (isFirstLayout) {
            // 强制重绘以确保 no-transition 生效
            grid.offsetHeight;

            requestAnimationFrame(() => {
                grid.classList.remove('no-transition');
                grid.classList.add('layout-ready');
            });
        } else {
            // 如果不是第一次，确保 layout-ready 存在
            if (!grid.classList.contains('layout-ready')) {
                grid.classList.add('layout-ready');
            }
        }
    };

    /**
     * 处理窗口/容器大小变化
     */
    cls.prototype._onLayoutResize = function () {
        ovLog('[OV-TRACE] _onLayoutResize called');
        // 使用 debounce 避免频繁重排
        if (this._resizeTimer) clearTimeout(this._resizeTimer);
        this._resizeTimer = setTimeout(() => {
            this._applyJustifiedLayout();
        }, 50);
    };

    /**
     * 实时检测图片/视频的真实比例，修正布局
     * 解决元数据缺失导致的黑边问题
     * 
     * 修复要点:
     * 1. 已缓存图片 (img.complete=true) 的 load 事件在绑定前就已触发
     * 2. 服务器加载的图片可能在任意时间后才完成，不能用固定 timeout
     * 解决: 每次检测到比例变化都立即触发 debounced relayout
     */
    cls.prototype._initRealTimeAspectRatioDetection = function (html) {
        const self = this;
        let relayoutTimer = null;

        // Debounced relayout: 收集所有比例更新后统一重排
        const scheduleRelayout = () => {
            if (relayoutTimer) clearTimeout(relayoutTimer);
            relayoutTimer = setTimeout(() => {
                ovLog(`${MODULE_ID} | Aspect ratio correction: relayout triggered`);
                // ★ 虚拟滚动模式下使用虚拟滚动的重布局，避免 INFO_HEIGHT 不一致
                if (self.virtualScrollEnabled && self.allItems?.length >= self.virtualScrollThreshold) {
                    self._relayoutVirtualScroll();
                } else {
                    self._applyJustifiedLayout();
                }
                relayoutTimer = null;
            }, 100); // 100ms debounce，收集快速连续的 load 事件
        };

        // 通用的比例检测逻辑 — 检测到变化时立即调度 relayout
        const checkAndUpdateRatio = (element, naturalW, naturalH) => {
            if (!naturalW || !naturalH) return;
            const realRatio = naturalW / naturalH;
            const card = $(element).closest('.asset-card')[0];
            if (!card) return;
            const storedRatio = parseFloat(card.dataset.aspectRatio) || 1;
            // 如果差异超过 5%，更新并调度 relayout
            if (Math.abs(realRatio - storedRatio) / storedRatio > 0.05) {
                card.dataset.aspectRatio = realRatio.toFixed(4);
                // ★ 同步到 allItems 数据模型，确保缓存上下文中的比例正确
                // 这样从预览返回时不会再触发不必要的 relayout
                const itemId = card.dataset.itemId;
                if (itemId && self.allItems) {
                    const item = self.allItems.find(i => i.id === itemId);
                    if (item) item.aspectRatio = realRatio;
                }
                scheduleRelayout();
            }
        };

        // 监听图片加载（处理未缓存的图片 — 服务器加载可能需要数秒）
        html.find('.asset-thumbnail img').on('load', function () {
            checkAndUpdateRatio(this, this.naturalWidth, this.naturalHeight);
        });

        // ★ 立即检查已缓存的图片
        html.find('.asset-thumbnail img').each(function () {
            if (this.complete && this.naturalWidth) {
                checkAndUpdateRatio(this, this.naturalWidth, this.naturalHeight);
            }
        });

        // 监听视频加载
        html.find('.asset-thumbnail video').on('loadedmetadata', function () {
            checkAndUpdateRatio(this, this.videoWidth, this.videoHeight);
        });

        // ★ 立即检查已加载的视频
        html.find('.asset-thumbnail video').each(function () {
            if (this.readyState >= 1 && this.videoWidth) {
                checkAndUpdateRatio(this, this.videoWidth, this.videoHeight);
            }
        });
    };

}
