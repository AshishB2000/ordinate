// Where an open dashboard stands as a draft (docs/superpowers/specs/2026-10-29-dashboard-drafts-publish-design.md):
// the `analysis:open` reply its page was built from — the draft or the published copy, its status, when it was
// published. The page holds that reply for as long as it is open; useDraftActions and the editor's autosave keep its
// status current, so reading it here asks the server nothing.

import { useSearchParams } from 'react-router';
import { useOpenAnalysis, type OpenReply } from '../../analyses/api';
import type { Doc } from '../../analyses/editor/doc';
import type { EditorApi } from '../../analyses/editor/context';

export type Opened = Extract<OpenReply, { ok: true }>;

/** The view page (/dashboards/<p>/<id>) shows the published copy; `?draft=1` is the Preview of the draft. */
export const wantsPublished = (search: URLSearchParams): boolean => search.get('draft') !== '1';

/** The reply this page opened with: the editor's is the draft's, the view page's the copy's unless it is a Preview. */
export function useOpened(ed: Pick<EditorApi, 'projectId' | 'analysisId' | 'viewing'>): Opened | undefined {
  const [search] = useSearchParams();
  const q = useOpenAnalysis(ed.projectId, ed.analysisId, { published: ed.viewing && wantsPublished(search) });
  return q.data?.ok ? q.data : undefined;
}

const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const dated = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/** "Oct 27" this year, "Oct 27, 2025" before it; '' for no date. */
export function publishedDay(iso: string | undefined, now = new Date()): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return d.getFullYear() === now.getFullYear() ? day.format(d) : dated.format(d);
}

const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** What Publish would freeze, as the dialog lists it: sheets, then charts, KPIs and filters there are any of. */
export function contentsOf(doc: Pick<Doc, 'sheets' | 'filters'>): string[] {
  const cards = doc.sheets.flatMap((s) => s.cards);
  const count = (type: string) => cards.filter((c) => c.type === type).length;
  const charts = count('visual');
  const kpis = count('metric');
  // A dashboard filter and a control card are both a filter the reader meets.
  const filters = doc.filters.length + count('control');
  return [n(doc.sheets.length, 'sheet', 'sheets'), charts && n(charts, 'chart', 'charts'), kpis && n(kpis, 'KPI', 'KPIs'), filters && n(filters, 'filter', 'filters')].filter(
    (x): x is string => !!x,
  );
}
