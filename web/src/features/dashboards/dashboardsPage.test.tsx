// The Dashboards page (docs/superpowers/specs/2026-10-27-dashboards-in-app-design.md): it lists only Ready dashboards,
// with no tabs, and opens them in view mode; the published list keeps only its address (`&tab=links`); the view page is
// the editing canvas with no editing tool (no Edit, layout size, History, Lineage, or sheet tabs for one sheet), its own
// header (Dashboards / project, then Compare, Subscribe, Expand and ⋯ with Copy link — the live in-app address, for
// everyone — and no Present); the editing screen has no Publish…, and its Ready switch (a stopgap over Publish) writes
// `analysis:publish` / `analysis:unpublish` and nothing else.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../test-utils';
import { boardPath } from '../analyses/editor/context';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '11111111-1111-4111-8111-111111111111';
const A1 = '33333333-3333-4333-8333-333333333333';
const A2 = '44444444-4444-4444-8444-444444444444';
const PROJECT = { id: P, name: 'Sales', updatedAt: '2026-10-01T10:00:00Z', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 2, sample: false };
const board = (id: string, name: string, ready?: true) => ({ id, name, sheetCount: 2, updatedAt: '2026-10-01T10:00:00Z', previews: [], sheets: [], status: ready ? 'published' : 'draft' });
const analysis = () => ({
  id: A1, projectId: P, name: 'Board', sheets: [{ id: 's1', name: 'Sheet 1', cards: [] }], filters: [], style: {}, parameters: [], views: [], defaultViewId: '', updatedAt: '',
});
const opened = (status: 'draft' | 'published' = 'draft') => ({ ok: true, analysis: analysis(), visuals: [], tag: 'T1', status, showing: 'draft' });

function serve(role: 'admin' | 'viewer', extra: Record<string, RpcReply> = {}) {
  return serveRpc({
    '/api/auth/me': { body: { user: { email: 'dev@local', role: role === 'viewer' ? 'viewer' : 'admin' }, org: 'default', mode: 'dev', canSignOut: false } },
    'projects:overview': { body: [PROJECT] },
    'projects:roles': { body: { [P]: role } },
    'analysis:gallery': { body: [board(A1, 'Ready board', true), board(A2, 'Draft board')] },
    'publish:sites': { body: { sites: [], publicLinks: false } },
    'publish:targets': { body: { dashboards: [{ id: A1, name: 'Ready board' }], stories: [], scorecards: [] } },
    'publish:plan': { body: { ok: true, plan: { pages: [], bytes: 0, combos: 0, tooBig: false } } },
    'analysis:open': { body: opened() },
    ...extra,
  });
}

// Radix opens its menu on pointerdown or Enter, never on a plain click, so the trigger is focused and sent Enter.
async function openMore() {
  const more = await screen.findByRole('button', { name: 'More dashboard actions' });
  act(() => more.focus());
  fireEvent.keyDown(more, { key: 'Enter' });
  await screen.findByRole('menuitem', { name: 'Export HTML' });
}

