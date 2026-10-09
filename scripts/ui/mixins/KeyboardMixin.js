/**
 * KeyboardMixin - 键盘导航与快捷键
 * 从 MainWindow 提取的键盘事件处理方法
 * 
 * 包含：键盘事件总入口、方向键导航、QuickLook 导航、素材选中
 * 混入后通过 this 访问 MainWindow 实例状态
 */

import { MODULE_ID, SPECIAL_FOLDERS, FILE_TYPES } from '../../constants.js';
import { t } from '../../utils/i18n.js';
import { QuickLook } from '../QuickLook.js';

/**
 * 将方法混入目标类
 * @param {Function} cls - 目标类 (MainWindow)
 */
export function applyKeyboardMixin(cls) {
  cls.prototype._onKeyDown = async function (event) {

    // OV 未渲染时不处理
    if (!this.element || !this.rendered) return;

    // 对比面板独立管理焦点与候选，Delete/空格不能穿透到素材库。
    if (this.comparisonPanel?.handleKey(event)) return;

    // 忽略所有可编辑元素内的键盘事件（修复 PF2e 特征搜索等）
    const tag = event.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target.isContentEditable) return;

    // 如果焦点在其他模块的窗口内（非 OV），不拦截
    const targetApp = event.target.closest?.('.application, .app, .window-app');
    if (targetApp && !this.element.contains(targetApp)) return;

    const ql = QuickLook.getInstance();

    // 1. 优先处理 QuickLook 导航 (如果 QuickLook 打开)
    if (ql.isOpen) {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        this._handleQuickLookNavigation(event.key);
        return;
      }
    }

    // 2. 箭头键导航 (网格视图) — 详情预览模式下禁用
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      if (this.previewItem) return; // 双击详情模式下方向键无效
      event.preventDefault();
      event.stopPropagation();
      this._handleArrowNavigation(event.key);
      return;
    }

    // Delete 键删除
    if (event.key === 'Delete' && this.selectedItems.size > 0) {
      event.preventDefault();
      if (this.library.isSmartFolderId?.(this.currentFolderId)) {
        ui.notifications.info(t('origin-vault.smartFolders.readOnly'));
        return;
      }
      for (const itemId of this.selectedItems) {
        await this.library.removeItemFromFolder(itemId, this.currentFolderId);
      }
      this.selectedItems.clear();
      this.render(false);
      return;
    }

    // Ctrl+A 全选
    if (event.key === 'a' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      const items = this.library.getItemsByFolder(this.currentFolderId);
      this.selectedItems = new Set(items.map(i => i.id));
      this._updateSelectionVisuals();
      this._renderDetailsPanel();
      return;
    }

    // 空格键: 打开 Quick Look (覆盖层预览)
    if (event.key === ' ' || event.code === 'Space' || event.keyCode === 32) {
      event.preventDefault();
      event.stopPropagation();

      if (ql.isOpen) {
        ql.close();
      } else if (this.previewItem) {
        // 内联预览模式下，空格控制视频播放
        const video = $(this.element).find('.preview-container video')[0];
        if (video) {
          if (video.paused) video.play();
          else video.pause();
        }
      } else if (this.selectedItems.size >= 1) {
        const itemId = this.selectedItems.values().next().value;
        const item = this.library.getItem(itemId);
        if (item) {
          // 查找对应的 DOM 元素以便执行动画
          const element = $(this.element).find(`.asset-card:not(.ov-compare-card)[data-item-id="${itemId}"] .asset-thumbnail`)[0] ||
            $(this.element).find(`.asset-card:not(.ov-compare-card)[data-item-id="${itemId}"] img`)[0];
          ql.open(item, element);
        }
      }
      return;
    }

    // ESC 键: 层级式关闭
    if (event.key === 'Escape') {
      // 文件选择器模式：ESC 退出选择模式
      if (this.filePickerMode) {
        this._exitFilePickerMode();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (ql.isOpen) {
        ql.close();
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (this.previewItem) {
        this._closePreview();
        event.preventDefault(); // 防止 Foundry 默认 ESC 处理
        event.stopPropagation();
        return;
      }
      if (this.selectedItems.size > 0) {
        this.selectedItems.clear();
        this.render(false);
        event.preventDefault(); // Prevent bubbling to close window
        event.stopPropagation();
        return;
      }
      this.constructor.hide();
      return;
    }

    // F2: 重命名
    if (event.key === 'F2') {
      if (this.selectedItems.size === 1) {
        const itemId = this.selectedItems.values().next().value;
        this._onItemRename(itemId);
      } else if (!this.currentFolderId.startsWith('__')) {
        this._onFolderRename(this.currentFolderId);
      }
      return;
    }
  };

  /**
   * 处理网格箭头导航 (基于视觉位置，适应任何布局)
   */
  cls.prototype._handleArrowNavigation = function (key) {
    if (!this.allItems || this.allItems.length === 0) return;

    // 如果还没有选中项，选中第一个
    if (this.selectedItems.size === 0) {
      this._selectItem(this.allItems[0].id);
      return;
    }

    const currentId = this.selectedItems.values().next().value;
    const currentCard = this.element.querySelector(`.asset-card:not(.ov-compare-card)[data-item-id="${currentId}"]`);

    // 如果当前卡片不在 DOM 中 (例如虚拟滚动太远)，回退到索引导航
    if (!currentCard) {
      console.warn('Current card not found in DOM, falling back to index navigation');
      return this._handleArrowNavigationByIndex(key);
    }

    const currentRect = currentCard.getBoundingClientRect();
    const cx = currentRect.left + currentRect.width / 2;
    const cy = currentRect.top + currentRect.height / 2;

    const allCards = Array.from(this.element.querySelectorAll('.asset-card:not(.ov-compare-card)'));

    let bestCandidate = null;
    let minDistance = Infinity;

    for (const card of allCards) {
      if (card === currentCard) continue;

      const rect = card.getBoundingClientRect();
      const tx = rect.left + rect.width / 2;
      const ty = rect.top + rect.height / 2;

      let isValid = false;
      let dist = Infinity;

      // 允许一定的误差 (tolerance)
      const vTolerance = currentRect.height * 0.5;
      const hTolerance = currentRect.width * 0.5;

      if (key === 'ArrowRight') {
        // 右侧：x > cx，且 y 差不多在同一行
        isValid = tx > cx && Math.abs(ty - cy) < vTolerance;
        dist = tx - cx;
      } else if (key === 'ArrowLeft') {
        // 左侧：x < cx，且 y 差不多在同一行
        isValid = tx < cx && Math.abs(ty - cy) < vTolerance;
        dist = cx - tx;
      } else if (key === 'ArrowDown') {
        // 下方：y > cy
        isValid = ty > cy;
        // 距离公式：垂直距离优先，水平偏移作为惩罚
        const dy = ty - cy;
        const dx = Math.abs(tx - cx);
        // 如果水平偏移太大（超过半个卡片宽），增加惩罚权重，防止跳到太远的列
        const penalty = dx > currentRect.width ? 5 : 2;
        dist = dy * dy + dx * dx * penalty;
      } else if (key === 'ArrowUp') {
        // 上方：y < cy
        isValid = ty < cy;
        const dy = cy - ty;
        const dx = Math.abs(tx - cx);
        const penalty = dx > currentRect.width ? 5 : 2;
        dist = dy * dy + dx * dx * penalty;
      }

      if (isValid && dist < minDistance) {
        minDistance = dist;
        bestCandidate = card;
      }
    }

    if (bestCandidate) {
      const id = bestCandidate.dataset.itemId;
      this._selectItem(id);
      this._ensureItemVisible(id);
    } else {
      // 边缘情况：如果视觉导航没找到（例如行末按右），尝试索引导航兜底
      // 但对于上下键，通常意味着到了顶/底，不做操作
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        this._handleArrowNavigationByIndex(key);
      }
    }
  };

  cls.prototype._handleArrowNavigationByIndex = function (key) {
    const currentId = this.selectedItems.values().next().value;
    const currentIndex = this.allItems.findIndex(i => i.id === currentId);
    if (currentIndex === -1) return;

    let nextIndex = currentIndex;
    if (key === 'ArrowLeft') nextIndex--;
    if (key === 'ArrowRight') nextIndex++;
    // 上下键在索引模式下很难准确预测列数，简单粗暴处理或忽略
    // 此处仅支持左右

    if (nextIndex >= 0 && nextIndex < this.allItems.length) {
      const nextItem = this.allItems[nextIndex];
      this._selectItem(nextItem.id);
      this._ensureItemVisible(nextItem.id);
    }
  };

  /**
   * 处理 QuickLook 导航 (箭头键切换上一张/下一张)
   */
  cls.prototype._handleQuickLookNavigation = function (key) {
    this._handleArrowNavigation(key);

    // 跳过音频文件：如果新选中的是音频，继续导航直到找到非音频
    const direction = (key === 'ArrowRight' || key === 'ArrowDown') ? 'ArrowRight' : 'ArrowLeft';
    let maxAttempts = 50; // 防止无限循环
    while (maxAttempts-- > 0) {
      const itemId = this.selectedItems.values().next().value;
      if (!itemId) break;
      const item = this.library.getItem(itemId);
      if (!item) break;
      const ext = item.path.substring(item.path.lastIndexOf('.')).toLowerCase();
      if (!FILE_TYPES.AUDIO.includes(ext)) break;
      // 当前是音频，继续跳
      this._handleArrowNavigation(direction);
    }

    // 同步更新 QuickLook 内容
    const ql = QuickLook.getInstance();
    if (ql.isOpen && this.selectedItems.size > 0) {
      const itemId = this.selectedItems.values().next().value;
      const item = this.library.getItem(itemId);
      if (item) {
        ql.switchAsset(item);
      }
    }
  };

  /**
   * 选中素材 (单一选中，不触发全量重绘)
   */
  cls.prototype._selectItem = function (itemId) {
    this.selectedItems.clear();
    this.selectedItems.add(itemId);

    // 更新视觉状态 (不完全重绘)
    $(this.element).find('.asset-card:not(.ov-compare-card).selected').removeClass('selected');
    $(this.element).find(`.asset-card:not(.ov-compare-card)[data-item-id="${itemId}"]`).addClass('selected');

    // 更新详情面板
    this._renderDetailsPanel();
  };

  /**
   * 确保素材卡片在可视区域内
   */
  cls.prototype._ensureItemVisible = function (itemId) {
    const card = $(this.element).find(`.asset-card:not(.ov-compare-card)[data-item-id="${itemId}"]`);
    if (!card.length) {
      // 虚拟滚动下该卡片可能未渲染，尝试用位置信息滚动
      if (this.virtualScrollEnabled && this.itemPositions) {
        const pos = this.itemPositions.get(itemId);
        if (pos) {
          const gridContainer = $(this.element).find('.asset-grid');
          const scrollTop = gridContainer.scrollTop();
          const viewportHeight = gridContainer.height();
          const subfoldersOffset = typeof this._getSubfoldersOffset === 'function'
            ? this._getSubfoldersOffset(gridContainer[0])
            : 0;
          const itemTop = pos.top + subfoldersOffset;
          const itemBottom = itemTop + pos.height;

          if (itemTop < scrollTop) {
            gridContainer.scrollTop(Math.max(0, itemTop - 20));
          } else if (itemBottom > scrollTop + viewportHeight) {
            gridContainer.scrollTop(itemBottom - viewportHeight + 20);
          }
        }
      }
      return;
    }

    card[0].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
}
