function getPrimaryFilePickerClass() {
  return foundry?.applications?.apps?.FilePicker?.implementation ?? null;
}

function getLegacyFilePickerClass() {
  return globalThis.FilePicker ?? null;
}

/**
 * 把 FilePicker 的入口都收在这里，外面别再关心它今天挂在哪个命名空间。
 */
export function getFilePickerClass() {
  const FilePickerClass = getPrimaryFilePickerClass() ?? getLegacyFilePickerClass();
  if (!FilePickerClass) {
    throw new Error('Foundry FilePicker class is unavailable');
  }
  return FilePickerClass;
}

export function getFilePickerClasses() {
  const primaryClass = getPrimaryFilePickerClass();
  if (primaryClass) return [primaryClass];

  const legacyClass = getLegacyFilePickerClass();
  if (legacyClass) return [legacyClass];

  throw new Error('Foundry FilePicker class is unavailable');
}

/**
 * Tile Browser 自己管理持续浏览和拖拽，OV 只接管真正需要回填路径的选择器。
 */
export function resolveFilePickerInterceptMode(picker, renderOptions = {}) {
  if (picker?._ovSkipIntercept) return 'native';
  if (picker?.type === 'folder') return 'native';
  if (picker?.isSidebar || renderOptions?.sidebar) return 'native';
  if (picker?.options?.tileSize === true) return 'native';
  return 'select';
}

export function isFilePickerInstance(app) {
  if (!app) return false;
  return getFilePickerClasses().some(FilePickerClass => app instanceof FilePickerClass);
}

export function findActiveFilePickers() {
  return Object.values(ui.windows || {}).filter(windowApp => isFilePickerInstance(windowApp));
}

export function createFilePickerApp(options = {}) {
  const FilePickerClass = getFilePickerClass();
  return new FilePickerClass(options);
}

function normalizeFilePickerPath(path) {
  return String(path ?? '').replace(/^\/+|\/+$/g, '');
}

export function isUsingTheForge() {
  return typeof globalThis.ForgeVTT !== 'undefined' && !!globalThis.ForgeVTT?.usingTheForge;
}

export function browseFilePicker(source, path, options) {
  return getFilePickerClass().browse(source, path, options);
}

export function createFilePickerDirectory(source, path, options) {
  return getFilePickerClass().createDirectory(source, path, options);
}

export function uploadWithFilePicker(source, path, file, options, requestOptions) {
  return getFilePickerClass().upload(source, path, file, options, requestOptions);
}

export async function directoryExistsWithFilePicker(source, path, options) {
  const targetPath = normalizeFilePickerPath(path);
  const probeSource = (source === 'data' && isUsingTheForge()) ? 'forgevtt' : source;

  try {
    const result = await browseFilePicker(probeSource, targetPath, options);
    const resultTarget = normalizeFilePickerPath(result?.target);

    // Forge 上 data source 会回退到 Assets Library，这里只认真正命中的目标目录
    if (probeSource === 'forgevtt') return resultTarget === targetPath;
    if (resultTarget && resultTarget !== targetPath) return false;
    return true;
  } catch (error) {
    return false;
  }
}
