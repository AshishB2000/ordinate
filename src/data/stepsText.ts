// The text steps in the transforms fold — MAIN PROCESS. The JS implementation
// is the ONLY one: sqlGen bails on these types (a tokenizer and VADER have no
// SQL form), so the resident and DuckDB paths fall back here.
//
// Every step builds a new table and never touches its input. A missing column
// SKIPS the step with a warning — the transforms.ts contract. Empty text
// (null, '' or whitespace — isEmptyCell) is not a document: it has no terms, no
// sentiment (null, not 0) and takes the default category.
//
// ── Long runs ────────────────────────────────────────────────────────────────
// Scoring a million reviews takes seconds, and the fold is synchronous. So each
// step is a RUNNER — per-row work that can be done in chunks, then a cheap
// finish — and src/ipc/text.ts runs the chunks in a `compute` job (progress,
// cancel, the main thread free between chunks) before committing the step
// through the ordinary save path. The job leaves the finished runner WARM,
// keyed by a SHA-1 of the step and every cell it reads; when the fold reaches
// the same step over the same cells it takes the warm runner instead of redoing
// the work. Same function, same input, so the same output — a changed cell
// changes the key and the fold simply computes. Nothing is ever served stale.

import { createHash } from 'crypto';
import type { Cell, TableData } from './transforms';
import { cellToString, colIndex, isEmptyCell } from './transforms';
import type { ParsedColumn } from './parse';
import type { PowerResult } from './stepsReshape';
import { skipped } from './stepsReshape';
import type { KeywordRulesStep, TextSentimentStep, TextStep, TextTermsStep } from './textStepTypes';
import { TERMS_COLUMNS, categoryColumnName, sentimentColumnName } from './textStepTypes';
import { addCounts, documentTerms } from '../analysis/text/ngrams';
import type { GroupCounts } from '../analysis/text/tfidf';
import { documentFrequency, rankGroup, tfidfScores } from '../analysis/text/tfidf';
import { compoundScore, vaderVersion } from '../analysis/text/vader';
import { categorize, compileRules } from '../analysis/text/keywordRules';

/** Per-row work over rows [from, to), then the table. `finish` reads `t` only for its existing cells. */
export interface TextRunner {
  rows: number;
  run(from: number, to: number): void;
  finish(t: TableData): PowerResult;
}

function runnerFor(t: TableData, step: TextStep): TextRunner | PowerResult {
  switch (step.type) {
    case 'text_terms':
      return termsRunner(t, step);
    case 'text_sentiment':
      return sentimentRunner(t, step);
    case 'keyword_rules':
      return keywordRunner(t, step);
    default:
      return skipped(t, `Unknown step type "${(step as { type: string }).type}" skipped`);
  }
}

const isResult = (r: TextRunner | PowerResult): r is PowerResult => 'table' in r;

export function applyTextStep(t: TableData, step: TextStep): PowerResult {
  const warm = takeWarm(t, step);
  if (warm) return warm.finish(t);
  const r = runnerFor(t, step);
  if (isResult(r)) return r;
  r.run(0, r.rows);
  return r.finish(t);
}

// ── Warm runners ─────────────────────────────────────────────────────────────

const warmRunners = new Map<string, TextRunner>();
/** Below this the fold is quick enough that neither a job nor a key is worth it. */
export const WARM_MIN_ROWS = 20_000;
const CHUNK = 5_000;

/** SHA-1 of the step and of every cell it reads (names, types and values, in order). */
export function textStepKey(t: TableData, step: TextStep): string {
  const h = createHash('sha1');
  h.update(JSON.stringify(step));
  const cols = [step.column, step.type === 'text_terms' ? step.by : undefined]
    .filter((c): c is string => typeof c === 'string')
    .map((name) => colIndex(t.columns, name));
  for (const ci of cols) {
    const c = t.columns[ci];
    h.update(`\u0000col:${c ? c.name + ':' + c.type : '?'}`);
    if (ci < 0) continue;
    for (const r of t.rows) {
      const v = r[ci];
      // A type tag per cell: null, the string "null" and the number 0 hash apart.
      h.update(v === null || v === undefined ? '\u0000n' : typeof v === 'number' ? `\u0000#${v}` : `\u0000s${v}`);
    }
  }
  h.update(`\u0000rows:${t.rows.length}`);
  return h.digest('hex');
}

