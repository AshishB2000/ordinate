// Lineage (lineagePanel.ts): the dependency graph around one dataset — what it
// is built from, and every visual, dashboard, report and alert built on it.
// The server builds AND lays out the graph (src/analysis/lineage.ts): every
// node arrives with a column and a row, so this only turns them into an SVG.
// Hover or focus a card and everything not on a path through it dims; Enter
// or a click opens the record.

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Drawer } from '../../ui/Dialog';
import { Icon, type IconName } from '../../ui/icons/Icon';
import { SkeletonBlock } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { useLineage, type Lineage, type LineageNode } from './api';
import { recordHref } from './CatalogTab';
import { formatNumber } from './format';
import s from './Data.module.css';
import ms from './Model.module.css';

const W = 168;
const H = 52;
const COL_GAP = 40;
const ROW_GAP = 18;
const PAD = 8;
const HEAD = 30;

const KIND: Record<string, { word: string; plural: string; icon: IconName }> = {
  source: { word: 'Source', plural: 'Sources', icon: 'file-text' },
  dataset: { word: 'Dataset', plural: 'Datasets', icon: 'database' },
  prepare: { word: 'Prepare', plural: 'Prepare', icon: 'sliders' },
  calc: { word: 'Calculated field', plural: 'Calculated fields', icon: 'function' },
  metric: { word: 'Metric', plural: 'Metrics', icon: 'gauge' },
  visual: { word: 'Visual', plural: 'Visuals', icon: 'chart-bar' },
  dashboard: { word: 'Dashboard', plural: 'Dashboards', icon: 'layout-dashboard' },
  report: { word: 'Report', plural: 'Reports', icon: 'file-text' },
  alert: { word: 'Alert', plural: 'Alerts', icon: 'bell' },
};

/** "Used in 3 visuals · 1 dashboard" — the counts are the server's. */
export function usedInText(usedIn: Record<string, number>): string {
  const parts = (['dataset', 'visual', 'dashboard', 'report', 'alert'] as const)
    .filter((k) => usedIn[k])
    .map((k) => `${formatNumber(usedIn[k])} ${usedIn[k] === 1 ? k : `${k}s`}`);
  return parts.length ? `Used in ${parts.join(' · ')}` : '';
}

function iconFor(n: LineageNode): IconName {
  if (n.kind === 'source' && n.ref?.type === 'connection') return 'plug';
  if (n.kind === 'source' && n.ref?.type === 'capture') return 'camera';
  if (n.kind === 'source' && n.id.startsWith('source:url:')) return 'link';
  return (KIND[n.kind] ?? KIND.dataset).icon;
}

const fit = (t: string, max: number) => (t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t);

/** Where a node opens, if anywhere in the browser yet. */
function hrefOf(projectId: string, n: LineageNode): string | null {
  const r = n.ref;
  if (!r) return null;
  if (r.type === 'dataset') return `/data/${projectId}/${r.id}${n.kind === 'calc' || n.kind === 'prepare' ? '?tab=columns' : ''}`;
  if (r.type === 'dashboard') return recordHref(projectId, { kind: 'analysis', id: r.id });
  if (r.type === 'visual' || r.type === 'report' || r.type === 'metric') return recordHref(projectId, { kind: r.type, id: r.id });
  return null;
}

