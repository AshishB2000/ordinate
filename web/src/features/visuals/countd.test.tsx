// Count distinct in the chart builder's measure picker (semantic layer part 5, step 04). A point, hexbin or flow map
// refuses it on the server, so its picker does not offer it; a region map does.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { serveRpc } from '../../test-utils';
import type { Encoding } from './api';
import { EncodingForm } from './EncodingForm';
import { AGG_LABELS, AGGS, type Column } from './model';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PID = '11111111-1111-4111-8111-111111111111';
const DID = '22222222-2222-4222-8222-222222222222';
const COLS: Column[] = [{ name: 'region', type: 'text' }, { name: 'customer_id', type: 'text' }];
const BASE: Encoding = { category: 'region', values: [{ column: 'customer_id', aggregation: 'count' }] };

function mount(encoding: Encoding) {
  serveRpc({ 'metric:list': { body: { ok: true, metrics: [] } }, 'projects:roles': { body: { [PID]: 'editor' } }, 'formula:functions': { body: [] } });
  const onChange = vi.fn<(e: Encoding) => void>();
  const el = <EncodingForm projectId={PID} datasetId={DID} cols={COLS} related={[]} encoding={encoding} info={undefined} canEdit onChange={onChange} onFormat={vi.fn()} />;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={createMemoryRouter([{ path: '/', element: el }])} />
    </QueryClientProvider>,
  );
  return onChange;
}
const options = () => {
  fireEvent.click(screen.getByRole('combobox', { name: 'Aggregation' }));
  return screen.getAllByRole('option').map((o) => o.textContent);
};

describe('Count distinct in the builder', () => {
  it('is in the list with its label, and choosing it puts countd in the encoding', () => {
    expect(AGGS).toContain('countd');
    expect(AGG_LABELS.countd).toBe('Count distinct');
    const onChange = mount(BASE);
    expect(options()).toEqual(['Sum', 'Average', 'Count', 'Count distinct', 'Min', 'Max', 'Raw (no aggregation)']);
    fireEvent.click(screen.getByRole('option', { name: 'Count distinct' }));
    expect(onChange).toHaveBeenLastCalledWith({ category: 'region', values: [{ column: 'customer_id', aggregation: 'countd' }] });
  });

  it('NEGATIVE CONTROL: a point, hexbin or flow map does not offer it; a region map does', () => {
    for (const level of ['point', 'hexbin', 'flow'] as const) {
      cleanup();
      mount({ ...BASE, geo: { level } });
      expect(options()).not.toContain('Count distinct');
    }
    cleanup();
    mount({ ...BASE, geo: { level: 'us_state' } });
    expect(options()).toContain('Count distinct');
  });
});
