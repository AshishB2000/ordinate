// Server-only batches for reports and stories (T2.13). On the desktop the
// renderer resolved a report page by page over instant IPC — a `visual:data`
// per tile, a `dashboard:metric` per KPI, a `reports:caption` per sentence. Over
// the network that is a chatty page (plan §9), and it would put the assembly of
// a report in the browser. Here the server resolves the WHOLE page list in one
// call (src/analysis/reportPages.ts), by calling the SAME registered handlers
// a single call would — so a batched figure cannot differ from the unbatched one
// (scripts/test-reportsServer.ts compares them with Object.is). The browser
// turns each `chart` into a picture and writes the file.
//
//   reports:open       the builder in one call: the record, the dashboard's sheets
//                      and visual cards by name, its saved views
//   report:preview     the pages of a (possibly unsaved) report — the builder
//   report:build       the same pages for a file about to leave (audited)
//   reports:generated  stamp "last generated" after the browser saved the file
//   story:figures      a story page's charts and metrics, one call
//   story:export       a story as report pages (audited)

import { ipcMain } from './bus';
import { handlers } from '../server/rpc';
import * as appPaths from '../app/paths';
import * as reportSpec from '../analysis/reportSpec';
import * as analysis from '../analysis/analysis';
import * as visuals from '../analysis/visuals';
import * as stories from '../analysis/stories';
import * as comments from '../app/comments';
import { readLogoDataUrl } from '../app/branding';
import { formatDate } from '../app/format';
import { t } from '../app/i18n';
import { todayIso } from '../analysis/dateIntel';
import { viewScope } from '../analysis/savedViews';
import { buildReportPages, storyReportPages, storyVisual, type PageAnalysis, type PageDeps, type VisualRec } from '../analysis/reportPages';
import { scorecardSnapshot } from './scorecards';
import { publicReport } from './reports';
import type { FilterStep } from '../data/transforms';

/** A registered handler, called as the RPC layer calls it. Missing → a refusal, never a throw. */
async function call(event: unknown, channel: string, payload: unknown): Promise<any> { // any: each handler's own reply
  const h = handlers.get(channel);
  if (!h) return { ok: false, error: `${channel} is not available` };
  try {
    return await h(event, payload);
  } catch (err: any) { // any: a handler's throw
    return { ok: false, error: err?.message || `${channel} failed` };
  }
}

/** How long a report waits for the optional model-written page (reportRender.ts reportNarrative). */
const NARRATIVE_MS = 30_000;

/** The handlers behind every page, bound to one project and one request. */
/** `share`: the reply leaves the app (a report, an export) — shaped by the Share policy. A story on screen is not. */
export function pageDeps(event: unknown, projectId: string, share = true): PageDeps & { datasets: Set<string> } {
  const datasets = new Set<string>();
  const visualCache = new Map<string, Promise<VisualRec | null>>();
  return {
    datasets,
    visual: (id) => {
      if (!visualCache.has(id)) visualCache.set(id, visuals.getVisual(projectId, id).then((v) => (v ? (v as unknown as VisualRec) : null), () => null));
      return visualCache.get(id) as Promise<VisualRec | null>;
    },
    vizData: (v, filters, params) => {
      datasets.add(v.datasetId);
      // The share path: what goes into a file is shaped by the project's Share policy.
      return call(event, 'visual:data', {
        projectId, datasetId: v.datasetId, encoding: v.encoding, filters, params, ...(share ? { share: 'report' } : {}),
        ...(Array.isArray(v.analytics) && v.analytics.length ? { analytics: v.analytics } : {}),
      });
    },
    metric: async (m, filters, params) => {
      const item = { kind: 'metric', datasetId: m.datasetId, column: m.column, aggregation: m.aggregation, filters, ...(m.metricId ? { metricId: m.metricId } : {}) };
      const out = await call(event, 'analysis:tiles', { projectId, params, items: [item] });
      const r = Array.isArray(out) ? out[0] : null;
      return r && r.ok ? { value: typeof r.value === 'number' ? r.value : null, display: r.display, name: r.name } : { value: null };
    },
    metricValue: async (id, filters) => {
      const r = await call(event, 'metric:value', { projectId, id, filters });
      return r && r.ok !== false && r.name ? { name: String(r.name), display: String(r.display ?? '—'), value: typeof r.value === 'number' ? r.value : null } : null;
    },
    caption: async (input) => {
      const r = await call(event, 'reports:caption', { input });
      return typeof r === 'string' ? r : '';
    },
    sensitivity: async (analysisId) => {
      const r = await call(event, 'catalog:sensitivity', { projectId, analysisId });
      return r && Array.isArray(r.lines) ? r.lines.map(String) : [];
    },
    // The Summary card's sentences lead the summary page — once `summary:compute`
    // is registered on the server (the Summary card is T2.9's); until then none.
    summaryLines: async (a, filters, params) => {
      if (!handlers.has('summary:compute') || !a.sheets.some((s) => (s.cards || []).some((c) => c && c.type === 'summary'))) return [];
      const r = await call(event, 'summary:compute', { projectId, analysisId: a.id, name: a.name, pages: a.sheets, filters, params, asOf: null, outbound: true });
      return r && r.ok && Array.isArray(r.sentences) ? r.sentences.map((x: { text: unknown }) => String(x.text)) : [];
    },
    narrative: async (analysisId, captions) => {
      const question = t('reportRender.write_exactly_two_short_paragraphs', { p0: captions.map((c) => '- ' + c).join('\n') });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), NARRATIVE_MS); });
      const r = await Promise.race([call(event, 'copilot:ask', { projectId, context: { kind: 'analysis', id: analysisId }, question }), late]);
      clearTimeout(timer);
      return r && r.ok !== false && typeof r.answer === 'string' ? r.answer.trim() : '';
    },
    scorecard: (id) => scorecardSnapshot(projectId, id),
    comments: async () => {
      const res = await comments.list(projectId);
      const list = res.ok ? res.comments.filter((c) => !c.deletedAt) : [];
      const targets: Record<string, { name: string }> = {};
      if (list.some((c) => c.target.kind === 'visual' || c.target.kind === 'card')) {
        const names = new Map<string, string>();
        for (const v of await visuals.listVisuals(projectId)) {
          names.set(v.id, v.name);
          targets['visual:' + v.id] = { name: v.name };
        }
        for (const s of await analysis.listAnalyses(projectId)) {
          const a = await analysis.getAnalysis(projectId, s.id);
          for (const sheet of a ? a.sheets : []) {
            for (const card of sheet.cards) {
              const name = card.visualId ? names.get(card.visualId) : card.metric ? card.metric.label : card.heading;
              if (name) targets['card:' + card.id] = { name };
            }
          }
        }
      }
      return { comments: list, targets };
    },
    logo: async (a) => {
      const scope = a.style && a.style.logo === 'custom' && a.id ? a.id : 'workspace';
      return readLogoDataUrl(appPaths.userData(), scope).catch(() => null);
    },
    today: () => formatDate(todayIso()),
  };
}

