// The recorded corpus behind scripts/test-verifiedEval.ts §2 (semantic layer part 3 D13.1).
//
// Each case is a model's whole reply to a question, ending in its @@ACTION line, the sample project's verified
// question it is scored against (src/app/sampleGuidance.ts), and the outcome the judge must give. CI replays them
// through the real path — `splitAction`, the validator, `judgeSpec` — with no model. It guards resolution and
// judging, not the prompt: that is live mode's job (ORDINATE_LIVE_MODEL=1).
//
// `recorded: true` means `line` is a REAL reply, pasted from live mode's printout. The `written` cases pin what no
// live run happened to produce.

import type { Outcome } from '../src/ipc/verifiedJudge';

export interface EvalCase {
  name: string;
  /** True when `line` is a captured model reply rather than written here. */
  recorded: boolean;
  /** What was asked: the verified question or one of its phrasings. */
  question: string;
  /** The sample's verified question it is scored against. */
  verified: string;
  /** The model's whole reply, ending in its @@ACTION line. */
  line: string;
  expect: Outcome;
}

const DS = '"dataset":"Retail orders"';
const SUM = (column: string): string => `"measures":[{"column":"${column}","aggregation":"sum"}]`;
const reply = (intent: string, spec: string): string =>
  `Here is the chart.\n@@ACTION {"kind":"answer","intent":"${intent}","spec":{${DS},${spec}}}`;
const LAST_YEAR = '"filters":[{"column":"order_date","period":"last_year"}]';

export const EVAL_CASES: EvalCase[] = [
  // ── Revenue by region ──
  { name: 'Revenue by region: the verified spec', recorded: false, question: 'Revenue by region', verified: 'Revenue by region',
    line: reply('Revenue by region', `"category":"region",${SUM('revenue')},"filters":[]`), expect: 'match' },
  { name: 'Revenue by region: only the chart type changed', recorded: false, question: 'Revenue by region', verified: 'Revenue by region',
    line: reply('Revenue by region', `"category":"region",${SUM('revenue')},"chartType":"bar"`), expect: 'match' },
  { name: '"Sales by region": sales resolved to the revenue column', recorded: false, question: 'Sales by region', verified: 'Revenue by region',
    line: reply('Sales by region', `"category":"region",${SUM('revenue')}`), expect: 'match' },
  // No sample question filters a value: `in` every region draws the same figures as none, `=` one region does not
  // (`in ['West']` against `= 'West'` is pinned in §1).
  { name: 'Revenue by region: in every region agrees by figures', recorded: false, question: 'Revenue by region', verified: 'Revenue by region',
    line: reply('Revenue by region', `"category":"region",${SUM('revenue')},"filters":[{"column":"region","op":"in","values":["Central","East","Northeast","South","West"]}]`), expect: 'match' },
  { name: 'Revenue by region: = West is another chart', recorded: false, question: 'Revenue by region', verified: 'Revenue by region',
    line: reply('Revenue by region', `"category":"region",${SUM('revenue')},"filters":[{"column":"region","op":"=","value":"West"}]`), expect: 'differs' },
  { name: 'Revenue by region: a wrong measure', recorded: false, question: 'Which region sells the most', verified: 'Revenue by region',
    line: reply('Which region sells the most', `"category":"region",${SUM('units')}`), expect: 'differs' },
  { name: '"Sales by region": an unknown column is refused', recorded: false, question: 'Sales by region', verified: 'Revenue by region',
    line: reply('Sales by region', `"category":"region",${SUM('sales')}`), expect: 'refused' },
  { name: 'Revenue by region: a reply with no action line', recorded: false, question: 'Which region sells the most', verified: 'Revenue by region',
    line: 'West sells the most of the five regions.', expect: 'refused' },

  // ── Profit by category ──
  { name: 'Profit by category: the verified spec', recorded: false, question: 'Profit by category', verified: 'Profit by category',
    line: reply('Profit by category', `"category":"category",${SUM('profit')},"filters":[]`), expect: 'match' },
  { name: 'Profit by category: only the chart type changed', recorded: false, question: 'Profit per category', verified: 'Profit by category',
    line: reply('Profit per category', `"category":"category",${SUM('profit')},"chartType":"pie"`), expect: 'match' },
  { name: 'Profit by category: an average is a wrong measure', recorded: false, question: 'Profit by category', verified: 'Profit by category',
    line: `Here is the chart.\n@@ACTION {"kind":"answer","intent":"Profit by category","spec":{${DS},"category":"category","measures":[{"column":"profit","aggregation":"avg"}]}}`,
    expect: 'differs' },

  // ── Top 5 states by revenue ──
  { name: 'Top 5 states by revenue: the verified spec', recorded: false, question: 'Top 5 states by revenue', verified: 'Top 5 states by revenue',
    line: reply('Top 5 states by revenue', `"category":"state",${SUM('revenue')},"top":5`), expect: 'match' },
  { name: 'Top 5 states by revenue: only the chart type changed', recorded: false, question: 'Best states by revenue', verified: 'Top 5 states by revenue',
    line: reply('Best states by revenue', `"category":"state",${SUM('revenue')},"top":5,"chartType":"bar"`), expect: 'match' },
  { name: 'Top 5 states by revenue: a top 10 is another chart', recorded: false, question: 'Best states by revenue', verified: 'Top 5 states by revenue',
    line: reply('Best states by revenue', `"category":"state",${SUM('revenue')},"top":10`), expect: 'differs' },

  // ── Revenue by month last year ──
  { name: 'Revenue by month last year: the verified spec', recorded: false, question: 'Revenue by month last year', verified: 'Revenue by month last year',
    line: reply('Revenue by month last year', `"category":"order_date","grain":"month",${SUM('revenue')},${LAST_YEAR},"chartType":"line"`), expect: 'match' },
  { name: 'Revenue by month last year: only the chart type changed', recorded: false, question: 'Monthly revenue last year', verified: 'Revenue by month last year',
    line: reply('Monthly revenue last year', `"category":"order_date","grain":"month",${SUM('revenue')},${LAST_YEAR},"chartType":"column"`), expect: 'match' },
  { name: 'Revenue by month last year: a wrong period', recorded: false, question: 'Revenue by month last year', verified: 'Revenue by month last year',
    line: reply('Revenue by month last year', `"category":"order_date","grain":"month",${SUM('revenue')},"filters":[{"column":"order_date","period":"last_quarter"}]`), expect: 'differs' },
  // With no grain, a year of days rolls up by week (analysis/categoryKey `chooseGrain`): another chart.
  { name: 'Revenue by month last year: no grain is another chart', recorded: false, question: 'Monthly revenue last year', verified: 'Revenue by month last year',
    line: reply('Monthly revenue last year', `"category":"order_date",${SUM('revenue')},${LAST_YEAR}`), expect: 'differs' },
];
