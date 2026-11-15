// Phase G on the answer (docs/assistant/00-design.md): a VIEWER's "Ask an editor" where the data isn't
// theirs yet — the composer prefilled with the question and the reason, an optional note, and the
// server's word on what happened (sent, already sent today, the day's limit, a failure) — and an
// EDITOR's "Alert me", which opens the existing alert dialog on the server's subject and threshold,
// or says why an answer can't be one. Neither is offered to the other role.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { serveRpc, type RpcReply } from '../../test-utils';
import { AskAnEditor } from './AskAnEditor';
import { AlertFromAnswer } from './AlertFromAnswer';

vi.setConfig({ testTimeout: 30_000 });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const P = '11111111-1111-4111-8111-111111111111';
const DS = '22222222-2222-4222-8222-222222222222';
const SPEC = { datasetId: DS, category: 'region', measures: [{ column: 'net_sales', aggregation: 'sum' }], filters: [{ column: 'order_date', period: 'last_quarter' }], chartType: 'column', title: 'Sales by region' };

function mount(ui: React.ReactNode, role: 'viewer' | 'editor', routes: Record<string, RpcReply> = {}) {
  const calls = serveRpc({ 'projects:roles': { body: { [P]: role } }, ...routes });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
  return calls;
}
const askUi = <AskAnEditor projectId={P} question="returns by reason last month" reason="missing" />;
async function compose() {
  fireEvent.click(await screen.findByRole('button', { name: 'Ask an editor' }));
  return screen.findByRole('dialog', { name: 'Ask an editor' });
}

describe('Ask an editor (a viewer)', () => {
  it('says why, opens a composer prefilled with the question and the reason, and sends it with the note', async () => {
    const calls = mount(askUi, 'viewer', { 'editors:ask': { body: { ok: true } } });
    const offer = await screen.findByTestId('ask-editor');
    expect(within(offer).getByText('This data isn’t in Ordinate yet.')).toBeTruthy();
    const dialog = await compose();
    expect((within(dialog).getByRole('textbox', { name: 'Your question' }) as HTMLTextAreaElement).value).toBe('returns by reason last month');
    expect(within(dialog).getByText('This data isn’t in Ordinate yet.')).toBeTruthy();
    expect(within(dialog).getByText(/Other viewers never see it/)).toBeTruthy();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Note (optional)' }), { target: { value: '  For the Q4 review ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'editors:ask')?.payload).toEqual({ projectId: P, question: 'returns by reason last month', reason: 'missing', note: 'For the Q4 review' }));
    expect((await screen.findByTestId('ask-editor-sent')).textContent).toBe('Sent to the project’s editors');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Ask an editor' })).toBeNull(); // sent: it can't be clicked again from here
  });

  it('the same question again today: "already sent", nothing else', async () => {
    mount(askUi, 'viewer', { 'editors:ask': { body: { ok: true, already: true } } });
    fireEvent.click(within(await compose()).getByRole('button', { name: 'Send' }));
    expect((await screen.findByTestId('ask-editor-sent')).textContent).toBe('Already sent to the project’s editors today');
  });

  it('the day\'s limit: the server\'s sentence, Send off, the composer and the note kept', async () => {
    const limit = 'You can ask the editors 10 times a day. Try again tomorrow.';
    mount(askUi, 'viewer', { 'editors:ask': { body: { ok: false, code: 'rate_limited', error: limit } } });
    const dialog = await compose();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Note (optional)' }), { target: { value: 'kept' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(limit);
    expect((within(dialog).getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(dialog).getByRole('textbox', { name: 'Note (optional)' }) as HTMLTextAreaElement).value).toBe('kept');
  });

  it('a failure says so and keeps the composer; sending again works', async () => {
    let n = 0;
    const calls = mount(askUi, 'viewer', { 'editors:ask': () => (n++ === 0 ? { status: 500, body: { error: 'Boom' } } : { body: { ok: true } }) });
    const dialog = await compose();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));
    expect(await screen.findByTestId('ask-editor-sent')).toBeTruthy();
    expect(calls.filter((c) => c.channel === 'editors:ask').length).toBe(2);
  });

  it('an empty question cannot be sent; Escape closes the composer and sends nothing', async () => {
    const calls = mount(askUi, 'viewer');
    const dialog = await compose();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Your question' }), { target: { value: '   ' } });
    expect((within(dialog).getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls.some((c) => c.channel === 'editors:ask')).toBe(false);
  });

  it('NEGATIVE CONTROL: an editor is never offered it (they get the editor\'s way out)', async () => {
    const calls = mount(askUi, 'editor');
    await waitFor(() => expect(calls.some((c) => c.channel === 'projects:roles')).toBe(true));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId('ask-editor')).toBeNull();
  });
});

