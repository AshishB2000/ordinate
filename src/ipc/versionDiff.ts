import { ipcMain } from './bus';
import * as versions from '../app/versions';
import * as visuals from '../analysis/visuals';
import * as analysis from '../analysis/analysis';
import * as metricsStore from '../analysis/metrics';
import { sanitizeDashboardFilters } from '../analysis/dashboards';
import type { CardMetric } from '../analysis/dashboards';
import { paramValues, resolveFilterParams } from '../analysis/params';
import type { ParamValues } from '../analysis/params';
import type { FilterStep } from '../data/transforms';
import { canonical, contentOf } from '../analysis/recordDiff';
import { diffVersions } from '../analysis/versionDiff';
import type { Change, Counts, FigureAsk, StructDiff, TitleOf } from '../analysis/versionDiff';
import type { Rec } from '../analysis/versionDiffParts';
import * as M from '../analysis/versionDiffMessages';
import { formatValue } from '../app/format';
import { t } from '../app/i18n';
import { computeCardMetric } from './dashboards';
import { previewDefinition, resolveMetric } from './metrics';
import { liveCodeOf } from './liveRoute';
import { gateRows } from '../data/rowAccess';

// What changed between two saved versions (docs/version-diff/00-design.md).
//
//   versions:diff     the structural diff, worded: a summary line, every change as
//                     a sentence, and a dashboard's layout per sheet with each tile
//                     classified. File reads only — fast.
//   versions:figures  the KPI cards whose figure may have moved, each side's spec
//                     computed NOW on current data through the card's own door
//                     (computeCardMetric / resolveMetric, previewDefinition for a
//                     metric version) — so a Live dataset is asked of its warehouse
//                     and a refusal stays typed. Never a stored figure.

type Input = { projectId?: unknown; type?: unknown; id?: unknown; from?: unknown; to?: unknown };

/** Chart ids to the catalog's chart names (web/src/charts/vizLabels.ts prints the same keys). */
const CHART_KEY: Record<string, string> = {
  bar: 'renderResult.bar', clustered_column: 'renderResult.clustered_column', clustered_bar: 'renderResult.clustered_bar',
  stacked_column: 'renderResult.stacked_column', stacked_bar: 'renderResult.stacked_bar',
  pct_stacked_column: 'renderResult.100_stacked_column', pct_stacked_bar: 'renderResult.100_stacked_bar',
  line: 'renderResult.line', line_markers: 'renderResult.line_with_markers', area: 'renderResult.area', stacked_area: 'renderResult.stacked_area',
  pie: 'renderResult.pie', donut: 'renderResult.donut', scatter: 'renderResult.scatter', gauge: 'renderResult.gauge',
  combo: 'renderResult.line_column', bubble: 'renderResult.bubble', treemap: 'renderResult.treemap', heatmap: 'renderResult.heatmap',
  funnel: 'renderResult.funnel', histogram: 'renderResult.histogram', sankey: 'renderResult.sankey', candlestick: 'renderResult.candlestick',
  boxplot: 'renderResult.box_plot', waterfall: 'renderResult.waterfall', bullet: 'renderResult.bullet', calendar: 'renderResult.calendar_heatmap',
  radar: 'renderResult.radar', pareto: 'renderResult.pareto', pivot: 'renderResult.pivot_table', cohort: 'common.cohort',
  event_funnel: 'renderResult.event_funnel', table: 'common.table', map_bubble: 'renderResult.bubble_map', map_choropleth: 'renderResult.region_map',
  word_cloud: 'renderResult.word_cloud', map_hexbin: 'renderResult.hexbin_map', map_flow: 'renderResult.flow_map',
};

function chartName(id: string | number | undefined): string {
  const s = String(id ?? '');
  if (s === 'column') return M.columnChart();
  if (!s) return '—';
  return CHART_KEY[s] ? t(CHART_KEY[s]) : s.replace(/_/g, ' ');
}

/** Every card of a dashboard version, for collecting the visuals it names. */
function cardsOf(rec: Rec): Rec[] {
  const out: Rec[] = [];
  for (const s of Array.isArray(rec.sheets) ? rec.sheets : []) for (const c of Array.isArray(s && s.cards) ? s.cards : []) if (c && typeof c === 'object') out.push(c);
  return out;
}

