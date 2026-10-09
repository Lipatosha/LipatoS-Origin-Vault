import { FILE_TYPES, IS_MAD_EDITION } from '../../constants.js';

export const COMPARISON_MIME = 'application/x-origin-vault-comparison';
const DOCUMENT_TYPES = new Set(['scene', 'item', 'actor']);

export function mediaType(path = '') {
  const extension = `.${String(path).split(/[?#]/)[0].split('.').pop().toLowerCase()}`;
  for (const [type, extensions] of Object.entries(FILE_TYPES)) {
    if (extensions.includes(extension)) return type.toLowerCase();
  }
  return null;
}

export function safeMediaPath(path) {
  if (typeof path !== 'string') return '';
  // 文件路径和 HTTP 资源都可用，拖入的数据不能变成脚本或内联文档。
  if (/^[a-z][a-z\d+.-]*:/i.test(path) && !/^https?:/i.test(path)) return '';
  return path;
}

export function comparisonAsset(item, { libraryId = '', source = 'data', bucket = '', tagDefinitions = {} } = {}) {
  if (!item || typeof item !== 'object') return null;
  const declared = String(item.metadata?.type || item.type || '').toLowerCase();
  const type = DOCUMENT_TYPES.has(declared) ? declared : mediaType(item.path || item.previewImage || '');
  if (!type || (IS_MAD_EDITION && (type === 'actor' || type === 'item'))) return null;
  const uuid = item.metadata?.uuid || item.uuid || '';
  const path = safeMediaPath(item.path || item.previewImage || item.img || '');
  if (!path && !uuid && !item.sceneData && !item.metadata?.sceneData) return null;
  const identity = libraryId && item.id
    ? ['library', libraryId, item.id]
    : uuid ? ['document', uuid] : ['file', source, bucket || '', path];
  return {
    key: JSON.stringify(identity), type, uuid, path,
    libraryId, source, bucket: bucket || '',
    assetId: item.id || '',
    name: item.displayName || item.name || path.split('/').pop() || type,
    thumbnail: safeMediaPath(item.thumbnail || item.previewImage || (type === 'image' || type === 'actor' || type === 'item' ? path : '')),
    // 保留原卡片需要的字段；切换库后仍能预览，当前库中的条目则在使用时重新读取。
    item: { ...item, metadata: { ...item.metadata }, _pos: undefined },
    tagDefinitions: Object.fromEntries((item.tags || []).filter(id => tagDefinitions[id]).map(id => [id, tagDefinitions[id]])),
    metadata: { ...item.metadata, ...(DOCUMENT_TYPES.has(type) ? { type, uuid } : {}) },
    sceneData: item.sceneData || item.metadata?.sceneData || null
  };
}

export function readComparisonDrop(transfer) {
  for (const mime of [COMPARISON_MIME, 'application/x-origin-vault-browser-files', 'application/x-origin-vault-item', 'text/plain']) {
    const raw = transfer?.getData(mime);
    if (!raw) continue;
    try {
      const value = JSON.parse(raw);
      if (value && typeof value === 'object') return { mime, value };
    } catch { /* 普通文本不属于素材拖放，继续检查其他格式。 */ }
  }
  return null;
}

