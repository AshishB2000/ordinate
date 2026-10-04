// What a card does where the dashboard is READ (T2.9), hooked into T2.8's
// canvas: a visual tile's actions and its tooltip visual, a narrowed tile's
// filters, the KPI's "Alert me…" and its watched bell, a pivot's "Copy as
// table" / "Export CSV", and Present mode's fitted rows.

import { useLayoutEffect, useMemo, useState, type ReactNode, type RefObject } from 'react';
import { rpc } from '../../api/client';
import type { PivotGridShape } from '../../charts/grids/model';
import type { MenuEntry } from '../../ui/Menu';
import { toast } from '../../ui/Toast';
import { Icon } from '../../ui/icons/Icon';
import type { Card, Layout, VisualDef } from '../analyses/api';
import type { EditorApi } from '../analyses/editor/context';
import { mergeFilters, VisualTileBody } from '../analyses/VisualTile';
import { AlertDialog, subjectOf, type AlertSubject } from './AlertDialog';
import { DrillPanel, type DrillTarget } from '../visuals/drill/DrillPanel';
import { useAlerts, useComments } from './api';
import { pinsOn } from './CommentsPanel';
import { presentRow } from './DashboardChrome';
import { pivotToCsv, pivotToTsv, saveText } from './pivotExport';
import { actionMenu, actionsOf, TooltipVisual, useRunAction } from './tileActions';
import s from './Dashboards.module.css';

/** What a drill from a tile reads: the SAME filters that drew it, and the clicked mark (or none: every row). */
export function drillTarget(ed: EditorApi, cardId: string, def: VisualDef, mark: DrillTarget['mark']): DrillTarget {
  return {
    name: def.name || 'Visual',
    projectId: ed.projectId,
    datasetId: def.datasetId,
    encoding: def.encoding as DrillTarget['encoding'],
    filters: mergeFilters(tileFilters(ed, cardId), def.filters) as DrillTarget['filters'],
    mark,
  };
}

/** The pivot as it may LEAVE the app: the server's grid through the Share policy's export path. */
/** What a tile reads: the sheet's filters, then a filter_target narrowing on this tile. */
export function tileFilters(ed: EditorApi, cardId: string) {
  const narrow = ed.view.tileSteps(cardId);
  return narrow.length ? [...ed.filters, ...narrow] : ed.filters;
}

async function sharedPivot(ed: EditorApi, def: VisualDef, cardId: string): Promise<PivotGridShape | null> {
  const r = (await rpc('visual:data', {
    projectId: ed.projectId,
    datasetId: def.datasetId,
    encoding: def.encoding as never, // the saved visual's own encoding, re-sanitized by the handler
    filters: mergeFilters(tileFilters(ed, cardId), def.filters) as never,
    // The sheet's parameters, as the tile was drawn with them: the export IS the grid on screen.
    params: ed.params,
    share: 'export',
  })) as { ok: boolean; data?: { pivot?: PivotGridShape }; error?: string };
  if (!r.ok || !r.data?.pivot) {
    toast(r.error || 'This pivot has nothing to copy yet.', { kind: 'error' });
    return null;
  }
  return r.data.pivot;
}

