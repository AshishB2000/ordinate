// A bookmarked dashboard, dataset, story or report in a folder the caller cannot open (docs/team-folders D12): the page found
// nothing, asked `folder:of`, and says the server's sentence instead of "not found". NEGATIVE CONTROLS: when
// folder:of answers {ok:true} (a missing id) the page says "not found" as before, and a page that loaded never asks.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { renderApp, serveRpc } from '../../test-utils';

vi.setConfig({ testTimeout: 30_000 });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '11111111-1111-4111-8111-111111111111';
const A = '33333333-3333-4333-8333-333333333333';
const CLOSED = "This is in a folder you can't open.";
const LOAD = { timeout: 15_000 };
const PROJECT = { id: P, name: 'Sales', updatedAt: '2026-10-01T10:00:00Z', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 1, sample: false };
const serve = (closed: boolean, extra: Record<string, { body: unknown }> = {}) =>
  serveRpc({
    '/api/auth/me': { body: { user: { email: 'v@acme.test', role: 'viewer' }, org: 'default', mode: 'header', canSignOut: false } },
    'projects:overview': { body: [PROJECT] },
    'projects:roles': { body: { [P]: 'viewer' } },
    'analysis:open': { body: { ok: false, error: 'That dashboard could not be loaded.' } },
    'dataset:columns': { body: null },
    'story:get': { body: null },
    'reports:open': { body: { ok: false, error: 'That report is gone.' } },
    'folder:of': { body: closed ? { ok: false, code: 'folder', reason: 'closed', error: CLOSED } : { ok: true } },
    ...extra,
  });

describe('a bookmark in a folder the caller cannot open', () => {
  it('a dashboard says so, in the server’s words', async () => {
    const calls = serve(true);
    renderApp(`/dashboards/${P}/${A}`);
    expect(await screen.findByText(CLOSED, {}, LOAD)).toBeTruthy();
    expect(screen.queryByText('That dashboard could not be loaded')).toBeNull();
    expect(calls.find((c) => c.channel === 'folder:of')?.payload).toEqual({ projectId: P, kind: 'dashboard', id: A });
  });
  it('a dataset says so, in the server’s words', async () => {
    const calls = serve(true);
    renderApp(`/data/${P}/${A}`);
    expect(await screen.findByText(CLOSED, {}, LOAD)).toBeTruthy();
    expect(screen.queryByText('Dataset not found')).toBeNull();
    expect(calls.find((c) => c.channel === 'folder:of')?.payload).toEqual({ projectId: P, kind: 'dataset', id: A });
  });
  it('a story says so too (it follows what it shows)', async () => {
    const calls = serve(true);
    renderApp(`/stories/${P}/${A}`);
    expect(await screen.findByText(CLOSED, {}, LOAD)).toBeTruthy();
    expect(calls.find((c) => c.channel === 'folder:of')?.payload).toEqual({ projectId: P, kind: 'story', id: A });
  });
  it('a report says so too', async () => {
    const calls = serve(true);
    renderApp(`/reports/${P}/${A}`);
    expect(await screen.findByText(CLOSED, {}, LOAD)).toBeTruthy();
    expect(screen.queryByText('That report is gone.')).toBeNull();
    expect(calls.find((c) => c.channel === 'folder:of')?.payload).toEqual({ projectId: P, kind: 'report', id: A });
  });
  it('NEGATIVE CONTROL: a missing report says it is gone, as before', async () => {
    serve(false);
    renderApp(`/reports/${P}/${A}`);
    expect(await screen.findByText('That report is gone.', {}, LOAD)).toBeTruthy();
    expect(screen.queryByText(CLOSED)).toBeNull();
  });
  it('NEGATIVE CONTROL: a missing one is "not found", as before', async () => {
    serve(false);
    renderApp(`/data/${P}/${A}`);
    expect(await screen.findByText('Dataset not found', {}, LOAD)).toBeTruthy();
    expect(screen.queryByText(CLOSED)).toBeNull();
  });
  it('NEGATIVE CONTROL: a dashboard that loads never asks folder:of', async () => {
    const board = { id: A, projectId: P, name: 'Pipeline', sheets: [{ id: 's1', name: 'Summary', cards: [] }], filters: [], style: {}, parameters: [], views: [], defaultViewId: '', updatedAt: '' };
    const calls = serve(true, { 'analysis:open': { body: { ok: true, analysis: board, visuals: [], tag: 'T', status: 'published', showing: 'published', published: { publishedAt: '2026-10-27T15:00:00Z' } } } });
    renderApp(`/dashboards/${P}/${A}`);
    expect(await screen.findByText('Pipeline', {}, LOAD)).toBeTruthy();
    expect(calls.some((c) => c.channel === 'folder:of')).toBe(false);
  });
});
