// Self-check for the geo-join layer (src/analysis/geoMatch.ts) across all five
// choropleth levels named in src/analyze.ts GEO_LEVELS: country, us_state,
// us_county, us_city, us_zip.  (`point` needs no name join — it carries lat/lng.)
//
// This file imports the REAL matcher and the REAL shipped boundary assets. It
// deliberately does NOT re-declare any helper inline: docs/phase-0/README.md §5
// records three test files that mirror renderer helpers and therefore keep
// passing after the originals are deleted. geoMatch is node-importable exactly
// so this file doesn't have to be a fourth one.
//
// Renderer-agnostic by design: the join is pure string work, so the Leaflet →
// MapLibre port (Phase 4) must not need to touch it. The §0 block below locks
// that in.
//
// Run: node scripts/test-geoLevels.js   (exits non-zero on failure)

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

// ponytail: geoMatch.js is a UMD script (not a TS module) and the
// boundary sets are postinstall-fetched build output — require both with loose types.
const { normalizeName, matchGeoItem } = require('../src/analysis/geoMatch') as {
  normalizeName: (n: string | null | undefined) => string;
  matchGeoItem: (items: any[], featProps: any) => any;
};

const GEO_DIR = path.join(__dirname, '..', 'assets', 'geo');

// The world/state sets ship as `window.__GEO_X__ = {...};` script assets (they are
// eager <script> tags in the hub). Evaluate them in a throwaway context to read
// the real data rather than hand-copying a fixture.
function loadWindowAsset(file: string, varName: string): { features: any[] } {
  const sandbox: any = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(GEO_DIR, file), 'utf8'), sandbox);
  return sandbox.window[varName];
}

const WORLD = loadWindowAsset('world-countries.js', '__GEO_WORLD__');
const STATES = loadWindowAsset('us-states.js', '__GEO_US_STATES__');
const COUNTIES = require('../assets/geo/us-counties.json') as { features: any[] };


// Feature-property lookups against the real assets.
function worldProps(name: string) {
  const f = WORLD.features.find(x => x.properties.name === name);
  if (!f) throw new Error('world asset has no feature named ' + name);
  return f.properties;
}
function stateProps(name: string) {
  const f = STATES.features.find(x => x.properties.name === name);
  if (!f) throw new Error('us-states asset has no feature named ' + name);
  return f.properties;
}
function countyProps(name: string, kind: string, state: string) {
  const f = COUNTIES.features.find(x =>
    x.properties.name === name && x.properties.kind === kind && x.properties.state === state);
  if (!f) throw new Error(`us-counties asset has no ${kind} "${name}" in ${state}`);
  return f.properties;
}

// ── §0 renderer-agnosticism: the join layer must stay pure ───────────────────
// Phase 4 swaps Leaflet for MapLibre in mapRender.ts. If a future change reaches
// for L.latLng / map / a DOM node from inside geoMatch, the join stops being
// portable and this suite stops being runnable under plain node. Assert on the
// source, the same way test-formula asserts formula.ts contains no `eval`.
const GEOMATCH_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'analysis', 'geoMatch.ts'), 'utf8');
// Comments are stripped first: the file's own header prose says "No DOM or
// Leaflet dependencies", which a naive source grep would flag as a hit.
const GEOMATCH_CODE = GEOMATCH_SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
ok('geoMatch.ts names no map renderer (leaflet/maplibre/deck.gl)',
  !/\bleaflet\b|\bmaplibre\b|deck\.gl|\bL\./i.test(GEOMATCH_CODE));
