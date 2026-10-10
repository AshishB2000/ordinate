import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp } from '../../test-utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PID = '11111111-1111-4111-8111-111111111111';
const DS = '22222222-2222-4222-8222-222222222222';
const ADMIN_DEV = { user: { email: 'dev@local', role: 'admin' }, org: 'default', mode: 'dev', canSignOut: false, accounts: false };
const VIEWER = { user: { email: 'pat@acme.test', role: 'viewer' }, org: 'acme', mode: 'oidc', canSignOut: true, accounts: true };
const FORMATS = { locale: 'en-US', numberStyle: 'locale', currency: 'USD', currencyPosition: 'before', dateFormat: 'medium', weekStart: 1, fiscalYearStart: 1, calendarType: 'gregorian', yearEnd: 'nearest', compact: true };
const BRANDING = { accent: '', logo: '', dashboardStyle: 'auto' };
const PROJECT = { id: PID, name: 'Retail', updatedAt: '2026-10-01T00:00:00Z', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false };

type Reply = { status?: number; body?: unknown } | ((payload: unknown) => { status?: number; body?: unknown });

/** fetch answered per path or RPC channel; records each RPC's payload. */
function serve(routes: Record<string, Reply>) {
  const calls: { channel: string; payload: unknown }[] = [];
  const base: Record<string, Reply> = {
    'projects:overview': { body: [PROJECT] },
    'projects:roles': { body: { [PID]: 'admin' } },
    'prefs:get': { body: { formats: FORMATS, branding: BRANDING } },
    ...routes,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split('?')[0];
      const channel = path.startsWith('/api/rpc/') ? decodeURIComponent(path.slice('/api/rpc/'.length)) : path;
      const payload = init?.body && typeof init.body === 'string' ? (JSON.parse(init.body) as { args: unknown[] }).args[0] : undefined;
      if (path.startsWith('/api/rpc/')) calls.push({ channel, payload });
      const r = base[channel] ?? { body: [] };
      const out = typeof r === 'function' ? r(payload) : r;
      return new Response(JSON.stringify(out.body ?? null), { status: out.status ?? 200 });
    }),
  );
  return calls;
}

const sent = (calls: { channel: string; payload: unknown }[], channel: string) => calls.filter((c) => c.channel === channel).map((c) => c.payload);

