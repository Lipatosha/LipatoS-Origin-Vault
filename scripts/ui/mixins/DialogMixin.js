import { ovText } from '../../utils/locale.js';
// 未来的我：别再用 jQuery ($) 了！所有 DOM 操作用原生 API
// 现有的 $() 调用是历史债务，重构时逐步干掉
/**
 * DialogMixin - 对话框/弹窗系统
 * 从 MainWindow 提取的所有对话框、右键菜单、输入框等 UI 方法
 * 
 * 包含：标签选择器、标签管理器、帮助面板、确认弹窗、输入弹窗、右键菜单
 * 混入后通过 this 访问 MainWindow 实例状态
 */

import { MODULE_ID, IS_MAD_EDITION, OV_LAYERS } from '../../constants.js';
import { t, tf } from '../../utils/i18n.js';
import { appendJQueryToOverlayHost, getOverlayHostRect } from '../../utils/overlayHost.js';
import { listPlaylists, addAudioItemsToPlaylist, createPlaylistWithAudioItems } from '../../features/PlaylistIntegration.js';

/**
 * 将对话框方法混入目标类
 * @param {Function} cls - 目标类 (MainWindow)
 */
export function applyDialogMixin(cls) {
  const reserveOverlayZIndex = () => {
    const base = OV_LAYERS.DIALOG_OVERLAY_BASE;
    const current = Number(window._ovWindowZ) || base;
    const next = Math.max(current, base) + 1;
    window._ovWindowZ = next;
    return String(next);
  };

  cls.prototype._showContextMenu = function (event, menuItems) {
    $('.ov-context-menu').remove();

    const menu = $(`<div class="ov-context-menu"></div>`);

    for (const item of menuItems) {
      const menuItem = $(`
        <div class="ov-context-menu-item">
          ${item.icon || ''}
          <span>${item.name}</span>
        </div>
      `);
      menuItem.on('click', () => {
        menu.remove();
        item.callback();
      });
      menu.append(menuItem);
    }

    const { rect: hostRect } = getOverlayHostRect({ owner: this });
    const initialLeft = event.clientX - hostRect.left;
    const initialTop = event.clientY - hostRect.top;

    menu.css({
      position: 'absolute',
      left: `${initialLeft}px`,
      top: `${initialTop}px`,
      zIndex: String(OV_LAYERS.CONTEXT_MENU)
    });

    appendJQueryToOverlayHost(menu, { owner: this });

    const menuWidth = menu.outerWidth() || 0;
    const menuHeight = menu.outerHeight() || 0;
    const clampedLeft = Math.max(5, Math.min(initialLeft, hostRect.width - menuWidth - 5));
    const clampedTop = Math.max(5, Math.min(initialTop, hostRect.height - menuHeight - 5));
    menu.css({
      left: `${clampedLeft}px`,
      top: `${clampedTop}px`
    });

    const closeMenu = (e) => {
      if (!$(e.target).closest('.ov-context-menu').length) {
        menu.remove();
        $(document).off('click', closeMenu);
      }
    };
    setTimeout(() => $(document).on('click', closeMenu), 0);
  }

  /**
   * 显示自定义输入弹窗
   */
  cls.prototype._showInputDialog = function (title, placeholder, defaultValue = '') {
    return new Promise((resolve) => {
      const overlay = $(`
        <div class="ov-dialog-overlay">
          <div class="ov-dialog">
            <div class="ov-dialog-header">
              <h3 class="ov-dialog-title">${title}</h3>
              <button class="ov-dialog-close"><i class="fas fa-times"></i></button>
            </div>
            <div class="ov-dialog-content">
              <input type="text" class="ov-dialog-input" placeholder="${placeholder}" value="${defaultValue}">
            </div>
            <div class="ov-dialog-footer">
            <button class="ov-dialog-btn cancel">${t('origin-vault.dialog.cancel')}</button>
            <button class="ov-dialog-btn primary confirm">${t('origin-vault.dialog.confirm')}</button>
          </div>
          </div>
        </div>
      `);

      const input = overlay.find('.ov-dialog-input');

      const close = (value) => {
        overlay.remove();
        resolve(value);
      };

      overlay.find('.ov-dialog-close, .cancel').on('click', () => close(null));
      overlay.find('.confirm').on('click', () => close(input.val().trim()));

      input.on('keydown', (e) => {
        if (e.key === 'Enter') close(input.val().trim());
        if (e.key === 'Escape') close(null);
      });

      overlay.on('click', (e) => {
        if (e.target === overlay[0]) close(null);
      });

      overlay.css({
        position: 'fixed',
        zIndex: reserveOverlayZIndex()
      });

      appendJQueryToOverlayHost(overlay, { owner: this });
      input.focus().select();
    });
  }

  cls.prototype._showTagPickerDialog = function (itemId, currentTags = [], selectedItemIds = null) {
    // selectedItemIds: 如果传了，则对所有选中项操作（多选批量）
    const targetIds = selectedItemIds || new Set([itemId]);

    // 动态注入样式
    if (!document.getElementById('ov-tag-picker-styles')) {
      const css = `
        /* ==================== 标签选择器美化 (Eagle 风格即时生效) ==================== */
        
        /* Overlay 定位 */
        .ov-dialog-overlay.ov-tag-picker-overlay {
          position: absolute !important;
          top: 0 !important;
          left: 0 !important;
          right: 0 !important;
          bottom: 0 !important;
          background: rgba(0,0,0,0.15) !important;
          backdrop-filter: none !important;
          display: block !important;
          z-index: ${OV_LAYERS.DIALOG_OVERLAY_BASE} !important;
          pointer-events: auto !important;
        }
        
        .ov-dialog.ov-tag-picker {
          position: absolute !important;
          width: 320px !important;
          max-height: calc(100vh - 80px) !important;
          box-sizing: border-box !important;
          background: #1e1e1e !important;
          border: 1px solid #444 !important;
          border-radius: 8px !important;
          box-shadow: 0 8px 24px rgba(0,0,0,0.5) !important;
          overflow: hidden !important;
          display: flex !important;
          flex-direction: column !important;
        }

        .ov-tag-picker .ov-dialog-header {
          background: #252525 !important;
          padding: 16px 20px !important;
          border-bottom: 1px solid #333 !important;
          display: flex !important;
          align-items: center !important;
          justify-content: space-between !important;
          flex-shrink: 0 !important;
        }

        .ov-tag-picker .ov-dialog-title {
          font-size: 16px !important;
          font-weight: 600 !important;
          margin: 0 !important;
          color: #eee !important;
        }

        .ov-tag-picker .ov-dialog-close {
          background: none !important;
          border: none !important;
          color: #888 !important;
          cursor: pointer !important;
          width: 28px !important;
          height: 28px !important;
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
          border-radius: 4px !important;
          transition: all 0.2s !important;
        }
        .ov-tag-picker .ov-dialog-close:hover {
          background: rgba(255,255,255,0.1) !important;
          color: #fff !important;
        }

        .ov-tag-picker .ov-dialog-content {
          padding: 16px !important;
          background: #1e1e1e !important;
          flex: 1 !important;
          overflow-y: auto !important;
          overflow-x: hidden !important;
          min-width: 0 !important;
          box-sizing: border-box !important;
          display: flex !important;
          flex-direction: column !important;
        }

        .ov-tag-search {
          width: 100% !important;
          min-width: 0 !important;
          background: #2a2a2a !important;
          border: 1px solid #444 !important;
          border-radius: 6px !important;
          padding: 10px 12px !important;
          color: #fff !important;
          font-size: 14px !important;
          margin-bottom: 12px !important;
          box-sizing: border-box !important;
        }
        .ov-tag-search:focus {
          outline: none !important;
          border-color: #3498db !important;
        }

        .ov-tag-picker-list {
          flex: 1 !important;
          overflow-y: auto !important;
          overflow-x: hidden !important;
          min-width: 0 !important;
          box-sizing: border-box !important;
          padding-right: 4px !important;
          display: flex !important;
          flex-direction: column !important;
          gap: 4px !important;
          max-height: 400px !important;
        }

        .ov-tag-picker-list::-webkit-scrollbar { width: 6px !important; }
        .ov-tag-picker-list::-webkit-scrollbar-thumb { background: #444 !important; border-radius: 3px !important; }

        .ov-tag-picker-item {
          display: flex !important;
          align-items: center !important;
          max-width: 100% !important;
          box-sizing: border-box !important;
          padding: 8px 12px !important;
          border-radius: 6px !important;
          background: #252525 !important;
          cursor: pointer !important;
          transition: all 0.2s !important;
          border: 1px solid transparent !important;
          user-select: none !important;
        }

        .ov-tag-picker-item:hover {
          background: #333 !important;
        }

        .ov-tag-picker-item.selected {
          background: rgba(52, 152, 219, 0.25) !important;
          border-color: rgba(52, 152, 219, 0.5) !important;
          box-shadow: 0 0 6px rgba(52, 152, 219, 0.2) !important;
        }

        .ov-tag-picker-item .tag-color-dot {
          width: 14px !important;
          height: 14px !important;
          border-radius: 50% !important;
          margin-right: 12px !important;
          flex-shrink: 0 !important;
          box-shadow: 0 0 5px rgba(0,0,0,0.3) !important;
          cursor: pointer !important;
          border: 2px solid transparent !important;
          transition: transform 0.2s !important;
        }
        .ov-tag-picker-item .tag-color-dot:hover {
          transform: scale(1.2) !important;
          border-color: #fff !important;
        }

        .ov-tag-picker-item .tag-name {
          flex: 1 !important;
          font-size: 14px !important;
          color: #ddd !important;
          white-space: nowrap !important;
          overflow: hidden !important;
          text-overflow: ellipsis !important;
        }

        .ov-tag-picker-item .tag-status-icon {
          font-size: 14px !important;
          margin-left: 8px !important;
          transition: all 0.2s !important;
        }
        .ov-tag-picker-item .tag-status-icon.checked {
          color: #3498db !important;
        }
        .ov-tag-picker-item .tag-status-icon.unchecked {
          color: #555 !important;
        }

        .ov-tag-picker-item.create-new {
          border: 1px dashed #555 !important;
          background: rgba(52, 152, 219, 0.1) !important;
          margin-top: 8px !important;
        }
        .ov-tag-picker-item.create-new:hover {
          background: rgba(52, 152, 219, 0.2) !important;
        }
        
        /* 颜色选择器 Popover */
        .ov-color-picker-popover {
          position: absolute;
          background: #2a2a2a;
          border: 1px solid #444;
          border-radius: 8px;
          padding: 10px;
          box-shadow: 0 5px 20px rgba(0,0,0,0.5);
          z-index: ${OV_LAYERS.NESTED_DIALOG};
          display: grid;
          grid-template-columns: repeat(5, 1fr);
          gap: 6px;
        }
        .ov-color-swatch {
          width: 20px;
          height: 20px;
          border-radius: 50%;
          cursor: pointer;
          border: 2px solid transparent;
        }
        .ov-color-swatch:hover, .ov-color-swatch.active {
          border-color: #fff;
          transform: scale(1.1);
        }
        
        /* === 分区样式 === */
        .ov-tag-section {
          margin-bottom: 16px !important;
          min-width: 0 !important;
        }
        .ov-tag-section:last-child {
          margin-bottom: 0 !important;
        }
        .ov-tag-section-title {
          font-size: 12px !important;
          color: #888 !important;
          margin-bottom: 8px !important;
          display: flex !important;
          align-items: center !important;
          gap: 6px !important;
          cursor: pointer !important;
          user-select: none !important;
        }
        .ov-tag-section-title:hover {
          color: #bbb !important;
        }
        .ov-tag-section-title .collapse-arrow {
          font-size: 10px !important;
          transition: transform 0.2s !important;
          margin-left: auto !important;
        }
        .ov-tag-section-title .collapse-arrow.collapsed {
          transform: rotate(-90deg) !important;
        }
        .ov-tag-section-title i:first-child {
          font-size: 11px !important;
          color: #666 !important;
        }
        .ov-tag-section-content {
          display: flex !important;
          flex-direction: column !important;
          min-width: 0 !important;
          gap: 4px !important;
        }
        .ov-tag-section-content.collapsed {
          display: none !important;
        }
        
        /* 标签芯片样式 */
        .ov-tag-chips {
          flex-direction: row !important;
          flex-wrap: wrap !important;
          min-width: 0 !important;
          gap: 6px !important;
        }
        .ov-tag-chip {
          display: inline-flex !important;
          align-items: center !important;
          max-width: 100% !important;
          box-sizing: border-box !important;
          gap: 6px !important;
          padding: 5px 10px !important;
          background: #2a2a2a !important;
          border: 1px solid #444 !important;
          border-radius: 16px !important;
          font-size: 12px !important;
          color: #ccc !important;
          cursor: pointer !important;
          transition: all 0.2s !important;
        }
        .ov-tag-chip:hover {
          background: #333 !important;
          border-color: #555 !important;
        }
        .ov-tag-chip.selected {
          background: rgba(52, 152, 219, 0.3) !important;
          border-color: rgba(52, 152, 219, 0.7) !important;
          color: #fff !important;
          box-shadow: 0 0 6px rgba(52, 152, 219, 0.3) !important;
        }
        .ov-tag-chip .tag-color-dot {
          width: 8px !important;
          height: 8px !important;
          border-radius: 50% !important;
          flex-shrink: 0 !important;
        }
        .ov-tag-chip .tag-name {
          white-space: nowrap !important;
          min-width: 0 !important;
          overflow: hidden !important;
          text-overflow: ellipsis !important;
        }
        .ov-tag-chip i {
          font-size: 10px !important;
        }
        .ov-tag-chip.suggestion {
          border-style: dashed !important;
          background: rgba(241, 196, 15, 0.1) !important;
          border-color: rgba(241, 196, 15, 0.3) !important;
        }
        .ov-tag-chip.suggestion:hover {
          background: rgba(241, 196, 15, 0.2) !important;
        }
        .ov-tag-chip.suggestion.selected {
          background: rgba(46, 204, 113, 0.3) !important;
          border-color: rgba(46, 204, 113, 0.7) !important;
          border-style: solid !important;
          color: #fff !important;
          box-shadow: 0 0 8px rgba(46, 204, 113, 0.3) !important;
        }
        
        /* 使用次数标签 */
        .tag-usage {
          font-size: 11px !important;
          color: #666 !important;
          margin-left: auto !important;
          margin-right: 8px !important;
        }
      `;
      const style = document.createElement('style');
      style.id = 'ov-tag-picker-styles';
      style.textContent = css;
      document.head.appendChild(style);
    }

    return new Promise((resolve) => {
      const container = $(this.element).find('.origin-vault-container');
      const allTagsGlobal = this.library.getAllTags() || {};
      // 当前选中状态（实时同步）
      const liveSelectedTags = new Set(currentTags.map(String));
      const PRESET_COLORS = [
        '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#1abc9c',
        '#3498db', '#9b59b6', '#34495e', '#ecf0f1', '#95a5a6'
      ];

      // 折叠状态（会话内记忆）
      if (!this._tagSectionCollapsed) this._tagSectionCollapsed = {};

      // 即时切换标签：对所有选中项操作
      const toggleTag = async (tagId) => {
        tagId = String(tagId);
        if (liveSelectedTags.has(tagId)) {
          liveSelectedTags.delete(tagId);
          for (const id of targetIds) {
            await this.library.removeTagFromItem(id, tagId);
          }
        } else {
          liveSelectedTags.add(tagId);
          for (const id of targetIds) {
            await this.library.addTagToItem(id, tagId);
          }
        }
      };

      const addTagToTargets = async (tagId) => {
        tagId = String(tagId);
        if (liveSelectedTags.has(tagId)) return false;

        liveSelectedTags.add(tagId);
        for (const id of targetIds) {
          await this.library.addTagToItem(id, tagId);
        }
        return true;
      };

      const findExactTag = (name) => {
        const lowerName = String(name || '').trim().toLowerCase();
        if (!lowerName) return null;
        return Object.values(allTagsGlobal).find(tag => tag.name.toLowerCase() === lowerName) || null;
      };

      const addTagFromSearch = async (name, color = '#3498db') => {
        const tagName = String(name || '').trim();
        if (!tagName) return null;

        const existingTag = findExactTag(tagName);
        if (existingTag) {
          await addTagToTargets(existingTag.id);
          return String(existingTag.id);
        }

        const newId = this.library.createTag(tagName, color);
        allTagsGlobal[newId] = this.library.getTag(newId) || { id: newId, name: tagName, color };
        await addTagToTargets(newId);
        ui.notifications.info(tf('origin-vault.tags.createSuccess', { name: tagName }));
        return String(newId);
      };

      // 构建标签列表 HTML (三栏布局)
      const buildTagList = (searchTerm = '') => {
        const lowerSearch = searchTerm.toLowerCase();
        let html = '';

        const currentItem = this.library.getItem(itemId);
        const collapsed = this._tagSectionCollapsed;

        // 过滤匹配的标签
        const matchingTags = Object.values(allTagsGlobal).filter(tag =>
          !searchTerm || tag.name.toLowerCase().includes(lowerSearch)
        );

        const hasExactMatch = Object.values(allTagsGlobal).some(
          t => t.name.toLowerCase() === lowerSearch
        );

        // === 搜索模式：只显示匹配结果 ===
        if (searchTerm) {
          matchingTags.forEach(tag => {
            const isSelected = liveSelectedTags.has(String(tag.id));
            html += `
              <div class="ov-tag-picker-item ${isSelected ? 'selected' : ''}" data-tag-id="${tag.id}">
                <span class="tag-color-dot" style="background: ${tag.color || '#808080'}" data-color-action="edit"></span>
                <span class="tag-name">${tag.name}</span>
                <i class="fas ${isSelected ? 'fa-check tag-status-icon checked' : 'fa-circle tag-status-icon unchecked'}"></i>
              </div>
            `;
          });

          // 新建选项
          if (!hasExactMatch) {
            html += `
              <div class="ov-tag-picker-item create-new" data-name="${searchTerm}">
                <span class="tag-color-dot" style="background: ${PRESET_COLORS[Math.floor(Math.random() * PRESET_COLORS.length)]}" data-color-action="new"></span>
                <span class="tag-name"><i class="fas fa-plus" style="margin-right: 6px; font-size: 12px;"></i>${t('origin-vault.tags.addNew')} "${searchTerm}"</span>
              </div>
            `;
          }

          if (matchingTags.length === 0 && hasExactMatch) {
            html = `<div class="ov-tag-picker-empty">${t('origin-vault.tags.noTags')}</div>`;
          }

          return html;
        }

        // === 非搜索模式：三栏可折叠布局 ===

        // 辅助：生成分区
        const buildSection = (key, icon, title, rawTags, chipClass = '') => {
          // 去重：按 tag.id 去重，防止同一标签重复显示
          const seen = new Set();
          const tags = rawTags.filter(t => {
            const tid = String(t.id);
            if (seen.has(tid)) return false;
            seen.add(tid);
            return true;
          });
          if (tags.length === 0) return '';
          const isCollapsed = !!collapsed[key];
          let s = `
            <div class="ov-tag-section">
              <div class="ov-tag-section-title" data-section="${key}">
                <i class="fas ${icon}"></i> ${title} (${tags.length})
                <i class="fas fa-chevron-down collapse-arrow ${isCollapsed ? 'collapsed' : ''}"></i>
              </div>
              <div class="ov-tag-section-content ov-tag-chips ${isCollapsed ? 'collapsed' : ''}">
          `;
          tags.forEach(tag => {
            const isSelected = liveSelectedTags.has(String(tag.id));
            const isPotential = tag.isPotential;
            s += `
              <div class="ov-tag-chip ${chipClass} ${isSelected ? 'selected' : ''} ${isPotential ? 'potential' : ''}" 
                   data-tag-id="${tag.id}" 
                   ${isPotential ? `data-is-potential="true" data-tag-name="${tag.name}"` : ''}>
                ${isPotential ? '<i class="fas fa-plus-circle" style="font-size: 10px; opacity: 0.7;"></i>' : `<span class="tag-color-dot" style="background: ${tag.color || '#808080'}"></span>`}
                <span class="tag-name">${tag.name}</span>
                ${isSelected ? '<i class="fas fa-check" style="font-size: 10px;"></i>' : '<i class="far fa-circle" style="font-size: 10px; color: #555;"></i>'}
              </div>
            `;
          });
          s += `</div></div>`;
          return s;
        };

        // 1. 最近使用
        const recentTags = this.library.getRecentTags(6);
        html += buildSection('recent', 'fa-clock', t('origin-vault.tags.recent'), recentTags);

        // 2. 当前文件夹标签
        const folderTags = this.library.getTagsUsedInFolder(this.currentFolderId);
        html += buildSection('folder', 'fa-folder', t('origin-vault.tags.folderTags'), folderTags);

        // 3. 智能推荐
        let uniqueSuggestions = [];
        if (currentItem) {
          const suggestions = this.library.getSmartTagSuggestions(currentItem, 15);
          const existingIdsInUI = new Set([
            ...recentTags.map(t => t.id),
            ...folderTags.map(t => t.id)
          ]);
          uniqueSuggestions = suggestions.filter(s => !existingIdsInUI.has(s.id)).slice(0, 10);
        }
        html += buildSection('suggestions', 'fa-lightbulb', t('origin-vault.tags.suggestions'), uniqueSuggestions, 'suggestion');

        if (!html) {
          html = `<div class="ov-tag-picker-empty">${t('origin-vault.tags.noTags')}</div>`;
        }

        return html;
      };

      const overlay = $(`
        <div class="ov-dialog-overlay ov-tag-picker-overlay">
          <div class="ov-dialog ov-tag-picker">
            <div class="ov-dialog-header">
              <h3 class="ov-dialog-title">${t('origin-vault.tags.addTag')}</h3>
              <button class="ov-dialog-close"><i class="fas fa-times"></i></button>
            </div>
            <div class="ov-dialog-content">
              <input type="text" class="ov-tag-search" placeholder="${t('origin-vault.tags.search')}">
              <div class="ov-tag-picker-list">
                ${buildTagList()}
              </div>
            </div>
          </div>
        </div>
      `);

      const searchInput = overlay.find('.ov-tag-search');
      const tagList = overlay.find('.ov-tag-picker-list');

      const close = () => {
        $(document).off('keydown.ov-tag-picker');
        $('.ov-color-picker-popover').remove();
        overlay.remove();
        resolve(); // 无需返回值，已即时生效
      };

      // 搜索过滤
      searchInput.on('input', () => {
        tagList.html(buildTagList(searchInput.val().trim()));
      });

      searchInput.on('keydown', async (e) => {
        if (e.key !== 'Enter' || e.originalEvent?.isComposing) return;

        e.preventDefault();
        e.stopPropagation();

        const searchTerm = searchInput.val().trim();
        if (!searchTerm) return;

        const colorDot = tagList.find('.ov-tag-picker-item.create-new .tag-color-dot').first();
        const color = colorDot.length ? colorDot.css('background-color') : '#3498db';
        const tagId = await addTagFromSearch(searchTerm, color);
        if (!tagId) return;

        searchInput.val('');
        tagList.html(buildTagList(''));
      });

      // 1. 点击列表项：即时切换
      tagList.on('click', '.ov-tag-picker-item', async (e) => {
        if ($(e.target).hasClass('tag-color-dot')) return;

        const item = $(e.currentTarget);
        const tagId = String(item.data('tagId') || '');

        // 创建新标签
        if (item.hasClass('create-new')) {
          const tagNameSpan = item.find('.tag-name').text();
          const match = tagNameSpan.match(/"([^"]+)"/);
          const newTagName = match ? match[1] : item.attr('data-name');

          if (!newTagName || typeof newTagName !== 'string') return;

          const colorDot = item.find('.tag-color-dot');
          const color = colorDot.css('background-color') || '#3498db';

          await addTagFromSearch(newTagName, color);

          // 清空搜索，回到初始视图（新标签会出现在最近使用中）
          searchInput.val('');
          tagList.html(buildTagList(''));
          return;
        }

        // 普通标签项：即时切换（不重建列表，保持顺序）
        if (tagId) {
          await toggleTag(tagId);
          const isNowSelected = liveSelectedTags.has(tagId);
          item.toggleClass('selected', isNowSelected);
          const icon = item.find('.tag-status-icon');
          icon.removeClass('fa-check fa-circle checked unchecked')
            .addClass(isNowSelected ? 'fa-check checked' : 'fa-circle unchecked');
        }
      });

      // 1.5 点击标签芯片 (最近使用/文件夹/推荐)
      tagList.on('click', '.ov-tag-chip', async (e) => {
        if ($(e.target).hasClass('tag-color-dot')) return;

        let tagId = String($(e.currentTarget).data('tagId') || '');
        const isPotential = $(e.currentTarget).data('isPotential');
        const tagName = String($(e.currentTarget).data('tagName') || '');

        // 潜在标签（未创建的词段），点击时先创建
        if (isPotential && tagName) {
          const color = '#3498db';
          const newId = this.library.createTag(tagName, color);
          tagId = String(newId);
          ui.notifications.info(tf('origin-vault.tags.createSuccess', { name: tagName }));
        }

        if (tagId) {
          await toggleTag(tagId);
          // 就地切换视觉状态，不重建列表
          const chip = $(e.currentTarget);
          const isNowSelected = liveSelectedTags.has(tagId);
          chip.toggleClass('selected', isNowSelected);
          const icon = chip.find('i:last');
          icon.removeClass('fas far fa-check fa-circle').addClass(isNowSelected ? 'fas fa-check' : 'far fa-circle');
          if (!isNowSelected) icon.css('color', '#555'); else icon.css('color', '');
        }
      });

      // 2. 点击分区标题折叠/展开
      tagList.on('click', '.ov-tag-section-title', (e) => {
        const section = $(e.currentTarget).data('section');
        if (!section) return;
        this._tagSectionCollapsed[section] = !this._tagSectionCollapsed[section];
        tagList.html(buildTagList(searchInput.val().trim()));
      });

      // 3. 颜色选择器逻辑
      const showColorPicker = (targetDot, onSelect) => {
        $('.ov-color-picker-popover').remove();

        const picker = $(`<div class="ov-color-picker-popover"></div>`);
        PRESET_COLORS.forEach(c => {
          const swatch = $(`<div class="ov-color-swatch" style="background: ${c}"></div>`);
          swatch.on('click', async (e) => {
            e.stopPropagation();
            await onSelect(c);
            picker.remove();
          });
          picker.append(swatch);
        });

        const { rect: hostRect } = getOverlayHostRect({ owner: this });
        appendJQueryToOverlayHost(picker, { owner: this });

        const rect = targetDot[0].getBoundingClientRect();
        const pickerWidth = picker.outerWidth() || 0;
        const pickerHeight = picker.outerHeight() || 0;
        const desiredLeft = rect.left - hostRect.left;
        const desiredTop = rect.bottom - hostRect.top + 5;
        const clampedLeft = Math.max(8, Math.min(desiredLeft, hostRect.width - pickerWidth - 8));
        const clampedTop = Math.max(8, Math.min(desiredTop, hostRect.height - pickerHeight - 8));
        picker.css({
          position: 'absolute',
          top: `${clampedTop}px`,
          left: `${clampedLeft}px`
        });

        const closePicker = (e) => {
          if (!picker.is(e.target) && picker.has(e.target).length === 0 && !targetDot.is(e.target)) {
            picker.remove();
            $(document).off('click', closePicker);
          }
        };
        setTimeout(() => $(document).on('click', closePicker), 10);
      };

      // 4. 点击颜色圆点
      tagList.on('click', '.tag-color-dot', (e) => {
        e.stopPropagation();
        const dot = $(e.currentTarget);
        const item = dot.closest('.ov-tag-picker-item, .ov-tag-chip');

        if (item.hasClass('create-new')) {
          showColorPicker(dot, async (color) => {
            dot.css('background', color);
          });
        } else {
          const tagId = String(item.data('tagId') || '');
          showColorPicker(dot, async (color) => {
            if (tagId) {
              await this.library.updateTag(tagId, { color });
              dot.css('background', color);
            }
          });
        }
      });

      // 5. 关闭按钮 / 点击外部 / ESC
      overlay.find('.ov-dialog-close').on('click', () => close());

      overlay.on('mousedown', (e) => {
        const dialog = overlay.find('.ov-tag-picker')[0];
        if (dialog && !dialog.contains(e.target)) {
          close();
        }
      });

      $(document).on('keydown.ov-tag-picker', (e) => {
        if (e.key === 'Escape') close();
      });

      // 挂载到 body 并动态定位
      const { rect: hostRect } = getOverlayHostRect({ owner: this });
      appendJQueryToOverlayHost(overlay, { owner: this });

      const btnEl = container.find('.btn-add-tag')[0];
      const dialog = overlay.find('.ov-tag-picker');
      if (btnEl) {
        const rect = btnEl.getBoundingClientRect();
        const dialogWidth = 320;
        const margin = 8;
        let left = rect.left - hostRect.left - dialogWidth - margin;
        if (left < margin) left = rect.right - hostRect.left + margin;
        if (left + dialogWidth > hostRect.width - margin) {
          left = Math.max(margin, hostRect.width - dialogWidth - margin);
        }
        let top = rect.top - hostRect.top;
        const maxHeight = hostRect.height - top - margin;
        if (maxHeight < 200) top = Math.max(margin, hostRect.height - 500);
        dialog.css({
          top: `${top}px`,
          left: `${left}px`,
          maxHeight: `${Math.max(220, hostRect.height - top - margin)}px`
        });
      } else {
        dialog.css({
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          maxHeight: `${Math.max(220, hostRect.height - 16)}px`
        });
      }

      searchInput.focus();
    });
  }

  /**
   * 显示标签管理对话框
   * 支持查看所有标签、使用统计、重命名、删除和创建新标签
   */
  cls.prototype._showTagManagerDialog = function () {
    // 动态注入样式
    if (!document.getElementById('ov-tag-manager-styles')) {
      const css = `
        /* ==================== 标签管理器样式 (JS动态注入) ==================== */
        .ov-dialog.ov-tag-manager {
          width: 450px !important;
          max-height: 600px !important;
          background: #1e1e1e !important;
          border: 1px solid #333 !important;
          border-radius: 12px !important;
          box-shadow: 0 15px 40px rgba(0,0,0,0.6) !important;
          overflow: hidden !important;
          display: flex !important;
          flex-direction: column !important;
        }

        .ov-tag-manager .ov-dialog-header {
          background: #252525 !important;
          padding: 16px 20px !important;
          border-bottom: 1px solid #333 !important;
          display: flex !important;
          align-items: center !important;
          justify-content: space-between !important;
          flex-shrink: 0 !important;
        }

        .ov-tag-manager .ov-dialog-title {
          font-size: 16px !important;
          font-weight: 600 !important;
          margin: 0 !important;
          color: #eee !important;
        }

        .ov-tag-manager .ov-dialog-close {
          background: none !important;
          border: none !important;
          color: #888 !important;
          cursor: pointer !important;
          width: 28px !important;
          height: 28px !important;
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
          border-radius: 4px !important;
        }
        .ov-tag-manager .ov-dialog-close:hover {
          background: rgba(255,255,255,0.1) !important;
          color: #fff !important;
        }

        .ov-tag-manager .ov-dialog-content {
          padding: 16px !important;
          background: #1e1e1e !important;
          flex: 1 !important;
          overflow: hidden !important;
          display: flex !important;
          flex-direction: column !important;
        }

        .ov-tag-manager-list {
          flex: 1 !important;
          overflow-y: auto !important;
          display: flex !important;
          flex-direction: column !important;
          gap: 4px !important;
        }

        .ov-tag-manager-item {
          display: flex !important;
          align-items: center !important;
          padding: 10px 12px !important;
          border-radius: 6px !important;
          background: #252525 !important;
          transition: all 0.2s !important;
        }

        .ov-tag-manager-item:hover {
          background: #333 !important;
        }

        .ov-tag-manager-item .tag-color-dot {
          width: 14px !important;
          height: 14px !important;
          border-radius: 50% !important;
          margin-right: 12px !important;
          flex-shrink: 0 !important;
          cursor: pointer !important;
          border: 2px solid transparent !important;
        }
        .ov-tag-manager-item .tag-color-dot:hover {
          transform: scale(1.2) !important;
          border-color: #fff !important;
        }

        .ov-tag-manager-item .tag-info {
          flex: 1 !important;
          min-width: 0 !important;
        }

        .ov-tag-manager-item .tag-name {
          font-size: 14px !important;
          color: #ddd !important;
          white-space: nowrap !important;
          overflow: hidden !important;
          text-overflow: ellipsis !important;
        }

        .ov-tag-manager-item .tag-usage {
          font-size: 11px !important;
          color: #888 !important;
          margin-top: 2px !important;
        }

        .ov-tag-manager-item .tag-actions {
          display: flex !important;
          gap: 6px !important;
          margin-left: 10px !important;
          opacity: 0 !important;
          transition: opacity 0.2s !important;
        }

        .ov-tag-manager-item:hover .tag-actions {
          opacity: 1 !important;
        }

        .ov-tag-manager-item .tag-action-btn {
          background: none !important;
          border: none !important;
          color: #888 !important;
          cursor: pointer !important;
          padding: 4px !important;
          border-radius: 3px !important;
        }
        .ov-tag-manager-item .tag-action-btn:hover {
          background: rgba(255,255,255,0.1) !important;
          color: #fff !important;
        }
        .ov-tag-manager-item .tag-action-btn.delete:hover {
          color: #e74c3c !important;
        }

        .ov-tag-manager-footer {
          padding: 12px 20px !important;
          background: #252525 !important;
          border-top: 1px solid #333 !important;
          display: flex !important;
          justify-content: center !important;
          flex-shrink: 0 !important;
        }

        .ov-btn-create-tag {
          padding: 8px 20px !important;
          border-radius: 6px !important;
          border: 1px dashed #555 !important;
          background: rgba(52, 152, 219, 0.1) !important;
          color: #aaa !important;
          font-size: 13px !important;
          cursor: pointer !important;
          display: flex !important;
          align-items: center !important;
          gap: 8px !important;
        }
        .ov-btn-create-tag:hover {
          background: rgba(52, 152, 219, 0.2) !important;
          border-color: #3498db !important;
          color: #fff !important;
        }

        .ov-tag-manager-empty {
          padding: 40px 20px !important;
          text-align: center !important;
          color: #666 !important;
        }
      `;
      const style = document.createElement('style');
      style.id = 'ov-tag-manager-styles';
      style.textContent = css;
      document.head.appendChild(style);
    }

    const container = $(this.element).find('.origin-vault-container');
    // 使用 currentFolderId 获取可见标签范围
    const visibleTags = this.library.getTagsForFolder(this.currentFolderId);
    const allTags = Object.fromEntries(visibleTags.map(t => [t.id, t]));
    const PRESET_COLORS = [
      '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#1abc9c',
      '#3498db', '#9b59b6', '#34495e', '#ecf0f1', '#95a5a6'
    ];

    // 计算每个标签的使用统计
    const getTagUsageCount = (tagId) => {
      let count = 0;
      for (const item of this.library.itemsCache.values()) {
        if (item.tags && item.tags.includes(tagId)) count++;
      }
      return count;
    };

    // 构建标签列表 HTML
    const buildTagList = () => {
      const tagEntries = Object.entries(allTags);
      if (tagEntries.length === 0) {
        return `<div class="ov-tag-manager-empty">${t('origin-vault.tags.noTags')}</div>`;
      }

      return tagEntries.map(([id, tag]) => {
        const usageCount = getTagUsageCount(id);
        return `
          <div class="ov-tag-manager-item" data-tag-id="${id}">
            <span class="tag-color-dot" style="background: ${tag.color || '#808080'}"></span>
            <div class="tag-info">
              <div class="tag-name">${tag.name}</div>
              <div class="tag-usage">${tf('origin-vault.tags.usageCount', { count: usageCount })}</div>
            </div>
            <div class="tag-actions">
              <button class="tag-action-btn rename" title="${t('origin-vault.tags.rename')}">
                <i class="fas fa-pen"></i>
              </button>
              <button class="tag-action-btn delete" title="${t('origin-vault.tags.delete')}">
                <i class="fas fa-trash"></i>
              </button>
            </div>
          </div>
        `;
      }).join('');
    };

    const overlay = $(`
      <div class="ov-dialog-overlay">
        <div class="ov-dialog ov-tag-manager">
          <div class="ov-dialog-header">
            <h3 class="ov-dialog-title">${t('origin-vault.tags.manage')}</h3>
            <button class="ov-dialog-close"><i class="fas fa-times"></i></button>
          </div>
          <div class="ov-dialog-content">
            <div class="ov-tag-manager-list">
              ${buildTagList()}
          </div>
        </div>
      </div>
    `);

    overlay.css({
      position: 'fixed',
      zIndex: reserveOverlayZIndex()
    });

    const tagList = overlay.find('.ov-tag-manager-list');

    const close = () => {
      overlay.remove();
    };

    const refreshList = () => {
      tagList.html(buildTagList());
    };

    // 颜色选择器
    const showColorPicker = (targetDot, onSelect) => {
      $('.ov-color-picker-popover').remove();
      const picker = $(`<div class="ov-color-picker-popover"></div>`);
      PRESET_COLORS.forEach(c => {
        const swatch = $(`<div class="ov-color-swatch" style="background: ${c}"></div>`);
        swatch.on('click', async (e) => {
          e.stopPropagation();
          await onSelect(c);
          picker.remove();
        });
        picker.append(swatch);
      });
      const { rect: hostRect } = getOverlayHostRect({ owner: this });
      appendJQueryToOverlayHost(picker, { owner: this });
      const rect = targetDot[0].getBoundingClientRect();
      const pickerWidth = picker.outerWidth() || 0;
      const pickerHeight = picker.outerHeight() || 0;
      const desiredLeft = rect.left - hostRect.left;
      const desiredTop = rect.bottom - hostRect.top + 5;
      const clampedLeft = Math.max(8, Math.min(desiredLeft, hostRect.width - pickerWidth - 8));
      const clampedTop = Math.max(8, Math.min(desiredTop, hostRect.height - pickerHeight - 8));
      picker.css({ position: 'absolute', top: `${clampedTop}px`, left: `${clampedLeft}px` });
      setTimeout(() => $(document).on('click.ov-color-picker', () => {
        picker.remove();
        $(document).off('click.ov-color-picker');
      }), 10);
    };

    // 颜色点击
    tagList.on('click', '.tag-color-dot', (e) => {
      e.stopPropagation();
      const dot = $(e.currentTarget);
      const item = dot.closest('.ov-tag-manager-item');
      const tagId = item.data('tagId');
      showColorPicker(dot, async (color) => {
        await this.library.updateTag(tagId, { color });
        dot.css('background', color);
      });
    });

    // 重命名
    tagList.on('click', '.tag-action-btn.rename', async (e) => {
      e.stopPropagation();
      const item = $(e.currentTarget).closest('.ov-tag-manager-item');
      const tagId = item.data('tagId');
      const tag = allTags[tagId];
      if (!tag) return;

      const newName = await this._showInputDialog(
        t('origin-vault.tags.renameTitle'),
        t('origin-vault.tags.newName'),
        tag.name
      );
      if (newName && newName !== tag.name) {
        this.library.updateTag(tagId, { name: newName });
        item.find('.tag-name').text(newName);
        allTags[tagId].name = newName; // Update local reference
      }
    });

    // 删除
    tagList.on('click', '.tag-action-btn.delete', async (e) => {
      e.stopPropagation();
      const item = $(e.currentTarget).closest('.ov-tag-manager-item');
      const tagId = item.data('tagId');
      const tag = allTags[tagId];
      if (!tag) return;

      const confirmed = await this._showConfirmDialog(
        t('origin-vault.tags.delete'),
        `${tf('origin-vault.tags.deleteConfirm', { name: tag.name })}<br><small>${t('origin-vault.tags.deleteWarning')}</small>`,
        true
      );
      if (confirmed) {
        await this.library.deleteTag(tagId);
        delete allTags[tagId];
        item.remove();
        if (Object.keys(allTags).length === 0) {
          refreshList();
        }
      }
    });

    // Eagle 风格：标签管理器不再支持创建标签，只做管理
    // 标签只能在给素材添加标签时创建

    overlay.find('.ov-dialog-close').on('click', close);
    overlay.on('click', (e) => {
      if (e.target === overlay[0]) close();
    });

    appendJQueryToOverlayHost(overlay, { owner: this });
  }

  /**
   * 显示帮助面板
   */
  cls.prototype._showHelpPanel = function () {
    // 如果已打开则关闭
    const existing = $(this.element).find('.ov-help-overlay');
    if (existing.length) { existing.remove(); return; }

    const L = (key) => t(`origin-vault.help.${key}`);
    const LF = (key) => t(`origin-vault.help.features.${key}`);
    const LO = (key) => t(`origin-vault.help.operations.${key}`);

    // 快捷键行构建器
    const kbd = (keys) => keys.map(k => `<span class="ov-help-kbd">${k}</span>`).join('');
    const row = (label, keys) => `
      <div class="ov-help-row">
        <span class="ov-help-row-label">${label}</span>
        <span class="ov-help-row-keys">${kbd(keys)}</span>
      </div>`;

    // 功能列表 — 每项含关联操作
    const features = [
      {
        icon: 'fa-database', titleKey: 'libraryTitle', descKey: 'libraryDesc',
        ops: [
          { label: LO('ctx_fileDetails'), keys: [ovText('Right Click', 'Правая кнопка')] },
          { label: LO('ctx_fileCopyPath'), keys: [ovText('Right Click', 'Правая кнопка')] },
          { label: LO('ctx_fileMoveOut'), keys: [ovText('Right Click', 'Правая кнопка')] },
          { label: LO('ctx_fileRemove'), keys: [ovText('Right Click', 'Правая кнопка')] },
        ]
      },
      {
        icon: 'fa-globe', titleKey: 'globalTitle', descKey: 'globalDesc',
        ops: []
      },
      {
        icon: 'fa-folder', titleKey: 'folderTitle', descKey: 'folderDesc',
        ops: [
          { label: LO('ctx_folderNew'), keys: [ovText('Right Click', 'Правая кнопка')] },
          { label: LO('ctx_folderRename'), keys: [ovText('Right Click', 'Правая кнопка')] },
          { label: LO('ctx_folderCollapse'), keys: [ovText('Right Click', 'Правая кнопка')] },
          { label: LO('ctx_folderColor'), keys: [ovText('Right Click', 'Правая кнопка')] },
          { label: LO('ctx_folderRemove'), keys: [ovText('Right Click', 'Правая кнопка')] },
          { label: LO('ctx_folderDelete'), keys: [ovText('Right Click', 'Правая кнопка')] },
          { label: LO('folder_inlineRename'), keys: [ovText('Double Click', 'Двойной щелчок')] },
          { label: LO('drag_sortFolders'), keys: [ovText('Drag', 'Перетаскивание')] },
          { label: LO('kb_rename'), keys: ['F2'] },
        ]
      },
      {
        icon: 'fa-tags', titleKey: 'tagTitle', descKey: 'tagDesc',
        ops: []
      },
      {
        icon: 'fa-filter', titleKey: 'filterTitle', descKey: 'filterDesc',
        ops: [
          { label: LO('kb_selectAll'), keys: ['Ctrl', 'A'] },
        ]
      },
      {
        icon: 'fa-folder-open', titleKey: 'browserTitle', descKey: 'browserDesc',
        advanced: true,
        ops: [
          { label: LO('drag_fromBrowser'), keys: [ovText('Drag', 'Перетаскивание')] },
        ]
      },
      {
        icon: 'fa-map', titleKey: 'sceneTitle', descKey: 'sceneDesc',
        ops: []
      },
      {
        icon: 'fa-box-open', titleKey: 'itemTitle', descKey: 'itemDesc',
        advanced: true,
        ops: []
      },
      {
        icon: 'fa-eye', titleKey: 'previewTitle', descKey: 'previewDesc',
        ops: [
          { label: LO('kb_quickLook'), keys: [ovText('Space', 'Пробел')] },
          { label: LO('mouse_details'), keys: [ovText('Double Click', 'Двойной щелчок')] },
          { label: LO('mouse_hoverPreview'), keys: [ovText('Hover', 'Наведение')] },
          { label: LO('mouse_videoScrub'), keys: [ovText('Hover', 'Наведение'), '↔'] },
          { label: LO('kb_navigate'), keys: ['←', '→'] },
        ]
      },
      {
        icon: 'fa-upload', titleKey: 'uploadTitle', descKey: 'uploadDesc',
        advanced: true,
        ops: []
      },
      {
        icon: 'fa-file-export', titleKey: 'exportTitle', descKey: 'exportDesc',
        ops: []
      },
      {
        icon: 'fa-vector-square', titleKey: 'canvasTitle', descKey: 'canvasDesc',
        advanced: true,
        ops: [
          { label: LO('drag_toCanvas'), keys: [ovText('Drag', 'Перетаскивание')] },
          { label: LO('drag_toFolder'), keys: [ovText('Drag', 'Перетаскивание')] },
          { label: LO('drag_copyToFolder'), keys: ['Alt', ovText('Drag', 'Перетаскивание')] },
        ]
      },
      {
        icon: 'fa-mouse-pointer', titleKey: 'pickerTitle', descKey: 'pickerDesc',
        advanced: true,
        ops: []
      },
    ].filter(feature => feature.enabled !== false);

    // 构建功能介绍 (accordion) Tab
    const featuresHtml = features.map((f, i) => {
      const opsRows = f.ops.length > 0
        ? `<div class="ov-help-acc-ops">${f.ops.map(o => row(o.label, o.keys)).join('')}</div>`
        : '';
      const hasOps = f.ops.length > 0 ? 'has-ops' : '';
      return `
        <div class="ov-help-acc ${hasOps}" data-index="${i}">
          <div class="ov-help-acc-header">
            <div class="ov-help-feature-icon"><i class="fas ${f.icon}"></i></div>
            <span class="ov-help-acc-title">${LF(f.titleKey)}</span>
            ${f.advanced && IS_MAD_EDITION ? `<span style="margin-left:6px;padding:1px 6px;font-size:10px;background:linear-gradient(135deg,#f39c12,#e67e22);color:#fff;border-radius:4px;font-weight:600;">⭐ ${t('origin-vault.help.advancedBadge')}</span>` : ''}
            ${f.ops.length > 0 ? '<i class="fas fa-chevron-right ov-help-acc-arrow"></i>' : ''}
          </div>
          <div class="ov-help-acc-body">
            <p class="ov-help-acc-desc">${LF(f.descKey)}</p>
            ${opsRows}
          </div>
        </div>`;
    }).join('');

    // 操作教学 Tab (完整速查)
    const opsHtml = `
      <h5 class="ov-help-section-title">${LO('quickStartTitle')}</h5>
      <div class="ov-help-qs">
        <div class="ov-help-qs-item"><i class="fas fa-upload"></i><span>${LO('qs_upload')}</span></div>
        <div class="ov-help-qs-item"><i class="fas fa-folder-open"></i><span>${LO('qs_browser')}</span></div>
        <div class="ov-help-qs-item"><i class="fas fa-exchange-alt"></i><span>${LO('qs_picker')}</span></div>
      </div>

      <h5 class="ov-help-section-title">⌨️ ${LO('keyboardTitle')}</h5>
      ${row(LO('kb_openVault'), ['Alt', 'V'])}
      ${row(LO('kb_quickLook'), [ovText('Space', 'Пробел')])}
      ${row(LO('kb_delete'), ['Delete'])}
      ${row(LO('kb_selectAll'), ['Ctrl', 'A'])}
      ${row(LO('kb_rename'), ['F2'])}
      ${row(LO('kb_escape'), ['Esc'])}
      ${row(LO('kb_navigate'), ['←', '→', '↑', '↓'])}
      ${row(LO('kb_gridSize'), ['Shift', '🖱️Scroll'])}

      <h5 class="ov-help-section-title">🖱️ ${LO('mouseTitle')}</h5>
      ${row(LO('mouse_select'), [ovText('Click', 'Щелчок')])}
      ${row(LO('mouse_multiSelect'), ['Ctrl', ovText('Click', 'Щелчок')])}
      ${row(LO('mouse_rangeSelect'), ['Shift', ovText('Click', 'Щелчок')])}
      ${row(LO('mouse_marquee'), [ovText('Drag', 'Перетаскивание')])}
      ${row(LO('mouse_details'), [ovText('Double Click', 'Двойной щелчок')])}
      ${row(LO('mouse_hoverPreview'), [ovText('Hover', 'Наведение')])}
      ${row(LO('mouse_videoScrub'), [ovText('Hover', 'Наведение'), '↔'])}

      <h5 class="ov-help-section-title">📂 ${LO('folderOpsTitle')}</h5>
      ${row(LO('folder_contextMenu'), [ovText('Right Click', 'Правая кнопка')])}
      ${row(LO('folder_inlineRename'), [ovText('Double Click', 'Двойной щелчок')])}
      ${row(LO('folder_colorTag'), [ovText('Right Click', 'Правая кнопка')])}

      <h5 class="ov-help-section-title">📦 ${LO('dragTitle')}</h5>
      ${row(LO('drag_toFolder'), [ovText('Drag', 'Перетаскивание')])}
      ${row(LO('drag_copyToFolder'), ['Alt', ovText('Drag', 'Перетаскивание')])}
      ${row(LO('drag_toCanvas'), [ovText('Drag', 'Перетаскивание')])}
      ${row(LO('drag_sortFolders'), [ovText('Drag', 'Перетаскивание')])}
      ${row(LO('drag_fromBrowser'), [ovText('Drag', 'Перетаскивание')])}

      <h5 class="ov-help-section-title">📋 ${LO('contextMenuTitle')}</h5>
      ${row(LO('ctx_fileDetails'), [ovText('Right Click', 'Правая кнопка')])}
      ${row(LO('ctx_fileCopyPath'), [ovText('Right Click', 'Правая кнопка')])}
      ${row(LO('ctx_fileMoveOut'), [ovText('Right Click', 'Правая кнопка')])}
      ${row(LO('ctx_fileRemove'), [ovText('Right Click', 'Правая кнопка')])}
      ${row(LO('ctx_folderNew'), [ovText('Right Click', 'Правая кнопка')])}
      ${row(LO('ctx_folderRename'), [ovText('Right Click', 'Правая кнопка')])}
      ${row(LO('ctx_folderCollapse'), [ovText('Right Click', 'Правая кнопка')])}
      ${row(LO('ctx_folderColor'), [ovText('Right Click', 'Правая кнопка')])}
      ${row(LO('ctx_folderRemove'), [ovText('Right Click', 'Правая кнопка')])}
      ${row(LO('ctx_folderDelete'), [ovText('Right Click', 'Правая кнопка')])}
    `;

    // --- Build Panel ---
    const overlay = $(`
      <div class="ov-help-overlay">
        <div class="ov-help-panel">
          <div class="ov-help-header">
            <h3>${L('title')}</h3>
            <button class="ov-help-close"><i class="fas fa-times"></i></button>
          </div>
          <div class="ov-help-tabs">
            <button class="ov-help-tab active" data-tab="features">${L('tabFeatures')}</button>
            <button class="ov-help-tab" data-tab="operations">${L('tabOperations')}</button>
          </div>
          <div class="ov-help-content">
            <div class="ov-help-tab-content active" data-tab="features">
              ${featuresHtml}
            </div>
            <div class="ov-help-tab-content" data-tab="operations">
              ${opsHtml}
            </div>
          </div>
        </div>
      </div>
    `);

    // Tab switching
    overlay.find('.ov-help-tab').on('click', function () {
      const tab = $(this).data('tab');
      overlay.find('.ov-help-tab').removeClass('active');
      $(this).addClass('active');
      overlay.find('.ov-help-tab-content').removeClass('active');
      overlay.find(`.ov-help-tab-content[data-tab="${tab}"]`).addClass('active');
    });

    // Accordion toggle
    overlay.find('.ov-help-acc-header').on('click', function () {
      const acc = $(this).closest('.ov-help-acc');
      const wasOpen = acc.hasClass('open');
      overlay.find('.ov-help-acc.open').removeClass('open');
      if (!wasOpen) acc.addClass('open');
    });

    // Close
    const close = () => overlay.remove();
    overlay.find('.ov-help-close').on('click', close);
    overlay.on('click', (e) => {
      if (e.target === overlay[0]) close();
    });

    appendJQueryToOverlayHost(overlay, { owner: this });
  }


  /**
   * 显示自定义确认弹窗
   */
  cls.prototype._showConfirmDialog = function (title, content, isDanger = false) {
    return new Promise((resolve) => {
      const overlay = $(`
  <div class="ov-dialog-overlay">
    <div class="ov-dialog">
      <div class="ov-dialog-header">
        <h3 class="ov-dialog-title">${title}</h3>
        <button class="ov-dialog-close"><i class="fas fa-times"></i></button>
      </div>
      <div class="ov-dialog-content">
        <p style="margin: 0; line-height: 1.5;">${content}</p>
      </div>
      <div class="ov-dialog-footer">
        <button class="ov-dialog-btn cancel">${t('origin-vault.dialog.cancel')}</button>
        <button class="ov-dialog-btn ${isDanger ? 'danger' : 'primary'} confirm">${t('origin-vault.dialog.confirm')}</button>
      </div>
    </div>
        </div>
  `);

      const close = (value) => {
        overlay.remove();
        resolve(value);
      };

      overlay.find('.ov-dialog-close, .cancel').on('click', () => close(false));
      overlay.find('.confirm').on('click', () => close(true));

      overlay.on('keydown', (e) => {
        if (e.key === 'Escape') close(false);
        if (e.key === 'Enter') close(true);
      });

      overlay.on('click', (e) => {
        if (e.target === overlay[0]) close(false);
      });

      overlay.css({
        position: 'fixed',
        zIndex: reserveOverlayZIndex()
      });

      appendJQueryToOverlayHost(overlay, { owner: this });
      overlay.find('.confirm').focus();
    });
  }

  cls.prototype._showAsyncConfirmDialog = function (title, content, {
    isDanger = false,
    confirmLabel = null,
    loadingLabel = null,
    onConfirm = null
  } = {}) {
    return new Promise((resolve) => {
      const confirmText = confirmLabel || t('origin-vault.dialog.confirm');
      const loadingText = loadingLabel || t('origin-vault.browser.loading');

      const overlay = $(`
  <div class="ov-dialog-overlay">
    <div class="ov-dialog">
      <div class="ov-dialog-header">
        <h3 class="ov-dialog-title">${title}</h3>
        <button class="ov-dialog-close"><i class="fas fa-times"></i></button>
      </div>
      <div class="ov-dialog-content">
        <p style="margin: 0; line-height: 1.5;">${content}</p>
        <div class="ov-dialog-progress" style="display: none; margin-top: 14px; padding: 12px 14px; border-radius: 8px; background: rgba(255,255,255,0.05); color: #ddd;">
          <div style="display: flex; align-items: center; gap: 10px;">
            <i class="fas fa-spinner fa-spin" style="color: var(--ov-accent, #5b9bd5);"></i>
            <span class="ov-dialog-progress-text">${loadingText}</span>
          </div>
        </div>
      </div>
      <div class="ov-dialog-footer">
        <button class="ov-dialog-btn cancel">${t('origin-vault.dialog.cancel')}</button>
        <button class="ov-dialog-btn ${isDanger ? 'danger' : 'primary'} confirm">${confirmText}</button>
      </div>
    </div>
  </div>
      `);

      const confirmBtn = overlay.find('.confirm');
      const cancelBtn = overlay.find('.cancel');
      const closeBtn = overlay.find('.ov-dialog-close');
      const progressEl = overlay.find('.ov-dialog-progress');
      const progressTextEl = overlay.find('.ov-dialog-progress-text');

      let busy = false;

      const close = (value) => {
        if (busy) return;
        overlay.remove();
        resolve(value);
      };

      const setBusy = (value, statusText = loadingText) => {
        busy = value;
        confirmBtn.prop('disabled', value);
        cancelBtn.prop('disabled', value);
        closeBtn.prop('disabled', value);

        confirmBtn.css('opacity', value ? '0.75' : '');
        cancelBtn.css('opacity', value ? '0.55' : '');
        closeBtn.css('opacity', value ? '0.55' : '');
        closeBtn.css('cursor', value ? 'default' : '');

        if (value) {
          progressEl.show();
          progressTextEl.text(statusText);
          confirmBtn.html(`<i class="fas fa-spinner fa-spin"></i> ${statusText}`);
        } else {
          progressEl.hide();
          progressTextEl.text(loadingText);
          confirmBtn.text(confirmText);
        }
      };

      const setStatus = (statusText) => {
        progressTextEl.text(statusText || loadingText);
        if (busy) {
          confirmBtn.html(`<i class="fas fa-spinner fa-spin"></i> ${statusText || loadingText}`);
        }
      };

      closeBtn.on('click', () => close(false));
      cancelBtn.on('click', () => close(false));

      confirmBtn.on('click', async () => {
        if (busy) return;

        setBusy(true, loadingText);

        // Yield once so the loading state is visibly rendered before heavy work starts.
        await new Promise(resolveRender => {
          requestAnimationFrame(() => setTimeout(resolveRender, 0));
        });

        try {
          const shouldClose = await (onConfirm ? onConfirm({ setStatus, overlay }) : true);
          if (shouldClose !== false) {
            busy = false;
            overlay.remove();
            resolve(true);
            return;
          }
        } catch (error) {
          console.error(`${MODULE_ID} | Async confirm dialog failed:`, error);
        }

        setBusy(false, loadingText);
      });

      overlay.on('keydown', (e) => {
        if (busy) return;
        if (e.key === 'Escape') close(false);
        if (e.key === 'Enter') confirmBtn.trigger('click');
      });

      overlay.on('click', (e) => {
        if (busy) return;
        if (e.target === overlay[0]) close(false);
      });

      overlay.css({
        position: 'fixed',
        zIndex: reserveOverlayZIndex()
      });

      appendJQueryToOverlayHost(overlay, { owner: this });
      confirmBtn.focus();
    });
  }

  /**
   * 加入播放清单浮层：选一个现有清单，或就地新建一个丢进去。
   * items 是已经过滤好的音频素材（单选就一个，多选/框选是一批）。
   * 真正的写清单动作都在 PlaylistIntegration 里做（世界文档，GM only）。
   */
  cls.prototype._showPlaylistPickerDialog = function (items) {
    const audioItems = (Array.isArray(items) ? items : []).filter(Boolean);
    if (audioItems.length === 0) {
      ui.notifications.warn(t('origin-vault.playlist.noAudio'));
      return;
    }

    if (!document.getElementById('ov-playlist-picker-styles')) {
      const style = document.createElement('style');
      style.id = 'ov-playlist-picker-styles';
      style.textContent = `
        .ov-dialog.ov-playlist-picker {
          width: 340px !important; max-height: calc(100vh - 100px) !important;
          background: #1e1e1e !important; border: 1px solid #444 !important; border-radius: 8px !important;
          box-shadow: 0 8px 24px rgba(0,0,0,0.5) !important;
          display: flex !important; flex-direction: column !important; overflow: hidden !important;
        }
        .ov-playlist-picker .ov-dialog-header {
          background: #252525 !important; padding: 14px 18px !important; border-bottom: 1px solid #333 !important;
          display: flex !important; align-items: center !important; justify-content: space-between !important; flex-shrink: 0 !important;
        }
        .ov-playlist-picker .ov-dialog-title { font-size: 15px !important; font-weight: 600 !important; margin: 0 !important; color: #eee !important; }
        .ov-playlist-picker .ov-dialog-close {
          background: none !important; border: none !important; color: #888 !important; cursor: pointer !important;
          width: 26px !important; height: 26px !important; border-radius: 4px !important;
        }
        .ov-playlist-picker .ov-dialog-close:hover { background: rgba(255,255,255,0.1) !important; color: #fff !important; }
        .ov-playlist-picker .ov-dialog-content { padding: 10px !important; overflow: hidden !important; flex: 1 !important; display: flex !important; flex-direction: column !important; }
        .ov-playlist-picker-list { display: flex !important; flex-direction: column !important; gap: 4px !important; max-height: 340px !important; overflow-y: auto !important; }
        .ov-playlist-picker-list::-webkit-scrollbar { width: 6px !important; }
        .ov-playlist-picker-list::-webkit-scrollbar-thumb { background: #444 !important; border-radius: 3px !important; }
        .ov-playlist-picker-item {
          display: flex !important; align-items: center !important; gap: 10px !important;
          padding: 10px 12px !important; border-radius: 6px !important; background: #252525 !important;
          cursor: pointer !important; border: 1px solid transparent !important; transition: background .15s, border-color .15s !important;
        }
        .ov-playlist-picker-item:hover { background: #303030 !important; border-color: rgba(52,152,219,.5) !important; }
        .ov-playlist-picker-item .ov-pp-icon { color: #7aa7cc !important; font-size: 13px !important; flex-shrink: 0 !important; }
        .ov-playlist-picker-item .ov-pp-name {
          flex: 1 !important; min-width: 0 !important; color: #ddd !important; font-size: 14px !important;
          white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important;
        }
        .ov-playlist-picker-item .ov-pp-count { color: #777 !important; font-size: 12px !important; flex-shrink: 0 !important; }
        .ov-playlist-picker-empty { padding: 28px 16px !important; text-align: center !important; color: #888 !important; font-size: 13px !important; line-height: 1.5 !important; }
        .ov-playlist-new-row { display: flex !important; align-items: center !important; gap: 8px !important; padding: 12px !important; border-top: 1px solid #333 !important; flex-shrink: 0 !important; }
        .ov-playlist-new-row .ov-pp-new-icon { color: #888 !important; font-size: 12px !important; flex-shrink: 0 !important; }
        .ov-playlist-new-input {
          flex: 1 !important; min-width: 0 !important; background: #2a2a2a !important; border: 1px solid #444 !important; border-radius: 6px !important;
          padding: 8px 10px !important; color: #fff !important; font-size: 13px !important; box-sizing: border-box !important;
        }
        .ov-playlist-new-input:focus { outline: none !important; border-color: #3498db !important; }
        .ov-playlist-new-btn {
          flex-shrink: 0 !important; padding: 8px 14px !important; border-radius: 6px !important;
          background: #3498db !important; border: none !important; color: #fff !important;
          font-size: 13px !important; cursor: pointer !important; white-space: nowrap !important; transition: background .15s !important;
        }
        .ov-playlist-new-btn:hover { background: #2f8bcc !important; }
        .ov-playlist-picker.busy { opacity: 0.6 !important; pointer-events: none !important; }
      `;
      document.head.appendChild(style);
    }

    const esc = (s) => foundry.utils.escapeHTML?.(String(s ?? '')) ?? String(s ?? '');
    const playlists = listPlaylists();
    const title = audioItems.length > 1
      ? tf('origin-vault.playlist.pickerTitleMulti', { count: audioItems.length })
      : t('origin-vault.playlist.pickerTitle');

    const listHtml = playlists.length
      ? playlists.map(pl => `
          <div class="ov-playlist-picker-item" data-playlist-id="${esc(pl.id)}">
            <i class="fas fa-list-ul ov-pp-icon"></i>
            <span class="ov-pp-name">${esc(pl.name)}</span>
            <span class="ov-pp-count">${tf('origin-vault.playlist.soundCount', { count: pl.soundCount })}</span>
          </div>`).join('')
      : `<div class="ov-playlist-picker-empty">${t('origin-vault.playlist.emptyHint')}</div>`;

    const overlay = $(`
      <div class="ov-dialog-overlay ov-playlist-picker-overlay">
        <div class="ov-dialog ov-playlist-picker">
          <div class="ov-dialog-header">
            <h3 class="ov-dialog-title">${title}</h3>
            <button class="ov-dialog-close"><i class="fas fa-times"></i></button>
          </div>
          <div class="ov-dialog-content">
            <div class="ov-playlist-picker-list">${listHtml}</div>
          </div>
          <div class="ov-playlist-new-row">
            <i class="fas fa-plus ov-pp-new-icon"></i>
            <input type="text" class="ov-playlist-new-input" placeholder="${t('origin-vault.playlist.newNamePlaceholder')}" title="${t('origin-vault.playlist.createHint')}">
            <button class="ov-playlist-new-btn">${t('origin-vault.playlist.createBtn')}</button>
          </div>
        </div>
      </div>
    `);

    const dialog = overlay.find('.ov-playlist-picker');
    const newInput = overlay.find('.ov-playlist-new-input');
    let busy = false;

    const close = () => {
      $(document).off('keydown.ov-playlist-picker');
      overlay.remove();
    };

    // 写清单是异步的，加个 busy 闸防止连点重复加入
    const runWrite = async (task) => {
      if (busy) return;
      busy = true;
      dialog.addClass('busy');
      try {
        await task();
        close();
      } catch (err) {
        busy = false;
        dialog.removeClass('busy');
        console.error(`${MODULE_ID} | Playlist write failed:`, err);
        ui.notifications.error(err?.message || String(err));
      }
    };

    const addToExisting = (playlistId) => runWrite(async () => {
      const { added, playlist } = await addAudioItemsToPlaylist(audioItems, playlistId);
      ui.notifications.info(tf('origin-vault.playlist.added', { count: added, name: playlist?.name || '' }));
    });

    const createAndAdd = (rawName) => {
      const name = String(rawName || '').trim();
      if (!name) return;
      return runWrite(async () => {
        const { added, playlist } = await createPlaylistWithAudioItems(name, audioItems);
        ui.notifications.info(tf('origin-vault.playlist.created', { count: added, name: playlist?.name || name }));
        // 新建的清单直接把 Foundry 原生配置面板叫出来——播放模式/音频通道/淡出/描述都交给原生调，OV 不重造一套
        playlist?.sheet?.render(true);
      });
    };

    overlay.find('.ov-dialog-close').on('click', close);
    overlay.on('mousedown', (e) => {
      if (dialog[0] && !dialog[0].contains(e.target)) close();
    });
    overlay.find('.ov-playlist-picker-list').on('click', '.ov-playlist-picker-item', function () {
      const id = $(this).data('playlistId');
      if (id) addToExisting(String(id));
    });
    newInput.on('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); createAndAdd(newInput.val()); }
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    overlay.find('.ov-playlist-new-btn').on('click', () => createAndAdd(newInput.val()));
    $(document).on('keydown.ov-playlist-picker', (e) => {
      if (e.key === 'Escape') close();
    });

    overlay.css({ position: 'fixed', zIndex: reserveOverlayZIndex() });
    appendJQueryToOverlayHost(overlay, { owner: this });

    // 一个清单都没有时，光标直接落到新建框，第一次用不卡壳
    if (playlists.length === 0) newInput.focus();
  }

}

