// The two warehouse connectors against REAL accounts (plan L1.5): Snowflake and
// BigQuery end to end through the real registry and dispatch, over the network,
// in server mode (so the SSRF guard checks and pins every socket). The
// self-checks beside it (test-connectorsSnowflake, test-connectorsBigquery,
// test-bigqueryBounds) run the same code off recorded replies; this is what
// tells us the recordings still match the services.
//
// It runs ONLY when a warehouse's credentials are in the environment, and
// otherwise prints that it skipped and exits 0 — so `npm test` stays green on a
// laptop and in CI. The nightly (.github/workflows/warehouse-nightly.yml) sets
// them from repository secrets. They are inputs to this test, not server
// settings (docs/server/live-data.md, "Testing against a real account"):
//
//   Snowflake  SNOWFLAKE_ACCOUNT, SNOWFLAKE_USER, SNOWFLAKE_WAREHOUSE, SNOWFLAKE_ROLE, and
//              SNOWFLAKE_PRIVATE_KEY (PEM, + SNOWFLAKE_PRIVATE_KEY_PASSPHRASE) or SNOWFLAKE_PAT;
//              SNOWFLAKE_DATABASE, SNOWFLAKE_SCHEMA optional (the database needs one table)
//   BigQuery   BIGQUERY_KEY_JSON; BIGQUERY_PROJECT, BIGQUERY_DATASET, BIGQUERY_LOCATION optional;
//              BIGQUERY_SCRATCH_DATASET optional — a dataset the account may write, for the
//              spike's CREATE TABLE probe
//
// Some variables of a warehouse set but not all is a FAILURE, not a skip: a
// half-configured nightly must not pass by doing nothing.
//
// Each warehouse: test connection, listTables, describeTable, a run truncated at
// the cap (and one exactly at it, not truncated), partitions / pages past the
// first, the type mapping (numbers, ids past 15 digits, dates and timestamps to
// UTC ISO, JSON), runBound with adversarial literals and an injection control,
// cancel on abort confirmed by the warehouse itself, and the SECRET CANARY:
// every result and error the connectors returned and every byte printed,
// grepped for the keys, passphrase, PAT, and every bearer token and signed
// assertion issued during the run. BigQuery also: the estimate, the read-only
// gate, and the scope spike (warehouseLiveBigquery.ts).
//
//   npm run build:ts && node scripts/test-warehouseLive.js      (with the variables above)

export {}; // module scope — sibling test scripts share top-level names
import { failureCount, finish } from './selfcheck';
import { canary, canaryControl, ok, ORG, say, summary, writeSummary } from './warehouseLiveHarness';
import type { SnowflakeConfig } from './warehouseLiveSnowflake';
import type { BigqueryConfig } from './warehouseLiveBigquery';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { randomBytes }: typeof import('crypto') = require('crypto');

/** A reader of variables; unset and blank are the same (a missing repo secret arrives as ''). */
type Env = (name: string) => string;
const envOf = (vars: Record<string, string | undefined>): Env => (name) => (vars[name] ?? '').trim();
/** A PEM pasted with literal \n escapes (a one-line secret store) is turned back into lines. */
const pem = (v: string): string => (v && !v.includes('\n') && v.includes('\\n') ? v.replace(/\\n/g, '\n') : v);

type Plan<T> = { run: true; config: T } | { run: false; why: string; missing?: string[] };

function snowflakePlan(env: Env): Plan<SnowflakeConfig> {
  const names = ['SNOWFLAKE_ACCOUNT', 'SNOWFLAKE_USER', 'SNOWFLAKE_WAREHOUSE', 'SNOWFLAKE_ROLE', 'SNOWFLAKE_PRIVATE_KEY', 'SNOWFLAKE_PRIVATE_KEY_PASSPHRASE',
    'SNOWFLAKE_PAT', 'SNOWFLAKE_DATABASE', 'SNOWFLAKE_SCHEMA'];
  if (!names.some(env)) return { run: false, why: 'no SNOWFLAKE_* variable is set' };
  const missing = ['SNOWFLAKE_ACCOUNT', 'SNOWFLAKE_USER', 'SNOWFLAKE_WAREHOUSE', 'SNOWFLAKE_ROLE'].filter((n) => !env(n));
  if (!env('SNOWFLAKE_PRIVATE_KEY') && !env('SNOWFLAKE_PAT')) missing.push('SNOWFLAKE_PRIVATE_KEY or SNOWFLAKE_PAT');
  if (missing.length) return { run: false, why: 'only some SNOWFLAKE_* variables are set', missing };
  const config: SnowflakeConfig = { account: env('SNOWFLAKE_ACCOUNT'), user: env('SNOWFLAKE_USER'), warehouse: env('SNOWFLAKE_WAREHOUSE'), role: env('SNOWFLAKE_ROLE') };
  if (env('SNOWFLAKE_DATABASE')) config.database = env('SNOWFLAKE_DATABASE');
  if (env('SNOWFLAKE_SCHEMA')) config.schema = env('SNOWFLAKE_SCHEMA');
  if (env('SNOWFLAKE_PRIVATE_KEY')) {
    config.key = pem(env('SNOWFLAKE_PRIVATE_KEY'));
    if (env('SNOWFLAKE_PRIVATE_KEY_PASSPHRASE')) config.passphrase = env('SNOWFLAKE_PRIVATE_KEY_PASSPHRASE');
  } else {
    config.pat = env('SNOWFLAKE_PAT');
  }
  return { run: true, config };
}

