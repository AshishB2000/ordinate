// The Documents section (docs/knowledge-docs/00-design.md, "Screens"): on the Assistant tab and an agent's page. The list
// with kind, size and who edited; the empty state that points short rules to Instructions; a viewer's read-only view; Add
// document and its refusals (the server's sentence at the field, the text kept); a stale save and Reload; the upload's
// reading, refused and done states; delete behind the confirm; documents off without a database; and "How this was
// answered" naming the documents, a removed one as such. Replies are canned.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../../test-utils';
import type { Turn } from '../../assistant/api';
import { HowAnswered } from './HowAnswered';
import type { DocFull, DocRow } from './knowledgeApi';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const AG = 'a1111111-1111-4111-8111-111111111111';
const D1 = '1d6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D2 = '2d6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const LAZY = { timeout: 15_000 };

const doc = (id: string, title: string, more: Partial<DocRow> = {}): DocRow => ({
  id, agentId: null, title, source: 'typed', fileName: null, chars: 1200, updatedBy: 'priya@acme.test', updatedAt: '2026-10-12T10:00:00Z', ...more,
});
const TWO = [doc(D1, 'Revenue policy'), doc(D2, 'Fiscal calendar', { source: 'pdf', fileName: 'calendar.pdf', chars: 45210 })];
const full = (d: DocRow, text: string, tag = 'tag-1'): DocFull => ({ ...d, text, tag });
const list = (docs: DocRow[], more: object = {}) => ({ body: { ok: true, docs, total: docs.length, max: 100, projectDocs: null, canEdit: true, ...more } });

function serve(role: 'editor' | 'viewer', routes: Record<string, RpcReply> = {}) {
  const body = (b: unknown) => ({ body: b });
  return serveRpc({
    '/api/auth/me': body({ user: { email: 'pat@acme.test', role: 'member' }, org: 'acme', mode: 'oidc', canSignOut: true }),
    'projects:list': body([{ id: P, name: 'Sales', createdAt: '', updatedAt: '' }]),
    'projects:overview': body([{ id: P, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 0, dashboards: 0, sample: false }]),
    'projects:roles': body({ [P]: role }),
    'catalog:instructions': body({ ok: true, instructions: [] }),
    'verified:list': body({ ok: true, broken: 0, questions: [] }),
    'agent:list': body({ ok: true, agents: [], preselected: null, canManage: false, canInstruct: role === 'editor' }),
    'knowledge:list': list(TWO),
    ...routes,
  });
}
const section = async () => {
  await screen.findByRole('heading', { level: 2, name: 'Documents' }, LAZY);
  return screen.getByRole('region', { name: 'Documents' });
};
const sent = (calls: { channel: string; payload: unknown }[], channel: string) => calls.filter((c) => c.channel === channel).map((c) => c.payload);

