// The seed behind the viewer walk (view-only-routes.e2e.ts): one project with
// something on every screen a viewer can reach, built by the org admin over
// RPC on the real server (Postgres, header sign-in), then shared with one
// viewer and one editor.
//
// `sample:seed` goes FIRST: it refuses an org that has a project, and the
// onboarding checklist (Home's Get started) exists only after it. Everything
// else lands in the sample project:
//
//   a second dataset, a relationship between the two, a quality rule on the
//   first; a visual deleted afterwards (the Trash) and one updated twice (its
//   versions); the sample dashboard (its KPIs); a metric with a tree; a story,
//   a scorecard, a scenario, an event, an input table, an alert rule; a saved
//   view on the sample dashboard (its Views menu, the phone's Saved view); and a
//   Live dataset over the harness's fake warehouse (the server runs with
//   ORDINATE_TEST_LIVE_FAKE=1 — withLiveDataset()).
//
// Not seeded, so walked in their empty state: a capture (reading a screenshot
// needs a model) and the rebuild page (the same).

import assert from 'node:assert/strict';

/** An RPC as `as`; asserts a 200 and returns the parsed reply. */
export type Rpc = (as: string, channel: string, payload?: unknown) => Promise<any>; // any: each channel's own reply

export interface ViewerSeed {
  pid: string;
  /** The sample's dataset (Retail orders) and the second one. */
  did: string;
  did2: string;
  liveId: string;
  connId: string;
  inputId: string;
  aid: string;
  /** A saved view on the sample dashboard. */
  viewId: string;
  vid: string;
  deletedVid: string;
  metricId: string;
  storyId: string;
  scorecardId: string;
  scenarioId: string;
}

const uuid = /^[0-9a-f-]{36}$/;
const idOf = (r: any, ...keys: string[]): string => {
  for (const k of keys) {
    const v = k.split('.').reduce((o, p) => o?.[p], r);
    if (typeof v === 'string' && uuid.test(v)) return v;
  }
  throw new Error(`no id in ${JSON.stringify(r).slice(0, 300)}`);
};

