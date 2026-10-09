// The Assistant's facts for a LIVE dataset (docs/live-data/00-plan.md L2.4) —
// MAIN PROCESS, PURE.
//
// The extract's facts (./copilotFacts.datasetFacts) are statistics over the
// stored rows: a row count, per-column min/max/mean, quality notes, sample rows.
// A Live dataset stores none of those — its warehouse answers each question —
// so these facts are its SCHEMA (the names an answer spec must use), the user's
// column notes and the defined metrics, whose figures the warehouse gave and
// which enter the ledger like any other. The model then answers a question with
// an `answer` action, which the app asks the warehouse (ipc/liveAnswers.ts).
// Never a row count: a Live dataset has no stored rows, and "0 rows" would be a
// confident wrong figure.
//
// L2.5 (the profile) adds the sample values and distinct counts here.

import type { ParsedColumn } from '../data/parse';
import type { LedgerEntry } from './numberAudit';
import type { CopilotFacts } from './copilot';
import { GUARD_LINE, columnNoteLines, metricLines, num, sealLedger } from './copilotFacts';
import type { FactColumnDoc, FactMetric } from './copilotFacts';

export function liveDatasetFacts(
  ds: { name: string; columns: ParsedColumn[] },
  metrics: FactMetric[] = [],
  columnDocs: Record<string, FactColumnDoc> = {},
): CopilotFacts {
  const lines: string[] = [GUARD_LINE, ''];
  const ledger: LedgerEntry[] = [];
  lines.push(`Dataset: "${ds.name}" (${ds.columns.length} columns) — a LIVE dataset: its warehouse answers each question when it is asked, so no row counts, statistics or sample rows are listed here.`);
  num(ledger, 'column count', ds.columns.length, 'count', 'dataset');
  lines.push('');
  lines.push('Columns (name and type — use these exact names in an answer spec):');
  for (const c of ds.columns) lines.push(`- ${c.name} (${c.type})`);
  columnNoteLines(lines, columnDocs);
  metricLines(lines, ledger, metrics);
  lines.push('');
  lines.push('A question answerable from these columns can be answered with an "answer" action; the app asks the warehouse for the figures.');
  const text = lines.join('\n');
  sealLedger(ledger, text, 'dataset');
  return {
    text,
    ledger,
    provenance: { kind: 'dataset', name: ds.name, columns: ds.columns.map((c) => c.name), note: 'schema only — figures come live from the warehouse' },
  };
}
