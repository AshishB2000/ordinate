// A report's (or a story's) PAGES, resolved on the server — the web port of the
// desktop's the desktop's reportRender.ts buildReportPages, reportScorecard.ts,
// reportDiscussion.ts and storyPresent.ts stReportPages (T2.13).
//
// One description of a page — a title, a picture, a caption, a KPI table, some
// bullets — that the browser's preview and its three writers (PDF, PPTX, DOCX)
// each draw in their own medium. What changed from the desktop is WHERE it is
// resolved: every figure, sentence and display string is decided here, and a
// chart travels as the server's own `visual:data` reply (`chart`) that the
// browser turns into a picture with the shared chart engine. The browser lays
// out and draws; it composes no number.
//
// The I/O is injected (`PageDeps`, wired to the registered handlers by
// src/ipc/reportsServer.ts), so this file is the assembly and nothing else.

import { t } from '../app/i18n';
import { formatDate, formatDateRange, formatValue } from '../app/format';
import { describePeriod, getCalendar } from './dateIntel';
import { mergeDashboardFilters } from './dashboardFilters';
import { substituteText, paramValues } from './params';
import { plainParagraphs, storyPages, type StoryBlockLike } from './storyText';
import type { Report, ReportPage } from './reportSpec';
import type { FilterStep } from '../data/transforms';

/** A chart the browser draws: the server's reply, the visual's chart type and its overrides. */
export interface PageChart {
  type: string;
  data: unknown;
  overrides: Record<string, unknown>;
  datasetId: string;
}
export interface PageTile {
  title: string;
  chart?: PageChart | null;
  /** A picture that is already one (a story's image block). */
  png?: string | null;
  /** Why there is no picture (hidden by the Share policy, or a grid the browser cannot draw yet). */
  note?: string;
}
export interface RenderedPage {
  kind: string;
  title: string;
  subtitle?: string;
  caption?: string;
  body?: string;
  chart?: PageChart | null;
  png?: string | null;
  note?: string;
  tiles?: PageTile[];
  kpis?: Array<{ label: string; value: string }>;
  grid?: { head: string[][]; body: string[][] } | null;
  bullets?: string[];
  meta?: string[];
  /** Cover only: 'mark' (Ordinate's), a logo data: URL (the dashboard's or the workspace's), or null (Style says none). */
  logo?: string | null;
  layout?: string;
}

type Params = Array<{ name: string; kind: string; value: unknown; min?: number; max?: number }>;
type AnyCard = { id: string; type: string; visualId?: string; metric?: any; control?: any; [k: string]: unknown }; // any: dashboards.CardMetric, read loosely
export interface PageAnalysis {
  id: string;
  name: string;
  sheets: Array<{ name: string; cards: AnyCard[] }>;
  style?: Record<string, unknown>;
}
export interface VisualRec {
  id: string;
  name: string;
  datasetId: string;
  chartType: string;
  encoding: unknown;
  overrides?: Record<string, unknown>;
  filters?: FilterStep[];
  analytics?: unknown[];
}
export interface ScoreSnapshot {
  name: string;
  window?: { label: string; from: string; to: string } | null;
  counts: Record<string, number>;
  rows: Array<{ name: string; display: string; targetDisplay: string; attainmentDisplay: string; status: string; deltaDisplay: string; pctDisplay: string; owner?: string; group?: string }>;
}
export interface CommentsReply {
  comments: Array<{ target: { kind: string; id: string; point?: { label: string; series?: string } }; author?: string; body: string; createdAt: string; resolvedAt?: string | null; replies?: Array<{ author?: string; body: string; createdAt: string }> }>;
  targets: Record<string, { name: string }>;
}

/** Everything the assembly reads, each answered by the handler that answers it alone. */
export interface PageDeps {
  visual(id: string): Promise<VisualRec | null>;
  /** `visual:data` ON THE SHARE PATH 'report' — the Share policy decides what may leave. */
  vizData(v: VisualRec, filters: FilterStep[], params: Params): Promise<{ ok: boolean; data?: any; error?: string; hiddenByPolicy?: boolean }>; // any: a visual:data reply
  metric(m: any, filters: FilterStep[], params: Params): Promise<{ value: number | null; display?: string; name?: string }>; // any: a card's metric
  metricValue(id: string, filters: FilterStep[]): Promise<{ name: string; display: string; value: number | null } | null>;
  caption(input: Record<string, unknown>): Promise<string>;
  sensitivity(analysisId: string): Promise<string[]>;
  summaryLines(a: PageAnalysis, filters: FilterStep[], params: Params): Promise<string[]>;
  narrative(analysisId: string, captions: string[]): Promise<string>;
  scorecard(id: string): Promise<ScoreSnapshot | null>;
  /** The cover's mark as a data: URL — the dashboard's own logo, else the workspace's; null → Ordinate's. */
  logo(a: PageAnalysis): Promise<string | null>;
  comments(): Promise<CommentsReply>;
  today(): string;
}

