// Publish to folder — MAIN PROCESS. The orchestrator: which dashboards and
// stories, where, with what options; how big the result will be; writing it.
//
// A published site is a folder of static files: index.html (the nav), one
// page per dashboard or story, and manifest.json. Every page carries the app's
// own renderer and its data, pre-computed by the app (./dashboardData.ts,
// ./storyData.ts), sanitized (./sanitize.ts) and pinned by a CSP
// (./siteHtml.ts). Opening it needs no server and makes no request.
//
// THE 50 MB LIMIT. Size is dominated by the filter bar: one answer per tile per
// combination. `planPublish` estimates it BEFORE anything is computed in full
// (each tile's default answer × its combinations) and says what to drop;
// `publishSite` measures the real thing and refuses to write a site over the
// limit rather than leave a half-written folder.
//
// WRITING. Each file is written to a temp sibling and renamed. Files a
// PREVIOUS publish wrote (listed in its manifest.json, when that manifest is
// ours) and that this one no longer writes are removed; nothing else in the
// folder is ever touched.

import * as appPaths from '../app/paths';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as projects from '../app/projects';
import { projectDir, isValidId } from '../app/recordKinds';
import { getFormatPrefs } from '../app/format';
import { planCombos, summaryLine, formatBytes, DEFAULT_MAX_COMBOS } from './combos';
import { planDashboard, buildDashboard } from './dashboardData';
import type { Outgoing, PublishedDashboard } from './dashboardData';
import { buildStory } from './storyData';
import type { PublishedStory } from './storyData';
import { buildScorecard } from './scorecardData';
import type { PublishedScorecard } from './scorecardData';
import { geoFor } from './geoData';
import { sanitizePage } from './sanitize';
import { pageHtml } from './siteHtml';
import { sanitizeBrand } from '../analysis/dashboardExport';
import * as sharePolicy from '../app/sharePolicy';
import { readLogoDataUrl } from '../app/branding';
import type { SiteAssets } from './siteHtml';
import { listThemes } from '../app/themeStore';
import { themeModel } from '../analysis/themeTokens';
import * as recordFs from '../app/recordFs';

export const SITE_FORMAT = 'ordinate-site';
export const SITE_VERSION = 1;
export const MAX_SITE_BYTES = 50 * 1024 * 1024;
let maxSiteBytes = MAX_SITE_BYTES;
/** Test hook: a smaller limit, so the refusal can be exercised without 50 MB. */
export function setMaxBytesForTest(n: number): void {
  maxSiteBytes = n > 0 ? n : MAX_SITE_BYTES;
}
const MAX_TARGETS = 50;

export interface PublishOptions {
  /** Site title on index.html; defaults to the project name. */
  title?: string;
  /** Cap on filter-bar control combinations pre-aggregated per dashboard. */
  maxCombos?: number;
  /** Re-publish on its own after a dataset of this project refreshes. */
  afterRefresh?: boolean;
}

export interface PublishConfig {
  projectId: string;
  dashboardIds: string[];
  storyIds: string[];
  /** Scorecards (analysis/scorecards.ts), each one page for its latest period. */
  scorecardIds: string[];
  /** Absolute path of the output folder. */
  outDir: string;
  options: PublishOptions;
  /**
   * Per dashboard, the brand accent ramp — computed by the renderer's colour
   * code (chartPalette.brandTokens owns the contrast walk), exactly as the HTML
   * export receives it, and clamped by dashboardExport.sanitizeBrand. Absent
   * for a headless publish: the dashboard's named accent then applies.
   */
  brands?: Record<string, { ramp?: unknown }>;
}

export interface PublishProgress {
  progress?: (fraction: number, note?: string) => void;
  checkCancelled?: () => void;
}

export interface PublishResult {
  outDir: string;
  /** Paths relative to outDir, index.html and manifest.json included. */
  files: string[];
  bytes: number;
  combos: number;
}

// ── Config ───────────────────────────────────────────────────────────────────

