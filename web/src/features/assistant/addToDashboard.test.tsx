// An editor's "Add to dashboard" on an answer card (./AddToDashboard, docs/assistant/00-design.md step 8): offered on a
// chart answer to a member who may edit, never to a viewer or on a warehouse table's answer; the dialog lists the
// dashboards the server says they edit (loading, none, a failed list), sends the spec and the dashboard — or a new one's
// name — and nothing else, shows the server's refusal and keeps the dialog, and once added the card says where, with Open.

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { serveRpc, type RpcReply } from '../../test-utils';
import { AnswerCard, type Card } from './AnswerCard';
import { AddToDashboard } from './AddToDashboard';

const canEdit = vi.hoisted(() => ({ value: true }));
vi.mock('../../charts/Chart', () => ({ Chart: ({ label }: { label?: string }) => <div role="img" aria-label={label ?? 'Chart'} /> }));
vi.mock('../projects/api', () => ({ useCanEdit: () => canEdit.value, useRoles: () => ({ data: undefined }) }));
vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  canEdit.value = true;
});

const P = '11111111-1111-4111-8111-111111111111';
const DS = '22222222-2222-4222-8222-222222222222';
const BOARD = '33333333-3333-4333-8333-333333333333';
const NEW_BOARD = '44444444-4444-4444-8444-444444444444';
const SPEC = { datasetId: DS, category: 'region', measures: [{ column: 'net_sales', aggregation: 'sum' }], filters: [], chartType: 'column', title: 'Sales by region' };
const CARD: Card = {
  ok: true, title: 'Sales by region', chartType: 'column', datasetName: 'Orders',
  data: { labels: ['West', 'East'], series: [{ name: 'sum of net_sales', values: [1234.6, 1444] }] }, caption: '',
  headline: [], bullets: [], chips: [], filterLabels: [], notes: [],
};
const BOARDS = { body: [{ id: BOARD, name: 'Sales board' }] };

function mount(ui: React.ReactNode, routes: Record<string, RpcReply> = {}) {
  const calls = serveRpc({ 'stats:dashboards': BOARDS, ...routes });
  render(<MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider></MemoryRouter>);
  return calls;
}
const button = <AddToDashboard projectId={P} spec={SPEC} />;
async function openDialog() {
  fireEvent.click(screen.getByRole('button', { name: 'Add to dashboard' }));
  return screen.findByRole('dialog', { name: 'Add to dashboard' });
}

describe('on the answer card', () => {
  it('an editor is offered it on a chart answer', () => {
    mount(<AnswerCard projectId={P} spec={SPEC} card={CARD} narrated={false} onFollowUp={async () => {}} />);
    expect(screen.getByRole('button', { name: 'Add to dashboard' })).toBeTruthy();
  });

  it('a viewer is not, and neither is a warehouse table\'s answer (Keep as a dataset first)', () => {
    canEdit.value = false;
    mount(<AnswerCard projectId={P} spec={SPEC} card={CARD} narrated={false} onFollowUp={async () => {}} />);
    expect(screen.queryByRole('button', { name: 'Add to dashboard' })).toBeNull();
    cleanup();
    canEdit.value = true;
    mount(<AnswerCard projectId={P} spec={{ ...SPEC, table: BOARD }} card={CARD} turn={{ threadId: NEW_BOARD, turnId: 't1' }} narrated={false} onFollowUp={async () => {}} />);
    expect(screen.queryByRole('button', { name: 'Add to dashboard' })).toBeNull();
  });
});

