'use strict';

// Parity: src/analysis/params.ts `substituteText` replaces `{{name}}` exactly as
// the desktop's `paramSubst` (dashParams.ts) did.
//
// The desktop kept a copy because a card title was drawn synchronously and a
// classic <script> could not import a CommonJS module. That copy went with the
// desktop app (T8.1); its answers over these inputs are the golden fixture
// scripts/fixtures/golden/paramsParity.json (scripts/golden.ts), compared with
// the same strict equality as before.
//
//   npm run build:ts && node scripts/test-paramsParity.js

import { paramValues, substituteText } from '../src/analysis/params';
import { golden } from './golden';

import { ok, finish } from './selfcheck';

const G = golden<{ entries: Parameters<typeof paramValues>[0]; cases: Array<[string, string]> }>('paramsParity');
const values = paramValues(G.entries);

ok('the fixture holds the nine texts', G.cases.length === 9);
for (const [t, legacy] of G.cases) {
  const main = substituteText(t, values);
  ok(`"${t}" → "${main}"`, legacy === main, `the desktop said "${legacy}"`);
}

finish();