function Graph({ projectId, g }: { projectId: string; g: Lineage }) {
  const navigate = useNavigate();
  const [hover, setHover] = useState<string | null>(null);
  const cols = Math.max(1, g.columns || 1);
  const rows = Math.max(1, ...g.nodes.map((n) => (n.row ?? 0) + 1));
  const width = PAD * 2 + cols * W + (cols - 1) * COL_GAP;
  const height = HEAD + PAD * 2 + rows * H + (rows - 1) * ROW_GAP;
  const x = (c: number) => PAD + c * (W + COL_GAP);
  const y = (r: number) => HEAD + PAD + r * (H + ROW_GAP);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));

  // Everything on a path through the hovered card: walk up and down the edges.
  const related = (() => {
    if (!hover) return null;
    const seen = new Set([hover]);
    for (const dir of ['up', 'down'] as const) {
      const stack = [hover];
      while (stack.length) {
        const at = stack.pop()!;
        for (const e of g.edges) {
          const next = dir === 'up' ? (e.to === at ? e.from : null) : e.from === at ? e.to : null;
          if (next && !seen.has(next)) {
            seen.add(next);
            stack.push(next);
          }
        }
      }
    }
    return seen;
  })();

  const heads = Array.from({ length: cols }, (_, c) => [...new Set(g.nodes.filter((n) => n.col === c).map((n) => (KIND[n.kind] ?? KIND.dataset).plural))].join(' & '));
  return (
    <div className={ms.lnScroll}>
      <svg className={`${s.lnSvg} ${related ? ms.lnHovering : ''}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="group" aria-label="Lineage graph">
        {heads.map((h, c) => (
          <text key={c} className={ms.lnColHead} x={x(c) + 2} y={14}>
            {c > 0 && h === heads[c - 1] ? '' : h.toUpperCase()}
          </text>
        ))}
        {g.edges.map((e) => {
          const a = byId.get(e.from);
          const b = byId.get(e.to);
          if (!a || !b) return null;
          const x1 = x(a.col) + W;
          const y1 = y(a.row) + H / 2;
          const x2 = x(b.col);
          const y2 = y(b.row) + H / 2;
          let d: string;
          if (b.col - a.col <= 1) {
            const dx = Math.max(16, (x2 - x1) / 2);
            d = `M${x1} ${y1} C${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
          } else {
            // A skipped column: run along the gutter under the source row, not behind the cards between.
            const yg = y(a.row) + H + ROW_GAP / 2;
            const sx = COL_GAP / 2;
            d = `M${x1} ${y1} C${x1 + sx} ${y1}, ${x1 + sx / 2} ${yg}, ${x1 + sx} ${yg} L${x2 - sx} ${yg} C${x2 - sx / 2} ${yg}, ${x2 - sx} ${y2}, ${x2} ${y2}`;
          }
          const on = related?.has(e.from) && related.has(e.to);
          return <path key={`${e.from}>${e.to}`} className={`${ms.lnEdge} ${on ? ms.lnRelated : ''}`} d={d} />;
        })}
        {g.nodes.map((n) => {
          const k = KIND[n.kind] ?? KIND.dataset;
          const href = hrefOf(projectId, n);
          const open = () => {
            if (href) void navigate(href);
          };
          return (
            <g
              key={n.id}
              className={[ms.lnNode, n.id === g.focus && ms.lnFocus, href && ms.lnLink, related?.has(n.id) && ms.lnRelated].filter(Boolean).join(' ')}
              transform={`translate(${x(n.col)} ${y(n.row)})`}
              tabIndex={0}
              role={href ? 'link' : 'img'}
              aria-label={`${k.word}: ${n.name}${n.sub ? `, ${n.sub}` : ''}`}
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(n.id)}
              onBlur={() => setHover(null)}
              onClick={open}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), open())}
            >
              <title>{`${n.name}\n${k.word}${n.sub ? ` · ${n.sub}` : ''}`}</title>
              <rect className={ms.lnCard} width={W} height={H} rx={10} />
              <rect className={ms.lnIcBg} x={10} y={12} width={28} height={28} rx={7} />
              <g className={ms.lnIc} transform="translate(16 18)">
                <Icon name={iconFor(n)} />
              </g>
              <text className={ms.lnName} x={48} y={23}>
                {fit(n.name, 16)}
              </text>
              <text className={ms.lnSub} x={48} y={39}>
                {fit(n.sub || k.word, 21)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function LineageDrawer({ projectId, id, name, onClose }: { projectId: string; id: string; name: string; onClose: () => void }) {
  const q = useLineage(projectId, id);
  const g = q.data;
  return (
    <Drawer open wide onOpenChange={(o) => !o && onClose()} title={name} description="Lineage · Dataset">
      {q.isPending ? (
        <SkeletonBlock label="Tracing what this is built from" />
      ) : q.isError ? (
        <ErrorState compact heading={3} title="The lineage could not be traced" message={q.error.message} onRetry={() => void q.refetch()} />
      ) : !g || g.nodes.length === 0 ? (
        <EmptyState compact heading={3} icon="lineage" title="Nothing to trace">
          This record could not be found. It may have been deleted.
        </EmptyState>
      ) : (
        <>
          <div className={ms.lnSummary}>
            <span className={ms.lnChip}>
              <Icon name="lineage" size={16} />
              {g.upstream ? `Built from ${formatNumber(g.upstream)} ${g.upstream === 1 ? 'record' : 'records'}` : 'Built from nothing else here'}
            </span>
            <span className={ms.lnChip}>
              <Icon name="chart-bar" size={16} />
              {usedInText(g.usedIn) || 'Not used by anything yet'}
            </span>
            <span className={s.meta}>Hover to follow a path; click to open.</span>
          </div>
          <Graph projectId={projectId} g={g} />
          {g.nodes.length === 1 && <p className={s.note}>Nothing is built from this yet — visuals, dashboards and reports on it will appear here.</p>}
        </>
      )}
    </Drawer>
  );
}
