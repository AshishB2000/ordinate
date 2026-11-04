// Deleting a connection takes its source table docs with it (semantic layer p2-02,
// reader only). A newer release writes connections/<C>.tables.json (the index) and
// connections/<C>/tables/<DOC>.json (one doc per table); this release never writes
// them, but must not leave them behind when the connection goes. Written raw, as the
// newer release's writer would, into a temp ORDINATE_LOCAL_DIR. The Postgres half
// (rows, one range delete) is in test-connections-server.ts.
//
//   npm run build:ts && node scripts/test-sourceTablesReader.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import type { LogSink } from '../src/app/logger';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-source-docs-'));
process.env.ORDINATE_LOCAL_DIR = tmpUserData;

const connections: typeof import('../src/connectors/connections') = require('../src/connectors/connections');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const logging: typeof import('../src/app/logger') = require('../src/app/logger');

const DOC = 'a1b2c3d4-0000-4000-8000-0000000000d1';
const errors: string[] = [];
const sink: LogSink = { debug() {}, info() {}, warn() {}, error: (_o, msg) => void errors.push(msg), child: () => sink };

async function main(): Promise<void> {
  logging.useLogger(sink);
  await projects.init();
  const P = (await projects.createProject('Source docs')).id;
  const dir = path.join(tmpUserData, 'projects', P, 'connections');
  const make = async (name: string): Promise<string> => {
    const c = await connections.saveConnection(P, { name, connectorId: 'url', values: { url: 'https://example.com/x.json' } });
    if (!c) throw new Error('saveConnection returned null');
    fs.mkdirSync(path.join(dir, c.id, 'tables'), { recursive: true });
    fs.writeFileSync(path.join(dir, `${c.id}.tables.json`), JSON.stringify([{ table: 'ANALYTICS.ORDERS', docId: DOC }]));
    fs.writeFileSync(path.join(dir, c.id, 'tables', `${DOC}.json`), JSON.stringify({ table: 'ANALYTICS.ORDERS' }));
    return c.id;
  };
  const A = await make('A');
  const B = await make('B');

  ok('delete: the connection goes', (await connections.deleteConnection(P, A)) === true && !fs.existsSync(path.join(dir, `${A}.json`)));
  ok('delete: the index and the docs go with the connection', !fs.existsSync(path.join(dir, `${A}.tables.json`)) && !fs.existsSync(path.join(dir, A)));
  ok("NEGATIVE CONTROL: another connection's docs stay", fs.existsSync(path.join(dir, `${B}.tables.json`)) && fs.existsSync(path.join(dir, B, 'tables', `${DOC}.json`)));
  ok('listConnections skips the index and the folder, silently', (await connections.listConnections(P)).map((c) => c.id).join() === B && errors.length === 0, errors.join('|'));

  // Best effort (ruling F3): the record goes first, and a doc that cannot be deleted
  // is logged, never fatal. Here the "index" is a non-empty directory, which a plain
  // rm refuses; the folder's docs still go, and the delete still answers true so the
  // caller still drops the connection's secrets.
  const C = await make('C');
  fs.rmSync(path.join(dir, `${C}.tables.json`));
  fs.mkdirSync(path.join(dir, `${C}.tables.json`));
  fs.writeFileSync(path.join(dir, `${C}.tables.json`, 'stuck'), 'x');
  ok('a doc that cannot be deleted does not fail the delete', (await connections.deleteConnection(P, C)) === true && !fs.existsSync(path.join(dir, `${C}.json`)));
  ok('…it is logged, and the other doc still went', errors.length === 1 && errors[0].includes(C) && !fs.existsSync(path.join(dir, C)), errors.join('|'));
  ok('NEGATIVE CONTROL: B still has everything', fs.existsSync(path.join(dir, `${B}.tables.json`)) && fs.existsSync(path.join(dir, B, 'tables', `${DOC}.json`)));

  // A connection with no docs deletes as before, and a missing one stays a no-op success.
  const D = (await connections.saveConnection(P, { name: 'D', connectorId: 'url', values: { url: 'https://example.com/y.json' } }))!.id;
  ok('a connection with no docs deletes as before', (await connections.deleteConnection(P, D)) === true && !fs.existsSync(path.join(dir, `${D}.json`)));
  ok('a missing connection is still a no-op success', (await connections.deleteConnection(P, '00000000-0000-0000-0000-000000000000')) === true);
  fs.rmSync(tmpUserData, { recursive: true, force: true });
}

main()
  .catch((err) => ok('suite ran to the end', false, err instanceof Error ? err.stack : err))
  .finally(finish);
