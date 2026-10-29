// Publish, Unpublish and Discard edits — MAIN, the three writes of a dashboard's
// published copy (./publishedCopy.ts). Each records a version (src/app/versions.ts
// `event`), and none bumps the draft's `updatedAt` or its edit tag except
// Discard, which IS an edit of the draft.
//
// Publish freezes each visual card's chart into the copy (`card.visual`), read
// from the Visuals store; Discard never writes to that store — a restored visual
// card points at its chart as it is now.

import * as analysis from './analysis';
import type { Analysis } from './analysis';
import * as visuals from './visuals';
import { sanitizeCardVisual } from './dashboards';
import type { CardVisual, Page } from './dashboards';
import { copyOf, draftPatchOf, statusOf, type DashboardStatus, type PublishedCopy } from './publishedCopy';
import * as versions from '../app/versions';
import { contentTag } from '../app/editConflict';
import { recordChanged } from '../app/editConflictMessages';
import { ctx } from '../server/context';

/** What a reply says about the copy — never its sheets. */
export type PublishedMeta = Pick<PublishedCopy, 'publishedAt' | 'publishedBy' | 'versionKey'>;

export function metaOf(p: PublishedCopy | undefined): PublishedMeta | undefined {
  return p ? { publishedAt: p.publishedAt, ...(p.publishedBy ? { publishedBy: p.publishedBy } : {}), ...(p.versionKey ? { versionKey: p.versionKey } : {}) } : undefined;
}

/** `sheets` with every visual card's chart definition, as stored now, frozen into `card.visual`. A chart gone is a hole, as in the draft. */
export async function frozenSheets(projectId: string, sheets: Page[]): Promise<Page[]> {
  const defs = new Map<string, CardVisual | null>();
  const out: Page[] = [];
  for (const sheet of sheets) {
    const cards = [];
    for (const c of sheet.cards) {
      if (c.type !== 'visual' || !c.visualId) {
        cards.push(c);
        continue;
      }
      if (!defs.has(c.visualId)) {
        const v = await visuals.getVisual(projectId, c.visualId);
        defs.set(c.visualId, v ? sanitizeCardVisual(v) : null);
      }
      const def = defs.get(c.visualId);
      cards.push(def ? { ...c, visual: def } : c);
    }
    out.push({ ...sheet, cards });
  }
  return out;
}

/** The signed-in publisher, as a version's `by` is kept. */
function publisher(): string | undefined {
  try {
    const email = ctx().user.email;
    return email && email !== 'desktop' ? email : undefined;
  } catch (_) {
    return undefined;
  }
}

/**
 * Publish the draft as stored. `base`: the editor's content tag — a draft that moved since they saw it is refused
 * untouched (ERECORDCHANGED, the route's 409), so what goes live is what they looked at. Null when the record is gone.
 */
export async function publish(projectId: string, id: string, base?: unknown): Promise<{ analysis: Analysis; status: DashboardStatus } | null> {
  let done = null as Analysis | null; // set inside the hold
  await analysis.patchStored(projectId, id, async (stored) => {
    const tag = contentTag('dashboard', stored);
    if (base !== undefined && base !== null && base !== tag) throw Object.assign(new Error(recordChanged('dashboard')), { code: 'ERECORDCHANGED', tag });
    const draft = await analysis.getStoredAnalysis(projectId, id);
    if (!draft) return false;
    const version = await versions.record(projectId, 'dashboard', draft, { event: 'published' });
    const copy: PublishedCopy = {
      ...copyOf(draft, new Date().toISOString(), publisher()),
      sheets: await frozenSheets(projectId, draft.sheets),
      ...(version ? { versionKey: version.key } : {}),
    };
    stored.published = copy;
    delete stored.ready;
    done = { ...draft, published: copy };
    return true;
  });
  return done ? { analysis: done, status: statusOf(done) } : null;
}

/** Off the Dashboards page for viewers; the draft stays as it is. Idempotent: a draft is left alone, unversioned. */
export async function unpublish(projectId: string, id: string): Promise<{ analysis: Analysis; status: DashboardStatus } | null> {
  let changed = false as boolean; // set inside the hold
  const stored = await analysis.patchStored(projectId, id, async (s) => {
    changed = s.published !== undefined || s.ready !== undefined;
    delete s.published;
    delete s.ready;
    return changed;
  });
  if (!stored) return null;
  const a = await analysis.getStoredAnalysis(projectId, id);
  if (!a) return null;
  if (changed) await versions.record(projectId, 'dashboard', a, { event: 'unpublished' });
  return { analysis: a, status: statusOf(a) };
}

/**
 * Discard edits: the draft becomes the published copy again — layout, filters, text, KPIs, style, parameters. Visual
 * cards keep their `visualId` and draw the chart as it is now. A draft never published has nothing to go back to
 * (`'draft'`); null when the record is gone.
 */
export async function discard(projectId: string, id: string): Promise<{ analysis: Analysis; status: DashboardStatus } | 'draft' | null> {
  return analysis.lockedAnalysis(projectId, id, async () => {
    const before = await analysis.getStoredAnalysis(projectId, id);
    if (!before) return null;
    if (!before.published) return 'draft';
    const updated = await analysis.updateAnalysis(projectId, id, draftPatchOf(before.published));
    if (!updated) return null;
    await versions.record(projectId, 'dashboard', updated, { before, event: 'discarded' });
    return { analysis: updated, status: statusOf(updated) };
  });
}
