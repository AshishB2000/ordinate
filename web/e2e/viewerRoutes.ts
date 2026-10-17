// Every route a project viewer can open, for the viewer walk
// (view-only-routes.e2e.ts): its URL over the walk's seed, what an editor is
// offered there (the negative control), the surfaces that hold stored values,
// and the exploration names the write pattern would otherwise count.
//
// A NEW ROUTE in web/src/app/routes.tsx must be listed here or in SKIP with a
// reason: `uncovered()` fails the spec's first test (which needs no Postgres,
// so it runs in CI) on any route that is neither.

import { createRequire } from 'node:module';
import type { Locator, Page } from 'playwright';
import type { ViewerSeed } from './seed-viewer.ts';

export interface Control {
  role: 'button' | 'link' | 'heading' | 'textbox' | 'region' | 'navigation' | 'grid' | 'list';
  name: string | RegExp;
}

export interface RouteCase {
  /** The route's pattern, exactly as web/src/app/routes.tsx spells it. */
  pattern: string;
  url: (s: ViewerSeed) => string;
  /**
   * What only an editor is offered here: present for an editor, absent for a viewer — the negative control that the
   * viewer's empty count is not a page that failed to draw. Absent where nothing on the route is an editor's.
   */
  editor?: Control;
  /**
   * Opens what the route keeps a click away (a popover, an older version). Returns the scope that holds stored values,
   * whose fields must be read-only for a viewer and editable for an editor (a Details popover); nothing otherwise.
   */
  open?: (page: Page) => Promise<Locator | undefined>;
  /** Names the WRITE pattern matches that change only the viewer's own screen (a what-if, a filter, a spec) — never stored. */
  explore?: readonly string[];
}

/** Routes not walked, and why. */
export const SKIP: Readonly<Record<string, string>> = {
  '/dev/ui': 'the UI kit gallery: a dev build only, no project data',
  '/dev/charts': 'every chart id over the API, for the chart specs; no write control',
  '/dev/maps': 'every map kind over the sample, for the map specs; no write control',
  '/reports/:projectId/:reportId': 'the report builder: a viewer’s edits there are still open (findings.md)',
  '/tokens': 'the signed-in person’s own API tokens: org read, not the project’s',
  '/about': 'version and licences: nothing of the project’s',
  '/admin': 'org admins only: the server refuses its channels to anyone else',
};

/** The route patterns of routes.tsx's source that are neither walked nor skipped. */
export function uncovered(routesSrc: string, routes: readonly RouteCase[] = ROUTES): string[] {
  const listed = new Set([...routes.map((r) => r.pattern), ...Object.keys(SKIP)]);
  return [...routesSrc.matchAll(/\bpage\(\s*'([^']+)'/g)].map((m) => m[1]!).filter((p) => !listed.has(p));
}

/** An accessible name that writes, or opens an editor-only flow — anchored to the name's start. */
export const WRITE =
  /^(New|Add|Create|Save|Delete|Remove|Rename|Edit|Duplicate|Restore|Import|Upload|Publish|Run checks|Snooze|Mark( all)? seen|Mark as|Make a copy|Copy the data|Sync|Reset|Refresh|Build|Break|Suggest|Set up|Metrics & targets|Chart this column|Pin a filter)\b/;

const ACTION_ROLES = /^(button|link|menuitem|menuitemcheckbox|menuitemradio)$/;

/** Every visible action on the page (portals included) whose name matches WRITE, less the route's exploration names. */
export async function writeControls(page: Page, explore: readonly string[] = []): Promise<string[]> {
  const snap = await page.locator('body').ariaSnapshot();
  const out: string[] = [];
  for (const line of snap.split('\n')) {
    const m = /^\s*- ([a-z]+) "((?:[^"\\]|\\.)*)"/.exec(line);
    if (!m || !ACTION_ROLES.test(m[1]!)) continue;
    const name = m[2]!.replace(/\\"/g, '"');
    if (WRITE.test(name) && !explore.includes(name)) out.push(`${m[1]} "${name}"`);
  }
  return out;
}

/** The fields in `scope` a person could type a stored value into, or toggle: not read-only, not disabled. */
export function editableFields(scope: Locator): Promise<string[]> {
  return scope.evaluate((root) => {
    const out: string[] = [];
    for (const el of root.querySelectorAll<HTMLElement>('input, textarea, select, [role=combobox], [role=switch], [role=checkbox], [role=radio], [contenteditable=true]')) {
      if (el instanceof HTMLInputElement && (el.type === 'hidden' || el.type === 'file')) continue;
      const disabled = el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-disabled');
      const readOnly = (el as HTMLInputElement).readOnly === true || el.getAttribute('aria-readonly') === 'true';
      if (disabled || readOnly) continue;
      const label = el.getAttribute('aria-label') || (el as HTMLInputElement).labels?.[0]?.textContent?.trim() || el.textContent?.trim() || el.tagName.toLowerCase();
      out.push(label);
    }
    return out;
  });
}