/** Untrusted config (a renderer, a CLI file, an MCP call) → a PublishConfig, or why not. */
export function sanitizePublishConfig(raw: unknown): PublishConfig | { error: string } {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (!isValidId(o.projectId)) return { error: 'Choose a project.' };
  const ids = (v: unknown): string[] => [...new Set((Array.isArray(v) ? v : []).filter(isValidId))].slice(0, MAX_TARGETS);
  const dashboardIds = ids(o.dashboardIds);
  const storyIds = ids(o.storyIds);
  const scorecardIds = ids(o.scorecardIds);
  if (!dashboardIds.length && !storyIds.length && !scorecardIds.length) return { error: 'Pick at least one dashboard, story or scorecard.' };
  const outDir = typeof o.outDir === 'string' ? o.outDir.trim() : '';
  if (!outDir || !path.isAbsolute(outDir) || outDir.includes('\0')) return { error: 'Choose an output folder.' };
  const resolved = path.resolve(outDir);
  if (resolved === path.parse(resolved).root) return { error: 'Choose a folder, not the root of a disk.' };
  const opt = o.options && typeof o.options === 'object' ? (o.options as Record<string, unknown>) : {};
  const maxCombos = typeof opt.maxCombos === 'number' && Number.isFinite(opt.maxCombos)
    ? Math.min(2048, Math.max(1, Math.floor(opt.maxCombos))) : DEFAULT_MAX_COMBOS;
  const options: PublishOptions = { maxCombos };
  if (typeof opt.title === 'string' && opt.title.trim()) options.title = opt.title.trim().slice(0, 120);
  if (opt.afterRefresh === true) options.afterRefresh = true;
  const brands: Record<string, { ramp?: unknown }> = {};
  const rawBrands = o.brands && typeof o.brands === 'object' ? (o.brands as Record<string, unknown>) : {};
  for (const id of dashboardIds) {
    const b = rawBrands[id];
    const clean = b && typeof b === 'object' ? sanitizeBrand({ ramp: (b as Record<string, unknown>).ramp }) : {};
    if (clean.ramp) brands[id] = { ramp: clean.ramp };
  }
  return { projectId: o.projectId as string, dashboardIds, storyIds, scorecardIds, outDir: resolved, options, ...(Object.keys(brands).length ? { brands } : {}) };
}

/** A logo as a data: URL — the workspace's, or a dashboard's own — or undefined. */
async function logoFor(scope: string): Promise<string | undefined> {
  try {
    return (await readLogoDataUrl(appPaths.userData(), scope)) || undefined;
  } catch (_) {
    return undefined;
  }
}

function configFile(projectId: string): string {
  return path.join(projectDir(projectId), 'publish.json');
}

/** The choices the last Publish… used, for "Re-publish". Null when never published. */
export async function getStoredConfig(projectId: string): Promise<(PublishConfig & { lastPublishedAt?: string; lastBytes?: number }) | null> {
  if (!isValidId(projectId)) return null;
  try {
    const raw = JSON.parse(await recordFs.readFile(configFile(projectId), 'utf8'));
    const clean = sanitizePublishConfig({ ...raw, projectId });
    if ('error' in clean) return null;
    return {
      ...clean,
      ...(typeof raw.lastPublishedAt === 'string' ? { lastPublishedAt: raw.lastPublishedAt } : {}),
      ...(typeof raw.lastBytes === 'number' ? { lastBytes: raw.lastBytes } : {}),
    };
  } catch (_) {
    return null;
  }
}

export async function storeConfig(config: PublishConfig, result?: PublishResult): Promise<void> {
  const file = configFile(config.projectId);
  const body = {
    dashboardIds: config.dashboardIds,
    storyIds: config.storyIds,
    scorecardIds: config.scorecardIds,
    outDir: config.outDir,
    options: config.options,
    ...(config.brands ? { brands: config.brands } : {}),
    ...(result ? { lastPublishedAt: new Date().toISOString(), lastBytes: result.bytes } : {}),
  };
  const tmp = file + '.' + randomUUID() + '.tmp';
  await recordFs.writeFile(tmp, JSON.stringify(body, null, 2));
  await recordFs.rename(tmp, file);
}

// ── The share policy ─────────────────────────────────────────────────────────

/**
 * The project's Share policy on this path, as the builders' Outgoing hook:
 * labels drawn from a sensitive column become tokens (mask), or the tile is
 * hidden (drop, or a map, which cannot draw a token); `include` passes through
 * — the dialog asked first. Applied HERE, inside the engine, so every door
 * into a publish — the dialog, Re-publish, the after-refresh schedule, the
 * CLI, MCP — gets it without having to remember to.
 */
export function policyOutgoing(projectId: string, sharePath: 'publish' | 'export'): Outgoing {
  return async (datasetId, encoding, data) => {
    const r = await sharePolicy.applyToChart(projectId, datasetId, encoding, { ok: true as boolean, data }, sharePath);
    if (!r.ok || !r.data) return { hidden: (r as { error?: string }).error || sharePolicy.HIDDEN_BY_POLICY };
    return r.data as typeof data;
  };
}

// ── Assets ───────────────────────────────────────────────────────────────────

const ROOT = path.join(__dirname, '..', '..');

