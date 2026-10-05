// Place-name matching — src/analysis/geoMatch.ts as an ES module. PURE. The
// server side keeps the desktop file (main requires it); geo.test.ts holds the
// two equal.

/**
 * Lowercase, drop parentheticals and admin suffixes (County/Parish/Borough/
 * City/Town), collapse spaces. Item and feature names both go through it.
 * ponytail: stripping "city" also flattens "James City" → "james"; both sides
 * strip it, so the match still holds and state + kind disambiguate.
 */
export function normalizeName(n: string | null | undefined): string {
  return (n || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(county|parish|borough|census area|municipality|city|town)\b/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

interface Matchable {
  name: string;
  state?: string;
  kind?: string;
}

/**
 * The item a GeoJSON feature stands for. For US sub-state levels, state and
 * kind (county vs independent city) must agree when both sides carry them —
 * that is what tells Roanoke county from Roanoke city.
 */
export function matchGeoItem<T extends Matchable>(items: readonly T[], featProps: Record<string, unknown>): T | undefined {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const featName = normalizeName(str(featProps.name));
  const featIso2 = str(featProps.iso2).toLowerCase();
  const featState = normalizeName(str(featProps.state));
  const featKind = str(featProps.kind).toLowerCase();
  for (const item of items) {
    if (featState && item.state && normalizeName(item.state) !== featState) continue;
    if (featKind && item.kind && String(item.kind).toLowerCase() !== featKind) continue;
    const itemName = normalizeName(item.name);
    if (itemName === featName) return item;
    // Substring match for variants ("United States" vs "United States of America").
    if (itemName.length > 4 && (featName.includes(itemName) || itemName.includes(featName))) return item;
    if (featIso2 && featIso2 === normalizeName(item.name).slice(0, 2)) return item;
  }
  return undefined;
}
