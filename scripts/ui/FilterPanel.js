/**
 * Origin Vault - 筛选面板组件 (Eagle 风格)
 * 简洁的单个筛选按钮 + 下拉面板设计
 */

import { MODULE_ID, IS_MAD_EDITION, FILE_TYPES, OV_LAYERS } from '../constants.js';
import { LibraryData } from '../data/LibraryData.js';
import { hasTranslation, t } from '../utils/i18n.js';

/**
 * 筛选面板类
 */
export class FilterPanel {
    constructor(container, options = {}) {
        this.container = container;
        this.options = {
            onFilterChange: options.onFilterChange || (() => { }),
            ...options
        };

        // 当前筛选状态
        this.filters = {
            tags: [],           // 选中的标签 ID
            excludeTags: [],    // 排除的标签 ID
            minRating: 0,       // 最低评分 (0 = 不筛选)
            fileTypes: [],      // 文件类型: ['image', 'video', 'audio', 'scene']
            untagged: false     // 仅显示未标签
        };

        this.isOpen = false;
        this._boundClickOutside = this._onClickOutside.bind(this);

        // 动态注入样式 (修复 CSS 加载问题)
        this._injectStyles();

        // 当前文件夹 ID (用于标签已筛选)
        this.currentFolderId = options.currentFolderId || null;
    }

    /**
     * 设置当前文件夹 ID
     * @param {string} folderId 
     */
    setCurrentFolder(folderId) {
        if (this.currentFolderId !== folderId) {
            this.currentFolderId = folderId;
            // 如果面板打开，刷新下拉内容
            if (this.isOpen) {
                this._renderDropdown();
            }
        }
    }

