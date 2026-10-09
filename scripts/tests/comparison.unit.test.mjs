import assert from 'node:assert/strict';
import test from 'node:test';
import { comparisonAsset, ComparisonSelection, COMPARISON_MIME, resolveComparisonDrop, resolveComparisonItem } from '../ui/comparison/ComparisonAssets.js';
import { applyPreviewMixin } from '../ui/mixins/PreviewMixin.js';
import { ComparisonPanel } from '../ui/comparison/ComparisonPanel.js';

const transfer = (data, mime = 'text/plain') => ({ getData: type => type === mime ? JSON.stringify(data) : '' });

test('关闭重开保留对比候选、顺序与移除结果；手动清空和新会话仍为空', () => {
  const previousHooks = globalThis.Hooks;
  const hooks = new Set();
  globalThis.Hooks = {
    on(name, callback) { hooks.add(callback); return callback; },
    off(name, callback) { hooks.delete(callback); }
  };
  const owner = { _hideHoverZoom() {} };
  try {
    let panel = new ComparisonPanel(owner);
    const [a, b, c] = ['a', 'b', 'c'].map(name => comparisonAsset({ path: `${name}.webp` }));
    panel.selection.add([a, b, c]);
    panel.selection.move(c.key, a.key);
    panel.selection.remove(b.key);
    panel.destroy();
    assert.equal(hooks.size, 0);
    panel = new ComparisonPanel(owner);
    assert.deepEqual(panel.selection.items.map(item => item.key), [c.key, a.key]);
    panel.selection.clear();
    panel.destroy();
    panel = new ComparisonPanel(owner);
    assert.equal(panel.selection.items.length, 0);
    panel.selection.add([a]);
    panel.destroy();
    const newSession = new ComparisonPanel({ _hideHoverZoom() {} });
    assert.equal(newSession.selection.items.length, 0);
    newSession.destroy();
    assert.equal(hooks.size, 0);
  } finally { globalThis.Hooks = previousHooks; }
});

test('对比覆盖六类资产，文档图标不被识别为普通图片', () => {
  for (const [type, path] of [['image', 'tree.webp'], ['video', 'rain.webm'], ['audio', 'wind.ogg'], ['scene', 'map.ov-scene'], ['item', 'sword.webp'], ['actor', 'orc.png']]) {
    const item = comparisonAsset({ path, metadata: ['item', 'actor'].includes(type) ? { type, uuid: `Compendium.test.${type}.a` } : {} });
    assert.equal(item.type, type);
  }
  assert.equal(comparisonAsset({ path: 'https://cdn.test/Map.WEBP?signature=abc' }).type, 'image');
  assert.equal(comparisonAsset({ path: 'javascript:alert(1).svg' }), null);
});

test('库身份和完整 UUID 避免短 ID、路径、世界副本串项', () => {
  const item = { id: 'same', path: 'same.webp', name: 'A' };
  const first = comparisonAsset(item, { libraryId: 'a' });
  const second = comparisonAsset(item, { libraryId: 'b' });
  assert.notEqual(first.key, second.key);
  const pack = comparisonAsset({ type: 'actor', uuid: 'Compendium.pack.Actor.same' });
  const world = comparisonAsset({ type: 'actor', uuid: 'Actor.same' });
  assert.notEqual(pack.key, world.key);
  assert.notEqual(comparisonAsset({ path: 'https://cdn/a.webp?v=1' }).key, comparisonAsset({ path: 'https://cdn/a.webp?v=2' }).key);
});

test('重复拖入定位原项；移除后新增资产不会被撤销丢掉', () => {
  const state = new ComparisonSelection();
  const [a, b, c] = ['a', 'b', 'c'].map(name => comparisonAsset({ path: `${name}.webp` }));
  assert.equal(state.add([a, b, a]), 2);
  assert.equal(state.activeKey, a.key);
  state.remove(a.key);
  state.add([c]);
  state.undo();
  assert.deepEqual(state.items.map(item => item.key), [a.key, b.key, c.key]);
  state.clear();
  assert.equal(state.items.length, 0);
  state.undo();
  assert.equal(state.items.length, 3);
});

test('排序只改变候选顺序，不触及原始素材', () => {
  const state = new ComparisonSelection();
  const assets = ['a', 'b', 'c'].map(name => comparisonAsset({ path: `${name}.webp` }));
  state.add(assets);
  state.move(assets[2].key, assets[0].key);
  assert.deepEqual(state.items.map(item => item.path), ['c.webp', 'a.webp', 'b.webp']);
  assert.deepEqual(assets.map(item => item.path), ['a.webp', 'b.webp', 'c.webp']);
});

