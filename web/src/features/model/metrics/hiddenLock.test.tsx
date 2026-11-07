// A metric or term the server marks hidden from the caller (part 4, D19) draws a lock with the reason: the Metrics
// tab with metric:table's refusal sentence, the Glossary with the app's words. NEGATIVE CONTROL: one not marked has none.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type { ReactNode } from 'react';
import { serveRpc } from '../../../test-utils';
import { MetricsTab } from './MetricsTab';
import { TermsList } from '../terms/TermsList';

afterEach(() => vi.unstubAllGlobals());

const P = '0b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const M = '2b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const N = '3b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const SENTENCE = "This uses a column a project admin has limited to certain people, so it can't be shown here.";
const metric = (id: string, name: string, hidden?: true) => ({
  id, name, datasetId: D, datasetName: 'Staff', definition: { column: 'salary', aggregation: 'sum' }, definitionText: `sum of ${name}`, format: { kind: 'number' }, updatedAt: '', ...(hidden ? { hidden } : {}),
});
const term = (id: string, name: string, hidden?: true) => ({ id, name, aliases: [], datasetId: D, datasetName: 'Staff', definition: 'salary > 1200', updatedAt: '', ...(hidden ? { hidden } : {}) });

const mount = (ui: ReactNode) =>
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
const rowOf = async (name: string) => (await screen.findByText(name)).closest('tr') as HTMLElement;

describe('a metric or term hidden from the viewer', () => {
  it('the Metrics tab draws a lock with the refusal sentence; Headcount has none', async () => {
    serveRpc({
      'projects:roles': { body: { [P]: 'viewer' } },
      'catalog:tags': { body: { ok: true, tags: [], refs: {} } },
      'metric:table': { body: { ok: true, metrics: [metric(M, 'Payroll', true), metric(N, 'Headcount')], rows: {
        [M]: { display: null, series: null, usage: null, refused: { code: 'row_policy', reason: 'hidden', error: SENTENCE } },
        [N]: { display: '12', series: null, usage: null },
      } } },
    });
    mount(<MetricsTab projectId={P} />);
    expect(within(await rowOf('Payroll')).getByRole('img', { name: SENTENCE })).toBeTruthy();
    expect(within(await rowOf('Headcount')).queryByRole('img', { name: SENTENCE })).toBeNull();
  });

  it('the Glossary draws a lock with the reason; Ops people has none', async () => {
    serveRpc({ 'term:list': { body: { ok: true, terms: [term(M, 'High earners', true), term(N, 'Ops people')] } } });
    mount(<TermsList projectId={P} canEdit={false} />);
    expect(within(await rowOf('High earners')).getByRole('img', { name: /hidden from you/i })).toBeTruthy();
    expect(within(await rowOf('Ops people')).queryByRole('img', { name: /hidden from you/i })).toBeNull();
  });
});
