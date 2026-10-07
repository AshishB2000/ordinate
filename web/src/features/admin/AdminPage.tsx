// Admin (T3.4): the org admin's screen — people, teams, project ownership,
// the audit log and org settings, one tab each (the tab is in the URL, so a
// link opens it). The server refuses every admin channel to anyone below org
// admin; this page only says so instead of showing five failed loads.
//
// T2.14 adds the ORGANIZATION settings the desktop kept in its Settings panel
// — the workspace's formats, branding and Assistant rules, dashboard themes,
// and backups. Those live in the org's config, not in Postgres, so a server
// without accounts (dev) still shows them; the account tabs need Postgres.

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
import { WorkspaceTab } from '../settings/WorkspaceTab';
import { ThemesTab } from '../settings/ThemesTab';
import { BackupsTab } from '../settings/BackupsTab';
import { Icon } from '../../ui/icons/Icon';
import s from './Admin.module.css';

const ACCOUNT_TABS = ['people', 'teams', 'projects', 'audit', 'settings'] as const;
const ORG_TABS = ['workspace', 'themes', 'backups'] as const;
type TabId = (typeof ACCOUNT_TABS)[number] | (typeof ORG_TABS)[number];

export default function AdminPage() {
  const me = useMe();
  const [params, setParams] = useSearchParams();

  if (me.isPending) return <PageSkeleton />;
  if (me.isError) {
    return (
      <Page title="Admin">
        <ErrorState title="Could not check who is signed in" message={me.error.message} onRetry={() => void me.refetch()} />
      </Page>
    );
  }
  const accounts = me.data.accounts !== false;
  // Without accounts every request is the dev admin (src/server/context.ts); with them, the role decides.
  if (accounts && me.data.user?.role !== 'admin') {
    return (
      <Page title="Admin">
        <EmptyState icon="shield" title="Only organization admins can open Admin">
          Ask an admin of {me.data.org ?? 'your organization'} to change roles, teams or settings for you.
        </EmptyState>
      </Page>
    );
  }
  if (!accounts && me.data.user?.role !== 'admin') return <NoAccounts title="Admin" />;
  const tabs: readonly TabId[] = accounts ? [...ACCOUNT_TABS, ...ORG_TABS] : ORG_TABS;
  const first = tabs[0];
  const asked = params.get('tab');
  const tab: TabId = (tabs as readonly string[]).includes(asked ?? '') ? (asked as TabId) : first;
  return (
    <Page
      title="Admin"
      sub={
        accounts
          ? 'Who can sign in, the teams they belong to, who owns each project, what happened — and the organization’s own settings.'
          : 'The organization’s own settings: formats, branding, dashboard themes and backups.'
      }
    >
      {!accounts && (
        <div className={s.notice} role="note">
          <Icon name="database" />
          <div>
            <h2 className={s.noticeTitle}>This server keeps no accounts</h2>
            <p className={s.lead}>
              Members, teams, project ownership and the audit log are stored in Postgres, and this server runs without one. Set DATABASE_URL and sign-in (AUTH_MODE) to
              manage them here. The organization settings below work either way.
            </p>
          </div>
        </div>
      )}
      <Tabs value={tab} onValueChange={(v) => setParams(v === first ? {} : { tab: v }, { replace: true })}>
        <TabList label="Admin">
          {accounts && (
            <>
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
            </>
          )}
          <Tab value="workspace" icon="sliders">
            Workspace
          </Tab>
          <Tab value="themes" icon="layout-dashboard">
            Themes
          </Tab>
          <Tab value="backups" icon="hard-drive">
            Backups
          </Tab>
        </TabList>
        {accounts && (
          <>
            <TabPanel value="people">
              <UsersTab me={me.data.user?.email ?? ''} passwords={me.data.mode === 'password'} />
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
          </>
        )}
        <TabPanel value="workspace">
          <WorkspaceTab />
        </TabPanel>
        <TabPanel value="themes">
          <ThemesTab />
        </TabPanel>
        <TabPanel value="backups">
          <BackupsTab />
        </TabPanel>
      </Tabs>
    </Page>
  );
}
