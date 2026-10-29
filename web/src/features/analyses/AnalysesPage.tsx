// /analyses — the old list of dashboards, folded into Dashboards (docs/superpowers/specs/2026-10-29-dashboard-drafts-
// publish-design.md). Links and bookmarks still arrive here, so the address sends them on with everything they asked
// for: `?project=`, and `?new=1[&dataset=<id>]` still opens the new-dashboard wizard. The editor
// (/analyses/<project>/<id>) and Rebuild (/analyses/<project>/rebuild) keep their addresses.

import { Navigate, useLocation } from 'react-router';

export default function AnalysesPage() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: '/dashboards', search }} replace />;
}
