// The app frame: one 40px top bar across the window, the section rail on the
// left, the routed page on the right — the desktop hub's layout (.hub-topbar,
// .app-sidebar, .ws-panel). Every page renders inside <Outlet/>, under its own
// Suspense (lazy chunk) and error boundary (routes.tsx), so a broken page
// never takes the nav down with it.

import { Suspense } from 'react';
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { nav } from '../api/client';
import { changePasswordPath, signInPath, signOut, signOutEverywhere, useMe, type Me } from '../features/auth/api';
import { Icon } from '../ui/icons/Icon';
import { IconButton } from '../ui/Button';
import { Menu, type MenuEntry } from '../ui/Menu';
import { PageSkeleton } from '../ui/Skeleton';
import { toast, Toaster } from '../ui/Toast';
import { ProjectProvider } from '../features/projects/current';
import { ProjectSwitcher } from '../features/projects/ProjectSwitcher';
import { JobsButton } from './JobsButton';
import { AlertsBell } from '../features/dashboards/AlertsBell';
import { NAV, type NavItem } from './nav';
import { Dock, DockToggle } from '../features/assistant/DockParts';
import { useWorkspacePrefs } from './prefs';
import { CommandPalette, openPalette } from '../features/palette/CommandPalette';
import { THEME_PREFS, useThemePref, type ThemePref } from './theme';
import s from './Shell.module.css';

const THEME_LABEL: Record<ThemePref, string> = { system: 'System', light: 'Light', dark: 'Dark' };

// hubMenus.ts HELP_LINKS — opened in a new tab, never inside the app.
const REPO = 'https://github.com/AshishB2000/screenchart';
const openLink = (url: string) => () => void window.open(url, '_blank', 'noopener,noreferrer');
const HELP_ITEMS: MenuEntry[] = [
  { kind: 'separator' },
  { kind: 'heading', label: 'Help' },
  { label: 'Help and feedback', icon: 'message-square', onSelect: openLink(`${REPO}/issues/new/choose`) },
  { label: "What's new", icon: 'sparkles', onSelect: openLink(`${REPO}/releases`) },
  { label: 'Source on GitHub', icon: 'external-link', onSelect: openLink(REPO) },
];

function NavEntry({ item }: { item: NavItem }) {
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      className={({ isActive }) => (isActive ? `${s.navItem} ${s.active}` : s.navItem)}
    >
      <Icon name={item.icon} size={20} />
      <span className={s.navLabel}>{item.label}</span>
    </NavLink>
  );
}

/** The menu's head: who is signed in (T3.2), or why that is not known. */
function Who({ me, failed }: { me: Me | undefined; failed: boolean }) {
  if (me?.user) {
    const role = me.user.role[0].toUpperCase() + me.user.role.slice(1);
    return (
      <div className={s.menuHead}>
        <span className={s.menuName} data-testid="user-email">
          {me.user.email}
        </span>
        <span className={s.menuMeta}>{me.mode === 'dev' ? 'Development sign-in' : `${role} · ${me.org}`}</span>
      </div>
    );
  }
  return (
    <div className={s.menuHead}>
      <span className={s.menuName}>You</span>
      <span className={s.menuMeta}>{failed ? 'Could not check who is signed in' : 'Checking sign-in…'}</span>
    </div>
  );
}

// A full navigation, not a router push: it drops every cached query the
// signed-out user must not keep seeing.
function onSignOut() {
  signOut().then(
    () => nav.assign('/sign-in'),
    () => toast('Sign out failed. Check your connection and try again.', { kind: 'error' }),
  );
}

// Every session of this user ends — a lost laptop, a shared machine.
function onSignOutEverywhere() {
  signOutEverywhere().then(
    () => nav.assign('/sign-in'),
    () => toast('Signing out everywhere failed. Check your connection and try again.', { kind: 'error' }),
  );
}

