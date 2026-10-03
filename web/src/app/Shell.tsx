// The app frame: one 40px top bar across the window, the section rail on the
// left, the routed page on the right — the desktop hub's layout (.hub-topbar,
// .app-sidebar, .ws-panel). Every page renders inside <Outlet/>, under its own
// Suspense (lazy chunk) and error boundary (routes.tsx), so a broken page
// never takes the nav down with it.

import { Suspense } from 'react';
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { nav } from '../api/client';
import { signInPath, signOut, useMe, type Me } from '../features/auth/api';
import { Icon } from '../ui/icons/Icon';
import { IconButton } from '../ui/Button';
import { Menu, type MenuEntry } from '../ui/Menu';
import { PageSkeleton } from '../ui/Skeleton';
import { toast, Toaster } from '../ui/Toast';
import { NAV, type NavItem } from './nav';
import { THEME_PREFS, useThemePref, type ThemePref } from './theme';
import s from './Shell.module.css';

const THEME_LABEL: Record<ThemePref, string> = { system: 'System', light: 'Light', dark: 'Dark' };

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

function UserMenu() {
  const [theme, setTheme] = useThemePref();
  const navigate = useNavigate();
  const me = useMe();
  // Only a session can be ended here: dev has none, header mode signs out at the proxy.
  const signOutItems: MenuEntry[] = me.data?.canSignOut
    ? [{ kind: 'separator' }, { label: 'Sign out', icon: 'log-out', onSelect: onSignOut }]
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
        ...signOutItems,
      ]}
    />
  );
}

export function Shell() {
  const main = NAV.filter((n) => !n.bottom);
  const bottom = NAV.filter((n) => n.bottom);
  const me = useMe();
  const here = useLocation();
  // Signed out while the app is open (expired, signed out in another tab):
  // the server already sends a signed-out first visit to /sign-in.
  if (me.data && me.data.user === null) return <Navigate to={signInPath(here.pathname + here.search)} replace />;
  return (
    <div className={s.win}>
      <a className={s.skip} href="#main">
        Skip to content
      </a>
      <header className={s.topbar}>
        <div className={s.side}>
          <button
            type="button"
            className={s.project}
            aria-disabled="true"
            aria-label="Switch project (coming soon)"
            title="Project switching is coming soon"
          >
            <span className={s.projectAvatar}>
              <Icon name="folder" />
            </span>
            <span className={s.projectName}>All projects</span>
            <Icon name="chevron-down" />
          </button>
        </div>
        <div className={s.search} role="search">
          <Icon name="search" />
          <input className={s.searchInput} type="search" placeholder="Search" aria-label="Search" />
        </div>
        <div className={`${s.side} ${s.right}`}>
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
      </div>
      <Toaster />
    </div>
  );
}
