// Glossary terms for the Assistant (semantic D10, D12) — MAIN, PURE: no fs, no model.
//
// The FACTS list the context dataset's terms, so "revenue for EMEA" can be asked as the filter
// {"term":"EMEA"}; the answer spec resolves the word to the term's id (`matchTerm`) and the answer door
// expands it (../analysis/termExpand). A term line holds no figure, so it adds nothing to the ledger;
// its definition is written without values for a caller they are hidden from.

import { squash } from '../app/columnNames';

/** A term an answer spec may name. */
export interface SpecTerm {
  id: string;
  name: string;
  aliases: string[];
  datasetId: string;
}

/** A term as the FACTS state it. `definition` is already worded (and redacted) by the caller. */
export interface FactTerm {
  name: string;
  aliases: string[];
  description?: string;
  definition: string;
}

/**
 * The term `said` means: its id, else its name or an alias equal ignoring case, else equal squashed
 * (../app/columnNames squash). Each pass must be unambiguous — a word two terms answer to means neither.
 */
export function matchTerm(said: unknown, terms: readonly SpecTerm[]): SpecTerm | null {
  if (typeof said !== 'string' || !said.trim()) return null;
  const byId = terms.find((t) => t.id === said);
  if (byId) return byId;
  const n = said.trim().toLowerCase();
  const key = squash(n);
  const pass = (same: (name: string) => boolean): SpecTerm[] => terms.filter((t) => [t.name, ...t.aliases].some(same));
  const exact = pass((x) => x.trim().toLowerCase() === n);
  if (exact.length === 1) return exact[0];
  const loose = key ? pass((x) => squash(x) === key) : [];
  return loose.length === 1 ? loose[0] : null;
}

/** "Glossary terms — …" and one line per term: its name, what else it is called, its filters in words, its description. */
export function termLines(lines: string[], terms: readonly FactTerm[]): void {
  if (!terms.length) return;
  lines.push('');
  lines.push('Glossary terms — filter by one with {"term":"<name>"}:');
  for (const t of terms) {
    const also = t.aliases.length ? ` (also called ${t.aliases.map((a) => JSON.stringify(a)).join(', ')})` : '';
    lines.push(`- ${JSON.stringify(t.name)}${also}: ${t.definition}${t.description ? ` — ${JSON.stringify(t.description)}` : ''}`);
  }
}
