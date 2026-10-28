// What the URL says the dock is about: the project a route names, and the ONE
// thing its screen shows. Pure — dockState.ts's hooks hand it the pathname.
// Every id is checked before it is used: `/data/import` is not a project
// called "import", and `/visuals/<project>/new` is not a visual called "new".

import { matchPath } from 'react-router';
import type { Ask } from './api';

/** A record id, as the contracts check one (src/api/contract.ts `Uuid`). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A capture's id is its history thread's (src/api/captures.ts `CaptureId`). */
const CAPTURE_ID = /^[0-9a-zA-Z_-]{1,64}$/;

/** What comes before `:projectId` in every route that names a project (app/routes.tsx — dockRoute.test.tsx walks that list against this one). */
const BEFORE_PROJECT = ['/data', '/data/captures', '/data/input', '/data/metrics', '/visuals', '/analyses', '/scorecards', '/analytics', '/analytics/scenarios', '/connections', '/pipelines', '/reports', '/stories', '/versions', '/dashboards'];

/** The project the URL names, or null — the segment where a route keeps its project, and only when it is an id. */
export function routeProject(pathname: string): string | null {
  for (const prefix of BEFORE_PROJECT) {
    const id = matchPath(`${prefix}/:projectId/*`, pathname)?.params.projectId;
    if (id && UUID.test(id)) return id;
  }
  return null;
}

/** The context kinds a URL alone can name. */
export type ScreenKind = Extract<Ask['kind'], 'dataset' | 'visual' | 'capture' | 'analysis' | 'scorecard' | 'scenario'>;

export interface RouteScreen {
  projectId: string;
  kind: ScreenKind;
  id: string;
}

// The screens that are about one thing. An in-app dashboard IS its analysis
// (docs/analysis/00-model.md); a published one is served at /p/, outside this app.
// The Statistics and Drivers workbenches ask about their DATASET: the `stats`
// and `drivers` kinds need the panel's spec or a token one pod's memory holds, and no URL carries either.
const SCREENS: readonly (readonly [pattern: string, kind: ScreenKind])[] = [
  ['/data/captures/:projectId/:id', 'capture'],
  ['/data/:projectId/:id', 'dataset'],
  ['/data/:projectId/:id/prepare', 'dataset'],
  ['/data/input/:projectId/:id', 'dataset'], // an input table is an ordinary dataset
  ['/analytics/:projectId/:id/stats', 'dataset'],
  ['/analytics/:projectId/:id/drivers', 'dataset'],
  ['/analytics/:projectId/:id/segments', 'dataset'],
  ['/visuals/:projectId/:id', 'visual'],
  ['/analyses/:projectId/:id', 'analysis'],
  ['/dashboards/:projectId/:id', 'analysis'], // the same dashboard, opened from the Dashboards page to read
  ['/scorecards/:projectId/:id', 'scorecard'],
  ['/analytics/scenarios/:projectId/:id', 'scenario'],
];

/** The one thing the screen at `pathname` shows, or null: a list, a new draft, a page about the whole project. */
export function routeScreen(pathname: string): RouteScreen | null {
  for (const [pattern, kind] of SCREENS) {
    const p = matchPath(pattern, pathname)?.params;
    if (!p?.projectId || !p.id || !UUID.test(p.projectId)) continue;
    if ((kind === 'capture' ? CAPTURE_ID : UUID).test(p.id)) return { projectId: p.projectId, kind, id: p.id };
  }
  return null;
}