    _injectStyles() {
        if (document.getElementById('ov-filter-panel-style')) return;

        const css = `
            /* ==================== 筛选面板 (JS动态注入) ==================== */
            .origin-vault-container .filter-panel-container {
                position: relative;
                display: inline-flex;
                margin-left: 8px;
                vertical-align: middle;
            }
            
            .origin-vault-container .ov-filter-btn {
                background: rgba(0, 0, 0, 0.3);
                border: 1px solid #444;
                color: #ccc;
                padding: 6px 10px;
                border-radius: 4px;
                cursor: pointer;
                transition: all 0.2s;
                display: flex;
                align-items: center;
                gap: 6px;
                font-size: 13px;
                height: 32px;
            }
            
            .origin-vault-container .ov-filter-btn:hover {
                background: rgba(255, 255, 255, 0.1);
                color: #fff;
                border-color: #666;
            }
            
            .origin-vault-container .ov-filter-btn.active {
                background: rgba(var(--color-primary), 0.2);
                border-color: var(--color-primary, #ff6400);
                color: var(--color-primary, #ff6400);
            }
            
            .origin-vault-container .ov-filter-badge {
                font-size: 10px;
                background: var(--color-primary, #ff6400);
                color: white;
                padding: 0 5px;
                border-radius: 10px;
                min-width: 16px;
                height: 16px;
                display: flex;
                align-items: center;
                justify-content: center;
                line-height: 1;
            }
            
            /* 下拉面板 */
            .origin-vault-container .ov-filter-dropdown {
                position: absolute;
                top: calc(100% + 4px);
                left: 0;
                width: 300px;
                background: #1a1a1a;
                border: 1px solid #444;
                border-radius: 4px;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.6);
                z-index: ${OV_LAYERS.FILTER_DROPDOWN};
                overflow: hidden;
                padding-bottom: 4px;
            }
            
            .origin-vault-container .ov-filter-section {
                padding: 10px;
                border-bottom: 1px solid #333;
            }
            
            .origin-vault-container .ov-filter-section:last-child {
                border-bottom: none;
            }
            
            .origin-vault-container .ov-filter-section-title {
                font-size: 11px;
                font-weight: bold;
                color: #888;
                text-transform: uppercase;
                margin-bottom: 8px;
                display: flex;
                align-items: center;
                gap: 6px;
            }
            
            /* 评分选择 */
            .origin-vault-container .ov-filter-rating {
                display: flex;
                gap: 4px;
                justify-content: center;
                background: rgba(0, 0, 0, 0.2);
                padding: 6px;
                border-radius: 4px;
            }
            
            .origin-vault-container .ov-rating-star {
                font-size: 20px;
                color: #555;
                cursor: pointer;
                transition: color 0.1s;
                line-height: 1;
            }
            
            .origin-vault-container .ov-rating-star:hover,
            .origin-vault-container .ov-rating-star.filled {
                color: #ffcc00;
                text-shadow: 0 0 5px rgba(255, 204, 0, 0.3);
            }
            
            /* 芯片样式 */
            .origin-vault-container .ov-filter-types,
            .origin-vault-container .ov-filter-tags {
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
            }
            
            .origin-vault-container .ov-filter-chip {
                display: inline-flex;
                align-items: center;
                gap: 5px;
                padding: 4px 10px;
                font-size: 12px;
                background: #2a2a2a;
                border: 1px solid #444;
                border-radius: 14px;
                cursor: pointer;
                transition: all 0.15s;
                color: #ccc;
            }
            
            .origin-vault-container .ov-filter-chip:hover {
                background: #3a3a3a;
                border-color: #666;
                color: #fff;
            }
            
            .origin-vault-container .ov-filter-chip.selected {
                background: rgba(var(--color-primary), 0.2);
                border-color: var(--color-primary, #ff6400);
                color: var(--color-primary, #ff6400);
            }
            
            .origin-vault-container .ov-filter-chip.excluded {
                background: rgba(255, 0, 0, 0.15);
                border-color: #ff4444;
                color: #ff4444;
                text-decoration: line-through;
            }
            
            .origin-vault-container .ov-filter-empty {
                color: #666;
                font-style: italic;
                padding: 4px;
                font-size: 12px;
            }
            
            .origin-vault-container .ov-filter-footer {
                padding: 8px;
                text-align: center;
                background: rgba(0, 0, 0, 0.2);
                border-top: 1px solid #333;
            }
            
            .origin-vault-container .ov-filter-clear {
                background: none;
                border: none;
                color: #888;
                font-size: 11px;
                cursor: pointer;
                text-decoration: underline;
            }
            
            .origin-vault-container .ov-filter-clear:hover {
                color: #ff4444;
            }
        `;

        const style = document.createElement('style');
        style.id = 'ov-filter-panel-style';
        style.textContent = css;
        document.head.appendChild(style);
    }

    /**
     * 获取当前筛选条件
     */
    getFilters() {
        return {
            ...this.filters,
            tags: [...(this.filters.tags || [])],
            excludeTags: [...(this.filters.excludeTags || [])],
            fileTypes: [...(this.filters.fileTypes || [])]
        };
    }

    /**
     * 检查是否有激活的筛选
     */
    hasActiveFilters() {
        return this.filters.tags.length > 0 ||
            this.filters.excludeTags.length > 0 ||
            this.filters.minRating > 0 ||
            this.filters.fileTypes.length > 0 ||
            this.filters.untagged;
    }

    /**
     * 获取激活筛选数量
     */
    getActiveFilterCount() {
        let count = 0;
        if (this.filters.tags.length > 0) count += this.filters.tags.length;
        if (this.filters.minRating > 0) count++;
        if (this.filters.fileTypes.length > 0) count += this.filters.fileTypes.length;
        if (this.filters.untagged) count++;
        return count;
    }

    _getCurrentTranslation(path) {
        return foundry.utils.getProperty(game.i18n.translations, path);
    }

    _getImportedItemFilterLabel() {
        const translated = this._getCurrentTranslation('origin-vault.fileTypes.importedItem');
        if (typeof translated === 'string' && translated.trim()) {
            return translated;
        }

        return `${t('origin-vault.scenes.alreadyImported')} ${t('origin-vault.fileTypes.item')}`;
    }

