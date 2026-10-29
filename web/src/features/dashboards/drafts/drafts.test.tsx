// Drafts and Publish on the editing screen, the Preview and the view page (docs/superpowers/specs/2026-10-29-dashboard-
// drafts-publish-design.md, part 3): the editor's header in each state — Draft, Published, Edits not live — with Preview
// and Publish, Discard edits and Unpublish behind a confirmation, the "not live yet" strip from the version diff; the
// Publish dialog (what goes, and a 409 when someone else saved); the Preview strip; the published view's Edit and
// "edits not live" line, for an editor only. A viewer reads, read-only, whatever they open.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../../test-utils';
import { PRIMARY_SELECTOR } from '../../../ui/Button';
import { contentsOf, publishedDay } from './state';

// The editor is a lazy chunk with the whole app around it: its first open in a file is slow on a busy machine.
vi.setConfig({ testTimeout: 30_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '11111111-1111-4111-8111-111111111111';
const A = '33333333-3333-4333-8333-333333333333';
const D = '55555555-5555-4555-8555-555555555555';
const AT = '2026-10-27T15:00:00Z';
const ME = 'priya@acme.test';
const PROJECT = { id: P, name: 'Sales', updatedAt: '2026-10-01T10:00:00Z', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 1, sample: false };
const kpi = (id: string, label: string) => ({ id, type: 'metric', layout: { x: 0, y: 0, w: 3, h: 2 }, metric: { datasetId: D, column: 'amount', aggregation: 'sum', label } });
const board = (name = 'Pipeline health') => ({
  id: A, projectId: P, name, sheets: [{ id: 's1', name: 'Summary', cards: [kpi('k1', 'Open deals')] }], filters: [], style: {}, parameters: [], views: [], defaultViewId: '', updatedAt: '',
});
type Status = 'draft' | 'published' | 'edited';
const meta = { publishedAt: AT, publishedBy: ME, versionKey: 'K-PUB' };
/**
 * The server, as far as these screens ask it. `analysis:open`: an editor gets the draft, or the copy when it asks and
 * there is one; a viewer always the copy. Publish and Unpublish move the status the next open reads.
 */
function serve(start: Status, role: 'admin' | 'viewer' = 'admin', extra: Record<string, RpcReply> = {}) {
  let status = start;
  const open: RpcReply = (payload) => {
    const copy = role === 'viewer' || ((payload as { published?: boolean }).published === true && status !== 'draft');
    return {
      body: {
        ok: true,
        analysis: board(),
        visuals: [],
        tag: copy ? 'COPY' : 'T1',
        status: role === 'viewer' ? 'published' : status,
        showing: copy ? 'published' : 'draft',
        ...(status === 'draft' ? {} : { published: role === 'viewer' ? { publishedAt: AT } : meta }),
      },
    };
  };
  return serveRpc({
    'analysis:publish': () => ((status = 'published'), { body: { ok: true, status, published: meta } }),
    'analysis:unpublish': () => ((status = 'draft'), { body: { ok: true, status } }),
    '/api/auth/me': { body: { user: { email: ME, role: role === 'viewer' ? 'viewer' : 'admin' }, org: 'default', mode: 'header', canSignOut: false } },
    'projects:overview': { body: [PROJECT] },
    'projects:roles': { body: { [P]: role } },
    'analysis:open': open,
    'versions:list': { body: [{ key: 'K-NOW', savedAt: '2026-10-28T10:00:00Z', summary: '' }, { key: 'K-PUB', savedAt: AT, summary: '' }] },
    'versions:diff': {
      body: {
        ok: true, from: { key: 'K-PUB', savedAt: AT }, to: { key: 'K-NOW', savedAt: AT }, summary: '1 card changed, 1 card added',
        counts: { changed: 1, added: 1, removed: 0, moved: 0, filters: 0, other: 0 }, changes: [], sheets: [], figures: 0,
      },
    },
    ...extra,
  });
}

/** The editor opens with the whole app around it: the first find of a test waits for that. */
const LOAD = { timeout: 15_000 };

// Radix opens its menu on pointerdown or Enter, never on a plain click, so the trigger is focused and sent Enter.
async function openMore() {
  const more = await screen.findByRole('button', { name: 'More dashboard actions' }, LOAD);
  act(() => more.focus());
  fireEvent.keyDown(more, { key: 'Enter' });
  await screen.findByRole('menuitem', { name: 'Export HTML' });
}
const menuItems = () => screen.getAllByRole('menuitem').map((m) => m.textContent?.trim());
/** The editor's header: a toast from an earlier test may say "Published" too. */
const head = () => within(document.querySelector('[data-print-root] header') as HTMLElement);
const day = publishedDay(AT);

describe('The editor’s header', () => {
  it('a draft: Draft, then Preview and Publish — the one primary — and back to Dashboards; no Ready switch', async () => {
    serve('draft');
    renderApp(`/analyses/${P}/${A}`);
    await screen.findByText('Draft', {}, LOAD);
    const back = screen.getAllByRole('link', { name: 'Dashboards' }).filter((a) => a.closest('[data-print-root] header'));
    expect(back.map((a) => a.getAttribute('href'))).toEqual([`/dashboards?project=${P}`]);
    expect(screen.getByRole('button', { name: 'Preview' })).toBeTruthy();
    const publish = screen.getByRole('button', { name: 'Publish' });
    expect(publish.matches(PRIMARY_SELECTOR)).toBe(true);
    expect(screen.queryByRole('button', { name: 'Discard edits' })).toBeNull();
    expect(screen.queryByRole('switch', { name: 'Ready' })).toBeNull();
    expect(screen.queryByText(/Not live yet/)).toBeNull();
    await openMore();
    expect(menuItems()).not.toContain('View published version');
    expect(menuItems()).not.toContain('Unpublish…');
  });

  it('published, in step with viewers: Published, and Publish is not the loud one; ⋯ has View published version and Unpublish…', async () => {
    serve('published');
    renderApp(`/analyses/${P}/${A}`);
    await screen.findByText('Published', {}, LOAD);
    expect(screen.getByRole('button', { name: 'Publish' }).matches(PRIMARY_SELECTOR)).toBe(false);
    expect(screen.queryByRole('button', { name: 'Discard edits' })).toBeNull();
    expect(screen.queryByText(/Not live yet/)).toBeNull();
    await openMore();
    expect(menuItems()[0]).toBe('View published version');
    expect(menuItems().at(-1)).toBe('Unpublish…');
  });

  it('edits not live: the date, Discard edits and Publish changes, and the strip saying what changed since — See changes opens the compare', async () => {
    const calls = serve('edited');
    renderApp(`/analyses/${P}/${A}`);
    await screen.findByText('Edits not live', {}, LOAD);
    expect(screen.getByText(`published ${day}`)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Discard edits' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Publish changes' }).matches(PRIMARY_SELECTOR)).toBe(true);
    await screen.findByText(`Not live yet: 1 card changed, 1 card added since you published on ${day}.`);
    expect(screen.getByRole('link', { name: 'See changes' }).getAttribute('href')).toBe(`/versions/${P}/dashboard/${A}?compare=K-PUB`);
    // The published version's key → the newest version: the server words the summary.
    expect(calls.find((c) => c.channel === 'versions:diff')?.payload).toEqual({ projectId: P, type: 'dashboard', id: A, from: 'K-PUB', to: 'K-NOW' });
  });

  it('edits not live, the published version pruned from History: the strip says so without counts or a compare', async () => {
    const calls = serve('edited', 'admin', { 'versions:diff': { body: { ok: false, error: 'That version is no longer kept.' } } });
    renderApp(`/analyses/${P}/${A}`);
    await screen.findByText(`Edits not live: viewers still see the version published on ${day}.`, {}, LOAD);
    await waitFor(() => expect(calls.some((c) => c.channel === 'versions:diff')).toBe(true));
    await new Promise((r) => setTimeout(r, 50)); // the refusal lands
    expect(screen.getByText(`Edits not live: viewers still see the version published on ${day}.`)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'See changes' })).toBeNull();
  });

  it('NEGATIVE CONTROL: a viewer’s editor is read-only on the copy — View only, nothing about drafts, nothing to publish', async () => {
    const calls = serve('edited', 'viewer');
    renderApp(`/analyses/${P}/${A}`);
    await screen.findByText('View only', {}, LOAD);
    for (const name of ['Preview', 'Publish', 'Publish changes', 'Discard edits']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.queryByText('Edits not live')).toBeNull();
    expect(screen.queryByText(/Not live yet/)).toBeNull();
    expect(calls.some((c) => c.channel.startsWith('versions:'))).toBe(false);
  });
});