/** Pivot / cohort / funnel tiles are tables, not canvases: their grids reach the browser with T1.2. */
const GRID_TYPES = new Set(['pivot', 'cohort', 'event_funnel']);
const STATUS_KEY: Record<string, string> = { good: 'common.on_track', warn: 'common.at_risk', off: 'common.off_track', none: 'common.no_target' };
const AGG: Record<string, string> = { sum: t('common.sum'), avg: t('reportPages.average'), count: t('common.count'), min: t('common.min'), max: t('common.max') };

function statusWord(s: string): string {
  return STATUS_KEY[s] ? t(STATUS_KEY[s]) : '';
}

/** "<label> = <value>" for every control on the dashboard, at its saved default (dashShare.ts formatControlSummaryPart). */
export function filterLine(a: PageAnalysis): string {
  const parts: string[] = [];
  for (const sheet of a.sheets) {
    for (const card of sheet.cards || []) {
      const c = card && card.type === 'control' ? card.control : null;
      if (!c || c.kind === 'parameter') continue;
      const cur = c.default || {};
      let value = '';
      if (c.kind === 'multi') {
        const vals: string[] = Array.isArray(cur.values) ? cur.values.map(String) : [];
        value = vals.length > 5 ? t('dashShare.and_more', { p0: vals.slice(0, 5).join(', '), p1: vals.length - 5 }) : vals.join(', ');
      } else if (c.kind === 'date_range') {
        value = cur.preset && cur.preset !== 'custom' ? describePeriod(cur, getCalendar()) : cur.from || cur.to ? formatDateRange(cur.from, cur.to) : '';
      } else {
        value = typeof cur.value === 'string' ? cur.value : '';
      }
      if (value) parts.push((c.label || t('common.filter')) + ' = ' + value);
    }
  }
  return parts.length ? t('common.filtered', { p0: parts.join(' · ') }) : '';
}

interface Tile { title: string; chart: PageChart | null; caption: string; note?: string }

/**
 * Resolve a report's pages under `filters` / `params`, in order, skipping the
 * pages the author unchecked. Each card is resolved at most once even when it
 * appears on its sheet page and on its own tile page.
 */
