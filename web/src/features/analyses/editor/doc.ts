// The open dashboard as an editable document, with undo / redo (legacy
// dashHistory.ts + markDashDirty): every edit is a labelled step; typing in
// one field within a second is ONE step (coalesced), not one per key. The
// saved part is `Doc` — name, sheets, dashboard filters, parameters — and the
// autosave sends exactly it. Pure: no React, no RPC.

import type { Analysis, Card, Parameter, Sheet, Step } from '../api';

export interface Doc {
  name: string;
  sheets: Sheet[];
  filters: Step[];
  parameters: Parameter[];
  /** The dashboard's look (T2.9 Style): saved with the record, undoable like any edit. */
  style: Record<string, unknown>;
}

export interface History {
  doc: Doc;
  past: { doc: Doc; label: string }[];
  future: { doc: Doc; label: string }[];
  /** The last edit's label and time, for coalescing. */
  last: { label: string; at: number } | null;
  /** Bumped by every change to `doc` — the autosave's trigger. */
  version: number;
}

/** Keystrokes in one field closer together than this are one undo step (DASH_HIST_COALESCE_MS). */
export const COALESCE_MS = 1000;
const MAX_STEPS = 100;

export function fromAnalysis(a: Analysis): Doc {
  return { name: a.name, sheets: a.sheets, filters: a.filters ?? [], parameters: a.parameters ?? [], style: a.style ?? {} };
}

export const initial = (doc: Doc): History => ({ doc, past: [], future: [], last: null, version: 0 });

export type Action =
  | { type: 'edit'; label: string; mutate: (d: Doc) => void; coalesce?: boolean; now?: number }
  | { type: 'undo' }
  | { type: 'redo' };

export function reduce(h: History, a: Action): History {
  if (a.type === 'undo') {
    const prev = h.past[h.past.length - 1];
    if (!prev) return h;
    return { doc: prev.doc, past: h.past.slice(0, -1), future: [{ doc: h.doc, label: prev.label }, ...h.future], last: null, version: h.version + 1 };
  }
  if (a.type === 'redo') {
    const next = h.future[0];
    if (!next) return h;
    return { doc: next.doc, past: [...h.past, { doc: h.doc, label: next.label }], future: h.future.slice(1), last: null, version: h.version + 1 };
  }
  const draft = structuredClone(h.doc);
  a.mutate(draft);
  if (JSON.stringify(draft) === JSON.stringify(h.doc)) return h;
  const now = a.now ?? Date.now();
  const merge = !!a.coalesce && !!h.last && h.last.label === a.label && now - h.last.at < COALESCE_MS && h.past.length > 0;
  const past = merge ? h.past : [...h.past, { doc: h.doc, label: a.label }].slice(-MAX_STEPS);
  return { doc: draft, past, future: [], last: { label: a.label, at: now }, version: h.version + 1 };
}

// ── Lookups and small edits on a Doc draft ──────────────────────────────

export function sheetOf(d: Doc, index: number): Sheet {
  return d.sheets[Math.max(0, Math.min(d.sheets.length - 1, index))];
}

export function cardIn(d: Doc, sheet: number, id: string | null): Card | undefined {
  return id ? sheetOf(d, sheet).cards.find((c) => c.id === id) : undefined;
}

/** Every control card on every sheet — controls filter the whole dashboard (dashboards.ts effectiveFilters). */
export function allControls(d: Doc): Card[] {
  return d.sheets.flatMap((s) => s.cards.filter((c) => c.type === 'control' && c.control));
}

/** "Sheet 2", "Sheet 3", … — the first name no sheet has. */
export function nextSheetName(d: Doc): string {
  const names = new Set(d.sheets.map((s) => s.name));
  let n = d.sheets.length + 1;
  while (names.has(`Sheet ${n}`)) n++;
  return `Sheet ${n}`;
}

export const uuid = (): string => crypto.randomUUID();
