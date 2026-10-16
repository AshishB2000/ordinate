// Signed embedding's RPC handlers (docs/embed/00-design.md; contracts in
// src/api/embed.ts). The org's settings and secret live in
// src/server/embed/settings.ts; the view itself is GET /embed/<token>
// (src/server/embed/route.ts). Nothing here computes a figure.

import { ipcMain } from './bus';
import * as datasets from '../data/datasets';
import * as metrics from '../analysis/metrics';
import { ctx } from '../server/context';
import { getDefs, getSite, type HostedSite } from '../publish/hosted';
import type { PublishedDef } from '../publish/dashboardData';
import { canStore, hasSecret, MAX_ORIGINS, readSettings, rotateSecret, saveSettings, secretOf } from '../server/embed/settings';
import { MAX_LOCK_COLUMNS, MAX_TTL_SEC, PREVIEW_TTL_SEC, signToken } from '../server/embed/token';
import { embedNeedsSecret, embedNeedsStore, embedNotFound, embedRepublish } from '../server/embedMessages';

const org = (): string => ctx().org.id;

/** A link of THIS project, or null. */
async function siteIn(projectId: string, id: string): Promise<HostedSite | null> {
  const s = await getSite(id);
  return s && s.projectId === projectId ? s : null;
}

/** Every dataset a figure of `def` reads: the tiles a lock must cover. */
async function tileDatasets(projectId: string, def: PublishedDef): Promise<string[]> {
  const out: string[] = [];
  for (const card of def.analysis.sheets.flatMap((p) => p.cards)) {
    const c = card as unknown as { type?: string; metric?: { datasetId?: string; metricId?: string }; stats?: { datasetId?: string }; visualId?: string; visual?: { datasetId?: string } };
    if (c.type === 'visual') {
      const v = c.visual?.datasetId ? c.visual : c.visualId ? def.visuals[c.visualId] : undefined;
      if (v?.datasetId) out.push(v.datasetId);
    } else if (c.type === 'metric' && c.metric) {
      const m = c.metric.metricId ? await metrics.getMetric(projectId, c.metric.metricId) : null;
      const id = m?.datasetId ?? c.metric.datasetId;
      if (id) out.push(id);
    } else if (c.type === 'stats' && c.stats?.datasetId) out.push(c.stats.datasetId);
  }
  return out;
}

export function register(): void {
  const status = async () => {
    const s = await readSettings(org());
    return { canStore: canStore(), enabled: s.enabled, origins: s.origins, secretSet: canStore() && (await hasSecret(org())), org: org() };
  };
  ipcMain.handle('embed:settings', async () => ({ ...(await status()), maxOrigins: MAX_ORIGINS, maxTtlHours: MAX_TTL_SEC / 3600, maxLockColumns: MAX_LOCK_COLUMNS }));
  ipcMain.handle('embed:status', status);
  ipcMain.handle('embed:save', async (_e, s: { enabled: boolean; origins: string[] }) => saveSettings(org(), s));
  ipcMain.handle('embed:rotate', async () => rotateSecret(org()));

  // Which columns a lock on this dashboard can hold: each column of a dataset its figures read, and how many tiles it covers.
  ipcMain.handle('embed:columns', async (_e, { projectId, siteId, dashboardId }: { projectId: string; siteId: string; dashboardId: string }) => {
    const site = await siteIn(projectId, siteId);
    if (!site || !site.config.dashboardIds.includes(dashboardId)) return { ok: false, error: embedNotFound() };
    const def = (await getDefs(siteId))?.[dashboardId];
    if (!def) return { ok: false, republish: true, error: embedRepublish() };
    const ids = await tileDatasets(projectId, def);
    const metas = new Map<string, Awaited<ReturnType<typeof datasets.getDatasetMeta>>>();
    for (const id of new Set(ids)) metas.set(id, await datasets.getDatasetMeta(projectId, id));
    const cover = new Map<string, { type: string; tiles: number }>();
    for (const id of ids) {
      for (const col of metas.get(id)?.columns ?? []) {
        const c = cover.get(col.name) ?? { type: col.type, tiles: 0 };
        c.tiles += 1;
        cover.set(col.name, c);
      }
    }
    const columns = [...cover].map(([name, c]) => ({ name, type: c.type, tiles: c.tiles })).sort((a, b) => b.tiles - a.tiles || a.name.localeCompare(b.name));
    return { ok: true, tiles: ids.length, columns, dashboards: site.pages.filter((p) => p.kind === 'dashboard').map((p) => p.name) };
  });

  // A preview link: signed here, for ten minutes, served only to an iframe of this server (src/server/embed/route.ts).
  ipcMain.handle('embed:preview', async (_e, i: { projectId: string; siteId: string; dashboardId: string; params?: Record<string, (string | number)[]>; theme?: 'light' | 'dark'; hide?: ('title' | 'filters')[] }) => {
    if (!canStore()) return { ok: false, error: embedNeedsStore() };
    const site = await siteIn(i.projectId, i.siteId);
    if (!site || !site.config.dashboardIds.includes(i.dashboardId)) return { ok: false, error: embedNotFound() };
    const secret = await secretOf(org());
    if (!secret) return { ok: false, error: embedNeedsSecret() };
    const exp = Math.floor(Date.now() / 1000) + PREVIEW_TTL_SEC;
    const token = signToken(org(), {
      pub: site.id, dash: i.dashboardId, exp, prv: 1,
      ...(i.params && Object.keys(i.params).length ? { params: i.params } : {}),
      ...(i.theme ? { theme: i.theme } : {}),
      ...(i.hide && i.hide.length ? { hide: i.hide } : {}),
    }, secret);
    return { ok: true, url: `/embed/${token}`, expiresAt: new Date(exp * 1000).toISOString() };
  });
}
