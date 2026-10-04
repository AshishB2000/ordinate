// The card kinds beyond visual / KPI / text / layout (legacy cardKinds.ts):
// a statistics result (statsTile.ts — the server recomputes the spec under the
// sheet's filters on every render), an image from the project's assets
// (layoutKinds.ts), and a navigation strip (navCard.ts). Nothing here
// computes a figure: a stats tile's table cells are the server's strings.

import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../api/client';
import { SkeletonBlock } from '../../../ui/Skeleton';
import { ErrorState } from '../../../ui/States';
import { Icon, type IconName } from '../../../ui/icons/Icon';
import { useTile, type Card, type StatsTile } from '../api';
import { DrawnVisual } from '../VisualTile';
import { useEditor } from './context';
import s from './Kinds.module.css';

export type ImageSpec = { assetId: string; ext: 'png' | 'jpg' | 'svg'; fit: 'contain' | 'cover' | 'fill'; alt: string; lockAspect?: boolean; aspect?: number };
export type NavItem = { id: string; label: string; icon?: string; target?: { analysisId: string; page?: string }; carry?: { column: string; value: string | number } };
export type NavSpec = { style: 'buttons' | 'tabs' | 'back'; items: NavItem[] };
export type StatsSpec = { kind: 'correlation' | 'regression' | 'groups' | 'distribution'; datasetId: string; [k: string]: unknown };

/** The icons a nav button may wear (cardModel.ts NAV_ICONS — the store drops anything else). */
export const NAV_ICONS = [
  'layout-dashboard', 'chart-bar', 'chart-line', 'chart-pie', 'map', 'table', 'home', 'arrow-left',
  'arrow-right', 'star', 'filter', 'layers', 'grid', 'list', 'user', 'calendar', 'database', 'sparkles',
] as const;
export const MAX_NAV_ITEMS = 12;

/** A statistics card's title from its spec (statsTile.ts swTileTitle). */
export function statsTitle(spec: StatsSpec | undefined): string {
  const o = spec ?? ({} as Partial<StatsSpec>);
  if (o.kind === 'correlation') return o.method === 'spearman' ? 'Rank correlation' : 'Correlation';
  if (o.kind === 'regression') return `Regression on ${String(o.target ?? '')}`;
  if (o.kind === 'groups') return `${String(o.outcome ?? '')} by ${String(o.group ?? '')}`;
  if (o.kind === 'distribution') return `Distribution of ${String((o.columns as string[] | undefined)?.[0] ?? '')}`;
  return 'Statistics';
}

