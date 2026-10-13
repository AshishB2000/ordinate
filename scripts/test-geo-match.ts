// Self-check for the geo matcher against the real US county boundary asset.
// Run: node scripts/test-geo-match.js   (exits non-zero on failure)
// Reproduces the Virginia capture that originally rendered a blank world map.

export {}; // module scope — sibling test scripts share top-level names

// Explicit annotation (not a cast): assert.ok is an assertion function, and
// TS requires the call target itself to carry a declared type (TS2775).
const assert: typeof import('assert') = require('assert');

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const vm: typeof import('vm') = require('vm');

type Match = (items: any[], props: any, shapeNames?: Set<string>) => any;
type Shapes = { features: any[] };

// ponytail: geoMatch.js is a UMD script (not a TS module) and the
// county asset is postinstall-fetched JSON — require both with loose types.
const { matchGeoItem, featureNameSet, normalizeName } = require('../src/analysis/geoMatch') as {
  matchGeoItem: Match;
  featureNameSet: (features: any[]) => Set<string>;
  normalizeName: (n: string) => string;
};

const counties = require('../assets/geo/us-counties.json') as Shapes;

// The state and world sets ship as `window.__GEO_X__ = {...};` scripts: read the real data.
function windowAsset(file: string, varName: string): Shapes {
  const sandbox: any = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'assets', 'geo', file), 'utf8'), sandbox);
  return sandbox.window[varName];
}
const states = windowAsset('us-states.js', '__GEO_US_STATES__');
const world = windowAsset('world-countries.js', '__GEO_WORLD__');

// Virginia capture: counties + independent cities, including the Roanoke collision.
const items = [
  { name: 'Newport News', state: 'Virginia', kind: 'city',   value: 183230 },
  { name: 'Stafford',     state: 'Virginia', kind: 'county', value: 170803 },
  { name: 'Alexandria',   state: 'Virginia', kind: 'city',   value: 160662 },
  { name: 'Roanoke',      state: 'Virginia', kind: 'county', value: 98434  },
  { name: 'Roanoke',      state: 'Virginia', kind: 'city',   value: 99111  },
  { name: 'James City',   state: 'Virginia', kind: 'county', value: 83326  },
];

// Find the GeoJSON feature for a given VA name + kind.
function feat(name: string, kind: string) {
  return counties.features.find(f =>
    f.properties.state === 'Virginia' &&
    f.properties.name === name &&
    f.properties.kind === kind
  );
}

// Independent city resolves to the city item, not a county.
const npn = matchGeoItem(items, feat('Newport News', 'city').properties);
assert(npn && npn.value === 183230, 'Newport News should match the city item');

// County resolves to the county item.
const stafford = matchGeoItem(items, feat('Stafford', 'county').properties);
assert(stafford && stafford.value === 170803, 'Stafford should match the county item');

// The Roanoke collision: county feature → county item, city feature → city item.
const roCounty = matchGeoItem(items, feat('Roanoke', 'county').properties);
const roCity   = matchGeoItem(items, feat('Roanoke', 'city').properties);
assert(roCounty && roCounty.value === 98434, 'Roanoke county feature should match the county item');
assert(roCity   && roCity.value   === 99111, 'Roanoke city feature should match the city item');

// "James City" (a real county) survives the "city" suffix stripping.
const jc = matchGeoItem(items, feat('James City', 'county').properties);
assert(jc && jc.value === 83326, 'James City county should match');

// A feature in a different state must NOT match a VA item with the same name.
const otherState = matchGeoItem(items, { name: 'Roanoke', state: 'Texas', kind: 'county' });
assert(otherState === undefined, 'Same name in another state must not match');

// Every capture item should place against some feature (no blank-globe leftovers).
const placed = items.filter(it =>
  counties.features.some(f => matchGeoItem([it], f.properties))
);
assert(placed.length === items.length, `all ${items.length} items should place; placed ${placed.length}`);