const alertUi = <AlertFromAnswer projectId={P} spec={SPEC} />;
const SUBJECT = { datasetId: DS, column: 'net_sales', aggregation: 'sum', filters: [{ type: 'filter', column: 'order_date', op: 'period', period: { preset: 'last_quarter' } }] };
const DIALOG_ROUTES: Record<string, RpcReply> = {
  'alerts:list': { body: { ok: true, digest: false, unseen: 0, rules: [], events: [] } },
  'dashboard:metric': { body: { ok: true, value: 2600 } },
  'alerts:save': { body: { ok: true, rule: {} } },
};

describe('Alert me (an editor)', () => {
  it('opens the alert dialog on the server\'s subject, with its threshold and what the number covers; Save sends that rule', async () => {
    const calls = mount(alertUi, 'editor', {
      ...DIALOG_ROUTES,
      'alerts:fromAnswer': { body: { ok: true, subject: SUBJECT, value: 2600, suggest: { op: '<', value: 2300 }, scope: 'One number for every region together, under this answer\'s filters.' } },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Alert me' }));
    await waitFor(() => expect(calls.find((c) => c.channel === 'alerts:fromAnswer')?.payload).toEqual({ projectId: P, spec: SPEC }));
    const dialog = await screen.findByRole('dialog', { name: 'Alert me…' });
    expect((within(dialog).getByRole('textbox', { name: 'Value' }) as HTMLInputElement).value).toBe('2300');
    expect(within(dialog).getByText('One number for every region together, under this answer\'s filters.')).toBeTruthy();
    // The figure is the dialog's own by-hand read, as from a KPI card.
    await waitFor(() => expect(calls.find((c) => c.channel === 'dashboard:metric')?.payload).toEqual({ projectId: P, datasetId: DS, column: 'net_sales', aggregation: 'sum', filters: SUBJECT.filters }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'alerts:save')).toBe(true));
    const saved = calls.find((c) => c.channel === 'alerts:save');
    const rule = (saved ? (saved.payload as { rule: Record<string, unknown> }) : { rule: {} }).rule;
    expect(rule).toMatchObject({ datasetId: DS, metric: { column: 'net_sales', aggregation: 'sum', filters: SUBJECT.filters }, compare: 'threshold', threshold: { op: '<', value: 2300 } });
  });

  it('an answer no single number stands for: the server\'s reason beside the button, and no dialog', async () => {
    const why = 'This answer has 2 measures, and an alert watches one number. Ask for one of them to set an alert.';
    mount(alertUi, 'editor', { 'alerts:fromAnswer': { body: { ok: false, reason: why } } });
    fireEvent.click(await screen.findByRole('button', { name: 'Alert me' }));
    expect((await screen.findByTestId('answer-alert-refused')).textContent).toBe(why);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('NEGATIVE CONTROL: a viewer is never offered it (an alert is saved to the project)', async () => {
    const calls = mount(alertUi, 'viewer');
    await waitFor(() => expect(calls.some((c) => c.channel === 'projects:roles')).toBe(true));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole('button', { name: 'Alert me' })).toBeNull();
  });
});
