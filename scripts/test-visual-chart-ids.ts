// Self-check: MAIN's SUGGESTABLE_CHART_TYPES cannot name a chart nothing can
// draw.
//
// The list the desktop drew from was `ALL_CHART_TYPE_IDS` in its renderResult.ts,
// a classic global-scope <script> src/analysis/visuals.ts could not import, so
// visuals.ts keeps its own copy for the AI prompt. Separate lists drift, and the
// drift is SILENT: the model proposes a type nothing can render and the user
// gets an empty option with no error anywhere.
//
// The desktop list went with the desktop app (T8.1). The literal as this test
// parsed it is the golden fixture scripts/fixtures/golden/chartIds.json
// (`parsedIds`, scripts/golden.ts); web/src/charts/legacy.test.ts pins the web
// engine's ids to the same desktop set.

import { SUGGESTABLE_CHART_TYPES } from '../src/analysis/visuals';
import { golden } from './golden';

import { ok, failureCount } from './selfcheck';

function main(): void {
  const rendererIds = golden<{ parsedIds: string[] }>('chartIds').parsedIds;

  ok('ALL_CHART_TYPE_IDS was recorded from the desktop renderResult.ts',
     Array.isArray(rendererIds) && rendererIds.length > 0,
     rendererIds ? `${rendererIds.length} ids` : 'NOT FOUND');
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

  if (failureCount()) {
    console.error(`\n${failureCount()} check(s) FAILED.`);
    process.exit(1);
  }
  console.log('\nAll chart-id checks passed.');
}

main();
