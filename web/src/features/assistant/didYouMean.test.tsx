// "Did you mean", "Save as visual" and "Remember" — the ways an answer stops
// being a dead end, a throwaway, or a correction made again next time. The row
// on its own (options, a click, nothing when there are none, text only), then
// through the real dock: under a refused reply, in an answer card with no rows,
// and the card's Save and Remember buttons for each role and each outcome.
// Every option, every figure and whether a name is known is the server's.

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { renderApp } from '../../test-utils';
import { DidYouMean } from './DidYouMean';
import { setDockOpen } from './dockState';

// Chart.js needs a canvas jsdom does not have; what the card does around the chart is what is under test.
vi.mock('../../charts/Chart', () => ({ Chart: ({ label }: { label?: string }) => <div role="img" aria-label={label ?? 'Chart'} /> }));

afterEach(() => {
  act(() => setDockOpen(false));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PID = '11111111-1111-4111-8111-111111111111';
const DID = '22222222-2222-4222-8222-222222222222';
const TID = '33333333-3333-4333-8333-333333333333';
const VID = '44444444-4444-4444-8444-444444444444';
const ME = { user: { email: 'eve@acme.test', role: 'editor' }, org: 'acme', mode: 'oidc', canSignOut: true };

/** A route answers with a body, or with what a function of the payload returns — a promise to hold a reply open. */
type Route = unknown;
function serve(routes: Record<string, Route>) {
  const calls: { channel: string; payload: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split('?')[0];
      const channel = path.startsWith('/api/rpc/') ? decodeURIComponent(path.slice('/api/rpc/'.length)) : path;
      const payload = init?.body ? (JSON.parse(String(init.body)) as { args: unknown[] }).args[0] : undefined;
      if (path.startsWith('/api/rpc/')) calls.push({ channel, payload });
      const r = channel in routes ? routes[channel] : [];
      const body = typeof r === 'function' ? await (r as (p: unknown) => unknown)(payload) : r;
      return new Response(JSON.stringify(body ?? null), { status: 200 });
    }),
  );
  return calls;
}

const SPEC = { datasetId: DID, category: 'region', measures: [{ column: 'net_sales', aggregation: 'sum' }], filters: [], chartType: 'column', title: 'Sales by region' };
const TAX = { ...SPEC, measures: [{ column: 'sales_tax', aggregation: 'sum' }] };
const CARD = {
  ok: true, spec: SPEC, title: 'Sales by region', chartType: 'column', datasetName: 'Orders',
  data: { labels: ['West', 'East'], series: [{ name: 'sum of net_sales', values: [3, 2] }] }, caption: 'West leads.',
  headline: [{ label: 'Total net_sales', value: 5, display: '5' }], bullets: ['West is highest at 3.'], chips: [], filterLabels: [], steps: [], notes: [],
};
const user = (id: string, text: string) => ({ id, role: 'user', text, createdAt: '' });
const REFUSED = {
  id: 'a1', role: 'assistant', text: 'Here it is.\n\n(No chart: Unknown measure column "sales".)', createdAt: '',
  suggest: { part: 'measure', said: 'sales', options: [{ label: 'net_sales', spec: SPEC }, { label: 'Sales Tax', spec: TAX }] },
};
const ANSWERED = { id: 'a2', role: 'assistant', text: '', createdAt: '', answer: SPEC };

const shell = (turns: unknown[], role = 'editor'): Record<string, Route> => ({
  '/api/auth/me': ME,
  'projects:list': [{ id: PID, name: 'Ledger', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }],
  'projects:roles': { [PID]: role },
  'ai:status': { ready: true, models: [{ provider: 'anthropic', model: 'm', label: 'M', isDefault: true }], mine: { provider: 'anthropic', model: 'm' }, copilotEnabled: true, keyStore: null },
  'copilot:history': { ok: true, turns, threadId: TID },
  'dataset:list': [{ id: DID, name: 'Orders' }],
  'answer:card': CARD,
});

