// Self-check for the geo matcher against the real US county boundary asset.
// Run: node scripts/test-geo-match.js   (exits non-zero on failure)
// Reproduces the Virginia capture that originally rendered a blank world map.

export {}; // module scope — sibling test scripts share top-level names

// Explicit annotation (not a cast): assert.ok is an assertion function, and
// TS requires the call target itself to carry a declared type (TS2775).
const assert: typeof import('assert') = require('assert');
import * as path from 'path';

// ponytail: geoMatch.js is a renderer global-script (not a TS module) and the
// county asset is postinstall-fetched JSON — require both with loose types.
const { matchGeoItem } = require('../renderer/hub/geoMatch') as {
  matchGeoItem: (items: any[], props: any) => any;
};

const counties = require('../assets/geo/us-counties.json') as { features: any[] };

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

console.log('geo-match self-check passed (' + items.length + ' Virginia items placed)');
