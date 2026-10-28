// What the dock is about, per route: the pure URL reading (dockRoute.ts)
// walked over EVERY route the app has, then the two hooks (dockState.ts) over
// a router and a query cache. The real pages — that each one's own query is
// where the name comes from, at no extra call — are dockScreens.test.tsx.

import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider, type QueryKey } from '@tanstack/react-query';
import { pages } from '../../app/routes';
import { routeProject, routeScreen } from './dockRoute';
import { useDockContext, useDockProject } from './dockState';
import { starterPrompts } from './prompts';

afterEach(() => {
  vi.unstubAllGlobals();
});

const P = '11111111-1111-4111-8111-111111111111';
const X = '22222222-2222-4222-8222-222222222222';
/** The project the dock falls back to when the URL names none: the caller's most recent. */
const RECENT = '99999999-9999-4999-8999-999999999999';

/** The route patterns the app serves, with every `:param` filled by an id — the project's by P, any other by X. */
const routes = pages.flatMap((r) => (r.path ? [r.path] : []));
const fill = (pattern: string): string => pattern.replace(/:(\w+)/g, (_, name: string) => (name === 'projectId' ? P : X));

/** The screens that are about one thing, by the route pattern app/routes.tsx declares. Every other route is the whole project. */
const KIND: Record<string, string> = {
  '/data/:projectId/:datasetId': 'dataset',
  '/data/:projectId/:datasetId/prepare': 'dataset',
  '/data/input/:projectId/:datasetId': 'dataset',
  '/analytics/:projectId/:datasetId/stats': 'dataset',
  '/analytics/:projectId/:datasetId/drivers': 'dataset',
  '/analytics/:projectId/:datasetId/segments': 'dataset',
  '/visuals/:projectId/:visualId': 'visual',
  '/analyses/:projectId/:analysisId': 'analysis',
  '/dashboards/:projectId/:analysisId': 'analysis',
  '/scorecards/:projectId/:scorecardId': 'scorecard',
  '/analytics/scenarios/:projectId/:scenarioId': 'scenario',
  '/data/captures/:projectId/:captureId': 'capture',
};

describe('the URL, read for the dock', () => {
  it('names the project on every route that carries one, and on no other', () => {
    expect(routes.length).toBeGreaterThan(40); // the walk is over the real list
    for (const pattern of routes) {
      expect([pattern, routeProject(fill(pattern))]).toEqual([pattern, pattern.includes(':projectId') ? P : null]);
    }
    // Negative control: a route this module was never told about names no project, so the walk above would catch one.
    expect(routeProject(`/widgets/${P}/${X}`)).toBeNull();
  });

  it('names the one thing a screen shows on exactly the routes that show one', () => {
    for (const pattern of Object.keys(KIND)) expect(routes).toContain(pattern); // the table is about routes that exist
    for (const pattern of routes) {
      const at = routeScreen(fill(pattern));
      expect([pattern, at?.kind ?? '', at?.id ?? '', at?.projectId ?? '']).toEqual(KIND[pattern] ? [pattern, KIND[pattern], X, P] : [pattern, '', '', '']);
    }
  });

  it('takes nothing that is not an id for one', () => {
    // A literal where the project goes is not a project called that…
    for (const path of ['/data/import', '/data/captures', '/data/metrics', '/data/input', `/data/input/nope/${X}`, `/visuals/nope/${X}`, `/analyses/123/${X}`, '/analytics/scenarios', '/visuals', '/']) {
      expect([path, routeProject(path), routeScreen(path)]).toEqual([path, null, null]);
    }
    // …and a literal or a typo where the thing goes is not a thing: the project still stands.
    for (const path of [`/visuals/${P}/new`, `/analytics/scenarios/${P}/compare`, `/visuals/${P}/not-an-id`, `/analyses/${P}/123`, `/scorecards/${P}/${X}0`, `/analytics/scenarios/${P}/x`, `/data/${P}/columns`, `/analytics/${P}/sql`]) {
      expect([path, routeProject(path), routeScreen(path)]).toEqual([path, P, null]);
    }
    // A capture's id is its history thread's, not a UUID (src/api/captures.ts).
    expect(routeScreen(`/data/captures/${P}/cap_2026-10-13`)).toEqual({ projectId: P, kind: 'capture', id: 'cap_2026-10-13' });
    expect(routeScreen(`/data/captures/${P}/no%20spaces`)).toBeNull();
  });
});

/** Both hooks at `path`, as Dock.tsx composes them, over a cache holding `seed` and a server answering `served` by channel. */
function dockAt(path: string, seed: [QueryKey, unknown][] = [], served: Record<string, unknown> = {}) {
  const asked: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const channel = decodeURIComponent(url.split('?')[0].replace('/api/rpc/', ''));
      asked.push(channel);
      const projects = [{ id: RECENT, name: 'Recent', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }];
      return new Response(JSON.stringify(channel in served ? served[channel] : channel === 'projects:list' ? projects : null));
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const [key, data] of seed) client.setQueryData(key, data);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  const hook = renderHook(
    () => {
      const project = useDockProject(true);
      return { project, context: useDockContext(project.id) };
    },
    { wrapper },
  );
  return { ...hook, client, asked };
}

