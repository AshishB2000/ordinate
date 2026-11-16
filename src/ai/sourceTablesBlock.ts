// The SOURCE TABLES block (docs/assistant/00-design.md, step 4 outcome C) — PURE: no fs, no model.
// src/ipc/sourceAnswers.ts decides which tables go in (an editor's Home question, step 3's best few) and types their
// columns from the table's facts, as a Live dataset's are declared (../data/liveSchema).

import { schemaLine, sealLedger } from './copilotFacts';
import type { LedgerEntry } from './numberAudit';

/** Characters of source tables a block holds, then "(more not shown)". */
export const SOURCE_TABLES_MAX = 3000;

export interface SourceTableEntry {
  table: string;
  connection: string;
  /** False: the connection is not asked live, so the table must be copied first. */
  live: boolean;
  columns: readonly { name: string; type: string }[];
}

// No digit here: the frame adds nothing to the ledger.
const FRAMING = [
  'SOURCE TABLES — warehouse tables on the project\'s connections that no dataset is made from. An answer may name one as',
  'its "dataset" (an "sql" line among its "datasets"), exactly as written here: the app asks the warehouse live and',
  'creates nothing. Prefer a dataset above',
  'that has the columns. A table marked "copy first" is not asked live: answering from it means copying it into Ordinate.',
].join('\n');

/** `- ANALYTICS.RETURNS (on "Snowflake"): reason (text), amount (number)`. */
export function sourceTableLine(e: SourceTableEntry): string {
  return schemaLine({ name: `${e.table} (on "${e.connection}"${e.live ? '' : ', copy first'})`, columns: [...e.columns] });
}

/** The block, or '' (and no ledger) when no table is offered. */
export function sourceTablesBlock(entries: readonly SourceTableEntry[]): { text: string; ledger: LedgerEntry[] } {
  const items: string[] = [];
  let used = 0;
  for (const e of entries) {
    const line = sourceTableLine(e);
    if (used + line.length > SOURCE_TABLES_MAX) {
      items.push('- (more source tables not shown)');
      break;
    }
    used += line.length;
    items.push(line);
  }
  if (!items.length) return { text: '', ledger: [] };
  const text = [FRAMING, ...items].join('\n');
  const ledger: LedgerEntry[] = [];
  sealLedger(ledger, text, 'source tables');
  return { text, ledger };
}
