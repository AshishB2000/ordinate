// The builder's draft and everything derived from it (vizBuilder.ts state):
// encoding, chart type, overrides, filters and overlays, previewed on the
// server 160 ms after the last edit; the chips the reply supports (CODE's
// call, ./eligibility); the project colour scope; styling kept on a saved
// visual as it changes. No figure is computed here.

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { rpc } from '../../api/client';
import { withGeoChartType } from '../../charts/maps/mapKinds';
import type { MapGeo } from '../../charts/maps/types';
import type { ChartDataShape, Overrides } from '../../charts/types';
import { toast } from '../../ui/Toast';
import { pickDockProject, setDockOpen } from '../assistant/dockState';
import { useCan } from '../projects/api';
import type { Overlay } from './analytics/AnalyticsPane';
import { saveVisual, updateVisual, usePreview, useRefreshVisuals, type Encoding, type FilterStep, type RelatedCol } from './api';
import { chartCanRender, countNumericSeries, eligibleChartTypes } from './eligibility';
import { facetControlsData } from './facets/FacetGrid';
import { liveFilters } from './filters/filterText';
import { useColorEdits, useColorMap, usePersistDeal } from './format/colorMap';
import { categoryType, suggestName, type Column } from './model';
import { engineKind, engineName, switchEncoding } from '../analytics/grids/gridEncoding';
import { chartFeature, LIVE_OFF_CHARTS } from '../live/offFeatures';

export interface Initial {
  visualId?: string;
  name: string;
  datasetId: string;
  encoding: Encoding;
  chartType: string;
  overrides: Overrides;
  filters: FilterStep[];
  analytics: Record<string, unknown>[];
  /** The dataset is Live (L2.6): pivot, cohort and funnel are off, and the stage says so instead of asking. */
  live?: boolean;
}

/** `value`, settled for `ms`. */
function useSettled<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** What goes to the server: the grain and the overlay belong to a date category only; empty measures drop. */
function effective(enc: Encoding, isDate: boolean): Encoding {
  const e: Encoding = { ...enc, values: enc.values.filter((v) => v.column) };
  if (!isDate) {
    delete e.grain;
    delete e.overlay;
  }
  return e;
}

/** The measure names the series are drawn under (chartFormat.measureNames). */
function measureNames(enc: Encoding): string[] {
  return enc.values.flatMap((v) => (v.aggregation === 'count' ? [v.column] : v.aggregation === 'none' ? [`sum of ${v.column}`, v.column] : [`${v.aggregation} of ${v.column}`]));
}

