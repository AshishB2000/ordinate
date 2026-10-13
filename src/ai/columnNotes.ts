// The user's COLUMN NOTES as a model reads them — PURE: no fs, no model.
//
// Split out of ./copilotFacts.ts near its size cap (.claude/rules/file-size.md).
// One format for a column's catalog notes (src/app/catalog.ts), shared by every
// facts block that prints them: the dataset, visual and project facts
// (./copilotFacts), a Live dataset's (./liveFacts) and the dashboard draft's
// (src/analysis/planFacts.ts).

/** A column's catalog notes, as the Assistant needs them (src/app/catalog.ts). */
export interface FactColumnDoc { description?: string; displayName?: string; aliases?: string[]; sensitivity?: string }

/**
 * What people call the column: `called "Net Amount"`, `also called "sales",
 * "revenue"`. These are the names a question may use and an answer spec may be
 * written in — src/ai/answerSpec.ts resolves both to the real column. They are
 * names a person wrote, not values of the column, so a personal or financial
 * mark withholds nothing here.
 */
export function columnNameBits(d: FactColumnDoc): string[] {
  const bits: string[] = [];
  if (d.displayName) bits.push(`called "${d.displayName}"`);
  if (d.aliases && d.aliases.length) bits.push(`also called ${d.aliases.map((a) => `"${a}"`).join(', ')}`);
  return bits;
}

/**
 * The user's OWN notes on columns — what a column means, what they call it,
 * whether it is personal or financial — so an answer uses their words. Words,
 * not figures: a digit a note happens to contain reaches the ledger through
 * sealLedger, exactly like a digit in a dataset name.
 */
export function columnNoteLines(lines: string[], docs: Record<string, FactColumnDoc>, only?: string[]): void {
  const notes: string[] = [];
  for (const name of Object.keys(docs || {})) {
    if (only && only.indexOf(name) < 0) continue;
    const d = docs[name] || {};
    const bits = columnNameBits(d);
    if (d.description) bits.push(d.description);
    if (d.sensitivity && d.sensitivity !== 'none') bits.push(`${d.sensitivity} data; sample values withheld`);
    if (bits.length) notes.push(`- ${name}: ${bits.join('; ')}`);
  }
  if (!notes.length) return;
  lines.push('');
  lines.push('Column notes (written by the user) — use these names and meanings for these columns:');
  lines.push(...notes);
}

/** What a withheld value prints as. */
export const WITHHELD = '(withheld)';

/**
 * The columns whose VALUES the model is never shown: the ones the user marked
 * personal or financial. Their statistics (counts, min/max/mean) stay — those
 * are the app's aggregates, and the number ledger covers them unchanged — but
 * a sample cell, a most-common value or a chart label drawn from one is
 * replaced by WITHHELD, and the facts say so.
 */
export function withheldColumns(docs: Record<string, FactColumnDoc>): Set<string> {
  return new Set(Object.keys(docs || {}).filter((k) => {
    const s = docs[k] && docs[k].sensitivity;
    return s === 'personal' || s === 'financial';
  }));
}
