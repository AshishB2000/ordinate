// Self-check for answer cards — the facts they carry, the ledger their
// narration is audited against, and the three IPC entry points end to end.
//
//   1. FACTS: headline, bullets and ledger are read off the chart's own
//      {labels, series}; nothing is aggregated here, and nothing is omitted from
//      the ledger that the facts block prints.
//   2. THE LEDGER REJECTS A NUMBER ABSENT FROM THE FACTS: a narration citing the
//      card's figures (raw, compact or as a share) passes; one inventing a
//      growth rate or a total fails, token by token.
//   3. END TO END through the real handlers (electron stubbed via Module._load,
//      the model stubbed at analyze.askCopilot): a dock ask whose action is an
//      `answer` stores the SPEC on the turn and a guarded narration; the card's
//      values equal buildVizData's aggregate exactly (Object.is); Explain works
//      with no model (bullets, no prose); a chip re-runs with no model call
//      deciding anything.
//
//   npm run build:ts && node scripts/test-answerFacts.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-answers-'));
// Handlers land in the RPC registry (src/ipc/bus.ts outside Electron), not the stub.
const handlers: Map<string, (e: unknown, payload: unknown) => Promise<any>> = require('../src/server/rpc').handlers;
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return {
      app: { getPath: () => tmpUserData },
      net: {},
      safeStorage: { isEncryptionAvailable: () => false },
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};

const F: typeof import('../src/ai/answerFacts') = require('../src/ai/answerFacts');
const audit: typeof import('../src/ai/numberAudit') = require('../src/ai/numberAudit');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const visuals: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const copilotStore: typeof import('../src/ai/copilot') = require('../src/ai/copilot');
const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');
const vizData: typeof import('../src/analysis/vizData') = require('../src/analysis/vizData');
const copilotIpc: typeof import('../src/ipc/copilot') = require('../src/ipc/copilot');

// ── 1. Facts ────────────────────────────────────────────────────────────────

const REGION = {
  labels: ['West', 'East', 'Central', 'South', 'Northeast'],
  series: [{ name: 'sum of revenue', values: [1565150.46, 1406441.74, 1018896.34, 748876.37, 455233.82] }],
};
const TOTAL = REGION.series[0].values.reduce((a, b) => a + b, 0);
const facts = F.answerFacts({
  title: 'Revenue by region', datasetName: 'Retail orders', describe: 'sum of revenue by region',
  data: REGION, categoryIsDate: false, additive: true, filterLabels: [], caption: 'West leads revenue at 1.6M, 1.1× East',
});
ok('facts: headline is the total, then the leader — both app-formatted',
  facts.headline.length === 2 && facts.headline[0].label === 'Total revenue' && Object.is(facts.headline[0].value, TOTAL)
  && facts.headline[0].display === '5.2M' && facts.headline[1].label === 'Highest · West' && facts.headline[1].display === '1.6M',
  JSON.stringify(facts.headline));
ok('facts: bullets name the leader with its share, and the lowest',
  facts.bullets[0] === 'West is highest at 1.6M, 30.1% of the 5.2M total.' && facts.bullets[1] === 'Northeast is lowest at 455.2K.',
  JSON.stringify(facts.bullets));
ok('facts: every mark is in the ledger, unrounded',
  REGION.labels.every((l, i) => facts.ledger.some((e) => e.label === `sum of revenue @ ${l}` && Object.is(e.value, REGION.series[0].values[i]))));
ok('facts: the total and the share are ledger entries, the share as a percent',
  facts.ledger.some((e) => Object.is(e.value, TOTAL)) && facts.ledger.some((e) => e.unit === 'percent' && Math.abs(e.value - 30.13) < 0.01));
ok('facts: the text block carries the guard line', /computed by the app/.test(facts.text) && /Highest: West at 1565150.46/.test(facts.text));

const avg = F.answerFacts({
  title: 'Avg revenue', datasetName: 'd', describe: 'avg of revenue by region',
  data: { labels: ['A', 'B'], series: [{ name: 'avg of revenue', values: [10, 30] }] },
  categoryIsDate: false, additive: false, filterLabels: ['region in A, B'], caption: '',
});
ok('facts: an average states no total and no share', !/Total/.test(avg.text) && !avg.ledger.some((e) => e.unit === 'percent')
  && avg.headline.length === 1 && avg.headline[0].label === 'Highest · B');
ok('facts: the filters in force are a bullet', avg.bullets.includes('Filtered to region in A, B.'));

const monthly = F.answerFacts({
  title: 'Revenue by month', datasetName: 'd', describe: 'sum of revenue by month',
  data: { labels: ['2024-10', '2024-11', '2024-12'], series: [{ name: 'sum of revenue', values: [200, 250, 225] }] },
  categoryIsDate: true, additive: true, filterLabels: [], caption: '',
});
ok('facts: a date axis reports the latest period and its change on the one before',
  monthly.bullets[0] === 'The latest period, 2024-12, is 225, down 10% on 2024-11.' && monthly.headline[1].label === 'Latest · 2024-12',
  JSON.stringify(monthly.bullets));
