// The project scripts/test-meaningSearch.ts searches: three datasets and a wide one (110 columns, so the job sends more
// than one batch), a `region` column on two datasets, a dataset whose texts the fake provider can refuse, a column
// hidden from the viewer, metrics, terms, a source table only editors see, and eight verified
// questions, "Revenue by region" the oldest (words alone rank it last for a question sharing none of its words; with
// eight questions every one is among the nearest, so it is meaning's first against the others' fused ranks). Words in it the fake embedder's synonyms reach: revenue (turnover, income,
// sales), region (territory), salary (compensation, wage, pay), customer (clients).

const crypto: typeof import('crypto') = require('crypto');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const record: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const columnAccess: typeof import('../src/data/columnAccess') = require('../src/data/columnAccess');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const terms: typeof import('../src/analysis/terms') = require('../src/analysis/terms');
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const sourceTables: typeof import('../src/app/sourceTables') = require('../src/app/sourceTables');
const store: typeof import('../src/analysis/verifiedQuestions') = require('../src/analysis/verifiedQuestions');

type Identity = import('../src/server/context').Identity;
type VerifiedQuestion = import('../src/analysis/verifiedRules').VerifiedQuestion;

export const WHO: Array<[string, Identity]> = [
  ['admin', { user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } }],
  ['editor', { user: { email: 'eve@acme.test', role: 'viewer' }, org: { id: 'acme' } }],
  ['viewer', { user: { email: 'vic@acme.test', role: 'viewer' }, org: { id: 'acme' } }],
];

export interface World { P: string; orders: string; staff: string; customers: string; poison: string; verified: VerifiedQuestion[]; rename: (datasetId: string, name: string) => Promise<void> }

export async function meaningWorld(asAdmin: <T>(fn: () => Promise<T>) => Promise<T>): Promise<World> {
  return asAdmin(async () => {
    await projects.init();
    const P = (await projects.createProject('Meaning search'))!.id;
    const save = async (name: string, cols: Array<[string, 'text' | 'number']>) =>
      (await datasets.saveDataset(P, { name, sourceKind: 'csv', columns: cols.map(([n, type]) => ({ name: n, type })), rows: [cols.map(([, t]) => (t === 'number' ? 1 : 'x'))] }))!.id;
    const orders = await save('Online orders', [['region', 'text'], ['sales_amount', 'number'], ['order_date', 'text'], ['customer', 'text'], ['quantity', 'number']]);
    const staff = await save('Staff', [['dept', 'text'], ['salary', 'number'], ['pay_grade', 'text'], ['region', 'text']]); // `region`: Orders' too, a text of its own
    const poison = await save('Poison data', [['pz', 'text']]); // the fake provider refuses a text with "poison" while told to
    const customers = await save('Customers', [['city', 'text'], ['segment', 'text'], ['visits', 'number']]);
    await save('Wide', Array.from({ length: 110 }, (_, i): [string, 'number'] => [`c${String(i).padStart(3, '0')}`, 'number']));
    await record.serialized(record.datasetFilePath(P, staff), (raw) => {
      raw.columnAccess = columnAccess.buildColumnAccess(raw, [{ column: 'salary', visibleTo: [{ userId: crypto.randomUUID() }] }], 'ana@acme.test', new Date().toISOString());
      return true;
    });
    await catalog.setDoc(P, `dataset:${orders}`, { description: 'Every order placed online, one row per order' });
    await catalog.setColumn(P, orders, 'region', { aliases: ['territory'], displayName: 'Sales region', description: 'Where the order shipped' }, ['region', 'sales_amount', 'order_date', 'customer', 'quantity']);
    await catalog.setColumn(P, staff, 'salary', { aliases: ['wage'], description: 'Annual pay before tax' }, ['dept', 'salary', 'pay_grade', 'region']);
    const metric = async (name: string, datasetId: string, column: string, description?: string) =>
      metrics.saveMetric(P, { name, datasetId, definition: { column, aggregation: 'sum' }, ...(description ? { description } : {}) });
    await metric('Revenue', orders, 'sales_amount', 'Total sales revenue');
    await metric('Gross margin', orders, 'sales_amount');
    await metric('Payroll', staff, 'salary', 'Annual pay of every employee');
    await terms.saveTerm(P, { name: 'West coast', aliases: ['Pacific'], description: 'Orders shipped to the west', datasetId: orders, filters: [{ type: 'filter', column: 'region', op: '=', value: 'West' }] });
    await terms.saveTerm(P, { name: 'Big buyers', aliases: [], datasetId: customers, filters: [{ type: 'filter', column: 'visits', op: '>', value: 10 }] });
    const conn = (await connections.saveConnection(P, { name: 'Warehouse', connectorId: 'postgres', values: { host: 'db.example.test', port: 5432, database: 'app', user: 'reader' } } as never))!.id;
    for (const t of ['ANALYTICS.INCOME_LEDGER', 'ANALYTICS.CUSTOMERS']) await sourceTables.createSourceDoc(P, conn, t, {});
    const spec = (datasetId: string, category: string, column: string) => ({ datasetId, category, measures: [{ column, aggregation: 'sum' as const }], filters: [], chartType: 'column', title: '' });
    const verified: VerifiedQuestion[] = [];
    const asks: Array<[string, string]> = [['Revenue by region', orders], ['Orders by month', orders], ['Quantity by customer', orders], ['Average quantity', orders],
      ['Orders placed online', orders], ['Top customers', orders], ['Busiest day', orders], ['Customers by city', customers]];
    for (const [i, [question, ds]] of asks.entries()) {
      const at = `2026-11-0${i + 1}T10:00:00.000Z`;
      const q = await store.writeVerified(P, {
        // Fixed ids, ascending with age: the questions the fake puts at distance 1 tie, and a tie goes by key.
        id: `00000000-0000-4000-8000-00000000000${i + 1}`, projectId: P, question, phrasings: [], spec: ds === orders ? spec(ds, 'region', 'sales_amount') : spec(ds, 'city', 'visits'),
        verifiedBy: 'ana@acme.test', verifiedAt: at, createdAt: at, updatedAt: at, schemaVersion: 1,
      });
      if (!q) throw new Error('fixture: ' + question);
      verified.push(q);
    }
    const rename = async (datasetId: string, name: string): Promise<void> => {
      await asAdmin(() => record.serialized(record.datasetFilePath(P, datasetId), (raw) => { raw.name = name; return true; }));
    };
    return { P, orders, staff, customers, poison, verified, rename };
  });
}