export async function buildReportPages(
  report: Report,
  analysis: PageAnalysis,
  scope: { filters: FilterStep[]; params: Params },
  deps: PageDeps,
): Promise<RenderedPage[]> {
  const sheets = analysis.sheets || [];
  const values = paramValues(scope.params);
  const cache = new Map<string, Promise<Tile | null>>();

  const resolveTile = async (card: AnyCard): Promise<Tile | null> => {
    const v = card.visualId ? await deps.visual(card.visualId) : null;
    if (!v) return null;
    const title = substituteText(v.name || '', values);
    const type = typeof v.chartType === 'string' && v.chartType ? v.chartType : 'column';
    const res = await deps.vizData(v, mergeDashboardFilters(scope.filters, v.filters || []), scope.params);
    // A tile the policy hides keeps its place and says why, rather than vanishing from the page.
    if (res && res.hiddenByPolicy) return { title, chart: null, caption: String(res.error || ''), note: String(res.error || '') };
    if (!res || !res.ok) return null;
    const data = res.data || { labels: [], series: [] };
    const caption = await deps.caption({
      chartType: type, data, geo: data.geo || null, pivot: data.pivot || null,
      projectId: report.projectId, datasetId: v.datasetId, overrides: v.overrides || null,
    });
    const grid = GRID_TYPES.has(type);
    return {
      title,
      chart: grid ? null : { type, data, overrides: v.overrides || {}, datasetId: v.datasetId },
      caption,
      ...(grid ? { note: t('reportPages.this_table_prints_once_pivot_and') } : {}),
    };
  };
  const tileFor = (card: AnyCard): Promise<Tile | null> => {
    if (!cache.has(card.id)) cache.set(card.id, resolveTile(card).catch(() => null));
    return cache.get(card.id) as Promise<Tile | null>;
  };
  const kpisOf = async (sheet: { cards: AnyCard[] }): Promise<Array<{ label: string; value: number | null; text: string }>> => {
    const out: Array<{ label: string; value: number | null; text: string }> = [];
    for (const card of sheet.cards || []) {
      if (!card || card.type !== 'metric' || !card.metric) continue;
      const m = card.metric;
      const r = await deps.metric(m, scope.filters, scope.params).catch(() => ({ value: null }) as { value: number | null; display?: string; name?: string });
      const label = substituteText(m.label || r.name || `${AGG[m.aggregation] || m.aggregation} · ${m.column || ''}`, values);
      const value = typeof r.value === 'number' ? r.value : null;
      out.push({ label, value, text: r.display ?? (value === null ? '—' : formatValue(value, m.format || 'auto')) });
    }
    return out;
  };
  const kpiCaption = (kpis: Array<{ label: string; value: number | null }>): Promise<string> =>
    kpis.length ? deps.caption({ kpis: kpis.map((k) => ({ label: k.label, value: k.value })) }).catch(() => '') : Promise.resolve('');

  // The summary page needs every tile's sentence, and it is usually the SECOND page.
  const wanted = report.pages.some((p) => p.include !== false && (p.kind === 'summary' || p.kind === 'narrative'));
  const allCaptions: string[] = [];
  const allKpis: Array<{ label: string; text: string }> = [];
  if (wanted) {
    allCaptions.push(...(await deps.summaryLines(analysis, scope.filters, scope.params).catch(() => [])));
    for (const sheet of sheets) {
      const kpis = await kpisOf(sheet);
      allKpis.push(...kpis);
      const kc = await kpiCaption(kpis);
      if (kc) allCaptions.push(kc);
      for (const card of sheet.cards || []) {
        if (!card || card.type !== 'visual') continue;
        const tv = await tileFor(card);
        if (tv && tv.caption && !tv.note) allCaptions.push((tv.title ? tv.title + ' — ' : '') + tv.caption);
      }
    }
  }

  const out: RenderedPage[] = [];
  for (const page of report.pages) {
    if (page.include === false) continue;
    const rp = await onePage(page);
    if (rp) out.push(rp);
  }
  return out;

  async function onePage(page: ReportPage): Promise<RenderedPage | null> {
    switch (page.kind) {
      case 'cover': {
        const meta = [deps.today()];
        if (report.includeFilters !== false) {
          const line = filterLine(analysis);
          if (line) meta.push(line);
        }
        if (analysis.id) meta.push(...(await deps.sensitivity(analysis.id).catch(() => [])));
        const style = analysis.style || {};
        const none = report.cover.logo === false || style.logo === 'none';
        return {
          kind: 'cover', layout: page.layout,
          title: report.cover.title || report.name || t('common.report'),
          subtitle: report.cover.subtitle || '',
          meta,
          logo: none ? null : (await deps.logo(analysis).catch(() => null)) || 'mark',
        };
      }
      case 'summary':
        return { kind: 'summary', layout: page.layout, title: t('common.summary'), kpis: allKpis.map((k) => ({ label: k.label, value: k.text })), bullets: allCaptions.slice(), caption: page.caption };
      case 'sheet': {
        const sheet = sheets[Number(page.sheetIdx) || 0];
        if (!sheet) return null;
        const tiles: PageTile[] = [];
        for (const card of sheet.cards || []) {
          if (!card || card.type !== 'visual') continue;
          const tv = await tileFor(card);
          if (tv) tiles.push({ title: tv.title, chart: tv.chart, ...(tv.note ? { note: tv.note } : {}) });
        }
        const kpis = await kpisOf(sheet);
        const caption = page.caption || (await kpiCaption(kpis));
        return { kind: 'sheet', layout: page.layout, title: sheet.name || t('common.sheet'), kpis: kpis.map((k) => ({ label: k.label, value: k.text })), tiles, caption };
      }
      case 'tile': {
        const card = sheets.flatMap((s) => s.cards || []).find((c) => c && c.id === page.cardId);
        if (!card) return { kind: 'tile', layout: page.layout, title: t('common.tile'), body: t('reportRender.this_tile_is_no_longer_on') };
        const tv = await tileFor(card);
        if (!tv) return { kind: 'tile', layout: page.layout, title: t('common.tile'), body: t('reportRender.this_tile_could_not_be_drawn') };
        return { kind: 'tile', layout: page.layout, title: tv.title || t('common.tile'), chart: tv.chart, ...(tv.note ? { note: tv.note } : {}), caption: page.caption || tv.caption };
      }
      case 'notes':
        return { kind: 'notes', layout: page.layout, title: t('common.notes'), body: page.notes || '' };
      case 'narrative': {
        // Dropped, never waited on: no model, a failure or a slow answer leaves the report without it.
        const body = allCaptions.length && analysis.id ? await deps.narrative(analysis.id, allCaptions).catch(() => '') : '';
        return body ? { kind: 'narrative', layout: page.layout, title: t('common.narrative'), body } : null;
      }
      case 'scorecard':
        return page.scorecardId ? scorecardPage(page, await deps.scorecard(page.scorecardId).catch(() => null)) : null;
      case 'discussion':
        return discussionPage(page, analysis, await deps.comments().catch(() => ({ comments: [], targets: {} })));
      default:
        return null;
    }
  }
}

