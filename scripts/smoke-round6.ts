// Depth round 6 — the one smoke for the round: layouts for every size, the
// statistics workbench, text analytics, geospatial analysis and input tables,
// each driven through the REAL app in ONE launch on a small fixture.
//
// Each feature's checks live in its own section module (scripts/r6*.ts) so this
// file stays a list, and it fails on any renderer console error — the check
// that catches a CSP violation.
//
//   npm run build && node scripts/smoke-round6.js
//   SMOKE_R6_ONLY=stats node scripts/smoke-round6.js   # one section

import { ok, failureCount } from './selfcheck';
import { launchSmoke, seedProject, reloadSmoke, finishSmoke } from './smokeFixture';
import type { Smoke, Fixture } from './smokeFixture';

type Section = { name: string; run: (s: Smoke, fx: Fixture) => Promise<unknown> };

/** Sections, in commit order. */
const SECTIONS: Section[] = [
  { name: 'layouts', run: (s, fx) => require('./r6Layouts').layoutsSection(s, fx) },
  { name: 'stats', run: (s, fx) => require('./r6Stats').statsSection(s, fx) },
  { name: 'text', run: (s, fx) => require('./r6Text').textSection(s, fx) },
  { name: 'geo', run: (s, fx) => require('./r6Geo').geoSection(s, fx) },
  { name: 'input', run: (s, fx) => require('./r6Input').inputSection(s, fx) },
];

async function main(): Promise<void> {
  const only = process.env.SMOKE_R6_ONLY || '';
  const sections = SECTIONS.filter((x) => !only || only === x.name);
  const s = await launchSmoke('round6');
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
  finishSmoke('round6', failureCount());
}

main().catch((err) => {
  console.error('FAIL (threw)', err);
  process.exit(1);
});
