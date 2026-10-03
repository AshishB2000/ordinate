// The left nav, top to bottom. APPEND-ONLY (plan §6): a new area adds a line;
// never reorder or reformat, so parallel screen ports do not conflict here.
// `bottom` pins an item to the foot of the rail, as Settings is on the desktop.

import type { IconName } from './Icon';

export interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly icon: IconName;
  readonly bottom?: boolean;
}

export const NAV: readonly NavItem[] = [
  { to: '/', label: 'Home', icon: 'home' },
  { to: '/data', label: 'Data', icon: 'database' },
  { to: '/visuals', label: 'Visuals', icon: 'chart-bar' },
  { to: '/analyses', label: 'Analyses', icon: 'layers' },
  { to: '/dashboards', label: 'Dashboards', icon: 'layout-dashboard' },
  { to: '/explore', label: 'Explore', icon: 'trending-up' },
  { to: '/reports', label: 'Reports', icon: 'file-text' },
  { to: '/settings', label: 'Settings', icon: 'settings', bottom: true },
];
