import { ovText } from '../utils/locale.js';
/**
 * Origin Vault - 物品标签筛选面板 (DnD5e 专用)
 * ---------------------------------------------------
 * 独立的筛选按钮 + 下拉面板，专门用于 DnD5e 自动标签。
 * 标签按类别分组显示（法术环阶、稀有度、伤害类型等）。
 * 仅在 DnD5e 系统下渲染。
 * 
 * 与主筛选面板保持同一套标签语义，
 * 但状态通过回调同步，避免继续共享数组引用。
 */

import { MODULE_ID, OV_LAYERS } from '../constants.js';
import { LibraryData } from '../data/LibraryData.js';
import { getTagGroups, isDnd5eSystem } from '../data/Dnd5eAutoTags.js';
import { hasTranslation, t } from '../utils/i18n.js';

export class ItemFilterPanel {
    constructor(container, options = {}) {
        this.container = container;
        this.options = {
            onFilterChange: options.onFilterChange || (() => { }),
            ...options
        };

        // 当前面板自己的筛选状态快照
        this.filters = {
            tags: [],
            excludeTags: []
        };

        this.isOpen = false;
        this.currentFolderId = options.currentFolderId || null;
        this._boundClickOutside = this._onClickOutside.bind(this);

        this._injectStyles();
    }

    // ==================== 样式注入 ====================

    _injectStyles() {
        if (document.getElementById('ov-item-filter-style')) return;

        const css = `
            .origin-vault-container .item-filter-container {
                position: relative;
                display: inline-flex;
                margin-left: 4px;
                vertical-align: middle;
            }
            
            .origin-vault-container .ov-item-filter-btn {
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
            
            .origin-vault-container .ov-item-filter-btn:hover {
                background: rgba(255, 255, 255, 0.1);
                color: #fff;
                border-color: #666;
            }
            
            .origin-vault-container .ov-item-filter-btn.active {
                background: rgba(66, 165, 245, 0.2);
                border-color: #42a5f5;
                color: #42a5f5;
            }
            
            .origin-vault-container .ov-item-filter-badge {
                font-size: 10px;
                background: #42a5f5;
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
            .origin-vault-container .ov-item-filter-dropdown {
                position: absolute;
                top: calc(100% + 4px);
                left: 0;
                width: 320px;
                max-height: 70vh;
                overflow-y: auto;
                background: #1a1a1a;
                border: 1px solid #444;
                border-radius: 4px;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.6);
                z-index: ${OV_LAYERS.FILTER_DROPDOWN};
                padding: 8px 0;
            }

            /* 分组 */
            .origin-vault-container .ov-item-group {
                padding: 4px 12px;
            }
            .origin-vault-container .ov-item-group-header {
                display: flex;
                align-items: center;
                gap: 6px;
                padding: 6px 0 4px;
                cursor: pointer;
                user-select: none;
                font-size: 12px;
                font-weight: 600;
                color: #aaa;
                transition: color 0.15s;
            }
            .origin-vault-container .ov-item-group-header:hover {
                color: #eee;
            }
            .origin-vault-container .ov-item-group-header .ov-ig-chevron {
                font-size: 9px;
                transition: transform 0.2s;
                color: #666;
            }
            .origin-vault-container .ov-item-group-header .ov-ig-chevron.collapsed {
                transform: rotate(-90deg);
            }
            .origin-vault-container .ov-item-group-header .ov-ig-count {
                font-size: 10px;
                color: #555;
                font-weight: 400;
            }
            .origin-vault-container .ov-item-group-chips {
                display: flex;
                flex-wrap: wrap;
                gap: 5px;
                padding: 4px 0 8px;
            }
            .origin-vault-container .ov-item-group-chips.collapsed {
                display: none;
            }

            /* 芯片 */
            .origin-vault-container .ov-item-chip {
                display: inline-flex;
                align-items: center;
                padding: 3px 10px;
                font-size: 11px;
                font-weight: 500;
                background: #2a2a2a;
                border: 1px solid #3a3a3a;
                border-radius: 12px;
                cursor: pointer;
                transition: all 0.15s;
                color: #bbb;
            }
            .origin-vault-container .ov-item-chip:hover {
                background: #3a3a3a;
                border-color: #555;
                color: #fff;
            }
            .origin-vault-container .ov-item-chip.selected {
                background: rgba(66, 165, 245, 0.2);
                border-color: #42a5f5;
                color: #42a5f5;
            }
            .origin-vault-container .ov-item-chip.excluded {
                background: rgba(255, 0, 0, 0.12);
                border-color: #ff4444;
                color: #ff4444;
                text-decoration: line-through;
            }

            /* 底部 */
            .origin-vault-container .ov-item-filter-footer {
                padding: 6px 12px;
                text-align: center;
                border-top: 1px solid #333;
                margin-top: 4px;
            }
            .origin-vault-container .ov-item-filter-clear {
                background: none;
                border: none;
                color: #888;
                font-size: 11px;
                cursor: pointer;
                text-decoration: underline;
            }
            .origin-vault-container .ov-item-filter-clear:hover {
                color: #ff4444;
            }

            .origin-vault-container .ov-item-filter-empty {
                color: #555;
                font-style: italic;
                text-align: center;
                padding: 16px;
                font-size: 12px;
            }

            /* 分隔线 */
            .origin-vault-container .ov-item-group + .ov-item-group {
                border-top: 1px solid #2a2a2a;
            }
        `;

        const style = document.createElement('style');
        style.id = 'ov-item-filter-style';
        style.textContent = css;
        document.head.appendChild(style);
    }

