// /reports?project=<id>&tab=reports|stories|scorecards — the desktop's Reports,
// Stories and Scorecards tabs (reportList.ts rbSelectTab, which shared one strip
// with Dashboards and Scenarios; those two have their own routes here). The tab
// is in the URL so a link or Back lands on it.

import { useSearchParams } from 'react-router';
import { Page } from '../../app/blocks';
import { Tab, TabList, TabPanel, Tabs } from '../../ui/Tabs';
import { ProjectGate } from '../import/ProjectGate';
import { ReportList } from './ReportList';
import { ScorecardList } from './scorecards/ScorecardList';
import { StoryList } from './stories/StoryList';

const TABS = ['reports', 'stories', 'scorecards'] as const;
type TabId = (typeof TABS)[number];
const SUB: Record<TabId, string> = {
  reports: 'Dashboards as files you can send — PDF, PowerPoint or Word, built from the figures the app computed.',
  stories: 'Documents you read top to bottom: prose with live charts and metrics in between.',
  scorecards: 'Metrics against their targets, one period at a time.',
};

export default function ReportsPage() {
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab') as TabId | null;
  const tab: TabId = asked && TABS.includes(asked) ? asked : 'reports';
  const select = (t: string) => {
    const next = new URLSearchParams(params);
    if (t === 'reports') next.delete('tab');
    else next.set('tab', t);
    setParams(next, { replace: true });
  };
  return (
    <ProjectGate title="Reports" why="Reports, stories and scorecards belong to a project.">
      {(projectId) => (
        <Page title="Reports" sub={SUB[tab]}>
          <Tabs value={tab} onValueChange={select}>
            <TabList label="Reports area">
              <Tab value="reports" icon="file-text">Reports</Tab>
              <Tab value="stories" icon="type-text">Stories</Tab>
              <Tab value="scorecards" icon="target">Scorecards</Tab>
            </TabList>
            <TabPanel value="reports">
              <ReportList key={projectId} projectId={projectId} />
            </TabPanel>
            <TabPanel value="stories">
              <StoryList key={projectId} projectId={projectId} />
            </TabPanel>
            <TabPanel value="scorecards">
              <ScorecardList key={projectId} projectId={projectId} />
            </TabPanel>
          </Tabs>
        </Page>
      )}
    </ProjectGate>
  );
}
