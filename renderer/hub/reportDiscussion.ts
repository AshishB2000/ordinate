'use strict';

// A report's DISCUSSION page — the dashboard's comment threads, printed last,
// and only when the author ticked "Include discussion" (reportBuilder.ts adds
// the page; reportRender.ts resolves every other kind). Classic global-scope
// script: no import/export.
//
// It is one more `RenderedPage`, so the PDF, PPTX and DOCX writers print it
// with no code of their own: a count line under the heading, then one bullet
// per thread — open first, then resolved — and an indented bullet per reply.
// Bodies go out as plain text: the Markdown subset is for the screen, and a
// printed `**` is noise.
//
// The threads are read for the REPORT's project, not the open one: a scheduled
// run prints reports of projects nobody has open.

async function reportDiscussionPage(ctx: ReportContext, page: any): Promise<RenderedPage | null> {
  if (!page || page.kind !== 'discussion') return null;
  let res: any = null;
  try {
    res = await window.hubPower.listComments(ctx.projectId);
  } catch (_) {
    res = null;
  }
  const list: any[] = res && res.ok && Array.isArray(res.comments) ? res.comments : [];
  const names: Record<string, { name: string }> = (res && res.targets) || {};
  const a = ctx.analysis || {};
  const cards = new Set<string>();
  const visuals = new Set<string>();
  for (const sheet of a.sheets || []) {
    for (const card of sheet.cards || []) {
      if (!card) continue;
      cards.add(card.id);
      if (card.visualId) visuals.add(card.visualId);
    }
  }
  const threads = list.filter((c) => {
    const t = c.target || {};
    return (t.kind === 'analysis' && t.id === a.id) || (t.kind === 'card' && cards.has(t.id)) || (t.kind === 'visual' && visuals.has(t.id));
  }).sort((x, y) => (!x.resolvedAt !== !y.resolvedAt ? (x.resolvedAt ? 1 : -1) : String(x.createdAt).localeCompare(String(y.createdAt))));

  const open = threads.filter((c) => !c.resolvedAt).length;
  // The LOCAL calendar day, in the workspace's date style — slicing the ISO string would print UTC's.
  const day = (iso: string): string => {
    const d = new Date(iso);
    return OrdFormat.formatDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  };
  const bullets: string[] = [];
  for (const c of threads) {
    const tv = c.target;
    const where = tv.kind === 'analysis' ? t('common.the_dashboard') : ((names[tv.kind + ':' + tv.id] || {}).name || t('reportDiscussion.a_tile'));
    const point = tv.point ? ' (' + tv.point.label + (tv.point.series ? ' · ' + tv.point.series : '') + ')' : '';
    const state = c.resolvedAt ? t('common.resolved') : t('common.open');
    bullets.push(t('reportDiscussion.on', { state, p1: c.author || t('common.someone'), where, point, createdAt: day(c.createdAt), body: cmtPlain(c.body) }));
    for (const r of c.replies || []) bullets.push(`    ↳ ${r.author || t('common.someone')}, ${day(r.createdAt)}: ${cmtPlain(r.body)}`);
  }
  return {
    kind: 'discussion',
    layout: page.layout,
    title: t('common.discussion'),
    meta: [threads.length
      ? t('reportDiscussion.open_resolved', { open, p1: threads.length - open })
      : t('reportDiscussion.no_one_has_commented_on_this')],
    bullets,
  };
}
