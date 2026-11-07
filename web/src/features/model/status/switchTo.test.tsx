import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { replacementOf, retiredMeasures, switchTo } from './switchTo';
import { RetiredNote } from './RetiredNote';
import type { MetricSummary } from '../../analyses/metrics/api';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const at = { by: 'ana@acme.com', at: '2026-11-03T10:00:00Z', note: '' };
const m = (id: string, name: string, extra: object = {}) =>
  ({ id, name, datasetId: 'd', datasetName: 'Sales', definition: { column: `${name}_col`, aggregation: 'avg' }, definitionText: '', format: { kind: 'number' }, updatedAt: '', ...extra }) as unknown as MetricSummary;
const NET = m('net', 'Net', { status: { state: 'certified', ...at } });
const GROSS = m('gross', 'Gross', { status: { state: 'retired', ...at, replacedBy: { ref: 'metric:net', name: 'Net' } } });
const ENC = { category: 'region', values: [{ column: 'x', aggregation: 'sum' }, { column: 'Gross_col', aggregation: 'avg', metricId: 'gross' }] };

describe('switchTo', () => {
  it('finds the retired measure and changes only values[index]', () => {
    expect(retiredMeasures(ENC, [GROSS, NET]).map((r) => r.index)).toEqual([1]);
    const out = switchTo(ENC, 1, NET);
    expect(out.values[0]).toBe(ENC.values[0]);
    expect(out.values[1]).toEqual({ column: 'Net_col', aggregation: 'avg', metricId: 'net' });
    expect(out.category).toBe('region');
  });
  it('NEGATIVE CONTROL: a certified metric and a measure with no metric are not retired', () => {
    expect(retiredMeasures({ values: [{ metricId: 'net' }, {}] }, [GROSS, NET])).toEqual([]);
    expect(replacementOf(GROSS, [GROSS])).toBeUndefined();
  });
});

describe('RetiredNote', () => {
  const mount = (ids: string[], onSwitch?: () => void) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, metrics: [GROSS, NET] }), { status: 200 })));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RetiredNote projectId="p" metricIds={ids} onSwitch={onSwitch} />
      </QueryClientProvider>,
    );
  };
  it('says so, and offers the switch to an editor', async () => {
    const onSwitch = vi.fn();
    mount(['gross'], onSwitch);
    expect(await screen.findByText('Retired metric: Gross')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Net' }));
    expect(onSwitch).toHaveBeenCalledWith(0, NET);
  });
  it('a viewer sees the line and no button; a certified metric has no line', async () => {
    mount(['gross']);
    await screen.findByText('Retired metric: Gross');
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    mount(['net']);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole('note')).toBeNull();
  });
});
