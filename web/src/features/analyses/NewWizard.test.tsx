// The wizard's plain layouts: each one the server builds from the dataset's
// columns is created by asking `analysis:starterCards` for ITS kind, and the
// cards that come back are what the new dashboard's first sheet is saved with.
// The browser only reads what was ASKED for — no layout is worked out here.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router';
import { NewWizard } from './NewWizard';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PID = '11111111-1111-4111-8111-111111111111';
const DID = '22222222-2222-4222-8222-222222222222';
const AID = '33333333-3333-4333-8333-333333333333';
const CARD = { id: 'c1', type: 'visual', layout: { x: 0, y: 0, w: 8, h: 6 }, visualId: 'v1' };

/** A server with one dataset and no model (or, with `ai`, one that drafts); records every RPC and what it was asked. */
function serve(ai = false) {
  const calls: { channel: string; payload: Record<string, unknown> }[] = [];
  const replies: Record<string, unknown> = {
    '/api/auth/me': { user: { email: 'dev@local', role: 'admin' }, org: 'default', mode: 'dev', canSignOut: false },
    'dataset:list': [{ id: DID, name: 'Orders', sourceKind: 'csv', rowCount: 120, columnCount: 3, updatedAt: '2026-10-01T10:00:00Z' }],
    'ai:status': ai ? { ready: true, models: [], mine: null, keyStore: null } : { ready: false, reason: 'no_model', models: [], mine: null, keyStore: null },
    'analysis:draft': { ok: true, name: 'Orders', sheets: [{ name: 'Overview', visuals: [] }], plan: { name: 'Orders' } },
    'analysis:buildPlan': { ok: true, analysis: { id: AID } },
    'template:list': { ok: true, datasetId: DID, datasetName: 'Orders', columns: [], templates: [] },
    'analysis:create': { id: AID, name: 'Orders dashboard', sheets: [{ id: 's1', name: 'Sheet 1', cards: [] }] },
    'analysis:starterCards': { ok: true, cards: [CARD] },
    'analysis:update': { ok: true },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).split('?')[0];
      const channel = path.startsWith('/api/rpc/') ? decodeURIComponent(path.slice('/api/rpc/'.length)) : path;
      const payload = init?.body ? (JSON.parse(String(init.body)) as { args: Record<string, unknown>[] }).args[0] : {};
      calls.push({ channel, payload });
      return new Response(JSON.stringify(replies[channel] ?? null), { status: 200 });
    }),
  );
  return calls;
}

/** Where the wizard sent the browser. */
function Where() {
  const at = useLocation();
  return <output data-testid="where">{at.pathname + at.search}</output>;
}

/** The wizard on "Start from", with the Orders dataset already chosen. */
async function open(ai = false) {
  const calls = serve(ai);
  const onClose = vi.fn();
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <NewWizard projectId={PID} datasetId={DID} initialStep={2} onClose={onClose} />
        <Where />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  const layouts = await screen.findByRole('radiogroup', { name: 'Layouts' });
  const create = async (title: RegExp) => {
    fireEvent.click(within(layouts).getByRole('radio', { name: title }));
    fireEvent.click(screen.getByRole('button', { name: 'Create dashboard' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  };
  return { calls, layouts, create };
}

describe('the wizard’s layouts', () => {
  it('offers the blank sheet, the four starters, the Assistant and the screenshot rebuild, in that order', async () => {
    const { layouts } = await open();
    const titles = ['Blank sheet', 'KPIs + chart', 'Two-up', 'Spotlight', 'Chart first', 'Let the Assistant design it', 'Rebuild from a screenshot'];
    // A card reads as its title and then its one-line body.
    const cards = within(layouts).getAllByRole('radio').map((r) => r.textContent ?? '');
    expect(cards.map((text, i) => (text.startsWith(titles[i]) ? titles[i] : text))).toEqual(titles);
  });

  it.each([
    ['KPIs + chart', 'kpis'],
    ['Two-up', 'twoup'],
    ['Spotlight', 'spotlight'],
    ['Chart first', 'lead'],
  ])('“%s” is built as the %s starter, and its cards are the new sheet’s', async (title, kind) => {
    const { calls, create } = await open();
    await create(new RegExp(`^${title.replace('+', '\\+')}`));
    expect(calls.find((c) => c.channel === 'analysis:starterCards')?.payload).toEqual({ projectId: PID, kind, datasetId: DID });
    const saved = calls.find((c) => c.channel === 'analysis:update')?.payload as { id: string; sheets: { cards: unknown[] }[] };
    expect(saved.id).toBe(AID);
    expect(saved.sheets[0].cards).toEqual([CARD]);
  });

  it('the Assistant’s step shows the brief under the description, and hands both to the draft', async () => {
    const { calls, layouts } = await open(true);
    const ai = within(layouts).getByRole('radio', { name: /^Let the Assistant design it/ }) as HTMLButtonElement;
    await waitFor(() => expect(ai.disabled).toBe(false));
    fireEvent.click(ai);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Describe the dashboard' }), { target: { value: '  revenue by region  ' } });
    // The same brief the draft flow shows, on its defaults — asked here, so not asked again.
    expect((screen.getByRole('radio', { name: /^Assistant picks/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: /^Workspace default/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: /^Scorecard/ }));
    fireEvent.click(screen.getByRole('radio', { name: /^Executive/ }));
    expect(calls.some((c) => c.channel === 'analysis:draft')).toBe(false); // the wizard no longer asks the model itself

    fireEvent.click(screen.getByRole('button', { name: 'Draft with the Assistant' }));
    const review = await screen.findByRole('dialog', { name: 'Assistant draft — review before creating' });
    expect(screen.queryByRole('dialog', { name: 'Draft a dashboard' })).toBeNull();
    expect(screen.queryByRole('radiogroup', { name: 'Shape' })).toBeNull();
    expect(calls.filter((c) => c.channel === 'analysis:draft').map((c) => c.payload)).toEqual([{ projectId: PID, datasetId: DID, intent: 'revenue by region', shape: 'scorecard', clarify: true }]);
    // The name follows the dataset until it is typed, so the draft's own name stands.
    fireEvent.click(within(review).getByRole('button', { name: 'Create dashboard' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'analysis:buildPlan')?.payload).toEqual({ projectId: PID, plan: { name: 'Orders' }, style: 'executive' }));
  });

  it('the screenshot rebuild needs a model, and opens its own page on the chosen dataset', async () => {
    const off = await open();
    expect((within(off.layouts).getByRole('radio', { name: /^Rebuild from a screenshot/ }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    const { layouts, calls } = await open(true);
    const card = within(layouts).getByRole('radio', { name: /^Rebuild from a screenshot/ }) as HTMLButtonElement;
    await waitFor(() => expect(card.disabled).toBe(false));
    fireEvent.click(card);
    fireEvent.click(screen.getByRole('button', { name: 'Choose a screenshot' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe(`/analyses/${PID}/rebuild?dataset=${DID}`));
    expect(calls.some((c) => c.channel === 'analysis:create' || c.channel === 'rebuild:read')).toBe(false); // nothing is created or read yet
  });

  // Negative control: a start that is not a starter asks for none.
  it('a blank sheet asks for no starter', async () => {
    const { calls, create } = await open();
    await create(/^Blank sheet/);
    expect(calls.some((c) => c.channel === 'analysis:create')).toBe(true);
    expect(calls.some((c) => c.channel === 'analysis:starterCards' || c.channel === 'analysis:update')).toBe(false);
  });
});
