// A capture's own page, over the whole app with fetch answered per channel.
// The rule under test: the page lays out what captureDataset:get returned and
// computes nothing — a figure, a metric line and a table cell appear exactly as
// the server sent them — and "Build an analysis" goes through the composer's
// cell check unless the capture is already a dataset.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp } from '../../test-utils';
import { setDockOpen } from '../assistant/dockState';

afterEach(() => {
  act(() => setDockOpen(false));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const C = '3b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const LAZY = 15_000;

const VIEW = {
  ok: true,
  id: C,
  title: 'Regional sales',
  createdAt: '2026-10-11T15:41:00Z',
  datasetId: null as string | null,
  hasImage: true,
  analysis: 'Sales are spread across three regions.',
  headline: [{ text: 'One region leads. North is the largest at ' }, { text: '120', bold: true }, { text: '.' }] as { text: string; bold?: boolean }[] | null,
  metrics: [{ id: 'pct_of_total', title: 'Share of total', lines: ['North: 40.68%', 'South: 32.20%', 'East: 27.12%'] }],
  chart: { labels: ['North', 'South', 'East'], series: [{ name: 'Sales', values: [120, 95, 80] }] },
  chartTypes: ['bar', 'pie', 'table'],
  followups: ['Which region leads?'],
  // `007` is text and 40.68 is not rounded: the page must print both as sent.
  table: { columns: [{ name: 'Region', type: 'text' }, { name: 'Code', type: 'text' }, { name: 'Sales', type: 'number' }], rows: [['North', '007', 120], ['South', '008', 40.68]], warnings: [] } as object | null,
  unsure: true,
};

function serve(view: unknown, extra: Record<string, unknown> = {}) {
  const calls: { channel: string; payload: Record<string, unknown> }[] = [];
  const routes: Record<string, unknown> = {
    '/api/auth/me': { user: { email: 'boss@acme.test', role: 'admin' }, org: 'acme', mode: 'oidc', canSignOut: true },
    'projects:list': [{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }],
    'projects:roles': { [P]: 'admin' },
    'captureDataset:get': view,
    'captureDataset:image': { ok: true, dataUrl: PNG },
    ...extra,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split('?')[0];
      const channel = path.startsWith('/api/rpc/') ? decodeURIComponent(path.slice('/api/rpc/'.length)) : path;
      const payload = init?.body ? ((JSON.parse(String(init.body)) as { args: Record<string, unknown>[] }).args[0] ?? {}) : {};
      calls.push({ channel, payload });
      return new Response(JSON.stringify(routes[channel] ?? null), { status: 200 });
    }),
  );
  return calls;
}

const open = () => renderApp(`/data/captures/${P}/${C}`);
const href = (name: string) => screen.getByRole('link', { name }).getAttribute('href');