export function useBuilder(projectId: string, columns: Column[], related: RelatedCol[], initial: Initial) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const refresh = useRefreshVisuals(projectId);
  const can = useCan(projectId);
  const [enc, setEnc] = useState(initial.encoding);
  const [chartType, setChartType] = useState(initial.chartType);
  const [overrides, setOverrides] = useState<Overrides>(initial.overrides);
  const [filters, setFilters] = useState<FilterStep[]>(initial.filters);
  const [overlays, setOverlays] = useState<Overlay[]>(initial.analytics as Overlay[]);
  // "As of" (snapshotAsOf.ts): view state only — never saved, back to Latest on every open.
  const [asOf, setAsOf] = useState<string | null>(null);
  const { visualId, datasetId } = initial;
  const persist = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(persist.current), []);

  const isDate = categoryType(enc, columns, related) === 'date';
  const eff = useMemo(() => effective(enc, isDate), [enc, isDate]);
  const live = useMemo(() => liveFilters(filters), [filters]);
  const complete = !!eff.pivot || (!!eff.category && eff.values.length > 0);
  // A grid type on a Live dataset is off in v1: nothing is asked, the stage explains (../live/offFeatures).
  const offType = initial.live ? chartFeature(chartType) : null;
  const wanted = useMemo(
    () => (complete && !offType ? { projectId, datasetId, encoding: eff, filters: live, ...(overlays.length ? { analytics: overlays } : {}), ...(asOf ? { asOf } : {}) } : undefined),
    [complete, offType, projectId, datasetId, eff, live, overlays, asOf],
  );
  const preview = usePreview(useSettled(wanted, 160));
  const reply = complete ? preview.data : undefined;
  const data = reply?.data as (ChartDataShape & { geo?: MapGeo | null; facets?: never }) | undefined;

  // The chips: from the reply's shape and structure; a map reply is judged as its category's shape;
  // small multiples are judged on ONE panel (every panel is drawn the same way).
  const fit = data ? facetControlsData(data) : undefined;
  const hasGeo = !!data?.geo;
  const shape = data?.geo ? (isDate ? 'time_series' : 'categorical') : (reply?.recommendedShape ?? 'unstructured');
  const eligible = fit ? withGeoChartType(eligibleChartTypes(shape, countNumericSeries(fit), (fit.labels || []).length), data?.geo) : [];
  const recommended = initial.live ? eligible.filter((t) => !LIVE_OFF_CHARTS.has(t)) : eligible;
  const current = fit && chartType && (recommended.includes(chartType) || chartCanRender(chartType, fit, hasGeo)) ? chartType : (recommended[0] ?? '');
  const engine = engineKind(current);
  const label = initial.name || (engine && engineName(engine, eff)) || suggestName(eff, current);

  // The project's colours: the category / split columns this chart reads (not a related dataset's).
  const colorMap = useColorMap(projectId);
  const edits = useColorEdits(projectId);
  const catCol = eff.categoryDatasetId ? '' : eff.category;
  const serCol = eff.series && !eff.seriesDatasetId ? eff.series : '';
  const map = colorMap.data;
  const scope = map ? { category: catCol, series: serCol, map, edit: edits } : null;
  const drawn = useMemo(() => (map ? { ...overrides, _colorScope: { category: catCol, series: serCol, map } } : overrides), [overrides, map, catCol, serCol]);
  usePersistDeal(projectId, colorMap.data, catCol, fit?.labels, can('editor'));
  usePersistDeal(projectId, colorMap.data, serCol, fit?.series?.filter((x) => x.role !== 'overlay').map((x) => x.name), can('editor'));

  const pickType = (t: string) => {
    // A calendar is one cell per DAY: an auto-grained axis would leave a handful of lonely cells.
    if (t === 'calendar' && isDate && enc.grain !== 'day') setEnc({ ...enc, grain: 'day' });
    // Entering or leaving a pivot / cohort / funnel changes what the encoding IS (vizBuilder's onSelect).
    const next = switchEncoding(enc, current || chartType, t, columns);
    if (next !== enc) setEnc(next);
    setChartType(t);
  };

  const patch = (p: Record<string, unknown>) => {
    let next: Overrides;
    if (p.reset) next = {};
    else {
      next = { ...overrides, ...p };
      for (const k of Object.keys(p)) if (next[k] == null) delete next[k];
    }
    setOverrides(next);
    // A saved visual keeps its styling as it changes; a draft keeps it until the first Save.
    // A viewer may try a style on screen; nothing of theirs is written.
    if (visualId && can('editor')) {
      window.clearTimeout(persist.current);
      persist.current = window.setTimeout(() => void updateVisual(projectId, visualId, { overrides: next }).then(() => refresh(visualId), () => undefined), 300);
    }
  };

  /**
   * A new calculated measure is the chart's only one: draw its figures in its own
   * format (a ratio as a percent). Kept with the draft, saved by Save — never
   * written on its own, or a saved chart would wear a format its saved measure lacks.
   */
  const formatAs = (kind: string) => {
    if ((kind === 'percent' || kind === 'currency') && !overrides.numberFormat) setOverrides({ ...overrides, numberFormat: kind });
  };

  const save = async (finalName: string) => {
    const grain = isDate && !eff.grain && reply?.category?.grain ? { grain: reply.category.grain } : {};
    const body = { name: finalName, chartType: current || chartType || 'column', encoding: { ...eff, ...grain }, overrides, filters: live, analytics: overlays };
    if (visualId) await updateVisual(projectId, visualId, body);
    else await saveVisual({ projectId, datasetId, ...body });
    refresh(visualId);
    void qc.invalidateQueries({ queryKey: ['visual:thumbs', projectId] });
    toast(`Saved “${finalName}”.`, { kind: 'success' });
    void navigate(`/visuals/${projectId}`);
  };

  const explain = () =>
    void rpc('answer:explain', { projectId, tile: { datasetId, encoding: eff, filters: live, chartType: current, name: label } })
      .then((r) => {
        const res = r as { ok: boolean; reason?: string };
        if (!res.ok) throw new Error(res.reason || 'This chart cannot be explained.');
        pickDockProject(projectId);
        setDockOpen(true);
      })
      .catch((e: Error) => toast(e.message, { kind: 'error' }));

  return {
    enc, setEnc, chartType, setChartType, overrides, patch, filters, setFilters, live, overlays, setOverlays,
    eff, isDate, complete, preview, reply, data, fit, hasGeo, recommended, current, label, pickType, save, explain,
    drawn, scope, measures: measureNames(eff), visualId, datasetId, asOf, setAsOf, liveDataset: !!initial.live, offType,
    canEdit: can('editor'),
    formatAs,
  };
}

export type Builder = ReturnType<typeof useBuilder>;
