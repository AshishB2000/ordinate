// Dashboard requests on the web (docs/team-folders/00-design.md, "Dashboard requests"): a VIEWER's "Request a
// dashboard" on an answer (an editor never sees it), the bell's rows for an approver and for the viewer who asked, and
// the review page — the server's charts and its list of what approving makes, Approve and publish, Edit, Decline with a
// note, and a refusal in the server's words. The server's side is scripts/test-dashboardRequests.ts.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderApp, serveRpc, type RpcReply } from '../../../test-utils';
import { RequestDashboard } from '../../assistant/RequestDashboard';

vi.setConfig({ testTimeout: 30_000 });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const T = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const A1 = '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const A2 = '3b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const R = '4b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '5b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const ANSWERS = [{ turnId: A1, title: 'Sales by region' }, { turnId: A2, title: 'Returns by reason' }];

function answer(role: 'viewer' | 'editor', routes: Record<string, RpcReply> = {}) {
  const calls = serveRpc({ 'projects:roles': { body: { [P]: role } }, ...routes });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RequestDashboard projectId={P} turn={{ threadId: T, turnId: A2 }} answers={ANSWERS} />
    </QueryClientProvider>,
  );
  return calls;
}

describe('Request a dashboard (a viewer, on an answer)', () => {
  it('names it after this answer, offers the conversation\'s charts with this one ticked, and sends the picked ones in order with the note', async () => {
    const calls = answer('viewer', { 'request:create': { body: { ok: true, id: R } } });
    fireEvent.click(await screen.findByRole('button', { name: 'Request a dashboard' }));
    const dialog = await screen.findByRole('dialog', { name: 'Request a dashboard' });
    expect((within(dialog).getByRole('textbox', { name: 'Dashboard name' }) as HTMLInputElement).value).toBe('Returns by reason');
    expect((within(dialog).getByRole('checkbox', { name: 'Returns by reason' }) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByRole('checkbox', { name: 'Sales by region' }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Sales by region' }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Dashboard name' }), { target: { value: 'Returns Q4' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Note (optional)' }), { target: { value: ' For the review ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'request:create')?.payload).toEqual({ projectId: P, threadId: T, turnIds: [A1, A2], title: 'Returns Q4', note: 'For the review' }));
    expect((await screen.findByTestId('request-sent')).textContent).toBe('Sent to the editors');
  });

  it('no chart ticked: Send is off; the day\'s limit: the server\'s sentence, the dialog kept', async () => {
    const limit = 'You can ask for 10 dashboards a day. Try again tomorrow.';
    answer('viewer', { 'request:create': { body: { ok: false, code: 'rate_limited', error: limit } } });
    fireEvent.click(await screen.findByRole('button', { name: 'Request a dashboard' }));
    const dialog = await screen.findByRole('dialog', { name: 'Request a dashboard' });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Returns by reason' }));
    expect((within(dialog).getByRole('button', { name: 'Send request' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Returns by reason' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(limit);
  });

  it('NEGATIVE CONTROL: an editor is not offered it (Save as visual is theirs)', async () => {
    const calls = answer('editor');
    await waitFor(() => expect(calls.some((c) => c.channel === 'projects:roles')).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: 'Request a dashboard' })).toBeNull();
  });
});

const row = (over: object) => ({ projectId: P, id: R, by: 'Priya Shah', title: 'Returns Q4', note: 'For the review', charts: 2, state: 'open', decidedBy: '', answer: '', dashboardId: null, at: '2026-11-01T10:00:00Z', mine: false, seen: false, ...over });
function shell(requests: unknown[], more: Record<string, RpcReply> = {}) {
  const calls = serveRpc({
    '/api/auth/me': { body: { user: { email: 'ed@acme.test', role: 'viewer' }, org: 'acme', mode: 'header', canSignOut: false, mentionsUnseen: 1 } },
    'projects:list': { body: [{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }] },
    'projects:overview': { body: [{ id: P, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false }] },
    'projects:roles': { body: { [P]: 'editor' } },
    'alerts:list': { body: { ok: true, digest: false, unseen: 0, rules: [], events: [] } },
    'mentions:list': { body: { ok: true, available: true, items: [], asks: [], requests, unseen: 1 } },
    'mentions:seen': { body: { ok: true } },
    ...more,
  });
  return { calls, router: renderApp('/no-such-page') };
}
async function bell() {
  const b = await screen.findByRole('button', { name: /^Notifications/ });
  await waitFor(() => expect(b.hasAttribute('disabled')).toBe(false));
  fireEvent.click(b);
  return screen.findByRole('dialog', { name: 'Notifications' });
}

describe('the bell: Dashboard requests', () => {
  it('an approver\'s row says who asked, for what, with the note; a click marks it seen and opens the review', async () => {
    const { calls, router } = shell([row({})]);
    const inbox = await bell();
    expect(await within(inbox).findByRole('heading', { name: 'Dashboard requests' })).toBeTruthy();
    const r = within(inbox).getByTestId('bell-request');
    expect(r.getAttribute('aria-label')).toBe('Priya Shah asked for a dashboard, new: Returns Q4. Opens Review');
    expect(within(r).getByText('For the review')).toBeTruthy();
    expect(within(r).getByText('2 charts · Sales')).toBeTruthy();
    fireEvent.click(r);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/requests/${P}/${R}`));
    await waitFor(() => expect(calls.some((c) => c.channel === 'mentions:seen' && JSON.stringify(c.payload) === JSON.stringify({ projectId: P, id: R }))).toBe(true));
  });

  it('the viewer\'s own: ready opens the dashboard; declined reads the editor\'s note and goes nowhere', async () => {
    const { router } = shell([row({ id: D, mine: true, state: 'declined', decidedBy: 'Ed', answer: 'We have this already' }), row({ mine: true, state: 'approved', decidedBy: 'Ed', dashboardId: D })]);
    const inbox = await bell();
    const [declined, ready] = await within(inbox).findAllByTestId('bell-request');
    expect(declined.getAttribute('aria-label')).toBe('Your request for Returns Q4 was declined, new: Returns Q4. Marks it seen');
    expect(within(declined).getByText('We have this already')).toBeTruthy();
    expect(ready.getAttribute('aria-label')).toBe('Your dashboard Returns Q4 is ready, new: Returns Q4. Opens Dashboard');
    fireEvent.click(ready);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/dashboards/${P}/${D}`));
  });
});

