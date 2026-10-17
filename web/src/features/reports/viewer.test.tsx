// A project viewer on a story and a scorecard: the page reads the same, and
// nothing saves — hiding the buttons is half of it, so the story's save paths
// (the debounced commit, undo/redo, ⌘Z) are driven past their 600 ms and must
// send no story:update. Each case has its editor negative control.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../test-utils';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const S = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const LAZY = 15_000;
const STORY = { id: S, name: 'Q3 review', updatedAt: '', blocks: [{ id: 'b1', kind: 'text', text: '## Revenue held up' }] };
const RESULT = {
  ok: true, id: S, name: 'Targets', period: 'month',
  window: { from: '2026-09-01', to: '2026-09-30', label: 'September 2026', offset: 0 },
  rows: [], groups: [], counts: { good: 0, warn: 0, off: 0, none: 0 },
};

const routes = (role: string, extra: Record<string, RpcReply> = {}): Record<string, RpcReply> => ({
  'projects:list': { body: [{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }] },
  'projects:roles': { body: { [P]: role } },
  'story:get': { body: STORY },
  'story:update': { body: { id: S } },
  'scorecard:get': { body: { id: S, name: 'Targets', period: 'month', rows: [], updatedAt: '' } },
  'scorecard:compute': { body: RESULT },
  ...extra,
});

describe('a viewer on a story', () => {
  it('reads it as a document: no name field, no undo, and ⌘Z past 600 ms sends no story:update', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = serveRpc(routes('viewer'));
    renderApp(`/stories/${P}/${S}?focus=end`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Q3 review' }, { timeout: LAZY })).toBeTruthy();
    expect(screen.getByText('View only')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: 'Revenue held up' })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Story name' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit text' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^(Undo|Nothing to undo)/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Story options' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a block below' })).toBeNull();
    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    fireEvent.keyDown(window, { key: 'z', metaKey: true, shiftKey: true });
    await act(async () => void vi.advanceTimersByTime(700));
    expect(calls.filter((c) => c.channel === 'story:update')).toEqual([]);
  }, 30_000);

  it('an empty story tells a viewer who can fill it (and does not crash on focus=end)', async () => {
    serveRpc(routes('viewer', { 'story:get': { body: { ...STORY, blocks: [] } } }));
    renderApp(`/stories/${P}/${S}?focus=end`);
    expect(await screen.findByRole('heading', { name: 'This story is empty' }, { timeout: LAZY })).toBeTruthy();
  }, 30_000);

  it('negative control: an editor renames it and the debounced save sends story:update', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const calls = serveRpc(routes('editor'));
    renderApp(`/stories/${P}/${S}`);
    const name = await screen.findByRole('textbox', { name: 'Story name' }, { timeout: LAZY });
    expect(screen.queryByText('View only')).toBeNull();
    fireEvent.change(name, { target: { value: 'Q3 review, final' } });
    await act(async () => void vi.advanceTimersByTime(700));
    await waitFor(() => expect(calls.find((c) => c.channel === 'story:update')?.payload).toMatchObject({ name: 'Q3 review, final' }));
  }, 30_000);
});

describe('a viewer on a scorecard', () => {
  it('steps periods, reads the rows; the name, period, metrics and options are an editor\'s', async () => {
    const calls = serveRpc(routes('viewer'));
    renderApp(`/scorecards/${P}/${S}?edit=1`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Targets' }, { timeout: LAZY })).toBeTruthy();
    expect(screen.getByText('View only')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Period' }).hasAttribute('disabled')).toBe(true);
    expect(await screen.findByText(/An editor of this project can add the metrics/)).toBeTruthy();
    for (const name of ['Metrics & targets', 'Scorecard options', 'Add metrics']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull(); // ?edit=1 never opens the targets editor for a viewer
    fireEvent.click(screen.getByRole('button', { name: 'Previous period' }));
    await waitFor(() => expect(calls.filter((c) => c.channel === 'scorecard:compute').length).toBeGreaterThan(1));
    expect(calls.some((c) => c.channel === 'scorecard:update')).toBe(false);
    cleanup();
    serveRpc(routes('editor'));
    renderApp(`/scorecards/${P}/${S}`);
    expect(await screen.findByRole('button', { name: 'Metrics & targets' }, { timeout: LAZY })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Scorecard name' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add metrics' })).toBeTruthy();
  }, 30_000);
});
