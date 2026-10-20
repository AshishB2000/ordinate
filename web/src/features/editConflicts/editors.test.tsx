// The editors around the guard (docs/edit-conflicts/00-design.md):
//
//   reopen    a report, a scenario and a scorecard open from a FRESH read: left
//             and reopened after someone else's save, the editor shows that save
//             and its next save sends that save's tag — no false banner (each
//             page read the record twice: the cached copy was not used);
//   KindProps the dashboard's Interactions checkbox refused 409: the visual is
//             read again — its settings and its tag — the user is told, and the
//             next click sends the new tag (CONTROL: any other failure is only
//             its sentence, nothing re-read);
//   scorecard Save mine as a copy after a refused period pick carries the
//             period picked here, not the one the server holds.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../test-utils';
import { Toaster } from '../../ui/Toast';
import { EditorCtx, type EditorApi } from '../analyses/editor/context';
import { InteractionProps } from '../analyses/editor/KindProps';
import type { VisualDef } from '../analyses/api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '11111111-1111-4111-8111-111111111111';
const R = '22222222-2222-4222-8222-222222222222';
const LAZY = 15_000;
const CHANGED = { status: 409, body: { error: 'record_changed', code: 'record_changed', message: 'Changed elsewhere.', tag: 'ELSEWHERE' } };
const shell = (extra: Record<string, RpcReply>): Record<string, RpcReply> => ({
  'projects:list': { body: [{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }] },
  'projects:roles': { body: { [P]: 'editor' } },
  ...extra,
});
const sent = (calls: { channel: string; payload: unknown }[], channel: string) => calls.filter((c) => c.channel === channel).map((c) => c.payload as Record<string, unknown>);

/** The server's copy, which someone else changes while the editor is closed. */
function server<T extends object>(first: T) {
  const s = { rec: first, tag: 'T1', reads: 0 };
  return {
    s,
    change: (rec: T) => {
      s.rec = rec;
      s.tag = 'T2';
    },
  };
}

