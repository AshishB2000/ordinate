// The Get-started tour's visits (tourVisits.ts): which pages tick which stop,
// and that the shell's hook asks the server only for a stop the tour Home
// already read says is not ticked yet. Never a call of its own on a page load.

import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { pages } from '../../app/routes';
import { stepFor, useTourVisits } from './tourVisits';

afterEach(() => {
  vi.unstubAllGlobals();
});

const TOUR = { show: true, collapsed: false, steps: [{ id: 'explore', done: true }, { id: 'data', done: false }], doneCount: 1, total: 4 };

function visitAt(path: string, cached: unknown) {
  const asked: { channel: string; payload: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const channel = decodeURIComponent(url.replace('/api/rpc/', ''));
      asked.push({ channel, payload: (JSON.parse(String(init?.body ?? '{}')) as { args?: unknown[] }).args?.[0] });
      return Response.json({ ok: true });
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (cached) client.setQueryData(['onboarding:status'], cached);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  renderHook(() => useTourVisits(), { wrapper });
  return asked;
}

describe('the tour’s visits', () => {
  it('map each stop to its pages, and a dashboard itself to Dashboards', () => {
    expect(stepFor('/explore')).toBe('explore');
    expect(stepFor('/dashboards')).toBe('dashboards');
    expect(stepFor('/analyses/p/a')).toBe('dashboards');
    expect(stepFor('/reports')).toBe('reports');
    expect(stepFor('/data/import')).toBe('data');
    expect(stepFor('/')).toBeUndefined();
    expect(stepFor('/dataset-x')).toBeUndefined(); // a prefix, not a substring
  });

  it('point only at pages the app has', () => {
    const served = pages.flatMap((r) => (r.path ? [`/${r.path.replace(/^\//, '').split('/')[0]}`] : []));
    for (const p of ['/explore', '/dashboards', '/analyses', '/reports', '/data']) expect(served).toContain(p);
  });

  it('tick a stop not yet visited, once', async () => {
    const asked = visitAt('/data', TOUR);
    await waitFor(() => expect(asked).toEqual([{ channel: 'onboarding:visit', payload: { step: 'data' } }]));
  });

  it('ask nothing for a stop already ticked, a page that is no stop, or a tour Home has not read', async () => {
    const quiet = [visitAt('/explore', TOUR), visitAt('/visuals', TOUR), visitAt('/data', undefined), visitAt('/data', { ...TOUR, show: false })];
    // Negative control: the same hook on an unticked stop does ask (above); here nothing may.
    await new Promise((r) => setTimeout(r, 50));
    for (const asked of quiet) expect(asked).toEqual([]);
  });
});
