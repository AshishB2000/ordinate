// Self-check for src/ai/numberAudit.ts — the number-fidelity audit.
//
// Two halves, and the second is the one that keeps the first honest:
//
//   1. auditNumbers over hand-written answers and ledgers: every numeric FORMAT
//      the extractor must handle, the unit-aware tolerance, and the traps (a
//      year, an order id, a count the model is entitled to state, a percentage
//      it worked out for itself).
//   2. Each copilot FACTS builder audited against ITS OWN ledger. The prompt is
//      app-authored, so by definition every figure in it is app-computed — if
//      that round trip ever fails, the ledger has fallen behind the text and the
//      product would start accusing correct answers. This is the assertion that
//      makes the ledger maintainable: a new facts line that prints a number
//      fails here rather than in front of a user.
//
// userData is a temp dir, as in test-copilot.ts: copilot.ts resolves paths at
// module load, and nothing here touches disk beyond that.

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-numberaudit-'));
process.env.ORDINATE_LOCAL_DIR = tmpUserData;

// ponytail: compiled siblings of the .ts sources under test.
const audit: typeof import('../src/ai/numberAudit') = require('../src/ai/numberAudit');
const copilot: typeof import('../src/ai/copilot') = require('../src/ai/copilot');
const { auditNumbers, harvestAppNumbers } = audit;
type LedgerEntry = import('../src/ai/numberAudit').LedgerEntry;

function led(label: string, value: number, unit: LedgerEntry['unit'] = 'number'): LedgerEntry {
  return { label, value, unit, source: 'test' };
}

/** `ok` for "this answer is clean against this ledger". */
function clean(label: string, text: string, ledger: LedgerEntry[]): void {
  const r = auditNumbers(text, ledger);
  ok(label, r.ok, r.ok ? '' : 'flagged: ' + r.violations.map((v) => v.token).join(', '));
}

/** `ok` for "this answer is flagged, and `token` is among the findings". */
function flags(label: string, text: string, ledger: LedgerEntry[], token: string): void {
  const r = auditNumbers(text, ledger);
  ok(label, !r.ok && r.violations.some((v) => v.token === token),
    'violations: ' + JSON.stringify(r.violations.map((v) => v.token)));
}

// ── 1. Numeric formats ───────────────────────────────────────────────────────
const L = [led('orders', 1234, 'count'), led('revenue', 3200), led('avg order', 42.5)];

clean('a plain integer that is in the ledger', 'There were 1234 orders.', L);
clean('a thousands separator is not two numbers', 'There were 1,234 orders.', L);
clean('a currency symbol is presentational', 'Revenue was $3,200 last period.', L);
clean('a decimal cited exactly', 'The average order was 42.5.', L);
clean('a decimal rounded to the precision shown', 'The average order was 42.5.', [led('avg', 42.4999)]);
clean('a bare integer covers a half-step (42.5 shown as 43)', 'About 43.', [led('avg', 42.5)]);
flags('a decimal rounded too coarsely is a violation', 'The average was 41.', [led('avg', 42.5)], '41');

clean('K notation at the displayed precision', 'Revenue reached 1.2K.', [led('rev', 1180)]);
flags('K notation beyond the displayed precision', 'Revenue reached 1.2K.', [led('rev', 1300)], '1.2K');
clean('M notation', 'Revenue reached 12.4M.', [led('rev', 12_440_000)]);
clean('lowercase k is the same suffix', 'about 3.2k', [led('x', 3200)]);
clean('a K that is really a word is not a suffix', 'It took 3 Kelvin', [led('x', 3)]);

clean('a negative figure', 'Margin fell to -4.2 this quarter.', [led('margin', -4.2)]);
clean('a unicode minus sign', 'Margin fell to −4.2 this quarter.', [led('margin', -4.2)]);
clean('a range reads as two positives, not a negative', 'Orders ran 10-20 a day.',
  [led('lo', 10), led('hi', 20)]);
clean('an en-dash range reads as two positives', 'Orders ran 10–20 a day.',
  [led('lo', 10), led('hi', 20)]);
flags('the upper bound of a range is audited too', 'Orders ran 10-20 a day.', [led('lo', 10)], '20');

// ── 2. Unit awareness — the percentage rule ──────────────────────────────────
clean('a percentage backed by a percent figure', 'Revenue grew 9.4%.', [led('growth', 9.4, 'percent')]);
flags('a percentage the model derived itself', 'Revenue grew 9.4%.',
  [led('rev now', 109.4), led('rev before', 100)], '9.4%');
flags('a percentage is NOT satisfied by a plain figure of the same value',
  'Revenue grew 12.4%.', [led('some count', 12.4)], '12.4%');
clean('a plain figure IS satisfied by a percent entry of the same value',
  'The empty share is 60.', [led('empty pct', 60, 'percent')]);
flags('an empty ledger makes every figure a violation', 'The total was 512.', [], '512');
ok('an empty ledger reports a null nearest',
  auditNumbers('The total was 512.', []).violations[0].nearest === null);

// ── 3. The traps: references that are not figures ────────────────────────────
clean('a year is not a figure', 'Sales were strongest in 2024.', []);
clean('a year at the low end of the range', 'The series starts in 1998.', []);
flags('a five-digit number is NOT treated as a year', 'The total was 20240.', [], '20240');
clean('an order id is not a figure', 'See order 10493 for the outlier.', []);
clean('a hash-prefixed id is not a figure', 'Invoice #4471 is the largest.', []);
clean('an invoice cue is not a figure', 'invoice 22 is duplicated', []);
clean('an ordinal is a position', 'March was the 3rd strongest month.', []);
clean('a list position is not a figure', 'The top 5 regions are listed below.', []);
clean('a count the ledger holds may be stated', 'There are 5 regions.', [led('regions', 5, 'count')]);
flags('a count the ledger does NOT hold may not be stated', 'There are 7 regions.',
  [led('regions', 5, 'count')], '7');

