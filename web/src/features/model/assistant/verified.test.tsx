// The Data model's Assistant tab: its verified questions (semantic part 3 D7). Each row is the server's words —
// the question, what it draws, who verified it and when, or why it no longer runs. An editor edits one in place
// (`verified:save` with `id` and `base`) or deletes it behind the house confirm; a viewer only reads.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../../test-utils';
import type { VerifiedRow } from './api';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const V1 = '3c6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const V2 = '4c6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const LAZY = { timeout: 15_000 };
const SPEC = { datasetId: D, category: 'region', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [{ column: 'region', op: 'in', values: ['West', 'East'] }], chartType: 'column', title: 'Revenue by region' };
const GONE = '“segment” is no longer a column of Orders.';

const row = (id: string, question: string, more: Partial<VerifiedRow> = {}): VerifiedRow => ({
  id, question, phrasings: [], datasetId: D, datasetName: 'Orders', describe: 'sum of amount by region', filters: [], spec: { ...SPEC, title: question },
  verifiedBy: 'priya@acme.test', verifiedAt: '2026-10-12T10:00:00Z', runs: true, tag: `tag-${id}`, ...more,
});
const WORKS = row(V1, 'Revenue by region', { phrasings: ['Sales per region'], note: 'Net of refunds', filters: ['region in West, East'] });
const BROKEN = row(V2, 'Revenue by segment', { describe: 'sum of amount by segment', runs: false, problem: GONE });

function serve(routes: Record<string, RpcReply> = {}, role: 'editor' | 'viewer' = 'editor', questions: VerifiedRow[] = [WORKS, BROKEN]) {
  const body = (b: unknown) => ({ body: b });
  return serveRpc({
    '/api/auth/me': body({ user: { email: 'pat@acme.test', role: 'member' }, org: 'acme', mode: 'oidc', canSignOut: true }),
    'projects:list': body([{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }]),
    'projects:overview': body([{ id: P, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false }]),
    'projects:roles': body({ [P]: role }),
    'catalog:instructions': body({ ok: true, instructions: [] }),
    'verified:list': body({ ok: true, broken: questions.filter((q) => !q.runs).length, questions }),
    ...routes,
  });
}
const section = () => screen.findByRole('region', { name: 'Verified questions' }, LAZY);
const rows = async () => within(await screen.findByRole('list', { name: 'Verified questions' }, LAZY)).getAllByRole('listitem');
const sent = (calls: { channel: string; payload: unknown }[], channel: string) => calls.filter((c) => c.channel === channel).map((c) => c.payload);

