// A dashboard's PUBLISHED COPY — MAIN, pure
// (docs/superpowers/specs/2026-10-29-dashboard-drafts-publish-design.md).
//
// Every dashboard is a DRAFT its editors change; viewers see only what was last
// PUBLISHED. Publish freezes a copy inside the record (`Analysis.published`):
// the content an editor's save writes (name, sheets, filters, style,
// parameters — recordDiff.SAVE_KEYS) with each visual card's chart DEFINITION
// copied into its inline `card.visual`, so a later edit in Visuals reaches
// viewers only through the next Publish. No figure is stored: every number is
// recomputed on render, through the frozen definition.
//
// Saved views are NOT frozen. They are a reader's state, outside the content
// (no version, not in the edit tag), so the copy's readers get the record's
// views re-checked against the copy's sheets.
//
// Status compares the draft's content tag with the one taken at Publish, so
// undoing back to the published state reads as in sync. A chart edited in
// Visuals does not move it: the draft points at the chart, and Discard could
// not undo that edit (it never writes to the shared Visuals store).

import type { Analysis } from './analysis';
import type { Visual } from './visuals';
import { sanitizeDashboardFilters, sanitizePages, sanitizeStyle } from './dashboards';
import type { Card, DashboardStyle, Page } from './dashboards';
import { sanitizeParameters } from './params';
import type { Parameter } from './params';
import { sanitizeDefaultViewId, sanitizeViews } from './savedViews';
import type { FilterStep } from '../data/transforms';
import { contentTag } from '../app/editConflict';

export interface PublishedCopy {
  name: string;
  /** Visual cards keep `visualId` and carry their chart's definition, frozen, as `visual`. */
  sheets: Page[];
  filters: FilterStep[];
  style: DashboardStyle;
  parameters: Parameter[];
  publishedAt: string;
  /** The publisher's email; absent on a copy made from a Ready dashboard (the migration). */
  publishedBy?: string;
  /** The version recorded at Publish (src/app/versions.ts): `versions:diff` from it to now. Absent once unknown. */
  versionKey?: string;
  /** contentTag('dashboard', draft) at Publish. */
  contentHash: string;
}

/** never published · published and the draft is what was published · published, and the draft has moved since. */
export type DashboardStatus = 'draft' | 'published' | 'edited';

const VERSION_KEY_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d{1,3})?$/;

/** Whitelist a stored (untrusted) copy, as normalize() does every other field. Anything unusable → none. */
export function sanitizePublished(raw: unknown, mint: () => string): PublishedCopy | undefined {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!o || typeof o.contentHash !== 'string' || !o.contentHash || typeof o.publishedAt !== 'string' || !Number.isFinite(Date.parse(o.publishedAt))) return undefined;
  return {
    name: typeof o.name === 'string' && o.name.trim() ? o.name : 'Untitled dashboard',
    sheets: sanitizePages(o.sheets),
    filters: sanitizeDashboardFilters(o.filters),
    style: sanitizeStyle(o.style),
    parameters: sanitizeParameters(o.parameters, mint),
    publishedAt: o.publishedAt,
    ...(typeof o.publishedBy === 'string' && o.publishedBy ? { publishedBy: o.publishedBy.slice(0, 320) } : {}),
    ...(typeof o.versionKey === 'string' && VERSION_KEY_RE.test(o.versionKey) ? { versionKey: o.versionKey } : {}),
    contentHash: o.contentHash.slice(0, 100),
  };
}

/** The content an editor's save writes, as a copy of `a` (charts not frozen — the caller does that). */
export function copyOf(a: Analysis, at: string, by: string | undefined): PublishedCopy {
  return {
    name: a.name, sheets: a.sheets, filters: a.filters, style: a.style, parameters: a.parameters,
    publishedAt: at, ...(by ? { publishedBy: by } : {}), contentHash: contentTag('dashboard', a),
  };
}

export function statusOf(a: Analysis): DashboardStatus {
  if (!a.published) return 'draft';
  return contentTag('dashboard', a) === a.published.contentHash ? 'published' : 'edited';
}

/**
 * The record as its viewers read it: the copy's content in the draft's place, `updatedAt` the Publish time, the
 * saved views checked against the copy's sheets, and no copy inside it. Null when it was never published.
 */
export function asPublished(a: Analysis): Analysis | null {
  const p = a.published;
  if (!p) return null;
  const { published: _copy, ...rest } = a;
  const out: Analysis = { ...rest, name: p.name, sheets: p.sheets, filters: p.filters, style: p.style, parameters: p.parameters, updatedAt: p.publishedAt };
  out.views = sanitizeViews(a.views, out);
  out.defaultViewId = sanitizeDefaultViewId(a.defaultViewId, out.views);
  return out;
}

/** What a send, a published page or an embed renders: the published copy, or — only an editor reaches a draft's — the draft. */
export function audienceCopy(a: Analysis): Analysis {
  return asPublished(a) ?? a;
}

/** A copy's frozen chart as a Visual record under its card's `visualId`, for code that reads charts by id. Null on a draft's card. */
export function visualOfCard(projectId: string, c: Card, at: string): Visual | null {
  return c.visual ? { ...c.visual, id: c.visualId || '', projectId, favorite: false, createdAt: at, updatedAt: at, schemaVersion: 2 } : null;
}

/** A card of the copy as the draft holds it: a visual card points at its chart again (the frozen definition dropped). */
function unfrozen(c: Card): Card {
  if (c.type !== 'visual' || !c.visualId || !c.visual) return c;
  const { visual: _frozen, ...card } = c;
  return card;
}

/** Discard edits: the copy's content as an `updateAnalysis` patch. Never a write to the Visuals store. */
export function draftPatchOf(p: PublishedCopy): { name: string; sheets: Page[]; filters: FilterStep[]; style: DashboardStyle; parameters: Parameter[] } {
  return { name: p.name, sheets: p.sheets.map((s) => ({ ...s, cards: s.cards.map(unfrozen) })), filters: p.filters, style: p.style, parameters: p.parameters };
}
