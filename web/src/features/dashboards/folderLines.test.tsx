// Shared folders on the Publish and Embed dialogs (docs/team-folders E7): a /p/ page and its embeds keep the link's
// audience, so each says "Shows data from folders N people can't open" from the server's count (`outside` on
// publish:plan and embed:columns). NEGATIVE CONTROLS: at 0 (every item in Everyone, or everyone opens them) neither
// says anything.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { serveRpc } from '../../test-utils';
import type { HostedSite } from './api';
import { EmbedDialog } from './EmbedDialog';
import { PublishDialog } from './PublishDialog';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const P = '11111111-1111-4111-8111-111111111111';
const D = '22222222-2222-4222-8222-222222222222';
const SITE_ID = '33333333-3333-4333-8333-333333333333';
const TARGETS = { ok: true, dashboards: [{ id: D, name: 'Revenue', sheets: 1 }], stories: [], scorecards: [] };
const PLAN = { pages: [{ kind: 'dashboard', id: D, name: 'Revenue', combos: 1, mode: 'all', bytes: 2048, dropped: [] }], combos: 1, bytes: 2048, maxBytes: 50 * 1024 * 1024, tooBig: false, summary: '1 page · 2 KB', suggestions: [] };
const SITE: HostedSite = {
  id: SITE_ID, projectId: P, title: 'Revenue site', access: 'org', publishedBy: 'pat@acme.test', publishedAt: '2026-11-01T10:00:00Z', bytes: 2048, combos: 1,
  pages: [{ file: 'revenue.html', kind: 'dashboard', name: 'Revenue' }], config: { dashboardIds: [D], storyIds: [], scorecardIds: [], options: {} },
};
const LINE = /Shows data from folders/;

function mount(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const publish = (outside: number) => {
  serveRpc({ 'publish:targets': { body: TARGETS }, 'publish:plan': { body: { ok: true, plan: PLAN, outside } } });
  mount(<PublishDialog projectId={P} preselect={D} publicLinks onClose={() => undefined} onPublished={() => undefined} />);
};

const embed = (outside: number) => {
  const calls = serveRpc({
    '/api/auth/me': { body: { user: { email: 'pat@acme.test', role: 'admin' }, org: 'acme', mode: 'header', canSignOut: false } },
    'embed:status': { body: { canStore: true, enabled: true, origins: ['https://portal.acme.test'], secretSet: true, org: 'acme' } },
    'publish:targets': { body: TARGETS },
    'embed:columns': { body: { ok: true, tiles: 2, columns: [{ name: 'region', type: 'text', tiles: 2 }], outside } },
    'embed:preview': { body: { ok: false, error: 'Not in this test.' } },
  });
  mount(<EmbedDialog projectId={P} site={SITE} onClose={() => undefined} />);
  return calls;
};

describe('the Publish dialog', () => {
  it('says the page shows data from folders N people can’t open', async () => {
    publish(3);
    expect((await screen.findByText(LINE)).closest('[role="note"]')?.textContent).toBe('Shows data from folders 3 people can’t open.');
  });
  it('one person', async () => {
    publish(1);
    expect((await screen.findByText(LINE)).textContent).toBe('Shows data from folders 1 person can’t open.');
  });
  it('NEGATIVE CONTROL: says nothing when everyone in the project opens what it shows', async () => {
    publish(0);
    expect(await screen.findByText('1 page · 2 KB')).toBeTruthy(); // the plan has come back
    expect(screen.queryByText(LINE)).toBeNull();
  });
});

describe('the Embed dialog', () => {
  it('says the embedded dashboard shows data from folders N people can’t open', async () => {
    embed(4);
    expect((await screen.findByText(LINE)).textContent).toBe('Shows data from folders 4 people can’t open.');
  });
  it('NEGATIVE CONTROL: says nothing when everyone in the project opens what it shows', async () => {
    const calls = embed(0);
    await screen.findByTestId('embed-claims'); // the dialog's body is drawn
    await waitFor(() => expect(calls.some((c) => c.channel === 'embed:columns')).toBe(true));
    await new Promise((r) => setTimeout(r, 200)); // its reply has been read
    expect(screen.queryByText(LINE)).toBeNull();
  });
});
