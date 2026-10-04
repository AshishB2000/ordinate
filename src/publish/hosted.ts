// Publish to a URL (T2.9) — the server's home for a published site. MAIN.
//
// The desktop wrote a published site into a folder the user picked; a server
// has no such folder, so the SAME pages (./publish.ts buildPages: the same
// builders, the same Share policy, the same sanitizePage whitelist on top of
// dashboardExport.sanitizeBundle, the same pinned CSP) are kept as records of
// the org instead and served at /p/<publishId>/ (src/server/published.ts).
//
//   userData/published/<id>/manifest.json   who, when, what, who may open it
//   userData/published/<id>/<file>.json     { html } — one per page, index.html too
//
// `published/` is a record root (src/app/recordFs.ts): with Postgres each file
// is a row of the org, so every pod serves every site; without it, files on
// the org's disk. A published site is a SNAPSHOT: the figures were computed
// when it was published, and only a re-publish changes them.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as appPaths from '../app/paths';
import * as recordFs from '../app/recordFs';
import { isValidId } from '../app/recordKinds';
import * as analysis from '../analysis/analysis';
import * as visuals from '../analysis/visuals';
import { ctx, runInContext, serverDataDir } from '../server/context';
import { buildPages, policyOutgoing, sanitizePublishConfig, type PublishConfig, type PublishProgress } from './publish';

export type Access = 'org' | 'link';

export interface HostedPage {
  readonly file: string;
  readonly kind: 'dashboard' | 'story' | 'scorecard';
  readonly name: string;
}

export interface HostedSite {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  /** org: signed-in members of the org. link: anyone with the URL — only while the org allows public links. */
  readonly access: Access;
  readonly publishedBy: string;
  readonly publishedAt: string;
  readonly bytes: number;
  readonly combos: number;
  readonly pages: HostedPage[];
  /** What to build again on Re-publish. */
  readonly config: Pick<PublishConfig, 'dashboardIds' | 'storyIds' | 'scorecardIds' | 'options' | 'brands'>;
}

/** A page's file name as the site links it (publish.ts slugFor), or index.html. */
export const PAGE_RE = /^(index|[a-z0-9][a-z0-9-]{0,80})\.html$/;

const root = (): string => path.join(appPaths.userData(), 'published');
const dir = (id: string): string => path.join(root(), id);

async function writeJson(file: string, body: unknown): Promise<void> {
  // The stores' own rule (analysis.ts): the directory on disk, which a Postgres row does not need but never minds.
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await recordFs.writeFile(tmp, JSON.stringify(body));
  await recordFs.rename(tmp, file);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await recordFs.readFile(file, 'utf8')) as T;
  } catch {
    return null; // missing or corrupt: not published
  }
}

/** The manifest of site `id` in the caller's org, or null. */
export async function getSite(id: string): Promise<HostedSite | null> {
  if (!isValidId(id)) return null;
  const m = await readJson<HostedSite>(path.join(dir(id), 'manifest.json'));
  return m && m.id === id ? m : null;
}

/** One page's HTML, or null. */
export async function getPage(id: string, file: string): Promise<string | null> {
  if (!isValidId(id) || !PAGE_RE.test(file)) return null;
  const p = await readJson<{ html?: unknown }>(path.join(dir(id), `${file}.json`));
  return p && typeof p.html === 'string' ? p.html : null;
}

