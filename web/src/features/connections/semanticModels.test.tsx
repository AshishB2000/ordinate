// A semantic layer's models under Connections (semantic layer part 7, b3; docs/semantic-layer/07-portability.md "What you
// will see"): a Snowflake connection lists its semantic views beside its tables and SQL; a layer-only connection (Cube,
// dbt) lists its models alone. "Add as dataset" names the new Live dataset (prefilled, editable) and opens it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, serveRpc, type RpcReply } from '../../test-utils';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PID = '11111111-1111-4111-8111-111111111111';
const CID = '22222222-2222-4222-8222-222222222222';
const DSID = '33333333-3333-4333-8333-333333333333';
const LAZY = { timeout: 15_000 };
const SNOWFLAKE = { id: 'snowflake', label: 'Snowflake', family: 'snowflake', category: 'Cloud warehouses', browsable: true, live: true, semantic: true, fields: [] };
const CONN = { id: CID, projectId: PID, name: 'Layer prod', connectorId: 'semantic-fake', values: {}, lastStatus: 'ok', lastError: null, queries: [], semantic: true };
const MODELS = { ok: true, models: [{ name: 'mdl_orders', label: 'Orders', description: 'Orders by day' }, { name: 'mdl_returns' }] };

function serve(extra: Record<string, RpcReply> = {}) {
  return serveRpc({
    '/api/auth/me': { body: { user: { email: 'dev@local', role: 'admin' }, org: 'default', mode: 'dev', canSignOut: false } },
    'projects:list': { body: [{ id: PID, name: 'Sales', createdAt: '', updatedAt: '' }] },
    'projects:overview': { body: [{ id: PID, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 0, dashboards: 0, sample: false }] },
    'projects:roles': { body: { [PID]: 'editor' } },
    'connectors:catalog': { body: [SNOWFLAKE] },
    'connectors:logos': { body: {} },
    'connections:list': { body: [CONN] },
    'connection:semanticModels': { body: MODELS },
    'connection:addSemanticDataset': { body: { ok: true, dataset: { id: DSID, name: 'Orders', mode: 'live' } } },
    ...extra,
  });
}

describe('a semantic layer under Connections', () => {
  it('a layer-only connection lists its models, and no SQL editor', async () => {
    serve();
    renderApp(`/connections/${PID}/${CID}`);
    const models = await screen.findByRole('region', { name: 'Models' }, LAZY);
    expect(await within(models).findByText('Orders')).toBeTruthy();
    expect(within(models).getByText('Orders by day')).toBeTruthy();
    expect(within(models).getByText('mdl_returns')).toBeTruthy(); // no label: its own name
    expect(screen.queryByRole('button', { name: /^Run/ })).toBeNull();
  }, 30_000);

  it('Add as dataset sends the model and the name, and opens the new dataset', async () => {
    const calls = serve();
    const router = renderApp(`/connections/${PID}/${CID}`);
    const models = await screen.findByRole('region', { name: 'Models' }, LAZY);
    fireEvent.click((await within(models).findAllByRole('button', { name: 'Add as dataset' }))[0]);
    const name = await screen.findByRole('textbox', { name: 'Dataset name' });
    expect((name as HTMLInputElement).value).toBe('Orders');
    fireEvent.change(name, { target: { value: 'Orders (layer)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add dataset' }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/data/${PID}/${DSID}`));
    expect(calls.find((c) => c.channel === 'connection:addSemanticDataset')?.payload).toEqual({ projectId: PID, connId: CID, model: 'mdl_orders', name: 'Orders (layer)' });
  });

  it('a refusal stays in the dialog, in the server’s words', async () => {
    serve({ 'connection:addSemanticDataset': { body: { ok: false, error: 'Fake layer didn’t answer, so nothing changed. The details are in the server log.' } } });
    renderApp(`/connections/${PID}/${CID}`);
    fireEvent.click((await within(await screen.findByRole('region', { name: 'Models' }, LAZY)).findAllByRole('button', { name: 'Add as dataset' }))[1]);
    fireEvent.click(await screen.findByRole('button', { name: 'Add dataset' }));
    expect(await screen.findByText('Fake layer didn’t answer, so nothing changed. The details are in the server log.')).toBeTruthy();
  });

  it('a Snowflake connection lists its semantic views beside the SQL editor, and says when there are none', async () => {
    serve({ 'connections:list': { body: [{ ...CONN, connectorId: 'snowflake' }] }, 'connection:semanticModels': { body: { ok: true, models: [] } } });
    renderApp(`/connections/${PID}/${CID}`);
    const views = await screen.findByRole('region', { name: 'Semantic views' }, LAZY);
    expect(await within(views).findByText('No semantic views in this database yet.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Run/ })).toBeTruthy();
  });

  it('a listing that fails says why and retries', async () => {
    let fail = true;
    serve({ 'connection:semanticModels': () => ({ body: fail ? { ok: false, error: 'Fake layer didn’t answer, so nothing changed. The details are in the server log.' } : MODELS }) });
    renderApp(`/connections/${PID}/${CID}`);
    const models = await screen.findByRole('region', { name: 'Models' }, LAZY);
    expect(await within(models).findByText(/didn’t answer/)).toBeTruthy();
    fail = false;
    fireEvent.click(within(models).getByRole('button', { name: /Retry|Try again/ }));
    expect(await within(models).findByText('Orders')).toBeTruthy();
  });

  it('NEGATIVE CONTROL: a plain connection lists no models and asks for none', async () => {
    const calls = serve({ 'connections:list': { body: [{ ...CONN, connectorId: 'snowflake', semantic: undefined }] }, 'connectors:catalog': { body: [{ ...SNOWFLAKE, semantic: false }] } });
    renderApp(`/connections/${PID}/${CID}`);
    await screen.findByRole('button', { name: /^Run/ }, LAZY);
    expect(screen.queryByRole('region', { name: /Models|Semantic views/ })).toBeNull();
    expect(calls.some((c) => c.channel === 'connection:semanticModels')).toBe(false);
  });
});