function UserMenu() {
  const [theme, setTheme] = useThemePref();
  const navigate = useNavigate();
  const me = useMe();
  // Only a session can be ended here: dev has none, header mode signs out at the proxy.
  const signOutItems: MenuEntry[] = me.data?.canSignOut
    ? [
        { kind: 'separator' },
        { label: 'Sign out', icon: 'log-out', onSelect: onSignOut },
        { label: 'Sign out everywhere', icon: 'monitor', onSelect: onSignOutEverywhere },
      ]
    : [];
  return (
    <Menu
      align="end"
      label="Account"
      trigger={<IconButton icon="user" label="Account and theme" />}
      header={<Who me={me.data} failed={me.isError} />}
      items={[
        { kind: 'separator' },
        { kind: 'heading', label: 'Theme' },
        {
          kind: 'radio',
          label: 'Theme',
          value: theme,
          options: THEME_PREFS.map((p) => ({ value: p, label: THEME_LABEL[p] })),
          onChange: (v) => setTheme(v as ThemePref),
        },
        { kind: 'separator' },
        { label: 'Settings', icon: 'settings', onSelect: () => void navigate('/settings') },
        { label: 'API tokens', icon: 'terminal', onSelect: () => void navigate('/tokens') },
        ...(me.data?.mode === 'password' ? [{ label: 'Change password', icon: 'lock' as const, onSelect: () => void navigate('/change-password') }] : []),
        ...HELP_ITEMS,
        { label: 'About Ordinate', icon: 'info', onSelect: () => void navigate('/about') },
        ...signOutItems,
      ]}
    />
  );
}

export function Shell() {
  useWorkspacePrefs();
  const me = useMe();
  // Admin is for org admins (the server refuses its channels to anyone else):
  // hidden once the role is known to be another; the page explains itself too.
  const role = me.data?.user?.role;
  const shown = NAV.filter((n) => n.to !== '/admin' || role === undefined || role === 'admin');
  const main = shown.filter((n) => !n.bottom);
  const bottom = shown.filter((n) => n.bottom);
  const here = useLocation();
  // Signed out while the app is open (expired, signed out in another tab):
  // the server already sends a signed-out first visit to /sign-in.
  if (me.data && me.data.user === null) return <Navigate to={signInPath(here.pathname + here.search)} replace />;
  // A temporary password: the server already sends every navigation to /change-password; this covers the rest.
  if (me.data?.user?.mustChangePassword) return <Navigate to={changePasswordPath(here.pathname + here.search)} replace />;
  return (
    <ProjectProvider>
      <div className={s.win}>
        <a className={s.skip} href="#main">
          Skip to content
        </a>
        <header className={s.topbar}>
          <div className={s.side}>
            <ProjectSwitcher />
          </div>
          <div className={s.search} role="search">
            <Icon name="search" />
            <input className={s.searchInput} type="search" placeholder="Search" aria-label="Search" aria-haspopup="dialog" readOnly onClick={openPalette} onKeyDown={(e) => (e.key === 'Enter' || e.key.length === 1) && openPalette(e)} />
          </div>
          <div className={`${s.side} ${s.right}`}>
            <AlertsBell />
            <JobsButton />
            <span className={s.divider} aria-hidden="true" />
            <DockToggle />
            <UserMenu />
          </div>
        </header>
        <div className={s.body}>
          <nav className={s.rail} aria-label="Sections">
            <div className={s.nav}>
              {main.map((n) => (
                <NavEntry key={n.to} item={n} />
              ))}
            </div>
            <div className={s.bottom}>
              {bottom.map((n) => (
                <NavEntry key={n.to} item={n} />
              ))}
            </div>
          </nav>
          <main id="main" className={s.stage} tabIndex={-1}>
            <Suspense fallback={<PageSkeleton />}>
              <Outlet />
            </Suspense>
          </main>
          <Dock />
        </div>
        <Toaster />
        <CommandPalette />
      </div>
    </ProjectProvider>
  );
}
