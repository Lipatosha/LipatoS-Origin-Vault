function unwrapElement(node) {
  if (!node) return null;
  if (node.jquery) return node[0] ?? null;
  return node;
}

function findOriginVaultContainer(node) {
  const element = unwrapElement(node);
  if (!element) return null;
  if (element.classList?.contains('origin-vault-container')) return element;
  return element.querySelector?.('.origin-vault-container')
    || element.closest?.('.origin-vault-container')
    || null;
}

export function resolveOverlayHost({ owner = null, ownerElement = null, preferContainer = true } = {}) {
  const candidates = [ownerElement, owner?.element, owner?.parentElement];

  for (const candidate of candidates) {
    const element = unwrapElement(candidate);
    if (!element) continue;

    if (preferContainer) {
      const container = findOriginVaultContainer(element);
      if (container) return container;
    }

    return element;
  }

  if (preferContainer) {
    const activeContainer = document.querySelector('.origin-vault-container');
    if (activeContainer) return activeContainer;
  }

  return document.body;
}

export function appendToOverlayHost(node, options = {}) {
  const element = unwrapElement(node);
  if (!element) return null;

  const host = resolveOverlayHost(options);
  host.appendChild(element);
  return host;
}

export function appendJQueryToOverlayHost(node, options = {}) {
  const host = resolveOverlayHost(options);
  if (!host || !node) return host;

  if (node.appendTo) {
    node.appendTo(host);
  } else {
    const element = unwrapElement(node);
    if (element) host.appendChild(element);
  }

  return host;
}

export function getOverlayHostRect(options = {}) {
  const host = resolveOverlayHost(options);
  if (!host || host === document.body || host === document.documentElement) {
    return {
      host: document.body,
      rect: {
        left: 0,
        top: 0,
        right: window.innerWidth,
        bottom: window.innerHeight,
        width: window.innerWidth,
        height: window.innerHeight
      }
    };
  }

  return {
    host,
    rect: host.getBoundingClientRect()
  };
}