    // ==================== 公共 API ====================

    setCurrentFolder(folderId) {
        if (this.currentFolderId !== folderId) {
            this.currentFolderId = folderId;
            if (this.isOpen) this._renderDropdown();
        }
    }

    /**
     * 获取当前已选中的标签数量
     */
    getActiveCount() {
        // 只计算属于物品自动标签的选中数
        const library = LibraryData.getInstance();
        const groups = getTagGroups(library, this.currentFolderId);
        const autoTagIds = new Set();
        for (const { tags } of groups) {
            for (const t of tags) autoTagIds.add(t.id);
        }
        return this.filters.tags.filter(id => autoTagIds.has(id)).length +
            this.filters.excludeTags.filter(id => autoTagIds.has(id)).length;
    }

    toggle() {
        this.isOpen ? this.close() : this.open();
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
        const dropdown = this.container.querySelector('.ov-item-filter-dropdown');
        if (dropdown) dropdown.remove();
        this._updateButton();
    }

    render() {
        if (!isDnd5eSystem()) {
            this.container.innerHTML = '';
            return;
        }
        this.container.innerHTML = '';
        this._renderButton();
    }

    destroy() {
        document.removeEventListener('click', this._boundClickOutside, true);
        this.container.innerHTML = '';
    }

    // ==================== 内部方法 ====================

    _onClickOutside(e) {
        if (!this.container.contains(e.target)) {
            this.close();
        }
    }

