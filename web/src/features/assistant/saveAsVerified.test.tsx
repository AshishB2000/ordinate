// "Save as verified" on an answer card (semantic part 3 D11): an editor turns a good answer into a verified question.
// The card sends its turn's stored spec and the question that was asked; the server draws it again and may refuse
// with a sentence that belongs beside a field. A viewer is never offered it, and a card already marked verified has no need.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../test-utils';
import { setDockOpen } from './dockState';

// Chart.js needs a canvas jsdom does not have; the card's actions are what is under test.
vi.mock('../../charts/Chart', () => ({ Chart: ({ label }: { label?: string }) => <div role="img" aria-label={label ?? 'Chart'} /> }));

afterEach(() => {
  cleanup();
  act(() => setDockOpen(false));
  vi.unstubAllGlobals();
  localStorage.clear();
});

const PID = '11111111-1111-4111-8111-111111111111';
const THREAD = '22222222-2222-4222-8222-222222222222';
const NOW = new Date().toISOString();
const SPEC = { datasetId: 'd1', category: 'region', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [], chartType: 'column', title: 'Revenue by region' };
const CARD = {
  ok: true, title: 'Revenue by region', chartType: 'column', datasetName: 'Orders', data: { labels: ['West'], series: [{ name: 'sum', values: [3] }] },
  caption: '', headline: [], bullets: [], chips: [], filterLabels: [], notes: [],
};
const TURNS = [
  { id: 'u1', role: 'user', text: 'revenue by region last quarter', createdAt: NOW },
  { id: 'a1', role: 'assistant', text: 'West leads.', createdAt: NOW, answer: SPEC },
];

function serve(routes: Record<string, RpcReply> = {}, role: 'editor' | 'viewer' = 'editor') {
  const body = (b: unknown) => ({ body: b });
  return serveRpc({
    '/api/auth/me': body({ user: { email: 'pat@acme.test', role: 'admin' }, org: 'acme', mode: 'oidc', canSignOut: true }),
    'projects:list': body([{ id: PID, name: 'Ledger', createdAt: NOW, updatedAt: NOW }]),
    'projects:roles': body({ [PID]: role }),
    'ai:status': body({ ready: true, models: [], mine: null, copilotEnabled: true, keyStore: null }),
    'copilot:history': body({ ok: true, turns: TURNS, threadId: THREAD }),
    'dataset:list': body([{ id: 'd1', name: 'Orders' }]),
    'verified:list': body({ ok: true, broken: 0, questions: [] }),
    'answer:card': body(CARD),
    'projects:overview': body([{ id: PID, name: 'Ledger', updatedAt: NOW, lastOpenedAt: null, archived: false, datasets: 0, dashboards: 0, sample: false }]),
    'recent:list': body([]),
    'starred:get': body([]),
    'onboarding:status': body({ show: false, collapsed: false, steps: [], doneCount: 0, total: 0 }),
    'numbers:get': body({ ok: true, tiles: [], suggestions: [], choices: [] }),
    'jobs:list': body({ active: [], recent: [] }),
    'prefs:get': body({ formats: {}, branding: { accent: '' } }),
    'home:overview': body({ counts: { datasets: 1, dashboards: 0, captures: 0, visuals: 0 }, datasets: [{ id: 'd1', name: 'Orders', rowCount: 3, columnCount: 2 }] }),
    ...routes,
  });
}
async function openDock() {
  renderApp('/');
  fireEvent.click(await screen.findByRole('button', { name: 'Assistant' }));
  const dock = await screen.findByRole('complementary', { name: 'Assistant' }, { timeout: 15_000 });
  await within(dock).findByTestId('answer-card');
  return dock;
}

describe('Save as verified', () => {
  it('an editor’s dock card offers it; the dialog is prefilled and saving sends the stored spec with the phrasings split by line', async () => {
    const calls = serve({ 'verified:save': { body: { ok: true, question: { id: 'v1' } } } });
    const dock = await openDock();
    fireEvent.click(await within(dock).findByRole('button', { name: 'Save as verified' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save as a verified question' });
    expect((within(dialog).getByRole('textbox', { name: 'Question' }) as HTMLInputElement).value).toBe('revenue by region last quarter');
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Other ways people ask it' }), { target: { value: 'sales per region\n\n revenue per region ' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Why this is the answer' }), { target: { value: 'Net of refunds' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'verified:save')?.payload).toEqual({
      projectId: PID,
      input: { question: 'revenue by region last quarter', phrasings: ['sales per region', 'revenue per region'], note: 'Net of refunds', spec: SPEC },
    }));
    expect(await within(dock).findByText('Saved as verified')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.filter((c) => c.channel === 'verified:list').length).toBeGreaterThan(1); // the list was asked again
  });

  it('a refusal shows beside its field and keeps what was typed', async () => {
    serve({ 'verified:save': { body: { ok: false, error: '“Revenue by region” is already a verified question.', field: 'question' } } });
    const dock = await openDock();
    fireEvent.click(await within(dock).findByRole('button', { name: 'Save as verified' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save as a verified question' });
    const q = within(dialog).getByRole('textbox', { name: 'Question' }) as HTMLInputElement;
    fireEvent.change(q, { target: { value: 'Revenue by region' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('“Revenue by region” is already a verified question.')).toBeTruthy();
    expect(q.value).toBe('Revenue by region');
    expect(within(dock).queryByText('Saved as verified')).toBeNull();
  });

  it('an empty question is refused before anything is sent', async () => {
    const calls = serve();
    const dock = await openDock();
    fireEvent.click(await within(dock).findByRole('button', { name: 'Save as verified' }));
    const dialog = await screen.findByRole('dialog', { name: 'Save as a verified question' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Question' }), { target: { value: '  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Write the question first.')).toBeTruthy();
    expect(calls.some((c) => c.channel === 'verified:save')).toBe(false);
  });

  it('NEGATIVE CONTROL: a card that is already verified shows no button', async () => {
    serve({ 'answer:card': { body: { ...CARD, verified: { id: 'v1', question: 'Revenue by region', by: 'priya@x', at: NOW } } } });
    const dock = await openDock();
    await within(dock).findByText(/Verified · priya@x/);
    expect(within(dock).getByRole('button', { name: 'Save as visual' })).toBeTruthy();
    expect(within(dock).queryByRole('button', { name: 'Save as verified' })).toBeNull();
  });

  it('NEGATIVE CONTROL: a viewer is offered none', async () => {
    serve({}, 'viewer');
    const dock = await openDock();
    await waitFor(() => expect(within(dock).getByRole('button', { name: 'Show table' })).toBeTruthy());
    expect(within(dock).queryByRole('button', { name: 'Save as verified' })).toBeNull();
  });
});