describe('The Data model: verified questions', () => {
  it('two rows, one broken: the count, "1 no longer runs", what each draws, who and when, and why the broken one stopped', async () => {
    serve();
    renderApp(`/model/${P}?tab=assistant`);
    const s = await section();
    const [works, broken] = await rows();
    expect(within(s).getByText('1 no longer runs')).toBeTruthy();
    expect(within(works).getByText('Revenue by region')).toBeTruthy();
    expect(works.textContent).toContain('Orders · sum of amount by region · region in West, East');
    expect(works.textContent).toContain('Also asked as “Sales per region”');
    expect(works.textContent).toContain('Net of refunds');
    expect(within(works).getByText('✓ priya@acme.test · Oct 12')).toBeTruthy();
    expect(within(broken).getByText(GONE)).toBeTruthy();
    expect(within(broken).queryByText(/^✓/)).toBeNull();
  }, 30_000); // the first test pays for the lazy route chunk's transform

  it('Edit sends verified:save with the id, the tag as base and the spec it holds; a stale tag says someone else changed it', async () => {
    const saved = { ok: true, question: { ...WORKS, note: 'Gross', tag: 'tag-next' } };
    let n = 0;
    const calls = serve({ 'verified:save': () => (n++ ? { status: 409, body: { code: 'record_changed', message: 'stale' } } : { body: saved }) });
    renderApp(`/model/${P}?tab=assistant`);
    const [works] = await rows();
    fireEvent.click(within(works).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit verified question' });
    expect((within(dialog).getByRole('textbox', { name: 'Question' }) as HTMLInputElement).value).toBe('Revenue by region');
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Other ways people ask it' }), { target: { value: 'Sales per region\n\nRevenue per region ' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Note' }), { target: { value: 'Gross' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent(calls, 'verified:save')).toEqual([
      { projectId: P, id: V1, base: `tag-${V1}`, input: { question: 'Revenue by region', phrasings: ['Sales per region', 'Revenue per region'], note: 'Gross', spec: WORKS.spec } },
    ]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(within((await rows())[0]).getByRole('button', { name: 'Edit' }));
    const again = await screen.findByRole('dialog', { name: 'Edit verified question' });
    fireEvent.click(within(again).getByRole('button', { name: 'Save' }));
    expect(await within(again).findByText('Someone else changed this question. Reload to see it.')).toBeTruthy();
  });

  it('a refusal shows the server\'s sentence beside its box, and keeps what was typed', async () => {
    serve({ 'verified:save': { body: { ok: false, error: '“Sales” is already a verified question or one of its phrasings.', field: 'phrasings' } } });
    renderApp(`/model/${P}?tab=assistant`);
    fireEvent.click(within((await rows())[0]).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit verified question' });
    const box = within(dialog).getByRole('textbox', { name: 'Other ways people ask it' }) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'Sales' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('“Sales” is already a verified question or one of its phrasings.')).toBeTruthy();
    expect(box.value).toBe('Sales');
    expect(box.getAttribute('aria-invalid')).toBe('true');
  });

  it('Delete asks first: Keep it sends nothing; Delete sends verified:delete', async () => {
    const calls = serve({ 'verified:delete': { body: { ok: true } } });
    renderApp(`/model/${P}?tab=assistant`);
    const [, broken] = await rows();
    expect(within(broken).queryByRole('button', { name: 'Edit' })).toBeNull(); // a spec that no longer runs cannot be saved again
    fireEvent.click(within(broken).getByRole('button', { name: 'Delete' }));
    const ask = await screen.findByRole('dialog', { name: 'Delete this verified question?' });
    expect(ask.textContent).toContain('Revenue by segment');
    fireEvent.click(within(ask).getByRole('button', { name: 'Keep it' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sent(calls, 'verified:delete')).toEqual([]);
    fireEvent.click(within(broken).getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Delete this verified question?' })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(sent(calls, 'verified:delete')).toEqual([{ projectId: P, id: V2 }]));
  });

  it('NEGATIVE CONTROL: a viewer reads the rows and gets no Edit or Delete', async () => {
    const calls = serve({}, 'viewer');
    renderApp(`/model/${P}?tab=assistant`);
    const s = await section();
    await waitFor(() => expect(calls.some((c) => c.channel === 'projects:roles')).toBe(true));
    expect(await rows()).toHaveLength(2);
    expect(within(s).queryAllByRole('button')).toEqual([]);
  });

  it('a hidden row (no spec) reads its question and the server\'s "values hidden" words, and offers no Edit', async () => {
    const { spec: _s, ...hidden } = row(V1, 'West customers', { filters: ['customer · values hidden by row access rules'] });
    serve({}, 'editor', [hidden]);
    renderApp(`/model/${P}?tab=assistant`);
    const [only] = await rows();
    expect(within(only).getByText('West customers')).toBeTruthy();
    expect(only.textContent).toContain('customer · values hidden by row access rules');
    expect(within(only).queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('none yet: the empty state says what a verified question is', async () => {
    serve({}, 'editor', []);
    renderApp(`/model/${P}?tab=assistant`);
    expect(await screen.findByRole('heading', { name: 'No verified questions yet' }, LAZY)).toBeTruthy();
    expect((await section()).textContent).toContain('A verified question is answered the team’s way every time, by the app, without a model.');
  });

  it('an old server without verified:list shows its error state, the instructions still draw, and Retry asks again', async () => {
    const calls = serve({ 'verified:list': { status: 404, body: { error: 'not_found', message: 'Unknown channel' } } });
    renderApp(`/model/${P}?tab=assistant`);
    const alert = await within(await section()).findByRole('alert', {}, LAZY);
    expect(alert.textContent).toContain('The verified questions could not be loaded');
    expect(await screen.findByRole('heading', { name: 'No instructions yet' })).toBeTruthy();
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(calls.filter((c) => c.channel === 'verified:list')).toHaveLength(2));
  });
});
