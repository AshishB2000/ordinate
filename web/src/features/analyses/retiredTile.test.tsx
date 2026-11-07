// A chart or KPI on a retired metric says so; an editor can switch it to the replacement (model/status/RetiredNote).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { VisualTileBody } from './VisualTile';
import { MetricBody } from './editor/MetricCard';
import { EditorCtx, type EditorApi } from './editor/context';
import type { Card, VisualDef } from './api';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const at = { by: 'ana@acme.com', at: '2026-11-03T10:00:00Z', note: '' };
const metric = (id: string, name: string, status?: object) => ({ id, name, datasetId: D, datasetName: 'S', definition: { column: name, aggregation: 'sum' }, definitionText: '', format: { kind: 'number' }, updatedAt: '', ...(status && { status }) });
const METRICS = [metric('gross', 'Gross', { state: 'retired', ...at, replacedBy: { ref: 'metric:net', name: 'Net' } }), metric('net', 'Net', { state: 'certified', ...at })];
const def = (metricId: string) => ({ id: 'v', name: 'Rev', datasetId: D, chartType: 'column', encoding: { category: 'r', values: [{ column: 'Gross', aggregation: 'sum', metricId }] }, overrides: {}, filters: [], updatedAt: '' }) as unknown as VisualDef;
const CHART = { ok: true, data: { labels: ['E'], series: [{ name: 'R', values: [3] }] }, warnings: [], paramErrors: ['seen'] };

function serve() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(decodeURIComponent(url).includes('metric:list') ? { ok: true, metrics: METRICS } : [CHART]), { status: 200 })));
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('a chart on a retired metric', () => {
  const mount = (id: string, onSwitch?: (e: unknown) => void) =>
    render(
      <MemoryRouter>
        <QueryClientProvider client={serve()}>
          <VisualTileBody projectId={P} def={def(id)} filters={[]} params={[]} onSwitch={onSwitch} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  it('draws the line and, for an editor, saves the switch once', async () => {
    const onSwitch = vi.fn();
    mount('gross', onSwitch);
    expect(await screen.findByText('Retired metric: Gross')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Net' }));
    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(onSwitch.mock.calls[0][0]).toEqual({ category: 'r', values: [{ column: 'Net', aggregation: 'sum', metricId: 'net' }] });
  });
  it('a viewer sees the line and no button', async () => {
    mount('gross');
    await screen.findByText('Retired metric: Gross');
    expect(screen.queryByRole('button', { name: /Switch/ })).toBeNull();
  });
  it('NEGATIVE CONTROL: a certified metric has no line', async () => {
    mount('net');
    await screen.findByText('seen');
    expect(screen.queryByText(/Retired metric/)).toBeNull();
  });
});

describe('a KPI on a retired metric', () => {
  it('says so and its switch writes the card\'s metricId', async () => {
    const edit = vi.fn();
    const card = { id: 'c1', type: 'metric', layout: { x: 0, y: 0, w: 3, h: 2 }, metric: { datasetId: D, column: 'Gross', aggregation: 'sum', label: 'Gross', metricId: 'gross' } } as unknown as Card;
    const ed = { projectId: P, filters: [], params: [], view: { compare: null }, readOnly: false, writer: true, sheet: 0, edit } as unknown as EditorApi;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(decodeURIComponent(url).includes('metric:list') ? { ok: true, metrics: METRICS } : [{ ok: true, value: 3, display: '3' }]), { status: 200 })));
    render(
      <MemoryRouter>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <EditorCtx.Provider value={ed}>
            <MetricBody card={card} />
          </EditorCtx.Provider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Switch to Net' }));
    expect(edit).toHaveBeenCalledTimes(1);
    const doc = { sheets: [{ cards: [structuredClone(card)] }] };
    edit.mock.calls[0][1](doc);
    expect(doc.sheets[0].cards[0].metric).toMatchObject({ metricId: 'net', column: 'Net', label: 'Net' });
  });
});
