import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, serveRpc, stubFetch } from '../test-utils';
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
    // No AI model here, so no Assistant page in the rail (the next test has one).
    const shown = [...NAV_GROUPS.flatMap((g) => g.items.map((to) => NAV.find((n) => n.to === to)!)), ...NAV.filter((n) => n.bottom)].filter((n) => n.to !== '/assistant');
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(shown.map((n) => n.label));
    expect(within(nav).getAllByRole('link').slice(0, 4).map((a) => a.textContent)).toEqual(['Home', 'Explore', 'Dashboards', 'Reports']);
    for (const g of NAV_GROUPS) {
      expect(within(within(nav).getByRole('group', { name: g.label })).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(g.items.filter((to) => to !== '/assistant'));
    }
    expect(screen.getByRole('search')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Account and theme' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Switch project/ })).toBeTruthy();
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeTruthy();
  });

  it('offers the Assistant’s page right after Home while a model is ready; NEGATIVE CONTROL, none without one', async () => {
    const ready = { ready: true, models: [{ provider: 'anthropic', model: 'm', label: 'M', isDefault: true }], mine: { provider: 'anthropic', model: 'm' }, copilotEnabled: true, keyStore: null };
    serveRpc({ 'ai:status': { body: ready } });
    renderApp('/');
    const nav = screen.getByRole('navigation', { name: 'Sections' });
    const view = within(nav).getByRole('group', { name: 'View' });
    await waitFor(() => expect(within(view).getAllByRole('link').map((a) => a.textContent)).toEqual(['Home', 'Assistant', 'Explore', 'Dashboards', 'Reports']));
    expect(within(view).getByRole('link', { name: 'Assistant' }).getAttribute('href')).toBe('/assistant');
  });

  it('asks nothing of its own for the Assistant’s entry (every page holds an RPC budget): off an AI surface it goes by what this browser saw last', async () => {
    const calls = serveRpc({});
    localStorage.setItem('ordinate.aiReady', '1');
    renderApp('/reports');
    expect(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('link', { name: 'Assistant' }).getAttribute('href')).toBe('/assistant');
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.some((c) => c.channel === 'ai:status')).toBe(false);
  });

  it('hides the Assistant’s page without a model (negative control)', async () => {
    const calls = serveRpc({ 'ai:status': { body: { ready: false, reason: 'no_model', models: [], mine: null, copilotEnabled: true, keyStore: null } } });
    renderApp('/');
    await waitFor(() => expect(calls.some((c) => c.channel === 'ai:status')).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(within(screen.getByRole('navigation', { name: 'Sections' })).queryByRole('link', { name: 'Assistant' })).toBeNull();
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
    for (const n of NAV.filter((x) => x.to !== '/assistant')) expect(within(rail).getByRole('link', { name: n.label }).getAttribute('aria-hidden')).toBeNull();
    expect(rail.hasAttribute('data-picked')).toBe(false);
    fireEvent.click(within(rail).getByRole('link', { name: 'Data' }));
    expect(rail.hasAttribute('data-picked')).toBe(true);
    fireEvent.pointerLeave(rail);
    expect(rail.hasAttribute('data-picked')).toBe(false);
  });

  it('keeps the rail open on Home only', async () => {
    stubFetch(200, []);
    renderApp('/');
    const win = screen.getByRole('navigation', { name: 'Sections' }).parentElement!.parentElement!;
    expect(win.hasAttribute('data-home')).toBe(true);
    fireEvent.click(screen.getByRole('link', { name: 'Data' }));
    await screen.findByRole('heading', { level: 1, name: 'Data' });
    expect(win.hasAttribute('data-home')).toBe(false);
  });

  // The project switcher sits in the top bar, so it shows whether the rail is open or not.
  it('keeps the project switcher in the top bar, out of the rail', () => {
    stubFetch(200, []);
    renderApp('/');
    const topBar = screen.getByRole('search').parentElement!;
    expect(within(topBar).getByRole('button', { name: /Switch project/ })).toBeTruthy();
    expect(within(screen.getByTestId('brand').parentElement!).queryByRole('button', { name: /Switch project/ })).toBeNull();
  });

  const LOGO = 'data:image/png;base64,iVBORw0KGgo=';
  const prefs = (branding: object) => ({ body: { formats: {}, branding: { accent: '', logo: '', dashboardStyle: 'auto', companyName: '', ...branding } } });

  it('heads the rail with the company: its logo, and its name for when the rail opens', async () => {
    const calls = serveRpc({ 'prefs:get': prefs({ logo: 'png', companyName: 'Acme Corp' }), 'branding:logo': { body: { ok: true, dataUrl: LOGO } } });
    renderApp('/');
    const brand = screen.getByTestId('brand');
    await waitFor(() => expect(brand.querySelector('img')?.getAttribute('src')).toBe(LOGO));
    expect(brand.textContent).toBe('Acme Corp');
    expect(calls.filter((c) => c.channel === 'branding:logo')).toHaveLength(1);
  });

  it('without a logo, the initial of the company name, and no call for a logo', async () => {
    const calls = serveRpc({ 'prefs:get': prefs({ companyName: 'acme Corp' }) });
    renderApp('/');
    const brand = screen.getByTestId('brand');
    await within(brand).findByText('acme Corp');
    expect(brand.querySelector('img')).toBeNull();
    expect(brand.querySelector('[aria-hidden="true"]')?.textContent).toBe('A');
    expect(calls.some((c) => c.channel === 'branding:logo')).toBe(false);
  });

  it('with no name and no logo, the rail is headed Ordinate', async () => {
    serveRpc({ 'prefs:get': prefs({}) });
    renderApp('/');
    const brand = screen.getByTestId('brand');
    await waitFor(() => expect(brand.textContent).toBe('OOrdinate'));
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
    expect(within(screen.getByRole('navigation', { name: 'Sections' })).getAllByRole('link')).toHaveLength(NAV.length - 1); // no model: no Assistant page
  });
});
