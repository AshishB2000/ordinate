// The folder safety net (docs/team-folders/00-design.md, "The folder safety net"). Section 1 ships with E1
// (the resolver); sections 2–11 arrive with the PRs that make each class hold (E2–E7) and run over the real
// RPC route as real users in a scratch Postgres (scripts/folderHarness.ts), like test-rowPolicySafetyNet.
//
// 1. COVERAGE (no database): every `read` and `write` contract is classified in scripts/folderReaders.ts,
//    in the table of its access; the tables name no channel that is gone or changed access; every `admin`
//    contract is reachable only at rank 3, the rank that opens every folder.
//    NEGATIVE CONTROLS: a planted contract is reported; a planted stale entry is reported; a `write`
//    contract is reachable at rank 2, so the rank check can tell.
// 0, 2–5 and 7 (E2, with DATABASE_URL): no folders → identical replies; the sweep; by id; figures; the storage
//    net; the security walks — scripts/folderNet.ts, each with its negative control.
// 9–10 (E3, with DATABASE_URL): pushes, sends, mentions and counts; MCP and the model's prompts —
//    scripts/folderNetSends.ts, each with its negative control.
//
//   npm run build:ts && [DATABASE_URL=…] node scripts/test-folderSafetyNet.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { READS, WRITES } from './folderReaders';
import { databaseSections } from './folderNet';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const api: typeof import('../src/api/index') = require('../src/api/index');
const authz: typeof import('../src/server/authz/index') = require('../src/server/authz/index');
const folders: typeof import('../src/server/authz/folders') = require('../src/server/authz/folders');
const context: typeof import('../src/server/context') = require('../src/server/context');

type Contracts = Record<string, { access: string }>;
type Identity = import('../src/server/context').Identity;
type Contract = import('../src/api/contract').Contract;
const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** `read` / `write` contracts not in their access's table — the coverage rule, as a function so its control can run it. */
const unclassified = (contracts: Contracts): string[] =>
  Object.entries(contracts).flatMap(([ch, c]) => ((c.access === 'read' && !has(READS, ch)) || (c.access === 'write' && !has(WRITES, ch)) ? [ch] : []));

/** Table entries whose channel is gone or no longer of that table's access. */
const stale = (contracts: Contracts, reads: object, writes: object): string[] => [
  ...Object.keys(reads).filter((ch) => !has(contracts, ch) || contracts[ch].access !== 'read'),
  ...Object.keys(writes).filter((ch) => !has(contracts, ch) || contracts[ch].access !== 'write'),
];

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-foldernet-'));
const as = (role: Identity['user']['role']): Identity => ({ user: { email: `${role}@acme.test`, role }, org: { id: 'acme' } });
/** A pool whose only answer is `grantRank`'s: the caller holds `rank` on every project. */
const rankPool = (rank: number) => ({ query: async () => ({ rows: [{ rank }] }) }) as unknown as import('pg').Pool;

(async () => {
  const all = api.contracts as unknown as Contracts;
  const missing = unclassified(all);
  ok('coverage: every read and write contract is classified in scripts/folderReaders.ts', missing.length === 0, missing.join(', '));
  const gone = stale(all, READS, WRITES);
  ok('coverage: the tables name no channel that is gone or changed access', gone.length === 0, gone.join(', '));
  const counts = { read: Object.keys(READS).length, write: Object.keys(WRITES).length };
  console.log(`     ${counts.read} read and ${counts.write} write contracts classified`);
  ok('NEGATIVE CONTROL: a planted read contract is reported', JSON.stringify(unclassified({ ...all, 'folder:plantedRead': { access: 'read' } })) === '["folder:plantedRead"]');
  ok('NEGATIVE CONTROL: a planted write contract is reported', JSON.stringify(unclassified({ ...all, 'folder:plantedWrite': { access: 'write' } })) === '["folder:plantedWrite"]');
  ok('NEGATIVE CONTROL: an entry for a gone channel, and one left in the wrong table, are reported',
    JSON.stringify(stale(all, { ...READS, 'folder:gone': 'LIST', 'dataset:update': 'EDIT' }, WRITES)) === '["folder:gone","dataset:update"]');

  // Every admin contract, its scope resolved, refuses rank 2 and answers rank 3: the callers left out of the
  // inventory are exactly the ones the resolver gives `{ all: true }`.
  context.enterServerMode(DATA);
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const pid = await context.runInContext(as('admin'), 'seed', async () => (await projects.createProject('Folders')).id);
  const decide = (who: Identity, c: Contract, rank: number) => context.runInContext(who, 'r', () => authz.authorize(c, {}, who, rankPool(rank)));
  const scoped = (c: Contract): Contract => ('org' in c && c.org === true ? c : { ...c, project: () => pid });
  const admins = Object.entries(api.contracts as unknown as Record<string, Contract>).filter(([, c]) => c.access === 'admin');
  const reach: string[] = [];
  for (const [ch, c] of admins) {
    const editor = await decide(as('editor'), scoped(c), 2);
    const top = 'org' in c && c.org === true ? await decide(as('admin'), c, 0) : await decide(as('editor'), scoped(c), 3);
    if (editor.ok || !top.ok) reach.push(`${ch}: rank 2 ${editor.ok ? 'allowed' : 'denied'}, rank 3 ${top.ok ? 'allowed' : 'denied'}`);
  }
  ok(`admin contracts (${admins.length}): each refuses rank 2 and answers rank 3`, admins.length > 0 && reach.length === 0, reach.join('; '));
  const planted = { ...(admins.find(([, c]) => !('org' in c))?.[1] as Contract), access: 'write' } as Contract;
  ok('NEGATIVE CONTROL: the same contract at `write` is reached at rank 2', (await decide(as('editor'), scoped(planted), 2)).ok);
  ok('rank 3 opens every folder: the resolver answers { all: true }, whatever the folders', folders.accessFrom(pid, 3, [{ id: '6b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b', parentId: null, shareFigures: false, grant: null }]).all === true);

  await databaseSections(); // 0, 2–5 and 7 (E2), 9–10 (E3), with DATABASE_URL
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(() => {
    fs.rmSync(DATA, { recursive: true, force: true });
    finish();
  });
