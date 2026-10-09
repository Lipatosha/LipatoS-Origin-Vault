import assert from 'node:assert/strict';
import test from 'node:test';

import { applyCompendiumBatchImportMixin } from '../ui/mixins/CompendiumBatchImportMixin.js';

class BatchImportHost {}
applyCompendiumBatchImportMixin(BatchImportHost);

function createPack(collection, documentName, label) {
  return {
    collection,
    documentName,
    metadata: { label }
  };
}

test('跨类型合集包按勾选顺序导入，失败项保留供重试', async () => {
  const previousGame = globalThis.game;
  const previousUi = globalThis.ui;
  const packs = [
    createPack('module-a.items', 'Item', 'Items A'),
    createPack('module-b.scenes', 'Scene', 'Scenes B'),
    createPack('module-c.actors', 'Actor', 'Actors C')
  ];
  const notifications = [];

  globalThis.game = {
    packs: new Map(packs.map(pack => [pack.collection, pack])),
    i18n: {
      localize: key => key,
      format: (key, data) => `${key}:${JSON.stringify(data)}`
    }
  };
  globalThis.ui = {
    notifications: {
      info: message => notifications.push(['info', message]),
      warn: message => notifications.push(['warn', message])
    }
  };

  try {
    const host = new BatchImportHost();
    const importOrder = [];
    host._syncCompendiumBatchControls = () => {};
    host._hideBottomProgressBar = () => {};
    host._refreshViewAfterUpdate = () => {};
    host._importPackItems = async packId => {
      importOrder.push(packId);
      return { success: true, imported: 4 };
    };
    host._importPackScenes = async packId => {
      importOrder.push(packId);
      return { success: false, imported: 0, error: new Error('preview failed') };
    };
    host._importPackActors = async packId => {
      importOrder.push(packId);
      return { success: true, imported: 2 };
    };

    host._setCompendiumPackSelected('module-a.items', true);
    host._setCompendiumPackSelected('module-b.scenes', true);
    host._setCompendiumPackSelected('module-c.actors', true);

    const result = await host._runCompendiumBatchImport();

    assert.deepEqual(importOrder, ['module-a.items', 'module-b.scenes', 'module-c.actors']);
    assert.equal(result.succeeded, 2);
    assert.equal(result.failed, 1);
    assert.equal(result.imported, 6);
    assert.deepEqual(Array.from(host._compendiumBatchSelection.keys()), ['module-b.scenes']);
    assert.equal(host._compendiumBatchState.running, false);
    assert.equal(notifications.at(-1)[0], 'warn');
  } finally {
    globalThis.game = previousGame;
    globalThis.ui = previousUi;
  }
});

test('取消后重新勾选会把合集包移到队尾', () => {
  const host = new BatchImportHost();
  host._setCompendiumPackSelected('first', true);
  host._setCompendiumPackSelected('second', true);
  host._setCompendiumPackSelected('first', false);
  host._setCompendiumPackSelected('first', true);

  assert.deepEqual(Array.from(host._compendiumBatchSelection.keys()), ['second', 'first']);
});
