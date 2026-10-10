// Automation handlers — MAIN PROCESS. What each registry entry DOES.
//
// Every handler calls the same main-process function the matching IPC channel
// calls, then returns a WHITELISTED projection of the result: a new object
// built field by field, never a stored record passed through. That is the
// secrets rule made structural — a dataset's origin (file path, URL, connection
// id, SQL) and a capture's crop path never appear in output because nothing
// copies them, not because something strips them.
//
// Where row VALUES or LABELS leave the app through automation, the project's
// Share policy (src/app/sharePolicy.ts) applies on its EXPORT path: SQL rows
// and chart labels from sensitive columns are masked or dropped, insights
// about them are withheld, and exported files are built by code that already
// applies it (publish.dashboardPageHtml, the report renderer's share path).

import * as fs from 'fs';
import * as path from 'path';
import * as appPaths from '../app/paths';
import * as projects from '../app/projects';
import * as datasets from '../data/datasets';
import * as sqlDatasets from '../engine/sqlDatasets';
import { viewColumns } from '../engine/datasetView';
import { sourceKindForPath, storedKind } from '../data/fileImport';
import { parseAnyFile } from '../data/parquetImport';
import { refreshAsJob } from '../data/refreshJob';
import { refreshDependents } from '../data/datasetDependents';
import { runQualityChecks } from '../analysis/qualityRun';
import * as metrics from '../analysis/metrics';
import { describeDefinitionShort } from '../analysis/metricFormat';
import * as analysis from '../analysis/analysis';
import * as reportSpec from '../analysis/reportSpec';
import * as publishing from '../publish/publish';
import { resolveMetric } from '../ipc/metrics';
import { insightsForDataset } from '../ipc/insights';
import { evaluateAndDeliver } from '../ipc/alerts';
import { AutomationError } from './errors';
import { defaultProject, pick, resolveProject, runJob } from './resolve';
import type { Ctx } from './registry';
import * as sharePolicy from '../app/sharePolicy';
import * as privacyStore from '../app/privacyStore';

export { resolveProject };
export { aggregate, createVisual, createDashboard } from './creators';

// ── Lookups ──────────────────────────────────────────────────────────────────

async function datasetFor(ctx: Ctx, ref: string): Promise<datasets.DatasetSummary> {
  return pick(await datasets.listDatasets(ctx.projectId), ref, 'dataset');
}

// ── Projects and datasets ────────────────────────────────────────────────────

export async function projectsList(ctx?: Ctx): Promise<unknown> {
  const list = (await projects.listProjects()).filter((p) => !ctx?.canRead || ctx.canRead(p.id));
  const def = defaultProject(list);
  return list.map((p) => ({
    id: p.id,
    name: p.name,
    updatedAt: p.updatedAt,
    lastOpenedAt: p.lastOpenedAt || null,
    archived: Boolean(p.archivedAt),
    default: Boolean(def && def.id === p.id),
  }));
}

export async function datasetsList(ctx: Ctx): Promise<unknown> {
  return (await datasets.listDatasets(ctx.projectId)).map((d) => ({
    id: d.id,
    name: d.name,
    source: d.sourceKind,
    // A Live dataset keeps no rows here: its count is unknown, never a zero (L2.1, D6).
    mode: d.mode === 'live' ? 'live' : 'extract',
    rows: d.mode === 'live' ? null : d.rowCount,
    columns: d.columnCount,
    updatedAt: d.updatedAt,
    // listDatasets already withholds a capture's origin, so this is "has a
    // re-fetchable source" — the same test the Data page's ↻ uses.
    refreshable: Boolean(d.originKind),
    lastRefreshedAt: d.lastRefreshedAt || null,
    qualityFailing: d.qualityFailing || 0,
  }));
}

/**
 * Columns, declared types and the names SQL sees. `origin` is its KIND only:
 * the path, URL, connection id or query behind it is withheld — a tool that
 * wants to know where data came from is told what sort of source it is.
 */
