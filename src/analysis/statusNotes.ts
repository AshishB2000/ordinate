// What the Assistant and MCP do with an item's status (semantic layer part 4, D9/D10) — MAIN. The order of a
// vocabulary and the omission of a retired item are code, never a model's choice; a retired item still computes (D6).

import { nameOf, statusFor, type StatusState } from './statusStore';
import * as msg from './statusMessages';

const isLetter = (c: string | undefined): boolean => !!c && c.toLowerCase() !== c.toUpperCase();

/** Whether the question contains one of `names` (a name or alias), case-insensitive and bounded by non-letters. */
export function namedIn(question: string | undefined, names: readonly string[]): boolean {
  if (!question) return false;
  const q = question.toLowerCase();
  return names.some((raw) => {
    const n = raw.trim().toLowerCase();
    if (!n) return false;
    for (let i = q.indexOf(n); i >= 0; i = q.indexOf(n, i + 1)) {
      if (!isLetter(q[i - 1]) && !isLetter(q[i + n.length])) return true;
    }
    return false;
  });
}

/** Certified first, then the rest in their order, then the retired ones `keepRetired` allows. Stable. */
export function vocabularyOrder<T extends { status?: { state: StatusState } }>(items: T[], keepRetired: (t: T) => boolean): T[] {
  const of = (s: StatusState): T[] => items.filter((i) => i.status?.state === s);
  const rest = items.filter((i) => i.status?.state !== 'certified' && i.status?.state !== 'retired');
  return [...of('certified'), ...rest, ...of('retired').filter(keepRetired)];
}

/** "Gross revenue is retired; Net revenue replaces it." for each retired ref, in the app's words. */
export async function retiredNotes(projectId: string, refs: readonly string[]): Promise<string[]> {
  const status = statusFor(projectId);
  const out: string[] = [];
  for (const ref of new Set(refs)) {
    const s = await status(ref);
    if (s?.state !== 'retired') continue;
    const name = (await nameOf(projectId, ref)) ?? '';
    out.push(s.replacedBy ? msg.retiredUse(name, s.replacedBy.name) : msg.retiredBare(name));
  }
  return out;
}