describe('command palette', () => {
  it('opens on Ctrl+K, finds a command by a few letters, runs it on Enter, and closes on Ctrl+K', async () => {
    serve({ '/api/auth/me': { body: ADMIN_DEV } });
    const router = renderApp('/');
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    const input = await screen.findByRole('combobox', { name: 'Search commands and records' });
    // Empty query: the commands by group, the admin-only ones included for an admin.
    expect(screen.getByRole('option', { name: /Organization settings/ })).toBeTruthy();
    fireEvent.change(input, { target: { value: '>gt sett' } });
    const first = screen.getAllByRole('option')[0];
    expect(first.textContent).toMatch(/Go to Settings/);
    expect(first.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings'));
    expect(screen.queryByRole('combobox', { name: 'Search commands and records' })).toBeNull();
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    await screen.findByRole('combobox', { name: 'Search commands and records' });
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    await waitFor(() => expect(screen.queryByRole('combobox', { name: 'Search commands and records' })).toBeNull());
  });

  it('the top bar\'s Search box is the palette\'s door for a pointer', async () => {
    serve({ '/api/auth/me': { body: ADMIN_DEV } });
    renderApp('/');
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    fireEvent.click(within(screen.getByRole('search')).getByRole('searchbox', { name: 'Search' }));
    expect(await screen.findByRole('combobox', { name: 'Search commands and records' })).toBeTruthy();
  });

  it('searches record names in the current project and opens a dataset on its route', async () => {
    const calls = serve({
      '/api/auth/me': { body: ADMIN_DEV },
      'search:query': { body: { ok: true, results: [{ kind: 'dataset', id: DS, name: 'Customers', sub: '20 rows', type: 'Dataset', projectId: PID, projectName: 'Retail', snippet: '' }] } },
    });
    const router = renderApp('/');
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    fireEvent.change(await screen.findByRole('combobox', { name: 'Search commands and records' }), { target: { value: '/cust' } });
    const hit = await screen.findByRole('option', { name: /Customers/ });
    expect(sent(calls, 'search:query')).toEqual([{ projectId: PID, query: 'cust' }]);
    expect(within(screen.getByRole('group', { name: 'In Retail' })).getAllByRole('option')).toHaveLength(1);
    fireEvent.click(hit);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/data/${PID}/${DS}`));
  });

  it('? opens the shortcuts sheet from the same registry — not while typing in a field', async () => {
    serve({ '/api/auth/me': { body: ADMIN_DEV } });
    renderApp('/settings');
    await screen.findByRole('heading', { level: 1, name: 'Settings' });
    const field = document.createElement('input');
    document.body.append(field);
    fireEvent.keyDown(field, { key: '?', shiftKey: true });
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull();
    field.remove();
    fireEvent.keyDown(document.body, { key: '?', shiftKey: true });
    const sheet = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(sheet).getByText('Command palette')).toBeTruthy();
    expect(within(sheet).getByLabelText('Ctrl+K')).toBeTruthy();
  });
});

describe('My settings', () => {
  it('shows who is signed in and sets the theme the account menu shows too (one preference)', async () => {
    serve({ '/api/auth/me': { body: VIEWER } });
    renderApp('/settings');
    expect((await screen.findByTestId('settings-email')).textContent).toBe('pat@acme.test');
    expect(screen.queryByRole('link', { name: /Organization settings/ })).toBeNull(); // not an admin
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(document.documentElement.dataset.theme).toBe('dark');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Account and theme' }), { key: 'Enter' });
    expect(screen.getByRole('menuitemradio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('true');
  });

  it('Privacy: a viewer reads the policy but cannot change it; an admin changes one path', async () => {
    const overview = {
      ok: true,
      projectName: 'Retail',
      policy: { export: 'mask', report: 'mask', publish: 'mask', bundle: 'mask' },
      datasets: [{ id: DS, name: 'Customers', sensitive: [], pending: [{ column: 'email', kind: 'email', level: 'personal', reason: '20 of 20 values are email addresses' }] }],
      datasetCount: 1,
    };
    serve({ '/api/auth/me': { body: VIEWER }, 'projects:roles': { body: { [PID]: 'viewer' } }, 'privacy:overview': { body: overview } });
    renderApp('/settings?tab=privacy');
    const exportsSeg = await screen.findByRole('radiogroup', { name: 'Exports' });
    expect(within(exportsSeg).getByRole('radio', { name: 'Drop' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Mark as personal' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/Looks like email addresses/)).toBeTruthy();
  });

  it('Privacy: the project admin sets Drop on exports and marks a proposal', async () => {
    const overview = {
      ok: true,
      projectName: 'Retail',
      policy: { export: 'mask', report: 'mask', publish: 'mask', bundle: 'mask' },
      datasets: [{ id: DS, name: 'Customers', sensitive: [], pending: [{ column: 'email', kind: 'email', level: 'personal', reason: 'r' }] }],
      datasetCount: 1,
    };
    const calls = serve({ '/api/auth/me': { body: ADMIN_DEV }, 'privacy:overview': { body: overview }, 'privacy:setPolicy': { body: { ok: true } }, 'privacy:decide': { body: { ok: true } } });
    renderApp('/settings?tab=privacy');
    const exportsSeg = await screen.findByRole('radiogroup', { name: 'Exports' });
    await waitFor(() => expect(within(exportsSeg).getByRole('radio', { name: 'Drop' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(within(exportsSeg).getByRole('radio', { name: 'Drop' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark as personal' }));
    await waitFor(() => expect(sent(calls, 'privacy:decide')).toEqual([{ projectId: PID, datasetId: DS, column: 'email', level: 'personal' }]));
    expect(sent(calls, 'privacy:setPolicy')).toEqual([{ projectId: PID, policy: { export: 'drop' } }]);
  });
});

describe('Organization settings (Admin)', () => {
  it('without accounts, an admin still gets the organization tabs — and no admin:* channel is called', async () => {
    const calls = serve({ '/api/auth/me': { body: ADMIN_DEV }, 'key:status': { body: { globalRules: '', autoRefresh: true, notifications: { alerts: true } } } });
    renderApp('/admin');
    expect(await screen.findByRole('heading', { name: 'This server keeps no accounts' })).toBeTruthy();
    // Live usage (live data L2.7) is an org tab: it counts this server's warehouse queries without Postgres too.
    // AI (docs/ai-models) is one as well: without Postgres it says what the operator sets.
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Workspace', 'AI', 'Themes', 'Backups', 'Live usage']);
    await screen.findByTestId('fmt-money');
    expect(calls.filter((c) => c.channel.startsWith('admin:'))).toEqual([]);
  });

  it('Workspace: a currency change goes to the server, and the preview shows what it answered', async () => {
    const eur = { ...FORMATS, currency: 'EUR' };
    const calls = serve({
      '/api/auth/me': { body: ADMIN_DEV },
      'key:status': { body: { globalRules: '', autoRefresh: true, notifications: { alerts: true } } },
      'formats:set': { body: { ok: true, formats: eur, branding: BRANDING } },
      'calendar:today': { body: { ok: true, today: '2026-10-04', from: '2026-01-01', to: '2026-12-31', label: '', weeks: null } },
    });
    renderApp('/admin?tab=workspace');
    expect((await screen.findByTestId('fmt-money')).textContent).toBe('$5.2M');
    // The calendar preview is the server's answer, only formatted here.
    expect((await screen.findByTestId('cal-fiscal-year')).textContent).toMatch(/2026/);
    expect(screen.queryByTestId('cal-today-is')).toBeNull();
    expect(calls.some((c) => c.channel === 'calendar:today')).toBe(true);
    fireEvent.click(screen.getByRole('combobox', { name: 'Currency' }));
    fireEvent.click(await screen.findByRole('option', { name: /^EUR/ }));
    await waitFor(() => expect(screen.getByTestId('fmt-money').textContent).toBe('€5.2M'));
    expect(sent(calls, 'formats:set')).toEqual([{ currency: 'EUR' }]);
  });

  it('Themes: the empty state, then Duplicate on a built-in saves a copy under a free name', async () => {
    const calls = serve({
      '/api/auth/me': { body: ADMIN_DEV },
      'themes:list': { body: { defaultId: '', themes: [] } },
      'themes:save': { body: { ok: true, theme: { id: '33333333-3333-4333-8333-333333333333', name: 'Copy of Light', tokens: {}, updatedAt: '' } } },
    });
    renderApp('/admin?tab=themes');
    expect(await screen.findByText('No themes of your own yet')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Workspace theme' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate Light' }));
    await waitFor(() => expect(sent(calls, 'themes:save')).toHaveLength(1));
    const saved = sent(calls, 'themes:save')[0] as { name: string; tokens: Record<string, unknown> };
    expect(saved.name).toBe('Copy of Light');
    expect(saved.tokens['--bg']).toBe('#f7f7f8');
  });

  it('Themes: the editor warns about contrast as you pick, and Save sends the draft', async () => {
    const theme = { id: '33333333-3333-4333-8333-333333333333', name: 'Board', tokens: { '--bg': '#ffffff', '--surface': '#ffffff', '--text': '#18181b', '--accent': '#2563eb', '--chart-1': '#2563eb' }, updatedAt: '' };
    const calls = serve({ '/api/auth/me': { body: ADMIN_DEV }, 'themes:list': { body: { defaultId: theme.id, themes: [theme] } }, 'themes:save': { body: { ok: true, theme } } });
    renderApp('/admin?tab=themes');
    expect(await screen.findByText('Workspace default')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const series1 = await screen.findByLabelText('Series 1 as hex');
    fireEvent.change(series1, { target: { value: '#eeeeee' } });
    fireEvent.keyDown(series1, { key: 'Enter' });
    expect(await screen.findByText(/One colour is under its contrast floor/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save theme' }));
    await waitFor(() => expect(sent(calls, 'themes:save')).toHaveLength(1));
    const draft = sent(calls, 'themes:save')[0] as { id: string; tokens: Record<string, unknown> };
    expect(draft.id).toBe(theme.id);
    expect(draft.tokens['--chart-1']).toBe('#eeeeee');
  });

  it('Backups: restore takes a file AND the typed word, then lists what came back as new projects', async () => {
    const calls = serve({
      '/api/auth/me': { body: ADMIN_DEV },
      '/api/files': { body: { fileToken: 'a'.repeat(43), name: 'b.zip', size: 4 } },
      'backups:restore': { body: { ok: true, restored: [{ id: PID, name: 'Retail (restored Oct 4, 2026)' }], failed: [] } },
    });
    renderApp('/admin?tab=backups');
    fireEvent.click(await screen.findByRole('button', { name: 'Restore from a backup…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Restore from a backup' });
    const go = within(dialog).getByRole('button', { name: 'Restore as new projects' });
    expect(go.hasAttribute('disabled')).toBe(true);
    const file = new File(['zip!'], 'b.zip', { type: 'application/zip' });
    fireEvent.change(within(dialog).getByLabelText('Backup file'), { target: { files: [file] } });
    expect(go.hasAttribute('disabled')).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Type “restore” to confirm'), { target: { value: 'restor' } });
    expect(go.hasAttribute('disabled')).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Type “restore” to confirm'), { target: { value: 'restore' } });
    expect(go.hasAttribute('disabled')).toBe(false);
    await act(async () => fireEvent.click(go));
    expect(await within(dialog).findByText('Retail (restored Oct 4, 2026)')).toBeTruthy();
    expect(sent(calls, 'backups:restore')).toEqual([{ fileToken: 'a'.repeat(43), confirm: 'restore' }]);
  });
});

describe('About', () => {
  it('shows the version and the bundled licences, filterable, each with its text', async () => {
    serve({
      '/api/auth/me': { body: ADMIN_DEV },
      '/licenses.json': {
        body: {
          app: { name: 'Ordinate', version: '0.1.0' },
          generatedAt: '2026-10-04T00:00:00Z',
          packages: [
            { name: 'react', version: '19.3.0', license: 'MIT', url: 'https://github.com/facebook/react', text: 'MIT License\n\nCopyright (c) Meta' },
            { name: 'pg', version: '8.16.0', license: 'MIT', text: 'MIT' },
            { name: 'png-js', version: '1.1.0', license: 'UNKNOWN' },
          ],
        },
      },
    });
    renderApp('/about');
    await waitFor(() => expect(screen.getByTestId('about-version').textContent).toBe('Version 0.1.0'));
    expect(screen.getByTestId('licence-count').textContent).toBe('3 packages');
    expect(screen.getByText('Licence not stated')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Filter packages'), { target: { value: 'reac' } });
    expect(screen.getByTestId('licence-count').textContent).toBe('1 of 3 packages');
    expect(screen.getByText(/Copyright \(c\) Meta/)).toBeTruthy();
  });
});