test('原生文档拖入读取准确来源并检查权限', async () => {
  const previousGame = globalThis.game;
  const previousFromUuid = globalThis.fromUuid;
  const reads = [];
  globalThis.game = { user: { isGM: false } };
  globalThis.fromUuid = async uuid => {
    reads.push(uuid);
    return { uuid, documentName: 'Actor', name: 'Original', img: 'a.webp', testUserPermission: () => uuid.startsWith('Compendium.') };
  };
  try {
    const items = await resolveComparisonDrop(transfer({ type: 'Actor', uuid: 'Compendium.pack.Actor.a' }), {});
    assert.equal(items[0].uuid, 'Compendium.pack.Actor.a');
    assert.deepEqual(reads, ['Compendium.pack.Actor.a']);
    await assert.rejects(resolveComparisonDrop(transfer({ type: 'Actor', uuid: 'Actor.private' }), {}), /inaccessible/);
  } finally { globalThis.game = previousGame; globalThis.fromUuid = previousFromUuid; }
});

test('库多选和文件浏览器 S3 拖入不要求导入，目录不会展开扫描', async () => {
  const host = { library: { basePath: 'library-a', getItem: id => ({ id, path: `${id}.png` }) } };
  const assets = await resolveComparisonDrop(transfer({ type: 'origin-vault-item', itemId: 'a', originVault: { itemIds: ['a', 'b'] } }), host);
  assert.equal(assets.length, 2);
  assert.equal(assets[0].libraryId, 'library-a');
  const files = { type: 'origin-vault-browser-files', paths: ['a.webp', 'b.ogg'], source: 's3', bucket: 'assets' };
  assert.equal((await resolveComparisonDrop(transfer(files), host))[1].bucket, 'assets');
  assert.deepEqual(await resolveComparisonDrop(transfer({ ...files, isDirectory: true }), host), []);
  assert.deepEqual(await resolveComparisonDrop(transfer({ type: 'Folder', uuid: 'Folder.a' }), host), []);
});

test('对比 MIME 保留跨库身份，不能回到当前库重新找同名 ID', async () => {
  const asset = comparisonAsset({ id: 'a', path: 'a.png', metadata: { type: 'actor', uuid: 'Compendium.pack.Actor.a' } }, { libraryId: 'old-library' });
  const [resolved] = await resolveComparisonDrop(transfer({ assets: [asset] }, COMPARISON_MIME), { library: { getItem() { throw new Error('wrong library'); } } });
  assert.equal(resolved.key, asset.key);
  assert.equal(resolved.uuid, asset.uuid);
});

test('当前库读取最新完整条目，跨库保留原卡片字段并隔离可编辑 ID', () => {
  const original = { id: 'same', path: 'bow.png', displayName: '长弓', tags: ['ranged'],
    thumbnail: 'bow-thumb.webp', thumbnailGenerated: true, thumbnailRevision: 'v2', aspectRatio: 0.75,
    metadata: { type: 'item', uuid: 'Compendium.test.Item.bow', itemType: 'weapon', rarity: 'rare' } };
  const asset = comparisonAsset(original, { libraryId: 'first' });
  const latest = { ...original, displayName: '新名称', tags: ['changed'] };
  const library = { basePath: 'first', getItem: () => latest };
  assert.equal(resolveComparisonItem(asset, library), latest);
  library.basePath = 'second';
  const detached = resolveComparisonItem(asset, library);
  assert.notEqual(detached.id, latest.id);
  assert.equal(detached.displayName, '长弓');
  assert.deepEqual(detached.tags, ['ranged']);
  assert.equal(detached.thumbnailRevision, 'v2');
  assert.equal(detached.metadata.rarity, 'rare');
  assert.equal(detached.aspectRatio, 0.75);
});

test('对比显式传入条目时，双击仍遵循原网格的六类打开规则', async () => {
  class Host {}
  applyPreviewMixin(Host);
  const host = new Host();
  const calls = [];
  host.library = { getItem() { throw new Error('不能用外部 ID 查当前库'); } };
  host._openPreview = (...args) => calls.push(['preview', ...args]);
  host._resolveImportState = () => ({ imported: true, worldUuid: 'Actor.world' });
  host._openWorldActorWithSync = uuid => calls.push(['world', uuid]);
  host._openNativeActorSheet = uuid => calls.push(['native', uuid]);
  const options = { returnSelection: new Set(['main']) };
  for (const [type, path] of [['image', 'map.webp'], ['video', 'rain.webm'], ['audio', 'wind.ogg'], ['scene', 'map.ov-scene'], ['item', 'bow.png'], ['actor', 'guard.png']]) {
    const item = { id: type, path, metadata: { type, uuid: `${type}.source` } };
    const before = calls.length;
    await host._onItemDoubleClick(item.id, item, options);
    if (type === 'audio') assert.equal(calls.length, before);
    else if (type === 'actor') assert.deepEqual(calls.at(-1), ['world', 'Actor.world']);
    else assert.deepEqual(calls.at(-1), ['preview', item.id, item, options]);
  }
  host._resolveImportState = () => ({ imported: false });
  await host._onItemDoubleClick('actor', { id: 'actor', path: 'guard.png', metadata: { type: 'actor', uuid: 'Compendium.test.Actor.guard' } });
  assert.deepEqual(calls.at(-1), ['native', 'Compendium.test.Actor.guard']);
  host.filePickerMode = true;
  host._confirmFilePicker = path => calls.push(['picker', path]);
  host._onItemDoubleClick('map', { id: 'map', path: 'map.webp' });
  assert.deepEqual(calls.at(-1), ['picker', 'map.webp']);
});
