// The chart form's `calc` (docs/assistant/00-design.md "Two ways to answer"): an answer's measure shown as one of
// the engine's table calculations (src/ai/answerCalc.ts), in server mode, over the real RPC route, on an extract
// and on a Live dataset of the same rows (the fake warehouse).
//
//   1. DIFFERENTIAL  for every TableCalcKind, `answer:card` with the calc is `visual:data` with the same encoding
//      (the visual path: `withTableCalcs` after the chart door) — Object.is on every label, calculated value and raw
//      figure — on the extract AND on the Live dataset, and the Live card is the extract's (parity). NEGATIVE
//      CONTROL: the card without its calc is another chart.
//   2. REFUSALS  an unknown kind, YoY or a moving average off a date axis, a window out of bounds, a calc beside a
//      top-N, down without a split, on a split's second measure, a running total of an average — each in its own
//      sentence, each beside the valid twin that passes (NEGATIVE CONTROL). A stored spec without calc is unchanged.
//   3. KEPT  Save as visual stores the calc on the measure and the visual draws the card; a verified question keeps
//      it; the turn's snapshot keeps the calculated series; a follow-up carries it, and a calc is a change. No
//      follow-up chip takes away what a calc needs (a YoY answer offers no "Same for last year").
//   4. THE MODEL  a stubbed reply with a calc → the card's figures are the engine's, and the prompt names every kind.
//
//   npm run build:ts && node scripts/test-answerCalc.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { Reply } from './liveRouteHarness';
import { H, close, hydrated, post } from './liveRouteHarness';
import type { AnswerSpec, SpecDataset } from '../src/ai/answerSpec';
import type { TableCalcKind } from '../src/analysis/tableCalc';

const spec_: typeof import('../src/ai/answerSpec') = require('../src/ai/answerSpec');
const answerCalc: typeof import('../src/ai/answerCalc') = require('../src/ai/answerCalc');
const msg: typeof import('../src/ai/answerMessages') = require('../src/ai/answerMessages');
const refine: typeof import('../src/ai/answerRefine') = require('../src/ai/answerRefine');
const tableCalc: typeof import('../src/analysis/tableCalc') = require('../src/analysis/tableCalc');
const metricMsg: typeof import('../src/analysis/metricCheckMessages') = require('../src/analysis/metricCheckMessages');
const sa: typeof import('../src/ai/suggestedAction') = require('../src/ai/suggestedAction');
const answers: typeof import('../src/ipc/answers') = require('../src/ipc/answers');
const cmp: typeof import('./liveParityCompare') = require('./liveParityCompare');

const show = (v: unknown): string => JSON.stringify(v);
type Series = { name: string; values: unknown[]; raw?: unknown[]; calc?: { kind: string } };
type Data = { labels: unknown[]; series: Series[] };

/** Every figure of a chart by series and label — the calculated value and the raw one — so two charts compare whatever their order. */
const figures = (d: Data): Map<string, [unknown, unknown, string]> =>
  new Map(d.series.flatMap((s) => d.labels.map((l, i): [string, [unknown, unknown, string]] => [`${s.name}\u0000${String(l)}`, [s.values[i], s.raw?.[i], s.calc?.kind ?? '']])));
const same = (a: Data | undefined, b: Data | undefined): boolean => {
  if (!a || !b) return false;
  const fa = figures(a);
  const fb = figures(b);
  return fa.size > 0 && fa.size === fb.size && [...fa].every(([k, v]) => fb.has(k) && v.every((x, j) => Object.is(x, fb.get(k)![j])));
};
/** The calculated values that are numbers: the comparison is not vacuous. */
const finite = (d: Data | undefined): number => (d ? d.series.flatMap((s) => s.values).filter((v) => typeof v === 'number' && Number.isFinite(v)).length : 0);

const AMT = { column: 'amt', aggregation: 'sum' as const };
const BY_MONTH: TableCalcKind[] = ['running_total', 'diff', 'pct_diff', 'moving_avg', 'moving_sum', 'yoy', 'index'];
const BY_REGION: TableCalcKind[] = ['pct_of_total', 'rank_dense', 'rank_competition', 'percentile'];

