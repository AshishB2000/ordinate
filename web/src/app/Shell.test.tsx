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

  it('switches theme between system, light and dark', () => {
    stubFetch(200, []);
    renderApp('/');
    // The menu is a native popover, which jsdom does not open: query it hidden.
    const root = document.documentElement;
    expect(root.dataset.theme).toBe('light'); // system default, OS light

    fireEvent.click(screen.getByRole('button', { name: 'Dark', hidden: true }));
    expect(root.dataset.theme).toBe('dark');
    expect(localStorage.getItem('ordinate.theme')).toBe('dark');
    expect(screen.getByRole('button', { name: 'Dark', hidden: true }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: 'Light', hidden: true }));
    expect(root.dataset.theme).toBe('light');

    media.systemDark = true;
    fireEvent.click(screen.getByRole('button', { name: 'System', hidden: true }));
    expect(root.dataset.theme).toBe('dark');
    expect(localStorage.getItem('ordinate.theme')).toBeNull();
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