async function openDock(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: 'Assistant' }));
  await screen.findByRole('textbox', { name: 'Ask the Assistant' });
  return document.getElementById('dock-panel') as HTMLElement;
}

describe('the "Did you mean" row', () => {
  it('offers one chip per option, in order; a click hands back that option and holds the row until it settles', async () => {
    let settle = (): void => undefined;
    const onPick = vi.fn(() => new Promise<void>((r) => (settle = r)));
    render(<DidYouMean options={REFUSED.suggest.options} said="sales" onPick={onPick} />);
    const row = screen.getByRole('group', { name: 'Did you mean, instead of sales' });
    expect(within(row).getByText('Did you mean')).toBeTruthy();
    const chips = within(row).getAllByRole('button');
    expect(chips.map((b) => b.textContent)).toEqual(['net_sales', 'Sales Tax']);
    expect(chips[1].getAttribute('title')).toBe('Use Sales Tax instead of “sales”');
    fireEvent.click(chips[1]);
    expect(onPick).toHaveBeenCalledWith(TAX, 'Sales Tax', undefined); // no column on the option: no name to remember
    expect(chips.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(chips[1].getAttribute('aria-busy')).toBe('true');
    await act(async () => settle());
    await waitFor(() => expect((chips[0] as HTMLButtonElement).disabled).toBe(false));
  });

  it('is nothing at all when there is nothing to offer', () => {
    const { container } = render(<DidYouMean options={[]} said="sales" onPick={vi.fn(async () => undefined)} />);
    expect(container.innerHTML).toBe('');
  });

  it('shows what the model said and each label as TEXT — markup is never HTML', () => {
    const said = '<img src=x onerror="alert(1)">';
    const { container } = render(<DidYouMean options={[{ label: '<b>net</b>', spec: SPEC }]} said={said} onPick={vi.fn(async () => undefined)} />);
    expect(container.querySelector('img, b')).toBeNull();
    expect(screen.getByRole('button').textContent).toBe('<b>net</b>');
    expect(screen.getByRole('group').getAttribute('aria-label')).toBe(`Did you mean, instead of ${said}`);
  });

  it('wears the theme’s tokens only — every colour it uses is defined for light AND dark, none written in', () => {
    const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
    const theme = read('../../theme.css');
    const at = theme.indexOf('[data-theme="dark"] {');
    const [light, dark] = [theme.slice(0, at), theme.slice(at)];
    const css = read('./DidYouMean.module.css');
    const card = read('./AnswerCard.module.css');
    const ours = css + card.slice(card.indexOf('.noMatch {'), card.indexOf('.caption {')) + card.slice(card.indexOf('.saveError {'));
    const used = [...new Set([...ours.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]))];
    expect(used.length).toBeGreaterThan(10);
    for (const token of used) expect(light.includes(`${token}:`), `${token} is a theme token`).toBe(true);
    const colours = ['--accent', '--accent-soft', '--accent-line', '--muted', '--error', '--inset', '--text', '--focus-ring'].filter((t) => used.includes(t));
    expect(colours.length).toBe(8);
    for (const token of colours) expect(dark.includes(`${token}:`), `${token} has a dark value`).toBe(true);
    expect(ours).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });
});