const CARD = { ok: true, title: 'Sales by region', chartType: 'column', datasetName: 'Orders', data: { labels: ['North', 'South'], series: [{ name: 'Sum of amount', values: [70007.33, 55555.55] }] }, headline: [{ label: 'Total', display: '125,563' }], caption: 'North leads.', notes: [], filterLabels: [] };
const preview = (state = 'open') => ({ ok: true, request: { projectId: P, id: R, by: 'Priya Shah', title: 'Returns Q4', note: 'For the review', charts: 1, state, decidedBy: state === 'open' ? '' : 'Ed', answer: '', dashboardId: state === 'open' ? null : D, at: '2026-11-01T10:00:00Z' }, cards: state === 'open' ? [CARD] : [], creates: state === 'open' ? { visuals: ['Sales by region'], dashboard: 'Returns Q4', folder: 'Ops' } : null });
function review(routes: Record<string, RpcReply>) {
  const calls = serveRpc({ '/api/auth/me': { body: { user: { email: 'ed@acme.test', role: 'viewer' }, org: 'acme', mode: 'header', canSignOut: false, mentionsUnseen: 0 } }, 'projects:list': { body: [{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }] }, 'projects:roles': { body: { [P]: 'editor' } }, ...routes });
  return { calls, router: renderApp(`/requests/${P}/${R}`) };
}

describe('the review page', () => {
  it('draws the server\'s charts and figures, says what approving makes, and Approve and publish opens the dashboard', async () => {
    const { calls, router } = review({ 'request:preview': { body: preview() }, 'request:approve': { body: { ok: true, dashboardId: D, published: true } } });
    expect(await screen.findByRole('heading', { level: 1, name: 'Returns Q4' })).toBeTruthy();
    const card = await screen.findByTestId('request-card');
    expect(within(card).getByText('125,563')).toBeTruthy();
    const makes = screen.getByTestId('request-creates');
    expect(makes.textContent).toContain('A visual: Sales by region');
    expect(makes.textContent).toContain('The dashboard Returns Q4');
    expect(makes.textContent).toContain('In Ops');
    fireEvent.click(screen.getByRole('button', { name: 'Approve and publish' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'request:approve')?.payload).toEqual({ projectId: P, id: R, publish: true }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/dashboards/${P}/${D}`));
  });

  it('Edit makes it as a draft and opens the editor', async () => {
    const { calls, router } = review({ 'request:preview': { body: preview() }, 'request:approve': { body: { ok: true, dashboardId: D, published: false } } });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'request:approve')?.payload).toEqual({ projectId: P, id: R, publish: false }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/analyses/${P}/${D}`));
  });

  it('Decline needs a note, and sends it', async () => {
    let n = 0;
    const { calls } = review({ 'request:preview': () => ({ body: preview(n++ === 0 ? 'open' : 'declined') }), 'request:decline': { body: { ok: true } } });
    fireEvent.click(await screen.findByRole('button', { name: 'Decline…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Decline this request' });
    expect((within(dialog).getByRole('button', { name: 'Decline' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Note to the viewer' }), { target: { value: 'We have this already' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Decline' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'request:decline')?.payload).toEqual({ projectId: P, id: R, note: 'We have this already' }));
    expect(await screen.findByText('Ed declined it')).toBeTruthy();
  });

  it('a refusal is the server\'s sentence (an editor who cannot open the data), with no action offered', async () => {
    review({ 'request:preview': { status: 409, body: { ok: false, code: 'folder', reason: 'closed', error: 'This is in a folder you can\'t open.' } } });
    expect(await screen.findByText('This is in a folder you can\'t open.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve and publish' })).toBeNull();
  });
});