/** Every site published from `projectId`, newest first. */
export async function listSites(projectId: string): Promise<HostedSite[]> {
  let ids: string[] = [];
  try {
    ids = await recordFs.readdir(root());
  } catch {
    return [];
  }
  // ponytail: one manifest read per site of the org — an index row per site if an org publishes hundreds.
  const sites = await Promise.all(ids.filter(isValidId).map(getSite));
  return sites.filter((s): s is HostedSite => !!s && s.projectId === projectId).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

/**
 * Build and store a site; `id` re-publishes over an existing one (its link
 * stays). Pages the new build no longer has are removed after the manifest
 * switches, so a reader never meets a manifest naming a missing page.
 */
export async function publishHosted(
  /** Untrusted: a PublishConfig without its folder, re-sanitized here. */
  raw: object,
  by: string,
  opts: { id?: string; access?: Access; progress?: PublishProgress } = {},
): Promise<HostedSite> {
  // buildPages never writes: the folder sanitizePublishConfig insists on is a stand-in.
  const config = sanitizePublishConfig({ ...raw, outDir: appPaths.temp() });
  if ('error' in config) throw new Error(config.error);
  const prev = opts.id ? await getSite(opts.id) : null;
  if (opts.id && !prev) throw new Error('That published link no longer exists.');
  const id = prev ? prev.id : randomUUID();
  const { pages, index, combos } = await buildPages(config, opts.progress ?? {}, policyOutgoing(config.projectId, 'publish'));
  const files = [{ file: 'index.html', html: index }, ...pages.map((p) => ({ file: p.file, html: p.html }))];
  for (const f of files) await writeJson(path.join(dir(id), `${f.file}.json`), { html: f.html });
  const site: HostedSite = {
    id,
    projectId: config.projectId,
    title: config.options.title || '',
    access: opts.access ?? prev?.access ?? 'org',
    publishedBy: by,
    publishedAt: new Date().toISOString(),
    bytes: files.reduce((n, f) => n + Buffer.byteLength(f.html), 0),
    combos,
    pages: pages.map((p) => ({ file: p.file, kind: p.kind, name: p.name })),
    config: { dashboardIds: config.dashboardIds, storyIds: config.storyIds, scorecardIds: config.scorecardIds, options: config.options, ...(config.brands ? { brands: config.brands } : {}) },
  };
  await writeJson(path.join(dir(id), 'manifest.json'), site);
  const keep = new Set(files.map((f) => `${f.file}.json`));
  for (const old of prev ? ['index.html', ...prev.pages.map((p) => p.file)] : []) {
    if (!keep.has(`${old}.json`)) await recordFs.rm(path.join(dir(id), `${old}.json`), { force: true });
  }
  return site;
}

/** Change who may open a site. */
export async function setAccess(id: string, access: Access): Promise<HostedSite | null> {
  const site = await getSite(id);
  if (!site) return null;
  const next = { ...site, access };
  await writeJson(path.join(dir(id), 'manifest.json'), next);
  return next;
}

/** Take a site down: the manifest first (the link stops at once), then its pages. */
export async function removeSite(id: string): Promise<boolean> {
  const site = await getSite(id);
  if (!site) return false;
  await recordFs.rm(path.join(dir(id), 'manifest.json'), { force: true });
  await recordFs.rm(dir(id), { recursive: true, force: true });
  return true;
}

// ── Re-publish after a refresh (the desktop's publish.ts scheduleRepublish) ──
//
// A site published with "Re-publish after data refreshes" is rebuilt, at its
// own link, once a dataset it reads refreshes — the manual Refresh
// (ipc/datasets afterRefresh) and the scheduled tick (server/jobs/schedules)
// both end here. Debounced per project, so a tick that refreshes five
// datasets rebuilds once, after the last. Runs as the org it was asked in.

const REPUBLISH_DEBOUNCE_MS = 15_000;
let debounceMs = REPUBLISH_DEBOUNCE_MS;
const pending = new Map<string, { timer: NodeJS.Timeout; datasets: Set<string> }>();
let running: Promise<unknown> = Promise.resolve();

/** Test hook: a shorter debounce. */
export function setRepublishDelayForTest(ms: number): void {
  debounceMs = ms >= 0 ? ms : REPUBLISH_DEBOUNCE_MS;
}

/** Test hook: every scheduled re-publish has run. */
export async function republishSettled(): Promise<void> {
  while (pending.size) await new Promise((r) => setTimeout(r, 10));
  await running;
}

/** The datasets a site's dashboards read: KPI, control, statistics and visual cards. */
async function datasetsOf(site: HostedSite): Promise<Set<string> | null> {
  // ponytail: a story or scorecard counts as reading every dataset — rebuild it on any refresh, as the desktop did for the whole site.
  if (site.config.storyIds.length || site.config.scorecardIds.length) return null;
  const out = new Set<string>();
  for (const id of site.config.dashboardIds) {
    const a = await analysis.getAnalysis(site.projectId, id);
    for (const card of a ? a.sheets.flatMap((p) => p.cards) : []) {
      const c = card as unknown as { metric?: { datasetId?: string }; control?: { datasetId?: string }; stats?: { datasetId?: string }; visualId?: string };
      for (const d of [c.metric?.datasetId, c.control?.datasetId, c.stats?.datasetId]) if (d) out.add(d);
      if (c.visualId) {
        const v = await visuals.getVisual(site.projectId, c.visualId);
        if (v) out.add(v.datasetId);
      }
    }
  }
  return out;
}

/** Rebuild every opted-in site of `projectId` that reads one of `datasetIds`. */
export async function republishUsing(projectId: string, datasetIds: ReadonlySet<string>): Promise<string[]> {
  const done: string[] = [];
  for (const site of await listSites(projectId)) {
    if (!site.config.options.afterRefresh) continue;
    const uses = await datasetsOf(site);
    if (uses && ![...datasetIds].some((d) => uses.has(d))) continue;
    try {
      await publishHosted({ projectId, ...site.config }, site.publishedBy, { id: site.id });
      done.push(site.id);
    } catch (err) {
      console.error('[publish] re-publish after refresh failed:', err instanceof Error ? err.message : String(err));
    }
  }
  return done;
}

/** A dataset of `projectId` refreshed: schedule the re-publish (server only; the desktop has its own job hook). */
export function scheduleRepublish(projectId: string, datasetId: string): void {
  if (serverDataDir() === null) return;
  const who = ctx();
  const key = `${who.org.id}\u0000${projectId}`;
  const prev = pending.get(key);
  if (prev) clearTimeout(prev.timer);
  const datasets = prev ? prev.datasets.add(datasetId) : new Set([datasetId]);
  const timer = setTimeout(() => {
    pending.delete(key);
    running = running.then(() => runInContext({ user: who.user, org: who.org }, 'republish', () => republishUsing(projectId, datasets))).catch(() => undefined);
  }, debounceMs);
  timer.unref();
  pending.set(key, { timer, datasets });
}