export async function seedViewer(rpc: Rpc, admin: string, members: { viewer: string; editor: string }): Promise<ViewerSeed> {
  const sample = await rpc(admin, 'sample:seed');
  assert.equal(sample.ok, true, JSON.stringify(sample));
  const pid: string = sample.projectId;
  const aid: string = sample.analysisId;
  const datasets = (await rpc(admin, 'dataset:list', { projectId: pid })) as { id: string; name: string }[];
  const did = datasets[0]!.id;

  // A second dataset, related to the first by region, and a quality rule.
  const regions = await rpc(admin, 'dataset:composeSave', {
    projectId: pid,
    name: 'Regions',
    base: { inline: { name: 'Regions', columns: [{ name: 'region', type: 'text' }, { name: 'manager', type: 'text' }], rows: [['West', 'Ana'], ['East', 'Bo'], ['Central', 'Cy'], ['South', 'Di']] } },
    joins: [],
    steps: [],
    sourceKind: 'paste',
  });
  assert.equal(regions.ok, true, JSON.stringify(regions).slice(0, 300));
  const did2: string = regions.dataset.id;
  const rel = await rpc(admin, 'relationship:save', { projectId: pid, relationship: { from: { datasetId: did, column: 'region' }, to: { datasetId: did2, column: 'region' }, cardinality: 'many_to_one' } });
  assert.notEqual(rel?.ok, false, JSON.stringify(rel).slice(0, 300));
  const rule = await rpc(admin, 'quality:save', { projectId: pid, datasetId: did, rule: { kind: 'not_null', column: 'region', args: {}, severity: 'fail' } });
  assert.notEqual(rule?.ok, false, JSON.stringify(rule).slice(0, 300));

  // A visual in the Trash, and one with versions.
  const chart = (name: string) => ({ projectId: pid, datasetId: did, name, chartType: 'column', encoding: { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] } });
  const deletedVid = idOf(await rpc(admin, 'visual:save', chart('Old chart')), 'visual.id', 'id');
  await rpc(admin, 'visual:delete', { projectId: pid, id: deletedVid });
  const vid = idOf(await rpc(admin, 'visual:save', chart('Revenue by region')), 'visual.id', 'id');
  await rpc(admin, 'visual:update', { projectId: pid, id: vid, name: 'Revenue by region (v2)' });
  await rpc(admin, 'visual:update', { projectId: pid, id: vid, name: 'Revenue by region' });

  // A saved view on the sample dashboard: shared, so every member's Views menu lists it.
  const view = await rpc(admin, 'analysis:view', { projectId: pid, id: aid, op: { op: 'create', name: 'West only', state: {} } });
  assert.equal(view.ok, true, JSON.stringify(view).slice(0, 300));
  const viewId: string = view.viewId;
  // Ready: the Dashboards page lists it, so the walk reads a card there rather than the empty state.
  assert.equal((await rpc(admin, 'analysis:setReady', { projectId: pid, id: aid, ready: true })).ok, true);

  // A metric with a tree (the sample's Revenue = Orders × Avg order value).
  const metrics = (await rpc(admin, 'metric:list', { projectId: pid })).metrics as { id: string; name: string }[];
  const metric = (n: string) => metrics.find((m) => m.name === n)!.id;
  const metricId = metric('Revenue');
  const tree = await rpc(admin, 'metricTree:save', {
    projectId: pid,
    id: metricId,
    tree: { relation: 'product', children: [{ metricId: metric('Orders'), split: 'region' }, { metricId: metric('Avg order value') }] },
  });
  assert.equal(tree.ok, true, JSON.stringify(tree).slice(0, 300));

  // Reports and analytics records.
  const storyId = idOf(
    await rpc(admin, 'story:create', {
      projectId: pid,
      name: 'Quarter in review',
      blocks: [
        { id: crypto.randomUUID(), kind: 'text', text: '## Revenue held up' },
        { id: crypto.randomUUID(), kind: 'visual', visualId: vid, filters: [{ type: 'filter', column: 'region', op: '=', value: 'West' }] },
        { id: crypto.randomUUID(), kind: 'callout', tone: 'info', text: 'West led the quarter.' },
      ],
    }),
    'story.id', 'id',
  );
  const scorecardId = idOf(
    await rpc(admin, 'scorecard:create', { projectId: pid, name: 'Monthly targets', period: 'month', rows: [{ metricId }, { metricId: metric('Profit') }] }),
    'scorecard.id', 'id',
  );
  const scenarioId = idOf(
    await rpc(admin, 'scenario:create', {
      projectId: pid,
      input: { name: 'Price +5%', baseMetricIds: [metricId], drivers: [{ name: 'Price', kind: 'pct', value: 5, target: { column: 'revenue' } }] },
    }),
    'scenario.id', 'id',
  );
  const ev = await rpc(admin, 'events:save', { projectId: pid, event: { title: 'Spring campaign', kind: 'campaign', date: '2024-03-01', end: '2024-03-31' } });
  assert.notEqual(ev?.ok, false, JSON.stringify(ev).slice(0, 300));
  const input = await rpc(admin, 'input:create', { projectId: pid, name: 'Targets', columns: [{ name: 'region', type: 'text' }, { name: 'target', type: 'number' }] });
  assert.equal(input.ok, true, JSON.stringify(input).slice(0, 300));
  const alert = await rpc(admin, 'alerts:save', {
    projectId: pid,
    rule: { name: 'Revenue watch', datasetId: did, metric: { column: 'revenue', aggregation: 'sum' }, compare: 'threshold', threshold: { op: '<', value: 1 }, enabled: true },
  });
  assert.notEqual(alert?.ok, false, JSON.stringify(alert).slice(0, 300));

  // A Live dataset over the fake warehouse.
  const conn = await rpc(admin, 'connection:testAndSave', { projectId: pid, connectorId: 'live-fake', name: 'Fake warehouse', values: { fixture: 'orders' } });
  const connId = idOf(conn, 'connection.id', 'id', 'connId');
  const live = await rpc(admin, 'connection:import', { projectId: pid, connId, table: 'live_fake_orders', limit: 1000, mode: 'live', name: 'Orders (live)' });
  const liveId = idOf(live, 'dataset.id', 'id', 'datasetId');

  // Shared: a first header-mode request provisions each account (an org viewer).
  await rpc(members.viewer, 'projects:list');
  await rpc(members.editor, 'projects:list');
  const targets = (await rpc(admin, 'project:shareTargets', { projectId: pid })) as { users: { id: string; email: string }[] };
  const userId = (email: string) => targets.users.find((u) => u.email === email)?.id;
  await rpc(admin, 'project:share', { projectId: pid, member: { userId: userId(members.viewer) }, role: 'viewer' });
  await rpc(admin, 'project:share', { projectId: pid, member: { userId: userId(members.editor) }, role: 'editor' });
  assert.deepEqual(await rpc(members.viewer, 'projects:roles'), { [pid]: 'viewer' });
  assert.deepEqual(await rpc(members.editor, 'projects:roles'), { [pid]: 'editor' });

  return { pid, did, did2, liveId, connId, inputId: input.id, aid, viewId, vid, deletedVid, metricId, storyId, scorecardId, scenarioId };
}
