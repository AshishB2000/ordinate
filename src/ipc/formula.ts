// Formula CHECKING for the formula editor — MAIN PROCESS.
//
// The editor asks this on every (debounced) keystroke: is the expression valid,
// where exactly is it wrong, which columns does it name, which of those do not
// exist, what type does it produce, and what does it produce for the first
// eight rows.
//
// WHY MAIN AND NOT THE RENDERER. The compiler already lives here, and it is the
// SAME `compile()` that `transforms.stepCalculatedField` runs when the step is
// saved. A second checker in the renderer would be a second opinion on whether
// a formula is valid, and the two would drift — at which point the editor shows
// a green preview for an expression the pipeline then skips with a warning
// nobody reads. One compiler, one verdict.
//
// NOTHING HERE WRITES. No step is added, no dataset is touched, no `.parquet`
// is rewritten. Checking a formula the user then abandons must leave no trace —
// which is also why the sample is read through `pageFor` (a windowed read off
// the stored Parquet) rather than by hydrating the table.
//
// THE COLUMN SET IS THE PREPARED ONE. `getDatasetMeta` returns the columns as
// they stand AFTER the pipeline, so a formula can reference a column an earlier
// step produced — which is the whole reason "is `[x]` a column?" cannot be
// answered from the imported file's header.
// ponytail: when EDITING a step that is not last, the columns shown are still
// the pipeline's FINAL ones, so a column a later step drops is offered and a
// column a later step renames is not. Fixing it means re-running the pipeline
// to step i-1 per keystroke; revisit if anyone actually hits it.

import { ipcMain } from './bus';

import { compile, type FValue, type SourceSpan } from '../formula/formula';
import { tokenize, type Tok } from '../formula/formulaTokens';
import { LOD_DOCS, listFunctionDocs, type FunctionDoc } from '../formula/formulaDocs';
import { nearestColumn } from '../formula/didYouMean';
import { lodDimProblem } from '../formula/lod';
import { detectColumnType } from '../data/parse';
import * as datasets from '../data/datasets';
import { pageFor } from './datasets';
import { lodPreview } from './lodData';

/** How many rows the preview shows. Small on purpose: this runs per keystroke. */
const SAMPLE_ROWS = 8;

/**
 * Longest expression accepted. The tokenizer is linear and the evaluator runs
 * over eight rows, so this is not a performance cliff — it is the ordinary
 * bound on a string arriving from a renderer, so a pathological paste cannot
 * turn a keystroke into a stall.
 */
const MAX_EXPRESSION = 4000;

export type ResultType = 'number' | 'string' | 'date' | 'logical';

export interface UnknownRef {
  name: string;
  /** The closest real column, when one is close enough to be worth offering. */
  didYouMean?: string;
}

export interface FormulaSample {
  /** The referenced columns that EXIST, in the order the expression names them,
   *  then one column per LOD expression, headed by its source text. */
  columns: string[];
  rows: Array<{ inputs: FValue[]; result: FValue }>;
  /** How many trailing `columns` are LOD values rather than dataset columns. */
  lodColumns?: number;
  /** Why the LOD values are missing from the preview, when they are. */
  note?: string;
}

export interface FormulaCheck {
  /** Every token with its source offsets — what the editor's highlight layer paints. */
  tokens: Tok[];
  ok: boolean;
  error?: string;
  /** Where the error is, in source offsets. Absent when the failure has no position. */
  at?: SourceSpan;
  refs: string[];
  unknownRefs: UnknownRef[];
  /** What the formula produces, judged from the sample. Null when it produced nothing. */
  resultType: ResultType | null;
  sample: FormulaSample;
}

const EMPTY_SAMPLE: FormulaSample = { columns: [], rows: [] };

function emptyCheck(tokens: Tok[], error: string, at?: SourceSpan): FormulaCheck {
  return { tokens, ok: false, error, at, refs: [], unknownRefs: [], resultType: null, sample: EMPTY_SAMPLE };
}

// ── Result type ──────────────────────────────────────────────────────────────

/**
 * What the expression produces, judged from the values it actually produced.
 *
 * The number and text arms are `transforms.retypeColumn`'s rule verbatim —
 * already-numeric results are numbers (never re-sniffed, or `revenue / units`
 * would come back "text" through detectColumnType's 15-digit guard), and
 * everything else is classified by the app's own column sniffer. Using the
 * SAME sniffer is what makes the badge a promise: it is the type the column
 * will really have once the step is saved.
 *
 * `logical` is the one addition, and the one place the badge describes the
 * EXPRESSION rather than the stored column — a boolean result is saved as the
 * text "true"/"false", because the app has no boolean column type. Saying
 * "logical" is still the honest answer to "what does this formula give me".
 */
