// The answer cache (src/engine/queryCache.ts): keying, invalidation on a
// dataset write, and LRU eviction by BYTES.
//
//   npm run build:ts && node scripts/test-queryCache.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as qc from '../src/engine/queryCache';
import * as trace from '../src/engine/residentTrace';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const parts = (datasetId: string, updatedAt = '2026-01-01T00:00:00.000Z', steps: unknown[] = []) => ({
  datasetId,
  updatedAt,
  pipelineHash: qc.pipelineHash(steps),
});

// ── Keying ──────────────────────────────────────────────────────────────────
{
  const spec1 = { encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] }, filters: [] };
  const spec2 = { filters: [], encoding: { values: [{ aggregation: 'sum', column: 'amount' }], category: 'region' } };
  ok('key: object key order does not change the key',
    qc.cacheKey('aggregate', parts(A), spec1) === qc.cacheKey('aggregate', parts(A), spec2));
  ok('key: array order DOES change the key',
    qc.cacheKey('aggregate', parts(A), { v: [1, 2] }) !== qc.cacheKey('aggregate', parts(A), { v: [2, 1] }));
  ok('key: a newer updatedAt is a different key',
    qc.cacheKey('metric', parts(A), spec1) !== qc.cacheKey('metric', parts(A, '2026-01-02T00:00:00.000Z'), spec1));
  ok('key: a different pipeline is a different key',
    qc.cacheKey('metric', parts(A), spec1) !== qc.cacheKey('metric', parts(A, undefined, [{ type: 'trim' }]), spec1));
  ok('key: the op is part of the key',
    qc.cacheKey('metric', parts(A), spec1) !== qc.cacheKey('pivot', parts(A), spec1));
  ok('key: another dataset is another key',
    qc.cacheKey('metric', parts(A), spec1) !== qc.cacheKey('metric', parts(B), spec1));
  ok('pipelineHash: step key order is irrelevant, step order is not',
    qc.pipelineHash([{ type: 'trim', column: 'x' }]) === qc.pipelineHash([{ column: 'x', type: 'trim' }]) &&
    qc.pipelineHash([{ type: 'trim' }, { type: 'dedupe' }]) !== qc.pipelineHash([{ type: 'dedupe' }, { type: 'trim' }]));
  ok('stableStringify: undefined members are dropped like JSON.stringify',
    qc.stableStringify({ a: 1, b: undefined }) === '{"a":1}');
}

