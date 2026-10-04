// My settings — the per-USER half of the desktop Settings panel. What is the
// organization's (formats, branding, themes, the Assistant's rules, backups)
// lives under Admin → Organization, for admins; what is a project's (the Share
// policy) is the Privacy tab, for the current project. What only made sense on
// one machine is gone: the global hotkey, launch at login, the Screen Recording
// permission, local-CLI models, delete-my-data on this device.

import { useCallback, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router';
import { nav } from '../../api/client';
import { Page } from '../../app/blocks';
import { THEME_PREFS, useThemePref, type ThemePref } from '../../app/theme';
import { Button } from '../../ui/Button';
import { SkeletonBlock } from '../../ui/Skeleton';
import { ErrorState } from '../../ui/States';
import { Tab, TabList, TabPanel, Tabs } from '../../ui/Tabs';
import { toast } from '../../ui/Toast';
import { Icon, type IconName } from '../../ui/icons/Icon';
import { signOut, signOutEverywhere, useMe, type Me } from '../auth/api';
import { useCurrentProject } from '../projects/current';
import { useCommands } from '../palette/registry';
import { KeyCaps, ShortcutList } from '../palette/ShortcutsSheet';
import { PrivacySection } from './PrivacySection';
import { Group, Row, Segmented } from './Rows';
import s from './Settings.module.css';

const THEME_LABEL: Record<ThemePref, string> = { system: 'System', light: 'Light', dark: 'Dark' };
const TABS = ['you', 'privacy'] as const;
type TabId = (typeof TABS)[number];

function Who({ me }: { me: Me }) {
  const email = me.user?.email ?? 'You';
  const role = me.user ? me.user.role[0].toUpperCase() + me.user.role.slice(1) : '';
  const end = (fn: () => Promise<void>, failed: string) => () =>
    void fn().then(
      () => nav.assign('/sign-in'),
      () => toast(failed, { kind: 'error' }),
    );
  return (
    <Group title="Signed in" desc={me.mode === 'header' ? 'Your sign-in is managed by the proxy in front of this server.' : undefined}>
      <div className={s.who}>
        <span className={s.avatar} aria-hidden="true">
          {email[0]}
        </span>
        <span className={s.whoText}>
          <span className={s.whoName} data-testid="settings-email">
            {email}
          </span>
          <span className={s.whoMeta}>{me.mode === 'dev' ? 'Development sign-in · every request is an admin' : `${role} · ${me.org ?? ''}`}</span>
        </span>
      </div>
      {me.canSignOut && (
        <div className={s.actionsRow}>
          <Button icon="monitor" onClick={end(signOutEverywhere, 'Signing out everywhere failed. Check your connection and try again.')}>
            Sign out everywhere
          </Button>
          <Button icon="log-out" onClick={end(signOut, 'Sign out failed. Check your connection and try again.')}>
            Sign out
          </Button>
        </div>
      )}
    </Group>
  );
}

function LinkCard({ to, icon, title, desc }: { to: string; icon: IconName; title: string; desc: string }) {
  return (
    <Link to={to} className={s.linkCard}>
      <span className={s.linkIcon}>
        <Icon name={icon} />
      </span>
      <span className={s.linkText}>
        <span className={s.linkTitle}>{title}</span>
        <span className={s.linkDesc}>{desc}</span>
      </span>
    </Link>
  );
}

function You({ me }: { me: Me }) {
  const [theme, setTheme] = useThemePref();
  const { project } = useCurrentProject();
  const admin = me.user?.role === 'admin';
  return (
    <div className={`${s.cols} ${s.stackPage}`}>
      <div className={s.side}>
        <Who me={me} />
        <Group title="Appearance" desc="Kept in this browser, like the system setting it can follow.">
          <Row title="Theme" desc="Follow the system, or always light or dark.">
            <Segmented label="Theme" value={theme} onChange={setTheme} options={THEME_PREFS.map((p) => ({ value: p, label: THEME_LABEL[p] }))} />
          </Row>
        </Group>
        <Group
          title="Keyboard"
          desc={
            <>
              <KeyCaps keys="mod+k" /> opens the command palette — every command, and the records in this project. <KeyCaps keys="?" /> shows this list anywhere.
            </>
          }
        >
          <div className={s.pad}>
            <ShortcutList />
          </div>
        </Group>
      </div>
      <aside className={s.side} aria-label="More settings">
        {admin && <LinkCard to="/admin?tab=workspace" icon="shield" title="Organization settings" desc="Formats, branding, dashboard themes, the Assistant's rules and backups — for everyone." />}
        <LinkCard to="/settings?tab=privacy" icon="lock" title="Privacy" desc={project ? `The Share policy and sensitive columns of ${project.name}.` : 'The Share policy of the current project.'} />
        <LinkCard to="/tokens" icon="terminal" title="API tokens and MCP" desc="Use Ordinate from a script, the command line or an MCP client such as Claude Code." />
        <LinkCard to="/about" icon="info" title="About Ordinate" desc="Version, licences of the software it bundles, and links." />
      </aside>
    </div>
  );
}

export default function SettingsPage() {
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab');
  const tab: TabId = (TABS as readonly string[]).includes(asked ?? '') ? (asked as TabId) : 'you';
  const pick = useCallback((v: string) => setParams(v === 'you' ? {} : { tab: v }, { replace: true }), [setParams]);
  // This page's own commands, while it is open.
  useCommands(
    useMemo(
      () => [
        { id: 'settings.tab.you', title: 'Settings: you', group: 'Settings' as const, icon: 'user' as const, when: () => tab !== 'you', run: () => pick('you') },
        { id: 'settings.tab.privacy', title: 'Settings: privacy of this project', group: 'Settings' as const, icon: 'lock' as const, when: () => tab !== 'privacy', run: () => pick('privacy') },
      ],
      [tab, pick],
    ),
  );

  return (
    <Page title="Settings" sub="Yours: how Ordinate looks and behaves for you, in this browser. The organization's settings are under Admin.">
      {me.isPending ? (
        <SkeletonBlock label="Loading your settings" />
      ) : me.isError ? (
        <ErrorState title="Could not check who is signed in" message={me.error.message} onRetry={() => void me.refetch()} />
      ) : (
        <Tabs value={tab} onValueChange={pick}>
          <TabList label="Settings">
            <Tab value="you" icon="user">
              You
            </Tab>
            <Tab value="privacy" icon="lock">
              Privacy
            </Tab>
          </TabList>
          <TabPanel value="you">
            <You me={me.data} />
          </TabPanel>
          <TabPanel value="privacy">
            <PrivacySection />
          </TabPanel>
        </Tabs>
      )}
    </Page>
  );
}