describe('Documents on the Assistant tab', () => {
  it('lists each document with its kind, size, file name and who edited it, and says who can read them', async () => {
    serve('editor');
    renderApp(`/model/${P}?tab=assistant`);
    const s = await section();
    const rows = await within(s).findAllByTestId('document-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Revenue policy');
    expect(rows[0].textContent).toContain('Typed');
    expect(rows[0].textContent).toContain('1,200 characters');
    expect(rows[0].textContent).toContain('priya@acme.test · Oct 12, 2026');
    expect(rows[1].textContent).toContain('PDF');
    expect(rows[1].textContent).toContain('calendar.pdf');
    expect(rows[1].textContent).toContain('45,210 characters');
    expect(s.textContent).toContain('Anyone who can ask this assistant can see what these documents say, including in Slack channels connected to it.');
  }, 30_000); // the first test pays for the lazy route chunk's transform

  it('no documents: an empty state that says what they are for and points short rules to Instructions', async () => {
    serve('editor', { 'knowledge:list': list([]) });
    renderApp(`/model/${P}?tab=assistant`);
    const s = await section();
    expect(await within(s).findByText('No documents yet')).toBeTruthy();
    expect(s.textContent).toContain('how you count revenue');
    expect(s.textContent).toContain('belong in Instructions instead');
    expect(within(s).getAllByRole('button', { name: 'Add document' }).length).toBeGreaterThan(0);
    expect(within(s).getAllByRole('button', { name: 'Upload PDF or Word' }).length).toBeGreaterThan(0);
  });

  it('a viewer reads the list and a document read-only, with no way to add, upload or remove', async () => {
    serve('viewer', { 'knowledge:get': { body: { ok: true, doc: full(TWO[0], '# Revenue\n\nNet of refunds.') } } });
    renderApp(`/model/${P}?tab=assistant`);
    const s = await section();
    await within(s).findAllByTestId('document-row');
    expect(within(s).queryByRole('button', { name: 'Add document' })).toBeNull();
    expect(within(s).queryByRole('button', { name: 'Upload PDF or Word' })).toBeNull();
    expect(within(s).queryByRole('button', { name: /^Remove / })).toBeNull();
    fireEvent.click(within(s).getByRole('button', { name: 'Read Revenue policy' }));
    const text = (await screen.findByRole('textbox', { name: /^Text/ }, LAZY)) as HTMLTextAreaElement;
    expect(text.value).toBe('# Revenue\n\nNet of refunds.');
    expect(text.readOnly).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Close' }).length).toBeGreaterThan(0);
  });

  it('documents off without a database: its own state, no way to add', async () => {
    serve('editor', { 'knowledge:list': { body: { ok: false, needsDatabase: true, error: 'Documents need a database. Set DATABASE_URL to use them.' } } });
    renderApp(`/model/${P}?tab=assistant`);
    const s = await section();
    expect(await within(s).findByText('Documents need a database')).toBeTruthy();
  });

  it('a list that cannot be read shows its error with a retry', async () => {
    serve('editor', { 'knowledge:list': { body: { ok: false, error: 'The documents could not be read.' } } });
    renderApp(`/model/${P}?tab=assistant`);
    const s = await section();
    expect(await within(s).findByText('The documents could not be loaded')).toBeTruthy();
    expect(within(s).getByRole('button', { name: /try again|retry/i })).toBeTruthy();
  });

  it('Add document: title and text, one create, the list read again; a refusal keeps the text at its field', async () => {
    const created = full(doc(D1, 'How we count revenue'), 'Net of refunds.');
    const calls = serve('editor', { 'knowledge:save': { body: { ok: false, error: 'The document has no text.' } } });
    renderApp(`/model/${P}?tab=assistant`);
    const s = await section();
    fireEvent.click(await within(s).findByRole('button', { name: 'Add document' }));
    const dlg = await screen.findByRole('dialog');
    const save = within(dlg).getByRole('button', { name: 'Add document' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(within(dlg).getByRole('textbox', { name: 'Title' }), { target: { value: 'How we count revenue' } });
    fireEvent.change(within(dlg).getByRole('textbox', { name: /^Text/ }), { target: { value: 'Net of refunds.' } });
    fireEvent.click(save);
    expect(await within(dlg).findByText('The document has no text.')).toBeTruthy();
    expect((within(dlg).getByRole('textbox', { name: /^Text/ }) as HTMLTextAreaElement).value).toBe('Net of refunds.');
    vi.mocked(fetch).mockClear();
    serve('editor', { 'knowledge:save': { body: { ok: true, doc: created } } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Add document' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sent(calls, 'knowledge:save')).toEqual([{ projectId: P, title: 'How we count revenue', text: 'Net of refunds.' }]);
  });

  it('a text over 300,000 characters says so at the field and cannot be saved', async () => {
    serve('editor');
    renderApp(`/model/${P}?tab=assistant`);
    const s = await section();
    fireEvent.click(await within(s).findByRole('button', { name: 'Add document' }));
    const dlg = await screen.findByRole('dialog');
    fireEvent.change(within(dlg).getByRole('textbox', { name: 'Title' }), { target: { value: 'Huge' } });
    fireEvent.change(within(dlg).getByRole('textbox', { name: /^Text/ }), { target: { value: 'a'.repeat(300_001) } });
    expect(within(dlg).getByText(/300,001 characters is over the 300,000 limit/)).toBeTruthy();
    expect((within(dlg).getByRole('button', { name: 'Add document' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('an edit sends the tag it read; a stale one says so and Reload reads the document again', async () => {
    let tag = 'tag-1';
    const calls = serve('editor', {
      'knowledge:get': () => ({ body: { ok: true, doc: full(TWO[1], 'Extracted text.', tag) } }),
      'knowledge:save': { status: 409, body: { error: 'record_changed', code: 'record_changed', message: 'This document was changed in another tab or by someone else. Reload it and make your change again.', tag: 'tag-2' } },
    });
    renderApp(`/model/${P}?tab=assistant`);
    const s = await section();
    fireEvent.click(await within(s).findByRole('button', { name: 'Edit Fiscal calendar' }));
    const dlg = await screen.findByRole('dialog');
    expect((await within(dlg).findByText(/Read from calendar\.pdf\. The original file is not kept/))).toBeTruthy();
    fireEvent.change(within(dlg).getByRole('textbox', { name: /^Text/ }), { target: { value: 'Edited text.' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Save' }));
    expect(await within(dlg).findByText(/was changed in another tab/)).toBeTruthy();
    expect(sent(calls, 'knowledge:save')).toEqual([{ projectId: P, id: D2, base: 'tag-1', title: 'Fiscal calendar', text: 'Edited text.' }]);
    tag = 'tag-2';
    fireEvent.click(within(dlg).getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect((within(dlg).getByRole('textbox', { name: /^Text/ }) as HTMLTextAreaElement).value).toBe('Extracted text.'));
    expect(sent(calls, 'knowledge:get').length).toBeGreaterThan(1);
  }, 20_000);

  it('Remove asks first, names what goes, then deletes one document', async () => {
    const calls = serve('editor', { 'knowledge:delete': { body: { ok: true } } });
    renderApp(`/model/${P}?tab=assistant`);
    const s = await section();
    fireEvent.click(await within(s).findByRole('button', { name: 'Remove Revenue policy' }));
    const dlg = await screen.findByRole('dialog');
    expect(dlg.textContent).toContain('Remove “Revenue policy”?');
    expect(dlg.textContent).toContain('the original file is not kept');
    expect(sent(calls, 'knowledge:delete')).toEqual([]);
    fireEvent.click(within(dlg).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(sent(calls, 'knowledge:delete')).toEqual([{ projectId: P, id: D1 }]));
  });
});

describe('Documents on an agent\'s page', () => {
  it('the agent\'s own documents, and a line that the project\'s apply too', async () => {
    const body = (b: unknown) => ({ body: b });
    const agent = { id: AG, name: 'Finance assistant', usable: true, topic: null, model: null, build: false, teams: [], instructions: [], tag: 't' };
    const calls = serve('editor', {
      'agent:list': body({ ok: true, agents: [agent], preselected: null, canManage: false, canInstruct: true }),
      'knowledge:list': (p) => ({ body: { ok: true, docs: [doc(D1, 'Finance glossary', { agentId: AG })], total: 3, max: 100, projectDocs: (p as { agentId?: string }).agentId ? 2 : null, canEdit: true } }),
      'model:navigation': body({ ok: true, tables: [], dateLadder: [], topics: [] }),
      'project:shareTargets': body({ users: [], teams: [] }),
      'ai:status': body({ ready: true, models: [], mine: null, copilotEnabled: true, keyStore: null }),
    });
    renderApp(`/model/${P}?tab=assistant&agent=${AG}`);
    const s = await section();
    expect((await within(s).findAllByTestId('document-row'))[0].textContent).toContain('Finance glossary');
    expect(s.textContent).toContain('The project’s 2 documents apply to this assistant too.');
    expect(s.textContent).toContain('Reference text only this assistant reads');
    expect(sent(calls, 'knowledge:list')).toContainEqual({ projectId: P, agentId: AG });
  }, 30_000);
});

describe('Uploading a file', () => {
  const pick = (s: HTMLElement, name: string) => {
    const input = within(s).getByLabelText('Document file') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], name)] } });
  };
  /** An upload is multipart, which serveRpc does not read: answered here, the rest passed on; the document upload may be held until `release()`. */
  function stage(name: string, held = false) {
    let release: () => void = () => undefined;
    const gate = held ? new Promise<void>((r) => { release = r; }) : Promise.resolve();
    const inner = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/files') return new Response(JSON.stringify({ fileToken: 'T'.repeat(43), name, size: 3 }), { status: 200 });
      if (url.includes('knowledge%3Aupload') || url.includes('knowledge:upload')) await gate;
      return inner(url, init);
    }));
    return release;
  }

  it('says it is reading while the server reads, then lists the new document', async () => {
    const calls = serve('editor', { 'knowledge:upload': { body: { ok: true, doc: full(TWO[1], 'x') } } });
    const release = stage('calendar.pdf', true);
    renderApp(`/model/${P}?tab=assistant`);
    const s = await section();
    await within(s).findAllByTestId('document-row');
    pick(s, 'calendar.pdf');
    expect((await within(s).findByRole('status')).textContent).toContain('Reading calendar.pdf');
    release();
    await waitFor(() => expect(within(s).queryByRole('status')).toBeNull());
    expect(sent(calls, 'knowledge:upload')).toEqual([{ projectId: P, fileToken: 'T'.repeat(43) }]);
    expect(within(s).queryByRole('alert')).toBeNull();
  });

  it('a refused file shows the server\'s own sentence beside its name, and can be dismissed', async () => {
    serve('editor', { 'knowledge:upload': { body: { ok: false, error: 'No text could be read from this file. A scanned PDF holds pictures, not text.' } } });
    stage('scan.pdf');
    renderApp(`/model/${P}?tab=assistant`);
    const s = await section();
    await within(s).findAllByTestId('document-row');
    pick(s, 'scan.pdf');
    const alert = await within(s).findByRole('alert');
    expect(alert.textContent).toContain('scan.pdf');
    expect(alert.textContent).toContain('was not added');
    expect(alert.textContent).toContain('A scanned PDF holds pictures, not text.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }));
    expect(within(s).queryByRole('alert')).toBeNull();
  });

  it('a too-long document is refused with its sentence like any other', async () => {
    serve('editor', { 'knowledge:upload': { body: { ok: false, error: 'This document is longer than 300,000 characters. Split it into smaller documents.' } } });
    stage('big.docx');
    renderApp(`/model/${P}?tab=assistant`);
    const s = await section();
    await within(s).findAllByTestId('document-row');
    pick(s, 'big.docx');
    expect((await within(s).findByRole('alert')).textContent).toContain('longer than 300,000 characters');
  });
});

describe('How this was answered, with documents', () => {
  const turn = (guidance: Turn['guidance']): Turn => ({ id: 't', role: 'assistant', text: 'x', guidance } as Turn);
  it('lists the documents the answer read by title, and a removed one as such', () => {
    render(<HowAnswered turn={turn({ instructions: 2, examples: [], documents: [D1, D2], documentRefs: [{ id: D1, title: 'Revenue policy' }, { id: D2, title: '', gone: true }] })} verified={[]} />);
    const how = screen.getByTestId('how-documents');
    expect(how.textContent).toContain('It read 2 documents.');
    expect(how.textContent).toContain('Revenue policy');
    expect(how.textContent).toContain('a removed document');
  });
  it('NEGATIVE CONTROL: an answer that read none says nothing about documents', () => {
    render(<HowAnswered turn={turn({ instructions: 2, examples: [] })} verified={[]} />);
    expect(screen.queryByTestId('how-documents')).toBeNull();
  });
});
