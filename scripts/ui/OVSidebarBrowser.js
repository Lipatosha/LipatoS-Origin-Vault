import { MODULE_ID, SPECIAL_FOLDERS, FILE_TYPES, EVENTS, IS_MAD_EDITION, ENABLE_RIGHT_SIDEBAR_BROWSER } from '../constants.js';
import { LibraryData } from '../data/LibraryData.js';
import { LibraryManager } from '../data/LibraryManager.js';
import { SceneRenderer } from './SceneRenderer.js';
import { MainWindow } from './MainWindow.js';
import { WaveformManager } from '../utils/WaveformManager.js';
import { hasTranslation, t } from '../utils/i18n.js';
import { getWorldSceneId } from '../utils/worldSceneBindings.js';

const TAB_ID = 'ov-sidebar-browser';
const PREVIEW_ID = 'ov-sidebar-browser-preview';
const CONTEXT_MENU_ID = 'ov-sidebar-browser-context-menu';
const SPECIAL_FOLDER_IDS = new Set(Object.values(SPECIAL_FOLDERS));
const ITEM_FILTER_GROUPS_FALLBACK = 'origin-vault.autoTags.groups.itemFilter';
const QUICK_PRESET_FILE_TYPES = Object.freeze({
  all: [],
  files: ['image', 'video', 'audio'],
  items: ['item'],
  scenes: ['scene']
});

export class OVSidebarBrowser {
  static #instance = null;

  static getInstance() {
    if (!OVSidebarBrowser.#instance) {
      OVSidebarBrowser.#instance = new OVSidebarBrowser();
    }
    return OVSidebarBrowser.#instance;
  }

  constructor() {
    this.initialized = false;

    this.state = {
      currentFolderId: SPECIAL_FOLDERS.ALL,
      searchOpen: false,
      filterOpen: false,
      folderOpen: false,
      searchQuery: '',
      activeFilterTab: 'default',
      filters: {
        tags: [],
        excludeTags: [],
        fileTypes: []
      }
    };

    this._sidebarRoot = null;
    this._tabEntry = null;
    this._tabButton = null;
    this._panel = null;
    this._contextMenuEl = null;
    this._scroller = null;
    this._flow = null;
    this._previewEl = null;
    this._activePreview = null;
    this._hoverSceneRenderer = null;
    this._previewToken = 0;
    this._resizeObserver = null;
    this._refreshTimer = null;
    this._renderToken = 0;
    this._scrollFrame = null;
    this._hoverTimer = null;
    this._hidePreviewTimer = null;
    this._loadPromise = null;
    this._pendingRenderOptions = null;
    this._lastLayoutWidth = 0;
    this._currentScrollTop = 0;
    this._pendingFocusItemId = null;
    this._focusedItemId = null;
    this._focusClearTimer = null;
    this._items = [];
    this._itemsById = new Map();
    this._importedSceneUuids = null;
    this._importedSceneNames = null;
    this._importedItemUuids = null;
    this._importedSceneCacheTimer = null;
    this._importedItemCacheTimer = null;
    this._layout = {
      positions: new Map(),
      totalHeight: 0,
      columnWidth: 0,
      gap: 10
    };

    this._boundOnDocumentPointerDown = this._onDocumentPointerDown.bind(this);
    this._boundOnDocumentKeyDown = this._onDocumentKeyDown.bind(this);
    this._boundOnScroll = this._onScroll.bind(this);
    this._boundOnResize = this._onViewportResize.bind(this);
    this._boundOnWorldSceneCreate = () => this._onWorldCollectionChanged('scene');
    this._boundOnWorldSceneDelete = () => this._onWorldCollectionChanged('scene');
    this._boundOnWorldItemCreate = () => this._onWorldCollectionChanged('item');
    this._boundOnWorldItemDelete = () => this._onWorldCollectionChanged('item');
  }

  init() {
    if (!ENABLE_RIGHT_SIDEBAR_BROWSER) return;
    if (this.initialized) return;
    this.initialized = true;

    Hooks.on('renderSidebar', (_app, html) => {
      this._ensureInjected(html);
    });

    for (const eventName of [
      EVENTS.ITEM_ADDED,
      EVENTS.ITEM_UPDATED,
      EVENTS.ITEM_REMOVED,
      EVENTS.FOLDER_CREATED,
      EVENTS.FOLDER_UPDATED,
      EVENTS.FOLDER_DELETED,
      EVENTS.TAG_CREATED,
      EVENTS.TAG_UPDATED,
      EVENTS.TAG_DELETED,
      EVENTS.LIBRARY_CREATED,
      EVENTS.LIBRARY_LOADED,
      EVENTS.LIBRARY_SWITCHED
    ]) {
      Hooks.on(eventName, () => this._scheduleRefresh({ preserveScroll: true }));
    }

    document.addEventListener('pointerdown', this._boundOnDocumentPointerDown, true);
    document.addEventListener('keydown', this._boundOnDocumentKeyDown, true);
    window.addEventListener('resize', this._boundOnResize);
    Hooks.on('createScene', this._boundOnWorldSceneCreate);
    Hooks.on('deleteScene', this._boundOnWorldSceneDelete);
    Hooks.on('createItem', this._boundOnWorldItemCreate);
    Hooks.on('deleteItem', this._boundOnWorldItemDelete);

    this._ensurePreviewHost();
    this._ensureInjected(ui.sidebar?.element ?? document.getElementById('sidebar'));
  }

  _ensureInjected(htmlLike) {
    const sidebarRoot = this._resolveSidebarRoot(htmlLike);
    if (!sidebarRoot) return;

    const tabsNav = sidebarRoot.querySelector('#sidebar-tabs');
    if (!tabsNav) return;

    const tabHost = this._getTabButtonHost(tabsNav);
    if (!tabHost) return;

    let tabButton = tabsNav.querySelector(`[data-tab="${TAB_ID}"]`);
    let tabEntry = tabButton ? this._getTabEntry(tabButton, tabHost) : null;
    if (!tabButton) {
      const created = this._createTabButton(tabHost);
      tabEntry = created.entry;
      tabButton = created.button;
      tabButton.addEventListener('click', () => {
        const renderOptions = this._consumePendingRenderOptions() || { preserveScroll: true };
        this._ensureSidebarExpanded();
        requestAnimationFrame(() => {
          if (!this._isActive()) {
            this._activateFallbackTab();
          }
          this._renderPanel(renderOptions);
        });
      });
      tabHost.appendChild(tabEntry);
    } else if ((tabEntry || tabButton).parentElement !== tabHost) {
      tabHost.appendChild(tabEntry || tabButton);
    }
    this._configureTabButton(tabEntry || tabButton, tabButton, t('origin-vault.sidebarDock.tabTitle'));

    if (!tabsNav.dataset.ovSidebarBrowserBridge) {
      tabsNav.dataset.ovSidebarBrowserBridge = 'true';
      tabsNav.addEventListener('click', (event) => {
        const item = event.target.closest('[data-tab]');
        if (!item || !tabsNav.contains(item) || item.dataset.tab === TAB_ID) return;
        this._hidePreview();
        this._closePopovers();
        this._setTabActiveState(this._tabButton, false);
        this._panel?.classList.remove('active');
      });
    }

    const panelHost = this._getPanelHost(sidebarRoot);
    let panel = sidebarRoot.querySelector(`#${TAB_ID}`);
    if (!panel) {
      panel = document.createElement('section');
      panelHost.appendChild(panel);
    } else if (panel.parentElement !== panelHost) {
      panelHost.appendChild(panel);
    }
    panel.id = TAB_ID;
    panel.className = 'tab sidebar-tab directory flexcol ov-sidebar-browser';
    panel.dataset.tab = TAB_ID;
    panel.dataset.group = 'primary';
    panel.setAttribute('role', 'tabpanel');

    this._sidebarRoot = sidebarRoot;
    this._tabEntry = tabEntry || tabButton;
    this._tabButton = tabButton;
    this._panel = panel;
    this._observePanelResize();

    if (this._isActive()) {
      this._renderPanel({ preserveScroll: true });
    }
  }

  activate({ preserveScroll = true, resetScroll = false } = {}) {
    if (!this._panel || !this._tabButton) return;

    this._ensureSidebarExpanded();
    this._pendingRenderOptions = { preserveScroll, resetScroll };
    const activationMode = this._requestNativeTabChange();

    if (activationMode === 'fallback-click') {
      return;
    }

    requestAnimationFrame(() => {
      const renderOptions = this._consumePendingRenderOptions() || { preserveScroll, resetScroll };
      if (!this._isActive()) {
        this._activateFallbackTab();
      }
      this._renderPanel(renderOptions);
    });
  }

  openWithPreset(presetId) {
    if (!this._applyQuickPreset(presetId)) return;
    this.activate({ resetScroll: true, preserveScroll: false });
  }

  openFolderFromQuickLauncher(folderId) {
    if (!folderId) return false;
    if (!this._isFolderAvailable(LibraryData.getInstance(), folderId)) return false;

    this._applyQuickLauncherViewState({ folderId });
    this.activate({ resetScroll: true, preserveScroll: false });
    return true;
  }

  async getQuickLauncherFolders() {
    const library = await this._ensureLibraryReady();
    if (!library) return [];
    return this._buildQuickLauncherFolderTree(library);
  }

  async locateCurrentScene() {
    const viewedScene = canvas?.scene;
    if (!viewedScene) {
      ui.notifications.warn(t('origin-vault.scenes.noActiveScene'));
      return false;
    }

    const library = await this._ensureLibraryReady();
    if (!library) {
      ui.notifications.warn(t('origin-vault.sidebarDock.noLibrary'));
      return false;
    }

    const matchedItem = this._findSceneLibraryItem(viewedScene, library);
    if (!matchedItem) {
      ui.notifications.warn(t('origin-vault.scenes.sceneNotInLibrary'));
      return false;
    }

    const targetFolderId = matchedItem.folders?.find((folderId) => !SPECIAL_FOLDER_IDS.has(folderId))
      || matchedItem.folders?.[0]
      || SPECIAL_FOLDERS.ALL;

    this._applyQuickLauncherViewState({
      folderId: targetFolderId,
      fileTypes: ['scene'],
      focusItemId: matchedItem.id
    });
    this.activate({ resetScroll: true, preserveScroll: false });
    return true;
  }

  getTabButtonElement() {
    return this._tabButton;
  }

  getActiveQuickPresetId() {
    const fileTypes = [...(this.state.filters?.fileTypes || [])].sort().join('|');

    for (const [presetId, presetTypes] of Object.entries(QUICK_PRESET_FILE_TYPES)) {
      if ([...presetTypes].sort().join('|') === fileTypes) {
        return presetId;
      }
    }

    return 'custom';
  }

  _activateFallbackTab() {
    if (!this._sidebarRoot || !this._panel || !this._tabButton) return;

    this._getSidebarTabButtons().forEach((el) => {
      this._setTabActiveState(el, el === this._tabButton);
    });

    this._sidebarRoot.querySelectorAll('.sidebar-tab').forEach((el) => {
      el.classList.toggle('active', el === this._panel);
    });

    if (ui.sidebar) {
      ui.sidebar.activeTab = TAB_ID;
    }
  }