describe('in the dock', () => {
  it('under a refused reply: the server’s options; a click reruns that option and the answer turn appears', async () => {
    // The conversation as the server holds it: the rerun appends to it, so a refetch reads it back.
    let turns: unknown[] = [user('u1', 'sales by region'), REFUSED];
    const calls = serve({
      ...shell(turns),
      'copilot:history': () => ({ ok: true, turns, threadId: TID }),
      'answer:rerun': () => {
        turns = [...turns, user('u2', 'net_sales'), ANSWERED];
        return { ok: true, threadId: TID, turns };
      },
    });
    renderApp('/');
    const dock = await openDock();
    const row = await within(dock).findByRole('group', { name: 'Did you mean, instead of sales' });
    expect(within(row).getAllByRole('button').map((b) => b.textContent)).toEqual(['net_sales', 'Sales Tax']);
    fireEvent.click(within(row).getByRole('button', { name: 'net_sales' }));
    await within(dock).findByTestId('answer-card');
    expect(calls.find((c) => c.channel === 'answer:rerun')?.payload).toEqual({ projectId: PID, threadId: TID, spec: SPEC, label: 'net_sales' });
    expect(within(dock).getByText('Sales by region')).toBeTruthy();
  });

  it('offers nothing under a reply that carries no options (negative control)', async () => {
    serve(shell([user('u1', 'sales by region'), { ...REFUSED, suggest: undefined }]));
    renderApp('/');
    const dock = await openDock();
    await within(dock).findByText(/Unknown measure column "sales"/);
    expect(within(dock).queryByTestId('did-you-mean')).toBeNull();
  });

  it('an answer with no rows: the server’s sentence and its options where the chart would be — no table, no save', async () => {
    const west = { ...SPEC, filters: [{ column: 'region', op: '=', value: 'West' }] };
    const east = { ...SPEC, filters: [{ column: 'region', op: '=', value: 'East' }] };
    const turns = [user('u1', 'sales in est'), ANSWERED];
    const calls = serve({
      ...shell(turns),
      'answer:card': {
        ...CARD, data: { labels: [], series: [] }, headline: [], caption: 'No data to summarize', bullets: ['No rows match this question, so there is nothing to chart.'],
        noMatch: { text: 'No rows match region = "est".', options: [{ label: 'West', spec: west }, { label: 'East', spec: east }] },
      },
      'answer:rerun': { ok: true, threadId: TID, turns },
    });
    renderApp('/');
    const dock = await openDock();
    const empty = await within(dock).findByTestId('answer-no-match');
    expect(within(empty).getByText('No rows match region = "est".')).toBeTruthy();
    const card = within(dock).getByTestId('answer-card');
    expect(within(card).queryByRole('img')).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Show table' })).toBeNull();
    expect(within(card).queryByRole('button', { name: 'Save as visual' })).toBeNull();
    expect(within(card).queryByText(/nothing to chart|No data to summarize/)).toBeNull();
    fireEvent.click(within(empty).getByRole('button', { name: 'East' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'answer:rerun')?.payload).toEqual({ projectId: PID, threadId: TID, spec: east, label: 'East' }));
  });
});