/** The app's own scripts, read off disk (inside the asar when packaged). */
export function readAssets(): SiteAssets {
  const read = (...p: string[]): string => {
    try { return fs.readFileSync(path.join(ROOT, ...p), 'utf8'); } catch (_) { return ''; }
  };
  return {
    chartJs: read('node_modules', 'chart.js', 'dist', 'chart.umd.min.js'),
    formatJs: read('src', 'app', 'format.js'),
    geoMatchJs: read('src', 'analysis', 'geoMatch.js'),
    coreJs: read('src', 'publish', 'site', 'publishCore.js'),
    clientJs: read('src', 'publish', 'site', 'publishClient.js'),
  };
}

/** A file name for a page: lower-case words, unique within the site. */
export function slugFor(name: string, taken: Set<string>): string {
  const base = (String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)) || 'page';
  let file = base + '.html';
  for (let i = 2; taken.has(file) || file === 'index.html'; i++) file = `${base}-${i}.html`;
  taken.add(file);
  return file;
}

// ── Plan ─────────────────────────────────────────────────────────────────────

export interface PlanPage {
  kind: 'dashboard' | 'story' | 'scorecard';
  id: string;
  name: string;
  combos: number;
  mode: 'all' | 'single';
  bytes: number;
  dropped: Array<{ control: string; options: string[] }>;
}

export interface PublishPlan {
  pages: PlanPage[];
  combos: number;
  bytes: number;
  maxBytes: number;
  tooBig: boolean;
  summary: string;
  /** What to drop to fit, biggest saving first, when `tooBig`. */
  suggestions: string[];
}

/**
 * The dialog's estimate: every page, its combinations, and its size — computed
 * from each tile's DEFAULT answer times its combinations (an upper bound: the
 * real site stores repeated answers once).
 */
export async function planPublish(config: PublishConfig, outgoing: Outgoing = policyOutgoing(config.projectId, 'publish')): Promise<PublishPlan> {
  const assets = readAssets();
  const fixed = Object.values(assets).reduce((n, s) => n + Buffer.byteLength(s), 0) + 8 * 1024;
  const pages: PlanPage[] = [];
  const saving: Array<{ text: string; bytes: number }> = [];
  const maxCombos = config.options.maxCombos || DEFAULT_MAX_COMBOS;
  for (const id of config.dashboardIds) {
    const planned = await planDashboard(config.projectId, id, maxCombos);
    if (!planned) continue;
    const one = await buildDashboard(config.projectId, id, maxCombos, {}, outgoing, { defaultOnly: true });
    const perCombo = one ? Buffer.byteLength(JSON.stringify(one.sheets)) : 0;
    const geo = one ? await geoFor(config.projectId, one.geoLevels, one.boundaryIds) : {};
    const combos = planned.plan.keys.length;
    const bytes = fixed + perCombo * combos + Buffer.byteLength(JSON.stringify(geo));
    pages.push({ kind: 'dashboard', id, name: planned.name, combos, mode: planned.plan.mode, bytes, dropped: planned.plan.dropped });
    // What removing each control would save: the plan without it.
    planned.specs.forEach((s, i) => {
      const without = planCombos(planned.specs.filter((_, j) => j !== i).map((x) => x.domain), maxCombos).keys.length;
      const cut = perCombo * (combos - without);
      if (cut > 0) saving.push({ text: `Remove the “${s.domain.label}” control from “${planned.name}” (${s.domain.options.length} options) — saves about ${formatBytes(cut)}`, bytes: cut });
    });
    saving.push({ text: `Leave out “${planned.name}” — saves about ${formatBytes(bytes)}`, bytes });
  }
  for (const id of config.storyIds) {
    const st = await buildStory(config.projectId, id, {}, outgoing);
    if (!st) continue;
    const geo = await geoFor(config.projectId, st.geoLevels, st.boundaryIds);
    const bytes = fixed + Buffer.byteLength(JSON.stringify(st)) + Buffer.byteLength(JSON.stringify(geo));
    pages.push({ kind: 'story', id, name: st.name, combos: 1, mode: 'all', bytes, dropped: [] });
  }
  for (const id of config.scorecardIds || []) {
    const sc = await buildScorecard(config.projectId, id);
    if (!sc) continue;
    pages.push({ kind: 'scorecard', id, name: sc.name, combos: 1, mode: 'all', bytes: fixed + Buffer.byteLength(JSON.stringify(sc)), dropped: [] });
  }
  const bytes = pages.reduce((n, p) => n + p.bytes, 0) + fixed; // + index.html
  const combos = pages.reduce((n, p) => n + (p.kind === 'dashboard' ? p.combos : 0), 0);
  const tooBig = bytes > maxSiteBytes;
  return {
    pages,
    combos,
    bytes,
    maxBytes: maxSiteBytes,
    tooBig,
    summary: summaryLine(combos, bytes),
    suggestions: tooBig ? saving.sort((a, b) => b.bytes - a.bytes).slice(0, 4).map((s) => s.text) : [],
  };
}

