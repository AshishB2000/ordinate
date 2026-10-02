// Round 10 — the one smoke for the round: saved views, retail and fiscal
// calendars, multi-currency, incremental refresh and drag and drop, each driven
// through the REAL app in ONE launch on a small fixture.
//
// Each feature's checks live in its own section module (scripts/r10*.ts) so this
// file stays a list, and it fails on any renderer console error — the check
// that catches a CSP violation. Every section restores the sample and deletes
// what it creates, so a later section never fails on an earlier one's leftovers.
//
// It exits within seconds of its last check: closing a stuck renderer is raced
// against a short timer and the process exits explicitly, so a lingering handle
// (a watcher, a socket, the DuckDB worker) can never hold a CI run open.
//
//   npm run build && node scripts/smoke-round10.js
//   SMOKE_R10_ONLY=views node scripts/smoke-round10.js   # one section

import { ok, failureCount } from './selfcheck';
import { launchSmoke, seedProject, reloadSmoke, finishSmoke } from './smokeFixture';
import type { Smoke, Fixture } from './smokeFixture';

type Section = { name: string; run: (s: Smoke, fx: Fixture) => Promise<unknown> };

/** Sections, in commit order. */
const SECTIONS: Section[] = [
  { name: 'views', run: (s, fx) => require('./r10Views').viewsSection(s, fx) },
  { name: 'calendars', run: (s, fx) => require('./r10Calendars').calendarsSection(s, fx) },
  { name: 'currency', run: (s, fx) => require('./r10Currency').currencySection(s, fx) },
  { name: 'incremental', run: (s, fx) => require('./r10Incremental').incrementalSection(s, fx) },
  { name: 'dragdrop', run: (s, fx) => require('./r10DragDrop').dragDropSection(s, fx) },
];

/** Longest a close may take before the run exits anyway. */
const CLOSE_MS = 8_000;

async function main(): Promise<void> {
  const only = process.env.SMOKE_R10_ONLY || '';
  const sections = SECTIONS.filter((x) => !only || only === x.name);
  const s = await launchSmoke('round10');
  try {
    const fx = await seedProject(s.app, { rows: 5_000 });
    await reloadSmoke(s);
    for (const sec of sections) {
      await sec.run(s, fx);
      ok(`${sec.name}: no renderer console errors`, s.errors.length === 0, s.errors.join('\n'));
    }
  } finally {
    await Promise.race([s.close().catch(() => undefined), new Promise((r) => setTimeout(r, CLOSE_MS))]);
  }
  finishSmoke('round10', failureCount());
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL (threw)', err);
  process.exit(1);
});
