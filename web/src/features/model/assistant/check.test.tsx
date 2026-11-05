// Check the Assistant on the Data model's Assistant tab (semantic part 3 D13 (3)): an editor asks the model each working
// verified question once (`verified:check`, a job) and sees which it gets right (`verified:checkResult`, the run's record).
// The page re-reads the record on its own tab's job pushes, never on a timer; the counts are the server's.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { encode } from '../../../../../src/server/wire.ts';
import { resetEventsForTest } from '../../../api/events';
import { renderApp, serveRpc, type RpcReply } from '../../../test-utils';
import type { CheckRun, VerifiedRow } from './api';

/** The one EventSource the tab opens, driven by the test. */
class FakeSource {
  static readonly CLOSED = 2;
  static last: FakeSource | null = null;
  readyState = 1;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly handlers = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(readonly url: string) {
    FakeSource.last = this;
  }
  addEventListener(ch: string, fn: (e: { data: string }) => void) {
    this.handlers.set(ch, [...(this.handlers.get(ch) ?? []), fn]);
  }
  close() {}
  emit(ch: string, payload: unknown) {
    act(() => {
      for (const fn of this.handlers.get(ch) ?? []) fn({ data: encode(payload) });
    });
  }
}

beforeEach(() => vi.stubGlobal('EventSource', FakeSource));
afterEach(() => {
  cleanup();
  resetEventsForTest();
  vi.unstubAllGlobals();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const V1 = '3c6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const V2 = '4c6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const V3 = '5c6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const V4 = '6c6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const R = '7c6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const LAZY = { timeout: 15_000 };
const NOW = '2026-10-12T10:00:00Z';
const READY = { ready: true, models: [], mine: null, copilotEnabled: true, keyStore: null };
const NO_MODEL = { ready: false, reason: 'no_model', models: [], mine: null, copilotEnabled: true, keyStore: null };

const row = (id: string, question: string, more: Partial<VerifiedRow> = {}): VerifiedRow => ({
  id, question, phrasings: [], datasetId: D, datasetName: 'Orders', describe: 'sum of amount by region', filters: [],
  spec: { datasetId: D, category: 'region', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [], chartType: 'column', title: question },
  verifiedBy: 'priya@acme.test', verifiedAt: NOW, runs: true, tag: `tag-${id}`, ...more,
});
const ROWS = [row(V1, 'Revenue by region'), row(V2, 'Profit by category'), row(V3, 'Top 5 states by revenue'), row(V4, 'Added after the run')];
const run = (more: Partial<CheckRun> = {}): CheckRun => ({
  runId: R, state: 'done', startedBy: 'priya@acme.test', startedAt: NOW, heartbeatAt: NOW, finishedAt: NOW,
  total: 14, asked: 14, matched: 12, skipped: 0, results: [], ...more,
});

function serve(routes: Record<string, RpcReply> = {}, role: 'editor' | 'viewer' = 'editor', last: CheckRun | null = null) {
  const body = (b: unknown) => ({ body: b });
  return serveRpc({
    '/api/auth/me': body({ user: { email: 'pat@acme.test', role: 'member' }, org: 'acme', mode: 'oidc', canSignOut: true }),
    'projects:list': body([{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }]),
    'projects:overview': body([{ id: P, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false }]),
    'projects:roles': body({ [P]: role }),
    'catalog:instructions': body({ ok: true, instructions: [] }),
    'verified:list': body({ ok: true, broken: 0, questions: ROWS }),
    'verified:checkResult': body({ ok: true, run: last }),
    'ai:status': body(READY),
    'copilot:threads': body({ ok: true, threads: [] }),
    ...routes,
  });
}
const section = () => screen.findByRole('region', { name: 'Verified questions' }, LAZY);
const rowOf = async (question: string) => (await within(await section()).findByText(question)).closest('li') as HTMLElement;
const sent = (calls: { channel: string; payload: unknown }[], channel: string) => calls.filter((c) => c.channel === channel).map((c) => c.payload);

describe('The Data model: Check the Assistant', () => {
  it('a done run reads its score on the button, from the server\'s counts', async () => {
    serve({}, 'editor', run());
    renderApp(`/model/${P}?tab=assistant`);
    expect(await within(await section()).findByRole('button', { name: 'Check the Assistant · 12 of 14' })).toBeTruthy();
  }, 30_000); // the first test pays for the lazy route chunk's transform

  it('it asks first, saying what it costs; confirming posts verified:check and reads the run back', async () => {
    let started = false;
    const calls = serve({
      'verified:check': () => { started = true; return { body: { ok: true, runId: R } }; },
      'verified:checkResult': () => ({ body: { ok: true, run: started ? run({ state: 'running', asked: 0, total: 4, matched: 0, finishedAt: undefined }) : null } }),
    });
    renderApp(`/model/${P}?tab=assistant`);
    fireEvent.click(await within(await section()).findByRole('button', { name: 'Check the Assistant' }));
    const dialog = await screen.findByRole('dialog', { name: 'Check the Assistant on 4 verified questions?' });
    expect(dialog.textContent).toContain('It asks the model once per question (at most 50).');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sent(calls, 'verified:check')).toEqual([]);
    fireEvent.click(within(await section()).getByRole('button', { name: 'Check the Assistant' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Check' }));
    await waitFor(() => expect(sent(calls, 'verified:check')).toEqual([{ projectId: P }]));
    expect(await within(await section()).findByRole('button', { name: 'Checking… 0 of 4' })).toBeTruthy();
  });

  it('a running run reads its progress, and is read again on its tab\'s job pushes only', async () => {
    let asked = 3;
    const calls = serve({ 'verified:checkResult': () => ({ body: { ok: true, run: run({ state: 'running', asked, matched: 2, finishedAt: undefined }) } }) });
    renderApp(`/model/${P}?tab=assistant`);
    const button = await within(await section()).findByRole('button', { name: 'Checking… 3 of 14' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    const reads = () => sent(calls, 'verified:checkResult').length;
    const before = reads();
    FakeSource.last!.emit('jobs:changed', { active: [{ id: 'j1', kind: 'quality', state: 'running' }], recent: [], pod: 'a' });
    await new Promise((r) => setTimeout(r, 50));
    expect(reads()).toBe(before); // NEGATIVE CONTROL: another kind of job changes nothing here
    asked = 4;
    FakeSource.last!.emit('jobs:changed', { active: [{ id: 'j2', kind: 'assistant-check', state: 'running' }], recent: [], pod: 'a' });
    expect(await within(await section()).findByRole('button', { name: 'Checking… 4 of 14' })).toBeTruthy();
    expect(reads()).toBe(before + 1);
  });

  it('each row says how the Assistant did on it; a question added after the run says nothing', async () => {
    serve({}, 'editor', run({
      total: 3, asked: 3, matched: 1,
      results: [{ id: V1, outcome: 'match' }, { id: V2, outcome: 'differs' }, { id: V3, outcome: 'refused', reason: 'The Assistant did not answer with a chart.' }],
    }));
    renderApp(`/model/${P}?tab=assistant`);
    expect((await rowOf('Revenue by region')).textContent).toContain('✓ The Assistant gets this');
    expect((await rowOf('Profit by category')).textContent).toContain('✗ The Assistant answers it differently');
    const refused = await rowOf('Top 5 states by revenue');
    expect(refused.textContent).toContain('✗ The Assistant could not answer it');
    expect(refused.textContent).toContain('The Assistant did not answer with a chart.');
    expect((await rowOf('Added after the run')).textContent).not.toMatch(/The Assistant/);
  });

  it('with no model the button is disabled, and says why', async () => {
    serve({ 'ai:status': { body: NO_MODEL } });
    renderApp(`/model/${P}?tab=assistant`);
    const s = await section();
    await waitFor(() => expect((within(s).getByRole('button', { name: 'Check the Assistant' }) as HTMLButtonElement).disabled).toBe(true));
    expect(within(s).getByRole('button', { name: 'Check the Assistant' }).getAttribute('title')).toBe('Connect a model to check the Assistant.');
  });

  it('a stopped run says it stopped before the end, and how far it got', async () => {
    serve({}, 'editor', run({ state: 'stopped', asked: 5, matched: 4 }));
    renderApp(`/model/${P}?tab=assistant`);
    const s = await section();
    expect(await within(s).findByText('The last check stopped before the end, after 5 of 14 questions.')).toBeTruthy();
    expect(within(s).getByRole('button', { name: 'Check the Assistant' })).toBeTruthy();
  });

  it('NEGATIVE CONTROL: a viewer reads each row\'s result and gets no button', async () => {
    const calls = serve({}, 'viewer', run({ total: 1, asked: 1, matched: 1, results: [{ id: V1, outcome: 'match' }] }));
    renderApp(`/model/${P}?tab=assistant`);
    expect((await rowOf('Revenue by region')).textContent).toContain('✓ The Assistant gets this');
    await waitFor(() => expect(calls.some((c) => c.channel === 'projects:roles')).toBe(true));
    expect(within(await section()).queryByRole('button', { name: /Check the Assistant/ })).toBeNull();
  });

  it('an older server without verified:check shows its error with Try again, which asks again', async () => {
    const calls = serve({ 'verified:check': { status: 404, body: { error: 'not_found', message: 'Unknown channel' } } });
    renderApp(`/model/${P}?tab=assistant`);
    fireEvent.click(await within(await section()).findByRole('button', { name: 'Check the Assistant' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Check' }));
    const alert = await within(await section()).findByRole('alert');
    expect(alert.textContent).toContain('The check could not start');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(sent(calls, 'verified:check')).toHaveLength(2));
  });
});
