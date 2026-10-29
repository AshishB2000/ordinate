// The editor's header keeps its title row to one line (web/e2e/editor-head.e2e.ts measures it): what left that row is
// still there, by the same name — undo / redo and the layout size in the authoring row under it, Subscribe… in ⋯,
// Discard edits as a named icon beside Preview. A reader's header keeps the layout size: it has no authoring row.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { Analysis } from '../api';
import { Editor } from './Editor';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const A = '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';

const analysis: Analysis = {
  id: A,
  projectId: P,
  name: 'Weekly review',
  filters: [],
  style: {},
  parameters: [],
  updatedAt: '',
  sheets: [{ id: 's1', name: 'Overview', cards: [] }],
};

function open(readOnly = false) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const channel = decodeURIComponent(/\/api\/rpc\/([^?]+)/.exec(String(url))?.[1] ?? String(url));
      const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      // Published earlier today, then edited: "Edits not live".
      if (channel === 'analysis:open') return reply({ ok: true, analysis, visuals: [], tag: 't1', status: 'edited', showing: 'draft', published: { publishedAt: new Date().toISOString() } });
      if (channel === 'projects:roles') return reply({ [P]: readOnly ? 'viewer' : 'owner' });
      if (channel === 'fx:get') return reply({ settings: { dashboards: {} } });
      if (channel === 'comment:list') return reply({ comments: [] });
      if (channel === 'alerts:list') return reply({ rules: [], events: [] });
      return reply({});
    }),
  );
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <Editor projectId={P} analysis={analysis} visuals={[]} readOnly={readOnly} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/** Opens ⋯ from the keyboard, as a keyboard user would, and lists its items. */
async function moreItems(header: HTMLElement): Promise<string[]> {
  fireEvent.keyDown(within(header).getByRole('button', { name: 'More dashboard actions' }), { key: 'Enter' });
  await screen.findAllByRole('menuitem');
  return screen.getAllByRole('menuitem').map((m) => m.textContent ?? '');
}

describe('the editor header, edits not live', () => {
  it('keeps Publish changes and a named Discard edits in the title row, and moves the authoring tools under it', async () => {
    open();
    const header = screen.getByRole('banner');
    await within(header).findByText('Edits not live');
    within(header).getByRole('button', { name: 'Publish changes' });
    within(header).getByRole('button', { name: 'Preview' });
    const discard = within(header).getByRole('button', { name: 'Discard edits' });
    expect(discard.getAttribute('title')).toMatch(/^Discard edits: back to the version published \w+ \d+$/);

    // Out of the title row, still on screen with their names.
    for (const name of ['Nothing to undo', 'Nothing to redo']) {
      expect(within(header).queryByRole('button', { name })).toBeNull();
      screen.getByRole('button', { name });
    }
    expect(within(header).queryByRole('group', { name: 'Layout size' })).toBeNull();
    screen.getByRole('group', { name: 'Layout size' });
    within(screen.getByRole('group', { name: 'Layout size' })).getByRole('button', { name: 'Desktop layout' });
    expect(within(header).queryByRole('button', { name: 'Subscribe' })).toBeNull();

    // Last: the confirmation is modal, so everything under it leaves the accessibility tree.
    expect(discard.tagName).toBe('BUTTON'); // a real button: Tab reaches it, Enter and Space press it
    fireEvent.click(discard);
    await screen.findByRole('dialog', { name: 'Discard your edits?' });
  });

  it('has Subscribe… in ⋯, beside History, the published version and Unpublish', async () => {
    open();
    const header = screen.getByRole('banner');
    await within(header).findByText('Edits not live');
    const items = await moreItems(header);
    for (const name of ['View published version', 'History', 'Lineage', 'Style…', 'Subscribe…', 'Export HTML', 'Unpublish…']) expect(items).toContain(name);
    expect(items.indexOf('Subscribe…')).toBeLessThan(items.indexOf('Export HTML'));
  });

  it('opens the Subscribe dialog from ⋯', async () => {
    open();
    const header = screen.getByRole('banner');
    await within(header).findByText('Edits not live');
    await moreItems(header);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Subscribe…' }));
    await screen.findByRole('dialog', { name: 'Subscribe to Weekly review' });
  });
});

describe('a reader’s editor header', () => {
  it('keeps the layout size in the title row, with no draft controls, undo or Subscribe…', async () => {
    open(true);
    const header = screen.getByRole('banner');
    await within(header).findByText('View only');
    within(header).getByRole('group', { name: 'Layout size' });
    for (const name of ['Publish', 'Publish changes', 'Preview', 'Discard edits', 'Nothing to undo']) expect(screen.queryByRole('button', { name })).toBeNull();
    const items = await moreItems(header);
    expect(items).toContain('History');
    expect(items).not.toContain('Subscribe…');
  });
});