    _renderButton() {
        const count = this.getActiveCount();
        const hasActive = count > 0;

        const btn = document.createElement('button');
        btn.className = `ov-item-filter-btn${hasActive ? ' active' : ''}`;
        btn.title = hasTranslation('origin-vault.autoTags.groups.itemFilter')
            ? t('origin-vault.autoTags.groups.itemFilter')
            : ovText('Item Filter', 'Фильтр предметов');
        btn.innerHTML = `
            <i class="fas fa-dice-d20"></i>
            ${hasActive ? `<span class="ov-item-filter-badge">${count}</span>` : ''}
        `;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggle();
        });

        this.container.appendChild(btn);
    }

    _updateButton() {
        const btn = this.container.querySelector('.ov-item-filter-btn');
        if (!btn) return;

        const count = this.getActiveCount();
        const hasActive = count > 0;
        btn.classList.toggle('active', hasActive);

        let badge = btn.querySelector('.ov-item-filter-badge');
        if (hasActive) {
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'ov-item-filter-badge';
                btn.appendChild(badge);
            }
            badge.textContent = count;
        } else if (badge) {
            badge.remove();
        }
    }

    _renderDropdown() {
        let dropdown = this.container.querySelector('.ov-item-filter-dropdown');
        if (dropdown) dropdown.remove();

        dropdown = document.createElement('div');
        dropdown.className = 'ov-item-filter-dropdown';

        const library = LibraryData.getInstance();
        const groups = getTagGroups(library, this.currentFolderId);

        if (groups.length === 0) {
            dropdown.innerHTML = `<div class="ov-item-filter-empty">
                <i class="fas fa-dice-d20" style="font-size: 20px; margin-bottom: 8px; display: block;"></i>
                ${hasTranslation('origin-vault.autoTags.groups.noItemTags')
                    ? t('origin-vault.autoTags.groups.noItemTags')
                    : ovText('No item tags in this folder', 'В этой папке нет меток предметов')}
            </div>`;
            this.container.appendChild(dropdown);
            return;
        }

        dropdown.innerHTML = groups.map(({ group, tags }) => {
            const groupLabel = hasTranslation(group.i18nKey)
                ? t(group.i18nKey)
                : group.id;

            const chips = tags.map(tag => {
                const isSelected = this.filters.tags.includes(tag.id);
                const isExcluded = this.filters.excludeTags.includes(tag.id);
                return `<span class="ov-item-chip${isSelected ? ' selected' : ''}${isExcluded ? ' excluded' : ''}" 
                    data-tag-id="${tag.id}">${tag.name}</span>`;
            }).join('');

            return `
                <div class="ov-item-group" data-group="${group.id}">
                    <div class="ov-item-group-header">
                        <i class="fas fa-chevron-down ov-ig-chevron"></i>
                        <span>${group.icon} ${groupLabel}</span>
                        <span class="ov-ig-count">(${tags.length})</span>
                    </div>
                    <div class="ov-item-group-chips">${chips}</div>
                </div>
            `;
        }).join('');

        // 清除按钮
        if (this.getActiveCount() > 0) {
            dropdown.innerHTML += `
                <div class="ov-item-filter-footer">
                    <button class="ov-item-filter-clear">${hasTranslation('origin-vault.settings.resetDefaults')
                    ? t('origin-vault.settings.resetDefaults')
                    : 'Clear'
                }</button>
                </div>
            `;
        }

        this.container.appendChild(dropdown);
        this._bindDropdownEvents(dropdown);
    }

    _bindDropdownEvents(dropdown) {
        // 标签点击
        dropdown.querySelectorAll('.ov-item-chip[data-tag-id]').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                this._toggleTag(el.dataset.tagId, false);
            });
            el.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this._toggleTag(el.dataset.tagId, true);
            });
        });

        // 分组折叠
        dropdown.querySelectorAll('.ov-item-group-header').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                const group = el.closest('.ov-item-group');
                const chips = group?.querySelector('.ov-item-group-chips');
                const chevron = el.querySelector('.ov-ig-chevron');
                if (chips) chips.classList.toggle('collapsed');
                if (chevron) chevron.classList.toggle('collapsed');
            });
        });

        // 清除
        dropdown.querySelector('.ov-item-filter-clear')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this._clearItemTags();
        });
    }

    _toggleTag(tagId, exclude = false) {
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
        this.options.onFilterChange(this.filters);
        this._renderDropdown();
        this._updateButton();
    }

    _clearItemTags() {
        // 只清除物品自动标签，不影响用户手动标签
        const library = LibraryData.getInstance();
        const groups = getTagGroups(library, this.currentFolderId);
        const autoTagIds = new Set();
        for (const { tags } of groups) {
            for (const t of tags) autoTagIds.add(t.id);
        }
        this.filters.tags = this.filters.tags.filter(id => !autoTagIds.has(id));
        this.filters.excludeTags = this.filters.excludeTags.filter(id => !autoTagIds.has(id));

        this.options.onFilterChange(this.filters);
        this._renderDropdown();
        this._updateButton();
    }
}