describe('editors open from a fresh read', { timeout: 40_000 }, () => {
  it('a report: reopened after another save, the builder shows it and saves from its tag', async () => {
    const REPORT = {
      id: R, projectId: P, analysisId: R, name: 'Weekly', format: 'pdf', pages: [{ id: 'c', kind: 'cover', include: true }],
      cover: { title: 'Weekly', logo: true }, paper: { size: 'letter', orientation: 'portrait' }, includeFilters: true, narrative: false, discussion: false, updatedAt: '',
    };
    const { s, change } = server(REPORT);
    const calls = serveRpc(shell({
      'reports:open': () => (s.reads++, { body: { ok: true, report: s.rec, dashboard: { id: R, name: 'Board' }, sheets: [], views: [], missing: false, tag: s.tag } }),
      'reports:update': (p) => ({ body: { ok: true, report: { ...s.rec, ...(p as { patch: object }).patch }, tag: 'T3' } }),
    }));
    const router = renderApp(`/reports/${P}/${R}`);
    await screen.findByRole('heading', { level: 1, name: 'Weekly' }, { timeout: LAZY });
    await act(() => router.navigate(`/reports?project=${P}`));
    await waitFor(() => expect(screen.queryByLabelText('Report name')).toBeNull(), { timeout: LAZY }); // the builder is closed
    change({ ...REPORT, name: 'Renamed elsewhere' });
    await act(() => router.navigate(`/reports/${P}/${R}`));
    await screen.findByRole('heading', { level: 1, name: 'Renamed elsewhere' }, { timeout: LAZY });
    expect(s.reads).toBe(2);
    const name = screen.getByLabelText('Report name');
    fireEvent.change(name, { target: { value: 'Mine' } });
    fireEvent.blur(name);
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent(calls, 'reports:update')).toHaveLength(1));
    expect(sent(calls, 'reports:update')[0]).toMatchObject({ base: 'T2', patch: { name: 'Mine' } });
    expect(screen.queryByText(/was changed in another tab/)).toBeNull();
  });

  it('a scenario: reopened after another save, the editor shows it and saves from its tag', async () => {
    const SC = { id: R, name: 'Price +5%', baseMetricIds: [], drivers: [] };
    const { s, change } = server(SC);
    const calls = serveRpc(shell({
      'scenario:get': () => (s.reads++, { body: { ...s.rec, tag: s.tag } }),
      'scenario:compute': { body: { ok: true, metrics: [], drivers: [], tornado: null, notes: [] } },
      'scenario:targets': { body: { ok: true, columns: [], metrics: [], datasets: [] } },
      'scenario:update': () => ({ body: { ok: true, scenario: s.rec, tag: 'T3' } }),
    }));
    const router = renderApp(`/analytics/scenarios/${P}/${R}`);
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Scenario name' }) as HTMLInputElement).value).toBe('Price +5%'), { timeout: LAZY });
    await act(() => router.navigate(`/analytics/scenarios/${P}`));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Scenario name' })).toBeNull(), { timeout: LAZY }); // the editor is closed
    change({ ...SC, name: 'Renamed elsewhere' });
    await act(() => router.navigate(`/analytics/scenarios/${P}/${R}`));
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Scenario name' }) as HTMLInputElement).value).toBe('Renamed elsewhere'), { timeout: LAZY });
    expect(s.reads).toBe(2);
    fireEvent.change(screen.getByRole('textbox', { name: 'Scenario name' }), { target: { value: 'Mine' } });
    await waitFor(() => expect(sent(calls, 'scenario:update')).toHaveLength(1), { timeout: 3000 });
    expect(sent(calls, 'scenario:update')[0]).toMatchObject({ base: 'T2', patch: { name: 'Mine' } });
  });

  it('a scorecard: reopened after another save, the page shows it and saves from its tag', async () => {
    const SC = { id: R, projectId: P, name: 'Targets', period: 'month', rows: [], updatedAt: '' };
    const { s, change } = server(SC);
    const calls = serveRpc(shell({
      'scorecard:get': () => (s.reads++, { body: { ...s.rec, tag: s.tag } }),
      'scorecard:compute': { body: { ok: true, id: R, name: 'Targets', period: 'month', window: { from: '2026-09-01', to: '2026-09-30', label: 'September 2026', offset: 0 }, rows: [], groups: [], counts: { good: 0, warn: 0, off: 0, none: 0 } } },
      'scorecard:update': () => ({ body: { ok: true, scorecard: s.rec, tag: 'T3' } }),
    }));
    const router = renderApp(`/scorecards/${P}/${R}`);
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Scorecard name' }) as HTMLInputElement).value).toBe('Targets'), { timeout: LAZY });
    await act(() => router.navigate(`/reports?project=${P}&tab=scorecards`));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Scorecard name' })).toBeNull(), { timeout: LAZY }); // the page is closed
    change({ ...SC, name: 'Renamed elsewhere' });
    await act(() => router.navigate(`/scorecards/${P}/${R}`));
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Scorecard name' }) as HTMLInputElement).value).toBe('Renamed elsewhere'), { timeout: LAZY });
    expect(s.reads).toBe(2);
    const box = screen.getByRole('textbox', { name: 'Scorecard name' });
    fireEvent.change(box, { target: { value: 'Mine' } });
    fireEvent.blur(box);
    await waitFor(() => expect(sent(calls, 'scorecard:update')).toHaveLength(1));
    expect(sent(calls, 'scorecard:update')[0]).toMatchObject({ base: 'T2', patch: { name: 'Mine' } });
  });
});

