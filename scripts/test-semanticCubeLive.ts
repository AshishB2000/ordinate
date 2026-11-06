// The semantic parity matrix on a REAL Cube (semantic layer part 7, e1; docs/live-data/cube.md): the shipped `cube`
// connector and encoder against a Cube server over Postgres seeded with the live-parity fixture
// (scripts/fixtures/cube/compose.yml), in server mode — the SSRF guard on, the deployment's address allowed and
// pinned — compared with the extract path exactly as every pull request compares the fake (./semanticCubeLive.ts).
//
// Runs when CUBE_URL is set (with CUBE_API_SECRET, the deployment's CUBEJS_API_SECRET), and prints that it skipped
// otherwise, so `npm test` passes without a Cube. One of the two without the other is a failure, not a skip. The
// `cube` job of .github/workflows/warehouse-nightly.yml starts the compose file and sets both.
//
//   docker compose -f scripts/fixtures/cube/compose.yml up -d
//   npm run build:ts && CUBE_URL=http://127.0.0.1:4000 CUBE_API_SECRET=ordinate-cube-parity-not-a-secret node scripts/test-semanticCubeLive.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish, failureCount } from './selfcheck';

const url = (process.env.CUBE_URL ?? '').trim();
const secret = (process.env.CUBE_API_SECRET ?? '').trim();

let printed = '';
for (const s of [process.stdout, process.stderr]) {
  const orig = s.write.bind(s) as (...a: unknown[]) => boolean;
  (s as unknown as { write: (...a: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => {
    printed += String(chunk);
    return orig(chunk, ...rest);
  };
}

/** A line of the nightly's run page ($GITHUB_STEP_SUMMARY), when there is one. */
function summaryLine(line: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) (require('fs') as typeof import('fs')).appendFileSync(file, `${line}\n`);
}

if (!url && !secret) {
  console.log('skip semantic parity on Cube: CUBE_URL is unset (the nightly sets it; see scripts/fixtures/cube/compose.yml)');
  finish();
} else if (!url || !secret) {
  ok(`CUBE_URL and CUBE_API_SECRET are set together (only ${url ? 'CUBE_URL' : 'CUBE_API_SECRET'} is): a half-set run fails, never skips`, false);
  finish();
} else {
  void main().catch((e: unknown) => ok('semantic parity on Cube threw', false, e instanceof Error ? e.stack : String(e))).finally(finish);
}

async function main(): Promise<void> {
  const fs: typeof import('fs') = require('fs');
  const os: typeof import('os') = require('os');
  const path: typeof import('path') = require('path');
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return ok('CUBE_URL is an http(s) URL (a set but unusable value fails, never skips)', false);
  }
  const eng: typeof import('./liveParityEngines') = require('./liveParityEngines');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-cube-live-'));
  // Server mode: every request SSRF-checked and pinned; the deployment's address — the one that answers — is allowed.
  const reach = await eng.reachableAddress(target.hostname.replace(/^\[(.*)\]$/, '$1'), Number(target.port) || (target.protocol === 'https:' ? 443 : 80));
  process.env.SSRF_ALLOW = [process.env.SSRF_ALLOW, reach.cidr].filter(Boolean).join(',');
  const context: typeof import('../src/server/context') = require('../src/server/context');
  context.enterServerMode(path.join(tmp, 'data'));
  const live: typeof import('./semanticCubeLive') = require('./semanticCubeLive');
  const identity = { user: { email: 'parity@ordinate.invalid', role: 'admin' as const }, org: { id: 'parity' } };
  await context.runInContext(identity, `cube-live-${process.pid}`, async () => {
    const r = await live.runCubeLive({ url, secret }, ok);
    summaryLine(`- cube: ${r.loads} loads, ${failureCount() === 0 ? 'every check passed' : `**${failureCount()} failed**`}`);
  });
  ok('cube: the API secret was printed nowhere (the canary)', !printed.includes(secret));
  fs.rmSync(tmp, { recursive: true, force: true });
}
