/** Preserve English and Chinese UI, show hand-written Russian fallback strings in Russian Foundry. */
export function ovText(english, russian) {
    return String(globalThis.game?.i18n?.lang ?? 'en').toLowerCase().startsWith('ru') ? russian : english;
}
