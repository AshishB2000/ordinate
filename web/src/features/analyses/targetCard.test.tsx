// A metric's KPI card shows its target (semantic layer part 5, step 09, D14): the attainment as the server wrote it,
// a status dot for the status it graded, and how the target was worked out as a muted line. With `none`, only the
// sentence. With no `target`, nothing new (NEGATIVE CONTROL).

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
  return render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <EditorCtx.Provider value={ed}>
          <MetricBody card={CARD} />
        </EditorCtx.Provider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const BASE = { ok: true, value: 700_000, display: '$700K', name: 'Revenue' };

describe('a KPI card with a target', () => {
  it('prints the server’s attainment, its status and how the target was worked out', async () => {
    kpi({ ...BASE, target: { value: 800_000, display: '$800K', attainment: 87.5, attainmentDisplay: '88%', status: 'warn', how: '1.2M for Nov 2024, pro-rated to Nov 20' } });
    expect(await screen.findByText('88% of target')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'At risk' })).toBeTruthy();
    expect(screen.getByText('1.2M for Nov 2024, pro-rated to Nov 20')).toBeTruthy();
    expect(screen.getByText(/\$800K/)).toBeTruthy(); // the target figure, as written
  });

  it('ahead of the target: on track', async () => {
    kpi({ ...BASE, target: { value: 600_000, display: '$600K', attainment: 116.7, attainmentDisplay: '117%', status: 'good' } });
    expect(await screen.findByText('117% of target')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'On track' })).toBeTruthy();
  });

  it('with no target figure there is only the sentence', async () => {
    kpi({ ...BASE, target: { value: null, display: '', attainment: null, attainmentDisplay: '', status: 'none', none: 'Pick a period to see the target.' } });
    expect(await screen.findByText('Pick a period to see the target.')).toBeTruthy();
    expect(screen.queryByText(/of target/)).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('NEGATIVE CONTROL: a tile with no target has nothing new', async () => {
    const { container } = kpi(BASE);
    expect(await screen.findByText('$700K')).toBeTruthy();
    expect(screen.queryByText(/of target/)).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
    expect(container.querySelector('[data-target]')).toBeNull();
  });
});