    _getImportedActorFilterLabel() {
        const translated = this._getCurrentTranslation('origin-vault.fileTypes.importedActor');
        if (typeof translated === 'string' && translated.trim()) {
            return translated;
        }

        return `${t('origin-vault.scenes.alreadyImported')} ${t('origin-vault.fileTypes.actor')}`;
    }

    /**
     * 重置所有筛选
     */
    resetFilters() {
        this.filters = {
            tags: [],
            excludeTags: [],
            minRating: 0,
            fileTypes: [],
            untagged: false
        };
        this._notifyChange();
        this.render();
    }

    /**
     * 切换标签筛选
     */
    toggleTag(tagId, exclude = false) {
        if (exclude) {
            const idx = this.filters.excludeTags.indexOf(tagId);
            if (idx >= 0) {
                this.filters.excludeTags.splice(idx, 1);
            } else {
                this.filters.excludeTags.push(tagId);
                const selectIdx = this.filters.tags.indexOf(tagId);
                if (selectIdx >= 0) this.filters.tags.splice(selectIdx, 1);
            }
        } else {
            const idx = this.filters.tags.indexOf(tagId);
            if (idx >= 0) {
                this.filters.tags.splice(idx, 1);
            } else {
                this.filters.tags.push(tagId);
                const excludeIdx = this.filters.excludeTags.indexOf(tagId);
                if (excludeIdx >= 0) this.filters.excludeTags.splice(excludeIdx, 1);
            }
        }
        this._notifyChange();
        this._updateDropdown();
    }

    /**
     * 设置最低评分
     */
    setMinRating(rating) {
        this.filters.minRating = this.filters.minRating === rating ? 0 : rating;
        this._notifyChange();
        this._updateDropdown();
    }

    /**
     * 切换文件类型筛选
     */
    toggleFileType(type) {
        const idx = this.filters.fileTypes.indexOf(type);
        if (idx >= 0) {
            this.filters.fileTypes.splice(idx, 1);
        } else {
            this.filters.fileTypes.push(type);
        }
        this._notifyChange();
        this._updateDropdown();
    }

    /**
     * 切换仅显示未标签
     */
    toggleUntagged() {
        this.filters.untagged = !this.filters.untagged;
        if (this.filters.untagged) {
            this.filters.tags = [];
            this.filters.excludeTags = [];
        }
        this._notifyChange();
        this._updateDropdown();
    }

    /**
     * 打开/关闭筛选面板
     */
    toggle() {
        if (this.isOpen) {
            this.close();
        } else {
            this.open();
        }
    }

    open() {
        this.isOpen = true;
        this._renderDropdown();
        setTimeout(() => {
            document.addEventListener('click', this._boundClickOutside, true);
        }, 10);
    }

    close() {
        this.isOpen = false;
        document.removeEventListener('click', this._boundClickOutside, true);
        const dropdown = this.container.querySelector('.ov-filter-dropdown');
        if (dropdown) dropdown.remove();
        this._updateButton();
    }

    _onClickOutside(e) {
        if (!this.container.contains(e.target)) {
            this.close();
        }
    }

    _notifyChange() {
        this.options.onFilterChange(this.getFilters());
        this._updateButton();
    }

    /**
     * 渲染筛选面板
     */
    render() {
        this.container.innerHTML = '';
        this._renderButton();
    }

