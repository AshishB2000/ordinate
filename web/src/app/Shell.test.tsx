import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import { renderApp, stubFetch } from '../test-utils';
import { media } from '../test-setup';
import { NAV } from './nav';
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
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(NAV.map((n) => n.label));
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
