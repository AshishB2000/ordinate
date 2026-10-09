import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ageWord, freshOptions, FreshOnAskPicker, type FreshTarget } from './FreshOnAsk';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const ON: FreshTarget = { id: '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b', name: 'Orders', originKind: 'connection', incrementalOn: true };

/** fetch answered per RPC channel; records each call's payload. */
function serve(reply: unknown = { ok: true }) {
  const calls: { channel: string; payload: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ channel: decodeURIComponent(url.split('?')[0].slice('/api/rpc/'.length)), payload: init?.body ? (JSON.parse(String(init.body)) as { args: unknown[] }).args[0] : undefined });
    return new Response(JSON.stringify(reply), { status: 200 });
  }));
  return calls;
}

function draw(d: FreshTarget) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <FreshOnAskPicker projectId={P} d={d} />
    </QueryClientProvider>,
  );
}

describe('Fresh on ask', () => {
  it('words the ages, and keeps a stored age the picker does not list', () => {
    expect([60, 300, 900, 3600, 7200, 90].map(ageWord)).toEqual(['1 min', '5 min', '15 min', '1 h', '2 h', '90 s']);
    expect(freshOptions(undefined).map((o) => o.label)).toEqual(['Fresh on ask off', 'Fresh on ask · 1 min', 'Fresh on ask · 5 min', 'Fresh on ask · 15 min', 'Fresh on ask · 1 h']);
    expect(freshOptions(7200).map((o) => o.value)).toEqual(['off', '60', '300', '900', '3600', '7200']);
  });

  it('with incremental refresh on: offered, and a pick sends the age (Off sends null)', async () => {
    const calls = serve();
    draw(ON);
    const picker = screen.getByRole('combobox', { name: 'Fresh on ask for Orders' });
    expect(picker.hasAttribute('disabled')).toBe(false);
    expect(picker.textContent).toContain('Fresh on ask off');
    fireEvent.click(picker);
    fireEvent.click(screen.getByRole('option', { name: 'Fresh on ask · 5 min' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'dataset:update')).toBeTruthy());
    expect(calls.find((c) => c.channel === 'dataset:update')?.payload).toEqual({ projectId: P, datasetId: ON.id, freshOnAsk: { maxStalenessSec: 300 } });
  });

  it('turning it off sends null', async () => {
    const calls = serve();
    draw({ ...ON, freshOnAsk: { maxStalenessSec: 900 } });
    const picker = screen.getByRole('combobox', { name: 'Fresh on ask for Orders' });
    expect(picker.textContent).toContain('Fresh on ask · 15 min');
    fireEvent.click(picker);
    fireEvent.click(screen.getByRole('option', { name: 'Fresh on ask off' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'dataset:update')?.payload).toEqual({ projectId: P, datasetId: ON.id, freshOnAsk: null }));
  });

  it('without incremental refresh: disabled, saying why in words', () => {
    serve();
    draw({ ...ON, incrementalOn: undefined });
    const picker = screen.getByRole('combobox', { name: 'Fresh on ask for Orders — needs incremental refresh' });
    expect(picker.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('needs incremental refresh')).toBeTruthy();
    expect(picker.closest('span[title]')?.getAttribute('title')).toMatch(/needs incremental refresh on this dataset/);
  });

  it('a next refresh that must be full: on, and says it waits for it', () => {
    serve();
    draw({ ...ON, freshOnAsk: { maxStalenessSec: 300, fullDue: true } });
    expect(screen.getByText('Waits for a full refresh')).toBeTruthy();
  });

  it('not shown for a Live dataset, nor for a source with no incremental refresh at all', () => {
    serve();
    const live = draw({ ...ON, mode: 'live' });
    expect(screen.queryByRole('combobox')).toBeNull();
    live.unmount();
    draw({ ...ON, originKind: 'url', incrementalOn: undefined });
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});
