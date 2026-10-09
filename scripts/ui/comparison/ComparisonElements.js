import { t } from '../../utils/i18n.js';

export function comparisonText(key) {
  return t(`origin-vault.comparison.${key}`);
}

export function element(document, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(document, icon, label, action) {
  const node = element(document, 'button', 'ov-compare-button');
  node.type = 'button';
  node.title = label;
  node.setAttribute('aria-label', label);
  node.append(element(document, 'i', `fas ${icon}`));
  node.addEventListener('click', action);
  return node;
}
