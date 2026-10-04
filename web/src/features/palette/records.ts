// The records the palette finds — palette.ts's record half. Empty query: the
// caller's Recent (the same cached `recent:list` Home reads). Typed: record
// NAMES in the current project (`search:query`, never row contents). A hit
// opens the route that exists for it; areas still being ported land on their
// section, as Home's Recent does.

import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../api/client';
import type { IconName } from '../../ui/icons/Icon';

export interface SearchHit {
  kind: 'dataset' | 'visual' | 'analysis' | 'view' | 'connection' | 'metric' | 'report' | 'story' | 'alert';
  id: string;
  parentId?: string;
  name: string;
  /** The server's own second line: rows, chart type, sheet count. */
  sub: string;
  /** The kind in the words the UI says it in ("Dataset", "Dashboard"). */
  type: string;
  projectId: string;
}

export const HIT_ICON: Record<SearchHit['kind'], IconName> = {
  dataset: 'database',
  visual: 'chart-bar',
  analysis: 'layout-dashboard',
  view: 'layout-dashboard',
  connection: 'plug',
  metric: 'gauge',
  report: 'file-text',
  story: 'file-text',
  alert: 'bell',
};

/** Where a hit opens. */
export function hitHref(h: Pick<SearchHit, 'kind' | 'id' | 'projectId'>): string {
  switch (h.kind) {
    case 'dataset':
      return `/data/${h.projectId}/${h.id}`;
    case 'connection':
      return `/connections/${h.projectId}/${h.id}`;
    case 'visual':
      return '/visuals';
    case 'analysis':
    case 'view':
      return '/dashboards';
    case 'report':
    case 'story':
      return '/reports';
    default:
      return '/analyses';
  }
}

const hits = (v: unknown): SearchHit[] => {
  const r = v && typeof v === 'object' ? (v as { ok?: unknown; results?: unknown }) : {};
  return r.ok === true && Array.isArray(r.results) ? (r.results as SearchHit[]) : [];
};

/** Names matching `query` in `projectId`; off for an empty query or no project. */
export function useRecordSearch(projectId: string | null, query: string) {
  const q = query.trim();
  return useQuery({
    queryKey: ['search:query', projectId, q],
    queryFn: async () => hits(await rpc('search:query', { projectId: projectId as string, query: q })),
    enabled: !!projectId && q.length > 0,
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });
}
