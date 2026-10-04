// A column rename / retype, resolved BY NAME (T2.6; the open item T2.3 logged).
//
// Every client sends the edit indexed against the columns it SHOWS — the
// prepared (post-pipeline) columns. updateDataset used to apply that array by
// position to the stored base, which for a dataset with prepare steps is the
// immutable SOURCE: a step that adds, drops or reorders a column shifts every
// index after it, so "rename column 3" renamed some other column. Here each
// changed column is found by its current name instead:
//
//   - a column the source has (by that name)  → edited in the source, as before
//     (renames and retypes survive every recompute) — except a RENAME of a
//     column a step names, which would leave that step reading a column that is
//     gone: that rename becomes a `rename_column` step at the end instead;
//   - a column a step made or renamed          → a rename becomes a
//     `rename_column` step appended to the pipeline; a retype is refused with
//     the reason (there is no source column to retype — change the step).
//
// With no pipeline the shown columns ARE the stored ones, and the result is the
// old by-position edit exactly.

import type { ParsedColumn } from './parse';
import type { TransformStep } from './transforms';

export class ColumnEditError extends Error {}

const TYPES = new Set(['text', 'number', 'date']);

export function resolveColumnEdit(
  shown: readonly ParsedColumn[],
  base: readonly ParsedColumn[],
  incoming: readonly unknown[],
  /** The pipeline, or null when there is none (then shown === base, by position). */
  steps: readonly unknown[] | null,
): { columns: ParsedColumn[]; addSteps: TransformStep[] } {
  const stepped = steps !== null;
  // Does any step mention the name — a field value or inside a formula ([col] or a bare col)?
  // ponytail: a whole-word match over the steps' JSON; a false hit only costs a rename step instead of a source rename.
  const text = JSON.stringify(steps ?? []);
  const named = (col: string): boolean =>
    new RegExp(`(^|[^A-Za-z0-9_])${col.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_])`).test(text);
  const columns = base.map((c) => ({ ...c }));
  const addSteps: TransformStep[] = [];
  shown.forEach((cur, i) => {
    const next = incoming[i] as Partial<ParsedColumn> | undefined;
    if (!next || typeof next !== 'object') return;
    const name = typeof next.name === 'string' && next.name.trim() ? next.name.trim() : cur.name;
    const type = TYPES.has(String(next.type)) ? (next.type as ParsedColumn['type']) : cur.type;
    if (name === cur.name && type === cur.type) return;
    // No pipeline: shown === base, by position (an input table's duplicate-free names make this the same column).
    const at = stepped ? columns.findIndex((c) => c.name === cur.name) : i;
    if (at >= 0 && at < columns.length) {
      const keepName = stepped && name !== cur.name && named(cur.name);
      columns[at] = { ...columns[at], name: keepName ? cur.name : name, type }; // keeps an input table's required/lookup
      if (keepName) addSteps.push({ type: 'rename_column', from: cur.name, to: name } as TransformStep);
      return;
    }
    if (type !== cur.type) {
      throw new ColumnEditError(`"${cur.name}" is made by a prepare step, so its type comes from that step — change the step instead.`);
    }
    addSteps.push({ type: 'rename_column', from: cur.name, to: name } as TransformStep);
  });
  return { columns, addSteps };
}
