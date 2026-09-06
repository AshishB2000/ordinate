// The recorded corpus behind scripts/test-number-fidelity.ts.
//
// Each case is an answer, the ledger the app handed the model for that turn, and
// the exact set of tokens the audit must flag. Committed and deterministic, so
// CI runs the gate with no model.
//
// `recorded: true` means the `answer` is a REAL model transcript, captured from
// the live run (ORDINATE_LIVE_MODEL=1) against the seeded Orders dataset. Those
// are the valuable ones: they carry the phrasings a model actually reaches for,
// which is not what an author writing "a plausible bad answer" produces. The
// `written` cases exist to pin behaviour no live run happened to exercise.
//
// Ledgers are trimmed to the entries a case needs — the audit only ever asks
// whether SOME entry matches, so a smaller ledger is a stricter test.

import type { LedgerEntry } from '../src/ai/numberAudit';

export interface FidelityCase {
  name: string;
  /** True when `answer` is a captured model transcript rather than written here. */
  recorded: boolean;
  answer: string;
  ledger: LedgerEntry[];
  /** Every token the audit must flag — exact strings, order irrelevant. */
  violations: string[];
}

const S = 'datasetStats';
const e = (label: string, value: number, unit: LedgerEntry['unit'] = 'number'): LedgerEntry =>
  ({ label, value, unit, source: S });

// The ledger the seeded Orders dataset produces, trimmed to what the cases cite.
const ORDERS: LedgerEntry[] = [
  e('row count', 364, 'count'),
  e('column count', 3, 'count'),
  e('amount min', 60),
  e('amount max', 152),
  e('amount mean', 121.5),
  e('amount numeric values', 364, 'count'),
  e('amount non-empty', 364, 'count'),
  e('region distinct', 4, 'count'),
  e('region non-empty', 364, 'count'),
  e('region most common count', 91, 'count'),
];

