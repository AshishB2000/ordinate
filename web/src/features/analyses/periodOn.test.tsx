// A dashboard date control's period moved onto the date a metric counts by (semantic layer D9): the tile says which
// date it used, from the server's `periodOn`, on a chart and on a KPI. With no `periodOn`, no note.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { VisualTileBody } from './VisualTile';
import { MetricBody } from './editor/MetricCard';
import { EditorCtx, type EditorApi } from './editor/context';
import type { Card, VisualDef } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const M = '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const DEF: VisualDef = { id: 'v', name: 'Revenue by region', datasetId: D, chartType: 'column', encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] }, overrides: {}, filters: [], updatedAt: '' };
// A parameter note the tile always shows: what the test waits for before it looks for the date note.
const SEEN = 'Target is not set.';
const CHART = { ok: true, data: { labels: ['East', 'West'], series: [{ name: 'Revenue', values: [3, 4] }] }, warnings: [], paramErrors: [SEEN] };
const CARD = { id: 'c1', type: 'metric', layout: { x: 0, y: 0, w: 3, h: 2 }, metric: { datasetId: D, column: 'amount', aggregation: 'sum', metricId: M } } as unknown as Card;
const NOTE = 'Date range applied to ship_date';

function serve(tile: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    new Response(JSON.stringify(url.includes('projects%3Aroles') || url.includes('projects:roles') ? { [P]: 'viewer' } : [tile]), { status: 200 })));
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function chart(tile: unknown) {
  render(
    <MemoryRouter>
      <QueryClientProvider client={serve(tile)}>
        <VisualTileBody projectId={P} def={DEF} filters={[]} params={[]} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function kpi(tile: unknown) {
  const ed = { projectId: P, filters: [], params: [], view: { compare: null }, readOnly: true } as unknown as EditorApi;
  render(
    <MemoryRouter>
      <QueryClientProvider client={serve(tile)}>
        <EditorCtx.Provider value={ed}>
          <MetricBody card={CARD} />
        </EditorCtx.Provider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('a tile says which date a date control was applied to', () => {
  it('a chart drawn on the metric’s date says so', async () => {
    chart({ ...CHART, periodOn: 'ship_date' });
    expect(await screen.findByText(NOTE)).toBeTruthy();
  });

  it('NEGATIVE CONTROL: a chart with no periodOn has no note', async () => {
    chart(CHART);
    expect(await screen.findByText(SEEN)).toBeTruthy();
    expect(screen.queryByText(/Date range applied to/)).toBeNull();
  });

  it('a KPI counted on the metric’s date says so', async () => {
    kpi({ ok: true, value: 647, display: '647', name: 'Revenue', periodOn: 'ship_date' });
    expect(await screen.findByText('647')).toBeTruthy();
    expect(screen.getByText(NOTE)).toBeTruthy();
  });

  it('NEGATIVE CONTROL: a KPI with no periodOn has no note', async () => {
    kpi({ ok: true, value: 647, display: '647', name: 'Revenue' });
    expect(await screen.findByText('647')).toBeTruthy();
    expect(screen.queryByText(/Date range applied to/)).toBeNull();
  });
});
