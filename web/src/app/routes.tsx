// URL routes. APPEND-ONLY (plan §6): a new screen adds one `page(...)` line at
// the end of the list; never reorder or reformat. Each page is its own lazy
// chunk (only the shell is in the initial bundle) with its own error boundary,
// so one broken page leaves the nav and every other page working.

import { lazy, Suspense, type ComponentType } from 'react';
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
  page('/admin', () => import('../features/admin/AdminPage')),
  page('/tokens', () => import('../features/admin/TokensPage')),
  // Dev-only UI kit gallery. Both conditions are build-time constants, so a
  // production build drops this entry and never emits the chunk.
  ...(import.meta.env.DEV || import.meta.env.MODE === 'gallery'
    ? [page('/dev/ui', () => import('../ui/gallery/Gallery'))]
    : []),
  page('/data/:projectId/:datasetId', () => import('../features/data/DatasetPage')),
  // Every chart id drawn from the API (T1.1). In every build, not in the nav:
  // the e2e drives the production build, and the page reads only what the
  // caller may already read through contracted channels.
  page('/dev/charts', () => import('../charts/dev/ChartsGallery')),
  // Every map kind over the sample project (T1.3). In the production build too:
  // the e2e drives the built app. A lazy chunk, never in the initial bundle.
  page('/dev/maps', () => import('../charts/maps/dev/MapsDev')),
  // Connect data (T2.5): the project's connections and the source picker, and one connection's workbench.
  page('/connections', () => import('../features/connections/ConnectionsPage')),
  page('/connections/:projectId', () => import('../features/connections/ConnectionsPage')),
  page('/connections/:projectId/:connId', () => import('../features/connections/WorkbenchPage')),

  page('/trash', () => import('../features/projects/TrashPage')),
  page('/versions/:projectId/:type/:id', () => import('../features/projects/VersionsPage')),
  // Import, composer, captures, input tables (T2.4), in the current project.
  page('/data/import', () => import('../features/import/ImportPage')),
  page('/data/captures', () => import('../features/import/CapturesPage')),
  page('/data/input/:projectId/:datasetId', () => import('../features/import/InputTablePage')),
  // The Data section (T2.3): one project's datasets / captures / catalog / relationships.
  page('/data/:projectId', () => import('../features/data/DataSection')),
  // Visuals (T2.7): one project's gallery, and the builder — new on a dataset, or a saved visual.
  page('/visuals/:projectId', () => import('../features/visuals/VisualsPage')),
  page('/visuals/:projectId/new', () => import('../features/visuals/BuilderPage')),
  page('/visuals/:projectId/:visualId', () => import('../features/visuals/BuilderPage')),

  // Prepare (T2.6): a dataset's reversible step pipeline beside its prepared rows.
  page('/data/:projectId/:datasetId/prepare', () => import('../features/prepare/PreparePage')),
  // Pipelines (T2.6): every scheduled or dependent thing in a project as one DAG.
  page('/pipelines', () => import('../features/prepare/PipelinesPage')),
  page('/pipelines/:projectId', () => import('../features/prepare/PipelinesPage')),

  // Analytics workbenches A (T2.10): the doors, the three dataset workbenches, and scenarios.
  page('/analytics', () => import('../features/analytics/AnalyticsPage')),
  page('/analytics/:projectId/:datasetId/stats', () => import('../features/analytics/stats/StatsPage')),
  page('/analytics/:projectId/:datasetId/drivers', () => import('../features/analytics/drivers/DriversPage')),
  page('/analytics/:projectId/:datasetId/segments', () => import('../features/analytics/segments/SegmentsPage')),
  page('/analytics/scenarios/:projectId', () => import('../features/analytics/scenarios/ScenariosPage')),
  page('/analytics/scenarios/:projectId/compare', () => import('../features/analytics/scenarios/ScenarioComparePage')),
  page('/analytics/scenarios/:projectId/:scenarioId', () => import('../features/analytics/scenarios/ScenarioPage')),

  // About (T2.14): version, links, the licences of every bundled package.
  page('/about', () => import('../features/settings/AboutPage')),
  // Analyses and authoring (T2.8): one dashboard open on the authoring canvas.
  page('/analyses/:projectId/:analysisId', () => import('../features/analyses/AuthoringPage')),
  // The project's metrics (T2.8) — the Metrics tab of Data on the desktop.
  page('/data/metrics', () => import('../features/analyses/metrics/MetricsPage')),
  // Reports, stories, scorecards (T2.13): the report builder, a story, a scorecard. The tabs are /reports.
  page('/reports/:projectId/:reportId', () => import('../features/reports/builder/ReportBuilder')),
  page('/stories/:projectId/:storyId', () => import('../features/reports/stories/StoryPage')),
  page('/scorecards/:projectId/:scorecardId', () => import('../features/reports/scorecards/ScorecardPage')),

  // Analytics workbenches B (T2.11): SQL over the project's datasets, and its event annotations.
  page('/analytics/:projectId/sql', () => import('../features/analytics/sql/QueryPage')),
  page('/analytics/:projectId/events', () => import('../features/analytics/events/EventsPage')),
];

// Sign-in sits OUTSIDE the shell: no nav for someone who is not signed in.
const SignInPage = lazy(() => import('../features/auth/SignInPage'));
const ChangePasswordPage = lazy(() => import('../features/auth/ChangePasswordPage'));

/** The whole tree: the shell, every page inside it, and the 404 for anything else. */
export function appRoutes(children: RouteObject[] = pages): RouteObject[] {
  return [
    {
      path: '/',
      element: <Shell />,
      errorElement: <RouteError />,
      children: [...children, { path: '*', element: <NotFound /> }],
    },
    {
      path: '/sign-in',
      element: (
        <Suspense fallback={null}>
          <SignInPage />
        </Suspense>
      ),
      errorElement: <RouteError />,
    },
    // Password sign-in: choose your own password (a temporary one must be replaced first).
    {
      path: '/change-password',
      element: (
        <Suspense fallback={null}>
          <ChangePasswordPage />
        </Suspense>
      ),
      errorElement: <RouteError />,
    },
  ];
}
