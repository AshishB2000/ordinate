// The LINKED DATASETS block (docs/assistant/00-design.md, step 3 "Follow the links") — PURE: no fs, no model.
// src/ipc/askLinks.ts decides which datasets go in and what the caller may read of them.
//
// Each linked dataset is listed as the facts list a dataset (./copilotFacts schemaLine), with the links that reach it.
// The block says what a linked dataset is for: an answer of its own, or the category, split, a measure or a filter of one
// on the dataset it is linked to, which the chart door joins (./answerJoin).

import { schemaLine, sealLedger, type FactSchema } from './copilotFacts';
import type { LedgerEntry } from './numberAudit';

/** Characters of linked datasets a block holds, then "(more not shown)". */
export const LINKED_FACTS_MAX = 3000;

/** One link walked, from the side already in the facts to the side it adds. */
export interface LinkHop { from: { dataset: string; column: string }; to: { dataset: string; column: string } }

export interface LinkedEntry { schema: FactSchema; base: string; hops: readonly LinkHop[] }

// No digit here: the frame adds nothing to the ledger.
const FRAMING = [
  'LINKED DATASETS — linked in Relationships to a dataset above, followed only from the many side to the one side, so',
  'each row there has at most one row here. An answer on the dataset above may take its category, split, a measure or a',
  'filter (not a relative period) from one of these, naming it: "categoryDataset", "seriesDataset", or "dataset" inside',
  'that measure or filter. A measure here is counted once per row here, never once per row above it.',
].join('\n');

const hopText = (h: LinkHop): string => `${h.from.dataset}.${h.from.column} → ${h.to.dataset}.${h.to.column}`;

/** `- Customers (linked to Orders via Orders.customer_id → Customers.id): id (text), region (text)`. */
export function linkedLine(e: LinkedEntry): string {
  return schemaLine({ ...e.schema, name: `${e.schema.name} (linked to ${e.base} via ${e.hops.map(hopText).join(', then ')})` });
}

/** The block, or '' (and no ledger) when nothing is linked. */
export function linkedBlock(entries: readonly LinkedEntry[]): { text: string; ledger: LedgerEntry[] } {
  const items: string[] = [];
  let used = 0;
  for (const e of entries) {
    const line = linkedLine(e);
    if (used + line.length > LINKED_FACTS_MAX) {
      items.push('- (more linked datasets not shown)');
      break;
    }
    used += line.length;
    items.push(line);
  }
  if (!items.length) return { text: '', ledger: [] };
  const text = [FRAMING, ...items].join('\n');
  const ledger: LedgerEntry[] = [];
  sealLedger(ledger, text, 'linked');
  return { text, ledger };
}