export async function datasetsDescribe(ctx: Ctx, ref: string): Promise<unknown> {
  const d = await datasetFor(ctx, ref);
  const meta = await datasets.getDatasetMeta(ctx.projectId, d.id);
  if (!meta) throw new AutomationError('not_found', `Dataset "${ref}" could not be read.`);
  const cat = (await sqlDatasets.projectCatalog(ctx.projectId)).find((e) => e.id === d.id);
  const sqlCols = viewColumns(meta.columns);
  return {
    id: meta.id,
    name: meta.name,
    source: meta.sourceKind,
    origin: meta.origin ? meta.origin.kind : null,
    mode: meta.mode === 'live' ? 'live' : 'extract',
    rowCount: meta.mode === 'live' ? null : meta.rowCount,
    // The slug is always a plain identifier SQL accepts; the alias (the name as
    // typed, quoted) works too when there is one.
    sqlName: cat ? cat.slug : null,
    sqlAlias: cat && cat.alias && cat.alias !== cat.slug ? cat.alias : null,
    queryable: cat ? cat.queryable : false,
    columns: meta.columns.map((c, i) => ({ name: c.name, type: c.type, sqlName: sqlCols[i] ? sqlCols[i].name : c.name })),
    prepareSteps: Array.isArray(meta.steps) ? meta.steps.length : 0,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    lastRefreshedAt: meta.lastRefreshedAt || null,
    lastRefreshStatus: meta.lastRefreshStatus || null,
  };
}

/** The same three calls the composer's file import makes: parse, save, check. */
export async function datasetsImport(ctx: Ctx, file: string, name: string): Promise<unknown> {
  const abs = path.resolve(ctx.cwd, file);
  const kind = sourceKindForPath(abs);
  if (!kind) throw new AutomationError('usage', 'Only .csv, .json and .xlsx files can be imported.');
  if (!fs.existsSync(abs)) throw new AutomationError('not_found', `No file at ${abs}.`);
  const dsName = name.trim() || path.basename(abs, path.extname(abs));
  return runJob(
    { kind: 'import', label: `Import ${path.basename(abs)}`, projectId: ctx.projectId },
    async (progress) => {
      progress(0.1, 'Reading the file');
      ctx.progress(`Reading ${path.basename(abs)}…`);
      const parsed = await parseAnyFile(abs, kind);
      progress(0.6, `Saving ${parsed.rowCount.toLocaleString('en-US')} rows`);
      ctx.progress(`Saving ${parsed.rowCount.toLocaleString('en-US')} rows…`);
      const saved = await datasets.saveDataset(ctx.projectId, {
        name: dsName, sourceKind: storedKind(kind), columns: parsed.columns, rows: parsed.rows,
        origin: { kind: 'file', path: abs },
      });
      if (!saved) throw new AutomationError('runtime', 'Could not save the dataset.');
      await runQualityChecks(ctx.projectId, saved.id); // never throws
      return { id: saved.id, name: saved.name, rows: saved.rowCount, columns: saved.columns.length, warnings: parsed.warnings };
    },
    (r) => `${r.rows.toLocaleString('en-US')} rows`,
  );
}

/**
 * `dataset:refresh`'s own sequence, through its own door (src/data/refreshJob.ts:
 * the job, the queue per dataset, the lock across pods, the announcement), with
 * the dependents AWAITED — the process exits after.
 */
export async function datasetsRefresh(ctx: Ctx, ref: string): Promise<unknown> {
  const d = await datasetFor(ctx, ref);
  ctx.progress(`Refreshing ${d.name}…`);
  const res = await refreshAsJob(ctx.projectId, d.id);
  if (!res.ok) throw new AutomationError('runtime', res.error);
  await evaluateAndDeliver(ctx.projectId, d.id);
  await runQualityChecks(ctx.projectId, d.id);
  await refreshDependents(ctx.projectId, d.id);
  return { id: d.id, name: res.dataset.name, rows: res.dataset.rowCount, refreshedAt: res.dataset.lastRefreshedAt || null, warnings: res.warnings };
}

// ── SQL, metrics, insights ───────────────────────────────────────────────────