/** The Share policy's line for what is about to leave ("2 sensitive columns will be masked"), or null. */
async function shareNote(event: unknown, projectId: string, datasetIds: Set<string>): Promise<unknown> {
  if (!datasetIds.size) return null;
  const r = await call(event, 'privacy:summary', { projectId, path: 'report', datasetIds: [...datasetIds] });
  return r && r.ok && r.count ? { count: r.count, action: r.action, line: r.line } : null;
}

/** A report's dashboard — or the empty stand-in a scorecard report runs on (reportScorecard.ts reportAnalysisFor). */
async function analysisFor(projectId: string, report: reportSpec.Report): Promise<(PageAnalysis & { filters?: FilterStep[]; parameters?: any[]; views?: any[] }) | null> { // any: analysis.Parameter / SavedView, passed through
  const a = report.analysisId ? await analysis.getAnalysis(projectId, report.analysisId) : null;
  if (a) return a as unknown as PageAnalysis;
  return report.scorecardId ? { id: '', name: report.name, sheets: [], style: {} } : null;
}

/** The stored report with the builder's unsaved settings over it, every field re-sanitized. */
function withDraft(stored: reportSpec.Report, draft: any): reportSpec.Report { // any: an untrusted draft
  if (!draft || typeof draft !== 'object') return stored;
  const r: reportSpec.Report = { ...stored };
  if (typeof draft.name === 'string' && draft.name.trim()) r.name = draft.name.trim().slice(0, 200);
  if (draft.format !== undefined) r.format = reportSpec.sanitizeFormat(draft.format);
  if (draft.pages !== undefined) r.pages = reportSpec.sanitizePages(draft.pages);
  if (draft.cover !== undefined) r.cover = reportSpec.sanitizeCover(draft.cover);
  if (draft.paper !== undefined) r.paper = reportSpec.sanitizePaper(draft.paper);
  if (draft.includeFilters !== undefined) r.includeFilters = draft.includeFilters !== false;
  if (draft.narrative !== undefined) r.narrative = draft.narrative === true;
  if (draft.discussion !== undefined) r.discussion = draft.discussion === true;
  if (draft.viewId !== undefined) r.viewId = typeof draft.viewId === 'string' && draft.viewId ? draft.viewId : undefined;
  return r;
}

/**
 * Every page of a report under its view (savedViews.ts svReportPages): as saved
 * with none, under one view's scope, or — "every view" — the whole list once per
 * view, each section's cover subtitled with the view's name.
 */
