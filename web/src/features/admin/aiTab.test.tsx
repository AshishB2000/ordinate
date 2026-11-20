import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp } from '../../test-utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ADMIN = { user: { email: 'boss@acme.test', role: 'admin' }, org: 'acme', mode: 'oidc', canSignOut: true };
const off = (provider: string) => ({ provider, connected: false, saved: false, hasKey: false, baseUrl: '', verifiedAt: null });
const on = (provider: string) => ({ provider, connected: true, saved: true, hasKey: true, baseUrl: '', verifiedAt: new Date().toISOString() });
const SONNET = { provider: 'anthropic', model: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', isDefault: true };
const HAIKU = { provider: 'anthropic', model: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', isDefault: false };
const EMPTY = { keyStore: null, providers: ['anthropic', 'openai', 'gemini', 'gateway'].map(off), models: [] };
const SET_UP = { keyStore: null, providers: [on('anthropic'), off('openai'), off('gemini'), off('gateway')], models: [SONNET, HAIKU] };

type Reply = { status?: number; body?: unknown } | ((payload: unknown) => { status?: number; body?: unknown });
/** Channels the AI tab reads beside its own (deep research's limits card), answered quietly unless a test says otherwise. */
const ALSO: Record<string, Reply> = { 'research:limits': { body: { ok: true, limits: { steps: 8, queries: 12, minutes: 10 }, ceilings: { steps: 20, queries: 30, minutes: 30 } } } };

function serve(routes: Record<string, Reply>) {
  const calls: { channel: string; payload: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split('?')[0];
      const channel = path.startsWith('/api/rpc/') ? decodeURIComponent(path.slice('/api/rpc/'.length)) : path;
      const payload = init?.body ? (JSON.parse(String(init.body)) as { args: unknown[] }).args[0] : undefined;
      if (path.startsWith('/api/rpc/')) calls.push({ channel, payload });
      const r = routes[channel] ?? ALSO[channel] ?? { body: [] };
      const out = typeof r === 'function' ? r(payload) : r;
      return new Response(JSON.stringify(out.body ?? null), { status: out.status ?? 200 });
    }),
  );
  return calls;
}

const open = () => renderApp('/admin?tab=ai');

