// Verified questions, picked by exact wording and ranked as examples (semantic part 3 D8, D10, D15) — PURE.
//
//   npm run build:ts && node scripts/test-verifiedPick.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const P: typeof import('../src/ai/verifiedPick') = require('../src/ai/verifiedPick');
type State = import('../src/ipc/verifiedState').VerifiedState;
type Spec = import('../src/ai/answerSpec').AnswerSpec;

const T = '2026-11-05T00:00:00.000Z';
const ORDERS = 'a0000000-1111-4222-8333-444455556666';
const OTHER = 'b0000000-1111-4222-8333-444455556666';
const id = (n: number): string => `c000000${n}-1111-4222-8333-444455556666`;
const REV_ORDERS = id(1), PROFIT_OTHER_DS = id(2), BY_EMAIL = id(3), TERMED = id(4), LONG = id(5);
const PID = 'd0000000-1111-4222-8333-444455556666';
const NAMES = { dataset: (d: string) => (d === ORDERS ? 'Orders' : 'Other'), term: (t: string) => (t === 'e0000000-1111-4222-8333-444455556666' ? 'EMEA' : '?') };
const spec = (datasetId: string, over: Partial<Spec> = {}): Spec =>
  ({ datasetId, category: 'region', measures: [{ column: 'net_amount', aggregation: 'sum' }], filters: [], chartType: 'column', title: 'x', ...over });
const st = (i: string, question: string, s: Spec, over: Partial<State> = {}, phrasings: string[] = [], updatedAt = T): State => ({
  q: { id: i, projectId: PID, question, phrasings, spec: s, verifiedBy: 'a', verifiedAt: T, createdAt: T, updatedAt, schemaVersion: 1 },
  problem: null, hidden: false, tag: 't', ...over,
});

const S: State[] = [
  st(REV_ORDERS, 'Revenue by region', spec(ORDERS, { filters: [{ column: 'order_date', period: 'last_quarter' }] }), {}, ['revenue per region']),
  st(PROFIT_OTHER_DS, 'Profit by region', spec(OTHER, { measures: [{ column: 'profit', aggregation: 'sum' }] })),
  st(BY_EMAIL, 'Mail to ana', spec(ORDERS, { filters: [{ column: 'email', op: '=', value: 'ana@x.test' }] })),
  st(TERMED, 'EMEA by region', spec(ORDERS, { filters: [{ term: 'e0000000-1111-4222-8333-444455556666' }] })),
];

ok('exact, squashed', P.exactHit(S, 'revenue BY region?')?.id === REV_ORDERS);
ok('a phrasing matches', P.exactHit(S, 'Revenue per region')?.id === REV_ORDERS);
ok('a near miss does not', P.exactHit(S, 'revenue by region last year') === null);
ok('a question of only punctuation never matches', P.exactHit(S, '???') === null);
ok('broken or hidden never match', P.exactHit([{ ...S[0], problem: 'x' }], 'Revenue by region') === null && P.exactHit([{ ...S[0], hidden: true }], 'Revenue by region') === null);
ok('leave-one-out', P.exactHit(S, 'Revenue by region', REV_ORDERS) === null);

const ex = P.pickExamples(S, { question: 'profit by region', datasetId: ORDERS, withheld: () => new Set(['email']), names: NAMES });
ok('context dataset first, then shared words', ex.ids[0] !== PROFIT_OTHER_DS && ex.ids.includes(REV_ORDERS) && ex.ids.at(-1) === PROFIT_OTHER_DS, ex.ids.join());
const rev = P.pickExamples(S, { question: 'x', datasetId: ORDERS, withheld: () => new Set(['email']), names: NAMES });
ok('the action-line shape, by name', rev.lines[rev.ids.indexOf(REV_ORDERS)] === '- "Revenue by region" → {"dataset":"Orders","category":"region","measures":[{"column":"net_amount","aggregation":"sum"}],"filters":[{"column":"order_date","period":"last_quarter"}],"chartType":"column"}', rev.lines.join('\n'));
ok('a term is written by its name', rev.lines.some((l) => l.includes('{"term":"EMEA"}')));
ok('a withheld column\'s value filter is never an example', !ex.ids.includes(BY_EMAIL));
ok('NEGATIVE CONTROL: without the withheld column it is one', P.pickExamples(S, { question: 'x', withheld: () => new Set(), names: NAMES }).ids.includes(BY_EMAIL));
ok('exclude removes it from the examples too', !P.pickExamples(S, { question: 'x', exclude: REV_ORDERS, withheld: () => new Set(), names: NAMES }).ids.includes(REV_ORDERS));
ok('broken and hidden are never examples', P.pickExamples([{ ...S[0], problem: 'x' }, { ...S[1], hidden: true }], { question: 'x', withheld: () => new Set(), names: NAMES }).ids.length === 0);

const many: State[] = Array.from({ length: 12 }, (_, n) => st(`c00000${String(n).padStart(2, '0')}-1111-4222-8333-444455556666`, `Question ${n} about sales`, spec(ORDERS), {}, [], `2026-11-${String(10 + n).padStart(2, '0')}T00:00:00.000Z`));
const big = P.pickExamples(many, { question: 'q', withheld: () => new Set(), names: NAMES });
ok('at most 5, newest first on a tie', big.ids.length === 5 && big.ids[0].startsWith('c0000011'), big.ids.join());
const huge = st(LONG, 'Long', spec(ORDERS, { filters: [{ column: 'region', op: 'in', values: Array.from({ length: 80 }, (_, n) => `value number ${n}`) }] }));
const capped = P.pickExamples([huge, ...many], { question: 'q', withheld: () => new Set(), names: NAMES });
ok('a line over 600 characters is skipped', !capped.ids.includes(LONG) && capped.lines.every((l) => l.length <= P.EXAMPLE_MAX));
const wide = Array.from({ length: 5 }, (_, n) => st(id(n), `Wide ${n}`, spec(ORDERS, { filters: [{ column: 'region', op: 'in', values: Array.from({ length: 34 }, (_, k) => `value ${k}`) }] })));
const w = P.pickExamples(wide, { question: 'q', withheld: () => new Set(), names: NAMES });
ok('3,000 in all (5 lines of up to 600 fit it)', w.ids.length >= 1 && w.lines.join('\n').length <= P.EXAMPLES_BLOCK_MAX, `${w.ids.length} ${w.lines.join('\n').length}`);

finish();
