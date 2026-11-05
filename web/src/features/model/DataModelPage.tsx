// /model and /model/:projectId — the Data model (docs/semantic-layer/00-design.md "The name and where it
// sits"): what the project's data means, on one screen. /model goes to the current project, as /data does.
// The tab is in the URL (?tab=); TABS lists them in the order they are drawn (Source tables second, editors only).

import { useState } from 'react';
import { Navigate, useLocation, useParams, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ErrorState, Page, PageSkeleton } from '../../app/blocks';
import { Button } from '../../ui/Button';
import { Tab, TabList, TabPanel, Tabs } from '../../ui/Tabs';
import { useAdoptProject, useCurrentProject } from '../projects/current';
import { NoProject } from '../projects/NoProject';
import { useCanEdit, useRoles } from '../projects/api';
import { MetricEditor } from '../analyses/metrics/MetricEditor';
import { DatasetsTab } from './datasets/DatasetsTab';
import { SourcesLoading, SourceTablesTab } from './sources/SourceTablesTab';
import { AssistantTab } from './assistant/AssistantTab';
import { MetricsTab } from './metrics/MetricsTab';
import { GlossaryTab } from './terms/GlossaryTab';
import { TermDialog } from './terms/TermDialog';
import { RelationshipsTab } from '../data/RelationshipsTab';
import { DefaultJoins } from './relationships/DefaultJoins';

const TABS = ['datasets', 'sources', 'metrics', 'glossary', 'relationships', 'assistant'] as const;
type TabId = (typeof TABS)[number];

const TITLE = 'Data model';
const SUB = 'What your data means: datasets, fields, metrics and business terms. Every chart, the Assistant and agents use it.';
const WHY = 'The data model belongs to a project.';

function Section({ projectId }: { projectId: string }) {
  const [params, setParams] = useSearchParams();
  // The URL names the project: the shell's switcher shows it (T2.2).
  useAdoptProject(projectId);
  const canEdit = useCanEdit(projectId);
  const roles = useRoles();
  const client = useQueryClient();
  const [newMetric, setNewMetric] = useState(false);
  const [newTerm, setNewTerm] = useState(false);
  const asked = params.get('tab');
  const tab: TabId = (TABS as readonly string[]).includes(asked ?? '') ? (asked as TabId) : 'datasets';
  const setTab = (v: string) =>
    setParams((p) => {
      const q = new URLSearchParams(p);
      if (v === 'datasets') q.delete('tab');
      else q.set('tab', v);
      return q;
    }, { replace: true });
  const metricSaved = () => {
    void client.invalidateQueries({ queryKey: ['metric:table', projectId] });
    void client.invalidateQueries({ queryKey: ['metric:list', projectId] });
    setTab('metrics');
  };
  // Source tables are an editor's: a viewer's address lands on Datasets, once the roles are known (not before: an editor's link waits).
  if (tab === 'sources' && !roles.isPending && !canEdit) return <Navigate to="?tab=datasets" replace />;
  return (
    <Page
      title={TITLE}
      sub={SUB}
      actions={
        // On every tab, so an empty Metrics or Glossary tab does not repeat them (one door, never two).
        canEdit && (
          <>
            <Button icon="plus" onClick={() => setNewTerm(true)}>
              New term
            </Button>
            <Button variant="primary" icon="plus" onClick={() => setNewMetric(true)}>
              New metric
            </Button>
          </>
        )
      }
    >
      <Tabs value={tab} onValueChange={setTab}>
        <TabList label="Data model views">
          <Tab value="datasets" icon="database">
            Datasets
          </Tab>
          {canEdit && (
            <Tab value="sources" icon="table">
              Source tables
            </Tab>
          )}
          <Tab value="metrics" icon="target">
            Metrics
          </Tab>
          <Tab value="glossary" icon="list">
            Glossary
          </Tab>
          <Tab value="relationships" icon="link">
            Relationships
          </Tab>
          <Tab value="assistant" icon="sparkles">
            Assistant
          </Tab>
        </TabList>
        <TabPanel value="datasets">
          <DatasetsTab projectId={projectId} />
        </TabPanel>
        <TabPanel value="sources">{canEdit ? <SourceTablesTab projectId={projectId} /> : <SourcesLoading />}</TabPanel>
        <TabPanel value="metrics">
          <MetricsTab projectId={projectId} />
        </TabPanel>
        <TabPanel value="glossary">
          <GlossaryTab projectId={projectId} />
        </TabPanel>
        <TabPanel value="relationships">
          <RelationshipsTab projectId={projectId} />
          <DefaultJoins projectId={projectId} />
        </TabPanel>
        <TabPanel value="assistant">
          <AssistantTab projectId={projectId} />
        </TabPanel>
      </Tabs>
      {newMetric && canEdit && <MetricEditor projectId={projectId} existing={{}} onClose={() => setNewMetric(false)} onSaved={metricSaved} />}
      {newTerm && canEdit && <TermDialog projectId={projectId} onClose={() => setNewTerm(false)} onSaved={() => setTab('glossary')} />}
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