/** reportScorecard.ts: the status count, then a native table of the server's display strings. */
export function scorecardPage(page: ReportPage, sc: ScoreSnapshot | null): RenderedPage {
  if (!sc) return { kind: 'scorecard', layout: page.layout, title: t('common.scorecard'), body: t('reportScorecard.this_scorecard_is_no_longer_in') };
  const summary = ['good', 'warn', 'off'].map((k) => `${sc.counts[k] || 0} ${statusWord(k).toLowerCase()}`).join(' · ')
    + (sc.counts.none ? t('reportScorecard.without_a_target', { none: sc.counts.none }) : '');
  const grouped = sc.rows.some((r) => r.group);
  const body = sc.rows.map((r) => {
    const change = r.deltaDisplay ? r.deltaDisplay + (r.pctDisplay ? ` (${r.pctDisplay})` : '') : '—';
    const row = [String(r.name), r.display || '—', r.targetDisplay || '—', r.attainmentDisplay || '—', statusWord(r.status), change, r.owner || ''];
    if (grouped) row.unshift(r.group || t('common.other'));
    return row;
  });
  const head = [t('common.metric'), sc.window ? sc.window.label : t('common.value'), t('common.target'), t('common.attainment'), t('common.status'), t('common.vs_previous'), t('common.owner')];
  if (grouped) head.unshift(t('common.group'));
  return {
    kind: 'scorecard', layout: page.layout,
    title: sc.name || t('common.scorecard'),
    subtitle: sc.window ? `${sc.window.label} · ${sc.window.from} – ${sc.window.to}` : '',
    caption: page.caption || summary,
    grid: body.length ? { head: [head], body } : null,
    ...(body.length ? {} : { body: t('reportScorecard.no_metrics_on_this_scorecard') }),
  };
}