function takeWarm(t: TableData, step: TextStep): TextRunner | null {
  if (!warmRunners.size || t.rows.length < WARM_MIN_ROWS) return null;
  const key = textStepKey(t, step);
  const hit = warmRunners.get(key) || null;
  if (hit) warmRunners.delete(key);
  return hit;
}

/**
 * Do a step's per-row work in chunks, yielding between them, and leave it warm
 * for the fold. `progress` gets 0–1; `cancelled` is polled per chunk (the
 * caller throws). Returns the key, so the caller can drop it if the commit fails.
 */
export async function warmTextStep(
  t: TableData, step: TextStep, progress: (p: number) => void, cancelled: () => boolean,
): Promise<string | null> {
  warmRunners.clear(); // one warm step at a time: a new warm-up supersedes any other
  const r = runnerFor(t, step);
  if (isResult(r)) return null; // it will skip in the fold too, instantly
  for (let from = 0; from < r.rows; from += CHUNK) {
    if (cancelled()) return null;
    r.run(from, Math.min(r.rows, from + CHUNK));
    progress(Math.min(1, (from + CHUNK) / Math.max(1, r.rows)));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const key = textStepKey(t, step);
  warmRunners.set(key, r);
  return key;
}

export function dropWarm(key: string | null): void {
  if (key) warmRunners.delete(key);
}

// ── text_sentiment ───────────────────────────────────────────────────────────

function sentimentRunner(t: TableData, s: TextSentimentStep): TextRunner | PowerResult {
  const ci = colIndex(t.columns, s.column);
  if (ci < 0) return skipped(t, `Sentiment skipped: unknown column "${s.column}"`);
  const name = sentimentColumnName(s);
  if (colIndex(t.columns, name) >= 0) return skipped(t, `Sentiment skipped: column "${name}" already exists`);
  const values: Array<number | null> = new Array(t.rows.length).fill(null);
  return {
    rows: t.rows.length,
    run(from, to) {
      for (let i = from; i < to; i += 1) {
        const cell = t.rows[i][ci] ?? null;
        values[i] = isEmptyCell(cell) ? null : compoundScore(cellToString(cell));
      }
    },
    finish(input) {
      const warnings: string[] = [];
      const now = vaderVersion();
      if (s.lexiconVersion && s.lexiconVersion !== now) {
        warnings.push(`Sentiment "${name}" was set up with ${s.lexiconVersion}; scored with ${now}`);
      }
      const columns: ParsedColumn[] = [...input.columns.map((c) => ({ ...c })), { name, type: 'number' }];
      return { table: { columns, rows: input.rows.map((r, i) => [...r, values[i]]) }, warnings };
    },
  };
}

// ── keyword_rules ────────────────────────────────────────────────────────────

function keywordRunner(t: TableData, s: KeywordRulesStep): TextRunner | PowerResult {
  const ci = colIndex(t.columns, s.column);
  if (ci < 0) return skipped(t, `Tag with rules skipped: unknown column "${s.column}"`);
  const name = categoryColumnName(s);
  if (colIndex(t.columns, name) >= 0) return skipped(t, `Tag with rules skipped: column "${name}" already exists`);
  const compiled = compileRules(s.rules || []);
  if (!compiled.tests.length) return skipped(t, 'Tag with rules skipped: no usable rules');
  const otherwise = s.otherwise === undefined ? null : s.otherwise;
  const values: Array<string | null> = new Array(t.rows.length).fill(otherwise);
  return {
    rows: t.rows.length,
    run(from, to) {
      for (let i = from; i < to; i += 1) {
        const cell = t.rows[i][ci] ?? null;
        values[i] = isEmptyCell(cell) ? otherwise : categorize(cellToString(cell), compiled, otherwise);
      }
    },
    finish(input) {
      const warnings = compiled.problems.map((p) => `Tag with rules: ${p} — rule left out`);
      const columns: ParsedColumn[] = [...input.columns.map((c) => ({ ...c })), { name, type: 'text' }];
      return { table: { columns, rows: input.rows.map((r, i) => [...r, values[i]]) }, warnings };
    },
  };
}

// ── text_terms ───────────────────────────────────────────────────────────────

interface Group extends GroupCounts {
  key: Cell;
  /** Per term: sum of the compound scores of the rows it occurs in, and how many rows. */
  senti?: Map<string, { sum: number; rows: number }>;
}

/**
 * The top terms, overall or per group of `by`.
 *
 * Output: [by], term, words (n), count, [tfidf when by], [sentiment]. Groups
 * appear in first-seen row order; within one, terms rank best first (see
 * tfidf.rankGroup for the tie rules). Rows with empty text are no document at
 * all — they neither add a group nor count towards N.
 */
function termsRunner(t: TableData, s: TextTermsStep): TextRunner | PowerResult {
  const ci = colIndex(t.columns, s.column);
  if (ci < 0) return skipped(t, `Count terms skipped: unknown column "${s.column}"`);
  const bi = s.by ? colIndex(t.columns, s.by) : -1;
  if (s.by && bi < 0) return skipped(t, `Count terms skipped: unknown column "${s.by}"`);
  if (s.by && (Object.values(TERMS_COLUMNS) as string[]).includes(s.by)) {
    return skipped(t, `Count terms skipped: the dimension "${s.by}" has the same name as an output column — rename it first`);
  }
  const byColumn: ParsedColumn | null = bi >= 0 ? { ...t.columns[bi] } : null;
  const groups: Group[] = [];
  const byKey = new Map<string, Group>();
  const opts = { lang: s.lang, minN: s.minN, maxN: s.maxN, keepNumbers: !!s.keepNumbers };
  return {
    rows: t.rows.length,
    run(from, to) {
      for (let i = from; i < to; i += 1) {
        const r = t.rows[i];
        const cell = r[ci] ?? null;
        if (isEmptyCell(cell)) continue;
        const keyCell: Cell = bi >= 0 ? (r[bi] ?? null) : null;
        const k = JSON.stringify(keyCell);
        let g = byKey.get(k);
        if (!g) {
          g = { key: keyCell, counts: new Map(), total: 0 };
          if (s.sentiment) g.senti = new Map();
          byKey.set(k, g);
          groups.push(g);
        }
        const text = cellToString(cell);
        const terms = documentTerms(text, opts);
        addCounts(g.counts, terms);
        g.total += terms.length;
        if (g.senti) {
          const score = compoundScore(text);
          for (const term of new Set(terms)) {
            const acc = g.senti.get(term) || { sum: 0, rows: 0 };
            acc.sum += score;
            acc.rows += 1;
            g.senti.set(term, acc);
          }
        }
      }
    },
    finish() {
      const df = documentFrequency(groups);
      const columns: ParsedColumn[] = [];
      if (byColumn) columns.push(byColumn);
      columns.push({ name: TERMS_COLUMNS.term, type: 'text' }, { name: TERMS_COLUMNS.ngram, type: 'number' },
        { name: TERMS_COLUMNS.count, type: 'number' });
      if (byColumn) columns.push({ name: TERMS_COLUMNS.tfidf, type: 'number' });
      if (s.sentiment) columns.push({ name: TERMS_COLUMNS.sentiment, type: 'number' });
      const rows: Cell[][] = [];
      for (const g of groups) {
        const scores = byColumn ? tfidfScores(g, df, groups.length) : new Map<string, number>();
        for (const [term, count, score] of rankGroup(g, scores, s.rank, s.top)) {
          const row: Cell[] = [];
          if (byColumn) row.push(g.key);
          row.push(term, term.split(' ').length, count);
          if (byColumn) row.push(score);
          if (g.senti) {
            const acc = g.senti.get(term);
            row.push(acc && acc.rows ? acc.sum / acc.rows : null);
          }
          rows.push(row);
        }
      }
      const warnings = groups.length ? [] : [`Count terms: "${s.column}" has no text to count`];
      return { table: { columns, rows }, warnings };
    },
  };
}
