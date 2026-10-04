// The app-wide commands — commandDefs.ts, ported to routes. Each one goes to
// an existing route or calls the same setter its control calls; a page adds
// its own with `useCommands` while it is mounted.
//
// Changed from the desktop: ⌘1–⌘4 are not bound (a browser keeps them for its
// tabs), zoom is the browser's own, the sidebar toggle and the native menu bar
// are gone. Commands for screens still being ported (prepare, visual builder,
// dashboard editor) arrive with those screens, registered by them.

import { NAV } from '../../app/nav';
import type { ThemePref } from '../../app/theme';
import type { Command } from './registry';

const REPO = 'https://github.com/AshishB2000/screenchart';
/** hubMenus.ts HELP_LINKS — opened in a new tab, never inside the app. */
export const HELP_LINKS = {
  help: `${REPO}/issues/new/choose`,
  whatsNew: `${REPO}/releases`,
  source: REPO,
} as const;

export interface AppCommandDeps {
  go: (to: string) => void;
  /** The caller's org role, or undefined while unknown. */
  role: string | undefined;
  theme: ThemePref;
  setTheme: (p: ThemePref) => void;
  dockOpen: boolean;
  setDockOpen: (open: boolean) => void;
  togglePalette: () => void;
  openShortcuts: () => void;
}

const open = (url: string) => () => void window.open(url, '_blank', 'noopener,noreferrer');

export function appCommands(d: AppCommandDeps): Command[] {
  const isAdmin = () => d.role === 'admin';
  const nav: Command[] = NAV.map((n) => ({
    id: `nav.${n.to === '/' ? 'home' : n.to.slice(1)}`,
    title: `Go to ${n.label}`,
    group: 'Navigate',
    icon: n.icon,
    // Admin is for org admins (the server refuses everyone else): absent otherwise.
    ...(n.to === '/admin' ? { when: () => d.role === undefined || isAdmin() } : {}),
    // Settings keeps its desktop chord.
    ...(n.to === '/settings' ? { keys: 'mod+,' } : {}),
    run: () => d.go(n.to),
  }));
  const next = (p: ThemePref): ThemePref => (p === 'dark' ? 'light' : p === 'light' ? 'dark' : document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  return [
    ...nav,
    { id: 'create.import', title: 'New dataset from a file', group: 'Create', icon: 'upload', run: () => d.go('/data/import') },
    { id: 'create.capture', title: 'New dataset from a screenshot', group: 'Create', icon: 'camera', run: () => d.go('/data/captures') },
    { id: 'create.connect', title: 'New dataset from a connection', group: 'Create', icon: 'plug', run: () => d.go('/connections') },
    // The dashboard wizard (T2.8). The desktop's ⌘N is the browser's own new window here, so no chord.
    { id: 'create.dashboard', title: 'New dashboard', group: 'Create', icon: 'layout-dashboard', run: () => d.go('/analyses?new=1') },
    {
      id: 'ai.toggle',
      title: d.dockOpen ? 'Close the Assistant' : 'Open the Assistant',
      group: 'Assistant',
      icon: 'sparkles',
      keys: 'mod+l',
      bind: false, // the dock binds ⌘L / ⌘J itself (DockParts.tsx)
      run: () => d.setDockOpen(!d.dockOpen),
    },
    { id: 'view.palette', title: 'Command palette', group: 'View', icon: 'search', keys: 'mod+k', run: d.togglePalette },
    { id: 'view.theme', title: 'Toggle dark mode', group: 'View', icon: 'eye', run: () => d.setTheme(next(d.theme)) },
    { id: 'view.themeSystem', title: 'Follow the system theme', group: 'View', icon: 'monitor', when: () => d.theme !== 'system', run: () => d.setTheme('system') },
    { id: 'settings.org', title: 'Organization settings', group: 'Settings', icon: 'shield', when: isAdmin, run: () => d.go('/admin?tab=workspace') },
    { id: 'settings.themes', title: 'Dashboard themes', group: 'Settings', icon: 'layers', when: isAdmin, run: () => d.go('/admin?tab=themes') },
    { id: 'settings.backups', title: 'Back up or restore every project', group: 'Settings', icon: 'hard-drive', when: isAdmin, run: () => d.go('/admin?tab=backups') },
    { id: 'settings.privacy', title: 'Privacy and the Share policy', group: 'Settings', icon: 'lock', run: () => d.go('/settings?tab=privacy') },
    { id: 'settings.tokens', title: 'API tokens', group: 'Settings', icon: 'terminal', run: () => d.go('/tokens') },
    { id: 'help.shortcuts', title: 'Keyboard shortcuts', group: 'Help', icon: 'info', keys: '?', run: d.openShortcuts },
    { id: 'help.about', title: 'About Ordinate', group: 'Help', icon: 'info', run: () => d.go('/about') },
    { id: 'help.whatsNew', title: "What's new", group: 'Help', icon: 'sparkles', run: open(HELP_LINKS.whatsNew) },
    { id: 'help.report', title: 'Report a problem', group: 'Help', icon: 'message-square', run: open(HELP_LINKS.help) },
  ];
}
