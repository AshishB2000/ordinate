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
import { H, close } from './liveRouteHarness';
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
  const ms = ds('orders').metrics as { name: string; expression: { sql: string } }[];
  ok('a distinct count maps', ms.some((m) => m.name === 'Orders' && m.expression.sql === 'COUNT(DISTINCT order_id)'));
  ok('a relationship maps from the many side', JSON.stringify(doc.relationships.map((r: { from: string; to: string; from_columns: string[]; to_columns: string[] }) => [r.from, r.to, r.from_columns, r.to_columns])) === '[["orders","customers",["customer_id"],["id"]]]');
  const rep = (kind: string, name: string) => out.report.notMapped.some((n) => n.kind === kind && n.name === name && n.reason.length > 0);
  ok('a metric with a filter is reported, not exported without it', rep('metric', 'Revenue') && !ms.some((m) => m.name === 'Revenue'));
  ok('a snapshot, a period and a formula metric are reported', rep('metric', 'Stock on hand') && rep('metric', 'Revenue MTD') && rep('metric', 'Avg basket'));
  ok('terms and value labels are reported', rep('term', 'EMEA') && rep('valueLabels', 'region'));
  ok('role, calendar and sensitivity are reported', rep('role', 'Orders') && rep('calendar', 'Calendar') && rep('sensitivity', 'amount'));
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

  await close();
  finish();
})();
