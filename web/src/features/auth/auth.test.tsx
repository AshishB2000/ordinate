import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderApp } from '../../test-utils';
import { nav, rpc } from '../../api/client';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ALICE = { user: { email: 'alice@acme.test', role: 'editor' }, org: 'acme', mode: 'oidc', canSignOut: true };
const SIGNED_OUT = { user: null, org: null, mode: 'oidc', canSignOut: false };

/** fetch answered per path; anything else is an empty list (the Home page). */
function routeFetch(routes: Record<string, { status?: number; body?: unknown }>) {
  const spy = vi.fn(async (url: string, _init?: RequestInit) => {
    const r = routes[url.split('?')[0]] ?? { body: [] };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200 });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('sign-in page', () => {
  it('sends the browser to /api/auth/login, carrying where to come back to', async () => {
    routeFetch({ '/api/auth/me': { body: SIGNED_OUT } });
    renderApp('/sign-in?next=%2Fdata');
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in to Ordinate' })).toBeTruthy();
    const go = screen.getByRole('link', { name: /Continue with single sign-on/ });
    expect(go.getAttribute('href')).toBe('/api/auth/login?next=%2Fdata');
    expect(screen.queryByRole('alert')).toBeNull();
    // outside the shell: no section nav for someone not signed in
    expect(screen.queryByRole('navigation', { name: 'Sections' })).toBeNull();
  });

  it('never carries an off-site next', async () => {
    routeFetch({ '/api/auth/me': { body: SIGNED_OUT } });
    renderApp('/sign-in?next=%2F%2Fevil.example');
    const go = await screen.findByRole('link', { name: /Continue with single sign-on/ });
    expect(go.getAttribute('href')).toBe('/api/auth/login');
  });

  it('designs the failed-login state, and the button becomes a retry', async () => {
    routeFetch({ '/api/auth/me': { body: SIGNED_OUT } });
    renderApp('/sign-in?error=domain');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("We couldn't sign you in");
    expect(alert.textContent).toContain('email domain');
    expect(screen.getByRole('link', { name: /Try again/ }).getAttribute('href')).toBe('/api/auth/login');
  });

  it('falls back to a generic message for an unknown error code', async () => {
    routeFetch({ '/api/auth/me': { body: SIGNED_OUT } });
    renderApp('/sign-in?error=whatever');
    expect((await screen.findByRole('alert')).textContent).toContain("Sign-in didn't complete");
  });

  it('header mode explains the proxy instead of offering a login it cannot do', async () => {
    routeFetch({ '/api/auth/me': { body: { ...SIGNED_OUT, mode: 'header' } } });
    renderApp('/sign-in');
    expect(await screen.findByText(/access proxy/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: /single sign-on/ })).toBeNull();
  });

  it('an already signed-in visitor goes straight to next', async () => {
    routeFetch({ '/api/auth/me': { body: ALICE } });
    const router = renderApp('/sign-in?next=%2Fdata');
    await waitFor(() => expect(router.state.location.pathname).toBe('/data'));
  });
});