describe('Admin → AI', () => {
  it('loads with a skeleton, then every provider not connected and the models empty state', async () => {
    serve({ '/api/auth/me': { body: ADMIN }, 'ai:admin': { body: EMPTY } });
    open();
    expect(await screen.findByRole('status', { name: 'Loading AI providers' })).toBeTruthy();
    const list = await screen.findByRole('list', { name: 'Providers' });
    expect(within(list).getAllByText('Not connected')).toHaveLength(4);
    expect(screen.getByRole('heading', { name: 'No models yet' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Add models' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('with no key store, says what the operator sets and offers nothing to connect', async () => {
    serve({ '/api/auth/me': { body: ADMIN }, 'ai:admin': { body: { ...EMPTY, keyStore: 'This server has no database, so it cannot store API keys.' } } });
    open();
    expect(await screen.findByRole('heading', { name: 'This server can’t store API keys' })).toBeTruthy();
    expect(screen.getByText(/DATABASE_URL \(Postgres\) and ORDINATE_MASTER_KEY/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
  });

  it('a load failure is an error state with a retry', async () => {
    serve({ '/api/auth/me': { body: ADMIN }, 'ai:admin': { status: 500, body: { error: 'boom' } } });
    open();
    expect(await screen.findByRole('heading', { name: 'AI settings could not be loaded' })).toBeTruthy();
  });

  it('connects with a write-only key: a password field, never prefilled, cleared once sent; a failed test is shown inline', async () => {
    const calls = serve({
      '/api/auth/me': { body: ADMIN },
      'ai:admin': { body: EMPTY },
      'ai:connect': { body: { ok: false, errorType: 'auth', message: 'The API key was rejected.' } },
    });
    open();
    const list = await screen.findByRole('list', { name: 'Providers' });
    fireEvent.click(within(list).getAllByRole('button', { name: 'Connect' })[0]);
    const key = screen.getByLabelText('API key') as HTMLInputElement;
    expect(key.type).toBe('password');
    expect(key.value).toBe('');
    fireEvent.change(key, { target: { value: 'sk-test-123' } });
    fireEvent.click(within(screen.getByRole('form', { name: 'Connect Anthropic' })).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'ai:connect')?.payload).toEqual({ provider: 'anthropic', apiKey: 'sk-test-123' }));
    expect(key.value).toBe('');
    expect(screen.queryByDisplayValue('sk-test-123')).toBeNull();
    expect(await screen.findByText('The API key was rejected.')).toBeTruthy();
  });

  it('the gateway needs a base URL and a model id to test with', async () => {
    serve({ '/api/auth/me': { body: ADMIN }, 'ai:admin': { body: EMPTY } });
    open();
    const list = await screen.findByRole('list', { name: 'Providers' });
    fireEvent.click(within(list).getAllByRole('button', { name: 'Connect' })[3]);
    const form = screen.getByRole('form', { name: 'Connect OpenAI-compatible gateway' });
    const go = within(form).getByRole('button', { name: 'Connect' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText('Base URL'), { target: { value: 'https://gw.example.com/v1' } });
    fireEvent.change(within(form).getByLabelText('Model id to test with'), { target: { value: 'openai/gpt-4o-mini' } });
    expect(go.disabled).toBe(false);
  });

  it('a connected provider: tested time, Test again, Replace key; Disconnect names how many models members lose', async () => {
    const calls = serve({ '/api/auth/me': { body: ADMIN }, 'ai:admin': { body: SET_UP }, 'ai:disconnect': { body: { ok: true } } });
    open();
    expect(await screen.findByText('Connected · tested just now')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Test again' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Replace key' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('dialog', { name: 'Disconnect Anthropic?' });
    expect(within(dialog).getByText(/members lose 2 models/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'ai:disconnect')?.payload).toEqual({ provider: 'anthropic' }));
  });

  it('the models table: choosing a default and removing a model send the whole list', async () => {
    const calls = serve({ '/api/auth/me': { body: ADMIN }, 'ai:admin': { body: SET_UP }, 'ai:setModels': { body: { ok: true } } });
    open();
    fireEvent.click(await screen.findByRole('radio', { name: 'Make Claude Haiku 4.5 the default' }));
    const list = [
      { provider: 'anthropic', model: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { provider: 'anthropic', model: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
    ];
    await waitFor(() => expect(calls.find((c) => c.channel === 'ai:setModels')?.payload).toEqual({ models: list, defaultIndex: 1 }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Claude Sonnet 4.6' }));
    await waitFor(() => expect(calls.filter((c) => c.channel === 'ai:setModels')[1]?.payload).toEqual({ models: [list[1]], defaultIndex: 0 }));
  });

  it('Add models: the provider\'s live list, already-enabled ones ticked and fixed, plus an id typed in', async () => {
    const calls = serve({
      '/api/auth/me': { body: ADMIN },
      'ai:admin': { body: SET_UP },
      'ai:providerModels': { body: { ok: true, models: [{ id: 'claude-opus-4-1', label: 'Claude Opus 4.1' }, { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' }] } },
      'ai:setModels': { body: { ok: true } },
    });
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Add models' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add models' });
    const sonnet = (await within(dialog).findByLabelText('Claude Sonnet 4.6')) as HTMLInputElement;
    expect(sonnet.checked && sonnet.disabled).toBe(true);
    fireEvent.click(within(dialog).getByLabelText('Claude Opus 4.1'));
    fireEvent.change(within(dialog).getByLabelText('Enter a model id'), { target: { value: 'claude-custom-x' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add 2 models' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'ai:setModels')?.payload).toEqual({
      models: [
        { provider: 'anthropic', model: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
        { provider: 'anthropic', model: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
        { provider: 'anthropic', model: 'claude-opus-4-1', label: 'Claude Opus 4.1' },
        { provider: 'anthropic', model: 'claude-custom-x', label: 'claude-custom-x' },
      ],
      defaultIndex: 0,
    }));
  });
});

describe('Admin → AI → fingerprint model for meaning search', () => {
  const OPENAI_ON = { ...SET_UP, providers: [on('anthropic'), on('openai'), off('gemini'), on('gateway')], fingerprintModel: null };
  const SMALL = { provider: 'openai', model: 'text-embedding-3-small' };
  const card = async () => {
    const heading = await screen.findByRole('heading', { name: 'Fingerprint model for meaning search' });
    return heading.closest('div')!.parentElement as HTMLElement;
  };
  const choose = (name: string | RegExp) => {
    fireEvent.click(screen.getByRole('combobox', { name: 'Model' }));
    fireEvent.click(screen.getByRole('option', { name }));
  };

  it('with only Anthropic connected, says meaning search needs an OpenAI, Gemini or gateway key, and offers no picker', async () => {
    serve({ '/api/auth/me': { body: ADMIN }, 'ai:admin': { body: { ...SET_UP, fingerprintModel: null } } });
    open();
    expect(await screen.findByRole('heading', { name: 'Meaning search needs an OpenAI, Gemini or gateway key' })).toBeTruthy();
    expect(screen.getByText(/Anthropic has no fingerprint model/)).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Model' })).toBeNull();
  });

  it('is off by default: Off picked, Test and Save disabled; only connected providers\' models are offered', async () => {
    serve({ '/api/auth/me': { body: ADMIN }, 'ai:admin': { body: OPENAI_ON } });
    open();
    const c = await card();
    expect(within(c).queryByText(/^On ·/)).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Model' }).textContent).toContain('Off');
    expect((screen.getByRole('button', { name: 'Test' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('combobox', { name: 'Model' }));
    const names = screen.getAllByRole('option').map((o) => o.textContent);
    expect(names.some((n) => n?.includes('OpenAI · text-embedding-3-large'))).toBe(true);
    expect(names.some((n) => n?.includes('gemini'))).toBe(false); // Gemini is not connected
    expect(names.some((n) => n?.includes('enter a model id'))).toBe(true);
  });

  it('Test fingerprints the picked model and shows the server\'s size and latency; Save sends the pick', async () => {
    const calls = serve({
      '/api/auth/me': { body: ADMIN },
      'ai:admin': { body: OPENAI_ON },
      'ai:testFingerprint': { body: { ok: true, dimensions: 768, ms: 412 } },
      'ai:setFingerprintModel': { body: { ok: true } },
    });
    open();
    await card();
    choose('OpenAI · text-embedding-3-small');
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText('768 dimensions · 412 ms')).toBeTruthy();
    expect(calls.find((c) => c.channel === 'ai:testFingerprint')?.payload).toEqual({ pick: SMALL });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'ai:setFingerprintModel')?.payload).toEqual({ pick: SMALL }));
  });

  it('a failed test shows the provider\'s sentence; picking again clears it', async () => {
    serve({
      '/api/auth/me': { body: ADMIN },
      'ai:admin': { body: OPENAI_ON },
      'ai:testFingerprint': { body: { ok: false, errorType: 'auth', message: 'Your API key was rejected. Check it in Settings.', detail: 'OpenAI API · 401' } },
    });
    open();
    await card();
    choose('OpenAI · text-embedding-3-large');
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Your API key was rejected. Check it in Settings. OpenAI API · 401');
    choose('OpenAI · text-embedding-3-small');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a gateway needs its model id typed before Save; a refusal is shown inline', async () => {
    const calls = serve({
      '/api/auth/me': { body: ADMIN },
      'ai:admin': { body: OPENAI_ON },
      'ai:setFingerprintModel': { body: { ok: false, error: 'Connect gateway before adding its models.' } },
    });
    open();
    await card();
    choose('OpenAI-compatible gateway · enter a model id');
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Gateway model id'), { target: { value: 'acme/embed-768' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(calls.find((c) => c.channel === 'ai:setFingerprintModel')?.payload).toEqual({ pick: { provider: 'gateway', model: 'acme/embed-768' } }));
    expect((await screen.findByRole('alert')).textContent).toBe('Connect gateway before adding its models.');
  });

  const STATUS = 'ai:fingerprintStatus';
  it('says when the database has no pgvector, why meaning search stays on words, and links the upgrade note', async () => {
    serve({ '/api/auth/me': { body: ADMIN }, 'ai:admin': { body: OPENAI_ON }, [STATUS]: { body: { vectors: 'no_extension', items: null, fingerprinted: null } } });
    open();
    expect(await screen.findByText(/Meaning search needs the pgvector extension on your database\./)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'How to add pgvector' }) as HTMLAnchorElement;
    expect(link.href).toMatch(/docs\/server\/upgrade\.md#pgvector-for-meaning-search-0029_pgvector$/);
    expect(link.target).toBe('_blank');
  });

  it('with a model saved, shows how far the job has got', async () => {
    serve({ '/api/auth/me': { body: ADMIN }, 'ai:admin': { body: { ...OPENAI_ON, fingerprintModel: SMALL } }, [STATUS]: { body: { vectors: 'ready', items: 1300, fingerprinted: 1234 } } });
    open();
    expect(await screen.findByText(/^Fingerprinted 1,234 of 1,300 items\./)).toBeTruthy();
  });

  it('…and once every item is done, says so', async () => {
    serve({ '/api/auth/me': { body: ADMIN }, 'ai:admin': { body: { ...OPENAI_ON, fingerprintModel: SMALL } }, [STATUS]: { body: { vectors: 'ready', items: 1300, fingerprinted: 1300 } } });
    open();
    expect(await screen.findByText('All 1,300 items are fingerprinted.')).toBeTruthy();
  });

  it('with no model, a ready database adds no line; the status loads with a skeleton and fails with a retry', async () => {
    let fail = true;
    const calls = serve({ '/api/auth/me': { body: ADMIN }, 'ai:admin': { body: OPENAI_ON }, [STATUS]: () => (fail ? { status: 500, body: { error: 'boom' } } : { body: { vectors: 'ready', items: null, fingerprinted: null } }) });
    open();
    expect(await screen.findByRole('status', { name: 'Loading meaning search status' })).toBeTruthy();
    expect((await screen.findByRole('alert')).textContent).toContain('The meaning search status did not load.');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.queryByText(/fingerprinted/i)).toBeNull();
    expect(calls.filter((c) => c.channel === STATUS).length).toBeGreaterThanOrEqual(2);
  });

  it('a saved model shows On; choosing Off and saving sends null', async () => {
    const calls = serve({ '/api/auth/me': { body: ADMIN }, 'ai:admin': { body: { ...OPENAI_ON, fingerprintModel: SMALL } }, 'ai:setFingerprintModel': { body: { ok: true } } });
    open();
    expect(await screen.findByText('On · text-embedding-3-small')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    choose(/^Off/);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'ai:setFingerprintModel')?.payload).toEqual({ pick: null }));
  });
});