/** Every channel whose contract is `access: 'write'`, from the compiled contracts (npm run build:ts). */
export function writeChannels(): Set<string> {
  const require = createRequire(import.meta.url);
  const { contracts } = require('../../src/api/index.js') as { contracts: Record<string, { access: string }> };
  return new Set(Object.entries(contracts).filter(([, c]) => c.access === 'write').map(([k]) => k));
}

/** A popover or dialog the click opened, by its accessible name. */
const opened = (page: Page, name: string | RegExp) => page.getByRole('dialog', { name }).last();

const details = async (page: Page) => {
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  const pop = opened(page, 'Dataset details');
  await pop.getByRole('textbox', { name: 'Description' }).waitFor();
  return pop;
};

const olderVersion = async (page: Page) => {
  await page.getByRole('region', { name: 'Saved versions' }).getByRole('button').nth(1).click();
  await page.getByRole('button', { name: 'Compare with current' }).waitFor();
  return undefined;
};

// A scenario's what-ifs and a builder's spec are the viewer's own screen: nothing there is stored for them.
const SCENARIO = ['Remove Revenue', 'Add driver', 'Remove driver 1'];
const BUILDER = ['Suggest chart', 'Add measure', 'Remove measure', 'Add filter', 'Add'];

export const ROUTES: readonly RouteCase[] = [
  { pattern: '/', url: (s) => `/?project=${s.pid}`, editor: { role: 'button', name: 'New' } },
  { pattern: '/data', url: (s) => `/data?project=${s.pid}`, editor: { role: 'link', name: 'Import file' } },
  { pattern: '/visuals', url: (s) => `/visuals?project=${s.pid}`, editor: { role: 'button', name: 'New visual' } },
  { pattern: '/analyses', url: (s) => `/analyses?project=${s.pid}`, editor: { role: 'button', name: 'Create dashboard' } },
  { pattern: '/dashboards', url: (s) => `/dashboards?project=${s.pid}`, editor: { role: 'button', name: 'Publish…' } },
  { pattern: '/explore', url: (s) => `/explore?project=${s.pid}` },
  { pattern: '/reports', url: (s) => `/reports?project=${s.pid}`, editor: { role: 'button', name: 'New report' } },
  { pattern: '/settings', url: (s) => `/settings?tab=privacy&project=${s.pid}`, editor: { role: 'button', name: /^Check \d+ datasets? for sensitive columns$/ } },
  { pattern: '/data/:projectId/:datasetId', url: (s) => `/data/${s.pid}/${s.did}`, editor: { role: 'link', name: 'Prepare' }, open: details },
  // The same route over a Live dataset: its notice, settings and schema.
  { pattern: '/data/:projectId/:datasetId', url: (s) => `/data/${s.pid}/${s.liveId}`, editor: { role: 'button', name: 'Copy the data instead' } },
  { pattern: '/data/:projectId/:datasetId', url: (s) => `/data/${s.pid}/${s.liveId}?tab=schema`, editor: { role: 'button', name: 'Sync schema' } },
  { pattern: '/connections', url: () => '/connections', editor: { role: 'link', name: /Fake warehouse/ } },
  { pattern: '/connections/:projectId', url: (s) => `/connections/${s.pid}`, editor: { role: 'link', name: /Fake warehouse/ } },
  { pattern: '/connections/:projectId/:connId', url: (s) => `/connections/${s.pid}/${s.connId}`, editor: { role: 'button', name: 'Save query' } },
  { pattern: '/trash', url: (s) => `/trash?project=${s.pid}`, editor: { role: 'button', name: 'Restore Old chart' } },
  { pattern: '/versions/:projectId/:type/:id', url: (s) => `/versions/${s.pid}/visual/${s.vid}`, editor: { role: 'button', name: 'Restore' }, open: olderVersion },
  { pattern: '/data/import', url: (s) => `/data/import?project=${s.pid}`, editor: { role: 'navigation', name: 'Sources' } },
  // No capture (reading one needs a model): the empty state — an editor's is the reader, a viewer's says who uploads.
  { pattern: '/data/captures', url: (s) => `/data/captures?project=${s.pid}`, editor: { role: 'heading', name: 'Reading a screenshot needs AI' } },
  { pattern: '/data/input/:projectId/:datasetId', url: (s) => `/data/input/${s.pid}/${s.inputId}`, editor: { role: 'grid', name: /Targets/ } },
  { pattern: '/data/:projectId', url: (s) => `/data/${s.pid}`, editor: { role: 'link', name: 'Import file' } },
  { pattern: '/visuals/:projectId', url: (s) => `/visuals/${s.pid}`, editor: { role: 'button', name: 'New visual' } },
  { pattern: '/visuals/:projectId/new', url: (s) => `/visuals/${s.pid}/new?dataset=${s.did}`, editor: { role: 'button', name: 'Save visual' }, explore: BUILDER },
  { pattern: '/visuals/:projectId/:visualId', url: (s) => `/visuals/${s.pid}/${s.vid}`, editor: { role: 'button', name: 'Save visual' }, explore: BUILDER },
  { pattern: '/data/:projectId/:datasetId/prepare', url: (s) => `/data/${s.pid}/${s.did}/prepare`, editor: { role: 'list', name: 'Pipeline steps' } },
  { pattern: '/pipelines', url: (s) => `/pipelines?project=${s.pid}`, editor: { role: 'button', name: /^Run/ } },
  { pattern: '/pipelines/:projectId', url: (s) => `/pipelines/${s.pid}`, editor: { role: 'button', name: /^Run/ } },
  { pattern: '/analytics', url: (s) => `/analytics?project=${s.pid}`, editor: { role: 'link', name: 'New pivot table' } },
  { pattern: '/analytics/:projectId/:datasetId/stats', url: (s) => `/analytics/${s.pid}/${s.did}/stats`, editor: { role: 'button', name: 'Add to dashboard' } },
  { pattern: '/analytics/:projectId/:datasetId/drivers', url: (s) => `/analytics/${s.pid}/${s.did}/drivers`, editor: { role: 'button', name: 'Add as a waterfall tile' } },
  // Its saves follow a run (SaveColumn, SaveDataset: Vitest's analytics/viewer.test.tsx); unrun, nothing is an editor's.
  { pattern: '/analytics/:projectId/:datasetId/segments', url: (s) => `/analytics/${s.pid}/${s.did}/segments` },
  { pattern: '/analytics/scenarios/:projectId', url: (s) => `/analytics/scenarios/${s.pid}`, editor: { role: 'button', name: 'New scenario' } },
  { pattern: '/analytics/scenarios/:projectId/compare', url: (s) => `/analytics/scenarios/${s.pid}/compare?ids=${s.scenarioId}` },
  { pattern: '/analytics/scenarios/:projectId/:scenarioId', url: (s) => `/analytics/scenarios/${s.pid}/${s.scenarioId}`, editor: { role: 'textbox', name: 'Scenario name' }, explore: SCENARIO },
  { pattern: '/analyses/:projectId/:analysisId', url: (s) => `/analyses/${s.pid}/${s.aid}`, editor: { role: 'button', name: 'Add sheet' } },
  { pattern: '/data/metrics', url: (s) => `/data/metrics?project=${s.pid}`, editor: { role: 'button', name: 'New metric' } },
  { pattern: '/stories/:projectId/:storyId', url: (s) => `/stories/${s.pid}/${s.storyId}`, editor: { role: 'textbox', name: 'Story name' } },
  { pattern: '/scorecards/:projectId/:scorecardId', url: (s) => `/scorecards/${s.pid}/${s.scorecardId}`, editor: { role: 'button', name: 'Metrics & targets' } },
  { pattern: '/analytics/:projectId/sql', url: (s) => `/analytics/${s.pid}/sql`, editor: { role: 'button', name: 'Save as dataset' } },
  { pattern: '/analytics/:projectId/events', url: (s) => `/analytics/${s.pid}/events`, editor: { role: 'button', name: 'New event' } },
  // Walked in their empty state: no capture exists (reading one needs a model), and rebuilding needs one too.
  { pattern: '/data/captures/:projectId/:captureId', url: (s) => `/data/captures/${s.pid}/${s.did}` },
  { pattern: '/analyses/:projectId/rebuild', url: (s) => `/analyses/${s.pid}/rebuild` },
  { pattern: '/data/metrics/:projectId/:metricId/tree', url: (s) => `/data/metrics/${s.pid}/${s.metricId}/tree`, editor: { role: 'button', name: 'Edit tree' } },
];
