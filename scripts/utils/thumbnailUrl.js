export function createThumbnailRevision() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getThumbnailCacheKey(item) {
  return item?.thumbnailRevision
    || item?.thumbnailUpdatedAt
    || item?.thumbnailVersion
    || 1;
}

export function buildThumbnailSrc(item, thumbnailPath = item?.thumbnail) {
  if (!thumbnailPath) return '';

  const separator = String(thumbnailPath).includes('?') ? '&' : '?';
  return `${thumbnailPath}${separator}v=${encodeURIComponent(getThumbnailCacheKey(item))}`;
}
