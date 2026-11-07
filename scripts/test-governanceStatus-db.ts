// The status channels (semantic layer part 4, D3) over the real route, as real users in a scratch Postgres
// (scripts/rowPolicyHarness.ts): only a project admin reviews, certifies, retires or clears; an editor and a viewer are
// 403 before the handler runs. A stale base is 409 record_changed carrying the current pin.
// NEGATIVE CONTROL: the admin certifies.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-governanceStatus-db.js

export {}; // module scope: sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as H from './rowPolicyHarness';

(async () => {
  const W = await H.world('governance status (db) suite');
  if (!W) return finish();
  try {
    const { P, plain } = W;
    const saved = await W.call('boss', 'metric:save', { projectId: P, input: { name: 'Revenue', datasetId: plain, definition: { column: 'sales', aggregation: 'sum' } } });
    const M: string = saved.body.metric.id;
    const REF = `metric:${M}`;
    const review = await W.call('boss', 'model:review', { projectId: P, ref: REF });
    const body = { projectId: P, ref: REF, base: String(review.body?.pin) };
    ok('the admin reviews', review.body?.ok === true && typeof review.body.pin === 'string');
    ok('an editor is 403 on review', (await W.call('ed', 'model:review', { projectId: P, ref: REF })).status === 403);
    ok('an editor is 403 on certify', (await W.call('ed', 'model:certify', body)).status === 403);
    ok('a viewer is 403 on retire', (await W.call('east', 'model:retire', { projectId: P, ref: REF })).status === 403);
    ok('a viewer is 403 on clear', (await W.call('west', 'model:clearStatus', { projectId: P, ref: REF })).status === 403);
    ok('…and nothing was written', (await W.call('boss', 'model:review', { projectId: P, ref: REF })).body?.status === null);
    ok('NEGATIVE CONTROL: the admin certifies', (await W.call('boss', 'model:certify', body)).body?.ok === true);
    await W.call('ed', 'metric:update', { projectId: P, id: M, patch: { filters: [{ type: 'filter', column: 'qty', op: '>', value: 1 }] } });
    const CURRENT = (await W.call('boss', 'model:review', { projectId: P, ref: REF })).body?.pin;
    const stale = await W.call('boss', 'model:certify', body);
    ok('a stale base is 409 record_changed with the current pin', stale.status === 409 && stale.body?.code === 'record_changed' && stale.body.tag === CURRENT && CURRENT !== body.base, stale.text);
  } finally {
    await W.close();
  }
  finish();
})().catch((err) => {
  console.error('FAIL harness', err);
  process.exitCode = 1;
  finish();
});
