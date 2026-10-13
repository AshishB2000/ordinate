// The dock on the REAL pages: a saved visual, an analysis, a scorecard and a
// scenario each open through the app's router, with the Assistant beside them.
// What this pins that dockRoute.test.tsx cannot: the name in the dock's header
// comes from the query the page itself makes (the cache keys in dockState.ts
// `nameIn` are a second spelling of each page's own), the dock adds no call to
// it — opened with the page or after it — and a question carries that kind and id.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp } from '../../test-utils';
import { setDockOpen } from './dockState';

// Whole-app renders through the router and several lazy chunks: generous under a loaded machine.
vi.setConfig({ testTimeout: 60_000 });
configure({ asyncUtilTimeout: 15_000 });

afterEach(() => {
  act(() => setDockOpen(false));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '11111111-1111-4111-8111-111111111111';
const D = '22222222-2222-4222-8222-222222222222';
const X = '33333333-3333-4333-8333-333333333333';
/** Another project the caller can open, more recently: the one the dock would ask about if the route did not decide. */
const RECENT = '99999999-9999-4999-8999-999999999999';

function serve(routes: Record<string, unknown>) {
  const calls: { channel: string; payload: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split('?')[0];
      const channel = path.startsWith('/api/rpc/') ? decodeURIComponent(path.slice('/api/rpc/'.length)) : path;
      if (path.startsWith('/api/rpc/')) calls.push({ channel, payload: init?.body ? (JSON.parse(String(init.body)) as { args: unknown[] }).args[0] : undefined });
      return new Response(JSON.stringify(channel in routes ? routes[channel] : []), { status: 200 });
    }),
  );
  return calls;
}

const SHELL = {
  '/api/auth/me': { user: { email: 'dev@local', role: 'admin' }, org: 'default', mode: 'dev', canSignOut: false },
  'projects:overview': [
    { id: P, name: 'Sales', updatedAt: '2026-10-01T10:00:00Z', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 1, sample: false },
    { id: RECENT, name: 'Recent', updatedAt: '2026-10-12T10:00:00Z', lastOpenedAt: '2026-10-12T10:00:00Z', archived: false, datasets: 0, dashboards: 0, sample: false },
  ],
  'projects:list': [
    { id: P, name: 'Sales', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' },
    { id: RECENT, name: 'Recent', createdAt: '2026-10-12T00:00:00Z', updatedAt: '2026-10-12T00:00:00Z', lastOpenedAt: '2026-10-12T10:00:00Z' },
  ],
  'projects:roles': { [P]: 'admin', [RECENT]: 'admin' },
  'ai:status': { ready: true, models: [{ provider: 'anthropic', model: 'm', label: 'M', isDefault: true }], mine: { provider: 'anthropic', model: 'm' }, copilotEnabled: true, keyStore: null },
  'copilot:history': { ok: true, turns: [], threadId: null },
  'copilot:ask': { ok: true, answer: 'ok', threadId: null, turns: [], suggestedAction: { kind: 'none', intent: '' } },
  'dataset:list': [{ id: D, name: 'Orders', sourceKind: 'csv', rowCount: 3, columnCount: 2, updatedAt: '' }],
  'dataset:columns': { id: D, name: 'Orders', rowCount: 3, columns: [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }] },
};

interface Screen {
  kind: string;
  path: string;
  /** The page's own query for the thing it shows. */
  channel: string;
  name: string;
  routes: Record<string, unknown>;
  /** The first of the three starter questions for this kind. */
  starter: string;
}

const SCREENS: Screen[] = [
  {
    kind: 'visual',
    path: `/visuals/${P}/${X}`,
    channel: 'visual:get',
    name: 'Amount by region',
    starter: 'What does Amount by region show?',
    routes: {
      'visual:get': { id: X, name: 'Amount by region', chartType: 'table', datasetId: D, updatedAt: '', favorite: false, encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] }, overrides: {}, filters: [] },
      'visual:preview': { ok: true, data: { labels: ['East', 'North'], series: [{ name: 'sum of amount', values: [3, 4] }] }, recommendedShape: 'unstructured', warnings: [] },
      'relationship:related': { ok: true, groups: [] },
      'boundary:list': { ok: true, boundaries: [] },
      'snapshots:stamps': { ok: true, items: [] },
    },
  },
  {
    kind: 'analysis',
    path: `/analyses/${P}/${X}`,
    channel: 'analysis:open',
    name: 'Q3 review',
    starter: 'What does Q3 review show?',
    routes: {
      'analysis:open': { ok: true, analysis: { id: X, projectId: P, name: 'Q3 review', sheets: [{ id: 's1', name: 'Sheet 1', cards: [] }], filters: [], style: {}, parameters: [], updatedAt: '' }, visuals: [] },
    },
  },
  {
    kind: 'scorecard',
    path: `/scorecards/${P}/${X}`,
    channel: 'scorecard:get',
    name: 'Company goals',
    starter: 'What is off track in Company goals?',
    routes: {
      'scorecard:get': { id: X, projectId: P, name: 'Company goals', period: 'month', rows: [], updatedAt: '' },
      'scorecard:compute': { ok: true, name: 'Company goals', period: 'month', window: { label: 'Oct 2026', from: '2026-10-01', to: '2026-10-31' }, rows: [], groups: [], counts: { good: 0, warn: 0, off: 0, none: 0 } },
    },
  },
  {
    kind: 'scenario',
    path: `/analytics/scenarios/${P}/${X}`,
    channel: 'scenario:get',
    name: 'Price rise',
    starter: 'What changes most in Price rise?',
    routes: {
      'scenario:get': { id: X, projectId: P, name: 'Price rise', baseMetricIds: [], drivers: [], updatedAt: '' },
      'scenario:compute': { ok: false, error: 'Pick a metric first.' },
      'scenario:targets': { ok: true, columns: [], metrics: [], datasets: [] },
    },
  },
];

