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
//   userData/published/<id>/defs.json       each dashboard's record and visuals AS PUBLISHED —
//                                           what an embed is built from (src/publish/embedPage.ts)
//
// `published/` is a record root (src/app/recordFs.ts): with Postgres each file
// is a row of the org, so every pod serves every site; without it, files on
// the org's disk. A published site is a SNAPSHOT: the figures were computed
// when it was published, and only a re-publish changes them.

import * as fs from 'fs';
import { anyPolicyClosedRecently, assertFanOutAllowed, fanOutScope, policyClosed } from '../data/rowAccess';
import { datasetsOfRoot } from '../server/subscriptions/figureDatasets';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as appPaths from '../app/paths';
import * as recordFs from '../app/recordFs';
import { isValidId } from '../app/recordKinds';
import * as analysis from '../analysis/analysis';
import * as visuals from '../analysis/visuals';
import { ctx, runInContext, serverDataDir } from '../server/context';
import { buildPages, policyOutgoing, sanitizePublishConfig, type PublishConfig, type PublishProgress } from './publish';
import type { PublishedDef } from './dashboardData';
import type { Visual } from '../analysis/visuals';

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
  /** The datasets the build read (row-policy D10): the page is not served once one has row access rules. Absent before. */
  readonly datasetIds?: readonly string[];
  /** What to build again on Re-publish. */
  readonly config: Pick<PublishConfig, 'dashboardIds' | 'storyIds' | 'scorecardIds' | 'options' | 'brands'>;
}

/** A page's file name as the site links it (publish.ts slugFor), or index.html. */
export const PAGE_RE = /^(index|[a-z0-9][a-z0-9-]{0,80})\.html$/;

const root = (): string => path.join(appPaths.userData(), 'published');
const dir = (id: string): string => path.join(root(), id);
/** The site's manifest — also its lock (recordFs.locked): every write of the site holds it. */
const manifestPath = (id: string): string => path.join(dir(id), 'manifest.json');

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
  const m = await readJson<HostedSite>(manifestPath(id));
  return m && m.id === id ? m : null;
}

/**
 * May `site` still be served (docs/row-policy D10)? Not once a dataset its build read has row access
 * rules (or is built from one). A site published before builds were recorded has its datasets worked
 * out ONCE from the dashboards it was published with, and kept (round 2, #10); one that cannot be
 * (a story or scorecard, no stored definitions) is not served while its project has any such dataset.
 */
export async function servable(site: HostedSite): Promise<boolean> {
  try {
    const ids = Array.isArray(site.datasetIds) ? site.datasetIds : await backfillDatasets(site);
    if (ids === null) return !(await anyPolicyClosedRecently(site.projectId));
    for (const id of ids) if (await policyClosed(site.projectId, id)) return false;
    return true;
  } catch {
    return false; // rules that cannot be read: not served
  }
}

/**
 * The datasets an older site's dashboards can show, from the definitions it was PUBLISHED with
 * (item 4's walk: lineage upstream and relationships, an over-approximation), written onto its
 * manifest so the next fetch reads them there. Null when they cannot be worked out.
 */
async function backfillDatasets(site: HostedSite): Promise<readonly string[] | null> {
  if (site.config.storyIds.length || site.config.scorecardIds.length) return null;
  const defs = await getDefs(site.id);
  if (!defs) return null;
  const ids = new Set<string>();
  for (const dashId of site.config.dashboardIds) {
    const def = defs[dashId];
    if (!def) return null; // a dashboard the build kept no definition of: cannot say what it showed
    for (const d of await datasetsOfRoot(site.projectId, 'dashboard', dashId, def.analysis, def.visuals)) ids.add(d);
  }
  const datasetIds = [...ids];
  // Kept only on the manifest it was worked out from: a re-publish meanwhile recorded its own.
  await recordFs.locked(manifestPath(site.id), async () => {
    const now = await getSite(site.id);
    if (now && !Array.isArray(now.datasetIds) && now.publishedAt === site.publishedAt) await writeJson(manifestPath(site.id), { ...now, datasetIds });
  });
  return datasetIds;
}

/** One page's HTML, or null. */
export async function getPage(id: string, file: string): Promise<string | null> {
  if (!isValidId(id) || !PAGE_RE.test(file)) return null;
  const p = await readJson<{ html?: unknown }>(path.join(dir(id), `${file}.json`));
  return p && typeof p.html === 'string' ? p.html : null;
}

