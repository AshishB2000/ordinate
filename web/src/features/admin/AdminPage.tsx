// Admin (T3.4): the org admin's screen — people, teams, project ownership,
// the audit log and org settings, one tab each (the tab is in the URL, so a
// link opens it). The server refuses every admin channel to anyone below org
// admin; this page only says so instead of showing five failed loads.

import { useSearchParams } from 'react-router';
import { Page } from '../../app/blocks';
import { useMe } from '../auth/api';
import { PageSkeleton } from '../../ui/Skeleton';
import { EmptyState, ErrorState } from '../../ui/States';
import { Tab, TabList, TabPanel, Tabs } from '../../ui/Tabs';
import { AuditTab } from './AuditTab';
import { ProjectsTab } from './ProjectsTab';
import { SettingsTab } from './SettingsTab';
import { TeamsTab } from './TeamsTab';
import { UsersTab } from './UsersTab';
import { NoAccounts } from './NoAccounts';

const TABS = ['people', 'teams', 'projects', 'audit', 'settings'] as const;
type TabId = (typeof TABS)[number];

export default function AdminPage() {
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab');
  const tab: TabId = (TABS as readonly string[]).includes(asked ?? '') ? (asked as TabId) : 'people';

  if (me.isPending) return <PageSkeleton />;
  if (me.isError) {
    return (
      <Page title="Admin">
        <ErrorState title="Could not check who is signed in" message={me.error.message} onRetry={() => void me.refetch()} />
      </Page>
    );
  }
  if (me.data.accounts === false) return <NoAccounts title="Admin" />;
  if (me.data.user?.role !== 'admin') {
    return (
      <Page title="Admin">
        <EmptyState icon="shield" title="Only organization admins can open Admin">
          Ask an admin of {me.data.org ?? 'your organization'} to change roles, teams or settings for you.
        </EmptyState>
      </Page>
    );
  }
  return (
    <Page title="Admin" sub="Who can sign in, the teams they belong to, who owns each project, and what happened.">
      <Tabs value={tab} onValueChange={(v) => setParams(v === 'people' ? {} : { tab: v }, { replace: true })}>
        <TabList label="Admin">
          <Tab value="people" icon="user">
            People
          </Tab>
          <Tab value="teams" icon="layers">
            Teams
          </Tab>
          <Tab value="projects" icon="folder">
            Projects
          </Tab>
          <Tab value="audit" icon="history">
            Audit log
          </Tab>
          <Tab value="settings" icon="settings">
            Settings
          </Tab>
        </TabList>
        <TabPanel value="people">
          <UsersTab me={me.data.user.email} />
        </TabPanel>
        <TabPanel value="teams">
          <TeamsTab />
        </TabPanel>
        <TabPanel value="projects">
          <ProjectsTab />
        </TabPanel>
        <TabPanel value="audit">
          <AuditTab />
        </TabPanel>
        <TabPanel value="settings">
          <SettingsTab />
        </TabPanel>
      </Tabs>
    </Page>
  );
}
