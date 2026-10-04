// User regexes on the server — the ASYNC half (T6.4, threat-model R1). MAIN.
//
// Each entry point does what its sync twin does, except that before a step or
// rule runs a user pattern it collects the DISTINCT texts that pattern will
// see, has the regex worker (src/engine/regexPool.ts) answer them under a
// deadline, and hands the answers to the sync code as a memo (./regexMemo.ts).
// Same functions, same inputs, so the same output — byte for byte.
//
// Only where the sync code would refuse (the server, with rows to scan): on the
// desktop every entry point IS its sync twin, unchanged.
//
// A call that overruns the deadline skips that step / fails that rule with a
// translated sentence (./regexMessages.ts); the request still answers.

import { applyPipeline, cellToString, colIndex, foldStep, isEmptyCell } from './transforms';
import type { ApplyResult, Cell, PipelineCtx, StepResult, TableData, TransformStep } from './transforms';
import type { ParsedColumn } from './parse';
import { replaceProblem } from './stepsClean';
import { splitProblem } from './stepsReshape';
import { hasRegexRule } from './stepsText';
import type { RegexMemo } from './regexMemo';
import { inlineRegexRefused, regexWorkerOnly } from './regexMemo';
import { regexTimeoutRuleError, regexTimeoutWarning } from './regexMessages';
import { RegexTimeout, deadline, runRegex } from '../engine/regexPool';
import type { RegexSpec } from '../engine/regexPool';
import { evaluateRuleJs, failingPredicateJs } from '../analysis/qualityRules';
import type { QualityRule, RefTable, RuleResult } from '../analysis/qualityRules';
import { formatNumber } from '../app/format';

const seconds = (): string => formatNumber(deadline() / 1000, { maxDecimals: 1 });

/** The distinct texts of column `ci` that a pattern will be run on, first-seen order. */
function textsOf(rows: Cell[][], ci: number, keep: (c: Cell) => boolean, text: (c: Cell) => string): string[] {
  const seen = new Set<string>();
  for (const r of rows) {
    const c = Array.isArray(r) ? r[ci] ?? null : null;
    if (keep(c)) seen.add(text(c));
  }
  return [...seen];
}

/** Run `spec` over `texts` in the worker → a memo. A timeout comes back as the RegexTimeout. */
async function memoOf(spec: RegexSpec, texts: string[]): Promise<RegexMemo | RegexTimeout> {
  try {
    const results = await runRegex(spec, texts);
    return new Map(texts.map((s, i) => [s, results[i]]));
  } catch (e) {
    if (e instanceof RegexTimeout) return e;
    throw e;
  }
}

// ── Steps ────────────────────────────────────────────────────────────────────

/** What a step needs from the worker, or null when it runs no user pattern (or will skip anyway). */
function stepWork(t: TableData, step: TransformStep): { spec: RegexSpec; texts: string[] } | null {
  const notNull = (c: Cell): boolean => c !== null;
  const filled = (c: Cell): boolean => !isEmptyCell(c);
  switch (step.type) {
    case 'replace_values': {
      if (step.mode !== 'regex' || replaceProblem(t.columns, step)) return null;
      const spec: RegexSpec = { op: 'replace', rules: step.rules, ignoreCase: !!step.ignoreCase };
      return { spec, texts: textsOf(t.rows, colIndex(t.columns, step.column), notNull, cellToString) };
    }
    case 'split_column': {
      const ci = colIndex(t.columns, step.column);
      if (step.mode !== 'regex' || ci < 0 || splitProblem(step)) return null;
      const spec: RegexSpec = { op: 'split', pattern: step.pattern as string, ignoreCase: !!step.ignoreCase };
      return { spec, texts: textsOf(t.rows, ci, notNull, cellToString) };
    }
    case 'keyword_rules': {
      const ci = colIndex(t.columns, step.column);
      if (!hasRegexRule(step) || ci < 0) return null;
      const spec: RegexSpec = { op: 'keyword', rules: step.rules || [], otherwise: step.otherwise === undefined ? null : step.otherwise };
      return { spec, texts: textsOf(t.rows, ci, filled, cellToString) };
    }
    default:
      return null;
  }
}

