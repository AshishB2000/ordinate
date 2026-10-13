// ASK FIRST, in the browser: the brief (kind and look) is on screen before any
// model is asked; the draft is then asked with `clarify`, and a reply of
// questions is one more screen — once — before the review. What these hold is
// what is SENT: the kind, the answers ("Skip" is an empty list), and the look,
// which goes to `analysis:buildPlan` and nowhere else.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { DEFAULT_BRIEF, DraftBrief, type Brief } from './DraftBrief';
import { DraftFlow } from './DraftReview';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const PID = '11111111-1111-4111-8111-111111111111';
const DID = '22222222-2222-4222-8222-222222222222';
const AID = '33333333-3333-4333-8333-333333333333';
const PLAN = { ok: true, name: 'Sales overview', sheets: [{ name: 'Overview', visuals: [] }], plan: { name: 'Sales overview' } };
const QUESTIONS = {
  ok: true,
  questions: [
    { ask: 'Which measure?', options: ['Revenue', 'Order count'] },
    { ask: 'Compared how?', options: ['By region', 'Over time', 'Both'] },
  ],
};
const REVIEW = 'Assistant draft — review before creating';

/** A reply body, a promise of one (to hold a call open), or `{ status, body }` for a failed request. */
type Canned = unknown;
const isHttp = (r: unknown): r is { status: number; body: unknown } => !!r && typeof r === 'object' && 'status' in r && 'body' in r;

/** A server whose `analysis:draft` answers with `drafts`, in order; records every RPC and what it was asked. */
function serve(drafts: Canned[]) {
  const calls: { channel: string; payload: Record<string, unknown> }[] = [];
  let n = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).split('?')[0];
      const channel = path.startsWith('/api/rpc/') ? decodeURIComponent(path.slice('/api/rpc/'.length)) : path;
      const payload = init?.body ? (JSON.parse(String(init.body)) as { args: Record<string, unknown>[] }).args[0] : {};
      calls.push({ channel, payload });
      const canned = channel === 'analysis:draft' ? await drafts[n++] : channel === 'analysis:buildPlan' ? { ok: true, analysis: { id: AID } } : null;
      return isHttp(canned) ? new Response(JSON.stringify(canned.body), { status: canned.status }) : new Response(JSON.stringify(canned ?? null), { status: 200 });
    }),
  );
  return { calls, drafts: () => calls.filter((c) => c.channel === 'analysis:draft').map((c) => c.payload) };
}

