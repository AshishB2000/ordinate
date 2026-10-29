import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { renderApp, stubFetch } from '../test-utils';
import { media } from '../test-setup';
import { NAV } from './nav';
import { NAV_GROUPS } from './navGroups';
import { RouteError } from './errors';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  media.systemDark = false;
});

describe('shell', () => {
  it('renders the nav, the top bar and the routed page', async () => {
    stubFetch(200, []);
    renderApp('/');
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    // The rail draws its groups in order (navGroups.ts: View, then Build), then
    // the `bottom` items pinned to its foot — not NAV's append-only order.
    const shown = [...NAV_GROUPS.flatMap((g) => g.items.map((to) => NAV.find((n) => n.to === to)!)), ...NAV.filter((n) => n.bottom)];
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(shown.map((n) => n.label));
    expect(within(nav).getAllByRole('link').slice(0, 4).map((a) => a.textContent)).toEqual(['Home', 'Explore', 'Dashboards', 'Reports']);
    for (const g of NAV_GROUPS) {
      expect(within(within(nav).getByRole('group', { name: g.label })).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(g.items);
    }
    expect(screen.getByRole('search')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Account and theme' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Switch project/ })).toBeTruthy();
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeTruthy();
  });

  it('keeps every nav item keyboard reachable and navigates on activation', async () => {
    stubFetch(200, []);
    renderApp('/');
    const links = within(screen.getByRole('navigation', { name: 'Sections' })).getAllByRole('link');
    for (const a of links) {
      expect(a.getAttribute('href')).toMatch(/^\//);
      expect(a.getAttribute('tabindex')).toBeNull();
      a.focus();
      expect(document.activeElement).toBe(a);
    }
    const data = screen.getByRole('link', { name: 'Data' });
    fireEvent.click(data);
    expect(await screen.findByRole('heading', { level: 1, name: 'Data' })).toBeTruthy();
    expect(data.getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('link', { name: 'Home' }).getAttribute('aria-current')).toBeNull();
  });

  it('the closed rail keeps every name, and picking a section folds it until the pointer leaves', () => {
    stubFetch(200, []);
    renderApp('/');
    const rail = screen.getByRole('navigation', { name: 'Sections' }).parentElement!;
    // Closed, the labels are faded, not removed: each link is still found by its name.
    for (const n of NAV) expect(within(rail).getByRole('link', { name: n.label }).getAttribute('aria-hidden')).toBeNull();
    expect(within(rail).getByRole('button', { name: /Switch project/ })).toBeTruthy();
    expect(rail.hasAttribute('data-picked')).toBe(false);
    fireEvent.click(within(rail).getByRole('link', { name: 'Data' }));
    expect(rail.hasAttribute('data-picked')).toBe(true);
    fireEvent.pointerLeave(rail);
    expect(rail.hasAttribute('data-picked')).toBe(false);
  });

  it('switches theme between system, light and dark from the account menu', () => {
    stubFetch(200, []);
    renderApp('/');
    const root = document.documentElement;
    expect(root.dataset.theme).toBe('light'); // system default, OS light

    const account = screen.getByRole('button', { name: 'Account and theme' });
    const pick = (name: string) => {
      fireEvent.keyDown(account, { key: 'Enter' });
      fireEvent.click(screen.getByRole('menuitemradio', { name }));
    };

    pick('Dark');
    expect(root.dataset.theme).toBe('dark');
    expect(localStorage.getItem('ordinate.theme')).toBe('dark');
    fireEvent.keyDown(account, { key: 'Enter' });
    expect(screen.getByRole('menuitemradio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });

    pick('Light');
    expect(root.dataset.theme).toBe('light');

    media.systemDark = true;
    pick('System');
    expect(root.dataset.theme).toBe('dark');
    expect(localStorage.getItem('ordinate.theme')).toBeNull();
  });

  it('the account menu reaches Settings', async () => {
    stubFetch(200, []);
    renderApp('/');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Account and theme' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
  });

  it('mounts the toast stack once', () => {
    stubFetch(200, []);
    renderApp('/');
    expect(screen.getAllByRole('status', { name: 'Notifications' })).toHaveLength(1);
  });

  it('shows a 404 inside the shell for an unknown address', () => {
    renderApp('/no/such/page');
    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Sections' })).toBeTruthy();
  });

  it('contains a page crash to that page', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const Boom = () => {
      throw new Error('kaboom');
    };
    renderApp('/boom', [{ path: 'boom', element: <Boom />, errorElement: <RouteError /> }]);
    expect(screen.getByRole('alert').textContent).toContain('kaboom');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    // the shell survived: nav still there and usable
    expect(within(screen.getByRole('navigation', { name: 'Sections' })).getAllByRole('link')).toHaveLength(NAV.length);
  });
});
