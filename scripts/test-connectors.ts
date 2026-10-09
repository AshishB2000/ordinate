// Self-check for the connector registry (src/connectors/index.ts) and its wiring
// into the connection store (src/connections.ts) and dispatch
// (src/connectionRun.ts). Like test-connections.ts, we point userData
// (ORDINATE_LOCAL_DIR) at a fresh temp dir, then exercise the
// REAL modules against real disk. No framework, no network, no database socket.
//
// What this is guarding:
//   • the CONTRACT — every registered connector is well-formed and read-only, so
//     a family module written by another pair of hands cannot half-register;
//   • the RENDERER BOUNDARY — connectorCatalog() carries form shape and nothing
//     else: no functions (structured clone would throw), no secret values;
//   • the MIGRATION — a real pre-registry v1 connection record, byte-for-byte as
//     the app used to write it, still opens with everything it had;
//   • safeError() — the one function standing between a driver's DSN-carrying
//     error string and a renderer.

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'screenchart-connectors-'));

process.env.ORDINATE_LOCAL_DIR = tmpUserData;

// ponytail: compiled siblings of the .ts sources.
const registry: typeof import('../src/connectors') = require('../src/connectors');
const types: typeof import('../src/connectors/types') = require('../src/connectors/types');
const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const connectionRun: typeof import('../src/connectors/connectionRun') = require('../src/connectors/connectionRun');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');

const CATEGORIES = new Set(['Databases', 'Cloud warehouses', 'Query engines', 'Files & local', 'Apps & SaaS']);
const FAMILIES = new Set(['postgres', 'mysql', 'mssql', 'oracle', 'http', 'duckdb', 'saas', 'snowflake']);
const FIELD_TYPES = new Set(['text', 'number', 'password', 'select', 'checkbox', 'textarea']);
const SECRET_PW = 'sup3r-s3cret-pw';