function mount(ui: React.ReactElement, seed?: (client: QueryClient) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(client);
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

const names = (group: HTMLElement) => within(group).getAllByRole('radio').map((r) => (r as HTMLInputElement).closest('label')?.textContent ?? '');
const checked = (group: HTMLElement) => within(group).getAllByRole('radio').filter((r) => (r as HTMLInputElement).checked).map((r) => (r as HTMLInputElement).value);

describe('the brief', () => {
  it('offers three kinds and five looks, on Explore and the workspace default', () => {
    const { calls } = serve([]);
    mount(<DraftBrief value={DEFAULT_BRIEF} onChange={() => {}} />);
    const kind = screen.getByRole('radiogroup', { name: 'Kind' });
    const look = screen.getByRole('radiogroup', { name: 'Look' });
    expect(within(kind).getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual(['explore', 'overview', 'report']);
    // A card reads as its title and then its one-line description.
    expect(names(kind).map((text, i) => text.startsWith(['Explore', 'Overview', 'Report'][i]) && text.length > 20)).toEqual([true, true, true]);
    expect(checked(kind)).toEqual(['explore']);
    // The three pinned themes carry the Style dialog's own words; Dense is the fourth.
    expect(names(look)).toEqual(['Workspace defaultFrom Settings', 'LightAlways light', 'ExecutiveSlate, serif figures', 'DarkAlways dark', 'DenseCompact rows']);
    expect(checked(look)).toEqual(['']); // the workspace default is no look at all
    expect(DEFAULT_BRIEF).toEqual({ kind: 'explore', look: '' });
    expect(calls.some((c) => c.channel === 'analysis:draft')).toBe(false); // no model is asked to draw it
  });

  it('reports the kind and the look that were picked, each leaving the other alone', () => {
    serve([]);
    const seen: Brief[] = [];
    mount(<DraftBrief value={{ kind: 'overview', look: 'dense' }} onChange={(b) => seen.push(b)} />);
    expect(checked(screen.getByRole('radiogroup', { name: 'Kind' }))).toEqual(['overview']);
    expect(checked(screen.getByRole('radiogroup', { name: 'Look' }))).toEqual(['dense']);
    fireEvent.click(screen.getByRole('radio', { name: /^Report/ }));
    fireEvent.click(screen.getByRole('radio', { name: /^Dark/ }));
    fireEvent.click(screen.getByRole('radio', { name: /^Workspace default/ }));
    expect(seen).toEqual([{ kind: 'report', look: 'dense' }, { kind: 'overview', look: 'dark' }, { kind: 'overview', look: '' }]);
  });

  it('names the workspace’s own default when the app already knows it — without asking for it', () => {
    const { calls } = serve([]);
    mount(<DraftBrief value={DEFAULT_BRIEF} onChange={() => {}} />, (c) => c.setQueryData(['prefs:get'], { formats: {}, branding: { accent: '', logo: '', dashboardStyle: 'executive' } }));
    expect(screen.getByRole('radio', { name: /^Workspace default/ }).closest('label')?.textContent).toBe('Workspace defaultExecutive, from Settings');
    expect(calls).toEqual([]);
  });
});

describe('the draft flow', () => {
  it('brief → questions → review: the kind and the answers go to the draft, the look to the build', async () => {
    const { calls, drafts } = serve([QUESTIONS, PLAN]);
    const onClose = vi.fn();
    mount(<DraftFlow projectId={PID} datasetId={DID} intent="sales" onClose={onClose} />);

    // The brief, at once: nothing has been asked of the model.
    const brief = await screen.findByRole('dialog', { name: 'Draft a dashboard' });
    expect(drafts()).toEqual([]);
    fireEvent.click(within(brief).getByRole('radio', { name: /^Overview/ }));
    fireEvent.click(within(brief).getByRole('radio', { name: /^Dark/ }));
    fireEvent.click(within(brief).getByRole('button', { name: 'Draft dashboard' }));

    // The model's questions: one group each, nothing answered for the user.
    const ask = await screen.findByRole('dialog', { name: 'A few questions first' });
    expect(drafts()).toEqual([{ projectId: PID, datasetId: DID, intent: 'sales', kind: 'overview', clarify: true }]);
    const measure = within(ask).getByRole('radiogroup', { name: 'Which measure?' });
    expect(within(measure).getAllByRole('radio').map((r) => (r as HTMLInputElement).value)).toEqual(['Revenue', 'Order count']);
    expect(within(within(ask).getByRole('radiogroup', { name: 'Compared how?' })).getAllByRole('radio')).toHaveLength(3);
    expect(within(ask).getAllByRole('radio').some((r) => (r as HTMLInputElement).checked)).toBe(false);
    expect((within(ask).getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(ask).getByRole('button', { name: 'Skip — just build it' })).toBeTruthy();

    // One answered, one left: only the answered one is sent.
    fireEvent.click(within(measure).getByRole('radio', { name: 'Revenue' }));
    fireEvent.click(within(ask).getByRole('button', { name: 'Continue' }));
    const review = await screen.findByRole('dialog', { name: REVIEW });
    expect(drafts()[1]).toEqual({ projectId: PID, datasetId: DID, intent: 'sales', kind: 'overview', clarify: true, answers: [{ ask: 'Which measure?', answer: 'Revenue' }] });
    expect(drafts()).toHaveLength(2);
    expect(within(review).getByText('Sales overview')).toBeTruthy();
    expect(calls.some((c) => c.channel === 'analysis:buildPlan')).toBe(false); // nothing is created until the click

    fireEvent.click(within(review).getByRole('button', { name: 'Create dashboard' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.find((c) => c.channel === 'analysis:buildPlan')?.payload).toEqual({ projectId: PID, plan: PLAN.plan, style: 'dark' });
    // The look went to the build only: no draft was told it.
    expect(JSON.stringify(drafts())).not.toMatch(/dark|style|look/);
  });

  it('“Skip — just build it” sends no answers, and is not asked again', async () => {
    const { drafts } = serve([QUESTIONS, PLAN]);
    mount(<DraftFlow projectId={PID} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Draft dashboard' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Skip — just build it' }));
    await screen.findByRole('dialog', { name: REVIEW });
    expect(drafts()).toEqual([
      { projectId: PID, kind: 'explore', clarify: true },
      { projectId: PID, kind: 'explore', clarify: true, answers: [] },
    ]);
  });

  it('a request that needs no questions goes straight to the review, and the workspace default sends no look', async () => {
    const { calls, drafts } = serve([PLAN]);
    const onClose = vi.fn();
    mount(<DraftFlow projectId={PID} intent="revenue by region" preferredName="Mine" onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Draft dashboard' }));
    const review = await screen.findByRole('dialog', { name: REVIEW });
    expect(screen.queryByRole('dialog', { name: 'A few questions first' })).toBeNull();
    expect(drafts()).toEqual([{ projectId: PID, intent: 'revenue by region', kind: 'explore', clarify: true }]);
    fireEvent.click(within(review).getByRole('button', { name: 'Create dashboard' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.find((c) => c.channel === 'analysis:buildPlan')?.payload).toEqual({ projectId: PID, plan: { name: 'Mine' } });
  });

  it('with the brief already chosen (the wizard), it skips its own and drafts at once', async () => {
    const { calls, drafts } = serve([PLAN]);
    const onClose = vi.fn();
    mount(<DraftFlow projectId={PID} datasetId={DID} intent="sales" brief={{ kind: 'report', look: 'executive' }} onClose={onClose} />);
    const review = await screen.findByRole('dialog', { name: REVIEW });
    expect(screen.queryByRole('radiogroup', { name: 'Kind' })).toBeNull();
    expect(drafts()).toEqual([{ projectId: PID, datasetId: DID, intent: 'sales', kind: 'report', clarify: true }]);
    fireEvent.click(within(review).getByRole('button', { name: 'Create dashboard' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.find((c) => c.channel === 'analysis:buildPlan')?.payload).toEqual({ projectId: PID, plan: PLAN.plan, style: 'executive' });
  });

  it('shows a skeleton while the model works, on both calls', async () => {
    let first!: (v: unknown) => void;
    let second!: (v: unknown) => void;
    serve([new Promise((r) => (first = r)), new Promise((r) => (second = r))]);
    mount(<DraftFlow projectId={PID} onClose={() => {}} />);
    expect(screen.queryByRole('status')).toBeNull(); // the brief is not a loading state
    fireEvent.click(await screen.findByRole('button', { name: 'Draft dashboard' }));
    expect((await screen.findByRole('status')).getAttribute('aria-label')).toBe('The Assistant is planning your dashboard');
    expect(screen.queryByRole('button', { name: 'Create dashboard' })).toBeNull();
    first(QUESTIONS);
    fireEvent.click(await screen.findByRole('button', { name: 'Skip — just build it' }));
    expect((await screen.findByRole('status')).getAttribute('aria-label')).toBe('The Assistant is drafting your dashboard');
    second(PLAN);
    await screen.findByRole('button', { name: 'Create dashboard' });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a failed call is an error with a retry that asks the same thing again', async () => {
    const { drafts } = serve([{ status: 500, body: { error: 'internal', message: 'The model timed out.' } }, QUESTIONS, { ok: false, error: 'The model replied with nothing usable.' }, PLAN]);
    mount(<DraftFlow projectId={PID} intent="sales" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Draft dashboard' }));
    const failed = await screen.findByRole('alert');
    expect(within(failed).getByText('The model timed out.')).toBeTruthy();
    fireEvent.click(within(failed).getByRole('button', { name: 'Try again' }));

    // The retry was the asking call again; then the answers fail, and their retry carries them.
    fireEvent.click(within(await screen.findByRole('radiogroup', { name: 'Which measure?' })).getByRole('radio', { name: 'Order count' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const refused = await screen.findByRole('alert');
    expect(within(refused).getByText('The model replied with nothing usable.')).toBeTruthy();
    fireEvent.click(within(refused).getByRole('button', { name: 'Try again' }));
    await screen.findByRole('dialog', { name: REVIEW });
    const ask = { projectId: PID, intent: 'sales', kind: 'explore', clarify: true };
    const answered = { ...ask, answers: [{ ask: 'Which measure?', answer: 'Order count' }] };
    expect(drafts()).toEqual([ask, ask, answered, answered]);
  });

  it('with no model it says how to connect one', async () => {
    serve([{ ok: false, notReady: true }]);
    mount(<DraftFlow projectId={PID} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Draft dashboard' }));
    expect(await screen.findByRole('heading', { name: 'Connect a model to draft' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open the Assistant' })).toBeTruthy();
  });

  it('questions a second time are an error, never a second round', async () => {
    const { drafts } = serve([QUESTIONS, QUESTIONS]);
    mount(<DraftFlow projectId={PID} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Draft dashboard' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Skip — just build it' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(drafts()).toHaveLength(2);
  });
});
