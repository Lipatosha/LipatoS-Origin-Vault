import { GLOBAL_DATA_PATH } from '../constants.js';

export function getCurrentWorldId() {
  return game?.world?.id || null;
}

export function isGlobalLibraryPath(path) {
  const normalized = String(path || '').replace(/\\/g, '/');
  return normalized === GLOBAL_DATA_PATH || normalized.startsWith(`${GLOBAL_DATA_PATH}/`);
}

function getItemMetadata(item) {
  if (!item) return null;
  return item.metadata || item;
}

function normalizeBindings(bindings) {
  return bindings && typeof bindings === 'object' && !Array.isArray(bindings)
    ? bindings
    : {};
}

export function getWorldSceneBinding(item, {
  worldId = getCurrentWorldId(),
  library = null,
  allowLegacy = true
} = {}) {
  const metadata = getItemMetadata(item);
  if (!metadata || !worldId) return null;

  const bindings = normalizeBindings(metadata.worldSceneBindings);
  const binding = bindings[worldId];
  if (binding?.sceneId) {
    return {
      ...binding,
      worldId,
      legacy: false
    };
  }

  if (!allowLegacy || metadata.worldSceneOrigin !== true || !metadata.worldSceneId) {
    return null;
  }

  const legacyScene = game?.scenes?.get?.(metadata.worldSceneId) || null;
  if (!legacyScene) return null;

  // 旧字段没有 worldId。全局库里只在当前世界确实存在这条 Scene 时兜底，
  // 避免 A 世界的 worldSceneId 在 B 世界被当成可打开的场景。
  return {
    sceneId: legacyScene.id,
    sceneName: legacyScene.name || metadata.sceneName || item?.displayName || '',
    source: 'legacy-world-scene',
    worldId,
    legacy: true,
    globalLegacy: isGlobalLibraryPath(library?.basePath)
  };
}

export function getWorldSceneId(item, options = {}) {
  return getWorldSceneBinding(item, options)?.sceneId || null;
}

export function isWorldSceneAsset(item) {
  const metadata = getItemMetadata(item);
  if (!metadata) return false;

  const bindings = normalizeBindings(metadata.worldSceneBindings);
  return metadata.worldSceneOrigin === true || Object.keys(bindings).length > 0;
}

export function shouldShowWorldSceneAsset(item, options = {}) {
  if (!isWorldSceneAsset(item)) return true;

  const metadata = getItemMetadata(item);
  const bindings = normalizeBindings(metadata.worldSceneBindings);
  if (Object.keys(bindings).length > 0) {
    return !!getWorldSceneBinding(item, { ...options, allowLegacy: false });
  }

  return !!getWorldSceneBinding(item, options);
}

export function setWorldSceneBinding(item, scene, {
  worldId = getCurrentWorldId(),
  source = 'world-scene',
  createdFromAsset = false,
  backgroundSrc = null
} = {}) {
  if (!item || !scene || !worldId) return null;

  item.metadata = item.metadata || {};
  const bindings = {
    ...normalizeBindings(item.metadata.worldSceneBindings)
  };

  bindings[worldId] = {
    sceneId: scene.id,
    sceneName: scene.name || '',
    source,
    createdFromAsset: !!createdFromAsset,
    backgroundSrc: backgroundSrc ?? scene.background?.src ?? '',
    updatedAt: new Date().toISOString()
  };

  item.metadata.worldSceneOrigin = true;
  item.metadata.worldSceneBindings = bindings;
  delete item.metadata.worldSceneId;

  return bindings[worldId];
}
