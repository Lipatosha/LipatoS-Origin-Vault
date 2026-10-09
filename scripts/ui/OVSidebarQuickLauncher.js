import { ENABLE_RIGHT_SIDEBAR_BROWSER } from '../constants.js';
import { OVSidebarBrowser } from './OVSidebarBrowser.js';
import { t } from '../utils/i18n.js';

const TAB_ID = 'ov-sidebar-browser';
const LAUNCHER_ID = 'ov-sidebar-quick-launcher';
const SHOW_DELAY = 140;
const HIDE_DELAY = 140;
const QUICK_PRESETS = Object.freeze([
  { id: 'all', icon: 'fa-layer-group', labelKey: 'origin-vault.sidebarDock.quickAll' },
  { id: 'files', icon: 'fa-file', labelKey: 'origin-vault.sidebarDock.quickFiles' },
  { id: 'items', icon: 'fa-scroll', labelKey: 'origin-vault.sidebarDock.quickItems' },
  { id: 'scenes', icon: 'fa-map', labelKey: 'origin-vault.sidebarDock.quickScenes' }
]);
const QUICK_ACTIONS = Object.freeze([
  { id: 'locate-scene', icon: 'fa-location-crosshairs', labelKey: 'origin-vault.sidebarDock.quickLocateScene' }
]);

export class OVSidebarQuickLauncher {
  static #instance = null;

  static getInstance() {
    if (!OVSidebarQuickLauncher.#instance) {
      OVSidebarQuickLauncher.#instance = new OVSidebarQuickLauncher();
    }
    return OVSidebarQuickLauncher.#instance;
  }

  constructor() {
    this.initialized = false;
    this._tabButton = null;
    this._launcherEl = null;
    this._showTimer = null;
    this._hideTimer = null;
    this._showToken = 0;

    this._boundOnButtonEnter = this._onButtonEnter.bind(this);
    this._boundOnButtonLeave = this._onButtonLeave.bind(this);
    this._boundOnButtonClick = this._onButtonClick.bind(this);
    this._boundOnLauncherEnter = this._onLauncherEnter.bind(this);
    this._boundOnLauncherLeave = this._onLauncherLeave.bind(this);
    this._boundOnLauncherClick = this._onLauncherClick.bind(this);
    this._boundOnDocumentPointerDown = this._onDocumentPointerDown.bind(this);
    this._boundOnDocumentKeyDown = this._onDocumentKeyDown.bind(this);
    this._boundOnResize = this._onViewportResize.bind(this);
  }

  init() {
    if (!ENABLE_RIGHT_SIDEBAR_BROWSER) return;
    if (this.initialized) return;
    this.initialized = true;

    Hooks.on('renderSidebar', (_app, html) => {
      this._ensureBound(html);
    });

    document.addEventListener('pointerdown', this._boundOnDocumentPointerDown, true);
    document.addEventListener('keydown', this._boundOnDocumentKeyDown, true);
    window.addEventListener('resize', this._boundOnResize);

    this._ensureLauncherHost();
    this._ensureBound(ui.sidebar?.element ?? document.getElementById('sidebar'));
  }

