// The renames a change of prepare steps makes, as Autopilot's rename log wants them (src/server/autopilot/renames.ts).
// A rename_column step that is NEW in `after` renames from to; one that is GONE (the editor removed it, a plan replaced the list, a
// version restore went back) undoes a rename, so it is logged reversed (to to from). Steps are compared as from|to pairs, so
// moving a step is not a rename.

import type { Rename } from '../server/autopilot/renames';

const pairs = (steps: readonly unknown[] | undefined): Array<[string, string]> =>
  (steps ?? []).flatMap((s) => {
    const st = s as { type?: unknown; from?: unknown; to?: unknown } | null;
    return st && st.type === 'rename_column' && typeof st.from === 'string' && typeof st.to === 'string' ? [[st.from, st.to] as [string, string]] : [];
  });

/** `before` to `after`: the added rename steps, then the removed ones reversed. */
export function stepRenameChanges(before: readonly unknown[] | undefined, after: readonly unknown[] | undefined): Rename[] {
  const left = pairs(before);
  const out: Rename[] = [];
  const rest = [...left];
  for (const [from, to] of pairs(after)) {
    const i = rest.findIndex(([f, t]) => f === from && t === to);
    if (i >= 0) rest.splice(i, 1); // in both: unchanged
    else out.push({ from, to, kind: 'step' });
  }
  for (const [from, to] of rest) out.push({ from: to, to: from, kind: 'step' });
  return out;
}