// ── memo: hits, misses, nulls not cached, trace counts ──────────────────────
void (async () => {
  qc.clear();
  trace.reset();
  let calls = 0;
  const compute = async () => { calls++; return { labels: ['a'], series: [{ data: [1] }] }; };
  const v1 = await qc.memo('aggregate', parts(A), { q: 1 }, compute);
  const v2 = await qc.memo('aggregate', parts(A), { q: 1 }, compute);
  ok('memo: the second identical call is a hit (computed once)', calls === 1 && JSON.stringify(v1) === JSON.stringify(v2));
  (v2 as { labels: string[] }).labels.push('MUTATED');
  const v3 = await qc.memo('aggregate', parts(A), { q: 1 }, compute);
  ok('memo: a caller mutating its copy cannot change what the next caller gets',
    calls === 1 && (v3 as { labels: string[] }).labels.length === 1);

  // Two callers at the same moment share ONE computation.
  let slow = 0;
  const slowCompute = () => new Promise<number>((r) => { slow++; setTimeout(() => r(42), 20); });
  const [s1, s2] = await Promise.all([
    qc.memo('metric', parts(A), { burst: 1 }, slowCompute),
    qc.memo('metric', parts(A), { burst: 1 }, slowCompute),
  ]);
  ok('through: concurrent identical misses compute once', slow === 1 && s1 === 42 && s2 === 42);
  let threw = 0;
  const failing = () => new Promise<number>((_r, j) => setTimeout(() => j(new Error('x')), 5));
  await Promise.allSettled([qc.memo('metric', parts(A), { bad: 1 }, failing), qc.memo('metric', parts(A), { bad: 1 }, failing)])
    .then((rs) => { threw = rs.filter((r) => r.status === 'rejected').length; });
  ok('through: a failed computation rejects every waiter and is not cached', threw === 2);
  let again = 0;
  await qc.memo('metric', parts(A), { bad: 1 }, async () => { again++; return 1; });
  ok('through: …and the next call computes afresh', again === 1);
  const counts = trace.snapshot()['cache:aggregate'];
  ok('trace: one miss and two hits recorded under cache:aggregate',
    Boolean(counts) && counts.miss === 1 && counts.hit === 2, JSON.stringify(counts));

  let nulls = 0;
  await qc.memo('metric', parts(A), { q: 2 }, async () => { nulls++; return null; });
  await qc.memo('metric', parts(A), { q: 2 }, async () => { nulls++; return null; });
  ok('memo: a null answer is never cached (a resident failure must not stick)', nulls === 2);

  let zeros = 0;
  await qc.memo('metric', parts(A), { q: 3 }, async () => { zeros++; return 0; });
  await qc.memo('metric', parts(A), { q: 3 }, async () => { zeros++; return 0; });
  ok('memo: a real 0 IS cached', zeros === 1);

  // ── Invalidation ──────────────────────────────────────────────────────────
  qc.clear();
  await qc.memo('aggregate', parts(A), { q: 1 }, compute);
  await qc.memo('aggregate', parts(B), { q: 1 }, compute);
  await qc.memo('metric', parts(B), { joined: true }, async () => 7, [A]); // B's answer joined A
  ok('invalidate: three entries before', qc.stats().entries === 3);
  const dropped = qc.invalidateDataset(A);
  ok('invalidate: a write to A drops A\'s entry AND the one that joined A', dropped === 2 && qc.stats().entries === 1);
  const before = calls;
  await qc.memo('aggregate', parts(B), { q: 1 }, compute);
  ok('invalidate: B\'s own entry survives a write to A', calls === before);

  // Project-wide: an answer tagged with its project is dropped by a write to
  // ANY dataset of that project (a join, a boundary), and by invalidateProject.
  qc.clear();
  const P = '33333333-3333-4333-8333-333333333333';
  await qc.memo('aggregate', parts(B), { q: 'joined' }, compute, [qc.projectDep(P)]);
  ok('project: a write to another dataset of the project drops the tagged answer',
    qc.invalidateDataset(A, P) === 1 && qc.stats().entries === 0);
  await qc.memo('aggregate', parts(B), { q: 'joined' }, compute, [qc.projectDep(P)]);
  await qc.memo('aggregate', parts(B), { q: 'plain' }, compute);
  ok('project: invalidateProject drops only the tagged answers', qc.invalidateProject(P) === 1 && qc.stats().entries === 1);

  // ── LRU by bytes ──────────────────────────────────────────────────────────
  qc.clear();
  qc.setBudgetForTest(4000);
  const blob = (n: number) => ({ s: 'x'.repeat(n) });
  qc.set('k1', blob(900), [A]);
  qc.set('k2', blob(900), [A]);
  qc.set('k3', blob(900), [A]);
  ok('lru: three ~900-byte entries fit a 4000-byte budget', qc.stats().entries === 3 && qc.stats().bytes <= 4000);
  qc.get('aggregate', 'k1'); // touch k1 → k2 is now the oldest
  qc.set('k4', blob(900), [A]);
  qc.set('k5', blob(900), [A]);
  ok('lru: the budget holds after inserts', qc.stats().bytes <= 4000, qc.stats().bytes);
  ok('lru: the least recently USED entry went first (k2), not the oldest inserted (k1)',
    qc.get('aggregate', 'k2') === undefined && qc.get('aggregate', 'k1') !== undefined);
  ok('lru: an answer bigger than a quarter of the budget is not cached at all',
    qc.set('huge', blob(1500), [A]) === false && qc.get('aggregate', 'huge') === undefined);
  const e = qc.stats().entries;
  qc.set('k1', blob(10), [A]);
  ok('lru: replacing a key re-counts its bytes instead of adding them',
    qc.stats().entries === e && qc.stats().bytes <= 4000);
  qc.setBudgetForTest(qc.MAX_BYTES);
  ok('budget: the production budget is 64 MB', qc.MAX_BYTES === 64 * 1024 * 1024);

  finish();
})();