async function stepOffThread(t: TableData, step: TransformStep, ctx: PipelineCtx): Promise<StepResult> {
  const work = inlineRegexRefused(t.rows.length) ? stepWork(t, step) : null;
  if (!work) return foldStep(t, step, ctx);
  let memo: RegexMemo | RegexTimeout;
  try {
    memo = await memoOf(work.spec, work.texts);
  } catch (e) {
    // The fold's own contract: a step never throws, it is skipped and named.
    return { table: t, warnings: [`Step "${step.type}" skipped: ${e instanceof Error ? e.message : 'unknown error'}`] };
  }
  if (memo instanceof RegexTimeout) return { table: t, warnings: [regexTimeoutWarning(seconds())] };
  return foldStep(t, step, ctx, memo);
}

/**
 * transforms.applyPipeline, with every user pattern evaluated off the request
 * thread under a deadline. The ONLY fold a server request may run user steps
 * through.
 */
export async function applyPipelineAsync(source: TableData, steps: TransformStep[], ctx: PipelineCtx = {}): Promise<ApplyResult> {
  const list = Array.isArray(steps) ? steps : [];
  if (!regexWorkerOnly() || !list.some(needsWorker)) {
    return applyPipeline(source, list, ctx);
  }
  const start = applyPipeline(source, [], ctx); // the fold's own deep copy
  let table: TableData = { columns: start.columns, rows: start.rows };
  const warnings: string[] = [];
  const stepCounts: NonNullable<ApplyResult['stepCounts']> = [];
  for (const step of list) {
    const result = await stepOffThread(table, step, ctx);
    stepCounts.push({ before: table.rows.length, after: result.table.rows.length });
    table = result.table;
    for (const w of result.warnings) warnings.push(w);
  }
  return { columns: table.columns, rows: table.rows, rowCount: table.rows.length, warnings, stepCounts };
}

/** A step type and mode that runs a user pattern (whatever its columns). */
function needsWorker(s: TransformStep | null | undefined): boolean {
  if (!s) return false;
  if (s.type === 'replace_values' || s.type === 'split_column') return s.mode === 'regex';
  return s.type === 'keyword_rules' && hasRegexRule(s);
}

// ── Quality rules ────────────────────────────────────────────────────────────

/** A `regex` rule's memo over `rows`, or null when no worker is needed. */
async function ruleMemo(rule: QualityRule, columns: ParsedColumn[], rows: Cell[][]): Promise<RegexMemo | RegexTimeout | null> {
  const ci = colIndex(columns, rule.column ?? '');
  if (rule.kind !== 'regex' || ci < 0 || !inlineRegexRefused(rows.length)) return null;
  return memoOf({ op: 'match', pattern: rule.args.pattern ?? '' }, textsOf(rows, ci, (c) => !isEmptyCell(c), String));
}

/** qualityRules.evaluateRuleJs, its pattern off the request thread. */
export async function evaluateRuleAsync(rule: QualityRule, columns: ParsedColumn[], rows: Cell[][], ref?: RefTable | null): Promise<RuleResult> {
  const memo = await ruleMemo(rule, columns, rows);
  if (memo instanceof RegexTimeout) return { ruleId: rule.id, passed: false, failing: 0, sample: [], error: regexTimeoutRuleError(seconds()) };
  return evaluateRuleJs(rule, columns, rows, ref, memo ?? undefined);
}

/** qualityRules.failingPredicateJs, its pattern off the request thread. */
export async function failingPredicateAsync(
  rule: QualityRule, columns: ParsedColumn[], rows: Cell[][], ref?: RefTable | null,
): Promise<ReturnType<typeof failingPredicateJs>> {
  const memo = await ruleMemo(rule, columns, rows);
  if (memo instanceof RegexTimeout) return { error: regexTimeoutRuleError(seconds()) };
  return failingPredicateJs(rule, columns, rows, ref, memo ?? undefined);
}

/** The memo (or the timeout sentence) for each `regex` rule over cells as they will be tested. */
export async function ruleMemos(rules: QualityRule[], columns: ParsedColumn[], rows: Cell[][]): Promise<Map<string, RegexMemo | string>> {
  const out = new Map<string, RegexMemo | string>();
  for (const rule of rules) {
    const memo = await ruleMemo(rule, columns, rows);
    if (memo instanceof RegexTimeout) out.set(rule.id, regexTimeoutRuleError(seconds()));
    else if (memo) out.set(rule.id, memo);
  }
  return out;
}
