import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { serveRpc, type RpcReply } from '../../test-utils';
import { Toaster } from '../../ui/Toast';
import { AboutTab } from './AboutTab';
import type { Relationship } from './api';
import { RelationshipsTab } from './RelationshipsTab';
import { relWarningText, type KeyCheck, type TableDoc } from './tableApi';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const C = 'c1b6b0e1-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const HEADER = {
  id: D,
  name: 'Order lines',
  rowCount: 4,
  columns: [
    { name: 'line_id', type: 'number' as const },
    { name: 'order_id', type: 'number' as const },
    { name: 'sku', type: 'text' as const },
  ],
};

const GET = 'catalog:getTable';
const SET = 'catalog:setTable';
const CHECK = 'catalog:checkKey';
const CHECKED = '2026-10-03T12:00:00Z';
const counts = (repeatedKeys: number, more: Partial<KeyCheck> = {}): KeyCheck => ({ rows: 4, empty: 0, repeatedKeys, checkedAt: CHECKED, ...more });

type Plain = { status?: number; body?: unknown };
const doc = (more: Partial<TableDoc> = {}): TableDoc => ({ role: '', key: '', grain: '', guide: '', updatedBy: '', updatedAt: '', ...more });
const reply = (table: TableDoc): Plain => ({ body: { ok: true, table } });
/** Dates in these tests are read against a fixed "today". */
const today = () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-04T12:00:00Z'));
};

type Calls = { channel: string; payload: unknown }[];
const to = (calls: Calls, channel: string) => calls.filter((c) => c.channel === channel).map((c) => c.payload);

/** The tab over canned replies; the caller edits this project unless a test says otherwise. `before` runs once fetch is stubbed. */
function renderTab(routes: Record<string, RpcReply>, props: Partial<Parameters<typeof AboutTab>[0]> = {}, before?: () => void) {
  const calls = serveRpc({ 'projects:roles': { body: { [P]: 'editor' } }, ...routes });
  before?.();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <AboutTab projectId={P} datasetId={D} header={HEADER} {...props} />
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return calls;
}

/** A table that remembers what was saved, as the server does; a new key on an extract comes back counted. */
function store(start: TableDoc, counted?: KeyCheck): Record<string, RpcReply> {
  let now = start;
  return {
    [GET]: () => reply(now),
    [SET]: (payload) => {
      const patch = (payload as { patch: Partial<TableDoc> }).patch;
      now = { ...now, ...patch, ...(patch.key !== undefined && { keyCheck: patch.key ? counted : undefined }) };
      return reply(now);
    },
  };
}

/** Hold every call to `channel` until the returned function is called. */
function hold(channel: string): () => void {
  const answer = globalThis.fetch;
  let release = () => {};
  const gate = new Promise<void>((go) => (release = go));
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => (url.includes(channel) ? gate.then(() => answer(url, init)) : answer(url, init)));
  return release;
}

const roleGroup = () => screen.findByRole('group', { name: 'Role' });
const keyBox = () => screen.findByRole('combobox', { name: 'Key' });
const grainBox = async () => (await screen.findByRole('textbox', { name: 'Grain' })) as HTMLInputElement;
/** The key line, which a viewer reads too. */
const keyLine = async () => (await screen.findByText((_, el) => el?.hasAttribute('data-key-line') ?? false)).textContent;
const pickKey = async (name: string) => {
  fireEvent.click(await keyBox());
  fireEvent.click(await screen.findByRole('option', { name }));
};

