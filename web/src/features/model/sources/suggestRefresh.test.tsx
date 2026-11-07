// A read from the warehouse and a link both change what catalog:suggestions answers, so both mark it stale.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { serveRpc } from '../../../test-utils';
import { useReadFacts } from './api';
import { useSetSourceTables } from './linksApi';
import { SUGGESTIONS } from './suggestApi';
import { doc, ORD, P, W, X } from './testServe';

afterEach(() => vi.unstubAllGlobals());

function cached() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData([SUGGESTIONS, P, '*'], { ok: true, suggestions: [], total: 0, datasets: 0 });
  client.setQueryData(['catalog:columns', P], []);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { client, wrapper, stale: (key: unknown[]) => client.getQueryState(key)?.isInvalidated };
}

describe('What changes the suggestions marks them stale', () => {
  it('a read from the warehouse', async () => {
    serveRpc({ 'sourceTable:read': { body: { ok: true, doc: doc() } } });
    const { wrapper, stale } = cached();
    const { result } = renderHook(() => useReadFacts(P, W, ORD), { wrapper });
    await act(() => result.current.mutateAsync());
    expect(stale([SUGGESTIONS, P, '*'])).toBe(true);
    expect(stale(['catalog:columns', P])).toBe(false); // NEGATIVE CONTROL: not every query
  });

  it('linking tables', async () => {
    serveRpc({ 'dataset:setSourceTables': { body: { ok: true, tables: ['public.orders'] } } });
    const { wrapper, stale } = cached();
    const { result } = renderHook(() => useSetSourceTables(P, X), { wrapper });
    await act(() => result.current.mutateAsync(['public.orders']));
    expect(stale([SUGGESTIONS, P, '*'])).toBe(true);
    expect(stale(['catalog:columns', P])).toBe(false);
  });
});
