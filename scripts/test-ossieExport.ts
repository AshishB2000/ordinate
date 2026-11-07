// The Ossie export (semantic layer part 7, g1; docs/semantic-layer/ossie-mapping.md), over ./modelFixture.ts.
//
// 1. Mapping: the pinned version, datasets with sources only where allowed, fields, simple/distinct metrics, key,
//    relationship; what Ossie lacks is in the report, never silently gone.
// 2. Leaks: no planted SQL, secret, rule value or source table outside the one Live table-origin dataset.
// 3. Byte-stable, and the golden (scripts/fixtures/golden/ossie, ids normalised).
// 4. The spec's required keys (./ossieShape.ts). NEGATIVE CONTROL: a document missing one fails.
// 5. model:exportOssie: viewer 403, restricted caller refused, an editor gets the file and the report.
//
//   npm run build:ts && node scripts/test-ossieExport.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Identity } from '../src/server/context';
import { H, close, post } from './liveRouteHarness';
import { liveRecord } from './liveQueryHarness';
import { ossieShape } from './ossieShape';
import { modelJson } from '../src/app/modelFormat';
import { buildModelFixture, goldenOf, SOURCE_TABLE, POLICY_CANARY } from './modelFixture';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const GOLDEN = path.join(__dirname, 'fixtures', 'golden', 'ossie');
const { ossieExport, OSSIE_SPEC_VERSION }: typeof import('../src/app/ossieExport') = require('../src/app/ossieExport');