function bigqueryPlan(env: Env): Plan<BigqueryConfig> {
  const names = ['BIGQUERY_KEY_JSON', 'BIGQUERY_PROJECT', 'BIGQUERY_DATASET', 'BIGQUERY_LOCATION', 'BIGQUERY_SCRATCH_DATASET'];
  if (!names.some(env)) return { run: false, why: 'no BIGQUERY_* variable is set' };
  if (!env('BIGQUERY_KEY_JSON')) return { run: false, why: 'only some BIGQUERY_* variables are set', missing: ['BIGQUERY_KEY_JSON'] };
  const config: BigqueryConfig = { keyJson: env('BIGQUERY_KEY_JSON') };
  for (const [k, n] of [['project', 'BIGQUERY_PROJECT'], ['dataset', 'BIGQUERY_DATASET'], ['location', 'BIGQUERY_LOCATION'], ['scratch', 'BIGQUERY_SCRATCH_DATASET']] as const) {
    if (env(n)) config[k] = env(n);
  }
  return { run: true, config };
}

/** The plan's own checks, run every time (skipped or not): what skips, what fails, what runs. */
function planControls(): void {
  const full = { SNOWFLAKE_ACCOUNT: 'a-b', SNOWFLAKE_USER: 'u', SNOWFLAKE_WAREHOUSE: 'w', SNOWFLAKE_ROLE: 'r', SNOWFLAKE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----' };
  ok('plan: nothing set, or every value blank (absent repo secrets) — both skip',
    [envOf({}), envOf(Object.fromEntries(Object.keys(full).map((k) => [k, ' '])))].every((e) => { const p = snowflakePlan(e); return !p.run && !p.missing; }) && !bigqueryPlan(envOf({ BIGQUERY_KEY_JSON: '' })).run);
  const partial = snowflakePlan(envOf({ ...full, SNOWFLAKE_ROLE: '', SNOWFLAKE_PRIVATE_KEY: '' }));
  const bqPartial = bigqueryPlan(envOf({ BIGQUERY_DATASET: 'd' }));
  ok('plan: only some of a warehouse\'s variables — refused, naming what is missing (negative control: not a skip)',
    !partial.run && partial.missing?.join() === 'SNOWFLAKE_ROLE,SNOWFLAKE_PRIVATE_KEY or SNOWFLAKE_PAT' && !bqPartial.run && bqPartial.missing?.join() === 'BIGQUERY_KEY_JSON',
    JSON.stringify([partial, bqPartial]));
  const runs = snowflakePlan(envOf(full));
  ok('plan: a full set runs, a one-line PEM gets its line breaks back, a PAT is the other way in',
    runs.run && runs.config.key === '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----' && !runs.config.pat
    && (() => { const p = snowflakePlan(envOf({ ...full, SNOWFLAKE_PRIVATE_KEY: '', SNOWFLAKE_PAT: 'pat' })); return p.run && p.config.pat === 'pat' && !p.config.key; })());
}

async function main(): Promise<void> {
  planControls();
  const env = envOf(process.env);
  const plans = [['Snowflake', snowflakePlan(env)], ['BigQuery', bigqueryPlan(env)]] as const;
  for (const [name, plan] of plans) {
    if (plan.run) continue;
    if (plan.missing) {
      ok(`${name}: its variables are set together (missing: ${plan.missing.join(', ')})`, false);
      summary(`- **${name}: FAILED** — ${plan.why}; missing ${plan.missing.join(', ')}`);
    } else {
      console.log(`skip ${name} real-account checks: ${plan.why} (docs/server/live-data.md, "Testing against a real account")`);
      summary(`- ${name}: skipped — ${plan.why}`);
    }
  }
  const [sf, bq] = [plans[0][1], plans[1][1]];
  if (!sf.run && !bq.run) return;

  // Server mode: the SSRF guard resolves, checks and pins every socket, as in production.
  const context: typeof import('../src/server/context') = require('../src/server/context');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-warehouse-live-'));
  context.enterServerMode(dataDir);
  const nonce = randomBytes(6).toString('hex');
  const identity = { user: { email: 'warehouse-nightly@ordinate.invalid', role: 'admin' as const }, org: { id: ORG } };
  try {
    // One warehouse throwing must not cost the other its run.
    const runOne = async (name: string, go: () => Promise<void>): Promise<void> => {
      const n = failureCount();
      const t = Date.now();
      try {
        await go();
      } catch (err) {
        ok(`${name}: the run reached its end`, false, err instanceof Error ? err.stack : String(err));
      }
      summary(`- ${name}: ran in ${Math.round((Date.now() - t) / 1000)} s, ${failureCount() - n === 0 ? 'every check passed' : `**${failureCount() - n} failed**`}`);
    };
    await context.runInContext(identity, `warehouse-nightly-${nonce}`, async () => {
      if (sf.run) await runOne('Snowflake', () => (require('./warehouseLiveSnowflake') as typeof import('./warehouseLiveSnowflake')).runSnowflake(sf.config, nonce));
      if (bq.run) await runOne('BigQuery', () => (require('./warehouseLiveBigquery') as typeof import('./warehouseLiveBigquery')).runBigquery(bq.config, nonce));
    });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  // ── The secret canary, over the whole run ───────────────────────────────
  ok('canary: control — the grep finds a planted secret, and nothing in a clean string', canaryControl());
  const c = canary();
  say(`canary: ${c.planted} secret spellings planted or issued, ${c.outputs} results and errors kept`);
  ok(`canary: no key, passphrase, PAT, bearer token or assertion in any result, error or printed line (${c.outputs} outputs)`, c.planted > 0 && c.leaks.length === 0, c.leaks.join(', '));
}

main()
  .catch((err: unknown) => ok('the run reached its end', false, err instanceof Error ? err.stack : String(err)))
  .finally(() => {
    writeSummary();
    finish();
  });
