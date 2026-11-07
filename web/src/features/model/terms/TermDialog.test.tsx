// The glossary term dialog (semantic D10): "Also called" is one comma-separated line sent as a list, and the
// server's refusal is said under the box it names.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { serveRpc, type RpcReply } from '../../../test-utils';
import { TermDialog } from './TermDialog';
import { splitAliases } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const routes = (extra: Record<string, RpcReply> = {}): Record<string, RpcReply> => ({
  'projects:roles': { body: { [P]: 'editor' } },
  'dataset:list': { body: [{ id: D, name: 'Customers' }] },
  'dataset:columns': { body: { id: D, name: 'Customers', rowCount: 3, columns: [{ name: 'region', type: 'text' }] } },
  'term:list': { body: { ok: true, terms: [] } },
  ...extra,
});

function mount(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <TermDialog projectId={P} onClose={onClose} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return onClose;
}

describe('the term dialog', () => {
  it('sends "Europe, ME" as two names, and closes on save', async () => {
    const calls = serveRpc(routes({ 'term:save': { body: { ok: true, term: { id: 't', name: 'EMEA', aliases: ['Europe', 'ME'], datasetId: D, filters: [] } } } }));
    const onClose = mount();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Name' }), { target: { value: 'EMEA' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Also called' }), { target: { value: 'Europe,  ME ,' } });
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Dataset' }) as HTMLButtonElement).textContent).toBe('Customers'));
    fireEvent.click(screen.getByRole('button', { name: 'Create term' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const sent = calls.find((c) => c.channel === 'term:save')?.payload as { input: { aliases: string[]; datasetId: string; name: string } };
    expect(sent.input.aliases).toEqual(['Europe', 'ME']);
    expect(sent.input.datasetId).toBe(D);
    expect(sent.input.name).toBe('EMEA');
  });

  it('says the server\'s refusal under Name, and keeps the dialog open', async () => {
    const SAY = '"Revenue" is already taken by "Revenue". Pick a name no metric or other term uses.';
    serveRpc(routes({ 'term:save': { body: { ok: false, field: 'name', error: SAY } } }));
    const onClose = mount();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Name' }), { target: { value: 'Revenue' } });
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Dataset' }) as HTMLButtonElement).textContent).toBe('Customers'));
    fireEvent.click(screen.getByRole('button', { name: 'Create term' }));
    const name = screen.getByRole('textbox', { name: 'Name' });
    await waitFor(() => expect(name.getAttribute('aria-invalid')).toBe('true'));
    expect(screen.getByText(SAY)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('NEGATIVE CONTROL: splitAliases drops empties and keeps inner spaces single', () => {
    expect(splitAliases(' Europe ,, Middle   East ,')).toEqual(['Europe', 'Middle East']);
    expect(splitAliases('')).toEqual([]);
  });
});