// ── Build and write ──────────────────────────────────────────────────────────

interface BuiltPage { file: string; kind: 'dashboard' | 'story' | 'scorecard'; id: string; name: string; html: string; combos: number; mode: string; dropped: unknown[] }

async function siteHeader(config: PublishConfig): Promise<{ title: string; logo?: string }> {
  const p = await projects.getProject(config.projectId);
  return { title: config.options.title || (p ? p.name : 'Published dashboards'), logo: await logoFor('workspace') };
}

/** Build every page in memory. Throws over the limit, before anything is written. */
export async function buildPages(config: PublishConfig, ctx: PublishProgress, outgoing?: Outgoing): Promise<{ pages: BuiltPage[]; index: string; combos: number }> {
  const assets = readAssets();
  const head = await siteHeader(config);
  const taken = new Set<string>();
  const targets: Array<{ kind: 'dashboard' | 'story' | 'scorecard'; id: string }> = [
    ...config.dashboardIds.map((id) => ({ kind: 'dashboard' as const, id })),
    ...config.storyIds.map((id) => ({ kind: 'story' as const, id })),
    ...(config.scorecardIds || []).map((id) => ({ kind: 'scorecard' as const, id })),
  ];
  const built: Array<{ kind: 'dashboard' | 'story' | 'scorecard'; id: string; name: string; file: string; data: PublishedDashboard | PublishedStory | PublishedScorecard }> = [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const slice = (f: number, note?: string) => ctx.progress && ctx.progress(0.9 * ((i + f) / targets.length), note);
    const sub = { progress: slice, checkCancelled: ctx.checkCancelled };
    const data = t.kind === 'dashboard'
      ? await recordFs.withReadMemo(() => buildDashboard(config.projectId, t.id, config.options.maxCombos || DEFAULT_MAX_COMBOS, sub, outgoing))
      : t.kind === 'story' ? await buildStory(config.projectId, t.id, sub, outgoing)
        : await buildScorecard(config.projectId, t.id, sub);
    if (!data) continue; // deleted since it was picked: publish the rest
    built.push({ kind: t.kind, id: t.id, name: data.name, file: slugFor(data.name, taken), data });
  }
  const nav = built.map((b) => ({ file: b.file, kind: b.kind, name: b.name }));
  const site = { title: head.title, nav, generatedAt: new Date().toISOString(), logo: head.logo };
  const formats = getFormatPrefs();
  const pages: BuiltPage[] = [];
  let combos = 0;
  const themes = await listThemes(); // a dashboard's workspace theme travels as tokens (themeStore.ts)
  for (const b of built) {
    const geo = await geoFor(config.projectId, b.data.geoLevels, b.data.boundaryIds);
    // Branding: the dashboard's accent ramp (from the renderer, see PublishConfig
    // .brands) and its logo — its own upload, none, or the workspace's.
    let brand: Record<string, unknown> | undefined;
    let theme: unknown;
    if (b.kind === 'dashboard') {
      const style = ((b.data as PublishedDashboard).style || {}) as { logo?: string; themeId?: string };
      const logo = style.logo === 'none' ? undefined : style.logo === 'custom' ? await logoFor(b.id) : head.logo;
      brand = { ramp: config.brands && config.brands[b.id] ? config.brands[b.id].ramp : undefined, logo };
      theme = themeModel.resolveTheme(style.themeId, themes.defaultId, themes.themes).theme || undefined;
    }
    const raw = b.kind === 'dashboard'
      ? { site, kind: 'dashboard', dashboard: b.data, brand, theme, formats, geo }
      : b.kind === 'story' ? { site, kind: 'story', story: b.data, formats, geo }
        : { site, kind: 'scorecard', scorecard: b.data, formats, geo };
    const page = sanitizePage(raw);
    const html = pageHtml(page, assets, `${b.name} · ${head.title}`);
    const d = b.kind === 'dashboard' ? (b.data as PublishedDashboard) : null;
    if (d) combos += d.keys.length;
    pages.push({ file: b.file, kind: b.kind, id: b.id, name: b.name, html, combos: d ? d.keys.length : 1, mode: d ? d.mode : 'all', dropped: d ? d.dropped : [] });
  }
  const index = pageHtml(sanitizePage({ site, kind: 'index', formats, geo: {} }), assets, head.title);
  const total = pages.reduce((n, p) => n + Buffer.byteLength(p.html), Buffer.byteLength(index));
  if (total > maxSiteBytes) {
    const worst = pages.slice().sort((a, b) => Buffer.byteLength(b.html) - Buffer.byteLength(a.html))[0];
    throw new Error(
      `The site would be ${formatBytes(total)} — over the ${formatBytes(maxSiteBytes)} limit. ` +
      (worst ? `“${worst.name}” alone is ${formatBytes(Buffer.byteLength(worst.html))}; lower its filter combinations or leave it out.` : ''),
    );
  }
  return { pages, index, combos };
}