// ── 4. Dates are labels, not figures ─────────────────────────────────────────
clean('an ISO date is masked entirely', 'The peak was on 2024-03-05.', []);
clean('a month-grain label is masked entirely', 'The peak was 2024-03.', []);
clean('a US-order date is masked entirely', 'The peak was on 03/05/2024.', []);
clean('a quarter label is masked entirely', 'The peak was 2024-Q1.', []);
clean('a spelled quarter is masked entirely', 'The peak was Q1 2024.', []);

// ── 5. Tokenising discipline ─────────────────────────────────────────────────
clean('a digit inside a word is not a figure', 'Column A1 holds the key.', []);
clean('a digit at the end of a word is not a figure', 'The COVID19 column is empty.', []);
ok('a repeated violation is reported once',
  auditNumbers('It grew 12.4%, and 12.4% again.', []).violations.filter((v) => v.token === '12.4%').length === 1);
{
  const r = auditNumbers('The total was 512.', [led('near', 500), led('far', 10)]);
  ok('nearest picks the closest ledger entry', r.violations[0].nearest?.label === 'near');
  ok('delta is token minus nearest', r.violations[0].delta === 12);
}
ok('a clean answer reports ok with no violations',
  auditNumbers('Revenue rose sharply.', L).ok && auditNumbers('Revenue rose.', L).violations.length === 0);
ok('non-string input is tolerated', auditNumbers(undefined as any, L).ok);
ok('a non-array ledger is tolerated', auditNumbers('no figures here', undefined as any).ok);

// ── 6. harvestAppNumbers carries the percent unit ────────────────────────────
{
  const h = harvestAppNumbers('Column "region" is 60% empty');
  ok('harvest reads a percentage out of an app sentence',
    h.length === 1 && h[0].value === 60 && h[0].unit === 'percent', JSON.stringify(h));
  ok('harvest skips the years it would be wrong to bank',
    harvestAppNumbers('rebuilt in 2024').length === 0);
}

// ── 7. The round trip: every facts block is clean against its own ledger ─────
//
// Names here carry NO digits on purpose: that is what lets the assertions below
// also prove sealLedger had nothing to catch, i.e. the structured entries are
// the whole ledger rather than a decoration on top of a text harvest.
const SEALED = 'figure printed in the facts block';

function roundTrip(label: string, facts: { text: string; ledger: LedgerEntry[] }): void {
  clean(label + ': its own facts block audits clean', facts.text, facts.ledger);
  ok(label + ': every figure is structurally labelled, not backstopped',
    facts.ledger.every((e) => e.label !== SEALED),
    JSON.stringify(facts.ledger.filter((e) => e.label === SEALED)));
}

async function main(): Promise<void> {
  const ds: any = {
    id: 'x', name: 'Cities', rowCount: 3,
    columns: [{ name: 'city', type: 'text' }, { name: 'pop', type: 'number' }],
    rows: [['Paris', 100], ['Berlin', 300], ['Madrid', 200]],
  };
  const summaries: any[] = [
    { name: 'city', type: 'text', nonEmpty: 3, distinct: 3, mostCommon: { value: 'Paris', count: 1 } },
    { name: 'pop', type: 'number', nonEmpty: 3, min: 100, max: 300, mean: 200, count: 3 },
  ];
  const issues: any[] = [{ kind: 'empty_heavy', detail: 'Column "note" is 60% empty', severity: 'warn' }];
  roundTrip('datasetFacts', copilot.datasetFacts(ds, summaries, issues));
  ok('datasetFacts banks the quality percentage as a percent unit',
    copilot.datasetFacts(ds, summaries, issues).ledger
      .some((e) => e.value === 60 && e.unit === 'percent'));

  const visual: any = {
    id: 'v', name: 'Population by city', chartType: 'column',
    encoding: { category: 'city', values: [{ column: 'pop', aggregation: 'sum' }] },
  };
  const viz: any = {
    data: { labels: ['Paris', 'Berlin'], series: [{ name: 'sum of pop', values: [100, 300] }] },
    recommendedShape: 'categorical', warnings: [],
  };
  roundTrip('visualFacts', copilot.visualFacts(visual, 'Cities', viz));

  const an: any = {
    id: 'a', name: 'Overview',
    sheets: [{ name: 'Main', cards: [{ type: 'metric', metric: { label: 'Total pop', column: 'pop', aggregation: 'sum' } }] }],
  };
  roundTrip('analysisFacts', copilot.analysisFacts(an, [{ label: 'Total pop', value: 600 }]));

  roundTrip('projectFacts', copilot.projectFacts('Demo', {
    datasets: ['Cities'], visuals: ['Population by city'], dashboards: ['Overview'],
  }));

  // The backstop must still WORK — a name carrying digits is the live case it
  // exists for, and a model repeating the name it was handed is not inventing.
  const named = copilot.projectFacts('Demo', { datasets: ['Q3 orders 7714'], visuals: [], dashboards: [] });
  clean('a dataset name carrying digits does not accuse the answer that repeats it',
    'The project has one dataset, Q3 orders 7714.', named.ledger);

  console.log(failureCount() === 0 ? '\nAll number-audit checks passed.' : '\nnumber-audit checks FAILED.');
  finish();
}

void main();
