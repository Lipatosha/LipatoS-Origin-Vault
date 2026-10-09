import { ovText } from '../utils/locale.js';
import { naturalCompare } from './sort.js';

export function getCompendiumPackSourceMeta(pack, { iconClass = 'fas fa-folder-open' } = {}) {
  const packageType = pack?.metadata?.packageType || 'unknown';
  const packageName = pack?.metadata?.packageName || '';

  let sourceId = packageName;
  if (!sourceId && packageType === 'system') sourceId = game.system?.id || '';
  if (!sourceId && packageType === 'world') sourceId = game.world?.id || '';

  let name = sourceId || pack?.metadata?.label || pack?.collection || ovText('Unknown Source', 'Неизвестный источник');
  if (packageType === 'module' && sourceId) {
    name = game.modules.get(sourceId)?.title || name;
  } else if (packageType === 'system' && sourceId) {
    name = (game.system?.id === sourceId ? game.system?.title : null) || name;
  } else if (packageType === 'world') {
    name = game.world?.title || name;
  }

  return {
    key: sourceId ? `${packageType}:${sourceId}` : `pack:${pack.collection}`,
    sourceId,
    packageType,
    name,
    iconClass
  };
}

export function getCompendiumPackGroupCollapsed(host, stateKey, groupKey) {
  host[stateKey] ??= new Map();
  if (!host[stateKey].has(groupKey)) {
    host[stateKey].set(groupKey, true);
  }
  return host[stateKey].get(groupKey);
}

export function setCompendiumPackGroupCollapsed(host, stateKey, groupKey, collapsed) {
  host[stateKey] ??= new Map();
  host[stateKey].set(groupKey, collapsed);
}

export function buildCompendiumPackGroups(host, packs, {
  stateKey,
  getCount,
  sourceIconClass = 'fas fa-folder-open',
  isSelected = () => false
} = {}) {
  const entries = packs.map(pack => {
    const source = getCompendiumPackSourceMeta(pack, { iconClass: sourceIconClass });
    return {
      id: pack.collection,
      name: pack.metadata.label,
      count: getCount(pack),
      sourceKey: source.key,
      sourceId: source.sourceId,
      sourceName: source.name,
      sourceType: source.packageType,
      sourceIconClass: source.iconClass,
      selected: isSelected(pack.collection)
    };
  });

  const groups = new Map();
  for (const entry of entries) {
    let group = groups.get(entry.sourceKey);
    if (!group) {
      group = {
        key: entry.sourceKey,
        name: entry.sourceName,
        sourceId: entry.sourceId,
        sourceType: entry.sourceType,
        sourceIconClass: entry.sourceIconClass,
        packs: []
      };
      groups.set(entry.sourceKey, group);
    }
    group.packs.push(entry);
  }

  return Array.from(groups.values())
    .sort((a, b) => naturalCompare(a.name, b.name))
    .map(group => {
      const sortedPacks = [...group.packs].sort((a, b) => naturalCompare(a.name, b.name));

      const allCountsKnown = sortedPacks.every(pack => Number.isInteger(pack.count));
      const totalCount = allCountsKnown
        ? sortedPacks.reduce((sum, pack) => sum + pack.count, 0)
        : '?';

      return {
        isGroup: true,
        key: group.key,
        name: group.name,
        sourceId: group.sourceId,
        sourceType: group.sourceType,
        sourceIconClass: group.sourceIconClass,
        packCount: sortedPacks.length,
        totalCount,
        allSelected: sortedPacks.length > 0 && sortedPacks.every(pack => pack.selected),
        collapsed: getCompendiumPackGroupCollapsed(host, stateKey, group.key),
        packs: sortedPacks
      };
    });
}

export function bindCompendiumPackGroupToggles(panelEl, host, {
  stateKey,
  selector = '.item-pack-group-header'
} = {}) {
  panelEl.find(selector).off('click').on('click', (event) => {
    if (event.target.closest('.compendium-batch-group-checkbox')) return;
    event.preventDefault();
    event.stopPropagation();

    const header = event.currentTarget;
    const groupKey = header.dataset.groupKey;
    const groupEl = header.closest('.item-pack-group');
    if (!groupKey || !groupEl) return;

    const nextCollapsed = !groupEl.classList.contains('collapsed');
    groupEl.classList.toggle('collapsed', nextCollapsed);
    header.setAttribute('aria-expanded', String(!nextCollapsed));
    setCompendiumPackGroupCollapsed(host, stateKey, groupKey, nextCollapsed);
  });
}