export const FIDELITY_CASES: FidelityCase[] = [
  // ── Clean answers: narration of figures that are in the ledger ────────────
  {
    name: 'a row count read straight off the ledger',
    recorded: false,
    answer: 'The dataset has 364 rows across 3 columns.',
    ledger: ORDERS,
    violations: [],
  },
  {
    name: 'a mean cited exactly as computed',
    recorded: false,
    answer: 'The average order amount is 121.5.',
    ledger: ORDERS,
    violations: [],
  },
  {
    name: 'a mean rounded to the precision shown',
    recorded: false,
    answer: 'Orders average about 122 per order.',
    ledger: ORDERS,
    violations: [],
  },
  {
    name: 'a min and max quoted as a range',
    recorded: false,
    answer: 'Amounts run from 60 to 152.',
    ledger: ORDERS,
    violations: [],
  },
  {
    name: 'a distinct count the ledger holds',
    recorded: false,
    answer: 'There are 4 distinct regions in the data.',
    ledger: ORDERS,
    violations: [],
  },
  {
    name: 'a purely qualitative answer states no figures at all',
    recorded: false,
    answer: 'Amounts are broadly stable, with one clear dip late in the period.',
    ledger: ORDERS,
    violations: [],
  },
  {
    name: 'thousands separators in a large figure',
    recorded: false,
    answer: 'Total revenue came to 44,226.',
    ledger: [e('revenue total', 44226)],
    violations: [],
  },
  {
    name: 'compact notation at the displayed precision',
    recorded: false,
    answer: 'Revenue was about 44.2K over the period.',
    ledger: [e('revenue total', 44226)],
    violations: [],
  },
  {
    name: 'a currency symbol does not change the figure',
    recorded: false,
    answer: 'The biggest order was $152.',
    ledger: ORDERS,
    violations: [],
  },

  // ── Traps that must NOT be flagged ───────────────────────────────────────
  {
    name: 'a year in prose is not a figure',
    recorded: false,
    answer: 'Every order falls in 2024, so there is no year-on-year comparison to make.',
    ledger: ORDERS,
    violations: [],
  },
  {
    name: 'a month-grain label is not a stray figure',
    recorded: false,
    answer: 'The lowest month was 2024-09, well below the rest.',
    ledger: ORDERS,
    violations: [],
  },
  {
    name: 'an id the user asked about is not a figure',
    recorded: false,
    answer: 'I cannot see order 10493 in the columns provided.',
    ledger: ORDERS,
    violations: [],
  },
  {
    name: 'an ordinal is a position, not a measurement',
    recorded: false,
    answer: 'September is the 9th month and the weakest one here.',
    ledger: ORDERS,
    violations: [],
  },
  {
    name: 'a list position is not a measurement',
    recorded: false,
    answer: 'The top 3 regions are listed below in order.',
    ledger: ORDERS,
    violations: [],
  },
  {
    name: 'a percentage the app DID compute may be quoted',
    recorded: false,
    answer: 'The note column is 60% empty, which limits what can be said about it.',
    ledger: [...ORDERS, e('quality: empty_heavy', 60, 'percent')],
    violations: [],
  },

  // ── Violations: figures the model produced ───────────────────────────────
  {
    name: 'a growth percentage the model derived',
    recorded: false,
    answer: 'Revenue grew 12.4% over the period.',
    ledger: ORDERS,
    violations: ['12.4%'],
  },
  {
    name: 'a share-of-total the model derived',
    recorded: false,
    answer: 'The largest region accounts for roughly 31% of the total.',
    ledger: ORDERS,
    violations: ['31%'],
  },
  {
    name: 'a percentage is not excused by a plain figure of the same value',
    recorded: false,
    answer: 'Amounts fell 4% in the dip.',
    ledger: [...ORDERS, e('some count', 4, 'count')],
    violations: ['4%'],
  },
  {
    name: 'a total the app never computed',
    recorded: false,
    answer: 'Summing every order gives 44226 for the period.',
    ledger: ORDERS,
    violations: ['44226'],
  },
  {
    name: 'a per-group average the ledger does not carry',
    recorded: false,
    answer: 'North averages 124.8 per order, ahead of South at 118.2.',
    ledger: ORDERS,
    violations: ['124.8', '118.2'],
  },
  {
    name: 'a median, which the app does not compute at all',
    recorded: false,
    answer: 'The median order amount is 120.',
    ledger: ORDERS,
    violations: ['120'],
  },
  {
    name: 'a projection is entirely invented',
    recorded: false,
    answer: 'A 10% uplift would take revenue to about 48,650.',
    ledger: ORDERS,
    violations: ['10%', '48,650'],
  },
  {
    name: 'one clean figure alongside one invented figure',
    recorded: false,
    answer: 'Across 364 rows the median is 120.',
    ledger: ORDERS,
    violations: ['120'],
  },
  {
    name: 'an empty ledger makes every figure a finding',
    recorded: false,
    answer: 'There are 12 sheets holding 48 cards.',
    ledger: [],
    violations: ['12', '48'],
  },

  // ── Recorded ─────────────────────────────────────────────────────────────
  {
    // Captured verbatim from the live run (ORDINATE_LIVE_MODEL=1, local CLI
    // `antigravity`, 2026-09-06): asked "How many rows does this dataset have?"
    // over the seeded Orders dataset, it returned the bare action object and no
    // prose at all — for this and all eleven other questions.
    //
    // It is here because of what it proves about the AUDIT rather than about
    // that CLI: a non-answer states no wrong figure, so `auditNumbers` calls it
    // clean, and it is clean. Number fidelity is not answer quality, and this
    // case pins that boundary so nobody later "fixes" the audit into an
    // answer-quality checker. Catching this shape is the live runner's job, and
    // it now does (the prose check in test-number-fidelity.ts).
    name: 'a degenerate model reply is clean, because it states no figure',
    recorded: true,
    answer: '{"kind":"none","intent":""}',
    ledger: ORDERS,
    violations: [],
  },
];
