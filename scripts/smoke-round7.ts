// Round 7 — the one smoke for the round: notebooks, level-of-detail
// expressions, save as template, linked hover and motion, and interface
// languages, each driven through the REAL app in ONE launch on a small fixture.
//
// Each feature's checks live in its own section module (scripts/r7*.ts) so this
// file stays a list, and it fails on any renderer console error — the check
// that catches a CSP violation. Sections share the launch: each restores what
// it changed and deletes what it created (see the section headers), and
// languages runs LAST because it reloads the window three times.
//
//   npm run build && node scripts/smoke-round7.js
//   SMOKE_R7_ONLY=lod,motion node scripts/smoke-round7.js   # some sections

import { ok, failureCount } from './selfcheck';
import { launchSmoke, seedProject, reloadSmoke, finishSmoke } from './smokeFixture';
import type { Smoke, Fixture } from './smokeFixture';

type Section = { name: string; run: (s: Smoke, fx: Fixture) => Promise<unknown> };

/** Sections, in commit order. */
const SECTIONS: Section[] = [
  { name: 'notebooks', run: (s, fx) => require('./r7Notebooks').notebooksSection(s, fx) },
  { name: 'lod', run: (s, fx) => require('./r7Lod').lodSection(s, fx) },
  { name: 'templates', run: (s, fx) => require('./r7Templates').templatesSection(s, fx) },
  { name: 'motion', run: (s, fx) => require('./r7Motion').motionSection(s, fx) },
  { name: 'i18n', run: (s, fx) => require('./r7I18n').i18nSection(s, fx) },
];

async function main(): Promise<void> {
  const only = process.env.SMOKE_R7_ONLY || '';
  const sections = SECTIONS.filter((x) => !only || only.split(',').includes(x.name));
  const s = await launchSmoke('round7');
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
  finishSmoke('round7', failureCount());
}

main().catch((err) => {
  console.error('FAIL (threw)', err);
  process.exit(1);
});
