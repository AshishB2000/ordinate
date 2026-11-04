// /model and /model/:projectId — the Data model (docs/semantic-layer/00-design.md "The name and where it
// sits"): what the project's data means, on one screen. /model goes to the current project, as /data does.
// The tab is in the URL (?tab=); each tab is a later step's, appended to TABS.

import { Navigate, useLocation, useParams, useSearchParams } from 'react-router';
import { ErrorState, Page, PageSkeleton } from '../../app/blocks';
import { Tab, TabList, TabPanel, Tabs } from '../../ui/Tabs';
import { useAdoptProject, useCurrentProject } from '../projects/current';
import { NoProject } from '../projects/NoProject';
import { DatasetsTab } from './datasets/DatasetsTab';

const TABS = ['datasets'] as const;
type TabId = (typeof TABS)[number];

const TITLE = 'Data model';
const SUB = 'What your data means: datasets, fields, metrics and business terms. Every chart, the Assistant and agents use it.';
const WHY = 'The data model belongs to a project.';

function Section({ projectId }: { projectId: string }) {
  const [params, setParams] = useSearchParams();
  // The URL names the project: the shell's switcher shows it (T2.2).
  useAdoptProject(projectId);
  const asked = params.get('tab');
  const tab: TabId = (TABS as readonly string[]).includes(asked ?? '') ? (asked as TabId) : 'datasets';
  const setTab = (v: string) =>
    setParams((p) => {
      const q = new URLSearchParams(p);
      if (v === 'datasets') q.delete('tab');
      else q.set('tab', v);
      return q;
    }, { replace: true });
  return (
    <Page title={TITLE} sub={SUB}>
      <Tabs value={tab} onValueChange={setTab}>
        <TabList label="Data model views">
          <Tab value="datasets" icon="database">
            Datasets
          </Tab>
        </TabList>
        <TabPanel value="datasets">
          <DatasetsTab projectId={projectId} />
        </TabPanel>
      </Tabs>
    </Page>
  );
}

export default function DataModelPage() {
  const { projectId } = useParams();
  const cur = useCurrentProject();
  const { search } = useLocation();
  if (projectId) return <Section projectId={projectId} />;
  if (cur.status === 'pending') return <PageSkeleton />;
  if (cur.status === 'error') {
    return (
      <Page title={TITLE}>
        <ErrorState title="Projects could not be loaded" message={cur.error?.message ?? 'Try again.'} onRetry={cur.refetch} />
      </Page>
    );
  }
  if (!cur.projectId) {
    return (
      <Page title={TITLE} sub={SUB}>
        <NoProject why={WHY} />
      </Page>
    );
  }
  // `?project=` has done its job once it is in the path.
  const q = new URLSearchParams(search);
  q.delete('project');
  const rest = q.toString();
  return <Navigate to={`/model/${cur.projectId}${rest ? `?${rest}` : ''}`} replace />;
}
