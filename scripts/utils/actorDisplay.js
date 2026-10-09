import { hasTranslation, t } from './i18n.js';

export function getActorTypeLabel(actorType = 'npc') {
  if (!actorType) return '';

  const typeKey = `TYPES.Actor.${actorType}`;
  if (hasTranslation(typeKey)) return t(typeKey);

  const configuredLabel = CONFIG.Actor?.typeLabels?.[actorType];
  if (typeof configuredLabel === 'string') {
    return hasTranslation(configuredLabel, false) ? t(configuredLabel) : configuredLabel;
  }

  return actorType.charAt(0).toUpperCase() + actorType.slice(1);
}

export function getActorSystemId(source = null) {
  return source?.metadata?.systemId
    || source?.systemId
    || game.system?.id
    || '';
}

export function isDnd5eActor(source = null) {
  return getActorSystemId(source) === 'dnd5e';
}

export function getActorSystemData(source = null) {
  return source?.system
    || source?.systemData
    || source?.metadata?.systemData
    || {};
}

function readString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    return readString(value.name)
      || readString(value.label)
      || readString(value.value)
      || readString(value.slug);
  }
  return '';
}

function isInternalActorToken(value) {
  if (!value) return true;
  if (/^(Actor|Item|Compendium)\./i.test(value)) return true;
  return /^[A-Za-z0-9]{16,}$/.test(value);
}

function localizeMaybe(value) {
  if (!value) return '';
  return hasTranslation(value, false) ? t(value) : value;
}

function readDisplayText(value) {
  const text = readString(value);
  return isInternalActorToken(text) ? '' : localizeMaybe(text);
}

export function escapeActorDisplayText(value) {
  return readString(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatChallengeRating(value) {
  if (value === null || value === undefined || value === '') return '';
  const raw = typeof value === 'object' ? value.value : value;
  if (raw === null || raw === undefined || raw === '') return '';

  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return String(raw).trim();
  if (numeric === 0.125) return '1/8';
  if (numeric === 0.25) return '1/4';
  if (numeric === 0.5) return '1/2';
  if (Number.isInteger(numeric)) return String(numeric);
  return String(raw).trim();
}

export function getDnd5eActorParts(source = null) {
  const metadata = source?.metadata || {};
  const system = getActorSystemData(source);
  const details = system.details || {};
  const creatureTypeValue = readString(details.type?.value || details.type);
  const creatureTypeLabel = readDisplayText(details.type?.label)
    || readDisplayText(details.type?.custom)
    || readDisplayText(CONFIG.DND5E?.creatureTypes?.[creatureTypeValue]?.label)
    || readDisplayText(creatureTypeValue);

  const race = readDisplayText(metadata.actorRace)
    || readDisplayText(details.race?.name)
    || readDisplayText(details.race)
    || readDisplayText(system.race)
    || creatureTypeLabel;

  const cr = formatChallengeRating(
    metadata.actorCr
    ?? details.cr
    ?? system.cr
    ?? system.attributes?.cr
  );

  return { race, cr };
}

export function getActorBadgeLabel(source = null, doc = null) {
  const actorType = doc?.type || source?.metadata?.actorType || source?.actorType || 'npc';

  if (isDnd5eActor(source || doc)) {
    if (actorType === 'character') return getActorTypeLabel(actorType);

    const parts = getDnd5eActorParts(doc || source);
    const labels = [];
    if (parts.race) labels.push(parts.race);
    if (parts.cr) labels.push(`CR ${parts.cr}`);
    if (labels.length) return labels.join(' · ');
  }

  return getActorTypeLabel(actorType);
}

export function getActorPreviewMeta(source = null, doc = null) {
  const actorType = doc?.type || source?.metadata?.actorType || source?.actorType || 'npc';
  const systemSource = doc || source;
  const dndParts = isDnd5eActor(systemSource) && actorType !== 'character'
    ? getDnd5eActorParts(systemSource)
    : { race: '', cr: '' };

  return {
    name: doc?.name || source?.displayName || source?.name || '',
    imgSrc: doc?.img || source?.path || source?.thumbnail || 'icons/svg/mystery-man.svg',
    actorType,
    typeLabel: getActorTypeLabel(actorType),
    badgeLabel: getActorBadgeLabel(source, doc),
    isDnd5e: isDnd5eActor(systemSource),
    race: dndParts.race,
    cr: dndParts.cr
  };
}