export async function resolveComparisonDrop(transfer, host) {
  const payload = readComparisonDrop(transfer);
  if (!payload) return [];
  const data = payload.value;
  if (payload.mime === COMPARISON_MIME && Array.isArray(data.assets)) {
    return data.assets.map(entry => comparisonAsset({
      ...entry.item,
      id: entry.assetId, type: entry.type, path: entry.path, uuid: entry.uuid,
      name: entry.name, thumbnail: entry.thumbnail, metadata: entry.metadata, sceneData: entry.sceneData
    }, entry)).filter(Boolean);
  }
  if (data.type === 'origin-vault-browser-files' && !data.isDirectory) {
    return (Array.isArray(data.paths) ? data.paths : []).map(path => comparisonAsset({ path }, data)).filter(Boolean);
  }
  if (data.type === 'origin-vault-item' || data.type === 'origin-vault-items') {
    const ids = data.originVault?.itemIds || data.itemIds || [data.itemId];
    return ids.map(id => host.library.getItem(id)).filter(Boolean)
      .map(item => comparisonAsset(item, { libraryId: host.library.basePath, tagDefinitions: host.library.getAllTags?.() || {} })).filter(Boolean);
  }
  if (DOCUMENT_TYPES.has(String(data.type).toLowerCase()) && typeof data.uuid === 'string') {
    const doc = await loadComparisonDocument({ uuid: data.uuid });
    return [comparisonAsset({
      type: doc.documentName.toLowerCase(), uuid: doc.uuid, name: doc.name,
      path: doc.img || doc.background?.src || '', thumbnail: doc.thumb || doc.img || '',
      thumbnailGenerated: !!(doc.thumb || doc.img),
      sceneData: doc.documentName === 'Scene' ? doc.toObject?.() : undefined,
      metadata: { type: doc.documentName.toLowerCase(), uuid: doc.uuid, itemType: doc.type,
        actorType: doc.type, rarity: doc.system?.rarity, width: doc.width, height: doc.height }
    })].filter(Boolean);
  }
  return [];
}

export async function loadComparisonDocument(asset) {
  const doc = await globalThis.fromUuid(asset.uuid);
  // 先验证拖入的来源；打开与悬停时沿用主网格对世界副本的选择规则。
  if (!doc || (!globalThis.game?.user?.isGM && !doc.testUserPermission?.(game.user, 'OBSERVER'))) {
    throw new Error('Comparison source unavailable or inaccessible');
  }
  return doc;
}

export function resolveComparisonItem(asset, library) {
  if (asset.libraryId && asset.libraryId === library.basePath) {
    const item = library.getItem(asset.assetId);
    if (item) return item;
  }
  // 外部条目不能借用当前库的短 ID，否则详情编辑可能误改同 ID 的另一项。
  return {
    ...asset.item,
    id: `ov-compare-${encodeURIComponent(asset.key)}`,
    path: asset.path, name: asset.name, displayName: asset.name,
    source: asset.source, bucket: asset.bucket,
    thumbnail: asset.thumbnail,
    thumbnailGenerated: asset.item?.thumbnailGenerated ?? !!asset.thumbnail,
    metadata: { ...asset.metadata }, sceneData: asset.sceneData,
    tags: asset.item?.tags || [], folders: [],
    aspectRatio: asset.item?.aspectRatio || (asset.metadata?.width / asset.metadata?.height) || (asset.type === 'video' ? 16 / 9 : 1)
  };
}

export class ComparisonSelection {
  constructor() {
    this.items = [];
    this.activeKey = null;
    this.undoItems = null;
  }

  add(assets) {
    let added = 0;
    for (const asset of assets) {
      if (!this.items.some(item => item.key === asset.key)) {
        this.items.push(asset);
        added++;
      }
      this.activeKey = asset.key;
    }
    return added;
  }

  remove(key) {
    const index = this.items.findIndex(item => item.key === key);
    if (index < 0) return;
    this.undoItems = [...this.items];
    this.items.splice(index, 1);
    if (this.activeKey === key) this.activeKey = this.items[Math.min(index, this.items.length - 1)]?.key || null;
  }

  clear() {
    if (!this.items.length) return;
    this.undoItems = [...this.items];
    this.items = [];
    this.activeKey = null;
  }

  undo() {
    if (!this.undoItems) return;
    // 撤销移除时仍保留此后新拖入的资产。
    this.items = [...this.undoItems, ...this.items.filter(item => !this.undoItems.some(old => old.key === item.key))];
    this.undoItems = null;
    this.activeKey ||= this.items[0]?.key || null;
  }

  move(key, targetKey) {
    const item = this.items.find(entry => entry.key === key);
    if (!item || key === targetKey) return;
    const remaining = this.items.filter(entry => entry.key !== key);
    const target = remaining.findIndex(entry => entry.key === targetKey);
    remaining.splice(target < 0 ? remaining.length : target, 0, item);
    this.items = remaining;
  }
}
