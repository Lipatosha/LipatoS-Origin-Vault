function getI18n() {
  return globalThis.game?.i18n ?? null;
}

export function hasTranslation(key, fallback = true) {
  const i18n = getI18n();
  if (!i18n?.has) return false;
  return i18n.has(key, fallback);
}

export function t(key, data) {
  const i18n = getI18n();
  if (!i18n?.localize) return key;

  if (data && typeof data === 'object' && Object.keys(data).length) {
    if (typeof i18n.format === 'function') return i18n.format(key, data);
    return i18n.localize(key, data);
  }

  return i18n.localize(key);
}

export function tf(key, data) {
  return t(key, data);
}

export function ensureI18nCompat() {
  const i18n = getI18n();
  if (!i18n?.localize || typeof i18n.format === 'function' || i18n._ovFormatCompatInstalled) {
    return false;
  }

  // V14 开始 localize 已经能带替换参数了，这里补回 format，
  // 这样老代码先别炸，后面再慢慢迁。
  i18n.format = (key, data) => i18n.localize(key, data);
  i18n._ovFormatCompatInstalled = true;
  return true;
}