export async function query(ctx: Ctx, sql: string, limit: number): Promise<unknown> {
  const res = await sqlDatasets.runSql(ctx.projectId, sql, [], limit);
  if (!res.ok) throw new AutomationError('runtime', res.error);
  // Every dataset the statement read shapes the result by column name.
  // ponytail: an alias (`SELECT email AS e`) is not traced back to its source
  // column; the SQL lineage (res.used) would be the upgrade.
  let table: { columns: any[]; rows: any[][] } = { columns: res.columns.map((c) => ({ name: c.name, type: 'text' })), rows: res.rows }; // any: SQL result cells
  const masked: string[] = [];
  const dropped: string[] = [];
  for (const dsId of res.deps || []) {
    const t = await sharePolicy.applyToTable(ctx.projectId, dsId, table, 'export');
    masked.push(...t.masked);
    dropped.push(...t.dropped);
    table = { columns: t.columns, rows: t.rows };
  }
  const kept = new Set(table.columns.map((c) => c.name));
  return {
    columns: res.columns.filter((c) => kept.has(c.name)).map((c) => ({ name: c.name, type: c.type })),
    rows: table.rows,
    ...(masked.length || dropped.length ? { sharePolicy: { masked: [...new Set(masked)], dropped: [...new Set(dropped)] } } : {}),
    rowCount: res.rowCount,
    truncated: res.truncated,
    elapsedMs: res.elapsedMs,
  };
}

export async function metricsList(ctx: Ctx): Promise<unknown> {
  const names = new Map((await datasets.listDatasets(ctx.projectId)).map((d) => [d.id, d.name]));
  return (await metrics.listMetrics(ctx.projectId)).map((m) => ({
    id: m.id,
    name: m.name,
    dataset: names.get(m.datasetId) || null,
    definition: describeDefinitionShort(m.definition),
    description: m.description || '',
  }));
}

export async function metricValue(ctx: Ctx, ref: string): Promise<unknown> {
  const byName = await metrics.metricsByName(ctx.projectId);
  const m = byName.get(ref.trim().toLowerCase()) || (await metrics.getMetric(ctx.projectId, ref.trim()));
  if (!m) throw new AutomationError('not_found', `No metric called "${ref}".`);
  const r =await resolveMetric(ctx.projectId, m.id, {});
  if (!r) throw new AutomationError('not_found', `No metric called "${ref}".`);
  // A single app-computed figure, like a dashboard KPI: the Share policy
  // passes aggregates through (it shapes labels and rows, not totals).
  return { id: r.id, name: r.name, value: r.value, display: r.display, definition: r.definitionText };
}

export async function insights(ctx: Ctx, ref: string): Promise<unknown> {
  const d = await datasetFor(ctx, ref);
  const found = await insightsForDataset(ctx.projectId, d.id);
  // An insight's sentence names values of its column; one about a sensitive
  // column is withheld under mask/drop rather than half-masked.
  const policy = await privacyStore.getPolicy(ctx.projectId);
  const sens = policy.export === 'include' ? new Map() : await sharePolicy.sensitiveColumns(ctx.projectId, d.id);
  return found.filter((i) => !(i.column && sens.has(i.column))).map((i) => ({
    kind: i.kind, severity: i.severity, title: i.title, detail: i.detail, column: i.column || null, facts: i.facts,
  }));
}

// ── Dashboards, reports, publish ─────────────────────────────────────────────

export async function dashboardsList(ctx: Ctx): Promise<unknown> {
  const reports = await reportSpec.listReports(ctx.projectId);
  return (await analysis.listAnalyses(ctx.projectId)).map((a) => ({
    id: a.id,
    name: a.name,
    sheets: a.sheetCount,
    updatedAt: a.updatedAt,
    reports: reports.filter((r) => r.analysisId === a.id).map((r) => ({ id: r.id, name: r.name, format: r.format })),
  }));
}

