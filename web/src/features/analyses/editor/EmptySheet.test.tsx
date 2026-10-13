// An empty sheet's starter buttons: each asks `analysis:starterCards` for its
// own kind, and the cards the server returns — already placed — are added to the
// sheet as one undoable edit. Nothing is laid out in the browser.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Doc } from './doc';
import { EditorCtx, type EditorApi } from './context';
import { EmptySheet } from './EmptySheet';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PID = '11111111-1111-4111-8111-111111111111';
const DID = '22222222-2222-4222-8222-222222222222';
const AID = '33333333-3333-4333-8333-333333333333';
const CARDS = [
  { id: 'c1', type: 'visual', layout: { x: 0, y: 0, w: 8, h: 6 }, visualId: 'v1' },
  { id: 'c2', type: 'metric', layout: { x: 8, y: 0, w: 4, h: 3 }, metric: { datasetId: DID, column: 'amount', aggregation: 'sum' } },
];

function open() {
  const asked: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const channel = decodeURIComponent(/\/api\/rpc\/([^?]+)/.exec(String(url))?.[1] ?? String(url));
      const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (channel === 'dataset:list') return reply([{ id: DID, name: 'Orders', sourceKind: 'csv', rowCount: 120, columnCount: 3, updatedAt: '' }]);
      if (channel === 'analysis:starterCards') {
        asked.push((JSON.parse(String(init?.body)) as { args: Record<string, unknown>[] }).args[0]);
        return reply({ ok: true, cards: CARDS, dropped: [] });
      }
      if (channel === 'analysis:open') return reply({ ok: true, analysis: {}, visuals: [] });
      return reply(null);
    }),
  );
  // The sheet the edit lands on: `edit` runs the mutation, as the editor's own does.
  const doc = { sheets: [{ id: 's1', name: 'Sheet 1', cards: [] as unknown[] }] };
  const ed = {
    projectId: PID,
    analysisId: AID,
    readOnly: false,
    sheet: 0,
    edit: vi.fn((_label: string, mutate: (d: Doc) => void) => mutate(doc as unknown as Doc)),
    addVisuals: vi.fn(),
    openAdd: vi.fn(),
  };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <EditorCtx.Provider value={ed as unknown as EditorApi}>
        <EmptySheet />
      </EditorCtx.Provider>
    </QueryClientProvider>,
  );
  return { asked, doc, ed };
}

describe('an empty sheet’s starters', () => {
  it.each([
    ['KPIs + chart', 'kpis'],
    ['Two-up', 'twoup'],
    ['Spotlight', 'spotlight'],
    ['Chart first', 'lead'],
  ])('“%s” asks for the %s starter and adds the cards it returns, as placed', async (label, kind) => {
    const { asked, doc, ed } = open();
    fireEvent.click(await screen.findByRole('button', { name: label }));
    await waitFor(() => expect(ed.edit).toHaveBeenCalledTimes(1));
    expect(asked).toEqual([{ projectId: PID, kind, datasetId: DID }]);
    expect(doc.sheets[0].cards).toEqual(CARDS);
  });

  // Negative control: the add-a-card buttons beside them build nothing.
  it('“Add a visual” asks for no starter', async () => {
    const { asked, ed } = open();
    await screen.findByRole('button', { name: 'Spotlight' });
    fireEvent.click(screen.getByRole('button', { name: 'Add a visual' }));
    expect(ed.openAdd).toHaveBeenCalledWith('visual');
    expect(asked).toEqual([]);
  });
});