ok('facts: that change is a percent ledger entry', monthly.ledger.some((e) => e.unit === 'percent' && Object.is(e.value, -10)));
const empty = F.answerFacts({
  title: 't', datasetName: 'd', describe: 'x', data: { labels: [], series: [] },
  categoryIsDate: false, additive: true, filterLabels: [], caption: '',
});
ok('facts: no rows is said plainly, with no headline', empty.headline.length === 0 && /No rows match/.test(empty.bullets[0]));

// ── 2. The ledger rejects a number absent from the facts ────────────────────

const pass = (t: string): boolean => audit.auditNumbers(t, facts.ledger).ok;
const flagged = (t: string): string[] => audit.auditNumbers(t, facts.ledger).violations.map((v) => v.token);
ok('ledger: the raw figure passes', pass('West brought in 1,565,150.46 of revenue.'));
ok('ledger: the compact figure and the share pass', pass('West leads at 1.57M, about 30% of the 5.2M total.'));
ok('ledger: the caption\'s ratio passes (it is in the facts block)', pass('West is 1.1× East.'));
ok('ledger: the count of regions passes', pass('Across all 5 regions, Northeast trails.'));
ok('ledger: an invented growth rate is rejected', JSON.stringify(flagged('Revenue grew 12.4% this year.')) === '["12.4%"]',
  JSON.stringify(flagged('Revenue grew 12.4% this year.')));
ok('ledger: an invented total is rejected, the real figure beside it is not',
  JSON.stringify(flagged('West has 1.6M out of a 7.3M total.')) === '["7.3M"]');
ok('ledger: a derived share the facts do not carry is rejected', flagged('East is 27% of revenue.').includes('27%'));

// ── 3. End to end through the handlers ──────────────────────────────────────

const COLS: import('../src/data/parse').ParsedColumn[] = [
  { name: 'order_date', type: 'date' }, { name: 'region', type: 'text' },
  { name: 'category', type: 'text' }, { name: 'revenue', type: 'number' },
];
const ROWS: import('../src/data/transforms').Cell[][] = [
  ['2024-10-02', 'West', 'Tech', 120], ['2024-11-15', 'East', 'Tech', 80], ['2024-12-20', 'West', 'Furn', 40],
  ['2024-07-01', 'South', 'Furn', 60], ['2023-11-03', 'West', 'Tech', 999], ['2024-12-01', 'Central', 'Office', 15],
];