describe('the dock’s project and context', () => {
  it('follow the route on every screen that shows one thing', async () => {
    for (const [pattern, kind] of Object.entries(KIND)) {
      const { result, unmount } = dockAt(fill(pattern));
      expect([pattern, result.current.project.id, result.current.project.fromRoute]).toEqual([pattern, P, true]);
      // Named by its kind until its page has loaded it.
      expect([pattern, result.current.context]).toEqual([pattern, { kind, id: X, label: `${kind} · open ${kind}`, name: '' }]);
      unmount();
    }
  });

  it('name the thing from the cache entry its own page reads, and ask the server for nothing', async () => {
    const named: [string, QueryKey, unknown, string][] = [
      ['/visuals/:projectId/:visualId', ['visual:get', P, X], { id: X, name: 'Revenue by region' }, 'visual · Revenue by region'],
      ['/analyses/:projectId/:analysisId', ['analysis:open', P, X], { ok: true, analysis: { id: X, name: 'Q3 review' }, visuals: [] }, 'analysis · Q3 review'],
      ['/scorecards/:projectId/:scorecardId', ['scorecard:get', P, X], { id: X, name: 'Company goals' }, 'scorecard · Company goals'],
      ['/analytics/scenarios/:projectId/:scenarioId', ['scenario:get', P, X], { id: X, name: 'Price rise' }, 'scenario · Price rise'],
      // A dataset's workbenches: the project's list, which the dock itself holds.
      ['/data/:projectId/:datasetId/prepare', ['dataset:list', P], [{ id: RECENT, name: 'Other' }, { id: X, name: 'Orders' }], 'dataset · Orders'],
      ['/analytics/:projectId/:datasetId/stats', ['dataset:list', P], [{ id: X, name: 'Orders' }], 'dataset · Orders'],
      ['/data/input/:projectId/:datasetId', ['dataset:list', P], [{ id: X, name: 'Budget' }], 'dataset · Budget'],
    ];
    for (const [pattern, key, data, label] of named) {
      // Already cached: named on the first render.
      const warm = dockAt(fill(pattern), [[key, data]]);
      expect([pattern, warm.result.current.context.label]).toEqual([pattern, label]);
      warm.unmount();
      // Arriving later (the page's own fetch landing): the dock follows it.
      const cold = dockAt(fill(pattern));
      expect(cold.result.current.context.name).toBe('');
      cold.client.setQueryData(key, data);
      await waitFor(() => expect([pattern, cold.result.current.context.label]).toEqual([pattern, label]));
      // Nothing was asked for but the caller's projects: no observer of the dock's sits on the page's query.
      await waitFor(() => expect(cold.result.current.project.projects.length).toBe(1));
      expect([pattern, cold.asked]).toEqual([pattern, ['projects:list']]);
      expect(cold.client.getQueryCache().find({ queryKey: key })?.getObserversCount()).toBe(0);
      cold.unmount();
    }
    // Negative controls: a reply that carries no name names nothing. Where the page's own read says the thing is NOT
    // THERE (a refusal, a missing record), the dock is about the whole project — which is what the server will answer from.
    for (const [pattern, key, data, kind] of [
      ['/analyses/:projectId/:analysisId', ['analysis:open', P, X], { ok: false }, ''],
      ['/visuals/:projectId/:visualId', ['visual:get', P, X], null, ''],
      ['/scorecards/:projectId/:scorecardId', ['scorecard:get', P, X], null, ''],
      ['/analytics/scenarios/:projectId/:scenarioId', ['scenario:get', P, X], null, ''],
      ['/data/:projectId/:datasetId/prepare', ['dataset:list', P], [{ id: RECENT, name: 'Other' }], 'dataset'],
      ['/scorecards/:projectId/:scorecardId', ['scorecard:get', P, X], { id: X, name: 42 }, 'scorecard'],
    ] as [string, QueryKey, unknown, string][]) {
      const { result, unmount } = dockAt(fill(pattern), [[key, data]]);
      expect([pattern, result.current.context.name, result.current.context.kind, result.current.project.id]).toEqual([pattern, '', kind, P]);
      unmount();
    }
  });

  it('carry the period a scorecard’s URL shows, and nothing a URL should not decide', () => {
    const at = (search: string, pattern = '/scorecards/:projectId/:scorecardId') => {
      const { result, unmount } = dockAt(fill(pattern) + search);
      const { offset } = result.current.context;
      unmount();
      return offset;
    };
    expect([at('?back=1'), at('?back=12'), at('?edit=1&back=600')]).toEqual([1, 12, 600]);
    // Negative controls: the current period, a count the server would refuse, a word — and another kind of screen.
    for (const search of ['', '?back=0', '?back=-1', '?back=601', '?back=1.5', '?back=soon', '?back=']) expect([search, at(search)]).toEqual([search, undefined]);
    expect(at('?back=2', '/visuals/:projectId/:visualId')).toBeUndefined();
  });

  it('keep the observer a dataset’s own page and a capture’s always had on the page’s query', async () => {
    const dataset = dockAt(`/data/${P}/${X}`, [], { 'dataset:columns': { id: X, name: 'Orders', rowCount: 3, columns: [] } });
    await waitFor(() => expect(dataset.result.current.context).toEqual({ kind: 'dataset', id: X, label: 'dataset · Orders', name: 'Orders' }));
    expect(dataset.asked.filter((c) => c !== 'projects:list')).toEqual(['dataset:columns']);
    dataset.unmount();
    const capture = dockAt(`/data/captures/${P}/${X}`, [], { 'captureDataset:get': { ok: true, id: X, title: 'Regional sales' } });
    await waitFor(() => expect(capture.result.current.context).toEqual({ kind: 'capture', id: X, label: 'capture · Regional sales', name: 'Regional sales' }));
    expect(capture.asked.filter((c) => c !== 'projects:list')).toEqual(['captureDataset:get']);
    capture.unmount();
    // Negative control: a workbench of that dataset is not its own page — no observer, so no call.
    const stats = dockAt(`/analytics/${P}/${X}/stats`, [], { 'dataset:columns': { id: X, name: 'Orders', rowCount: 3, columns: [] } });
    await waitFor(() => expect(stats.result.current.project.projects.length).toBe(1));
    expect([stats.asked, stats.result.current.context.name]).toEqual([['projects:list'], '']);
    stats.unmount();
  });

  it('are the whole of a project the route names, where the screen is a list, a draft or a tool', async () => {
    for (const path of [`/visuals/${P}/new`, `/analytics/scenarios/${P}/compare`, `/visuals/${P}`, `/data/${P}`, `/reports/${P}/${X}`, `/connections/${P}/${X}`, `/visuals/${P}/not-an-id`]) {
      const { result, unmount } = dockAt(path);
      expect([path, result.current.project.id, result.current.project.fromRoute, result.current.context]).toEqual([path, P, true, { kind: '', label: 'whole project', name: '' }]);
      unmount();
    }
  });

  it('never take a word in the URL for a project: the most recent one stands, whole', async () => {
    for (const path of ['/', '/data/import', '/data/captures', '/data/metrics', `/data/input/nope/${X}`, `/visuals/nope/${X}`]) {
      const { result, unmount } = dockAt(path);
      expect([path, result.current.project.id, result.current.project.fromRoute]).toEqual([path, null, false]); // nothing until the list is in
      await waitFor(() => expect([path, result.current.project.id]).toEqual([path, RECENT]));
      expect([path, result.current.project.fromRoute, result.current.context.kind]).toEqual([path, false, '']);
      unmount();
    }
  });

  it('are the whole project when the thing on screen belongs to another one', () => {
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/visuals/${P}/${X}`]}>{children}</MemoryRouter>
      </QueryClientProvider>
    );
    expect(renderHook(() => useDockContext(P), { wrapper }).result.current.kind).toBe('visual');
    expect(renderHook(() => useDockContext(RECENT), { wrapper }).result.current.kind).toBe('');
    expect(renderHook(() => useDockContext(null), { wrapper }).result.current.kind).toBe('');
  });
});

describe('starter prompts for the thing on screen', () => {
  it('ask about it by name, three at most, and fall back to the project’s when it has no name yet', () => {
    const datasets = ['Sales', 'Costs'];
    for (const kind of ['visual', 'analysis', 'scorecard', 'scenario']) {
      const prompts = starterPrompts(datasets, 'Board pack', kind);
      expect([kind, prompts.length, prompts.every((p) => p.includes('Board pack'))]).toEqual([kind, 3, true]);
      expect([kind, new Set(prompts).size]).toEqual([kind, 3]);
      // A project with no dataset list yet still gets them: they are about the thing, not a dataset.
      expect(starterPrompts([], 'Board pack', kind)).toEqual(prompts);
      // No name yet: exactly what the whole project gets.
      expect(starterPrompts(datasets, '', kind)).toEqual(starterPrompts(datasets));
    }
    expect(starterPrompts(datasets, 'Company goals', 'scorecard')[0]).toBe('What is off track in Company goals?');
    // A chip is one line of the dock: about 44 characters at its default 340px (measured), cut with an ellipsis. So the
    // words around the name stay within 30, and a name of a dozen letters is still on screen, whole.
    for (const kind of ['visual', 'analysis', 'scorecard', 'scenario']) {
      for (const p of starterPrompts(datasets, '§', kind)) expect([p, p.replace('§', '').length <= 30]).toEqual([p, true]);
    }
    // Negative controls: a dataset, a capture and the whole project keep the dataset questions.
    for (const kind of ['dataset', 'capture', '']) expect(starterPrompts(datasets, 'Costs', kind)).toEqual(starterPrompts(datasets, 'Costs'));
    expect(starterPrompts(datasets, 'Costs', 'dataset')).toEqual(['What stands out in Costs?', 'How do Costs and Sales compare?', 'Summarise Costs in plain terms']);
  });
});
