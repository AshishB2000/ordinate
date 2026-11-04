// The facts door (docs/semantic-layer/02-source-tables.md: D6, D15): the ONE way the app reads a
// warehouse table's comments, keys and partitions. Part 1 is the door on test connectors: the
// reader wins over describeTable, a secret in any string is redacted, the bounds reach the
// connector, the SSRF guard runs first. Part 2 is the fake warehouse's reader over DuckDB's own
// catalog, with its count of catalog calls.
//
//   npm run build:ts && node scripts/test-tableFacts.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as H from './liveQueryHarness'; // enters server mode, which turns the SSRF guard on

const registry: typeof import('../src/connectors/index') = require('../src/connectors/index');
const { LIVE_FAKE_ID, resetFake } = H.fakeMod;
const fake = H.fake;
const { readTableFacts, FACTS_ROWS }: typeof import('../src/connectors/tableFactsRun') = require('../src/connectors/tableFactsRun');
const { redactSecrets, safeError }: typeof import('../src/connectors/types') = require('../src/connectors/types');
type ConnectorContext = import('../src/connectors/types').ConnectorContext;
type ConnectorDef = import('../src/connectors/types').ConnectorDef;

const S = { password: 'pw-canary-71ab' };
const calls = { tableFacts: 0, describe: 0 };
let seenCtx: ConnectorContext | null = null;

function base(id: string, withHost = false): ConnectorDef {
  return {
    id, label: id, family: 'facts-test', category: 'Databases', readOnly: true,
    fields: [...(withHost ? [{ key: 'host', label: 'Host', type: 'text' as const }] : []), { key: 'password', label: 'Password', type: 'password', secret: true }],
    async listTables() { return { ok: true, tables: [] }; },
    async run() { return { ok: false, error: 'not here' }; },
  };
}

const describeTable: ConnectorDef['describeTable'] = async () => { calls.describe += 1; return { ok: true, columns: [{ name: 'a', type: 'int' }], rowEstimate: 5 }; };

function register(): void {
  registry.registerTestConnector({
    ...base('facts-both'),
    describeTable,
    async tableFacts(ctx, table) {
      calls.tableFacts += 1;
      seenCtx = ctx;
      if (table === 'boom') return { ok: false, error: 'login failed for ' + ctx.secrets.password };
      if (table === 'throws') throw new Error('driver said //u:' + ctx.secrets.password + '@db');
      if (table === 'nocolumns') return { ok: true } as never;
      return { ok: true, comment: 'pw=' + ctx.secrets.password, columns: [{ name: 'a', type: 'int', comment: ctx.secrets.password }] };
    },
  });
  registry.registerTestConnector({ ...base('facts-describe'), describeTable });
  registry.registerTestConnector(base('facts-none'));
  registry.registerTestConnector({
    ...base('facts-host', true),
    async tableFacts(ctx) { calls.tableFacts += 1; return { ok: true, columns: [{ name: ctx.pinned?.address ?? 'unpinned', type: 'int' }] }; },
  });
}

