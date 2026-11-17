// What a refused answer needs an editor to add first (docs/assistant/00-design.md, outcomes C and E), as a turn keeps it
// — PURE. `needs` is the reason Ask an editor carries (`link`, `copy`); `link` the checked link an editor may approve
// (src/ipc/answerLink.ts). Stored on the assistant turn, so a reload offers the same card; whitelisted here on every
// read and write, as `suggest` is.

import { isValidId } from '../app/ids';

export interface AnswerLink {
  from: { datasetId: string; dataset: string; column: string };
  to: { datasetId: string; dataset: string; column: string };
  cardinality: 'many_to_one' | 'one_to_one';
  /** What the card says: the names normalise alike, the declared types agree, the sampled share found (a percent to one decimal), TO's key unique. */
  checks: { names: boolean; types: boolean; foundPct: number | null; unique: boolean };
  /** The counts were taken inside the date range a Live table requires: its sentence (*Last 12 months: this table needs a date range*). */
  note?: string;
  /** Why this link can't be saved here (a Live side no one engine can count with the other, src/ipc/linkLive.ts): the card offers no Approve. */
  blocked?: string;
  /** With `blocked`: the Live datasets (one end or both) whose copies would let it be saved — the card's "Make a copy". */
  copy?: string[];
}

export interface AnswerNeeds { needs?: 'link' | 'copy'; link?: AnswerLink }

const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v !== '' && v.length <= max ? v : null);

function end(raw: unknown): AnswerLink['from'] | null {
  const e = raw as Record<string, unknown> | null;
  const datasetId = e && isValidId(e.datasetId) ? String(e.datasetId) : null;
  const dataset = text(e?.dataset, 200);
  const column = text(e?.column, 512);
  return datasetId && dataset && column ? { datasetId, dataset, column } : null;
}

/** The `needs` and `link` a stored turn may carry; nothing for anything else. */
export function sanitizeNeeds(raw: unknown): AnswerNeeds {
  const o = raw as Record<string, unknown> | null;
  if (!o || (o.needs !== 'link' && o.needs !== 'copy')) return {};
  const l = o.needs === 'link' ? (o.link as Record<string, unknown> | null) : null;
  const from = end(l?.from);
  const to = end(l?.to);
  const c = l?.checks as Record<string, unknown> | null;
  const pct = c?.foundPct;
  if (!l || !from || !to || !c || (l.cardinality !== 'many_to_one' && l.cardinality !== 'one_to_one')) return { needs: o.needs };
  return {
    needs: 'link',
    link: {
      from, to, cardinality: l.cardinality,
      checks: { names: c.names === true, types: c.types === true, foundPct: typeof pct === 'number' && Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : null, unique: c.unique === true },
      ...(text(l.note, 300) ? { note: String(l.note) } : {}),
      ...(text(l.blocked, 600) ? { blocked: String(l.blocked), copy: Array.isArray(l.copy) ? [...new Set(l.copy.filter((id) => id === from.datasetId || id === to.datasetId))] : [] } : {}),
    },
  };
}