function inferResultType(values: FValue[]): ResultType | null {
  const present = values.filter((v) => v !== null && v !== '');
  if (present.length === 0) return null;
  if (present.every((v) => typeof v === 'boolean')) return 'logical';
  if (present.every((v) => typeof v === 'number' && Number.isFinite(v))) return 'number';
  const detected = detectColumnType(present.map((v) => String(v)));
  return detected === 'text' ? 'string' : detected;
}

// ── The check ────────────────────────────────────────────────────────────────

async function checkFormula(projectId: string, datasetId: string, expression: string): Promise<FormulaCheck> {
  const src = typeof expression === 'string' ? expression : '';
  if (src.length > MAX_EXPRESSION) {
    return emptyCheck([], `Expression is too long (${src.length} characters; the limit is ${MAX_EXPRESSION}).`);
  }

  // Tokenize FIRST and separately from compiling, because the highlight layer
  // needs tokens even for an expression that does not parse — the colours
  // should not blink out while a call is half-typed. An expression the
  // TOKENIZER rejects (an unterminated string) is the one case with no tokens
  // to show; the message and the underline still land.
  let tokens: Tok[] = [];
  try {
    tokens = tokenize(src);
  } catch (_) {
    /* compile() below reports the same failure, with its position */
  }

  const res = compile(src);
  if (!res.ok) return emptyCheck(tokens, res.error, res.at);

  const refs = res.fn.refs;
  const meta = await datasets.getDatasetMeta(projectId, datasetId);
  if (!meta) return emptyCheck(tokens, 'Dataset not found');
  const columnNames = meta.columns.map((c) => c.name);
  // r7:lod — an unknown LOD dimension is an ERROR, underlined, not a hint.
  const lodBad = lodDimProblem(res.fn, columnNames);
  if (lodBad) return emptyCheck(tokens, lodBad.error, lodBad.at);

  const unknownRefs: UnknownRef[] = refs
    .filter((ref) => !columnNames.includes(ref))
    .map((ref) => {
      const didYouMean = nearestColumn(ref, columnNames);
      return didYouMean === undefined ? { name: ref } : { name: ref, didYouMean };
    });

  // The sample is the point of the whole panel: a formula that compiles can
  // still be silently wrong (the wrong column, a text column in a division),
  // and eight real rows say so immediately where a green tick does not.
  const page = await pageFor(projectId, datasetId, { offset: 0, limit: SAMPLE_ROWS }, 'formulaCheck');
  const known = refs.filter((ref) => columnNames.includes(ref));
  // An LOD's value is an aggregate over the WHOLE table, so it is computed
  // there (ipc/lodData) and only its first eight values join the sample.
  const lods = res.fn.lods;
  const lodVals = lods.length ? await lodPreview(projectId, datasetId, res.fn, SAMPLE_ROWS) : [];
  const sample: FormulaSample = { columns: known.concat(lods.map((l) => src.slice(l.start, l.end))), rows: [] };
  if (lods.length) sample.lodColumns = lods.length;
  if (!lodVals) sample.note = 'This dataset is too large to preview level-of-detail values here; they are computed when the field is saved.';
  if (page.ok) {
    page.rows.forEach((row, r) => {
      const rowMap: Record<string, FValue> = {};
      for (let i = 0; i < columnNames.length; i += 1) rowMap[columnNames[i]] = (row[i] ?? null) as FValue;
      const lodRow = lods.map((_, j) => (lodVals ? lodVals[j][r] ?? null : null));
      lods.forEach((l, j) => { rowMap[l.key] = lodRow[j]; });
      sample.rows.push({
        inputs: known.map((ref) => rowMap[ref] ?? null).concat(lodRow),
        result: res.fn.evaluate(rowMap),
      });
    });
  }

  return {
    tokens,
    ok: true,
    refs,
    unknownRefs,
    resultType: inferResultType(sample.rows.map((r) => r.result)),
    sample,
  };
}

export function register(): void {
  ipcMain.handle('formula:check', async (_e, { projectId, datasetId, expression }: any = {}): Promise<FormulaCheck> => {
    try {
      return await checkFormula(String(projectId || ''), String(datasetId || ''), String(expression ?? ''));
    } catch (err: any) {
      // A check must never reject: the editor calls it on every keystroke, and
      // an unhandled rejection there would take the panel down mid-typing.
      return emptyCheck([], err?.message || 'Could not check the formula');
    }
  });

  // r7:lod — the level-of-detail entries ride at the end, in their own category.
  ipcMain.handle('formula:functions', (): FunctionDoc[] => listFunctionDocs().concat(LOD_DOCS));
}