/** reportDiscussion.ts: the dashboard's threads, open first, a bullet per reply. Plain text: Markdown is for the screen. */
export function discussionPage(page: ReportPage, a: PageAnalysis, res: CommentsReply): RenderedPage {
  const cards = new Set<string>();
  const visuals = new Set<string>();
  for (const sheet of a.sheets || []) {
    for (const card of sheet.cards || []) {
      if (!card) continue;
      cards.add(card.id);
      if (card.visualId) visuals.add(card.visualId);
    }
  }
  const threads = res.comments
    .filter((c) => (c.target.kind === 'analysis' && c.target.id === a.id) || (c.target.kind === 'card' && cards.has(c.target.id)) || (c.target.kind === 'visual' && visuals.has(c.target.id)))
    .sort((x, y) => (!x.resolvedAt !== !y.resolvedAt ? (x.resolvedAt ? 1 : -1) : String(x.createdAt).localeCompare(String(y.createdAt))));
  const open = threads.filter((c) => !c.resolvedAt).length;
  const day = (iso: string): string => formatDate(String(iso).slice(0, 10));
  const plain = (s: string): string => String(s || '').replace(/[*_`#>]/g, '').trim();
  const bullets: string[] = [];
  for (const c of threads) {
    const tv = c.target;
    const where = tv.kind === 'analysis' ? t('common.the_dashboard') : (res.targets[tv.kind + ':' + tv.id] || { name: '' }).name || t('reportDiscussion.a_tile');
    const point = tv.point ? ' (' + tv.point.label + (tv.point.series ? ' · ' + tv.point.series : '') + ')' : '';
    const state = c.resolvedAt ? t('common.resolved') : t('common.open');
    bullets.push(t('reportDiscussion.on', { state, p1: c.author || t('common.someone'), where, point, createdAt: day(c.createdAt), body: plain(c.body) }));
    for (const r of c.replies || []) bullets.push(`    ↳ ${r.author || t('common.someone')}, ${day(r.createdAt)}: ${plain(r.body)}`);
  }
  return {
    kind: 'discussion', layout: page.layout, title: t('common.discussion'),
    meta: [threads.length ? t('reportDiscussion.open_resolved', { open, p1: threads.length - open }) : t('reportDiscussion.no_one_has_commented_on_this')],
    bullets,
  };
}

type StoryBlock = StoryBlockLike & { visualId?: string; metricId?: string; metricIds?: string[]; filters?: FilterStep[]; caption?: string; src?: string; alt?: string };

/**
 * A story as report pages (storyPresent.ts stReportPages): a page per `#` / `##`
 * heading, its prose, its metric table, its charts with their captions.
 */
export async function storyReportPages(name: string, blocks: StoryBlock[], deps: Pick<PageDeps, 'visual' | 'vizData' | 'caption' | 'metricValue'>, projectId: string): Promise<RenderedPage[]> {
  const out: RenderedPage[] = [];
  for (const page of storyPages(blocks)) {
    const rp: RenderedPage = { kind: 'sheet', layout: 'full', title: page.heading || name };
    const paras: string[] = [];
    const kpis: Array<{ label: string; value: string }> = [];
    const pics: Array<{ title: string; chart: PageChart | null; png: string | null; caption: string; note?: string }> = [];
    for (const it of page.items) {
      const b = it.block;
      if (b.kind === 'text') paras.push(...plainParagraphs(it.text || ''));
      else if (b.kind === 'callout') paras.push(...plainParagraphs(b.text || '').map((p) => '▍ ' + p));
      else if (b.kind === 'metric' || b.kind === 'metrics_row') {
        const ids = b.kind === 'metric' ? [b.metricId as string] : b.metricIds || [];
        for (const id of ids) {
          const f = await deps.metricValue(id, b.filters || []).catch(() => null);
          kpis.push(f ? { label: f.name, value: f.display } : { label: t('common.missing_metric'), value: '—' });
        }
      } else if (b.kind === 'visual' && b.visualId) {
        const fig = await storyVisual(b, deps, projectId);
        if (!fig) continue;
        const own = typeof b.caption === 'string' && b.caption.trim() ? b.caption : '';
        pics.push({ title: fig.title, chart: fig.chart, png: null, caption: fig.note || own || fig.caption, ...(fig.note ? { note: fig.note } : {}) });
      } else if (b.kind === 'image' && b.src) {
        pics.push({ title: b.caption || b.alt || '', chart: null, png: b.src, caption: b.caption || '' });
      }
    }
    if (paras.length) rp.body = paras.join('\n\n');
    if (kpis.length) rp.kpis = kpis;
    if (pics.length === 1) Object.assign(rp, { chart: pics[0].chart, png: pics[0].png, caption: pics[0].caption, ...(pics[0].note ? { note: pics[0].note } : {}) });
    if (pics.length > 1) {
      rp.tiles = pics.map((p) => ({ title: p.title, chart: p.chart, png: p.png, ...(p.note ? { note: p.note } : {}) }));
      rp.caption = pics.map((p) => p.caption).filter(Boolean).join(' ');
    }
    out.push(rp);
  }
  return out;
}

/** One visual block: the saved visual under its own AND its pinned filters, with the app's caption (storyBlocks.ts stVisualData). */
export async function storyVisual(
  b: { visualId?: string; filters?: FilterStep[] },
  deps: Pick<PageDeps, 'visual' | 'vizData' | 'caption'>,
  projectId: string,
): Promise<{ title: string; visualId: string; datasetId: string; chart: PageChart | null; caption: string; note?: string } | null> {
  const v = b.visualId ? await deps.visual(b.visualId) : null;
  if (!v) return null;
  const type = v.chartType || 'column';
  const res = await deps.vizData(v, mergeDashboardFilters(b.filters || [], v.filters || []), []);
  if (res && res.hiddenByPolicy) return { title: v.name || '', visualId: v.id, datasetId: v.datasetId, chart: null, caption: '', note: String(res.error || '') };
  const data = res && res.ok && res.data ? res.data : { labels: [], series: [] };
  const caption = await deps.caption({ chartType: type, data, geo: data.geo || null, pivot: data.pivot || null, projectId, datasetId: v.datasetId, overrides: v.overrides || {} }).catch(() => '');
  const grid = GRID_TYPES.has(type);
  return {
    title: v.name || '', visualId: v.id, datasetId: v.datasetId,
    chart: grid ? null : { type, data, overrides: v.overrides || {}, datasetId: v.datasetId },
    caption: typeof caption === 'string' ? caption : '',
    ...(grid ? { note: t('reportPages.this_table_prints_once_pivot_and') } : {}),
  };
}