describe('shell sign-in wiring', () => {
  /** Opens the kit account menu (Radix opens on Enter from the trigger). */
  const openMenu = async () => {
    const account = await screen.findByRole('button', { name: 'Account and theme' });
    fireEvent.keyDown(account, { key: 'Enter' });
  };

  it('shows the signed-in user and their role in the account menu', async () => {
    routeFetch({ '/api/auth/me': { body: ALICE } });
    renderApp('/');
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    await waitFor(async () => {
      await openMenu();
      expect(screen.getByTestId('user-email').textContent).toBe('alice@acme.test');
    });
    expect(screen.getByText('Editor · acme')).toBeTruthy();
  });

  it('signs out: POST /api/auth/logout, then to the sign-in page', async () => {
    const spy = routeFetch({ '/api/auth/me': { body: ALICE }, '/api/auth/logout': { status: 204 } });
    const go = vi.spyOn(nav, 'assign').mockImplementation(() => {});
    renderApp('/');
    await waitFor(async () => {
      await openMenu();
      expect(screen.getByRole('menuitem', { name: 'Sign out' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => expect(go).toHaveBeenCalledWith('/sign-in'));
    expect(spy.mock.calls.some(([url, init]) => url === '/api/auth/logout' && init?.method === 'POST')).toBe(true);
  });

  it('sign-out carries the CSRF header (T6.2)', async () => {
    vi.spyOn(document, 'cookie', 'get').mockReturnValue(`ordinate_csrf=${'c'.repeat(43)}`);
    const spy = routeFetch({ '/api/auth/me': { body: ALICE }, '/api/auth/logout': { status: 204 } });
    vi.spyOn(nav, 'assign').mockImplementation(() => {});
    renderApp('/');
    await waitFor(async () => {
      await openMenu();
      expect(screen.getByRole('menuitem', { name: 'Sign out' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => expect(spy.mock.calls.some(([url]) => url === '/api/auth/logout')).toBe(true));
    const init = spy.mock.calls.find(([url]) => url === '/api/auth/logout')?.[1];
    expect((init?.headers as Record<string, string> | undefined)?.['X-CSRF-Token']).toBe('c'.repeat(43));
  });

  it('signs out everywhere: POST /api/auth/logout-everywhere, then to the sign-in page', async () => {
    const spy = routeFetch({ '/api/auth/me': { body: ALICE }, '/api/auth/logout-everywhere': { body: { ended: 3 } } });
    const go = vi.spyOn(nav, 'assign').mockImplementation(() => {});
    renderApp('/');
    await waitFor(async () => {
      await openMenu();
      expect(screen.getByRole('menuitem', { name: 'Sign out everywhere' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out everywhere' }));
    await waitFor(() => expect(go).toHaveBeenCalledWith('/sign-in'));
    expect(spy.mock.calls.some(([url, init]) => url === '/api/auth/logout-everywhere' && init?.method === 'POST')).toBe(true);
  });

  it('says so when signing out everywhere fails, and stays put', async () => {
    routeFetch({ '/api/auth/me': { body: ALICE }, '/api/auth/logout-everywhere': { status: 500 } });
    const go = vi.spyOn(nav, 'assign').mockImplementation(() => {});
    renderApp('/');
    await waitFor(async () => {
      await openMenu();
      expect(screen.getByRole('menuitem', { name: 'Sign out everywhere' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out everywhere' }));
    expect(await screen.findByText(/Signing out everywhere failed/)).toBeTruthy();
    expect(go).not.toHaveBeenCalled();
  });

  it('says so when sign-out fails, and stays put', async () => {
    routeFetch({ '/api/auth/me': { body: ALICE }, '/api/auth/logout': { status: 500 } });
    const go = vi.spyOn(nav, 'assign').mockImplementation(() => {});
    renderApp('/');
    await waitFor(async () => {
      await openMenu();
      expect(screen.getByRole('menuitem', { name: 'Sign out' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(await screen.findByText(/Sign out failed/)).toBeTruthy();
    expect(go).not.toHaveBeenCalled();
  });

  it('offers no sign-out where there is no session to end (dev, header)', async () => {
    routeFetch({ '/api/auth/me': { body: { ...ALICE, mode: 'dev', canSignOut: false } } });
    renderApp('/');
    await waitFor(async () => {
      await openMenu();
      expect(screen.getByText('Development sign-in')).toBeTruthy();
    });
    expect(screen.queryByRole('menuitem', { name: 'Sign out' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Sign out everywhere' })).toBeNull();
  });

  it('sends a signed-out user to sign-in, keeping where they were', async () => {
    routeFetch({ '/api/auth/me': { body: SIGNED_OUT } });
    const router = renderApp('/data');
    await waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'));
    expect(router.state.location.search).toBe('?next=%2Fdata');
  });
});

describe('rpc on 401', () => {
  it('goes to sign-in and still rejects the call', async () => {
    routeFetch({ '/api/rpc/projects%3Alist': { status: 401, body: { error: 'not signed in' } } });
    const go = vi.spyOn(nav, 'assign').mockImplementation(() => {});
    const err = await rpc('projects:list').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 401 });
    expect(go).toHaveBeenCalledWith('/sign-in');
  });

  it('does not redirect on other errors', async () => {
    routeFetch({ '/api/rpc/projects%3Alist': { status: 403, body: { error: 'forbidden' } } });
    const go = vi.spyOn(nav, 'assign').mockImplementation(() => {});
    await rpc('projects:list').catch(() => undefined);
    expect(go).not.toHaveBeenCalled();
  });
});
