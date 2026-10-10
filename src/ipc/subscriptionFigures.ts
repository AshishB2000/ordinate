// The figures a subscription sends, resolved on the server — MAIN.
//
// Nothing here computes a figure. Each card is answered by the SAME registered
// handler that answers it on the dashboard (the way src/ipc/reportsServer.ts
// resolves a report), so a number in Slack cannot differ from the number on
// screen, and a Live dataset is asked of its warehouse through the doors and
// counted (docs/live-data: `analysis:tiles` → computeCardMetric, `visual:data`
// → vizDataFor). `getDataset` is never called from this file.
//
//   KPI card      `analysis:tiles` — the figure, its display string, and the
//                 card's Compare when it has one
//   visual card   `visual:data` ON THE SHARE PATH 'report': what leaves the app
//                 is shaped by the project's Share policy, and a tile the
//                 policy hides says so instead of sending its rows
//
// A view's scope is savedViews.viewScope — the dashboard's filters, every
// control at the view's pick, the selection — plus the view's per-tile narrowing.

import { handlers } from '../server/rpc';
import * as visuals from '../analysis/visuals';
import type { Analysis } from '../analysis/analysis';
import type { Card } from '../analysis/dashboards';
import { viewScope, type SavedView } from '../analysis/savedViews';
import { mergeDashboardFilters } from '../analysis/dashboardFilters';
import { paramValues, substituteText } from '../analysis/params';
import { formatValue } from '../app/format';
import type { FilterStep } from '../data/transforms';
import type { KpiFigure, VisualFigure } from '../analysis/subscriptionMessage';
import { noFigure } from '../analysis/subscriptionText';

/** A registered handler, called as the RPC layer calls it. Missing or throwing → a refusal, never a throw. */
async function call(channel: string, payload: unknown): Promise<any> { // any: each handler's own reply
  const h = handlers.get(channel);
  if (!h) return { ok: false, error: '' };
  try {
    return await h({}, payload);
  } catch (err) {
    // A Live figure's typed failure carries a catalog sentence (liveFigureError); anything else stays in the log.
    const f = (err as { failure?: { code?: string; error?: string } }).failure;
    return { ok: false, error: f && typeof f.error === 'string' ? f.error : '', ...(f && f.code ? { code: f.code } : {}) };
  }
}

/** A refusal's words when they are the app's own to show (a Live failure, the Share policy), else the plain line. */
function why(r: any): string { // any: a handler's refusal
  const typed = r && (r.hiddenByPolicy === true || (typeof r.code === 'string' && r.code.startsWith('live_')));
  return typed && typeof r.error === 'string' && r.error ? r.error : noFigure();
}

export interface CardRef { id: string; type: 'metric' | 'visual'; title: string; sheet: string; chartType?: string }

const sendable = (c: Card): boolean => !!c && ((c.type === 'metric' && !!c.metric) || (c.type === 'visual' && (!!c.visualId || !!c.visual)));

/** The cards of a dashboard a subscription can send — KPIs and visuals, in sheet order — by title and type. */
export async function sendableCards(projectId: string, a: Analysis): Promise<CardRef[]> {
  const out: CardRef[] = [];
  for (const sheet of a.sheets) {
    for (const c of sheet.cards || []) {
      if (!sendable(c)) continue;
      if (c.type === 'metric') {
        out.push({ id: c.id, type: 'metric', title: c.metric?.label || c.metric?.column || '', sheet: sheet.name });
        continue;
      }
      const v = c.visual ?? (c.visualId ? await visuals.getVisual(projectId, c.visualId) : null);
      if (v) out.push({ id: c.id, type: 'visual', title: v.name || '', sheet: sheet.name, chartType: v.chartType });
    }
  }
  return out;
}

export interface Figures {
  kpis: KpiFigure[];
  visuals: VisualFigure[];
  /** The newest data time among the figures (their `asOf`), or null. */
  dataAt: string | null;
  /** How many of the asked-for cards are still on the dashboard. */
  found: number;
}

/**
 * Resolve the chosen cards (`cardIds` null = every sendable card) under a saved
 * view's scope (null = the dashboard as saved).
 */
