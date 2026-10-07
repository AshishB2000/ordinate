// Password sign-in (AUTH_MODE=password): the sign-in form, the first-run setup
// form, the change-password page and the shell's hold on a temporary password.
// The server is a fetch stub; every decision is the server's, these only check
// what the page sends and how it words the answer.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderApp } from '../../test-utils';
import { nav } from '../../api/client';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const SIGNED_OUT = { user: null, org: null, mode: 'password', canSignOut: true, accounts: true, setup: false };
const SETUP = { ...SIGNED_OUT, setup: true };
const ALICE = { user: { email: 'alice@acme.test', role: 'editor', mustChangePassword: false }, org: 'acme', mode: 'password', canSignOut: true, accounts: true, setup: false };
const TEMP = { ...ALICE, user: { ...ALICE.user, mustChangePassword: true } };

type Reply = { status?: number; body?: unknown };

/** fetch answered per path; records every call. Anything else is an empty list. */
function serve(routes: Record<string, Reply | Reply[]>) {
  const seen = new Map<string, number>();
  const spy = vi.fn(async (url: string, _init?: RequestInit) => {
    const path = url.split('?')[0];
    const r = routes[path];
    const n = seen.get(path) ?? 0;
    seen.set(path, n + 1);
    const out = Array.isArray(r) ? r[Math.min(n, r.length - 1)] : (r ?? { body: [] });
    return new Response(out.body === undefined ? null : JSON.stringify(out.body), { status: out.status ?? 200 });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

const bodyOf = (spy: ReturnType<typeof serve>, path: string) => {
  const call = spy.mock.calls.find(([url]) => url === path);
  return call ? (JSON.parse(String(call[1]?.body)) as Record<string, string>) : undefined;
};

const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('password sign-in', () => {
  it('shows an email and password form, never a single sign-on button', async () => {
    serve({ '/api/auth/me': { body: SIGNED_OUT } });
    renderApp('/sign-in');
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in to Ordinate' })).toBeTruthy();
    expect(screen.getByLabelText('Email')).toBeTruthy();
    expect(screen.getByLabelText('Password').getAttribute('autocomplete')).toBe('current-password');
    expect(screen.queryByRole('link', { name: /single sign-on/ })).toBeNull();
    expect(screen.getByText(/administrator can set a new one/)).toBeTruthy();
  });

  it('offers nothing to click until it knows how this server signs in', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    renderApp('/sign-in');
    expect(await screen.findByLabelText('Checking how this server signs you in')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /single sign-on/ })).toBeNull();
    expect(screen.queryByLabelText('Password')).toBeNull();
  });

  it('posts the email and password with the CSRF header, then goes to next', async () => {
    vi.spyOn(document, 'cookie', 'get').mockReturnValue(`ordinate_csrf=${'c'.repeat(43)}`);
    const spy = serve({ '/api/auth/me': { body: SIGNED_OUT }, '/api/auth/password/login': { body: { ok: true, mustChangePassword: false } } });
    const go = vi.spyOn(nav, 'assign').mockImplementation(() => {});
    renderApp('/sign-in?next=%2Fdata');
    await screen.findByLabelText('Email');
    type('Email', ' alice@acme.test ');
    type('Password', 'alice-own-password');
    fireEvent.click(screen.getByRole('button', { name: /Sign in/ }));
    await waitFor(() => expect(go).toHaveBeenCalledWith('/data'));
    expect(bodyOf(spy, '/api/auth/password/login')).toEqual({ email: 'alice@acme.test', password: 'alice-own-password' });
    const init = spy.mock.calls.find(([url]) => url === '/api/auth/password/login')?.[1];
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string> | undefined)?.['X-CSRF-Token']).toBe('c'.repeat(43));
  });

  it('a temporary password goes to the change-password page, keeping next', async () => {
    serve({ '/api/auth/me': { body: SIGNED_OUT }, '/api/auth/password/login': { body: { ok: true, mustChangePassword: true } } });
    const go = vi.spyOn(nav, 'assign').mockImplementation(() => {});
    renderApp('/sign-in?next=%2Fdata');
    await screen.findByLabelText('Email');
    type('Email', 'alice@acme.test');
    type('Password', 'alice-temporary-1');
    fireEvent.click(screen.getByRole('button', { name: /Sign in/ }));
    await waitFor(() => expect(go).toHaveBeenCalledWith('/change-password?next=%2Fdata'));
  });

  for (const [error, words, extra] of [
    ['invalid', "don't match an account", {}],
    ['disabled', 'has been disabled', {}],
    ['locked', 'Try again in 3 minutes', { retryAfter: 150 }],
    ['rate limited', 'from this network', {}], // the per-IP limit's 429 body, read the same way
  ] as const) {
    it(`words a refusal (${error}) and stays on the form`, async () => {
      serve({ '/api/auth/me': { body: SIGNED_OUT }, '/api/auth/password/login': { body: { ok: false, error, ...extra } } });
      const go = vi.spyOn(nav, 'assign').mockImplementation(() => {});
      renderApp('/sign-in');
      await screen.findByLabelText('Email');
      type('Email', 'alice@acme.test');
      type('Password', 'not-the-password');
      fireEvent.click(screen.getByRole('button', { name: /Sign in/ }));
      expect((await screen.findByRole('alert')).textContent).toContain(words);
      expect(go).not.toHaveBeenCalled();
    });
  }
});

