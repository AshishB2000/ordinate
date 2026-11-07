// What a source table's stored facts suggest for a dataset built from it (docs/semantic-layer/02-source-tables.md):
// a column comment, the table comment, a single-column primary key. Pure: nothing here writes. A suggestion
// becomes the dataset's own only when an editor presses Use (through the existing writers).
//
// Exact names only. Where the dataset's linked tables disagree about one name (or one kind), it gets nothing.
// A dismissal is a short hash of the text, so a changed warehouse comment is offered again.

import { createHash } from 'crypto';
import type { SourceTableDoc } from '../app/sourceTables';

export type SuggestionKind = 'column' | 'table' | 'key';
export interface Suggestion { datasetId: string; kind: SuggestionKind; column?: string; text: string; hash: string; connId: string; docId: string; table: string }

export interface SuggestionInput {
  datasetId: string;
  columns: string[];
  columnDocs: Record<string, { description?: string }>;
  description: string;
  /** The dataset's table key (part 1's TableDoc.key). */
  key: string;
  /** The dataset's linked, documented tables, in sourceTablesOf order. */
  docs: { connId: string; docId: string; table: string; doc: SourceTableDoc }[];
}

type Entry = SuggestionInput['docs'][number];

export const hashOf = (text: string): string => createHash('sha256').update(text).digest('base64url').slice(0, 12);

export function suggestionsFor(i: SuggestionInput): Suggestion[] {
  const docs = i.docs.filter((d) => d.doc.facts);
  const out: Suggestion[] = [];
  // The one text every offering doc agrees on, or nothing; a dismissal in any offering doc holds.
  const settle = (kind: SuggestionKind, offers: { d: Entry; text: string }[], column?: string): void => {
    const texts = new Set(offers.map((o) => o.text));
    if (texts.size !== 1) return;
    const { d, text } = offers[0];
    const hash = hashOf(text);
    const held = offers.some((o) => {
      const x = o.d.doc.dismissed?.[i.datasetId];
      return (kind === 'column' ? x?.columns?.[column as string] : x?.[kind]) === hash;
    });
    if (!held) out.push({ datasetId: i.datasetId, kind, ...(column !== undefined ? { column } : {}), text, hash, connId: d.connId, docId: d.docId, table: d.table });
  };
  for (const column of i.columns) {
    if (i.columnDocs[column]?.description?.trim()) continue;
    const offers = docs.flatMap((d) => d.doc.facts!.columns.filter((c) => c.name === column && c.comment?.trim()).map((c) => ({ d, text: c.comment as string })));
    if (offers.length) settle('column', offers, column);
  }
  if (!i.description.trim()) settle('table', docs.filter((d) => d.doc.facts!.comment?.trim()).map((d) => ({ d, text: d.doc.facts!.comment as string })));
  if (!i.key) {
    const single = docs.flatMap((d) => { const k = d.doc.facts!.primaryKey?.columns; return k?.length === 1 && i.columns.includes(k[0]) ? [{ d, text: k[0] }] : []; });
    settle('key', single);
  }
  return out;
}
