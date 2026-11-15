// Reciprocal rank fusion (src/ai/rankFusion.ts): meaning and words merge by rank.
//
//   reference   on random lists, fuse is Object.is-equal to a brute reference
//               (indexOf per list, then the same Σ 1/(k + rank)), keys and scores
//   no meaning  an empty meaning list (no fingerprints yet): the words order,
//               each 1/(60 + rank). NEGATIVE CONTROL: a reversed meaning list
//               changes the order
//   ties        equal ranks swapped between lists tie exactly; the better words
//               rank wins, then the key; an item missing from a list adds nothing
//   k, limit    k changes who wins; limit cuts; a bad k throws
//
//   npm run build:ts && node scripts/test-rankFusion.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const { fuse }: typeof import('../src/ai/rankFusion') = require('../src/ai/rankFusion');

const keys = (r: readonly { key: string }[]): string => r.map((x) => x.key).join(',');
const show = (v: unknown): string => JSON.stringify(v);

/** The brute reference: every key of every list, its ranks by indexOf, summed smallest rank first; sorted by the stated rule. */
function reference(lists: string[][], k = 60, limit = Infinity): { key: string; score: number }[] {
  const all = [...new Set(lists.flat())];
  const rows = all.map((key) => {
    const rs = lists.map((l) => l.indexOf(key) + 1).filter((r) => r > 0).sort((a, b) => a - b);
    let score = 0;
    for (const r of rs) score += 1 / (k + r);
    const w = lists[0] ? lists[0].indexOf(key) : -1;
    return { key, score, w: w < 0 ? Number.MAX_SAFE_INTEGER : w };
  });
  rows.sort((a, b) => (a.score !== b.score ? (a.score > b.score ? -1 : 1) : a.w !== b.w ? a.w - b.w : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return rows.slice(0, limit).map(({ key, score }) => ({ key, score }));
}

const same = (a: readonly { key: string; score: number }[], b: readonly { key: string; score: number }[]): boolean =>
  a.length === b.length && a.every((x, i) => x.key === b[i].key && Object.is(x.score, b[i].score));

// ── Reference, on seeded random lists (no duplicates within a list) ─────────
let seed = 7;
const rand = (n: number): number => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
let agreed = 0;
const cases = 300;
for (let c = 0; c < cases; c++) {
  const pool = Array.from({ length: 2 + rand(30) }, (_, i) => `i${i}`);
  const lists = Array.from({ length: 1 + rand(3) }, () => pool.filter(() => rand(3) > 0).sort(() => rand(3) - 1));
  const k = [0, 1, 60][rand(3)];
  const limit = rand(4) === 0 ? rand(10) : Infinity;
  if (same(fuse(lists, { k, limit }), reference(lists, k, limit))) agreed++;
  else ok(`reference: case ${c}`, false, show({ lists, k, limit, got: fuse(lists, { k, limit }), want: reference(lists, k, limit) }));
}
ok(`reference: ${cases} random cases (1–3 lists, k 0/1/60, some limits) Object.is-equal to the brute reference`, agreed === cases);

// ── No fingerprints: words alone ────────────────────────────────────────────
const words = ['orders', 'revenue', 'regions', 'customers'];
const alone = fuse([words, []]);
ok('no meaning: an empty meaning list leaves the words order', keys(alone) === words.join(','), keys(alone));
ok('no meaning: …each scored 1/(60 + rank)', alone.every((x, i) => Object.is(x.score, 1 / (60 + i + 1))), show(alone));
ok('no meaning: …the same as words alone', same(alone, fuse([words])));
const reversed = fuse([words, [...words].reverse()]);
ok('no meaning NEGATIVE CONTROL: a reversed meaning list changes the order', keys(reversed) !== words.join(','), keys(reversed));
ok('empty: no lists, or only empty ones, fuse to nothing', fuse([]).length === 0 && fuse([[], []]).length === 0);

// ── Ties ────────────────────────────────────────────────────────────────────
const swapped = fuse([['a', 'x', 'b'], ['b', 'y', 'a']]);
const a = swapped.find((r) => r.key === 'a');
const b = swapped.find((r) => r.key === 'b');
ok('ties: ranks 1 and 3 swapped between the lists score exactly the same', !!a && !!b && Object.is(a.score, b.score), show(swapped));
ok('ties: …and the better words rank goes first', keys(swapped).startsWith('a,b'), keys(swapped));
// p and r hold ranks 1, 2 and 3, each in another list: the same score, exactly.
const three = fuse([['p', 'f1', 'r'], ['f2', 'r', 'p'], ['r', 'p', 'f3']]);
const pScore = three.find((r) => r.key === 'p')?.score;
ok('ties: three lists, the same ranks in other lists — exactly equal, words first', pScore !== undefined && Object.is(pScore, three.find((r) => r.key === 'r')?.score)
  && keys(three).startsWith('p,r'), show(three));
const tieByKey = fuse([['w'], ['n', 'z'], ['m', 'z']]);
// z: 2/62 leads; w, m, n tie at 1/61 — w has a words rank, m and n go by key.
ok('ties: equal scores with no words rank go by key, after the one words ranks', keys(tieByKey) === 'z,w,m,n', keys(tieByKey));
const missing = fuse([['a', 'b'], ['c']]);
ok('missing: an item absent from a list gets nothing for it', Object.is(missing.find((r) => r.key === 'b')!.score, 1 / 62) && Object.is(missing.find((r) => r.key === 'c')!.score, 1 / 61));
const dup = fuse([['a', 'b', 'a'], ['b']]);
ok('duplicates: a list naming an item twice counts its best rank once', Object.is(dup.find((r) => r.key === 'a')!.score, 1 / 61), show(dup));

// ── k and limit ─────────────────────────────────────────────────────────────
// p: rank 1 in words only = 1/(k+1); q: rank 3 in both = 2/(k+3). q wins when k > 1.
const kLists = [['p', 'x', 'q'], ['y', 'z', 'q']];
ok('k: with k = 0 the top words item wins', fuse(kLists, { k: 0 })[0].key === 'p', keys(fuse(kLists, { k: 0 })));
ok('k: with k = 60 the item both lists rank wins', fuse(kLists)[0].key === 'q', keys(fuse(kLists)));
ok('limit: cuts the fused list', keys(fuse(kLists, { limit: 2 })) === keys(fuse(kLists)).split(',').slice(0, 2).join(',') && fuse(kLists, { limit: 0 }).length === 0);
let threw = '';
try {
  fuse(kLists, { k: -1 });
} catch (e) {
  threw = (e as Error).message;
}
ok('k: a negative k throws', /k must be/.test(threw), threw);
const input = [['a', 'b'], ['b']];
fuse(input);
ok('pure: the input lists are not changed', show(input) === show([['a', 'b'], ['b']]));
ok('deterministic: the same lists fuse the same twice', same(fuse(kLists), fuse(kLists)));

finish();
