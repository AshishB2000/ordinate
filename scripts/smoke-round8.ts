// Round 8 — the one smoke for the round: small multiples, pipelines, event
// annotations, the summary card and search inside the data, each driven
// through the REAL app in ONE launch on a small fixture.
//
// Each feature's checks live in its own section module (scripts/r8*.ts) so this
// file stays a list, and it fails on any renderer console error — the check
// that catches a CSP violation. Every section restores the sample and deletes
// what it creates, so a later section never fails on an earlier one's leftovers.
//
//   npm run build && node scripts/smoke-round8.js
//   SMOKE_R8_ONLY=facets node scripts/smoke-round8.js   # one section

import { ok, failureCount } from './selfcheck';
import { launchSmoke, seedProject, reloadSmoke, finishSmoke } from './smokeFixture';
import type { Smoke, Fixture } from './smokeFixture';

type Section = { name: string; run: (s: Smoke, fx: Fixture) => Promise<unknown> };

/** Sections, in commit order. */
const SECTIONS: Section[] = [
  { name: 'facets', run: (s, fx) => require('./r8Facets').facetsSection(s, fx) },
  { name: 'pipelines', run: (s, fx) => require('./r8Pipelines').pipelinesSection(s, fx) },
  { name: 'events', run: (s, fx) => require('./r8Events').eventsSection(s, fx) },
  { name: 'summary', run: (s, fx) => require('./r8Summary').summarySection(s, fx) },
  { name: 'search', run: (s, fx) => require('./r8Search').searchSection(s, fx) },
];

async function main(): Promise<void> {
  const only = process.env.SMOKE_R8_ONLY || '';
  const sections = SECTIONS.filter((x) => !only || only === x.name);
  const s = await launchSmoke('round8');
  try {
    const fx = await seedProject(s.app, { rows: 5_000 });
    await reloadSmoke(s);
    for (const sec of sections) {
      await sec.run(s, fx);
      ok(`${sec.name}: no renderer console errors`, s.errors.length === 0, s.errors.join('\n'));
    }
  } finally {
    await s.close();
  }
  finishSmoke('round8', failureCount());
}

main().catch((err) => {
  console.error('FAIL (threw)', err);
  process.exit(1);
});
