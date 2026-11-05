// Column access rules at every door, over the real RPC route, as real users with real grants, in a
// scratch Postgres (semantic layer part 4, D12–D17, D20). The world is scripts/columnAccessHarness.ts:
// *Staff* hides `salary`, `ssn` and the carrier `bonus` from `east` (a viewer); `hr` (a viewer in HR)
// and `ed` (an editor) see them.
//
// 1. THE NET: Staff is closed to east for a whole-table reader, open inside a gated door, open to hr;
//    `policyClosed` stays rows-only (NEGATIVE CONTROL).
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-columnDoors.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as C from './columnAccessHarness';

const access: typeof import('../src/data/rowAccess') = require('../src/data/rowAccess');

(async () => {
  const W = await C.columnWorld('column doors');
  if (!W) return finish();
  try {
    const { P, staff } = W;
    // ── 1. The net ───────────────────────────────────────────────────────────
    ok('net: Staff is closed to east for a whole-table reader', await W.as('east', () => access.closedToCaller(P, staff)));
    ok('NEGATIVE CONTROL: …open to hr, whom the rules name', !(await W.as('hr', () => access.closedToCaller(P, staff))));
    ok('NEGATIVE CONTROL: …open to the editor', !(await W.as('ed', () => access.closedToCaller(P, staff))));
    ok('net: inside a door that checked Staff, it is open to east', !(await W.as('east', () => access.withColumnsChecked(new Set([staff]), () => access.closedToCaller(P, staff)))));
    ok('net: …a door that checked another dataset does not open it', await W.as('east', () => access.withColumnsChecked(new Set([W.plain]), () => access.closedToCaller(P, staff))));
    ok('NEGATIVE CONTROL: policyClosed is rows only (Staff has no row rules)', !(await W.as('boss', () => access.policyClosed(P, staff))));
    ok('governed: Staff has column rules, for the replies sent alike to every reader', await W.as('boss', () => access.governed(P, staff)));
    ok('NEGATIVE CONTROL: governed: Plain has none', !(await W.as('boss', () => access.governed(P, W.plain))));
    ok('hiddenColumnsFor: east is hidden salary, ssn and the carrier bonus; hr nothing', [...(await W.as('east', () => access.hiddenColumnsFor(P, staff)))].sort().join() === 'bonus,salary,ssn' && (await W.as('hr', () => access.hiddenColumnsFor(P, staff))).size === 0);
  } finally {
    await W.close();
  }
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