export async function dashboardsExport(ctx: Ctx, ref: string, format: string, out: string): Promise<unknown> {
  const a = pick(await analysis.listAnalyses(ctx.projectId), ref, 'dashboard');
  const html = await publishing.dashboardPageHtml(ctx.projectId, a.id);
  // PNG and PDF were drawn in a hidden desktop window, which went with the
  // desktop app (T8.1); the page itself is the export now.
  if (format !== 'html') throw new AutomationError('runtime', `A ${format.toUpperCase()} export was drawn by the desktop app, which is gone — export as html.`);
  const bytes = Buffer.from(html, 'utf8');
  // Built by publish.dashboardPageHtml, which applies the EXPORT share policy.
  const dest = await writeOutput(ctx, out, safeFileName(a.name, 'dashboard') + '.' + format, bytes);
  return { path: dest, format, bytes: bytes.length };
}

export async function reportsRun(ctx: Ctx, ref: string, out: string): Promise<unknown> {
  void out;
  const summary = pick(await reportSpec.listReports(ctx.projectId), ref, 'report');
  // The report renderer was a hidden desktop window, which went with the desktop
  // app (T8.1); a report is generated from its page in the web app.
  throw new AutomationError('runtime', `"${summary.name}" was generated by the desktop app, which is gone — generate it from the report's page.`);
}

/** Read the file, fill the project from --project when it names none, then the contract's own sanitizer. */
export async function publish(ctx: Ctx, file: string): Promise<unknown> {
  const abs = path.resolve(ctx.cwd, file);
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.promises.readFile(abs, 'utf8'));
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ENOENT') throw new AutomationError('not_found', `No publish config at ${abs}.`);
    throw new AutomationError('usage', `${abs} is not valid JSON.`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AutomationError('usage', 'A publish config is a JSON object.');
  const o = { ...(raw as Record<string, unknown>) };
  if (!o.projectId) o.projectId = ctx.projectId;
  // A relative outDir is relative to the CONFIG FILE, like any config that names paths.
  if (typeof o.outDir === 'string' && o.outDir && !path.isAbsolute(o.outDir)) o.outDir = path.resolve(path.dirname(abs), o.outDir);
  const config = publishing.sanitizePublishConfig(o);
  if ('error' in config) throw new AutomationError('usage', config.error);
  return runJob(
    { kind: 'publish', label: `Publish to ${path.basename(config.outDir)}`, projectId: config.projectId },
    (progress) => publishing.publishSite(config, {
      progress: (f, note) => { progress(f, note); if (note) ctx.progress(note); },
    }),
    (r) => `${r.files.length} files`,
  );
}

// ── Output files ─────────────────────────────────────────────────────────────

export function safeFileName(name: string, fallback: string): string {
  const s = String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 100);
  return s || fallback;
}

/**
 * Where an export lands. The CLI writes where it was told (`--out`, a file or
 * an existing folder) or into the current directory. MCP never takes a path —
 * a remote caller naming a file to write is a file-write primitive — so it
 * always writes a NEW file into Downloads/Ordinate.
 */
export async function writeOutput(ctx: Ctx, out: string, fileName: string, bytes: Buffer): Promise<string> {
  let dest: string;
  if (ctx.transport === 'cli') {
    const target = out ? path.resolve(ctx.cwd, out) : ctx.cwd;
    const isDir = fs.existsSync(target) && fs.statSync(target).isDirectory();
    dest = isDir ? path.join(target, fileName) : target;
  } else {
    const dir = path.join(appPaths.downloads(), 'Ordinate');
    await fs.promises.mkdir(dir, { recursive: true });
    const ext = path.extname(fileName);
    const base = fileName.slice(0, fileName.length - ext.length);
    dest = path.join(dir, fileName);
    for (let n = 2; fs.existsSync(dest); n++) dest = path.join(dir, `${base} (${n})${ext}`);
  }
  const tmp = dest + '.' + process.pid + '.tmp';
  try {
    await fs.promises.writeFile(tmp, bytes);
    await fs.promises.rename(tmp, dest);
  } catch (e) {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw new AutomationError('runtime', `Could not write ${dest}: ${(e as Error).message}`);
  }
  return dest;
}