describe('Save as visual', () => {
  it('is not offered to a viewer — the card is drawn, the button is not there', async () => {
    serve(shell([user('u1', 'sales by region'), ANSWERED], 'viewer'));
    renderApp('/');
    const dock = await openDock();
    const card = await within(dock).findByTestId('answer-card');
    await within(card).findByRole('button', { name: 'Show table' });
    expect(within(card).queryByRole('button', { name: 'Save as visual' })).toBeNull();
  });

  it('saves the stored spec and nothing else, says it is saving, then becomes a link to the visual', async () => {
    let reply = (_: unknown): void => undefined;
    const calls = serve({
      ...shell([user('u1', 'sales by region'), ANSWERED]),
      'answer:saveVisual': () => new Promise((r) => (reply = r)),
    });
    renderApp('/');
    const dock = await openDock();
    const card = await within(dock).findByTestId('answer-card');
    fireEvent.click(await within(card).findByRole('button', { name: 'Save as visual' }));
    const busy = await within(card).findByRole('button', { name: 'Saving…' });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    // The spec, and which turn it is — so the server records the visual there. Never steps or an encoding.
    expect(calls.find((c) => c.channel === 'answer:saveVisual')?.payload).toEqual({ projectId: PID, spec: SPEC, threadId: TID, turnId: 'a2' });
    await act(async () => reply({ ok: true, visual: { id: VID, name: 'Sales by region' } }));
    const link = await within(card).findByRole('link', { name: 'Open in Visuals' });
    expect(link.getAttribute('href')).toBe(`/visuals/${PID}/${VID}`);
    expect(document.activeElement).toBe(link); // the focus the button had goes to what replaced it
    expect(within(card).queryByRole('button', { name: /Save as visual|Saving/ })).toBeNull();
  });

  it('remembers the save when the dock is closed and opened again — the same answer is never offered twice', async () => {
    const calls = serve({ ...shell([user('u1', 'sales by region'), ANSWERED]), 'answer:saveVisual': { ok: true, visual: { id: VID, name: 'Sales by region' } } });
    renderApp('/');
    let card = await within(await openDock()).findByTestId('answer-card');
    fireEvent.click(await within(card).findByRole('button', { name: 'Save as visual' }));
    await within(card).findByRole('link', { name: 'Open in Visuals' });
    act(() => setDockOpen(false));
    expect(screen.queryByTestId('answer-card')).toBeNull(); // closed: every card unmounted
    card = await within(await openDock()).findByTestId('answer-card');
    const link = await within(card).findByRole('link', { name: 'Open in Visuals' });
    expect(link.getAttribute('href')).toBe(`/visuals/${PID}/${VID}`);
    expect(document.activeElement).not.toBe(link); // a remount does not take the focus
    expect(within(card).queryByRole('button', { name: 'Save as visual' })).toBeNull();
    expect(calls.filter((c) => c.channel === 'answer:saveVisual')).toHaveLength(1);
  });

  it('after a reload, an answer the turn records as saved links to its visual — no second save offered', async () => {
    const calls = serve(shell([user('u1', 'sales by region'), { ...ANSWERED, savedVisualId: VID }]));
    renderApp('/');
    const card = await within(await openDock()).findByTestId('answer-card');
    const link = await within(card).findByRole('link', { name: 'Open in Visuals' });
    expect(link.getAttribute('href')).toBe(`/visuals/${PID}/${VID}`);
    expect(within(card).queryByRole('button', { name: 'Save as visual' })).toBeNull();
    expect(calls.filter((c) => c.channel === 'answer:saveVisual')).toHaveLength(0);
  });

  it('a refusal says why, and the button stays to try again', async () => {
    const replies = [{ ok: false, reason: '"territory" is no longer a column of Orders.' }, { ok: true, visual: { id: VID, name: 'Sales by region' } }];
    serve({ ...shell([user('u1', 'sales by region'), ANSWERED]), 'answer:saveVisual': () => replies.shift() });
    renderApp('/');
    const dock = await openDock();
    const card = await within(dock).findByTestId('answer-card');
    fireEvent.click(await within(card).findByRole('button', { name: 'Save as visual' }));
    expect((await within(card).findByRole('alert')).textContent).toBe('"territory" is no longer a column of Orders.');
    fireEvent.click(within(card).getByRole('button', { name: 'Save as visual' }));
    await within(card).findByRole('link', { name: 'Open in Visuals' });
    expect(within(card).queryByRole('alert')).toBeNull();
  });
});