void (async () => {
  const F = await buildModelFixture();
  // A Live dataset defined by SQL: it has no table to name.
  await H.as(H.ORG_A, () => liveRecord.saveLiveRecord(F.P, { name: 'Sales (SQL)', columns: [{ name: 'x', type: 'number' }], origin: { kind: 'connection', connId: F.connId, sql: 'SELECT 7 AS x /* PLANTED_SQL */' } }));
  const out = await H.as(H.ORG_A, () => ossieExport(F.P));
  const doc = JSON.parse(out.text);
  const ds = (n: string) => doc.datasets.find((d: { name: string }) => d.name === n);

  ok('the version is pinned in the document', doc.version === OSSIE_SPEC_VERSION && OSSIE_SPEC_VERSION === '0.2.0.dev0');
  ok('the model is named after the project', doc.name === 'Retail model');
  ok('every dataset is a dataset', doc.datasets.length === 4, JSON.stringify(doc.datasets.map((d: { name: string }) => d.name)));
  ok('the table-origin Live dataset names its source', ds('live').source === SOURCE_TABLE);
  ok('an extract and a SQL Live dataset have no source, and the report says so', out.report.noSource.join() === 'Customers,Orders,Sales (SQL)', out.report.noSource.join());
  ok('the key and the documented field travel', JSON.stringify(ds('orders').primary_key) === '["order_id"]' && ds('orders').fields.some((f: { name: string; description?: string }) => f.name === 'amount' && f.description === 'Net amount'));
  ok('a date column is a time dimension', ds('orders').fields.find((f: { name: string }) => f.name === 'day').dimension?.is_time === true);
  ok('aliases are synonyms', JSON.stringify(ds('orders').fields.find((f: { name: string }) => f.name === 'amount').ai_context.synonyms) === '["Amount","net"]');
  ok('the guide is the dataset ai_context instructions', ds('orders').ai_context.instructions.includes('One row per order line'));
  const ms = (ds('orders').metrics ?? []) as { name: string; expression: { sql: string } }[];
  ok('a relationship maps from the many side', JSON.stringify(doc.relationships.map((r: { from: string; to: string; from_columns: string[]; to_columns: string[] }) => [r.from, r.to, r.from_columns, r.to_columns])) === '[["orders","customers",["customer_id"],["id"]]]');
  const rep = (kind: string, name: string) => out.report.notMapped.some((n) => n.kind === kind && n.name === name && n.reason.length > 0);
  ok('a metric with a filter is reported, not exported without it', rep('metric', 'Revenue') && !ms.some((m) => m.name === 'Revenue'));
  ok('a snapshot, a period and a formula metric are reported', rep('metric', 'Stock on hand') && rep('metric', 'Revenue MTD') && rep('metric', 'Avg basket'));
  ok('a distinct count of a text column is reported, not exported (section 6 has the figures)', rep('metric', 'Orders') && !ms.some((m) => m.name === 'Orders'));
  ok('terms and value labels are reported', rep('term', 'EMEA') && rep('valueLabels', 'region'));
  ok('role and sensitivity are reported; a default calendar is not', rep('role', 'Orders') && rep('sensitivity', 'amount') && !rep('calendar', 'Calendar'));
  ok('every unmapped definition is kept in the ordinate extension', doc.custom_extensions[0].vendor_name === 'ordinate' && /EMEA/.test(doc.custom_extensions[0].data));

  const { exportModel }: typeof import('../src/app/modelExport') = require('../src/app/modelExport');
  const model = await H.as(H.ORG_A, () => exportModel(F.P));
  const inDoc = (n: string) => doc.datasets.some((d: { metrics?: { name: string }[] }) => d.metrics?.some((m) => m.name === n));
  const named = [...model.files].filter(([p]) => /^(metrics|terms)\//.test(p)).map(([, t]) => JSON.parse(t).name as string);
  ok('every metric and term is in the document or the report, never neither', named.length === 6 && named.every((n) => inDoc(n) || out.report.notMapped.some((r) => r.name === n)), named.join());

  // ── 2. Leaks ──
  const everything = out.text + JSON.stringify(out.report);
  ok('no planted SQL, secret, rule value, salt or connection id', [...F.planted.filter(([w]) => w !== 'source table name').map((p) => p[1]), 'PLANTED_SQL', POLICY_CANARY].every((n) => !everything.includes(n)));
  ok('the source table appears once, in the Live dataset', everything.split(SOURCE_TABLE).length === 2);

  // ── 3. Stable ──
  const again = await H.as(H.ORG_A, () => ossieExport(F.P));
  ok('byte-stable', again.text === out.text && JSON.stringify(again.report) === JSON.stringify(out.report));

  // ── 4. The spec's required shape ──
  ok('the emitted document satisfies the spec\'s required keys and types', ossieShape(out.text).length === 0, ossieShape(out.text).join('; '));
  const without = (k: string) => JSON.stringify(Object.fromEntries(Object.entries(doc).filter(([key]) => key !== k)));
  ok('NEGATIVE CONTROL: a document without datasets, or with a bad datatype, fails', ossieShape(without('datasets')).length > 0 && ossieShape(without('version')).length > 0
    && ossieShape(JSON.stringify({ ...doc, datasets: [{ name: 'a', source: 'a', fields: [{ name: 'f', expression: { sql: 'f' }, datatype: 'Number' }] }] })).length === 1);

  // ── 3b. The golden ──
  const golden = (text: string) => goldenOf(new Map([['x', text]])).get('x');
  ok('the document matches the golden', golden(out.text) === fs.readFileSync(path.join(GOLDEN, 'ossie.json'), 'utf8'));
  ok('the report matches the golden', golden(modelJson(out.report)) === fs.readFileSync(path.join(GOLDEN, 'report.json'), 'utf8'));

  // ── 5. model:exportOssie: who, and what the reply holds ──
  const api: typeof import('../src/api/index') = require('../src/api/index');
  const authz: typeof import('../src/server/authz/index') = require('../src/server/authz/index');
  const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
  const msg: typeof import('../src/app/modelFileMessages') = require('../src/app/modelFileMessages');
  const VIEWER: Identity = { user: { email: 'vic@acme.test', role: 'viewer' }, org: { id: 'acme' } };
  const EDITOR: Identity = { user: { email: 'eve@acme.test', role: 'editor' }, org: { id: 'acme' } };
  const contract = api.contracts['model:exportOssie'];
  const input = { projectId: F.P };
  ok('contract: write, project-scoped, a strict input', !!contract && contract.access === 'write' && contract.project(input) === F.P && !contract.input.safeParse({ ...input, path: '/x' }).success && contract.input.safeParse(input).success);
  const grants = (rank: number) => ({ query: async () => ({ rows: [{ rank }] }) }) as unknown as import('pg').Pool;
  const decide = (who: Identity, rank: number) => H.as(who, () => authz.authorize(contract, input, who, grants(rank)));
  ok('a viewer is refused (403 before the handler)', !(await decide(VIEWER, 1)).ok);
  ok('NEGATIVE CONTROL: a project editor may export', (await decide(EDITOR, 2)).ok);
  const asViewer = (await H.as(VIEWER, async () => rpc.handlers.get('model:exportOssie')?.(undefined, input))) as { ok?: boolean; error?: string; downloadToken?: string };
  ok('a restricted caller reaching the handler gets the same refusal as the model export', asViewer?.ok === false && asViewer.error === (await H.as(VIEWER, async () => msg.modelRestricted())) && !('downloadToken' in asViewer), JSON.stringify(asViewer));
  const r = (await post('model:exportOssie', input)).value;
  ok('NEGATIVE CONTROL: an editor gets a token and the report, and no path', r.ok === true && typeof r.downloadToken === 'string' && JSON.stringify(r.report) === JSON.stringify(out.report) && r.version === OSSIE_SPEC_VERSION && !/\.json|temp/.test(JSON.stringify(r)), JSON.stringify(r).slice(0, 200));
  const { ossieBytes }: typeof import('../src/ipc/modelFiles') = require('../src/ipc/modelFiles');
  const sent = await H.as(H.ORG_A, () => ossieBytes(F.P));
  ok('the file the route offers is the export, named for the project', sent.bytes.toString('utf8') === out.text && sent.name === 'Retail model-ossie.json', sent.name);

  // ── 6. A metric is in the document only where its SQL over the source gives Ordinate's figure ──
  // After every check above, which read the fixture as built. `Blanks`: a Live dataset over a warehouse table, no base filter.
  const must = async (channel: string, payload: unknown) => {
    const res = await post(channel, payload);
    if (res.status !== 200 || res.value?.ok === false) throw new Error(`${channel}: ${res.body.slice(0, 300)}`);
    return res.value;
  };
  const metric = async (datasetId: string, name: string, definition: unknown): Promise<string> => {
    const v = await must('metric:save', { projectId: F.P, input: { datasetId, name, definition } });
    return (v.metric?.id ?? v.id) as string;
  };
  const BCOLS = [{ name: 'tag', type: 'text' as const }, { name: 'n', type: 'number' as const }];
  await H.as(H.ORG_A, () => H.fakeMod.loadWarehouseTable('blanks', BCOLS, [['EU', 1], ['', 2], ['  ', 2], [null, null], ['ME', 3], ['EU', 1]]));
  const B = await H.as(H.ORG_A, () => liveRecord.saveLiveRecord(F.P, { name: 'Blanks', columns: BCOLS, origin: { kind: 'connection', connId: F.connId, table: 'blanks' } }));
  if (!B) throw new Error('Blanks not saved');
  const ids6 = new Map<string, string>();
  ids6.set('Live revenue', await metric(F.live, 'Live revenue', { column: 'amount', aggregation: 'sum' }));
  ids6.set('N total', await metric(B.id, 'N total', { column: 'n', aggregation: 'sum' }));
  for (const [name, column, aggregation] of [['Tags', 'tag', 'count'], ['Distinct tags', 'tag', 'countd'], ['Ns', 'n', 'count'], ['Distinct ns', 'n', 'countd']]) ids6.set(name, await metric(B.id, name, { column, aggregation }));
  // `amount` is already marked financial; `customer_id` is marked personal here.
  await must('catalog:setColumn', { projectId: F.P, datasetId: F.orders, column: 'amount', patch: { example: '1234.56 PAYROLL_CANARY' } });
  await must('catalog:setColumn', { projectId: F.P, datasetId: F.orders, column: 'customer_id', patch: { sensitivity: 'personal', example: 'c1', values: [{ value: 'c1', label: 'PERSONAL_CANARY' }] } });
  const six = await H.as(H.ORG_A, () => ossieExport(F.P));
  const doc6 = JSON.parse(six.text);
  const metricsOf = (n: string) => (doc6.datasets.find((d: { name: string }) => d.name === n)?.metrics ?? []) as { name: string; expression: { sql: string } }[];
  const rep6 = (kind: string, name: string) => six.report.notMapped.some((n) => n.kind === kind && n.name === name && n.reason.length > 0);
  ok('a metric on a Live dataset with base filters is reported, never exported as the whole table\'s total', rep6('metric', 'Live revenue') && !metricsOf('live').length, JSON.stringify(metricsOf('live')));
  const fieldOf = (d: string, f: string) => doc6.datasets.find((x: { name: string }) => x.name === d).fields.find((x: { name: string }) => x.name === f);
  ok('a field marked personal or financial exports no example and no value labels', !fieldOf('orders', 'amount').ai_context?.examples && !fieldOf('orders', 'customer_id').ai_context?.examples
    && !/PAYROLL_CANARY|PERSONAL_CANARY/.test(six.text + JSON.stringify(six.report)) && rep6('sensitivity', 'customer_id') && !rep6('valueLabels', 'customer_id'), JSON.stringify([fieldOf('orders', 'amount'), fieldOf('orders', 'customer_id')]));
  ok('NEGATIVE CONTROL: an unmarked field keeps its example and value labels', JSON.stringify(fieldOf('orders', 'region').ai_context?.examples) === '["EU"]' && /Middle East/.test(six.text) && rep6('valueLabels', 'region'));
  ok('NEGATIVE CONTROL: a metric on a Live dataset without base filters maps', metricsOf('blanks').some((m) => m.name === 'N total' && m.expression.sql === 'SUM(n)'), JSON.stringify(metricsOf('blanks')));
  // Ordinate's figure (metric:values) against the exported SQL run over the document's source, in the same warehouse.
  const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
  const ordinate = async (name: string): Promise<unknown> => (await must('metric:values', { projectId: F.P, ids: [ids6.get(name)] }))[0]?.value;
  const blanks = doc6.datasets.find((d: { name: string }) => d.name === 'blanks');
  const overSource = async (sql: string): Promise<number> => Number((await H.as(H.ORG_A, () => duck.queryAsync(`SELECT ${sql} AS v FROM ${blanks.source}`)))[0].v);
  ok('a count and a distinct count of a text column with blanks are reported, not exported', rep6('metric', 'Tags') && rep6('metric', 'Distinct tags')
    && !metricsOf('blanks').some((m) => m.name === 'Tags' || m.name === 'Distinct tags'), JSON.stringify(metricsOf('blanks')));
  const [tags, countTag] = [await ordinate('Tags'), await overSource('COUNT(tag)')];
  ok('…because COUNT(tag) counts the blanks Ordinate does not', tags === 3 && countTag === 5, `${String(tags)} vs ${countTag}`);
  const mapped = metricsOf('blanks');
  const agree: string[] = [];
  for (const m of mapped) if (!Object.is(await ordinate(m.name), await overSource(m.expression.sql))) agree.push(m.name);
  ok('NEGATIVE CONTROL: a count, a distinct count and a sum of a number column map, and their SQL gives Ordinate\'s figure (Object.is)',
    ['N total', 'Ns', 'Distinct ns'].every((n) => mapped.some((m) => m.name === n)) && agree.length === 0, `${JSON.stringify(mapped)} disagree: ${agree.join()}`);

  await close();
  finish();
})();