describe('a scorecard refused mid-edit', { timeout: 40_000 }, () => {
  it('Save mine as a copy carries the period picked here, not the server’s', async () => {
    const SC = { id: R, projectId: P, name: 'Targets', period: 'month', rows: [{ metricId: R }], updatedAt: '', tag: 'T1' };
    const calls = serveRpc(shell({
      'scorecard:get': { body: SC },
      'scorecard:compute': { body: { ok: true, id: R, name: 'Targets', period: 'month', window: { from: '2026-09-01', to: '2026-09-30', label: 'September 2026', offset: 0 }, rows: [], groups: [], counts: { good: 0, warn: 0, off: 0, none: 0 } } },
      'scorecard:update': CHANGED,
      'scorecard:create': { body: { ok: true, scorecard: { id: '33333333-3333-4333-8333-333333333333' } } },
    }));
    renderApp(`/scorecards/${P}/${R}`);
    const period = await screen.findByRole('combobox', { name: 'Period' }, { timeout: LAZY });
    period.focus();
    fireEvent.keyDown(period, { key: 'ArrowDown' }); // opens on Monthly
    fireEvent.keyDown(period, { key: 'ArrowDown' }); // Quarterly
    fireEvent.keyDown(period, { key: 'Enter' });
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('This scorecard was changed in another tab or by someone else.');
    expect(screen.getByRole('combobox', { name: 'Period' }).textContent).toBe('Quarterly'); // the pick is kept on screen
    fireEvent.click(within(banner).getByRole('button', { name: 'Save mine as a copy' }));
    await waitFor(() => expect(sent(calls, 'scorecard:create')).toHaveLength(1));
    expect(sent(calls, 'scorecard:create')[0]).toMatchObject({ name: 'Targets (copy)', period: 'quarter', rows: [{ metricId: R }] });
  });
});

describe('the dashboard’s Interactions after a 409', () => {
  const DEF: VisualDef = { id: R, name: 'By region', datasetId: R, chartType: 'bar', encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] }, overrides: {}, filters: [], updatedAt: '', tag: 'OLD' };
  function mount(def: VisualDef, addVisuals = vi.fn()) {
    const api = { projectId: P, sheet: 0, doc: { sheets: [{ clickFilter: false }] }, addVisuals } as unknown as EditorApi;
    const r = render(
      <>
        <EditorCtx.Provider value={api}>
          <InteractionProps def={def} />
        </EditorCtx.Provider>
        <Toaster />
      </>,
    );
    return { addVisuals, rerender: (d: VisualDef) => r.rerender(<><EditorCtx.Provider value={api}><InteractionProps def={d} /></EditorCtx.Provider><Toaster /></>) };
  }

  it('reads the visual again, says so, and the next click sends its new tag', async () => {
    let refuse = true;
    const calls = serveRpc({
      'visual:update': () => (refuse ? CHANGED : { body: { ok: true, visual: { ...DEF, overrides: { showTooltips: true } }, tag: 'NEWER' } }),
      'visual:get': { body: { ...DEF, projectId: P, favorite: false, createdAt: '', overrides: { showTooltips: false }, tag: 'NEW' } },
    });
    const { addVisuals, rerender } = mount(DEF);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show tooltips' }));
    await waitFor(() => expect(addVisuals).toHaveBeenCalled());
    const now = (addVisuals.mock.calls[0][0] as VisualDef[])[0];
    expect(now).toMatchObject({ id: R, overrides: { showTooltips: false }, tag: 'NEW' });
    expect(await screen.findByText(/This visual was changed in another tab or by someone else/)).toBeTruthy();
    expect(sent(calls, 'visual:update')[0]).toMatchObject({ base: 'OLD' });
    refuse = false;
    rerender(now);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show tooltips' }));
    await waitFor(() => expect(sent(calls, 'visual:update')).toHaveLength(2));
    expect(sent(calls, 'visual:update')[1]).toMatchObject({ base: 'NEW', overrides: { showTooltips: true } });
  });

  it('CONTROL: any other failure is its sentence, and nothing is read again', async () => {
    const calls = serveRpc({ 'visual:update': { status: 500, body: { error: 'handler failed' } } });
    const { addVisuals } = mount(DEF);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show tooltips' }));
    expect(await screen.findByText('handler failed')).toBeTruthy();
    expect(sent(calls, 'visual:get')).toHaveLength(0);
    expect(addVisuals).not.toHaveBeenCalled();
  });
});