export async function resolveFigures(projectId: string, a: Analysis, cardIds: string[] | null, view: SavedView | null): Promise<Figures> {
  const scope = viewScope(view, a);
  const values = paramValues(scope.params);
  const want = cardIds ? new Set(cardIds) : null;
  const cards = a.sheets.flatMap((s) => s.cards || []).filter((c) => sendable(c) && (!want || want.has(c.id)));
  const tile = (c: Card): FilterStep[] => [...scope.filters, ...((view && view.state.tiles[c.id]) || [])];
  let dataAt: string | null = null;
  const seen = (r: any): void => { // any: a reply's asOf
    const at = r && r.asOf && typeof r.asOf.at === 'string' ? r.asOf.at : null;
    if (at && (dataAt === null || at > dataAt)) dataAt = at;
  };

  const metricCards = cards.filter((c) => c.type === 'metric');
  const tiles: any[] = metricCards.length // any: analysis:tiles' reply per item
    ? await call('analysis:tiles', {
      projectId,
      params: scope.params,
      items: metricCards.map((c) => {
        const m = c.metric!;
        return { kind: 'metric', datasetId: m.datasetId, column: m.column, aggregation: m.aggregation, filters: tile(c), ...(m.metricId ? { metricId: m.metricId } : {}), ...(m.compare ? { compare: m.compare } : {}) };
      }),
    })
    : [];
  const kpis: KpiFigure[] = metricCards.map((c, i) => {
    const m = c.metric!;
    const r = Array.isArray(tiles) ? tiles[i] : null;
    const label = substituteText(m.label || (r && r.name) || m.column || '', values);
    if (!r || r.ok === false) return { label, display: '—', error: why(r) };
    seen(r);
    const value = typeof r.value === 'number' ? r.value : null;
    const k: KpiFigure = { label, display: typeof r.display === 'string' ? r.display : value === null ? '—' : formatValue(value, m.format || 'auto') };
    const cmp = r.compare;
    if (cmp && cmp.ok && cmp.reason !== 'no_date_filter') {
      k.compare = {
        pct: typeof cmp.pct === 'number' ? cmp.pct : null,
        delta: typeof cmp.delta === 'number' ? cmp.delta : null,
        label: String(cmp.label || ''),
        ...(typeof cmp.deltaDisplay === 'string' ? { deltaDisplay: (cmp.delta < 0 ? '−' : '+') + cmp.deltaDisplay } : {}),
        ...(cmp.direction ? { direction: cmp.direction } : {}),
      };
    }
    return k;
  });

  const out: VisualFigure[] = [];
  for (const c of cards.filter((x) => x.type === 'visual')) {
    const v = c.visual ?? (c.visualId ? await visuals.getVisual(projectId, c.visualId) : null);
    if (!v) continue;
    const title = substituteText(v.name || '', values);
    const chartType = typeof v.chartType === 'string' && v.chartType ? v.chartType : 'column';
    const analytics = (v as { analytics?: unknown[] }).analytics;
    const r = await call('visual:data', {
      projectId, datasetId: v.datasetId, encoding: v.encoding, filters: mergeDashboardFilters(tile(c), v.filters || []), params: scope.params, share: 'report',
      ...(Array.isArray(analytics) && analytics.length ? { analytics } : {}),
    });
    if (!r || !r.ok) {
      out.push({ title, chartType, note: why(r) });
      continue;
    }
    seen(r);
    const data = r.data || { labels: [], series: [] };
    const caption = await call('reports:caption', { input: { chartType, data, geo: data.geo || null, pivot: data.pivot || null, projectId, datasetId: v.datasetId, overrides: v.overrides || null } });
    const format = (v.overrides as { numberFormat?: unknown } | undefined)?.numberFormat;
    out.push({
      title, chartType, data,
      ...(typeof caption === 'string' && caption ? { caption } : {}),
      ...(typeof format === 'string' ? { format } : {}),
      ...(typeof r.recommendedShape === 'string' ? { shape: r.recommendedShape } : {}),
    });
  }
  return { kpis, visuals: out, dataAt, found: cards.length };
}