export function StatsBody({ card }: { card: Card }) {
  const ed = useEditor();
  const spec = card.stats as StatsSpec | undefined;
  const req = useMemo(() => (spec ? { kind: 'stats' as const, spec, filters: ed.filters } : undefined), [spec, ed.filters]);
  const q = useTile<StatsTile>(ed.projectId, ed.params, req);
  const title = statsTitle(spec);
  if (!spec) return <p className={s.missing}>This statistics card has no analysis.</p>;
  if (q.isPending) return <SkeletonBlock label={`Computing ${title}`} />;
  if (q.isError || !q.data.ok) {
    return <ErrorState compact heading={3} title="Could not compute this tile" message={q.isError ? q.error.message : q.data.ok ? '' : q.data.error} onRetry={() => void q.refetch()} />;
  }
  const { tile, view } = q.data;
  return (
    <div className={s.stats}>
      {tile.subtitle && <p className={s.statsSub}>{tile.subtitle}</p>}
      {view === 'chart' ? (
        <div className={s.statsChart}>
          <DrawnVisual type={tile.chart.chartType} data={tile.chart.data} label={tile.title} projectId={ed.projectId} />
        </div>
      ) : (
        <div className={s.statsTable}>
          <table>
            <thead>
              <tr>
                {tile.table.head.map((h, i) => (
                  <th key={i} scope="col" className={i > 0 ? s.num : undefined}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tile.table.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((v, j) =>
                    j === 0 ? (
                      <th key={j} scope="row">
                        {v}
                      </th>
                    ) : (
                      <td key={j} className={s.num}>
                        {v}
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {tile.sentence && <p className={s.statsSentence}>{tile.sentence}</p>}
    </div>
  );
}

export function ImageBody({ card }: { card: Card }) {
  const ed = useEditor();
  const img = card.image as ImageSpec | undefined;
  const q = useQuery({
    queryKey: ['asset:read', ed.projectId, img?.assetId, img?.ext],
    enabled: !!img,
    staleTime: Infinity,
    queryFn: async () => (await rpc('asset:read', { projectId: ed.projectId, id: img?.assetId as string, ext: img?.ext ?? 'png' })) as { ok: true; dataUrl: string } | { ok: false; error: string },
  });
  if (!img) return <p className={s.missing}>This image card has no picture.</p>;
  if (q.isPending) return <SkeletonBlock label="Loading the image" />;
  if (q.isError) return <ErrorState compact heading={3} title="The image could not be loaded" message={q.error.message} onRetry={() => void q.refetch()} />;
  if (!q.data.ok) {
    return (
      <p className={s.missing}>
        <Icon name="alert" size={16} />
        This image is missing from the project.
      </p>
    );
  }
  return (
    <div className={`${s.img} ${s[`fit_${img.fit}`]}`}>
      <img src={q.data.dataUrl} alt={img.alt} role={img.alt ? undefined : 'presentation'} />
    </div>
  );
}

/** A navigation strip (navCard.ts). In the editor a button opens its target dashboard; carried filters apply where it is viewed. */
export function NavBody({ card }: { card: Card }) {
  const ed = useEditor();
  const navigate = useNavigate();
  const nav = (card.nav as NavSpec | undefined) ?? { style: 'buttons', items: [] };
  const items = nav.style === 'back' ? [nav.items[0] ?? { id: 'back', label: 'Back to overview' }] : nav.items;
  if (!items.length) return <p className={s.missing}>No buttons yet — add them in Properties.</p>;
  const open = (it: NavItem) => {
    if (!it.target) return;
    // This dashboard: just switch sheets (the editor stays open).
    if (it.target.analysisId === ed.analysisId) return ed.setSheet(Math.max(0, ed.doc.sheets.findIndex((p) => p.id === it.target?.page)));
    const sheet = it.target.page ? `?sheet=${it.target.page}` : '';
    void navigate(`/analyses/${ed.projectId}/${it.target.analysisId}${sheet}`);
  };
  return (
    <nav className={nav.style === 'tabs' ? `${s.nav} ${s.navTabs}` : s.nav} aria-label={card.heading || 'Dashboard navigation'}>
      {items.map((it) => {
        const here = !!it.target && it.target.analysisId === ed.analysisId && (it.target.page ? ed.doc.sheets[ed.sheet]?.id === it.target.page : ed.sheet === 0);
        const icon = (nav.style === 'back' ? 'arrow-left' : it.icon) as IconName | undefined;
        return (
          <button
            key={it.id}
            type="button"
            className={[nav.style === 'tabs' ? s.navTab : s.navBtn, here && s.navOn].filter(Boolean).join(' ')}
            aria-current={here ? 'page' : undefined}
            disabled={!it.target}
            title={it.target ? (it.carry ? `Opens with ${it.carry.column} = ${String(it.carry.value)}` : undefined) : 'This button has no dashboard to open yet.'}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              open(it);
            }}
          >
            {icon && <Icon name={icon} size={12} />}
            <span>{it.label || 'Open'}</span>
          </button>
        );
      })}
    </nav>
  );
}

// ── Image aspect lock (layoutKinds.ts imgLockAspect) ─────────────────────

/** The sheet grid's pitch, read from the drawn grid (`data-sheet-grid`); null before it is laid out. */
function gridMetrics(): { pitch: number; gap: number; row: number } | null {
  const grid = document.querySelector<HTMLElement>('[data-sheet-grid]');
  if (!grid) return null;
  const css = getComputedStyle(grid);
  const gap = parseFloat(css.getPropertyValue('--dash-gap')) || 12;
  const row = parseFloat(css.getPropertyValue('--dash-row')) || 48;
  return { pitch: (grid.getBoundingClientRect().width + gap) / 12, gap, row };
}

/** Rows that keep an image's aspect at `w` columns; the current height when it cannot be measured. */
export function lockedRows(w: number, aspect: number | undefined, fallback: number): number {
  const m = gridMetrics();
  if (!m || !aspect || !(aspect > 0)) return fallback;
  const widthPx = w * m.pitch - m.gap;
  return Math.max(1, Math.round((widthPx / aspect + m.gap) / (m.row + m.gap)));
}