describe('Remember a name', () => {
  const LEARN = { said: 'sales', column: 'net_sales' };
  const TAUGHT = { ...ANSWERED, learn: LEARN };
  /** The card as the server draws it: offered until the name is added, known after. */
  const remembering = (role = 'editor', addAlias: (p: unknown) => unknown = () => ({ ok: true })) => {
    let known = false;
    return serve({
      ...shell([user('u1', 'Net Sales'), TAUGHT], role),
      'answer:card': () => ({ ...CARD, learn: { ...LEARN, label: 'Net Sales', state: known ? 'known' : 'offer' } }),
      'catalog:addAlias': async (p: unknown) => {
        const r = (await addAlias(p)) as { ok: boolean };
        known = r.ok;
        return r;
      },
    });
  };

  it('a "Did you mean" column sends what was said and the column picked; a dataset’s option sends no name', async () => {
    const named = { ...REFUSED, suggest: { ...REFUSED.suggest, options: [{ label: 'Net Sales', spec: SPEC, column: 'net_sales' }, { label: 'Orders', spec: TAX }] } };
    const calls = serve({ ...shell([user('u1', 'sales by region'), named]), 'answer:rerun': { ok: true, threadId: TID, turns: [user('u1', 'sales by region'), named] } });
    renderApp('/');
    const row = await within(await openDock()).findByRole('group', { name: 'Did you mean, instead of sales' });
    fireEvent.click(within(row).getByRole('button', { name: 'Net Sales' }));
    await waitFor(() => expect(calls.filter((c) => c.channel === 'answer:rerun')).toHaveLength(1));
    fireEvent.click(within(row).getByRole('button', { name: 'Orders' }));
    await waitFor(() => expect(calls.filter((c) => c.channel === 'answer:rerun')).toHaveLength(2));
    const [first, second] = calls.filter((c) => c.channel === 'answer:rerun').map((c) => c.payload);
    expect(first).toEqual({ projectId: PID, threadId: TID, spec: SPEC, label: 'Net Sales', learn: LEARN });
    expect(second).toEqual({ projectId: PID, threadId: TID, spec: TAX, label: 'Orders' });
  });

  it('an editor is offered it; remembering sends ONE name, says so while it saves, then the card says it is known', async () => {
    let reply = (_: unknown): void => undefined;
    const calls = remembering('editor', () => new Promise((r) => (reply = r)));
    renderApp('/');
    const card = await within(await openDock()).findByTestId('answer-card');
    expect(calls.find((c) => c.channel === 'answer:card')?.payload).toEqual({ projectId: PID, spec: SPEC, learn: LEARN });
    fireEvent.click(await within(card).findByRole('button', { name: 'Remember “sales” as Net Sales' }));
    const busy = await within(card).findByRole('button', { name: 'Remembering…' });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(calls.find((c) => c.channel === 'catalog:addAlias')?.payload).toEqual({ projectId: PID, datasetId: DID, column: 'net_sales', alias: 'sales' });
    await act(async () => reply({ ok: true }));
    const known = await within(card).findByText(/now means/);
    expect(known.textContent).toBe('“sales” now means Net Sales in this project.');
    expect(known.getAttribute('role')).toBe('status');
    expect(within(card).queryByRole('button', { name: /Remember/ })).toBeNull();
    expect(calls.filter((c) => c.channel === 'catalog:addAlias')).toHaveLength(1);
  });

  it('a viewer is not offered it', async () => {
    serve({ ...shell([user('u1', 'Net Sales'), TAUGHT], 'viewer'), 'answer:card': { ...CARD, learn: { ...LEARN, label: 'Net Sales', state: 'offer' } } });
    renderApp('/');
    const card = await within(await openDock()).findByTestId('answer-card');
    await within(card).findByRole('button', { name: 'Show table' });
    expect(within(card).queryByRole('button', { name: /Remember/ })).toBeNull();
  });

  it('a known name is read by anyone — viewer included', async () => {
    serve({ ...shell([user('u1', 'Net Sales'), TAUGHT], 'viewer'), 'answer:card': { ...CARD, learn: { ...LEARN, label: 'Net Sales', state: 'known' } } });
    renderApp('/');
    const card = await within(await openDock()).findByTestId('answer-card');
    expect((await within(card).findByText(/now means/)).textContent).toBe('“sales” now means Net Sales in this project.');
  });

  it('a refusal says why in the server’s words, and the button stays to try again', async () => {
    remembering('editor', () => ({ ok: false, error: 'Net Sales already has 8 other names.' }));
    renderApp('/');
    const card = await within(await openDock()).findByTestId('answer-card');
    fireEvent.click(await within(card).findByRole('button', { name: 'Remember “sales” as Net Sales' }));
    expect((await within(card).findByRole('alert')).textContent).toBe('Net Sales already has 8 other names.');
    expect(within(card).getByRole('button', { name: 'Remember “sales” as Net Sales' })).toBeTruthy();
  });
});
