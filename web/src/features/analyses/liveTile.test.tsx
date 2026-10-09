// A dashboard tile over a Live dataset (docs/live-data/00-plan.md L2.6): one
// refused tile in a batch shows the server's sentence and "Make a copy" — never
// "No data" with a retry that would refuse again — and the sheet's other tiles
// are unaffected (the batch answers per item).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { VisualTileBody } from './VisualTile';
import type { VisualDef } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const DEF: VisualDef = { id: 'v', name: 'Sales by region', datasetId: D, chartType: 'column', encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] }, overrides: {}, filters: [], updatedAt: '' };
const SENTENCE = 'A pivot table cannot be drawn from a Live dataset yet.';

function draw(tile: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    new Response(JSON.stringify(url.includes('projects%3Aroles') || url.includes('projects:roles') ? { [P]: 'admin' } : [tile]), { status: 200 })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <VisualTileBody projectId={P} def={DEF} filters={[]} params={[]} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('a dashboard tile over a Live dataset', () => {
  it('a typed refusal: the server’s sentence and "Make a copy", no retry', async () => {
    draw({ ok: false, code: 'live_refused', reason: 'pivot', error: SENTENCE });
    expect(await screen.findByText(SENTENCE)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Off for this Live dataset' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Make a copy' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('NEGATIVE CONTROL: any other failure is "No data for this chart" with a retry', async () => {
    draw({ ok: false, code: 'live_failed', error: 'The warehouse could not answer this question.' });
    expect(await screen.findByRole('heading', { name: 'No data for this chart' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Make a copy' })).toBeNull();
  });
});
