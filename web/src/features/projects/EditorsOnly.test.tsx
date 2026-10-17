// A page whose only job is writing tells a viewer so — and never mounts the
// page under it, so not one of its reads (prepare:get, input:load) is sent.
// Each case has its editor negative control: the same URL opens the page.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../test-utils';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const ME = { user: { email: 'dev@local', role: 'viewer' }, org: 'default', mode: 'dev', canSignOut: false };
const PROJECT = { id: P, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false };

const routes = (role: string, extra: Record<string, RpcReply> = {}): Record<string, RpcReply> => ({
  '/api/auth/me': { body: ME },
  'projects:list': { body: [{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }] },
  'projects:overview': { body: [PROJECT] },
  'projects:roles': { body: { [P]: role } },
  'dataset:list': { body: [{ id: D, name: 'Orders', sourceKind: 'csv', rowCount: 3, columnCount: 2, updatedAt: '' }] },
  ...extra,
});

describe('EditorsOnly', () => {
  it('tells a viewer Prepare is for editors and never asks prepare:get; an editor gets the page', async () => {
    let calls = serveRpc(routes('viewer'));
    renderApp(`/data/${P}/${D}/prepare`);
    expect(await screen.findByRole('heading', { name: 'Preparing data is for editors' })).toBeTruthy();
    expect(screen.getByText(/You have view-only access\. Ask a project admin to make you an editor\./)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open the dataset' }).getAttribute('href')).toBe(`/data/${P}/${D}`);
    expect(calls.some((c) => c.channel === 'prepare:get')).toBe(false);
    cleanup();
    calls = serveRpc(routes('editor', { 'prepare:get': { body: null } }));
    renderApp(`/data/${P}/${D}/prepare`);
    await waitFor(() => expect(calls.some((c) => c.channel === 'prepare:get')).toBe(true));
    expect(screen.queryByRole('heading', { name: 'Preparing data is for editors' })).toBeNull();
  });

  it('tells a viewer an input table is for editors and never asks input:load; an editor loads it', async () => {
    let calls = serveRpc(routes('viewer'));
    renderApp(`/data/input/${P}/${D}`);
    expect(await screen.findByRole('heading', { name: 'Typing into an input table is for editors' })).toBeTruthy();
    expect(calls.some((c) => c.channel === 'input:load')).toBe(false);
    cleanup();
    calls = serveRpc(routes('admin', { 'input:load': { body: { ok: false, error: 'Not an input table.' } } }));
    renderApp(`/data/input/${P}/${D}`);
    await waitFor(() => expect(calls.some((c) => c.channel === 'input:load')).toBe(true));
  });

  it('tells a viewer bringing data in is for editors, with the way back to Data; an editor gets the sources', async () => {
    serveRpc(routes('viewer'));
    renderApp(`/data/import?project=${P}`);
    expect(await screen.findByRole('heading', { name: 'Bringing data in is for editors' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Data' }).getAttribute('href')).toBe(`/data/${P}`);
    expect(screen.queryByRole('navigation', { name: 'Sources' })).toBeNull();
    cleanup();
    serveRpc(routes('editor'));
    renderApp(`/data/import?project=${P}`);
    expect(await screen.findByRole('navigation', { name: 'Sources' })).toBeTruthy();
  });
});
