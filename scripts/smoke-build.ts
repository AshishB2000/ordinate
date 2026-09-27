// Build depth — the one smoke for the round: assistant plans, formatting and
// project colours, the theme editor, SaaS sources (against a local HTTP fixture
// server, never the network) and data snapshots, each driven through the REAL
// app in ONE launch on a small fixture.
//
// Each feature's checks live in its own section module (scripts/bd*.ts) so this
// file stays a list, and it fails on any renderer console error — the check
// that catches a CSP violation.
//
//   npm run build && node scripts/smoke-build.js
//   SMOKE_BUILD_ONLY=theme node scripts/smoke-build.js   # one section

import { ok, failureCount } from './selfcheck';
import { launchSmoke, seedProject, reloadSmoke, finishSmoke } from './smokeFixture';
import type { Smoke, Fixture } from './smokeFixture';

type Section = { name: string; run: (s: Smoke, fx: Fixture) => Promise<unknown> };

/** Sections, in commit order. */
const SECTIONS: Section[] = [
  // build:plan
  { name: 'plan', run: (s, fx) => require('./bdPlan').planSection(s, fx) },

  // build:format
  { name: 'format', run: (s, fx) => require('./bdFormat').formatSection(s, fx) },

  // build:theme
  { name: 'theme', run: (s, fx) => require('./bdTheme').themeSection(s, fx) },

  // build:saas
  { name: 'saas', run: (s, fx) => require('./bdSaas').saasSection(s, fx) },

  // build:snapshots

];

async function main(): Promise<void> {
  const only = process.env.SMOKE_BUILD_ONLY || '';
  const sections = SECTIONS.filter((x) => !only || only === x.name);
  const s = await launchSmoke('build');
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
  finishSmoke('build', failureCount());
}

main().catch((err) => {
  console.error('FAIL (threw)', err);
  process.exit(1);
});