  _ensureBound(htmlLike) {
    const sidebarRoot = this._resolveSidebarRoot(htmlLike);
    if (!sidebarRoot) return;

    const browser = OVSidebarBrowser.getInstance();
    const nextTabButton = browser.getTabButtonElement()
      || sidebarRoot.querySelector(`#sidebar-tabs [data-tab="${TAB_ID}"]`);

    if (!(nextTabButton instanceof HTMLElement)) return;
    if (this._tabButton === nextTabButton) return;

    this._unbindTabButton();
    this._tabButton = nextTabButton;
    this._tabButton.addEventListener('mouseenter', this._boundOnButtonEnter);
    this._tabButton.addEventListener('mouseleave', this._boundOnButtonLeave);
    this._tabButton.addEventListener('click', this._boundOnButtonClick);
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

  _ensureLauncherHost() {
    let launcherEl = document.getElementById(LAUNCHER_ID);
    if (!launcherEl) {
      launcherEl = document.createElement('div');
      launcherEl.id = LAUNCHER_ID;
      launcherEl.className = 'ov-sidebar-browser__quick-launcher';
      document.body.appendChild(launcherEl);
    }

    launcherEl.removeEventListener('mouseenter', this._boundOnLauncherEnter);
    launcherEl.removeEventListener('mouseleave', this._boundOnLauncherLeave);
    launcherEl.removeEventListener('click', this._boundOnLauncherClick);

    launcherEl.addEventListener('mouseenter', this._boundOnLauncherEnter);
    launcherEl.addEventListener('mouseleave', this._boundOnLauncherLeave);
    launcherEl.addEventListener('click', this._boundOnLauncherClick);

    this._launcherEl = launcherEl;
  }

  _renderLauncher({ activePreset = 'custom', folders = [] } = {}) {
    if (!this._launcherEl) return;

    this._launcherEl.innerHTML = `
      <div class="ov-sidebar-browser__quick-launcher-menu" role="menu" aria-label="${this._escapeHtml(t('origin-vault.sidebarDock.quickLauncherTitle'))}">
        ${QUICK_PRESETS.map((preset) => `
          <button
            type="button"
            class="ov-sidebar-browser__quick-launcher-item${activePreset === preset.id ? ' is-active' : ''}"
            data-preset="${preset.id}"
            role="menuitem"
          >
            <i class="fas ${preset.icon}"></i>
            <span>${this._escapeHtml(t(preset.labelKey))}</span>
          </button>
        `).join('')}
        <div class="ov-sidebar-browser__quick-launcher-divider" role="presentation"></div>
        ${QUICK_ACTIONS.map((action) => `
          <button
            type="button"
            class="ov-sidebar-browser__quick-launcher-item ov-sidebar-browser__quick-launcher-item--secondary"
            data-action="${action.id}"
            role="menuitem"
          >
            <i class="fas ${action.icon}"></i>
            <span>${this._escapeHtml(t(action.labelKey))}</span>
          </button>
        `).join('')}
        ${folders.length > 0 ? `
          <div class="ov-sidebar-browser__quick-launcher-divider" role="presentation"></div>
          <section class="ov-sidebar-browser__quick-launcher-section">
            <div class="ov-sidebar-browser__quick-launcher-section-title">${this._escapeHtml(t('origin-vault.sidebarDock.folderButton'))}</div>
            <div class="ov-sidebar-browser__quick-launcher-tree">
              ${folders.map((folder) => this._renderFolderTreeItem(folder)).join('')}
            </div>
          </section>
        ` : ''}
      </div>
    `;
  }

  _renderFolderTreeItem(folder) {
    const hasChildren = Array.isArray(folder.children) && folder.children.length > 0;

    return `
      <div class="ov-sidebar-browser__quick-tree-item${hasChildren ? ' has-children' : ''}">
        <button
          type="button"
          class="ov-sidebar-browser__quick-folder-button"
          data-folder-id="${this._escapeHtml(folder.id)}"
          role="menuitem"
          title="${this._escapeHtml(folder.name)}"
        >
          <span class="ov-sidebar-browser__quick-folder-label">
            <i class="fas ${this._escapeHtml(folder.icon || 'fa-folder')}"></i>
            <span class="ov-sidebar-browser__quick-folder-name">${this._escapeHtml(folder.name)}</span>
          </span>
          <span class="ov-sidebar-browser__quick-folder-meta">
            <span class="ov-sidebar-browser__quick-folder-count">${Number(folder.count || 0)}</span>
            ${hasChildren ? '<i class="fas fa-chevron-right"></i>' : ''}
          </span>
        </button>
        ${hasChildren ? `
          <div class="ov-sidebar-browser__quick-folder-flyout">
            ${folder.children.map((child) => this._renderFolderTreeItem(child)).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }

  _scheduleShow() {
    window.clearTimeout(this._hideTimer);
    window.clearTimeout(this._showTimer);
    this._showTimer = window.setTimeout(() => this._show(), SHOW_DELAY);
  }

  _scheduleHide() {
    window.clearTimeout(this._showTimer);
    window.clearTimeout(this._hideTimer);
    this._hideTimer = window.setTimeout(() => this.hide(), HIDE_DELAY);
  }

  async _show() {
    if (!(this._tabButton instanceof HTMLElement) || !this._launcherEl) return;

    const token = ++this._showToken;
    const browser = OVSidebarBrowser.getInstance();
    const folders = await browser.getQuickLauncherFolders();
    if (token !== this._showToken || !(this._tabButton instanceof HTMLElement) || !this._launcherEl) return;

    this._renderLauncher({
      activePreset: browser.getActiveQuickPresetId(),
      folders
    });
    this._positionLauncher();
    this._launcherEl.classList.add('is-visible');
  }

  hide(immediate = false) {
    this._showToken += 1;
    window.clearTimeout(this._showTimer);
    window.clearTimeout(this._hideTimer);

    if (!this._launcherEl) return;

    if (immediate) {
      this._launcherEl.classList.remove('is-visible');
      return;
    }

    this._launcherEl.classList.remove('is-visible');
  }

  _positionLauncher() {
    if (!(this._tabButton instanceof HTMLElement) || !this._launcherEl) return;

    const tabRect = this._tabButton.getBoundingClientRect();
    const hostRect = this._launcherEl.getBoundingClientRect();
    const launcherWidth = Math.max(160, hostRect.width || 172);
    const launcherHeight = Math.max(176, hostRect.height || 196);
    let left = tabRect.left - launcherWidth + 10;
    let top = tabRect.top + (tabRect.height / 2) - (launcherHeight / 2);

    left = Math.max(8, left);
    top = Math.max(8, Math.min(top, window.innerHeight - launcherHeight - 8));

    this._launcherEl.style.left = `${Math.round(left)}px`;
    this._launcherEl.style.top = `${Math.round(top)}px`;
  }

  _openPreset(presetId) {
    const browser = OVSidebarBrowser.getInstance();
    browser.openWithPreset(presetId);
    this.hide(true);
  }

  _onButtonEnter() {
    this._scheduleShow();
  }

  _onButtonLeave() {
    this._scheduleHide();
  }

  _onButtonClick() {
    this.hide(true);
  }

  _onLauncherEnter() {
    window.clearTimeout(this._hideTimer);
    window.clearTimeout(this._showTimer);
  }

  _onLauncherLeave() {
    this._scheduleHide();
  }

  _onLauncherClick(event) {
    const presetTarget = event.target.closest('[data-preset]');
    if (presetTarget instanceof HTMLElement) {
      event.preventDefault();
      event.stopPropagation();
      this._openPreset(presetTarget.dataset.preset);
      return;
    }

    const actionTarget = event.target.closest('[data-action]');
    if (actionTarget instanceof HTMLElement) {
      event.preventDefault();
      event.stopPropagation();

      if (actionTarget.dataset.action === 'locate-scene') {
        OVSidebarBrowser.getInstance().locateCurrentScene();
        this.hide(true);
      }
      return;
    }

    const folderTarget = event.target.closest('[data-folder-id]');
    if (folderTarget instanceof HTMLElement) {
      event.preventDefault();
      event.stopPropagation();
      OVSidebarBrowser.getInstance().openFolderFromQuickLauncher(folderTarget.dataset.folderId);
      this.hide(true);
    }
  }

  _onDocumentPointerDown(event) {
    if (!this._launcherEl?.classList.contains('is-visible')) return;

    const target = event.target;
    if (!(target instanceof Node)) return;

    const clickedLauncher = this._launcherEl.contains(target);
    const clickedButton = this._tabButton?.contains(target);
    if (!clickedLauncher && !clickedButton) {
      this.hide(true);
    }
  }

  _onDocumentKeyDown(event) {
    if (event.key === 'Escape') {
      this.hide(true);
    }
  }

  _onViewportResize() {
    if (this._launcherEl?.classList.contains('is-visible')) {
      this._positionLauncher();
    }
  }

  _unbindTabButton() {
    if (!(this._tabButton instanceof HTMLElement)) return;

    this._tabButton.removeEventListener('mouseenter', this._boundOnButtonEnter);
    this._tabButton.removeEventListener('mouseleave', this._boundOnButtonLeave);
    this._tabButton.removeEventListener('click', this._boundOnButtonClick);
    this._tabButton = null;
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
