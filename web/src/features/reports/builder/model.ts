// The builder's edits to a report, pure (reportBuilder.ts rbReadSettings and
// the page-list handlers). The server re-sanitizes everything on save
// (reportSpec.sanitize*); these only keep the in-memory copy coherent.

import type { PageKind, Report, ReportPage } from '../api';

export const KIND_LABEL: Record<PageKind, string> = {
  cover: 'Cover', summary: 'Summary', sheet: 'Sheet', tile: 'Tile', notes: 'Notes', narrative: 'Narrative', discussion: 'Discussion', scorecard: 'Scorecard',
};

const newPage = (kind: PageKind, extra: Partial<ReportPage> = {}): ReportPage => ({ id: crypto.randomUUID(), kind, include: true, layout: 'full', ...extra });

/**
 * Settings that are PAGES: Narrative adds or removes its page; Discussion is
 * always the LAST page (reportDiscussion.ts). Everything else is a field.
 */
export function withSettings(r: Report, patch: Partial<Report>): Report {
  const next: Report = { ...r, ...patch };
  let pages = next.pages.slice();
  const hasNarrative = pages.some((p) => p.kind === 'narrative');
  if (next.narrative && !hasNarrative) pages.push(newPage('narrative'));
  if (!next.narrative && hasNarrative) pages = pages.filter((p) => p.kind !== 'narrative');
  const discussion = pages.find((p) => p.kind === 'discussion');
  pages = pages.filter((p) => p.kind !== 'discussion');
  if (next.discussion) pages.push(discussion || newPage('discussion'));
  next.pages = pages;
  return next;
}

export function movePage(pages: ReportPage[], from: number, to: number): ReportPage[] {
  if (from === to || from < 0 || to < 0 || from >= pages.length || to >= pages.length) return pages;
  const out = pages.slice();
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved);
  return out;
}

export function addPage(pages: ReportPage[], kind: 'notes' | 'tile', cardId?: string): ReportPage[] {
  return [...pages, newPage(kind, kind === 'notes' ? { notes: '' } : { cardId })];
}

/** Typing a caption stores an override; clearing it (or typing the app's own) removes it, so the page follows the data again. */
export function withCaption(page: ReportPage, text: string, appCaption: string): ReportPage {
  const next = { ...page };
  if (text.trim() && text !== appCaption) next.caption = text;
  else delete next.caption;
  return next;
}

/** What the row under a page's kind says — enough to tell two Tile pages apart. */
export function pageSubtitle(page: ReportPage, sheets: Array<{ name: string; cards: Array<{ id: string; name: string }> }>): string {
  if (page.kind === 'sheet') {
    const s = sheets[Number(page.sheetIdx) || 0];
    return s ? s.name || 'Sheet' : 'Missing sheet';
  }
  if (page.kind === 'tile') {
    const card = sheets.flatMap((s) => s.cards).find((c) => c.id === page.cardId);
    return card ? card.name || 'Chart' : 'No longer on the dashboard';
  }
  if (page.kind === 'notes') return (page.notes || '').slice(0, 40) || 'Empty';
  return '';
}

/** The fields reports:update / report:preview accept (no stamps, no paths). */
export function draftOf(r: Report) {
  return {
    name: r.name,
    format: r.format,
    pages: r.pages,
    cover: r.cover,
    paper: r.paper,
    includeFilters: r.includeFilters,
    narrative: r.narrative,
    discussion: r.discussion,
    viewId: r.viewId || '',
  };
}
