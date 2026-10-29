// /dashboards/:projectId/:analysisId — a dashboard opened from the Dashboards page: the editing screen's own canvas
// and figures, read-only whatever the role, with a reader's header (Copy link, for everyone). It shows the PUBLISHED
// copy — what viewers see until the next Publish. `?draft=1` is the Preview: the draft, as viewers will see it once
// published (an editor's only; a viewer is sent the copy whatever is asked), under its strip (drafts/PreviewStrip).

import { useSearchParams } from 'react-router';
import AuthoringPage from '../analyses/AuthoringPage';
import { wantsPublished } from './drafts/state';

export default function DashboardViewPage() {
  const [search] = useSearchParams();
  return <AuthoringPage viewing published={wantsPublished(search)} />;
}
