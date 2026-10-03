// Where the app keeps its files. Every former `app.getPath(...)` call goes
// through here, so the desktop and the server can disagree about the answer:
//
//   desktop  Electron's own folders.
//   server   DATA_DIR/orgs/<orgId>/{userData,downloads,temp,documents}, the org
//            taken from the current request (src/server/context.ts). Each
//            directory is created on first use.
//
// Never cache a result in a module variable: on the server it differs per
// request, and a cached path is another org's data.

import * as fs from 'fs';
import * as path from 'path';
import { ctx, serverDataDir } from '../server/context';

type Kind = 'userData' | 'downloads' | 'temp' | 'documents';

// An org id becomes a path segment. Lowercase slug or UUID; no dot, no
// separator, so `..` and `a/b` can never reach the filesystem.
export const ORG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

const made = new Set<string>();

function resolve(kind: Kind): string {
  const root = serverDataDir();
  // Lazy: the server never loads Electron.
  if (root === null) return (require('electron') as typeof import('electron')).app.getPath(kind);
  const org = ctx().org.id;
  if (!ORG_RE.test(org)) throw new Error('invalid org id');
  const dir = path.join(root, 'orgs', org, kind);
  if (!made.has(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    made.add(dir);
  }
  return dir;
}

export function userData(): string { return resolve('userData'); }
export function downloads(): string { return resolve('downloads'); }
export function temp(): string { return resolve('temp'); }
export function documents(): string { return resolve('documents'); }
