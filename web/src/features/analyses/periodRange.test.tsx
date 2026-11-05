// A period metric's KPI (semantic layer part 5, step 05) says which days its figure covers, from the server's
// `periodRange`, as a muted line under the figure. With none, no line.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { MetricBody } from './editor/MetricCard';
import { EditorCtx, type EditorApi } from './editor/context';
import type { Card } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const M = '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const CARD = { id: 'c1', type: 'metric', layout: { x: 0, y: 0, w: 3, h: 2 }, metric: { datasetId: D, column: '', aggregation: 'sum', metricId: M } } as unknown as Card;

function kpi(tile: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    new Response(JSON.stringify(url.includes('projects%3Aroles') || url.includes('projects:roles') ? { [P]: 'viewer' } : [tile]), { status: 200 })));
  const ed = { projectId: P, filters: [], params: [], view: { compare: null }, readOnly: true } as unknown as EditorApi;
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <EditorCtx.Provider value={ed}>
          <MetricBody card={CARD} />
        </EditorCtx.Provider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('a period metric’s tile says which days it covers', () => {
  it('shows the range under the figure', async () => {
    kpi({ ok: true, value: 1200, display: '$1.2K', name: 'Revenue YTD', periodRange: { from: '2024-01-01', to: '2024-10-31' } });
    expect(await screen.findByText('$1.2K')).toBeTruthy();
    expect(screen.getByText('Jan 1 – Oct 31, 2024')).toBeTruthy();
  });

  it('a range across a year names both years', async () => {
    kpi({ ok: true, value: 1200, display: '$1.2K', name: 'Revenue 90d', periodRange: { from: '2023-12-01', to: '2024-02-29' } });
    expect(await screen.findByText('Dec 1, 2023 – Feb 29, 2024')).toBeTruthy();
  });

  it('NEGATIVE CONTROL: a tile with no periodRange has no line', async () => {
    kpi({ ok: true, value: 1200, display: '$1.2K', name: 'Revenue' });
    expect(await screen.findByText('$1.2K')).toBeTruthy();
    expect(screen.queryByText(/2024/)).toBeNull();
  });
});
