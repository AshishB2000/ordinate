// The semantic parity matrix on a REAL dbt Cloud Semantic Layer (semantic layer part 7, d1, BETA;
// docs/live-data/dbt-semantic-layer.md): the shipped `dbt-semantic-layer` connector and encoder against the account's
// environment that deploys scripts/fixtures/dbt-sl/project (the saved query `ordinate_parity`), in server mode — the
// SSRF guard on every request — compared with the extract path exactly as every pull request compares the fake
// (./semanticDbtLive.ts).
//
// Runs when DBT_SL_HOST, DBT_SL_ENVIRONMENT_ID and DBT_SL_TOKEN are set, and prints that it skipped when none is, so
// `npm test` passes without an account. Some but not all is a failure, not a skip; so is a host that is not one of
// the three multi-tenant hosts. The `dbt` job of .github/workflows/warehouse-nightly.yml passes the three secrets.
//
//   npm run build:ts && DBT_SL_HOST=semantic-layer.cloud.getdbt.com DBT_SL_ENVIRONMENT_ID=… DBT_SL_TOKEN=… node scripts/test-semanticDbtLive.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish, failureCount } from './selfcheck';

const host = (process.env.DBT_SL_HOST ?? '').trim();
const environmentId = (process.env.DBT_SL_ENVIRONMENT_ID ?? '').trim();
const token = (process.env.DBT_SL_TOKEN ?? '').trim();

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

const set = [host, environmentId, token].filter(Boolean).length;
if (set === 0) {
  console.log('skip semantic parity on dbt: DBT_SL_HOST, DBT_SL_ENVIRONMENT_ID and DBT_SL_TOKEN are unset (the nightly sets them once an account exists; docs/server/live-data.md)');
  finish();
} else if (set < 3) {
  const missing = [['DBT_SL_HOST', host], ['DBT_SL_ENVIRONMENT_ID', environmentId], ['DBT_SL_TOKEN', token]].filter(([, v]) => !v).map(([k]) => k);
  ok(`DBT_SL_HOST, DBT_SL_ENVIRONMENT_ID and DBT_SL_TOKEN are set together (${missing.join(', ')} unset): a half-set run fails, never skips`, false);
  finish();
} else {
  void main().catch((e: unknown) => ok('semantic parity on dbt threw', false, e instanceof Error ? e.stack : String(e))).finally(finish);
}

async function main(): Promise<void> {
  const fs: typeof import('fs') = require('fs');
  const os: typeof import('os') = require('os');
  const path: typeof import('path') = require('path');
  const wire: typeof import('../src/connectors/dbtWire') = require('../src/connectors/dbtWire');
  const region = Object.entries(wire.DBT_REGIONS).find(([, r]) => r.host === host)?.[0];
  if (!region) return ok(`DBT_SL_HOST is one of the multi-tenant hosts (${wire.DBT_HOSTS.join(', ')}): a set but unusable value fails, never skips`, false);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-dbt-live-'));
  const context: typeof import('../src/server/context') = require('../src/server/context');
  context.enterServerMode(path.join(tmp, 'data')); // every request SSRF-checked and pinned
  const live: typeof import('./semanticDbtLive') = require('./semanticDbtLive');
  const identity = { user: { email: 'parity@ordinate.invalid', role: 'admin' as const }, org: { id: 'parity' } };
  await context.runInContext(identity, `dbt-live-${process.pid}`, async () => {
    const r = await live.runDbtLive({ region, environmentId, token }, ok);
    summaryLine(`- dbt (beta): ${r.queries} questions, ${failureCount() === 0 ? 'every check passed' : `**${failureCount()} failed**`}`);
  });
  ok('dbt: the service token was printed nowhere (the canary)', !printed.includes(token));
  fs.rmSync(tmp, { recursive: true, force: true });
}