describe('About tab: an editor', () => {
  it('reads role, key, grain and guide from the server: radios, a key picker, a grain field, rendered markdown', async () => {
    renderTab({ [GET]: reply(doc({ role: 'fact', key: 'line_id', grain: 'One row per order line', guide: '# Order lines\n\nUse **net** revenue.' })) });
    const role = await roleGroup();
    for (const name of ['Fact', 'Dimension', 'Not said']) expect(within(role).getByRole('radio', { name })).toBeTruthy();
    expect((within(role).getByRole('radio', { name: 'Fact' }) as HTMLInputElement).checked).toBe(true);
    const key = await keyBox();
    expect(key.textContent).toContain('line_id');
    fireEvent.click(key);
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['No key', 'line_id', 'order_id', 'sku']);
    fireEvent.keyDown(key, { key: 'Escape' });
    const grain = await grainBox();
    expect(grain.value).toBe('One row per order line');
    expect(screen.getByRole('heading', { name: 'Order lines' })).toBeTruthy();
    expect(screen.getByText('net').tagName).toBe('STRONG');
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
  });

  it('puts the key in the grain\'s placeholder once one is picked, and offers nothing to count before', async () => {
    renderTab(store(doc()));
    expect((await keyBox()).textContent).toContain('Pick the key column');
    expect((await grainBox()).placeholder).toBe('For example, one row per order line');
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
    await pickKey('line_id');
    await waitFor(async () => expect((await grainBox()).placeholder).toBe('One row per line_id'));
    expect(screen.getByRole('button', { name: 'Check now' })).toBeTruthy();
  });

  it('a guide waits to be written: an invitation, and no Edit before there is something to edit', async () => {
    renderTab({ [GET]: reply(doc()) });
    expect(await screen.findByRole('heading', { name: 'No guide yet' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Write a guide' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('a pick is sent as a one-field patch and shows what the server stored', async () => {
    const calls = renderTab(store(doc({ key: 'line_id' }), counts(0)));
    const role = await roleGroup();
    fireEvent.click(within(role).getByRole('radio', { name: 'Dimension' }));
    await waitFor(() => expect(to(calls, SET)).toEqual([{ projectId: P, datasetId: D, patch: { role: 'dimension' } }]));
    await waitFor(() => expect((within(role).getByRole('radio', { name: 'Dimension' }) as HTMLInputElement).checked).toBe(true));
    await pickKey('order_id');
    await waitFor(() => expect(to(calls, SET)[1]).toEqual({ projectId: P, datasetId: D, patch: { key: 'order_id' } }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Key' }).textContent).toContain('order_id'));
    fireEvent.click(screen.getByRole('combobox', { name: 'Key' }));
    fireEvent.click(await screen.findByRole('option', { name: 'No key' })); // the key can be taken away
    await waitFor(() => expect(to(calls, SET)[2]).toEqual({ projectId: P, datasetId: D, patch: { key: '' } }));
  });

  it('says it is counting while a new key on an extract is counted, then the server\'s verdict', async () => {
    const calls = renderTab(store(doc(), counts(1)));
    await keyBox();
    const release = hold('setTable'); // the count runs before the reply
    await pickKey('order_id');
    expect((await screen.findByText('Counting order_id…')).closest('[role="status"]')).not.toBeNull();
    expect(screen.getByRole('combobox', { name: 'Key' }).textContent).toContain('order_id'); // the pick shows at once
    release();
    await waitFor(() => expect(screen.queryByText('Counting order_id…')).toBeNull());
    expect(await keyLine()).toMatch(/^Key order_id · 1 value repeats · checked /);
    expect(to(calls, SET)).toHaveLength(1);
  });

  it('on a Live dataset a new key is saved and nothing is counted until "Check now"', async () => {
    const calls = renderTab(store(doc()), { live: true });
    await pickKey('sku');
    expect(await keyLine()).toBe('Key sku · not checked yet');
    expect(screen.queryByText(/Counting/)).toBeNull();
    expect(to(calls, CHECK)).toHaveLength(0);
    expect(screen.getByText(/Counted in the warehouse only when you press Check now/)).toBeTruthy();
  });

  it('does not read the old key\'s count as the new key\'s while the pick is being saved', async () => {
    renderTab(store(doc({ key: 'line_id', keyCheck: counts(0) })), { live: true });
    expect(await keyLine()).toMatch(/^Key line_id · unique/);
    const release = hold('setTable');
    await pickKey('sku');
    expect(await screen.findByText('Key sku · not checked yet')).toBeTruthy();
    expect(screen.queryByText(/unique/)).toBeNull();
    release();
  });

  it('says the server\'s refusal at the key field, once, and keeps the stored key', async () => {
    const sentence = '“sku” is not a column of this dataset.';
    renderTab({ [GET]: reply(doc({ key: 'line_id' })), [SET]: { body: { ok: false, error: sentence } } });
    await pickKey('sku');
    const said = await screen.findByText(sentence);
    expect(screen.getAllByText(sentence)).toHaveLength(1); // at the field only: no toast beside it
    const key = screen.getByRole('combobox', { name: 'Key' });
    expect(key.getAttribute('aria-invalid')).toBe('true');
    expect(key.getAttribute('aria-describedby')).toContain(said.id);
    expect(key.textContent).toContain('line_id');
  });

  it('reads the counts as the server gave them: unique, how many values repeat, empty keys, and when', async () => {
    today();
    const cases: [KeyCheck, string][] = [
      [counts(1), 'Key line_id · 1 value repeats · checked Oct 3'],
      [counts(0), 'Key line_id · unique · checked Oct 3'],
      [counts(1_200, { rows: 9_000 }), 'Key line_id · 1,200 values repeat · checked Oct 3'],
      [counts(0, { empty: 1, checkedAt: '2025-12-24T12:00:00Z' }), 'Key line_id · unique · 1 row has no key · checked Dec 24, 2025'],
      [counts(2, { empty: 3, checkedAt: new Date().toISOString() }), 'Key line_id · 2 values repeat · 3 rows have no key · checked today'],
    ];
    for (const [keyCheck, text] of cases) {
      renderTab({ [GET]: reply(doc({ key: 'line_id', keyCheck })) });
      expect(await keyLine()).toBe(text);
      cleanup();
    }
  });

  it('a unique key reads "Key line_id · unique" and a repeating one carries its date in the same sentence', async () => {
    renderTab({ [GET]: reply(doc({ key: 'line_id', keyCheck: counts(0) })) });
    expect(await screen.findByText('Key line_id · unique')).toBeTruthy();
    cleanup();
    renderTab({ [GET]: reply(doc({ key: 'line_id', keyCheck: counts(1) })) });
    expect(await screen.findByText(/^Key line_id · 1 value repeats · checked \S/)).toBeTruthy();
  });

  it('a key that is no longer a column says so, offers no count, and can be cleared', async () => {
    renderTab(store(doc({ key: 'line_gone', keyCheck: counts(0) })));
    expect(await screen.findByText('line_gone is no longer a column')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Check now' }) as HTMLButtonElement).disabled).toBe(true);
    const key = await keyBox();
    expect(key.textContent).toContain('Pick the key column');
    expect(screen.queryByText(/unique/)).toBeNull(); // its old count is not shown against it
    fireEvent.click(key);
    expect((await screen.findAllByRole('option'))[0].textContent).toBe('No key');
  });

  it('"Check now" counts the key again and shows what the server found', async () => {
    let now = doc({ key: 'line_id', keyCheck: counts(0) });
    const calls = renderTab({
      [GET]: () => reply(now),
      [CHECK]: () => reply((now = { ...now, keyCheck: counts(1) })),
    });
    expect(await keyLine()).toMatch(/^Key line_id · unique · checked /);
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(to(calls, CHECK)).toEqual([{ projectId: P, datasetId: D }]));
    await waitFor(async () => expect(await keyLine()).toMatch(/^Key line_id · 1 value repeats/));
  });

  it('a Live refusal of "Check now" is the server\'s sentence in the refusal card; a timeout is a plain error line', async () => {
    const budget = 'The warehouse budget for today is used up.';
    let answer: unknown = { ok: false, code: 'live_refused', error: budget };
    renderTab({ [GET]: reply(doc({ key: 'line_id' })), [CHECK]: () => ({ body: answer }) }, { live: true });
    const check = await screen.findByRole('button', { name: 'Check now' });
    fireEvent.click(check);
    expect(await screen.findByText(budget)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'The key was not counted' })).toBeTruthy();
    expect(document.querySelector('[data-live-refusal]')).not.toBeNull();
    answer = { ok: false, code: 'live_timeout', error: 'The warehouse took too long to answer.' };
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The warehouse took too long to answer.');
    expect(document.querySelector('[data-live-refusal]')).toBeNull(); // the refusal card is gone: this one is retried, not a copy's job
  });

  it('saves the grain trimmed, once for Enter and the blur after it, and shows what the server kept', async () => {
    const calls = renderTab(store(doc({ key: 'line_id' })));
    const grain = await grainBox();
    fireEvent.change(grain, { target: { value: '  One row per order line ' } });
    fireEvent.keyDown(grain, { key: 'Enter' });
    fireEvent.blur(grain);
    await waitFor(() => expect(grain.value).toBe('One row per order line'));
    expect(to(calls, SET)).toEqual([{ projectId: P, datasetId: D, patch: { grain: 'One row per order line' } }]);
    fireEvent.blur(grain); // nothing changed: nothing sent
    expect(to(calls, SET)).toHaveLength(1);
  });

  it('says a refused grain at the field, keeps what was typed, and sends it again only once the field is come back to', async () => {
    const sentence = 'This could not be saved right now.';
    let answer: Plain = { body: { ok: false, error: sentence } };
    const calls = renderTab({ [GET]: reply(doc()), [SET]: () => answer });
    const grain = await grainBox();
    fireEvent.change(grain, { target: { value: 'One row per sale' } });
    fireEvent.blur(grain);
    expect(await screen.findByText(sentence)).toBeTruthy();
    expect(grain.value).toBe('One row per sale');
    expect(grain.getAttribute('aria-invalid')).toBe('true');
    fireEvent.blur(grain);
    expect(to(calls, SET)).toHaveLength(1);
    answer = reply(doc({ grain: 'One row per sale' }));
    fireEvent.focus(grain);
    fireEvent.blur(grain);
    await waitFor(() => expect(screen.queryByText(sentence)).toBeNull());
    expect(to(calls, SET)).toHaveLength(2);
  });

  it('writes the guide in its own editor: Save sends it, Cancel and Escape leave the stored one', async () => {
    const calls = renderTab(store(doc({ guide: 'Old note.' })));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const box = screen.getByRole('textbox', { name: 'Guide' }) as HTMLTextAreaElement;
    expect(box.value).toBe('Old note.');
    fireEvent.change(box, { target: { value: 'Never mind.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('Old note.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Guide' }), { key: 'Escape' });
    expect(screen.getByText('Old note.')).toBeTruthy();
    expect(to(calls, SET)).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Guide' }), { target: { value: '## Watch out\n\n- Returns are negative.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save guide' }));
    expect(await screen.findByRole('heading', { name: 'Watch out' })).toBeTruthy();
    expect(screen.getByText('Returns are negative.').tagName).toBe('LI');
    expect(to(calls, SET)).toEqual([{ projectId: P, datasetId: D, patch: { guide: '## Watch out\n\n- Returns are negative.' } }]);
    expect(screen.queryByRole('textbox', { name: 'Guide' })).toBeNull();
  });

  it('keeps the guide editor open, with the server\'s sentence, when the save is refused', async () => {
    const sentence = 'The guide could not be saved.';
    renderTab({ [GET]: reply(doc()), [SET]: { body: { ok: false, error: sentence } } });
    fireEvent.click(await screen.findByRole('button', { name: 'Write a guide' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Guide' }), { target: { value: 'Something' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save guide' }));
    expect(await screen.findByText(sentence)).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Guide' }) as HTMLTextAreaElement).value).toBe('Something');
  });

  it('shows a {{name}} in a guide as the text it is: there is nothing here to fill it from', async () => {
    renderTab({ [GET]: reply(doc({ guide: 'Revenue is {{net_revenue}} after refunds.' })) });
    const token = await screen.findByText('{{net_revenue}}');
    expect(token.getAttribute('data-token')).toBe('net_revenue');
  });

  it('says who changed it last', async () => {
    renderTab({ [GET]: reply(doc({ role: 'fact', updatedBy: 'ana@acme.test', updatedAt: new Date().toISOString() })) });
    expect(await screen.findByText('Updated by ana@acme.test · just now')).toBeTruthy();
  });
});

describe('About tab: a viewer, loading and failure', () => {
  const viewer = { 'projects:roles': { body: { [P]: 'viewer' } } };

  it('reads role, key, grain and guide as text, with nothing to change', async () => {
    today();
    const calls = renderTab(
      { ...viewer, [GET]: reply(doc({ role: 'dimension', key: 'line_id', grain: 'One row per order line', guide: 'Use **net** revenue.', keyCheck: counts(0) })) },
    );
    expect(await keyLine()).toBe('Key line_id · unique · checked Oct 3');
    await waitFor(() => expect(to(calls, 'projects:roles')).toHaveLength(1));
    await act(async () => {}); // the roles reply settles: still a viewer
    expect(screen.getByText('Dimension')).toBeTruthy();
    expect(screen.getByText('One row per order line')).toBeTruthy();
    expect(screen.getByText('net').tagName).toBe('STRONG');
    for (const role of ['radio', 'combobox', 'textbox', 'button']) expect(screen.queryAllByRole(role), role).toHaveLength(0);
  });

  it('shows what is not said as "Not said", and a guide nobody wrote as a plain sentence', async () => {
    renderTab({ ...viewer, [GET]: reply(doc({ key: 'line_id' })) });
    expect(await screen.findByText('Key line_id · not checked yet')).toBeTruthy();
    expect(screen.getAllByText('Not said')).toHaveLength(2); // the role and the grain
    expect(screen.getByText('Nobody has written a guide for this table.')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('tells a viewer of a table nobody has described who can', async () => {
    renderTab({ ...viewer, [GET]: reply(doc()) });
    expect(await screen.findByRole('heading', { name: 'Nothing written about this table yet' })).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('says the counts are hidden from a caller whose access covers only some of the rows', async () => {
    renderTab({ [GET]: reply(doc({ key: 'line_id' })) }, { header: { ...HEADER, scoped: true } });
    expect(await keyLine()).toBe('Key line_id · counts are hidden: your access covers only some of the rows');
  });

  it('loads as a skeleton, not a blank', async () => {
    renderTab({ [GET]: reply(doc({ role: 'fact' })) }, {}, () => {
      hold('getTable');
    });
    const loading = await screen.findByRole('status', { name: 'Loading the table notes' });
    expect(loading.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByRole('group', { name: 'Role' })).toBeNull();
  });

  it('a failed read is an error state with a retry that reads again', async () => {
    let answer: Plain = { body: { ok: false, error: 'The table notes could not be read.' } };
    const calls = renderTab({ [GET]: () => answer });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The table notes could not be loaded');
    expect(alert.textContent).toContain('The table notes could not be read.');
    answer = reply(doc({ role: 'fact' }));
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    await roleGroup();
    expect(to(calls, GET)).toHaveLength(2);
  });
});

describe('A relationship\'s warning', () => {
  const rel = (warning: Relationship['warning'], column = 'customer_id'): Relationship => ({
    id: 'r1',
    from: { datasetId: D, column: 'customer_id' },
    to: { datasetId: C, column },
    cardinality: 'many_to_one',
    verified: { matched: 90, unmatchedFrom: 10 },
    matchPct: 90,
    ...(warning && { warning }),
  });

  it('words a repeating key and a key that is another column', () => {
    expect(relWarningText(rel({ kind: 'repeats', repeats: 3 }), 'Customers')).toBe('Customers repeats some customer_id values. Each lookup uses the first matching row.');
    expect(relWarningText(rel({ kind: 'not_key', key: 'email' }), 'Customers')).toBe("Customers' key is email; this relationship looks rows up by customer_id.");
    expect(relWarningText(rel({ kind: 'not_key', key: 'email' }), 'Region')).toBe("Region's key is email; this relationship looks rows up by customer_id.");
    expect(relWarningText(rel(undefined), 'Customers')).toBe('');
  });

  it('is said under the relationship it belongs to, and only there', async () => {
    vi.stubGlobal('CSS', { escape: (v: string) => v }); // jsdom has none; the diagram measures with it
    const dataset = (id: string, name: string) => ({ id, name, sourceKind: 'csv', rowCount: 4, columnCount: 2, updatedAt: '2026-10-01T10:00:00Z' });
    const clean: Relationship = { ...rel(undefined, 'region'), id: 'r2', from: { datasetId: D, column: 'region' } };
    serveRpc({
      'projects:roles': { body: { [P]: 'editor' } },
      'dataset:list': { body: [dataset(D, 'Orders'), dataset(C, 'Customers')] },
      'relationship:list': { body: { ok: true, relationships: [rel({ kind: 'repeats', repeats: 3 }), clean] } },
    });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RelationshipsTab projectId={P} />
      </QueryClientProvider>,
    );
    const said = await screen.findByText('Customers repeats some customer_id values. Each lookup uses the first matching row.');
    expect(said.closest('tr')?.previousElementSibling?.textContent).toContain('customer_id'); // the row it is under
    expect(screen.getAllByText(/Each lookup uses the first matching row/)).toHaveLength(1);
    expect(screen.getAllByRole('row')).toHaveLength(4); // the head, the two relationships, the one warning
  });
});