(async () => {
  const s = await H.setupOrg(H.ORG_A);
  const P = s.projectId;
  const L = s.liveId;
  const X = s.extractId;
  const from = hydrated.length;
  const ds: SpecDataset = { id: X, name: 'Fixture copy', columns: H.fx.COLUMNS };

  const specOf = (datasetId: string, kind: TableCalcKind, over: Partial<AnswerSpec> = {}): AnswerSpec => {
    const date = BY_MONTH.includes(kind);
    const calc = { kind, along: 'across' as const, ...(kind === 'moving_avg' ? { window: 3 } : {}) };
    return {
      datasetId, category: date ? 'd' : 'region', ...(date ? { grain: 'month' as const } : {}), measures: [{ ...AMT, calc }],
      filters: [], chartType: date ? 'line' : 'column', title: `amt as ${kind}`, ...over,
    };
  };
  const card = async (spec: AnswerSpec): Promise<Reply> => (await post('answer:card', { projectId: P, spec })).value;
  const visual = async (spec: AnswerSpec): Promise<Reply> => (await post('visual:data', {
    projectId: P, datasetId: spec.datasetId, chartType: spec.chartType, filters: [],
    encoding: { category: spec.category, values: spec.measures, ...(spec.grain ? { grain: spec.grain } : {}), ...(spec.series ? { series: spec.series } : {}) },
  })).value;

  // ── 1. Differential: the card's calc is the visual's ───────────────────────
  for (const kind of [...BY_MONTH, ...BY_REGION]) {
    const [cx, vx, cl, vl] = [await card(specOf(X, kind)), await visual(specOf(X, kind)), await card(specOf(L, kind)), await visual(specOf(L, kind))];
    ok(`${kind}: the extract card is visual:data's table calculation (Object.is on every label, value and raw figure; ${finite(cx.data)} figures)`,
      cx.ok === true && vx.ok === true && finite(cx.data) >= 3 && cx.data.series[0].calc?.kind === kind && same(cx.data, vx.data), show([cx.data, vx.data ?? vx]).slice(0, 600));
    ok(`${kind}: the Live card is the Live visual's, and the extract card's (parity)`,
      cl.ok === true && vl.ok === true && same(cl.data, vl.data) && same(cl.data, cx.data), show([cl.data ?? cl, cx.data]).slice(0, 600));
  }
  const plain = await card({ ...specOf(X, 'running_total'), measures: [AMT] });
  const running = await card(specOf(X, 'running_total'));
  ok('NEGATIVE CONTROL: the card without its calc is another chart', plain.ok === true && !same(plain.data, running.data));
  // The extract's month axis comes first-seen; a running total along it runs in time order (analysis/tableCalc `byTime`), as Live's.
  const months = (running.data.labels as string[]).filter((l) => l !== '');
  const firstSeen = tableCalc.applyChartCalcs(plain.data, { category: 'd', values: [{ ...AMT, calc: { kind: 'running_total', along: 'across' } }] }, { kind: 'text' });
  ok('time order: the extract\'s axis is NOT in time order, and the calc in its first-seen order would be another answer (NEGATIVE CONTROL)',
    months.join() !== [...months].sort().join() && !same(firstSeen as Data, running.data));
  const at = (d: Data, l: string, raw = false): number => (raw ? d.series[0].raw! : d.series[0].values)[d.labels.indexOf(l)] as number;
  let acc = 0;
  const inTime = [...months].sort().map((m) => (acc += at(running.data, m, true)));
  ok('time order: month by month the running total adds up the months before it, and the empty bucket adds last',
    [...months].sort().every((m, k) => Object.is(at(running.data, m), inTime[k])) && Object.is(at(running.data, ''), acc + at(running.data, '', true)), show(inTime.slice(0, 3)));
  const down = specOf(X, 'pct_of_total', { category: 'd', grain: 'year', series: 'region', chartType: 'stacked_column', measures: [{ ...AMT, calc: { kind: 'pct_of_total', along: 'down' } }] });
  const [dc, dv, dl, dlv] = [await card(down), await visual(down), await card({ ...down, datasetId: L }), await visual({ ...down, datasetId: L })];
  ok('down the split: each region\'s share of its year is the visual\'s (Object.is), on the extract and on Live', dc.ok === true && dc.data.series.length >= 3 && same(dc.data, dv.data) && same(dl.data, dlv.data),
    show([dc.data, dv.data]).slice(0, 600));
  // Each path orders its own split (docs/live-data/log.md, "Two summation orders"), so a share's total adds the same cells in another order.
  const rawOf = (d: Data): Data => ({ labels: d.labels, series: d.series.map((x) => ({ name: x.name, values: x.raw ?? [] })) });
  ok('down the split, Live against the extract: the same figures (Object.is), the shares within the documented float tolerance',
    same(rawOf(dl.data), rawOf(dc.data)) && cmp.compareCharts(dc.data, dl.data, () => true, true).length === 0, show(cmp.compareCharts(dc.data, dl.data, () => true, true)).slice(0, 400));
  const ranked = await card(specOf(X, 'rank_competition'));
  ok('a ranked answer: largest first, so the ranks read #1, #2, … down the bars (ranked by the figures, never the rank)',
    ranked.ok === true && show(ranked.data.series[0].values.slice(0, 3)) === '[1,2,3]', show(ranked.data));
  const yoy = await card(specOf(X, 'yoy'));
  ok('yoy: 2024\'s months against 2023\'s, the first year null (no year before it)', yoy.ok === true && yoy.data.labels.indexOf('2024-01') > 0
    && yoy.data.series[0].values[yoy.data.labels.indexOf('2023-01')] === null && typeof yoy.data.series[0].values[yoy.data.labels.indexOf('2024-01')] === 'number', show(yoy.data).slice(0, 300));

  // The card says the calculated series as it is: its words, its percents, no total of a share.
  const share = await card(specOf(X, 'pct_of_total'));
  ok('the card describes the calculation: a share in percent with its figure beside it, and no "Total" of shares',
    share.ok === true && share.bullets.some((b: string) => / is highest at [\d.]+% of total · /.test(b)) && !share.headline.some((h: { label: string }) => /^Total/.test(h.label))
    && /% of total/.test(share.caption), show([share.bullets, share.headline, share.caption]));
  const facts = await H.as(H.ORG_A, () => answers.computeCard(P, specOf(X, 'running_total')));
  ok('the facts say what the series is: "a running total of sum of amt", and the figures before it', 'card' in facts
    && facts.factsText.includes('a running total of sum of amt by d') && facts.factsText.includes('before the calculation:') && !/^Total /m.test(facts.factsText), 'card' in facts ? facts.factsText.slice(0, 600) : show(facts));
  const rankFacts = await card(specOf(X, 'rank_dense'));
  ok('a rank is said by position: first is rank 1', rankFacts.ok === true && rankFacts.bullets[0].includes('ranks first at #1') && rankFacts.headline[0].label.startsWith('First · '), show(rankFacts.bullets));

  // ── 2. Refusals, each beside the twin that passes ──────────────────────────
  const raw = (calc: unknown, over: Record<string, unknown> = {}) => ({ dataset: X, category: 'd', grain: 'month', measures: [{ column: 'amt', aggregation: 'sum', calc }], ...over });
  const check = (r: unknown) => spec_.validateAnswerSpec(r, [ds]);
  const reason = (r: unknown): string => { const v = check(r); return v.ok ? 'ok' : v.reason; };
  const calcOf = (r: unknown): unknown => { const v = check(r); return v.ok ? v.spec.measures.map((m) => m.calc ?? null) : v.reason; };
  ok('refused: an unknown kind, naming the kinds', reason(raw('cumulative_fudge')) === msg.calcUnknown('cumulative_fudge', tableCalc.TABLE_CALC_KINDS.join(', ')), reason(raw('cumulative_fudge')));
  ok('NEGATIVE CONTROL: a known kind passes, stored as a visual stores it', show(calcOf(raw('running_total'))) === show([{ kind: 'running_total', along: 'across' }]));
  ok('a name slightly off is read as the kind it means ("moving average", "Rank", "year-over-year")',
    show(calcOf(raw({ kind: 'moving average', window: 4 }))) === show([{ kind: 'moving_avg', along: 'across', window: 4 }])
    && answerCalc.calcKind('Rank') === 'rank_competition' && answerCalc.calcKind('year-over-year') === 'yoy' && answerCalc.calcKind('cumulative_fudge') === null);
  const needsDate = (k: TableCalcKind): string => msg.calcNeedsDate(tableCalc.CALC_KIND_NAMES[k]);
  ok('refused: YoY off a date category', reason(raw('yoy', { category: 'region', grain: undefined })) === needsDate('yoy'), reason(raw('yoy', { category: 'region' })));
  ok('refused: a moving average off a date category', reason(raw('moving_avg', { category: 'region' })) === needsDate('moving_avg'));
  ok('NEGATIVE CONTROL: both on a date category pass', reason(raw('yoy')) === 'ok' && reason(raw('moving_avg')) === 'ok');
  const win = msg.calcWindow('2', '366');
  ok('refused: a window of 1, of 400 or of 2.5 periods', [1, 400, 2.5, '3'].every((w) => reason(raw({ kind: 'moving_sum', window: w })) === win), reason(raw({ kind: 'moving_sum', window: 1 })));
  ok('NEGATIVE CONTROL: a window of 2 and of 366 pass, kept', show(calcOf(raw({ kind: 'moving_sum', window: 2 }))) === show([{ kind: 'moving_sum', along: 'across', window: 2 }]) && reason(raw({ kind: 'moving_sum', window: 366 })) === 'ok');
  ok('refused: a calc beside a top-N', reason(raw('pct_of_total', { category: 'region', top: 3 })) === msg.calcWithTop(tableCalc.CALC_KIND_NAMES.pct_of_total, '3'));
  ok('NEGATIVE CONTROL: the share without the top-N passes', reason(raw('pct_of_total', { category: 'region' })) === 'ok');
  ok('refused: down with no split, and a direction it does not know', reason(raw({ kind: 'pct_of_total', along: 'down' }, { category: 'region' })) === msg.calcAlongOf()
    && reason(raw({ kind: 'pct_of_total', along: 'sideways' }, { category: 'region' })) === msg.calcAlongOf());
  ok('NEGATIVE CONTROL: down with a split passes', reason(raw({ kind: 'pct_of_total', along: 'down' }, { category: 'region', series: 'cat' })) === 'ok');
  ok('refused: a running total down the split (it is worked out in date order)', reason(raw({ kind: 'running_total', along: 'down' }, { series: 'region' })) === needsDate('running_total'));
  const two = (calcAt: number) => ({ ...raw(undefined, { category: 'region', series: 'cat' }), measures: [0, 1].map((i) => ({ column: i ? 'qty' : 'amt', aggregation: 'sum', ...(i === calcAt ? { calc: 'rank' } : {}) })) });
  ok('refused: with a split, a calc on the second measure (not drawn)', reason(two(1)) === msg.calcSplitFirst());
  ok('NEGATIVE CONTROL: on the first measure it passes', reason(two(0)) === 'ok');
  const avg = await card({ ...specOf(X, 'running_total'), measures: [{ column: 'amt', aggregation: 'avg', calc: { kind: 'running_total', along: 'across' } }] });
  const avgVisual = await visual({ ...specOf(X, 'running_total'), measures: [{ column: 'amt', aggregation: 'avg', calc: { kind: 'running_total', along: 'across' } }] });
  ok('refused: a running total of an average, in the visual\'s own sentence', avg.ok === false && avg.reason === avgVisual.error && avg.reason === metricMsg.calcNotAdditive('avg of amt', tableCalc.CALC_KIND_NAMES.running_total), show([avg, avgVisual]));
  ok('NEGATIVE CONTROL: an index of an average adds nothing up, and is drawn', (await card({ ...specOf(X, 'index'), measures: [{ column: 'amt', aggregation: 'avg', calc: { kind: 'index', along: 'across' } }] })).ok === true);

  const bare = { ...specOf(X, 'running_total'), measures: [AMT] };
  ok('a stored spec without calc is unchanged: no calc key appears', show(spec_.sanitizeStoredSpec(bare)) === show(spec_.sanitizeStoredSpec(JSON.parse(show(bare)))) && !('calc' in spec_.sanitizeStoredSpec(bare)!.measures[0]));
  ok('a stored spec: an unknown kind is dropped, a window clamped as a visual\'s is (shape only)',
    !('calc' in spec_.sanitizeStoredSpec({ ...bare, measures: [{ ...AMT, calc: { kind: 'nope' } }] })!.measures[0])
    && spec_.sanitizeStoredSpec({ ...bare, measures: [{ ...AMT, calc: { kind: 'moving_avg', window: 9999 } }] })!.measures[0].calc?.window === 366);

  // ── 3. Kept: a visual, a verified question, the turn's snapshot, a follow-up ─
  const kept = specOf(X, 'moving_avg');
  const keptCard = await card(kept);
  const saved = (await post('answer:saveVisual', { projectId: P, spec: kept })).value;
  const vis = saved.ok ? (await post('visual:get', { projectId: P, id: saved.visual.id })).value : null;
  const visData = vis ? (await post('visual:data', { projectId: P, datasetId: vis.datasetId, encoding: vis.encoding, filters: vis.filters, chartType: vis.chartType })).value : null;
  ok('save as visual: the measure keeps its calc, and the visual draws the card (Object.is)', !!vis && show(vis.encoding.values[0].calc) === show({ kind: 'moving_avg', along: 'across', window: 3 })
    && !!visData && same(visData.data, keptCard.data), show([vis?.encoding, visData?.data ?? visData]).slice(0, 400));
  const liveSaved = (await post('answer:saveVisual', { projectId: P, spec: { ...kept, datasetId: L } })).value;
  const liveVis = liveSaved.ok ? (await post('visual:get', { projectId: P, id: liveSaved.visual.id })).value : null;
  ok('save as visual on Live: the calc is kept too', !!liveVis && liveVis.encoding.values[0].calc?.kind === 'moving_avg');

  const verified = (await post('verified:save', { projectId: P, input: { question: 'Three-month moving average of amt', spec: kept } })).value;
  const listed = ((await post('verified:list', { projectId: P })).value.questions ?? (await post('verified:list', { projectId: P })).value) as Reply[];
  const vq = Array.isArray(listed) ? listed.find((q) => q.id === verified.question?.id) : null;
  ok('a verified question keeps the calc, and draws the card', verified.ok === true && !!vq && show(vq.spec.measures[0].calc) === show(kept.measures[0].calc)
    && same((await card(vq.spec)).data, keptCard.data), show([verified, vq]).slice(0, 400));
  ok('…and it is not the same question as the chart without the calc', !refine.sameChart(kept, { ...kept, measures: [AMT] }) && refine.sameChart(kept, JSON.parse(show(kept))));

  const tid = (await post('copilot:newThread', { projectId: P })).value.thread.id;
  const asked = (await post('answer:rerun', { projectId: P, threadId: tid, spec: kept, label: 'moving average of amt' })).value;
  const turn = asked.ok ? (asked.turns as Reply[]).filter((t) => t.role === 'assistant').pop() : null;
  ok('the turn\'s snapshot keeps the calculated series as computed', !!turn && !!turn.card && turn.card.data.series[0].calc?.kind === 'moving_avg' && same(turn.card.data, keptCard.data)
    && turn.answer.measures[0].calc?.kind === 'moving_avg', show(turn ?? asked).slice(0, 400));

  const followed = check(refine.refineSpec(kept, { filters: [{ column: 'region', op: '=', value: 'North' }] }, ds));
  ok('a follow-up carries the calc onto the merged spec', followed.ok && show(followed.spec.measures[0].calc) === show(kept.measures[0].calc), show(followed));
  const prev = await H.as(H.ORG_A, () => answers.previousAnswer(P, [{ id: '1', role: 'assistant', text: '', createdAt: '', answer: kept }]));
  ok('…and the model is told the previous chart had it', !!prev && prev.block.includes('sum(amt) as moving_avg over 3'), prev?.block);
  const moved = check(refine.refineSpec(kept, { category: 'region' }, ds));
  ok('…a follow-up onto a text axis is refused in the calc\'s words, never drawn without it', !moved.ok && moved.reason === needsDate('moving_avg'), show(moved));

  // Follow-up chips never take away what a calc needs, so no chip lands on an empty card.
  const labelsOf = (sp: AnswerSpec, hierarchies: { id: string; name: string; levels: string[] }[] = []): string[] =>
    spec_.answerChips(sp, { columns: H.fx.COLUMNS, splitCandidates: [], hierarchies, ladder: ['year', 'quarter', 'month', 'day'] }).map((c) => c.label);
  const period = { filters: [{ column: 'd', period: 'last_n_months' as const, n: 24 }] };
  ok('chips: a YoY answer offers no "Same for last year" (it already compares with the year before)', !labelsOf(specOf(X, 'yoy', period)).includes('Same for last year'), show(labelsOf(specOf(X, 'yoy', period))));
  ok('chips NEGATIVE CONTROL: the same answer without its calc offers it', labelsOf({ ...specOf(X, 'yoy', period), measures: [AMT] }).includes('Same for last year'));
  ok('chips: a difference, a % difference and an index keep it (they compare within the axis)', (['diff', 'pct_diff', 'index'] as const).every((k) => labelsOf(specOf(X, k, period)).includes('Same for last year')));
  const yoyCard = await card(specOf(X, 'yoy', period));
  ok('chips: …and the card the route draws offers none either', yoyCard.ok === true && !yoyCard.chips.some((c: { label: string }) => c.label === 'Same for last year'), show(yoyCard.chips?.map((c: { label: string }) => c.label)));
  const time = [{ id: 'h1', name: 'Time', levels: ['d', 'region'] }];
  ok('chips: a date-order calc is never regrouped onto a text level ("By region"); the finer grain is offered instead',
    !labelsOf(specOf(X, 'running_total'), time).includes('By region') && labelsOf(specOf(X, 'running_total'), time).includes('By day'), show(labelsOf(specOf(X, 'running_total'), time)));
  ok('chips NEGATIVE CONTROL: without the calc, or with a share, "By region" is offered', labelsOf({ ...specOf(X, 'running_total'), measures: [AMT] }, time).includes('By region')
    && labelsOf(specOf(X, 'pct_of_total', { category: 'd', grain: 'month' }), time).includes('By region'));

  // ── 4. The model writes a calc, never a figure ─────────────────────────────
  const reply = 'Here is the running total of amt by month.\n' + sa.ACTION_MARKER
    + ' {"kind":"answer","intent":"running total of amt by month","spec":{"dataset":"Fixture copy","category":"d","grain":"month","measures":[{"column":"amt","aggregation":"sum","calc":"running total"}]}}';
  const action = sa.splitAction(reply).action;
  const fromModel = await H.as(H.ORG_A, () => answers.answerFromAction(P, {}, action, 'running total of amt by month'));
  const engine = await visual(specOf(X, 'running_total'));
  ok('a stubbed model reply with a calc: the card is the engine\'s running total (the reply holds no figure)', action.kind === 'answer' && !/\d/.test(show(action.spec).replace(/"[0-9a-f-]{36}"/g, ''))
    && fromModel.ok === true && fromModel.spec.measures[0].calc?.kind === 'running_total' && same(fromModel.card.data as unknown as Data, engine.data), show(fromModel).slice(0, 400));
  const wrong = sa.splitAction(reply.replace('"calc":"running total"', '"calc":"cumulative fudge"')).action;
  const refused = await H.as(H.ORG_A, () => answers.answerFromAction(P, {}, wrong, 'x'));
  ok('…a calc it does not know is refused with the reason, no card', refused.ok === false && refused.reason === msg.calcUnknown('cumulative fudge', tableCalc.TABLE_CALC_KINDS.join(', ')), show(refused));
  ok('the prompt names every kind, and says a calc never goes with "top"', tableCalc.TABLE_CALC_KINDS.every((k) => sa.CHAT_SYSTEM_PROMPT.includes(k)) && sa.CHAT_SYSTEM_PROMPT.includes('calc never goes with "top"'));

  ok('THE SPY: nothing here asked getDataset for the Live dataset', !hydrated.slice(from).includes(L), show(hydrated.slice(from)));
  await close();
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