describe('Dashboards page', () => {
  it('opens on the Ready dashboards, each a link to its view page; a dashboard not Ready is not listed', async () => {
    serve('admin');
    renderApp(`/dashboards?project=${P}`);
    const card = await screen.findByRole('link', { name: /Ready board/ });
    expect(card.getAttribute('href')).toBe(`/dashboards/${P}/${A1}`);
    expect(screen.queryByText('Draft board')).toBeNull();
    // No tabs: the Ready dashboards are the page.
    expect(screen.queryByRole('tab', { name: 'Shared links' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Dashboards' })).toBeNull();
  });

  it('with none Ready, says what Ready means — an editor gets the way to Analyses, and Create dashboard in the header', async () => {
    serve('admin', { 'analysis:gallery': { body: [board(A2, 'Draft board')] } });
    renderApp(`/dashboards?project=${P}`);
    await screen.findByRole('heading', { name: 'No dashboards are Ready yet' });
    expect(screen.getByText(/switch Ready on at the top of one/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to Analyses' }).getAttribute('href')).toBe(`/analyses?project=${P}`);
    expect(screen.getAllByRole('link', { name: 'Create dashboard' })).toHaveLength(1); // the header's, not repeated
  });

  it('NEGATIVE CONTROL: a viewer’s empty state offers nothing to create', async () => {
    serve('viewer', { 'analysis:gallery': { body: [] } });
    renderApp(`/dashboards?project=${P}`);
    await screen.findByText(/once an editor of this project marks it Ready/);
    expect(screen.queryByRole('link', { name: 'Create dashboard' })).toBeNull();
  });

  it('the published list keeps its address but no tab: &dashboard= opens Publish on it, and closing stays on the list', async () => {
    const calls = serve('admin');
    const router = renderApp(`/dashboards?project=${P}&dashboard=${A1}`);
    await screen.findByRole('dialog', { name: 'Publish' });
    expect(screen.queryByRole('tab', { name: 'Shared links', hidden: true })).toBeNull();
    expect(calls.some((c) => c.channel === 'analysis:gallery')).toBe(false); // the Ready list is never asked for
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Publish' }), { key: 'Escape' });
    await waitFor(() => expect(router.state.location.search).toBe(`?project=${P}&tab=links`));
    await screen.findByRole('heading', { name: 'Nothing published yet' });
  });
});

describe('The view page', () => {
  it('is the canvas with no editing tool: Dashboards / project back to the list, no badge, no Edit, no Present, and Copy link in ⋯ for an editor too', async () => {
    serve('admin');
    renderApp(`/dashboards/${P}/${A1}`);
    await screen.findByRole('heading', { level: 1, name: 'Board' });
    const crumbs = within(screen.getByRole('navigation', { name: 'Breadcrumb' }));
    expect(crumbs.getByRole('link', { name: 'Dashboards' }).getAttribute('href')).toBe(`/dashboards?project=${P}`);
    expect((await crumbs.findByRole('link', { name: 'Sales' })).getAttribute('href')).toBe(`/dashboards?project=${P}`);
    for (const tool of ['Add sheet', 'Nothing to undo', 'Ready']) expect(screen.queryByRole('button', { name: tool }) ?? screen.queryByRole('switch', { name: tool })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Add to the sheet' })).toBeNull();
    expect(screen.queryByText('View only')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Layout size' })).toBeNull();
    expect(screen.queryByRole('tablist', { name: 'Sheets' })).toBeNull(); // one sheet: nothing to switch between
    expect(screen.queryByRole('button', { name: 'Share link' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Present' })).toBeNull(); // Expand takes its place
    expect(screen.getByRole('button', { name: 'Expand' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Subscribe' })).toBeTruthy(); // a reader's own write: an editor keeps it here
    expect(screen.queryByRole('button', { name: 'Copy link' })).toBeNull(); // in ⋯
    await openMore();
    expect(screen.getByRole('menuitem', { name: 'Copy link' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Comments' })).toBeTruthy();
  });

  it('Expand lays the dashboard over the window and keeps its header; the button and Esc give the window back', async () => {
    serve('viewer');
    renderApp(`/dashboards/${P}/${A1}`);
    const expand = await screen.findByRole('button', { name: 'Expand' });
    const root = () => document.querySelector('[data-viewing]') as HTMLElement;
    const before = root().className;
    fireEvent.click(expand);
    const exit = screen.getByRole('button', { name: 'Exit full screen' });
    expect(exit.getAttribute('aria-pressed')).toBe('true');
    expect(root().className).not.toBe(before);
    expect(screen.getByRole('heading', { level: 1, name: 'Board' })).toBeTruthy(); // the header stays
    fireEvent.keyDown(document, { key: 'Escape' });
    await screen.findByRole('button', { name: 'Expand' });
    expect(root().className).toBe(before);
    fireEvent.click(screen.getByRole('button', { name: 'Expand' }));
    fireEvent.click(screen.getByRole('button', { name: 'Exit full screen' }));
    expect(root().className).toBe(before);
  });

  it('a dashboard of two sheets keeps its sheet tabs on the view page', async () => {
    const sheets = [{ id: 's1', name: 'Sheet 1', cards: [] }, { id: 's2', name: 'Sheet 2', cards: [] }];
    serve('admin', { 'analysis:open': { body: { ok: true, analysis: { ...analysis(), sheets }, visuals: [], tag: 'T1' } } });
    renderApp(`/dashboards/${P}/${A1}`);
    const tabs = await screen.findByRole('tablist', { name: 'Sheets' });
    expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Sheet 1', 'Sheet 2']);
  });

  for (const role of ['admin', 'viewer'] as const) {
    it(`Copy link copies the live in-app address for ${role === 'admin' ? 'an editor' : 'a viewer'} — no Publish, no leaving the page`, async () => {
      serve(role);
      const writeText = vi.fn(async () => undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      const router = renderApp(`/dashboards/${P}/${A1}`);
      await openMore();
      fireEvent.click(screen.getByRole('menuitem', { name: 'Copy link' }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/dashboards/${P}/${A1}`));
      expect(router.state.location.pathname).toBe(`/dashboards/${P}/${A1}`);
      expect(screen.queryByRole('dialog', { name: 'Publish' })).toBeNull();
      expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Share link' })).toBeNull();
      if (role === 'viewer') expect(screen.queryByRole('button', { name: 'Subscribe' })).toBeNull();
    });
  }

  it('reading writes nothing: Export HTML from the view page sends no dashboard save, even for an editor', async () => {
    const calls = serve('admin', { 'dashboard:exportHtml': { body: { ok: false, error: 'Not in this test.' } } });
    renderApp(`/dashboards/${P}/${A1}`);
    await openMore();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export HTML' }));
    await waitFor(() => expect(calls.some((c) => c.channel === 'dashboard:exportHtml')).toBe(true));
    expect(calls.some((c) => c.channel === 'analysis:update')).toBe(false);
  });

  it('the view page’s ⋯ menu is the link, comments, export and print — no History, no Lineage', async () => {
    serve('admin');
    renderApp(`/dashboards/${P}/${A1}`);
    await openMore();
    expect(screen.getByRole('menuitem', { name: 'Print or save as PDF' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'History' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Lineage' })).toBeNull();
  });

  it('NEGATIVE CONTROL: an editor on the editing screen keeps layout size, the sheet tabs, History and Lineage (and has no Publish…)', async () => {
    serve('admin');
    renderApp(`/analyses/${P}/${A1}`);
    await screen.findByRole('tablist', { name: 'Sheets' });
    expect(screen.getByRole('group', { name: 'Layout size' })).toBeTruthy();
    await openMore();
    expect(screen.getByRole('menuitem', { name: 'History' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Lineage' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Publish…' })).toBeNull(); // Ready is the switch that puts it in front of readers
  });

  it('links to another dashboard stay on the view page while viewing, and on the editing screen while editing', () => {
    expect(boardPath({ projectId: P, viewing: true }, A2)).toBe(`/dashboards/${P}/${A2}`);
    expect(boardPath({ projectId: P, viewing: false }, A2)).toBe(`/analyses/${P}/${A2}`);
  });
});

describe('The Ready switch', () => {
  it('writes analysis:publish alone — no autosave — and reads what it wrote', async () => {
    const calls = serve('admin', { 'analysis:publish': { body: { ok: true, status: 'published', published: { publishedAt: '2026-10-29T10:00:00Z' } } } });
    renderApp(`/analyses/${P}/${A1}`);
    const sw = await screen.findByRole('switch', { name: 'Ready' });
    expect((sw as HTMLInputElement).checked).toBe(false);
    fireEvent.click(sw);
    await waitFor(() => expect(calls.find((c) => c.channel === 'analysis:publish')?.payload).toEqual({ projectId: P, id: A1 }));
    expect((sw as HTMLInputElement).checked).toBe(true);
    await new Promise((r) => setTimeout(r, 800)); // past the 600 ms autosave
    expect(calls.some((c) => c.channel === 'analysis:update')).toBe(false);
  });

  it('a refused write puts the switch back and says why', async () => {
    serve('admin', { 'analysis:open': { body: opened('published') }, 'analysis:unpublish': { body: { ok: false, error: 'That dashboard is gone.' } } });
    renderApp(`/analyses/${P}/${A1}`);
    const sw = await screen.findByRole('switch', { name: 'Ready' });
    expect((sw as HTMLInputElement).checked).toBe(true);
    fireEvent.click(sw);
    await screen.findByText('That dashboard is gone.');
    expect((sw as HTMLInputElement).checked).toBe(true);
  });

  it('NEGATIVE CONTROL: a viewer on the editing screen has no Ready switch', async () => {
    serve('viewer');
    renderApp(`/analyses/${P}/${A1}`);
    await screen.findByText('View only');
    expect(screen.queryByRole('switch', { name: 'Ready' })).toBeNull();
  });
});
