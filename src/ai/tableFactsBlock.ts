// The TABLE FACTS block — what the warehouse's catalog says about the tables behind the Live datasets an ask is about,
// and what editors wrote about them (docs/assistant/00-design.md, step 3 "Table facts"). PURE: no fs, no model.
// src/ipc/askTableFacts.ts loads what goes in.
//
// Every figure here is the server's: the row estimate and "updated 2 h ago" are formatted from the stored facts and
// sealed into the ledger, so the model may repeat them and never computes one. A caller who may not see source names
// (a viewer, src/data/sourceNames.ts) never reads the warehouse table's name: the dataset's name stands in for it, and
// no editor-written text reaches them at all (a note can name the table loosely: "SALES", a schema, a host), only the
// structured lines. Hidden columns are left out of every list and every note.

import type { TableFacts } from '../connectors/tableFacts';
import { FENCE_RE } from '../app/instructions';
import { formatCompact } from '../app/format';
import type { LedgerEntry } from './numberAudit';
import { oneLine as cut } from './columnNotes';
import { promptJson } from './promptText';
import { sealLedger } from './copilotFacts';

/** Lines under one table's heading. */
export const TABLE_LINES = 6;
/** Characters of table entries a block holds, then "(more not shown)". */
export const TABLE_FACTS_MAX = 3000;
/** An editor's note, cut to this many characters. */
export const NOTE_MAX = 300;
const NAME_MAX = 200;

export interface TableFactsEntry {
  /** The warehouse table's name, exactly as its doc names it. Printed only when `names`. */
  table: string;
  /** The Live dataset it is the source of. */
  dataset: string;
  /** Which of the dataset's documented tables this is (1-based), and how many it has: a viewer's label tells them apart. */
  nth: number;
  of: number;
  /** The caller may see source names (seesSourceNames). */
  names: boolean;
  facts: TableFacts;
  /** Columns hidden from the caller: never named. */
  hidden: ReadonlySet<string>;
  /** The caller may count every row (no row access rule restricts them): else the size is left out. */
  rows: boolean;
  notes: { requiredFilters: string; guide: string; refresh: string };
}

const HOUR = 3_600_000;

/** "2 h ago", from a stored time; '' when it is not one. */
export function ago(at: string | undefined, now: number): string {
  const t = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(t)) return '';
  const ms = now - t;
  if (ms < HOUR) return 'under an hour ago';
  if (ms < 48 * HOUR) return `${Math.floor(ms / HOUR)} h ago`;
  return `${Math.floor(ms / (24 * HOUR))} days ago`;
}

/** The names a caller may read, or null when one of them is hidden (a key or partition with a column left out is wrong). */
function shown(cols: readonly string[] | undefined, hidden: ReadonlySet<string>, whole: boolean): string[] | null {
  if (!cols?.length) return null;
  const kept = cols.filter((c) => !hidden.has(c));
  if (!kept.length || (whole && kept.length < cols.length)) return null;
  return kept.map((c) => cut(c, NAME_MAX));
}

/** One table's entry, or '' when nothing is left to say about it. */
function entryText(e: TableFactsEntry, now: number): string {
  const f = e.facts;
  const dataset = promptJson(cut(e.dataset, NAME_MAX));
  const name = e.names ? cut(e.table, NAME_MAX) : `${dataset}, ${e.of > 1 ? `source table ${e.nth}` : 'its source table'}`;
  const head = [e.names ? `source table of ${dataset}` : ''];
  if (e.rows && f.rowEstimate !== undefined) head.push(`~${formatCompact(f.rowEstimate)} ${f.rowEstimate === 1 ? 'row' : 'rows'}`);
  const updated = ago(f.lastModified, now);
  if (updated) head.push(`updated ${updated}`);
  const lines: string[] = [];
  const key = shown(f.primaryKey?.columns, e.hidden, true);
  if (key) lines.push(`one row per ${key.join(', ')} (the table's key${f.primaryKey?.enforced ? '' : ', declared but not enforced'})`);
  const part = shown(f.partition?.columns, e.hidden, true);
  if (part) lines.push(`partitioned by ${part.join(', ')}${f.partition?.required ? ` (a filter on ${part.length > 1 ? 'them' : 'it'} is required)` : ''}`);
  const cluster = shown(f.clusterBy, e.hidden, false);
  if (cluster) lines.push(`clustered by ${cluster.join(', ')}`);
  const sort = shown(f.sortKey, e.hidden, false);
  if (sort) lines.push(`sorted by ${sort.join(', ')}`);
  // Editors' text only for a caller who sees source names (a false hide, never a leak), and never one naming a hidden column.
  const held = [...e.hidden].map((v) => v.toLowerCase()).filter(Boolean);
  const hides = (text: string): boolean => held.some((v) => text.toLowerCase().includes(v));
  const notes = e.names ? [['required filters (editor)', e.notes.requiredFilters], ['editor note', e.notes.guide], ['refreshed (editor)', e.notes.refresh]] as const : [];
  for (const [label, raw] of notes) {
    const text = cut(raw, NOTE_MAX);
    const line = `${label}: ${promptJson(text)}`;
    if (text && !hides(raw) && !FENCE_RE.test(line)) lines.push(line);
  }
  const heading = head.filter(Boolean);
  if (!lines.length && heading.length <= (e.names ? 1 : 0)) return '';
  return [`- ${name}${heading.length ? ` (${heading.join(' · ')})` : ''}`, ...lines.slice(0, TABLE_LINES).map((l) => `    ${l}`)].join('\n');
}

// No digit here: the frame adds nothing to the ledger.
const FRAMING = [
  'SOURCE TABLE FACTS — what the warehouse says about the tables behind these Live datasets (read by the app; a size is',
  'the warehouse\'s own estimate) and what editors wrote about them. Use them to choose filters and columns: a required',
  'filter must be in every answer on that dataset. An answer\'s figures still come from the app, never from these.',
].join('\n');

/** The block, or '' (and no ledger) when no entry has anything to say. */
export function tableFactsBlock(entries: readonly TableFactsEntry[], now: number): { text: string; ledger: LedgerEntry[] } {
  const items: string[] = [];
  let used = 0;
  for (const e of entries) {
    const text = entryText(e, now);
    if (!text) continue;
    if (used + text.length > TABLE_FACTS_MAX) {
      items.push('- (more source tables not shown)');
      break;
    }
    used += text.length;
    items.push(text);
  }
  if (!items.length) return { text: '', ledger: [] };
  const text = [FRAMING, ...items].join('\n');
  const ledger: LedgerEntry[] = [];
  sealLedger(ledger, text, 'tableFacts');
  return { text, ledger };
}
