import { comparisonAsset, ComparisonSelection, COMPARISON_MIME, readComparisonDrop, resolveComparisonDrop, resolveComparisonItem } from './ComparisonAssets.js';
import { button, element, comparisonText as text } from './ComparisonElements.js';
import { EVENTS, SPECIAL_FOLDERS } from '../../constants.js';
import { QuickLook } from '../QuickLook.js';


export class ComparisonPanel {
  constructor(owner) {
    this.owner = owner;
    // MainWindow 单例会跨关闭/重开保留；只存内存，刷新或退出 FVTT 后自然清空。
    this.selection = owner._comparisonSelection ??= new ComparisonSelection();
    this.isOpen = false;
    this.generation = 0;
    this.hooks = [];
    const refresh = () => {
      this.refreshAssets();
      clearTimeout(this.refreshTimer);
      this.refreshTimer = setTimeout(() => { if (this.isOpen) this.render(); }, 60);
    };
    for (const name of [EVENTS.ITEM_UPDATED, EVENTS.ITEM_REMOVED, EVENTS.TAG_UPDATED, EVENTS.TAG_DELETED, EVENTS.LIBRARY_SWITCHED, 'createScene', 'deleteScene', 'createItem', 'deleteItem', 'updateItem', 'createActor', 'deleteActor', 'updateActor']) {
      this.hooks.push([name, Hooks.on(name, refresh)]);
    }
  }

  mount() {
    const root = this.owner.element?.querySelector('.origin-vault-container');
    if (!root) return;
    this.closePreview(false);
    this.hideHover();
    this.bindings?.abort();
    this.rememberSize();
    this.stopMedia();
    this.panel?.remove();
    this.root = root;
    this.document = root.ownerDocument;
    this.bindings = new this.document.defaultView.AbortController();
    const listen = (node, name, handler, options = {}) => node.addEventListener(name, handler, { ...options, signal: this.bindings.signal });
    this.trigger = root.querySelector('.btn-comparison');
    if (!this.trigger) return;
    listen(this.trigger, 'click', () => this.toggle());
    listen(this.trigger, 'dragenter', () => {
      if (!this.isOpen) this.openTimer = setTimeout(() => this.open(), 450);
    });
    listen(this.trigger, 'dragleave', () => clearTimeout(this.openTimer));
    listen(this.trigger, 'dragover', event => event.preventDefault());
    listen(this.trigger, 'drop', event => { clearTimeout(this.openTimer); this.open(); this.drop(event); });
    // 增加独立 MIME，不更改原生 Actor/Item 与画布使用的拖放数据。
    listen(root, 'dragstart', event => {
      const card = event.target.closest('.asset-card[data-item-id]');
      if (!card || card.closest('.ov-compare-panel') || !event.dataTransfer) return;
      const itemId = card.dataset.itemId;
      const ids = this.owner.selectedItems.has(itemId) ? [...this.owner.selectedItems] : [itemId];
      const assets = ids.map(id => this.assetForId(id)).filter(Boolean);
      if (assets.length) event.dataTransfer.setData(COMPARISON_MIME, JSON.stringify({ assets }));
      this.owner._hideHoverZoom?.();
      this.hideHover();
    }, { capture: true });
    listen(root, 'dragend', () => { clearTimeout(this.openTimer); this.panel?.classList.remove('drag-over'); });
    listen(root, 'pointerdown', event => {
      if (!this.panel?.contains(event.target)) this.hideHover();
    }, { capture: true });
    this.render();
  }

  assetForId(id) {
    const libraryItem = this.owner.activeType === 'scene' ? null : this.owner.library.getItem(id);
    if (libraryItem) return comparisonAsset(libraryItem, { libraryId: this.owner.library.basePath, tagDefinitions: this.owner.library.getAllTags() });
    const item = this.owner._cachedGridContext?.items?.find(entry => entry.id === id);
    return item ? comparisonAsset(item) : null;
  }

  refreshAssets() {
    for (const asset of this.selection.items) {
      if (asset.libraryId !== this.owner.library.basePath) continue;
      const item = this.owner.library.getItem(asset.assetId);
      if (item) Object.assign(asset, comparisonAsset(item, {
        libraryId: asset.libraryId, tagDefinitions: this.owner.library.getAllTags()
      }));
    }
  }