async function reportPages(event: unknown, projectId: string, id: string, draft: unknown, only: number | undefined): Promise<any> { // any: the reply envelope
  const stored = await reportSpec.getReport(projectId, id);
  if (!stored) return { ok: false, error: 'That report is gone.' };
  let report = withDraft(stored, draft);
  const a = await analysisFor(projectId, report);
  if (!a) return { ok: false, error: 'The dashboard this report prints has been deleted.' };
  if (only !== undefined) {
    const page = report.pages[only];
    if (!page) return { ok: true, pages: [], share: null, date: formatDate(todayIso()) };
    report = { ...report, pages: [{ ...page, include: true }] };
  }
  const deps = pageDeps(event, projectId);
  const views: any[] = Array.isArray(a.views) ? a.views : []; // any: SavedView
  const pick = report.viewId === 'all' ? views : views.filter((v) => v.id === report.viewId);
  const pages = [];
  if (!pick.length) {
    pages.push(...(await buildReportPages(report, a, viewScope(null, a as never), deps)));
  } else {
    for (const v of pick) {
      const scope = viewScope(v, a as never);
      pages.push(...(await buildReportPages({ ...report, cover: { ...report.cover, subtitle: v.name } }, a, scope, deps)));
    }
  }
  return { ok: true, pages, share: await shareNote(event, projectId, deps.datasets), date: deps.today() };
}

type FigureBlock = { id: string; kind: string; visualId?: string; metricId?: string; metricIds?: string[]; filters?: FilterStep[] };

export function register(): void {
  ipcMain.handle('reports:open', async (_e, { projectId, id }: any = {}) => {
    const r = await reportSpec.getReport(projectId, id);
    if (!r) return { ok: false, error: 'That report is gone.' };
    const a = await analysisFor(projectId, r);
    const sheets = [];
    for (const s of a ? a.sheets : []) {
      const cards = [];
      for (const c of s.cards || []) {
        if (!c || c.type !== 'visual' || !c.visualId) continue;
        const v = await visuals.getVisual(projectId, c.visualId);
        cards.push({ id: c.id, name: v ? v.name : '', chartType: v ? v.chartType : '' });
      }
      sheets.push({ name: s.name, cards });
    }
    const views = a && Array.isArray((a as { views?: unknown }).views) ? ((a as { views: Array<{ id: string; name: string }> }).views).map((v) => ({ id: v.id, name: v.name })) : [];
    return { ok: true, report: publicReport(r), dashboard: a && a.id ? { id: a.id, name: a.name } : null, sheets, views, missing: !a };
  });

  const pagesHandler = async (event: unknown, { projectId, id, draft, page }: any = {}) => // any: the contract's parsed input
    reportPages(event, projectId, id, draft, typeof page === 'number' ? page : undefined);
  ipcMain.handle('report:preview', pagesHandler);
  ipcMain.handle('report:build', pagesHandler);

  // The browser saved the file; the record says when. No path — the file is on the reader's machine.
  ipcMain.handle('reports:generated', async (_e, { projectId, id }: any = {}) => {
    const r = await reportSpec.updateReport(projectId, id, { lastRunAt: new Date().toISOString() });
    return r ? { ok: true, lastRunAt: r.lastRunAt } : { ok: false, error: 'Report not found.' };
  });

  // A story page's figures: per block, the chart (with its app caption) or the metrics (with theirs).
  ipcMain.handle('story:figures', async (event, { projectId, blocks }: any = {}) => {
    const deps = pageDeps(event, projectId, false);
    const out: Record<string, unknown> = {};
    for (const b of (Array.isArray(blocks) ? blocks : []) as FigureBlock[]) {
      if (b.kind === 'visual') {
        out[b.id] = (await storyVisual(b, deps, projectId)) || { missing: true };
      } else if (b.kind === 'metric' || b.kind === 'metrics_row') {
        const ids = b.kind === 'metric' ? [b.metricId as string] : b.metricIds || [];
        const figures = [];
        for (const id of ids) figures.push((await deps.metricValue(id, b.filters || [])) || { name: t('common.missing_metric'), display: '—', value: null });
        const caption = b.kind === 'metric' ? await deps.caption({ kpis: figures.map((f) => ({ label: f.name, value: f.value })) }) : '';
        out[b.id] = { figures, caption };
      }
    }
    return { ok: true, blocks: out };
  });

  ipcMain.handle('story:export', async (event, { projectId, id }: any = {}) => {
    const s = await stories.getStory(projectId, id);
    if (!s) return { ok: false, error: 'That story could not be opened.' };
    const deps = pageDeps(event, projectId);
    const pages = await storyReportPages(s.name, s.blocks as never, deps, projectId);
    return { ok: true, name: s.name, pages, share: await shareNote(event, projectId, deps.datasets), date: deps.today() };
  });
}
