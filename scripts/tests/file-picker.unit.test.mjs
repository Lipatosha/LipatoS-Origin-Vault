import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const filePickerUtilsUrl = new URL('../utils/filePicker.js', import.meta.url);
const fileUploadUrl = new URL('../features/FileUpload.js', import.meta.url);
const mainWindowUrl = new URL('../ui/MainWindow.js', import.meta.url);

test('V13 命名空间可用时不再读取旧版 FilePicker 全局变量', async () => {
  class PrimaryFilePicker {}
  class LegacyFilePicker {}

  const previousFoundry = globalThis.foundry;
  const legacyDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'FilePicker');
  let legacyReads = 0;

  globalThis.foundry = {
    applications: {
      apps: {
        FilePicker: { implementation: PrimaryFilePicker }
      }
    }
  };
  Object.defineProperty(globalThis, 'FilePicker', {
    configurable: true,
    get() {
      legacyReads += 1;
      return LegacyFilePicker;
    }
  });

  try {
    const { getFilePickerClasses } = await import(`${filePickerUtilsUrl.href}?primary-only=${Date.now()}`);
    assert.deepEqual(getFilePickerClasses(), [PrimaryFilePicker]);
    assert.equal(legacyReads, 0);
  } finally {
    globalThis.foundry = previousFoundry;
    if (legacyDescriptor) {
      Object.defineProperty(globalThis, 'FilePicker', legacyDescriptor);
    } else {
      delete globalThis.FilePicker;
    }
  }
});

test('Tile Browser 应原生透传，普通路径选择器仍由 OV 接管', async () => {
  const filePickerUtils = await import(`${filePickerUtilsUrl.href}?mode=${Date.now()}`);
  assert.equal(typeof filePickerUtils.resolveFilePickerInterceptMode, 'function');

  const resolveMode = filePickerUtils.resolveFilePickerInterceptMode;
  assert.equal(resolveMode({ type: 'imagevideo', options: { tileSize: true } }), 'native');
  assert.equal(resolveMode({ type: 'image', options: {} }), 'select');
  assert.equal(resolveMode({ type: 'folder', options: {} }), 'native');
  assert.equal(resolveMode({ type: 'image', _ovSkipIntercept: true }), 'native');
  assert.equal(resolveMode({ type: 'image', isSidebar: true }), 'native');
  assert.equal(resolveMode({ type: 'image' }, { sidebar: true }), 'native');
});

test('OV 不保留 Tile Browser 专用会话状态', async () => {
  const [mainWindowSource, fileUploadSource] = await Promise.all([
    readFile(mainWindowUrl, 'utf8'),
    readFile(fileUploadUrl, 'utf8')
  ]);

  assert.doesNotMatch(mainWindowSource, /openAsTileBrowser|tileBrowserMode/);
  assert.doesNotMatch(fileUploadSource, /interceptMode === ['"]browse['"]/);
});

test('素材卡片的单击和双击只由根级事件委托负责', async () => {
  const source = await readFile(mainWindowUrl, 'utf8');
  const methodStart = source.indexOf('  _activateAssetGridListeners(container) {');
  const contextMenuStart = source.indexOf('    // 素材右键菜单', methodStart);
  const directSelectionBindings = source.slice(methodStart, contextMenuStart);

  assert.ok(methodStart >= 0 && contextMenuStart > methodStart, '找不到素材网格监听方法');
  assert.doesNotMatch(directSelectionBindings, /\.on\(['"](?:click|dblclick)['"]/);
  assert.match(source, /html\.off\(['"]\.ovAssetSelection['"]\)/);
  assert.match(source, /html\.on\(['"]click\.ovAssetSelection['"], ['"]\.asset-card:not\(\.ov-compare-card\):not\(\.folder-card\)['"]/);
  assert.match(source, /html\.on\(['"]dblclick\.ovAssetSelection['"], ['"]\.asset-card:not\(\.ov-compare-card\)['"]/);
});