describe('The Publish dialog', () => {
  it('says who sees it and what freezes, lists what goes, and publishes the draft as this editor saw it', async () => {
    const calls = serve('draft');
    renderApp(`/analyses/${P}/${A}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }, LOAD));
    const dialog = await screen.findByRole('dialog', { name: 'Publish “Pipeline health”?' });
    expect(within(dialog).getByText('Everyone in Sales can see it')).toBeTruthy();
    expect(within(dialog).getByText('Viewers see this version')).toBeTruthy();
    expect(within(dialog).getByText('Figures stay live')).toBeTruthy();
    expect(within(within(dialog).getByRole('list', { name: 'What is published' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['1 sheet', '1 KPI']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The tag the editor opened on: a draft moved since would be refused.
    expect(calls.find((c) => c.channel === 'analysis:publish')?.payload).toEqual({ projectId: P, id: A, base: 'T1' });
    await screen.findByRole('button', { name: 'Preview' });
    expect(screen.getByRole('button', { name: 'Publish' }).matches(PRIMARY_SELECTOR)).toBe(false); // now in step
    expect(calls.some((c) => c.channel === 'analysis:update')).toBe(false); // Publish is not an edit
  });

  it('someone else saved first (409 record_changed): nothing went live, it says why, and Reload is the way on', async () => {
    const changed = { status: 409, body: { error: 'record_changed', code: 'record_changed', message: 'This dashboard was changed in another tab or by someone else.', tag: 'ELSEWHERE' } };
    const calls = serve('draft', 'admin', { 'analysis:publish': changed });
    renderApp(`/analyses/${P}/${A}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }, LOAD));
    const dialog = await screen.findByRole('dialog', { name: 'Publish “Pipeline health”?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }));
    await within(dialog).findByText(/Someone else saved this dashboard after you opened it, so nothing was published/);
    expect(within(dialog).queryByRole('button', { name: 'Publish' })).toBeNull(); // no second try that would publish their edits unseen
    const opens = calls.filter((c) => c.channel === 'analysis:open').length;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(calls.filter((c) => c.channel === 'analysis:open').length).toBe(opens + 1));
  });
});