const chip = () => within(document.getElementById('dock-panel') as HTMLElement).getByTestId('dock-context');

describe('the dock beside a real page', () => {
  for (const sc of SCREENS) {
    it(`an open ${sc.kind}: the header names it from the page’s own query, and a question is about it`, async () => {
      const calls = serve({ ...SHELL, ...sc.routes });
      const count = () => calls.filter((c) => c.channel === sc.channel).length;
      renderApp(sc.path);
      // The page has its record; the dock is still shut and has asked for nothing.
      await waitFor(() => expect(count()).toBe(1));
      expect(calls.some((c) => c.channel.startsWith('copilot:'))).toBe(false);

      fireEvent.click(await screen.findByRole('button', { name: 'Assistant' }));
      const box = (await screen.findByRole('textbox', { name: 'Ask the Assistant' })) as HTMLTextAreaElement;
      await waitFor(() => expect(chip().textContent).toBe(sc.name));
      expect(chip().getAttribute('title')).toBe(`Answers are based on ${sc.kind} · ${sc.name}`);
      // Its own questions, by name — and the conversation is this page's project's, not the most recent one's.
      await waitFor(() => expect(box.disabled).toBe(false));
      expect((await screen.findByRole('button', { name: sc.starter })).textContent).toBe(sc.starter);
      expect(calls.filter((c) => c.channel === 'copilot:history').map((c) => (c.payload as { projectId: string }).projectId)).toEqual([P]);
      expect(screen.queryByRole('combobox', { name: 'Project' })).toBeNull(); // the route decides: no project switch in the dock

      fireEvent.change(box, { target: { value: 'What stands out?' } });
      fireEvent.keyDown(box, { key: 'Enter' });
      await waitFor(() => expect(calls.find((c) => c.channel === 'copilot:ask')?.payload).toMatchObject({ projectId: P, context: { kind: sc.kind, id: X }, question: 'What stands out?' }));
      // Opening the dock and asking cost the page's query nothing.
      expect(count()).toBe(1);
    });
  }

  it('remembered open across a load: the page and the dock mount together and still make one call', async () => {
    const sc = SCREENS[0];
    const calls = serve({ ...SHELL, ...sc.routes });
    act(() => setDockOpen(true));
    renderApp(sc.path);
    await screen.findByRole('textbox', { name: 'Ask the Assistant' });
    await waitFor(() => expect(chip().textContent).toBe(sc.name));
    expect(calls.filter((c) => c.channel === sc.channel).length).toBe(1);
  });

  it('@ still overrides the screen: the pinned dataset is asked about, and × returns to the open visual', async () => {
    const sc = SCREENS[0];
    const calls = serve({ ...SHELL, ...sc.routes });
    act(() => setDockOpen(true));
    renderApp(sc.path);
    const box = (await screen.findByRole('textbox', { name: 'Ask the Assistant' })) as HTMLTextAreaElement;
    await waitFor(() => expect(chip().textContent).toBe(sc.name));
    await waitFor(() => expect(box.disabled).toBe(false));
    fireEvent.change(box, { target: { value: '@' } });
    const picker = await screen.findByRole('dialog', { name: 'Point the Assistant at' });
    fireEvent.click(await within(picker).findByRole('button', { name: 'Orders' }));
    await waitFor(() => expect(chip().textContent).toBe('Orders'));
    fireEvent.change(box, { target: { value: 'Why the dip?' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect((calls.find((c) => c.channel === 'copilot:ask')?.payload as { context: unknown } | undefined)?.context).toEqual({ kind: 'dataset', id: D }));
    fireEvent.click(await screen.findByRole('button', { name: 'Follow what’s on screen again' }));
    expect(chip().textContent).toBe(sc.name);
  });

  // Negative controls: a draft and a tool keep the route's project, and are about the whole of it.
  for (const path of [`/visuals/${P}/new?dataset=${D}`, `/analytics/scenarios/${P}/compare`]) {
    it(`${path.split('/').slice(-1)[0].split('?')[0]}: the whole project — the route’s`, async () => {
      const calls = serve({ ...SHELL, ...SCREENS[0].routes });
      act(() => setDockOpen(true));
      renderApp(path);
      await screen.findByRole('textbox', { name: 'Ask the Assistant' });
      await waitFor(() => expect(calls.filter((c) => c.channel === 'copilot:history').map((c) => (c.payload as { projectId: string }).projectId)).toEqual([P]));
      expect(chip().textContent).toBe('whole project');
    });
  }
});