async function writeAtomic(file: string, data: string): Promise<void> {
  const tmp = file + '.' + randomUUID() + '.tmp';
  await recordFs.writeFile(tmp, data);
  await recordFs.rename(tmp, file);
}

/** Files a previous publish of OURS wrote here, by its manifest. */
async function previousFiles(outDir: string): Promise<string[]> {
  try {
    const m = JSON.parse(await recordFs.readFile(path.join(outDir, 'manifest.json'), 'utf8'));
    if (!m || m.format !== SITE_FORMAT || !Array.isArray(m.pages)) return [];
    return m.pages.map((p: { file?: unknown }) => p && p.file).filter((f: unknown) => typeof f === 'string' && /^[a-z0-9][a-z0-9-]*\.html$/.test(f));
  } catch (_) {
    return [];
  }
}

/** Write the static site. Throws on failure (and over the size limit, before writing). */
export async function publishSite(
  config: PublishConfig,
  ctx: PublishProgress = {},
  outgoing: Outgoing = policyOutgoing(config.projectId, 'publish'),
): Promise<PublishResult> {
  const { pages, index, combos } = await buildPages(config, ctx, outgoing);
  if (ctx.checkCancelled) ctx.checkCancelled();
  if (ctx.progress) ctx.progress(0.92, 'Writing files');
  await fs.promises.mkdir(config.outDir, { recursive: true });
  const before = await previousFiles(config.outDir);
  const files: string[] = [];
  let bytes = 0;
  for (const p of pages) {
    await writeAtomic(path.join(config.outDir, p.file), p.html);
    files.push(p.file);
    bytes += Buffer.byteLength(p.html);
  }
  await writeAtomic(path.join(config.outDir, 'index.html'), index);
  bytes += Buffer.byteLength(index);
  const manifest = {
    format: SITE_FORMAT,
    version: SITE_VERSION,
    generatedAt: new Date().toISOString(),
    title: (await siteHeader(config)).title,
    pages: pages.map((p) => ({ file: p.file, kind: p.kind, id: p.id, name: p.name, combos: p.combos, mode: p.mode, bytes: Buffer.byteLength(p.html), dropped: p.dropped })),
    totalBytes: bytes,
    limits: { maxBytes: maxSiteBytes, maxCombos: config.options.maxCombos || DEFAULT_MAX_COMBOS },
    offline: true,
  };
  const manifestText = JSON.stringify(manifest, null, 2);
  await writeAtomic(path.join(config.outDir, 'manifest.json'), manifestText);
  bytes += Buffer.byteLength(manifestText);
  for (const old of before) {
    if (!files.includes(old)) await recordFs.rm(path.join(config.outDir, old), { force: true });
  }
  if (ctx.progress) ctx.progress(1);
  return { outDir: config.outDir, files: ['index.html', ...files, 'manifest.json'], bytes, combos };
}

/**
 * One dashboard as a single self-contained page — the same renderer and data
 * the published site uses, with no filter combinations beyond the default.
 * For `dashboards export --html` and, rendered offscreen, --pdf / --png.
 */
export async function dashboardPageHtml(
  projectId: string,
  dashboardId: string,
  // An export of one dashboard (the CLI's `dashboards export`) follows the EXPORT path's policy.
  outgoing: Outgoing = policyOutgoing(projectId, 'export'),
): Promise<string> {
  const d = await buildDashboard(projectId, dashboardId, 1, {}, outgoing, { defaultOnly: true });
  if (!d) throw new Error('Dashboard not found.');
  const geo = await geoFor(projectId, d.geoLevels, d.boundaryIds);
  const site = { title: d.name, nav: [], generatedAt: new Date().toISOString() };
  return pageHtml(sanitizePage({ site, kind: 'dashboard', dashboard: d, formats: getFormatPrefs(), geo }), readAssets(), d.name);
}
