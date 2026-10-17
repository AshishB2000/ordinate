// A date-range control (docs/dashboard-filters/00-design.md): the visuals'
// period picker in a popover, the chip named by the SERVER. A pill stores the
// control's own shape — `{preset, n}` in that key order — and a range stores
// `{from, to}`, never `{preset:'custom'}`. The label is whatever
// `period:picker` calls the period (the stub says 'Zzz': NEGATIVE CONTROL for a
// client table of preset names), and a fixed range asks the server nothing
// until it is opened.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import type { Card, ControlValue } from '../api';
import { ControlWidget } from './ControlWidget';
import { fromSpec, toSpec } from './DateControl';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
type Control = NonNullable<Card['control']>;

/** `period:picker`: one pill (its spec keys in the server's own order), and the asked spec named 'Zzz'. */
function serve() {
  const asked: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      const input = (JSON.parse(String(init?.body)) as { args: Array<{ spec?: unknown }> }).args[0] ?? {};
      asked.push(input);
      const body = {
        groups: [{ title: 'Days', items: [{ spec: { n: 30, preset: 'last_n_days' }, label: 'Last 30 days' }] }],
        units: [{ preset: 'last_n_days', label: 'days' }],
        fiscal: false,
        ...(input.spec ? { current: { spec: input.spec, label: 'Zzz', range: '1 Sep – 30 Sep' } } : {}),
      };
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return asked;
}

function draw(initial?: ControlValue) {
  const changes: Array<ControlValue | undefined> = [];
  function Host() {
    const [v, setV] = useState<ControlValue | undefined>(initial);
    return (
      <ControlWidget
        projectId={P}
        control={{ kind: 'date_range', datasetId: D, column: 'order_date', label: 'Order date' } as Control}
        value={v}
        onChange={(next) => {
          changes.push(next);
          setV(next);
        }}
      />
    );
  }
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Host />
    </QueryClientProvider>,
  );
  return changes;
}

describe('a date-range control', () => {
  it('a pill stores exactly {preset, n}, in that key order, and the chip says what the server calls it', async () => {
    serve();
    const changes = draw();
    fireEvent.click(screen.getByRole('button', { name: 'Order date: All dates' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Last 30 days' }));
    expect(JSON.stringify(changes)).toBe('[{"preset":"last_n_days","n":30}]');
    await screen.findByRole('button', { name: 'Order date: Zzz' });
  });

  it('NEGATIVE CONTROL: the label is the server’s, never a client table’s', async () => {
    const asked = serve();
    draw({ preset: 'last_n_days', n: 30 });
    const chip = await screen.findByRole('button', { name: 'Order date: Zzz' });
    expect(chip.textContent).toBe('Zzz');
    expect(asked).toEqual([{ spec: { preset: 'last_n_days', n: 30 } }]); // one call, the control's own spec
  });

  it('a range round-trips as {from, to} with no `custom` key', async () => {
    expect(toSpec({ from: '2024-01-01', to: '2024-03-31' })).toEqual({ preset: 'custom', from: '2024-01-01', to: '2024-03-31' });
    expect(fromSpec(toSpec({ from: '2024-01-01', to: '2024-03-31' }))).toEqual({ from: '2024-01-01', to: '2024-03-31' });
    expect(fromSpec(toSpec({ preset: 'ytd' }))).toEqual({ preset: 'ytd' });
    expect(fromSpec({ preset: 'custom' })).toBeUndefined();
    serve();
    const changes = draw({ from: '2024-01-01', to: '2024-03-31' });
    fireEvent.click(screen.getByRole('button', { name: 'Order date: 2024-01-01 – 2024-03-31' }));
    fireEvent.change(await screen.findByLabelText('To'), { target: { value: '2024-06-30' } });
    expect(changes).toEqual([{ from: '2024-01-01', to: '2024-06-30' }]);
    expect(JSON.stringify(changes)).not.toContain('custom');
  });

  it('All dates clears the control', async () => {
    serve();
    const changes = draw({ preset: 'ytd' });
    fireEvent.click(await screen.findByRole('button', { name: 'Order date: Zzz' }));
    fireEvent.click(await screen.findByRole('button', { name: 'All dates' }));
    expect(changes).toEqual([undefined]);
    await screen.findByRole('button', { name: 'Order date: All dates' });
  });

  it('a closed chip on a fixed range asks period:picker nothing', async () => {
    const asked = serve();
    draw({ from: '2024-01-01' });
    expect(screen.getByRole('button', { name: 'Order date: From 2024-01-01' })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 100));
    await waitFor(() => expect(asked).toEqual([]));
  });
});
