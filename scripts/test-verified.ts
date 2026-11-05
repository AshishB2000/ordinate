// Verified questions (semantic layer part 3 D5, D7, D9): a question with its checked answer SPEC, never a
// figure — real modules, the real RPC route in server mode (dev sign-in) over a temp DATA_DIR.
//
//   § record   one line, the spec without `matched`, its title the question; the key squashes; a clash is
//              found across phrasings; a term or a period is no value filter; sanitizing is idempotent;
//              Trash round-trips under the question; a stale base refuses; a corrupt file is skipped
// What a row-restricted viewer reads of a verified question is pinned in scripts/test-rowPolicySafetyNet.ts.
//
//   npm run build:ts && node scripts/test-verified.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-verified-'));

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const R: typeof import('../src/analysis/verifiedRules') = require('../src/analysis/verifiedRules');
const S: typeof import('../src/analysis/verifiedQuestions') = require('../src/analysis/verifiedQuestions');
const trash: typeof import('../src/app/trash') = require('../src/app/trash');
const editConflict: typeof import('../src/app/editConflict') = require('../src/app/editConflict');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const recordKinds: typeof import('../src/app/recordKinds') = require('../src/app/recordKinds');

type Identity = import('../src/server/context').Identity;
const TEST_USER = 'ana@acme.test';
const ADMIN: Identity = { user: { email: TEST_USER, role: 'admin' }, org: { id: 'acme' } };
const COLUMNS = [
  { name: 'region', type: 'text' as const }, { name: 'segment', type: 'text' as const },
  { name: 'amount', type: 'number' as const }, { name: 'order_date', type: 'date' as const },
];
const ROWS = [['West', 'SMB', 10, '2026-01-05'], ['East', 'SMB', 20, '2026-02-05'], ['West', 'Ent', 5, '2026-03-05'], ['North', 'Ent', 1, '2026-04-05']];
const T = '2026-11-05T00:00:00.000Z';
const V = '5f0c2d1e-1111-4222-8333-444455556666';
const TERM = '7d2c1f4e-1111-4222-8333-444455556666';

const caught = async (f: () => Promise<unknown>): Promise<unknown> => f().then(() => null, (e: unknown) => e);

(async () => {
  context.enterServerMode(DATA);
  appMod.registerHandlers();
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, () => ADMIN);
  type Reply = { status: number; text: string; body: any }; // any: each channel's own reply
  const call = async (channel: string, payload: unknown): Promise<Reply> => {
    const r = await app.inject({
      method: 'POST', url: `/api/rpc/${encodeURIComponent(channel)}`,
      headers: withCsrf({ 'content-type': 'application/json' }), payload: wire.encode({ args: [payload] }),
    });
    let body: unknown = null;
    try { body = r.statusCode === 200 ? wire.decode(r.body) : JSON.parse(r.body); } catch { body = null; }
    return { status: r.statusCode, text: r.body, body };
  };
  void call;
  const as = <T>(fn: () => Promise<T>): Promise<T> => context.runInContext(ADMIN, 'verified', fn);
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');

  const { P, D } = await as(async () => {
    await projects.init();
    const P = (await projects.createProject('Verified')).id;
    const d = await datasets.saveDataset(P, { name: 'Orders', sourceKind: 'csv', columns: COLUMNS, rows: ROWS });
    if (!d) throw new Error('fixture not saved');
    return { P, D: d.id };
  });
  const SPEC = { datasetId: D, category: 'region', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [], chartType: 'column', title: 'x' };

  // ── § record ──────────────────────────────────────────────────────────────
  const raw = {
    id: V, projectId: P, question: ' Revenue by\nregion ', phrasings: ['revenue per region', 'Revenue  by region!', ''],
    spec: { ...SPEC, matched: [{ column: 'region', said: 'west', value: 'West' }] },
    verifiedBy: 'a', verifiedAt: T, createdAt: T, updatedAt: T, schemaVersion: 1,
  };
  const q = R.sanitizeVerified(raw);
  if (!q) throw new Error('not sanitized');
  ok('one line, spec without matched, title is the question', q.question === 'Revenue by region' && !('matched' in q.spec) && q.spec.title === 'Revenue by region', JSON.stringify(q));
  ok('a phrasing with the question\'s own key, or none, is dropped', q.phrasings.join('|') === 'revenue per region', q.phrasings.join('|'));
  ok('sanitizing twice is sanitizing once', JSON.stringify(R.sanitizeVerified(R.sanitizeVerified(raw))) === JSON.stringify(q));
  ok('NEGATIVE CONTROL: no spec, no question, no id is no record', R.sanitizeVerified({ ...raw, spec: { datasetId: 'nope' } }) === null
    && R.sanitizeVerified({ ...raw, question: '  ' }) === null && R.sanitizeVerified({ ...raw, id: 'x' }) === null);
  ok('the key squashes', R.questionKey('Revenue by region?') === R.questionKey('revenue  BY region'));
  ok('a clash is found across phrasings', R.keyClash([q], ['Revenue per region!']) === 'Revenue per region!');
  ok('NEGATIVE CONTROL: no clash with itself, or with another question', R.keyClash([q], ['Revenue per region'], V) === null && R.keyClash([q], ['Revenue by segment']) === null);
  ok('a term or a period is no value filter', !R.hasValueFilter({ ...q.spec, filters: [{ term: TERM }, { column: 'order_date', period: 'last_quarter' }, { column: 'region', op: 'not_empty' }] })
    && R.hasValueFilter({ ...q.spec, filters: [{ column: 'region', op: '=', value: 'West' }] }));

  await as(async () => {
    await S.writeVerified(P, q);
    ok('stored and read back', (await S.getVerified(P, V))?.question === 'Revenue by region' && (await S.listVerified(P)).length === 1);
    const del = await trash.trashRecord(P, 'verified', V);
    const listed = (await trash.list(P)).some((e) => e.type === 'verified' && e.id === V && e.name === 'Revenue by region');
    const goneNow = (await S.getVerified(P, V)) === null && (await S.listVerified(P)).length === 0;
    const back = await trash.restore(P, 'verified', V);
    ok('Trash: delete → listed under its question → restore', del.ok && del.name === 'Revenue by region' && listed && goneNow && back.ok
      && back.restored[0]?.name === 'Revenue by region' && (await S.getVerified(P, V))?.question === 'Revenue by region', JSON.stringify({ del, listed, goneNow, back }));
    const stale = await caught(() => S.writeVerified(P, { ...q, note: 'x' }, 'stale'));
    ok('a stale base refuses (409 record_changed)', editConflict.isRecordChanged(stale), String(stale));
    const read = await S.readVerified(P, V);
    const moved = await S.writeVerified(P, { ...q, note: 'net of refunds' }, read?.tag);
    ok('NEGATIVE CONTROL: the open tag saves, and the record keeps when it was made', moved?.note === 'net of refunds' && moved.createdAt === T);
    const dir = path.join(recordKinds.projectDir(P), recordKinds.RECORD_DIR.verified);
    await recordFs.writeFile(path.join(dir, '00000000-0000-4000-8000-000000000001.json'), '{ not json', 'utf8');
    ok('a corrupt file is skipped', (await S.listVerified(P)).length === 1);
  });

  await app.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