export function useCardRuntime(ed: EditorApi, gridRef: RefObject<HTMLDivElement | null>) {
  const run = useRunAction(ed);
  const [alertFor, setAlertFor] = useState<AlertSubject | null>(null);
  const [rowsDrill, setRowsDrill] = useState<DrillTarget | null>(null);
  const [rowPx, setRowPx] = useState<number | null>(null);
  const [rows, setRows] = useState(0);
  const presenting = ed.view.presenting;

  // Present: the whole sheet in the window, refitted on resize; the stored layout is never touched.
  useLayoutEffect(() => {
    if (!presenting) return setRowPx(null);
    const fit = () => {
      const g = gridRef.current;
      if (!g) return;
      const gap = parseFloat(getComputedStyle(g).getPropertyValue('--dash-gap')) || 12;
      setRowPx(presentRow(rows, window.innerHeight - g.getBoundingClientRect().top - 24, gap));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [presenting, rows, gridRef]);

  const menu = (card: Card, def: VisualDef | undefined): MenuEntry[] => {
    const out: MenuEntry[] = [];
    if (card.type === 'metric') {
      out.push({
        label: 'Alert me…',
        icon: 'bell',
        onSelect: () => {
          const subj = subjectOf(card, ed.filters, ed.analysisId);
          if (subj) setAlertFor(subj);
          else toast('This card has no metric to alert on.');
        },
      });
    }
    if (def && def.chartType === 'pivot') {
      out.push(
        {
          label: 'Copy as table',
          icon: 'copy',
          onSelect: () =>
            void sharedPivot(ed, def, card.id).then((g) => {
              if (!g) return;
              navigator.clipboard.writeText(pivotToTsv(g)).then(
                () => toast('Table copied', { kind: 'success' }),
                () => toast('The clipboard is not available here.', { kind: 'error' }),
              );
            }),
        },
        {
          label: 'Export CSV',
          icon: 'download',
          onSelect: () => void sharedPivot(ed, def, card.id).then((g) => g && saveText(pivotToCsv(g), `${(def.name || 'pivot').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'pivot'}.csv`, 'text/csv')),
        },
      );
    }
    // The rows behind the whole visual — the drill a click on a mark narrows (dashGrid.ts, the chart's ⋯).
    if (def && !def.chartType.startsWith('map_')) out.push({ label: 'Show the rows', icon: 'table', onSelect: () => setRowsDrill(drillTarget(ed, card.id, def, null)) });
    out.push(...actionMenu(card, def, run));
    return out;
  };

  const gridVars = (items: Layout[]): Record<string, string> => {
    const n = items.reduce((m, it) => Math.max(m, it.y + it.h), 0);
    if (presenting && n !== rows) queueMicrotask(() => setRows(n));
    return rowPx ? { '--dash-row': `${rowPx}px` } : {};
  };

  const overlays: ReactNode = (
    <>
      {alertFor && <AlertDialog projectId={ed.projectId} subject={alertFor} onClose={() => setAlertFor(null)} />}
      {rowsDrill && <DrillPanel target={rowsDrill} onClose={() => setRowsDrill(null)} />}
    </>
  );
  return { menu, gridVars, overlays };
}

/** A visual card's drawing with its tile actions: a click action owns the click (cross-filter after). */
export function VisualCard({ ed, card, def, asTable, onMark }: { ed: EditorApi; card: Card; def: VisualDef; asTable: boolean; onMark?: (v: string | number) => void }) {
  const run = useRunAction(ed);
  const actions = actionsOf(card);
  const clicks = actions.filter((a) => a.trigger === 'click' && a.kind !== 'tooltip_visual');
  const tip = actions.find((a) => a.kind === 'tooltip_visual' && a.tooltipVisualId);
  const [hover, setHover] = useState<{ category: string | number; x: number; y: number } | null>(null);
  const filters = tileFilters(ed, card.id);
  // The card's comment pins, drawn by the chart engine's annotations (commentStore.ts cmtWithPins).
  const comments = useComments(ed.projectId);
  const pins = pinsOn(comments.data?.comments, 'card', card.id);
  const drawn = useMemo(
    () => (pins.length ? { ...def, overrides: { ...def.overrides, commentPins: pins, commentPinTarget: { kind: 'card', id: card.id } } } : def),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pins compared by value
    [def, card.id, JSON.stringify(pins)],
  );
  // A plain click: the tile's own actions, else click-to-filter, else the rows behind the mark (dashGrid.ts wireDrillClick).
  const [drill, setDrill] = useState<DrillTarget | null>(null);
  const mark = clicks.length
    ? (v: string | number) => clicks.forEach((a) => run(a, card, def, v))
    : (onMark ?? ((v: string | number, series?: string) => setDrill(drillTarget(ed, card.id, def, { category: v, ...(def.encoding.series && series ? { series } : {}) }))));
  return (
    <>
      <VisualTileBody
        projectId={ed.projectId}
        def={drawn}
        filters={filters}
        params={ed.params}
        asTable={asTable}
        onMark={mark}
        // A map has no Chart.js marks: a clicked region or point runs the tile's click actions, else joins the
        // sheet's selection (tileActions.ts wireTileActions, cv-mark-click).
        onMapMark={(column, category) => {
          if (clicks.length) return clicks.forEach((a) => run(a, card, def, category));
          const col = column || def.encoding.category;
          if (col) ed.view.toggleSelection({ type: 'filter', column: col, op: '=', value: category });
        }}
        onPinAt={(category, series) => ed.view.openComments({ kind: 'card', id: card.id, point: { label: String(category), ...(series ? { series } : {}) } })}
        onHover={tip ? (category, e) => setHover(category === null ? null : { category, x: e.clientX, y: e.clientY }) : undefined}
      />
      {drill && <DrillPanel target={drill} onClose={() => setDrill(null)} />}
      {tip && hover && <TooltipVisual ed={ed} tip={ed.visuals.get(tip.tooltipVisualId as string)} column={def.encoding.category} category={hover.category} at={hover} />}
    </>
  );
}

/** A KPI watched by an enabled rule wears a bell; accented while one of its alerts is unseen (alAttachCardBell). */
export function WatchedBell({ ed, card }: { ed: EditorApi; card: Card }) {
  const q = useAlerts(ed.projectId);
  const m = card.metric;
  const rule = m && q.data?.rules.find((r) => r.enabled && r.datasetId === m.datasetId && r.metric.column === m.column && r.metric.aggregation === m.aggregation);
  if (!rule) return null;
  const fired = q.data?.events.some((e) => e.ruleId === rule.id && !e.seen);
  return (
    <span className={fired ? `${s.watched} ${s.fired}` : s.watched} title={fired ? `“${rule.name}” fired` : `Watched by “${rule.name}”`} role="img" aria-label={fired ? 'Alert fired' : 'Watched by an alert'}>
      <Icon name="bell" size={12} />
    </span>
  );
}
