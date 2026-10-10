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

function serve(routes: Record<string, Reply>) {
  const calls: { channel: string; payload: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split('?')[0];
      const channel = path.startsWith('/api/rpc/') ? decodeURIComponent(path.slice('/api/rpc/'.length)) : path;
      const payload = init?.body ? (JSON.parse(String(init.body)) as { args: unknown[] }).args[0] : undefined;
      if (path.startsWith('/api/rpc/')) calls.push({ channel, payload });
      const r = routes[channel] ?? { body: [] };
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
