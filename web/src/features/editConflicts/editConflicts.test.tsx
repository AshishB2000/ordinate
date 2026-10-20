// Two editors never overwrite each other (docs/edit-conflicts/00-design.md).
//
//   the guard   the base is sent and each reply's tag becomes the next; a 409
//               record_changed pauses it — nothing more is sent (CONTROL: any
//               other failure rejects and pauses nothing); a saved-view reply's
//               tag is checked, never adopted; the server's push of another
//               save raises it, its own does not (CONTROL: another record's);
//   the banner  worded per type, no way to dismiss it, Reload, and Save mine as
//               a copy with its busy and refused states;
//   the editor  a dashboard end to end: save → view op → save sends the tag each
//               reply gave and shows no banner; a refused save shows the banner,
//               autosave stops (no write however long it waits), Reload opens
//               the dashboard again without it, and Save mine as a copy creates
//               "<name> (copy)" from the document on screen and opens it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { encode } from '../../../../src/server/wire.ts';
import { RpcError } from '../../api/client';
import { resetEventsForTest } from '../../api/events';
import { renderApp, serveRpc } from '../../test-utils';
import { ConflictBanner } from './ConflictBanner';
import { SAVED_CHANNEL, useEditGuard } from './useEditGuard';

const P = '11111111-1111-4111-8111-111111111111';
const A = '33333333-3333-4333-8333-333333333333';
const NEW = '44444444-4444-4444-8444-444444444444';
const CHANGED = () => new RpcError(409, 'record_changed', 'This dashboard was changed in another tab or by someone else. Reload it, or save yours as a copy.');

