import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../test-utils';
import { PRIMARY_SELECTOR } from '../../ui/Button';
import { startDownload } from '../../api/files';

vi.mock('../../api/files', () => ({ startDownload: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.mocked(startDownload).mockClear();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const O = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
/** The Data model is a lazy chunk: its first render waits on a transform (long under load). */
const LAZY = { timeout: 15_000 };
const EXPORTED = { ok: true, downloadToken: 'tok-1', counts: { datasets: 1, metrics: 2, terms: 0, relationships: 0 }, notCarried: ['metricTrees', 'instructions'] };

function serve(routes: Record<string, RpcReply> = {}, role: 'editor' | 'viewer' = 'editor') {
  const body = (b: unknown) => ({ body: b });
  return serveRpc({
    '/api/auth/me': body({ user: { email: 'pat@acme.test', role: 'member' }, org: 'acme', mode: 'oidc', canSignOut: true }),
    'projects:list': body([{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }]),
    'projects:overview': body([{ id: P, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false }]),
    'projects:roles': body({ [P]: role }),
    'dataset:list': body([{ id: O, name: 'Orders', sourceKind: 'csv', rowCount: 10, columnCount: 3, updatedAt: '2026-10-01T10:00:00Z' }]),
    'model:overview': body({ ok: true, tables: [], todo: [], more: 0 }),
    'model:export': body(EXPORTED),
    ...routes,
  });
}

const OSSIE = {
  ok: true, downloadToken: 'tok-2', version: '0.2.0.dev0',
  report: {
    noSource: ['Customers', 'Orders'],
    notMapped: [
      { kind: 'term', name: 'EMEA', reason: 'Ossie has no named filters; the term is kept in the ordinate extension.' },
      { kind: 'term', name: 'Big orders', reason: 'Ossie has no named filters; the term is kept in the ordinate extension.' },
      { kind: 'valueLabels', name: 'region', reason: 'Ossie has no value labels; they are kept in the ordinate extension.' },
      { kind: 'metric', name: 'Avg basket', reason: 'Ossie metrics cannot refer to other metrics, so a formula, period or funnel metric is not exported.' },
      { kind: 'calculated', name: 'Margin', reason: "Ossie fields are the source table's columns, so a calculated field, and a metric over one, is not exported." },
    ],
  },
};

const openExport = async () => {
  fireEvent.pointerDown(await screen.findByRole('button', { name: 'Export' }, LAZY), { button: 0, pointerType: 'mouse' });
  return screen.findByRole('menuitem', { name: 'Model files' });
};

describe('The Data model: Export ▾', () => {
  it('Model files asks model:export for this project and downloads its token, and says what the files do not carry', async () => {
    const calls = serve();
    renderApp(`/model/${P}`);
    fireEvent.click(await openExport());
    await waitFor(() => expect(startDownload).toHaveBeenCalledWith('tok-1'));
    expect(calls.filter((c) => c.channel === 'model:export').map((c) => c.payload)).toEqual([{ projectId: P }]);
    expect(await screen.findByText('Exported the model files. Not in them: metric trees and Assistant instructions.')).toBeTruthy();
  }, 30_000); // the first test pays for the lazy route chunk's transform

  it('a project with nothing left out says only that it exported', async () => {
    serve({ 'model:export': { body: { ...EXPORTED, notCarried: [] } } });
    renderApp(`/model/${P}`);
    fireEvent.click(await openExport());
    expect(await screen.findByText('Exported the model files.')).toBeTruthy();
  });

  it('an ok:false reply shows the server\'s sentence and starts no download', async () => {
    const sentence = 'Your access to this project is limited by row access rules, so its definitions can\'t be exported or imported.';
    serve({ 'model:export': { body: { ok: false, error: sentence } } });
    renderApp(`/model/${P}`);
    fireEvent.click(await openExport());
    expect(await screen.findByText(sentence)).toBeTruthy();
    expect(startDownload).not.toHaveBeenCalled();
  });

  it('a viewer sees no Export button', async () => {
    serve({}, 'viewer');
    renderApp(`/model/${P}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Data model' }, LAZY)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('tab', { name: /Datasets/ })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();
  });

  it('the page keeps one primary: Export is a secondary beside New term', async () => {
    serve();
    renderApp(`/model/${P}`);
    const exp = await screen.findByRole('button', { name: 'Export' }, LAZY);
    expect([...document.querySelectorAll(PRIMARY_SELECTOR)].map((b) => b.textContent?.trim())).toEqual(['New metric']);
    expect(exp.matches(PRIMARY_SELECTOR)).toBe(false);
  });

  it('Ossie downloads the file and lists what did not map, by kind, in a dialog', async () => {
    const calls = serve({ 'model:exportOssie': { body: OSSIE } });
    renderApp(`/model/${P}`);
    await openExport();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Ossie' }));
    await waitFor(() => expect(startDownload).toHaveBeenCalledWith('tok-2'));
    expect(calls.filter((c) => c.channel === 'model:exportOssie').map((c) => c.payload)).toEqual([{ projectId: P }]);
    const dialog = await screen.findByRole('dialog', { name: 'Exported for Ossie' });
    expect(dialog.textContent).toContain('0.2.0.dev0');
    expect(dialog.textContent).toContain('2 terms');
    expect(dialog.textContent).toContain('EMEA, Big orders');
    expect(dialog.textContent).toContain('Value labels on 1 field');
    expect(dialog.textContent).toContain('1 metric');
    expect(dialog.textContent).toContain('1 calculated field');
    expect(dialog.textContent).toContain('the rest of this list is not in the file'); // roles, dates, one-to-one, calcs, marks: not kept
    expect(dialog.textContent).not.toContain('nothing is lost');
    expect(dialog.textContent).toContain('Customers, Orders');
    expect(dialog.textContent).not.toContain('Everything mapped.');
  });

  it('a project where everything mapped says so', async () => {
    serve({ 'model:exportOssie': { body: { ...OSSIE, report: { noSource: [], notMapped: [] } } } });
    renderApp(`/model/${P}`);
    await openExport();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Ossie' }));
    expect(await screen.findByText('Everything mapped.')).toBeTruthy();
  });

  it('an ok:false Ossie reply shows the sentence and starts no download', async () => {
    serve({ 'model:exportOssie': { body: { ok: false, error: 'Not allowed.' } } });
    renderApp(`/model/${P}`);
    await openExport();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Ossie' }));
    expect(await screen.findByText('Not allowed.')).toBeTruthy();
    expect(startDownload).not.toHaveBeenCalled();
  });
});