    _renderButton() {
        const count = this.getActiveFilterCount();
        const hasActive = count > 0;

        const btn = document.createElement('button');
        btn.className = `ov-filter-btn${hasActive ? ' active' : ''}`;
        btn.title = t('origin-vault.toolbar.settings');
        btn.innerHTML = `
      <i class="fas fa-filter"></i>
      ${hasActive ? `<span class="ov-filter-badge">${count}</span>` : ''}
    `;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggle();
        });

        this.container.appendChild(btn);
    }

    _updateButton() {
        const btn = this.container.querySelector('.ov-filter-btn');
        if (!btn) return;

        const count = this.getActiveFilterCount();
        const hasActive = count > 0;

        btn.classList.toggle('active', hasActive);

        let badge = btn.querySelector('.ov-filter-badge');
        if (hasActive) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'ov-filter-badge';
                btn.appendChild(badge);
            }
            badge.textContent = count;
        } else if (badge) {
            badge.remove();
        }
    }

    _getOv5eAutoTagIds(library) {
        const ov5eEnabled = game.modules.get('ov5e')?.active;
        const getAutoTagGroups = globalThis.OriginVault?.getAutoTagGroups;
        const itemFilterClass = globalThis.OriginVault?.itemFilterClass;
        if (!ov5eEnabled || typeof getAutoTagGroups !== 'function' || !itemFilterClass) {
            return new Set();
        }

        try {
            const groups = getAutoTagGroups(library, this.currentFolderId) || [];
            const autoTagIds = new Set();
            for (const group of groups) {
                for (const tag of group.tags || []) {
                    if (tag?.id) autoTagIds.add(tag.id);
                }
            }
            return autoTagIds;
        } catch (err) {
            console.warn(`${MODULE_ID} | Failed to resolve ov5e auto tag groups for FilterPanel:`, err);
            return new Set();
        }
    }

    _renderDropdown() {
        // 移除旧的
        let dropdown = this.container.querySelector('.ov-filter-dropdown');
        if (dropdown) dropdown.remove();

        dropdown = document.createElement('div');
        dropdown.className = 'ov-filter-dropdown';

        const library = LibraryData.getInstance();
        const autoTagIds = this._getOv5eAutoTagIds(library);
        // 根据当前文件夹获取可见标签。
        // 物品专用标签现在也应如实出现在普通筛选器中。
        const visibleTags = library.getTagsForFolder(this.currentFolderId);
        // 转换为对象格式以兼容 _renderTagChips
        const tags = Object.fromEntries(visibleTags.filter(t => !autoTagIds.has(t.id)).map(t => [t.id, t]));

        dropdown.innerHTML = `
      <div class="ov-filter-section">
        <div class="ov-filter-section-title">
          <i class="fas fa-star"></i> ${t('origin-vault.ui.rating')}
        </div>
        <div class="ov-filter-rating">
          ${[1, 2, 3, 4, 5].map(r => `
            <span class="ov-rating-star${this.filters.minRating >= r ? ' filled' : ''}${this.filters.minRating === r ? ' active' : ''}" data-rating="${r}">★</span>
          `).join('')}
        </div>
      </div>
      
      <div class="ov-filter-section">
        <div class="ov-filter-section-title">
          <i class="fas fa-file"></i> ${t('origin-vault.ui.format')}
        </div>
        <div class="ov-filter-types">
          ${this._renderTypeChips()}
        </div>
      </div>
      
      <div class="ov-filter-section">
        <div class="ov-filter-section-title">
          <i class="fas fa-tags"></i> ${t('origin-vault.tags.title')}
        </div>
        <div class="ov-filter-tags">
          ${this._renderTagChips(tags)}
        </div>
      </div>
      
      ${this.hasActiveFilters() ? `
        <div class="ov-filter-footer">
          <button class="ov-filter-clear">${t('origin-vault.settings.resetDefaults')}</button>
        </div>
      ` : ''}
    `;

        this.container.appendChild(dropdown);
        this._bindDropdownEvents(dropdown);
    }

    _updateDropdown() {
        if (this.isOpen) {
            this._renderDropdown();
        }
        this._updateButton();
    }

    _renderTypeChips() {
        const types = [
            { id: 'image', icon: 'fa-image', label: t('origin-vault.fileTypes.image') },
            { id: 'video', icon: 'fa-film', label: t('origin-vault.fileTypes.video') },
            { id: 'audio', icon: 'fa-music', label: t('origin-vault.fileTypes.audio') },
            // ★★★ ITEM_ACTOR_TOGGLE [6/7] ★★★ 打开
            { id: 'item', icon: 'fa-scroll', label: t('origin-vault.fileTypes.item') },
            { id: 'imported_item', icon: 'fa-circle-check', label: hasTranslation('origin-vault.fileTypes.importedItem') ? t('origin-vault.fileTypes.importedItem') : '已导入物品' },
            { id: 'scene', icon: 'fa-map', label: t('origin-vault.fileTypes.scene') },
            { id: 'imported_scene', icon: 'fa-check-circle', label: t('origin-vault.fileTypes.importedScene') },
            { id: 'actor', icon: 'fa-user', label: t('origin-vault.fileTypes.actor') },
            { id: 'imported_actor', icon: 'fa-circle-check', label: hasTranslation('origin-vault.fileTypes.importedActor') ? t('origin-vault.fileTypes.importedActor') : '已导入角色' }
        ].filter(t => !IS_MAD_EDITION || t.id === 'scene' || t.id === 'imported_scene');

        const importedItemType = types.find(t => t.id === 'imported_item');
        if (importedItemType) {
            importedItemType.label = this._getImportedItemFilterLabel();
        }
        const importedActorType = types.find(t => t.id === 'imported_actor');
        if (importedActorType) {
            importedActorType.label = this._getImportedActorFilterLabel();
        }

        return types.map(t => {
            const isSelected = this.filters.fileTypes.includes(t.id);
            return `<span class="ov-filter-chip${isSelected ? ' selected' : ''}" data-type="${t.id}">
        <i class="fas ${t.icon}"></i> ${t.label}
      </span>`;
        }).join('');
    }

    _renderTagChips(tags) {
        const tagEntries = Object.entries(tags);

        if (tagEntries.length === 0) {
            return `<div class="ov-filter-empty">${t('origin-vault.tags.noTags')}</div>`;
        }

        // 未标签选项
        let html = `<span class="ov-filter-chip special${this.filters.untagged ? ' selected' : ''}" data-action="untagged">
      <i class="fas fa-tag"></i> ${t('origin-vault.tags.noTags')}
    </span>`;

        // 标签列表
        html += tagEntries.map(([id, tag]) => {
            const isSelected = this.filters.tags.includes(id);
            const isExcluded = this.filters.excludeTags.includes(id);
            return `<span class="ov-filter-chip${isSelected ? ' selected' : ''}${isExcluded ? ' excluded' : ''}" 
                    data-tag-id="${id}" 
                    style="--tag-color: ${tag.color || '#808080'}">
        ${tag.name}
      </span>`;
        }).join('');

        return html;
    }

    _bindDropdownEvents(dropdown) {
        // 评分
        dropdown.querySelectorAll('.ov-rating-star').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                this.setMinRating(parseInt(el.dataset.rating));
            });
        });

        // 文件类型
        dropdown.querySelectorAll('.ov-filter-chip[data-type]').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleFileType(el.dataset.type);
            });
        });

        // 标签
        dropdown.querySelectorAll('.ov-filter-chip[data-tag-id]').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleTag(el.dataset.tagId, false);
            });
            el.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.toggleTag(el.dataset.tagId, true);
            });
        });

        // 分组折叠/展开
        dropdown.querySelectorAll('.ov-tag-group-header').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const group = el.closest('.ov-tag-group');
                const chips = group?.querySelector('.ov-tag-group-chips');
                const chevron = el.querySelector('.ov-group-chevron');
                if (chips) chips.classList.toggle('collapsed');
                if (chevron) chevron.classList.toggle('collapsed');
            });
        });

        // 未标签
        dropdown.querySelector('.ov-filter-chip[data-action="untagged"]')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleUntagged();
        });

        // 清除按钮
        dropdown.querySelector('.ov-filter-clear')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.resetFilters();
            this.close();
        });
    }

    /**
     * 销毁组件
     */
    destroy() {
        document.removeEventListener('click', this._boundClickOutside, true);
        this.container.innerHTML = '';
    }
}