  itemFor(asset) { return resolveComparisonItem(asset, this.owner.library); }

  tagsFor(asset) {
    return asset.libraryId === this.owner.library.basePath ? this.owner.library.getAllTags() : asset.tagDefinitions;
  }

  stopMedia() {
    if (!this.panel) return;
    $(this.panel).find('.ov-compare-card').each((i, card) => $(card).triggerHandler('mouseleave'));
    this.panel.querySelectorAll('audio, video').forEach(media => {
      media.pause();
      media.removeAttribute('src');
      media.load();
    });
  }

  toggle() { if (this.isOpen) this.close(); else this.open(); }

  rememberSize() {
    if (this.panel?.style.width) this.size = { width: this.panel.style.width, height: this.panel.style.height };
  }

  open() {
    clearTimeout(this.openTimer);
    this.isOpen = true;
    this.owner.element?.classList.remove('dragging-hidden');
    this.owner._hideHoverZoom?.();
    this.render();
  }

  close() {
    clearTimeout(this.openTimer);
    this.isOpen = false;
    this.hideHover();
    this.closePreview(false);
    this.render();
    this.trigger?.focus({ preventScroll: true });
  }

  render() {
    if (!this.root) return;
    this.hideHover();
    this.refreshAssets();
    const focused = this.panel?.contains(this.document.activeElement);
    const scroll = this.panel?.querySelector('.ov-compare-grid')?.scrollTop || 0;
    this.rememberSize();
    this.stopMedia();
    this.panel?.remove();
    this.panel = null;
    this.resizeObserver?.disconnect();
    this.trigger.setAttribute('aria-expanded', String(this.isOpen));
    this.trigger.classList.toggle('active', this.isOpen);
    const count = this.trigger.querySelector('.ov-compare-count');
    count.textContent = String(this.selection.items.length);
    count.hidden = !this.selection.items.length;
    if (!this.isOpen) return;
    const panel = element(this.document, 'section', 'ov-compare-panel');
    if (this.size) Object.assign(panel.style, this.size);
    panel.id = 'ov-comparison-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', text('title'));
    const header = element(this.document, 'header', 'ov-compare-header');
    header.append(element(this.document, 'strong', '', text('title')));
    header.append(element(this.document, 'span', 'ov-compare-total', String(this.selection.items.length)));
    const undo = button(this.document, 'fa-undo', text('undo'), () => { this.selection.undo(); this.render(); });
    undo.disabled = !this.selection.undoItems;
    const clear = button(this.document, 'fa-broom', text('clear'), () => {
      this.generation++;
      this.closePreview(false);
      this.selection.clear();
      this.render();
      this.announce(text('cleared'));
    });
    clear.disabled = !this.selection.items.length;
    header.append(undo, clear, button(this.document, 'fa-chevron-up', text('collapse'), () => this.close()));
    const grid = element(this.document, 'div', 'ov-compare-grid');
    if (!this.selection.items.length) {
      const empty = element(this.document, 'div', 'ov-compare-empty');
      empty.append(element(this.document, 'i', 'fas fa-images'), element(this.document, 'span', '', text('dropHint')));
      grid.append(empty);
    }
    for (const asset of this.selection.items) grid.append(this.card(asset));
    const footer = element(this.document, 'footer', 'ov-compare-footer');
    footer.append(element(this.document, 'span', '', text('keyboardHint')));
    if (this.owner.isWindowed) footer.append(element(this.document, 'span', 'ov-compare-window-hint', text('windowHint')));
    this.status = element(this.document, 'span', 'ov-compare-status');
    this.status.setAttribute('role', 'status');
    footer.append(this.status);
    panel.append(header, grid, footer);
    panel.addEventListener('dragover', event => {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'copy';
      panel.classList.add('drag-over');
    });
    panel.addEventListener('dragleave', event => {
      if (!panel.contains(event.relatedTarget)) panel.classList.remove('drag-over');
    });
    panel.addEventListener('drop', event => this.drop(event));
    this.panel = panel;
    this.root.append(panel);
    grid.scrollTop = scroll;
    const resolveItem = id => {
      const asset = this.selection.items.find(entry => this.itemFor(entry).id === id);
      return asset ? this.itemFor(asset) : null;
    };
    const assetFor = item => this.selection.items.find(entry => this.itemFor(entry).id === item.id);
    this.owner._initHoverScrubbing($(grid), {
      comparison: true, resolveItem,
      onSelect: id => { const item = resolveItem(id); if (item) this.select(assetFor(item).key, true); }
    });
    this.owner._bindAssetPreviewBadges($(grid).find('.ov-compare-card'), {
      resolveItem, tags: item => this.tagsFor(assetFor(item)),
      onOpen: item => this.openAsset(assetFor(item), { badge: true })
    });
    this.owner._drawWaveforms(grid, resolveItem);
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => this.owner._drawWaveforms(grid, resolveItem));
    this.resizeObserver.observe(grid);
    if (focused) this.select(this.selection.activeKey, true);
  }

  card(asset) {
    const item = this.itemFor(asset);
    const template = this.document.createElement('template');
    template.innerHTML = this.owner._createAssetCardHtml(item, {
      position: null, selected: asset.key === this.selection.activeKey
    });
    const card = template.content.firstElementChild;
    card.classList.add('ov-compare-card');
    card.dataset.key = asset.key;
    card.dataset.eventsBound = 'true';
    card.tabIndex = asset.key === this.selection.activeKey ? 0 : -1;
    card.setAttribute('aria-label', item.displayName || item.name);
    const remove = button(this.document, 'fa-times', text('remove'), event => {
      event.stopPropagation();
      this.remove(asset.key);
    });
    remove.classList.add('ov-compare-remove');
    card.append(remove);
    card.addEventListener('click', event => {
      event.stopPropagation();
      if (!event.target.closest('button, .ov-preview-badge')) this.select(asset.key, true);
    });
    card.addEventListener('dblclick', event => {
      event.stopPropagation();
      if (event.target.closest('button, .ov-preview-badge')) return;
      event.preventDefault();
      this.openAsset(asset);
    });
    card.addEventListener('contextmenu', event => {
      event.preventDefault();
      event.stopPropagation();
      this.hideHover();
      this.select(asset.key, true);
      const current = this.itemFor(asset);
      this.owner._onItemContextMenu(event, current.id, {
        item: current, selectedItems: new Set([current.id]), preserveSelection: true,
        folderId: current.folders?.includes(this.owner.currentFolderId) ? this.owner.currentFolderId : SPECIAL_FOLDERS.ALL,
        onOpen: () => this.openAsset(asset)
      });
    });
    card.addEventListener('dragstart', event => {
      this.hideHover();
      this.stopMedia();
      event.stopPropagation();
      event.dataTransfer.effectAllowed = 'copyMove';
      // 原拖放格式与面板排序数据并存，继续支持系统自己的文档拖放。
      this.owner._onItemDragStart({ originalEvent: event, currentTarget: card }, item.id, this.itemFor(asset));
      event.dataTransfer.setData(COMPARISON_MIME, JSON.stringify({ assets: [asset], reorderKey: asset.key }));
    });
    return card;
  }

  select(key, focus = false) {
    this.selection.activeKey = key;
    this.panel?.querySelectorAll('.ov-compare-card').forEach(card => {
      const active = card.dataset.key === key;
      card.classList.toggle('selected', active);
      card.tabIndex = active ? 0 : -1;
      if (active && focus) { card.focus({ preventScroll: true }); card.scrollIntoView({ block: 'nearest' }); }
    });
  }

  async drop(event) {
    event.preventDefault();
    event.stopPropagation();
    this.panel?.classList.remove('drag-over');
    this.hideHover();
    const payload = readComparisonDrop(event.dataTransfer);
    const generation = this.generation;
    const targetKey = event.target.closest('.ov-compare-card')?.dataset.key;
    if (payload?.mime === COMPARISON_MIME && payload.value.reorderKey && targetKey) {
      this.selection.move(payload.value.reorderKey, targetKey);
      this.render();
      return;
    }
    try {
      const assets = await resolveComparisonDrop(event.dataTransfer, this.owner);
      if (generation !== this.generation) return;
      if (!assets.length) { this.announce(text('unsupported')); return; }
      const added = this.selection.add(assets);
      this.render();
      this.select(this.selection.activeKey, true);
      this.announce(added ? `${text('added')} ${added}` : text('duplicate'));
    } catch (error) {
      if (generation !== this.generation) return;
      console.warn('Origin Vault | Comparison drop failed', error);
      this.announce(text('unavailable'));
    }
  }

  announce(message) { if (this.status) this.status.textContent = message; }

  remove(key) {
    this.closePreview(false);
    this.selection.remove(key);
    this.render();
    this.select(this.selection.activeKey, true);
    this.announce(text('removed'));
  }

  hideHover() { this.owner._hideHoverZoom?.(); }

  async openAsset(asset, { badge = false } = {}) {
    this.hideHover();
    this.stopMedia();
    this.closePreview(false);
    this.select(asset.key);
    const item = this.itemFor(asset);
    const options = { returnSelection: this.owner.selectedItems, tags: this.tagsFor(asset) };
    try {
      if (badge) await this.owner._openQuickLook(item.id, item, options);
      else await this.owner._onItemDoubleClick(item.id, item, options);
    } catch (error) {
      console.warn('Origin Vault | Comparison open failed', error);
      this.announce(text('unavailable'));
    }
  }

  showPreview(asset) {
    this.hideHover();
    this.stopMedia();
    this.select(asset.key);
    const quickLook = QuickLook.getInstance();
    this.quickLookAsset = this.itemFor(asset);
    const request = quickLook.isOpen ? quickLook.switchAsset(this.quickLookAsset) : quickLook.open(this.quickLookAsset);
    Promise.resolve(request).catch(error => {
      console.warn('Origin Vault | Comparison QuickLook failed', error);
      this.announce(text('unavailable'));
    });
  }

  ownsQuickLook() {
    const quickLook = QuickLook.getInstance();
    return !!this.quickLookAsset && quickLook.currentAsset === this.quickLookAsset && !!quickLook.isOpen;
  }

  closePreview(focus = true) {
    if (this.ownsQuickLook()) QuickLook.getInstance().close();
    this.quickLookAsset = null;
    if (focus) this.select(this.selection.activeKey, true);
  }

  navigate(delta) {
    const items = this.selection.items;
    if (!items.length) return;
    const index = items.findIndex(item => item.key === this.selection.activeKey);
    const asset = items[(index + delta + items.length) % items.length];
    if (this.ownsQuickLook()) this.showPreview(asset);
    else this.select(asset.key, true);
  }

  handleKey(event) {
    const target = event.target;
    const quickLook = this.ownsQuickLook();
    const inPanel = this.panel?.contains(target) || target === this.trigger;
    if (!this.isOpen || (!inPanel && !quickLook)) return false;
    if (target.matches('input, textarea, select') || target.isContentEditable) return false;
    const targetApp = target.closest('.application, .app, .window-app');
    if (targetApp && !this.owner.element.contains(targetApp)) return false;
    const key = event.key;
    const onButton = !!target.closest('button, a, audio, video');
    if ((key === ' ' || key === 'Enter') && onButton) return true;
    if (key === 'Escape') {
      if (quickLook) this.closePreview();
      else this.close();
    } else if (key === ' ') {
      if (quickLook) this.closePreview();
      else {
        const asset = this.selection.items.find(item => item.key === this.selection.activeKey);
        if (asset) this.showPreview(asset);
      }
    } else if (key === 'Enter') {
      const asset = this.selection.items.find(item => item.key === this.selection.activeKey);
      if (asset) this.openAsset(asset);
    } else if (key === 'Delete' || key === 'Backspace') {
      if (!quickLook) this.remove(this.selection.activeKey);
    } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key) && !onButton) {
      this.navigate({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -2, ArrowDown: 2 }[key]);
    } else if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === 'z') {
      this.selection.undo(); this.render();
    } else return true;
    event.preventDefault();
    event.stopPropagation();
    return true;
  }

  destroy() {
    this.generation++;
    clearTimeout(this.openTimer);
    clearTimeout(this.refreshTimer);
    this.resizeObserver?.disconnect();
    for (const [name, id] of this.hooks) Hooks.off(name, id);
    this.hooks = [];
    this.closePreview(false);
    this.hideHover();
    this.bindings?.abort();
    this.stopMedia();
    this.panel?.remove();
    this.panel = null;
    this.root = null;
    this.isOpen = false;
  }
}