ok('geoMatch.ts touches no DOM', !/\bdocument\b|\bHTMLElement\b|createElement/.test(GEOMATCH_CODE));
ok('geoMatch.ts has no import/require of its own', !/\bimport\b|\brequire\s*\(/.test(GEOMATCH_CODE));
ok('geoMatch is loadable under plain node (no browser globals needed)',
  typeof normalizeName === 'function' && typeof matchGeoItem === 'function');

// ── §1 normalizeName: the shared normalization both sides go through ─────────
ok('normalize: lowercases and collapses whitespace', normalizeName('  NEW   YORK  ') === 'new york');
ok('normalize: null/undefined → empty string', normalizeName(null) === '' && normalizeName(undefined) === '');
ok('normalize: strips a "County" suffix', normalizeName('Stafford County') === 'stafford');
ok('normalize: strips a Louisiana "Parish" suffix', normalizeName('Acadia Parish') === 'acadia');
ok('normalize: strips an Alaska "Borough" suffix', normalizeName('Kenai Peninsula Borough') === 'kenai peninsula');
ok('normalize: strips "Census Area"', normalizeName('Valdez-Cordova Census Area') === 'valdez-cordova');
ok('normalize: strips "Municipality"', normalizeName('Anchorage Municipality') === 'anchorage');
ok('normalize: drops a parenthetical', normalizeName('Newport News (City)') === 'newport news');
ok('normalize: suffix strip is word-bounded — "Hillsborough" survives intact',
  normalizeName('Hillsborough') === 'hillsborough');
ok('normalize: a ZIP code passes through unchanged (leading zero kept)',
  normalizeName('01001') === '01001');
ok('normalize is idempotent', normalizeName(normalizeName('Stafford County')) === normalizeName('Stafford County'));

// ── §2 level: country (assets/geo/world-countries.js, 177 features) ──────────
const usa = worldProps('United States');
ok('country: exact name matches', matchGeoItem([{ name: 'United States', value: 1 }], usa)?.value === 1);
ok('country: case/spacing insensitive', matchGeoItem([{ name: '  united   states ', value: 2 }], usa)?.value === 2);
ok('country: "United States of America" matches via the substring rule',
  matchGeoItem([{ name: 'United States of America', value: 3 }], usa)?.value === 3);
ok('country: an unrelated name does not match', matchGeoItem([{ name: 'Canada', value: 4 }], usa) === undefined);
ok('country: no items → undefined, no throw', matchGeoItem([], usa) === undefined);
ok('country: first matching item wins',
  matchGeoItem([{ name: 'United States', value: 10 }, { name: 'United States', value: 20 }], usa)?.value === 10);

// The substring rule is gated on the ITEM name being longer than 4 characters, so
// short country names only ever match exactly. Chad (4) is the boundary case.
const chad = worldProps('Chad');
ok('country: a 4-char name still matches exactly', matchGeoItem([{ name: 'Chad', value: 5 }], chad)?.value === 5);
ok('country: a <=4-char item never substring-matches ("Chad" vs "Chile")',
  matchGeoItem([{ name: 'Chad' }], worldProps('Chile')) === undefined);

// The iso2 fall-back branch in matchGeoItem is DEAD against the shipped asset:
// download-geo.ts reads ISO_A2 from the source GeoJSON, and the pinned
// D3-graph-gallery world.geojson carries no such property. Recorded, not
// asserted-as-desirable — if a future asset populates iso2 this flips and the
// "USA" case below starts matching, which would be an improvement, not a break.
ok('country: every shipped feature has an empty iso2 (the iso2 branch is unreachable)',
  WORLD.features.every(f => !f.properties.iso2));
ok('country: KNOWN GAP — a 3-letter alias like "USA" does not match (iso2 is empty)',
  matchGeoItem([{ name: 'USA', value: 6 }], usa) === undefined);

// ── §3 level: us_state (assets/geo/us-states.js, 52 features) ────────────────
const virginia = stateProps('Virginia');
ok('us_state: exact name matches', matchGeoItem([{ name: 'Virginia', value: 1 }], virginia)?.value === 1);
ok('us_state: uppercase item matches', matchGeoItem([{ name: 'VIRGINIA', value: 2 }], virginia)?.value === 2);
// State features carry only `name` — no `state`/`kind` props — so the two guard
// clauses are skipped and an item that redundantly carries `state` still matches.
ok('us_state: feature has no state/kind props', virginia.state === undefined && virginia.kind === undefined);
ok('us_state: an item carrying a redundant state field is not rejected',
  matchGeoItem([{ name: 'Virginia', state: 'Virginia', value: 3 }], virginia)?.value === 3);
ok('us_state: DC/PR are present in the asset (52 features, not 50)', STATES.features.length === 52);
// Every state name in the asset must round-trip through the matcher.
const allStatesPlace = STATES.features.every(f =>
  matchGeoItem([{ name: f.properties.name, value: 1 }], f.properties) !== undefined);
ok('us_state: all 52 features place from their own name', allStatesPlace);

// ── §4 level: us_county (assets/geo/us-counties.json, 3,221 features) ────────
const staffordCo = countyProps('Stafford', 'county', 'Virginia');
ok('us_county: bare item name matches a bare feature name',
  matchGeoItem([{ name: 'Stafford', state: 'Virginia', kind: 'county', value: 1 }], staffordCo)?.value === 1);
ok('us_county: a "County"-suffixed item still matches (both sides normalize)',
  matchGeoItem([{ name: 'Stafford County', state: 'Virginia', kind: 'county', value: 2 }], staffordCo)?.value === 2);
ok('us_county: an item with no kind is not rejected (guard needs both sides)',
  matchGeoItem([{ name: 'Stafford', state: 'Virginia', value: 3 }], staffordCo)?.value === 3);
ok('us_county: an item with no state is not rejected either',
  matchGeoItem([{ name: 'Stafford', value: 4 }], staffordCo)?.value === 4);
ok('us_county: a mismatched state IS rejected — name collisions across states',
  matchGeoItem([{ name: 'Stafford', state: 'Texas', value: 5 }], staffordCo) === undefined);

// Louisiana parishes and Alaska boroughs: the asset stores bare names, the model
// emits the local administrative word. Suffix stripping is what bridges them.
ok('us_county: Louisiana "Acadia Parish" places',
  matchGeoItem([{ name: 'Acadia Parish', state: 'Louisiana', kind: 'county', value: 1 }],
    countyProps('Acadia', 'county', 'Louisiana'))?.value === 1);
ok('us_county: Alaska "Kenai Peninsula Borough" places',
  matchGeoItem([{ name: 'Kenai Peninsula Borough', state: 'Alaska', kind: 'county', value: 1 }],
    countyProps('Kenai Peninsula', 'county', 'Alaska'))?.value === 1);

// The Roanoke collision — one name, two features, disambiguated only by `kind`.
const roanokeCo = countyProps('Roanoke', 'county', 'Virginia');
const roanokeCity = countyProps('Roanoke', 'city', 'Virginia');
const roanokeItems = [
  { name: 'Roanoke', state: 'Virginia', kind: 'county', value: 98434 },
  { name: 'Roanoke', state: 'Virginia', kind: 'city', value: 99111 },
];
ok('us_county: kind=county routes to the county item', matchGeoItem(roanokeItems, roanokeCo)?.value === 98434);
ok('us_county: kind=city routes to the city item', matchGeoItem(roanokeItems, roanokeCity)?.value === 99111);
ok('us_county: a wrong-kind item is rejected outright',
  matchGeoItem([{ name: 'Roanoke', state: 'Virginia', kind: 'city' }], roanokeCo) === undefined);

// "James City" and "Charles City" are real counties whose names end in the word
// the normalizer strips. Both sides strip it, so the join still holds.
ok('us_county: "James City" county survives the "city" strip',
  matchGeoItem([{ name: 'James City County', state: 'Virginia', kind: 'county', value: 83326 }],
    countyProps('James City', 'county', 'Virginia'))?.value === 83326);
ok('us_county: "Charles City" county survives too',
  matchGeoItem([{ name: 'Charles City', state: 'Virginia', kind: 'county', value: 7 }],
    countyProps('Charles City', 'county', 'Virginia'))?.value === 7);

// ── §5 level: us_city ────────────────────────────────────────────────────────
// There is NO nationwide places asset. The design spec
// (docs/superpowers/specs/2026-06-16-us-geo-choropleth-levels-design.md §2) planned
// us-city.json (~30k features); it was never shipped, and mapRender's
// loadChoroplethData returns null for us_city so the level degrades to a bubble
// map / column chart. What DOES exist is the 41 kind:'city' features inside
// us-counties.json — the independent cities of VA, MO and MD, which are county
// equivalents. That is the only city geometry the join can serve today.
const cityFeatures = COUNTIES.features.filter(f => f.properties.kind === 'city');
ok('us_city: the only bundled city polygons are county-equivalent independent cities',
  cityFeatures.length === 41);
ok('us_city: they cover exactly VA, MO and MD',
  JSON.stringify([...new Set(cityFeatures.map(f => f.properties.state))].sort())
    === JSON.stringify(['Maryland', 'Missouri', 'Virginia']));
const alexandria = countyProps('Alexandria', 'city', 'Virginia');
ok('us_city: an independent city places by name+state+kind',
  matchGeoItem([{ name: 'Alexandria', state: 'Virginia', kind: 'city', value: 160662 }], alexandria)?.value === 160662);
ok('us_city: an "(City)" parenthetical is stripped before matching',
  matchGeoItem([{ name: 'Alexandria (City)', state: 'Virginia', kind: 'city', value: 1 }], alexandria)?.value === 1);
ok('us_city: the same city name in another state does not place',
  matchGeoItem([{ name: 'Alexandria', state: 'Louisiana', kind: 'city', value: 1 }], alexandria) === undefined);
// Every bundled independent city must place from its own properties — the
// blank-map regression this whole join exists to prevent.
ok('us_city: all 41 independent cities place from their own name+state+kind',
  cityFeatures.every(f => matchGeoItem([{
    name: f.properties.name, state: f.properties.state, kind: 'city', value: 1,
  }], f.properties) !== undefined));

// The full Virginia capture from the original blank-globe bug: counties and
// independent cities in one item list, every item placing on some polygon.
const vaItems = [
  { name: 'Newport News', state: 'Virginia', kind: 'city', value: 183230 },
  { name: 'Stafford County', state: 'Virginia', kind: 'county', value: 170803 },
  { name: 'Alexandria', state: 'Virginia', kind: 'city', value: 160662 },
  { name: 'Roanoke', state: 'Virginia', kind: 'county', value: 98434 },
  { name: 'Roanoke', state: 'Virginia', kind: 'city', value: 99111 },
  { name: 'James City County', state: 'Virginia', kind: 'county', value: 83326 },
];
const vaPlaced = vaItems.filter(it => COUNTIES.features.some(f => matchGeoItem([it], f.properties)));
ok('mixed VA capture: every county + independent city places', vaPlaced.length === vaItems.length);
// …and no item bleeds outside Virginia.
const vaBleed = COUNTIES.features.filter(f =>
  f.properties.state !== 'Virginia' && matchGeoItem(vaItems, f.properties));
ok('mixed VA capture: nothing shades a polygon outside Virginia', vaBleed.length === 0);

// ── §6 level: us_zip ─────────────────────────────────────────────────────────
// No ZCTA asset ships either (spec §2 planned ~33k features). The matcher is
// still the contract for the level: spec §1 says `name` IS the ZCTA code and is
// matched directly, optionally scoped by state. Feature fixtures here are
// synthetic BECAUSE the asset does not exist — the code under test is real.
const zcta22554 = { name: '22554', state: 'Virginia' };
ok('us_zip: a ZCTA code matches itself', matchGeoItem([{ name: '22554', value: 1 }], zcta22554)?.value === 1);
ok('us_zip: state scoping rejects the same code claimed for another state',
  matchGeoItem([{ name: '22554', state: 'Maryland', value: 1 }], zcta22554) === undefined);
ok('us_zip: state scoping accepts the right state',
  matchGeoItem([{ name: '22554', state: 'Virginia', value: 2 }], zcta22554)?.value === 2);
ok('us_zip: a different code does not match',
  matchGeoItem([{ name: '22553', value: 1 }], zcta22554) === undefined);
// A leading-zero ZIP must stay text end to end — parse.ts's isFiniteNumber gate
// keeps `01001` out of the number branch, and the matcher must not re-mangle it.
ok('us_zip: a leading-zero ZIP matches as text',
  matchGeoItem([{ name: '01001', state: 'Massachusetts', value: 1 }], { name: '01001', state: 'Massachusetts' })?.value === 1);
ok('us_zip: "1001" does not match ZCTA "01001"',
  matchGeoItem([{ name: '1001' }], { name: '01001' }) === undefined);
// ZIPs are 5 characters, so they clear the >4 substring gate. Codes are fixed
// width, so containment can only happen between equal strings — no false joins.
ok('us_zip: no 5-digit code substring-matches a different 5-digit code',
  ['22554', '22553', '90210', '01001'].every(a =>
    ['22554', '22553', '90210', '01001'].every(b =>
      (a === b) === (matchGeoItem([{ name: a }], { name: b }) !== undefined))));
ok('us_zip: no ZCTA boundary asset ships — the level degrades, it never blank-globes',
  !fs.existsSync(path.join(GEO_DIR, 'us-zip.json')) && !fs.existsSync(path.join(GEO_DIR, 'us-zips.json')));
ok('us_city: no places boundary asset ships either',
  !fs.existsSync(path.join(GEO_DIR, 'us-city.json')) && !fs.existsSync(path.join(GEO_DIR, 'us-cities.json')));

// ── §7 KNOWN DEFECTS — characterized, not endorsed ───────────────────────────
// These assert what the shipped matcher DOES today. Each is a real mis-join, all
// of them pre-date Phase 4, and none is caused by the renderer. They are pinned
// here so a fix is a visible, deliberate test edit rather than a silent drift.

// D1. The substring rule (item name >4 chars, containment either direction) is
// unscoped by length ratio, so a longer country name captures a shorter one.
// 17 ordered collision pairs exist in the shipped 177-feature world asset.
const worldNorm = WORLD.features.map(f => normalizeName(f.properties.name));
const collisionPairs: string[] = [];
for (const a of worldNorm) for (const b of worldNorm) {
  if (a !== b && a.length > 4 && (a.includes(b) || b.includes(a))) collisionPairs.push(a + ' ~ ' + b);
}
ok('D1: the world asset holds 17 ordered substring-colliding country pairs (15 names)',
  collisionPairs.length === 17 && new Set(collisionPairs.map(p => p.split(' ~ ')[0])).size === 15);
ok('D1: an item named "Nigeria" wrongly matches the Niger polygon',
  matchGeoItem([{ name: 'Nigeria', value: 1 }], worldProps('Niger'))?.value === 1);
ok('D1: an item named "Romania" wrongly matches the Oman polygon',
  matchGeoItem([{ name: 'Romania', value: 1 }], worldProps('Oman'))?.value === 1);
ok('D1: an item named "South Sudan" wrongly matches the Sudan polygon',
  matchGeoItem([{ name: 'South Sudan', value: 1 }], worldProps('Sudan'))?.value === 1);
// Item order decides the outcome, so the damage depends on the row order of the
// user's data — the same dataset sorted differently shades a different country.
ok('D1: with both present, list order decides which polygon Niger gets',
  matchGeoItem([{ name: 'Nigeria', value: 1 }, { name: 'Niger', value: 2 }], worldProps('Niger'))?.value === 1 &&
  matchGeoItem([{ name: 'Niger', value: 2 }, { name: 'Nigeria', value: 1 }], worldProps('Niger'))?.value === 2);

// D2. The same rule bites at us_state, where features carry no `state` prop to
// disambiguate with: "West Virginia" contains "Virginia".
ok('D2: an item named "West Virginia" wrongly matches the Virginia polygon',
  matchGeoItem([{ name: 'West Virginia', value: 1 }], virginia)?.value === 1);
ok('D2: a "Virginia" item listed first steals the West Virginia polygon',
  matchGeoItem([{ name: 'Virginia', value: 1 }, { name: 'West Virginia', value: 2 }],
    stateProps('West Virginia'))?.value === 1);

// D3. matchGeoItem does String() the item's `kind` but not its `name`, so a
// non-string name throws instead of degrading. PRECONDITION, not a live bug:
// analyze.ts:216-218 filters geo items to `typeof item.name === 'string'`, and
// vizData.ts:260 builds `name: String(labels[k])`. Both production callers
// guarantee a string. If either guard is ever relaxed, this assertion is the
// pointer to why the map started throwing.
let threw = false;
try { matchGeoItem([{ name: 22554, value: 1 }], zcta22554); } catch (_) { threw = true; }
ok('D3: PRECONDITION — a non-string item name throws (upstream callers coerce)', threw);
ok('D3: a non-string FEATURE name also throws (assets are generated, always strings)',
  (() => { try { matchGeoItem([{ name: 'x' }], { name: 22554 }); return false; } catch (_) { return true; } })());

if (failureCount()) { console.error('\n' + failureCount() + ' assertion(s) failed'); process.exit(1); }
console.log('\nAll geo-level join checks passed.');