/** Names a card the way the reader knows it: a visual by its Visual record's current name. */
async function titler(projectId: string, records: Rec[]): Promise<TitleOf> {
  const ids = new Set<string>();
  const trees = new Set<string>();
  for (const r of records) {
    for (const c of cardsOf(r)) {
      if (c.type === 'visual' && typeof c.visualId === 'string') ids.add(c.visualId);
      if (c.type === 'metricTree' && c.metricTree && typeof c.metricTree.metricId === 'string') trees.add(c.metricTree.metricId);
    }
  }
  const names = new Map<string, string>();
  for (const id of ids) {
    const v = await visuals.getVisual(projectId, id).catch(() => null);
    if (v) names.set(id, v.name);
  }
  // A Metric tree card is titled by its metric: "Revenue tree".
  const metricNames = new Map<string, string>();
  for (const id of trees) {
    const m = await metricsStore.getMetric(projectId, id).catch(() => null);
    if (m) metricNames.set(id, m.name);
  }
  return (c: Rec): string => {
    if (c.type === 'visual') return names.get(String(c.visualId || '')) || (c.visual && typeof c.visual.name === 'string' && c.visual.name) || M.deletedVisual();
    if (c.type === 'metric' && c.metric) return String(c.metric.label || `${c.metric.aggregation}(${c.metric.column})`);
    if (c.type === 'text' && typeof c.heading === 'string' && c.heading.trim()) return c.heading.trim();
    if (c.type === 'metricTree' && c.metricTree) {
      const name = metricNames.get(String(c.metricTree.metricId || ''));
      return name ? M.treeCardTitle(name) : M.treeCardDeleted();
    }
    if (c.type === 'control' && c.control) return String(c.control.label || c.control.column || '') || M.untitledCard(String(c.type));
    return M.untitledCard(String(c.type || ''));
  };
}

/** One change as a sentence. Exhaustive: a new kind without words fails tsc. */
export function sentence(c: Change): string {
  const p = c.params;
  const s = (k: string): string => String(p[k] ?? '');
  const n = (k: string): number => Number(p[k]) || 0;
  switch (c.kind) {
    case 'name': return M.titleChanged(s('from'), s('to'));
    case 'style': return M.styleChanged();
    case 'description': return M.descriptionEdited();
    case 'sheet.added': return M.sheetAdded(s('name'));
    case 'sheet.removed': return M.sheetRemoved(s('name'));
    case 'sheet.renamed': return M.sheetRenamed(s('from'), s('to'));
    case 'sheet.reordered': return M.sheetsReordered();
    case 'filter.added': return M.filterAdded(s('filter'));
    case 'filter.removed': return M.filterRemoved(s('filter'));
    case 'filter.changed': return M.filterChanged(s('from'), s('to'));
    case 'card.added': return M.cardAdded(s('title'), s('sheet'));
    case 'card.removed': return M.cardRemoved(s('title'), s('sheet'));
    case 'card.movedSheet': return M.cardMovedSheet(s('title'), s('from'), s('to'));
    case 'card.movedRow': return M.cardMovedRow(s('title'), n('from'), n('to'));
    case 'card.movedWithin': return M.cardMovedWithin(s('title'), n('row'));
    case 'card.resized': return M.cardResized(s('title'), s('from'), s('to'));
    case 'card.type': return M.cardTypeChanged(s('title'));
    case 'card.renamed': return M.cardRenamed(s('from'), s('to'));
    case 'card.visualSwapped': return M.cardVisualSwapped(s('from'), s('to'));
    case 'card.chartType': return M.cardChartType(s('title'), chartName(p.from), chartName(p.to));
    case 'card.encoding': return M.cardEncoding(s('title'));
    case 'card.visualFilters': return M.cardVisualFilters(s('title'));
    case 'card.actions': return M.cardActions(s('title'));
    case 'card.measure': return M.cardMeasure(s('title'), s('from'), s('to'));
    case 'card.savedMetric': return M.cardSavedMetric(s('title'));
    case 'card.dataset': return M.cardDataset(s('title'));
    case 'card.format': return M.cardFormat(s('title'));
    case 'card.compare': return M.cardCompare(s('title'));
    case 'card.calc': return M.cardCalc(s('title'));
    case 'card.scenario': return M.cardScenario(s('title'));
    case 'card.text': return M.cardText(s('title'));
    case 'card.control': return M.cardControl(s('title'));
    case 'card.settings': return M.cardSettings(s('title'));
    case 'card.treeRoot': return M.cardTreeRoot(s('from'), s('to'));
    case 'visual.chartType': return M.chartChanged(chartName(p.from), chartName(p.to));
    case 'visual.category': return M.categoryChanged(s('from'), s('to'));
    case 'visual.series': return M.splitChanged(s('from'), s('to'));
    case 'visual.measureAdded': return M.measureAdded(s('measure'));
    case 'visual.measureRemoved': return M.measureRemoved(s('measure'));
    case 'visual.grain': return M.grainChanged();
    case 'visual.bins': return M.binsChanged();
    case 'visual.geo': return M.mapLevelChanged();
    case 'visual.pivot': return M.pivotChanged();
    case 'visual.styling': return M.stylingChanged();
    case 'metric.definition': return M.definitionChanged(s('from'), s('to'));
    case 'metric.format': return M.metricFormatChanged();
    case 'metric.direction': return M.directionChanged();
    case 'metric.tree': return M.metricTreeChanged(s('from'), s('to'));
    case 'report.format': return M.reportFormat(s('from'), s('to'));
    case 'report.dashboard': return M.reportDashboard();
    case 'report.pagesAdded': return M.pagesAdded(n('n'));
    case 'report.pagesRemoved': return M.pagesRemoved(n('n'));
    case 'report.pagesIncluded': return M.pagesIncluded(n('n'));
    case 'report.pagesExcluded': return M.pagesExcluded(n('n'));
    case 'report.pagesEdited': return M.pagesEdited(n('n'));
    case 'report.pagesReordered': return M.pagesReordered();
    case 'report.cover': return M.coverEdited();
    case 'report.paper': return M.paperChanged();
    case 'report.schedule': return M.scheduleChanged();
    case 'report.includeFilters': return M.includeFiltersChanged();
    case 'report.narrative': return M.narrativeChanged();
    case 'step.added': return M.stepAdded(s('step'));
    case 'step.removed': return M.stepRemoved(s('step'));
    case 'step.reordered': return M.stepsReordered();
    case 'table.columns': return M.tableColumnsChanged();
    case 'table.rowsAdded': return M.rowsAdded(n('n'));
    case 'table.rowsRemoved': return M.rowsRemoved(n('n'));
    case 'table.cells': return M.cellsEdited(n('n'));
    default: {
      const never: never = c.kind;
      return String(never);
    }
  }
}