// ── A row is never lent to a shape it merely resembles ───────────────────────
// "Arkansas" contains "kansas" and "West Virginia" contains "virginia". A
// first-hit rule that takes an exact OR a substring match paints the Kansas
// shape with Arkansas's figure and West Virginia with Virginia's — in the row
// order of a real file, ranked by population.
const ranked = [
  { name: 'Virginia', value: 8752297 },
  { name: 'Arkansas', value: 3089060 },
  { name: 'Kansas', value: 2944376 },
  { name: 'West Virginia', value: 1766107 },
];
const without = (name: string) => ranked.filter(r => r.name !== name);

// What a map paints: each shape's figure by shape name (absent = no data).
function painted(match: Match, shapes: Shapes, rows: any[]): Record<string, number> {
  const names = featureNameSet(shapes.features);
  const out: Record<string, number> = {};
  for (const f of shapes.features) {
    const hit = match(rows, f.properties, names);
    if (hit) out[f.properties.name] = hit.value;
  }
  return out;
}

// Every case as [what it proves, what the map paints, what it must paint].
function cases(match: Match): Array<[string, Record<string, number>, Record<string, number>]> {
  const everyState = states.features.map((f, i) => ({ name: f.properties.name as string, value: i }));
  return [
    ['four states in rank order: every shape takes its own row', painted(match, states, ranked),
      { Virginia: 8752297, Arkansas: 3089060, Kansas: 2944376, 'West Virginia': 1766107 }],
    ['Kansas filtered out: its shape takes NO row, not Arkansas\'s', painted(match, states, without('Kansas')),
      { Virginia: 8752297, Arkansas: 3089060, 'West Virginia': 1766107 }],
    ['West Virginia filtered out: its shape takes NO row, not Virginia\'s', painted(match, states, without('West Virginia')),
      { Virginia: 8752297, Arkansas: 3089060, Kansas: 2944376 }],
    ['every state, last shape\'s row first: each shape takes its own row', painted(match, states, [...everyState].reverse()),
      Object.fromEntries(everyState.map(r => [r.name, r.value]))],
    ['Niger then Nigeria: each country takes its own row',
      painted(match, world, [{ name: 'Niger', value: 1 }, { name: 'Nigeria', value: 2 }]), { Niger: 1, Nigeria: 2 }],
    ['Niger alone: the Nigeria shape takes no row', painted(match, world, [{ name: 'Niger', value: 1 }]), { Niger: 1 }],
    // A variant that names no shape of its own still finds its shape by substring.
    ['"United States of America" still paints the United States shape',
      painted(match, world, [{ name: 'United States of America', value: 7 }]), { 'United States': 7 }],
    ['"United States" still paints a shape named "United States of America"',
      painted(match, { features: [{ properties: { name: 'United States of America' } }, { properties: { name: 'Canada' } }] },
        [{ name: 'United States', value: 7 }]), { 'United States of America': 7 }],
  ];
}
const wrong = (match: Match) => cases(match).filter(([, got, want]) => {
  try { assert.deepStrictEqual(got, want); return false; } catch (_) { return true; }
}).map(([label]) => label);

assert.deepStrictEqual(wrong(matchGeoItem), [], 'a row painted a shape that is not its own');

// Without the collection's names the matcher cannot tell a variant from a
// neighbour, but an exact match still wins over an earlier substring one.
const kansas = states.features.find(f => f.properties.name === 'Kansas').properties;
assert(matchGeoItem(ranked, kansas).value === 2944376, 'exact beats an earlier substring hit without shape names');

// NEGATIVE CONTROL: the rule this replaced — the first row that matches exactly
// OR by substring — re-declared only to prove the cases above catch it. It must
// fail every mis-join case and pass the two variant cases.
const firstHit: Match = (rows, props) => {
  const feat = normalizeName(props.name);
  return rows.find(r => {
    const n = normalizeName(r.name);
    return n === feat || (n.length > 4 && (feat.includes(n) || n.includes(feat)));
  });
};
assert.deepStrictEqual(wrong(firstHit), cases(firstHit).slice(0, 6).map(([label]) => label),
  'negative control: the first-hit rule must fail exactly the six mis-join cases');

console.log('geo-match self-check passed (' + items.length + ' Virginia items placed)');
