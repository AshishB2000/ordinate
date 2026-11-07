// Status in the lists, for people (semantic layer part 4, D7), over the real route in a scratch Postgres
// (scripts/rowPolicyHarness.ts): a row-restricted viewer sees each item's state and who certified it, no list carries a
// pin, and nothing of West's reaches East (the status of an item adds no value, label or rule).
// NEGATIVE CONTROL: the admin's own list says certified too.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-governanceReplies-db.js

export {}; // module scope: sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as H from './rowPolicyHarness';

(async () => {
  const W = await H.world('governance replies (db) suite');
  if (!W) return finish();
  try {
    const { P, plain, orders } = W;
    const M: string = (await W.call('boss', 'metric:save', { projectId: P, input: { name: 'Revenue', datasetId: plain, definition: { column: 'sales', aggregation: 'sum' } } })).body.metric.id;
    const T: string = (await W.call('boss', 'term:save', { projectId: P, input: { name: 'EMEA', aliases: [], description: '', datasetId: orders, filters: [{ type: 'filter', column: 'region', op: 'in', values: ['West', H.POLICY_CANARY] }] } })).body?.term?.id;
    for (const ref of [`metric:${M}`, ...(T ? [`term:${T}`] : [])]) {
      const pin = (await W.call('boss', 'model:review', { projectId: P, ref })).body?.pin;
      ok(`certified ${ref.split(':')[0]}`, (await W.call('boss', 'model:certify', { projectId: P, ref, base: pin })).body?.ok === true);
    }
    ok('setup: the term exists', !!T);
    ok('retire Orders', (await W.call('boss', 'model:retire', { projectId: P, ref: `dataset:${orders}`, replacedBy: `dataset:${plain}`, note: 'use Plain' })).body?.ok === true);
    const status = (r: H.Reply, list: (b: any) => any[], id: string) => list(r.body).find((i) => i.id === id)?.status;
    const m = (b: any) => b.metrics, t = (b: any) => b.terms, d = (b: any) => b;
    ok('NEGATIVE CONTROL: the admin sees the metric certified', status(await W.call('boss', 'metric:list', { projectId: P }), m, M)?.state === 'certified');
    for (const who of ['east', 'west', 'ed']) {
      const s = status(await W.call(who, 'metric:list', { projectId: P }), m, M);
      ok(`${who} sees the metric certified, and by whom`, s?.state === 'certified' && s.by === 'boss@acme.test', JSON.stringify(s));
    }
    const ds = status(await W.call('east', 'dataset:list', { projectId: P }), d, orders);
    ok('east sees Orders retired with its replacement by name', ds?.state === 'retired' && ds.replacedBy?.name === 'Plain', JSON.stringify(ds));
    ok('east sees the term certified', !T || status(await W.call('east', 'term:list', { projectId: P }), t, T)?.state === 'certified');
    ok('NEGATIVE CONTROL: nothing needs review yet, east\'s overview has no review key', !('review' in (await W.call('east', 'model:overview', { projectId: P })).body));
    await W.call('ed', 'metric:update', { projectId: P, id: M, patch: { filters: [{ type: 'filter', column: 'qty', op: '>', value: 1 }] } });
    const ov = await W.call('east', 'model:overview', { projectId: P });
    ok('east\'s overview lists the changed metric for review, and nothing of West\'s', ov.body.review?.[0]?.ref === `metric:${M}` && ov.body.review[0].kind === 'needs_review' && !H.leaks(ov.text), ov.text.slice(0, 300));
    const texts = await Promise.all(['east', 'ed'].flatMap((who) => ['metric:list', 'metric:table', 'dataset:list', 'catalog:list', 'term:list'].map((c) => W.call(who, c, { projectId: P }))));
    ok('no list reply carries a pin, for anyone', texts.every((r) => !/"pin"/.test(r.text)));
    ok('East reads nothing of West', (await Promise.all(['metric:list', 'dataset:list', 'catalog:list', 'term:list'].map((c) => W.call('east', c, { projectId: P })))).every((r) => !H.leaks(r.text)));
  } finally {
    await W.close();
  }
  finish();
})().catch((err) => { console.error('FAIL harness', err); process.exitCode = 1; finish(); });