  _isActive() {
    return !!this._panel?.classList.contains('active')
      || !!this._tabButton?.classList.contains('active')
      || ui.sidebar?.activeTab === TAB_ID;
  }

  _resolveSidebarRoot(htmlLike) {
    if (!htmlLike) {
      return document.getElementById('sidebar');
    }

    if (htmlLike instanceof HTMLElement) {
      return htmlLike.id === 'sidebar' ? htmlLike : htmlLike.querySelector('#sidebar') ?? document.getElementById('sidebar');
    }

    const element = htmlLike[0] ?? htmlLike.element?.[0] ?? null;
    if (element instanceof HTMLElement) {
      return element.id === 'sidebar' ? element : element.querySelector('#sidebar') ?? document.getElementById('sidebar');
    }

    return document.getElementById('sidebar');
  }

  _getTabButtonHost(tabsNav) {
    if (!tabsNav) return null;

    const directHost = Array.from(tabsNav.children).find((child) =>
      child?.matches?.('menu, nav.tabs, .tabs')
    );
    if (directHost) {
      return directHost;
    }

    return tabsNav.querySelector('menu, nav.tabs, .tabs') || tabsNav;
  }

  _getPanelHost(sidebarRoot) {
    if (!sidebarRoot) return null;
    return sidebarRoot.querySelector('#sidebar-content')
      || sidebarRoot.querySelector('.sidebar-tab')?.parentElement
      || sidebarRoot;
  }

  _getSidebarTabButtons() {
    const tabsNav = this._sidebarRoot?.querySelector('#sidebar-tabs');
    const tabHost = this._getTabButtonHost(tabsNav);
    if (!tabHost) return [];

    return Array.from(tabHost.querySelectorAll('[data-tab]')).filter((el) =>
      el instanceof HTMLElement
      && el !== this._panel
    );
  }

  _createTabButton(tabHost) {
    const nativeTemplate = this._getNativeTabTemplate(tabHost);
    const title = t('origin-vault.sidebarDock.tabTitle');
    const tabEntry = nativeTemplate
      ? nativeTemplate.cloneNode(true)
      : this._buildFallbackTabEntry(tabHost);

    const tabButton = this._extractTabButton(tabEntry) || tabEntry;
    this._configureTabButton(tabEntry, tabButton, title);
    return { entry: tabEntry, button: tabButton };
  }

  _getNativeTabTemplate(tabHost) {
    if (!tabHost) return null;

    return Array.from(tabHost.children).find((child) =>
      child instanceof HTMLElement
      && this._extractTabButton(child)?.dataset.tab
      && this._extractTabButton(child)?.dataset.tab !== TAB_ID
    ) || null;
  }

