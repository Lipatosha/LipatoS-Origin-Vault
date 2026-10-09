import { ImportFloater } from '../ImportFloater.js';
import { t, tf } from '../../utils/i18n.js';

const IMPORT_METHODS = {
  Scene: '_importPackScenes',
  Item: '_importPackItems',
  Actor: '_importPackActors'
};

function getBatchSelection(host) {
  host._compendiumBatchSelection ??= new Map();
  return host._compendiumBatchSelection;
}

function getPanelRoot(panelEl) {
  if (!panelEl) return null;
  if (panelEl.jquery) return panelEl[0] || null;
  return panelEl;
}

export function applyCompendiumBatchImportMixin(cls) {
  cls.prototype._hasCompendiumImportInFlight = function () {
    return !!(
      this._backgroundTask
      || this._scenePackImportPending
      || this._itemPackImportPending
      || this._itemPackImportActive
      || this._actorPackImportPending
      || this._actorPackImportActive
    );
  };

  cls.prototype._isCompendiumPackSelected = function (packId) {
    return getBatchSelection(this).has(packId);
  };

  cls.prototype._getCompendiumBatchContext = function () {
    const state = this._compendiumBatchState;
    const selectedCount = getBatchSelection(this).size;

    return {
      selectedCount,
      hasSelection: selectedCount > 0,
      running: !!state?.running,
      current: state?.current || 0,
      total: state?.total || 0,
      currentName: state?.currentName || ''
    };
  };

  cls.prototype._setCompendiumPackSelected = function (packId, selected) {
    const selection = getBatchSelection(this);
    if (selected) {
      // Map 会保留第一次勾选的顺序，队列就照这个顺序跑。
      if (!selection.has(packId)) selection.set(packId, true);
    } else {
      selection.delete(packId);
    }
  };

  cls.prototype._setCompendiumPacksSelected = function (packIds, selected) {
    for (const packId of packIds) {
      this._setCompendiumPackSelected(packId, selected);
    }
  };

  cls.prototype._syncCompendiumBatchControls = function (panelEl = this.element?.querySelector?.('#ov-right-panel')) {
    const root = getPanelRoot(panelEl);
    if (!root) return;

    const selection = getBatchSelection(this);
    const queueOrder = new Map(Array.from(selection.keys()).map((packId, index) => [packId, index + 1]));
    const state = this._compendiumBatchState;
    const running = !!state?.running;

    for (const checkbox of root.querySelectorAll('.compendium-batch-pack-checkbox')) {
      const packId = checkbox.dataset.packId;
      checkbox.checked = selection.has(packId);
      checkbox.disabled = running;
      const packItem = checkbox.closest('.compendium-pack-item');
      packItem?.classList.toggle('batch-selected', checkbox.checked);
      const orderBadge = packItem?.querySelector('.compendium-batch-order');
      if (orderBadge) orderBadge.textContent = queueOrder.get(packId) || '';
    }

    for (const groupCheckbox of root.querySelectorAll('.compendium-batch-group-checkbox')) {
      const group = groupCheckbox.closest('.item-pack-group');
      const packIds = Array.from(group?.querySelectorAll('.compendium-batch-pack-checkbox') || [])
        .map(checkbox => checkbox.dataset.packId)
        .filter(Boolean);
      const selectedCount = packIds.filter(packId => selection.has(packId)).length;

      groupCheckbox.checked = packIds.length > 0 && selectedCount === packIds.length;
      groupCheckbox.indeterminate = selectedCount > 0 && selectedCount < packIds.length;
      groupCheckbox.disabled = running || packIds.length === 0;
    }

    for (const bar of root.querySelectorAll('.compendium-batch-bar')) {
      bar.classList.toggle('is-running', running);
      const countEl = bar.querySelector('.compendium-batch-count');
      const statusEl = bar.querySelector('.compendium-batch-status');
      const startButton = bar.querySelector('.btn-start-compendium-batch');
      const clearButton = bar.querySelector('.btn-clear-compendium-batch');

      if (countEl) {
        countEl.textContent = tf('origin-vault.batchImport.selectedCount', { count: selection.size });
      }

      if (statusEl) {
        statusEl.textContent = running
          ? tf('origin-vault.batchImport.progress', {
            current: state.current,
            total: state.total,
            name: state.currentName
          })
          : t('origin-vault.batchImport.orderHint');
      }

      if (startButton) {
        startButton.disabled = running || selection.size === 0 || this._hasCompendiumImportInFlight();
        const icon = startButton.querySelector('i');
        if (icon) icon.className = running ? 'fas fa-spinner fa-spin' : 'fas fa-play';
      }
      if (clearButton) clearButton.disabled = running || selection.size === 0;
    }

    for (const button of root.querySelectorAll('.btn-import-pack, .btn-import-item-pack, .btn-import-actor-pack')) {
      button.disabled = running;
    }
  };

  cls.prototype._activateCompendiumBatchListeners = function (panelEl) {
    const root = getPanelRoot(panelEl);
    if (!root) return;

    for (const checkbox of root.querySelectorAll('.compendium-batch-pack-checkbox')) {
      checkbox.addEventListener('click', event => event.stopPropagation());
      checkbox.addEventListener('change', event => {
        this._setCompendiumPackSelected(event.currentTarget.dataset.packId, event.currentTarget.checked);
        this._syncCompendiumBatchControls(root);
      });
    }

    for (const checkbox of root.querySelectorAll('.compendium-batch-group-checkbox')) {
      checkbox.addEventListener('click', event => event.stopPropagation());
      checkbox.addEventListener('change', event => {
        const group = event.currentTarget.closest('.item-pack-group');
        const packIds = Array.from(group?.querySelectorAll('.compendium-batch-pack-checkbox') || [])
          .map(packCheckbox => packCheckbox.dataset.packId)
          .filter(Boolean);
        this._setCompendiumPacksSelected(packIds, event.currentTarget.checked);
        this._syncCompendiumBatchControls(root);
      });
    }

    root.querySelector('.btn-clear-compendium-batch')?.addEventListener('click', () => {
      if (this._compendiumBatchState?.running) return;
      getBatchSelection(this).clear();
      this._syncCompendiumBatchControls(root);
    });

    root.querySelector('.btn-start-compendium-batch')?.addEventListener('click', () => {
      void this._runCompendiumBatchImport();
    });

    this._syncCompendiumBatchControls(root);
  };

  cls.prototype._runCompendiumBatchImport = async function () {
    if (this._compendiumBatchState?.running || this._hasCompendiumImportInFlight()) {
      ui.notifications.warn(t('origin-vault.notifications.bgImportRunning'));
      return null;
    }

    const selection = getBatchSelection(this);
    const queue = Array.from(selection.keys())
      .map(packId => game.packs.get(packId))
      .filter(pack => pack && IMPORT_METHODS[pack.documentName]);

    if (!queue.length) {
      ui.notifications.warn(t('origin-vault.batchImport.empty'));
      return null;
    }

    const state = {
      running: true,
      current: 0,
      total: queue.length,
      currentName: '',
      results: []
    };
    this._compendiumBatchState = state;
    this._syncCompendiumBatchControls();

    for (let index = 0; index < queue.length; index++) {
      const pack = queue[index];
      const importMethod = this[IMPORT_METHODS[pack.documentName]];
      state.current = index + 1;
      state.currentName = pack.metadata?.label || pack.collection;
      this._syncCompendiumBatchControls();

      let result;
      try {
        result = await importMethod.call(this, pack.collection, {
          fromBatch: true,
          notify: false,
          batchPosition: { current: state.current, total: state.total }
        });
      } catch (error) {
        result = { success: false, imported: 0, error };
      }

      const normalizedResult = {
        packId: pack.collection,
        name: state.currentName,
        success: result?.success === true,
        imported: result?.imported || 0,
        error: result?.error || null
      };
      state.results.push(normalizedResult);

      if (normalizedResult.success) {
        // 成功项从选择里拿掉；失败项留下，用户可以直接再跑一次。
        selection.delete(pack.collection);
      }
      this._syncCompendiumBatchControls();
    }

    state.running = false;
    const succeeded = state.results.filter(result => result.success);
    const failed = state.results.filter(result => !result.success);
    const imported = succeeded.reduce((sum, result) => sum + result.imported, 0);

    this._backgroundTask = null;
    this._hideBottomProgressBar?.();
    const floater = ImportFloater.getInstance();
    if (floater.isVisible()) floater.complete();
    this._refreshViewAfterUpdate?.();
    this._syncCompendiumBatchControls();

    if (failed.length) {
      ui.notifications.warn(tf('origin-vault.batchImport.completeWithFailures', {
        succeeded: succeeded.length,
        failed: failed.length,
        count: imported
      }));
    } else {
      ui.notifications.info(tf('origin-vault.batchImport.complete', {
        packs: succeeded.length,
        count: imported
      }));
    }

    return {
      success: failed.length === 0,
      succeeded: succeeded.length,
      failed: failed.length,
      imported,
      results: state.results
    };
  };
}