describe('first-run setup', () => {
  it('asks for the setup code and creates the admin account', async () => {
    const spy = serve({ '/api/auth/me': { body: SETUP }, '/api/auth/password/setup': { body: { ok: true } } });
    const go = vi.spyOn(nav, 'assign').mockImplementation(() => {});
    renderApp('/sign-in');
    expect(await screen.findByRole('heading', { level: 1, name: 'Create the admin account' })).toBeTruthy();
    expect(screen.getByText(/docker compose logs ordinate/)).toBeTruthy();
    type('Setup code', 'k7qm-2xra-v9td');
    type('Your email', 'boss@acme.test');
    type('Password', 'boss-first-password');
    type('Confirm password', 'boss-first-password');
    fireEvent.click(screen.getByRole('button', { name: /Create admin account/ }));
    await waitFor(() => expect(go).toHaveBeenCalledWith('/'));
    expect(bodyOf(spy, '/api/auth/password/setup')).toEqual({ code: 'k7qm-2xra-v9td', email: 'boss@acme.test', password: 'boss-first-password' });
  });

  it('checks length and the confirmation before sending anything', async () => {
    const spy = serve({ '/api/auth/me': { body: SETUP } });
    renderApp('/sign-in');
    await screen.findByLabelText('Setup code');
    type('Setup code', 'K7QM-2XRA-V9TD');
    type('Your email', 'boss@acme.test');
    type('Password', 'short');
    type('Confirm password', 'different');
    fireEvent.click(screen.getByRole('button', { name: /Create admin account/ }));
    expect(await screen.findByText('Use at least 10 characters.')).toBeTruthy();
    expect(screen.getByText("The passwords don't match.")).toBeTruthy();
    expect(spy.mock.calls.some(([url]) => url === '/api/auth/password/setup')).toBe(false);
  });

  it('a wrong code says where to find the right one', async () => {
    serve({ '/api/auth/me': { body: SETUP }, '/api/auth/password/setup': { body: { ok: false, error: 'code' } } });
    renderApp('/sign-in');
    await screen.findByLabelText('Setup code');
    type('Setup code', 'AAAA-AAAA-AAAA');
    type('Your email', 'boss@acme.test');
    type('Password', 'boss-first-password');
    type('Confirm password', 'boss-first-password');
    fireEvent.click(screen.getByRole('button', { name: /Create admin account/ }));
    expect((await screen.findByRole('alert')).textContent).toContain("server's log");
  });

  it('when someone else finished setup first, it turns into the sign-in form', async () => {
    serve({ '/api/auth/me': [{ body: SETUP }, { body: SIGNED_OUT }], '/api/auth/password/setup': { body: { ok: false, error: 'closed' } } });
    renderApp('/sign-in');
    await screen.findByLabelText('Setup code');
    type('Setup code', 'K7QM-2XRA-V9TD');
    type('Your email', 'boss@acme.test');
    type('Password', 'boss-first-password');
    type('Confirm password', 'boss-first-password');
    fireEvent.click(screen.getByRole('button', { name: /Create admin account/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in to Ordinate' })).toBeTruthy();
  });
});

describe('change password', () => {
  it('a temporary password: the shell sends you to change it, keeping where you were going', async () => {
    serve({ '/api/auth/me': { body: TEMP } });
    const router = renderApp('/data');
    await waitFor(() => expect(router.state.location.pathname).toBe('/change-password'));
    expect(router.state.location.search).toBe('?next=%2Fdata');
    expect(await screen.findByRole('heading', { level: 1, name: 'Choose your own password' })).toBeTruthy();
    expect(screen.getByLabelText('Temporary password')).toBeTruthy();
  });

  it('changes it and goes on to next', async () => {
    const spy = serve({ '/api/auth/me': { body: TEMP }, '/api/auth/password/change': { body: { ok: true } } });
    const go = vi.spyOn(nav, 'assign').mockImplementation(() => {});
    renderApp('/change-password?next=%2Fdata');
    await screen.findByLabelText('Temporary password');
    type('Temporary password', 'alice-temporary-1');
    type('New password', 'alice-own-password');
    type('Confirm new password', 'alice-own-password');
    fireEvent.click(screen.getByRole('button', { name: /Change password/ }));
    await waitFor(() => expect(go).toHaveBeenCalledWith('/data'));
    expect(bodyOf(spy, '/api/auth/password/change')).toEqual({ current: 'alice-temporary-1', password: 'alice-own-password' });
  });

  it('words a wrong current password', async () => {
    serve({ '/api/auth/me': { body: ALICE }, '/api/auth/password/change': { body: { ok: false, error: 'current' } } });
    renderApp('/change-password');
    expect(await screen.findByRole('heading', { level: 1, name: 'Change your password' })).toBeTruthy();
    type('Current password', 'wrong-password');
    type('New password', 'alice-new-password');
    type('Confirm new password', 'alice-new-password');
    fireEvent.click(screen.getByRole('button', { name: /Change password/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('current password is not right');
  });

  it('is only for password sign-in', async () => {
    serve({ '/api/auth/me': { body: { ...ALICE, mode: 'oidc' } } });
    const router = renderApp('/change-password');
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });

  it('the account menu offers it under password sign-in', async () => {
    serve({ '/api/auth/me': { body: ALICE } });
    const router = renderApp('/');
    // Async, like auth.test.tsx's openMenu: a sync callback re-runs on every DOM mutation the key press itself causes.
    await waitFor(async () => {
      fireEvent.keyDown(await screen.findByRole('button', { name: 'Account and theme' }), { key: 'Enter' });
      expect(screen.getByRole('menuitem', { name: 'Change password' })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Change password' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/change-password'));
  });
});
