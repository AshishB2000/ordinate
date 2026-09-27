// The compact FACTS block the three dataset prompts share — dataset:explain,
// dataset:suggestSteps and dataset:suggestCalcField (src/ipc/datasets.ts).
//
// Every number here is app-computed (datasetStats), embedded as a FACT — the
// model narrates from these and never recomputes. Kept small (column stats +
// up to 5 sample rows) so it fits comfortably in a single prompt.
//
// Moved out of ipc/datasets.ts (at its line cap) when it learned to withhold:
// a column the user marked personal or financial keeps its statistics, but its
// most-common value and its sample cells print as "(withheld)", and the block
// says so — the same rule copilotFacts.datasetFacts follows for the Assistant.

import type { ParsedColumn } from '../data/parse';
import type { ColumnSummary, QualityIssue } from '../data/datasetStats';

const WITHHELD = '(withheld)';

// Takes METADATA, not a Dataset: it only ever reads name/rowCount/columns plus
// a 5-row sample, so the caller can supply that from a bounded read
// (statsResident.sampleRowsResident) instead of hydrating the whole table.
export function buildDatasetSummaryText(
  ds: { name: string; rowCount: number; columns: ParsedColumn[] },
  summaries: ColumnSummary[],
  issues: QualityIssue[],
  sample: (string | number | null)[][],
  withheld: ReadonlySet<string> = new Set(),
): string {
  const lines: string[] = [];
  lines.push(`Dataset: "${ds.name}" (${ds.rowCount} rows, ${ds.columns.length} columns).`);
  lines.push('');
  lines.push('Columns and computed statistics:');
  summaries.forEach((s) => {
    if (s.type === 'number') {
      const parts: string[] = [];
      if (typeof s.min === 'number') parts.push(`min ${s.min}`);
      if (typeof s.max === 'number') parts.push(`max ${s.max}`);
      if (typeof s.mean === 'number') parts.push(`mean ${s.mean}`);
      parts.push(`${s.count ?? 0} numeric values`, `${s.nonEmpty} non-empty`);
      lines.push(`- ${s.name} (number): ${parts.join(', ')}`);
    } else {
      const parts: string[] = [`${s.distinct ?? 0} distinct`, `${s.nonEmpty} non-empty`];
      if (s.mostCommon) {
        parts.push(withheld.has(s.name)
          ? `most common value ${WITHHELD} (${s.mostCommon.count}x)`
          : `most common "${s.mostCommon.value}" (${s.mostCommon.count}x)`);
      }
      lines.push(`- ${s.name} (${s.type}): ${parts.join(', ')}`);
    }
  });
  if (issues.length > 0) {
    lines.push('');
    lines.push('Data-quality notes:');
    issues.forEach((i) => lines.push(`- ${i.detail}`));
  }
  if (sample.length > 0) {
    lines.push('');
    lines.push(`Sample rows (first ${sample.length}):`);
    const hidden = ds.columns.filter((c) => withheld.has(c.name)).map((c) => c.name);
    if (hidden.length) lines.push(`(Values of ${hidden.join(', ')} are withheld — marked personal or financial data.)`);
    lines.push(ds.columns.map((c) => c.name).join(' | '));
    sample.forEach((row) => {
      lines.push(ds.columns
        .map((col, c) => (withheld.has(col.name) ? WITHHELD : row && row[c] != null ? String(row[c]) : ''))
        .join(' | '));
    });
  }
  return lines.join('\n');
}
