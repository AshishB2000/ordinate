// URL routes. APPEND-ONLY (plan §6): a new screen adds one `page(...)` line at
// the end of the list; never reorder or reformat. Each page is its own lazy
// chunk (only the shell is in the initial bundle) with its own error boundary,
// so one broken page leaves the nav and every other page working.

import { lazy, type ComponentType } from 'react';
import type { RouteObject } from 'react-router';
import { Shell } from './Shell';
import { NotFound, RouteError } from './errors';

function page(path: string, load: () => Promise<{ default: ComponentType }>): RouteObject {
  const Component = lazy(load);
  const route = { element: <Component />, errorElement: <RouteError /> };
  return path === '/' ? { index: true, ...route } : { path, ...route };
}

export const pages: RouteObject[] = [
  page('/', () => import('../features/home/HomePage')),
  page('/data', () => import('../features/data/DataPage')),
  page('/visuals', () => import('../features/visuals/VisualsPage')),
  page('/analyses', () => import('../features/analyses/AnalysesPage')),
  page('/dashboards', () => import('../features/dashboards/DashboardsPage')),
  page('/explore', () => import('../features/explore/ExplorePage')),
  page('/reports', () => import('../features/reports/ReportsPage')),
  page('/settings', () => import('../features/settings/SettingsPage')),
];

/** The whole tree: the shell, every page inside it, and the 404 for anything else. */
export function appRoutes(children: RouteObject[] = pages): RouteObject[] {
  return [
    {
      path: '/',
      element: <Shell />,
      errorElement: <RouteError />,
      children: [...children, { path: '*', element: <NotFound /> }],
    },
  ];
}
