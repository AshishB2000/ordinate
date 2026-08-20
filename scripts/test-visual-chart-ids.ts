// Self-check: MAIN's SUGGESTABLE_CHART_TYPES cannot name a chart the RENDERER
// cannot draw.
//
// The two lists are unavoidably separate. `ALL_CHART_TYPE_IDS` lives in
// renderer/hub/renderResult.ts, a classic global-scope <script> with no exports,
// so src/visuals.ts cannot import it and keeps its own copy for the AI prompt.
// Separate lists drift, and the drift is SILENT: the model proposes a type
// nothing can render and the user gets an empty option with no error anywhere.
//
// So this test reads the renderer file as TEXT and parses the literal out of it.
// Deliberately not `require()` — importing a classic script would need a DOM and
// a global scope it does not have here. A regex over the source is the cheap
// thing that fails the moment either list changes without the other.

import * as fs from 'fs';
import * as path from 'path';
import { SUGGESTABLE_CHART_TYPES } from '../src/analysis/visuals';

let failures = 0;
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) console.log('ok   ' + label + (detail ? '  ' + detail : ''));
  else {
    console.error('FAIL ' + label + (detail ? '  ' + detail : ''));
    failures++;
  }
}

// Parse `const ALL_CHART_TYPE_IDS = [ 'a', 'b', … ];` out of the renderer source.
function parseRendererIds(src: string): string[] | null {
  const m = /const\s+ALL_CHART_TYPE_IDS\s*=\s*\[([\s\S]*?)\]/.exec(src);
  if (!m) return null;
  const ids = m[1].match(/'([a-z_]+)'/g);
  return ids ? ids.map((s) => s.slice(1, -1)) : null;
}

function main(): void {
  const file = path.join(__dirname, '..', 'renderer', 'hub', 'renderResult.ts');
  const src = fs.readFileSync(file, 'utf8');
  const rendererIds = parseRendererIds(src);

  ok('ALL_CHART_TYPE_IDS was found in renderer/hub/renderResult.ts',
     Array.isArray(rendererIds) && rendererIds.length > 0,
     rendererIds ? `${rendererIds.length} ids` : 'NOT FOUND — did the literal move or get renamed?');
  if (!rendererIds) {
    process.exit(1);
  }

  // The whole point: every id the model may be told about must be drawable.
  const known = new Set(rendererIds);
  const unknown = SUGGESTABLE_CHART_TYPES.filter((t) => !known.has(t));
  ok('every SUGGESTABLE_CHART_TYPES id is in ALL_CHART_TYPE_IDS',
     unknown.length === 0,
     unknown.length ? 'renderer cannot draw: ' + unknown.join(', ') : `${SUGGESTABLE_CHART_TYPES.length} ids`);

  // Guards against the list quietly becoming empty or gaining a duplicate — both
  // would still pass the subset check above while making the prompt nonsense.
  ok('the list is non-empty', SUGGESTABLE_CHART_TYPES.length > 0);
  ok('the list has no duplicates',
     new Set(SUGGESTABLE_CHART_TYPES).size === SUGGESTABLE_CHART_TYPES.length);

  // A map or a table needs something the model is never asked for (a geo level)
  // or is a fallback rather than a proposal. Neither belongs in the prompt.
  ['table', 'map_bubble', 'map_choropleth'].forEach((t) => {
    ok(`'${t}' is deliberately NOT suggestable`, SUGGESTABLE_CHART_TYPES.indexOf(t) < 0);
  });

  if (failures) {
    console.error(`\n${failures} check(s) FAILED.`);
    process.exit(1);
  }
  console.log('\nAll chart-id checks passed.');
}

main();