/** Each dashboard of site `id` as it was published, by id; null for a site published before definitions were kept. */
export async function getDefs(id: string): Promise<Record<string, PublishedDef> | null> {
  if (!isValidId(id)) return null;
  const d = await readJson<{ dashboards?: Record<string, PublishedDef> }>(path.join(dir(id), 'defs.json'));
  return d && d.dashboards && typeof d.dashboards === 'object' ? d.dashboards : null;
}

/** The published definition of every dashboard in `ids`: the record, and each visual a card names. */
async function definitions(projectId: string, ids: readonly string[]): Promise<Record<string, PublishedDef>> {
  const out: Record<string, PublishedDef> = {};
  for (const id of ids) {
    const a = await analysis.getAnalysis(projectId, id);
    if (!a) continue;
    const vis: Record<string, Visual> = {};
    for (const card of a.sheets.flatMap((p) => p.cards)) {
      const vid = card && (card as { visualId?: string }).visualId;
      if (!vid || vis[vid]) continue;
      const v = await visuals.getVisual(projectId, vid);
      if (v) vis[vid] = v;
    }
    out[id] = { analysis: a, visuals: vis };
  }
  return out;
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
  // ponytail: read just before the pages build; an edit landing in that window can reach the /p/ page but not the embed. One read for both if it matters.
  const defs = await definitions(config.projectId, config.dashboardIds);
  // Built OUTSIDE the lock (every figure is computed here); only the switch below holds the site.
  // A fan-out (docs/row-policy D10): a dataset with row access rules — or built from one — refuses the whole publish.
  const { value: built, datasets: read } = await fanOutScope(() => buildPages(config, opts.progress ?? {}, policyOutgoing(config.projectId, 'publish')));
  await assertFanOutAllowed(config.projectId, read);
  const { pages, index, combos } = built;
  const files = [{ file: 'index.html', html: index }, ...pages.map((p) => ({ file: p.file, html: p.html }))];
  return recordFs.locked(manifestPath(id), async () => {
    // Read again under the lock: a site taken down meanwhile stays down, and
    // who may open it is the owner's latest word, not what the build started with.
    const now = prev ? await getSite(id) : null;
    if (prev && !now) throw new Error('That published link no longer exists.');
    for (const f of files) await writeJson(path.join(dir(id), `${f.file}.json`), { html: f.html });
    await writeJson(path.join(dir(id), 'defs.json'), { dashboards: defs });
    const site: HostedSite = {
      id,
      projectId: config.projectId,
      title: config.options.title || '',
      access: opts.access ?? now?.access ?? 'org',
      publishedBy: by,
      publishedAt: new Date().toISOString(),
      bytes: files.reduce((n, f) => n + Buffer.byteLength(f.html), 0),
      combos,
      pages: pages.map((p) => ({ file: p.file, kind: p.kind, name: p.name })),
      datasetIds: [...new Set(read)],
      config: { dashboardIds: config.dashboardIds, storyIds: config.storyIds, scorecardIds: config.scorecardIds, options: config.options, ...(config.brands ? { brands: config.brands } : {}) },
    };
    await writeJson(manifestPath(id), site);
    const keep = new Set(files.map((f) => `${f.file}.json`));
    for (const old of now ? ['index.html', ...now.pages.map((p) => p.file)] : []) {
      if (!keep.has(`${old}.json`)) await recordFs.rm(path.join(dir(id), `${old}.json`), { force: true });
    }
    return site;
  });
}

/** Change who may open a site. */
export async function setAccess(id: string, access: Access): Promise<HostedSite | null> {
  if (!isValidId(id)) return null;
  return recordFs.locked(manifestPath(id), async () => {
    const site = await getSite(id);
    if (!site) return null;
    const next = { ...site, access };
    await writeJson(manifestPath(id), next);
    return next;
  });
}

/** Take a site down: the manifest first (the link stops at once), then its pages. */
export async function removeSite(id: string): Promise<boolean> {
  if (!isValidId(id)) return false;
  return recordFs.locked(manifestPath(id), async () => {
    const site = await getSite(id);
    if (!site) return false;
    await recordFs.rm(manifestPath(id), { force: true });
    await recordFs.rm(dir(id), { recursive: true, force: true });
    return true;
  });
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