describe('a capture’s page', () => {
  it('shows the screenshot beside the analysis, every figure and cell as the server sent it', async () => {
    const calls = serve(VIEW);
    open();
    expect(await screen.findByRole('heading', { level: 1, name: 'Regional sales' }, { timeout: LAZY })).toBeTruthy();
    // When it was captured is a machine-readable date, not only words.
    const when = document.querySelector('main header time');
    expect(when?.getAttribute('datetime')).toBe(VIEW.createdAt);
    expect(when?.textContent).toMatch(/^Captured /);

    const analysis = screen.getByRole('region', { name: 'Analysis' });
    expect(within(analysis).getByText('120').tagName).toBe('STRONG');
    expect(within(analysis).getByText('Sales are spread across three regions.')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Metrics' })).getByText('South: 32.20%')).toBeTruthy();

    const table = within(screen.getByRole('region', { name: 'What the model read' }));
    expect(table.getByText('007')).toBeTruthy();
    expect(table.getByText('40.68')).toBeTruthy();
    expect(table.getByText(/The model was unsure/)).toBeTruthy();

    const img = await screen.findByRole('img', { name: 'Screenshot: Regional sales' });
    expect(img.getAttribute('src')).toBe(PNG);
    // Only the chart ids <Chart> draws are offered: `table` has a renderer of its own.
    expect(within(screen.getByRole('group', { name: 'Chart type' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['Bar', 'Pie']);
    // Opening the page reads the stored capture; it never asks a model.
    expect(calls.filter((c) => c.channel.startsWith('captureDataset:')).map((c) => c.channel).sort()).toEqual(['captureDataset:get', 'captureDataset:image']);
    expect(calls.find((c) => c.channel === 'captureDataset:get')?.payload).toEqual({ projectId: P, captureId: C });
  });

  it('asks whether to build an analysis: through the composer’s cell check, or just the dataset', async () => {
    serve(VIEW);
    open();
    expect(await screen.findByRole('heading', { name: 'Want an analysis built from this?' }, { timeout: LAZY })).toBeTruthy();
    expect(href('Build an analysis')).toBe(`/data/import?project=${P}&capture=${C}&then=analysis`);
    expect(href('Just save as dataset')).toBe(`/data/import?project=${P}&capture=${C}`);
  });

  it('a capture that is already a dataset goes straight to the new-analysis wizard on it', async () => {
    serve({ ...VIEW, datasetId: D });
    open();
    expect(await screen.findByRole('heading', { name: 'Want an analysis built from this?' }, { timeout: LAZY })).toBeTruthy();
    expect(href('Build an analysis')).toBe(`/dashboards?project=${P}&new=1&dataset=${D}`);
    expect(href('Open the dataset')).toBe(`/data/${P}/${D}`);
    expect(screen.queryByRole('link', { name: 'Just save as dataset' })).toBeNull();
  });

  it('a screenshot with no table shows the analysis and says why nothing can be built', async () => {
    serve({ ...VIEW, headline: null, metrics: [], chart: { labels: [], series: [] }, chartTypes: [], table: null, unsure: false });
    open();
    expect(await screen.findByRole('heading', { name: 'Nothing to build from yet' }, { timeout: LAZY })).toBeTruthy();
    expect(screen.getByText('Sales are spread across three regions.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Build an analysis' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Chart' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'What the model read' })).toBeNull();
  });

  it('a viewer reads the capture but is not asked to build: saving is an editor’s', async () => {
    serve(VIEW, { 'projects:roles': { [P]: 'viewer' } });
    open();
    expect(await screen.findByText('Sales are spread across three regions.', undefined, { timeout: LAZY })).toBeTruthy();
    expect(await screen.findByRole('img', { name: 'Screenshot: Regional sales' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Want an analysis built from this?' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Build an analysis' })).toBeNull();
  });

  it('a capture that is gone says so, with the way back', async () => {
    const calls = serve({ ok: false, error: 'That capture no longer exists.' });
    open();
    expect(await screen.findByRole('heading', { name: 'This capture is gone' }, { timeout: LAZY })).toBeTruthy();
    expect(href('Back to Captures')).toBe(`/data/captures?project=${P}`);
    expect(calls.some((c) => c.channel === 'captureDataset:image')).toBe(false);
  });

  it('a follow-up is asked in the dock, about this capture', async () => {
    const calls = serve(VIEW, {
      'ai:status': { ready: true, models: [{ provider: 'anthropic', model: 'm', label: 'M', isDefault: true }], mine: { provider: 'anthropic', model: 'm' }, copilotEnabled: true, keyStore: null },
      'copilot:history': { ok: true, turns: [], threadId: null },
      'dataset:list': [],
      'copilot:ask': { ok: true, answer: 'North.', threadId: null, turns: [], suggestedAction: { kind: 'none', intent: '' } },
    });
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Which region leads?' }, { timeout: LAZY }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'copilot:ask')?.payload).toMatchObject({ projectId: P, context: { kind: 'capture', id: C }, question: 'Which region leads?' }), { timeout: LAZY });
  });
});
