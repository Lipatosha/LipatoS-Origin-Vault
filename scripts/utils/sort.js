const NATURAL_SORT_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base'
});

export function naturalCompare(a, b) {
  return NATURAL_SORT_COLLATOR.compare(String(a || ''), String(b || ''));
}
