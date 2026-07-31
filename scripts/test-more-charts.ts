// Self-check for the "+ More" picker's renderability logic in renderer/hub/hub.js.
// hub.js isn't node-runnable (browser globals), so these mirror the pure helpers —
// keep in sync with canRenderType()/needsText() and the CHART_*_MIN tables.

export {}; // module scope — sibling test scripts share top-level names

const CHART_SERIES_MIN: Record<string, number> = {
  clustered_column: 2, clustered_bar: 2, stacked_column: 2, stacked_bar: 2,
  pct_stacked_column: 2, pct_stacked_bar: 2, stacked_area: 2, combo: 2,
  scatter: 2, bubble: 3, heatmap: 2,
};
const CHART_LABELS_MIN: Record<string, number> = { pie: 2, donut: 2, treemap: 2, heatmap: 2, funnel: 3 };
const MAP_TYPES = new Set(['map_bubble', 'map_choropleth']);

function canRenderType(type: string, numSeries: number, numLabels: number, hasGeo: boolean): boolean {
  if (type === 'table') return true;
  if (MAP_TYPES.has(type)) return !!hasGeo;
  if (numSeries < (CHART_SERIES_MIN[type] || 1)) return false;
  if (numLabels < (CHART_LABELS_MIN[type] || 1)) return false;
  return true;
}
function needsText(type: string, numSeries: number, numLabels: number, hasGeo: boolean): string {
  const parts: string[] = [];
  const ns = CHART_SERIES_MIN[type] || 1, nl = CHART_LABELS_MIN[type] || 1;
  if (MAP_TYPES.has(type) && !hasGeo) parts.push('place or region data');
  if (numSeries < ns) parts.push(`at least ${ns} numeric series`);
  if (numLabels < nl) parts.push(`at least ${nl} categories`);
  return parts.join(' and ') || 'different data';
}

let failures = 0;
function ok(label: string, cond: boolean) { if (cond) console.log('ok   ' + label); else { console.error('FAIL ' + label); failures++; } }

// Renderable vs not — the gate between a best-effort chart and the friendly message.
ok('scatter needs 2 series → 1 series cannot render', !canRenderType('scatter', 1, 5, false));
ok('scatter with 2 series renders', canRenderType('scatter', 2, 5, false));
ok('bubble needs 3 series → 2 cannot render', !canRenderType('bubble', 2, 5, false));
ok('bubble with 3 series renders', canRenderType('bubble', 3, 5, false));
ok('pie needs 2 categories → 1 label cannot render', !canRenderType('pie', 3, 1, false));
ok('pie with 1 series + 2 labels renders', canRenderType('pie', 1, 2, false));
ok('column renders with a single series', canRenderType('column', 1, 1, false));
ok('table always renders', canRenderType('table', 0, 0, false));
ok('region map needs geo → none cannot render', !canRenderType('map_choropleth', 5, 5, false));
ok('region map with geo renders', canRenderType('map_choropleth', 5, 5, true));

// The "what it needs" message names the missing requirement.
ok('scatter message names 2 series', needsText('scatter', 0, 5, false) === 'at least 2 numeric series');
ok('pie message names 2 categories', needsText('pie', 3, 1, false) === 'at least 2 categories');
ok('bubble message names 3 series', needsText('bubble', 1, 1, false) === 'at least 3 numeric series');
ok('map message names place data', needsText('map_bubble', 5, 5, false) === 'place or region data');

// The "+ More" three-tier partition (mirrors buildVizPicker.openMorePanel): a type lives
// in exactly one of Recommended / Selected / Other. Shared by the main view + export dialog.
function tiers(recommended: string[], selectedOthers: string[], pool: string[]) {
  const suited = new Set(recommended);
  const sel = new Set(selectedOthers);
  return {
    recommended: recommended.slice(),
    selected: pool.filter(t => sel.has(t)),
    other: pool.filter(t => !suited.has(t) && !sel.has(t)),
  };
}
const POOL = ['column', 'line', 'pie', 'scatter', 'sankey', 'treemap'];
const t = tiers(['column', 'line'], ['sankey'], POOL);
ok('Selected tier holds pulled-in charts', JSON.stringify(t.selected) === JSON.stringify(['sankey']));
ok('Other excludes recommended + selected', !t.other.includes('column') && !t.other.includes('sankey') && t.other.includes('pie'));
ok('Recommended never leaks into Other', !t.other.includes('line'));
ok('Selected and Other are disjoint', t.selected.every(x => !t.other.includes(x)));
ok('every non-recommended pool type appears once', POOL.filter(x => x !== 'column' && x !== 'line').every(x => (t.selected.includes(x) ? 1 : 0) + (t.other.includes(x) ? 1 : 0) === 1));

if (failures) { console.error('\n' + failures + ' assertion(s) failed'); process.exit(1); }
console.log('\nAll +More renderability checks passed.');
