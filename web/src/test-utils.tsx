import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import { appRoutes } from './app/routes';

/** The whole app at `path`, with a fresh query cache and no retries. */
export function renderApp(path = '/', children?: RouteObject[]) {
  const router = createMemoryRouter(appRoutes(children), { initialEntries: [path] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

/** Stub fetch with one canned response; returns the spy. */
export function stubFetch(status: number, body: unknown) {
  const spy = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

export type RpcReply = { status?: number; body?: unknown } | ((payload: unknown) => { status?: number; body?: unknown });

/**
 * Stub fetch with canned replies by RPC channel (or by path, e.g. `/api/auth/me`); an unlisted
 * channel answers `[]`. Returns every RPC call made, in order — what a viewer test asserts on.
 */
export function serveRpc(routes: Record<string, RpcReply>) {
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