async function door(): Promise<void> {
  const r = await readTableFacts('facts-both', {}, S, 't');
  ok('the reader wins: describeTable never runs', r!.ok && calls.tableFacts === 1 && calls.describe === 0);
  ok('a secret in any string is redacted', !JSON.stringify(r).includes(S.password) && JSON.stringify(r).includes('***'), JSON.stringify(r));
  const boom = await readTableFacts('facts-both', {}, S, 'boom');
  ok('…and in an error', boom!.ok === false && !boom!.error.includes(S.password) && boom!.error.includes('***'), JSON.stringify(boom));
  const thrown = await readTableFacts('facts-both', {}, S, 'throws');
  ok('…and in a thrown one, with the credentials of a URL', thrown!.ok === false && !thrown!.error.includes(S.password), JSON.stringify(thrown));
  const none = await readTableFacts('facts-both', {}, S, 'nocolumns');
  ok('a reply with no columns list is an error, not facts', none!.ok === false);
  ok('no reader: describeTable\'s columns and estimate', JSON.stringify(await readTableFacts('facts-describe', {}, {}, 't')) === '{"ok":true,"facts":{"columns":[{"name":"a","type":"int"}],"rowEstimate":5}}');
  ok('neither: null, not an error', (await readTableFacts('facts-none', {}, {}, 't')) === null);
  ok('an unknown connector is an error', ((x) => x!.ok === false && /Unknown connector/.test(x!.error))(await readTableFacts('nope', {}, {}, 't')));
  ok('the row bound reaches the connector', seenCtx!.rowLimit === 2000 && FACTS_ROWS === 2000 && seenCtx!.timeoutMs === 30_000);

  ok('redactSecrets: a literal secret and a URL\'s credentials', redactSecrets('a pw-canary-71ab b //u:p@h', S) === 'a *** b //***:***@h');
  ok('safeError still cuts to 500 characters', safeError('x'.repeat(900)).length === 500);

  // The SSRF guard (server mode: the harness entered it). 10.0.0.5 is private; SSRF_ALLOW is how an operator opens it.
  delete process.env.SSRF_ALLOW;
  const before = calls.tableFacts;
  const refused = await readTableFacts('facts-host', { host: '10.0.0.5' }, {}, 't');
  ok('a private host is refused before the reader runs', refused!.ok === false && /^Refused/.test(refused!.error) && calls.tableFacts === before, JSON.stringify(refused));
  process.env.SSRF_ALLOW = '10.0.0.0/8';
  const allowed = await readTableFacts('facts-host', { host: '10.0.0.5' }, {}, 't');
  ok('NEGATIVE CONTROL: SSRF_ALLOW lets it through, pinned to the address', allowed!.ok === true && allowed!.facts.columns[0].name === '10.0.0.5' && calls.tableFacts === before + 1, JSON.stringify(allowed));
  delete process.env.SSRF_ALLOW;
}

async function fakeWarehouse(): Promise<void> {
  await H.warehouseExec(H.ORG_A, "CREATE OR REPLACE TABLE wh_keys (id INTEGER PRIMARY KEY, note VARCHAR); COMMENT ON COLUMN wh_keys.note IS 'Free text'");
  const read = (t: string, values = {}) => H.as(H.ORG_A, () => readTableFacts(LIVE_FAKE_ID, values, {}, t));
  const got = async (t: string, values = {}) => { const r = await read(t, values); return r && r.ok ? r.facts : null; };
  const n0 = fake.catalogCalls;
  const f = await got('live_fake_orders', { fixture: 'orders' });
  ok('fake: the table and column comments', f?.comment === 'Orders, one row per line' && f.columns.find((c) => c.name === 'amount')?.comment === 'Order amount in USD', JSON.stringify(f));
  ok('fake: types, nullability and the estimate come from DuckDB', f?.columns.map((c) => c.type).join() === 'VARCHAR,DOUBLE,DATE' && f.columns.every((c) => typeof c.nullable === 'boolean') && f.rowEstimate === 240, JSON.stringify(f));
  const k = await got('wh_keys');
  ok('fake: a declared key', JSON.stringify(k?.primaryKey) === '{"columns":["id"],"enforced":true}' && k?.columns[0].key === true && !k.columns[1].key, JSON.stringify(k));
  ok('fake: a column comment alone', k?.columns[1].comment === 'Free text' && !('comment' in k));
  const bad = await read('x"; drop table wh_keys; --');
  ok('fake: a hostile name is refused before DuckDB', bad?.ok === false && (await read('wh_keys'))?.ok === true);
  ok('fake: counted (the hostile name never reached the reader)', fake.catalogCalls === n0 + 3, `${fake.catalogCalls - n0}`);
  const gone = await read('no_such_table');
  ok('fake: a table that is not there is an error', gone?.ok === false, JSON.stringify(gone));
  fake.factsHook = async () => ({ ok: true, comment: 'from the hook', columns: [{ name: 'h', type: 'int' }] });
  ok('fake: a test\'s hook may answer instead', (await got('wh_keys'))?.comment === 'from the hook');
  resetFake();
  ok('fake: resetFake clears the hook and the count', fake.factsHook === null && fake.catalogCalls === 0);
  const calls0 = fake.calls.length;
  await read('wh_keys');
  ok('fake: fake.calls records runBound only', fake.calls.length === calls0 && fake.catalogCalls === 1);
}

(async () => {
  register();
  await door();
  await fakeWarehouse();
  H.cleanup();
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