async function main(): Promise<void> {
  const p = await projects.createProject('Answers');
  const ds = await datasets.saveDataset(p!.id, { name: 'Retail orders', sourceKind: 'csv', columns: COLS, rows: ROWS });
  const pid = p!.id;
  copilotIpc.register();
  const call = (ch: string, payload: unknown): Promise<any> => handlers.get(ch)!({}, payload);

  // The model, stubbed at its own boundary. First call: the ask, answering with
  // a spec. Second call: the narration of the card — citing a real figure and
  // an invented one.
  const replies: any[] = [];
  const asked: string[] = [];
  (analyze as any).askCopilot = async (_prior: unknown, factsText: string, q: string) => {
    asked.push(q + '\n' + factsText);
    return replies.shift();
  };
  (execConfig as any).executionReady = () => true;

  replies.push({
    ok: true, text: 'Here is revenue by region for the last quarter.',
    suggestedAction: {
      kind: 'answer', intent: 'revenue by region last quarter',
      spec: { dataset: 'retail orders', category: 'Region', measures: [{ column: 'Revenue', aggregation: 'sum' }],
        filters: [{ column: 'order date', period: 'last_quarter' }] },
    },
  });
  replies.push({ ok: true, text: 'West leads at 160, and revenue grew 12.4%.', suggestedAction: { kind: 'none', intent: '' } });
  const r = await call('copilot:ask', { projectId: pid, context: {}, question: 'revenue by region last quarter' });
  const last = r.turns[r.turns.length - 1];
  ok('ask: the answer turn stores the resolved SPEC, not figures',
    r.ok && last.answer && last.answer.category === 'region' && last.answer.datasetId === ds!.id
    && JSON.stringify(last.answer.filters) === '[{"column":"order_date","period":"last_quarter"}]' && !('data' in last.answer),
    JSON.stringify(last));
  ok('ask: the narration was asked of the CARD\'s facts', asked.length === 2 && /Answer: "Revenue by region last quarter"/.test(asked[1])
    && /West=160/.test(asked[1]), asked[1]);
  ok('ask: the narration is audited against the card — the invented 12.4% is flagged, the real 160 is not',
    /Contains a figure the app did not compute: 12\.4%$/.test(last.text) && r.numberAudit.violations.length === 1, last.text);
  ok('ask: the answer proposes nothing further', r.suggestedAction.kind === 'none');
  ok('ask: the turn survives a reload with its spec',
    (await copilotStore.loadHistory(pid, r.threadId)).slice(-1)[0].answer?.category === 'region');

  const card = await call('answer:card', { projectId: pid, spec: last.answer });
  const ref = vizData.buildVizData(COLS, ROWS, { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] },
    [{ type: 'filter', column: 'order_date', op: '>=', value: '2024-10-01' }, { type: 'filter', column: 'order_date', op: '<=', value: '2024-12-31' }]);
  const refMap = new Map(ref.data.labels.map((l, i) => [String(l), ref.data.series[0].values[i]]));
  ok('card: every value equals buildVizData\'s aggregate (Object.is), ranked largest first',
    card.ok && card.data.labels.join() === 'West,East,Central'
    && card.data.labels.every((l: string, i: number) => Object.is(card.data.series[0].values[i], refMap.get(l))), JSON.stringify(card.data));
  ok('card: the period is labelled, the caption names the leader', card.filterLabels[0] === 'order_date: 2024-Q4' && /^West leads/.test(card.caption), card.caption);
  ok('card: chips come from the spec', card.chips.map((c: any) => c.label).join('|') === 'Split by category|Same for last year|Show as table',
    card.chips.map((c: any) => c.label).join('|'));

  const bad = [];
  replies.push({ ok: true, text: 'Here it is.', suggestedAction: { kind: 'answer', intent: 'x', spec: { dataset: 'Retail orders', category: 'state', measures: ['revenue'] } } });
  const miss = await call('copilot:ask', { projectId: pid, context: {}, question: 'revenue by state' });
  bad.push(miss);
  const missTurn = miss.turns[miss.turns.length - 1];
  ok('ask: a spec that does not resolve keeps the prose and says why, with no chart',
    !missTurn.answer && /No chart: Unknown category column "state"/.test(missTurn.text), missTurn.text);

  // Explain with NO model: the card's bullets stand in for prose.
  (execConfig as any).executionReady = () => false;
  const v = await visuals.saveVisual(pid, {
    name: 'Revenue by category', datasetId: ds!.id, chartType: 'column',
    encoding: { category: 'category', values: [{ column: 'revenue', aggregation: 'sum' }] },
  });
  const before = asked.length;
  const ex = await call('answer:explain', { projectId: pid, visualId: v!.id });
  const exTurns = await copilotStore.loadHistory(pid, ex.threadId);
  ok('explain: a NEW conversation — the question, then an answer turn with no prose',
    ex.ok && !ex.narrated && exTurns.length === 2 && exTurns[0].text === 'Explain “Revenue by category”'
    && exTurns[1].text === '' && exTurns[1].answer?.category === 'category', JSON.stringify(exTurns));
  ok('explain: no model was called', asked.length === before);
  const exCard = await call('answer:card', { projectId: pid, spec: exTurns[1].answer });
  ok('explain: the card carries the bullets that stand in for prose', exCard.ok && exCard.bullets[0] === 'Tech is highest at 1.2K, 91.2% of the 1.3K total.',
    JSON.stringify(exCard.bullets));
  const tile = await call('answer:explain', { projectId: pid, tile: {
    datasetId: ds!.id, name: 'Revenue by region', chartType: 'map_choropleth',
    encoding: { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] },
    filters: [{ type: 'filter', column: 'region', op: '!=', value: 'West' }] } });
  const tileTurn = (await copilotStore.loadHistory(pid, tile.threadId))[1];
  ok('explain: a dashboard tile is explained under ITS filters, a map drawn as columns',
    tile.ok && tileTurn.answer?.chartType === 'column' && (tileTurn.answer.filters[0] as { op?: string }).op === '!=');

  const chip = card.chips[0];
  const rr = await call('answer:rerun', { projectId: pid, threadId: r.threadId, spec: chip.spec, label: chip.label });
  const rrLast = rr.turns[rr.turns.length - 1];
  ok('chip: re-runs into the same conversation — the chip as the question, the split spec as the answer',
    rr.ok && rr.threadId === r.threadId && rr.turns[rr.turns.length - 2].text === 'Split by category' && rrLast.answer?.series === 'category');
  const rrCard = await call('answer:card', { projectId: pid, spec: rrLast.answer });
  ok('chip: the split card has one series per category value', rrCard.ok && rrCard.data.series.length >= 2, JSON.stringify(rrCard.data));
  ok('card: a spec over a column that no longer exists says so',
    /no longer a column/.test((await call('answer:card', { projectId: pid, spec: { ...last.answer, category: 'gone' } })).reason));

  finish();
}

main().catch((e) => { console.error(e); process.exit(1); });
