// Pure geo name-matching helpers, shared by the renderer (loaded as a <script>
// that attaches to window) and the Node self-check (scripts/test-geo-match.js,
// which require()s this file). No DOM or Leaflet dependencies — keep it pure.
(function (global: any) {

  // Normalize a place name for matching: lowercase, drop parentheticals and admin
  // suffixes (County/Parish/Borough/City/Town), collapse spaces. Both the AI item
  // and the GeoJSON feature go through this, so they normalize identically.
  // ponytail: stripping "city" also flattens names like "James City" → "james",
  // but since both sides strip it the match still holds; state+kind disambiguate.
  function normalizeName(n: string | null | undefined): string {
    return (n || '')
      .toLowerCase()
      .replace(/\([^)]*\)/g, ' ')
      .replace(/\b(county|parish|borough|census area|municipality|city|town)\b/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  // Match an AI-provided place against a GeoJSON feature's properties.
  // For US sub-state levels, state + kind (county vs independent city) must agree
  // when both sides carry them — that's what tells "Roanoke" county from city.
  function matchGeoItem(geoItems: any[], featProps: any): any | undefined {
    const featName = normalizeName(featProps.name || '');
    const featIso2 = (featProps.iso2 || '').toLowerCase();
    const featState = normalizeName(featProps.state || '');
    const featKind = (featProps.kind || '').toLowerCase();
    for (const item of geoItems) {
      if (featState && item.state && normalizeName(item.state) !== featState) continue;
      if (featKind && item.kind && String(item.kind).toLowerCase() !== featKind) continue;
      const itemName = normalizeName(item.name);
      if (itemName === featName) return item;
      // Substring match for variants ("United States" vs "United States of America")
      if (itemName.length > 4 && (featName.includes(itemName) || itemName.includes(featName))) return item;
      if (featIso2 && featIso2 === normalizeName(item.name).slice(0, 2)) return item;
    }
    return undefined;
  }

  const api = { normalizeName, matchGeoItem };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;            // Node (self-check)
  } else {
    global.normalizeName = normalizeName;  // Browser (hub.js uses these globals)
    global.matchGeoItem = matchGeoItem;
  }

})(typeof window !== 'undefined' ? window : globalThis);
