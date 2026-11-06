// What is off on a SEMANTIC dataset (semantic layer part 7, b3; D14): its layer returns totals, not rows, so there is no
// copy to make — "Make a copy" and "Copy the data instead" are not offered, and the off screens say why in the layer's
// name. A plain Live dataset keeps both (the negative control). The gate reads the dataset list the screen around it
// already holds: it never asks for it itself (a dashboard's tiles are at their request budget).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { serveRpc } from '../../test-utils';
import { LiveNotice } from '../data/LiveMode';
import { LiveBanner, LiveOff, LiveRefusal } from './LiveOff';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const SEM = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const LIVE = '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const LIST = [
  { id: SEM, name: 'Orders layer', sourceKind: 'postgres', rowCount: 0, columnCount: 3, updatedAt: '', mode: 'live', semantic: { layer: 'fake', label: 'Fake layer' } },
  { id: LIVE, name: 'Orders', sourceKind: 'postgres', rowCount: 0, columnCount: 3, updatedAt: '', mode: 'live' },
];

function mount(node: React.ReactNode, cached = true) {
  const calls = serveRpc({ 'projects:roles': { body: { [P]: 'editor' } }, 'dataset:list': { body: LIST } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (cached) client.setQueryData(['dataset:list', P], LIST);
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </MemoryRouter>,
  );
  return calls;
}
const SAID = 'Orders layer comes from Fake layer, which returns totals, not rows.';

describe('off screens on a semantic dataset', () => {
  it('a feature that is off says the layer’s sentence, with no copy to make', async () => {
    mount(<LiveOff projectId={P} datasetId={SEM} feature="pivot" />);
    expect(await screen.findByText(SAID)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Make a copy' })).toBeNull();
  });

  it('NEGATIVE CONTROL: a plain Live dataset offers the copy, in its own words', async () => {
    mount(<LiveOff projectId={P} datasetId={LIVE} feature="pivot" />);
    expect(await screen.findByRole('button', { name: 'Make a copy' })).toBeTruthy();
    expect(screen.queryByText(/comes from/)).toBeNull();
  });

  it('the Data tab offers neither copy, and the banner over row tools none', async () => {
    mount(
      <>
        <LiveNotice projectId={P} datasetId={SEM} maxCacheAgeSec={300} />
        <LiveBanner projectId={P} datasetId={SEM} name="Orders layer" />
      </>,
    );
    expect((await screen.findAllByText(new RegExp(SAID.replace(/[.]/g, '\\.')))).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Make a copy' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy the data instead' })).toBeNull();
  });

  it('a refused figure keeps the server’s sentence and offers no copy', async () => {
    const refusal = (d: string) => <LiveRefusal refusal={{ ok: false, code: 'live_refused', reason: 'pivot', error: 'A pivot table can’t be drawn from Orders layer: Fake layer computes its metrics and returns totals, not rows.' }} projectId={P} datasetId={d} />;
    mount(<>{refusal(LIVE)}{refusal(SEM)}</>);
    expect(await screen.findAllByText(/A pivot table can’t be drawn from Orders layer/)).toHaveLength(2);
    expect(await screen.findAllByRole('button', { name: 'Make a copy' })).toHaveLength(1); // NEGATIVE CONTROL: the plain Live one's
  });

  it('the gate never asks for the list itself', async () => {
    const calls = mount(<LiveRefusal refusal={{ ok: false, code: 'live_refused', reason: 'pivot', error: 'No.' }} projectId={P} datasetId={SEM} />, false);
    await screen.findByText('No.');
    expect(calls.some((c) => c.channel === 'dataset:list')).toBe(false);
  });
});