describe('Discard edits and Unpublish', () => {
  it('Discard edits asks first, says charts stay as they are in Visuals, then opens the restored draft', async () => {
    const restored = { ...board('Pipeline health (as published)') };
    const calls = serve('edited', 'admin', { 'analysis:discard': { body: { ok: true, analysis: restored, tag: 'T2', status: 'published', published: meta } } });
    renderApp(`/analyses/${P}/${A}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Discard edits' }, LOAD));
    const dialog = await screen.findByRole('dialog', { name: 'Discard your edits?' });
    expect(within(dialog).getByText(/Charts show as they are now in Visuals/)).toBeTruthy();
    expect(calls.some((c) => c.channel === 'analysis:discard')).toBe(false); // not before the confirmation
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard edits' }));
    await screen.findByRole('button', { name: 'Pipeline health (as published)' }); // the restored draft, in a new editor
    expect(head().getByText('Published')).toBeTruthy();
    expect(calls.filter((c) => c.channel === 'analysis:discard')).toHaveLength(1);
  });

  it('Unpublish asks first — off the Dashboards page, the draft stays — then the header reads Draft', async () => {
    const calls = serve('published');
    renderApp(`/analyses/${P}/${A}`);
    await openMore();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unpublish…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unpublish “Pipeline health”?' });
    expect(within(dialog).getByText(/comes off the Dashboards page.*Your draft stays/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unpublish' }));
    await waitFor(() => expect(head().getByText('Draft')).toBeTruthy());
    expect(calls.find((c) => c.channel === 'analysis:unpublish')?.payload).toEqual({ projectId: P, id: A });
  });
});

describe('The Preview', () => {
  it('the view page on the draft, under its strip: Back to editing, or Publish — which then shows the published version', async () => {
    const calls = serve('draft');
    const router = renderApp(`/dashboards/${P}/${A}?draft=1`);
    const strip = await screen.findByRole('region', { name: 'Preview' }, LOAD);
    expect(strip.textContent).toContain('This is how viewers will see this dashboard once you publish it.');
    expect(within(strip).getByRole('link', { name: 'Back to editing' }).getAttribute('href')).toBe(`/analyses/${P}/${A}`);
    expect(calls.find((c) => c.channel === 'analysis:open')?.payload).toEqual({ projectId: P, id: A }); // the draft
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Add to the sheet' })).toBeNull(); // the view page: read-only
    fireEvent.click(within(strip).getByRole('button', { name: 'Publish' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish “Pipeline health”?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
    expect(calls.find((c) => c.channel === 'analysis:publish')?.payload).toEqual({ projectId: P, id: A, base: 'T1' });
    await screen.findByRole('link', { name: 'Edit' });
    expect(screen.queryByRole('region', { name: 'Preview' })).toBeNull();
  });

  it('an editor opening a dashboard never published on the view page gets the Preview', async () => {
    serve('draft');
    renderApp(`/dashboards/${P}/${A}`);
    await screen.findByRole('region', { name: 'Preview' }, LOAD);
  });

  it('NEGATIVE CONTROL: a viewer asking for the draft is sent the published copy — no strip, nothing to publish', async () => {
    serve('published', 'viewer');
    renderApp(`/dashboards/${P}/${A}?draft=1`);
    await screen.findByRole('heading', { level: 1, name: 'Pipeline health' }, LOAD);
    await screen.findByText(`Published ${day}`, { exact: false });
    expect(screen.queryByRole('region', { name: 'Preview' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
  });
});

describe('The published view', () => {
  it('an editor gets Edit, and — the draft holding edits not live — a line with the way to it', async () => {
    const calls = serve('edited');
    renderApp(`/dashboards/${P}/${A}`);
    const edit = await screen.findByRole('link', { name: 'Edit' }, LOAD);
    expect(edit.getAttribute('href')).toBe(`/analyses/${P}/${A}`);
    expect(calls.find((c) => c.channel === 'analysis:open')?.payload).toEqual({ projectId: P, id: A, published: true });
    await screen.findByText(/You have edits that aren’t live yet/);
    expect(screen.getByRole('link', { name: 'Open the draft' }).getAttribute('href')).toBe(`/analyses/${P}/${A}`);
    expect(screen.queryByRole('region', { name: 'Preview' })).toBeNull();
  });

  it('in step, an editor gets Edit and no line', async () => {
    serve('published');
    renderApp(`/dashboards/${P}/${A}`);
    await screen.findByRole('link', { name: 'Edit' }, LOAD);
    expect(screen.queryByText(/edits that aren’t live/)).toBeNull();
  });

  it('NEGATIVE CONTROL: a viewer gets neither Edit nor the line', async () => {
    serve('edited', 'viewer');
    renderApp(`/dashboards/${P}/${A}`);
    await screen.findByRole('heading', { level: 1, name: 'Pipeline health' }, LOAD);
    await screen.findByText(`Published ${day}`, { exact: false });
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
    expect(screen.queryByText(/edits that aren’t live/)).toBeNull();
  });
});

describe('helpers', () => {
  it('lists what Publish freezes, leaving out what there is none of', () => {
    const control = { id: 'c', type: 'control', layout: { x: 0, y: 0, w: 3, h: 1 } };
    const chart = { id: 'v', type: 'visual', layout: { x: 0, y: 0, w: 6, h: 4 }, visualId: 'x' };
    const sheets = [{ id: 'a', name: 'A', cards: [chart, chart, control] }, { id: 'b', name: 'B', cards: [kpi('k', 'K')] }];
    expect(contentsOf({ sheets, filters: [{ type: 'filter' }] })).toEqual(['2 sheets', '2 charts', '1 KPI', '2 filters']);
    expect(contentsOf({ sheets: [{ id: 'a', name: 'A', cards: [] }], filters: [] })).toEqual(['1 sheet']);
  });

  it('a date this year without its year, an older one with it, nothing for no date', () => {
    const now = new Date('2026-10-29T12:00:00Z');
    expect(publishedDay('2026-10-27T15:00:00Z', now)).not.toMatch(/2026/);
    expect(publishedDay('2025-10-27T15:00:00Z', now)).toMatch(/2025/);
    expect(publishedDay(undefined, now)).toBe('');
  });
});
