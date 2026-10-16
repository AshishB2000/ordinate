// One embedded dashboard page (docs/embed/00-design.md) — MAIN.
//
// The SAME page a published link serves (./publish.ts buildPages: the same
// builders, Share policy, sanitizePage whitelist and pinned CSP), with three
// differences:
//
//   - built from the dashboard AS PUBLISHED (./hosted.ts getDefs), never the
//     editable record: a tile added after publishing is not embedded;
//   - built under the token's LOCKED filters (./embedLock.ts), so the page
//     holds no row outside them — nothing in it can be un-filtered;
//   - built when it is asked for, not at publish time (every customer's
//     figures cannot be precomputed), so it is cached here: one build per
//     (org, link, publish time, dashboard, locks, theme, hide) for CACHE_MS,
//     shared by concurrent identical views. The caller runs this inside
//     runAsPublished, so a Live figure is never fresher than the /p/ floor.

import { orgKey } from '../server/context';
import * as recordFs from '../app/recordFs';
import { getFormatPrefs } from '../app/format';
import { listThemes } from '../app/themeStore';
import { themeModel } from '../analysis/themeTokens';
import { buildDashboard } from './dashboardData';
import { DEFAULT_MAX_COMBOS } from './combos';
import { geoFor } from './geoData';
import { getDefs, type HostedSite } from './hosted';
import { makeLock } from './embedLock';
import { policyOutgoing, readAssets } from './publish';
import { sanitizePage } from './sanitize';
import { pageHtml } from './siteHtml';
import type { EmbedClaims } from '../server/embed/token';

/** Filter-bar combinations an embed computes at most (a cold view computes them all). */
export const EMBED_MAX_COMBOS = 64;
const CACHE_MS = 5 * 60_000;
// ponytail: a page can be a few MB, so a small count cap; a byte budget if embeds are many and large.
const CACHE_MAX = 32;

export type EmbedBuild = { html: string } | { missing: 'gone' | 'republish' };

const cache = new Map<string, { at: number; html: string }>();
const inflight = new Map<string, Promise<EmbedBuild>>();

/** Test hook: forget every built page. */
export function clearEmbedCache(): void {
  cache.clear();
}

function keyOf(site: HostedSite, dashboardId: string, c: EmbedClaims): string {
  const params = Object.keys(c.params).sort().map((k) => [k, c.params[k]]);
  return orgKey(JSON.stringify(['embed', site.id, site.publishedAt, dashboardId, params, c.theme ?? '', [...c.hide].sort()]));
}

async function build(site: HostedSite, dashboardId: string, c: EmbedClaims): Promise<EmbedBuild> {
  const defs = await getDefs(site.id);
  const def = defs && Object.prototype.hasOwnProperty.call(defs, dashboardId) ? defs[dashboardId] : null;
  if (!def) return { missing: 'republish' };
  const lock = makeLock(c.params);
  const max = Math.min(site.config.options.maxCombos || DEFAULT_MAX_COMBOS, EMBED_MAX_COMBOS);
  const d = await recordFs.withReadMemo(() => buildDashboard(site.projectId, dashboardId, max, {}, policyOutgoing(site.projectId, 'publish'), { def, lock }));
  if (!d) return { missing: 'gone' };
  const raw = (d.style || {}) as { themeId?: string };
  // A token's theme wins over the dashboard's (and its workspace theme and brand ramp, which were made for the other one).
  const style = c.theme ? { ...raw, theme: c.theme === 'dark' ? 'dark' : 'clean', chosen: true, themeId: undefined } : raw;
  const themes = c.theme ? null : await listThemes();
  const theme = themes ? themeModel.resolveTheme(raw.themeId, themes.defaultId, themes.themes).theme || undefined : undefined;
  const ramp = c.theme ? undefined : site.config.brands?.[dashboardId]?.ramp;
  const geo = await geoFor(site.projectId, d.geoLevels, d.boundaryIds);
  const page = sanitizePage({
    site: { title: d.name, nav: [], generatedAt: new Date().toISOString() },
    kind: 'dashboard',
    dashboard: { ...d, style },
    brand: { ramp },
    theme,
    formats: getFormatPrefs(),
    geo,
    embed: { hideTitle: c.hide.includes('title'), hideFilters: c.hide.includes('filters') },
  });
  return { html: pageHtml(page, readAssets(), d.name) };
}

/** The page for `dashboardId` of `site` under the token's claims — cached, one build at a time per key. */
export async function embedHtml(site: HostedSite, dashboardId: string, claims: EmbedClaims): Promise<EmbedBuild> {
  const key = keyOf(site, dashboardId, claims);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return { html: hit.html };
  let p = inflight.get(key);
  if (!p) {
    p = build(site, dashboardId, claims).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  const out = await p;
  if ('html' in out) {
    cache.delete(key);
    cache.set(key, { at: Date.now(), html: out.html });
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  }
  return out;
}