describe('the dialog', () => {
  it('waits for the list, picks the first dashboard the server lists, sends the spec and its id, and says where it went', async () => {
    const calls = mount(button, { 'answer:addToDashboard': { body: { ok: true, dashboard: { id: BOARD, name: 'Sales board' }, visual: { id: DS, name: 'Sales by region' } } } });
    const served = globalThis.fetch;
    let list: () => void = () => {};
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => (url.endsWith('stats:dashboards') ? new Promise<Response>((r) => (list = () => r(new Response(JSON.stringify(BOARDS.body))))) : served(url, init))));
    const dialog = await openDialog();
    const pick = within(dialog).getByRole('combobox', { name: 'Dashboard' });
    expect(pick.getAttribute('aria-disabled') === 'true' || (pick as HTMLButtonElement).disabled).toBe(true);
    expect((within(dialog).getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true);
    list();
    await waitFor(() => expect(pick.textContent).toContain('Sales board'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'answer:addToDashboard')?.payload).toEqual({ projectId: P, spec: SPEC, analysisId: BOARD }));
    expect((await screen.findByTestId('answer-added')).textContent).toBe('Added to Sales board');
    expect(screen.getByRole('link', { name: 'Open' }).getAttribute('href')).toBe(`/analyses/${P}/${BOARD}`);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add to dashboard' })).toBeNull(); // added: not twice from here
  });

  it('a new dashboard: picked from the list, named, the name trimmed', async () => {
    const calls = mount(button, { 'answer:addToDashboard': { body: { ok: true, dashboard: { id: NEW_BOARD, name: 'Q4 review' }, visual: { id: DS, name: 'x' } } } });
    const dialog = await openDialog();
    const pick = within(dialog).getByRole('combobox', { name: 'Dashboard' });
    await waitFor(() => expect(pick.textContent).toContain('Sales board'));
    fireEvent.click(pick);
    fireEvent.click(screen.getByRole('option', { name: 'New dashboard…' }));
    const name = within(dialog).getByRole('textbox', { name: 'Name the dashboard' }) as HTMLInputElement;
    expect(name.placeholder).toBe('Sales by region');
    fireEvent.change(name, { target: { value: '  Q4 review ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'answer:addToDashboard')?.payload).toEqual({ projectId: P, spec: SPEC, name: 'Q4 review' }));
    expect((await screen.findByTestId('answer-added')).textContent).toBe('Added to Q4 review');
  });

  it('none to edit: says so, and makes a new one — unnamed, the server names it', async () => {
    const calls = mount(button, { 'stats:dashboards': { body: [] }, 'answer:addToDashboard': { body: { ok: true, dashboard: { id: NEW_BOARD, name: 'Sales by region' }, visual: { id: DS, name: 'x' } } } });
    const dialog = await openDialog();
    expect(await within(dialog).findByText('No dashboard you can edit yet: this makes a new one.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'answer:addToDashboard')?.payload).toEqual({ projectId: P, spec: SPEC }));
  });

  it('a refusal: the server\'s sentence, the dialog kept; adding again works', async () => {
    let n = 0;
    const refusal = 'You can only view this folder.';
    const calls = mount(button, {
      'answer:addToDashboard': () => (n++ === 0 ? { body: { ok: false, reason: refusal } } : { body: { ok: true, dashboard: { id: BOARD, name: 'Sales board' }, visual: { id: DS, name: 'x' } } }),
    });
    const dialog = await openDialog();
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: 'Dashboard' }).textContent).toContain('Sales board'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect((await within(dialog).findByTestId('add-problem')).textContent).toBe(refusal);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add' }));
    expect(await screen.findByTestId('answer-added')).toBeTruthy();
    expect(calls.filter((c) => c.channel === 'answer:addToDashboard')).toHaveLength(2);
  });

  it('a failed list says so and still offers a new dashboard', async () => {
    mount(button, { 'stats:dashboards': { status: 500, body: { error: 'Boom' } } });
    const dialog = await openDialog();
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Could not list your dashboards. You can still add it to a new one.');
    expect(within(dialog).getByRole('textbox', { name: 'Name the dashboard' })).toBeTruthy();
    expect((within(dialog).getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('Cancel sends nothing', async () => {
    const calls = mount(button);
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.filter((c) => c.channel === 'answer:addToDashboard')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Add to dashboard' })).toBeTruthy();
  });
});

it('wears the theme\'s tokens only — the added line and the refusal (AskEditor.module.css) are coloured for light AND dark', () => {
  const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
  const theme = read('../../theme.css');
  const at = theme.search(/^\[data-theme="dark"\]/m);
  const [light, dark] = [theme.slice(0, at), theme.slice(at)];
  const css = read('./AskEditor.module.css');
  const block = (from: string): string => css.slice(css.indexOf(from), css.indexOf('}', css.indexOf(from)));
  const ours = [block('.sent {'), block('.error {\n  background')].join('\n');
  const used = [...new Set([...ours.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]))];
  expect(used).toEqual(expect.arrayContaining(['--ok-text', '--error-soft', '--error-text']));
  for (const token of ['--ok-text', '--error-soft', '--error-text']) {
    expect(light.includes(`${token}:`), `${token} is a theme token`).toBe(true);
    expect(dark.includes(`${token}:`), `${token} has a dark value`).toBe(true);
  }
  expect(ours).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
});
