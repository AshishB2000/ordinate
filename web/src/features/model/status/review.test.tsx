import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { serveRpc, type RpcReply } from '../../../test-utils';
import { ReviewDialog } from './ReviewDialog';
import { RetireDialog } from './RetireDialog';
import { StatusActions } from './StatusActions';
import { SaveWarning, needsWarning } from './SaveWarning';
import type { StatusView } from './status';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const M = '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const N = '3b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const REF = `metric:${M}`;
const status: StatusView = { state: 'needs_review', by: 'ana@acme.com', at: '2026-11-03T10:00:00Z', note: '', versionKey: 'K1' };
const VERSIONS = [{ key: 'K2', savedAt: '2026-11-04T10:00:00Z', summary: 'Edited' }, { key: 'K1', savedAt: '2026-11-03T10:00:00Z', summary: 'Certified' }];
const DIFF = { ok: true, summary: '1 filter added', counts: { filters: 1 }, figures: 0, changes: [{ group: 'filters', kind: 'added', label: 'Filter', detail: 'region = EU' }] };

/** The Certify button, once the review is in (it is disabled while it loads). */
const certifyButton = async () => {
  const b = await screen.findByRole('button', { name: 'Certify' });
  await waitFor(() => expect((b as HTMLButtonElement).disabled).toBe(false));
  return b;
};

const mount = (el: React.ReactElement) =>
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{el}</QueryClientProvider>
    </MemoryRouter>,
  );
const base = (extra: Record<string, RpcReply> = {}) => ({
  'model:review': { body: { ok: true, pin: 'PIN', status, newestKey: 'K2' } },
  'versions:list': { body: VERSIONS },
  'versions:diff': { body: DIFF },
  'projects:roles': { body: { [P]: 'admin' } },
  ...extra,
});

describe('ReviewDialog', () => {
  it('diffs the certified version against the newest and certifies on the pin it read', async () => {
    const calls = serveRpc(base({ 'model:certify': { body: { ok: true, status: { ...status, state: 'certified' } } } }));
    mount(<ReviewDialog projectId={P} kind="metric" id={M} name="Revenue" onClose={() => {}} />);
    await waitFor(() => expect(calls.some((c) => c.channel === 'versions:diff')).toBe(true));
    expect(calls.find((c) => c.channel === 'versions:diff')?.payload).toMatchObject({ type: 'metric', from: 'K1', to: 'K2' });
    fireEvent.click(await certifyButton());
    await waitFor(() => expect(calls.find((c) => c.channel === 'model:certify')?.payload).toMatchObject({ ref: REF, base: 'PIN' }));
  });
  it('shows the comparison only: no Restore beside Certify (the version history keeps it)', async () => {
    serveRpc(base());
    mount(<ReviewDialog projectId={P} kind="metric" id={M} name="Revenue" onClose={() => {}} />);
    await screen.findByRole('heading', { name: 'What changed' });
    expect(screen.queryByRole('button', { name: /^Restore/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Certify' })).toBeTruthy();
  });
  it('says so when the definition did not move', async () => {
    serveRpc(base({ 'versions:diff': { body: { ...DIFF, changes: [], counts: {}, summary: '' } } }));
    mount(<ReviewDialog projectId={P} kind="metric" id={M} name="Revenue" onClose={() => {}} />);
    expect(await screen.findByText(/The definition is unchanged\. Something it uses changed/)).toBeTruthy();
  });
  it('a 409 shows the server sentence, reads the review again and stays open', async () => {
    const calls = serveRpc(base({ 'model:certify': { status: 409, body: { error: 'record_changed', message: 'This changed since you reviewed it. Review it again, then certify.' } } }));
    mount(<ReviewDialog projectId={P} kind="metric" id={M} name="Revenue" onClose={() => {}} />);
    fireEvent.click(await certifyButton());
    expect(await screen.findByText(/This changed since you reviewed it/)).toBeTruthy();
    await waitFor(() => expect(calls.filter((c) => c.channel === 'model:review').length).toBe(2));
    expect(screen.getByRole('button', { name: 'Certify' })).toBeTruthy();
  });
});

describe('RetireDialog', () => {
  const metrics = [
    { id: M, name: 'Gross', datasetId: 'd', definition: {}, definitionText: '', format: {}, updatedAt: '' },
    { id: N, name: 'Net', datasetId: 'd', definition: {}, definitionText: '', format: {}, updatedAt: '' },
    { id: '4b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b', name: 'Old', datasetId: 'd', definition: {}, definitionText: '', format: {}, updatedAt: '', status: { state: 'retired', by: 'a', at: '', note: '' } },
  ];
  it('offers neither itself nor a retired metric, and shows the server\'s sentence under the field', async () => {
    const calls = serveRpc({
      'metric:list': { body: { ok: true, metrics } },
      'model:retire': { body: { ok: false, error: 'Net is the replacement for another item. Point that item somewhere else first.', field: 'replacedBy' } },
    });
    mount(<RetireDialog projectId={P} kind="metric" id={M} name="Gross" onClose={() => {}} />);
    await waitFor(() => expect(calls.some((c) => c.channel === 'metric:list')).toBe(true));
    await new Promise((r) => setTimeout(r, 30));
    fireEvent.click(screen.getByRole('combobox', { name: 'Replaced by' }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Nothing: it is just retired', 'Net']);
    fireEvent.click(screen.getByRole('option', { name: 'Net' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retire' }));
    expect(await screen.findByText(/is the replacement for another item/)).toBeTruthy();
    expect(calls.find((c) => c.channel === 'model:retire')?.payload).toMatchObject({ ref: REF, replacedBy: `metric:${N}` });
  });
});

describe('StatusActions', () => {
  it('NEGATIVE CONTROL: an editor sees nothing', async () => {
    const calls = serveRpc({ 'projects:roles': { body: { [P]: 'editor' } } });
    const { container } = mount(<StatusActions projectId={P} kind="metric" id={M} name="Revenue" status={status} />);
    await waitFor(() => expect(calls.some((c) => c.channel === 'projects:roles')).toBe(true));
    await new Promise((r) => setTimeout(r, 30));
    expect(container.querySelector('button')).toBeNull();
  });
  it('an admin gets Review and certify, Retire and Clear', async () => {
    serveRpc({ 'projects:roles': { body: { [P]: 'admin' } } });
    mount(<StatusActions projectId={P} kind="metric" id={M} name="Revenue" status={status} />);
    expect(await screen.findByRole('button', { name: 'Review and certify…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retire…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear status' })).toBeTruthy();
  });
});

describe('SaveWarning', () => {
  it('names the certifier and the usage, and only a certified item that moves its pin needs it', () => {
    const cert: StatusView = { ...status, state: 'certified' };
    const onConfirm = vi.fn();
    mount(<SaveWarning name="Revenue" status={cert} used="31 charts" onConfirm={onConfirm} onCancel={() => {}} />);
    expect(screen.getByText(/Revenue is certified by ana@acme\.com\. Saving changes 31 charts and needs a project admin to certify it again\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save anyway' }));
    expect(onConfirm).toHaveBeenCalled();
    expect(needsWarning(cert, true)).toBe(true);
    expect(needsWarning(cert, false)).toBe(false);
    expect(needsWarning(status, true)).toBe(false);
    expect(needsWarning(undefined, true)).toBe(false);
  });
});
