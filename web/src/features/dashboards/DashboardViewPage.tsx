// /dashboards/:projectId/:analysisId — a dashboard opened from the Dashboards page: the editing screen's own canvas
// and figures, read-only whatever the role, with a reader's header (Share link, Edit for editors). Any dashboard the
// person can read opens here, Ready or not: Ready decides only what the Dashboards tab lists.

import AuthoringPage from '../analyses/AuthoringPage';

export default function DashboardViewPage() {
  return <AuthoringPage viewing />;
}