async function main(): Promise<void> {
  await projects.init();

  // ── Which family modules actually loaded ───────────────────────────────────
  const diag = registry.registryDiagnostics();
  console.log('\n-- registry --');
  console.log('   loaded:', JSON.stringify(diag.counts));
  if (diag.missing.length) console.log('   MISSING modules:', diag.missing.join(', '));
  if (diag.empty.length) console.log('   loaded but registered nothing:', diag.empty.join(', '));
  for (const [mod, msg] of Object.entries(diag.errors)) {
    console.log('   ' + mod + ': ' + String(msg).split('\n')[0]); // first line only — a require stack is noise
  }
  console.log('');

  const all = registry.listConnectors();
  ok('the registry is non-empty', all.length > 0, all.length);
  ok('the URL/API source is registered', registry.getConnector('url') !== null);

  // ── Every connector satisfies the contract ─────────────────────────────────
  const ids = new Set<string>();
  let dupes = 0;
  let badLabel = 0;
  let badFamily: string[] = [];
  let badCategory: string[] = [];
  let notReadOnly: string[] = [];
  let noFields: string[] = [];
  let badField: string[] = [];
  let selectWithoutOptions: string[] = [];

  for (const c of all) {
    if (ids.has(c.id)) dupes++;
    ids.add(c.id);
    if (typeof c.label !== 'string' || !c.label.trim()) badLabel++;
    if (!FAMILIES.has(c.family)) badFamily.push(c.id + ':' + c.family);
    if (!CATEGORIES.has(c.category)) badCategory.push(c.id + ':' + c.category);
    // ponytail: readOnly is typed `true`, so only a JS caller could break it —
    // which is exactly the caller this check exists for.
    if ((c as { readOnly: unknown }).readOnly !== true) notReadOnly.push(c.id);
    if (!Array.isArray(c.fields) || c.fields.length === 0) { noFields.push(c.id); continue; }
    for (const f of c.fields) {
      if (typeof f.key !== 'string' || !f.key.trim()) badField.push(c.id + ': missing key');
      else if (typeof f.label !== 'string' || !f.label.trim()) badField.push(c.id + '.' + f.key + ': missing label');
      else if (!FIELD_TYPES.has(f.type)) badField.push(c.id + '.' + f.key + ': type ' + String(f.type));
      if (f.type === 'select' && (!Array.isArray(f.options) || f.options.length === 0)) {
        selectWithoutOptions.push(c.id + '.' + f.key);
      }
    }
  }

  ok('connector ids are unique', dupes === 0, dupes + ' duplicate(s)');
  ok('listConnectors() ids match the registry size', ids.size === all.length);
  ok('every connector has a non-empty label', badLabel === 0, badLabel + ' without one');
  ok('every connector has a known family', badFamily.length === 0, badFamily.join(', '));
  ok('every connector has a known category', badCategory.length === 0, badCategory.join(', '));
  ok('every connector is readOnly', notReadOnly.length === 0, notReadOnly.join(', '));
  ok('every connector has at least one field', noFields.length === 0, noFields.join(', '));
  ok('every field has a key, a label and a valid type', badField.length === 0, badField.join(', '));
  ok('every select field has options', selectWithoutOptions.length === 0, selectWithoutOptions.join(', '));

  // Categories are grouped, not interleaved — the picker renders in list order.
  const order = ['Databases', 'Cloud warehouses', 'Query engines', 'Files & local', 'Apps & SaaS'];
  const seenCats: string[] = [];
  for (const c of all) if (seenCats[seenCats.length - 1] !== c.category) seenCats.push(c.category);
  ok('listConnectors() groups categories (no interleaving)',
    seenCats.length === new Set(seenCats).size, seenCats.join(' | '));
  ok('categories appear in picker order',
    seenCats.every((cat, i) => i === 0 || order.indexOf(seenCats[i - 1]) <= order.indexOf(cat)), seenCats.join(' | '));

  // ── getConnector ───────────────────────────────────────────────────────────
  ok('getConnector() resolves a registered id', registry.getConnector('url')?.id === 'url');
  ok('getConnector() returns null for an unknown id', registry.getConnector('nope-not-real') === null);
  ok('getConnector() returns null (never throws) for a non-string', registry.getConnector(42 as unknown as string) === null);
  ok('getConnector() returns null for an empty string', registry.getConnector('') === null);
  ok('isKnownConnectorId() agrees with getConnector()',
    registry.isKnownConnectorId('url') === true && registry.isKnownConnectorId('nope-not-real') === false);

  // ── The renderer boundary: connectorCatalog() ──────────────────────────────
  const catalog = registry.connectorCatalog();
  ok('connectorCatalog() covers every connector', catalog.length === all.length);

  // `hosts` is the eighth, and only on a SaaS source: the fixed hosts it may
  // contact, which the form shows. Like `browsable`, a fact, never a value.
  // `browsable` is the seventh: a BOOLEAN derived from whether the connector
  // implements describeTable, so the workbench knows whether to show a schema
  // tree. It is a capability flag, never a value — the same discipline as a
  // field's `secret` flag, which travels while the secret never does.
  const CATALOG_KEYS = new Set(['id', 'label', 'family', 'category', 'blurb', 'fields', 'browsable', 'hosts']);
  const FIELD_KEYS = new Set(['key', 'label', 'type', 'required', 'placeholder', 'default', 'options', 'secret', 'help']);
  let extraKeys: string[] = [];
  let functionsFound: string[] = [];
  let secretDefaults: string[] = [];

  const scanForFunctions = (v: unknown, where: string): void => {
    if (typeof v === 'function') { functionsFound.push(where); return; }
    if (v && typeof v === 'object') {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) scanForFunctions(child, where + '.' + k);
    }
  };

  for (const entry of catalog) {
    for (const k of Object.keys(entry)) if (!CATALOG_KEYS.has(k)) extraKeys.push(entry.id + '.' + k);
    for (const f of entry.fields) {
      for (const k of Object.keys(f)) if (!FIELD_KEYS.has(k)) extraKeys.push(entry.id + '.' + f.key + '.' + k);
      if (f.secret === true && f.default !== undefined) secretDefaults.push(entry.id + '.' + f.key);
    }
  }
  scanForFunctions(catalog, 'catalog');

  ok('connectorCatalog() exposes ONLY the eight documented keys', extraKeys.length === 0, extraKeys.join(', '));
  // The flag has to be a BOOLEAN on every entry: `undefined` on a browsable
  // source would read as "not browsable" in the renderer's `!== false` test and
  // silently hide a schema tree that works.
  const badBrowsable = catalog.filter((e: any) => typeof e.browsable !== 'boolean').map((e: any) => e.id);
  ok('every catalog entry reports `browsable` as a boolean', badBrowsable.length === 0, badBrowsable.join(', '));
  // The four SQL families implement describeTable; HTTP engines and URL do not,
  // and that ASYMMETRY is the whole point of the flag — if it ever reads all-true
  // or all-false, something has stopped being derived from the registry.
  const browsableIds = catalog.filter((e: any) => e.browsable).map((e: any) => e.id);
  ok('the SQL families are browsable',
    ['postgres', 'mysql', 'sqlserver', 'oracle'].every((id) => browsableIds.includes(id)),
    browsableIds.join(', '));
  ok('…and the HTTP engines and the URL source are not',
    ['clickhouse', 'trino', 'elasticsearch', 'url'].every((id) => !browsableIds.includes(id)),
    browsableIds.join(', '));
  ok('connectorCatalog() carries NO functions (listTables/run never cross the bridge)',
    functionsFound.length === 0, functionsFound.join(', '));
  ok('connectorCatalog() ships no default value on a secret field',
    secretDefaults.length === 0, secretDefaults.join(', '));
  // The IPC bridge structured-clones its payload: a function anywhere would throw.
  let clonable = true;
  try { structuredClone(catalog); } catch (_) { clonable = false; }
  ok('connectorCatalog() is structured-clone safe (IPC-sendable)', clonable);
  // A field's `secret` FLAG travels (the renderer needs it to render a password
  // input); a value never does — there is no `value` key anywhere in the catalog.
  const catalogJson = JSON.stringify(catalog);
  ok('connectorCatalog() reports the secret flag', catalogJson.includes('"secret":true'));
  // A select's `options` are {value, label} by design (Snowflake's sign-in
  // picker is the first); outside them no `value` key may appear at all.
  const withoutOptions = JSON.stringify(catalog.map((e) => ({ ...e, fields: e.fields.map(({ options: _o, ...f }) => f) })));
  ok('connectorCatalog() has no value/secrets payload',
    !withoutOptions.includes('"value"') && !catalogJson.includes('"secrets"'));
  ok('…and select options sit only on non-secret fields, as plain strings',
    catalog.every((e) => e.fields.every((f) => !f.options || (!f.secret && f.options.every((o) => typeof o.value === 'string' && typeof o.label === 'string' && Object.keys(o).length === 2)))));

  // ── safeError(): the last line before a renderer ───────────────────────────
  const withPw = types.safeError(
    new Error('password authentication failed: tried ' + SECRET_PW + ' for user reader'),
    { password: SECRET_PW },
  );
  ok('safeError() redacts a password passed in secrets', !withPw.includes(SECRET_PW) && withPw.includes('***'), withPw);
  const withDsn = types.safeError(new Error('could not connect to postgres://bob:s3cr3t@db.example.com:5432/app'));
  ok('safeError() redacts //user:pw@ in a URL', !withDsn.includes('s3cr3t') && withDsn.includes('//***:***@'), withDsn);
  const withToken = types.safeError('GET https://api.example.com failed (Bearer tok_abcdefg)', { token: 'tok_abcdefg' });
  ok('safeError() redacts a token from a plain string', !withToken.includes('tok_abcdefg'), withToken);
  ok('safeError() handles a non-Error, non-string value', types.safeError(null).length > 0);
  ok('safeError() bounds the message length', types.safeError(new Error('x'.repeat(5000))).length <= 500);
  // A 1–2 character secret would redact half the alphabet; safeError skips those
  // deliberately. Pin the behaviour so it is a decision, not a surprise.
  ok('safeError() leaves a <3 char secret alone (would redact everything)',
    types.safeError(new Error('a failure'), { password: 'a' }).includes('a failure'));

  // ── Dispatch: table → SQL per dialect, and the bounds ──────────────────────
  ok('buildTableSql() quotes + limits for the ANSI default',
    connectionRun.buildTableSql('postgres', 'public.sales', 100) === 'select * from "public"."sales" limit 100',
    connectionRun.buildTableSql('postgres', 'public.sales', 100));
  ok('buildTableSql() backtick-quotes for mysql',
    connectionRun.buildTableSql('mysql', 'shop.orders', 10) === 'select * from `shop`.`orders` limit 10',
    connectionRun.buildTableSql('mysql', 'shop.orders', 10));
  ok('buildTableSql() uses TOP for mssql',
    connectionRun.buildTableSql('mssql', 'dbo.orders', 10) === 'select top 10 * from [dbo].[orders]',
    connectionRun.buildTableSql('mssql', 'dbo.orders', 10));
  ok('buildTableSql() uses FETCH FIRST for oracle',
    connectionRun.buildTableSql('oracle', 'HR.EMPLOYEES', 10) === 'select * from HR.EMPLOYEES fetch first 10 rows only',
    connectionRun.buildTableSql('oracle', 'HR.EMPLOYEES', 10));
  ok('buildTableSql() accepts a three-part name', connectionRun.buildTableSql('mssql', 'db.dbo.t', 5) !== null);
  ok('buildTableSql() rejects a four-part name', connectionRun.buildTableSql('postgres', 'a.b.c.d', 5) === null);
  ok('buildTableSql() rejects an injected identifier',
    connectionRun.buildTableSql('postgres', 'sales"; drop table users; --', 5) === null);
  ok('buildTableSql() rejects a quoted/spaced identifier', connectionRun.buildTableSql('postgres', 'my table', 5) === null);
  ok('buildTableSql() rejects an empty name', connectionRun.buildTableSql('postgres', '', 5) === null);

  const urlDef = registry.getConnector('url')!;
  const passthrough = connectionRun.selectionSql(urlDef, { query: 'select 1 from t;  ' }, 10);
  ok('selectionSql() passes a user query through, minus the trailing semicolon',
    passthrough.ok === true && passthrough.sql === 'select 1 from t', JSON.stringify(passthrough));

  const ctx = connectionRun.buildContext({ a: 1 }, { password: 'p' }, { rowLimit: 10, timeoutMs: 5 });
  ok('buildContext() honours a smaller requested bound', ctx.rowLimit === 10 && ctx.timeoutMs === 5);
  const ctxBig = connectionRun.buildContext({}, {}, { rowLimit: 99_000_000, timeoutMs: 99_000_000 });
  ok('buildContext() CLAMPS a bigger requested bound to the module cap',
    ctxBig.rowLimit === connectionRun.ROW_LIMIT && ctxBig.timeoutMs === connectionRun.QUERY_TIMEOUT_MS);
  const ctxNone = connectionRun.buildContext({}, {});
  ok('buildContext() defaults to the module cap', ctxNone.rowLimit === connectionRun.ROW_LIMIT);

  const unknownRun = await connectionRun.runConnection('no-such-connector', {}, {}, { table: 't' });
  ok('runConnection() on an unknown connector errors rather than throwing',
    unknownRun.ok === false && unknownRun.error.startsWith('Unknown connector'), JSON.stringify(unknownRun));
  const unknownList = await connectionRun.listTables('no-such-connector', {}, {});
  ok('listTables() on an unknown connector errors rather than throwing', unknownList.ok === false);

  // ── v1 → v2 migration, from a REAL pre-registry record ─────────────────────
  // Written exactly as src/connections.ts used to write it: kind + flat pg
  // fields + schemaVersion 1. Nothing here may be lost.
  const proj = await projects.createProject('Migration project');
  const connDir = path.join(tmpUserData, 'projects', proj.id, 'connections');
  fs.mkdirSync(connDir, { recursive: true });

  const legacyPgId = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const legacyPg = {
    id: legacyPgId,
    projectId: proj.id,
    name: 'Legacy warehouse',
    kind: 'postgres',
    host: 'db.internal',
    port: 5433,
    database: 'analytics',
    user: 'reader',
    ssl: true,
    table: 'public.sales',
    lastRefreshedAt: '2026-01-02T03:04:05.000Z',
    lastStatus: 'ok',
    lastError: null,
    linkedDatasetId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
    createdAt: '2025-12-01T00:00:00.000Z',
    updatedAt: '2026-01-02T03:04:05.000Z',
    schemaVersion: 1,
  };
  fs.writeFileSync(path.join(connDir, legacyPgId + '.json'), JSON.stringify(legacyPg, null, 2), 'utf8');

  const legacyUrlId = 'cccccccc-3333-4333-8333-cccccccccccc';
  const legacyUrl = {
    id: legacyUrlId,
    projectId: proj.id,
    name: 'Legacy prices API',
    kind: 'url',
    url: 'https://api.example.com/prices.json',
    query: 'unused',
    lastRefreshedAt: null,
    lastStatus: 'untested',
    lastError: null,
    linkedDatasetId: null,
    createdAt: '2025-12-01T00:00:00.000Z',
    updatedAt: '2025-12-01T00:00:00.000Z',
    schemaVersion: 1,
  };
  fs.writeFileSync(path.join(connDir, legacyUrlId + '.json'), JSON.stringify(legacyUrl, null, 2), 'utf8');

  const migratedPg = await connections.getConnection(proj.id, legacyPgId);
  ok('a v1 postgres record still opens', migratedPg !== null);
  ok('v1 kind → connectorId', migratedPg?.connectorId === 'postgres', migratedPg?.connectorId);
  ok('v1 record reads as schemaVersion 2', migratedPg?.schemaVersion === 2);
  ok('v1 host/port/database/user/ssl → values',
    migratedPg?.values.host === 'db.internal' &&
    migratedPg?.values.port === 5433 &&
    migratedPg?.values.database === 'analytics' &&
    migratedPg?.values.user === 'reader' &&
    migratedPg?.values.ssl === true,
    JSON.stringify(migratedPg?.values));
  ok('v1 saved table survives', migratedPg?.table === 'public.sales');
  ok('v1 name/telemetry survive',
    migratedPg?.name === 'Legacy warehouse' &&
    migratedPg?.lastStatus === 'ok' &&
    migratedPg?.lastRefreshedAt === '2026-01-02T03:04:05.000Z' &&
    migratedPg?.linkedDatasetId === 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb' &&
    migratedPg?.createdAt === '2025-12-01T00:00:00.000Z' &&
    migratedPg?.updatedAt === '2026-01-02T03:04:05.000Z');
  // Lossless: no v1 key was dropped on the floor.
  const migratedKeys = new Set([
    ...Object.keys(migratedPg ?? {}),
    ...Object.keys(migratedPg?.values ?? {}),
  ]);
  const lost = ['host', 'port', 'database', 'user', 'ssl', 'table', 'name', 'lastStatus', 'lastRefreshedAt', 'lastError', 'linkedDatasetId', 'createdAt', 'updatedAt']
    .filter((k) => !migratedKeys.has(k));
  ok('no v1 field is lost in migration', lost.length === 0, 'lost: ' + lost.join(', '));

  const migratedUrl = await connections.getConnection(proj.id, legacyUrlId);
  ok('a v1 url record still opens', migratedUrl !== null);
  ok('v1 url kind → the url connector', migratedUrl?.connectorId === 'url');
  ok('v1 url → values.url', migratedUrl?.values.url === 'https://api.example.com/prices.json');
  ok('v1 query survives', migratedUrl?.query === 'unused');

  // listConnections migrates too, and the on-disk file is untouched until a write
  // (lazy + one-way, like datasets.ts v2→v3).
  const listed = await connections.listConnections(proj.id);
  ok('listConnections migrates every v1 record', listed.length === 2 && listed.every((c) => c.schemaVersion === 2));
  const onDiskBefore = JSON.parse(fs.readFileSync(path.join(connDir, legacyPgId + '.json'), 'utf8'));
  ok('migration is LAZY — reading does not rewrite the file', onDiskBefore.schemaVersion === 1 && onDiskBefore.kind === 'postgres');

  const rewritten = await connections.updateConnection(proj.id, legacyPgId, { lastStatus: 'error', lastError: 'nope' });
  ok('updateConnection on a v1 record succeeds', rewritten !== null && rewritten.connectorId === 'postgres');
  const onDiskAfter = JSON.parse(fs.readFileSync(path.join(connDir, legacyPgId + '.json'), 'utf8'));
  ok('the next write lands the record as v2',
    onDiskAfter.schemaVersion === 2 && onDiskAfter.connectorId === 'postgres' && onDiskAfter.values.host === 'db.internal');
  ok('the v2 rewrite keeps the migrated values', onDiskAfter.values.port === 5433 && onDiskAfter.table === 'public.sales');

  // The legacy renderer reads c.kind / c.host — publicConnection still answers.
  const pubMigrated = migratedPg !== null ? connections.publicConnection(migratedPg) : null;
  ok('publicConnection mirrors the legacy display fields',
    pubMigrated?.kind === 'postgres' && pubMigrated?.host === 'db.internal' && pubMigrated?.port === 5433);

  // ── publicConnection never carries a secret-marked value ───────────────────
  // Force one onto a record the wrong way (as a plain value under the url
  // connector's secret field key) and prove the view drops it.
  const smuggled = await connections.saveConnection(proj.id, {
    name: 'Smuggler',
    connectorId: 'url',
    values: { url: 'https://api.example.com/x.json', token: SECRET_PW },
  });
  ok('saveConnection strips a secret-marked value before it reaches disk',
    smuggled !== null && smuggled.values.token === undefined, JSON.stringify(smuggled?.values));
  const smuggledFile = smuggled !== null
    ? fs.readFileSync(path.join(connDir, smuggled.id + '.json'), 'utf8')
    : '';
  ok('the connection file on disk has no secret-marked value', !smuggledFile.includes(SECRET_PW));
  const pubSmuggled = smuggled !== null ? connections.publicConnection({
    ...smuggled,
    values: { ...smuggled.values, token: SECRET_PW }, // as if a stale file had one
  }) : null;
  ok('publicConnection drops a secret-marked value', pubSmuggled !== null && !JSON.stringify(pubSmuggled).includes(SECRET_PW));

  // Inline credentials in a URL never reach the shareable project file.
  const inlineCreds = await connections.saveConnection(proj.id, {
    name: 'Inline creds',
    connectorId: 'url',
    values: { url: 'https://bob:' + SECRET_PW + '@api.example.com/x.json' },
  });
  ok('saveConnection strips userinfo from a url value',
    inlineCreds !== null && typeof inlineCreds.values.url === 'string' && !inlineCreds.values.url.includes(SECRET_PW),
    String(inlineCreds?.values.url));
}

main()
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) {}
    if (failureCount()) { console.error('\n' + failureCount() + ' connector check(s) FAILED'); process.exit(1); }
    console.log('\nAll connector checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
