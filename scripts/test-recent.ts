// buildRecent — the pure flatten/sort/cap behind the cross-project "Recent"
// list. Tested with no disk at all: buildRecent takes RecentGroup[] in and
// gives RecentItem[] out, so ordering, carry-through, cap, empties and sort
// stability are all provable off hand-built groups.

export {}; // module scope — sibling test scripts share top-level names

const test = require('node:test');
const assert = require('node:assert');

const { buildRecent } = require('../src/app/recent.js') as typeof import('../src/app/recent');

// Two projects, each with one dataset and one analysis, all distinct timestamps
// chosen so the expected newest-first order interleaves the two projects and
// both types.
const groups = [
  {
    projectId: 'p1',
    projectName: 'Alpha',
    datasets: [{ id: 'd1', name: 'DS one', updatedAt: '2026-01-01T00:00:00.000Z' }],
    analyses: [{ id: 'a1', name: 'An one', updatedAt: '2026-01-05T00:00:00.000Z' }],
  },
  {
    projectId: 'p2',
    projectName: 'Beta',
    datasets: [{ id: 'd2', name: 'DS two', updatedAt: '2026-01-06T00:00:00.000Z' }],
    analyses: [{ id: 'a2', name: 'An two', updatedAt: '2026-01-02T00:00:00.000Z' }],
  },
];

test('orders strictly newest-updatedAt first, across projects and types', () => {
  const out = buildRecent(groups, 50);
  assert.deepStrictEqual(
    out.map((i) => i.id),
    ['d2', 'a1', 'a2', 'd1'],
  );
});

test('carries type and projectName through for every item', () => {
  const out = buildRecent(groups, 50);
  const byId = new Map(out.map((i) => [i.id, i]));

  assert.strictEqual(byId.get('d1')!.type, 'dataset');
  assert.strictEqual(byId.get('a1')!.type, 'analysis');

  assert.strictEqual(byId.get('d1')!.projectName, 'Alpha');
  assert.strictEqual(byId.get('d1')!.projectId, 'p1');
  assert.strictEqual(byId.get('d2')!.projectName, 'Beta');
  assert.strictEqual(byId.get('d2')!.projectId, 'p2');

  // Item name comes from the record, not the project.
  assert.strictEqual(byId.get('a2')!.name, 'An two');
});

test('caps to `limit`, keeping the newest', () => {
  const out = buildRecent(groups, 2);
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(
    out.map((i) => i.id),
    ['d2', 'a1'],
  );
});

test('limit <= 0 returns nothing', () => {
  assert.deepStrictEqual(buildRecent(groups, 0), []);
  assert.deepStrictEqual(buildRecent(groups, -5), []);
});

test('empty input and all-empty groups contribute nothing', () => {
  assert.deepStrictEqual(buildRecent([], 50), []);
  assert.deepStrictEqual(
    buildRecent(
      [{ projectId: 'p', projectName: 'Empty', datasets: [], analyses: [] }],
      50,
    ),
    [],
  );
});

test('equal timestamps preserve input order (stable sort)', () => {
  const ts = '2026-02-02T00:00:00.000Z';
  const tied = [
    {
      projectId: 'p1',
      projectName: 'Alpha',
      datasets: [
        { id: 'first', name: 'first', updatedAt: ts },
        { id: 'second', name: 'second', updatedAt: ts },
      ],
      analyses: [{ id: 'third', name: 'third', updatedAt: ts }],
    },
  ];
  const out = buildRecent(tied, 50);
  assert.deepStrictEqual(
    out.map((i) => i.id),
    ['first', 'second', 'third'],
  );
});

test('saved visuals are listed with the rest, carrying their chart type', () => {
  const out = buildRecent(
    [
      {
        projectId: 'p1',
        projectName: 'Alpha',
        datasets: [{ id: 'd1', name: 'DS one', updatedAt: '2026-01-01T00:00:00.000Z' }],
        analyses: [],
        visuals: [{ id: 'v1', name: 'Vis one', updatedAt: '2026-01-03T00:00:00.000Z', meta: { chartType: 'bar' } }],
      },
    ],
    50,
  );
  assert.deepStrictEqual(out.map((i) => [i.type, i.id]), [['visual', 'v1'], ['dataset', 'd1']]);
  assert.deepStrictEqual(out[0]!.meta, { chartType: 'bar' });
  assert.strictEqual(out[0]!.projectName, 'Alpha');
});
