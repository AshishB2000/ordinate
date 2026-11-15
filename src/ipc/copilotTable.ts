// An open dataset's table, as the Assistant's facts take it (./copilot `buildFacts`) — MAIN PROCESS.
//
// The column summaries, the quality issues and the first rows, off the stored Parquet (../engine/statsResident, as
// the Data page's `dataset:stats`): a question never loads the table (docs/assistant/00-design.md, "Scale rules").
// `hydratedTable` is the reference the resident read is held to (scripts/test-askDatasetFacts.ts, Object.is), and the
// fallback when it returns null. Both leave the caller's hidden columns out before anything reads a value (part 4, D21).

import * as datasets from '../data/datasets';
import { withoutColumns } from '../data/columnAccess';
import { computeColumnSummary, findQualityIssues, type ColumnSummary, type QualityIssue } from '../data/datasetStats';
import { computeColumnSummariesResident, findQualityIssuesResident, sampleRowsResident } from '../engine/statsResident';
import * as trace from '../engine/residentTrace';
import { SAMPLE_ROWS } from '../ai/copilotFacts';

export interface FactTable {
  /** The record without the hidden columns; `rows` are what the facts show of it (the resident read: the first SAMPLE_ROWS). */
  ds: datasets.Dataset;
  summaries: ColumnSummary[];
  issues: QualityIssue[];
}

/** Off the Parquet, reading no row into the app; null — never "no data" — when the resident path cannot answer. */
export async function residentTable(projectId: string, id: string, hidden: ReadonlySet<string>): Promise<FactTable | null> {
  const src = await datasets.residentSource(projectId, id);
  const meta = src && (await datasets.getDatasetMeta(projectId, id));
  if (!src || !meta) {
    trace.record('copilotFacts', 'skipped');
    return null;
  }
  const at = src.columns.flatMap((c, i) => (hidden.has(c.name) ? [] : [i]));
  const shown = { parquetPath: src.parquetPath, columns: at.map((i) => src.columns[i]), positions: at };
  const summaries = await computeColumnSummariesResident(shown);
  const issues = summaries && (await findQualityIssuesResident(shown));
  const rows = issues && (await sampleRowsResident(shown, SAMPLE_ROWS));
  if (!summaries || !issues || !rows) {
    trace.record('copilotFacts', 'failed', `${shown.columns.length} cols`);
    return null;
  }
  trace.record('copilotFacts', 'resident');
  return { ds: { ...meta, columns: shown.columns, rows }, summaries, issues };
}

/** The reference: the whole table hydrated, the hidden columns dropped, then the pure datasetStats helpers. */
export async function hydratedTable(projectId: string, id: string, hidden: ReadonlySet<string>): Promise<FactTable | null> {
  const whole = await datasets.getDataset(projectId, id);
  const ds = whole && withoutColumns(whole, hidden);
  if (!ds) return null;
  const summaries = ds.columns.map((col, c) => computeColumnSummary(col, ds.rows.map((row) => (row ? row[c] ?? null : null))));
  return { ds, summaries, issues: findQualityIssues(ds.columns, ds.rows) };
}
