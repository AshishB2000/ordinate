// /assistant/setup and /assistant/setup/:projectId — the Assistant's setup: its agents (docs/assistant-agents),
// instructions, documents, verified questions, tests, inbox and issues, and a test chat (AssistantTab.tsx).
// It sits beside the Assistant's chat, not in the Data model: it is how the Assistant behaves, not what the data
// means. /assistant/setup goes to the current project, as /model does. The Data model's old `?tab=assistant`
// address lands here with its query (`agent`, `issue`) kept (DataModelPage.tsx).

import { Navigate, useLocation, useParams } from 'react-router';
import { ErrorState, Page, PageSkeleton } from '../../../app/blocks';
import { useAdoptProject, useCurrentProject } from '../../projects/current';
import { NoProject } from '../../projects/NoProject';
import { AssistantTab } from './AssistantTab';
import { setupPath } from './setupPath';

const TITLE = 'Agents & setup';
const SUB = 'How the Assistant answers in this project: its agents, instructions, documents and verified questions.';
const WHY = 'The Assistant’s setup belongs to a project.';
const BACK = { to: '/assistant', label: 'Assistant' };

function Section({ projectId }: { projectId: string }) {
  useAdoptProject(projectId); // the URL names the project: the shell's switcher shows it
  return (
    <Page title={TITLE} sub={SUB} back={BACK}>
      <AssistantTab projectId={projectId} />
    </Page>
  );
}

export default function SetupPage() {
  const { projectId } = useParams();
  const cur = useCurrentProject();
  const { search } = useLocation();
  if (projectId) return <Section projectId={projectId} />;
  if (cur.status === 'pending') return <PageSkeleton />;
  if (cur.status === 'error') {
    return (
      <Page title={TITLE} back={BACK}>
        <ErrorState title="Projects could not be loaded" message={cur.error?.message ?? 'Try again.'} onRetry={cur.refetch} />
      </Page>
    );
  }
  if (!cur.projectId) {
    return (
      <Page title={TITLE} sub={SUB} back={BACK}>
        <NoProject why={WHY} />
      </Page>
    );
  }
  return <Navigate to={setupPath(cur.projectId, search)} replace />;
}
