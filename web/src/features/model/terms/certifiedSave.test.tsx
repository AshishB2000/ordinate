// Saving a certified term (semantic D5): a name or filter change warns first; a description or alias change does not.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { serveRpc } from '../../../test-utils';
import { TermDialog } from './TermDialog';

afterEach(() => vi.unstubAllGlobals());

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const T = '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const TERM = { id: T, name: 'EMEA', aliases: [], datasetId: D, datasetName: 'Customers', definition: 'region = EU', updatedAt: '', status: { state: 'certified', by: 'ana@acme.com', at: '2026-11-03T10:00:00Z', note: '' } };

function mount(term: object = TERM) {
  const calls = serveRpc({
    'projects:roles': { body: { [P]: 'editor' } },
    'dataset:list': { body: [{ id: D, name: 'Customers' }] },
    'dataset:columns': { body: { id: D, name: 'Customers', rowCount: 3, columns: [{ name: 'region', type: 'text' }] } },
    'term:get': { body: { ok: true, term: { ...TERM, filters: [] }, tag: 't1' } },
    'term:update': { body: { ok: true, term: TERM } },
    'term:save': { body: { ok: true, term: TERM } },
  });
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TermDialog projectId={P} term={term as never} used="3 charts" onClose={() => {}} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return calls;
}
const saved = (calls: { channel: string }[]) => calls.some((c) => c.channel === 'term:save' || c.channel === 'term:update');
const saveButton = async () => {
  const b = await screen.findByRole('button', { name: 'Save' });
  await waitFor(() => expect((b as HTMLButtonElement).disabled).toBe(false)); // the record is in
  return b;
};

describe('saving a certified term', () => {
  it('a rename warns first with the certifier and the count', async () => {
    const calls = mount();
    const b = await saveButton();
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Europe' } });
    fireEvent.click(b);
    expect(await screen.findByText(/Europe is certified by ana@acme\.com\. Saving changes 3 charts and needs a project admin to certify it again\./)).toBeTruthy();
    expect(saved(calls)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Save anyway' }));
    await waitFor(() => expect(saved(calls)).toBe(true));
  });
  it('NEGATIVE CONTROL: other names and a description save with no warning', async () => {
    const calls = mount();
    const b = await saveButton();
    fireEvent.change(screen.getByRole('textbox', { name: 'Also called' }), { target: { value: 'EU' } });
    fireEvent.click(b);
    await waitFor(() => expect(saved(calls)).toBe(true));
    expect(screen.queryByText(/is certified by/)).toBeNull();
  });
});
