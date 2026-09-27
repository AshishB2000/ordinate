// Platform depth — the one smoke for the round: speed and background jobs,
// publish to folder, privacy and sensitivity, automation (CLI + MCP), and
// backups and sync, each driven through the REAL app.
//
// Two launches, because the fixtures want different things:
//   1. the 1M-row fixture — the speed targets are MEASURED on it (pfSpeed.ts
//      prints the table the PR quotes);
//   2. a 5k-row fixture for everything else, which asserts behaviour, not
//      timing, and would only be slower on a million rows.
// Each feature's checks live in its own section module (scripts/pf*.ts) so
// this file stays a list, and fails on any renderer console error — the check
// that catches a CSP violation.
//
//   npm run build && node scripts/smoke-platform.js

import { ok, failureCount } from './selfcheck';
import { launchSmoke, seedProject, reloadSmoke, finishSmoke } from './smokeFixture';
import type { Smoke, Fixture } from './smokeFixture';
import { speedSection } from './pfSpeed';
import { publishSection } from './pfPublish';
import { privacySection } from './pfPrivacy';

type Section = { name: string; run: (s: Smoke, fx: Fixture) => Promise<unknown> };

/** Sections that run on the small fixture, in order. */
const SECTIONS: Section[] = [
  { name: 'publish', run: publishSection },
  { name: 'privacy', run: privacySection },
  // platform:sections
];

async function main(): Promise<void> {
  const only = process.env.SMOKE_PLATFORM_ONLY || '';

  if (!only || only === 'speed') {
    const big = await launchSmoke('platform-speed');
    try {
      const fx = await seedProject(big.app, { rows: 1_000_000 });
      await reloadSmoke(big);
      await speedSection(big, fx);
      ok('speed: no renderer console errors', big.errors.length === 0, big.errors.join('\n'));
    } finally {
      await big.close();
    }
  }

  const sections = SECTIONS.filter((x) => !only || only === x.name);
  if (sections.length) {
    const small = await launchSmoke('platform');
    try {
      const fx = await seedProject(small.app, { rows: 5_000 });
      await reloadSmoke(small);
      for (const sec of sections) {
        await sec.run(small, fx);
        ok(`${sec.name}: no renderer console errors`, small.errors.length === 0, small.errors.join('\n'));
      }
    } finally {
      await small.close();
    }
  }

  finishSmoke('platform', failureCount());
}

main().catch((err) => {
  console.error('FAIL (threw)', err);
  process.exit(1);
});