/** "3 cards changed, 1 card added, 1 card removed, a filter changed". */
export function summaryLine(c: Counts): string {
  const parts: string[] = [];
  if (c.changed) parts.push(M.cardsChanged(c.changed));
  if (c.added) parts.push(M.cardsAdded(c.added));
  if (c.removed) parts.push(M.cardsRemoved(c.removed));
  if (c.moved) parts.push(M.cardsMoved(c.moved));
  if (c.filters) parts.push(M.filtersChanged(c.filters));
  if (c.other) parts.push(parts.length ? M.otherChanges(c.other) : M.changesCount(c.other));
  if (!parts.length) return M.noChanges();
  const line = parts.join(', ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}

interface Pair {
  type: 'dataset' | 'visual' | 'dashboard' | 'metric' | 'report';
  projectId: string;
  id: string;
  a: versions.VersionFile;
  b: versions.VersionFile;
  keys: [string, string];
}

/** Both versions, or the reason there are not two to compare. */
async function readPair(input: Input): Promise<Pair | { ok: false; error: string }> {
  const projectId = String(input.projectId || '');
  const id = String(input.id || '');
  const type = input.type;
  if (!versions.isVersionType(type)) return { ok: false, error: M.versionGone() };
  // A dataset's versions are its whole table (row-policy D9). A visual's diff never words its overrides' values.
  if (type === 'dataset') await gateRows(projectId, id);
  const keys: [string, string] = [String(input.from || ''), String(input.to || '')];
  const [a, b] = await Promise.all(keys.map((k) => versions.get(projectId, type, id, k)));
  if (!a || !b) return { ok: false, error: M.versionGone() };
  return { type, projectId, id, a, b, keys };
}

async function structOf(p: Pair): Promise<StructDiff> {
  const titleOf = p.type === 'dashboard' ? await titler(p.projectId, [p.a.record, p.b.record]) : () => '';
  return diffVersions(p.type, p.a.record, p.b.record, titleOf);
}

const side = (key: string, f: versions.VersionFile) => ({ key, savedAt: f.savedAt, ...(f.by ? { by: f.by } : {}) });

async function diff(input: Input) {
  const p = await readPair(input);
  if ('ok' in p) return p;
  const d = await structOf(p);
  return {
    ok: true as const,
    from: side(p.keys[0], p.a),
    to: side(p.keys[1], p.b),
    summary: summaryLine(d.counts),
    counts: d.counts,
    changes: d.changes.map((c) => ({
      group: c.group, kind: c.kind, text: sentence(c), ...(c.cardId ? { cardId: c.cardId } : {}), ...(c.words ? { words: c.words } : {}),
    })),
    sheets: d.sheets,
    figures: p.type === 'dashboard' ? d.figures.length : metricFigureNeeded(p) ? 1 : 0,
  };
}

// ── Figures ──────────────────────────────────────────────────────────────────

export type FigureSide = { ok: true; value: number | null; display: string } | { ok: false; error: string; code?: string };

/** A failure kept typed: a Live code and its catalog sentence, else a plain sentence of ours. */
function failed(err: unknown): FigureSide {
  const live = liveCodeOf(err);
  if (live.code) return { ok: false, code: live.code, error: err instanceof Error ? err.message : M.figureFailed() };
  return { ok: false, error: M.figureFailed() };
}

/** One KPI card's figure under `filters`, through the card's own door. */
export async function cardFigure(projectId: string, m: CardMetric, filters: FilterStep[], params: ParamValues): Promise<FigureSide> {
  try {
    if (m.metricId) {
      const r = await resolveMetric(projectId, m.metricId, { filters, params });
      if (r) return { ok: true, value: r.value, display: r.display };
      // A deleted saved metric: the card's own column and aggregation, as the card falls back to them.
    }
    const res = await computeCardMetric(projectId, m.datasetId, { column: m.column, aggregation: m.aggregation }, filters, params);
    if (!res.ok) return { ok: false, error: M.figureGone() };
    return { ok: true, value: res.value, display: res.value === null ? '—' : formatValue(res.value, m.format) };
  } catch (err) {
    return failed(err);
  }
}

const REASON: Record<FigureAsk['reason'], () => string> = {
  measure: M.reasonMeasure, filters: M.reasonFilters, added: M.reasonAdded, removed: M.reasonRemoved,
};

const moved = (a: FigureSide | null, b: FigureSide | null): boolean =>
  !a || !b || !a.ok || !b.ok || !Object.is(a.value, b.value);

async function dashboardFigures(p: Pair) {
  const d = await structOf(p);
  // Parameters are not part of a version: both sides take the dashboard's current values.
  const current = await analysis.getAnalysis(p.projectId, p.id).catch(() => null);
  const params = paramValues(current ? current.parameters : []);
  const scope = (rec: Rec): FilterStep[] => resolveFilterParams(sanitizeDashboardFilters(contentOf('dashboard', rec).filters), params).steps;
  const fa = scope(p.a.record);
  const fb = scope(p.b.record);
  const out = [];
  for (const f of d.figures) {
    const before = f.before ? await cardFigure(p.projectId, f.before, fa, params) : null;
    const after = f.after ? await cardFigure(p.projectId, f.after, fb, params) : null;
    out.push({ cardId: f.cardId, title: f.title, reason: REASON[f.reason](), before, after, moved: moved(before, after) });
  }
  return out;
}

function metricFigureNeeded(p: Pair): boolean {
  if (p.type !== 'metric') return false;
  const a = contentOf('metric', p.a.record);
  const b = contentOf('metric', p.b.record);
  return canonical([a.definition, a.filters]) !== canonical([b.definition, b.filters]);
}

async function metricFigures(p: Pair) {
  if (!metricFigureNeeded(p)) return [];
  const metric = await metricsStore.getMetric(p.projectId, p.id);
  if (!metric) return [];
  const one = async (rec: Rec): Promise<FigureSide> => {
    try {
      const r = await previewDefinition(p.projectId, metric.datasetId, rec.definition, rec.filters, rec.format ?? metric.format, String(rec.name || metric.name));
      return { ok: true, value: r.value, display: r.display };
    } catch (err) {
      return failed(err);
    }
  };
  const before = await one(p.a.record);
  const after = await one(p.b.record);
  return [{ cardId: p.id, title: String(p.b.record.name || metric.name), reason: M.reasonDefinition(), before, after, moved: moved(before, after) }];
}

async function figures(input: Input) {
  const p = await readPair(input);
  if ('ok' in p) return p;
  const rows = p.type === 'dashboard' ? await dashboardFigures(p) : await metricFigures(p);
  return { ok: true as const, figures: rows };
}

export function register(): void {
  ipcMain.handle('versions:diff', async (_e, input: Input = {}) => diff(input));
  ipcMain.handle('versions:figures', async (_e, input: Input = {}) => figures(input));
}