/** The one stream useServerEvent opens, driven by the test (as api/events.test.ts does). */
class FakeSource {
  static all: FakeSource[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly handlers = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(readonly url: string) {
    FakeSource.all.push(this);
  }
  addEventListener(ch: string, fn: (e: { data: string }) => void) {
    this.handlers.set(ch, [...(this.handlers.get(ch) ?? []), fn]);
  }
  close() {
    this.readyState = 2;
  }
  emit(ch: string, payload: unknown) {
    for (const fn of this.handlers.get(ch) ?? []) fn({ data: encode(payload) });
  }
}

beforeEach(() => {
  FakeSource.all = [];
  vi.stubGlobal('EventSource', FakeSource);
});
afterEach(() => {
  resetEventsForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const guardFor = (tag = 'T0', id = A) => renderHook(() => useEditGuard({ projectId: P, type: 'dashboard', id }, tag));
const push = (p: Record<string, unknown>) => act(() => FakeSource.all.forEach((s) => s.emit(SAVED_CHANNEL, { projectId: P, type: 'dashboard', id: A, ...p })));
const drain = (g: { queue: (w: () => Promise<undefined>) => Promise<undefined> }) => act(async () => {
  await g.queue(async () => undefined);
});

describe('useEditGuard', () => {
  it('sends the tag it opened with, then the one each reply gives', async () => {
    const { result } = guardFor();
    const sent: (string | undefined)[] = [];
    await act(() => result.current.save(async (b) => (sent.push(b), { ok: true, tag: 'T1' })));
    await act(() => result.current.save(async (b) => (sent.push(b), { ok: true, tag: 'T2' })));
    expect(sent).toEqual(['T0', 'T1']);
    expect(result.current.changed).toBe(false);
  });

  it('a 409 record_changed pauses it: null, and nothing more is sent', async () => {
    const { result } = guardFor();
    let out: unknown = 'unset';
    await act(async () => void (out = await result.current.save(() => Promise.reject(CHANGED()))));
    expect(out).toBeNull();
    expect(result.current.changed).toBe(true);
    const send = vi.fn(async () => ({ ok: true, tag: 'T9' }));
    await act(async () => void (out = await result.current.save(send)));
    expect(send).not.toHaveBeenCalled();
    expect(out).toBeNull();
  });

  it('CONTROL: any other failure rejects as it would without the guard, and pauses nothing', async () => {
    const { result } = guardFor();
    await act(() => expect(result.current.save(() => Promise.reject(new RpcError(500, 'handler failed', 'boom')))).rejects.toThrow('boom'));
    expect(result.current.changed).toBe(false);
  });

  it('saves run one at a time, in order, each with the tag the last returned', async () => {
    const { result } = guardFor();
    const sent: (string | undefined)[] = [];
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    let a!: Promise<unknown>;
    let b!: Promise<unknown>;
    act(() => {
      a = result.current.save(async (base) => (sent.push(base), await slow, { tag: 'T1' }));
      b = result.current.save(async (base) => (sent.push(base), { tag: 'T2' }));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(sent).toEqual(['T0']); // the second waits for the first
    release();
    await act(async () => {
      await Promise.all([a, b]);
    });
    expect(sent).toEqual(['T0', 'T1']);
  });

  it('a saved-view reply is a check: the same tag changes nothing, another raises it', async () => {
    const { result } = guardFor();
    await act(() => result.current.queue(async () => ({ ok: true, tag: 'T0' })));
    expect(result.current.changed).toBe(false);
    await act(() => result.current.queue(async () => ({ ok: true, tag: 'ELSEWHERE' })));
    expect(result.current.changed).toBe(true);
  });

  it('the server’s push: its own save is not news; another’s raises it (CONTROL: another record’s does not)', async () => {
    const { result } = guardFor();
    await act(() => result.current.save(async () => ({ ok: true, tag: 'T1' })));
    push({ tag: 'T1' }); // this tab's own save
    push({ tag: 'T0' }); // a tag it held
    push({ id: NEW, tag: 'OTHER' }); // another dashboard
    push({ type: 'visual', tag: 'OTHER' }); // another kind of record with this id
    await drain(result.current);
    expect(result.current.changed).toBe(false);
    push({ tag: 'SOMEONE' });
    await waitFor(() => expect(result.current.changed).toBe(true));
  });

  it('a host whose reply lands after mount: the first tag it passes is the base', async () => {
    let tag: string | undefined;
    const { result, rerender } = renderHook(() => useEditGuard({ projectId: P, type: 'metric', id: A }, tag));
    tag = 'LATE';
    rerender();
    tag = 'LATER'; // a refetch: the editor's copy was built on LATE
    rerender();
    const sent: (string | undefined)[] = [];
    await act(() => result.current.save(async (b) => (sent.push(b), {})));
    expect(sent).toEqual(['LATE']);
  });
});

describe('ConflictBanner', () => {
  it('says what changed in the editor’s words, has no way to dismiss it, and offers the two ways on', () => {
    const onReload = vi.fn();
    render(<ConflictBanner noun="scorecard" onReload={onReload} onCopy={async () => {}} />);
    const banner = screen.getByRole('alert');
    expect(banner.textContent).toContain('This scorecard was changed in another tab or by someone else.');
    expect(banner.textContent).toContain('Your changes since then are not saved');
    expect(within(banner).getAllByRole('button').map((b) => b.textContent)).toEqual(['Reload', 'Save mine as a copy']);
    fireEvent.keyDown(banner, { key: 'Escape' });
    expect(screen.getByRole('alert')).toBe(banner);
    fireEvent.click(within(banner).getByRole('button', { name: 'Reload' }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('Save mine as a copy: busy while it runs; a refusal is said in the banner, and the button comes back', async () => {
    let fail!: (e: Error) => void;
    render(<ConflictBanner noun="metric" onReload={() => {}} onCopy={() => new Promise<void>((_, rej) => (fail = rej))} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save mine as a copy' }));
    const busy = await screen.findByRole('button', { name: 'Saving a copy…' });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Reload' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => fail(new Error('A metric called “Revenue (copy)” already exists.')));
    expect(await screen.findByText('A metric called “Revenue (copy)” already exists.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save mine as a copy' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

// ── The dashboard editor, end to end ──────────────────────────────────────

const analysis = (id: string, name: string) => ({
  id, projectId: P, name, sheets: [{ id: 's1', name: 'Sheet 1', cards: [] }], filters: [], style: {}, parameters: [], views: [], defaultViewId: '', updatedAt: '',
});

function serveEditor(update: (payload: { base?: string; name: string }, n: number) => { status?: number; body: unknown }) {
  let opens = 0;
  let updates = 0;
  const calls = serveRpc({
    '/api/auth/me': { body: { user: { email: 'dev@local', role: 'admin' }, org: 'default', mode: 'dev', canSignOut: false } },
    'projects:list': { body: [{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }] },
    'projects:roles': { body: { [P]: 'editor' } },
    'analysis:open': (p) => {
      opens += 1;
      const id = (p as { id: string }).id;
      return { body: { ok: true, analysis: analysis(id, id === NEW ? 'Four (copy)' : opens > 1 ? 'Saved elsewhere' : 'Board'), visuals: [], tag: `OPEN${opens}` } };
    },
    'analysis:update': (p) => update(p as { base?: string; name: string }, ++updates),
    'analysis:view': () => ({ body: { ok: true, views: [{ id: '77777777-7777-4777-8777-777777777771', name: 'East', state: {}, createdAt: '', updatedAt: '' }], defaultViewId: '', viewId: '77777777-7777-4777-8777-777777777771', tag: 'T1' } }),
    'analysis:create': (p) => ({ body: { ...analysis(NEW, (p as { name: string }).name), tag: 'NEWTAG' } }),
  });
  return calls;
}

async function rename(to: string) {
  fireEvent.click(await screen.findByTitle('Click to rename', undefined, { timeout: 15_000 }));
  const dialog = await screen.findByRole('dialog', { name: 'Rename dashboard' });
  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: to } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
}
const updates = (calls: { channel: string; payload: unknown }[]) => calls.filter((c) => c.channel === 'analysis:update').map((c) => c.payload as { base?: string; name: string });
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

describe('the dashboard editor', { timeout: 40_000 }, () => {
  it('save → saved-view op → save: each save sends the tag the last reply gave, and no banner', async () => {
    const calls = serveEditor((p, n) => ({ body: { ok: true, analysis: analysis(A, p.name), tag: `T${n}` } }));
    renderApp(`/analyses/${P}/${A}`);
    await rename('One');
    await waitFor(() => expect(updates(calls)).toHaveLength(1), { timeout: 3000 });
    expect(updates(calls)[0]).toMatchObject({ base: 'OPEN1', name: 'One' });
    // A saved view, in the same queue: its reply carries the record's tag, unchanged by it.
    fireEvent.pointerDown(await screen.findByRole('button', { name: /^Views/ }), { button: 0, ctrlKey: false });
    fireEvent.click(within(await screen.findByRole('menu', { name: /^Views/ })).getByRole('menuitem', { name: 'Save as a new view…' }));
    const dlg = await screen.findByRole('dialog', { name: 'Save as a new view' });
    fireEvent.change(within(dlg).getByLabelText('Name'), { target: { value: 'East' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Save view' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'analysis:view')).toBe(true));
    await rename('Two');
    await waitFor(() => expect(updates(calls)).toHaveLength(2), { timeout: 3000 });
    expect(updates(calls)[1]).toMatchObject({ base: 'T1', name: 'Two' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a refused save: the banner, autosave stopped; Reload opens the dashboard again without it', async () => {
    const calls = serveEditor(() => ({ status: 409, body: { error: 'record_changed', code: 'record_changed', message: CHANGED().message, tag: 'ELSEWHERE' } }));
    renderApp(`/analyses/${P}/${A}`);
    await rename('Three');
    const banner = await screen.findByRole('alert', undefined, { timeout: 3000 });
    expect(banner.textContent).toContain('This dashboard was changed in another tab or by someone else.');
    expect(screen.getByText('Not saved')).toBeTruthy();
    // Paused: an edit after the refusal is never sent, however long it waits.
    await rename('Four');
    await wait(1200);
    expect(updates(calls)).toHaveLength(1);
    fireEvent.click(within(banner).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(calls.filter((c) => c.channel === 'analysis:open')).toHaveLength(2));
    expect(await screen.findByTitle('Click to rename', undefined, { timeout: 15_000 })).toBeTruthy();
    await waitFor(() => expect(screen.getByTitle('Click to rename').textContent).toBe('Saved elsewhere'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Save mine as a copy: "<name> (copy)" from the document on screen, then it opens', async () => {
    const calls = serveEditor(() => ({ status: 409, body: { error: 'record_changed', code: 'record_changed', message: CHANGED().message, tag: 'ELSEWHERE' } }));
    const router = renderApp(`/analyses/${P}/${A}`);
    await rename('Four');
    const banner = await screen.findByRole('alert', undefined, { timeout: 3000 });
    fireEvent.click(within(banner).getByRole('button', { name: 'Save mine as a copy' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/analyses/${P}/${NEW}`));
    const made = calls.find((c) => c.channel === 'analysis:create')?.payload as { name: string; sheets: unknown[]; style: unknown };
    expect(made).toMatchObject({ projectId: P, name: 'Four (copy)', sheets: [{ id: 's1', name: 'Sheet 1', cards: [] }], style: {} });
    await waitFor(() => expect(calls.some((c) => c.channel === 'analysis:open' && (c.payload as { id: string }).id === NEW)).toBe(true));
    // Leaving the refused editor sent nothing more.
    expect(updates(calls)).toHaveLength(1);
  });
});