  _buildFallbackTabEntry(tabHost) {
    if (tabHost?.matches?.('menu, ul, ol')) {
      const entry = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ui-control plain icon';
      button.dataset.action = 'tab';
      entry.appendChild(button);
      return entry;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ui-control plain icon';
    button.dataset.action = 'tab';
    return button;
  }

  _configureTabButton(tabEntry, tabButton, title) {
    if (!(tabButton instanceof HTMLElement)) return;

    if (tabEntry instanceof HTMLElement) {
      tabEntry.id = '';
      tabEntry.classList.remove('active');
      if (tabEntry !== tabButton && tabEntry.tagName === 'LI') {
        tabEntry.classList.add('ov-sidebar-browser__tab-entry');
      }
    }

    tabButton.classList.remove('active');
    tabButton.classList.add('ov-sidebar-browser__tab-button');
    tabButton.dataset.tab = TAB_ID;
    tabButton.dataset.group = 'primary';

    if (tabButton.tagName === 'BUTTON') {
      tabButton.setAttribute('type', 'button');
      tabButton.dataset.action ||= 'tab';
    } else {
      tabButton.removeAttribute('href');
      tabButton.setAttribute('role', 'button');
    }

    tabButton.setAttribute('role', 'tab');
    tabButton.setAttribute('aria-label', title);
    tabButton.setAttribute('title', title);
    tabButton.setAttribute('aria-pressed', 'false');

    tabButton.dataset.tooltip = title;

    this._setTabButtonIcon(tabButton);
  }

  _setTabButtonIcon(tabButton) {
    const iconEl = tabButton.querySelector('i');

    if (iconEl) {
      this._stripIconClasses(tabButton);
      iconEl.className = 'fas fa-box';
      tabButton.replaceChildren(iconEl);
      return;
    }

    if (tabButton.tagName === 'BUTTON') {
      this._stripIconClasses(tabButton);
      tabButton.classList.add('fa-solid', 'fa-box');
      tabButton.textContent = '';
      return;
    }

    tabButton.innerHTML = '<i class="fas fa-box"></i>';
  }

  _extractTabButton(entry) {
    if (!(entry instanceof HTMLElement)) return null;
    if (entry.matches('[data-tab]')) return entry;
    return entry.querySelector('[data-tab]');
  }

  _getTabEntry(tabButton, tabHost) {
    if (!(tabButton instanceof HTMLElement)) return null;

    let current = tabButton;
    while (current instanceof HTMLElement && current.parentElement && current.parentElement !== tabHost) {
      current = current.parentElement;
    }

    if (current instanceof HTMLElement && current.parentElement === tabHost) {
      return current;
    }

    return tabButton;
  }

  _setTabActiveState(tabButton, isActive) {
    if (!(tabButton instanceof HTMLElement)) return;

    tabButton.classList.toggle('active', isActive);
    if (tabButton.matches('button, a')) {
      tabButton.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    }

    const tabHost = this._getTabButtonHost(this._sidebarRoot?.querySelector('#sidebar-tabs'));
    const tabEntry = this._getTabEntry(tabButton, tabHost);
    if (tabEntry && tabEntry !== tabButton) {
      tabEntry.classList.toggle('active', isActive);
    }
  }

  _requestNativeTabChange() {
    const changeTab = ui.sidebar?.changeTab;
    if (typeof changeTab === 'function') {
      const attempts = [
        [TAB_ID, 'primary'],
        [TAB_ID, { group: 'primary' }],
        [{ tab: TAB_ID, group: 'primary' }]
      ];

      for (const args of attempts) {
        try {
          changeTab.call(ui.sidebar, ...args);
          return 'native';
        } catch (_err) {}
      }
    }

    this._tabButton?.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true
    }));
    return 'fallback-click';
  }

  _ensureSidebarExpanded() {
    const sidebar = ui.sidebar;
    if (!sidebar) return;

    const sidebarRoot = this._resolveSidebarRoot(sidebar.element ?? document.getElementById('sidebar'));
    const isCollapsed = sidebar.collapsed === true
      || sidebar._collapsed === true
      || !!sidebarRoot?.classList.contains('collapsed');

    if (isCollapsed && typeof sidebar.expand === 'function') {
      try {
        sidebar.expand();
      } catch (_err) {}
    }
  }

  _consumePendingRenderOptions() {
    const options = this._pendingRenderOptions;
    this._pendingRenderOptions = null;
    return options;
  }

  _applyQuickPreset(presetId) {
    const presetTypes = QUICK_PRESET_FILE_TYPES[presetId];
    if (!presetTypes) return false;

    this._applyQuickLauncherViewState({
      folderId: SPECIAL_FOLDERS.ALL,
      fileTypes: [...presetTypes]
    });
    return true;
  }

  _applyQuickLauncherViewState({ folderId = SPECIAL_FOLDERS.ALL, fileTypes = [], focusItemId = null } = {}) {
    this.state.currentFolderId = folderId;
    this.state.folderOpen = false;
    this.state.searchOpen = false;
    this.state.filterOpen = false;
    this.state.searchQuery = '';
    this.state.activeFilterTab = 'default';
    this.state.filters = {
      tags: [],
      excludeTags: [],
      fileTypes: [...fileTypes]
    };
    this._currentScrollTop = 0;
    this._pendingFocusItemId = focusItemId;
    this._hidePreview();
    this._hideCardContextMenu();
  }

  _stripIconClasses(element) {
    if (!(element instanceof HTMLElement)) return;

    const iconClasses = Array.from(element.classList).filter((cls) =>
      cls === 'fas'
      || cls === 'far'
      || cls === 'fal'
      || cls === 'fab'
      || cls === 'fa-solid'
      || cls === 'fa-regular'
      || cls === 'fa-light'
      || cls === 'fa-brands'
      || cls.startsWith('fa-')
    );

    if (iconClasses.length) {
      element.classList.remove(...iconClasses);
    }
  }

  async _renderPanel({ preserveScroll = false, resetScroll = false } = {}) {
    if (!this._panel) return;

    const renderToken = ++this._renderToken;
    const previousScrollTop = preserveScroll ? (this._scroller?.scrollTop ?? this._currentScrollTop ?? 0) : 0;
    const shouldShowLoading = !LibraryData.getInstance().loaded;

    this._hidePreview();
    this._hideCardContextMenu();
    this._detachScroller();
    if (shouldShowLoading) {
      this._panel.innerHTML = this._buildLoadingState();
    }

    const library = await this._ensureLibraryReady();
    if (renderToken !== this._renderToken || !this._panel) return;

    if (!library) {
      this._panel.innerHTML = this._buildEmptyLibraryState();
      return;
    }

    const view = this._collectViewData(library);

    this._panel.innerHTML = this._buildPanelHtml(view);
    this._bindPanelEvents(view);

    this._scroller = this._panel.querySelector('.ov-sidebar-browser__scroller');
    this._flow = this._panel.querySelector('.ov-sidebar-browser__flow');
    this._items = view.items;
    this._itemsById = new Map(view.items.map((item) => [item.id, item]));

    if (!this._scroller || !this._flow) return;

    this._scroller.addEventListener('scroll', this._boundOnScroll, { passive: true });

    const targetScrollTop = resetScroll ? 0 : previousScrollTop;
    this._updateLayout({ scrollTop: targetScrollTop });
  }

  _collectViewData(library) {
    if (!this._isFolderAvailable(library, this.state.currentFolderId)) {
      this.state.currentFolderId = SPECIAL_FOLDERS.ALL;
    }

    const folderOptions = this._buildFolderOptions(library);
    const currentFolderName = this._getFolderLabel(library, this.state.currentFolderId);
    const itemFilterAvailable = this._hasItemSpecificFilters();
    const itemGroups = itemFilterAvailable ? this._getItemSpecificGroups(library) : [];
    const itemAutoTagIds = new Set();

    for (const group of itemGroups) {
      for (const tag of group.tags || []) {
        if (tag?.id) itemAutoTagIds.add(tag.id);
      }
    }

    const defaultTags = library
      .getTagsForFolder(this.state.currentFolderId)
      .filter((tag) => !itemAutoTagIds.has(tag.id));

    const searchQuery = this.state.searchQuery.trim();
    const items = library.searchItems(searchQuery, {
      ...this.state.filters,
      folderId: this.state.currentFolderId,
      mode: 'fuzzy'
    });
    this._hydrateImportState(items);

    const hasAnyFilter = this._getActiveFilterCount() > 0 || !!searchQuery;

    return {
      currentFolderName,
      currentFolderId: this.state.currentFolderId,
      folderOptions,
      defaultTags,
      itemGroups,
      itemFilterAvailable,
      items,
      itemCount: items.length,
      filterCount: this._getActiveFilterCount(),
      hasAnyFilter,
      searchQuery
    };
  }

  _buildPanelHtml(view) {
    const searchActive = this.state.searchOpen || !!view.searchQuery;
    const filterActive = this.state.filterOpen || view.filterCount > 0;
    const folderActive = this.state.folderOpen;

    return `
      <div class="ov-sidebar-browser__shell">
        <header class="ov-sidebar-browser__header directory-header flexcol">
          <div class="ov-sidebar-browser__toolbar header-actions action-buttons flexrow">
          <button type="button" class="ov-sidebar-browser__tool header-control${folderActive ? ' is-active' : ''}" data-action="toggle-folder-menu" title="${this._escapeHtml(t('origin-vault.sidebarDock.folderButton'))}">
            <i class="fas fa-folder-open"></i>
            <span>${this._escapeHtml(this._truncateLabel(view.currentFolderName, 18))}</span>
          </button>
          <button type="button" class="ov-sidebar-browser__tool header-control${searchActive ? ' is-active' : ''}" data-action="toggle-search" title="${this._escapeHtml(t('origin-vault.sidebarDock.searchButton'))}">
            <i class="fas fa-search"></i>
            <span>${this._escapeHtml(t('origin-vault.sidebarDock.searchButton'))}</span>
          </button>
          <button type="button" class="ov-sidebar-browser__tool header-control${filterActive ? ' is-active' : ''}" data-action="toggle-filter-menu" title="${this._escapeHtml(t('origin-vault.sidebarDock.filterButton'))}">
            <i class="fas fa-filter"></i>
            <span>${this._escapeHtml(t('origin-vault.sidebarDock.filterButton'))}</span>
            ${view.filterCount > 0 ? `<em class="ov-sidebar-browser__tool-badge">${view.filterCount}</em>` : ''}
          </button>
          </div>

          <div class="ov-sidebar-browser__popovers">
            ${this.state.folderOpen ? this._buildFolderMenuHtml(view.folderOptions) : ''}
            ${this.state.searchOpen ? this._buildSearchMenuHtml(view.searchQuery) : ''}
            ${this.state.filterOpen ? this._buildFilterMenuHtml(view) : ''}
          </div>

          <div class="ov-sidebar-browser__summary">
            <strong>${this._escapeHtml(view.currentFolderName)}</strong>
            <span class="hint">${view.itemCount}</span>
          </div>
        </header>

        <div class="ov-sidebar-browser__content">
          ${view.items.length > 0 ? `
            <div class="ov-sidebar-browser__scroller directory-list">
              <div class="ov-sidebar-browser__flow"></div>
            </div>
          ` : this._buildEmptyState(view.hasAnyFilter)}
        </div>
      </div>
    `;
  }

  _buildLoadingState() {
    return `
      <div class="ov-sidebar-browser__state ov-sidebar-browser__state--loading">
        <i class="fas fa-spinner fa-spin"></i>
        <span>${this._escapeHtml(t('origin-vault.browser.loading'))}</span>
      </div>
    `;
  }

  _buildEmptyLibraryState() {
    return `
      <div class="ov-sidebar-browser__state">
        <i class="fas fa-box-open"></i>
        <p>${this._escapeHtml(t('origin-vault.sidebarDock.noLibrary'))}</p>
      </div>
    `;
  }

  _buildEmptyState(hasAnyFilter) {
    const message = hasAnyFilter
      ? t('origin-vault.search.noResults')
      : t('origin-vault.sidebarDock.empty');

    return `
      <div class="ov-sidebar-browser__state">
        <i class="fas fa-layer-group"></i>
        <p>${this._escapeHtml(message)}</p>
      </div>
    `;
  }

  _buildFolderMenuHtml(folderOptions) {
    return `
      <div class="ov-sidebar-browser__popover ov-sidebar-browser__popover--folder">
        <div class="ov-sidebar-browser__menu">
          ${folderOptions.map((folder) => `
            <button
              class="ov-sidebar-browser__folder-option${folder.id === this.state.currentFolderId ? ' is-active' : ''}"
              data-action="select-folder"
              data-folder-id="${this._escapeHtml(folder.id)}"
              style="--ov-sidebar-folder-depth:${folder.depth};"
            >
              <span class="ov-sidebar-browser__folder-main">
                <i class="fas ${this._escapeHtml(folder.icon)}"></i>
                <span class="ov-sidebar-browser__folder-label">${this._escapeHtml(folder.name)}</span>
              </span>
              <span class="ov-sidebar-browser__folder-count">${folder.count}</span>
            </button>
          `).join('')}
        </div>
      </div>
    `;
  }

  _buildSearchMenuHtml(searchQuery) {
    return `
      <div class="ov-sidebar-browser__search-row header-search flexrow">
        <label class="ov-sidebar-browser__search-field">
          <i class="fas fa-search"></i>
          <input
            type="text"
            data-role="search-input"
            placeholder="${this._escapeHtml(t('origin-vault.search.placeholder'))}"
            value="${this._escapeHtml(searchQuery)}"
          >
          ${searchQuery ? '<button type="button" class="ov-sidebar-browser__search-clear" data-action="clear-search"><i class="fas fa-times"></i></button>' : ''}
        </label>
      </div>
    `;
  }

  _buildFilterMenuHtml(view) {
    const hasSegments = view.itemFilterAvailable;
    const defaultActive = this.state.activeFilterTab !== 'item';
    const itemActive = this.state.activeFilterTab === 'item';

    return `
      <div class="ov-sidebar-browser__popover ov-sidebar-browser__popover--filter">
        ${hasSegments ? `
          <div class="ov-sidebar-browser__segments">
            <button class="ov-sidebar-browser__segment${defaultActive ? ' is-active' : ''}" data-action="set-filter-tab" data-filter-tab="default">
              ${this._escapeHtml(t('origin-vault.sidebarDock.defaultFilters'))}
            </button>
            <button class="ov-sidebar-browser__segment${itemActive ? ' is-active' : ''}" data-action="set-filter-tab" data-filter-tab="item">
              ${this._escapeHtml(t('origin-vault.sidebarDock.itemFilters'))}
            </button>
          </div>
        ` : ''}

        ${defaultActive ? this._buildDefaultFilterTab(view) : this._buildItemFilterTab(view)}

        ${view.filterCount > 0 ? `
          <div class="ov-sidebar-browser__filter-footer">
            <button class="ov-sidebar-browser__ghost-button" data-action="clear-filters">
              ${this._escapeHtml(t('origin-vault.settings.resetDefaults'))}
            </button>
          </div>
        ` : ''}
      </div>
    `;
  }

  _buildDefaultFilterTab(view) {
    const typeOptions = this._getFilterTypeOptions();

    return `
      <div class="ov-sidebar-browser__filter-section">
        <h4>${this._escapeHtml(t('origin-vault.ui.format'))}</h4>
        <div class="ov-sidebar-browser__chip-group">
          ${typeOptions.map((option) => this._buildFilterChip(option.id, option.label, {
            selected: this.state.filters.fileTypes.includes(option.id),
            icon: option.icon,
            action: 'toggle-type-filter'
          })).join('')}
        </div>
      </div>

      <div class="ov-sidebar-browser__filter-section">
        <h4>${this._escapeHtml(t('origin-vault.tags.title'))}</h4>
        ${view.defaultTags.length > 0 ? `
          <div class="ov-sidebar-browser__chip-group">
            ${view.defaultTags.map((tag) => this._buildTagChip(tag)).join('')}
          </div>
        ` : `
          <p class="ov-sidebar-browser__helper-text">${this._escapeHtml(t('origin-vault.tags.noTags'))}</p>
        `}
      </div>
    `;
  }

  _buildItemFilterTab(view) {
    if (!view.itemGroups.length) {
      const fallback = hasTranslation('origin-vault.autoTags.groups.noItemTags')
        ? t('origin-vault.autoTags.groups.noItemTags')
        : t('origin-vault.sidebarDock.noItemFilters');

      return `<p class="ov-sidebar-browser__helper-text">${this._escapeHtml(fallback)}</p>`;
    }

    return `
      <div class="ov-sidebar-browser__item-groups">
        ${view.itemGroups.map((group) => `
          <section class="ov-sidebar-browser__filter-section">
            <h4>${this._escapeHtml(group.group?.label || group.group?.name || this._localizeMaybe(group.group?.i18nKey || ITEM_FILTER_GROUPS_FALLBACK))}</h4>
            <div class="ov-sidebar-browser__chip-group">
              ${(group.tags || []).map((tag) => this._buildTagChip(tag)).join('')}
            </div>
          </section>
        `).join('')}
      </div>
    `;
  }

  _buildTagChip(tag) {
    const isSelected = this.state.filters.tags.includes(tag.id);
    const isExcluded = this.state.filters.excludeTags.includes(tag.id);
    const chipClass = [
      'ov-sidebar-browser__chip',
      isSelected ? 'is-selected' : '',
      isExcluded ? 'is-excluded' : ''
    ].filter(Boolean).join(' ');

    return `
      <button
        class="${chipClass}"
        data-action="toggle-tag-filter"
        data-tag-id="${this._escapeHtml(tag.id)}"
        style="--ov-sidebar-tag-color:${this._escapeHtml(tag.color || '#888888')};"
        title="${this._escapeHtml(tag.name)}"
      >
        <span class="ov-sidebar-browser__chip-dot"></span>
        <span>${this._escapeHtml(tag.name)}</span>
      </button>
    `;
  }

  _buildFilterChip(id, label, { selected = false, icon = null, action = null } = {}) {
    return `
      <button
        class="ov-sidebar-browser__chip${selected ? ' is-selected' : ''}"
        data-action="${this._escapeHtml(action || 'noop')}"
        data-filter-type="${this._escapeHtml(id)}"
      >
        ${icon ? `<i class="fas ${this._escapeHtml(icon)}"></i>` : ''}
        <span>${this._escapeHtml(label)}</span>
      </button>
    `;
  }

  _bindPanelEvents(view) {
    if (!this._panel) return;

    this._panel.querySelectorAll('[data-action]').forEach((element) => {
      element.addEventListener('click', (event) => this._onPanelAction(event, view));

      if (element.dataset.action === 'toggle-tag-filter') {
        element.addEventListener('contextmenu', (event) => this._onTagContextMenu(event));
      }
    });

    const searchInput = this._panel.querySelector('[data-role="search-input"]');
    if (searchInput) {
      searchInput.addEventListener('input', (event) => {
        this.state.searchQuery = event.currentTarget.value;
        this._renderPanel({ resetScroll: true });
      });

      requestAnimationFrame(() => searchInput.focus());
    }
  }

  _onPanelAction(event, view) {
    const actionTarget = event.currentTarget.closest('[data-action]');
    const action = actionTarget?.dataset.action;
    if (!action) return;

    switch (action) {
      case 'toggle-folder-menu':
        this.state.folderOpen = !this.state.folderOpen;
        this.state.searchOpen = false;
        this.state.filterOpen = false;
        this._renderPanel({ preserveScroll: true });
        break;

      case 'toggle-search':
        this.state.searchOpen = !this.state.searchOpen;
        this.state.folderOpen = false;
        this.state.filterOpen = false;
        this._renderPanel({ preserveScroll: true });
        break;

      case 'toggle-filter-menu':
        this.state.filterOpen = !this.state.filterOpen;
        this.state.folderOpen = false;
        this.state.searchOpen = false;
        if (this.state.filterOpen && !view.itemFilterAvailable) {
          this.state.activeFilterTab = 'default';
        }
        this._renderPanel({ preserveScroll: true });
        break;

      case 'select-folder': {
        const folderId = actionTarget.dataset.folderId || SPECIAL_FOLDERS.ALL;
        this.state.currentFolderId = folderId;
        this.state.folderOpen = false;
        this._hidePreview();
        this._renderPanel({ resetScroll: true });
        break;
      }

      case 'set-filter-tab':
        this.state.activeFilterTab = actionTarget.dataset.filterTab === 'item' ? 'item' : 'default';
        this._renderPanel({ preserveScroll: true });
        break;

      case 'toggle-type-filter':
        this._toggleFileType(actionTarget.dataset.filterType);
        this._renderPanel({ resetScroll: true });
        break;

      case 'toggle-tag-filter':
        this._toggleTag(actionTarget.dataset.tagId, false);
        this._renderPanel({ resetScroll: true });
        break;

      case 'clear-filters':
        this.state.filters = {
          tags: [],
          excludeTags: [],
          fileTypes: []
        };
        this.state.activeFilterTab = 'default';
        this._renderPanel({ resetScroll: true });
        break;

      case 'clear-search':
        this.state.searchQuery = '';
        this.state.searchOpen = true;
        this._renderPanel({ resetScroll: true });
        break;

      default:
        break;
    }
  }

  _onTagContextMenu(event) {
    event.preventDefault();

    const tagId = event.currentTarget.dataset.tagId;
    if (!tagId) return;

    this._toggleTag(tagId, true);
    this._renderPanel({ resetScroll: true });
  }

  _toggleTag(tagId, exclude) {
    if (!tagId) return;

    const includeTags = new Set(this.state.filters.tags);
    const excludeTags = new Set(this.state.filters.excludeTags);

    if (exclude) {
      if (excludeTags.has(tagId)) {
        excludeTags.delete(tagId);
      } else {
        excludeTags.add(tagId);
        includeTags.delete(tagId);
      }
    } else if (includeTags.has(tagId)) {
      includeTags.delete(tagId);
    } else {
      includeTags.add(tagId);
      excludeTags.delete(tagId);
    }

    this.state.filters.tags = [...includeTags];
    this.state.filters.excludeTags = [...excludeTags];
  }

  _toggleFileType(filterType) {
    if (!filterType) return;

    const types = new Set(this.state.filters.fileTypes);
    if (types.has(filterType)) {
      types.delete(filterType);
    } else {
      types.add(filterType);
    }
    this.state.filters.fileTypes = [...types];
  }

  _updateLayout({ scrollTop = null } = {}) {
    if (!this._scroller || !this._flow) return;

    const width = Math.max(0, this._scroller.clientWidth - 2);
    if (!width) return;

    if (scrollTop !== null) {
      this._scroller.scrollTop = scrollTop;
    }

    const shouldRecalculate = width !== this._lastLayoutWidth || this._layout.positions.size !== this._items.length;
    if (shouldRecalculate) {
      this._layout = this._computeLayout(this._items, width);
      this._lastLayoutWidth = width;
      this._flow.style.height = `${this._layout.totalHeight}px`;
    }

    this._renderVisibleItems();
  }

  _computeLayout(items, width) {
    const gap = 10;
    const minCardWidth = width >= 300 ? 132 : 118;
    const columns = Math.max(2, Math.floor((width + gap) / (minCardWidth + gap)));
    const columnWidth = Math.max(92, Math.floor((width - gap * (columns - 1)) / columns));
    const columnHeights = new Array(columns).fill(0);
    const positions = new Map();
    const infoHeight = 28;

    for (const item of items) {
      const ratio = this._getAspectRatio(item);
      const thumbnailHeight = Math.max(72, Math.min(360, Math.round(columnWidth / ratio)));
      const height = thumbnailHeight + infoHeight;
      const columnIndex = this._getShortestColumnIndex(columnHeights);
      const left = columnIndex * (columnWidth + gap);
      const top = columnHeights[columnIndex];

      positions.set(item.id, {
        top,
        left,
        width: columnWidth,
        height,
        thumbnailHeight
      });

      columnHeights[columnIndex] += height + gap;
    }

    return {
      positions,
      totalHeight: Math.max(0, ...columnHeights) - gap,
      columnWidth,
      gap
    };
  }

  _renderVisibleItems() {
    if (!this._scroller || !this._flow) return;

    const scrollTop = this._scroller.scrollTop;
    const viewportHeight = this._scroller.clientHeight;
    const buffer = 420;
    const minTop = Math.max(0, scrollTop - buffer);
    const maxTop = scrollTop + viewportHeight + buffer;
    const visibleItems = [];

    for (const item of this._items) {
      const pos = this._layout.positions.get(item.id);
      if (!pos) continue;
      if (pos.top + pos.height >= minTop && pos.top <= maxTop) {
        visibleItems.push({ item, pos });
      }
    }

    this._flow.innerHTML = visibleItems.map(({ item, pos }) => this._buildCardHtml(item, pos)).join('');
    this._bindCardEvents();
    this._restoreCardFocus();
  }

  _buildCardHtml(item, pos) {
    const typeLabel = this._getTypeLabel(item);
    const media = this._buildCardMedia(item);
    const importBadge = this._buildImportedStateBadge(item);
    const typeBadgeClass = [
      'ov-sidebar-browser__type-badge',
      item.isImported && this._getAssetType(item) === 'scene' ? 'is-imported-scene' : '',
      item.isImported && this._getAssetType(item) === 'item' ? 'is-imported-item' : ''
    ].filter(Boolean).join(' ');

    return `
      <article
        class="ov-sidebar-browser__card"
        data-item-id="${this._escapeHtml(item.id)}"
        draggable="true"
        style="left:${pos.left}px; top:${pos.top}px; width:${pos.width}px; height:${pos.height}px;"
      >
        <div class="ov-sidebar-browser__card-media" style="height:${pos.thumbnailHeight}px;">
          <span class="${typeBadgeClass}">${this._escapeHtml(typeLabel)}</span>
          ${importBadge}
          ${media}
        </div>
        <div class="ov-sidebar-browser__card-info">
          <h4 title="${this._escapeHtml(this._getDisplayName(item))}">${this._escapeHtml(this._getDisplayName(item))}</h4>
        </div>
      </article>
    `;
  }

  _buildCardMedia(item) {
    const previewKind = this._getPreviewKind(item);
    const previewSrc = this._getPreviewImage(item);

    if (previewSrc) {
      return `<img src="${this._escapeHtml(previewSrc)}" alt="${this._escapeHtml(this._getDisplayName(item))}" loading="lazy">`;
    }

    const icon = previewKind === 'audio'
      ? 'fa-music'
      : previewKind === 'video'
        ? 'fa-film'
        : previewKind === 'scene'
          ? 'fa-map'
          : previewKind === 'item'
            ? 'fa-scroll'
            : previewKind === 'actor'
              ? 'fa-user'
              : 'fa-image';

    return `
      <div class="ov-sidebar-browser__media-fallback">
        <i class="fas ${icon}"></i>
      </div>
    `;
  }

  _bindCardEvents() {
    if (!this._flow) return;

    this._flow.querySelectorAll('.ov-sidebar-browser__card').forEach((card) => {
      const itemId = card.dataset.itemId;
      if (!itemId) return;

      card.addEventListener('mouseenter', () => {
        this._schedulePreview(itemId);
      });

      card.addEventListener('mousemove', (event) => {
        this._onCardHoverMove(event, itemId);
      });

      card.addEventListener('mouseleave', () => {
        this._scheduleHidePreview();
      });

      card.addEventListener('dblclick', (event) => {
        this._onCardDoubleClick(event, itemId);
      });

      card.addEventListener('contextmenu', (event) => {
        this._onCardContextMenu(event, itemId);
      });

      card.addEventListener('dragstart', (event) => {
        this._onCardDragStart(event, itemId);
      });

      card.addEventListener('dragend', () => {
        this._hidePreview();
      });
    });
  }

  _buildImportedStateBadge(item) {
    const type = this._getAssetType(item);
    if (type !== 'scene' && type !== 'item') return '';
    if (!item.isImported) return '';

    const labelKey = type === 'scene'
      ? 'origin-vault.fileTypes.importedScene'
      : 'origin-vault.fileTypes.importedItem';
    const fallbackKey = type === 'scene'
      ? 'origin-vault.scenes.reimport'
      : 'origin-vault.items.openItemSheet';
    const label = hasTranslation(labelKey)
      ? t(labelKey)
      : t(fallbackKey);

    return `
      <span class="ov-sidebar-browser__import-badge" title="${this._escapeHtml(label)}" aria-label="${this._escapeHtml(label)}">
        <i class="fas fa-circle-check"></i>
      </span>
    `;
  }

  async _onCardDoubleClick(event, itemId) {
    event.preventDefault();
    event.stopPropagation();

    const item = this._itemsById.get(itemId);
    if (!item) return;

    if (this._getAssetType(item) === 'item') {
      await this._openItemFromSidebar(item);
    }
  }

  _onCardContextMenu(event, itemId) {
    event.preventDefault();
    event.stopPropagation();

    const item = this._itemsById.get(itemId);
    if (!item) return;

    const actions = this._buildCardContextActions(item);
    if (!actions.length) return;

    this._hidePreview();
    this._showCardContextMenu(event, actions);
  }

  _buildCardContextActions(item) {
    const type = this._getAssetType(item);
    if (type === 'scene') {
      return this._buildSceneContextActions(item);
    }
    if (type === 'item') {
      return this._buildItemContextActions(item);
    }
    return [];
  }

  _buildSceneContextActions(item) {
    const importState = this._resolveImportState(item, { type: 'scene' });
    const actions = [];

    if (importState.imported && importState.worldDoc) {
      actions.push({
        icon: 'fa-eye',
        label: t('origin-vault.scenes.viewScene'),
        onClick: async () => {
          await importState.worldDoc.view();
        }
      });
      actions.push({
        icon: 'fa-bolt',
        label: t('origin-vault.scenes.activateScene'),
        onClick: async () => {
          await importState.worldDoc.activate();
          ui.notifications.info(t('origin-vault.scenes.activateSuccess'));
        }
      });
    }

    actions.push({
      icon: 'fa-download',
      label: t(importState.imported ? 'origin-vault.scenes.reimport' : 'origin-vault.scenes.importToWorld'),
      onClick: async () => {
        await this._importSceneFromSidebar(item);
      }
    });

    return actions;
  }

  _buildItemContextActions(item) {
    const importState = this._resolveImportState(item, { type: 'item' });
    const actions = [];

    if (importState.imported && (importState.worldUuid || importState.sourceUuid)) {
      actions.push({
        icon: 'fa-up-right-from-square',
        label: t('origin-vault.items.openItemSheet'),
        onClick: async () => {
          await this._openItemFromSidebar(item);
        }
      });
    }

    if (!importState.imported && importState.sourceUuid) {
      actions.push({
        icon: 'fa-download',
        label: t('origin-vault.items.importToWorld'),
        onClick: async () => {
          await this._importItemFromSidebar(item);
        }
      });
    }

    return actions;
  }

  _showCardContextMenu(event, actions) {
    this._hideCardContextMenu();

    const menu = document.createElement('div');
    menu.id = CONTEXT_MENU_ID;
    menu.className = 'ov-sidebar-browser__context-menu';

    for (const action of actions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ov-sidebar-browser__context-menu-item';
      button.innerHTML = `
        <i class="fas ${this._escapeHtml(action.icon || 'fa-circle')}"></i>
        <span>${this._escapeHtml(action.label || '')}</span>
      `;
      button.addEventListener('click', async (clickEvent) => {
        clickEvent.preventDefault();
        clickEvent.stopPropagation();
        this._hideCardContextMenu();
        await action.onClick?.();
      });
      menu.appendChild(button);
    }

    document.body.appendChild(menu);
    this._contextMenuEl = menu;
    this._positionCardContextMenu(event.clientX, event.clientY);
  }

  _positionCardContextMenu(clientX, clientY) {
    if (!this._contextMenuEl) return;

    const width = this._contextMenuEl.offsetWidth || 180;
    const height = this._contextMenuEl.offsetHeight || 40;
    const left = Math.max(8, Math.min(clientX, window.innerWidth - width - 8));
    const top = Math.max(8, Math.min(clientY, window.innerHeight - height - 8));

    this._contextMenuEl.style.left = `${Math.round(left)}px`;
    this._contextMenuEl.style.top = `${Math.round(top)}px`;
  }

  _hideCardContextMenu() {
    if (!this._contextMenuEl) return;
    this._contextMenuEl.remove();
    this._contextMenuEl = null;
  }

  _restoreCardFocus() {
    const itemId = this._pendingFocusItemId || this._focusedItemId;
    if (!itemId || !this._scroller || !this._flow) return;

    const pos = this._layout.positions.get(itemId);
    if (!pos) return;

    if (this._pendingFocusItemId) {
      const viewportTop = this._scroller.scrollTop;
      const viewportBottom = viewportTop + this._scroller.clientHeight;
      const padding = 18;
      let nextScrollTop = viewportTop;

      if (pos.top < viewportTop + padding) {
        nextScrollTop = Math.max(0, pos.top - padding);
      } else if (pos.top + pos.height > viewportBottom - padding) {
        nextScrollTop = Math.max(0, pos.top + pos.height - this._scroller.clientHeight + padding);
      }

      if (Math.abs(nextScrollTop - viewportTop) > 1) {
        this._scroller.scrollTop = nextScrollTop;
        this._currentScrollTop = nextScrollTop;
        this._renderVisibleItems();
        return;
      }

      this._pendingFocusItemId = null;
    }

    const card = this._flow.querySelector(`.ov-sidebar-browser__card[data-item-id="${itemId}"]`);
    if (!(card instanceof HTMLElement)) return;

    card.classList.add('is-focused');
    this._focusedItemId = itemId;
    if (this._focusClearTimer) {
      clearTimeout(this._focusClearTimer);
    }
    this._focusClearTimer = setTimeout(() => {
      card.classList.remove('is-focused');
      if (this._focusedItemId === itemId) {
        this._focusedItemId = null;
      }
      this._focusClearTimer = null;
    }, 1400);
  }

  async _openItemFromSidebar(item) {
    const importState = this._resolveImportState(item, { type: 'item' });
    const sourceUuid = importState.worldUuid || importState.sourceUuid;
    if (!sourceUuid) return;

    const bridge = this._getMainWindowBridge(item);
    if (importState.imported && importState.worldUuid && typeof bridge._openWorldItemWithSync === 'function') {
      await bridge._openWorldItemWithSync(importState.worldUuid);
      return;
    }

    if (typeof bridge._openNativeItemSheet === 'function') {
      await bridge._openNativeItemSheet(sourceUuid);
    }
  }

  async _importItemFromSidebar(item) {
    const importState = this._resolveImportState(item, { type: 'item' });
    if (!importState.sourceUuid) return;

    const bridge = this._getMainWindowBridge(item);
    if (typeof bridge._importItemToWorld === 'function') {
      await bridge._importItemToWorld(importState.sourceUuid);
      this._onWorldCollectionChanged('item');
    }
  }

  async _importSceneFromSidebar(item) {
    const bridge = this._getMainWindowBridge(item);
    if (typeof bridge._importSceneFromDetailsItem === 'function') {
      await bridge._importSceneFromDetailsItem(item.id, item);
      this._onWorldCollectionChanged('scene');
    }
  }

  _getMainWindowBridge(item = null) {
    const bridge = MainWindow.getInstance();
    bridge.library = LibraryData.getInstance();
    bridge.currentFolderId = item?.folders?.find((folderId) => !SPECIAL_FOLDER_IDS.has(folderId))
      || this.state.currentFolderId
      || SPECIAL_FOLDERS.ALL;
    bridge.selectedItems = new Set(item?.id ? [item.id] : []);
    bridge.previewItem = item || null;
    return bridge;
  }

  _schedulePreview(itemId) {
    window.clearTimeout(this._hidePreviewTimer);
    window.clearTimeout(this._hoverTimer);

    const hoverDelay = Math.max(80, Number(LibraryData.getInstance()?.getSetting?.('hoverDelay') ?? 200));
    this._hoverTimer = window.setTimeout(() => {
      this._showPreview(itemId);
    }, hoverDelay);
  }

  _scheduleHidePreview() {
    window.clearTimeout(this._hoverTimer);
    window.clearTimeout(this._hidePreviewTimer);
    this._hidePreviewTimer = window.setTimeout(() => this._hidePreview(), 100);
  }

  _onCardHoverMove(event, itemId) {
    if (!this._activePreview || this._activePreview.itemId !== itemId) return;

    this._positionPreview();

    if (this._activePreview.kind === 'video' || this._activePreview.kind === 'audio') {
      this._scrubActivePreview(event, event.currentTarget);
    }
  }

  async _showPreview(itemId) {
    const item = this._itemsById.get(itemId);
    if (!item || !this._previewEl || !this._sidebarRoot || !this._isActive()) return;

    if (this._activePreview?.itemId === itemId) {
      this._positionPreview();
      return;
    }

    this._hidePreview();

    const state = {
      token: ++this._previewToken,
      itemId,
      item,
      kind: this._getPreviewKind(item),
      mediaEl: null,
      timeEl: null,
      progressFillEl: null,
      playheadEl: null,
      unplayedOverlayEl: null
    };
    this._activePreview = state;

    if (state.kind === 'scene') {
      await this._showScenePreview(state);
    } else if (state.kind === 'audio') {
      await this._showAudioPreview(state);
    } else if (state.kind === 'video') {
      this._showVideoPreview(state);
    } else {
      this._showStaticPreview(state);
    }

    if (!this._activePreview || this._activePreview.token !== state.token || !this._previewEl) return;

    requestAnimationFrame(() => {
      if (!this._activePreview || this._activePreview.token !== state.token || !this._previewEl) return;
      this._positionPreview();
      this._previewEl.classList.add('is-visible');
    });
  }

  _hidePreview() {
    window.clearTimeout(this._hoverTimer);
    window.clearTimeout(this._hidePreviewTimer);

    if (this._activePreview?.mediaEl) {
      try {
        this._activePreview.mediaEl.pause();
      } catch (_err) {}
    }

    this._destroyHoverSceneRenderer();
    this._activePreview = null;

    if (!this._previewEl) return;
    this._previewEl.classList.remove('is-visible');
    this._previewEl.innerHTML = '';
  }

  _positionPreview() {
    if (!this._previewEl || !this._sidebarRoot) return;

    const rect = this._sidebarRoot.getBoundingClientRect();
    const previewRect = this._previewEl.getBoundingClientRect();
    const previewWidth = Math.max(280, previewRect.width || Math.min(720, window.innerWidth * 0.52));
    const previewHeight = Math.max(160, previewRect.height || Math.min(520, window.innerHeight * 0.72));
    let left = rect.left - previewWidth - 12;
    let top = 12;

    if (left < 12) {
      left = 12;
    }

    if (top + previewHeight > window.innerHeight - 12) {
      top = Math.max(12, window.innerHeight - previewHeight - 12);
    }

    this._previewEl.style.left = `${Math.round(left)}px`;
    this._previewEl.style.top = `${Math.round(top)}px`;
  }

  _showStaticPreview(state) {
    const item = state.item;
    const previewSrc = this._getPreviewImage(item) || item.path || '';
    const box = this._getMediaPreviewBox(item);
    const tags = this._getPreviewTags(item);
    const mediaHtml = previewSrc
      ? `<img src="${this._escapeHtml(previewSrc)}" alt="${this._escapeHtml(this._getDisplayName(item))}">`
      : `
        <div class="ov-sidebar-browser__preview-fallback">
          <i class="fas ${this._getPreviewIcon(item)}"></i>
        </div>
      `;

    this._previewEl.innerHTML = `
      <div
        class="ov-sidebar-browser__preview-card ov-sidebar-browser__preview-card--static"
        style="--ov-sidebar-preview-width:${box.width}px; --ov-sidebar-preview-height:${box.height}px;"
      >
        <div class="ov-sidebar-browser__preview-media">${mediaHtml}</div>
        <div class="ov-sidebar-browser__preview-meta">
          <span class="ov-sidebar-browser__preview-type">${this._escapeHtml(this._getTypeLabel(item))}</span>
          <h3>${this._escapeHtml(this._getDisplayName(item))}</h3>
          <p>${this._escapeHtml(this._getPreviewSubtitle(item))}</p>
          ${tags.length > 0 ? `
            <div class="ov-sidebar-browser__preview-tags">
              ${tags.map((tag) => `<span>${this._escapeHtml(tag)}</span>`).join('')}
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  _showVideoPreview(state) {
    const item = state.item;
    const box = this._getMediaPreviewBox(item, { defaultRatio: 16 / 9 });
    const tags = this._getPreviewTags(item);

    this._previewEl.innerHTML = `
      <div
        class="ov-sidebar-browser__preview-card ov-sidebar-browser__preview-card--video"
        style="--ov-sidebar-preview-width:${box.width}px; --ov-sidebar-preview-height:${box.height}px;"
      >
        <div class="ov-sidebar-browser__preview-media ov-sidebar-browser__preview-media--video">
          <video src="${this._escapeHtml(item.path)}" muted autoplay loop playsinline preload="metadata"></video>
          <div class="ov-sidebar-browser__preview-progress">
            <div class="ov-sidebar-browser__preview-progress-fill"></div>
          </div>
          <div class="ov-sidebar-browser__preview-time">0:00</div>
        </div>
        <div class="ov-sidebar-browser__preview-meta">
          <span class="ov-sidebar-browser__preview-type">${this._escapeHtml(this._getTypeLabel(item))}</span>
          <h3>${this._escapeHtml(this._getDisplayName(item))}</h3>
          <p>${this._escapeHtml(this._getPreviewSubtitle(item))}</p>
          ${tags.length > 0 ? `
            <div class="ov-sidebar-browser__preview-tags">
              ${tags.map((tag) => `<span>${this._escapeHtml(tag)}</span>`).join('')}
            </div>
          ` : ''}
        </div>
      </div>
    `;

    state.mediaEl = this._previewEl.querySelector('video');
    state.timeEl = this._previewEl.querySelector('.ov-sidebar-browser__preview-time');
    state.progressFillEl = this._previewEl.querySelector('.ov-sidebar-browser__preview-progress-fill');

    state.mediaEl?.addEventListener('loadedmetadata', () => {
      if (!this._activePreview || this._activePreview.token !== state.token) return;
      state.mediaEl.currentTime = 0;
      this._updateActivePreviewProgress(state);
      this._positionPreview();
    });

    state.mediaEl?.addEventListener('timeupdate', () => {
      if (!this._activePreview || this._activePreview.token !== state.token) return;
      this._updateActivePreviewProgress(state);
    });
  }

  async _showAudioPreview(state) {
    const item = state.item;
    const tags = this._getPreviewTags(item);

    this._previewEl.innerHTML = `
      <div class="ov-sidebar-browser__preview-card ov-sidebar-browser__preview-card--audio">
        <div class="ov-sidebar-browser__preview-media ov-sidebar-browser__preview-media--audio">
          <canvas class="ov-sidebar-browser__audio-waveform" width="640" height="180"></canvas>
          <div class="ov-sidebar-browser__audio-unplayed"></div>
          <div class="ov-sidebar-browser__audio-playhead"></div>
          <div class="ov-sidebar-browser__preview-time">0:00</div>
          <audio src="${this._escapeHtml(item.path)}" autoplay loop preload="metadata"></audio>
        </div>
        <div class="ov-sidebar-browser__preview-meta">
          <span class="ov-sidebar-browser__preview-type">${this._escapeHtml(this._getTypeLabel(item))}</span>
          <h3>${this._escapeHtml(this._getDisplayName(item))}</h3>
          <p>${this._escapeHtml(this._getPreviewSubtitle(item))}</p>
          ${tags.length > 0 ? `
            <div class="ov-sidebar-browser__preview-tags">
              ${tags.map((tag) => `<span>${this._escapeHtml(tag)}</span>`).join('')}
            </div>
          ` : ''}
        </div>
      </div>
    `;

    state.mediaEl = this._previewEl.querySelector('audio');
    state.timeEl = this._previewEl.querySelector('.ov-sidebar-browser__preview-time');
    state.playheadEl = this._previewEl.querySelector('.ov-sidebar-browser__audio-playhead');
    state.unplayedOverlayEl = this._previewEl.querySelector('.ov-sidebar-browser__audio-unplayed');

    const canvas = this._previewEl.querySelector('.ov-sidebar-browser__audio-waveform');
    if (canvas) {
      try {
        const waveformData = await WaveformManager.getInstance().getWaveform(item.path, item.id);
        if (this._activePreview?.token === state.token) {
          WaveformManager.getInstance().drawWaveform(canvas, waveformData);
        }
      } catch (error) {
        console.warn(`${MODULE_ID} | Failed to draw sidebar audio preview waveform:`, error);
      }
    }

    state.mediaEl?.addEventListener('loadedmetadata', () => {
      if (!this._activePreview || this._activePreview.token !== state.token) return;
      state.mediaEl.currentTime = 0;
      this._updateActivePreviewProgress(state);
      this._positionPreview();
    });

    state.mediaEl?.addEventListener('timeupdate', () => {
      if (!this._activePreview || this._activePreview.token !== state.token) return;
      this._updateActivePreviewProgress(state);
    });
  }

  async _showScenePreview(state) {
    const item = state.item;
    const sceneData = await this._getScenePreviewData(item);

    if (!sceneData || !this._activePreview || this._activePreview.token !== state.token) {
      if (this._activePreview?.token === state.token) {
        this._showStaticPreview(state);
      }
      return;
    }

    const tags = this._getPreviewTags(item);
    const box = this._getScenePreviewBox(sceneData);

    this._previewEl.innerHTML = `
      <div
        class="ov-sidebar-browser__preview-card ov-sidebar-browser__preview-card--scene"
        style="--ov-sidebar-preview-width:${box.width}px; --ov-sidebar-preview-height:${box.height}px;"
      >
        <div class="ov-sidebar-browser__preview-media ov-sidebar-browser__preview-media--scene">
          <div class="ov-sidebar-browser__preview-scene-canvas" style="width:${box.width}px; height:${box.height}px;"></div>
        </div>
        <div class="ov-sidebar-browser__preview-meta">
          <span class="ov-sidebar-browser__preview-type">${this._escapeHtml(this._getTypeLabel(item))}</span>
          <h3>${this._escapeHtml(this._getDisplayName(item))}</h3>
          <p>${this._escapeHtml(this._getPreviewSubtitle(item))}</p>
          ${tags.length > 0 ? `
            <div class="ov-sidebar-browser__preview-tags">
              ${tags.map((tag) => `<span>${this._escapeHtml(tag)}</span>`).join('')}
            </div>
          ` : ''}
        </div>
      </div>
    `;

    const container = this._previewEl.querySelector('.ov-sidebar-browser__preview-scene-canvas');
    if (!container) return;

    this._destroyHoverSceneRenderer();
    this._hoverSceneRenderer = new SceneRenderer(container, sceneData, {
      interactive: false,
      showWalls: false,
      showLights: false,
      levelId: SceneRenderer.getDefaultLevelId(sceneData),
      minResolution: 1024
    });

    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (!this._activePreview || this._activePreview.token !== state.token || !this._hoverSceneRenderer) return;

    await this._hoverSceneRenderer.render();
    if (!this._activePreview || this._activePreview.token !== state.token) return;

    this._positionPreview();
  }

  _scrubActivePreview(event, cardEl) {
    const state = this._activePreview;
    const mediaEl = state?.mediaEl;
    if (!state || !mediaEl || !mediaEl.duration || Number.isNaN(mediaEl.duration) || !(cardEl instanceof HTMLElement)) return;

    const rect = cardEl.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, x / rect.width));
    const targetTime = mediaEl.duration * pct;

    if (Math.abs(mediaEl.currentTime - targetTime) > 0.08) {
      mediaEl.currentTime = targetTime;
    }
    this._updateActivePreviewProgress(state);
  }

  _updateActivePreviewProgress(state) {
    const mediaEl = state?.mediaEl;
    if (!mediaEl || !mediaEl.duration || Number.isNaN(mediaEl.duration)) return;

    const pct = Math.max(0, Math.min(1, mediaEl.currentTime / mediaEl.duration));

    if (state.timeEl) {
      state.timeEl.textContent = this._formatTime(mediaEl.currentTime);
    }
    if (state.progressFillEl) {
      state.progressFillEl.style.width = `${pct * 100}%`;
    }
    if (state.playheadEl) {
      state.playheadEl.style.left = `${pct * 100}%`;
    }
    if (state.unplayedOverlayEl) {
      state.unplayedOverlayEl.style.left = `${pct * 100}%`;
    }
  }

  async _getScenePreviewData(item) {
    try {
      const worldSceneId = item.worldSceneId || getWorldSceneId(item, { library: LibraryData.getInstance() });
      if (worldSceneId) {
        const worldScene = game.scenes?.get(worldSceneId);
        if (worldScene) return worldScene.toObject();
      }

      const uuid = item.metadata?.uuid || item.uuid;
      if (uuid) {
        const doc = await fromUuid(uuid);
        if (doc) return doc.toObject();
      }

      if (item.metadata?.compendiumId && item.id) {
        const pack = game.packs?.get(item.metadata.compendiumId);
        if (pack) {
          const doc = await pack.getDocument(item.id);
          if (doc) return doc.toObject();
        }
      }

      if (item.sceneData) return item.sceneData;
    } catch (error) {
      console.warn(`${MODULE_ID} | Failed to get sidebar scene preview data:`, error);
    }

    return null;
  }

  _getMediaPreviewBox(item, { defaultRatio = 16 / 10 } = {}) {
    const rawWidth = Number(item.metadata?.width) || 0;
    const rawHeight = Number(item.metadata?.height) || 0;
    const aspectRatio = rawWidth > 0 && rawHeight > 0
      ? rawWidth / rawHeight
      : this._getAspectRatio(item) || defaultRatio;
    const maxWidth = Math.min(920, Math.floor(window.innerWidth * 0.62));
    const maxHeight = Math.min(720, Math.floor(window.innerHeight * 0.7));

    let width = rawWidth > 0 ? rawWidth : Math.round(aspectRatio >= 1 ? 760 : 540);
    let height = rawHeight > 0 ? rawHeight : Math.round(width / aspectRatio);

    const scale = Math.min(maxWidth / width, maxHeight / height, 1);
    width = Math.round(width * scale);
    height = Math.round(height * scale);

    return {
      width: Math.max(220, width),
      height: Math.max(160, height)
    };
  }

  _getScenePreviewBox(sceneData) {
    const sceneWidth = Number(sceneData?.width) || 1000;
    const sceneHeight = Number(sceneData?.height) || 1000;
    const maxWidth = Math.min(980, Math.floor(window.innerWidth * 0.62));
    const maxHeight = Math.min(700, Math.floor(window.innerHeight * 0.62));
    const scale = Math.min(maxWidth / sceneWidth, maxHeight / sceneHeight, 1);

    return {
      width: Math.max(280, Math.round(sceneWidth * scale)),
      height: Math.max(180, Math.round(sceneHeight * scale))
    };
  }

  _getPreviewTags(item) {
    return (item.tags || [])
      .map((tagId) => this._getTagName(tagId))
      .filter(Boolean)
      .slice(0, 5);
  }

  _getPreviewIcon(item) {
    const previewKind = this._getPreviewKind(item);
    return previewKind === 'audio'
      ? 'fa-music'
      : previewKind === 'video'
        ? 'fa-film'
        : previewKind === 'scene'
          ? 'fa-map'
          : previewKind === 'item'
            ? 'fa-scroll'
            : previewKind === 'actor'
              ? 'fa-user'
              : 'fa-image';
  }

  _destroyHoverSceneRenderer() {
    if (!this._hoverSceneRenderer) return;

    try {
      this._hoverSceneRenderer.destroy();
    } catch (_err) {}
    this._hoverSceneRenderer = null;
  }

  _onCardDragStart(event, itemId) {
    const item = this._itemsById.get(itemId);
    if (!item) return;

    const dragData = this._buildDragData(item);
    if (!dragData) return;

    const dataString = JSON.stringify(dragData);
    event.dataTransfer.setData('text/plain', dataString);
    if (dragData.type === 'origin-vault-item') {
      event.dataTransfer.setData('application/x-origin-vault-item', dataString);
    }

    const previewImage = event.currentTarget.querySelector('img');
    if (previewImage) {
      const dragImage = previewImage.cloneNode(true);
      dragImage.style.width = '96px';
      dragImage.style.height = '96px';
      dragImage.style.objectFit = 'contain';
      dragImage.style.borderRadius = '10px';
      dragImage.style.position = 'absolute';
      dragImage.style.left = '-9999px';
      dragImage.style.top = '-9999px';
      document.body.appendChild(dragImage);
      event.dataTransfer.setDragImage(dragImage, 48, 48);
      event.currentTarget.addEventListener('dragend', () => dragImage.remove(), { once: true });
    }
  }

  _buildDragData(item) {
    const type = item.metadata?.type || item.type;

    if (type === 'item' && item.metadata?.uuid) {
      const sourceUuid = item.metadata.uuid;
      const worldItem = game.items?.find((doc) =>
        doc.flags?.core?.sourceId === sourceUuid
        || doc._stats?.compendiumSource === sourceUuid
      );

      return {
        type: 'Item',
        uuid: worldItem?.uuid || sourceUuid
      };
    }

    if (type === 'actor' && item.metadata?.uuid) {
      const sourceUuid = item.metadata.uuid;
      const worldActor = game.actors?.find((doc) =>
        doc.flags?.core?.sourceId === sourceUuid
        || doc._stats?.compendiumSource === sourceUuid
      );

      return {
        type: 'Actor',
        uuid: worldActor?.uuid || sourceUuid
      };
    }

    return {
      type: 'origin-vault-item',
      itemId: item.id,
      originVault: {
        type: 'origin-vault-items',
        itemIds: [item.id],
        sourceFolderId: this.state.currentFolderId
      },
      img: item.path,
      texture: { src: item.path }
    };
  }

  _onScroll() {
    if (!this._scroller) return;
    this._currentScrollTop = this._scroller.scrollTop;
    if (this._scrollFrame) return;

    this._scrollFrame = requestAnimationFrame(() => {
      this._scrollFrame = null;
      this._renderVisibleItems();
    });
  }

  _onViewportResize() {
    this._positionPreview();
    this._hideCardContextMenu();
    if (this._isActive()) {
      this._updateLayout({ scrollTop: this._currentScrollTop });
    }
  }

  _observePanelResize() {
    if (!this._panel || typeof ResizeObserver !== 'function') return;

    if (!this._resizeObserver) {
      this._resizeObserver = new ResizeObserver(() => {
        if (!this._isActive()) return;
        this._updateLayout({ scrollTop: this._scroller?.scrollTop ?? this._currentScrollTop ?? 0 });
        this._positionPreview();
      });
    }

    this._resizeObserver.disconnect();
    this._resizeObserver.observe(this._panel);
  }

  _detachScroller() {
    if (this._scroller) {
      this._currentScrollTop = this._scroller.scrollTop;
      this._scroller.removeEventListener('scroll', this._boundOnScroll);
    }
    if (this._scrollFrame) {
      cancelAnimationFrame(this._scrollFrame);
      this._scrollFrame = null;
    }
    this._scroller = null;
    this._flow = null;
    this._items = [];
    this._itemsById.clear();
    this._layout = {
      positions: new Map(),
      totalHeight: 0,
      columnWidth: 0,
      gap: 10
    };
    this._lastLayoutWidth = 0;
  }

  _scheduleRefresh({ preserveScroll = true } = {}) {
    if (!this.initialized) return;

    window.clearTimeout(this._refreshTimer);
    this._refreshTimer = window.setTimeout(() => {
      if (this._panel) {
        this._renderPanel({ preserveScroll });
      }
    }, 40);
  }

  async _ensureLibraryReady() {
    const libraryManager = LibraryManager.getInstance();
    const activeLibrary = libraryManager.getActiveLibrary?.() ?? null;
    if (!activeLibrary) return null;

    const library = LibraryData.getInstance();
    if (library.basePath !== activeLibrary.path) {
      library.setLibraryPath(activeLibrary.path);
    }

    if (!library.loaded) {
      if (!this._loadPromise) {
        this._loadPromise = library.load().finally(() => {
          this._loadPromise = null;
        });
      }
      await this._loadPromise;
    }

    return library.loaded ? library : null;
  }

  _ensurePreviewHost() {
    let previewEl = document.getElementById(PREVIEW_ID);
    if (!previewEl) {
      previewEl = document.createElement('div');
      previewEl.id = PREVIEW_ID;
      previewEl.className = 'ov-sidebar-browser__preview-host';
      document.body.appendChild(previewEl);
    }
    this._previewEl = previewEl;
  }

  _onDocumentPointerDown(event) {
    const target = event.target;

    if (this._contextMenuEl && target instanceof Node && !this._contextMenuEl.contains(target)) {
      this._hideCardContextMenu();
    }

    if (this._panel && target instanceof Node) {
      const clickedInsidePanel = this._panel.contains(target);
      const clickedTabButton = this._tabButton?.contains(target);

      if (!clickedInsidePanel && !clickedTabButton) {
        if (this.state.folderOpen || this.state.searchOpen || this.state.filterOpen) {
          this._closePopovers();
          if (this._isActive()) {
            this._renderPanel({ preserveScroll: true });
          }
        }
      }
    }
  }

  _onDocumentKeyDown(event) {
    if (event.key !== 'Escape') return;

    if (this._contextMenuEl) {
      this._hideCardContextMenu();
      return;
    }

    if (this.state.folderOpen || this.state.searchOpen || this.state.filterOpen) {
      this._closePopovers();
      if (this._isActive()) {
        this._renderPanel({ preserveScroll: true });
      }
      return;
    }

    if (this._previewEl?.classList.contains('is-visible')) {
      this._hidePreview();
    }
  }

  _closePopovers() {
    this.state.folderOpen = false;
    this.state.searchOpen = false;
    this.state.filterOpen = false;
  }

  _onWorldCollectionChanged(type) {
    this._invalidateImportStateCache(type);
    this._scheduleRefresh({ preserveScroll: true });
  }

  _hydrateImportState(items) {
    if (!Array.isArray(items) || !items.length) return;

    for (const item of items) {
      const type = this._getAssetType(item);
      if (type !== 'scene' && type !== 'item') continue;

      const importState = this._getCardImportState(item, type);
      item.isImported = importState.imported;

      if (type === 'scene') {
        item.worldId = importState.worldId || null;
      }

      if (type === 'item') {
        item.isItemImported = importState.imported;
        item.worldItemUuid = importState.worldUuid || item.worldItemUuid || null;
      }
    }
  }

  _findSceneLibraryItem(viewedScene, library) {
    const viewedBg = viewedScene.background?.src || viewedScene.background?.texture?.src || viewedScene.img || '';
    const compendiumSource = viewedScene._stats?.compendiumSource || viewedScene.flags?.core?.sourceId || '';

    for (const item of library.itemsCache?.values?.() || []) {
      if (this._getAssetType(item) !== 'scene') continue;

      const itemName = (item.metadata?.sceneName || item.displayName || item.name || '').trim();
      if (getWorldSceneId(item, { library }) === viewedScene.id) return item;
      if (item.worldId && item.worldId === viewedScene.id) return item;
      if (compendiumSource && this._getAssetUuid(item) === compendiumSource) return item;
      if (viewedBg && item.metadata?.backgroundSrc && item.metadata.backgroundSrc === viewedBg) return item;
      if (viewedBg && item.path === viewedBg) return item;
      if (
        itemName === viewedScene.name
        && Number(item.metadata?.width) === Number(viewedScene.width)
        && Number(item.metadata?.height) === Number(viewedScene.height)
      ) {
        return item;
      }
    }

    return null;
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
        : null;

    return collection?.find((doc) => this._getWorldDocumentSource(doc) === sourceUuid) || null;
  }

  _resolveImportState(target = null, { type = null, uuid = null } = {}) {
    const resolvedType = type || this._getAssetType(target);
    const sourceUuid = uuid ?? this._getAssetUuid(target);

    if (resolvedType === 'scene') {
      const persistedWorldSceneId = getWorldSceneId(target, { library: LibraryData.getInstance() });
      if (persistedWorldSceneId) {
        const worldDoc = game.scenes?.get(persistedWorldSceneId) || null;
        if (worldDoc) {
          return {
            imported: true,
            worldId: worldDoc.id,
            worldUuid: worldDoc.uuid,
            worldDoc,
            sourceUuid,
            type: resolvedType
          };
        }
      }
    }

    const worldDoc = this._findWorldDocumentBySource(resolvedType, sourceUuid);
    if (worldDoc) {
      return {
        imported: true,
        worldId: worldDoc.id,
        worldUuid: worldDoc.uuid,
        worldDoc,
        sourceUuid,
        type: resolvedType
      };
    }

    if (resolvedType === 'scene') {
      const sceneName = (target?.metadata?.sceneName || target?.displayName || target?.name || '').trim().toLowerCase();
      if (sceneName) {
        const sceneByName = game.scenes?.find((scene) => scene.name?.trim?.().toLowerCase() === sceneName) || null;
        if (sceneByName) {
          return {
            imported: true,
            worldId: sceneByName.id,
            worldUuid: sceneByName.uuid,
            worldDoc: sceneByName,
            sourceUuid,
            type: resolvedType
          };
        }
      }
    }

    return {
      imported: false,
      worldId: null,
      worldUuid: null,
      worldDoc: null,
      sourceUuid,
      type: resolvedType
    };
  }

  _getCardImportState(item, type = null) {
    const resolvedType = type || this._getAssetType(item);
    if (resolvedType === 'scene') {
      const persistedWorldSceneId = getWorldSceneId(item, { library: LibraryData.getInstance() });
      if (persistedWorldSceneId && game.scenes?.get(persistedWorldSceneId)) {
        const worldDoc = game.scenes.get(persistedWorldSceneId);
        return {
          imported: true,
          worldId: worldDoc.id,
          worldUuid: worldDoc.uuid
        };
      }

      this._ensureImportedSceneCache();
      const sourceUuid = this._getAssetUuid(item);
      if (sourceUuid && this._importedSceneUuids?.has(sourceUuid)) {
        return { imported: true, worldId: persistedWorldSceneId || null, worldUuid: null };
      }

      const sceneName = (item?.metadata?.sceneName || item?.displayName || item?.name || '').trim().toLowerCase();
      if (sceneName && this._importedSceneNames?.has(sceneName)) {
        return { imported: true, worldId: persistedWorldSceneId || null, worldUuid: null };
      }

      return { imported: false, worldId: null, worldUuid: null };
    }

    if (resolvedType === 'item') {
      this._ensureImportedItemCache();
      const sourceUuid = this._getAssetUuid(item);
      if (sourceUuid && this._importedItemUuids?.has(sourceUuid)) {
        return { imported: true, worldId: null, worldUuid: item?.worldItemUuid || null };
      }
    }

    return { imported: false, worldId: null, worldUuid: null };
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
    game.scenes?.forEach((scene) => {
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
    game.items?.forEach((item) => {
      const sourceUuid = this._getWorldDocumentSource(item);
      if (sourceUuid) this._importedItemUuids.add(sourceUuid);
    });

    if (this._importedItemCacheTimer) clearTimeout(this._importedItemCacheTimer);
    this._importedItemCacheTimer = setTimeout(() => this._invalidateImportStateCache('item'), 30000);
  }

  _buildFolderOptions(library) {
    const options = [
      {
        id: SPECIAL_FOLDERS.ALL,
        name: t('origin-vault.folders.all'),
        icon: 'fa-layer-group',
        count: library.getItemCountByFolder(SPECIAL_FOLDERS.ALL),
        depth: 0
      },
      {
        id: SPECIAL_FOLDERS.FAVORITES,
        name: t('origin-vault.folders.favorites'),
        icon: 'fa-star',
        count: library.getItemCountByFolder(SPECIAL_FOLDERS.FAVORITES),
        depth: 0
      },
      {
        id: SPECIAL_FOLDERS.RECENT,
        name: t('origin-vault.folders.recent'),
        icon: 'fa-history',
        count: library.getItemCountByFolder(SPECIAL_FOLDERS.RECENT),
        depth: 0
      },
      {
        id: SPECIAL_FOLDERS.UNCATEGORIZED,
        name: t('origin-vault.folders.uncategorized'),
        icon: 'fa-inbox',
        count: library.getItemCountByFolder(SPECIAL_FOLDERS.UNCATEGORIZED),
        depth: 0
      }
    ];

    const folders = library.getAllFolders();
    const walk = (folderId, depth = 0) => {
      const folder = folders[folderId];
      if (!folder?.children?.length) return;

      for (const childId of folder.children) {
        const child = folders[childId];
        if (!child || SPECIAL_FOLDER_IDS.has(childId)) continue;

        options.push({
          id: childId,
          name: child.name,
          icon: child.icon || 'fa-folder',
          count: library.getItemCountByFolder(childId),
          depth
        });

        walk(childId, depth + 1);
      }
    };

    walk(SPECIAL_FOLDERS.ROOT, 0);
    return options;
  }

  _buildQuickLauncherFolderTree(library) {
    const folders = library.getAllFolders();
    const buildBranch = (folderId) => {
      const folder = folders[folderId];
      if (!folder || SPECIAL_FOLDER_IDS.has(folderId)) return null;

      const children = (folder.children || [])
        .map((childId) => buildBranch(childId))
        .filter(Boolean);

      return {
        id: folderId,
        name: folder.name,
        icon: folder.icon || 'fa-folder',
        count: library.getItemCountByFolder(folderId),
        children
      };
    };

    return (folders[SPECIAL_FOLDERS.ROOT]?.children || [])
      .map((folderId) => buildBranch(folderId))
      .filter(Boolean);
  }

  _isFolderAvailable(library, folderId) {
    if (!folderId) return false;
    if (SPECIAL_FOLDER_IDS.has(folderId)) return true;
    return !!library.getFolder(folderId);
  }

  _getFolderLabel(library, folderId) {
    if (folderId === SPECIAL_FOLDERS.ALL) return t('origin-vault.folders.all');
    if (folderId === SPECIAL_FOLDERS.FAVORITES) return t('origin-vault.folders.favorites');
    if (folderId === SPECIAL_FOLDERS.RECENT) return t('origin-vault.folders.recent');
    if (folderId === SPECIAL_FOLDERS.UNCATEGORIZED) return t('origin-vault.folders.uncategorized');
    return library.getFolder(folderId)?.name || t('origin-vault.folders.all');
  }

  _getFilterTypeOptions() {
    const options = [
      { id: 'image', icon: 'fa-image', label: t('origin-vault.fileTypes.image') },
      { id: 'video', icon: 'fa-film', label: t('origin-vault.fileTypes.video') },
      { id: 'audio', icon: 'fa-music', label: t('origin-vault.fileTypes.audio') },
      { id: 'scene', icon: 'fa-map', label: t('origin-vault.fileTypes.scene') },
      { id: 'item', icon: 'fa-scroll', label: t('origin-vault.fileTypes.item') },
      { id: 'actor', icon: 'fa-user', label: t('origin-vault.fileTypes.actor') }
    ];

    if (IS_MAD_EDITION) {
      return options.filter((option) => option.id === 'scene');
    }

    return options;
  }

  _hasItemSpecificFilters() {
    return typeof globalThis.OriginVault?.getAutoTagGroups === 'function';
  }

  _getItemSpecificGroups(library) {
    const getAutoTagGroups = globalThis.OriginVault?.getAutoTagGroups;
    if (typeof getAutoTagGroups !== 'function') return [];

    try {
      return (getAutoTagGroups(library, this.state.currentFolderId) || []).map((group) => ({
        ...group,
        group: {
          ...group.group,
          label: this._localizeMaybe(group.group?.i18nKey, group.group?.name)
        }
      }));
    } catch (error) {
      console.warn(`${MODULE_ID} | Failed to load sidebar item filter groups:`, error);
      return [];
    }
  }

  _getActiveFilterCount() {
    return this.state.filters.tags.length
      + this.state.filters.excludeTags.length
      + this.state.filters.fileTypes.length;
  }

  _getAspectRatio(item) {
    const ratio = Number(item.aspectRatio)
      || (Number(item.metadata?.width) > 0 && Number(item.metadata?.height) > 0
        ? Number(item.metadata.width) / Number(item.metadata.height)
        : 1);

    return Math.max(0.45, Math.min(2.4, ratio || 1));
  }

  _getShortestColumnIndex(heights) {
    let minIndex = 0;
    let minHeight = heights[0] ?? 0;

    for (let i = 1; i < heights.length; i += 1) {
      if (heights[i] < minHeight) {
        minHeight = heights[i];
        minIndex = i;
      }
    }

    return minIndex;
  }

  _getDisplayName(item) {
    return item.displayName || item.name || item.path?.split('/').pop() || item.id;
  }

  _getTypeLabel(item) {
    const type = item.metadata?.type || item.type;

    if (type === 'scene') {
      return t('origin-vault.fileTypes.scene');
    }

    if (type === 'item') {
      const itemType = item.metadata?.itemType;
      if (itemType && hasTranslation(`TYPES.Item.${itemType}`)) {
        return t(`TYPES.Item.${itemType}`);
      }
      return t('origin-vault.fileTypes.item');
    }

    if (type === 'actor') {
      const actorType = item.metadata?.actorType;
      if (actorType && hasTranslation(`TYPES.Actor.${actorType}`)) {
        return t(`TYPES.Actor.${actorType}`);
      }
      return t('origin-vault.fileTypes.actor');
    }

    const extension = this._getExtension(item.path);
    if (FILE_TYPES.VIDEO.includes(extension)) return t('origin-vault.fileTypes.video');
    if (FILE_TYPES.AUDIO.includes(extension)) return t('origin-vault.fileTypes.audio');
    return t('origin-vault.fileTypes.image');
  }

  _getPreviewKind(item) {
    const type = item.metadata?.type || item.type;
    if (type === 'scene' || type === 'item' || type === 'actor') return type;

    const extension = this._getExtension(item.path);
    if (FILE_TYPES.VIDEO.includes(extension)) return 'video';
    if (FILE_TYPES.AUDIO.includes(extension)) return 'audio';
    return 'image';
  }

  _getPreviewImage(item) {
    if (item.thumbnailGenerated && item.thumbnail) {
      return item.thumbnail;
    }

    const kind = this._getPreviewKind(item);
    if (kind === 'image' && item.path) {
      return item.path;
    }

    return '';
  }

  _getPreviewSubtitle(item) {
    const type = item.metadata?.type || item.type;
    if (type === 'item') {
      return item.metadata?.itemType || t('origin-vault.fileTypes.item');
    }
    if (type === 'actor') {
      return item.metadata?.actorType || t('origin-vault.fileTypes.actor');
    }
    if (type === 'scene') {
      return item.metadata?.width && item.metadata?.height
        ? `${item.metadata.width} × ${item.metadata.height}`
        : t('origin-vault.fileTypes.scene');
    }

    return item.path || '';
  }

  _getTagName(tagId) {
    return LibraryData.getInstance().getTag(tagId)?.name || '';
  }

  _getPreviewSubtitle(item) {
    const type = item.metadata?.type || item.type;
    const dimensions = item.metadata?.width && item.metadata?.height
      ? `${item.metadata.width} x ${item.metadata.height}`
      : '';
    const duration = Number(item.metadata?.duration) > 0
      ? this._formatTime(Number(item.metadata.duration))
      : '';

    if (type === 'item') {
      return item.metadata?.itemType || t('origin-vault.fileTypes.item');
    }
    if (type === 'actor') {
      return item.metadata?.actorType || t('origin-vault.fileTypes.actor');
    }
    if (type === 'scene') {
      return dimensions || t('origin-vault.fileTypes.scene');
    }
    if (dimensions && duration) {
      return `${dimensions} / ${duration}`;
    }
    if (dimensions) {
      return dimensions;
    }
    if (duration) {
      return duration;
    }

    return item.path || '';
  }

  _getExtension(path = '') {
    const index = path.lastIndexOf('.');
    return index >= 0 ? path.slice(index).toLowerCase() : '';
  }

  _localizeMaybe(key, fallback = '') {
    if (key && hasTranslation(key)) {
      return t(key);
    }
    return fallback || '';
  }

  _truncateLabel(label, maxLength) {
    if (!label || label.length <= maxLength) return label;
    return `${label.slice(0, Math.max(1, maxLength - 1))}…`;
  }

  _formatTime(seconds) {
    if (Number.isNaN(seconds) || seconds < 0) return '0:00';
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  }

  _truncateLabel(label, maxLength) {
    if (!label || label.length <= maxLength) return label;
    return `${label.slice(0, Math.max(1, maxLength - 3))}...`;
  }

  _escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
